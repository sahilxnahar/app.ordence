"use client";

/**
 * Ordence — ⭐⭐⭐ MY PAYSLIPS, FOR THE PERSON THEY BELONG TO
 * Version: v1.43.0-alpha · Batch 107
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS IS A DIFFERENT DOCUMENT FROM `payroll-run-board.tsx`, NOT A
 *    NARROWER ONE
 * ══════════════════════════════════════════════════════════════════════
 * The run board is a control screen. It leads with the problems, because
 * its reader is deciding whether to approve a wage bill and the figures
 * they can least afford to be wrong about are the ones the system is
 * unsure of.
 *
 * This screen has one reader, they are not deciding anything, and they
 * came to answer one of four questions: what am I being paid, what was
 * taken off it, why, and is the PAN you have for me right. So the order
 * is theirs — the month, then the net, then the working, then the
 * caveats — and nothing is offered that they cannot act on.
 *
 * ⚠️ THE EMPLOYER'S OWN CONTRIBUTIONS ARE NOT ON THIS SCREEN, AND THAT
 * IS DELIBERATE. Employer PF, pension, EDLI, administration and ESI are
 * a cost to the company. They never appear on a payslip, they are not
 * money the employee is owed, and putting them here would invite the
 * reading that the deductions column is bigger than it is.
 *
 * 🔴 AND THERE IS NO EMPLOYEE PICKER, NO SEARCH AND NO ID IN THE URL.
 * `myPayslips()` takes no arguments; this component renders whatever
 * that call returned and has no way to ask for anybody else. See the
 * header of `server/actions/payroll-self.ts` for why that is the design
 * rather than an omission.
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { rupees } from "@/components/payroll/payroll-run-board";
import { PayslipCaveats } from "@/components/payroll/payslip-caveats";
import type { SelfPayslipView, SelfServiceView } from "@/server/actions/payroll-self";

/**
 * ⚠️ THE MONTH, NOT THE RUN NUMBER, IS WHAT THE EMPLOYEE LOOKS FOR.
 * `PR-202603` is the payroll team's handle for a batch. Nobody asks for
 * their PR-202603 payslip.
 */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(periodEnd: string): string {
  const month = Number(periodEnd.slice(5, 7));
  return `${MONTHS[month - 1] ?? periodEnd.slice(5, 7)} ${periodEnd.slice(0, 4)}`;
}

