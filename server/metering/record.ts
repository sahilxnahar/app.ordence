import "server-only";

/**
 * Ordence — Usage Recorders
 * Version: v0.14.0-alpha (Phase 15)
 *
 * ══════════════════════════════════════════════════════════════════════
 * RULE 1: METERING MUST NEVER BREAK THE REQUEST IT MEASURES
 * ══════════════════════════════════════════════════════════════════════
 * Every function in this file that OBSERVES usage swallows its own errors
 * and returns a boolean. Not because failures do not matter — they are
 * logged loudly, with the tenant and the metric — but because of what the
 * alternative does.
 *
 * A metering write that can throw means:
 *
 *   • A database hiccup turns a successful API call into a 500. The
 *     customer's integration breaks, and the cause is our billing
 *     bookkeeping, which they are not even aware exists.
 *   • Worse, and this is the one that decides it: a tenant who has hit a
 *     lock contention or a connection limit gets errors on the metered
 *     path FIRST — i.e. the busiest customers, the ones paying the most,
 *     experience the outage first and hardest.
 *   • Worst: an email is sent, the counter write fails, the request 500s,
 *     the caller retries, and the email is sent AGAIN. Making the recorder
 *     throw converts a lost count into a duplicated side effect.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONE EXCEPTION: `reserveUsage()`
 * ══════════════════════════════════════════════════════════════════════
 * There is exactly one case where a metering failure MUST take the request
 * down with it, and it is the case where the recorder is not observing —
 * it is RESERVING.
 *
 * When a metric is hard-capped (storage, today), the counter is not a
 * report on what happened, it is the mechanism that decides whether the
 * next upload is allowed. If that write is best-effort, then an attacker —
 * or an ordinary customer with an unlucky retry loop — who can make the
 * counter write fail gets an UNMETERED, UNBOUNDED plan: every upload
 * succeeds, the level never moves, the quota never trips, and the first
 * symptom is a blob-storage bill.
 *
 * "Silently stops counting" is a tolerable failure for a metric that only
 * feeds an invoice line, because the invoice is reconciled against
 * reality later. It is not tolerable for a metric that gates a resource,
 * because there is nothing downstream to catch it.
 *
 * So: `reserveUsage()` runs INSIDE the caller's transaction and THROWS.
 * If the reservation cannot be recorded, the upload it was reserving for
 * is rolled back. The customer sees "we could not complete that upload,
 * please try again", which is honest, recoverable and costs us nothing.
 *
 * ⚠️ DECREMENTS NEVER THROW, INCLUDING FOR HARD-CAPPED METRICS.
 * `releaseStorageBytes()` is best-effort even though `reserveUsage()` is
 * not, and the asymmetry is deliberate. A failed decrement leaves the
 * customer's figure too HIGH; making the delete fail because of it would
 * mean a tenant who is over quota cannot delete anything, which is the
 * exact trap described in `lib/metering/quota.ts` — the remedy blocked by
 * the condition it remedies. The drift is corrected by
 * `reconcileStorageLevel()`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * RULE 2: EVERY INCREMENT IS ONE ATOMIC STATEMENT
 * ══════════════════════════════════════════════════════════════════════
 * `INSERT … ON CONFLICT (tenant_id, metric, period_start) DO UPDATE SET
 *  value = usage_counters.value + excluded.value`
 *
 * The tempting alternative is a read-modify-write: SELECT the row, add
 * one in JavaScript, UPDATE. On a serverless platform that is not
 * "slightly racy", it is WRONG BY CONSTRUCTION:
 *
 *   • There may be a hundred concurrent Vercel instances. They share
 *     nothing — no lock, no memory, no leader. There is no application
 *     layer in which a mutex could exist.
 *   • Under READ COMMITTED (Postgres' default, and what every path here
 *     uses) two transactions that both SELECT 41 will both UPDATE to 42.
 *     No error is raised. One increment is simply gone.
 *   • The loss is silently in the CUSTOMER's favour, so it is never
 *     reported by anybody — it shows up as revenue that quietly does not
 *     exist, which is the hardest kind of bug to notice.
 *
 * `ON CONFLICT DO UPDATE` pushes the arithmetic into the engine, where the
 * row lock is held for the duration of the addition. Concurrent writers
 * queue on the lock and each applies its delta to the value the previous
 * one committed. `tests/security/metering-isolation.test.ts` runs both
 * shapes concurrently against a real PostgreSQL and demonstrates that the
 * upsert keeps every increment while the read-modify-write loses several.
 */

