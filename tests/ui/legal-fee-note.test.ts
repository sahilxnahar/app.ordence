/**
 * ⭐⭐⭐ LEGAL, BATCH 2 — WHO PAYS THE GST, AND THE ₹500 THAT COSTS ₹9,090.
 *
 * 🔴 BOTH HALVES FAIL SILENTLY AND EXPENSIVELY.
 *
 *    A firm that charges 18% forward on a reverse-charge legal fee has
 *    collected tax it had no authority to collect — s.76 makes it
 *    payable to the Government anyway, and the client cannot claim the
 *    credit. Nothing errors. The invoice looks completely normal.
 *
 *    A firm that rounds a ₹50,000 court fee up to ₹50,500 on the bill
 *    has moved the WHOLE ₹50,500 into the value of supply, because
 *    Explanation (d) to Rule 33 allows a pure agent only the actual
 *    amount incurred. Nothing errors there either.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LegalChargeError,
  REDUCED_THRESHOLD_STATE_CODES,
  THRESHOLD_CONTESTED_STATE_CODES,
  THRESHOLD_REDUCED_MINOR,
  THRESHOLD_STANDARD_MINOR,
  assessLegalCharge,
  assessRegistrationNeed,
  thresholdIsContested,
  thresholdMinorFor,
} from "@/lib/legal/gst-legal";
import {
  DisbursementError,
  PURE_AGENT_CAPABLE,
  assessPureAgent,
  feeNoteTotals,
  type FeeNoteLine,
} from "@/lib/legal/disbursement";
import {
  CourtFeeError,
  computeCourtFee,
  refundEntitlement,
  validateCourtFeeSlabs,
  type CourtFeeSlab,
} from "@/lib/legal/court-fee";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
/**
 * ⚠️ JSX gets re-wrapped by the formatter, so a sentence assertion has
 * to be made against whitespace-collapsed text. This is the same helper
 * the limitation suite needed — it is a tool, not a lesson to re-learn.
 */
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0059_court_fees_disbursements.sql");
const GST_LIB = read("lib/legal/gst-legal.ts");
const DISB_LIB = read("lib/legal/disbursement.ts");
const FEE_LIB = read("lib/legal/court-fee.ts");
const DISB_ACTIONS = read("server/actions/disbursements.ts");
const BILLING_ACTIONS = read("server/actions/legal-billing.ts");
const TIME_ACTIONS = read("server/actions/time-billing.ts");
const DISB_PAGE = read("app/(crm)/legal/disbursements/page.tsx");
const FEE_PAGE = read("app/(crm)/legal/fee-note/page.tsx");
const BUILDER = read("components/legal/fee-note-builder.tsx");
const REGISTRY = read("lib/modules/registry.ts");
const SCHEMA = read("db/schema/legal-billing.ts");

/* ================================================================== */
/* ① WHO PAYS                                                          */
/* ================================================================== */

const FIRM = {
  supplier: "firm_of_advocates",
  service: "advice",
} as const;

