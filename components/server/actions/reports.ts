"use server";

/**
 * Ordence — Reports Server Actions
 * Version: v0.82.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION.
 *
 * Predefined report executors that aggregate tenant data into structured
 * summaries. Each report runs inside `withTenant()` under RLS.
 */

import { and, eq, desc, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  complianceTasks,
  complianceObligations,
  demandNotices,
  receipts,
  tdsDeductions,
  tdsChallans,
  stockBalances,
  stockItems,
  projects,
  salesInvoices,
  salesInvoiceLines,
  salesCreditNotes,
  itcRegister,
} from "@/db/schema";
import { requireTenantContext } from "@/server/tenant-context";
import { functionalCurrencyFromSettings, formatMinorPlain } from "@/lib/fx/currency";
import { sumByCurrency } from "@/lib/fx/aggregate";
/**
 * ⭐⭐ ONE IMPLEMENTATION OF RULE 53, SHARED WITH THE RETURN.
 * `lib/gstr1/build.ts` calls the same `creditNoteEffect`, so the summary
 * and GSTR-1 cannot come to different conclusions about whether a credit
 * note reduces output tax — which is the only way the two figures on the
 * two screens can be defended as one position.
 */
import {
  GST_HEADS,
  ZERO_HEADS,
  addHeads,
  creditNoteEffect,
  netCreditNotes,
  taxPeriodOf,
  totalOf,
  type HeadAmounts,
  type PeriodMovement,
} from "@/lib/gstr1/netting";

type ReportResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ BATCH 0101 — EVERY TOTAL BELOW CARRIES A CURRENCY
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS WRONG. Every figure this file produced was a bare
 * `coalesce(sum(...), 0)::text` with no currency anywhere near it. Two
 * distinct faults were hiding in that, and they need different fixes:
 *
 *   ① A SUM OVER A TABLE THAT HAS A `currency` COLUMN. `getGstSummary`
 *      summed `billing.invoices`, which carries one. Dollars and rupees
 *      were added together. FIXED BELOW by grouping.
 *
 *      🔴 AND BATCH 0104 THEN FIXED THE DEEPER FAULT 0101 ONLY NAMED:
 *      `billing.invoices` was the WRONG TABLE ENTIRELY. It is Ordence
 *      billing its own tenants. This report now reads `sales_invoices` —
 *      the workspace's own outward supplies — and still groups.
 *
 *   ② A SUM OVER A TABLE WITH NO `currency` COLUMN — `demand_notices`,
 *      `receipts`, `tds_deductions`, `itc_register`, `tds_challans`.
 *      These are single-currency BY CONSTRUCTION and the arithmetic was
 *      never wrong. What was wrong is that the number reached a screen
 *      with nothing saying what it was a quantity of. FIXED BELOW by
 *      labelling with the workspace's functional currency and saying, on
 *      the payload, that the label is an assumption the schema forces
 *      rather than a fact the row carries.
 *
 * ⚠️ ② IS NOT COSMETIC. `demand_notices` holding no currency is itself
 * the reason a developer who starts selling to a Gulf buyer will silently
 * get a wrong ageing — and a payload that says "assumed INR because the
 * table cannot hold anything else" is the only place that fact is visible.
 */
type SingleCurrencyTotal = {
  currency: string;
  amountMinor: string;
  formatted: string;
  /**
   * 🔴 TRUE when the currency is the workspace's functional currency
   * applied by assumption, because the underlying table has no `currency`
   * column at all. False when the row carried its own.
   */
  currencyAssumed: boolean;
};

function labelled(
  amountMinor: bigint,
  currency: string,
  currencyAssumed: boolean,
): SingleCurrencyTotal {
  return {
    currency,
    amountMinor: amountMinor.toString(),
    formatted: `${currency} ${formatMinorPlain(amountMinor, currency)}`,
    currencyAssumed,
  };
}

/**
 * ⭐ THE FOUR HEADS, EACH CARRYING THE CURRENCY, PLUS THE SUM.
 *
 * ⚠️ THE HEADS ARE LABELLED INDIVIDUALLY AND NOT JUST THE TOTAL. CGST is
 * owed to the Union, SGST to the State and IGST to the Union for
 * apportionment; they are three liabilities and a single "tax" figure is
 * three facts flattened into one. The total is provided beside them
 * because a screen needs one number, not instead of them.
 */
