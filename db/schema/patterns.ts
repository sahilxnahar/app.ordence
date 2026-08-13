/**
 * Ordence — ⭐⭐⭐ ORDER RHYTHM AND AUTOMATION EVENTS
 * Version: v1.16.0-alpha  ·  SQL 0068
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE AUTOMATION ENGINE HAS NEVER RECEIVED A BUSINESS EVENT
 * ══════════════════════════════════════════════════════════════════════
 * `workflows` and its five tables have existed since v0.7x with a full
 * executor, conditions, watched fields, a run log and a screen. The only
 * way to start one is a person pressing "run now": `record_created` and
 * `record_updated` are in the trigger vocabulary and nothing has ever
 * emitted one.
 *
 * ⭐ `automationEvents` is not a second engine. It is the queue the
 * existing executor has been waiting for.
 */

import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  date,
  integer,
  jsonb,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants } from "./core";
import { tasks } from "./work";

/* ------------------------------------------------------------------ */
/* 1 · THE RHYTHM, DERIVED                                             */
/* ------------------------------------------------------------------ */

export const customerRhythms = pgTable(
  "customer_rhythms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    subjectType: varchar("subject_type", { length: 40 }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    subjectLabel: varchar("subject_label", { length: 255 }),

    /**
     * 🔴 INCLUDING THE VERDICTS THAT ARE REFUSALS.
     *
     * ⭐ `too_few_orders` and `irregular` are stored rather than
     * discarded. "We looked and there is no pattern" is an answer, and a
     * screen showing only the confident rows makes a business look like
     * it has forty customers when it has four hundred.
     */
    verdict: varchar("verdict", { length: 20 }).notNull(),

    orderCount: integer("order_count").default(0).notNull(),
    firstOrderOn: date("first_order_on"),
    lastOrderOn: date("last_order_on"),
    /** Median, never mean. One bulk order should not move this. */
    medianGapDays: integer("median_gap_days"),
    /** Median absolute deviation. The robust spread. */
    madDays: integer("mad_days"),

    expectedNextOn: date("expected_next_on"),
    windowDays: integer("window_days"),
    /** 0..100, deliberately hard to get high. */
    confidence: integer("confidence").default(0).notNull(),
    drift: varchar("drift", { length: 20 }).default("unknown").notNull(),

    /** ⭐ The sentence a salesman reads. Stored, so it cannot drift. */
    explanation: varchar("explanation", { length: 1000 }).notNull(),

    computedAt: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    computedThroughOn: date("computed_through_on"),
  },
  (t) => ({
    unique: uniqueIndex("customer_rhythms_unique").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
    dueIdx: index("customer_rhythms_due_idx")
      .on(t.tenantId, t.expectedNextOn)
      .where(sql`${t.verdict} = 'regular'`),
    /** ⭐ The query that matters most: who has stopped. */
    lapsedIdx: index("customer_rhythms_lapsed_idx")
      .on(t.tenantId, t.lastOrderOn)
      .where(sql`${t.verdict} = 'lapsed'`),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · THE SIGNAL, RAISED ONCE                                         */
/* ------------------------------------------------------------------ */

/**
 * 🔴 A nightly job that re-raises "this customer is due" for five nights
 * produces five tasks, and the salesman turns the feature off on the
 * third day.
 */
export const rhythmSignals = pgTable(
  "rhythm_signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    subjectType: varchar("subject_type", { length: 40 }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    subjectLabel: varchar("subject_label", { length: 255 }),

    kind: varchar("kind", { length: 20 }).notNull(),
    /** ⭐ The expected date, or the month for a lapse. See the index. */
    occurrence: varchar("occurrence", { length: 40 }).notNull(),

    dueOn: date("due_on").notNull(),
    confidence: integer("confidence").default(0).notNull(),
    headline: varchar("headline", { length: 300 }).notNull(),
    detail: varchar("detail", { length: 1000 }).notNull(),

    raisedAt: timestamp("raised_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),

    /**
     * ⭐⭐ WHAT HAPPENED NEXT, which is the only way to know whether any
     * of this works.
     *
     * 🔴 A prediction feature nobody scores is astrology.
     */
    outcome: varchar("outcome", { length: 20 }),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    outcomeOrderId: uuid("outcome_order_id"),
  },
  (t) => ({
    once: uniqueIndex("rhythm_signals_once").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
      t.kind,
      t.occurrence,
    ),
    openIdx: index("rhythm_signals_open_idx")
      .on(t.tenantId, t.dueOn)
      .where(sql`${t.outcome} IS NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* 3 · THE EVENT THE EXECUTOR HAS BEEN WAITING FOR                     */
/* ------------------------------------------------------------------ */

/**
 * 🔴 A TABLE RATHER THAN A DIRECT CALL, deliberately. A trigger that
 * invoked a workflow inline would run somebody's HTTP step inside the
 * transaction that created an invoice, and a slow endpoint would hold a
 * lock on the ledger.
 */
export const automationEvents = pgTable(
  "automation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    trigger_type: varchar("trigger_type", { length: 30 }).notNull(),
    recordType: varchar("record_type", { length: 40 }).notNull(),
    recordId: uuid("record_id").notNull(),

    /** ⭐ For the watched-field loop prevention the programs already use. */
    changedFields: text("changed_fields").array(),

    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /** How many workflows this actually started. Zero is common. */
    runsStarted: integer("runs_started").default(0).notNull(),
    errorMessage: varchar("error_message", { length: 500 }),

    /** 🔴 DPDP again: an event carries somebody's data. */
    purgeAfter: date("purge_after").notNull(),
  },
  (t) => ({
    pendingIdx: index("automation_events_pending_idx")
      .on(t.tenantId, t.occurredAt)
      .where(sql`${t.processedAt} IS NULL`),
    recordIdx: index("automation_events_record_idx").on(
      t.tenantId,
      t.recordType,
      t.recordId,
      t.occurredAt,
    ),
  }),
);

export const rhythmSignalsRelations = relations(rhythmSignals, ({ one }) => ({
  task: one(tasks, {
    fields: [rhythmSignals.taskId],
    references: [tasks.id],
  }),
}));

export type CustomerRhythm = typeof customerRhythms.$inferSelect;
export type RhythmSignal = typeof rhythmSignals.$inferSelect;
export type AutomationEvent = typeof automationEvents.$inferSelect;
