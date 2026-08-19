/**
 * Ordence — Tenant-Aware Cache & Rate Limiting
 * Version: v0.1.0-alpha
 *
 * Upstash Redis is used over its REST API, which is fetch-based and therefore
 * Edge-compatible (a normal TCP Redis client is not).
 *
 * ISOLATION RULE (Blueprint: "Cache Isolation"): every key is namespaced with the
 * tenant id via `tenantKey()`. There is no un-namespaced setter exported.
 */

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

let client: Redis | null = null;

/** Returns null when Redis is not configured — callers must degrade gracefully. */
export function getRedis(): Redis | null {
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  client = new Redis({ url, token });
  return client;
}

/** Build a tenant-scoped cache key. The ONLY sanctioned way to name a key. */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  if (!tenantId) throw new Error("[SECURITY] tenantKey() requires a tenant id.");
  return ["t", tenantId, ...parts].join(":");
}

/** Read a tenant-scoped value. */
export async function cacheGet<T>(tenantId: string, key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get<T>(tenantKey(tenantId, key));
  } catch {
    return null; // Cache failures must never break the request path.
  }
}

/** Write a tenant-scoped value with a TTL (default 5 minutes). */
export async function cacheSet(
  tenantId: string,
  key: string,
  value: unknown,
  ttlSeconds = 300,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(tenantKey(tenantId, key), value, { ex: ttlSeconds });
  } catch {
    /* non-fatal */
  }
}

/** Per-tenant rate limiter. Falls back to "allow" when Redis is absent. */
export function getRateLimiter(requests = 100, window = "1 m") {
  const redis = getRedis();
  if (!redis) return null;
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requests, window as Parameters<typeof Ratelimit.slidingWindow>[1]),
    analytics: false,
    prefix: "ratelimit",
  });
}
