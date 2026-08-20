# PATCH-REQUEST-PHASE-5 — what Phase 5 needs in files it does not own

Repo `app.ordence`, tree **v1.85.0-alpha**. Phase 5 owns
`lib/import/entities-sales.ts`, `server/import/writers/sales/**` and SQL
`0230`–`0239`. Everything below is in somebody else's file.

Five requests. **§1 to §3 are required for Phase 5 to be reachable and
for CI to be green. §4 and §5 are findings that belong to other tracks;
neither blocks this delivery.**

Every hunk in §1–§3 was applied to a local copy of v1.85.0-alpha and the
whole gate set run against it. The evidence is in `TRACK-REPORT.md §1`.
Unapplied, the entities compile and are **not reachable**, which is the
correct resting state — reach is membership in `ALL_IMPORT_ENTITIES` and
nothing else.

---

## §1 — Three one-line edits that make the two entities reachable

### 1a · `lib/import/types.ts` — one new destination

`customer_receipts` joins the `ImportTableKey` union.

```diff
   | "vendor_ledger_entries"
-  | "stock_movements";
+  | "stock_movements"
+  /**
+   * ⭐ PHASE 5 — CUSTOMER RECEIPTS.
+   *
+   * Money received from a customer and not yet applied to an invoice.
+   * Written one row at a time, like `companies`, and — unlike the
+   * single-record action that writes the same table — posting NOTHING to
+   * the general ledger: an imported receipt is sub-ledger detail beside
+   * an opening trial balance that already carries the bank and the
+   * debtors. See `lib/import/entities-sales.ts`.
+   */
+  | "customer_receipts";
```

⚠️ **This edit alone does not compile, and that is Phase 1 working.**
`IMPORT_WRITERS` is a `Record` over this union, so adding a member
without 1b is a compile error at `registry.ts` naming the missing
destination. Apply 1a and 1b together or neither.

### 1b · `server/import/writers/registry.ts` — the writer for it

```diff
 import { companiesWriter } from "./companies";
+import { customerReceiptsWriter } from "./sales/customer-receipts";
 import { gstPartiesWriter } from "./gst-parties";
@@
   stock_movements: stockMovementsWriter,
+  customer_receipts: customerReceiptsWriter,
 };
```

The writer file itself is Phase 5's and is in the delivery at
`server/import/writers/sales/customer-receipts.ts`. It declares
`writeRow` and not `writeFile`, which is what the registry's module-load
check requires.

### 1c · `lib/import/entities.ts` — the single-line spread

```diff
 import { OPENING_IMPORT_ENTITIES } from "./opening-entities";
+import { SALES_IMPORT_ENTITIES } from "./entities-sales";
@@
 export const ALL_IMPORT_ENTITIES = {
   ...IMPORT_ENTITIES,
   ...openingWithContracts,
+  ...SALES_IMPORT_ENTITIES,
 } as const satisfies Record<string, ContractedImportEntity>;
```

⚠️ **Nothing else in that file changes.** Five phases each adding one
line is five clean merges. `isImportEntityKey` keeps its shape, the map
stays the one allowlist, and the two new entities inherit the contract
requirement from the map's element type rather than from anything here.

After 1a–1c, on the local tree:

```
npx tsc --noEmit                → clean
npm run check:import-contract   → 8 entities, 2 waves
                                  wave 0: companies, customers, gst-parties,
                                          opening-stock, opening-trial-balance
                                  wave 1: opening-customer-invoices,
                                          opening-vendor-bills, receipts
npm run check:writer-registry   → induction still refuses an unregistered
                                  destination and names the registry
```

---

## §2 — `scripts/track-ownership.json`: the phases map does not merge as written

🔴 **`track-ownership-phases.json` cannot be merged into
`scripts/track-ownership.json` as delivered.** Merging it verbatim
produces **28 violations** from `npm run check:track-ownership` and keeps
`check:migrations` red. Three separate collisions, each with a fix:

### 2a · PHASE-1…10 and M2…M8 are the same tracks under two names

| existing | phases file | overlap |
|---|---|---|
| M2 `Import ledger` 200–206 | PHASE-1 200–204, PHASE-2 205–214 | 200–206 |
| M3 **`Sales entities`** 207–210 | PHASE-2 | 207–210 |
| M4 `Supply entities` 211–214 | PHASE-2 | 211–214 |
| M5 `People entities` 215–218 | PHASE-3 215–219 | 215–218 |
| M7 `Discovery and dry run` 219–222 | PHASE-3, PHASE-4 220–229 | 219–222 |
| M8 `Reconcile and cutover` 223–226 | PHASE-4 | 223–226 |

