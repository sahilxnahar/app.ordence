/**
 * Ordence — Usage Metering Schema (Phase 15)
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE DECISION THIS FILE IS: COUNTERS, NOT EVENTS
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design is a row per metered occurrence — one INSERT per API
 * call, per email, per upload — and then `SUM()` it when someone asks.
 * It is obvious, it is auditable, and it is unaffordable here:
 *
 *   • A single tenant on the 10,000-calls plan generates 10,000 rows a
 *     month. Two hundred tenants generate two million, before a single
 *     email or portal link. On Neon that is real money for data nobody
 *     reads at row granularity.
 *   • Every metered request grows an INSERT-heavy table that is never
 *     pruned by the application, so the usage page gets slower every day
 *     it is used, and the slowdown is proportional to how much the
 *     customer uses the product — the worst possible correlation.
 *   • Rendering a usage bar becomes an aggregate over a month of rows.
 *     That is a hundred-millisecond query on a page that must be instant,
 *     and it is on the hot path of every quota check.
 *
 * The opposite extreme — one mutable counter per tenant per metric — is
 * cheap and useless. It cannot answer "what did they use in May", which is
 * the only question an overage invoice asks; it cannot be audited, because
 * the number today tells you nothing about how it got there; and it has
 * nowhere to reset to at a period boundary without destroying history.
 *
 * ══════════════════════════════════════════════════════════════════════
 * SO: PERIOD-BUCKETED AGGREGATES
 * ══════════════════════════════════════════════════════════════════════
 * One row per (tenant, metric, period_start), holding a total. That is
 * ~4 rows per tenant per month rather than tens of thousands, it answers
 * the billing question directly, and last month's bucket is still sitting
 * there when a customer disputes an overage line.
 *
 * WHAT IS LOST, STATED PLAINLY: per-occurrence forensics. "Which endpoint
 * made those 9,000 calls" is NOT answerable from this table. That is
 * accepted deliberately — it is an observability question, and the answer
 * belongs in the request logs and in Phase 19's telemetry, not in a
 * billing counter that has to be correct and cheap.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ARE THE BUCKETS APPEND-ONLY? NO — AND THAT NEEDS DEFENDING
 * ══════════════════════════════════════════════════════════════════════
 * `audit_logs`, `payment_events`, `contract_signatures` and
 * `security_events` are all append-only, enforced by a trigger. This table
 * cannot be: the entire concurrency design rests on `INSERT … ON CONFLICT
 * DO UPDATE SET value = value + excluded.value`, which is an UPDATE.
 *
 * Refusing UPDATE would force one row per occurrence, which is the event
 * table we just rejected. So the guarantee is weakened deliberately, and
 * replaced with the strongest one that survives:
 *
 *   ⭐ A COUNTER MAY ONLY EVER GO UP, AND ITS IDENTITY MAY NEVER CHANGE.
 *
 * Enforced by `usage_counters_monotonic` in
 * `SQL-FILES/0013_phase15_metering.sql`: an UPDATE that DECREASES `value`,
 * or that alters `tenant_id`, `metric`, `period_start` or `period_end`, is
 * refused with SQLSTATE 42501.
 *
 * That is the property with teeth. The only reasons to lower a cumulative
 * counter are to under-bill, to hide usage from a customer who is about to
 * be charged for it, or to cover a bug — and all three are things a
 * correction should do by writing an ADJUSTMENT, not by editing history.
 * DELETE is withheld from the application role entirely (Section 6 of the
 * SQL); retention pruning runs under a different credential.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO TABLES, BECAUSE THERE ARE TWO KINDS OF NUMBER
 * ══════════════════════════════════════════════════════════════════════
 *   `usage_counters`  CUMULATIVE. Emails, API calls, portal links. A tally
 *                     within a billing period. Monotonic. Resets by virtue
 *                     of the next period getting a new row.
 *
 *   `usage_levels`    A LEVEL. Bytes stored. Goes UP on upload and DOWN on
 *                     delete. Not a tally — a reading.
 *
 * These could have been one table with a `kind` column. They are not, and
 * the reason is that the monotonic trigger above must apply to one and
 * must NOT apply to the other. A single table would need a trigger with a
 * branch in it, and the day someone gets that branch wrong is the day
 * either storage stops decreasing (a customer who deletes 30 GB is still
 * billed for it, and eventually locked out of an account they have been
 * diligently tidying) or emails become decrementable (usage quietly
 * vanishes before invoicing). Two tables make each guarantee
 * unconditional.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY EVERY QUANTITY IS `bigint`
 * ══════════════════════════════════════════════════════════════════════
 * Same rule as money. `integer` overflows at 2.1 GB, which one video file
 * exceeds; a size that silently wraps negative is a bug that appears once
 * and then never reproduces. `double precision` is worse still — a byte
 * count that has passed through a float has already lost its low digits,
 * and the resulting figure disagrees with `SUM(documents.size_bytes)` by
 * an amount nobody can account for.
 *
 * ⚠️ Note the divergence from `documents.sizeBytes`, which is declared
 * `mode: "number"` (Phase 8). That is fine for ONE file — no single upload
 * approaches 2^53 bytes — and wrong for a SUM over a tenant's whole
 * library, which is what this table holds. The conversion happens once, at
 * the reconciliation query in `server/metering/record.ts`, and is
 * commented there.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  timestamp,
  bigint,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants } from "./core";
import { USAGE_METRICS, CUMULATIVE_METRICS, LEVEL_METRICS } from "@/lib/metering/quota";

/* ------------------------------------------------------------------ */
/* ENUM                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE ENUM VALUES ARE IMPORTED, NOT RETYPED.
 *
 * Exactly as `securityEventTypeEnum` does in Phase 20. A hand-copied list
 * drifts the first time a metric is added to one side and not the other,
 * and the symptom is an INSERT failing at runtime inside a recorder that
 * swallows its own errors by design — i.e. a metric that silently records
 * nothing, discovered when an invoice is short.
 */
