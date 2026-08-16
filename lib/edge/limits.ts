/**
 * Ordence — Per-Tenant Edge Rate Limiting
 * Version: v1.31.0-alpha (Batch 31)
 * Runtime: Edge AND Node. No `node:` imports, no database client, no
 *          `next/headers` — this module is imported by `middleware.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * `lib/security/rate-limit.ts` is the ANTI-ABUSE limiter: six named
 * policies, one number each, aimed at credential stuffing, token
 * enumeration and denial-of-wallet. It stays exactly as it is and this
 * module does not replace it.
 *
 * This is the CAPACITY limiter. It answers a different question — "is one
 * workspace consuming a share of a shared instance that will hurt every
 * other workspace on it" — and it therefore has a different key (the
 * tenant), a different number per caller (the plan) and a different
 * failure policy per surface (see `FAIL_MODE`).
 *
 * Both run. They are not alternatives.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE IDENTITY IS THE CLERK ORGANISATION, RESOLVED BY THE SESSION
 * ══════════════════════════════════════════════════════════════════════
 * The bucket key must be the thing whose costs are shared — the tenant —
 * and it must be resolved the way every other tenant decision in this
 * request is resolved. `middleware.ts` gets it from `auth()`, the same
 * call that decides whether the request is allowed at all, and it strips
 * every `x-tenant-*` header off the inbound request first
 * (`SPOOFABLE_HEADERS`).
 *
 * ⚠️ IT IS EMPHATICALLY NOT A HEADER, NOT THE HOSTNAME AND NOT A QUERY
 * PARAMETER. Key on anything the client picks and the limit is opt-in:
 * send a fresh `x-tenant-id` per request and every request is the first
 * request of a new workspace. The hostname is nearly as bad — it is
 * client-supplied too, and `middleware.ts` only uses it to decide which
 * tenant is being ASKED for, then refuses when the session disagrees.
 *
 * ⚠️ THE CLERK ORG ID, NOT THE INTERNAL TENANT UUID. The internal uuid
 * requires a database read and the Edge runtime has no database. The org
 * id is 1:1 with it, is server-trusted, and is already the join key in
 * `server/tenant-context.ts`. Keys are prefixed `org:` so that a future
 * caller passing a uuid cannot silently land in the same bucket.
 */

import { Ratelimit } from "@upstash/ratelimit";
/**
 * ⚠️ `@upstash/redis/cloudflare`, NOT `@upstash/redis`.
 *
 * The default entrypoint resolves to `nodejs.mjs`, which touches
 * `process.version`. This module is imported by `middleware.ts`, which
 * runs in the Edge Runtime, and `next build` says so out loud:
 *
 *     A Node.js API is used (process.version at line: 240) which is not
 *     supported in the Edge Runtime.
 *     Import trace: ./node_modules/@upstash/redis/nodejs.mjs
 *                   ./lib/edge/limits.ts
 *
 * ⭐ IT IS ONLY A WARNING, WHICH IS WHY IT SURVIVED. The build completes
 * and the deploy goes green, and the rate limiter is the thing that
 * silently does not work in the runtime it was written for , which is
 * how a per-tenant limit becomes no limit at all with nothing to read.
 * The `/cloudflare` build is the same client over `fetch`, which is what
 * the Edge Runtime has.
 */
import { Redis } from "@upstash/redis/cloudflare";
import type { PlanTier } from "@/db/schema/core";
import {
  budgetFor,
  FAIL_MODE,
  UNKNOWN_PLAN_FALLBACK_TIER,
  type EdgeSurface,
  type SurfaceBudget,
} from "@/lib/edge/budgets";

/* ------------------------------------------------------------------ */
/* RUNTIME ENVIRONMENT                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE SAME INDIRECTION `middleware.ts` USES, FOR THE SAME REASON.
 *
 * Next.js textually substitutes literal `process.env.X` at BUILD time.
 * On Railway and Cloudflare the build machine has no Upstash credentials,
 * so a literal read compiles to `undefined` and the limiter concludes
 * "not configured" on a deployment that is configured perfectly well —
 * which is the quietest possible way for a security control to be absent.
 *
 * Do not "tidy" this into a direct property access.
 */
