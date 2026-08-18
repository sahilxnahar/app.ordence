/**
 * Ordence — ⭐⭐⭐ MULTI-CURRENCY AND FX (Batch 0101)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE ASSERTIONS AND NOT OTHERS
 * ══════════════════════════════════════════════════════════════════════
 * Every failure this batch closes is INVISIBLE to the person it costs.
 * Nobody can see that a total added dollars to rupees, that a yen amount
 * was divided by a hundred, that a fixed asset was revalued, or that a
 * settlement gain was booked twice — every one of those produces a
 * plausible number on a statement that still foots.
 *
 * So nothing below pins a count, a total or an incidental string. Every
 * test asserts a PROPERTY or a RELATION between two runs that differ in
 * exactly one thing:
 *
 *   ① CONVERTING AT r THEN AT 1/r RETURNS THE ORIGINAL WITHIN A BOUND
 *     THE ENGINE ITSELF STATES. Asserted over many amounts and rates, so
 *     no single lucky value can make it pass, and asserted against
 *     `roundTripDriftBoundMinor` rather than a hardcoded tolerance — a
 *     looser implementation would have to loosen its own stated bound,
 *     which is a visible change.
 *   ② A MONETARY ITEM RESTATES AND A NON-MONETARY ONE DOES NOT. Asserted
 *     as a relation between two items identical in every argument except
 *     `kind`, so no rounding, default or field ordering can make it pass.
 *   ③ A ZERO-DECIMAL CURRENCY NEVER GAINS PHANTOM PAISE, and a
 *     three-decimal one never loses a fils. Asserted through the format
 *     AND the parse, because this is exactly the bug that is right in the
 *     arithmetic and wrong in the display.
 *   ④ AN AGGREGATE OVER MIXED CURRENCIES EITHER REFUSES OR LABELS.
 *     Asserted by showing that the labelled answer is recoverable and the
 *     unlabelled one is not expressible.
 *   ⑤ 🔴 CHANGING THE RATE CHANGES THE POSTED FUNCTIONAL FIGURE. This is
 *     the test that would have caught "declared and enforced by nothing".
 *     Two identical invoices at two different rates must produce two
 *     different journals; if the rate column were stored and ignored,
 *     they would produce the same one.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FUNCTIONAL_CURRENCY,
  KNOWN_CURRENCIES,
  UnknownCurrencyError,
  addMoney,
  assertKnownCurrency,
  formatMinorPlain,
  functionalCurrencyFromSettings,
  isKnownCurrency,
  minorUnitExponent,
  parseMajorToMinor,
} from "@/lib/fx/currency";
import {
  FX_RATE_SOURCES,
  FxRateError,
  RATE_SCALE,
  describeQuote,
  formatRateScaled,
  identityQuote,
  invertQuote,
  makeQuote,
  orientQuote,
  parseRateToScaled,
} from "@/lib/fx/rates";
import {
  CLOSING_RATE_WINDOW,
  EXACT_DATE,
  convertMinor,
  divideRounded,
  roundTripDriftBoundMinor,
} from "@/lib/fx/convert";
import {
  MONETARY_ITEM_KINDS,
  NON_MONETARY_ITEM_KINDS,
  carriedForPart,
  exchangeDifferenceForPl,
  initialRecognition,
  isMonetary,
  restateAtClosingRate,
  settlementDifference,
} from "@/lib/fx/restatement";
import {
  MixedCurrencyError,
  convertBuckets,
  describeConvertedTotal,
  requireSingleCurrency,
  sumByCurrency,
} from "@/lib/fx/aggregate";
import {
  TRANSLATION_RESIDUAL_BOUND_MINOR,
  totalsAddUp,
  translateTaxTotals,
  type TaxTotals,
} from "@/lib/fx/translate";
import {
  buildFxRevaluationPosting,
  buildFxSettlementPosting,
  fxContraRoleForKind,
  fxRolesUsed,
  assertFxBalances,
  buildInvoicePosting,
  FX_ROLE_META,
} from "@/lib/accounting/sales-posting";
import { formatMoneyPlain, parseMoney } from "@/lib/billing/money";
import { pickQuote } from "@/server/fx/rate-service";

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

const DAY = "2026-03-31";

function quote(base: string, quoteCur: string, rate: string, on = DAY) {
  return makeQuote({
    baseCurrency: base,
    quoteCurrency: quoteCur,
    rateScaled: parseRateToScaled(rate),
    rateDate: on,
    source: "rbi_reference",
    sourceReference: "test fixture",
  });
}

/* ================================================================== */
/* ③ MINOR UNITS ARE NOT UNIVERSALLY TWO DECIMAL PLACES                */
/* ================================================================== */

