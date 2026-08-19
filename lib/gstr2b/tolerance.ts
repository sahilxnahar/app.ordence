/**
 * Ordence — ⭐ Reconciliation Tolerance
 * Version: v0.34.0-alpha
 *
 * Pure. `bigint` paise, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY A TOLERANCE EXISTS AT ALL, WHEN THE LAW HAS NONE
 * ══════════════════════════════════════════════════════════════════════
 * Rule 36(4) used to allow provisional credit of 5%, then 10%, then 5%
 * again, of the credit appearing in 2B. From 1 January 2022 it allows
 * NOTHING: the credit is what 2B shows, to the rupee.
 *
 * So the tolerance here is emphatically NOT a claim tolerance. It does
 * not decide how much credit may be taken. It decides ONE thing:
 *
 *     Are these two records describing the SAME DOCUMENT?
 *
 * And for that question a small difference is expected and means nothing,
 * because the two figures were arrived at by different arithmetic:
 *
 *   • The supplier computes tax per LINE and foots the invoice. We record
 *     tax per line from their document and foot ours. Where a line's tax
 *     lands on a half-paisa, two correct implementations round opposite
 *     ways, and a twelve-line invoice can differ by a few paise.
 *   • The supplier's own accounting package rounds the invoice total to
 *     the rupee (Section 170 of the CGST Act permits it) and files the
 *     rounded figure; we hold the unrounded one.
 *   • An accountant retyping from a PDF drops a paisa.
 *
 * Refusing to match on a two-paisa difference reports the supplier as not
 * having filed AND the invoice as unrecorded — two exceptions, in
 * opposite directions, from one perfectly ordinary invoice. Multiply by a
 * few hundred invoices a month and the worklist is noise.
 *
 * ⚠️ AND THE TOLERANCE NEVER HIDES THE DIFFERENCE. A match inside
 * tolerance is still `probable`, still records the delta in paise, and
 * still requires a human before it is accepted. The tolerance decides
 * whether two rows are ABOUT THE SAME INVOICE; it never decides that the
 * difference does not matter.
 */

/**
 * The bands, in paise and days.
 *
 * ⚠️ ABSOLUTE, NOT PROPORTIONAL, AND THAT IS THE RIGHT SHAPE. Rounding
 * error scales with the NUMBER OF LINES on the document, not with its
 * value — a ₹4 crore single-line steel invoice rounds once, a ₹40,000
 * twenty-line hardware bill rounds twenty times. A percentage tolerance
 * gets this exactly backwards: it is loosest on the largest invoices,
 * which are the ones where a real ₹2,000 discrepancy must be seen.
 */
export type MatchTolerance = {
  /** Taxable value may differ by this much and still be one document. */
  taxableValueMinor: bigint;
  /** Each of CGST/SGST/IGST/cess, individually. */
  headMinor: bigint;
  /** And the four heads together. */
  totalTaxMinor: bigint;
  /**
   * How many days the invoice dates may differ by.
   *
   * ⚠️ ZERO BY DEFAULT, AND IT SHOULD STAY THERE. An invoice date is a
   * printed fact on a document, not a measurement — there is no rounding
   * to absorb. Two records with different dates are either two documents
   * or one document typed wrongly, and both need a person. A tolerance
   * here would silently merge a March invoice with an April one, moving
   * a credit across the Section 16(4) boundary.
   */
  invoiceDateDays: number;
};

/**
 * ₹1 per figure.
 *
 * Chosen because Section 170 of the CGST Act permits rounding to the
 * nearest RUPEE, so a one-rupee difference between two correct records
 * of one invoice is not merely possible but statutory. Anything larger
 * is a real difference somebody must look at.
 */
export const DEFAULT_MATCH_TOLERANCE: MatchTolerance = Object.freeze({
  taxableValueMinor: 100n,
  headMinor: 100n,
  totalTaxMinor: 100n,
  invoiceDateDays: 0,
});

/**
 * A tolerance of nothing. Used when a period is being prepared for filing
 * and the question stops being "is this the same invoice" and becomes "do
 * these agree".
 */
export const STRICT_MATCH_TOLERANCE: MatchTolerance = Object.freeze({
  taxableValueMinor: 0n,
  headMinor: 0n,
  totalTaxMinor: 0n,
  invoiceDateDays: 0,
});

export function absDiff(a: bigint, b: bigint): bigint {
  const d = a - b;
  return d < 0n ? -d : d;
}

export function withinTolerance(a: bigint, b: bigint, toleranceMinor: bigint): boolean {
  return absDiff(a, b) <= toleranceMinor;
}

/**
 * Whole days between two civil days, absolute.
 *
 * ⚠️ `Date.UTC` FROM THE PARTS, NOT `new Date(string)`. Parsing a
 * `YYYY-MM-DD` string with the Date constructor is specified as UTC, but
 * `getDate()` reads it back in the LOCAL zone — so on any machine west of
 * UTC the day comes back one earlier. A reconciliation that shifts every
 * date by a day on a developer's laptop and not on the server is the kind
 * of defect that gets diagnosed as "flaky".
 */
export function civilDaysApart(a: string, b: string): number {
  const left = civilDayToUtcMillis(a);
  const right = civilDayToUtcMillis(b);
  if (left === null || right === null) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((left - right) / 86_400_000));
}

function civilDayToUtcMillis(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
