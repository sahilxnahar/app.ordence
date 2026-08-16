"use client";

/**
 * Ordence — ⭐⭐⭐ A PAYROLL RUN, ON A SCREEN
 * Version: v1.23.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PROBLEMS COME FIRST, ABOVE THE MONEY
 * ══════════════════════════════════════════════════════════════════════
 * A payroll screen that leads with a big net-pay figure invites the
 * reader to check the total and approve. The figures a person can least
 * afford to be wrong about are the ones the system is UNSURE of, and
 * those are stated at the top in words before any number appears.
 *
 * ⚠️ AND THE APPROVE BUTTON IS DISABLED WHILE ANY PROBLEM REMAINS,
 * which the server re-checks anyway. The button is a courtesy; the
 * refusal in `approvePayrollRun` is the control.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 v1.47.0 (BATCH 50): THIS FILE USED TO SEND `attendance: []`
 * ══════════════════════════════════════════════════════════════════════
 * `onCompute({ runId, attendance: [] })` was hardcoded, so every run paid
 * every salaried person a full month whatever the attendance register
 * said, and loss of pay could not be entered at all. It was hardcoded
 * because there was no table to read from; migration 0082 built one.
 *
 * ⚠️ THE FIX IS NOT "SEND THE RIGHT ARRAY INSTEAD". A `"use server"`
 * export is a public endpoint, and a browser-supplied array of
 * `{employeeId, lopDays}` is a browser deciding what everybody is paid.
 * `computeRun()` reads `staff_attendance` and the approved leave register
 * itself, inside the transaction that writes the payslips, and this
 * screen's job is to SHOW that position before anybody signs it — which
 * is what `LopPositionPanel` immediately below the problems is for.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LopPositionPanel } from "@/components/payroll/lop-position";

export type PayslipView = {
  id: string;
  employeeName: string;
  employeeCode: string;
  daysInMonth: number;
  payableDays: string;
  lopDays: string;
  grossMinor: string;
  employeePfMinor: string;
  employeeEsiMinor: string;
  professionalTaxMinor: string;
  tdsMinor: string;
  otherDeductionsMinor: string;
  totalDeductionsMinor: string;
  netPayMinor: string;
  tdsIsProjection: boolean;
  tdsOverridden: boolean;
  notes: string[];
  problems: string[];
  lines: Array<{
    label: string;
    kind: string;
    amountMinor: string;
    fullMonthMinor: string;
    workingNote: string;
  }>;
};

export type RunView = {
  id: string;
  runNo: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  employeeCount: number;
  problemCount: number;
  grossMinor: string;
  netPayMinor: string;
  employerCostMinor: string;
  employeePfMinor: string;
  employerPfMinor: string;
  employerPensionMinor: string;
  employeeEsiMinor: string;
  employerEsiMinor: string;
  professionalTaxMinor: string;
  tdsMinor: string;
  approvalNote: string | null;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** ⚠️ Paise to rupees by string arithmetic, never by dividing a Number. */
