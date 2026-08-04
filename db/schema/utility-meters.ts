/**
 * Ordence — ⭐ ENGINE 5 · UTILITY METERING & CONSUMPTION BILLING
 * Version: v0.63.0-alpha  ·  Session 1
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NOT `db/schema/metering.ts` — THAT ONE ALREADY EXISTS AND IS
 * SOMETHING ELSE ENTIRELY.
 * ══════════════════════════════════════════════════════════════════════
 * Phase 15's `metering.ts` counts how much of ORDENCE a tenant has used:
 * API calls, emails, storage. This file is about PHYSICAL meters —
 * electricity consumed, solar generated, water, gas, fuel.
 *
 * Two things called metering in one ERP is confusing but honest; naming
 * them the same thing would have been a silent shadow at the schema
 * barrel, and someone would eventually import the wrong one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A READING IS AN ODOMETER, NOT A QUANTITY
 * ══════════════════════════════════════════════════════════════════════
 * The instinct is to store "450 units consumed in July". It is wrong,
 * and the wrongness is not recoverable.
 *
 * A meter shows a CUMULATIVE total. What you consumed is the difference
 * between two readings. Storing the difference throws away the only
 * thing that can ever verify it — so when a customer disputes July, you
 * have your own arithmetic and nothing to check it against, and when a
 * reading is later found to be a typo every downstream month is wrong
 * with no way to detect it.
 *
 * So `reading_value` is what the dial said, and consumption is DERIVED
 * by trigger from the previous reading on the same meter.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND A READING CAN GO DOWN LEGITIMATELY
 * ══════════════════════════════════════════════════════════════════════
 * Two ways, both common, both catastrophic if unhandled:
 *
 *   ROLLOVER — a 5-digit meter passes 99999 and shows 00042. Consumption
 *              is 43, not −99,957. Naive subtraction produces a credit
 *              note for a year of free electricity.
 *   REPLACED — the old meter died and the new one starts at zero. There
 *              is no arithmetic relationship between the two at all.
 *
 * Rollover is handled by the digit count. Replacement is handled by
 * refusing to subtract across meters — which is why a replacement is a
 * new meter row, never an edit to the old one.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  boolean,
  integer,
  bigint,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { contacts } from "./crm";
import { rateCards } from "./pricing";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

export const meterKindEnum = pgEnum("meter_kind", [
  "electricity_import",
  "electricity_export",
  "electricity_net",
  "solar_generation",
  "water",
  "gas",
  "fuel",
  "sub_meter",
]);

export const meterStatusEnum = pgEnum("meter_status", [
  "pending_installation",
  "active",
  "faulty",
  "replaced",
  "disconnected",
  "removed",
]);

/**
 * How the number got here.
 *
 * ⚠️ `estimated` IS A FIRST-CLASS STATE, NOT A FLAG. When nobody could
 * reach the meter the bill still goes out, based on history — and the
 * NEXT actual reading must reconcile against it, crediting or charging
 * the difference. A system that cannot say "this one was estimated"
 * cannot do that reconciliation, and the error compounds silently every
 * month nobody visits.
 */
export const readingSourceEnum = pgEnum("reading_source", [
  "manual",
  "photo",
  "smart_meter",
  "api",
  "estimated",
  "customer_submitted",
]);

export const readingStatusEnum = pgEnum("reading_status", [
  "recorded",
  "validated",
  "disputed",
  "superseded",
  "rejected",
]);

/* ------------------------------------------------------------------ */
/* 1 · METERS                                                          */
/* ------------------------------------------------------------------ */

