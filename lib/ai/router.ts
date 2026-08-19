/**
 * Ordence — ⭐ THE AI ROUTER
 * Version: v0.61.0-alpha  ·  Batch 3
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS PURE FUNCTIONS AND NOT A CLIENT
 * ══════════════════════════════════════════════════════════════════════
 * Nothing in this file makes a network call, reads a secret, or touches
 * a database. It answers one question — GIVEN what each provider has
 * left and how each has recently behaved, who should answer this
 * request? — and it answers it deterministically.
 *
 * That is deliberate. The cases that actually bite in production are
 * combinatorial: every provider exhausted, a breaker half-open, a 429
 * arriving mid-flight, two requests racing for the last token of the
 * minute. Those are miserable to test through a network client and
 * trivial to test as a function over a table. So the decision lives
 * here, and the plumbing lives in `client.ts` where it belongs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY BUDGET-AWARE ROUTING, NOT TRY/CATCH FAILOVER
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design is a chain: try Groq, catch, try Cerebras, catch.
 *
 * It fails in the way free tiers actually fail. They rarely go DOWN —
 * they rate-limit. Groq allows 30 requests a minute; request 31 gets a
 * 429. A try/catch chain therefore hammers Groq to its ceiling on every
 * single request, waits for the rejection, and only then moves on. Past
 * the thirtieth call, every request pays the full latency of a failure
 * before it does anything useful.
 *
 * Knowing the budget BEFORE spending it turns that from a failure into a
 * routing decision.
 */

import { providersFor, type AiProvider } from "./providers";

/* ------------------------------------------------------------------ */
/* WHAT THE ROUTER IS TOLD                                             */
/* ------------------------------------------------------------------ */

/** What a caller says about the data it is holding. */
export type Sensitivity = "open" | "tenant";

/**
 * A provider's live position, as recorded in Upstash.
 *
 * ⚠️ `undefined` for a provider means NO RECORD, which is treated as
 * "full budget, healthy". That is the correct reading on a cold start —
 * the alternative, treating an absent record as exhausted, would make
 * the very first request after a deploy fail on every provider at once.
 */
export type ProviderState = {
  /** Requests already spent in the current minute window. */
  usedThisMinute: number;
  /** Requests already spent in the current day window. */
  usedToday: number;
  /** Consecutive failures. Resets to 0 on any success. */
  consecutiveFailures: number;
  /** Epoch ms until which the breaker is open. 0 = closed. */
  breakerOpenUntil: number;
};

export type RouterInput = {
  sensitivity: Sensitivity;
  /** Provider id → state. Missing entries mean untouched and healthy. */
  states: Readonly<Record<string, ProviderState | undefined>>;
  /** Which provider ids have a key configured in this deployment. */
  configured: readonly string[];
  /** Injected so the decision is deterministic and testable. */
  now: number;
  /** Providers already tried and failed within THIS request. */
  exclude?: readonly string[];
};

export type RouterDecision =
  | { ok: true; provider: AiProvider; reason: string }
  | { ok: false; reason: RefusalReason; message: string };

export type RefusalReason =
  | "no_provider_configured"
  | "all_rate_limited"
  | "all_unhealthy"
  | "confidential_lane_exhausted";

/* ------------------------------------------------------------------ */
/* CONSTANTS                                                           */
/* ------------------------------------------------------------------ */

/**
 * How many consecutive failures trip the breaker.
 *
 * ⚠️ THREE, NOT ONE. A single failure is noise — a timeout, a blip, a
 * transient 500. Tripping on one would take a healthy provider out of
 * rotation constantly and make the system flap between providers for no
 * reason, which is worse than the occasional retry.
 */
export const BREAKER_THRESHOLD = 3;

/**
 * How long the breaker stays open.
 *
 * ⚠️ Long enough that a struggling provider gets real relief, short
 * enough that a provider that recovered in ten seconds is not sidelined
 * for an hour. Sixty seconds also happens to align with the per-minute
 * budget window, so a breaker re-opening and a budget resetting tend to
 * coincide rather than fight.
 */
