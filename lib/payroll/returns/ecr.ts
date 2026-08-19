/**
 * Ordence — ⭐⭐⭐ THE EPFO ELECTRONIC CHALLAN CUM RETURN
 * Version: v1.52.0-alpha · Batch 78
 *
 * Pure. `bigint` paise in, whole rupees out. No I/O, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE THING AN EMPLOYER ACTUALLY OWES EPFO IS A FILE, NOT A NUMBER
 * ══════════════════════════════════════════════════════════════════════
 * `computePf` has known the contributions for a year. What has been
 * missing is the artefact: a `#~#` delimited text file, one line per
 * member, uploaded to the Unified Portal, which generates the TRRN and
 * the challan. Until it is uploaded and the challan is paid — by the
 * 15th of the following month, s.38 of the EPF Scheme 1952 and the same
 * date `lib/compliance/statutory-due.ts` already holds — nothing has
 * been filed, however correct the ledger is.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 NCP DAYS — THE FIELD EMPLOYERS GET WRONG
 * ══════════════════════════════════════════════════════════════════════
 * NCP is the NON-CONTRIBUTORY PERIOD: the days in the month for which no
 * wages were payable, so no contribution arose. Loss of pay, unpaid
 * leave, absence, a strike, and the un-served part of a joining or
 * leaving month.
 *
 * ⚠️ IT IS NOT "DAYS ABSENT". Paid leave is contributory and is NOT NCP.
 * Ordence gets this right for free because `chargedLopCentidays` in the
 * leave engine is already the LOSS-OF-PAY count and paid leave never
 * reaches it.
 *
 * ⭐ WHY IT MATTERS ENOUGH TO HAVE ITS OWN SECTION:
 *   • EPFO reconciles wages against NCP. A member whose EPF wages fell
 *     from ₹15,000 to ₹9,000 with NCP declared as 0 is a wage-reduction
 *     the department will ask about, and the answer "he was absent" is
 *     one the return should have given.
 *   • NCP feeds the member's CONTRIBUTORY SERVICE, which feeds the EPS
 *     pension. Over-declared NCP shortens somebody's pensionable service
 *     by a period that nobody will ever notice until they retire.
 *
 * 🔴 THE MAPPING FROM CENTIDAYS, STATED PLAINLY:
 *
 *     ncpDays = round-half-up( lopCentidays / 100 )
 *
 * The portal takes an INTEGER. Ordence holds hundredths of a day because
 * half-day loss of pay is ordinary. Something has to give, and every
 * choice is defensible:
 *   • FLOOR favours the member's service record and under-declares the
 *     non-contributory period;
 *   • CEIL is the conservative declaration and shortens their service;
 *   • NEAREST is closest to the truth in aggregate and is what is
 *     encoded, as `rounding` on the field in `layout.ts` — DATA, so a
 *     CA who disagrees changes a row rather than this function.
 *
 * ⚠️ AND EVERY ROUNDED MEMBER IS NAMED ON THE FILE. A file that silently
 * turns 1.5 days into 2 is the exact class of defect this batch exists
 * to stop: correct-looking, accepted, and different from the payslip the
 * employee is holding.
 */

import type { PfRules } from "@/lib/payroll/statutory";
import {
  daysFromCentidays,
  ecrLayoutFor,
  isWholeRupee,
  rupeesFromPaise,
  type EcrLayout,
  type RupeeRounding,
  type DayRounding,
} from "./layout";
import {
  blocking,
  containsDelimiter,
  hasBlocking,
  joinLines,
  refuse,
  sanitiseText,
  warn,
  type ReturnFinding,
  type StatutoryReturnOutcome,
} from "./validate";

/* ------------------------------------------------------------------ */
/* WHAT A MEMBER LINE IS BUILT FROM                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EVERY FIGURE IS TAKEN FROM THE FROZEN PAYSLIP, NOT RECOMPUTED.
 *
 * 🔴 THE RETURN MUST AGREE WITH WHAT WAS PAID. Recomputing from today's
 * rates would produce a return that is arithmetically lovely and
 * disagrees with the bank transfer, the payslip and the ledger — and the
 * return is the one the department believes.
 */
export interface EcrMemberFacts {
  readonly employeeId: string;
  readonly employeeCode: string;
  /** ⚠️ The name as it stands in the UAN repository. Frozen on the payslip. */
  readonly memberName: string;
  readonly uan: string | null;

  readonly daysInMonth: number;
  /** Hundredths of a day of LOSS OF PAY. Paid leave is not in here. */
  readonly lopCentidays: number;

