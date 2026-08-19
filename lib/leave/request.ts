/**
 * Ordence — ⭐⭐ COUNTING THE DAYS IN AN APPLICATION
 * Version: v1.46.0-alpha · Batch 59
 *
 * Pure arithmetic over dates. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 "FIVE DAYS OFF" IS NOT A NUMBER UNTIL SOMEBODY SAYS WHAT COUNTS
 * ══════════════════════════════════════════════════════════════════════
 * An employee applies for Monday to Friday. Whether that is five days out
 * of their balance depends on the leave type, and both answers are
 * standard Indian practice:
 *
 *   `counts_holidays_and_offs = true`   the whole block comes out —
 *       usual for earned or privilege leave. What is granted is the
 *       period of absence, Sundays included.
 *
 *   `counts_holidays_and_offs = false`  only working days come out —
 *       usual for casual and sick leave.
 *
 * ⚠️ GETTING IT BACKWARDS ON ONE TYPE COSTS EVERY EMPLOYEE WHO TAKES A
 * LONG HOLIDAY EXACTLY TWO DAYS A WEEK, and the number looks entirely
 * plausible at every point. Nobody discovers it until somebody counts
 * their own leave by hand.
 *
 * ⭐ SO THE FUNCTION RETURNS ITS WORKING, not just a total. The screen
 * shows "7 calendar days, of which 2 are weekly offs and 1 is a declared
 * holiday — 4 days will be deducted", and an employee who disagrees is
 * disagreeing with something specific.
 */

import {
  addDays,
  inclusiveDayCount,
  weekdayOf,
  type Centidays,
} from "./days";

export interface RequestDayCountInput {
  /** ISO `YYYY-MM-DD`, inclusive. */
  readonly fromOn: string;
  /** ISO `YYYY-MM-DD`, inclusive. */
  readonly toOn: string;
  readonly halfDayStart: boolean;
  readonly halfDayEnd: boolean;
  /** `leave_types.counts_holidays_and_offs`. */
  readonly countsHolidaysAndOffs: boolean;
  /**
   * Weekdays that are not worked, 0 = Sunday. ⚠️ A LIST AND NOT A
   * BOOLEAN: the six-day week with Sunday off is still the common case in
   * India, five-day weeks exist, and some establishments close on a
   * different day entirely.
   */
  readonly weeklyOffDays: readonly number[];
  /** ISO dates from `holiday_calendar`, already filtered to this employee. */
  readonly holidays: readonly string[];
}

export interface RequestDayCount {
  /** ⭐ What comes out of the balance. */
  readonly chargeableCentidays: Centidays;
  readonly calendarDays: number;
  readonly weeklyOffDays: number;
  readonly holidayDays: number;
  readonly halfDays: number;
  readonly workingNote: string;
  /** 🔴 Non-empty means the application must not be submitted as it is. */
  readonly problems: readonly string[];
}

const MAX_SPAN_DAYS = 400;

/**
 * ⭐ THE COUNT, WITH ITS WORKING.
 *
 * ⚠️ HALF DAYS ARE APPLIED ONLY TO CHARGEABLE DAYS. A half day on a
 * Sunday is not half a day of leave; it is nothing, and subtracting it
 * anyway would let an employee shave half a day off every application by
 * starting it on a weekend.
 */
