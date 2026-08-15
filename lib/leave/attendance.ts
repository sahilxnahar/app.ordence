/**
 * Ordence — ⭐⭐⭐ ATTENDANCE → LOSS OF PAY
 * Version: v1.46.0-alpha · Batch 59
 *
 * Pure arithmetic. The one function in this module that payroll depends
 * on, kept away from the database so that "why was this payslip short two
 * days" can be answered from a test rather than from production.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE HARDCODED `attendance: []`
 * ══════════════════════════════════════════════════════════════════════
 * `components/payroll/payroll-run-board.tsx` passes an empty array to the
 * payroll compute. Every run therefore pays every salaried person a full
 * month, and loss of pay cannot be entered at all. It was hardcoded
 * because there was no table to read — `db/schema/labour.ts` has an
 * `attendance_kind` enum for construction labour check-in/check-out
 * punches, and contract labour is paid through a vendor's RA bill, not a
 * payslip.
 *
 * ⭐ `staff_attendance` IS THAT TABLE, AND THIS FUNCTION IS THE
 * TRANSLATION. `summariseAttendance()` produces exactly the shape
 * `server/payroll/run.ts#AttendanceInput` already accepts, so wiring it
 * up is replacing one literal with one call.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FUNCTION DELIBERATELY DOES NOT COMPUTE: `payableDays`
 * ══════════════════════════════════════════════════════════════════════
 * `server/payroll/run.ts#daysOnRollsIn` already derives the days an
 * employee was on the rolls inside the period, and it gets the joiner and
 * leaver cases right. Attendance has nothing to add to it — a person who
 * joined on the 12th has 20 payable days whether or not anybody ticked a
 * box for the 12th.
 *
 * 🔴 SO `payableDays` HERE IS ALWAYS THE CALLER'S OWN DAYS-ON-ROLLS
 * FIGURE, PASSED IN. Computing it from attendance rows would make a month
 * with no attendance entered pay nobody, and most salaried staff are
 * never marked present at all — which is exactly the default
 * `computeRun()` argues for at length and would be silently reversed by
 * an attendance table that thought it knew better.
 */

import { parseDaysOrZero, type Centidays } from "./days";

/** One row of `staff_attendance`, as the summary needs it. */
export interface AttendanceDayFacts {
  readonly employeeId: string;
  /** ISO `YYYY-MM-DD`. */
  readonly onDate: string;
  readonly status: string;
  /** ⚠️ The raw `numeric` string from Drizzle. Parsed in here, once. */
  readonly lopFraction: string | number;
}

/**
 * ⭐ THE SHAPE `server/payroll/run.ts` ALREADY TAKES.
 *
 * Structurally identical to `AttendanceInput` there, and deliberately
 * declared here rather than imported: `lib/` must not import from
 * `server/`, and `tests/ui/leave.test.ts` asserts the two definitions
 * still agree field for field. A drift between them would be a payroll
 * that silently ignores loss of pay, which is the defect this whole batch
 * exists to make fixable.
 */
export interface PayrollAttendanceRow {
  readonly employeeId: string;
  readonly payableDays: number;
  readonly lopDays: number;
}

export interface AttendanceSummary {
  readonly rows: readonly PayrollAttendanceRow[];
  /** Employees with at least one attendance row in the period. */
  readonly employeesWithRecords: number;
  /** Total loss-of-pay days across the whole run, for the board's header. */
  readonly totalLopCentidays: Centidays;
  /**
   * 🔴 EMPLOYEES WHOSE ATTENDANCE INCLUDES AN `absent` DAY WITH NO LEAVE
   * TYPE. Reported, never auto-classified: an unexplained absence and an
   * approved unpaid leave cost the same money and mean completely
   * different things to the person's manager.
   */
  readonly unexplainedAbsenceEmployeeIds: readonly string[];
}

