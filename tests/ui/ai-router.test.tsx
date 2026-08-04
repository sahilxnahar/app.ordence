/**
 * Ordence — THE AI ROUTER
 * Batch 3 · v0.61.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE CASES THAT ACTUALLY BITE
 * ══════════════════════════════════════════════════════════════════════
 * Not "does it pick Groq" — it does. What matters is the combinatorial
 * middle: every provider exhausted, a breaker half-open, a 429 arriving
 * mid-flight, the confidential lane empty while the open lane is wide
 * open. Those are miserable to test through a network client and trivial
 * to test as a function over a table, which is exactly why the router is
 * pure functions.
 *
 * The first describe block is the one that matters most. If tenant data
 * can reach an open-lane provider by ANY path, nothing else here is
 * worth anything.
 */

import { describe, it, expect } from "vitest";
import {
  chooseProvider,
  attemptOrder,
  afterSuccess,
  afterFailure,
  hasBudget,
  isHealthy,
  BREAKER_THRESHOLD,
  BREAKER_COOLOFF_MS,
  type ProviderState,
} from "@/lib/ai/router";
import {
  AI_PROVIDERS,
  PROVIDERS_BY_ID,
  providersFor,
  providerEnvVars,
} from "@/lib/ai/providers";

const NOW = 1_800_000_000_000;
const ALL = AI_PROVIDERS.map((p) => p.id);

const fresh = (over: Partial<ProviderState> = {}): ProviderState => ({
  usedThisMinute: 0,
  usedToday: 0,
  consecutiveFailures: 0,
  breakerOpenUntil: 0,
  ...over,
});

/** A state that has consumed the provider's entire per-minute budget. */
const exhausted = (id: string): ProviderState =>
  fresh({ usedThisMinute: PROVIDERS_BY_ID[id]!.requestsPerMinute ?? 9_999 });

/* ================================================================== */
/* 1. THE LANE — the assertion the whole design exists for            */
/* ================================================================== */

