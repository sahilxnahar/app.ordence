/**
 * Ordence — ⭐⭐⭐ LEAVE ACCRUAL
 * Version: v1.46.0-alpha · Batch 59
 *
 * Pure arithmetic. No database, no clock, no tenant. Everything this file
 * needs is an argument, which is what lets the same function answer
 * "what does the monthly job write tonight" and "what would this person's
 * balance have been on 12 August" without a second implementation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE DECISION: LEAVE IS EARNED MONTHLY, IN ARREARS, PRO-RATED BY
 * DAYS ON THE ROLLS
 * ══════════════════════════════════════════════════════════════════════
 * At the end of each month of the leave year, an employee earns the
 * share of the annual entitlement that corresponds to the days they were
 * actually on the rolls inside that year so far, less the days that fell
 * inside their probation.
 *
 * ⚠️ THE ALTERNATIVE — GRANTING THE FULL YEAR ON THE FIRST DAY — IS THE
 * SPECIFIC MISTAKE THIS BATCH EXISTS TO PREVENT. Somebody who joins in
 * October and sees 18 days on their balance is looking at a number the
 * business does not owe them. They will take it, because it is on their
 * screen and nobody told them otherwise, and the employer will discover
 * in March that half a year's staffing cost went out as paid absence
 * against leave that was never earned. It is not recoverable — you cannot
 * bill somebody for a holiday they were told they had.
 *
 * ⭐ SO A MID-YEAR JOINER ACCRUES FROM THEIR JOINING MONTH AND FOR THE
 * PART OF THAT MONTH THEY WERE THERE. Somebody joining on 20 October in
 * an April–March year has, by 31 March, earned
 * `annual × (163 / 365)` — the 163 days from 20 October to 31 March —
 * rounded to the type's granularity. Nothing else in this file is more
 * important than that sentence.
 *
 * ⚠️ AND A MID-YEAR LEAVER STOPS. `daysOnRollsInPeriod` is an
 * intersection, so it handles both ends with the same arithmetic and
 * they cannot drift apart.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE CUMULATIVE TARGET, WHICH IS THE NON-OBVIOUS HALF
 * ══════════════════════════════════════════════════════════════════════
 * The accrual for a month is NOT `round(annual / 12)`. It is
 *
 *     target(this month) − everything already accrued this period
 *
 * where `target` is the rounded entitlement earned to date.
 *
 * 🔴 ROUNDING EACH MONTH INDEPENDENTLY IS WRONG BY A WHOLE MONTH'S
 * ACCRUAL A YEAR AND LOOKS RIGHT EVERY SINGLE MONTH. An entitlement of
 * 15 days rounded to half days is 1.25 a month; rounded per month that
 * becomes 1.5, and twelve of those is 18 days against an entitlement of
 * 15. Nobody notices in April. Everybody notices in March, by which time
 * three days per head have been taken.
 *
 * ⭐ THE CUMULATIVE FORM ALSO MAKES THE JOB RE-RUNNABLE AND
 * SELF-HEALING. A month the job missed is caught up by the next run,
 * because the target does not care how many entries preceded it — and a
 * month the job ran twice writes a delta of zero, which the caller drops.
 * That is belt to the braces of `leave_ledger_accrual_once`.
 */

import {
  overlapDays,
  parseDays,
  roundToGranularity,
  type Centidays,
} from "./days";

/** What the leave year is, as far as arithmetic is concerned. */
export interface LeavePeriodFacts {
  /** ISO `YYYY-MM-DD`, inclusive. */
  readonly startsOn: string;
  /** ISO `YYYY-MM-DD`, inclusive. */
  readonly endsOn: string;
}

/** The policy, already parsed out of `leave_types`. */
export interface AccrualPolicy {
  readonly method: "monthly_earned" | "annual_advance" | "none";
  readonly annualEntitlementCentidays: Centidays;
  readonly roundToCentidays: Centidays;
  readonly probationDays: number;
}