export function rupees(minor: string): string {
  const value = BigInt(minor || "0");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toLocaleString("en-IN");
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${whole}.${paise}`;
}

export function PayrollRunBoard({
  run,
  slips,
  canManage,
  canApprove,
  canPost,
  onCompute,
  onApprove,
  onPost,
  onCancel,
}: {
  run: RunView;
  slips: PayslipView[];
  canManage: boolean;
  canApprove: boolean;
  canPost: boolean;
  /**
   * ⚠️ TAKES A RUN AND NOTHING ELSE. It used to take `attendance` as
   * well — see the header. The register is read on the server.
   */
  onCompute: (input: { runId: string }) => Promise<
    Result<{ employeeCount: number; problemCount: number; note: string }>
  >;
  onApprove: (input: { runId: string; note: string }) => Promise<Result<{ note: string }>>;
  onPost: (input: { runId: string }) => Promise<Result<{ note: string }>>;
  onCancel: (input: { runId: string; reason: string }) => Promise<Result<{ note: string }>>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState<"approve" | "cancel" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /**
   * ⚠️ `router.refresh()` RE-RENDERS THE SERVER COMPONENTS AND DOES NOT
   * RE-RUN A CLIENT COMPONENT'S OWN FETCH. Without this counter the
   * loss-of-pay panel would keep showing the position from before the
   * recompute, which is the one moment somebody is looking at it.
   */
  const [lopKey, setLopKey] = useState(0);

  const withProblems = slips.filter((s) => s.problems.length > 0);
  const editable = run.status === "draft" || run.status === "computed";

  function act<T>(promise: Promise<Result<T>>, success: (data: T) => string) {
    startTransition(async () => {
      const result = await promise;
      if (result.ok) {
        setOpen(null);
        setNote("");
        setReason("");
        toast.success(success(result.data));
        setLopKey((k) => k + 1);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------- */}
      {/* 🔴 PROBLEMS, BEFORE ANY FIGURE                              */}
      {/* ---------------------------------------------------------- */}
      {withProblems.length > 0 ? (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              {withProblems.length} payslip{withProblems.length === 1 ? "" : "s"} cannot be paid as
              they stand
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            {withProblems.map((s) => (
              <div key={s.id}>
                <div className="font-medium">
                  {s.employeeName} <span className="text-muted-foreground">{s.employeeCode}</span>
                </div>
                {s.problems.map((p) => (
                  <p key={p} className="text-muted-foreground">
                    {p}
                  </p>
                ))}
              </div>
            ))}
            <p className="border-t pt-2 text-muted-foreground">
              A run cannot be approved while any of these remain. Every one is a figure nothing in
              this system stands behind, and approving past it means somebody is paid a number
              nobody can defend.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------- */}
      {/* 🔴 THE LOSS-OF-PAY POSITION, BEFORE THE MONEY AND BEFORE     */}
      {/* THE APPROVE BUTTON. Rendered whether or not anybody is       */}
      {/* losing pay: a panel that appears only when there is          */}
      {/* something to see teaches the reader that its absence means   */}
      {/* nothing happened, and the state this batch exists to make    */}
      {/* visible is the one where nothing was recorded at all.        */}
      {/* ---------------------------------------------------------- */}
      <LopPositionPanel runId={run.id} refreshKey={lopKey} />

      {/* ---------------------------------------------------------- */}
      {/* THE TOTALS                                                  */}
      {/* ---------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <span>{run.runNo}</span>
            <Badge variant={run.status === "posted" ? "secondary" : "outline"}>{run.status}</Badge>
            <span className="text-xs font-normal text-muted-foreground">
              {run.periodStart} to {run.periodEnd} · {run.employeeCount} employee
              {run.employeeCount === 1 ? "" : "s"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Gross earnings</dt>
              <dd className="text-lg font-semibold">{rupees(run.grossMinor)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Net payable</dt>
              <dd className="text-lg font-semibold">{rupees(run.netPayMinor)}</dd>
            </div>
            <div>
              {/*
                ⭐ COST TO COMPANY, WHICH IS NOT THE GROSS. The employer's
                own PF, pension, EDLI and ESI sit on top and add roughly a
                seventh to the wage bill. A screen showing only gross
                under-states what the month actually costs.
              */}
              <dt className="text-xs text-muted-foreground">Cost to the business</dt>
              <dd className="text-lg font-semibold">{rupees(run.employerCostMinor)}</dd>
            </div>
          </dl>

          <div className="grid gap-2 border-t pt-3 text-xs sm:grid-cols-2">
            <Figure label="Employee PF" value={run.employeePfMinor} />
            <Figure label="Employer PF" value={run.employerPfMinor} />
            <Figure label="Pension (EPS)" value={run.employerPensionMinor} />
            <Figure label="Employee ESI" value={run.employeeEsiMinor} />
            <Figure label="Employer ESI" value={run.employerEsiMinor} />
            <Figure label="Professional tax" value={run.professionalTaxMinor} />
            <Figure label="TDS on salary" value={run.tdsMinor} />
          </div>

          {run.approvalNote ? (
            <p className="rounded border p-2 text-xs">
              <span className="text-muted-foreground">Approved: </span>
              {run.approvalNote}
            </p>
          ) : null}

          {/* ---- The actions ------------------------------------- */}
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {editable && canManage ? (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => act(onCompute({ runId: run.id }), (d) => d.note)}
              >
                {run.status === "draft" ? "Compute" : "Recompute"}
              </Button>
            ) : null}

            {run.status === "computed" && canApprove ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || run.problemCount > 0}
                title={
                  run.problemCount > 0
                    ? "Every payslip problem has to be resolved first."
                    : undefined
                }
                onClick={() => setOpen("approve")}
              >
                Approve
              </Button>
            ) : null}

            {run.status === "approved" && canPost ? (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => act(onPost({ runId: run.id }), (d) => d.note)}
              >
                Post to the ledger
              </Button>
            ) : null}

            {run.status !== "posted" && run.status !== "cancelled" && canApprove ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => setOpen("cancel")}
              >
                Cancel this run
              </Button>
            ) : null}
          </div>

          {open === "approve" ? (
            <div className="space-y-2 rounded border p-3">
              <p className="text-xs text-muted-foreground">
                You are signing off what everybody is paid this month. Once approved the payslips
                are frozen — the database refuses a change to any of them, and a correction means
                cancelling this run and raising another.
              </p>
              <Textarea
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What did you check? Ten characters minimum, and in six months this is the only record of why."
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => act(onApprove({ runId: run.id, note }), (d) => d.note)}
                >
                  Approve the wage bill
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {open === "cancel" ? (
            <div className="space-y-2 rounded border p-3">
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this run being abandoned? The run stays on the record with this reason."
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => act(onCancel({ runId: run.id, reason }), (d) => d.note)}
                >
                  Cancel the run
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------- */}
      {/* THE PAYSLIPS                                                */}
      {/* ---------------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Payslips ({slips.length})</h2>
        {slips.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing computed yet. Press Compute and every employee who was on the rolls during this
            period gets a payslip.
          </p>
        ) : null}

        {slips.map((slip) => (
          <Card key={slip.id} data-testid={`payslip-${slip.employeeCode}`}>
            <CardContent className="space-y-2 pt-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{slip.employeeName}</span>
                <span className="text-xs text-muted-foreground">{slip.employeeCode}</span>
                {slip.problems.length > 0 ? <Badge variant="destructive">problem</Badge> : null}
                {slip.tdsOverridden ? <Badge variant="outline">tax overridden</Badge> : null}
                <span className="ml-auto font-semibold">{rupees(slip.netPayMinor)}</span>
              </div>

              <p className="text-xs text-muted-foreground">
                {slip.payableDays} of {slip.daysInMonth} days paid
                {Number(slip.lopDays) > 0 ? ` · ${slip.lopDays} loss of pay` : ""} · gross{" "}
                {rupees(slip.grossMinor)} · deductions {rupees(slip.totalDeductionsMinor)}
              </p>

              {expanded === slip.id ? (
                <div className="space-y-2 rounded border p-3 text-xs">
                  <table className="w-full">
                    <tbody>
                      {slip.lines.map((line, i) => (
                        <tr key={`${line.label}-${i}`} className="border-b last:border-0">
                          <td className="py-1">
                            {line.label}
                            {/*
                              ⭐ THE WORKING, PRINTED. An employee with a
                              calculator will find a one-rupee difference
                              and they are right to raise it; this line
                              answers them without anybody re-deriving it.
                            */}
                            <div className="text-muted-foreground">{line.workingNote}</div>
                          </td>
                          <td className="py-1 text-right align-top">
                            {line.kind === "deduction" ? "−" : ""}
                            {rupees(line.amountMinor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <dl className="grid grid-cols-2 gap-1 border-t pt-2">
                    <dt className="text-muted-foreground">Provident fund</dt>
                    <dd className="text-right">{rupees(slip.employeePfMinor)}</dd>
                    <dt className="text-muted-foreground">ESI</dt>
                    <dd className="text-right">{rupees(slip.employeeEsiMinor)}</dd>
                    <dt className="text-muted-foreground">Professional tax</dt>
                    <dd className="text-right">{rupees(slip.professionalTaxMinor)}</dd>
                    <dt className="text-muted-foreground">
                      Income tax{slip.tdsIsProjection ? " (estimate)" : ""}
                    </dt>
                    <dd className="text-right">{rupees(slip.tdsMinor)}</dd>
                  </dl>

                  {slip.notes.map((n) => (
                    <p key={n} className="text-muted-foreground">
                      {n}
                    </p>
                  ))}
                  {slip.problems.map((p) => (
                    <p key={p} className="text-destructive">
                      {p}
                    </p>
                  ))}
                </div>
              ) : null}

              <Button
                size="sm"
                variant="ghost"
                onClick={() => setExpanded(expanded === slip.id ? null : slip.id)}
              >
                {expanded === slip.id ? "Hide the working" : "Show the working"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{rupees(value)}</span>
    </div>
  );
}
