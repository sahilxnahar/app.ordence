# Phase 6 — Entities: purchases

Repo `app.ordence`, build **v1.85.0-alpha**, block **SQL 0240–0249**.

**Two of the four entities ship. Two are refused, with proof.** The
refusals are the more useful half of this report and they are §3 and §4.

Every claim below is followed by the command that produced it and, where
the claim is about behaviour, by the **induced failure** — the change
that makes the check go red. A gate proven only by passing is not proven.

---

## 0. The tree, confirmed before anything was written

```
$ npx tsc --noEmit                       # (silent)
$ npm run gates:static                   28/28 passed
$ npm run check:import-contract
  ✅ 6 entities examined … 2 wave(s)
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills
$ npm run check:writer-registry
  ✅ Induction: adding an unregistered destination FAILED to compile
```

Six entities, two waves. This is the tree the brief describes.

**Postgres 16 was stood up and the whole schema applied**, because three of
this phase's findings are only visible by executing things:

```
$ PGPASSWORD=… node scripts/bootstrap-test-db.mjs --force
  push the base schema (drizzle-kit)…            ✅  308 base tables
  apply ALL-IN-ONE-SETUP.sql…                    ✅  461 statements, 0 refused
  apply the numbered SQL files, in order…        ✅  155 files, 0 refused
  confirm row-level security is actually enabled ✅  319 tables protected
  confirm ordence_app cannot create a table      ✅  no CREATE, no owned tables
```

---

## 1. What ships

| Entity | Destination | Wave | Modes | Reversal |
|---|---|---|---|---|
| `vendors` | `vendors` | 0 | skip · update · fail | `restore-prior`, capture `*` |
| `purchase-bills` | `purchase_invoices` | 1 | skip · fail | `reverse-entry` |

```
$ npm run check:import-contract
  ✅ 8 entities examined, every contract complete and coherent.
     Load order resolves in 2 wave(s):
       wave 0: companies, gst-parties, opening-stock, opening-trial-balance, vendors
       wave 1: opening-customer-invoices, opening-vendor-bills, purchase-bills

$ npm run check:writer-registry     ✅  (induction still refuses)
$ npx tsc --noEmit                  (silent)
$ npm run gates:static              28/28 passed
$ npm run check:migrations          ✅ 155 files, 0001…0240
$ npm run check:track-ownership     OK SQL blocks
```

The census names both entities in the waves expected: a vendor master
depends on nothing, and a bill cannot be loaded before the vendor it is
owed to.

Files delivered, all inside Phase 6's own paths:

```
lib/import/entities-purchases.ts
server/import/writers/purchases/vendors.ts
server/import/writers/purchases/purchase-invoices.ts
SQL-FILES/0240_purchase_import_reentrancy_proof.sql
```

plus `tests/security/import-purchases.test.ts`, which is **not** in a Phase 6
path — see §7 and `PATCH-REQUEST-PHASE-6.md` §7.

---

## 2. The deviation: `vendors` goes to `vendors`, not to `gst_parties`

The brief maps the `vendors` entity to `gst_parties` and asks Phase 6 and
Phase 5 to agree how to share that destination. **Phase 6 says the
destination should not be shared, because neither phase should add an
entity to it.** Three checkable facts:

**① `gst_parties` already has a registered entity and it already covers
vendors.** `gstPartiesEntity` in `lib/import/entities.ts` has a required
`partyType` column whose values are exactly `customer` and `vendor`, and
keys on `(party_type, gstin)`. Its own comment says why the type is in the
key: *"the same firm can be a customer and a vendor at once … a builder
buys cement from a company it also sells a shop to."* A second entity
writing that table with that identity would be a second route to one
destination; under `update` the two would overwrite each other and both
would report success.

**② The schema argues at length that a vendor is not a GST party.**
`db/schema/purchases.ts:396`:

> `gst_parties` answers "what tax identity did we transact under, and was
> it valid on the date of this document" — it is DATED … A vendor is a
> single continuing relationship with payment terms, a bank account, an
> MSME status and a running balance, and it must survive its
> counterparty's re-registration without the balance splitting in two.

