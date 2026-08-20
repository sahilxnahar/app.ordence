import "server-only";

/**
 * Ordence — WHAT EACH JOB IS ALLOWED TO DO, AND HOW LONG IT MAY BE SILENT
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE FROM THE REGISTRY
 * ══════════════════════════════════════════════════════════════════════
 * `server/scheduling/registry.ts` belongs to another stream this wave, so
 * these declarations cannot be added to the job objects where they would
 * most naturally live. That constraint turned out to be an improvement
 * and would be worth keeping even without it:
 *
 * ⭐ A SEPARATE TABLE CAN BE CHECKED FOR COMPLETENESS. `catalog.ts` throws
 * at module load if a registered job has no policy here, or if a policy
 * here names a job that does not exist. Fields on the job object cannot be
 * checked that way — a missing one is `undefined`, which reads as a
 * default, which is how "every job declares a budget" becomes "every job
 * except the one somebody added on a Friday".
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SILENCE WINDOW IS DERIVED, NEVER TYPED
 * ══════════════════════════════════════════════════════════════════════
 * `maxSilenceSeconds` — the dead man switch's window — is computed from
 * the job's own cron by `server/scheduler/cron.ts`. Two declarations of
 * one fact drift, and the day they drift the alarm is wrong in whichever
 * direction is least useful: too tight and it is muted, too loose and it
 * is decorative.
 *
 * It is the WORST gap between consecutive slots, doubled, plus fifteen
 * minutes. `rera_dunning_plan` (`0 3 * * 1-5`) is why it is the worst gap
 * and not the typical one: Friday to Monday is 72 hours, so a window built
 * from the Monday-to-Tuesday 24 hours would alarm every single weekend.
 *
 * An override is allowed and must carry `maxSilenceReason`. The type makes
 * that impossible to forget and `catalog.ts` re-checks it at run time,
 * because a type is a compile-time promise and this list is data an
 * operator may one day edit.
 */

import { nextSlotAfter, parseCron, worstGapSeconds } from "@/server/scheduler/cron";
import type { ParsedCron } from "@/server/scheduler/cron";

/**
 * `app`         — executed by the Next.js application over HTTP as the
 *                 application database role.
 * `maintenance` — executed by the cron service over a SEPARATE database
 *                 connection as `ordence_maintenance`, because the
 *                 function it calls is one the application role is
 *                 deliberately refused (0121, 0128, sealed-grants.json).
 *                 See SQL-FILES/0132 and docs/SCHEDULER.md.
 */
export type Lane = "app" | "maintenance";

/**
 * What happens when a slot arrives and the previous run of the same job is
 * still going.
 *
 * `skip`  — do not run. A ledger row is still written, with
 *           `state = 'skipped_overrun'`, because a silent skip is
 *           indistinguishable from a run that happened.
 * `queue` — claim the slot now, run it on a later tick once the previous
 *           run has finished. Nothing is lost and nothing overlaps.
 * `kill`  — ask the in-flight run to stop, then run this slot.
 *
 * 🔴 `kill` IS COOPERATIVE AND SAYING SO IS NOT A CAVEAT, IT IS THE
 * SPECIFICATION. An HTTP handler in another container cannot be
 * preempted from here. `kill` sets `cancel_requested` on the in-flight
 * ledger row; the runner checks that flag at every workspace boundary and
 * stops. So the previous run ends within one workspace's work, not
 * instantly, and a job that hangs INSIDE one workspace is not killed by
 * this at all — that case is `scheduler_reclaim_stale()` in 0131, which
 * ends the claim once the heartbeat dies.
 *
 * Shipping a `kill` that claimed to preempt and did nothing would be
 * instance twenty-four of this codebase's pattern.
 */
export type OverrunPolicy = "skip" | "queue" | "kill";

export type JobPolicy = {
  readonly jobId: string;
  readonly lane: Lane;
  readonly overrun: OverrunPolicy;

  /**
   * Wall-clock budget for one run, in milliseconds.
   *
   * ⚠️ ENFORCED AT EVERY BOUNDARY THE SCHEDULER OWNS, WHICH IS BETWEEN
   * WORKSPACES. A per-tenant job is checked after each workspace and stops
   * with `budget_exceeded`. A platform-scoped job is one opaque call, so
   * its budget can only be observed after it returns — the run is marked
   * `budget_exceeded` and the operator is alerted, and it is NOT stopped.
   * Making that real needs an AbortSignal parameter on the registry's job
   * functions, which is another stream's file this wave; it is written up
   * in PATCH-REQUEST-A.md.
   */
  readonly maxMs: number;

  /**
   * Row budget, or null when the job's own work is not row-shaped.
   * Compared against what the job reports, so a job that reports nothing
   * is unbounded and the calendar shows `rows: not reported` rather than
   * a reassuring zero.
   */
  readonly maxRows: number | null;

  /** Whether an operator may replay a missed slot for this job. */
  readonly backfillable: boolean;

  /** Present only when the derived silence window is overridden. */
  readonly maxSilenceOverrideSeconds?: number;
  readonly maxSilenceReason?: string;
};

