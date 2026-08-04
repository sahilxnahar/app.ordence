/**
 * Ordence — ⭐ Land, Title and the Joint Development Agreement
 * Version: v0.42.0-alpha  ·  PORT WAVE A
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHERE A DEVELOPER'S LIFE ACTUALLY STARTS
 * ══════════════════════════════════════════════════════════════════════
 * Ordence has been able to describe a project, its units, its buyers and
 * its money since Phase 22. It has never been able to describe the LAND —
 * who owned it, how they came to own it, whether that ownership is clean,
 * what was agreed with them, and whether the thing may lawfully be built
 * on at all. Every one of those questions precedes the first brick and any
 * one of them can stop a project dead after crores are spent.
 *
 * This wave is ported from a working single-company system, so the shapes
 * here are not guesses — they encode things somebody learned the expensive
 * way. What is NOT ported is that system's tenancy model, because it has
 * none: it is one company's database. Every table below is rebuilt
 * multi-tenant, with RLS forced and composite foreign keys, in
 * `SQL-FILES/0030_phase42_land.sql`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE CHAIN OF TITLE IS ORDERED SO THAT A GAP IS VISIBLE
 * ══════════════════════════════════════════════════════════════════════
 * A title chain is the sequence of deeds carrying ownership from the
 * earliest recorded owner to today. Its value is not the documents — it is
 * the ABSENCE of a break between them. A chain stored as an unordered pile
 * of scans looks complete when it is not, because the missing link is the
 * one nobody uploaded.
 *
 * So `chainPosition` is explicit and starts at the mother deed, and
 * `linksFromPartyId`/`toParty` are recorded per link, which is what lets a
 * report ask the only question that matters: does every link's seller
 * match the previous link's buyer? A chain that fails that test is a title
 * somebody will litigate.
 *
 * ⚠️ MERGED FROM TWO TABLES ON PURPOSE. The source system had BOTH a
 * `TitleDocument` and a `TitleChainEntry`, with overlapping columns and two
 * different enums for the same list of deed types. That is a real defect
 * rather than a style choice: a chain split across two tables cannot be
 * checked for gaps at all, because half the links are in the other table.
 * One table, one enum, one order.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SHARES ARE FRACTIONS, NOT PERCENTAGES
 * ══════════════════════════════════════════════════════════════════════
 * An ancestral property divided among three heirs gives each one third.
 * Stored as a percentage that is 33.33, and three of them sum to 99.99 —
 * so a system that checks the shares add up rejects a correct family, and
 * a system that does not check lets a wrong one through. Stored as
 * `shareNum`/`shareDen` the arithmetic is exact and the check is real.
 *
 * ⚠️ AND A RELINQUISHMENT IS A DEED, NOT A DELETION. An heir who signs
 * away their share still existed and still had it. `relinquished` plus the
 * deed number keeps them in the tree, because the buyer's lawyer will ask
 * about them by name.
 *
 * Money is `bigint` paise. Areas are `numeric`. Nothing is a float.
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
import { projects, units } from "./sales";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

export const landParcelStageEnum = pgEnum("land_parcel_stage", [
  "identified",
  "under_negotiation",
  "agreed",
  "due_diligence",
  "registered",
  "dropped",
]);

/**
 * ⭐ ONE LIST OF DEED TYPES. The source system had two overlapping enums;
 * merged here, with the state-specific records that actually turn up in an
 * Indian title search kept rather than collapsed into "other".
 *
 * ⚠️ `rtc_pahani` and `mutation_extract` are NOT deeds — they are revenue
 * records showing possession and the recording of a transfer. They belong
 * in the chain because a chain of deeds with no mutation behind it is a
 * chain nobody acted on, which is its own warning.
 */
export const titleDocKindEnum = pgEnum("title_doc_kind", [
  "mother_deed",
  "sale_deed",
  "gift_deed",
  "partition_deed",
  "release_deed",
  "will",
  "court_decree",
  "mutation_extract",
  "encumbrance_certificate",
  "rtc_pahani",
  "khata_certificate",
  "conversion_order",
  "power_of_attorney",
  "other",
]);

/** ⭐ Area share hands back flats; revenue share hands back money. */
export const jdaShareTypeEnum = pgEnum("jda_share_type", [
  "area_share",
  "revenue_share",
  "hybrid",
]);

