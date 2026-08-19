"use client";

/**
 * Ordence — 🔴🔴🔴 PEOPLE WAITING FOR A SEAT
 * Version: v1.71.0-alpha (0114)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS REPLACES
 * ══════════════════════════════════════════════════════════════════════
 * Until 0114 a workspace on ten seats could have thirty people. There is
 * no in-product invite, so everybody arrives through Clerk, and that path
 * checked the limit, wrote a high-severity audit row, and admitted them
 * anyway. The audit row was correct and nobody read it.
 *
 * ⭐ They now arrive as `pending_seat` — which consumes no seat — and
 * appear here. This is a QUEUE and not a notification, on purpose: a
 * notification is read once and lost, and a queue is still here next
 * Tuesday when somebody gets round to it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE WAIT IS THE MOST IMPORTANT COLUMN
 * ══════════════════════════════════════════════════════════════════════
 * A person parked here can sign in and sees one screen telling them their
 * administrator has been asked for a seat. If nobody acts, they see that
 * screen every day. So the list is OLDEST FIRST and the wait is shown in
 * days — sorting newest-first would bury the person who has been waiting
 * eleven days under three who arrived this morning, and they are exactly
 * the one somebody needs to deal with.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type PendingSeat = {
  requestId: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  source: string;
  requestedAt: string;
  seatsUsedAtRequest: number;
  seatsAvailableAtRequest: number;
  waitingDays: number;
};

const SOURCE_LABEL: Record<string, string> = {
  identity_provider: "Added in your identity provider",
  invite: "Invited from Ordence",
  reactivation: "Reactivated from suspended",
};

export function PendingSeats({
  rows,
  seatsAvailable,
  canManage,
  approveAction,
  declineAction,
}: {
  rows: readonly PendingSeat[];
  seatsAvailable: number;
  canManage: boolean;
  approveAction: (i: unknown) => Promise<Result<{ note: string }>>;
  declineAction: (i: unknown) => Promise<Result<{ note: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (rows.length === 0) return null;

  function approve(requestId: string) {
    startTransition(async () => {
      const res = await approveAction({ requestId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.data.note);
    });
  }

  function decline(requestId: string) {
    if (reason.trim().length < 10) {
      toast.error(
        "Say why. They can see that they are waiting, and a refusal with no reason leaves them waiting for ever.",
      );
      return;
    }
    startTransition(async () => {
      const res = await declineAction({ requestId, reason: reason.trim() });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.data.note);
      setDecliningId(null);
      setReason("");
    });
  }

  return (
    <div className="space-y-3 rounded-md border border-amber-300 p-4 dark:border-amber-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {rows.length} {rows.length === 1 ? "person is" : "people are"} waiting
          for a seat
        </h3>
        <Badge variant={seatsAvailable > 0 ? "secondary" : "destructive"}>
          {seatsAvailable} seat{seatsAvailable === 1 ? "" : "s"} free
        </Badge>
      </div>

      {/**
       * ⚠️ THE COPY SAYS THEY CAN SIGN IN. An administrator who thinks a
       * parked person is locked out entirely will treat this as less
       * urgent than it is. They are not locked out — they are looking at
       * a screen that says "ask your administrator", every day.
       */}
      <p className="text-sm text-muted-foreground">
        They were added to your identity provider while this workspace had no
        seat free, so they were created <strong>without one</strong>. They can
        sign in, and they see a screen telling them a seat has been requested.
        Nothing else.
      </p>

      {seatsAvailable === 0 && (
        <p className="text-sm text-destructive">
          🔴 You have no free seats, so approving will be refused. Add seats, or
          suspend somebody who has left — a suspended person keeps their history
          and frees their seat.
        </p>
      )}

      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.requestId} className="space-y-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.name}</span>
              <span className="text-sm text-muted-foreground">{r.email}</span>
              <Badge variant="secondary">{r.role}</Badge>
              {/**
               * 🔴 THE WAIT, AND IT ESCALATES. Somebody on day one is an
               * administrator who has not looked yet. Somebody on day
               * eleven is a person who has concluded the product is
               * broken.
               */}
              <Badge
                variant={r.waitingDays >= 3 ? "destructive" : "outline"}
              >
                {r.waitingDays === 0
                  ? "arrived today"
                  : `waiting ${r.waitingDays} day${r.waitingDays === 1 ? "" : "s"}`}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {SOURCE_LABEL[r.source] ?? r.source}
              </span>
            </div>

            {/**
             * ⚠️ THE POSITION WHEN THEY ARRIVED, NOT NOW. It explains why
             * this row exists, which today's numbers cannot: three people
             * may have left since.
             */}
            <p className="text-xs text-muted-foreground">
              When they arrived you were using {r.seatsUsedAtRequest} seat
              {r.seatsUsedAtRequest === 1 ? "" : "s"} with{" "}
              {r.seatsAvailableAtRequest} free.
            </p>

            {canManage && decliningId !== r.requestId && (
              <div className="flex flex-wrap gap-2">
                <Button
                  className="h-7 px-2 text-xs"
                  disabled={pending || seatsAvailable === 0}
                  onClick={() => approve(r.requestId)}
                >
                  Give {r.name.split(" ")[0]} a seat
                </Button>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={pending}
                  onClick={() => {
                    setDecliningId(r.requestId);
                    setReason("");
                  }}
                >
                  Decline
                </Button>
              </div>
            )}

            {canManage && decliningId === r.requestId && (
              <div className="space-y-2 rounded-md border border-dashed p-3">
                <Label htmlFor={`why-${r.requestId}`}>
                  Why is {r.name.split(" ")[0]} not getting a seat?
                </Label>
                <Textarea
                  id={`why-${r.requestId}`}
                  rows={2}
                  value={reason}
                  placeholder="Left the company before their start date"
                  onChange={(e) => setReason(e.target.value)}
                />
                {/**
                 * 🔴 THE ASYMMETRY, STATED. Approving is explained by the
                 * seat count. Refusing is explained by nothing, and three
                 * months later "why was this person never let in" has no
                 * answer.
                 */}
                <p className="text-xs text-muted-foreground">
                  Approving needs no note — the seat count explains it. A
                  refusal is explained by nothing, and this person can see that
                  they are waiting.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    className="h-7 px-2 text-xs"
                    disabled={pending || reason.trim().length < 10}
                    onClick={() => decline(r.requestId)}
                  >
                    Decline, with this reason
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() => {
                      setDecliningId(null);
                      setReason("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {!canManage && (
              <p className="text-xs text-muted-foreground">
                Your role cannot approve seats. Ask an owner or an
                administrator.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
