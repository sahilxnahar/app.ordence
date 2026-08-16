import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE BRIDGE: ATTENDANCE AND APPROVED LEAVE → LOSS OF PAY
 * Version: v1.47.0-alpha · Batch 50
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE REPLACES
 * ══════════════════════════════════════════════════════════════════════
 * `components/payroll/payroll-run-board.tsx` passed `attendance: []` to
 * the payroll compute. Every run therefore paid every salaried person a
 * full month whatever the register said, and loss of pay could not be
 * entered at all. It was hardcoded because there was no table to read;
 * migration 0082 built `staff_attendance` and the leave ledger, and this
 * file is the last mile.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THERE ARE THREE WAYS TO LOSE PAY AND THEY ARE NOT THE SAME THING
 * ══════════════════════════════════════════════════════════════════════
 * They cost identical money and mean completely different things to the
 * person's manager, so they are counted separately all the way to the
 * screen and only added up at the last moment:
 *
 *   ① THE REGISTER. A row in `staff_attendance` is a DAY'S VERDICT that
 *      somebody typed. `lop_fraction` on it is the money. This is the
 *      authority: where a day has a row, nothing else is consulted.
 *
 *   ② APPROVED UNPAID LEAVE WITH NO ROW IN THE REGISTER. An approval is
 *      a promise, not a fact — but an employer who approved five days of
 *      leave against a type whose `is_paid` is false has already decided
 *      those days are not paid. Ignoring them because nobody also ticked
 *      a grid would pay a full month against the employer's own written
 *      decision, which is the identical defect to `attendance: []` and
 *      one level deeper.
 *
 *   ③ APPROVED **PAID** LEAVE. Costs nothing. Counted and shown anyway,
 *      because "why is Ravi's December short" is answered by seeing that
 *      his leave was paid and the deduction came from somewhere else.
 *
 * 🔴 UNAPPROVED ABSENCE IS A FOURTH CASE AND IS NOT COLLAPSED INTO ANY OF
 * THEM. `status = 'absent'` with no leave type is charged — the register
 * says so and the database CHECK will not let it be free — but it is
 * reported separately as UNREGULARISED, because an unexplained absence
 * is a conversation somebody has to have and an approved unpaid day is
 * not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS DOES NOT CALL `lib/leave/attendance.ts#summariseAttendance`
 * ══════════════════════════════════════════════════════════════════════
 * It is the right function and it computes the register half correctly.
 * But its per-employee output is `lopDays` — ALREADY DIVIDED BY A
 * HUNDRED. Recovering the centidays this file has to add to the leave
 * half would mean `Math.round(row.lopDays * 100)`, and putting loss of
 * pay through a float on the way back is the one thing `lib/leave/days.ts`
 * exists to prevent. So the register fold happens here, in centidays, and
 * `tests/ui/attendance-into-run.test.ts` pins the two folds to the same
 * answer so they cannot drift.
 *
 * `server/leave/attendance.ts#loadPayrollAttendance` remains the
 * read-only path used by `getPayrollAttendance` in the leave module.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ EVERYTHING IN HERE IS AN INTEGER NUMBER OF CENTIDAYS
 * ══════════════════════════════════════════════════════════════════════
 * A hundredth of a day, the same unit `lib/leave/*` uses, for the same
 * reason money is paise: 0.1 + 0.2 is not 0.3, and a half day of loss of
 * pay is the single most common fraction in Indian payroll.
 *
 * ⚠️ THE DIVISION BACK TO DAYS HAPPENS AT THE BOUNDARY WITH THE PAYSLIP
 * AND NOWHERE ELSE. `buildPayslip` takes `lopDays` in days (it may be
 * 0.5) and immediately scales it back to centidays for the money, so the
 * fraction survives; `chargeableLopCentidays()` replays that exact round
 * trip so this file can state what reached the money instead of assuming
 * it. `splitLopForPayslip()` also divides, but only for the whole-day
 * label an operator reads — never for money.
 */

