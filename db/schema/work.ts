/**
 * Ordence — ⭐⭐⭐ TASKS, THE UNIVERSAL TIMELINE, AND THE CALENDAR
 * Version: v1.9.0-alpha  ·  SQL 0060
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 FIFTY-NINE MIGRATIONS AND NO TASK TABLE
 * ══════════════════════════════════════════════════════════════════════
 * Ordence could record what a business IS. It could not record what
 * anybody DID about any of it. No follow-up, no assignment, no note
 * against a customer, no "ring him Tuesday".
 *
 * ⚠️ That is why the spreadsheet survives. A system holding the ledger
 * but not the follow-up leaves every human process outside it, and once
 * a process lives outside the system the data follows it out.
 *
 * ⭐ THREE TABLES, AND THEY ARE NOT THE SAME THING.
 *   tasks            — what somebody has to do, and by when
 *   activities       — what actually happened, append-only
 *   calendar_events  — where somebody has to be
 *
 * 🔴 Merging them is the common mistake. A task can be done late; a
 * meeting cannot. A note about what happened is not something to do.
 * Products that model all three as one row end up with a to-do list full
 * of history and a calendar full of wishes.
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
import { contacts } from "./crm";

/* ------------------------------------------------------------------ */
/* TASKS                                                               */
/* ------------------------------------------------------------------ */

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    title: varchar("title", { length: 300 }).notNull(),
    detail: text("detail"),

    /**
     * ⭐ POLYMORPHIC, DELIBERATELY. A task hangs off a company, an
     * invoice, a matter, a unit or nothing. Foreign keys to twenty
     * tables would mean twenty nullable columns, and a task table that
     * has to be altered every time a module is added is a task table
     * nobody creates tasks in.
     *
     * ⚠️ The TYPE is constrained even though the id is not, because a
     * free-text type gives you "invoice", "Invoice" and "sales_invoice"
     * in one column and a timeline showing a third of the history.
     */
    subjectType: varchar("subject_type", { length: 40 }),
    subjectId: uuid("subject_id"),
    subjectLabel: varchar("subject_label", { length: 300 }),

    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    dueOn: date("due_on", { mode: "string" }),
    dueAt: timestamp("due_at", { withTimezone: true }),

    priority: varchar("priority", { length: 10 }).default("normal").notNull(),
    status: varchar("status", { length: 20 }).default("open").notNull(),

    /** 🔴 "Done" with nobody's name on it is a cleared screen, not a record. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    outcome: text("outcome"),

    /** ⚠️ "Cancelled" with no reason is indistinguishable from "forgotten". */
    cancelledReason: varchar("cancelled_reason", { length: 500 }),

    /**
     * ⭐ Recurrence, kept simple: every N days, optionally until a date.
     * 🔴 The next one is created on COMPLETION, by a trigger, not on a
     * schedule. A nightly generator produces forty identical rows the
     * first time it is left off, and forty rows is a list nobody reads.
     */
    repeatEveryDays: integer("repeat_every_days"),
    repeatUntil: date("repeat_until", { mode: "string" }),
    recurredFrom: uuid("recurred_from").references((): AnyPgColumn => tasks.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    mineIdx: index("tasks_mine_idx")
      .on(t.tenantId, t.assignedTo, t.dueOn)
      .where(sql`${t.status} IN ('open', 'in_progress', 'blocked')`),
    subjectIdx: index("tasks_subject_idx").on(t.tenantId, t.subjectType, t.subjectId),
    /** ⚠️ Open work with nobody's name on it. */
    unassignedIdx: index("tasks_unassigned_idx")
      .on(t.tenantId, t.dueOn)
      .where(
        sql`${t.assignedTo} IS NULL AND ${t.status} IN ('open', 'in_progress', 'blocked')`,
      ),
  }),
);

