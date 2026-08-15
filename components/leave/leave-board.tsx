"use client";

/**
 * Ordence — ⭐⭐ THE LEAVE REGISTER
 * Version: v1.46.0-alpha · Batch 59
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCREEN SHOWS TWO NUMBERS PER LEAVE TYPE AND NEVER ONE
 * ══════════════════════════════════════════════════════════════════════
 * `Balance` is what has been earned and not spent. `Available` is that
 * less what approvals have already reserved.
 *
 * ⚠️ SHOWING ONLY ONE OF THEM IS WHERE THE PRODUCT WOULD GO WRONG, in
 * whichever direction it picked. Show only `balance` and two people book
 * the same week off against the same six remaining days, both are
 * approved, and the second one goes onto loss of pay in the month it
 * happens. Show only `available` and an employee who cancels a holiday
 * cannot work out why their number moved.
 *
 * ⭐ AND THE ACCRUAL POLICY IS PRINTED NEXT TO THE ENTITLEMENT, not
 * hidden behind an edit dialog. "Granted up front" and "earned monthly"
 * produce very different balances for the same annual number, and a
 * screen that makes that hard to see is a screen that gets it wrong.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type LeaveTypeRow = {
  id: string;
  code: string;
  label: string;
  isPaid: boolean;
  accrualMethod: string;
  annualEntitlementDays: string;
  carryForwardCapDays: string;
  encashmentCapDays: string;
  countsHolidaysAndOffs: boolean;
};

export type PeriodRow = {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  isClosed: boolean;
};

export type BalanceRow = {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  code: string;
  accruedDays: string;
  carriedInDays: string;
  takenDays: string;
  lapsedDays: string;
  balanceDays: string;
  committedDays: string;
  availableDays: string;
};

export type RequestRow = {
  id: string;
  fullName: string;
  employeeCode: string;
  code: string;
  fromOn: string;
  toOn: string;
  days: string;
  status: string;
  reason: string | null;
  decisionNote: string | null;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function accrualWords(method: string): string {
  if (method === "annual_advance") return "Granted up front";
  if (method === "none") return "Never earned";
  return "Earned monthly";
}

export function LeaveBoard({
  types,
  periods,
  balances,
  requests,
  canManage,
  canApprove,
  onSeed,
  onAccrue,
  onDecide,
}: {
  types: LeaveTypeRow[];
  periods: PeriodRow[];
  balances: BalanceRow[];
  requests: RequestRow[];
  canManage: boolean;
  canApprove: boolean;
  onSeed: () => Promise<Result<{ types: number; periods: number; note: string }>>;
  onAccrue: (
    input: unknown,
  ) => Promise<Result<{ entriesWritten: number; employeesTouched: number; note: string }>>;
  onDecide: (input: unknown) => Promise<Result<{ status: string; note: string }>>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const openPeriod = periods.find((p) => !p.isClosed) ?? null;
  const pending_requests = requests.filter((r) => r.status === "submitted");

  return (
    <div className="space-y-6">
      {types.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">There is no leave policy yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Nobody can apply for leave until there is at least one leave type and a leave year
              to count it against. The starter set writes four types — earned, casual, sick and
              loss of pay — and the current April–March leave year.
            </p>
            {/*
              🔴 THE DISCLAIMER IS NOT SMALL PRINT. Leave entitlement in
              India comes from the Factories Act for a factory and from the
              State's Shops and Establishments Act for everybody else, and
              those differ from each other. A product that presented its
              seed as a legal minimum would be confidently wrong for most
              of its users.
            */}
            <p className="rounded border border-amber-500 p-2 text-xs">
              These are ordinary practice, not a statutory minimum and not legal advice. Check
              every entitlement and every cap against the Act your establishment is registered
              under before the first accrual.
            </p>
            {canManage ? (
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await onSeed();
                    if (result.ok) {
                      toast.success(`${result.data.types} leave types added.`);
                      router.refresh();
                    } else {
                      toast.error(result.error);
                    }
                  })
                }
              >
                Seed the starter policy
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {types.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Leave types</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {types.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center gap-2 border-b py-2 text-sm last:border-0"
              >
                <span className="font-mono text-xs">{t.code}</span>
                <span className="flex-1">{t.label}</span>
                <Badge variant="outline">{accrualWords(t.accrualMethod)}</Badge>
                <span className="text-xs text-muted-foreground">
                  {t.annualEntitlementDays} days a year
                </span>
                {/*
                  ⚠️ THE CAP IS ALWAYS PRINTED, INCLUDING WHEN IT IS ZERO.
                  "Nothing carries forward" is a policy somebody chose;
                  a blank space is a policy nobody read back, and an
                  uncapped carry-forward is a liability that never appears
                  on a balance sheet until a team turns over.
                */}
                <Badge variant={Number(t.carryForwardCapDays) > 0 ? "secondary" : "outline"}>
                  {Number(t.carryForwardCapDays) > 0
                    ? `Carries up to ${t.carryForwardCapDays}`
                    : "Nothing carries forward"}
                </Badge>
                {!t.isPaid ? <Badge variant="destructive">Unpaid</Badge> : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {canManage && openPeriod ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Accrual — {openPeriod.label}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Leave is earned month by month in proportion to the days each person was on the
              rolls, so somebody who joined in October earns a part year and not a whole one.
              Running this again writes nothing new — the arithmetic is cumulative and the
              database refuses a second entry for a month that already has one.
            </p>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await onAccrue({ periodId: openPeriod.id });
                  if (result.ok) {
                    toast.success(
                      `${result.data.entriesWritten} entries for ${result.data.employeesTouched} people.`,
                      { description: result.data.note },
                    );
                    router.refresh();
                  } else {
                    toast.error(result.error);
                  }
                })
              }
            >
              Run the accrual to today
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Applications awaiting a decision ({pending_requests.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {pending_requests.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing is waiting.</p>
          ) : null}
          {pending_requests.map((r) => (
            <div key={r.id} className="space-y-2 border-b py-2 last:border-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{r.fullName}</span>
                <span className="font-mono text-xs">{r.code}</span>
                <span className="text-xs text-muted-foreground">
                  {r.fromOn} to {r.toOn} · {r.days} days
                </span>
              </div>
              {r.reason ? (
                <p className="text-xs text-muted-foreground">{r.reason}</p>
              ) : null}
              {canApprove ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await onDecide({ id: r.id, decision: "approved" });
                        if (result.ok) {
                          toast.success("Approved.", { description: result.data.note });
                          router.refresh();
                        } else {
                          toast.error(result.error);
                        }
                      })
                    }
                  >
                    Approve
                  </Button>
                  {rejectingId === r.id ? (
                    <>
                      <input
                        className="flex-1 rounded border px-2 py-1 text-xs"
                        placeholder="Why is it refused?"
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending || rejectNote.trim().length < 3}
                        onClick={() =>
                          startTransition(async () => {
                            const result = await onDecide({
                              id: r.id,
                              decision: "rejected",
                              note: rejectNote,
                            });
                            if (result.ok) {
                              toast.success("Refused.");
                              setRejectingId(null);
                              setRejectNote("");
                              router.refresh();
                            } else {
                              toast.error(result.error);
                            }
                          })
                        }
                      >
                        Confirm refusal
                      </Button>
                    </>
                  ) : (
                    /*
                     * 🔴 REFUSING TAKES A SECOND CLICK AND A REASON.
                     * A one-click refusal beside a one-click approval is
                     * how somebody gets a "no" with nothing to escalate,
                     * and the person who has to answer for it three
                     * months later is not always the person who clicked.
                     */
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRejectingId(r.id)}
                    >
                      Refuse…
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Balances</CardTitle>
        </CardHeader>
        <CardContent>
          {balances.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing has been accrued yet, so every balance is zero. A balance here is always the
              sum of the ledger entries behind it — there is no stored number that can drift from
              them.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-3">Employee</th>
                    <th className="py-1 pr-3">Type</th>
                    <th className="py-1 pr-3 text-right">Accrued</th>
                    <th className="py-1 pr-3 text-right">Taken</th>
                    <th className="py-1 pr-3 text-right">Lapsed</th>
                    <th className="py-1 pr-3 text-right">Balance</th>
                    <th className="py-1 pr-3 text-right">Committed</th>
                    <th className="py-1 text-right">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((b) => (
                    <tr key={`${b.employeeId}-${b.code}`} className="border-b last:border-0">
                      <td className="py-1 pr-3">{b.fullName}</td>
                      <td className="py-1 pr-3 font-mono text-xs">{b.code}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{b.accruedDays}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{b.takenDays}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{b.lapsedDays}</td>
                      <td className="py-1 pr-3 text-right font-medium tabular-nums">
                        {b.balanceDays}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">{b.committedDays}</td>
                      <td className="py-1 text-right font-medium tabular-nums">
                        {b.availableDays}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">
                Committed is leave that has been approved and not yet taken. It is not an absence
                — people cancel plans and come in anyway — so it reduces what can still be applied
                for and does not reduce the balance.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
