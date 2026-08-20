import "server-only";

/**
 * Ordence — THE RUN LEDGER, FROM THE APPLICATION SIDE
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY WRITE IN THIS FILE GOES THROUGH `withPlatformScope`, AND THAT
 *    IS NOT THE USUAL RULE
 * ══════════════════════════════════════════════════════════════════════
 * `db/index.ts` documents `withPlatformScope` as READ ONLY, and it is
 * right about every table that existed when it was written: the
 * `app.platform_scope` marker appears in those tables' `USING` clauses and
 * in none of their `WITH CHECK` clauses, so the database refuses a
 * cross-tenant write.
 *
 * The six `scheduler_*` tables (0129, 0130, 0131) carry the marker on BOTH
 * clauses, deliberately, and the argument is written out in 0129 Section 3.
 * The short version: these hold no tenant content, a platform sweep has no
 * current tenant to write under, and a policy on a NEW table cannot widen
 * the write boundary on an existing one. Nothing here writes to any table
 * outside that set.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ RAW `sql` TEMPLATES, NOT DRIZZLE QUERY BUILDERS
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/**` belongs to another stream this wave, so these tables have
 * no Drizzle definitions and cannot be given any by this track. Raw
 * templates are the house pattern anyway — 166 files under server/ and
 * lib/ already use them — and every value below is a bound parameter, never
 * concatenated. PATCH-REQUEST-A.md asks for the definitions so a later
 * wave gets the types.
 */

import { sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import type { Lane, OverrunPolicy } from "@/server/scheduler/policy";

export type RunKind = "scheduled" | "backfill" | "manual";

export type RunState =
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped_paused"
  | "skipped_overrun"
  | "cancelled"
  | "abandoned"
  | "budget_exceeded";

/** States a run can end in. Anything else means it is still going. */
export const TERMINAL_STATES: readonly RunState[] = [
  "succeeded",
  "failed",
  "skipped_paused",
  "skipped_overrun",
  "cancelled",
  "abandoned",
  "budget_exceeded",
];

type Row = Record<string, unknown>;

/**
 * The Neon driver returns either an array or `{rows: [...]}` depending on
 * the call path. Every raw-SQL site in this repository does this dance;
 * doing it once here rather than at nine call sites is the only reason
 * this helper exists.
 */
function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as Row[]) : [];
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function date(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ */
/* THE CLAIM                                                           */
/* ------------------------------------------------------------------ */

export type ClaimArgs = {
  jobId: string;
  lane: Lane;
  /** null for a platform-scoped job. */
  subjectTenantId: string | null;
  /** null only for `manual`. */
  slotAt: Date | null;
  runKind: RunKind;
  triggeredBy: string;
  justification?: string | null;
  deadlineAt?: Date | null;
  maxRows?: number | null;
};

export type ClaimResult =
  | { claimed: true; runId: string }
  | { claimed: false; reason: "slot_already_claimed" };

/**
 * Take a slot, or discover that somebody else already has it.
 *
 * 🔴 THIS IS THE WHOLE IDEMPOTENCY GUARANTEE AND IT IS ONE STATEMENT.
 * There is no SELECT-then-INSERT anywhere in this file, because the window
 * between them is exactly the window in which two ticks both decide the
 * slot is free. `INSERT ... ON CONFLICT DO NOTHING RETURNING id` is
 * decided by the database: one caller gets a row, every other caller gets
 * zero rows, under any interleaving, including across two containers.
 *
 * ⚠️ `RETURNING id` WITH `DO NOTHING` RETURNS NO ROW ON CONFLICT — that is
 * the property being used, and it is easy to write the version that does
 * not have it. `ON CONFLICT DO UPDATE SET id = id RETURNING id` returns a
 * row to BOTH callers and both then run. 0129 Section 5 executes the
 * double claim rather than trusting this comment.
 */
export async function claimSlot(args: ClaimArgs): Promise<ClaimResult> {
  const result = await withPlatformScope(
    `Scheduler: claiming the ${args.jobId} slot in the run ledger, which is platform-owned operational history with no tenant context to write it under`,
    (tx) =>
      tx.execute(sql`
        INSERT INTO scheduler_runs (
          job_id, lane, subject_tenant_id, slot_at, run_kind,
          triggered_by, justification, deadline_at, max_rows
        )
        VALUES (
          ${args.jobId},
          ${args.lane},
          ${args.subjectTenantId}::uuid,
          ${args.slotAt ? args.slotAt.toISOString() : null}::timestamptz,
          ${args.runKind},
          ${args.triggeredBy},
          ${args.justification ?? null},
          ${args.deadlineAt ? args.deadlineAt.toISOString() : null}::timestamptz,
          ${args.maxRows ?? null}::bigint
        )
        ON CONFLICT DO NOTHING
        RETURNING id::text AS id
      `),
  );

  const rows = rowsOf(result);
  const first = rows[0];
  if (!first) return { claimed: false, reason: "slot_already_claimed" };
  return { claimed: true, runId: str(first.id) };
}

/**
 * Record that a slot was decided against, and why.
 *
 * ⭐ A SKIP THAT WRITES NOTHING IS INDISTINGUISHABLE FROM A RUN THAT
 * HAPPENED. The whole reason this product's jobs were dormant for years is
 * that not-running leaves no trace. A skipped slot therefore takes the
 * claim exactly as a real run would, carries the reason, and shows on the
 * calendar as a skip rather than as a gap.
 */
export async function recordSkip(args: {
  jobId: string;
  lane: Lane;
  subjectTenantId: string | null;
  slotAt: Date;
  state: "skipped_paused" | "skipped_overrun";
  reason: string;
  triggeredBy: string;
}): Promise<string | null> {
  const result = await withPlatformScope(
    `Scheduler: recording that the ${args.jobId} slot was decided against, in a ledger no single workspace owns`,
    (tx) =>
      tx.execute(sql`
        INSERT INTO scheduler_runs (
          job_id, lane, subject_tenant_id, slot_at, run_kind,
          state, triggered_by, finished_at, outcome
        )
        VALUES (
          ${args.jobId}, ${args.lane}, ${args.subjectTenantId}::uuid,
          ${args.slotAt.toISOString()}::timestamptz, 'scheduled',
          ${args.state}, ${args.triggeredBy}, now(),
          jsonb_build_object('skipReason', ${args.reason}::text)
        )
        ON CONFLICT DO NOTHING
        RETURNING id::text AS id
      `),
  );
  const first = rowsOf(result)[0];
  return first ? str(first.id) : null;
}

/* ------------------------------------------------------------------ */
/* LIVENESS                                                            */
/* ------------------------------------------------------------------ */

export async function markStarted(runId: string): Promise<void> {
  await withPlatformScope(`Scheduler: marking run ${runId} started in the platform-owned ledger, which a tenant session cannot see or write`, (tx) =>
    tx.execute(sql`
      UPDATE scheduler_runs
         SET state = 'running', started_at = now(), heartbeat_at = now()
       WHERE id = ${runId}::uuid
         AND state = 'claimed'
    `),
  );
}

export type Heartbeat = {
  /** True when an operator, or a `kill` overrun policy, asked this to stop. */
  cancelRequested: boolean;
  /** True when the run has passed its declared wall-clock budget. */
  pastDeadline: boolean;
  /** True when the run has reported more rows than its declared budget. */
  pastRowBudget: boolean;
};

/**
 * Say the run is still alive, report progress, and read back the three
 * reasons it might have to stop.
 *
 * 🔴 THE READ-BACK IS THE POINT. A heartbeat that only writes is a
 * liveness signal; a heartbeat that also returns the stop conditions is
 * the cancellation channel, and it costs the same round trip. The runner
 * calls this at every workspace boundary, which is why "cancel" and
 * "budget" are bounded by one workspace's work rather than by the whole
 * run.
 */
export async function heartbeat(runId: string, rowsProcessed: number): Promise<Heartbeat> {
  const result = await withPlatformScope(`Scheduler: proving run ${runId} is still alive and reading back whether an operator has asked it to stop`, (tx) =>
    tx.execute(sql`
      UPDATE scheduler_runs
         SET heartbeat_at = now(),
             rows_processed = ${rowsProcessed}::bigint
       WHERE id = ${runId}::uuid
      RETURNING
        cancel_requested,
        (deadline_at IS NOT NULL AND now() > deadline_at)                 AS past_deadline,
        (max_rows IS NOT NULL AND ${rowsProcessed}::bigint > max_rows)    AS past_rows
    `),
  );

  const first = rowsOf(result)[0];
  /**
   * ⚠️ A MISSING ROW MEANS THE RUN IS GONE — pruned, or the id is wrong.
   * Reporting "no reason to stop" would keep a run going against a ledger
   * row that no longer exists, which is a run nothing can cancel. Treat it
   * as a cancellation.
   */
  if (!first) return { cancelRequested: true, pastDeadline: false, pastRowBudget: false };

  return {
    cancelRequested: first.cancel_requested === true,
    pastDeadline: first.past_deadline === true,
    pastRowBudget: first.past_rows === true,
  };
}

export async function finishRun(args: {
  runId: string;
  state: Exclude<RunState, "claimed" | "running">;
  outcome?: Record<string, unknown>;
  error?: string | null;
  rowsProcessed?: number;
}): Promise<void> {
  await withPlatformScope(`Scheduler: recording the outcome of run ${args.runId}, which no workspace owns and none may read`, (tx) =>
    tx.execute(sql`
      UPDATE scheduler_runs
         SET state          = ${args.state},
             finished_at    = now(),
             heartbeat_at   = now(),
             outcome        = ${JSON.stringify(args.outcome ?? {})}::jsonb,
             error          = ${args.error ?? null},
             rows_processed = COALESCE(${args.rowsProcessed ?? null}::bigint, rows_processed)
       WHERE id = ${args.runId}::uuid
         AND finished_at IS NULL
    `),
  );
}

export async function requestCancel(args: {
  runId: string;
  by: string;
  reason: string;
}): Promise<boolean> {
  const result = await withPlatformScope(
    `Scheduler: an operator is cancelling run ${args.runId}, a platform decision about work spanning many workspaces`,
    (tx) =>
      tx.execute(sql`
        UPDATE scheduler_runs
           SET cancel_requested = true,
               outcome = outcome || jsonb_build_object(
                 'cancelRequestedBy', ${args.by}::text,
                 'cancelReason', ${args.reason}::text
               )
         WHERE id = ${args.runId}::uuid
           AND finished_at IS NULL
        RETURNING id::text AS id
      `),
  );
  return rowsOf(result).length > 0;
}

/* ------------------------------------------------------------------ */
/* READS                                                               */
/* ------------------------------------------------------------------ */

export type InFlightRun = {
  id: string;
  jobId: string;
  subjectTenantId: string | null;
  slotAt: Date | null;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  state: RunState;
};

export async function inFlightRuns(jobId?: string): Promise<InFlightRun[]> {
  const result = await withPlatformScope("Scheduler: the overrun policy needs every unfinished run of a job, across all the workspaces it serves", (tx) =>
    tx.execute(sql`
      SELECT id::text AS id, job_id, subject_tenant_id::text AS subject_tenant_id,
             slot_at, claimed_at, heartbeat_at, state
        FROM scheduler_runs
       WHERE finished_at IS NULL
         AND (${jobId ?? null}::text IS NULL OR job_id = ${jobId ?? null}::text)
       ORDER BY claimed_at
    `),
  );

  return rowsOf(result).map((r) => ({
    id: str(r.id),
    jobId: str(r.job_id),
    subjectTenantId: r.subject_tenant_id ? str(r.subject_tenant_id) : null,
    slotAt: date(r.slot_at),
    claimedAt: date(r.claimed_at),
    heartbeatAt: date(r.heartbeat_at),
    state: str(r.state) as RunState,
  }));
}

/**
 * The most recent slot this (job, workspace) already has a ledger row for.
 *
 * ⭐ THIS IS WHAT MAKES THE TICK SELF-HEALING AND ALSO WHAT BOUNDS IT.
 * The tick asks "which slots since this one have come due", so a scheduler
 * that was down for two hours catches up on its own without anybody
 * running a backfill. `lookbackHours` in the runner is what stops a
 * scheduler that was down for a month from trying to run a month of slots
 * on the first tick back.
 */
export async function lastHandledSlot(
  jobId: string,
  subjectTenantId: string | null,
): Promise<Date | null> {
  const result = await withPlatformScope(
    `Scheduler: deciding which ${jobId} slots are still due, which requires the ledger a tenant session cannot read`,
    (tx) =>
      tx.execute(sql`
        SELECT max(slot_at) AS at
          FROM scheduler_runs
         WHERE job_id = ${jobId}
           AND slot_at IS NOT NULL
           AND subject_tenant_id IS NOT DISTINCT FROM ${subjectTenantId}::uuid
      `),
  );
  const first = rowsOf(result)[0];
  return first ? date(first.at) : null;
}

/**
 * Runs that hold a claim and have not started.
 *
 * ⭐ THESE EXIST BECAUSE OF THE `queue` OVERRUN POLICY, AND WITHOUT THIS
 * READER THAT POLICY WOULD BE A WORD IN A TYPE UNION. `queue` keeps the
 * slot and leaves the row in `claimed`; if no later tick looked for such
 * rows, the slot would be permanently consumed by a run that never
 * happened — a job silently losing one slot per overrun, forever.
 */
export async function pendingClaimedRuns(): Promise<InFlightRun[]> {
  const result = await withPlatformScope(
    "Scheduler: finding slots the queue policy parked, which span every workspace their job serves",
    (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, job_id, subject_tenant_id::text AS subject_tenant_id,
               slot_at, claimed_at, heartbeat_at, state
          FROM scheduler_runs
         WHERE state = 'claimed'
           AND started_at IS NULL
           AND finished_at IS NULL
         ORDER BY slot_at NULLS LAST, claimed_at
      `),
  );

  return rowsOf(result).map((r) => ({
    id: str(r.id),
    jobId: str(r.job_id),
    subjectTenantId: r.subject_tenant_id ? str(r.subject_tenant_id) : null,
    slotAt: date(r.slot_at),
    claimedAt: date(r.claimed_at),
    heartbeatAt: date(r.heartbeat_at),
    state: str(r.state) as RunState,
  }));
}

/**
 * Which of these slots already have a ledger row, for the missed-slot
 * calculation the backfill screen runs.
 *
 * ⚠️ ASKS THE DATABASE WHICH SLOTS ARE PRESENT rather than fetching all
 * runs and filtering in TypeScript. Over a 30-day window at a 15-minute
 * cadence that is 2,880 rows a screen render would otherwise pull.
 */
export async function slotsAlreadyRecorded(args: {
  jobId: string;
  subjectTenantId: string | null;
  fromInclusive: Date;
  toInclusive: Date;
}): Promise<Set<number>> {
  const result = await withPlatformScope(
    `Scheduler: separating the ${args.jobId} slots that were missed from the ones already decided, before offering a replay`,
    (tx) =>
      tx.execute(sql`
        SELECT DISTINCT slot_at
          FROM scheduler_runs
         WHERE job_id = ${args.jobId}
           AND slot_at IS NOT NULL
           AND subject_tenant_id IS NOT DISTINCT FROM ${args.subjectTenantId}::uuid
           AND slot_at >= ${args.fromInclusive.toISOString()}::timestamptz
           AND slot_at <= ${args.toInclusive.toISOString()}::timestamptz
      `),
  );

  const seen = new Set<number>();
  for (const r of rowsOf(result)) {
    const at = date(r.slot_at);
    if (at) seen.add(at.getTime());
  }
  return seen;
}

export type LedgerRun = {
  id: string;
  jobId: string;
  lane: Lane;
  subjectTenantId: string | null;
  slotAt: Date | null;
  runKind: RunKind;
  state: RunState;
  claimedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  rowsProcessed: number;
  triggeredBy: string;
  justification: string | null;
  error: string | null;
  outcome: Record<string, unknown>;
};

function toLedgerRun(r: Row): LedgerRun {
  const started = date(r.started_at) ?? date(r.claimed_at);
  const finished = date(r.finished_at);
  return {
    id: str(r.id),
    jobId: str(r.job_id),
    lane: str(r.lane) as Lane,
    subjectTenantId: r.subject_tenant_id ? str(r.subject_tenant_id) : null,
    slotAt: date(r.slot_at),
    runKind: str(r.run_kind) as RunKind,
    state: str(r.state) as RunState,
    claimedAt: date(r.claimed_at),
    startedAt: date(r.started_at),
    finishedAt: finished,
    durationMs: started && finished ? finished.getTime() - started.getTime() : null,
    rowsProcessed: num(r.rows_processed),
    triggeredBy: str(r.triggered_by),
    justification: r.justification ? str(r.justification) : null,
    error: r.error ? str(r.error) : null,
    outcome:
      typeof r.outcome === "object" && r.outcome !== null
        ? (r.outcome as Record<string, unknown>)
        : {},
  };
}

/** The newest run per job, for the calendar's "last outcome" column. */
export async function latestRunPerJob(): Promise<Map<string, LedgerRun>> {
  const result = await withPlatformScope("Scheduler: the jobs calendar answers did this run last night for every job at once, across all workspaces", (tx) =>
    tx.execute(sql`
      SELECT DISTINCT ON (job_id)
             id::text AS id, job_id, lane, subject_tenant_id::text AS subject_tenant_id,
             slot_at, run_kind, state, claimed_at, started_at, finished_at,
             rows_processed, triggered_by, justification, error, outcome
        FROM scheduler_runs
       ORDER BY job_id, claimed_at DESC
    `),
  );

  const map = new Map<string, LedgerRun>();
  for (const row of rowsOf(result)) {
    const run = toLedgerRun(row);
    map.set(run.jobId, run);
  }
  return map;
}

/** The newest SUCCESSFUL run per job. Different question, different column. */
export async function lastSuccessPerJob(): Promise<Map<string, Date>> {
  const result = await withPlatformScope("Scheduler: the dead man switch measures each job silence against every workspace it serves, not one", (tx) =>
    tx.execute(sql`
      SELECT job_id, max(finished_at) AS at
        FROM scheduler_runs
       WHERE state = 'succeeded' AND finished_at IS NOT NULL
       GROUP BY job_id
    `),
  );
  const map = new Map<string, Date>();
  for (const row of rowsOf(result)) {
    const at = date(row.at);
    if (at) map.set(str(row.job_id), at);
  }
  return map;
}

export async function recentRuns(args: {
  jobId?: string | null;
  limit: number;
}): Promise<LedgerRun[]> {
  const limit = Math.min(Math.max(1, args.limit), 500);
  const result = await withPlatformScope("Scheduler: an operator reviewing run history needs every workspace on one page to see a pattern", (tx) =>
    tx.execute(sql`
      SELECT id::text AS id, job_id, lane, subject_tenant_id::text AS subject_tenant_id,
             slot_at, run_kind, state, claimed_at, started_at, finished_at,
             rows_processed, triggered_by, justification, error, outcome
        FROM scheduler_runs
       WHERE (${args.jobId ?? null}::text IS NULL OR job_id = ${args.jobId ?? null}::text)
       ORDER BY claimed_at DESC
       LIMIT ${limit}
    `),
  );
  return rowsOf(result).map(toLedgerRun);
}

/* ------------------------------------------------------------------ */
/* THE CLOCK'S OWN PULSE                                               */
/* ------------------------------------------------------------------ */

export async function beat(source: string, detail: Record<string, unknown>): Promise<void> {
  await withPlatformScope("Scheduler: the heartbeat is one platform-wide fact about the clock, belonging to no workspace at all", (tx) =>
    tx.execute(sql`
      INSERT INTO scheduler_heartbeat (id, beat_at, source, detail)
      VALUES ('tick', now(), ${source}, ${JSON.stringify(detail)}::jsonb)
      ON CONFLICT (id) DO UPDATE
        SET beat_at = EXCLUDED.beat_at,
            source  = EXCLUDED.source,
            detail  = EXCLUDED.detail
    `),
  );
}

/* ------------------------------------------------------------------ */
/* MIRRORING THE CODE'S DECLARATIONS INTO THE DATABASE                 */
/* ------------------------------------------------------------------ */

export type Expectation = {
  jobId: string;
  lane: Lane;
  label: string;
  cronUtc: string;
  maxSilenceSeconds: number;
  consequence: string;
};

/**
 * Write the catalog's declarations into `scheduler_job_expectations`.
 *
 * 🔴 THE `retired_at` HALF IS THE HALF THAT IS USUALLY MISSING. Upserting
 * the current catalog is obvious. Retiring the rows that are no longer in
 * it is not, and without it a job removed from the code alarms forever —
 * which is how a watchdog gets muted, which removes the alarm for every
 * job that still matters.
 *
 * ⚠️ RETIRED, NOT DELETED. The row records that the job existed and what
 * it promised, which is the question asked when somebody wonders why a
 * table stopped being pruned in March.
 */
export async function syncExpectations(expectations: readonly Expectation[]): Promise<{
  declared: number;
  retired: number;
}> {
  if (expectations.length === 0) {
    /**
     * ⚠️ AN EMPTY CATALOG WOULD RETIRE EVERYTHING AND SILENCE THE WHOLE
     * WATCHDOG. That is never a legitimate state — `catalog.ts` throws
     * rather than produce one — so treat it as a bug and change nothing.
     */
    throw new Error(
      "syncExpectations was called with an empty catalog. That would retire every " +
        "expectation and silence the dead man switch entirely. Refusing.",
    );
  }

  const payload = JSON.stringify(
    expectations.map((e) => ({
      job_id: e.jobId,
      lane: e.lane,
      label: e.label,
      cron_utc: e.cronUtc,
      max_silence_seconds: e.maxSilenceSeconds,
      consequence: e.consequence,
    })),
  );

  return withPlatformScope("Scheduler: copying declared cadences into the table the watchdog reads when the application is not running", async (tx) => {
    await tx.execute(sql`
      INSERT INTO scheduler_job_expectations
        (job_id, lane, label, cron_utc, max_silence_seconds, consequence, updated_at, retired_at)
      SELECT j.job_id, j.lane, j.label, j.cron_utc, j.max_silence_seconds, j.consequence,
             now(), NULL
        FROM jsonb_to_recordset(${payload}::jsonb) AS j(
               job_id text, lane text, label text, cron_utc text,
               max_silence_seconds integer, consequence text)
      ON CONFLICT (job_id) DO UPDATE
        SET lane                = EXCLUDED.lane,
            label               = EXCLUDED.label,
            cron_utc            = EXCLUDED.cron_utc,
            max_silence_seconds = EXCLUDED.max_silence_seconds,
            consequence         = EXCLUDED.consequence,
            updated_at          = now(),
            -- ⭐ A JOB THAT COMES BACK IS UN-RETIRED, so re-adding a job
            -- to the catalog restores its alarm without anybody
            -- remembering that a column needs clearing.
            retired_at          = NULL
    `);

    /**
     * ⚠️ THE LIST IS RE-DERIVED FROM THE SAME JSON PAYLOAD, not passed as a
     * separate bound array. Two encodings of one list is two things to keep
     * in step, and the failure mode if they ever diverged is that a live
     * job gets retired and its alarm goes quiet.
     */
    const retired = await tx.execute(sql`
      UPDATE scheduler_job_expectations
         SET retired_at = now(), updated_at = now()
       WHERE retired_at IS NULL
         AND job_id NOT IN (
           SELECT j.job_id
             FROM jsonb_to_recordset(${payload}::jsonb) AS j(job_id text)
         )
      RETURNING job_id
    `);

    return { declared: expectations.length, retired: rowsOf(retired).length };
  });
}

/* ------------------------------------------------------------------ */
/* RECLAIM                                                             */
/* ------------------------------------------------------------------ */

export async function reclaimStale(staleSeconds: number): Promise<number> {
  const result = await withPlatformScope(
    "Scheduler: a crashed executor holds a slot for whichever workspace it was serving, and any of them may need freeing",
    (tx) =>
      tx.execute(sql`
        SELECT scheduler_reclaim_stale(now(), ${staleSeconds}::integer) AS n
      `),
  );
  const first = rowsOf(result)[0];
  return first ? num(first.n) : 0;
}

/* ------------------------------------------------------------------ */
/* PAUSE                                                               */
/* ------------------------------------------------------------------ */

/**
 * Is this (job, workspace) allowed to run right now, and if not, why not.
 *
 * ⚠️ THE PRECEDENCE LIVES IN `scheduler_pause_reason()` IN 0130, NOT HERE.
 * Four conditions can suppress a run and the admin screen needs the same
 * answer the runner acts on. Implementing it twice would mean the screen
 * saying "paused" while the job ran anyway, and neither copy being
 * obviously wrong.
 */
export async function pauseReason(
  jobId: string,
  subjectTenantId: string | null,
): Promise<string | null> {
  const result = await withPlatformScope(
    `Scheduler: deciding whether ${jobId} is paused, which depends on global controls no workspace can see`,
    (tx) =>
      tx.execute(sql`
        SELECT scheduler_pause_reason(${jobId}, ${subjectTenantId}::uuid, now()) AS reason
      `),
  );
  const first = rowsOf(result)[0];
  const reason = first?.reason;
  return reason === null || reason === undefined ? null : String(reason);
}

export type JobControl = {
  jobId: string;
  enabled: boolean;
  pausedReason: string | null;
  pausedBy: string | null;
  pausedAt: Date | null;
  cronOverride: string | null;
  maxMsOverride: number | null;
  maxRowsOverride: number | null;
};

export async function jobControls(): Promise<Map<string, JobControl>> {
  const result = await withPlatformScope("Scheduler: reading the operator overrides that decide whether a job runs at all, which apply to every workspace", (tx) =>
    tx.execute(sql`
      SELECT job_id, enabled, paused_reason, paused_by, paused_at,
             cron_override, max_ms_override, max_rows_override
        FROM scheduler_job_controls
    `),
  );
  const map = new Map<string, JobControl>();
  for (const r of rowsOf(result)) {
    map.set(str(r.job_id), {
      jobId: str(r.job_id),
      enabled: r.enabled !== false,
      pausedReason: r.paused_reason ? str(r.paused_reason) : null,
      pausedBy: r.paused_by ? str(r.paused_by) : null,
      pausedAt: date(r.paused_at),
      cronOverride: r.cron_override ? str(r.cron_override) : null,
      maxMsOverride: r.max_ms_override === null ? null : num(r.max_ms_override),
      maxRowsOverride: r.max_rows_override === null ? null : num(r.max_rows_override),
    });
  }
  return map;
}

export async function setJobEnabled(args: {
  jobId: string;
  enabled: boolean;
  reason: string;
  by: string;
}): Promise<void> {
  await withPlatformScope(`Scheduler: an operator is switching ${args.jobId} ${args.enabled ? "on" : "off"} for every workspace at once`, (tx) =>
    tx.execute(sql`
      INSERT INTO scheduler_job_controls
        (job_id, enabled, paused_reason, paused_by, paused_at, updated_at, updated_by)
      VALUES (
        ${args.jobId}, ${args.enabled},
        ${args.enabled ? null : args.reason},
        ${args.enabled ? null : args.by},
        ${args.enabled ? null : new Date().toISOString()}::timestamptz,
        now(), ${args.by}
      )
      ON CONFLICT (job_id) DO UPDATE
        SET enabled       = EXCLUDED.enabled,
            paused_reason = EXCLUDED.paused_reason,
            paused_by     = EXCLUDED.paused_by,
            paused_at     = EXCLUDED.paused_at,
            updated_at    = now(),
            updated_by    = EXCLUDED.updated_by
    `),
  );
}

export type TenantPause = {
  id: string;
  jobId: string;
  subjectTenantId: string;
  reason: string;
  pausedBy: string;
  pausedAt: Date | null;
  expiresAt: Date | null;
};

export async function activeTenantPauses(): Promise<TenantPause[]> {
  const result = await withPlatformScope("Scheduler: which workspaces are held back from which jobs is a question that spans every workspace by definition", (tx) =>
    tx.execute(sql`
      SELECT id::text AS id, job_id, subject_tenant_id::text AS subject_tenant_id,
             reason, paused_by, paused_at, expires_at
        FROM scheduler_tenant_pauses
       WHERE lifted_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY paused_at DESC
    `),
  );
  return rowsOf(result).map((r) => ({
    id: str(r.id),
    jobId: str(r.job_id),
    subjectTenantId: str(r.subject_tenant_id),
    reason: str(r.reason),
    pausedBy: str(r.paused_by),
    pausedAt: date(r.paused_at),
    expiresAt: date(r.expires_at),
  }));
}

export async function pauseTenant(args: {
  jobId: string;
  subjectTenantId: string;
  reason: string;
  by: string;
  expiresAt: Date | null;
}): Promise<void> {
  await withPlatformScope(
    `Scheduler: recording a platform decision to hold workspace ${args.subjectTenantId} back from ${args.jobId}`,
    (tx) =>
      tx.execute(sql`
        INSERT INTO scheduler_tenant_pauses
          (job_id, subject_tenant_id, reason, paused_by, expires_at)
        VALUES (
          ${args.jobId}, ${args.subjectTenantId}::uuid, ${args.reason}, ${args.by},
          ${args.expiresAt ? args.expiresAt.toISOString() : null}::timestamptz
        )
      `),
  );
}

export async function liftTenantPause(args: {
  pauseId: string;
  by: string;
  reason: string;
}): Promise<boolean> {
  const result = await withPlatformScope(`Scheduler: an operator is lifting pause ${args.pauseId}, a platform decision recorded about one workspace`, (tx) =>
    tx.execute(sql`
      UPDATE scheduler_tenant_pauses
         SET lifted_at = now(), lifted_by = ${args.by}, lifted_reason = ${args.reason}
       WHERE id = ${args.pauseId}::uuid
         AND lifted_at IS NULL
      RETURNING id::text AS id
    `),
  );
  return rowsOf(result).length > 0;
}

export type TenantSchedule = {
  jobId: string;
  subjectTenantId: string;
  cronExpr: string;
  timezone: string;
  reason: string;
};

export async function tenantSchedules(): Promise<TenantSchedule[]> {
  const result = await withPlatformScope("Scheduler: the tick must apply every workspace own cadence override before it can decide what is due", (tx) =>
    tx.execute(sql`
      SELECT job_id, subject_tenant_id::text AS subject_tenant_id, cron_expr, timezone, reason
        FROM scheduler_tenant_schedules
    `),
  );
  return rowsOf(result).map((r) => ({
    jobId: str(r.job_id),
    subjectTenantId: str(r.subject_tenant_id),
    cronExpr: str(r.cron_expr),
    timezone: str(r.timezone),
    reason: str(r.reason),
  }));
}

/** Re-exported so the runner does not import the policy module twice. */
export type { OverrunPolicy };
