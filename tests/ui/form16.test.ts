/**
 * Ordence — Form 16 Part B
 *
 * ⚠️ PROPERTIES, NOT SHAPES. Nothing here pins an exact sentence or a
 * literal count: the wording of a caveat is meant to be improved, and a
 * test that breaks when somebody clarifies a warning teaches people to
 * delete tests. What is pinned is what must remain true of the output.
 *
 * 🔴 FOUR OF THESE ARE LOAD-BEARING:
 *   ① nothing in the output is presented as Part A;
 *   ② s.288A / s.288B rounding is exact where a float is not;
 *   ③ the two regimes produce different tax on the same input;
 *   ④ a disagreement between the year's payslips and the annual
 *      computation is REPORTED, never silently reconciled.
 */

import { describe, expect, it } from "vitest";

import {
  buildForm16,
  parseRegimeElections,
  roundToNearestTenRupees,
  type ChallanDeposit,
  type Form16Request,
  type Form16Rules,
  type PayslipTdsFact,
  type RegimeElection,
} from "@/lib/payroll/form16";
import { buildForm16Document } from "@/lib/payroll/form16-document";
import type { TaxSlab } from "@/lib/payroll/statutory";

/* ------------------------------------------------------------------ */
/* FIXTURES — data, exactly as the rate table would supply it          */
/* ------------------------------------------------------------------ */

const FY = "2025-26";
/** ₹1 = 100 paise. `r(3_00_000)` is three lakh rupees in paise. */
const r = (rupees: number): bigint => BigInt(rupees) * 100n;

const NEW_RULES: Form16Rules = {
  regime: "new",
  effectiveFrom: "2025-04-01",
  effectiveTo: "2026-03-31",
  standardDeductionMinor: r(75_000).toString(),
  rebateLimitMinor: r(12_00_000).toString(),
  rebateMaxMinor: r(60_000).toString(),
  cessRateBp: 400,
  surchargeThresholdMinor: r(50_00_000).toString(),
  exemptionCodesAllowed: [],
  allowsProfessionalTaxDeduction: false,
  allowsEntertainmentAllowance: false,
  allowsChapterViA: false,
  chapterViACapsMinor: {},
};

const OLD_RULES: Form16Rules = {
  regime: "old",
  effectiveFrom: "2025-04-01",
  effectiveTo: "2026-03-31",
  standardDeductionMinor: r(50_000).toString(),
  rebateLimitMinor: r(5_00_000).toString(),
  rebateMaxMinor: r(12_500).toString(),
  cessRateBp: 400,
  surchargeThresholdMinor: r(50_00_000).toString(),
  exemptionCodesAllowed: "all",
  allowsProfessionalTaxDeduction: true,
  allowsEntertainmentAllowance: false,
  allowsChapterViA: true,
  chapterViACapsMinor: { "80C": r(1_50_000).toString() },
};

const slab = (
  regime: "new" | "old",
  from: number,
  to: number | null,
  rateBp: number,
): TaxSlab => ({
  regime,
  effectiveFrom: "2025-04-01",
  effectiveTo: "2026-03-31",
  fromMinor: r(from).toString(),
  toMinor: to === null ? null : r(to).toString(),
  rateBp,
});

const SLABS: readonly TaxSlab[] = [
  slab("new", 0, 4_00_000, 0),
  slab("new", 4_00_000, 8_00_000, 500),
  slab("new", 8_00_000, 12_00_000, 1000),
  slab("new", 12_00_000, 16_00_000, 1500),
  slab("new", 16_00_000, 20_00_000, 2000),
  slab("new", 20_00_000, 24_00_000, 2500),
  slab("new", 24_00_000, null, 3000),
  slab("old", 0, 2_50_000, 0),
  slab("old", 2_50_000, 5_00_000, 500),
  slab("old", 5_00_000, 10_00_000, 2000),
  slab("old", 10_00_000, null, 3000),
];

const election = (regime: "new" | "old"): RegimeElection => ({
  financialYear: FY,
  regime,
  declaredOn: "2025-04-10",
  recordedBy: "payroll@example.test",
});

function payslips(perMonthMinor: bigint): PayslipTdsFact[] {
  const months = [
    "2025-04-30", "2025-05-31", "2025-06-30", "2025-07-31",
    "2025-08-31", "2025-09-30", "2025-10-31", "2025-11-30",
    "2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31",
  ];
  return months.map((periodEnd, i) => ({
    payslipId: `ps-${i}`,
    periodEnd,
    tdsMinor: perMonthMinor,
    isProjection: false,
    wasOverridden: false,
  }));
}

