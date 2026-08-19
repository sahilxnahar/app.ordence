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

/**
 * ⭐⭐⭐ WHICH SIDE OF THE SPREAD, AND IT IS A DIFFERENT AXIS FROM `source`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE NUMBERS, NOT ONE, AND THE STATUTE NAMES ONE OF THEM
 * ══════════════════════════════════════════════════════════════════════
 * A bank quoting USD/INR quotes at least three numbers on the same day:
 * what it will PAY for a dollar arriving by telegraphic transfer (the TT
 * BUYING rate), what it will CHARGE for a dollar it sends (TT SELLING),
 * and the midpoint between them, which is what a reference rate and a
 * market data feed publish. The spread between buying and selling is
 * routinely 40–80 paise on the dollar, so on a ₹1 crore remittance the
 * three numbers are half a lakh apart.
 *
 * 🔴 RULE 26 OF THE INCOME-TAX RULES 1962 NAMES THE TELEGRAPHIC TRANSFER
 *    BUYING RATE AND NOTHING ELSE. For deducting tax at source on income
 *    payable in foreign currency, the rupee value is the amount converted
 *    at the TT buying rate "as on the date on which the tax is required to
 *    be deducted". A mid rate used where the statute says TT buying
 *    changes the chargeable base, and therefore the tax — and a short
 *    deduction makes the deductor personally liable under s.201(1) for
 *    the whole shortfall plus 201(1A) interest.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS NOT A NEW `source` VALUE
 * ══════════════════════════════════════════════════════════════════════
 * `source` answers WHO PUBLISHED IT — the Reserve Bank, a vendor feed, a
 * person in the workspace. `rateType` answers WHICH OF THAT PUBLISHER'S
 * THREE NUMBERS IT IS. They are orthogonal: the State Bank publishes a TT
 * buying rate, the RBI publishes a reference (mid) rate, and a tenant can
 * type either off an advice. Folding one into the other would make
 * `source = 'tt_buying'` a publisher, which answers neither question, and
 * `STORABLE_FX_RATE_SOURCES` is a closed list precisely so that it stays
 * a list of publishers.
 *
 * 🔴 AND NOTHING ANYWHERE INFERS ONE AXIS FROM THE OTHER. There is no
 *    `rateTypeOf(source)` in this codebase and there must never be one:
 *    "rbi_reference means mid" is true today, is a fact about the RBI's
 *    publication policy rather than about our data, and would silently
 *    re-label every historic row the day it stopped being true.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ `unstated` IS A REAL VALUE AND IT IS WHAT EVERY PRE-0106 ROW IS
 * ══════════════════════════════════════════════════════════════════════
 * Every `fx_rates` and `fx_reference_rates` row written before this batch
 * carries no side of the spread, because the column did not exist and
 * nobody was ever asked. `unstated` records that ignorance as a fact.
 *
 * 🔴 IT IS NOT `mid`, AND CALLING IT `mid` WAS THE OBVIOUS WRONG MOVE. A
 *    tenant who typed 83.60 off their bank's advice typed a TT buying or
 *    a TT selling rate — the advice for a real remittance is never a mid
 *    — so `mid` would be false for exactly the rows that matter most.
 * 🔴 IT IS EMPHATICALLY NOT `tt_buying`, because that single word would
 *    make every historical rate eligible to compute a s.195 deduction,
 *    which is the mis-deduction this batch exists to prevent.
 *
 * ⚠️ AN `unstated` ROW IS STILL PERFECTLY USABLE for everything it was
 *    already used for — AS 11 initial recognition, the closing-rate
 *    revaluation, a receivables ageing — because none of those name a
 *    side of the spread. It is refused ONLY where a statute names one.
 *    That is why this migration changes no figure now on a screen.
 */
export const FX_RATE_TYPES = ["unstated", "mid", "tt_buying", "tt_selling"] as const;

export type FxRateType = (typeof FX_RATE_TYPES)[number];

