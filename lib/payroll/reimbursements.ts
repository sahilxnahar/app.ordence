/**
 * Ordence — ⭐⭐⭐ EMPLOYEE REIMBURSEMENTS
 * Version: v1.52.0-alpha
 *
 * Pure. No database, no network, no clock. Every date and every amount
 * arrives as an argument, exactly as `lib/payroll/statutory.ts` and
 * `lib/payroll/settlement.ts` do.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE WHOLE FEATURE IS ONE DISTINCTION, AND IT IS NOT A CHECKBOX
 * ══════════════════════════════════════════════════════════════════════
 * A REIMBURSEMENT is the employer giving back money the EMPLOYEE ALREADY
 * SPENT on the employer's behalf. Nothing accrues to the employee: they
 * are ₹4,000 poorer for the air ticket and ₹4,000 richer for the
 * repayment. There is no income, so there is no salary, so PF, ESI,
 * professional tax and s.192 TDS have nothing to bite on.
 *
 * 🔴 AN ALLOWANCE IS THE OPPOSITE AND LOOKS IDENTICAL ON A PAYSLIP. A
 * fixed ₹4,000 "travel reimbursement" paid every month whether or not
 * anybody travelled is a sum the employee keeps. It is a profit in lieu
 * of, or in addition to, salary under s.17(1)(iv) of the Income-tax Act,
 * 1961 and it is TAXABLE.
 *
 * ⭐⭐ THE ONLY THING THAT TELLS THE TWO APART IS THE EVIDENCE. A bill,
 * an invoice, a receipt, a boarding pass — a document, dated, for an
 * amount, that shows the money left the employee's pocket. Rule 3 of the
 * Income-tax Rules, 1962 and the proviso to s.10(14) both hang on the
 * expenditure being ACTUALLY INCURRED; the exemption for a special
 * allowance under s.10(14)(i) is available only "to the extent to which
 * such expenses are actually incurred for that purpose".
 *
 * 🔴🔴 SO THIS MODULE WILL NOT LET A USER TICK "REIMBURSEMENT" AND MAKE
 * TAX GO AWAY. The tick is not an input. The DOCUMENTS are the input,
 * and the treatment is DERIVED from them:
 *
 *     evidence ≥ claim  →  the whole claim is not wages
 *     evidence < claim  →  the shortfall is a TAXABLE ALLOWANCE
 *     no evidence       →  the whole claim is a TAXABLE ALLOWANCE
 *
 * ⚠️ AND THE SHORTFALL IS NOT REFUSED. Refusing would push the employer
 * into paying it outside the payroll, where no tax is deducted at all,
 * which is worse than paying it and taxing it. The claim is honoured and
 * RECLASSIFIED, and the payslip says which part was which.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE REFUSES TO DECIDE, AND WHO HAS TO
 * ══════════════════════════════════════════════════════════════════════
 * ① PF AND ESI ON THE UNEVIDENCED PART. Once a sum is an allowance the
 *   question becomes whether it is "basic wages" under s.2(b) of the
 *   Employees' Provident Funds and Miscellaneous Provisions Act, 1952,
 *   and whether it is "wages" under s.2(22) of the Employees' State
 *   Insurance Act, 1948. The Supreme Court's 2019 decision on universal
 *   allowances pulled a great many allowances INTO basic wages and the
 *   boundary is still argued establishment by establishment. Ordence
 *   returns `notDecided` and names it. ⚠️ A CA MUST CONFIRM THIS PER
 *   COMPONENT; a wrong answer is a PF demand with interest under s.7Q
 *   and damages under s.14B.
 * ② THE PER-CATEGORY EXEMPTION CEILINGS. Some categories carry their
 *   own limits (uniform, books and periodicals, telephone) and they move
 *   with the Finance Act and with the tax regime the employee elected.
 *   NOT MODELLED HERE — see `caps` below.
 * ③ GST INPUT TAX CREDIT on the underlying bill. Not this module's
 *   question and not attempted.
 */

import type { Paise } from "./statutory";

/* ================================================================== */
/* ① THE EVIDENCE                                                      */
/* ================================================================== */

/**
 * ⚠️ `self_declaration` IS ON THIS LIST AND IT IS NOT EVIDENCE BY
 * DEFAULT — see `EvidencePolicy`. It is here so an employer can RECORD
 * that a declaration was taken, which is a real and useful fact, without
 * that record silently buying a tax exemption.
 */
