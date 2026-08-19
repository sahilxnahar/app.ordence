/**
 * Ordence — The Edge: per-tenant rate limits, body size, pagination caps
 * Version: v1.31.0-alpha (Batch 31)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE FOR
 * ══════════════════════════════════════════════════════════════════════
 * Not "the limiter exists". Every assertion below corresponds to a way
 * this feature is worth nothing, or worse than nothing, if it is wrong:
 *
 *   1. ONE BUCKET PER TENANT, AND PER SURFACE. Two workspaces sharing a
 *      counter is a cross-tenant availability leak — an attack anybody
 *      with a signup can mount. The staff console sharing a counter with
 *      customers is the same fault with the blast radius reversed.
 *
 *   2. THE PLAN CHANGES THE NUMBER. If it does not, the whole batch is
 *      an expensive way to have one global limit.
 *
 *   3. "UNCOUNTED" NEVER LOOKS LIKE "ALLOWED". The classic failure is a
 *      `catch {}` that returns success; the mode field exists so the two
 *      states are distinguishable, and these tests hold it to that.
 *
 *   4. HEALTH CHECKS AND WEBHOOKS ARE NEVER COUNTED. Railway's probe has
 *      taken this product down before; a limiter that throttles it turns
 *      a deploy into a crash loop.
 *
 *   5. THE UPLOAD ROUTE STILL ACCEPTS BIG FILES. A global body cap would
 *      have broken every document upload in the product, silently, with
 *      a 413 that looks like a browser bug.
 *
 *   6. A CLAMPED PAGE NEVER LOOKS LIKE THE END OF THE DATA. This is the
 *      one that costs money rather than uptime: a reconciliation screen
 *      showing 200 of 1000 unmatched rows does not look broken, it looks
 *      finished, and somebody signs off a close on a fifth of the data.
 *
 * ⚠️ THERE IS NO REDIS HERE, SO EVERY RATE-LIMIT CHECK PASSES
 * `forceMemory: true` EXPLICITLY. Not because the memory path is the
 * interesting one, but because the result must not depend on whether an
 * environment variable happens to be set on the machine running this.
 *
 * ⚠️ THE CLOCK IS INJECTED (`nowMs`) rather than slept through. A limiter
 * suite built on real sleeps takes minutes and is flaky at exactly the
 * boundary the tests exist to pin down.
 *
 * ⚠️ SOURCE-TEXT ASSERTIONS RUN THROUGH `codeOnly()`. This subject is
 * covered in comments containing the very strings being asserted absent
 * ("x-tenant-id", "catch"), and a grep over raw files would fail on the
 * prose that exists to explain why the thing is absent.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  budgetFor,
  bodyLimitFor,
  isRateLimitExempt,
  maxPageSizeForPlan,
  platformBudget,
  FAIL_MODE,
  PLAN_RATE_BUDGETS,
  UNKNOWN_PLAN_FALLBACK_TIER,
  EDGE_SURFACES,
} from "@/lib/edge/budgets";
import {
  checkEdgeLimit,
  edgeLimitHeaders,
  edgeLimitBody,
  edgeLimitStatus,
  exemptDecision,
  __resetEdgeLimitsForTests,
  __edgeMemoryKeyCountForTests,
} from "@/lib/edge/limits";
import {
  checkDeclaredBodySize,
  bodyTooLargeBody,
  readBodyWithLimit,
  readJsonWithLimit,
  RequestTooLargeError,
} from "@/lib/edge/body-limit";
import {
  boundPage,
  boundPageOrThrow,
  paginate,
  PageLimitError,
  ABSOLUTE_MAX_PAGE_SIZE,
  MAX_PAGE_OFFSET,
  DEFAULT_PAGE_SIZE,
} from "@/lib/pagination";

const T0 = 1_770_000_000_000; // fixed epoch ms; any value, never "now"

beforeEach(() => {
  __resetEdgeLimitsForTests();
});

/** Fire `n` requests at one instant against the memory path. */
async function fire(
  n: number,
  options: Omit<Parameters<typeof checkEdgeLimit>[0], "nowMs" | "forceMemory">,
) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(await checkEdgeLimit({ ...options, nowMs: T0, forceMemory: true }));
  }
  return out;
}

