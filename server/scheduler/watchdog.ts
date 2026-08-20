import "server-only";

/**
 * Ordence — THE DEAD MAN SWITCH, FROM THE APPLICATION SIDE
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ALARM FIRES ON ABSENCE, WHICH MEANS IT CANNOT LIVE ONLY INSIDE
 *    THE THING THAT CAN GO ABSENT
 * ══════════════════════════════════════════════════════════════════════
 * If the only evaluator of "has this job stopped?" were the tick, then a
 * tick that stops also stops the alarm about the tick stopping. That is
 * not a hypothetical: it is the current state of this product, where the
 * things that would have noticed the jobs were dormant were themselves
 * jobs.
 *
 * So the evaluation is a SQL function (0131 `scheduler_overdue`), and it
 * has three independent readers:
 *
 *   1. the tick, routinely — useful, and the one that can die;
 *   2. the jobs calendar, when a human looks;
 *   3. `GET /api/workers?watchdog=1`, which an external uptime monitor
 *      polls and which depends on none of our scheduling at all.
 *
 * The third is the one that survives us, and it is why this module's job
 * is to turn a list of rows into ONE boolean an uptime monitor can act on.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A DELIBERATELY PAUSED JOB IS SILENT, AND SILENCE IS WHAT WE ALARM ON
 * ══════════════════════════════════════════════════════════════════════
 * `scheduler_overdue()` reports every job that has not succeeded inside
 * its window, and it is right to: a job disabled by an operator has, in
 * fact, stopped. But an endpoint that stays red for three weeks because
 * somebody legitimately paused a detector is an endpoint that gets muted,
 * and muting it removes the alarm for every job that still matters.
 *
 * So a job that is EXPLICITLY DISABLED with a written reason is separated
 * out and does not make the endpoint red — until the pause is older than
 * PAUSE_BECOMES_AN_OUTAGE_DAYS, at which point it does. A pause nobody has
 * revisited in a month is not a decision any more, it is an outage that
 * somebody once had a reason for.
 */

import { sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { jobControls, type JobControl } from "@/server/scheduler/ledger";
import { findCatalogEntry } from "@/server/scheduler/catalog";

/**
 * How long an explicit pause may suppress the alarm.
 *
 * ⚠️ THIRTY DAYS IS A JUDGEMENT AND IT IS THE PART OF THIS FILE MOST
 * LIKELY TO BE WRONG. Too short and every deliberate hold becomes noise;
 * too long and "we paused dunning for one workspace in March" is still
 * quietly true in September. Thirty days is one billing cycle, which is
 * the shortest interval at which somebody is definitely looking at this
 * product's collections anyway.
 */
export const PAUSE_BECOMES_AN_OUTAGE_DAYS = 30;

/** Age at which the clock itself is declared dead. Six tick intervals. */
export const HEARTBEAT_MAX_SECONDS = 30 * 60;

export type OverdueJob = {
  jobId: string;
  label: string;
  lane: string;
  maxSilenceSeconds: number;
  lastSuccessAt: Date | null;
  silentSeconds: number;
  everRan: boolean;
  consequence: string;
  /** Set when the silence is a pause somebody wrote down. */
  pausedReason: string | null;
  pausedBy: string | null;
  pausedForDays: number | null;
};

export type WatchdogReport = {
  /** What `GET /api/workers?watchdog=1` turns into 200 or 503. */
  ok: boolean;
  headline: string;
  heartbeatAt: Date | null;
  heartbeatAgeSeconds: number | null;
  heartbeatStale: boolean;
  /** Silent, and nobody asked for it to be. These are the alarm. */
  overdue: OverdueJob[];
  /** Silent because an operator disabled them, recently enough to count. */
  pausedSilent: OverdueJob[];
  neverRanCount: number;
};

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as Row[]) : [];
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The heartbeat age, or null when there has never been a beat.
 *
 * 🔴 THE SQL FUNCTION MAPS "NO HEARTBEAT" TO bigint MAX RATHER THAN TO
 * NULL, and 0131 Section 6h2 exists because a first draft did not: with
 * nothing overdue, `ok = (0 = 0 AND NULL <= 900)` evaluates to NULL, and a
 * response body carrying `ok: null` reads as "not false" to every monitor
 * that tests for false. The sentinel is translated back to null HERE, for
 * display only, after the boolean has already been decided in SQL.
 */
const NO_HEARTBEAT_SENTINEL = 9223372036854775807;