type LabelledHeads = {
  cgst: SingleCurrencyTotal;
  sgst: SingleCurrencyTotal;
  igst: SingleCurrencyTotal;
  cess: SingleCurrencyTotal;
  total: SingleCurrencyTotal;
};

function labelledHeads(heads: HeadAmounts, currency: string): LabelledHeads {
  return {
    cgst: labelled(heads.cgst, currency, false),
    sgst: labelled(heads.sgst, currency, false),
    igst: labelled(heads.igst, currency, false),
    cess: labelled(heads.cess, currency, false),
    total: labelled(totalOf(heads), currency, false),
  };
}

/** `numeric`/`bigint` arrives as a string on some paths. Never via `Number`. */
function toMinor(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  return BigInt(String(value).trim().split(".")[0] || "0");
}

/* ------------------------------------------------------------------ */
/* GST SUMMARY                                                         */
/* ------------------------------------------------------------------ */

export async function getGstSummary(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      /**
       * ═════════════════════════════════════════════════════════════
       * 🔴 BATCH 0104 — THIS READ USED TO BE OF THE WRONG TABLE
       * ═════════════════════════════════════════════════════════════
       * It joined `invoice_lines` to `invoices` — and `invoices` in
       * `db/schema/billing.ts` is ORDENCE BILLING ITS OWN TENANTS. Those
       * rows carry `subscription_id`, `provider_invoice_id` and
       * `hosted_invoice_url`; their customer is the workspace, and
       * `server/billing/invoice-generator.ts` fills `customer_legal_name`
       * from the TENANT.
       *
       * So an Indian business opening "GST Summary" was shown the output
       * tax on ITS OWN SUBSCRIPTION BILLS FROM ORDENCE. Not a rounding
       * error, not a stale figure — somebody else's sales, presented as
       * the workspace's outward supply position, on the screen used to
       * decide what to file.
       *
       * ⚠️ AND IT FOOTED. Both tables have `cgst_minor`, `sgst_minor`,
       * `igst_minor` and `taxable_value_minor` in exactly those names, so
       * the query compiled, ran, returned plausible rupee figures and
       * never once mentioned that it was describing the wrong business.
       * `db/schema/sales-invoices.ts` opens by saying the two tables
       * "MUST NEVER MERGE" and that merging them "would put Ordence's own
       * revenue into its tenants' GSTR-1" — which is what this report did
       * on screen, short of the return itself.
       *
       * ⭐ THE RIGHT TABLE IS `sales_invoices` / `sales_invoice_lines`:
       * the workspace billing ITS customers. Same shape, opposite
       * direction. `lib/gstr1/build.ts` and the GSTR-1 path already read
       * these; this report was the outlier.
       */

      /**
       * ⭐ GROUPED BY `sales_invoices.currency`, WHICH IS A REAL COLUMN.
       * An exporter raising a USD invoice and a domestic invoice in the
       * same period has two output-tax figures and no third one. Grouping
       * needs no exchange rate and cannot be wrong.
       *
       * ⚠️ STATUS, NOT PAYMENT. The GST liability on an outward supply
       * arises when the tax invoice is ISSUED, not when it is paid, so
       * `part_paid` and `paid` count exactly as much as `issued`. `draft`
       * is not a document and `cancelled` was withdrawn under the narrow
       * lawful window; neither is a supply. The old query filtered
       * `status = 'open'`, which is a BILLING lifecycle value that does
       * not exist in `sales_invoice_status` at all.
       *
       * ⚠️ `count(DISTINCT invoice)`, NOT `count(*)`. The old version
       * counted LINES and the screen labelled the result "invoices", so a
       * single five-line invoice was reported as five.
       */
      const outputTaxRows = await tx
        .select({
          currency: salesInvoices.currency,
          count: sql<number>`count(distinct ${salesInvoices.id})::int`,
          totalTax: sql<string>`coalesce(sum(${salesInvoiceLines.cgstMinor} + ${salesInvoiceLines.sgstMinor} + ${salesInvoiceLines.igstMinor}), 0)::text`,
          totalValue: sql<string>`coalesce(sum(${salesInvoiceLines.taxableValueMinor}), 0)::text`,
          /**
           * ⭐ THE SAME FIGURES HEAD BY HEAD, so they can be compared
           * against the DOCUMENT totals read below. See `tiesToDocument`.
           */
          lineCgst: sql<string>`coalesce(sum(${salesInvoiceLines.cgstMinor}), 0)::text`,
          lineSgst: sql<string>`coalesce(sum(${salesInvoiceLines.sgstMinor}), 0)::text`,
          lineIgst: sql<string>`coalesce(sum(${salesInvoiceLines.igstMinor}), 0)::text`,
          lineCess: sql<string>`coalesce(sum(${salesInvoiceLines.cessMinor}), 0)::text`,
        })
        .from(salesInvoiceLines)
        .innerJoin(
          salesInvoices,
          and(
            eq(salesInvoiceLines.invoiceId, salesInvoices.id),
            // Belt and braces beside RLS: a join across tenants would be
            // arithmetic nonsense even where a policy permitted it.
            eq(salesInvoiceLines.tenantId, salesInvoices.tenantId),
          ),
        )
        .where(sql`${salesInvoices.status} IN ('issued', 'part_paid', 'paid')`)
        .groupBy(salesInvoices.currency)
        .orderBy(salesInvoices.currency);

      /**
       * ══════════════════════════════════════════════════════════════
       * ⭐⭐⭐ v1.67.0 — THE SUPPLY SIDE, BY TAX PERIOD AND BY HEAD
       * ══════════════════════════════════════════════════════════════
       * ⚠️ READS THE DOCUMENT TOTALS, NOT THE LINE TOTALS, AND THAT IS
       * WHAT MAKES THIS AGREE WITH THE RETURN. `loadGstr1Documents`
       * carries `sales_credit_notes` and the document-level tax columns
       * into GSTR-1, so a summary built from line sums and a return
       * built from document totals are two answers whenever a trigger
       * has not kept them in step. Both are read here and compared —
       * see `tiesToDocument` on the payload.
       *
       * ⚠️ THE PERIOD IS THE UTC MONTH OF `issued_at`, WHICH IS THE
       * BASIS `server/invoicing/documents.ts` USES FOR THE RETURN. It is
       * the wrong basis in law — a tax period is an Indian calendar
       * month, and a UTC boundary puts every document raised in the
       * first five and a half hours of an Indian month into the previous
       * return — but it is the basis the return uses, and a summary that
       * disagreed with the return would be a second wrong number rather
       * than a check on the first. Named on the payload as
       * `periodBoundary` and in the batch report.
       */
      const supplyPeriods = await tx
        .select({
          currency: salesInvoices.currency,
          period: sql<string>`to_char(${salesInvoices.issuedAt} at time zone 'UTC', 'YYYY-MM')`,
          cgst: sql<string>`coalesce(sum(${salesInvoices.cgstMinor}), 0)::text`,
          sgst: sql<string>`coalesce(sum(${salesInvoices.sgstMinor}), 0)::text`,
          igst: sql<string>`coalesce(sum(${salesInvoices.igstMinor}), 0)::text`,
          cess: sql<string>`coalesce(sum(${salesInvoices.cessMinor}), 0)::text`,
          taxableValue: sql<string>`coalesce(sum(${salesInvoices.taxableValueMinor}), 0)::text`,
        })
        .from(salesInvoices)
        .where(
          and(
            sql`${salesInvoices.status} IN ('issued', 'part_paid', 'paid')`,
            sql`${salesInvoices.issuedAt} IS NOT NULL`,
          ),
        )
        .groupBy(salesInvoices.currency, sql`2`)
        .orderBy(salesInvoices.currency, sql`2`);

      /**
       * ══════════════════════════════════════════════════════════════
       * 🔴 THE REDUCTIONS — ROW BY ROW, AND DELIBERATELY NOT AGGREGATED
       * ══════════════════════════════════════════════════════════════
       * Section 34(2) is decided per document, against the date of the
       * ORIGINAL SUPPLY, and a month can straddle the 30 November
       * deadline. Aggregating in SQL would mean restating the deadline
       * as SQL date arithmetic — a second implementation of a statutory
       * rule, which is how two parts of a system come to disagree about
       * a return. `lib/gstr1/netting.ts` decides it once and both this
       * summary and `lib/gstr1/build.ts` call it.
       *
       * ⚠️ A LEFT JOIN, NOT AN INNER ONE. `invoice_id` is NOT NULL but a
       * note whose original document cannot be resolved must be reported
       * as unverifiable rather than dropped — dropping it would restore
       * the very overstatement this batch exists to remove.
       *
       * ⚠️ ONE ROW PER CREDIT NOTE, NOT PER LINE. Credit notes are rare
       * next to invoices; the invoice side above stays aggregated in the
       * database precisely because it is not.
       */
      const creditNoteRows = await tx
        .select({
          currency: salesCreditNotes.currency,
          noteDate: salesCreditNotes.noteDate,
          issuedAt: salesCreditNotes.issuedAt,
          supplyDate: salesInvoices.invoiceDate,
          cgst: salesCreditNotes.cgstMinor,
          sgst: salesCreditNotes.sgstMinor,
          igst: salesCreditNotes.igstMinor,
          cess: salesCreditNotes.cessMinor,
          taxableValue: salesCreditNotes.taxableValueMinor,
        })
        .from(salesCreditNotes)
        .leftJoin(
          salesInvoices,
          and(
            eq(salesCreditNotes.invoiceId, salesInvoices.id),
            eq(salesCreditNotes.tenantId, salesInvoices.tenantId),
          ),
        )
        .where(sql`${salesCreditNotes.status} IN ('issued', 'part_paid', 'paid')`);

      const inputTax = await tx
        .select({
          count: sql<number>`count(*)::int`,
          totalItc: sql<string>`coalesce(sum(itc_register.cgst_minor + itc_register.sgst_minor + itc_register.igst_minor), 0)::text`,
        })
        .from(itcRegister)
        .where(eq(itcRegister.status, "claimed"));

      const pendingTasks = await tx
        .select({
          count: sql<number>`count(*)::int`,
          oldest: sql<string>`min(${complianceTasks.dueDate})`,
        })
        .from(complianceTasks)
        .leftJoin(complianceObligations, eq(complianceTasks.obligationId, complianceObligations.id))
        .where(and(
          eq(complianceTasks.status, "pending"),
          sql`${complianceObligations.authority} = 'gst'`,
        ));

      /**
       * ⭐ ONE ROW PER CURRENCY, OVER THE UNION OF BOTH SIDES. A
       * workspace can hold a credit note in a currency it raised no
       * supply in during the same window, and that note must still
       * appear rather than vanish for want of a matching supply row.
       */
      const grossByCurrency = new Map(outputTaxRows.map((r) => [r.currency, r]));
      const currencies = [
        ...new Set([
          ...outputTaxRows.map((r) => r.currency),
          ...supplyPeriods.map((r) => r.currency),
          ...creditNoteRows.map((r) => r.currency),
        ]),
      ].sort();

      const netted = currencies.map((currency) => {
        const supplies: PeriodMovement[] = supplyPeriods
          .filter((r) => r.currency === currency)
          .map((r) => ({
            period: r.period,
            heads: {
              cgst: toMinor(r.cgst),
              sgst: toMinor(r.sgst),
              igst: toMinor(r.igst),
              cess: toMinor(r.cess),
            },
            taxableValueMinor: toMinor(r.taxableValue),
          }));

        const notes = creditNoteRows.filter((r) => r.currency === currency);
        const reductions: PeriodMovement[] = [];
        let timeBarredCount = 0;
        let windowUnverifiedCount = 0;
        let withoutIssueTimestamp = 0;
        let timeBarredTax = 0n;

        for (const note of notes) {
          const heads = {
            cgst: toMinor(note.cgst),
            sgst: toMinor(note.sgst),
            igst: toMinor(note.igst),
            cess: toMinor(note.cess),
          };
          const effect = creditNoteEffect({
            noteDate: String(note.noteDate),
            supplyDate: note.supplyDate === null ? null : String(note.supplyDate),
          });
          if (effect.reason === "supply_date_unknown") windowUnverifiedCount += 1;
          if (!effect.reducesOutputTax) {
            timeBarredCount += 1;
            timeBarredTax += totalOf(heads);
            continue;
          }
          /**
           * ⚠️ THE PERIOD OF THE NOTE, NEVER THE PERIOD OF THE INVOICE.
           * A note declared in August against a June supply reduces
           * August. Netting it back into June would restate a return
           * that has already been filed.
           *
           * ⚠️ `issued_at` FIRST, `note_date` ONLY AS A FALLBACK, so the
           * period matches the one the return would put it in. Unlike
           * `sales_invoices`, `sales_credit_notes` carries no CHECK
           * requiring an issued document to have a timestamp, and the
           * GSTR-1 loader filters on that timestamp — so a note without
           * one is invisible to the return and is counted here.
           */
          if (note.issuedAt === null) withoutIssueTimestamp += 1;
          reductions.push({
            period: taxPeriodOf(
              note.issuedAt ? note.issuedAt.toISOString() : String(note.noteDate),
            ),
            heads,
            taxableValueMinor: toMinor(note.taxableValue),
          });
        }

        const netting = netCreditNotes({ supplies, reductions });
        const gross = grossByCurrency.get(currency);

        /**
         * 🔴 DOES THE DOCUMENT AGREE WITH ITS OWN LINES? The headline
         * above sums `sales_invoice_lines`; the netting sums the
         * document totals, which is what GSTR-1 files. They are kept in
         * step by a trigger, so a difference is not a rounding artefact
         * — it is a document whose lines and header have diverged, and
         * the return and the books will disagree by exactly that much.
         */
        const lineHeads = {
          cgst: toMinor(gross?.lineCgst),
          sgst: toMinor(gross?.lineSgst),
          igst: toMinor(gross?.lineIgst),
          cess: toMinor(gross?.lineCess),
        };
        const documentHeads = supplies.reduce<HeadAmounts>(
          (acc, s) => addHeads(acc, s.heads),
          ZERO_HEADS,
        );
        const driftMinor = totalOf(documentHeads) - totalOf(lineHeads);

        return {
          currency,
          count: gross?.count ?? 0,
          totalTax: labelled(toMinor(gross?.totalTax), currency, false),
          totalValue: labelled(toMinor(gross?.totalValue), currency, false),
          /** ⭐ The same supplies read the way the return reads them. */
          documentTax: labelledHeads(documentHeads, currency),
          creditNotes: {
            count: notes.length,
            nettedCount: reductions.length,
            timeBarredCount,
            windowUnverifiedCount,
            withoutIssueTimestamp,
            timeBarredTax: labelled(timeBarredTax, currency, false),
            reducedTax: labelledHeads(
              reductions.reduce<HeadAmounts>((acc, r) => addHeads(acc, r.heads), ZERO_HEADS),
              currency,
            ),
          },
          /** 🔴 SIGNED. Below zero is a real answer — see `carriedForward`. */
          netTax: labelledHeads(netting.net, currency),
          /** ⭐ What is payable, head by head, after carry. Never negative. */
          liability: labelledHeads(netting.liability, currency),
          /**
           * ⭐ REDUCTION NOT YET USED. A period whose credit notes
           * exceeded its supplies does not produce a negative liability
           * and does not produce a zero either: the excess carries into
           * the next period on the SAME head, and whatever is left at
           * the end is this figure.
           */
          carriedForward: labelledHeads(netting.carriedForward, currency),
          hasNegativePeriod: netting.hasNegativePeriod,
          periods: netting.periods.map((p) => ({
            period: p.period,
            grossTax: labelled(totalOf(p.gross), currency, false),
            reducedTax: labelled(totalOf(p.reductions), currency, false),
            netTax: labelled(totalOf(p.net), currency, false),
            liability: labelled(totalOf(p.liability), currency, false),
            carriedOut: labelled(totalOf(p.carriedOut), currency, false),
            /** Which heads went below zero, so it is not a mystery. */
            negativeHeads: GST_HEADS.filter((h) => p.net[h] < 0n),
          })),
          tiesToDocument: {
            agrees: driftMinor === 0n,
            differenceMinor: driftMinor.toString(),
          },
        };
      });

      return {
        /**
         * ⭐ NAMED SO THE SOURCE IS NOT A GUESS. A reader who has just
         * been shown the wrong table's numbers deserves to see, on the
         * payload, which table these came from.
         */
        source: "sales_invoices",
        /**
         * ⭐ AN ARRAY, ONE ENTRY PER CURRENCY. Never a single scalar,
         * because there is no single scalar to give when the underlying
         * set spans currencies — and a shape that can only hold one
         * number is how the previous version came to hold a wrong one.
         */
        outputTaxByCurrency: netted,
        outputTaxCurrencies: currencies,
        /**
         * ⭐ NETTED SINCE v1.67.0, AND THE FLAG STAYS SO THAT A SCREEN
         * BUILT AGAINST THE OLD PAYLOAD SAYS THE RIGHT THING RATHER THAN
         * SILENTLY CHANGING MEANING. `totalTax` is still the GROSS
         * figure; `liability` is what Rule 53 leaves.
         */
        outputTaxExcludesCreditNotes: false,
        /**
         * ⚠️ THE BASIS EVERY FIGURE ABOVE IS BUCKETED ON, stated because
         * it is the wrong one in law and the right one for agreeing with
         * the return. See the comment on `supplyPeriods`.
         */
        periodBoundary: "utc_month_of_issued_at",
        /**
         * ⚠️ THE EARLIER LIMB OF s.34(2) IS NOT APPLIED. The window ends
         * on the annual return's filing date when that is before 30
         * November, and nothing in Ordence records a GSTR-9 filing — so
         * the window applied is the latest lawful one and a note in the
         * gap between the two dates is netted when it should not be.
         */
        section34AnnualReturnLimbApplied: false,
        /**
         * ⚠️ `itc_register` HAS NO `currency` COLUMN, and it correctly has
         * none: input tax credit under the CGST Act is a rupee amount in a
         * rupee electronic credit ledger. So the label is the functional
         * currency by assumption and the payload says so.
         */
        inputTax: {
          count: inputTax[0]?.count ?? 0,
          totalItc: labelled(toMinor(inputTax[0]?.totalItc), functional.code, true),
        },
        pendingFilings: pendingTasks[0]?.count ?? 0,
        nextFilingDue: pendingTasks[0]?.oldest ?? null,
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate GST summary." };
  }
}

