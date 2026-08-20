import "server-only";

/**
 * Ordence — Track F · TENANT-SAFE CACHE KEYS
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE THING THIS FILE EXISTS TO MAKE IMPOSSIBLE
 * ══════════════════════════════════════════════════════════════════════
 * Serving tenant A's cached rows to tenant B.
 *
 * In Postgres that cannot happen: 309 tables carry `FORCE ROW LEVEL
 * SECURITY` and every policy compares `tenant_id` to
 * `app_current_tenant_id()`. In Redis there is no such thing. A cache
 * key is a string, and a string that forgot the tenant id is a
 * cross-tenant read with no error, no log line and no way to notice
 * except a customer telling you.
 *
 * `lib/redis.ts:28` already had the right idea — `tenantKey()` refuses
 * an empty tenant id. It has ZERO CALLERS, and it has three gaps that
 * matter:
 *
 *   ① `if (!tenantId)` accepts the string `"undefined"`, which is what
 *      you get from `String(someUndefinedVariable)`. That is not a
 *      hypothetical; it is the single most common way this bug ships.
 *   ② Nothing constrains the rest of the key, so two features can
 *      collide by choosing the same words.
 *   ③ Nothing checks on the way OUT. A key collision, however it
 *      happened, is served silently.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SHAPE, AND WHY IT IS THREE DEFENCES AND NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 * ① COMPILE TIME — `TenantCacheKey` is a branded type. A plain string
 *    will not type-check where one is required, so the only way to get a
 *    key is to call `tenantCacheKey()`, which requires a tenant id. This
 *    is the defence that costs nothing at runtime and catches the most.
 *
 * ② KEY CONSTRUCTION — the tenant id is validated against the SAME uuid
 *    regex `db/index.ts:404` uses for `withTenant()`, so "no tenant" and
 *    "a tenant id that is really the string 'undefined'" both throw here
 *    rather than producing a shared key. The namespace comes from a
 *    closed union, so a typo is a compile error.
 *
 * ③ READ TIME — the tenant id is ALSO stored inside the cached envelope
 *    and compared on read (`lib/cache/index.ts`). If a key ever collides
 *    anyway — a Redis instance shared with something else, a bug here, a
 *    manual `SET` — the value is discarded as a miss instead of being
 *    served. This is the defence that assumes the other two failed,
 *    which is the only kind worth having for this class of bug.
 *
 * ⚠️ Defence ③ is not redundancy for its own sake. ① and ② both live in
 * this repository and can both be edited away by somebody who is sure
 * they are unnecessary; ③ fails closed even then, and it is four lines.
 */

import { CACHE_SCHEMA_VERSION, type CacheNamespace } from "./namespaces";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ENVIRONMENT TAG, ADDED IN WAVE 17 BECAUSE UPSTASH IS REAL NOW
 * ══════════════════════════════════════════════════════════════════════
 * The wave-17 environment audit confirmed **Upstash Redis is configured
 * on production**. That turns one thing from hypothetical into live.
 *
 * Ordence has exactly ONE pair of Upstash variables
 * (`UPSTASH_REDIS_REST_URL` / `_TOKEN`, `lib/env.ts:70-71`). There is no
 * per-environment pair. So the moment a staging deploy, a preview
 * branch, or a developer's laptop is pointed at the same Upstash
 * database — which is the normal way a single credential gets used — a
 * key like
 *
 *     ord:v1:t:<tenant-uuid>:ledger-list
 *
 * is IDENTICAL in both. Same tenant id, same namespace, different
 * database behind it. Staging's ledger list is then served to the
 * production tenant, and the read-time envelope check cannot catch it:
 * the tenant id in the envelope MATCHES. It is the right tenant and the
 * wrong universe.
 *
 * ⚠️ SO THE ENVIRONMENT IS PART OF THE KEY. `NEXT_PUBLIC_ROOT_DOMAIN`
 * (`lib/env.ts:244`) is the discriminator: it is non-secret, it is
 * already catalogued, and it necessarily differs between environments
 * because it is the domain tenants are served on. `NODE_ENV` alone
 * would not do — two preview deployments are both "production".
 *
 * ⚠️ READ FROM `process.env` DIRECTLY, not through `getServerEnv()`.
 * `NEXT_PUBLIC_ROOT_DOMAIN` lives in the CLIENT schema, and importing
 * `@/lib/env` here would make a module that must be loadable in any
 * request depend on full server-env validation.
 *
 * ⚠️ IT IS READ ONCE AND FROZEN. A key built from a value that can
 * change mid-process would write under one prefix and read under
 * another, which presents as a cache that never hits.
 */
