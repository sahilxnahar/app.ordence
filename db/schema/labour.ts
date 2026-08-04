/**
 * Ordence — ⭐ Labour, Welfare and Site Records
 * Version: v0.45.0-alpha  ·  PORT WAVE C
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PEOPLE ON SITE ARE THE LIABILITY NOBODY BUDGETS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Wave B encoded the money side of the principal-employer problem: a
 * contractor with no verified EPF/ESI challan does not get paid. This
 * wave is the other half — the WORKERS themselves, and the obligations
 * that attach to a developer because they are on his land.
 *
 * Three of those obligations have teeth:
 *
 *   ⭐ THE UAN. A Universal Account Number is a worker's provident fund
 *     identity. A worker on site with an invalid or missing UAN is a
 *     worker whose PF is not being credited to anyone — and under the EPF
 *     Act that becomes the principal employer's problem, not the
 *     labour contractor's.
 *
 *   ⭐ BOCW WELFARE. The Building and Other Construction Workers Act
 *     obliges the employer to provide drinking water, sanitation, a
 *     creche where women workers are employed, first aid and rest
 *     shelter. Inspections ask for EVIDENCE, not assurances, which is why
 *     a welfare log carries a headcount and a photograph.
 *
 *   ⭐ THE VENDOR DEFAULT REGISTER. A subcontractor who abandoned a site
 *     last year is a subcontractor about to be engaged again by a
 *     different project manager who was not there. The register is
 *     deliberately CROSS-PROJECT: the history follows the man.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT STORE
 * ══════════════════════════════════════════════════════════════════════
 * No Aadhaar number. No caste, religion or community. No medical detail
 * beyond the fact that a medical camp happened and how many attended.
 * A construction workforce is among the most vulnerable populations a
 * software system touches, and a field that exists will eventually be
 * filled, exported, and leaked. Attendance carries a location because a
 * geofence is the point; it carries no continuous tracking.
 *
 * Money is `bigint` paise. Quantities are `numeric(18,3)`.
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
import { projects } from "./sales";
import { vendors } from "./purchases";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE STATE OF A WORKER'S PROVIDENT FUND IDENTITY.
 *
 * ⚠️ `pending` IS NOT `valid`. A UAN that has been typed but never
 * checked against the EPFO record is a number, not an identity — and the
 * gate below treats it as unverified, because a system that let
 * "somebody typed it in" count as verification would produce exactly the
 * false assurance an inspection is looking for.
 */
export const uanStatusEnum = pgEnum("uan_status", [
  "pending",
  "valid",
  "invalid",
  "not_applicable",
]);

/**
 * ⭐ BOCW WELFARE CATEGORIES, NAMED AS THE ACT NAMES THEM.
 *
 * ⚠️ `creche` IS ON THIS LIST BECAUSE THE ACT REQUIRES ONE where women
 * workers are employed, and it is the provision most often missing when
 * an inspector arrives. A free-text category field would let a site log
 * "welfare — done" and satisfy nobody.
 */
export const welfareCategoryEnum = pgEnum("welfare_category", [
  "drinking_water",
  "sanitation",
  "creche",
  "first_aid",
  "rest_shelter",
  "medical_camp",
  "safety_training",
  "canteen",
  "accommodation",
  "other",
]);

export const attendanceKindEnum = pgEnum("attendance_kind", [
  "check_in",
  "check_out",
]);

export const shiftKindEnum = pgEnum("shift_kind", [
  "morning",
  "evening",
  "night",
  "full_day",
  "off",
]);

/**
 * ⭐ WHAT A CONTRACTOR DID WRONG.
 *
 * ⚠️ `abandonment` IS FIRST BECAUSE IT IS THE ONE THAT COSTS MOST. A
 * subcontractor who walks off a half-finished slab leaves work that must
 * be surveyed, condemned or rebuilt before anybody else will touch it.
 */
export const vendorDefaultKindEnum = pgEnum("vendor_default_kind", [
  "abandonment",
  "quality_failure",
  "delay",
  "financial",
  "safety",
  "labour_compliance",
  "other",
]);