describe("🔴 an advocate almost never charges forward GST on legal services", () => {
  it("puts a large business client on reverse charge with no tax on the invoice", () => {
    const v = assessLegalCharge({
      ...FIRM,
      recipient: "business_entity",
      recipientStateCode: "27",
      recipientTurnoverPrecedingFyMinor: 500_000_000_00n,
    });
    expect(v.basis).toBe("reverse_charge");
    expect(v.isReverseCharge).toBe(true);
    /** 🔴 THE INVOICE CARRIES NOTHING. */
    expect(v.invoiceTaxRateBps).toBe(0);
    expect(v.citation).toContain("13/2017");
    expect(v.citation).toContain("Sr. No. 2");
  });

  it("exempts an individual who is not a business entity", () => {
    const v = assessLegalCharge({ ...FIRM, recipient: "not_a_business" });
    expect(v.basis).toBe("exempt");
    expect(v.isReverseCharge).toBe(false);
    expect(v.invoiceTaxRateBps).toBe(0);
    expect(v.citation).toContain("12/2017");
  });

  it("exempts the Government", () => {
    const v = assessLegalCharge({ ...FIRM, recipient: "government" });
    expect(v.basis).toBe("exempt");
  });

  it("exempts another firm of advocates, so tax does not stack down a brief chain", () => {
    const v = assessLegalCharge({ ...FIRM, recipient: "advocate_or_firm" });
    expect(v.basis).toBe("exempt");
    expect(v.arguable).toBe(false);
  });

  it("🔴 charges forward when the supply is NOT a legal service", () => {
    const v = assessLegalCharge({
      supplier: "firm_of_advocates",
      service: "not_a_legal_service",
      recipient: "business_entity",
      recipientTurnoverPrecedingFyMinor: 500_000_000_00n,
    });
    expect(v.basis).toBe("forward_charge");
    expect(v.invoiceTaxRateBps).toBe(1800);
    expect(v.isReverseCharge).toBe(false);
  });

  it("🔴 charges forward when the supplier is not an advocate at all", () => {
    const v = assessLegalCharge({
      supplier: "not_an_advocate",
      service: "advice",
      recipient: "business_entity",
      recipientTurnoverPrecedingFyMinor: 500_000_000_00n,
    });
    expect(v.basis).toBe("forward_charge");
    expect(v.reason).toContain("advocate");
  });

  it("treats an overseas client as an export, not as reverse charge", () => {
    const v = assessLegalCharge({
      ...FIRM,
      recipient: "business_entity",
      recipientOutsideIndia: true,
      recipientTurnoverPrecedingFyMinor: 500_000_000_00n,
    });
    /** ⚠️ Sr. No. 2 only reaches a business entity IN the taxable territory. */
    expect(v.basis).toBe("export_zero_rated");
    expect(v.isReverseCharge).toBe(false);
    expect(v.invoiceDeclaration).toMatch(/Letter of Undertaking/i);
  });

  it("puts an arbitral tribunal on its own entry, Sr. No. 3", () => {
    const v = assessLegalCharge({
      supplier: "individual_advocate",
      service: "arbitral_tribunal",
      recipient: "business_entity",
      recipientTurnoverPrecedingFyMinor: 500_000_000_00n,
    });
    expect(v.basis).toBe("reverse_charge");
    expect(v.citation).toContain("Sr. No. 3");
  });
});

describe("🔴 the threshold that decides the exemption is the CLIENT's", () => {
  it("exempts a business entity at or below the threshold", () => {
    const v = assessLegalCharge({
      ...FIRM,
      recipient: "business_entity",
      recipientStateCode: "27",
      recipientTurnoverPrecedingFyMinor: THRESHOLD_STANDARD_MINOR,
    });
    /** ⭐ AT the threshold is still below the line — "up to". */
    expect(v.basis).toBe("exempt");
  });

  it("moves the same client to reverse charge one paisa over", () => {
    const v = assessLegalCharge({
      ...FIRM,
      recipient: "business_entity",
      recipientStateCode: "27",
      recipientTurnoverPrecedingFyMinor: THRESHOLD_STANDARD_MINOR + 1n,
    });
    expect(v.basis).toBe("reverse_charge");
  });

  it("🔴 applies ₹10 lakh in Manipur where ₹20 lakh applies in Maharashtra", () => {
    const turnover = 1_500_000_00n; // ₹15,00,000
    const maharashtra = assessLegalCharge({
      ...FIRM,
      recipient: "business_entity",
      recipientStateCode: "27",
      recipientTurnoverPrecedingFyMinor: turnover,
    });
    const manipur = assessLegalCharge({
      ...FIRM,
      recipient: "business_entity",
      recipientStateCode: "14",
      recipientTurnoverPrecedingFyMinor: turnover,
    });
    /** ⚠️ The same turnover, two different answers. */
    expect(maharashtra.basis).toBe("exempt");
    expect(manipur.basis).toBe("reverse_charge");
  });

  it("uses reverse charge — never exempt — when the turnover is unknown", () => {
    const v = assessLegalCharge({
      ...FIRM,
      recipient: "business_entity",
      recipientStateCode: "27",
      recipientTurnoverPrecedingFyMinor: null,
    });
    /**
     * 🔴 The safe default. Assuming exempt would leave the client with
     * an undischarged reverse-charge liability they never knew about.
     */
    expect(v.basis).toBe("reverse_charge");
    expect(v.notes.join(" ")).toMatch(/not on file|not been recorded/i);
  });

  it("lets a tenant override the threshold, and stops calling it contested", () => {
    const args = { recipientStateCode: "11", overrideMinor: 3_000_000_00n };
    expect(thresholdMinorFor(args)).toBe(3_000_000_00n);
    expect(thresholdIsContested(args)).toBe(false);
  });

  it("refuses a threshold that is not positive", () => {
    expect(() => thresholdMinorFor({ overrideMinor: 0n })).toThrow(LegalChargeError);
  });

  it("refuses a negative turnover", () => {
    expect(() =>
      assessLegalCharge({
        ...FIRM,
        recipient: "business_entity",
        recipientTurnoverPrecedingFyMinor: -1n,
      }),
    ).toThrow(LegalChargeError);
  });
});