import { sql } from "drizzle-orm";
import { usageCounters, usageLevels } from "@/db/schema/metering";
import {
  isCumulativeMetric,
  isLevelMetric,
  metricDefinition,
  toBigIntUsage,
  type UsageMetric,
} from "@/lib/metering/quota";
import type { MeteringPeriod } from "@/lib/metering/period";
import { getTenantMeteringContext } from "@/server/metering/query";
import type { withTenant } from "@/db";

/**
 * The transaction handle type, derived from `withTenant` rather than
 * named, so it cannot drift from the real one. Same trick as
 * `server/security/record.ts` and `server/billing/audit-billing.ts`.
 */
export type TransactionHandle = Parameters<Parameters<typeof withTenant>[1]>[0];

/* ------------------------------------------------------------------ */
/* SHARED                                                              */
/* ------------------------------------------------------------------ */

export type RecordUsageInput = {
  tenantId: string;
  metric: UsageMetric;
  /** How many units. Accepts a bigint, a safe integer, or a digit string. */
  quantity?: bigint | number | string;
  /**
   * The billing period this belongs to. Omit and it is resolved from the
   * tenant's subscription — one extra indexed read, cached briefly.
   * Pass it when you already know it (a batch, a backfill), which also
   * makes the call deterministic in a test.
   */
  period?: MeteringPeriod;
};

/**
 * A quantity that is not a positive whole number is a programming error,
 * not a data condition — `recordUsage(..., 0.5)` means somebody divided
 * something. It is rejected here rather than silently truncated, because a
 * truncated quantity under-bills forever and never reports itself.
 */
function normaliseQuantity(quantity: bigint | number | string | undefined): bigint {
  const value = toBigIntUsage(quantity ?? 1n);
  if (value < 0n) {
    throw new Error(
      "A cumulative usage quantity cannot be negative. Cumulative counters only " +
        "go up; to correct one, record an adjustment in the next period.",
    );
  }
  return value;
}

/**
 * `bigint` values are interpolated as a decimal string and cast in SQL.
 *
 * Neither driver in use here binds a JavaScript `bigint` parameter
 * reliably — the Neon HTTP client serialises it inconsistently and `pg`
 * refuses outright. `${value.toString()}::bigint` binds a plain string the
 * engine then casts exactly, with no float anywhere in the path. Never
 * `Number(value)`: that is the one conversion this whole phase exists to
 * avoid.
 */
function bigintParam(value: bigint) {
  return sql`${value.toString()}::bigint`;
}

/** Loud, structured, and it names what was lost. Never rethrows. */
function reportFailure(
  operation: string,
  input: { tenantId: string; metric: UsageMetric; quantity?: bigint },
  err: unknown,
): void {
  console.error("[USAGE RECORD FAILED]", {
    operation,
    tenantId: input.tenantId,
    metric: input.metric,
    quantity: input.quantity?.toString() ?? null,
    error: err instanceof Error ? err.message : String(err),
  });
}

async function resolvePeriod(
  tenantId: string,
  provided: MeteringPeriod | undefined,
): Promise<MeteringPeriod> {
  if (provided) return provided;
  const context = await getTenantMeteringContext(tenantId);
  return context.period;
}

/* ------------------------------------------------------------------ */
/* CUMULATIVE — the atomic increment                                   */
/* ------------------------------------------------------------------ */

/**
 * The one statement that does the work. Exported for the SQL/TypeScript
 * agreement test, which asserts that the shape asserted in the security
 * suite is the shape actually executed here.
 */