  readonly grossMinor: bigint;
  readonly pfWagesMinor: bigint;
  readonly employeePfMinor: bigint;
  /** ⚠️ Already the employer share MINUS pension. See `computePf`. */
  readonly employerPfMinor: bigint;
  readonly employerPensionMinor: bigint;

  /** Scheme advances are not modelled; the caller supplies nil explicitly. */
  readonly refundOfAdvancesMinor: bigint;
  readonly pfExempt: boolean;
}

export interface EcrLine {
  readonly employeeCode: string;
  readonly memberName: string;
  readonly uan: string;
  readonly grossWagesRupees: bigint;
  readonly epfWagesRupees: bigint;
  readonly epsWagesRupees: bigint;
  readonly edliWagesRupees: bigint;
  readonly employeeShareRupees: bigint;
  readonly pensionShareRupees: bigint;
  readonly employerDifferenceRupees: bigint;
  readonly ncpDays: number;
  readonly refundRupees: bigint;
}

/* ------------------------------------------------------------------ */
/* THE WAGE BASES                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EPS AND EDLI WAGES ARE DERIVED, AND THE DERIVATION IS EVIDENCE-LED.
 *
 * ⚠️ EPS WAGES ARE NOT "EPF WAGES CAPPED". A member who joined after
 * 1 September 2014 above the ceiling is NOT in the pension scheme at all,
 * and their EPS wages are zero while their EPF wages are ₹15,000.
 * Guessing from the ceiling alone would put every such member into EPS.
 *
 * 🔴 SO THE TEST IS WHETHER A PENSION CONTRIBUTION WAS ACTUALLY MADE.
 * That is a fact on the payslip, not an inference about the member's
 * joining date, and it cannot disagree with the money that moved.
 */
export function pensionableWagesFor(
  facts: Pick<EcrMemberFacts, "pfWagesMinor" | "employerPensionMinor">,
  rules: PfRules,
): bigint {
  if (facts.employerPensionMinor === 0n) return 0n;
  const cap = BigInt(rules.pensionCeilingMinor);
  return facts.pfWagesMinor < cap ? facts.pfWagesMinor : cap;
}

/**
 * ⚠️ EDLI IS CAPPED ON THE SAME BASE (EDLI Scheme 1976, para 7 read with
 * the notified ceiling), and `computePf` charges it on exactly that
 * base — so the return's EDLI wages must be that base and not EPF wages.
 * Where a member is outside EPS but inside EPF, EDLI still applies, so
 * this deliberately does NOT reuse the pension zero-test.
 */
export function edliWagesFor(
  facts: Pick<EcrMemberFacts, "pfWagesMinor">,
  rules: PfRules,
): bigint {
  const cap = BigInt(rules.pensionCeilingMinor);
  return facts.pfWagesMinor < cap ? facts.pfWagesMinor : cap;
}

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

const UAN_PATTERN = /^\d{12}$/;

/**
 * 🔴 A MEMBER WITH NO UAN CANNOT BE FILED, AND THE ANSWER IS A NAME.
 *
 * ⚠️ THE TEMPTING ALTERNATIVES ARE ALL WORSE:
 *   • a blank field — the portal rejects the whole file and names a
 *     record number, and somebody spends an evening counting lines;
 *   • omitting the member — the challan is short, the employee's
 *     passbook has a gap, and nothing anywhere says why;
 *   • a placeholder like the TDS return's `PANNOTAVBL` — THERE IS NO
 *     SUCH THING FOR UAN. 24Q has one because the Income Tax Department
 *     defined one. Inventing the equivalent here files a made-up
 *     identifier against real money.
 *
 * ⭐ So it blocks, and the refusal says which employee, so the fix is
 * "generate Anita Rao's UAN on the portal" rather than "debug the file".
 */
