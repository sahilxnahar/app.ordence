/**
 * Ordence — ⭐⭐⭐ SOURCES, PIPELINES, CONSENT AND CONVERSATIONS
 * Version: v1.10.0-alpha  ·  SQL 0061
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ NO SECOND LEAD TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `leads` already existed and is already mostly generic. What was
 * real-estate-shaped about it was the project link. 0061 extends it and
 * this file declares the additions on the existing table rather than
 * creating a rival one, for the same reason 0057 did not build a second
 * price list: two answers to "who enquired" is worse than a gap.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 AND THE PART THAT IS NOT OPTIONAL
 * ══════════════════════════════════════════════════════════════════════
 * The DPDP Rules 2025 were notified on 13 November 2025 and the penalty
 * regime begins May 2027, which is inside the life of this plan.
 *
 * ⚠️ Consent as a boolean is not consent. It turns on what the person
 * was TOLD, for what PURPOSE, and whether they can take it back. Hence
 * two tables: the notice, in the exact words shown and frozen the moment
 * anybody agrees to it, and the consent itself, naming the notice.
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
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { companies, contacts } from "./crm";
import { tasks } from "./work";

/* ------------------------------------------------------------------ */
/* WHERE LEADS COME FROM                                               */
/* ------------------------------------------------------------------ */

export const leadSources = pgTable(
  "lead_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 160 }).notNull(),
    channel: varchar("channel", { length: 30 }).notNull(),
    /** ⭐ For a marketplace, the key the connector uses. */
    connectorKey: varchar("connector_key", { length: 60 }),

    isPaid: boolean("is_paid").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    activeIdx: index("lead_sources_active_idx")
      .on(t.tenantId, t.channel)
      .where(sql`${t.isActive}`),
  }),
);

