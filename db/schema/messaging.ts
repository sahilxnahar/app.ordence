/**
 * Ordence — ⭐⭐⭐ UTILITY MESSAGING
 * Version: v1.14.0-alpha  ·  SQL 0066
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS EXISTS TO MAKE `dunning_events.channel = 'whatsapp'` TRUE
 * ══════════════════════════════════════════════════════════════════════
 * That column has recorded WhatsApp service since 0027, in a table that
 * exists to be "the evidence that the buyer was given every chance". The
 * row was written by a person ticking a box, and nothing was ever sent.
 *
 * ⚠️ A gap in evidence is a gap. Evidence of something that did not
 * happen is a different problem, and it is found by the other side.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { tenants, users } from "./core";
import { connections } from "./integrations";

/* ------------------------------------------------------------------ */
/* 1 · THE TEMPLATE, AS META HOLDS IT                                  */
/* ------------------------------------------------------------------ */

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 120 }).notNull(),
    language: varchar("language", { length: 10 }).default("en").notNull(),

    /**
     * 🔴 THE CATEGORY DECIDES THE PRICE, AND META DECIDES THE CATEGORY.
     *
     * ⚠️ They re-categorise. A template written as `utility` that reads
     * like an advertisement is moved to `marketing`, and the identical
     * send silently costs roughly seven times more. Nothing tells the
     * business; the bill does, a month later.
     */
    category: varchar("category", { length: 20 }).notNull(),
    /** ⭐ What we asked for, kept so a re-categorisation is visible. */
    requestedCategory: varchar("requested_category", { length: 20 }),

    body: text("body").notNull(),
    headerText: text("header_text"),
    footerText: text("footer_text"),
    /**
     * ⚠️ Meta refuses a send whose parameter count does not match the
     * approved template, so this is checked before anything is
     * attempted rather than discovered when the reminder does not go.
     */
    variableCount: integer("variable_count").default(0).notNull(),

    /**
     * 🔴 in_review · approved · rejected · paused · disabled
     *
     * ⚠️ `paused` IS TEMPORARY AND ESCALATING: three hours, then six,
     * then permanent. A retry loop that treats a pause as a transient
     * error sends into the next pause and reaches `disabled`, which
     * cannot be undone.
     */
    status: varchar("status", { length: 20 }).default("in_review").notNull(),
    quality: varchar("quality", { length: 10 }),
    rejectionReason: varchar("rejection_reason", { length: 500 }),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    /** ⭐ Three pauses is permanent. */
    pauseCount: integer("pause_count").default(0).notNull(),

    syncedAt: timestamp("synced_at", { withTimezone: true }),

    /**
     * ⭐⭐ WHERE THIS ROW CAME FROM. Added in 0069.
     *
     * `declared` — a person told us this template exists.
     * `synced`   — we read it back from the provider.
     *
     * 🔴 A DECLARED TEMPLATE IS A CLAIM. ONLY A SYNCED ONE IS A FACT,
     * and 0069 carries the CHECK that stops a declared row ever holding
     * `status = 'approved'`. Without that separation somebody ticks
     * approved because it looks approved on Meta's dashboard, a campaign
     * of four thousand resolves against it, and either every send is
     * refused for a parameter mismatch or they all go out under a
     * category Meta quietly moved to marketing at seven times the price.
     */
    source: varchar("source", { length: 20 }).default("declared").notNull(),
    /** ⚠️ When a person asserted it. Null on a row that came from the API. */
    declaredAt: timestamp("declared_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    unique: uniqueIndex("message_templates_unique").on(
      t.connectionId,
      t.name,
      t.language,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · THE 24 HOUR WINDOW                                              */
/* ------------------------------------------------------------------ */

/**
 * 🔴🔴 THE DIFFERENCE BETWEEN FREE AND CHARGED, AND IT IS INVISIBLE.
 *
 * A utility template inside an open customer service window is free.
 * The same template one minute after it closes is charged. Nothing about
 * the message changes; only the clock.
 *
 * ⭐ Which makes this the one optimisation that actually saves a
 * customer money, and no product tells them: send the payment reminder
 * while the buyer is still in conversation.
 */
export const serviceWindows = pgTable(
  "service_windows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),

    phoneDigits: varchar("phone_digits", { length: 15 }).notNull(),

    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /**
     * ⭐ 72 HOURS, NOT 24, AND EVERYTHING IS FREE INSIDE IT — including
     * marketing. Opened by a click-to-WhatsApp ad or a page button, so a
     * business running those has a materially different cost profile and
     * no product tells them.
     */
    isFreeEntryPoint: boolean("is_free_entry_point").default(false).notNull(),

    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    unique: uniqueIndex("service_windows_unique").on(t.connectionId, t.phoneDigits),
    openIdx: index("service_windows_open_idx").on(t.tenantId, t.expiresAt),
  }),
);

