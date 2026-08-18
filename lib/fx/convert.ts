/**
 * Ordence — ⭐⭐⭐ THE CONVERSION. MINOR UNITS IN, MINOR UNITS OUT.
 * Batch 0101 · Multi-currency and FX
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FOUR RULES THIS FILE ENFORCES BY ITS SIGNATURE
 * ══════════════════════════════════════════════════════════════════════
 * ① IT CANNOT BE CALLED WITHOUT A RATE DATE. `on` is a required argument
 *    and it is checked against the quote's own date. There is no "latest"
 *    overload, no optional date, no default. The most common FX error in
 *    accounting software is not a wrong rate, it is yesterday's right one.
 *
 * ② IT NEVER DIVIDES BY 100. The exponent comes from
 *    `lib/fx/currency.ts` per currency, on BOTH sides. JPY has none and
 *    KWD has three; a routine that hardcodes hundredths is wrong the first
 *    time somebody invoices in yen and wrong by a factor of ten the first
 *    time somebody invoices in dinars.
 *
 * ③ IT DIVIDES ONCE. The whole calculation is one fraction evaluated in
 *    `bigint`, so there is exactly one rounding event and it happens at
 *    the end. Rounding the rate, then multiplying, then rescaling
 *    accumulates three errors and none of them is visible.
 *
 * ④ IT IS SIGN-SYMMETRIC. BigInt division truncates toward zero, so a
 *    naive implementation rounds a credit note differently from the
 *    invoice it mirrors and the pair no longer nets to zero. Every
 *    division below runs on the magnitude with the sign reapplied after.
 *
 * ⚠️ PURE. No database, no clock, no `server-only`.
 */

import { minorUnitExponent, normaliseCurrencyCode } from "./currency";
import {
  FxRateError,
  RATE_SCALE,
  describeQuote,
  identityQuote,
  orientQuote,
  type FxQuote,
} from "./rates";

/**
 * ⭐ ROUNDING IS STATED, NOT ASSUMED.
 *
 *   `half_even` — banker's rounding, the default. A half lands on the even
 *                 minor unit, so a long series of conversions has no
 *                 systematic bias in either direction. This is what a
 *                 revaluation of a portfolio of receivables needs: half-up
 *                 across four hundred invoices drifts upward by roughly
 *                 two hundred paise, every quarter, in the same direction.
 *   `half_up`    — away from zero on a half. Matches what most bank
 *                 advices show, so it is available for a tenant who has to
 *                 tie to a specific counterparty's arithmetic.
 *   `down`       — truncate toward zero. Only for a deliberately
 *                 conservative estimate; never for a posting.
 */
export const ROUNDING_MODES = ["half_even", "half_up", "down"] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export const DEFAULT_ROUNDING: RoundingMode = "half_even";

/**
 * `numerator / denominator` in the given mode, sign-symmetric.
 * `denominator` must be positive.
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  if (denominator <= 0n) throw new FxRateError("Division by a non-positive denominator.");
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;

  const q = abs / denominator;
  const r = abs % denominator;
  let magnitude: bigint;

  if (mode === "down" || r === 0n) {
    magnitude = q;
  } else {
    const twice = r * 2n;
    if (twice > denominator) magnitude = q + 1n;
    else if (twice < denominator) magnitude = q;
    // Exactly half.
    else if (mode === "half_up") magnitude = q + 1n;
    else magnitude = q % 2n === 0n ? q : q + 1n; // half_even
  }
  return negative ? -magnitude : magnitude;
}

/**
 * ⭐ THE RESULT CARRIES ITS OWN WORKING.
 *
 * Everything a reader needs to reproduce the figure — the rate, the date
 * the rate is for, where the rate came from, whether it was inverted, and
 * how the last paisa was rounded. A converted amount displayed without
 * these is an assertion the tenant cannot check.
 */
