# Ordence — tax: the rounding policy, the rate registry, and where each number comes from

Version: v1.81.0-alpha · Wave 15 · Track E
Scope: GST, TDS and statutory correctness. Written because the answer to
"why is this figure 18000 and not 18001" was, before this document, five
files and a guess.

---

## 0. The one-paragraph version

Money is `bigint` **minor units**. Tax is rounded **per line, once**, using
**half-up away from zero** in exact integer arithmetic. CGST and SGST are
the **rounded line tax split in two**, never the rate halved and applied
twice. Invoice-level rupee rounding is **off by default**. The rate that
governs is the one **in force on the document's own date**, resolved from
`hsn_sac_rates`, and the row it came from is pinned onto the line so the
figure can be traced back to a notification. The database refuses a line
whose stored tax does not survive being recomputed from its own taxable
value and its own rate.

Everything below is either an expansion of that paragraph or an honest
statement of where the product does not yet meet it.

---

## 1. Minor units

`bigint`, always. No floats anywhere in a money path.

**Minor units are not universally two decimals.** The exponent table is
`lib/fx/currency.ts` and it is the only copy:

| exponent | currencies |
|---|---|
| 0 | BIF CLP DJF GNF ISK **JPY** KMF KRW PYG RWF UGX UYI VND VUV WST XAF XOF XPF |
| 3 | **BHD IQD JOD KWD LYD OMR TND** |
| 4 | **CLF UYW** |
| 2 | every other active ISO-4217 code, enumerated by name |

An unknown code **throws** `UnknownCurrencyError`. It does not default to
2. A silent default is how a JPY invoice comes out a hundred times too
small and looks plausible while doing it.

`lib/billing/money.ts` re-exports `minorUnitExponent` from there. There is
no second table. `server/fx/rate-service.ts verifyCurrencyUnits()` compares
the TypeScript table against the `currency_units` rows seeded by SQL 0101
and reports divergence, so the two cannot drift silently.

> ⚠️ **Known INR-only leak.** `roundOffToRupee` (`lib/gst/tax.ts`) hardcodes
> `100n`. `lib/money/policy.ts roundOffToUnit(amountMinor, currency)` is the
> exponent-aware replacement; swapping the call site requires adding
> `currency` to `TaxComputationInput`, which is a change to `lib/gst/**` and
> is therefore a patch request, not something Track E may do. It is latent
> rather than live — rupee rounding is off by default and GST invoices are
> INR — but `sales_invoices.currency` has been genuinely multi-currency
> since 0101.

---

## 2. Rounding, stated once

### 2.1 Half-up, not banker's

```
applyRateBps(amount, bps) = sign(amount) * ((|amount| * bps + 5000) / 10000)
```

integer division, truncating. `lib/billing/money.ts`.

Banker's rounding is the better choice when you are summing thousands of
independent values and want the errors to cancel. **GST is not that.** The
statutory method rounds to the nearest unit with half up, and an auditor
checking one invoice by hand will compute it that way. Matching the method
on a document somebody will recompute matters more than statistical
elegance across a portfolio.

Negatives round **away from zero** by the same magnitude, so a credit note
of −₹100 at 18% is exactly the negative of a charge of ₹100 at 18%.
Without that symmetry an upgrade followed by an immediate downgrade leaves
a stray paisa on the account forever.

The two cases that tell the implementations apart:

| taxable | rate | half-up | banker's |
|---|---|---|---|
| 5 paise | 10% | **1** | 0 |
| 15 paise | 10% | **2** | 2 |

Both belong in any parity test. The second agrees under either rule, so a
suite containing only that one misses a banker's implementation half the
time.

### 2.2 Per line, then summed

The tax is rounded **once per line** and the header totals are the sum of
the rounded line values — never `rate × summed taxable`. The two differ,
and the difference is what makes a document fail its own footing check.

### 2.3 CGST / SGST split the rounded total

```
cgst = splitEvenly(lineTax, 2)[0]     // the odd minor unit lands here
sgst = lineTax - cgst
```

**Not** `applyRateBps(taxable, rate/2)` twice. On a tax of ₹100.01 the
halved-rate form produces ₹50.01 + ₹50.01 = ₹100.02 and the invoice stops
balancing. Splitting the rounded total is exact by construction, and the
odd paisa lands on CGST, deterministically.

> ⚠️ **There is deliberately no `CHECK (cgst_minor = sgst_minor)`.** It is
> the obvious constraint and it is wrong: it would refuse the correct line
> 901 / 900 and push somebody towards rounding each half separately. SQL
> 0021 §1c argues this at length.

### 2.4 Cess

Two kinds, both per line, both possible at once:

