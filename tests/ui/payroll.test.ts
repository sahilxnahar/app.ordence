/**
 * Ordence — ⭐⭐⭐ PAYROLL
 * Version: v1.23.0-alpha · Batch 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY OTHER TOTAL IN THIS PRODUCT IS CHECKED BY A MACHINE OR NOT AT
 * ALL. A PAYSLIP IS CHECKED BY A PERSON WITH A CALCULATOR.
 * ══════════════════════════════════════════════════════════════════════
 * So the arithmetic below is asserted against worked examples with real
 * numbers rather than against itself. A test that says
 * `expect(pf).toBe(computePf(...))` proves nothing; a test that says
 * "₹20,000 of basic produces ₹1,800 of employee PF" is a claim somebody
 * can disagree with.
 *
 * ⚠️ AND THE REFUSALS MATTER AS MUCH AS THE SUMS. A payroll that
 * silently deducts nothing because a rate was never configured is worse
 * than one that stops, because it produces a plausible payslip and is
 * discovered by an inspector.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ceilToRupee,
  computeEsi,
  computePf,
  computeProfessionalTax,
  pickEffective,
  projectMonthlyTds,
  roundToRupee,
  type EsiRules,
  type PfRules,
  type PtSlab,
  type TaxRules,
  type TaxSlab,
} from "@/lib/payroll/statutory";
import {
  buildPayslip,
  paidDays,
  totalRun,
  type PayComponent,
} from "@/lib/payroll/payslip";
import {
  buildPayrollPosting,
  assertPayrollBalances,
  PAYROLL_ROLE_META,
  payrollRolesUsed,
} from "@/lib/accounting/sales-posting";
import { STARTER_COMPONENTS, STARTER_RATES } from "@/lib/payroll/starter";
import { daysInPeriod, daysOnRollsIn, monthsRemainingInFy } from "@/server/payroll/run";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** ₹ to paise, for readable expectations. */
const r = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

/* ================================================================== */
/* ① ROUNDING                                                          */
/* ================================================================== */

describe("statutory rounding", () => {
  it("rounds to the nearest rupee, half away from zero", () => {
    expect(roundToRupee(10049n)).toBe(10000n);
    expect(roundToRupee(10050n)).toBe(10100n);
    expect(roundToRupee(10099n)).toBe(10100n);
  });

  it("⚠️ rounds ESI UP, which is the one place the general rule is wrong", () => {
    expect(ceilToRupee(10001n)).toBe(10100n);
    expect(ceilToRupee(10000n)).toBe(10000n);
  });
});

/* ================================================================== */
/* ② EFFECTIVE DATING                                                  */
/* ================================================================== */

describe("picking the rules in force", () => {
  const rows = [
    { effectiveFrom: "2023-04-01", effectiveTo: "2024-03-31", tag: "old" },
    { effectiveFrom: "2024-04-01", effectiveTo: null, tag: "current" },
  ];

  it("uses the rules that applied on the day, not today's", () => {
    // 🔴 THE WHOLE REASON RATES ARE ROWS. A March payslip reissued in
    // September must reproduce March's number.
    expect(pickEffective(rows, "2023-09-15")?.tag).toBe("old");
    expect(pickEffective(rows, "2025-06-01")?.tag).toBe("current");
  });

  it("🔴 returns null rather than falling back to the newest", () => {
    // A fallback would produce a plausible payslip for a period with no
    // configured rates and be discovered at assessment.
    expect(pickEffective(rows, "2020-01-01")).toBeNull();
  });

  it("lets a later correction supersede an overlapping row", () => {
    const overlapping = [
      ...rows,
      { effectiveFrom: "2024-08-01", effectiveTo: null, tag: "corrected" },
    ];
    expect(pickEffective(overlapping, "2024-09-01")?.tag).toBe("corrected");
  });
});

/* ================================================================== */
/* ③ PROVIDENT FUND                                                    */
/* ================================================================== */

const PF: PfRules = {
  effectiveFrom: "2024-04-01",
  effectiveTo: null,
  employeeRateBp: 1200,
  employerRateBp: 1200,
  pensionRateBp: 833,
  edliRateBp: 50,
  adminRateBp: 50,
  wageCeilingMinor: "1500000",
  pensionCeilingMinor: "1500000",
};

