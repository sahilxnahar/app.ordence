/**
 * Ordence — ⭐⭐⭐ BATCH 78: THE MONTHLY STATUTORY RETURN FILES
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FOUR THINGS THAT MUST NOT BE QUIETLY REVERSED
 * ══════════════════════════════════════════════════════════════════════
 *   ① A MEMBER WITH NO UAN BLOCKS THE FILE. Not a blank field, not a
 *      dropped line, not an invented placeholder. The refusal names the
 *      person.
 *   ② AN EMPLOYEE WHO CROSSES THE ESI CEILING MID-PERIOD STAYS COVERED
 *      TO THE END OF THE CONTRIBUTION PERIOD, and a return that drops
 *      them refuses instead.
 *   ③ AN UNCONFIGURED PROFESSIONAL TAX STATE REFUSES. Professional tax
 *      is State law and there is no national fallback shape.
 *   ④ RUPEE CONVERSION IS EXACT IN BIGINT AT A BOUNDARY WHERE THE
 *      OBVIOUS FLOAT VERSION IS WRONG.
 *
 * ⚠️ THESE ARE PROPERTY ASSERTIONS, NOT SHAPE ASSERTIONS. Nothing below
 * pins an exact rendered string or an exact finding count — the point is
 * "no file was produced and this person is named", not "the message is
 * these 94 characters". Six tests in this suite were rewritten once for
 * pinning exactly that.
 */

import { describe, expect, it } from "vitest";

import type { EsiRules, PfRules } from "@/lib/payroll/statutory";
import { dueDateFor } from "@/lib/compliance/statutory-due";
import {
  ECR_LAYOUTS,
  ESIC_LAYOUTS,
  PT_RETURN_FORMS,
  buildEcr,
  buildEsicMonthly,
  buildPtReturn,
  contributionPeriodOf,
  contributionPeriodRange,
  daysFromCentidays,
  ecrLayoutFor,
  returnDueInfo,
  rupeesFromPaise,
  staysCovered,
  type EcrMemberFacts,
  type EsicPersonFacts,
  type PtPersonFacts,
} from "@/lib/payroll/returns";

/* ------------------------------------------------------------------ */
/* FIXTURES — today's numbers, stated as arguments, never as constants */
/* ------------------------------------------------------------------ */

const PF_RULES: PfRules = {
  effectiveFrom: "2014-09-01",
  effectiveTo: null,
  employeeRateBp: 1200,
  employerRateBp: 1200,
  pensionRateBp: 833,
  edliRateBp: 50,
  adminRateBp: 50,
  wageCeilingMinor: "1500000",
  pensionCeilingMinor: "1500000",
};

const ESI_RULES: EsiRules = {
  effectiveFrom: "2019-07-01",
  effectiveTo: null,
  employeeRateBp: 75,
  employerRateBp: 325,
  wageLimitMinor: "2100000",
};

const DUE = { dueOn: "2025-07-15", dueAuthority: "EPFO", ifLate: "Interest and damages." };
const PERIOD = { periodStart: "2025-06-01", periodEnd: "2025-06-30" };

function member(over: Partial<EcrMemberFacts> = {}): EcrMemberFacts {
  return {
    employeeId: "e1",
    employeeCode: "EMP-0001",
    memberName: "Anita Rao",
    uan: "100200300400",
    daysInMonth: 30,
    lopCentidays: 0,
    grossMinor: 2_000_000n,
    pfWagesMinor: 1_500_000n,
    employeePfMinor: 180_000n,
    employerPfMinor: 55_000n,
    employerPensionMinor: 125_000n,
    refundOfAdvancesMinor: 0n,
    pfExempt: false,
    ...over,
  };
}

function ecr(members: readonly EcrMemberFacts[]) {
  return buildEcr({
    members,
    pfRules: PF_RULES,
    ...PERIOD,
    ...DUE,
    establishmentCode: "KNRGN1234567",
  });
}

function insured(over: Partial<EsicPersonFacts> = {}): EsicPersonFacts {
  return {
    employeeId: "e1",
    employeeCode: "EMP-0001",
    ipName: "Anita Rao",
    ipNumber: "1234567890",
    daysInMonth: 30,
    payableCentidays: 3000,
    grossMinor: 1_800_000n,
    employeeEsiMinor: 13_500n,
    employerEsiMinor: 58_500n,
    coveredAtPeriodStart: true,
    esiExempt: false,
    zeroDayReasonCode: null,
    lastWorkingDay: null,
    ...over,
  };
}

