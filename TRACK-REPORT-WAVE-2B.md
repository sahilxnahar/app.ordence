# WAVE 2B — the undo. Build v1.89.0-alpha.

**Delivered:** `server/actions/import-reversal.ts` (new),
`tests/security/import-undo-action.test.ts` (new, offered to Track D).
No SQL. `server/actions/import.ts` untouched.

---

## 0. The tree was confirmed, once, and then not re-measured

```
$ npx tsc --noEmit
(no output)

$ npm run gates:static
  29/29 passed

$ npm run check:import-contract
✅ check:import-contract
   18 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: chart-of-accounts, companies, cost-centres, customers, gst-parties,
             leads, opening-stock, stock-items, tax-codes, vendors, warehouses
     wave 1: batches, contacts, opening-customer-invoices, opening-trial-balance,
             opening-vendor-bills, purchase-bills, receipts
```

The proofs below ran against a local PostgreSQL 16 stood up with
`node scripts/bootstrap-test-db.mjs` (`ordence_app`, NOSUPERUSER NOBYPASSRLS;
312 base tables, 168 numbered SQL files, 323 tables under FORCE RLS). **That
harness applies the twelve unapplied migrations**, which is how §3 was found.

---

## 1. THE DECISION: "may import" is **not** "may undo an import"

**Chosen: the entity's own `updatePermission`, for every kind — plus
`transactions:reverse` when the run's provenance rows say this undo posts to
the ledger. Never `createPermission`.** The reasoning is written into the file
header, not only here.

**Why not `createPermission` (the nearest one).** `undoOneRow()` dispatches on
`import_row_provenance.operation`, so undoing a `restore-prior` run in `update`
mode is an UPDATE over records the customer had *before* the migration. Adding
prospects from a file and mass-restoring the customer master are not the same
right. The floor is therefore the same key `guardImport()` already demands
before an import may overwrite anything — and it is demanded for **every** kind,
including `delete`, because otherwise the safest-sounding kind carries the
weakest gate.

**Why the second key, and why it is derived per run.** `reverseImportRun` can
post: `postReversingJournalEntry` writes a `transactions` row and its legs;
`postReversingStockMovement` writes a compensating movement. Measured rather
than assumed:

```
$ grep -rn "transactions:reverse" --include=*.ts server/ app/ components/
server/fixed-assets/depreciation-service.ts:255: * ... which is what `transactions:reverse` is for.
```

— i.e. the catalogue key exists (`db/schema/auth.ts:619`), is listed in
`DANGEROUS_PERMISSIONS` (`:922`), and **nothing in the repository asks for it**.
The accounting side's real bar is `requireRole(FINANCE_ROLES)` +
`requireAccess("accounting:reverseTransaction")` +
`requireFeature("accounting.ledger")` (`server/actions/accounting.ts:356-369`).
This action asks for the catalogue's own name for the act, plus that
entitlement, on the runs that post — and **not** on the runs that do not, so a
workspace is never pushed to hand a ledger permission to whoever does
migrations.

`purchase-bills` is the entity that makes the derivation necessary rather than
decorative: it declares `reverse-entry` and its own two keys are
`purchases:record_invoice`. A guard built from the entity alone would let
somebody who may type a purchase bill post a reversal they could not post from
the accounting screen. (`opening-trial-balance` happens to declare
`transactions:reverse` itself, which is exactly why it is the wrong entity to
prove this with.)

**What fails closed.** The permission KEY still comes from
`ALL_IMPORT_ENTITIES` — nothing records it on the run, unlike
`reversal_escapes` (SQL 0208 §0). An entity removed from the allowlist
therefore cannot be undone through this action: it refuses, says why, and the
refusal is audited. Guessing a nearby key would silently downgrade somebody's
data-protection right. `PATCH-REQUEST-WAVE-2B.md` §1 asks for the column that
closes it.

---

## 2. The proofs. Every one induced; none is "the action ran"

```
$ npx vitest run --project=security tests/security/import-undo-action.test.ts
 ✓ the permission the undo asks for > refuses a user who may import but may not overwrite — and the reversal never starts
 ✓ the permission the undo asks for > asks for transactions:reverse when the run posts to the ledger, and refuses without it
 ✓ the permission the undo asks for > does not ask for transactions:reverse on a run that posts nothing
 ✓ a partial reversal, through the action > returns ok with status partial, names every row, and does NOT release the file claim
 ✓ an irreversible refusal > is recorded in audit_logs, because a refusal nobody recorded is nobody having tried
 ✓ an irreversible refusal > records an undo aimed at a run this workspace does not have
 ✓ SQL 0215 §4 against SQL 0205 §5 > makes every undo 0-of-N with the pack as ordered, and 3-of-3 without it
 Test Files  1 passed (1)      Tests  7 passed (7)
```

**① The permission actually refuses — counted, not read.** A `tenant_owner`
with one explicit revoke (`{"companies:update": false}`) still holds
`companies:create`, so they may run the import. The undo returns `ok: false`
and: `import_reversals` for that run = **0** (so `reverseImportRun` was never
entered — not "ran and failed", which the error string cannot distinguish),
the two imported `companies` rows are still there, both provenance rows still
have `reversed_at IS NULL`, and `permission_denials` gained exactly one row
naming `companies:update`. Then the same user, the same run, the same call,
with the override removed: `import_reversals` = **1**. One variable.

