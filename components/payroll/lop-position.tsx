"use client";

/**
 * Ordence — ⭐⭐⭐ WHO IS LOSING PAY THIS MONTH, BEFORE ANYBODY SIGNS
 * Version: v1.47.0-alpha · Batch 50
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A DEDUCTION FOUND ON A PAYSLIP HAS ALREADY BEEN PAID
 * ══════════════════════════════════════════════════════════════════════
 * By the time an employee reads "27 of 31 days paid", the money has been
 * remitted, the run has been posted to the ledger, and the conversation
 * is an argument rather than a question. The same four days shown on the
 * run board, above the approve button, is something an operator can open
 * the attendance register and check in a minute.
 *
 * ⚠️ SO THIS PANEL SITS BETWEEN THE PROBLEMS AND THE MONEY, AND IT IS
 * RENDERED WHETHER OR NOT ANYBODY IS LOSING PAY. A panel that appears
 * only when there is something to see teaches the reader that its absence
 * means nothing happened — and the most dangerous state this batch has to
 * make visible is exactly the one where nothing was recorded and everyone
 * was quietly paid a full month.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY IT FETCHES ITS OWN DATA INSTEAD OF TAKING A PROP
 * ══════════════════════════════════════════════════════════════════════
 * Every screen that renders the run board gets the loss-of-pay position
 * without the page having to remember to pass it. A prop-injected version
 * is one `<PayrollRunBoard>` away from a screen that silently has no LOP
 * review on it, which is the same class of defect as `attendance: []`.
 *
 * ⚠️ THE ACTION IT CALLS RE-CHECKS `payroll.read` ON THE SERVER. This
 * component renders nothing sensitive on its own.
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getPayrollLopPosition } from "@/server/actions/payroll";

type PositionRow = {
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  payableDays: number;
  lopDays: string;
  chargedDays: number;
  unchargedDays: string;
  fromRegisterDays: string;
  fromApprovedUnpaidDays: string;
  approvedPaidDays: string;
  unregularisedDays: string;
  registerDayCount: number;
  capped: boolean;
  source: string;
};

type Position = {
  live: boolean;
  status: string;
  periodStart: string;
  periodEnd: string;
  rows: readonly PositionRow[];
  employeesInRun: number;
  employeesWithRecords: number;
  employeesAssumedFullMonth: number;
  unregularisedCount: number;
  unchargeableCount: number;
  totalLopDays: string;
  assumption: string;
};

/**
 * ⚠️ `"0.00"`, `"0"` and `"-0.00"` all mean nothing happened.
 *
 * ⭐ MATCHED, NOT PARSED. `parseFloat` on a day figure is exactly the
 * habit `lib/leave/days.ts` exists to stop, and a helper that does it
 * "only for a comparison" is the one somebody copies for arithmetic.
 */
function isZero(days: string): boolean {
  return /^-?0(\.0*)?$/.test(days.trim());
}

