/**
 * Ordence — ⭐⭐⭐ FORM 16 PART B, AND ONLY PART B
 * Version: v1.52.0-alpha
 *
 * Pure. No database, no network, no clock, no `server-only`. Every date
 * is an argument. Every rate arrives from an effective-dated row.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ONE THING TO UNDERSTAND BEFORE READING ANY OF THE ARITHMETIC
 * ══════════════════════════════════════════════════════════════════════
 * FORM 16 HAS TWO PARTS AND AN EMPLOYER MAY LAWFULLY PRODUCE ONLY ONE.
 *
 *   PART A — TAN, PAN, the quarterly summary of tax DEDUCTED AND
 *            DEPOSITED, and the challan identification for each deposit.
 *            🔴 Rule 31(1)(a) of the Income-tax Rules, 1962 read with
 *            CBDT Notification 11/2013: Part A is GENERATED AND
 *            DIGITALLY SIGNED BY TRACES. It is downloaded after the
 *            quarterly Form 24Q statement has been filed and processed.
 *            An employer who types their own Part A has produced a
 *            document that is NOT a valid Form 16.
 *
 *   PART B — the annexure. Salary breakup under s.17, exemptions under
 *            s.10, deductions under s.16 and Chapter VI-A, total income,
 *            tax on total income. ⭐ THIS the employer prepares.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ SO THIS FILE BUILDS PART B AND DELIBERATELY REFUSES TO BUILD PART A
 * ══════════════════════════════════════════════════════════════════════
 * What it builds for Part A is the INPUTS: the quarterly deducted and
 * deposited figures and the challan references, so the employer can hold
 * them next to the TRACES download and see whether they agree BEFORE
 * handing the certificate to the employee.
 *
 * 🔴 THE FAILURE THIS PREVENTS IS SPECIFIC AND IT LANDS ON TWO PEOPLE.
 * An employee who receives a self-printed "complete Form 16" files their
 * return with credit that Form 26AS does not show, and the demand
 * arrives eighteen months later. A small employer who believes issuing
 * that document discharged their obligation under s.203 has in fact
 * discharged nothing, and discovers it at a TDS survey. A tool that says
 * "Part B is ready — download Part A from TRACES and staple them" is
 * correct and useful. One that quietly emits both is worse than nothing.
 *
 * ⭐ THE SAME POSITION `lib/tds/certificates.ts` TAKES FOR FORM 16A, for
 * the same reason and under the neighbouring sub-rule (Rule 31(3)). This
 * file is deliberately its salary-side twin.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE REFUSES TO GUESS, NAMED
 * ══════════════════════════════════════════════════════════════════════
 * ① SURCHARGE AND MARGINAL RELIEF. Refused outright — see
 *    `SURCHARGE_IS_REFUSED` below. Not approximated, not omitted
 *    silently. The certificate is not issued at all.
 * ② PERQUISITE VALUATION under Rule 3. Accepted as an input, never
 *    derived. Ordence does not know the employee's rent-free
 *    accommodation, car or ESOP position.
 * ③ THE CHAPTER VI-A QUALIFYING AMOUNT for any section for which no cap
 *    is configured. Taken as declared and flagged for a CA.
 * ④ WHICH s.10 EXEMPTIONS SURVIVE UNDER THE CONCESSIONAL REGIME. It is
 *    configuration (`exemptionCodesAllowed`), not a literal in code.
 */

import type { TdsQuarter } from "@/db/schema/tds";
import { quarterOf, quarterRange } from "@/lib/tds/calendar";
import {
  pickEffective,
  type EffectiveDated,
  type Paise,
  type TaxRules,
  type TaxSlab,
} from "./statutory";

/* ================================================================== */
/* ⓪ THE CONSTANT THAT IS ACTUALLY A POLICY                            */
/* ================================================================== */

/**
 * 🔴 READ BY THE UI AND BY THE TESTS. Part A is not produced here and
 * the sentence that says so is generated from one place so it cannot
 * drift out of the screen, the PDF and the code at the same time.
 */
export const PART_A_MUST_COME_FROM_TRACES =
  "Part A of Form 16 is generated and digitally signed by TRACES and must be downloaded from there after the Form 24Q statement for each quarter has been filed and processed. Ordence does not produce Part A. Rule 31(1)(a), Income-tax Rules 1962.";

/**
 * 🔴 SURCHARGE IS NOT COMPUTED, AND THE CERTIFICATE IS NOT ISSUED WHEN
 * IT APPLIES.
 *
 * ⚠️ Surcharge under the First Schedule to the Finance Act is a band on
 * TOTAL INCOME with MARGINAL RELIEF: the additional tax plus surcharge
 * may not exceed the income in excess of the threshold. Getting the
 * relief slightly wrong produces a figure that looks entirely plausible
 * and is wrong by lakhs — and the employee cannot tell. Under the
 * concessional regime the top band is capped differently again, and the
 * capital-gains carve-outs change which components attract which band.
 *
 * ⭐ SO WE REFUSE, LOUDLY, WITH THE INCOME AND THE THRESHOLD PRINTED.
 * A refusal that explains itself beats a guess that looks finished.
 * A CA must confirm the surcharge band and the marginal relief before
 * this certificate can be issued.
 */
export const SURCHARGE_IS_REFUSED =
  "This employee's total income is in surcharge territory. Ordence does not compute surcharge or marginal relief under the First Schedule to the Finance Act, so it will not issue a Part B that would understate the tax. Have your chartered accountant compute the surcharge and marginal relief, then record the tax figure as an override.";

/* ================================================================== */
/* ① MONEY AND THE TWO STATUTORY ROUNDINGS                             */
/* ================================================================== */

/** 🔴 Ten rupees, in paise. s.288A and s.288B both round to this unit. */
const TEN_RUPEES: Paise = 1_000n;

