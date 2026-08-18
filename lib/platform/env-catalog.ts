/**
 * Ordence — ⭐⭐ THE ENVIRONMENT CATALOGUE, IN ONE PLACE
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS MOVED OUT OF `app/api/diag/route.ts`
 * ══════════════════════════════════════════════════════════════════════
 * This array is the only written-down answer to "what settings does this
 * product read". The secret rotation board needs exactly that list, and
 * a `route.ts` may export nothing but HTTP verbs — so a second screen
 * could only have had a SECOND COPY.
 *
 * ⚠️ TWO LISTS KEPT IN STEP BY DISCIPLINE IS THE DEFECT THAT PRODUCED
 * MIGRATION 0091, where two reserved-slug lists had drifted by eight
 * names in each direction and neither author had noticed. The diagnostic
 * and the board now read one array; there is nothing to drift.
 *
 * ⚠️ PURE, AND IT MUST STAY PURE. No `server-only`, no `process.env`, no
 * imports. `app/api/diag/route.ts` reads it, the console reads it, and a
 * test reads it without standing anything up. It is a list of NAMES and
 * prose — it has never held a value and must never hold one.
 *
 * ⚠️ "Object Storage (R2)" APPEARS TWICE, exactly as it did in the
 * diagnostic. Left alone deliberately: this move must not change what
 * `/api/diag` answers. Consumers that need each name once de-duplicate
 * on the way out (see `lib/platform/secret-catalog.ts`).
 */

export type EnvCategory = {
  name: string;
  required: string[];
  optional: string[];
  description: string;
};

export const ENV_CATEGORIES: EnvCategory[] = [
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
    optional: ["CSP_ENFORCE", "CSP_REPORT_URI", "SEED_ALLOW_PROD"],
  },
  {
    /**
     * 🔴 THESE TWO APPEARED IN NO DEPLOYMENT ARTIFACT ANYWHERE.
     *
     * Not in `.env.example`, not in `RAILWAY-VARIABLES-PASTE.txt`, not
     * in `docs/ENVIRONMENT-VARIABLES.md`, and not here. An operator
     * following any shipped document set neither, so `vaultReadiness()`
     * returned not-ready, every `putSecret` refused, and no integration
     * credential could be saved — with no entry in the one endpoint
     * built to explain exactly this class of failure.
     *
     * ⚠️ OPTIONAL, NOT REQUIRED. The vault fails closed and nothing
     * leaks without it; the product simply cannot store a connector
     * credential. Refusing to boot over it would take down deployments
     * that legitimately use no connectors.
     */
    name: "Vault",
    description:
      "Application-level encryption for tenant integration credentials. " +
      "Absent means connectors cannot be configured; nothing is stored in the clear.",
    required: [],
    optional: ["VAULT_ENCRYPTION_KEY", "VAULT_BLIND_INDEX_PEPPER"],
  },
  {
    name: "Object Storage (R2)",
    description: "Cloudflare R2 over the S3 API. All four or none.",
    required: [],
    optional: ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
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
