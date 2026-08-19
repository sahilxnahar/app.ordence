/**
 * Ordence — ⭐⭐⭐ PAYROLL RUNS
 * Version: v1.23.0-alpha · Batch 15
 *
 * ⚠️ The guard is on every action, not on this route. `listPayrollRuns`,
 * `openPayrollRun` and the rest each call `requirePermission` themselves,
 * because a server action is a POST to whatever URL the browser is on.
 */

import Link from "next/link";
import {
  listPayrollRuns,
  openPayrollRun,
  payrollAccountsNeeded,
} from "@/server/actions/payroll";
import { NewRunForm } from "@/components/payroll/new-run-form";
import { rupees } from "@/components/payroll/payroll-run-board";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payroll · Ordence" };

export default async function PayrollPage() {
  const [runs, accounts] = await Promise.all([listPayrollRuns(), payrollAccountsNeeded()]);

  if (!runs.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Payroll</h1>
        <p className="text-sm text-destructive">{runs.error}</p>
      </main>
    );
  }

  const unmapped = accounts.ok ? accounts.data.roles.filter((r) => !r.mapped) : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Payroll</h1>
        {/*
          ⭐ THE RATE TABLE IS REACHABLE FROM HERE, not only from setup.
          Setup is a place somebody visits once. A statutory rate changes
          every year and is corrected on the day somebody notices a
          payslip is wrong, which is a day they are looking at runs.
        */}
        <div className="mt-1 flex gap-3 text-xs">
          <Link href="/payroll/rates" className="underline">
            Statutory rates
          </Link>
          <Link href="/payroll/setup" className="underline">
            Setup
          </Link>
          <Link href="/payroll/employees" className="underline">
            Employees
          </Link>
          {/*
            ⭐ LEAVE IS REACHABLE FROM HERE BECAUSE ATTENDANCE IS WHAT
            MAKES A PAYSLIP SHORT. The person who has to answer "why was
            Ravi's December short two days" needs the register open beside
            the run, and a leave section a navigation away would be
            consulted after the wage bill was approved rather than before.
          */}
          <Link href="/payroll/leave" className="underline">
            Leave &amp; attendance
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          One run per month. It computes a payslip for everybody who was on the rolls during the
          period, somebody signs it off, and posting puts the gross into Salaries and Wages with
          what was withheld sitting in five payable accounts.
        </p>
      </div>

      {/*
        ⭐⭐ THE UNMAPPED ACCOUNTS ARE SHOWN BEFORE THE FIRST RUN, NOT AT
        THE MOMENT POSTING FAILS.

        ⚠️ Discovering that a ledger is missing on the day the wage bill
        is due is discovering it at the worst possible moment. The
        posting refuses the whole journal when any role is unmapped —
        correctly, because a payroll entry missing a leg does not balance
        — so the useful place to say it is here.
      */}
      {unmapped.length > 0 ? (
        <Card className="border-amber-500">
          <CardHeader>
            <CardTitle className="text-sm">
              {unmapped.length} account{unmapped.length === 1 ? "" : "s"} still to map
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <p className="text-muted-foreground">
              A run will compute and can be approved without these. It cannot be POSTED without
              them, because a payroll journal missing a leg does not balance and Ordence refuses
              the whole entry rather than writing half of it.
            </p>
            {unmapped.map((r) => (
              <div key={r.role}>
                <span className="font-medium">{r.label}</span>{" "}
                <code className="font-mono text-muted-foreground">{r.role}</code>
                <p className="text-muted-foreground">{r.help}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <NewRunForm onOpen={openPayrollRun} />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Runs</h2>
        {runs.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No payroll has been run yet. Before the first one, add your people under Employees and
            seed the pay components and statutory rates under Setup.
          </p>
        ) : null}

        <div className="space-y-2">
          {runs.data.rows.map((row) => {
            const id = String(row.id);
            const status = String(row.status);
            const problems = Number(row.problemCount ?? 0);
            return (
              <Link key={id} href={`/payroll/${id}`} className="block">
                <Card className="transition hover:border-foreground/30">
                  <CardContent className="flex flex-wrap items-center gap-2 py-3 text-sm">
                    <span className="font-medium">{String(row.runNo)}</span>
                    <Badge variant={status === "posted" ? "secondary" : "outline"}>{status}</Badge>
                    {problems > 0 ? (
                      <Badge variant="destructive">
                        {problems} problem{problems === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {String(row.periodStart)} to {String(row.periodEnd)} ·{" "}
                      {Number(row.employeeCount ?? 0)} employee
                      {Number(row.employeeCount ?? 0) === 1 ? "" : "s"}
                    </span>
                    <span className="ml-auto font-semibold">
                      {rupees(String(row.netPayMinor ?? "0"))}
                    </span>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