- **ad valorem** — `applyRateBps(taxable, cessRateBps)`
- **specific** — `cessPerUnitMinor × trunc(quantity)`

Cess is never split across heads and is never set off against
CGST/SGST/IGST.

> 🔴 **Specific cess cannot be stored on any line table.**
> `hsn_sac_rates.cess_per_unit_minor` exists and `lib/gst/tax.ts` charges
> it, but no line table has a per-unit cess column, so tobacco and pan
> masala are unrepresentable end to end. `server/tax/audit.ts
> validateTaxDecisions()` **refuses loudly** rather than silently recording
> the ad-valorem part. See TRACK-REPORT.md §4.

### 2.5 Invoice-level rupee rounding

`roundToRupee` defaults **off**. Section 170 rounds the *tax*, which is a
different operation from rounding the invoice total, and a rounding that
appears without being asked for makes the invoice disagree with the payment
plan by up to 99 paise per instalment, forever.

When it is on, `roundOffToRupee` is half-up at 50 paise.

> ⚠️ **One asymmetry, stated rather than hidden.** `roundOffToRupee` rounds
> an exact half towards **+∞** (−₹1.50 becomes −₹1.00), whereas
> `applyRateBps` rounds **away from zero**. `lib/money/policy.ts
> roundOffToUnit` reproduces the existing behaviour on purpose — a
> currency-exponent fix should not smuggle in a second behaviour change —
> so the disagreement survives. Whether the round-off line on a credit note
> should follow the credit or the calendar is a decision nobody has made;
> it is listed as open.

### 2.6 Reverse charge

An RCM line contributes its **value** to the invoice total and its **tax**
to `reverse_charge_tax_minor` only. `invoiceTotalMinor` excludes it, per
Rule 46(p): under s.9(3)/9(4) the recipient pays that tax direct to the
Government, so adding it to the total charges the customer for tax we do
not owe and they pay it again themselves.

The **master** decides reverse charge and the caller may only add to it. A
classification notified under s.9(3) is on reverse charge whatever the form
says; a line may *additionally* be flagged under s.9(4) (an unregistered
supplier), which the master cannot know.

> ⚠️ `sales_invoices.is_reverse_charge` is a **header** boolean, but
> Rule 46(p) is a per-supply rule. A per-line column is a patch request.

---

## 3. The rate registry

`hsn_sac_codes` → `hsn_sac_rates`, one row per **effective-dated period**,
half-open `[effective_from, effective_to)`, compared as `YYYY-MM-DD` civil
days in IST so a notification taking effect on 1 April does not shift when
somebody reads it in UTC.

- There is **no "current rate" accessor**. Every entry point takes a date.
- `resolveRateOn` returns **`null`, never 0%**, when no period covers the
  date. A missing rate is a question, not a zero.
- **Overlaps are an error**, enforced by a GiST `EXCLUDE` constraint on
  `(tenant_id, hsn_sac_id, daterange)` and by `validateRateHistory`.
- **Gaps are a warning**, deliberately: a classification may genuinely be
  unrated before 2017-07-01.
- A rate period that a document has used **cannot be edited or moved**
  (`enforce_gst_rate_history_immutable`), and cannot be deleted
  (`block_used_gst_rate_delete`). Both read usage through
  `gst_rate_usage(rate_id)` (SQL 0146), which counts all four tables that
  pin a rate. Before 0146 they counted `invoice_lines` only and were
  therefore blind to every outward supply the product actually raises.

**A rate change is data, not a deploy.** Close the period with an end date
and open a new one; do not edit the row.

---

## 4. The pin, and what it is for

Four tables pin a rate row onto a line:

| table | column | resolved server-side today? |
|---|---|---|
| `purchase_invoice_lines` | `gst_rate_id` | **yes** — `server/purchases/engine.ts` |
| `invoice_lines` | `gst_rate_id` | no — never written |
| `sales_invoice_lines` | `hsn_sac_rate_id` | no — **passed through from the client** |
| `sales_order_lines` | `hsn_sac_rate_id` | no — **passed through from the client** |

The pin is what makes a figure traceable: it names the exact period, and
through it the notification, that produced the number. A pin that is not
resolved server-side proves nothing.

Since SQL 0146 and 0147 the database enforces that a pin, **when present**:

1. belongs to the writing tenant (a two-column FK onto `(id, tenant_id)`;
   the single-column form did not, because PostgreSQL runs referential
   checks with row security **off**, so RLS does not cover for it);
2. names a period whose date range **covers the document's own date**; and
3. carries the **same `rate_bps` and `cess_rate_bps`** the line charged —
   on outward supplies. On purchases it does not, because the figures are
   the supplier's: a vendor who charged 12% where the master says 18% is a
   dispute to record and pursue, not a bill the system may refuse to enter.

