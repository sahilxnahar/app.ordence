/**
 * Ordence — ⭐⭐⭐ RULE 53: WHAT A CREDIT NOTE DOES TO OUTPUT TAX
 * Version: v1.67.0-alpha
 *
 * Pure. `bigint` minor units in, `bigint` minor units out, no clock, no
 * database, no division — so nothing here has to know how many decimal
 * places a currency has. Formatting happens once, at the edge, through
 * `lib/fx/currency.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NOT A SUBTRACTION
 * ══════════════════════════════════════════════════════════════════════
 * `getGstSummary` reported output tax GROSS of credit notes, and said so
 * on the payload (`outputTaxExcludesCreditNotes`). Every workspace that
 * has ever taken a return has been shown a liability that is too high,
 * every month. The obvious fix — subtract the credit notes — is wrong in
 * four separate ways, and each one produces a figure that foots:
 *
 *   ① SECTION 34(2) HAS A DEADLINE. A credit note issued after 30
 *      November following the end of the financial year OF THE ORIGINAL
 *      SUPPLY (or the annual return, whichever is earlier) does not
 *      reduce output tax at all. It is a commercial document — the
 *      customer may still be paid — but the tax stays. Subtracting it
 *      under-declares a return, which is the expensive direction.
 *
 *   ② THE PERIOD IS THE NOTE'S, NOT THE INVOICE'S. A note issued in
 *      August against a June invoice reduces AUGUST. Netting it back to
 *      June restates a return that has already been filed.
 *
 *   ③ THE HEADS ARE DIFFERENT LIABILITIES TO DIFFERENT GOVERNMENTS.
 *      CGST reduces CGST, SGST reduces SGST, IGST reduces IGST. An
 *      intra-state credit note applied against an inter-state month
 *      would net a Union liability against a State one and show a total
 *      that is right while both halves are wrong.
 *
 *   ④ THE NET CAN BE NEGATIVE, AND THAT IS REAL. A month with more
 *      returns than sales has a negative outward-tax movement. It is NOT
 *      zero. Clamping it to zero silently throws away a reduction the
 *      taxpayer is entitled to carry into the next period — see
 *      `netCreditNotes` below, which reports the signed net AND the
 *      carry, and never the clamp on its own.
 *
 * ⚠️ `server/returns/assemble.ts:151` DOES CLAMP — `gross > 0n ? gross :
 * 0n` on the ledger movement. That is the GSTR-3B path and is out of
 * this batch's scope; it is named in the batch report. The two answers
 * differ exactly in a month where returns exceed sales.
 */

import { ZERO_HEADS, addHeads, totalOf, type Head, type HeadAmounts } from "@/lib/gst/gstr3b";

export { ZERO_HEADS, addHeads, totalOf };
export type { Head, HeadAmounts };

/** The four heads, in a fixed order, so a loop over them is exhaustive. */
export const GST_HEADS: readonly Head[] = Object.freeze(["igst", "cgst", "sgst", "cess"]);

/* ------------------------------------------------------------------ */
/* THE FINANCIAL YEAR, AND THE DEADLINE THAT HANGS OFF IT              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE INDIAN FINANCIAL YEAR OF A DATE. 1 April to 31 March.
 *
 * ⚠️ DERIVED FROM THE DATE, NOT READ FROM `financial_year`. The column
 * on `sales_invoices` is the year the NUMBER SERIES belongs to, which is
 * the same thing in every normal case and is not the same thing for a
 * document raised late against an earlier year. Section 34(2) counts
 * from the supply, so the supply's date is what decides it.
 */
export function financialYearOf(isoDate: string): {
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
} {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  return {
    label: `${startYear}-${String(endYear % 100).padStart(2, "0")}`,
    startsOn: `${startYear}-04-01`,
    endsOn: `${endYear}-03-31`,
  };
}

/**
 * ⭐ THE SECTION 34(2) LONG STOP for a supply made on `supplyDate`.
 *
 * "…not later than the thirtieth day of November following the end of
 * the financial year in which such supply was made, or the date of
 * furnishing of the relevant annual return, whichever is earlier."
 *
 * ⚠️ THE ANNUAL-RETURN LIMB IS A PARAMETER AND IS NORMALLY ABSENT, AND
 * THAT IS A STATED GAP RATHER THAN A SIMPLIFICATION. `gst_returns` can
 * hold a `return_type` of GSTR9 with a `filed_at`, but nothing in this
 * codebase writes one, so no caller can supply the date. The window this
 * function returns is therefore the LATEST lawful one: a taxpayer who
 * filed their annual return in September has a shorter window than this,
 * and Ordence has no way to know it. Named in the batch report.
 */