export const BREAKER_COOLOFF_MS = 60_000;

/**
 * Stop using a provider slightly before its published ceiling.
 *
 * ⚠️ THE HEADROOM IS NOT PARANOIA. A published "30 per minute" is
 * enforced by the provider's own clock, not ours, and the two windows
 * are never exactly aligned. Spending the literal last request of our
 * count reliably produces a 429 that our ledger did not predict — which
 * is the exact surprise this whole file exists to avoid.
 */
export const RATE_LIMIT_HEADROOM = 1;

/* ------------------------------------------------------------------ */
/* THE DECISION                                                        */
/* ------------------------------------------------------------------ */

const FRESH: ProviderState = {
  usedThisMinute: 0,
  usedToday: 0,
  consecutiveFailures: 0,
  breakerOpenUntil: 0,
};

/** Has this provider got room for one more request right now? */
export function hasBudget(
  provider: AiProvider,
  state: ProviderState,
): boolean {
  if (provider.requestsPerMinute !== null) {
    const ceiling = Math.max(0, provider.requestsPerMinute - RATE_LIMIT_HEADROOM);
    if (state.usedThisMinute >= ceiling) return false;
  }
  if (provider.requestsPerDay !== null) {
    const ceiling = Math.max(0, provider.requestsPerDay - RATE_LIMIT_HEADROOM);
    if (state.usedToday >= ceiling) return false;
  }
  return true;
}

/** Is the breaker closed (or has the cool-off expired)? */
export function isHealthy(state: ProviderState, now: number): boolean {
  return state.breakerOpenUntil <= now;
}

/**
 * ⭐ Pick a provider, or explain precisely why none can be used.
 *
 * ⚠️ THE REFUSAL IS AS IMPORTANT AS THE CHOICE, and the reasons are
 * distinct on purpose. "Nothing is configured" is an operator problem,
 * "everything is rate-limited" is a capacity problem that will pass on
 * its own, and "the confidential lane is exhausted" is neither — it is a
 * deliberate refusal to do the unsafe thing. A single generic
 * "unavailable" would hide all three behind the same shrug.
 */
export function chooseProvider(input: RouterInput): RouterDecision {
  const { sensitivity, states, configured, now } = input;
  const exclude = new Set(input.exclude ?? []);
  const configuredSet = new Set(configured);

  const lane = providersFor(sensitivity);
  const eligible = lane.filter(
    (p) => configuredSet.has(p.id) && !exclude.has(p.id),
  );

  if (eligible.length === 0) {
    /**
     * ⚠️ THE CONFIDENTIAL LANE GETS ITS OWN REASON, AND NEVER A FALLBACK.
     *
     * When no confidential provider is available the answer is to refuse,
     * not to quietly use an open-lane one. A slow AI feature is an
     * inconvenience; a customer's contract in somebody's training set is
     * not recoverable. There is no flag to change this.
     */
    if (sensitivity === "tenant") {
      return {
        ok: false,
        reason: "confidential_lane_exhausted",
        message:
          "No provider is available that is permitted to see tenant data. " +
          "This request will not be sent to a general-purpose free tier.",
      };
    }
    return {
      ok: false,
      reason: "no_provider_configured",
      message:
        "No AI provider is configured for this deployment. Add at least one " +
        "provider key in Cloudflare → Settings → Variables and secrets.",
    };
  }

  const healthy = eligible.filter((p) =>
    isHealthy(states[p.id] ?? FRESH, now),
  );

  if (healthy.length === 0) {
    return {
      ok: false,
      reason: "all_unhealthy",
      message:
        "Every configured provider is failing. The circuit breakers will " +
        "reopen within a minute; the request has not been sent anywhere.",
    };
  }

  const withBudget = healthy.filter((p) => hasBudget(p, states[p.id] ?? FRESH));

  if (withBudget.length === 0) {
    return {
      ok: false,
      reason: "all_rate_limited",
      message:
        "Every configured provider has reached its free-tier limit for now. " +
        "Try again shortly, or add another provider key.",
    };
  }

  /**
   * ⚠️ FIRST MATCH, NOT LEAST-LOADED.
   *
   * Spreading load across providers sounds better and is worse here. The
   * registry order is a real preference — Groq is faster than GitHub
   * Models, and Cloudflare Workers AI is the only one allowed near
   * tenant data — so balancing would trade a quality decision for an
   * evenness nobody asked for. Providers further down the list exist to
   * be reached when the ones above are genuinely out, which is exactly
   * what the budget check above already establishes.
   */
  const chosen = withBudget[0]!;
  const state = states[chosen.id] ?? FRESH;

  return {
    ok: true,
    provider: chosen,
    reason:
      `${chosen.label} — ` +
      (chosen.requestsPerMinute === null
        ? "no published minute limit"
        : `${state.usedThisMinute}/${chosen.requestsPerMinute} this minute`) +
      (exclude.size > 0 ? `, after ${exclude.size} failed attempt(s)` : ""),
  };
}