function deposits(perQuarterMinor: bigint): ChallanDeposit[] {
  return [
    { challanId: "c1", depositDate: "2025-07-07", bsrCode: "0510308", challanSerial: "00021", amountMinor: perQuarterMinor },
    { challanId: "c2", depositDate: "2025-10-07", bsrCode: "0510308", challanSerial: "00042", amountMinor: perQuarterMinor },
    { challanId: "c3", depositDate: "2026-01-07", bsrCode: "0510308", challanSerial: "00063", amountMinor: perQuarterMinor },
    { challanId: "c4", depositDate: "2026-04-30", bsrCode: "0510308", challanSerial: "00084", amountMinor: perQuarterMinor },
  ];
}

function request(over: Partial<Form16Request> = {}): Form16Request {
  return {
    financialYear: FY,
    employer: { name: "Basaveshwar Infra", tan: "BLRB01234E", pan: "AAACB1234C", address: null },
    employee: { employeeId: "e1", name: "R. Kulkarni", pan: "ABCPK1234D", designation: "Engineer" },
    elections: [election("new")],
    salary17_1Minor: r(15_00_000),
    perquisites17_2Minor: 0n,
    profitsInLieu17_3Minor: 0n,
    exemptions: [{ code: "10(13A)", label: "House rent allowance", amountMinor: r(1_80_000) }],
    professionalTaxMinor: r(2_400),
    entertainmentAllowanceMinor: 0n,
    chapterViA: [
      {
        section: "80C",
        label: "Life insurance, provident fund and others",
        grossAmountMinor: r(1_50_000),
        qualifyingAmountMinor: r(1_50_000),
      },
    ],
    otherIncomeReportedMinor: 0n,
    payslips: payslips(r(9_000)),
    deposits: deposits(r(27_000)),
    expectedMonths: 12,
    rules: [NEW_RULES, OLD_RULES],
    slabs: SLABS,
    ...over,
  };
}

/** Every human-readable string a reader could see on the document. */
function proseOf(doc: {
  title: string;
  partANotice: string;
  partAHeading: string;
  statusReason: string;
  basis: readonly string[];
  warnings: readonly string[];
  notes: readonly string[];
  rows: readonly { cells: Readonly<Record<string, string | null>> }[];
  partARows: readonly { cells: Readonly<Record<string, string | null>> }[];
}): string[] {
  const cellText = [...doc.rows, ...doc.partARows].flatMap((row) =>
    Object.values(row.cells).filter((v): v is string => typeof v === "string"),
  );
  return [
    doc.title,
    doc.partANotice,
    doc.partAHeading,
    doc.statusReason,
    ...doc.basis,
    ...doc.warnings,
    ...doc.notes,
    ...cellText,
  ];
}

/* ================================================================== */
/* ① 🔴 NOTHING IN THE OUTPUT IS PRESENTED AS PART A                   */
/* ================================================================== */

describe("Form 16 — Part A is never produced here", () => {
  const outcome = buildForm16(request());

  it("issues a Part B and nothing else", () => {
    expect(outcome.issued).toBe(true);
    if (!outcome.issued) return;

    // 🔴 The type-level promise, checked at runtime too.
    expect(outcome.partAInputs.isCertificate).toBe(false);
    expect(outcome.partAInputs.kind).toBe("part-a-reconciliation-inputs");
    expect(outcome.partAInputs.mustBeDownloadedFrom).toBe("TRACES");
  });

  it("marks the document as Part B only, on the document itself", () => {
    if (!outcome.issued) throw new Error("expected an issued certificate");
    const built = buildForm16Document({ outcome, generatedOn: "2026-05-20" });
    expect(built.generated).toBe(true);
    if (!built.generated) return;

    expect(built.document.part).toBe("B");
    expect(built.document.includesPartA).toBe(false);
  });

  it("never mentions Part A except to say it comes from TRACES", () => {
    if (!outcome.issued) throw new Error("expected an issued certificate");
    const built = buildForm16Document({ outcome, generatedOn: "2026-05-20" });
    if (!built.generated) throw new Error("expected a generated document");

    const prose = proseOf(built.document);
    const partAMentions = prose.filter((s) => /part\s*a/i.test(s));

    // ⭐ It must be mentioned — silence about Part A is its own failure.
    expect(partAMentions.length).toBeGreaterThan(0);

    // 🔴 And every mention must carry the disclaimer with it, so no single
    // sentence lifted out of context reads as a Part A this tool produced.
    for (const mention of partAMentions) {
      expect(/TRACES|not\b/i.test(mention)).toBe(true);
    }
  });

  it("keeps the quarterly figures in a table of their own", () => {
    if (!outcome.issued) throw new Error("expected an issued certificate");
    const built = buildForm16Document({ outcome, generatedOn: "2026-05-20" });
    if (!built.generated) throw new Error("expected a generated document");

    const bodyKeys = new Set(built.document.rows.map((row) => row.key));
    for (const row of built.document.partARows) {
      expect(bodyKeys.has(row.key)).toBe(false);
    }
    // The heading itself has to disclaim, not just the banner above it.
    expect(/not|reconcil/i.test(built.document.partAHeading)).toBe(true);
  });

  it("reports what was deducted against what is recorded as deposited", () => {
    if (!outcome.issued) throw new Error("expected an issued certificate");
    const a = outcome.partAInputs;
    expect(a.quarters).toHaveLength(4);
    const summed = a.quarters.reduce((s, q) => s + q.deductedMinor, 0n);
    expect(summed).toBe(a.totalDeductedMinor);
    expect(a.totalUndepositedMinor).toBe(a.totalDeductedMinor - a.totalDepositedMinor);
  });
});