M3 is *"Sales entities"* and so is PHASE-5; M7 is *"Discovery and dry
run"* and so is PHASE-3; M8 is *"Reconcile and cutover"* and so is
PHASE-10. These are not two sets of tracks competing for numbers — they
are one set of tracks that was renamed and re-blocked, and the old
entries were never removed.

**Fix: delete `M2` through `M8`. Keep `M1`** (`Import contract`,
196–199), which has delivered and whose paths are real. PHASE-1…10
supersede the rest.

### 2b · PHASE-1 claims the whole writers directory

The phases file's own comment anticipates this — *"PHASE-1 must exclude
those subdirectories once they exist"* — but the gate has no notion of
exclusion, so `server/import/writers/**` collides with all five entity
phases' subdirectories.

**Fix: narrow PHASE-1 to the files it actually owns.**

```json
"PHASE-1": {
  "name": "Writer registry",
  "sql": [200, 204],
  "paths": ["server/actions/import.ts", "server/import/writers/*.ts"]
}
```

A single `*` does not descend, so `registry.ts`, `types.ts`, `shared.ts`
and the six original writers stay PHASE-1's while
`server/import/writers/sales/**` is Phase 5's.

### 2c · 0181–0195 belong to nobody, and `0230` is what makes that fatal

`check:migrations` tolerates a gap only where a block reserves the
number. Nothing reserves 0181–0195. With the highest file at 0168 that
was invisible; the moment any file lands above it — Phase 5's `0230` is
the first — every unreserved number below becomes *"Missing migration
NNNN — the sequence jumps over it"*, and **15 of those errors are not
Phase 5's to fix**.

**Fix: reserve them, or state that they were never allocated.** The local
proof used a placeholder block:

```json
"UNASSIGNED-181-195": {
  "name": "reserved, unclaimed (see PATCH-REQUEST-PHASE-5.md §3)",
  "sql": [181, 195],
  "paths": []
}
```

Integration should replace that with whoever actually owns 0181–0195, or
add them to `KNOWN_GAPS` with the reason. Either is a decision; the
placeholder is not.

With 2a + 2b + 2c applied: **`npm run gates:static` → 28/28 passed**, and
`check:migrations` reports *"155 files, 0001…0230, next number 0231"*.

---

## §3 — What a historical invoice schema would have to express

Phase 5 refuses `sales-invoices` and `credit-notes`. `TRACK-REPORT.md §3`
gives the evidence; this section is the part somebody else has to decide,
written out so the refusal does not simply get asked again in three
weeks.

**Owner: whoever owns `lib/validators/sales-invoices.ts` and
`server/actions/sales-invoices.ts`.** It is not an import decision, which
is exactly why Phase 5 did not take it.

### The decision, in one sentence

*May a sales invoice exist in Ordence that was numbered by another
system?*

Today the answer is no, and it is deliberate. `issueInvoiceSchema`:

> ⚠️ THERE IS NO `invoiceNumber` FIELD AND THERE NEVER WILL BE. The
> number is derived inside the transaction that issues the document. A
> caller who can choose it can collide with a document already in a
> customer's file, and Rule 46(b) requires the series to be consecutive —
> a caller-supplied number cannot be.

Every word of that is about invoices Ordence RAISES. Whether it also
governs invoices Ordence merely REMEMBERS — issued by software being
switched off, under a series that closed before this workspace existed —
is the open question.

### If the answer becomes yes, a `recordHistoricalInvoiceSchema` must express

1. **An externally supplied `invoiceNumber`** (≤ 60 chars, matching
   `sales_invoices.invoice_number`), unique per tenant — the database
   index already enforces that — and **segregated from the live series**,
   so `issueInvoice`'s next number can never collide with an imported
   one. Today's numbering derives from a count; see §4.
2. **`financialYear`**, from the invoice's own date via
   `financialYearOf`, never from today. Rule 46(b) is per financial year
   and the Indian one turns on 1 April.
3. **No `orderId`.** This is the structural difference from
   `raiseInvoiceFromOrderSchema`, which requires a *confirmed* Ordence
   order and takes the customer, the place of supply, every line and the
   frozen tax determination from it. A migrated invoice has none.