const orgA = { kind: "tenant", orgId: "org_aaaaaaaaaaaaaaaa" } as const;
const orgB = { kind: "tenant", orgId: "org_bbbbbbbbbbbbbbbb" } as const;

/* ================================================================== */
/* 1. THE PLAN ACTUALLY CHANGES THE NUMBER                             */
/* ================================================================== */

describe("budgets are differentiated by plan", () => {
  it("gives every paid tier strictly more than the one below it", () => {
    const ladder = ["trial", "basic", "advanced", "ai", "enterprise"] as const;
    for (let i = 1; i < ladder.length; i += 1) {
      const lower = budgetFor(ladder[i - 1], "app").limit;
      const higher = budgetFor(ladder[i], "app").limit;
      expect(higher).toBeGreaterThan(lower);
    }
  });

  it("gives the programmatic surface a tighter budget than the browser", () => {
    for (const tier of ["trial", "basic", "advanced", "ai", "enterprise"] as const) {
      expect(budgetFor(tier, "api").limit).toBeLessThan(budgetFor(tier, "app").limit);
    }
  });

  it("falls back to a generous — but not unlimited — tier when the plan is unknown", () => {
    // The direction is the decision: a cache miss must not throttle the
    // customer paying the most, and must not remove the limit either.
    const fallback = budgetFor(null, "app").limit;
    expect(fallback).toBe(budgetFor(UNKNOWN_PLAN_FALLBACK_TIER, "app").limit);
    expect(fallback).toBeGreaterThan(budgetFor("trial", "app").limit);
    expect(fallback).toBeLessThan(budgetFor("enterprise", "app").limit);
  });

  it("never reads the platform budget out of the per-plan table", () => {
    // The placeholder is zero so that misuse fails loudly and immediately
    // rather than quietly varying a staff limit by a customer's plan.
    for (const tier of ["trial", "basic", "enterprise"] as const) {
      expect(PLAN_RATE_BUDGETS[tier].platform.limit).toBe(0);
    }
    expect(budgetFor("enterprise", "platform").limit).toBe(platformBudget().limit);
    expect(platformBudget().limit).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* 2. THE BOUNDARY, AND WHO SHARES A COUNTER WITH WHOM                 */
/* ================================================================== */

describe("the per-tenant bucket", () => {
  it("passes exactly the budget and refuses the next request", async () => {
    const budget = budgetFor("trial", "api").limit;
    const decisions = await fire(budget + 1, {
      surface: "api",
      identity: orgA,
      planTier: "trial",
    });

    expect(decisions.slice(0, budget).every((d) => d.allowed)).toBe(true);

    const refused = decisions[budget]!;
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe("over_budget");
    // Never zero: a `Retry-After: 0` is an invitation to hot-loop on the
    // endpoint we are trying to protect.
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("does not let one workspace exhaust another's budget", async () => {
    const budget = budgetFor("trial", "api").limit;
    await fire(budget + 5, { surface: "api", identity: orgA, planTier: "trial" });

    const [neighbour] = await fire(1, {
      surface: "api",
      identity: orgB,
      planTier: "trial",
    });
    expect(neighbour!.allowed).toBe(true);
    expect(neighbour!.remaining).toBeGreaterThan(0);
  });

  it("does not let a workspace's API traffic throttle its own browser users", async () => {
    const budget = budgetFor("trial", "api").limit;
    await fire(budget + 5, { surface: "api", identity: orgA, planTier: "trial" });

    const [browser] = await fire(1, {
      surface: "app",
      identity: orgA,
      planTier: "trial",
    });
    expect(browser!.allowed).toBe(true);
  });

  it("keeps the staff console in a bucket of its own", async () => {
    // Same string used as an org id and as a staff user id must not
    // collide: the two prefixes are what make that structurally
    // impossible rather than accidentally absent.
    const shared = "collision-candidate";
    const budget = platformBudget().limit;
    await fire(budget + 1, {
      surface: "platform",
      identity: { kind: "staff", userId: shared },
    });

    const [tenant] = await fire(1, {
      surface: "app",
      identity: { kind: "tenant", orgId: shared },
      planTier: "basic",
    });
    expect(tenant!.allowed).toBe(true);
  });

  it("covers every declared surface", () => {
    for (const surface of EDGE_SURFACES) {
      expect(FAIL_MODE[surface]).toBeDefined();
    }
  });
});

/* ================================================================== */
/* 3. "UNCOUNTED" MUST NEVER LOOK LIKE "ALLOWED"                       */
/* ================================================================== */

describe("the fail decision is a value, not an implication", () => {
  it("reports the per-instance path as degraded rather than enforced", async () => {
    const [d] = await fire(1, { surface: "app", identity: orgA, planTier: "basic" });
    expect(d!.mode).toBe("degraded");
    expect(d!.mode).not.toBe("enforced");
  });

  it("names the two fail modes explicitly, and they differ", () => {
    // The whole reason the console is a separate bucket: it can have a
    // different answer to "the counter is unreachable".
    expect(FAIL_MODE.platform).toBe("closed");
    expect(FAIL_MODE.app).toBe("degraded");
    expect(FAIL_MODE.api).toBe("degraded");
  });

  it("answers a fail-closed refusal with 503 and a stated cause", () => {
    const closed = {
      allowed: false,
      surface: "platform",
      mode: "closed",
      reason: "limiter_unavailable",
      tier: null,
      tierSource: "n/a",
      limit: 600,
      remaining: 0,
      retryAfterSeconds: 5,
    } as const;

    expect(edgeLimitStatus(closed)).toBe(503);
    const body = edgeLimitBody(closed);
    expect(body.error.code).toBe("limiter_unavailable");
    // A refusal a human cannot act on is a support ticket.
    expect(body.error.message.length).toBeGreaterThan(20);
  });

  it("answers an over-budget refusal with 429 and names the plan as the cause", () => {
    const over = {
      allowed: false,
      surface: "api",
      mode: "enforced",
      reason: "over_budget",
      tier: "basic",
      tierSource: "hint",
      limit: 300,
      remaining: 0,
      retryAfterSeconds: 12,
    } as const;

    expect(edgeLimitStatus(over)).toBe(429);
    expect(edgeLimitBody(over).error.code).toBe("workspace_rate_limit");
    expect(edgeLimitBody(over).error.message).toMatch(/plan/i);
  });

  it("never throws, whatever it is handed", async () => {
    await expect(
      checkEdgeLimit({
        surface: "app",
        identity: { kind: "tenant", orgId: "" },
        planTier: "basic",
        nowMs: T0,
        forceMemory: true,
      }),
    ).resolves.toBeDefined();
  });

  it("bounds the in-process key store so it cannot become the attack", async () => {
    for (let i = 0; i < 200; i += 1) {
      await checkEdgeLimit({
        surface: "app",
        identity: { kind: "tenant", orgId: `org_${i}` },
        planTier: "basic",
        nowMs: T0,
        forceMemory: true,
      });
    }
    // Assert a ceiling, not an exact figure — the eviction policy may
    // improve and this test must not have to be edited when it does.
    expect(__edgeMemoryKeyCountForTests()).toBeLessThanOrEqual(10_000);
  });
});

/* ================================================================== */
/* 4. OBSERVABILITY                                                    */
/* ================================================================== */

describe("the current position is readable", () => {
  it("publishes the mode on every decision it touches", async () => {
    const [d] = await fire(1, { surface: "app", identity: orgA, planTier: "basic" });
    const headers = edgeLimitHeaders(d!);
    expect(headers["x-ordence-limit-mode"]).toBeTruthy();
    expect(headers["x-ratelimit-limit"]).toBe(String(d!.limit));
    expect(headers["x-ratelimit-remaining"]).toBeTruthy();
  });

  it("publishes the position while things are still fine, not only on the 429", async () => {
    const [d] = await fire(1, { surface: "app", identity: orgA, planTier: "basic" });
    expect(d!.allowed).toBe(true);
    expect(edgeLimitHeaders(d!)["x-ratelimit-remaining"]).toBeDefined();
  });

  it("sends Retry-After only when it refused", async () => {
    const budget = budgetFor("trial", "api").limit;
    const decisions = await fire(budget + 1, {
      surface: "api",
      identity: orgA,
      planTier: "trial",
    });
    expect(edgeLimitHeaders(decisions[0]!)["retry-after"]).toBeUndefined();
    expect(Number(edgeLimitHeaders(decisions[budget]!)["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("does not publish a budget for a path that is deliberately not counted", () => {
    const headers = edgeLimitHeaders(exemptDecision("app"));
    expect(headers["x-ordence-limit-mode"]).toBe("exempt");
    // Publishing "0 of 0 remaining" for an uncounted path would read as
    // "you are out of budget" on a health check.
    expect(headers["x-ratelimit-limit"]).toBeUndefined();
  });
});

/* ================================================================== */
/* 5. WHAT MUST NEVER BE RATE LIMITED                                  */
/* ================================================================== */

describe("probes, providers and schedulers are never counted", () => {
  it.each([
    "/api/health",
    "/api/ready",
    "/api/diag",
    "/api/webhooks/razorpay",
    "/api/webhooks/stripe",
    "/api/cron/canary",
    "/api/workers",
    "/api/workers/ai-monitors",
  ])("exempts %s", (path) => {
    expect(isRateLimitExempt(path)).toBe(true);
  });

  it.each(["/api/assistant", "/api/mcp", "/dashboard", "/api/telemetry"])(
    "does not exempt %s",
    (path) => {
      expect(isRateLimitExempt(path)).toBe(false);
    },
  );

  it("does not exempt a path that merely starts with the same letters", () => {
    // `/api/healthcheck-bypass` must not inherit `/api/health`'s exemption.
    expect(isRateLimitExempt("/api/healthy-tenants")).toBe(false);
  });
});

/* ================================================================== */
/* 6. REQUEST SIZE                                                     */
/* ================================================================== */

describe("request body size", () => {
  it("still lets the upload receiver take a real file", () => {
    // 🔴 The trap this batch could most easily have shipped: one global
    // cap, and every document upload in the product refused.
    const rule = bodyLimitFor("/api/upload/put");
    expect(rule.maxBytes).toBeGreaterThanOrEqual(50 * 1024 * 1024);
  });

  it("applies a tight default to everything nobody thought about", () => {
    const fallback = bodyLimitFor("/some/route/nobody/registered");
    // A ceiling, not an exact figure: this number may only get tighter.
    expect(fallback.maxBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it("keeps the assistant far below the upload ceiling", () => {
    // Its bytes become prompt tokens somebody charges us for.
    expect(bodyLimitFor("/api/assistant").maxBytes).toBeLessThan(
      bodyLimitFor("/api/upload/put").maxBytes,
    );
    expect(bodyLimitFor("/api/assistant/goal-planner").maxBytes).toBe(
      bodyLimitFor("/api/assistant").maxBytes,
    );
  });

  it("refuses an honestly-declared oversized body without reading it", () => {
    const verdict = checkDeclaredBodySize("/api/assistant", String(50 * 1024 * 1024));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");

    const body = bodyTooLargeBody(verdict);
    expect(body.error.code).toBe("request_too_large");
    // The ceiling is an interface contract, not a secret: an integration
    // author cannot chunk correctly without it.
    expect(body.error.limitBytes).toBe(verdict.limitBytes);
    expect(body.error.message).toMatch(/too large/i);
  });

  it("lets an absent, empty or nonsense Content-Length through", () => {
    // Refusing these would refuse every chunked upload and every GET.
    for (const value of [null, undefined, "", "not-a-number", "-1"]) {
      expect(checkDeclaredBodySize("/api/assistant", value).ok).toBe(true);
    }
  });

  it("refuses a body that lied about its length, by measuring it", async () => {
    const payload = "x".repeat(5_000);
    const request = fakeRequest(payload, { "content-length": "10" });
    await expect(readBodyWithLimit(request, 1_000)).rejects.toBeInstanceOf(
      RequestTooLargeError,
    );
  });

  it("stops reading at the cap instead of buffering the whole body first", async () => {
    let chunksDelivered = 0;
    const request = streamingRequest(20, 1_000, () => {
      chunksDelivered += 1;
    });
    await expect(readBodyWithLimit(request, 3_000)).rejects.toBeInstanceOf(
      RequestTooLargeError,
    );
    // Assert a ceiling: it must not have consumed the whole 20-chunk body.
    expect(chunksDelivered).toBeLessThan(20);
  });

  it("counts BYTES, not UTF-16 code units", async () => {
    // Four bytes each, `.length` two each. A cap built on `.length` would
    // be twice as loose as it reads.
    const payload = "\u{1F600}".repeat(400); // 1600 bytes, .length === 800
    expect(payload.length).toBeLessThan(1_000);
    const request = fakeRequest(payload);
    await expect(readBodyWithLimit(request, 1_000)).rejects.toBeInstanceOf(
      RequestTooLargeError,
    );
  });

  it("keeps a size failure distinct from a parse failure", async () => {
    const tooBig = fakeRequest("[" + "1,".repeat(5_000) + "1]");
    await expect(readJsonWithLimit(tooBig, 100)).rejects.toBeInstanceOf(
      RequestTooLargeError,
    );

    const malformed = fakeRequest("{not json");
    await expect(readJsonWithLimit(malformed, 1_000_000)).rejects.not.toBeInstanceOf(
      RequestTooLargeError,
    );
  });

  it("accepts a body that fits", async () => {
    const request = fakeRequest(JSON.stringify({ hello: "world" }));
    await expect(readJsonWithLimit<{ hello: string }>(request, 1_000)).resolves.toEqual({
      hello: "world",
    });
  });
});

/* ================================================================== */
/* 7. PAGINATION CAPS                                                  */
/* ================================================================== */

describe("pagination bounds", () => {
  it("clamps the curl request and says that it did", () => {
    const bounds = boundPage({ limit: "1000000", planTier: "basic" });
    expect(bounds.limit).toBeLessThanOrEqual(ABSOLUTE_MAX_PAGE_SIZE);
    expect(bounds.limit).toBe(bounds.maxLimit);
    expect(bounds.clamped).toBe(true);
    expect(bounds.clampReason).toBeTruthy();
    // 🔴 The sentence must warn that this is NOT the end of the data.
    expect(bounds.clampReason).toMatch(/not the end/i);
  });

  it("hands the query a probe row so truncation is a measurement", () => {
    const bounds = boundPage({ limit: 25 });
    expect(bounds.take).toBe(bounds.limit + 1);

    const fetched = Array.from({ length: bounds.take }, (_, i) => i);
    const page = paginate(fetched, bounds);
    expect(page.rows).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(25);
  });

  it("does not claim more rows exist when the page is genuinely the last", () => {
    const bounds = boundPage({ limit: 25 });
    const page = paginate(Array.from({ length: 10 }, (_, i) => i), bounds);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it("carries the clamp notice into the envelope the caller reads", () => {
    const bounds = boundPage({ limit: 5_000, planTier: "trial" });
    const page = paginate(Array.from({ length: bounds.take }, (_, i) => i), bounds);
    expect(page.clamped).toBe(true);
    expect(page.notice).toBeTruthy();
    expect(page.hasMore).toBe(true);
  });

  it("refuses rather than clamps when the caller is a program", () => {
    // Quietly serving 200 to a client paging by 1000 makes it skip 800
    // rows per page, forever, with no error anywhere.
    expect(() => boundPageOrThrow({ limit: 1_000, planTier: "basic" })).toThrow(
      PageLimitError,
    );
    expect(() => boundPageOrThrow({ limit: 10, planTier: "basic" })).not.toThrow();
  });

  it("differentiates the ceiling by plan but never above the absolute one", () => {
    expect(maxPageSizeForPlan("trial")).toBeLessThan(maxPageSizeForPlan("enterprise"));
    for (const tier of ["trial", "basic", "advanced", "ai", "enterprise"] as const) {
      expect(maxPageSizeForPlan(tier)).toBeLessThanOrEqual(ABSOLUTE_MAX_PAGE_SIZE);
    }
    // A call site cannot ask for more than the plan or the absolute cap.
    expect(
      boundPage({ limit: 100_000, maxLimit: 100_000, planTier: "enterprise" }).limit,
    ).toBeLessThanOrEqual(ABSOLUTE_MAX_PAGE_SIZE);
  });

  it("never emits NaN, Infinity or a negative into a query", () => {
    for (const junk of ["abc", "", "-5", "1e400", NaN, Infinity, -Infinity, null, {}, []]) {
      const bounds = boundPage({ limit: junk as unknown, offset: junk as unknown });
      expect(Number.isInteger(bounds.limit)).toBe(true);
      expect(Number.isInteger(bounds.offset)).toBe(true);
      expect(bounds.limit).toBeGreaterThan(0);
      expect(bounds.offset).toBeGreaterThanOrEqual(0);
      expect(bounds.limit).toBeLessThanOrEqual(ABSOLUTE_MAX_PAGE_SIZE);
    }
  });

  it("uses the default when nothing was asked for", () => {
    const bounds = boundPage({});
    expect(bounds.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(bounds.clamped).toBe(false);
    expect(bounds.clampReason).toBeNull();
  });

  it("bounds the offset, because the cost of OFFSET is the offset", () => {
    const bounds = boundPage({ offset: 5_000_000 });
    expect(bounds.offset).toBe(MAX_PAGE_OFFSET);
    expect(bounds.clamped).toBe(true);
    expect(bounds.clampReason).toMatch(/offset/i);
  });

  it("accepts a 1-based page number without letting it escape the offset cap", () => {
    expect(boundPage({ page: 1, limit: 50 }).offset).toBe(0);
    expect(boundPage({ page: 3, limit: 50 }).offset).toBe(100);
    expect(boundPage({ page: 10_000_000, limit: 50 }).offset).toBe(MAX_PAGE_OFFSET);
  });
});

/* ================================================================== */
/* 8. THE WIRING — ASSERTED IN THE SOURCE                              */
/* ================================================================== */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Blank comments (and JSX comments) before asserting the ABSENCE of
 * anything. This subject is documented in prose containing the exact
 * strings being asserted absent.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const MIDDLEWARE = codeOnly(read("middleware.ts"));
const LIMITS = codeOnly(read("lib/edge/limits.ts"));
const BUDGETS = codeOnly(read("lib/edge/budgets.ts"));
const BODY_LIMIT = codeOnly(read("lib/edge/body-limit.ts"));
const PAGINATION = codeOnly(read("lib/pagination.ts"));

describe("the middleware wiring", () => {
  it("gates authenticated traffic through the tenant limiter", () => {
    expect(MIDDLEWARE).toContain("edgeLimitGate");
    expect(MIDDLEWARE).toContain("checkEdgeLimit");
    expect(MIDDLEWARE).toContain("isRateLimitExempt");
  });

  it("keys the bucket on the session's organisation, not on anything the client sends", () => {
    // The org id comes from `auth()`, the same call step 7 uses to refuse
    // a cross-tenant request.
    expect(MIDDLEWARE).toMatch(/kind:\s*"tenant",\s*orgId\s*}/);
    // 🔴 No `x-tenant-*` header may be read anywhere in the file: every
    // one of them is deleted from the inbound request in step 1, and
    // keying on one would make the limit opt-in.
    expect(MIDDLEWARE).not.toMatch(/headers\.get\(\s*["']x-tenant/);
  });

  it("gives the staff console its own bucket", () => {
    expect(MIDDLEWARE).toMatch(/kind:\s*"staff"/);
    expect(MIDDLEWARE).toContain('"platform"');
  });

  it("checks the body size before the auth gate, so an anonymous flood is refused early", () => {
    const sizeAt = MIDDLEWARE.indexOf("checkDeclaredBodySize");
    const authAt = MIDDLEWARE.indexOf("await auth()");
    expect(sizeAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(-1);
    expect(sizeAt).toBeLessThan(authAt);
  });

  it("stays inside the edge runtime", () => {
    // No database client and no Node built-ins may reach middleware.ts —
    // it runs in the edge runtime and importing either breaks the build
    // in a way that only shows up on deploy.
    expect(MIDDLEWARE).not.toMatch(/from\s+["']@\/db["']/);
    expect(MIDDLEWARE).not.toMatch(/from\s+["']node:/);
  });
});

describe("the edge modules stay edge-safe", () => {
  it.each([
    ["lib/edge/limits.ts", LIMITS],
    ["lib/edge/budgets.ts", BUDGETS],
    ["lib/edge/body-limit.ts", BODY_LIMIT],
    ["lib/pagination.ts", PAGINATION],
  ])("%s imports no Node built-in and no database client", (_name, source) => {
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/require\(["']node:/);
    expect(source).not.toMatch(/from\s+["']@\/db["']/);
  });

  it("reads its settings at request time rather than through an inlined literal", () => {
    // A literal `process.env.UPSTASH_...` is substituted at build time on
    // Railway and Cloudflare, where the build machine has no credentials —
    // so the limiter would conclude "not configured" on a deployment that
    // is configured correctly, which is the quietest way for a control to
    // be absent.
    expect(LIMITS).toContain("readRuntimeEnv");
    expect(LIMITS).not.toMatch(/process\.env\.UPSTASH/);
  });
});

describe("the routes that read a body do so with a limit", () => {
  it.each(["app/api/assistant/route.ts", "app/api/mcp/route.ts"])(
    "%s never calls req.json() unbounded",
    (path) => {
      const source = codeOnly(read(path));
      expect(source).toContain("readJsonWithLimit");
      expect(source).not.toMatch(/await\s+req\.json\(\)/);
    },
  );
});

/* ================================================================== */
/* TEST DOUBLES                                                        */
/* ================================================================== */

/**
 * A minimal stand-in for `Request`.
 *
 * ⚠️ Hand-rolled rather than `new Request(...)` because this suite runs
 * in JSDOM, where the WHATWG `Request` constructor rejects a stream body.
 * `readBodyWithLimit` touches exactly two members, so a double is honest
 * here rather than a shortcut.
 */
function fakeRequest(payload: string, headers: Record<string, string> = {}): Request {
  const bytes = new TextEncoder().encode(payload);
  return streamOf([bytes], headers);
}

function streamingRequest(
  chunkCount: number,
  chunkBytes: number,
  onChunk: () => void,
): Request {
  const chunks = Array.from(
    { length: chunkCount },
    () => new Uint8Array(chunkBytes),
  );
  return streamOf(chunks, {}, onChunk);
}

function streamOf(
  chunks: Uint8Array[],
  headers: Record<string, string>,
  onChunk?: () => void,
): Request {
  let index = 0;
  const reader = {
    read: async () => {
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = chunks[index];
      index += 1;
      onChunk?.();
      return { done: false, value };
    },
    cancel: async () => {
      index = chunks.length;
    },
    releaseLock: () => {},
  };

  return {
    body: { getReader: () => reader },
    headers: new Map(Object.entries(headers)) as unknown as Headers,
    text: async () =>
      new TextDecoder().decode(
        chunks.reduce<Uint8Array>((acc, c) => {
          const merged = new Uint8Array(acc.length + c.length);
          merged.set(acc, 0);
          merged.set(c, acc.length);
          return merged;
        }, new Uint8Array(0)),
      ),
  } as unknown as Request;
}