export const utilityMeters = pgTable(
  "utility_meters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** The number printed on the meter. */
    serialNumber: varchar("serial_number", { length: 120 }).notNull(),
    kind: meterKindEnum("kind").notNull(),
    status: meterStatusEnum("status").default("active").notNull(),

    /** Whose consumption this is. */
    consumerContactId: uuid("consumer_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),

    /** Where it is. A flat, a site, a feeder, a rooftop. */
    location: varchar("location", { length: 300 }),
    connectionRef: varchar("connection_ref", { length: 120 }),

    /**
     * ⭐ HOW MANY DIGITS THE DIAL HAS.
     *
     * ⚠️ THIS IS WHAT MAKES ROLLOVER SURVIVABLE. A 5-digit meter wraps at
     * 100000; one that reads 00042 after 99999 consumed 43 units. Without
     * the digit count the only options are to reject a legitimate reading
     * or to issue a credit note for a year of free supply.
     */
    digitCount: integer("digit_count").default(6).notNull(),

    /** Multiplier for meters that read in thousands. Usually 1. */
    multiplier: numeric("multiplier", { precision: 12, scale: 4 })
      .default("1")
      .notNull(),

    unit: varchar("unit", { length: 20 }).default("kWh").notNull(),

    /** Which rate card prices this meter's consumption. */
    rateCardId: uuid("rate_card_id").references(() => rateCards.id, {
      onDelete: "set null",
    }),

    installedOn: date("installed_on"),
    /** Reading at installation. Consumption never counts below this. */
    initialReading: numeric("initial_reading", { precision: 18, scale: 4 })
      .default("0")
      .notNull(),

    /**
     * ⭐ Set when this meter replaced another.
     *
     * ⚠️ A REPLACEMENT IS A NEW ROW, NEVER AN EDIT. The two meters have
     * no arithmetic relationship — the new one starts at zero — so any
     * attempt to subtract across them is nonsense. Pointing at the
     * predecessor keeps the consumer's history readable without ever
     * letting the numbers mix.
     */
    replacesMeterId: uuid("replaces_meter_id"),
    replacedOn: date("replaced_on"),

    /** Net metering: is export credited against import? */
    isNetMetered: boolean("is_net_metered").default(false).notNull(),
    sanctionedLoadKw: numeric("sanctioned_load_kw", { precision: 12, scale: 3 }),

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
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("utility_meters_tenant_idx").on(t.tenantId),
    consumerIdx: index("utility_meters_consumer_idx").on(
      t.tenantId,
      t.consumerContactId,
    ),
    statusIdx: index("utility_meters_status_idx").on(t.tenantId, t.status),
    serialKey: uniqueIndex("utility_meters_serial_key").on(
      t.tenantId,
      t.serialNumber,
    ),
    tenantScoped: uniqueIndex("utility_meters_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    digitsSane: check(
      "utility_meters_digits_sane",
      sql`${t.digitCount} BETWEEN 3 AND 12`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · READINGS — append-only                                          */
/* ------------------------------------------------------------------ */

export const meterReadings = pgTable(
  "meter_readings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    meterId: uuid("meter_id").notNull(),

    readAt: timestamp("read_at", { withTimezone: true }).notNull(),

    /** ⭐ WHAT THE DIAL SAID. Cumulative. Never a consumption figure. */
    readingValue: numeric("reading_value", { precision: 18, scale: 4 }).notNull(),

    source: readingSourceEnum("source").default("manual").notNull(),
    status: readingStatusEnum("status").default("recorded").notNull(),

    /* ---- DERIVED BY TRIGGER — never accepted from a form ---------- */

    previousReadingId: uuid("previous_reading_id"),
    previousValue: numeric("previous_value", { precision: 18, scale: 4 }),

    /** ⭐ The answer. Computed, rollover-aware, multiplier-applied. */
    consumption: numeric("consumption", { precision: 18, scale: 4 }),

    /** Set when the dial wrapped past its maximum. */
    isRollover: boolean("is_rollover").default(false).notNull(),

    /**
     * ⭐ Flagged when consumption departs sharply from this meter's own
     * history.
     *
     * ⚠️ FLAGGED, NOT REJECTED. A 300% jump is theft, a fault, or a typo
     * — and it is also a family that bought an air conditioner in April.
     * Refusing the reading would make an honest bill impossible; not
     * noticing it at all is how meter tampering runs for two years.
     */
    isAnomaly: boolean("is_anomaly").default(false).notNull(),
    anomalyNote: text("anomaly_note"),

    /** Photo evidence, for a disputed reading. */
    documentId: uuid("document_id"),

    readByUserId: uuid("read_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("meter_readings_tenant_idx").on(t.tenantId),
    meterTimeIdx: index("meter_readings_meter_time_idx").on(
      t.tenantId,
      t.meterId,
      t.readAt,
    ),
    anomalyIdx: index("meter_readings_anomaly_idx").on(t.tenantId, t.isAnomaly),
    tenantScoped: uniqueIndex("meter_readings_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    /**
     * ⚠️ ONE READING PER METER PER INSTANT. A double-submitted form
     * otherwise creates a second reading with zero consumption, which
     * silently resets the baseline for everything after it.
     */
    oneAtATime: uniqueIndex("meter_readings_meter_instant_key").on(
      t.meterId,
      t.readAt,
    ),
    valueNonNegative: check(
      "meter_readings_value_non_negative",
      sql`${t.readingValue} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 3 · BILLING PERIODS                                                 */
/* ------------------------------------------------------------------ */

/**
 * One billing cycle for one meter: opening reading, closing reading,
 * units, and what that cost through the slab engine.
 *
 * ⭐ NET METERING LIVES HERE, and it is not a subtraction.
 *
 * ⚠️ Import minus export is the naive answer and it is wrong in India.
 * Surplus export is BANKED — carried to the next period, settled
 * annually, often at a different rate from the import tariff. Netting
 * them within a month silently destroys the bank and under-credits the
 * customer, every month, in the utility's favour. That is the kind of
 * error a regulator notices.
 */
export const meterBillingPeriods = pgTable(
  "meter_billing_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    meterId: uuid("meter_id").notNull(),

    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    label: varchar("label", { length: 60 }).notNull(),

    openingReadingId: uuid("opening_reading_id"),
    closingReadingId: uuid("closing_reading_id"),

    unitsConsumed: numeric("units_consumed", { precision: 18, scale: 4 })
      .default("0")
      .notNull(),
    unitsExported: numeric("units_exported", { precision: 18, scale: 4 })
      .default("0")
      .notNull(),

    /** ⭐ Carried forward, not netted away. See the note above. */
    unitsBankedOpening: numeric("units_banked_opening", {
      precision: 18,
      scale: 4,
    })
      .default("0")
      .notNull(),
    unitsBankedClosing: numeric("units_banked_closing", {
      precision: 18,
      scale: 4,
    })
      .default("0")
      .notNull(),

    rateCardId: uuid("rate_card_id").references(() => rateCards.id, {
      onDelete: "set null",
    }),

    energyChargeMinor: bigint("energy_charge_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    fixedChargeMinor: bigint("fixed_charge_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    dutyMinor: bigint("duty_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    exportCreditMinor: bigint("export_credit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /** True once billed. A billed period is frozen. */
    isFinalised: boolean("is_finalised").default(false).notNull(),
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("meter_billing_periods_tenant_idx").on(t.tenantId),
    meterIdx: index("meter_billing_periods_meter_idx").on(
      t.tenantId,
      t.meterId,
      t.periodStart,
    ),
    onePerPeriod: uniqueIndex("meter_billing_periods_meter_period_key").on(
      t.meterId,
      t.periodStart,
    ),
    tenantScoped: uniqueIndex("meter_billing_periods_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    periodOrdered: check(
      "meter_billing_periods_ordered",
      sql`${t.periodEnd} >= ${t.periodStart}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* CONSTANTS & PURE ARITHMETIC                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ How far a reading may depart from the meter's own recent average
 * before it is flagged.
 *
 * ⚠️ 200% UP, 60% DOWN — ASYMMETRIC ON PURPOSE. A doubling is often
 * seasonal and honest (an air conditioner in April). A collapse to
 * two-fifths of normal is rarely honest — it is a bypassed meter, a
 * stopped dial, or a misread. The thresholds reflect which direction
 * fraud actually travels in.
 */
export const ANOMALY_HIGH_MULTIPLIER = 3.0;
export const ANOMALY_LOW_MULTIPLIER = 0.4;

/** Readings of history to average before judging a new one. */
export const ANOMALY_LOOKBACK = 3;

/**
 * ⭐ Consumption between two readings, rollover-aware.
 *
 * ⚠️ THE ROLLOVER BRANCH IS THE WHOLE FUNCTION. Without it, a 5-digit
 * meter passing 99999 → 00042 produces −99,957 units and a credit note
 * for roughly a year of free supply, issued automatically, to whoever
 * happened to be on that meter.
 */
export function consumptionBetween(
  previous: number,
  current: number,
  digitCount: number,
  multiplier = 1,
): { consumption: number; isRollover: boolean } {
  if (current >= previous) {
    return { consumption: (current - previous) * multiplier, isRollover: false };
  }

  // The dial wrapped. 99999 → 00042 on 5 digits is 43 units, not −99,957.
  const ceiling = Math.pow(10, digitCount);
  return {
    consumption: (ceiling - previous + current) * multiplier,
    isRollover: true,
  };
}

export type MeterKind = (typeof meterKindEnum.enumValues)[number];
export type ReadingSource = (typeof readingSourceEnum.enumValues)[number];

/** Sources that are a measurement rather than a guess. */
export const ACTUAL_READING_SOURCES: readonly ReadingSource[] = [
  "manual",
  "photo",
  "smart_meter",
  "api",
  "customer_submitted",
];

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const utilityMetersRelations = relations(
  utilityMeters,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [utilityMeters.tenantId],
      references: [tenants.id],
    }),
    consumer: one(contacts, {
      fields: [utilityMeters.consumerContactId],
      references: [contacts.id],
    }),
    rateCard: one(rateCards, {
      fields: [utilityMeters.rateCardId],
      references: [rateCards.id],
    }),
    readings: many(meterReadings),
    periods: many(meterBillingPeriods),
  }),
);

export const meterReadingsRelations = relations(meterReadings, ({ one }) => ({
  meter: one(utilityMeters, {
    fields: [meterReadings.meterId],
    references: [utilityMeters.id],
  }),
}));

export const meterBillingPeriodsRelations = relations(
  meterBillingPeriods,
  ({ one }) => ({
    meter: one(utilityMeters, {
      fields: [meterBillingPeriods.meterId],
      references: [utilityMeters.id],
    }),
  }),
);
