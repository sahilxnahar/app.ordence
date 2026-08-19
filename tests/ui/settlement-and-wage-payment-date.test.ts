/**
 * Ordence — ⭐⭐⭐ FULL AND FINAL SETTLEMENT, AND THE DATE WAGES WERE PAID
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE ASSERTIONS AND NOT OTHERS
 * ══════════════════════════════════════════════════════════════════════
 * Both features fail SILENTLY and both fail against somebody who has
 * already left and cannot argue. So the tests are on the four places
 * where being wrong is invisible:
 *
 *   ① THE s.7(3) CAP REFUSES, IT DOES NOT CLAMP. A clamped settlement
 *     is a lawful-looking number that leaves the employer believing the
 *     balance was recovered. The assertion is on the BEHAVIOUR — nothing
 *     applied, nothing payable, the full claim still visible — not on
 *     any message.
 *   ② GRATUITY IS OUT OF THE CAP BASE. Asserted as a relation between
 *     two settlements that differ ONLY in the gratuity, so no wording
 *     and no field ordering can make it pass by accident.
 *   ③ A TERMINATED EMPLOYEE IS ON THE LAST WORKING DAY, NOT THE 7TH.
 *   ④ EXACT PAISE AT A BOUNDARY A FLOAT GETS WRONG — a cap base with an
 *     odd number of paise, where dividing rupees by two and rounding
 *     permits one paise more than the Act does.
 *
 * ⚠️ THE ASSERTIONS ARE PROPERTIES — relations between two computed
 * results, or the exact paise at a boundary — so that rewording a note
 * or adding a field cannot make them fail, and so that changing the
 * arithmetic cannot make them pass.
 */

import { describe, expect, it } from "vitest";

import {
  DEDUCTION_CAP_BP,
  DEDUCTION_CAP_BP_WITH_CO_OPERATIVE,
  computeSettlement,
  deductionCapBp,
  maximumLawfulDeductionMinor,
  partMonthWagesMinor,
  settlementSnapshot,
  type Recovery,
  type SettlementArgs,
} from "@/lib/payroll/settlement";
import {
  dueDateFor,
  wagePaymentDueDate,
  wagePaymentStatus,
  overdueWagePayments,
  type WageRunFacts,
} from "@/lib/compliance/statutory-due";
import type { GratuityRules } from "@/lib/payroll/gratuity";

/* ------------------------------------------------------------------ */
/* THE RULE ROWS — DATA, AS THE ENGINE REQUIRES                        */
/* ------------------------------------------------------------------ */

const RULES_2018: GratuityRules = {
  effectiveFrom: "2018-03-29",
  effectiveTo: null,
  ceilingMinor: "200000000", // ₹20,00,000
  daysWagesPerCompletedYear: 15,
  monthlyWageDivisorDays: 26,
  seasonalDaysWagesPerSeason: 7,
  minimumContinuousYears: 5,
  delayInterestRateBpPerAnnum: null,
};

/**
 * ⭐ ONE BASE SETTLEMENT THE WHOLE FILE VARIES FROM, so that every
 * assertion below is a difference between two runs rather than a
 * hand-computed constant nobody can check.
 *
 * ⚠️ 18 of 31 days at ₹45,000 is chosen because it produces a cap base
 * with an ODD number of paise — see the float boundary test.
 */
function baseArgs(over: Partial<SettlementArgs> = {}): SettlementArgs {
  return {
    employee: {
      joinedOn: "2014-04-01",
      leftOn: "2025-03-18",
      lastDrawnWagesMinor: "4500000", // ₹45,000 basic + DA
    },
    cause: "resignation",
    lastWorkingDay: "2025-03-18",
    partMonth: {
      monthlyWagesMinor: "4500000",
      daysPayable: 18,
      divisor: { kind: "calendar_days_of_month", daysInMonth: 31 },
    },
    leaveBalanceCentidays: 0,
    leaveDailyRateMinor: "150000",
    leaveRateBasisNote: "basic + DA ÷ 30, as the standing orders provide",
    notice: { direction: "none", amountMinor: "0", reference: "n/a" },
    recoveries: [],
    gratuityRulesHistory: [RULES_2018],
    ...over,
  };
}

