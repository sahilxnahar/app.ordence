import "server-only";

/**
 * Ordence — Usage DERIVED From Rows, Not Tallied Into a Counter
 * Version: v1.52.0-alpha (Batch 56)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A COUNTER THAT INCREMENTS IS A COUNTER THAT DRIFTS.
 * ══════════════════════════════════════════════════════════════════════
 * `usage_levels.current_value` for `storage_bytes` is written by
 * `reserveStorageBytes()` on upload and `releaseStorageBytes()` on delete.
 * Every one of those writes is best-effort by design — metering must never
 * fail a customer's upload — so every one of them is a chance to drift,
 * and the drift is ALWAYS in the direction that hurts:
 *
 *   • an upload that succeeded while the metering write failed → we
 *     under-count, and bill less than we should;
 *   • a delete whose release failed, a restore, a bulk import rolled back
 *     after the reservation, a row removed by a support script → we
 *     over-count, and REFUSE AN UPLOAD FROM A CUSTOMER WHO HAS SPACE.
 *
 * The second is the one that generates the ticket, and it is unanswerable:
 * the customer can see their documents, add up the sizes, and be right.
 * `reconcileStorageLevel()` has existed since Phase 15 to fix exactly
 * this — AND IT WAS CALLED FROM NOWHERE. The correction existed; the
 * decision was still made against the drifting number.
 *
 * ⭐ So the rule is now: WHERE THE TRUTH CAN BE DERIVED FROM ROWS, THE
 * DECISION IS MADE AGAINST THE ROWS. The counter survives as a cache for
 * display and as the thing reconciliation repairs — never as the thing an
 * enforcement decision reads.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS DERIVABLE, AND WHAT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 *   storage_bytes        DERIVED. `SUM(documents.size_bytes)` over live
 *                        rows IS the definition of the number.
 *   seats                DERIVED, already — `countSeatsInUse()` counts
 *                        `users` rows. There is no seat counter, and there
 *                        must never be one.
 *   emails_sent          COUNTER. Reconcilable in principle against the
 *                        provider's own log, which is not in our database.
 *   api_calls            COUNTER, GENUINELY NECESSARY — see below.
 *   portal_links_created COUNTER. Uncapped, so drift costs nothing.
 *
 * ⚠️ WHY `api_calls` STAYS A COUNTER.
 * A cumulative metric cannot be derived from current state at all: there
 * is no row that says "this call happened" unless we keep one, and keeping
 * one row per API call is a table that grows without bound and is
 * expensive to aggregate on every quota check. `mcp_call_log` DOES retain
 * that row for the MCP surface, so the counter is RECONCILABLE against it
 * for any window the log still covers — `reconcilableApiCalls()` below is
 * that source, and it is how a disputed invoice line gets settled. The
 * counter stays because it is cheap and O(1); the log stays because the
 * counter has to be checkable against something.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import type { MeteringPeriod } from "@/lib/metering/period";
import type { UsageMetric } from "@/lib/metering/quota";
import type { TransactionHandle } from "./record";

/**
 * Metrics whose enforcement decision reads rows rather than a counter.
 *
 * Exported as data so a test can assert that every member really is
 * derived at the decision point, rather than trusting a comment.
 */
export const DERIVED_METRICS: readonly UsageMetric[] = ["storage_bytes"];

export function isDerivedMetric(metric: UsageMetric): boolean {
  return DERIVED_METRICS.includes(metric);
}

/**
 * Read a `::text` aggregate back as an exact `bigint`.
 *
 * ⚠️ `documents.size_bytes` is declared `mode: "number"` in the Phase 8
 * schema. Harmless for one file, wrong for a sum over a library: a tenant
 * with enough documents exceeds 2^53 and the JavaScript addition rounds
 * SILENTLY. Postgres does the sum; the wire carries a string; `BigInt`
 * parses it. There is no float anywhere on this path.
 */
function exactBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  const text = typeof value === "string" ? value : String(value ?? "0");
  const digits = text.trim();
  if (!/^-?\d+$/.test(digits)) return 0n;
  const parsed = BigInt(digits);
  // A negative aggregate means a corrupt row, not a credit. Clamp, because
  // a negative "used" would make every quota comparison read as healthy.
  return parsed < 0n ? 0n : parsed;
}

function firstRow<T>(result: unknown): T | undefined {
  const withRows = result as { rows?: T[] };
  if (Array.isArray(withRows?.rows)) return withRows.rows[0];
  return Array.isArray(result) ? (result as T[])[0] : undefined;
}

/**
 * 🔴 THE TRUTH FOR STORAGE. One indexed aggregate over one tenant's rows.
 *
 * Deliberately the SAME predicate as `reconcileStorageLevel()` — live rows
 * only, tenant pinned in the WHERE as well as by RLS. If these two ever
 * disagree, reconciliation would write a number that the gate then refuses
 * to believe, and the customer would watch their usage figure flip between
 * two values on refresh.
 */
export async function deriveStorageBytes(tenantId: string): Promise<bigint> {
  return withTenant(tenantId, (tx) => deriveStorageBytesIn(tx, tenantId));
}

/**
 * The same aggregate, run INSIDE a transaction the caller already opened.
 *
 * ⚠️ THIS OVERLOAD IS NOT A CONVENIENCE. `getCurrentUsage()` is already
 * inside `withTenant`, and calling the wrapper from in there would open a
 * SECOND scoped connection while the first is still held — which on a
 * pooled Neon connection is at best a wasted round trip and at worst a
 * self-deadlock under load. A derivation that hangs the upload path would
 * be a strictly worse bug than the drift it was added to fix.
 */
export async function deriveStorageBytesIn(
  tx: TransactionHandle,
  tenantId: string,
): Promise<bigint> {
  const result = await tx.execute(sql`
    SELECT COALESCE(SUM(size_bytes), 0)::text AS total
      FROM documents
     WHERE tenant_id = ${tenantId}::uuid
       AND deleted_at IS NULL
  `);
  return exactBigInt(firstRow<{ total: string }>(result)?.total ?? "0");
}

export type MetricDrift = {
  metric: UsageMetric;
  /** What the rows say. This is the number that decides. */
  derived: bigint;
  /** What the counter says. This is the number that was displayed. */
  stored: bigint;
  /** derived - stored. Negative = the counter was over-reporting. */
  drift: bigint;
};

/**
 * The support answer to "why did it refuse me when I have space".
 *
 * Returns the two numbers side by side rather than a boolean, because the
 * SIGN of the drift is the diagnosis: negative means a release was lost
 * and the customer was wrongly refused; positive means a reservation was
 * lost and we under-billed. Those are different bugs with different fixes.
 */
export async function storageDrift(
  tenantId: string,
  storedValue: bigint,
): Promise<MetricDrift> {
  const derived = await deriveStorageBytes(tenantId);
  return {
    metric: "storage_bytes",
    derived,
    stored: storedValue,
    drift: derived - storedValue,
  };
}

/**
 * The reconcilable source for `api_calls`, for the billing period given.
 *
 * ⚠️ THIS IS NOT THE ENFORCEMENT NUMBER AND MUST NOT BECOME ONE.
 * `mcp_call_log` covers the MCP surface only, and it is subject to
 * retention. Treating it as the meter would under-count every non-MCP
 * caller and would silently reduce a customer's bill the day a retention
 * job ran. It exists so that a customer who disputes an invoice line can
 * be shown rows, and so that a large gap between this and the counter is
 * detectable — a gap is a bug in one of them, and finding out from a
 * customer is the expensive way.
 */
export async function reconcilableApiCalls(
  tenantId: string,
  period: MeteringPeriod,
): Promise<bigint> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT COUNT(*)::text AS total
        FROM mcp_call_log
       WHERE tenant_id = ${tenantId}::uuid
         AND occurred_at >= ${period.periodStart}
         AND occurred_at <  ${period.periodEnd}
    `);
    return exactBigInt(firstRow<{ total: string }>(result)?.total ?? "0");
  });
}
