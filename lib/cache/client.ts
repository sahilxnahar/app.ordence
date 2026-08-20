import "server-only";

/**
 * Ordence — Track F · THE CACHE CLIENT SEAM
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * `lib/cache/index.ts` needs a Redis client. `lib/redis.ts:18` already
 * provides one and this delegates to it — so there is exactly one place
 * that reads `UPSTASH_REDIS_REST_URL` and exactly one memoised client.
 *
 * The reason for the indirection is the read-time cross-tenant defence
 * in `lib/cache/index.ts`. That defence exists FOR THE CASE WHERE KEY
 * CONSTRUCTION FAILED — a shared Redis database, a manual `SET`, a
 * regression in `keys.ts`. It cannot be exercised by calling the cache
 * API correctly, because no correct call can produce a poisoned entry.
 * It can only be exercised by writing one directly into the store.
 *
 * ES module namespaces are frozen, so a test cannot replace
 * `getRedis()` from outside. Without a seam the single most important
 * guarantee in this module would be untestable — and an untested
 * guarantee in this repository has, twenty-three times, turned out not
 * to hold.
 *
 * ⭐ SO THE SEAM IS OWNED, NAMED AND GUARDED rather than improvised.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND IT REFUSES TO OPEN IN PRODUCTION
 * ══════════════════════════════════════════════════════════════════════
 * A test hook that can be reached at runtime is a way to replace the
 * cache with something an attacker controls. `setCacheClientForTests()`
 * throws when `NODE_ENV === "production"`, so the worst a bug can do is
 * crash a process that was never meant to call it.
 */

import { getRedis } from "@/lib/redis";

/**
 * The four operations `lib/cache` uses. Deliberately NOT the full
 * Upstash surface: a narrow type is a narrow blast radius, and it makes
 * the stand-in in `scripts/perf/prove-cache-isolation.mts` a complete
 * implementation rather than a partial mock.
 */
export type CacheClient = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts: { ex: number }): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(
    cursor: string,
    opts: { match: string; count: number },
  ): Promise<[number | string, string[]]>;
};

let override: CacheClient | null = null;

/** Returns null when Upstash is not configured. Callers MUST degrade. */
export function getCacheClient(): CacheClient | null {
  if (override) return override;
  return getRedis() as unknown as CacheClient | null;
}

/**
 * Test-only. Pass `null` to restore the real client.
 *
 * @throws in production, always.
 */
export function setCacheClientForTests(client: CacheClient | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[SECURITY] setCacheClientForTests() was called in production. " +
        "This hook replaces the cache backend; it must never be reachable at runtime.",
    );
  }
  override = client;
}
