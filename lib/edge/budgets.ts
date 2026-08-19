/**
 * Ordence — The Edge Budget Matrix
 * Version: v1.31.0-alpha (Batch 31)
 *
 * Pure data and pure arithmetic. No imports that do I/O, no `server-only`,
 * no database — the middleware (Edge runtime), the Node route handlers, the
 * settings screen and the tests all read the SAME numbers from here.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PROBLEM THIS BATCH EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Before this file there was exactly one shared thing bounding request
 * volume — `lib/security/rate-limit.ts` — and it is keyed per SURFACE
 * (auth, search, upload, portal, webhook, api) with ONE number each,
 * identical for every workspace on the instance.
 *
 * That is a fine anti-abuse control and a useless capacity control. Two
 * failures follow directly from it, and both were live:
 *
 *   1. NOTHING BOUNDS A TENANT'S TOTAL. A workspace whose integration has
 *      gone into a retry loop issues tens of thousands of requests a
 *      minute against page routes and server actions, none of which is
 *      `search` or `upload`. The `api` policy never sees them because
 *      nothing calls it on the page path. Postgres connections, Worker
 *      CPU and the Neon compute bill are all SHARED, so the tenant does
 *      not degrade themselves — they degrade everybody.
 *
 *   2. A PAYING CUSTOMER AND A TRIAL GET THE SAME BUDGET. Which means
 *      either the trial is too generous (we sell capacity for nothing) or
 *      the enterprise customer is throttled at a trial's ceiling (we
 *      throttle the person paying the most). One number cannot be right
 *      for both.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE BUDGETS ARE CEILINGS, NOT QUOTAS
 * ══════════════════════════════════════════════════════════════════════
 * Nothing here is a product promise and nothing here is metered or
 * billed — `lib/metering/quota.ts` owns the things a customer buys. These
 * are the numbers above which a workspace is, with certainty, malfunctioning
 * rather than working hard. They are set roughly an order of magnitude
 * above observed peak use for the tier, because:
 *
 *   ⚠️ A CEILING TUNED TO "NORMAL" IS AN OUTAGE WAITING FOR A BUSY
 *   MONDAY. The cost of a ceiling being too high is some wasted compute
 *   for the minutes it takes to notice. The cost of it being too low is a
 *   customer's month-end close failing at 4pm on the 31st. Those are not
 *   comparable, so the numbers lean the same way every time.
 */

import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* SURFACES                                                            */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE SURFACES, THREE BUCKETS, THREE BLAST RADII. NEVER ONE BUCKET.
 * ══════════════════════════════════════════════════════════════════════
 *   `app`       A tenant's own people using the CRM in a browser. Tens of
 *               thousands of humans. Throttling this wrongly is a visible
 *               product outage for a paying customer.
 *
 *   `api`       The same tenant's PROGRAMMATIC surface. A script has no
 *               patience and no think-time, so its natural rate is
 *               unbounded and its natural failure mode is a retry loop.
 *               It gets a tighter budget than the humans do, deliberately.
 *
 *   `platform`  The staff console at `admin.<zone>`. Perhaps a dozen
 *               people, and every page reads ACROSS tenants. Throttling
 *               it wrongly inconveniences colleagues; failing to throttle
 *               it means an compromised staff session can enumerate every
 *               workspace in the product as fast as the network allows.
 *
 * ⚠️ THE POINT OF THE SPLIT IS THAT THE FAILURE MODES DIFFER, NOT JUST
 * THE NUMBERS. See `FAIL_MODE` below — `platform` fails CLOSED and the
 * tenant surfaces fail DEGRADED, and that would be unexpressible if they
 * shared a bucket.
 */
export const EDGE_SURFACES = ["app", "api", "platform"] as const;

export type EdgeSurface = (typeof EDGE_SURFACES)[number];

/* ------------------------------------------------------------------ */
/* THE PLAN MATRIX                                                     */
/* ------------------------------------------------------------------ */