export function LopPositionPanel({ runId, refreshKey }: { runId: string; refreshKey?: number }) {
  const [position, setPosition] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const result = await getPayrollLopPosition({ runId });
      if (result.ok) {
        setPosition(result.data as Position);
        setError(null);
      } else {
        setError(result.error);
      }
    });
  }, [runId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (error !== null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Loss of pay</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-destructive">{error}</CardContent>
      </Card>
    );
  }

  if (position === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Loss of pay</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Reading the attendance register…
        </CardContent>
      </Card>
    );
  }

  const nobodyLosingPay = position.rows.length === 0;

  return (
    <Card data-testid="lop-position">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span>Loss of pay</span>
          <Badge variant={nobodyLosingPay ? "outline" : "secondary"}>
            {position.totalLopDays} days
          </Badge>
          {/*
            ⭐ THE BADGE THAT SAYS WHICH NUMBER THIS IS. A frozen run
            shows what it charged; a live one shows what the next compute
            WOULD charge, and the two are not the same claim.
          */}
          <Badge variant="outline">{position.live ? "from the register now" : "as charged"}</Badge>
          {position.live ? (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={pending}
              onClick={load}
            >
              Re-read the register
            </Button>
          ) : null}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3 text-xs">
        {/* ---------------------------------------------------------- */}
        {/* 🔴 THE ASSUMPTION, ALWAYS, EVEN WHEN IT IS BORING           */}
        {/* ---------------------------------------------------------- */}
        <p className="rounded border-l-2 border-muted-foreground/40 bg-muted/40 p-2 text-muted-foreground">
          {position.assumption}
        </p>

        {position.unchargeableCount > 0 ? (
          <p className="rounded border border-destructive p-2 text-destructive">
            {position.unchargeableCount} {position.unchargeableCount === 1 ? "person has" : "people have"}{" "}
            a part day of loss of pay that this run could not charge. Each of those payslips carries a
            problem naming the exact fraction, and the run cannot be approved until it is resolved —
            record the part day as a whole day in the register if that is what was meant.
          </p>
        ) : null}

        {position.unregularisedCount > 0 ? (
          <p className="rounded border border-destructive/50 p-2">
            {/*
              🔴 AN UNEXPLAINED ABSENCE IS NOT AN APPROVED UNPAID DAY.
              They cost identical money and mean entirely different
              things, so they are never added together on this screen.
            */}
            {position.unregularisedCount}{" "}
            {position.unregularisedCount === 1 ? "person is" : "people are"} marked absent with no
            leave type against the day. The pay is being docked because the register says so, but
            nobody has recorded why they were away. That is a conversation, not an accounting entry.
          </p>
        ) : null}

        {nobodyLosingPay ? (
          <p className="text-muted-foreground">
            Nobody is losing pay in this period.
          </p>
        ) : (
          <div className="space-y-1">
            {(expanded ? position.rows : position.rows.slice(0, 8)).map((row) => (
              <div
                key={row.employeeId}
                className="flex flex-wrap items-baseline gap-2 border-b py-1 last:border-0"
                data-testid={`lop-row-${row.employeeCode}`}
              >
                <span className="font-medium">{row.employeeName}</span>
                <span className="text-muted-foreground">{row.employeeCode}</span>
                <span className="ml-auto font-semibold">
                  {row.lopDays} of {row.payableDays} days
                </span>
                <span className="w-full text-muted-foreground">
                  {describeRow(row)}
                </span>
              </div>
            ))}
            {position.rows.length > 8 ? (
              <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
                {expanded ? "Show fewer" : `Show all ${position.rows.length}`}
              </Button>
            ) : null}
          </div>
        )}

        {/* ---------------------------------------------------------- */}
        {/* ⭐ SOMETHING TO DO ABOUT IT, NOT JUST SOMETHING TO READ     */}
        {/* ---------------------------------------------------------- */}
        {position.live ? (
          <p className="border-t pt-2 text-muted-foreground">
            These figures are read from the attendance register and the approved leave register for{" "}
            {position.periodStart} to {position.periodEnd}. Nothing is charged until the run is
            computed. Correct them in{" "}
            <Link href="/payroll/leave" className="underline">
              leave and attendance
            </Link>{" "}
            and recompute — a recompute replaces every payslip in the run.
          </p>
        ) : (
          <p className="border-t pt-2 text-muted-foreground">
            This run is {position.status}, so its payslips are frozen and this is what it charged.
            The attendance register may have moved since; it is deliberately not re-read here,
            because a current register beside a frozen wage bill is two numbers that disagree with
            nothing to say which one anybody was paid.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * ⭐ WHERE ONE PERSON'S LOSS OF PAY CAME FROM, IN A SENTENCE.
 *
 * ⚠️ THE THREE SOURCES ARE NEVER SUMMED INTO ONE PHRASE. "4 days of loss
 * of pay" tells an operator nothing they can act on; "3 days absent
 * without explanation and 1 day of approved unpaid leave" tells them who
 * to talk to and which of the two figures to trust.
 */
function describeRow(row: PositionRow): string {
  if (row.source === "frozen") {
    return `${row.lopDays} days were charged on this payslip.`;
  }

  const parts: string[] = [];
  if (!isZero(row.fromRegisterDays)) {
    parts.push(`${row.fromRegisterDays} from the attendance register`);
  }
  if (!isZero(row.fromApprovedUnpaidDays)) {
    parts.push(
      `${row.fromApprovedUnpaidDays} from approved unpaid leave on days the register has no entry for`,
    );
  }
  if (!isZero(row.unregularisedDays)) {
    parts.push(`${row.unregularisedDays} marked absent with no reason given`);
  }
  if (!isZero(row.approvedPaidDays)) {
    parts.push(`${row.approvedPaidDays} of approved PAID leave, which costs nothing`);
  }
  if (row.capped) {
    parts.push("capped at the days this person was on the rolls");
  }
  if (!isZero(row.unchargedDays)) {
    parts.push(`${row.unchargedDays} of a day could NOT be charged and is not on the payslip`);
  }
  return parts.length === 0 ? "Nothing recorded." : `${parts.join(" · ")}.`;
}
