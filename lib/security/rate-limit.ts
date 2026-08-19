/**
 * Ordence — Rate Limiting
 * Version: v0.12.0-alpha (Phase 20)
 *
 * Closes SEC-005 (no limit on search / webhook / upload),
 *        SEC-020 (no limit on `/portal/[token]`),
 *        SEC-024 (no limit on the billing webhook endpoints).
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS FOR, PRECISELY
 * ══════════════════════════════════════════════════════════════════════
 * Not "load shedding". Every policy below exists because a specific attack
 * on THIS application is cheap without it:
 *
 *   auth    Credential stuffing. A leaked password list is tried against our
 *           sign-in surface at whatever rate we will accept. Ten attempts a
 *           minute makes a 100k-password list take 7 days per account and
 *           makes the attempt visible in `security_events`; unlimited makes
 *           it take minutes and produces nothing to look at.
 *
 *   portal  Token enumeration AND link-sharing abuse. See the long note on
 *           keying below — this is the subtlest policy in the file.
 *
 *   search  Data exfiltration by iteration. Search is the one authenticated
 *           endpoint that will happily read a large slice of a tenant's CRM
 *           and return it, so a compromised session with no limit drains the
 *           account as fast as the network allows. It also has the worst
 *           cost profile of any query we run.
 *
 *   upload  Storage-cost denial of wallet. Uploads are billed by the byte in
 *           Vercel Blob; an authenticated user with a script can turn our
 *           storage line item into a five-figure number in an afternoon.
 *
 *   webhook Provider traffic. Deliberately the LOOSEST limit here, and the
 *           reasoning is in its own section below because getting this one
 *           wrong loses money rather than leaking data.
 *
 *   api     A backstop for everything else, so a route added in Phase 25 is
 *           not completely unprotected merely because nobody thought about it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️  WHAT HAPPENS WHEN REDIS IS ABSENT — THE CENTRAL DECISION
 * ══════════════════════════════════════════════════════════════════════
 * `UPSTASH_REDIS_REST_URL` / `_TOKEN` are OPTIONAL in `lib/env.ts`. A local
 * dev machine, a preview deployment and a self-hosted install can all run
 * with no Redis at all. So this module must have an answer for "no shared
 * counter exists" and there are exactly three:
 *
 *   FAIL CLOSED (refuse every request)
 *     Correct for a bank vault, catastrophic here. An unconfigured
 *     environment variable would take the entire product offline for every
 *     user — a self-inflicted total outage, triggered by the security
 *     feature, on the day someone rotates a token and typos it. The blast
 *     radius of the mistake is larger than the blast radius of the attack it
 *     prevents. Rejected.
 *
 *   FAIL OPEN (allow everything)
 *     Honest and simple, but it means an attacker who can make our Redis
 *     unreachable — or who simply finds a deployment where it was never
 *     configured — gets an unlimited login endpoint. Rejected as the whole
 *     answer.
 *
 *   DEGRADE TO PER-INSTANCE MEMORY  ← what this module does
 *     A sliding-window log in process memory, per serverless instance.
 *
 * ⚠️ BE HONEST ABOUT WHAT THE FALLBACK IS WORTH. On Vercel there may be a
 * hundred concurrent instances and a request can land on any of them, so the
 * effective limit is `limit × instances` and an attacker who opens enough
 * parallel connections gets exactly that multiple. Memory is also lost on
 * every cold start. THIS IS A SPEED BUMP, NOT A CONTROL. It stops a naive
 * script and a runaway client loop; it does not stop a distributed attack.
 *
 * That is why the fallback is loud rather than quiet: the first time it is
 * used in a process it emits `rate_limit.degraded` at WARNING severity, so
 * "Redis was never configured in production" is a thing you find in a
 * dashboard rather than a thing you find in an incident review. Silently
 * allowing everything is the failure mode this design refuses.
 *
 * The one policy that is fail-open by choice even here is `webhook` — see
 * below.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS MODULE NEVER THROWS
 * ══════════════════════════════════════════════════════════════════════
 * `checkRateLimit()` returns a decision or, if literally everything inside
 * it fails, an allow. A rate limiter that throws converts a Redis blip into
 * a 500 on every route it guards — which is a worse outage than the abuse it
 * was installed to prevent, and it is the classic way this feature takes a
 * site down. Errors go to stderr; the caller gets a decision.
 *
 * ══════════════════════════════════════════════════════════════════════
 * RUNTIME
 * ══════════════════════════════════════════════════════════════════════
 * No `node:` imports. Upstash speaks HTTP and the key hashing uses WebCrypto
 * (`crypto.subtle`), both of which exist on the Edge runtime — this has to be
 * callable from `middleware.ts`.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { getRedis } from "@/lib/redis";

/* ------------------------------------------------------------------ */
/* POLICIES                                                            */
/* ------------------------------------------------------------------ */

