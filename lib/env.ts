/**
 * Ordence — Environment Variable Validation
 * Version: v0.1.0-alpha
 *
 * SECURITY (Blueprint: "Sensitive Data Exposure Strategy"):
 * `serverEnv` is guarded by an explicit `typeof window` check. If any client
 * component ever imports it, the build fails loudly instead of silently leaking
 * secrets into the browser bundle. Only NEXT_PUBLIC_* values may cross to the client.
 */

import { z } from "zod";

/* ---------------------------- SERVER ONLY ---------------------------- */

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // --- Database (Neon serverless Postgres) ---
  DATABASE_URL: z
    .string()
    .url("DATABASE_URL must be a valid postgres:// connection string"),
  // Direct (non-pooled) URL used only by drizzle-kit for migrations.
  DATABASE_URL_UNPOOLED: z.string().url().optional(),

  // --- Clerk (authentication) ---
  CLERK_SECRET_KEY: z.string().min(1, "CLERK_SECRET_KEY is required"),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional(),

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 TWELVE NAMES THE CODE READS THAT THIS SCHEMA NEVER DECLARED
   * ══════════════════════════════════════════════════════════════════
   * The block further down asserts that the reconciliation between "what
   * the code reads" and "what this file knows about" was completed and
   * that "the true figure was 43". It was not complete. All four `S3_*`
   * names, the eight AI provider keys, `CSP_REPORT_URI` and both Sentry
   * DSNs were still absent.
   *
   * ⚠️ THE COST IS EXACTLY WHAT THAT BLOCK DESCRIBES. A typo in
   * `S3_SECRET_ACCESS_KEY` produced no boot error, no build error and no
   * runtime error — just a document vault reporting "storage is not
   * configured", which is the same thing it says when storage genuinely
   * is not configured. Declaring them optional does not make them
   * required; it makes them KNOWN, so `/api/diag` can report them and a
   * misspelling has somewhere to be noticed.
   */

  // --- Object storage (Cloudflare R2 over the S3 API) ---
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  // --- AI providers. At least one enables the assistant. ---
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CF_AI_TOKEN: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  CEREBRAS_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  GITHUB_MODELS_TOKEN: z.string().optional(),

  // --- Observability ---
  SENTRY_DSN: z.string().optional(),
  /** ⚠️ Where CSP violation reports go. Without it, report-only mode is a no-op. */
  CSP_REPORT_URI: z.string().optional(),

  // --- Upstash Redis (cache + rate limiting) ---
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // --- Vercel Blob (file storage, Phase 8) ---
  //
  // Optional so the app still builds and runs without storage configured —
  // the Document Vault degrades to a clear "storage is not configured"
  // message rather than crashing every page that imports it. A required
  // variable here would make `npm run build` depend on a real secret, which
  // is exactly what the CI build asserts must NOT be true.
  BLOB_READ_WRITE_TOKEN: z.string().optional(),

  // --- Resend (transactional email, Phase 8) ---
  RESEND_API_KEY: z.string().optional(),
  /** Verified sender, e.g. "Ordence <notifications@ordence.com>". */
  RESEND_FROM_EMAIL: z.string().optional(),
  /** Where LedgerAlertEmail is delivered. Comma-separated. */
  FINANCE_ALERT_EMAILS: z.string().optional(),

  // --- Razorpay (primary payment rail for INR, Phase 11) ---
  //
  // All THREE are optional, so the app builds and runs with no payment
  // provider configured. `configuredProviders()` reports what is actually
  // available and checkout refuses cleanly rather than crashing — the same
  // degradation strategy used for Blob and Resend.
  //
  // ⚠️ RAZORPAY_KEY_ID is the publishable half and reaches the browser via
  // the Checkout widget. RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET
  // never do, which is why none of them carry a NEXT_PUBLIC_ prefix — the
  // key id is passed to the client explicitly by a server action instead.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // --- Stripe (international cards, Phase 11) ---
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // --- Tax identity (Phase 11) ---
  /** Our GST registration state code. Decides IGST vs CGST+SGST. */
  PLATFORM_GST_STATE_CODE: z.string().length(2).optional(),
  /** Our own GSTIN, printed on every invoice we issue. */
  PLATFORM_GSTIN: z.string().optional(),
  /** Invoice number prefix, e.g. "AH". */
  PLATFORM_INVOICE_PREFIX: z.string().max(10).optional(),

  // --- Telemetry (Phase 19) ---
  //
  // Deploy identity stamped onto every telemetry row. Optional: without it
  // rows carry release "unknown", which is degraded but not broken. Falls
  // back to VERCEL_GIT_COMMIT_SHA automatically.
  TELEMETRY_RELEASE: z.string().max(80).optional(),
  // Kill switch — stop all telemetry writes without a deploy. Opt-OUT by
  // design: telemetry that must be switched ON is telemetry that is off in
  // the environment where it mattered.
  TELEMETRY_DISABLED: z.string().optional(),

  // --- Platform ---
  PLATFORM_ADMIN_EMAILS: z.string().optional(),

  /* ================================================================== *
   * ⭐ RECONCILIATION — v0.73.0-alpha (Batch 3)
   * ================================================================== *
   * 🔴 EVERY VARIABLE BELOW WAS ALREADY BEING READ BY THE CODE AND WAS
   *    ABSENT FROM THIS SCHEMA.
   *
   * Three inventories of "what configures Ordence" existed and all three
   * disagreed:
   *
   *     lib/env.ts       31 variables   ← validated at boot
   *     /api/diag        26 variables   ← reported to the operator
   *     .env.example     12 variables   ← what a new developer copies
   *
   * The true figure was 43. The twelve missing from here were invisible
   * to `getServerEnv()`, so a typo in one produced no error at boot, no
   * error at build, and a feature that silently did nothing.
   *
   * Two of them are load-bearing:
   *
   *   • UPLOAD_TICKET_SECRET — absent, and EVERY FILE UPLOAD REFUSES.
   *     `getTicketSecret()` returns null below 32 characters.
   *   • WORKER_API_SECRET — absent, and `/api/workers` returns 503, so
   *     ALL BACKGROUND JOBS STOP.
   *
   * Both fail CLOSED, which is right — the system is never insecure, it
   * is inert. But inert with no error is exactly the failure mode this
   * project has hit four times: something stops working and reports
   * success. Declaring them here makes them visible.
   *
   * ⚠️ THEY STAY OPTIONAL, DELIBERATELY. Making them required would make
   * `npm run build` depend on a real secret — which is precisely what the
   * CI build asserts must NOT be true. Optional-and-declared beats
   * required-and-breaks-the-build, and beats undeclared by a mile.
   * ================================================================== */

  /** HMAC key for upload tickets. ⚠️ Minimum 32 characters, or uploads refuse. */
  UPLOAD_TICKET_SECRET: z.string().optional(),

  /** Bearer secret for `/api/workers`. Compared with `timingSafeEqual`. */
  WORKER_API_SECRET: z.string().optional(),

  /**
   * 🔴🔴 THE KEY THE VAULT HAS BEEN WAITING FOR SINCE 0037.
   *
   * `vault_secrets` holds ciphertext and the NAME of a key. This is the
   * key. 64 hex characters (32 bytes) for AES-256-GCM, generated once
   * with `openssl rand -hex 32`.
   *
   * ⚠️ WITHOUT IT NOTHING CAN BE VAULTED, AND THAT IS INTENDED. The
   * alternative — a default key, or storing the value in the clear "for
   * now" — is how plaintext credentials end up in a database backup. The
   * screens say the key is missing rather than pretending to work.
   *
   * ⚠️ AND CHANGING IT ORPHANS EVERY SECRET ALREADY STORED, which is why
   * `vault_secrets.key_ref` names the key on every row: an old row can
   * still say which key it needs while new rows use the new one.
   */
  VAULT_ENCRYPTION_KEY: z.string().optional(),

  /**
   * 🔴 THE PEPPER FOR THE BLIND INDEX, and a different secret from the
   * key above on purpose.
   *
   * ⚠️ The blind index makes "find the record with this PAN" answerable
   * without decrypting anything. A plain SHA-256 would not: the PAN
   * space is about 10^9 and a laptop enumerates that in minutes, so the
   * hash IS the PAN to whoever obtains the column. Under a pepper that
   * lives outside the database, the same column is inert.
   *
   * 🔴 IT MUST NEVER BE ROTATED CASUALLY. Every blind index in the
   * database is computed under it, and changing it makes all of them
   * unsearchable at once.
   */
  VAULT_BLIND_INDEX_PEPPER: z.string().optional(),

  /** Vercel-cron auth path. Vestigial on Railway; retained for the rollback. */
  CRON_SECRET: z.string().optional(),

  /** QStash delivery signatures. Two keys so Upstash can rotate without downtime. */
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),

  /**
   * Run queued jobs in-process instead of dispatching them.
   * The documented stopgap until a Railway cron service exists.
   */
  ORDENCE_INLINE_JOBS: z.string().optional(),

  /** ⚠️ PRINTED ON EVERY INVOICE WE ISSUE. Wrong here is wrong on paper. */
  PLATFORM_LEGAL_NAME: z.string().optional(),
  PLATFORM_ADDRESS: z.string().optional(),

  /** Staff-console host override. Defaults to `admin.<zone>`. */
  PLATFORM_HOST: z.string().optional(),

  /**
   * ⚠️ GUARDS SEEDING AGAINST PRODUCTION.
   *
   * Undeclared until now, and nothing verified it was configured as
   * intended — a safety catch nobody could see the state of.
   */
  SEED_ALLOW_PROD: z.string().optional(),

  /**
   * Enforce the Content-Security-Policy rather than only reporting it.
   * Unset means report-only, which is the current production state.
   */
  CSP_ENFORCE: z.string().optional(),
});

