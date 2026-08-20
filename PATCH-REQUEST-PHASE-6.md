# PATCH REQUEST — Phase 6 (entities: purchases)

Everything Phase 6 needs in a file it does not own. Sections **1–4 are
required** — without them the two entities compile but are unreachable, or
the repository's own gates go red. Sections **5–9 are proposals** and are
each argued rather than asserted.

**Every required patch below was applied to a local copy of
v1.85.0-alpha and the whole gate set was run against the result.** The
outputs are in `TRACK-REPORT-PHASE-6.md`; the short version is:

```
npx tsc --noEmit             (silent)
npm run gates:static         28/28 passed
npm run check:import-contract  ✅ 8 entities, 2 waves
npm run check:writer-registry  ✅ induction still refuses
npm run check:migrations       ✅ 155 files, 0001…0240
npm run check:track-ownership  OK SQL blocks
npx vitest run --project=security tests/security/import-purchases.test.ts
                               Tests  25 passed (25)
```

---

## 1. REQUIRED — `scripts/track-ownership.json`

Three edits, and **the second is the one that will be missed.**

### 1a. Merge the phase blocks, REPLACING M2–M8 rather than adding to them

`track-ownership-phases.json` ships with the phase briefs. Merge its
`tracks` into `scripts/track-ownership.json` — but **delete the existing
`M2` … `M8` entries first.** They reserve 0200–0226, which the phase
blocks also reserve. Two owners for one number is ambiguous ownership, and
`reservedNumbers()` in `check-migrations.mjs` silently keeps the last
writer, so nothing complains.

### 1b. 🔴 Reserve 0181–0195, or the first phase to ship SQL turns the gate red

**Merging the phases file is necessary and not sufficient.** After the
merge the reserved space runs 0129–0180 and 0196–0299. Nothing owns
**0181–0195**, and `check:migrations` only tolerates a gap "where a block
reserves the number AND no file uses it". The moment any phase ships a
numbered file above 0195 — Phase 6's `0240` is the one that did it here —
fifteen numbers become gaps in nobody's block:

```
$ npm run check:migrations
  ::error::Missing migration 0181 …  (×15)
  ❌ Migration numbering FAILED — 15 problem(s).
```

Add:

```json
"UNALLOCATED-181-195": {
  "name": "unallocated — held open so a later reserved block does not read as a gap",
  "sql": [181, 195],
  "paths": []
}
```

After which:

```
✅ Migrations contiguous — 155 files, 0001…0240 (6 documented historical gaps).
```

### 1c. Narrow PHASE-1's path claim, which the phases file already asks for

`track-ownership-phases.json`'s own `_comment` says *"PHASE-1 must exclude
those subdirectories once they exist."* They exist now:

```
$ npm run check:track-ownership
  x tracks PHASE-1 and PHASE-4 both claim: "server/import/writers/**" vs "server/import/writers/crm/**"
  x tracks PHASE-1 and PHASE-5 …
  x tracks PHASE-1 and PHASE-6 …
  x tracks PHASE-1 and PHASE-7 …
  x tracks PHASE-1 and PHASE-8 …
  5 violation(s).
```

Change PHASE-1's `paths` from

```json
["server/actions/import.ts", "server/import/writers/**"]
```

to

```json
["server/actions/import.ts", "server/import/writers/*.ts"]
```

`*.ts` matches the registry and the root-level writers and not the
per-phase subdirectories. Verified: `OK SQL blocks`.

---

## 2. REQUIRED — `lib/import/types.ts` (Track M1): two destinations

```diff
   | "vendor_ledger_entries"
-  | "stock_movements";
+  | "stock_movements"
+  /**
+   * ⭐⭐ PHASE 6 — THE PURCHASE DESTINATIONS.
+   *
+   * `vendors` is the payee master: a continuing relationship with payment
+   * terms, an MSME registration and a running balance. It is NOT
+   * `gst_parties` with `party_type = 'vendor'`; `db/schema/purchases.ts`
+   * argues that at length and the columns Section 43B(h) is enforced from
+   * live here.
+   *
+   * `purchase_invoices` is the vendor's bill. One input row writes the
+   * header, one line, a vendor-ledger credit and a journal entry, which is
+   * why its provenance cardinality is `many`.
+   */
+  | "vendors"
+  | "purchase_invoices";
```

⚠️ **Apply this together with §3.** Widening the union without adding the
writers is a compile error at `registry.ts` naming the missing
destinations — which is Phase 1 working exactly as intended, and is what
this patch is for.

---

## 3. REQUIRED — `server/import/writers/registry.ts` (Phase 1): two writers

```diff
 import { vendorLedgerEntriesWriter } from "./vendor-ledger-entries";
+import { vendorsWriter } from "./purchases/vendors";
+import { purchaseInvoicesWriter } from "./purchases/purchase-invoices";
 
 export const IMPORT_WRITERS: Record<ImportTableKey, ImportWriter> = {
   …
   stock_movements: stockMovementsWriter,
+  vendors: vendorsWriter,
+  purchase_invoices: purchaseInvoicesWriter,
 };
```

