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
import { eq, and, isNull } from "drizzle-orm";
import { Receiver } from "@upstash/qstash";
import { db } from "@/db";
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

  let parsed: { job?: unknown; mode?: string; cron?: string };
  try {
    parsed = rawBody ? (JSON.parse(rawBody) as typeof parsed) : {};
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  /* ---- CRON SWEEP -------------------------------------------------- */
  if (parsed.mode === "cron") {
    return runCronSweep({ authMethod: auth.method, cron: parsed.cron, startedAt });
  }

  /* ---- ONE JOB ----------------------------------------------------- */
  if (parsed.job !== undefined) {
    return runOneJob({ payload: parsed.job, authMethod: auth.method, startedAt });
  }

  return NextResponse.json(
    {
      error:
        'Nothing to do. Send {"job": {...}} to process a job, or {"mode":"cron"} to run the sweep.',
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
  const activeTenants = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(and(eq(tenants.status, "active"), isNull(tenants.deletedAt)))
    .limit(MAX_TENANTS_PER_SWEEP);

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

  const failed = results.filter((r) => !r.queued);

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
      truncated: results.length >= MAX_TENANTS_PER_SWEEP,
      tookMs: Date.now() - args.startedAt,
    },
    { status: failed.length === 0 ? 200 : 500 },
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
export async function GET() {
  const auth = await authenticate("");
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  return NextResponse.json({
    enabled: isQueueEnabled(),
    transport: describeJobTransport(),
    inlineFallback: isInlineFallbackEnabled(),
  });
}
