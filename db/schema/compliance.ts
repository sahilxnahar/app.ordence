/**
 * Ordence — ⭐ ENGINE 4 · THE COMPLIANCE CALENDAR
 * Version: v0.57.0-alpha  ·  Session 1, Part 1
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE CHEAPEST ENGINE, AND THE ONE ALL TEN INDUSTRIES NEED
 * ══════════════════════════════════════════════════════════════════════
 * A hotel renews an FSSAI licence. A hospital files biomedical-waste
 * returns. A logistics firm watches vehicle fitness certificates. A CA
 * firm files GSTR-3B for four hundred clients. A distributor files its
 * own. Every one of those is the same four facts:
 *
 *   WHAT must be done · FOR WHOM · BY WHEN · WHAT IT COSTS TO BE LATE
 *
 * One table, one reminder ladder, one evidence store. Only the seed data
 * differs between a hospital and a haulier. That is why this is built
 * first: it is the smallest engine on the list and it appears in the
 * largest number of verticals.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DESIGN DECISION THAT MAKES IT SERVE A CA FIRM
 * ══════════════════════════════════════════════════════════════════════
 * An obligation is not always about the tenant. A chartered accountant's
 * whole business is tracking obligations that belong to somebody ELSE —
 * four hundred clients, each with a GST registration, a TDS liability and
 * an annual return.
 *
 * So every obligation names a SUBJECT: either the tenant itself, or one
 * of its `companies` rows. The same table therefore answers both
 * "when is MY GST due" and "which of my clients has not filed yet",
 * with no second schema and no second screen.
 *
 * A separate `client_compliance` table would have been the obvious move
 * and it would have been wrong: the reminder ladder, the evidence store,
 * the late-fee arithmetic and the escalation rules are identical, and two
 * copies of identical logic diverge on the first bug fix.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DUE DATE IS DERIVED, NEVER TYPED
 * ══════════════════════════════════════════════════════════════════════
 * GSTR-3B for July is due on 20 August. Not "twenty days after somebody
 * created the row" — the twentieth of the following month, whether the
 * row was created in June or on the day it was filed.
 *
 * So the obligation carries the RULE (`due_month_offset`,
 * `due_day_of_month`) and the task carries the PERIOD, and the due date
 * is computed by trigger from the two. A hand-typed due date is a due
 * date somebody will eventually type wrong, on the one filing that
 * mattered, and nothing will contradict them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A MISSED DEADLINE IS A FACT, NOT AN ERROR
 * ══════════════════════════════════════════════════════════════════════
 * Tasks are never deleted and a missed one is never quietly closed. It
 * moves to `missed` and stays, with its late fee computed and its
 * evidence trail intact. A compliance system that lets you tidy away the
 * filing you forgot is a system that will let you forget the next one
 * too — and the register it produces is worthless in front of an
 * inspector, which is the one moment it exists for.
 *
 * Money is `bigint` paise. Rates are integer basis points.
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
import { tenants, users } from "./core";
import { companies } from "./crm";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * Which authority the obligation answers to.
 *
 * ⚠️ Recorded because the ANSWER to "are we compliant" is always asked by
 * one regulator at a time. An inspector from the pollution control board
 * does not want to see your GST returns, and a register that cannot be
 * filtered to one authority is a register nobody opens during an
 * inspection.
 */
export const complianceAuthorityEnum = pgEnum("compliance_authority", [
  "gst",
  "income_tax",
  "mca_roc",
  "epfo",
  "esic",
  "labour",
  "professional_tax",
  "customs",
  "rbi",
  "sebi",
  "fssai",
  "pollution_control",
  "fire",
  "municipal",
  "transport_rto",
  "electricity_cea",
  "health_nmc",
  "drugs_licensing",
  "aerb",
  "state_excise",
  "legal_metrology",
  "internal",
  "other",
]);

/**
 * How often it recurs.
 *
 * ⚠️ `event_based` is not a frequency and that is deliberate. Some
 * obligations are triggered by something happening — a new hire triggers
 * EPF enrolment, an accident triggers a report within 24 hours. They
 * belong in the same register because they are the same question ("what
 * do we owe a regulator"), but they have no schedule, so their tasks are
 * created by an event rather than by the generator.
 */
export const complianceFrequencyEnum = pgEnum("compliance_frequency", [
  "monthly",
  "quarterly",
  "half_yearly",
  "annual",
  "one_time",
  "event_based",
]);