/* ================================================================== */
/* ② 🔴 s.288A / s.288B ROUNDING, EXACT WHERE A FLOAT IS NOT           */
/* ================================================================== */

describe("Form 16 — rounding to the nearest ten rupees", () => {
  it("rounds half away from zero in BOTH directions", () => {
    // ₹1,00,005.00 sits exactly half way between two multiples of ten.
    expect(roundToNearestTenRupees(10_000_500n)).toBe(10_001_000n);
    expect(roundToNearestTenRupees(-10_000_500n)).toBe(-10_001_000n);
  });

  it("disagrees with the obvious float implementation on a refund", () => {
    /**
     * 🔴 THE BOUNDARY A FLOAT GETS WRONG. `Math.round` rounds half toward
     * POSITIVE INFINITY, so on a negative half — an excess deduction, which
     * s.288B covers in the same breath as tax payable — it rounds the
     * wrong way by ten rupees. This is not hypothetical arithmetic: it is
     * what any implementation written with `Number` produces.
     */
    const excessDeducted = -10_000_500n;
    const naiveFloat = BigInt(Math.round(Number(excessDeducted) / 1000) * 1000);

    expect(roundToNearestTenRupees(excessDeducted)).toBe(-10_001_000n);
    expect(naiveFloat).not.toBe(roundToNearestTenRupees(excessDeducted));
  });

  it("stays exact past the point where a Number cannot hold the input", () => {
    const beyondSafe = 9_007_199_254_740_993n; // 2^53 + 1 paise
    // The premise: this value is not representable as a JS number.
    expect(BigInt(Number(beyondSafe))).not.toBe(beyondSafe);
    // The property: the rounding is still exact.
    expect(roundToNearestTenRupees(beyondSafe)).toBe(9_007_199_254_741_000n);
  });

  it("leaves nothing but multiples of ten rupees on the certificate", () => {
    // ⭐ Paise deliberately present in the inputs, so a value that was not
    // rounded would show up as a non-zero remainder.
    const outcome = buildForm16(
      request({
        salary17_1Minor: r(15_00_000) + 47n,
        professionalTaxMinor: r(2_400) + 13n,
      }),
    );
    expect(outcome.issued).toBe(true);
    if (!outcome.issued) return;

    expect(outcome.partB.totalIncomeMinor % 1000n).toBe(0n);
    expect(outcome.partB.taxPayableMinor % 1000n).toBe(0n);
  });
});

/* ================================================================== */
/* ③ 🔴 THE TWO REGIMES ARE NOT THE SAME TAX                           */
/* ================================================================== */

describe("Form 16 — the regime election changes the tax", () => {
  const asNew = buildForm16(request({ elections: [election("new")] }));
  const asOld = buildForm16(request({ elections: [election("old")] }));

  it("computes a different liability on identical salary and declarations", () => {
    expect(asNew.issued).toBe(true);
    expect(asOld.issued).toBe(true);
    if (!asNew.issued || !asOld.issued) return;

    expect(asNew.partB.totalIncomeMinor).not.toBe(asOld.partB.totalIncomeMinor);
    expect(asNew.partB.taxPayableMinor).not.toBe(asOld.partB.taxPayableMinor);
  });

  it("allows Chapter VI-A and s.10 under the old regime and not the new one", () => {
    if (!asNew.issued || !asOld.issued) return;
    expect(asOld.partB.chapterViATotalMinor).toBeGreaterThan(0n);
    expect(asNew.partB.chapterViATotalMinor).toBe(0n);
    expect(asOld.partB.exemptSalaryMinor).toBeGreaterThan(0n);
    expect(asNew.partB.exemptSalaryMinor).toBe(0n);
  });

  it("shows a disallowed claim at nil rather than dropping it", () => {
    if (!asNew.issued) return;
    // ⚠️ The employee declared it; the certificate must show it was received.
    expect(asNew.partB.chapterViALines.some((l) => l.disallowed)).toBe(true);
    expect(asNew.partB.exemptionLines.some((l) => l.disallowed)).toBe(true);
  });

  it("refuses to build anything when no election is on file for the year", () => {
    const outcome = buildForm16(request({ elections: [] }));
    expect(outcome.issued).toBe(false);
    if (outcome.issued) return;
    expect(outcome.refusal.evidence.length).toBeGreaterThan(0);
  });

  it("does not borrow another year's election", () => {
    const outcome = buildForm16(
      request({ elections: [{ ...election("old"), financialYear: "2024-25" }] }),
    );
    expect(outcome.issued).toBe(false);
  });

  it("parses junk in the election column into no election at all", () => {
    expect(parseRegimeElections(null)).toHaveLength(0);
    expect(parseRegimeElections("2025-26")).toHaveLength(0);
    expect(parseRegimeElections({ "2025-26": { regime: "sideways" } })).toHaveLength(0);
    expect(parseRegimeElections({ nonsense: { regime: "old", declaredOn: "2025-04-01" } })).toHaveLength(0);
    expect(
      parseRegimeElections({ "2025-26": { regime: "old", declaredOn: "2025-04-01" } }),
    ).toHaveLength(1);
  });
});