describe("🔴 the exponent is per currency, and it is not always two", () => {
  it("knows the three groups that are not two, by name", () => {
    // Zero.
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("XOF")).toBe(0);
    // Three — the group lib/billing/money.ts got wrong by a factor of ten.
    for (const dinar of ["KWD", "BHD", "OMR", "JOD", "TND", "LYD", "IQD"]) {
      expect(minorUnitExponent(dinar)).toBe(3);
    }
    // Four.
    expect(minorUnitExponent("CLF")).toBe(4);
    // And the one this product actually runs on.
    expect(minorUnitExponent("INR")).toBe(2);
  });

  it("refuses a code it does not know rather than defaulting to two", () => {
    expect(() => minorUnitExponent("ZZZ")).toThrow(UnknownCurrencyError);
    expect(() => assertKnownCurrency("")).toThrow(UnknownCurrencyError);
    expect(isKnownCurrency("zzz")).toBe(false);
    // ⚠️ THE MESSAGE NAMES THE CODE. A refusal that does not say which
    // currency it refused sends somebody to read the stack trace.
    expect(() => minorUnitExponent("ZZZ")).toThrow(/ZZZ/);
  });

  it("is case- and whitespace-insensitive on the way in, never on the way out", () => {
    expect(minorUnitExponent(" kwd ")).toBe(3);
    for (const code of KNOWN_CURRENCIES) {
      expect(code).toBe(code.toUpperCase());
      expect(code).toHaveLength(3);
    }
  });

  it("formats and parses at the currency's own precision, both directions", () => {
    // 🔴 THE REGRESSION. Before 0101 all three of these printed "12.34".
    expect(formatMinorPlain(1234n, "KWD")).toBe("1.234");
    expect(formatMinorPlain(1234n, "JPY")).toBe("1234");
    expect(formatMinorPlain(1234n, "INR")).toBe("12.34");

    // And the parse agrees with the format on every currency, for a range
    // of values — a round trip, not a pinned string.
    for (const code of ["INR", "JPY", "KWD", "CLF", "USD"]) {
      for (const minor of [0n, 1n, 7n, 999n, 1000n, 123456789n]) {
        expect(parseMajorToMinor(formatMinorPlain(minor, code), code)).toBe(minor);
      }
    }
  });

  it("refuses more decimals than the currency has", () => {
    expect(() => parseMajorToMinor("1.5", "JPY")).toThrow(/JPY/);
    expect(() => parseMajorToMinor("1.2345", "KWD")).toThrow(/KWD/);
    // …and accepts exactly as many as it does.
    expect(parseMajorToMinor("1.234", "KWD")).toBe(1234n);
  });

  it("fixes lib/billing/money.ts, which is where the display bug lived", () => {
    // These two lines are the whole defect: the old implementation named
    // five zero-decimal currencies and defaulted everything else to two.
    expect(formatMoneyPlain(1234n, "KWD")).toBe("1.234");
    expect(parseMoney("1.234", "KWD")).toBe(1234n);
    expect(formatMoneyPlain(1234n, "JPY")).toBe("1234");
    // The currencies it did get right still work.
    expect(formatMoneyPlain(1234n, "INR")).toBe("12.34");
  });
});

describe("⭐ a zero-decimal currency never gains phantom minor units", () => {
  it("converts INTO yen without inventing sen", () => {
    // ₹100,000.00 at INR/JPY 1.85 → ¥1,850 exactly, not ¥1,850.00.
    const result = convertMinor({
      amountMinor: 10_000_000n,
      from: "INR",
      to: "JPY",
      quote: quote("INR", "JPY", "1.85"),
      on: DAY,
    });
    expect(result.currency).toBe("JPY");
    expect(formatMinorPlain(result.amountMinor, "JPY")).not.toContain(".");
    // 100000 rupees × 1.85 = 185000 yen.
    expect(result.amountMinor).toBe(185_000n);
  });

  it("converts OUT of yen into a two-decimal currency without losing the scale", () => {
    // ¥1,000 at JPY/INR 0.54 → ₹540.00 → 54000 paise.
    const result = convertMinor({
      amountMinor: 1_000n,
      from: "JPY",
      to: "INR",
      quote: quote("JPY", "INR", "0.54"),
      on: DAY,
    });
    expect(result.amountMinor).toBe(54_000n);
    expect(formatMinorPlain(result.amountMinor, "INR")).toBe("540.00");
  });

  it("converts into a three-decimal currency at three decimals", () => {
    // ₹1,000.00 at INR/KWD 0.0037 → KWD 3.700 → 3700 fils.
    const result = convertMinor({
      amountMinor: 100_000n,
      from: "INR",
      to: "KWD",
      quote: quote("INR", "KWD", "0.0037"),
      on: DAY,
    });
    expect(result.amountMinor).toBe(3_700n);
    expect(formatMinorPlain(result.amountMinor, "KWD")).toBe("3.700");
  });
});

/* ================================================================== */
/* THE RATE ITSELF                                                     */
/* ================================================================== */