/**
 * ⭐ THE LIFECYCLE.
 *
 * ⚠️ `filed` AND `late_filed` ARE DIFFERENT STATES, ON PURPOSE.
 *
 * Both mean the work is done and neither is a failure to act. But a
 * register that collapses them cannot answer "how often are we late",
 * which is the only leading indicator of a compliance failure that
 * exists. By the time something is `missed` the damage is done; the
 * pattern of `late_filed` is what predicts it.
 *
 * ⚠️ `not_applicable` is a DECISION, and carries a reason. "We did not
 * file because we are not registered" and "we did not file" look
 * identical in a register that only has `missed`.
 */
export const complianceTaskStatusEnum = pgEnum("compliance_task_status", [
  "pending",
  "in_progress",
  "awaiting_client",
  "ready_to_file",
  "filed",
  "late_filed",
  "missed",
  "not_applicable",
  "waived",
]);

/** How much it hurts. Drives sort order on the board and escalation. */
export const complianceSeverityEnum = pgEnum("compliance_severity", [
  "informational",
  "low",
  "medium",
  "high",
  "critical",
]);

/** What kind of permission a licence row represents. */
export const licenceStatusEnum = pgEnum("licence_status", [
  "active",
  "renewal_due",
  "under_renewal",
  "expired",
  "suspended",
  "cancelled",
  "not_required",
]);

/* ------------------------------------------------------------------ */
/* 1 · OBLIGATIONS — the rule                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ What must be done, for whom, how often, and what lateness costs.
 *
 * This is the RULE. It generates tasks; it is not itself a task.
 */
