import "server-only";

/**
 * Ordence — ⭐⭐⭐ ONE ENUMERABLE CATALOG OF EVERYTHING THAT SHOULD RUN ON A
 *              CLOCK, INCLUDING THE THINGS THAT DO NOT
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PREMISE OF THIS TRACK'S BRIEF WAS "NOTHING RUNS ON A SCHEDULE",
 *    AND THE FIRST HALF OF THAT IS WRONG IN A WAY THAT MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * There is no scheduler — that part is true and verified: `railway.json`
 * has no `cronSchedule`, `.github/workflows/` has no `schedule:`, and
 * `wrangler.jsonc` has no `triggers.crons`. Nothing calls anything on a
 * clock.
 *
 * But the JOBS exist, and there are TWO registries of them, which nothing
 * in the repository relates to each other:
 *
 *   server/scheduling/registry.ts    SCHEDULED_JOBS      8 jobs
 *     → app/api/workers  {"mode":"scheduled","jobId":…}
 *     → generates docs/current/CRON-RUNBOOK.md
 *     → entitlement-gated, cadence declared, consequence declared
 *
 *   server/ai/background-workers.ts  BACKGROUND_WORKERS  6 workers
 *     → app/api/workers/ai-monitors  {"mode":"sweep"}
 *     → in NO document; grep `ai-monitors` in CRON-RUNBOOK.md finds nothing
 *     → NO entitlement gate at all
 *     → its own separate 100-workspace cap
 *
 * Two lists, two routes, two caps, one of them invisible. Building a
 * control plane over one of them and not the other would have made the
 * invisible one permanently invisible: the calendar would show eight jobs,
 * the watchdog would watch eight jobs, and six more would go on not
 * running with a page in front of an operator implying full coverage.
 *
 * ⭐ SO THE ASSERTION AT THE BOTTOM OF THIS FILE IS THE POINT OF THE FILE.
 * Every id in BOTH upstream registries must appear either in this catalog
 * or in `DORMANT_NOT_SCHEDULED` with a written reason and a named owner.
 * A seventh registry job or a seventh AI worker added by another stream
 * makes this module THROW ON IMPORT, which takes `/api/workers` and the
 * jobs calendar down loudly, rather than dropping one row from a list
 * nobody counts.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE NEW JOBS BELOW ARE `ScheduledJob` OBJECTS ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * They satisfy the registry's own exported type and are executed by the
 * registry's own `runScheduledJob`. That is not politeness about file
 * ownership: it means entitlement gating, the `notReached` count, the
 * platform-scope workspace listing and per-workspace error isolation are
 * the SAME code for new jobs as for old ones. A second executor would be
 * a second place for the `withPlatformScope` rule to be forgotten.
 */

import { sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import {
  SCHEDULED_JOBS,
  type ScheduledJob,
} from "@/server/scheduling/registry";
import { BACKGROUND_WORKERS } from "@/server/ai/background-workers";
import { enqueueJob } from "@/lib/queue/jobs";
import { purgeExpiredEvents } from "@/server/automation/drain";
import { sweepExpiredImpersonations } from "@/server/platform/impersonation";
import { sweepTenantHealth } from "@/server/platform/health-sweep";
import { runCanaryProbe } from "@/server/platform/canary";
import { todayInIndia } from "@/lib/accounting/periods";
import {
  JOB_POLICIES,
  deriveMaxSilenceSeconds,
  findJobPolicy,
  type JobPolicy,
  type Lane,
} from "@/server/scheduler/policy";
import { parseCron } from "@/server/scheduler/cron";

/** How far ahead the contract expiry scan looks. Matches the value the
 *  `{"mode":"cron"}` sweep in app/api/workers/route.ts has always used. */
const EXPIRY_LOOKAHEAD_DAYS = 30;

/* ================================================================== */
/* ① WORK THAT EXISTED AND HAD NO SCHEDULE                             */
/* ================================================================== */

export const EXTRA_SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    id: "contract_expiry_scan",
    scope: "per-tenant",
    label: "Warn about contracts about to expire",
    feature: "clm.contracts",
    consequenceWhenStopped:
      "Nobody is told that a contract is about to expire. The scan, the processor and the queue kind all exist and are tested; the only thing that ever enqueued one was the {\"mode\":\"cron\"} branch of /api/workers, which no clock has ever called. A contract that lapses because the renewal window passed unnoticed is not recoverable by running the scan later.",
    cronUtc: "0 21 * * *",
    cadenceInIst: "02:30 IST every day",
    idempotency:
      "It enqueues one contract_expiry_scan job per workspace with a correlation id. The processor reads contracts and raises notifications; running it twice in a day produces the same set of warnings about the same contracts, and the notification layer coalesces on its own key. Nothing is written that a second pass would duplicate.",
    runForTenant: async (tenant) => {
      const enqueued = await enqueueJob({
        kind: "contract_expiry_scan",
        tenantId: tenant.id,
        correlationId: `scheduler:contract_expiry_scan`,
        lookaheadDays: EXPIRY_LOOKAHEAD_DAYS,
      });

      /**
       * 🔴 A REFUSED ENQUEUE MUST FAIL THE WORKSPACE, NOT BE REPORTED AS A
       * FIELD. `enqueueJob` returns `{queued:false, reason}` when no queue
       * is bound and inline fallback is off — it does not throw. Returning
       * that as a detail would make the run green while nothing happened,
       * which is precisely how this job came to have no caller in the
       * first place.
       */
      if (!enqueued.queued) {
        throw new Error(
          `contract_expiry_scan was not enqueued for ${tenant.slug}: ` +
            `${enqueued.error ?? enqueued.reason}. Nothing scanned this workspace.`,
        );
      }

      return { via: enqueued.via, jobId: enqueued.jobId, lookaheadDays: EXPIRY_LOOKAHEAD_DAYS };
    },
  },

  {
    id: "automation_event_purge",
    scope: "per-tenant",
    label: "Delete automation events past their retention date",
    /**
     * ══════════════════════════════════════════════════════════════════
     * 🔴 DELIBERATELY UNGATED, AND THE ARGUMENT IS THE SAME ONE
     *    `mail_drain` MAKES
     * ══════════════════════════════════════════════════════════════════
     * `server/automation/emit.ts` stamps every event with a 90-day
     * `purge_after`. `purgeExpiredEvents` is the deleter, and its only
     * caller is a BUTTON on /automations/queue. So retention on this table
     * happens when a human clicks, which is to say never.
     *
     * Gating the deletion on the plan would mean a workspace whose
     * subscription lapses keeps its automation events forever — we would
     * be retaining a former customer's data because they stopped paying,
     * which is a data-protection problem rather than a commercial lever.
     */
    feature: null,
    ungatedBecause:
      "This deletes data whose retention period the product already promised. Refusing to run it for an unentitled workspace would not withhold a capability, it would retain a former customer's event history indefinitely because they stopped paying.",
    consequenceWhenStopped:
      "automation_events grows without bound and the 90-day purge_after column means nothing. Every automation firing writes a row; the column that says when it should be deleted has existed since the table did and nothing has ever read it except a button on /automations/queue.",
    cronUtc: "20 22 * * *",
    cadenceInIst: "03:50 IST every day",
    idempotency:
      "It is a DELETE on a date predicate evaluated at run time, restricted to rows already processed. A second run in the same day removes nothing, because the first one already removed everything matching.",
    runForTenant: async (tenant) => {
      const removed = await purgeExpiredEvents({
        tenantId: tenant.id,
        today: todayInIndia(),
      });
      return { removed };
    },
  },

  {
    id: "platform_impersonation_sweep",
    scope: "platform",
    label: "Close impersonation sessions that have expired",
    feature: null,
    consequenceWhenStopped:
      "Expired impersonation sessions stay open in platform_impersonation_sessions. The sessions themselves stopped working at the thirty-minute cap, so this is not a live access hole — but the console's list of open impersonations grows monotonically and stops being readable, which is the list somebody scans during an incident to answer 'is anyone inside a customer's workspace right now'.",
    cronUtc: "*/20 * * * *",
    cadenceInIst: "every twenty minutes",
    idempotency:
      "It is an UPDATE whose predicate is 'ended_at IS NULL AND the capped expiry has passed'. The rows it touches no longer match after it touches them, so a second pass updates nothing.",
    runPlatform: async () => {
      /**
       * ⚠️ THIS FUNCTION HAD NO SCHEDULED CALLER AND ITS ONE REAL CALLER IS
       * A PIGGYBACK. `server/platform/action-log.ts` dynamic-imports it and
       * fires it opportunistically when somebody opens the action log — its
       * own comment says "`sweepExpiredImpersonations()` HAD NO CALLER".
       * Opening a screen is not a schedule. That call is left alone; this
       * one makes it a schedule.
       */
      const closed = await sweepExpiredImpersonations();
      return { closed };
    },
  },

  {
    id: "platform_health_sweep",
    scope: "platform",
    label: "Open and close tenant health events",
    feature: null,
    consequenceWhenStopped:
      "Tenant health events are only computed when an operator opens /platform/health or clicks the sweep. A workspace that went quiet, ran out of seats or stopped filing is therefore noticed exactly when somebody happens to look — which, on the day the platform is having a bad time, is the day nobody is looking at that screen.",
    cronUtc: "10 * * * *",
    cadenceInIst: "ten minutes past every hour",
    idempotency:
      "It reads one aggregate query across workspaces and reconciles it against what is already open: an event already open is left alone, an event whose condition has cleared is auto-closed. Running it a hundred times converges on the same set of open events.",
    runPlatform: async () => {
      const result = await sweepTenantHealth(new Date());
      return {
        tenantsExamined: result.tenantsExamined,
        opened: result.opened,
        alreadyOpen: result.alreadyOpen,
        autoClosed: result.autoClosed,
      };
    },
  },

  {
    id: "rls_canary",
    scope: "platform",
    label: "Prove tenant isolation is still enforced by the database",
    feature: null,
    consequenceWhenStopped:
      "Nothing checks that row-level security still holds. RLS is the ONLY tenant isolation in this product — there is no application-level tenant filter to fall back on — and the probe that attempts a real cross-tenant read and proves it returns nothing runs only when somebody curls /api/cron/canary by hand. Nobody has. A policy dropped by a migration, a role that gained BYPASSRLS, or a drizzle-kit push against the wrong database would be silent until a customer saw another customer's ledger.",
    cronUtc: "0 * * * *",
    cadenceInIst: "every hour, on the hour",
    idempotency:
      "It is read-only. Four separate transactions attempt a cross-tenant read against a synthetic workspace and report what came back; it writes no row anywhere, so a hundred runs produce a hundred identical verdicts and change nothing.",
    runPlatform: async () => {
      /**
       * ⭐ CALLED DIRECTLY, NOT OVER HTTP. `app/api/cron/canary` needs
       * `CRON_SECRET` because it is reachable from the internet and its
       * response names real workspace ids. Inside the application there
       * is no perimeter to cross: `runCanaryProbe()` is exported, takes
       * no arguments, holds no permission, and opens its own scoped
       * transactions. Going out through HTTP would mean the scheduler
       * held a second secret for a call to itself, and
       * `docs/current/CRON-RUNBOOK.md` is right that two secrets for one
       * job is how something authenticates against the wrong one at 3am.
       */
      const result = await runCanaryProbe();

      /**
       * 🔴 ONLY `pass` IS GREEN, AND `inconclusive` IS THE ONE THAT LOOKS
       * HARMLESS AND IS NOT.
       *
       * `docs/current/CRON-RUNBOOK.md` is emphatic about this and it is
       * worth repeating where the decision is actually made: a 503 from
       * this probe is what you get when the database role BYPASSES
       * row-level security, so the probe could not put itself in a
       * position to prove anything. "A green tick from a connection that
       * bypasses row-level security is the worst outcome available here.
       * It is believed, and it is evidence of nothing."
       *
       * So an inconclusive verdict FAILS the run, the ledger records it,
       * and GET /api/workers?watchdog=1 goes red — because a probe that
       * cannot prove isolation is indistinguishable, to everything
       * downstream, from one that has not run.
       */
      if (result.verdict !== "pass") {
        throw new Error(
          `Tenant isolation canary returned "${result.verdict}": ${result.headline} ` +
            `(${result.provenTargets} target(s) proved, ${result.inconclusiveTargets} inconclusive)`,
        );
      }

      return {
        verdict: result.verdict,
        headline: result.headline,
        provenTargets: result.provenTargets,
        inconclusiveTargets: result.inconclusiveTargets,
        tookMs: result.tookMs,
      };
    },
  },
];