/**
 * ⭐ FOLDS A PERIOD'S ATTENDANCE INTO ONE ROW PER EMPLOYEE.
 *
 * `payableDaysByEmployee` is the caller's days-on-rolls map — see the
 * header for why it is not derived from the rows.
 *
 * ⚠️ AN EMPLOYEE WITH NO ROWS GETS NO ENTRY IN THE RESULT AT ALL, rather
 * than an entry with `lopDays: 0`. `computeRun()` treats a missing entry
 * as "full month, nothing happened", which is the correct default and the
 * one it argues for; emitting a zero row would be the same answer by a
 * longer route today and a different answer the first time that default
 * changes.
 */
export function summariseAttendance(args: {
  readonly days: readonly AttendanceDayFacts[];
  readonly payableDaysByEmployee: ReadonlyMap<string, number>;
}): AttendanceSummary {
  const lopByEmployee = new Map<string, Centidays>();
  const unexplained = new Set<string>();

  for (const d of args.days) {
    const lop = parseDaysOrZero(d.lopFraction);
    /*
     * ⚠️ CLAMPED, NOT TRUSTED. The CHECK constraint keeps the column
     * between 0 and 1, and this function is also called with rows built
     * in a test and rows arriving from a CSV import. A fraction of 8
     * would dock somebody eight days for one Tuesday.
     */
    const clamped = lop < 0 ? 0 : lop > 100 ? 100 : lop;
    lopByEmployee.set(d.employeeId, (lopByEmployee.get(d.employeeId) ?? 0) + clamped);

    if (d.status === "absent") unexplained.add(d.employeeId);
  }

  const rows: PayrollAttendanceRow[] = [];
  let total = 0;

  for (const [employeeId, lopCentidays] of lopByEmployee) {
    const payableDays = args.payableDaysByEmployee.get(employeeId);
    /*
     * 🔴 AN ATTENDANCE ROW FOR SOMEBODY NOT ON THE RUN IS DROPPED, NOT
     * GUESSED AT. It means the employee left before the period or joined
     * after it, and inventing a `payableDays` for them would put a
     * payslip in a run that `computeRun()` deliberately excluded.
     */
    if (payableDays === undefined) continue;

    /*
     * ⚠️ LOSS OF PAY CANNOT EXCEED THE DAYS THE PERSON WAS ON THE ROLLS.
     * Otherwise `paidDays()` in lib/payroll/payslip.ts clamps a negative
     * to zero and the payslip says "0 of 31 days" with no explanation of
     * where the extra came from. Capping here means the number on the
     * payslip is the number in the register.
     */
    const lopDays = Math.min(lopCentidays / 100, payableDays);
    total += lopCentidays;

    rows.push({ employeeId, payableDays, lopDays });
  }

  rows.sort((a, b) => (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0));

  return {
    rows,
    employeesWithRecords: lopByEmployee.size,
    totalLopCentidays: total,
    unexplainedAbsenceEmployeeIds: [...unexplained].sort(),
  };
}

/**
 * ⭐ THE LOSS-OF-PAY FRACTION IMPLIED BY A DAY'S VERDICT.
 *
 * ⚠️ IT IS A SUGGESTION AND NOT A RULE, which is why the column exists
 * separately and this function only proposes a default for the screen.
 * `paid_leave` with half a day of loss of pay — a full day taken against
 * half a day of balance — is real, common, and expressible only because
 * the fraction is stored rather than derived.
 */
export function defaultLopFraction(status: string): Centidays {
  switch (status) {
    case "absent":
    case "unpaid_leave":
      return 100;
    case "present":
    case "on_duty":
    case "weekly_off":
    case "holiday":
    case "paid_leave":
      return 0;
    default:
      /*
       * 🔴 AN UNKNOWN STATUS PROPOSES ZERO. The other default — dock the
       * day — would turn a future enum value somebody forgot to handle
       * into an unexplained deduction on everybody's payslip.
       */
      return 0;
  }
}