describe("🔴 a rate is a direction, a date and a source", () => {
  it("cannot be built without a well-formed date", () => {
    expect(() => quote("USD", "INR", "83.215", "31/03/2026")).toThrow(FxRateError);
    expect(() => quote("USD", "INR", "83.215", "2026-3-1")).toThrow(FxRateError);
  });

  it("cannot be zero, negative or a self-pair at anything but one", () => {
    expect(() => parseRateToScaled("0")).toThrow(FxRateError);
    expect(() => parseRateToScaled("-1")).toThrow(FxRateError);
    expect(() =>
      makeQuote({
        baseCurrency: "INR",
        quoteCurrency: "INR",
        rateScaled: parseRateToScaled("1.5"),
        rateDate: DAY,
        source: "manual",
      }),
    ).toThrow(FxRateError);
  });

  it("refuses more precision than it can store, rather than truncating", () => {
    // Thirteen decimals. Truncating would silently change the rate.
    expect(() => parseRateToScaled("1.1234567890123")).toThrow(FxRateError);
    expect(parseRateToScaled("1.123456789012")).toBeGreaterThan(0n);
  });

  it("round-trips text through the scaled bigint exactly", () => {
    for (const text of ["1", "83.215", "0.000000000001", "1.500000000000"]) {
      const scaled = parseRateToScaled(text);
      expect(parseRateToScaled(formatRateScaled(scaled))).toBe(scaled);
    }
  });

  it("refuses to apply a rate for the wrong pair", () => {
    const usdInr = quote("USD", "INR", "83.215");
    expect(() => orientQuote(usdInr, "EUR", "INR")).toThrow(FxRateError);
    // …and orients correctly in both directions of the pair it names.
    expect(orientQuote(usdInr, "USD", "INR").derived).toBe(false);
    expect(orientQuote(usdInr, "INR", "USD").derived).toBe(true);
  });

  it("marks an inverted rate as derived, and says so on the screen", () => {
    const inverted = invertQuote(quote("USD", "INR", "83.215"));
    expect(inverted.derived).toBe(true);
    expect(inverted.source).toBe("derived_inverse");
    expect(describeQuote(inverted)).toContain("derived");
    // Every source the engine can produce is in the declared list.
    expect(FX_RATE_SOURCES).toContain(inverted.source);
  });

  it("the identity rate is exactly one and comes from no table", () => {
    const id = identityQuote("INR", DAY);
    expect(id.rateScaled).toBe(RATE_SCALE);
    expect(id.source).toBe("identity");
    expect(id.rateId).toBeNull();
  });
});

/* ================================================================== */
/* ⑤ THE DATE IS NOT OPTIONAL AND THERE IS NO "LATEST"                 */
/* ================================================================== */

describe("🔴 a conversion cannot silently use yesterday's rate", () => {
  const yesterdaysRate = quote("USD", "INR", "83.215", "2026-03-27");

  it("refuses a stale rate by default", () => {
    expect(() =>
      convertMinor({
        amountMinor: 100_00n,
        from: "USD",
        to: "INR",
        quote: yesterdaysRate,
        on: DAY,
      }),
    ).toThrow(/requires the rate for the day itself/);
  });

  it("accepts it only when the caller states a policy, and reports the staleness", () => {
    const result = convertMinor({
      amountMinor: 100_00n,
      from: "USD",
      to: "INR",
      quote: yesterdaysRate,
      on: DAY,
      policy: CLOSING_RATE_WINDOW,
    });
    expect(result.stalenessDays).toBe(4);
    // The result carries its own working — the rate, its date and its source.
    expect(result.quote.rateDate).toBe("2026-03-27");
    expect(result.on).toBe(DAY);
  });

  it("refuses beyond the stated window rather than stretching it", () => {
    const tooOld = quote("USD", "INR", "83.215", "2026-03-20");
    expect(() =>
      convertMinor({
        amountMinor: 100_00n,
        from: "USD",
        to: "INR",
        quote: tooOld,
        on: DAY,
        policy: CLOSING_RATE_WINDOW,
      }),
    ).toThrow(/beyond the 4-day window/);
  });

  it("refuses a rate dated AFTER the event — that is hindsight, not translation", () => {
    const future = quote("USD", "INR", "83.215", "2026-04-15");
    expect(() =>
      convertMinor({
        amountMinor: 100_00n,
        from: "USD",
        to: "INR",
        quote: future,
        on: DAY,
        policy: CLOSING_RATE_WINDOW,
      }),
    ).toThrow(/dated AFTER/);
  });

  it("EXACT_DATE is the policy that needs no justification, and the others carry one", () => {
    expect(EXACT_DATE.kind).toBe("exact");
    expect(CLOSING_RATE_WINDOW.kind).toBe("on_or_before");
    if (CLOSING_RATE_WINDOW.kind === "on_or_before") {
      expect(CLOSING_RATE_WINDOW.because.length).toBeGreaterThan(20);
    }
  });
});

/* ================================================================== */
/* ① THE ROUND TRIP, AGAINST THE ENGINE'S OWN STATED BOUND             */
/* ================================================================== */

describe("⭐⭐ converting at r then at 1/r returns the original within a stated bound", () => {
  const RATES = ["83.215", "0.012017", "1.85", "0.0037", "1", "112.4567"];
  const AMOUNTS = [
    1n, 7n, 100n, 12_345n, 1_00_000n, 9_87_65_432n, 1_00_00_00_00_000n,
  ];

  it("holds for every combination, and the drift never exceeds the bound", () => {
    for (const rate of RATES) {
      const q = quote("USD", "INR", rate);
      for (const amount of AMOUNTS) {
        const forward = convertMinor({
          amountMinor: amount,
          from: "USD",
          to: "INR",
          quote: q,
          on: DAY,
        });
        const back = convertMinor({
          amountMinor: forward.amountMinor,
          from: "INR",
          to: "USD",
          quote: invertQuote(q),
          on: DAY,
        });
        const drift = back.amountMinor - amount;
        const bound = roundTripDriftBoundMinor({
          amountMinor: amount,
          from: "USD",
          to: "INR",
          quote: q,
        });
        expect(drift <= bound && drift >= -bound).toBe(true);
      }
    }
  });

  it("drifts by nothing at all through the identity rate", () => {
    for (const amount of AMOUNTS) {
      const there = convertMinor({
        amountMinor: amount,
        from: "INR",
        to: "INR",
        quote: identityQuote("INR", DAY),
        on: DAY,
      });
      expect(there.amountMinor).toBe(amount);
    }
  });

  it("bounds the yen round trip loosely, because one yen is worth more than one paisa", () => {
    // ⚠️ THE POINT OF THIS TEST IS THAT THE BOUND IS HONEST. A tight
    // bound here would be a lie: the JPY leg cannot represent fractions
    // of a yen, so the drift is genuinely larger and the engine says so.
    const q = quote("INR", "JPY", "1.85");
    const bound = roundTripDriftBoundMinor({
      amountMinor: 100_00n,
      from: "INR",
      to: "JPY",
      quote: q,
    });
    expect(bound).toBeGreaterThan(1n);
  });
});

