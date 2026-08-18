/**
 * Ordence — ⭐⭐⭐ AN EXCHANGE RATE IS A DIRECTION, A DATE AND A SOURCE
 * Batch 0101 · Multi-currency and FX
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A RATE IS NOT A SCALAR AND THIS FILE IS THE PROOF
 * ══════════════════════════════════════════════════════════════════════
 * "The USD rate" is not a fact. `USD/INR 83.2150 on 2026-03-31, RBI
 * reference` is. Strip any one of the three and you have a number that
 * cannot be defended:
 *
 *   • no DIRECTION  → 83.2150 and 0.012018 are the same rate written two
 *                     ways and multiplying by the wrong one is an error of
 *                     four orders of magnitude that still looks like money
 *   • no DATE       → yesterday's rate on today's transaction. Ind AS 21
 *                     ¶21 requires the SPOT rate at the DATE OF THE
 *                     TRANSACTION; a stale rate is not a rounding error,
 *                     it is the wrong measurement
 *   • no SOURCE     → nobody can reproduce the figure at audit, and a
 *                     manually typed rate and a published reference rate
 *                     carry very different weight in that conversation
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE STORAGE DECISION: PAIR-AS-PUBLISHED, NOT BASE-ANCHORED
 * ══════════════════════════════════════════════════════════════════════
 * A rate row names `base` and `quote` explicitly and holds "how many
 * QUOTE per ONE BASE". USD→INR 83.2150 is stored as base=USD, quote=INR,
 * rate=83.215.
 *
 * 🔴 THE ALTERNATIVE — anchor everything to INR and derive every other
 * pair by division — was rejected, and the reason is evidential rather
 * than mathematical. The Reserve Bank publishes USD/INR and EUR/INR as
 * separate reference rates in its daily press release. Deriving EUR/USD
 * from those two produces a number the RBI never published, from a
 * division nobody can point at, and the tenant cannot answer "where did
 * this rate come from" with a document. Storing the pair as it was
 * published means the number on the invoice is the number in the
 * circular.
 *
 * ⚠️ THE PRICE OF THAT CHOICE IS THAT INVERSION IS EXPLICIT. `invertQuote`
 * exists, it marks its result `derived: true`, and the derivation is
 * carried through to the conversion result and onto the screen. An
 * inverted rate is a rate we computed, not a rate anybody published, and
 * the tenant is entitled to know which one their books used.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE PRECISION DECISION: TWELVE DECIMAL PLACES, AS A `bigint`
 * ══════════════════════════════════════════════════════════════════════
 * `RATE_SCALE = 10^12`, so 83.215 is stored as 83_215_000_000_000n.
 *
 *   • RBI publishes reference rates to FOUR decimals (83.2150). Four is
 *     enough to store what is published and nowhere near enough to store
 *     its inverse: 1/83.215 = 0.01201706… and truncating that at four
 *     decimals (0.0120) is an error of 1.4 per cent — on a ₹1 crore
 *     receivable, ₹1.4 lakh.
 *   • Twelve places hold the inverse of any plausible rate to about ten
 *     significant figures, which round-trips a ₹100 crore balance to
 *     within a paisa.
 *   • It is a `bigint`, not a float. IEEE-754 gives ~15-16 significant
 *     decimal digits total, and a rate multiplication in the middle of a
 *     money calculation is exactly where those digits get spent.
 *   • `numeric(30,12)` in the database: 18 integer digits of headroom,
 *     which covers the hyperinflated currencies without an overflow.
 */

import { assertKnownCurrency, normaliseCurrencyCode } from "./currency";

/** Decimal places a stored rate carries. See the header for why twelve. */
export const RATE_EXPONENT = 12;

/** 10^RATE_EXPONENT. A rate of exactly 1 is `RATE_SCALE`. */
export const RATE_SCALE: bigint = 10n ** BigInt(RATE_EXPONENT);

/**
 * ⚠️ WHERE THE NUMBER CAME FROM, AND IT IS NOT COSMETIC.
 *
 *   `rbi_reference`  — the Reserve Bank of India's daily reference rate.
 *                      A published fact, identical for every tenant, so it
 *                      lives on the PLATFORM table (see SQL 0101 §3).
 *   `provider`       — a commercial rate feed. Also published, also
 *                      platform-scoped, but carrying a vendor name.
 *   `manual`         — somebody in the tenant typed it, usually the rate
 *                      on their own bank's advice. That is the tenant's
 *                      own fact and lives on the TENANT table, because one
 *                      workspace's negotiated rate is not evidence for
 *                      anybody else's books.
 *   `derived_inverse`— computed by `invertQuote` from a rate published the
 *                      other way round. Never stored; only ever produced
 *                      at the point of use, and it says so.
 *   `identity`       — from and to are the same currency. Exactly 1, by
 *                      construction, never read from a table.
 */
