# CALL-SITES-E — the wiring specification

Track E · Wave 17 · against `app.ordence` 1.81.0-alpha

**This document has a machine-readable twin.** `server/tax/call-sites.ts`
holds the same 42 entries as typed data, and
`tests/security/tax-call-sites.test.ts` fails the suite when the two stop
describing reality. The tables below are **generated from that file**, so
they cannot drift from it. If you are the Wiring track, read this; if you
are automating something, read the register.

---

## 0. Why this is a register and not a list

The brief put it exactly right:

> Naming five and missing the sixth is how two implementations of GST come
> to exist, and two implementations is a defect even when both are right,
> because they will not stay right together.

So the register is not maintained by memory. Three independent derivations
have to agree or the suite goes red:

| check | derived from | catches |
|---|---|---|
| §1 | `information_schema` — every base table with a CGST/SGST/IGST column | a new tax-bearing **table** |
| §2 | the source tree — every `.insert(sym)` / `.update(sym)` and every raw-SQL write | a new **writer** of an existing table |
| §3 | the tree again — each entry's `anchor` substring | a writer that **moved**, was renamed, or was deleted |
| §4 | PostgreSQL — every `assertion` is executed | a **proof** that is fiction |

**§2 earned its place immediately.** The register was written straight out
of an exhaustive audit, by the person who had just done the audit, and it
was **twelve writers short**. Every one of the twelve turned out to write a
tax-bearing table without touching a tax column — FX revaluation, e-way
number write-back, dunning, three-way match — which is precisely the
category a human eye skips. They are all in the register now, under
`non-tax-write`, with the reason, because the alternative is that somebody
scanning for "where do sales invoices get written" finds
`server/actions/eway.ts`, sees an untouched table, and wires a tax
computation into an e-way bill number write-back.

**§4 earned its place too.** Two of the assertions were wrong on the first
draft: `eway_bill_items` has no `invoice_line_id` (items relate to invoice
lines by **position**), and `purchase_order_lines` has no
`line_value_minor` and calls its parent key `po_id`. Both had been written
from what the schema obviously ought to look like. A proof that does not
run is worse than no proof, because it gets pasted, it errors, and the
person pasting it concludes the register is unreliable.

And §4's own **filter** was wrong in the dangerous direction on the first
draft: it excluded any assertion containing `<`, which is SQL's not-equals,
so eight of fourteen were never executed and the block passed anyway. That
is the `count(*) >= 10 THEN 'PASS'` shape one more time, in a test written
specifically to avoid it.

---

## 1. The eight statuses, and what each one obliges you to do

| status | count | what the Wiring track does |
|---|---|---|
| `computes-but-unpinned` | 2 | Already reaches `computeInvoiceTax`. **Wire anyway** — the rate is still the client's. |
| `must-wire` | 13 | The queue. |
| `third-party-figures` | 5 | 🔴 **Do not wire.** These record somebody else's numbers. |
| `aggregate-only` | 3 | Nothing. They sum their children. |
| `master-data` | 1 | Nothing, but see the note — a wrong rate card seeds every order made from it. |
| `non-tax-write` | 12 | Nothing. They write the table and not the tax. |
| `no-tax-columns` | 3 | Nothing, and the honest answer to "wire RA bills" is here. |
| `unreachable` | 3 | Nothing **yet** — wiring dead code is still dead code. |

⚠️ **There is no `done` and no `ignore`.** Every value is a claim the test
can check or that this document has to justify. A bucket meaning "we
decided not to think about this" is where the sixth path goes to hide.

---

## 2. The whole register, at a glance

| # | id | table | writer | status |
|---|---|---|---|---|
| 1 | `sales-invoice-from-order` | `sales_invoices` | `server/actions/sales-invoices.ts` → `raiseInvoiceFromOrder` | **computes-but-unpinned** |
| 2 | `sales-invoice-lines-from-order` | `sales_invoice_lines` | `server/actions/sales-invoices.ts` → `raiseInvoiceFromOrder` | **computes-but-unpinned** |
| 3 | `sales-invoice-from-time` | `sales_invoices` | `server/actions/time-billing.ts` → `raiseInvoiceFromTime` | **must-wire** |
| 4 | `sales-invoice-lines-from-time` | `sales_invoice_lines` | `server/actions/time-billing.ts` → `raiseInvoiceFromTime` | **must-wire** |
| 5 | `credit-note` | `sales_credit_notes` | `server/actions/sales-invoices.ts` → `raiseCreditNote` | **must-wire** |
| 6 | `credit-note-lines` | `sales_credit_note_lines` | `server/actions/sales-invoices.ts` → `raiseCreditNote` | **must-wire** |
| 7 | `sales-order-lines` | `sales_order_lines` | `server/actions/orders.ts` → `createOrder / amendOrder (via lineValuesFor)` | **must-wire** |
| 8 | `stock-transfer` | `stock_transfers` | `server/actions/transfers.ts` → `createTransfer` | **must-wire** |
| 9 | `demand-notice` | `demand_notices` | `server/receivables/demands.ts` → `raiseDemand` | **must-wire** |
| 10 | `brokerage-commission` | `channel_partner_commissions` | `server/actions/sales-brokerage.ts` → `raiseBrokerage` | **must-wire** |
| 11 | `booking-cancellation-reversal` | `bookings` | `server/actions/sales-bookings.ts` → `postBookingCancellation` | **must-wire** |
| 12 | `eway-bill-items` | `eway_bill_items` | `server/actions/eway.ts` → `prepareEwayBill` | **must-wire** |
| 13 | `goods-return-lines` | `goods_return_lines` | `server/actions/goods-returns.ts` → `receiveGoodsReturn` | **must-wire** |
| 14 | `purchase-order-lines` | `purchase_order_lines` | `server/actions/purchase-orders.ts` → `raisePurchaseOrder` | **must-wire** |
| 15 | `boqs` | `boqs` | `server/actions/construction.ts` → `createBoq` | **must-wire** |
| 16 | `purchase-invoice` | `purchase_invoices` | `server/actions/purchases.ts` → `recordPurchaseInvoice` | **third-party-figures** |
| 17 | `purchase-invoice-lines` | `purchase_invoice_lines` | `server/actions/purchases.ts` → `recordPurchaseInvoice` | **third-party-figures** |
| 18 | `gstr2b-rows` | `gstr2b_rows` | `server/actions/gstr2b.ts` → `importGstr2b` | **third-party-figures** |
| 19 | `bank-charge-itc` | `bank_charge_itc_deferrals` | `server/banking/bank-charge-itc-service.ts` → `recordTaxInvoice` | **third-party-figures** |
| 20 | `itc-register` | `itc_register` | `server/actions/purchases.ts` → `recordItcMovement / buildItcForPeriod / runRule42ForPeriod` | **third-party-figures** |
| 21 | `sales-order` | `sales_orders` | `server/actions/orders.ts` → `createOrder` | **aggregate-only** |
| 22 | `order-totals-trigger` | `sales_orders` | `SQL-FILES/0028_phase39_orders.sql` → `ordence_recompute_order_totals()` | **aggregate-only** |
| 23 | `gstr3b-return` | `gst_returns` | `server/actions/returns.ts` → `prepareGstr3b` | **aggregate-only** |
| 24 | `rate-cards` | `rate_cards` | `server/actions/rates.ts` → `saveRateCard` | **master-data** |
| 25 | `invoice-payment-recorded` | `invoices` | `server/actions/billing.ts` → `recordManualPayment` | **non-tax-write** |
| 26 | `invoice-voided` | `invoices` | `server/actions/invoicing.ts` → `voidInvoice` | **non-tax-write** |
| 27 | `eway-number-writeback` | `sales_invoices` | `server/actions/eway.ts` → `recordEwayNumber / cancelEwayBill` | **non-tax-write** |
| 28 | `opening-balance-import` | `sales_invoices` | `server/actions/import.ts` → `writeRow (entity sales_invoices)` | **non-tax-write** |
| 29 | `three-way-match` | `purchase_invoices` | `server/actions/purchase-orders.ts` → `runThreeWayMatch` | **non-tax-write** |
| 30 | `booking-possession` | `bookings` | `server/actions/sales-posting.ts` → `recordPossession` | **non-tax-write** |
| 31 | `fx-initial-recognition-sales` | `sales_invoices` | `server/fx/initial-recognition.ts` → `recogniseSalesInvoice` | **non-tax-write** |
| 32 | `fx-initial-recognition-purchase` | `purchase_invoices` | `server/fx/initial-recognition.ts` → `recognisePurchaseInvoice` | **non-tax-write** |
| 33 | `fx-revaluation-sales` | `sales_invoices` | `server/fx/revaluation-service.ts` → `runRevaluation / settleForeignSalesInvoice` | **non-tax-write** |
| 34 | `fx-revaluation-purchase` | `purchase_invoices` | `server/fx/revaluation-service.ts` → `runRevaluation / settleForeignPurchaseInvoice` | **non-tax-write** |
| 35 | `demand-dunning` | `demand_notices` | `server/receivables/dunning.ts` → `sendDunningLetter` | **non-tax-write** |
| 36 | `demand-receipts` | `demand_notices` | `server/receivables/receipts.ts` → `recordReceipt / bounceReceipt / reallocateReceipt` | **non-tax-write** |
| 37 | `ra-bills` | `ra_bills` | `server/actions/ra-bills.ts` → `raiseRaBillFromMeasurements` | **no-tax-columns** |
| 38 | `ra-bill-lines` | `ra_bill_lines` | `server/actions/ra-bills.ts` → `raiseRaBillFromMeasurements` | **no-tax-columns** |
| 39 | `works-contracts` | `works_contracts` | `scripts/seed-contracting-demo.ts` → `(seed only)` | **no-tax-columns** |
| 40 | `subscription-invoice` | `invoices` | `server/billing/invoice-generator.ts` → `generateInvoice` | **unreachable** |
| 41 | `subscription-invoice-lines` | `invoice_lines` | `server/billing/invoice-generator.ts` → `generateInvoice` | **unreachable** |
| 42 | `post-supply-discount` | `post_supply_discount_invoices` | `server/actions/discounts.ts` → `computeRebate` | **unreachable** |