/* ------------------------- CLIENT (PUBLIC) --------------------------- */

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_ROOT_DOMAIN: z.string().default("localhost:3000"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.string().default("/sign-in"),
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: z.string().default("/sign-up"),

  /* ---- reconciliation, v0.73.0-alpha ---- */

  /**
   * The zone tenant subdomains hang off. Read by the middleware; was
   * reported by `/api/diag` and absent from this schema.
   */
  NEXT_PUBLIC_ZONE_DOMAIN: z.string().optional(),

  /**
   * Client-visible release stamp.
   *
   * ⚠️ Do NOT wire this to `VERCEL_GIT_COMMIT_SHA` — Railway never sets
   * that, which is why telemetry rows currently read "unknown".
   */
  NEXT_PUBLIC_RELEASE: z.string().optional(),

  /**
   * ⚠️ Declared here because it is read by
   * `lib/observability/sentry-options.ts` and appeared in neither
   * schema. A DSN is send-only and embedded in client JS by design, so
   * it is not a secret; being undeclared still meant a typo produced
   * silence rather than an error.
   */
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
});

/* ----------------------------- LOADERS ------------------------------- */

function formatIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`).join("\n");
}

let cachedServerEnv: z.infer<typeof serverSchema> | null = null;

/**
 * Server-side environment. Throws if called from the browser.
 * Call this inside route handlers / server components / server actions only.
 */
export function getServerEnv(): z.infer<typeof serverSchema> {
  if (typeof window !== "undefined") {
    throw new Error(
      "[SECURITY] getServerEnv() was called in the browser. " +
        "Server secrets must never reach the client bundle.",
    );
  }
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid server environment variables:\n${formatIssues(parsed.error.issues)}\n\n` +
        `Copy .env.example to .env.local and fill in the missing values.`,
    );
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

