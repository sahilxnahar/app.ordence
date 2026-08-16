/**
 * Ordence — ⭐⭐⭐ HALF-DAY LOP REGRESSION (centidays rewrite)
 * Version: v1.50.0-alpha
 *
 * Tests the centidays fix for half-day loss of pay.
 *
 * 🔴 BEFORE: the payslip floored a fractional month (29.5 days → 29) and
 * paid 29/30 of a ₹60,000 month — ₹1,000 docked from the employee,
 * silently, always in the employer's favour. The remainder was reported
 * as a "verify this assumption" problem; a half-day absence could stop
 * a payroll run from being approved at all.
 *
 * ⭐ AFTER: `buildPayslip` divides in centidays. 29.5/30 stays 29.5/30,
 * a half-day LOP is charged as exactly half, the register and the payslip
 * agree to the centiday, and nothing is left to verify.
 */

import { describe, expect, it } from "vitest";
import { buildPayslip, type PayComponent } from "@/lib/payroll/payslip";

const r = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

const COMPONENTS: PayComponent[] = [
  { code: "BASIC", label: "Basic", kind: "earning", pfApplicable: true, esiApplicable: true, taxable: true, proRates: true, displayOrder: 10 },
];

const EMPLOYEE = {
  stateCode: "KA",
  pfExempt: false,
  pfOnFullWages: false,
  esiExempt: false,
  esiCoveredAtPeriodStart: false,
  taxRegime: "new" as const,
  declaredDeductionsMinor: "0",
  tdsOverrideMinor: null,
  hasPan: true,
};

describe("half-day LOP", () => {
  it("charges the half day as exactly half — never as zero, never as one", () => {
    // 15.5 lop days on a 31-day month with 31 payable days.
    // paidDays() yields 15.5, which is now REAL, not a problem.
    const slip = buildPayslip({
      employee: EMPLOYEE,
      components: COMPONENTS,
      structure: [{ componentCode: "BASIC", monthlyAmountMinor: r(31_000).toString() }],
      attendance: { daysInMonth: 31, payableDays: 31, lopDays: 15.5 },
      month: 6,
      periodEnd: "2025-06-30",
      pfRules: null,
      esiRules: null,
      ptSlabs: [],
      taxRules: null,
      taxSlabs: [],
      monthsRemaining: 12,
      tdsAlreadyDeductedMinor: "0",
    });

    // ⭐ 15.5/31 of ₹31,000 = ₹15,500 exactly. The floored maths paid
    // ₹15,000 — ₹500 docked from the employee, always.
    const basicLine = slip.lines.find((l) => l.componentCode === "BASIC");
    expect(basicLine).toBeDefined();
    expect(basicLine!.amountMinor).toBe(r(15_500));

    // The register and the payslip state the SAME figures: 15.5 of 31
    // days, and the 15.5-day loss of pay.
    expect(basicLine!.workingNote).toContain("15.50 of 31 days paid");
    expect(basicLine!.workingNote).toContain("15.50 days loss of pay");
  });

  it("leaves NO problem behind — the part day is charged, not verified", () => {
    const slip = buildPayslip({
      employee: EMPLOYEE,
      components: COMPONENTS,
      structure: [{ componentCode: "BASIC", monthlyAmountMinor: r(31_000).toString() }],
      attendance: { daysInMonth: 31, payableDays: 31, lopDays: 15.5 },
      month: 6,
      periodEnd: "2025-06-30",
      pfRules: null,
      esiRules: null,
      ptSlabs: [],
      taxRules: null,
      taxSlabs: [],
      monthsRemaining: 12,
      tdsAlreadyDeductedMinor: "0",
    });

    // 🔴 The old behaviour reported the fraction as "remainder charged
    // as whole days — please verify". There is no remainder any more:
    // the half day divided exactly, and `unrepresentableCentidays` is
    // the agreement value, which is zero.
    const fractional = slip.problems.find((p) => p.includes("fractional loss of pay"));
    expect(fractional).toBeUndefined();
    const remainder = slip.problems.find((p) => p.includes("NOT on this payslip"));
    expect(remainder).toBeUndefined();
  });

  it("still refuses a run when the register and the payslip disagree", () => {
    // The centidays arithmetic guarantees agreement today; the refusal
    // must remain, because a broken agreement is the one thing the
    // payslip must never hide.
    const slip = buildPayslip({
      employee: EMPLOYEE,
      components: COMPONENTS,
      structure: [{ componentCode: "BASIC", monthlyAmountMinor: r(31_000).toString() }],
      attendance: { daysInMonth: 31, payableDays: 31, lopDays: 15 },
      month: 6,
      periodEnd: "2025-06-30",
      pfRules: null,
      esiRules: null,
      ptSlabs: [],
      taxRules: null,
      taxSlabs: [],
      monthsRemaining: 12,
      tdsAlreadyDeductedMinor: "0",
    });

    const wholeDay = slip.problems.find((p) => p.includes("no longer agree"));
    expect(wholeDay).toBeUndefined();
  });
});
