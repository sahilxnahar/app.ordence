/**
 * Ordence — ⭐⭐ AN EMPLOYEE'S OWN LEAVE
 * Version: v1.46.0-alpha · Batch 59
 *
 * ⚠️ A SEPARATE SCREEN FROM `/payroll/leave`, AND THE SEPARATION IS THE
 * CONTROL.
 *
 * 🔴 ONE PAGE THAT WIDENS FOR PRIVILEGED CALLERS IS THE BUG THIS
 * ARRANGEMENT AVOIDS. Two code paths — "everybody, if you hold the key"
 * and "only me, always" — inside one screen means the narrow path is one
 * boolean away from the wide one, and that boolean is computed from a
 * role that an impersonation, a permission override or a seeded fixture
 * can flip. `myLeaveOverview()` takes no arguments and scopes in its
 * WHERE clause; the register lives somewhere else entirely. The same
 * argument `server/actions/payroll-self.ts` makes about payslips.
 */

import Link from "next/link";
import { cancelLeaveRequest, myLeaveOverview, submitLeaveRequest } from "@/server/actions/leave";
import { MyLeave, type MyBalance, type MyRequest } from "@/components/leave/my-leave";

export const dynamic = "force-dynamic";
export const metadata = { title: "My leave · Ordence" };

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "");
}

export default async function MyLeavePage() {
  const overview = await myLeaveOverview();

  if (!overview.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">My leave</h1>
        <p className="text-sm text-destructive">{overview.error}</p>
      </main>
    );
  }

  const balances: MyBalance[] = overview.data.balances.map((b) => ({
    leaveTypeId: String(b.leaveTypeId),
    code: String(b.code),
    label: String(b.label),
    balanceDays: String(b.balanceDays),
    committedDays: String(b.committedDays),
    availableDays: String(b.availableDays),
  }));

  const requests: MyRequest[] = overview.data.requests.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    fromOn: iso(r.fromOn),
    toOn: iso(r.toOn),
    days: String(r.days),
    status: String(r.status),
    decisionNote: r.decisionNote ? String(r.decisionNote) : null,
  }));

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <Link href="/payroll/leave" className="text-xs underline">
          Leave
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">My leave</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your own balances and applications. This screen shows nobody else&apos;s.
        </p>
      </div>

      <MyLeave
        balances={balances}
        requests={requests}
        linked={overview.data.linked}
        onSubmit={submitLeaveRequest}
        onCancel={cancelLeaveRequest}
      />
    </main>
  );
}
