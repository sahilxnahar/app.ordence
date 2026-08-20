import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE TICK: ONE CLOCK, MANY CADENCES
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THERE IS ONE RAILWAY CRON SERVICE AND NOT EIGHT
 * ══════════════════════════════════════════════════════════════════════
 * The obvious shape is one Railway cron service per job, each with the
 * job's own cron expression set in the Railway UI. It is also how the
 * cadence stops being a fact about this codebase: eight schedules would
 * live in a web console, `cronUtc` in `server/scheduling/registry.ts`
 * would become documentation of what somebody typed there once, and the
 * generated runbook would describe a schedule nothing enforces. Adding a
 * ninth job would silently not run until a human remembered.
 *
 * So there is ONE service, on a five-minute cron, and it does not know
 * what the jobs are. It asks the application "what is due", and the
 * application answers from the catalog. The cadence stays in the
 * repository, a new job is scheduled by the commit that adds it, and the
 * Railway console holds one line that never changes.
 *
 * ⚠️ THE COST IS FIVE MINUTES OF GRANULARITY. A slot at 19:30 runs by
 * 19:34. Every cadence in this product is fifteen minutes or slower, so
 * this is invisible; it is written down because it is the kind of thing
 * that is invisible right up until somebody adds a per-minute job.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE TICK RUNS THE CURRENT SLOT. IT DOES NOT REPLAY A WEEK.
 * ══════════════════════════════════════════════════════════════════════
 * If the scheduler has been down for three days, an hourly job has 72 due
 * slots. Running all 72 on the first tick back would be a stampede for no
 * benefit: `mail_drain` drains whatever is in the outbox now, and 72 runs
 * would drain it once and do nothing 71 times.
 *
 * So the tick claims only the MOST RECENT due slot per (job, workspace).
 * The older ones stay missing, they are visible as gaps on the jobs
 * calendar, and running them is a deliberate backfill with a
 * justification. That is what the brief asks for — "run the missed slots
 * deliberately, in order" — and it is the opposite of a scheduler that
 * quietly catches up and leaves nobody knowing what happened.
 */

import {
  SCHEDULER_CATALOG,
  findCatalogEntry,
  findSchedulableTenant,
  listSchedulableTenants,
  type CatalogEntry,
  type SchedulableTenant,
} from "@/server/scheduler/catalog";
import { parseCron, slotsBetween, nextSlotAfter } from "@/server/scheduler/cron";
import {
  beat,
  claimSlot,
  finishRun,
  jobControls,
  lastHandledSlot,
  pauseReason,
  recordSkip,
  pendingClaimedRuns,
  reclaimStale,
  slotsAlreadyRecorded,
  syncExpectations,
  tenantSchedules,
  type JobControl,
  type TenantSchedule,
} from "@/server/scheduler/ledger";
import { runUnit, startClaimedRun, type UnitOutcome } from "@/server/scheduler/runner";

/**
 * How long one tick will spend before handing the rest to the next tick.
 *
 * ⚠️ SHORTER THAN THE TICK INTERVAL ON PURPOSE. At a five-minute cron a
 * tick that ran for six minutes would overlap its successor, and two ticks
 * racing is exactly what the ledger claim has to absorb on every slot
 * rather than occasionally. Four minutes leaves a minute of margin.
 */
export const TICK_BUDGET_MS = 4 * 60_000;

/**
 * How far back a tick will look for a due slot it has not handled.
 *
 * A job whose last ledger row is older than this does not get its slots
 * enumerated at all — `slotsBetween` would be asked to scan weeks. It
 * simply runs its next slot when the next one comes, and the missing ones
 * are visible on the calendar as gaps.
 */
export const TICK_LOOKBACK_HOURS = 6;

/** A run whose heartbeat is older than this is declared dead. */
export const STALE_RUN_SECONDS = 30 * 60;

export const MAX_TENANTS_PER_TICK = 500;

