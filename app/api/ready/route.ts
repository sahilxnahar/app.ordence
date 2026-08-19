import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_VERSION } from "@/lib/version";

/**
 * Ordence — ⭐ READINESS PROBE
 * Version: v0.90.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS, AND WHY `/api/health` COULD NOT DO IT
 * ══════════════════════════════════════════════════════════════════════
 * On 12 August 2026 this application was down for roughly twelve hours.
 * Neon's password had been rotated and Railway never got the new one, so
 * every request touching the database failed with `28P01: password
 * authentication failed for user "ordence_app"`.
 *
 * ⚠️ `/api/health` STAYED GREEN THROUGHOUT. It returns a hard-coded JSON
 * body and touches nothing. Railway's healthcheck was satisfied, the
 * container was never restarted, no alert could have fired — and the
 * outage was found by a person clicking around.
 *
 * ⭐ A PROBE THAT DOES NOT TOUCH THE DEPENDENCY IT VOUCHES FOR IS WORSE
 *    THAN NO PROBE. It does not merely fail to detect an outage; it
 *    actively reports health during one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * LIVENESS AND READINESS ARE DIFFERENT QUESTIONS
 * ══════════════════════════════════════════════════════════════════════
 * `/api/health`  — "is this process alive?"  → keep it as the container
 *                  healthcheck. Restarting on a database blip would turn
 *                  a Neon hiccup into a restart loop, which is strictly
 *                  worse than serving errors.
 * `/api/ready`   — "can this process do its job?" → this file. Point the
 *                  UPTIME MONITOR here.
 *
 * ⚠️ DO NOT SET THIS AS `healthcheckPath` IN `railway.json`. Railway
 * restarts a container that fails its healthcheck; a database outage
 * would then produce an endless restart loop and destroy the logs that
 * explain it.
 */

export const dynamic = "force-dynamic";

/**
 * ⚠️ THE QUERY IS `SELECT 1`, NOT A TABLE READ.
 *
 * It proves the connection, the credentials and the pooler — the entire
 * failure mode of 12 August — without depending on any table's
 * existence, any row-level security policy, or a tenant context that a
 * probe has no session to establish.
 */
async function checkDatabase(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    /**
     * ⚠️ THE CODE, NOT THE MESSAGE. A driver error can carry the
     * connection string, and this endpoint is unauthenticated. `28P01`
     * tells an operator exactly what happened; the full message could
     * tell a stranger the host and the user.
     */
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "unknown";
    return { ok: false, ms: Date.now() - started, error: code };
  }
}

export async function GET() {
  const database = await checkDatabase();
  const ok = database.ok;

  return NextResponse.json(
    {
      status: ok ? "ready" : "degraded",
      version: APP_VERSION,
      /**
       * ⭐ The commit, so an alert can name the release that broke.
       * Railway injects `RAILWAY_GIT_COMMIT_SHA` on every deploy, so this
       * is populated with no variable to set.
       */
      release: process.env.NEXT_PUBLIC_RELEASE ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      checks: { database },
      timestamp: new Date().toISOString(),
    },
    {
      /**
       * ⚠️ 503, NOT 200-WITH-A-FLAG. Every uptime monitor understands a
       * status code; almost none parse a JSON body by default. A probe
       * returning 200 while saying `"degraded"` inside gets configured
       * once, believed, and never fires.
       */
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