/* ------------------------------------------------------------------ */
/* 3 · WHAT WE ACTUALLY SENT                                           */
/* ------------------------------------------------------------------ */

export const messageSends = pgTable(
  "message_sends",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").references(() => messageTemplates.id, {
      onDelete: "set null",
    }),

    /**
     * 🔴🔴 OURS, NOT THEIRS, AND DERIVED FROM WHAT THE MESSAGE IS.
     *
     * ⚠️ Meta returns a message id only in the response, which is no use
     * for deciding whether to send. A retry after a timeout would
     * otherwise send the same payment reminder twice, and the second one
     * is the one the customer complains about.
     */
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),

    subjectType: varchar("subject_type", { length: 40 }),
    subjectId: uuid("subject_id"),

    toPhoneDigits: varchar("to_phone_digits", { length: 15 }).notNull(),
    toPhone: varchar("to_phone", { length: 32 }),

    category: varchar("category", { length: 20 }).notNull(),
    language: varchar("language", { length: 10 }).default("en").notNull(),
    /**
     * 🔴 THE RENDERED TEXT, KEPT. A demand notice is served evidence,
     * and "template X with parameters A, B" is not what the buyer
     * received. The template will have been edited by the time anybody
     * asks.
     */
    renderedBody: text("rendered_body").notNull(),

    /**
     * 🔴 RECORDED AT SEND TIME, because it cannot be reconstructed
     * afterwards and it is the whole explanation of the price.
     */
    insideServiceWindow: boolean("inside_service_window").default(false).notNull(),

    status: varchar("status", { length: 20 }).default("queued").notNull(),
    providerMessageId: varchar("provider_message_id", { length: 200 }),

    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),

    errorCode: varchar("error_code", { length: 60 }),
    errorMessage: varchar("error_message", { length: 500 }),

    /**
     * 🔴🔴 NULL UNTIL DELIVERED, AND 0066 REFUSES A COST ON ANYTHING
     * THAT WAS NOT.
     *
     * ⚠️ Meta charges only when a template message is delivered. A cost
     * booked at send time counts messages that were never charged, and a
     * spend ceiling built on that figure stops a business from sending
     * messages that are free.
     */
    costMinor: bigint("cost_minor", { mode: "bigint" }),
    /** The rate used, so an old send survives a rate change. */
    rateMinor: bigint("rate_minor", { mode: "bigint" }),

    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    idempotencyUnique: uniqueIndex("message_sends_idempotency_unique").on(
      t.tenantId,
      t.idempotencyKey,
    ),
    subjectIdx: index("message_sends_subject_idx").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const messageTemplatesRelations = relations(
  messageTemplates,
  ({ one, many }) => ({
    connection: one(connections, {
      fields: [messageTemplates.connectionId],
      references: [connections.id],
    }),
    sends: many(messageSends),
  }),
);

export const messageSendsRelations = relations(messageSends, ({ one }) => ({
  template: one(messageTemplates, {
    fields: [messageSends.templateId],
    references: [messageTemplates.id],
  }),
  connection: one(connections, {
    fields: [messageSends.connectionId],
    references: [connections.id],
  }),
}));

export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type MessageSend = typeof messageSends.$inferSelect;
export type ServiceWindowRow = typeof serviceWindows.$inferSelect;