import { and, eq, gte, lte } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  holidayCalendar,
  leaveRequests,
  leaveTypes,
  staffAttendance,
} from "@/db/schema/leave";
import { addDays, parseDaysOrZero, weekdayOf, type Centidays } from "@/lib/leave/days";
import { chargeableLopCentidays } from "@/lib/payroll/payslip";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** One day, in the unit everything here counts in. */
export const CENTIDAYS_PER_DAY = 100;

/**
 * ⚠️ SUNDAY OFF, WHICH IS A DEFAULT AND NOT A RULE — AND A DUPLICATE.
 *
 * The identical constant lives in `server/actions/leave.ts`, which is a
 * `"use server"` module and therefore cannot export anything that is not
 * an async function. Until it moves to `lib/leave/`, the two copies have
 * to be kept in step by hand; `tests/ui/attendance-into-run.test.ts`
 * asserts they still read the same.
 *
 * 🔴 THE SIX-DAY WEEK IS STILL THE COMMON CASE IN INDIA. Assuming a
 * five-day week would stop charging Saturdays inside a block of unpaid
 * leave, which is two days a week of somebody's salary.
 */
export const DEFAULT_WEEKLY_OFF_DAYS: readonly number[] = [0];

/** ⚠️ A payroll period is a month. This is a runaway guard, not a policy. */
const MAX_PERIOD_DAYS = 400;

/* ------------------------------------------------------------------ */
/* THE FACTS, AS THE PURE FOLD NEEDS THEM                              */
/* ------------------------------------------------------------------ */

/** One row of `staff_attendance`. */
export interface RegisterDayFacts {
  readonly employeeId: string;
  /** ISO `YYYY-MM-DD`. */
  readonly onDate: string;
  readonly status: string;
  /** ⚠️ The raw `numeric` string Drizzle hands back. Parsed here, once. */
  readonly lopFraction: string | number;
  /** Null for an unexplained absence — see decision ④ in `db/schema/leave.ts`. */
  readonly leaveTypeId: string | null;
}

/** One approved leave application, with the bit of its type that matters. */
export interface ApprovedLeaveFacts {
  readonly employeeId: string;
  readonly fromOn: string;
  readonly toOn: string;
  readonly halfDayStart: boolean;
  readonly halfDayEnd: boolean;
  /** `leave_types.is_paid`. FALSE means every day taken is loss of pay. */
  readonly isPaid: boolean;
  /** `leave_types.counts_holidays_and_offs`. */
  readonly countsHolidaysAndOffs: boolean;
  readonly typeCode: string;
}

/** One row of `holiday_calendar`. `workStateCode` null means everywhere. */
export interface HolidayFacts {
  readonly onDate: string;
  readonly workStateCode: string | null;
}

/** A single day of approved leave, already reduced to money. */
export interface LeaveDayFacts {
  readonly employeeId: string;
  readonly onDate: string;
  readonly centidays: Centidays;
  readonly isPaid: boolean;
  readonly typeCode: string;
}

/* ------------------------------------------------------------------ */
/* THE RESULT                                                          */
/* ------------------------------------------------------------------ */

export type LopSource = "none" | "register" | "approved_leave" | "both";

export interface RunLopRow {
  readonly employeeId: string;
  /** From `daysOnRollsIn()`. Attendance never computes this — see below. */
  readonly payableDays: number;

  readonly registerCentidays: Centidays;
  readonly approvedUnpaidCentidays: Centidays;
  /** ⭐ Never money. Shown so a paid absence can be told from a deduction. */
  readonly approvedPaidCentidays: Centidays;

  /** ① + ②, capped at the days the person was on the rolls. */
  readonly totalLopCentidays: Centidays;

  /** ⭐ What reaches `buildPayslip`, now in CENTIDAYS — a half day is
   *  charged as exactly half (29.5/30), never as 29/30. Whole days are
   *  still kept below for the board and the print view; the money math
   *  reads this. */
  readonly chargedLopCentidays: Centidays;
  /** Whole days, for the board and the print view. Not for money. */
  readonly chargedLopDays: number;