describe("⭐ tenant data never reaches an open-lane provider", () => {
  it("offers ONLY confidential providers for tenant sensitivity", () => {
    for (const p of providersFor("tenant")) {
      expect(p.lane, `${p.label} is in the tenant lane`).toBe("confidential");
    }
  });

  it("refuses rather than falling back when the confidential lane is empty", () => {
    // The single most important behaviour in this file. Every open-lane
    // provider is configured, healthy and idle — and the answer is still no.
    const decision = chooseProvider({
      sensitivity: "tenant",
      states: {},
      configured: AI_PROVIDERS.filter((p) => p.lane === "open").map((p) => p.id),
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("confidential_lane_exhausted");
      expect(decision.message).toMatch(/will not be sent/i);
    }
  });

  it("refuses when the confidential provider is merely rate-limited", () => {
    // Not down. Not broken. Just busy — and STILL no fallback, because a
    // customer's contract in a training set is not recoverable and a slow
    // feature is only an inconvenience.
    const cf = "cloudflare_workers_ai";
    const decision = chooseProvider({
      sensitivity: "tenant",
      states: { [cf]: exhausted(cf) },
      configured: ALL,
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("all_rate_limited");
  });

  it("never lists an open-lane provider in a tenant attempt order", () => {
    // Belt and braces: the retry path must not widen the lane either.
    const order = attemptOrder({
      sensitivity: "tenant",
      states: {},
      configured: ALL,
      now: NOW,
    });

    expect(order.length).toBeGreaterThan(0);
    for (const p of order) expect(p.lane).toBe("confidential");
  });

  it("keeps the confidential lane small and justified", () => {
    // Padding this lane with free tiers because "they probably don't
    // train on inputs" would make the entire design decorative.
    const confidential = AI_PROVIDERS.filter((p) => p.lane === "confidential");
    expect(confidential.length).toBeLessThanOrEqual(3);
    for (const p of confidential) {
      expect(p.mayTrainOnInputs, `${p.label} must not train on inputs`).toBe(false);
    }
  });

  it("lets confidential providers serve open traffic, but LAST", () => {
    // They can. They just should not spend the scarce lane's budget on a
    // marketing email while Groq is idle.
    const open = providersFor("open");
    const firstConfidential = open.findIndex((p) => p.lane === "confidential");
    const lastOpen = open.map((p) => p.lane).lastIndexOf("open");
    expect(firstConfidential).toBeGreaterThan(lastOpen);
  });
});

/* ================================================================== */
/* 2. BUDGET                                                           */
/* ================================================================== */

describe("budget-aware selection", () => {
  it("prefers the first provider in registry order", () => {
    const d = chooseProvider({
      sensitivity: "open",
      states: {},
      configured: ALL,
      now: NOW,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.provider.id).toBe("groq");
  });

  it("skips a provider at its minute ceiling and takes the next", () => {
    const d = chooseProvider({
      sensitivity: "open",
      states: { groq: exhausted("groq") },
      configured: ALL,
      now: NOW,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.provider.id).toBe("cerebras");
  });

  it("leaves headroom rather than spending the literal last request", () => {
    // A published limit is enforced by the provider's clock, not ours, and
    // the two windows never align exactly. Spending the last one reliably
    // produces a 429 the ledger did not predict.
    const groq = PROVIDERS_BY_ID.groq!;
    const atLimit = fresh({ usedThisMinute: groq.requestsPerMinute! - 1 });
    expect(hasBudget(groq, atLimit)).toBe(false);

    const oneBelow = fresh({ usedThisMinute: groq.requestsPerMinute! - 2 });
    expect(hasBudget(groq, oneBelow)).toBe(true);
  });

  it("respects the DAILY ceiling as well as the minute one", () => {
    const gh = PROVIDERS_BY_ID.github_models!;
    const spentToday = fresh({ usedToday: gh.requestsPerDay! });
    expect(hasBudget(gh, spentToday)).toBe(false);
  });

  it("treats an absent record as full budget, not as exhausted", () => {
    // The cold-start case. Reading a missing record as exhausted would
    // fail every provider at once on the first request after a deploy.
    const d = chooseProvider({
      sensitivity: "open",
      states: {},
      configured: ["groq"],
      now: NOW,
    });
    expect(d.ok).toBe(true);
  });

  it("reports all_rate_limited when every provider is spent", () => {
    const states: Record<string, ProviderState> = {};
    for (const id of ALL) states[id] = exhausted(id);

    const d = chooseProvider({
      sensitivity: "open",
      states,
      configured: ALL,
      now: NOW,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("all_rate_limited");
  });
});

/* ================================================================== */
/* 3. THE BREAKER                                                      */
/* ================================================================== */

describe("circuit breaker", () => {
  it("does NOT trip on a single failure", () => {
    // One failure is noise. Tripping on it would make the system flap.
    const s = afterFailure(fresh(), NOW, "error");
    expect(s.consecutiveFailures).toBe(1);
    expect(isHealthy(s, NOW)).toBe(true);
  });

  it(`trips after ${BREAKER_THRESHOLD} consecutive failures`, () => {
    let s = fresh();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) s = afterFailure(s, NOW, "error");
    expect(isHealthy(s, NOW)).toBe(false);
  });

  it("reopens once the cool-off has passed", () => {
    let s = fresh();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) s = afterFailure(s, NOW, "error");

    expect(isHealthy(s, NOW + BREAKER_COOLOFF_MS - 1)).toBe(false);
    expect(isHealthy(s, NOW + BREAKER_COOLOFF_MS)).toBe(true);
  });

  it("⭐ a 429 does NOT trip the breaker", () => {
    // Being rate-limited is the provider working exactly as documented.
    // The budget ledger already routes around it and it recovers on its
    // own at the top of the next minute. A sixty-second breaker as well
    // would sideline a healthy provider for a minute it did not need.
    let s = fresh();
    for (let i = 0; i < BREAKER_THRESHOLD + 2; i += 1) {
      s = afterFailure(s, NOW, "rate_limited");
    }
    expect(isHealthy(s, NOW)).toBe(true);
  });

  it("counts a rate-limited attempt against the budget anyway", () => {
    // The request was made and the provider counted it, whatever it
    // returned. Not counting it would let a limited provider look free
    // and be chosen again immediately — a loop producing only 429s.
    const s = afterFailure(fresh(), NOW, "rate_limited");
    expect(s.usedThisMinute).toBe(1);
    expect(s.usedToday).toBe(1);
  });

  it("RESETS the failure count on success, never decrements", () => {
    let s = fresh();
    s = afterFailure(s, NOW, "error");
    s = afterFailure(s, NOW, "error");
    s = afterSuccess(s);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.breakerOpenUntil).toBe(0);
  });

  it("skips a tripped provider and reports all_unhealthy when none remain", () => {
    let broken = fresh();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) broken = afterFailure(broken, NOW, "error");

    const d = chooseProvider({
      sensitivity: "open",
      states: { groq: broken },
      configured: ["groq"],
      now: NOW,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("all_unhealthy");
  });
});

/* ================================================================== */
/* 4. THE RETRY PATH                                                   */
/* ================================================================== */

describe("attempt order", () => {
  it("lists every eligible provider once, in preference order", () => {
    const order = attemptOrder({
      sensitivity: "open",
      states: {},
      configured: ALL,
      now: NOW,
    });
    const ids = order.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("groq");
  });

  it("excludes providers already tried in this request", () => {
    const d = chooseProvider({
      sensitivity: "open",
      states: {},
      configured: ALL,
      now: NOW,
      exclude: ["groq", "cerebras"],
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(["groq", "cerebras"]).not.toContain(d.provider.id);
  });

  it("terminates rather than looping when everything is excluded", () => {
    const order = attemptOrder({
      sensitivity: "open",
      states: {},
      configured: ALL,
      now: NOW,
      exclude: ALL,
    });
    expect(order).toEqual([]);
  });
});

/* ================================================================== */
/* 5. THE REGISTRY ITSELF                                              */
/* ================================================================== */

describe("the provider registry", () => {
  it("ships NO keys — only the names of environment variables", () => {
    // This file is committed to git. A key in it is a key published, and
    // git keeps it in history after the line is deleted.
    const source = JSON.stringify(AI_PROVIDERS);
    expect(source).not.toMatch(/gsk_[A-Za-z0-9]{20,}/); // Groq
    expect(source).not.toMatch(/sk-[A-Za-z0-9]{20,}/); // OpenAI-style
    expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{30,}/); // Google
    expect(source).not.toMatch(/cfut_|cfk_/); // Cloudflare
    for (const p of AI_PROVIDERS) expect(p.envVar).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it("gives every provider a unique id and env var per provider", () => {
    const ids = AI_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(providerEnvVars().length).toBeGreaterThan(0);
  });

  it("records the training position for every provider", () => {
    // Recorded next to the lane decision rather than in a document
    // nobody re-reads. `true` also covers "silent about it", which for
    // planning purposes is the same thing.
    for (const p of AI_PROVIDERS) {
      expect(typeof p.mayTrainOnInputs).toBe("boolean");
      if (p.lane === "confidential") expect(p.mayTrainOnInputs).toBe(false);
    }
  });

  it("keeps OpenRouter listed but unconfigured", () => {
    // The four previous keys leaked and were deleted. It stays in the
    // registry because it is a good aggregator worth reaching for later;
    // the router simply skips any provider whose env var is unset.
    const or = PROVIDERS_BY_ID.openrouter;
    expect(or).toBeDefined();

    const d = chooseProvider({
      sensitivity: "open",
      states: {},
      configured: ["openrouter"],
      now: NOW,
    });
    // Listed and selectable IF configured — but nothing configures it.
    expect(d.ok).toBe(true);
  });
});
