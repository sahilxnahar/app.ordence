/**
 * Ordence — ⭐ ENGINE 1 · SCHEDULING & CAPACITY
 * Version: v0.59.0-alpha  ·  Session 1, Part 1
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE KEYSTONE — FIVE VERTICALS RUN ON THIS ONE ENGINE
 * ══════════════════════════════════════════════════════════════════════
 * A hotel room-night. A hospital appointment and a bed. A truck's next
 * trip. A consultant's Tuesday. A solar engineer's service visit.
 *
 * Five industries, one question: can this resource be committed for that
 * span of time, and is it already promised to somebody else?
 *
 * ⚠️ THE VOCABULARY DIFFERS; THE CAPABILITY DOES NOT. `hotel.rooms` +
 * `hospital.beds` + `logistics.slots` would be three feature keys for one
 * engine — three code paths, three sets of bugs, and a price list nobody
 * can explain. There is ONE key, `scheduling.resources`, and the words
 * live in the industry template.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE HARD PART IS NOT THE CALENDAR. IT IS THE CONCURRENCY.
 * ══════════════════════════════════════════════════════════════════════
 * Every naive booking system works perfectly in testing and double-sells
 * on the first busy day. Two agents open the last room at the same
 * instant, both queries say "available", both write, and now one guest
 * arrives to a room that belongs to somebody else.
 *
 * Reading before writing cannot fix this. The check and the write are two
 * statements, and in between them anything can happen.
 *
 * So the guarantee is a POSTGRESQL EXCLUSION CONSTRAINT over a time
 * range — the database itself refuses two overlapping commitments on one
 * resource, at the moment of write, under concurrency, with no
 * application code involved. Implemented in `0033_engine1_scheduling.sql`
 * with `tstzrange` and a GiST index.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND YET OVERBOOKING MUST BE POSSIBLE
 * ══════════════════════════════════════════════════════════════════════
 * A hotel deliberately sells more rooms than it has, because some guests
 * never arrive. A system that forbids that is unusable in hospitality; a
 * system that permits it silently is dangerous everywhere else.
 *
 * So capacity is a NUMBER on the resource and overbooking is a STATED
 * ALLOWANCE — `capacity` plus `overbook_limit`. Exclusive resources (a
 * consultation room, a truck) set capacity to 1 and the allowance to 0,
 * and get true exclusivity. Shared ones (a ward with 20 beds, a
 * restaurant with 40 covers) count instead. One model, both behaviours,
 * and the difference is visible in a column rather than buried in a
 * branch.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { contacts } from "./crm";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * What kind of thing is being booked.
 *
 * ⚠️ DESCRIPTIVE, NOT STRUCTURAL. Every kind behaves identically — this
 * exists so a hotel's screens can filter to rooms and a clinic's to
 * practitioners. Nothing in the engine branches on it, and nothing
 * should: the moment one kind gets special handling, the other four
 * stop being tested.
 */
export const resourceKindEnum = pgEnum("resource_kind", [
  "room",
  "bed",
  "table",
  "hall",
  "practitioner",
  "vehicle",
  "equipment",
  "staff",
  "slot",
  "other",
]);

/**
 * ⭐ THE BOOKING LIFECYCLE.
 *
 * ⚠️ WHICH STATES CONSUME CAPACITY IS THE WHOLE DESIGN, and it is not
 * obvious. `held` and `confirmed` do; `cancelled` and `no_show` do not.
 *
 * `no_show` is the interesting one. The guest did not arrive, so the room
 * is free NOW — but it was legitimately committed for the night, and the
 * charge usually stands. Treating it as `cancelled` would make the
 * occupancy history lie; treating it as `confirmed` would block a resale.
 * It is its own state because it is its own fact.
 */
/**
 * ⚠️ NAMED `scheduleBookingStatusEnum`, NOT `bookingStatusEnum`.
 *
 * `./sales` already exports a `bookingStatusEnum` — a property booking in
 * a real-estate sale, which is a completely different lifecycle. The
 * schema barrel re-exports everything into one namespace, so the collision
 * was a hard build error rather than a silent shadow. Caught by tsc, but
 * worth naming: two "booking" concepts in one ERP is normal, and the
 * qualified name is what keeps them apart.
 */
export const scheduleBookingStatusEnum = pgEnum("schedule_booking_status", [
  "held",
  "confirmed",
  "checked_in",
  "in_progress",
  "completed",
  "no_show",
  "cancelled",
  "waitlisted",
]);

/** Why a resource is unavailable outside normal hours. */
export const blockKindEnum = pgEnum("schedule_block_kind", [
  "maintenance",
  "cleaning",
  "closed",
  "holiday",
  "reserved_internal",
  "breakdown",
  "other",
]);