  /** ⭐ THE AGREEMENT VALUE. The register and the payslip divide the
   *  loss of pay in the SAME units now, so nothing is dropped: this is
   *  zero whenever the register and the payslip agree — and the centidays
   *  arithmetic guarantees they do. Non-zero means the agreement has
   *  broken and both the run AND the build will refuse to hide it. */
  readonly unrepresentableCentidays: Centidays;

  /** How many days of the period have a verdict in the register. */
  readonly registerDayCount: number;
  /** 🔴 `absent` with no leave type. Charged, and reported as unregularised. */
  readonly unregularisedCentidays: Centidays;

  readonly cappedAtPayableDays: boolean;
  readonly source: LopSource;
}

export interface RunAttendance {
  readonly rows: readonly RunLopRow[];
  readonly byEmployee: ReadonlyMap<string, RunLopRow>;

  /**
   * ⭐ EXACTLY `server/payroll/run.ts#AttendanceInput`, and only for the
   * people who actually lose pay. An employee with nothing against them
   * gets NO entry, because `computeRun()` reads a missing entry as "full
   * month, nothing happened" and that default is argued for at length
   * there. Emitting a zero row would be the same answer today by a longer
   * route, and a different answer the first time the default changes.
   */
  readonly forCompute: readonly {
    readonly employeeId: string;
    readonly payableDays: number;
    readonly lopDays: number;
  }[];

  readonly employeesInRun: number;
  readonly employeesWithRegisterRows: number;
  /** 🔴 Nothing recorded and no approved leave. The assumption, named. */
  readonly employeesAssumedFullMonth: readonly string[];
  readonly unregularisedEmployeeIds: readonly string[];
  /** Employees whose loss of pay could not be charged in whole days. */
  readonly fractionalEmployeeIds: readonly string[];
  readonly totalLopCentidays: Centidays;
  readonly chargedLopCentidays: Centidays;

  /**
   * ⭐⭐ THE SENTENCE THAT MAKES THE DEFAULT NOT SILENT.
   *
   * 🔴 AN EMPLOYEE WITH NO ATTENDANCE ROWS MUST NOT BECOME A FULL MONTH
   * OF LOSS OF PAY — most salaried staff are never marked present at all
   * and a blank register is a normal month. BUT THEY MUST NOT QUIETLY
   * BECOME A FULL MONTH OF PAY EITHER. The assumption is stated here, on
   * the screen before approval, and again as a note on the payslip.
   */
  readonly assumption: string;
}

/* ------------------------------------------------------------------ */
/* ① THE ONE DIVISION IN THE WHOLE MODULE                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ SPLIT A CENTIDAYS FIGURE INTO WHOLE DAYS AND A REMAINDER, FOR
 * PEOPLE TO READ. NOT FOR MONEY.
 *
 * ⚠️ THIS FUNCTION IS NO LONGER ON THE MONEY PATH, AND THE COMMENT THAT
 * USED TO SIT HERE IS WHY THAT MATTERS. It said the payslip engine could
 * not pro-rate half a day — `BigInt(30.5)` is a `RangeError` — and so
 * only the whole-day part could be charged, with the remainder raised as
 * a blocking problem. That was true of the old engine. It is not true of
 * this one: `lib/payroll/payslip.ts` divides in centidays, so 29.5/30
 * stays 29.5/30 and the fraction reaches the money exactly.
 *
 * 🔴 THE FRACTION IS CHARGED, AND THE WHOLE DAYS ARE JUST A LABEL.
 * `foldRunLop()` charges `chargedLopCentidays` (the exact register
 * figure) and uses `wholeDays` only for the approval board and the print
 * view, where "3 days" is what an operator reads. Never divide by a
 * hundred to compute money — `chargeableLopCentidays()` in the payslip
 * module is the one place that round trip is allowed, and it exists to
 * MEASURE the trip rather than to make it.
 *
 * ⚠️ NO FLOAT. `centidays - (centidays % 100)` is a multiple of a
 * hundred, so dividing it by a hundred is exact for every value this
 * product can hold.
 */
export function splitLopForPayslip(centidays: Centidays): {
  readonly wholeDays: number;
  readonly remainderCentidays: Centidays;
} {
  const safe = centidays < 0 ? 0 : Math.trunc(centidays);
  const remainder = safe % CENTIDAYS_PER_DAY;
  return { wholeDays: (safe - remainder) / CENTIDAYS_PER_DAY, remainderCentidays: remainder };
}