export function incrementCounterStatement(args: {
  tenantId: string;
  metric: UsageMetric;
  quantity: bigint;
  period: MeteringPeriod;
}) {
  return sql`
    INSERT INTO usage_counters
      (tenant_id, metric, period_start, period_end, value, first_recorded_at, last_recorded_at)
    VALUES (
      ${args.tenantId}::uuid,
      ${args.metric}::usage_metric,
      ${args.period.periodStart.toISOString()}::timestamptz,
      ${args.period.periodEnd.toISOString()}::timestamptz,
      ${bigintParam(args.quantity)},
      now(),
      now()
    )
    ON CONFLICT (tenant_id, metric, period_start) DO UPDATE
      SET value            = usage_counters.value + excluded.value,
          last_recorded_at = now()
  `;
}

/**
 * Record cumulative usage inside an EXISTING transaction.
 *
 * ⚠️ THROWS. It joins your transaction, so if it fails your transaction
 * must fail too — a counter row that survives a rolled-back state change
 * is a bill for something that did not happen.
 *
 * Prefer this over `recordUsage()` wherever a transaction already exists:
 * it costs one statement on a connection you are already holding, whereas
 * the standalone version opens its own.
 */
export async function recordUsageTx(
  tx: TransactionHandle,
  input: RecordUsageInput & { period: MeteringPeriod },
): Promise<void> {
  const quantity = normaliseQuantity(input.quantity);
  if (quantity === 0n) return;

  if (!isCumulativeMetric(input.metric)) {
    // The CHECK constraint would refuse this anyway. Failing here gives
    // the developer the sentence that explains WHY, at the call site.
    throw new Error(
      `"${input.metric}" is a LEVEL, not a tally. Use adjustStorageBytes()/` +
        `setStorageBytes() — recording it as a tally would make stored bytes ` +
        `rise forever and never fall when a customer deletes something.`,
    );
  }

  await tx.execute(
    incrementCounterStatement({
      tenantId: input.tenantId,
      metric: input.metric,
      quantity,
      period: input.period,
    }),
  );
}

/**
 * Record cumulative usage standalone.
 *
 * BEST EFFORT — never throws. Returns true if the row was written.
 *
 * @example
 *   await recordUsage({ tenantId, metric: "emails_sent" });
 */
