/**
 * Ordence — ⭐⭐⭐ THE INTEGRATION FRAME
 * Version: v1.12.0-alpha  ·  SQL 0064
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE FRAME, BUILT ONCE, FOR FIVE INTEGRATIONS
 * ══════════════════════════════════════════════════════════════════════
 * IndiaMART, JustDial, Meta, WhatsApp and email are five connections.
 * Building the frame once is one session; building it five times is five
 * sessions and five different bugs, and the fifth is always the worst
 * because by then nobody remembers how the first handled a retry.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 AND THERE IS NO SECRETS TABLE HERE
 * ══════════════════════════════════════════════════════════════════════
 * Integration credentials live in `vault_secrets`, which has existed
 * since 0037 with `api_credential` already in its kind list and which
 * nothing had ever written to. A private secrets table beside it would
 * have been a second vault: two erasure paths, two rotation stories, and
 * an access log that does not cover the credentials most worth logging.
 *
 * See `owner_kind = 'connection'` in `server/vault/secrets.ts`.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* 1 · THE CONNECTION                                                  */
/* ------------------------------------------------------------------ */

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** indiamart · justdial · meta_lead_ads · whatsapp · email */
    connectorKey: varchar("connector_key", { length: 40 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),

    /**
     * ⭐ NON-SECRET CONFIGURATION ONLY: an account id, a page id, a
     * mobile number. Anything secret goes in `vault_secrets`.
     */
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /**
     * 🔴 THE STATE A HUMAN READS: connected · degraded · locked ·
     * paused · revoked.
     *
     * ⚠️ Anything other than connected or paused MUST carry a reason,
     * enforced by a CHECK in 0064. "Degraded" on a screen with no reason
     * is the support call this whole feature exists to prevent.
     */
    state: varchar("state", { length: 20 }).default("paused").notNull(),
    stateReason: varchar("state_reason", { length: 500 }),

    /** ⚠️ Zero means push-only. A webhook connection never polls. */
    pollEverySeconds: integer("poll_every_seconds").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    /** ⭐ Where the next fetch resumes from. */
    cursorAt: timestamp("cursor_at", { withTimezone: true }),

    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    /**
     * 🔴 SET BY THE FAR END'S THROTTLE OR BY OUR OWN BACKOFF, and
     * nothing may fetch before it passes. State on the row, not a
     * comment in a runner, because everything that fetches has to see
     * it.
     */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 60 }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /** In words the customer can read. Never a stack trace. */
    lastErrorMessage: varchar("last_error_message", { length: 500 }),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),

    /* --- 0065 · WHAT AN ARRIVING ENQUIRY BECOMES ------------------- */
    /**
     * ⭐ 0061 BUILT `lead_sources` AND NOTHING HAD EVER CREATED ONE.
     *
     * ⚠️ A lead arriving with no source does not appear in "where does
     * our business come from", which is the single report this whole
     * batch exists to make true. The connection carries the source it
     * files under, and the intake refuses to guess.
     */
    leadSourceId: uuid("lead_source_id"),
    /**
     * ⚠️ NOT "the first stage by position". A tenant who reorders their
     * board would silently start filing new enquiries into whatever
     * ended up leftmost, which on a board beginning with "Contacted"
     * records every new lead as already contacted.
     */
    intakeStageId: uuid("intake_stage_id"),
    /** 🔴 Null means nobody, and the screen shows that rather than hiding it. */
    intakeOwnerId: uuid("intake_owner_id"),
    /**
     * 🔴🔴 DEFAULT TRUE, AND IT IS THE POINT OF THE BATCH. A lead in a
     * list nobody opens is a lead nobody rings.
     */
    intakeCreatesTask: boolean("intake_creates_task").default(true).notNull(),
    /**
     * ⚠️ An enquiry answered within the hour is a different business
     * from one answered on Thursday. Floored at 5 minutes and capped at
     * a week by a CHECK in 0065, so it cannot be set to nonsense.
     */
    intakeTaskDueMinutes: integer("intake_task_due_minutes").default(60).notNull(),

    /* --- 0066 · THE CEILING ---------------------------------------- */
    /**
     * 🔴🔴 A BUG IN A LOOP SPENDS REAL MONEY AT ABOUT ₹1 A MESSAGE.
     *
     * ⚠️ Everything else in this system that goes wrong produces a wrong
     * number on a screen. This produces a bill, and a customer whose
     * phone buzzed forty times at three in the morning.
     *
     * ⭐ ENFORCED BY A TRIGGER IN 0066, not by the sender. A limit
     * enforced by the code that does the sending is a limit the next
     * code path forgets.
     */
    dailySpendCapMinor: bigint("daily_spend_cap_minor", { mode: "bigint" }),
    /**
     * ⚠️ COUNTED ON ATTEMPTS AS WELL AS SPEND, because spend is billed
     * on delivery and therefore lags. A runaway loop moves the attempt
     * count immediately and the money figure minutes later, by which
     * time it is gone.
     */
    dailySendCap: integer("daily_send_cap"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    keyUnique: uniqueIndex("connections_key_unique").on(
      t.tenantId,
      t.connectorKey,
      sql`lower(${t.name})`,
    ),
    /** ⭐ The only query the runner makes: what is due. */
    dueIdx: index("connections_due_idx")
      .on(t.tenantId, t.lastAttemptAt)
      .where(
        sql`${t.isActive} AND ${t.pollEverySeconds} > 0 AND ${t.state} IN ('connected', 'degraded')`,
      ),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · EVERY FETCH, RECORDED                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THIS TABLE EXISTS FOR THE DAY SOMETHING BREAKS, NOT FOR THE DAYS IT
 * WORKS.
 *
 * 🔴 AND IT HAS THREE COUNTS, NOT ONE. "Fetched 40" answers nothing.
 * Forty seen, forty duplicates and nothing new is a healthy run on a
 * quiet day. Forty seen and forty new every single time is a cursor that
 * is not moving, which looks like success and is a silent re-import.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    /** ⚠️ The window actually asked for, so a gap can be seen. */
    windowFrom: timestamp("window_from", { withTimezone: true }),
    windowTo: timestamp("window_to", { withTimezone: true }),

    /**
     * running · success · partial · failed · skipped_locked ·
     * skipped_too_soon
     *
     * ⚠️ A skipped run is still a run and is still written down. A log
     * with gaps in it teaches people that gaps are normal.
     */
    outcome: varchar("outcome", { length: 20 }).default("running").notNull(),

    itemsSeen: integer("items_seen").default(0).notNull(),
    itemsNew: integer("items_new").default(0).notNull(),
    itemsDuplicate: integer("items_duplicate").default(0).notNull(),
    itemsFailed: integer("items_failed").default(0).notNull(),

    errorCode: varchar("error_code", { length: 60 }),
    /** 🔴 Required for failed and partial, by CHECK in 0064. */
    errorMessage: varchar("error_message", { length: 500 }),
    /** ⭐ Where the far end told us to wait. It wins over our own curve. */
    retryAfter: timestamp("retry_after", { withTimezone: true }),
  },
  (t) => ({
    connectionIdx: index("sync_runs_connection_idx").on(
      t.tenantId,
      t.connectionId,
      t.startedAt,
    ),
    /** ⭐ The screen a customer opens when leads stop arriving. */
    failuresIdx: index("sync_runs_failures_idx")
      .on(t.tenantId, t.startedAt)
      .where(sql`${t.outcome} IN ('failed', 'partial')`),
  }),
);