export const RATE_LIMIT_POLICIES = [
  "auth",
  "search",
  "upload",
  "portal",
  "webhook",
  "api",
] as const;

export type RateLimitPolicy = (typeof RATE_LIMIT_POLICIES)[number];

type PolicyConfig = {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * When Redis is unavailable, does this policy still enforce in memory?
   *
   * `false` means "allow everything rather than risk a false positive". It is
   * set for exactly one policy and the justification is written at that line.
   */
  enforceWhenDegraded: boolean;
  /** Why this number. Read at the point of tuning it. */
  rationale: string;
};

export const POLICY_CONFIG: Record<RateLimitPolicy, PolicyConfig> = {
  /**
   * 10 attempts per minute per (IP + identifier).
   *
   * A human who has genuinely forgotten their password tries three or four
   * times and then clicks "reset". Ten is comfortably above real use and far
   * below what makes a password list worth running.
   */
  auth: {
    limit: 10,
    windowSeconds: 60,
    enforceWhenDegraded: true,
    rationale: "Credential stuffing. Well above human retry, far below useful attack rate.",
  },

  /**
   * 30 searches per minute per tenant-user.
   *
   * Type-ahead is debounced client-side to ~3/s bursts; 30/min accommodates
   * genuinely frantic use. A script iterating the alphabet to reconstruct a
   * contact list runs at thousands per minute and hits this in two seconds.
   */
  search: {
    limit: 30,
    windowSeconds: 60,
    enforceWhenDegraded: true,
    rationale: "Exfiltration by iteration, and the most expensive query we run.",
  },

  /**
   * 20 uploads per 5 minutes per tenant-user.
   *
   * A user attaching a folder of site photographs does 10–15 in a burst. A
   * script filling our storage bill does thousands.
   */
  upload: {
    limit: 20,
    windowSeconds: 300,
    enforceWhenDegraded: true,
    rationale: "Storage-cost denial of wallet; bytes are billed.",
  },

  /**
   * 20 portal requests per minute per (token-hash + IP-prefix). See the
   * keying note below — this number is meaningless without it.
   */
  portal: {
    limit: 20,
    windowSeconds: 60,
    enforceWhenDegraded: true,
    rationale: "Token enumeration and leaked-link abuse on an anonymous surface.",
  },

  /**
   * ══════════════════════════════════════════════════════════════════
   * 600 per minute, and DISABLED when degraded. Read before tightening.
   * ══════════════════════════════════════════════════════════════════
   * `app/api/webhooks/razorpay/route.ts` is public and unauthenticated by
   * necessity — a server-to-server call carries no session — and the HMAC is
   * the auth. Rate limiting it therefore has a property no other policy has:
   * A REJECTION COSTS MONEY.
   *
   * Razorpay reads a 429 as a delivery failure and retries with backoff, and
   * eventually gives up. The event we dropped might be
   * `subscription.charged`. We then believe a customer has not paid when they
   * have, dun them, and suspend an account that is in good standing.
   *
   * AND A RETRY STORM IS LEGITIMATE TRAFFIC. If our own endpoint is briefly
   * down, the provider redelivers everything it queued — hundreds of events
   * in a burst, all real, all needed. A limit tuned to "normal" traffic would
   * throttle precisely the recovery we want to succeed.
   *
   * So the limit here is a DoS ceiling, not a business rule: 600/minute is an
   * order of magnitude above any plausible redelivery burst for a platform of
   * this size, while still bounding an attacker who has found the URL and is
   * pointing a flood at it. Note that a flood of forged payloads is already
   * cheap for us to refuse — the HMAC check is one hash and happens before
   * any database work — so the limiter is protecting the function-invocation
   * bill, not the subscription state. The signature is what protects that.
   *
   * ⚠️ THE KEY IS THE SOURCE IP, NOT THE ENDPOINT. A global counter on the
   * endpoint would let one attacker's flood exhaust the budget and cause OUR
   * PROVIDER'S events to be rejected. That turns a nuisance into lost
   * revenue, and it is the specific mistake this note exists to prevent.
   *
   * ⚠️ `enforceWhenDegraded: false`. With no Redis, the per-instance counter
   * would see only a slice of the provider's traffic and could reject a
   * legitimate burst on a small window of evidence. Given the asymmetry —
   * a missed limit costs some compute, a wrongly-dropped webhook costs a
   * payment — the fallback declines to guess. Signature verification is
   * unaffected and still refuses everything forged.
   */
  webhook: {
    limit: 600,
    windowSeconds: 60,
    enforceWhenDegraded: false,
    rationale:
      "DoS ceiling only. A provider retry storm is legitimate traffic and a 429 loses payments.",
  },

  /**
   * 300 per minute per tenant — the backstop for anything not named above.
   */
  /**
   * ⭐⭐ WAVE 9 — THE RATIONALE ON THIS POLICY WAS FALSE AND IS NOW TRUE.
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 IT USED TO SAY: "Default ceiling so a new route is never
   *    completely unguarded." NOTHING CALLED IT.
   * ══════════════════════════════════════════════════════════════════
   * A grep for `checkRateLimit("api"` returned no call sites anywhere in
   * the product. The sentence described a guarantee this policy did not
   * provide and had never provided.
   *
   * The guarantee itself is real — it is just somewhere else.
   * `lib/edge/budgets.ts` applies a per-plan, per-surface ceiling in
   * MIDDLEWARE, on every request the matcher sees, which is every route
   * including ones nobody has written yet. That is the thing that keeps a
   * new route from being unguarded, and this policy was quietly taking
   * credit for it.
   *
   * ⚠️ WHAT IS LEFT UNGUARDED IS WHAT THE EDGE DELIBERATELY EXEMPTS.
   * `RATE_LIMIT_EXEMPT_PREFIXES` lists six, with reasons: health and
   * readiness (a 429 makes a load balancer kill a healthy instance and
   * the replacement is throttled too — a crash loop the limiter caused),
   * webhooks and cron (which have their own limiters, or a shared
   * secret). `/api/diag` is on that list and had NEITHER: no session, no
   * secret, no limit, and a response that enumerates every configuration
   * name this deployment knows about. That is where this policy now
   * applies, and it is the only place it applies, because it is the only
   * place that was actually unguarded.
   *
   * ⚠️ 300/MINUTE IS LOOSE ON PURPOSE. Diag exists to be reachable when
   * everything else is broken, and a human refreshing it during an
   * incident must never be the one who gets throttled. 300 is far above
   * any human and far below a useful polling oracle.
   *
   * ⚠️ `rateLimitBackendName()` ALSO PROBES THIS POLICY to report which
   * backend is live. That is a diagnostic use, not an enforcement one,
   * and it is not what makes the sentence above true.
   */
  api: {
    limit: 300,
    windowSeconds: 60,
    enforceWhenDegraded: true,
    rationale:
      "The ceiling for /api/diag, the one edge-exempt route with neither a session " +
      "nor a shared secret. The general default is the per-plan edge budget in " +
      "lib/edge/budgets.ts, not this.",
  },
};