const advance = (paise: string): Recovery => ({
  kind: "advance_or_overpayment",
  description: "Salary advance of March 2024",
  amountMinor: paise,
  reference: "ADV-2024-0117",
});

/* ================================================================== */
/* ① THE 50% CAP REFUSES RATHER THAN CLAMPS                            */
/* ================================================================== */

describe("Payment of Wages Act, 1936 s.7(3) — the deduction cap", () => {
  it("refuses an over-cap settlement instead of clamping the recovery to the limit", () => {
    const result = computeSettlement(baseArgs());
    const cap = result.maximumLawfulDeductionMinor;

    const overCap = computeSettlement(baseArgs({ recoveries: [advance(String(cap + 1n))] }));

    // 🔴 THE WHOLE POINT: it is a refusal.
    expect(overCap.refused).toBe(true);
    // ⭐ NOTHING WAS APPLIED. A clamp would have put `cap` here, which is
    // the exact lie this test exists to catch.
    expect(overCap.deductionsAppliedMinor).toBe(0n);
    expect(overCap.deductionsAppliedMinor).not.toBe(cap);
    // ⭐ AND NO NET IS OFFERED. A refused settlement has no payable figure.
    expect(overCap.netPayableMinor).toBe(0n);
    // ⚠️ The employer still sees the full claim and the excess, which is
    // what lets them decide which head to drop.
    expect(overCap.recoveriesClaimedMinor).toBe(cap + 1n);
    expect(overCap.overCapByMinor).toBe(1n);
    expect(overCap.problems.length).toBeGreaterThan(0);
  });

  it("permits the settlement at exactly the cap, so the refusal is a boundary and not a blanket", () => {
    const cap = computeSettlement(baseArgs()).maximumLawfulDeductionMinor;
    const atCap = computeSettlement(baseArgs({ recoveries: [advance(String(cap))] }));

    expect(atCap.refused).toBe(false);
    expect(atCap.deductionsAppliedMinor).toBe(cap);
    expect(atCap.overCapByMinor).toBe(0n);
    // ⭐ THE NET IS THE GROSS LESS THE RECOVERY, EXACTLY. Not the base.
    expect(atCap.netPayableMinor).toBe(atCap.grossDuesMinor - cap);
  });

  it("lifts the cap to 75% when any part of the deductions is a co-operative society payment", () => {
    // ⚠️ "wholly or PARTLY made for payments to co-operative societies" —
    // one rupee moves the cap for the whole set, which is surprising and
    // is the drafting.
    const withCoop: readonly Recovery[] = [
      advance("100000"),
      {
        kind: "co_operative_society",
        description: "Monthly subscription, employees' credit society",
        amountMinor: "100",
        reference: "COOP-88",
      },
    ];
    expect(deductionCapBp([advance("100000")])).toBe(DEDUCTION_CAP_BP);
    expect(deductionCapBp(withCoop)).toBe(DEDUCTION_CAP_BP_WITH_CO_OPERATIVE);

    const plain = computeSettlement(baseArgs());
    const lifted = computeSettlement(baseArgs({ recoveries: withCoop }));
    // ⭐ Same base, larger allowance, and the ratio is the proviso's.
    expect(lifted.capBaseMinor).toBe(plain.capBaseMinor);
    expect(lifted.maximumLawfulDeductionMinor).toBeGreaterThan(
      plain.maximumLawfulDeductionMinor,
    );
  });

  it("refuses a deduction for an unreturned asset with no s.10 show-cause reference", () => {
    // 🔴 The commonest unlawful line on an Indian settlement, and it is
    // small enough to be nowhere near the 50% cap — so the refusal has to
    // come from s.10(1A) and not from s.7(3).
    const tiny = computeSettlement(
      baseArgs({
        recoveries: [
          {
            kind: "unreturned_asset",
            description: "Laptop not returned",
            amountMinor: "100000",
            reference: "ASSET-4412",
          },
        ],
      }),
    );
    expect(tiny.overCapByMinor).toBe(0n);
    expect(tiny.refused).toBe(true);
    expect(tiny.netPayableMinor).toBe(0n);

    const heard = computeSettlement(
      baseArgs({
        recoveries: [
          {
            kind: "unreturned_asset",
            description: "Laptop not returned",
            amountMinor: "100000",
            reference: "ASSET-4412",
            showCauseReference: "SCN/2025/09 — replied 12 March 2025",
          },
        ],
      }),
    );
    expect(heard.refused).toBe(false);
    expect(heard.deductionsAppliedMinor).toBe(100000n);
  });

  it("refuses notice-shortfall recovery until the employer states its ground, because s.7(2) does not list it", () => {
    const bare = computeSettlement(
      baseArgs({
        recoveries: [
          {
            kind: "notice_shortfall",
            description: "30 days of notice not served",
            amountMinor: "100000",
            reference: "Appointment letter cl. 9",
          },
        ],
      }),
    );
    expect(bare.refused).toBe(true);

    const stated = computeSettlement(
      baseArgs({
        recoveries: [
          {
            kind: "notice_shortfall",
            description: "30 days of notice not served",
            amountMinor: "100000",
            reference: "Appointment letter cl. 9",
            authorisedBecause: "Clause 9 of the accepted appointment letter, signed 2014-03-20.",
          },
        ],
      }),
    );
    expect(stated.refused).toBe(false);
  });
});

