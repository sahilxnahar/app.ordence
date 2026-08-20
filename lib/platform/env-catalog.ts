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
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND IT IS NO LONGER KEPT IN STEP BY DISCIPLINE — v1.66.0-alpha
 * ══════════════════════════════════════════════════════════════════════
 * By v1.65.0-alpha this array had drifted from the code by FOURTEEN
 * names, exactly as the warning above predicted. `RESEND_WEBHOOK_SECRET`
 * gates all bounce and complaint handling; `SENTRY_DSN` decides whether
 * anything is observable at all; `EDGE_LIMIT_PLATFORM_FAIL_OPEN` decides
 * whether the platform rate limiter fails open. All fourteen were read by
 * the running code and reported by `/api/diag` as though they did not
 * exist.
 *
 * 🔴 `scripts/check-env-catalogue.mjs` NOW FAILS THE BUILD when a
 * `process.env` read exists in `app/`, `lib/`, `server/`, `db/`,
 * `components/`, `middleware.ts`, `next.config.ts` or `instrumentation*`
 * and the name is not here — and in the other direction too. Correcting
 * the fourteen without building the gate would have been fixing instance
 * eleven of this pattern and creating instance twelve.
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
    /**
     * ⚠️ `DATABASE_URL_UNPOOLED` is read by migration tooling and by
     * nothing in the running application. It is listed because an
     * operator still has to set it, not because the app reads it.
     */
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
      /**
       * ⚠️ READ BY THE CLERK SDK, NOT BY US. There is no `process.env`
       * read of this name anywhere in our tree, and it is still a setting
       * the deployment needs. Annotated rather than removed, because
       * deleting it would make the diagnostic silent about a name whose
       * absence breaks handshake encryption.
       */
      "CLERK_ENCRYPTION_KEY",
      /**
       * 🔴 THE UN-PREFIXED ALIAS. `lib/env.ts` falls back to this when
       * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is absent, for deployments
       * that would rather not maintain a build-variable list. It was read
       * by the code and in no catalogue, so an operator who had set only
       * this one saw `/api/diag` report the publishable key as missing
       * while the application worked — the diagnostic contradicting the
       * deployment is worse than no diagnostic.
       */
      "CLERK_PUBLISHABLE_KEY",
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
    optional: [
      "PLATFORM_HOST",
      /**
       * 🔴 BOTH OF THESE ARE READ BY `lib/security/csrf.ts` AND WERE IN NO
       * CATALOGUE. They decide which Origin headers a state-changing
       * request may carry. A deployment that sets neither does not fail
       * loudly; it refuses form posts from the host somebody actually
       * uses, and the diagnostic built to explain exactly that had no
       * entry for either name.
       */
      "APP_HOST",
      "ORDENCE_PLATFORM_HOST",
    ],
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
      /**
       * 🔴 MISSED BECAUSE THE NAME IS DATA, NOT A LITERAL.
       * `lib/ai/providers.ts` carries `envVar: "OPENROUTER_API_KEY"` and
       * `lib/ai/client.ts` reads `process.env[provider.envVar]`, so no
       * grep for `process.env.OPENROUTER_API_KEY` would ever have found
       * it. `scripts/check-env-catalogue.mjs` reads the `envVar:` shape
       * for this reason, and fails if that shape ever stops matching.
       */
      "OPENROUTER_API_KEY",
    ],
  },
  {
    name: "Email",
    description: "Resend — transactional email delivery.",
    required: [],
    optional: [
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
      /**
       * 🔴🔴 THE MOST CONSEQUENTIAL OF THE FOURTEEN. Without it
       * `/api/webhooks/resend` answers 503 and refuses every delivery, so
       * bounces and spam complaints are NOT suppressed — the product goes
       * on mailing an address that has hard-bounced, which is how a
       * sending domain's reputation is destroyed. The paste sheet
       * mentioned it; the catalogue did not, so `/api/diag` could not
       * tell an operator it was missing.
       */
      "RESEND_WEBHOOK_SECRET",
      /**
       * ⚠️ GENUINELY DEAD. Declared in `lib/env.ts` and read by no code
       * path. Kept listed only so a deployment that already sets it is
       * not told it does not exist; see KNOWN_UNREAD in
       * `scripts/check-env-catalogue.mjs`.
       */
      "FINANCE_ALERT_EMAILS",
    ],
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
    description:
      "CSP enforcement, cross-origin allowlist, edge rate-limit posture and seed safety catches.",
    required: [],
    optional: [
      "CSP_ENFORCE",
      "CSP_REPORT_URI",
      /**
       * ⚠️ Read by `scripts/` only, never by the application, and still an
       * operator-set safety catch. Listed for that reason.
       */
      "SEED_ALLOW_PROD",
      /** The cross-origin allowlist read by `lib/edge/cors.ts`. */
      "CORS_ALLOWED_ORIGINS",
      /**
       * 🔴 TWO SETTINGS THAT CHANGE WHAT THE RATE LIMITER DOES, AND
       * NEITHER WAS VISIBLE. `EDGE_LIMIT_MODE=observe` counts and refuses
       * nothing; `EDGE_LIMIT_PLATFORM_FAIL_OPEN=true` lets platform
       * traffic through when the limiter itself is unavailable. Both are
       * deliberate doors, and a door nobody can see from the diagnostic is
       * a door nobody checks is shut.
       */
      "EDGE_LIMIT_MODE",
      "EDGE_LIMIT_PLATFORM_FAIL_OPEN",
    ],
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
    description: "Error reporting, release tracking and telemetry opt-out.",
    required: [],
    optional: [
      "TELEMETRY_RELEASE",
      "NEXT_PUBLIC_RELEASE",
      "TELEMETRY_DISABLED",
      /**
       * 🔴 THE THREE SENTRY NAMES. `lib/observability/sentry-options.ts`
       * reads `NEXT_PUBLIC_SENTRY_DSN ?? SENTRY_DSN` and turns Sentry ON
       * only when one of them is non-empty; `next.config.ts` uploads
       * source maps only when `SENTRY_AUTH_TOKEN` exists. A deployment
       * with none of the three has no error reporting and no readable
       * stack traces, and `/api/diag` reported none of them.
       *
       * ⚠️ `SENTRY_AUTH_TOKEN` IS BUILD-TIME. It is read by
       * `next.config.ts`, which runs on the build machine, so setting it
       * only at runtime uploads nothing. That is why the gate's search
       * roots include `next.config.ts`.
       */
      "SENTRY_DSN",
      "NEXT_PUBLIC_SENTRY_DSN",
      "SENTRY_AUTH_TOKEN",
    ],
  },
  {
    /**
     * ⭐ THE THREE THAT CHANGE WHEN A CUSTOMER IS WARNED AND WHEN THEY ARE
     * LOCKED OUT.
     *
     * `lib/billing/grace.ts` reads all three and falls back to defaults
     * when they are absent, which is why nobody noticed: the product
     * works, it simply chases on a schedule nobody chose. They are
     * `NEXT_PUBLIC_` because the same numbers are printed to the customer
     * in the banner that warns them.
     */
    name: "Billing notices",
    description:
      "How many days of warning and grace a trial and an unpaid invoice get. Absent means the built-in defaults.",
    required: [],
    optional: [
      "NEXT_PUBLIC_ORDENCE_TRIAL_NOTICE_DAYS",
      "NEXT_PUBLIC_ORDENCE_TRIAL_GRACE_DAYS",
      "NEXT_PUBLIC_ORDENCE_DUNNING_GRACE_DAYS",
    ],
  },
  {
    /**
     * ⭐ ADDED AT INTEGRATION, WAVE 14. Track A introduced these five names
     * and could not catalogue them: `lib/platform/env-catalog.ts` is not in
     * its ownership block, and its patch request did not ask for the entry.
     * `check:env-catalogue` refused the delivery, which is the gate doing
     * exactly its job , a setting the code reads and the catalogue omits is
     * invisible to `/api/diag`, the one endpoint built to explain a missing
     * setting.
     *
     * ⚠️ ALL FIVE ARE OPTIONAL BY DESIGN. The entrypoint falls back for each,
     * so a scheduler with none of them set still runs. That is deliberate:
     * a cron service that refuses to start because a timeout was not tuned
     * is a cron service that does not run.
     */
    name: "Scheduler",
    description:
      "The cron entrypoint. Absent values fall back, so a scheduler with none of these still runs.",
    required: [],
    /**
     * ⭐ NARROWED AT INTEGRATION, WAVE 17. The first delivery read five names;
     * Track A's wave-17 deleted three of them , `APP_URL` in favour of the
     * existing `NEXT_PUBLIC_APP_URL`, and `SCHEDULER_SOURCE` and
     * `SCHEDULER_TIMEOUT_MS` as knobs nobody would ever turn. `check:env-catalogue`
     * caught the leftovers immediately, in the opposite direction from last
     * time: catalogued and read by nothing rather than read and uncatalogued.
     * Deleting a setting is rarer and better than adding one.
     */
    optional: ["SCHEDULER_APP_URL", "MAINTENANCE_DATABASE_URL"],
  },
  {
    /**
     * ⭐ ADDED AT INTEGRATION, WAVE 14, for the same reason as "Scheduler"
     * above: Track B introduced this name and cannot edit this file.
     *
     * 🔴 THE WEBHOOK URL IS A CREDENTIAL. Anyone holding it can post into
     * the alert channel as Ordence. It is optional because alerting must
     * degrade to logs rather than refuse to start, and it must never
     * appear in a log line, an error message or a report.
     */
    name: "Alerting",
    description:
      "Where security and SLO alerts are posted. Absent means alerts degrade to logs. The URL is a credential.",
    required: [],
    optional: ["DISCORD_ALERT_WEBHOOK_URL"],
  },
  {
    /**
     * ⭐ ADDED AT INTEGRATION, WAVE 15. Third time this wave: a track
     * introduced a setting and cannot edit this file. Tracks A, B and E
     * each hit it, none of the three asked for the entry in its patch
     * request, and the gate caught all three. That is the gate working and
     * a brief that needs one more line.
     *
     * ⚠️ OFF IS THE SAFE VALUE AND THE DEFAULT. Turning it on makes Ordence
     * call the government IRP for an invoice reference number. Absent
     * means the e-invoice payload is built and validated and nothing
     * leaves the building.
     */
    name: "E-invoicing",
    description:
      "Whether invoices are registered with the IRP. Absent or false means the payload is built and never sent.",
    required: [],
    optional: ["ORDENCE_EINVOICE_IRP_ENABLED"],
  },
  {
    name: "Legacy",
    description: "Kept for rollback safety; no live code path.",
    required: [],
    optional: ["BLOB_READ_WRITE_TOKEN"],
  },
];
