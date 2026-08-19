"use client";

/**
 * Ordence — ⭐⭐⭐ THE COUNT SHEET AND THE REVIEW
 * Version: v1.18.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 TWO MODES, AND THE WHOLE CONTROL IS THAT THEY ARE DIFFERENT
 * ══════════════════════════════════════════════════════════════════════
 * COUNTING shows the item and an empty box. It does not show what the
 * system expects, and it does not react when a figure is typed.
 *
 * REVIEW shows expected beside counted, and is a different permission.
 *
 * ⚠️ THE SEPARATION IS ENFORCED ON THE SERVER, in two different exports
 * returning two different shapes. This component could not display an
 * expected quantity during counting even if somebody added the markup,
 * because the field is not in the payload. That is deliberate: a control
 * a curious employee can defeat by pressing F12 is not a control.
 *
 * ⭐ AND NOTHING IS SAID BACK WHEN A FIGURE IS ENTERED. The obvious
 * kindness is "that differs from the system by 4, are you sure" and it
 * would convert every count from the second line onwards into a sighted
 * one.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface CountRow {
  id: string;
  countNo: string;
  warehouseName: string;
  status: string;
  startedAt: string | null;
  postedAt: string | null;
  varianceValueMinor: string;
}

export function CountManager({
  counts,
  warehouses,
  openAction,
  postAction,
}: {
  counts: readonly CountRow[];
  warehouses: ReadonlyArray<{ id: string; name: string }>;
  openAction: (
    i: unknown,
  ) => Promise<Result<{ countId: string; countNo: string; lines: number }>>;
  postAction: (
    i: unknown,
  ) => Promise<
    Result<{ posted: boolean; movements: number; netValueMinor: string; note: string }>
  >;
}) {
  const [pending, startTransition] = useTransition();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");

  function open() {
    if (!warehouseId) {
      toast.error("There is no warehouse to count.");
      return;
    }
    startTransition(async () => {
      const r = await openAction({ warehouseId });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(
        `${r.data.countNo} opened with ${r.data.lines} lines. The system figures are frozen as of now.`,
      );
    });
  }

  function post(id: string, no: string) {
    startTransition(async () => {
      const r = await postAction({ countId: id });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`${no}: ${r.data.note} ${r.data.movements} adjustments written.`);
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Start a count</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {warehouses.length === 0 ? (
            <p className="text-muted-foreground">
              There are no warehouses set up yet.
            </p>
          ) : (
            <>
              {/**
               * ⭐ THE FREEZE IS EXPLAINED BEFORE IT HAPPENS, because it
               * is the one thing about a stocktake that surprises people:
               * dispatches made while counting do NOT become variances.
               */}
              <p className="text-muted-foreground">
                Opening a count writes down what the system currently believes is on
                every shelf, and freezes it. Anything dispatched or received while
                the counting happens is compared against that frozen moment rather
                than muddled into the difference.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="grow">
                  <Label htmlFor="wh">Warehouse</Label>
                  <select
                    id="wh"
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={warehouseId}
                    onChange={(e) => setWarehouseId(e.target.value)}
                  >
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button disabled={pending} onClick={open}>
                  Open a count
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {counts.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No counts yet. A stocktake is the only thing in the system that checks
            whether the stock figures are true, and until one is run they are a
            record of what should have happened rather than what did.
          </CardContent>
        </Card>
      ) : (
        counts.map((c) => (
          <Card key={c.id}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{c.countNo}</CardTitle>
                <Badge variant="secondary">{c.warehouseName}</Badge>
                <Badge variant={c.status === "posted" ? "default" : "secondary"}>
                  {c.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                {c.startedAt
                  ? `Started ${new Date(c.startedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
                  : "Not started"}
                {c.postedAt
                  ? ` · posted ${new Date(c.postedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
                  : ""}
              </p>

              {c.status !== "posted" && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => post(c.id, c.countNo)}
                  >
                    Review and post
                  </Button>
                </div>
              )}

              {c.status === "posted" && (
                <p className="text-xs text-muted-foreground">
                  {/**
                   * ⚠️ A POSTED COUNT IS FROZEN and 0070 refuses edits to
                   * its lines. Saying so here stops somebody hunting for
                   * an edit button that is deliberately absent.
                   */}
                  Posted. The difference is in the stock ledger and in the accounts,
                  so this sheet can no longer be changed. Open a new count instead.
                </p>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