/* ------------------------------------------------------------------ */
/* DECISION                                                            */
/* ------------------------------------------------------------------ */

export type RateLimitDecision = {
  allowed: boolean;
  /**
   * Seconds until the caller may retry. 0 when allowed.
   * Always >= 1 when denied — a `Retry-After: 0` invites an immediate retry,
   * which is a tight loop rather than a backoff.
   */
  retryAfterSeconds: number;
  policy: RateLimitPolicy;
  limit: number;
  /** Requests left in the window. Never disclosed to an anonymous caller. */
  remaining: number;
  /**
   * Which counter answered. `"none"` = the policy declined to enforce.
   *
   * ⭐ `"postgres"` ADDED IN WAVE 8. It is not a degraded answer: a fixed
   * window counted in the database is atomic across every instance, which
   * is the property that makes a limit a limit. `"memory"` is the only
   * value that means the number is unknown.
   */
  backend: "redis" | "postgres" | "memory" | "none";
  /**
   * True when the answer came from a per-instance counter, so the
   * effective limit is (limit × instances).
   *
   * ⚠️ NOT "REDIS WAS UNAVAILABLE". After wave 8 Redis being absent is
   * ordinary — the durable Postgres counter answers instead and this stays
   * false, correctly.
   */
  degraded: boolean;
};