describe("⚠️ where published sources disagree, Ordence says so", () => {
  it("keeps the confident four and the contested set apart", () => {
    for (const c of REDUCED_THRESHOLD_STATE_CODES) {
      expect(THRESHOLD_CONTESTED_STATE_CODES).not.toContain(c);
    }
    expect(REDUCED_THRESHOLD_STATE_CODES).toEqual(["13", "14", "15", "16"]);
  });

  it("uses ₹20 lakh in a contested State — the answer that never leaves tax uncollected", () => {
    expect(thresholdMinorFor({ recipientStateCode: "11" })).toBe(THRESHOLD_STANDARD_MINOR);
    expect(thresholdMinorFor({ recipientStateCode: "14" })).toBe(THRESHOLD_REDUCED_MINOR);
  });

  it("🔴 tells the firm to confirm the threshold by hand in a contested State", () => {
    const v = assessLegalCharge({
      ...FIRM,
      recipient: "business_entity",
      recipientStateCode: "11",
      recipientTurnoverPrecedingFyMinor: 1_500_000_00n,
    });
    expect(v.notes.join(" ")).toMatch(/CONFIRM THE THRESHOLD/i);
  });

  it("does not nag about the threshold in a State that is not contested", () => {
    const v = assessLegalCharge({
      ...FIRM,
      recipient: "business_entity",
      recipientStateCode: "27",
      recipientTurnoverPrecedingFyMinor: 1_500_000_00n,
    });
    expect(v.notes.join(" ")).not.toMatch(/CONFIRM THE THRESHOLD/i);
  });
});

describe("🔴 the one question Ordence refuses to answer quietly", () => {
  it("flags a senior advocate billing another firm of advocates as arguable", () => {
    const v = assessLegalCharge({
      supplier: "senior_advocate",
      service: "advice",
      recipient: "advocate_or_firm",
    });
    expect(v.arguable).toBe(true);
    expect(v.arguableNote).toBeTruthy();
    expect(v.arguableNote ?? "").toMatch(/unsettled|take your own view/i);
    /** ⭐ And the working answer is the one that leaves no tax uncollected. */
    expect(v.basis).toBe("reverse_charge");
  });

  it("does NOT flag a non-senior advocate in the same position", () => {
    const v = assessLegalCharge({
      supplier: "individual_advocate",
      service: "advice",
      recipient: "advocate_or_firm",
    });
    expect(v.arguable).toBe(false);
    expect(v.basis).toBe("exempt");
  });
});

describe("⭐ registration — and the one supply that ends the relief", () => {
  it("does not require registration where every supply is on reverse charge", () => {
    const v = assessRegistrationNeed({
      hasForwardChargeSupplies: false,
      aggregateTurnoverMinor: 50_000_000_00n,
    });
    expect(v.mustRegister).toBe(false);
    expect(v.citation).toContain("5/2017");
  });

  it("🔴 requires it as soon as ONE forward-charge supply exists and turnover is over", () => {
    const v = assessRegistrationNeed({
      hasForwardChargeSupplies: true,
      aggregateTurnoverMinor: 50_000_000_00n,
    });
    expect(v.mustRegister).toBe(true);
    expect(v.citation).toContain("s.22(1)");
    /** ⚠️ Aggregate turnover counts the exempt and RCM supplies too. */
    expect(v.notes.join(" ")).toMatch(/s\.2\(6\)/);
  });

  it("does not require it where the forward-charge supplies are under the threshold", () => {
    const v = assessRegistrationNeed({
      hasForwardChargeSupplies: true,
      aggregateTurnoverMinor: 1_000_000_00n,
    });
    expect(v.mustRegister).toBe(false);
  });

  it("distinguishes the s.24(i) goods trigger from services", () => {
    const v = assessRegistrationNeed({
      hasForwardChargeSupplies: false,
      aggregateTurnoverMinor: 1n,
      makesInterStateSupplyOfGoods: true,
    });
    expect(v.mustRegister).toBe(true);
    expect(v.citation).toContain("s.24(i)");
    expect(v.notes.join(" ")).toMatch(/10\/2017-Integrated Tax/);
  });
});

/* ================================================================== */
/* ② RULE 33                                                           */
/* ================================================================== */

const AT_ACTUAL = {
  kind: "court_fee",
  clientAuthorised: true,
  separatelyIndicated: true,
  suppliedOnOwnAccount: true,
} as const;