/**
 * ⭐⭐ s.288A / s.288B — ROUNDING TO THE NEAREST TEN RUPEES.
 *
 * s.288A: the TOTAL INCOME is rounded off to the nearest multiple of ten
 * rupees before tax is computed on it.
 * s.288B: the amount of TAX PAYABLE (and refundable) is rounded off to
 * the nearest multiple of ten rupees.
 *
 * ⚠️ BOTH round half AWAY FROM ZERO. `Math.round` rounds half toward
 * POSITIVE INFINITY, so `Math.round(-2.5)` is `-2`. On a refund or an
 * excess-deduction adjustment that is a ten-rupee error in the wrong
 * direction, and it is the sort of thing nobody notices because the
 * number is small and looks right. This is one of two reasons the
 * function takes and returns `bigint`.
 *
 * ⚠️ THE OTHER REASON IS PRECISION. Above 2^53 paise a `number` cannot
 * represent consecutive integers, so the remainder that decides the
 * direction of the rounding is itself wrong. `bigint` has no such point.
 *
 * ⚠️ THE MONTHLY PROJECTION DOES NOT DO THIS. `projectMonthlyTds` floors
 * to the rupee and rounds tax to the rupee, because a monthly withholding
 * is an estimate under s.192(1) and not an assessment. The annual
 * certificate is the assessment, and the two therefore differ by design.
 * ⭐ That difference is a NAMED cause in the reconciliation below rather
 * than something smoothed over — see `RECONCILIATION_ROUNDING`.
 */
export function roundToNearestTenRupees(minor: Paise): Paise {
  const whole = minor / TEN_RUPEES;
  const remainder = minor % TEN_RUPEES;
  const half = TEN_RUPEES / 2n;
  if (remainder >= half) return (whole + 1n) * TEN_RUPEES;
  if (remainder <= -half) return (whole - 1n) * TEN_RUPEES;
  return whole * TEN_RUPEES;
}

/** Multiply before divide, always. Basis points, never a float rate. */
function applyBp(amount: Paise, basisPoints: number): Paise {
  return (amount * BigInt(Math.round(basisPoints))) / 10_000n;
}

function positive(value: Paise): Paise {
  return value > 0n ? value : 0n;
}

function minOf(a: Paise, b: Paise): Paise {
  return a < b ? a : b;
}

/* ================================================================== */
/* ② THE FINANCIAL YEAR                                                */
/* ================================================================== */

/**
 * ⚠️ THE CERTIFICATE IS FOR THE FINANCIAL YEAR, 1 APRIL TO 31 MARCH, and
 * never for a calendar year. The quarters are the FY's own quarters —
 * `lib/tds/calendar.ts` already owns that arithmetic and this file
 * imports it rather than restating it, because two modules that each
 * decide when Q4 begins is two modules that can disagree, and the one
 * that disagrees is never the one being read.
 */
export const FORM16_QUARTERS: readonly TdsQuarter[] = ["Q1", "Q2", "Q3", "Q4"];

/** `"2025-26"` → `{ from: "2025-04-01", to: "2026-03-31" }`. */
export function financialYearRange(financialYear: string): {
  readonly from: string;
  readonly to: string;
} {
  const startYear = Number(financialYear.slice(0, 4));
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}

/* ================================================================== */
/* ③ THE REGIME ELECTION — STORED, NEVER INFERRED                      */
/* ================================================================== */

export type TaxRegime = "new" | "old";

/**
 * 🔴🔴 WHICH REGIME APPLIES IS AN ELECTION, IT IS PER EMPLOYEE AND PER
 * YEAR, AND IT MUST BE STORED.
 *
 * s.115BAC(6): a person having income from salary may exercise the
 * option for each previous year, and the concessional regime is the
 * DEFAULT unless the option to be taxed under the old provisions is
 * exercised. The default changed with the Finance Act 2023 — before it,
 * the old regime was the default. So "what the employee chose" cannot be
 * reconstructed from anything the system knows; it can only be recorded.
 *
 * ⚠️ `employees.tax_regime` is a SINGLE CURRENT VALUE. It is the right
 * thing to project this month's withholding from, and the wrong thing to
 * build a certificate from, because a Form 16 for 2024-25 regenerated in
 * 2026 would silently pick up the employee's 2026 election and restate a
 * year that was closed. That is the exact class of defect
 * `lib/registers/document.ts` was written to prevent: same title, same
 * employee, different figures, nothing on the face saying so.
 *
 * ⭐ SO THE ELECTION IS FY-KEYED AND LIVES IN
 * `employees.tax_regime_elections` (migration 0095). One row per FY, with
 * the date the employee declared it. When the FY has no election this
 * module REFUSES rather than falling back to the current flag.
 */
export interface RegimeElection {
  /** `"2025-26"`. */
  readonly financialYear: string;
  readonly regime: TaxRegime;
  /** The civil date the employee's declaration was signed/received. */
  readonly declaredOn: string;
  /** Free text: who recorded it. Null when the record predates capture. */
  readonly recordedBy: string | null;
}

/**
 * ⭐ A TOTAL PARSER. The column is `jsonb` and the database stores bytes;
 * meaning lives here. Any shape, any depth, any junk resolves to a list —
 * possibly empty — and never throws. An unparseable entry is DROPPED
 * rather than defaulted, so it surfaces as "no election recorded", which
 * is a refusal, rather than as a wrong regime, which is a wrong tax.
 */
export function parseRegimeElections(raw: unknown): readonly RegimeElection[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: RegimeElection[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const regime = entry["regime"];
    if (regime !== "new" && regime !== "old") continue;
    const declaredOn = entry["declaredOn"];
    if (typeof declaredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(declaredOn)) continue;
    const recordedBy = entry["recordedBy"];
    out.push({
      financialYear: key,
      regime,
      declaredOn,
      recordedBy: typeof recordedBy === "string" && recordedBy.length > 0 ? recordedBy : null,
    });
  }
  return out.sort((a, b) => a.financialYear.localeCompare(b.financialYear));
}

/** The election for one FY, or `null`. ⚠️ Never falls back to another year. */
export function electionFor(
  elections: readonly RegimeElection[],
  financialYear: string,
): RegimeElection | null {
  return elections.find((e) => e.financialYear === financialYear) ?? null;
}

/* ================================================================== */
/* ④ THE RULES, WHICH ARE DATA                                         */
/* ================================================================== */

/**
 * 🔴 NOT ONE SLAB, LIMIT OR RATE IS WRITTEN IN THIS FILE.
 *
 * `Form16Rules` extends the `TaxRules` the monthly projection already
 * loads from `statutory_rates` (kind `income_tax`, scope `new`/`old`), so
 * the certificate and the payslip read the SAME effective-dated row and
 * cannot disagree about the standard deduction. The extra members below
 * are the ones only an annual computation needs.
 *
 * ⚠️ THE STANDARD DEDUCTION, THE 87A REBATE LIMIT, THE CESS RATE AND THE
 * SURCHARGE THRESHOLD HAVE ALL MOVED IN THE LAST FIVE FINANCE ACTS and
 * will move again. A slab compiled into this file is a bug with a delay
 * fuse: it does not fail on deploy, it fails the following February, on
 * every certificate at once, after they have been issued.
 */