export const FX_RATE_SOURCES = [
  "rbi_reference",
  "provider",
  "manual",
  "derived_inverse",
  "identity",
] as const;

export type FxRateSource = (typeof FX_RATE_SOURCES)[number];

/** Sources that may be persisted. The other two are computed at use. */
export const STORABLE_FX_RATE_SOURCES = ["rbi_reference", "provider", "manual"] as const;
export type StorableFxRateSource = (typeof STORABLE_FX_RATE_SOURCES)[number];

export function isStorableFxRateSource(v: string): v is StorableFxRateSource {
  return (STORABLE_FX_RATE_SOURCES as readonly string[]).includes(v);
}

export class FxRateError extends Error {}

/**
 * ⭐ ONE RATE. Immutable, self-describing, and impossible to use without
 * knowing what date it is for.
 */
export type FxQuote = {
  /** ISO-4217. "How many `quoteCurrency` for one `baseCurrency`." */
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  /** Scaled by RATE_SCALE. Always > 0. */
  readonly rateScaled: bigint;
  /** `YYYY-MM-DD`. The date the rate IS FOR, never the date it was typed. */
  readonly rateDate: string;
  readonly source: FxRateSource;
  /** RBI circular number, provider tick id, or the tenant's own note. */
  readonly sourceReference: string | null;
  /**
   * True when this quote was computed by inverting a rate published the
   * other way. Carried onto the conversion result and onto the screen.
   */
  readonly derived: boolean;
  /** The `fx_rates` / `fx_reference_rates` row id, when it came from one. */
  readonly rateId: string | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertRateDate(date: string): void {
  if (!DATE_RE.test(date)) {
    throw new FxRateError(
      `"${date}" is not a rate date. A rate without a date is not a rate — Ind AS 21 ¶21 ` +
        `measures a transaction at the spot rate AT THE DATE OF THE TRANSACTION, so the date ` +
        `is part of the measurement and not metadata about it.`,
    );
  }
}

/** Build a quote, refusing every shape that cannot be defended. */
export function makeQuote(input: {
  baseCurrency: string;
  quoteCurrency: string;
  rateScaled: bigint;
  rateDate: string;
  source: FxRateSource;
  sourceReference?: string | null;
  derived?: boolean;
  rateId?: string | null;
}): FxQuote {
  const baseCurrency = normaliseCurrencyCode(input.baseCurrency);
  const quoteCurrency = normaliseCurrencyCode(input.quoteCurrency);
  assertKnownCurrency(baseCurrency);
  assertKnownCurrency(quoteCurrency);
  assertRateDate(input.rateDate);

  if (input.rateScaled <= 0n) {
    throw new FxRateError(
      `An exchange rate of ${input.rateScaled} is not a rate. Rates are strictly positive; ` +
        `direction is carried by the pair, never by the sign.`,
    );
  }
  if (baseCurrency === quoteCurrency && input.rateScaled !== RATE_SCALE) {
    throw new FxRateError(
      `${baseCurrency} to ${baseCurrency} is exactly 1 and cannot be stored as anything else.`,
    );
  }
  return {
    baseCurrency,
    quoteCurrency,
    rateScaled: input.rateScaled,
    rateDate: input.rateDate,
    source: input.source,
    sourceReference: input.sourceReference ?? null,
    derived: input.derived ?? false,
    rateId: input.rateId ?? null,
  };
}

/**
 * ⭐ THE IDENTITY QUOTE. INR→INR on any date is 1, exactly, from no table.
 *
 * ⚠️ THIS IS WHY THE BATCH IS SAFE FOR EVERY EXISTING TENANT. Every
 * workspace in the product today keeps its books in INR and invoices in
 * INR, so every conversion the new code performs resolves to identity, is
 * exact, and changes no number that is on a screen now.
 */
export function identityQuote(currency: string, rateDate: string): FxQuote {
  return makeQuote({
    baseCurrency: currency,
    quoteCurrency: currency,
    rateScaled: RATE_SCALE,
    rateDate,
    source: "identity",
    sourceReference: null,
  });
}

/**
 * Decimal text → scaled bigint. Text in, never `Number`.
 *
 * ⚠️ MORE THAN TWELVE DECIMALS IS REFUSED RATHER THAN TRUNCATED. A rate
 * silently shortened is a rate the tenant did not enter.
 */
export function parseRateToScaled(text: string): bigint {
  const trimmed = text.trim();
  const m = new RegExp(`^(\\d{1,18})(?:\\.(\\d{1,${RATE_EXPONENT}}))?$`).exec(trimmed);
  if (!m) {
    throw new FxRateError(
      `"${text}" is not an exchange rate. Expected a positive decimal with at most ` +
        `${RATE_EXPONENT} decimal places, e.g. "83.2150".`,
    );
  }
  const whole = BigInt(m[1] ?? "0");
  const frac = BigInt((m[2] ?? "").padEnd(RATE_EXPONENT, "0"));
  const scaled = whole * RATE_SCALE + frac;
  if (scaled <= 0n) throw new FxRateError(`An exchange rate of ${text} is not a rate.`);
  return scaled;
}

/** Scaled bigint → the exact decimal string, all twelve places. */
export function formatRateScaled(rateScaled: bigint): string {
  const whole = rateScaled / RATE_SCALE;
  const frac = (rateScaled % RATE_SCALE).toString().padStart(RATE_EXPONENT, "0");
  return `${whole}.${frac}`;
}

/** How the pair reads on a screen: "USD/INR 83.215000000000". */
export function describeQuote(q: FxQuote): string {
  const derived = q.derived ? " (derived by inversion)" : "";
  return `${q.baseCurrency}/${q.quoteCurrency} ${formatRateScaled(q.rateScaled)} on ${q.rateDate} · ${q.source}${derived}`;
}

/**
 * ⭐ THE INVERSE, MARKED AS DERIVED.
 *
 * 🔴 THIS IS LOSSY AND SAYS SO. `round(10^24 / rateScaled)` is the best
 * twelve-decimal representation of 1/r, and it is not exactly 1/r. So
 * `convert(convert(x, q), invert(q))` does not always return x — it
 * returns x within the bound `roundTripDriftBoundMinor()` computes and
 * `tests/ui/fx.test.ts` proves. Anybody relying on an exact round trip is
 * relying on something that is not true of real exchange rates either.
 */
export function invertQuote(q: FxQuote): FxQuote {
  if (q.baseCurrency === q.quoteCurrency) return q;
  // Half-up on a positive magnitude: r' = round(SCALE^2 / r).
  const numerator = RATE_SCALE * RATE_SCALE;
  const inverted = (numerator * 2n + q.rateScaled) / (q.rateScaled * 2n);
  if (inverted <= 0n) {
    throw new FxRateError(
      `${describeQuote(q)} is too large to invert at ${RATE_EXPONENT} decimal places: its ` +
        `reciprocal rounds to zero. Enter the rate in the direction it is quoted in.`,
    );
  }
  return {
    baseCurrency: q.quoteCurrency,
    quoteCurrency: q.baseCurrency,
    rateScaled: inverted,
    rateDate: q.rateDate,
    source: "derived_inverse",
    sourceReference: q.sourceReference,
    derived: true,
    rateId: q.rateId,
  };
}

/**
 * ⭐ ORIENT A QUOTE FOR A CONVERSION, OR REFUSE.
 *
 * Returns the quote that converts `from` into `to`, inverting if the
 * stored pair runs the other way, and refusing when the quote has nothing
 * to do with either currency. Refusing matters: silently returning the
 * stored quote when it names the wrong pair would convert INR to INR at
 * 83, which balances and is nonsense.
 */
export function orientQuote(q: FxQuote, from: string, to: string): FxQuote {
  const f = normaliseCurrencyCode(from);
  const t = normaliseCurrencyCode(to);
  if (q.baseCurrency === f && q.quoteCurrency === t) return q;
  if (q.baseCurrency === t && q.quoteCurrency === f) return invertQuote(q);
  throw new FxRateError(
    `${describeQuote(q)} cannot convert ${f} to ${t}. Nothing has been converted. ` +
      `A rate for the wrong pair applied anyway produces a figure that balances and is wrong.`,
  );
}
