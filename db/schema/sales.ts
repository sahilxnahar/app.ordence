/**
 * Ordence — Sales Pipeline & Inventory
 * Version: v0.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHERE THIS DESIGN CAME FROM
 * ══════════════════════════════════════════════════════════════════════
 * The shape of these tables is taken from a real-estate CRM that has been
 * in daily use — not from a specification. That matters, because several
 * columns here are ones nobody designs up front and everybody adds after
 * being burned:
 *
 *   • `cp_locked_until` on a lead — the commission-protection window that
 *     stops two brokers claiming the same buyer.
 *   • `hold_until` / `held_for_lead_id` on a unit — a sales rep blocking
 *     a flat for a prospect, with an automatic release.
 *   • `forfeit_amount` and `refund_amount` on a booking — what actually
 *     happens when somebody walks away.
 *   • `preferred_lang` — because a demand notice in the wrong language is
 *     a demand notice that does not get paid.
 *   • `consent_at` / `consent_source` — DPDP.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY DIFFERENT FROM THE SOURCE
 * ══════════════════════════════════════════════════════════════════════
 * Three changes, each because a single-organisation app does not have to
 * worry about them and a multi-tenant one does:
 *
 * 1. EVERY TABLE CARRIES A `tenant_id` AND IS UNDER FORCED RLS. The
 *    source has none — correctly, since it serves one company. Copying
 *    that assumption into a SaaS product is how one customer reads
 *    another's pipeline.
 *
 * 2. MONEY IS `bigint` MINOR UNITS, NOT `Decimal(14,2)`. The rest of this
 *    platform settled on paise in Phase 11 and mixing the two
 *    representations is how a rounding difference appears between the
 *    booking value and the invoice raised against it.
 *
 * 3. THE UNIT HOLD IS RACE-SAFE. In a single-organisation app two reps
 *    holding the same flat is a conversation. Here it is two customers
 *    promised one property, so it is a database guarantee — see
 *    `SQL-FILES/0016_phase22_sales.sql`.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  boolean,
  integer,
  bigint,
  numeric,
  date,
  doublePrecision,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "contacted",
  "qualified",
  "site_visit",
  "negotiation",
  "booked",
  "won",
  "lost",
]);

export const leadSourceEnum = pgEnum("lead_source", [
  "website",
  "referral",
  "walk_in",
  "campaign",
  "portal",
  "nri_desk",
  "broker",
  "other",
]);

/**
 * Temperature is SEPARATE from status, deliberately.
 *
 * Status is where the buyer is in the process; temperature is how likely
 * they are to close. A lead can sit at `qualified` and go cold, and a rep
 * needs to see that without the pipeline stage changing — collapsing the
 * two loses exactly the signal that tells you which deals are dying.
 */
export const leadTemperatureEnum = pgEnum("lead_temperature", [
  "hot",
  "warm",
  "cold",
]);

export const unitStatusEnum = pgEnum("unit_status", [
  "available",
  "held",
  "booked",
  "sold",
  "blocked",
]);

/**
 * `blocked` and `held` are different things, and the distinction is
 * operational rather than cosmetic:
 *
 *   held    — a rep is holding it for a named prospect, with a deadline.
 *             It releases automatically.
 *   blocked — management has taken it off the market (a dispute, a
 *             promoter allocation, a structural problem). It does NOT
 *             release, and no rep can book it.
 */

export const bookingStatusEnum = pgEnum("booking_status", [
  "tentative",
  "confirmed",
  "agreement",
  "registered",
  "cancelled",
]);

export const paymentStatusEnum = pgEnum("sales_payment_status", [
  "pending",
  "partial",
  "paid",
  "overdue",
]);

export const leadActivityTypeEnum = pgEnum("lead_activity_type", [
  "call",
  "email",
  "whatsapp",
  "meeting",
  "site_visit",
  "note",
  "status_change",
  "assignment",
]);

export const commissionBasisEnum = pgEnum("commission_basis", [
  "percent_of_sale",
  "months_of_rent",
  "flat_fee",
]);

export const partnerStatusEnum = pgEnum("channel_partner_status", [
  "pending",
  "active",
  "suspended",
  "terminated",
]);

export const kycStatusEnum = pgEnum("kyc_status", [
  "pending",
  "submitted",
  "verified",
  "rejected",
]);

/**
 * ⭐ v1.25.0-alpha — the life of a brokerage bill.
 *
 * ⚠️ IT RATCHETS, AND A TRIGGER ENFORCES THAT. Once a bill is posted its
 * figures are in the trial balance and in a TDS return; letting it walk
 * back to `draft` for an edit would restate a deduction that has already
 * been certified to a broker. The remedy for a wrong bill is `cancelled`
 * plus a new one, which is what the paper trail should show anyway.
 */
export const commissionStatusEnum = pgEnum("commission_status", [
  "draft",
  "approved",
  "posted",
  "paid",
  "cancelled",
]);

