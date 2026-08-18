/**
 * Ordence — ⭐⭐⭐ A TOTAL WITH NO CURRENCY LABEL IS A BUG
 * Batch 0101 · Multi-currency and FX
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FAILURE THIS FILE EXISTS FOR IS NOT AN ERROR MESSAGE
 * ══════════════════════════════════════════════════════════════════════
 * `coalesce(sum(amount_minor), 0)` over a set that spans currencies
 * returns a number. The number is not wrong in any way the database can
 * detect: it is the arithmetic sum of a column. It is simply not a
 * quantity of anything. USD 100 plus INR 100 is 200 of nothing, and it is
 * then printed on a receivables ageing, believed, and chased.
 *
 * There is no exception thrown, no NULL, no zero row. That is precisely
 * why a type is the right place to fix it: `sumByCurrency` cannot return a
 * bare `bigint`, so a caller cannot accidentally treat one as a total.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ TWO HONEST ANSWERS, AND ONE DISHONEST ONE
 * ══════════════════════════════════════════════════════════════════════
 *   ① GROUP BY CURRENCY — "₹4,10,000 and $6,200". Always correct, needs
 *      no rate, and is what a receivables ageing should show.
 *   ② CONVERT THROUGH A STATED RATE — one figure, with the rate, the rate
 *      date and the source shown next to it, and the components listed.
 *      `convertBuckets` below returns all of that; the caller cannot get
 *      the number without also getting the working.
 *   ③ ADD THEM UP — what the product did before this batch.
 *
 * ⚠️ AND WHEN A RATE IS MISSING, ② DEGRADES TO ①. It does not guess, it
 * does not skip the row, and it does not fall back to 1:1. It returns the
 * unconvertible components separately so the screen can say "and $6,200
 * for which no rate is on file for 31 March".
 *
 * ⚠️ PURE. No database, no clock.
 */

import { normaliseCurrencyCode, type Money } from "./currency";
import { convertMinor, EXACT_DATE, type RoundingMode, type StalenessPolicy } from "./convert";
import { describeQuote, identityQuote, type FxQuote } from "./rates";

export class MixedCurrencyError extends Error {
  readonly currencies: readonly string[];
  constructor(what: string, currencies: readonly string[]) {
    super(
      `${what} spans ${currencies.length} currencies (${currencies.join(", ")}), so it has no ` +
        `single total. Group it by currency, or convert it through a rate on a stated date and ` +
        `show that rate. Adding the minor units together would produce a plausible number that ` +
        `is a quantity of nothing.`,
    );
    this.name = "MixedCurrencyError";
    this.currencies = currencies;
  }
}

/** One labelled subtotal. Never a bare bigint anywhere in this module. */
export type CurrencyTotal = {
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly count: number;
};

/**
 * ⭐ THE AGGREGATION. Rows in, one labelled subtotal per currency out,
 * sorted so the output is stable and diffable.
 */