Both writers declare `writeRow` and not `writeFile`, so the registry's
module-load check accepts them. That check is exercised for real by the
first test in `tests/security/import-purchases.test.ts`, which imports
`IMPORT_WRITERS` — a writer declaring both or neither would throw before
the assertion ran.

---

## 4. REQUIRED — `lib/import/entities.ts` (owned by nobody): one line

**This is the file five phases each add one line to.** Phase 6's line is
the spread; the import beside it is the second.

```diff
 import { OPENING_CONTRACTS } from "./contract/opening-policies";
+import { PURCHASE_IMPORT_ENTITIES } from "./entities-purchases";
 import type { ContractedImportEntity } from "./types";
```

```diff
 export const IMPORT_ENTITIES = {
   companies: companiesEntity,
   "gst-parties": gstPartiesEntity,
+  ...PURCHASE_IMPORT_ENTITIES,
 } as const satisfies Record<string, ContractedImportEntity>;
```

⚠️ **`IMPORT_ENTITIES`, not `ALL_IMPORT_ENTITIES`.** These are lists a
customer loads because they have them — the general picker. The
opening-balance entities have their own screen because they are a one-time
migration with an order to it. `ALL_IMPORT_ENTITIES` picks both up and
remains the single allowlist on the write path; `isImportEntityKey`
remains membership in it. Verified:

```
✓ isImportEntityKey("vendors")        → true
✓ isImportEntityKey("purchase-bills") → true
✓ isImportEntityKey("constructor")    → false
✓ isImportEntityKey("__proto__")      → false
```

---

## 5. REQUIRED — `tests/security/import-purchases.test.ts` (track D's path)

A **new** file, not an edit. It is in `tests/security/**` because
`vitest.config.ts` collects only `tests/security/**` and `tests/ui/**` —
a test written anywhere else never runs, which is the same defect as a
writer that is never reached.

It needs no change to `vitest.config.ts` and no change to
`tests/setup.ts`. It mocks `@/db`'s transport for the reason set out in
`TRACK-REPORT-PHASE-6.md` §6.2 — the harness's WebSocket bridge does not
complete a handshake on this tree, and a file that predates Phase 6 fails
12/12 with 30-second timeouts to prove it is not this phase's doing. The
substitution connects as `ordence_app`, which has `NOBYPASSRLS`, so a
missing policy is still a test that fails.

**If track H fixes the bridge, delete the `vi.mock("@/db", …)` block and
the file should pass unchanged.** That is the intended end state and the
mock is written to be removable in one piece.

---

## 6. PROPOSED — `server/actions/purchases.ts`: let a bill carry its due date

**The finding:** nothing in this product writes
`purchase_invoices.due_date`. Seven write sites, none of them names it
(`TRACK-REPORT-PHASE-6.md` §5.3). It is READ twice, in
`server/actions/vendor-payments.ts:119` and `:320`, so the payment run
allocates oldest-first over a column that is always null.

Two lines. In `lib/validators/purchases.ts`, inside
`recordPurchaseInvoiceSchema`, beside `receivedDate`:

```ts
    /**
     * ⚠️ NOT DERIVED FROM THE INVOICE DATE PLUS THE VENDOR'S TERMS WHEN
     * IT IS ABSENT. Terms in Ordence are TODAY's terms; the terms on a
     * two-year-old bill were whatever they were then. For an MSME vendor
     * this date is statutory — Section 15 caps the agreed period at 45
     * days and Section 43B(h) disallows the expenditure if payment is
     * later — so a guess here is a guess with a tax consequence.
     */
    dueDate: civilDaySchema.optional().nullable(),
```

and in `recordPurchaseInvoice`'s insert, beside `receivedDate`:

```ts
          dueDate: data.dueDate ?? null,
```

Phase 6 then adds one column to `purchase-bills`. It is **not** shipped
before this lands: the importer could only set the due date with a second
statement outside the transaction that wrote the bill, and if that
statement failed the bill would exist, the row would be reported as an
error, and the re-run would skip it as a duplicate — the due date lost
permanently, with the report saying the bill was never imported.

---

## 7. PROPOSED — move `paySchema` into `lib/validators/`, and `payments` becomes buildable

`payments` is refused today because its only schema is a non-exported
`const` inside a server action that imports the database
(`TRACK-REPORT-PHASE-6.md` §4). It cannot be imported into `lib/import/`
at all — rule 7.

**A move, not a rewrite.** Cut `paySchema` from
`server/actions/vendor-payments.ts:236`, paste it into
`lib/validators/purchases.ts` as `export const recordVendorPaymentSchema`,
and import it back. Nothing else changes and the action keeps parsing the
same object.

