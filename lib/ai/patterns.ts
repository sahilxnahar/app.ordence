/**
 * Ordence — ⭐ TENANT PATTERN MEMORY
 * Version: v0.76.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES
 * ══════════════════════════════════════════════════════════════════════
 * Two functions:
 *
 *   `getTenantPatterns(tenantId)` — read the patterns an agent should
 *   know about before it starts. Called by the agent runner and injected
 *   into the system prompt.
 *
 *   `recordPattern(tenantId, type, key, data, agentId)` — upsert a
 *   pattern. If the (tenant, type, key) combination exists, increment the
 *   count and update last_seen. If not, insert.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS NOT A VECTOR DATABASE
 * ══════════════════════════════════════════════════════════════════════
 * RUFLO uses HNSW vector embeddings for semantic pattern retrieval.
 * Ordence's patterns are structured business facts, not semantic
 * embeddings: "client XYZ disputes invoices over ₹5 lakh" is a fact with
 * a type, a key, and a count — not a vector. A JSONB column with an index
 * on (tenant_id, pattern_type) is sufficient, auditable, and far simpler
 * to debug. An inspector can read these rows; nobody can read a vector.
 */

import "server-only";

import { and, eq, desc, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { tenantPatterns } from "@/db/schema/ai-patterns";

/* ------------------------------------------------------------------ */
/* PATTERN TYPES — the controlled vocabulary                           */
/* ------------------------------------------------------------------ */

/**
 * The valid pattern types. The agent runner and any future pattern
 * recorder must use one of these. Adding a new type is a code change,
 * not a migration — the column is varchar and validated here.
 */
export const PATTERN_TYPES = [
  "disputed_invoice",
  "late_compliance",
  "boq_variation_trend",
  "gst_mismatch",
  "overdue_receivable",
  "field_job_repeat_visit",
  "low_stock_reorder",
  "licence_expiring",
] as const;

export type PatternType = (typeof PATTERN_TYPES)[number];

/* ------------------------------------------------------------------ */
/* THE SHAPE RETURNED TO THE AGENT RUNNER                              */
/* ------------------------------------------------------------------ */

export type TenantPattern = {
  patternType: string;
  patternKey: string;
  patternData: { summary?: string; [key: string]: unknown };
  occurrenceCount: number;
  lastSeen: Date;
};

/* ------------------------------------------------------------------ */
/* READ — getTenantPatterns                                            */
/* ------------------------------------------------------------------ */

/**
 * Read the most relevant patterns for a tenant. Returns the top 20 by
 * occurrence count (most frequently seen first), which is what an agent
 * needs in its system prompt — the patterns that have been observed most
 * often are the ones most likely to recur.
 *
 * ⚠️ RUNS INSIDE `withTenant()` UNDER RLS. Even though the query filters
 * by tenant_id, the RLS policy is the enforcing layer — if this function
 * were called with the wrong tenant id, RLS would return nothing rather
 * than another tenant's patterns.
 */
export async function getTenantPatterns(
  tenantId: string,
): Promise<TenantPattern[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        patternType: tenantPatterns.patternType,
        patternKey: tenantPatterns.patternKey,
        patternData: tenantPatterns.patternData,
        occurrenceCount: tenantPatterns.occurrenceCount,
        lastSeen: tenantPatterns.lastSeen,
      })
      .from(tenantPatterns)
      .where(eq(tenantPatterns.tenantId, tenantId))
      .orderBy(desc(tenantPatterns.occurrenceCount))
      .limit(20);

    return rows.map((r) => ({
      patternType: r.patternType,
      patternKey: r.patternKey,
      patternData: r.patternData,
      occurrenceCount: r.occurrenceCount,
      lastSeen: r.lastSeen,
    }));
  });
}

/* ------------------------------------------------------------------ */
/* WRITE — recordPattern                                               */
/* ------------------------------------------------------------------ */

export type PatternData = {
  summary?: string;
  [key: string]: unknown;
};

/**
 * ⭐ Upsert a pattern. If the (tenant, type, key) combination exists,
 * increment the count and update last_seen and the data. If not, insert.
 *
 * ⚠️ RUNS INSIDE `withTenant()` UNDER RLS. The write is protected by the
 * same RLS policy as every other tenant-scoped table.
 *
 * ⚠️ VALIDATES THE PATTERN TYPE. An unknown type is rejected — it would
 * create a row that no query ever retrieves, and silence is the wrong
 * response to a programming error.
 */
export async function recordPattern(
  tenantId: string,
  patternType: PatternType,
  patternKey: string,
  data: PatternData,
  agentId?: string,
): Promise<void> {
  if (!PATTERN_TYPES.includes(patternType)) {
    throw new Error(
      `Unknown pattern type "${patternType}". Valid types: ${PATTERN_TYPES.join(", ")}.`,
    );
  }

  if (!patternKey || patternKey.trim().length === 0) {
    throw new Error("patternKey is required and must not be empty.");
  }

  await withTenant(tenantId, async (tx) => {
    // Try to find an existing row with the same (tenant, type, key).
    const existing = await tx
      .select({ id: tenantPatterns.id })
      .from(tenantPatterns)
      .where(
        and(
          eq(tenantPatterns.tenantId, tenantId),
          eq(tenantPatterns.patternType, patternType),
          eq(tenantPatterns.patternKey, patternKey),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // Increment the count and update the data and timestamp.
      await tx
        .update(tenantPatterns)
        .set({
          occurrenceCount: sql`${tenantPatterns.occurrenceCount} + 1`,
          patternData: data,
          lastSeen: new Date(),
          lastAgentId: agentId ?? null,
        })
        .where(eq(tenantPatterns.id, existing[0]!.id));
    } else {
      // Insert a new pattern.
      await tx.insert(tenantPatterns).values({
        tenantId,
        patternType,
        patternKey,
        patternData: data,
        occurrenceCount: 1,
        lastAgentId: agentId ?? null,
      });
    }
  });
}
