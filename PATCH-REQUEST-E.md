# PATCH-REQUEST-E — changes Track E needs outside its own file block

Track E owns `server/gst/**`, `server/tax/**`, `app/(finance)/**`,
`lib/money/**`, `tests/security/gst-*.test.ts`,
`tests/security/tax-*.test.ts`, `docs/TAX.md`, and SQL 0146–0150.

Everything below is outside that block. **Nothing here has been written by
Track E.** Each item states the file, what to change, why, and what breaks
if it is skipped. They are ordered by consequence, not by size.

> ⚠️ **Nothing in this list is required for 0146–0150 to be applied.** The
> five migrations are self-contained and self-verifying; they were executed
> in numeric order against a clean Postgres 16 and the full 1,359-test
> security suite passes with them installed and no code change at all. This
> list is what turns the controls from *a floor the product cannot fall
> below* into *a product that fills the columns*.

---

## P1 — `db/schema/gst.ts` (or a new `db/schema/tax.ts`): a Drizzle object for `tax_decisions`

**Why.** SQL 0150 creates `tax_decisions`. `db/schema/**` is not Track E's,
so `server/tax/audit.ts` reaches the table with hand-written `sql` template
queries and hand-written row types. A column rename in 0150 therefore
breaks it **at runtime**, not at `tsc` — which is the exact shape of defect
this wave exists to remove.

**What.** A `pgTable("tax_decisions", …)` mirroring the columns listed at
the end of this file (§ Schema appendix), plus the composite
`(hsn_sac_rate_id, tenant_id)` relation. Then replace the four raw queries
in `server/tax/audit.ts` and the two in `app/(finance)/tax/_pin-status.ts`.

**If skipped.** Everything works; the type safety is a comment.

---

## P2 — `server/actions/sales-invoices.ts`: call the one computation

This is the mission. `gst_computed` and `gst_rate_id` are unfilled because
**no code path resolves a rate server-side for an outward supply.**

### P2a — `createInvoiceFromOrder` (~L197 header, ~L237 lines)

Today the header and line values are assembled inline and the rate pin is
whatever the client posted. Replace with:

```ts
import { computePersistableTax } from "@/server/tax/compute";
import { buildTaxWriteForSalesInvoice, buildTaxDecisionsForSalesInvoice } from "@/server/tax/apply";
import { recordTaxDecisions } from "@/server/tax/audit";

const tax = await computePersistableTax(ctx.tenant.id, { /* … */ });
const write = buildTaxWriteForSalesInvoice({ tax, /* … */ });

const [header] = await tx.insert(salesInvoices)
  .values({ ...write.header, /* the caller's own identity fields */ })
  .returning({ id: salesInvoices.id });

const lines = await tx.insert(salesInvoiceLines)
  .values(write.lines.map((l) => ({ ...l, invoiceId: header.id })))
  .returning({ id: salesInvoiceLines.id, lineNo: salesInvoiceLines.lineNo });

await recordTaxDecisions(
  ctx.tenant.id,
  buildTaxDecisionsForSalesInvoice({ tax, documentId: header.id, /* … */ }),
  tx,
);
```

**Three things this fixes, not one.**

1. `hsn_sac_rate_id` becomes the row the engine resolved from the registry
   on the document's own date, instead of a uuid the browser sent.
2. `hsn_sac_code_id` likewise — `quoteTax` was already loading that row to
   refuse an unknown code and throwing it away. Track E added `codeByLine`
   to `server/gst/engine.ts` (in-block, purely additive) so it is available.
3. **`lineTotalMinor` stops being wrong on reverse-charge lines.** The
   current inline form computes `taxable + cgst + sgst + igst + cess`,
   which adds tax the customer does not owe under Rule 46(p).
   `buildTaxWriteForSalesInvoice` takes it from the engine.

**If skipped.** The database still refuses arithmetically wrong invoices —
0147 does not depend on this — but every outward-supply line stays
untraceable, `/tax` keeps reporting `unbackfillable_no_classification`, and
the tax decision trail stays empty.

### P2b — credit-note creation (~L1229): three separate bugs on one screen

```ts
cessRateBps: 0,                                          // ← 1
taxKind: invoice.isInterState ? "igst" : "cgst_sgst",    // ← 2
placeOfSupplyCode: invoice.placeOfSupplyCode ?? "27",    // ← 3
```

1. **Cess is silently dropped.** A credit note against a cess-bearing line
   reverses the GST and not the cess. Under s.34 it must carry both. This
   needs a `cess_rate_bps` column on `sales_credit_note_lines` (**P5**) as
   well as the code change — the column does not exist, which is why SQL
   0147 could not enforce cess on credit notes.