describe("🔴🔴 the ₹500 that costs ₹9,090", () => {
  it("excludes a court fee recovered at exactly what was paid", () => {
    const v = assessPureAgent({ ...AT_ACTUAL, paidMinor: 50_000_00n, recoveredMinor: 50_000_00n });
    expect(v.excludedFromValue).toBe(true);
    expect(v.failedOn).toEqual([]);
    expect(v.taxAtRiskMinor).toBe(0n);
  });

  it("🔴 destroys the exclusion for a ₹500 markup — and taxes the WHOLE recovery", () => {
    const v = assessPureAgent({
      ...AT_ACTUAL,
      paidMinor: 50_000_00n,
      recoveredMinor: 50_500_00n,
    });
    expect(v.excludedFromValue).toBe(false);
    /**
     * 🔴 THE NUMBER THIS WHOLE BATCH EXISTS FOR.
     * 18% of ₹50,500 = ₹9,090. NOT 18% of ₹500 = ₹90.
     */
    expect(v.taxAtRiskMinor).toBe(9_090_00n);
    expect(v.failedOn.join(" ")).toMatch(/Explanation \(d\)/);
  });

  it("says so in rupees, so nobody has to work it out", () => {
    const v = assessPureAgent({
      ...AT_ACTUAL,
      paidMinor: 50_000_00n,
      recoveredMinor: 50_500_00n,
    });
    expect(v.notes.join(" ")).toContain("₹9,090.00");
    expect(v.notes.join(" ")).toContain("₹50,500.00");
  });

  it("fails without the client's authorisation — Rule 33(i) and Explanation (a)", () => {
    const v = assessPureAgent({
      ...AT_ACTUAL,
      clientAuthorised: false,
      paidMinor: 10_000_00n,
      recoveredMinor: 10_000_00n,
    });
    expect(v.excludedFromValue).toBe(false);
    expect(v.failedOn.join(" ")).toMatch(/Rule 33\(i\)/);
  });

  it("fails when it is not separately indicated — Rule 33(ii)", () => {
    const v = assessPureAgent({
      ...AT_ACTUAL,
      separatelyIndicated: false,
      paidMinor: 10_000_00n,
      recoveredMinor: 10_000_00n,
    });
    expect(v.excludedFromValue).toBe(false);
    expect(v.failedOn.join(" ")).toMatch(/Rule 33\(ii\)/);
  });

  it("fails when there is nothing supplied on the firm's own account — Rule 33(iii)", () => {
    const v = assessPureAgent({
      ...AT_ACTUAL,
      suppliedOnOwnAccount: false,
      paidMinor: 10_000_00n,
      recoveredMinor: 10_000_00n,
    });
    expect(v.excludedFromValue).toBe(false);
    expect(v.failedOn.join(" ")).toMatch(/Rule 33\(iii\)/);
  });

  it("🔴 refuses travel as a pure agent recovery — the client never owed the airline", () => {
    expect(PURE_AGENT_CAPABLE.travel).toBe(false);
    expect(PURE_AGENT_CAPABLE.courier).toBe(false);
    expect(PURE_AGENT_CAPABLE.court_fee).toBe(true);
    expect(PURE_AGENT_CAPABLE.stamp_duty).toBe(true);

    const v = assessPureAgent({
      ...AT_ACTUAL,
      kind: "travel",
      paidMinor: 8_000_00n,
      recoveredMinor: 8_000_00n,
    });
    expect(v.excludedFromValue).toBe(false);
    expect(v.notes.join(" ")).toMatch(/never liable to the third party/i);
  });

  it("⚠️ flags recovering LESS than was paid without pretending it is the same mischief", () => {
    const v = assessPureAgent({
      ...AT_ACTUAL,
      paidMinor: 50_000_00n,
      recoveredMinor: 45_000_00n,
    });
    expect(v.excludedFromValue).toBe(false);
    expect(v.notes.join(" ")).toMatch(/no margin here/i);
  });

  it("refuses a negative disbursement", () => {
    expect(() =>
      assessPureAgent({ ...AT_ACTUAL, paidMinor: -1n, recoveredMinor: 0n }),
    ).toThrow(DisbursementError);
  });
});