/**
 * ⚠️ NOTHING HERE IS OPTIONAL AND NOTHING HERE HAS A DEFAULT. Every job in
 * the catalog must appear, and `catalog.ts` refuses to load otherwise.
 * A default would mean the job somebody forgot silently gets `skip`, a
 * five-minute budget and no backfill, which are choices nobody made.
 */
export const JOB_POLICIES: readonly JobPolicy[] = [
  /* ---- the eight already in server/scheduling/registry.ts ------------ */

  {
    jobId: "dunning_sweep",
    lane: "app",
    /**
     * 🔴 `skip`, AND THIS IS THE MOST CONSEQUENTIAL SINGLE VALUE IN THIS
     * FILE. Two overlapping dunning sweeps against one workspace race on
     * the ladder. The insert is ON CONFLICT DO NOTHING against
     * `credit_dunning_log_once_per_stage_key`, so the database refuses the
     * second row — but the two runs would then disagree about what they
     * queued, and the enqueue is driven by RETURNING. `queue` would be
     * equally safe and would delay a statutory ladder by a day for no
     * benefit; `kill` would abandon a partly-advanced ladder mid-workspace.
     */
    overrun: "skip",
    maxMs: 10 * 60_000,
    maxRows: null,
    backfillable: true,
  },
  {
    jobId: "mail_drain",
    lane: "app",
    /**
     * ⭐ `kill` IS WRONG AND `skip` IS WRONG HERE. The drain claims rows
     * with FOR UPDATE SKIP LOCKED, so two drains genuinely cannot send the
     * same message twice — overlap is safe by construction. But `skip` on
     * an hourly job whose previous run is slow means an hour of statutory
     * notices sit in the queue, and the reason to run it hourly rather
     * than nightly was exactly the retry latency. `queue` keeps every slot
     * and runs it as soon as the previous one is done.
     */
    overrun: "queue",
    maxMs: 5 * 60_000,
    maxRows: null,
    backfillable: false,
    /**
     * The outbox has no missed-slot concept: a message queued at 02:00 is
     * sent by the 03:05 run. Replaying 02:05 would send nothing and would
     * put a row in the ledger claiming a delivery window was covered when
     * a different run covered it.
     */
  },
  {
    jobId: "workflow_maintenance",
    lane: "app",
    overrun: "skip",
    maxMs: 10 * 60_000,
    maxRows: null,
    backfillable: false,
    /**
     * ⚠️ NOT BACKFILLABLE, AND THE REGISTRY ALREADY EXPLAINS WHY: the
     * dispatcher advances `next_run_at` FROM NOW rather than from the
     * missed slot, so a four-hour outage fires each workflow once on
     * recovery. Replaying the four missed slots would fire it four more
     * times, which is the exact behaviour that design avoids.
     */
  },
  {
    jobId: "rhythms",
    lane: "app",
    overrun: "skip",
    maxMs: 15 * 60_000,
    maxRows: null,
    backfillable: true,
  },
  {
    jobId: "storage_reconcile",
    lane: "app",
    overrun: "skip",
    maxMs: 15 * 60_000,
    maxRows: null,
    backfillable: true,
  },
  {
    jobId: "rera_dunning_plan",
    lane: "app",
    overrun: "skip",
    maxMs: 5 * 60_000,
    maxRows: null,
    backfillable: true,
  },
  {
    jobId: "rate_limit_sweep",
    lane: "app",
    overrun: "skip",
    maxMs: 2 * 60_000,
    maxRows: null,
    backfillable: false,
    /**
     * Deleting expired windows is a function of NOW, not of the slot. A
     * replay of 14:07 would delete exactly what the 15:07 run already
     * deleted, and record a ledger row implying the 14:07 window was
     * covered by its own run.
     */
  },
  {
    jobId: "anomaly_detection",
    lane: "app",
    overrun: "skip",
    maxMs: 5 * 60_000,
    maxRows: null,
    backfillable: false,
    /**
     * ⚠️ IT READS A ROLLING TWO-HOUR WINDOW FROM NOW. A replay of a slot
     * three days ago would scan the last two hours and record findings
     * against a slot they did not come from — evidence with the wrong
     * timestamp, which is worse than no evidence.
     */
  },

  /* ---- work that existed and had no schedule at all ------------------ */

  {
    jobId: "contract_expiry_scan",
    lane: "app",
    overrun: "skip",
    maxMs: 15 * 60_000,
    maxRows: null,
    backfillable: true,
  },
  {
    jobId: "automation_event_purge",
    lane: "app",
    overrun: "skip",
    maxMs: 10 * 60_000,
    maxRows: null,
    backfillable: false,
    /**
     * A retention purge deletes on a date predicate evaluated at run time.
     * The next run removes whatever a missed run would have.
     */
  },
  {
    jobId: "platform_impersonation_sweep",
    lane: "app",
    overrun: "skip",
    maxMs: 2 * 60_000,
    maxRows: null,
    backfillable: false,
  },
  {
    jobId: "rls_canary",
    lane: "app",
    /**
     * 🔴 `skip`, AND THE ARGUMENT IS NOT THE USUAL ONE. Two overlapping
     * canary runs would not corrupt anything — the probe writes nothing.
     * They would corrupt the SIGNAL: the probe reasons about what a
     * connection can see, and two of them interleaving their
     * `set_config` markers across four transactions each is exactly the
     * shape `server/platform/canary.ts` warns about in its own header
     * ("that would be a bug with a green tick on it"). A false P0 is how
     * a canary gets muted.
     */
    overrun: "skip",
    maxMs: 3 * 60_000,
    maxRows: null,
    backfillable: false,
    /**
     * It answers "is isolation enforced RIGHT NOW". Replaying an hour-old
     * slot would record this hour's answer against that hour, which is
     * evidence with the wrong timestamp on it.
     */
  },
  {
    jobId: "platform_health_sweep",
    lane: "app",
    overrun: "skip",
    maxMs: 5 * 60_000,
    maxRows: null,
    backfillable: false,
  },

  /* ---- the maintenance lane ------------------------------------------ */
  //
  // 🔴 NONE OF THESE FOUR CAN BE RUN BY THE APPLICATION, AND THAT IS NOT AN
  // OVERSIGHT TO BE FIXED WITH A GRANT. `prune_security_events` and
  // `prune_usage_counters` are sealed against `ordence_app` in
  // `scripts/sealed-grants.json`; 0121 repaired a regression that granted
  // one of them; 0128 withheld the third at creation. They run on a
  // separate connection as `ordence_maintenance`. See 0132 Section 6.

  {
    jobId: "prune_scheduler_runs",
    lane: "maintenance",
    overrun: "skip",
    maxMs: 10 * 60_000,
    maxRows: null,
    backfillable: false,
  },
  {
    jobId: "prune_change_log",
    lane: "maintenance",
    overrun: "skip",
    maxMs: 30 * 60_000,
    maxRows: null,
    backfillable: false,
  },
  {
    jobId: "prune_security_events",
    lane: "maintenance",
    overrun: "skip",
    maxMs: 30 * 60_000,
    maxRows: null,
    backfillable: false,
  },
  {
    jobId: "prune_usage_counters",
    lane: "maintenance",
    overrun: "skip",
    maxMs: 30 * 60_000,
    maxRows: null,
    backfillable: false,
  },
];

