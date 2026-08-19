/**
 * Ordence — ⭐⭐⭐ A CONVERSION A STATUTE NAMES THE RATE FOR
 * Batch 0106 · Rule 26 and the s.195 chargeable base
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FAILURE THIS FILE EXISTS TO END
 * ══════════════════════════════════════════════════════════════════════
 * `lib/fx/convert.ts` will convert at whatever quote it is handed. That
 * is right for accounting — AS 11 ¶9 asks for "the exchange rate at the
 * date of the transaction" and does not care which side of a bank's
 * spread it came from — and it is wrong for tax, because a tax rule names
 * a specific number:
 *
 *   ⭐ RULE 26, INCOME-TAX RULES 1962. "For the purpose of deduction of
 *      tax at source on any income payable in foreign currency, the rate
 *      of exchange for the calculation of the value in rupees of such
 *      income shall be the TELEGRAPHIC TRANSFER BUYING RATE of such
 *      currency AS ON THE DATE ON WHICH THE TAX IS REQUIRED TO BE
 *      DEDUCTED."
 *
 * Three things are named and all three are enforced below: the SIDE OF
 * THE SPREAD (TT buying, not mid, not TT selling), the DATE (the date the
 * tax is required to be deducted, which is neither the invoice date nor
 * automatically the payment date), and by implication the DIRECTION (the
 * TT buying rate OF THE FOREIGN CURRENCY, published as rupees per unit).
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE POLICY: A STATUTORY CALLER ASKS BY NAME AND IS REFUSED, NEVER
 *     SERVED SOMETHING ELSE
 * ══════════════════════════════════════════════════════════════════════
 * The shape is `requireQuote`'s, deliberately, because that shape is
 * already proven here: when no rate exists for the date, it throws and
 * names the pair and the day rather than reaching for a neighbouring one.
 * This file does the same for the side of the spread. There is no
 * fallback, no "nearest available", and no widening — a mid rate silently
 * substituted for a TT buying rate produces a chargeable base that is
 * wrong by the half-spread and a deduction nobody can reproduce, and
 * s.201(1) makes the deductor personally liable for the shortfall.
 *
 * ⚠️ PURE. No database, no clock, no `server-only`. The database half is
 * `server/fx/rate-service.ts#requireStatutoryQuote`.
 */

import {
  convertMinor,
  EXACT_DATE,
  type FxConversion,
  type RoundingMode,
} from "./convert";
import {
  FxRateError,
  describeQuote,
  describeRateType,
  type FxQuote,
  type StorableFxRateType,
} from "./rates";

/**
 * ⭐ A CONVERSION SOME LAW NAMES THE RATE FOR, AND THE PLACE IT SAYS SO.
 *
 * ⚠️ `statutoryRef` IS NOT DECORATION. It is what a refusal quotes and
 * what the deduction row records, so "why is this figure ₹83,60,000 and
 * not ₹83,21,500" has an answer that is a rule number rather than a
 * developer's recollection.
 */
export type StatutoryConversion = {
  /** Stable identifier, stored on rows and asserted by tests. */
  readonly id: string;
  /** The rate type the statute names. Nothing else may be served. */
  readonly rateType: StorableFxRateType;
  /** "Rule 26, Income-tax Rules 1962". */
  readonly statutoryRef: string;
  /** What the date argument has to be, in the statute's own words. */
  readonly dateMeans: string;
  /**
   * ⭐ TDS ARITHMETIC IN THIS CODEBASE IS HALF-UP AND THIS FOLLOWS IT.
   * `lib/billing/money.ts#applyRateBps` adds 5000 before dividing by
   * 10000, which is half-up on an exact integer, and every TDS figure in
   * the product comes through it. The FX house default is `half_even`,
   * which is right for a revaluation of four hundred receivables — a long
   * series where half-up drifts one way — and wrong here, because a
   * chargeable base is computed once per payment and has to agree, to the
   * paisa, with the rest of the deduction it sits inside.
   */
  readonly rounding: RoundingMode;
};

/**
 * ⭐⭐ RULE 26. The only statutory conversion this codebase implements,
 * and it is registered rather than hardcoded at the call site so that a
 * second one — Rule 115 for the assessee's own income, s.43A for a
 * capital asset — is added here where the first one can be seen.
 */
export const RULE_26_TT_BUYING: StatutoryConversion = {
  id: "rule_26_tds_tt_buying",
  rateType: "tt_buying",
  statutoryRef: "Rule 26, Income-tax Rules 1962",
  dateMeans:
    "the date on which the tax is required to be deducted — the earlier of the credit of " +
    "the sum to the payee's account and its payment, which is neither the invoice date nor " +
    "automatically the date the money left the bank",
  rounding: "half_up",
};

export const STATUTORY_CONVERSIONS = [RULE_26_TT_BUYING] as const;

/** Thrown when a statutory conversion cannot be made. Never caught into a default. */
export class StatutoryRateError extends FxRateError {
  readonly conversionId: string;
  readonly requiredRateType: StorableFxRateType;
  readonly requiredOn: string;
  readonly pair: string;

  constructor(args: {
    conversion: StatutoryConversion;
    on: string;
    pair: string;
    message: string;
  }) {
    super(args.message);
    this.name = "StatutoryRateError";
    this.conversionId = args.conversion.id;
    this.requiredRateType = args.conversion.rateType;
    this.requiredOn = args.on;
    this.pair = args.pair;
  }
}

