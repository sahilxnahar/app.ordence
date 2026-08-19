/**
 * Ordence — ⭐⭐⭐ RULE 26 · TDS ON A PAYMENT IN FOREIGN CURRENCY (Batch 0106)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE ASSERTIONS AND NOT OTHERS
 * ══════════════════════════════════════════════════════════════════════
 * Every failure this batch closes produces a voucher that foots. A mid
 * rate used where Rule 26 names the telegraphic transfer BUYING rate, or
 * the payment date used where the statute names the date the tax is
 * REQUIRED to be deducted, gives a chargeable base that is wrong by the
 * half-spread or by a fortnight of the dollar — and nothing on the screen
 * says so. s.201(1) then makes the deductor personally liable for the
 * shortfall and s.201(1A) charges interest on it monthly.
 *
 * So nothing below pins a count, an id or a total. Every test asserts a
 * PROPERTY, or a RELATION between two runs that differ in exactly one
 * thing:
 *
 *   ① THE RATE TYPE IS A FILTER, NOT A PREFERENCE. Given a mid rate and a
 *     TT buying rate for the same pair on the same day, the mid is not
 *     ranked, not picked and not returned — asserted with the mid FIRST
 *     in the candidate list, so ordering cannot be what makes it pass.
 *   ② NO TT BUYING RATE FOR THE REQUIRED DATE MEANS A REFUSAL, and the
 *     refusal names the rate type, the pair and the day. Asserted on the
 *     resolver's ranking half AND on the pure gate, because a fallback
 *     could be introduced in either.
 *   ③ 🔴 THE RATE TYPE CHANGES THE MONEY. Two measurements identical in
 *     every argument except which side of the spread is asked for produce
 *     different chargeable bases and different tax. If the column were
 *     stored and ignored — the twelve-times-recorded failure in this
 *     codebase — they would produce the same figure.
 *   ④ ROUNDING IS HALF-UP, THE SAME DIRECTION `applyRateBps` USES, and the
 *     whole computation foots: the base is the nearest paisa to the
 *     foreign amount at the rate, and net + tax = base exactly.
 *   ⑤ THE SPECIFIED DATE IS THE EARLIER OF CREDIT AND PAYMENT — never the
 *     invoice date, and not the payment date whenever the credit came
 *     first — and the rate date is that date and cannot be anything else.
 *   ⑥ THE DOMESTIC PATH IS UNTOUCHED. A rupee payment resolves to identity
 *     from no table, and an `unstated` rate — which is every row written
 *     before 0106 — still converts exactly as it did for AS 11.
 */

import { describe, expect, it } from "vitest";

import { applyRateBps } from "@/lib/billing/money";
import {
  DEFAULT_ROUNDING,
  EXACT_DATE,
  convertMinor,
} from "@/lib/fx/convert";
import { minorUnitExponent } from "@/lib/fx/currency";
import {
  RATE_SCALE,
  identityQuote,
  invertQuote,
  makeQuote,
  parseRateToScaled,
  type FxQuote,
  type FxRateType,
} from "@/lib/fx/rates";
import {
  RULE_26_TT_BUYING,
  STATUTORY_CONVERSIONS,
  StatutoryRateError,
  assertStatutoryQuote,
  convertUnderStatute,
  type StatutoryConversion,
} from "@/lib/fx/statutory";
import {
  ForeignPaymentTdsError,
  TDS_FUNCTIONAL_CURRENCY,
  deductionDateFor,
  foreignPaymentBase,
} from "@/lib/tds/foreign-payments";
import { pickQuote } from "@/server/fx/rate-service";

/* ------------------------------------------------------------------ */
/* FIXTURES — the same day, the same pair, three different numbers.    */
/* ------------------------------------------------------------------ */

const DEDUCTION_DAY = "2026-03-31";
const DAY_BEFORE = "2026-03-30";
const FOREIGN = "USD";

/**
 * ⚠️ THE THREE NUMBERS ARE DELIBERATELY FAR APART AND IN THE ORDER A BANK
 * QUOTES THEM — it buys below the mid and sells above it. Nothing below
 * asserts these values; they exist so that "the wrong one was used" is a
 * difference a test can see rather than a rounding coincidence.
 */