export type SurfaceBudget = {
  /** Requests permitted per window, per TENANT (not per user). */
  limit: number;
  /** Window length, seconds. */
  windowSeconds: number;
};

/**
 * Requests per minute per workspace, by plan.
 *
 * ⚠️ PER TENANT, NOT PER USER, AND THAT IS THE WHOLE DESIGN. Per-user
 * limits do not solve the problem this batch is about: fifty users each
 * politely under a per-user limit still add up to a workspace that is
 * consuming the instance. The bucket has to be the thing whose costs are
 * shared, and that is the workspace.
 *
 * ⚠️ THE LADDER IS NOT LINEAR. It roughly doubles per tier, because seat
 * counts roughly double per tier and request volume is driven by seats,
 * not by feature flags. A basic workspace is five people; an enterprise
 * one is two hundred with three integrations.
 *
 * `trial` sits BELOW basic on purpose, and this is the one place in the
 * product where trial is not treated as advanced (contrast
 * `TRIAL_EFFECTIVE_TIER` in `lib/entitlements/features.ts`). Entitlements
 * decide what a prospect may SEE, and being generous there sells the
 * product. Capacity decides what an unverified signup may CONSUME, and
 * being generous there is how a free tier becomes a botnet's proxy.
 */
export const PLAN_RATE_BUDGETS: Readonly<
  Record<PlanTier, Readonly<Record<EdgeSurface, SurfaceBudget>>>
> = Object.freeze({
  trial: Object.freeze({
    app: { limit: 600, windowSeconds: 60 },
    api: { limit: 120, windowSeconds: 60 },
    platform: PLATFORM_PLACEHOLDER(),
  }),
  basic: Object.freeze({
    app: { limit: 1_200, windowSeconds: 60 },
    api: { limit: 300, windowSeconds: 60 },
    platform: PLATFORM_PLACEHOLDER(),
  }),
  advanced: Object.freeze({
    app: { limit: 3_000, windowSeconds: 60 },
    api: { limit: 900, windowSeconds: 60 },
    platform: PLATFORM_PLACEHOLDER(),
  }),
  ai: Object.freeze({
    app: { limit: 6_000, windowSeconds: 60 },
    api: { limit: 1_800, windowSeconds: 60 },
    platform: PLATFORM_PLACEHOLDER(),
  }),
  enterprise: Object.freeze({
    app: { limit: 12_000, windowSeconds: 60 },
    api: { limit: 3_600, windowSeconds: 60 },
    platform: PLATFORM_PLACEHOLDER(),
  }),
});

/**
 * The staff console has no plan, so the per-plan table cannot express its
 * budget and must not pretend to.
 *
 * ⚠️ THIS PLACEHOLDER EXISTS SO THE TYPE STAYS TOTAL. Reading
 * `PLAN_RATE_BUDGETS[tier].platform` is a bug — `platformBudget()` is the
 * only correct source — and a zero limit makes that bug LOUD (everything
 * refused, immediately, in the first test that touches it) rather than
 * quiet (a plausible-looking number that silently varies with the
 * customer's plan, which is nonsense for staff).
 */
function PLATFORM_PLACEHOLDER(): SurfaceBudget {
  return { limit: 0, windowSeconds: 60 };
}

/**
 * The staff console's own budget. Plan-independent, keyed per STAFF USER.
 *
 * 600/minute is ten per second sustained, which no human clicking a
 * console reaches and which a script walking every tenant reaches
 * instantly. It is deliberately not generous: there are about a dozen
 * legitimate users of this surface and every one of their requests can
 * read another company's revenue.
 */