4. **A customer named rather than identified** — the file cannot carry a
   uuid. `receipts` shows the shape that works: the name is a schema
   field, the lookup resolves it in the preview, the writer re-parses the
   full schema with the uuid present.
5. **GST captured as at issue, not re-derived.** `customerGstin`,
   `customerLegalName`, `placeOfSupplyCode`, `isInterState` are frozen
   facts on a document that has already been reported. Re-deriving them
   from today's addresses would re-split a historical document between
   IGST and CGST + SGST — the failure `raiseInvoiceFromOrder` documents
   at length and deliberately avoids.
6. **A status that is not `draft`.** `sales_invoices_issued_has_stamp`
   requires `issued_at` on anything not draft or cancelled, and an
   imported invoice is neither draft nor issued by us.

### Rules `raiseInvoiceFromOrderSchema` enforces that it must still enforce

- the three GST identity rules, through `upsertPartySchema` on the party
  it names (a `regular` party has a GSTIN; an `unregistered` one has
  none; a state code agrees with the GSTIN's first two digits);
- `sales_invoices_gst_mutually_exclusive` — IGST or CGST + SGST, never
  both;
- `sales_invoices_amounts_non_negative` and
  `sales_invoices_received_within_total`;
- money as `bigint` minor units end to end, never a float;
- and the one this phase cares about most: **it must post nothing to the
  general ledger while an opening trial balance carries the debtors.**
  See `TRACK-REPORT.md §4`.

### And the question that has to be answered first

**Does the customer need it at all?** Open receivables — the part needed
to trade on day one — already migrate through
`opening-customer-invoices`, which exists, is contracted and has a
writer. What §3 buys is historical invoice *history*: line detail and tax
on documents that were reported to the Government by another system.
That is a reporting convenience, not a cutover requirement, and it is
worth pricing before the numbering rule is reopened.

`credit-notes` is downstream of this in every sense:
`sales_credit_notes.invoice_id` is `NOT NULL`, so without importable
invoices there is nothing for a credit note to be about.

---

## §4 — Finding for the sales track: receipt numbering can hand out a used number

**Not Phase 5's file. Reported, not fixed.**
`server/actions/sales-invoices.ts`, `recordCustomerReceipt`:

```ts
const [row] = await tx
  .select({ count: sql<number>`count(*)::int` })
  .from(customerReceipts)
  .where(eq(customerReceipts.tenantId, ctx.tenant.id));

const receiptNumber = `RCP/${String((row?.count ?? 0) + 1).padStart(6, "0")}`;
```

Two defects, and the second is why Phase 5 is writing this down now:

1. **`count(*)` is not a reservation.** Two receipts recorded at the same
   moment compute the same number and one dies on
   `customer_receipts_number_tenant_key`.
2. **It counts rows rather than reading the highest number issued.** Any
   deletion makes the next receipt reuse a number that has already been
   on a customer's statement. Phase 5's `reversal: delete` is exactly such
   a deletion — which is why the import writer does **not** imitate this
   scheme: an imported receipt is numbered `IMP-RCP/<8 hex>`, unique by
   construction and visibly outside the `RCP/` series.

**Suggested fix (owner's call):** derive from
`max(receipt_number)`-by-suffix inside the transaction, or a per-tenant
sequence, as `transactions.transaction_number` already does.

---

## §5 — Finding for M1/Phase 2: three of the five contract members are inert

`TRACK-REPORT.md §2` has the evidence. In one line each:

- **`provenance`** — `import_row_provenance` is cited as SQL 0196.
  `SQL-FILES/` stops at 0168 and no file in it mentions the table. There
  is no sidecar, so nothing can attribute a row to a run.
- **`reversal`** — no engine reads it. `server/import/reversal.ts` does
  not exist (it is Phase 2's, blocks 0205–0214).
- **`requiredness`** — read by `checkImportContract()` and by nothing
  else. `lib/import/plan.ts` and `server/actions/import.ts` contain no
  occurrence of the string.

Phase 5 declares all three correctly and does not claim any of them
works. Their absence is asserted from both sides, so the day one of them
lands the assertion fails and this note gets deleted:

- `tests/ui/import-sales-entities.test.ts` — no `requiredness` in
  `plan.ts` or `server/actions/import.ts`; no `0196` and no
  `import_row_provenance` anywhere in `SQL-FILES/`; no
  `server/import/reversal.ts`.
- `tests/security/import-receipts-rerun.test.ts` — against the
  bootstrapped database, `to_regclass('public.import_row_provenance')`
  returns `NULL`.