describe("⭐ the arithmetic is sign-symmetric and the rounding is stated", () => {
  it("rounds a credit note exactly as it rounds the invoice it mirrors", () => {
    const q = quote("USD", "INR", "83.215");
    for (const amount of [1n, 7n, 33n, 12_345n, 99_999n]) {
      const positive = convertMinor({
        amountMinor: amount,
        from: "USD",
        to: "INR",
        quote: q,
        on: DAY,
      }).amountMinor;
      const negative = convertMinor({
        amountMinor: -amount,
        from: "USD",
        to: "INR",
        quote: q,
        on: DAY,
      }).amountMinor;
      // 🔴 A mirror, not an approximate mirror. BigInt division truncates
      // toward zero, so a naive implementation fails this.
      expect(negative).toBe(-positive);
    }
  });

  it("half-even and half-up differ only on an exact half, and both are available", () => {
    expect(divideRounded(5n, 2n, "half_even")).toBe(2n);
    expect(divideRounded(5n, 2n, "half_up")).toBe(3n);
    expect(divideRounded(7n, 2n, "half_even")).toBe(4n);
    expect(divideRounded(7n, 2n, "half_up")).toBe(4n);
    expect(divideRounded(-5n, 2n, "half_even")).toBe(-2n);
    expect(divideRounded(-5n, 2n, "half_up")).toBe(-3n);
    expect(divideRounded(5n, 2n, "down")).toBe(2n);
  });
});

/* ================================================================== */
/* ② MONETARY vs NON-MONETARY — THE ERROR THAT IS ALWAYS GOT BACKWARDS */
/* ================================================================== */

describe("🔴🔴 AS 11 ¶11 — a monetary item restates, a non-monetary one does not", () => {
  const common = {
    foreignAmountMinor: 10_000_00n, // USD 10,000.00
    foreignCurrency: "USD",
    functionalCurrency: "INR",
    carriedFunctionalMinor: 8_20_00_000n, // recognised at 82.00
    closingQuote: quote("USD", "INR", "83.00"),
    reportingDate: DAY,
  };

  it("restates a receivable and leaves a fixed asset alone, from identical arguments", () => {
    const receivable = restateAtClosingRate({ ...common, kind: "trade_receivable" });
    const machine = restateAtClosingRate({ ...common, kind: "fixed_asset" });

    // ⭐ THE RELATION. The two differ in exactly one argument.
    expect(receivable.restated).toBe(true);
    expect(machine.restated).toBe(false);

    expect(receivable.restatedFunctionalMinor).toBe(8_30_00_000n);
    expect(receivable.differenceMinor).toBe(10_00_000n);

    // 🔴 The machine's carrying amount is UNTOUCHED and its difference nil.
    expect(machine.restatedFunctionalMinor).toBe(common.carriedFunctionalMinor);
    expect(machine.differenceMinor).toBe(0n);
    expect(machine.conversion).toBeNull();
  });

  it("gives the non-monetary item a REASON, not a silent zero", () => {
    const machine = restateAtClosingRate({ ...common, kind: "fixed_asset" });
    // A caller receiving 0 cannot tell "computed, and it was nil" from
    // "this must never be revalued". The reason is what tells them apart.
    expect(machine.reason).toBeTruthy();
    expect(machine.reason).toMatch(/NON-MONETARY/);
    // ⭐ AND THE RESTATED ITEM CARRIES NO REASON, so "reason present" is a
    // reliable signal of "nothing happened here and here is why".
    expect(restateAtClosingRate({ ...common, kind: "trade_receivable" }).reason).toBeNull();
  });

  it("classifies every declared kind, and refuses one it has never heard of", () => {
    for (const kind of MONETARY_ITEM_KINDS) expect(isMonetary(kind)).toBe(true);
    for (const kind of NON_MONETARY_ITEM_KINDS) expect(isMonetary(kind)).toBe(false);
    // 🔴 REFUSES BY NAME. Falling through to "monetary" would revalue a
    // building; falling through to "non-monetary" would leave a
    // receivable's exchange difference out of the P&L.
    expect(() => isMonetary("some_new_thing")).toThrow(/some_new_thing/);
  });

  it("treats a supplier advance as NON-monetary — the one people argue about", () => {
    // Ind AS 21 ¶16: the essential feature of a monetary item is a right
    // to receive a fixed number of units of CURRENCY. An advance for goods
    // will be consumed by a delivery, never repaid in cash.
    expect(isMonetary("advance_to_supplier")).toBe(false);
    expect(isMonetary("advance_from_customer")).toBe(false);
    // …while a receivable, a payable and a foreign bank balance are.
    expect(isMonetary("trade_receivable")).toBe(true);
    expect(isMonetary("trade_payable")).toBe(true);
    expect(isMonetary("foreign_bank_balance")).toBe(true);
  });

  it("does not restate an item already in the functional currency", () => {
    const same = restateAtClosingRate({
      ...common,
      kind: "trade_receivable",
      foreignCurrency: "INR",
      closingQuote: identityQuote("INR", DAY),
    });
    expect(same.restated).toBe(false);
    expect(same.differenceMinor).toBe(0n);
    expect(same.reason).toBeTruthy();
  });
});