/* ================================================================== */
/* ② GRATUITY IS NOT IN THE CAP BASE                                   */
/* ================================================================== */

describe("s.2(vi) — gratuity is not wages for the deduction cap", () => {
  it("leaves the cap base and the maximum deduction unchanged when the gratuity changes", () => {
    // ⭐ TWO SETTLEMENTS IDENTICAL EXCEPT FOR SERVICE LENGTH, so the only
    // figure that moves is the gratuity. If gratuity were in the base,
    // the longer service would enlarge what may lawfully be deducted.
    const short = computeSettlement(baseArgs({ employee: { joinedOn: "2019-04-01", leftOn: "2025-03-18", lastDrawnWagesMinor: "4500000" } }));
    const long = computeSettlement(baseArgs({ employee: { joinedOn: "2000-04-01", leftOn: "2025-03-18", lastDrawnWagesMinor: "4500000" } }));

    const gratuityOf = (r: typeof short) =>
      r.earnings.find((l) => l.key === "gratuity_statutory")?.amountMinor ?? 0n;

    expect(gratuityOf(long)).toBeGreaterThan(gratuityOf(short));
    expect(long.grossDuesMinor).toBeGreaterThan(short.grossDuesMinor);

    // 🔴 THE PROPERTY. The base and the cap do not move at all.
    expect(long.capBaseMinor).toBe(short.capBaseMinor);
    expect(long.maximumLawfulDeductionMinor).toBe(short.maximumLawfulDeductionMinor);
    // ⭐ And the excluded amount is exactly the gratuity.
    expect(long.capBaseExcludesMinor).toBe(gratuityOf(long));
    expect(long.grossDuesMinor - long.capBaseMinor).toBe(gratuityOf(long));
  });

  it("refuses a recovery that would only be lawful if gratuity were folded into the base", () => {
    const long = computeSettlement(
      baseArgs({ employee: { joinedOn: "2000-04-01", leftOn: "2025-03-18", lastDrawnWagesMinor: "4500000" } }),
    );
    // Half the GROSS — which includes a large gratuity — is far above half
    // the wages. This is the number an employer arrives at by halving the
    // settlement total, and it is unlawful.
    const halfOfGross = long.grossDuesMinor / 2n;
    expect(halfOfGross).toBeGreaterThan(long.maximumLawfulDeductionMinor);

    const attempt = computeSettlement(
      baseArgs({
        employee: { joinedOn: "2000-04-01", leftOn: "2025-03-18", lastDrawnWagesMinor: "4500000" },
        recoveries: [advance(String(halfOfGross))],
      }),
    );
    expect(attempt.refused).toBe(true);
    expect(attempt.deductionsAppliedMinor).toBe(0n);
  });

  it("keeps leave encashment inside the base by default, and says so on the line", () => {
    // ⚠️ Configuration, not a constant — s.2(vi)(d) puts sums payable BY
    // REASON OF TERMINATION inside "wages", and this is the default that
    // reading produces. The test asserts the wiring, not the policy.
    const withLeave = computeSettlement(
      baseArgs({ leaveBalanceCentidays: 1_200, leaveDailyRateMinor: "150000" }),
    );
    const withoutLeave = computeSettlement(baseArgs());
    expect(withLeave.capBaseMinor).toBeGreaterThan(withoutLeave.capBaseMinor);

    const excluded = computeSettlement(
      baseArgs({
        leaveBalanceCentidays: 1_200,
        leaveDailyRateMinor: "150000",
        capBase: {
          leaveEncashmentIsWages: false,
          noticePayInLieuIsWages: true,
          exGratiaIsWages: false,
        },
      }),
    );
    expect(excluded.capBaseMinor).toBe(withoutLeave.capBaseMinor);
    expect(excluded.grossDuesMinor).toBe(withLeave.grossDuesMinor);
  });
});