/** The person, as far as arithmetic is concerned. */
export interface EmployeeServiceFacts {
  /** ISO `YYYY-MM-DD`. */
  readonly joinedOn: string;
  /** ISO `YYYY-MM-DD`, or null while employed. */
  readonly leftOn: string | null;
}

export interface AccrualOutcome {
  /**
   * ⭐ WHAT TO WRITE AS AN `accrual` ENTRY. Never negative — see
   * `overAccruedCentidays`.
   */
  readonly deltaCentidays: Centidays;
  /** The rounded entitlement earned from the start of the period to `asOf`. */
  readonly targetCentidays: Centidays;
  /** Days on the rolls, inside the period, up to and including `asOf`. */
  readonly eligibleDays: number;
  /** Days in the whole leave period. The divisor. */
  readonly periodDays: number;
  /**
   * 🔴 NON-ZERO MEANS MORE HAS ALREADY BEEN ACCRUED THAN IS NOW EARNED.
   *
   * ⚠️ IT IS REPORTED AND NEVER NETTED AWAY. The only ways to get here
   * are an `annual_advance` type (which grants ahead by design) and an
   * employee whose leaving date was backdated after the accrual ran. Both
   * are real, both are somebody's decision to make, and writing a silent
   * negative `accrual` to "correct" it would erase leave the employee has
   * already been told about — and may already have taken. The recovery,
   * if there is one, is an `adjustment` with a note and a human's name
   * on it.
   */
  readonly overAccruedCentidays: Centidays;
  /** Plain-language working, for the screen and for the ledger note. */
  readonly workingNote: string;
}

/**
 * ⭐ THE MID-YEAR JOINER AND LEAVER ANSWER, IN ONE LINE.
 *
 * The days an employee was on the rolls inside a window is the
 * intersection of their employment with that window. `asOf` clips the
 * window short so the same function answers "so far this year".
 */
export function daysOnRollsInPeriod(
  employee: EmployeeServiceFacts,
  period: LeavePeriodFacts,
  asOf: string,
): number {
  const windowEnd = asOf < period.endsOn ? asOf : period.endsOn;
  if (windowEnd < period.startsOn) return 0;
  /*
   * ⚠️ `9999-12-31` RATHER THAN A NULL BRANCH. A separate code path for
   * "still employed" is a second place the interval logic can be wrong,
   * and this is the one calculation in the file everything else divides
   * by.
   */
  const leftOn = employee.leftOn ?? "9999-12-31";
  return overlapDays(employee.joinedOn, leftOn, period.startsOn, windowEnd);
}

/**
 * ⚠️ THE PROBATION WINDOW, EXPRESSED AS THE DAYS INSIDE THE PERIOD THAT
 * EARN NOTHING.
 *
 * 🔴 PROBATION IS COUNTED FROM JOINING AND NOT FROM THE START OF THE
 * LEAVE YEAR. An employee in their second year has no probation days
 * left, and a version that measured from 1 April would re-impose it on
 * them every April.
 */
export function probationDaysInPeriod(
  employee: EmployeeServiceFacts,
  period: LeavePeriodFacts,
  asOf: string,
  probationDays: number,
): number {
  if (probationDays <= 0) return 0;
  const windowEnd = asOf < period.endsOn ? asOf : period.endsOn;
  if (windowEnd < period.startsOn) return 0;

  /* The last day of probation, inclusive: joining day counts as day 1. */
  const probationEnd = shiftIso(employee.joinedOn, probationDays - 1);
  const leftOn = employee.leftOn ?? "9999-12-31";
  const employedEnd = leftOn < probationEnd ? leftOn : probationEnd;
  return overlapDays(employee.joinedOn, employedEnd, period.startsOn, windowEnd);
}