export interface Form16Rules extends TaxRules {
  /**
   * ⭐ WHICH s.10 EXEMPTION CODES SURVIVE UNDER THIS REGIME.
   * `"all"` means the row does not restrict them (the old regime).
   * A list means only those codes are allowed and every other declared
   * exemption is disallowed ON THE FACE OF THE CERTIFICATE with a line
   * saying so, rather than dropped.
   *
   * ⚠️ NEEDS A CA'S CONFIRMATION PER YEAR. s.115BAC(2) withdraws most of
   * s.10 but not all of it — transport allowance for a disabled
   * employee, conveyance on official duty and s.10(10) gratuity are among
   * the survivors, and the list has been amended. Ordence will not
   * hard-code that list.
   */
  readonly exemptionCodesAllowed: "all" | readonly string[];
  /** s.16(iii) professional tax. Old regime only, today. */
  readonly allowsProfessionalTaxDeduction: boolean;
  /** s.16(ii) entertainment allowance. Government employees only. */
  readonly allowsEntertainmentAllowance: boolean;
  /** Chapter VI-A as a whole. Largely withdrawn by s.115BAC(2). */
  readonly allowsChapterViA: boolean;
  /**
   * Per-section statutory ceilings in paise, keyed by section as spelt on
   * the certificate (`"80C"`, `"80CCD(1B)"`, `"80D"`, …).
   * ⚠️ A SECTION ABSENT FROM THIS MAP IS NOT CAPPED BY ORDENCE and the
   * declared qualifying amount is taken as given, with a caveat naming
   * the section. Silently applying somebody else's ceiling to 80D — which
   * depends on the ages of the insured — would be a guess.
   */
  readonly chapterViACapsMinor: Readonly<Record<string, string>>;
}

/* ================================================================== */
/* ⑤ THE INPUTS                                                        */
/* ================================================================== */

/** A s.10 exemption as DECLARED. Never derived — Ordence does not know rent. */
export interface ExemptionClaim {
  /** `"10(13A)"`, `"10(5)"`, `"10(10)"`. Matched against the rules' list. */
  readonly code: string;
  readonly label: string;
  readonly amountMinor: Paise;
}

/** A Chapter VI-A deduction as declared, with the employer's own vetting. */
export interface ChapterViAClaim {
  /** `"80C"`, `"80D"`, `"80CCD(1B)"`, … */
  readonly section: string;
  readonly label: string;
  /** What the employee declared. */
  readonly grossAmountMinor: Paise;
  /**
   * ⭐ What the employer accepted after seeing proof. Distinct from gross
   * on purpose: Part B has both columns and an employer who prints the
   * declared figure in the deductible column has certified something they
   * did not verify.
   */
  readonly qualifyingAmountMinor: Paise;
}

/** One month's actual withholding, straight off the payslip. */
export interface PayslipTdsFact {
  readonly payslipId: string;
  /** Any civil day inside the pay period. Used only to place the quarter. */
  readonly periodEnd: string;
  readonly tdsMinor: Paise;
  /** ⚠️ True means the payslip itself said the figure was an estimate. */
  readonly isProjection: boolean;
  readonly wasOverridden: boolean;
}

/** A deposit, as recorded against a challan. Reconciliation input only. */
export interface ChallanDeposit {
  readonly challanId: string;
  readonly depositDate: string;
  readonly bsrCode: string | null;
  readonly challanSerial: string | null;
  readonly amountMinor: Paise;
}

export interface Form16Employer {
  readonly name: string;
  readonly tan: string | null;
  readonly pan: string | null;
  readonly address: string | null;
}

export interface Form16Employee {
  readonly employeeId: string;
  readonly name: string;
  readonly pan: string | null;
  readonly designation: string | null;
}

/* ================================================================== */
/* ⑥ THE OUTPUTS                                                       */
/* ================================================================== */

export type FindingSeverity = "blocking" | "warning" | "note";

export interface Form16Finding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: string;
}

/** A named line on Part B, with its section, in the order it is printed. */
export interface Form16Line {
  readonly id: string;
  readonly label: string;
  /** `"s.17(1)"`, `"s.16(ia)"`, `"Chapter VI-A"`. Printed beside the label. */
  readonly citation: string | null;
  readonly amountMinor: Paise;
  /** A line the employer claimed and the regime does not allow. */
  readonly disallowed: boolean;
  readonly note: string | null;
}

export interface Form16PartB {
  readonly financialYear: string;
  readonly assessmentYear: string;
  readonly employer: Form16Employer;
  readonly employee: Form16Employee;
  readonly election: RegimeElection;

  readonly salaryLines: readonly Form16Line[];
  readonly exemptionLines: readonly Form16Line[];
  readonly section16Lines: readonly Form16Line[];
  readonly chapterViALines: readonly Form16Line[];

  readonly grossSalaryMinor: Paise;
  readonly exemptSalaryMinor: Paise;
  readonly salaryAfterExemptionsMinor: Paise;
  readonly section16TotalMinor: Paise;
  readonly incomeChargeableUnderSalariesMinor: Paise;
  readonly otherIncomeReportedMinor: Paise;
  readonly grossTotalIncomeMinor: Paise;
  readonly chapterViATotalMinor: Paise;

  /** 🔴 AFTER s.288A rounding. This is the figure tax is computed on. */
  readonly totalIncomeMinor: Paise;
  readonly taxOnTotalIncomeMinor: Paise;
  readonly rebate87aMinor: Paise;
  readonly taxAfterRebateMinor: Paise;
  readonly cessMinor: Paise;
  /** 🔴 AFTER s.288B rounding. */
  readonly taxPayableMinor: Paise;

  /**
   * 🔴 WHAT WAS ACTUALLY WITHHELD, SUMMED FROM THE YEAR'S PAYSLIPS.
   * NEVER a recomputation. The certificate reports what was deducted.
   */
  readonly taxDeductedPerPayslipsMinor: Paise;
  /** deducted − payable. Positive is over-withheld. */
  readonly balanceMinor: Paise;

  readonly findings: readonly Form16Finding[];
}

