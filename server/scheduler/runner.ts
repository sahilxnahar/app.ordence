import "server-only";

/**
 * Ordence — EXECUTING ONE UNIT OF SCHEDULED WORK, EXACTLY ONCE
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT A "UNIT" IS, AND WHY IT IS NOT "A JOB"
 * ══════════════════════════════════════════════════════════════════════
 * A unit is one (job, slot, workspace) — or one (job, slot) for a
 * platform-scoped job. A per-tenant job at one slot is therefore N units
 * and N ledger rows, not one.
 *
 * That costs more ledger rows than a single fan-out row would. It buys
 * four things the brief asks for and that a single fan-out row cannot
 * give:
 *
 *   1. PER-WORKSPACE PAUSE is a real skip with a reason attached to the
 *      workspace it applies to, rather than a filter inside an opaque run.
 *   2. PER-WORKSPACE CADENCE is possible at all. A workspace on its own
 *      schedule has its own slots, which cannot exist inside one shared
 *      slot row.
 *   3. THE BUDGET GUARD CAN ACTUALLY STOP SOMETHING. The scheduler owns
 *      the boundary between workspaces, so a job that has burned its
 *      budget on workspace 3 does not go on to workspace 4. Inside a
 *      single fan-out call there is no boundary the scheduler owns and
 *      "budget" could only ever be a post-hoc observation.
 *   4. CANCELLATION IS COOPERATIVE AT THAT SAME BOUNDARY.
 *
 * ⚠️ AND IT USED TO COST A TENANT-TABLE READ PER WORKSPACE, WHICH IT NO
 * LONGER DOES. The first delivery reached the work through
 * `runScheduledJob(job, { onlyTenantId })`, which lists up to 501
 * workspaces and filters them down to one — so twelve workspaces meant
 * twelve identical reads of a table the tick had already read. Wave 17
 * calls `job.runForTenant` directly and passes the workspace row the tick
 * already holds. See `executeUnit` at the foot of this file for what had
 * to be preserved in the move, and why the entitlement gate is imported
 * rather than reimplemented.
 */

/**
 * ⚠️ `tenantAllowsFeature`, NOT A REIMPLEMENTATION OF IT.
 *
 * The runner no longer goes through `runScheduledJob` (see
 * `executeUnit` below), so it has to apply the entitlement gate itself.
 * It applies the SAME function the registry applies — importing it is
 * reading, which this track may do. A second copy of "is this workspace
 * entitled" is a second place for the answer to drift, and the drift
 * would be invisible: the wrong workspaces would quietly get a paid
 * capability, or quietly stop getting one.
 */
import { tenantAllowsFeature } from "@/server/scheduling/entitlement";
import type { CatalogEntry, SchedulableTenant } from "@/server/scheduler/catalog";
import {
  claimSlot,
  finishRun,
  heartbeat,
  inFlightRuns,
  markStarted,
  pauseReason,
  recordSkip,
  type RunKind,
  type RunState,
} from "@/server/scheduler/ledger";
import type { OverrunPolicy } from "@/server/scheduler/policy";
import { requestCancel } from "@/server/scheduler/ledger";

export type UnitOutcome = {
  jobId: string;
  subjectTenantId: string | null;
  slotAt: Date | null;
  runKind: RunKind;
  /** null when nothing was claimed, so nothing ran and nothing was recorded. */
  runId: string | null;
  state: RunState | "not_claimed";
  detail: Record<string, unknown>;
  error: string | null;
  tookMs: number;
};

/* ------------------------------------------------------------------ */
/* OVERRUN                                                             */
/* ------------------------------------------------------------------ */

export type OverrunDecision =
  | { proceed: true; note?: string }
  | { proceed: false; state: "skipped_overrun"; reason: string };