export type EvidenceKind =
  | "bill"
  | "invoice"
  | "receipt"
  | "boarding_pass"
  | "bank_statement"
  | "self_declaration";

export interface EvidenceDocument {
  readonly kind: EvidenceKind;
  /** The bill number, the PNR, the statement line. Printed, not parsed. */
  readonly reference: string;
  /** ISO date on the document itself, not the date it was uploaded. */
  readonly documentDate: string;
  /** Paise. The amount the DOCUMENT shows, which may be less than claimed. */
  readonly amountMinor: string;
}

/**
 * ⭐ WHICH DOCUMENT KINDS PROVE EXPENDITURE. Configuration, because the
 * answer is an audit-policy question rather than a statutory one, and
 * because an establishment whose auditor accepts declarations for
 * conveyance below a threshold is not doing anything wrong.
 *
 * 🔴 THE DEFAULT EXCLUDES `self_declaration`. "I spent it" is the
 * employee asserting the very fact the exemption depends on. Accepting
 * it by default would reintroduce the tickbox this module exists to
 * remove — with the added harm that the payslip would then CALL it
 * evidenced.
 */
export interface EvidencePolicy {
  readonly acceptSelfDeclaration: boolean;
  /**
   * ⚠️ A document dated after the claim's `incurredOn` is normal (an
   * invoice raised later). A document dated BEFORE the expense is not
   * evidence of it. Zero disables the check.
   */
  readonly maxDaysDocumentPrecedesExpense: number;
}

export const EVIDENCE_POLICY_DEFAULT: EvidencePolicy = Object.freeze({
  acceptSelfDeclaration: false,
  maxDaysDocumentPrecedesExpense: 0,
});

/* ================================================================== */
/* ② THE CLAIM                                                         */
/* ================================================================== */

export type ReimbursementCategory =
  | "travel"
  | "conveyance"
  | "telephone_or_internet"
  | "medical"
  | "books_and_periodicals"
  | "relocation"
  | "professional_development"
  | "other";

export interface ReimbursementClaim {
  readonly category: ReimbursementCategory;
  /** In the words the employee will read on the payslip. */
  readonly description: string;
  /** Paise. What the employee is asking to be given back. */
  readonly claimedMinor: string;
  /** ISO date the money left the employee's pocket. */
  readonly incurredOn: string;
  readonly evidence: readonly EvidenceDocument[];
  /**
   * 🔴 THE SECOND CONDITION, AND IT IS INDEPENDENT OF THE BILL. A
   * genuine, fully-billed dinner that was not for the employer is not a
   * reimbursement however good the receipt is. s.10(14)(i) requires the
   * expense to be incurred "in the performance of the duties of an
   * office"; the employer asserts this and the assertion is recorded.
   */
  readonly incurredForEmployer: boolean;
  /**
   * ⚠️ Whether the same expense is also being claimed from a client, an
   * insurer or a government scheme. A double recovery is income twice
   * over and the second one is never on anybody's payslip.
   */
  readonly recoveredElsewhereMinor?: string | null;
}

/* ================================================================== */
/* ③ THE ASSESSMENT                                                    */
/* ================================================================== */

export type ReimbursementTreatment =
  /** Not wages, not income. Outside PF, ESI, PT and s.192 entirely. */
  | "reimbursement_not_wages"
  /** Wholly an allowance. Salary income, taxable, on the payslip as pay. */
  | "taxable_allowance"
  /** Part evidenced, part not. Both figures are on the result. */
  | "part_reimbursement_part_allowance";

/**
 * ⭐ "notDecided" IS A VALUE AND NOT A GAP IN THE TYPE. A caller that
 * forgets to handle it gets a type error rather than a default of
 * `false`, which is the direction that under-deducts PF.
 */
export type ContributionApplicability = "no" | "notDecided";