/* ------------------------------------------------------------------ */
/* STATE TRANSITIONS                                                   */
/* ------------------------------------------------------------------ */

/**
 * The state after a successful call.
 *
 * ⚠️ `consecutiveFailures` resets to ZERO, not decrements. A provider
 * that answers is working; carrying two-thirds of a trip forward would
 * mean a provider that fails twice, succeeds a hundred times, then fails
 * once is treated identically to one failing three times in a row.
 */
export function afterSuccess(state: ProviderState = FRESH): ProviderState {
  return {
    usedThisMinute: state.usedThisMinute + 1,
    usedToday: state.usedToday + 1,
    consecutiveFailures: 0,
    breakerOpenUntil: 0,
  };
}

/**
 * The state after a failure.
 *
 * ⚠️ A RATE-LIMIT FAILURE STILL COUNTS AGAINST THE BUDGET. The request
 * was made and the provider counted it, whatever it returned. Not
 * counting it would let a rate-limited provider look like it had room
 * and be chosen again immediately — a retry loop that produces nothing
 * but 429s.
 */
export function afterFailure(
  state: ProviderState = FRESH,
  now: number,
  kind: "rate_limited" | "error" | "timeout",
): ProviderState {
  const failures = state.consecutiveFailures + 1;

  /**
   * ⚠️ A 429 DOES NOT TRIP THE BREAKER, AND THAT DISTINCTION MATTERS.
   *
   * Being rate-limited is not being broken — it is the provider working
   * exactly as documented. The budget ledger already routes around it,
   * and it recovers on its own at the top of the next minute. Tripping a
   * sixty-second breaker as well would sideline a perfectly healthy
   * provider for a minute it did not need, on every busy afternoon.
   *
   * The breaker is for providers that are actually failing: 5xx,
   * timeouts, connection refused.
   */
  const shouldTrip = kind !== "rate_limited" && failures >= BREAKER_THRESHOLD;

  return {
    usedThisMinute: state.usedThisMinute + 1,
    usedToday: state.usedToday + 1,
    consecutiveFailures: failures,
    breakerOpenUntil: shouldTrip ? now + BREAKER_COOLOFF_MS : state.breakerOpenUntil,
  };
}

/**
 * The full ordered attempt list for one request.
 *
 * `client.ts` walks this: try the first, and on failure re-ask the router
 * with that provider excluded. Exposed separately so a caller can see the
 * whole plan — and so the tests can assert the ORDER rather than just the
 * first choice.
 */
export function attemptOrder(input: RouterInput): AiProvider[] {
  const out: AiProvider[] = [];
  const excluded = new Set(input.exclude ?? []);

  // Bounded by the registry size; a provider can never be picked twice
  // because each iteration adds it to the exclusion set.
  for (let i = 0; i < 32; i += 1) {
    const decision = chooseProvider({ ...input, exclude: [...excluded] });
    if (!decision.ok) break;
    out.push(decision.provider);
    excluded.add(decision.provider.id);
  }

  return out;
}
