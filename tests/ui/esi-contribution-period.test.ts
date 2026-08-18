/**
 * Ordence — ⭐⭐⭐ BATCH 79: THE PERSON WHO LOST THEIR ESI IN JULY
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ONE HARDCODED `false` TOOK A REAL PERSON OFF THE ESI REGISTER
 * ══════════════════════════════════════════════════════════════════════
 * `computeEsi()` has always implemented reg.4 of the ESI (General)
 * Regulations 1950 correctly: covered when the contribution period began
 * ⇒ covered until it ends, contributing on ACTUAL wages however far they
 * rise. `server/payroll/run.ts` fed it
 * `esiCoveredAtPeriodStart: false` for every employee, every month, and
 * called it an approximation.
 *
 * ⚠️ THE FAILURE IS NOT A MIS-STATED CHALLAN. It is somebody who thinks
 * they have medical cover, whose employer silently stopped contributing
 * the month they got a rise, and who finds out at a hospital counter —
 * with their dependants, whose cover derives from theirs.
 *
 * These assert PROPERTIES of the decision, not the shape of the code:
 * who is covered, when they stop being covered, and what happens when
 * nobody can tell.
 */

import { describe, expect, it } from "vitest";
import {
  resolveEsiCoverage,
  type EsiHistoryRow,
} from "@/lib/payroll/esi-coverage";
import { buildPayslip, type PayComponent } from "@/lib/payroll/payslip";
import { withEsiCoverageStory } from "@/server/payroll/run";
import type { EsiRules, PfRules, PtSlab } from "@/lib/payroll/statutory";

const r = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

const ESI: EsiRules = {
  effectiveFrom: "2024-04-01",
  effectiveTo: null,
  employeeRateBp: 75,
  employerRateBp: 325,
  wageLimitMinor: "2100000", // ₹21,000
};

const PF: PfRules = {
  effectiveFrom: "2024-04-01",
  effectiveTo: null,
  employeeRateBp: 1200,
  employerRateBp: 1200,
  pensionRateBp: 833,
  wageCeilingMinor: "1500000",
  pensionCeilingMinor: "1500000",
  edliRateBp: 50,
  adminRateBp: 50,
};

const PT: PtSlab[] = [];

const COMPONENTS: PayComponent[] = [
  {
    code: "BASIC",
    label: "Basic",
    kind: "earning",
    pfApplicable: true,
    esiApplicable: true,
    taxable: true,
    proRates: true,
    displayOrder: 10,
  },
];

/** A month's payslip for somebody on `monthlyRupees`, at a stated coverage. */
function slip(monthlyRupees: number, coveredAtPeriodStart: boolean, periodEnd: string) {
  return buildPayslip({
    employee: {
      stateCode: "KA",
      pfExempt: false,
      pfOnFullWages: false,
      esiExempt: false,
      esiCoveredAtPeriodStart: coveredAtPeriodStart,
      taxRegime: "new",
      declaredDeductionsMinor: "0",
      tdsOverrideMinor: null,
      hasPan: true,
    },
    components: COMPONENTS,
    structure: [{ componentCode: "BASIC", monthlyAmountMinor: r(monthlyRupees).toString() }],
    attendance: { daysInMonth: 30, payableDays: 30, lopDays: 0 },
    month: Number(periodEnd.slice(5, 7)),
    periodEnd,
    pfRules: PF,
    esiRules: ESI,
    ptSlabs: PT,
    taxRules: null,
    taxSlabs: [],
    monthsRemaining: 12,
    tdsAlreadyDeductedMinor: "0",
  });
}

const paid = (periodStart: string, periodEnd: string, esiRupees: number): EsiHistoryRow => ({
  runPeriodStart: periodStart,
  runPeriodEnd: periodEnd,
  employeeEsiMinor: r(esiRupees),
  employerEsiMinor: r(esiRupees * 4),
});

