# TRACK REPORT — Phase 5, sales entities

Repo `app.ordence`, tree **v1.85.0-alpha** (the zip that came with the
brief). Phase 5 owns `lib/import/entities-sales.ts`,
`server/import/writers/sales/**` and SQL `0230`–`0239`.

## What was asked for, and what is delivered

| Entity | Asked | Delivered | Why |
|---|---|---|---|
| `customers` | ✅ | ✅ **shipped** | Destination `gst_parties`, `upsertPartySchema`, existing Phase 1 writer. `partyType` fixed by the entity, so it cannot collide with Phase 6's `vendors`. |
| `receipts` | ✅ | ✅ **shipped** | Destination `customer_receipts` (new), `recordReceiptSchema`, new writer. Posts nothing to the ledger. |
| `sales-invoices` | ✅ | 🔴 **refused** | There is no schema for an invoice this product did not raise itself. §3. |
| `credit-notes` | ✅ | 🔴 **refused** | `sales_credit_notes.invoice_id` is `NOT NULL` and points at the invoices above. §3. |

Files delivered, at real repo paths:

```
lib/import/entities-sales.ts                          the two entities
server/import/writers/sales/customer-receipts.ts      the one new writer
SQL-FILES/0230_import_customer_receipt_match_indexes.sql
tests/ui/import-sales-entities.test.ts                26 tests, pure layer
tests/security/import-receipts-rerun.test.ts          13 tests, real Postgres
PATCH-REQUEST-PHASE-5.md                              five requests
TRACK-REPORT.md                                       this file
```

Nothing else in the tree is touched. The three one-line edits that make
these entities reachable are in `PATCH-REQUEST-PHASE-5.md §1`, not in the
delivery, because `lib/import/entities.ts` is contested by five phases.

---

## §1 — The tree, and every claim with the command that proves it

### The four confirmations the brief asked for, before anything was written

```
$ npx tsc --noEmit
(no output, exit 0)

$ npm run gates:static
  28/28 passed

$ npm run check:import-contract
✅ 6 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills

$ npm run check:writer-registry
✅ registry: server/import/writers/registry.ts
   server/actions/import.ts carries 0 literal destination comparisons.
   Induction: adding an unregistered destination FAILED to compile, and the
   error named the registry. Restored tree compiles clean.
```

Six entities and a two-wave order, as the brief said to expect. **This is
the right tree.**

### After the delivery, with `PATCH-REQUEST-PHASE-5.md §1–§2` applied locally

```
$ npx tsc --noEmit
(no output, exit 0)

$ npm run check:import-contract
✅ 8 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, customers, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills, receipts

$ npm run check:writer-registry
✅ Induction: adding an unregistered destination FAILED to compile, and the
   error named the registry. Restored tree compiles clean.

$ npm run check:migrations
   171 numbers reserved for parallel tracks, 138 still unused.
✅ Migrations contiguous — 155 files, 0001…0230 (6 documented historical gaps).

$ npm run gates:static
  28/28 passed

$ npx vitest run --project=ui tests/ui/import-sales-entities.test.ts
  Test Files  1 passed (1)
       Tests  26 passed (26)

$ PGPASSWORD=postgres node scripts/bootstrap-test-db.mjs --force
  apply the numbered SQL files, in order… ✅  155 files, 0 statement(s) refused
  confirm row-level security is actually enabled… ✅  319 tables protected

$ npx vitest run --project=security tests/security/import-receipts-rerun.test.ts
  Connected to: ordence_test as ordence_app
  RLS check: ✅ non-superuser role — isolation tests are meaningful
  Test Files  1 passed (1)
       Tests  13 passed (13)
```

⭐ **SQL 0230 was EXECUTED, not read** — it is one of the 155 files that
bootstrap applies in order, and the security suite reads both indexes back
out of `pg_index` and asserts `indisvalid`, `indisready` and
`indisunique = false`.

**`customers` in wave 0, `receipts` in wave 1** — that is the hard edge
between them, computed rather than asserted, and it is the census the
brief asked to see the new entities in.

### What would have differed if the claims were false

