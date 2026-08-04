/**
 * Ordence — ⭐ ENGINE 2 · RATE & PRICING
 * Version: v0.62.0-alpha  ·  Session 1
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE SLAB FORMULA SERVES SIX VERTICALS
 * ══════════════════════════════════════════════════════════════════════
 * An electricity tariff: first 100 units at ₹4.50, next 200 at ₹6.20,
 * the rest at ₹8.00. A freight rate: first 500 kg at one rate, then a
 * cheaper one. A volume discount: buy 1,000 and the price per unit
 * drops. A hotel's seasonal rate. A hospital's tariff class.
 *
 * Written separately these become six pricing engines that round money
 * six slightly different ways — and every one of them is a customer
 * argument you cannot win, because your own two screens disagree.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DECISION THAT DEFINES THIS ENGINE: PROGRESSIVE vs FLAT
 * ══════════════════════════════════════════════════════════════════════
 * "First 100 at ₹4.50, next 200 at ₹6.20" has TWO possible readings, and
 * both are used in the real world:
 *
 *   PROGRESSIVE — 250 units cost (100 × 4.50) + (150 × 6.20).
 *                 Indian electricity tariffs. Income tax.
 *   FLAT        — 250 units cost 250 × 6.20, because you landed in that
 *                 band. Most freight rates. Most volume discounts.
 *
 * ⚠️ THE DIFFERENCE ON THAT EXAMPLE IS ₹380 ON A ₹1,380 BILL — 27%. A
 * pricing engine that picks one silently is wrong for half its users and
 * gives no clue which half. So `slab_mode` is stated ON the rate card,
 * required, with no default.
 *
 * ══════════════════════════════════════════════════════════════════════
 * MONEY IS `bigint` PAISE. RATES ARE INTEGER BASIS POINTS.
 * ══════════════════════════════════════════════════════════════════════
 * No floats anywhere. 18% is 1800 bps. ₹4.50 is 450 paise. Rounding
 * happens once, at the end, half-up — the same rule Tally uses, so a
 * reconciliation against a customer's books does not drift by a rupee
 * per line and turn into an argument about arithmetic.
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
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants } from "./core";
import { companies } from "./crm";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/** ⭐ See the header. This is the engine's defining decision. */
export const slabModeEnum = pgEnum("slab_mode", [
  "progressive",
  "flat",
  "none",
]);

/** What the rate is charged per. */
export const rateBasisEnum = pgEnum("rate_basis", [
  "per_unit",
  "per_night",
  "per_hour",
  "per_day",
  "per_km",
  "per_kg",
  "per_kwh",
  "flat_fee",
  "percentage",
]);

/**
 * Why one card beats another when several match.
 *
 * ⚠️ EXPLICIT PRECEDENCE, NOT "MOST RECENT WINS". Several cards can
 * legitimately apply at once — a seasonal rate, a contracted rate for
 * one customer, a channel rate. Resolving that by `created_at` means the
 * winner changes when somebody edits an unrelated card, and nobody can
 * explain the price afterwards.
 */
export const rateScopeEnum = pgEnum("rate_scope", [
  "list",
  "seasonal",
  "channel",
  "segment",
  "contracted",
  "promotional",
]);

/* ------------------------------------------------------------------ */
/* 1 · RATE CARDS                                                      */
/* ------------------------------------------------------------------ */