/* ------------------------------------------------------------------ */
/* RECEIVABLES AGING                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BATCH 0101 — WHY THIS ONE IS LABELLED AND NOT GROUPED.
 *
 * `demand_notices` and `receipts` have NO `currency` column. That is not
 * an oversight this batch can fix from here — adding one means a
 * migration on two tables plus every write path that fills them — so the
 * arithmetic below was, and remains, correct: it sums one currency
 * because the schema cannot hold two.
 *
 * 🔴 WHAT WAS WRONG IS THAT THE NUMBER LEFT THIS FUNCTION NAKED. A
 * receivables ageing is read by somebody deciding whom to chase, and a
 * bare "412000" is a figure they will read as rupees whatever the
 * workspace's books are actually kept in. Every total below now carries
 * the functional currency AND a flag saying the label is an assumption
 * the schema forces.
 *
 * ⚠️ STATED GAP: a workspace whose functional currency is not INR and
 * which raises a foreign-currency demand has no way to record it here at
 * all. Listed in the batch report.
 */
export async function getReceivablesAging(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const aging = await tx
        .select({
          bucket: sql<string>`
            CASE
              WHEN (${demandNotices.noticeDate}::date) >= (now() - interval '30 days')::date THEN '0-30'
              WHEN (${demandNotices.noticeDate}::date) >= (now() - interval '60 days')::date THEN '31-60'
              WHEN (${demandNotices.noticeDate}::date) >= (now() - interval '90 days')::date THEN '61-90'
              ELSE '90+'
            END
          `,
          count: sql<number>`count(*)::int`,
          total: sql<string>`coalesce(sum(outstanding_minor), 0)::text`,
        })
        .from(demandNotices)
        .where(sql`outstanding_minor > 0`)
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      const totalReceipts = await tx
        .select({
          count: sql<number>`count(*)::int`,
          total: sql<string>`coalesce(sum(${receipts.amountMinor}), 0)::text`,
        })
        .from(receipts)
        .where(sql`received_on >= (now() - interval '30 days')::date`);

      return {
        currency: functional.code,
        currencyAssumed: true,
        currencyNote:
          `demand_notices has no currency column, so every figure here is ${functional.code} ` +
          `by construction rather than by measurement. A foreign-currency demand cannot be ` +
          `recorded in this table at all.`,
        buckets: aging.map((b) => ({
          bucket: b.bucket,
          count: b.count,
          total: labelled(toMinor(b.total), functional.code, true),
        })),
        receipts30Days: {
          count: totalReceipts[0]?.count ?? 0,
          total: labelled(toMinor(totalReceipts[0]?.total), functional.code, true),
        },
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate receivables aging." };
  }
}

