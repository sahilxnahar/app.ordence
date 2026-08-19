/**
 * Ordence — ⭐⭐⭐ CAMPAIGNS
 * Version: v1.15.0-alpha  ·  SQL 0067
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE AUDIENCE IS ROWS, NOT A SAVED FILTER
 * ══════════════════════════════════════════════════════════════════════
 * Every marketing tool stores the filter and re-runs it at send time, so
 * the list that goes out is not the list that was approved. Somebody
 * enquires in the twenty minutes between and receives a campaign nobody
 * decided to send them.
 *
 * ⚠️ And the person approving approved a specific number of messages at
 * a specific cost. This is the one place in the system where being wrong
 * spends money that cannot be got back.
 */

import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { connections } from "./integrations";
import { messageSends, messageTemplates } from "./messaging";

export const campaigns = pgTable(
  "campaigns",
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

    name: varchar("name", { length: 200 }).notNull(),
    purpose: varchar("purpose", { length: 500 }),

    /** draft · review · approved · sending · sent · stopped · cancelled */
    status: varchar("status", { length: 20 }).default("draft").notNull(),

    /**
     * ⭐ KEPT AS EVIDENCE OF HOW THE LIST WAS BUILT, AND NEVER RE-RUN.
     * See the file header.
     */
    audienceFilter: jsonb("audience_filter")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    audienceResolvedAt: timestamp("audience_resolved_at", { withTimezone: true }),

    /**
     * 🔴 THE FIGURES AS THEY STOOD WHEN A PERSON SAID YES. A trigger in
     * 0067 refuses an approval whose numbers do not match the resolved
     * audience, which is the whole reason the audience is rows.
     */
    approvedRecipients: integer("approved_recipients"),
    approvedCostMinor: bigint("approved_cost_minor", { mode: "bigint" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * ⚠️ TYPED BY THE PERSON APPROVING, NOT TICKED. An amount somebody
     * had to read and copy is an amount somebody read.
     */
    approvedAmountTyped: varchar("approved_amount_typed", { length: 40 }),

    /**
     * 🔴 CHECKED PER MESSAGE BY A TRIGGER IN 0067. A flag the runner
     * reads once at the start is not a stop button, and the moment
     * somebody notices the wording is wrong is about ninety seconds in.
     */
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    stopRequestedBy: uuid("stop_requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    stopReason: varchar("stop_reason", { length: 500 }),

    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("campaigns_tenant_idx").on(t.tenantId, t.createdAt),
    liveIdx: index("campaigns_live_idx")
      .on(t.tenantId, t.status)
      .where(sql`${t.status} IN ('review', 'approved', 'sending')`),
  }),
);

/**
 * 🔴🔴 BOTH THE PEOPLE WHO WILL RECEIVE IT AND THE PEOPLE WHO WILL NOT.
 *
 * ⚠️ A list of 9,000 that becomes 6,000 is a list where 3,000 people
 * were dropped for reasons nobody saw. A silent exclusion is how a firm
 * discovers it has been mailing 6,000 people instead of 9,000 for a year.
 */
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),

    subjectType: varchar("subject_type", { length: 40 }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** ⭐ Frozen at resolution. The name may change; this is who it went to. */
    displayName: varchar("display_name", { length: 255 }),
    phoneDigits: varchar("phone_digits", { length: 15 }),

    isIncluded: boolean("is_included").notNull(),
    exclusionCode: varchar("exclusion_code", { length: 40 }),
    exclusionReason: varchar("exclusion_reason", { length: 500 }),

    insideServiceWindow: boolean("inside_service_window").default(false).notNull(),
    /** Estimated, never billed. The real figure comes from the receipt. */
    estimatedCostMinor: bigint("estimated_cost_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    messageSendId: uuid("message_send_id").references(() => messageSends.id, {
      onDelete: "set null",
    }),
    sendOutcome: varchar("send_outcome", { length: 20 }),
    sendError: varchar("send_error", { length: 500 }),
    processedAt: timestamp("processed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** 🔴 One row per person. The same customer twice is two messages and one complaint. */
    unique: uniqueIndex("campaign_recipients_unique").on(
      t.campaignId,
      t.subjectType,
      t.subjectId,
    ),
    pendingIdx: index("campaign_recipients_pending_idx")
      .on(t.campaignId, t.id)
      .where(sql`${t.isIncluded} AND ${t.sendOutcome} IS NULL`),
  }),
);

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  connection: one(connections, {
    fields: [campaigns.connectionId],
    references: [connections.id],
  }),
  template: one(messageTemplates, {
    fields: [campaigns.templateId],
    references: [messageTemplates.id],
  }),
  recipients: many(campaignRecipients),
}));

export const campaignRecipientsRelations = relations(
  campaignRecipients,
  ({ one }) => ({
    campaign: one(campaigns, {
      fields: [campaignRecipients.campaignId],
      references: [campaigns.id],
    }),
  }),
);

export type Campaign = typeof campaigns.$inferSelect;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