/* ------------------------------------------------------------------ */
/* ② APPROVED LEAVE, DAY BY DAY                                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EXPANDS EACH APPROVED APPLICATION INTO THE DAYS OF THE PERIOD IT
 * COVERS, IN CENTIDAYS.
 *
 * ⚠️ THE WALK IS OVER THE PERIOD, NOT OVER THE APPLICATION. A request is
 * capped at 400 days by a CHECK; a payroll period is a month. Clipping
 * first means a typo of `2026` for `2025` in an end date cannot make a
 * payroll compute walk a year of days per employee.
 *
 * ⚠️ THE HALF DAY AT EITHER END APPLIES ONLY IF THAT END FALLS INSIDE
 * THIS PERIOD. A leave that started on 28 February and runs into March
 * has its opening half day charged to February, where it happened.
 *
 * ⭐ HOLIDAYS AND WEEKLY OFFS FOLLOW THE LEAVE TYPE'S OWN POLICY —
 * `counts_holidays_and_offs`, the same flag `lib/leave/request.ts` uses
 * to decide what comes out of the balance. Charging loss of pay on a
 * different rule from the one that debited the balance is how the payroll
 * number and the leave register stop agreeing, which is the whole reason
 * unpaid leave is modelled as a leave TYPE rather than as the absence of
 * one.
 */
