"use client";

/**
 * Ordence — ⭐ THE QUEUE PANEL
 * Version: v1.19.0-alpha
 *
 * ⚠️ THE BUTTON IS NOT THE INTENDED CALLER. A scheduled job drains this.
 * The button exists so the queue can be inspected and nudged on the day
 * something is wrong, which is the only day anybody opens this screen.
 */

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

interface Row {
  id: string;
  triggerType: string;
  recordType: string;
  occurredAt: string;
  processedAt: string | null;
  runsStarted: number;
  errorMessage: string | null;
}

export function QueuePanel({
  pending,
  recent,
  runAction,
  purgeAction,
}: {
  pending: number;
  recent: readonly Row[];
  runAction: () => Promise<Result<{ considered: number; runsStarted: number; note: string }>>;
  purgeAction: () => Promise<Result<{ removed: number }>>;
}) {
  const [busy, startTransition] = useTransition();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {pending === 0
              ? "Nothing waiting."
              : `${pending} event${pending === 1 ? "" : "s"} waiting`}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {/**
             * ⭐ THE STALE RULE IS STATED, because it is the one
             * behaviour here that surprises people: a backlog is not
             * replayed wholesale.
             */}
            Events older than six hours are recorded and skipped rather than run.
            Firing two days of queued reminders in one minute sends real messages
            to real customers at real cost, and each one is individually correct
            while the effect is a business that looks broken.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                startTransition(async () => {
                  const r = await runAction();
                  if (!r.ok) toast.error(r.error);
                  else toast.success(r.data.note);
                })
              }
            >
              Run the queue now
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                startTransition(async () => {
                  const r = await purgeAction();
                  if (!r.ok) toast.error(r.error);
                  else
                    toast.success(
                      `${r.data.removed} processed event${r.data.removed === 1 ? "" : "s"} past their retention date removed.`,
                    );
                })
              }
            >
              Purge expired
            </Button>
          </div>
        </CardContent>
      </Card>

      {recent.map((r) => (
        <Card key={r.id} className={r.errorMessage ? "border-destructive" : undefined}>
          <CardContent className="space-y-1 pt-6 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.recordType.replace(/_/g, " ")}</span>
              <Badge variant="secondary">{r.triggerType.replace(/_/g, " ")}</Badge>
              {r.processedAt ? (
                <Badge variant="secondary">
                  {r.runsStarted} run{r.runsStarted === 1 ? "" : "s"} started
                </Badge>
              ) : (
                <Badge>waiting</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {new Date(r.occurredAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
            </p>
            {r.errorMessage && <p className="text-destructive">{r.errorMessage}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