/* ------------------------------------------------------------------ */
/* TDS SUMMARY                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BATCH 0101 — LABELLED, NOT GROUPED, AND FOR A GOOD REASON.
 *
 * `tds_deductions` and `tds_challans` hold no currency and must not: tax
 * deducted at source under Chapter XVII-B is paid to the Government in
 * rupees, on a rupee challan, whatever currency the underlying payment was
 * made in. So these figures ARE rupees.
 *
 * 🔴 WHICH IS ITSELF A GAP WORTH NAMING: a payment to a non-resident under
 * s.195 is frequently made in foreign currency and the TDS is computed on
 * the rupee equivalent at the rate prescribed by Rule 26 — the telegraphic
 * transfer buying rate on the date the tax is required to be deducted.
 * Ordence does not apply Rule 26 anywhere, so a s.195 deduction entered
 * here is whatever rupee figure somebody typed. Named in the batch report.
 */
export async function getTdsSummary(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const deductions = await tx
        .select({
          count: sql<number>`count(*)::int`,
          totalTds: sql<string>`coalesce(sum(tax_minor + surcharge_minor + cess_minor), 0)::text`,
        })
        .from(tdsDeductions)
        .where(sql`deduction_date >= date_trunc('month', now())::date - interval '3 months'`);

      const pendingChallans = await tx
        .select({
          count: sql<number>`count(*)::int`,
          totalTds: sql<string>`coalesce(sum(total_tds_minor), 0)::text`,
        })
        .from(tdsChallans)
        .where(eq(tdsChallans.status, "pending"));

      const bySection = await tx
        .select({
          section: tdsDeductions.section,
          count: sql<number>`count(*)::int`,
          totalTds: sql<string>`coalesce(sum(tax_minor + surcharge_minor + cess_minor), 0)::text`,
        })
        .from(tdsDeductions)
        .where(sql`deduction_date >= date_trunc('month', now())::date - interval '3 months'`)
        .groupBy(tdsDeductions.section)
        .orderBy(desc(sql`2`));

      return {
        currency: functional.code,
        currencyAssumed: true,
        quarterly: {
          count: deductions[0]?.count ?? 0,
          totalTds: labelled(toMinor(deductions[0]?.totalTds), functional.code, true),
        },
        pendingChallans: {
          count: pendingChallans[0]?.count ?? 0,
          totalTds: labelled(toMinor(pendingChallans[0]?.totalTds), functional.code, true),
        },
        bySection: bySection.map((s) => ({
          section: s.section,
          count: s.count,
          totalTds: labelled(toMinor(s.totalTds), functional.code, true),
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate TDS summary." };
  }
}

/* ------------------------------------------------------------------ */
/* COMPLIANCE STATUS                                                   */
/* ------------------------------------------------------------------ */

export async function getComplianceStatus(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const today = new Date().toISOString().slice(0, 10);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const byStatus = await tx
        .select({
          status: complianceTasks.status,
          count: sql<number>`count(*)::int`,
        })
        .from(complianceTasks)
        .groupBy(complianceTasks.status);

      const overdue = await tx
        .select({
          count: sql<number>`count(*)::int`,
          oldest: sql<string>`min(${complianceTasks.dueDate})`,
        })
        .from(complianceTasks)
        .where(and(eq(complianceTasks.status, "pending"), sql`${complianceTasks.dueDate} < ${today}`));

      const byAuthority = await tx
        .select({
          authority: complianceObligations.authority,
          pending: sql<number>`count(*) FILTER (WHERE ${complianceTasks.status} = 'pending')::int`,
          /**
           * ══════════════════════════════════════════════════════════
           * 🔴 v1.67.0 — `'completed'` IS NOT A `compliance_task_status`
           * ══════════════════════════════════════════════════════════
           * The enum in `db/schema/compliance.ts:157` is pending,
           * in_progress, awaiting_client, ready_to_file, filed,
           * late_filed, missed, not_applicable. There has never been a
           * `completed`.
           *
           * ⚠️ THIS IS THE SAME FAULT v1.66.0 FOUND IN `getGstSummary`,
           * which filtered `status = 'open'` — a value
           * `sales_invoice_status` does not contain either. Comparing an
           * enum column to a literal outside its labels is not a
           * mismatch that returns nothing; Postgres refuses the input
           * value, so the whole compliance report failed rather than
           * quietly reading zero.
           *
           * ⭐ A GST OBLIGATION IS DISCHARGED BY BEING FILED, and a
           * return filed after its due date is still filed — the
           * lateness is a separate fact carried by its own label, and
           * counting `late_filed` as outstanding would show a workspace
           * arrears it has already cleared.
           */
          completed: sql<number>`count(*) FILTER (WHERE ${complianceTasks.status} IN ('filed', 'late_filed'))::int`,
          overdue: sql<number>`count(*) FILTER (WHERE ${complianceTasks.status} = 'pending' AND ${complianceTasks.dueDate} < ${today})::int`,
        })
        .from(complianceTasks)
        .leftJoin(complianceObligations, eq(complianceTasks.obligationId, complianceObligations.id))
        .groupBy(complianceObligations.authority)
        .orderBy(complianceObligations.authority);

      return {
        byStatus: byStatus.map((s) => ({ status: s.status, count: s.count })),
        overdueCount: overdue[0]?.count ?? 0,
        oldestOverdue: overdue[0]?.oldest ?? null,
        byCategory: byAuthority.map((c) => ({
          category: c.authority ?? "uncategorised",
          pending: c.pending,
          completed: c.completed,
          overdue: c.overdue,
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate compliance status." };
  }
}

/* ------------------------------------------------------------------ */
/* INVENTORY VALUATION                                                 */
/* ------------------------------------------------------------------ */

export async function getInventoryValuation(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const totals = await tx
        .select({
          itemCount: sql<number>`count(distinct ${stockBalances.stockItemId})::int`,
          totalQty: sql<string>`coalesce(sum(${stockBalances.quantityOnHand} - ${stockBalances.quantityReserved}), 0)::text`,
          reservedQty: sql<string>`coalesce(sum(${stockBalances.quantityReserved}), 0)::text`,
        })
        .from(stockBalances)
        .where(sql`${stockBalances.quantityOnHand} > 0`);

      const lowStock = await tx
        .select({
          id: stockItems.id,
          name: stockItems.name,
          sku: stockItems.sku,
          onHand: stockBalances.quantityOnHand,
          reserved: stockBalances.quantityReserved,
          reorderLevel: stockItems.reorderLevel,
        })
        .from(stockItems)
        .innerJoin(stockBalances, eq(stockBalances.stockItemId, stockItems.id))
        .where(and(
          sql`${stockBalances.quantityOnHand} - ${stockBalances.quantityReserved} <= coalesce(${stockItems.reorderLevel}, 0)`,
          sql`${stockBalances.quantityOnHand} > 0`,
        ))
        .orderBy(sql`${stockBalances.quantityOnHand} ASC`)
        .limit(20);

      return {
        totals: {
          itemCount: totals[0]?.itemCount ?? 0,
          totalQty: totals[0]?.totalQty ?? "0",
          reservedQty: totals[0]?.reservedQty ?? "0",
        },
        lowStock: lowStock.map((item) => ({
          id: item.id,
          name: item.name,
          sku: item.sku,
          onHand: Number(item.onHand),
          reserved: Number(item.reserved),
          available: Number(item.onHand) - Number(item.reserved),
          reorderPoint: item.reorderLevel ? Number(item.reorderLevel) : null,
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate inventory valuation." };
  }
}

/* ------------------------------------------------------------------ */
/* PROJECT PROFITABILITY                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BATCH 0101. `projects` has no `currency` column either, so
 * `contract_value_minor` is the functional currency by construction. The
 * label below is the assumption made visible; `sumByCurrency` is used even
 * on a single bucket so that the day a currency column arrives, this
 * function produces several labelled figures rather than one wrong one.
 */
export async function getProjectProfitability(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const projectRows = await tx
        .select({
          id: projects.id,
          name: projects.name,
          contractValue: sql<string>`coalesce(contract_value_minor, 0)::text`,
        })
        .from(projects)
        .where(eq(projects.isActive, true))
        .orderBy(desc(projects.name))
        .limit(20);

      const totals = sumByCurrency(
        projectRows.map((p) => ({
          currency: functional.code,
          amountMinor: toMinor(p.contractValue),
        })),
      );

      return {
        currency: functional.code,
        currencyAssumed: true,
        contractValueTotals: totals.map((t) =>
          labelled(t.amountMinor, t.currency, true),
        ),
        projects: projectRows.map((p) => ({
          id: p.id,
          name: p.name,
          status: "active",
          contractValue: labelled(toMinor(p.contractValue), functional.code, true),
          certifiedValue: labelled(0n, functional.code, true),
          purchaseValue: labelled(0n, functional.code, true),
          margin: labelled(0n, functional.code, true),
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate project profitability." };
  }
}