A pin is **not** mandatory. Nothing populates it on outward supplies today,
so requiring one would refuse every invoice the product raises.
`gst_rate_pin_status` (SQL 0148) reports coverage as a **number** per
verdict, and `/tax` renders it. There is no threshold and no PASS badge.

---

## 5. What the database refuses

Enforced by `enforce_gst_line_recomputes` (SQL 0147) on
`sales_invoice_lines`, `sales_credit_note_lines`, `sales_order_lines`,
`invoice_lines` (full) and `purchase_invoice_lines` (pin checks only):

| refused | why |
|---|---|
| stored CGST/SGST/IGST ≠ recomputation from the line's own taxable value and rate | an auditor recomputing the line gets a different answer from the document |
| a non-zero rate with no tax charged under it | either the rate is wrong or the tax was never computed |
| stored cess ≠ ad-valorem recomputation | same |
| IGST on an intra-state supply | the recipient cannot claim it and the supplier pays CGST+SGST again on the same supply |
| CGST+SGST on an inter-state supply | tax paid to the wrong government, claimable by nobody |
| a pin whose period does not cover the document date | provenance that points at the wrong period is worse than none |
| a pin whose rate disagrees with the rate charged (outward only) | the pin proves the opposite of what it claims |

**There is no opt-in flag.** The Phase 32 reconciliation trigger has one
(`invoices.gst_computed`) and it is why that trigger has never executed:
no code path sets it. An arithmetic check cannot break a correct document,
so it does not need one.

On UPDATE the check re-runs only if a tax column moved, so a legacy row can
still be marked paid or void.

---

## 6. TDS

`lib/tds/**` and `server/tds/**` are substantially complete and are **not**
Track E's files. What exists: the s.194 section catalogue with 206AA and
206AB loading, cumulative thresholds with retrospective catch-up on
crossing, s.197 lower-deduction certificates with a consumption cap,
challan recording and allocation, interest (1%/1.5% per month or part) and
s.234E fees, quarterly returns 24Q/26Q/27Q/27EQ, Form 16A/27D assembly, the
deposit/return/certificate calendar, and Rule 26 foreign payments.

What does not exist: TRACES/NSDL/OLTAS integration, 26AS reconciliation, FVU
file generation, challan CIN/BSR verification, and **TDS on receipts** —
tax our own customers deduct from us, including GST s.51 TDS at 2%.
`lib/gst/tax.ts` carries a typed seam for it whose `applicable` is
hardcoded `false`. Under CBDT Circular 23/2017 the deduction base is the
taxable value **excluding** GST, and that is what the seam computes.

---

## 7. What is filed, and from what

| return | built from | status |
|---|---|---|
| GSTR-1 | `sales_invoices` + credit notes, with s.34(2)/Rule 53 netting and the 30-Nov deadline | built, ledger-sourced |
| GSTR-3B | the **ledger** — journal movements joined to posting-account roles, not invoices | built; refuses to assemble if the tax accounts are unmapped |
| GSTR-2B | full parse (JSON and delimited), invoice-number canonicalisation, tolerance-based matching, vendor chase buckets | built |
| e-invoice / IRN | payload shape, validation, threshold and hash exist; the IRP call is behind `ORDENCE_EINVOICE_IRP_ENABLED` and is unimplemented | readiness only |

Nothing here transmits to a GSP or the portal, by design.

> ⚠️ **A known divergence between two of these.** GSTR-3B clamps the ledger
> movement at zero; GSTR-1 reports the signed net. In a month where credit
> notes exceed sales the two disagree. Both files document it; neither is
> obviously the wrong choice, and picking one is a decision nobody has made.

---

## 8. Where a number comes from, for an accountant

`/tax` lists every outward-supply line by whether its rate can be traced.
`/tax/<invoice-id>` is the working paper for one document: per line, the
HSN/SAC, the rate in basis points, **the period it was resolved from and
its notification reference**, the place of supply with the rule that
produced it and the statutory citation, the tax kind, reverse charge and
its basis, and the four heads beside the taxable value.

It reads `tax_decisions` (SQL 0150), which refuses to record a decision
whose money could not have come from its own stated rate.

> 🔴 **Nothing calls `recordTaxDecisions()` yet.** The writer, the schema
> and the page exist; the two call sites are in
> `server/actions/sales-invoices.ts`, which Track E does not own. Until that
> patch lands, every invoice renders the empty state, and the empty state
> says exactly this rather than showing a spinner.

---

## 9. Ordence's own tax identity, and what happens without it