export function expandApprovedLeave(args: {
  readonly requests: readonly ApprovedLeaveFacts[];
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly holidays: readonly HolidayFacts[];
  readonly workStateByEmployee: ReadonlyMap<string, string | null>;
  readonly weeklyOffDays?: readonly number[];
}): readonly LeaveDayFacts[] {
  const offs = new Set(args.weeklyOffDays ?? DEFAULT_WEEKLY_OFF_DAYS);

  const holidaysEverywhere = new Set<string>();
  const holidaysByState = new Map<string, Set<string>>();
  for (const h of args.holidays) {
    if (h.workStateCode === null) {
      holidaysEverywhere.add(h.onDate);
      continue;
    }
    const set = holidaysByState.get(h.workStateCode) ?? new Set<string>();
    set.add(h.onDate);
    holidaysByState.set(h.workStateCode, set);
  }

  const out: LeaveDayFacts[] = [];

  for (const req of args.requests) {
    const from = req.fromOn > args.periodStart ? req.fromOn : args.periodStart;
    const to = req.toOn < args.periodEnd ? req.toOn : args.periodEnd;
    if (from > to) continue;

    const state = args.workStateByEmployee.get(req.employeeId) ?? null;
    const stateHolidays = state === null ? null : holidaysByState.get(state);

    /*
     * The chargeable days of this request that fall inside the period.
     *
     * ⚠️ THE WALK IS BOUNDED BY A COUNTER AND NOT ONLY BY THE END DATE.
     * `addDays` returns its input unchanged for a date it cannot parse,
     * and a `for` loop that steps by "unchanged" never terminates. A
     * payroll compute that hangs holds a transaction open.
     */
    const days: string[] = [];
    let day = from;
    for (let guard = 0; day <= to && guard <= MAX_PERIOD_DAYS; guard++) {
      const isHoliday = holidaysEverywhere.has(day) || (stateHolidays?.has(day) ?? false);
      const isOff = offs.has(weekdayOf(day));
      if (req.countsHolidaysAndOffs || (!isHoliday && !isOff)) days.push(day);
      const next = addDays(day, 1);
      if (next === day) break;
      day = next;
    }
    if (days.length === 0) continue;

    for (let i = 0; i < days.length; i++) {
      const onDate = days[i];
      if (onDate === undefined) continue;
      let centidays: Centidays = CENTIDAYS_PER_DAY;
      const isFirst = i === 0 && req.fromOn >= args.periodStart;
      const isLast = i === days.length - 1 && req.toOn <= args.periodEnd;
      if (req.halfDayStart && isFirst) centidays -= 50;
      if (req.halfDayEnd && isLast && !(isFirst && days.length === 1)) centidays -= 50;
      if (centidays <= 0) continue;
      out.push({
        employeeId: req.employeeId,
        onDate,
        centidays,
        isPaid: req.isPaid,
        typeCode: req.typeCode,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* ③ THE FOLD                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ ONE ROW PER EMPLOYEE, FROM BOTH SOURCES, WITHOUT DOUBLE-CHARGING.
 *
 * 🔴 THE PRECEDENCE RULE IS PER DAY AND NOT PER EMPLOYEE. Where a day has
 * a row in the register, that row is the whole answer for that day and
 * the leave application is ignored — the register is what somebody
 * actually observed. Where it does not, an approved application is the
 * best evidence there is.
 *
 * ⚠️ AN EMPLOYEE-LEVEL RULE ("if they have any register rows, ignore
 * leave") WAS THE OBVIOUS SIMPLER VERSION AND IS WRONG. A company that
 * marks attendance for the first week of the month and then stops would
 * have every approved unpaid day after the 7th silently paid in full.
 *
 * `payableDaysByEmployee` is the caller's days-on-rolls map. Attendance
 * deliberately does not derive it: a person who joined on the 12th has
 * 20 payable days whether or not anybody ticked a box for the 12th, and
 * `daysOnRollsIn()` already gets the joiner and leaver cases right.
 */
export function foldRunLop(args: {
  readonly payableDaysByEmployee: ReadonlyMap<string, number>;
  readonly register: readonly RegisterDayFacts[];
  readonly leaveDays: readonly LeaveDayFacts[];
}): RunAttendance {
  const registerCentidays = new Map<string, Centidays>();
  const registerDayCount = new Map<string, number>();
  const unregularised = new Map<string, Centidays>();
  const covered = new Set<string>();

  for (const d of args.register) {
    /*
     * ⚠️ CLAMPED, NOT TRUSTED. The CHECK keeps the column between 0 and
     * 1; this fold is also reached from a CSV import and from tests. A
     * fraction of 8 would dock somebody eight days for one Tuesday.
     */
    const raw = parseDaysOrZero(d.lopFraction);
    const lop = raw < 0 ? 0 : raw > CENTIDAYS_PER_DAY ? CENTIDAYS_PER_DAY : raw;

    covered.add(`${d.employeeId} ${d.onDate}`);
    registerDayCount.set(d.employeeId, (registerDayCount.get(d.employeeId) ?? 0) + 1);
    registerCentidays.set(d.employeeId, (registerCentidays.get(d.employeeId) ?? 0) + lop);

    /*
     * 🔴 `absent` WITH NO LEAVE TYPE IS THE UNEXPLAINED CASE. It is
     * charged like any other loss of pay — the register says so — and
     * counted separately so the operator sees a name to ask about rather
     * than a number to accept.
     */
    if (d.status === "absent" && d.leaveTypeId === null) {
      unregularised.set(d.employeeId, (unregularised.get(d.employeeId) ?? 0) + lop);
    }
  }

  const approvedUnpaid = new Map<string, Centidays>();
  const approvedPaid = new Map<string, Centidays>();

  for (const d of args.leaveDays) {
    /* ⭐ The register wins for a day it has already ruled on. */
    if (covered.has(`${d.employeeId} ${d.onDate}`)) continue;
    const bucket = d.isPaid ? approvedPaid : approvedUnpaid;
    bucket.set(d.employeeId, (bucket.get(d.employeeId) ?? 0) + d.centidays);
  }

  const touched = new Set<string>([
    ...registerCentidays.keys(),
    ...approvedUnpaid.keys(),
    ...approvedPaid.keys(),
  ]);

  const rows: RunLopRow[] = [];
  const forCompute: { employeeId: string; payableDays: number; lopDays: number }[] = [];
  const assumedFullMonth: string[] = [];
  const unregularisedIds: string[] = [];
  const fractionalIds: string[] = [];
  let totalLop = 0;
  let chargedLop = 0;

  for (const [employeeId, payableDays] of args.payableDaysByEmployee) {
    /*
     * 🔴 AN EMPLOYEE WITH NOTHING AGAINST THEM IS PAID A FULL MONTH AND
     * THE ASSUMPTION IS RECORDED. Not silence: `computeRun()` puts the
     * sentence on their payslip and the board shows the count above the
     * approve button.
     */
    if (!touched.has(employeeId)) {
      assumedFullMonth.push(employeeId);
      continue;
    }

    const reg = registerCentidays.get(employeeId) ?? 0;
    const unpaid = approvedUnpaid.get(employeeId) ?? 0;
    const paid = approvedPaid.get(employeeId) ?? 0;
    const raw = reg + unpaid;

    /*
     * ⚠️ LOSS OF PAY CANNOT EXCEED THE DAYS THE PERSON WAS ON THE ROLLS.
     * Otherwise `paidDays()` clamps a negative to zero and the payslip
     * says "0 of 31 days" with no explanation of where the extra came
     * from. Capping here means the number on the payslip is the number in
     * the register.
     */
    const ceiling = payableDays * CENTIDAYS_PER_DAY;
    const total = raw > ceiling ? ceiling : raw;
    const split = splitLopForPayslip(total);
    const unreg = unregularised.get(employeeId) ?? 0;
    if (unreg > 0) unregularisedIds.push(employeeId);
    if (split.remainderCentidays > 0) fractionalIds.push(employeeId);

    /*
     * 🔴🔴 THE PAYSLIP IS ASKED WHAT IT CAN CHARGE. IT IS NOT ASSUMED.
     *
     * ⚠️ THIS LINE USED TO BE `unrepresentableCentidays: 0`, a literal.
     * A literal zero here is not a fact about the arithmetic, it is a
     * promise about it — and it permanently disarmed the refusal in
     * `server/payroll/run.ts#withAttendanceStory` ("Do not approve this
     * run"), which exists for exactly one purpose: to stop a run where
     * the register holds a fraction the payslip cannot charge. A guard
     * whose input is a constant is not a guard.
     *
     * `chargeableLopCentidays()` replays the round trip `buildPayslip`
     * actually performs (centidays → days → centidays) and reports what
     * came back. Since the centidays rewrite the answer is the whole
     * figure, every time — but the day a whole-day divisor comes back,
     * the difference below stops being zero and the run stops.
     */
    const chargeable = chargeableLopCentidays({ payableDays, lopCentidays: total });

    const row: RunLopRow = {
      employeeId,
      payableDays,
      registerCentidays: reg,
      approvedUnpaidCentidays: unpaid,
      approvedPaidCentidays: paid,
      totalLopCentidays: total,
      // ⭐ THE REGISTER AND THE PAYSLIP AGREE, TO THE CENTIDAY — AND THE
      // AGREEMENT IS CHECKED RATHER THAN CLAIMED. `chargeable` is what
      // the payslip's own centidays arithmetic gives back when handed
      // `total`; the difference below is what it could not take. Today
      // that difference is zero for every value this product can hold,
      // so a 0.5-day remainder is charged as 50/100 of a day on the
      // payslip rather than "lost, please verify this assumption" —
      // but nothing here ASSERTS that, it measures it.
      chargedLopCentidays: chargeable,
      /** ⚠️ Whole days, for the board and the print view. Not for money:
       *  `computeRun()` pro-rates from `chargedLopCentidays` above. */
      chargedLopDays: split.wholeDays,
      unrepresentableCentidays: total - chargeable,
      registerDayCount: registerDayCount.get(employeeId) ?? 0,
      unregularisedCentidays: unreg,
      cappedAtPayableDays: raw > ceiling,
      source:
        reg > 0 || (registerDayCount.get(employeeId) ?? 0) > 0
          ? unpaid > 0
            ? "both"
            : "register"
          : unpaid > 0 || paid > 0
            ? "approved_leave"
            : "none",
    };
    rows.push(row);
    totalLop += total;
    /* ⚠️ THE CHARGED TOTAL IS THE SUM OF WHAT WAS CHARGED, not of what
     * was recorded. The two are equal today; adding `total` here would
     * make them equal by construction and hide the day they are not. */
    chargedLop += chargeable;

    /*
     * ⚠️ ONLY PEOPLE WHO ACTUALLY LOSE PAY GO TO THE COMPUTE. Somebody
     * whose register is a month of `present` rows belongs on this screen
     * and not in that array — see `RunAttendance.forCompute`.
     */
    // ⭐ A PART DAY IS NOW A REAL ATTENDANCE FACT, NOT A PROBLEM.
    // `buildPayslip` receives the fractional figure and pro-rates the
    // month's lines against it exactly in centidays, so the 0.5 shows
    // up on the payslip as 0.5 days of loss of pay — the register and
    // the payslip can no longer disagree about it.
    //
    // ⚠️ `chargeable`, NOT `total`. This array is the same figure
    // `computeRun()` pro-rates by (`chargedLopCentidays`), and the two
    // must not be able to drift: an external caller reading this array
    // would otherwise compute a different payslip from the one the run
    // writes.
    if (total > 0) {
      forCompute.push({ employeeId, payableDays, lopDays: chargeable / CENTIDAYS_PER_DAY });
    }
  }

  rows.sort((a, b) => (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0));
  forCompute.sort((a, b) =>
    a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0,
  );

  const employeesInRun = args.payableDaysByEmployee.size;
  const withRegister = registerDayCount.size;

  return {
    rows,
    byEmployee: new Map(rows.map((r) => [r.employeeId, r])),
    forCompute,
    employeesInRun,
    employeesWithRegisterRows: withRegister,
    employeesAssumedFullMonth: assumedFullMonth.sort(),
    unregularisedEmployeeIds: unregularisedIds.sort(),
    fractionalEmployeeIds: fractionalIds.sort(),
    totalLopCentidays: totalLop,
    chargedLopCentidays: chargedLop,
    assumption: describeAssumption({
      employeesInRun,
      withRegister,
      assumedFullMonth: assumedFullMonth.length,
      totalLopCentidays: totalLop,
    }),
  };
}

/**
 * ⭐ THE ASSUMPTION, IN A SENTENCE AN OPERATOR CAN DISAGREE WITH.
 *
 * ⚠️ NOT A COUNT ON ITS OWN. "0 attendance records" reads as a system
 * that has nothing to say. The point is that the system HAS made a
 * decision about everybody's salary and is naming it.
 */
export function describeAssumption(args: {
  readonly employeesInRun: number;
  readonly withRegister: number;
  readonly assumedFullMonth: number;
  readonly totalLopCentidays: Centidays;
}): string {
  if (args.employeesInRun === 0) return "Nobody is on the rolls for this period.";

  if (args.withRegister === 0 && args.totalLopCentidays === 0) {
    return `Nothing is recorded in the attendance register for this period and no unpaid leave is approved, so all ${args.employeesInRun} people are being paid a full month. That is the deliberate default — most salaried staff are never marked present at all — but it is an assumption and not a check.`;
  }

  if (args.assumedFullMonth === 0) {
    return `Every one of the ${args.employeesInRun} people in this run has attendance or approved leave recorded for the period.`;
  }

  return `${args.assumedFullMonth} of ${args.employeesInRun} people have nothing recorded for this period — no attendance and no approved leave — and are being paid a full month on the assumption that nothing happened. The other ${args.employeesInRun - args.assumedFullMonth} are being paid on what is recorded.`;
}

/* ------------------------------------------------------------------ */
/* ④ THE READ                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ TAKES A TRANSACTION RATHER THAN OPENING ONE.
 *
 * 🔴 SO THAT `computeRun()` CAN CALL IT INSIDE THE TRANSACTION THAT
 * WRITES THE PAYSLIPS. Attendance read outside that transaction can
 * change between the read and the write — somebody regularising an
 * absence while the run is computing — and the payslip would then state a
 * loss of pay the register no longer holds, with no way to tell which of
 * the two is the lie.
 *
 * ⭐ THREE QUERIES FOR THE WHOLE RUN, NOT THREE PER EMPLOYEE. A payroll
 * of four hundred people would otherwise issue twelve hundred round trips
 * inside a transaction, which is how a compute that took two seconds
 * starts timing out in month nine and gets "fixed" by hardcoding an empty
 * array again.
 */
export async function loadRunAttendance(
  tx: Tx,
  args: {
    readonly tenantId: string;
    /** ISO `YYYY-MM-DD`, inclusive. */
    readonly periodStart: string;
    /** ISO `YYYY-MM-DD`, inclusive. */
    readonly periodEnd: string;
    readonly payableDaysByEmployee: ReadonlyMap<string, number>;
    /** For state-specific holidays. Absent is treated as "no state list". */
    readonly workStateByEmployee?: ReadonlyMap<string, string | null>;
  },
): Promise<RunAttendance> {
  const registerRows = await tx
    .select({
      employeeId: staffAttendance.employeeId,
      onDate: staffAttendance.onDate,
      status: staffAttendance.status,
      lopFraction: staffAttendance.lopFraction,
      leaveTypeId: staffAttendance.leaveTypeId,
    })
    .from(staffAttendance)
    .where(
      and(
        eq(staffAttendance.tenantId, args.tenantId),
        gte(staffAttendance.onDate, args.periodStart),
        lte(staffAttendance.onDate, args.periodEnd),
      ),
    );

  /**
   * ⚠️ `approved` ONLY. A `submitted` application reserves days and has
   * been decided by nobody; charging it would let an employee dock their
   * own pay by applying, and `rejected` and `cancelled` never happened.
   */
  const requestRows = await tx
    .select({
      employeeId: leaveRequests.employeeId,
      fromOn: leaveRequests.fromOn,
      toOn: leaveRequests.toOn,
      halfDayStart: leaveRequests.halfDayStart,
      halfDayEnd: leaveRequests.halfDayEnd,
      isPaid: leaveTypes.isPaid,
      countsHolidaysAndOffs: leaveTypes.countsHolidaysAndOffs,
      typeCode: leaveTypes.code,
    })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .where(
      and(
        eq(leaveRequests.tenantId, args.tenantId),
        eq(leaveRequests.status, "approved"),
        lte(leaveRequests.fromOn, args.periodEnd),
        gte(leaveRequests.toOn, args.periodStart),
      ),
    );

  const holidayRows = await tx
    .select({
      onDate: holidayCalendar.onDate,
      workStateCode: holidayCalendar.workStateCode,
      isRestricted: holidayCalendar.isRestricted,
    })
    .from(holidayCalendar)
    .where(
      and(
        eq(holidayCalendar.tenantId, args.tenantId),
        gte(holidayCalendar.onDate, args.periodStart),
        lte(holidayCalendar.onDate, args.periodEnd),
        /**
         * ⚠️ A RESTRICTED HOLIDAY IS AN OPTIONAL ONE. Treating it as a
         * company holiday would stop charging a day of unpaid leave that
         * the employee did in fact take.
         */
        eq(holidayCalendar.isRestricted, false),
      ),
    );

  const leaveDays = expandApprovedLeave({
    requests: requestRows.map((r) => ({
      employeeId: String(r.employeeId),
      fromOn: String(r.fromOn),
      toOn: String(r.toOn),
      halfDayStart: Boolean(r.halfDayStart),
      halfDayEnd: Boolean(r.halfDayEnd),
      isPaid: Boolean(r.isPaid),
      countsHolidaysAndOffs: Boolean(r.countsHolidaysAndOffs),
      typeCode: String(r.typeCode),
    })),
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    holidays: holidayRows.map((h) => ({
      onDate: String(h.onDate),
      workStateCode: h.workStateCode === null ? null : String(h.workStateCode),
    })),
    workStateByEmployee: args.workStateByEmployee ?? new Map(),
  });

  return foldRunLop({
    payableDaysByEmployee: args.payableDaysByEmployee,
    register: registerRows.map((r) => ({
      employeeId: String(r.employeeId),
      onDate: String(r.onDate),
      status: String(r.status),
      lopFraction: String(r.lopFraction ?? "0"),
      leaveTypeId: r.leaveTypeId === null ? null : String(r.leaveTypeId),
    })),
    leaveDays,
  });
}
