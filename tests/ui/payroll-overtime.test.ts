/**
 * Ordence — ⭐⭐⭐ OVERTIME: THE FIVE THINGS THAT MUST STAY TRUE
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Every assertion here is a PROPERTY — a relationship that must hold
 * whatever the numbers are — and not a snapshot of a sentence or a count
 * of an array. Suites in this project have had to be rewritten because
 * they pinned an exact string, so nothing below asserts wording; the
 * message tests assert only that the thing the reader must be told is
 * mentioned at all.
 *
 *   ① A HALF DAY IS PAID AS A HALF DAY. Never floored to nothing, never
 *      ceiled to a whole one. This is the defect this codebase already
 *      shipped once, in this exact area, with `Math.floor(worked)`.
 *   ② TWICE THE ORDINARY RATE, NOT ONE AND A HALF. s.59(1). One-and-a-
 *      half is the American rate and the commonest defect in Indian
 *      payroll software.
 *   ③ AN UNCONFIGURED STATE REFUSES. Shops and Establishments Acts are
 *      state law and differ; no fallback to a neighbour, to the newest
 *      row, or to the Factories Act.
 *   ④ EXCEEDING THE s.64/s.65 CAP IS SURFACED. It is an offence by the
 *      employer, so paying it silently is the wrong behaviour.
 *   ⑤ EXACT PAISE AT A BOUNDARY A FLOAT WOULD GET WRONG.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asOvertimeRules,
  computeOvertime,
  minutesFromDayFraction,
  ordinaryMinutesInPeriod,
  ordinaryRateBase,
  overtimeWagesMinor,
  pickOvertimeRules,
  type EstablishmentKind,
  type OrdinaryRateComponent,
  type OvertimeRules,
} from "@/lib/payroll/overtime";

/* ------------------------------------------------------------------ */
/* FIXTURES — every number here is data, exactly as it is in the file  */
/* ------------------------------------------------------------------ */

const NORMAL_DAY_MINUTES = 480; // eight hours
const MONTH_ORDINARY_MINUTES = 480 * 26;

function rules(over: Partial<OvertimeRules> = {}): OvertimeRules {
  return {
    stateCode: "KA",
    establishmentKind: "factory" as EstablishmentKind,
    multiplierBp: 20_000, // twice — s.59(1)
    dailyThresholdMinutes: 540, // nine hours — s.54
    weeklyThresholdMinutes: 2_880, // forty-eight hours — s.51
    basis: "greater_of",
    dailyTotalCapMinutes: 600,
    weeklyTotalCapMinutes: 3_600,
    quarterlyOvertimeCapMinutes: 3_000,
    ordinaryRateIncludes: ["BASIC", "DA", "CONV"],
    weekStartsOnWeekday: 0,
    authorityNote: "Test fixture.",
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    ...over,
  };
}

function earnings(): OrdinaryRateComponent[] {
  return [
    { componentCode: "BASIC", amountMinor: 3_000_000n, isBonus: false, isOvertime: false },
    { componentCode: "DA", amountMinor: 500_000n, isBonus: false, isOvertime: false },
    { componentCode: "CONV", amountMinor: 160_000n, isBonus: false, isOvertime: false },
    { componentCode: "HRA", amountMinor: 1_500_000n, isBonus: false, isOvertime: false },
    { componentCode: "BONUS", amountMinor: 900_000n, isBonus: true, isOvertime: false },
    { componentCode: "OT", amountMinor: 250_000n, isBonus: false, isOvertime: true },
  ];
}

const ORDINARY_BASE = 3_000_000n + 500_000n + 160_000n;

/**
 * ⭐ A BASE CHOSEN SO THE DIVISION IS EXACT: ₹37,440 over 12,480 ordinary
 * minutes is 300 paise a minute at the ordinary rate, 600 at twice it.
 * Proportionality can then be asserted as an EQUALITY rather than as a
 * tolerance, so "half a day is half the money" is tested with nothing
 * hidden inside a rounding allowance.
 */
const EXACT_BASE = 3_744_000n;
const EXACT_PAISE_PER_MINUTE_AT_DOUBLE = 600n;

function run(over: Partial<Parameters<typeof computeOvertime>[0]> = {}) {
  return computeOvertime({
    rules: rules(),
    stateCode: "KA",
    establishmentKind: "factory",
    days: [],
    earnings: earnings(),
    ordinaryMinutesInPeriod: MONTH_ORDINARY_MINUTES,
    quarterToDateOvertimeMinutes: 0,
    quarterToDateIsKnown: true,
    ...over,
  });
}

