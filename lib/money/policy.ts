/**
 * Ordence — ⭐⭐ THE ROUNDING POLICY, STATED ONCE, EXECUTABLY
 * Wave 15 / Track E — GST, TDS and statutory correctness
 *
 * Pure. No `server-only`, no `@/db`, no clock. `lib/**` must not import
 * the database, and this file in particular is imported by the invoice
 * renderer, the pricing screen and the server engine alike — a second
 * copy of any of these decisions on one side of that line is how "the
 * page said ₹5,898 and the invoice says ₹5,899" happens.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY A POLICY FILE AND NOT JUST FUNCTIONS
 * ══════════════════════════════════════════════════════════════════════
 * Every rounding decision in this product is already made correctly
 * somewhere: `applyRateBps` is half-up, `computeInvoiceTax` rounds per
 * line, `splitEvenly` splits the rounded total. Each is defended in a
 * comment above the code that does it, and NOWHERE are the four
 * statements written down together.
 *
 * That is a real gap and it has a shape: the next person to add a tax
 * computation — a credit note, a proforma, a purchase bill, a TDS
 * certificate — reads none of those four comments, because they are in
 * four files they are not editing. They write `applyRateBps(totalTaxable,
 * rate)` because it is one line shorter, and the invoice column stops
 * adding to the invoice total by one paisa on roughly one document in
 * eight. Nothing fails. It is found by a buyer's accounts clerk.
 *
 * ⭐ SO `ROUNDING_POLICY` BELOW IS PROSE THAT IS ALSO A VALUE. It can be
 * rendered into the working papers, quoted in a test's failure message,
 * and — the part that matters — read by somebody grepping for "rounding"
 * before they write the fifth computation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE MAY NOT DO: REPLACE `roundOffToRupee`
 * ══════════════════════════════════════════════════════════════════════
 * `lib/gst/tax.ts:349` exports `roundOffToRupee(amountMinor)`, and its
 * body is `amountMinor % 100n` — a HARDCODED 100. That is right for INR
 * and wrong for:
 *
 *   · JPY, KRW, VND, CLP, ISK and the other exponent-0 codes — there is
 *     no minor unit at all, so every amount is already "whole" and the
 *     adjustment must be 0. The hardcoded version instead rounds ¥1,234
 *     to ¥1,200 and books ¥-34 of round-off that does not exist.
 *   · KWD, BHD, OMR, JOD, TND, LYD, IQD (exponent 3) — 1 dinar is 1000
 *     fils, so `% 100n` rounds to a TENTH of a dinar and leaves the
 *     document un-whole in the only unit anybody quotes.
 *   · CLF, UYW (exponent 4) — the same, two digits worse.
 *
 * 🔴 AND YET `roundOffToRupee` STILL EXISTS AND IS STILL CALLED. It is
 * called from exactly one place, `computeInvoiceTax`, in `lib/gst/`,
 * which is NOT Track E's to edit. Changing that call site is a PATCH
 * REQUEST (PATCH-REQUEST-E.md), not something this file may do — a
 * second rounding helper that silently supersedes the first, while the
 * first stays wired up, is two behaviours with one name and is worse
 * than the bug it fixes.
 *
 * What this file does instead: state the currency-aware version, name
 * the INR-only one it is meant to replace, and leave the swap to a diff
 * somebody reviews.
 *
 * ⚠️ AND NOTE THAT IN PRACTICE THE BUG IS LATENT, NOT LIVE.
 * `computeInvoiceTax` only rounds when `roundToRupee: true` is passed,
 * and GST invoices are INR by construction (s.15 values a supply in
 * rupees). The exposure is a foreign-currency sales invoice —
 * `sales_invoices.currency` is a real column with real non-INR rows
 * possible since Batch 0101 — that asks for invoice-level rounding.
 */

import { minorUnitExponent } from "@/lib/fx/currency";

/* ------------------------------------------------------------------ */
/* ⭐ THE POLICY                                                        */
/* ------------------------------------------------------------------ */

export type RoundingRule = {
  /** Short handle, for a test name or a log line. */
  readonly id: string;
  /** What the rule IS, in one sentence. */
  readonly rule: string;
  /** What goes wrong when it is not followed. Never omitted. */
  readonly failureMode: string;
  /** The function or file that already implements it. */
  readonly implementedBy: string;
};

