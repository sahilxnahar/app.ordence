/**
 * Ordence — Notifications
 * Version: v0.81.0-alpha
 *
 * Per-tenant notification center. Each notification is a structured alert
 * that surfaces insights from the background intelligence workers, system
 * events, and user-triggered actions to the people who need to see them.
 *
 * ⚠️ TENANT-SCOPED. Every row keys off `tenant_id` and is protected by
 * RLS, identical to every other tenant table.
 *
 * ⚠️ APPEND-ONLY INSERT, UPDATE ONLY FOR READ STATE. A notification is
 * created by the system and can be marked as read or dismissed, but never
 * edited or deleted. The history of what was alerted is itself auditable.
 *
 * Design choices:
 * - `severity` controls UI presentation (badge color, sort priority)
 * - `category` groups notifications for filtering (compliance, finance, etc.)
 * - `actionUrl` is a deep link to the relevant page (e.g. /compliance?task=123)
 * - `metadata` stores structured context for the notification (e.g. amount, dueDate)
 * - `expiresAt` allows notifications to auto-archive after a period
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./core";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Who should see this. null = broadcast to all users in the tenant. */
    userId: uuid("user_id"),

    /** The notification category, for filtering. */
    category: varchar("category", { length: 40 }).notNull(),

    /** Severity controls UI presentation and sort priority. */
    severity: varchar("severity", { length: 20 }).notNull().default("info"),

    /** One-line title shown in the bell dropdown and notification list. */
    title: varchar("title", { length: 200 }).notNull(),

    /** Body text with details. Shown expanded in the notification list. */
    body: text("body"),

    /** Deep link to the relevant page, e.g. /compliance?task=123. */
    actionUrl: varchar("action_url", { length: 500 }),

    /** Structured context: amounts, dates, entity IDs, etc. */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),

    /** Which background worker or system created this. */
    source: varchar("source", { length: 60 }),

    readAt: timestamp("read_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),

    /** Auto-archive after this time. null = never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /** List unread notifications for a tenant, newest first. */
    tenantUnreadIdx: index("notifications_tenant_unread_idx")
      .on(t.tenantId, t.readAt, t.createdAt),
    /** Filter by category within a tenant. */
    tenantCategoryIdx: index("notifications_tenant_category_idx")
      .on(t.tenantId, t.category, t.createdAt),
    /** Per-user notifications. */
    userIdx: index("notifications_user_idx").on(t.userId, t.createdAt),
  }),
);