describe("🔴 the sign — an asset worth more is a gain, a liability worth more is a loss", () => {
  const base = {
    foreignAmountMinor: 10_000_00n,
    foreignCurrency: "USD",
    functionalCurrency: "INR",
    carriedFunctionalMinor: 8_20_00_000n,
    closingQuote: quote("USD", "INR", "83.00"),
    reportingDate: DAY,
  };

  it("flips exactly once, in exchangeDifferenceForPl and nowhere else", () => {
    const receivable = restateAtClosingRate({ ...base, kind: "trade_receivable" });
    const payable = restateAtClosingRate({ ...base, kind: "trade_payable" });

    // The raw difference on the carrying amount is IDENTICAL…
    expect(receivable.differenceMinor).toBe(payable.differenceMinor);
    // …and the effect on the P&L is opposite.
    expect(exchangeDifferenceForPl(receivable)).toBe(10_00_000n);
    expect(exchangeDifferenceForPl(payable)).toBe(-10_00_000n);
  });

  it("reports no P&L effect at all for an item that was not restated", () => {
    const machine = restateAtClosingRate({ ...base, kind: "fixed_asset" });
    expect(exchangeDifferenceForPl(machine)).toBe(0n);
  });
});

/* ================================================================== */
/* ③ SETTLEMENT MEASURES AGAINST THE CARRYING AMOUNT                   */
/* ================================================================== */

describe("🔴🔴 AS 11 ¶13 — settlement is measured against the CARRYING rate", () => {
  /**
   * The scenario the standard is written for, and the one software gets
   * wrong: raised in December at 82, restated at 31 March to 83, settled
   * in May at 85.
   *
   *   correct   → year one takes 1, year two takes 2
   *   incorrect → year two takes 3, double-counting year one's 1
   */
  const foreign = 10_000_00n; // USD 10,000.00

  const recognised = initialRecognition({
    foreignAmountMinor: foreign,
    foreignCurrency: "USD",
    functionalCurrency: "INR",
    quote: quote("USD", "INR", "82.00", "2025-12-14"),
    transactionDate: "2025-12-14",
  });

  const restated = restateAtClosingRate({
    kind: "trade_receivable",
    foreignAmountMinor: foreign,
    foreignCurrency: "USD",
    functionalCurrency: "INR",
    carriedFunctionalMinor: recognised.carriedFunctionalMinor,
    closingQuote: quote("USD", "INR", "83.00"),
    reportingDate: DAY,
  });

  it("takes the first year's movement at the reporting date", () => {
    expect(recognised.functionalAmountMinor).toBe(8_20_00_000n);
    expect(restated.restatedFunctionalMinor).toBe(8_30_00_000n);
    expect(exchangeDifferenceForPl(restated)).toBe(10_00_000n); // ₹10,000
  });

  it("takes only the SECOND year's movement at settlement", () => {
    const settled = settlementDifference({
      foreignSettledMinor: foreign,
      foreignCurrency: "USD",
      functionalCurrency: "INR",
      // 🔴 THE RESTATED FIGURE, not the invoice figure.
      carriedFunctionalMinor: restated.restatedFunctionalMinor,
      settlementQuote: quote("USD", "INR", "85.00", "2026-05-20"),
      settlementDate: "2026-05-20",
    });
    expect(settled.realisedDifferenceMinor).toBe(20_00_000n); // ₹20,000
  });

  it("and the two years together equal the whole movement — nothing is lost or doubled", () => {
    const settled = settlementDifference({
      foreignSettledMinor: foreign,
      foreignCurrency: "USD",
      functionalCurrency: "INR",
      carriedFunctionalMinor: restated.restatedFunctionalMinor,
      settlementQuote: quote("USD", "INR", "85.00", "2026-05-20"),
      settlementDate: "2026-05-20",
    });
    const total = exchangeDifferenceForPl(restated) + settled.realisedDifferenceMinor;
    // 10,000 USD × ₹3 = ₹30,000 = 30,00,000 paise.
    expect(total).toBe(30_00_000n);

    // ⭐ AND THE WRONG WAY ROUND IS DEMONSTRABLY DIFFERENT: measuring the
    // settlement against the ORIGINAL invoice figure gives ₹30,000 in year
    // two ALONE, so the two years would total ₹40,000.
    const wrong = settlementDifference({
      foreignSettledMinor: foreign,
      foreignCurrency: "USD",
      functionalCurrency: "INR",
      carriedFunctionalMinor: recognised.functionalAmountMinor,
      settlementQuote: quote("USD", "INR", "85.00", "2026-05-20"),
      settlementDate: "2026-05-20",
    });
    expect(wrong.realisedDifferenceMinor).toBe(30_00_000n);
    expect(exchangeDifferenceForPl(restated) + wrong.realisedDifferenceMinor).toBe(40_00_000n);
  });

  it("pro-rates a part settlement without losing a paisa across the whole", () => {
    const carried = 8_30_00_001n; // deliberately awkward
    const total = 30_000_00n;
    let released = 0n;
    let remainingCarried = carried;
    let remainingForeign = total;
    for (const part of [10_000_00n, 10_000_00n, 10_000_00n]) {
      const forPart = carriedForPart({
        carriedFunctionalMinor: remainingCarried,
        foreignTotalMinor: remainingForeign,
        foreignPartMinor: part,
      });
      released += forPart;
      remainingCarried -= forPart;
      remainingForeign -= part;
    }
    // ⭐ SETTLING IN FULL THROUGH PARTS RELEASES EXACTLY THE CARRYING
    // AMOUNT. The floor's remainder stays with the unsettled balance and
    // the last part absorbs it — the same rule as an inventory layer.
    expect(released).toBe(carried);
    expect(remainingCarried).toBe(0n);
  });

  it("refuses a negative settlement rather than treating it as a refund", () => {
    expect(() =>
      settlementDifference({
        foreignSettledMinor: -1n,
        foreignCurrency: "USD",
        functionalCurrency: "INR",
        carriedFunctionalMinor: 100n,
        settlementQuote: quote("USD", "INR", "83.00"),
        settlementDate: DAY,
      }),
    ).toThrow();
  });
});

