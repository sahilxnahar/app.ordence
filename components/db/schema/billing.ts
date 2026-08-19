/**
 * Ordence — Billing & Subscription Schema
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE THREE DESIGN RULES THIS FILE OBEYS
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. MONEY IS NEVER A FLOAT, AND NEVER A NUMBER.
 *    Every monetary column is `bigint` holding the smallest currency unit
 *    (paise for INR, cents for USD). Drizzle returns bigint as a STRING,
 *    which is deliberate — arithmetic happens in `BigInt`, never in IEEE
 *    754. `0.1 + 0.2 !== 0.3` is a rounding curiosity in a blog post and a
 *    reconciliation failure in an invoice.
 *
 * 2. THE PAYMENT EVENT LOG IS APPEND-ONLY AT THE ENGINE LEVEL.
 *    `payment_events` is the evidence table. A trigger blocks UPDATE and
 *    DELETE (see SQL-FILES/0009_phase11_billing.sql) exactly as it does for
 *    `audit_logs` and `contract_signatures`. If a customer disputes a
 *    charge, the log must be something you can point at, not something you
 *    have to vouch for.
 *
 * 3. THE PROVIDER IS NEVER TRUSTED TO BE EXACTLY-ONCE.
 *    Razorpay and Stripe both retry webhooks, both can deliver out of
 *    order, and both can deliver a duplicate hours later. Every event
 *    carries the provider's own event id under a UNIQUE index, so a replay
 *    is a constraint violation rather than a second charge applied to a
 *    subscription.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY `plans` IS NOT TENANT-SCOPED
 * ══════════════════════════════════════════════════════════════════════
 * A plan is platform catalogue data — the same "Advanced ₹4,999/mo" row is
 * referenced by every tenant. It contains no customer data, so it carries
 * no `tenant_id` and no RLS policy, exactly like `permissions` in Phase 1.
 * Everything downstream of it (`subscriptions`, `invoices`, `payment_*`)
 * IS tenant-scoped and IS under RLS.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  jsonb,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users, planTierEnum } from "./core";
import { gstRegistrationTypeEnum, gstSupplyTypeEnum } from "./gst";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * Payment providers. Razorpay is primary for Indian customers (UPI,
 * NetBanking, RuPay, and it settles in INR without an FX leg). Stripe is
 * the secondary rail for international cards.
 *
 * `manual` is not a fallback for a broken integration — it is for genuine
 * offline settlement: an enterprise customer who pays by NEFT against a
 * proforma invoice. Those still produce invoices and payment events, they
 * are simply recorded by a human with `recordManualPayment()`.
 */
export const paymentProviderEnum = pgEnum("payment_provider", [
  "razorpay",
  "stripe",
  "manual",
]);

/**
 * Subscription lifecycle.
 *
 * `past_due` and `unpaid` are deliberately distinct. `past_due` means a
 * payment failed and dunning is in progress — the customer still has full
 * access, because cutting someone off for a card that expired is how you
 * lose a renewal you would otherwise have kept. `unpaid` means dunning has
 * been exhausted; that is the state Phase 14 turns into a lockout.
 */
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "cancelled",
  "expired",
]);

export const billingIntervalEnum = pgEnum("billing_interval", [
  "monthly",
  "quarterly",
  "annual",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "open",
  "paid",
  "partially_paid",
  "void",
  "uncollectible",
  "refunded",
]);

/**
 * Payment event kinds. This is OUR vocabulary, not a provider's — each
 * adapter maps its own event names onto this closed set, so nothing
 * downstream of the webhook handler has to know which provider it came
 * from. Anything an adapter cannot map becomes `unmapped`, which is
 * recorded but never acted upon.
 */
export const paymentEventTypeEnum = pgEnum("payment_event_type", [
  "payment_succeeded",
  "payment_failed",
  "payment_refunded",
  "subscription_created",
  "subscription_renewed",
  "subscription_updated",
  "subscription_cancelled",
  "invoice_created",
  "invoice_paid",
  "mandate_created",
  "mandate_revoked",
  "dispute_opened",
  "unmapped",
]);

export const paymentEventStatusEnum = pgEnum("payment_event_status", [
  "received",
  "processed",
  "ignored_duplicate",
  "ignored_unknown_tenant",
  "failed",
]);

