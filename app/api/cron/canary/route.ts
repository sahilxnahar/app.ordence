/**
 * Ordence — ⭐⭐⭐ THE CANARY ENDPOINT
 * Version: v1.45.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ══════════════════════════════════════════════════════════════════════
 * The scheduled entry point for `server/platform/canary.ts` — a synthetic
 * cross-tenant read, attempted against REAL tenant ids, on a schedule,
 * forever. Read that file's header before changing anything here; the
 * design constraint that matters lives there.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE STATUS CODE IS THE ALERT. THE BODY IS ONLY THE EXPLANATION.
 * ══════════════════════════════════════════════════════════════════════
 * Nothing downstream reads JSON. Vercel Cron, Cloudflare's dashboard, an
 * uptime monitor and a `curl | grep` in a runbook all agree on exactly
 * one thing: 2xx is green, everything else is red. So the verdict is
 * carried by the status:
 *
 *   200  pass         — a real cross-tenant read was attempted and
 *                       returned nothing, on a connection that could not
 *                       have bypassed RLS.
 *   500  breach       — 🔴 P0. It returned something.
 *   503  inconclusive — the probe could not put itself in a position to
 *                       prove anything. **NOT GREEN.**
 *
 * ⚠️ INCONCLUSIVE IS RED ON PURPOSE, AND THIS ENDPOINT IS EXPECTED TO BE
 * RED ON FIRST DEPLOY. `scripts/check-rls-writes.mjs` established, by
 * executing, that this application currently connects as a role with
 * BYPASSRLS. On such a connection the probe refuses to report a pass, so
 * this endpoint answers 503 until `DATABASE_URL` names a role that does
 * not bypass RLS (the deploy checklist names `ordence_app`).
 *
 * 🔴 THE FIX FOR THAT RED IS THE DATABASE ROLE. It is NOT to relax this
 * mapping, and it is not to add an env var that downgrades INCONCLUSIVE
 * to 200 "until we get round to it". A green tick from a connection that
 * bypasses row-level security is the worst outcome available here — it
 * is believed, and it is evidence of nothing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS PATH IS IN middleware.ts's PUBLIC LIST
 * ══════════════════════════════════════════════════════════════════════
 * Same reason as `/api/workers`: a scheduler has no browser cookie, so a
 * Clerk gate here would refuse every run and the canary would be an
 * orphan — present, correct, and never once executed. "Public" does NOT
 * mean unauthenticated: every request is checked against `CRON_SECRET`
 * in constant time below, and with no secret configured this route
 * refuses to run at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND WHY AN UNAUTHENTICATED CALLER MUST NOT REACH IT
 * ══════════════════════════════════════════════════════════════════════
 * The response names real tenant UUIDs and row counts. That is far less
 * than the probe could have read and still more than a stranger should
 * have: a list of live workspace ids, plus a running commentary on which
 * tables have row-level security enabled and which do not. That second
 * part is a map for exactly the attack this endpoint exists to detect.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { runCanaryProbe, httpStatusForVerdict } from "@/server/platform/canary";
import { recordSecurityEvent } from "@/server/security/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* AUTHENTICATION                                                      */
/* ------------------------------------------------------------------ */

type AuthResult = { ok: true; method: string } | { ok: false; status: number; reason: string };

/**
 * Constant-time comparison.
 *
 * `a === b` returns at the first differing byte, so response time leaks
 * how many leading characters were correct and an attacker recovers the
 * secret one character at a time. Copied rather than imported from
 * `app/api/workers/route.ts`, because importing across route modules
 * pulls that route's whole dependency graph — QStash, the job
 * processors, the queue bindings — into this one, and this route's value
 * is that it has almost nothing in it to break.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so a length mismatch is not trivially timeable.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * ⚠️ FAILS CLOSED. No `CRON_SECRET` means 503 and no probe, rather than
 * an open endpoint that enumerates tenant ids to anybody who finds it.
 *
 * Two shapes accepted, because two schedulers exist and neither is
 * negotiable about how it calls:
 *   `Authorization: Bearer <CRON_SECRET>`  — worker.ts, curl, anything.
 *   `x-vercel-signature` / `x-vercel-cron` — the Vercel cron path.
 */