/** A week of `count` days each of `minutes`, starting Monday 2026-04-06. */
function week(count: number, minutes: number) {
  const days: { onDate: string; workedMinutes: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    days.push({ onDate: `2026-04-${String(6 + i).padStart(2, "0")}`, workedMinutes: minutes });
  }
  return days;
}

/* ================================================================== */
/* ① A HALF DAY IS A HALF DAY                                          */
/* ================================================================== */

describe("part days survive — the Math.floor defect stays fixed", () => {
  it("converts a half day and a quarter day to exactly half and a quarter of a day's minutes", () => {
    const full = minutesFromDayFraction(100, NORMAL_DAY_MINUTES);
    const half = minutesFromDayFraction(50, NORMAL_DAY_MINUTES);
    const quarter = minutesFromDayFraction(25, NORMAL_DAY_MINUTES);

    expect(full).toBe(NORMAL_DAY_MINUTES);
    // 🔴 The two ways this has gone wrong before: floored to nothing,
    // or rounded up to a whole day.
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
    expect(half * 2).toBe(full);
    expect(quarter * 4).toBe(full);
  });

  it("pays a half day of overtime as exactly half of a full day, and a quarter as a quarter", () => {
    const money = (minutes: number) =>
      overtimeWagesMinor({
        ordinaryBaseMinor: EXACT_BASE,
        ordinaryMinutesInPeriod: MONTH_ORDINARY_MINUTES,
        overtimeMinutes: minutes,
        multiplierBp: 20_000,
      });

    const fullDay = money(NORMAL_DAY_MINUTES);
    const halfDay = money(NORMAL_DAY_MINUTES / 2);
    const quarterDay = money(NORMAL_DAY_MINUTES / 4);

    expect(fullDay).toBe(EXACT_PAISE_PER_MINUTE_AT_DOUBLE * BigInt(NORMAL_DAY_MINUTES));
    // 🔴 Neither floored to nothing nor ceiled to a whole day.
    expect(halfDay > 0n).toBe(true);
    expect(halfDay < fullDay).toBe(true);
    expect(halfDay * 2n).toBe(fullDay);
    expect(quarterDay * 4n).toBe(fullDay);
  });

  it("keeps a half day within a paise of half even when the division does not come out even", () => {
    // ⚠️ The realistic case: each line is rounded once, so half of an
    // odd amount cannot double back exactly. What must never happen is
    // the part day collapsing to zero or being paid as a whole one.
    const money = (minutes: number) =>
      overtimeWagesMinor({
        ordinaryBaseMinor: ORDINARY_BASE,
        ordinaryMinutesInPeriod: MONTH_ORDINARY_MINUTES,
        overtimeMinutes: minutes,
        multiplierBp: 20_000,
      });
    const fullDay = money(NORMAL_DAY_MINUTES);
    const halfDay = money(NORMAL_DAY_MINUTES / 2);
    const drift = halfDay * 2n - fullDay;
    expect(halfDay > 0n).toBe(true);
    expect(halfDay < fullDay).toBe(true);
    expect(drift < 0n ? -drift : drift).toBeLessThanOrEqual(2n);
  });

  it("pays seven and a half hours as seven and a half hours, not seven and not eight", () => {
    const money = (minutes: number) =>
      overtimeWagesMinor({
        ordinaryBaseMinor: EXACT_BASE,
        ordinaryMinutesInPeriod: MONTH_ORDINARY_MINUTES,
        overtimeMinutes: minutes,
        multiplierBp: 20_000,
      });

    const sevenHalf = money(450);
    const seven = money(420);
    const eight = money(480);

    expect(sevenHalf > seven).toBe(true);
    expect(sevenHalf < eight).toBe(true);
    // ⭐ 450 minutes is exactly fifteen thirty-minute halves; the pay is
    // exactly fifteen times the pay for thirty minutes, with no drift.
    expect(money(30) * 15n).toBe(sevenHalf);
  });

  it("keeps a half day on the rolls as half a day of the divisor", () => {
    const twentyNineAndAHalf = ordinaryMinutesInPeriod({
      payableCentidays: 2_950,
      normalDailyMinutes: NORMAL_DAY_MINUTES,
    });
    const thirty = ordinaryMinutesInPeriod({
      payableCentidays: 3_000,
      normalDailyMinutes: NORMAL_DAY_MINUTES,
    });
    expect(thirty - twentyNineAndAHalf).toBe(NORMAL_DAY_MINUTES / 2);
  });

  it("counts a part hour of overtime at the end of a day rather than dropping it", () => {
    // Nine and a half hours against a nine hour threshold: thirty minutes.
    const result = run({ days: [{ onDate: "2026-04-06", workedMinutes: 570 }] });
    expect(result.computed).toBe(true);
    expect(result.overtimeMinutes).toBe(30);
    expect(result.overtimeWagesMinor > 0n).toBe(true);
  });

  it("has no floor and no float parsing anywhere on its time or money path", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/payroll/overtime.ts"),
      "utf8",
    );
    // ⚠️ Comments stripped first — the header NAMES the old defect, and
    // a test that banned the words would ban documenting them.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // 🔴 The literal defect: flooring a worked quantity.
    expect(code.includes("Math.floor")).toBe(false);
    expect(code.includes("parseFloat")).toBe(false);
  });
});