/* ------------------------------------------------------------------ */
/* 1 · RESOURCES — the thing being booked                              */
/* ------------------------------------------------------------------ */

export const scheduleResources = pgTable(
  "schedule_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 60 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    kind: resourceKindEnum("kind").default("slot").notNull(),

    /** Grouping — a floor, a ward, a depot, a department. */
    groupName: varchar("group_name", { length: 120 }),

    /**
     * ⭐ HOW MANY SIMULTANEOUS BOOKINGS THIS RESOURCE ADMITS.
     *
     * 1  → exclusive. A room, a truck, a surgeon. Two overlapping
     *      bookings are refused by the exclusion constraint outright.
     * >1 → shared. A ward with 20 beds, a class with 30 seats. Overlap
     *      is legitimate; the COUNT is what is checked.
     */
    capacity: integer("capacity").default(1).notNull(),

    /**
     * ⭐ HOW FAR BEYOND CAPACITY THIS RESOURCE MAY BE SOLD.
     *
     * ⚠️ ZERO BY DEFAULT, AND THAT DEFAULT IS THE SAFE ONE. A hotel
     * turning this up to 3 is making a commercial decision it can defend
     * and measure. Every other vertical leaves it at zero and gets hard
     * exclusivity — which is what a hospital bed and an operating theatre
     * require, and what a system that overbooks "helpfully" would break.
     */
    overbookLimit: integer("overbook_limit").default(0).notNull(),

    /**
     * Minutes to leave free after each booking — cleaning a room,
     * sterilising a theatre, a driver's rest.
     *
     * ⚠️ Enforced by the exclusion constraint by EXTENDING the reserved
     * range, not by a separate rule. A buffer that is merely displayed is
     * a buffer the busy day ignores.
     */
    bufferMinutes: integer("buffer_minutes").default(0).notNull(),

    /** Smallest bookable unit. 1440 = a full day, for room-nights. */
    slotMinutes: integer("slot_minutes").default(60).notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    isBookableOnline: boolean("is_bookable_online").default(false).notNull(),

    /** Base price. The rate engine overrides; this is the fallback. */
    baseRateMinor: bigint("base_rate_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Opening hours as `{ mon: [["09:00","18:00"]], ... }`. */
    openingHours: jsonb("opening_hours")
      .$type<Record<string, [string, string][]>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Skills, features, ward class — used for matching, not gating. */
    attributes: jsonb("attributes")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("schedule_resources_tenant_idx").on(t.tenantId),
    kindIdx: index("schedule_resources_kind_idx").on(t.tenantId, t.kind),
    codeKey: uniqueIndex("schedule_resources_code_key").on(t.tenantId, t.code),
    tenantScoped: uniqueIndex("schedule_resources_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    capacityPositive: check(
      "schedule_resources_capacity_positive",
      sql`${t.capacity} >= 1`,
    ),
    overbookNonNegative: check(
      "schedule_resources_overbook_non_negative",
      sql`${t.overbookLimit} >= 0`,
    ),
    bufferNonNegative: check(
      "schedule_resources_buffer_non_negative",
      sql`${t.bufferMinutes} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · BOOKINGS — the commitment                                       */
/* ------------------------------------------------------------------ */

export const scheduleBookings = pgTable(
  "schedule_bookings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    resourceId: uuid("resource_id").notNull(),

    reference: varchar("reference", { length: 60 }).notNull(),

    /**
     * ⚠️ HALF-OPEN: [starts_at, ends_at). A booking ending at 11:00 and
     * one starting at 11:00 do NOT overlap.
     *
     * This is not a detail. With closed ranges, back-to-back appointments
     * collide and every schedule develops a one-minute gap that somebody
     * eventually "fixes" by disabling the check.
     */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),

    status: scheduleBookingStatusEnum("status").default("held").notNull(),

    /**
     * When a `held` booking expires if not confirmed.
     *
     * ⚠️ A hold with no expiry is inventory lost forever to somebody who
     * closed the tab. The sweeper releases these; the column is what
     * makes that possible without guessing.
     */
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),

    /** How many units of capacity this consumes. Usually 1. */
    quantity: integer("quantity").default(1).notNull(),

    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    partyName: varchar("party_name", { length: 200 }),
    partyPhone: varchar("party_phone", { length: 40 }),

    /** Where it came from — direct, OTA, phone, portal, API. */
    channel: varchar("channel", { length: 60 }).default("direct").notNull(),

    quotedRateMinor: bigint("quoted_rate_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * ⭐ SET WHEN THIS BOOKING EXCEEDED CAPACITY.
     *
     * ⚠️ Recorded rather than merely permitted. An overbooking that
     * nobody can find afterwards is how a hotel discovers at 9pm that it
     * has walked three guests. The flag makes the exposure a query.
     */
    isOverbooking: boolean("is_overbooking").default(false).notNull(),

    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),

    notes: text("notes"),

    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("schedule_bookings_tenant_idx").on(t.tenantId),
    resourceTimeIdx: index("schedule_bookings_resource_time_idx").on(
      t.tenantId,
      t.resourceId,
      t.startsAt,
    ),
    statusIdx: index("schedule_bookings_status_idx").on(t.tenantId, t.status),
    holdIdx: index("schedule_bookings_hold_idx").on(t.holdExpiresAt),
    referenceKey: uniqueIndex("schedule_bookings_reference_key").on(
      t.tenantId,
      t.reference,
    ),
    tenantScoped: uniqueIndex("schedule_bookings_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    /**
     * ⚠️ STRICTLY GREATER. A zero-length booking passes every overlap
     * check ever written, because it overlaps nothing — so it silently
     * consumes no capacity while appearing on the board as a real
     * commitment.
     */
    rangeOrdered: check(
      "schedule_bookings_range_ordered",
      sql`${t.endsAt} > ${t.startsAt}`,
    ),
    quantityPositive: check(
      "schedule_bookings_quantity_positive",
      sql`${t.quantity} >= 1`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 3 · BLOCKS — time that is not for sale                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A SEPARATE TABLE, NOT A BOOKING WITH A FAKE CUSTOMER.
 *
 * Modelling maintenance as a booking is the obvious shortcut and it
 * poisons every number downstream: occupancy counts it as sold, revenue
 * reports show a zero-value stay, and the cancellation rate includes
 * the day the boiler broke. Blocked time is not demand.
 */
export const scheduleBlocks = pgTable(
  "schedule_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    resourceId: uuid("resource_id").notNull(),

    kind: blockKindEnum("kind").default("maintenance").notNull(),
    reason: varchar("reason", { length: 300 }).notNull(),

    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),

    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("schedule_blocks_tenant_idx").on(t.tenantId),
    resourceTimeIdx: index("schedule_blocks_resource_time_idx").on(
      t.tenantId,
      t.resourceId,
      t.startsAt,
    ),
    tenantScoped: uniqueIndex("schedule_blocks_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    rangeOrdered: check(
      "schedule_blocks_range_ordered",
      sql`${t.endsAt} > ${t.startsAt}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* CONSTANTS                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE STATUSES THAT CONSUME CAPACITY.
 *
 * ⚠️ THE SINGLE MOST CONSEQUENTIAL LIST IN THE ENGINE, and the SQL
 * exclusion constraint must agree with it exactly. Add a status here and
 * forget the constraint, and that status stops blocking double-booking —
 * silently, with no error anywhere, on the busiest day of the year.
 * `tests/ui/scheduling.test.tsx` asserts the two lists match.
 */
export const CAPACITY_CONSUMING_STATUSES = [
  "held",
  "confirmed",
  "checked_in",
  "in_progress",
] as const;

/** Statuses that free the resource again. */
export const CAPACITY_RELEASING_STATUSES = [
  "completed",
  "no_show",
  "cancelled",
  "waitlisted",
] as const;

/** Default minutes a hold survives before the sweeper releases it. */
export const DEFAULT_HOLD_MINUTES = 20;

export type ScheduleBookingStatus =
  (typeof scheduleBookingStatusEnum.enumValues)[number];
export type ResourceKind = (typeof resourceKindEnum.enumValues)[number];

/**
 * Does this status occupy the resource?
 *
 * Exported so the UI, the availability query and the tests all ask the
 * same question of the same list rather than each re-deriving it.
 */
export function consumesCapacity(status: ScheduleBookingStatus): boolean {
  return (CAPACITY_CONSUMING_STATUSES as readonly string[]).includes(status);
}

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const scheduleResourcesRelations = relations(
  scheduleResources,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [scheduleResources.tenantId],
      references: [tenants.id],
    }),
    bookings: many(scheduleBookings),
    blocks: many(scheduleBlocks),
  }),
);

export const scheduleBookingsRelations = relations(
  scheduleBookings,
  ({ one }) => ({
    resource: one(scheduleResources, {
      fields: [scheduleBookings.resourceId],
      references: [scheduleResources.id],
    }),
    contact: one(contacts, {
      fields: [scheduleBookings.contactId],
      references: [contacts.id],
    }),
  }),
);

export const scheduleBlocksRelations = relations(scheduleBlocks, ({ one }) => ({
  resource: one(scheduleResources, {
    fields: [scheduleBlocks.resourceId],
    references: [scheduleResources.id],
  }),
}));
