/**
 * Ordence — ⭐⭐⭐ ONE PAYROLL RUN
 * Version: v1.23.0-alpha · Batch 15
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  approvePayrollRun,
  cancelPayrollRun,
  computePayrollRun,
  getPayrollRun,
  postPayroll,
} from "@/server/actions/payroll";
import {
  PayrollRunBoard,
  type PayslipView,
  type RunView,
} from "@/components/payroll/payroll-run-board";
import { checkPermission } from "@/server/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payroll run · Ordence" };

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "");
}

export default async function PayrollRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getPayrollRun(id);

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Payroll run</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  if (!result.data.run) notFound();
  const r = result.data.run;

  /*
    ⚠️ THE BUTTONS ARE HIDDEN AS A COURTESY, NOT AS A CONTROL. Every one
    of these actions re-checks its own permission on the server, because
    a server action is a public endpoint whether or not a button exists.
  */
  const [manage, approve, post] = await Promise.all([
    checkPermission("payroll.manage"),
    checkPermission("payroll.approve"),
    checkPermission("payroll.post"),
  ]);

  const run: RunView = {
    id: String(r.id),
    runNo: String(r.runNo),
    periodStart: iso(r.periodStart),
    periodEnd: iso(r.periodEnd),
    status: String(r.status),
    employeeCount: Number(r.employeeCount ?? 0),
    problemCount: Number(r.problemCount ?? 0),
    grossMinor: String(r.grossMinor ?? "0"),
    netPayMinor: String(r.netPayMinor ?? "0"),
    employerCostMinor: String(r.employerCostMinor ?? "0"),
    employeePfMinor: String(r.employeePfMinor ?? "0"),
    employerPfMinor: String(r.employerPfMinor ?? "0"),
    employerPensionMinor: String(r.employerPensionMinor ?? "0"),
    employeeEsiMinor: String(r.employeeEsiMinor ?? "0"),
    employerEsiMinor: String(r.employerEsiMinor ?? "0"),
    professionalTaxMinor: String(r.professionalTaxMinor ?? "0"),
    tdsMinor: String(r.tdsMinor ?? "0"),
    approvalNote: r.approvalNote === null || r.approvalNote === undefined ? null : String(r.approvalNote),
  };

  const slips: PayslipView[] = result.data.slips.map((s) => ({
    id: String(s.id),
    employeeName: String(s.employeeName),
    employeeCode: String(s.employeeCode),
    daysInMonth: Number(s.daysInMonth ?? 30),
    payableDays: String(s.payableDays ?? "0"),
    lopDays: String(s.lopDays ?? "0"),
    grossMinor: String(s.grossMinor ?? "0"),
    employeePfMinor: String(s.employeePfMinor ?? "0"),
    employeeEsiMinor: String(s.employeeEsiMinor ?? "0"),
    professionalTaxMinor: String(s.professionalTaxMinor ?? "0"),
    tdsMinor: String(s.tdsMinor ?? "0"),
    otherDeductionsMinor: String(s.otherDeductionsMinor ?? "0"),
    totalDeductionsMinor: String(s.totalDeductionsMinor ?? "0"),
    netPayMinor: String(s.netPayMinor ?? "0"),
    tdsIsProjection: Boolean(s.tdsIsProjection),
    tdsOverridden: Boolean(s.tdsOverridden),
    notes: Array.isArray(s.notes) ? (s.notes as string[]) : [],
    problems: Array.isArray(s.problems) ? (s.problems as string[]) : [],
    lines: Array.isArray(s.lines)
      ? (s.lines as Array<Record<string, unknown>>).map((l) => ({
          label: String(l.label ?? ""),
          kind: String(l.kind ?? "earning"),
          amountMinor: String(l.amountMinor ?? "0"),
          fullMonthMinor: String(l.fullMonthMinor ?? "0"),
          workingNote: String(l.workingNote ?? ""),
        }))
      : [],
  }));

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link href="/payroll" className="text-xs underline">
          All runs
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Payroll {run.runNo}</h1>
      </div>

      <PayrollRunBoard
        run={run}
        slips={slips}
        canManage={manage.allowed}
        canApprove={approve.allowed}
        canPost={post.allowed}
        onCompute={computePayrollRun}
        onApprove={approvePayrollRun}
        onPost={postPayroll}
        onCancel={cancelPayrollRun}
      />
    </main>
  );
}
