/**
 * Ordence — Background Work Endpoint
 * Version: v0.21.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ROUTE IS NOW
 * ══════════════════════════════════════════════════════════════════════════
 * It used to DRAIN a BullMQ queue: open Redis, pull a bounded batch, process
 * what fitted in a 10-second budget, hand the rest back. None of that is
 * possible on Cloudflare — a Worker cannot open a TCP connection to Redis and
 * cannot hold one open between requests — and none of it is necessary, because
 * Cloudflare Queues does the pulling.
 *
 * So the route inverted. It no longer fetches work; work is delivered TO it,
 * one message at a time, by `worker.ts`'s `queue()` handler. Two shapes:
 *
 *   { "job": { ...JobData } }   process exactly this job, report the outcome
 *   { "mode": "cron" }          the nightly sweep
 *
 * `worker.ts` explains why the queue handler calls an HTTP route instead of
 * importing the processors directly. The short version: this file already has
 * the authentication and the tenant guard, and it is bundled by Next.js with
 * the same module resolution as the rest of the application.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS ENDPOINT IS DANGEROUS, AND HOW IT IS LOCKED DOWN
 * ══════════════════════════════════════════════════════════════════════════
 * This route executes background work. If an attacker could call it they
 * could:
 *   - run jobs against a tenant of their choosing, by supplying the payload
 *   - force expensive aggregations repeatedly to burn the Workers quota (a
 *     financial denial-of-service)
 *   - replay a captured request to re-run jobs
 *
 * THREE independent authentication paths, all fail-closed:
 *
 *   1. BEARER SECRET — `WORKER_API_SECRET`. This is how `worker.ts` calls in
 *      from the cron and queue handlers, and how a self-hosted worker would.
 *      Compared with `timingSafeEqual`; a plain `===` on a secret leaks its
 *      prefix through response-time differences, which is a real, demonstrated
 *      attack.
 *
 *   2. QSTASH SIGNATURE — retained. Upstash signs each delivery with a key
 *      only Upstash holds. Verified cryptographically before anything else.
 *      Unused on Cloudflare, kept so an external scheduler still works.
 *
 *   3. VERCEL CRON — retained for the Vercel deployment path, which still
 *      builds. `x-vercel-signature` against `CRON_SECRET`.
 *
 * If NONE are configured the endpoint returns 503 and refuses to run. An
 * unauthenticated worker endpoint is worse than no worker endpoint.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS PATH IS IN middleware.ts's PUBLIC LIST
 * ══════════════════════════════════════════════════════════════════════════
 * It has to be: `clerkMiddleware` runs before every route, and the cron and
 * queue handlers have no browser cookie. Before this change, `/api/workers`
 * was reachable only with a Clerk session — which meant any authenticated
 * user of any tenant reached this file, and was then refused by the three
 * checks below.
 *
 * That is the same set of people who can reach it now. "Public" here removes
 * a layer that never granted anything, and makes the shared secret — which
 * was always the real gate — the only one. Nothing that could previously get
 * past this file can get past it now.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import { Receiver } from "@upstash/qstash";
import { db, withPlatformScope } from "@/db";
/**
 * ⭐ THE MAIL DRAIN. See `runCronSweep` below — queued dunning letters
 * had no drain at all before this import existed.
 */
import { dispatchTenantOutbox } from "@/server/email/outbox";
import { tenants } from "@/db/schema";
import {
  assertJobTenant,
  enqueueJob,
  describeJobTransport,
  isQueueEnabled,
  isInlineFallbackEnabled,
  type JobData,
} from "@/lib/queue/jobs";
import { processJob } from "@/lib/queue/processors";
/**
 * ⭐⭐⭐ THE SCHEDULED WORK THAT NOTHING RAN — Brief C.
 *
 * Six functions existed, were correct, were tested, and had no caller:
 * the dunning sweep, workflow maintenance, anomaly detection, the rhythm
 * recompute, storage reconciliation and the RERA dunning plan. They are
 * registered as DATA in `server/scheduling/registry.ts` and dispatched by
 * id below.
 *
 * ⚠️ EXTENDED HERE RATHER THAN GIVEN ITS OWN ROUTE, for one reason that
 * decided it: `middleware.ts` matches public paths EXACTLY, not by
 * prefix — `/api/workers` and `/api/workers/ai-monitors` are two separate
 * entries. A new path would need a new line in `middleware.ts`, which
 * belongs to another stream this cycle, and a scheduled route that is not
 * in the public list is refused by Clerk on every single run: present,
 * correct, never executed, which is the exact failure this batch exists
 * to remove.
 */