export function isFxRateType(v: string): v is FxRateType {
  return (FX_RATE_TYPES as readonly string[]).includes(v);
}

/**
 * ⭐ WHAT A PERSON OR A FEED MAY WRITE TODAY. `unstated` is readable
 * history and is never a choice on a new row: a rate being entered now
 * has somebody looking at the advice it came from, and asking them which
 * number it is costs one field and settles the question forever.
 */
export const STORABLE_FX_RATE_TYPES = ["mid", "tt_buying", "tt_selling"] as const;
export type StorableFxRateType = (typeof STORABLE_FX_RATE_TYPES)[number];

export function isStorableFxRateType(v: string): v is StorableFxRateType {
  return (STORABLE_FX_RATE_TYPES as readonly string[]).includes(v);
}

/** How a rate type reads in a refusal, in the statute's own words. */
export function describeRateType(t: FxRateType): string {
  switch (t) {
    case "tt_buying":
      return "telegraphic transfer buying rate";
    case "tt_selling":
      return "telegraphic transfer selling rate";
    case "mid":
      return "mid rate";
    case "unstated":
      return "rate of unstated side of the spread";
  }
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
  /**
   * ⭐ WHICH SIDE OF THE SPREAD. Orthogonal to `source`, never derived
   * from it, and `unstated` where nobody said. See `FX_RATE_TYPES`.
   */
  readonly rateType: FxRateType;
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
  /**
   * ⚠️ OMITTING IT MEANS `unstated`, WHICH FAILS CLOSED. An omitted rate
   * type can never satisfy a statutory conversion — `assertStatutoryQuote`
   * in `lib/fx/statutory.ts` refuses it by name — so the default costs a
   * refusal and never a wrong deduction. It is NOT inferred from `source`.
   */
  rateType?: FxRateType;
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
    rateType: input.rateType ?? "unstated",
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
/**
 * ⚠️ AN IDENTITY QUOTE CARRIES WHATEVER SIDE OF THE SPREAD WAS ASKED FOR,
 * AND THAT IS NOT A LOOPHOLE. There is no spread between a currency and
 * itself: the telegraphic transfer buying rate of rupees for rupees is
 * one, the selling rate is one and the mid is one. So a caller that needs
 * a TT buying rate to translate an INR payment gets one, exactly, from no
 * table — and the refusal it would otherwise hit would be a refusal to
 * multiply by 1.
 */
export function identityQuote(
  currency: string,
  rateDate: string,
  rateType: FxRateType = "unstated",
): FxQuote {
  return makeQuote({
    baseCurrency: currency,
    quoteCurrency: currency,
    rateScaled: RATE_SCALE,
    rateDate,
    source: "identity",
    rateType,
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
  return `${q.baseCurrency}/${q.quoteCurrency} ${formatRateScaled(q.rateScaled)} on ${q.rateDate} · ${q.source} · ${describeRateType(q.rateType)}${derived}`;
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
    /**
     * 🔴🔴 THE SIDE OF THE SPREAD DOES NOT SURVIVE INVERSION.
     *
     * A TT buying rate for USD/INR is what a bank PAYS in rupees for a
     * dollar arriving. Its reciprocal is a number of dollars per rupee
     * that no bank quotes and that is certainly not the rate at which
     * anybody buys rupees — the buying side of one pair is the selling
     * side of the other, and the two sides are not reciprocals of each
     * other because the spread is not symmetric.
     *
     * ⚠️ SO AN INVERTED SPREAD-SIDE RATE BECOMES `unstated`, WHICH MEANS
     * A STATUTORY CONVERSION REFUSES IT. That refusal is the correct
     * answer: Rule 26 names a published TT buying rate, and a reciprocal
     * this code computed is not one, however close the arithmetic is.
     *
     * ⭐ `mid` SURVIVES, because `mid` asserts only "neither side of the
     * spread", and the reciprocal of a number that is on neither side is
     * still on neither side.
     */
    rateType: q.rateType === "mid" ? "mid" : "unstated",
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