/** Everything the application itself can run, old and new, one list. */
export const APP_LANE_JOBS: readonly ScheduledJob[] = [
  ...SCHEDULED_JOBS,
  ...EXTRA_SCHEDULED_JOBS,
];

/* ================================================================== */
/* ② THE MAINTENANCE LANE                                              */
/* ================================================================== */

/**
 * 🔴 THESE CANNOT RUN ON `/api/workers` AND A GRANT WOULD NOT BE A FIX.
 *
 * The brief for this track names `prune_change_log`,
 * `prune_security_events` and `prune_usage_counters` as retention that is
 * "written, documented, argued for in comments, and never runs". All three
 * are true. The fourth fact is the one that decides the design:
 *
 *   SQL-FILES/0012  declared, in a comment inside its own grant block:
 *                   "Explicitly NOT granted: EXECUTE on
 *                    prune_security_events(). The web application must not
 *                    be able to delete security history."
 *   SQL-FILES/0087  granted it anyway, 75 files later, by copying a
 *                   signature without reading the role.
 *   SQL-FILES/0121  revoked it again and sealed it.
 *   SQL-FILES/0128  withheld prune_change_log() at creation for the same
 *                   reason, and says outright: "⭐ AND WHEN THE SCHEDULER
 *                   EXISTS, this belongs beside prune_security_events()".
 *   scripts/sealed-grants.json + `npm run check:sealed-grants` fail the
 *                   build on any .sql file that grants them back.
 *
 * `/api/workers` executes as the application role. Registering these there
 * has two possible outcomes: permission denied on every run, or a fourth
 * reversal of a control that has already been reversed once and repaired
 * once. So they run on a second connection as `ordence_maintenance`,
 * driven by `server/scheduler/maintenance.mjs` from the cron service, and
 * they claim their slots in the SAME ledger so the calendar shows one list.
 */