/* ------------------------------------------------------------------ */
/* KEY CONSTRUCTION                                                    */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * KEYING IS THE ENTIRE DESIGN. THE NUMBERS ARE THE EASY PART.
 * ══════════════════════════════════════════════════════════════════════
 * A limit applied to the wrong key is either useless or an outage:
 *
 *   Keyed too broadly (per endpoint) → one abusive caller consumes the
 *   budget and everyone else is throttled. That is a denial-of-service
 *   primitive we would have built ourselves and handed to the attacker.
 *
 *   Keyed too narrowly (per session) → the attacker discards the session
 *   between requests and the limit never applies to anything.
 *
 * The rule this file follows:
 *
 *   • AUTHENTICATED SURFACES are keyed by TENANT + USER. The tenant prefix
 *     is not decoration — it guarantees two tenants cannot collide in the
 *     keyspace, so tenant A's traffic can never exhaust tenant B's budget.
 *     That is the multi-tenant equivalent of the "keyed too broadly" failure
 *     and it would be a cross-tenant availability leak.
 *
 *   • ANONYMOUS SURFACES are keyed by IP, because there is nothing else.
 *
 *   • THE PORTAL IS KEYED BY BOTH, and that needs its own argument.
 */

/** Every key is prefixed so two policies can never share a counter. */
function namespacedKey(policy: RateLimitPolicy, key: string): string {
  return `rl:${policy}:${key}`;
}

/**
 * Key for an authenticated request.
 *
 * ⚠️ `tenantId` FIRST AND MANDATORY. If this were keyed on the user id alone
 * it would still be correct today (user ids are globally unique uuids), and
 * it would silently break the moment any identifier becomes tenant-scoped.
 * The prefix makes cross-tenant collision structurally impossible rather
 * than accidentally absent.
 */
export function tenantRateLimitKey(tenantId: string, userId?: string | null): string {
  if (!tenantId) {
    // Mirrors `tenantKey()` in lib/redis.ts. An empty tenant would produce a
    // key shared by every tenant that also passed an empty one.
    throw new Error("[SECURITY] tenantRateLimitKey() requires a tenant id.");
  }
  return `t:${tenantId}:u:${userId ?? "anon"}`;
}

/** Key for an anonymous request. `ip` may be null behind a broken proxy. */
export function ipRateLimitKey(ip: string | null | undefined): string {
  // A null IP collapses every unidentifiable caller into one bucket. That is
  // the safe direction: it cannot punish an identifiable user, and it stops
  // "strip the header" from being a bypass.
  return `ip:${normaliseIp(ip)}`;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * PORTAL KEYING — WHY IT IS BOTH TOKEN AND IP
 * ══════════════════════════════════════════════════════════════════════
 * `/portal/[token]` is reached by clients of our customers: an architect, a
 * buyer's solicitor, a bank. Neither obvious key works alone.
 *
 *   KEY BY IP ONLY. A firm behind one NAT gateway — which is most law firms
 *   and every construction company on site wifi — shares a single address.
 *   Six people opening the same contract at 10am exhausts the budget and the
 *   seventh sees a 429 on a link we sent them. We have broken the product for
 *   a legitimate customer to defend against nothing: an attacker enumerating
 *   tokens simply rotates IPs, which is cheap.
 *
 *   KEY BY TOKEN ONLY. Now each token gets its own budget — so an attacker
 *   guessing tokens gets a FRESH budget for every guess, because each guess
 *   is a different key. The limit is exactly zero protection against the
 *   attack it was installed for.
 *
 * So: BOTH, as a compound key.
 *
 *   • The token component means one leaked link being hammered is contained
 *     without touching anyone else's link.
 *   • The IP component means a single source enumerating tokens is counted as
 *     one source no matter how many tokens it tries — because the second
 *     dimension is the IP PREFIX, not the token.
 *
 * Callers should therefore check TWO keys on this surface (see
 * `docs/PHASE-20-NOTES.md`): the compound key, and a token-independent
 * IP-prefix key. The compound key alone still resets per token.
 *
 * ⚠️ THE RAW TOKEN NEVER BECOMES A REDIS KEY. It is a live 256-bit
 * credential. Redis keys appear in `MONITOR` output, in slow-log entries, in
 * Upstash's own console and in any error message that echoes the key. A
 * SHA-256 of the token is just as unique for counting and is worthless if
 * disclosed.
 *
 * The IP component is a /24 (v4) or /64 (v6) PREFIX rather than the exact
 * address, because a mobile client's address changes between requests while
 * its prefix usually does not, and because an attacker with a /64 of IPv6 —
 * i.e. anyone with a VPS — would otherwise have 18 quintillion free buckets.
 */
export async function portalRateLimitKey(
  rawToken: string,
  ip: string | null | undefined,
): Promise<string> {
  const tokenHash = await sha256Hex(rawToken);
  // 16 hex chars = 64 bits of the digest. Collision-free at any realistic
  // token count, and shorter keys are cheaper in Redis.
  return `pt:${tokenHash.slice(0, 16)}:net:${ipPrefix(ip)}`;
}

/** Token-independent portal key: catches enumeration across many tokens. */
export function portalSourceRateLimitKey(ip: string | null | undefined): string {
  return `net:${ipPrefix(ip)}`;
}

/**
 * Webhook key: the SOURCE, never the endpoint.
 * See the `webhook` policy note — a shared endpoint counter would let an
 * attacker starve the provider's own budget.
 */
export function webhookRateLimitKey(
  provider: string,
  ip: string | null | undefined,
): string {
  return `wh:${provider}:ip:${normaliseIp(ip)}`;
}

/* --- IP helpers ---------------------------------------------------- */

function normaliseIp(ip: string | null | undefined): string {
  if (!ip) return "unknown";
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed) return "unknown";
  // Bound the length: this value is attacker-controlled in general and ends
  // up in a Redis key. A 10KB "IP" is a memory-amplification attempt.
  return trimmed.slice(0, 45);
}