export function section34Deadline(
  supplyDate: string,
  annualReturnFiledOn?: string | null,
): string {
  const fy = financialYearOf(supplyDate);
  const longStop = `${Number(fy.endsOn.slice(0, 4))}-11-30`;
  if (!annualReturnFiledOn) return longStop;
  // ISO dates compare correctly as strings; both are `YYYY-MM-DD`.
  return annualReturnFiledOn < longStop ? annualReturnFiledOn : longStop;
}

export type CreditNoteEffect = {
  /** ⭐ Whether this note reduces OUTPUT TAX. Not whether it is valid. */
  readonly reducesOutputTax: boolean;
  readonly reason: "within_window" | "time_barred" | "supply_date_unknown";
  /** Null only when the supply date is unknown, so no window can be drawn. */
  readonly deadline: string | null;
};

/**
 * 🔴 DOES THIS CREDIT NOTE REDUCE THE LIABILITY, OR ONLY THE DEBT?
 *
 * ⚠️ THREE ANSWERS, NOT TWO. A note whose original supply date is not
 * known is NOT treated as time-barred: refusing the reduction on missing
 * data would overstate the liability of a workspace whose only fault is
 * a credit note raised against an invoice from before it started using
 * Ordence. It reduces, and it is flagged, and a human decides.
 *
 * ⚠️ `loadGstr1Documents` LEAVES `againstInvoiceDate` NULL WHENEVER THE
 * ORIGINAL INVOICE FALLS OUTSIDE THE PERIOD BEING BUILT
 * (`server/invoicing/documents.ts:402`), which is the common case for a
 * credit note. So `supply_date_unknown` is the answer the GSTR-1 path
 * gets most of the time today. Named in the batch report.
 */
export function creditNoteEffect(args: {
  readonly noteDate: string;
  readonly supplyDate: string | null;
  readonly annualReturnFiledOn?: string | null;
}): CreditNoteEffect {
  if (!args.supplyDate) {
    return { reducesOutputTax: true, reason: "supply_date_unknown", deadline: null };
  }
  const deadline = section34Deadline(args.supplyDate, args.annualReturnFiledOn);
  return args.noteDate <= deadline
    ? { reducesOutputTax: true, reason: "within_window", deadline }
    : { reducesOutputTax: false, reason: "time_barred", deadline };
}

/* ------------------------------------------------------------------ */
/* THE TAX PERIOD                                                      */
/* ------------------------------------------------------------------ */

/**
 * `YYYY-MM-DD` or an ISO timestamp → the `YYYY-MM` tax period.
 *
 * ⚠️ THE STRING IS TAKEN AS IT ARRIVES AND IS NEVER PUT THROUGH `Date`.
 * A `Date` would apply the server's zone to a date that has none, and
 * move every document raised in the first five and a half hours of an
 * Indian month into the previous return.
 */
export function taxPeriodOf(isoDateOrTimestamp: string): string {
  return isoDateOrTimestamp.slice(0, 7);
}

/* ------------------------------------------------------------------ */
/* THE NETTING                                                         */
/* ------------------------------------------------------------------ */

export type PeriodMovement = {
  /** `YYYY-MM`. */
  readonly period: string;
  readonly heads: HeadAmounts;
  readonly taxableValueMinor: bigint;
};

export type NettedPeriod = {
  readonly period: string;
  /** Output tax on outward supplies declared in this period. */
  readonly gross: HeadAmounts;
  /** Reductions declared in this period that HAVE tax effect. */
  readonly reductions: HeadAmounts;
  /**
   * 🔴 SIGNED AND UNCLAMPED. Negative means this period's credit notes
   * exceeded its supplies, which is a fact and not an error.
   */
  readonly net: HeadAmounts;
  /** Reduction brought in from earlier periods, as a positive amount. */
  readonly carriedIn: HeadAmounts;
  /** ⭐ What is actually payable for this period. Never negative. */
  readonly liability: HeadAmounts;
  /** Unutilised reduction leaving this period, as a positive amount. */
  readonly carriedOut: HeadAmounts;
  readonly grossTaxableValueMinor: bigint;
  readonly reductionTaxableValueMinor: bigint;
  readonly netTaxableValueMinor: bigint;
};

export type Netting = {
  readonly periods: readonly NettedPeriod[];
  /** Sum of the signed nets. Can be negative. */
  readonly net: HeadAmounts;
  /** Sum of what was payable period by period. Never negative. */
  readonly liability: HeadAmounts;
  /**
   * ⭐ WHAT IS STILL CARRYING AT THE END OF THE LAST PERIOD. A reduction
   * the taxpayer has not yet been able to use.
   *
   * ⚠️ THE INVARIANT THAT MAKES THIS CHECKABLE:
   *     liability = net + carriedForward, head by head.
   * If that ever fails, a reduction has been created or destroyed.
   */
  readonly carriedForward: HeadAmounts;
  /** True where any period's signed net went below zero on any head. */
  readonly hasNegativePeriod: boolean;
};