export async function watchdogReport(): Promise<WatchdogReport> {
  const [statusRaw, overdueRaw, controls] = await Promise.all([
    withPlatformScope("Scheduler watchdog: an uptime monitor needs one verdict covering every job and every workspace at once", (tx) =>
      tx.execute(sql`
        SELECT ok, overdue_count, never_ran_count, heartbeat_at,
               heartbeat_age_seconds, heartbeat_stale, headline
          FROM scheduler_watchdog_status(now(), ${HEARTBEAT_MAX_SECONDS}::integer)
      `),
    ),
    withPlatformScope("Scheduler watchdog: a job that stopped has stopped for all its workspaces, so the silence is only visible across them", (tx) =>
      tx.execute(sql`
        SELECT job_id, label, lane, max_silence_seconds, last_success_at,
               silent_seconds, ever_ran, consequence
          FROM scheduler_overdue(now())
      `),
    ),
    jobControls(),
  ]);

  const status = rowsOf(statusRaw)[0] ?? {};
  const rawAge = Number(status.heartbeat_age_seconds ?? NO_HEARTBEAT_SENTINEL);
  const heartbeatAgeSeconds = rawAge >= NO_HEARTBEAT_SENTINEL ? null : rawAge;

  const all: OverdueJob[] = rowsOf(overdueRaw).map((r) => {
    const jobId = String(r.job_id ?? "");
    const control: JobControl | undefined = controls.get(jobId);
    const pausedAt = control && !control.enabled ? control.pausedAt : null;
    return {
      jobId,
      label: String(r.label ?? findCatalogEntry(jobId)?.label ?? jobId),
      lane: String(r.lane ?? "app"),
      maxSilenceSeconds: Number(r.max_silence_seconds ?? 0),
      lastSuccessAt: toDate(r.last_success_at),
      silentSeconds: Number(r.silent_seconds ?? 0),
      everRan: r.ever_ran === true,
      consequence: String(r.consequence ?? ""),
      pausedReason: control && !control.enabled ? control.pausedReason : null,
      pausedBy: control && !control.enabled ? control.pausedBy : null,
      pausedForDays: pausedAt
        ? Math.floor((Date.now() - pausedAt.getTime()) / (24 * 3600_000))
        : null,
    };
  });

  const pausedSilent: OverdueJob[] = [];
  const overdue: OverdueJob[] = [];

  for (const job of all) {
    const excused =
      job.pausedReason !== null &&
      (job.pausedForDays === null || job.pausedForDays < PAUSE_BECOMES_AN_OUTAGE_DAYS);
    if (excused) pausedSilent.push(job);
    else overdue.push(job);
  }

  const heartbeatStale = status.heartbeat_stale === true;
  const ok = overdue.length === 0 && !heartbeatStale;

  return {
    ok,
    headline: buildHeadline({
      ok,
      heartbeatAt: toDate(status.heartbeat_at),
      heartbeatAgeSeconds,
      heartbeatStale,
      overdue,
      pausedSilent,
    }),
    heartbeatAt: toDate(status.heartbeat_at),
    heartbeatAgeSeconds,
    heartbeatStale,
    overdue,
    pausedSilent,
    neverRanCount: overdue.filter((j) => !j.everRan).length,
  };
}

function buildHeadline(args: {
  ok: boolean;
  heartbeatAt: Date | null;
  heartbeatAgeSeconds: number | null;
  heartbeatStale: boolean;
  overdue: OverdueJob[];
  pausedSilent: OverdueJob[];
}): string {
  if (!args.heartbeatAt) {
    return (
      "NO HEARTBEAT EVER. The scheduler clock has never run: the Railway cron service " +
      "does not exist, or has never reached /api/workers. Every job is dormant. " +
      "See docs/SCHEDULER.md."
    );
  }
  if (args.heartbeatStale) {
    return (
      `SCHEDULER CLOCK IS SILENT. Last tick ${args.heartbeatAgeSeconds ?? "?"}s ago. Nothing ` +
      `is being scheduled, and no job-level alert can be trusted, because the thing that ` +
      `raises them is the thing that stopped.`
    );
  }
  if (args.overdue.length > 0) {
    const never = args.overdue.filter((j) => !j.everRan);
    const worst = args.overdue[0];
    return (
      `${args.overdue.length} job(s) overdue` +
      (never.length > 0 ? `, ${never.length} of which have NEVER succeeded` : "") +
      (worst
        ? `. Worst: ${worst.jobId}, silent ${Math.round(worst.silentSeconds / 3600)}h against a ` +
          `${Math.round(worst.maxSilenceSeconds / 3600)}h window. ${worst.consequence}`
        : "")
    );
  }
  if (args.pausedSilent.length > 0) {
    return (
      `Every job that is supposed to be running has completed within its window. ` +
      `${args.pausedSilent.length} job(s) are deliberately paused and are not counted: ` +
      `${args.pausedSilent.map((j) => j.jobId).join(", ")}.`
    );
  }
  return "Every declared job has completed within its window and the clock is beating.";
}