/**
 * Collapse an address to its network prefix: /24 for IPv4, /64 for IPv6.
 * Rationale in the portal keying note above.
 */
export function ipPrefix(ip: string | null | undefined): string {
  const addr = normaliseIp(ip);
  if (addr === "unknown") return "unknown";

  if (addr.includes(":")) {
    // IPv6 — first four hextets is the /64 that a customer is allocated.
    const parts = addr.split(":");
    return parts.slice(0, 4).join(":") + "::/64";
  }

  const octets = addr.split(".");
  if (octets.length === 4) {
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  return addr;
}

/** SHA-256 via WebCrypto — available in Node 18+, Edge and the browser. */
async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------------ */
/* IN-MEMORY FALLBACK                                                  */
/* ------------------------------------------------------------------ */

/**
 * A sliding-window LOG, not a fixed-window counter.
 *
 * A fixed window lets a caller send `limit` requests at 11:59:59 and another
 * `limit` at 12:00:00 — double the intended rate at exactly the moment an
 * attacker will aim for, because window boundaries are guessable from the
 * `Retry-After` we hand back. Storing timestamps costs a few bytes and has
 * no boundary.
 *
 * ⚠️ PER PROCESS. On a serverless platform this is one instance out of
 * however many are warm. Stated again here because the next person to read
 * this code will be tempted to trust it.
 */
type MemoryBucket = number[];

const memoryBuckets = new Map<string, MemoryBucket>();

/**
 * Hard cap on distinct keys held in memory.
 *
 * Without it, an attacker rotating IPs creates an unbounded Map inside our
 * function instance and turns the rate limiter into the memory-exhaustion
 * vector. When the cap is hit the OLDEST-TOUCHED keys are dropped — those are
 * the idle ones, so an active abuser's bucket survives the eviction that
 * their own flood triggered.
 */
const MEMORY_MAX_KEYS = 10_000;

function memoryCheck(
  key: string,
  limit: number,
  windowSeconds: number,
  nowMs: number,
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const windowMs = windowSeconds * 1000;
  const cutoff = nowMs - windowMs;

  const existing = memoryBuckets.get(key) ?? [];
  const hits = existing.filter((t) => t > cutoff);

  if (hits.length >= limit) {
    // Refresh position in the Map so an active abuser is not evicted.
    memoryBuckets.delete(key);
    memoryBuckets.set(key, hits);

    const oldest = hits[0] ?? nowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  hits.push(nowMs);
  memoryBuckets.delete(key);
  memoryBuckets.set(key, hits);

  if (memoryBuckets.size > MEMORY_MAX_KEYS) {
    // Map iterates in insertion order, so the first entries are the
    // least-recently-touched. Evict a slice rather than one, so this does not
    // run on every single request once the cap is reached.
    const evictCount = Math.ceil(MEMORY_MAX_KEYS * 0.1);
    let evicted = 0;
    for (const k of memoryBuckets.keys()) {
      if (evicted >= evictCount) break;
      memoryBuckets.delete(k);
      evicted += 1;
    }
  }

  return { allowed: true, remaining: limit - hits.length, retryAfterSeconds: 0 };
}

/* ------------------------------------------------------------------ */
/* REDIS LIMITERS                                                      */
/* ------------------------------------------------------------------ */

/**
 * One `Ratelimit` instance per policy, built lazily and cached.
 *
 * Constructing one per request would be wasteful, and — more importantly —
 * `@upstash/ratelimit`'s ephemeral cache (its own short-circuit for keys
 * already known to be blocked) lives on the instance and is worthless if the
 * instance is thrown away every time.
 */
const limiterCache = new Map<RateLimitPolicy, Ratelimit | null>();

function getLimiter(policy: RateLimitPolicy): Ratelimit | null {
  const cached = limiterCache.get(policy);
  if (cached !== undefined) return cached;

  const redis = getRedis();
  if (!redis) {
    limiterCache.set(policy, null);
    return null;
  }

  const config = POLICY_CONFIG[policy];

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(
      config.limit,
      `${config.windowSeconds} s` as Parameters<typeof Ratelimit.slidingWindow>[1],
    ),
    // Off deliberately: Upstash analytics writes an extra key per request,
    // which doubles the command count (and the bill) for telemetry we already
    // record ourselves in `security_events`.
    analytics: false,
    prefix: "ordence:rl",
  });

  limiterCache.set(policy, limiter);
  return limiter;
}