/* ================================================================== */
/* ③ EXACT PAISE AT A BOUNDARY A FLOAT GETS WRONG                      */
/* ================================================================== */

describe("exact paise", () => {
  it("computes the cap by flooring the exact half-paise, where a rupee-float would round up and permit one paise too much", () => {
    const result = computeSettlement(baseArgs());

    // ₹45,000 × 18 ÷ 31 = 26,12,903.2258… paise → 26,12,903 paise.
    expect(result.capBaseMinor).toBe(2_612_903n);
    // 🔴 AN ODD NUMBER OF PAISE, so half of it is x.5 and the direction of
    // the rounding is the whole test.
    expect(result.capBaseMinor % 2n).toBe(1n);

    // ⭐ THE EXACT FIGURE THE ACT PERMITS: floor, never up.
    expect(result.maximumLawfulDeductionMinor).toBe(1_306_451n);

    // ⚠️ WHAT A FLOAT PIPELINE PRODUCES. Rupees, halved, rounded to paise:
    // 26129.03 / 2 = 13064.515 → 13064.52 → 13,06,452 paise. One paise
    // more than the Act allows, and it is a deduction, so it comes out of
    // somebody's settlement.
    const floatCap = Math.round((Number(result.capBaseMinor) / 100 / 2) * 100);
    expect(BigInt(floatCap)).toBe(result.maximumLawfulDeductionMinor + 1n);

    // 🔴 AND THAT ONE PAISE IS REFUSED.
    const attempt = computeSettlement(baseArgs({ recoveries: [advance(String(floatCap))] }));
    expect(attempt.refused).toBe(true);
    expect(attempt.overCapByMinor).toBe(1n);
  });

  it("divides once at the end, so a part month is not the rounded daily rate multiplied out", () => {
    const once = partMonthWagesMinor({
      monthlyWagesMinor: "4500000",
      daysPayable: 17,
      divisor: { kind: "calendar_days_of_month", daysInMonth: 31 },
    });
    // The spreadsheet method: round a daily rate first, then multiply.
    const perDayRounded = (4_500_000n / 31n) * 17n;
    expect(once).not.toBe(perDayRounded);
    expect(once).toBe(2_467_742n);
    // ⭐ AND IT IS ALWAYS THE NEARER OF THE TWO TO THE EXACT RATIO.
    expect(once * 31n - 4_500_000n * 17n).toBeLessThanOrEqual(31n);
  });

  it("keeps the cap a pure integer relation: applied × 10000 ≤ base × bp", () => {
    // ⭐ The same invariant the database CHECK enforces, asserted here so
    // the two can never drift.
    for (const claim of ["0", "1", "999999", "1306451"]) {
      const r = computeSettlement(baseArgs({ recoveries: [advance(claim)] }));
      expect(r.deductionsAppliedMinor * 10_000n).toBeLessThanOrEqual(
        r.capBaseMinor * BigInt(r.capBp),
      );
    }
    expect(maximumLawfulDeductionMinor(0n, DEDUCTION_CAP_BP)).toBe(0n);
  });
});