/**
 * ⭐ THE FOUR STATEMENTS. Frozen, so a caller cannot "adjust the policy"
 * at runtime — a mutable policy object is a configuration knob, and a
 * configuration knob on statutory arithmetic is a way for two workspaces
 * to produce different tax on the same figures.
 */
export const ROUNDING_POLICY: readonly RoundingRule[] = Object.freeze([
  Object.freeze({
    id: "per-line-then-summed",
    rule:
      "Tax is computed and rounded PER LINE and the rounded lines are then " +
      "summed. It is never computed as rate × summed taxable value.",
    failureMode:
      "A tax invoice prints a tax figure against each line and a total at the " +
      "foot, and somebody adds the column. Rate-on-the-total makes the column " +
      "disagree with the total by a rupee or two whenever rounding breaks " +
      "differently — on a document that has to be defended, with no " +
      "reconciliation step available because there is nothing legitimate to " +
      "reconcile.",
    implementedBy: "lib/gst/tax.ts computeInvoiceTax()",
  }),
  Object.freeze({
    id: "half-up-away-from-zero",
    rule:
      "Rounding is HALF-UP, away from zero, in exact integer arithmetic. Not " +
      "banker's rounding, and never through a float.",
    failureMode:
      "Banker's rounding is the better choice when errors should cancel across " +
      "a portfolio. A tax invoice is not a portfolio: the statutory method is " +
      "half-up and an auditor recomputing one line by hand will use it. " +
      "Away-from-zero is what makes a credit note of -₹100 at 18% exactly the " +
      "negative of a charge of ₹100 at 18%, so an upgrade followed by a " +
      "downgrade leaves no stray paisa on the account.",
    implementedBy: "lib/billing/money.ts applyRateBps()",
  }),
  Object.freeze({
    id: "split-the-rounded-total",
    rule:
      "CGST and SGST/UTGST are produced by splitting the ROUNDED TOTAL TAX in " +
      "two with `splitEvenly`. The rate is never halved and applied twice.",
    failureMode:
      "Halving the rate and rounding each half separately turns ₹100.01 of tax " +
      "into ₹50.01 + ₹50.01 = ₹100.02. The halves stop adding to the tax " +
      "charged, the `sales_invoice_lines` recompute trigger from SQL 0147 " +
      "refuses the row — correctly — and the fix looks like a database problem. " +
      "Splitting the rounded total is exact by construction and puts the odd " +
      "paisa on CGST, deterministically.",
    implementedBy: "lib/billing/money.ts splitEvenly(), via lib/gst/tax.ts",
  }),
  Object.freeze({
    id: "invoice-rounding-off-by-default",
    rule:
      "Invoice-level rounding to a whole major unit is OFF unless the caller " +
      "asks for it. Section 170 rounds the TAX to the nearest rupee, which is " +
      "a different operation from rounding the invoice total.",
    failureMode:
      "A rounding that appears without being asked for makes the invoice " +
      "disagree with the payment plan by up to 99 paise per instalment, " +
      "forever, and the demand no longer matches the agreement. Many " +
      "developers deliberately do neither rounding for exactly that reason.",
    implementedBy: "lib/gst/tax.ts TaxComputationInput.roundToRupee (default false)",
  }),
]);

/**
 * ⚠️ THE DEFAULT, STATED AS A VALUE RATHER THAN LEFT AS AN ABSENCE.
 * `roundToRupee` being optional-and-falsy is the correct behaviour and it
 * is invisible at a call site that simply omits the field. A caller that
 * wants to be explicit about taking the default can pass this.
 */
export const INVOICE_ROUNDING_DEFAULT = false as const;

/* ------------------------------------------------------------------ */
/* ONE IMPLEMENTATION, RE-EXPORTED                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐ RE-EXPORTED, NOT REIMPLEMENTED, AND THAT IS THE WHOLE POINT OF THE
 * FILE. A second `applyRateBps` that differs from the subscription
 * biller's by one paisa is a discrepancy nobody can explain and everybody
 * can see. `lib/gst/constants.ts` and `lib/gst/tax.ts` already take the
 * same decision for the same reason; this file joins them rather than
 * starting a third lineage.
 */
export { applyRateBps, splitEvenly } from "@/lib/billing/money";

/* ------------------------------------------------------------------ */
/* ⭐ CURRENCY-EXPONENT-AWARE ROUNDING                                  */
/* ------------------------------------------------------------------ */