function subtractHeads(a: HeadAmounts, b: HeadAmounts): HeadAmounts {
  return {
    igst: a.igst - b.igst,
    cgst: a.cgst - b.cgst,
    sgst: a.sgst - b.sgst,
    cess: a.cess - b.cess,
  };
}

function byPeriod(movements: readonly PeriodMovement[]): Map<string, PeriodMovement> {
  const out = new Map<string, PeriodMovement>();
  for (const m of movements) {
    const seen = out.get(m.period);
    out.set(
      m.period,
      seen
        ? {
            period: m.period,
            heads: addHeads(seen.heads, m.heads),
            taxableValueMinor: seen.taxableValueMinor + m.taxableValueMinor,
          }
        : m,
    );
  }
  return out;
}

/**
 * ⭐⭐ NET SUPPLIES AGAINST REDUCTIONS, HEAD BY HEAD, PERIOD BY PERIOD.
 *
 * Both arguments are movements ALREADY ASSIGNED to the period they are
 * declared in — this function does not know what a credit note is and
 * cannot put one in the wrong month. Section 34(2) is applied by the
 * caller, which drops a time-barred note from `reductions` entirely.
 *
 * ⚠️ WHAT HAPPENS WHEN REDUCTIONS EXCEED SUPPLIES, STATED ONCE:
 *   • `net` keeps the negative. It is reported, never clamped.
 *   • `liability` for that period is zero, because a negative liability
 *     is not a refund — there is no such thing as the Government owing
 *     output tax back on a credit note.
 *   • The excess becomes `carriedOut` and reduces the NEXT period with
 *     any liability on the SAME head. It is not lost and it does not
 *     migrate to another head.
 *   • Anything still carrying after the last period is `carriedForward`,
 *     which is the honest answer: the workspace has a reduction it has
 *     not yet been able to use, and no month in this data set can absorb
 *     it.
 */
export function netCreditNotes(args: {
  readonly supplies: readonly PeriodMovement[];
  readonly reductions: readonly PeriodMovement[];
}): Netting {
  const supplies = byPeriod(args.supplies);
  const reductions = byPeriod(args.reductions);

  const periodKeys = [...new Set([...supplies.keys(), ...reductions.keys()])].sort();

  const periods: NettedPeriod[] = [];
  let carry: HeadAmounts = ZERO_HEADS;
  let netTotal: HeadAmounts = ZERO_HEADS;
  let liabilityTotal: HeadAmounts = ZERO_HEADS;
  let hasNegativePeriod = false;

  for (const period of periodKeys) {
    const gross = supplies.get(period)?.heads ?? ZERO_HEADS;
    const reduction = reductions.get(period)?.heads ?? ZERO_HEADS;
    const net = subtractHeads(gross, reduction);

    const carriedIn = carry;
    const liability: Record<Head, bigint> = { igst: 0n, cgst: 0n, sgst: 0n, cess: 0n };
    const carriedOut: Record<Head, bigint> = { igst: 0n, cgst: 0n, sgst: 0n, cess: 0n };

    for (const head of GST_HEADS) {
      if (net[head] < 0n) hasNegativePeriod = true;
      // ⚠️ HEAD BY HEAD. A CGST excess never pays an IGST liability here;
      // that is a set-off under s.49 and it belongs to the 3B, not to an
      // outward-supply summary.
      const available = net[head] - carriedIn[head];
      liability[head] = available > 0n ? available : 0n;
      carriedOut[head] = available < 0n ? -available : 0n;
    }

    const grossValue = supplies.get(period)?.taxableValueMinor ?? 0n;
    const reductionValue = reductions.get(period)?.taxableValueMinor ?? 0n;

    periods.push({
      period,
      gross,
      reductions: reduction,
      net,
      carriedIn,
      liability,
      carriedOut,
      grossTaxableValueMinor: grossValue,
      reductionTaxableValueMinor: reductionValue,
      netTaxableValueMinor: grossValue - reductionValue,
    });

    netTotal = addHeads(netTotal, net);
    liabilityTotal = addHeads(liabilityTotal, liability);
    carry = carriedOut;
  }

  return {
    periods,
    net: netTotal,
    liability: liabilityTotal,
    carriedForward: carry,
    hasNegativePeriod,
  };
}
