/**
 * Ordence — ⭐⭐ THE STARTER PAYROLL SETUP
 * Version: v1.23.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THESE ARE OPENING NUMBERS, NOT LAW, AND NOT ADVICE
 * ══════════════════════════════════════════════════════════════════════
 * Every figure below is what the rules said when this file was written.
 * They are seeded ONCE into a tenant's own `statutory_rates` table and
 * are then that tenant's to correct, supersede and date.
 *
 * ⚠️ NOTHING IN THE CALCULATION READS THIS FILE. The engine reads rows.
 * If it read constants, a rate change would be a deploy and March would
 * be recalculated with April's numbers the next time anybody reissued a
 * payslip.
 *
 * 🔴 AND THE SEED IS NOT RE-APPLIED. A tenant who corrects a rate must
 * not have their correction overwritten by the number they corrected
 * away from. `seedPayrollSetup` skips any kind that already exists.
 *
 * ⭐ THE PROFESSIONAL TAX SLABS ARE THE THINNEST PART, DELIBERATELY.
 * Three States are seeded and the rest are left empty, because a wrong
 * slab is worse than an absent one: an absent one produces a stated
 * "no slabs configured" note, and a wrong one produces a confident
 * deduction of the wrong amount.
 */

export interface StarterComponent {
  code: string;
  label: string;
  kind: "earning" | "deduction";
  pfApplicable: boolean;
  esiApplicable: boolean;
  taxable: boolean;
  proRates: boolean;
  displayOrder: number;
}

/**
 * ⚠️ THE `pfApplicable` AND `proRates` FLAGS ARE THE TWO THAT MATTER,
 * and both are set the way most Indian employers actually run.
 *
 * 🔴 BASIC AND DEARNESS ALLOWANCE CARRY PF. Special allowance
 * deliberately does NOT here, which is the common practice and is also
 * the exact point the Supreme Court's 2019 decision made contentious.
 * A tenant whose auditor disagrees changes one flag; a tenant who never
 * looks at it inherits the common reading. Both outcomes are visible on
 * the setup screen rather than buried in a calculation.
 */
export const STARTER_COMPONENTS: readonly StarterComponent[] = Object.freeze([
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
  {
    code: "DA",
    label: "Dearness Allowance",
    kind: "earning",
    pfApplicable: true,
    esiApplicable: true,
    taxable: true,
    proRates: true,
    displayOrder: 20,
  },
  {
    code: "HRA",
    label: "House Rent Allowance",
    kind: "earning",
    pfApplicable: false,
    esiApplicable: true,
    taxable: true,
    proRates: true,
    displayOrder: 30,
  },
  {
    code: "CONVEYANCE",
    label: "Conveyance Allowance",
    kind: "earning",
    pfApplicable: false,
    esiApplicable: true,
    taxable: true,
    proRates: true,
    displayOrder: 40,
  },
  {
    code: "SPECIAL",
    label: "Special Allowance",
    kind: "earning",
    pfApplicable: false,
    esiApplicable: true,
    taxable: true,
    proRates: true,
    displayOrder: 50,
  },
  {
    /**
     * ⭐ THE ONE THAT DOES NOT PRO-RATE, AS AN EXAMPLE OF THE FLAG.
     *
     * ⚠️ A fixed reimbursement is paid in full or not at all — three
     * days of leave does not reduce a telephone bill. Getting this
     * backwards is the single most common payslip complaint.
     */
    code: "REIMB",
    label: "Fixed Reimbursement",
    kind: "earning",
    pfApplicable: false,
    esiApplicable: false,
    taxable: false,
    proRates: false,
    displayOrder: 60,
  },
  {
    code: "ADVANCE",
    label: "Advance Recovery",
    kind: "deduction",
    pfApplicable: false,
    esiApplicable: false,
    taxable: false,
    proRates: false,
    displayOrder: 200,
  },
]);

export interface StarterRate {
  kind: "pf" | "esi" | "professional_tax" | "income_tax" | "income_tax_slab";
  scope: string | null;
  effectiveFrom: string;
  payload: Record<string, unknown>;
  note: string;
}