/* ------------------------------------------------------------------ */
/* THE BOARD                                                           */
/* ------------------------------------------------------------------ */

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    pipelineKey: varchar("pipeline_key", { length: 40 }).default("lead").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    position: integer("position").notNull(),

    /**
     * 🔴 EXACTLY ONE WON STAGE PER BOARD, enforced by a deferrable
     * constraint trigger in 0061. Two win columns produce two conversion
     * rates and every report built on them disagrees with every other.
     */
    isWon: boolean("is_won").default(false).notNull(),
    isLost: boolean("is_lost").default(false).notNull(),
    /** ⚠️ A lost stage asks why. The reasons are the value of it. */
    requiresReason: boolean("requires_reason").default(false).notNull(),
    colour: varchar("colour", { length: 20 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    positionUnique: uniqueIndex("pipeline_stages_position_unique").on(
      t.tenantId,
      t.pipelineKey,
      t.position,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* THE NOTICE                                                          */
/* ------------------------------------------------------------------ */

export const consentNotices = pgTable(
  "consent_notices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 160 }).notNull(),
    version: integer("version").default(1).notNull(),
    /** ⭐ THE ACTUAL WORDING SHOWN. Not a link to it, and frozen once used. */
    body: text("body").notNull(),
    purposes: text("purposes")
      .array()
      .notNull()
      .default(sql`ARRAY['marketing']`),
    language: varchar("language", { length: 8 }).default("en").notNull(),

    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    isActive: boolean("is_active").default(true).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    versionUnique: uniqueIndex("consent_notices_version_unique").on(
      t.tenantId,
      t.name,
      t.version,
      t.language,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* THE CONSENT                                                         */
/* ------------------------------------------------------------------ */

export const consents = pgTable(
  "consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    /** ⚠️ Typed loosely to avoid a cycle with sales.ts. FK is in 0061. */
    leadId: uuid("lead_id"),

    /** 🔴 Purpose limitation. Order updates are not a campaign. */
    purpose: varchar("purpose", { length: 30 }).notNull(),
    /** ⭐ `all` is the important value: one stop means stop. */
    channel: varchar("channel", { length: 20 }).default("all").notNull(),

    state: varchar("state", { length: 20 }).default("granted").notNull(),

    /** 🔴 A grant without this is a checkbox, not evidence. */
    noticeId: uuid("notice_id").references(() => consentNotices.id, {
      onDelete: "restrict",
    }),

    grantedAt: timestamp("granted_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    evidence: varchar("evidence", { length: 200 }),
    evidenceRef: varchar("evidence_ref", { length: 200 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    contactIdx: index("consents_contact_idx")
      .on(t.tenantId, t.contactId, t.purpose)
      .where(sql`${t.contactId} IS NOT NULL`),
    leadIdx: index("consents_lead_idx")
      .on(t.tenantId, t.leadId, t.purpose)
      .where(sql`${t.leadId} IS NOT NULL`),
    companyIdx: index("consents_company_idx")
      .on(t.tenantId, t.companyId, t.purpose)
      .where(sql`${t.companyId} IS NOT NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* CONVERSATIONS                                                       */
/* ------------------------------------------------------------------ */

export const messageThreads = pgTable(
  "message_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    title: varchar("title", { length: 300 }),
    /** The same vocabulary tasks and activities use. */
    subjectType: varchar("subject_type", { length: 40 }),
    subjectId: uuid("subject_id"),
    subjectLabel: varchar("subject_label", { length: 300 }),

    isClosed: boolean("is_closed").default(false).notNull(),
    closedReason: varchar("closed_reason", { length: 300 }),

    /** ⭐ Kept by a trigger so a thread list needs no subquery per row. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    messageCount: integer("message_count").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    subjectIdx: index("message_threads_subject_idx").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
    recentIdx: index("message_threads_recent_idx").on(t.tenantId, t.lastMessageAt),
  }),
);

export const threadParticipants = pgTable(
  "thread_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => messageThreads.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** 🔴 Unread is computed from this. Never a stored count. */
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    isMuted: boolean("is_muted").default(false).notNull(),
    joinedVia: varchar("joined_via", { length: 20 }).default("added").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    unique: uniqueIndex("thread_participants_unique").on(t.threadId, t.userId),
    mineIdx: index("thread_participants_mine_idx").on(t.tenantId, t.userId),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => messageThreads.id, { onDelete: "cascade" }),

    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    /** ⭐ A mention adds the person to the thread, by trigger. */
    mentions: uuid("mentions")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    replyTo: uuid("reply_to").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),

    /** Set when a message became a task, so it is not done twice. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),

    /** ⚠️ An edit is recorded, never hidden. */
    editedAt: timestamp("edited_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    threadIdx: index("messages_thread_idx").on(t.tenantId, t.threadId, t.createdAt),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const leadSourcesRelations = relations(leadSources, ({ one }) => ({
  tenant: one(tenants, { fields: [leadSources.tenantId], references: [tenants.id] }),
}));

export const consentNoticesRelations = relations(consentNotices, ({ many }) => ({
  consents: many(consents),
}));

export const consentsRelations = relations(consents, ({ one }) => ({
  notice: one(consentNotices, {
    fields: [consents.noticeId],
    references: [consentNotices.id],
  }),
  contact: one(contacts, { fields: [consents.contactId], references: [contacts.id] }),
  company: one(companies, { fields: [consents.companyId], references: [companies.id] }),
}));

export const messageThreadsRelations = relations(messageThreads, ({ one, many }) => ({
  tenant: one(tenants, { fields: [messageThreads.tenantId], references: [tenants.id] }),
  participants: many(threadParticipants),
  messages: many(messages),
}));

export const threadParticipantsRelations = relations(threadParticipants, ({ one }) => ({
  thread: one(messageThreads, {
    fields: [threadParticipants.threadId],
    references: [messageThreads.id],
  }),
  user: one(users, { fields: [threadParticipants.userId], references: [users.id] }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(messageThreads, {
    fields: [messages.threadId],
    references: [messageThreads.id],
  }),
  author: one(users, { fields: [messages.authorId], references: [users.id] }),
  task: one(tasks, { fields: [messages.taskId], references: [tasks.id] }),
}));