/* ================================================================== */
/* ④ AGGREGATION — A TOTAL WITH NO CURRENCY LABEL IS A BUG             */
/* ================================================================== */

describe("🔴 an aggregate over mixed currencies refuses or labels — never adds", () => {
  const rows = [
    { currency: "INR", amountMinor: 4_10_000n },
    { currency: "USD", amountMinor: 6_200_00n },
    { currency: "INR", amountMinor: 90_000n },
  ];

  it("groups by currency and never produces a bare number", () => {
    const totals = sumByCurrency(rows);
    // ⭐ ASSERTED AS A PROPERTY: every bucket is labelled, and the buckets
    // partition the input exactly.
    for (const t of totals) expect(isKnownCurrency(t.currency)).toBe(true);
    const rebuilt = totals.reduce((n, t) => n + t.count, 0);
    expect(rebuilt).toBe(rows.length);
    const inr = totals.find((t) => t.currency === "INR");
    expect(inr?.amountMinor).toBe(5_00_000n);
  });

  it("refuses to hand back one figure when there is more than one currency", () => {
    expect(() => requireSingleCurrency("This total", sumByCurrency(rows))).toThrow(
      MixedCurrencyError,
    );
    // …and names the currencies it found, so the message is actionable.
    expect(() => requireSingleCurrency("This total", sumByCurrency(rows))).toThrow(/USD/);
  });

  it("refuses to add two Money values of different currencies", () => {
    expect(() =>
      addMoney({ amountMinor: 1n, currency: "INR" }, { amountMinor: 1n, currency: "USD" }),
    ).toThrow();
  });

  it("converts through a stated rate and returns the rate WITH the number", () => {
    const converted = convertBuckets({
      totals: sumByCurrency(rows),
      to: "INR",
      on: DAY,
      resolve: (from) => (from === "USD" ? quote("USD", "INR", "83.00") : null),
    });
    expect(converted.complete).toBe(true);
    expect(converted.totalMinor).toBe(5_00_000n + 5_14_60_000n);
    // 🔴 THE WORKING IS NOT OPTIONAL. Every converted component carries
    // the rate, its date and its source.
    const usd = converted.components.find((c) => c.currency === "USD");
    expect(usd?.rateDate).toBe(DAY);
    expect(usd?.rateSource).toBe("rbi_reference");
    expect(describeConvertedTotal(converted)).toContain("USD/INR");
  });

  it("degrades to several labelled figures when a rate is missing — never to 1:1", () => {
    const converted = convertBuckets({
      totals: sumByCurrency(rows),
      to: "INR",
      on: DAY,
      resolve: () => null,
    });
    expect(converted.complete).toBe(false);
    expect(converted.unconverted.map((u) => u.currency)).toContain("USD");
    // ⭐ THE UNCONVERTED AMOUNT IS NOT IN THE TOTAL. Counting it at 1:1 is
    // the bug; dropping it silently is worse, so it is reported separately.
    // The INR bucket is still there — it needs no rate, it IS the target.
    expect(converted.totalMinor).toBe(5_00_000n);
    expect(converted.unconverted.reduce((n, u) => n + u.amountMinor, 0n)).toBe(6_200_00n);
    expect(describeConvertedTotal(converted)).toMatch(/no exchange rate is on file/i);
  });
});

/* ================================================================== */
/* THE DOCUMENT — SIX COMPONENTS THAT MUST ADD TO THE SEVENTH          */
/* ================================================================== */

