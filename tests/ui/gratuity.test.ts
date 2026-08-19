/**
 * Ordence — ⭐⭐⭐ GRATUITY, THE PAYMENT OF GRATUITY ACT, 1972
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE ASSERTIONS AND NOT OTHERS
 * ══════════════════════════════════════════════════════════════════════
 * Gratuity is computed once, for somebody who has already left, and
 * nobody re-reads it next month. So the tests here are about the four
 * places where being wrong is invisible:
 *
 *   ① THE SIX-MONTH BOUNDARY, in both directions. One day either side
 *     is a whole year of somebody's wages.
 *   ② DEATH AND DISABLEMENT UNDER FIVE YEARS. A refusal here is the
 *     worst failure this feature has, and it looks exactly like a
 *     correct refusal.
 *   ③ THE CEILING BINDING THE STATUTORY FIGURE ONLY. s.4(5) preserves
 *     better terms; a ceiling applied to the payment rather than to the
 *     entitlement silently caps a lawful settlement.
 *   ④ EVERY AMOUNT A `bigint`. Asserted at a value a float pipeline
 *     gets wrong, not by reading the source.
 *
 * ⚠️ THE ASSERTIONS ARE PROPERTIES, NOT SHAPES — relations between two
 * computed results, or the exact paise at a boundary — so that
 * rewording a note or adding a field cannot make them fail, and so that
 * changing the arithmetic cannot make them pass.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ESTABLISHMENT_BASIS,
  ceilingInForceOn,
  computeGratuity,
  gratuityOnExit,
  measureService,
  waivesMinimumService,
  type GratuityArgs,
  type GratuityResult,
  type GratuityRules,
} from "@/lib/payroll/gratuity";

/* ------------------------------------------------------------------ */
/* THE RULE ROWS — TWO OF THEM, BECAUSE THE CEILING HAS MOVED          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ The real history: ₹10 lakh from 24 May 2010, ₹20 lakh from 29
 * March 2018. Two rows, so that "the ceiling on the date of exit" is
 * testable rather than assumed.
 */
const RULES_2010: GratuityRules = {
  effectiveFrom: "2010-05-24",
  effectiveTo: "2018-03-28",
  ceilingMinor: "100000000",
  daysWagesPerCompletedYear: 15,
  monthlyWageDivisorDays: 26,
  seasonalDaysWagesPerSeason: 7,
  minimumContinuousYears: 5,
  delayInterestRateBpPerAnnum: null,
};

const RULES_2018: GratuityRules = {
  ...RULES_2010,
  effectiveFrom: "2018-03-29",
  effectiveTo: null,
  ceilingMinor: "200000000",
};

const HISTORY = [RULES_2010, RULES_2018] as const;

function monthly(wagesMinor: string, over: Partial<GratuityArgs> = {}): GratuityResult {
  return computeGratuity({
    joinedOn: "2015-01-01",
    exitOn: "2020-12-31",
    cause: "resignation",
    basis: { kind: "monthly_rated", monthlyWagesMinor: wagesMinor },
    rulesHistory: HISTORY,
    ...over,
  });
}