/* ------------------------------------------------------------------ */
/* THE DERIVED WINDOW                                                  */
/* ------------------------------------------------------------------ */

/** Grace on top of two cadences, for a tick that ran a little late. */
export const SILENCE_GRACE_SECONDS = 15 * 60;

/**
 * The floor, for a job whose cadence is so short that twice it is not a
 * useful window. An hourly job gets 2h15m; an every-fifteen-minutes job
 * would get 45
 * minutes, which is fine; a hypothetical every-minute job would get 17
 * minutes, which is also fine. The floor exists so a mis-parsed cadence
 * of zero cannot produce a window of fifteen minutes and page hourly.
 */
export const MIN_SILENCE_SECONDS = 30 * 60;

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GAP FOR A CRON TOO SPARSE TO ENUMERATE. A PRODUCTION BUILD
 *    FAILURE, AND THE FIX IS NOT THE ONE THE ERROR MESSAGE SUGGESTS.
 * ══════════════════════════════════════════════════════════════════════
 * `worstGapSeconds` enumerates every minute in a 32-day probe. A MONTHLY
 * cron has at most ONE slot in such a window unless it happens to
 * straddle two month boundaries , from 20 August the next two runs of
 * `0 3 1 * *` are 1 September and 1 October, and 1 October is 42 days
 * out. One slot returns `null`, and `null` made `deriveMaxSilenceSeconds`
 * throw.
 *
 * ⚠️ IT THREW AT MODULE LOAD, so this was never a scheduler failure. It
 * was a BUILD failure: `next build` collects page data for `/api/workers`,
 * which imports this module, and the deploy died with
 *   Job "prune_change_log" has cron "0 3 1 * *", which produces fewer
 *   than two slots in the next 32 days
 *
 * 🔴 AND IT WAS NOT ONE JOB. THREE of the four maintenance jobs are
 *    monthly: `prune_change_log`, `prune_security_events` and
 *    `prune_usage_counters`. The build stops at the first, so fixing only
 *    the job the log names produces three more failed deploys, one per
 *    attempt. Measured, not assumed.
 *
 * ⚠️ WHY NOT SIMPLY WIDEN THE PROBE. Tried first, and refused , by design.
 * `slotsBetween` throws above 40 days, and its message argues the case:
 * "a backfill that silently starts 40 days ago is a backfill that
 * silently skips everything before that." That limit is correct and it is
 * load-bearing for backfills. A monthly cron needs up to 62 days. The two
 * cannot be reconciled by moving the number.
 *
 * ⚠️ WHY NOT THREE `maxSilenceOverrideSeconds` ENTRIES. That is what the
 * error message recommends, and for a genuinely exotic cadence it is
 * right. Monthly is not exotic , it is the most common retention cadence
 * in this product. Three hand-written overrides would also reintroduce
 * precisely what `cadenceSeconds` exists to prevent: a window typed in by
 * hand next to a cron string, which is two declarations of one fact, and
 * the day they disagree is the day the alarm is wrong.
 *
 * ⭐ SO: HOP INSTEAD OF SCANNING. `nextSlotAfter` finds the next slot
 * without enumerating a range, and each hop of a monthly cron is at most
 * 31 days, comfortably inside the same 40-day bound. Chaining hops gives
 * the real gaps without ever asking for a window the scanner refuses.
 *
 * ⚠️ AND IT TAKES THE WORST OF SEVERAL HOPS, NOT THE FIRST. The first gap
 * of a monthly cron is 28, 29, 30 or 31 days depending on when it is
 * asked. Deriving the alarm from a February hop would leave the window
 * three days short of a real July-to-August silence, and a watchdog that
 * is short fires on a healthy system , which is how an alarm gets muted,
 * which removes the alarm for the case it exists for.
 *
 * ⚠️ THIS IS A FALLBACK, NOT A REPLACEMENT. It runs only when the
 * enumerating probe found fewer than two slots. Every job already in the
 * catalogue that the probe can see keeps the value it had , verified:
 * `prune_scheduler_runs` (`40 2 * * 0`) reads 168.0h before and after.
 */