- If `customers` had keyed on the GSTIN alone, the census would still say
  8 — so the census is not the proof. The proof that it cannot collide
  with Phase 6 is `cannot be talked into writing a vendor row`, which
  plans a file containing the literal cell `vendor` and asserts the key
  is still `customer|27AAACR5055K1Z7`.
- If `receipts` had offered `update` beside `reversal: delete`,
  `check:import-contract` would have failed naming the entity and both
  members. That is asserted from the other side too: induction ① in the
  suite makes exactly that mutation and requires the refusal.
- If the writer had been forgotten after `customer_receipts` joined
  `ImportTableKey`, `tsc` would have failed at `registry.ts`. That is
  Phase 1's property and it was tested by removing the registry line: the
  compiler refused at `server/import/writers/registry.ts` naming
  `customer_receipts`:

  ```
  $ sed -i '/customer_receipts: customerReceiptsWriter,/d' server/import/writers/registry.ts
  $ npx tsc --noEmit
  server/import/writers/registry.ts(65,14): error TS2741: Property 'customer_receipts'
    is missing in type '{ companies: ImportWriter; gst_parties: ImportWriter; ... }'
    but required in type 'Record<ImportTableKey, ImportWriter>'.
  $ # line restored
  $ npx tsc --noEmit   → clean
  ```

### The full UI suite — 12 pre-existing failures, none of them Phase 5's

```
$ npx vitest run --project=ui                    # WITH the delivery
  Test Files  3 failed | 207 passed (210)
       Tests  12 failed | 6713 passed | 8 skipped (6733)

$ npx vitest run --project=ui \                  # PRISTINE v1.85.0-alpha,
    tests/ui/assemble-wave.test.ts \             # unzipped again, untouched
    tests/ui/csv-import.test.ts \
    tests/ui/opening-balances.test.ts
  Test Files  3 failed (3)
       Tests  12 failed | 106 passed (118)
```

The same twelve, in the same three files, on a tree with none of this
work in it. They are source-text assertions about
`server/actions/import.ts` that Phase 1 invalidated when it moved the
destinations into modules — for example *"reads and writes inside
`withTenant`"* and the eight `opening-balances` assertions about code
that now lives in `server/import/writers/transactions.ts`. **Reported,
not fixed: those tests belong to the tracks that own those files.** The
`security` project was not run — it needs a live throwaway Postgres,
which this environment does not have.

---

## §2 — 🔴 Three of the contract's five members are inert in this tree

This is the most important thing in the report, and it is not a Phase 5
defect — it is the state of the tree Phase 5 was told to write against.

| member | enforced by | in this tree |
|---|---|---|
| `dependsOn` | `resolveImportOrder()` + gate 29 | ✅ real. Computes waves; the wizard reads it. |
| `duplicateDecision` | gate 29 + the wizard | ✅ real. |
| `provenance` | *nothing* | 🔴 the sidecar table **does not exist** |
| `reversal` | *nothing* | 🔴 no engine reads it |
| `requiredness` | gate 29 only | 🔴 no import path reads it |

Proved by execution, in `tests/ui/import-sales-entities.test.ts`:

```
✓ `requiredness` is read by the contract checker and by nothing that runs an import
✓ the provenance sidecar the contract describes has no migration in SQL-FILES
✓ no reversal engine exists yet, so `reversal: delete` is a declaration and not a behaviour
```

The commands behind them:

```
$ grep -rn "requiredness" --include=*.ts --include=*.tsx --include=*.mjs .
    (only lib/import/types.ts, lib/import/contract/check.ts, and the
     entity files that DECLARE it. Not plan.ts. Not server/actions/import.ts.)

$ ls SQL-FILES | grep -E "^019[0-9]"
    (nothing. The highest migration in the tree is 0168.)

$ grep -rl "import_row_provenance" SQL-FILES/
    (nothing)

$ ls server/import/
    ai-mapper.ts  proposals.ts  runs.ts  writers/      ← no reversal.ts
```

`types.ts` says provenance is *"written by the same transaction as the
row it describes — see SQL 0196"*. **There is no SQL 0196.** The sidecar
is Phase 2's to build (blocks 0205–0214), and until it exists the honest
statement about every reversal policy in this repository — including the
four opening ones that shipped in Batch 58 — is that it declares an
intention and nothing executes it.