export function validateEcrMember(
  facts: EcrMemberFacts,
  layout: EcrLayout,
  line: EcrLine,
  seenUans: ReadonlySet<string>,
): ReturnFinding[] {
  const who = `${facts.memberName} (${facts.employeeCode})`;
  const out: ReturnFinding[] = [];

  const uan = (facts.uan ?? "").trim();
  if (uan.length === 0) {
    out.push(
      blocking(
        "uan_missing",
        who,
        "No UAN. EPFO has no substitute value for a missing UAN, so this member cannot appear on " +
          "the ECR at all. Allot or link the UAN on the Unified Portal and regenerate.",
      ),
    );
  } else if (!UAN_PATTERN.test(uan)) {
    out.push(
      blocking(
        "uan_malformed",
        who,
        `UAN "${uan}" is not twelve digits. The portal rejects the file and names only a record number.`,
      ),
    );
  } else if (seenUans.has(uan)) {
    out.push(
      blocking(
        "uan_duplicated",
        who,
        `UAN ${uan} already appears on this return. Two lines for one member either double the ` +
          "contribution or overwrite it, and both are corrected only by a revised return.",
      ),
    );
  }

  if (sanitiseText(facts.memberName).length === 0) {
    out.push(blocking("member_name_missing", facts.employeeCode, "The member has no name on the payslip."));
  }
  if (containsDelimiter(facts.memberName, layout.delimiter)) {
    out.push(
      blocking(
        "member_name_missing",
        who,
        `The member's name contains the field delimiter ${layout.delimiter}, which would shift every ` +
          "later column of this line. Escaping it would be a guess about the portal's parser.",
      ),
    );
  }

  /* --- arithmetic that cannot be true ---------------------------- */
  for (const [label, value] of [
    ["gross wages", facts.grossMinor],
    ["EPF wages", facts.pfWagesMinor],
    ["employee share", facts.employeePfMinor],
    ["employer share", facts.employerPfMinor],
    ["pension share", facts.employerPensionMinor],
    ["refund of advances", facts.refundOfAdvancesMinor],
  ] as const) {
    if (value < 0n) {
      out.push(
        blocking("negative_amount", who, `The ${label} is negative. No ECR field may carry a negative.`),
      );
    }
  }

  if (facts.pfWagesMinor > facts.grossMinor) {
    out.push(
      blocking(
        "epf_wages_exceed_gross",
        who,
        "EPF wages exceed gross wages, which cannot happen — the contribution base is a subset of pay.",
      ),
    );
  }

  if (line.epsWagesRupees > line.epfWagesRupees) {
    out.push(
      blocking(
        "eps_wages_exceed_epf_wages",
        who,
        "EPS wages exceed EPF wages. The pension base is capped at or below the provident fund base.",
      ),
    );
  }

  if (facts.pfWagesMinor === 0n && facts.employeePfMinor > 0n) {
    out.push(
      blocking("contribution_without_wages", who, "A contribution was deducted against zero EPF wages."),
    );
  }

  /**
   * 🔴 PAISE MUST NOT DISAPPEAR INTO THE FILE.
   *
   * ⚠️ `computePf` rounds every contribution to the rupee, so a
   * contribution that is not a whole rupee did not come from the engine.
   * Converting it anyway loses up to 99 paise per member and the challan
   * then disagrees with the return by a few rupees that nobody can trace.
   */
  for (const [label, value] of [
    ["employee share", facts.employeePfMinor],
    ["pension share", facts.employerPensionMinor],
    ["employer difference", facts.employerPfMinor],
  ] as const) {
    if (!isWholeRupee(value)) {
      out.push(
        blocking(
          "paise_would_be_lost",
          who,
          `The ${label} is ${value} paise, which is not a whole rupee. The engine rounds every ` +
            "contribution to the rupee, so this figure did not come from it and the file would " +
            "silently drop the paise.",
        ),
      );
    }
  }

  /* --- NCP ------------------------------------------------------- */
  if (line.ncpDays > facts.daysInMonth) {
    out.push(
      blocking(
        "days_exceed_month",
        who,
        `NCP is ${line.ncpDays} days in a ${facts.daysInMonth}-day month. More non-contributory days ` +
          "than days is a defect in attendance, not a return that can be filed.",
      ),
    );
  }
  if (line.ncpDays < 0) {
    out.push(blocking("negative_amount", who, "NCP days is negative."));
  }

  const rounded = daysFromCentidays(facts.lopCentidays, ncpRoundingOf(layout));
  if (!rounded.exact) {
    const actual = (facts.lopCentidays / 100).toFixed(2);
    out.push(
      warn(
        "ncp_rounded",
        who,
        `Loss of pay is ${actual} days and the ECR takes whole days only, so NCP is filed as ` +
          `${rounded.days}. The payslip says ${actual}; the return says ${rounded.days}. That is ` +
          "expected, and it is stated here so nobody discovers it during an inspection.",
      ),
    );
  }
  if (facts.lopCentidays > 0 && rounded.days === 0) {
    out.push(
      warn(
        "ncp_lost_to_rounding",
        who,
        "There was loss of pay this month but it rounds to zero NCP days, so the return declares a " +
          "full contributory month against reduced wages. EPFO reconciles the two.",
      ),
    );
  }

  return out;
}