import {
  SCHEDULED_JOBS,
  SCHEDULED_JOB_IDS,
  findScheduledJob,
  runScheduledJob,
} from "@/server/scheduling/registry";
/**
 * ⭐⭐⭐ WAVE 14, TRACK A — THE SCHEDULER AND THE JOB CONTROL PLANE.
 *
 * Everything above this import was already correct and had one thing
 * missing: a clock. `{"mode":"scheduled","jobId":…}` runs a job when
 * somebody calls it, and nothing has ever called it.
 *
 * ⚠️ THE NEW MODES LIVE ON THIS PATH RATHER THAN ON `/api/scheduler`, AND
 * THAT IS FORCED, not preferred. `middleware.ts` matches public paths
 * EXACTLY, not by prefix — `/api/workers` and `/api/workers/ai-monitors`
 * are two separate entries in that list. A new path would need a new line
 * in `middleware.ts`, which belongs to another stream this wave, and a
 * scheduled route that is not in the public list is refused by Clerk on
 * every single run: present, correct, never executed. The comment above
 * `runRegisteredJob` already recorded this reasoning for the `scheduled`
 * mode; it applies unchanged to `tick`.
 */
import { runTick } from "@/server/scheduler/tick";
import { SCHEDULER_CATALOG, DORMANT_NOT_SCHEDULED } from "@/server/scheduler/catalog";
import { watchdogReport } from "@/server/scheduler/watchdog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How many tenants the nightly sweep will fan out to in one invocation.
 *
 * A cron invocation gets 15 minutes of wall-clock time, which is generous —
 * but an unbounded loop over a growing tenant table is a job that works fine
 * until the day it does not. When this cap is hit the response says so.
 */
const MAX_TENANTS_PER_SWEEP = 500;

/** How far ahead the expiry scan looks. */
const EXPIRY_LOOKAHEAD_DAYS = 30;

/* ------------------------------------------------------------------ */
/* AUTHENTICATION                                                      */
/* ------------------------------------------------------------------ */

type AuthResult =
  | { ok: true; method: "qstash" | "bearer" | "vercel-cron" }
  | { ok: false; status: number; reason: string };

/**
 * Constant-time string comparison.
 *
 * `a === b` returns as soon as it finds a differing byte, so response time
 * reveals how many leading characters were correct. Given enough requests an
 * attacker recovers the secret one character at a time. `timingSafeEqual`
 * always examines every byte.
 *
 * ⚠️ `node:crypto` on Workers requires the `nodejs_compat` flag, which
 * wrangler.jsonc sets. `timingSafeEqual` and `Buffer` are both supported
 * under it.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // Length must be compared separately — timingSafeEqual throws on a mismatch.
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length differences are not trivially timeable.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function authenticate(rawBody: string): Promise<AuthResult> {
  const headerList = await headers();

  const qstashCurrent = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const qstashNext = process.env.QSTASH_NEXT_SIGNING_KEY;
  const workerSecret = process.env.WORKER_API_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  // Fail closed: no configured auth means no execution.
  if (!qstashCurrent && !workerSecret && !cronSecret) {
    return {
      ok: false,
      status: 503,
      reason:
        "Worker endpoint is not configured with any authentication method. " +
        "Set WORKER_API_SECRET (npx wrangler secret put WORKER_API_SECRET).",
    };
  }

  /* --- 1. QStash signature ---------------------------------------- */
  const qstashSignature = headerList.get("upstash-signature");
  if (qstashSignature && qstashCurrent) {
    try {
      const receiver = new Receiver({
        currentSigningKey: qstashCurrent,
        nextSigningKey: qstashNext ?? qstashCurrent,
      });
      const valid = await receiver.verify({ signature: qstashSignature, body: rawBody });
      if (valid) return { ok: true, method: "qstash" };
      return { ok: false, status: 401, reason: "Invalid QStash signature." };
    } catch (err) {
      console.warn("[workers] QStash verification failed:", (err as Error).message);
      return { ok: false, status: 401, reason: "Invalid QStash signature." };
    }
  }

  /* --- 2. Bearer secret — the Cloudflare path ---------------------- */
  const authHeader = headerList.get("authorization");
  if (authHeader?.startsWith("Bearer ") && workerSecret) {
    const presented = authHeader.slice(7).trim();
    if (safeCompare(presented, workerSecret)) {
      return { ok: true, method: "bearer" };
    }
    return { ok: false, status: 401, reason: "Invalid worker token." };
  }

  /* --- 3. Vercel Cron (the Vercel deployment path) ----------------- */
  const vercelCron = headerList.get("x-vercel-signature") ?? headerList.get("x-vercel-cron");
  if (vercelCron && cronSecret) {
    if (safeCompare(vercelCron, cronSecret)) {
      return { ok: true, method: "vercel-cron" };
    }
    return { ok: false, status: 401, reason: "Invalid cron signature." };
  }

  return { ok: false, status: 401, reason: "Authentication required." };
}

/* ------------------------------------------------------------------ */
/* POST                                                                */
/* ------------------------------------------------------------------ */