describe("🔴 the fee note keeps the two totals apart — Rule 33(ii)", () => {
  const lines: FeeNoteLine[] = [
    {
      kind: "court_fee",
      description: "Court fee on the plaint",
      paidMinor: 50_000_00n,
      recoveredMinor: 50_000_00n,
      isPureAgent: true,
    },
    {
      kind: "travel",
      description: "Travel to Nagpur bench",
      paidMinor: 8_000_00n,
      recoveredMinor: 8_000_00n,
      isPureAgent: false,
    },
  ];

  it("adds the disbursement AFTER the tax, never into the taxable value", () => {
    const t = feeNoteTotals({ feesMinor: 1_00_000_00n, lines, taxRateBps: 1800 });
    expect(t.pureAgentDisbursementsMinor).toBe(50_000_00n);
    expect(t.taxableRecoveriesMinor).toBe(8_000_00n);
    /** ⭐ Fees + travel. The court fee is NOT here. */
    expect(t.taxableValueMinor).toBe(1_08_000_00n);
    expect(t.taxMinor).toBe(19_440_00n);
    expect(t.totalPayableMinor).toBe(1_08_000_00n + 19_440_00n + 50_000_00n);
  });

  it("🔴 charges nothing at all under reverse charge, but still carries the disbursement", () => {
    const t = feeNoteTotals({ feesMinor: 1_00_000_00n, lines, taxRateBps: 0 });
    expect(t.taxMinor).toBe(0n);
    expect(t.totalPayableMinor).toBe(1_08_000_00n + 50_000_00n);
  });

  it("⚠️ refuses to build a note on a pure-agent line that is not at actual", () => {
    expect(() =>
      feeNoteTotals({
        feesMinor: 0n,
        taxRateBps: 1800,
        lines: [
          {
            kind: "court_fee",
            description: "Court fee, rounded",
            paidMinor: 50_000_00n,
            recoveredMinor: 50_500_00n,
            isPureAgent: true,
          },
        ],
      }),
    ).toThrow(DisbursementError);
  });
});

/* ================================================================== */
/* ③ COURT FEES — STRUCTURE, NOT RATES                                 */
/* ================================================================== */

const SLABS: CourtFeeSlab[] = [
  { fromMinor: 0n, uptoMinor: 1_00_000_00n, rateBps: 500 },
  { fromMinor: 1_00_000_00n, uptoMinor: 10_00_000_00n, rateBps: 750 },
  { fromMinor: 10_00_000_00n, uptoMinor: null, rateBps: 1000 },
];

describe("⭐ the court fee is computed from the tenant's own schedule", () => {
  it("slices the valuation band by band", () => {
    const r = computeCourtFee({
      schedule: { statuteRef: "Test Act, Sch I, Art 1", basis: "ad_valorem", slabs: SLABS },
      valuationMinor: 5_00_000_00n,
    });
    /** 5% of the first lakh + 7.5% of the next four. */
    expect(r.feeMinor).toBe(5_000_00n + 30_000_00n);
    expect(r.steps.length).toBe(2);
    expect(r.cappedAtMaximum).toBe(false);
  });

  it("🔴 applies the statutory maximum, which is why big suits are cheap to file", () => {
    const r = computeCourtFee({
      schedule: {
        statuteRef: "Test Act",
        basis: "ad_valorem",
        slabs: SLABS,
        maximumMinor: 3_00_000_00n,
      },
      valuationMinor: 10_00_00_000_00n,
    });
    expect(r.feeMinor).toBe(3_00_000_00n);
    expect(r.cappedAtMaximum).toBe(true);
  });

  it("rounds up to the next ₹10 where the Act says so", () => {
    const r = computeCourtFee({
      schedule: {
        statuteRef: "Test Act",
        basis: "fixed",
        fixedMinor: 1_234_00n,
        roundUpToMinor: 10_00n,
      },
      valuationMinor: 0n,
    });
    expect(r.feeMinor).toBe(1_240_00n);
  });

  it("always tells the firm to check it against the registry", () => {
    const r = computeCourtFee({
      schedule: { statuteRef: "Test Act", basis: "fixed", fixedMinor: 500_00n },
      valuationMinor: 0n,
    });
    expect(r.notes.join(" ")).toMatch(/registry wall|deficit court fee/i);
  });

  it("refuses to compute a schedule marked as worked out by hand", () => {
    expect(() =>
      computeCourtFee({
        schedule: { statuteRef: "Test Act", basis: "manual" },
        valuationMinor: 1n,
      }),
    ).toThrow(CourtFeeError);
  });

  it("refuses a negative valuation", () => {
    expect(() =>
      computeCourtFee({
        schedule: { statuteRef: "T", basis: "fixed", fixedMinor: 1n },
        valuationMinor: -1n,
      }),
    ).toThrow(CourtFeeError);
  });
});

