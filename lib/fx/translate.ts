/**
 * Ordence — ⭐⭐⭐ TRANSLATING A DOCUMENT, NOT A NUMBER
 * Batch 0101 · Multi-currency and FX
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PROBLEM A PER-LINE CONVERSION CREATES
 * ══════════════════════════════════════════════════════════════════════
 * A tax invoice is not one number. It is a taxable value, four tax
 * components, a round-off and a total, and the seventh is the sum of the
 * first six BY CONSTRUCTION — `sales_invoices_total_adds_up` is a CHECK
 * constraint and `assertBalances` in `lib/accounting/sales-posting.ts`
 * refuses a journal where it does not hold.
 *
 * ⚠️ CONVERTING EACH COMPONENT INDEPENDENTLY BREAKS THAT. Six roundings
 * do not add up to the seventh rounding. USD 1,234.56 taxable plus USD
 * 222.22 IGST at 83.215 converts to ₹1,02,724.60 and ₹18,494.03; their
 * sum is ₹1,21,218.63 and the total USD 1,456.78 converts to
 * ₹1,21,218.62. One paisa, every time, on a journal that then refuses to
 * post — or worse, on an invoice whose CHECK constraint refuses the write
 * and whose failure the user sees as "something went wrong".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE RULE: THE TOTAL IS TRANSLATED, THE RESIDUAL GOES TO ROUND-OFF
 * ══════════════════════════════════════════════════════════════════════
 * Every component is translated at the one rate. The TOTAL is translated
 * at the same rate, independently. The round-off is then whatever makes
 * the six add to the seventh.
 *
 * ⭐ WHY THE ROUND-OFF AND NOT THE REVENUE. The round-off line already
 * exists for exactly this purpose — it is the balancing paise, it already
 * has a mapped ledger in every chart of accounts this product installs,
 * and it is an indirect expense that nobody's turnover or tax liability
 * is measured from. Absorbing the residual into revenue would move
 * turnover by a paisa; absorbing it into a tax component would move a
 * figure that goes on a statutory return.
 *
 * 🔴 AND THE RESIDUAL IS BOUNDED. Six roundings of at most half a minor
 * unit each, against one rounding of at most half a minor unit, so the
 * difference cannot exceed 4 minor units and in practice is 0 or 1.
 * `translationResidualBoundMinor` states it and the test asserts it.
 *
 * ⚠️ PURE.
 */

import { convertMinor, type FxConversion, type RoundingMode, type StalenessPolicy } from "./convert";
import type { FxQuote } from "./rates";

/** The seven figures of a tax document, in minor units of one currency. */
export type TaxTotals = {
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  roundOffMinor: bigint;
  totalMinor: bigint;
};

export type TranslatedTotals = {
  readonly totals: TaxTotals;
  readonly currency: string;
  readonly conversion: FxConversion;
  /**
   * ⭐ HOW MUCH WAS PUSHED INTO ROUND-OFF TO MAKE THE SIX ADD TO THE
   * SEVENTH, over and above the translated round-off itself. Reported so
   * that a reviewer can see it is a paisa and not a rupee.
   */
  readonly residualMinor: bigint;
};

/** See the header: six roundings against one, so at most four minor units. */
export const TRANSLATION_RESIDUAL_BOUND_MINOR = 4n;

/**
 * ⭐⭐⭐ TRANSLATE A TAX DOCUMENT AT ONE RATE ON ONE DATE.
 *
 * ⚠️ `on` AND `quote` ARE BOTH REQUIRED, as everywhere in `lib/fx`.
 * AS 11 ¶9 measures the transaction at the rate at the DATE OF THE
 * TRANSACTION, which for an invoice is its invoice date and not the day
 * somebody pressed Issue.
 */
export function translateTaxTotals(args: {
  totals: TaxTotals;
  from: string;
  to: string;
  quote: FxQuote;
  on: string;
  policy?: StalenessPolicy;
  rounding?: RoundingMode;
}): TranslatedTotals {
  const convert = (amountMinor: bigint): bigint =>
    convertMinor({
      amountMinor,
      from: args.from,
      to: args.to,
      quote: args.quote,
      on: args.on,
      policy: args.policy,
      rounding: args.rounding,
    }).amountMinor;

  // The total is the anchor: it is what the customer owes and what the
  // receivable is debited with.
  const totalConversion = convertMinor({
    amountMinor: args.totals.totalMinor,
    from: args.from,
    to: args.to,
    quote: args.quote,
    on: args.on,
    policy: args.policy,
    rounding: args.rounding,
  });

  const taxableValueMinor = convert(args.totals.taxableValueMinor);
  const cgstMinor = convert(args.totals.cgstMinor);
  const sgstMinor = convert(args.totals.sgstMinor);
  const igstMinor = convert(args.totals.igstMinor);
  const cessMinor = convert(args.totals.cessMinor);
  const translatedRoundOff = convert(args.totals.roundOffMinor);

  const componentsWithoutRoundOff =
    taxableValueMinor + cgstMinor + sgstMinor + igstMinor + cessMinor;

  /**
   * 🔴 THE ROUND-OFF IS DERIVED, NOT TRANSLATED. Whatever it takes for the
   * six to equal the seventh. `residualMinor` is how far that is from the
   * translated round-off, i.e. the arithmetic this function absorbed.
   */
  const roundOffMinor = totalConversion.amountMinor - componentsWithoutRoundOff;

  return {
    totals: {
      taxableValueMinor,
      cgstMinor,
      sgstMinor,
      igstMinor,
      cessMinor,
      roundOffMinor,
      totalMinor: totalConversion.amountMinor,
    },
    currency: totalConversion.currency,
    conversion: totalConversion,
    residualMinor: roundOffMinor - translatedRoundOff,
  };
}

/**
 * ⭐ THE INVARIANT, AS A FUNCTION, SO NOBODY HAS TO REMEMBER IT.
 * True for the input and true for the output of `translateTaxTotals`.
 */
export function totalsAddUp(t: TaxTotals): boolean {
  return (
    t.taxableValueMinor + t.cgstMinor + t.sgstMinor + t.igstMinor + t.cessMinor + t.roundOffMinor ===
    t.totalMinor
  );
}