const SPARSE_HOPS = 14;

function sparseWorstGapSeconds(parsed: ParsedCron, from: Date): number | null {
  let cursor = nextSlotAfter(parsed, from);
  if (!cursor) return null;

  let worst = 0;
  for (let hop = 0; hop < SPARSE_HOPS; hop += 1) {
    const next = nextSlotAfter(parsed, cursor);
    /* A cron with one slot and then nothing reachable is genuinely
     * underivable. Returning null here is what keeps the override path
     * meaningful for a quarterly or annual job. */
    if (!next) break;
    worst = Math.max(worst, next.getTime() - cursor.getTime());
    cursor = next;
  }

  return worst === 0 ? null : Math.round(worst / 1000);
}

/**
 * Two full cadences plus grace, measured from the job's own cron.
 *
 * ⚠️ TWO, NOT ONE. One cadence means any single missed slot pages. A
 * scheduled job legitimately misses a slot — a deploy, a slow tick, a
 * Railway restart — and an alarm that fires on every one of those is an
 * alarm that gets muted, which removes the alarm for the case it exists
 * for. Two consecutive misses is a pattern, not an event.
 */
export function deriveMaxSilenceSeconds(
  cronUtc: string,
  policy: Pick<JobPolicy, "maxSilenceOverrideSeconds" | "maxSilenceReason" | "jobId">,
  from = new Date(),
): number {
  if (policy.maxSilenceOverrideSeconds !== undefined) {
    if (!policy.maxSilenceReason || policy.maxSilenceReason.trim().length < 20) {
      throw new Error(
        `Job "${policy.jobId}" overrides its watchdog window to ` +
          `${policy.maxSilenceOverrideSeconds}s without a written reason. The window is ` +
          `derived from the cron for a reason; overriding it silently is how an alarm ` +
          `ends up wider than the outage it is supposed to catch.`,
      );
    }
    return policy.maxSilenceOverrideSeconds;
  }

  const parsed = parseCron(cronUtc);
  const worst = worstGapSeconds(parsed, from) ?? sparseWorstGapSeconds(parsed, from);

  if (worst === null) {
    throw new Error(
      `Job "${policy.jobId}" has cron "${cronUtc}", which produces fewer than two slots in ` +
        `any window this function can scan. A watchdog window cannot be derived from it. Either the ` +
        `expression is wrong, or the job runs so rarely that it needs an explicit ` +
        `maxSilenceOverrideSeconds with a written reason.`,
    );
  }

  return Math.max(MIN_SILENCE_SECONDS, worst * 2 + SILENCE_GRACE_SECONDS);
}

export function findJobPolicy(jobId: string): JobPolicy | undefined {
  return JOB_POLICIES.find((p) => p.jobId === jobId);
}
