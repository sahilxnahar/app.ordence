/**
 * Ordence — Tenant Pattern Memory (Phase D, Agent Intelligence)
 * Version: v0.76.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS — AND WHAT IT DELIBERATELY IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * A per-tenant store of learned business patterns — facts an AI agent
 * picks up from running tasks and can use in future runs. This is the
 * Ordence equivalent of RUFLO's self-learning memory, but deliberately
 * simpler:
 *
 *   RUFLO learns coding patterns across projects using HNSW vector
 *   embeddings and SONA neural adaptation.
 *
 *   Ordence learns business patterns within ONE tenant using structured
 *   JSONB facts and a frequency counter. The patterns are not semantic
 *   — they are structured ("client XYZ disputes invoices over ₹5 lakh")
 *   — and they are auditable, because a pattern that cannot be read and
 *   verified is a pattern that cannot be trusted with business decisions.
 *
 * ⚠️ TENANT-SCOPED. Every row keys off `tenant_id` and is protected by
 * RLS. A pattern learned in tenant A is invisible to tenant B, and the
 * agent runner reads patterns only for the session's tenant.
 *
 * ⚠️ APPEND-OR-UPDATE, NEVER DELETE. A pattern is either new (inserted)
 * or seen again (occurrence_count incremented, last_seen updated). There
 * is no delete — a pattern that was learned was real, and erasing it
 * would make the agent's behaviour inexplicable.
 */

import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./core";

/**
 * The kinds of patterns an agent can learn. Each is a structured fact
 * about the tenant's business that makes future agent runs more useful.
 *
 * ⚠️ NOT FREE TEXT. A pattern type is a controlled vocabulary because
 * patterns are queried by type ("show me all disputed_invoice patterns")
 * and aggregated ("how many late_compliance patterns do we have"). The
 * valid types are listed in `lib/ai/patterns.ts`.
 *
 * varchar rather than pgEnum so new pattern types can be added without
 * a migration — the application layer validates the value.
 */

export const tenantPatterns = pgTable(
  "tenant_patterns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * The kind of pattern. See the type list in `lib/ai/patterns.ts`.
     * varchar rather than enum so new pattern types can be added without
     * a migration — the application layer validates the value.
     */
    patternType: varchar("pattern_type", { length: 60 }).notNull(),

    /**
     * A stable key that identifies this specific pattern instance.
     * e.g. "client:abc-corp:dispute-threshold" or "gst:mismatch:rate-12-vs-18".
     * Combined with tenant_id and pattern_type, this is unique — the same
     * pattern seen again increments the count rather than creating a
     * duplicate.
     */
    patternKey: varchar("pattern_key", { length: 200 }).notNull(),

    /**
     * The structured fact. What the agent learned, in a shape that can
     * be read by a human and injected into a system prompt.
     *
     * Convention: always includes a `summary` field (one sentence) and
     * any structured details specific to the pattern type.
     */
    patternData: jsonb("pattern_data")
      .$type<{
        summary?: string;
        [key: string]: unknown;
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** How many times this pattern has been observed. */
    occurrenceCount: integer("occurrence_count").default(1).notNull(),

    /** The agent that most recently recorded this pattern. */
    lastAgentId: varchar("last_agent_id", { length: 60 }),

    lastSeen: timestamp("last_seen", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("tenant_patterns_tenant_idx").on(t.tenantId, t.patternType),
    /** One row per unique (tenant, type, key). Seeing it again increments. */
    uniquePattern: uniqueIndex("tenant_patterns_unique_key").on(
      t.tenantId,
      t.patternType,
      t.patternKey,
    ),
    recentIdx: index("tenant_patterns_recent_idx")
      .on(t.tenantId, t.lastSeen)
      .where(sql`${t.occurrenceCount} >= 1`),
  }),
);