const ENV_TAG: string = (() => {
  const raw =
    process.env.NEXT_PUBLIC_ROOT_DOMAIN ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NODE_ENV ??
    "unset";
  const slug = raw
    .replace(/^https?:\/\//, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .toLowerCase();
  // "unset" rather than "" — an empty segment would collapse the key
  // shape and silently reintroduce the collision this exists to prevent.
  return slug.length > 0 ? slug : "unset";
})();

/** Exported for `scripts/perf/prove-cache-isolation.mts` and for debugging. */
export function cacheEnvironmentTag(): string {
  return ENV_TAG;
}

/**
 * A string that is KNOWN to carry a validated tenant id and a registered
 * namespace. The brand is a compile-time-only property; nothing is added
 * to the string at runtime.
 */
export type TenantCacheKey = string & { readonly __tenantScoped: unique symbol };

/**
 * ⚠️ THE SAME REGEX AS `db/index.ts:404`, DELIBERATELY DUPLICATED.
 *
 * Importing it would mean importing `@/db` — the Drizzle client, the
 * pool, `getServerEnv()` — from a module that must be safe to load in a
 * request that never touches the database. `db/index.ts` does not export
 * it in any case. Twelve characters of regex are the cheaper coupling.
 *
 * It rejects the nil uuid and any non-RFC-4122 variant, which is what
 * makes `"undefined"`, `""` and `"00000000-0000-0000-0000-000000000000"`
 * all fail rather than becoming a shared namespace.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * ⚠️ KEY PARTS ARE CONSTRAINED, AND THE REASON IS NOT AESTHETICS.
 *
 * A colon in a part would forge a key boundary: a part of
 * `"x:t:<other-tenant>"` inside tenant A's key produces a string that
 * READS as tenant B's key to anything scanning by prefix — including
 * `invalidateTenant()`, which deletes by prefix. Any character outside
 * this set is refused rather than escaped, because an escaping scheme is
 * one more thing that can be got wrong later.
 */
const SAFE_PART = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Build the only kind of cache key this codebase is allowed to use.
 *
 *     ord:v1:<env-tag>:t:<tenant-uuid>:<namespace>[:<part>...]
 *
 * Fixed prefix, then the environment, then the tenant — so that every
 * tenant's keys within one environment share a prefix and
 * `invalidateTenant()` can find them with one scan pattern, while two
 * environments sharing an Upstash database cannot collide at all.
 *
 * @throws if the tenant id is not a well-formed uuid, or a part contains
 *         anything outside `[A-Za-z0-9._-]`.
 */
export function tenantCacheKey(
  tenantId: string,
  namespace: CacheNamespace,
  ...parts: string[]
): TenantCacheKey {
  if (!UUID.test(tenantId)) {
    /*
     * ⚠️ The id is NOT included in the message. It is not a secret, but
     * this message reaches logs and the habit of interpolating tenant
     * identifiers into errors is how they end up in a third party's
     * error tracker.
     */
    throw new Error(
      "[SECURITY] tenantCacheKey() requires a well-formed tenant uuid. " +
        "A cache key without one is a key every tenant shares.",
    );
  }
  for (const part of parts) {
    if (!SAFE_PART.test(part)) {
      throw new Error(
        `[SECURITY] tenantCacheKey() refused a key part: it must match ${SAFE_PART}. ` +
          "A part containing ':' could forge another tenant's key prefix.",
      );
    }
  }
  return ["ord", CACHE_SCHEMA_VERSION, ENV_TAG, "t", tenantId, namespace, ...parts].join(
    ":",
  ) as TenantCacheKey;
}

/**
 * The prefix that matches every key belonging to one tenant, for
 * invalidation. Same validation, same reason.
 */
export function tenantKeyPrefix(tenantId: string, namespace?: CacheNamespace): string {
  if (!UUID.test(tenantId)) {
    throw new Error("[SECURITY] tenantKeyPrefix() requires a well-formed tenant uuid.");
  }
  const base = ["ord", CACHE_SCHEMA_VERSION, ENV_TAG, "t", tenantId];
  if (namespace) base.push(namespace);
  return base.join(":") + ":*";
}

/**
 * Read the tenant id back out of a key. Used by the read-time check in
 * `lib/cache/index.ts` and by tests; there is no other reason to call it.
 *
 * Returns null rather than throwing, because it is called on strings
 * that came back from Redis and may be anything at all.
 */
export function tenantIdFromKey(key: string): string | null {
  const parts = key.split(":");
  // ord : <version> : <env-tag> : t : <uuid> : <namespace> ...
  if (parts[0] !== "ord" || parts[3] !== "t") return null;
  const candidate = parts[4];
  return candidate && UUID.test(candidate) ? candidate : null;
}
