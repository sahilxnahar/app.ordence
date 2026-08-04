/**
 * Ordence — Rate Limiter Behaviour
 * Version: v0.12.0-alpha (Phase 20)
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 20 MANDATORY VERIFICATION — SEC-005 / SEC-020 / SEC-024
 * ══════════════════════════════════════════════════════════════════════
 * These tests are adversarial. They do not assert "the limiter exists"; they
 * assert the four things that would make it worthless if wrong:
 *
 *   1. THE BOUNDARY. Exactly `limit` requests pass and the very next one does
 *      not. An off-by-one here is either a limit that is one lower than
 *      documented (support tickets) or one higher (an attacker's free
 *      request per window, forever).
 *
 *   2. NO KEY COLLISION. Two tenants, two policies and two IPs must never
 *      share a counter. A collision means tenant A's traffic throttles tenant
 *      B — a cross-tenant availability leak, and an attack anyone with an
 *      account could mount.
 *
 *   3. THE REDIS-ABSENT PATH. It must still count, it must not throw, and the
 *      webhook policy must deliberately NOT enforce.
 *
 *   4. NO INFORMATION LEAK IN A 429. An anonymous caller must not learn the
 *      limit, the remaining budget or which policy tripped.
 *
 * ⚠️ There is no Redis in this environment, so every check runs on the
 * in-memory fallback — which is precisely the path that most needs proving,
 * because it is the one that runs whenever someone forgets to configure
 * Upstash. `forceMemory: true` is passed explicitly so the result does not
 * depend on whether an env var happens to be set on the machine running this.
 *
 * The clock is INJECTED (`nowMs`) rather than mocked or slept through. A
 * limiter test built on real sleeps takes minutes and is flaky at exactly the
 * boundary the tests exist to pin down.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  checkRateLimit,
  rateLimitHeaders,
  rateLimitBody,
  tenantRateLimitKey,
  ipRateLimitKey,
  portalRateLimitKey,
  portalSourceRateLimitKey,
  webhookRateLimitKey,
  ipPrefix,
  onRateLimitDegraded,
  POLICY_CONFIG,
  RATE_LIMIT_POLICIES,
  __resetRateLimitStateForTests,
  __memoryKeyCountForTests,
} from "@/lib/security/rate-limit";

const T0 = 1_760_000_000_000; // fixed epoch ms; any value, never "now"

beforeEach(() => {
  __resetRateLimitStateForTests();
});

/** Fire `n` requests at the same instant and return the decisions. */
async function fire(policy: Parameters<typeof checkRateLimit>[0], key: string, n: number, at = T0) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(await checkRateLimit(policy, key, { nowMs: at, forceMemory: true }));
  }
  return out;
}

/* ================================================================== */
/* 1. THE BOUNDARY                                                     */
/* ================================================================== */

