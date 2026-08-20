/**
 * Ordence — AI Monitors API Route
 * Version: v0.77.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ══════════════════════════════════════════════════════════════════════
 * The cron-triggered endpoint that runs the 6 background intelligence
 * workers. Called by Railway's cron scheduler (or any external cron)
 * with a bearer secret.
 *
 * Supports two modes:
 *
 *   { "mode": "sweep" }           Run all workers for all active tenants
 *   { "tenantId": "...", "workerId": "..." }  Run one worker for one tenant
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AUTHENTICATION
 * ══════════════════════════════════════════════════════════════════════
 * Same pattern as /api/workers — bearer secret via WORKER_API_SECRET.
 * No secret configured → 503 (refuses to run).
 */

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import { BACKGROUND_WORKERS, runAllWorkers, runWorker } from "@/server/ai/background-workers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TENANTS_PER_SWEEP = 100;

/* ------------------------------------------------------------------ */
/* AUTH                                                                */
/* ------------------------------------------------------------------ */

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function authenticate(): Promise<boolean> {
  const secret = process.env.WORKER_API_SECRET;
  if (!secret) return false;

  const headerList = await headers();
  const authHeader = headerList.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  return safeCompare(authHeader.slice(7).trim(), secret);
}

/* ------------------------------------------------------------------ */
/* POST                                                                */
/* ------------------------------------------------------------------ */

export async function POST(req: NextRequest) {
  const authed = await authenticate();
  if (!authed) {
    return NextResponse.json(
      { error: "Authentication required. Set WORKER_API_SECRET and send it as a Bearer token." },
      { status: 401 },
    );
  }

  let body: { mode?: string; tenantId?: string; workerId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  /* ---- SINGLE WORKER FOR ONE TENANT ---- */
  if (body.tenantId && body.workerId) {
    const result = await runWorker(body.workerId, body.tenantId);
    if (!result) {
      return NextResponse.json(
        { error: `No worker called "${body.workerId}".` },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  }

  /* ---- SINGLE TENANT, ALL WORKERS ---- */
  if (body.tenantId && !body.workerId) {
    const results = await runAllWorkers(body.tenantId);
    return NextResponse.json({
      tenantId: body.tenantId,
      workers: results.length,
      alerts: results.reduce((sum, r) => sum + r.alertCount, 0),
      results,
    });
  }

  /* ---- SWEEP: ALL TENANTS, ALL WORKERS ---- */
  if (body.mode === "sweep") {
    const startedAt = Date.now();

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
      `Scheduled sweep: list the workspaces to run every AI monitor for. The set of workspaces IS the input to this pass, so there is no one tenant whose scope could contain it`,
      (tx) =>
        tx
        .select({ id: tenants.id, slug: tenants.slug })
        .from(tenants)
        .where(and(eq(tenants.status, "active"), isNull(tenants.deletedAt)))
        /**
         * ⚠️ ONE MORE THAN THE CAP, ON PURPOSE, so the tail is COUNTABLE
         * rather than merely flagged. Selecting exactly the cap cannot
         * tell "there were 100" from "there were 6,000", and `truncated:
         * true` with no number leaves an operator no way to know whether
         * to raise the cap by ten or by ten thousand.
         */
        .limit(MAX_TENANTS_PER_SWEEP + 1),
    );

    const sweepTenants = activeTenants.slice(0, MAX_TENANTS_PER_SWEEP);
    const notReached = activeTenants.length - sweepTenants.length;

    const allResults: Array<{
      tenantId: string;
      workers: number;
      alerts: number;
      errors: number;
    }> = [];

    for (const tenant of sweepTenants) {
      const results = await runAllWorkers(tenant.id);
      allResults.push({
        tenantId: tenant.id,
        workers: results.length,
        alerts: results.reduce((sum, r) => sum + r.alertCount, 0),
        errors: results.filter((r) => !r.ok).length,
      });
    }

    const totalErrors = allResults.reduce((s, r) => s + r.errors, 0);
    const truncated = notReached > 0;

    /**
     * ══════════════════════════════════════════════════════════════
     * 🔴 `ok: true` WAS HARDCODED, AND THE STATUS WAS ALWAYS 200 — v1.66.0
     * ══════════════════════════════════════════════════════════════
     * This response counted `totalErrors` and then reported success
     * regardless of it, so a sweep in which every worker failed for every
     * workspace answered `{"ok":true}` with HTTP 200. A cron dashboard,
     * an uptime monitor and a `curl -f` all read that as green. The
     * number was right there in the body and nothing acted on it.
     *
     * ⚠️ AND `truncated` HAD THE SAME PROBLEM. It said a cap was hit and
     * left `ok` true, so "we ran the monitors" and "we ran the monitors
     * for the first hundred workspaces of six hundred" were the same
     * answer. A silent cap is a lie. `notReached` is now a number, so an
     * operator knows whether to raise the cap by ten or by ten thousand.
     *
     * `app/api/workers/route.ts` already had this property for the cron
     * sweep; this route is the same shape and did not.
     */
    const ok = totalErrors === 0 && !truncated;

    return NextResponse.json(
      {
        ok,
        tenantsSwept: allResults.length,
        totalAlerts: allResults.reduce((s, r) => s + r.alerts, 0),
        totalErrors,
        truncated,
        notReached,
        tookMs: Date.now() - startedAt,
        perTenant: allResults,
      },
      { status: ok ? 200 : 500 },
    );
  }

  return NextResponse.json(
    {
      error:
        'Send {"mode":"sweep"} to run all workers for all tenants, ' +
        'or {"tenantId":"...","workerId":"..."} to run one worker for one tenant.',
    },
    { status: 400 },
  );
}

/* ------------------------------------------------------------------ */
/* GET — list available workers (authenticated)                       */
/* ------------------------------------------------------------------ */

export async function GET() {
  const authed = await authenticate();
  if (!authed) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  return NextResponse.json({
    workers: BACKGROUND_WORKERS.map((w) => ({
      id: w.id,
      label: w.label,
      description: w.description,
      cadence: w.cadence,
    })),
  });
}
