# PATCH REQUEST — Track D, wave 17

Against the **assembled** tree (1.81.0-alpha + tracks B/C/D/E/F/G, reconstructed
locally — see `TRACK-REPORT.md` §0 for what that reconstruction can and cannot
see). Track D owns `lib/security/**`, `lib/rbac/**`, `server/billing/**`,
`server/automation/**`, `app/(platform)/admin/access/**`, `tests/security/**`.

Six items. **Item 1 is the one to land first** — it is four lines and it removes
a live trap. Item 2 is a number. Items 3–5 are the money-movement fixes the
wave-17 proofs justify; each now has an executed failure behind it rather than a
reading. Item 6 is small.

Three items from `PATCH-REQUEST-D.md` (wave 15) are **carried forward
unconfirmed** — see the foot of this file.

---

## 1. ⚠️ `server/security/record.ts` — make the failure hook a chain

`onSecurityRecordFailure` is a module-level **single-slot setter**:

```ts
let failureListener: RecordFailureListener | null = null;
export function onSecurityRecordFailure(listener: RecordFailureListener | null): void {
  failureListener = listener;          // ← the second caller silently wins
}
```

**Track B did the right thing and it does not make this safe.**
`server/observability/runtime.ts` declines to call it and explains why;
`PATCH-REQUEST-B.md` item ⑨ correctly adds the Discord alert *inside* the
existing listener rather than as a second registration. So the property "only
one thing registers" is currently held by a comment, a paragraph, and one
author's care.

The thing that stops reporting when somebody registers second is
`installSecurityAlerting()` — the only path that reports a **critical** security
event which failed to persist. Every test still passes, because the hook still
has exactly one listener.

**Proven** in `tests/security/security-record-hook-chain.test.ts`: register two
listeners, induce a real refused INSERT of a `critical` event, and watch the
first listener never fire.

**Patch.** Four lines, and it makes the property structural:

```ts
-let failureListener: RecordFailureListener | null = null;
+/**
+ * ⚠️ AN ARRAY, NOT A SLOT. This was `let failureListener` — a setter whose
+ * second caller silently replaced the first, so wiring a new alerting
+ * destination switched off the existing one and every test still passed
+ * because the hook still had exactly one listener.
+ */
+const failureListeners: RecordFailureListener[] = [];

 export function onSecurityRecordFailure(listener: RecordFailureListener | null): void {
-  failureListener = listener;
+  if (listener === null) { failureListeners.length = 0; return; }
+  if (!failureListeners.includes(listener)) failureListeners.push(listener);
 }
```

and at the call site (`record.ts`, in the `catch`):

```ts
     if (severity === "critical") {
-      try {
-        failureListener?.({ type: input.type, severity, error: message });
-      } catch {
-        /* a broken alert path must not become a second failure */
-      }
+      for (const listener of failureListeners) {
+        try {
+          listener({ type: input.type, severity, error: message });
+        } catch {
+          /*
+           * ⚠️ PER-LISTENER, NOT AROUND THE LOOP. One broken destination must
+           * not stop the others — that is the same single-point failure this
+           * change exists to remove, one level down.
+           */
+        }
+      }
     }
```

and in `__resetRecorderStateForTests()`, `failureListener = null` becomes
`failureListeners.length = 0`.

⚠️ **This makes one Track D test fail, on purpose.**
`tests/security/security-record-hook-chain.test.ts` asserts the setter is still
last-write-wins and that `record.ts` contains `failureListener = listener`. When
this patch lands, delete those two assertions with a one-line note — that
deletion is exactly the review this change deserves. The ratchet in the same
file ("exactly one registration site") should be **kept**: chaining makes a
second registration safe, not automatically correct.

---

## 2. A migration number for the exemption record

**File:** `SQL-FILES/TRACK-D-PENDING-NUMBER-impersonation-guard-exemption-record.sql`
**Action:** rename to the next free number and apply. (Wave 15's file was
numbered 0166 the same way; the reconstruction says the next free number is
0167, but take it from a fresh `check:migrations` on the real tree.)

It writes twelve `COMMENT ON TABLE`s and then **refuses to apply** if the
coverage they describe is no longer true. Changes no data and no behaviour.

