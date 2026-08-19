/**
 * Ordence — ⭐ 24Q / 26Q / 27Q Assembly and the Validation Pass
 * Version: v0.36.0-alpha
 *
 * Pure. `bigint` paise, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE VALIDATION PASS IS THE VALUABLE HALF OF THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * A quarterly TDS statement is not accepted or rejected record by record.
 * The File Validation Utility refuses the WHOLE FILE on the first
 * structural defect, and it names it by record number and field number —
 * "T-FV-4034, record 47, field 12" — not by vendor.
 *
 * So the failure mode is not "one deductee is wrong". It is:
 *
 *   • the return is prepared on the 28th,
 *   • the utility rejects it,
 *   • somebody spends two days translating record numbers into vendors,
 *   • the return is filed on the 4th,
 *   • ⭐ and Section 234E has charged ₹200 a day since the 31st — a fee
 *     that CANNOT be waived for reasonable cause and without which the
 *     statement is not even accepted,
 *   • and every deductee's Form 16A is late too, at ₹100 a day under
 *     Section 272A(2)(g).
 *
 * `validateReturn` runs the same checks the utility runs, against our own
 * records, and reports them as sentences about VENDORS. Run it on the 5th
 * and the two days are free.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE CHECKS THAT ACTUALLY REJECT FILES
 * ══════════════════════════════════════════════════════════════════════
 * Listed in `TdsReturnFindingCode` below, each with the reason it exists.
 * The two worth reading before the others:
 *
 *   ⭐ `pan_type_mismatch` — the fourth character of a PAN IS the holder's
 *      constitution, and a deductee typed `company` whose PAN says `P` is
 *      rejected. It is also, quietly, a 194C rate error: that vendor has
 *      been deducted at 2% and is an individual at 1%.
 *
 *   ⭐ `challan_over_utilised` — more tax mapped to a challan than was
 *      deposited into it. The file is ACCEPTED and some deductees simply
 *      never get credit. Nothing errors, and they find out in October.
 */

import { reconcileChallans, type ChallanFacts, type MappedDeduction } from "./challans";
import { assessLateFiling } from "./interest";
import { isWithinQuarter, quarterRange, returnDueDate } from "./calendar";
import { formatBps, formatPaise, panAgreesWithDeducteeType, sectionRule } from "./sections";
import type {
  TdsDeducteeType,
  TdsPanStatus,
  TdsQuarter,
  TdsRateBasis,
  TdsReturnForm,
  TdsSectionCode,
} from "@/db/schema/tds";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type ReturnDeducteeFacts = {
  id: string;
  legalName: string;
  panNumber: string | null;
  panStatus: TdsPanStatus;
  deducteeType: TdsDeducteeType;
  isNonResident: boolean;
};

export type ReturnDeduction = {
  id: string;
  deducteeId: string;
  section: TdsSectionCode;
  deductionDate: string;
  paymentBaseMinor: bigint;
  chargeableBaseMinor: bigint;
  rateBps: number;
  rateBasis: TdsRateBasis;
  tdsMinor: bigint;
  surchargeMinor: bigint;
  cessMinor: bigint;
  challanId: string | null;
  lowerDeductionCertificateNumber?: string | null;
  outcome: string;
};

/* ------------------------------------------------------------------ */
/* ASSEMBLY                                                            */
/* ------------------------------------------------------------------ */

export type ReturnDeducteeBlock = {
  deducteeId: string;
  legalName: string;
  panNumber: string | null;
  /** ⚠️ "PANNOTAVBL" / "PANAPPLIED" / "PANINVALID" where there is none. */
  panForReturn: string;
  deducteeType: TdsDeducteeType;
  deductionCount: number;
  totalBaseMinor: bigint;
  totalTdsMinor: bigint;
};

export type AssembledReturn = {
  formType: TdsReturnForm;
  financialYear: string;
  quarter: TdsQuarter;
  tan: string;
  dueDate: string;

  deducteeCount: number;
  deductionCount: number;
  totalBaseMinor: bigint;
  totalTdsMinor: bigint;
  /** Attached to a challan. What the Department will give credit for. */
  totalDepositedMinor: bigint;

  blocks: ReturnDeducteeBlock[];
  /** Deductions this form does NOT carry, and why. */
  excluded: Array<{ deductionId: string; reason: string }>;
};