export type TickReport = {
  ok: boolean;
  startedAt: string;
  tookMs: number;
  budgetExhausted: boolean;
  expectationsDeclared: number;
  expectationsRetired: number;
  staleReclaimed: number;
  resumedQueued: number;
  unitsConsidered: number;
  unitsRun: number;
  unitsSkipped: number;
  unitsFailed: number;
  tenantsNotReached: number;
  outcomes: UnitOutcome[];
  errors: string[];
  /**
   * ⭐ SLOTS CLAIMED FOR THE MAINTENANCE LANE, HANDED BACK TO THE CALLER
   * TO EXECUTE. Empty unless the caller said it can reach the database as
   * `ordence_maintenance` — see `claimMaintenance` below.
   */
  maintenance: MaintenanceHandoff[];
};

/**
 * A maintenance slot the application has claimed but cannot run.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE CLAIM AND THE EXECUTION HAPPEN IN DIFFERENT PROCESSES
 * ══════════════════════════════════════════════════════════════════════
 * The exactly-once guarantee lives in one place — the partial unique
 * index in 0129 — and the application role can write `scheduler_runs`, so
 * the application does the claim. What it cannot do is EXECUTE
 * `prune_security_events()`, `prune_usage_counters()` or
 * `prune_change_log()`: 0012 refused them in a comment, 0087 granted one
 * back by copying a signature without reading the role, 0121 revoked it
 * and sealed it, 0128 withheld the third at creation, and
 * `npm run check:sealed-grants` fails the build on any .sql file that
 * grants them again.
 *
 * So the claim is here and the execution is in
 * `server/scheduler/cron-entrypoint.mjs`, over a second connection as
 * `ordence_maintenance`. Both write the same ledger row, so the jobs
 * calendar shows one list rather than two.
 */
export type MaintenanceHandoff = {
  runId: string;
  jobId: string;
  slotAt: string;
  /** Executed verbatim by the maintenance connection. Never interpolated. */
  sqlCall: string;
  maxMs: number;
};

function resolveCron(
  entry: CatalogEntry,
  control: JobControl | undefined,
  tenantSchedule: TenantSchedule | undefined,
): { expr: string; timeZone: string; source: string } {
  if (tenantSchedule) {
    return {
      expr: tenantSchedule.cronExpr,
      timeZone: tenantSchedule.timezone,
      source: "workspace override",
    };
  }
  if (control?.cronOverride) {
    return { expr: control.cronOverride, timeZone: "UTC", source: "operator override" };
  }
  return { expr: entry.cronUtc, timeZone: "UTC", source: "code" };
}

/* ================================================================== */
/* THE TICK                                                            */
/* ================================================================== */