describe("🔴 a gap in a schedule does not throw — it under-charges", () => {
  it("accepts a contiguous schedule", () => {
    expect(validateCourtFeeSlabs(SLABS)).toEqual([]);
  });

  it("catches a gap between two bands", () => {
    const problems = validateCourtFeeSlabs([
      { fromMinor: 0n, uptoMinor: 1_00_000_00n, rateBps: 500 },
      { fromMinor: 2_00_000_00n, uptoMinor: null, rateBps: 750 },
    ]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.map((p) => p.message).join(" ")).toMatch(/Gap/);
  });

  it("catches an overlap", () => {
    const problems = validateCourtFeeSlabs([
      { fromMinor: 0n, uptoMinor: 2_00_000_00n, rateBps: 500 },
      { fromMinor: 1_00_000_00n, uptoMinor: null, rateBps: 750 },
    ]);
    expect(problems.map((p) => p.message).join(" ")).toMatch(/Overlap/);
  });

  it("catches a schedule that does not start at zero", () => {
    const problems = validateCourtFeeSlabs([
      { fromMinor: 1_000_00n, uptoMinor: null, rateBps: 500 },
    ]);
    expect(problems.map((p) => p.message).join(" ")).toMatch(/start at zero/i);
  });

  it("catches a schedule with no open top band", () => {
    const problems = validateCourtFeeSlabs([
      { fromMinor: 0n, uptoMinor: 1_00_000_00n, rateBps: 500 },
    ]);
    expect(problems.map((p) => p.message).join(" ")).toMatch(/open-ended/i);
  });

  it("refuses to compute from a schedule with a hole in it", () => {
    expect(() =>
      computeCourtFee({
        schedule: {
          statuteRef: "Broken Act",
          basis: "ad_valorem",
          slabs: [
            { fromMinor: 0n, uptoMinor: 1_00_000_00n, rateBps: 500 },
            { fromMinor: 2_00_000_00n, uptoMinor: null, rateBps: 750 },
          ],
        },
        valuationMinor: 1_50_000_00n,
      }),
    ).toThrow(CourtFeeError);
  });
});

describe("🔴 Kankariya — a Lok Adalat award and a mediation are not the same thing", () => {
  it("gives a full statutory refund on a Lok Adalat award", () => {
    const r = refundEntitlement({ route: "lok_adalat" });
    expect(r.verdict).toBe("full");
    expect(r.checkStateAct).toBe(false);
    expect(r.citation).toMatch(/Legal Services Authorities Act/);
  });

  it("⚠️ does NOT promise a refund on a court-referred mediation", () => {
    const r = refundEntitlement({ route: "court_referred_mediation" });
    expect(r.verdict).toBe("state_specific");
    expect(r.checkStateAct).toBe(true);
    expect(r.citation).toMatch(/2024/);
    expect(r.reason).toMatch(/cannot be equated/i);
  });

  it("treats a private settlement as contested rather than settled", () => {
    const r = refundEntitlement({ route: "private_settlement" });
    expect(r.verdict).toBe("state_specific");
    expect(r.reason).toMatch(/contested/i);
  });

  it("gives nothing on a bare withdrawal", () => {
    const r = refundEntitlement({ route: "withdrawal" });
    expect(r.verdict).toBe("none");
  });

  it("names the tenant's own statute when it has one", () => {
    const r = refundEntitlement({
      route: "court_referred_mediation",
      stateStatuteRef: "Bombay Court Fees Act 1959",
    });
    expect(r.citation).toContain("Bombay Court Fees Act 1959");
  });
});

/* ================================================================== */
/* ④ THE RULES THAT LIVE IN THE DATABASE                               */
/* ================================================================== */