function esic(people: readonly EsicPersonFacts[]) {
  return buildEsicMonthly({
    people,
    esiRules: ESI_RULES,
    ...PERIOD,
    dueOn: "2025-07-15",
    dueAuthority: "ESIC",
    ifLate: "Interest and damages.",
    employerCode: "12345678900001099",
  });
}

/* ================================================================== */
/* ① A MISSING UAN BLOCKS THE FILE                                     */
/* ================================================================== */

describe("EPFO ECR — a member with no UAN cannot be filed", () => {
  it("refuses the whole file and names the employee instead of emitting a blank", () => {
    const outcome = ecr([member(), member({ employeeId: "e2", employeeCode: "EMP-0002", memberName: "Vikram Shah", uan: null })]);

    // 🔴 NO FILE AT ALL. Not a file with a gap in it.
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;

    const codes = outcome.refusal.findings.map((f) => f.code);
    expect(codes).toContain("uan_missing");

    // ⭐ THE NAME IS THE DELIVERABLE. A record number is what the portal
    // would have given us, and it is useless.
    const named = outcome.refusal.findings.filter((f) => f.code === "uan_missing");
    expect(named.some((f) => f.subject.includes("Vikram Shah"))).toBe(true);

    // ⚠️ AND EVERY FINDING ON A REFUSAL IS BLOCKING — a refusal that
    // carried warnings would let a reader think the file nearly worked.
    expect(outcome.refusal.findings.every((f) => f.severity === "blocking")).toBe(true);
  });

  it("does not silently drop the member instead", () => {
    const bad = ecr([member({ uan: null })]);
    expect(bad.generated).toBe(false);

    const good = ecr([member()]);
    expect(good.generated).toBe(true);
    if (!good.generated) return;
    // The only difference between the two runs is the UAN, so a builder
    // that "skipped" the bad member would have produced a nil file here.
    expect(good.file.lineCount).toBe(1);
  });

  it("rejects a UAN that is not twelve digits, and a duplicated one", () => {
    const short = ecr([member({ uan: "12345" })]);
    expect(short.generated).toBe(false);
    if (short.generated) return;
    expect(short.refusal.findings.map((f) => f.code)).toContain("uan_malformed");

    const twice = ecr([member(), member({ employeeId: "e2", employeeCode: "EMP-0002" })]);
    expect(twice.generated).toBe(false);
    if (twice.generated) return;
    expect(twice.refusal.findings.map((f) => f.code)).toContain("uan_duplicated");
  });
});

/* ================================================================== */
/* NCP DAYS                                                            */
/* ================================================================== */

describe("EPFO ECR — NCP days from loss-of-pay centidays", () => {
  it("maps centidays to whole days and never exceeds the month", () => {
    // The property, not the number: a whole number of days, bounded.
    for (const centidays of [0, 50, 149, 150, 275, 3000]) {
      const { days } = daysFromCentidays(centidays, "nearest");
      expect(Number.isInteger(days)).toBe(true);
      expect(days).toBeGreaterThanOrEqual(0);
      expect(days * 100).toBeGreaterThanOrEqual(centidays - 50);
      expect(days * 100).toBeLessThanOrEqual(centidays + 50);
    }
  });

  it("tells the operator whenever a fractional loss of pay was rounded", () => {
    const outcome = ecr([member({ lopCentidays: 150 })]);
    expect(outcome.generated).toBe(true);
    if (!outcome.generated) return;

    // ⭐ THE FILE IS PRODUCED — rounding is legitimate — AND THE MEMBER
    // IS NAMED, because the payslip and the return now differ.
    const rounding = outcome.file.findings.filter((f) => f.code === "ncp_rounded");
    expect(rounding.length).toBeGreaterThan(0);
    expect(rounding.every((f) => f.severity === "warning")).toBe(true);
    expect(rounding.some((f) => f.subject.includes("Anita Rao"))).toBe(true);
  });

  it("refuses more non-contributory days than the month contains", () => {
    const outcome = ecr([member({ lopCentidays: 3500, daysInMonth: 30 })]);
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    expect(outcome.refusal.findings.map((f) => f.code)).toContain("days_exceed_month");
  });
});