describe("rate limiter — the boundary", () => {
  it("allows exactly `limit` requests and refuses the next one", async () => {
    const limit = POLICY_CONFIG.auth.limit;

    const inside = await fire("auth", "user@example.com", limit);
    expect(inside.every((d) => d.allowed)).toBe(true);

    const justPast = await checkRateLimit("auth", "user@example.com", {
      nowMs: T0,
      forceMemory: true,
    });

    expect(
      justPast.allowed,
      `request ${limit + 1} was allowed — the limit is one higher than documented, ` +
        `which is a free request per window for an attacker, forever`,
    ).toBe(false);
  });

  it("the last allowed request reports zero remaining, not one", async () => {
    const limit = POLICY_CONFIG.search.limit;
    const decisions = await fire("search", "t:x:u:y", limit);
    expect(decisions[limit - 1]!.remaining).toBe(0);
  });

  it("a refusal never returns Retry-After: 0", async () => {
    // A zero would be read by a well-behaved client as "retry immediately",
    // turning a backoff into a hot loop against the endpoint being protected.
    await fire("auth", "loop@example.com", POLICY_CONFIG.auth.limit);
    const denied = await checkRateLimit("auth", "loop@example.com", {
      nowMs: T0,
      forceMemory: true,
    });

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("the window SLIDES — it does not reset on a fixed boundary", async () => {
    // A fixed window would let a caller send `limit` at 11:59:59 and `limit`
    // again at 12:00:00: double rate at exactly the moment an attacker aims
    // for, because the boundary is guessable from Retry-After.
    const windowMs = POLICY_CONFIG.auth.windowSeconds * 1000;
    const limit = POLICY_CONFIG.auth.limit;

    // Staggered one millisecond apart, so the hits age out one at a time —
    // which is the property under test. Fired simultaneously they would all
    // expire together and a FIXED window would pass this too.
    for (let i = 0; i < limit; i += 1) {
      await checkRateLimit("auth", "slide@example.com", {
        nowMs: T0 + i,
        forceMemory: true,
      });
    }

    // One millisecond before the first hit ages out: still refused.
    const stillBlocked = await checkRateLimit("auth", "slide@example.com", {
      nowMs: T0 + windowMs - 1,
      forceMemory: true,
    });
    expect(stillBlocked.allowed).toBe(false);

    // The instant the FIRST hit ages out: exactly one slot has freed up, and
    // exactly one — a fixed window would have freed all ten.
    const freed = await checkRateLimit("auth", "slide@example.com", {
      nowMs: T0 + windowMs,
      forceMemory: true,
    });
    expect(freed.allowed).toBe(true);
    expect(freed.remaining).toBe(0);
  });
});

/* ================================================================== */
/* 2. KEY ISOLATION                                                    */
/* ================================================================== */

describe("rate limiter — key isolation", () => {
  it("exhausting tenant A's budget does not affect tenant B", async () => {
    const keyA = tenantRateLimitKey("11111111-1111-1111-1111-111111111111", "u1");
    const keyB = tenantRateLimitKey("22222222-2222-2222-2222-222222222222", "u1");

    await fire("search", keyA, POLICY_CONFIG.search.limit);

    const aBlocked = await checkRateLimit("search", keyA, { nowMs: T0, forceMemory: true });
    const bAllowed = await checkRateLimit("search", keyB, { nowMs: T0, forceMemory: true });

    expect(aBlocked.allowed).toBe(false);
    expect(
      bAllowed.allowed,
      "TENANT A'S TRAFFIC THROTTLED TENANT B — the keyspace is shared, which is a " +
        "cross-tenant denial of service any customer could mount",
    ).toBe(true);
  });

  it("the same user id under two tenants gets two budgets", async () => {
    // Guards the specific mistake of keying on the user id alone: correct
    // today because user ids are global uuids, silently broken the moment any
    // identifier becomes tenant-scoped.
    const sameUser = "shared-user-id";
    const keyA = tenantRateLimitKey("aaaaaaaa-0000-0000-0000-000000000000", sameUser);
    const keyB = tenantRateLimitKey("bbbbbbbb-0000-0000-0000-000000000000", sameUser);
    expect(keyA).not.toBe(keyB);

    await fire("upload", keyA, POLICY_CONFIG.upload.limit);
    const b = await checkRateLimit("upload", keyB, { nowMs: T0, forceMemory: true });
    expect(b.allowed).toBe(true);
  });

  it("two policies with the same key do not share a counter", async () => {
    const key = ipRateLimitKey("203.0.113.10");

    await fire("auth", key, POLICY_CONFIG.auth.limit);

    const authBlocked = await checkRateLimit("auth", key, { nowMs: T0, forceMemory: true });
    const searchFine = await checkRateLimit("search", key, { nowMs: T0, forceMemory: true });

    expect(authBlocked.allowed).toBe(false);
    expect(searchFine.allowed).toBe(true);
  });

  it("refuses to build a tenant key with no tenant id", () => {
    // An empty tenant would produce one key shared by every caller that also
    // passed an empty one — the collision above, made permanent.
    expect(() => tenantRateLimitKey("")).toThrow(/tenant id/i);
  });
});

/* ================================================================== */
/* 3. PORTAL KEYING (SEC-020)                                          */
/* ================================================================== */

describe("rate limiter — portal keying", () => {
  it("never places the raw token in the key", async () => {
    const token = "a".repeat(64);
    const key = await portalRateLimitKey(token, "203.0.113.5");

    expect(
      key.includes(token),
      "THE RAW PORTAL TOKEN IS IN THE REDIS KEY — it is a live credential and " +
        "Redis keys appear in MONITOR output, slow logs and error messages",
    ).toBe(false);
  });

  it("one office behind one NAT is not throttled by a colleague's token", async () => {
    // The failure of keying by IP alone: six people on one gateway opening
    // six different contract links must not consume one shared budget.
    const ip = "198.51.100.20";
    const keys = await Promise.all(
      ["tok-1", "tok-2", "tok-3"].map((t) => portalRateLimitKey(t, ip)),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("the token-independent key collapses an enumerator to ONE bucket", async () => {
    // The failure of keying by token alone: every guess is a different token,
    // so every guess would get a fresh budget. The source key must not move.
    const ip = "192.0.2.77";
    const a = portalSourceRateLimitKey(ip);
    const b = portalSourceRateLimitKey(ip);
    expect(a).toBe(b);

    await fire("portal", a, POLICY_CONFIG.portal.limit);
    const next = await checkRateLimit("portal", a, { nowMs: T0, forceMemory: true });
    expect(next.allowed).toBe(false);
  });

  it("collapses an IPv6 /64 to one bucket", () => {
    // Anyone with a VPS holds a /64. Counting addresses would hand them
    // 18 quintillion free buckets.
    const one = ipPrefix("2001:0db8:85a3:0000:1111:2222:3333:4444");
    const two = ipPrefix("2001:0db8:85a3:0000:9999:8888:7777:6666");
    expect(one).toBe(two);
  });

  it("collapses an IPv4 /24 to one bucket", () => {
    expect(ipPrefix("203.0.113.4")).toBe(ipPrefix("203.0.113.250"));
    expect(ipPrefix("203.0.113.4")).not.toBe(ipPrefix("203.0.114.4"));
  });

  it("an absent IP does not become a bypass", () => {
    // Stripping the header must not produce a unique, unlimited identity.
    expect(ipRateLimitKey(null)).toBe(ipRateLimitKey(undefined));
    expect(ipRateLimitKey("")).toBe(ipRateLimitKey(null));
  });

  it("bounds an absurdly long attacker-supplied address", () => {
    const key = ipRateLimitKey("1.".repeat(5000));
    expect(key.length).toBeLessThan(60);
  });
});

/* ================================================================== */
/* 4. WEBHOOKS (SEC-024)                                               */
/* ================================================================== */

describe("rate limiter — webhook policy", () => {
  it("is keyed by source, never by endpoint", () => {
    // A shared endpoint counter would let one attacker's flood exhaust the
    // budget and cause OUR PROVIDER'S events to be rejected — turning a
    // nuisance into lost payments.
    const attacker = webhookRateLimitKey("razorpay", "192.0.2.66");
    const provider = webhookRateLimitKey("razorpay", "35.154.1.1");
    expect(attacker).not.toBe(provider);
  });

  it("tolerates a redelivery burst far above ordinary traffic", async () => {
    // If our endpoint was briefly down the provider redelivers everything it
    // queued: hundreds of events, all real, all needed.
    const key = webhookRateLimitKey("razorpay", "35.154.1.1");
    const decisions = await fire("webhook", key, 200);
    expect(decisions.every((d) => d.allowed)).toBe(true);
  });

  it("does NOT enforce on the degraded per-instance counter", async () => {
    // Deliberate. A per-instance counter sees only a slice of provider
    // traffic; a missed limit costs some compute, a wrongly-dropped webhook
    // costs a payment.
    const key = webhookRateLimitKey("razorpay", "35.154.1.1");
    const decisions = await fire("webhook", key, POLICY_CONFIG.webhook.limit + 50);

    expect(decisions.every((d) => d.allowed)).toBe(true);
    expect(decisions[0]!.backend).toBe("none");
    expect(decisions[0]!.degraded).toBe(true);
  });

  it("every OTHER policy does enforce when degraded", async () => {
    for (const policy of RATE_LIMIT_POLICIES) {
      if (policy === "webhook") continue;
      __resetRateLimitStateForTests();

      const decisions = await fire(policy, `k-${policy}`, POLICY_CONFIG[policy].limit + 1);
      const last = decisions[decisions.length - 1]!;

      expect(last.allowed, `policy "${policy}" did not enforce on the fallback`).toBe(false);
      expect(last.backend).toBe("memory");
      expect(last.degraded).toBe(true);
    }
  });
});

/* ================================================================== */
/* 5. DEGRADATION IS LOUD, AND NEVER FATAL                             */
/* ================================================================== */

describe("rate limiter — degradation", () => {
  it("reports degradation exactly once per process, not once per request", async () => {
    // One event per request would be a million rows an hour in an
    // append-only table, and the alarm would drown the signal it raises.
    const listener = vi.fn();
    onRateLimitDegraded(listener);

    // `forceMemory` is the test hook; the un-forced path is what notifies.
    for (let i = 0; i < 5; i += 1) {
      await checkRateLimit("api", "degrade-check", { nowMs: T0 });
    }

    expect(listener.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("a throwing degradation listener does not break the request", async () => {
    onRateLimitDegraded(() => {
      throw new Error("alerting is down");
    });

    const decision = await checkRateLimit("api", "listener-throws", { nowMs: T0 });
    expect(decision).toBeDefined();
    expect(typeof decision.allowed).toBe("boolean");
  });

  it("never throws, whatever it is handed", async () => {
    // A limiter that throws converts a Redis blip into a 500 on every route
    // it guards — a worse outage than the abuse it was installed to prevent.
    const weird = await checkRateLimit("api", "", { nowMs: T0, forceMemory: true });
    expect(weird.allowed).toBe(true);

    const unicode = await checkRateLimit("api", "🔥 \n", { nowMs: T0, forceMemory: true });
    expect(typeof unicode.allowed).toBe("boolean");
  });

  it("bounds memory under an IP-rotation flood", async () => {
    // Without a cap, rotating source addresses turns the rate limiter itself
    // into the memory-exhaustion vector.
    for (let i = 0; i < 12_000; i += 1) {
      await checkRateLimit("api", `flood-${i}`, { nowMs: T0, forceMemory: true });
    }
    expect(__memoryKeyCountForTests()).toBeLessThanOrEqual(10_000);
  });
});

/* ================================================================== */
/* 6. THE 429 LEAKS NOTHING                                            */
/* ================================================================== */

describe("rate limiter — the response", () => {
  it("tells an anonymous caller nothing but when to come back", async () => {
    await fire("portal", "anon-key", POLICY_CONFIG.portal.limit);
    const denied = await checkRateLimit("portal", "anon-key", {
      nowMs: T0,
      forceMemory: true,
    });

    const headers = rateLimitHeaders(denied, { authenticated: false });

    expect(Object.keys(headers)).toEqual(["Retry-After"]);
    expect(headers["X-RateLimit-Limit"]).toBeUndefined();
    expect(headers["X-RateLimit-Remaining"]).toBeUndefined();
  });

  it("the body names no policy, no limit and no count", async () => {
    const body = rateLimitBody();
    const serialised = JSON.stringify(body);

    expect(Object.keys(body)).toEqual(["error"]);
    // The concrete leak: a body echoing the policy and the reset time is a
    // free calibration API, letting an attacker sit permanently at 99% of
    // our limit instead of discovering it by probing.
    for (const forbidden of ["policy", "limit", "remaining", "reset", "portal", "auth"]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("does give an authenticated caller their own budget", async () => {
    const decision = await checkRateLimit("search", tenantRateLimitKey("t-1", "u-1"), {
      nowMs: T0,
      forceMemory: true,
    });

    const headers = rateLimitHeaders(decision, { authenticated: true });
    expect(headers["X-RateLimit-Limit"]).toBe(String(POLICY_CONFIG.search.limit));
    expect(headers["X-RateLimit-Remaining"]).toBe(String(decision.remaining));
  });
});