export async function POST(req: Request) {
  const startedAt = Date.now();

  // Read the raw body BEFORE parsing — QStash signs the exact bytes.
  const rawBody = await req.text();

  const auth = await authenticate(rawBody);
  if (!auth.ok) {
    // Uniform shape; never reveals which method was attempted or why it failed.
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  let parsed: {
    job?: unknown;
    mode?: string;
    cron?: string;
    /**
     * ⚠️ `jobId`, NOT `job`. `job` already means "an inline JobData
     * object" on this route, and overloading one key with a string in one
     * mode and an object in another is how a typo becomes a 400 that
     * nobody can read. A separate key costs one word in the runbook.
     */
    jobId?: unknown;
    tenantId?: unknown;
    limit?: unknown;
    /** Free text naming the caller of a tick, e.g. "railway-cron". */
    source?: unknown;
    /** True when the caller can execute SQL as `ordence_maintenance`. */
    maintenance?: unknown;
  };
  try {
    parsed = rawBody ? (JSON.parse(rawBody) as typeof parsed) : {};
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  /* ---- CRON SWEEP -------------------------------------------------- */
  if (parsed.mode === "cron") {
    return runCronSweep({ authMethod: auth.method, cron: parsed.cron, startedAt });
  }

  /* ---- THE CLOCK --------------------------------------------------- */
  //
  // ⭐ ONE TICK, EVERY FIVE MINUTES, FROM THE RAILWAY CRON SERVICE. It
  // carries no job id: the tick asks the catalog what is due. That is what
  // keeps every cadence in `server/scheduling/registry.ts` and
  // `server/scheduler/policy.ts` rather than in a web console, and it is
  // why adding a ninth job schedules it by the commit that adds it.
  if (parsed.mode === "tick") {
    return runSchedulerTick({
      authMethod: auth.method,
      source: typeof parsed.source === "string" ? parsed.source : "railway-cron",
      /**
       * ⚠️ THE CALLER ASSERTS THIS, THE APPLICATION DOES NOT ASSUME IT.
       * Maintenance slots are claimed here and executed by whoever sent
       * the tick, over a database connection this process does not have.
       * A tick from a caller with no such connection must not claim them:
       * the row would sit unowned until the watchdog reclaimed it half an
       * hour later, and the `skip` overrun policy would suppress the next
       * slot in the meantime.
       */
      claimMaintenance: parsed.maintenance === true,
      startedAt,
    });
  }

  /* ---- ONE REGISTERED SCHEDULED JOB -------------------------------- */
  if (parsed.mode === "scheduled") {
    return runRegisteredJob({
      jobId: parsed.jobId,
      tenantId: parsed.tenantId,
      limit: parsed.limit,
      authMethod: auth.method,
      startedAt,
    });
  }

  /* ---- ONE JOB ----------------------------------------------------- */
  if (parsed.job !== undefined) {
    return runOneJob({ payload: parsed.job, authMethod: auth.method, startedAt });
  }

  return NextResponse.json(
    {
      error:
        'Nothing to do. Send {"mode":"tick"} to run the scheduler (this is what the Railway ' +
        'cron service sends), {"mode":"scheduled","jobId":"<id>"} to run one job by hand, ' +
        '{"job": {...}} to process a queue job, or {"mode":"cron"} to run the legacy sweep.',
      validModes: ["tick", "scheduled", "cron", "job"],
      validJobIds: SCHEDULED_JOB_IDS,
    },
    { status: 400 },
  );
}

/* ------------------------------------------------------------------ */
/* ONE JOB                                                             */
/* ------------------------------------------------------------------ */

async function runOneJob(args: {
  payload: unknown;
  authMethod: string;
  startedAt: number;
}): Promise<NextResponse> {
  /**
   * ⚠️ THE TENANT GUARD RUNS BEFORE ANY DATABASE WORK.
   *
   * A queue message is JSON that arrived over the network. Nothing about the
   * transport proves our own code produced it, and a job with no tenant would
   * run with no RLS context — returning nothing, while the application had
   * already lost the isolation guarantee. Reject loudly instead.
   */
  try {
    assertJobTenant(args.payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid job payload.";
    console.error("[workers] rejected job payload:", message);
    // 400, not 500: the message is malformed and retrying will never help.
    // The consumer sees a non-2xx and retries a bounded number of times
    // before the dead-letter queue takes it — the correct destination for a
    // payload that can never succeed.
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  const job = args.payload as JobData;
  const result = await processJob(job);

  // ⚠️ The HTTP status must reflect the JOB's outcome, not the route's.
  // `worker.ts` acks on success and retries on anything else; a 200 for a
  // failed job would ack it and lose the work permanently.
  return NextResponse.json(
    {
      ok: result.ok,
      authMethod: args.authMethod,
      kind: result.kind,
      tenantId: result.tenantId,
      detail: result.detail,
      error: result.error,
      tookMs: Date.now() - args.startedAt,
    },
    { status: result.ok ? 200 : 500 },
  );
}

/* ------------------------------------------------------------------ */
/* ONE REGISTERED SCHEDULED JOB                                        */
/* ------------------------------------------------------------------ */

/**
 * Run one job from `server/scheduling/registry.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE STATUS CODE IS THE ALERT
 * ══════════════════════════════════════════════════════════════════════
 * No scheduler reads JSON. A cron dashboard, an uptime monitor and a
 * `curl -f` in a runbook agree on exactly one thing: 2xx is green,
 * everything else is red. So a run in which any workspace failed, or in
 * which the bound refused to reach a workspace, answers 500 — the same
 * property `runCronSweep` already has and for the same reason. A
 * partially failed sweep that reports green is a sweep nobody fixes.
 *
 * ⚠️ AN UNKNOWN JOB ID IS 400 AND NAMES THE VALID ONES. A typo in a cron
 * body that returned 200-and-did-nothing would be indistinguishable from
 * a working schedule for as long as anybody cared to look.
 */
async function runRegisteredJob(args: {
  jobId: unknown;
  tenantId: unknown;
  limit: unknown;
  authMethod: string;
  startedAt: number;
}): Promise<NextResponse> {
  if (typeof args.jobId !== "string" || args.jobId.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Send {"mode":"scheduled","jobId":"<id>"}.',
        validJobIds: SCHEDULED_JOB_IDS,
      },
      { status: 400 },
    );
  }

  const job = findScheduledJob(args.jobId);
  if (!job) {
    return NextResponse.json(
      {
        ok: false,
        error: `No scheduled job called "${args.jobId}".`,
        /**
         * ⚠️ THE VALID IDS COME BACK WITH THE REFUSAL. A typo in a cron
         * body that answered a bare 400 would look identical to a
         * scheduler that had not been set up yet.
         */
        validJobIds: SCHEDULED_JOB_IDS,
      },
      { status: 400 },
    );
  }

  const onlyTenantId = typeof args.tenantId === "string" ? args.tenantId : null;
  const limit = typeof args.limit === "number" ? args.limit : undefined;

  const run = await runScheduledJob({ job, onlyTenantId, limit });

  if (!run.ok) {
    console.error(
      `[workers] scheduled job ${job.id}: ${run.tenantsFailed} failed, ${run.notReached} not reached`,
      run.error ?? run.results.filter((r) => !r.ok).slice(0, 10),
    );
  }

  return NextResponse.json(
    {
      ok: run.ok,
      authMethod: args.authMethod,
      mode: "scheduled",
      jobId: run.jobId,
      label: job.label,
      scope: run.scope,
      tenantsConsidered: run.tenantsConsidered,
      tenantsRun: run.tenantsRun,
      tenantsSkipped: run.tenantsSkipped,
      tenantsFailed: run.tenantsFailed,
      /**
       * 🔴 THE WORKSPACES THE BOUND DROPPED, AS A NUMBER. "A silent cap is
       * a lie": `truncated: true` says a cap was hit and not how far past
       * it the tail goes, so nobody knows whether to raise it by ten or by
       * ten thousand.
       */
      notReached: run.notReached,
      platformDetail: run.platformDetail ?? null,
      results: run.results,
      error: run.error ?? null,
      tookMs: Date.now() - args.startedAt,
    },
    { status: run.ok ? 200 : 500 },
  );
}

/* ------------------------------------------------------------------ */
/* THE SCHEDULER TICK                                                  */
/* ------------------------------------------------------------------ */

/**
 * One turn of the clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE STATUS CODE IS THE ALERT, AND A TICK THAT RAN OUT OF TIME IS RED
 * ══════════════════════════════════════════════════════════════════════
 * No scheduler reads JSON. Railway, a cron dashboard and a `curl -f` in a
 * runbook agree on exactly one thing: 2xx is green. `runTick` returns
 * `ok: false` when a unit failed, when a workspace was not reached, when
 * a cron string would not parse, or when the tick hit its own wall-clock
 * budget — and every one of those becomes a 500 here.
 *
 * ⚠️ THE BUDGET CASE IS THE ONE WORTH ARGUING FOR. A tick that quietly
 * ran out of time every night, reporting green, is how the last thirty
 * workspaces in the list end up never being swept — which is this
 * codebase's characteristic defect, delivered by the file written to
 * remove it.
 */
async function runSchedulerTick(args: {
  authMethod: string;
  source: string;
  claimMaintenance: boolean;
  startedAt: number;
}): Promise<NextResponse> {
  let report;
  try {
    report = await runTick({ source: args.source, claimMaintenance: args.claimMaintenance });
  } catch (err) {
    /**
     * 🔴 A THROW HERE IS ALMOST CERTAINLY THE CATALOG REFUSING TO LOAD.
     * `server/scheduler/catalog.ts` asserts on import that every
     * registered job has a policy and that both upstream registries are
     * either scheduled or explicitly declined; a violation throws, and
     * that is deliberate — see its header. Surface the message rather
     * than a bare 500, because the message names the fault.
     */
    const message = err instanceof Error ? err.message : String(err);
    console.error("[workers] scheduler tick failed to start:", message);
    return NextResponse.json(
      {
        ok: false,
        mode: "tick",
        error: message,
        hint:
          "If this names the scheduler catalog, a job was added to a registry without a " +
          "policy in server/scheduler/policy.ts, or removed while a policy still names it.",
        tookMs: Date.now() - args.startedAt,
      },
      { status: 500 },
    );
  }

  if (!report.ok) {
    console.error(
      `[workers] tick: ${report.unitsFailed} failed, ${report.tenantsNotReached} not reached, ` +
        `budgetExhausted=${report.budgetExhausted}`,
      report.errors.slice(0, 10),
    );
  }

  return NextResponse.json(
    {
      ok: report.ok,
      authMethod: args.authMethod,
      mode: "tick",
      source: args.source,
      startedAt: report.startedAt,
      budgetExhausted: report.budgetExhausted,
      expectationsDeclared: report.expectationsDeclared,
      expectationsRetired: report.expectationsRetired,
      staleReclaimed: report.staleReclaimed,
      resumedQueued: report.resumedQueued,
      unitsConsidered: report.unitsConsidered,
      unitsRun: report.unitsRun,
      unitsSkipped: report.unitsSkipped,
      unitsFailed: report.unitsFailed,
      /**
       * ⚠️ REPORTED AS A NUMBER, AND IT MAKES THE RUN RED. "A silent cap
       * is a lie" — the same property `notReached` already has on the
       * registry path, for the same reason.
       */
      tenantsNotReached: report.tenantsNotReached,
      errors: report.errors,
      /**
       * ⭐ SLOTS THIS PROCESS CLAIMED AND CANNOT RUN. The caller executes
       * them as `ordence_maintenance` and writes the outcome back onto the
       * same ledger row. Empty unless the caller asked for them.
       *
       * ⚠️ THE CALLER MUST NOT TREAT AN UNEXECUTED HANDOFF AS HARMLESS: the
       * slot is already claimed, so abandoning it means that job does not
       * run this cycle. `server/scheduler/cron-entrypoint.mjs` marks any
       * handoff it fails to execute as `failed` with the reason, rather
       * than leaving it to be reclaimed silently thirty minutes later.
       */
      maintenance: report.maintenance,
      outcomes: report.outcomes.map((o) => ({
        jobId: o.jobId,
        tenantId: o.subjectTenantId,
        slotAt: o.slotAt ? o.slotAt.toISOString() : null,
        state: o.state,
        tookMs: o.tookMs,
        error: o.error,
      })),
      tookMs: Date.now() - args.startedAt,
    },
    { status: report.ok ? 200 : 500 },
  );
}

/* ------------------------------------------------------------------ */
/* CRON SWEEP                                                          */
/* ------------------------------------------------------------------ */

/**
 * The nightly maintenance pass.
 *
 * Enqueues a contract-expiry scan for every ACTIVE tenant. It enqueues rather
 * than processing directly so that one slow tenant cannot starve the rest, and
 * so the work goes through the same retry and dead-letter machinery as
 * everything else.
 *
 * ⚠️ When no queue is bound, `enqueueJob` runs each scan INLINE, inside this
 * one cron invocation. That is acceptable at this scale (a cron invocation
 * gets 15 minutes of wall clock) and the response reports `transport` so the
 * difference is visible rather than assumed.
 */
async function runCronSweep(args: {
  authMethod: string;
  cron?: string;
  startedAt: number;
}): Promise<NextResponse> {
  /**
   * Reads across ALL tenants deliberately, with no tenant context set.
   *
   * This is one of the very few places that legitimately does so: a sweep
   * that could only see one tenant could not sweep. It reads nothing but ids
   * and slugs from the tenants table, and every job it creates is pinned to
   * exactly one tenant, which the processors re-establish under RLS.
   */
  /**
   * 🔴 `withPlatformScope`, NOT "no scope at all".
   *
   * The comment above was right that this legitimately reads across
   * every workspace. What it missed is that reading across workspaces
   * REQUIRES THE PLATFORM MARKER: with no session variable set, the
   * `tenants` policy evaluates `id = NULL OR false` and matches nothing,
   * so under a database role that does not bypass RLS this sweep would
   * process ZERO workspaces, silently, every night, forever.
   *
   * ⚠️ "CROSS-TENANT" AND "UNSCOPED" ARE NOT THE SAME THING, and I said
   * they were last session. Unscoped is not a wider view; it is no view.
   */
  const activeTenants = await withPlatformScope(
    `Scheduled sweep: list the workspaces to enqueue contract-expiry work for. The set of workspaces IS the input to this pass, so there is no one tenant whose scope could contain it`,
    (tx) =>
      tx
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(and(eq(tenants.status, "active"), isNull(tenants.deletedAt)))
      .limit(MAX_TENANTS_PER_SWEEP),
  );

  const results: Array<{ tenantId: string; queued: boolean; via?: string; error?: string }> = [];

  for (const tenant of activeTenants) {
    const enqueued = await enqueueJob({
      kind: "contract_expiry_scan",
      tenantId: tenant.id,
      correlationId: `cron:${args.cron ?? "manual"}`,
      lookaheadDays: EXPIRY_LOOKAHEAD_DAYS,
    });

    results.push(
      enqueued.queued
        ? { tenantId: tenant.id, queued: true, via: enqueued.via }
        : { tenantId: tenant.id, queued: false, error: enqueued.error ?? enqueued.reason },
    );
  }

  /*
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐ DRAIN THE MAIL OUTBOX. THE STEP THAT DID NOT EXIST.
   * ══════════════════════════════════════════════════════════════════
   * 🔴 Until this line, `credit_dunning_log` rows were written `queued`
   * and nothing ever emptied them. The screen said a reminder had been
   * recorded; the customer received nothing.
   *
   * ⚠️ IT RUNS INLINE HERE RATHER THAN AS AN ENQUEUED JOB, and that is a
   * deliberate trade. The drain is already idempotent, already claims
   * atomically, and already bounded — so the worst a duplicate sweep can
   * do is find nothing to take. Routing it through the job queue would
   * add a hop whose only failure mode is the one this whole batch is
   * about: work that is queued and never performed.
   *
   * ⚠️ A DRAIN FAILURE DOES NOT FAIL THE SWEEP. `ok` above is about
   * whether work was ENQUEUED. One tenant whose mail could not be sent
   * must not mark the nightly run red for every other tenant — the
   * per-row state carries that fact, with the reason, and the mail
   * console shows it.
   */
  let mailSent = 0;
  let mailFailed = 0;
  for (const tenant of activeTenants) {
    try {
      const drained = await dispatchTenantOutbox({ tenantId: tenant.id, limit: 50 });
      mailSent += drained.sent;
      mailFailed += drained.dead + drained.suppressed;
    } catch (err) {
      console.error(`[workers] mail outbox drain failed for ${tenant.id}`, err);
      mailFailed += 1;
    }
  }

  const failed = results.filter((r) => !r.queued);

  /* ══════════════════════════════════════════════════════════════════
   * ⭐⭐ WAVE 17 — THIS SWEEP IS NOW VISIBLE IN THE RUN LEDGER
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE PROBLEM IT SOLVES IS TWO CLOCKS, NOT TWO EXECUTIONS.
   *
   * `{"mode":"cron"}` and `{"mode":"tick"}` overlap on real work:
   * this sweep enqueues `contract_expiry_scan` for every workspace and
   * drains the mail outbox, and the tick has a `contract_expiry_scan`
   * job and a `mail_drain` job that do the same two things. Both paths
   * are documented — `docs/current/CRON-RUNBOOK.md` tells operators
   * "Keep it if you are already running it" — so a deployment may well
   * be running both.
   *
   * ⚠️ RUNNING BOTH IS SAFE AND WAS ALREADY SAFE. Each job argues its own
   * idempotency: the outbox claim is `FOR UPDATE SKIP LOCKED` with a
   * fixed key per row, and the expiry scan raises notifications that
   * coalesce on their own key. Nothing is sent twice.
   *
   * 🔴 WHAT WAS NOT SAFE IS THAT THIS PATH LEFT NO TRACE. A deployment
   * driving only `{"mode":"cron"}` would do the work every night and
   * `scheduler_overdue()` would report `mail_drain` and
   * `contract_expiry_scan` as never having run — a red watchdog on a
   * healthy system, which is the fastest way to get a watchdog ignored.
   * So the sweep now writes a ledger row.
   *
   * ⚠️ `run_kind = 'manual'` AND `slot_at = NULL`, DELIBERATELY. This
   * sweep has no declared cadence — whoever calls it decides — so it has
   * no slot to claim, and claiming one would let a legacy caller consume
   * the slot the tick was going to use and silently cancel it. A manual
   * row is never blocked and never blocks, which is exactly right for a
   * trigger nobody owns.
   */
  try {
    await recordLegacyCronSweep({
      tenantsSwept: results.length,
      failed: failed.length,
      mailSent,
      mailUndelivered: mailFailed,
      cron: args.cron ?? null,
    });
  } catch (err) {
    // Visibility is not worth failing the sweep for.
    console.warn("[workers] could not record the legacy cron sweep in the ledger:", err);
  }

  if (failed.length > 0) {
    console.error(
      `[workers] cron sweep: ${failed.length}/${results.length} tenants failed`,
      failed.slice(0, 10),
    );
  }

  return NextResponse.json(
    {
      // ⚠️ `ok` is false if ANY tenant failed. `worker.ts` throws on a non-ok
      // sweep, which marks the cron run red in the Cloudflare dashboard. A
      // partially-failed sweep that reports green is a sweep nobody fixes.
      ok: failed.length === 0,
      authMethod: args.authMethod,
      mode: "cron",
      cron: args.cron ?? null,
      transport: describeJobTransport(),
      tenantsSwept: results.length,
      failed: failed.length,
      // ⭐ Reported so "did the letters go out" is answerable from the
      // cron log alone, without opening the console.
      mailSent,
      mailUndelivered: mailFailed,
      truncated: results.length >= MAX_TENANTS_PER_SWEEP,
      /**
       * ⚠️ SAID IN THE RESPONSE, NOT ONLY IN A DOCUMENT. An operator who
       * set this up two years ago reads the JSON, not docs/SCHEDULER.md.
       */
      deprecated: true,
      replacedBy: 'POST /api/workers {"mode":"tick"}',
      deprecationNote:
        "This sweep overlaps the scheduler's contract_expiry_scan and mail_drain jobs. " +
        "Running both is safe — each job is idempotent by construction — but only the tick " +
        "records a claimed slot, so the jobs calendar and the watchdog see the tick and not " +
        "this. Move the schedule to {\"mode\":\"tick\"} and this endpoint can stop being " +
        "called. See docs/SCHEDULER.md.",
      tookMs: Date.now() - args.startedAt,
    },
    { status: failed.length === 0 ? 200 : 500 },
  );
}

/**
 * Write one ledger row so the legacy sweep shows on the jobs calendar.
 *
 * ⚠️ IT DOES NOT CLAIM A SLOT — see the block in `runCronSweep` above for
 * why a trigger with no declared cadence must not.
 */
async function recordLegacyCronSweep(detail: {
  tenantsSwept: number;
  failed: number;
  mailSent: number;
  mailUndelivered: number;
  cron: string | null;
}): Promise<void> {
  await withPlatformScope(
    "Scheduled sweep: recording that the legacy cron path ran, so the jobs calendar does not report its work as never having happened",
    (tx) =>
      tx.execute(sql`
        INSERT INTO scheduler_runs (
          job_id, lane, subject_tenant_id, slot_at, run_kind, state,
          triggered_by, justification, finished_at, started_at, outcome
        )
        VALUES (
          'legacy_cron_sweep', 'app', NULL, NULL, 'manual', ${detail.failed === 0 ? "succeeded" : "failed"},
          'legacy-cron', 
          'Legacy {"mode":"cron"} sweep, retained for compatibility with an existing external schedule. Use {"mode":"tick"} instead; see docs/SCHEDULER.md.',
          now(), now(), ${JSON.stringify(detail)}::jsonb
        )
      `),
  );
}

/* ------------------------------------------------------------------ */
/* GET — status (authenticated)                                        */
/* ------------------------------------------------------------------ */

/**
 * How background work is currently being handled.
 *
 * Deliberately reports the INLINE case as `enabled: false`, because that is
 * the honest answer to "is there a background queue?" — the work happens, but
 * it happens inside the user's request. Reporting `true` here is how an
 * operator ends up believing they have a queue they do not have.
 */
export async function GET(req: Request) {
  const auth = await authenticate("");
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  /* ---- THE DEAD MAN SWITCH ------------------------------------------
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THIS IS THE ONE ALARM THAT DOES NOT DEPEND ON OUR SCHEDULER
   * ══════════════════════════════════════════════════════════════════
   * Every other signal in this system is downstream of a run: a failed
   * workspace is counted, a tick returns 500, a red tick appears. All of
   * them require the scheduler to be alive. The failure that has actually
   * been happening in this product for years is the scheduler not
   * existing, and no run-driven signal can see it.
   *
   * So: an external uptime monitor — cron-job.org, UptimeRobot, a Railway
   * healthcheck on another service, anything that polls a URL — points at
   *
   *     GET /api/workers?watchdog=1
   *
   * 200 means every declared job has completed inside its declared
   * window and the clock is beating. 503 means it has not. Nothing about
   * that answer is computed by the thing being watched: the windows live
   * in `scheduler_job_expectations`, the evaluation is
   * `scheduler_overdue()` in SQL, and both keep working when the tick
   * stops. That is the whole point.
   *
   * ⚠️ THE QUERY PARAMETER IS WHY THIS DOES NOT BREAK ANYTHING. A bare
   * GET /api/workers answers exactly what it always did, with the same
   * keys and the same 200. `docs/current/CRON-RUNBOOK.md` documents that
   * call and `npx vitest run --project=ui` compares that document against
   * the generator; changing the bare GET's status code would have made an
   * operator's `curl -fsS` start failing on a healthy deployment, which
   * is how a check gets removed from a runbook.
   */
  if (new URL(req.url).searchParams.get("watchdog") !== null) {
    let report;
    try {
      report = await watchdogReport();
    } catch (err) {
      /**
       * 🔴 A THROW IS RED, NEVER GREEN. The likeliest cause is that
       * SQL-FILES/0129–0131 have not been applied, so the functions this
       * calls do not exist — which means there is no watchdog at all,
       * which is the worst state and must not answer 200.
       */
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          ok: false,
          headline:
            "The watchdog could not evaluate. This is NOT a pass. Most likely " +
            "SQL-FILES/0129 to 0132 have not been applied to this database, so there is " +
            "no run ledger and no expectations table to check against.",
          error: message,
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      {
        ok: report.ok,
        headline: report.headline,
        heartbeatAt: report.heartbeatAt?.toISOString() ?? null,
        heartbeatAgeSeconds: report.heartbeatAgeSeconds,
        heartbeatStale: report.heartbeatStale,
        neverRanCount: report.neverRanCount,
        overdue: report.overdue.map((j) => ({
          jobId: j.jobId,
          label: j.label,
          lane: j.lane,
          everRan: j.everRan,
          lastSuccessAt: j.lastSuccessAt?.toISOString() ?? null,
          silentSeconds: j.silentSeconds,
          maxSilenceSeconds: j.maxSilenceSeconds,
          consequence: j.consequence,
        })),
        /**
         * ⚠️ REPORTED AND NOT COUNTED. A job an operator disabled with a
         * written reason is silent on purpose and does not make this red
         * — until the pause is a month old, at which point
         * `watchdogReport` moves it into `overdue`, because a pause
         * nobody has revisited in a month is not a decision any more.
         */
        pausedSilent: report.pausedSilent.map((j) => ({
          jobId: j.jobId,
          pausedReason: j.pausedReason,
          pausedBy: j.pausedBy,
          pausedForDays: j.pausedForDays,
        })),
      },
      { status: report.ok ? 200 : 503 },
    );
  }

  return NextResponse.json({
    enabled: isQueueEnabled(),
    transport: describeJobTransport(),
    inlineFallback: isInlineFallbackEnabled(),
    /**
     * ⭐ THE SCHEDULED WORK, ENUMERABLE. An operator setting Railway up
     * can ask the deployment what it expects to be called with, rather
     * than trusting that a document in the repository still matches the
     * code. `consequenceWhenStopped` is here because a list of job ids
     * does not tell anybody which red tick to get out of bed for.
     */
    scheduledJobs: SCHEDULED_JOBS.map((j) => ({
      id: j.id,
      label: j.label,
      scope: j.scope,
      feature: j.feature,
      cronUtc: j.cronUtc,
      cadenceInIst: j.cadenceInIst,
      consequenceWhenStopped: j.consequenceWhenStopped,
      idempotency: j.idempotency,
    })),
    /**
     * ⭐ THE FULL CATALOG, WHICH IS A SUPERSET OF `scheduledJobs` ABOVE.
     *
     * `scheduledJobs` is left exactly as it was because
     * `docs/current/CRON-RUNBOOK.md` is generated from the same registry
     * and a UI test compares the two; narrowing or renaming it would make
     * an operator's `curl` disagree with their runbook.
     *
     * This key adds the jobs Wave 14 scheduled that were in no registry —
     * the contract expiry scan, the automation event purge, the two
     * platform sweeps that only ran when somebody opened a screen — and
     * the maintenance lane, which the application cannot run at all.
     */
    catalog: SCHEDULER_CATALOG.map((e) => ({
      id: e.id,
      label: e.label,
      lane: e.lane,
      scope: e.scope,
      feature: e.feature,
      cronUtc: e.cronUtc,
      cadenceInIst: e.cadenceInIst,
      overrun: e.policy.overrun,
      maxMs: e.policy.maxMs,
      backfillable: e.policy.backfillable,
      maxSilenceSeconds: e.maxSilenceSeconds,
      consequenceWhenStopped: e.consequenceWhenStopped,
    })),
    /**
     * 🔴 AND WHAT IS DORMANT AND DELIBERATELY NOT SCHEDULED, WITH THE
     * REASON. A control plane that lists only what it runs implies that
     * what it runs is everything. The six AI background workers at
     * /api/workers/ai-monitors are the case in point: they exist, they
     * are in no document, and they are ungated.
     */
    notScheduled: DORMANT_NOT_SCHEDULED.map((d) => ({
      id: d.id,
      where: d.where,
      reason: d.reason,
      owner: d.owner,
    })),
  });
}