/* ------------------------- RUNTIME ENV READER ------------------------ */

/**
 * Read an environment variable in a way bundlers CANNOT inline.
 *
 * ⚠️ This indirection is the whole point, so do not "simplify" it back to
 * `process.env.SOMETHING`.
 *
 * Next.js replaces every literal `process.env.NEXT_PUBLIC_FOO` with the
 * value present AT BUILD TIME. On a platform where the build runs in one
 * place and the deploy runs in another — Cloudflare Workers Builds, for
 * instance — a variable configured only for the running Worker is simply
 * absent while the code is being assembled, and the literal `undefined`
 * gets frozen into the output.
 *
 * Looking the name up through a variable defeats that substitution, so the
 * value is read when the request happens rather than when the code was
 * compiled. That is what allows a single list of environment variables to
 * be enough, instead of the same list maintained in two places.
 */
export function readRuntimeEnv(name: string): string | undefined {
  const bag = process.env as unknown as Record<string, string | undefined>;
  const value = bag[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The Clerk publishable key, resolved at REQUEST time.
 *
 * Order of preference:
 *   1. the build-time inlined value, when the build had it
 *   2. the same name looked up at runtime
 *   3. `CLERK_PUBLISHABLE_KEY` — the un-prefixed alias, for deployments that
 *      would rather not maintain a build-variable list at all
 *
 * Returns undefined rather than throwing. `app/layout.tsx` decides what to
 * do about a missing key; a module that throws while merely being imported
 * takes down the build itself, which is what used to happen here.
 */
export function getClerkPublishableKey(): string | undefined {
  return (
    (typeof process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === "string" &&
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.length > 0
      ? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
      : undefined) ??
    readRuntimeEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") ??
    readRuntimeEnv("CLERK_PUBLISHABLE_KEY")
  );
}

/**
 * ⭐ The paths of the sign-in and sign-up pages THIS APPLICATION serves,
 * resolved at REQUEST time — added v0.50.0.
 *
 * Read by `app/layout.tsx` and handed to `<ClerkProvider>` as props. See
 * the long comment there for why props rather than the NEXT_PUBLIC_
 * variables Clerk would otherwise look up itself: those are substituted
 * into the browser bundle at BUILD time, and the Cloudflare build runs
 * with no variables set, so Clerk concluded this app had no sign-in page
 * and sent every visitor to its own hosted Account Portal instead.
 *
 * Defaults are the real routes under `app/(auth)/`, so this returns the
 * correct answer even when nothing is configured anywhere — which is the
 * property the previous arrangement lacked.
 */
export function getClerkPaths(): { signInUrl: string; signUpUrl: string } {
  return {
    signInUrl: readRuntimeEnv("NEXT_PUBLIC_CLERK_SIGN_IN_URL") ?? "/sign-in",
    signUpUrl: readRuntimeEnv("NEXT_PUBLIC_CLERK_SIGN_UP_URL") ?? "/sign-up",
  };
}

/**
 * Public environment.
 *
 * ⚠️ LAZY BY NECESSITY — this used to be `export const clientEnv =
 * clientSchema.parse(...)`, evaluated the moment any module imported this
 * file. That made a missing `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` a BUILD
 * failure rather than a runtime one, and the resulting error named a
 * completely unrelated route:
 *
 *     Failed to collect page data for /api/documents/[id]/download
 *
 * because that route merely happened to be the first thing imported. A
 * function moves the check to the point of use, where the message can be
 * about the thing that is actually wrong.
 */
export function getClientEnv(): z.infer<typeof clientSchema> {
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_APP_URL: readRuntimeEnv("NEXT_PUBLIC_APP_URL"),
    NEXT_PUBLIC_ROOT_DOMAIN: readRuntimeEnv("NEXT_PUBLIC_ROOT_DOMAIN"),
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: getClerkPublishableKey(),
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: readRuntimeEnv("NEXT_PUBLIC_CLERK_SIGN_IN_URL"),
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: readRuntimeEnv("NEXT_PUBLIC_CLERK_SIGN_UP_URL"),
    /**
     * 🔴 THESE THREE WERE DECLARED AND NEVER PARSED. `clientSchema`
     * listed `NEXT_PUBLIC_ZONE_DOMAIN` and `NEXT_PUBLIC_RELEASE`, and
     * this object omitted both — dead validation that read as coverage.
     * Harmless while they are optional, and exactly the shape of thing
     * that stops being harmless the day one of them is not.
     */
    NEXT_PUBLIC_ZONE_DOMAIN: readRuntimeEnv("NEXT_PUBLIC_ZONE_DOMAIN"),
    NEXT_PUBLIC_RELEASE: readRuntimeEnv("NEXT_PUBLIC_RELEASE"),
    NEXT_PUBLIC_SENTRY_DSN: readRuntimeEnv("NEXT_PUBLIC_SENTRY_DSN"),
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid public environment variables:\n${formatIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;