/* ================================================================== */
/* THE FILE ITSELF                                                     */
/* ================================================================== */

describe("EPFO ECR — the emitted text", () => {
  it("has exactly one field per layout column on every line", () => {
    const layout = ecrLayoutFor("2025-06-30");
    expect(layout).not.toBeNull();
    if (layout === null) return;

    const outcome = ecr([member(), member({ employeeId: "e2", employeeCode: "EMP-0002", uan: "100200300401" })]);
    expect(outcome.generated).toBe(true);
    if (!outcome.generated) return;

    const lines = outcome.file.text.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      // 🔴 The count comes from the layout, so moving a column moves the
      // assertion with it rather than breaking it.
      expect(line.split(layout.delimiter)).toHaveLength(layout.fields.length);
    }
  });

  it("blocks a contribution carrying paise rather than dropping them", () => {
    const outcome = ecr([member({ employeePfMinor: 180_050n })]);
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    expect(outcome.refusal.findings.map((f) => f.code)).toContain("paise_would_be_lost");
  });

  it("ties its due date to the shared obligation table and not to a second opinion", () => {
    const info = returnDueInfo("epfo_ecr", "2025-06-30");
    expect(info).not.toBeNull();
    if (info === null) return;
    // ⭐ The property: it IS `dueDateFor`, whatever `dueDateFor` says.
    expect(info.dueOn).toBe(dueDateFor("2025-06-30", 15));
  });
});

/* ================================================================== */
/* ② THE ESI CONTRIBUTION PERIOD                                       */
/* ================================================================== */

describe("ESIC — crossing the wage ceiling mid-period", () => {
  it("keeps somebody covered for the rest of the contribution period", () => {
    const overLimit = {
      grossMinor: 2_500_000n,
      wageLimitMinor: BigInt(ESI_RULES.wageLimitMinor),
      isExempt: false,
    };
    expect(staysCovered({ ...overLimit, coveredAtPeriodStart: true }).covered).toBe(true);
    // ⚠️ And somebody who was NOT covered when the period began does not
    // acquire cover by staying above the limit.
    expect(staysCovered({ ...overLimit, coveredAtPeriodStart: false }).covered).toBe(false);
  });

  it("puts a mid-period riser on the return, on actual wages", () => {
    const outcome = esic([
      insured({
        grossMinor: 2_500_000n,
        coveredAtPeriodStart: true,
        employeeEsiMinor: 18_750n,
        employerEsiMinor: 81_250n,
      }),
    ]);
    expect(outcome.generated).toBe(true);
    if (!outcome.generated) return;
    expect(outcome.file.lineCount).toBe(1);
    // The wage on the return is the ACTUAL wage, not the ceiling.
    expect(outcome.file.text).toContain("25000");
  });

  it("refuses a return that drops a covered person mid-period", () => {
    // The payroll deducted nothing because the run was computed with the
    // documented `esiCoveredAtPeriodStart: false` approximation.
    const outcome = esic([
      insured({ grossMinor: 2_500_000n, coveredAtPeriodStart: true, employeeEsiMinor: 0n, employerEsiMinor: 0n }),
    ]);
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    expect(outcome.refusal.findings.map((f) => f.code)).toContain("esi_dropped_mid_period");
    expect(outcome.refusal.findings.some((f) => f.subject.includes("Anita Rao"))).toBe(true);
  });

  it("knows the two contribution periods and that October–March crosses a year", () => {
    expect(contributionPeriodOf(4)).toBe("apr_sep");
    expect(contributionPeriodOf(9)).toBe("apr_sep");
    expect(contributionPeriodOf(10)).toBe("oct_mar");
    expect(contributionPeriodOf(3)).toBe("oct_mar");

    // 🔴 THE YEAR-CROSSING PROPERTY: the range always contains its own
    // month and always begins before it ends.
    for (const end of ["2025-01-31", "2025-03-31", "2025-04-30", "2025-10-31", "2025-12-31"]) {
      const range = contributionPeriodRange(end);
      expect(range.from < range.to).toBe(true);
      expect(range.from <= end).toBe(true);
      expect(end <= range.to).toBe(true);
    }
  });

  it("blocks a covered person with no insurance number, and zero days with no reason", () => {
    const noIp = esic([insured({ ipNumber: null })]);
    expect(noIp.generated).toBe(false);
    if (noIp.generated) return;
    expect(noIp.refusal.findings.map((f) => f.code)).toContain("ip_number_missing");

    const zeroDays = esic([insured({ payableCentidays: 0, grossMinor: 0n, employeeEsiMinor: 0n, employerEsiMinor: 0n, zeroDayReasonCode: null })]);
    expect(zeroDays.generated).toBe(false);
    if (zeroDays.generated) return;
    expect(zeroDays.refusal.findings.map((f) => f.code)).toContain("esi_zero_days_without_reason");
  });

  it("notices when the portal's own arithmetic on the wage would disagree with the challan", () => {
    // ⭐ The portal recomputes from the wage column; a contribution that
    // is materially different from that recomputation must be reported.
    const outcome = esic([insured({ employeeEsiMinor: 100n, employerEsiMinor: 100n })]);
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    expect(outcome.refusal.findings.map((f) => f.code)).toContain("esi_contribution_disagrees_with_wage");
  });
});

