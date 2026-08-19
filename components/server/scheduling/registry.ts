import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE WORK THAT NOTHING RAN
 * Version: v1.66.0-alpha (Brief C)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Railway runs ONE service and has no scheduler attached to it. The
 * consequence, verified by grep against this tree at v1.65.0-alpha, is
 * that six functions exist, are correct, are tested, and are called by
 * nothing at all:
 *
 *   server/actions/credit.ts        runDunningSweep       0 callers
 *   server/actions/workflows.ts     runWorkflowMaintenance 0 callers
 *   server/security/anomalies.ts    runAnomalyDetection   0 callers
 *   server/actions/rhythms.ts       recomputeRhythms      0 callers
 *   server/metering/record.ts       reconcileStorageLevel 0 callers
 *   server/actions/receivables.ts   planDunning           0 callers
 *
 * ⚠️ "0 callers" HERE MEANS "I FOUND NO CALLER", which is a weaker and
 * truer claim than "it is not called". The evidence is in the batch
 * report; a dynamic import built from a string would not have shown up.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE REGISTRY IS THE POINT, NOT THE ROUTE
 * ══════════════════════════════════════════════════════════════════════
 * A route with six `if (mode === "…")` branches would have made the same
 * mistake one level up: the list of scheduled work would exist only as
 * control flow, so nothing could enumerate it, no document could be
 * generated from it, and the seventh job somebody adds would be reachable
 * or not depending on whether they remembered to edit two files.
 *
 * So the jobs are DATA. `app/api/workers/route.ts` looks a job up by id
 * and runs it. `scripts/generate-cron-runbook.mjs` reads the same array
 * and writes `docs/current/CRON-RUNBOOK.md`, so the operator's document
 * cannot drift from the code the way `RAILWAY-VARIABLES-PASTE.txt` drifted
 * from `lib/platform/env-catalog.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THERE IS NO SERVICE ACCOUNT
 * ══════════════════════════════════════════════════════════════════════
 * The obvious way to call a permission-gated server action from a cron is
 * to invent a user with every permission and sign in as it. That user
 * would then own every row it created, appear in every audit chain as the
 * actor, and be the single credential whose theft grants everything.
 *
 * `runCronSweep` in `app/api/workers/route.ts` already showed the right
 * shape: list the workspaces under `withPlatformScope`, then do the work
 * per workspace under `withTenant`. Row-level security is enforced for
 * every write exactly as it is for a person; what is absent is a PERSON,
 * and that absence is recorded honestly as a null `created_by` and a
 * `writeSystemAudit` row rather than disguised.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY PER-TENANT JOB IS ENTITLEMENT-GATED
 * ══════════════════════════════════════════════════════════════════════
 * `feature` below is read by `runScheduledJob` before the job runs, and a
 * workspace that is not entitled is skipped AND SAID to be skipped. A
 * nightly job delivering a paid capability to a workspace that has not
 * paid for it is instance eleven of the pattern in the brief.
 */

import { and, eq, isNull } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import { writeSystemAudit } from "@/server/audit";
import { tenantAllowsFeature } from "@/server/scheduling/entitlement";
import { sweepDunningForTenant } from "@/server/credit/dunning-sweep";
import { recomputeRhythmsForTenant } from "@/server/patterns/rhythm-recompute";
import { reconcileStorageLevel } from "@/server/metering/record";
import { runAnomalyDetection } from "@/server/security/anomalies";
import { dispatchScheduled } from "@/server/workflows/dispatch";
import { executeRun } from "@/server/workflows/executor";
import { expireOverdueTasks, resumeDueRuns } from "@/server/workflows/runs";
import { planDunningSweep } from "@/server/receivables/dunning";
import { dispatchTenantOutbox } from "@/server/email/outbox";
import { todayInIndia } from "@/lib/accounting/periods";
/** ⭐ Wave 8 — the counter that makes a rate limit a limit, and its sweeper. */
import { sweepRateLimitCounters } from "@/server/security/rate-limit-durable";
import { rateLimitBackendName } from "@/lib/security/rate-limit";

/* ------------------------------------------------------------------ */
/* THE BOUND                                                           */
/* ------------------------------------------------------------------ */

/**
 * How many workspaces one invocation of a per-tenant job will touch.
 *
 * ⚠️ A SILENT CAP IS A LIE. `MAX_TENANTS_PER_JOB` exists because an
 * unbounded loop over a growing tenant table is a job that works fine
 * until the day it does not — but a response saying `swept: 500` when
 * there are 640 workspaces reads as "swept everything". So the executor
 * counts what it did NOT reach and returns `notReached`, and `ok` is
 * FALSE when that number is not zero. A bound the operator cannot see is
 * a bound nobody raises.
 */
export const MAX_TENANTS_PER_JOB = 500;

/* ------------------------------------------------------------------ */
/* THE SHAPE                                                           */
/* ------------------------------------------------------------------ */

export type JobTenantResult = {
  tenantId: string;
  slug: string;
  ok: boolean;
  /** Present when the workspace was skipped rather than run. */
  skipped?: string;
  detail?: Record<string, number | string | boolean | null>;
  error?: string;
};

export type ScheduledJobRun = {
  jobId: string;
  ok: boolean;
  scope: "per-tenant" | "platform";
  tenantsConsidered: number;
  tenantsRun: number;
  tenantsSkipped: number;
  tenantsFailed: number;
  /** 🔴 Workspaces the bound refused to reach. Non-zero makes `ok` false. */
  notReached: number;
  results: JobTenantResult[];
  platformDetail?: Record<string, number | string | boolean | null>;
  error?: string;
};

export type ScheduledJob = {
  /** The value the operator puts in the request body. Stable forever. */
  readonly id: string;
  readonly scope: "per-tenant" | "platform";
  readonly label: string;
  /**
   * 🔴 THE ENTITLEMENT KEY. Read by `runScheduledJob` before the work
   * happens, and a workspace that is not entitled is skipped and SAID to
   * be skipped.
   *
   * ⚠️ NULL IS ALLOWED AND HAS TO BE ARGUED FOR. A platform-scoped job
   * belongs to us and not to a customer's plan. A PER-TENANT job with a
   * null feature is a paid capability being delivered on a schedule to
   * somebody who may not be paying for it, so it must fill in
   * `ungatedBecause` and the test suite refuses it otherwise.
   */
  readonly feature: string | null;
  /**
   * Why a per-tenant job runs for every workspace regardless of plan.
   * Required exactly when `feature` is null and `scope` is per-tenant.
   */
  readonly ungatedBecause?: string;
  /** What stops working when this job stops running. Not decoration. */
  readonly consequenceWhenStopped: string;
  /** Recommended schedule, in UTC, because cron schedulers are in UTC. */
  readonly cronUtc: string;
  /** The same schedule said in IST, because the operator lives there. */
  readonly cadenceInIst: string;
  /** Why running it twice is safe. Asserted non-empty by the test suite. */
  readonly idempotency: string;
  readonly runForTenant?: (tenant: {
    id: string;
    slug: string;
    name: string;
  }) => Promise<Record<string, number | string | boolean | null>>;
  readonly runPlatform?: () => Promise<Record<string, number | string | boolean | null>>;
};

/* ------------------------------------------------------------------ */
/* THE JOBS                                                            */
/* ------------------------------------------------------------------ */

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    id: "dunning_sweep",
    scope: "per-tenant",
    label: "Advance the collections ladder",
    feature: "sales.orders",
    consequenceWhenStopped:
      "The collections ladder does not advance. No credit_dunning_log row is written, so no reminder is queued, so nothing is sent and no credit hold is placed. A statutory demand notice that was never swept is a notice that was never served, and the provider message id that constitutes proof of service under Indian law is never obtained.",
    cronUtc: "30 19 * * *",
    cadenceInIst: "01:00 IST every day",
    idempotency:
      "The insert is ON CONFLICT DO NOTHING against credit_dunning_log_once_per_stage_key and only the rows RETURNING gives back earn a letter, so a second run in the same day queues nothing. Credit holds are ON CONFLICT DO NOTHING against the one-active-hold index. The outbox row carries the fixed key dunning:<row id>.",
    runForTenant: async (tenant) => {
      const outcome = await sweepDunningForTenant({
        tenantId: tenant.id,
        organizationName: tenant.name,
        actorUserId: null,
        impersonationId: null,
        audit: (entry) =>
          writeSystemAudit(tenant.id, {
            action: "create",
            resourceType: "dunning_sweep",
            resourceId: entry.ladderId,
            actorLabel: "scheduler",
            newValue: {
              ladder: entry.ladderName,
              asOf: entry.asOf,
              queued: entry.queued,
              suppressed: entry.suppressed,
              holdsPlaced: entry.holdsPlaced,
              skipped: entry.skipped,
            },
            severity: "warning",
          }),
      });
      return {
        asOf: outcome.asOf,
        queued: outcome.queued,
        suppressed: outcome.suppressed,
        holdsPlaced: outcome.holdsPlaced,
        skipped: outcome.skipped.length,
      };
    },
  },

  {
    id: "mail_drain",
    scope: "per-tenant",
    label: "Send what the outbox is holding",
    /**
     * ══════════════════════════════════════════════════════════════════
     * 🔴 DELIBERATELY UNGATED, AND THIS IS THE ONE PLACE A GATE WOULD BE
     *    THE DEFECT RATHER THAN THE FIX
     * ══════════════════════════════════════════════════════════════════
     * Every other per-tenant job here decides whether to DO work, and
     * gating that on the plan is right. This one finishes work that was
     * already authorised: the row is in `email_outbox` because some gated
     * feature put it there, and the decision to send was made then.
     *
     * ⚠️ REFUSING TO DRAIN IS NOT "WITHHOLDING A PAID FEATURE", IT IS
     * LOSING A LETTER. A workspace whose subscription lapses on Tuesday
     * would have Monday's statutory demand notices sit in the queue
     * forever, and a notice that was never served is the exposure this
     * whole batch is about. The commercial lever for a lapse is the write
     * path, which already refuses; it is not the delivery of documents
     * the product has already told a customer it sent.
     */
    feature: null,
    ungatedBecause:
      "The outbox holds work that a gated feature already authorised. Refusing to drain it would not withhold a capability, it would strand statutory notices that the product has already recorded as queued.",
    consequenceWhenStopped:
      "Nothing leaves the building. Queued dunning letters, RERA demand notices and every other transactional message stay in email_outbox with delivery 'queued', and a message whose first send failed is never retried. This is also the only thing that writes a provider message id back onto the row it came from, so it is the only thing that can turn 'we recorded a reminder' into 'we can prove we sent one'.",
    /**
     * ⚠️ HOURLY, NOT NIGHTLY, AND THE ARGUMENT IS THE RETRY.
     *
     * This is the only thing that sends mail AND the only thing that
     * retries a failed send. Nightly means a bounced-then-retried letter
     * waits twenty four hours per attempt, so a transient provider outage
     * at 01:00 costs a full day on every message in the queue. It is
     * idempotent by construction — the claim is FOR UPDATE SKIP LOCKED
     * with a fixed idempotency key per row — so the only cost of hourly is
     * running the tenant loop twenty four times over a table that is
     * usually empty.
     */
    cronUtc: "5 * * * *",
    cadenceInIst: "five minutes past every hour",
    idempotency:
      "dispatchTenantOutbox claims rows with an atomic FOR UPDATE SKIP LOCKED and a claim token. A row already claimed by a running worker is invisible to a second one; a claim from a worker that died is reclaimed by expiry and re-offered WITH THE SAME idempotency key, so the provider de-duplicates rather than sending twice.",
    runForTenant: async (tenant) => {
      const report = await dispatchTenantOutbox({ tenantId: tenant.id, limit: 50 });
      return {
        claimed: report.claimed,
        sent: report.sent,
        suppressed: report.suppressed,
        retrying: report.retrying,
        dead: report.dead,
        released: report.released,
      };
    },
  },

  {
    id: "workflow_maintenance",
    scope: "per-tenant",
    label: "Fire, resume and expire tenant workflows",
    feature: "workflows.scheduled",
    consequenceWhenStopped:
      "Every tenant-configured scheduled workflow stops. Nothing fires on its schedule, nothing that is waiting resumes, and an approval request nobody answered stays open forever holding its run's cursor. The workflow builder keeps accepting schedules and none of them mean anything.",
    cronUtc: "*/15 * * * *",
    cadenceInIst: "every fifteen minutes",
    idempotency:
      "dispatchScheduled claims a due workflow with UPDATE ... WHERE next_run_at = <the value it read>, so exactly one of two concurrent dispatchers changes the row. next_run_at advances from now rather than from the missed slot, so a four-hour outage fires each workflow once on recovery and not four times. executeRun claims the run and returns 'skipped' when it cannot, so a second pass performs no effect twice.",
    runForTenant: async (tenant) => {
      const scheduled = await dispatchScheduled({ tenantId: tenant.id });
      for (const runId of scheduled.started) {
        await executeRun({ tenantId: tenant.id, runId });
      }
      const resumed = await resumeDueRuns({ tenantId: tenant.id });
      const expired = await expireOverdueTasks({ tenantId: tenant.id });
      return {
        started: scheduled.started.length,
        skipped: scheduled.skipped.length,
        resumed: resumed.resumed.length,
        expired: expired.expired,
      };
    },
  },

  {
    id: "rhythms",
    scope: "per-tenant",
    label: "Recompute who is about to order and who has gone quiet",
    /**
     * ⚠️ `crm.contacts` IS BASELINE ON EVERY TIER, so this gate refuses
     * only in the one case that matters for a nightly job: a workspace
     * whose subscription has lapsed, or one where platform staff have
     * revoked the key with a recorded reason. Skipping unattended compute
     * for a lapsed workspace is what a lapse is for; the board keeps
     * showing the last figures it computed, so nothing a customer already
     * has is taken away.
     */
    feature: "crm.contacts",
    consequenceWhenStopped:
      "The /rhythms board reads what was computed and nothing computes. Both halves of the feature go dark: the nudge that a regular customer is due, and the more valuable half, the customer who ordered every month for two years and has not ordered for seven weeks. No task is raised, so nobody calls them.",
    cronUtc: "0 20 * * *",
    cadenceInIst: "01:30 IST every day",
    idempotency:
      "The rhythm row is an upsert keyed on (tenant, subject_type, subject_id) and always replaces rather than patches. The signal is ON CONFLICT DO NOTHING against an occurrence key that is the expected date for a due signal and the calendar month for a lapse, so a second run the same day raises no second signal and therefore creates no second task.",
    runForTenant: async (tenant) => {
      const outcome = await recomputeRhythmsForTenant({
        tenantId: tenant.id,
        impersonationId: null,
        audit: (entry) =>
          writeSystemAudit(tenant.id, {
            action: "update",
            resourceType: "customer_rhythms",
            resourceId: tenant.id,
            actorLabel: "scheduler",
            newValue: {
              examined: entry.examined,
              regular: entry.regular,
              lapsed: entry.lapsed,
              signalsRaised: entry.signalsRaised,
            },
            severity: "info",
          }),
      });
      return { ...outcome };
    },
  },

  {
    id: "storage_reconcile",
    scope: "per-tenant",
    label: "Recount stored bytes from the documents table",
    feature: "storage.documents",
    consequenceWhenStopped:
      "Stored-bytes metering drifts upward after every bulk delete and never comes back. The customer is billed against, and quota-limited by, a number that is too high. Five comments in server/metering name this function as the corrective and nothing called it.",
    /**
     * ⚠️ SUNDAY IN UTC IS MONDAY IN IST. 20:45 UTC on Sunday plus 5:30 is
     * 02:15 on Monday morning in Bengaluru, and writing "Sunday" in the
     * IST column would have sent somebody looking for a run on the wrong
     * day. Every cadence in this file states the IST day it actually
     * lands on, not the UTC one.
     */
    cronUtc: "45 20 * * 0",
    cadenceInIst: "02:15 IST on Monday morning",
    idempotency:
      "It is a recomputation, not an increment: SUM(size_bytes) over the tenant's live documents is written as the level. Running it a hundred times writes the same value a hundred times. It never throws — a workspace it cannot compute returns null and is reported as failed rather than silently counted as done.",
    runForTenant: async (tenant) => {
      const written = await reconcileStorageLevel(tenant.id);
      /**
       * 🔴 `null` MEANS IT DID NOT WORK, AND IT IS REPORTED AS SUCH.
       * `reconcileStorageLevel` is best-effort and swallows its own
       * exception, which is right for a call inside a user's request and
       * wrong for a scheduled corrective: a job that silently records
       * nothing is a job whose failure nobody discovers. Throwing here
       * turns it into a failed workspace, which turns the run red.
       */
      if (written === null) {
        throw new Error(
          "Stored bytes could not be recomputed for this workspace. reconcileStorageLevel returned null; see the reportFailure entry for the underlying error.",
        );
      }
      return { storedBytes: written.toString() };
    },
  },

  {
    id: "rera_dunning_plan",
    scope: "per-tenant",
    label: "Report which RERA demand notices are due for a rung",
    feature: "sales.receivables",
    consequenceWhenStopped:
      "Nobody is told which allottees have fallen due for the next rung of the statutory ladder, so the letters are sent when somebody happens to look. The rungs themselves are NOT sent by this job and must not be.",
    cronUtc: "0 3 * * 1-5",
    cadenceInIst: "08:30 IST on weekdays",
    idempotency:
      "It writes nothing. It is a read of demand_notices joined against the configured policy, so a hundred runs produce a hundred identical reports and change no row.",
    /**
     * ══════════════════════════════════════════════════════════════════
     * 🔴 WHY THIS PLANS AND DOES NOT SEND, WHICH IS A DECISION AND NOT AN
     *    OMISSION
     * ══════════════════════════════════════════════════════════════════
     * The brief lists `sendDunningNotice` among the dead functions and it
     * is dead: I found no importer in `app/` or `components/`. It is NOT
     * wired to this cron, and it should not be.
     *
     * ⚠️ THE PERMISSION DEPENDS ON THE RUNG. A cancellation warning needs
     * `receivables:warn_cancellation`, a key the accountant who does every
     * other collections task deliberately does not hold, because that
     * letter precedes terminating an allotment and forfeiting what a
     * family has paid towards a home. A cron holds no permission at all,
     * so automating it would not be "running it as somebody with the
     * right" — it would be removing the right from the design.
     *
     * ⚠️ AND THE ACTION ITSELF SAYS SO: "a single call that sent a hundred
     * letters would be a single call that sent a hundred wrong letters."
     * A schedule is that single call, once a day, forever.
     *
     * ⭐ SO THE SCHEDULE DELIVERS THE THING A HUMAN CANNOT DO FOR
     * THEMSELVES — noticing — and leaves the decision where the statute
     * puts it. `needsDecision` is reported separately from `toSend` for
     * the same reason: a demand the policy cannot resolve is not a demand
     * to send, and merging the two counts would hide it.
     *
     * ⚠️ THIS LEAVES `sendDunningNotice` WITH NO CALLER. That is stated
     * plainly in the batch report rather than papered over: it needs a
     * screen, and a screen is not this batch.
     */
    runForTenant: async (tenant) => {
      const items = await planDunningSweep({
        tenantId: tenant.id,
        asOf: todayInIndia(),
        limit: 200,
      });
      const toSend = items.filter((i) => i.action === "send" && i.stage).length;
      const needsDecision = items.filter((i) => i.action === "needs_decision").length;
      return {
        examined: items.length,
        toSend,
        needsDecision,
        /**
         * ⚠️ THE BOUND ON THIS READ IS REPORTED TOO. 200 is the limit
         * `planDunningSweep` was given; a workspace at exactly 200 has
         * more that this run did not look at.
         */
        truncated: items.length >= 200,
      };
    },
  },

  {
    /**
     * ⭐⭐ WAVE 8 — THE RATE LIMIT COUNTERS' SWEEPER.
     *
     * ⚠️ `rate_limit_counters` IS THE HOTTEST SMALL TABLE IN THE DATABASE
     * after wave 8: one row per key per window, on every guarded request.
     * Without a sweeper it grows forever, the expiry index grows with it,
     * and the table that must answer in a millisecond stops doing so.
     */
    id: "rate_limit_sweep",
    scope: "platform",
    label: "Delete expired rate limit windows",
    feature: null,
    consequenceWhenStopped:
      "rate_limit_counters grows without bound. One row per key per window, on every guarded request, forever. The table is on the critical path of every rate-limited route, so the first symptom is not a disk warning but every login getting slower. Nothing else deletes from it.",
    /**
     * ⚠️ HOURLY, NOT NIGHTLY. The longest window in POLICY_CONFIG is five
     * minutes, so an hourly sweep never has more than about twelve
     * windows' worth to remove and each run is small. A nightly sweep
     * would accumulate a day of rows and then take a lock long enough to
     * be felt on the login path.
     */
    cronUtc: "7 * * * *",
    cadenceInIst: "seven minutes past every hour",
    idempotency:
      "It deletes rows whose expires_at has passed, up to a bounded batch. Running it twice deletes nothing the second time. It never touches a live window: expires_at is set to two windows out, so a request that started inside a window still finds its row. Deleting a row that should not have been deleted would reset one counter to zero, which is why the batch is bounded and the predicate is time rather than count.",
    runPlatform: async () => {
      const deleted = await sweepRateLimitCounters();
      /**
       * ⭐ THE BACKEND IS REPORTED WITH THE COUNT, because "0 deleted" has
       * two completely different meanings: nothing had expired, or the
       * limiter is not using this table at all and the counters are
       * per-instance again.
       */
      return { deleted, backend: rateLimitBackendName() };
    },
  },

  {
    id: "anomaly_detection",
    scope: "platform",
    label: "Run the five security detectors across the perimeter",
    feature: null,
    consequenceWhenStopped:
      "Five detectors report nothing: failed-login bursts, permission-denial spikes, portal-token sharing, off-hours bulk export and rate-limit pressure. An anomaly detector that never runs is indistinguishable from one that always passes, and the unattributed perimeter rows — forged signatures, unknown portal tokens, pre-session limiter trips — are seen by nothing else in the product.",
    cronUtc: "*/30 * * * *",
    cadenceInIst: "every thirty minutes",
    idempotency:
      "It reads a rolling two-hour window and records findings with noCoalesce. Two runs thirty minutes apart over overlapping windows can record the same ongoing burst twice, and that is the intended behaviour for an aggregate: suppressing the second row would drop the second distinct finding of the same rule in the same window, which is precisely when two networks are brute-forcing at once. It acts on nothing, locks nobody out and revokes no token, so a duplicate finding costs a duplicate row and nothing else.",
    /**
     * ⚠️ PLATFORM-SCOPED, AND THAT IS THE WHOLE REASON IT IS NOT IN THE
     * PER-TENANT LOOP. With no `tenantId` the filter is the time window
     * alone, which is the only way the `tenant_id IS NULL` perimeter rows
     * are considered at all. Running it once per tenant would silently
     * degrade it to a detector that cannot see a pre-authentication
     * attack.
     */
    runPlatform: async () => {
      const findings = await runAnomalyDetection({});
      const bySeverity: Record<string, number> = {};
      for (const finding of findings) {
        bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
      }
      return {
        findings: findings.length,
        critical: bySeverity.critical ?? 0,
        warning: bySeverity.warning ?? 0,
        info: bySeverity.info ?? 0,
      };
    },
  },
];

export function findScheduledJob(id: string): ScheduledJob | undefined {
  return SCHEDULED_JOBS.find((j) => j.id === id);
}

export const SCHEDULED_JOB_IDS: readonly string[] = SCHEDULED_JOBS.map((j) => j.id);

/* ------------------------------------------------------------------ */
/* THE EXECUTOR                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run one registered job.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 FAILURE IS VISIBLE OR IT IS NOT FAILURE
 * ══════════════════════════════════════════════════════════════════════
 * `ok` is false when ANY workspace failed, and false when the bound
 * refused to reach a workspace. The route maps a false `ok` to HTTP 500,
 * and the runbook's curl uses `-f`, so a partially failed run cannot
 * report green. A sweep that half worked and said 200 is a sweep nobody
 * ever fixes.
 *
 * ⚠️ ONE WORKSPACE'S FAILURE DOES NOT ABORT THE REST. The loop catches
 * per workspace, records the message, and carries on. Stopping at the
 * first error would mean one broken workspace freezes the collections
 * ladder for every other one — which is how a single bad row becomes an
 * outage for everybody.
 */
export async function runScheduledJob(args: {
  job: ScheduledJob;
  /** Restrict to one workspace. Used by the console and by a re-run. */
  onlyTenantId?: string | null;
  limit?: number;
}): Promise<ScheduledJobRun> {
  const job = args.job;

  if (job.scope === "platform") {
    if (!job.runPlatform) {
      return {
        jobId: job.id,
        ok: false,
        scope: "platform",
        tenantsConsidered: 0,
        tenantsRun: 0,
        tenantsSkipped: 0,
        tenantsFailed: 0,
        notReached: 0,
        results: [],
        error: `Job "${job.id}" is declared platform-scoped and has no runPlatform.`,
      };
    }
    try {
      const detail = await job.runPlatform();
      return {
        jobId: job.id,
        ok: true,
        scope: "platform",
        tenantsConsidered: 0,
        tenantsRun: 0,
        tenantsSkipped: 0,
        tenantsFailed: 0,
        notReached: 0,
        results: [],
        platformDetail: detail,
      };
    } catch (err) {
      return {
        jobId: job.id,
        ok: false,
        scope: "platform",
        tenantsConsidered: 0,
        tenantsRun: 0,
        tenantsSkipped: 0,
        tenantsFailed: 1,
        notReached: 0,
        results: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!job.runForTenant) {
    return {
      jobId: job.id,
      ok: false,
      scope: "per-tenant",
      tenantsConsidered: 0,
      tenantsRun: 0,
      tenantsSkipped: 0,
      tenantsFailed: 0,
      notReached: 0,
      results: [],
      error: `Job "${job.id}" is declared per-tenant and has no runForTenant.`,
    };
  }

  const bound = Math.min(Math.max(1, args.limit ?? MAX_TENANTS_PER_JOB), MAX_TENANTS_PER_JOB);

  /**
   * 🔴 `withPlatformScope`, NOT "no scope at all".
   *
   * Reading across workspaces REQUIRES THE PLATFORM MARKER. With no
   * session variable set, the `tenants` policy evaluates to false and
   * matches nothing, so under a database role that does not bypass RLS
   * this loop would process ZERO workspaces, silently, every night,
   * forever. Cross-tenant and unscoped are not the same thing: unscoped
   * is not a wider view, it is no view.
   */
  const all = await withPlatformScope(
    `Scheduled job "${job.id}": list the workspaces to run it for`,
    (tx) =>
      tx
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          planTier: tenants.planTier,
        })
        .from(tenants)
        .where(and(eq(tenants.status, "active"), isNull(tenants.deletedAt)))
        .orderBy(tenants.id)
        /**
         * ⚠️ `bound + 1` ON PURPOSE. Selecting exactly the bound cannot
         * tell "there were 500" from "there were 6,000"; one extra row
         * answers the question, and the extra row is dropped rather than
         * run. `truncated: true` with no number was the shape that let
         * MAX_TENANTS_PER_SWEEP mean nothing.
         */
        .limit(bound + 1),
  );

  const candidates = args.onlyTenantId
    ? all.filter((t) => t.id === args.onlyTenantId)
    : all.slice(0, bound);

  const notReached = args.onlyTenantId ? 0 : Math.max(0, all.length - bound);

  const results: JobTenantResult[] = [];

  for (const tenant of candidates) {
    if (job.feature !== null) {
      const entitled = await tenantAllowsFeature({
        tenantId: tenant.id,
        feature: job.feature,
        cachedPlanTier: tenant.planTier,
      });
      if (!entitled.allowed) {
        results.push({
          tenantId: tenant.id,
          slug: tenant.slug,
          ok: true,
          skipped: entitled.reason,
        });
        continue;
      }
    }

    try {
      const detail = await job.runForTenant(tenant);
      results.push({ tenantId: tenant.id, slug: tenant.slug, ok: true, detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduled:${job.id}] ${tenant.slug} failed:`, message);
      results.push({ tenantId: tenant.id, slug: tenant.slug, ok: false, error: message });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped !== undefined).length;

  return {
    jobId: job.id,
    ok: failed === 0 && notReached === 0,
    scope: "per-tenant",
    tenantsConsidered: candidates.length,
    tenantsRun: results.length - skipped - failed,
    tenantsSkipped: skipped,
    tenantsFailed: failed,
    notReached,
    results,
  };
}
