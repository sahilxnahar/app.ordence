import { requireCapability } from "@/server/platform/guard";
import { SCHEDULER_CATALOG, DORMANT_NOT_SCHEDULED } from "@/server/scheduler/catalog";
import { nextRunFor } from "@/server/scheduler/tick";
import {
  activeTenantPauses,
  jobControls,
  latestRunPerJob,
  lastSuccessPerJob,
  recentRuns,
} from "@/server/scheduler/ledger";
import { watchdogReport } from "@/server/scheduler/watchdog";
import { JobsConsole, type JobRow, type RunRow } from "./jobs-console";

/**
 * Ordence — ⭐ THE JOBS CALENDAR
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS PAGE IS FOR, AND WHY IT WAS BUILT EARLY
 * ══════════════════════════════════════════════════════════════════════
 * Every job, its cadence, its last run, its next run, its last duration
 * and its last outcome, on one page. The brief said to build it early and
 * use it while working, and that turned out to be the right instruction
 * for a reason worth recording: the first render of this page, against a
 * database with 0129–0132 applied and no cron service, showed sixteen
 * jobs all reading NEVER RUN with a red watchdog banner. That is the
 * honest picture of this product today and no other screen in it says so.
 *
 * ⚠️ THE READ IS `observatory:read`, WHICH EVERY GRADE HOLDS. "Did the
 * dunning sweep run last night" is a question the person answering the
 * phone needs answered, and a console only engineers can open is a
 * console that gets screenshotted into chat.
 *
 * The WRITE actions in `actions.ts` are `flags:write`, which is engineer
 * and owner and requires step-up.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Scheduled jobs · Ordence Platform",
  robots: { index: false, follow: false },
};

export default async function AdminJobsPage() {
  /**
   * ⚠️ THE PAGE GUARDS AGAIN, AFTER THE LAYOUT ALREADY DID. The layout
   * proves the caller is platform staff at all; this proves they hold the
   * capability. They are different questions, and `app/platform/**` pages
   * do exactly this pairing.
   */
  await requireCapability("observatory:read");

  const [watchdog, controls, latest, lastSuccess, pauses, runs] = await Promise.all([
    watchdogReport(),
    jobControls(),
    latestRunPerJob(),
    lastSuccessPerJob(),
    activeTenantPauses(),
    recentRuns({ limit: 60 }),
  ]);

  const now = new Date();

  const jobs: JobRow[] = SCHEDULER_CATALOG.map((entry) => {
    const control = controls.get(entry.id);
    const last = latest.get(entry.id);
    const success = lastSuccess.get(entry.id);
    const overdue = watchdog.overdue.find((o) => o.jobId === entry.id);
    const pausedSilent = watchdog.pausedSilent.find((o) => o.jobId === entry.id);

    return {
      id: entry.id,
      label: entry.label,
      lane: entry.lane,
      scope: entry.scope,
      cronUtc: entry.cronUtc,
      cadenceInIst: entry.cadenceInIst,
      cronOverride: control?.cronOverride ?? null,
      enabled: control?.enabled ?? true,
      pausedReason: control?.pausedReason ?? null,
      overrun: entry.policy.overrun,
      backfillable: entry.policy.backfillable,
      maxMs: entry.policy.maxMs,
      maxSilenceSeconds: entry.maxSilenceSeconds,
      consequenceWhenStopped: entry.consequenceWhenStopped,
      lastRunAt: last?.claimedAt?.toISOString() ?? null,
      lastState: last?.state ?? null,
      lastDurationMs: last?.durationMs ?? null,
      lastError: last?.error ?? null,
      lastSuccessAt: success?.toISOString() ?? null,
      /**
       * 🔴 `nextRunFor` USES THE CODE'S CRON, NOT THE OVERRIDE, AND THE
       * COLUMN SAYS SO WHEN THEY DIFFER. Rendering the override's next run
       * under a heading that reads like the schedule would hide the
       * override — and an override that has outlived its incident is the
       * thing this column most needs to make visible.
       */
      nextRunAt: nextRunFor(entry, now)?.toISOString() ?? null,
      overdue: overdue
        ? {
            silentSeconds: overdue.silentSeconds,
            everRan: overdue.everRan,
          }
        : null,
      deliberatelySilent: pausedSilent !== undefined,
      tenantPauses: pauses
        .filter((p) => p.jobId === entry.id || p.jobId === "*")
        .map((p) => ({
          id: p.id,
          jobId: p.jobId,
          tenantId: p.subjectTenantId,
          reason: p.reason,
          pausedBy: p.pausedBy,
          expiresAt: p.expiresAt?.toISOString() ?? null,
        })),
    };
  });

  const runRows: RunRow[] = runs.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    tenantId: r.subjectTenantId,
    slotAt: r.slotAt?.toISOString() ?? null,
    runKind: r.runKind,
    state: r.state,
    claimedAt: r.claimedAt?.toISOString() ?? null,
    durationMs: r.durationMs,
    rowsProcessed: r.rowsProcessed,
    triggeredBy: r.triggeredBy,
    justification: r.justification,
    error: r.error,
    inFlight: r.finishedAt === null,
  }));

  return (
    <JobsConsole
      jobs={jobs}
      runs={runRows}
      notScheduled={DORMANT_NOT_SCHEDULED.map((d) => ({
        id: d.id,
        where: d.where,
        reason: d.reason,
        owner: d.owner,
      }))}
      watchdog={{
        ok: watchdog.ok,
        headline: watchdog.headline,
        heartbeatAt: watchdog.heartbeatAt?.toISOString() ?? null,
        heartbeatAgeSeconds: watchdog.heartbeatAgeSeconds,
        heartbeatStale: watchdog.heartbeatStale,
        overdueCount: watchdog.overdue.length,
        neverRanCount: watchdog.neverRanCount,
      }}
    />
  );
}