describe("🔴 0059 puts the rules where nothing can route around them", () => {
  const sql = sqlCode(SQL);

  it("refuses a pure agent recovery that is not at actual", () => {
    expect(sql).toContain("matter_disbursements_pure_agent_is_at_actual");
    expect(flat(sql)).toMatch(
      /matter_disbursements_pure_agent_is_at_actual CHECK \(\s*NOT is_pure_agent OR recovered_amount_minor = paid_amount_minor/,
    );
  });

  it("refuses a pure agent recovery the client never authorised", () => {
    expect(sql).toContain("matter_disbursements_pure_agent_is_authorised");
  });

  it("refuses travel and courier as pure agent recoveries", () => {
    expect(sql).toContain("matter_disbursements_own_costs_are_not_pure_agent");
    expect(flat(sql)).toMatch(/kind NOT IN \('travel', 'courier'\)/);
  });

  it("validates court fee bands as a set, deferred to the end of the transaction", () => {
    expect(sql).toContain("ordence_validate_court_fee_slabs");
    expect(sql).toContain("CREATE CONSTRAINT TRIGGER trg_validate_court_fee_slabs");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
  });

  it("refuses a court fee refunded twice", () => {
    expect(sql).toContain("ordence_guard_court_fee_refund");
    expect(flat(sql)).toMatch(/cannot be refunded twice/i);
  });

  it("refuses to move a disbursement that has already been billed", () => {
    expect(sql).toContain("ordence_guard_billed_disbursement");
    expect(flat(sql)).toMatch(/already been billed/i);
  });

  it("keeps the suit valuation separate from the claim", () => {
    expect(sql).toContain("suit_valuation_minor");
  });

  it("⚠️ refuses a turnover with no financial year attached to it", () => {
    expect(sql).toContain("legal_client_tax_status_turnover_has_year");
  });

  it("refuses an overseas client that also has an Indian State code", () => {
    expect(sql).toContain("legal_client_tax_status_overseas_is_not_local");
  });

  it("requires a reason for a position taken on the contested question", () => {
    expect(sql).toContain("legal_practice_profile_position_is_reasoned");
  });

  it("⭐ ships no court fee rates at all", () => {
    /**
     * 🔴 THE TEST THAT KEEPS THE PROMISE. If somebody ever seeds a
     * State's slabs into the migration, this fails — and it should,
     * because a stale slab is worse than an empty table.
     */
    expect(sql).not.toMatch(/INSERT INTO court_fee_slabs/i);
    expect(sql).not.toMatch(/INSERT INTO court_fee_schedules/i);
  });

  it("puts RLS on every new table, with platform scope in USING only", () => {
    for (const t of [
      "court_fee_schedules",
      "court_fee_slabs",
      "matter_disbursements",
      "court_fee_refund_claims",
      "legal_practice_profile",
      "legal_client_tax_status",
    ]) {
      expect(sql, t).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      expect(sql, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    }
    /** 🔴 app_platform_scope() NEVER appears in a WITH CHECK. */
    const withChecks = sql.match(/WITH CHECK \([^)]*\)/g) ?? [];
    expect(withChecks.length).toBeGreaterThan(0);
    for (const w of withChecks) {
      expect(w).not.toContain("app_platform_scope");
    }
  });
});

/* ================================================================== */
/* ⑤ THE DEFECT THIS BATCH CORRECTS                                    */
/* ================================================================== */

describe("🔴🔴 raiseInvoiceFromTime no longer charges 18% forward unconditionally", () => {
  const c = code(TIME_ACTIONS);

  it("takes a charge basis", () => {
    expect(c).toContain("chargeBasis");
    expect(c).toMatch(/"forward_charge",\s*"reverse_charge",\s*"exempt",\s*"export_zero_rated"/);
  });

  it("🔴 FORCES the rate to zero on anything but forward charge", () => {
    expect(flat(c)).toMatch(
      /const effectiveRateBps = data\.chargeBasis === "forward_charge" \? data\.taxRateBps : 0;/,
    );
  });

  it("uses the derived rate on the invoice lines, not the one that was passed in", () => {
    expect(c).toContain("taxRateBps: effectiveRateBps");
    expect(c).not.toContain("taxRateBps: data.taxRateBps,");
  });

  it("sets the Rule 46(p) reverse-charge flag on the invoice", () => {
    expect(c).toMatch(/const isReverseCharge = data\.chargeBasis === "reverse_charge";/);
    expect(c).toContain("isReverseCharge,");
  });
});

describe("🔴 the actions refuse the expensive mistakes with a reason, not a constraint name", () => {
  it("explains the markup in rupees before the database rejects it", () => {
    const c = code(DISB_ACTIONS);
    expect(c).toContain("A pure agent recovery must be at actual");
    expect(c).toContain("Explanation (d)");
    expect(flat(c)).toMatch(/falls into the value of supply/);
  });

  it("refuses a firm's own cost as a pure agent recovery", () => {
    expect(code(DISB_ACTIONS)).toContain("PURE_AGENT_CAPABLE");
  });

  it("re-assesses stored rows on read rather than trusting the flag", () => {
    const c = code(DISB_ACTIONS);
    expect(c).toContain("assessPureAgent");
    expect(c).toContain("atRisk");
  });

  it("refuses an overseas client with an Indian State code", () => {
    expect(code(BILLING_ACTIONS)).toMatch(/cannot also have an Indian State code/);
  });

  it("refuses a turnover with no year on it", () => {
    expect(code(BILLING_ACTIONS)).toMatch(/which financial year/);
  });

  it("requires a written reason for a position on the contested question", () => {
    expect(code(BILLING_ACTIONS)).toMatch(/has to say why/);
  });

  it("defaults an unrecorded client to reverse charge and says the assumption out loud", () => {
    expect(flat(code(BILLING_ACTIONS))).toMatch(/Nothing is recorded about this client/);
  });
});

/* ================================================================== */
/* ⑥ WHAT THE SCREENS SAY                                              */
/* ================================================================== */

describe("⭐ the screens lead with the rule, not the field", () => {
  it("the fee note screen states that an advocate almost never charges GST", () => {
    expect(flat(FEE_PAGE)).toMatch(/almost never charges GST on legal services/i);
  });

  it("🔴 the builder offers no tax rate box, and says why", () => {
    expect(flat(BUILDER)).toMatch(/There is no tax rate to type/i);
    expect(BUILDER).not.toMatch(/id="fn-rate"/);
  });

  it("prints the Rule 46(p) declaration where it can be copied", () => {
    expect(flat(BUILDER)).toMatch(/Rule 46\(p\)/);
    expect(BUILDER).toContain("invoiceDeclaration");
  });

  it("shows the arguable case in red rather than answering it", () => {
    expect(BUILDER).toContain("arguable");
    expect(BUILDER).toContain("arguableNote");
  });

  it("the disbursements screen leads with the whole-recovery consequence", () => {
    expect(flat(DISB_PAGE)).toMatch(/the exclusion is lost on the.*whole.*recovery/i);
  });

  it("explains why no court fee rates ship", () => {
    expect(flat(DISB_PAGE)).toMatch(/ships no court fee rates/i);
    expect(flat(DISB_PAGE)).toMatch(/stale slab is worse than an empty table/i);
  });

  it("states the Kankariya distinction where the refund decision is made", () => {
    expect(flat(DISB_PAGE)).toMatch(/Lok Adalat/);
    expect(flat(DISB_PAGE)).toMatch(/20 December 2024/);
  });

  it("shows the unbilled-disbursement leak", () => {
    expect(flat(DISB_PAGE)).toMatch(/Paid out, not billed/);
  });
});

describe("⭐ the new screens are on the ledger, not free", () => {
  it("registers both, charged for, under money", () => {
    const c = code(REGISTRY);
    for (const nav of ["disbursements", "fee-note"]) {
      expect(c, nav).toContain(`navId: "${nav}"`);
    }
    /** ⚠️ Neither is feature: null. Nothing legal ships free. */
    const block = c.slice(c.indexOf('navId: "disbursements"'), c.indexOf('contracts: {'));
    expect(block).not.toContain("feature: null");
    expect(block).toContain('feature: "sales.orders"');
  });

  it("wires both into the legal industry template", () => {
    const nav = read("lib/industry-templates.ts");
    expect(nav).toContain('href: "/legal/fee-note"');
    expect(nav).toContain('href: "/legal/disbursements"');
  });

  it("declares the new tables in the Drizzle schema", () => {
    for (const t of [
      "courtFeeSchedules",
      "courtFeeSlabs",
      "matterDisbursements",
      "courtFeeRefundClaims",
      "legalPracticeProfile",
      "legalClientTaxStatus",
    ]) {
      expect(SCHEMA, t).toContain(`export const ${t} = pgTable`);
    }
    expect(read("db/schema/index.ts")).toContain('export * from "./legal-billing"');
  });
});

describe("⚠️ the libs stay pure", () => {
  it("reads no clock and no database", () => {
    for (const [name, src] of [
      ["gst-legal", GST_LIB],
      ["disbursement", DISB_LIB],
      ["court-fee", FEE_LIB],
    ] as const) {
      const c = code(src);
      expect(c, name).not.toMatch(/new Date\(\)/);
      expect(c, name).not.toMatch(/Date\.now\(/);
      expect(c, name).not.toContain("@/db");
    }
  });

  it("uses bigint minor units, never a float", () => {
    for (const [name, src] of [
      ["disbursement", DISB_LIB],
      ["court-fee", FEE_LIB],
    ] as const) {
      expect(code(src), name).not.toMatch(/parseFloat|Number\(.*Minor/);
    }
  });
});