export interface ReimbursementAssessment {
  readonly treatment: ReimbursementTreatment;
  readonly claimedMinor: Paise;
  /** Paise proven by acceptable documents, capped at the claim. */
  readonly evidencedMinor: Paise;
  /** 🔴 The part with no document behind it. */
  readonly unevidencedMinor: Paise;
  /** Paise that are NOT wages: outside PF, ESI, PT and s.192. */
  readonly notWagesMinor: Paise;
  /** 🔴 Paise that ARE salary income and must be taxed as such. */
  readonly taxableAllowanceMinor: Paise;
  /**
   * ⚠️ Applies ONLY to `taxableAllowanceMinor`. The evidenced part is
   * `"no"` by construction — a repayment of expenditure is not
   * remuneration and there is nothing for s.2(b) to reach.
   */
  readonly pfOnAllowance: ContributionApplicability;
  readonly esiOnAllowance: ContributionApplicability;
  /** 🔴 Income tax is not COMPUTED here. See the file header. */
  readonly incomeTaxTreatment: "taxable_as_salary" | "not_income";
  readonly notes: readonly string[];
  readonly problems: readonly string[];
}

const rupees = (p: Paise): string => `₹${(p / 100n).toLocaleString("en-IN")}`;

/** ⭐ Whole days between two ISO dates. Pure; no clock is consulted. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * ⭐ WHETHER ONE DOCUMENT PROVES EXPENDITURE. Separated out so the
 * reason a document was rejected can be printed next to it.
 */
export function evidenceCounts(
  doc: EvidenceDocument,
  claim: ReimbursementClaim,
  policy: EvidencePolicy,
): { readonly counts: boolean; readonly reason: string } {
  if (doc.kind === "self_declaration" && !policy.acceptSelfDeclaration) {
    return {
      counts: false,
      reason:
        "A self-declaration asserts the very expenditure the exemption depends on. It is recorded but it does not evidence the claim.",
    };
  }
  const amount = BigInt(doc.amountMinor);
  if (amount <= 0n) {
    return { counts: false, reason: "The document shows no amount." };
  }
  if (policy.maxDaysDocumentPrecedesExpense >= 0) {
    const precedes = daysBetween(doc.documentDate, claim.incurredOn);
    if (precedes > policy.maxDaysDocumentPrecedesExpense) {
      return {
        counts: false,
        reason: `The document is dated ${precedes} days BEFORE the expense it is offered for. A document cannot evidence a payment that had not happened when it was written.`,
      };
    }
  }
  return { counts: true, reason: "" };
}

/**
 * ⭐⭐ THE ONE CALL A REIMBURSEMENT SCREEN AND THE PAYSLIP BOTH MAKE.
 *
 * 🔴 IT NEVER THROWS AND IT NEVER REFUSES. A claim always resolves to a
 * payable amount; what changes is HOW MUCH OF IT IS TAXED. See the
 * header for why refusing would be the worse outcome.
 */