export type MaintenanceJob = {
  readonly id: string;
  readonly label: string;
  readonly cronUtc: string;
  readonly cadenceInIst: string;
  readonly consequenceWhenStopped: string;
  readonly idempotency: string;
  /** Executed as-is by the maintenance connection. Never interpolated. */
  readonly sqlCall: string;
  /** The read-only form an operator runs first. */
  readonly sqlDryRun: string;
};

export const MAINTENANCE_JOBS: readonly MaintenanceJob[] = [
  {
    id: "prune_scheduler_runs",
    label: "Bound the scheduler's own run ledger",
    cronUtc: "40 2 * * 0",
    cadenceInIst: "08:10 IST on Sunday morning",
    consequenceWhenStopped:
      "scheduler_runs grows by roughly (active workspaces x per-tenant jobs) rows a day, forever. This track would then have built, in its first file, exactly the unbounded table it was written to stop existing.",
    idempotency:
      "It deletes finished rows older than 90 days. A second run the same day deletes nothing, because the first one already removed everything matching. It never deletes an unfinished run, whatever its age.",
    sqlCall: "SELECT * FROM public.prune_scheduler_runs(90, false)",
    sqlDryRun: "SELECT * FROM public.prune_scheduler_runs(90, true)",
  },
  {
    id: "prune_change_log",
    label: "Bound the change_log window (180 days)",
    cronUtc: "0 3 1 * *",
    cadenceInIst: "08:30 IST on the 1st of each month",
    consequenceWhenStopped:
      "change_log grows forever. 0017 attaches a change-log trigger to every tenant table and 0122 swept the coverage across 303 of them, so this is the highest-volume table in the product. 0128 wrote the retention, documented it, argued for the 30-day floor, and said plainly that no scheduler exists to run it.",
    idempotency:
      "It deletes rows older than the cutoff, per workspace, inside each workspace's own RLS context. A second run in the same month deletes nothing.",
    sqlCall: "SELECT * FROM public.prune_change_log(180, false)",
    sqlDryRun: "SELECT * FROM public.prune_change_log(180, true)",
  },
  {
    id: "prune_security_events",
    label: "Bound the security_events window (365 days)",
    cronUtc: "30 3 1 * *",
    cadenceInIst: "09:00 IST on the 1st of each month",
    consequenceWhenStopped:
      "security_events grows forever. It is append-only by trigger and this SECURITY DEFINER function is the only sanctioned way past that trigger, which is exactly why the application may not call it.",
    idempotency:
      "It deletes events older than the cutoff and refuses a window under 30 days. A second run the same month deletes nothing.",
    sqlCall: "SELECT * FROM public.prune_security_events(365, false)",
    sqlDryRun: "SELECT * FROM public.prune_security_events(365, true)",
  },
  {
    id: "prune_usage_counters",
    label: "Bound the metering counter window (25 months)",
    cronUtc: "0 4 1 * *",
    cadenceInIst: "09:30 IST on the 1st of each month",
    consequenceWhenStopped:
      "usage_counters grows forever, one row per metric per period per workspace. These are the counters every invoice is computed from, which is both why retention is 25 months rather than 90 days and why the tenant-facing tier must not be able to delete them.",
    idempotency:
      "It removes closed buckets older than the interval. A second run the same month removes nothing.",
    sqlCall: "SELECT public.prune_usage_counters('25 months')",
    sqlDryRun: "SELECT count(*) AS would_remove FROM usage_counters WHERE period_end < now() - interval '25 months'",
  },
];

