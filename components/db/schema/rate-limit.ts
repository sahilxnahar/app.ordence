/**
 * Ordence — ⭐⭐ THE RATE LIMIT COUNTER — SQL 0119 · WAVE 8
 * Version: v1.76.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE TABLE IN THIS PRODUCT WITH NO TENANT COLUMN AND NO RLS
 * ══════════════════════════════════════════════════════════════════════
 * That is deliberate and it could not be otherwise:
 *
 *   • an auth limit is checked BEFORE anybody is authenticated, so there
 *     is no tenant to scope to;
 *   • a portal limit is checked for a client of a customer, who has no
 *     account;
 *   • an IP limit exists precisely to count somebody we cannot identify.
 *
 * ⭐ WHAT MAKES IT SAFE INSTEAD:
 *   ① it holds no tenant data and no personal data — a hash, a count and
 *     two timestamps;
 *   ② the tenant id is inside the key where one exists, so one workspace
 *     cannot consume another's budget. The absence of RLS is not the
 *     absence of separation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY IT IS DEFINED IN DRIZZLE AT ALL, GIVEN NOTHING QUERIES IT HERE
 * ══════════════════════════════════════════════════════════════════════
 * `check:sql-completeness` reports every table that exists in SQL and not
 * in the schema, because `drizzle-kit push` treats those as drift and may
 * DROP them. `push` is banned outright in this project — it drops RLS
 * policies on three hundred tables — and a table whose safety depends on
 * a ban being remembered is a table one afternoon away from being gone.
 *
 * 🔴 THE COUNTER IS WRITTEN THROUGH `ordence_rate_limit_hit`, NOT THROUGH
 * THIS DEFINITION. A single atomic statement is the whole point; an
 * insert-then-update through the ORM would be two round trips and a race.
 */

import { sql } from "drizzle-orm";
import { bigint, char, check, index, integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    /** 🔴 SHA-256 of the namespaced key, hex. Never the key. */
    keyHash: char("key_hash", { length: 64 }).notNull(),
    /** Epoch second of the fixed window's start. Part of the key. */
    windowStart: bigint("window_start", { mode: "number" }).notNull(),

    /** ⚠️ For pruning and operator visibility only, never for the decision. */
    policy: varchar("policy", { length: 20 }).notNull(),
    windowSeconds: integer("window_seconds").notNull(),

    hits: integer("hits").default(1).notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiryIdx: index("rate_limit_counters_expiry_idx").on(t.expiresAt),

    hitsPositive: check("rate_limit_counters_hits_positive", sql`${t.hits} > 0`),
    windowPositive: check(
      "rate_limit_counters_window_positive",
      sql`${t.windowSeconds} > 0`,
    ),
    /**
     * ⚠️ `char(64)` ALONE WOULD SILENTLY ACCEPT A RAW KEY PADDED TO 64
     * CHARACTERS, which is exactly the mistake this table exists to make
     * impossible.
     */
    hashIsAHash: check(
      "rate_limit_counters_hash_is_a_hash",
      sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