export interface Form16PartAQuarter {
  readonly quarter: TdsQuarter;
  readonly from: string;
  readonly to: string;
  readonly deductedMinor: Paise;
  readonly depositedMinor: Paise;
  /** deducted − deposited. ⚠️ The number the TRACES call is about. */
  readonly undepositedMinor: Paise;
  readonly challans: readonly ChallanDeposit[];
}

/**
 * 🔴 NOT A CERTIFICATE, AND THE TYPE SAYS SO.
 *
 * `kind` is a literal, `isCertificate` is `false` as a TYPE and not just
 * as a value, and `mustBeDownloadedFrom` names TRACES. Anything that
 * renders this and calls it Part A is contradicted by its own data.
 */
export interface Form16PartAInputs {
  readonly kind: "part-a-reconciliation-inputs";
  readonly isCertificate: false;
  readonly mustBeDownloadedFrom: "TRACES";
  readonly statement: string;
  readonly financialYear: string;
  readonly employerTan: string | null;
  readonly quarters: readonly Form16PartAQuarter[];
  readonly totalDeductedMinor: Paise;
  readonly totalDepositedMinor: Paise;
  readonly totalUndepositedMinor: Paise;
  readonly findings: readonly Form16Finding[];
}

export interface Form16Reconciliation {
  readonly deductedPerPayslipsMinor: Paise;
  readonly annualTaxPayableMinor: Paise;
  /** deducted − payable. */
  readonly varianceMinor: Paise;
  readonly agrees: boolean;
  readonly monthsWithPayslip: number;
  readonly payslipCount: number;
  readonly projectionCount: number;
  readonly overriddenCount: number;
  /** 🔴 Never empty when `agrees` is false. */
  readonly findings: readonly Form16Finding[];
}

export interface Form16Refusal {
  readonly financialYear: string;
  readonly employeeName: string;
  readonly reason: string;
  /** Facts, not adjectives. What the employer must fix, and the figures. */
  readonly evidence: readonly string[];
  readonly findings: readonly Form16Finding[];
}

export type Form16Outcome =
  | {
      readonly issued: true;
      readonly partB: Form16PartB;
      readonly partAInputs: Form16PartAInputs;
      readonly reconciliation: Form16Reconciliation;
    }
  | { readonly issued: false; readonly refusal: Form16Refusal };

/* ================================================================== */
/* ⑦ PART A INPUTS — THE RECONCILIATION, NOT THE DOCUMENT              */
/* ================================================================== */

/**
 * ⭐ THE QUESTION THIS ANSWERS IS NOT "WHAT DOES PART A SAY". It is
 * "WILL PART A SAY WHAT OUR BOOKS SAY", asked before the employer
 * downloads it.
 *
 * 🔴 TRACES CERTIFIES WHAT WAS DEPOSITED AND MATCHED IN OLTAS, NOT WHAT
 * WAS DEDUCTED. Tax withheld from a March payslip and deposited late
 * appears on no certificate the employee can use for that year: their
 * payslips show one number, their Form 26AS shows a smaller one, and the
 * difference is real, is the employer's, and is invisible to them until
 * the return is processed. `undepositedMinor` is that difference, per
 * quarter, and it is the first thing on the screen.
 */
export function buildPartAInputs(args: {
  readonly financialYear: string;
  readonly employerTan: string | null;
  readonly payslips: readonly PayslipTdsFact[];
  readonly deposits: readonly ChallanDeposit[];
}): Form16PartAInputs {
  const findings: Form16Finding[] = [];

  const quarters: Form16PartAQuarter[] = FORM16_QUARTERS.map((quarter) => {
    const range = quarterRange(args.financialYear, quarter);
    const deducted = args.payslips
      .filter((p) => quarterOf(p.periodEnd) === quarter && withinFy(p.periodEnd, args.financialYear))
      .reduce<Paise>((sum, p) => sum + p.tdsMinor, 0n);
    const challans = args.deposits.filter(
      (d) => d.depositDate >= range.from && d.depositDate <= addOneQuarterGrace(range.to),
    );
    const deposited = challans.reduce<Paise>((sum, d) => sum + d.amountMinor, 0n);
    return {
      quarter,
      from: range.from,
      to: range.to,
      deductedMinor: deducted,
      depositedMinor: deposited,
      undepositedMinor: deducted - deposited,
      challans,
    };
  });

  const totalDeducted = quarters.reduce<Paise>((s, q) => s + q.deductedMinor, 0n);
  const totalDeposited = quarters.reduce<Paise>((s, q) => s + q.depositedMinor, 0n);

  if (args.employerTan === null || args.employerTan.trim() === "") {
    findings.push({
      code: "no_tan",
      severity: "blocking",
      message:
        "No TAN is recorded for this establishment. Part A cannot be requested from TRACES without one, and s.203A requires it to be quoted on every TDS document.",
    });
  }

  for (const q of quarters) {
    if (q.undepositedMinor > 0n) {
      findings.push({
        code: `undeposited_${q.quarter}`,
        severity: "blocking",
        message: `${q.quarter} (${q.from} to ${q.to}): ₹${rupees(q.deductedMinor)} was deducted and ₹${rupees(q.depositedMinor)} is recorded as deposited. TRACES will certify the deposited figure, so the employee's Form 26AS will be short by ₹${rupees(q.undepositedMinor)} for this quarter until the balance is paid and the 24Q correction is processed.`,
      });
    } else if (q.undepositedMinor < 0n) {
      findings.push({
        code: `overdeposited_${q.quarter}`,
        severity: "warning",
        message: `${q.quarter}: ₹${rupees(-q.undepositedMinor)} more is recorded as deposited than was deducted from this employee. That is normal when a challan covers several employees; it is reported because this view cannot tell that apart from a misallocation.`,
      });
    }
    if (q.deductedMinor > 0n && q.challans.length === 0) {
      findings.push({
        code: `no_challan_${q.quarter}`,
        severity: "blocking",
        message: `${q.quarter} has tax deducted but no challan identified. Part A carries a challan identification number for every deposit; without one there is nothing to reconcile the TRACES download against.`,
      });
    }
  }

  findings.push({
    code: "part_a_from_traces",
    severity: "note",
    message: PART_A_MUST_COME_FROM_TRACES,
  });

  return {
    kind: "part-a-reconciliation-inputs",
    isCertificate: false,
    mustBeDownloadedFrom: "TRACES",
    statement: PART_A_MUST_COME_FROM_TRACES,
    financialYear: args.financialYear,
    employerTan: args.employerTan,
    quarters,
    totalDeductedMinor: totalDeducted,
    totalDepositedMinor: totalDeposited,
    totalUndepositedMinor: totalDeducted - totalDeposited,
    findings,
  };
}