Phase 6's recommended contract for the entity, so it does not have to be
re-derived, is in `TRACK-REPORT-PHASE-6.md` §4 — including the answer to
"is allocation atomic per payment": **yes, per payment, and the existing
`payVendor` already says so in its own comment.**

---

## 8. PROPOSED — make `vendorLedgerEntriesWriter` entity-aware, and `debit-notes` becomes buildable

`server/import/writers/vendor-ledger-entries.ts:82` hard-codes
`entryType: "purchase_invoice"` and reads `billNumber` / `billDate` /
`outstandingMinor`. A second entity on that destination writes a ledger
entry labelled `purchase_invoice`, with a blank reference and a zero
amount, on the wrong side — and reports success.

🔴 **This is Phase 1's own finding one level down, and it is unguarded.**
The `Record` over the destination union catches a destination with no
writer. It cannot catch a writer serving another entity's payload shape,
and **two entities sharing one destination is now the normal case** — the
contract itself says so: *"Two entities can write the same table … and
they do not have the same predecessors."*

Two possible shapes, and Phase 6 recommends the first:

**(a) Pass the entity key to the writer.** `ImportWriter.writeRow` gains a
fourth argument, the entity key, and each writer switches on it — one
place, explicit, and a writer that does not recognise the key returns
`{ ok: false }` with a sentence rather than writing something plausible.

**(b) Give a debit note its own destination.** `vendor_debit_notes` as a
table of its own, with its own writer. Cleaner, and it is a schema change
in `db/schema/**`, which belongs to track I.

Under either, `debit-notes` uses `addVendorLedgerEntrySchema`
(`lib/validators/purchases.ts:549`, parsed by
`server/actions/purchases.ts:1573`), whose `entryType` enum already
contains `debit_note` and whose `superRefine` already refuses an entry
carrying both a debit and a credit.

---

## 9. PROPOSED — three framework gaps, in decreasing order of cost

### 9a. Split the provenance union from the destination union

`ImportProvenancePolicy.targets` is typed over `ImportTableKey`, which is
also the key of `IMPORT_WRITERS`. So an entity that writes child tables
cannot name them in provenance without demanding a *writer* for a table
that is never written on its own. `purchase-bills` writes five tables and
can attribute one.

```ts
/** Every table a run may write a row into. A superset of ImportTableKey. */
export type ImportProvenanceTableKey =
  | ImportTableKey
  | "purchase_invoice_lines"
  | "journal_entries";
```

`cardinality: "many"` is what currently stops a reconciler reporting false
misses, and it is a blunter instrument than the sidecar deserves.

### 9b. A `groupBy` on the entity definition

`buildPayload` is one row in, one payload out. `atomic`/`batchKey` make the
WHOLE FILE one document. Neither expresses *"these four rows are one
four-line bill"* — or *"these three rows are one payment against three
bills"*, which is the same gap arriving from the other direction (§7 and
`TRACK-REPORT-PHASE-6.md` §4). One mechanism would serve both.

Today `purchase-bills` is one row per bill with a single summary line,
which is the shape of a purchase register exported from Tally or Busy. A
multi-line file is not silently mis-imported: the natural key collapses
the rows and the second is refused **inside the file** with a message
naming the first.

### 9c. A `gst_party_by_gstin` lookup kind, and a decimal-rate column kind

Two small ones, both currently worked around honestly rather than faked:

- **`gst_party_by_gstin`.** `vendors.gst_party_id` links a vendor to its
  tax identity and this import leaves it null, because there is no lookup
  kind for it. `upsertVendorSchema` accepts a `gstin` and `upsertVendor`
  **drops it** — `vendors` has no such column — so offering the column
  would put a value in the customer's file that validates, imports,
  reports success and is stored nowhere. The column arrives with the
  lookup, not before. Adding the kind is one member on `ImportLookupKind`
  and one `if` block in `resolveLookups`.
- **A rate kind.** `purchaseLineSchema.rateBps` is an integer in basis
  points and GST has real rates that are not whole percentages — 0.25% on
  rough diamonds, 1.5% on diamond job work, 3% on gold. `kind: "integer"`
  on a "GST rate %" column cannot express them and `kind: "money"` would
  produce the coercion layer's own message — *"write it as rupees"* — on a
  column that is not rupees. The shipped column is therefore honest and
  unfriendly: **"GST rate (basis points)"**, 1800 for 18%. A
  `kind: "rate"` coercing `18` / `0.25` to `1800` / `25` would fix it for
  every phase that touches a tax rate.

### 9d. Raise gate 29's floor — once, at integration

`scripts/check-import-contract.mjs` sets `FLOOR = 6` and its own message
says *"Raise the floor when entities are added; never lower it."*

⚠️ **It cannot be raised by each phase independently.** A floor of 8
committed by Phase 6 fails for anyone whose tree has Phase 6's entities
and not Phase 5's, and vice versa. It is one edit, made once, after the
last entity phase merges — Phase 6 alone takes it from 6 to 8.