/* ================================================================== */
/* ③ WHAT IS DORMANT AND IS DELIBERATELY NOT BEING SCHEDULED           */
/* ================================================================== */

/**
 * 🔴 THIS LIST BEING SHORT WOULD BE THE SUSPICIOUS OUTCOME, NOT THE GOOD
 * ONE. "Every existing dormant job is either scheduled or listed with a
 * reason why not" is a definition-of-done that a track can satisfy by
 * scheduling everything it can reach and never looking for the rest.
 *
 * Each entry names the file, the reason, and WHO can act on it, because a
 * finding with no owner is a finding that stays in a report.
 */
export type NotScheduled = {
  readonly id: string;
  readonly where: string;
  readonly reason: string;
  readonly owner: string;
};

export const DORMANT_NOT_SCHEDULED: readonly NotScheduled[] = [
  {
    id: "ai_background_workers",
    where: "server/ai/background-workers.ts BACKGROUND_WORKERS (6 workers), app/api/workers/ai-monitors",
    reason:
      "All six are per-tenant and NONE is entitlement-gated: runAllWorkers loops every active workspace and calls every worker, with no equivalent of the registry's tenantAllowsFeature check. Putting them on a clock would deliver GST deadline watching, receivables ageing, reconciliation drift, inventory reorder, compliance-gap and site-labour anomaly detection nightly to workspaces that have not paid for them — which is the eleventh instance of the exact pattern server/scheduling/registry.ts names in its own header. The fix is a `feature` (and, where genuinely ungated, an `ungatedBecause`) on each BackgroundWorker; the file belongs to another stream this wave. Until then the catalog carries them here, the jobs calendar shows them as UNSCHEDULED with this reason, and nothing pretends they are covered.",
    owner: "Track C or E — server/ai/background-workers.ts",
  },
  {
    id: "gstr2b_reconciliation",
    where: "server/actions/gstr2b.ts runGstr2bReconciliation",
    reason:
      "It exists only as a permission-gated server action: it calls guardGstr2bWrite({permission:'gstr2b:reconcile'}) and therefore requires a human session. A cron holds no permission at all, so scheduling it would mean either inventing a service account — which server/scheduling/registry.ts argues against at length, and correctly — or removing the permission check. The shape that works already exists twice in this repo: split a sweepGstr2bForTenant() out of the action, as sweepDunningForTenant and recomputeRhythmsForTenant were split, and register that. That is a change inside the job, which this track is told not to make.",
    owner: "Track C or E — server/actions/gstr2b.ts",
  },
  {
    id: "compliance_licence_reminders",
    where: "server/actions/compliance.ts, components/compliance/*",
    reason:
      "There is no implementation to schedule. renewalLeadDays, isRenewalDue and daysUntilExpiry are computed at read time for the licences screen only; nothing writes a reminder, queues an email or raises a task on a licence approaching expiry. The nearest thing that exists is the compliance_gap AI worker, which only reports. Scheduling nothing would produce a green tick on a job that does nothing, which is worse than the current honest silence.",
    owner: "Track C or E — new work, not a scheduling gap",
  },
  {
    id: "usage_counter_rollups",
    where: "server/metering/**, lib/metering/period.ts",
    reason:
      "No rollup exists. usage_counters is period-bucketed and written incrementally, and lib/metering/period.ts resolveMeteringPeriod derives the bucket lazily at read time — there is no period-close or aggregation step to put on a clock. db/schema/telemetry.ts says so directly: 'if this stops being fast enough, the answer is a real rollup TABLE written by the retention sweep'. The metering functions that DO exist and have zero callers are storageDrift and reconcilableApiCalls in server/metering/derive.ts, which are drift detectors with nowhere to send a finding; scheduling them would compute a number and discard it.",
    owner: "Track C or E — new work",
  },
  {
    id: "sendDunningNotice",
    where: "server/actions/receivables.ts",
    reason:
      "Deliberately not scheduled, and the argument in docs/current/CRON-RUNBOOK.md is right: the permission depends on the rung, and a cancellation warning needs a key the accountant who does every other collections task does not hold, because that letter precedes terminating an allotment and forfeiting what a family has paid towards a home. A cron holds no permission, so putting it on a clock would not be running it as somebody with the right — it would be removing the right from the design. The rera_dunning_plan job already reports which notices have come due.",
    owner: "nobody — this one is correct as it stands",
  },
  {
    id: "retention_ttls_with_no_deleter",
    where: "server/automation/agent-dispatch.ts RUN_RETENTION_DAYS, server/integrations/ingest.ts INTAKE_FAILURE_RETENTION_DAYS, lib/integrations/verify.ts DEFAULT_DELIVERY_RETENTION_DAYS / FAILED_DELIVERY_RETENTION_DAYS",
    reason:
      "Four more retention windows are declared, stamped onto rows as purge_after, and have no deleter function anywhere — unlike automation_events, which has purgeExpiredEvents and is now scheduled as automation_event_purge. There is nothing to schedule: the deleters have to be written first, and writing them is a change to those modules. This is the same defect as prune_change_log had before 0128, in four more places.",
    owner: "Track C or E — server/automation/**, server/integrations/**",
  },
];