/** April: on ₹18,000, under the ₹21,000 limit, so ESI was deducted. */
const APRIL_COVERED = paid("2025-04-01", "2025-04-30", 135);
/** July onwards: above the limit, and the old code deducted nothing. */
const nilMonth = (start: string, end: string): EsiHistoryRow => ({
  runPeriodStart: start,
  runPeriodEnd: end,
  employeeEsiMinor: 0n,
  employerEsiMinor: 0n,
});

const forEmployee = (over: Partial<Parameters<typeof resolveEsiCoverage>[0]> = {}) =>
  resolveEsiCoverage({
    periodStart: "2025-08-01",
    periodEnd: "2025-08-31",
    joinedOn: "2023-01-09",
    esiExempt: false,
    hasRules: true,
    history: [APRIL_COVERED],
    ...over,
  });

/* ================================================================== */
/* ① THE LOAD-BEARING RULE                                             */
/* ================================================================== */

describe("🔴 covered on 1 April, crosses the ceiling in July", () => {
  it("is still covered in August, from the April payslip and nothing else", () => {
    const august = forEmployee();
    expect(august.coveredAtPeriodStart).toBe(true);
    expect(august.basis).toBe("evidence_covered");
    expect(august.windowStart).toBe("2025-04-01");
  });

  it("is still covered in September, the last month of the period", () => {
    const september = forEmployee({
      periodStart: "2025-09-01",
      periodEnd: "2025-09-30",
      history: [APRIL_COVERED, nilMonth("2025-07-01", "2025-07-31")],
    });
    expect(september.coveredAtPeriodStart).toBe(true);
  });

  it("⭐ AND THE MONEY FOLLOWS: ESI is deducted on the ACTUAL wages, not on the limit", () => {
    const august = slip(40_000, forEmployee().coveredAtPeriodStart, "2025-08-31");
    expect(august.employeeEsiMinor).toBeGreaterThan(0n);
    // 0.75% of ₹40,000 = ₹300, rounded up to the rupee by regulation.
    expect(august.employeeEsiMinor).toBe(r(300));
    // ⚠️ NOT 0.75% of the ₹21,000 limit. ESI is not PF.
    expect(august.employeeEsiMinor).not.toBe(r(157.5));
  });

  it("🔴 and the old hardcoded answer would have paid them nothing", () => {
    expect(slip(40_000, false, "2025-08-31").employeeEsiMinor).toBe(0n);
  });
});

/* ================================================================== */
/* ② AND THEY LOSE IT ON 1 OCTOBER, NOT BEFORE                         */
/* ================================================================== */

describe("🔴 the period ends on 30 September", () => {
  it("does not carry April–September coverage into October", () => {
    const october = forEmployee({
      periodStart: "2025-10-01",
      periodEnd: "2025-10-31",
      history: [APRIL_COVERED, nilMonth("2025-08-01", "2025-08-31")],
    });
    expect(october.coveredAtPeriodStart).toBe(false);
    // ⭐ Not "no evidence" — 1 October IS the window, so this month's own
    // wages decide it and there is nothing earlier to look for.
    expect(october.basis).toBe("window_opens_now");
    expect(october.windowStart).toBe("2025-10-01");
  });

  it("⭐ so the October payslip on the same wages deducts nothing", () => {
    const october = forEmployee({ periodStart: "2025-10-01", periodEnd: "2025-10-31" });
    expect(slip(40_000, october.coveredAtPeriodStart, "2025-10-31").employeeEsiMinor).toBe(0n);
  });

  it("⚠️ and January is in the period that started the PREVIOUS October", () => {
    const january = forEmployee({
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      history: [paid("2025-11-01", "2025-11-30", 135)],
    });
    expect(january.windowStart).toBe("2025-10-01");
    expect(january.coveredAtPeriodStart).toBe(true);
  });
});

/* ================================================================== */
/* ③ NO EVIDENCE IS NOT "NOT COVERED"                                  */
/* ================================================================== */