describe("provident fund", () => {
  it("deducts 12% of ₹12,000 = ₹1,440", () => {
    const pf = computePf({
      pfEligibleWagesMinor: r(12_000),
      rules: PF,
      contributeAboveCeiling: false,
      isExempt: false,
    });
    expect(pf.employeeMinor).toBe(r(1_440));
  });

  it("⚠️ CAPS AT THE CEILING: ₹40,000 of basic still deducts ₹1,800", () => {
    const pf = computePf({
      pfEligibleWagesMinor: r(40_000),
      rules: PF,
      contributeAboveCeiling: false,
      isExempt: false,
    });
    expect(pf.pfWagesMinor).toBe(r(15_000));
    expect(pf.employeeMinor).toBe(r(1_800));
    expect(pf.note).toMatch(/exceed the statutory ceiling/i);
  });

  it("contributes on full wages when the employer has chosen to", () => {
    const pf = computePf({
      pfEligibleWagesMinor: r(40_000),
      rules: PF,
      contributeAboveCeiling: true,
      isExempt: false,
    });
    expect(pf.employeeMinor).toBe(r(4_800));
    // 🔴 AND PENSION IS STILL CAPPED. 8.33% of ₹15,000 = ₹1,249.50 → ₹1,250.
    expect(pf.employerPensionMinor).toBe(r(1_250));
  });

  it("🔴 splits the employer's 12% into pension and PF, with PF as the REMAINDER", () => {
    // Computing both from rates independently leaves a rupee belonging
    // to neither account, and the ECR then rejects the file.
    const pf = computePf({
      pfEligibleWagesMinor: r(15_000),
      rules: PF,
      contributeAboveCeiling: false,
      isExempt: false,
    });
    const employerTotal = r(1_800);
    expect(pf.employerPensionMinor + pf.employerPfMinor).toBe(employerTotal);
    expect(pf.employerPensionMinor).toBe(r(1_250));
    expect(pf.employerPfMinor).toBe(r(550));
  });

  it("deducts nothing from somebody exempt", () => {
    const pf = computePf({
      pfEligibleWagesMinor: r(50_000),
      rules: PF,
      contributeAboveCeiling: false,
      isExempt: true,
    });
    expect(pf.employeeMinor).toBe(0n);
    expect(pf.employerTotalMinor).toBe(0n);
  });
});

/* ================================================================== */
/* ④ ESI — THE CLIFF                                                   */
/* ================================================================== */

const ESI: EsiRules = {
  effectiveFrom: "2024-04-01",
  effectiveTo: null,
  employeeRateBp: 75,
  employerRateBp: 325,
  wageLimitMinor: "2100000",
};

describe("ESI", () => {
  it("deducts 0.75% under the limit, rounded up", () => {
    // ₹18,000 × 0.75% = ₹135 exactly.
    const esi = computeEsi({
      grossMinor: r(18_000),
      rules: ESI,
      coveredAtPeriodStart: false,
      isExempt: false,
    });
    expect(esi.covered).toBe(true);
    expect(esi.employeeMinor).toBe(r(135));
    expect(esi.employerMinor).toBe(r(585));
  });

  it("🔴🔴 STOPS ALTOGETHER above the limit — it is a cliff, not a ceiling", () => {
    // Treating ESI like PF would deduct 0.75% of ₹21,000 from somebody
    // earning ₹40,000 who is not covered at all.
    const esi = computeEsi({
      grossMinor: r(40_000),
      rules: ESI,
      coveredAtPeriodStart: false,
      isExempt: false,
    });
    expect(esi.covered).toBe(false);
    expect(esi.employeeMinor).toBe(0n);
    expect(esi.employerMinor).toBe(0n);
  });

  it("⭐ keeps somebody covered to the end of the contribution period after a rise", () => {
    // Dropping them the month they get a rise is wrong, and wrong in the
    // direction that loses them medical cover.
    const esi = computeEsi({
      grossMinor: r(24_000),
      rules: ESI,
      coveredAtPeriodStart: true,
      isExempt: false,
    });
    expect(esi.covered).toBe(true);
    // ⚠️ ON ACTUAL WAGES, not on the limit.
    expect(esi.esiWagesMinor).toBe(r(24_000));
    expect(esi.note).toMatch(/rest of this contribution period/i);
  });

  it("rounds both halves UP to the rupee", () => {
    // ₹18,001 × 0.75% = ₹135.0075 → ₹136.
    const esi = computeEsi({
      grossMinor: r(18_001),
      rules: ESI,
      coveredAtPeriodStart: false,
      isExempt: false,
    });
    expect(esi.employeeMinor).toBe(r(136));
  });
});

/* ================================================================== */
/* ⑤ PROFESSIONAL TAX                                                  */
/* ================================================================== */

const PT: PtSlab[] = [
  {
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    stateCode: "MH",
    fromMinor: "1000000",
    toMinor: null,
    amountMinor: "20000",
    februaryAmountMinor: "30000",
  },
  {
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    stateCode: "KA",
    fromMinor: "2500000",
    toMinor: null,
    amountMinor: "20000",
    februaryAmountMinor: null,
  },
];