**② A partial reaches the caller as partial.** Induced with
`REVOKE DELETE ON sales_invoices FROM ordence_app`. The action returns
`ok: true` — a partial is a report, not an error; `{ok:false}` would throw away
the names — with `status: "partial"`, 4 considered / 0 reversed / 4 unreversed,
all four named with `targetTable`, `targetId`, `inputRowNumber`, a sentence and
`sqlstate 42501`, `count(import_reversal_failures) == rowsUnreversed`, four
invoices still in the workspace, and **`import_runs.superseded_at` still NULL** —
the file stays claimed. The audit row is `severity: warning`, `outcome:
partial`, with all four rows in `metadata.unreversed`.

**③ The refusal is audited.** An `irreversible` fixture (no registered entity
declares that kind; the ledger carries it, as `import-reversal.test.ts` does):
`status: "refused"`, nothing changed, and `audit_logs` goes from 0 to 1 rows for
that run — `action: delete`, `severity: warning`, the escape sentence in
`reason`, `metadata.outcome: refused`, and `actor_email` naming the human. An
undo aimed at a run that is not in the workspace is audited too, because that is
the probe worth having a record of.

**A gate proven only by passing is not proven — so both were mutated.**

```
# guard deleted from the action:
-    await requireAllPermissions(required, { type: "import_run", id: runId });
 × refuses a user who may import but may not overwrite …  → expected true to be false
 × asks for transactions:reverse when the run posts …     → expected true to be false

# writeAudit deleted from the action:
 × is recorded in audit_logs …                            → expected +0 to be 1
```

Both reverted; the file shipped is the unmutated one.

---

## 3. 🔴 FINDING: with the twelve-migration pack as ordered, **no undo can ever complete**

`import_row_provenance` is defined **twice** in the unapplied pack:

* **0205 §5** `import_row_provenance_immutable` — freezes every column
  **except `reversed_at` and `reversal_id`**, which is precisely how a reversal
  marks a row undone, in the same transaction as the undo.
* **0215 §4** `import_row_provenance_is_append_only` — `RAISE EXCEPTION` on
  BEFORE UPDATE, unconditionally, for every role, `ERRCODE
  restrict_violation`.

Two different trigger names on one table: the second does not replace the
first, it sits beside it and fires first. Applied together — which is what
"integration will send them as one ordered pack" means — **every undo of every
kind reports `partial`, 0 of N, `23001`**, and (correctly, per the rule) never
releases the run's claim on the file. So the shipped behaviour would be: the
undo button never works, and the customer can never re-import either.

Proved by induction from both sides, on the same fixture, in one test:

```
with import_row_provenance_no_update present : status "partial", 0/3, sqlstate 23001,
                                               3 invoices still there, superseded_at NULL
with it dropped                              : status "reversed", 3/3,
                                               0 invoices left, superseded_at NOT NULL
```

The trigger is re-created in a `finally`, and the test asserts it is back.

This is also why four tests in `tests/security/import-reversal.test.ts` are red
on this tree (see §5): Phase 2's own proofs were run before 0215 existed.

**Not mine to fix** — SQL, and neither file is in my two. `PATCH-REQUEST-WAVE-2B.md` §2 carries the one-line change and the argument for which of the two rules should win.

---

## 4. ⚠️ `check:gates:static` goes 29/29 → 28/29, and it is the honest failure

```
::error::1 server action(s) newly reachable from nothing:
  • server/actions/import-reversal.ts#undoImportRun — no file under app/ or
    components/ names it …
```

Wave 2B owns no UI, so the call site now exists and the button does not. The
check is right and its own note says not to silence it with an unused import.
The baseline (`scripts/action-reachability-baseline.json`) is not one of my two
files: `PATCH-REQUEST-WAVE-2B.md` §3 gives the exact one-line addition, to be
removed again the day a screen calls it. **`npx tsc --noEmit` is still clean and
the other 28 gates still pass**; this is the single delta.

---

## 5. Pre-existing red, measured on an untouched tree

The brief names 12 `--project=ui` failures. The **security** project also has
13 failures on this tree, before my files exist:

```
$ git-less check: my two files moved aside, then
$ npx vitest run --project=security <the six files>
 Test Files  6 failed (6)      Tests  13 failed | 94 passed (107)
```

identical, file for file and count for count, to the full run with my files in
place (`13 failed | 1638 passed` across 71 files). They are:

* `import-reversal.test.ts` ×4 — three are §3's collision; the fourth asserts
  `opening-stock` declares `delete` and it now declares `reverse-entry` (a
  later phase applied Phase 2's own finding and the assertion did not move).
* `import-dry-run-parity.test.ts` ×5, `import-inventory.test.ts` ×1,
  `import-receipts-rerun.test.ts` ×1, `tax-call-sites.test.ts` ×2.
* `import-crm-entities.test.ts` — suite-level: `lead_activities is
  append-only; DELETE is not permitted` in `afterAll`. Same shape as the
  finding in §6.

None of them are mine and none were made worse.

---

## 6. Two smaller things this work measured

* **`audit_logs` makes a tenant undeletable.** `audit_logs.tenant_id` is
  `ON DELETE RESTRICT` **and** the table carries `audit_logs_no_delete`. This
  suite is the first in the directory to write real audit rows through
  `writeAudit()`, so it is the first to hit it. That is Phase 2's
  `journal_entries` finding and wave 15 §4.2's `security_events` finding
  reached through a third table — the one **every** tenant has rows in. Lawful
  erasure under the DPDPA has to solve it. `permission_denials` is the fourth.
* **`reverseImportRun` refuses cross-tenant by construction, and this action
  keeps it that way.** The run is read inside `withTenant()`, so a run id from
  another workspace reads as "not found" rather than telling the caller it
  exists; that refusal is audited as a probe.
