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
});

/* ------------------------- CLIENT (PUBLIC) --------------------------- */

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_ROOT_DOMAIN: z.string().default("localhost:3000"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.string().default("/sign-in"),
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: z.string().default("/sign-up"),
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
function readRuntimeEnv(name: string): string | undefined {
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