export const usageMetricEnum = pgEnum("usage_metric", USAGE_METRICS);

/**
 * The metric lists rendered as SQL literals, so the CHECK constraints
 * below are generated from the same constant the TypeScript uses.
 *
 * `tests/security/metering-isolation.test.ts` reads these constraints back
 * out of `pg_constraint` and asserts they still match `CUMULATIVE_METRICS`
 * and `LEVEL_METRICS`. That test is the only thing keeping a metric from
 * being classified as a tally in one place and a level in the other.
 */
const CUMULATIVE_LITERALS = sql.raw(CUMULATIVE_METRICS.map((m) => `'${m}'`).join(","));
const LEVEL_LITERALS = sql.raw(LEVEL_METRICS.map((m) => `'${m}'`).join(","));

/* ------------------------------------------------------------------ */
/* USAGE COUNTERS  (cumulative, tenant-scoped, RLS)                    */
/* ------------------------------------------------------------------ */

export const usageCounters = pgTable(
  "usage_counters",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    metric: usageMetricEnum("metric").notNull(),

    /**
     * The BILLING period this bucket covers, copied from
     * `subscriptions.current_period_start/_end` — not the calendar month.
     * A subscription anchored on the 9th has buckets running 9th→9th.
     * See `lib/metering/period.ts` for why that distinction is
     * load-bearing rather than pedantic.
     *
     * Stored on the row rather than derived at read time because the
     * subscription's period moves on, and a bucket must keep describing
     * the window it actually measured.
     */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),

    /**
     * The tally. Incremented by `value = usage_counters.value + excluded.value`
     * inside an upsert, never by a read-modify-write in application code.
     */
    value: bigint("value", { mode: "bigint" }).default(sql`0`).notNull(),

    /**
     * Recorded for support, not for billing: "when did this month's usage
     * actually happen" is the first question asked about a surprising
     * overage, and without it the bucket is a number with no story.
     */
    firstRecordedAt: timestamp("first_recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastRecordedAt: timestamp("last_recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⭐ THE MOST IMPORTANT LINE IN THIS FILE.
     *
     * This unique index is the ARBITER for `ON CONFLICT (tenant_id, metric,
     * period_start) DO UPDATE`. Without it the upsert has nothing to
     * conflict on, every increment inserts a FRESH ROW, and usage silently
     * becomes a count of rows nobody sums — the quota never trips, the
     * overage is never billed, and no error is raised anywhere.
     *
     * `SQL-FILES/0013_phase15_metering.sql` asserts its existence
     * explicitly, because `drizzle-kit push` dropping it would be exactly
     * that silent.
     */
    tenantMetricPeriodUnique: uniqueIndex("usage_counters_tenant_metric_period_unique").on(
      t.tenantId,
      t.metric,
      t.periodStart,
    ),

    tenantPeriodIdx: index("usage_counters_tenant_period_idx").on(t.tenantId, t.periodStart),
    metricPeriodIdx: index("usage_counters_metric_period_idx").on(t.metric, t.periodStart),

    // A cumulative counter is a count of things that happened. There is no
    // such thing as minus four emails.
    valueNonNegative: check("usage_counters_value_non_negative", sql`${t.value} >= 0`),

    // A period that ends before it starts means the subscription row it was
    // copied from is wrong, and every bucket derived from it would be too.
    periodSane: check(
      "usage_counters_period_sane",
      sql`${t.periodEnd} > ${t.periodStart}`,
    ),

    /**
     * ⭐ ONLY CUMULATIVE METRICS LIVE HERE.
     *
     * Without this, `storage_bytes` could be written into the tally table
     * by a call site that used the wrong recorder, and it would then be
     * summed as though every upload were permanent — the exact
     * "storage only ever rises" failure this phase exists to avoid. The
     * database refuses rather than trusting the caller.
     */
    metricIsCumulative: check(
      "usage_counters_metric_is_cumulative",
      sql`${t.metric} = ANY(ARRAY[${CUMULATIVE_LITERALS}]::usage_metric[])`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* USAGE LEVELS  (a reading, tenant-scoped, RLS)                       */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * STORAGE IS A LEVEL, AND THE PEAK IS RECORDED SEPARATELY
 * ══════════════════════════════════════════════════════════════════════
 * `currentValue` is what the customer sees: how much they are storing
 * right now. It falls when they delete something, immediately, because a
 * storage figure that only rises is how a customer who has spent an
 * afternoon tidying finds themselves still locked out at the end of it.
 *
 * `peakValue` exists because Phase 16 has a genuine choice to make and
 * should not have to guess retrospectively. Billing storage on the
 * end-of-period reading rewards deleting everything on the last day and
 * re-uploading on the first; billing on the peak charges for a spike that
 * lasted an hour. Both are defensible, the decision is commercial, and it
 * cannot be made later at all if the peak was never recorded. So both
 * numbers are kept and neither is derived from the other.
 *
 * The peak is scoped to `peakPeriodStart` and resets when a new billing
 * period is first written — otherwise a single 40 GB spike in March would
 * still be the billable figure in December.
 *
 * ⚠️ THERE IS NO PER-PERIOD ROW HERE. A level is not a tally; it does not
 * reset. Giving storage one row per period would mean a new period starts
 * at zero and the customer's entire library appears to have vanished until
 * something is uploaded. One row per (tenant, metric), forever.
 */
export const usageLevels = pgTable(
  "usage_levels",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    metric: usageMetricEnum("metric").notNull(),

    /** The reading now. Moves both ways. Never negative. */
    currentValue: bigint("current_value", { mode: "bigint" }).default(sql`0`).notNull(),

    /** Highest reading seen since `peakPeriodStart`. */
    peakValue: bigint("peak_value", { mode: "bigint" }).default(sql`0`).notNull(),
    peakAt: timestamp("peak_at", { withTimezone: true }),

    /** The billing period the peak is scoped to. */
    peakPeriodStart: timestamp("peak_period_start", { withTimezone: true }).notNull(),

    lastEventAt: timestamp("last_event_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * When this level was last SET from an authoritative recount rather
     * than adjusted by a delta.
     *
     * Deltas drift — a retried delete decrements twice, a failed upload
     * increments for a file that never landed. The drift is small and
     * bounded, and it is corrected by `reconcileStorageLevel()`, which
     * recomputes from `SUM(documents.size_bytes)`. This column is how you
     * tell a figure that was verified an hour ago from one that has been
     * accumulating deltas since March.
     */
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** The arbiter for the level upsert. See the counter index note. */
    tenantMetricUnique: uniqueIndex("usage_levels_tenant_metric_unique").on(
      t.tenantId,
      t.metric,
    ),

    metricIdx: index("usage_levels_metric_idx").on(t.metric),

    /**
     * ⭐ A LEVEL CAN NEVER BE NEGATIVE.
     *
     * The application clamps with `GREATEST(0, …)` on every decrement, so
     * in normal operation this constraint never fires. It exists for the
     * case where the clamp is missing from a NEW call site — a decrement
     * that would go negative means a deletion has been counted twice, and
     * a tenant whose storage reads -2 GB has an allowance 2 GB larger than
     * the one they paid for.
     */
    currentNonNegative: check("usage_levels_current_non_negative", sql`${t.currentValue} >= 0`),

    // The peak is a high-water mark. A peak below the current reading means
    // the update path forgot to raise it, and the figure Phase 16 might
    // bill on would understate what was actually stored.
    peakAtLeastCurrent: check(
      "usage_levels_peak_at_least_current",
      sql`${t.peakValue} >= ${t.currentValue}`,
    ),

    /** ⭐ ONLY LEVEL METRICS LIVE HERE. The mirror of the counter check. */
    metricIsLevel: check(
      "usage_levels_metric_is_level",
      sql`${t.metric} = ANY(ARRAY[${LEVEL_LITERALS}]::usage_metric[])`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const usageCountersRelations = relations(usageCounters, ({ one }) => ({
  tenant: one(tenants, { fields: [usageCounters.tenantId], references: [tenants.id] }),
}));

export const usageLevelsRelations = relations(usageLevels, ({ one }) => ({
  tenant: one(tenants, { fields: [usageLevels.tenantId], references: [tenants.id] }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type UsageCounter = typeof usageCounters.$inferSelect;
export type NewUsageCounter = typeof usageCounters.$inferInsert;
export type UsageLevel = typeof usageLevels.$inferSelect;
export type NewUsageLevel = typeof usageLevels.$inferInsert;

/** Re-exported so a call site can import the metric union from the schema. */
export type { UsageMetric } from "@/lib/metering/quota";