function withinFy(day: string, financialYear: string): boolean {
  const { from, to } = financialYearRange(financialYear);
  return day >= from && day <= to;
}

/**
 * ⚠️ A QUARTER'S TAX IS DEPOSITED AFTER THE QUARTER ENDS — by the 7th of
 * the following month, and for March by 30 April (Rule 30(2)). So the
 * deposits that belong to a quarter are dated up to roughly a month past
 * its close. This window is deliberately generous: attributing a deposit
 * to the wrong quarter here would invent a mismatch, and a reconciliation
 * that cries wolf is a reconciliation people stop reading.
 */
function addOneQuarterGrace(quarterEnd: string): string {
  const year = Number(quarterEnd.slice(0, 4));
  const month = Number(quarterEnd.slice(5, 7));
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-30`;
}

/* ================================================================== */
/* ⑧ THE RECONCILIATION THAT MUST NOT BE SMOOTHED                      */
/* ================================================================== */

export const RECONCILIATION_ROUNDING =
  "The monthly withholding is rounded to the rupee under s.192 and the annual liability to the nearest ten rupees under s.288B, so a difference of up to a few rupees across twelve months is expected and is not a defect.";

/**
 * 🔴🔴 THE MOST VALUABLE OUTPUT OF THIS WHOLE FEATURE.
 *
 * ⚠️ THE CERTIFICATE REPORTS WHAT WAS DEDUCTED, NOT WHAT SHOULD HAVE
 * BEEN. If the year's payslips add up to less than the annual liability,
 * the employer under-withheld and owes interest under s.201(1A); if they
 * add up to more, the employee is due a refund on assessment. Either way
 * the honest thing is to print BOTH numbers and the gap.
 *
 * 🔴 A SYSTEM THAT QUIETLY PRINTS THE RECOMPUTED FIGURE IN THE "TAX
 * DEDUCTED" BOX MAKES THE PROBLEM DISAPPEAR FROM THE ONLY DOCUMENT ON
 * WHICH IT WOULD HAVE BEEN VISIBLE — and it will not disappear from Form
 * 26AS, so the employee finds out from the department instead.
 */
export function reconcile(args: {
  readonly payslips: readonly PayslipTdsFact[];
  readonly annualTaxPayableMinor: Paise;
  readonly financialYear: string;
  /** Months the employee was on the payroll during the FY. */
  readonly expectedMonths: number;
}): Form16Reconciliation {
  const inYear = args.payslips.filter((p) => withinFy(p.periodEnd, args.financialYear));
  const deducted = inYear.reduce<Paise>((sum, p) => sum + p.tdsMinor, 0n);
  const variance = deducted - args.annualTaxPayableMinor;
  const months = new Set(inYear.map((p) => p.periodEnd.slice(0, 7))).size;
  const projections = inYear.filter((p) => p.isProjection).length;
  const overridden = inYear.filter((p) => p.wasOverridden).length;

  const findings: Form16Finding[] = [];
  const absVariance = variance < 0n ? -variance : variance;

  /**
   * ⭐ THE TOLERANCE IS TEN RUPEES AND IT IS NOT ARBITRARY. s.288B rounds
   * the annual figure to the nearest ten rupees, so agreement to the
   * rupee is not achievable even when nothing is wrong. Anything larger
   * is a real difference in the withholding, not in the rounding.
   */
  const agrees = absVariance < TEN_RUPEES;

  if (!agrees && variance < 0n) {
    findings.push({
      code: "under_withheld",
      severity: "blocking",
      message: `The year's payslips withheld ₹${rupees(deducted)} but the annual computation on this certificate is ₹${rupees(args.annualTaxPayableMinor)} — ₹${rupees(absVariance)} short. Ordence has NOT adjusted either figure. The employee will carry the shortfall as tax payable on assessment, and the employer may owe interest under s.201(1A) for the months it was under-deducted.`,
    });
  }
  if (!agrees && variance > 0n) {
    findings.push({
      code: "over_withheld",
      severity: "warning",
      message: `The year's payslips withheld ₹${rupees(deducted)} against an annual liability of ₹${rupees(args.annualTaxPayableMinor)} — ₹${rupees(absVariance)} more than the computation. Ordence has NOT adjusted either figure. The employee claims the excess as a refund; check whether a declaration arrived after the withholding was set.`,
    });
  }
  if (agrees && absVariance > 0n) {
    findings.push({
      code: "rounding_only",
      severity: "note",
      message: `${RECONCILIATION_ROUNDING} The difference here is ₹${rupees(absVariance)}.`,
    });
  }
  if (months < args.expectedMonths) {
    findings.push({
      code: "missing_months",
      severity: "blocking",
      message: `Payslips were found for ${months} month${months === 1 ? "" : "s"} of an expected ${args.expectedMonths}. A certificate built from an incomplete year understates both the salary and the tax deducted.`,
    });
  }
  if (projections > 0) {
    findings.push({
      code: "projected_months",
      severity: "warning",
      message: `${projections} of ${inYear.length} payslips carried a PROJECTED tax figure rather than a settled one. The projection is what was actually withheld and is therefore what the certificate reports, but it was an estimate at the time.`,
    });
  }
  if (overridden > 0) {
    findings.push({
      code: "overridden_months",
      severity: "note",
      message: `${overridden} payslip${overridden === 1 ? " carries" : "s carry"} an accountant's override rather than a computed figure. That is expected where a computation was done outside Ordence; it is named so the difference above is not mistaken for a defect in the engine.`,
    });
  }

  return {
    deductedPerPayslipsMinor: deducted,
    annualTaxPayableMinor: args.annualTaxPayableMinor,
    varianceMinor: variance,
    agrees,
    monthsWithPayslip: months,
    payslipCount: inYear.length,
    projectionCount: projections,
    overriddenCount: overridden,
    findings,
  };
}

/* ================================================================== */
/* ⑨ PART B                                                            */
/* ================================================================== */