2. **The Union Territory distinction is lost.** `raiseInvoiceFromOrder`
   uses `taxKindFor()`, which returns `cgst_utgst` for a UT; the credit
   note re-derives from a boolean and can only produce `cgst_sgst`. A
   credit note against a Chandigarh invoice reports in the wrong 3B box.
3. **`?? "27"` hardcodes Maharashtra.** An invoice with a null place of
   supply gets credited against a state it has nothing to do with. It
   should refuse.

**If skipped.** (2) and (3) are silent misreporting. (1) is money.

---

## P3 — `server/billing/invoice-generator.ts`: per-line tax on subscription invoices

> 🔴 **CORRECTED IN WAVE 17, AND THE CORRECTION LOWERS THE PRIORITY.** This
> item was written believing the generator ran. It does not: the caller
> chain `generateInvoice ← invoiceCurrentPeriod ← issueInvoiceForCurrentPeriod`
> ends at an orphan in `scripts/action-reachability-baseline.json`, with
> zero references in `app/`, `components/`, `app/api/`, `worker.ts` or
> `instrumentation.ts`. **Ordence has never issued one of these invoices.**
> Do P12 (the platform's tax identity) and make it reachable BEFORE doing
> this, or you will be wiring dead code — and the first invoice it ever
> issues is the one that sets the numbering series.

`invoices` / `invoice_lines` is Ordence's own SaaS billing. The generator
writes tax on the **header** and leaves **every line-level tax column at
zero**, then leaves `gst_computed = false`.

**What.** Populate `taxableValueMinor`, `cgstMinor`, `sgstMinor`,
`igstMinor` and `cessMinor` on each `invoiceLines` row, then set
`gstComputed: true` on the header.

**⚠️ Do these two together, in that order, or not at all.** Setting the flag
on rows whose lines carry no tax makes 0021 §6's deferred trigger refuse
them at COMMIT — which means the next attempt to mark one paid fails. SQL
0148 §5 declines to set the flag for exactly this reason and says so.

Also `computeGst` (`lib/billing/money.ts:276`) is a second, simpler GST
path: IGST-vs-CGST/SGST by bare state-code equality, no UTGST, no cess, no
reverse charge, no per-line rate id, defaulting to IGST when the place of
supply is null. It should be `computeInvoiceTax` from `lib/gst/tax.ts`.

**If skipped.** `invoices.gst_computed` stays false forever and 0021 §6's
trigger — which works, and is proven to work — never runs on this table.
Note that SQL 0147 already covers those lines with a stronger,
opt-in-free check, so the risk is bounded.

---

## P4 — `lib/gst/tax.ts`: make the round-off currency-aware

`roundOffToRupee` hardcodes `100n`. `lib/money/policy.ts roundOffToUnit`
(Track E, in block) is the exponent-aware version, built on
`lib/fx/currency.ts` so there is no second table.

**What.** Add `currency?: string` to `TaxComputationInput` and change the
one call in `computeInvoiceTax` from `roundOffToRupee(invoiceTotal)` to
`roundOffToUnit(invoiceTotal, input.currency ?? "INR")`.

**If skipped.** Latent, not live: rupee rounding is off by default and GST
invoices are INR. But `sales_invoices.currency` has been genuinely
multi-currency since 0101, and a JPY invoice with rounding on is wrong by a
factor of 100.

---

## P5 — `db/schema/sales-invoices.ts` + SQL: two missing columns

Neither can be added by Track E: the Drizzle file is not ours, and adding
the column in SQL alone leaves the schema drifted.

| column | table | why |
|---|---|---|
| `cess_rate_bps integer NOT NULL DEFAULT 0` | `sales_credit_note_lines` | s.34 requires the credit note to carry the cess. Today it cannot represent one, so SQL 0147 enforces GST but not cess on credit notes. |
| `is_reverse_charge boolean NOT NULL DEFAULT false` | `sales_invoice_lines` | Rule 46(p) is a **per-supply** rule; today it is a header boolean on `sales_invoices`. An invoice mixing forward and reverse-charge supplies cannot be represented. |

A third, larger one: **no line table has a per-unit cess column**, so a
specific-rate cess (tobacco, pan masala) is unrepresentable end to end even
though `hsn_sac_rates.cess_per_unit_minor` exists and `lib/gst/tax.ts`
charges it. `server/tax/audit.ts validateTaxDecisions()` refuses loudly
rather than recording only the ad-valorem part.

---

## P6 — `db/schema/sales-invoices.ts`: the five new IRN columns

SQL 0149 adds `irn_status`, `irn_cancelled_at`, `irn_cancel_reason`,
`einvoice_payload_hash`, `irn_error` to `sales_invoices`, plus a partial
unique index on `(tenant_id, irn)`. Mirror them in Drizzle.

---

## P7 — ✅ DONE BY INTEGRATION — `ORDENCE_EINVOICE_IRP_ENABLED`

> Integration added an "E-invoicing" category with this variable as
> optional, recording that **off is the safe value and the default**:
> absent means the payload is built and validated and nothing leaves the
> building. Track E was the third of three tracks to hit the
> `check:env-catalogue` gate this way. Left in the list rather than
> deleted, so the wave-15 numbering keeps matching the wave-15 report.

~~`lib/env.ts` and `.env.example`~~

`server/tax/einvoice.ts submitToIrp()` reads `process.env` directly and
throws unless it is set. Unset behaves as false, so nothing is broken —
but `npm run check:env-catalogue` expects every variable to be catalogued.

---

## P8 — `components/layout/`: one app shell, rendered by both route groups

`app/(finance)/layout.tsx` duplicates `(crm)`'s tenant resolution, session
verdict, two-stage navigation filtering and both safety banners, because
Track E may not write `components/**`. Until a shared shell exists, a
change to the auth or session logic in one is a change owed to the other,
and the support-access banner can silently diverge between them. Both files
say so in their headers.

---

## P9 — move `app/(finance)/tax/_pin-status.ts` to `server/tax/pin-status.ts`

There is no tenant-scoped reader for the `gst_rate_pin_status` view
anywhere in `server/`. To avoid querying the database from a page, the
reader was written inside the route group. It is a rename plus one import
fix. It also duplicates three small private helpers from
`server/tax/audit.ts`, which does not export them.

---

## P10 — navigation: nothing links to `/tax`

The nav is built in `lib/industry-templates.ts`. Both new pages are
reachable only by typing the URL. `npm run check:links` passes because it
refuses links to missing routes, not routes with no links.

---

## P11 — two pre-existing failures found while testing, neither caused by Track E

1. **`SQL-FILES/0126_updated_at_coverage.sql` §1a errors** with
   `relation "collations" does not exist`. It calls
   `has_any_column_privilege('ordence_app', quote_ident(c.table_name), …)`
   over `information_schema.columns`; the planner evaluates that before the
   `table_schema = 'public'` filter (information_schema views are not
   security barriers), so it lands on `information_schema.collations`,
   whose bare name does not resolve under the current `search_path`. Fix:
   `quote_ident(c.table_schema) || '.' || quote_ident(c.table_name)`, or a
   `::regclass` cast. Reproduced with all Track E objects dropped.

2. **`npm run check:migrations` will go red on a partial assembly.** It
   refuses gaps in the numbering, and Track E's block starts at 0146 while
   0129–0145 belong to other tracks. It goes green once every track's files
   are in the same tree. Expected, but worth not being surprised by.

---

## Schema appendix — everything SQL 0146–0150 adds

**New table `public.tax_decisions`** — `id`, `tenant_id`, `document_table`,
`document_line_id`, `document_id`, `line_no`, `decided_at`,
`document_date`, `place_of_supply_code`, `place_of_supply_basis`,
`statutory_ref`, `place_of_supply_explanation`, `hsn_sac_code`,
`hsn_sac_rate_id`, `rate_bps`, `cess_rate_bps`, `notification_ref`,
`rate_effective_from`, `rate_effective_to`, `tax_kind`,
`is_reverse_charge`, `reverse_charge_basis`, `taxable_value_minor`,
`cgst_minor`, `sgst_minor`, `igst_minor`, `cess_minor`, `engine_version`,
`decided_by`, `created_at`, `updated_at`. RLS ENABLE + FORCE, policy
`tax_decisions_tenant_isolation`, `UNIQUE (id, tenant_id)`,
`UNIQUE (tenant_id, document_table, document_line_id)`, composite FK
`(hsn_sac_rate_id, tenant_id) → hsn_sac_rates(id, tenant_id)`.

**New columns on `sales_invoices`** — `irn_status text NOT NULL DEFAULT
'not_required'`, `irn_cancelled_at timestamptz`, `irn_cancel_reason
varchar(200)`, `einvoice_payload_hash char(64)`, `irn_error text`.

**New views** — `gst_rate_pin_status` (0148) and `tax_decision_gaps`
(0150), both `security_invoker = true`.

**New functions** — `gst_rate_usage(uuid)`, `gst_apply_rate_bps(bigint,
integer)`, `gst_cgst_share(bigint)`, `gst_backfill_rate_pins(boolean)`,
`enforce_gst_line_recomputes()`, `enforce_sales_invoice_irn_integrity()`,
`enforce_tax_decision_recomputes()`. **Replaced** —
`enforce_gst_rate_history_immutable()`, `block_used_gst_rate_delete()`
(both now call `gst_rate_usage`).

**Replaced constraints** — the single-column `hsn_sac_rate_id` and
`hsn_sac_code_id` foreign keys on `sales_invoice_lines` and
`sales_order_lines` become two-column keys onto `(id, tenant_id)`.


---

## P12 — `server/actions/invoicing.ts` and `server/billing/invoice-generator.ts`: stop failing open on the platform's own tax identity

**Why.** `PLATFORM_GSTIN`, `PLATFORM_LEGAL_NAME`, `PLATFORM_ADDRESS` and
`PLATFORM_INVOICE_PREFIX` are unset on production, and five separate
fallbacks turn that from a refusal into a document:

```ts
// server/actions/invoicing.ts:228-232
legalName: process.env.PLATFORM_LEGAL_NAME ?? "Ordence",
gstin:     process.env.PLATFORM_GSTIN      ?? null,
stateCode: process.env.PLATFORM_GST_STATE_CODE ?? "29",
address:   process.env.PLATFORM_ADDRESS    ?? null,

// server/billing/invoice-generator.ts:114, :122
supplierStateCode() → DEFAULT_SUPPLIER_STATE_CODE
invoicePrefix()     → "AH"
```

What that emits today, if somebody presses "download invoice": a document
headed with a **product name**, carrying **no GSTIN and no address** — so
not a tax invoice under Rule 46(b)/(c), and the recipient cannot claim ITC
— computing its **tax head** from a guessed state code, and numbered with
the **previous product's** prefix.

⭐ The state-code default is the one that is not merely a compliance
defect: supplier state against place of supply is what decides CGST+SGST
versus IGST.

**What.** Replace all five with
`resolvePlatformIdentity()` from `server/tax/platform-identity.ts` (Track E,
in block, already written and type-checked). It returns
`{ ok: false, problems: [...] }` naming **every** missing or inconsistent
variable at once, with a remedy for each, and
`describePlatformIdentityProblems()` renders them as one paragraph fit to
show a user. It also refuses a `PLATFORM_GST_STATE_CODE` that disagrees
with the first two digits of `PLATFORM_GSTIN` rather than silently
preferring one.

```ts
const identity = resolvePlatformIdentity();
if (!identity.ok) return fail(describePlatformIdentityProblems(identity.problems));
// … use identity.identity.{legalName,gstin,stateCode,address,invoicePrefix}
```

**If skipped.** Nothing breaks today, because the generator is unreachable
(see P3). The day it becomes reachable, the first invoice Ordence ever
issues is invalid, and the invoice number series starts under the wrong
prefix — which cannot be restarted mid-year without leaving two series
inside one financial year.

---

## P13 — a migration: the sales-invoice header must agree with its own lines

**Why.** `server/tax/apply.ts` claimed, in a comment, that a
header/lines disagreement is refused at COMMIT by a trigger from SQL 0049.
**There is no such trigger.** `pg_trigger` on this database carries:

```
invoice_lines          → invoice_lines_gst_reconciles
invoices               → invoices_gst_reconciles
purchase_invoice_lines → purchase_invoice_lines_reconciles
purchase_invoices      → purchase_invoices_reconciles
```

and nothing at all on `sales_invoices` or `sales_invoice_lines`. So on the
document family that GSTR-1 is actually built from, the only thing
enforcing that the foot agrees with the column is a TypeScript function —
which is bypassable by not calling it, and nothing calls it yet.

⚠️ **SQL 0147 does not close this.** It makes every LINE recompute from its
own taxable value and rate. It says nothing about whether the header equals
the sum of the lines, which is a different property and the one that drifts
when a header is written by one statement and the lines by another.

**What.** A deferred constraint trigger on `sales_invoices` and
`sales_invoice_lines`, modelled on `enforce_gst_invoice_reconciles` from
0021 §6 — **but with no `gst_computed`-style opt-in**, since that opt-in is
the reason the original has never executed. `sales_invoices` has no such
column and should not acquire one.

**Track E has no SQL number for this wave.** 0146–0150 are spent. This needs
a number assigning before it can be written.

**If skipped.** A caller that bypasses `buildTaxWriteForSalesInvoice` can
store an invoice whose header and lines disagree, and it will be filed.

---

## P14 — `server/actions/purchase-orders.ts`: the truncating tax

`purchase-orders.ts:140` computes the PO header tax as

```ts
tax += (lineValue * BigInt(l.taxRateBps)) / 10_000n;   // truncates
```

`applyRateBps` is half-up (`+ 5000n` before dividing). This is the only one
of the five rate-application implementations in the product that is
arithmetically **wrong** rather than merely duplicated.

A purchase order is not a tax document, so nothing is filed from it. It
matters because the PO total is what `runThreeWayMatch` compares the
supplier's bill against, so a systematic one-paisa-low expectation produces
a match variance on **correct** invoices — an alert that is always slightly
wrong is an alert people learn to dismiss.

One-line fix: `applyRateBps(lineValue, l.taxRateBps)`.

---

## P15 — `server/actions/eway.ts`: the rate is split the other way round

`eway.ts:379-380` splits the *rate* with `Math.floor` and `Math.ceil`, so
the odd basis point lands on **SGST**. `splitEvenly` in
`lib/billing/money.ts` puts the odd minor unit on **CGST**, and everything
else in the product follows it.

The divergence never shows as money on our side, because an e-way bill
declares rates rather than amounts. It shows when the portal's figure is
compared against the invoice: an odd-basis-point rate is unusual but legal,
and when one occurs the e-way bill and the invoice it was generated from
state different CGST and SGST rates for the same supply.

⚠️ Also worth knowing while you are in there: `eway_bill_items` has **no
`invoice_line_id`**. Items are related to invoice lines by `line_no` —
by position.


---

## P16 — two gates count prose as code, and one of them hides orphans

Both were found by Track E's own files tripping them, and both are one-line
fixes in `scripts/`, which Track E may not edit.

### P16a — `scripts/check-tax-decisions.mjs`: the stripper does not strip strings

The function is called **`stripCommentsAndStrings`**. Its body handles `//`
and `/* */` and nothing else — it never touches a string literal. The
gate's own header says, in capitals:

> ⭐ SO CODE IS SEPARATED FROM PROSE ONCE, HERE, AND EVERY CHECK BELOW
> READS ONLY CODE.

It does not. This is the sixth occurrence of the prose trap that gate was
written to end, and this time it is in the machinery built to end it —
declared and unenforced, which is this codebase's signature defect.

Consequence: any string literal anywhere containing the two-way tax-kind
ternary fires the gate. An error message, a UI label, a fixture, or — as
happened here — a register entry describing the defect. Conversely the
`DERIVED_SPLIT` regexes also match inside string contents, so the gate's
false-positive surface is larger than its documentation claims.

**Fix:** extend the stripper to blank single-, double- and backtick-quoted
runs with equal-length whitespace, the same way it blanks comments, so line
numbers stay true. Track E worked around it by describing the defect
instead of quoting it (`server/tax/call-sites.ts`, the `credit-note`
entry) — the right fix for a file, and the wrong fix for a class.

### P16b — 🔴 `scripts/check-action-reachability.mjs`: naming an orphan makes it reachable

This one is worse, because it moves the number in the direction the gate's
own header calls dangerous:

> "Reporting a wired action as an orphan is a visible, arguable mistake;
> reporting an orphan as wired is the one that hides."

The gate counts an action as reached if its **identifier** appears anywhere
under `app/`, `components/`, `server/` or `lib/`, after stripping comments
but **not** strings. `server/tax/call-sites.ts` lives under `server/`, so
merely naming an orphaned action in the register made it read as called.
The first run after that file existed reported:

```
⭐ 5 action(s) became reachable since the baseline:
    server/actions/orders.ts#amendOrder
    server/actions/discounts.ts#computeRebate
    server/actions/invoicing.ts#issueInvoiceForCurrentPeriod
    server/actions/billing.ts#recordManualPayment
    server/actions/invoicing.ts#voidInvoice
```

**None of them had gained a caller.** Had anyone run
`--write-baseline` at that point, five dead actions would have been
laundered permanently and the count could never climb back.

**Fix:** either strip string literals as in P16a, or add
`server/tax/call-sites.ts` to the same directory-exclusion mechanism the
gate already applies to the places that "mention every action while
reaching none of them".

**Until then**, Track E stores those five identifiers split and joins them
at runtime (`orphanName()` in `server/tax/call-sites.ts`, with the reason
written above it), and `npm run check:action-reach` is back to reporting
`119 orphans (baseline 119)`. ⚠️ That workaround is a trap for the next
person who adds a register entry for a currently-orphaned action: if they
do not split it, the only symptom is a number quietly getting better.