/**
 * ⚠️ `blacklist` IS A SEPARATE SEVERITY, NOT THE TOP OF A SCALE. Low,
 * medium and high describe one incident. Blacklist is a decision about
 * the relationship, taken by a person, and the database requires a
 * reason for it (SQL 0032 §5).
 */
export const vendorDefaultSeverityEnum = pgEnum("vendor_default_severity", [
  "low",
  "medium",
  "high",
  "blacklist",
]);

/* ------------------------------------------------------------------ */
/* ⭐ WORKERS AND THEIR UAN                                             */
/* ------------------------------------------------------------------ */

export const siteWorkers = pgTable(
  "site_workers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** The labour contractor who brought this worker. */
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    workerName: varchar("worker_name", { length: 200 }).notNull(),
    /** Free text — mason, bar bender, carpenter, helper. */
    trade: varchar("trade", { length: 100 }),

    /**
     * ⭐ THE UNIVERSAL ACCOUNT NUMBER — 12 DIGITS.
     *
     * ⚠️ UNIQUE PER TENANT, and that uniqueness is doing real work. One
     * UAN appearing against two workers means somebody has been issued a
     * gate pass under another man's provident fund identity — which is
     * either a data-entry error or the exact substitution that makes a
     * PF record meaningless.
     */
    uan: varchar("uan", { length: 12 }),
    uanStatus: uanStatusEnum("uan_status").default("pending").notNull(),
    uanVerifiedAt: timestamp("uan_verified_at", { withTimezone: true }),
    uanVerifiedBy: uuid("uan_verified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    uanRejectionReason: text("uan_rejection_reason"),

    /**
     * ⭐ WHETHER THIS WORKER MAY BE ADMITTED TO SITE RIGHT NOW.
     *
     * ⚠️ MAINTAINED BY TRIGGER FROM `uanStatus` AND `blockedReason`, not
     * typed. The gate guard reads one column and gets a yes or a no; the
     * reasoning lives in one place rather than being re-derived by every
     * scanner, turnstile and mobile app that ever asks.
     */
    isAdmissible: boolean("is_admissible").default(false).notNull(),
    blockedReason: text("blocked_reason"),

    inductedOn: date("inducted_on"),
    exitedOn: date("exited_on"),

    /**
     * ⚠️ NO AADHAAR, NO COMMUNITY, NO MEDICAL HISTORY. See the file
     * header. A photograph for gate identification is the only
     * identifying artefact, and it is a document reference rather than
     * bytes in this table.
     */
    photoDocumentId: uuid("photo_document_id"),
    phone: varchar("phone", { length: 20 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("site_workers_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("site_workers_tenant_idx").on(t.tenantId),
    uanUnique: uniqueIndex("site_workers_uan_unique")
      .on(t.tenantId, t.uan)
      .where(sql`${t.uan} IS NOT NULL`),
    vendorIdx: index("site_workers_vendor_idx").on(t.tenantId, t.vendorId),
    projectIdx: index("site_workers_project_idx").on(t.tenantId, t.projectId),
    /** The gate query: who may come in today. */
    admissibleIdx: index("site_workers_admissible_idx").on(
      t.tenantId,
      t.projectId,
      t.isAdmissible,
    ),
    statusIdx: index("site_workers_uan_status_idx").on(t.tenantId, t.uanStatus),
    tenantIdUnique: uniqueIndex("site_workers_id_tenant_unique").on(t.id, t.tenantId),

    /** A UAN is exactly twelve digits or it is not a UAN. */
    uanShape: check(
      "site_workers_uan_shape",
      sql`${t.uan} IS NULL OR ${t.uan} ~ '^[0-9]{12}$'`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ BOCW WELFARE LOG                                                  */
/* ------------------------------------------------------------------ */

export const welfareLogs = pgTable(
  "welfare_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    category: welfareCategoryEnum("category").notNull(),
    loggedOn: date("logged_on").notNull(),

    /**
     * ⚠️ HEADCOUNT MATTERS BECAUSE THE OBLIGATION SCALES. A creche is
     * required above a threshold of women workers; a canteen above a
     * threshold of workers. "We provided drinking water" without a number
     * does not answer the question an inspector actually asks.
     */
    headcount: integer("headcount"),

    /**
     * ⭐ THE PHOTOGRAPH IS THE EVIDENCE, AND IT IS REQUIRED FOR THE
     * CATEGORIES THAT GET INSPECTED (SQL 0032 §3). An entry that says a
     * creche was provided, with nothing attached, is worth precisely as
     * much as saying it out loud.
     */
    photoDocumentId: uuid("photo_document_id"),
    note: text("note"),

    loggedBy: uuid("logged_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("welfare_logs_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("welfare_logs_tenant_idx").on(t.tenantId),
    projectDateIdx: index("welfare_logs_project_date_idx").on(
      t.tenantId,
      t.projectId,
      t.loggedOn,
    ),
    categoryIdx: index("welfare_logs_category_idx").on(t.tenantId, t.category),
    nonNegativeHeadcount: check(
      "welfare_logs_headcount_non_negative",
      sql`${t.headcount} IS NULL OR ${t.headcount} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* PIECE-RATE WORK                                                     */
/* ------------------------------------------------------------------ */

export const pieceRateEntries = pgTable(
  "piece_rate_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),

    workItem: varchar("work_item", { length: 300 }).notNull(),
    /** sqft, cum, nos, rmt — the unit the rate was agreed in. */
    unit: varchar("unit", { length: 20 }).default("sqft").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    ratePerUnitMinor: bigint("rate_per_unit_minor", { mode: "bigint" }).notNull(),

    /** ⚠️ Derived by trigger. Quantity × rate, half-up, in paise. */
    amountMinor: bigint("amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * ⚠️ THE DATE THE WORK WAS MEASURED, NOT THE DATE IT WAS ENTERED.
     * Piece-rate measurement is a joint exercise with the contractor's
     * man present. Recording the entry date instead loses the only fact
     * that makes the measurement contestable.
     */
    measuredOn: date("measured_on").notNull(),
    measuredBy: uuid("measured_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The contractor's representative who was present. */
    witnessedByName: varchar("witnessed_by_name", { length: 200 }),

    /** Set once this measurement has been carried into an RA bill. */
    raBillId: uuid("ra_bill_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("piece_rate_entries_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("piece_rate_entries_tenant_idx").on(t.tenantId),
    projectIdx: index("piece_rate_entries_project_idx").on(
      t.tenantId,
      t.projectId,
      t.measuredOn,
    ),
    vendorIdx: index("piece_rate_entries_vendor_idx").on(t.tenantId, t.vendorId),
    billedIdx: index("piece_rate_entries_billed_idx")
      .on(t.tenantId, t.raBillId)
      .where(sql`${t.raBillId} IS NULL`),

    positiveQuantity: check("piece_rate_quantity_positive", sql`${t.quantity} > 0`),
    nonNegativeRate: check("piece_rate_rate_non_negative", sql`${t.ratePerUnitMinor} >= 0`),
  }),
);

/* ------------------------------------------------------------------ */
/* ATTENDANCE AND ROSTER                                               */
/* ------------------------------------------------------------------ */

export const siteAttendance = pgTable(
  "site_attendance",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Either a staff user or a site worker. Exactly one. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id"),

    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    kind: attendanceKindEnum("kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /* --- Where, and how far from the site --------------------------- */
    latitude: numeric("latitude", { precision: 10, scale: 7 }),
    longitude: numeric("longitude", { precision: 10, scale: 7 }),
    accuracyMetres: integer("accuracy_metres"),
    distanceMetres: integer("distance_metres"),

    /**
     * ⭐ THE GEOFENCE VERDICT, RECORDED RATHER THAN RECOMPUTED.
     *
     * ⚠️ A site's coordinates can be corrected later, and a boundary can
     * be redrawn. Re-deriving "was he on site" from today's geofence
     * would silently rewrite last month's attendance — and attendance is
     * what wage disputes are settled on.
     */
    withinSite: boolean("within_site").default(false).notNull(),

    /**
     * ⭐ CAPTURED WITH NO SIGNAL, SYNCED LATER.
     *
     * ⚠️ FLAGGED, NOT HIDDEN. An offline punch is a claim about a time
     * that the device recorded and the server did not witness. It is
     * usually true and it is occasionally a phone with its clock moved.
     * Marking it lets a supervisor weigh it; discarding the flag would
     * make every record look equally verified.
     */
    isOffline: boolean("is_offline").default(false).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),

    photoDocumentId: uuid("photo_document_id"),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("site_attendance_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("site_attendance_tenant_idx").on(t.tenantId),
    userIdx: index("site_attendance_user_idx").on(t.tenantId, t.userId, t.occurredAt),
    workerIdx: index("site_attendance_worker_idx").on(
      t.tenantId,
      t.workerId,
      t.occurredAt,
    ),
    projectIdx: index("site_attendance_project_idx").on(
      t.tenantId,
      t.projectId,
      t.occurredAt,
    ),
    /** Reviewing offline punches is a real weekly task. */
    offlineIdx: index("site_attendance_offline_idx")
      .on(t.tenantId, t.occurredAt)
      .where(sql`${t.isOffline} = true`),

    /** Exactly one subject. A punch for nobody is not a punch. */
    oneSubject: check(
      "site_attendance_one_subject",
      sql`(${t.userId} IS NOT NULL AND ${t.workerId} IS NULL)
          OR (${t.userId} IS NULL AND ${t.workerId} IS NOT NULL)`,
    ),
  }),
);

export const dutyRosters = pgTable(
  "duty_rosters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    rosterDate: date("roster_date").notNull(),
    shift: shiftKindEnum("shift").default("full_day").notNull(),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("duty_rosters_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("duty_rosters_tenant_idx").on(t.tenantId),
    /** One person, one shift, one day. */
    slotUnique: uniqueIndex("duty_rosters_slot_unique").on(t.userId, t.rosterDate),
    dateIdx: index("duty_rosters_date_idx").on(t.tenantId, t.rosterDate),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ THE VENDOR DEFAULT REGISTER — CROSS-PROJECT ON PURPOSE            */
/* ------------------------------------------------------------------ */

export const vendorDefaults = pgTable(
  "vendor_defaults",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),

    /**
     * ⚠️ NULLABLE, AND THAT IS THE ENTIRE DESIGN. A default recorded
     * against a project is invisible to the next project's manager, who
     * is exactly the person about to engage this contractor again. The
     * project is recorded as CONTEXT; the register is read across all of
     * them.
     */
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    kind: vendorDefaultKindEnum("kind").notNull(),
    severity: vendorDefaultSeverityEnum("severity").default("medium").notNull(),

    occurredOn: date("occurred_on").notNull(),
    /** What happened, in enough detail to be fair to the contractor. */
    description: text("description").notNull(),
    estimatedCostMinor: bigint("estimated_cost_minor", { mode: "bigint" }),

    /**
     * ⚠️ A BLACKLISTING IS A DECISION ABOUT A LIVELIHOOD. It requires a
     * named approver and stays visible to the contractor's own portal if
     * one exists. A register that can blacklist anonymously is a register
     * that will be used to settle arguments.
     */
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),

    /** Cleared once remedied — the row stays, the flag lifts. */
    resolvedOn: date("resolved_on"),
    resolutionNote: text("resolution_note"),

    reportedBy: uuid("reported_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("vendor_defaults_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("vendor_defaults_tenant_idx").on(t.tenantId),
    /** ⭐ The lookup that matters: this contractor's whole history. */
    vendorIdx: index("vendor_defaults_vendor_idx").on(t.tenantId, t.vendorId),
    severityIdx: index("vendor_defaults_severity_idx").on(t.tenantId, t.severity),
    openIdx: index("vendor_defaults_open_idx")
      .on(t.tenantId, t.vendorId)
      .where(sql`${t.resolvedOn} IS NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* DAILY SITE LOG                                                      */
/* ------------------------------------------------------------------ */

export const dailySiteLogs = pgTable(
  "daily_site_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    logDate: date("log_date").notNull(),

    /**
     * ⭐ WEATHER IS NOT SMALL TALK. It is the primary evidence in an
     * extension-of-time claim: a contractor asserting rain days needs a
     * contemporaneous record, and so does a developer disputing them.
     * Recorded daily, it is evidence; reconstructed afterwards, it is
     * an assertion.
     */
    weather: varchar("weather", { length: 100 }),
    rainfallMm: numeric("rainfall_mm", { precision: 8, scale: 2 }),
    /** Hours actually lost to weather, if any. */
    hoursLost: numeric("hours_lost", { precision: 5, scale: 2 }),

    labourCount: integer("labour_count").default(0).notNull(),
    /** Breakdown by trade, where the site bothers. */
    labourByTrade: jsonb("labour_by_trade")
      .$type<Record<string, number>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    workDone: text("work_done"),
    issues: text("issues"),
    visitors: text("visitors"),

    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("daily_site_logs_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("daily_site_logs_tenant_idx").on(t.tenantId),
    /** One log per project per day. Two is two versions of one day. */
    slotUnique: uniqueIndex("daily_site_logs_slot_unique").on(t.projectId, t.logDate),
    dateIdx: index("daily_site_logs_date_idx").on(t.tenantId, t.logDate),
    tenantIdUnique: uniqueIndex("daily_site_logs_id_tenant_unique").on(t.id, t.tenantId),
    nonNegativeLabour: check(
      "daily_site_logs_labour_non_negative",
      sql`${t.labourCount} >= 0`,
    ),
  }),
);

export const sitePhotos = pgTable(
  "site_photos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    dailySiteLogId: uuid("daily_site_log_id").notNull(),

    documentId: uuid("document_id"),
    /**
     * ⭐ WHAT THIS PHOTOGRAPH IS OF — a milestone tag such as
     * "tower-a/slab-7/pour". Progress photographs are what lenders,
     * buyers and RERA filings all ask for, and an untagged pile of images
     * answers none of those questions.
     */
    milestoneTag: varchar("milestone_tag", { length: 150 }).notNull(),
    caption: text("caption"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("site_photos_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("site_photos_tenant_idx").on(t.tenantId),
    logIdx: index("site_photos_log_idx").on(t.tenantId, t.dailySiteLogId),
    tagIdx: index("site_photos_tag_idx").on(t.tenantId, t.milestoneTag),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS & TYPES                                                   */
/* ------------------------------------------------------------------ */

export const siteWorkersRelations = relations(siteWorkers, ({ one }) => ({
  vendor: one(vendors, { fields: [siteWorkers.vendorId], references: [vendors.id] }),
  project: one(projects, {
    fields: [siteWorkers.projectId],
    references: [projects.id],
  }),
}));

export const vendorDefaultsRelations = relations(vendorDefaults, ({ one }) => ({
  vendor: one(vendors, { fields: [vendorDefaults.vendorId], references: [vendors.id] }),
}));

export const dailySiteLogsRelations = relations(dailySiteLogs, ({ one, many }) => ({
  project: one(projects, {
    fields: [dailySiteLogs.projectId],
    references: [projects.id],
  }),
  photos: many(sitePhotos),
}));

export const sitePhotosRelations = relations(sitePhotos, ({ one }) => ({
  log: one(dailySiteLogs, {
    fields: [sitePhotos.dailySiteLogId],
    references: [dailySiteLogs.id],
  }),
}));

export type SiteWorker = typeof siteWorkers.$inferSelect;
export type WelfareLog = typeof welfareLogs.$inferSelect;
export type PieceRateEntry = typeof pieceRateEntries.$inferSelect;
export type SiteAttendance = typeof siteAttendance.$inferSelect;
export type DutyRoster = typeof dutyRosters.$inferSelect;
export type VendorDefault = typeof vendorDefaults.$inferSelect;
export type DailySiteLog = typeof dailySiteLogs.$inferSelect;
export type WelfareCategory = (typeof welfareCategoryEnum.enumValues)[number];

/**
 * ⭐ WELFARE CATEGORIES THAT REQUIRE PHOTOGRAPHIC EVIDENCE.
 *
 * ⚠️ These are the provisions an inspector physically walks over to look
 * at. A log entry for one of them with nothing attached is worth exactly
 * as much as saying it out loud, which is why SQL 0032 §3 refuses it.
 */
export const WELFARE_NEEDS_PHOTO: readonly WelfareCategory[] = [
  "drinking_water",
  "sanitation",
  "creche",
  "first_aid",
  "rest_shelter",
];