export const complianceObligations = pgTable(
  "compliance_obligations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Stable machine key, e.g. "gst.gstr3b". Never renumber. */
    code: varchar("code", { length: 100 }).notNull(),
    name: varchar("name", { length: 300 }).notNull(),
    description: text("description"),

    authority: complianceAuthorityEnum("authority").notNull(),
    frequency: complianceFrequencyEnum("frequency").notNull(),
    severity: complianceSeverityEnum("severity").default("medium").notNull(),

    /**
     * ⭐ WHOSE OBLIGATION IS THIS?
     *
     * NULL  → the tenant's own obligation
     * set   → a client's, from `companies`
     *
     * ⚠️ This one nullable column is what lets a CA firm and its client
     * use the same engine. See the header: a separate client table would
     * have duplicated the ladder, the evidence store and the late-fee
     * arithmetic, and the copies would have diverged.
     */
    subjectCompanyId: uuid("subject_company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),

    /* ---- THE DUE-DATE RULE ------------------------------------- */

    /**
     * Months AFTER the period ends before it falls due.
     *
     * GSTR-3B for July is due 20 August → offset 1, day 20.
     * An annual return for FY 2025-26 due 31 Oct 2026 → offset 7, day 31.
     *
     * ⚠️ Zero is legitimate — advance tax is due WITHIN the period it
     * relates to — so this must not be treated as "unset".
     */
    dueMonthOffset: integer("due_month_offset").default(1).notNull(),

    /**
     * Day of that month. 31 is clamped to the month's real last day by
     * the trigger, so "last day of the month" is expressible without a
     * separate flag and February needs no special case.
     */
    dueDayOfMonth: integer("due_day_of_month").default(20).notNull(),

    /* ---- THE COST OF BEING LATE -------------------------------- */

    /**
     * ⭐ STATED IN ADVANCE, WHICH IS THE ENTIRE POINT OF THIS ENGINE.
     *
     * A deadline board that shows what is due is mildly useful. One that
     * shows what being late will COST is what makes somebody act today
     * rather than tomorrow. ₹50/day feels ignorable until it is shown as
     * ₹50/day × 3 registrations × 40 days.
     */
    lateFeePerDayMinor: bigint("late_fee_per_day_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    lateFeeCapMinor: bigint("late_fee_cap_minor", { mode: "bigint" }),
    interestRateBps: integer("interest_rate_bps").default(0).notNull(),
    penaltyNote: text("penalty_note"),

    /** Statutory citation. Shown to the operator; settles arguments. */
    legalReference: varchar("legal_reference", { length: 300 }),

    /* ---- APPLICABILITY ----------------------------------------- */

    /**
     * ⚠️ EXPLICIT, NOT INFERRED.
     *
     * The temptation is to decide automatically whether an obligation
     * applies — turnover above a threshold, a registration present. That
     * inference is wrong often enough to be dangerous: a tenant switched
     * off by a rule nobody remembers writing has no idea they have
     * stopped filing.
     *
     * So applicability is a decision somebody makes and can see. The
     * conditions live in `applicabilityNote` for a human to read.
     */
    isActive: boolean("is_active").default(true).notNull(),
    applicabilityNote: text("applicability_note"),

    /** When this obligation starts and (optionally) stops applying. */
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),

    /** Default owner for generated tasks. */
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /** Days before the due date at which reminders begin. */
    reminderLeadDays: integer("reminder_lead_days").default(7).notNull(),

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
    tenantIdx: index("compliance_obligations_tenant_idx").on(t.tenantId),
    subjectIdx: index("compliance_obligations_subject_idx").on(
      t.tenantId,
      t.subjectCompanyId,
    ),
    authorityIdx: index("compliance_obligations_authority_idx").on(
      t.tenantId,
      t.authority,
    ),

    /**
     * ⚠️ COMPOSITE, INCLUDING tenant_id — required for the composite
     * foreign keys that keep a task and its obligation in the same
     * tenant. Without it, a task could reference an obligation belonging
     * to somebody else, and row-level security would not notice because
     * each row individually passes its own policy.
     */
    tenantScoped: uniqueIndex("compliance_obligations_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),

    /**
     * One obligation per code per subject. `subject_company_id` is
     * nullable, so this is enforced in SQL with two partial indexes —
     * NULL is not equal to NULL in a unique index, and without the
     * partial index the tenant's OWN obligations could be duplicated
     * freely.
     */
    dueDayValid: check(
      "compliance_obligations_due_day_valid",
      sql`${t.dueDayOfMonth} BETWEEN 1 AND 31`,
    ),
    dueOffsetValid: check(
      "compliance_obligations_due_offset_valid",
      sql`${t.dueMonthOffset} BETWEEN 0 AND 24`,
    ),
    lateFeeNonNegative: check(
      "compliance_obligations_late_fee_non_negative",
      sql`${t.lateFeePerDayMinor} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · TASKS — the occurrence                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ One period's instance of one obligation.
 *
 * Generated ahead of time by the scheduler, or on demand for
 * `event_based` obligations.
 */
export const complianceTasks = pgTable(
  "compliance_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    obligationId: uuid("obligation_id").notNull(),

    /**
     * Denormalised from the obligation so the board can filter without a
     * join, and — more importantly — so that changing an obligation's
     * subject later does not silently rewrite the history of who owed
     * what.
     */
    subjectCompanyId: uuid("subject_company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),

    /* ---- THE PERIOD -------------------------------------------- */

    /**
     * ⭐ THE PERIOD, NOT THE DEADLINE.
     *
     * `period_start`/`period_end` say WHAT the filing covers. `due_date`
     * is DERIVED from `period_end` plus the obligation's offset, by
     * trigger. See the header: a typed due date is a due date that will
     * eventually be typed wrong.
     */
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    /** Human label — "Jul 2026", "Q2 FY27". Display only. */
    periodLabel: varchar("period_label", { length: 60 }).notNull(),

    /** ⚠️ Written by trigger. Never accept this from a form. */
    dueDate: date("due_date").notNull(),

    status: complianceTaskStatusEnum("status").default("pending").notNull(),
    severity: complianceSeverityEnum("severity").default("medium").notNull(),

    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /* ---- COMPLETION -------------------------------------------- */

    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByUserId: uuid("completed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * The acknowledgement the authority gave back — ARN, challan number,
     * SRN, receipt number.
     *
     * ⚠️ A filing with no reference is a filing you cannot prove. The
     * trigger refuses `filed` and `late_filed` without one, because "I
     * definitely filed it" is not a defence anybody has ever won with.
     */
    filingReference: varchar("filing_reference", { length: 200 }),

    /**
     * ⭐ Days late, and what that cost. Both DERIVED at completion.
     *
     * Stored rather than computed on read because the obligation's late
     * fee may change next year, and last year's penalty must not change
     * with it.
     */
    daysLate: integer("days_late").default(0).notNull(),
    lateFeeMinor: bigint("late_fee_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Mandatory when status is `not_applicable` or `waived`. */
    exemptionReason: text("exemption_reason"),

    notes: text("notes"),

    /** Last reminder sent, so the ladder does not repeat itself. */
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    reminderCount: integer("reminder_count").default(0).notNull(),

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
    tenantIdx: index("compliance_tasks_tenant_idx").on(t.tenantId),

    /** The board's primary query: what is due, soonest first. */
    dueIdx: index("compliance_tasks_due_idx").on(
      t.tenantId,
      t.status,
      t.dueDate,
    ),
    subjectIdx: index("compliance_tasks_subject_idx").on(
      t.tenantId,
      t.subjectCompanyId,
      t.dueDate,
    ),
    ownerIdx: index("compliance_tasks_owner_idx").on(t.tenantId, t.ownerUserId),

    tenantScoped: uniqueIndex("compliance_tasks_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),

    /**
     * ⚠️ ONE TASK PER OBLIGATION PER PERIOD.
     *
     * The generator runs repeatedly — nightly, and again by hand when
     * somebody adds an obligation mid-year. Without this constraint the
     * second run silently doubles every task, and a board showing each
     * filing twice is a board people stop trusting within a week.
     */
    onePerPeriod: uniqueIndex("compliance_tasks_obligation_period_key").on(
      t.obligationId,
      t.periodStart,
    ),

    periodOrdered: check(
      "compliance_tasks_period_ordered",
      sql`${t.periodEnd} >= ${t.periodStart}`,
    ),
    daysLateNonNegative: check(
      "compliance_tasks_days_late_non_negative",
      sql`${t.daysLate} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 3 · EVIDENCE — the proof                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ What was actually filed, and the bytes to prove it.
 *
 * ⚠️ APPEND-ONLY BY POLICY. Evidence is deleted by nobody: superseding a
 * document adds a row, it does not replace one. The register's whole
 * value is that it can be handed to an inspector, and a store where the
 * last version is the only version cannot show that the earlier filing
 * existed — which is exactly what a revised return needs to demonstrate.
 */
export const complianceEvidence = pgTable(
  "compliance_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    taskId: uuid("task_id").notNull(),

    kind: varchar("kind", { length: 60 }).notNull(),
    title: varchar("title", { length: 300 }).notNull(),

    /** Points at `documents`. Bytes live in R2, never in Postgres. */
    documentId: uuid("document_id"),

    /**
     * ⭐ SHA-256 of the bytes at the moment of upload.
     *
     * ⚠️ This is what makes the evidence worth having. Without it, "here
     * is the acknowledgement we filed" is a PDF somebody could have
     * edited last week. With it, the file either hashes to the recorded
     * value or it has changed since — and which of those is true is not a
     * matter of opinion.
     */
    contentSha256: varchar("content_sha256", { length: 64 }),

    filingReference: varchar("filing_reference", { length: 200 }),
    filedOn: date("filed_on"),

    /** Set when a later row replaces this one. Never deleted. */
    supersededByEvidenceId: uuid("superseded_by_evidence_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),

    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("compliance_evidence_tenant_idx").on(t.tenantId),
    taskIdx: index("compliance_evidence_task_idx").on(t.tenantId, t.taskId),
    tenantScoped: uniqueIndex("compliance_evidence_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 4 · LICENCES — permissions that expire                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A LICENCE IS NOT A RECURRING FILING, AND MODELLING IT AS ONE FAILS.
 *
 * A GST return recurs forever on a fixed calendar. An FSSAI licence has
 * ONE expiry date, and the renewal window opens a fixed number of days
 * before it. Forcing it into the obligation table would mean either
 * inventing a fake period or generating tasks for a schedule that does
 * not exist.
 *
 * And the consequence of confusing them is asymmetric: a late GST return
 * costs a fee, whereas an expired fire NOC or drug licence stops the
 * business operating that day. So they get their own table, their own
 * warning ladder, and their own place on the board.
 *
 * Covers: FSSAI, trade licence, fire NOC, pollution consent, factory
 * licence, drug licence, vehicle fitness, PUC, insurance, professional
 * registrations, ISO/NABH certificates, DSC validity.
 */
export const complianceLicences = pgTable(
  "compliance_licences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Whose licence — the tenant's own, or a client's. */
    subjectCompanyId: uuid("subject_company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),

    name: varchar("name", { length: 300 }).notNull(),
    authority: complianceAuthorityEnum("authority").notNull(),
    licenceNumber: varchar("licence_number", { length: 200 }),

    /** Where it applies — a property, a vehicle, a person. Free text. */
    appliesTo: varchar("applies_to", { length: 300 }),

    issuedOn: date("issued_on"),
    validFrom: date("valid_from"),
    validUntil: date("valid_until"),

    /**
     * How many days before expiry the renewal must START.
     *
     * ⚠️ NOT the same as a reminder. Some renewals legally cannot be
     * applied for until a window opens, and others take ninety days to
     * process — so "remind me a week before" is useless. This is the date
     * from which being idle is already a problem.
     */
    renewalLeadDays: integer("renewal_lead_days").default(60).notNull(),

    status: licenceStatusEnum("status").default("active").notNull(),
    severity: complianceSeverityEnum("severity").default("high").notNull(),

    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    documentId: uuid("document_id"),

    /** Cost of renewal, for the budget nobody remembers to make. */
    renewalFeeMinor: bigint("renewal_fee_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    notes: text("notes"),

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
    tenantIdx: index("compliance_licences_tenant_idx").on(t.tenantId),
    expiryIdx: index("compliance_licences_expiry_idx").on(
      t.tenantId,
      t.status,
      t.validUntil,
    ),
    subjectIdx: index("compliance_licences_subject_idx").on(
      t.tenantId,
      t.subjectCompanyId,
    ),
    tenantScoped: uniqueIndex("compliance_licences_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    validityOrdered: check(
      "compliance_licences_validity_ordered",
      sql`${t.validUntil} IS NULL OR ${t.validFrom} IS NULL OR ${t.validUntil} >= ${t.validFrom}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* CONSTANTS — the rules other code must agree with                    */
/* ------------------------------------------------------------------ */

/** Statuses meaning "the work is done", however late. */
export const COMPLIANCE_DONE_STATUSES = [
  "filed",
  "late_filed",
  "not_applicable",
  "waived",
] as const;

/** Statuses still demanding somebody's attention. */
export const COMPLIANCE_OPEN_STATUSES = [
  "pending",
  "in_progress",
  "awaiting_client",
  "ready_to_file",
] as const;

/**
 * ⚠️ Statuses that REQUIRE a filing reference. Enforced by trigger, not
 * by the form — a back-fill and a support fix both bypass the form.
 */
export const COMPLIANCE_REFERENCE_REQUIRED = ["filed", "late_filed"] as const;

/** Statuses that REQUIRE a written reason. Same reasoning. */
export const COMPLIANCE_REASON_REQUIRED = ["not_applicable", "waived"] as const;

/**
 * The reminder ladder, in days before due. Negative values are days AFTER
 * the due date — the chase does not stop because the deadline passed.
 */
export const COMPLIANCE_REMINDER_LADDER = [30, 14, 7, 3, 1, 0, -1, -7] as const;

export type ComplianceTaskStatus =
  (typeof complianceTaskStatusEnum.enumValues)[number];
export type ComplianceFrequency =
  (typeof complianceFrequencyEnum.enumValues)[number];
export type ComplianceAuthority =
  (typeof complianceAuthorityEnum.enumValues)[number];

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const complianceObligationsRelations = relations(
  complianceObligations,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [complianceObligations.tenantId],
      references: [tenants.id],
    }),
    subjectCompany: one(companies, {
      fields: [complianceObligations.subjectCompanyId],
      references: [companies.id],
    }),
    tasks: many(complianceTasks),
  }),
);

export const complianceTasksRelations = relations(
  complianceTasks,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [complianceTasks.tenantId],
      references: [tenants.id],
    }),
    obligation: one(complianceObligations, {
      fields: [complianceTasks.obligationId],
      references: [complianceObligations.id],
    }),
    evidence: many(complianceEvidence),
  }),
);

export const complianceEvidenceRelations = relations(
  complianceEvidence,
  ({ one }) => ({
    task: one(complianceTasks, {
      fields: [complianceEvidence.taskId],
      references: [complianceTasks.id],
    }),
  }),
);

export const complianceLicencesRelations = relations(
  complianceLicences,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [complianceLicences.tenantId],
      references: [tenants.id],
    }),
    subjectCompany: one(companies, {
      fields: [complianceLicences.subjectCompanyId],
      references: [companies.id],
    }),
  }),
);