export function platformBudget(): SurfaceBudget {
  return { limit: 600, windowSeconds: 60 };
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT WE ASSUME WHEN WE DO NOT KNOW THE PLAN
 * ══════════════════════════════════════════════════════════════════════
 * The Edge runtime cannot read the database, so `middleware.ts` cannot
 * look up `tenants.plan_tier`. It reads a cached hint (see
 * `lib/edge/limits.ts`) and that hint can be absent: cold Redis, a
 * workspace whose first request of the day this is, a deployment with no
 * Redis at all.
 *
 * 🔴 THE FALLBACK DIRECTION IS A REAL DECISION AND IT IS THIS ONE:
 * ASSUME THE MOST GENEROUS SELF-SERVE TIER, NOT THE LEAST.
 *
 * Assume `trial` on a cache miss and every enterprise customer's first
 * request after a Redis restart is measured against a 600/minute ceiling.
 * The people most likely to trip it are the people paying the most, at
 * the moment we are least able to explain why. Assume `ai` and a trial
 * workspace briefly gets ten times its budget — which costs us some
 * compute, bounded by however long the hint takes to warm (seconds), and
 * which is still bounded by every other limit in the product.
 *
 * We take the cheap mistake over the expensive one, on purpose, in one
 * named constant so it can be argued with.
 *
 * ⚠️ NOT `enterprise`. The fallback must not be the top of the ladder, or
 * a permanently-broken hint would mean nobody is limited at all and the
 * whole feature would be dead without a single failing test.
 */
export const UNKNOWN_PLAN_FALLBACK_TIER: PlanTier = "ai";

/** The budget for a (plan, surface) pair. `platform` ignores the plan. */
export function budgetFor(
  tier: PlanTier | null | undefined,
  surface: EdgeSurface,
): SurfaceBudget {
  if (surface === "platform") return platformBudget();
  const resolved: PlanTier = tier ?? UNKNOWN_PLAN_FALLBACK_TIER;
  const row = PLAN_RATE_BUDGETS[resolved] ?? PLAN_RATE_BUDGETS[UNKNOWN_PLAN_FALLBACK_TIER];
  return row[surface];
}

/* ------------------------------------------------------------------ */
/* FAIL MODE — THE DECISION THE BRIEF DEMANDS BE VISIBLE               */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT HAPPENS WHEN THE COUNTER IS UNREACHABLE. WRITTEN DOWN, NOT
 *    IMPLIED BY A `catch {}`.
 * ══════════════════════════════════════════════════════════════════════
 * A limiter that fails OPEN is not a limit: an attacker who can make
 * Upstash unreachable — or who simply finds the deployment where nobody
 * configured it — has removed the control entirely. A limiter that fails
 * CLOSED is an outage generator: one bad afternoon at a third party and
 * every customer sees 429 on every page, caused by the security feature
 * rather than by any attack.
 *
 * Neither answer is right for both surfaces, so this product gives a
 * DIFFERENT answer per surface, and the difference is the reason the
 * surfaces are separate buckets in the first place:
 *
 *   `app` / `api`  →  "degraded"
 *       Fall back to a per-instance sliding-window counter and SAY SO on
 *       every response (`x-ordence-limit-mode: degraded`). Honest about
 *       what it is worth: on a multi-instance deployment the effective
 *       ceiling is `limit x instances`, so it stops a runaway integration
 *       and a stuck browser tab, and does not stop a distributed attack.
 *       Chosen because ten thousand customers being unable to work is a
 *       larger, more certain harm than one workspace briefly exceeding a
 *       capacity ceiling.
 *
 *   `platform`  →  "closed"
 *       Refuse, with a 503 and a sentence naming the cause. Chosen
 *       because the population is a dozen staff rather than ten thousand
 *       customers, the console reads across every tenant, and an
 *       uncounted cross-tenant console is the single worst uncontrolled
 *       surface in the product. A dozen people seeing "the limiter is
 *       unavailable, try again shortly" is a cost we can pay.
 *
 * ⚠️ "UNREACHABLE" MEANS CONFIGURED-BUT-ERRORING. A deployment with NO
 * Redis at all — local dev, a self-hosted install, a preview branch —
 * degrades on every surface INCLUDING `platform`. Failing closed there
 * would lock the operator out of their own console permanently on the
 * day they first deploy, which is not a security control, it is a brick.
 * The distinction is carried explicitly as `reason` in
 * `lib/edge/limits.ts`; it is not inferable from an exception.
 *
 * ⚠️ AND THERE IS A DOOR. `EDGE_LIMIT_PLATFORM_FAIL_OPEN=true` degrades
 * the console instead of refusing it. Present because the one scenario
 * where fail-closed is indefensible is "Upstash is down AND staff need
 * the console to respond to that", and an escape hatch that requires a
 * redeploy is not an escape hatch.
 */
export type LimitFailMode = "degraded" | "closed";

export const FAIL_MODE: Readonly<Record<EdgeSurface, LimitFailMode>> = Object.freeze({
  app: "degraded",
  api: "degraded",
  platform: "closed",
});

/* ------------------------------------------------------------------ */
/* REQUEST BODY SIZE                                                   */
/* ------------------------------------------------------------------ */

const KiB = 1024;
const MiB = 1024 * 1024;

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ONE GLOBAL BODY CAP WOULD HAVE BROKEN FILE UPLOAD ON DAY ONE
 * ══════════════════════════════════════════════════════════════════════
 * `app/api/upload/put/route.ts` is the one endpoint in Ordence that
 * legitimately streams tens of megabytes, and it is bounded already —
 * by a signed ticket that pins a per-file ceiling, and by R2 reporting
 * the bytes it actually stored. A blanket 256 KiB cap in middleware
 * would have refused every document a customer uploads, with a 413 that
 * looked like a bug in their browser.
 *
 * So the cap is a TABLE keyed by path prefix, longest-prefix-wins, and
 * the default is the tight one. A route that needs more says so here,
 * next to the reason.
 *
 * ⚠️ THE DEFAULT MUST BE THE TIGHT NUMBER, NOT THE LOOSE ONE. A route
 * added next month is protected by forgetting about this file; the
 * failure mode of forgetting is a polite 413 on an oversized request,
 * not an unbounded one.
 */
export type BodyLimitRule = {
  /** Path prefix this rule applies to. */
  prefix: string;
  maxBytes: number;
  /** Why this number. Read at the point of changing it. */
  why: string;
};

export const BODY_LIMIT_RULES: readonly BodyLimitRule[] = Object.freeze([
  {
    prefix: "/api/upload/put",
    maxBytes: 64 * MiB,
    why:
      "The byte receiver. MAX_FILE_BYTES is 50 MiB and the ticket pins a per-file " +
      "ceiling below that; this is a backstop above it, not the real control.",
  },
  {
    prefix: "/api/webhooks",
    maxBytes: 2 * MiB,
    why:
      "Provider payloads. A refused webhook costs a payment (see the `webhook` policy " +
      "in lib/security/rate-limit.ts), so the ceiling is far above any real event — " +
      "Razorpay and Stripe payloads are single-digit KiB — and exists only to stop a " +
      "flood of megabytes being buffered before the HMAC check can reject it.",
  },
  {
    prefix: "/api/mcp",
    maxBytes: 1 * MiB,
    why: "JSON-RPC batches with tool arguments. Larger than a form post, smaller than a file.",
  },
  {
    prefix: "/api/assistant",
    maxBytes: 256 * KiB,
    why:
      "🔴 The most expensive body in the product: every byte becomes prompt tokens we " +
      "are billed for. 256 KiB is roughly 60k tokens, already beyond any sane chat " +
      "history, and an unbounded body here is a denial-of-wallet with no attacker " +
      "required — one runaway client resending its whole history does it.",
  },
  {
    prefix: "/api/telemetry",
    maxBytes: 64 * KiB,
    why: "Matches MAX_INGEST_BODY_BYTES in the route. Web-vitals beacons are ~1 KiB.",
  },
  {
    prefix: "/",
    maxBytes: 512 * KiB,
    why:
      "The default, and it covers server actions as well as API routes. A form post " +
      "with a long note is a few KiB; half a megabyte is already generous.",
  },
]);

/** Longest-prefix-wins lookup. Never returns undefined — `/` always matches. */
export function bodyLimitFor(pathname: string): BodyLimitRule {
  let best: BodyLimitRule = BODY_LIMIT_RULES[BODY_LIMIT_RULES.length - 1]!;
  for (const rule of BODY_LIMIT_RULES) {
    if (pathname.startsWith(rule.prefix) && rule.prefix.length >= best.prefix.length) {
      best = rule;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* EXEMPTIONS                                                          */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 RAILWAY'S HEALTHCHECK HAS TAKEN THIS PRODUCT DOWN ONCE ALREADY
 * ══════════════════════════════════════════════════════════════════════
 * A platform healthcheck polls `/api/health` every few seconds forever,
 * from one address, with no session. Every property that makes it a good
 * probe also makes it look exactly like an attacker to a rate limiter:
 * constant rate, single source, anonymous.
 *
 * When the limiter throttles it, Railway reads the 429 as "the container
 * is unhealthy", kills it, starts a new one, and the new one is throttled
 * too — because the counter is in shared Redis and survives the restart.
 * That is not a degraded service, it is a crash loop the deploy cannot
 * escape, and the rate limiter caused it.
 *
 * The same argument holds, for different reasons, for:
 *
 *   • WEBHOOKS. A provider's retry storm after our own outage is entirely
 *     legitimate traffic, and dropping one is a payment we then chase a
 *     customer for. They keep their own IP-keyed DoS ceiling in
 *     `lib/security/rate-limit.ts`, which is tuned for exactly that.
 *
 *   • CRON AND WORKER ENDPOINTS. A scheduler that gets a 429 does not
 *     retry politely; it skips the run. The symptom is silence — nothing
 *     fails, work simply never happens — which is the hardest class of
 *     fault to notice. They authenticate on a shared secret, so an
 *     anonymous flood is refused a layer earlier and far more cheaply.
 *
 * ⚠️ EXEMPT FROM THE PER-TENANT CEILING ONLY. Body-size limits still
 * apply to all of them, and their own limiters still apply. "Exempt"
 * means "not counted against a workspace's capacity budget", because
 * none of these requests belongs to a workspace.
 */
export const RATE_LIMIT_EXEMPT_PREFIXES: readonly string[] = Object.freeze([
  "/api/health",
  "/api/ready",
  "/api/diag",
  "/api/webhooks",
  "/api/cron",
  "/api/workers",
]);

export function isRateLimitExempt(pathname: string): boolean {
  return RATE_LIMIT_EXEMPT_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/* ------------------------------------------------------------------ */
/* PAGE-SIZE CEILINGS BY PLAN                                          */
/* ------------------------------------------------------------------ */

/**
 * The largest page one request may ask for, by plan.
 *
 * ⚠️ THIS IS A COST CONTROL, NOT A FEATURE GATE, AND THE TWO WOULD BE
 * PRICED DIFFERENTLY. The row count is what turns into Neon compute, JSON
 * serialisation and Worker memory, and an enterprise workspace with two
 * million rows genuinely does need to page 500 at a time when it exports.
 * A trial workspace asking for 500 is a script, not a person.
 *
 * ⚠️ THE ABSOLUTE CEILING IS THE ONE THAT MATTERS. Every one of these is
 * clamped again by `ABSOLUTE_MAX_PAGE_SIZE` in `lib/pagination.ts`, so a
 * future edit here can loosen a plan's cap but cannot remove the bound.
 */
export const PLAN_MAX_PAGE_SIZE: Readonly<Record<PlanTier, number>> = Object.freeze({
  trial: 100,
  basic: 200,
  advanced: 200,
  ai: 500,
  enterprise: 500,
});

export function maxPageSizeForPlan(tier: PlanTier | null | undefined): number {
  if (!tier) return PLAN_MAX_PAGE_SIZE.basic;
  return PLAN_MAX_PAGE_SIZE[tier] ?? PLAN_MAX_PAGE_SIZE.basic;
}