/* ------------------------------------------------------------------ */
/* PROJECTS                                                            */
/* ------------------------------------------------------------------ */

/**
 * A development. Units hang off it.
 *
 * ⚠️ NOT merged into the Phase 4 `assets` table, and that was a real
 * decision rather than an oversight.
 *
 * `assets` is the generic vertical engine — 20 types, 12 statuses,
 * polymorphic. A project and a unit carry structure that engine has no
 * opinion about: RERA registration, tower and floor, carpet area as
 * defined by RERA, facing, a hold mechanism with a deadline. Pushing all
 * of that into the generic table would give every other vertical a dozen
 * columns meaning nothing to them.
 *
 * The real-estate vertical is the differentiator. It gets first-class
 * tables; the generic engine keeps serving everything else.
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),

    addressLine: text("address_line"),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 120 }),

    /**
     * ⭐ THE SITE'S GST STATE CODE — added v1.37.0 (SQL 0080, Batch 33).
     *
     * ══════════════════════════════════════════════════════════════════
     * 🔴 `state` ABOVE IS PROSE AND PROSE CANNOT DECIDE A TAX.
     * ══════════════════════════════════════════════════════════════════
     * Under s.12(3) of the IGST Act the place of supply for anything
     * relating to immovable property is the LOCATION OF THE PROPERTY. For
     * a works contract or an under-construction flat, that location is
     * this project.
     *
     * `state` holds "Maharashtra", or "MAHARASHTRA", or "Maharastra". The
     * place-of-supply engine needs "27". Those are not convertible
     * without a lookup table and a spelling policy, and a tax decision
     * taken on a fuzzy string match is a tax decision that will be wrong
     * for one project in fifty and be blamed on the customer's typing.
     *
     * ⚠️ DELIBERATELY NULLABLE, AND DELIBERATELY NOT BACKFILLED FROM
     * `state`. A project with no code set makes the engine REFUSE, with a
     * remedy naming this field. A guess would make it answer, and the
     * answer would be unverifiable. Refusing is the behaviour that gets
     * the data fixed; guessing is the behaviour that ships wrong returns
     * quietly for a year.
     */
    stateCode: varchar("state_code", { length: 2 }),

    /** For the lead heat-map and site navigation. */
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),

    /**
     * RERA registration number. Advertising a project without one is an
     * offence in India, so this is not decoration — a project with no
     * RERA number should not appear in customer-facing material, and
     * having the field is what lets us warn about that later.
     */
    reraNumber: varchar("rera_number", { length: 60 }),

    /**
     * ⭐ WHAT THE PROJECT WAS SUPPOSED TO COST — added v0.68.0 (SQL 0041).
     *
     * ══════════════════════════════════════════════════════════════════
     * ⚠️ WITHOUT THIS, EVERY COST REPORT IN THE PRODUCT WAS HALF A REPORT.
     * ══════════════════════════════════════════════════════════════════
     * `getCostControl()` could say what has been committed, measured and
     * billed. It could not say whether any of that is too much, because
     * there was nothing to compare against.
     *
     * "₹4.1 crore committed" is a number somebody reads and moves on
     * from. "₹4.1 crore against a ₹3.8 crore budget" is a decision
     * somebody has to make this week.
     *
     * ⚠️ NULL MEANS "NO BUDGET SET", AND REPORTS MUST SAY SO RATHER THAN
     * SHOWING ZERO. A zero budget renders as either "infinitely over" or,
     * worse, gets formatted into a tidy "₹0" that reads as on-budget.
     * The distinction between unset and zero is the whole reason this is
     * nullable rather than defaulted.
     *
     * ⚠️ PAISE AS bigint, like every other money column. A `numeric`
     * budget compared against a `bigint` spend is a units bug waiting in
     * whichever report joins them.
     */
    budgetMinor: bigint("budget_minor", { mode: "bigint" }),
    /** Contingency as basis points of the budget. 500 = 5%. */
    contingencyBps: integer("contingency_bps"),
    /** Saleable area, for the per-square-foot figures every developer works in. */
    saleableAreaSqft: numeric("saleable_area_sqft", { precision: 18, scale: 2 }),

    isActive: boolean("is_active").default(true).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    expectedCompletionAt: timestamp("expected_completion_at", { withTimezone: true }),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    // Unique PER TENANT, not globally. Two customers may both have a
    // project called "Phase 1", and neither should block the other.
    codePerTenant: uniqueIndex("projects_code_tenant_unique")
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdx: index("projects_tenant_idx").on(t.tenantId),
    activeIdx: index("projects_tenant_active_idx").on(t.tenantId, t.isActive),
  }),
);

/* ------------------------------------------------------------------ */
/* UNITS                                                               */
/* ------------------------------------------------------------------ */