/**
 * ⭐ THE DC CONVERSION LADDER (agricultural → non-agricultural).
 * ⚠️ `khata_updated` is the LAST rung and the one everybody forgets. A DC
 * order with no khata update behind it means the revenue records still say
 * agricultural, and the buyer's bank will say no.
 */
export const conversionStageEnum = pgEnum("land_conversion_stage", [
  "applied",
  "rtc_verified",
  "dc_scrutiny",
  "fee_demanded",
  "fee_paid",
  "dc_order_issued",
  "khata_updated",
  "rejected",
]);

/**
 * ⭐ A-KHATA VS B-KHATA IS NOT A FORMATTING DIFFERENCE.
 * A B-khata property is outside the municipal register proper: banks will
 * not lend against it, and it cannot be legally transferred in the ordinary
 * way. Recording it as a plain string means somebody eventually filters on
 * the wrong spelling and sells something unsellable.
 */
export const khataTypeEnum = pgEnum("khata_type", [
  "a_khata",
  "b_khata",
  "e_khata",
  "none",
]);

export const estampStatusEnum = pgEnum("estamp_status", [
  "requested",
  "generated",
  "used",
  "cancelled",
  "failed",
]);

export const sanctionStatusEnum = pgEnum("sanction_status", [
  "not_started",
  "applied",
  "in_process",
  "query_raised",
  "approved",
  "rejected",
  "expired",
]);

export const verificationStatusEnum = pgEnum("land_verification_status", [
  "pending",
  "verified",
  "rejected",
  "expired",
]);

/**
 * ⭐ PAN-INDIA, BECAUSE THE PAPERWORK IS NOT NATIONAL.
 * Patta/chitta/adangal are Tamil Nadu; RTC is Karnataka; FMB is a survey
 * sketch. A product sold in one state that hard-codes another state's
 * vocabulary is a product that cannot be sold in the second state.
 */
export const dueDiligenceRecordTypeEnum = pgEnum("due_diligence_record_type", [
  "rera_certificate",
  "encumbrance_certificate",
  "land_record_ror",
  "rtc_pahani",
  "patta",
  "chitta",
  "adangal",
  "survey_sketch",
  "fmb",
  "na_order",
  "court_clearance",
  "town_planning_approval",
  "municipal_sanction",
  "master_plan_extract",
  "hill_area_clearance",
  "airport_height_clearance",
  "fire_noc",
  "environment_clearance",
  "water_approval",
  "electricity_approval",
  "land_title",
  "other",
]);

export const revenueRecordKindEnum = pgEnum("land_revenue_record_kind", [
  "khata",
  "patta",
  "chitta",
  "dc_conversion",
  "betterment",
  "property_tax",
  "other",
]);

/* ------------------------------------------------------------------ */
/* LAND PARCELS                                                        */
/* ------------------------------------------------------------------ */