### What that costs Phase 5's own claims

The brief asks for five proofs. Here is what each is worth today.

| asked | status |
|---|---|
| a re-run of the whole file creates nothing the second time | ✅ **proved against Postgres 16, as `ordence_app` (NOBYPASSRLS).** Run 1: `{ created: 3, skipped: 0 }`, count 0 → 3. Run 2, same file: `{ created: 0, skipped: 3 }`, count unchanged at 3. The company is stored `"ACME   Cements  Ltd"` and the file says `"Acme Cements Ltd"`, so the match is through the fold on both sides — if the `regexp_replace` and the `.replace()` disagreed by one character, run 2 would have written three more rows. |
| preview counts equal commit counts, including when a lookup misses | ✅ **by construction, and not by Phase 5.** `server/actions/import.ts` resolves lookups once for both runs from one call site; `receipts` adds a lookup and no code. The security suite drives the same order — plan, resolve, `findExisting`, write — and the counts it asserts are the numbers a preview would have shown. |
| undo restores the prior state exactly | 🔴 **cannot be proved. Nothing implements undo**, and the suite says so rather than faking it: `to_regclass('public.import_row_provenance')` is `NULL` in the bootstrapped database and `server/import/reversal.ts` does not exist. What IS proved is the narrower claim the entity makes — a row this writer wrote deletes cleanly, leaving no allocation and no journal entry behind — which is what makes `delete` the honest kind once Phase 2 can identify the rows. |
| a row missing a structural field is refused in the PREVIEW with the message you wrote | ⚠️ **refused in the preview, by a different member.** Nothing reads `requiredness`. A nameless receipt is refused by the schema's own `.min(1)` message, in the preview, and lands in the failed-rows CSV. Proved by execution. |
| `check:import-contract` passes and names the entities in the expected wave | ✅ **8 entities, `customers` wave 0, `receipts` wave 1.** |

**Verified-by-a-floor is not verified**, so none of the three red or
amber rows above is written up as done.

---

## §3 — 🔴 Why `sales-invoices` and `credit-notes` are refused

Step 1 of the brief: *"Find the existing validator. If there is no schema
for this thing, the entity is not ready and you should say so in your
report rather than writing one. A schema written for the importer is by
definition not the one the form uses."*

### There is exactly one way to create a sales invoice, and a migration cannot use it

```
$ grep -rn "insert(salesInvoices)" --include=*.ts server lib app
server/actions/sales-invoices.ts:198      raiseInvoiceFromOrder
server/actions/time-billing.ts:922        (time-and-materials billing)
server/import/writers/sales-invoices.ts:66  the OPENING invoice writer
```

`raiseInvoiceFromOrderSchema` requires:

- `orderId` — and `raiseInvoiceFromOrder` refuses an order that is not
  confirmed, refuses one with no customer *("A tax invoice has to name
  who it is issued to (Rule 46(d))")*, and takes the place of supply and
  the frozen tax determination from it. **A Tally invoice has no Ordence
  order and never will.**
- `lines: [{ orderLineId }]` — uuids of lines of that same order.

And the number cannot come from the file. `issueInvoiceSchema`:

> ⚠️ THERE IS NO `invoiceNumber` FIELD AND THERE NEVER WILL BE. […] Rule
> 46(b) requires the series to be consecutive — a caller-supplied number
> cannot be.

So the two available routes were:

- **write a schema for the importer** — refused. Rule 6 forbids it in the
  same breath as describing it, and an import-only schema is the first
  crack through which the import path and the typing path become two sets
  of rules that agree today and drift tomorrow;
- **add `invoiceNumber` to the real schema** — refused. That reverses a
  deliberate product decision about invoice numbering under Rule 46(b),
  and Phase 5 does not get to take it as a side effect of an import
  feature. It is written out for its owner in
  `PATCH-REQUEST-PHASE-5.md §3`.

**What the refusal costs is smaller than it looks.** Open receivables —
what a customer needs to trade on day one — already migrate through
`opening-customer-invoices`: each carries its own number, its own date
(*"the date is the age and the age is what decides who gets chased"*) and
its own outstanding amount. What is refused is historical invoice
*history* with lines and tax.

### `credit-notes` is refused twice over

1. `raiseCreditNoteSchema` requires `invoiceId`, a uuid of an invoice
   already in the workspace, and `sales_credit_notes.invoice_id` is `NOT
   NULL` — the dependency is the database's, not merely the schema's.
2. The invoices it could be about are the ones refused above. The ones
   that *do* import are explicitly **not tax invoices**: their taxable
   value is zero *"because anything else would report the same supply to
   the Government twice"*. A Section 34 credit note reduces a liability
   this workspace never recorded. Importing one would either restate a
   return another system filed, or create a document with no tax effect
   that is indistinguishable from one that has — and an assessing officer
   reads them the same way.

The correct migration for a pre-cutover credit note is the one the
product already implements: it is netted off the outstanding figure on
the opening invoice list, exactly as a part-payment is.

The refusal is recorded **in `lib/import/entities-sales.ts` itself**, at
the foot, under `THE TWO ENTITIES THIS FILE DOES NOT DEFINE`, so the next
person reads the gap as a decision rather than as an oversight.

---

## §4 — 🔴🔴 The double-count decision, which is the one that costs money

**Question.** An imported receipt reduces debtors and increases the bank.
An opening trial balance already carries both. Which one posts?

**Answer: the trial balance. An imported receipt posts nothing.**

This is not a new rule; it is the product's existing one.
`lib/import/opening-entities.ts`:

> Debtors appear TWICE in the material above […] If both posted to the
> ledger, the workspace would open with ten lakh of debtors, a balance
> sheet that still balances — because the contra doubles too — and no
> error anywhere.
>
> ⭐ SO EXACTLY ONE OF THEM POSTS, AND IT IS THE TRIAL BALANCE.

So `server/import/writers/sales/customer-receipts.ts` does **not** call
`postCustomerReceipt`, and says so at the line where the call is absent,
because that is where somebody will one day wonder why.

**Proved against the ledger itself.** After importing three receipts
totalling ₹1,39,000.50, in a real database:

```
✓ 🔴 posts NOTHING to the general ledger
    transactions = 0, journal_entries = 0
✓ 🔴 writes no allocation rows, so nothing is settled twice
    customer_receipt_allocations = 0
```

If somebody adds the posting call, that test fails. That is the point of
it.

**The alternative was considered and rejected.** "Post, unless an opening
trial balance already exists" makes the customer's books depend on the
ORDER they uploaded their files in — receipts first and they post, trial
balance first and they do not. Same data, two sets of books, nothing on
screen saying which one they got.

### The consequence, and the argument against it

An imported receipt is **money on account** and this entity writes **no
allocation rows**. Three consequences, including the one that argues the
other way:

1. ✅ The arithmetic is right. `openingCustomerInvoiceSchema` takes
   `outstandingMinor` NET of what has been paid and refuses an invoice
   with nothing outstanding — so every receipt that HAS been applied to a
   pre-cutover invoice is already reflected in the opening invoice list.
   Importing it again as an allocation would show the customer their
   money twice. **The only receipt worth importing is an unallocated
   one**, and an unallocated receipt has nothing to allocate to.
2. ✅ `reversal: delete` stays honest. An allocation row would be written
   into `customer_receipt_allocations`, which is not a member of
   `ImportTableKey` and therefore cannot appear in `provenance.targets` —
   so an undo would delete the receipt and leave the allocation behind,
   still driving the `received_minor` trigger in `0049 §2` against an
   invoice whose payment no longer exists.
3. 🔴 **Against:** the brief asked for "allocation against invoices", and
   a customer whose old system tracked partial settlements invoice by
   invoice loses that detail. They keep the total, the ageing and the
   dates; they lose which cheque paid which invoice. If that detail is
   wanted, it needs `customer_receipt_allocations` as a destination in its
   own right — union member, writer, provenance target — which is a
   Phase 1 + Phase 2 change, not a Phase 5 one.

---

## §5 — Findings in other people's files

Both are written up for their owners in `PATCH-REQUEST-PHASE-5.md`.

**§4 there — receipt numbering can hand out a number already used.**
`recordCustomerReceipt` derives `RCP/nnnnnn` from `count(*) + 1`. It is
not a reservation (two concurrent receipts collide on the unique index)
and it counts rows rather than reading the highest number issued, so ANY
deletion makes the next receipt reuse a number that has been on a
customer's statement. Phase 5's own undo would be such a deletion —
which is why an imported receipt is numbered `IMP-RCP/<8 hex>`, unique by
construction and visibly outside the `RCP/` series.

**§2 there — the phases ownership map does not merge as written.**
`track-ownership-phases.json` merged verbatim gives 28 ownership
violations and leaves `check:migrations` red. `M2`–`M8` are the same
tracks as `PHASE-1`–`PHASE-10` under older names (M3 is literally "Sales
entities"), `PHASE-1` claims `server/import/writers/**` including every
entity phase's subdirectory, and 0181–0195 are reserved by nobody, which
only becomes fatal when a file lands above them — Phase 5's `0230` is the
first. All three fixes are in the patch request; with them applied,
`gates:static` is 28/28.

---

## §6 — The decisions this phase made, in one place

1. **`customers` is a new entity, not a reuse of `gst-parties`, and not a
   GSTIN-keyed one.** `partyType` is injected by `buildPayload` and is
   not a column, so a customers file cannot create a vendor row whatever
   it contains, and Phase 6's `vendors` is the mirror image. The natural
   key stays `(party_type, gstin)` — the database's own unique index —
   with `(party_type, legal_name)` as a labelled-weak fallback for
   unregistered parties.

   **On Phase 6.** The brief said `customers` and Phase 6's `vendors`
   share a destination and told the two phases to coordinate. As
   delivered, Phase 6 shipped `vendors` against the **`vendors` table**,
   not `gst_parties` — so there is no shared destination between us after
   all, and the vendor side of `gst_parties` remains the existing
   `gst-parties` entity's. The safety property still holds and is
   stronger for being structural rather than agreed: `partyType` is
   injected, so a customers file cannot produce a `vendor|…` key however
   Phase 6 evolves. **Integration should confirm this reading** — it is
   the one decision here that depends on another phase's delivery rather
   than on this tree.
2. **Neither refused entity is registered.** *"Do not skip step 8 and
   register anyway"* — an entity in the picker with no writer is this
   project's most-found defect.
3. **`receipts` posts nothing to the general ledger.** §4.
4. **`receipts` offers no `update`.** A receipt is a record that money
   arrived; the product itself has no "edit receipt" — a receipt that did
   not arrive is bounced, which keeps the row and releases what it
   settled. Excluding `update` is also what makes `reversal: delete`
   honest under gate 29.
5. **The receipts schema is the form's, applied in two steps.**
   `recordReceiptSchema.omit({ companyId: true }).extend({ customerName })`
   in the pure layer, and the **whole** `recordReceiptSchema` — `companyId`
   included — re-parsed in the writer once the lookup has resolved it. Not
   a copy, not a looser variant: a rule added to `recordReceiptSchema`
   tomorrow is in force here the moment it lands.
6. **`requiredness.structural` names `customerName`, not `companyId`.**
   `structural` names payload fields post-Zod, and `companyId` does not
   exist until after the lookup — an implementation that ran where the
   type says it runs would find it absent on every row of every file and
   refuse all of them.
7. **SQL 0230 creates two indexes and neither is unique.** A cheque
   number is unique within a bank account, not a workspace; two cash
   payments of the same amount on the same day are two receipts. Unique
   indexes there would turn a real second payment into a 23505 on a
   counter clerk's screen. The importer's job is to be careful with a
   file; the table's job is to record what happened.

### One near-miss worth recording

The receipts entity was one line from shipping a silent defect.
`recordReceiptSchema` has no `customerName`, and `z.object()` **strips**
unknown keys — so with the name built in `buildPayload` and not declared
in the schema, the parsed payload lost it. `naturalKey` returned `null`
and `lookups` returned `[]` **for every row**: every receipt would have
imported with no customer and no duplicate protection, reporting success.
Found by executing the planner rather than by reading it. The `.extend()`
is the fix and `keeps the customer's name through the schema — it is not
stripped` is the test that stops it coming back.