describe("professional tax", () => {
  it("charges the State's slab", () => {
    const pt = computeProfessionalTax({
      grossMinor: r(30_000),
      stateCode: "KA",
      month: 6,
      slabs: PT,
      onDate: "2025-06-30",
    });
    expect(pt.amountMinor).toBe(r(200));
  });

  it("⭐ charges Maharashtra's different February amount", () => {
    // The reason the payslip engine knows what month it is at all.
    const february = computeProfessionalTax({
      grossMinor: r(30_000),
      stateCode: "MH",
      month: 2,
      slabs: PT,
      onDate: "2026-02-28",
    });
    expect(february.amountMinor).toBe(r(300));

    const june = computeProfessionalTax({
      grossMinor: r(30_000),
      stateCode: "MH",
      month: 6,
      slabs: PT,
      onDate: "2025-06-30",
    });
    expect(june.amountMinor).toBe(r(200));
  });

  it("⚠️ a State with no slabs is a NIL deduction with a stated reason", () => {
    // Several States genuinely do not levy it, so treating the absence
    // as a misconfiguration would block payroll in half the country.
    const pt = computeProfessionalTax({
      grossMinor: r(80_000),
      stateCode: "DL",
      month: 6,
      slabs: PT,
      onDate: "2025-06-30",
    });
    expect(pt.amountMinor).toBe(0n);
    expect(pt.note).toMatch(/no professional tax slabs configured/i);
  });

  it("says so when a salary falls through every slab of a State that has them", () => {
    const pt = computeProfessionalTax({
      grossMinor: r(5_000),
      stateCode: "KA",
      month: 6,
      slabs: PT,
      onDate: "2025-06-30",
    });
    expect(pt.amountMinor).toBe(0n);
    expect(pt.note).toMatch(/gap in the slab table/i);
  });
});

/* ================================================================== */
/* ⑥ INCOME TAX — A PROJECTION, AND IT SAYS SO                         */
/* ================================================================== */

const NEW_RULES: TaxRules = {
  effectiveFrom: "2024-04-01",
  effectiveTo: null,
  regime: "new",
  standardDeductionMinor: "7500000",
  rebateLimitMinor: "70000000",
  rebateMaxMinor: "2500000",
  cessRateBp: 400,
  surchargeThresholdMinor: "5000000000",
};

const NEW_SLABS: TaxSlab[] = [
  { effectiveFrom: "2024-04-01", effectiveTo: null, regime: "new", fromMinor: "0", toMinor: "30000000", rateBp: 0 },
  { effectiveFrom: "2024-04-01", effectiveTo: null, regime: "new", fromMinor: "30000000", toMinor: "70000000", rateBp: 500 },
  { effectiveFrom: "2024-04-01", effectiveTo: null, regime: "new", fromMinor: "70000000", toMinor: "100000000", rateBp: 1000 },
  { effectiveFrom: "2024-04-01", effectiveTo: null, regime: "new", fromMinor: "100000000", toMinor: null, rateBp: 3000 },
];