/* ------------------------------------------------------------------ */
/* 3 · INBOUND                                                         */
/* ------------------------------------------------------------------ */

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),

    /**
     * 🔴 THE UNGUESSABLE PART OF THE URL. For JustDial, which signs
     * nothing, it is the only thing between the endpoint and the open
     * internet, which is why 0064 refuses anything under 32 characters
     * at the database level rather than trusting whatever generated it.
     */
    pathToken: varchar("path_token", { length: 64 }).notNull(),
    /** hmac_sha256 · hmac_sha1 · shared_token · none */
    verification: varchar("verification", { length: 20 })
      .default("hmac_sha256")
      .notNull(),
    signatureHeader: varchar("signature_header", { length: 80 }),
    /** ⚠️ Clock skew allowed on a signed timestamp, in seconds. */
    timestampToleranceSeconds: integer("timestamp_tolerance_seconds")
      .default(300)
      .notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tokenUnique: uniqueIndex("webhook_endpoints_token_unique").on(t.pathToken),
  }),
);

/**
 * 🔴 A DELIVERY IS EVIDENCE. It cannot be edited, and 0064 refuses both
 * UPDATE and DELETE except to mark it processed and to purge it after
 * its retention date.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),

    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    /** The sender's own id, where it gives one. The only reliable replay key. */
    externalId: varchar("external_id", { length: 200 }),

    /**
     * 🔴 FOUR STATES, NOT A BOOLEAN: verified · invalid · absent ·
     * not_required.
     *
     * ⚠️ Collapse the last two and an endpoint whose signing was
     * accidentally switched off reads exactly like one whose signature
     * is passing.
     */
    signatureState: varchar("signature_state", { length: 20 }).notNull(),
    isReplay: boolean("is_replay").default(false).notNull(),

    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    /** ⭐ Redacted before it is stored. */
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    /**
     * 🔴 WHEN THIS ROW IS DELETED. Not optional, and not "someday". A
     * webhook body full of somebody's personal data kept forever is a
     * DPDP problem sitting in a debugging tool.
     */
    purgeAfter: date("purge_after").notNull(),

    processedAt: timestamp("processed_at", { withTimezone: true }),
    /** received · processed · rejected · failed · ignored_replay */
    outcome: varchar("outcome", { length: 20 }).default("received").notNull(),
    errorMessage: varchar("error_message", { length: 500 }),
  },
  (t) => ({
    /**
     * 🔴🔴 REPLAY PROTECTION, IN AN INDEX. Every one of these senders
     * retries; a delivery that arrives twice has to land once.
     */
    externalUnique: uniqueIndex("webhook_deliveries_external_unique")
      .on(t.endpointId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL AND NOT ${t.isReplay}`),
    endpointIdx: index("webhook_deliveries_endpoint_idx").on(
      t.tenantId,
      t.endpointId,
      t.receivedAt,
    ),
    /** ⭐ The purge job's only query. */
    purgeIdx: index("webhook_deliveries_purge_idx").on(t.purgeAfter),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const connectionsRelations = relations(connections, ({ many }) => ({
  runs: many(syncRuns),
  endpoints: many(webhookEndpoints),
}));

export const syncRunsRelations = relations(syncRuns, ({ one }) => ({
  connection: one(connections, {
    fields: [syncRuns.connectionId],
    references: [connections.id],
  }),
}));

export const webhookEndpointsRelations = relations(
  webhookEndpoints,
  ({ one, many }) => ({
    connection: one(connections, {
      fields: [webhookEndpoints.connectionId],
      references: [connections.id],
    }),
    deliveries: many(webhookDeliveries),
  }),
);

export const webhookDeliveriesRelations = relations(
  webhookDeliveries,
  ({ one }) => ({
    endpoint: one(webhookEndpoints, {
      fields: [webhookDeliveries.endpointId],
      references: [webhookEndpoints.id],
    }),
  }),
);

export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

/* ------------------------------------------------------------------ */
/* 4 · THE ENQUIRY NOBODY COULD FILE (0065)                            */
/* ------------------------------------------------------------------ */

/**
 * 🔴🔴 A DELIVERY THAT ARRIVED AND COULD NOT BECOME A LEAD.
 *
 * ⚠️ The customer paid for that enquiry. IndiaMART charges for the
 * subscription that produced it; Meta charged for the click. The choice
 * is between a row somebody has to look at and no row at all, and it is
 * not a close call.
 *
 * ⭐ SEPARATE FROM `webhookDeliveries` ON PURPOSE. That table answers
 * "did the bytes arrive", which is a developer's question. This one
 * answers "did a person get lost", which is the owner's.
 */
export const leadIntakeFailures = pgTable(
  "lead_intake_failures",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),

    deliveryId: uuid("delivery_id").references(() => webhookDeliveries.id, {
      onDelete: "set null",
    }),
    runId: uuid("run_id").references(() => syncRuns.id, { onDelete: "set null" }),

    externalId: varchar("external_id", { length: 200 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /**
     * 🔴 WHY, IN WORDS THE OWNER CAN ACT ON.
     *
     * ⚠️ "Validation error" is not a reason. "This enquiry arrived with
     * no phone number and no email address, so there is nobody to call"
     * is one, and it sends them to the provider's panel rather than to
     * us.
     */
    reason: varchar("reason", { length: 500 }).notNull(),
    reasonCode: varchar("reason_code", { length: 60 }).notNull(),

    /** ⭐ Whatever arrived, redacted, so it can be filed by hand. */
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),

    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedNote: varchar("resolved_note", { length: 500 }),
    resolvedLeadId: uuid("resolved_lead_id"),

    /** 🔴 DPDP again. A failed enquiry is still somebody's phone number. */
    purgeAfter: date("purge_after").notNull(),
  },
  (t) => ({
    openIdx: index("lead_intake_failures_open_idx")
      .on(t.tenantId, t.occurredAt)
      .where(sql`${t.resolvedAt} IS NULL`),
    purgeIdx: index("lead_intake_failures_purge_idx").on(t.purgeAfter),
  }),
);

export type LeadIntakeFailure = typeof leadIntakeFailures.$inferSelect;
