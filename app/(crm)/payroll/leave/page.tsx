/**
 * Ordence — ⭐⭐⭐ LEAVE AND ATTENDANCE
 * Version: v1.46.0-alpha · Batch 59
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS LIVES UNDER `/payroll` AND NOT UNDER A NEW `/hr`
 * ══════════════════════════════════════════════════════════════════════
 * There is no `/hr` section in this product, and inventing one for a
 * single screen would put leave in a place with no other tenants and no
 * entry in the module registry. Leave belongs beside payroll for a
 * substantive reason as well as a routing one: the only thing recorded
 * here that leaves the module is loss of pay, and it leaves it in the
 * direction of a payslip. The person reconciling "why was Ravi's December
 * short" needs both screens open, and two top-level sections would put
 * them a navigation apart.
 *
 * 🔴 THAT IS NOT THE SAME AS SAYING LEAVE IS A PAYROLL PERMISSION. It is
 * deliberately not — `server/actions/leave.ts` has five keys of its own,
 * and a line manager approving three days off must not thereby be able
 * to read everybody's salary.
 */

import Link from "next/link";
import {
  decideLeaveRequest,
  listLeaveBalances,
  listLeaveRequests,
  listLeaveSetup,
  recordAttendance,
  runLeaveAccrual,
  seedLeaveSetup,
} from "@/server/actions/leave";
import { listEmployees } from "@/server/actions/payroll";
import {
  LeaveBoard,
  type BalanceRow,
  type LeaveTypeRow,
  type PeriodRow,
  type RequestRow,
} from "@/components/leave/leave-board";
import {
  AttendanceGrid,
  type LeaveTypeOption,
  type StaffRow,
} from "@/components/leave/attendance-grid";
import { checkPermission } from "@/server/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leave · Ordence" };

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "");
}

export default async function LeavePage() {
  const [setup, requests, manage, approve, record] = await Promise.all([
    listLeaveSetup(),
    listLeaveRequests({}),
    checkPermission("leave.manage"),
    checkPermission("leave.approve"),
    checkPermission("attendance.record"),
  ]);

  if (!setup.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Leave</h1>
        <p className="text-sm text-destructive">{setup.error}</p>
      </main>
    );
  }

  const types: LeaveTypeRow[] = setup.data.types.map((t) => ({
    id: String(t.id),
    code: String(t.code),
    label: String(t.label),
    isPaid: Boolean(t.isPaid),
    accrualMethod: String(t.accrualMethod ?? "monthly_earned"),
    annualEntitlementDays: String(t.annualEntitlementDays ?? "0"),
    carryForwardCapDays: String(t.carryForwardCapDays ?? "0"),
    encashmentCapDays: String(t.encashmentCapDays ?? "0"),
    countsHolidaysAndOffs: Boolean(t.countsHolidaysAndOffs),
  }));

  const periods: PeriodRow[] = setup.data.periods.map((p) => ({
    id: String(p.id),
    label: String(p.label),
    startsOn: iso(p.startsOn),
    endsOn: iso(p.endsOn),
    isClosed: Boolean(p.isClosed),
  }));

  /**
   * ⚠️ THE OPEN LEAVE YEAR, OR THE MOST RECENT ONE. Balances are always
   * per leave year — a balance summed across years would add days that
   * lapsed to days that carried and produce a number nobody owes.
   */
  const currentPeriod = periods.find((p) => !p.isClosed) ?? periods[0] ?? null;
  const balanceResult = currentPeriod
    ? await listLeaveBalances({ periodId: currentPeriod.id })
    : null;

  const balances: BalanceRow[] =
    balanceResult && balanceResult.ok
      ? balanceResult.data.rows.map((b) => ({
          employeeId: String(b.employeeId),
          employeeCode: String(b.employeeCode),
          fullName: String(b.fullName),
          code: String(b.code),
          accruedDays: String(b.accruedDays),
          carriedInDays: String(b.carriedInDays),
          takenDays: String(b.takenDays),
          lapsedDays: String(b.lapsedDays),
          balanceDays: String(b.balanceDays),
          committedDays: String(b.committedDays),
          availableDays: String(b.availableDays),
        }))
      : [];

  const requestRows: RequestRow[] = requests.ok
    ? requests.data.rows.map((r) => ({
        id: String(r.id),
        fullName: String(r.fullName),
        employeeCode: String(r.employeeCode),
        code: String(r.code),
        fromOn: iso(r.fromOn),
        toOn: iso(r.toOn),
        days: String(r.days),
        status: String(r.status),
        reason: r.reason ? String(r.reason) : null,
        decisionNote: r.decisionNote ? String(r.decisionNote) : null,
      }))
    : [];

  const people = await listEmployees();
  const staff: StaffRow[] = people.ok
    ? people.data.rows.map((e) => ({
        id: String(e.id),
        employeeCode: String(e.employeeCode),
        fullName: String(e.fullName),
      }))
    : [];

  const typeOptions: LeaveTypeOption[] = types.map((t) => ({
    id: t.id,
    code: t.code,
    label: t.label,
    isPaid: t.isPaid,
  }));

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <Link href="/payroll" className="text-xs underline">
          Payroll
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Leave</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Leave is earned, not granted: somebody who joined in October has earned a part year by
          March and not a whole one. Every balance on this page is the sum of the entries behind
          it — there is no stored number that can drift from the ledger and be argued about.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          <Link href="/payroll/leave/me" className="underline">
            Your own leave
          </Link>{" "}
          is a separate screen, and it shows you nobody else&apos;s.
        </p>
      </div>

      <LeaveBoard
        types={types}
        periods={periods}
        balances={balances}
        requests={requestRows}
        canManage={manage.allowed}
        canApprove={approve.allowed}
        onSeed={seedLeaveSetup}
        onAccrue={runLeaveAccrual}
        onDecide={decideLeaveRequest}
      />

      {/*
        🔴 THE ATTENDANCE GRID IS ON THE SAME PAGE AS THE BALANCES ON
        PURPOSE. The two are constantly confused — "he was approved for
        three days" and "he was away for three days" are different facts —
        and putting them side by side is the cheapest way to make the
        difference visible to whoever is recording it.
      */}
      {staff.length > 0 ? (
        <AttendanceGrid
          staff={staff}
          leaveTypes={typeOptions}
          canRecord={record.allowed}
          onRecord={recordAttendance}
        />
      ) : (
        <p className="rounded border border-amber-500 p-3 text-sm">
          There are no employees yet, so there is nobody to record attendance for.{" "}
          <Link href="/payroll/employees" className="underline">
            Add employees
          </Link>{" "}
          first.
        </p>
      )}
    </main>
  );
}
