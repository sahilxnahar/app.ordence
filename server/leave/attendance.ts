import "server-only";

/**
 * Ordence — ⭐⭐⭐ WHAT PAYROLL READS FROM THE ATTENDANCE REGISTER
 * Version: v1.46.0-alpha · Batch 59
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE EXISTS SO THAT BATCH 50 IS A SMALL CHANGE
 * ══════════════════════════════════════════════════════════════════════
 * `components/payroll/payroll-run-board.tsx` passes `attendance: []` to
 * the payroll compute. Every run therefore pays every salaried person a
 * full month whatever the register says, and loss of pay cannot be
 * entered at all.
 *
 * ⭐ `loadPayrollAttendance()` BELOW RETURNS EXACTLY THE SHAPE
 * `server/payroll/run.ts#AttendanceInput` ALREADY ACCEPTS. It takes a
 * transaction rather than opening one, so it can be called either from a
 * server action or from inside the payroll compute's own transaction —
 * and calling it from inside is the better of the two, because
 * attendance read outside the transaction that computes the run can
 * change between the read and the write.
 *
 * ⚠️ IT HOLDS NO ARITHMETIC. The fold is `summariseAttendance()` in
 * `lib/leave/attendance.ts`, which is pure and tested without a
 * database — the same split `server/payroll/run.ts` makes and for the
 * same reason: payroll arithmetic is the code most likely to be checked
 * by hand, by somebody with a calculator and a reason to care.
 */

import { and, eq, gte, lte } from "drizzle-orm";
import { withTenant } from "@/db";
import { staffAttendance } from "@/db/schema/leave";
import {
  summariseAttendance,
  type AttendanceSummary,
} from "@/lib/leave/attendance";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⭐ ONE QUERY FOR THE WHOLE RUN, NOT ONE PER EMPLOYEE.
 *
 * 🔴 A PAYROLL OF FOUR HUNDRED PEOPLE WOULD OTHERWISE ISSUE FOUR HUNDRED
 * ROUND TRIPS INSIDE A TRANSACTION, which is how a compute that took two
 * seconds starts timing out in month nine and gets "fixed" by hardcoding
 * an empty array again. That is the exact sentence `computeRun()` uses
 * about its own TDS query, and it applies here for the same reason.
 *
 * `payableDaysByEmployee` is the caller's days-on-rolls map — normally
 * the one `computeRun()` already builds with `daysOnRollsIn()`.
 * Attendance deliberately does not compute it: see the header of
 * `lib/leave/attendance.ts`.
 */
export async function loadPayrollAttendance(
  tx: Tx,
  args: {
    tenantId: string;
    /** ISO `YYYY-MM-DD`, inclusive. */
    periodStart: string;
    /** ISO `YYYY-MM-DD`, inclusive. */
    periodEnd: string;
    payableDaysByEmployee: ReadonlyMap<string, number>;
  },
): Promise<AttendanceSummary> {
  const rows = await tx
    .select({
      employeeId: staffAttendance.employeeId,
      onDate: staffAttendance.onDate,
      status: staffAttendance.status,
      lopFraction: staffAttendance.lopFraction,
    })
    .from(staffAttendance)
    .where(
      and(
        eq(staffAttendance.tenantId, args.tenantId),
        gte(staffAttendance.onDate, args.periodStart),
        lte(staffAttendance.onDate, args.periodEnd),
      ),
    );

  return summariseAttendance({
    days: rows.map((r) => ({
      employeeId: String(r.employeeId),
      onDate: String(r.onDate),
      status: String(r.status),
      lopFraction: String(r.lopFraction ?? "0"),
    })),
    payableDaysByEmployee: args.payableDaysByEmployee,
  });
}