/* ================================================================== */
/* ④ THE CATALOG                                                       */
/* ================================================================== */

export type CatalogEntry = {
  readonly id: string;
  readonly label: string;
  readonly lane: Lane;
  readonly scope: "per-tenant" | "platform";
  readonly cronUtc: string;
  readonly cadenceInIst: string;
  readonly feature: string | null;
  readonly consequenceWhenStopped: string;
  readonly idempotency: string;
  readonly policy: JobPolicy;
  readonly maxSilenceSeconds: number;
  /** Present for the `app` lane only. */
  readonly job?: ScheduledJob;
  /** Present for the `maintenance` lane only. */
  readonly maintenance?: MaintenanceJob;
};

function buildCatalog(): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = [];

  for (const job of APP_LANE_JOBS) {
    const policy = findJobPolicy(job.id);
    if (!policy) {
      throw new Error(
        `Scheduler catalog: job "${job.id}" is registered but has no entry in ` +
          `server/scheduler/policy.ts. Every job must declare its overrun policy and ` +
          `budget explicitly; a default here would silently give the job somebody just ` +
          `added a set of choices nobody made.`,
      );
    }
    entries.push({
      id: job.id,
      label: job.label,
      lane: policy.lane,
      scope: job.scope,
      cronUtc: job.cronUtc,
      cadenceInIst: job.cadenceInIst,
      feature: job.feature,
      consequenceWhenStopped: job.consequenceWhenStopped,
      idempotency: job.idempotency,
      policy,
      maxSilenceSeconds: deriveMaxSilenceSeconds(job.cronUtc, policy),
      job,
    });
  }

  for (const m of MAINTENANCE_JOBS) {
    const policy = findJobPolicy(m.id);
    if (!policy) {
      throw new Error(
        `Scheduler catalog: maintenance job "${m.id}" has no entry in ` +
          `server/scheduler/policy.ts.`,
      );
    }
    entries.push({
      id: m.id,
      label: m.label,
      lane: "maintenance",
      scope: "platform",
      cronUtc: m.cronUtc,
      cadenceInIst: m.cadenceInIst,
      feature: null,
      consequenceWhenStopped: m.consequenceWhenStopped,
      idempotency: m.idempotency,
      policy,
      maxSilenceSeconds: deriveMaxSilenceSeconds(m.cronUtc, policy),
      maintenance: m,
    });
  }

  return entries;
}