export function MyPayslips({ view }: { view: SelfServiceView }) {
  const [open, setOpen] = useState<string | null>(view.payslips[0]?.id ?? null);

  /*
    ══════════════════════════════════════════════════════════════════
    🔴 NO LINKED EMPLOYEE RECORD — EXPLAINED, NOT RENDERED EMPTY
    ══════════════════════════════════════════════════════════════════
    `employees.userId` is nullable and the schema is blunt about why:
    most people on a payroll never sign in, and half the people who sign
    in are not on the payroll. So a signed-in user with no employee row
    is an ordinary state, not an error — a contractor, a director, an
    admin account.

    ⚠️ AN EMPTY LIST WOULD BE READ AS "PAYROLL HAS LOST MY PAYSLIPS",
    which sends a message to HR that nobody can answer without opening
    the database. The distinction that matters to the reader is between
    "you have none" and "we do not know which of these people is you",
    and only the second has an action attached to it.
  */
  if (!view.linked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">This account is not linked to an employee record</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Ordence keeps sign-in accounts and employee records separate on purpose — most
            people on a payroll never sign in, and plenty of people who sign in are not on the
            payroll. Nothing here is missing; the two have simply not been connected.
          </p>
          <p>
            Ask whoever runs payroll to link your employee record to this sign-in. Until they
            do, no payslip can be shown here, because there is no safe way for Ordence to guess
            which employee you are.
          </p>
        </CardContent>
      </Card>
    );
  }

  const me = view.employee;

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------- */}
      {/* ① WHO ORDENCE THINKS YOU ARE                                */}
      {/* ---------------------------------------------------------- */}
      {me ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Your record</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-base font-semibold">{me.fullName}</span>
              <code className="font-mono text-xs text-muted-foreground">{me.employeeCode}</code>
              {me.designation ? (
                <span className="text-xs text-muted-foreground">{me.designation}</span>
              ) : null}
              {me.department ? <Badge variant="outline">{me.department}</Badge> : null}
            </div>

            <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
              <Field label="Joined" value={me.joinedOn} />
              {me.leftOn ? <Field label="Left" value={me.leftOn} /> : null}
              {/*
                ⚠️ THE WORK STATE IS SHOWN BECAUSE IT IS WHAT DRIVES
                PROFESSIONAL TAX. An employee in Mumbai working for a
                Bengaluru company owes Maharashtra PT, and the first sign
                that the record is wrong is a deduction they do not
                recognise. Nobody can query it if it is not on screen.
              */}
              <Field label="Work State" value={me.workStateCode} />
              {/*
                ⭐ PAN AND UAN IN FULL, DELIBERATELY. These are the
                employee's own identifiers, and the whole reason to show
                them is so a wrong one is caught NOW rather than in June
                when Form 16 does not match 26AS. Masking would make the
                field decoration.
              */}
              <Field label="PAN" value={me.pan ?? "not recorded"} mono />
              <Field label="UAN" value={me.uan ?? "not recorded"} mono />
              <Field label="ESIC" value={me.esicNumber ?? "not recorded"} mono />
              <Field label="Tax regime" value={me.taxRegime === "old" ? "Old" : "New"} />
              <Field
                label="Declared investments"
                value={rupees(me.declaredDeductionsMinor)}
              />
            </dl>

            {/*
              ⚠️ THE NEW REGIME IGNORES DECLARED INVESTMENTS ENTIRELY, and
              an employee who has declared ₹1,50,000 of 80C and is on the
              new regime is being shown a figure that changes nothing.
              `projectMonthlyTds` already says so in a caveat on the
              payslip; saying it beside the field is what stops somebody
              declaring more in the belief it will help.
            */}
            {me.taxRegime === "new" && BigInt(me.declaredDeductionsMinor || "0") > 0n ? (
              <p className="text-xs text-muted-foreground">
                You are on the new regime, which does not allow Chapter VI-A deductions, so the
                declared amount above does not reduce your tax. If that is not what you intended,
                the regime is the thing to change, not the declaration.
              </p>
            ) : null}

            {me.pan === null ? (
              <p className="text-xs text-destructive">
                No PAN is recorded against your employee record. Tax deducted without one cannot
                be credited to you, and section 206AA requires a higher rate — Ordence refuses to
                apply it automatically rather than guessing. Give payroll your PAN.
              </p>
            ) : null}

            {me.tdsOverridden ? (
              <p className="text-xs text-muted-foreground">
                Your income tax is set to a figure your accountant entered by hand rather than one
                Ordence projected.
              </p>
            ) : null}

            {/*
              ⚠️ TWO EMPLOYEE RECORDS ON ONE SIGN-IN. Both are this
              person — that is what the link means — so both are shown.
              It is still worth naming, because it is usually a rehire
              that was entered as a new person and it will confuse the
              PF and the Form 16 long before it confuses this screen.
            */}
            {view.duplicateLink ? (
              <p className="text-xs text-muted-foreground">
                More than one employee record is linked to this sign-in, so the payslips below span
                all of them. That is usually a rehire entered under a second employee code — worth
                mentioning to payroll.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------- */}
      {/* ② THE YEAR SO FAR                                           */}
      {/* ---------------------------------------------------------- */}
      {/*
        ⭐ THE FINANCIAL YEAR IS NAMED, NOT ASSUMED. It runs April to
        March, it is the year the tax figures actually belong to, and the
        totals cover only approved and posted payslips — which is
        precisely the set `tdsDeductedThisFy()` counts when it works out
        how much more to withhold. An employee comparing this to their
        Form 16 should find the same number.
      */}
      {view.ytd && view.fyLabel ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              Financial year {view.fyLabel} so far — {view.ytd.months} month
              {view.ytd.months === 1 ? "" : "s"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
              <Field label="Gross earnings" value={rupees(view.ytd.grossMinor)} />
              <Field label="Provident fund" value={rupees(view.ytd.employeePfMinor)} />
              <Field label="ESI" value={rupees(view.ytd.employeeEsiMinor)} />
              <Field label="Professional tax" value={rupees(view.ytd.professionalTaxMinor)} />
              <Field label="Income tax deducted" value={rupees(view.ytd.tdsMinor)} />
              <Field label="Net paid" value={rupees(view.ytd.netPayMinor)} strong />
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              Counts only payslips from a run that has been signed off. Anything still being
              prepared is left out, because its figures can still change.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------- */}
      {/* ③ THE PAYSLIPS                                              */}
      {/* ---------------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Payslips</h2>

        {view.payslips.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You have no signed-off payslips yet. A payslip appears here once the month&rsquo;s
            payroll has been approved.
          </p>
        ) : null}

        {/*
          ══════════════════════════════════════════════════════════
          ⭐ A RUN STILL BEING PREPARED IS ANNOUNCED, WITHOUT FIGURES
          ══════════════════════════════════════════════════════════
          🔴 The count comes from the server and the amounts deliberately
          do not. A `draft` or `computed` run is a calculation somebody is
          still editing — a recompute replaces every payslip in it, and
          attendance corrections and backdated raises are ordinary
          reasons to recompute. An employee who sees a net pay that later
          changes has been told something untrue about their own money,
          and has planned around it.

          ⚠️ SILENCE WOULD BE THE OTHER MISTAKE. An empty March reads as
          "payroll forgot me". "It is being prepared" is the true answer
          and is not a number anybody can act on.
        */}
        {view.awaitingApproval > 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-3 text-xs text-muted-foreground">
              {view.awaitingApproval} payslip{view.awaitingApproval === 1 ? " is" : "s are"}{" "}
              being prepared and {view.awaitingApproval === 1 ? "is" : "are"} not shown. Figures
              in a run that has not been signed off can still change, so Ordence does not show
              them — you will see them here once the run is approved.
            </CardContent>
          </Card>
        ) : null}

        <div className="space-y-2">
          {view.payslips.map((slip) => (
            <PayslipCard
              key={slip.id}
              slip={slip}
              expanded={open === slip.id}
              onToggle={() => setOpen(open === slip.id ? null : slip.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PayslipCard({
  slip,
  expanded,
  onToggle,
}: {
  slip: SelfPayslipView;
  expanded: boolean;
  onToggle: () => void;
}) {
  const earnings = slip.lines.filter((l) => l.kind === "earning");
  const deductions = slip.lines.filter((l) => l.kind === "deduction");

  return (
    <Card>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-2 p-4 text-left text-sm"
        aria-expanded={expanded}
      >
        <span className="font-medium">{monthLabel(slip.periodEnd)}</span>
        {/*
          ⚠️ THE STATUS IS SHOWN, THOUGH IT CAN ONLY EVER BE ONE OF TWO
          VALUES HERE. "Posted" means the wage bill is in the books;
          "approved" means it is signed off and not yet posted. Both are
          final as far as the employee is concerned, and showing the
          difference costs nothing while a hidden state invites the
          question of what else is hidden.
        */}
        <Badge variant={slip.status === "posted" ? "secondary" : "outline"}>{slip.status}</Badge>
        {slip.problems.length > 0 ? <Badge variant="destructive">check this</Badge> : null}
        <span className="text-xs text-muted-foreground">
          {slip.payableDays} of {slip.daysInMonth} days
          {/*
            ⚠️ `Number` HERE AND NOWHERE NEAR THE MONEY. Days are a
            `numeric(6,2)` count that can legitimately be a half — the
            string-splitting rule exists because paise in a float lose
            precision at scale, and a day count never approaches it.
            Using bigint here would silently drop half-day loss of pay.
          */}
          {Number(slip.lopDays) > 0 ? ` · ${slip.lopDays} unpaid` : ""}
        </span>
        <span className="ml-auto text-right">
          <span className="block text-xs text-muted-foreground">Net pay</span>
          <span className="font-semibold">{rupees(slip.netPayMinor)}</span>
        </span>
      </button>

      {expanded ? (
        <CardContent className="space-y-4 border-t pt-4">
          {/*
            🔴 NOTHING IS NETTED. Gross and total deductions are two
            numbers that both appear, and every line shows how it was
            arrived at. `lib/payroll/payslip.ts` keeps the working for
            exactly this moment: a payslip is the one document in the
            product that a person checks by hand, and an employee with a
            calculator who finds a one-rupee difference is right to raise
            it. A screen that showed only the net would make that
            impossible to check and impossible to answer.
          */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold">Earnings</p>
              <ul className="mt-1 space-y-1">
                {earnings.map((l) => (
                  <li key={l.label} className="text-xs">
                    <span className="flex justify-between gap-4">
                      <span>{l.label}</span>
                      <span className="font-mono">{rupees(l.amountMinor)}</span>
                    </span>
                    {/*
                      ⭐ THE WORKING, IN WORDS. "18 of 31 days paid (3
                      days loss of pay)" answers the query by being read
                      instead of by somebody re-deriving it.
                    */}
                    <span className="text-muted-foreground">{l.workingNote}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 flex justify-between gap-4 border-t pt-1 text-xs font-semibold">
                <span>Gross</span>
                <span className="font-mono">{rupees(slip.grossMinor)}</span>
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold">Deductions</p>
              <ul className="mt-1 space-y-1 text-xs">
                <Row label="Provident fund" minor={slip.employeePfMinor} />
                <Row label="ESI" minor={slip.employeeEsiMinor} />
                <Row label="Professional tax" minor={slip.professionalTaxMinor} />
                <Row label="Income tax (TDS)" minor={slip.tdsMinor} />
                {deductions.map((l) => (
                  <Row key={l.label} label={l.label} minor={l.amountMinor} />
                ))}
              </ul>
              <p className="mt-2 flex justify-between gap-4 border-t pt-1 text-xs font-semibold">
                <span>Total deductions</span>
                <span className="font-mono">{rupees(slip.totalDeductionsMinor)}</span>
              </p>
              <p className="mt-2 flex justify-between gap-4 border-t pt-1 text-sm font-semibold">
                <span>Net pay</span>
                <span className="font-mono">{rupees(slip.netPayMinor)}</span>
              </p>
            </div>
          </div>

          {/*
            ⭐⭐⭐ THE CAVEATS. Not an afterthought and not collapsed —
            see the header of `payslip-caveats.tsx`. The engine refuses
            to guess at surcharge and says so; that sentence has to reach
            the person it is about.
          */}
          <PayslipCaveats
            notes={slip.notes}
            problems={slip.problems}
            tdsIsProjection={slip.tdsIsProjection}
            tdsOverridden={slip.tdsOverridden}
          />

          <p className="text-xs text-muted-foreground">
            Payroll reference {slip.runNo} · {slip.periodStart} to {slip.periodEnd} · issued to{" "}
            {slip.employeeName} ({slip.employeeCode}).
            {/*
              ⚠️ THE NAME COMES FROM THE PAYSLIP ROW, NOT FROM THE
              EMPLOYEE RECORD. `payslips` freezes the name and code at
              compute time so a payslip reissued after a name change
              still matches the one the employee is holding. Joining to
              `employees` here would quietly show today's name on an old
              document.
            */}
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function Row({ label, minor }: { label: string; minor: string }) {
  /*
    ⚠️ ZERO LINES ARE KEPT, NOT DROPPED. `lib/payroll/payslip.ts` makes
    the same choice for the same reason: a payslip that silently omits
    "ESI — ₹0" because there was none this month looks like something was
    taken away, and the absence is exactly what somebody wants explained.
  */
  return (
    <li className="flex justify-between gap-4">
      <span>{label}</span>
      <span className="font-mono">{rupees(minor)}</span>
    </li>
  );
}

function Field({
  label,
  value,
  mono,
  strong,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`${mono ? "font-mono " : ""}${strong ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}