export async function recordUsage(input: RecordUsageInput): Promise<boolean> {
  let quantity = 0n;
  try {
    quantity = normaliseQuantity(input.quantity);
    if (quantity === 0n) return false;

    const period = await resolvePeriod(input.tenantId, input.period);

    /**
     * ⚠️ `withTenant` is imported LAZILY, inside the function.
     *
     * `db/index.ts` builds its client at MODULE LOAD and validates the
     * environment while doing it, so a static import would mean that
     * merely IMPORTING this module can throw — and this module is imported
     * by the upload route, the email sender and the portal, i.e. exactly
     * the surfaces it must never break. Phase 20 hit this precisely:
     * adding a recorder to `app/api/upload/route.ts` broke nineteen
     * authorisation tests because the import chain reached the database
     * client. A meter must not be able to break the thing it measures.
     */
    const { withTenant } = await import("@/db");

    await withTenant(input.tenantId, async (tx) => {
      await recordUsageTx(tx, { ...input, period });
    });

    return true;
  } catch (err) {
    reportFailure("recordUsage", { ...input, quantity }, err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* THE EXCEPTION — RESERVATION                                         */
/* ------------------------------------------------------------------ */

/**
 * Record consumption of a HARD-CAPPED metric as a reservation.
 *
 * ⚠️ THROWS ON FAILURE. See the header: for a metric that gates a
 * resource, an unrecorded increment is a free unlimited plan, and there is
 * nothing downstream to catch it. This must run inside the same
 * transaction as the state change it authorises, so that failing to record
 * the reservation undoes the thing that was reserved.
 *
 * Refuses outright for a metric with no hard cap — calling it for
 * `api_calls` would make a metric that is deliberately never blocking into
 * one that can fail a request, which is exactly the pricing decision this
 * phase declines to pre-empt.
 */
export async function reserveUsage(
  tx: TransactionHandle,
  input: RecordUsageInput & { period: MeteringPeriod },
): Promise<void> {
  const definition = metricDefinition(input.metric);
  if (definition.hardBlockBps === null) {
    throw new Error(
      `reserveUsage() is only for hard-capped metrics. "${input.metric}" is ` +
        `measured but never refused — use recordUsage(), which is best effort, ` +
        `so a metering failure cannot break a request that was always going to ` +
        `be allowed.`,
    );
  }

  if (isLevelMetric(input.metric)) {
    await adjustLevelTx(tx, {
      tenantId: input.tenantId,
      metric: input.metric,
      delta: normaliseQuantity(input.quantity),
      period: input.period,
    });
    return;
  }

  await recordUsageTx(tx, input);
}

/* ------------------------------------------------------------------ */
/* LEVELS — up AND down                                                */
/* ------------------------------------------------------------------ */

/**
 * The atomic level adjustment.
 *
 * Three things are happening in one statement, and each is here for a
 * reason:
 *
 *   `GREATEST(0, current_value + delta)` — the clamp. A decrement that
 *   would go negative means a deletion was counted twice (a retried
 *   request, a cascade that also fired the recorder). Clamping keeps the
 *   figure displayable; the CHECK constraint behind it means that if this
 *   clamp is ever missing from a NEW call site, the database refuses the
 *   write rather than granting the tenant a negative — i.e. larger —
 *   allowance.
 *
 *   The `peak_value` CASE — a high-water mark scoped to the billing
 *   period, reset when a new period is first seen. Phase 16 may bill
 *   storage on the peak or on the closing reading; that decision is
 *   commercial and cannot be made retrospectively if the peak was never
 *   kept.
 *
 *   `peak_period_start = GREATEST(existing, incoming)` — never move the
 *   scope BACKWARDS. An out-of-order write (a retry that lands after the
 *   period rolled) would otherwise reset a peak that has already been
 *   established for the new period.
 */
function adjustLevelStatement(args: {
  tenantId: string;
  metric: UsageMetric;
  delta: bigint;
  period: MeteringPeriod;
}) {
  const delta = bigintParam(args.delta);
  const periodStart = sql`${args.period.periodStart.toISOString()}::timestamptz`;

  /**
   * ⚠️ THE UPDATE BRANCH USES THE RAW DELTA, **NOT** `excluded.current_value`.
   *
   * This looks like a stylistic choice and it is not. The VALUES row has
   * to clamp — a decrement against a level that does not exist yet must
   * insert 0, not a negative — so `excluded.current_value` is
   * `GREATEST(0, delta)`, which is ZERO for every decrement. Adding THAT
   * on conflict makes every delete a no-op: storage rises on upload and
   * never falls, silently, exactly the failure this whole phase is built
   * to prevent.
   *
   * Found by `tests/security/metering-isolation.test.ts`, which asserts a
   * decrement actually lowers the figure. That test earned its place.
   */
  const next = sql`GREATEST(0::bigint, usage_levels.current_value + ${delta})`;

  return sql`
    INSERT INTO usage_levels
      (tenant_id, metric, current_value, peak_value, peak_at, peak_period_start,
       last_event_at, updated_at)
    VALUES (
      ${args.tenantId}::uuid,
      ${args.metric}::usage_metric,
      GREATEST(0::bigint, ${delta}),
      GREATEST(0::bigint, ${delta}),
      now(),
      ${periodStart},
      now(),
      now()
    )
    ON CONFLICT (tenant_id, metric) DO UPDATE
      SET current_value = ${next},
          peak_value = CASE
            WHEN usage_levels.peak_period_start < ${periodStart} THEN ${next}
            ELSE GREATEST(usage_levels.peak_value, ${next})
          END,
          peak_at = CASE
            WHEN usage_levels.peak_period_start < ${periodStart}
                 OR ${next} > usage_levels.peak_value
              THEN now()
            ELSE usage_levels.peak_at
          END,
          peak_period_start = GREATEST(usage_levels.peak_period_start, ${periodStart}),
          last_event_at = now(),
          updated_at = now()
  `;
}

/**
 * Move a level by a delta, inside an existing transaction. THROWS.
 *
 * Used by `reserveUsage()` on the upload path, where the reservation and
 * the `documents` row must succeed or fail together.
 */
export async function adjustLevelTx(
  tx: TransactionHandle,
  args: { tenantId: string; metric: UsageMetric; delta: bigint; period: MeteringPeriod },
): Promise<void> {
  if (!isLevelMetric(args.metric)) {
    throw new Error(
      `"${args.metric}" is a cumulative tally, not a level. Adjusting it downward ` +
        `would erase usage a customer is about to be billed for.`,
    );
  }
  if (args.delta === 0n) return;

  await tx.execute(adjustLevelStatement(args));
}

/**
 * Move a level by a delta, standalone. BEST EFFORT — never throws.
 *
 * This is the DECREMENT path (and the increment path for call sites with
 * no transaction of their own). It is best-effort even for storage, which
 * is hard-capped: see the asymmetry note in the header. Blocking a delete
 * because the meter is unavailable would trap an over-quota customer with
 * no way out.
 */
export async function adjustLevel(args: {
  tenantId: string;
  metric: UsageMetric;
  delta: bigint;
  period?: MeteringPeriod;
}): Promise<boolean> {
  try {
    if (args.delta === 0n) return false;
    const period = await resolvePeriod(args.tenantId, args.period);
    const { withTenant } = await import("@/db");

    await withTenant(args.tenantId, async (tx) => {
      await adjustLevelTx(tx, { ...args, period });
    });
    return true;
  } catch (err) {
    reportFailure("adjustLevel", { ...args, quantity: args.delta }, err);
    return false;
  }
}

/**
 * SET a level to an authoritative absolute value.
 *
 * This is the reconciliation path, and it is the only writer permitted to
 * lower a level by an arbitrary amount. Deltas drift — a retried delete
 * decrements twice, an upload that fails after the reservation increments
 * for a file that never landed — and the drift is unbounded over years.
 * Recomputing from `SUM(documents.size_bytes)` collapses it back to the
 * truth, and stamps `last_reconciled_at` so a support engineer can tell a
 * verified figure from an accumulated one.
 *
 * BEST EFFORT — never throws.
 */
export async function setLevel(args: {
  tenantId: string;
  metric: UsageMetric;
  value: bigint;
  period?: MeteringPeriod;
  reconciled?: boolean;
}): Promise<boolean> {
  try {
    if (!isLevelMetric(args.metric)) {
      throw new Error(`"${args.metric}" is not a level metric.`);
    }

    const value = args.value < 0n ? 0n : args.value;
    const period = await resolvePeriod(args.tenantId, args.period);
    const periodStart = sql`${period.periodStart.toISOString()}::timestamptz`;
    const reconciledAt = args.reconciled === false ? sql`NULL` : sql`now()`;

    const { withTenant } = await import("@/db");

    await withTenant(args.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO usage_levels
          (tenant_id, metric, current_value, peak_value, peak_at, peak_period_start,
           last_event_at, last_reconciled_at, updated_at)
        VALUES (
          ${args.tenantId}::uuid,
          ${args.metric}::usage_metric,
          ${bigintParam(value)},
          ${bigintParam(value)},
          now(),
          ${periodStart},
          now(),
          ${reconciledAt},
          now()
        )
        ON CONFLICT (tenant_id, metric) DO UPDATE
          SET current_value = excluded.current_value,
              -- The peak may not fall within its period, even on a
              -- reconciliation: the bytes really were stored. It resets
              -- only when the period rolls.
              peak_value = CASE
                WHEN usage_levels.peak_period_start < ${periodStart}
                  THEN excluded.current_value
                ELSE GREATEST(usage_levels.peak_value, excluded.current_value)
              END,
              peak_at = CASE
                WHEN usage_levels.peak_period_start < ${periodStart}
                     OR excluded.current_value > usage_levels.peak_value
                  THEN now()
                ELSE usage_levels.peak_at
              END,
              peak_period_start = GREATEST(usage_levels.peak_period_start, ${periodStart}),
              last_event_at = now(),
              last_reconciled_at = COALESCE(${reconciledAt}, usage_levels.last_reconciled_at),
              updated_at = now()
      `);
    });

    return true;
  } catch (err) {
    reportFailure("setLevel", { ...args, quantity: args.value }, err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* RECONCILIATION                                                      */
/* ------------------------------------------------------------------ */

/**
 * Recompute a tenant's stored bytes from the documents table and set the
 * level to it. BEST EFFORT — never throws. Returns the value written, or
 * null if it could not be computed.
 *
 * Run it after a bulk delete, from a nightly job, and from the support
 * tooling when a customer says the number looks wrong. It is cheap: one
 * indexed aggregate over one tenant's rows.
 *
 * ⚠️ THE SUM IS COMPUTED IN POSTGRES AND READ BACK AS A STRING.
 * `documents.sizeBytes` is declared `mode: "number"` in the Phase 8 schema,
 * which is harmless for one file and wrong for a sum over a library — a
 * tenant with ten thousand documents can exceed 2^53 bytes, and the
 * JavaScript sum would silently round. `SUM(size_bytes)::text` keeps the
 * value exact all the way into `BigInt`.
 */
export async function reconcileStorageLevel(tenantId: string): Promise<bigint | null> {
  try {
    const { withTenant } = await import("@/db");

    const total = await withTenant(tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT COALESCE(SUM(size_bytes), 0)::text AS total
          FROM documents
         WHERE tenant_id = ${tenantId}::uuid
           AND deleted_at IS NULL
      `);
      const rows = (result as unknown as { rows?: Array<{ total: string }> }).rows
        ?? (result as unknown as Array<{ total: string }>);
      return toBigIntUsage(rows?.[0]?.total ?? "0");
    });

    const written = await setLevel({
      tenantId,
      metric: "storage_bytes",
      value: total,
      reconciled: true,
    });

    return written ? total : null;
  } catch (err) {
    reportFailure("reconcileStorageLevel", { tenantId, metric: "storage_bytes" }, err);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* CONVENIENCE — the call shapes the product actually uses             */
/* ------------------------------------------------------------------ */

/**
 * Thin wrappers, for the same reason Phase 20 wraps `recordRateLimitTrip`:
 * six call sites that each choose their own metric string is six chances
 * to record `"email_sent"` into a column that expects `"emails_sent"` —
 * and the error surfaces inside a swallowed catch.
 */

/** One email left the building. Call AFTER the provider accepted it. */
export function recordEmailSent(tenantId: string, count = 1): Promise<boolean> {
  return recordUsage({ tenantId, metric: "emails_sent", quantity: count });
}

/** One authenticated API request was served. */
export function recordApiCall(tenantId: string, count = 1): Promise<boolean> {
  return recordUsage({ tenantId, metric: "api_calls", quantity: count });
}

/** A portal link was minted. Measured, never capped. */
export function recordPortalLinkCreated(tenantId: string, count = 1): Promise<boolean> {
  return recordUsage({ tenantId, metric: "portal_links_created", quantity: count });
}

/**
 * Bytes were added. THROWS — this is the reservation path.
 *
 * Call inside the same transaction that writes the `documents` row, so an
 * upload that cannot be metered is an upload that did not happen.
 */
export function reserveStorageBytes(
  tx: TransactionHandle,
  args: { tenantId: string; bytes: bigint; period: MeteringPeriod },
): Promise<void> {
  return reserveUsage(tx, {
    tenantId: args.tenantId,
    metric: "storage_bytes",
    quantity: args.bytes,
    period: args.period,
  });
}

/**
 * Bytes were removed. BEST EFFORT — never throws, never blocks a delete.
 *
 * A tenant who is over quota MUST be able to delete. If this write fails
 * their figure stays too high for a while and `reconcileStorageLevel()`
 * corrects it; if the delete failed instead, they would be stuck over
 * quota with the only remedy unavailable.
 */
export function releaseStorageBytes(tenantId: string, bytes: bigint): Promise<boolean> {
  const magnitude = bytes < 0n ? bytes : -bytes;
  return adjustLevel({ tenantId, metric: "storage_bytes", delta: magnitude });
}
