/**
 * Ordence — ⭐⭐⭐ HALF-DAY LOP REGRESSION
 * Version: v1.48.0-alpha · Track 1
 *
 * Tests the fix for the half-day LOP BigInt RangeError.
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
  it("should not throw RangeError and emit a problem with the assumption named", () => {
    // 15.5 lop days on a 31-day month with 31 payable days.
    // paidDays() yields 15.5.
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

    // Assert that the problem is emitted
    expect(slip.problems.length).toBeGreaterThan(0);
    const problemMessage = slip.problems.find(p => p.includes("fractional loss of pay"));
    expect(problemMessage).toBeDefined();
    expect(problemMessage).toContain("15.5 days");
    expect(problemMessage).toContain("remainder is charged as whole days");

    // Assert that the working note uses the floored value
    const basicLine = slip.lines.find(l => l.componentCode === "BASIC");
    expect(basicLine).toBeDefined();
    expect(basicLine!.workingNote).toContain("15 of 31 days paid");
    expect(basicLine!.workingNote).toContain("15.5 days loss of pay");

    // Assert the amount is calculated based on 15 days, not 15.5
    // 31,000 * 15 / 31 = 15,000
    expect(basicLine!.amountMinor).toBe(r(15_000));
  });

  it("should not emit a problem if lopDays is a whole number", () => {
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

    const problemMessage = slip.problems.find(p => p.includes("fractional loss of pay"));
    expect(problemMessage).toBeUndefined();
  });
});