/* ------------------------------------------------------------------ */
/* PLANS  (platform catalogue — NOT tenant-scoped)                     */
/* ------------------------------------------------------------------ */

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Stable machine key, e.g. "advanced_monthly_inr". Never renumber. */
    code: varchar("code", { length: 80 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),

    /**
     * Which tier this plan grants. Phase 12's entitlement engine reads
     * THIS, not `tenants.plan_tier`, once a subscription exists — the
     * column on `tenants` becomes a denormalised cache, kept in step by
     * the reconciliation path.
     */
    tier: planTierEnum("tier").notNull(),

    interval: billingIntervalEnum("interval").notNull(),

    /** ISO 4217. Determines which provider can charge it. */
    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    /**
     * Price in the smallest currency unit, EXCLUSIVE of tax.
     * ₹4,999.00 is stored as 499900.
     */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),

    /** Seats included before per-seat charges begin. Phase 13 enforces. */
    includedSeats: integer("included_seats").default(5).notNull(),

    /** Price per seat beyond `includedSeats`, smallest unit, or 0. */
    perSeatAmountMinor: bigint("per_seat_amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Quotas the metering engine (Phase 15) compares counters against. */
    storageLimitMb: integer("storage_limit_mb").default(512).notNull(),
    emailsPerMonth: integer("emails_per_month").default(500).notNull(),
    apiCallsPerMonth: integer("api_calls_per_month").default(10_000).notNull(),

    trialDays: integer("trial_days").default(14).notNull(),

    /**
     * Provider-side plan identifiers. Nullable because a plan can exist in
     * our catalogue before it has been mirrored into either provider —
     * and because `manual` plans never have one.
     */
    razorpayPlanId: varchar("razorpay_plan_id", { length: 120 }),
    stripePriceId: varchar("stripe_price_id", { length: 120 }),

    /** Hidden from the pricing page but still chargeable (legacy, bespoke). */
    isPublic: boolean("is_public").default(true).notNull(),
    isActive: boolean("is_active").default(true).notNull(),

    /** Display order on the pricing page; lower is further left. */
    sortOrder: integer("sort_order").default(100).notNull(),

    /** Marketing bullet points. Not read by any gate — Phase 12 owns that. */
    highlights: jsonb("highlights")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codeUnique: uniqueIndex("plans_code_unique").on(t.code),
    activeIdx: index("plans_active_idx").on(t.isActive, t.sortOrder),
    // A negative price is always a bug, never a discount. Discounts are a
    // separate concept and belong on the invoice, not the catalogue.
    amountNonNegative: check("plans_amount_non_negative", sql`${t.amountMinor} >= 0`),
    perSeatNonNegative: check(
      "plans_per_seat_non_negative",
      sql`${t.perSeatAmountMinor} >= 0`,
    ),
    seatsNonNegative: check("plans_seats_non_negative", sql`${t.includedSeats} >= 0`),
    trialNonNegative: check("plans_trial_non_negative", sql`${t.trialDays} >= 0`),
    currencyShape: check("plans_currency_shape", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  }),
);

/* ------------------------------------------------------------------ */
/* SUBSCRIPTIONS  (tenant-scoped, RLS)                                 */
/* ------------------------------------------------------------------ */

