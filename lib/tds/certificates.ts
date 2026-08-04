/**
 * Ordence — Form 16A / 27D Certificate Assembly
 * Version: v0.36.0-alpha
 *
 * Pure. `bigint` paise, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WE DO NOT ISSUE THE CERTIFICATE. WE PREDICT IT.
 * ══════════════════════════════════════════════════════════════════════
 * Rule 31(3) requires Form 16A to be DOWNLOADED FROM TRACES — generated
 * by the Department from the return we filed and the challans that
 * actually matched in OLTAS. A certificate typed by a deductor is not a
 * valid certificate and a deductee's assessing officer will not accept it.
 *
 * So the job of this file is not to produce the document. It is to answer
 * one question BEFORE the request goes to TRACES:
 *
 *        WILL THE CERTIFICATE SAY WHAT OUR BOOKS SAY?
 *
 * ⭐ AND THE ANSWER IS FREQUENTLY NO, FOR ONE REASON: TRACES CERTIFIES
 * WHAT WAS DEPOSITED AND MATCHED, NOT WHAT WAS DEDUCTED. Tax deducted in
 * March and deposited in July appears on no certificate the vendor can
 * use for that year. Their books show ₹40,000 withheld, their Form 26AS
 * shows ₹30,000, and the ₹10,000 is real, ours, and invisible to them.
 *
 * That gap is `deposited_tds_minor` against `total_tds_minor` on
 * `tds_certificates`, and it is the number the phone call is about.
 */

import { certificateDueDate, quarterRange } from "./calendar";
import { formatPaise, sectionRule } from "./sections";
import type {
  TdsCertificateForm,
  TdsQuarter,
  TdsSectionCode,
} from "@/db/schema/tds";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type CertificateDeduction = {
  id: string;
  section: TdsSectionCode;
  deductionDate: string;
  chargeableBaseMinor: bigint;
  rateBps: number;
  tdsMinor: bigint;
  surchargeMinor: bigint;
  cessMinor: bigint;
  /** NULL until deposited. Everything about the certificate turns on it. */
  challanId: string | null;
  bsrCode?: string | null;
  challanSerial?: string | null;
  depositDate?: string | null;
};

export type CertificateDeducteeFacts = {
  id: string;
  legalName: string;
  panNumber: string | null;
  /** Non-residents get a 27Q-derived certificate, not a 26Q one. */
  isNonResident?: boolean;
};

export type CertificateLine = {
  deductionId: string;
  section: string;
  deductionDate: string;
  baseMinor: string;
  rateBps: number;
  tdsMinor: string;
  bsrCode?: string;
  challanSerial?: string;
  depositDate?: string;
};

export type AssembledCertificate = {
  deducteeId: string;
  deducteeName: string;
  panNumber: string | null;
  formType: TdsCertificateForm;
  financialYear: string;
  quarter: TdsQuarter;
  tan: string;
  dueDate: string;

  totalBaseMinor: bigint;
  totalTdsMinor: bigint;
  /** ⭐ Only what reached a challan. What TRACES will actually certify. */
  depositedTdsMinor: bigint;
  /** ⭐ Deducted and not deposited. The gap the vendor cannot see. */
  undepositedTdsMinor: bigint;

  lineDetail: CertificateLine[];

  /** Reasons this certificate would be wrong, or short, if requested now. */
  problems: string[];
  /** Non-blocking notes. */
  warnings: string[];
};

/* ------------------------------------------------------------------ */
/* ASSEMBLY                                                            */
/* ------------------------------------------------------------------ */

/**
 * Assemble one deductee's certificate for one quarter.
 *
 * ⚠️ THE FORM IS DERIVED FROM THE SECTIONS PRESENT, NOT PASSED IN. A
 * deductee with 194-IA deductions gets Form 16B and everybody else gets
 * 16A, and letting a caller choose is how a land seller receives a Form
 * 16A for a transaction that was never on a 26Q return — a document
 * quoting a TAN that has nothing to do with the Form 26QB the payment was
 * actually made on.
 *
 * ⚠️ AND MIXING THE TWO IN ONE CERTIFICATE IS REFUSED, not silently
 * split. A certificate covering both would have to quote two different
 * statements, and it is not a case any real quarter produces by accident.
 */