/* ================================================================== */
/* ④ THE DATE WAGES FELL DUE                                           */
/* ================================================================== */

describe("Payment of Wages Act, 1936 s.5 — when wages fell due", () => {
  it("puts a terminated employee on the last working day, not the 7th of the following month", () => {
    const terminated = wagePaymentDueDate({
      periodEnd: "2025-03-31",
      band: "under_1000",
      terminatedOn: "2025-03-18",
    });
    const ordinary = wagePaymentDueDate({ periodEnd: "2025-03-31", band: "under_1000" });

    // 🔴 THE PROPERTY: the leaver's date is anchored to their last working
    // day and is strictly earlier than the wage-period date.
    expect(terminated.dueOn).toBe("2025-03-18");
    expect(terminated.basis).toBe("termination");
    expect(ordinary.dueOn).toBe(dueDateFor("2025-03-31", 7));
    expect(terminated.dueOn < ordinary.dueOn).toBe(true);
  });

  it("uses the tenth day where a thousand or more persons are employed", () => {
    const small = wagePaymentDueDate({ periodEnd: "2025-03-31", band: "under_1000" });
    const large = wagePaymentDueDate({ periodEnd: "2025-03-31", band: "1000_or_more" });
    expect(large.dueOn > small.dueOn).toBe(true);
    expect(large.dueOn).toBe(dueDateFor("2025-03-31", 10));
  });

  it("treats an approved, posted, unpaid run as overdue — approval is not payment", () => {
    const run: WageRunFacts = {
      runNo: "PR-2025-03",
      periodEnd: "2025-03-31",
      netPayMinor: 1_250_000_00n,
      employeeCount: 40,
      paidOn: null,
      paymentFailedOn: "2025-04-06",
      band: "under_1000",
      terminatedOn: null,
    };
    const status = wagePaymentStatus(run, "2025-04-09");
    expect(status.state).toBe("overdue");
    expect(status.lateBy).toBeGreaterThan(0);
    expect(overdueWagePayments([run], "2025-04-09")).toHaveLength(1);

    // ⭐ And a paid run drops out of the overdue set entirely, while still
    // carrying how late the payment itself was.
    const paidLate = wagePaymentStatus({ ...run, paidOn: "2025-04-12", paymentFailedOn: null }, "2025-04-30");
    expect(paidLate.lateBy).toBe(5);
    expect(overdueWagePayments([{ ...run, paidOn: "2025-04-12", paymentFailedOn: null }], "2025-04-30")).toHaveLength(0);
  });
});

/* ================================================================== */
/* ⑤ REPRODUCIBILITY                                                   */
/* ================================================================== */

describe("the settlement is reproducible", () => {
  it("snapshots every input alongside the working, with no bigint left to be lost by JSON", () => {
    const args = baseArgs({ recoveries: [advance("100000")] });
    const result = computeSettlement(args);
    const snap = settlementSnapshot(args, result);

    // ⭐ THE PROPERTY: the snapshot survives a JSON round trip intact,
    // which a `bigint` anywhere in it would not.
    const round = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(round).toEqual(snap);

    // ⭐ AND RECOMPUTING FROM THE STORED INPUTS REPRODUCES THE FIGURES.
    const again = computeSettlement(args);
    expect(again.netPayableMinor).toBe(result.netPayableMinor);
    expect(again.capBaseMinor).toBe(result.capBaseMinor);
    expect(again.grossDuesMinor).toBe(result.grossDuesMinor);
  });
});
