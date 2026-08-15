"use client";

/**
 * Ordence — ⭐ AN EMPLOYEE'S OWN LEAVE
 * Version: v1.46.0-alpha · Batch 59
 *
 * ⚠️ THIS SCREEN SHOWS THE SIGNED-IN PERSON AND NOBODY ELSE, and the
 * scoping is not here — it is in `myLeaveOverview()`, which takes no
 * arguments and resolves the employee from the session. A component
 * cannot be the authorisation for anything: it is markup, and the same
 * server action is reachable with curl.
 *
 * ⭐ THE APPLICATION FORM SENDS DATES AND A TYPE AND COMPUTES NO DAYS.
 * How many days a range costs depends on the leave type's holiday rule
 * and on the company's holiday calendar, and a browser that guessed
 * would show a number the server then disagreed with — which is worse
 * than showing none.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type MyBalance = {
  leaveTypeId: string;
  code: string;
  label: string;
  balanceDays: string;
  committedDays: string;
  availableDays: string;
};

export type MyRequest = {
  id: string;
  code: string;
  fromOn: string;
  toOn: string;
  days: string;
  status: string;
  decisionNote: string | null;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function MyLeave({
  balances,
  requests,
  linked,
  onSubmit,
  onCancel,
}: {
  balances: MyBalance[];
  requests: MyRequest[];
  linked: boolean;
  onSubmit: (input: unknown) => Promise<Result<{ days: string; note: string }>>;
  onCancel: (input: unknown) => Promise<Result<{ note: string }>>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [leaveTypeId, setLeaveTypeId] = useState(balances[0]?.leaveTypeId ?? "");
  const [fromOn, setFromOn] = useState("");
  const [toOn, setToOn] = useState("");
  const [halfDayStart, setHalfDayStart] = useState(false);
  const [halfDayEnd, setHalfDayEnd] = useState(false);
  const [reason, setReason] = useState("");

  if (!linked) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm">
            Your sign-in is not linked to an employee record, so there is nothing to book leave
            against. Ask whoever administers payroll to link them.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Your balances</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {balances.map((b) => (
            <div key={b.leaveTypeId} className="flex items-center gap-3 border-b py-2 text-sm last:border-0">
              <span className="font-mono text-xs">{b.code}</span>
              <span className="flex-1">{b.label}</span>
              <span className="tabular-nums">{b.balanceDays} earned</span>
              {Number(b.committedDays) > 0 ? (
                <Badge variant="secondary">{b.committedDays} already approved</Badge>
              ) : null}
              <span className="font-medium tabular-nums">{b.availableDays} available</span>
            </div>
          ))}
          {/*
            ⚠️ THE SENTENCE IS THE FEATURE. "Available" being lower than
            "earned" is the single most common support question a leave
            system generates, and answering it once on the screen is
            cheaper than answering it every December.
          */}
          <p className="text-xs text-muted-foreground">
            Available is what you have earned less anything already approved. Leave that is
            approved but not yet taken is reserved, not spent — if you cancel it, it comes back.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Apply for leave</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded border px-2 py-1 text-sm"
              value={leaveTypeId}
              onChange={(e) => setLeaveTypeId(e.target.value)}
            >
              {balances.map((b) => (
                <option key={b.leaveTypeId} value={b.leaveTypeId}>
                  {b.label}
                </option>
              ))}
            </select>
            <input
              type="date"
              className="rounded border px-2 py-1 text-sm"
              value={fromOn}
              onChange={(e) => setFromOn(e.target.value)}
            />
            <input
              type="date"
              className="rounded border px-2 py-1 text-sm"
              value={toOn}
              onChange={(e) => setToOn(e.target.value)}
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={halfDayStart}
                onChange={(e) => setHalfDayStart(e.target.checked)}
              />
              Half day at the start
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={halfDayEnd}
                onChange={(e) => setHalfDayEnd(e.target.checked)}
              />
              Half day at the end
            </label>
          </div>
          <input
            className="w-full rounded border px-2 py-1 text-sm"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {/*
            🔴 THE REASON FIELD IS OPTIONAL AND SAYS SO. A required
            "reason" on a sick-leave application is a demand for health
            information, recorded in a table every support session can
            read. An employee who volunteers a diagnosis has volunteered
            it; a required field would have asked for it.
          */}
          <p className="text-xs text-muted-foreground">
            The reason is optional. Please do not put medical details in it.
          </p>
          <Button
            size="sm"
            disabled={pending || !leaveTypeId || !fromOn || !toOn}
            onClick={() =>
              startTransition(async () => {
                const result = await onSubmit({
                  leaveTypeId,
                  fromOn,
                  toOn,
                  halfDayStart,
                  halfDayEnd,
                  reason: reason || null,
                });
                if (result.ok) {
                  toast.success(`Applied for ${result.data.days} days.`, {
                    description: result.data.note,
                  });
                  setFromOn("");
                  setToOn("");
                  setReason("");
                  router.refresh();
                } else {
                  toast.error(result.error);
                }
              })
            }
          >
            Apply
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Your applications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {requests.length === 0 ? (
            <p className="text-xs text-muted-foreground">You have not applied for any leave.</p>
          ) : null}
          {requests.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 border-b py-2 text-sm last:border-0">
              <span className="font-mono text-xs">{r.code}</span>
              <span className="flex-1">
                {r.fromOn} to {r.toOn} · {r.days} days
              </span>
              <Badge variant={r.status === "approved" ? "secondary" : "outline"}>{r.status}</Badge>
              {r.decisionNote ? (
                <span className="w-full text-xs text-muted-foreground">{r.decisionNote}</span>
              ) : null}
              {r.status === "submitted" || r.status === "approved" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await onCancel({ id: r.id });
                      if (result.ok) {
                        toast.success("Cancelled.", { description: result.data.note });
                        router.refresh();
                      } else {
                        toast.error(result.error);
                      }
                    })
                  }
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