async function authenticate(): Promise<AuthResult> {
  const headerList = await headers();
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return {
      ok: false,
      status: 503,
      reason:
        "The canary endpoint has no CRON_SECRET configured, so it refuses to run. " +
        "An unauthenticated isolation probe hands a stranger a list of live tenant ids.",
    };
  }

  const authHeader = headerList.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return safeCompare(authHeader.slice(7).trim(), cronSecret)
      ? { ok: true, method: "bearer" }
      : { ok: false, status: 401, reason: "Authentication required." };
  }

  const vercelCron = headerList.get("x-vercel-signature") ?? headerList.get("x-vercel-cron");
  if (vercelCron) {
    return safeCompare(vercelCron, cronSecret)
      ? { ok: true, method: "vercel-cron" }
      : { ok: false, status: 401, reason: "Authentication required." };
  }

  // ⚠️ One message for every failure. Telling a caller WHICH method it
  // got wrong tells it which method exists.
  return { ok: false, status: 401, reason: "Authentication required." };
}

/* ------------------------------------------------------------------ */
/* THE RUN                                                             */
/* ------------------------------------------------------------------ */

async function run(): Promise<NextResponse> {
  const auth = await authenticate();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  const result = await runCanaryProbe();

  /**
   * ⭐ THE LOG LINE IS PART OF THE ALERT, NOT DECORATION.
   *
   * A scheduler's red tick tells somebody that a thing failed. It does
   * not tell them WHICH tables, or against which workspace, and by the
   * time anybody looks, the HTTP response body is long gone. The log
   * line is the only copy of that which survives, so a breach prints the
   * whole result and an inconclusive prints the reason.
   *
   * ⚠️ It prints ids and counts, never row contents — the probe never
   * read any. See the "NEVER WRITES ANYTHING" note in `canary.ts`; the
   * same restraint applies to what it is allowed to say out loud.
   */
  if (result.verdict === "breach") {
    console.error(
      "🔴🔴 [canary] P0 CROSS-TENANT READ SUCCEEDED IN PRODUCTION:",
      JSON.stringify(result),
    );

    /**
     * ⚠️ BEST EFFORT, AND EXPLICITLY NOT THE ALARM.
     *
     * `recordSecurityEvent` writes on the module-level, unscoped `db`
     * client — which, under precisely the correctly-configured role this
     * probe is designed to run on, is refused by RLS and returns false.
     * So the durable evidence may not be written on exactly the
     * deployment where the probe is capable of proving anything. That is
     * an irony, not a defect in this route: the alarm is the 500 above,
     * which reaches a scheduler that does not depend on this database at
     * all. The row is a bonus for the platform observatory when it
     * happens to work.
     *
     * It never throws (documented in `server/security/record.ts`), so a
     * failure here cannot turn a P0 into a 500-with-a-stack-trace that
     * hides the P0.
     */
    await recordSecurityEvent({
      type: "tenant.cross_access_attempt",
      severity: "critical",
      source: "api/cron/canary",
      reason: result.headline,
      detail: {
        probe: "canary",
        syntheticTenantId: result.syntheticTenantId,
        currentUser: result.connection?.currentUser ?? null,
        breachedTables: result.targets.filter((t) => t.verdict === "breach").map((t) => t.table),
      },
    });
  } else if (result.verdict === "inconclusive") {
    console.warn("⚠️  [canary] proved nothing this run:", result.headline);
  }

  return NextResponse.json(
    {
      ok: result.verdict === "pass",
      verdict: result.verdict,
      headline: result.headline,
      authMethod: auth.method,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      tookMs: result.tookMs,
      syntheticTenantId: result.syntheticTenantId,
      connection: result.connection,
      provenTargets: result.provenTargets,
      inconclusiveTargets: result.inconclusiveTargets,
      targets: result.targets,
    },
    { status: httpStatusForVerdict(result.verdict) },
  );
}

/**
 * ⚠️ BOTH VERBS, BECAUSE SCHEDULERS DISAGREE AND A CANARY THAT ONLY
 * ANSWERS ONE OF THEM IS A CANARY THAT SILENTLY NEVER RAN.
 *
 * Vercel Cron issues GET. `worker.ts` and every `curl` in a runbook send
 * POST. Neither is worth arguing with, and the handler is identical
 * because the probe takes no input at all — there is nothing a request
 * body could usefully say to it, and giving it one would be an
 * opportunity to point the probe somewhere harmless.
 */
export async function GET() {
  return run();
}

export async function POST() {
  return run();
}