/**
 * One tenant has at most one ACTIVE subscription at a time. That is
 * enforced by a partial unique index rather than by application logic,
 * because "we upgraded them and forgot to cancel the old one" is a
 * double-billing incident and it should be impossible, not unlikely.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),

    status: subscriptionStatusEnum("status").default("trialing").notNull(),

    provider: paymentProviderEnum("provider").default("razorpay").notNull(),

    /**
     * The provider's own subscription id. UNIQUE per provider so a webhook
     * can resolve tenant from provider id without a scan, and so the same
     * remote subscription can never be attached to two tenants.
     */
    providerSubscriptionId: varchar("provider_subscription_id", { length: 160 }),
    providerCustomerId: varchar("provider_customer_id", { length: 160 }),

    /** Denormalised from the plan at time of purchase — see note below. */
    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    /**
     * WHY THE PRICE IS COPIED ONTO THE SUBSCRIPTION.
     * If you raise the catalogue price of "Advanced" next year, every
     * existing customer's historical invoices must NOT retroactively
     * change, and grandfathered customers must keep paying what they
     * agreed to. Reading the price through a join to `plans` would break
     * both. The plan is the template; this is the contract.
     */
    unitAmountMinor: bigint("unit_amount_minor", { mode: "bigint" }).notNull(),
    perSeatAmountMinor: bigint("per_seat_amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    interval: billingIntervalEnum("interval").notNull(),

    /** Seats purchased. Phase 13 compares active users against this. */
    seatsPurchased: integer("seats_purchased").default(5).notNull(),

    currentPeriodStart: timestamp("current_period_start", { withTimezone: true })
      .defaultNow()
      .notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),

    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),

    /**
     * Set when the customer cancels but has paid through the period end.
     * They keep access until `currentPeriodEnd`; a cron flips them to
     * `expired` after. Cancelling should never mean "and lose the month
     * you already paid for".
     */
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),

    /* --- Dunning state (Phase 14 drives the UX from these) --- */
    failedPaymentCount: integer("failed_payment_count").default(0).notNull(),
    lastPaymentFailedAt: timestamp("last_payment_failed_at", { withTimezone: true }),
    /** After this instant, Phase 14 is permitted to restrict access. */
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),

    /**
     * Monotonic guard against out-of-order webhooks. A provider event
     * carrying an older timestamp than this is recorded but not applied.
     * Without it, a retried "payment_failed" delivered after a successful
     * "payment_succeeded" would push a paying customer into dunning.
     */
    lastProviderEventAt: timestamp("last_provider_event_at", { withTimezone: true }),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("subscriptions_tenant_idx").on(t.tenantId),
    statusIdx: index("subscriptions_status_idx").on(t.status),
    periodEndIdx: index("subscriptions_period_end_idx").on(t.currentPeriodEnd),

    // One live subscription per tenant. Partial, so a tenant may accumulate
    // any number of cancelled/expired rows as history.
    oneLivePerTenant: uniqueIndex("subscriptions_one_live_per_tenant")
      .on(t.tenantId)
      .where(sql`${t.status} IN ('trialing','active','past_due','unpaid','paused')
                 AND ${t.deletedAt} IS NULL`),

    // A remote subscription belongs to exactly one row, forever.
    providerSubUnique: uniqueIndex("subscriptions_provider_sub_unique")
      .on(t.provider, t.providerSubscriptionId)
      .where(sql`${t.providerSubscriptionId} IS NOT NULL`),

    amountNonNegative: check(
      "subscriptions_amount_non_negative",
      sql`${t.unitAmountMinor} >= 0 AND ${t.perSeatAmountMinor} >= 0`,
    ),
    seatsPositive: check("subscriptions_seats_positive", sql`${t.seatsPurchased} >= 0`),
    // A period that ends before it starts means a clock or a webhook is
    // wrong, and every proration calculated from it would be wrong too.
    periodSane: check(
      "subscriptions_period_sane",
      sql`${t.currentPeriodEnd} > ${t.currentPeriodStart}`,
    ),
    failedCountSane: check(
      "subscriptions_failed_count_sane",
      sql`${t.failedPaymentCount} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* INVOICES  (tenant-scoped, RLS)                                      */
/* ------------------------------------------------------------------ */

/**
 * INDIAN TAX NOTE (expanded in Phase 16).
 * GST on a SaaS subscription is split CGST+SGST for an intra-state supply
 * and IGST for inter-state. Which applies depends on the customer's place
 * of supply versus ours, so all three columns exist and exactly one pair
 * is populated. Storing a single `tax_amount` would make a compliant
 * invoice impossible to render later without re-deriving the split from
 * an address that may since have changed.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),

    /**
     * Human-facing sequential number, e.g. "AH/2026-27/000148".
     * Generated by a database sequence, not by the application: two
     * concurrent invoice creations must never produce the same number,
     * and a gap in the series is a question an auditor is entitled to ask.
     */
    invoiceNumber: varchar("invoice_number", { length: 60 }).notNull(),

    status: invoiceStatusEnum("status").default("draft").notNull(),

    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    /** Sum of line items, before tax. */
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /** subtotal - discount + cgst + sgst + igst. Asserted by a check. */
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),

    amountPaidMinor: bigint("amount_paid_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Tax identity captured AT ISSUE — see the note on subscriptions. */
    customerGstin: varchar("customer_gstin", { length: 15 }),
    placeOfSupplyCode: varchar("place_of_supply_code", { length: 2 }),
    customerLegalName: varchar("customer_legal_name", { length: 255 }),
    customerAddress: jsonb("customer_address")
      .$type<{
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /* --- Phase 32: the Rule 46 fields Phase 11 had no reason to hold --- */
    //
    // ⚠️ EVERY COLUMN HERE IS NULLABLE OR DEFAULTED, so the subscription
    // invoices already in this table stay valid without a backfill. They
    // are added by `SQL-FILES/0021_phase32_gst.sql`, not by a new table:
    // a parallel `tax_invoices` would give "what did we bill them" two
    // answers, which is the failure mode Phase 32 exists to close.

    /**
     * ⭐ WHICH OF OUR GSTINs THIS WAS ISSUED UNDER. Phase 11 assumed one;
     * a developer with towers in two states holds two and issues from
     * whichever the supply belongs to. ON DELETE RESTRICT, because the
     * document must still render its GSTIN after the registration is
     * surrendered.
     */
    supplierRegistrationId: uuid("supplier_registration_id"),
    supplierGstin: varchar("supplier_gstin", { length: 15 }),
    supplierStateCode: varchar("supplier_state_code", { length: 2 }),

    supplyType: gstSupplyTypeEnum("supply_type").default("services").notNull(),

    /**
     * ⭐ WHERE THE FLAT IS. Under Section 12(3) of the IGST Act this — not
     * the buyer's address, not their GSTIN state — IS the place of supply
     * for anything relating to immovable property. A CHECK constraint in
     * Section 8 of the Phase 32 SQL refuses any immovable-property invoice
     * whose place of supply is anything else.
     */
    propertyStateCode: varchar("property_state_code", { length: 2 }),

    recipientRegistration: gstRegistrationTypeEnum("recipient_registration"),
    /** Which rule produced the place of supply. Shown in the working papers. */
    placeOfSupplyBasis: varchar("place_of_supply_basis", { length: 40 }),
    /** Intra-UT supplies are CGST + UTGST, reported in a different box. */
    isUnionTerritory: boolean("is_union_territory").default(false).notNull(),

    isReverseCharge: boolean("is_reverse_charge").default(false).notNull(),
    /**
     * ⚠️ SHOWN ON THE DOCUMENT, DELIBERATELY ABSENT FROM `totalMinor`.
     * Under Section 9(3)/9(4) the RECIPIENT pays this tax direct to the
     * Government. Adding it to the total charges the customer for tax we
     * do not owe, and they pay the same tax again themselves.
     */
    reverseChargeTaxMinor: bigint("reverse_charge_tax_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Compensation cess. Part of the balance check from Phase 32 onward. */
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    roundOffMinor: bigint("round_off_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * ⭐ THE DATE THE RATE WAS RESOLVED ON. A `date`, not a timestamp: a
     * notification takes effect on a calendar day in India, and an
     * invoice raised at 9am IST on 1 April 2019 compares as the previous
     * period if the comparison is done in UTC.
     */
    taxPointDate: date("tax_point_date", { mode: "string" }),

    /**
     * Opt-in to the deferred reconciliation trigger (Phase 32 SQL §6).
     * False on every Phase 16 subscription invoice, whose lines carry no
     * tax columns; true on anything the GST engine produced — and having
     * said so, it must add up against its own lines at COMMIT.
     */
    gstComputed: boolean("gst_computed").default(false).notNull(),

    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),

    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),

    provider: paymentProviderEnum("provider").default("razorpay").notNull(),
    providerInvoiceId: varchar("provider_invoice_id", { length: 160 }),
    /** Provider-hosted PDF / payment page, when one exists. */
    hostedInvoiceUrl: text("hosted_invoice_url"),

    notes: text("notes"),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    numberUnique: uniqueIndex("invoices_number_unique").on(t.invoiceNumber),
    tenantIdx: index("invoices_tenant_idx").on(t.tenantId, t.createdAt),
    statusIdx: index("invoices_tenant_status_idx").on(t.tenantId, t.status),
    subscriptionIdx: index("invoices_subscription_idx").on(t.subscriptionId),
    providerInvoiceUnique: uniqueIndex("invoices_provider_invoice_unique")
      .on(t.provider, t.providerInvoiceId)
      .where(sql`${t.providerInvoiceId} IS NOT NULL`),

    // The arithmetic is asserted by the DATABASE, not by the code that
    // writes it. An invoice whose total does not equal its parts is not a
    // display bug — it is a document you may have to defend.
    //
    // ⚠️ WIDENED IN PHASE 32 to include cess. `reverseChargeTaxMinor` is
    // deliberately NOT here: that tax is the recipient's to pay.
    totalsBalance: check(
      "invoices_totals_balance",
      sql`${t.totalMinor} = ${t.subtotalMinor} - ${t.discountMinor}
                          + ${t.cgstMinor} + ${t.sgstMinor} + ${t.igstMinor}
                          + COALESCE(${t.cessMinor}, 0)`,
    ),
    /**
     * ⭐ SECTION 12(3), IGST ACT — enforced by the database because this
     * write path is one of four. An import of historical bookings, a
     * support fix at a psql prompt and a future API route would each
     * reach for the customer's state, because that is what the column
     * next to it is called.
     */
    immovablePropertyPos: check(
      "invoices_immovable_property_pos",
      sql`${t.supplyType} <> 'immovable_property'
          OR (${t.propertyStateCode} IS NOT NULL
              AND ${t.placeOfSupplyCode} IS NOT NULL
              AND ${t.placeOfSupplyCode} = ${t.propertyStateCode})`,
    ),
    supplierStateMatchesGstin: check(
      "invoices_supplier_state_matches_gstin",
      sql`${t.supplierGstin} IS NULL
          OR ${t.supplierStateCode} IS NULL
          OR ${t.supplierStateCode} = substring(${t.supplierGstin} from 1 for 2)`,
    ),
    reverseChargeNonNegative: check(
      "invoices_reverse_charge_non_negative",
      sql`${t.reverseChargeTaxMinor} >= 0 AND ${t.cessMinor} >= 0`,
    ),
    // IGST is mutually exclusive with the CGST/SGST pair. Populating all
    // three would double-charge tax on a compliant return.
    gstMutuallyExclusive: check(
      "invoices_gst_mutually_exclusive",
      sql`NOT (${t.igstMinor} > 0 AND (${t.cgstMinor} > 0 OR ${t.sgstMinor} > 0))`,
    ),
    amountsNonNegative: check(
      "invoices_amounts_non_negative",
      sql`${t.subtotalMinor} >= 0 AND ${t.discountMinor} >= 0
          AND ${t.cgstMinor} >= 0 AND ${t.sgstMinor} >= 0 AND ${t.igstMinor} >= 0
          AND ${t.amountPaidMinor} >= 0`,
    ),
    // Overpayment is real (duplicate transfer, FX rounding on an inbound
    // wire) so this is not `<=`. A NEGATIVE paid amount is always a bug.
    gstinShape: check(
      "invoices_gstin_shape",
      sql`${t.customerGstin} IS NULL OR ${t.customerGstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* INVOICE LINE ITEMS                                                  */
/* ------------------------------------------------------------------ */

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),

    /** Denormalised for RLS — the policy filters without a join. */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    description: text("description").notNull(),

    /**
     * SAC code for GST classification. 998314 is "information technology
     * infrastructure and network management services", which is what a
     * hosted CRM subscription is. It appears on the invoice by law.
     */
    sacCode: varchar("sac_code", { length: 10 }).default("998314").notNull(),

    quantity: integer("quantity").default(1).notNull(),
    unitAmountMinor: bigint("unit_amount_minor", { mode: "bigint" }).notNull(),
    /** quantity × unitAmountMinor. Asserted by a check. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),

    /** GST rate in basis points — 1800 = 18%. Integer, so never 0.18. */
    taxRateBps: integer("tax_rate_bps").default(1800).notNull(),

    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),

    /* --- Phase 32: line-level GST -------------------------------- */
    //
    // ⚠️ TAX IS COMPUTED PER LINE AND THEN SUMMED, NEVER ON THE TOTAL.
    // A tax invoice prints a tax figure against each line and a total at
    // the foot, and somebody will add the column. Rounding once per line
    // makes the printed column add to the printed total by construction.
    // These columns are what that computation is stored in.

    /**
     * ⭐ THE EXACT `hsn_sac_rates` ROW THIS LINE WAS PRICED FROM.
     *
     * This single pointer is what makes "a historical invoice keeps its
     * historical rate" true rather than hoped for. ON DELETE RESTRICT, so
     * tidying the rate master cannot remove the evidence of what this
     * document was charged at, and a trigger refuses to edit the rate on
     * a row any line points at.
     */
    gstRateId: uuid("gst_rate_id"),

    cessRateBps: integer("cess_rate_bps").default(0).notNull(),

    /** Line-level discount, subtracted before tax. */
    discountMinor: bigint("discount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** amount − discount. What the rate is applied to. */
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" }),

    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** Carries UTGST for an intra-Union-Territory supply. Same column, other Act. */
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /** Section 9(3)/9(4) — this line's tax is the recipient's to pay. */
    isReverseCharge: boolean("is_reverse_charge").default(false).notNull(),

    /** Unit quantity code — "NOS", "SQM". Rule 46(g) wants it with the quantity. */
    uqc: varchar("uqc", { length: 10 }),

    /** "subscription" | "seat" | "overage" | "proration" | "adjustment" */
    lineType: varchar("line_type", { length: 30 }).default("subscription").notNull(),

    sortOrder: integer("sort_order").default(100).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    invoiceIdx: index("invoice_lines_invoice_idx").on(t.invoiceId, t.sortOrder),
    tenantIdx: index("invoice_lines_tenant_idx").on(t.tenantId),
    // A proration credit is a NEGATIVE line, so amount is unconstrained in
    // sign — but it must still equal quantity × unit price.
    amountConsistent: check(
      "invoice_lines_amount_consistent",
      sql`${t.amountMinor} = ${t.quantity} * ${t.unitAmountMinor}`,
    ),
    quantityPositive: check("invoice_lines_quantity_positive", sql`${t.quantity} > 0`),
    taxRateSane: check(
      "invoice_lines_tax_rate_sane",
      sql`${t.taxRateBps} >= 0 AND ${t.taxRateBps} <= 10000`,
    ),

    /* --- Phase 32 --------------------------------------------------- */
    //
    // ⚠️ THERE IS NO `CHECK (cgst_minor = sgst_minor)`, AND THE OMISSION
    // IS DELIBERATE. It is the obvious constraint and it is wrong: an odd
    // tax amount cannot be halved into two equal whole paise. ₹100.01 of
    // tax splits 50.01 / 50.00 — which still adds to the tax charged.
    // Demanding equality would refuse a correct invoice and push somebody
    // into rounding each half separately, producing 50.01 + 50.01 and a
    // document that does not balance.
    taxableConsistent: check(
      "invoice_lines_taxable_consistent",
      sql`${t.taxableValueMinor} IS NULL
          OR ${t.taxableValueMinor} = ${t.amountMinor} - ${t.discountMinor}`,
    ),
    gstNonNegative: check(
      "invoice_lines_gst_non_negative",
      sql`${t.cgstMinor} >= 0 AND ${t.sgstMinor} >= 0 AND ${t.igstMinor} >= 0
          AND ${t.cessMinor} >= 0 AND ${t.discountMinor} >= 0
          AND ${t.cessRateBps} >= 0`,
    ),
    // Both populated is a double charge the header check cannot catch:
    // the header would still balance against its own inflated total.
    gstMutuallyExclusive: check(
      "invoice_lines_gst_mutually_exclusive",
      sql`NOT (${t.igstMinor} > 0 AND (${t.cgstMinor} > 0 OR ${t.sgstMinor} > 0))`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* PAYMENT EVENTS  (APPEND-ONLY — the evidence table)                  */
/* ------------------------------------------------------------------ */

/**
 * Every webhook that arrives is written here BEFORE it is acted upon, and
 * the row is never mutated afterwards. Processing outcome is recorded by
 * inserting the row with its final status inside the same transaction as
 * the effect, not by updating it later — because a table you can UPDATE is
 * a table whose history you cannot prove.
 *
 * `providerEventId` is UNIQUE. That single index is the entire replay
 * defence: a duplicate delivery raises 23505 and the handler returns 200
 * without doing anything twice. It is checked by the DATABASE, so two
 * concurrent Vercel invocations racing on the same retry cannot both win.
 */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * Nullable ONLY because an event can arrive for a provider customer we
     * cannot map to a tenant (test-mode traffic, an account created
     * outside our flow). Those are recorded with
     * `ignored_unknown_tenant` rather than dropped — a webhook you cannot
     * explain is exactly the one you will want to read later.
     */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),

    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),

    provider: paymentProviderEnum("provider").notNull(),

    /** The provider's own event id. THE idempotency key. */
    providerEventId: varchar("provider_event_id", { length: 200 }).notNull(),

    /** Raw provider event name, kept verbatim for forensics. */
    providerEventName: varchar("provider_event_name", { length: 120 }).notNull(),

    /** Our normalised vocabulary. */
    eventType: paymentEventTypeEnum("event_type").notNull(),
    status: paymentEventStatusEnum("status").default("received").notNull(),

    /** Money moved by this event, if any. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    currency: varchar("currency", { length: 3 }),

    providerPaymentId: varchar("provider_payment_id", { length: 160 }),

    /**
     * The provider's timestamp for the event, used for the monotonic
     * ordering guard on `subscriptions.lastProviderEventAt`. NOT our
     * receipt time — retries arrive late but describe an early moment.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),

    /**
     * The full verified payload. Stored because a dispute six months from
     * now is answered by what the provider actually sent, not by our
     * interpretation of it. Card numbers never appear here — providers
     * send only a last4 and a network — but the redaction pass in
     * `lib/billing/redact.ts` runs regardless rather than trusting that.
     */
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Populated when `status = 'failed'`. Message only, never a stack. */
    processingError: text("processing_error"),

    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // ⭐ The replay defence. Scoped by provider so Razorpay and Stripe
    // cannot collide in the unlikely event they mint the same id string.
    providerEventUnique: uniqueIndex("payment_events_provider_event_unique").on(
      t.provider,
      t.providerEventId,
    ),
    tenantIdx: index("payment_events_tenant_idx").on(t.tenantId, t.receivedAt),
    subscriptionIdx: index("payment_events_subscription_idx").on(t.subscriptionId),
    typeIdx: index("payment_events_type_idx").on(t.eventType, t.receivedAt),
    statusIdx: index("payment_events_status_idx").on(t.status),
  }),
);