/* ================================================================== */
/* ④ 🔴 A MISMATCH IS REPORTED, NOT SMOOTHED                           */
/* ================================================================== */

describe("Form 16 — the year's payslips against the annual computation", () => {
  const shortfall = buildForm16(request({ payslips: payslips(r(1_000)) }));

  it("reports what was deducted, not what should have been", () => {
    expect(shortfall.issued).toBe(true);
    if (!shortfall.issued) return;

    const deducted = r(1_000) * 12n;
    expect(shortfall.partB.taxDeductedPerPayslipsMinor).toBe(deducted);
    // 🔴 The two figures are kept apart. Collapsing them is the defect.
    expect(shortfall.partB.taxDeductedPerPayslipsMinor).not.toBe(
      shortfall.partB.taxPayableMinor,
    );
    expect(shortfall.partB.balanceMinor).toBe(deducted - shortfall.partB.taxPayableMinor);
  });

  it("raises a blocking finding rather than adjusting either number", () => {
    if (!shortfall.issued) return;
    expect(shortfall.reconciliation.agrees).toBe(false);
    expect(
      shortfall.reconciliation.findings.some((f) => f.severity === "blocking"),
    ).toBe(true);
  });

  it("refuses to call the document final while the figures disagree", () => {
    if (!shortfall.issued) return;
    const built = buildForm16Document({ outcome: shortfall, generatedOn: "2026-05-20" });
    if (!built.generated) throw new Error("expected a generated document");

    expect(built.document.status).not.toBe("final");
    expect(built.document.warnings.length).toBeGreaterThan(0);
    // Both figures must survive to the printed page.
    const prose = proseOf(built.document).join(" ");
    expect(prose).toContain("Tax deducted at source per the year's payslips");
  });

  it("names a month that produced no payslip at all", () => {
    const partial = buildForm16(request({ payslips: payslips(r(9_000)).slice(0, 9) }));
    expect(partial.issued).toBe(true);
    if (!partial.issued) return;
    expect(partial.reconciliation.monthsWithPayslip).toBe(9);
    expect(
      partial.reconciliation.findings.some((f) => f.code === "missing_months"),
    ).toBe(true);
  });
});

/* ================================================================== */
/* ⑤ SURCHARGE IS REFUSED, LOUDLY                                      */
/* ================================================================== */

describe("Form 16 — surcharge", () => {
  it("will not issue a certificate it would have to understate", () => {
    const outcome = buildForm16(request({ salary17_1Minor: r(90_00_000) }));
    expect(outcome.issued).toBe(false);
    if (outcome.issued) return;

    // ⚠️ A property, not a sentence: the refusal has to explain itself and
    // to name marginal relief, because that is the part a reader would
    // otherwise assume we had handled.
    expect(/surcharge/i.test(outcome.refusal.reason)).toBe(true);
    expect(/marginal relief/i.test(outcome.refusal.reason)).toBe(true);
    expect(outcome.refusal.evidence.length).toBeGreaterThan(0);
  });

  it("still tells the reader Part A comes from TRACES when it refuses", () => {
    const outcome = buildForm16(request({ salary17_1Minor: r(90_00_000) }));
    const built = buildForm16Document({ outcome, generatedOn: "2026-05-20" });
    expect(built.generated).toBe(false);
    if (built.generated) return;
    expect(built.refusal.part).toBe("B");
    expect(built.refusal.includesPartA).toBe(false);
    expect(built.refusal.partANotice).toContain("TRACES");
  });
});