function ncpRoundingOf(layout: EcrLayout): DayRounding {
  const field = layout.fields.find((f) => f.id === "ncp_days");
  const mode = field?.rounding;
  return mode === "floor" || mode === "ceil" ? mode : "nearest";
}

function moneyRoundingOf(layout: EcrLayout, id: string): RupeeRounding {
  const field = layout.fields.find((f) => f.id === id);
  const mode = field?.rounding;
  return mode === "floor" || mode === "ceil" ? mode : "nearest";
}

/* ------------------------------------------------------------------ */
/* THE BUILD                                                           */
/* ------------------------------------------------------------------ */

export interface EcrBuildArgs {
  readonly members: readonly EcrMemberFacts[];
  /** 🔴 The rules in force for the PERIOD, not for today. */
  readonly pfRules: PfRules | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Due date and consequence, from `lib/compliance/statutory-due.ts`. */
  readonly dueOn: string;
  readonly dueAuthority: string;
  readonly ifLate: string;
  /** EPFO establishment code, for the file name only. */
  readonly establishmentCode: string | null;
}

export function buildEcr(args: EcrBuildArgs): StatutoryReturnOutcome {
  const title = "EPFO Electronic Challan cum Return (ECR)";
  const period = { periodStart: args.periodStart, periodEnd: args.periodEnd };

  const layout = ecrLayoutFor(args.periodEnd);
  if (layout === null) {
    return refuse({
      kind: "epfo_ecr",
      title,
      reason:
        `No ECR layout is configured as being in force on ${args.periodEnd}. A return cannot be ` +
        "assembled from a layout that was not effective for the period being filed.",
      findings: [
        blocking("layout_not_confirmed", "file", "No effective-dated ECR layout covers this period."),
      ],
      ...period,
    });
  }

  /**
   * 🔴 NO RULES, NO FILE. The pension and EDLI ceilings decide two of
   * the four wage columns. Assuming ₹15,000 because it is today's figure
   * would produce a file that is right this year and wrong the year the
   * ceiling moves — and right-looking in both.
   */
  if (args.pfRules === null) {
    return refuse({
      kind: "epfo_ecr",
      title,
      reason:
        `No provident fund rules are effective on ${args.periodEnd}, so the pension and EDLI wage ` +
        "ceilings are unknown. Configure the PF rates for this period and regenerate.",
      findings: [
        blocking(
          "rules_missing",
          "file",
          "PF rules are needed for the EPS and EDLI wage ceilings; they are not a constant.",
        ),
      ],
      ...period,
    });
  }
  const pfRules = args.pfRules;

  const filed = args.members.filter((m) => !m.pfExempt);
  if (filed.length === 0) {
    return refuse({
      kind: "epfo_ecr",
      title,
      reason:
        "No member on this run is covered by provident fund, so there is nothing to file. An empty " +
        "ECR is not a nil return; if you believe members are covered, check their PF exemption flags.",
      findings: [blocking("no_rows", "file", "Every employee in the period is marked PF-exempt.")],
      ...period,
    });
  }

  const grossMode = moneyRoundingOf(layout, "gross_wages");
  const epfMode = moneyRoundingOf(layout, "epf_wages");
  const epsMode = moneyRoundingOf(layout, "eps_wages");
  const edliMode = moneyRoundingOf(layout, "edli_wages");
  const contribMode = moneyRoundingOf(layout, "epf_contribution_remitted");
  const ncpMode = ncpRoundingOf(layout);

  const findings: ReturnFinding[] = [];
  const lines: EcrLine[] = [];
  const seenUans = new Set<string>();

  for (const m of filed) {
    const epsWages = pensionableWagesFor(m, pfRules);
    const edliWages = edliWagesFor(m, pfRules);

    const line: EcrLine = {
      employeeCode: m.employeeCode,
      memberName: sanitiseText(m.memberName),
      uan: (m.uan ?? "").trim(),
      grossWagesRupees: rupeesFromPaise(m.grossMinor, grossMode) ?? 0n,
      epfWagesRupees: rupeesFromPaise(m.pfWagesMinor, epfMode) ?? 0n,
      epsWagesRupees: rupeesFromPaise(epsWages, epsMode) ?? 0n,
      edliWagesRupees: rupeesFromPaise(edliWages, edliMode) ?? 0n,
      employeeShareRupees: rupeesFromPaise(m.employeePfMinor, contribMode) ?? 0n,
      pensionShareRupees: rupeesFromPaise(m.employerPensionMinor, contribMode) ?? 0n,
      employerDifferenceRupees: rupeesFromPaise(m.employerPfMinor, contribMode) ?? 0n,
      ncpDays: daysFromCentidays(m.lopCentidays, ncpMode).days,
      refundRupees: rupeesFromPaise(m.refundOfAdvancesMinor, contribMode) ?? 0n,
    };

    findings.push(...validateEcrMember(m, layout, line, seenUans));
    if (line.uan.length > 0) seenUans.add(line.uan);
    lines.push(line);
  }

  if (hasBlocking(findings)) {
    const named = findings.filter((f) => f.severity === "blocking").length;
    return refuse({
      kind: "epfo_ecr",
      title,
      reason:
        `${named} finding${named === 1 ? "" : "s"} would make this ECR wrong rather than merely ` +
        "malformed, so no file was produced. Each one names the member it belongs to. A file that " +
        "was not produced costs an hour; a well-formed file with wrong numbers is the employer's " +
        "filed position until a revised return and interest undo it.",
      findings,
      ...period,
    });
  }

  const text = joinLines(lines.map((l) => renderEcrLine(l, layout)));

  const totals = {
    grossWagesMinor: sum(filed.map((m) => m.grossMinor)),
    epfWagesMinor: sum(filed.map((m) => m.pfWagesMinor)),
    employeeShareMinor: sum(filed.map((m) => m.employeePfMinor)),
    pensionShareMinor: sum(filed.map((m) => m.employerPensionMinor)),
    employerDifferenceMinor: sum(filed.map((m) => m.employerPfMinor)),
  } as const;

  const month = args.periodEnd.slice(0, 7).replace("-", "");
  const est = (args.establishmentCode ?? "ESTABLISHMENT").replace(/[^A-Za-z0-9]/g, "");

  return {
    generated: true,
    file: {
      kind: "epfo_ecr",
      title,
      fileName: `ECR_${est}_${month}.txt`,
      text,
      lineCount: lines.length,
      layoutId: layout.id,
      layoutVersion: layout.version,
      layoutSource: layout.source,
      confirmedAgainstPortal: layout.confirmedAgainstPortal,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      dueOn: args.dueOn,
      dueAuthority: args.dueAuthority,
      ifLate: args.ifLate,
      totals,
      basis: [
        `${lines.length} members, taken from the frozen payslips of this period and not recomputed.`,
        "Contributions are exactly as computePf produced them, already rounded to the rupee.",
        `EPS wages are capped at the pension ceiling in force on ${args.periodEnd} and are zero for ` +
          "members with no pension contribution — that is read off the money, not inferred from a joining date.",
        `NCP days are loss-of-pay centidays converted to whole days, rounding ${ncpMode}.`,
      ],
      warnings: [
        layout.confirmedAgainstPortal
          ? "The field order has been confirmed against the EPFO portal."
          : "🔴 THE FIELD ORDER HAS NOT BEEN CONFIRMED AGAINST THE LIVE EPFO PORTAL. " + layout.note,
        "Refund of advances is nil for every member because Ordence does not model EPF scheme " +
          "advances. If any member repaid one this month, this file understates it.",
        "The ECR carries no administration or EDLI CHARGE columns — the portal computes those on the " +
          "challan from the wages above. Reconcile the challan against the totals on this page.",
      ],
      findings,
    },
  };
}

/**
 * ⚠️ THE RENDER IS DRIVEN BY THE LAYOUT'S FIELD ORDER, NOT BY A TEMPLATE
 * STRING. A template string is a second place the order lives, and the
 * two diverge the first time a column moves.
 */
export function renderEcrLine(line: EcrLine, layout: EcrLayout): string {
  const byId: Readonly<Record<string, string>> = {
    uan: line.uan,
    member_name: line.memberName,
    gross_wages: line.grossWagesRupees.toString(),
    epf_wages: line.epfWagesRupees.toString(),
    eps_wages: line.epsWagesRupees.toString(),
    edli_wages: line.edliWagesRupees.toString(),
    epf_contribution_remitted: line.employeeShareRupees.toString(),
    eps_contribution_remitted: line.pensionShareRupees.toString(),
    epf_eps_difference_remitted: line.employerDifferenceRupees.toString(),
    ncp_days: String(line.ncpDays),
    refund_of_advances: line.refundRupees.toString(),
  };
  return layout.fields.map((f) => byId[f.id] ?? "").join(layout.delimiter);
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}