export function assessReimbursement(
  claim: ReimbursementClaim,
  policy: EvidencePolicy = EVIDENCE_POLICY_DEFAULT,
): ReimbursementAssessment {
  const notes: string[] = [];
  const problems: string[] = [];

  const claimed = BigInt(claim.claimedMinor);
  if (claimed < 0n) {
    problems.push("A negative reimbursement is a recovery. State it as one so that s.7(3) of the Payment of Wages Act, 1936 can be applied to it.");
  }
  const claimedSafe = claimed > 0n ? claimed : 0n;

  /* ---- ① Add up only the documents that actually prove something --- */
  let proven = 0n;
  for (const doc of claim.evidence) {
    const verdict = evidenceCounts(doc, claim, policy);
    if (verdict.counts) {
      proven += BigInt(doc.amountMinor);
    } else {
      notes.push(`${doc.kind} ${doc.reference}: ${verdict.reason}`);
    }
  }

  /* ---- ② Money already recovered from somebody else ---------------- */
  // 🔴 A cost recovered from a client and again from the employer is not
  // an expense at all for the second payer; the second payment is a
  // benefit. Netted off the PROVEN side, not off the claim, so the
  // difference lands in the taxable column rather than vanishing.
  const elsewhere =
    claim.recoveredElsewhereMinor === null || claim.recoveredElsewhereMinor === undefined
      ? 0n
      : BigInt(claim.recoveredElsewhereMinor);
  if (elsewhere > 0n) {
    proven = proven - elsewhere;
    notes.push(
      `${rupees(elsewhere)} of this expense has already been recovered elsewhere and is not evidenced expenditure of the employee for this employer.`,
    );
  }
  if (proven < 0n) proven = 0n;

  /* ---- ③ Evidence never proves MORE than was claimed ---------------- */
  // ⚠️ A ₹6,000 bill against a ₹4,000 claim evidences ₹4,000. Letting the
  // surplus carry would let one large bill launder a later claim.
  const evidenced = proven > claimedSafe ? claimedSafe : proven;
  const unevidenced = claimedSafe - evidenced;

  /* ---- ④ The duty test, which no bill can satisfy ------------------- */
  // 🔴 If the expense was not incurred for the employer, the documents
  // are irrelevant: the employer is paying for the employee's own
  // spending, which is a perquisite in substance.
  const forEmployer = claim.incurredForEmployer === true;
  const notWages = forEmployer ? evidenced : 0n;
  const taxable = claimedSafe - notWages;

  if (!forEmployer && claimedSafe > 0n) {
    notes.push(
      "The employer has not certified that this expense was incurred in the performance of the employee's duties, so no part of it is a reimbursement. s.10(14)(i) of the Income-tax Act, 1961 exempts a special allowance only to the extent the expense was actually incurred FOR THAT PURPOSE.",
    );
  }

  if (unevidenced > 0n && forEmployer) {
    notes.push(
      `${rupees(unevidenced)} of this claim has no acceptable document behind it and is therefore an ALLOWANCE, not a reimbursement. It is salary income under s.17(1)(iv) of the Income-tax Act, 1961 and is taxed as such. Attach the bill and reassess if one exists.`,
    );
  }

  const treatment: ReimbursementTreatment =
    taxable === 0n && claimedSafe > 0n
      ? "reimbursement_not_wages"
      : notWages === 0n
        ? "taxable_allowance"
        : "part_reimbursement_part_allowance";

  /* ---- ⑤ PF and ESI on the allowance part: NOT DECIDED -------------- */
  // 🔴 SEE THE FILE HEADER ①. Ordence will not answer this, and a stated
  // "not decided" that appears on the screen is worth more than a
  // confident flag that is wrong for this establishment.
  const contribution: ContributionApplicability = taxable > 0n ? "notDecided" : "no";
  if (taxable > 0n) {
    notes.push(
      "⚠️ Whether provident fund and ESI are payable on the allowance portion is NOT decided here. It turns on whether the sum is 'basic wages' under s.2(b) of the Employees' Provident Funds and Miscellaneous Provisions Act, 1952 and 'wages' under s.2(22) of the Employees' State Insurance Act, 1948, which the Supreme Court's 2019 decision on universally-paid allowances left establishment-specific. A CA must confirm it for this component before the payslip is issued.",
    );
  }

  notes.push(
    "⚠️ Category exemption ceilings are not applied. Limits on uniform, books and periodicals, and telephone allowances differ between the two tax regimes and move with the Finance Act; they belong on the employee's tax computation and not on the claim.",
  );

  return {
    treatment,
    claimedMinor: claimedSafe,
    evidencedMinor: evidenced,
    unevidencedMinor: unevidenced,
    notWagesMinor: notWages,
    taxableAllowanceMinor: taxable,
    pfOnAllowance: contribution,
    esiOnAllowance: contribution,
    incomeTaxTreatment: taxable > 0n ? "taxable_as_salary" : "not_income",
    notes,
    problems,
  };
}

/**
 * ⭐ THE SNAPSHOT, FOR THE SAME REASON AS `settlementSnapshot`.
 *
 * ⚠️ An assessment is challenged at assessment time, years later, when
 * the evidence policy may have changed. The POLICY goes in beside the
 * documents so the row explains itself.
 */
export function reimbursementSnapshot(
  claim: ReimbursementClaim,
  policy: EvidencePolicy,
  assessment: ReimbursementAssessment,
): { readonly inputs: unknown; readonly computed: unknown } {
  return {
    inputs: { claim, policy },
    computed: {
      treatment: assessment.treatment,
      claimedMinor: assessment.claimedMinor.toString(),
      evidencedMinor: assessment.evidencedMinor.toString(),
      unevidencedMinor: assessment.unevidencedMinor.toString(),
      notWagesMinor: assessment.notWagesMinor.toString(),
      taxableAllowanceMinor: assessment.taxableAllowanceMinor.toString(),
      pfOnAllowance: assessment.pfOnAllowance,
      esiOnAllowance: assessment.esiOnAllowance,
      incomeTaxTreatment: assessment.incomeTaxTreatment,
      notes: assessment.notes,
      problems: assessment.problems,
    },
  };
}