/* ================================================================== */
/* ② TWICE, NOT ONE AND A HALF                                         */
/* ================================================================== */

describe("the multiplier is twice the ordinary rate", () => {
  it("pays exactly double what the same minutes are worth at the ordinary rate", () => {
    const minutes = 240;
    const atOrdinary = overtimeWagesMinor({
      ordinaryBaseMinor: EXACT_BASE,
      ordinaryMinutesInPeriod: MONTH_ORDINARY_MINUTES,
      overtimeMinutes: minutes,
      multiplierBp: 10_000,
    });
    const atOvertime = overtimeWagesMinor({
      ordinaryBaseMinor: EXACT_BASE,
      ordinaryMinutesInPeriod: MONTH_ORDINARY_MINUTES,
      overtimeMinutes: minutes,
      multiplierBp: 20_000,
    });

    expect(atOvertime).toBe(atOrdinary * 2n);
    // ⚠️ The American rate, explicitly not what comes out.
    const atOneAndAHalf = (atOrdinary * 3n) / 2n;
    expect(atOvertime > atOneAndAHalf).toBe(true);
  });

  it("blocks a factory configured at one and a half times", () => {
    const result = run({
      rules: rules({ multiplierBp: 15_000 }),
      days: [{ onDate: "2026-04-06", workedMinutes: 600 }],
    });
    expect(result.problems.length).toBeGreaterThan(0);
    expect(
      result.findings.some(
        (f) => f.code === "multiplier_below_statutory_minimum" && f.severity === "blocking",
      ),
    ).toBe(true);
  });
});

/* ================================================================== */
/* ③ THE ORDINARY RATE OF WAGES, s.59(2)                               */
/* ================================================================== */

describe("the base is neither gross nor basic alone", () => {
  it("counts the configured allowances but not the components outside the list", () => {
    const base = ordinaryRateBase({
      earnings: earnings(),
      includeCodes: ["BASIC", "DA", "CONV"],
    });
    const gross = earnings().reduce((t, e) => t + e.amountMinor, 0n);
    const basicOnly = 3_000_000n;

    expect(base.baseMinor).toBe(ORDINARY_BASE);
    // 🔴 Both shortcuts are wrong, in opposite directions.
    expect(base.baseMinor < gross).toBe(true);
    expect(base.baseMinor > basicOnly).toBe(true);
  });

  it("refuses to let a bonus or overtime itself into its own base", () => {
    const withBonus = ordinaryRateBase({
      earnings: earnings(),
      includeCodes: ["BASIC", "BONUS", "OT"],
    });
    expect(withBonus.baseMinor).toBe(3_000_000n);
    expect(withBonus.findings.filter((f) => f.severity === "blocking").length).toBe(2);
  });

  it("says so when a configured component is not on this payslip", () => {
    const missing = ordinaryRateBase({
      earnings: earnings(),
      includeCodes: ["BASIC", "SPECIAL_ALLOWANCE"],
    });
    expect(missing.findings.some((f) => f.code === "ordinary_rate_component_absent")).toBe(true);
  });

  it("refuses the whole calculation when nobody has said what the base is", () => {
    const result = run({ rules: rules({ ordinaryRateIncludes: [] }) });
    expect(result.computed).toBe(false);
    expect(result.overtimeWagesMinor).toBe(0n);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.refusal).toContain("59(2)");
  });
});

