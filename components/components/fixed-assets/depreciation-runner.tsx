"use client";

/**
 * Ordence — ⭐⭐⭐ COMPUTE, READ, THEN POST — IN THAT ORDER
 * Batch 100 · v1.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 COMPUTING AND POSTING ARE TWO BUTTONS AND THAT IS THE WHOLE
 *      DESIGN OF THIS SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * `runDepreciation` produces a figure. `postDepreciation` writes a
 * journal entry that a database trigger then freezes. They are separate
 * permissions on the server (`fixed_assets.manage` and
 * `fixed_assets.post`) and they are separate actions here, with the
 * lines shown in between.
 *
 * ⚠️ ONE BUTTON WOULD BE FASTER AND WOULD BE WRONG. The first month a
 * company runs this is the month they discover an asset carrying the
 * wrong useful life — and the only moment that discovery is cheap is
 * BEFORE the charge is in the statutory books. After posting the remedy
 * is a reversing journal, not an edit.
 *
 * ⭐ AND THE POSTED RUN IS READ BACK RATHER THAN REMEMBERED. "Show the
 * stored working" calls `depreciationRunDetail`, which returns the days,
 * the rate and the shift factor as they were WRITTEN — which is what an
 * auditor asking "why is this figure what it is" two years later is
 * entitled to, and is not the same question as "what would today's
 * configuration produce".
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMinor } from "@/lib/fixed-assets/register-view";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type RunLine = {
  assetNo?: unknown;
  method?: unknown;
  daysInUse?: unknown;
  rateBp?: unknown;
  shiftFactorBp?: unknown;
  openingAccumulatedMinor?: unknown;
  chargeMinor?: unknown;
  closingCarryingMinor?: unknown;
  terminal?: unknown;
  notes?: unknown;
};

type RunData = {
  runId: string;
  totalChargeMinor: string;
  assetCount: number;
  lines: ReadonlyArray<Record<string, unknown>>;
  note: string;
};

type DetailData = {
  run: Record<string, unknown>;
  lines: ReadonlyArray<Record<string, unknown>>;
};

export type RunAction = (input: unknown) => Promise<Result<RunData>>;
export type PostAction = (input: unknown) => Promise<Result<{ note: string }>>;
export type DetailAction = (input: unknown) => Promise<Result<DetailData>>;

const text = (v: unknown): string => (v === null || v === undefined ? "—" : String(v));
const money = (v: unknown): string => {
  const s = String(v ?? "");
  return /^-?\d+$/.test(s) ? formatMinor(BigInt(s)) : "—";
};

export function DepreciationRunner({
  defaultPeriodStart,
  defaultPeriodEnd,
  runAction,
  postAction,
  detailAction,
  canManage,
  canPost,
}: {
  defaultPeriodStart: string;
  defaultPeriodEnd: string;
  runAction: RunAction;
  postAction: PostAction;
  detailAction: DetailAction;
  canManage: boolean;
  canPost: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [from, setFrom] = useState(defaultPeriodStart);
  const [to, setTo] = useState(defaultPeriodEnd);
  const [run, setRun] = useState<RunData | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  function compute() {
    setRefusal(null);
    setPosted(null);
    setDetail(null);
    startTransition(async () => {
      const result = await runAction({ periodStart: from, periodEnd: to });
      if (!result.ok) {
        setRefusal(result.error);
        setRun(null);
        return;
      }
      setRun(result.data);
    });
  }

  function post() {
    if (!run) return;
    setRefusal(null);
    startTransition(async () => {
      const result = await postAction({ runId: run.runId });
      if (!result.ok) {
        setRefusal(result.error);
        return;
      }
      setPosted(result.data.note);
      router.refresh();
    });
  }

  function showWorking() {
    if (!run) return;
    setRefusal(null);
    startTransition(async () => {
      const result = await detailAction({ runId: run.runId });
      if (!result.ok) {
        setRefusal(result.error);
        return;
      }
      setDetail(result.data);
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Compute a period</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {/* ⚠️ Said before the dates are typed. */}
            A period lies inside one financial year. A written-down-value charge is a
            per-annum rate pro-rated by days, and a window spanning 31 March has two
            denominators and no honest answer — so run each year separately.
          </p>
          {!canManage ? (
            <p role="alert" className="text-muted-foreground">
              Computing depreciation needs the <code>fixed_assets.manage</code> permission.
              You can read the register and the schedules without it.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="dep-from">Period start</Label>
                <Input
                  id="dep-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="dep-to">Period end</Label>
                <Input
                  id="dep-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
              <Button onClick={compute} disabled={pending}>
                {pending ? "Working…" : "Compute the charge"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {refusal !== null && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <p className="font-medium">Nothing has been changed.</p>
          <p className="mt-1 whitespace-pre-line">{refusal}</p>
        </div>
      )}

      {run !== null && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">
                {from} to {to}
              </CardTitle>
              <Badge variant={posted === null ? "secondary" : "default"}>
                {posted === null ? "computed, not posted" : "posted"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-6">
              <div>
                <p className="text-xs uppercase text-muted-foreground">Total charge</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {money(run.totalChargeMinor)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Assets</p>
                <p className="text-2xl font-semibold tabular-nums">{run.assetCount}</p>
              </div>
            </div>

            <p className="text-muted-foreground">{run.note}</p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Asset</th>
                    <th className="py-2 pr-3 font-medium">Method</th>
                    <th className="py-2 pr-3 font-medium">Days</th>
                    <th className="py-2 pr-3 font-medium">Rate</th>
                    <th className="py-2 pr-3 font-medium">Shift</th>
                    <th className="py-2 pr-3 font-medium">Opening accumulated</th>
                    <th className="py-2 pr-3 font-medium">Charge</th>
                    <th className="py-2 pr-3 font-medium">Closing carrying</th>
                  </tr>
                </thead>
                <tbody>
                  {run.lines.map((raw, index) => {
                    const l = raw as RunLine;
                    return (
                      <tr key={`${text(l.assetNo)}-${index}`} className="border-b align-top last:border-0">
                        <td className="py-2 pr-3 font-medium">
                          {text(l.assetNo)}
                          {l.terminal === true && (
                            <Badge variant="outline" className="ml-2">
                              final
                            </Badge>
                          )}
                        </td>
                        <td className="py-2 pr-3">{text(l.method)}</td>
                        <td className="py-2 pr-3 tabular-nums">{text(l.daysInUse)}</td>
                        <td className="py-2 pr-3 tabular-nums">
                          {l.rateBp === null || l.rateBp === undefined
                            ? "—"
                            : `${Number(l.rateBp) / 100}%`}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {Number(l.shiftFactorBp ?? 10000) / 100}%
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {money(l.openingAccumulatedMinor)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums font-medium">
                          {money(l.chargeMinor)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {money(l.closingCarryingMinor)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {run.lines.some((l) => Array.isArray((l as RunLine).notes)) && (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {run.lines.flatMap((raw, index) => {
                  const l = raw as RunLine;
                  const notes = Array.isArray(l.notes) ? l.notes : [];
                  return notes.map((n, i) => (
                    <li key={`${index}-${i}`}>
                      {text(l.assetNo)}: {String(n)}
                    </li>
                  ));
                })}
              </ul>
            )}

            {/**
             * 🔴 THE SECOND, DELIBERATE ACTION. It is a different button,
             * a different permission and a different sentence.
             */}
            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              {posted === null ? (
                canPost ? (
                  <>
                    <Button variant="secondary" onClick={post} disabled={pending}>
                      Post this charge to the ledger
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Posting writes a journal entry dated the last day of the period. A
                      posted run is frozen by the database — the way to correct one is to
                      reverse the journal, not to recompute it.
                    </p>
                  </>
                ) : (
                  <p role="alert" className="text-xs text-muted-foreground">
                    Putting depreciation into the ledger needs the{" "}
                    <code>fixed_assets.post</code> permission. The figure above is
                    computed and is not in the books.
                  </p>
                )
              ) : (
                <p role="status" className="text-sm text-emerald-700">
                  {posted}
                </p>
              )}

              <Button variant="ghost" onClick={showWorking} disabled={pending}>
                Show the stored working
              </Button>
            </div>

            {detail !== null && (
              <div className="rounded-md border p-3">
                <p className="text-xs uppercase text-muted-foreground">
                  As written to the database
                </p>
                <p className="mt-1 text-sm">
                  Basis {text(detail.run.basis)} · status {text(detail.run.status)} · total{" "}
                  {money(detail.run.totalChargeMinor)}
                </p>
                <table className="mt-2 w-full text-xs">
                  <thead>
                    <tr className="border-b text-left uppercase text-muted-foreground">
                      <th className="py-1 pr-3 font-medium">Method</th>
                      <th className="py-1 pr-3 font-medium">Days</th>
                      <th className="py-1 pr-3 font-medium">Rate bp</th>
                      <th className="py-1 pr-3 font-medium">Shift bp</th>
                      <th className="py-1 pr-3 font-medium">Half rate</th>
                      <th className="py-1 pr-3 font-medium">Charge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((raw, index) => (
                      <tr key={index} className="border-b last:border-0">
                        <td className="py-1 pr-3">{text(raw.method)}</td>
                        <td className="py-1 pr-3 tabular-nums">{text(raw.daysInUse)}</td>
                        <td className="py-1 pr-3 tabular-nums">{text(raw.rateBp)}</td>
                        <td className="py-1 pr-3 tabular-nums">{text(raw.shiftFactorBp)}</td>
                        <td className="py-1 pr-3">{raw.halfRate === true ? "yes" : "no"}</td>
                        <td className="py-1 pr-3 tabular-nums">{money(raw.chargeMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