/* ================================================================== */
/* ③ PROFESSIONAL TAX IS STATE LAW                                     */
/* ================================================================== */

function ptPerson(over: Partial<PtPersonFacts> = {}): PtPersonFacts {
  return {
    employeeId: "e1",
    employeeCode: "EMP-0001",
    employeeName: "Anita Rao",
    workStateCode: "KA",
    grossMinor: 2_000_000n,
    professionalTaxMinor: 20_000n,
    ...over,
  };
}

function pt(stateCode: string, people: readonly PtPersonFacts[], priorYear: bigint | null = null) {
  return buildPtReturn({
    people,
    stateCode,
    ...PERIOD,
    dueOn: "2025-07-20",
    dueAuthority: "State government",
    ifLate: "Varies by State.",
    priorYearLiabilityMinor: priorYear,
  });
}

describe("Professional tax — the State decides, or nothing is emitted", () => {
  it("refuses an unconfigured State rather than emitting a national shape", () => {
    const outcome = pt("ZZ", [ptPerson({ workStateCode: "ZZ" })]);
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    expect(outcome.refusal.findings.map((f) => f.code)).toContain("pt_state_not_configured");
    expect(outcome.refusal.reason).toContain("ZZ");
  });

  it("says a State that does not levy it has no return, rather than emitting a nil one", () => {
    const outcome = pt("DL", [ptPerson({ workStateCode: "DL", professionalTaxMinor: 0n })]);
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    // ⚠️ A DIFFERENT ANSWER FROM "not configured" — this one is a fact
    // about the State, and the reason says so.
    expect(outcome.refusal.findings.map((f) => f.code)).not.toContain("pt_state_not_configured");
  });

  it("refuses when the filing frequency depends on a figure nobody supplied", () => {
    const outcome = pt("MH", [ptPerson({ workStateCode: "MH" })], null);
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    expect(outcome.refusal.findings.map((f) => f.code)).toContain("pt_frequency_unknown");
  });

  it("produces the State's own shape when the State is configured", () => {
    const outcome = pt("KA", [ptPerson(), ptPerson({ employeeId: "e2", employeeCode: "EMP-0002", employeeName: "Vikram Shah" })]);
    expect(outcome.generated).toBe(true);
    if (!outcome.generated) return;
    expect(outcome.file.lineCount).toBe(2);
    // ⭐ The State's own form identifies the document; there is no
    // national form number to fall back on.
    expect(outcome.file.title).toContain("Karnataka");
    // Not confirmed with a CA, and the file says so rather than implying
    // somebody checked.
    expect(outcome.file.confirmedAgainstPortal).toBe(false);
    expect(outcome.file.findings.some((f) => f.code === "pt_state_not_configured" && f.severity === "warning")).toBe(true);
  });

  it("blocks a professional tax figure carrying paise, because slabs are whole rupees", () => {
    const outcome = pt("KA", [ptPerson({ professionalTaxMinor: 20_050n })]);
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    expect(outcome.refusal.findings.map((f) => f.code)).toContain("paise_would_be_lost");
  });

  it("only returns the employees who work in the State being filed for", () => {
    const outcome = pt("KA", [ptPerson(), ptPerson({ employeeId: "e2", employeeCode: "EMP-0002", workStateCode: "MH" })]);
    expect(outcome.generated).toBe(true);
    if (!outcome.generated) return;
    expect(outcome.file.lineCount).toBe(1);
  });
});