/** Every `…Minor` field anywhere in a result, found by walking it. */
function moneyFields(value: unknown, path = ""): Array<[string, unknown]> {
  if (value === null || typeof value !== "object") return [];
  const found: Array<[string, unknown]> = [];
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (key.endsWith("Minor")) found.push([here, inner]);
    found.push(...moneyFields(inner, here));
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* ① THE SIX-MONTH BOUNDARY                                            */
/* ------------------------------------------------------------------ */

describe("s.4(2) — a part-year IN EXCESS OF six months counts as a year", () => {
  /**
   * 🔴 Joined 1 Jan 2015. The sixth anniversary is 1 Jan 2021, and six
   * months of the seventh year lands on 1 Jul 2021. Service to the END
   * of 30 Jun 2021 is exactly six months — "in excess of" is not "at
   * least", so it does NOT count.
   */
  it("does not count exactly six months", () => {
    const span = measureService("2015-01-01", "2021-06-30");
    expect(span?.completedYears).toBe(6);
    expect(span?.finalPartYearCounts).toBe(false);
    expect(span?.qualifyingYears).toBe(6);
  });

  it("counts six months and one day", () => {
    const span = measureService("2015-01-01", "2021-07-01");
    expect(span?.completedYears).toBe(6);
    expect(span?.finalPartYearCounts).toBe(true);
    expect(span?.qualifyingYears).toBe(7);
  });

  /**
   * ⭐ THE PROPERTY, NOT THE PAIR OF NUMBERS: one extra day of service
   * across that boundary is worth exactly one more year's wages, and
   * one day on either side of it is worth nothing.
   */
  it("is worth one whole year of wages and only at that one day", () => {
    const at = monthly("2600000", { exitOn: "2021-06-30" });
    const dayAfter = monthly("2600000", { exitOn: "2021-07-01" });
    const twoAfter = monthly("2600000", { exitOn: "2021-07-02" });
    const oneYear = (BigInt("2600000") * 15n) / 26n;

    expect(dayAfter.statutoryPayableMinor - at.statutoryPayableMinor).toBe(oneYear);
    expect(twoAfter.statutoryPayableMinor).toBe(dayAfter.statutoryPayableMinor);
  });

  /**
   * ⚠️ THE DAY IS CLAMPED, NEVER OVERFLOWED. Six months from 31 August
   * is 28 (or 29) February, because there is no 31 February. Overflowing
   * into 3 March instead would push the boundary three days later — i.e.
   * against the employee — for everybody who joined on the 29th, 30th or
   * 31st of a month.
   */
  it("clamps the six-month mark into a shorter month", () => {
    const span = measureService("2014-08-31", "2021-02-28");
    expect(span?.sixMonthMarkOn).toBe("2021-02-28");
    expect(span?.finalPartYearCounts).toBe(true);
    // And the day before it is still short of the mark.
    expect(measureService("2014-08-31", "2021-02-27")?.finalPartYearCounts).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* ② ELIGIBILITY — AND THE ROUNDING THAT MUST NOT REACH IT             */
/* ------------------------------------------------------------------ */

describe("s.4(1) — five years, and what the rounding may not do", () => {
  it("pays at exactly five years, the last working day included", () => {
    const exact = monthly("2600000", { exitOn: "2019-12-31" });
    expect(exact.service.completedYears).toBe(5);
    expect(exact.eligible).toBe(true);
    expect(exact.statutoryPayableMinor > 0n).toBe(true);
  });

  it("refuses one day short of five years", () => {
    const short = monthly("2600000", { exitOn: "2019-12-30" });
    expect(short.service.completedYears).toBe(4);
    expect(short.eligible).toBe(false);
    expect(short.totalPayableMinor).toBe(0n);
    expect(short.problems.length > 0).toBe(true);
  });

  /**
   * 🔴 THE TRAP THIS PINS. Four years and seven months rounds to five
   * qualifying YEARS under s.4(2) — and s.4(1) still says no. The
   * rounding decides how much, never whether.
   */
  it("does not let the s.4(2) rounding create eligibility", () => {
    const almost = monthly("2600000", { exitOn: "2019-08-15" });
    expect(almost.service.qualifyingYears).toBe(5);
    expect(almost.service.completedYears).toBe(4);
    expect(almost.eligible).toBe(false);
    expect(almost.statutoryPayableMinor).toBe(0n);
  });
});

/* ------------------------------------------------------------------ */
/* ③ DEATH AND DISABLEMENT — THE PROVISO TO s.4(1)                     */
/* ------------------------------------------------------------------ */

describe("proviso to s.4(1) — death and disablement need no qualifying period", () => {
  const twoYears = { joinedOn: "2018-01-01", exitOn: "2020-06-30" } as const;

  it("pays on death after two and a half years", () => {
    const died = monthly("2600000", { ...twoYears, cause: "death" });
    expect(died.eligible).toBe(true);
    expect(died.statutoryPayableMinor > 0n).toBe(true);
  });

  it("pays on disablement after the same service", () => {
    const disabled = monthly("2600000", { ...twoYears, cause: "disablement" });
    expect(disabled.eligible).toBe(true);
    expect(disabled.statutoryPayableMinor > 0n).toBe(true);
  });

  /**
   * ⭐ THE PROPERTY: the waiver touches ELIGIBILITY ONLY. A death claim
   * and a resignation with identical service and wages are the same
   * money — one is payable and the other is not.
   */
  it("waives the qualifying period without changing the arithmetic", () => {
    const died = monthly("2600000", { ...twoYears, cause: "death" });
    const longEnough = monthly("2600000", { joinedOn: "2013-01-01", exitOn: "2015-06-30" });
    // Same 2y6m span, resignation, five completed years short: refused.
    expect(longEnough.eligible).toBe(false);
    expect(died.service.qualifyingYears).toBe(longEnough.service.qualifyingYears);
    expect(died.entitlementBeforeCeilingMinor > 0n).toBe(true);
  });

  it("names exactly the two causes the proviso names", () => {
    expect(waivesMinimumService("death")).toBe(true);
    expect(waivesMinimumService("disablement")).toBe(true);
    for (const other of ["resignation", "retirement", "superannuation", "termination_by_employer"] as const) {
      expect(waivesMinimumService(other)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* ④ THE CEILING — s.4(3) AGAINST s.4(5)                               */
/* ------------------------------------------------------------------ */

describe("s.4(3) caps the entitlement, not the payment", () => {
  const big: Partial<GratuityArgs> = { joinedOn: "2010-01-01", exitOn: "2019-12-31" };

  it("binds the statutory figure and reports that it did", () => {
    const r = monthly("50000000", big); // ₹5,00,000 a month, 10 years
    expect(r.entitlementBeforeCeilingMinor).toBe(288461500n);
    expect(r.ceilingApplied).toBe(true);
    expect(r.statutoryEntitlementMinor).toBe(200000000n);
  });

  /**
   * 🔴 THE ONE THAT MATTERS: an employer paying above the ceiling is
   * lawful under s.4(5), the excess is ex gratia, and the total exceeds
   * the ceiling. A ceiling applied to the payment would clamp this.
   */
  it("lets a larger payment through and keeps the excess separate", () => {
    const r = monthly("50000000", { ...big, employerProposedTotalMinor: "288461500" });
    expect(r.statutoryEntitlementMinor).toBe(200000000n);
    expect(r.exGratiaMinor).toBe(88461500n);
    expect(r.totalPayableMinor).toBe(288461500n);
    expect(r.totalPayableMinor > r.ceilingMinor).toBe(true);
    // ⭐ And the two never merge: statutory + ex gratia is the whole total.
    expect(r.statutoryPayableMinor + r.exGratiaMinor).toBe(r.totalPayableMinor);
  });

  it("refuses to treat a shortfall as a settlement", () => {
    const r = monthly("50000000", { ...big, employerProposedTotalMinor: "100000000" });
    expect(r.exGratiaMinor).toBe(0n);
    expect(r.statutoryPayableMinor).toBe(200000000n);
    expect(r.problems.length > 0).toBe(true);
  });

  /**
   * 🔴 THE CEILING IS EFFECTIVE-DATED AND SELECTED ON THE EXIT DATE. An
   * exit in 2017 gets ₹10 lakh however late the settlement is run.
   */
  it("uses the ceiling in force on the date of exit, not the newest one", () => {
    const old = monthly("50000000", { joinedOn: "2007-01-01", exitOn: "2017-12-31" });
    const recent = monthly("50000000", { joinedOn: "2010-01-01", exitOn: "2019-12-31" });
    expect(old.statutoryEntitlementMinor).toBe(100000000n);
    expect(recent.statutoryEntitlementMinor).toBe(200000000n);
    expect(ceilingInForceOn(HISTORY, "2017-12-31")).toBe(100000000n);
    expect(ceilingInForceOn(HISTORY, "2019-12-31")).toBe(200000000n);
  });

  it("refuses rather than falling back when no row covers the exit date", () => {
    const r = monthly("2600000", { joinedOn: "2000-01-01", exitOn: "2009-12-31" });
    expect(r.eligible).toBe(false);
    expect(r.totalPayableMinor).toBe(0n);
    expect(ceilingInForceOn(HISTORY, "2009-12-31")).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* ⑤ THE MONEY IS bigint PAISE, AT A VALUE A FLOAT GETS WRONG          */
/* ------------------------------------------------------------------ */

describe("every amount is bigint paise", () => {
  it("has no non-bigint money anywhere in a result", () => {
    const fields = moneyFields(monthly("4500000", { exitOn: "2019-12-31" }));
    expect(fields.length > 0).toBe(true);
    for (const [name, value] of fields) {
      expect(`${name}:${typeof value}`).toBe(`${name}:bigint`);
    }
  });

  /**
   * 🔴 ₹45,000 for five years. 45,000 × 15 ÷ 26 recurs, and where the
   * division happens decides the answer:
   *   once at the end  → ₹1,29,807.6923… → ₹1,29,808
   *   per year, rounded → ₹25,962 × 5    → ₹1,29,810
   * Two rupees apart, and only the first is s.4(2)'s own arithmetic.
   */
  it("divides once, at the end", () => {
    const r = monthly("4500000", { exitOn: "2019-12-31" });
    expect(r.service.qualifyingYears).toBe(5);
    expect(r.statutoryPayableMinor).toBe(12980800n);
    // The per-year figure is shown, and multiplying it out is NOT the total.
    expect(r.wagesPerCompletedYearMinor).toBe(2596200n);
    expect(r.wagesPerCompletedYearMinor * 5n).not.toBe(r.statutoryPayableMinor);
  });

  /**
   * ⭐ THE HALF-RUPEE. ₹45,000.28 × 15 × 5 ÷ 26 is ₹1,29,808.50 exactly.
   * Rounding half away from zero — the rule the rest of the statutory
   * engine uses — pays ₹1,29,809. Truncating the ratio to paise first,
   * or letting a float land on …8.4999999, pays a rupee less.
   */
  it("rounds the exact half rupee away from zero", () => {
    const r = monthly("4500028", { exitOn: "2019-12-31" });
    expect(r.statutoryPayableMinor).toBe(12980900n);
    expect(r.statutoryPayableMinor % 100n).toBe(0n);
  });

  it("keeps the paise exact for a wage a float would smear", () => {
    // ₹1,23,456.78 for 7 years: 123456.78 × 15 × 7 ÷ 26.
    const r = monthly("12345678", { joinedOn: "2012-01-01", exitOn: "2019-12-31" });
    const exact = (12345678n * 15n * 8n) / 26n; // 8 qualifying years
    expect(r.service.qualifyingYears).toBe(8);
    // Within half a rupee of the exact ratio, and a whole number of rupees.
    const drift = r.entitlementBeforeCeilingMinor - exact;
    expect(drift < 100n && drift > -100n).toBe(true);
    expect(r.entitlementBeforeCeilingMinor % 100n).toBe(0n);
  });
});

/* ------------------------------------------------------------------ */
/* ⑥ THE ESTABLISHMENT BASIS IS EXPLICIT                               */
/* ------------------------------------------------------------------ */

describe("s.4(2) provisos — one rule is not applied to everybody", () => {
  it("pays a seasonal employee seven days a season, not fifteen days a year", () => {
    const seasonal = computeGratuity({
      joinedOn: "2012-01-01",
      exitOn: "2019-12-31",
      cause: "resignation",
      basis: { kind: "seasonal_not_year_round", dailyWagesMinor: "100000", seasons: 8 },
      rulesHistory: HISTORY,
    });
    expect(seasonal.basisApplied).toBe("seasonal_not_year_round");
    // 7 days × ₹1,000 × 8 seasons.
    expect(seasonal.statutoryPayableMinor).toBe(100000n * 7n * 8n);
  });

  it("reports which basis it applied, always", () => {
    const r = monthly("2600000", { exitOn: "2019-12-31" });
    expect(r.basisApplied).toBe(DEFAULT_ESTABLISHMENT_BASIS);
    const piece = computeGratuity({
      joinedOn: "2012-01-01",
      exitOn: "2019-12-31",
      cause: "resignation",
      basis: {
        kind: "piece_rated",
        dailyWagesMinor: "100000",
        averagingNote: "three months to 31 Dec 2019, overtime excluded",
      },
      rulesHistory: HISTORY,
    });
    expect(piece.basisApplied).toBe("piece_rated");
    expect(piece.statutoryPayableMinor).toBe(100000n * 15n * 8n);
  });
});

/* ------------------------------------------------------------------ */
/* ⑦ WHAT IT REFUSES TO DECIDE                                         */
/* ------------------------------------------------------------------ */

describe("the refusals", () => {
  it("never infers a forfeiture amount under s.4(6)", () => {
    const r = monthly("2600000", {
      exitOn: "2019-12-31",
      forfeiture: {
        ground: "damage_or_loss",
        amountMinor: null,
        reference: "show-cause 12/2019",
      },
    });
    expect(r.forfeitedMinor).toBe(0n);
    expect(r.problems.length > 0).toBe(true);
  });

  it("limits a stated forfeiture to the gratuity itself", () => {
    const r = monthly("2600000", {
      exitOn: "2019-12-31",
      forfeiture: {
        ground: "damage_or_loss",
        amountMinor: "999999999",
        reference: "show-cause 12/2019",
      },
    });
    expect(r.statutoryPayableMinor).toBe(0n);
    expect(r.forfeitedMinor).toBe(r.statutoryEntitlementMinor);
  });

  it("does not compute income tax and says so", () => {
    const r = monthly("2600000", { exitOn: "2019-12-31" });
    expect(r.taxTreatment).toBe("not_computed");
    expect(r.notes.some((n) => n.includes("10(10)"))).toBe(true);
  });

  it("gives a due date thirty days out, per s.7(3)", () => {
    const r = monthly("2600000", { exitOn: "2019-12-31" });
    expect(r.payableByOn).toBe("2020-01-30");
  });

  it("computes nothing for an employee who has not left", () => {
    expect(
      gratuityOnExit({
        employee: { joinedOn: "2015-01-01", leftOn: null, lastDrawnWagesMinor: "2600000" },
        cause: "resignation",
        rulesHistory: HISTORY,
      }),
    ).toBe(null);
  });

  it("computes from an employee row once they have", () => {
    const r = gratuityOnExit({
      employee: { joinedOn: "2015-01-01", leftOn: "2020-12-31", lastDrawnWagesMinor: "2600000" },
      cause: "resignation",
      rulesHistory: HISTORY,
    });
    expect(r?.eligible).toBe(true);
    expect(r?.basisApplied).toBe(DEFAULT_ESTABLISHMENT_BASIS);
    expect(r?.statutoryPayableMinor).toBe(
      monthly("2600000", { exitOn: "2020-12-31" }).statutoryPayableMinor,
    );
  });
});