/**
 * ⭐ THE PAN VALUE A RETURN CARRIES WHEN THERE IS NO PAN.
 *
 * ⚠️ THE FIELD IS NOT LEFT BLANK — a blank PAN field is a structural
 * rejection. The utility accepts three reserved words, and using the right
 * one matters because they mean different things to the Department:
 *
 *   PANAPPLIED — Form 49A filed, number not yet issued.
 *   PANINVALID — a number was given and it is not a valid PAN.
 *   PANNOTAVBL — nothing has been furnished at all.
 *
 * ⚠️ NONE OF THEM IS RELIEF FROM SECTION 206AA. The return is accepted;
 * the deduction still had to be at 20%. And there is a further limit: a
 * quarterly statement may not carry more than a set proportion of records
 * with no PAN before it is rejected outright, which is why a workspace
 * with a lot of PAN-less labour contractors has a filing problem as well
 * as a rate problem.
 */
export function panForReturn(deductee: ReturnDeducteeFacts): string {
  if (deductee.panNumber && deductee.panStatus === "valid") return deductee.panNumber;
  switch (deductee.panStatus) {
    case "applied_for":
      return "PANAPPLIED";
    case "invalid":
    case "inoperative":
      return "PANINVALID";
    default:
      return deductee.panNumber ? "PANINVALID" : "PANNOTAVBL";
  }
}

/**
 * ⭐ WHICH FORM A DEDUCTION BELONGS ON.
 *
 * ⚠️ THE PAYEE DECIDES, NOT THE PAYMENT. A 194C payment to a non-resident
 * contractor is a 27Q record, not a 26Q one. A return filed on the wrong
 * form is rejected wholesale — so one misclassified deductee holds up the
 * certificates of every other deductee in the quarter.
 */
export function formTypeFor(
  section: TdsSectionCode,
  deductee: Pick<ReturnDeducteeFacts, "isNonResident">,
): TdsReturnForm {
  if (section === "192") return "24Q";
  if (deductee.isNonResident) return "27Q";
  return "26Q";
}

/**
 * Build one form's data for one quarter.
 *
 * ⚠️ IT FILTERS BY FORM AND BY QUARTER AND REPORTS WHAT IT LEFT OUT. A
 * silent filter is how a deduction disappears from every return: too
 * salary for 26Q, too non-resident for 24Q, and on nobody's list.
 */