/**
 * ⭐⭐⭐ THE GATE. Four questions, all four refusable, none of them
 * answerable by substitution.
 *
 * ① IS IT THE RATE TYPE THE STATUTE NAMES? A mid rate is refused here,
 *    and it is refused by NAME rather than by being quietly not found, so
 *    the operator is told that the rate on file is the wrong one rather
 *    than that no rate exists.
 * ② IS IT FOR THE RIGHT DAY? Rule 26 fixes the date; there is no
 *    staleness policy on this path at all, because a statute that names a
 *    date does not have a long-weekend accommodation.
 * ③ WAS IT PUBLISHED, OR DID WE COMPUTE IT? An inverted rate is arithmetic
 *    on somebody else's number and is not the published TT buying rate.
 * ④ IS IT IN THE DIRECTION THE STATUTE ASSUMES? The TT buying rate OF a
 *    foreign currency is quoted as rupees per unit of it. A quote running
 *    the other way would have to be inverted, which ③ already refuses.
 */
export function assertStatutoryQuote(args: {
  quote: FxQuote;
  conversion: StatutoryConversion;
  /** The date the statute names. */
  on: string;
  from: string;
  to: string;
}): void {
  const { quote, conversion } = args;
  const pair = `${args.from}/${args.to}`;
  const fail = (message: string): never => {
    throw new StatutoryRateError({ conversion, on: args.on, pair, message });
  };

  // ① The side of the spread.
  if (quote.rateType !== conversion.rateType) {
    fail(
      `${conversion.statutoryRef} requires the ${describeRateType(conversion.rateType)} for ` +
        `${pair} on ${args.on}, and the rate on file is a ${describeRateType(quote.rateType)} ` +
        `(${describeQuote(quote)}). Nothing has been converted and no tax has been computed. ` +
        `These are different numbers — the spread between the buying and selling sides of a ` +
        `currency is routinely half a rupee on the dollar — so translating at the wrong one ` +
        `changes the chargeable base and therefore the tax. A short deduction makes the ` +
        `deductor personally liable under s.201(1) for the whole shortfall plus interest ` +
        `under s.201(1A). Enter the ${describeRateType(conversion.rateType)} for ${pair} on ` +
        `${args.on}.`,
    );
  }

  // ③ Published, not computed. Checked before the date so the message is the useful one.
  if (quote.derived) {
    fail(
      `${conversion.statutoryRef} requires a published ${describeRateType(conversion.rateType)} ` +
        `for ${pair} on ${args.on}, and the only rate on file for that day runs the other way ` +
        `round and would have to be inverted (${describeQuote(quote)}). Nothing has been ` +
        `converted. The buying side of one direction is the selling side of the other and the ` +
        `two are not reciprocals, so the inverse of a rate is not the rate the rule names. ` +
        `Enter the ${describeRateType(conversion.rateType)} quoted as ${args.to} per one ` +
        `${args.from}.`,
    );
  }

  // ② The day itself. No window, no policy, no reaching back.
  if (quote.rateDate !== args.on) {
    fail(
      `${conversion.statutoryRef} fixes the rate at ${args.on} — ${conversion.dateMeans} — and ` +
        `the ${describeRateType(conversion.rateType)} on file is for ${quote.rateDate}. Nothing ` +
        `has been converted. A neighbouring day's rate is an approximation the Income-tax ` +
        `Rules do not offer, unlike Ind AS 21 ¶22 which does. Enter the ` +
        `${describeRateType(conversion.rateType)} for ${pair} on ${args.on}.`,
    );
  }

  // ④ Direction, restated as an assertion rather than assumed.
  if (quote.baseCurrency !== args.from || quote.quoteCurrency !== args.to) {
    fail(
      `${describeQuote(quote)} is not a ${pair} rate and cannot measure a ${args.from} payment ` +
        `in ${args.to}. Nothing has been converted.`,
    );
  }
}

/**
 * ⭐⭐ CONVERT UNDER A STATUTE, OR REFUSE.
 *
 * ⚠️ THE ONLY WAY TO GET A RUPEE FIGURE FOR A TAX RULE IN THIS CODEBASE.
 * `convertMinor` is still available and still correct for accounting; a
 * tax caller reaching for it directly would be reaching past the gate,
 * which is why the s.195 base is computed here and nowhere else.
 */
export function convertUnderStatute(args: {
  amountMinor: bigint;
  from: string;
  to: string;
  quote: FxQuote;
  on: string;
  conversion: StatutoryConversion;
}): FxConversion {
  assertStatutoryQuote({
    quote: args.quote,
    conversion: args.conversion,
    on: args.on,
    from: args.from,
    to: args.to,
  });
  return convertMinor({
    amountMinor: args.amountMinor,
    from: args.from,
    to: args.to,
    quote: args.quote,
    on: args.on,
    // ⚠️ EXACT, ALWAYS. `assertStatutoryQuote` has already refused any
    // other day; passing the policy explicitly means a later edit to the
    // default cannot loosen a statutory conversion by accident.
    policy: EXACT_DATE,
    rounding: args.conversion.rounding,
  });
}
