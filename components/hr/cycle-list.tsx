"use client";

/**
 * Ordence — ⭐ THE APPRAISAL CYCLES
 * Version: v1.47.0-alpha · Batch 109
 *
 * ⚠️ THE PERIOD IS TYPED, NOT ASSUMED. Indian employers appraise on the
 * financial year more often than not — 1 April to 31 March — and the FY
 * label is derived from the dates rather than picked from a dropdown, so
 * a half-yearly or calendar-year cycle is still filed under the right
 * year instead of being impossible to enter.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createAppraisalCycle,
  setAppraisalCycleStatus,
} from "@/server/actions/appraisals";
import type { CycleSummary } from "@/server/actions/appraisals";

export function CycleList({
  cycles,
  canManage,
}: {
  cycles: CycleSummary[];
  canManage: boolean;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {cycles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No appraisal cycle yet. A cycle is a review period plus the people in it.
          </p>
        ) : null}
        {cycles.map((c) => (
          <Card key={c.id}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
                <Link href={`/hr/appraisals/${c.id}`} className="underline">
                  {c.name}
                </Link>
                <Badge variant="secondary">{c.status}</Badge>
                <span className="text-xs font-normal text-muted-foreground">
                  FY {c.fyLabel} · {c.periodStart} to {c.periodEnd}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-xs text-muted-foreground">
                {c.enrolled} enrolled · {c.signedOff} signed off
                {c.selfReviewDueOn ? ` · self reviews due ${c.selfReviewDueOn}` : ""}
                {c.managerReviewDueOn ? ` · manager reviews due ${c.managerReviewDueOn}` : ""}
              </p>
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  {(["draft", "open", "closed", "cancelled"] as const).map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={c.status === s ? "default" : "outline"}
                      disabled={pending || c.status === s}
                      onClick={() =>
                        start(async () => {
                          const result = await setAppraisalCycleStatus({
                            cycleId: c.id,
                            status: s,
                          });
                          setMessage(result.ok ? `Cycle is now ${result.data.status}.` : null);
                          setError(result.ok ? null : result.error);
                        })
                      }
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              ) : null}
              {/*
                ⚠️ CLOSED AND CANCELLED ARE DIFFERENT AND NEITHER DELETES.
                A closed cycle happened and its outcomes stand. A
                cancelled one was abandoned and must not be quoted — but
                the rows stay, because deleting appraisals that became
                inconvenient is the worst-looking thing in an employment
                file.
              */}
            </CardContent>
          </Card>
        ))}
      </div>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">New cycle</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="cycle-name">Name</Label>
                <Input
                  id="cycle-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Annual review 2025-26"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cycle-start">Period start</Label>
                <Input
                  id="cycle-start"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cycle-end">Period end</Label>
                <Input
                  id="cycle-end"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
            <Button
              disabled={pending || !name || !periodStart || !periodEnd}
              onClick={() =>
                start(async () => {
                  const result = await createAppraisalCycle({
                    name,
                    periodStart,
                    periodEnd,
                  });
                  setMessage(
                    result.ok ? `Created, filed under FY ${result.data.fyLabel}.` : null,
                  );
                  setError(result.ok ? null : result.error);
                })
              }
            >
              Create cycle
            </Button>
            <p className="text-xs text-muted-foreground">
              The financial year is worked out from the end of the period — 1 April to 31 March,
              in Indian civil dates. A period ending in January belongs to the year that started
              the previous April.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