/* ================================================================== */
/* ④ AN UNCONFIGURED STATE REFUSES                                     */
/* ================================================================== */

describe("state law selects the rule and an unconfigured state refuses", () => {
  const onFile = [
    rules({ stateCode: "KA" }),
    rules({ stateCode: "TN", establishmentKind: "shops_and_establishments" }),
  ];

  it("finds nothing for a state with no row rather than borrowing another state's", () => {
    expect(
      pickOvertimeRules(onFile, {
        stateCode: "MH",
        establishmentKind: "factory",
        onDate: "2026-04-30",
      }),
    ).toBeNull();
  });

  it("does not let a shops row answer for a factory in the same state", () => {
    expect(
      pickOvertimeRules(onFile, {
        stateCode: "TN",
        establishmentKind: "factory",
        onDate: "2026-04-30",
      }),
    ).toBeNull();
  });

  it("does not reach forward to a row that had not come into force", () => {
    expect(
      pickOvertimeRules(onFile, {
        stateCode: "KA",
        establishmentKind: "factory",
        onDate: "2026-03-31",
      }),
    ).toBeNull();
  });

  it("computes nothing and pays nothing for an unconfigured state, and names it", () => {
    const result = run({
      rules: null,
      stateCode: "MH",
      days: week(6, 600),
    });
    expect(result.computed).toBe(false);
    expect(result.overtimeMinutes).toBe(0);
    expect(result.overtimeWagesMinor).toBe(0n);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.refusal ?? "").toContain("MH");
  });

  it("refuses rules belonging to a different state even when handed them directly", () => {
    const result = run({
      rules: rules({ stateCode: "KA" }),
      stateCode: "MH",
      days: week(6, 600),
    });
    expect(result.computed).toBe(false);
    expect(result.overtimeWagesMinor).toBe(0n);
  });

  it("keeps state variation as data: two states may differ in threshold, cap and multiplier", () => {
    const strict = rules({ dailyThresholdMinutes: 480, multiplierBp: 20_000 });
    const lax = rules({ dailyThresholdMinutes: 540, multiplierBp: 20_000 });
    const day = [{ onDate: "2026-04-06", workedMinutes: 540 }];

    const a = run({ rules: strict, days: day });
    const b = run({ rules: lax, days: day });

    expect(a.overtimeMinutes).toBe(60);
    expect(b.overtimeMinutes).toBe(0);
    expect(a.overtimeWagesMinor > b.overtimeWagesMinor).toBe(true);
  });

  it("reads a rule row out of a jsonb payload, and rejects one that does not parse", () => {
    const parsed = asOvertimeRules(
      {
        establishmentKind: "factory",
        basis: "greater_of",
        multiplierBp: 20_000,
        dailyThresholdMinutes: 540,
        weeklyThresholdMinutes: 2_880,
        weekStartsOnWeekday: 0,
        ordinaryRateIncludes: ["BASIC", "DA"],
        quarterlyOvertimeCapMinutes: 3_000,
      },
      "KA",
      "2026-04-01",
      null,
    );
    expect(parsed?.multiplierBp).toBe(20_000);
    expect(parsed?.stateCode).toBe("KA");

    // 🔴 A malformed row is a null, never a zero multiplier.
    expect(asOvertimeRules({ establishmentKind: "factory" }, "KA", "2026-04-01", null)).toBeNull();
    expect(asOvertimeRules(null, "KA", "2026-04-01", null)).toBeNull();
  });
});

/* ================================================================== */
/* ⑤ THE CAPS ARE AN OFFENCE, NOT A ROUNDING MATTER                    */
/* ================================================================== */

