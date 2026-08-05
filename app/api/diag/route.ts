import { NextResponse } from "next/server";

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
 * ⚠️ REQUIRED means "the app is broken without it", not "somebody meant to
 * set it". Every name here is read on a path a signed-in user reaches.
 *
 * The webhook secret is in this list deliberately. Without it the Clerk
 * webhook cannot be verified, so no tenant is ever provisioned — and
 * nothing about the running app looks wrong until the first sign-up.
 */
const REQUIRED = [
  // Database — the pooled string serves requests, the unpooled one runs
  // migrations. Both are Secrets in Cloudflare, never in wrangler.jsonc.
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",

  // Authentication.
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",

  // Host resolution. Losing either of these does not throw — it just makes
  // admin.ordence.com stop being the staff console and every tenant
  // subdomain stop resolving, which reads as a code bug and is not one.
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_ROOT_DOMAIN",
  "NEXT_PUBLIC_ZONE_DOMAIN",
  "PLATFORM_HOST",
  "PLATFORM_ADMIN_EMAILS",
] as const;

/**
 * OPTIONAL means a named feature is inert without it, and the rest of the
 * app is unaffected. `present: false` here is information, not a fault.
 */
const OPTIONAL = [
  // Signed URLs and scheduled work. Absent = uploads and cron refuse.
  "UPLOAD_TICKET_SECRET",
  "CRON_SECRET",
  "WORKER_API_SECRET",
  /* ---- v0.73.0-alpha: were read by the code and reported by nothing ---- */
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  // ⚠️ Guards seeding against production. Nothing verified its state.
  "SEED_ALLOW_PROD",
  "NEXT_PUBLIC_RELEASE",
  // Unset means the CSP is report-only, which is the current state.
  "CSP_ENFORCE",

  // Background jobs run inline until a queue is bound.
  "ORDENCE_INLINE_JOBS",

  // Email.
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",

  // Billing.
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",

  // Our own tax identity, printed on platform invoices.
  "PLATFORM_LEGAL_NAME",
  "PLATFORM_GSTIN",
  "PLATFORM_GST_STATE_CODE",
  "PLATFORM_ADDRESS",
  "PLATFORM_INVOICE_PREFIX",

  // Cache and rate limiting.
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

export async function GET() {
  const settings: Record<string, { present: boolean; length: number }> = {};

  for (const name of [...REQUIRED, ...OPTIONAL]) {
    const value = readRuntimeEnv(name);
    settings[name] = { present: value !== undefined, length: value?.length ?? 0 };
  }

  const missing = REQUIRED.filter((name) => !settings[name]?.present);

  /* ── Can the Worker actually reach the database? ──────────────────────
   *
   * Answered with a query that touches no application table, so it works
   * on an empty database and cannot fail for a reason other than the one
   * being tested. The table count comes back too — 0 means the schema was
   * never created, which is a completely different problem from a bad
   * password and used to look identical from outside.
   */
  let database: Record<string, unknown> = { attempted: false };

  if (settings.DATABASE_URL?.present) {
    try {
      const { neon } = await import("@neondatabase/serverless");
      const sql = neon(readRuntimeEnv("DATABASE_URL") as string);
      const rows = (await sql`
        SELECT current_user AS role,
               (SELECT count(*) FROM information_schema.tables
                 WHERE table_schema = 'public') AS tables,
               (SELECT count(*) FROM pg_policies
                 WHERE schemaname = 'public') AS policies
      `) as Array<{ role: string; tables: number; policies: number }>;

      const row = rows[0];
      database = {
        attempted: true,
        connected: true,
        role: row?.role ?? null,
        tables: Number(row?.tables ?? 0),
        policies: Number(row?.policies ?? 0),
      };
    } catch (error) {
      database = {
        attempted: true,
        connected: false,
        // The driver's message names the fault — wrong password, no such
        // host, refused connection. It contains no credentials.
        error: error instanceof Error ? error.message : String(error),
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
  let transaction: Record<string, unknown> = { attempted: false };

  if (settings.DATABASE_URL?.present) {
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
        error: error instanceof Error ? error.message : String(error),
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
        staffRow = {
          attempted: true,
          found: false,
          error: error instanceof Error ? error.message : String(error),
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
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const ok =
    missing.length === 0 && database.connected === true && transaction.ok === true;

  return NextResponse.json(
    {
      ok,
      reachedTheApplication: true,
      missingRequiredSettings: missing,
      settings,
      database,
      transaction,
      platform,
      hint: ok
        ? "Everything the application needs is present. If a page still fails, the fault is in that page, not the deployment."
        : missing.length > 0
          ? `Add these in Cloudflare → Settings → Variables and secrets, then redeploy: ${missing.join(", ")}`
          : database.connected !== true
            ? "Settings are present but the database refused the connection. Read database.error above."
            : "Simple queries work but TRANSACTIONS do not. Read transaction.error — this is why signed-in pages fail while the webhook succeeds.",
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