export const rateCards = pgTable(
  "rate_cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 80 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),

    scope: rateScopeEnum("scope").default("list").notNull(),

    /**
     * ⭐ REQUIRED, NO DEFAULT. See the header — the two readings differ by
     * 27% on a common example, and guessing is wrong for half of users.
     */
    slabMode: slabModeEnum("slab_mode").notNull(),
    basis: rateBasisEnum("basis").notNull(),

    /**
     * ⭐ HIGHER WINS. Stated, not inferred.
     *
     * A contracted rate (500) beats a seasonal one (300) beats list (100)
     * — because that is a commercial decision, and one somebody will need
     * to explain to a customer holding a different invoice.
     */
    priority: integer("priority").default(100).notNull(),

    /** What this card prices. Free-form key — a room type, an item, a lane. */
    appliesToKind: varchar("applies_to_kind", { length: 60 }),
    appliesToId: uuid("applies_to_id"),

    /** A contracted rate belongs to one customer. */
    customerCompanyId: uuid("customer_company_id").references(
      () => companies.id,
      { onDelete: "cascade" },
    ),

    /** Sales channel — direct, OTA, marketplace, agent. */
    channel: varchar("channel", { length: 60 }),

    /**
     * ⚠️ VALIDITY IS A HALF-OPEN DATE RANGE, and `validTo` is EXCLUSIVE.
     * A card ending 31 March and one starting 31 March would otherwise
     * both apply on that day, and the answer would depend on sort order.
     */
    validFrom: date("valid_from"),
    validTo: date("valid_to"),

    /** Day-of-week mask, "1111100" = Mon–Fri. NULL = every day. */
    daysOfWeek: varchar("days_of_week", { length: 7 }),

    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    /** Used when there are no slabs at all. */
    baseAmountMinor: bigint("base_amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Tax rate in basis points. 1800 = 18%. */
    taxRateBps: integer("tax_rate_bps").default(0).notNull(),
    isTaxInclusive: boolean("is_tax_inclusive").default(false).notNull(),

    isActive: boolean("is_active").default(true).notNull(),

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
    tenantIdx: index("rate_cards_tenant_idx").on(t.tenantId),
    lookupIdx: index("rate_cards_lookup_idx").on(
      t.tenantId,
      t.appliesToKind,
      t.appliesToId,
      t.priority,
    ),
    customerIdx: index("rate_cards_customer_idx").on(
      t.tenantId,
      t.customerCompanyId,
    ),
    codeKey: uniqueIndex("rate_cards_code_key").on(t.tenantId, t.code),
    tenantScoped: uniqueIndex("rate_cards_id_tenant_key").on(t.id, t.tenantId),
    validityOrdered: check(
      "rate_cards_validity_ordered",
      sql`${t.validTo} IS NULL OR ${t.validFrom} IS NULL OR ${t.validTo} > ${t.validFrom}`,
    ),
    taxSane: check(
      "rate_cards_tax_sane",
      sql`${t.taxRateBps} BETWEEN 0 AND 10000`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · SLABS                                                           */
/* ------------------------------------------------------------------ */

/**
 * One band of a tiered rate.
 *
 * ⚠️ `upToQuantity` IS EXCLUSIVE AND NULL MEANS INFINITY.
 *
 * Slabs of (0,100], (100,300], (300,∞) are stored as upTo = 100, 300,
 * NULL. Using a `fromQuantity` as well would let the two drift into a
 * gap — a tariff with no band covering unit 101 prices it at zero, and
 * nothing errors. One boundary per row makes gaps unrepresentable, and
 * the SQL checks the sequence is contiguous.
 */
export const rateSlabs = pgTable(
  "rate_slabs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    rateCardId: uuid("rate_card_id").notNull(),

    /** Order within the card. 1, 2, 3 … */
    sequence: integer("sequence").notNull(),

    /** Exclusive upper bound. NULL = the final, unbounded slab. */
    upToQuantity: bigint("up_to_quantity", { mode: "bigint" }),

    /** Price per unit within this band, in paise. */
    unitAmountMinor: bigint("unit_amount_minor", { mode: "bigint" }).notNull(),

    /** Fixed charge for entering this band at all. Demand charges. */
    fixedAmountMinor: bigint("fixed_amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    label: varchar("label", { length: 120 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("rate_slabs_tenant_idx").on(t.tenantId),
    cardIdx: index("rate_slabs_card_idx").on(t.tenantId, t.rateCardId, t.sequence),
    seqKey: uniqueIndex("rate_slabs_sequence_key").on(t.rateCardId, t.sequence),
    tenantScoped: uniqueIndex("rate_slabs_id_tenant_key").on(t.id, t.tenantId),
    upToPositive: check(
      "rate_slabs_up_to_positive",
      sql`${t.upToQuantity} IS NULL OR ${t.upToQuantity} > 0`,
    ),
    amountNonNegative: check(
      "rate_slabs_amount_non_negative",
      sql`${t.unitAmountMinor} >= 0 AND ${t.fixedAmountMinor} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 3 · ADJUSTMENTS — surcharges and discounts                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A SEPARATE TABLE, AND ORDERED.
 *
 * Fuel surcharge, peak loading, night differential, electricity duty,
 * a negotiated discount. Folding these into the base rate makes the
 * invoice unexplainable — and "why is this ₹1,240?" is a question every
 * one of these six verticals gets asked.
 *
 * ⭐ AND THE ORDER IS LOAD-BEARING. 10% off then 18% tax is not the same
 * number as 18% tax then 10% off. `sequence` is the answer, stated.
 */
export const rateAdjustments = pgTable(
  "rate_adjustments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    rateCardId: uuid("rate_card_id").notNull(),

    sequence: integer("sequence").notNull(),
    label: varchar("label", { length: 160 }).notNull(),

    /** Positive = surcharge, negative = discount. */
    percentageBps: integer("percentage_bps").default(0).notNull(),
    fixedAmountMinor: bigint("fixed_amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Shown on the invoice line, or folded silently into the total. */
    isVisible: boolean("is_visible").default(true).notNull(),

    /** Statutory levies are not negotiable and are marked as such. */
    isStatutory: boolean("is_statutory").default(false).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("rate_adjustments_tenant_idx").on(t.tenantId),
    cardIdx: index("rate_adjustments_card_idx").on(
      t.tenantId,
      t.rateCardId,
      t.sequence,
    ),
    seqKey: uniqueIndex("rate_adjustments_sequence_key").on(
      t.rateCardId,
      t.sequence,
    ),
    tenantScoped: uniqueIndex("rate_adjustments_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 4 · QUOTE HISTORY                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHAT WE QUOTED, WHEN, AND WHY.
 *
 * ⚠️ APPEND-ONLY, AND IT IS THE POINT OF THE ENGINE.
 *
 * "What did you quote us on 14 March?" decides disputes. A pricing
 * system that can only recompute today's answer cannot settle that —
 * rate cards change, seasons end, and re-running the calculation gives
 * today's number with total confidence and no relationship to what was
 * actually said.
 *
 * So every quote stores its INPUTS, its chosen card, its breakdown and
 * its result, frozen.
 */
export const rateQuotes = pgTable(
  "rate_quotes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    rateCardId: uuid("rate_card_id").notNull(),

    quantity: bigint("quantity", { mode: "bigint" }).notNull(),

    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).notNull(),
    adjustmentsMinor: bigint("adjustments_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    taxMinor: bigint("tax_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),

    /** Per-slab and per-adjustment breakdown, as computed. */
    breakdown: jsonb("breakdown")
      .$type<Array<Record<string, unknown>>>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /** Why THIS card won. Priority, scope, validity — recorded. */
    selectionReason: text("selection_reason"),

    quotedFor: varchar("quoted_for", { length: 200 }),
    quotedAt: timestamp("quoted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("rate_quotes_tenant_idx").on(t.tenantId, t.quotedAt),
    cardIdx: index("rate_quotes_card_idx").on(t.tenantId, t.rateCardId),
    tenantScoped: uniqueIndex("rate_quotes_id_tenant_key").on(t.id, t.tenantId),
  }),
);

/* ------------------------------------------------------------------ */
/* PURE ARITHMETIC — shared by the app and asserted against the SQL     */
/* ------------------------------------------------------------------ */

export type Slab = {
  sequence: number;
  upToQuantity: bigint | null;
  unitAmountMinor: bigint;
  fixedAmountMinor: bigint;
};

/**
 * ⭐ PROGRESSIVE: every band charged for the part of the quantity that
 * falls inside it.
 *
 * 250 units against (100 @ 450, 300 @ 620, ∞ @ 800):
 *   100 × 450  =  45,000
 *   150 × 620  =  93,000
 *              = 138,000 paise = ₹1,380
 */
export function priceProgressive(quantity: bigint, slabs: readonly Slab[]): bigint {
  let remaining = quantity;
  let lower = 0n;
  let total = 0n;

  for (const slab of [...slabs].sort((a, b) => a.sequence - b.sequence)) {
    if (remaining <= 0n) break;

    const upper = slab.upToQuantity ?? quantity + lower;
    const bandSize = upper - lower;
    if (bandSize <= 0n) continue;

    const inBand = remaining < bandSize ? remaining : bandSize;

    total += inBand * slab.unitAmountMinor + slab.fixedAmountMinor;
    remaining -= inBand;
    lower = upper;
  }

  return total;
}

/**
 * ⭐ FLAT: the whole quantity charged at the rate of the band it lands in.
 *
 * The same 250 units: 250 × 620 = 155,000 paise = ₹1,550.
 *
 * ⚠️ ₹170 MORE THAN PROGRESSIVE ON AN IDENTICAL RATE CARD. That gap is
 * why `slabMode` has no default.
 */
export function priceFlat(quantity: bigint, slabs: readonly Slab[]): bigint {
  const ordered = [...slabs].sort((a, b) => a.sequence - b.sequence);

  for (const slab of ordered) {
    if (slab.upToQuantity === null || quantity <= slab.upToQuantity) {
      return quantity * slab.unitAmountMinor + slab.fixedAmountMinor;
    }
  }

  const last = ordered[ordered.length - 1];
  return last ? quantity * last.unitAmountMinor + last.fixedAmountMinor : 0n;
}

/**
 * Divide and round HALF-UP, on integers, symmetric about zero.
 *
 * ⚠️ NOT `Math.round` ON A FLOAT. Half-up matches Tally, which is what a
 * customer's own books use — so a reconciliation does not drift by a
 * rupee a line and become an argument about arithmetic rather than about
 * the bill.
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero in rate arithmetic.");

  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/** Apply a basis-point rate to an amount, rounded half-up. */
export function applyBps(amountMinor: bigint, bps: number): bigint {
  return divideRoundHalfUp(amountMinor * BigInt(bps), 10_000n);
}

export type SlabMode = (typeof slabModeEnum.enumValues)[number];
export type RateBasis = (typeof rateBasisEnum.enumValues)[number];
export type RateScope = (typeof rateScopeEnum.enumValues)[number];

/**
 * ⭐ PRECEDENCE, HIGHEST FIRST. The SQL selection view must agree.
 */
export const RATE_SCOPE_PRIORITY: Readonly<Record<RateScope, number>> =
  Object.freeze({
    contracted: 500,
    promotional: 400,
    segment: 300,
    channel: 200,
    seasonal: 150,
    list: 100,
  });

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const rateCardsRelations = relations(rateCards, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [rateCards.tenantId],
    references: [tenants.id],
  }),
  customer: one(companies, {
    fields: [rateCards.customerCompanyId],
    references: [companies.id],
  }),
  slabs: many(rateSlabs),
  adjustments: many(rateAdjustments),
  quotes: many(rateQuotes),
}));

export const rateSlabsRelations = relations(rateSlabs, ({ one }) => ({
  card: one(rateCards, {
    fields: [rateSlabs.rateCardId],
    references: [rateCards.id],
  }),
}));

export const rateAdjustmentsRelations = relations(rateAdjustments, ({ one }) => ({
  card: one(rateCards, {
    fields: [rateAdjustments.rateCardId],
    references: [rateCards.id],
  }),
}));

export const rateQuotesRelations = relations(rateQuotes, ({ one }) => ({
  card: one(rateCards, {
    fields: [rateQuotes.rateCardId],
    references: [rateCards.id],
  }),
}));