Importing a vendor master into `gst_parties` drops `payment_terms_days`,
`udyam_number` and `msme_category` — the three columns Section 43B(h) is
enforced from.

**③ The framework already expects `vendors` to be importable and nothing
writes it.** `ImportLookupKind` carries `vendor_by_code` ("`vendors.code`
— V-0042. Unique per workspace"), `resolveLookups` resolves it against
`vendors` at `server/actions/import.ts:432`, and `opening-vendor-bills`
depends on it. Before this phase, no entity wrote that table, so that
lookup could only ever miss.

**Recorded for Phase 5, as the brief asked both phases to do:** the
coordination is that there is nothing to coordinate. `gst_parties` keeps
one entity; Phase 6 takes `vendors`; the composite key that already exists
is the mechanism that makes one entity enough for both party types.

---

## 3. `debit-notes` is refused: there is no destination

```
$ grep -rn '"debit_notes"' db/schema/ SQL-FILES/*.sql
  (no output)
$ grep -rn 'pgTable(' db/schema/*.ts -A1 | grep -c 'debit_note'
  0
```

**There is no `debit_notes` table in this product, and there never was.**
A debit note exists only as a value of `vendor_ledger_entry_type`
(`db/schema/purchases.ts:381`) — an entry TYPE on `vendor_ledger_entries`.
`db/schema/sales-invoices.ts:649` says the same thing from the other side:
*"THERE IS NO DEBIT NOTE HERE."*

So the only honest destination is `vendor_ledger_entries`, which is
already an `ImportTableKey` with a writer. **And that writer cannot carry a
second entity as it stands.** `server/import/writers/vendor-ledger-entries.ts:82`:

```ts
entryType: "purchase_invoice",     // hard-coded
referenceNumber: String(payload.billNumber ?? ""),
creditMinor: minorOf(payload.outstandingMinor),
```

It is written for one payload shape (`billNumber`, `billDate`,
`outstandingMinor`) and stamps one entry type. A `debit-notes` entity
routed there would produce a ledger entry **labelled `purchase_invoice`**
with a blank reference and a zero amount, in the credit column rather than
the debit column — and would report success.

🔴 **That is Phase 1's own finding, one level down.** The fall-through
that wrote a GST party has been replaced by a `Record` over the
destination union, so a destination with no writer is a compile error. It
does not — and cannot — catch a destination whose writer serves a
*different entity's payload*. **Two entities sharing one destination is
now the unguarded case**, and it is a risk every one of the five entity
phases carries, not only this one. Named here because it is the shape this
codebase keeps finding, and nothing currently looks for it.

`server/import/writers/vendor-ledger-entries.ts` is Phase 1's file. The
concrete patch that would make it entity-aware is
`PATCH-REQUEST-PHASE-6.md` §6; the entity is not shipped without it,
because registering it would be the thirty-first instance of built,
offered, unreachable — except worse, since it would be reachable and
wrong.

---

## 4. `payments` is refused: there is no schema, and the reason is structural

The brief's own step 1 says: *"Find the existing validator. In
`lib/validators/`. If there is no schema for this thing, the entity is not
ready and you should say so in your report rather than writing one."*

```
$ grep -rn "vendorPayment\|payVendor\|paymentNumber" lib/validators/*.ts | wc -l
  0
$ grep -rn "paySchema" server/ lib/
  server/actions/vendor-payments.ts:236:const paySchema = z.object({
  server/actions/vendor-payments.ts:282:    const data = paySchema.parse(input);
```

The only schema for a vendor payment is a **non-exported `const` inside a
server action**, and that file imports the database:

```
server/actions/vendor-payments.ts:26   import { withTenant } from "@/db";
```

So it cannot be imported into `lib/import/` at all — rule 7, *"No database
import anywhere in `lib/import/`"*, which is what keeps the client wizard
able to build a blank template. **The entity is not ready.** The patch that
would make it ready (move `paySchema` to `lib/validators/purchases.ts` and
export it) is `PATCH-REQUEST-PHASE-6.md` §4; it belongs to whoever owns
that action, and it is a move, not a rewrite.

### The question the brief asked anyway: is allocation atomic per payment?

**Yes, and it must be, and the existing code already agrees.**
`server/actions/vendor-payments.ts:258`:

> 🔴 ALL OF IT OR NONE OF IT. A payment written without its allocations
> leaves the bills looking unpaid and they get paid again. A payment
> posted without its withholding clears the vendor's balance with the tax
> nowhere.

A payment against three bills where one bill failed to import is **not** a
payment that lands at two-thirds, for three separate reasons:

1. **The allocation is derived, not supplied.** `allocateOldestFirst`
   distributes the gross across whatever is outstanding, oldest first. Run
   against two of three bills it does not allocate two-thirds — it
   allocates the whole payment across the two bills that exist, marking
   them *more* paid than they were. The error is silent and it is in the
   wrong direction.
2. **`vendor_payment_allocations.invoice_id` is `ON DELETE RESTRICT` onto
   `purchase_invoices`.** A missing bill is not a missing allocation; it is
   an allocation that cannot exist.
3. **The withholding is one number for the payment.** TDS is deducted on
   the payment, not per bill, and `tds > gross` is refused. A partial
   payment carrying the whole deduction over-withholds; carrying a
   pro-rated share puts a figure in the quarterly return that no
   challan matches.

**The framework can express this today.** `atomic: true` plus a `fileRule`
is exactly the shape the opening trial balance uses, and its comment
covers this case verbatim: *"the refusal is expressed as ROW ERRORS, not
as a `fatal`"*, so every row still reaches the failed-rows CSV. The unit
should be the PAYMENT, not the file — which the framework cannot yet say,
because `atomic` is whole-file. That is the same missing `groupBy` the
multi-line purchase bill needs (§5 and PATCH-REQUEST §5); one mechanism
would serve both.

**Recommended contract when the schema lands**, so the next author does not
re-derive it:

```
dependsOn:          purchase-bills (hard) — an allocation needs the bill
reversal:           reverse-entry — the payment posts a journal entry and
                    a vendor-ledger debit; deleting it leaves both behind
duplicateModes:     ["skip", "fail"]     — vendor_payments_number_unique
duplicateDecision:  skip
requiredness:       ["vendorId"]         — a payment to nobody is not a payment
provenance:         targets ["vendor_payments"], cardinality "many"
```

---

## 5. What was found while building the two that ship

### 5.1 🔴 A `money` column changes unit at `buildPayload` and nothing says so

```
lib/import/values.ts:138     coerceMoneyMinor(raw, exponent = 2)   "1,250.50" → "125050"
lib/validators/purchases.ts:45   moneyString  /^-?\d+(\.\d{1,2})?$/  — MATCHES "125050"
lib/billing/money.ts:72      parseMoney(amount, currency = "INR")  — ×100
```

Passing the coerced value straight through is **not a type error, not a
validation error and not a runtime error**. It is a bill for ₹125,050
where the customer wrote ₹1,250.50, written successfully, on every row of
the file. `rupeesFromMinor` in `lib/import/entities-purchases.ts` closes
it, using string arithmetic rather than `Number(v)/100` for the same
reason `thousandthsToDecimal` does.

**Proved and induced:**

```
✓ ₹1,250.50 is stored as 125050 paise and not as ₹125,050

# induction: amount: rupeesFromMinor(values.amount) → (values.amount as string)
× ₹1,250.50 is stored as 125050 paise and not as ₹125,050
× the vendor ledger was credited in the same transaction
      Tests  2 failed | 23 passed (25)
```

**This affects every entity phase that imports money through a
`lib/validators/` schema.** The opening-balance entities are safe because
`opening-schemas.ts` validates minor units deliberately. Phases 5, 7 and 8
should check which unit their chosen validator wants before trusting the
coercion layer's output.

### 5.2 🔴 `recordPurchaseInvoiceSchema` requires a `vendorId` the row cannot have

The framework validates before it resolves lookups:

```
lib/import/plan.ts:282   entity.schema.safeParse(payload)
lib/import/plan.ts:337   entity.lookups?.(parsedPayload)
```

`recordPurchaseInvoiceSchema` requires `vendorId: uuid`. No customer's
purchase register carries our uuids, and `z.object` strips unknown keys,
so `vendorCode` would not survive the parse for `lookups` or `naturalKey`
to read even if the parse succeeded.

**The tempting fix — a copy of the schema with `vendorId` swapped for
`vendorCode` — is forbidden and would have been expensive.** It would have
left behind four `superRefine` rules, each with a statutory consequence:
Section 12(3) place of supply for immovable property, the Rule 46(p)
reverse-charge citation, the Section 17(5)(e) bill-of-supply rule, and the
capital-goods-into-own-building rule the validator itself calls *"the
cheapest place to catch the most expensive mistake"*.

**`importPurchaseBillSchema` delegates instead of copying.** It runs
`recordPurchaseInvoiceSchema` with a placeholder uuid, re-raises every
issue it produces at its own path, **deletes the placeholder from the
output**, and re-attaches `vendorCode`. All four rules fire, in the
preview, with the form's own sentences:

```
✓ a bill of supply carrying tax is refused — Section 17(5)(e)
✓ reverse charge with no section is refused — Rule 46(p)
✓ immovable property with no property state is refused — Section 12(3)
✓ capital goods into our own building must be marked as capital
✓ the MSME rules fire on the vendor import too — Section 43B(h)
✓ an MSME claim with no Udyam number is refused
```

The placeholder is deleted rather than left in, so a payload reaching the
write with no `vendorId` is a payload with no `vendorId` — refused by name
in `purchaseInvoicesWriter`, and named in `requiredness.structural` for
the customer-facing sentence.

### 5.3 🔴 Nothing in this product ever writes `purchase_invoices.due_date`

```
$ grep -rn "purchaseInvoices" --include=*.ts server/ app/ lib/ \
    | grep -E "\.insert\(|\.update\("
  server/actions/purchase-orders.ts:686   .update  → matchState, matchNote
  server/actions/purchases.ts:434         .insert  → (no dueDate)
  server/actions/purchases.ts:719         .update  → status
  server/fx/initial-recognition.ts:315,377   .update → fx columns
  server/fx/revaluation-service.ts:536,910   .update → fx columns
```

Seven write sites; not one names `dueDate`. `recordPurchaseInvoiceSchema`
has no such member. The column exists (SQL 0063 line 294) and is READ
twice — `server/actions/vendor-payments.ts:119` into the ageing and
`:320` into `allocateOldestFirst`. **Every purchase bill in this product
has a NULL due date, and the payment run allocates oldest-first over a
column that is always null.**

The import therefore ships **no due-date column**. It could only be set by
a second statement after `recordPurchaseInvoice` returns, outside the
transaction that wrote the bill — and if that statement failed, the bill
would exist, the row would be reported as an error, and the re-run would
SKIP it as a duplicate. The due date would be lost permanently and the
report would have said the bill was not imported. Half a write dressed as
a whole one. The two-line patch is PATCH-REQUEST §3.

### 5.4 🔴 Copying `gstPartiesWriter.findExisting` into the vendor writer is a bug

`gstPartiesWriter` filters `is_active = true`, correctly: its index is
`WHERE … AND is_active`, so a retired registration must be re-addable.
`vendors_code_tenant_unique` has **no** predicate, so a blocked vendor
still owns its code. With the filter copied across, the importer finds no
match, plans a CREATE, and Postgres refuses with `23505` — on every vendor
the customer has ever blocked, after a preview that promised the row.

```
✓ re-importing a blocked vendor skips rather than colliding on the index

# induction: add eq(vendors.isActive, true) to the vendor findExisting
× re-importing a blocked vendor skips rather than colliding on the index
      Tests  1 failed | 24 passed (25)
```

### 5.5 The natural key is the unique index, expression for expression

`purchase_invoices_no_duplicate_bill` is on
`(tenant_id, vendor_id, upper(btrim(invoice_number)), indian_financial_year(invoice_date)) WHERE status <> 'cancelled'`.
`naturalKey` builds `lower(code)|UPPER(TRIM(number))|financialYearOf(date)`
and `findExisting` mirrors it, including the cancelled predicate.
`financialYearOf` (`lib/gst/constants.ts:155`) produces the same `2024-25`
spelling as the SQL function; both sides call it, so there is one place
that decides where 1 April falls.

```
✓ purchase bills: load, load again, count unchanged
✓ purchase bills: the number, the case and the spacing all collapse
✓ purchase bills: the same serial in the NEXT financial year is a new bill

# induction: drop the financial year from the natural key
× purchase bills: load, load again, count unchanged
× purchase bills: the number, the case and the spacing all collapse
      Tests  2 failed | 23 passed (25)
```

The induced failure is instructive: dropping the year from the pure layer
while the writer still builds it makes the two sides **silently
disagree**, nothing matches, every row is planned as a create, and the
database refuses each with `23505`. That is what a divergence looks like.

### 5.6 The ITC purpose has no default and the file is refused without it

`lib/validators/purchases.ts:288` says the column defaults to
`taxable_supply` *"so that an import of historical bills does not fail"*
and that the form must not, because *"Section 17(5)(d) is the single most
expensive mistake in this product"*. This import goes through the form's
schema, so it inherits the refusal. `required: true` on the column turns
that into **one sentence about the file** rather than an error on every
row:

```
✓ no ITC-purpose column is a FATAL, not five thousand silent claims
```

A five-thousand-row file that silently claims credit on five thousand
bills is exactly the failure that note describes, at scale.

### 5.7 Provenance cannot name the tables the entity actually writes

`purchase-bills` writes `purchase_invoices`, `purchase_invoice_lines`,
`vendor_ledger_entries`, `journal_entries` and `transactions` in one
transaction. `ImportProvenancePolicy.targets` is typed over
`ImportTableKey`, and `ImportTableKey` is **also** the key of
`IMPORT_WRITERS`, a `Record` over that union. Naming
`purchase_invoice_lines` in provenance is therefore a compile error
demanding a *writer* for a table that is never written on its own.

The contract declares `targets: ["purchase_invoices"]` and
`cardinality: "many"`, which is what stops a reconciler reporting false
misses — but the sidecar can attribute the header and nothing under it.
Splitting the destination union from the provenance union is
PATCH-REQUEST §2.

---

## 6. What could NOT be proved, and why

Two of the brief's five proofs were not run, and neither is a matter of
opinion.

### 6.1 🔴 Undo cannot be tested because there is no undo and no provenance

```
$ grep -rn "import_row_provenance" SQL-FILES/ db/ server/
  (no output)
$ grep -rn "import_row_provenance\|importRowProvenance" --include=*.ts .
  lib/import/types.ts:337   "⭐ SO PROVENANCE IS A SIDECAR: one table, `import_row_provenance` …"
  lib/import/types.ts:356   "… used by `import_row_provenance.target_table`"
```

`types.ts:337` cites **"see SQL 0196"**. There is no SQL 0196; the highest
numbered file before this phase is 0168 and 0196–0199 is M1's *reserved*
block. `server/import/` contains `runs.ts` but no `reversal.ts` and no
`ledger.ts`; Phase 2 has not landed.

So **every `reversal` policy in this product, including the six that
predate Phase 6, is a declaration with nothing behind it.** Phase 6's two
are declared to the contract's rules and refused by gate 29 if they are
incoherent — `reverse-entry` with `update` offered is refused by name, and
`purchase-bills` offers no `update` — but "Undo restores the prior state
exactly" **was not run and is not claimed here.** Saying so is the point;
the brief's whole standard is that a claim is worth what its evidence is
worth.

### 6.2 The test harness's WebSocket bridge does not work on this tree

`db/index.ts` opens its transactional pool with `@neondatabase/serverless`
over a WebSocket; `tests/setup.ts` bridges it with a loopback WS-to-TCP
proxy. Every `withTenant` call hangs until the 30-second timeout.

**Checked rather than assumed** — a file that predates Phase 6 and touches
none of it:

```
$ npx vitest run --project=security tests/security/idempotency-money-movement.test.ts
      Tests  12 failed (12)      — all of them 30 s timeouts
```

`_ws-shim-standalone-probe.mts` at the repository root shows somebody has
fought this before. `tests/setup.ts` belongs to track H.

**So the transport was swapped and nothing else was.**
`tests/security/import-purchases.test.ts` mocks `@/db` with a `withTenant`
that is `db/index.ts:286` line for line — the same
`set_config('app.current_tenant_id', $1, true)` inside the same real
transaction — over `drizzle-orm/node-postgres`. **It connects as
`ordence_app`, which has `NOBYPASSRLS`**, so a missing policy is a test
that fails rather than a test that passes. Everything above the transport
is real: the planner, the natural-key match, `resolveLookups`, both
writers, `recordPurchaseInvoice`, `pricePurchase`, the ITC determination,
every CHECK constraint and the 0147 trigger.

`npm run build` also could not be run here: it is OOM-killed in this
container at 8 GB with 2 cores, with and without
`--max-old-space-size=6144`. The one property the build would have proved
that the gates do not — that `registry.ts`'s module-load check accepts
both new writers — **is** proved, by the first test in the file, which
imports `IMPORT_WRITERS` and would throw at module load if either writer
declared both or neither of `writeRow`/`writeFile`.

---

## 7. The five proofs the brief asked for

```
$ npx vitest run --project=security tests/security/import-purchases.test.ts
      Tests  25 passed (25)
```

| Asked | Result |
|---|---|
| A re-run of the whole file creates nothing the second time | ✓ both entities, row counts read back from Postgres |
| Preview counts equal commit counts, including when a lookup misses | ✓ 2 create / 1 error in both, and the dry run touched nothing |
| Undo restores the prior state exactly | **NOT RUN** — §6.1 |
| A row missing a structural field is refused in the PREVIEW, with the message written, and appears in the failed-rows CSV with its original values intact | ✓ including `2500.75` coming back as `2500.75` and not as `250075` |
| `npm run check:import-contract` passes and names the entities in the expected wave | ✓ 8 entities, `vendors` wave 0, `purchase-bills` wave 1 |

Three properties were induced to failure and restored (§5.1, §5.4, §5.5).

### SQL 0240 — proved by attempting seven writes, then induced four ways

```
$ psql -d ordence_test -f SQL-FILES/0240_purchase_import_reentrancy_proof.sql
  NOTICE:  0240 OK — seven writes attempted. …  Nothing was left behind.
$ psql -tAc "select count(*) from tenants where slug like '0240-probe-%'"
  0
```

Each induction was run inside a transaction and rolled back:

| induced | 0240 refused with |
|---|---|
| `DROP INDEX purchase_invoices_no_duplicate_bill` | "the same vendor's bill INV-001 was accepted twice in one financial year" |
| index rebuilt on the **bare** `invoice_number` | "`  inv-001 ` was accepted alongside `INV-001` … the importer mirrors that expression and now mirrors nothing" |
| index rebuilt **without** `WHERE status <> 'cancelled'` | "a bill could not be re-entered after the first was cancelled" |
| `DROP INDEX vendors_code_tenant_unique` | "a second vendor with the code V-0240 was ACCEPTED" |

The three acceptances are as load-bearing as the four refusals: an index
that refused everything would pass every refusal test and take the product
down on 1 April, when a vendor restarts numbering at 001.

---

## 8. Things the next phase should know

1. **Check which unit your validator wants before trusting the coercion
   layer.** §5.1. `coerceMoneyMinor` gives paise; `lib/validators/`
   schemas that use `moneyString` want rupees, and the wrong one validates.
2. **Two entities on one destination is now the unguarded case.** §3.
   Phase 1 removed the fall-through; it cannot catch a writer serving
   another entity's payload shape.
3. **If your validator takes a uuid the file cannot carry, delegate — do
   not copy.** §5.2. The pattern is in `importPurchaseBillSchema` and it
   costs about thirty lines.
4. **Merging `track-ownership-phases.json` is necessary and not
   sufficient.** 0181–0195 belong to nobody, and the first phase to ship a
   numbered file above them turns `check:migrations` red for everyone.
   PATCH-REQUEST §1.
5. **The floor in gate 29 is 6 and its own message says to raise it.** It
   cannot be raised by each phase independently without breaking whichever
   phases have not merged yet. PATCH-REQUEST §8 proposes doing it once, at
   integration.