describe("🔴 missing evidence never silently produces a nil-ESI payslip", () => {
  it("defaults to COVERED, because the two errors are not the same size", () => {
    const august = forEmployee({ history: [] });
    expect(august.basis).toBe("evidence_missing");
    expect(august.coveredAtPeriodStart).toBe(true);
  });

  it("⚠️ a later nil month is not evidence of anything — that IS the bug's shape", () => {
    const august = forEmployee({ history: [nilMonth("2025-07-01", "2025-07-31")] });
    expect(august.basis).toBe("evidence_missing");
    expect(august.coveredAtPeriodStart).toBe(true);
  });

  it("🔴 and the run is BLOCKED so a human decides, rather than quietly over-paying", () => {
    const august = forEmployee({ history: [] });
    const told = withEsiCoverageStory(slip(40_000, august.coveredAtPeriodStart, "2025-08-31"), august, ESI);
    expect(told.problems.length).toBeGreaterThan(0);
    expect(told.problems.join(" ")).toMatch(/insured person/i);
    // ⭐ And it is not a nil payslip while nobody is looking.
    expect(told.employeeEsiMinor).toBeGreaterThan(0n);
  });

  it("⭐ but says nothing when the wages make the question irrelevant", () => {
    const august = forEmployee({ history: [] });
    // ₹18,000 is under the limit: covered either way, nothing to decide.
    const told = withEsiCoverageStory(slip(18_000, true, "2025-08-31"), august, ESI);
    expect(told.problems).toHaveLength(0);
    expect(told.employeeEsiMinor).toBeGreaterThan(0n);
  });
});

/* ================================================================== */
/* ④ A PROVEN NEGATIVE IS ALLOWED TO BE NEGATIVE                       */
/* ================================================================== */

describe("above the limit when the period began", () => {
  it("stays out for the whole period, and does not block the run", () => {
    const august = forEmployee({ history: [nilMonth("2025-04-01", "2025-04-30")] });
    expect(august.basis).toBe("evidence_not_covered");
    expect(august.coveredAtPeriodStart).toBe(false);
    const told = withEsiCoverageStory(slip(40_000, false, "2025-08-31"), august, ESI);
    expect(told.problems).toHaveLength(0);
  });

  it("⚠️ a mid-period joiner is measured from the day they joined, not from 1 April", () => {
    const august = forEmployee({ joinedOn: "2025-08-11", history: [] });
    expect(august.windowStart).toBe("2025-08-11");
    expect(august.basis).toBe("window_opens_now");
    expect(august.coveredAtPeriodStart).toBe(false);
  });

  it("and an exempt employee is never dragged in by history", () => {
    expect(forEmployee({ esiExempt: true }).coveredAtPeriodStart).toBe(false);
  });
});

/* ================================================================== */
/* ⑤ PAST RUNS ARE REPORTED, NOT REWRITTEN                             */
/* ================================================================== */

describe("🔴 already-approved runs that under-contributed", () => {
  const august = forEmployee({
    history: [APRIL_COVERED, nilMonth("2025-06-01", "2025-06-30"), nilMonth("2025-07-01", "2025-07-31")],
  });

  it("names every month that owed a contribution and paid none", () => {
    expect(august.underContributedPeriodEnds).toEqual(["2025-06-30", "2025-07-31"]);
  });

  it("⚠️ reports them on the payslip WITHOUT blocking this month's wages", () => {
    const told = withEsiCoverageStory(slip(40_000, true, "2025-08-31"), august, ESI);
    expect(told.notes.join(" ")).toContain("2025-07-31");
    expect(told.notes.join(" ")).toMatch(/85B/);
    // ⭐ A correction with its own trail. Not a reason to withhold pay
    // from everybody in the run this month.
    expect(told.problems).toHaveLength(0);
  });

  it("does not accuse months that came BEFORE coverage started", () => {
    const late = forEmployee({
      history: [nilMonth("2025-04-01", "2025-04-30"), paid("2025-06-01", "2025-06-30", 135)],
    });
    expect(late.underContributedPeriodEnds).toEqual([]);
    expect(late.coveredAtPeriodStart).toBe(true);
  });
});