const RATES: Record<"tt_buying" | "mid" | "tt_selling", string> = {
  tt_buying: "83.2000",
  mid: "83.6000",
  tt_selling: "84.0000",
};

function quoteOf(
  rateType: FxRateType,
  opts: { rate?: string; rateDate?: string; derived?: boolean } = {},
): FxQuote {
  return makeQuote({
    baseCurrency: FOREIGN,
    quoteCurrency: TDS_FUNCTIONAL_CURRENCY,
    rateScaled: parseRateToScaled(
      opts.rate ?? RATES[rateType as keyof typeof RATES] ?? RATES.mid,
    ),
    rateDate: opts.rateDate ?? DEDUCTION_DAY,
    source: "manual",
    rateType,
    sourceReference: "the bank's advice for this remittance",
    ...(opts.derived === undefined ? {} : { derived: opts.derived }),
  });
}

/** A candidate row in the shape `pickQuote` ranks. */
function row(rateType: FxRateType, rateDate = DEDUCTION_DAY) {
  return {
    id: `row-${rateType}-${rateDate}`,
    baseCurrency: FOREIGN,
    quoteCurrency: TDS_FUNCTIONAL_CURRENCY,
    rate: RATES[rateType as keyof typeof RATES] ?? RATES.mid,
    rateDate,
    source: "manual",
    rateType,
    sourceReference: null,
  };
}

/* ================================================================== */
/* ① THE RATE TYPE IS A FILTER                                        */
/* ================================================================== */

