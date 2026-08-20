/**
 * Ordence — Track F · THE CACHE NAMESPACE REGISTRY
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY A CLOSED REGISTRY AND NOT A STRING
 * ══════════════════════════════════════════════════════════════════════
 * A cache in a multi-tenant system is the easiest place in the whole
 * product to serve one customer another customer's data, and row-level
 * security does not reach it. RLS lives in Postgres; Redis has never
 * heard of `app.current_tenant_id`.
 *
 * The failure does not look like a bug. It looks like a key that was
 * built out of a string somebody typed, in a hurry, one letter different
 * from the key somebody else typed. Two features share a key by
 * accident, and one tenant's invoice list is served to another.
 *
 * So there is no way to name a namespace except from this list. It is a
 * union type, not a string, and `tenantCacheKey()` will not accept
 * anything else. A typo becomes a compile error rather than a data
 * incident.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY ENTRY DECLARES A TTL AND SAYS WHY
 * ══════════════════════════════════════════════════════════════════════
 * A TTL is a promise about how stale a screen may be. An unbounded cache
 * entry is a promise that the screen may be wrong forever, which nobody
 * would agree to if it were written down. So it is written down.
 *
 * ⚠️ `invalidatesOn` is documentation with teeth: it names the write
 * that must call `invalidate()`. A namespace with an empty
 * `invalidatesOn` is a namespace that relies on the TTL alone, and that
 * is a decision, not an oversight — it must say so.
 */

export const CACHE_NAMESPACES = {
  /**
   * Chart of accounts. Read on every posting screen, written by hand a
   * few times a year. The clearest cache win in the product.
   */
  "ledger-list": {
    ttlSeconds: 300,
    why: "read on every posting screen, changed a handful of times a year",
    invalidatesOn: ["ledgers insert/update/delete"],
  },

  /**
   * GST rate lookup by HSN/SAC. `server/gst/engine.ts:96` opens TWO
   * tenant transactions PER INVOICE LINE to resolve these — see the N+1
   * finding in TRACK-REPORT.md §4. The rates are effectively static
   * between Council notifications.
   */
  "hsn-rate": {
    ttlSeconds: 3600,
    why: "resolved twice per invoice line today; changes only on a GST Council notification",
    invalidatesOn: ["hsn_sac_rates insert/update"],
  },

  /**
   * Entitlement/plan facts for a tenant. Already memoised per REQUEST by
   * React `cache()` in `server/entitlements.ts:45`; this extends that
   * across requests.
   *
   * ⚠️ SHORT TTL ON PURPOSE. This decides what a customer may do. A
   * downgrade that takes five minutes to bite is a support ticket; one
   * that takes an hour is a refund.
   */
  entitlements: {
    ttlSeconds: 60,
    why: "read on nearly every request; a stale entitlement grants access that was revoked",
    invalidatesOn: ["subscription change", "plan change", "seat grant"],
  },

  /**
   * Dashboard aggregates. Expensive, and nobody expects a dashboard to
   * be transactionally current.
   */
  "dashboard-summary": {
    ttlSeconds: 120,
    why: "aggregate scans over journal_entries; a two-minute-old dashboard is still a dashboard",
    invalidatesOn: [],
  },

  /**
   * Trial balance per financial period. The measured cost of computing
   * it live on the enterprise tenant is 46 ms and 27,444 shared buffers
   * — see `scripts/perf/results/measure-baseline.json`.
   *
   * ⚠️ MUST be invalidated on posting, not left to the TTL. A trial
   * balance that is two minutes stale is a wrong number on an accounting
   * screen, which is worse than a slow one.
   */
  "trial-balance": {
    ttlSeconds: 300,
    why: "46 ms and 27k buffers per computation on a 360k-row journal",
    invalidatesOn: ["journal_entries insert", "period close", "period reopen"],
  },
} as const;

export type CacheNamespace = keyof typeof CACHE_NAMESPACES;

export const CACHE_NAMESPACE_IDS = Object.keys(CACHE_NAMESPACES) as CacheNamespace[];

/**
 * ⚠️ BUMP THIS WHEN A CACHED PAYLOAD'S SHAPE CHANGES.
 *
 * Without it, a deploy that adds a field to a cached object reads back
 * yesterday's object, which lacks the field, and the failure appears
 * somewhere else entirely as `undefined`. The version is part of every
 * key, so a bump orphans the old entries and they expire on their own
 * TTL — no flush, no coordination, no window where two shapes are live
 * under one key.
 */
export const CACHE_SCHEMA_VERSION = "v1";