/**
 * ⭐⭐⭐ THE FUNCTION EVERYTHING ELSE IN THE MODULE IS ARRANGED AROUND.
 *
 * `alreadyAccruedCentidays` is the sum of the `accrual` entries already
 * in the ledger for this employee, this type and this period — nothing
 * else. Carry-forward, adjustments and taken days are deliberately NOT
 * in it: mixing them in would make the accrual depend on how much leave
 * somebody had taken, which is not what "earned" means.
 */
export function accrueTo(args: {
  readonly policy: AccrualPolicy;
  readonly employee: EmployeeServiceFacts;
  readonly period: LeavePeriodFacts;
  /** ISO date to accrue up to and including. Normally a month end. */
  readonly asOf: string;
  readonly alreadyAccruedCentidays: Centidays;
}): AccrualOutcome {
  const periodDays = overlapDays(
    args.period.startsOn,
    args.period.endsOn,
    args.period.startsOn,
    args.period.endsOn,
  );

  const onRolls = daysOnRollsInPeriod(args.employee, args.period, args.asOf);
  const probation = probationDaysInPeriod(
    args.employee,
    args.period,
    args.asOf,
    args.policy.probationDays,
  );
  const eligibleDays = Math.max(0, onRolls - probation);

  /* A type that is never earned earns nothing, and says so. */
  if (args.policy.method === "none" || args.policy.annualEntitlementCentidays <= 0) {
    return {
      deltaCentidays: 0,
      targetCentidays: 0,
      eligibleDays,
      periodDays,
      overAccruedCentidays: Math.max(0, args.alreadyAccruedCentidays),
      workingNote:
        args.policy.method === "none"
          ? "This type is never earned — days taken against it are recorded, not deducted from a balance."
          : "This type has no annual entitlement, so nothing accrues.",
    };
  }

  if (periodDays <= 0) {
    return {
      deltaCentidays: 0,
      targetCentidays: 0,
      eligibleDays,
      periodDays,
      overAccruedCentidays: 0,
      workingNote: "The leave period has no days in it, so nothing can be earned inside it.",
    };
  }

  /*
   * ⚠️ MULTIPLY BEFORE DIVIDE, THE SAME RULE AS EVERY PRO-RATION IN
   * PAYROLL. `(annual / periodDays) * eligible` loses precision on the
   * first operation and the twelve monthly deltas then do not add up to
   * the annual entitlement.
   */
  const earnedExact =
    (args.policy.annualEntitlementCentidays * eligibleDays) / periodDays;

  /*
   * ⭐ `annual_advance` GRANTS THE WHOLE ENTITLEMENT UP FRONT — BUT ONLY
   * THE PART OF THE YEAR THE PERSON IS ACTUALLY THERE FOR.
   *
   * 🔴 A FULL YEAR FOR A PART-YEAR JOINER IS EXACTLY THE LIABILITY THIS
   * BATCH IS ABOUT, so even the "grant it up front" method pro-rates by
   * the employee's own window. What `annual_advance` changes is the
   * TIMING — the whole of their pro-rated entitlement is available on
   * their first day rather than accruing across the year — and that is
   * the real thing employers mean when they say leave is granted
   * annually.
   */
  const target =
    args.policy.method === "annual_advance"
      ? roundToGranularity(
          (args.policy.annualEntitlementCentidays *
            remainingDaysOnRolls(args.employee, args.period)) /
            periodDays,
          args.policy.roundToCentidays,
        )
      : roundToGranularity(earnedExact, args.policy.roundToCentidays);

  const raw = target - args.alreadyAccruedCentidays;
  const delta = raw > 0 ? raw : 0;
  const over = raw < 0 ? -raw : 0;

  return {
    deltaCentidays: delta,
    targetCentidays: target,
    eligibleDays,
    periodDays,
    overAccruedCentidays: over,
    workingNote: buildNote({
      method: args.policy.method,
      eligibleDays,
      periodDays,
      probation,
      target,
      delta,
      over,
    }),
  };
}