The Wave 17 environment audit found `PLATFORM_GSTIN`,
`PLATFORM_LEGAL_NAME`, `PLATFORM_ADDRESS` and `PLATFORM_INVOICE_PREFIX`
all **unset on production**. That would be a configuration gap and nothing
more, if the code that needs them refused without them.

🔴 **It does not. It fails open, in four places.**

| where | fallback | what it produces |
|---|---|---|
| `server/actions/invoicing.ts:228` | `PLATFORM_LEGAL_NAME ?? "Ordence"` | a tax invoice headed with a **product name**, not a registered legal name (Rule 46(b)) |
| `server/actions/invoicing.ts:229` | `PLATFORM_GSTIN ?? null` | **no GSTIN**. Not a tax invoice. The recipient cannot claim ITC and finds out at GSTR-2B reconciliation, months later |
| `server/actions/invoicing.ts:231` | `PLATFORM_ADDRESS ?? null` | **no address** (Rule 46(c)) |
| `server/actions/invoicing.ts:230` and `server/billing/invoice-generator.ts:114` | `PLATFORM_GST_STATE_CODE ?? "29"` / `DEFAULT_SUPPLIER_STATE_CODE` | ⭐ **the worst one.** The supplier's state against the place of supply is what decides CGST+SGST versus IGST. Unset, every one of Ordence's own invoices computes its tax **head** from a guessed Karnataka |
| `server/billing/invoice-generator.ts:122` | `PLATFORM_INVOICE_PREFIX ?? "AH"` | invoice numbers prefixed with the **previous product's** initials. Rule 46(b) wants a consecutive serial unique for the financial year; adopting a prefix later leaves two series in one year |

**`server/tax/platform-identity.ts` resolves or refuses and never
substitutes.** There is no default in it and `??` does not appear in it. It
reports **every** problem rather than the first — someone configuring a
deployment sets these in one sitting, and returning them one per redeploy
costs four deploys to learn four facts that were all knowable at once.

⚠️ **The state code is checked against the GSTIN, not accepted beside it.**
The first two characters of a GSTIN *are* the state. Holding the code
separately gives one fact two sources, and the day they disagree the tax
head is decided by whichever the reader reached for. So
`PLATFORM_GST_STATE_CODE` is treated as an assertion to be verified, and a
disagreement is **refused** rather than resolved in favour of either.

Swapping the two fallback sites for it is a patch request (P12) —
`server/actions/invoicing.ts` and `server/billing/invoice-generator.ts` are
not Track E's files.

> ⚠️ Note that `server/billing/invoice-generator.ts` is currently
> **unreachable** — its caller chain ends at an orphan in
> `scripts/action-reachability-baseline.json`. Ordence has never issued one
> of these invoices. That lowers the urgency and raises the importance of
> fixing it before the first one goes out, because the first one is the one
> that sets the numbering series.

---

## 10. Wave 17 corrections to this document and its neighbours

Three claims made in wave 15 turned out to be wrong. They are listed here
rather than quietly edited, because a document that silently corrects
itself teaches nobody.

1. **`server/tax/apply.ts` said a reconciliation trigger from SQL 0049
   refuses a header/lines disagreement on a sales invoice at COMMIT.**
   There is no such trigger. `pg_trigger` carries `invoices_gst_reconciles`,
   `invoice_lines_gst_reconciles` and the two purchase equivalents, and
   **nothing on `sales_invoices` or `sales_invoice_lines`**. So
   `buildTaxWriteForSalesInvoice` is currently the *only* thing enforcing
   it, and it is bypassable by not calling it. The comment has been
   corrected; the missing migration is P13.

2. **SQL 0150's comment names a place-of-supply vocabulary that does not
   exist.** It lists `recipient_registered`, `immovable_property`,
   `performance`, `goods_delivery`. `lib/gst/place-of-supply.ts` emits
   `recipient_registration`, `recipient_address`,
   `immovable_property_location`, `delivery_location`, `supplier_location`,
   `sez_deemed_interstate`, `outside_india`. Its `statutory_ref` example is
   `'IGST Act s.12(3)(a)'`; the engine emits `'Section 12(2)(a), IGST Act'`.
   Nothing is enforced, so nothing breaks — but a query written from the
   comment returns zero rows. **Deliberately not fixed here:** 0150 is
   applied on the assembled tree and `scripts/migrate.mjs` records a
   checksum, so editing even a comment makes the file read as changed.
   Needs a `COMMENT ON COLUMN` in a future SQL number.

3. **`tax_decisions.tax_kind` is a per-line column written from the
   header.** Correct today — one supply, one place of supply — but a
   document mixing two could not be represented, and the per-line column
   would silently carry a header fact.