**Proven:** applied one statement per connection (the Neon console's behaviour)
— 14/14, twice, idempotent. Negative control: dropping
`no_delete_under_impersonation` from `contacts` and re-running produces

```
REFUSED #13: Tenant table(s) newly WITHOUT the impersonation delete guard: contacts.
```

---

## 3. 🔴 `change_log` has no delete protection that binds production

**File:** a one-line migration (number needed — can share item 2's file if
integration prefers, but it changes behaviour and item 2 deliberately does not).

Four of the five tables exempted from `no_delete_under_impersonation` on
"append-only protects it" grounds carry a `*_no_delete` ROW trigger.
`change_log` carries **no trigger at all**:

```sql
SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal AND c.relname = 'change_log';   -- (0 rows)
```

What refuses a DELETE today is `REVOKE DELETE ... FROM ordence_app`
(`has_table_privilege('ordence_app','change_log','DELETE')` → `f`). **A REVOKE
does not bind `neondb_owner`, which is what production connects as** — this
project's own standing rule. So the field-level history behind the audit trail
is deletable in production, including by staff inside a customer's workspace
under impersonation.

⚠️ **Wave 15 recommended leaving all twelve. That was wrong for this one**, and
it was writing the recommendation down as a *check* that found it.

```sql
-- change_log is the only one of the twelve exempt tables with no protection
-- that binds the production owner role. Narrow guard, not append-only.
SELECT attach_impersonation_guards();   -- idempotent; picks change_log up
```

or, if the sweep should stay opt-out:

```sql
CREATE TRIGGER no_delete_under_impersonation
  BEFORE DELETE ON change_log
  FOR EACH ROW EXECUTE FUNCTION refuse_delete_under_impersonation();
```

⚠️ **NOT an append-only trigger.** That would make `change_log` undeletable by
anyone — which is precisely what already makes a tenant with `security_events`
rows impossible to delete (wave 15 §4.2) and which the DPDPA erasure work has to
solve. Inheriting that problem on a second table is a bad trade. The narrow
guard refuses the impersonated delete and leaves lawful erasure possible.

Then update `lib/security/impersonation-guard-exemptions.ts`: remove the
`change_log` entry (the test fails until you do — a table that gains the guard
while still listed exempt is a stale exemption).

---

## 4. 🔴 The five money-moving actions — the fixes, each with an executed failure behind it

`tests/security/idempotency-money-movement.test.ts` calls the **real** actions
twice against a **real** PostgreSQL. Twelve assertions, every refusal with a
positive control. What follows is what each proof licences.

⚠️ **None of these files is Track D's.** The proofs are; the fixes are not.

### 4a. `postTransaction` — `server/actions/accounting.ts:281`

**Measured:** two sequential submits → **2 posted transactions, 4 journal legs,
₹10,00,000 of debits where ₹5,00,000 was intended.** Both balance, so the
deferred balance trigger passes on both.

**And the fix already exists in the schema.** The same proof shows that when a
`transactionNumber` IS supplied, the second submit is refused by
`transactions_tenant_number_unique … WHERE transaction_number IS NOT NULL`. The
gap is that the UI supplies none.

```ts
 export async function postTransaction(
   input: PostTransactionInput,
 ): Promise<ActionResult<PostedTransaction>> {
```
```ts
       .values({
         tenantId: ctx.tenant.id,
-        transactionNumber: data.transactionNumber ?? null,
+        /*
+         * ⚠️ NEVER NULL. The partial unique index is
+         * `… WHERE transaction_number IS NOT NULL`, so a null makes the one
+         * mechanism that could stop a double-post invisible to it. Measured:
+         * two sequential submits with no number produce two posted journals;
+         * with a number the second is refused.
+         *
+         * The client supplies a stable id per form submission (a hidden
+         * field minted on render, not on submit); the fallback keeps the
+         * server safe if it does not.
+         */
+        transactionNumber:
+          data.transactionNumber ?? `MJ:${data.idempotencyKey ?? crypto.randomUUID()}`,
```

⚠️ **A server-minted UUID fallback is NOT idempotency** — it makes every submit
unique and changes nothing. It is there so the column is never null; the
protection comes from the client-supplied key. The schema needs
`idempotencyKey: z.string().uuid().optional()` on `postTransactionSchema` and a
hidden field on the form, **minted when the form renders**.

### 4b. `reverseTransaction` — `server/actions/accounting.ts:392` and `:418`

**Measured:** sequential is **SAFE** — the second call reads
`status = 'reversed'` and is refused. ⚠️ Wave 15 implied a plain double-click
reproduced this; it does not, and saying so wrongly wastes a reviewer's
afternoon.

**Concurrent produces two mirror journals** — 2 reversals, 4 legs, both pointing
at the same original. The guard reads in one `withTenant()` and writes in
another; neither read sees the other's uncommitted write.

The fix is the pattern this codebase already uses once, in
`approveTimeEntries` (`server/actions/time-billing.ts:294`): make the guard a
**conditional UPDATE inside the write transaction** and read the row count.

```ts
     const reversalId = await withTenant(ctx.tenant.id, async (tx) => {
+      /*
+       * ⭐ CLAIM THE ORIGINAL FIRST, CONDITIONALLY, INSIDE THIS TRANSACTION.
+       * The `status === "reversed"` check above stays as the friendly early
+       * refusal; this is the one that is actually race-safe. Measured: two
+       * concurrent calls both passed the earlier check and both wrote a
+       * mirror.
+       */
+      const claimed = await tx
+        .update(transactions)
+        .set({ status: "reversed" })
+        .where(and(
+          eq(transactions.id, original.id),
+          eq(transactions.tenantId, ctx.tenant.id),
+          eq(transactions.status, original.status),   // ← 'posted'
+        ))
+        .returning({ id: transactions.id });
+
+      if (claimed.length === 0) return null;   // somebody else got there first
+
       const [reversal] = await tx.insert(transactions).values({ … }).returning();
```

…and the existing `UPDATE … SET status:'reversed', reversedByTransactionId` at
the foot becomes a narrowing update that only sets `reversedByTransactionId`.
`null` from the callback becomes `fail("This transaction has already been reversed.")`.

### 4c. `recordReceipt` — `server/receivables/receipts.ts:106` and `:190`

**Measured:** the same payment recorded twice → **2 receipts, 2 different
receipt numbers, the identical `bank_ref` on both, ₹20,00,000 recorded for one
₹10,00,000 transfer.**

🔴 **`receipts_number_tenant_unique` does not help and cannot.** The retry loop
treats a 23505 on it as a signal to **renumber and re-insert**:

```ts
    } catch (err) {
      if (!isNumberCollision(err)) throw err;   // → attempt + 1
```

That is a *numbering* guarantee. The index makes two concurrent receipts get
different numbers; it was never going to make one of them not exist.

**The field that identifies a payment is already carried, stored, and indexed by
nothing:** `bank_ref` (the UTR). Migration:

```sql
-- ⚠️ PARTIAL. A cash receipt has no bank reference and two of them on the same
-- day are two real receipts; only a referenced instrument is claimed to be
-- unique. `instrument_ref` (cheque number) deserves the same treatment.
CREATE UNIQUE INDEX CONCURRENTLY receipts_bank_ref_once
  ON receipts (tenant_id, bank_ref)
  WHERE bank_ref IS NOT NULL AND status <> 'bounced';
```

and in `recordReceipt`, catch that specific violation and return the EXISTING
receipt rather than retrying — a redelivered webhook should get the first
receipt back, not an error.

### 4d. `recordClientAccountEntry` — `server/actions/client-account.ts:125`

**Measured:** a retried POST → **2 entries, balance moved by −₹3,00,000 against
a ₹1,50,000 issued bill.** `client_account_entries` carries only a primary key;
the one trigger on it is a BEFORE INSERT sanity check, not a dedupe.

This is the worst of the five: it is client money, the action's own return value
reports the resulting balance as fact, and it is the balance a regulator
inspects. Flagged `severity: "critical"` in its own audit entry and unguarded.

```sql
-- One transfer per invoice, which is what "settling a bill" means. A second
-- transfer against the same bill is either a duplicate or a second bill.
CREATE UNIQUE INDEX client_account_transfer_once_per_invoice
  ON client_account_entries (tenant_id, invoice_id)
  WHERE entry_kind = 'transfer_to_office' AND invoice_id IS NOT NULL;
```

⚠️ **That covers `transfer_to_office` only, and deliberately.** Two receipts of
the same amount from the same client on the same day are genuinely two receipts;
a unique index across all kinds would refuse real work. For the other three
kinds the answer is a caller-supplied idempotency key, not a natural key.

### 4e. `recordMilestonePayment` — `server/actions/sales-bookings.ts:1525`

**Measured, two ways:**

* double-click → **₹16,00,000 credited against an ₹8,00,000 milestone**;
* two concurrent cashiers recording ₹5,00,000 and ₹3,00,000 → **the total is one
  of the two, not the sum. ₹3,00,000 or ₹5,00,000 of collected, receipted,
  banked money is absent from the record and NOTHING errors** — both calls
  return `ok: true`.

The second is worse than a duplicate: a duplicate is visible.

```ts
-      const nextPaid = milestone.amountPaidMinor + amountMinor;
-      …
-        .set({ amountPaidMinor: nextPaid, status, … })
+      /*
+       * ⭐ THE ADDITION HAPPENS IN THE DATABASE, NOT IN NODE. A
+       * read-modify-write across a round trip is a lost update whenever two
+       * cashiers work the same booking in the same second — measured: two
+       * concurrent receipts of ₹5,00,000 and ₹3,00,000 left ₹5,00,000
+       * recorded and no error anywhere.
+       */
+        .set({
+          amountPaidMinor: sql`${paymentMilestones.amountPaidMinor} + ${amountMinor}`,
+          status,
+          …
+        })
```

⚠️ **That fixes the lost update and NOT the double-click** — the status is still
derived from a value read before the update. Full correctness needs the receipt
that justifies the credit to be a row with its own key, and the milestone total
to be `SUM()` over those rows rather than a running column. That is a larger
change and is the right one; the `sql\`\`` form is the stop-the-bleeding half.

---

## 5. `scripts/bootstrap-test-db.mjs` — create `ordence_maintenance`

`npm run check:rls` cannot complete on a freshly bootstrapped database:

```
::error::RLS coverage check could not run: permission denied for function tenant_table_drift
```

0140/0139/0142 grant those functions to **`ordence_maintenance`**, inside an
`IF EXISTS (role)` block. The bootstrap script does not create that role, so the
grants never run and section C of the gate cannot execute locally.

Granting the five functions by hand gets it through section C —
`drift: 0 findings across 306 tenant tables` — and it then stops again on
`schema_contract_snapshots`. **Integration reports 26/26 gates green, so the
real tree has whatever creates this role.** If that is a patch-request migration
in 0160–0165, this item is already done and can be closed; if it is only in CI,
`check:rls` is a CI-only gate on a developer machine, which is the thing
`bootstrap-test-db.mjs` was written to stop being true.

---

## 6. Carried forward from wave 15, unconfirmed

The wave-17 re-verification runs against a **reconstruction** (1.81.0-alpha +
the six track zips), which cannot see integration's own patches. Integration
confirmed the five test files and the 0166 number; these three were not
mentioned and could not be checked:

| Wave 15 item | What it was | Why it still matters |
|---|---|---|
| ② `server/security/record.ts` — tenant-scoped writes | Seven call sites passing a real `tenantId` have never written a row; `tenant.cross_access_attempt` among them | Still reproducible in the reconstruction: `tests/security/security-event-tenant-scope.test.ts` passes, which means the unscoped write is still refused |
| ③ `db/index.ts` — record the platform-scope justification | Six lines; turns all 94 call sites into recorded ones | Without it `platform.scope_raised` only fires from Track D's own wrapper, which nothing existing uses |
| ④ `app/platform/access/**` — the access console | Two complete files | The simulator it renders is in `lib/rbac/` and is tested; the screen is not shipped |

⚠️ **Item ② is testable from your side in one command.** If it has landed,
`tests/security/security-event-tenant-scope.test.ts` will fail at *"returns
false and lands NO row when tenantId is set"* — and that failure is the good
news. Delete that assertion and keep the other four.
