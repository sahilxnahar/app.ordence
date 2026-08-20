import "server-only";

/**
 * Ordence — Track F · THE TENANT-SAFE CACHE
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `cached()` wraps a loader. On a hit it returns the stored value; on a
 * miss it runs the loader, stores the result, and returns it. That is
 * the whole idea. Everything else in this file is about the two ways a
 * cache in this product could do real damage.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 DAMAGE ①: SERVING ONE TENANT ANOTHER TENANT'S ROWS
 * ══════════════════════════════════════════════════════════════════════
 * RLS does not protect a cache. See `lib/cache/keys.ts` for the key-side
 * defences; the read-side defence is here, and it is the one that
 * assumes the others were removed:
 *
 *   • every stored value is wrapped in an envelope carrying the tenant
 *     id it was computed for,
 *   • on read, that id is compared to the id the caller asked for,
 *   • a mismatch is treated as a MISS and the entry is deleted.
 *
 * It costs one string comparison. It means a key collision — from a
 * shared Redis instance, a bad deploy, a manual `SET`, a future edit to
 * `keys.ts` — produces a slow request instead of a data breach.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 DAMAGE ②: A CACHE OUTAGE BECOMING AN APPLICATION OUTAGE
 * ══════════════════════════════════════════════════════════════════════
 * `UPSTASH_REDIS_REST_URL` is optional in `lib/env.ts:70`. Redis is
 * therefore ABSENT in local development, in CI, and in any environment
 * where somebody forgot the variable. A cache that throws when it cannot
 * reach Redis would turn a missing optional variable into a total
 * outage.
 *
 * So every failure path here returns "miss" and runs the loader. The
 * loader is the source of truth; the cache is an optimisation. The only
 * thing that ever throws out of this module is a MALFORMED TENANT ID,
 * because that one is a programming error whose correct behaviour is to
 * stop.
 *
 * ⚠️ Degradation is COUNTED, not silent — `cacheStats()` reports it, and
 * `scripts/perf/check-cache-adoption.mjs` reads it. A cache that has
 * silently been missing 100% of the time for a month is indistinguishable
 * from no cache at all, and that is exactly the shape of defect this
 * repository keeps finding.
 */

import { getCacheClient } from "./client";
import { CACHE_NAMESPACES, type CacheNamespace } from "./namespaces";
import {
  tenantCacheKey,
  tenantIdFromKey,
  tenantKeyPrefix,
  type TenantCacheKey,
} from "./keys";

export {
  tenantCacheKey,
  tenantKeyPrefix,
  cacheEnvironmentTag,
  type TenantCacheKey,
} from "./keys";
export { CACHE_NAMESPACES, CACHE_NAMESPACE_IDS, type CacheNamespace } from "./namespaces";
export { getCacheClient, setCacheClientForTests, type CacheClient } from "./client";

/**
 * The envelope. `t` is the tenant id the value was computed for; `v` is
 * the value; `w` is when it was written, so a caller can reason about
 * staleness without a second round trip.
 *
 * Single-letter keys because this is serialised on every write and read
 * of every cached object in the product, and the names carry no meaning
 * anybody reads.
 */
type Envelope<T> = { t: string; v: T; w: number };

let hits = 0;
let misses = 0;
let degraded = 0;
let refusedCrossTenant = 0;

export type CacheStats = {
  hits: number;
  misses: number;
  /** Reads and writes that could not reach Redis at all. */
  degraded: number;
  /**
   * 🔴 MUST BE ZERO. Any non-zero value here is a key collision that was
   * caught at read time. It is not "handled" — it is evidence.
   */
  refusedCrossTenant: number;
  /** False when Upstash is not configured; then every read is a miss. */
  configured: boolean;
};

export function cacheStats(): CacheStats {
  return { hits, misses, degraded, refusedCrossTenant, configured: getCacheClient() !== null };
}