export type FxConversion = {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly fromAmountMinor: bigint;
  readonly fromCurrency: string;
  readonly quote: FxQuote;
  readonly rounding: RoundingMode;
  /**
   * The date the conversion was made FOR — a transaction date, a reporting
   * date, a settlement date. Equal to `quote.rateDate` unless the caller
   * explicitly accepted a stale rate, in which case this is the real event
   * date and `stalenessDays` says how far back the rate is.
   */
  readonly on: string;
  readonly stalenessDays: number;
};

function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new FxRateError(`"${earlier}" or "${later}" is not a date in YYYY-MM-DD form.`);
  }
  return Math.round((b - a) / 86_400_000);
}

/**
 * 🔴 HOW OLD A RATE MAY BE, AND THE CALLER MUST SAY.
 *
 * `exact` is the default and the only one that needs no justification:
 * the rate is for the very day of the event. Anything else is an
 * accommodation for the fact that markets close — Ind AS 21 ¶22 permits a
 * rate that approximates the actual rate at the date of the transaction,
 * "for example, an average rate for a week or a month" — and the
 * accommodation has to be a decision somebody made, with a stated limit,
 * rather than a fallback the code takes on its own.
 */
export type StalenessPolicy =
  | { readonly kind: "exact" }
  | { readonly kind: "on_or_before"; readonly maxDays: number; readonly because: string };

export const EXACT_DATE: StalenessPolicy = { kind: "exact" };

/**
 * ⚠️ THE HOUSE DEFAULT FOR A CLOSING RATE. Indian markets are shut on
 * Saturday, Sunday and gazetted holidays, and 31 March has fallen on a
 * Sunday three times this decade. Four days reaches back across a long
 * weekend and no further; a month-old rate on a reporting date is not an
 * approximation of the closing rate, it is a different measurement.
 */
export const CLOSING_RATE_WINDOW: StalenessPolicy = {
  kind: "on_or_before",
  maxDays: 4,
  because:
    "the closing rate for a reporting date that falls on a market holiday is the last rate " +
    "published before it; four days reaches back across a long weekend and no further",
};

/**
 * 🔴 THE GATE. A quote is usable for a date only if it IS for that date,
 * or the caller has explicitly said how far back it may reach and why.
 */
export function assertQuoteUsableOn(
  quote: FxQuote,
  on: string,
  policy: StalenessPolicy,
): number {
  const drift = daysBetween(quote.rateDate, on);
  if (drift < 0) {
    throw new FxRateError(
      `${describeQuote(quote)} is dated AFTER ${on}. A rate published later than the event ` +
        `cannot measure it — that is hindsight, not translation.`,
    );
  }
  if (policy.kind === "exact") {
    if (drift !== 0) {
      throw new FxRateError(
        `${describeQuote(quote)} is ${drift} day(s) older than ${on} and this conversion ` +
          `requires the rate for the day itself. Nothing has been converted. If a rate for a ` +
          `nearby day is the right answer here, say so explicitly with a staleness policy — ` +
          `Ind AS 21 ¶22 allows an approximation, but only as a decision, never as a fallback.`,
      );
    }
    return 0;
  }
  if (drift > policy.maxDays) {
    throw new FxRateError(
      `${describeQuote(quote)} is ${drift} day(s) older than ${on}, beyond the ${policy.maxDays}-day ` +
        `window allowed because ${policy.because}. Nothing has been converted.`,
    );
  }
  return drift;
}

/**
 * ⭐⭐⭐ THE CONVERSION.
 *
 *     minor_to = minor_from × rate × 10^exp_to / (10^exp_from × RATE_SCALE)
 *
 * Read it as: strip `from`'s exponent to get major units, multiply by the
 * rate to get major units of `to`, apply `to`'s exponent. Written as one
 * fraction so it is computed with one division and one rounding.
 *
 * @example
 *   // USD 1,234.56 at USD/INR 83.2150 on 2026-03-31
 *   convertMinor({
 *     amountMinor: 123456n, from: "USD", to: "INR",
 *     quote, on: "2026-03-31", policy: EXACT_DATE,
 *   }).amountMinor === 10_272_460n   // ₹1,02,724.60
 */