export function sumByCurrency(
  rows: readonly { currency: string; amountMinor: bigint }[],
): CurrencyTotal[] {
  const buckets = new Map<string, { amountMinor: bigint; count: number }>();
  for (const row of rows) {
    const currency = normaliseCurrencyCode(row.currency);
    const existing = buckets.get(currency);
    if (existing) {
      existing.amountMinor += row.amountMinor;
      existing.count += 1;
    } else {
      buckets.set(currency, { amountMinor: row.amountMinor, count: 1 });
    }
  }
  return [...buckets.entries()]
    .map(([currency, v]) => ({ currency, amountMinor: v.amountMinor, count: v.count }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * 🔴 THE REFUSAL. For a total that genuinely has no meaning across
 * currencies — a credit limit, a spending cap, a "does this exceed X"
 * comparison — refusing is the correct answer and converting is not,
 * because the comparison would then silently depend on today's rate.
 */
export function requireSingleCurrency(
  what: string,
  totals: readonly CurrencyTotal[],
): Money {
  if (totals.length === 0) {
    throw new MixedCurrencyError(`${what} produced no rows at all, so it has no currency`, []);
  }
  if (totals.length > 1) {
    throw new MixedCurrencyError(what, totals.map((t) => t.currency));
  }
  const only = totals[0] as CurrencyTotal;
  return { amountMinor: only.amountMinor, currency: only.currency };
}

/** One component of a converted total, with its own working attached. */
export type ConvertedComponent = {
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly count: number;
  readonly convertedMinor: bigint;
  readonly rateScaled: bigint;
  readonly rateDate: string;
  readonly rateSource: string;
  readonly rateDerived: boolean;
  /** "USD/INR 83.215000000000 on 2026-03-31 · rbi_reference". */
  readonly rateDescription: string;
};

/**
 * ⭐⭐ THE CONVERTED TOTAL, WITH ITS WORKING AND ITS GAPS.
 *
 * ⚠️ `complete` IS FALSE WHENEVER ANYTHING COULD NOT BE CONVERTED, and a
 * screen must not print `total` on its own when it is. The unconverted
 * components are still there, still labelled, still correct — the answer
 * degrades from one number to several rather than from correct to wrong.
 */
export type ConvertedTotal = {
  readonly currency: string;
  readonly on: string;
  readonly totalMinor: bigint;
  readonly components: readonly ConvertedComponent[];
  readonly unconverted: readonly CurrencyTotal[];
  readonly complete: boolean;
};

/**
 * Convert a set of labelled subtotals into one currency at one date.
 *
 * `resolve` is supplied by the caller — in production it is
 * `server/fx/rate-service.ts#resolveQuote` bound to a transaction, and in
 * the tests it is a fixture. It returns `null` for "no rate on file",
 * which is a fact about the data and NOT an error.
 */
export function convertBuckets(args: {
  totals: readonly CurrencyTotal[];
  to: string;
  on: string;
  resolve: (from: string, to: string, on: string) => FxQuote | null;
  policy?: StalenessPolicy;
  rounding?: RoundingMode;
}): ConvertedTotal {
  const to = normaliseCurrencyCode(args.to);
  const components: ConvertedComponent[] = [];
  const unconverted: CurrencyTotal[] = [];
  let totalMinor = 0n;

  for (const bucket of args.totals) {
    /**
     * ⭐ THE BUCKET ALREADY IN THE TARGET CURRENCY NEEDS NO RESOLVER AND
     * NO RATE. `identityQuote` is exactly 1 by construction — asking a
     * resolver for INR→INR would make the commonest case in the product
     * depend on a table lookup that can come back empty, and an empty
     * lookup here would drop a workspace's entire rupee balance out of its
     * own rupee total.
     */
    const quote =
      normaliseCurrencyCode(bucket.currency) === to
        ? identityQuote(to, args.on)
        : args.resolve(bucket.currency, to, args.on);
    if (!quote) {
      unconverted.push(bucket);
      continue;
    }
    const conversion = convertMinor({
      amountMinor: bucket.amountMinor,
      from: bucket.currency,
      to,
      quote,
      on: args.on,
      policy: args.policy ?? EXACT_DATE,
      rounding: args.rounding,
    });
    totalMinor += conversion.amountMinor;
    components.push({
      currency: bucket.currency,
      amountMinor: bucket.amountMinor,
      count: bucket.count,
      convertedMinor: conversion.amountMinor,
      rateScaled: conversion.quote.rateScaled,
      rateDate: conversion.quote.rateDate,
      rateSource: conversion.quote.source,
      rateDerived: conversion.quote.derived,
      rateDescription: describeQuote(conversion.quote),
    });
  }

  return {
    currency: to,
    on: args.on,
    totalMinor,
    components,
    unconverted,
    complete: unconverted.length === 0,
  };
}

/**
 * ⭐ THE SENTENCE THAT GOES NEXT TO THE NUMBER.
 *
 * Not decoration. A converted total printed without saying which rate it
 * used is exactly as unauditable as an unlabelled one, and it is worse,
 * because it looks precise.
 */
export function describeConvertedTotal(t: ConvertedTotal): string {
  if (t.components.length === 0 && t.unconverted.length === 0) {
    return `No amounts to total in ${t.currency}.`;
  }
  const rates = t.components
    .filter((c) => c.currency !== t.currency)
    .map((c) => c.rateDescription);
  const head =
    rates.length === 0
      ? `Stated in ${t.currency}.`
      : `Converted to ${t.currency} at ${rates.join("; ")}.`;
  if (t.complete) return head;
  const missing = t.unconverted.map((u) => u.currency).join(", ");
  return `${head} ⚠️ Excludes ${missing}: no exchange rate is on file for ${t.on}, so those amounts are shown separately rather than guessed.`;
}