/**
 * ⚠️ FOR `annual_advance` ONLY: the whole of the employee's window in
 * this period, regardless of `asOf`. That is what makes the grant an
 * ADVANCE — the days exist before they are earned.
 */
function remainingDaysOnRolls(
  employee: EmployeeServiceFacts,
  period: LeavePeriodFacts,
): number {
  return daysOnRollsInPeriod(employee, period, period.endsOn);
}

function buildNote(a: {
  method: AccrualPolicy["method"];
  eligibleDays: number;
  periodDays: number;
  probation: number;
  target: Centidays;
  delta: Centidays;
  over: Centidays;
}): string {
  const parts: string[] = [];
  const days = (c: Centidays) => (c / 100).toFixed(2);

  if (a.method === "annual_advance") {
    parts.push(
      `Granted in advance for ${a.eligibleDays + a.probation} of ${a.periodDays} days on the rolls this leave year.`,
    );
  } else {
    parts.push(
      `Earned for ${a.eligibleDays} of ${a.periodDays} days on the rolls this leave year.`,
    );
  }
  if (a.probation > 0) {
    parts.push(`${a.probation} day${a.probation === 1 ? "" : "s"} of probation earn nothing.`);
  }
  parts.push(`Entitlement to date ${days(a.target)}; this entry adds ${days(a.delta)}.`);
  if (a.over > 0) {
    parts.push(
      `⚠️ ${days(a.over)} more has already been credited than is now earned. Nothing has been taken back — correct it with an adjustment if that is what you mean to do.`,
    );
  }
  return parts.join(" ");
}

/**
 * ⭐ THE MONTH ENDS INSIDE A LEAVE PERIOD, WHICH IS WHAT THE ACCRUAL RUN
 * ITERATES OVER.
 *
 * ⚠️ THE LAST ENTRY IS THE PERIOD'S OWN END DATE EVEN WHEN IT IS NOT A
 * MONTH END. A leave year running 1 April – 31 March ends on a month
 * end; one running 16 June – 15 June does not, and dropping its final
 * fortnight would quietly withhold half a month's accrual from everybody
 * every year.
 */
export function monthEndsIn(period: LeavePeriodFacts, upToIso: string): string[] {
  const out: string[] = [];
  const limit = upToIso < period.endsOn ? upToIso : period.endsOn;
  if (limit < period.startsOn) return out;

  const start = /^(\d{4})-(\d{2})/.exec(period.startsOn);
  if (!start) return out;

  let year = Number(start[1]);
  let month = Number(start[2]);

  /* ⚠️ A hard stop. A malformed period must not spin forever. */
  for (let guard = 0; guard < 500; guard++) {
    const end = monthEndIso(year, month);
    if (end > limit) break;
    if (end >= period.startsOn) out.push(end);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  if (out[out.length - 1] !== limit) out.push(limit);
  return out;
}

function monthEndIso(year: number, month: number): string {
  /* Day 0 of the next month is the last day of this one. */
  const ms = Date.UTC(year, month, 0);
  return new Date(ms).toISOString().slice(0, 10);
}

function shiftIso(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * ⭐ CONVENIENCE FOR CALLERS THAT HOLD RAW `leave_types` ROWS. Keeping
 * the parse in one place means a policy read from the database and a
 * policy typed into a test go through the same door.
 */
export function policyFromRow(row: {
  accrualMethod: string | null;
  annualEntitlementDays: string | number | null;
  accrualRoundToDays: string | number | null;
  probationDays: number | null;
}): AccrualPolicy {
  const method =
    row.accrualMethod === "annual_advance"
      ? "annual_advance"
      : row.accrualMethod === "none"
        ? "none"
        : "monthly_earned";
  return {
    method,
    annualEntitlementCentidays: parseDays(row.annualEntitlementDays) ?? 0,
    roundToCentidays: parseDays(row.accrualRoundToDays) ?? 0,
    probationDays: row.probationDays ?? 0,
  };
}