export async function runTick(args: {
  now?: Date;
  source: string;
  budgetMs?: number;
  /**
   * 🔴 FALSE BY DEFAULT, AND THAT IS THE SAFE DIRECTION. A maintenance
   * slot claimed by a caller that cannot execute it is a slot held by
   * nobody: the row sits in `claimed` until the watchdog reclaims it
   * thirty minutes later, the `skip` overrun policy suppresses the next
   * slot in the meantime, and the job is worse off than if the scheduler
   * had never touched it.
   *
   * The cron service sets this only when `MAINTENANCE_DATABASE_URL` is
   * present. When it is absent nothing is claimed, the jobs simply do not
   * run, and `scheduler_overdue()` reports them — so "retention is not
   * configured" is visible rather than silent, which is the entire
   * difference between this and the three years before it.
   */
  claimMaintenance?: boolean;
}): Promise<TickReport> {
  const now = args.now ?? new Date();
  const startedAt = Date.now();
  const budgetMs = args.budgetMs ?? TICK_BUDGET_MS;
  const deadline = startedAt + budgetMs;

  const outcomes: UnitOutcome[] = [];
  const errors: string[] = [];
  let tenantsNotReached = 0;
  let resumedQueued = 0;
  let unitsConsidered = 0;
  const maintenance: MaintenanceHandoff[] = [];

  /* ---- 0. Say the clock is alive, FIRST -----------------------------
   *
   * 🔴 BEFORE ANY WORK, NOT AFTER IT. A heartbeat written at the end of
   * the tick is not a heartbeat, it is a completion record: a tick that
   * hangs on the first job never writes one, and the watchdog reports the
   * clock dead when the clock is in fact alive and stuck. Those are
   * different faults needing different responses, and only a heartbeat
   * written first can tell them apart.
   */
  await beat(args.source, { startedAt: now.toISOString(), budgetMs });

  /* ---- 1. Mirror the catalog into the database ---------------------- */
  //
  // The watchdog reads `scheduler_job_expectations`, not the code, because
  // it has to be able to answer when the code is not running. This is the
  // only thing that keeps that copy true.
  let expectationsDeclared = 0;
  let expectationsRetired = 0;
  try {
    const synced = await syncExpectations(
      SCHEDULER_CATALOG.map((e) => ({
        jobId: e.id,
        lane: e.lane,
        label: e.label,
        cronUtc: e.cronUtc,
        maxSilenceSeconds: e.maxSilenceSeconds,
        consequence: e.consequenceWhenStopped,
      })),
    );
    expectationsDeclared = synced.declared;
    expectationsRetired = synced.retired;
  } catch (err) {
    errors.push(`syncExpectations failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /* ---- 2. Free claims held by processes that no longer exist -------- */
  let staleReclaimed = 0;
  try {
    staleReclaimed = await reclaimStale(STALE_RUN_SECONDS);
  } catch (err) {
    errors.push(`reclaimStale failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /* ---- 3. Resume anything the `queue` policy parked ------------------ */
  try {
    for (const pending of await pendingClaimedRuns()) {
      if (Date.now() > deadline) break;
      const entry = findCatalogEntry(pending.jobId);
      if (!entry || !entry.job) continue;

      /**
       * ⚠️ THE WORKSPACE IS RE-READ HERE, AND ONLY HERE. A parked run
       * carries a workspace ID in the ledger and nothing else, and the
       * row it needs may have changed — or been suspended — between the
       * tick that parked it and this one. That is one read per PARKED
       * run, not one per workspace per job, and a parked run is rare by
       * construction (it takes an overrun under the `queue` policy).
       */
      let tenant: SchedulableTenant | null = null;
      if (pending.subjectTenantId) {
        tenant = await findSchedulableTenant(pending.subjectTenantId);
        if (!tenant) {
          /**
           * 🔴 THE WORKSPACE WENT AWAY WHILE THE SLOT WAS PARKED. Running
           * anyway is impossible and finishing silently would leave a
           * claimed row for the watchdog to reclaim in half an hour, with
           * no reason recorded.
           */
          await finishRun({
            runId: pending.id,
            state: "failed",
            error:
              `Workspace ${pending.subjectTenantId} is no longer active, so the slot this run ` +
              `was queued for cannot be executed.`,
          });
          continue;
        }
      }

      const outcome = await startClaimedRun({
        entry,
        runId: pending.id,
        tenant,
        slotAt: pending.slotAt,
        runKind: "scheduled",
      });
      outcomes.push(outcome);
      resumedQueued += 1;
    }
  } catch (err) {
    errors.push(`resuming queued runs failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /* ---- 4. What is due ---------------------------------------------- */
  const controls = await jobControls();
  const schedules = await tenantSchedules();

  /**
   * ⚠️ THE WORKSPACE LIST IS FETCHED ONCE PER TICK, NOT ONCE PER JOB.
   * `runScheduledJob` fetches it again on each of its own calls, which is
   * the waste PATCH-REQUEST-A.md is about; there is no reason for the tick
   * to add to it.
   */
  const hasPerTenantJob = SCHEDULER_CATALOG.some(
    (e) => e.lane === "app" && e.scope === "per-tenant",
  );
  const tenantList = hasPerTenantJob
    ? await listSchedulableTenants(MAX_TENANTS_PER_TICK)
    : { tenants: [], notReached: 0 };
  tenantsNotReached = tenantList.notReached;

  for (const entry of SCHEDULER_CATALOG) {
    if (Date.now() > deadline) break;

    /**
     * ⚠️ THE MAINTENANCE LANE IS NOT RUN HERE AND THAT IS NOT AN
     * OVERSIGHT. Those jobs execute SQL functions the application role is
     * deliberately refused (0121, 0128, sealed-grants.json). The cron
     * service runs them over a separate connection. See 0132 Section 6.
     */
    if (entry.lane !== "app" || !entry.job) continue;

    const control = controls.get(entry.id);

    /**
     * A globally disabled job is not run and is not recorded as skipped
     * either — a `skipped_paused` row per slot for a job disabled for
     * three weeks would be several hundred rows saying the same thing.
     * The pause is visible on the calendar with its reason and its age,
     * and `watchdog.ts` reports a pause older than 30 days as an outage.
     */
    if (control && !control.enabled) continue;

    const units: Array<{
      tenant: SchedulableTenant | null;
      schedule: TenantSchedule | undefined;
    }> =
      entry.scope === "platform"
        ? [{ tenant: null, schedule: undefined }]
        : tenantList.tenants.map((t) => ({
            tenant: t,
            schedule: schedules.find((s) => s.jobId === entry.id && s.subjectTenantId === t.id),
          }));

    /** Per-job wall clock, so one slow job cannot consume the whole tick. */
    const jobStartedAt = Date.now();
    const jobDeadline = jobStartedAt + (control?.maxMsOverride ?? entry.policy.maxMs);

    for (const unit of units) {
      const nowMs = Date.now();
      if (nowMs > deadline) break;
      if (nowMs > jobDeadline) {
        /**
         * ⭐ THE BUDGET GUARD ACTUALLY STOPPING SOMETHING. The workspaces
         * not reached keep their slot unclaimed, so the next tick picks
         * them up — `lastHandledSlot` is per workspace, which is what
         * makes that true.
         */
        errors.push(
          `Job "${entry.id}" hit its ${entry.policy.maxMs}ms budget after ` +
            `${nowMs - jobStartedAt}ms; remaining workspaces are left for the next tick.`,
        );
        break;
      }

      const cron = resolveCron(entry, control, unit.schedule);

      let due: Date[];
      try {
        const parsed = parseCron(cron.expr);
        const last = await lastHandledSlot(entry.id, unit.tenant?.id ?? null);
        const floor = new Date(now.getTime() - TICK_LOOKBACK_HOURS * 3600_000);
        const from = last && last > floor ? last : floor;
        due = slotsBetween(parsed, from, now, cron.timeZone);
      } catch (err) {
        errors.push(
          `Job "${entry.id}" has an unusable cron "${cron.expr}" (${cron.source}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }

      if (due.length === 0) continue;

      /**
       * 🔴 THE MOST RECENT DUE SLOT ONLY. See this file's header. The
       * older ones are left missing on purpose and a backfill is the way
       * to run them.
       */
      const slot = due[due.length - 1];
      if (!slot) continue;

      unitsConsidered += 1;

      const outcome = await runUnit({
        entry,
        slotAt: slot,
        tenant: unit.tenant,
        runKind: "scheduled",
        triggeredBy: `tick:${args.source}`,
        maxMsOverride: control?.maxMsOverride ?? null,
        maxRowsOverride: control?.maxRowsOverride ?? null,
      });
      outcomes.push(outcome);

      if (outcome.state === "budget_exceeded") {
        errors.push(
          `Job "${entry.id}" exceeded its budget on ${unit.tenant?.slug ?? "the platform"}: ` +
            `${outcome.error ?? "no detail"}`,
        );
        break;
      }
    }
  }

  /* ---- 5. Claim maintenance-lane slots, if the caller can run them -- */
  if (args.claimMaintenance) {
    for (const entry of SCHEDULER_CATALOG) {
      if (entry.lane !== "maintenance" || !entry.maintenance) continue;
      if (Date.now() > deadline) break;

      const control = controls.get(entry.id);
      if (control && !control.enabled) continue;

      try {
        const parsed = parseCron(control?.cronOverride ?? entry.cronUtc);
        const last = await lastHandledSlot(entry.id, null);
        /**
         * ⚠️ A LONGER LOOKBACK THAN THE APP LANE, because these are
         * monthly. A six-hour window would never contain the 1st-of-the-
         * month slot unless the tick happened to run in that window, so a
         * monthly job would be missed by a scheduler that was down for one
         * morning and never picked up again.
         */
        const floor = new Date(now.getTime() - 36 * 3600_000);
        const from = last && last > floor ? last : floor;
        const due = slotsBetween(parsed, from, now);
        const slot = due[due.length - 1];
        if (!slot) continue;

        const pause = await pauseReason(entry.id, null);
        if (pause) {
          await recordSkip({
            jobId: entry.id,
            lane: "maintenance",
            subjectTenantId: null,
            slotAt: slot,
            state: "skipped_paused",
            reason: pause,
            triggeredBy: `tick:${args.source}`,
          });
          continue;
        }

        const claim = await claimSlot({
          jobId: entry.id,
          lane: "maintenance",
          subjectTenantId: null,
          slotAt: slot,
          runKind: "scheduled",
          triggeredBy: `tick:${args.source}`,
          deadlineAt: new Date(Date.now() + entry.policy.maxMs),
          maxRows: entry.policy.maxRows,
        });

        if (!claim.claimed) continue;

        maintenance.push({
          runId: claim.runId,
          jobId: entry.id,
          slotAt: slot.toISOString(),
          sqlCall: entry.maintenance.sqlCall,
          maxMs: entry.policy.maxMs,
        });
      } catch (err) {
        errors.push(
          `Maintenance job "${entry.id}" could not be scheduled: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const unitsRun = outcomes.filter((o) => o.state === "succeeded").length;
  const unitsFailed = outcomes.filter(
    (o) => o.state === "failed" || o.state === "budget_exceeded",
  ).length;
  const unitsSkipped = outcomes.filter(
    (o) =>
      o.state === "skipped_paused" || o.state === "skipped_overrun" || o.state === "not_claimed",
  ).length;

  const budgetExhausted = Date.now() > deadline;

  /**
   * 🔴 `ok` IS FALSE WHEN ANYTHING FAILED, WHEN A WORKSPACE WAS NOT
   * REACHED, OR WHEN THE TICK RAN OUT OF TIME. The cron service turns
   * this into its exit code and Railway turns that into a red run. A tick
   * that quietly ran out of budget every night while reporting green is
   * how a job ends up never running for the last thirty workspaces in the
   * list.
   */
  return {
    ok: unitsFailed === 0 && errors.length === 0 && tenantsNotReached === 0 && !budgetExhausted,
    startedAt: now.toISOString(),
    tookMs: Date.now() - startedAt,
    budgetExhausted,
    expectationsDeclared,
    expectationsRetired,
    staleReclaimed,
    resumedQueued,
    unitsConsidered,
    unitsRun,
    unitsSkipped,
    unitsFailed,
    tenantsNotReached,
    outcomes,
    errors,
    maintenance,
  };
}

/* ================================================================== */
/* RUN NOW                                                             */
/* ================================================================== */

export type RunNowResult =
  | { ok: true; outcome: UnitOutcome }
  | { ok: false; error: string };

/**
 * An operator running a job by hand.
 *
 * ⚠️ `run_kind = 'manual'` AND `slot_at = NULL`, SO IT NEVER TAKES A SLOT.
 * A "run now" at 19:29 must not consume the 19:30 slot and silently
 * cancel that evening's real run — 0129 has a CHECK constraint refusing
 * the row that would do it, because this is the kind of rule that is
 * obeyed by the code that was written next to it and forgotten by the
 * code written six months later.
 */
export async function runNow(args: {
  jobId: string;
  subjectTenantId: string | null;
  justification: string;
  operator: string;
}): Promise<RunNowResult> {
  const entry = findCatalogEntry(args.jobId);
  if (!entry) {
    return { ok: false, error: `No scheduled job called "${args.jobId}".` };
  }
  if (entry.lane !== "app") {
    return {
      ok: false,
      error:
        `"${args.jobId}" runs in the ${entry.lane} lane, over a separate database connection ` +
        `as ordence_maintenance. The application role is deliberately refused these ` +
        `functions — see SQL-FILES/0132 and docs/SCHEDULER.md. Run it from the cron ` +
        `service or by hand in a SQL console as that role.`,
    };
  }
  if (args.justification.trim().length < 20) {
    return {
      ok: false,
      error:
        "A hand-started run needs a written justification of at least 20 characters. " +
        "It is recorded on the run and in the platform action log.",
    };
  }
  if (entry.scope === "platform" && args.subjectTenantId !== null) {
    return {
      ok: false,
      error: `"${args.jobId}" is platform-scoped and cannot be run for a single workspace.`,
    };
  }
  let tenant: SchedulableTenant | null = null;
  if (args.subjectTenantId !== null) {
    tenant = await findSchedulableTenant(args.subjectTenantId);
  }
  if (args.subjectTenantId !== null && tenant === null) {
    /**
     * ⚠️ REFUSED RATHER THAN RUN. `runScheduledJob` with an unknown
     * `onlyTenantId` filters the workspace list down to nothing and
     * returns `ok: true, tenantsConsidered: 0` — a green result for a run
     * that did nothing, which is the whole pattern this wave is about.
     */
    return {
      ok: false,
      error:
        `No active workspace ${args.subjectTenantId}. Running anyway would consider zero ` +
        `workspaces and report success.`,
    };
  }

  const outcome = await runUnit({
    entry,
    slotAt: null,
    tenant,
    runKind: "manual",
    triggeredBy: `operator:${args.operator}`,
    justification: args.justification.trim(),
  });

  return { ok: true, outcome };
}

/* ================================================================== */
/* MISSED SLOTS AND BACKFILL                                           */
/* ================================================================== */

export type MissedSlot = {
  jobId: string;
  subjectTenantId: string | null;
  slotAt: Date;
};

/**
 * Slots that came due and have no ledger row at all.
 *
 * ⚠️ "NO ROW AT ALL" IS THE DEFINITION, AND IT EXCLUDES SKIPS ON PURPOSE.
 * A slot that was skipped because the workspace was paused is not missed,
 * it was decided; offering it for backfill would mean an operator
 * accidentally undoing a colleague's pause by clicking Replay.
 */
export async function missedSlots(args: {
  jobId: string;
  subjectTenantId: string | null;
  sinceHours: number;
  now?: Date;
}): Promise<MissedSlot[]> {
  const entry = findCatalogEntry(args.jobId);
  if (!entry) return [];

  const now = args.now ?? new Date();
  const from = new Date(now.getTime() - Math.min(args.sinceHours, 30 * 24) * 3600_000);

  const parsed = parseCron(entry.cronUtc);
  const expected = slotsBetween(parsed, from, now);
  if (expected.length === 0) return [];

  const first = expected[0];
  const last = expected[expected.length - 1];
  /* c8 ignore next -- non-empty array, checked above. */
  if (!first || !last) return [];

  const recorded = await slotsAlreadyRecorded({
    jobId: args.jobId,
    subjectTenantId: args.subjectTenantId,
    fromInclusive: first,
    toInclusive: last,
  });

  return expected
    .filter((slot) => !recorded.has(slot.getTime()))
    .map((slot) => ({ jobId: args.jobId, subjectTenantId: args.subjectTenantId, slotAt: slot }));
}

export type BackfillResult =
  | { ok: true; outcomes: UnitOutcome[] }
  | { ok: false; error: string };

/**
 * Replay missed slots, oldest first.
 *
 * 🔴 OLDEST FIRST IS NOT COSMETIC. Dunning is a ladder: rung two is only
 * correct if rung one has been recorded. Replaying Friday before Thursday
 * would advance a workspace past a rung it never received a letter for,
 * and there is no way to un-send the wrong notice.
 *
 * ⚠️ EACH REPLAYED SLOT TAKES THE SAME CLAIM A LIVE RUN WOULD, so a slot
 * that has since been run by a recovering tick is refused rather than
 * duplicated, and the refusal is reported as `not_claimed` rather than as
 * an error.
 */
export async function runBackfill(args: {
  jobId: string;
  subjectTenantId: string | null;
  slots: Date[];
  justification: string;
  operator: string;
  maxSlots?: number;
}): Promise<BackfillResult> {
  const entry = findCatalogEntry(args.jobId);
  if (!entry) return { ok: false, error: `No scheduled job called "${args.jobId}".` };
  if (entry.lane !== "app") {
    return { ok: false, error: `"${args.jobId}" runs in the ${entry.lane} lane.` };
  }
  if (!entry.policy.backfillable) {
    return {
      ok: false,
      error:
        `"${args.jobId}" is declared not backfillable in server/scheduler/policy.ts, and the ` +
        `reason is written there. Replaying it would either do nothing or do the wrong thing ` +
        `— for example, re-firing every workflow that a recovering dispatcher already fired ` +
        `once, or recording anomaly findings from the last two hours against a slot three ` +
        `days ago.`,
    };
  }
  if (args.justification.trim().length < 20) {
    return { ok: false, error: "A backfill needs a written justification of at least 20 characters." };
  }
  if (args.slots.length === 0) {
    return { ok: false, error: "No slots were selected." };
  }

  const cap = Math.min(args.maxSlots ?? 24, 48);
  if (args.slots.length > cap) {
    /**
     * ⚠️ REFUSED, NOT TRUNCATED. A backfill that silently ran the first 24
     * of 200 selected slots would report success on a job that is still
     * 176 slots behind, and nobody would look again.
     */
    return {
      ok: false,
      error:
        `${args.slots.length} slots selected, over the ${cap}-slot limit for one backfill. ` +
        `Run it in batches — a backfill that silently truncated would report success on a ` +
        `job still hours behind.`,
    };
  }

  /**
   * ⚠️ THE WORKSPACE IS RESOLVED ONCE, BEFORE THE LOOP. Resolving it per
   * slot would put a tenant-table read inside a loop that may run 24
   * times, which is the shape wave 17 removed from the tick.
   */
  let tenant: SchedulableTenant | null = null;
  if (args.subjectTenantId !== null) {
    tenant = await findSchedulableTenant(args.subjectTenantId);
    if (!tenant) {
      return {
        ok: false,
        error:
          `No active workspace ${args.subjectTenantId}. A replay against a workspace that ` +
          `does not exist would consider nothing and report success.`,
      };
    }
  }

  const ordered = [...args.slots].sort((a, b) => a.getTime() - b.getTime());
  const outcomes: UnitOutcome[] = [];

  for (const slot of ordered) {
    const outcome = await runUnit({
      entry,
      slotAt: slot,
      tenant,
      runKind: "backfill",
      triggeredBy: `operator:${args.operator}`,
      justification: args.justification.trim(),
    });
    outcomes.push(outcome);

    /**
     * 🔴 STOP ON THE FIRST FAILURE, BECAUSE THESE ARE ORDERED. Carrying on
     * after a failed rung would replay later slots on top of a gap, which
     * is the one thing "in order" was supposed to prevent.
     */
    if (outcome.state === "failed" || outcome.state === "budget_exceeded") break;
  }

  return { ok: true, outcomes };
}

/** Next scheduled fire, for the calendar. Null when there is none. */
export function nextRunFor(entry: CatalogEntry, after = new Date()): Date | null {
  try {
    return nextSlotAfter(parseCron(entry.cronUtc), after);
  } catch {
    return null;
  }
}