export const units = pgTable(
  "units",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    /** e.g. "A-1203". Unique within the project. */
    code: varchar("code", { length: 60 }).notNull(),
    tower: varchar("tower", { length: 60 }),
    floor: integer("floor"),
    /** "2BHK", "3BHK", "Penthouse" — tenant-defined, not an enum. */
    typology: varchar("typology", { length: 60 }),

    /**
     * CARPET area specifically, in square feet.
     *
     * RERA requires carpet area to be the basis of sale — super built-up
     * area cannot be used to price a unit. Naming the column for what it
     * legally is, rather than a generic `area`, is what stops somebody
     * putting the wrong number in it three years from now.
     */
    carpetAreaSqft: integer("carpet_area_sqft"),
    builtUpAreaSqft: integer("built_up_area_sqft"),

    /** Compass facing. Matters commercially in the Indian market. */
    facing: varchar("facing", { length: 20 }),

    /** List price in PAISE. See the file header on money. */
    priceMinor: bigint("price_minor", { mode: "bigint" }),

    status: unitStatusEnum("status").default("available").notNull(),

    /* --- The hold mechanism -------------------------------------- */
    //
    // A rep blocks a unit for a named prospect while the paperwork
    // happens. Three columns rather than one flag, because "who is it
    // held for" and "who held it" are both questions that get asked, and
    // "until when" is what makes the hold release itself.
    holdUntil: timestamp("hold_until", { withTimezone: true }),
    heldForLeadId: uuid("held_for_lead_id"),
    heldByUserId: uuid("held_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    holdTokenMinor: bigint("hold_token_minor", { mode: "bigint" }),
    holdNote: text("hold_note"),

    customFields: jsonb("custom_fields")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    codePerProject: uniqueIndex("units_code_project_unique")
      .on(t.projectId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdx: index("units_tenant_idx").on(t.tenantId),
    statusIdx: index("units_tenant_status_idx").on(t.tenantId, t.status),
    projectStatusIdx: index("units_project_status_idx").on(t.projectId, t.status),
    // Drives the expiry sweep.
    holdIdx: index("units_hold_until_idx")
      .on(t.holdUntil)
      .where(sql`${t.status} = 'held'`),

    priceNonNegative: check(
      "units_price_non_negative",
      sql`${t.priceMinor} IS NULL OR ${t.priceMinor} >= 0`,
    ),
    /**
     * ⚠️ A HELD unit must say who it is held for and until when.
     *
     * A hold with no deadline never releases, and a hold with no lead is
     * a unit nobody can explain. Both happen when a status is set by a
     * script that forgot the other columns — so the database refuses the
     * combination rather than trusting every future write path.
     */
    holdIsComplete: check(
      "units_hold_is_complete",
      sql`${t.status} <> 'held'
          OR (${t.holdUntil} IS NOT NULL AND ${t.heldForLeadId} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* LEADS                                                               */
/* ------------------------------------------------------------------ */

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Human-facing reference, e.g. "LEAD-2044". Unique per tenant. */
    reference: varchar("reference", { length: 40 }).notNull(),

    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 32 }),

    /**
     * Language for demand notices and WhatsApp.
     *
     * Not cosmetic. A payment demand a buyer cannot read is a payment
     * demand that does not get paid, and in a market where buyers span
     * four or five languages this is the difference between a collection
     * and a follow-up call.
     */
    preferredLang: varchar("preferred_lang", { length: 8 }).default("en"),

    source: leadSourceEnum("source").default("website").notNull(),
    status: leadStatusEnum("status").default("new").notNull(),
    temperature: leadTemperatureEnum("temperature").default("warm").notNull(),
    score: integer("score").default(0).notNull(),

    budgetMinMinor: bigint("budget_min_minor", { mode: "bigint" }),
    budgetMaxMinor: bigint("budget_max_minor", { mode: "bigint" }),
    requirement: text("requirement"),

    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),

    /* --- NRI ------------------------------------------------------ */
    //
    // A separate desk in most Indian developers. The timezone is the
    // operationally important one: calling a buyer in New Jersey at
    // 11am IST is calling them at 1:30am.
    isNri: boolean("is_nri").default(false).notNull(),
    country: varchar("country", { length: 2 }),
    timezone: varchar("timezone", { length: 64 }),

    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    lostReason: text("lost_reason"),

    /* --- Geography, for the heat map ------------------------------ */
    locality: varchar("locality", { length: 160 }),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),

    /* --- DPDP consent --------------------------------------------- */
    //
    // ⚠️ Under the Digital Personal Data Protection Act, contacting
    // someone about a property requires a lawful basis. `consent_at` and
    // `consent_source` are the evidence. A lead with neither is not a
    // lead you may legally call, and having the columns is what makes
    // that checkable rather than assumed.
    /**
     * ⭐⭐ ADDED IN v1.10.0 (SQL 0061). The lead was already mostly
     * generic; what was real-estate-shaped about it was the project
     * link, and what was missing was a general one.
     *
     * 🔴 A SECOND LEAD TABLE WAS NOT BUILT. Two answers to "who
     * enquired" is worse than a gap, and somebody would reconcile them
     * forever. Same decision as the price list in 0057.
     */
    leadSourceId: uuid("lead_source_id"),
    stageId: uuid("stage_id"),
    interestType: varchar("interest_type", { length: 40 }),
    interestId: uuid("interest_id"),
    interestLabel: varchar("interest_label", { length: 300 }),
    contactId: uuid("contact_id"),
    /**
     * 🔴 GENERATED ALWAYS, so it cannot drift from the column it comes
     * from and cannot be forgotten by an import. The last ten digits,
     * because +91 98765 43210, 098765 43210 and 9876543210 are the same
     * man and a check on the raw text finds none of them.
     */
    phoneDigits: varchar("phone_digits", { length: 10 }).generatedAlwaysAs(
      sql`right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10)`,
    ),
    emailKey: varchar("email_key", { length: 320 }).generatedAlwaysAs(
      sql`lower(btrim(COALESCE(email, '')))`,
    ),
    /** ⭐ A duplicate that was decided is recorded, never deleted. */
    duplicateOf: uuid("duplicate_of"),

    /* --- 0065 · WHERE IT CAME FROM, EXACTLY ------------------------ */
    /**
     * ⭐ WHICH CONNECTION, not merely which channel. `leadSourceId`
     * already answers "IndiaMART"; this answers "the IndiaMART account
     * we call Main", which is the one somebody can act on.
     */
    connectionId: uuid("connection_id"),
    /**
     * 🔴 THE SENDER'S OWN ID, and the reason a resent enquiry lands
     * once. 0065 puts a unique index on `(connection_id, external_id)`.
     *
     * ⚠️ NOT OURS. A key we mint cannot answer "have we had this
     * before", because we mint a new one every time we are asked.
     *
     * ⭐ AND IT IS A DIFFERENT QUESTION FROM `phoneDigits` above. That
     * one asks "is this the same PERSON" and is shown to a salesman;
     * this one asks "is this the same EVENT" and refuses the row.
     */
    externalId: varchar("external_id", { length: 200 }),
    intakeDeliveryId: uuid("intake_delivery_id"),
    intakeRunId: uuid("intake_run_id"),
    /**
     * ⚠️ WHAT THEY ACTUALLY SAID, redacted and kept verbatim. Every
     * connector has fields we do not map, and the one nobody mapped is
     * always the one the customer asks about.
     */
    intakePayload: jsonb("intake_payload").$type<Record<string, unknown> | null>(),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentSource: varchar("consent_source", { length: 120 }),

    /* --- Channel-partner attribution ------------------------------ */
    //
    // ⚠️ THE COMMISSION-PROTECTION WINDOW.
    //
    // A broker registers a buyer. For a defined period that buyer is
    // theirs, so a second broker — or the in-house team — cannot claim
    // the commission by re-registering the same person. This is one of
    // the most argued-about mechanics in Indian real estate, and getting
    // it wrong costs either a broker relationship or a commission paid
    // twice.
    channelPartnerId: uuid("channel_partner_id"),
    cpLockedUntil: timestamp("cp_locked_until", { withTimezone: true }),

    customFields: jsonb("custom_fields")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    referencePerTenant: uniqueIndex("leads_reference_tenant_unique")
      .on(t.tenantId, t.reference)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdx: index("leads_tenant_idx").on(t.tenantId),
    statusIdx: index("leads_tenant_status_idx").on(t.tenantId, t.status),
    ownerIdx: index("leads_tenant_owner_idx").on(t.tenantId, t.ownerId),
    followUpIdx: index("leads_follow_up_idx").on(t.tenantId, t.nextFollowUpAt),
    nriIdx: index("leads_nri_idx").on(t.tenantId, t.isNri),
    partnerIdx: index("leads_partner_idx").on(t.tenantId, t.channelPartnerId),

    scoreSane: check("leads_score_sane", sql`${t.score} >= 0 AND ${t.score} <= 100`),
    /**
     * A maximum below the minimum is a data-entry slip that silently
     * breaks every "units in budget" query downstream.
     */
    budgetSane: check(
      "leads_budget_sane",
      sql`${t.budgetMinMinor} IS NULL OR ${t.budgetMaxMinor} IS NULL
          OR ${t.budgetMaxMinor} >= ${t.budgetMinMinor}`,
    ),
    /** A lost lead should say why. Otherwise the pipeline teaches nothing. */
    lostHasReason: check(
      "leads_lost_has_reason",
      sql`${t.status} <> 'lost' OR ${t.lostReason} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* LEAD ACTIVITY                                                       */
/* ------------------------------------------------------------------ */

export const leadActivities = pgTable(
  "lead_activities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),

    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    type: leadActivityTypeEnum("type").notNull(),
    subject: varchar("subject", { length: 255 }),
    notes: text("notes"),
    outcome: varchar("outcome", { length: 160 }),

    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    leadIdx: index("lead_activities_lead_idx").on(t.leadId, t.occurredAt),
    tenantIdx: index("lead_activities_tenant_idx").on(t.tenantId),
  }),
);

/* ------------------------------------------------------------------ */
/* CHANNEL PARTNERS                                                    */
/* ------------------------------------------------------------------ */

export const channelPartners = pgTable(
  "channel_partners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 40 }).notNull(),
    firmName: varchar("firm_name", { length: 255 }).notNull(),
    contactName: varchar("contact_name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 32 }).notNull(),
    email: varchar("email", { length: 320 }),

    /** Statutory identifiers. A broker without RERA cannot legally act. */
    reraNumber: varchar("rera_number", { length: 60 }),
    panNumber: varchar("pan_number", { length: 10 }),
    gstin: varchar("gstin", { length: 15 }),

    /**
     * Commission can be expressed three ways, and a single `pct` column
     * forces the other two into a fiction. Lettings are quoted in months
     * of rent; some referral deals are a flat fee.
     */
    commissionBasis: commissionBasisEnum("commission_basis")
      .default("percent_of_sale")
      .notNull(),
    /** Basis points — 200 = 2%. Integer, never a float. */
    commissionRateBps: integer("commission_rate_bps").default(200).notNull(),
    /** Months of rent × 100, so 1.5 months is 150. */
    commissionMonthsCentis: integer("commission_months_centis"),
    commissionFlatMinor: bigint("commission_flat_minor", { mode: "bigint" }),

    kycStatus: kycStatusEnum("kyc_status").default("pending").notNull(),
    status: partnerStatusEnum("status").default("pending").notNull(),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    codePerTenant: uniqueIndex("channel_partners_code_tenant_unique")
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdx: index("channel_partners_tenant_idx").on(t.tenantId),
    statusIdx: index("channel_partners_tenant_status_idx").on(t.tenantId, t.status),

    rateSane: check(
      "channel_partners_rate_sane",
      sql`${t.commissionRateBps} >= 0 AND ${t.commissionRateBps} <= 10000`,
    ),
    /** GSTIN shape, matching the invoicing rule from Phase 11. */
    gstinShape: check(
      "channel_partners_gstin_shape",
      sql`${t.gstin} IS NULL OR ${t.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'`,
    ),
    panShape: check(
      "channel_partners_pan_shape",
      sql`${t.panNumber} IS NULL OR ${t.panNumber} ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* BOOKINGS                                                            */
/* ------------------------------------------------------------------ */

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    reference: varchar("reference", { length: 40 }).notNull(),

    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    salesRepId: uuid("sales_rep_id").references(() => users.id, {
      onDelete: "set null",
    }),
    channelPartnerId: uuid("channel_partner_id").references(() => channelPartners.id, {
      onDelete: "set null",
    }),

    status: bookingStatusEnum("status").default("tentative").notNull(),
    paymentStatus: paymentStatusEnum("payment_status").default("pending").notNull(),

    /** The agreed sale value, in paise. */
    agreementValueMinor: bigint("agreement_value_minor", { mode: "bigint" }),

    bookedAt: timestamp("booked_at", { withTimezone: true }).defaultNow().notNull(),

    /* --- Cancellation --------------------------------------------- */
    //
    // What actually happens when a buyer walks away: some of the money
    // is kept, some is returned. Two separate figures, because they are
    // negotiated separately and both appear in the ledger.
    /**
     * ⭐ THE DATE THAT MAKES REVENUE REAL — Ind AS 115.
     *
     * ⚠️ NOT A STATUS. "Has this flat been handed over" is answered
     * exactly by `possession_date IS NOT NULL`; a status column carrying
     * the same fact can disagree with it, and the one that disagrees is
     * always the one somebody set by hand.
     */
    possessionDate: date("possession_date", { mode: "string" }),
    possessionRecordedAt: timestamp("possession_recorded_at", { withTimezone: true }),
    possessionRecordedBy: uuid("possession_recorded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    possessionNote: text("possession_note"),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    forfeitAmountMinor: bigint("forfeit_amount_minor", { mode: "bigint" }),
    refundAmountMinor: bigint("refund_amount_minor", { mode: "bigint" }),

    /* --- ⭐⭐ v1.25.0-alpha — what the cancellation POSTED ---------- */
    //
    // 🔴 THE FIGURES ARE STORED, NOT RECOMPUTED. A cancellation posting
    // depends on the section 34 credit-note window, which depends on
    // today's date. Re-deriving it next year would produce a different
    // answer to the same question, and the journal that was actually
    // posted would then have no document behind it that agrees with it.
    /** The section 34 credit note that reversed the output tax, if any. */
    gstCreditNoteNumber: varchar("gst_credit_note_number", { length: 40 }),
    reversedCgstMinor: bigint("reversed_cgst_minor", { mode: "bigint" }),
    reversedSgstMinor: bigint("reversed_sgst_minor", { mode: "bigint" }),
    reversedIgstMinor: bigint("reversed_igst_minor", { mode: "bigint" }),
    /** ⚠️ Set by the posting, never by hand. Null means not yet in the ledger. */
    cancellationPostedAt: timestamp("cancellation_posted_at", { withTimezone: true }),
    /**
     * ⚠️ SEPARATE FROM `cancelledAt`, AND OFTEN MONTHS AFTER IT. How long
     * a cancelled buyer waits for their money is a question a consumer
     * forum asks in those words, and a single date cannot answer it.
     */
    refundPaidAt: timestamp("refund_paid_at", { withTimezone: true }),
    refundReference: varchar("refund_reference", { length: 60 }),

    customFields: jsonb("custom_fields")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    referencePerTenant: uniqueIndex("bookings_reference_tenant_unique").on(
      t.tenantId,
      t.reference,
    ),
    tenantIdx: index("bookings_tenant_idx").on(t.tenantId, t.bookedAt),
    statusIdx: index("bookings_tenant_status_idx").on(t.tenantId, t.status),
    unitIdx: index("bookings_unit_idx").on(t.unitId),

    /**
     * ⭐ ONE LIVE BOOKING PER UNIT.
     *
     * The single most important constraint in this phase. Two live
     * bookings on one flat means two buyers have been promised the same
     * property — a dispute that ends in a refund, a broken relationship
     * and possibly a RERA complaint.
     *
     * A single-organisation app can rely on nobody doing that. A product
     * used by companies with twelve reps and a busy launch weekend
     * cannot. Partial, so a cancelled booking leaves the unit free.
     */
    oneLivePerUnit: uniqueIndex("bookings_one_live_per_unit")
      .on(t.unitId)
      .where(sql`${t.status} <> 'cancelled' AND ${t.unitId} IS NOT NULL`),

    amountsNonNegative: check(
      "bookings_amounts_non_negative",
      sql`(${t.agreementValueMinor} IS NULL OR ${t.agreementValueMinor} >= 0)
          AND (${t.forfeitAmountMinor} IS NULL OR ${t.forfeitAmountMinor} >= 0)
          AND (${t.refundAmountMinor} IS NULL OR ${t.refundAmountMinor} >= 0)`,
    ),
    /** A cancellation should record why. */
    cancelHasReason: check(
      "bookings_cancel_has_reason",
      sql`${t.status} <> 'cancelled' OR ${t.cancelReason} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* PAYMENT MILESTONES                                                  */
/* ------------------------------------------------------------------ */

/**
 * The construction-linked payment plan. A buyer pays in instalments tied
 * to build progress — "on completion of 3rd slab" — which is how
 * residential sales work in India and is mandated by RERA for escrowed
 * projects.
 */
export const paymentMilestones = pgTable(
  "payment_milestones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),

    label: varchar("label", { length: 255 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),

    /** Where it sits in the plan. Milestones are ordered, not dated. */
    sequence: integer("sequence").default(1).notNull(),

    dueDate: timestamp("due_date", { withTimezone: true }),
    status: paymentStatusEnum("status").default("pending").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    amountPaidMinor: bigint("amount_paid_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bookingIdx: index("payment_milestones_booking_idx").on(t.bookingId, t.sequence),
    tenantIdx: index("payment_milestones_tenant_idx").on(t.tenantId),
    dueIdx: index("payment_milestones_due_idx").on(t.tenantId, t.dueDate),
    statusIdx: index("payment_milestones_status_idx").on(t.tenantId, t.status),

    amountPositive: check(
      "payment_milestones_amount_positive",
      sql`${t.amountMinor} > 0`,
    ),
    paidNonNegative: check(
      "payment_milestones_paid_non_negative",
      sql`${t.amountPaidMinor} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const projectsRelations = relations(projects, ({ one, many }) => ({
  tenant: one(tenants, { fields: [projects.tenantId], references: [tenants.id] }),
  units: many(units),
  leads: many(leads),
}));

export const unitsRelations = relations(units, ({ one, many }) => ({
  tenant: one(tenants, { fields: [units.tenantId], references: [tenants.id] }),
  project: one(projects, { fields: [units.projectId], references: [projects.id] }),
  bookings: many(bookings),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  tenant: one(tenants, { fields: [leads.tenantId], references: [tenants.id] }),
  project: one(projects, { fields: [leads.projectId], references: [projects.id] }),
  owner: one(users, { fields: [leads.ownerId], references: [users.id] }),
  activities: many(leadActivities),
  bookings: many(bookings),
}));

export const leadActivitiesRelations = relations(leadActivities, ({ one }) => ({
  lead: one(leads, { fields: [leadActivities.leadId], references: [leads.id] }),
}));

export const channelPartnersRelations = relations(channelPartners, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [channelPartners.tenantId],
    references: [tenants.id],
  }),
  bookings: many(bookings),
}));

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ CHANNEL-PARTNER COMMISSIONS — v1.25.0-alpha                   */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY BROKERAGE NEEDS A DOCUMENT AND NOT A COLUMN ON THE BOOKING
 * ══════════════════════════════════════════════════════════════════════
 * `lib/sales/commission.ts` has been able to COMPUTE brokerage since
 * Phase 22, and `/sales/partners/[id]` has shown the figure for almost as
 * long. Nothing has ever recorded it, so nothing has ever posted it —
 * the ninth time in this project that a complete engine turned out to
 * have nothing reaching it.
 *
 * What was missing is a DOCUMENT. Brokerage is not one number per
 * booking:
 *
 *   • It is usually paid in TRANCHES — part on agreement, part on
 *     registration, part on possession. A column would hold only the
 *     last one written.
 *   • The TDS depends on everything else credited to that partner in the
 *     SAME FINANCIAL YEAR, so each tranche has to be a dated row or the
 *     threshold cannot be applied at all.
 *   • The rate is resolved against the credit date and stored on the
 *     row. A partner statement for a closed year has to reproduce the
 *     rate that was right then, not the one in force when it is printed.
 *   • And a broker disputes a figure a year later. The answer has to be
 *     a document with a date on it, not a recomputation that quietly
 *     uses today's inputs.
 */
export const channelPartnerCommissions = pgTable(
  "channel_partner_commissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠️ `restrict`, NOT `cascade`. Deleting a partner must not take a
     * posted brokerage bill with it — the journal entry would survive
     * and its counterparty would not.
     */
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => channelPartners.id, { onDelete: "restrict" }),
    /** Nullable: a referral fee is sometimes not tied to one booking. */
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),

    reference: varchar("reference", { length: 40 }).notNull(),
    status: commissionStatusEnum("status").default("draft").notNull(),

    /**
     * 🔴 THE CREDIT DATE, AND EVERYTHING STATUTORY HANGS OFF IT. The
     * 194H rate, the annual threshold and the financial year the bill
     * falls in are all resolved against this and never against `now()`.
     */
    creditedOn: date("credited_on", { mode: "string" }).notNull(),

    /* --- How the figure was reached, kept so it can be re-derived --- */
    basis: commissionBasisEnum("basis").notNull(),
    rateBps: integer("rate_bps"),
    monthsCentis: integer("months_centis"),
    flatMinor: bigint("flat_minor", { mode: "bigint" }),
    considerationMinor: bigint("consideration_minor", { mode: "bigint" }),
    workings: text("workings").notNull(),

    grossMinor: bigint("gross_minor", { mode: "bigint" }).notNull(),

    /* --- The partner's own tax invoice ------------------------------ */
    partnerInvoiceNumber: varchar("partner_invoice_number", { length: 40 }),
    partnerInvoiceDate: date("partner_invoice_date", { mode: "string" }),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /**
     * 🔴 FALSE BY DEFAULT, DELIBERATELY. Most residential projects are on
     * the 1%/5% concessional rate and have NO input credit. Defaulting to
     * true would claim blocked credit on every brokerage bill in the
     * commonest configuration in the market, which is a demand with
     * interest and penalty on it.
     */
    itcEligible: boolean("itc_eligible").default(false).notNull(),

    /* --- Section 194H ------------------------------------------------ */
    tdsMinor: bigint("tds_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** ⚠️ Stored, not resolved at read time. 2% from 1 Oct 2024, 5% before. */
    tdsRateBps: integer("tds_rate_bps").default(0).notNull(),
    /** The WHOLE year's chargeable base this deduction was computed on. */
    tdsChargeableBaseMinor: bigint("tds_chargeable_base_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    tdsExplanation: text("tds_explanation"),

    netPayableMinor: bigint("net_payable_minor", { mode: "bigint" }).notNull(),

    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paymentReference: varchar("payment_reference", { length: 60 }),

    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    referencePerTenant: uniqueIndex("cp_commissions_reference_tenant_unique").on(
      t.tenantId,
      t.reference,
    ),
    tenantIdx: index("cp_commissions_tenant_idx").on(t.tenantId, t.creditedOn),
    partnerIdx: index("cp_commissions_partner_idx").on(t.partnerId, t.creditedOn),
    bookingIdx: index("cp_commissions_booking_idx").on(t.bookingId),
    statusIdx: index("cp_commissions_tenant_status_idx").on(t.tenantId, t.status),

    /**
     * ⭐ THE ARITHMETIC IS A DATABASE GUARANTEE, NOT AN APPLICATION ONE.
     * `net = gross + tax − TDS`. A row that does not satisfy it produces
     * a journal that does not balance, and the place to refuse it is
     * before it is stored — an unbalanced row that reaches the posting
     * step fails there instead, with a message about the ledger rather
     * than about the bill.
     */
    addsUp: check(
      "cp_commissions_adds_up",
      sql`${t.netPayableMinor} = ${t.grossMinor} + ${t.cgstMinor} + ${t.sgstMinor} + ${t.igstMinor} - ${t.tdsMinor}`,
    ),
    amountsNonNegative: check(
      "cp_commissions_amounts_non_negative",
      sql`${t.grossMinor} >= 0 AND ${t.cgstMinor} >= 0 AND ${t.sgstMinor} >= 0
          AND ${t.igstMinor} >= 0 AND ${t.tdsMinor} >= 0 AND ${t.netPayableMinor} >= 0`,
    ),
    /**
     * ⚠️ TDS CANNOT EXCEED THE BROKERAGE. 20% under 206AA is the highest
     * this can legitimately be, and a bill where tax exceeds the fee is
     * a units error — paise passed where rupees were expected is the
     * classic one, and it produces exactly this shape.
     */
    tdsSane: check("cp_commissions_tds_sane", sql`${t.tdsMinor} <= ${t.grossMinor}`),
    /**
     * 🔴 GST ONLY WITH AN INVOICE NUMBER. Input credit needs a document.
     * A brokerage bill carrying tax and no invoice number is credit
     * claimed against nothing, and it is the first thing an officer asks
     * for.
     */
    taxNeedsInvoice: check(
      "cp_commissions_tax_needs_invoice",
      sql`(${t.cgstMinor} + ${t.sgstMinor} + ${t.igstMinor}) = 0
          OR ${t.partnerInvoiceNumber} IS NOT NULL`,
    ),
    /**
     * ⚠️ CGST AND SGST MOVE TOGETHER, AND NEITHER MOVES WITH IGST. A
     * supply is intra-State or inter-State; there is no third case. A
     * bill with CGST and IGST both non-zero is a place-of-supply error,
     * and it flows straight into GSTR-3B if nothing refuses it.
     */
    taxShape: check(
      "cp_commissions_tax_shape",
      sql`(${t.igstMinor} = 0 OR (${t.cgstMinor} = 0 AND ${t.sgstMinor} = 0))`,
    ),
    /**
     * ⭐ ONE LIVE BILL PER PARTNER PER BOOKING PER CREDIT DATE.
     *
     * ⚠️ NOT "ONE PER BOOKING". Brokerage is genuinely paid in tranches
     * on different dates, and a constraint forbidding that would push
     * users into one inflated bill — which breaks the TDS timing, since
     * the threshold is tested when each amount is CREDITED.
     *
     * What it does forbid is the same tranche entered twice, which is
     * the actual failure mode: two people raise the same bill on a busy
     * launch weekend and the partner is paid twice.
     */
    oneLivePerTranche: uniqueIndex("cp_commissions_one_live_per_tranche")
      .on(t.partnerId, t.bookingId, t.creditedOn)
      .where(sql`${t.status} <> 'cancelled' AND ${t.bookingId} IS NOT NULL`),
  }),
);

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  tenant: one(tenants, { fields: [bookings.tenantId], references: [tenants.id] }),
  lead: one(leads, { fields: [bookings.leadId], references: [leads.id] }),
  unit: one(units, { fields: [bookings.unitId], references: [units.id] }),
  milestones: many(paymentMilestones),
}));

export const paymentMilestonesRelations = relations(paymentMilestones, ({ one }) => ({
  booking: one(bookings, {
    fields: [paymentMilestones.bookingId],
    references: [bookings.id],
  }),
}));

export const channelPartnerCommissionsRelations = relations(
  channelPartnerCommissions,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [channelPartnerCommissions.tenantId],
      references: [tenants.id],
    }),
    partner: one(channelPartners, {
      fields: [channelPartnerCommissions.partnerId],
      references: [channelPartners.id],
    }),
    booking: one(bookings, {
      fields: [channelPartnerCommissions.bookingId],
      references: [bookings.id],
    }),
  }),
);

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Unit = typeof units.$inferSelect;
export type NewUnit = typeof units.$inferInsert;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadActivity = typeof leadActivities.$inferSelect;
export type ChannelPartner = typeof channelPartners.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type PaymentMilestone = typeof paymentMilestones.$inferSelect;
export type ChannelPartnerCommission = typeof channelPartnerCommissions.$inferSelect;
export type NewChannelPartnerCommission = typeof channelPartnerCommissions.$inferInsert;
export type CommissionStatus = (typeof commissionStatusEnum.enumValues)[number];

export type LeadStatus = (typeof leadStatusEnum.enumValues)[number];
export type LeadSource = (typeof leadSourceEnum.enumValues)[number];
export type LeadTemperature = (typeof leadTemperatureEnum.enumValues)[number];
export type UnitStatus = (typeof unitStatusEnum.enumValues)[number];
export type BookingStatus = (typeof bookingStatusEnum.enumValues)[number];
export type SalesPaymentStatus = (typeof paymentStatusEnum.enumValues)[number];
export type LeadActivityType = (typeof leadActivityTypeEnum.enumValues)[number];
export type CommissionBasis = (typeof commissionBasisEnum.enumValues)[number];
export type ChannelPartnerStatus = (typeof partnerStatusEnum.enumValues)[number];
export type KycStatus = (typeof kycStatusEnum.enumValues)[number];