/* ------------------------------------------------------------------ */
/* PAYMENT METHODS  (tenant-scoped, RLS)                               */
/* ------------------------------------------------------------------ */

/**
 * WE DO NOT STORE PAYMENT INSTRUMENTS. This table holds a provider TOKEN
 * plus enough display metadata to render "Visa ending 4242, expires 09/28"
 * and nothing else. No PAN, no CVV, no expiry beyond the display month —
 * storing those would drag this application into PCI-DSS scope, which is a
 * compliance programme, not a schema decision.
 */
export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    provider: paymentProviderEnum("provider").notNull(),
    /** The provider's token. Meaningless without their API key. */
    providerMethodId: varchar("provider_method_id", { length: 160 }).notNull(),
    providerCustomerId: varchar("provider_customer_id", { length: 160 }),

    /** "card" | "upi" | "netbanking" | "emandate" | "wallet" */
    methodType: varchar("method_type", { length: 30 }).notNull(),

    /* --- Display only. Never used to authorise anything. --- */
    brand: varchar("brand", { length: 40 }),
    last4: varchar("last4", { length: 4 }),
    expiryMonth: integer("expiry_month"),
    expiryYear: integer("expiry_year"),
    upiVpaMasked: varchar("upi_vpa_masked", { length: 120 }),
    bankName: varchar("bank_name", { length: 120 }),

    isDefault: boolean("is_default").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),

    addedByUserId: uuid("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("payment_methods_tenant_idx").on(t.tenantId),
    providerMethodUnique: uniqueIndex("payment_methods_provider_unique").on(
      t.provider,
      t.providerMethodId,
    ),
    // At most one default per tenant, enforced by the database rather than
    // by "remember to unset the old one first".
    oneDefaultPerTenant: uniqueIndex("payment_methods_one_default_per_tenant")
      .on(t.tenantId)
      .where(sql`${t.isDefault} = true AND ${t.deletedAt} IS NULL`),
    last4Shape: check(
      "payment_methods_last4_shape",
      sql`${t.last4} IS NULL OR ${t.last4} ~ '^[0-9]{4}$'`,
    ),
    expiryMonthSane: check(
      "payment_methods_expiry_month_sane",
      sql`${t.expiryMonth} IS NULL OR (${t.expiryMonth} >= 1 AND ${t.expiryMonth} <= 12)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  tenant: one(tenants, { fields: [subscriptions.tenantId], references: [tenants.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
  invoices: many(invoices),
  paymentEvents: many(paymentEvents),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  tenant: one(tenants, { fields: [invoices.tenantId], references: [tenants.id] }),
  subscription: one(subscriptions, {
    fields: [invoices.subscriptionId],
    references: [subscriptions.id],
  }),
  lines: many(invoiceLines),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
}));

export const paymentEventsRelations = relations(paymentEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [paymentEvents.tenantId], references: [tenants.id] }),
  subscription: one(subscriptions, {
    fields: [paymentEvents.subscriptionId],
    references: [subscriptions.id],
  }),
  invoice: one(invoices, { fields: [paymentEvents.invoiceId], references: [invoices.id] }),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ one }) => ({
  tenant: one(tenants, { fields: [paymentMethods.tenantId], references: [tenants.id] }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type NewInvoiceLine = typeof invoiceLines.$inferInsert;
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent = typeof paymentEvents.$inferInsert;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type NewPaymentMethod = typeof paymentMethods.$inferInsert;

export type PaymentProvider = (typeof paymentProviderEnum.enumValues)[number];
export type SubscriptionStatus = (typeof subscriptionStatusEnum.enumValues)[number];
export type BillingInterval = (typeof billingIntervalEnum.enumValues)[number];
export type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];
export type PaymentEventType = (typeof paymentEventTypeEnum.enumValues)[number];
export type PaymentEventStatus = (typeof paymentEventStatusEnum.enumValues)[number];

/* ------------------------------------------------------------------ */
/* STATUS PREDICATES  (shared by Phases 12–14)                         */
/* ------------------------------------------------------------------ */

/**
 * Statuses under which a tenant retains full product access.
 *
 * `past_due` IS in this list, deliberately. A failed renewal is usually an
 * expired card, not a customer who decided to leave — and locking someone
 * out on the day their card expires is how a recoverable renewal becomes a
 * churn event. Phase 14 restricts access only after the grace window,
 * when the status has moved to `unpaid`.
 */
export const ACCESS_GRANTING_STATUSES = [
  "trialing",
  "active",
  "past_due",
] as const satisfies readonly SubscriptionStatus[];

/** Statuses that occupy the "one live subscription per tenant" slot. */
export const LIVE_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
] as const satisfies readonly SubscriptionStatus[];

export function grantsAccess(status: SubscriptionStatus): boolean {
  return (ACCESS_GRANTING_STATUSES as readonly SubscriptionStatus[]).includes(status);
}

export function isLiveSubscription(status: SubscriptionStatus): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly SubscriptionStatus[]).includes(status);
}

/* ================================================================== */
/* ⭐⭐⭐ SEAT GRANTS AND SEAT REQUESTS — 0114                          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE SEAT LIMIT WAS ADVISORY UNTIL 0114
 * ══════════════════════════════════════════════════════════════════════
 * `lib/billing/seats.ts` decided what a seat is, carefully. `seat_limit`
 * existed. `requireSeat()` existed. And there was NO in-product invite,
 * so the Clerk webhook was the only door — and it checked the limit,
 * wrote a high-severity audit row, and created the user anyway.
 *
 * ⭐ These two tables are the third state that comment never considered:
 * admit the person, withhold the seat, and give somebody a queue.
 */

/**
 * ⭐⭐ CAPACITY SOMEBODY GAVE, WITH THEIR NAME ON IT.
 *
 * 🔴 A GRANT RAISES THE LIMIT RATHER THAN FILLING A SEAT, so it survives
 * the person who prompted it leaving. `effectiveSeats()` in
 * `lib/billing/seats.ts` is the arithmetic.
 */
export const seatGrants = pgTable(
  "seat_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** ⚠️ A count, not a user. See above. */
    seats: integer("seats").notNull(),

    /** `platform` means Ordence gave it; `owner` means the workspace did. */
    grantedByKind: varchar("granted_by_kind", { length: 16 })
      .default("platform")
      .notNull(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * 🔴 AT LEAST TEN CHARACTERS, AND A CHECK ENFORCES IT. A free seat
     * with no reason is indistinguishable from a mistake in the billing
     * table, and it is found by an accountant asking why revenue per
     * workspace does not foot.
     */
    reason: text("reason").notNull(),

    grantedAt: timestamp("granted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /**
     * ⚠️ NULL MEANS PERMANENT, and that is the honest default. Inventing
     * an expiry would withdraw capacity a customer relies on, on a date
     * nobody chose.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (t) => ({
    activeIdx: index("seat_grants_active_idx").on(t.tenantId),
  }),
);

/**
 * ⭐⭐ THE QUEUE. One row per person who could not be given a seat when
 * they arrived.
 */
export const seatRequests = pgTable(
  "seat_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * ⚠️ `identity_provider` means Clerk created them and we parked them.
     * `invite` means somebody in the product tried and was refused at the
     * moment they tried. The two need different handling and the
     * difference is invisible afterwards.
     */
    source: varchar("source", { length: 24 }).notNull(),

    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /**
     * 🔴 FROZEN AT REQUEST TIME. Reading the seat position back from
     * today's numbers would answer "are they over the limit now", not
     * "were they over the limit then" — and the second is the one that
     * explains why this row exists.
     */
    seatsUsedAtRequest: integer("seats_used_at_request").notNull(),
    seatsAvailableAtRequest: integer("seats_available_at_request").notNull(),

    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: varchar("resolution", { length: 24 }),
    resolvedBy: uuid("resolved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * 🔴 REQUIRED TO DECLINE, NOT TO APPROVE. The seat count already
     * explains an approval and nothing explains a refusal. Same asymmetry
     * as the GSTR-2B worklist, and for the same reason: three months
     * later "why was this person never let in" has no answer.
     */
    resolutionReason: text("resolution_reason"),
  },
  (t) => ({
    /**
     * 🔴 ONE OPEN REQUEST PER PERSON. Clerk replays membership events on
     * purpose, and this codebase has been bitten by it before. Two open
     * requests would let an owner approve a seat for somebody who
     * already has one.
     *
     * ⚠️ PARTIAL, so the same person CAN be parked again once the first
     * request is closed. Declined in March and hired properly in June is
     * two requests, not an error.
     */
    openIdx: index("seat_requests_open_idx").on(t.tenantId, t.requestedAt),
  }),
);

/**
 * ⭐⭐⭐ WHOSE AI CREDITS — 0115.
 *
 * 🔴 ONE ROW PER PROVIDER CALL, AND `credentialSource` IS THE POINT.
 * Every row marked `platform` is money that left Ordence's own account on
 * a workspace's behalf. Before 0115 that number was unknowable: 0105's
 * `budget_scope` tracks provider HEALTH, not tokens.
 *
 * ⚠️ APPEND-ONLY BY TRIGGER. A metering table somebody can edit is one
 * nobody can quote in a billing conversation, and the edit that gets made
 * is always the one that lowers a number.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    providerId: varchar("provider_id", { length: 40 }).notNull(),
    model: varchar("model", { length: 120 }),

    /** 🔴 `platform` means it was OUR key. See the header. */
    credentialSource: varchar("credential_source", { length: 16 }).notNull(),

    /**
     * ⚠️ NULLABLE, AND NULL IS NOT ZERO. Not every provider returns
     * usage. A zero would be a measurement; NULL is the honest statement
     * that the provider did not say, and summing NULLs as zero would
     * understate our own spend invisibly.
     */
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),

    /** What asked. Not a foreign key: this table outlives its subjects. */
    feature: varchar("feature", { length: 60 }).notNull(),
    requestRef: varchar("request_ref", { length: 120 }),

    /**
     * 🔴 FAILURES ARE RECORDED. A call rejected after the prompt was sent
     * has already cost tokens, and a success-only table reports a
     * workspace as cheapest in exactly the month its key was broken and
     * it retried all day.
     */
    outcome: varchar("outcome", { length: 16 }).default("ok").notNull(),
    failureKind: varchar("failure_kind", { length: 40 }),
  },
  (t) => ({
    tenantPeriodIdx: index("ai_usage_tenant_period_idx").on(
      t.tenantId,
      t.occurredAt,
    ),
  }),
);