describe("Rule 26 · the telegraphic transfer buying rate is the one that is used", () => {
  it("serves the TT buying rate and does not serve the mid rate for the same pair and day", () => {
    // ⚠️ THE MID IS FIRST. If the rate type were merely a tie-break, or a
    // preference applied after ranking, this ordering would surface it.
    const candidates = [row("mid"), row("tt_buying"), row("tt_selling")];

    const served = pickQuote(candidates, [], FOREIGN, TDS_FUNCTIONAL_CURRENCY, "tt_buying");

    expect(served).not.toBeNull();
    expect(served?.rateType).toBe(RULE_26_TT_BUYING.rateType);
    expect(served?.rateScaled).toBe(parseRateToScaled(RATES.tt_buying));
    // The relation that matters: it is NOT either of the other two numbers.
    expect(served?.rateScaled).not.toBe(parseRateToScaled(RATES.mid));
    expect(served?.rateScaled).not.toBe(parseRateToScaled(RATES.tt_selling));
  });

  it("measures the payment at the served rate and at no other rate on file", () => {
    const candidates = [row("mid"), row("tt_buying")];
    const served = pickQuote(candidates, [], FOREIGN, TDS_FUNCTIONAL_CURRENCY, "tt_buying");
    const amountMinor = 10_000_000n; // US$100,000, in cents

    const measured = foreignPaymentBase({
      foreignAmountMinor: amountMinor,
      foreignCurrency: FOREIGN,
      deductionDate: DEDUCTION_DAY,
      quote: served as FxQuote,
    });

    const atTheMid = convertMinor({
      amountMinor,
      from: FOREIGN,
      to: TDS_FUNCTIONAL_CURRENCY,
      quote: quoteOf("mid"),
      on: DEDUCTION_DAY,
      policy: EXACT_DATE,
      rounding: RULE_26_TT_BUYING.rounding,
    });

    expect(measured.quote.rateType).toBe(RULE_26_TT_BUYING.rateType);
    expect(measured.chargeableBaseMinor).not.toBe(atTheMid.amountMinor);
    expect(measured.statutoryRef).toContain("Rule 26");
  });

  it("refuses a rate it computed by inversion, however close the arithmetic", () => {
    // The buying side of one direction is the selling side of the other,
    // and the two are not reciprocals. `invertQuote` must not carry a
    // spread side across, and the gate must refuse what it produces.
    const published = quoteOf("tt_buying");
    const inverted = invertQuote(published);

    expect(inverted.rateType).not.toBe("tt_buying");
    expect(inverted.derived).toBe(true);

    const backAgain = invertQuote(inverted);
    expect(() =>
      assertStatutoryQuote({
        quote: backAgain,
        conversion: RULE_26_TT_BUYING,
        on: DEDUCTION_DAY,
        from: FOREIGN,
        to: TDS_FUNCTIONAL_CURRENCY,
      }),
    ).toThrow(StatutoryRateError);
  });

  it("keeps every registered statutory conversion naming a real rate type and a rule", () => {
    expect(STATUTORY_CONVERSIONS.length).toBeGreaterThan(0);
    for (const conversion of STATUTORY_CONVERSIONS) {
      expect(["mid", "tt_buying", "tt_selling"]).toContain(conversion.rateType);
      expect(conversion.statutoryRef.trim().length).toBeGreaterThan(0);
      expect(conversion.dateMeans.trim().length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/* ② NO TT BUYING RATE FOR THE REQUIRED DATE → A REFUSAL              */
/* ================================================================== */

describe("Rule 26 · with no TT buying rate for the required date, the computation refuses", () => {
  it("has nothing to serve when only a mid rate is on file", () => {
    const onlyAMid = [row("mid"), row("tt_selling")];
    expect(pickQuote(onlyAMid, [], FOREIGN, TDS_FUNCTIONAL_CURRENCY, "tt_buying")).toBeNull();
    // …and the same candidate set is perfectly usable where no statute
    // names a side of the spread, which is why the batch changes nothing
    // that is on a screen today.
    expect(pickQuote(onlyAMid, [], FOREIGN, TDS_FUNCTIONAL_CURRENCY)).not.toBeNull();
  });

  it("refuses the mid rate by name, and the refusal says which rate is missing for which day", () => {
    let thrown: unknown;
    try {
      foreignPaymentBase({
        foreignAmountMinor: 10_000_000n,
        foreignCurrency: FOREIGN,
        deductionDate: DEDUCTION_DAY,
        quote: quoteOf("mid"),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StatutoryRateError);
    const error = thrown as StatutoryRateError;

    // 🔴 THE REFUSAL NAMES WHAT IS MISSING, not merely that something is.
    expect(error.requiredRateType).toBe(RULE_26_TT_BUYING.rateType);
    expect(error.requiredOn).toBe(DEDUCTION_DAY);
    expect(error.pair).toContain(FOREIGN);
    expect(error.pair).toContain(TDS_FUNCTIONAL_CURRENCY);
    expect(error.conversionId).toBe(RULE_26_TT_BUYING.id);

    expect(error.message).toContain("telegraphic transfer buying rate");
    expect(error.message).toContain(DEDUCTION_DAY);
    expect(error.message).toContain(FOREIGN);
    expect(error.message).toMatch(/Nothing has been converted/i);
    // The wrong rate is named too, so the operator is not sent to enter a
    // second copy of the number that is already on file.
    expect(error.message).toContain("mid rate");
  });

  it("refuses a TT buying rate for a neighbouring day rather than reaching for it", () => {
    let thrown: unknown;
    try {
      foreignPaymentBase({
        foreignAmountMinor: 10_000_000n,
        foreignCurrency: FOREIGN,
        deductionDate: DEDUCTION_DAY,
        quote: quoteOf("tt_buying", { rateDate: DAY_BEFORE }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StatutoryRateError);
    const error = thrown as StatutoryRateError;
    expect(error.requiredOn).toBe(DEDUCTION_DAY);
    expect(error.message).toContain(DEDUCTION_DAY);
    expect(error.message).toContain(DAY_BEFORE);
    expect(error.message).toMatch(/Nothing has been converted/i);
  });

  it("refuses rather than returning a figure, so no partial answer escapes", () => {
    const attempt = () =>
      foreignPaymentBase({
        foreignAmountMinor: 10_000_000n,
        foreignCurrency: FOREIGN,
        deductionDate: DEDUCTION_DAY,
        quote: quoteOf("tt_selling"),
      });
    expect(attempt).toThrow(StatutoryRateError);
    // A refusal carries no money on it at all — there is nothing for a
    // caller to fish out and post.
    try {
      attempt();
    } catch (err) {
      expect(Object.values(err as object).some((v) => typeof v === "bigint")).toBe(false);
    }
  });
});

/* ================================================================== */
/* ③ THE RATE TYPE CHANGES THE MONEY                                  */
/* ================================================================== */

describe("Rule 26 · the rate type changes the deducted amount, so the column cannot be decorative", () => {
  /**
   * ⚠️ A SECOND CONVERSION, IDENTICAL TO RULE 26 IN EVERY FIELD EXCEPT THE
   * SIDE OF THE SPREAD IT NAMES. It exists only here, and only so that the
   * two runs below differ in EXACTLY ONE THING. If `rate_type` were stored
   * and ignored, the two would produce the same rupee base and the same
   * tax, and every assertion in this block would fail.
   */
  const AS_IF_THE_MID_WERE_NAMED: StatutoryConversion = {
    ...RULE_26_TT_BUYING,
    id: "test_only_mid",
    rateType: "mid",
  };

  const amountMinor = 10_000_000n; // US$100,000
  const sectionRateBps = 1000; // 10%, s.195 on a fee for technical services

  it("produces a different rupee base and a different tax on each side of the spread", () => {
    const underRule26 = convertUnderStatute({
      amountMinor,
      from: FOREIGN,
      to: TDS_FUNCTIONAL_CURRENCY,
      quote: quoteOf("tt_buying"),
      on: DEDUCTION_DAY,
      conversion: RULE_26_TT_BUYING,
    });
    const underTheMid = convertUnderStatute({
      amountMinor,
      from: FOREIGN,
      to: TDS_FUNCTIONAL_CURRENCY,
      quote: quoteOf("mid"),
      on: DEDUCTION_DAY,
      conversion: AS_IF_THE_MID_WERE_NAMED,
    });

    expect(underRule26.amountMinor).not.toBe(underTheMid.amountMinor);
    // The bank buys below the mid, so Rule 26's base is the smaller one and
    // the tax on it is smaller too. The DIRECTION is the property; the
    // amounts are not asserted.
    expect(underRule26.amountMinor).toBeLessThan(underTheMid.amountMinor);
    expect(applyRateBps(underRule26.amountMinor, sectionRateBps)).toBeLessThan(
      applyRateBps(underTheMid.amountMinor, sectionRateBps),
    );
  });

  it("selects that different number through the resolver, not only through the gate", () => {
    const candidates = [row("mid"), row("tt_buying"), row("tt_selling")];
    const buying = pickQuote(candidates, [], FOREIGN, TDS_FUNCTIONAL_CURRENCY, "tt_buying");
    const middle = pickQuote(candidates, [], FOREIGN, TDS_FUNCTIONAL_CURRENCY, "mid");

    expect(buying).not.toBeNull();
    expect(middle).not.toBeNull();
    expect(buying?.rateScaled).not.toBe(middle?.rateScaled);

    const baseFromBuying = foreignPaymentBase({
      foreignAmountMinor: amountMinor,
      foreignCurrency: FOREIGN,
      deductionDate: DEDUCTION_DAY,
      quote: buying as FxQuote,
    }).chargeableBaseMinor;

    const baseFromMid = convertUnderStatute({
      amountMinor,
      from: FOREIGN,
      to: TDS_FUNCTIONAL_CURRENCY,
      quote: middle as FxQuote,
      on: DEDUCTION_DAY,
      conversion: AS_IF_THE_MID_WERE_NAMED,
    }).amountMinor;

    expect(baseFromBuying).not.toBe(baseFromMid);
  });

  it("moves the base whenever the rate moves, so no rate can be ignored", () => {
    const cheaper = quoteOf("tt_buying", { rate: "80.0000" });
    const dearer = quoteOf("tt_buying", { rate: "90.0000" });

    const low = foreignPaymentBase({
      foreignAmountMinor: amountMinor,
      foreignCurrency: FOREIGN,
      deductionDate: DEDUCTION_DAY,
      quote: cheaper,
    }).chargeableBaseMinor;
    const high = foreignPaymentBase({
      foreignAmountMinor: amountMinor,
      foreignCurrency: FOREIGN,
      deductionDate: DEDUCTION_DAY,
      quote: dearer,
    }).chargeableBaseMinor;

    expect(low).toBeLessThan(high);
  });
});

/* ================================================================== */
/* ④ ROUNDING, AND A WHOLE COMPUTATION THAT FOOTS                     */
/* ================================================================== */

describe("Rule 26 · the rounding is the one the rest of the deduction uses, and the computation foots", () => {
  it("rounds a half away from zero, the same direction applyRateBps rounds it", () => {
    // `applyRateBps` adds 5000 before dividing by 10000: an exact half goes
    // up. Every other TDS figure in the register is computed that way.
    expect(applyRateBps(1n, 5000)).toBe(1n);
    expect(RULE_26_TT_BUYING.rounding).toBe("half_up");
    expect(RULE_26_TT_BUYING.rounding).not.toBe(DEFAULT_ROUNDING);

    // One US cent at USD/INR 84.50 is exactly 84.5 paise — an exact half,
    // sitting above an EVEN quotient, which is the only case where half-up
    // and the FX house default disagree.
    const tie = quoteOf("tt_buying", { rate: "84.5000" });
    const underRule26 = foreignPaymentBase({
      foreignAmountMinor: 1n,
      foreignCurrency: FOREIGN,
      deductionDate: DEDUCTION_DAY,
      quote: tie,
    }).chargeableBaseMinor;
    const underTheFxDefault = convertMinor({
      amountMinor: 1n,
      from: FOREIGN,
      to: TDS_FUNCTIONAL_CURRENCY,
      quote: tie,
      on: DEDUCTION_DAY,
      policy: EXACT_DATE,
      rounding: DEFAULT_ROUNDING,
    }).amountMinor;

    expect(underRule26).toBeGreaterThan(underTheFxDefault);
  });

  it("lands on the nearest paisa to the foreign amount at the rate, never further", () => {
    const expFrom = BigInt(minorUnitExponent(FOREIGN));
    const expTo = BigInt(minorUnitExponent(TDS_FUNCTIONAL_CURRENCY));
    const denominator = 10n ** expFrom * RATE_SCALE;

    for (const rate of ["83.2000", "84.5000", "1.000000000001", "121.9375"]) {
      for (const amountMinor of [0n, 1n, 7n, 12_345n, 10_000_000n, 999_999_999n]) {
        const quote = quoteOf("tt_buying", { rate });
        const base = foreignPaymentBase({
          foreignAmountMinor: amountMinor,
          foreignCurrency: FOREIGN,
          deductionDate: DEDUCTION_DAY,
          quote,
        }).chargeableBaseMinor;

        const exactNumerator = amountMinor * quote.rateScaled * 10n ** expTo;
        const residual = base * denominator - exactNumerator;
        const magnitude = residual < 0n ? -residual : residual;
        // Nearest: never more than half a paisa away, in either direction.
        expect(magnitude * 2n).toBeLessThanOrEqual(denominator);
      }
    }
  });

  it("foots end to end: the base, the tax and the net payable close on each other", () => {
    for (const rateBps of [1000, 2000, 3120, 500]) {
      for (const amountMinor of [1n, 4_321n, 10_000_000n, 250_000_000n]) {
        const measured = foreignPaymentBase({
          foreignAmountMinor: amountMinor,
          foreignCurrency: FOREIGN,
          deductionDate: DEDUCTION_DAY,
          quote: quoteOf("tt_buying"),
        });
        const base = measured.chargeableBaseMinor;
        const tax = applyRateBps(base, rateBps);
        const net = base - tax;

        expect(net + tax).toBe(base);
        expect(tax).toBeLessThanOrEqual(base);
        expect(net).toBeGreaterThanOrEqual(0n);
        // The row records the working it was computed from, or the figure
        // cannot be defended in a s.201 proceeding.
        expect(measured.deductionDate).toBe(measured.quote.rateDate);
        expect(measured.foreignAmountMinor).toBe(amountMinor);
        expect(measured.foreignCurrency).toBe(FOREIGN);
        expect(measured.conversion.currency).toBe(TDS_FUNCTIONAL_CURRENCY);
      }
    }
  });

  it("is stable: the same payment measured twice gives the same base", () => {
    const once = foreignPaymentBase({
      foreignAmountMinor: 10_000_000n,
      foreignCurrency: FOREIGN,
      deductionDate: DEDUCTION_DAY,
      quote: quoteOf("tt_buying"),
    });
    const twice = foreignPaymentBase({
      foreignAmountMinor: 10_000_000n,
      foreignCurrency: "usd",
      deductionDate: DEDUCTION_DAY,
      quote: quoteOf("tt_buying"),
    });
    expect(twice.chargeableBaseMinor).toBe(once.chargeableBaseMinor);
  });

  it("refuses a negative payment rather than deducting tax from it", () => {
    expect(() =>
      foreignPaymentBase({
        foreignAmountMinor: -1n,
        foreignCurrency: FOREIGN,
        deductionDate: DEDUCTION_DAY,
        quote: quoteOf("tt_buying"),
      }),
    ).toThrow(ForeignPaymentTdsError);
  });
});

/* ================================================================== */
/* ⑤ THE DATE THE TAX IS REQUIRED TO BE DEDUCTED                      */
/* ================================================================== */

describe("Rule 26 · the specified date is the earlier of credit and payment", () => {
  it("takes the credit when the sum was credited before it was paid", () => {
    const verdict = deductionDateFor({ creditDate: "2026-03-31", paymentDate: "2026-06-15" });
    expect(verdict.deductionDate).toBe("2026-03-31");
    expect(verdict.basis).toBe("credit");
    expect(verdict.explanation).toContain("2026-03-31");
    expect(verdict.explanation).toContain("s.195(1)");
  });

  it("takes the payment when the money went out first — an advance", () => {
    const verdict = deductionDateFor({ creditDate: "2026-06-15", paymentDate: "2026-03-31" });
    expect(verdict.deductionDate).toBe("2026-03-31");
    expect(verdict.basis).toBe("payment");
  });

  it("never returns a date that was not one of the two events", () => {
    const cases: Array<{ creditDate: string | null; paymentDate: string | null }> = [
      { creditDate: "2026-03-31", paymentDate: "2026-06-15" },
      { creditDate: "2026-06-15", paymentDate: "2026-03-31" },
      { creditDate: "2026-04-01", paymentDate: "2026-04-01" },
      { creditDate: "2026-04-01", paymentDate: null },
      { creditDate: null, paymentDate: "2026-04-01" },
    ];
    for (const c of cases) {
      const verdict = deductionDateFor(c);
      expect([c.creditDate, c.paymentDate]).toContain(verdict.deductionDate);
      // Whichever it took, it is not later than either event that happened.
      for (const event of [c.creditDate, c.paymentDate]) {
        if (event) expect(verdict.deductionDate <= event).toBe(true);
      }
    }
  });

  it("refuses when it has neither date, rather than reaching for a clock", () => {
    let thrown: unknown;
    try {
      deductionDateFor({ creditDate: null, paymentDate: null });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForeignPaymentTdsError);
    expect((thrown as Error).message).toContain("s.195(1)");
    expect((thrown as Error).message).toMatch(/nothing has been computed/i);
  });

  it("measures at the rate for the deduction date and refuses the payment day's rate", () => {
    const verdict = deductionDateFor({ creditDate: "2026-03-31", paymentDate: "2026-06-15" });

    // The rate for the day the money actually left the bank is the one
    // nearest to hand on a payment screen. It is not the one Rule 26 names.
    expect(() =>
      foreignPaymentBase({
        foreignAmountMinor: 10_000_000n,
        foreignCurrency: FOREIGN,
        deductionDate: verdict.deductionDate,
        quote: quoteOf("tt_buying", { rateDate: "2026-06-15" }),
      }),
    ).toThrow(StatutoryRateError);

    const measured = foreignPaymentBase({
      foreignAmountMinor: 10_000_000n,
      foreignCurrency: FOREIGN,
      deductionDate: verdict.deductionDate,
      quote: quoteOf("tt_buying", { rateDate: verdict.deductionDate }),
    });
    expect(measured.quote.rateDate).toBe(verdict.deductionDate);
    expect(measured.deductionDate).toBe(verdict.deductionDate);
  });
});

/* ================================================================== */
/* ⑥ THE DOMESTIC PATH IS UNTOUCHED                                   */
/* ================================================================== */

describe("Rule 26 · a rupee payment, and every rate written before this batch, are untouched", () => {
  it("measures a rupee payment at exactly itself, from no table", () => {
    for (const amountMinor of [0n, 1n, 12_345n, 10_000_000n]) {
      const measured = foreignPaymentBase({
        foreignAmountMinor: amountMinor,
        foreignCurrency: TDS_FUNCTIONAL_CURRENCY,
        deductionDate: DEDUCTION_DAY,
        quote: identityQuote(
          TDS_FUNCTIONAL_CURRENCY,
          DEDUCTION_DAY,
          RULE_26_TT_BUYING.rateType,
        ),
      });
      expect(measured.chargeableBaseMinor).toBe(amountMinor);
      expect(measured.quote.rateScaled).toBe(RATE_SCALE);
    }
  });

  it("leaves the tax on a rupee payment identical to what it always was", () => {
    for (const rateBps of [100, 1000, 2000]) {
      for (const amountMinor of [25_000_00n, 1_00_00_000n]) {
        const throughRule26 = foreignPaymentBase({
          foreignAmountMinor: amountMinor,
          foreignCurrency: TDS_FUNCTIONAL_CURRENCY,
          deductionDate: DEDUCTION_DAY,
          quote: identityQuote(
            TDS_FUNCTIONAL_CURRENCY,
            DEDUCTION_DAY,
            RULE_26_TT_BUYING.rateType,
          ),
        }).chargeableBaseMinor;
        // The figure a pre-0106 rupee deduction was computed on is the
        // typed rupee amount itself.
        expect(applyRateBps(throughRule26, rateBps)).toBe(
          applyRateBps(amountMinor, rateBps),
        );
      }
    }
  });

  it("still converts an `unstated` rate for the accounting paths that name no side of the spread", () => {
    // Every `fx_rates` row written before 0106 is `unstated`. AS 11 initial
    // recognition and the closing-rate revaluation do not name a side of
    // the spread, so those conversions must keep working unchanged.
    const legacy = quoteOf("unstated", { rate: RATES.mid });
    const labelled = quoteOf("mid", { rate: RATES.mid });

    const fromLegacy = convertMinor({
      amountMinor: 10_000_000n,
      from: FOREIGN,
      to: TDS_FUNCTIONAL_CURRENCY,
      quote: legacy,
      on: DEDUCTION_DAY,
      policy: EXACT_DATE,
    });
    const fromLabelled = convertMinor({
      amountMinor: 10_000_000n,
      from: FOREIGN,
      to: TDS_FUNCTIONAL_CURRENCY,
      quote: labelled,
      on: DEDUCTION_DAY,
      policy: EXACT_DATE,
    });

    expect(fromLegacy.amountMinor).toBe(fromLabelled.amountMinor);
    // …and it is refused only where a statute names a side of the spread.
    expect(() =>
      assertStatutoryQuote({
        quote: legacy,
        conversion: RULE_26_TT_BUYING,
        on: DEDUCTION_DAY,
        from: FOREIGN,
        to: TDS_FUNCTIONAL_CURRENCY,
      }),
    ).toThrow(StatutoryRateError);
  });

  it("ranks an unstated legacy rate exactly as it did before, when no rate type is asked for", () => {
    const legacyOnly = [row("unstated")];
    const served = pickQuote(legacyOnly, [], FOREIGN, TDS_FUNCTIONAL_CURRENCY);
    expect(served).not.toBeNull();
    expect(served?.rateType).toBe("unstated");
  });
});