/* ------------------------------------------------------------------ */
/* ⑤ THE ASSERTIONS. THESE RUN ON IMPORT AND THROW.                    */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THROWING ON IMPORT IS THE DESIGN, NOT AN ACCIDENT OF WHERE THE CODE
 * SITS. This repository cannot be given a new test file by this track —
 * `tests/**` is not in its ownership block — so the enforcement has to
 * live somewhere that runs in production. Module-load assertions do:
 * `/api/workers` and the jobs calendar both import this file, so a
 * violation takes the scheduler down at deploy with a message naming the
 * fault, rather than dropping one row from a list nobody counts.
 *
 * ⚠️ AND THAT IS A REAL TRADE, MADE DELIBERATELY. A throw here means a
 * malformed cron string in policy.ts stops background work entirely. The
 * alternative is a scheduler that runs with an unparseable job silently
 * absent, which is the failure this whole wave exists to remove. Loud and
 * stopped beats quiet and partial. It is written up in TRACK-REPORT.md
 * section 5.
 */
function assertCatalogIsComplete(entries: readonly CatalogEntry[]): void {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const e of entries) {
    if (ids.has(e.id)) {
      problems.push(
        `duplicate job id "${e.id}" — the ledger keys on it, so two jobs sharing one id ` +
          `would claim each other's slots`,
      );
    }
    ids.add(e.id);

    try {
      parseCron(e.cronUtc);
    } catch (err) {
      problems.push(
        `job "${e.id}" has cron "${e.cronUtc}" which does not parse: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    /**
     * ⚠️ THE REGISTRY'S OWN RULE, RE-APPLIED TO THE JOBS THIS TRACK ADDED.
     * server/scheduling/registry.ts requires a per-tenant job with a null
     * feature to fill in `ungatedBecause`, and its test suite enforces that
     * for the eight jobs in that file. Nothing enforced it for a job
     * declared anywhere else, so this does.
     */
    if (e.job && e.scope === "per-tenant" && e.feature === null && !e.job.ungatedBecause) {
      problems.push(
        `job "${e.id}" is per-tenant with feature: null and no ungatedBecause. That is a ` +
          `paid capability being delivered on a schedule to a workspace that may not be ` +
          `paying for it.`,
      );
    }

    if (e.lane === "app" && !e.job) {
      problems.push(`job "${e.id}" is in the app lane with no runnable job object`);
    }
    if (e.lane === "maintenance" && !e.maintenance) {
      problems.push(`job "${e.id}" is in the maintenance lane with no SQL to run`);
    }
  }

  for (const policy of JOB_POLICIES) {
    if (!ids.has(policy.jobId)) {
      problems.push(
        `server/scheduler/policy.ts declares a policy for "${policy.jobId}", which is in ` +
          `no registry. Either the job was removed and the policy was left behind, or the ` +
          `id is a typo and the real job is running on defaults nobody chose.`,
      );
    }
  }

  /**
   * ⭐⭐ THE CHECK THIS FILE EXISTS FOR. Both upstream registries, in full,
   * either scheduled or explicitly declined.
   */
  const declined = new Set(DORMANT_NOT_SCHEDULED.map((d) => d.id));

  for (const job of SCHEDULED_JOBS) {
    if (!ids.has(job.id) && !declined.has(job.id)) {
      problems.push(
        `server/scheduling/registry.ts registers "${job.id}" and this catalog neither ` +
          `schedules it nor declines it in DORMANT_NOT_SCHEDULED. It would be invisible ` +
          `on the jobs calendar and invisible to the watchdog — which is worse than it ` +
          `was before, because the calendar would imply full coverage.`,
      );
    }
  }

  /**
   * ⚠️ THE SIX AI WORKERS ARE COVERED AS A GROUP, UNDER ONE ID, BECAUSE
   * THAT IS HOW THEY ARE OPERATED — `runAllWorkers` runs all six for a
   * workspace and the route has no per-worker schedule. If a later change
   * gives them individual schedules, this loop stops matching and says so.
   */
  const aiCovered = ids.has("ai_background_workers") || declined.has("ai_background_workers");
  if (!aiCovered) {
    problems.push(
      `server/ai/background-workers.ts declares ${BACKGROUND_WORKERS.length} background ` +
        `workers reachable at /api/workers/ai-monitors, and this catalog neither schedules ` +
        `them nor declines them. They are in no document and no registry that anything ` +
        `enumerates.`,
    );
  }

  for (const d of DORMANT_NOT_SCHEDULED) {
    if (d.reason.trim().length < 120) {
      problems.push(
        `DORMANT_NOT_SCHEDULED entry "${d.id}" has a reason under 120 characters. ` +
          `"not needed" and "out of scope" are how a decline list becomes a list of things ` +
          `nobody can re-open.`,
      );
    }
    if (d.owner.trim().length === 0) {
      problems.push(`DORMANT_NOT_SCHEDULED entry "${d.id}" names no owner`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Scheduler catalog is incoherent — ${problems.length} problem(s):\n  - ` +
        problems.join("\n  - "),
    );
  }
}