describe("exceeding the statutory cap is surfaced", () => {
  it("blocks a week over the total-hours cap while still stating the wages owed", () => {
    // Six days of eleven hours: 3960 minutes against a 3600 cap.
    const result = run({ days: week(6, 660) });
    expect(result.computed).toBe(true);
    expect(result.overtimeWagesMinor > 0n).toBe(true);
    expect(result.findings.some((f) => f.code === "weekly_total_cap_exceeded")).toBe(true);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("blocks a day over the daily total cap", () => {
    const result = run({ days: [{ onDate: "2026-04-06", workedMinutes: 700 }] });
    expect(result.findings.some((f) => f.code === "daily_total_cap_exceeded")).toBe(true);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("counts the cap per quarter, so an innocent month can be the one that breaches", () => {
    const days = week(6, 600); // 360 minutes of overtime this period
    const clean = run({ days, quarterToDateOvertimeMinutes: 0 });
    const late = run({ days, quarterToDateOvertimeMinutes: 2_800 });

    expect(clean.findings.some((f) => f.code === "quarterly_overtime_cap_exceeded")).toBe(false);
    expect(late.findings.some((f) => f.code === "quarterly_overtime_cap_exceeded")).toBe(true);
    expect(late.problems.length).toBeGreaterThan(clean.problems.length);
    // ⚠️ The hours are still owed — surfacing the breach must not become
    // a way of not paying for work already done.
    expect(late.overtimeWagesMinor).toBe(clean.overtimeWagesMinor);
  });

  it("blocks rather than assumes when no quarterly cap is configured for the state", () => {
    const result = run({
      rules: rules({ quarterlyOvertimeCapMinutes: null }),
      days: week(6, 600),
    });
    expect(result.findings.some((f) => f.code === "quarterly_cap_not_configured")).toBe(true);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("says so when the quarter's earlier overtime is not known to the run", () => {
    const result = run({ days: week(6, 600), quarterToDateIsKnown: false });
    expect(result.findings.some((f) => f.code === "quarter_to_date_unknown")).toBe(true);
  });

  it("takes the greater of the daily and the weekly excess, never their sum", () => {
    const days = week(6, 600); // daily excess 6x60=360; weekly 3600-2880=720
    const greater = run({ days });
    const daily = run({ rules: rules({ basis: "daily" }), days });
    const weekly = run({ rules: rules({ basis: "weekly" }), days });

    expect(daily.overtimeMinutes).toBe(360);
    expect(weekly.overtimeMinutes).toBe(720);
    expect(greater.overtimeMinutes).toBe(720);
    expect(greater.overtimeMinutes).toBeLessThan(daily.overtimeMinutes + weekly.overtimeMinutes);
  });
});

/* ================================================================== */
/* ⑥ EXACT PAISE                                                       */
/* ================================================================== */

describe("money is exact paise, not a float", () => {
  it("stays exact at a magnitude where a double has already lost whole paise", () => {
    // ₹99,99,999.99 of ordinary wages. Multiplied out this exceeds
    // 2^53, so the naive float arithmetic is no longer exact.
    const baseMinor = 999_999_999n;
    const overtimeMinutes = 450;
    const multiplierBp = 20_000;
    const minutesInPeriod = 12_480;

    const wages = overtimeWagesMinor({
      ordinaryBaseMinor: baseMinor,
      ordinaryMinutesInPeriod: minutesInPeriod,
      overtimeMinutes,
      multiplierBp,
    });

    const numerator = baseMinor * BigInt(overtimeMinutes) * BigInt(multiplierBp);
    const denominator = BigInt(minutesInPeriod) * 10_000n;
    const residue = wages * denominator - numerator;
    const magnitude = residue < 0n ? -residue : residue;

    // ⭐ The defining property of an exactly rounded quotient: the
    // reconstruction is within half a denominator. A float path drifts
    // further than this at these magnitudes.
    expect(magnitude * 2n <= denominator).toBe(true);
    expect(typeof wages).toBe("bigint");
  });

  it("rounds a half paise away from zero rather than down", () => {
    // 2 × 15000 / (2 × 10000) = 1.5 exactly.
    const wages = overtimeWagesMinor({
      ordinaryBaseMinor: 2n,
      ordinaryMinutesInPeriod: 2,
      overtimeMinutes: 1,
      multiplierBp: 15_000,
    });
    expect(wages).toBe(2n);
  });

  it("never produces a fraction of a paise and never a NaN", () => {
    for (const minutes of [1, 7, 59, 450, 3_599]) {
      const wages = overtimeWagesMinor({
        ordinaryBaseMinor: ORDINARY_BASE,
        ordinaryMinutesInPeriod: MONTH_ORDINARY_MINUTES,
        overtimeMinutes: minutes,
        multiplierBp: 20_000,
      });
      expect(typeof wages).toBe("bigint");
      expect(wages >= 0n).toBe(true);
    }
  });

  it("refuses fractional minutes instead of rounding somebody's hours away", () => {
    const result = run({ days: [{ onDate: "2026-04-06", workedMinutes: 570.5 }] });
    expect(result.computed).toBe(false);
    expect(result.overtimeWagesMinor).toBe(0n);
  });
});
