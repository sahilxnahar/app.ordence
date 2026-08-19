"use client";

/**
 * Ordence — Opening a payroll run
 * Version: v1.23.0-alpha
 *
 * ⚠️ THE DEFAULTS ARE LAST MONTH, NOT THIS ONE. Payroll for a month is
 * run after the month has finished; defaulting to the current month
 * offers a period that has not happened yet and is the wrong answer
 * eleven days out of twelve.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Result = { ok: true; data: { id: string } } | { ok: false; error: string };

function lastMonthBounds(): { start: string; end: string } {
  const now = new Date();
  const firstOfThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(firstOfThis.getTime() - 86_400_000);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function NewRunForm({
  onOpen,
}: {
  onOpen: (input: { periodStart: string; periodEnd: string }) => Promise<Result>;
}) {
  const router = useRouter();
  const bounds = lastMonthBounds();
  const [periodStart, setPeriodStart] = useState(bounds.start);
  const [periodEnd, setPeriodEnd] = useState(bounds.end);
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Open a run</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor="period-start">Period from</Label>
            <Input
              id="period-start"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="period-end">Period to</Label>
            <Input
              id="period-end"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await onOpen({ periodStart, periodEnd });
                  if (result.ok) {
                    toast.success("Run opened.");
                    router.push(`/payroll/${result.data.id}`);
                  } else {
                    toast.error(result.error);
                  }
                })
              }
            >
              Open
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          One live run per period. Two runs for the same month would post the wage bill twice, so
          the database refuses the second — cancel the first with a reason if you need to start
          again.
        </p>
      </CardContent>
    </Card>
  );
}