/** Test-only. Nothing in the request path should reset counters. */
export function resetCacheStats(): void {
  hits = misses = degraded = refusedCrossTenant = 0;
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

/**
 * Read one entry. Returns `undefined` for a miss — NOT `null`, because
 * `null` is a legitimate cached value and the two must be
 * distinguishable. Conflating them is how a cache ends up re-running an
 * expensive loader that correctly returns nothing, forever.
 */
export async function cacheRead<T>(
  tenantId: string,
  key: TenantCacheKey,
): Promise<T | undefined> {
  const redis = getCacheClient();
  if (!redis) {
    degraded++;
    misses++;
    return undefined;
  }

  let raw: Envelope<T> | null;
  try {
    raw = await redis.get<Envelope<T>>(key);
  } catch {
    // Upstash unreachable, rate-limited, or returning nonsense.
    degraded++;
    misses++;
    return undefined;
  }

  if (raw === null || typeof raw !== "object") {
    misses++;
    return undefined;
  }

  /*
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE CROSS-TENANT CHECK. THIS IS THE POINT OF THE ENVELOPE.
   * ══════════════════════════════════════════════════════════════════
   * Both the id inside the value AND the id encoded in the key are
   * compared to the id the caller asked for. Either one alone would be
   * defeated by the corresponding half of a bug; together they require
   * two independent things to be wrong at once.
   *
   * ⚠️ The entry is DELETED, not merely ignored. Leaving a poisoned
   * entry in place means the next reader repeats the check, the counter
   * climbs, and nobody can tell one incident from a thousand.
   */
  if (raw.t !== tenantId || tenantIdFromKey(key) !== tenantId) {
    refusedCrossTenant++;
    misses++;
    console.error(
      "[SECURITY][cache] Refused a cached value whose tenant does not match the caller. " +
        "This is a key collision, not a cache miss. Entry deleted.",
    );
    try {
      await redis.del(key);
    } catch {
      /* best effort — the value is already refused */
    }
    return undefined;
  }

  hits++;
  return raw.v;
}

/* ------------------------------------------------------------------ */
/* WRITE                                                               */
/* ------------------------------------------------------------------ */

export async function cacheWrite<T>(
  tenantId: string,
  key: TenantCacheKey,
  namespace: CacheNamespace,
  value: T,
): Promise<void> {
  const redis = getCacheClient();
  if (!redis) {
    degraded++;
    return;
  }
  /*
   * ⚠️ THE TTL COMES FROM THE REGISTRY, NEVER FROM THE CALLER. A caller
   * that can pass its own TTL can pass `0`, or forget one, and the
   * registry stops being the answer to "how stale can this screen be".
   * `CACHE_NAMESPACES` is a `const` object, so this lookup cannot miss.
   */
  const ttl = CACHE_NAMESPACES[namespace].ttlSeconds;
  const envelope: Envelope<T> = { t: tenantId, v: value, w: Date.now() };
  try {
    await redis.set(key, envelope, { ex: ttl });
  } catch {
    degraded++;
  }
}

/* ------------------------------------------------------------------ */
/* THE ONE CALLERS SHOULD USE                                          */
/* ------------------------------------------------------------------ */

/**
 * Read-through cache.
 *
 * @example
 *   const ledgers = await cached(
 *     ctx.tenant.id,
 *     "ledger-list",
 *     [],
 *     () => withTenant(ctx.tenant.id, (tx) => tx.select().from(ledgers)),
 *   );
 *
 * ⚠️ THE LOADER MUST BE TENANT-SCOPED ITSELF. This function does not and
 * cannot verify that; `withTenant(tenantId, ...)` inside the loader is
 * what makes the value correct, and caching it under a tenant key is
 * what keeps it correct. A loader that used `withPlatformScope()` would
 * write a cross-tenant result under one tenant's key — which is why
 * there is no overload of this function that takes a platform scope.
 *
 * ⚠️ NO STAMPEDE LOCK, DELIBERATELY. When a hot key expires, every
 * in-flight request runs the loader once. A lock would fix that and
 * would introduce a distributed lock that can be held by a process that
 * died — a much worse failure than N duplicate reads of a query that
 * already runs in single-digit milliseconds. If a loader is ever
 * expensive enough that the stampede matters, the answer is a shorter
 * loader, not a lock. This is a decision, not an omission.
 */
export async function cached<T>(
  tenantId: string,
  namespace: CacheNamespace,
  parts: string[],
  loader: () => Promise<T>,
): Promise<T> {
  // Throws on a malformed tenant id. That is the one thing worth failing on.
  const key = tenantCacheKey(tenantId, namespace, ...parts);

  const hit = await cacheRead<T>(tenantId, key);
  if (hit !== undefined) return hit;

  const value = await loader();
  await cacheWrite(tenantId, key, namespace, value);
  return value;
}

/* ------------------------------------------------------------------ */
/* INVALIDATION                                                        */
/* ------------------------------------------------------------------ */

/**
 * Drop one entry.
 *
 * ⚠️ Invalidation is the caller's job and the registry says whose. Each
 * entry in `CACHE_NAMESPACES` lists the writes that must call this; a
 * namespace with an empty `invalidatesOn` has explicitly chosen to rely
 * on its TTL.
 */
export async function invalidate(
  tenantId: string,
  namespace: CacheNamespace,
  ...parts: string[]
): Promise<void> {
  const redis = getCacheClient();
  const key = tenantCacheKey(tenantId, namespace, ...parts);
  if (!redis) {
    degraded++;
    return;
  }
  try {
    await redis.del(key);
  } catch {
    degraded++;
  }
}

/**
 * Drop every entry for one tenant, or one namespace of one tenant.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `SCAN`, NEVER `KEYS`. `KEYS` walks the entire keyspace in one
 * blocking operation; on a shared Upstash database that is every other
 * tenant's latency, and on a large one it is a timeout. `SCAN` is
 * cursored and bounded.
 *
 * ⚠️ AND IT IS BOUNDED AGAIN HERE. An unbounded loop over a cursor is
 * the same availability incident as an unbounded query — it just has a
 * different name. `MAX_SCAN_ROUNDS` caps the work; if the cap is hit,
 * the remaining entries are left to their TTL and the fact is LOGGED,
 * because silently doing half of an invalidation is how a customer ends
 * up looking at data they deleted.
 */
const MAX_SCAN_ROUNDS = 100;
const SCAN_COUNT = 200;

export async function invalidateTenant(
  tenantId: string,
  namespace?: CacheNamespace,
): Promise<{ deleted: number; complete: boolean }> {
  const redis = getCacheClient();
  // Validates the tenant id; throws on a malformed one, as everywhere else.
  const pattern = tenantKeyPrefix(tenantId, namespace);

  if (!redis) {
    degraded++;
    return { deleted: 0, complete: false };
  }

  let cursor = "0";
  let deleted = 0;
  let rounds = 0;

  try {
    do {
      const [next, keys] = await redis.scan(cursor, { match: pattern, count: SCAN_COUNT });
      cursor = String(next);
      if (keys.length > 0) {
        await redis.del(...(keys as string[]));
        deleted += keys.length;
      }
      rounds++;
    } while (cursor !== "0" && rounds < MAX_SCAN_ROUNDS);
  } catch {
    degraded++;
    return { deleted, complete: false };
  }

  const complete = cursor === "0";
  if (!complete) {
    console.warn(
      `[cache] invalidateTenant stopped after ${MAX_SCAN_ROUNDS} scan rounds with ` +
        `${deleted} keys deleted. The remainder will expire on its TTL.`,
    );
  }
  return { deleted, complete };
}