export interface Form16Request {
  readonly financialYear: string;
  readonly employer: Form16Employer;
  readonly employee: Form16Employee;
  /** ⚠️ Parsed from `employees.tax_regime_elections`. Never the live flag. */
  readonly elections: readonly RegimeElection[];

  /** s.17(1) salary as per the provisions of the section. */
  readonly salary17_1Minor: Paise;
  /** s.17(2) perquisites. ⚠️ VALUED ELSEWHERE — Ordence does not apply Rule 3. */
  readonly perquisites17_2Minor: Paise;
  /** s.17(3) profits in lieu of salary. */
  readonly profitsInLieu17_3Minor: Paise;

  readonly exemptions: readonly ExemptionClaim[];
  /** s.16(iii). Sum of the year's professional tax off the payslips. */
  readonly professionalTaxMinor: Paise;
  /** s.16(ii). Government employees only; zero otherwise. */
  readonly entertainmentAllowanceMinor: Paise;
  readonly chapterViA: readonly ChapterViAClaim[];
  /**
   * Other income the employee REPORTED to the employer under s.192(2B) —
   * house property loss, interest income. ⚠️ Reported, never discovered.
   */
  readonly otherIncomeReportedMinor: Paise;

  readonly payslips: readonly PayslipTdsFact[];
  readonly deposits: readonly ChallanDeposit[];
  readonly expectedMonths: number;

  /** All effective-dated rows; the engine picks. Never pre-filtered by year. */
  readonly rules: readonly Form16Rules[];
  readonly slabs: readonly TaxSlab[];
}