export const SCHEDULER_CATALOG: readonly CatalogEntry[] = buildCatalog();

assertCatalogIsComplete(SCHEDULER_CATALOG);

export const SCHEDULER_CATALOG_IDS: readonly string[] = SCHEDULER_CATALOG.map((e) => e.id);

export function findCatalogEntry(jobId: string): CatalogEntry | undefined {
  return SCHEDULER_CATALOG.find((e) => e.id === jobId);
}

/* ------------------------------------------------------------------ */
/* ⑥ THE WORKSPACE LIST, FOR PER-WORKSPACE SCHEDULING                  */
/* ------------------------------------------------------------------ */

export type SchedulableTenant = {
  readonly id: string;
  readonly slug: string;
  /** `runForTenant` takes it, and `dunning_sweep` puts it on the letter. */
  readonly name: string;
  /**
   * ⭐ CARRIED SO THE ENTITLEMENT CHECK COSTS NO EXTRA QUERY.
   * `tenantAllowsFeature` accepts `cachedPlanTier` precisely so the caller
   * that already read the workspace row does not read it again — which is
   * the whole of PATCH-REQUEST-A item 3, solved on this side of the
   * boundary instead of the registry's.
   */
  readonly planTier: string;
};

/**
 * Active workspaces, for the per-workspace fan-out.
 *
 * 🔴 `withPlatformScope`, NOT "no scope at all". With no session variable
 * set the `tenants` policy matches nothing, so under a role that does not
 * bypass row-level security this returns ZERO workspaces, silently, on
 * every tick, forever. Cross-tenant and unscoped are not the same thing:
 * unscoped is not a wider view, it is no view. This is the third place in
 * the repository that has to say so.
 */
export async function listSchedulableTenants(limit: number): Promise<{
  tenants: SchedulableTenant[];
  notReached: number;
}> {
  const rows = await withPlatformScope(
    "Scheduler tick: a per-tenant job runs for every active workspace, so the tick must see the whole list before running any",
    (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, slug, name, plan_tier
          FROM tenants
         WHERE status = 'active'
           AND deleted_at IS NULL
         ORDER BY id
         LIMIT ${limit + 1}
      `),
  );

  const list = (
    Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ id?: unknown; slug?: unknown; name?: unknown; plan_tier?: unknown }>;

  const parsed: SchedulableTenant[] = list
    .map((r) => ({
      id: String(r.id ?? ""),
      slug: String(r.slug ?? ""),
      name: String(r.name ?? ""),
      planTier: String(r.plan_tier ?? "free"),
    }))
    .filter((t) => t.id.length > 0);

  /**
   * ⚠️ `limit + 1` ON PURPOSE, and then the extra row is DROPPED rather
   * than run. Selecting exactly the bound cannot tell "there were 500"
   * from "there were 6,000"; one extra row answers the question. Same
   * reasoning as MAX_TENANTS_PER_JOB in the registry, and the count is
   * surfaced rather than a boolean, because a bound the operator cannot
   * see is a bound nobody raises.
   */
  return {
    tenants: parsed.slice(0, limit),
    notReached: Math.max(0, parsed.length - limit),
  };
}

/**
 * Whether a workspace still exists and is active. Used before a manual
 * "run now" against one workspace, so an operator pasting a stale id gets
 * a refusal rather than a run that considers zero workspaces and reports
 * success.
 */
export async function findSchedulableTenant(
  tenantId: string,
): Promise<SchedulableTenant | null> {
  const rows = await withPlatformScope(
    "Scheduler: an operator named one workspace by id, and running for a workspace that does not exist would report success having done nothing",
    (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, slug, name, plan_tier
          FROM tenants
         WHERE id = ${tenantId}::uuid
           AND status = 'active'
           AND deleted_at IS NULL
         LIMIT 1
      `),
  );
  const list = (
    Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ id?: unknown; slug?: unknown; name?: unknown; plan_tier?: unknown }>;
  const first = list[0];
  if (!first || !first.id) return null;
  return {
    id: String(first.id),
    slug: String(first.slug ?? ""),
    name: String(first.name ?? ""),
    planTier: String(first.plan_tier ?? "free"),
  };
}