export function assembleReturn(args: {
  formType: TdsReturnForm;
  financialYear: string;
  quarter: TdsQuarter;
  tan: string;
  deductees: readonly ReturnDeducteeFacts[];
  deductions: readonly ReturnDeduction[];
}): AssembledReturn {
  const byId = new Map(args.deductees.map((d) => [d.id, d]));
  const excluded: AssembledReturn["excluded"] = [];
  const blocks = new Map<string, ReturnDeducteeBlock>();

  let deductionCount = 0;
  let totalBaseMinor = 0n;
  let totalTdsMinor = 0n;
  let totalDepositedMinor = 0n;

  for (const d of args.deductions) {
    const deductee = byId.get(d.deducteeId);
    if (!deductee) {
      excluded.push({
        deductionId: d.id,
        reason:
          "The deductee for this deduction was not supplied. ⚠️ A deduction with " +
          "no payee cannot be reported at all, and the tax sits under our TAN " +
          "against nobody.",
      });
      continue;
    }

    if (!isWithinQuarter(d.deductionDate, args.financialYear, args.quarter)) {
      const { from, to } = quarterRange(args.financialYear, args.quarter);
      excluded.push({
        deductionId: d.id,
        reason:
          `Dated ${d.deductionDate}, outside ${args.quarter} of ` +
          `${args.financialYear} (${from} to ${to}).`,
      });
      continue;
    }

    const belongsOn = formTypeFor(d.section, deductee);
    if (belongsOn !== args.formType) {
      excluded.push({
        deductionId: d.id,
        reason:
          `Belongs on Form ${belongsOn}, not ${args.formType}` +
          (deductee.isNonResident
            ? " — the deductee is a non-resident, and every payment to them is " +
              "reported on 27Q whatever the section."
            : d.section === "192"
              ? " — salary is reported on 24Q."
              : "."),
      });
      continue;
    }

    const tax = d.tdsMinor + d.surchargeMinor + d.cessMinor;
    // ⚠️ Below-threshold rows exist so the annual limit can be applied.
    // They are not reported: there is no deduction to report.
    if (tax === 0n && d.outcome === "below_threshold") {
      continue;
    }

    deductionCount += 1;
    totalBaseMinor += d.chargeableBaseMinor;
    totalTdsMinor += tax;
    if (d.challanId) totalDepositedMinor += tax;

    const block = blocks.get(deductee.id) ?? {
      deducteeId: deductee.id,
      legalName: deductee.legalName,
      panNumber: deductee.panNumber,
      panForReturn: panForReturn(deductee),
      deducteeType: deductee.deducteeType,
      deductionCount: 0,
      totalBaseMinor: 0n,
      totalTdsMinor: 0n,
    };
    block.deductionCount += 1;
    block.totalBaseMinor += d.chargeableBaseMinor;
    block.totalTdsMinor += tax;
    blocks.set(deductee.id, block);
  }

  return {
    formType: args.formType,
    financialYear: args.financialYear,
    quarter: args.quarter,
    tan: args.tan,
    dueDate: returnDueDate(args.financialYear, args.quarter),
    deducteeCount: blocks.size,
    deductionCount,
    totalBaseMinor,
    totalTdsMinor,
    totalDepositedMinor,
    blocks: [...blocks.values()].sort((a, b) => a.legalName.localeCompare(b.legalName)),
    excluded,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ THE VALIDATION PASS                                               */
/* ------------------------------------------------------------------ */

export type TdsReturnFindingCode =
  /** No PAN, no reserved word, nothing. Structural rejection. */
  | "pan_missing"
  /** The PAN does not have the shape a PAN has. */
  | "pan_malformed"
  /** ⭐ Fourth character disagrees with the recorded constitution. */
  | "pan_type_mismatch"
  /** ⭐ A rate below the section's, with no certificate quoted. */
  | "reduced_rate_without_certificate"
  /** The tax is not the rate applied to the base. */
  | "tax_does_not_match_rate"
  /** Deducted, attached to no challan. No credit will reach the deductee. */
  | "deduction_not_linked_to_challan"
  /** ⭐ More mapped to a challan than was deposited into it. */
  | "challan_over_utilised"
  /** Money deposited against nothing. */
  | "challan_unutilised"
  /** Outside the quarter being filed. */
  | "date_outside_quarter"
  /** TAN missing or malformed. */
  | "tan_malformed"
  /** The stated totals do not match the records. */
  | "totals_disagree"
  /** ⭐ 234E is already accruing. */
  | "filing_overdue"
  /** A deductee with no PAN — accepted, but at 20% and against a quota. */
  | "no_pan_deductee";

export type TdsReturnFinding = {
  /** `reject` = the utility will refuse the file. `warn` = it will not. */
  severity: "reject" | "warn";
  code: TdsReturnFindingCode;
  deducteeId?: string;
  deductionId?: string;
  field?: string;
  message: string;
};

export type ReturnValidation = {
  findings: TdsReturnFinding[];
  rejectCount: number;
  warnCount: number;
  /** ⭐ Would the File Validation Utility accept this? */
  wouldBeAccepted: boolean;
  /** Section 234E, as at `asOf`. */
  lateFilingFeeMinor: bigint;
  summary: string;
};

const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_SHAPE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

/**
 * ⭐ WOULD THIS RETURN BE REJECTED, AND BY WHAT?
 *
 * Every finding names a VENDOR, not a record number. That translation is
 * the whole value: the utility says "record 47, field 12" and somebody
 * spends two days finding out that record 47 is Sahyadri Cement, while
 * ₹200 a day accrues under Section 234E.
 *
 * ⚠️ IT NEVER THROWS AND NEVER STOPS AT THE FIRST PROBLEM. The utility
 * stops at the first one, which is exactly why a return goes through four
 * reject-fix-resubmit cycles over four days. This reports all of them at
 * once so the cycle happens once.
 */
export function validateReturn(args: {
  assembled: AssembledReturn;
  deductees: readonly ReturnDeducteeFacts[];
  deductions: readonly ReturnDeduction[];
  challans: readonly ChallanFacts[];
  /** Today, for the 234E clock. */
  asOf: string;
}): ReturnValidation {
  const findings: TdsReturnFinding[] = [];
  const byId = new Map(args.deductees.map((d) => [d.id, d]));
  const { assembled } = args;

  /* --- The TAN ---------------------------------------------------- */
  if (!assembled.tan || !TAN_SHAPE.test(assembled.tan)) {
    findings.push({
      severity: "reject",
      code: "tan_malformed",
      field: "tan",
      message:
        `"${assembled.tan}" is not a Tax Deduction Account Number. A TAN is four ` +
        `letters, five digits and one letter — RTKA12345B. ⚠️ It is the identity ` +
        `the whole statement is filed under; nothing else in the file is looked ` +
        `at until it is right.`,
    });
  }

  /* --- Per deductee ----------------------------------------------- */
  for (const block of assembled.blocks) {
    const deductee = byId.get(block.deducteeId);
    if (!deductee) continue;

    if (!deductee.panNumber) {
      findings.push({
        severity: "warn",
        code: "no_pan_deductee",
        deducteeId: deductee.id,
        field: "pan",
        message:
          `${deductee.legalName} has no PAN, so the statement carries ` +
          `"${block.panForReturn}". ⚠️ That is accepted, and it is not relief: the ` +
          `deduction had to be at 20% under Section 206AA, the deductee gets no ` +
          `credit in any Form 26AS, and a statement carrying too high a proportion ` +
          `of PAN-less records is rejected outright.`,
      });
    } else {
      if (!PAN_SHAPE.test(deductee.panNumber)) {
        findings.push({
          severity: "reject",
          code: "pan_malformed",
          deducteeId: deductee.id,
          field: "pan",
          message:
            `${deductee.legalName}'s PAN "${deductee.panNumber}" is not a valid ` +
            `PAN — five letters, four digits, one letter. The file is rejected on ` +
            `this record and nothing after it is read.`,
        });
      } else {
        // ⭐ THE ONE THAT IS ALSO A RATE ERROR.
        const agrees = panAgreesWithDeducteeType(
          deductee.panNumber,
          deductee.deducteeType,
        );
        if (agrees === false) {
          findings.push({
            severity: "reject",
            code: "pan_type_mismatch",
            deducteeId: deductee.id,
            field: "deductee_type",
            message:
              `⭐ ${deductee.legalName} is recorded as "${deductee.deducteeType}", ` +
              `but the fourth character of their PAN (${deductee.panNumber}) is ` +
              `"${deductee.panNumber[3]}". The fourth character IS the holder's ` +
              `constitution, and the utility rejects the mismatch. ⚠️ It is also a ` +
              `rate error waiting to be found: Section 194C charges 1% to an ` +
              `individual or HUF and 2% to everybody else, so this vendor has been ` +
              `deducted at the wrong rate all year.`,
          });
        }
      }
    }
  }

  /* --- Per deduction ---------------------------------------------- */
  for (const d of args.deductions) {
    const deductee = byId.get(d.deducteeId);
    const name = deductee?.legalName ?? d.deducteeId;

    if (!isWithinQuarter(d.deductionDate, assembled.financialYear, assembled.quarter)) {
      continue; // Already reported as excluded by the assembler.
    }
    if (formTypeFor(d.section, deductee ?? { isNonResident: false }) !== assembled.formType) {
      continue;
    }

    const tax = d.tdsMinor + d.surchargeMinor + d.cessMinor;
    if (tax === 0n && d.outcome === "below_threshold") continue;

    const rule = sectionRule(d.section);

    /* ⭐ A reduced rate with no certificate quoted. */
    const normalForAnyone = Math.min(
      rule.rateBpsIndividualHuf ?? Number.MAX_SAFE_INTEGER,
      rule.rateBpsOther ?? Number.MAX_SAFE_INTEGER,
    );
    if (
      rule.rateResolvable &&
      d.rateBps < normalForAnyone &&
      d.rateBasis !== "section_197_certificate" &&
      !d.lowerDeductionCertificateNumber
    ) {
      findings.push({
        severity: "reject",
        code: "reduced_rate_without_certificate",
        deducteeId: d.deducteeId,
        deductionId: d.id,
        field: "rate",
        message:
          `⭐ ${name} was deducted at ${formatBps(d.rateBps)} under Section ` +
          `${rule.code}, below the ${formatBps(normalForAnyone)} the section ` +
          `charges, and no Section 197 certificate number is quoted. ⚠️ There is ` +
          `no third possibility: it is either a certificate or a short deduction. ` +
          `A certificate that exists and is not quoted is no defence — the ` +
          `Department reads the return, not the drawer.`,
      });
    }

    /* The arithmetic. */
    if (d.rateBps > 0 && d.chargeableBaseMinor > 0n) {
      const expected = (d.chargeableBaseMinor * BigInt(d.rateBps) + 5000n) / 10_000n;
      if (expected !== d.tdsMinor) {
        findings.push({
          severity: "warn",
          code: "tax_does_not_match_rate",
          deducteeId: d.deducteeId,
          deductionId: d.id,
          field: "tds_minor",
          message:
            `${name}: ${formatBps(d.rateBps)} of ` +
            `${formatPaise(d.chargeableBaseMinor)} is ${formatPaise(expected)}, ` +
            `and the row says ${formatPaise(d.tdsMinor)}. ⚠️ Surcharge and cess are ` +
            `separate columns, so this is not them — either the base or the rate ` +
            `has been edited since the tax was computed.`,
        });
      }
    }

    if (tax > 0n && !d.challanId) {
      findings.push({
        severity: "reject",
        code: "deduction_not_linked_to_challan",
        deducteeId: d.deducteeId,
        deductionId: d.id,
        field: "challan",
        message:
          `${name}: ${formatPaise(tax)} deducted on ${d.deductionDate} is attached ` +
          `to no challan. ⚠️ Every deduction in a statement quotes the challan that ` +
          `discharged it, by BSR code, deposit date and serial. Without one there ` +
          `is nothing for the Department to match, the deductee gets no credit, ` +
          `and interest under 201(1A)(ii) is running at 1.5% a month from the date ` +
          `of deduction.`,
      });
    }
  }

  /* --- ⭐ The challans -------------------------------------------- */
  const mapped: MappedDeduction[] = args.deductions.map((d) => ({
    id: d.id,
    challanId: d.challanId,
    tdsMinor: d.tdsMinor,
    surchargeMinor: d.surchargeMinor,
    cessMinor: d.cessMinor,
  }));
  const reconciliation = reconcileChallans({
    challans: args.challans,
    deductions: mapped,
  });

  for (const u of reconciliation.utilisations) {
    if (u.verdict === "over_utilised") {
      findings.push({
        severity: "reject",
        code: "challan_over_utilised",
        field: "challan",
        message: u.message,
      });
    } else if (u.verdict === "unutilised") {
      findings.push({
        severity: "warn",
        code: "challan_unutilised",
        field: "challan",
        message: u.message,
      });
    }
  }

  /* --- The stated totals ------------------------------------------ */
  const recomputedTds = assembled.blocks.reduce((sum, b) => sum + b.totalTdsMinor, 0n);
  if (recomputedTds !== assembled.totalTdsMinor) {
    findings.push({
      severity: "reject",
      code: "totals_disagree",
      field: "total_tds_minor",
      message:
        `The statement's total of ${formatPaise(assembled.totalTdsMinor)} does not ` +
        `equal the sum of its deductee blocks, ${formatPaise(recomputedTds)}. ⚠️ The ` +
        `utility recomputes every total, and a mismatch is a structural rejection.`,
    });
  }

  /* --- ⭐ Section 234E -------------------------------------------- */
  const lateFiling = assessLateFiling({
    dueDate: assembled.dueDate,
    filedOn: null,
    totalTdsMinor: assembled.totalTdsMinor,
    asOf: args.asOf,
  });
  if (lateFiling.late) {
    findings.push({
      severity: "warn",
      code: "filing_overdue",
      field: "filed_on",
      message: lateFiling.explanation,
    });
  }

  const rejectCount = findings.filter((f) => f.severity === "reject").length;
  const warnCount = findings.length - rejectCount;

  return {
    findings,
    rejectCount,
    warnCount,
    wouldBeAccepted: rejectCount === 0,
    lateFilingFeeMinor: lateFiling.feeMinor,
    summary:
      rejectCount === 0
        ? `This ${assembled.formType} for ${assembled.quarter} ${assembled.financialYear} ` +
          `would be accepted: ${assembled.deducteeCount} deductee(s), ` +
          `${assembled.deductionCount} deduction(s), ` +
          `${formatPaise(assembled.totalTdsMinor)} of tax.` +
          (warnCount > 0 ? ` ${warnCount} thing(s) worth looking at first.` : "")
        : `⭐ This ${assembled.formType} would be REJECTED. ${rejectCount} defect(s) ` +
          `the File Validation Utility refuses the whole file on, and ` +
          `${warnCount} warning(s). ⚠️ It refuses the file, not the record — so ` +
          `each of these has to be fixed before ANY deductee's credit reaches ` +
          `their Form 26AS, and Section 234E charges ₹200 a day meanwhile.`,
  };
}