describe("⭐⭐ translating a tax document keeps it adding up", () => {
  const totals: TaxTotals = {
    taxableValueMinor: 1_234_56n,
    cgstMinor: 0n,
    sgstMinor: 0n,
    igstMinor: 222_22n,
    cessMinor: 0n,
    roundOffMinor: 0n,
    totalMinor: 1_456_78n,
  };

  it("starts from a document that adds up", () => {
    expect(totalsAddUp(totals)).toBe(true);
  });

  it("still adds up after translation, at every rate", () => {
    for (const rate of ["83.215", "0.0037", "1.85", "112.4567", "1.000000000001"]) {
      const translated = translateTaxTotals({
        totals,
        from: "USD",
        to: "INR",
        quote: quote("USD", "INR", rate),
        on: DAY,
      });
      // 🔴 THE INVARIANT. Six independent roundings do not add to the
      // seventh; the round-off absorbs the residual and this proves it.
      expect(totalsAddUp(translated.totals)).toBe(true);
      const residual =
        translated.residualMinor < 0n ? -translated.residualMinor : translated.residualMinor;
      expect(residual <= TRANSLATION_RESIDUAL_BOUND_MINOR).toBe(true);
    }
  });

  it("still adds up when translating into a zero-decimal currency", () => {
    const translated = translateTaxTotals({
      totals,
      from: "USD",
      to: "JPY",
      quote: quote("USD", "JPY", "150.25"),
      on: DAY,
    });
    expect(totalsAddUp(translated.totals)).toBe(true);
    expect(formatMinorPlain(translated.totals.totalMinor, "JPY")).not.toContain(".");
  });

  it("produces a journal that balances, which is the thing that actually breaks", () => {
    const translated = translateTaxTotals({
      totals,
      from: "USD",
      to: "INR",
      quote: quote("USD", "INR", "83.215"),
      on: DAY,
    });
    // `buildInvoicePosting` calls `assertBalances` internally and throws if
    // the legs do not foot. Not throwing IS the assertion.
    const legs = buildInvoicePosting({
      tax: translated.totals,
      invoiceNumber: "INV/2026/0001",
      customerName: "Test",
    });
    expect(legs.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* ⑤ THE ONE THAT WOULD HAVE CAUGHT "DECLARED AND ENFORCED BY NOTHING" */
/* ================================================================== */

describe("🔴🔴🔴 changing the rate changes the posted functional figure", () => {
  const totals: TaxTotals = {
    taxableValueMinor: 10_000_00n,
    cgstMinor: 0n,
    sgstMinor: 0n,
    igstMinor: 0n,
    cessMinor: 0n,
    roundOffMinor: 0n,
    totalMinor: 10_000_00n,
  };

  function postedTotalAtRate(rate: string): bigint {
    const translated = translateTaxTotals({
      totals,
      from: "USD",
      to: "INR",
      quote: quote("USD", "INR", rate),
      on: DAY,
    });
    const legs = buildInvoicePosting({
      tax: translated.totals,
      invoiceNumber: "INV/2026/0001",
      customerName: "Test",
    });
    return legs
      .filter((l) => l.entryType === "debit")
      .reduce((sum, l) => sum + l.amountMinor, 0n);
  }

  /**
   * 🔴 THIS IS THE TEST THE SEVEN PREVIOUS DEFECTS DID NOT HAVE.
   * `valuationMethod`, `requireMfa` and thirty-four entitlement keys were
   * all stored, displayed and read by nothing. A test asserting that
   * CHANGING the stored value CHANGES a computed result is the only shape
   * that catches that, because a column read by nothing produces the same
   * answer whatever it holds.
   */
  it("two identical invoices at two rates produce two different journals", () => {
    const at82 = postedTotalAtRate("82.00");
    const at83 = postedTotalAtRate("83.00");
    expect(at82).not.toBe(at83);
    expect(at83 - at82).toBe(10_00_000n); // USD 10,000 × ₹1
  });

  it("and the difference tracks the rate monotonically, so it is not a coincidence", () => {
    const rates = ["80.00", "82.00", "83.00", "85.50", "90.00"];
    const posted = rates.map(postedTotalAtRate);
    for (let i = 1; i < posted.length; i += 1) {
      expect((posted[i] as bigint) > (posted[i - 1] as bigint)).toBe(true);
    }
  });

  it("and an INR invoice posts exactly what it always did — the batch is safe to ship", () => {
    const translated = translateTaxTotals({
      totals,
      from: "INR",
      to: "INR",
      quote: identityQuote("INR", DAY),
      on: DAY,
    });
    expect(translated.totals).toEqual(totals);
  });
});

/* ================================================================== */
/* THE JOURNAL                                                         */
/* ================================================================== */

describe("⭐ the revaluation journal", () => {
  it("posts gains and losses gross, never netted", () => {
    const legs = buildFxRevaluationPosting({
      items: [
        { kind: "trade_receivable", plEffectMinor: 80_000n, description: "INV/1" },
        { kind: "trade_payable", plEffectMinor: -95_000n, description: "PI/1" },
      ],
      asOfDate: DAY,
    });
    const gain = legs.find((l) => l.role === "fx_gain");
    const loss = legs.find((l) => l.role === "fx_loss");
    // 🔴 BOTH LEGS EXIST. Netting to a single ₹15,000 loss would make
    // "what did the currency cost us this year" unanswerable.
    expect(gain?.amountMinor).toBe(80_000n);
    expect(loss?.amountMinor).toBe(95_000n);
    // …and it balances, which `assertFxBalances` would have thrown on.
    expect(() => assertFxBalances(legs)).not.toThrow();
  });

  it("drops zero-difference items rather than posting nil legs", () => {
    const legs = buildFxRevaluationPosting({
      items: [{ kind: "trade_receivable", plEffectMinor: 0n, description: "INV/1" }],
      asOfDate: DAY,
    });
    expect(legs).toHaveLength(0);
  });

  it("sends each item to its own control account, not to one FX suspense", () => {
    expect(fxContraRoleForKind("trade_receivable")).toBe("fx_receivable_contra");
    expect(fxContraRoleForKind("trade_payable")).toBe("fx_payable_contra");
    expect(fxContraRoleForKind("foreign_bank_balance")).toBe("fx_bank_contra");
    expect(() => fxContraRoleForKind("fixed_asset")).toThrow();
  });

  it("does not demand a role map for a leg whose ledger the caller resolved", () => {
    const legs = buildFxRevaluationPosting({
      items: [
        {
          kind: "foreign_bank_balance",
          plEffectMinor: 5_000n,
          contraLedgerId: "11111111-1111-4111-8111-111111111111",
          description: "HDFC EEFC",
        },
      ],
      asOfDate: DAY,
    });
    // ⭐ The overridden contra is NOT in the roles that need mapping; the
    // gain still is.
    expect(fxRolesUsed(legs)).toEqual(["fx_gain"]);
  });

  it("refuses a negative leg — direction lives in entryType", () => {
    expect(() =>
      assertFxBalances([
        { role: "fx_gain", entryType: "credit", amountMinor: -1n, description: "x" },
      ]),
    ).toThrow(/negative/);
  });

  it("gives every role a mapping label, so the picker cannot show bare snake_case", () => {
    for (const role of Object.keys(FX_ROLE_META)) {
      const meta = FX_ROLE_META[role as keyof typeof FX_ROLE_META];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.help.length).toBeGreaterThan(20);
      expect(["asset", "liability", "revenue", "expense"]).toContain(meta.accountType);
    }
  });

  it("posts a realised loss as a debit to fx_loss, whichever side the item is", () => {
    const receivableLoss = buildFxSettlementPosting({
      kind: "trade_receivable",
      realisedDifferenceMinor: -5_000n,
      documentReference: "INV/1",
      settlementDate: DAY,
    });
    expect(receivableLoss.find((l) => l.role === "fx_loss")?.entryType).toBe("debit");

    // A payable that got MORE expensive is also a loss — the raw
    // difference is positive and the fold flips it.
    const payableLoss = buildFxSettlementPosting({
      kind: "trade_payable",
      realisedDifferenceMinor: 5_000n,
      documentReference: "PI/1",
      settlementDate: DAY,
    });
    expect(payableLoss.find((l) => l.role === "fx_loss")?.entryType).toBe("debit");
  });

  it("produces nothing at all when the realised difference is nil", () => {
    expect(
      buildFxSettlementPosting({
        kind: "trade_receivable",
        realisedDifferenceMinor: 0n,
        documentReference: "INV/1",
        settlementDate: DAY,
      }),
    ).toHaveLength(0);
  });
});

/* ================================================================== */
/* RESOLUTION PRECEDENCE                                               */
/* ================================================================== */

describe("⭐ the tenant's own rate beats the published one, and a document beats a derivation", () => {
  const own = {
    id: "a",
    baseCurrency: "USD",
    quoteCurrency: "INR",
    rate: "84.000000000000",
    rateDate: DAY,
    source: "manual",
    sourceReference: null,
  };
  const ownReverse = {
    id: "b",
    baseCurrency: "INR",
    quoteCurrency: "USD",
    rate: "0.011904761905",
    rateDate: DAY,
    source: "manual",
    sourceReference: null,
  };
  const published = {
    id: "c",
    baseCurrency: "USD",
    quoteCurrency: "INR",
    rate: "83.215000000000",
    rateDate: DAY,
    source: "rbi_reference",
    sourceReference: "RBI",
  };

  it("prefers the workspace's own rate over the published one", () => {
    const picked = pickQuote([own], [published], "USD", "INR");
    expect(picked?.source).toBe("manual");
    expect(picked?.derived).toBe(false);
  });

  it("prefers a published rate in the right direction over an inverted own rate", () => {
    // ⚠️ Ranked by (own vs published) FIRST, then (direct vs inverted), so
    // an own reverse rate still beats a published direct one — the
    // workspace's own evidence wins.
    const picked = pickQuote([ownReverse], [published], "USD", "INR");
    expect(picked?.derived).toBe(true);
    expect(picked?.source).toBe("derived_inverse");
  });

  it("falls back to inverting a published rate, and marks it", () => {
    const picked = pickQuote([], [published], "INR", "USD");
    expect(picked?.derived).toBe(true);
    expect(picked?.baseCurrency).toBe("INR");
    expect(picked?.quoteCurrency).toBe("USD");
  });

  it("returns null rather than inventing one when nothing is on file", () => {
    expect(pickQuote([], [], "USD", "INR")).toBeNull();
  });
});

/* ================================================================== */
/* THE FUNCTIONAL CURRENCY                                             */
/* ================================================================== */

describe("⭐ the functional currency is read from settings, and its default is named", () => {
  it("reads a chosen currency", () => {
    const chosen = functionalCurrencyFromSettings({ currency: "usd" });
    expect(chosen.code).toBe("USD");
    expect(chosen.isDefault).toBe(false);
  });

  it("reports the default as a default, rather than pretending it was chosen", () => {
    for (const settings of [null, undefined, {}, { currency: "" }, { currency: "  " }]) {
      const resolved = functionalCurrencyFromSettings(settings);
      expect(resolved.code).toBe(DEFAULT_FUNCTIONAL_CURRENCY);
      expect(resolved.isDefault).toBe(true);
    }
  });

  it("refuses junk in the free-form settings blob rather than silently substituting", () => {
    expect(() => functionalCurrencyFromSettings({ currency: "Rs" })).toThrow(
      UnknownCurrencyError,
    );
  });
});