export function buildForm16(request: Form16Request): Form16Outcome {
  const fy = request.financialYear;
  const range = financialYearRange(fy);
  const evidence: string[] = [];
  const findings: Form16Finding[] = [];

  const refuse = (reason: string): Form16Outcome => ({
    issued: false,
    refusal: {
      financialYear: fy,
      employeeName: request.employee.name,
      reason,
      evidence,
      findings,
    },
  });

  /* ---------------------------------------------------------------- */
  /* ⓵ THE ELECTION. Refused, never inferred.                          */
  /* ---------------------------------------------------------------- */
  const election = electionFor(request.elections, fy);
  if (election === null) {
    evidence.push(
      `No regime election is recorded for ${fy}. ${request.elections.length} election${request.elections.length === 1 ? " is" : "s are"} on file${request.elections.length > 0 ? ` (${request.elections.map((e) => `${e.financialYear}: ${e.regime}`).join(", ")})` : ""}.`,
    );
    evidence.push(
      "s.115BAC(6) makes the choice a per-year option and the Finance Act 2023 reversed which one is the default, so the election for a past year cannot be reconstructed from the employee's current setting. Record the declaration the employee signed for this year.",
    );
    return refuse(
      "The tax regime for this financial year has not been recorded, and it will not be guessed. The old and the new regime produce materially different tax on the same salary.",
    );
  }

  /* ---------------------------------------------------------------- */
  /* ⓶ PAN. s.203 requires it; without it the certificate is unusable. */
  /* ---------------------------------------------------------------- */
  if (request.employee.pan === null || request.employee.pan.trim() === "") {
    evidence.push(`No PAN is recorded for ${request.employee.name}.`);
    return refuse(
      "Form 16 quotes the employee's PAN. Without it TRACES cannot issue Part A, the credit cannot reach the employee's 26AS, and s.206AA would have required deduction at 20%.",
    );
  }

  /* ---------------------------------------------------------------- */
  /* ⓷ THE RULES IN FORCE FOR THIS YEAR                                */
  /* ---------------------------------------------------------------- */
  const forRegime = request.rules.filter((r) => r.regime === election.regime);
  const atStart = pickEffective(forRegime, range.from);
  const atEnd = pickEffective(forRegime, range.to);

  if (atStart === null || atEnd === null) {
    evidence.push(
      `No income-tax rate row is configured for the ${election.regime} regime covering ${range.from} to ${range.to}.`,
    );
    return refuse(
      "The rates for this year are not configured. Ordence will not fall back to the newest row: a certificate built with next year's standard deduction is wrong in a way nobody reading it can see.",
    );
  }

  /**
   * ⚠️ TWO DIFFERENT ROWS ACROSS ONE FINANCIAL YEAR IS A CONFIGURATION
   * ERROR, NOT A CASE TO HANDLE. The Finance Act for an assessment year
   * governs the WHOLE previous year; rates do not change mid-year for
   * salary. A row that starts in the middle of a year almost always means
   * somebody dated a correction from the day they made it.
   */
  if (atStart.effectiveFrom !== atEnd.effectiveFrom) {
    evidence.push(
      `Two different rate rows cover this year: one effective from ${atStart.effectiveFrom} and another from ${atEnd.effectiveFrom}.`,
    );
    return refuse(
      "More than one income-tax rate row is in force during this financial year. The Finance Act for an assessment year applies to the whole previous year, so this is a dating error in the rate table and it would silently split the slabs across the year.",
    );
  }
  const rules: Form16Rules = atEnd;

  const yearSlabs = request.slabs
    .filter((s) => s.regime === election.regime)
    .filter((s) => s.effectiveFrom <= range.to && (s.effectiveTo === null || s.effectiveTo >= range.from))
    .sort((a, b) => (BigInt(a.fromMinor) < BigInt(b.fromMinor) ? -1 : 1));

  if (yearSlabs.length === 0) {
    evidence.push(`No slabs are configured for the ${election.regime} regime in ${fy}.`);
    return refuse("The slab table for this regime and year is empty. There is nothing to compute tax from.");
  }

  /* ---------------------------------------------------------------- */
  /* ⓸ SALARY — s.17                                                   */
  /* ---------------------------------------------------------------- */
  const salaryLines: Form16Line[] = [
    line("s17_1", "Salary as per section 17(1)", "s.17(1)", request.salary17_1Minor),
    line("s17_2", "Value of perquisites under section 17(2)", "s.17(2)", request.perquisites17_2Minor),
    line("s17_3", "Profits in lieu of salary under section 17(3)", "s.17(3)", request.profitsInLieu17_3Minor),
  ];
  const grossSalary =
    request.salary17_1Minor + request.perquisites17_2Minor + request.profitsInLieu17_3Minor;

  if (request.perquisites17_2Minor > 0n) {
    findings.push({
      code: "perquisites_not_valued_here",
      severity: "warning",
      message:
        "The perquisite value is taken as supplied. Ordence does not apply the Rule 3 valuation rules for accommodation, motor car, ESOPs or interest-free loans, and it does not produce Form 12BA. Confirm the figure with whoever valued it.",
    });
  }

  /* ---------------------------------------------------------------- */
  /* ⓹ EXEMPTIONS — s.10, AND WHICH SURVIVE IS CONFIGURATION           */
  /* ---------------------------------------------------------------- */
  const allowed = rules.exemptionCodesAllowed;
  const exemptionLines: Form16Line[] = request.exemptions.map((e) => {
    const isAllowed = allowed === "all" || allowed.includes(e.code);
    return {
      id: `s10_${e.code}`,
      label: e.label,
      citation: `s.${e.code}`,
      amountMinor: isAllowed ? e.amountMinor : 0n,
      disallowed: !isAllowed,
      note: isAllowed
        ? null
        : `Claimed ₹${rupees(e.amountMinor)} and NOT allowed under the ${election.regime} regime for ${fy}. Printed at nil rather than removed, so the employee can see what was claimed and why it is not here.`,
    };
  });
  const exemptTotal = exemptionLines.reduce<Paise>((s, l) => s + l.amountMinor, 0n);

  /**
   * ⚠️ AN EXEMPTION CANNOT EXCEED THE SALARY IT EXEMPTS. A declaration
   * larger than the pay is a data-entry error, not a tax position.
   */
  if (exemptTotal > grossSalary) {
    evidence.push(
      `Exemptions claimed under s.10 total ₹${rupees(exemptTotal)} against a gross salary of ₹${rupees(grossSalary)}.`,
    );
    return refuse(
      "The s.10 exemptions claimed exceed the gross salary. That is an error in the declarations rather than a computation this certificate can carry.",
    );
  }
  const salaryAfterExemptions = grossSalary - exemptTotal;

  /* ---------------------------------------------------------------- */
  /* ⓺ DEDUCTIONS — s.16                                               */
  /* ---------------------------------------------------------------- */
  /**
   * ⚠️ THE STANDARD DEDUCTION IS CAPPED AT THE SALARY. An employee who
   * joined in March earns less than the standard deduction, and allowing
   * the full amount would create a negative salary head that offsets
   * other income — which s.16(ia) does not do.
   */
  const standard = minOf(BigInt(rules.standardDeductionMinor), positive(salaryAfterExemptions));
  const entertainment = rules.allowsEntertainmentAllowance
    ? request.entertainmentAllowanceMinor
    : 0n;
  const professionalTax = rules.allowsProfessionalTaxDeduction ? request.professionalTaxMinor : 0n;

  const section16Lines: Form16Line[] = [
    line("s16_ia", "Standard deduction", "s.16(ia)", standard),
    {
      id: "s16_ii",
      label: "Entertainment allowance",
      citation: "s.16(ii)",
      amountMinor: entertainment,
      disallowed: !rules.allowsEntertainmentAllowance && request.entertainmentAllowanceMinor > 0n,
      note: rules.allowsEntertainmentAllowance
        ? null
        : "s.16(ii) is available to government employees only under the rules configured for this year.",
    },
    {
      id: "s16_iii",
      label: "Tax on employment (professional tax)",
      citation: "s.16(iii)",
      amountMinor: professionalTax,
      disallowed: !rules.allowsProfessionalTaxDeduction && request.professionalTaxMinor > 0n,
      note: rules.allowsProfessionalTaxDeduction
        ? null
        : `₹${rupees(request.professionalTaxMinor)} of professional tax was paid and is not deductible under the ${election.regime} regime.`,
    },
  ];
  const section16Total = standard + entertainment + professionalTax;
  const incomeUnderSalaries = positive(salaryAfterExemptions - section16Total);
  const grossTotalIncome = incomeUnderSalaries + request.otherIncomeReportedMinor;

  /* ---------------------------------------------------------------- */
  /* ⓻ CHAPTER VI-A                                                    */
  /* ---------------------------------------------------------------- */
  const chapterViALines: Form16Line[] = request.chapterViA.map((c) => {
    if (!rules.allowsChapterViA) {
      return {
        id: `via_${c.section}`,
        label: c.label,
        citation: `s.${c.section}`,
        amountMinor: 0n,
        disallowed: true,
        note: `Declared ₹${rupees(c.grossAmountMinor)}. Chapter VI-A is not available under the ${election.regime} regime for ${fy}, so nothing is deducted. Shown so the employee can see the declaration was received.`,
      };
    }
    const capText = rules.chapterViACapsMinor[c.section];
    if (capText === undefined) {
      findings.push({
        code: `uncapped_${c.section}`,
        severity: "warning",
        message: `No statutory ceiling is configured for s.${c.section}, so ₹${rupees(c.qualifyingAmountMinor)} is taken as the employer verified it. ⚠️ Ordence will not apply a ceiling it has not been given — the s.80D limit depends on the ages of the insured and the s.80G limit on the donee. A chartered accountant should confirm this line.`,
      });
      return {
        id: `via_${c.section}`,
        label: c.label,
        citation: `s.${c.section}`,
        amountMinor: positive(c.qualifyingAmountMinor),
        disallowed: false,
        note: "No ceiling configured; amount as verified by the employer.",
      };
    }
    const cap = BigInt(capText);
    const capped = minOf(positive(c.qualifyingAmountMinor), cap);
    return {
      id: `via_${c.section}`,
      label: c.label,
      citation: `s.${c.section}`,
      amountMinor: capped,
      disallowed: false,
      note:
        capped < c.qualifyingAmountMinor
          ? `Restricted to the s.${c.section} ceiling of ₹${rupees(cap)} from ₹${rupees(c.qualifyingAmountMinor)} verified.`
          : null,
    };
  });

  const chapterViARaw = chapterViALines.reduce<Paise>((s, l) => s + l.amountMinor, 0n);
  /**
   * ⭐ s.80A(2): the aggregate of Chapter VI-A deductions may not exceed
   * the gross total income. It cannot create or increase a loss.
   */
  const chapterViATotal = minOf(chapterViARaw, positive(grossTotalIncome));
  if (chapterViATotal < chapterViARaw) {
    findings.push({
      code: "80a2_capped",
      severity: "note",
      message: `Chapter VI-A deductions of ₹${rupees(chapterViARaw)} were restricted to the gross total income of ₹${rupees(grossTotalIncome)} under s.80A(2). Deductions cannot create a loss.`,
    });
  }

  /* ---------------------------------------------------------------- */
  /* ⓼ TOTAL INCOME — s.288A                                           */
  /* ---------------------------------------------------------------- */
  const totalIncomeRaw = positive(grossTotalIncome - chapterViATotal);
  const totalIncome = roundToNearestTenRupees(totalIncomeRaw);

  /* ---------------------------------------------------------------- */
  /* ⓽ SURCHARGE — REFUSED BEFORE ANY NUMBER IS PRINTED                */
  /* ---------------------------------------------------------------- */
  if (
    rules.surchargeThresholdMinor !== null &&
    totalIncome > BigInt(rules.surchargeThresholdMinor)
  ) {
    evidence.push(
      `Total income after s.288A rounding is ₹${rupees(totalIncome)}, above the configured surcharge threshold of ₹${rupees(BigInt(rules.surchargeThresholdMinor))}.`,
    );
    evidence.push(
      "Everything up to the surcharge has been computed and is available in this refusal's working, but the certificate is not issued because the figure on it would be understated.",
    );
    findings.push({ code: "surcharge", severity: "blocking", message: SURCHARGE_IS_REFUSED });
    return refuse(SURCHARGE_IS_REFUSED);
  }

  /* ---------------------------------------------------------------- */
  /* ⓾ TAX ON TOTAL INCOME, REBATE, CESS — s.288B                      */
  /* ---------------------------------------------------------------- */
  let tax: Paise = 0n;
  for (const slab of yearSlabs) {
    const from = BigInt(slab.fromMinor);
    const to = slab.toMinor === null ? null : BigInt(slab.toMinor);
    if (totalIncome <= from) continue;
    const upper = to === null ? totalIncome : minOf(totalIncome, to);
    tax += applyBp(upper - from, slab.rateBp);
  }

  /**
   * ⭐ s.87A IS A CLIFF, NOT A TAPER. One rupee of total income over the
   * limit and the entire rebate disappears, which is why an employee just
   * above it takes home less than one just below. Computing it as a taper
   * is the commonest way to get this wrong.
   */
  const rebateLimit = BigInt(rules.rebateLimitMinor);
  const rebate =
    totalIncome <= rebateLimit ? minOf(tax, BigInt(rules.rebateMaxMinor)) : 0n;
  const taxAfterRebate = positive(tax - rebate);
  const cess = applyBp(taxAfterRebate, rules.cessRateBp);
  const taxPayable = roundToNearestTenRupees(taxAfterRebate + cess);

  /* ---------------------------------------------------------------- */
  /* ⑪ WHAT WAS ACTUALLY DEDUCTED, AND THE GAP                         */
  /* ---------------------------------------------------------------- */
  const reconciliation = reconcile({
    payslips: request.payslips,
    annualTaxPayableMinor: taxPayable,
    financialYear: fy,
    expectedMonths: request.expectedMonths,
  });

  const partAInputs = buildPartAInputs({
    financialYear: fy,
    employerTan: request.employer.tan,
    payslips: request.payslips,
    deposits: request.deposits,
  });

  findings.push(...reconciliation.findings);
  findings.push({
    code: "part_b_only",
    severity: "note",
    message: PART_A_MUST_COME_FROM_TRACES,
  });

  const partB: Form16PartB = {
    financialYear: fy,
    assessmentYear: assessmentYearOfFy(fy),
    employer: request.employer,
    employee: request.employee,
    election,
    salaryLines,
    exemptionLines,
    section16Lines,
    chapterViALines,
    grossSalaryMinor: grossSalary,
    exemptSalaryMinor: exemptTotal,
    salaryAfterExemptionsMinor: salaryAfterExemptions,
    section16TotalMinor: section16Total,
    incomeChargeableUnderSalariesMinor: incomeUnderSalaries,
    otherIncomeReportedMinor: request.otherIncomeReportedMinor,
    grossTotalIncomeMinor: grossTotalIncome,
    chapterViATotalMinor: chapterViATotal,
    totalIncomeMinor: totalIncome,
    taxOnTotalIncomeMinor: tax,
    rebate87aMinor: rebate,
    taxAfterRebateMinor: taxAfterRebate,
    cessMinor: cess,
    taxPayableMinor: taxPayable,
    // 🔴 STRAIGHT OFF THE PAYSLIPS. Never `taxPayable`.
    taxDeductedPerPayslipsMinor: reconciliation.deductedPerPayslipsMinor,
    balanceMinor: reconciliation.varianceMinor,
    findings,
  };

  return { issued: true, partB, partAInputs, reconciliation };
}