export function convertMinor(args: {
  amountMinor: bigint;
  from: string;
  to: string;
  /**
   * 🔴 REQUIRED. There is no overload without it and no "latest" default.
   * `identityQuote(currency, on)` is the answer when from === to, and
   * `server/fx/rate-service.ts#resolveQuote` is the answer otherwise.
   */
  quote: FxQuote;
  /** 🔴 REQUIRED. The date of the event being measured. */
  on: string;
  /** Defaults to `EXACT_DATE`, which is the only policy needing no reason. */
  policy?: StalenessPolicy;
  rounding?: RoundingMode;
}): FxConversion {
  const from = normaliseCurrencyCode(args.from);
  const to = normaliseCurrencyCode(args.to);
  const rounding = args.rounding ?? DEFAULT_ROUNDING;
  const policy = args.policy ?? EXACT_DATE;

  const oriented = from === to ? identityQuote(from, args.quote.rateDate) : orientQuote(args.quote, from, to);
  const stalenessDays = assertQuoteUsableOn(oriented, args.on, policy);

  const expFrom = BigInt(minorUnitExponent(from));
  const expTo = BigInt(minorUnitExponent(to));

  const numerator = args.amountMinor * oriented.rateScaled * 10n ** expTo;
  const denominator = 10n ** expFrom * RATE_SCALE;

  return {
    amountMinor: divideRounded(numerator, denominator, rounding),
    currency: to,
    fromAmountMinor: args.amountMinor,
    fromCurrency: from,
    quote: oriented,
    rounding,
    on: args.on,
    stalenessDays,
  };
}

/**
 * ⭐⭐ HOW FAR A→B→A CAN DRIFT, BOUNDED AND STATED.
 *
 * It CAN drift, and pretending otherwise is the mistake. Three separate
 * losses, each bounded:
 *
 *   ① the forward conversion rounds to the nearest minor unit of B. One
 *      minor unit of B is `10^(expA − expB) / rate` minor units of A, so
 *      half of one is the first term below.
 *   ② the inverse rate is `round(1/r)` at twelve decimals, a relative
 *      error of at most `0.5 × 10^-12`, which costs `|amount| / 2×10^12`
 *      minor units of A.
 *   ③ the return conversion rounds again: half a minor unit of A.
 *
 * The bound below is the sum, rounded up, plus one for the two half-units
 * that the ceilings could each hide. It is loose by design — a bound that
 * is occasionally exceeded is not a bound.
 *
 * ⚠️ ON A ZERO-DECIMAL CURRENCY THE FIRST TERM DOMINATES AND IS LARGE.
 * ₹1,000 → JPY → ₹ can land ₹0.40 away, because one whole yen is worth
 * more than one paisa and the JPY leg cannot represent the difference.
 * That is a property of the yen, not a bug, and it is why a total is
 * reported in the currency it was measured in.
 */
export function roundTripDriftBoundMinor(args: {
  amountMinor: bigint;
  from: string;
  to: string;
  quote: FxQuote;
}): bigint {
  const from = normaliseCurrencyCode(args.from);
  const to = normaliseCurrencyCode(args.to);
  if (from === to) return 0n;

  const oriented = orientQuote(args.quote, from, to);
  const expFrom = BigInt(minorUnitExponent(from));
  const expTo = BigInt(minorUnitExponent(to));
  const abs = args.amountMinor < 0n ? -args.amountMinor : args.amountMinor;

  const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

  // ① half a minor unit of `to`, expressed in minor units of `from`.
  const oneMinorToInFrom = ceilDiv(10n ** expFrom * RATE_SCALE, oriented.rateScaled * 10n ** expTo);
  const term1 = ceilDiv(oneMinorToInFrom, 2n) + 1n;
  // ② the inversion's relative error.
  const term2 = ceilDiv(abs, 2n * RATE_SCALE) + 1n;
  // ③ the final rounding.
  const term3 = 1n;

  return term1 + term2 + term3;
}