/** ⚠️ Basis points. 1200 = 12.00%. Integer arithmetic all the way down. */
export const STARTER_RATES: readonly StarterRate[] = Object.freeze([
  {
    kind: "pf",
    scope: null,
    effectiveFrom: "2024-04-01",
    payload: {
      employeeRateBp: 1200,
      employerRateBp: 1200,
      pensionRateBp: 833,
      edliRateBp: 50,
      adminRateBp: 50,
      wageCeilingMinor: "1500000",
      pensionCeilingMinor: "1500000",
    },
    note: "Employee 12%, employer 12% of which 8.33% is pension. EDLI and administration 0.5% each. Ceiling ₹15,000. Check against your establishment's own PF registration before the first run.",
  },
  {
    kind: "esi",
    scope: null,
    effectiveFrom: "2024-04-01",
    payload: {
      employeeRateBp: 75,
      employerRateBp: 325,
      wageLimitMinor: "2100000",
    },
    note: "Employee 0.75%, employer 3.25%, gross wage limit ₹21,000. ⚠️ ESI has a cliff rather than a ceiling: above the limit there is no contribution at all.",
  },
  {
    kind: "income_tax",
    scope: "new",
    effectiveFrom: "2024-04-01",
    payload: {
      standardDeductionMinor: "7500000",
      rebateLimitMinor: "70000000",
      rebateMaxMinor: "2500000",
      cessRateBp: 400,
      surchargeThresholdMinor: "5000000000",
    },
    note: "New regime. Standard deduction ₹75,000, rebate up to ₹25,000 for total income at or below ₹7,00,000, cess 4%. ⚠️ Ordence does not compute surcharge or marginal relief — above ₹50 lakh use an override.",
  },
  {
    kind: "income_tax_slab",
    scope: "new",
    effectiveFrom: "2024-04-01",
    payload: {
      slabs: [
        { fromMinor: "0", toMinor: "30000000", rateBp: 0 },
        { fromMinor: "30000000", toMinor: "70000000", rateBp: 500 },
        { fromMinor: "70000000", toMinor: "100000000", rateBp: 1000 },
        { fromMinor: "100000000", toMinor: "120000000", rateBp: 1500 },
        { fromMinor: "120000000", toMinor: "150000000", rateBp: 2000 },
        { fromMinor: "150000000", toMinor: null, rateBp: 3000 },
      ],
    },
    note: "New regime slabs. Nil to ₹3 lakh, then 5, 10, 15, 20 and 30 per cent.",
  },
  {
    kind: "income_tax",
    scope: "old",
    effectiveFrom: "2024-04-01",
    payload: {
      standardDeductionMinor: "5000000",
      rebateLimitMinor: "50000000",
      rebateMaxMinor: "1250000",
      cessRateBp: 400,
      surchargeThresholdMinor: "5000000000",
    },
    note: "Old regime. Standard deduction ₹50,000, rebate up to ₹12,500 at or below ₹5,00,000, cess 4%. Chapter VI-A declarations apply here and are ignored under the new regime.",
  },
  {
    kind: "income_tax_slab",
    scope: "old",
    effectiveFrom: "2024-04-01",
    payload: {
      slabs: [
        { fromMinor: "0", toMinor: "25000000", rateBp: 0 },
        { fromMinor: "25000000", toMinor: "50000000", rateBp: 500 },
        { fromMinor: "50000000", toMinor: "100000000", rateBp: 2000 },
        { fromMinor: "100000000", toMinor: null, rateBp: 3000 },
      ],
    },
    note: "Old regime slabs. Nil to ₹2.5 lakh, then 5, 20 and 30 per cent.",
  },
  /* ---- Professional tax: three States, deliberately -------------- */
  {
    kind: "professional_tax",
    scope: "KA",
    effectiveFrom: "2024-04-01",
    payload: {
      slabs: [
        { fromMinor: "0", toMinor: "2499999", amountMinor: "0", februaryAmountMinor: null },
        { fromMinor: "2500000", toMinor: null, amountMinor: "20000", februaryAmountMinor: null },
      ],
    },
    note: "Karnataka: ₹200 a month above ₹25,000. Verify against the current notification.",
  },
  {
    kind: "professional_tax",
    scope: "MH",
    effectiveFrom: "2024-04-01",
    payload: {
      slabs: [
        { fromMinor: "0", toMinor: "2499999", amountMinor: "0", februaryAmountMinor: null },
        { fromMinor: "2500000", toMinor: "9999999", amountMinor: "17500", februaryAmountMinor: "17500" },
        // ⭐ THE FEBRUARY TOP-UP, WHICH IS WHY THAT COLUMN EXISTS AT ALL.
        { fromMinor: "10000000", toMinor: null, amountMinor: "20000", februaryAmountMinor: "30000" },
      ],
    },
    note: "Maharashtra: ₹200 a month above ₹10,000, and ₹300 in February. The February difference is a real rule and the reason the payslip engine knows what month it is.",
  },
  {
    kind: "professional_tax",
    scope: "WB",
    effectiveFrom: "2024-04-01",
    payload: {
      slabs: [
        { fromMinor: "0", toMinor: "1000000", amountMinor: "0", februaryAmountMinor: null },
        { fromMinor: "1000001", toMinor: "1500000", amountMinor: "11000", februaryAmountMinor: null },
        { fromMinor: "1500001", toMinor: "2500000", amountMinor: "13000", februaryAmountMinor: null },
        { fromMinor: "2500001", toMinor: "4000000", amountMinor: "15000", februaryAmountMinor: null },
        { fromMinor: "4000001", toMinor: null, amountMinor: "20000", februaryAmountMinor: null },
      ],
    },
    note: "West Bengal, five slabs. Verify against the current notification.",
  },
]);

/**
 * ⚠️ THE STATES DELIBERATELY LEFT EMPTY, NAMED SO NOBODY THINKS THIS IS
 * AN OVERSIGHT.
 *
 * ⭐ Delhi, Haryana, Uttar Pradesh, Rajasthan, Punjab, Uttarakhand,
 * Himachal Pradesh, Jammu & Kashmir, Chandigarh, Goa and several others
 * do not levy professional tax at all, or levy it in a form Ordence does
 * not model. A zero deduction there is correct.
 *
 * 🔴 EVERY OTHER STATE IS ABSENT BECAUSE A WRONG SLAB IS WORSE THAN A
 * MISSING ONE. Missing produces a stated note on the payslip; wrong
 * produces a confident deduction of the wrong amount, remitted to the
 * wrong total, and discovered at assessment.
 */
export const PT_NOT_LEVIED: readonly string[] = Object.freeze([
  "DL", "HR", "UP", "RJ", "PB", "UK", "HP", "JK", "CH", "GA", "AN", "LA",
]);