export function countRequestDays(input: RequestDayCountInput): RequestDayCount {
  const problems: string[] = [];

  if (input.toOn < input.fromOn) {
    return {
      chargeableCentidays: 0,
      calendarDays: 0,
      weeklyOffDays: 0,
      holidayDays: 0,
      halfDays: 0,
      workingNote: "",
      problems: ["The last day of the leave is before the first day."],
    };
  }

  const calendarDays = inclusiveDayCount(input.fromOn, input.toOn);
  if (calendarDays <= 0) {
    return {
      chargeableCentidays: 0,
      calendarDays: 0,
      weeklyOffDays: 0,
      holidayDays: 0,
      halfDays: 0,
      workingNote: "",
      problems: ["Those dates are not a real range."],
    };
  }
  if (calendarDays > MAX_SPAN_DAYS) {
    /*
     * ⚠️ A REFUSAL RATHER THAN A LOOP. A typo of `2026` for `2025` in the
     * end date produces a 400-day walk and an application for a year of
     * leave that somebody might approve without reading.
     */
    problems.push(
      `That is ${calendarDays} days. An application longer than ${MAX_SPAN_DAYS} days is almost always a typo in the year — check the dates.`,
    );
  }

  const offs = new Set(input.weeklyOffDays);
  const holidaySet = new Set(input.holidays);

  let chargeableDays = 0;
  let weeklyOffCount = 0;
  let holidayCount = 0;
  let firstChargeable: string | null = null;
  let lastChargeable: string | null = null;

  const span = Math.min(calendarDays, MAX_SPAN_DAYS);
  for (let i = 0; i < span; i++) {
    const day = addDays(input.fromOn, i);
    const isHoliday = holidaySet.has(day);
    const isOff = offs.has(weekdayOf(day));

    if (isHoliday) holidayCount++;
    else if (isOff) weeklyOffCount++;

    const counts = input.countsHolidaysAndOffs || (!isHoliday && !isOff);
    if (counts) {
      chargeableDays++;
      if (firstChargeable === null) firstChargeable = day;
      lastChargeable = day;
    }
  }

  let centidays = chargeableDays * 100;
  let halfDays = 0;

  /*
   * ⭐ THE HALF DAY COMES OFF THE FIRST AND LAST CHARGEABLE DAY, NOT THE
   * FIRST AND LAST CALENDAR DAY. Somebody taking a half day on Friday
   * afternoon through Monday should be charged 1.5 days, and the Sunday
   * in the middle has nothing to do with it.
   */
  if (input.halfDayStart && firstChargeable !== null) {
    centidays -= 50;
    halfDays++;
  }
  if (input.halfDayEnd && lastChargeable !== null && lastChargeable !== firstChargeable) {
    centidays -= 50;
    halfDays++;
  } else if (input.halfDayEnd && lastChargeable !== null && lastChargeable === firstChargeable) {
    /*
     * 🔴 A HALF DAY AT BOTH ENDS OF A ONE-DAY APPLICATION IS ZERO DAYS,
     * which is an application for nothing. The database refuses it too
     * (`leave_requests_half_days_coherent`); saying so here means the
     * employee reads a sentence instead of a constraint name.
     */
    problems.push(
      "A single day cannot be a half day at both ends. Tick one of them for a half day off.",
    );
  }

  if (centidays <= 0 && problems.length === 0) {
    problems.push(
      chargeableDays === 0
        ? "Every day in that range is a weekly off or a declared holiday for this leave type, so there is nothing to apply for."
        : "That works out to no leave at all. Check the half-day boxes.",
    );
  }

  const notes: string[] = [`${calendarDays} calendar day${calendarDays === 1 ? "" : "s"}.`];
  if (input.countsHolidaysAndOffs) {
    notes.push(
      "This leave type counts intervening weekly offs and declared holidays, so the whole block is deducted.",
    );
  } else {
    if (weeklyOffCount > 0) notes.push(`${weeklyOffCount} weekly off${weeklyOffCount === 1 ? "" : "s"} not deducted.`);
    if (holidayCount > 0) notes.push(`${holidayCount} declared holiday${holidayCount === 1 ? "" : "s"} not deducted.`);
    if (weeklyOffCount === 0 && holidayCount === 0) {
      notes.push("No weekly offs or declared holidays fall inside it.");
    }
  }
  if (halfDays > 0) notes.push(`${halfDays} half day${halfDays === 1 ? "" : "s"}.`);
  notes.push(`${(Math.max(0, centidays) / 100).toFixed(2)} days will be deducted.`);

  return {
    chargeableCentidays: Math.max(0, centidays),
    calendarDays,
    weeklyOffDays: weeklyOffCount,
    holidayDays: holidayCount,
    halfDays,
    workingNote: notes.join(" "),
    problems,
  };
}

