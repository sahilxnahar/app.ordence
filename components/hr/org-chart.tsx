"use client";

/**
 * Ordence — ⭐⭐ THE ORG CHART, RENDERED
 * Version: v1.47.0-alpha · Batch 109
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ IT IS A NESTED LIST, NOT A CANVAS OF BOXES AND LINES
 * ══════════════════════════════════════════════════════════════════════
 * A drawn chart looks better in a screenshot and is worse in every other
 * way: it does not print, it does not search with the browser's own
 * find, a screen reader cannot walk it, and on a phone it becomes a
 * pinch-zoom puzzle. A nested list of names is what somebody actually
 * uses to answer "who do I escalate this to".
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE THREE WARNING BANDS ARE THE POINT OF THIS COMPONENT
 * ══════════════════════════════════════════════════════════════════════
 * A chart that renders cleanly while quietly omitting three people is
 * worse than no chart. So the problems are ABOVE the tree, not hidden
 * inside it:
 *
 *   · STALE LINES — somebody reporting to a person who has left. They
 *     were NOT moved and were NOT orphaned; see the header of
 *     `db/schema/appraisals.ts` for why either automatic answer is
 *     worse. This band is how a human finds out they have to decide.
 *   · UNPLACED — a cycle in the data, which every refusal in the stack
 *     is designed to make impossible and which is reported anyway,
 *     because "impossible" is a claim about writes that happened after
 *     the checks existed.
 *   · UNASSIGNED — people with no reporting line at all. One is the
 *     managing director. Forty means nobody has filled the chart in.
 */

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clearReportingLine, setReportingLine } from "@/server/actions/appraisals";
import type { OrgChartView } from "@/server/actions/appraisals";
import type { OrgNode } from "@/lib/hr/hierarchy";

function Node({ node }: { node: OrgNode }) {
  return (
    <li className="ml-4 border-l pl-4">
      <div className="flex flex-wrap items-baseline gap-2 py-1">
        <span className="font-medium">{node.fullName}</span>
        <span className="text-xs text-muted-foreground">{node.employeeCode}</span>
        {node.designation ? (
          <span className="text-xs text-muted-foreground">· {node.designation}</span>
        ) : null}
        {node.department ? <Badge variant="secondary">{node.department}</Badge> : null}
        {/*
          ⚠️ A LEAVER STAYS ON THE CHART AND IS MARKED. Removing them
          moves their reports to the top of the tree with nobody told,
          which mid-cycle makes four manager reviews nobody's job.
        */}
        {node.leftOn ? (
          <Badge variant="destructive">left {node.leftOn}</Badge>
        ) : null}
        {node.reports.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {node.reports.length} report{node.reports.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {node.reports.length > 0 ? (
        <ul>
          {node.reports.map((child) => (
            <Node key={child.employeeId} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function OrgChartBoard({ view }: { view: OrgChartView }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [managerId, setManagerId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [note, setNote] = useState("");

  const submit = () => {
    setMessage(null);
    setError(null);
    start(async () => {
      const result = await setReportingLine({
        employeeId,
        managerId,
        effectiveFrom: effectiveFrom || undefined,
        note: note || undefined,
      });
      if (result.ok) setMessage(result.data.note);
      else setError(result.error);
    });
  };

  const clear = () => {
    setMessage(null);
    setError(null);
    start(async () => {
      const result = await clearReportingLine({ employeeId, note: note || undefined });
      if (result.ok) setMessage(result.data.note);
      else setError(result.error);
    });
  };

  return (
    <div className="space-y-6">
      {/* 🔴 CYCLES FIRST, BECAUSE THEY MEAN PEOPLE ARE MISSING BELOW. */}
      {view.chart.cyclic.length > 0 ? (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">
              {view.chart.cyclic.length} people could not be placed
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            Their reporting lines form a loop. A loop makes the chart unwalkable and hangs any
            query that follows it. Ordence refuses to create one — these rows predate the check
            or arrived from outside the product. Clear one of the lines to break the loop.
          </CardContent>
        </Card>
      ) : null}

      {view.chart.staleLines.length > 0 ? (
        <Card className="border-amber-500">
          <CardHeader>
            <CardTitle className="text-sm">
              {view.chart.staleLines.length} reporting into somebody who has left
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="text-muted-foreground">
              Nothing was moved automatically. Re-pointing them at the next manager up would
              silently change who signs off an appraisal for a period that person did not
              supervise; blanking the line would orphan them with nobody told. Somebody has to
              decide, and this is the list.
            </p>
            <ul className="list-disc pl-5">
              {view.chart.staleLines.map((s) => (
                <li key={s.employee.employeeId}>
                  {s.employee.fullName} → {s.manager.fullName} (left {s.manager.leftOn})
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Reporting hierarchy · {view.placed} of {view.headcount} placed · deepest chain{" "}
            {view.chart.maxDepth + 1}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {view.chart.roots.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody on the roster yet. Add employees on the payroll screen first.
            </p>
          ) : (
            <ul className="text-sm">
              {view.chart.roots.map((root) => (
                <Node key={root.employeeId} node={root} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {view.chart.unassigned.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {view.chart.unassigned.length} with no reporting line
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            One of these is whoever runs the company. The rest are people the chart cannot place
            under anybody, and they will be enrolled in an appraisal cycle with no manager review
            expected.
            <ul className="mt-2 list-disc pl-5">
              {view.chart.unassigned.map((p) => (
                <li key={p.employeeId}>
                  {p.fullName} · {p.employeeCode}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/*
        ⚠️ THE FORM IS HIDDEN WITHOUT THE KEY AND THAT IS COSMETIC ONLY.
        The action re-checks; a hidden button is not a control, because a
        `"use server"` export is a URL whether or not anything renders it.
      */}
      {view.canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Set a reporting line</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="org-employee">Reports</Label>
                <select
                  id="org-employee"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                >
                  <option value="">Choose a person</option>
                  {view.people.map((p) => (
                    <option key={p.employeeId} value={p.employeeId}>
                      {p.fullName} ({p.employeeCode})
                      {p.leftOn ? " — left" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="org-manager">Reports to</Label>
                <select
                  id="org-manager"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={managerId}
                  onChange={(e) => setManagerId(e.target.value)}
                >
                  <option value="">Choose a manager</option>
                  {view.people.map((p) => (
                    <option key={p.employeeId} value={p.employeeId}>
                      {p.fullName} ({p.employeeCode})
                      {p.leftOn ? " — left" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="org-from">Effective from</Label>
                <Input
                  id="org-from"
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="org-note">Why (optional)</Label>
                <Input
                  id="org-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Reorganisation, promotion, cover…"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={submit} disabled={pending || !employeeId || !managerId}>
                Set reporting line
              </Button>
              <Button variant="outline" onClick={clear} disabled={pending || !employeeId}>
                End this person&rsquo;s line
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              A change ends the current line and starts a new one. The old line is kept, because
              an appraisal for a past period is assigned from whoever held the line then.
            </p>
            {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
