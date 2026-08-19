/**
 * Ordence — ⭐⭐⭐ THE ESIC MONTHLY CONTRIBUTION FILE
 * Version: v1.52.0-alpha · Batch 78
 *
 * Pure. `bigint` paise. No I/O, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE CONTRIBUTION PERIOD RULE, AND WHY IT IS THE WHOLE FILE
 * ══════════════════════════════════════════════════════════════════════
 * ESI has a wage CLIFF, not a ceiling: above the limit there is no
 * contribution at all. But s.2(9) of the ESI Act 1948 read with reg.4 of
 * the ESI (General) Regulations 1950 fixes coverage for a CONTRIBUTION
 * PERIOD, not for a month:
 *
 *     1 April – 30 September   and   1 October – 31 March
 *
 * ⭐ AN EMPLOYEE WHO CROSSES THE LIMIT MID-PERIOD STAYS COVERED UNTIL
 * THE PERIOD ENDS, and contributes on their ACTUAL wages, not on the
 * limit. They leave coverage on the first day of the NEXT contribution
 * period.
 *
 * ⚠️ WHY THIS IS NOT A ROUNDING-ERROR-CLASS BUG. Dropping somebody in
 * July because they got a rise in June ends their medical cover — and
 * the benefit periods run six months behind the contribution periods, so
 * the loss lands while they may already be in hospital. Their dependants
 * lose it too. There is no way to make it good afterwards except to pay
 * the omitted contribution with interest and hope the claim is reopened.
 *
 * 🔴 ORDENCE HAD A KNOWN HOLE HERE, WHICH THIS FILE CLOSED BY REFUSING:
 * `server/payroll/run.ts` computed every payslip with
 * `esiCoveredAtPeriodStart: false`, so a mid-period riser's payslip
 * could show nil ESI when they were in fact covered.
 *
 * ⭐ v1.52.0 (Batch 79) FIXED THE CALLER — run.ts now resolves coverage
 * from payslip history via `lib/payroll/esi-coverage.ts`, which reuses
 * `contributionPeriodRange()` and `staysCovered()` below rather than
 * keeping a second copy of the period rule.
 *
 * ⚠️ THIS MODULE STILL REFUSES, AND MUST. Payslips computed before that
 * fix are still on file, and a return is the last place the omission can
 * be caught before it reaches the register. A check that trusts the
 * thing it is checking is not a check.
 */