export const landParcels = pgTable(
  "land_parcels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠️ NULLABLE, AND DELIBERATELY SO. A parcel is identified, negotiated
     * and often dropped long before a project exists. Requiring a project
     * would force somebody to invent one for land they are still deciding
     * about — and the parcels that never became projects are exactly the
     * ones worth being able to look back at.
     */
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    name: varchar("name", { length: 250 }).notNull(),

    /* --- Where it is, in the words the record office uses ----------- */
    surveyNumber: varchar("survey_number", { length: 120 }),
    village: varchar("village", { length: 150 }),
    hobli: varchar("hobli", { length: 150 }),
    taluk: varchar("taluk", { length: 150 }),
    district: varchar("district", { length: 150 }),
    state: varchar("state", { length: 120 }),
    /** Two-digit code, so this can join to GST place-of-supply. */
    stateCode: varchar("state_code", { length: 2 }),

    /**
     * ⭐ ACRE AND GUNTHA, BOTH, BECAUSE THAT IS HOW THE DOCUMENT READS.
     *
     * ⚠️ 1 acre = 40 guntha, NOT 100. Converting to a single decimal acre
     * figure at entry loses the form the deed is written in, and every
     * later comparison against the deed becomes a mental conversion
     * somebody eventually gets wrong. Store both; convert only to display.
     */
    extentAcre: numeric("extent_acre", { precision: 12, scale: 4 }),
    extentGuntha: numeric("extent_guntha", { precision: 12, scale: 3 }),
    /** Derived and stored for sorting only. Never the authority. */
    extentSqft: numeric("extent_sqft", { precision: 16, scale: 2 }),

    stage: landParcelStageEnum("stage").default("identified").notNull(),

    /* --- Money, in paise -------------------------------------------- */
    askingRateMinor: bigint("asking_rate_minor", { mode: "bigint" }),
    agreedRateMinor: bigint("agreed_rate_minor", { mode: "bigint" }),
    /** Total consideration, not per-unit. Kept apart from the rate. */
    considerationMinor: bigint("consideration_minor", { mode: "bigint" }),
    advancePaidMinor: bigint("advance_paid_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Ordinary owner name where there is no heir tree worth mapping. */
    ownerName: varchar("owner_name", { length: 300 }),

    registeredOn: date("registered_on"),
    /**
     * ⚠️ SET WHEN A PARCEL IS DROPPED, AND REQUIRED THEN. A parcel that
     * quietly disappears from the pipeline teaches nobody anything; the
     * reason it was dropped — bad title, a litigating heir, a price that
     * moved — is the institutional memory that stops it being looked at
     * again in two years.
     */
    droppedReason: text("dropped_reason"),

    notes: text("notes"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("land_parcels_tenant_idx").on(t.tenantId),
    stageIdx: index("land_parcels_stage_idx").on(t.tenantId, t.stage),
    projectIdx: index("land_parcels_project_idx").on(t.tenantId, t.projectId),
    surveyIdx: index("land_parcels_survey_idx").on(t.tenantId, t.village, t.surveyNumber),
    tenantIdUnique: uniqueIndex("land_parcels_id_tenant_unique").on(t.id, t.tenantId),

    /** 1 acre = 40 guntha. A parcel recorded as 45 guntha is a typo. */
    gunthaWithinAcre: check(
      "land_parcels_guntha_below_forty",
      sql`${t.extentGuntha} IS NULL OR (${t.extentGuntha} >= 0 AND ${t.extentGuntha} < 40)`,
    ),
    nonNegativeMoney: check(
      "land_parcels_money_non_negative",
      sql`COALESCE(${t.advancePaidMinor}, 0) >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ THE CHAIN OF TITLE                                                */
/* ------------------------------------------------------------------ */

export const titleDocuments = pgTable(
  "title_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parcelId: uuid("parcel_id").notNull(),

    kind: titleDocKindEnum("kind").default("other").notNull(),
    title: varchar("title", { length: 300 }).notNull(),

    /**
     * ⭐ POSITION IN THE CHAIN. 1 is the mother deed; each subsequent link
     * carries ownership forward. Unique per parcel, so two documents cannot
     * claim the same position and quietly hide one of them.
     */
    chainPosition: integer("chain_position").notNull(),

    /**
     * ⭐ THE TWO FIELDS THE WHOLE CHAIN TURNS ON. Link N's `fromParty` must
     * be link N−1's `toParty`. Where it is not, ownership passed through
     * somebody with no recorded right to pass it, and that is the defect
     * every title opinion is looking for.
     */
    fromParty: varchar("from_party", { length: 300 }),
    toParty: varchar("to_party", { length: 300 }),

    documentDate: date("document_date"),
    registeredOn: date("registered_on"),
    registrationNo: varchar("registration_no", { length: 120 }),
    /** The sub-registrar's office. Where a certified copy is obtained. */
    sroOffice: varchar("sro_office", { length: 200 }),

    /**
     * ⭐ THE EC SEARCH WINDOW. An encumbrance certificate certifies only
     * the years it covers. One for 2005–2015 says nothing about 2016, and
     * a file holding "an EC" without its window is a file that proves
     * less than the person relying on it believes.
     */
    periodFromYear: integer("period_from_year"),
    periodToYear: integer("period_to_year"),

    /** For an EC or khata that needs renewing before a transaction. */
    expiresOn: date("expires_on"),
    renewalNote: text("renewal_note"),

    documentId: uuid("document_id"),
    isVerified: boolean("is_verified").default(false).notNull(),
    verifiedBy: uuid("verified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    remarks: text("remarks"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("title_documents_tenant_idx").on(t.tenantId),
    chainIdx: index("title_documents_chain_idx").on(
      t.tenantId,
      t.parcelId,
      t.chainPosition,
    ),
    expiryIdx: index("title_documents_expiry_idx")
      .on(t.tenantId, t.expiresOn)
      .where(sql`${t.expiresOn} IS NOT NULL`),
    positionUnique: uniqueIndex("title_documents_position_unique").on(
      t.parcelId,
      t.chainPosition,
    ),
    tenantIdUnique: uniqueIndex("title_documents_id_tenant_unique").on(t.id, t.tenantId),

    positivePosition: check(
      "title_documents_position_positive",
      sql`${t.chainPosition} >= 1`,
    ),
    /** An EC window that runs backwards is a mis-keyed window. */
    sanePeriod: check(
      "title_documents_period_ordered",
      sql`${t.periodFromYear} IS NULL OR ${t.periodToYear} IS NULL OR ${t.periodFromYear} <= ${t.periodToYear}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ LANDOWNERS AND THE HEIR TREE                                      */
/* ------------------------------------------------------------------ */

export const landowners = pgTable(
  "landowners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parcelId: uuid("parcel_id"),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    name: varchar("name", { length: 300 }).notNull(),
    /** "son of", "widow of", "daughter of" — as the deed puts it. */
    relationToParent: varchar("relation_to_parent", { length: 120 }),
    parentId: uuid("parent_id"),

    isDeceased: boolean("is_deceased").default(false).notNull(),

    /**
     * ⭐ AN EXACT FRACTION, NOT A PERCENTAGE. Three heirs of an ancestral
     * property hold one third each. As percentages that is 33.33 three
     * times, summing to 99.99, and every check built on it is either
     * wrong or meaninglessly loose.
     */
    shareNum: integer("share_num"),
    shareDen: integer("share_den"),

    /**
     * ⚠️ A RELINQUISHMENT IS RECORDED, NOT ERASED. The heir existed and
     * held a share; a release deed transferred it. Deleting the row loses
     * the only evidence that the share was dealt with at all, and the
     * buyer's advocate will ask about that person by name.
     */
    relinquished: boolean("relinquished").default(false).notNull(),
    relinquishDeedNo: varchar("relinquish_deed_no", { length: 120 }),
    relinquishedOn: date("relinquished_on"),

    /** Needed for TDS under s.194-IA on the purchase consideration. */
    panNumber: varchar("pan_number", { length: 10 }),
    phone: varchar("phone", { length: 40 }),
    address: text("address"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("landowners_tenant_idx").on(t.tenantId),
    parcelIdx: index("landowners_parcel_idx").on(t.tenantId, t.parcelId),
    parentIdx: index("landowners_parent_idx").on(t.tenantId, t.parentId),
    tenantIdUnique: uniqueIndex("landowners_id_tenant_unique").on(t.id, t.tenantId),

    /** A share of x/0 is not a share. */
    saneShare: check(
      "landowners_share_valid",
      sql`(${t.shareNum} IS NULL AND ${t.shareDen} IS NULL)
          OR (${t.shareNum} >= 0 AND ${t.shareDen} > 0 AND ${t.shareNum} <= ${t.shareDen})`,
    ),
    /** A relinquishment without a deed number is hearsay. */
    relinquishNeedsDeed: check(
      "landowners_relinquish_has_deed",
      sql`${t.relinquished} = false OR ${t.relinquishDeedNo} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ JOINT DEVELOPMENT AGREEMENTS                                      */
/* ------------------------------------------------------------------ */

export const jointDevelopmentAgreements = pgTable(
  "joint_development_agreements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parcelId: uuid("parcel_id").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    agreementNo: varchar("agreement_no", { length: 120 }),
    landownerName: varchar("landowner_name", { length: 300 }).notNull(),

    /**
     * ⭐ AREA SHARE HANDS BACK FLATS. REVENUE SHARE HANDS BACK MONEY.
     * They are not two ways of saying the same thing: under area share the
     * landowner's flats are removed from saleable inventory before a single
     * booking, and a sales forecast that counts them is overstated by the
     * owner's entire share.
     */
    shareType: jdaShareTypeEnum("share_type").default("area_share").notNull(),

    /**
     * ⚠️ BASIS POINTS, NOT A DECIMAL PERCENTAGE, and they must sum to
     * 10000. A 42.5 / 57.5 split stored as two decimals invites a pair
     * that sums to 99.9, which is a silent quarter-crore on a mid-size
     * tower.
     */
    developerShareBps: integer("developer_share_bps"),
    landownerShareBps: integer("landowner_share_bps"),

    refundableDepositMinor: bigint("refundable_deposit_minor", { mode: "bigint" }),
    /** Non-refundable consideration, which is taxed differently. */
    nonRefundableMinor: bigint("non_refundable_minor", { mode: "bigint" }),

    signedOn: date("signed_on"),
    registeredOn: date("registered_on"),
    registrationNo: varchar("registration_no", { length: 120 }),

    /**
     * ⭐ THE OWNER'S FLATS, NAMED. Under an area-share JDA these units are
     * not ours to sell. Recording the intent in prose and nowhere else is
     * how one of them gets sold to a buyer.
     */
    ownerUnitIds: jsonb("owner_unit_ids")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    obligations: text("obligations"),
    /** Handover deadline. Breaching it usually triggers a penalty clause. */
    handoverDueOn: date("handover_due_on"),
    penaltyPerMonthMinor: bigint("penalty_per_month_minor", { mode: "bigint" }),

    documentId: uuid("document_id"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("jda_tenant_idx").on(t.tenantId),
    parcelIdx: index("jda_parcel_idx").on(t.tenantId, t.parcelId),
    tenantIdUnique: uniqueIndex("jda_id_tenant_unique").on(t.id, t.tenantId),

    /** ⭐ The split must be the whole of it. */
    sharesSumToWhole: check(
      "jda_shares_sum_to_whole",
      sql`(${t.developerShareBps} IS NULL AND ${t.landownerShareBps} IS NULL)
          OR (${t.developerShareBps} + ${t.landownerShareBps} = 10000)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* CONVERSION, KHATA, E-STAMP, POA                                     */
/* ------------------------------------------------------------------ */

export const landConversions = pgTable(
  "land_conversions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parcelId: uuid("parcel_id"),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    surveyNo: varchar("survey_no", { length: 120 }).notNull(),
    village: varchar("village", { length: 150 }),
    taluk: varchar("taluk", { length: 150 }),
    extentAcre: numeric("extent_acre", { precision: 12, scale: 4 }),

    fromUse: varchar("from_use", { length: 60 }).default("agricultural").notNull(),
    toUse: varchar("to_use", { length: 60 }).default("residential").notNull(),

    stage: conversionStageEnum("stage").default("applied").notNull(),
    dcOrderNo: varchar("dc_order_no", { length: 120 }),
    conversionFeeMinor: bigint("conversion_fee_minor", { mode: "bigint" }),

    appliedOn: date("applied_on"),
    orderedOn: date("ordered_on"),
    khataUpdatedOn: date("khata_updated_on"),
    rejectionReason: text("rejection_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("land_conversions_tenant_idx").on(t.tenantId),
    stageIdx: index("land_conversions_stage_idx").on(t.tenantId, t.stage),
    parcelIdx: index("land_conversions_parcel_idx").on(t.tenantId, t.parcelId),
    tenantIdUnique: uniqueIndex("land_conversions_id_tenant_unique").on(t.id, t.tenantId),
  }),
);

export const khataRecords = pgTable(
  "khata_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parcelId: uuid("parcel_id"),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),

    khataType: khataTypeEnum("khata_type").default("none").notNull(),
    /** Property identification number — ward/street/plot. */
    pid: varchar("pid", { length: 80 }),
    khataNo: varchar("khata_no", { length: 120 }),
    assessmentNo: varchar("assessment_no", { length: 120 }),
    ownerName: varchar("owner_name", { length: 300 }),

    lastEcOn: date("last_ec_on"),
    ecClear: boolean("ec_clear").default(false).notNull(),
    propertyTaxPaidUpto: date("property_tax_paid_upto"),

    remarks: text("remarks"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("khata_records_tenant_idx").on(t.tenantId),
    typeIdx: index("khata_records_type_idx").on(t.tenantId, t.khataType),
    unitIdx: index("khata_records_unit_idx").on(t.tenantId, t.unitId),
    parcelIdx: index("khata_records_parcel_idx").on(t.tenantId, t.parcelId),
  }),
);

export const estampCertificates = pgTable(
  "estamp_certificates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    parcelId: uuid("parcel_id"),
    bookingId: uuid("booking_id"),

    purpose: varchar("purpose", { length: 250 }).notNull(),
    considerationMinor: bigint("consideration_minor", { mode: "bigint" }),
    /** Stamp duty payable. Paise, like everything else. */
    dutyMinor: bigint("duty_minor", { mode: "bigint" }).notNull(),

    /**
     * ⭐ THE SHCIL CERTIFICATE NUMBER — UNIQUE PER TENANT, ALWAYS.
     * An e-stamp certificate may be used once. The same number appearing
     * on two documents means one of them is void, and the party who finds
     * out is a registrar refusing to register.
     */
    certificateNo: varchar("certificate_no", { length: 80 }),
    status: estampStatusEnum("status").default("requested").notNull(),
    providerRef: varchar("provider_ref", { length: 120 }),

    firstParty: varchar("first_party", { length: 300 }),
    secondParty: varchar("second_party", { length: 300 }),

    issuedOn: date("issued_on"),
    usedOn: date("used_on"),
    cancelledReason: text("cancelled_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("estamp_certificates_tenant_idx").on(t.tenantId),
    statusIdx: index("estamp_certificates_status_idx").on(t.tenantId, t.status),
    certUnique: uniqueIndex("estamp_certificates_no_unique")
      .on(t.tenantId, t.certificateNo)
      .where(sql`${t.certificateNo} IS NOT NULL`),
    nonNegativeDuty: check("estamp_duty_non_negative", sql`${t.dutyMinor} >= 0`),
  }),
);

export const powersOfAttorney = pgTable(
  "powers_of_attorney",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parcelId: uuid("parcel_id"),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    grantor: varchar("grantor", { length: 300 }).notNull(),
    attorney: varchar("attorney", { length: 300 }).notNull(),
    scope: text("scope").notNull(),
    isRegistered: boolean("is_registered").default(false).notNull(),
    registrationNo: varchar("registration_no", { length: 120 }),

    validFrom: date("valid_from"),
    validUntil: date("valid_until"),

    /**
     * ⚠️ REVOKED, NOT DELETED. A deed executed under a POA that was live
     * at the time stays good after revocation. Deleting the row destroys
     * the evidence that it was live then.
     */
    revoked: boolean("revoked").default(false).notNull(),
    revokedOn: date("revoked_on"),
    revocationDeedNo: varchar("revocation_deed_no", { length: 120 }),

    documentId: uuid("document_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("poa_tenant_idx").on(t.tenantId),
    validityIdx: index("poa_validity_idx").on(t.tenantId, t.validUntil),
    parcelIdx: index("poa_parcel_idx").on(t.tenantId, t.parcelId),
  }),
);

/* ------------------------------------------------------------------ */
/* DUE DILIGENCE, SANCTIONS, LIAISON                                   */
/* ------------------------------------------------------------------ */

export const dueDiligenceRecords = pgTable(
  "due_diligence_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    parcelId: uuid("parcel_id"),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),

    recordType: dueDiligenceRecordTypeEnum("record_type").notNull(),
    /** The state decides which vocabulary applies. Not decorative. */
    state: varchar("state", { length: 120 }).notNull(),
    region: varchar("region", { length: 150 }),
    authorityName: varchar("authority_name", { length: 250 }).notNull(),
    reference: varchar("reference", { length: 200 }),

    documentId: uuid("document_id"),
    validUntil: date("valid_until"),
    verificationStatus: verificationStatusEnum("verification_status")
      .default("pending")
      .notNull(),
    verifiedBy: uuid("verified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("dd_records_tenant_idx").on(t.tenantId),
    typeIdx: index("dd_records_type_idx").on(t.tenantId, t.recordType),
    statusIdx: index("dd_records_status_idx").on(t.tenantId, t.verificationStatus),
    /** The report everybody actually opens: what expires soon. */
    expiryIdx: index("dd_records_expiry_idx")
      .on(t.tenantId, t.validUntil)
      .where(sql`${t.validUntil} IS NOT NULL`),
  }),
);

export const approvalSanctions = pgTable(
  "approval_sanctions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parcelId: uuid("parcel_id"),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    /** BBMP, BDA, BMRDA, BESCOM, BWSSB, DTCP, fire, pollution board… */
    authority: varchar("authority", { length: 150 }).notNull(),
    name: varchar("name", { length: 250 }).notNull(),
    status: sanctionStatusEnum("status").default("not_started").notNull(),

    appliedOn: date("applied_on"),
    expectedOn: date("expected_on"),
    approvedOn: date("approved_on"),
    expiresOn: date("expires_on"),

    feePaidMinor: bigint("fee_paid_minor", { mode: "bigint" }),
    /** Which desk the file is sitting on right now. */
    currentDesk: varchar("current_desk", { length: 200 }),
    referenceNo: varchar("reference_no", { length: 150 }),
    queryRaised: text("query_raised"),

    documentId: uuid("document_id"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("approval_sanctions_tenant_idx").on(t.tenantId),
    statusIdx: index("approval_sanctions_status_idx").on(t.tenantId, t.status),
    expectedIdx: index("approval_sanctions_expected_idx").on(t.tenantId, t.expectedOn),
    tenantIdUnique: uniqueIndex("approval_sanctions_id_tenant_unique").on(
      t.id,
      t.tenantId,
    ),
  }),
);

/**
 * A record of chasing a file: who went, who they saw, what was said.
 *
 * ⚠️ THIS IS A DIARY OF LEGITIMATE FOLLOW-UP AND NOTHING ELSE. It exists
 * because an approval that has sat for eleven weeks is a schedule risk
 * somebody has to be able to evidence — to a lender, to a board, in an
 * extension-of-time claim. It records visits and conversations. It has no
 * field for a payment and must never acquire one.
 */
export const liaisonLogs = pgTable(
  "liaison_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").notNull(),

    chasedBy: uuid("chased_by").references(() => users.id, { onDelete: "set null" }),
    chasedByName: varchar("chased_by_name", { length: 200 }),
    metWith: varchar("met_with", { length: 200 }),
    note: text("note").notNull(),
    chasedOn: timestamp("chased_on", { withTimezone: true }).defaultNow().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("liaison_logs_tenant_idx").on(t.tenantId),
    approvalIdx: index("liaison_logs_approval_idx").on(
      t.tenantId,
      t.approvalId,
      t.chasedOn,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ PLAN SANCTION AND THE OC                                          */
/* ------------------------------------------------------------------ */

export const planSanctions = pgTable(
  "plan_sanctions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    sanctionNo: varchar("sanction_no", { length: 150 }),
    authority: varchar("authority", { length: 100 }).notNull(),

    /**
     * ⭐ FLOOR AREA RATIO, SANCTIONED AGAINST BUILT.
     *
     * ⚠️ IN BASIS POINTS. An FAR of 2.75 stored as a decimal invites a
     * comparison that rounds; stored as 27500 it does not. The gap between
     * these two numbers is the single fact that decides whether the
     * occupancy certificate issues — and without an OC the building cannot
     * be lawfully occupied, buyers cannot register, and banks will not
     * disburse. A tower can be finished and worthless.
     */
    sanctionedFarBps: integer("sanctioned_far_bps").notNull(),
    builtFarBps: integer("built_far_bps").default(0).notNull(),

    sanctionedAreaSqft: numeric("sanctioned_area_sqft", { precision: 16, scale: 2 }),
    builtAreaSqft: numeric("built_area_sqft", { precision: 16, scale: 2 }),

    /**
     * ⚠️ DERIVED BY TRIGGER FROM THE TWO FAR FIGURES, NEVER TYPED.
     * A deviation percentage that can be written independently of the
     * numbers it comes from is a number that will eventually disagree with
     * them, and it will disagree in the reassuring direction.
     */
    deviationBps: integer("deviation_bps").default(0).notNull(),

    ocApplied: boolean("oc_applied").default(false).notNull(),
    ocReceived: boolean("oc_received").default(false).notNull(),
    ocNumber: varchar("oc_number", { length: 150 }),
    ocReceivedOn: date("oc_received_on"),

    /** Set where a deviation was regularised by the authority. */
    regularisationRef: varchar("regularisation_ref", { length: 150 }),

    sanctionedOn: date("sanctioned_on"),
    validUntil: date("valid_until"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("plan_sanctions_tenant_idx").on(t.tenantId),
    projectIdx: index("plan_sanctions_project_idx").on(t.tenantId, t.projectId),
    positiveFar: check(
      "plan_sanctions_far_positive",
      sql`${t.sanctionedFarBps} > 0 AND ${t.builtFarBps} >= 0`,
    ),
  }),
);

export const landRevenueRecords = pgTable(
  "land_revenue_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parcelId: uuid("parcel_id").notNull(),

    kind: revenueRecordKindEnum("kind").default("other").notNull(),
    reference: varchar("reference", { length: 200 }),
    authority: varchar("authority", { length: 200 }),
    paidToDate: date("paid_to_date"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    documentId: uuid("document_id"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("land_revenue_records_tenant_idx").on(t.tenantId),
    parcelKindIdx: index("land_revenue_records_parcel_idx").on(
      t.tenantId,
      t.parcelId,
      t.kind,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const landParcelsRelations = relations(landParcels, ({ one, many }) => ({
  tenant: one(tenants, { fields: [landParcels.tenantId], references: [tenants.id] }),
  project: one(projects, {
    fields: [landParcels.projectId],
    references: [projects.id],
  }),
  titleDocuments: many(titleDocuments),
  jdas: many(jointDevelopmentAgreements),
  revenueRecords: many(landRevenueRecords),
}));

export const titleDocumentsRelations = relations(titleDocuments, ({ one }) => ({
  parcel: one(landParcels, {
    fields: [titleDocuments.parcelId],
    references: [landParcels.id],
  }),
}));

export const landownersRelations = relations(landowners, ({ one, many }) => ({
  parent: one(landowners, {
    fields: [landowners.parentId],
    references: [landowners.id],
    relationName: "heirTree",
  }),
  children: many(landowners, { relationName: "heirTree" }),
}));

export const jdaRelations = relations(jointDevelopmentAgreements, ({ one }) => ({
  parcel: one(landParcels, {
    fields: [jointDevelopmentAgreements.parcelId],
    references: [landParcels.id],
  }),
}));

export const approvalSanctionsRelations = relations(
  approvalSanctions,
  ({ one, many }) => ({
    parcel: one(landParcels, {
      fields: [approvalSanctions.parcelId],
      references: [landParcels.id],
    }),
    liaisonLogs: many(liaisonLogs),
  }),
);

export const liaisonLogsRelations = relations(liaisonLogs, ({ one }) => ({
  approval: one(approvalSanctions, {
    fields: [liaisonLogs.approvalId],
    references: [approvalSanctions.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type LandParcel = typeof landParcels.$inferSelect;
export type NewLandParcel = typeof landParcels.$inferInsert;
export type TitleDocument = typeof titleDocuments.$inferSelect;
export type Landowner = typeof landowners.$inferSelect;
export type JointDevelopmentAgreement =
  typeof jointDevelopmentAgreements.$inferSelect;
export type LandConversion = typeof landConversions.$inferSelect;
export type KhataRecord = typeof khataRecords.$inferSelect;
export type EstampCertificate = typeof estampCertificates.$inferSelect;
export type PowerOfAttorney = typeof powersOfAttorney.$inferSelect;
export type DueDiligenceRecord = typeof dueDiligenceRecords.$inferSelect;
export type ApprovalSanction = typeof approvalSanctions.$inferSelect;
export type PlanSanction = typeof planSanctions.$inferSelect;

export type LandParcelStage = (typeof landParcelStageEnum.enumValues)[number];
export type KhataType = (typeof khataTypeEnum.enumValues)[number];

/**
 * ⭐ 1 ACRE = 40 GUNTHA = 43,560 SQ FT. Stated once, here, so no screen
 * re-derives it from memory. A guntha is 1,089 sq ft exactly.
 */
export const SQFT_PER_ACRE = 43560;
export const GUNTHA_PER_ACRE = 40;
export const SQFT_PER_GUNTHA = 1089;

/**
 * ⚠️ KHATA TYPES A BANK WILL NOT LEND AGAINST. A B-khata property can be
 * bought, but the buyer needs cash — which removes most of the market for
 * it. Exported so a sales screen can warn before somebody quotes a price.
 */
export const UNLOANABLE_KHATA: readonly KhataType[] = ["b_khata", "none"];