export function assembleCertificate(args: {
  deductee: CertificateDeducteeFacts;
  deductions: readonly CertificateDeduction[];
  financialYear: string;
  quarter: TdsQuarter;
  tan: string;
  /** Override the derived form. Used for 27D (TCS). */
  formType?: TdsCertificateForm;
}): AssembledCertificate {
  const problems: string[] = [];
  const warnings: string[] = [];

  const { from, to } = quarterRange(args.financialYear, args.quarter);
  const inQuarter = args.deductions.filter(
    (d) => d.deductionDate >= from && d.deductionDate <= to,
  );
  const outOfQuarter = args.deductions.length - inQuarter.length;
  if (outOfQuarter > 0) {
    warnings.push(
      `${outOfQuarter} deduction(s) fell outside ${args.quarter} of ` +
        `${args.financialYear} (${from} to ${to}) and are not on this ` +
        `certificate. ⚠️ Check they are on the right one — a deduction reported in ` +
        `the wrong quarter reaches the deductee's Form 26AS in a quarter their own ` +
        `return does not look at.`,
    );
  }

  const sections = new Set(inQuarter.map((d) => d.section));
  const has194IA = sections.has("194IA");
  const formType: TdsCertificateForm =
    args.formType ?? (has194IA && sections.size === 1 ? "16B" : "16A");

  if (has194IA && sections.size > 1) {
    problems.push(
      "This deductee has both Section 194-IA deductions and others in the same " +
        "quarter. ⚠️ They cannot go on one certificate: 194-IA is discharged on " +
        "Form 26QB against a PAN with no TAN and certified on Form 16B, while " +
        "everything else is on a 26Q return under this TAN and certified on Form " +
        "16A. Two certificates, from two statements.",
    );
  }

  let totalBaseMinor = 0n;
  let totalTdsMinor = 0n;
  let depositedTdsMinor = 0n;
  const lineDetail: CertificateLine[] = [];

  for (const d of inQuarter) {
    const tax = d.tdsMinor + d.surchargeMinor + d.cessMinor;
    if (tax === 0n && d.chargeableBaseMinor === 0n) {
      // ⚠️ Below-threshold rows are in the register so the annual limit can
      // be applied. They are NOT on a certificate — there is nothing to
      // certify, and printing a zero line invites the deductee to claim it.
      continue;
    }

    totalBaseMinor += d.chargeableBaseMinor;
    totalTdsMinor += tax;
    if (d.challanId) depositedTdsMinor += tax;

    lineDetail.push({
      deductionId: d.id,
      section: sectionRule(d.section).code,
      deductionDate: d.deductionDate,
      baseMinor: d.chargeableBaseMinor.toString(),
      rateBps: d.rateBps,
      tdsMinor: tax.toString(),
      ...(d.bsrCode ? { bsrCode: d.bsrCode } : {}),
      ...(d.challanSerial ? { challanSerial: d.challanSerial } : {}),
      ...(d.depositDate ? { depositDate: d.depositDate } : {}),
    });
  }

  const undeposited = totalTdsMinor - depositedTdsMinor;

  /* --- ⭐ The gap that produces the phone call -------------------- */
  if (undeposited > 0n) {
    problems.push(
      `⭐ ${formatPaise(undeposited)} of the ${formatPaise(totalTdsMinor)} deducted ` +
        `this quarter has not reached a challan. TRACES certifies what was ` +
        `DEPOSITED AND MATCHED, not what was deducted, so this certificate will ` +
        `show ${formatPaise(depositedTdsMinor)} — and the deductee's books will ` +
        `show ${formatPaise(totalTdsMinor)}. They cannot claim the difference and ` +
        `they cannot see where it went. ⚠️ Deposit it before requesting the ` +
        `certificate; interest under Section 201(1A)(ii) is already running at ` +
        `1.5% a month from the date of each deduction.`,
    );
  }

  /* --- The PAN. No PAN, no certificate worth having. -------------- */
  if (!args.deductee.panNumber) {
    problems.push(
      `No PAN on file for ${args.deductee.legalName}. ⚠️ A certificate without one ` +
        `cannot be generated by TRACES and would put the credit against nobody — ` +
        `the tax is deposited under our TAN and sits there. The deduction should ` +
        `already have been at 20% under Section 206AA; obtaining the PAN now fixes ` +
        `future payments and, on a correction statement, this one.`,
    );
  }

  return {
    deducteeId: args.deductee.id,
    deducteeName: args.deductee.legalName,
    panNumber: args.deductee.panNumber,
    formType,
    financialYear: args.financialYear,
    quarter: args.quarter,
    tan: args.tan,
    dueDate: certificateDueDate(args.financialYear, args.quarter),
    totalBaseMinor,
    totalTdsMinor,
    depositedTdsMinor,
    undepositedTdsMinor: undeposited,
    lineDetail,
    problems,
    warnings,
  };
}

/**
 * Assemble a quarter's certificates, one per deductee.
 *
 * ⚠️ IT RETURNS DEDUCTEES WITH NOTHING TO CERTIFY AS AN EMPTY ASSEMBLY
 * RATHER THAN OMITTING THEM. "Why has this vendor not had a Form 16A?" is
 * a real question with two very different answers — nothing was deducted,
 * or something was deducted and lost — and a list that silently drops the
 * first cannot distinguish them.
 */
export function assembleQuarterCertificates(args: {
  deductees: readonly CertificateDeducteeFacts[];
  deductions: readonly (CertificateDeduction & { deducteeId: string })[];
  financialYear: string;
  quarter: TdsQuarter;
  tan: string;
}): AssembledCertificate[] {
  const byDeductee = new Map<string, CertificateDeduction[]>();
  for (const d of args.deductions) {
    const bucket = byDeductee.get(d.deducteeId) ?? [];
    bucket.push(d);
    byDeductee.set(d.deducteeId, bucket);
  }

  return args.deductees.map((deductee) =>
    assembleCertificate({
      deductee,
      deductions: byDeductee.get(deductee.id) ?? [],
      financialYear: args.financialYear,
      quarter: args.quarter,
      tan: args.tan,
    }),
  );
}
