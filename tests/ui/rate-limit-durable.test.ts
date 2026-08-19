/**
 * Ordence — 🔴🔴🔴 THE RATE LIMITER ACTUALLY LIMITS · WAVE 8
 * Version: v1.76.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS WAVE FIXED, IN THE LIMITER'S OWN WORDS
 * ══════════════════════════════════════════════════════════════════════
 *     "Per-instance memory counters are a speed bump, not a control: on a
 *      serverless deployment the effective limit is (limit × instances)."
 *
 * That sentence was printed by this product on every cold start, because
 * `UPSTASH_REDIS_REST_*` is not set on this deployment. So:
 *
 *   • the auth limit of 10/minute was 10 × however many instances Railway
 *     happened to be running — a number nobody controls and nobody knows;
 *   • a fresh instance started with an EMPTY counter, so a caller who
 *     reconnected often enough was never counted at all;
 *   • and the warning was `console.warn`, ONCE, on a cold start.
 *
 * 🔴 AND `onRateLimitDegraded` — the hook whose entire purpose is to
 * raise a security event when this happens — HAD NO CALLER ANYWHERE IN
 * THE CODEBASE. The `rate_limit.degraded` event type has existed since
 * Phase 20 with a severity, a label and a SIEM mapping, and had never
 * fired once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  POLICY_CONFIG,
  RATE_LIMIT_POLICIES,
  checkRateLimit,
  hasDurableCounter,
  rateLimitBackendName,
  registerDurableCounter,
  onRateLimitDegraded,
  __resetRateLimitStateForTests,
} from "@/lib/security/rate-limit";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

afterEach(() => {
  registerDurableCounter(null);
  onRateLimitDegraded(null);
  __resetRateLimitStateForTests();
  vi.restoreAllMocks();
});

/* ================================================================== */
describe("⭐ a durable counter answers, and it is not a degraded answer", () => {
  it("is absent until something registers one", () => {
    expect(hasDurableCounter()).toBe(false);
    expect(rateLimitBackendName()).toBe("memory");
  });

  it("reports `postgres` once one is registered", () => {
    registerDurableCounter(async () => 1);
    expect(hasDurableCounter()).toBe(true);
    expect(rateLimitBackendName()).toBe("postgres");
  });

  it("🔴 counts ACROSS the boundary a memory counter cannot", async () => {
    /**
     * ⭐ THE WHOLE POINT. The stub below is one shared count, which is
     * what a real cross-instance counter is. A memory counter would give
     * each caller its own.
     */
    let shared = 0;
    registerDurableCounter(async () => {
      shared += 1;
      return shared;
    });

    const limit = POLICY_CONFIG.auth.limit;
    const decisions = [];
    for (let i = 0; i < limit + 2; i += 1) {
      decisions.push(await checkRateLimit("auth", "ip:203.0.113.9", { nowMs: 1_000_000 }));
    }

    expect(decisions.slice(0, limit).every((d) => d.allowed)).toBe(true);
    expect(decisions[limit]!.allowed).toBe(false);
    expect(decisions[limit + 1]!.allowed).toBe(false);
  });

  it("says `postgres` and NOT degraded", async () => {
    registerDurableCounter(async () => 1);
    const decision = await checkRateLimit("auth", "ip:203.0.113.9", { nowMs: 1_000_000 });
    expect(decision.backend).toBe("postgres");
    /**
     * ⚠️ `degraded` MEANS "THE NUMBER IS UNKNOWN", not "Redis is absent".
     * After wave 8, Redis being absent is ordinary.
     */
    expect(decision.degraded).toBe(false);
  });

  it("never answers `Retry-After: 0` on a denial", async () => {
    /** A `Retry-After: 0` is an invitation to retry immediately — a hot loop. */
    registerDurableCounter(async () => 9_999);
    for (const policy of RATE_LIMIT_POLICIES) {
      if (!POLICY_CONFIG[policy].enforceWhenDegraded) continue;
      const decision = await checkRateLimit(policy, "ip:x", { nowMs: 1_000_000 });
      expect(decision.allowed).toBe(false);
      expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it("reports the remaining budget from the shared count", async () => {
    registerDurableCounter(async () => 3);
    const decision = await checkRateLimit("auth", "ip:x", { nowMs: 1_000_000 });
    expect(decision.remaining).toBe(POLICY_CONFIG.auth.limit - 3);
  });
});

/* ================================================================== */
describe("⚠️ when the database is unreachable it falls to memory and SAYS SO", () => {
  it("does not 500 a route that was only being counted", async () => {
    registerDurableCounter(async () => {
      throw new Error("connection terminated unexpectedly");
    });
    const decision = await checkRateLimit("auth", "ip:x", { nowMs: 1_000_000 });
    expect(decision.backend).toBe("memory");
    expect(decision.degraded).toBe(true);
    expect(decision.allowed).toBe(true);
  });

  it("🔴 raises the degradation callback, which had no caller before wave 8", async () => {
    const seen: { policy: string; reason: string }[] = [];
    onRateLimitDegraded((event) => seen.push({ policy: event.policy, reason: event.reason }));
    registerDurableCounter(async () => {
      throw new Error("connection terminated unexpectedly");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await checkRateLimit("auth", "ip:x", { nowMs: 1_000_000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.policy).toBe("auth");
  });

  it("refuses a counter answer that is not a hit count", () => {
    /**
     * ⚠️ READING AN UNREADABLE ANSWER AS "NO HITS YET" would turn a
     * broken limiter into an open one, silently — which is how this whole
     * class of bug survives.
     */
    const durable = codeOnly(read("server/security/rate-limit-durable.ts"));
    expect(durable).toMatch(/if \(!Number\.isFinite\(hits\) \|\| hits < 1\)/);
    expect(durable).toMatch(/throw new Error/);
  });
});

/* ================================================================== */
describe("🔴 the key is hashed before it is stored", () => {
  const durable = read("server/security/rate-limit-durable.ts");

  it("hashes, and stores the hash", () => {
    /**
     * A rate-limit key contains an IP address. An IP with a timestamp
     * identifies a person, so a table of every key that has hit the
     * product would be the largest personal-data table in the system.
     */
    expect(durable).toContain('createHash("sha256")');

    /**
     * ⚠️ THE ASSERTION IS ON THE SQL STATEMENT, NOT ON THE WHOLE FILE.
     * `namespaced()` legitimately interpolates the raw key — that is the
     * string being hashed. What must never happen is the raw key reaching
     * a bound parameter.
     */
    const code = codeOnly(durable);
    const statement = code.slice(code.indexOf("db.execute(sql`"), code.indexOf("AS hits"));
    expect(statement).toContain("${keyHash}");
    expect(statement).not.toContain("${key}");
  });

  it("the database refuses anything that is not a 64-character hex digest", () => {
    const sql = read("SQL-FILES/0119_rate_limit_counters.sql");
    expect(sql).toContain("rate_limit_counters_hash_is_a_hash");
    expect(sql).toMatch(/\^\[0-9a-f\]\{64\}\$/);
  });

  it("⚠️ and the claim is a pseudonym, not anonymity, and says so", () => {
    const sql = read("SQL-FILES/0119_rate_limit_counters.sql");
    expect(sql).toMatch(/NOT THE SAME CLAIM AS "ANONYMOUS"/);
  });
});

/* ================================================================== */
describe("⭐ the counter function is safe to grant", () => {
  const sql = read("SQL-FILES/0119_rate_limit_counters.sql");

  it("is SECURITY DEFINER with a pinned search_path", () => {
    /**
     * 🔴 An unpinned search_path on a definer function is the classic
     * privilege-escalation shape: a caller creates their own `now()` in a
     * schema earlier on the path and the function calls theirs.
     */
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql.match(/SET search_path = public, pg_temp/g) ?? []).toHaveLength(2);
  });

  it("computes the window boundary in one place", () => {
    /**
     * ⚠️ An inline version in the application and a different one in a
     * test is how a limiter allows 11 requests in a 10-request window at
     * the boundary.
     */
    expect(sql).toMatch(/\(p_now_epoch \/ p_window_seconds\) \* p_window_seconds/);
  });

  it("increments atomically rather than reading then writing", () => {
    expect(sql).toContain("ON CONFLICT (key_hash, window_start) DO UPDATE");
    expect(sql).toMatch(/SET hits = public\.rate_limit_counters\.hits \+ 1/);
  });

  it("keeps a window for two windows, not one", () => {
    /**
     * ⚠️ A row deleted the instant its window ends is a row that vanishes
     * while a request that started inside that window is still deciding.
     */
    expect(sql).toMatch(/p_window_seconds \* 2/);
  });

  it("sweeps in bounded batches", () => {
    expect(sql).toMatch(/LIMIT p_limit/);
  });
});

/* ================================================================== */
describe("🔴 the limiter is installed where it will actually run", () => {
  it("is registered from instrumentation, once per Node process", () => {
    const instrumentation = read("instrumentation.ts");
    expect(instrumentation).toContain("installDurableRateLimiter");
    expect(instrumentation).toContain('NEXT_RUNTIME === "nodejs"');
  });

  it("⚠️ and NOT at a module top level, which would reach the edge bundle", () => {
    const durable = codeOnly(read("server/security/rate-limit-durable.ts"));
    /** The registration is inside a function, not at import time. */
    const at = durable.indexOf("registerDurableCounter(hit)");
    const fn = durable.indexOf("export function installDurableRateLimiter");
    expect(at).toBeGreaterThan(fn);
  });

  it("the limiter itself still imports no database client", () => {
    /**
     * 🔴 THE REASON THE INJECTION EXISTS. `lib/security/rate-limit.ts` is
     * imported by Edge middleware; one database import breaks the edge
     * bundle at build time with an error that names neither.
     */
    const limiter = codeOnly(read("lib/security/rate-limit.ts"));
    expect(limiter).not.toContain('from "@/db"');
    expect(limiter).not.toContain("node:crypto");
    expect(limiter).not.toContain('"server-only"');
  });

  it("wires the degradation event that had never fired", () => {
    const durable = read("server/security/rate-limit-durable.ts");
    expect(durable).toContain("onRateLimitDegraded");
    expect(durable).toContain('"rate_limit.degraded"');
  });
});

/* ================================================================== */
describe("⚠️ what wave 8 deliberately did not change", () => {
  it("webhook still declines to enforce on a per-instance counter", () => {
    /**
     * ⭐ Its rationale is unchanged: 600/minute of provider callbacks is
     * a DoS ceiling, not a business rule, and a wrongly-dropped provider
     * event costs a payment.
     */
    expect(POLICY_CONFIG.webhook.enforceWhenDegraded).toBe(false);
  });

  it("every other policy still enforces", () => {
    for (const policy of RATE_LIMIT_POLICIES) {
      if (policy === "webhook") continue;
      expect(POLICY_CONFIG[policy].enforceWhenDegraded, policy).toBe(true);
    }
  });

  it("the limiter still never throws", async () => {
    registerDurableCounter(async () => {
      throw new Error("boom");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(checkRateLimit("api", "ip:x", { nowMs: 1 })).resolves.toBeTruthy();
  });
});