describe("income tax on salary", () => {
  it("⭐ the rebate wipes out a small liability entirely", () => {
    // ₹7,50,000 gross − ₹75,000 standard = ₹6,75,000 taxable, which is
    // under the rebate limit, so nothing is due.
    const tax = projectMonthlyTds({
      projectedAnnualGrossMinor: r(750_000),
      declaredDeductionsMinor: 0n,
      annualProfessionalTaxMinor: 0n,
      rules: NEW_RULES,
      slabs: NEW_SLABS,
      monthsRemaining: 12,
      alreadyDeductedMinor: 0n,
    });
    expect(tax.annualLiabilityMinor).toBe(0n);
    expect(tax.monthlyMinor).toBe(0n);
  });

  it("🔴 the rebate is a CLIFF, not a taper", () => {
    // One rupee over and the whole rebate disappears, which is why an
    // employee just above the limit can take home less than one below.
    const under = projectMonthlyTds({
      projectedAnnualGrossMinor: r(775_000),
      declaredDeductionsMinor: 0n,
      annualProfessionalTaxMinor: 0n,
      rules: NEW_RULES,
      slabs: NEW_SLABS,
      monthsRemaining: 12,
      alreadyDeductedMinor: 0n,
    });
    const over = projectMonthlyTds({
      projectedAnnualGrossMinor: r(776_000),
      declaredDeductionsMinor: 0n,
      annualProfessionalTaxMinor: 0n,
      rules: NEW_RULES,
      slabs: NEW_SLABS,
      monthsRemaining: 12,
      alreadyDeductedMinor: 0n,
    });
    expect(under.annualLiabilityMinor).toBe(0n);
    expect(over.annualLiabilityMinor).toBeGreaterThan(r(20_000));
  });

  it("⚠️ IGNORES declared investments under the new regime, and SAYS SO", () => {
    // Applying old-regime deductions to the new regime is the single
    // most common payroll bug in the country, and it under-withholds.
    const tax = projectMonthlyTds({
      projectedAnnualGrossMinor: r(1_200_000),
      declaredDeductionsMinor: r(150_000),
      annualProfessionalTaxMinor: r(2_400),
      rules: NEW_RULES,
      slabs: NEW_SLABS,
      monthsRemaining: 12,
      alreadyDeductedMinor: 0n,
    });
    expect(tax.annualTaxableMinor).toBe(r(1_125_000));
    expect(tax.caveats.join(" ")).toMatch(/new regime, which does not allow them/i);
  });

  it("allows them under the old regime, professional tax included", () => {
    const oldRules: TaxRules = { ...NEW_RULES, regime: "old", standardDeductionMinor: "5000000" };
    const oldSlabs: TaxSlab[] = NEW_SLABS.map((s) => ({ ...s, regime: "old" as const }));
    const tax = projectMonthlyTds({
      projectedAnnualGrossMinor: r(1_200_000),
      declaredDeductionsMinor: r(150_000),
      annualProfessionalTaxMinor: r(2_400),
      rules: oldRules,
      slabs: oldSlabs,
      monthsRemaining: 12,
      alreadyDeductedMinor: 0n,
    });
    expect(tax.annualTaxableMinor).toBe(r(997_600));
  });

  it("always declares itself a projection", () => {
    const tax = projectMonthlyTds({
      projectedAnnualGrossMinor: r(2_000_000),
      declaredDeductionsMinor: 0n,
      annualProfessionalTaxMinor: 0n,
      rules: NEW_RULES,
      slabs: NEW_SLABS,
      monthsRemaining: 9,
      alreadyDeductedMinor: 0n,
    });
    expect(tax.isProjection).toBe(true);
    expect(tax.caveats[0]).toMatch(/estimate/i);
    expect(tax.note).toMatch(/9 months/);
  });

  it("🔴 refuses to guess at surcharge and says the figure is understated", () => {
    const tax = projectMonthlyTds({
      projectedAnnualGrossMinor: r(60_000_000),
      declaredDeductionsMinor: 0n,
      annualProfessionalTaxMinor: 0n,
      rules: NEW_RULES,
      slabs: NEW_SLABS,
      monthsRemaining: 12,
      alreadyDeductedMinor: 0n,
    });
    expect(tax.caveats.join(" ")).toMatch(/does not compute surcharge/i);
  });

  it("spreads only what is still outstanding across the months left", () => {
    const tax = projectMonthlyTds({
      projectedAnnualGrossMinor: r(2_000_000),
      declaredDeductionsMinor: 0n,
      annualProfessionalTaxMinor: 0n,
      rules: NEW_RULES,
      slabs: NEW_SLABS,
      monthsRemaining: 3,
      alreadyDeductedMinor: r(100_000),
    });
    const outstanding = tax.annualLiabilityMinor - r(100_000);
    expect(tax.monthlyMinor).toBe(roundToRupee(outstanding / 3n));
  });
});

/* ================================================================== */
/* ⑦ THE PAYSLIP                                                       */
/* ================================================================== */