import type { EsiRules } from "@/lib/payroll/statutory";
import {
  daysFromCentidays,
  esicLayoutFor,
  rupeesFromPaise,
  ESIC_ZERO_DAY_REASONS,
  type EsicLayout,
  type DayRounding,
  type RupeeRounding,
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
/* THE CONTRIBUTION PERIOD                                             */
/* ------------------------------------------------------------------ */

export type EsiContributionPeriod = "apr_sep" | "oct_mar";

/** April–September and October–March. Nothing else is a period. */
export function contributionPeriodOf(month: number): EsiContributionPeriod {
  return month >= 4 && month <= 9 ? "apr_sep" : "oct_mar";
}

/**
 * ⭐ THE PERIOD AS TWO DATES, AND OCTOBER–MARCH CROSSES A YEAR.
 *
 * ⚠️ THE YEAR-CROSSING IS THE BUG WAITING TO HAPPEN. January is in the
 * period that STARTED the previous October, so a naive
 * `${year}-10-01 .. ${year}-03-31` produces a range that ends before it
 * begins and silently matches nothing — which reads exactly like "this
 * employee has no history", which reads exactly like "not covered".
 */
export function contributionPeriodRange(periodEnd: string): {
  period: EsiContributionPeriod;
  from: string;
  to: string;
} {
  const year = Number(periodEnd.slice(0, 4));
  const month = Number(periodEnd.slice(5, 7));
  const period = contributionPeriodOf(month);
  if (period === "apr_sep") {
    return { period, from: `${year}-04-01`, to: `${year}-09-30` };
  }
  const startYear = month >= 10 ? year : year - 1;
  return { period, from: `${startYear}-10-01`, to: `${startYear + 1}-03-31` };
}

/**
 * 🔴 THE CONTINUATION TEST, IN ONE PLACE.
 *
 * Covered at the start of the period ⇒ covered for the whole period,
 * whatever this month's wages are. Otherwise coverage is decided by this
 * month's wages against the limit.
 */
export function staysCovered(args: {
  readonly grossMinor: bigint;
  readonly wageLimitMinor: bigint;
  readonly coveredAtPeriodStart: boolean;
  readonly isExempt: boolean;
}): { covered: boolean; becauseOfPeriodRule: boolean } {
  if (args.isExempt) return { covered: false, becauseOfPeriodRule: false };
  const overLimit = args.grossMinor > args.wageLimitMinor;
  if (!overLimit) return { covered: true, becauseOfPeriodRule: false };
  return { covered: args.coveredAtPeriodStart, becauseOfPeriodRule: args.coveredAtPeriodStart };
}

/* ------------------------------------------------------------------ */
/* FACTS                                                               */
/* ------------------------------------------------------------------ */

export interface EsicPersonFacts {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly ipName: string;
  /** ⚠️ The ESIC insurance number. Ten digits. */
  readonly ipNumber: string | null;

  readonly daysInMonth: number;
  /** Hundredths of a day for which wages were paid or payable. */
  readonly payableCentidays: number;

  /** ESI gross for the month, as the payslip computed it. */
  readonly grossMinor: bigint;
  readonly employeeEsiMinor: bigint;
  readonly employerEsiMinor: bigint;

  /**
   * 🔴 THE HISTORICAL FACT, SUPPLIED BY THE CALLER.
   * True when this person was an insured person at the start of the
   * contribution period this month falls in. This module does not know
   * what month it is and never guesses this.
   */
  readonly coveredAtPeriodStart: boolean;
  readonly esiExempt: boolean;
  /** Required when days worked is zero. See ESIC_ZERO_DAY_REASONS. */
  readonly zeroDayReasonCode: string | null;
  readonly lastWorkingDay: string | null;
}

export interface EsicRow {
  readonly employeeCode: string;
  readonly ipNumber: string;
  readonly ipName: string;
  readonly daysWorked: number;
  readonly wagesRupees: bigint;
  readonly reasonCode: string;
  readonly lastWorkingDay: string;
}

const IP_PATTERN = /^\d{10}$/;

function dayRoundingOf(layout: EsicLayout): DayRounding {
  const mode = layout.columns.find((c) => c.id === "days_worked")?.rounding;
  return mode === "floor" || mode === "ceil" ? mode : "nearest";
}

function wageRoundingOf(layout: EsicLayout): RupeeRounding {
  const mode = layout.columns.find((c) => c.id === "total_monthly_wages")?.rounding;
  return mode === "floor" || mode === "ceil" ? mode : "nearest";
}

/**
 * ⭐ CEILING TO THE RUPEE FROM BASIS POINTS, ONE DIVISION.
 *
 * ⚠️ IT IS A DELIBERATE DUPLICATE of the private helper in
 * `statutory.ts`, because the point of this check is to reproduce the
 * PORTAL'S arithmetic from the rupee figure we are about to send, and
 * then see whether it agrees with what we are actually paying. Importing
 * the engine's own helper would make the two agree by construction and
 * the check would be theatre — this codebase has shipped one of those.
 */
function esiCeilRupeesFromBp(rupees: bigint, basisPoints: number): bigint {
  const numerator = rupees * BigInt(Math.round(basisPoints));
  const whole = numerator / 10_000n;
  return numerator % 10_000n === 0n ? whole : whole + 1n;
}

/* ------------------------------------------------------------------ */
/* THE BUILD                                                           */
/* ------------------------------------------------------------------ */

export interface EsicBuildArgs {
  readonly people: readonly EsicPersonFacts[];
  readonly esiRules: EsiRules | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly dueOn: string;
  readonly dueAuthority: string;
  readonly ifLate: string;
  /** ESIC employer code, for the file name only. */
  readonly employerCode: string | null;
}

export function buildEsicMonthly(args: EsicBuildArgs): StatutoryReturnOutcome {
  const title = "ESIC monthly contribution";
  const period = { periodStart: args.periodStart, periodEnd: args.periodEnd };

  const layout = esicLayoutFor(args.periodEnd);
  if (layout === null) {
    return refuse({
      kind: "esic_monthly",
      title,
      reason: `No ESIC layout is configured as being in force on ${args.periodEnd}.`,
      findings: [blocking("layout_not_confirmed", "file", "No effective-dated ESIC layout covers this period.")],
      ...period,
    });
  }

  /**
   * 🔴 NO RULES, NO FILE — AND HERE IT IS THE WAGE LIMIT THAT DECIDES
   * WHO IS ON THE RETURN AT ALL. Assuming ₹21,000 would file the right
   * people today and the wrong people the year it moves, with no symptom.
   */
  if (args.esiRules === null) {
    return refuse({
      kind: "esic_monthly",
      title,
      reason:
        `No ESI rules are effective on ${args.periodEnd}, so the wage limit that decides coverage is ` +
        "unknown. Configure the ESI rates for this period and regenerate.",
      findings: [
        blocking("rules_missing", "file", "The ESI wage limit decides who appears on this return."),
      ],
      ...period,
    });
  }

  const limit = BigInt(args.esiRules.wageLimitMinor);
  const { period: contributionPeriod, from: periodFrom, to: periodTo } =
    contributionPeriodRange(args.periodEnd);

  const dayMode = dayRoundingOf(layout);
  const wageMode = wageRoundingOf(layout);

  const findings: ReturnFinding[] = [];
  const rows: EsicRow[] = [];
  const seen = new Set<string>();

  for (const p of args.people) {
    const who = `${p.ipName} (${p.employeeCode})`;
    const coverage = staysCovered({
      grossMinor: p.grossMinor,
      wageLimitMinor: limit,
      coveredAtPeriodStart: p.coveredAtPeriodStart,
      isExempt: p.esiExempt,
    });

    if (!coverage.covered) continue;

    /**
     * 🔴 THE LOAD-BEARING CHECK OF THIS WHOLE FILE.
     *
     * They are covered by the period rule, and the payslip deducted
     * nothing. That is somebody being written out of the ESI register
     * mid-period. It blocks, it names them, and it says what to do.
     */
    if (coverage.becauseOfPeriodRule && p.employeeEsiMinor === 0n && p.employerEsiMinor === 0n) {
      findings.push(
        blocking(
          "esi_dropped_mid_period",
          who,
          `Gross wages of ${p.grossMinor / 100n} rupees are above the ESI limit, but this person was ` +
            `an insured person at the start of the ${contributionPeriod === "apr_sep" ? "April–September" : "October–March"} ` +
            `contribution period (${periodFrom} to ${periodTo}), so they remain covered on ACTUAL wages ` +
            "until it ends. The payslip deducted nothing. Filing this month without them ends their " +
            "cover and their dependants' cover mid-period. Recompute the run with the contribution " +
            "period history before filing.",
        ),
      );
    }

    const ip = (p.ipNumber ?? "").trim();
    if (ip.length === 0) {
      findings.push(
        blocking(
          "ip_number_missing",
          who,
          "No ESIC insurance number. A covered person cannot be filed without one, and there is no " +
            "placeholder value — register them on the ESIC portal and regenerate.",
        ),
      );
    } else if (!IP_PATTERN.test(ip)) {
      findings.push(
        blocking("ip_number_malformed", who, `IP number "${ip}" is not ten digits.`),
      );
    } else if (seen.has(ip)) {
      findings.push(
        blocking("ip_number_duplicated", who, `IP number ${ip} appears twice on this return.`),
      );
    } else {
      seen.add(ip);
    }

    const name = sanitiseText(p.ipName);
    if (containsDelimiter(name, layout.delimiter)) {
      findings.push(
        blocking(
          "ip_number_malformed",
          who,
          `The name contains "${layout.delimiter}", the column separator, which would shift every ` +
            "later column of this row. A comma in a name is ordinary and is exactly why this refuses " +
            "rather than escaping on a guess about the portal's parser.",
        ),
      );
    }

    const days = daysFromCentidays(p.payableCentidays, dayMode);
    if (!days.exact) {
      findings.push(
        warn(
          "days_rounded",
          who,
          `Wages were paid for ${(p.payableCentidays / 100).toFixed(2)} days and ESIC takes whole days, ` +
            `so the return says ${days.days}. Days paid drive the 78-day qualification for sickness ` +
            "benefit, so the direction of this rounding is not cosmetic.",
        ),
      );
    }
    if (days.days > p.daysInMonth) {
      findings.push(
        blocking("days_exceed_month", who, `${days.days} paid days in a ${p.daysInMonth}-day month.`),
      );
    }

    if (p.grossMinor < 0n) {
      findings.push(blocking("negative_amount", who, "Negative ESI wages."));
    }

    const reason = (p.zeroDayReasonCode ?? "").trim();
    if (days.days === 0) {
      if (reason.length === 0 || !(reason in ESIC_ZERO_DAY_REASONS) || reason === "0") {
        findings.push(
          blocking(
            "esi_zero_days_without_reason",
            who,
            "Zero paid days with no valid reason code. ESIC rejects the row without one — and the " +
              "wrong one is worse: coding unpaid leave as 'left service' removes the person from the " +
              "register altogether.",
          ),
        );
      }
    }

    const wagesRupees = rupeesFromPaise(p.grossMinor, wageMode) ?? 0n;

    /**
     * ⭐ THE CROSS-CHECK THAT JUSTIFIES THE MODULE.
     *
     * 🔴 THE PORTAL RECOMPUTES THE CONTRIBUTION FROM THE WAGE COLUMN. So
     * the number we PAY on the challan and the number the portal DEMANDS
     * are derived from two different things — our exact paise, and our
     * rounded rupees. They can differ. If nobody checks, the challan is
     * short by a rupee a head and the shortfall accrues interest under
     * s.39(5)(a) at 12% a year.
     *
     * ⚠️ A DIFFERENCE OF UP TO ONE RUPEE IS THE ROUNDING ITSELF AND IS A
     * WARNING. More than that is arithmetic that does not reconcile, and
     * it blocks.
     */
    const expectedEmployee = esiCeilRupeesFromBp(wagesRupees, args.esiRules.employeeRateBp);
    const expectedEmployer = esiCeilRupeesFromBp(wagesRupees, args.esiRules.employerRateBp);
    const actualEmployee = p.employeeEsiMinor / 100n;
    const actualEmployer = p.employerEsiMinor / 100n;

    for (const [label, expected, actual] of [
      ["employee", expectedEmployee, actualEmployee],
      ["employer", expectedEmployer, actualEmployer],
    ] as const) {
      const diff = expected > actual ? expected - actual : actual - expected;
      if (diff === 0n) continue;
      const message =
        `The portal will compute the ${label} contribution as ${expected} rupees from the wage on ` +
        `this return, and the payroll deducted ${actual}. ESI contributions are rounded UP by ` +
        "regulation, so the two are derived differently and must be reconciled before the challan.";
      findings.push(
        diff > 1n
          ? blocking("esi_contribution_disagrees_with_wage", who, message)
          : warn("esi_contribution_disagrees_with_wage", who, `${message} The gap is rounding.`),
      );
    }

    rows.push({
      employeeCode: p.employeeCode,
      ipNumber: ip,
      ipName: name,
      daysWorked: days.days,
      wagesRupees,
      reasonCode: days.days === 0 ? reason : "0",
      lastWorkingDay: p.lastWorkingDay ?? "",
    });
  }

  if (rows.length === 0) {
    return refuse({
      kind: "esic_monthly",
      title,
      reason:
        "Nobody on this run is an insured person for the month, so there is no contribution file. " +
        "Check the ESI exemption flags and the wage limit if you expected somebody to be covered.",
      findings: [blocking("no_rows", "file", "No covered person in the period.")],
      ...period,
    });
  }

  if (hasBlocking(findings)) {
    const named = findings.filter((f) => f.severity === "blocking").length;
    return refuse({
      kind: "esic_monthly",
      title,
      reason:
        `${named} finding${named === 1 ? "" : "s"} would make this contribution file wrong rather ` +
        "than merely malformed, so no file was produced. A rejected file costs an afternoon; an " +
        "accepted file that drops an insured person costs them their medical cover.",
      findings,
      ...period,
    });
  }

  const header = layout.columns.map((c) => c.label).join(layout.delimiter);
  const text = joinLines([header, ...rows.map((r) => renderEsicRow(r, layout))]);

  const month = args.periodEnd.slice(0, 7).replace("-", "");
  const code = (args.employerCode ?? "EMPLOYER").replace(/[^A-Za-z0-9]/g, "");

  return {
    generated: true,
    file: {
      kind: "esic_monthly",
      title,
      fileName: `ESIC_MC_${code}_${month}.csv`,
      text,
      lineCount: rows.length,
      layoutId: layout.id,
      layoutVersion: layout.version,
      layoutSource: layout.source,
      confirmedAgainstPortal: layout.confirmedAgainstPortal,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      dueOn: args.dueOn,
      dueAuthority: args.dueAuthority,
      ifLate: args.ifLate,
      totals: {
        wagesMinor: args.people.reduce((a, p) => a + p.grossMinor, 0n),
        employeeContributionMinor: args.people.reduce((a, p) => a + p.employeeEsiMinor, 0n),
        employerContributionMinor: args.people.reduce((a, p) => a + p.employerEsiMinor, 0n),
      },
      basis: [
        `${rows.length} insured persons for the ${contributionPeriod === "apr_sep" ? "April–September" : "October–March"} contribution period, ${periodFrom} to ${periodTo}.`,
        "Coverage is decided by the contribution-period rule: anybody insured at the start of the " +
          "period stays on the return until it ends, on actual wages, whatever they now earn.",
        `Days paid are centidays rounded ${dayMode}; wages are paise rounded ${wageMode} to the rupee.`,
      ],
      warnings: [
        layout.confirmedAgainstPortal
          ? "The column order has been confirmed against the ESIC portal."
          : "🔴 THE COLUMN ORDER HAS NOT BEEN CONFIRMED AGAINST THE LIVE ESIC PORTAL. " + layout.note,
        "⚠️ THIS IS A TRANSCRIPTION WORKSHEET, NOT A PORTAL UPLOAD. ESIC's bulk upload takes its own " +
          "spreadsheet template; paste these columns into the template downloaded for this month.",
        "The portal computes the contribution from the wage column. Compare its figure against the " +
          "totals above before paying the challan.",
      ],
      findings,
    },
  };
}

export function renderEsicRow(row: EsicRow, layout: EsicLayout): string {
  const byId: Readonly<Record<string, string>> = {
    ip_number: row.ipNumber,
    ip_name: row.ipName,
    days_worked: String(row.daysWorked),
    total_monthly_wages: row.wagesRupees.toString(),
    reason_code: row.reasonCode,
    last_working_day: row.lastWorkingDay,
  };
  return layout.columns.map((c) => byId[c.id] ?? "").join(layout.delimiter);
}