/* ================================================================== */
/* ④ RUPEES FROM PAISE                                                 */
/* ================================================================== */

describe("Money — rupees out of bigint paise", () => {
  it("is exact where the obvious float version is wrong", () => {
    // ⚠️ Above 2^53 a double cannot hold every integer, so `Number(p)`
    // moves the value before it is ever divided. This paise figure has a
    // remainder of 49 — it must round DOWN — and the float path rounds it
    // UP because the value it saw was not the value we hold.
    const paise = 90_071_992_547_409_949n;
    const exact = rupeesFromPaise(paise, "nearest");
    expect(exact).toBe(900_719_925_474_099n);
    expect(BigInt(Math.round(Number(paise) / 100))).not.toBe(exact);
  });

  it("rounds half away from zero, which is what a challan means by 'nearest'", () => {
    expect(rupeesFromPaise(1_050n, "nearest")).toBe(11n);
    expect(rupeesFromPaise(1_049n, "nearest")).toBe(10n);
    expect(rupeesFromPaise(1_000n, "nearest")).toBe(10n);
  });

  it("obeys the mode it is given, because the rule is not the same for every field", () => {
    expect(rupeesFromPaise(1_099n, "floor")).toBe(10n);
    expect(rupeesFromPaise(1_001n, "ceil")).toBe(11n);
    // 🔴 And it refuses a negative rather than truncating toward zero,
    // which is what dividing a negative bigint would silently do.
    expect(rupeesFromPaise(-150n, "nearest")).toBeNull();
  });

  it("never loses a paise on a value that is already a whole rupee", () => {
    for (const rupees of [0n, 1n, 15_000n, 999_999n]) {
      for (const mode of ["nearest", "floor", "ceil"] as const) {
        expect(rupeesFromPaise(rupees * 100n, mode)).toBe(rupees);
      }
    }
  });
});

/* ================================================================== */
/* HONESTY ABOUT THE LAYOUTS                                           */
/* ================================================================== */

describe("Layouts — nothing claims to have been verified", () => {
  it("carries no layout marked as confirmed against a live portal", () => {
    // 🔴 THE LOAD-BEARING ONE. This project has shipped a verify script
    // that printed "policies OK" over a real leak. A layout row flipped
    // to `true` without somebody opening the portal is the same failure,
    // and it files a wrong return.
    for (const layout of [...ECR_LAYOUTS, ...ESIC_LAYOUTS]) {
      expect(layout.confirmedAgainstPortal).toBe(false);
      expect(layout.source.length).toBeGreaterThan(0);
      expect(layout.note.length).toBeGreaterThan(0);
    }
    for (const form of PT_RETURN_FORMS) {
      expect(form.confirmedWithCa).toBe(false);
      expect(form.citation.length).toBeGreaterThan(0);
    }
  });

  it("prints the unconfirmed layout on every file it produces", () => {
    const outcome = ecr([member()]);
    expect(outcome.generated).toBe(true);
    if (!outcome.generated) return;
    expect(outcome.file.confirmedAgainstPortal).toBe(false);
    expect(outcome.file.warnings.some((w) => w.includes("NOT BEEN CONFIRMED"))).toBe(true);
  });

  it("every rounding decision is declared on the field rather than applied at the edge", () => {
    for (const layout of ECR_LAYOUTS) {
      for (const field of layout.fields) {
        const needsRounding = field.kind !== "text";
        expect(field.rounding === null).toBe(!needsRounding);
        expect(field.why.length).toBeGreaterThan(0);
      }
    }
  });
});

/* ================================================================== */
/* REFUSAL AS A RESULT                                                 */
/* ================================================================== */

describe("Refusal is a first-class outcome", () => {
  it("refuses when the rules for the period are missing rather than assuming today's ceiling", () => {
    const outcome = buildEcr({
      members: [member()],
      pfRules: null,
      ...PERIOD,
      ...DUE,
      establishmentCode: null,
    });
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    expect(outcome.refusal.findings.map((f) => f.code)).toContain("rules_missing");
  });

  it("never produces file text alongside a refusal", () => {
    const outcome = ecr([member({ uan: null })]);
    expect(outcome.generated).toBe(false);
    if (outcome.generated) return;
    expect(Object.prototype.hasOwnProperty.call(outcome, "file")).toBe(false);
  });
});