---

## 3. The queue, in order, with its proofs

⚠️ **Wire `sales-order-lines` (#7) FIRST, before any invoice path.** A sales
invoice copies its rate, its cess rate, its rate pin and its classification
id from the order line — `lib/invoicing/build.ts` says so in capitals:
*"EVERY FIGURE IS COPIED FROM THE ORDER, NOT RECALCULATED."* Wiring the
invoice while the order still takes `hsnSacRateId` from the browser fixes
the symptom on one document and leaves the source intact, and the next
invoice raised from the same order re-imports it.

⚠️ **And wiring `sales-order` (#21, the header) achieves nothing on its own.**
The database trigger `ordence_recompute_order_totals()` rewrites the order
header from the lines on every line write, so the header has two writers and
the trigger has the last word. That is why #21 is `aggregate-only` and #7 is
the one in the queue.

### `sales-invoice-from-order` — `sales_invoices`

**Where.** `server/actions/sales-invoices.ts` → `raiseInvoiceFromOrder`  
**Anchor.** `export async function raiseInvoiceFromOrder`

**Where the tax comes from today.** lib/gst/tax.ts computeInvoiceTax via lib/invoicing/build.ts buildInvoice; but place_of_supply_code and is_inter_state are COPIED from the order row rather than re-derived, and the rate comes from the order line, which got it from the client

**What to call.**

```ts
const tax = await computePersistableTax(tenantId, {
  supplierRegistrationId, supplyType, recipientRegistration,
  recipientStateCode, propertyStateCode, deliveryStateCode,
  taxPointDate: <the document's own date>, lines,
});
if (!tax.ok) return fail(tax.error);

const write = buildTaxWriteForSalesInvoice({ tax: tax.value, documentDate });

const [header] = await tx.insert(<headerTable>)
  .values({ ...write.header, /* the caller's own identity fields */ })
  .returning({ id: <headerTable>.id });

const rows = await tx.insert(<lineTable>)
  .values(write.lines.map((l) => ({ ...l, invoiceId: header.id, /* identity */ })))
  .returning({ id: <lineTable>.id, lineNo: <lineTable>.lineNo });

await recordTaxDecisions(tenantId, buildTaxDecisionsForSalesInvoice({
  tax: tax.value, documentId: header.id, documentDate,
  lineIdByKey: <map the returned ids back by key>,
}), tx);
```

**Before the call, these must hold.**

- The tenant has a gst_registrations row to issue under; quoteTax refuses without one.
- Every line carries an HSN or SAC code. A line without one has no defensible rate and computePersistableTax refuses it by name.
- hsn_sac_rates holds a period covering the invoice date for each classification.

**After the call, these are true.**

- sales_invoice_lines.hsn_sac_rate_id is the registry row the engine resolved, not a client value.
- sales_invoice_lines.hsn_sac_code_id likewise, from quoteTax's codeByLine.
- line_total_minor excludes reverse-charge tax (Rule 46(p)); the current inline form adds it.
- One tax_decisions row exists per line.

**Proof.**

```sql
SELECT count(*)
  FROM gst_rate_pin_status
  WHERE document_table = 'sales_invoice_lines'
  AND verdict IN ('unbackfillable_no_classification','unbackfillable_rate_disagrees')
  AND document_date >= DATE '2026-09-01' /* edit: the date wiring shipped */
```

> 0. Any row means an invoice raised AFTER the wiring still cannot trace its rate.

### `sales-invoice-lines-from-order` — `sales_invoice_lines`

**Where.** `server/actions/sales-invoices.ts` → `raiseInvoiceFromOrder`  
**Anchor.** `insert(salesInvoiceLines)`

**Where the tax comes from today.** amounts from computeInvoiceTax; tax_rate_bps, cess_rate_bps, hsn_sac_rate_id and hsn_sac_code_id are copied verbatim from the order line (lib/invoicing/build.ts: 'EVERY FIGURE IS COPIED FROM THE ORDER, NOT RECALCULATED')

**What to call.**

```ts
write.lines from buildTaxWriteForSalesInvoice
```

**Proof.**

```sql
SELECT count(*)
  FROM sales_invoice_lines l
  JOIN sales_invoices i ON i.id = l.invoice_id
  WHERE l.hsn_sac_rate_id IS NULL
  AND (l.cgst_minor + l.sgst_minor + l.igst_minor) <> 0
  AND i.invoice_date >= DATE '2026-09-01' -- edit: the date wiring shipped
```

> 0. A taxed line raised after wiring with no rate pin is an unwired path.

### `sales-invoice-from-time` — `sales_invoices`

**Where.** `server/actions/time-billing.ts` → `raiseInvoiceFromTime`  
**Anchor.** `insert(salesInvoices)`

**Where the tax comes from today.** computeInvoiceTax, and place of supply IS freshly derived here (determinePlaceOfSupply, and a disagreeing caller value is refused) — but the rate is the file's own effectiveRateBps and hsn_sac_code defaults to the literal '9982'

**What to call.**

```ts
const tax = await computePersistableTax(tenantId, {
  supplierRegistrationId, supplyType, recipientRegistration,
  recipientStateCode, propertyStateCode, deliveryStateCode,
  taxPointDate: <the document's own date>, lines,
});
if (!tax.ok) return fail(tax.error);

const write = buildTaxWriteForSalesInvoice({ tax: tax.value, documentDate });

const [header] = await tx.insert(<headerTable>)
  .values({ ...write.header, /* the caller's own identity fields */ })
  .returning({ id: <headerTable>.id });

const rows = await tx.insert(<lineTable>)
  .values(write.lines.map((l) => ({ ...l, invoiceId: header.id, /* identity */ })))
  .returning({ id: <lineTable>.id, lineNo: <lineTable>.lineNo });

await recordTaxDecisions(tenantId, buildTaxDecisionsForSalesInvoice({
  tax: tax.value, documentId: header.id, documentDate,
  lineIdByKey: <map the returned ids back by key>,
}), tx);
```

**Proof.**

```sql
SELECT count(*)
  FROM sales_invoice_lines
  WHERE hsn_sac_code = '9982'
  AND hsn_sac_code_id IS NULL
```

> 0 for lines created after wiring. The literal '9982' with no resolved classification id is this path's fingerprint.

⚠️ THIS IS THE SIXTH PATH. It is the one most likely to be missed: it is not in the invoices folder, it is reached from components/billing/bill-time.tsx, and it writes sales_invoice_lines WITHOUT hsn_sac_rate_id, hsn_sac_code_id or cess_rate_bps at all. Its place-of-supply handling is the BEST in the product and its rate handling is the worst, which is exactly the combination that survives a review.

### `sales-invoice-lines-from-time` — `sales_invoice_lines`

**Where.** `server/actions/time-billing.ts` → `raiseInvoiceFromTime`  
**Anchor.** `insert(salesInvoiceLines)`

**Where the tax comes from today.** computeInvoiceTax; no rate pin, no classification id, no cess rate

**What to call.**

```ts
write.lines from buildTaxWriteForSalesInvoice
```

### `credit-note` — `sales_credit_notes`

**Where.** `server/actions/sales-invoices.ts` → `raiseCreditNote`  
**Anchor.** `export async function raiseCreditNote`

**Where the tax comes from today.** computeInvoiceTax, but the tax kind is re-derived from the invoice's is_inter_state boolean through a two-way ternary between the IGST and intra-state literals, which cannot express the Union Territory answer at all; and the place of supply falls back to the literal 27 (Maharashtra)

**What to call.**

```ts
const tax = await computePersistableTax(tenantId, {
  supplierRegistrationId, supplyType, recipientRegistration,
  recipientStateCode, propertyStateCode, deliveryStateCode,
  taxPointDate: <the document's own date>, lines,
});
if (!tax.ok) return fail(tax.error);

const write = buildTaxWriteForSalesInvoice({ tax: tax.value, documentDate });

const [header] = await tx.insert(<headerTable>)
  .values({ ...write.header, /* the caller's own identity fields */ })
  .returning({ id: <headerTable>.id });

const rows = await tx.insert(<lineTable>)
  .values(write.lines.map((l) => ({ ...l, invoiceId: header.id, /* identity */ })))
  .returning({ id: <lineTable>.id, lineNo: <lineTable>.lineNo });

await recordTaxDecisions(tenantId, buildTaxDecisionsForSalesInvoice({
  tax: tax.value, documentId: header.id, documentDate,
  lineIdByKey: <map the returned ids back by key>,
}), tx);
```

**Proof.**

```sql
SELECT count(*)
  FROM sales_credit_notes n
  JOIN sales_invoices i ON i.id = n.invoice_id
  WHERE i.is_union_territory
  AND NOT n.is_inter_state
  AND n.note_date >= DATE '2026-09-01' -- edit: the date wiring shipped
```

> 0 is NOT the assertion here — a UT credit note is legitimate. The assertion is that its tax_decisions rows carry tax_kind = 'cgst_utgst'; today they cannot, because the value is never produced.

🔴 THREE SEPARATE DEFECTS ON ONE SCREEN, and one of them is money: cessRateBps is hardcoded 0, so a credit note against a cess-bearing line reverses the GST and not the cess, which s.34 requires. That one also needs a cess_rate_bps column on sales_credit_note_lines — PATCH-REQUEST-E.md P5.

### `credit-note-lines` — `sales_credit_note_lines`

**Where.** `server/actions/sales-invoices.ts` → `raiseCreditNote`  
**Anchor.** `insert(salesCreditNoteLines)`

**Where the tax comes from today.** amounts from computeInvoiceTax; tax_rate_bps comes STRAIGHT FROM THE CLIENT PAYLOAD (lib/validators/sales-invoices.ts taxRateBps) rather than from the invoice line being credited

**What to call.**

```ts
write.lines, with the rate read from the invoice line, not the form
```

**Before the call, these must hold.**

- The line being credited is identified, so its rate and pin can be inherited rather than re-posted.

**Proof.**

```sql
SELECT count(*)
  FROM sales_credit_note_lines c
  JOIN sales_invoice_lines l ON l.id = c.invoice_line_id
  WHERE c.tax_rate_bps IS DISTINCT
  FROM l.tax_rate_bps
```

> 0. A credit note at a different rate from the invoice it credits is either a typo or a restatement, and both should be refused rather than stored.

### `sales-order-lines` — `sales_order_lines`

**Where.** `server/actions/orders.ts` → `createOrder / amendOrder (via lineValuesFor)`  
**Anchor.** `hsnSacRateId: line.hsnSacRateId ?? null`

**Where the tax comes from today.** amounts from lib/orders/pricing.ts priceLine — a SECOND implementation of the same arithmetic; rate, cess rate, rate pin and classification id all straight from the client payload

**What to call.**

```ts
const tax = await computePersistableTax(tenantId, {
  supplierRegistrationId, supplyType, recipientRegistration,
  recipientStateCode, propertyStateCode, deliveryStateCode,
  taxPointDate: <the document's own date>, lines,
});
if (!tax.ok) return fail(tax.error);

const write = buildTaxWriteForSalesInvoice({ tax: tax.value, documentDate });

const [header] = await tx.insert(<headerTable>)
  .values({ ...write.header, /* the caller's own identity fields */ })
  .returning({ id: <headerTable>.id });

const rows = await tx.insert(<lineTable>)
  .values(write.lines.map((l) => ({ ...l, invoiceId: header.id, /* identity */ })))
  .returning({ id: <lineTable>.id, lineNo: <lineTable>.lineNo });

await recordTaxDecisions(tenantId, buildTaxDecisionsForSalesInvoice({
  tax: tax.value, documentId: header.id, documentDate,
  lineIdByKey: <map the returned ids back by key>,
}), tx);
```

**Proof.**

```sql
SELECT count(*)
  FROM sales_order_lines l
  JOIN sales_orders o ON o.id = l.order_id
  WHERE l.hsn_sac_rate_id IS NULL
  AND COALESCE(l.tax_rate_bps,0) <> 0
  AND o.order_date >= DATE '2026-09-01' -- edit: the date wiring shipped
```

> 0.

⭐ THE HIGHEST-VALUE SINGLE LINE IN THE PRODUCT. `hsnSacRateId: line.hsnSacRateId ?? null` is where the browser's opinion about which rate period applies enters the database and is then copied onto every invoice raised from the order. Place of supply, by contrast, IS derived here and a disagreeing client value is refused — the machinery for doing this right already exists three lines away.

### `stock-transfer` — `stock_transfers`

**Where.** `server/actions/transfers.ts` → `createTransfer`  
**Anchor.** `const half = tax / 2n`

**Where the tax comes from today.** 🔴 inline arithmetic in the action itself — a FOURTH implementation. Arithmetically equivalent to applyRateBps/splitEvenly today, and nothing keeps it that way.

**What to call.**

```ts
computeInvoiceTax from lib/gst/tax.ts, with the Rule 28 value as the line gross and transferTaxTreatment supplying the tax kind
```

**Proof.**

```sql
SELECT count(*)
  FROM stock_transfers t
  JOIN stock_transfer_lines l ON l.transfer_id = t.id
  WHERE (t.cgst_minor + t.sgst_minor + t.igst_minor) <> (SELECT COALESCE(sum(gst_apply_rate_bps(l2.taxable_value_minor, COALESCE(l2.tax_rate_bps,0))),0)
  FROM stock_transfer_lines l2
  WHERE l2.transfer_id = t.id)
```

> 0. Note this uses 0147's own SQL arithmetic, so it is checking the transfer against the same rounding every other document uses.

A branch transfer between two registrations of the same PAN in different states IS a supply and does appear in GSTR-1. cess_minor exists on this table and is written by nothing.

### `demand-notice` — `demand_notices`

**Where.** `server/receivables/demands.ts` → `raiseDemand`  
**Anchor.** `insert(demandNotices)`

**Where the tax comes from today.** computeInvoiceTax via lib/receivables/demand.ts, at the rate on receivable_policies.gst_rate_bps — a per-policy rate, not a registry lookup — and taxKind and placeOfSupplyCode come straight from the client payload

**What to call.**

```ts
determinePlaceOfSupply for the tax kind, and the registry for the rate; the money arithmetic already goes through the right place
```

**Proof.**

```sql
SELECT count(*)
  FROM demand_notices
  WHERE cgst_minor <> 0
  AND igst_minor <> 0
```

> 0 — but that is the weak check. The real one is a tax_decisions row per demand carrying statutory_ref = 'IGST Act s.12(3)(a)'.

⚠️ A DEMAND NOTICE ON A PROPERTY BOOKING IS AN IMMOVABLE-PROPERTY SUPPLY, so s.12(3)(a) puts the place of supply where the property is — which the engine implements and refuses to guess at. Accepting the caller's taxKind bypasses the one rule this document type most needs.

### `brokerage-commission` — `channel_partner_commissions`

**Where.** `server/actions/sales-brokerage.ts` → `raiseBrokerage`  
**Anchor.** `data.cgst ? toMinorUnits(data.cgst)`

**Where the tax comes from today.** 🔴 nothing. The three heads are taken from the client payload with no engine call, no place-of-supply determination, no taxable value stored and no consistency check of any kind

**What to call.**

```ts
const tax = await computePersistableTax(tenantId, {
  supplierRegistrationId, supplyType, recipientRegistration,
  recipientStateCode, propertyStateCode, deliveryStateCode,
  taxPointDate: <the document's own date>, lines,
});
if (!tax.ok) return fail(tax.error);

const write = buildTaxWriteForSalesInvoice({ tax: tax.value, documentDate });

const [header] = await tx.insert(<headerTable>)
  .values({ ...write.header, /* the caller's own identity fields */ })
  .returning({ id: <headerTable>.id });

const rows = await tx.insert(<lineTable>)
  .values(write.lines.map((l) => ({ ...l, invoiceId: header.id, /* identity */ })))
  .returning({ id: <lineTable>.id, lineNo: <lineTable>.lineNo });

await recordTaxDecisions(tenantId, buildTaxDecisionsForSalesInvoice({
  tax: tax.value, documentId: header.id, documentDate,
  lineIdByKey: <map the returned ids back by key>,
}), tx);
```

**Proof.**

```sql
SELECT count(*)
  FROM channel_partner_commissions
  WHERE (cgst_minor <> 0
  OR sgst_minor <> 0
  OR igst_minor <> 0)
```

> Every one of these rows carries tax that no rule produced. The assertion after wiring is a tax_decisions row for each.

⚠️ THIS IS AN INWARD SUPPLY WE ARE THE RECIPIENT OF — a broker invoicing us — and it is frequently on reverse charge under s.9(3) when the broker is unregistered. It has no is_reverse_charge column, no place of supply and no taxable value, so it can neither be computed nor checked. Of everything in this register it is the least defensible and the smallest table.

### `booking-cancellation-reversal` — `bookings`

**Where.** `server/actions/sales-bookings.ts` → `postBookingCancellation`  
**Anchor.** `data.reversedCgst ? toMinorUnits(data.reversedCgst)`

**Where the tax comes from today.** 🔴 the client payload. reversed_cgst_minor / reversed_sgst_minor / reversed_igst_minor are typed in and frozen by a trigger thereafter

**What to call.**

```ts
the reversal must be derived from the demand notices actually raised on the booking, not posted as a figure
```

⚠️ FROZEN-ON-WRITE MAKES THIS WORSE, NOT BETTER. ordence_guard_posted_cancellation means a typed-in reversal is permanent. The number that gets frozen is the one nobody computed.

### `eway-bill-items` — `eway_bill_items`

**Where.** `server/actions/eway.ts` → `prepareEwayBill`  
**Anchor.** `Math.floor((l.taxRateBps ?? 0) / 2)`

**Where the tax comes from today.** 🔴 it HALVES THE RATE with floor and ceil, putting the odd basis point on SGST — the opposite of splitEvenly, which puts the odd minor unit on CGST

**What to call.**

```ts
the rates already stored on the sales_invoice_line the item was copied from
```

**Proof.**

```sql
SELECT count(*)
  FROM eway_bill_items i
  JOIN eway_bills b ON b.id = i.eway_bill_id
  JOIN sales_invoice_lines l ON l.invoice_id = b.invoice_id
  AND l.line_no = i.line_no
  WHERE i.cgst_rate_bps + i.sgst_rate_bps + i.igst_rate_bps <> COALESCE(l.tax_rate_bps, 0)
```

> 0 — and today it is 0 only because every rate in use happens to be even. ⚠️ NOTE THE JOIN: eway_bill_items has no invoice_line_id, only line_no, so the item and the line it came from are related by POSITION. That is its own fragility and it is why this assertion had to be written by reading the schema rather than assuming the obvious foreign key exists.

⭐ THIS IS THE MOST SUBTLE ITEM IN THE REGISTER AND THE EASIEST TO DISMISS. The e-way bill declares a rate, not an amount, so the divergence never shows up as money on our side. It shows up when the portal's figure is compared against the invoice — an odd-basis-point rate is unusual but legal, and when one occurs the e-way bill and the invoice it was generated from will state different CGST and SGST rates for the same supply.

### `goods-return-lines` — `goods_return_lines`

**Where.** `server/actions/goods-returns.ts` → `receiveGoodsReturn`  
**Anchor.** `insert(goodsReturnLines)`

**Where the tax comes from today.** 🔴 taxable_value_minor, tax_rate_bps AND tax_value_minor all straight from the client payload; tax_value_minor is never checked against taxable × rate

**What to call.**

```ts
at minimum, refuse a row where tax_value_minor <> gst_apply_rate_bps(taxable, rate)
```

**Proof.**

```sql
SELECT count(*)
  FROM goods_return_lines
  WHERE tax_value_minor <> gst_apply_rate_bps(taxable_value_minor, COALESCE(tax_rate_bps,0))
```

> 0. Uses 0147's arithmetic, so it agrees with every other document.

Only itc_reversal_minor is computed. The tax being reversed is not.

### `purchase-order-lines` — `purchase_order_lines`

**Where.** `server/actions/purchase-orders.ts` → `raisePurchaseOrder`  
**Anchor.** `tax += (lineValue * BigInt(l.taxRateBps)) / 10_000n`

**Where the tax comes from today.** 🔴 inline TRUNCATING division — a FIFTH implementation, and the only one that is arithmetically WRONG rather than merely duplicated. applyRateBps is half-up (+5000n before dividing); this one drops the fraction.

**What to call.**

```ts
applyRateBps from lib/billing/money.ts
```

**Proof.**

```sql
SELECT count(*)
  FROM purchase_orders o
  WHERE o.tax_minor <> (SELECT COALESCE(sum(gst_apply_rate_bps( (l.ordered_qty * l.unit_price_minor)::bigint, COALESCE(l.tax_rate_bps,0))),0)
  FROM purchase_order_lines l
  WHERE l.po_id = o.id)
```

> 0 after the fix. Before it, the count is every PO whose lines produced a fraction of a paisa.

⚠️ A PURCHASE ORDER IS NOT A TAX DOCUMENT, so this understates by up to one paisa per line and nobody files it. It matters because the PO's total is what the three-way match compares the supplier's bill against, and a systematic one-paisa-low expectation produces a match variance on correct invoices.

### `boqs` — `boqs`

**Where.** `server/actions/construction.ts` → `createBoq`  
**Anchor.** `export async function createBoq`

**Where the tax comes from today.** 🔴 nothing reads or writes it. boqs.gst_rate_bps DEFAULT 1800 and boqs.gst_tds_rate_bps DEFAULT 200 are live columns that createBoq never sets and no code anywhere reads

**What to call.**

```ts
resolve the rate from hsn_sac_rates for the works-contract SAC on the contract date, or drop the columns
```

⚠️ THE DANGEROUS SHAPE. A column with a plausible default that nobody writes and nobody reads looks configured. Every BOQ in the database says 18% and no part of that came from a decision.

---

## 4. How to know you are done

⚠️ **"All fifteen wired" is not the finish line, because it is a claim
about the code rather than about the data.** The finish line is that no
document raised *after* the wiring can fail to say where its tax came
from. That is one query:

```sql
-- Everything raised since wiring shipped that still cannot trace its rate.
SELECT document_table, verdict, count(*) AS lines
  FROM gst_rate_pin_status
 WHERE document_date >= DATE '2026-09-01'   -- edit: the date wiring shipped
   AND verdict IN ('unbackfillable_no_classification',
                   'unbackfillable_no_rate_in_force',
                   'unbackfillable_rate_disagrees')
 GROUP BY document_table, verdict
 ORDER BY lines DESC;
```

Zero rows means every outward-supply line raised since the wiring names a
classification, and the registry holds a period covering its date that
agrees with what it charged. **A non-empty result is a worklist, not a
failure** — `unbackfillable_no_rate_in_force` usually means the rate master
has a hole, which is a data job, not a code job. The verdict tells you
which.

And the second query, for the trail:

```sql
SELECT * FROM tax_decision_gaps;
```

⭐ **Neither of these has a PASS column, and that is deliberate.** This
codebase has been bitten by a coverage check written
`count(*) >= 10 THEN 'PASS'` for a property that had to hold on 303 tables;
it passed at 48. Both queries return numbers a person reads.

⚠️ **`gst_rate_pin_status` covers `sales_invoice_lines` and
`sales_order_lines` only.** The other eleven queued sites have no
equivalent view, and each carries its own `assertion` in §3 instead. Do not
read a clean coverage query as "everything is wired" — read it as "the two
biggest paths are wired".


---

## 5. Everything else, and why it is not in the queue

Read this section before concluding a path was forgotten. Every entry here
is a deliberate exclusion with a reason, and the reasons are not
interchangeable.

### `purchase-invoice` — `purchase_invoices` · **third-party-figures**

`server/actions/purchases.ts` → `recordPurchaseInvoice`. the supplier's figures, transcribed from the client payload by server/purchases/engine.ts pricePurchase; the registry rate is resolved and used only to raise a non-blocking rateMismatch warning

⭐ DO NOT WIRE THIS, AND THE REASON IS NOT LAZINESS. A vendor who charged 12% where the master says 18% is a dispute to record and pursue. Replacing their figure with ours would make the bill we hold disagree with the bill they sent, and GSTR-2B reconciliation compares OUR record against THEIR filing. It is also the only path in the product that already resolves a rate pin server-side, so it is the model for the ones that do not — server/purchases/engine.ts:265.

```sql
SELECT count(*)
  FROM purchase_invoice_lines l
  JOIN hsn_sac_rates r ON r.id = l.gst_rate_id
  WHERE r.rate_bps IS DISTINCT
  FROM l.rate_bps
```

> NOT 0 — a non-zero count is the list of supplier rate disputes to chase, and it should be a screen, not an assertion.

### `purchase-invoice-lines` — `purchase_invoice_lines` · **third-party-figures**

`server/actions/purchases.ts` → `recordPurchaseInvoice`. the supplier's figures; gst_rate_id IS resolved server-side

### `gstr2b-rows` — `gstr2b_rows` · **third-party-figures**

`server/actions/gstr2b.ts` → `importGstr2b`. the government's own JSON, parsed by lib/gstr2b/parse.ts

Recomputing these would defeat the entire purpose of the document: it is the counterparty's declaration, and the value of holding it is that it is theirs.

### `bank-charge-itc` — `bank_charge_itc_deferrals` · **third-party-figures**

`server/banking/bank-charge-itc-service.ts` → `recordTaxInvoice`. the bank's tax invoice, transcribed from the form and footing-checked against the gross already on the row (transcriptionRefusal)

⭐ THE ONLY THIRD-PARTY TRANSCRIPTION IN THE PRODUCT THAT IS ARITHMETICALLY CONSTRAINED ON WRITE. The gross comes from the stored row, never the form, so a transcription that does not foot is refused. That is the pattern the other four should copy.

### `itc-register` — `itc_register` · **third-party-figures**

`server/actions/purchases.ts` → `recordItcMovement / buildItcForPeriod / runRule42ForPeriod`. buildItcForPeriod copies from purchase_invoice_lines; runRule42ForPeriod computes the reversal in lib/; recordItcMovement takes the four heads from the client payload with no check

⚠️ MIXED, AND THE MIXTURE IS THE PROBLEM. Two of the three writers are sound and the manual one is not. recordItcMovement should at minimum refuse a movement whose heads disagree with the invoice it names.

### `subscription-invoice` — `invoices` · **unreachable**

`server/billing/invoice-generator.ts` → `generateInvoice`. lib/billing/money.ts computeGst — a THIRD implementation: IGST vs CGST/SGST by bare state-code equality, no UTGST, no cess, no reverse charge, no rate pin, and it defaults to IGST when the place of supply is null

🔴 STATUS IS `unreachable`, NOT `must-wire`, AND THAT CHANGES THE PRIORITY. The only caller chain is generateInvoice ← invoiceCurrentPeriod ← issueInvoiceForCurrentPeriod, and that last one is an orphan in scripts/action-reachability-baseline.json — zero references in app/, components/, app/api/, worker.ts or instrumentation.ts. Ordence has never issued one of these. Wiring it before making it reachable would be wiring dead code, and PATCH-REQUEST-E.md P3 was written before this was known.

```sql
SELECT count(*) FILTER (WHERE gst_computed), count(*)
  FROM invoices
```

> Today 0 of N. After P3, every row created afterwards must have gst_computed = true AND per-line tax — in that order, or 0021's deferred trigger refuses the next update of every one of them.

### `subscription-invoice-lines` — `invoice_lines` · **unreachable**

`server/billing/invoice-generator.ts` → `generateInvoice`. the constant SAAS_GST_RATE_BPS = 1800 is written to tax_rate_bps and NOTHING else — taxable_value_minor stays NULL and all four heads stay 0, while the header carries the whole tax

⚠️ 0147's trigger passes these rows only because COALESCE(taxable_value_minor,0) is 0, so the expected tax is 0 and the stored 0 matches. The moment the taxable value is populated without the heads, it will refuse — which is the correct order to discover that.

### `post-supply-discount` — `post_supply_discount_invoices` · **unreachable**

`server/actions/discounts.ts` → `computeRebate`. the rate is REVERSE-DERIVED from the stored header: rateBps = (tax * 10000) / taxable

🔴 UNREACHABLE — computeRebate is an orphan in the reachability baseline. Reverse-deriving a rate from a rounded total is lossy and would be worth fixing if anything called it. Wire the caller first or delete the action.

### `ra-bills` — `ra_bills` · **no-tax-columns**

`server/actions/ra-bills.ts` → `raiseRaBillFromMeasurements`. none — there is no GST on this table to compute

🔴 THE ANSWER TO 'WIRE RA BILLS' IS THAT AN RA BILL HAS NO GST ON IT.
The only rate columns are cess_rate_bps (BOCW labour welfare cess, 1%), retention_rate_bps and tds_rate_bps. The compute trigger ordence_compute_ra_bill() writes previous_paid, cess, retention, TDS and net_payable, and net_payable = gross − cess − retention − tds − other. No GST is added and none is deducted. lib/accounting/sales-posting.ts buildRaBillPosting emits six ledger roles and not one of them is a tax role.
⚠️ THE DESIGN INTENT IS THAT THE CONTRACTOR'S GST LIVES ON A purchase_invoices ROW — lib/construction/index.ts says so — and lib/construction/deductions.ts computes 194C and s.51 GST-TDS on the value EXCLUSIVE of GST, which only makes sense if the GST is captured elsewhere. But db/schema/purchases.ts has no ra_bill_id, works_contract_id or boq_id column, and server/actions/ra-bills.ts never creates or references a purchase invoice. So the two documents are unlinked, keyed twice, and reconciled by eye. That is a schema gap, not a wiring gap, and it is the honest answer to the brief's sixth bullet.

### `ra-bill-lines` — `ra_bill_lines` · **no-tax-columns**

`server/actions/ra-bills.ts` → `raiseRaBillFromMeasurements`. none — quantity, item rate and amount only

### `works-contracts` — `works_contracts` · **no-tax-columns**

`scripts/seed-contracting-demo.ts` → `(seed only)`. none — cess, retention and TDS rates only

🔴 AND IT HAS NO APPLICATION WRITER AT ALL. The only writes in the repo are the seed script and a test. Every RA bill reads a contract that no screen can create.

### `rate-cards` — `rate_cards` · **master-data**

`server/actions/rates.ts` → `saveRateCard`. the client payload, zod-range-checked and never compared to hsn_sac_rates

⚠️ A PRICE LIST IS NOT A DOCUMENT, so it does not need the engine — but a rate card carrying 12% for a classification the registry says is 18% will seed every order made from it with the wrong rate, and 0147 will then happily accept the resulting invoice because it is internally consistent. A soft warning at save time, against the registry, is the cheap fix.

### `sales-order` — `sales_orders` · **aggregate-only**

`server/actions/orders.ts` → `createOrder`. header totals are summarise(priced); the header is ALSO rewritten by the database trigger ordence_recompute_order_totals() on every line write

⚠️ TWO WRITERS, ONE HEADER. The action writes the totals and the trigger recomputes them from the lines immediately afterwards. Wiring the action without the lines changes nothing, because the trigger has the last word.

### `order-totals-trigger` — `sales_orders` · **aggregate-only**

`SQL-FILES/0028_phase39_orders.sql` → `ordence_recompute_order_totals()`. SUM() over sales_order_lines

⭐ A DATABASE TRIGGER IS A WRITE PATH AND BELONGS IN THIS REGISTER. It has the last word on the order header, after the action has written it. It is correct as an aggregate and it is the reason wiring only the order ACTION would achieve nothing.

### `gstr3b-return` — `gst_returns` · **aggregate-only**

`server/actions/returns.ts` → `prepareGstr3b`. lib/gst/gstr3b.ts buildGstr3b over LEDGER movements, not over invoices

Deliberately ledger-sourced, and it refuses to assemble if the tax accounts are unmapped rather than reporting a confident zero. Nothing to wire.

### `invoice-payment-recorded` — `invoices` · **non-tax-write**

`server/actions/billing.ts` → `recordManualPayment`. none — amount_paid_minor, status, paid_at

Also unreachable: an orphan in the reachability baseline.

### `invoice-voided` — `invoices` · **non-tax-write**

`server/actions/invoicing.ts` → `voidInvoice`. none — status, voided_at, notes

Also unreachable: an orphan in the reachability baseline.

### `eway-number-writeback` — `sales_invoices` · **non-tax-write**

`server/actions/eway.ts` → `recordEwayNumber / cancelEwayBill`. none — eway_bill_no and eway_bill_date only

⭐ THE ONE MOST LIKELY TO BE MIS-WIRED. It writes sales_invoices, so a scan for 'where are sales invoices written' surfaces it, and 0049's freeze trigger explicitly permits these two columns to move after issue — which reads like permission to write more. It is not.

### `opening-balance-import` — `sales_invoices` · **non-tax-write**

`server/actions/import.ts` → `writeRow (entity sales_invoices)`. deliberately none — taxable_value_minor is written as 0n and every head is left at 0, because an opening balance is a receivable carried forward, not a supply. No lines are inserted at all.

⚠️ DO NOT WIRE THIS, AND THE REASON IS SUBTLE. These rows are the closing balances of a system the customer is migrating FROM. The supply already happened, was already taxed, and was already filed under the old system. Computing GST on them would double-count every one of them in GSTR-1.

### `three-way-match` — `purchase_invoices` · **non-tax-write**

`server/actions/purchase-orders.ts` → `runThreeWayMatch`. none — match_state and match_note

### `booking-possession` — `bookings` · **non-tax-write**

`server/actions/sales-posting.ts` → `recordPossession`. none — possession and posting references

### `fx-initial-recognition-sales` — `sales_invoices` · **non-tax-write**

`server/fx/initial-recognition.ts` → `recogniseSalesInvoice`. none — functional currency, functional total and the FX rate

⚠️ AND IT MUST STAY THAT WAY. GST is charged and filed in INR whatever the invoice currency; an FX revaluation that moved a tax head would restate a filed return every time the rupee moved.

### `fx-initial-recognition-purchase` — `purchase_invoices` · **non-tax-write**

`server/fx/initial-recognition.ts` → `recognisePurchaseInvoice`. none — FX columns only

### `fx-revaluation-sales` — `sales_invoices` · **non-tax-write**

`server/fx/revaluation-service.ts` → `runRevaluation / settleForeignSalesInvoice`. none — fx_carried_functional_minor

### `fx-revaluation-purchase` — `purchase_invoices` · **non-tax-write**

`server/fx/revaluation-service.ts` → `runRevaluation / settleForeignPurchaseInvoice`. none — fx_carried_functional_minor

### `demand-dunning` — `demand_notices` · **non-tax-write**

`server/receivables/dunning.ts` → `sendDunningLetter`. none — dunning_stage and last_dunned_at

### `demand-receipts` — `demand_notices` · **non-tax-write**

`server/receivables/receipts.ts` → `recordReceipt / bounceReceipt / reallocateReceipt`. none — allocated_minor, interest_paid_minor, status

---

## 6. The three answers the brief asked for directly

### 6.1 The backfill honesty question

> *Which historical rows could NOT be computed, and how are they marked? If
> the answer is "all of them computed", today's rates were applied to old
> invoices and that is wrong.*

**Nothing was recomputed. One row in five was pinned, and the other four
were named.**

SQL 0148 pins a line only when all four hold: it names a classification;
exactly one rate period covers **the document's own date**; that period's
`rate_bps` and `cess_rate_bps` **equal what the line already charged**; and
the document is still a draft, so writing to it is legal. Under those four
the pin changes no figure — it records which row already produced the
figure that is there. Everything else is left alone and classified by
`gst_rate_pin_status` into one of six verdicts:

| verdict | meaning |
|---|---|
| `already_pinned` | had a pin before the backfill |
| `pinnable` | the four conditions hold; the worklist |
| `no_tax_to_trace` | no rate named and no tax charged; nothing to cite |
| `unbackfillable_no_classification` | carries tax, names no HSN/SAC |
| `unbackfillable_no_rate_in_force` | classified, but no period covers the date |
| `unbackfillable_rate_disagrees` | a period covers the date and says a different rate — **pinning here would assert a provenance the figure does not have** |
| `unbackfillable_document_frozen` | identical to `pinnable` but the document has been issued |

`tests/security/tax-backfill.test.ts` seeds one line of each of the first
five kinds, runs the backfill for real, and asserts **exactly one** was
pinned and the other four were untouched *and named correctly*. Those four
negative assertions are the point: a backfill that pinned all five would
pass a "did it pin anything" test and would have invented four rate
provenances.

⚠️ **Two families cannot be backfilled at all, and the reason is not
effort.** `invoices` / `invoice_lines` — Ordence's own subscription
invoices — carry no HSN/SAC classification of any kind (`SAAS_GST_RATE_BPS`
is a constant, not a registry lookup), so condition 1 is unsatisfiable for
every row, retrospectively and forever. And an **issued** sales invoice's
lines cannot be written at all: `sales_invoice_line_freeze` refuses every
UPDATE once the header leaves draft. That is also why the marking is a
**view** rather than a stored column — a stored `unbackfillable` marker
could not be written onto the very rows that most need one, and the only
way to write it would be to weaken a freeze guard.

### 6.2 Rounding, stated once

Stated once, in `docs/TAX.md` §2, and made executable in
`lib/money/policy.ts`. In one paragraph:

**Per line, then summed** — never `rate × summed taxable`. **Half-up away
from zero**, not banker's: `sign × ((|amount| × bps + 5000) / 10000)` in
exact integer arithmetic, because that is the statutory method and it is
what an auditor recomputing the line by hand will do. **CGST and SGST split
the rounded total** via `splitEvenly`, with the odd minor unit landing on
CGST — never the halved rate applied twice, which turns ₹100.01 of tax into
₹50.01 + ₹50.01 and stops the invoice balancing. **Invoice-level rounding
to the whole unit is off by default.** Cess is per line, ad valorem plus
specific, never split across heads and never set off.

The single place it is decided is `lib/billing/money.ts` —
`applyRateBps` and `splitEvenly`, which `lib/gst/tax.ts` explicitly forbids
restating. SQL 0147 transcribes exactly those two into
`gst_apply_rate_bps()` and `gst_cgst_share()` and **proves** they agree on
17 cases, including both exact halves in both directions (5 and 15 at 1000
bps — half-up gives 1 and 2; banker's would give 0 and 2, so a suite with
only the second case misses the drift half the time) and a product past
2⁵³. `tests/security/gst-recompute.test.ts` runs the same table against the
real TypeScript functions, so neither half is trusted alone.

**Minor units are not universally two decimals.** The exponent table is
`lib/fx/currency.ts` and there is exactly one copy: JPY and 17 others are
0; BHD, IQD, JOD, KWD, LYD, OMR and TND are 3; CLF and UYW are 4. An
unknown code **throws** rather than defaulting to 2.

🔴 **One INR-only leak survives.** `roundOffToRupee` in `lib/gst/tax.ts`
hardcodes `100n`. `lib/money/policy.ts roundOffToUnit(amountMinor, currency)`
is the exponent-aware replacement; swapping the call site needs `currency`
added to `TaxComputationInput`, which is `lib/gst/**` and therefore a patch
request (P4). It is latent — rupee rounding is off by default and GST
invoices are INR — but `sales_invoices.currency` has been genuinely
multi-currency since 0101.

### 6.3 The tax audit trail, traced

The trail exists and `tests/security/tax-audit-trail.test.ts` drives it end
to end through the **real** server modules —
`computePersistableTax` → `quoteTax` → `withTenant` under RLS as
`ordence_app` → `buildTaxWriteForSalesInvoice` → the real inserts (so 0146
and 0147 fire on the engine's own output) → `recordTaxDecisions` →
`getTaxDecisionsForDocument`. Here is one invoice, printed by the test:

```
GST WORKING PAPER — how this line was taxed, and under what authority
══════════════════════════════════════════════════════════════════════
Document              | TRAIL/A/4065aa23  dated 2026-08-19
Supplier              | 29AAACR5055K1Z3 (state 29)
Recipient             | Bengaluru Buyer Pvt Ltd (29)
Line                  | 1 — Structural design and drawing services
──────────────────────────────────────────────────────────────────────
HSN / SAC             | 998314
Taxable value         | ₹100.05  (10005 paise)
Rate applied          | 18.00%  (1800 bps)
Rate period           | 2019-04-01 → open   [rate row b987c97d-…]
Notification          | Notification 20/2019-Central Tax (Rate), Sl. No. 3(xii)
──────────────────────────────────────────────────────────────────────
Place of supply       | 29 (Karnataka)
Basis                 | recipient_registration
Statutory reference   | Section 12(2)(a), IGST Act
Reasoning             | The recipient is registered in Karnataka (29), so
                      | that is the place of supply.
──────────────────────────────────────────────────────────────────────
Tax kind              | cgst_sgst (intra-state: CGST + SGST)
Reverse charge        | no — forward charge
──────────────────────────────────────────────────────────────────────
CGST                  | ₹9.01  (901 paise)
SGST / UTGST          | ₹9.00  (900 paise)
IGST                  | ₹0.00  (0 paise)
Cess                  | ₹0.00  (0 paise)
──────────────────────────────────────────────────────────────────────
Recompute check       | 10005 × 1800 bps = 1801 paise, split 901 / 900
Engine version        | gst-engine-1.0.0
```

⭐ **The taxable value is 10005 on purpose.** 18% of it is 1801 paise, an
odd number, so the split is **901 / 900**. A trail that could only
reproduce even splits would look correct on almost every invoice and be
useless on the ones anybody argues about.

Four properties are asserted, not narrated:

1. **The trail reproduces the invoice from itself.** Feeding the trail's
   own `taxable_value_minor` and `rate_bps` back through `gst_apply_rate_bps`
   and `gst_cgst_share` returns 1801 and 901 — the same functions the
   database uses to refuse a line, so the accountant's recomputation and
   the constraint are the same arithmetic.
2. **The date governs, not the clock.** A second invoice dated
   **2018-06-01** cites 1200 bps and the 2017 notification, not the 2019
   pair, and recomputes to 1201 → 601/600.
3. **A new rate period does not restate history.** After a third period is
   opened and the 18% one is closed, both trails are byte-identical to
   before — and the sharpest assertion is that `hsn_sac_rates` now says the
   18% period ends 2027-01-01 while invoice A's trail still says
   `effectiveTo: null`, which proves the column was **copied, not joined**.
   Editing the 18% row's `rate_bps` is then refused by
   `enforce_gst_rate_history_immutable`, which learned about sales invoices
   in 0146 — with the sibling assertion that the same edit to the *unused*
   500 bps row is accepted.
4. **The trail cannot lie.** A decision whose CGST does not follow from its
   own taxable value and rate is refused by 0150's trigger (900/900 refused,
   901/900 accepted); so is one whose `tax_kind` disagrees with the heads it
   carries.

The Union Territory case works end to end — `cgst_utgst` reaches
`tax_decisions.tax_kind` — provided the workspace holds a registration in
the UT itself. Karnataka → UT is inter-state IGST, which is correct law and
not a code gap.

---

## 7. What is still missing, and who owns it

| # | gap | owner |
|---|---|---|
| 1 | **Nothing calls `recordTaxDecisions()` in the product.** The writer, the schema, the trigger and the page all exist. Two call sites, both in `server/actions/sales-invoices.ts`. | Wiring · P2 |
| 2 | **No database check that a sales invoice HEADER agrees with its own lines.** 0021's deferred trigger covers `invoices` and `purchase_invoices` only; `pg_trigger` has nothing on `sales_invoices`. `buildTaxWriteForSalesInvoice` is currently the *only* thing enforcing it, and it is bypassable by not calling it. Needs a migration; Track E has no number this wave. | **new SQL** · P13 |
| 3 | `sales_credit_note_lines` has no `cess_rate_bps`, so a credit note cannot reverse cess. **Money.** | schema · P5 |
| 4 | `sales_invoice_lines` has no per-line `is_reverse_charge`; Rule 46(p) is per supply. | schema · P5 |
| 5 | No line table has a per-unit cess column, so specific-rate cess is unrepresentable end to end. | schema · P5 |
| 6 | **An RA bill has no GST and no link to the purchase invoice that should carry it.** `db/schema/purchases.ts` has no `ra_bill_id`, `works_contract_id` or `boq_id`. Two documents, keyed twice, reconciled by eye. | schema |
| 7 | `works_contracts` has **no application writer at all** — seed script and tests only. Every RA bill reads a contract no screen can create. | construction |
| 8 | `boqs.gst_rate_bps` DEFAULT 1800 and `gst_tds_rate_bps` DEFAULT 200 are live columns nothing reads or writes. Every BOQ says 18% and none of that came from a decision. | construction |
| 9 | **SQL 0150's comment names a place-of-supply vocabulary that does not exist.** It lists `recipient_registered`, `immovable_property`, `performance`, `goods_delivery`; the engine emits `recipient_registration`, `recipient_address`, `immovable_property_location`, `delivery_location`, `supplier_location`, `sez_deemed_interstate`, `outside_india`. Nothing is enforced, so nothing breaks — but a query written from the comment returns zero rows. **Not fixed here on purpose:** 0150 is applied on the assembled tree and `scripts/migrate.mjs` records a checksum, so editing even a comment makes it read as changed. Needs a `COMMENT ON COLUMN` in a future number. | **new SQL** |
| 10 | `tax_decisions.tax_kind` is a per-line column written from the header. Correct today — one supply, one place of supply — but a mixed document could not be represented. | noted |
