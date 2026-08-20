"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  backfillJob,
  cancelRun,
  liftWorkspacePause,
  pauseWorkspace,
  runJobNow,
  setJobPaused,
} from "./actions";

/**
 * Ordence — THE JOBS CALENDAR, CLIENT HALF
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ⚠️ NO POLLING AND NO `refreshMs`. `components/platform/data-table.tsx`
 * offers auto-refresh and this page deliberately does not use it: the
 * page re-renders on every action through `revalidatePath`, and a screen
 * that silently re-fetched every ten seconds would re-run the watchdog
 * query, `scheduler_overdue()` and six ledger reads on a table this wave
 * also has to write retention for. An operator watching a run press
 * refresh is not a hardship.
 */

export type TenantPauseRow = {
  id: string;
  jobId: string;
  tenantId: string;
  reason: string;
  pausedBy: string;
  expiresAt: string | null;
};

export type JobRow = {
  id: string;
  label: string;
  lane: string;
  scope: string;
  cronUtc: string;
  cadenceInIst: string;
  cronOverride: string | null;
  enabled: boolean;
  pausedReason: string | null;
  overrun: string;
  backfillable: boolean;
  maxMs: number;
  maxSilenceSeconds: number;
  consequenceWhenStopped: string;
  lastRunAt: string | null;
  lastState: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  overdue: { silentSeconds: number; everRan: boolean } | null;
  deliberatelySilent: boolean;
  tenantPauses: TenantPauseRow[];
};

export type RunRow = {
  id: string;
  jobId: string;
  tenantId: string | null;
  slotAt: string | null;
  runKind: string;
  state: string;
  claimedAt: string | null;
  durationMs: number | null;
  rowsProcessed: number;
  triggeredBy: string;
  justification: string | null;
  error: string | null;
  inFlight: boolean;
};

export type NotScheduledRow = {
  id: string;
  where: string;
  reason: string;
  owner: string;
};

export type WatchdogSummary = {
  ok: boolean;
  headline: string;
  heartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  heartbeatStale: boolean;
  overdueCount: number;
  neverRanCount: number;
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 0) return `in ${humanDuration(-secs)}`;
  return `${humanDuration(secs)} ago`;
}

function humanDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86_400)}d`;
}

function stateVariant(state: string | null): "default" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case "succeeded":
      return "default";
    case "failed":
    case "budget_exceeded":
    case "abandoned":
      return "destructive";
    case "running":
    case "claimed":
      return "secondary";
    default:
      return "outline";
  }
}

export function JobsConsole(props: {
  jobs: JobRow[];
  runs: RunRow[];
  notScheduled: NotScheduledRow[];
  watchdog: WatchdogSummary;
}) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [sinceHours, setSinceHours] = useState("24");

  const call = (fn: () => Promise<{ ok: boolean; error?: string; data?: { note: string } }>) => {
    startTransition(async () => {
      const result = await fn();
      setNote(
        result.ok
          ? { ok: true, text: result.data?.note ?? "Done." }
          : { ok: false, text: result.error ?? "Refused." },
      );
      if (result.ok) setReason("");
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scheduled jobs</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every job the scheduler knows about, what it promised, and when it last kept the
          promise. Times are UTC.
        </p>
      </div>

      {/* ───────── THE WATCHDOG BANNER ─────────
        *
        * 🔴 FIRST ON THE PAGE, AND RED WHEN IT SHOULD BE. The question this
        * whole page exists to answer is "is anything running at all", and a
        * console where that answer is three scrolls down under a table is a
        * console where the answer is "nobody checked".
        */}
      <Card
        className={
          props.watchdog.ok ? "border-emerald-500/40" : "border-destructive bg-destructive/5"
        }
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Badge variant={props.watchdog.ok ? "default" : "destructive"}>
              {props.watchdog.ok ? "SCHEDULER HEALTHY" : "SCHEDULER NOT HEALTHY"}
            </Badge>
            <span className="text-muted-foreground text-xs font-normal">
              clock last beat {ago(props.watchdog.heartbeatAt)}
              {props.watchdog.heartbeatStale ? " — STALE" : ""}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{props.watchdog.headline}</p>
          <p className="text-muted-foreground text-xs">
            An external uptime monitor should poll{" "}
            <code className="font-mono">GET /api/workers?watchdog=1</code> with the worker bearer
            token. It answers 200 or 503 from the same evaluation as this banner, and it does not
            depend on the scheduler being alive — which is the point, because the failure this
            product has actually had is the scheduler not existing.
          </p>
        </CardContent>
      </Card>

      {note ? (
        <div
          className={
            note.ok
              ? "rounded-md border border-emerald-500/40 p-3 text-sm"
              : "border-destructive text-destructive rounded-md border p-3 text-sm"
          }
        >
          {note.text}
        </div>
      ) : null}

      {/* ───────── THE CALENDAR ───────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">The calendar</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Cadence</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Last success</TableHead>
                <TableHead>Next</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">Operate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.jobs.map((job) => (
                <TableRow key={job.id} className={job.overdue ? "bg-destructive/5" : undefined}>
                  <TableCell className="align-top">
                    <div className="font-mono text-xs font-medium">{job.id}</div>
                    <div className="text-muted-foreground text-xs">{job.label}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-[10px]">
                        {job.lane}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {job.scope}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        overrun: {job.overrun}
                      </Badge>
                      {job.backfillable ? null : (
                        <Badge variant="outline" className="text-[10px]">
                          no replay
                        </Badge>
                      )}
                    </div>
                    {!job.enabled ? (
                      <div className="text-destructive mt-1 text-xs">
                        DISABLED — {job.pausedReason}
                      </div>
                    ) : null}
                    {job.tenantPauses.length > 0 ? (
                      <div className="mt-1 space-y-1">
                        {job.tenantPauses.map((p) => (
                          <div key={p.id} className="text-muted-foreground text-[11px]">
                            workspace {p.tenantId.slice(0, 8)} paused
                            {p.jobId === "*" ? " (all jobs)" : ""} by {p.pausedBy}
                            {p.expiresAt ? ` until ${p.expiresAt}` : " indefinitely"} — {p.reason}
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto p-0 pl-2 text-[11px]"
                              disabled={pending || reason.trim().length < 20}
                              onClick={() =>
                                call(() =>
                                  liftWorkspacePause({ pauseId: p.id, justification: reason }),
                                )
                              }
                            >
                              lift
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </TableCell>

                  <TableCell className="align-top text-xs">
                    <div className="font-mono">{job.cronUtc}</div>
                    <div className="text-muted-foreground">{job.cadenceInIst}</div>
                    {job.cronOverride ? (
                      <div className="text-destructive font-mono">
                        OVERRIDE: {job.cronOverride}
                      </div>
                    ) : null}
                    <div className="text-muted-foreground mt-1">
                      alarms after {humanDuration(job.maxSilenceSeconds)} of silence
                    </div>
                  </TableCell>

                  <TableCell className="align-top text-xs">{ago(job.lastRunAt)}</TableCell>

                  <TableCell className="align-top text-xs">
                    {job.lastSuccessAt ? (
                      ago(job.lastSuccessAt)
                    ) : (
                      /* 🔴 "NEVER" IS THE MOST IMPORTANT WORD ON THIS PAGE. A job
                         that has never succeeded once is a configuration fault, not
                         a hiccup, and it is what every job in this product read
                         before this wave. */
                      <span className="text-destructive font-semibold">NEVER</span>
                    )}
                  </TableCell>

                  <TableCell className="align-top text-xs">
                    {job.nextRunAt ?? <span className="text-destructive">no next run</span>}
                  </TableCell>

                  <TableCell className="align-top text-xs">
                    <Badge variant={stateVariant(job.lastState)}>{job.lastState ?? "—"}</Badge>
                    {job.lastDurationMs !== null ? (
                      <div className="text-muted-foreground mt-1">{job.lastDurationMs}ms</div>
                    ) : null}
                    {job.overdue ? (
                      <div className="text-destructive mt-1">
                        OVERDUE — silent {humanDuration(job.overdue.silentSeconds)}
                      </div>
                    ) : null}
                    {job.deliberatelySilent ? (
                      <div className="text-muted-foreground mt-1">
                        silent on purpose (not alarming)
                      </div>
                    ) : null}
                    {job.lastError ? (
                      <div className="text-destructive mt-1 max-w-xs break-words">
                        {job.lastError.slice(0, 220)}
                      </div>
                    ) : null}
                  </TableCell>

                  <TableCell className="space-y-1 text-right align-top">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpen(open === job.id ? null : job.id)}
                    >
                      {open === job.id ? "close" : "operate"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {open ? (
            <OperatePanel
              job={props.jobs.find((j) => j.id === open) ?? null}
              pending={pending}
              reason={reason}
              setReason={setReason}
              tenantId={tenantId}
              setTenantId={setTenantId}
              sinceHours={sinceHours}
              setSinceHours={setSinceHours}
              call={call}
            />
          ) : null}
        </CardContent>
      </Card>

      {/* ───────── RECENT RUNS ───────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent runs</CardTitle>
        </CardHeader>
        <CardContent>
          {props.runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              The ledger is empty. Nothing has run — not once. If SQL-FILES/0129 to 0132 are
              applied and the Railway cron service exists, the first tick writes rows here within
              five minutes.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Slot</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Took</TableHead>
                  <TableHead>Triggered by</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-mono text-xs">
                      {run.jobId}
                      {run.tenantId ? (
                        <span className="text-muted-foreground"> · {run.tenantId.slice(0, 8)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">{run.slotAt ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {/* ⭐ A REPLAY IS LABELLED AS ONE. The brief asked for the
                          ledger to distinguish a replay from a live run; this is
                          where that distinction is worth anything. */}
                      <Badge variant={run.runKind === "backfill" ? "secondary" : "outline"}>
                        {run.runKind}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge variant={stateVariant(run.state)}>{run.state}</Badge>
                      {run.error ? (
                        <div className="text-destructive mt-1 max-w-md break-words">
                          {run.error.slice(0, 200)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {run.durationMs === null ? "—" : `${run.durationMs}ms`}
                    </TableCell>
                    <TableCell className="text-xs">
                      {run.triggeredBy}
                      {run.justification ? (
                        <div className="text-muted-foreground max-w-xs break-words">
                          {run.justification}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {run.inFlight ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending || reason.trim().length < 20}
                          onClick={() =>
                            call(() => cancelRun({ runId: run.id, justification: reason }))
                          }
                        >
                          cancel
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ───────── WHAT IS NOT SCHEDULED ─────────
        *
        * 🔴 THIS SECTION IS THE HONEST HALF OF THE PAGE. A console that
        * listed only what it runs would imply that what it runs is
        * everything — and six AI background workers exist at
        * /api/workers/ai-monitors, in no document and with no entitlement
        * gate, which is exactly the sort of thing a reassuring calendar
        * would bury.
        */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Dormant, and deliberately not scheduled ({props.notScheduled.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {props.notScheduled.map((d) => (
            <div key={d.id} className="border-l-2 pl-3">
              <div className="font-mono text-xs font-medium">{d.id}</div>
              <div className="text-muted-foreground text-xs">{d.where}</div>
              <p className="mt-1 text-xs">{d.reason}</p>
              <div className="text-muted-foreground mt-1 text-xs">Owner: {d.owner}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function OperatePanel(props: {
  job: JobRow | null;
  pending: boolean;
  reason: string;
  setReason: (v: string) => void;
  tenantId: string;
  setTenantId: (v: string) => void;
  sinceHours: string;
  setSinceHours: (v: string) => void;
  call: (
    fn: () => Promise<{ ok: boolean; error?: string; data?: { note: string } }>,
  ) => void;
}) {
  const job = props.job;
  if (!job) return null;

  const tenant = props.tenantId.trim() === "" ? null : props.tenantId.trim();
  const ready = props.reason.trim().length >= 20;

  return (
    <div className="mt-4 space-y-3 rounded-md border p-4">
      <div className="text-sm font-medium">Operate {job.id}</div>
      <p className="text-muted-foreground text-xs">{job.consequenceWhenStopped}</p>

      {job.lane !== "app" ? (
        <p className="text-destructive text-xs">
          This job runs in the <span className="font-mono">{job.lane}</span> lane, over a separate
          database connection as <span className="font-mono">ordence_maintenance</span>. The
          application role is deliberately refused these functions — SQL-FILES/0121, 0128 and
          scripts/sealed-grants.json — so nothing on this page can run it. See docs/SCHEDULER.md.
        </p>
      ) : null}

      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor="scheduler-reason">
          Why (recorded on the run and in the platform action log, 20 characters minimum)
        </label>
        <Textarea
          id="scheduler-reason"
          value={props.reason}
          onChange={(e) => props.setReason(e.target.value)}
          rows={2}
          placeholder="e.g. Dunning did not run on the 18th because the cron service was redeploying; replaying the missed slot."
        />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="scheduler-tenant">
            Workspace id (blank = every workspace)
          </label>
          <Input
            id="scheduler-tenant"
            value={props.tenantId}
            onChange={(e) => props.setTenantId(e.target.value)}
            placeholder="uuid"
            className="w-72 font-mono text-xs"
          />
        </div>

        <Button
          size="sm"
          disabled={props.pending || !ready || job.lane !== "app"}
          onClick={() =>
            props.call(() =>
              runJobNow({ jobId: job.id, tenantId: tenant, justification: props.reason }),
            )
          }
        >
          Run now
        </Button>

        <Button
          size="sm"
          variant={job.enabled ? "destructive" : "secondary"}
          disabled={props.pending || !ready}
          onClick={() =>
            props.call(() =>
              setJobPaused({ jobId: job.id, enabled: !job.enabled, justification: props.reason }),
            )
          }
        >
          {job.enabled ? "Disable job" : "Enable job"}
        </Button>

        <Button
          size="sm"
          variant="outline"
          disabled={props.pending || !ready || tenant === null}
          onClick={() =>
            props.call(() =>
              pauseWorkspace({
                jobId: job.id,
                tenantId: tenant ?? "",
                expiresAt: null,
                justification: props.reason,
              }),
            )
          }
        >
          Pause this workspace
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2 border-t pt-3">
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="scheduler-since">
            Replay missed slots from the last N hours
          </label>
          <Input
            id="scheduler-since"
            value={props.sinceHours}
            onChange={(e) => props.setSinceHours(e.target.value)}
            className="w-24"
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={props.pending || !ready || !job.backfillable || job.lane !== "app"}
          onClick={() =>
            props.call(() =>
              backfillJob({
                jobId: job.id,
                tenantId: tenant,
                sinceHours: Number(props.sinceHours) || 24,
                justification: props.reason,
              }),
            )
          }
        >
          Replay missed slots
        </Button>
        {job.backfillable ? null : (
          <p className="text-muted-foreground max-w-md text-xs">
            Not replayable. The reason is written against this job in
            server/scheduler/policy.ts — replaying it would either do nothing or do the wrong
            thing, such as re-firing every workflow a recovering dispatcher already fired once.
          </p>
        )}
      </div>
    </div>
  );
}