/* ------------------------------------------------------------------ */
/* DEGRADATION ALARM                                                   */
/* ------------------------------------------------------------------ */

/**
 * Emitted at most once per process. The concrete failure this shape prevents:
 * a production deployment with no Redis produces one `rate_limit.degraded`
 * event per REQUEST, which is a million rows an hour in an append-only table
 * that cannot be cleaned up, and the alarm drowns the signal it was meant to
 * raise.
 */
let degradedNotified = false;

type DegradationListener = (info: {
  policy: RateLimitPolicy;
  reason: "not_configured" | "redis_error";
  message: string;
}) => void;

let degradationListener: DegradationListener | null = null;

/**
 * Register a callback invoked the FIRST time the limiter degrades.
 *
 * A callback rather than a direct `recordSecurityEvent()` call because this
 * module must stay importable from Edge middleware, and the recorder pulls in
 * the database client. Wire it up in a Node-only entry point — see
 * `docs/PHASE-20-NOTES.md`.
 */
export function onRateLimitDegraded(listener: DegradationListener | null): void {
  degradationListener = listener;
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE DURABLE BACKEND — WAVE 8                                  */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `notifyDegraded` above says it plainly: *"Per-instance memory counters
 * are a speed bump, not a control: on a serverless deployment the
 * effective limit is (limit × instances)."* That was true of this
 * deployment, because `UPSTASH_REDIS_REST_*` is not set.
 *
 * ⭐ THE DATABASE IS ALREADY ON EVERY REQUEST. A fixed-window counter in
 * Postgres — `ordence_rate_limit_hit`, SQL 0119 — is one statement and is
 * atomic across every instance, which is the entire property the memory
 * counter lacks.
 *
 * ⚠️ INJECTED, FOR THE SAME REASON `onRateLimitDegraded` IS. This module
 * must stay importable from Edge middleware, and the database client is
 * not. `server/security/rate-limit-durable.ts` registers the
 * implementation from `instrumentation.ts`, which runs once per Node
 * process.
 */
export type DurableCounter = (
  policy: RateLimitPolicy,
  key: string,
  nowMs: number,
) => Promise<number>;

let durableCounter: DurableCounter | null = null;

export function registerDurableCounter(counter: DurableCounter | null): void {
  durableCounter = counter;
}

/** True when a cross-instance counter is available. Read by `/api/diag`. */
export function hasDurableCounter(): boolean {
  return durableCounter !== null;
}

/**
 * ⚠️ THE ORDER IS REDIS, THEN POSTGRES, THEN MEMORY, and it is a
 * preference rather than a fallback chain of equals:
 *
 *   redis     ~1ms, purpose-built, needs a service the operator buys
 *   postgres  ⭐ correct, always present, one round trip on a connection
 *             the request already holds
 *   memory    🔴 per-instance. A speed bump. The last resort, and after
 *             wave 8 it is reached only when the database itself is down
 *             — at which point the request was going to fail anyway.
 */
export function rateLimitBackendName(): "redis" | "postgres" | "memory" {
  /**
   * ⚠️ `getLimiter` RATHER THAN READING THE ENVIRONMENT DIRECTLY. It is
   * the same function `checkRateLimit` uses to decide, and a second
   * reading of the same condition is a second thing to keep in step —
   * which is how a diagnostic ends up reporting a backend the limiter is
   * not actually using.
   */
  if (getLimiter("api")) return "redis";
  if (durableCounter) return "postgres";
  return "memory";
}

function notifyDegraded(
  policy: RateLimitPolicy,
  reason: "not_configured" | "redis_error",
  message: string,
): void {
  if (degradedNotified) return;
  degradedNotified = true;

  console.warn(
    `[SECURITY] Rate limiter is running WITHOUT Redis (${reason}). ` +
      `Per-instance memory counters are a speed bump, not a control: on a ` +
      `serverless deployment the effective limit is (limit × instances). ` +
      `Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. ` +
      `Detail: ${message}`,
  );

  try {
    degradationListener?.({ policy, reason, message });
  } catch {
    // A broken listener must not break the request. This function exists to
    // report a problem; it may not create one.
  }
}

/* ------------------------------------------------------------------ */
/* THE PUBLIC ENTRY POINT                                              */
/* ------------------------------------------------------------------ */

export type CheckOptions = {
  /**
   * Injected clock, for tests only. Production always uses `Date.now()`.
   * Present because a rate limiter tested with real sleeps is a test suite
   * that takes minutes and is flaky at the boundary — and the boundary is
   * exactly where the bugs are.
   */
  nowMs?: number;
  /** Force the memory path. Tests use this to exercise the fallback. */
  forceMemory?: boolean;
};

/**
 * Check a request against a named policy.
 *
 * NEVER THROWS. On any internal failure it allows the request and logs — see
 * the module header for why that direction was chosen.
 *
 * @example
 *   const decision = await checkRateLimit("search", tenantRateLimitKey(t, u));
 *   if (!decision.allowed) return tooManyRequests(decision);
 */
export async function checkRateLimit(
  policy: RateLimitPolicy,
  key: string,
  options: CheckOptions = {},
): Promise<RateLimitDecision> {
  const config = POLICY_CONFIG[policy];

  const base = {
    policy,
    limit: config.limit,
  } as const;

  try {
    const fullKey = namespacedKey(policy, key);
    const limiter = options.forceMemory ? null : getLimiter(policy);

    /* ---- Redis path ------------------------------------------------ */
    if (limiter) {
      try {
        const result = await limiter.limit(fullKey);

        // `reset` is an absolute epoch ms. Clamp to >= 1s when denied: a
        // `Retry-After: 0` is an invitation to retry immediately, i.e. a hot
        // loop against the endpoint we are trying to protect.
        const retryAfterSeconds = result.success
          ? 0
          : Math.max(1, Math.ceil((result.reset - (options.nowMs ?? Date.now())) / 1000));

        return {
          ...base,
          allowed: result.success,
          retryAfterSeconds,
          remaining: Math.max(0, result.remaining),
          backend: "redis",
          degraded: false,
        };
      } catch (err) {
        // Redis was configured but is unreachable or erroring. Drop to memory
        // rather than 500 the route.
        notifyDegraded(
          policy,
          "redis_error",
          err instanceof Error ? err.message : String(err),
        );
      }
    } else if (!options.forceMemory) {
      notifyDegraded(policy, "not_configured", "UPSTASH_REDIS_REST_* not set");
    }

    /* ---- Degraded path --------------------------------------------- */

    if (!config.enforceWhenDegraded) {
      // Only `webhook`. Justified at its policy definition: a wrongly-dropped
      // provider event costs a payment, and a per-instance counter sees too
      // little of the traffic to make that call safely.
      return {
        ...base,
        allowed: true,
        retryAfterSeconds: 0,
        remaining: config.limit,
        backend: "none",
        degraded: true,
      };
    }

    /* ---- ⭐⭐⭐ THE DURABLE PATH — WAVE 8 ------------------------ */

    /**
     * 🔴 TRIED BEFORE MEMORY, AND IT IS NOT A "DEGRADED" ANSWER.
     * A Postgres fixed-window counter is atomic across every instance,
     * which is the property that makes a limit a limit. `degraded: false`
     * is therefore the honest flag — the control is working, on a
     * different backend from the one the policy was written against.
     */
    if (durableCounter && !options.forceMemory) {
      try {
        const nowMs = options.nowMs ?? Date.now();
        const hits = await durableCounter(policy, key, nowMs);
        const windowMs = config.windowSeconds * 1000;
        const windowEnd = (Math.floor(nowMs / windowMs) + 1) * windowMs;
        const allowed = hits <= config.limit;

        return {
          ...base,
          allowed,
          /** ⚠️ Never 0 on a denial. A `Retry-After: 0` is a hot loop. */
          retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((windowEnd - nowMs) / 1000)),
          remaining: Math.max(0, config.limit - hits),
          backend: "postgres",
          degraded: false,
        };
      } catch (err) {
        /**
         * ⚠️ THE DATABASE BEING UNREACHABLE IS NOT A REASON TO 500 A
         * ROUTE THAT WAS ONLY BEING COUNTED. Fall to memory and say so —
         * and at that point the request's own work is about to fail for
         * the same reason anyway.
         */
        notifyDegraded(
          policy,
          "redis_error",
          `the durable counter failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const memory = memoryCheck(
      fullKey,
      config.limit,
      config.windowSeconds,
      options.nowMs ?? Date.now(),
    );

    return {
      ...base,
      allowed: memory.allowed,
      retryAfterSeconds: memory.retryAfterSeconds,
      remaining: memory.remaining,
      backend: "memory",
      degraded: true,
    };
  } catch (err) {
    // Reaching here means the limiter itself is broken — a bug in this file,
    // not a Redis outage. Allowing is the lesser harm: the alternative is
    // every guarded route returning 429 forever until someone deploys a fix.
    console.error(
      "[SECURITY] checkRateLimit() failed internally; allowing the request.",
      err instanceof Error ? err.message : String(err),
    );
    return {
      ...base,
      allowed: true,
      retryAfterSeconds: 0,
      remaining: config.limit,
      backend: "none",
      degraded: true,
    };
  }
}

/* ------------------------------------------------------------------ */
/* RESPONSE SHAPE                                                      */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * A 429 MUST NOT TEACH THE ATTACKER ANYTHING
 * ══════════════════════════════════════════════════════════════════════
 * The convenient response — `{"error":"rate limit exceeded","policy":"auth",
 * "limit":10,"remaining":0,"reset":1754...}` — hands an anonymous caller a
 * free calibration API. They learn the exact limit, the exact window and the
 * exact moment the budget refills, which turns "find the threshold by
 * probing" into "read it from the response" and lets them run permanently at
 * 99% of our limit.
 *
 * `X-RateLimit-Limit` / `-Remaining` are genuinely useful to a logged-in
 * user's own client, which is why they are emitted ONLY when the caller is
 * authenticated — at that point they already know who they are, and the
 * information is about their own budget.
 *
 * `Retry-After` is always sent, to everyone. It is required for a
 * well-behaved client (and for the provider retry logic on webhooks) and it
 * leaks only the tail of the current window, not the policy.
 *
 * The BODY carries no detail at any time. Not which policy, not the counts.
 */
export function rateLimitHeaders(
  decision: RateLimitDecision,
  options: { authenticated: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (!decision.allowed) {
    headers["Retry-After"] = String(decision.retryAfterSeconds);
  }

  if (options.authenticated) {
    headers["X-RateLimit-Limit"] = String(decision.limit);
    headers["X-RateLimit-Remaining"] = String(decision.remaining);
  }

  return headers;
}

/**
 * The canonical 429 body. Deliberately three words and no structure.
 *
 * Returned as a plain object rather than a `NextResponse` so this module has
 * no `next/server` dependency and stays unit-testable without a request
 * context. Route handlers wrap it — see the notes.
 */
export function rateLimitBody(): { error: string } {
  return { error: "Too many requests" };
}

/* ------------------------------------------------------------------ */
/* TEST SUPPORT                                                        */
/* ------------------------------------------------------------------ */

/**
 * Clear all limiter state.
 *
 * Named with a `__` prefix and documented as test-only because calling it in
 * production would hand every currently-blocked caller a fresh budget — i.e.
 * it is an attacker's dream if it ever reaches an HTTP handler.
 */
export function __resetRateLimitStateForTests(): void {
  memoryBuckets.clear();
  limiterCache.clear();
  degradedNotified = false;
  degradationListener = null;
}

/** Read-only view of the memory store size, for assertions about eviction. */
export function __memoryKeyCountForTests(): number {
  return memoryBuckets.size;
}