const COMPONENTS: PayComponent[] = [
  { code: "BASIC", label: "Basic", kind: "earning", pfApplicable: true, esiApplicable: true, taxable: true, proRates: true, displayOrder: 10 },
  { code: "HRA", label: "HRA", kind: "earning", pfApplicable: false, esiApplicable: true, taxable: true, proRates: true, displayOrder: 20 },
  { code: "REIMB", label: "Reimbursement", kind: "earning", pfApplicable: false, esiApplicable: false, taxable: false, proRates: false, displayOrder: 30 },
  { code: "ADVANCE", label: "Advance", kind: "deduction", pfApplicable: false, esiApplicable: false, taxable: false, proRates: false, displayOrder: 200 },
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

function slipFor(over: Partial<Parameters<typeof buildPayslip>[0]> = {}) {
  return buildPayslip({
    employee: EMPLOYEE,
    components: COMPONENTS,
    structure: [
      { componentCode: "BASIC", monthlyAmountMinor: r(20_000).toString() },
      { componentCode: "HRA", monthlyAmountMinor: r(10_000).toString() },
      { componentCode: "REIMB", monthlyAmountMinor: r(2_000).toString() },
    ],
    attendance: { daysInMonth: 30, payableDays: 30, lopDays: 0 },
    month: 6,
    periodEnd: "2025-06-30",
    pfRules: PF,
    esiRules: ESI,
    ptSlabs: PT,
    taxRules: NEW_RULES,
    taxSlabs: NEW_SLABS,
    monthsRemaining: 12,
    tdsAlreadyDeductedMinor: "0",
    ...over,
  });
}

describe("building a payslip", () => {
  it("adds up to itself", () => {
    const slip = slipFor();
    expect(slip.netPayMinor).toBe(slip.grossEarningsMinor - slip.totalDeductionsMinor);
    expect(slip.grossEarningsMinor).toBe(r(32_000));
  });

  it("takes PF from the PF-applicable components only", () => {
    const slip = slipFor();
    // ₹20,000 basic only, not the HRA. 12% = ₹2,400.
    expect(slip.pfWagesMinor).toBe(r(20_000));
    expect(slip.employeePfMinor).toBe(r(1_800)); // capped at the ₹15,000 ceiling
  });

  it("⚠️ excludes non-ESI components from the ESI gross", () => {
    const slip = slipFor();
    expect(slip.esiGrossMinor).toBe(r(30_000));
  });

  it("🔴 PRO-RATES what should and does NOT pro-rate what should not", () => {
    // The single most argued-about flag in Indian payroll. Backwards on
    // one component produces a payslip wrong by a plausible amount for
    // everybody who took a day off.
    const slip = slipFor({
      attendance: { daysInMonth: 30, payableDays: 30, lopDays: 3 },
    });
    const basic = slip.lines.find((l) => l.componentCode === "BASIC")!;
    const reimb = slip.lines.find((l) => l.componentCode === "REIMB")!;
    expect(basic.amountMinor).toBe(r(18_000)); // 27/30 of ₹20,000
    expect(reimb.amountMinor).toBe(r(2_000)); // unchanged
    expect(basic.workingNote).toMatch(/27 of 30 days/);
    expect(basic.workingNote).toMatch(/3 days loss of pay/);
  });

  it("⭐ prints the working on every line", () => {
    for (const line of slipFor().lines) {
      expect(line.workingNote.length).toBeGreaterThan(10);
    }
  });

  it("🔴 REFUSES rather than deducting nothing when PF rates are missing", () => {
    // A silent zero looks like a correctly calculated exemption and is
    // discovered by an inspector.
    const slip = slipFor({ pfRules: null });
    expect(slip.employeePfMinor).toBe(0n);
    expect(slip.problems.join(" ")).toMatch(/No provident fund rates are configured/i);
  });

  it("does NOT complain about missing rates for somebody exempt", () => {
    const slip = slipFor({
      pfRules: null,
      esiRules: null,
      employee: { ...EMPLOYEE, pfExempt: true, esiExempt: true },
    });
    expect(slip.problems).toHaveLength(0);
  });

  it("🔴 refuses to withhold tax from somebody with no PAN", () => {
    // Applying 20% under 206AA to somebody who has not typed their PAN
    // in yet is a very expensive way to chase a data-entry gap.
    const slip = slipFor({
      employee: { ...EMPLOYEE, hasPan: false },
      structure: [{ componentCode: "BASIC", monthlyAmountMinor: r(200_000).toString() }],
    });
    expect(slip.problems.join(" ")).toMatch(/no PAN recorded/i);
  });

  it("⭐ takes the accountant's override and says it did", () => {
    const slip = slipFor({
      employee: { ...EMPLOYEE, tdsOverrideMinor: r(4_500).toString() },
    });
    expect(slip.tdsMinor).toBe(r(4_500));
    expect(slip.tdsOverridden).toBe(true);
    expect(slip.tdsIsProjection).toBe(false);
    expect(slip.notes.join(" ")).toMatch(/entered by your accountant/i);
  });

  it("🔴 refuses a negative net rather than issuing one", () => {
    const slip = slipFor({
      structure: [
        { componentCode: "BASIC", monthlyAmountMinor: r(10_000).toString() },
        { componentCode: "ADVANCE", monthlyAmountMinor: r(50_000).toString() },
      ],
    });
    expect(slip.problems.join(" ")).toMatch(/more than this month's earnings/i);
  });

  it("⚠️ a structure line whose component vanished is a PROBLEM, not a zero", () => {
    // Silently dropping it underpays by exactly that line and nothing
    // anywhere reports it.
    const slip = slipFor({
      structure: [
        { componentCode: "BASIC", monthlyAmountMinor: r(20_000).toString() },
        { componentCode: "GHOST", monthlyAmountMinor: r(5_000).toString() },
      ],
    });
    expect(slip.problems.join(" ")).toMatch(/no longer exists in the component list/i);
  });

  it("counts paid days as payable minus loss of pay, never below zero", () => {
    expect(paidDays({ daysInMonth: 30, payableDays: 30, lopDays: 3 })).toBe(27);
    expect(paidDays({ daysInMonth: 30, payableDays: 2, lopDays: 5 })).toBe(0);
  });
});

/* ================================================================== */
/* ⑧ THE RUN TOTAL                                                     */
/* ================================================================== */

describe("the run total", () => {
  it("⭐ cost to company is gross PLUS the employer's own contributions", () => {
    const slips = [slipFor(), slipFor()];
    const totals = totalRun(slips);
    expect(totals.employeeCount).toBe(2);
    expect(totals.grossMinor).toBe(r(64_000));
    expect(totals.employerCostMinor).toBeGreaterThan(totals.grossMinor);
    expect(totals.employerCostMinor).toBe(
      totals.grossMinor + slips.reduce((s, x) => s + x.employerTotalMinor, 0n),
    );
  });

  it("counts payslips carrying a problem", () => {
    const totals = totalRun([slipFor(), slipFor({ pfRules: null })]);
    expect(totals.withProblems).toBe(1);
  });
});

/* ================================================================== */
/* ⑨ THE LEDGER                                                        */
/* ================================================================== */

const FACTS = {
  grossMinor: r(100_000),
  employeePfMinor: r(1_800),
  employerPfMinor: r(550),
  employerPensionMinor: r(1_250),
  edliMinor: r(75),
  pfAdminMinor: r(75),
  employeeEsiMinor: r(135),
  employerEsiMinor: r(585),
  professionalTaxMinor: r(200),
  tdsMinor: r(5_000),
  otherDeductionsMinor: r(1_000),
  netPayMinor: r(91_865),
};

describe("the payroll journal", () => {
  const legs = buildPayrollPosting({ facts: FACTS, periodLabel: "June 2025" });

  it("balances", () => {
    expect(() => assertPayrollBalances(legs)).not.toThrow();
  });

  it("🔴🔴 DEBITS THE GROSS, never the net", () => {
    // The wrong journal debits Salaries with what was paid out. It
    // balances, and it is understated by every rupee withheld — money
    // the business spent and owes to somebody else.
    const salary = legs.find((l) => l.role === "salary_expense")!;
    expect(salary.entryType).toBe("debit");
    expect(salary.amountMinor).toBe(r(100_000));
  });

  it("⚠️ does NOT touch the bank — payroll accrues", () => {
    // What leaves the bank is a later event against Salaries Payable, on
    // the day the transfer clears.
    expect(legs.map((l) => String(l.role))).not.toContain("bank");
    const payable = legs.find((l) => l.role === "salaries_payable")!;
    expect(payable.entryType).toBe("credit");
    // ⭐ Net plus the non-statutory recoveries, which have no loan
    // account to go to yet. Stated as a limitation in the builder.
    expect(payable.amountMinor).toBe(r(92_865));
  });

  it("🔴 keeps PENSION separate from PF payable", () => {
    // Same challan, different account head. A single netted balance
    // cannot be reconciled against an ECR.
    const pf = legs.find((l) => l.role === "pf_payable")!;
    const pension = legs.find((l) => l.role === "pension_payable")!;
    expect(pension.amountMinor).toBe(r(1_250));
    // Employee 1,800 + employer 550 + EDLI 75 + admin 75 = 2,500.
    expect(pf.amountMinor).toBe(r(2_500));
  });

  it("puts the employer's own contributions on the DEBIT side as a cost", () => {
    const pfExpense = legs.find((l) => l.role === "employer_pf_expense")!;
    expect(pfExpense.entryType).toBe("debit");
    // 550 + 1,250 + 75 + 75 = 1,950.
    expect(pfExpense.amountMinor).toBe(r(1_950));
  });

  it("keeps salary TDS separate from vendor TDS", () => {
    expect(payrollRolesUsed(legs)).toContain("tds_payable_salary");
    expect(payrollRolesUsed(legs)).not.toContain("tds_payable");
  });

  it("⚠️ drops zero legs, so a business with no ESI need not map an ESI ledger", () => {
    const noEsi = buildPayrollPosting({
      facts: { ...FACTS, employeeEsiMinor: 0n, employerEsiMinor: 0n, netPayMinor: r(92_000) },
      periodLabel: "June 2025",
    });
    expect(payrollRolesUsed(noEsi)).not.toContain("esi_payable");
    expect(payrollRolesUsed(noEsi)).not.toContain("employer_esi_expense");
  });

  it("gives every role a label and an explanation for the mapping screen", () => {
    for (const role of payrollRolesUsed(legs)) {
      const meta = PAYROLL_ROLE_META[role];
      expect(meta.label.length).toBeGreaterThan(3);
      expect(meta.help.length).toBeGreaterThan(30);
      expect(["asset", "liability", "expense", "revenue"]).toContain(meta.accountType);
    }
  });
});

/* ================================================================== */
/* ⑩ PERIODS AND DATES                                                 */
/* ================================================================== */

describe("periods", () => {
  it("counts calendar days, never a fixed thirty", () => {
    expect(daysInPeriod("2025-02-01", "2025-02-28")).toBe(28);
    expect(daysInPeriod("2025-01-01", "2025-01-31")).toBe(31);
    expect(daysInPeriod("2024-02-01", "2024-02-29")).toBe(29);
  });

  it("⚠️ counts months left in the FINANCIAL year, which starts in April", () => {
    // A calendar year spreads the liability over the wrong twelve months
    // and under-withholds every January to March.
    expect(monthsRemainingInFy("2025-04-30")).toBe(12);
    expect(monthsRemainingInFy("2025-06-30")).toBe(10);
    expect(monthsRemainingInFy("2026-01-31")).toBe(3);
    expect(monthsRemainingInFy("2026-03-31")).toBe(1);
  });

  it("⭐ pays a joiner and a leaver for the days they were on the rolls", () => {
    // Excluding somebody because they are inactive now is how a final
    // month goes unpaid.
    expect(daysOnRollsIn("2025-06-16", null, "2025-06-01", "2025-06-30", 30)).toBe(15);
    expect(daysOnRollsIn("2020-01-01", "2025-06-20", "2025-06-01", "2025-06-30", 30)).toBe(20);
    expect(daysOnRollsIn("2020-01-01", null, "2025-06-01", "2025-06-30", 30)).toBe(30);
    expect(daysOnRollsIn("2025-07-01", null, "2025-06-01", "2025-06-30", 30)).toBe(0);
  });
});

/* ================================================================== */
/* ⑪ THE STARTER SET                                                   */
/* ================================================================== */

describe("the starter setup", () => {
  it("marks basic and DA as carrying PF, and nothing else", () => {
    const pfCarrying = STARTER_COMPONENTS.filter((c) => c.pfApplicable).map((c) => c.code);
    expect(pfCarrying.sort()).toEqual(["BASIC", "DA"]);
  });

  it("⭐ includes one component that does NOT pro-rate, as the example", () => {
    const fixed = STARTER_COMPONENTS.filter((c) => !c.proRates && c.kind === "earning");
    expect(fixed.length).toBeGreaterThan(0);
    expect(fixed[0]!.code).toBe("REIMB");
  });

  it("gives every rate a note explaining what it is", () => {
    for (const rate of STARTER_RATES) {
      expect(rate.note.length).toBeGreaterThan(40);
      expect(rate.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("⚠️ seeds only three States' professional tax, deliberately", () => {
    const states = STARTER_RATES.filter((r) => r.kind === "professional_tax").map((r) => r.scope);
    expect(states.sort()).toEqual(["KA", "MH", "WB"]);
  });

  it("carries Maharashtra's February amount, which is why that field exists", () => {
    const mh = STARTER_RATES.find((r) => r.kind === "professional_tax" && r.scope === "MH")!;
    const slabs = mh.payload.slabs as Array<Record<string, unknown>>;
    expect(slabs.some((s) => s.februaryAmountMinor !== null)).toBe(true);
  });

  it("seeds both tax regimes with their own slabs", () => {
    const regimes = STARTER_RATES.filter((r) => r.kind === "income_tax_slab").map((r) => r.scope);
    expect(regimes.sort()).toEqual(["new", "old"]);
  });
});

/* ================================================================== */
/* ⑫ REACHABILITY — THE TESTS THAT MATTER MOST                         */
/* ================================================================== */

describe("🔴 payroll is actually reachable", () => {
  const actions = read("server/actions/payroll.ts");

  it("the run screen calls the run actions", () => {
    const page = read("app/(crm)/payroll/[id]/page.tsx");
    expect(page).toContain("computePayrollRun");
    expect(page).toContain("approvePayrollRun");
    expect(page).toContain("postPayroll");
    expect(page).toContain("cancelPayrollRun");
  });

  it("the list screen opens runs and warns about unmapped accounts", () => {
    const page = read("app/(crm)/payroll/page.tsx");
    expect(page).toContain("openPayrollRun");
    expect(page).toContain("payrollAccountsNeeded");
  });

  it("the employees screen reaches the employee and structure actions", () => {
    const page = read("app/(crm)/payroll/employees/page.tsx");
    expect(page).toContain("saveEmployee");
    expect(page).toContain("setPayStructure");
  });

  it("the setup screen reaches the seed", () => {
    expect(read("app/(crm)/payroll/setup/page.tsx")).toContain("seedPayrollSetup");
  });

  it("⭐⭐ the action module CALLS the posting helper, not merely imports it", () => {
    // ⚠️ MEASURED AS A CALL. Twice this codebase has shipped a test
    // asserting a symbol was imported while nothing invoked it.
    expect(actions).toContain("postPayrollRun(tx, {");
  });

  it("the module is in the registry and the sidebar can reach it", () => {
    const registry = read("lib/modules/registry.ts");
    expect(registry).toContain('navId: "payroll"');
    expect(registry).toContain('href: "/payroll"');
    expect(registry).toContain('feature: "hr.payroll"');
  });

  it("🔴 the four permission keys exist, or every screen denies silently", () => {
    // A permission system that fails closed on unknown keys needs the
    // catalogue to be the single place keys are minted — this exact gap
    // denied /land, /inventory and /orders to every user for months.
    const auth = read("db/schema/auth.ts");
    for (const key of ["payroll.read", "payroll.manage", "payroll.approve", "payroll.post"]) {
      expect(auth).toContain(`"${key}"`);
    }
  });

  it("⚠️ manage and approve are NOT the same key at any call site", () => {
    expect(actions).toContain('const MANAGE = "payroll.manage"');
    expect(actions).toContain('const APPROVE = "payroll.approve"');
    expect(actions).toContain("requirePermission(APPROVE)");
    expect(actions).toContain("requirePermission(POST)");
  });
});

describe("🔴 the SQL says what the code assumes", () => {
  const sqlFile = read("SQL-FILES/0075_payroll.sql");

  it("refuses two live runs for one period", () => {
    // Two payrolls for the same March both post and the wage bill
    // doubles in the ledger with nothing reporting a problem.
    expect(sqlFile).toContain("payroll_runs_one_live_per_period");
    expect(sqlFile).toMatch(/WHERE status <> 'cancelled'/);
  });

  it("freezes payslips once a run is approved", () => {
    expect(sqlFile).toContain("ordence_guard_payroll_frozen");
    expect(sqlFile).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON payslips/);
  });

  it("refuses a run status that walks backwards", () => {
    expect(sqlFile).toContain("ordence_guard_payroll_status");
  });

  it("⭐ makes the payslip add up to itself in the DATABASE", () => {
    expect(sqlFile).toContain("payslips_adds_up");
  });

  it("refuses a posted run with no journal", () => {
    expect(sqlFile).toContain("payroll_runs_posted_has_journal");
  });

  it("🔴 stores no Aadhaar and no bank account number", () => {
    // Payroll accrues; it does not disburse. A bank account number here
    // would be a credential in a row every support session can read.
    //
    // ⚠️ THE ASSERTION IS ON COLUMN DEFINITIONS, NOT ON THE WORD. The
    // file's own header explains at length why Aadhaar is absent, and a
    // grep for the word fails on the explanation — which would make the
    // test demand that the reasoning be deleted to stay green.
    const columns = sqlFile
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .toLowerCase();
    expect(columns).not.toMatch(/aadhaar|aadhar/);
    expect(columns).not.toMatch(/account_number|bank_account/);
  });

  it("puts RLS on every payroll table", () => {
    expect(sqlFile).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sqlFile).toContain("app_platform_scope()");
  });

  it("⚠️ keeps app_platform_scope() out of WITH CHECK", () => {
    const withChecks = sqlFile.match(/WITH CHECK \([^)]*\)/g) ?? [];
    for (const clause of withChecks) expect(clause).not.toContain("app_platform_scope");
  });
});

describe("🔴 a gap found in existing code while building this", () => {
  it("the property posting path now checks the period lock too", () => {
    // ⚠️ v1.21.0 added the lock to `writePosting` and not to
    // `writePropertyPosting`. The DATA was never at risk — 0073's
    // trigger sits on `transactions` — but a correct refusal delivered
    // as an unhandled database error is read as a bug, and the response
    // to a bug is to look for a way around it.
    const posting = read("server/accounting/post-sales.ts");
    const propertyWriter = posting.slice(posting.indexOf("async function writePropertyPosting"));
    const body = propertyWriter.slice(0, propertyWriter.indexOf("\n}\n"));
    expect(body).toContain("closedPeriodFor(");
    expect(body).toContain("period_closed");
  });
});
