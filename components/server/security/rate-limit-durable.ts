import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE RATE LIMITER, ACTUALLY LIMITING
 * Version: v1.76.0-alpha · Wave 8
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS WRONG, IN THE LIMITER'S OWN WORDS
 * ══════════════════════════════════════════════════════════════════════
 * `lib/security/rate-limit.ts` prints this the first time it is used:
 *
 *     "Per-instance memory counters are a speed bump, not a control: on a
 *      serverless deployment the effective limit is (limit × instances)."
 *
 * Every word is correct, and `UPSTASH_REDIS_REST_URL` is not set on this
 * deployment. So the auth limit of 10 per minute is 10 × however many
 * instances Railway happens to be running — a number nobody controls and
 * nobody knows — and a fresh instance starts with an empty counter, so a
 * caller who reconnects often enough is never counted at all.
 *
 * ⚠️ AND THE WARNING IS `console.warn`, ONCE, ON A COLD START. Nobody
 * reads it. The product reported itself as rate limited and was not,
 * which is the seventeenth instance of declared-and-unenforced in this
 * codebase.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FIX IS THE DATABASE THAT IS ALREADY ON THE REQUEST PATH
 * ══════════════════════════════════════════════════════════════════════
 * Redis is the right backend and needs a service the operator has not
 * bought. Postgres is already there, already connected, already on every
 * request, and `ordence_rate_limit_hit` is ONE STATEMENT that is atomic
 * across every instance — which is the entire property the memory counter
 * lacks.
 *
 * ⚠️ IT IS A ROUND TRIP PER CHECK, AND THAT IS THE COST. On the auth and
 * portal paths it is worth it without argument. It is why `webhook` is
 * still allowed to fall through: 600/minute of provider callbacks is a
 * DoS ceiling, not a business rule, and a database write per callback is
 * a bill for defending against nothing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE KEY IS HASHED BEFORE IT IS STORED
 * ══════════════════════════════════════════════════════════════════════
 * A rate-limit key contains an IP address, or a tenant id and a user id.
 * An IP address with a timestamp identifies a person, so a table of every
 * key that has hit the product would be the single largest personal-data
 * table in the system and nobody asked for it.
 *
 * ⚠️ A HASH IS A PSEUDONYM, NOT ANONYMITY. Anybody who guesses an IP can
 * check it against the table — the input space is 2^32. It removes the
 * bulk-disclosure problem and it is written down rather than implied.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import {
  POLICY_CONFIG,
  registerDurableCounter,
  onRateLimitDegraded,
  type RateLimitPolicy,
} from "@/lib/security/rate-limit";

/** ⚠️ The same namespacing the memory and Redis paths use. */
function namespaced(policy: RateLimitPolicy, key: string): string {
  return `rl:${policy}:${key}`;
}

export function hashRateLimitKey(policy: RateLimitPolicy, key: string): string {
  return createHash("sha256").update(namespaced(policy, key)).digest("hex");
}

/**
 * ⭐⭐ ONE ROUND TRIP. Increment and return the count inside the window.
 *
 * ⚠️ ON THE UNSCOPED `db` CLIENT AND NOT `withTenant`, AND THAT IS
 * DELIBERATE. This runs on the unauthenticated path — an auth limit is
 * checked before anybody has a session, a portal limit is checked for a
 * client of a customer who has no account — so there is no tenant to
 * scope to. `rate_limit_counters` has no tenant column and no RLS, and
 * `SQL 0119` argues that exemption in writing rather than leaving it to
 * be inferred.
 *
 * 🔴 THE TENANT ID IS STILL INSIDE THE KEY where one exists, so one
 * workspace cannot consume another's budget. The absence of RLS is not
 * the absence of separation.
 */
async function hit(
  policy: RateLimitPolicy,
  key: string,
  nowMs: number,
): Promise<number> {
  const config = POLICY_CONFIG[policy];
  const keyHash = hashRateLimitKey(policy, key);
  const nowEpoch = Math.floor(nowMs / 1000);

  const result = await db.execute(sql`
    SELECT public.ordence_rate_limit_hit(
      ${keyHash}::char(64),
      ${policy}::varchar(20),
      ${config.windowSeconds}::integer,
      ${nowEpoch}::bigint
    ) AS hits
  `);

  const rows = Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : (((result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[]);

  const hits = Number(rows[0]?.hits);
  if (!Number.isFinite(hits) || hits < 1) {
    /**
     * ⚠️ REFUSED RATHER THAN TREATED AS ZERO. A backend that answers with
     * something unreadable is a backend that is not working, and reading
     * its answer as "no hits yet" would turn a broken limiter into an
     * open one — silently, which is how this whole class of bug survives.
     */
    throw new Error(
      `The rate limit counter returned ${JSON.stringify(rows[0])}, which is not a hit count.`,
    );
  }
  return hits;
}

/**
 * ⭐ THE SWEEPER. Expired windows are kept for two windows, not one — a
 * row deleted the instant its window ends is a row that vanishes while a
 * request that started inside it is still deciding.
 *
 * ⚠️ BOUNDED. An unbounded DELETE on the hottest small table in the
 * database takes a lock long enough to be felt on every request in
 * flight.
 */
export async function sweepRateLimitCounters(limit = 10_000): Promise<number> {
  const result = await db.execute(sql`
    SELECT public.ordence_rate_limit_sweep(${limit}::integer) AS deleted
  `);
  const rows = Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : (((result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[]);
  return Number(rows[0]?.deleted ?? 0);
}

let installed = false;

/**
 * ⭐⭐⭐ INSTALL THE DURABLE BACKEND AND THE DEGRADATION REPORTER.
 *
 * 🔴 `onRateLimitDegraded` HAD NO CALLER ANYWHERE IN THE CODEBASE BEFORE
 * THIS FUNCTION. It was written in Phase 20, documented, exported — and
 * the security event it exists to raise had therefore never fired once.
 * Found by grepping for its callers during this wave; it is the same
 * defect the limiter itself had, one level up.
 *
 * ⚠️ CALLED FROM `instrumentation.ts`, WHICH RUNS ONCE PER NODE PROCESS.
 * Not from a module top level: an import-time side effect runs in
 * whatever bundle happens to pull the module in, including the edge one,
 * where `node:crypto` and the database client do not exist.
 */
export function installDurableRateLimiter(): void {
  if (installed) return;
  installed = true;

  registerDurableCounter(hit);

  onRateLimitDegraded(({ policy, reason, message }) => {
    /**
     * ⚠️ IMPORTED LAZILY. `recordSecurityEvent` pulls in the database
     * client, and this callback is registered from a module the limiter
     * itself must never import — that separation is why the callback
     * exists at all.
     */
    void import("@/server/security/record")
      .then((events) =>
        events.recordSecurityEvent({
          /**
           * ⭐ `rate_limit.degraded` HAS EXISTED IN
           * `lib/security/events.ts` SINCE PHASE 20, with a severity, a
           * label and a SIEM mapping — and nothing has ever emitted it,
           * because the listener that would was never registered.
           */
          type: "rate_limit.degraded",
          severity: reason === "not_configured" ? "warning" : "critical",
          source: "rate-limit",
          tenantId: null,
          detail: { policy, reason, message },
          reason:
            `The ${policy} rate limit fell back to per-instance memory counters (${reason}). ` +
            `While this is true the effective limit is the policy limit multiplied by the ` +
            `number of running instances.`,
        }),
      )
      .catch(() => {
        /* A reporter that cannot report must not take the request with it. */
      });
  });
}