/**
 * How many minor units make one major unit of `currency`.
 *
 * ⚠️ THE EXPONENT TABLE IS NOT RESTATED HERE. It lives in
 * `lib/fx/currency.ts`, is complete for the active ISO-4217 codes, and
 * REFUSES a code it does not know instead of defaulting to two decimals.
 * A local `const ZERO_DECIMAL = new Set([...])` is precisely the shortcut
 * Batch 0101 removed from `lib/billing/money.ts`, where it had been wrong
 * by a factor of ten for the Gulf dinars since the file was written.
 *
 * ⚠️ THROWS `UnknownCurrencyError` on a code it does not know. That
 * propagates deliberately: rounding an amount whose number of decimal
 * places is a guess produces a figure that still looks like money.
 */
export function minorUnitsPerMajor(currency: string): bigint {
  return 10n ** BigInt(minorUnitExponent(currency));
}

/**
 * ⭐ THE ADJUSTMENT THAT TAKES AN AMOUNT TO A WHOLE MAJOR UNIT OF ITS OWN
 * CURRENCY — the currency-aware replacement for
 * `lib/gst/tax.ts:349 roundOffToRupee`, which hardcodes `100n`.
 *
 * Returns the DELTA, not the rounded amount: the round-off is a line on
 * the document (`sales_invoices.round_off_minor`) and must be recorded as
 * its own figure, not folded silently into the total. Add it to get the
 * payable amount.
 *
 * ⭐ EXPONENT 0 RETURNS 0n, AND THAT IS THE CASE THE HARDCODED VERSION
 * GETS WRONG MOST LOUDLY. In JPY the stored minor unit IS the yen; every
 * amount is already whole and there is nothing to adjust. `% 100n` would
 * instead round ¥1,234 down to ¥1,200 and book ¥34 of round-off against a
 * currency that has no sub-unit to round.
 *
 * Half-up on the exact half, which is what a person recomputing the
 * round-off line by hand will do.
 *
 * ⚠️⚠️ AND ON THE EXACT HALF IT ROUNDS **UP**, NOT AWAY FROM ZERO — SO
 * IT DISAGREES WITH `applyRateBps` ON NEGATIVE AMOUNTS. −₹1.50 becomes
 * −₹1.00 here, and `applyRateBps` would have gone to −₹2.00.
 *
 * 🔴 THAT ASYMMETRY IS INHERITED ON PURPOSE. `roundOffToRupee` behaves
 * exactly this way, and this function exists to replace it. A replacement
 * that ALSO changed the tie-breaking on negatives would be two changes in
 * one patch, one of them invisible: the exponent fix would be reviewed
 * and the tie-break would ride along, and the first person to notice
 * would be looking at a credit note that no longer negates its invoice.
 * The exponent is the defect; the tie-break is a separate decision and
 * belongs in a separate diff. It is listed in PATCH-REQUEST-E.md.
 *
 * ⚠️ In practice the exposure is small: `sales_invoices_amounts_non_negative`
 * refuses a negative total, and a credit note is its own positive
 * document. The half-exactly case on a negative amount is reachable
 * through the pure functions and not through a stored sales document.
 */
export function roundOffToUnit(amountMinor: bigint, currency: string): bigint {
  const scale = minorUnitsPerMajor(currency);

  // ⚠️ NOT A SPECIAL CASE BOLTED ON. With an exponent of 0 the scale is
  // 1n, every remainder is 0n, and the general path below already returns
  // 0n. It is written out because `10n ** 0n === 1n` is a step readers
  // check twice, and because the answer for JPY is the single most
  // important thing this function does differently from the one it
  // replaces.
  if (scale === 1n) return 0n;

  const remainder = ((amountMinor % scale) + scale) % scale;
  if (remainder === 0n) return 0n;

  // `remainder * 2n >= scale` rather than `remainder >= scale / 2n`:
  // integer division of an odd scale would truncate the half and shift
  // the tie. No active ISO-4217 scale is odd, but the expression that is
  // right for every scale costs nothing.
  return remainder * 2n >= scale ? scale - remainder : -remainder;
}

/**
 * The rounded amount itself, for the caller that wants it directly.
 * `amountMinor + roundOffToUnit(amountMinor, currency)`, named so that
 * nobody has to remember which way the delta points.
 */
export function roundToWholeUnit(amountMinor: bigint, currency: string): bigint {
  return amountMinor + roundOffToUnit(amountMinor, currency);
}