/**
 * Decide what to do about a previous run of the same job that has not
 * finished.
 *
 * 🔴 `kill` DOES NOT KILL, AND THIS FUNCTION IS WHERE THAT IS TRUE RATHER
 * THAN WHERE IT IS EXPLAINED AWAY. It sets `cancel_requested` on the
 * in-flight ledger row. The other run reads that flag at its next
 * workspace boundary and stops. So:
 *
 *   • a run between workspaces stops within one workspace's work;
 *   • a run WEDGED INSIDE one workspace is not stopped by this at all —
 *     that is `scheduler_reclaim_stale()` in 0131, which ends the claim
 *     once the heartbeat dies;
 *   • and `kill` therefore proceeds immediately, alongside the run it
 *     asked to stop, for as long as that takes to notice.
 *
 * A `kill` that returned `proceed: false` until the other run actually
 * ended would be `queue` wearing a different word.
 */
export async function decideOverrun(args: {
  jobId: string;
  policy: OverrunPolicy;
  triggeredBy: string;
}): Promise<OverrunDecision> {
  const inFlight = await inFlightRuns(args.jobId);
  if (inFlight.length === 0) return { proceed: true };

  const oldest = inFlight[0];
  const describe = oldest
    ? `run ${oldest.id} claimed ${oldest.claimedAt?.toISOString() ?? "?"} is still ${oldest.state}`
    : "a previous run is still in flight";

  switch (args.policy) {
    case "skip":
      return {
        proceed: false,
        state: "skipped_overrun",
        reason: `Overrun policy "skip": ${describe}.`,
      };

    case "queue":
      /**
       * ⚠️ `queue` RETURNS `proceed: false` HERE AND THE SLOT IS STILL
       * CLAIMED BY THE CALLER — see `runUnit`, which claims first and only
       * then asks. The row sits in `claimed` and a later tick starts it.
       * Nothing is lost and nothing overlaps, which is what `queue` means.
       */
      return {
        proceed: false,
        state: "skipped_overrun",
        reason: `Overrun policy "queue": ${describe}. This slot is claimed and will start on a later tick.`,
      };

    case "kill": {
      for (const run of inFlight) {
        await requestCancel({
          runId: run.id,
          by: args.triggeredBy,
          reason: `Overrun policy "kill": a later slot for ${args.jobId} came due while this run was still going.`,
        });
      }
      return {
        proceed: true,
        note: `Asked ${inFlight.length} in-flight run(s) to stop; they end at their next workspace boundary.`,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* THE UNIT                                                            */
/* ------------------------------------------------------------------ */

export type RunUnitArgs = {
  entry: CatalogEntry;
  /** null only for a manual "run now". */
  slotAt: Date | null;
  /**
   * The workspace row, carried whole rather than as an id.
   *
   * ⚠️ THE ROW, NOT THE ID, BECAUSE THE ID WOULD HAVE TO BE RESOLVED BACK
   * INTO A ROW — which is exactly the per-workspace tenant-table read
   * this wave removed. The tick has already read `name` (the letter needs
   * it) and `plan_tier` (the entitlement check takes it as a cache).
   */
  tenant: SchedulableTenant | null;
  runKind: RunKind;
  triggeredBy: string;
  justification?: string | null;
  /** Overrides from `scheduler_job_controls`, already resolved. */
  maxMsOverride?: number | null;
  maxRowsOverride?: number | null;
};

/**
 * Claim, run, record. Never throws: a scheduler that throws is a scheduler
 * that stops scheduling everything else in the tick.
 */
export async function runUnit(args: RunUnitArgs): Promise<UnitOutcome> {
  const startedAt = Date.now();
  const { entry } = args;

  const subjectTenantId = args.tenant?.id ?? null;

  const base: Omit<UnitOutcome, "state" | "detail" | "error" | "tookMs" | "runId"> = {
    jobId: entry.id,
    subjectTenantId,
    slotAt: args.slotAt,
    runKind: args.runKind,
  };

  const done = (
    state: UnitOutcome["state"],
    detail: Record<string, unknown>,
    error: string | null,
    runId: string | null,
  ): UnitOutcome => ({
    ...base,
    runId,
    state,
    detail,
    error,
    tookMs: Date.now() - startedAt,
  });

  if (!entry.job) {
    return done(
      "failed",
      {},
      `Job "${entry.id}" is in the ${entry.lane} lane and cannot be run by the application. ` +
        `See SQL-FILES/0132 Section 6 and docs/SCHEDULER.md.`,
      null,
    );
  }

  /* ---- 1. Is this (job, workspace) allowed to run right now? -------- */
  //
  // ⚠️ CHECKED BEFORE THE CLAIM FOR A MANUAL RUN AND AFTER IT FOR A
  // SCHEDULED ONE? No — before, always. A paused slot must still TAKE the
  // slot (so the calendar shows a skip rather than a gap) but must not
  // reach `runScheduledJob`. `recordSkip` below does the claim and the
  // refusal in one statement.
  const paused = await pauseReason(entry.id, subjectTenantId);
  if (paused) {
    if (args.slotAt) {
      const skipId = await recordSkip({
        jobId: entry.id,
        lane: entry.lane,
        subjectTenantId,
        slotAt: args.slotAt,
        state: "skipped_paused",
        reason: paused,
        triggeredBy: args.triggeredBy,
      });
      return done("skipped_paused", { skipReason: paused }, null, skipId);
    }
    /**
     * ⚠️ A MANUAL RUN AGAINST A PAUSED JOB IS REFUSED, NOT SILENTLY
     * ALLOWED. An operator with a Run now button and a pause they set
     * themselves last week is exactly the person who should be told the
     * pause exists rather than have it quietly overridden.
     */
    return done("skipped_paused", { skipReason: paused }, null, null);
  }

  /* ---- 2. Claim ---------------------------------------------------- */
  const maxMs = args.maxMsOverride ?? entry.policy.maxMs;
  const maxRows = args.maxRowsOverride ?? entry.policy.maxRows;

  const claim = await claimSlot({
    jobId: entry.id,
    lane: entry.lane,
    subjectTenantId,
    slotAt: args.slotAt,
    runKind: args.runKind,
    triggeredBy: args.triggeredBy,
    justification: args.justification ?? null,
    deadlineAt: new Date(Date.now() + maxMs),
    maxRows,
  });

  if (!claim.claimed) {
    /**
     * 🔴 THIS IS THE EXACTLY-ONCE GUARANTEE FIRING, AND IT IS NOT AN
     * ERROR. Two ticks raced, or a backfill asked for a slot that already
     * ran. Either way the correct behaviour is to do nothing and say so.
     */
    return done("not_claimed", { reason: claim.reason }, null, null);
  }

  /* ---- 3. Overrun -------------------------------------------------- */
  const overrun = await decideOverrun({
    jobId: entry.id,
    policy: entry.policy.overrun,
    triggeredBy: args.triggeredBy,
  });

  if (!overrun.proceed) {
    if (entry.policy.overrun === "queue") {
      /**
       * ⭐ THE CLAIM IS KEPT AND THE ROW IS LEFT IN `claimed`. A later tick
       * finds it via `pendingClaimedRuns` and starts it. Finishing it here
       * would lose the slot.
       */
      return done("claimed", { queued: overrun.reason }, null, claim.runId);
    }
    await finishRun({
      runId: claim.runId,
      state: overrun.state,
      outcome: { skipReason: overrun.reason },
    });
    return done(overrun.state, { skipReason: overrun.reason }, null, claim.runId);
  }

  /* ---- 4. Run ------------------------------------------------------ */
  return startClaimedRun({
    entry,
    runId: claim.runId,
    tenant: args.tenant,
    slotAt: args.slotAt,
    runKind: args.runKind,
    note: overrun.proceed ? overrun.note : undefined,
    startedAt,
  });
}

/**
 * Execute a run that already holds its claim.
 *
 * Split out because the `queue` overrun policy leaves a claimed row for a
 * later tick to start, and that later tick must take exactly this path —
 * not re-claim, which would be refused, and not skip the ledger, which
 * would lose the outcome.
 */
export async function startClaimedRun(args: {
  entry: CatalogEntry;
  runId: string;
  tenant: SchedulableTenant | null;
  slotAt: Date | null;
  runKind: RunKind;
  note?: string | undefined;
  startedAt?: number;
}): Promise<UnitOutcome> {
  const startedAt = args.startedAt ?? Date.now();
  const { entry } = args;

  const done = (
    state: UnitOutcome["state"],
    detail: Record<string, unknown>,
    error: string | null,
  ): UnitOutcome => ({
    jobId: entry.id,
    subjectTenantId: args.tenant?.id ?? null,
    slotAt: args.slotAt,
    runKind: args.runKind,
    runId: args.runId,
    state,
    detail,
    error,
    tookMs: Date.now() - startedAt,
  });

  if (!entry.job) {
    await finishRun({ runId: args.runId, state: "failed", error: "no runnable job object" });
    return done("failed", {}, "no runnable job object");
  }

  await markStarted(args.runId);

  /**
   * ⚠️ THE STOP CONDITIONS ARE READ BEFORE THE WORK, NOT ONLY AFTER IT.
   * A run that sat in `claimed` for three ticks under the `queue` policy
   * may have been cancelled in the meantime, and starting it anyway would
   * make the Cancel button a suggestion.
   */
  const before = await heartbeat(args.runId, 0);
  if (before.cancelRequested) {
    await finishRun({
      runId: args.runId,
      state: "cancelled",
      outcome: { cancelledBeforeStart: true },
    });
    return done("cancelled", { cancelledBeforeStart: true }, null);
  }

  try {
    const outcome = await executeUnit(entry, args.tenant ?? null);

    if (outcome.skipped) {
      /**
       * ⭐ A WORKSPACE THAT IS NOT ENTITLED IS SKIPPED AND *SAID* TO BE
       * SKIPPED, which is the registry's own rule and the reason the
       * entitlement check moved here rather than being dropped. A
       * nightly job delivering a paid capability to a workspace that has
       * not paid for it is instance eleven of this codebase's pattern;
       * a job silently not delivering one is instance twelve.
       */
      await finishRun({
        runId: args.runId,
        state: "skipped_paused",
        outcome: { skipReason: outcome.skipped, entitlement: entry.feature },
      });
      return done("skipped_paused", { skipReason: outcome.skipped }, null);
    }

    const rows =
      typeof outcome.detail["removed"] === "number"
        ? (outcome.detail["removed"] as number)
        : 1;

    const after = await heartbeat(args.runId, rows);

    let state: RunState = "succeeded";
    let error: string | null = null;

    /**
     * ⭐ THE BUDGET GUARD, AND IT IS HONEST ABOUT WHICH HALF IT IS.
     *
     * 🔴 IT IS A GUARD *BETWEEN* UNITS AND A REPORT *WITHIN* ONE, and that
     * distinction is the whole answer to PATCH-REQUEST-A item 2.
     *
     * Between units it genuinely stops work: `tick.ts` checks the job's
     * elapsed time after every workspace and refuses to start the next
     * one, so a job that has burned its budget on workspace 3 does not
     * touch workspace 4 — and workspaces 4..N keep their slots unclaimed,
     * so the next tick picks them up.
     *
     * Within one unit it cannot stop anything, and pretending otherwise
     * would be the defect this whole wave is about. A JavaScript promise
     * is not cancellable. `Promise.race` against a timer would let the
     * scheduler stop *waiting*, but the work would carry on holding a
     * database transaction while the ledger row said the run had ended —
     * and a later tick would then be free to claim the next slot and run
     * concurrently with the orphan. That is not a budget guard; it is a
     * way of MANUFACTURING the double execution 0129 exists to prevent.
     * So the run is awaited, and exceeding the budget is recorded and
     * alerted rather than interrupted.
     *
     * Making it a real interrupt needs `job.runForTenant` to accept an
     * `AbortSignal` and honour it — a change to
     * `server/scheduling/registry.ts`, which is not in this track's
     * ownership block. The exact diff is PATCH-REQUEST-A item 2.
     */
    if (after.pastDeadline || after.pastRowBudget) {
      state = "budget_exceeded";
      error = after.pastDeadline
        ? `Exceeded its ${entry.policy.maxMs}ms wall-clock budget (took ${Date.now() - startedAt}ms). ` +
          `The work completed; the scheduler stops this job here and leaves the remaining ` +
          `workspaces' slots unclaimed for the next tick.`
        : `Reported ${rows} rows against a budget of ${entry.policy.maxRows}.`;
    }

    const detail: Record<string, unknown> = {
      ...outcome.detail,
      scope: entry.scope,
      tenantId: args.tenant?.id ?? null,
      note: args.note ?? undefined,
    };

    await finishRun({ runId: args.runId, state, outcome: detail, error, rowsProcessed: rows });
    return done(state, detail, error);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun({ runId: args.runId, state: "failed", error: message });
    return done("failed", {}, message);
  }
}


/* ------------------------------------------------------------------ */
/* EXECUTING ONE WORKSPACE, OR ONE PLATFORM JOB                        */
/* ------------------------------------------------------------------ */

type UnitResult = {
  /** Set when the workspace was not entitled. Nothing ran. */
  skipped?: string;
  detail: Record<string, number | string | boolean | null>;
};

/**
 * ⭐⭐ WHY THIS DOES NOT CALL `runScheduledJob`.
 *
 * It used to. `runScheduledJob(job, { onlyTenantId })` opens a
 * `withPlatformScope` transaction, SELECTs up to 501 workspace rows,
 * filters them down to the one it was given, and runs it. The scheduler
 * executes one workspace per unit, so that listing happened once per
 * workspace per job per slot — twelve workspaces meant twelve identical
 * reads of the tenant table where one had already been done by the tick.
 * At the `MAX_TENANTS_PER_JOB` bound of 500 it is 500. That is
 * PATCH-REQUEST-A item 3, and it is fixed here rather than there because
 * the wasteful loop is the scheduler's, not the registry's.
 *
 * ⚠️ WHAT MUST NOT BE LOST IN THE MOVE, and is not:
 *
 *   • THE ENTITLEMENT GATE. `tenantAllowsFeature` is imported and applied
 *     below — the same function, not a copy of its rules.
 *   • THE SKIP BEING SAID OUT LOUD. A workspace that is not entitled gets
 *     a ledger row saying so, with the reason the entitlement check gave.
 *   • ERROR ISOLATION. One workspace failing must not stop the others;
 *     that is now the tick's loop, which catches per unit.
 *   • `notReached`. The bound is applied by `listSchedulableTenants`,
 *     which selects `limit + 1` and reports the overflow as a number —
 *     the same "a silent cap is a lie" property, in one place instead of
 *     two.
 *
 * `app/api/workers/route.ts` still calls `runScheduledJob` for the
 * documented `{"mode":"scheduled"}` path, which is unchanged.
 */
async function executeUnit(
  entry: CatalogEntry,
  tenant: SchedulableTenant | null,
): Promise<UnitResult> {
  const job = entry.job;
  if (!job) throw new Error(`Job "${entry.id}" has no runnable job object.`);

  if (entry.scope === "platform") {
    if (!job.runPlatform) {
      throw new Error(`Job "${entry.id}" is platform-scoped and has no runPlatform.`);
    }
    return { detail: await job.runPlatform() };
  }

  if (!tenant) {
    throw new Error(`Job "${entry.id}" is per-tenant and was given no workspace.`);
  }
  if (!job.runForTenant) {
    throw new Error(`Job "${entry.id}" is per-tenant and has no runForTenant.`);
  }

  if (job.feature !== null) {
    const entitled = await tenantAllowsFeature({
      tenantId: tenant.id,
      feature: job.feature,
      /**
       * ⚠️ THE PLAN TIER THE TICK ALREADY READ. `tenantAllowsFeature`
       * takes it as `cachedPlanTier` for exactly this reason; passing it
       * is the difference between one workspace query per tick and one
       * per workspace per job.
       */
      cachedPlanTier: tenant.planTier as Parameters<
        typeof tenantAllowsFeature
      >[0]["cachedPlanTier"],
    });
    if (!entitled.allowed) return { skipped: entitled.reason, detail: {} };
  }

  return {
    detail: await job.runForTenant({ id: tenant.id, slug: tenant.slug, name: tenant.name }),
  };
}
