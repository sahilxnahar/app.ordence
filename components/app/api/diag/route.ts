import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { ENV_CATEGORIES as CATEGORIES } from "@/lib/platform/env-catalog";
import { interpretRlsPosture } from "@/lib/platform/rls-posture";
import { checkRateLimit, ipRateLimitKey } from "@/lib/security/rate-limit";

/**
 * Ordence — Deployment diagnostic
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * A Cloudflare Worker that throws during middleware returns a blank 500 on
 * every url — the home page, the health check, even a file that does not
 * exist. From outside there is no way to tell "a setting is missing" from
 * "the database is unreachable" from "the code is broken". Diagnosing it
 * meant guessing, deploying, and waiting ten minutes to find out.
 *
 * This route answers the question directly.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IT DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It never returns the VALUE of anything. Only whether each setting is
 * visible to the running Worker, and how long each name is — enough to
 * catch a truncated paste, useless to anyone trying to steal a key.
 *
 * It is reachable without signing in, and it has to be: the failure it
 * diagnoses is one where signing in is precisely what does not work.
 */
export const dynamic = "force-dynamic";

function readRuntimeEnv(name: string): string | undefined {
  // ⚠️ Bracket lookup, not `process.env.NAME`. See middleware.ts — a literal
  // would be replaced at build time with the build machine's (empty) value.
  try {
    const bag = process.env as unknown as Record<string, string | undefined>;
    const value = bag?.[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ⭐ THE CATEGORY TABLE MOVED TO `lib/platform/env-catalog.ts` — Batch 127.
 *
 * 🔴 IT MOVED BECAUSE A `route.ts` MAY EXPORT NOTHING BUT HTTP VERBS.
 * `app/platform/secrets` needs this exact list of names, and the only
 * other way to give it one was a second hand-typed copy — the drift
 * that produced migration 0091. Nothing about this response changed:
 * the array is the same array, in the same order, including the
 * duplicated R2 entry.
 */
// (the import itself is at the top of the file, where imports belong)

/** Flattened arrays kept for backward compatibility with the response shape. */
const REQUIRED = CATEGORIES.flatMap((c) => c.required);
const OPTIONAL = CATEGORIES.flatMap((c) => c.optional);

/**
 * ⭐⭐⭐ WAVE 9 — THE ONE EDGE-EXEMPT ROUTE WITH NOTHING IN FRONT OF IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS ROUTE, AND WHY IT HAD NO LIMIT AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * `lib/edge/budgets.ts` exempts `/api/diag` from the per-plan ceiling,
 * correctly: this response belongs to no workspace, so counting it
 * against one makes no sense. But the exemption list also covers health
 * and readiness (cheap, static), webhooks (own limiter) and cron and
 * workers (shared secret). Diag was the only member with NONE of those:
 * no session, no secret, no limiter, and a body that enumerates every
 * configuration name the deployment knows and whether each is set.
 *
 * That is a reconnaissance surface. Polled, it reports the exact moment a
 * secret rotation lands and which optional integrations are configured,
 * to anybody, for free.
 *
 * ⚠️ IP-KEYED, NOT TENANT-KEYED. There is no tenant here by construction.
 *
 * ⚠️ A LIMITER FAILURE ALLOWS THE REQUEST, WHICH IS THE OPPOSITE OF THIS
 * CODEBASE'S DEFAULT. Every other limit in the product fails closed, and
 * that is right for every other limit. This route exists to answer "what
 * is broken?" during an outage — and an outage is precisely when the
 * limiter's own backend is a candidate. A diag endpoint that returns 500
 * because the rate limiter is unwell has failed at the one job it has.
 * The cost of failing open here is bounded: the body carries no values,
 * no session and no tenant data.
 */
async function diagLimitAllows(): Promise<boolean> {
  try {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
    const decision = await checkRateLimit("api", ipRateLimitKey(ip));
    return decision.allowed;
  } catch {
    return true;
  }
}

export async function GET() {
  if (!(await diagLimitAllows())) {
    /**
     * ⚠️ A PLAIN 429 WITH NO BODY DETAIL. Everything this route would
     * otherwise say is the thing being rate-limited; saying a fraction of
     * it in the refusal would defeat the refusal.
     */
    return NextResponse.json(
      { error: "Too many diagnostic requests. Try again shortly." },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 PRESENCE ONLY. THE LENGTH FIELD IS GONE.
   * ══════════════════════════════════════════════════════════════════
   * This route is public, and it returned `{ present, length }` for all
   * 47 names — including `CLERK_SECRET_KEY`, `RAZORPAY_KEY_SECRET`,
   * `WORKER_API_SECRET` and `S3_SECRET_ACCESS_KEY`. The header a few
   * lines up claims "It never returns the VALUE of anything", which was
   * true and beside the point: an exact character count is a
   * truncated-paste oracle and a fingerprint of which key format is in
   * use, handed to anybody who asks.
   *
   * ⚠️ THE BOOLEAN IS THE WHOLE JOB. Every question this endpoint
   * exists to answer — is it set, did it reach the running server, is
   * the required list satisfied — is answered by presence.
   */
  const settings: Record<string, { present: boolean }> = {};

  for (const name of [...REQUIRED, ...OPTIONAL]) {
    settings[name] = { present: readRuntimeEnv(name) !== undefined };
  }

  const missing = REQUIRED.filter((name) => !settings[name]?.present);

  // Build a per-category summary for the response.
  const categories = CATEGORIES.map((cat) => {
    const all = [...cat.required, ...cat.optional];
    const present = all.filter((n) => settings[n]?.present).length;
    const requiredMissing = cat.required.filter((n) => !settings[n]?.present);
    return {
      name: cat.name,
      description: cat.description,
      total: all.length,
      present,
      requiredMissing,
      vars: Object.fromEntries(all.map((n) => [n, settings[n] ?? { present: false }])),
    };
  });

  // AI providers: check if at least one is configured.
  const aiProviderKeys = ["CLOUDFLARE_ACCOUNT_ID", "CF_AI_TOKEN", "GROQ_API_KEY", "CEREBRAS_API_KEY", "GOOGLE_AI_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY", "GITHUB_MODELS_TOKEN"];
  const aiConfigured = aiProviderKeys.some((k) => settings[k]?.present);
  const storageKeys = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
  const storageConfigured = storageKeys.every((k) => settings[k]?.present);

  /* ── Can the Worker actually reach the database? ──────────────────────
   *
   * Answered with a query that touches no application table, so it works
   * on an empty database and cannot fail for a reason other than the one
   * being tested. The table count comes back too — 0 means the schema was
   * never created, which is a completely different problem from a bad
   * password and used to look identical from outside.
   */
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE INFRASTRUCTURE PROBES ARE STAFF-ONLY NOW
   * ══════════════════════════════════════════════════════════════════
   * They told an anonymous caller the Postgres role name (so, whether
   * the app runs as `ordence_app` or as the BYPASSRLS owner), how many
   * tables and policies exist, and on failure the RAW DRIVER MESSAGE —
   * which the sibling `/api/ready` deliberately reduces to a SQLSTATE,
   * with a comment saying a driver error can carry the connection
   * string and this endpoint is unauthenticated.
   *
   * Worse than the disclosure: each probe opened a fresh Neon HTTP
   * connection AND a WebSocket pool with a real transaction, on every
   * request, with no rate limit. An unauthenticated loop exhausts the
   * connection budget and takes the product down.
   *
   * ⭐ THE TWO-KEY REPORT STAYS PUBLIC. It is the state this endpoint
   * exists to explain, it answers only about the caller's own account,
   * and it says nothing at all to somebody who is not signed in.
   */
  const operator = await (async () => {
    try {
      const { getPlatformOperator } = await import("@/server/platform/guard");
      return await getPlatformOperator();
    } catch {
      return null;
    }
  })();

  let database: Record<string, unknown> = operator
    ? { attempted: false }
    : { attempted: false, withheld: "Sign in as platform staff to run this probe." };

  if (operator && settings.DATABASE_URL?.present) {
    try {
      const { neon } = await import("@neondatabase/serverless");
      const sql = neon(readRuntimeEnv("DATABASE_URL") as string);
      /**
       * ⭐ `rolbypassrls` AND `rolsuper` ARE ON THIS QUERY DELIBERATELY.
       *
       * This route already reported `current_user`, and a role NAME is not
       * the fact that matters. Tenant isolation in this product IS
       * row-level security, and a role with `rolbypassrls` skips every one
       * of the FORCE ROW LEVEL SECURITY policies while `check:rls` keeps
       * passing, because that gate reads pg_catalog and the catalog is
       * still correct. On Neon the default owner `neondb_owner` HAS
       * `rolbypassrls`.
       *
       * 🔴 WHICH ROLE `DATABASE_URL` AUTHENTICATES AS DECIDED WHETHER
       *    ISOLATION WAS ENFORCED BY THE DATABASE OR RESTING ENTIRELY ON
       *    THE APPLICATION, AND NOTHING IN THE PRODUCT COULD SEE IT. It
       *    took ten sessions and a hand-written catalog query to answer,
       *    and every signal was green throughout.
       *
       * The answer today is the good one. This exists so that if it ever
       * silently changes , a new environment, a debugging session, someone
       * pasting the owner URL into Railway , an operator finds out from
       * the product rather than from an incident.
       *
       * ⚠️ ADVISORY, NEVER FATAL. Refusing to boot on a database condition
       *    means a Neon blip takes the product down, which is a worse
       *    failure than a posture nobody can see.
       */
      const rows = (await sql`
        SELECT current_user AS role,
               (SELECT COALESCE(r.rolbypassrls, false)
                  FROM pg_roles r WHERE r.rolname = current_user) AS bypasses_rls,
               (SELECT COALESCE(r.rolsuper, false)
                  FROM pg_roles r WHERE r.rolname = current_user) AS is_superuser,
               (SELECT count(*) FROM information_schema.tables
                 WHERE table_schema = 'public') AS tables,
               (SELECT count(*) FROM pg_policies
                 WHERE schemaname = 'public') AS policies
      `) as Array<{
        role: string;
        bypasses_rls: boolean;
        is_superuser: boolean;
        tables: number;
        policies: number;
      }>;

      const row = rows[0];
      const posture = interpretRlsPosture(
        row
          ? {
              role: row.role,
              bypassesRls: row.bypasses_rls === true,
              isSuperuser: row.is_superuser === true,
            }
          : null,
      );

      database = {
        attempted: true,
        connected: true,
        role: row?.role ?? null,
        tables: Number(row?.tables ?? 0),
        policies: Number(row?.policies ?? 0),
        rls: {
          level: posture.level,
          label: posture.label,
          detail: posture.detail,
          remedy: posture.remedy,
        },
      };
    } catch (error) {
      database = {
        attempted: true,
        connected: false,
        /**
         * ⚠️ THE CODE, NOT THE MESSAGE. The old comment argued the
         * driver's text "contains no credentials" — which is true of
         * the errors anyone thought to test, and not a property the
         * driver guarantees. `/api/ready` already made the opposite
         * call for the same reason. A SQLSTATE plus the error name is
         * enough to tell wrong-password from no-such-host.
         */
        code: (error as { code?: string })?.code ?? null,
        name: error instanceof Error ? error.name : "unknown",
      };
    }
  }

  /* ── Can the Worker open a real TRANSACTION? ──────────────────────────
   *
   * ⚠️ A DIFFERENT CODE PATH FROM THE CHECK ABOVE, AND THE ONE THAT
   * ACTUALLY MATTERS.
   *
   * `neon()` speaks HTTP: one request, one query, no transaction. Every
   * signed-in page instead goes through `withTenant()`, which uses `Pool`
   * — a WebSocket connection — because pinning `app.current_tenant_id`
   * transaction-locally is the entire mechanism row-level security relies
   * on. A `SET` outside a transaction would leak to the next borrower of a
   * pooled connection.
   *
   * The two paths fail independently. The Clerk webhook uses HTTP and
   * worked on the first attempt; the dashboard uses WebSocket and threw a
   * server-side exception. Testing only the HTTP path reported a healthy
   * deployment while every page a user can reach was broken — which is
   * exactly what happened, and why this block exists.
   *
   * Cloudflare Workers have no `new WebSocket()` constructor; the driver
   * falls back to `fetch(url, {headers: {Upgrade: "websocket"}})`. Whether
   * that fallback survives the `global_fetch_strictly_public` compatibility
   * flag is the open question this answers.
   */
  let transaction: Record<string, unknown> = operator
    ? { attempted: false }
    : { attempted: false, withheld: "Sign in as platform staff to run this probe." };

  if (operator && settings.DATABASE_URL?.present) {
    try {
      const { Pool } = await import("@neondatabase/serverless");
      const pool = new Pool({ connectionString: readRuntimeEnv("DATABASE_URL") as string });
      try {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // The exact call `withTenant()` makes. A zero UUID is used so the
          // probe cannot read any real tenant's rows even by accident.
          await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
            "00000000-0000-4000-8000-000000000000",
          ]);
          const read = await client.query(
            "SELECT current_setting('app.current_tenant_id', true) AS pinned",
          );
          await client.query("COMMIT");
          transaction = {
            attempted: true,
            ok: true,
            pinned: read.rows[0]?.pinned ?? null,
            note: "WebSocket transaction works. Row-level security can be enforced.",
          };
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    } catch (error) {
      transaction = {
        attempted: true,
        ok: false,
        code: (error as { code?: string })?.code ?? null,
        name: error instanceof Error ? error.name : "unknown",
        note: "Transactions do NOT work in this runtime. Every signed-in page will fail.",
      };
    }
  }

  /* ── ⭐ WHY IS admin.ordence.com STILL 404? — v0.55.0 ────────────────
   *
   * ══════════════════════════════════════════════════════════════════
   * WRITTEN AFTER FOUR WRONG GUESSES. THIS IS THE POINT.
   * ══════════════════════════════════════════════════════════════════
   * `getPlatformOperator()` needs TWO keys and returns `null` if either
   * is missing — deliberately, and deliberately without saying which.
   * That is right for a stranger and useless for the operator trying to
   * get in, so every attempt to diagnose it from outside was a guess:
   * the allowlist, the email case, the Clerk instance, the staff row.
   * Each guess cost a deploy and a round trip.
   *
   * This reports the two keys SEPARATELY. It answers, for the person
   * currently signed in:
   *
   *   • is PLATFORM_ADMIN_EMAILS visible to the running Worker, and how
   *     many addresses did it parse into?          ← the build-inlining trap
   *   • did Clerk give us a VERIFIED primary email?
   *   • is that email in the allowlist?
   *   • does a staff row exist for this Clerk id, read through the
   *     SAME `withPlatformScope` path the console uses — so row-level
   *     security is exercised, not bypassed?
   *
   * ⚠️ NO EMAIL ADDRESSES, NO IDS, NO ALLOWLIST CONTENTS. Booleans and
   * counts only, and it says nothing at all to a caller who is not
   * signed in. Reachable without staff access because that is precisely
   * the state it exists to explain.
   */
  let platform: Record<string, unknown> = { signedIn: false };

  try {
    const { auth, currentUser } = await import("@clerk/nextjs/server");
    const { userId } = await auth();

    if (userId) {
      const user = await currentUser();
      const primary = user?.emailAddresses.find(
        (e) => e.id === user.primaryEmailAddressId,
      );
      const emailVerified = primary?.verification?.status === "verified";
      const email = emailVerified ? (primary?.emailAddress ?? null) : null;

      const { parseAdminAllowlist, isAllowlisted } = await import(
        "@/lib/platform/roles"
      );
      const raw = readRuntimeEnv("PLATFORM_ADMIN_EMAILS");
      const allowlist = parseAdminAllowlist(raw);

      // KEY 2, through the real path. A plain query here would prove
      // nothing: the console reads under `withPlatformScope`, and RLS is
      // the whole reason that wrapper exists.
      let staffRow: Record<string, unknown> = { attempted: false };
      try {
        const { withPlatformScope } = await import("@/db");
        const { platformStaff } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");

        const row = await withPlatformScope(
          "Diagnostic: confirm platform staff visibility under row-level security",
          async (tx) =>
            tx
              .select()
              .from(platformStaff)
              .where(eq(platformStaff.clerkUserId, userId))
              .limit(1)
              .then((rows) => rows[0] ?? null),
        );

        staffRow = row
          ? {
              attempted: true,
              found: true,
              grade: row.grade,
              status: row.status,
              expired:
                row.expiresAt !== null && row.expiresAt.getTime() <= Date.now(),
              revoked: row.revokedAt !== null,
            }
          : {
              attempted: true,
              found: false,
              note:
                "No row visible for this Clerk user id. Either none exists, " +
                "or row-level security is hiding it from this connection.",
            };
      } catch (error) {
        /**
         * ⚠️ SAME RULE AS THE PROBES ABOVE. This block is reachable by
         * any signed-in user of any tenant, and a Drizzle or driver
         * error raised while reading `platform_staff` under
         * `withPlatformScope` has no business being echoed to them.
         */
        staffRow = {
          attempted: true,
          found: false,
          code: (error as { code?: string })?.code ?? null,
          name: error instanceof Error ? error.name : "unknown",
        };
      }

      const allowlisted = isAllowlisted(email, allowlist);

      platform = {
        signedIn: true,
        key1_allowlist: {
          settingVisibleToWorker: raw !== undefined,
          addressesParsed: allowlist.size,
          clerkGaveUsAnEmail: primary !== undefined,
          emailVerified,
          allowlisted,
        },
        key2_staffRecord: staffRow,
        verdict:
          allowlisted && staffRow.found === true
            ? "✅ Both keys present. The console should open."
            : !allowlisted && staffRow.found !== true
              ? "🔴 BOTH keys failed. Read each block above."
              : !allowlisted
                ? "🔴 KEY 1 failed — the email allowlist. The staff row is fine."
                : "🔴 KEY 2 failed — the staff record. The allowlist is fine.",
      };
    }
  } catch (error) {
    platform = {
      signedIn: false,
      code: (error as { code?: string })?.code ?? null,
      name: error instanceof Error ? error.name : "unknown",
    };
  }

  const ok =
    missing.length === 0 && database.connected === true && transaction.ok === true;

  return NextResponse.json(
    {
      ok,
      reachedTheApplication: true,
      /**
       * ⚠️ FALLS BACK TO THE COMMIT SHA — v0.95.0.
       *
       * This read `"unset"` in production for every release, because
       * `NEXT_PUBLIC_RELEASE` was never set and nothing else was tried.
       * Railway injects `RAILWAY_GIT_COMMIT_SHA` on every deploy, so this
       * now answers "which build is serving me" with no variable to
       * configure — and it is the same string Sentry uses as its release,
       * so a diag output and a Sentry issue name the same commit.
       */
      version:
        readRuntimeEnv("NEXT_PUBLIC_RELEASE") ||
        readRuntimeEnv("RAILWAY_GIT_COMMIT_SHA") ||
        "unset",
      missingRequiredSettings: missing,
      settings,
      categories,
      features: {
        aiAssistant: aiConfigured
          ? "enabled"
          : "disabled — set at least one AI provider key (GROQ_API_KEY, CF_AI_TOKEN, etc.)",
        documentStorage: storageConfigured
          ? "enabled"
          : "disabled — set all four S3_* variables",
        email: settings.RESEND_API_KEY?.present ? "enabled" : "disabled",
        payments:
          settings.RAZORPAY_KEY_ID?.present || settings.STRIPE_SECRET_KEY?.present
            ? "enabled"
            : "disabled",
        cache: settings.UPSTASH_REDIS_REST_URL?.present ? "enabled" : "disabled",
        workers: settings.WORKER_API_SECRET?.present ? "enabled" : "disabled",
      },
      database,
      transaction,
      platform,
      hint: ok
        ? "Everything the application needs is present. Check `features` for optional capabilities."
        : missing.length > 0
          ? `Add these in Railway → Variables, then redeploy: ${missing.join(", ")}`
          : database.connected !== true
            ? "Settings are present but the database refused the connection. Read database.error above."
            : "Simple queries work but TRANSACTIONS do not. Read transaction.error — this is why signed-in pages fail while the webhook succeeds.",
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