/* ================================================================== */
/* HELPERS                                                             */
/* ================================================================== */

function line(id: string, label: string, citation: string, amountMinor: Paise): Form16Line {
  return { id, label, citation, amountMinor, disallowed: false, note: null };
}

/** `"2025-26"` → `"2026-27"`. The certificate is headed by both. */
export function assessmentYearOfFy(financialYear: string): string {
  const startYear = Number(financialYear.slice(0, 4));
  return `${startYear + 1}-${String((startYear + 2) % 100).padStart(2, "0")}`;
}

/**
 * Paise → grouped rupees for a SENTENCE, not for a column.
 * ⚠️ Integer arithmetic only. `Number(paise)/100` in a message is how a
 * wrong figure ends up quoted in an email to an employee.
 */
function rupees(minor: Paise): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const digits = abs.toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  const trimmed = whole.replace(/^0+(?=\d)/, "");
  const grouped =
    trimmed.length <= 3
      ? trimmed
      : `${trimmed.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${trimmed.slice(-3)}`;
  return `${negative ? "-" : ""}${grouped}.${fraction}`;
}

/** ⚠️ Exported for the renderer so one grouping rule serves both. */
export { rupees as formatRupees };

/**
 * ⚠️ NEEDED BY `EffectiveDated` CONSUMERS THAT WANT TO NARROW A ROW SET
 * TO ONE FINANCIAL YEAR BEFORE SHOWING IT. Not used in the computation —
 * the computation calls `pickEffective` on the year's own dates.
 */
export function rowsCoveringFy<T extends EffectiveDated>(
  rows: readonly T[],
  financialYear: string,
): readonly T[] {
  const { from, to } = financialYearRange(financialYear);
  return rows.filter((r) => r.effectiveFrom <= to && (r.effectiveTo === null || r.effectiveTo >= from));
}