/**
 * ⭐ THE CHARGEABLE DATES THEMSELVES, WHICH IS WHAT ATTENDANCE NEEDS.
 *
 * 🔴 DECISION ④ IN ONE FUNCTION. When somebody actually takes the leave,
 * an attendance row is written per DATE. This returns exactly those
 * dates and the fraction of each that is leave, so the attendance writer
 * never has to re-derive the calendar and the two can never disagree
 * about whether the Sunday in the middle was leave.
 */
export function chargeableDates(input: RequestDayCountInput): {
  readonly onDate: string;
  readonly fraction: Centidays;
}[] {
  if (input.toOn < input.fromOn) return [];
  const offs = new Set(input.weeklyOffDays);
  const holidaySet = new Set(input.holidays);
  const span = Math.min(inclusiveDayCount(input.fromOn, input.toOn), MAX_SPAN_DAYS);

  const out: { onDate: string; fraction: Centidays }[] = [];
  for (let i = 0; i < span; i++) {
    const day = addDays(input.fromOn, i);
    const isHoliday = holidaySet.has(day);
    const isOff = offs.has(weekdayOf(day));
    if (!input.countsHolidaysAndOffs && (isHoliday || isOff)) continue;
    out.push({ onDate: day, fraction: 100 });
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (!first || !last) return out;

  if (input.halfDayStart) first.fraction -= 50;
  if (input.halfDayEnd && out.length > 1) last.fraction -= 50;

  return out.filter((d) => d.fraction > 0);
}

/**
 * ⚠️ THE POLICY CHECKS THAT ARE NOT ARITHMETIC BUT ARE STILL PURE.
 *
 * Kept out of the server action so they can be exercised without a
 * database, and returned as sentences rather than codes because every one
 * of them is read by the person who wanted the leave.
 */
export function checkRequestPolicy(args: {
  readonly requestedCentidays: Centidays;
  readonly availableCentidays: Centidays;
  readonly allowNegativeBalance: boolean;
  readonly maxNegativeCentidays: Centidays;
  readonly maxConsecutiveCentidays: Centidays | null;
  readonly minNoticeDays: number;
  readonly allowHalfDay: boolean;
  readonly usesHalfDay: boolean;
  /** Days between the application being made and the leave starting. */
  readonly noticeDays: number;
  readonly isPaid: boolean;
}): string[] {
  const problems: string[] = [];

  if (args.usesHalfDay && !args.allowHalfDay) {
    problems.push("This leave type cannot be taken as a half day.");
  }

  if (args.minNoticeDays > 0 && args.noticeDays < args.minNoticeDays) {
    problems.push(
      `This leave type needs ${args.minNoticeDays} day${args.minNoticeDays === 1 ? "" : "s"} of notice and this application gives ${args.noticeDays}.`,
    );
  }

  if (
    args.maxConsecutiveCentidays !== null &&
    args.requestedCentidays > args.maxConsecutiveCentidays
  ) {
    problems.push(
      `This leave type allows at most ${(args.maxConsecutiveCentidays / 100).toFixed(2)} days at a time.`,
    );
  }

  /*
   * ⭐ AN UNPAID TYPE HAS NO BALANCE TO EXCEED. Loss of pay is not
   * rationed by a ledger — it is rationed by the employer's willingness
   * to approve it, which is what the approval step is for.
   */
  if (args.isPaid) {
    const after = args.availableCentidays - args.requestedCentidays;
    const floor = args.allowNegativeBalance ? -Math.abs(args.maxNegativeCentidays) : 0;
    if (after < floor) {
      problems.push(
        args.allowNegativeBalance
          ? `That would leave a balance of ${(after / 100).toFixed(2)} days, and this leave type allows no more than ${(Math.abs(args.maxNegativeCentidays) / 100).toFixed(2)} days of negative balance.`
          : `Only ${(args.availableCentidays / 100).toFixed(2)} days are available — earned days less anything already approved. Apply for unpaid leave for the rest, so the payslip and the leave register agree.`,
      );
    }
  }

  return problems;
}
