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

type EnvCategory = {
  name: string;
  required: string[];
  optional: string[];
  description: string;
};

const CATEGORIES: EnvCategory[] = [
  {
    name: "Database",
    description: "Neon Postgres — pooled for requests, unpooled for migrations.",
    required: ["DATABASE_URL"],
    optional: ["DATABASE_URL_UNPOOLED"],
  },
  {
    name: "Authentication",
    description: "Clerk — sign-in, webhooks, encryption.",
    required: [
      "CLERK_SECRET_KEY",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ],
    optional: [
      "CLERK_WEBHOOK_SIGNING_SECRET",
      "CLERK_ENCRYPTION_KEY",
      "NEXT_PUBLIC_CLERK_SIGN_IN_URL",
      "NEXT_PUBLIC_CLERK_SIGN_UP_URL",
    ],
  },
  {
    name: "Hosts & Domains",
    description: "Subdomain routing, admin portal, platform identification.",
    required: [
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_ROOT_DOMAIN",
      "NEXT_PUBLIC_ZONE_DOMAIN",
    ],
    optional: ["PLATFORM_HOST"],
  },
  {
    name: "Platform Admin",
    description: "Staff console access, platform tax identity for invoices.",
    required: ["PLATFORM_ADMIN_EMAILS"],
    optional: [
      "PLATFORM_LEGAL_NAME",
      "PLATFORM_GSTIN",
      "PLATFORM_GST_STATE_CODE",
      "PLATFORM_ADDRESS",
      "PLATFORM_INVOICE_PREFIX",
    ],
  },
  {
    name: "Object Storage (R2)",
    description: "Cloudflare R2 over S3 API — all four or none.",
    required: [],
    optional: ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
  },
  {
    name: "AI Providers",
    description: "LLM routing — at least one enables the AI assistant.",
    required: [],
    optional: [
      "CLOUDFLARE_ACCOUNT_ID",
      "CF_AI_TOKEN",
      "GROQ_API_KEY",
      "CEREBRAS_API_KEY",
      "GOOGLE_AI_API_KEY",
      "MISTRAL_API_KEY",
      "COHERE_API_KEY",
      "GITHUB_MODELS_TOKEN",
    ],
  },
  {
    name: "Email",
    description: "Resend — transactional email delivery.",
    required: [],
    optional: ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "FINANCE_ALERT_EMAILS"],
  },
  {
    name: "Payments",
    description: "Razorpay and/or Stripe — billing and subscriptions.",
    required: [],
    optional: [
      "RAZORPAY_KEY_ID",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ],
  },
  {
    name: "Cache & Queue",
    description: "Upstash Redis for caching, QStash for scheduled jobs.",
    required: [],
    optional: [
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "QSTASH_CURRENT_SIGNING_KEY",
      "QSTASH_NEXT_SIGNING_KEY",
    ],
  },
  {
    name: "Workers & Secrets",
    description: "Background job authentication and inline execution.",
    required: [],
    optional: [
      "UPLOAD_TICKET_SECRET",
      "WORKER_API_SECRET",
      "CRON_SECRET",
      "ORDENCE_INLINE_JOBS",
    ],
  },
  {
    name: "Security",
    description: "CSP enforcement and seed safety catches.",
    required: [],
    optional: ["CSP_ENFORCE", "SEED_ALLOW_PROD"],
  },
  {
    name: "Telemetry",
    description: "Release tracking and telemetry opt-out.",
    required: [],
    optional: ["TELEMETRY_RELEASE", "NEXT_PUBLIC_RELEASE", "TELEMETRY_DISABLED"],
  },
  {
    name: "Legacy",
    description: "Kept for rollback safety; no live code path.",
    required: [],
    optional: ["BLOB_READ_WRITE_TOKEN"],
  },
];

/** Flattened arrays kept for backward compatibility with the response shape. */
const REQUIRED = CATEGORIES.flatMap((c) => c.required);
const OPTIONAL = CATEGORIES.flatMap((c) => c.optional);

export async function GET() {
  const settings: Record<string, { present: boolean; length: number }> = {};

  for (const name of [...REQUIRED, ...OPTIONAL]) {
    const value = readRuntimeEnv(name);
    settings[name] = { present: value !== undefined, length: value?.length ?? 0 };
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
      vars: Object.fromEntries(all.map((n) => [n, settings[n] ?? { present: false, length: 0 }])),
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
      version: readRuntimeEnv("NEXT_PUBLIC_RELEASE") || "unset",
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