/* ------------------------------------------------------------------ */
/* THE UNIVERSAL TIMELINE                                              */
/* ------------------------------------------------------------------ */

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    subjectType: varchar("subject_type", { length: 40 }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    subjectLabel: varchar("subject_label", { length: 300 }),

    kind: varchar("kind", { length: 30 }).notNull(),
    /**
     * 🔴 WHEN IT HAPPENED, NOT WHEN IT WAS TYPED. A call made on Tuesday
     * and written up on Friday belongs on Tuesday. Timelines sorted by
     * creation tell the story in the wrong order and make people look
     * slower than they were.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),

    direction: varchar("direction", { length: 10 }),

    summary: varchar("summary", { length: 500 }).notNull(),
    body: text("body"),

    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    /** manual | system | integration. Only manual rows can be edited. */
    source: varchar("source", { length: 20 }).default("manual").notNull(),
    sourceName: varchar("source_name", { length: 60 }),
    /** The outside system's own id, for duplicate control. */
    externalRef: varchar("external_ref", { length: 200 }),

    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    subjectIdx: index("activities_subject_idx").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
      t.occurredAt,
    ),
    recentIdx: index("activities_recent_idx").on(t.tenantId, t.occurredAt),
    externalUnique: uniqueIndex("activities_external_unique")
      .on(t.tenantId, t.sourceName, t.externalRef)
      .where(sql`${t.externalRef} IS NOT NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* THE CALENDAR                                                        */
/* ------------------------------------------------------------------ */

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    title: varchar("title", { length: 300 }).notNull(),
    detail: text("detail"),
    location: varchar("location", { length: 300 }),

    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").default(false).notNull(),

    subjectType: varchar("subject_type", { length: 40 }),
    subjectId: uuid("subject_id"),
    subjectLabel: varchar("subject_label", { length: 300 }),

    organiserId: uuid("organiser_id").references(() => users.id, { onDelete: "set null" }),
    kind: varchar("kind", { length: 20 }).default("meeting").notNull(),
    status: varchar("status", { length: 20 }).default("confirmed").notNull(),
    cancelledReason: varchar("cancelled_reason", { length: 500 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    whenIdx: index("calendar_events_when_idx")
      .on(t.tenantId, t.startsAt)
      .where(sql`${t.status} <> 'cancelled'`),
    subjectIdx: index("calendar_events_subject_idx").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
  }),
);

export const calendarEventAttendees = pgTable(
  "calendar_event_attendees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),

    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    externalName: varchar("external_name", { length: 200 }),

    response: varchar("response", { length: 20 }).default("invited").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    eventIdx: index("calendar_event_attendees_event_idx").on(t.tenantId, t.eventId),
    mineIdx: index("calendar_event_attendees_mine_idx")
      .on(t.tenantId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    userUnique: uniqueIndex("calendar_event_attendees_user_unique")
      .on(t.eventId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  tenant: one(tenants, { fields: [tasks.tenantId], references: [tenants.id] }),
  assignee: one(users, { fields: [tasks.assignedTo], references: [users.id] }),
  activities: many(activities),
}));

export const activitiesRelations = relations(activities, ({ one }) => ({
  tenant: one(tenants, { fields: [activities.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [activities.userId], references: [users.id] }),
  task: one(tasks, { fields: [activities.taskId], references: [tasks.id] }),
}));

export const calendarEventsRelations = relations(calendarEvents, ({ one, many }) => ({
  tenant: one(tenants, { fields: [calendarEvents.tenantId], references: [tenants.id] }),
  organiser: one(users, {
    fields: [calendarEvents.organiserId],
    references: [users.id],
  }),
  attendees: many(calendarEventAttendees),
}));

export const calendarEventAttendeesRelations = relations(
  calendarEventAttendees,
  ({ one }) => ({
    event: one(calendarEvents, {
      fields: [calendarEventAttendees.eventId],
      references: [calendarEvents.id],
    }),
    user: one(users, { fields: [calendarEventAttendees.userId], references: [users.id] }),
    contact: one(contacts, {
      fields: [calendarEventAttendees.contactId],
      references: [contacts.id],
    }),
  }),
);
