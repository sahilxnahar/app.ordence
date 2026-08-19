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

/* ================================================================== */
/* ⭐⭐ THE PAYABLES SIDE — over `0101`'s columns                        */
/* ================================================================== */

/**
 * The four input-tax heads of a purchase document, in minor units.
 *
 * ⚠️ THE TAXABLE VALUE IS NOT HERE ON PURPOSE. Section 17(5) blocks a
 * CREDIT, not an expense: the taxable value is cost whether the credit is
 * eligible or blocked, so it is never split. Only the four tax heads are.
 */
export type ItcTaxHeads = {
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
};

export type TranslatedPurchaseDocument = {
  /** The seven header figures, functional currency, still adding up. */
  readonly totals: TaxTotals;
  /** Input tax that MAY be claimed — an asset. Functional currency. */
  readonly eligibleTax: ItcTaxHeads;
  /** Input tax blocked by Section 17(5) — cost. Functional currency. */
  readonly blockedTax: ItcTaxHeads;
  /** Reverse-charge tax, functional currency. Its own transaction. */
  readonly rcmTaxMinor: bigint;
  readonly currency: string;
  readonly conversion: FxConversion;
  readonly residualMinor: bigint;
};

/**
 * ⭐ A PART OF AN ALREADY-TRANSLATED FIGURE, WITHOUT RE-CONVERTING IT.
 *
 * 🔴 THE SPLIT IS APPORTIONED, NOT TRANSLATED, AND THAT IS THE WHOLE
 * POINT. Converting the eligible tax and the blocked tax separately is
 * two more roundings that do not have to add back to the head they came
 * from, and the difference lands in a journal that then refuses to
 * balance — the same failure `translateTaxTotals` exists to avoid one
 * level up. Apportioning a figure that has already been translated can
 * only redistribute paise WITHIN it, never create one.
 *
 * ⚠️ ROUNDING, STATED: the magnitude of the part is FLOORED and the
 * remainder stays with the other side. Callers pass the ELIGIBLE part, so
 * the odd paisa lands in blocked tax, which is cost — never in a credit.
 * Overstating an input-tax credit by a paisa is a claim on the Government;
 * overstating an expense by a paisa is not.
 */
export function apportionTranslatedMinor(args: {
  translatedWholeMinor: bigint;
  partMinor: bigint;
  wholeMinor: bigint;
}): bigint {
  if (args.wholeMinor === 0n) return 0n;
  if (args.partMinor === args.wholeMinor) return args.translatedWholeMinor;
  if (args.partMinor === 0n) return 0n;
  const negative = args.translatedWholeMinor < 0n;
  const abs = negative ? -args.translatedWholeMinor : args.translatedWholeMinor;
  const magnitude = (abs * args.partMinor) / args.wholeMinor;
  return negative ? -magnitude : magnitude;
}

/**
 * ⭐⭐⭐ TRANSLATE A VENDOR BILL AT ONE RATE ON ONE DATE.
 *
 * The header goes through `translateTaxTotals` unchanged — same anchor,
 * same residual-into-round-off rule, same bound. What this adds is the
 * one thing the payables posting needs and the receivables posting does
 * not: the split of each translated tax head into the part that is an
 * ASSET (eligible input tax) and the part that is COST (blocked under
 * Section 17(5)), so that
 *
 *     expense + eligible heads + round-off  =  the vendor's credit
 *
 * still holds exactly after translation. `buildPurchasePosting` asserts
 * that, and a per-head reconversion would break it by a paisa.
 *
 * ⚠️ `rcmTaxMinor` IS TRANSLATED AND IS NOT PART OF THE TOTAL. The vendor
 * never charged it, so it is not in `totals` and it credits the
 * Government rather than the vendor — its own balanced transaction, so
 * one conversion serves both its legs.
 *
 * ⚠️ PURE.
 */
export function translatePurchaseDocument(args: {
  totals: TaxTotals;
  /** From the LINES, in the document's own currency. */
  blockedTax: ItcTaxHeads;
  rcmTaxMinor: bigint;
  from: string;
  to: string;
  quote: FxQuote;
  on: string;
  policy?: StalenessPolicy;
  rounding?: RoundingMode;
}): TranslatedPurchaseDocument {
  const header = translateTaxTotals({
    totals: args.totals,
    from: args.from,
    to: args.to,
    quote: args.quote,
    on: args.on,
    policy: args.policy,
    rounding: args.rounding,
  });

  const split = (
    translatedHeadMinor: bigint,
    headMinor: bigint,
    blockedMinor: bigint,
  ): { eligible: bigint; blocked: bigint } => {
    const eligible = apportionTranslatedMinor({
      translatedWholeMinor: translatedHeadMinor,
      partMinor: headMinor - blockedMinor,
      wholeMinor: headMinor,
    });
    return { eligible, blocked: translatedHeadMinor - eligible };
  };

  const cgst = split(header.totals.cgstMinor, args.totals.cgstMinor, args.blockedTax.cgstMinor);
  const sgst = split(header.totals.sgstMinor, args.totals.sgstMinor, args.blockedTax.sgstMinor);
  const igst = split(header.totals.igstMinor, args.totals.igstMinor, args.blockedTax.igstMinor);
  const cess = split(header.totals.cessMinor, args.totals.cessMinor, args.blockedTax.cessMinor);

  const rcmTaxMinor = convertMinor({
    amountMinor: args.rcmTaxMinor,
    from: args.from,
    to: args.to,
    quote: args.quote,
    on: args.on,
    policy: args.policy,
    rounding: args.rounding,
  }).amountMinor;

  return {
    totals: header.totals,
    eligibleTax: {
      cgstMinor: cgst.eligible,
      sgstMinor: sgst.eligible,
      igstMinor: igst.eligible,
      cessMinor: cess.eligible,
    },
    blockedTax: {
      cgstMinor: cgst.blocked,
      sgstMinor: sgst.blocked,
      igstMinor: igst.blocked,
      cessMinor: cess.blocked,
    },
    rcmTaxMinor,
    currency: header.currency,
    conversion: header.conversion,
    residualMinor: header.residualMinor,
  };
}