function readRuntimeEnv(name: string): string | undefined {
  try {
    const bag = process.env as unknown as Record<string, string | undefined>;
    const value = bag?.[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The escape hatch described in `FAIL_MODE`. Read per request, not
 * cached: an operator setting it during an incident must not have to
 * redeploy for it to take effect.
 */
function platformFailOpen(): boolean {
  return readRuntimeEnv("EDGE_LIMIT_PLATFORM_FAIL_OPEN") === "true";
}

/* ------------------------------------------------------------------ */
/* REDIS                                                               */
/* ------------------------------------------------------------------ */

let redisClient: Redis | null = null;
let redisResolved = false;

/**
 * ⚠️ DELIBERATELY NOT `getRedis()` FROM `lib/redis.ts`. That helper reads
 * `process.env.UPSTASH_REDIS_REST_URL` as a literal, which is subject to
 * exactly the build-time substitution described above. Constructing the
 * client here from a runtime lookup means the Edge middleware sees the
 * credentials the Worker actually has. The client class and the
 * dependency are the same; only the lookup differs.
 */
function edgeRedis(): Redis | null {
  if (redisResolved) return redisClient;
  redisResolved = true;

  const url = readRuntimeEnv("UPSTASH_REDIS_REST_URL");
  const token = readRuntimeEnv("UPSTASH_REDIS_REST_TOKEN");
  if (!url || !token) {
    redisClient = null;
    return null;
  }
  try {
    redisClient = new Redis({ url, token });
  } catch {
    redisClient = null;
  }
  return redisClient;
}

/** Is a shared counter configured at all? Distinct from "is it working". */
export function isSharedCounterConfigured(): boolean {
  return edgeRedis() !== null;
}

/* ------------------------------------------------------------------ */
/* THE DECISION                                                        */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ FOUR MODES, NOT A BOOLEAN. "ALLOWED" AND "UNCOUNTED" MUST NOT LOOK
 *    THE SAME TO ANYONE — NOT TO THE CALLER, NOT TO A DASHBOARD, NOT TO
 *    THE PERSON READING THE RESPONSE HEADERS IN DEVTOOLS.
 * ══════════════════════════════════════════════════════════════════════
 * The classic shape of this bug is `try { ... } catch { return true }`:
 * the limiter is dead, every request is allowed, and nothing anywhere
 * says so. Six months later somebody notices Upstash has been
 * unreachable since a token rotation, and the limits have not existed
 * for any of that time.
 *
 * Carrying the mode as a value makes that state a first-class fact that
 * gets a response header, a log line and a row on the settings screen.
 */
export type LimitMode =
  /** A shared counter answered. The number means what it says. */
  | "enforced"
  /** No shared counter; a per-INSTANCE counter answered. Worth less. */
  | "degraded"
  /** Fail-closed surface with no counter: refused on purpose. */
  | "closed"
  /** Deliberately not counted (health checks, webhooks, cron). */
  | "exempt";

export type LimitReason =
  | "ok"
  | "over_budget"
  | "limiter_unavailable"
  | "limiter_not_configured"
  | "exempt_path";

export type EdgeLimitDecision = {
  allowed: boolean;
  surface: EdgeSurface;
  mode: LimitMode;
  reason: LimitReason;
  /** Which plan's budget was applied. Null for the staff console. */
  tier: PlanTier | null;
  /** Where that plan came from — see `resolvePlanTier`. */
  tierSource: "explicit" | "hint" | "fallback" | "n/a";
  limit: number;
  remaining: number;
  /** Seconds until retry. Always >= 1 when refused; 0 when allowed. */
  retryAfterSeconds: number;
};

/* ------------------------------------------------------------------ */
/* THE PLAN HINT                                                       */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ HOW AN EDGE FUNCTION WITH NO DATABASE KNOWS WHAT SOMEONE PAYS
 * ══════════════════════════════════════════════════════════════════════
 * It does not, and it must not pretend to. `tenants.plan_tier` lives in
 * Postgres behind RLS and `middleware.ts` cannot open a connection.
 *
 * So the plan is a HINT, published to Redis by any Node-side path that
 * has already resolved a real tenant context, and read by the Edge. Two
 * properties make this safe to build a limit on:
 *
 *   1. IT IS ONLY EVER USED TO CHOOSE A NUMBER. A wrong or missing hint
 *      changes how many requests a workspace may make. It never changes
 *      who the workspace is, what it may read, or which rows it sees.
 *      Tenant isolation does not depend on it in any way.
 *
 *   2. IT FAILS TOWARDS GENEROUS. A miss uses
 *      `UNKNOWN_PLAN_FALLBACK_TIER`, argued at its definition.
 *
 * ⚠️ THE HINT IS A CACHE, NOT A SOURCE OF TRUTH, AND IT HAS A SHORT TTL
 * FOR ONE SPECIFIC REASON: a downgrade must take effect on its own. With
 * no expiry, a workspace that dropped from enterprise to basic would keep
 * the enterprise ceiling until something happened to overwrite the key —
 * i.e. potentially forever, since nothing deletes it. Fifteen minutes
 * bounds that, cheaply.
 *
 * ⚠️ AN UPGRADE IS NOT SYMMETRICAL AND DOES NOT WAIT FIFTEEN MINUTES.
 * Any Node request from that workspace republishes the hint, and the
 * customer who just upgraded is by definition using the product.
 */
const PLAN_HINT_TTL_SECONDS = 900;

/** In-process memo so a hot path does not pay a Redis GET per request. */
const planHintMemo = new Map<string, { tier: PlanTier; expiresAtMs: number }>();
const PLAN_HINT_MEMO_MS = 60_000;

/**
 * ⚠️ Bounded, like every other in-process map in this file. An unbounded
 * cache keyed by a value an attacker can vary is a memory-exhaustion
 * primitive wearing a performance optimisation's clothes.
 */
const PLAN_HINT_MEMO_MAX = 5_000;

function planHintKey(orgId: string): string {
  return `ordence:edge:plan:${orgId}`;
}

/**
 * Publish a workspace's plan so the Edge can read it.
 *
 * Fire-and-forget by design: this is a cache warm on the side of a real
 * request, and a Redis hiccup must never be the reason a page fails to
 * render. The cost of it silently not happening is one extra request
 * measured against the generous fallback.
 */
export async function publishPlanHint(
  orgId: string | null | undefined,
  tier: PlanTier | null | undefined,
): Promise<void> {
  if (!orgId || !tier) return;
  planHintMemo.set(orgId, { tier, expiresAtMs: Date.now() + PLAN_HINT_MEMO_MS });
  const redis = edgeRedis();
  if (!redis) return;
  try {
    await redis.set(planHintKey(orgId), tier, { ex: PLAN_HINT_TTL_SECONDS });
  } catch {
    /* A cache warm may not break the request it rode in on. */
  }
}

async function readPlanHint(orgId: string, nowMs: number): Promise<PlanTier | null> {
  const memo = planHintMemo.get(orgId);
  if (memo && memo.expiresAtMs > nowMs) return memo.tier;

  const redis = edgeRedis();
  if (!redis) return null;

  try {
    const value = await redis.get<string>(planHintKey(orgId));
    if (!value) return null;
    const tier = value as PlanTier;
    if (planHintMemo.size >= PLAN_HINT_MEMO_MAX) planHintMemo.clear();
    planHintMemo.set(orgId, { tier, expiresAtMs: nowMs + PLAN_HINT_MEMO_MS });
    return tier;
  } catch {
    // Same direction as everywhere else in this file: an unreadable hint
    // is a missing hint, not an error. The caller falls back generously.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* IN-PROCESS FALLBACK COUNTER                                         */
/* ------------------------------------------------------------------ */

/**
 * A sliding-window LOG, not a fixed-window counter — a fixed window lets
 * a caller spend a full budget at 11:59:59 and another at 12:00:00, which
 * is twice the rate at exactly the second an attacker aims for, because
 * the boundary is readable from the `Retry-After` we hand back.
 *
 * ⚠️ PER PROCESS, AND ON A SERVERLESS PLATFORM THAT IS ONE INSTANCE OUT
 * OF MANY. Effective ceiling is `limit x instances`, and memory is lost
 * on every cold start. This is a speed bump. It is written here so the
 * next reader is not tempted to trust it, and it is reported as
 * `mode: "degraded"` so nobody has to read this comment to find out.
 */
const memoryBuckets = new Map<string, number[]>();
const MEMORY_MAX_KEYS = 10_000;

function memoryCheck(
  key: string,
  budget: SurfaceBudget,
  nowMs: number,
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const windowMs = budget.windowSeconds * 1000;
  const cutoff = nowMs - windowMs;
  const hits = (memoryBuckets.get(key) ?? []).filter((t) => t > cutoff);

  if (hits.length >= budget.limit) {
    // Re-insert so an ACTIVE abuser is not the one evicted by their own
    // flood — Map iterates in insertion order and eviction takes the head.
    memoryBuckets.delete(key);
    memoryBuckets.set(key, hits);
    const oldest = hits[0] ?? nowMs;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)),
    };
  }

  hits.push(nowMs);
  memoryBuckets.delete(key);
  memoryBuckets.set(key, hits);

  if (memoryBuckets.size > MEMORY_MAX_KEYS) {
    let evicted = 0;
    const target = Math.ceil(MEMORY_MAX_KEYS * 0.1);
    for (const k of memoryBuckets.keys()) {
      if (evicted >= target) break;
      memoryBuckets.delete(k);
      evicted += 1;
    }
  }

  return { allowed: true, remaining: budget.limit - hits.length, retryAfterSeconds: 0 };
}

/* ------------------------------------------------------------------ */
/* SHARED LIMITERS                                                     */
/* ------------------------------------------------------------------ */

/**
 * One `Ratelimit` per (surface, limit, window) triple rather than per
 * surface, because the limit VARIES BY PLAN and an instance carries its
 * limit internally. Caching per surface alone would apply whichever
 * plan's number happened to construct the instance first — an enterprise
 * customer's 12,000 silently applied to every trial on the box, or worse,
 * the reverse.
 */
const limiterCache = new Map<string, Ratelimit>();

function limiterFor(surface: EdgeSurface, budget: SurfaceBudget): Ratelimit | null {
  const redis = edgeRedis();
  if (!redis) return null;

  const cacheKey = `${surface}:${budget.limit}:${budget.windowSeconds}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(
      budget.limit,
      `${budget.windowSeconds} s` as Parameters<typeof Ratelimit.slidingWindow>[1],
    ),
    // Off deliberately: Upstash's analytics writes a second key per
    // request, which doubles the command count and therefore the bill,
    // for telemetry the response headers already carry.
    analytics: false,
    prefix: "ordence:edge",
  });
  limiterCache.set(cacheKey, limiter);
  return limiter;
}

/* ------------------------------------------------------------------ */
/* DEGRADATION ALARM                                                   */
/* ------------------------------------------------------------------ */

/**
 * Emitted at most once per process. A per-request warning on a
 * misconfigured deployment is a million log lines an hour and it drowns
 * the signal it exists to raise.
 */
let degradedAnnounced = false;

function announceDegraded(reason: LimitReason, detail: string): void {
  if (degradedAnnounced) return;
  degradedAnnounced = true;
  console.warn(
    `[LIMITS] Per-tenant capacity limiting is DEGRADED (${reason}). ` +
      `Per-instance counters mean the effective ceiling is (limit x instances) ` +
      `and it resets on every cold start. Configure UPSTASH_REDIS_REST_URL and ` +
      `UPSTASH_REDIS_REST_TOKEN. Detail: ${detail}`,
  );
}

/* ------------------------------------------------------------------ */
/* THE ENTRY POINT                                                     */
/* ------------------------------------------------------------------ */

export type EdgeIdentity =
  /** A workspace. `orgId` is the Clerk organisation id from the session. */
  | { kind: "tenant"; orgId: string }
  /** A member of platform staff. There is no tenant, so the user is the key. */
  | { kind: "staff"; userId: string };

export type CheckEdgeLimitOptions = {
  surface: EdgeSurface;
  identity: EdgeIdentity;
  /**
   * The plan, when the caller already knows it (any Node path that has a
   * `TenantContext`). Skips the hint entirely and is authoritative.
   */
  planTier?: PlanTier | null;
  /** Injected clock. Tests only — production always uses `Date.now()`. */
  nowMs?: number;
  /** Force the per-instance path. Tests only. */
  forceMemory?: boolean;
};

/**
 * Check one request against its workspace's capacity budget.
 *
 * ⚠️ THIS FUNCTION NEVER THROWS. A limiter that throws turns a Redis blip
 * into a 500 on every route it guards, which is a worse outage than the
 * abuse it was installed to prevent. Every failure resolves to a decision
 * whose `mode` says what happened.
 */
export async function checkEdgeLimit(
  options: CheckEdgeLimitOptions,
): Promise<EdgeLimitDecision> {
  const { surface, identity } = options;
  const nowMs = options.nowMs ?? Date.now();

  try {
    /* ---- 1. Which plan's budget applies? -------------------------- */
    let tier: PlanTier | null = null;
    let tierSource: EdgeLimitDecision["tierSource"] = "n/a";

    if (surface !== "platform" && identity.kind === "tenant") {
      if (options.planTier) {
        tier = options.planTier;
        tierSource = "explicit";
        // Warm the hint for the Edge, which cannot do this lookup itself.
        void publishPlanHint(identity.orgId, options.planTier);
      } else {
        const hinted = options.forceMemory
          ? null
          : await readPlanHint(identity.orgId, nowMs);
        if (hinted) {
          tier = hinted;
          tierSource = "hint";
        } else {
          tier = UNKNOWN_PLAN_FALLBACK_TIER;
          tierSource = "fallback";
        }
      }
    }

    const budget = budgetFor(tier, surface);

    /**
     * ⚠️ The key namespace is part of the isolation, not decoration. Two
     * surfaces must never share a counter (that is the "one bucket for
     * the console and the customers" mistake), and a staff key must never
     * be able to collide with an org key — hence distinct `org:` / `staff:`
     * prefixes rather than a bare id.
     */
    const key =
      identity.kind === "tenant"
        ? `${surface}:org:${identity.orgId}`
        : `${surface}:staff:${identity.userId}`;

    /* ---- 2. The shared counter ------------------------------------ */
    const limiter = options.forceMemory ? null : limiterFor(surface, budget);

    if (limiter) {
      try {
        const result = await limiter.limit(key);
        return {
          allowed: result.success,
          surface,
          mode: "enforced",
          reason: result.success ? "ok" : "over_budget",
          tier,
          tierSource,
          limit: budget.limit,
          remaining: Math.max(0, result.remaining),
          // Clamped to >= 1 when refused. `Retry-After: 0` is an
          // invitation to retry immediately, i.e. a hot loop against the
          // endpoint we are trying to protect.
          retryAfterSeconds: result.success
            ? 0
            : Math.max(1, Math.ceil((result.reset - nowMs) / 1000)),
        };
      } catch (err) {
        /* ══════════════════════════════════════════════════════════
         * 🔴 CONFIGURED BUT UNREACHABLE. THE FAIL DECISION HAPPENS
         *    HERE, EXPLICITLY, AND IT DIFFERS BY SURFACE.
         * ══════════════════════════════════════════════════════════
         * Argued at length in `FAIL_MODE` (lib/edge/budgets.ts). The
         * short version: the tenant surfaces degrade because refusing
         * ten thousand customers to defend a capacity ceiling is a
         * self-inflicted outage; the staff console refuses because a
         * dozen people seeing a 503 is cheaper than an uncounted
         * cross-tenant console.
         */
        announceDegraded(
          "limiter_unavailable",
          err instanceof Error ? err.message : String(err),
        );

        if (FAIL_MODE[surface] === "closed" && !platformFailOpen()) {
          return {
            allowed: false,
            surface,
            mode: "closed",
            reason: "limiter_unavailable",
            tier,
            tierSource,
            limit: budget.limit,
            remaining: 0,
            // Short, because this is a transient dependency failure and
            // the operator is a person waiting to get back into a console.
            retryAfterSeconds: 5,
          };
        }
        return degradedDecision(surface, key, budget, tier, tierSource, nowMs, "limiter_unavailable");
      }
    }

    /* ---- 3. No shared counter configured at all -------------------- */
    /**
     * ⚠️ A DIFFERENT SITUATION FROM THE ONE ABOVE, AND IT GETS A
     * DIFFERENT ANSWER EVEN ON THE FAIL-CLOSED SURFACE.
     *
     * "Configured but erroring" is an incident. "Never configured" is a
     * deployment choice — local dev, a preview branch, a self-hosted
     * install — and refusing the staff console there would brick the
     * operator's own console on the day they first deploy, permanently,
     * with a 503 that suggests nothing about the cause. That is not a
     * control, it is a trap.
     */
    if (!options.forceMemory) {
      announceDegraded("limiter_not_configured", "UPSTASH_REDIS_REST_* not set");
    }
    return degradedDecision(
      surface,
      key,
      budget,
      tier,
      tierSource,
      nowMs,
      options.forceMemory ? "ok" : "limiter_not_configured",
    );
  } catch (err) {
    /**
     * Reaching here means a bug in THIS file, not a Redis outage. Allow,
     * loudly, and mark the mode: the alternative is every guarded route
     * returning 429 forever until somebody ships a fix, which is a worse
     * outage than the one being prevented.
     */
    console.error(
      "[LIMITS] checkEdgeLimit() failed internally; allowing and marking degraded.",
      err instanceof Error ? err.message : String(err),
    );
    const budget = budgetFor(null, options.surface);
    return {
      allowed: true,
      surface: options.surface,
      mode: "degraded",
      reason: "limiter_unavailable",
      tier: null,
      tierSource: "fallback",
      limit: budget.limit,
      remaining: budget.limit,
      retryAfterSeconds: 0,
    };
  }
}

function degradedDecision(
  surface: EdgeSurface,
  key: string,
  budget: SurfaceBudget,
  tier: PlanTier | null,
  tierSource: EdgeLimitDecision["tierSource"],
  nowMs: number,
  reason: LimitReason,
): EdgeLimitDecision {
  const memory = memoryCheck(key, budget, nowMs);
  return {
    allowed: memory.allowed,
    surface,
    mode: "degraded",
    reason: memory.allowed ? reason : "over_budget",
    tier,
    tierSource,
    limit: budget.limit,
    remaining: memory.remaining,
    retryAfterSeconds: memory.retryAfterSeconds,
  };
}

/** A decision for a path that is deliberately not counted. */
export function exemptDecision(surface: EdgeSurface): EdgeLimitDecision {
  return {
    allowed: true,
    surface,
    mode: "exempt",
    reason: "exempt_path",
    tier: null,
    tierSource: "n/a",
    limit: 0,
    remaining: 0,
    retryAfterSeconds: 0,
  };
}

/* ------------------------------------------------------------------ */
/* OBSERVABILITY                                                       */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A LIMIT THAT CANNOT BE OBSERVED CANNOT BE TUNED
 * ══════════════════════════════════════════════════════════════════════
 * These headers go on EVERY response the limiter touches, not only on the
 * 429. The 429 is the moment it is already too late to be useful; what a
 * support engineer needs is "you were at 11,400 of 12,000 all morning",
 * which is only visible if the position is published while things are
 * still fine.
 *
 * ⚠️ AUTHENTICATED CALLERS ONLY, AND THAT IS A REAL RULE RATHER THAN
 * CAUTION. Publishing the exact limit, the exact remaining budget and the
 * exact refill moment to an anonymous caller hands them a calibration
 * API: they stop probing for the threshold and simply read it, then run
 * permanently at 99% of it. Everything below is scoped to a request that
 * has already proved which workspace it belongs to, so the information is
 * about the reader's own budget.
 *
 * `x-ordence-limit-mode` is the one that matters most and the one nobody
 * would think to add: it is how "the limiter is working" and "the limiter
 * has been silently dead since a token rotation" stop looking identical.
 */
export function edgeLimitHeaders(decision: EdgeLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ordence-limit-mode": decision.mode,
    "x-ordence-limit-surface": decision.surface,
  };

  if (decision.mode !== "exempt") {
    headers["x-ratelimit-limit"] = String(decision.limit);
    headers["x-ratelimit-remaining"] = String(decision.remaining);
    if (decision.tier) headers["x-ordence-limit-tier"] = decision.tier;
  }
  if (!decision.allowed) {
    headers["retry-after"] = String(Math.max(1, decision.retryAfterSeconds));
  }
  return headers;
}

/**
 * The body of a refusal, as a plain object so this module keeps no
 * dependency on `next/server` and stays unit-testable without a request.
 *
 * ⚠️ IT STATES A REASON. A bare 429 with an empty body is the difference
 * between a customer's integration author fixing their retry loop in ten
 * minutes and opening a support ticket that takes three days. The reason
 * is a category, never a count — see the header note above for why the
 * numbers are not in here.
 */
export function edgeLimitBody(decision: EdgeLimitDecision): {
  error: { code: string; message: string };
} {
  if (decision.mode === "closed") {
    return {
      error: {
        code: "limiter_unavailable",
        message:
          "The rate limiter is temporarily unreachable and this console refuses " +
          "requests it cannot account for. Retry shortly.",
      },
    };
  }
  return {
    error: {
      code: "workspace_rate_limit",
      message:
        "This workspace has exceeded its request budget for the current minute. " +
        "The budget is set by your plan. Retry after the interval in the Retry-After header.",
    },
  };
}

/** The HTTP status for a refusal. 503 for fail-closed; 429 for over-budget. */
export function edgeLimitStatus(decision: EdgeLimitDecision): number {
  return decision.mode === "closed" ? 503 : 429;
}

/* ------------------------------------------------------------------ */
/* READING THE POSITION WITHOUT MOVING IT                              */
/* ------------------------------------------------------------------ */

export type EdgeLimitPosition = {
  surface: EdgeSurface;
  tier: PlanTier | null;
  limit: number;
  /** Null when there is no shared counter to read. */
  remaining: number | null;
  /** Epoch ms when the window refills, or null. */
  resetAtMs: number | null;
  mode: LimitMode;
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A LIMIT NOBODY CAN SEE IS A LIMIT NOBODY CAN TUNE — OR TRUST
 * ══════════════════════════════════════════════════════════════════════
 * Response headers publish the position to whoever made the request.
 * That is enough for an integration author debugging their own client
 * and useless for the two questions that actually get asked:
 *
 *   "Are we anywhere near this?"  — asked by a customer's admin before
 *   they buy more seats, and by us before we tune a number.
 *
 *   "Is the limiter even working?" — asked after an incident, and
 *   answered wrongly by every design where "unlimited" and "well within
 *   limits" produce the same evidence.
 *
 * ⚠️ `getRemaining` READS AND DOES NOT INCREMENT. Using `limit()` to
 * render a dashboard would make opening the page consume the budget the
 * page exists to report — a meter that moves because you looked at it,
 * and a support engineer refreshing during an incident would push a
 * struggling workspace over its own ceiling.
 *
 * ⚠️ RETURNS `remaining: null` RATHER THAN A ZERO OR A FULL BUDGET WHEN
 * THERE IS NO COUNTER. "Not measured" and "measured as fine" must never
 * render as the same number on a screen someone makes a decision from.
 */
export async function peekEdgeLimit(
  surface: EdgeSurface,
  identity: EdgeIdentity,
  planTier?: PlanTier | null,
): Promise<EdgeLimitPosition> {
  const tier = surface === "platform" ? null : (planTier ?? null);
  const budget = budgetFor(tier, surface);
  const key =
    identity.kind === "tenant"
      ? `${surface}:org:${identity.orgId}`
      : `${surface}:staff:${identity.userId}`;

  const limiter = limiterFor(surface, budget);
  if (!limiter) {
    return {
      surface,
      tier,
      limit: budget.limit,
      remaining: null,
      resetAtMs: null,
      mode: "degraded",
    };
  }

  try {
    const { remaining, reset } = await limiter.getRemaining(key);
    return {
      surface,
      tier,
      limit: budget.limit,
      remaining: Math.max(0, remaining),
      resetAtMs: reset,
      mode: "enforced",
    };
  } catch {
    // A dashboard that cannot read the counter reports that it cannot
    // read the counter. It does not invent a number.
    return {
      surface,
      tier,
      limit: budget.limit,
      remaining: null,
      resetAtMs: null,
      mode: "degraded",
    };
  }
}

/* ------------------------------------------------------------------ */
/* TEST SUPPORT                                                        */
/* ------------------------------------------------------------------ */

/**
 * Clear every piece of limiter state.
 *
 * ⚠️ Prefixed `__` and documented as test-only because calling it in a
 * request path would hand every currently-throttled caller a fresh
 * budget — an attacker's dream if it ever reaches an HTTP handler.
 */
export function __resetEdgeLimitsForTests(): void {
  memoryBuckets.clear();
  limiterCache.clear();
  planHintMemo.clear();
  redisClient = null;
  redisResolved = false;
  degradedAnnounced = false;
}

export function __edgeMemoryKeyCountForTests(): number {
  return memoryBuckets.size;
}
