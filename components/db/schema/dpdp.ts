/**
 * Ordence — ⭐⭐⭐ DATA PRINCIPAL REQUESTS AND BREACH INTIMATIONS
 * Version: v1.68.0-alpha
 *
 * DDL: SQL-FILES/0113_dpdp_data_principal_requests.sql — which is the
 * authority. This file mirrors it so the application is typed and so the
 * classification gate can see these tables.
 *
 * ⚠️ THAT SECOND REASON IS NOT INCIDENTAL. `scripts/check-data-classification.mjs`
 * reads `db/schema/*.ts`. A table created only in SQL is invisible to it —
 * which means the four tables in this batch, every one of which holds
 * personal data, would have been the first tables the new gate could not
 * see. Declaring them here closes that on the day it would first have
 * mattered; it does NOT close it in general, and the general case is a
 * stated gap in the batch report.
 *
 * 🔴 NEVER RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* THE REGISTER                                                        */
/* ------------------------------------------------------------------ */

export const dataPrincipalRequests = pgTable(
  "data_principal_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    reference: varchar("reference", { length: 40 }).notNull(),

    /** access (s.11) | erasure (s.12(3)) | correction (s.12(1)) | grievance (s.13) | consent_withdrawal (s.6(4)) */
    kind: varchar("kind", { length: 30 }).notNull(),

    /** How the person described themselves, before we decide which rows are theirs. */
    principalLabel: text("principal_label").notNull(),
    principalEmail: varchar("principal_email", { length: 320 }),
    principalPhone: varchar("principal_phone", { length: 40 }),

    /**
     * 🔴 THE MOST IMPORTANT COLUMN IN THIS BATCH, AND NOT A BOOLEAN.
     *
     * Answering an access request for somebody who is not the Data
     * Principal is itself a personal data breach, and it is the breach
     * that arrives disguised as good service: a polite email from an
     * address that looks right, answered by somebody trying to help.
     * A boolean would record that a box was ticked. This records what
     * was actually done, which is the thing that can be wrong in a way
     * a reader can see.
     */
    verifiedHow: text("verified_how").notNull(),
    verifiedBy: uuid("verified_by").references(() => users.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    status: varchar("status", { length: 20 }).default("received").notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /**
     * 🔴 THERE IS NO `dueAt`. An earlier draft had one, documented as
     * advisory because the DPDP Rules' response periods commence in May
     * 2027. Nothing wrote it and nothing read it — a column existing for
     * an obligation nobody has yet, which is the same defect as a policy
     * stored and never checked.
     */

    /** ⭐ The manifest as produced, so "what did we tell them" is not a reconstruction. */
    outcomeManifest: jsonb("outcome_manifest").$type<Record<string, unknown> | null>(),
    /** The refusal notice as sent. Text, not a template id: a template can be edited later. */
    refusalNotice: text("refusal_notice"),

    /**
     * 🔴 A CHECK CONSTRAINT IN 0113 REFUSES TO MARK A REQUEST ANSWERED
     * WHILE THIS IS TRUE. "We decided automatically that a law we could
     * not read requires us to keep your data" is not an answer to send.
     */
    needsHumanDecision: boolean("needs_human_decision").default(false).notNull(),
    /**
     * ⚠️ AND NO `humanDecisionNote`. Every per-table decision a person
     * takes is already one row in `data_principal_request_events`, with
     * its own `because`, on a table that cannot be edited afterwards. A
     * summary column here would be a second, mutable account of the same
     * facts.
     */

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    idTenantKey: uniqueIndex("data_principal_requests_id_tenant_key").on(t.id, t.tenantId),
    referenceKey: uniqueIndex("data_principal_requests_reference_key").on(t.tenantId, t.reference),
    openIdx: index("data_principal_requests_open_idx").on(t.tenantId, t.status, t.receivedAt),
    kindValid: check(
      "data_principal_requests_kind_valid",
      sql`${t.kind} IN ('access','erasure','correction','grievance','consent_withdrawal')`,
    ),
    statusValid: check(
      "data_principal_requests_status_valid",
      sql`${t.status} IN ('received','verifying','planned','answered','refused','withdrawn')`,
    ),
    noSilentAnswer: check(
      "data_principal_requests_no_silent_answer",
      sql`${t.status} <> 'answered' OR ${t.needsHumanDecision} = false`,
    ),
    answerHasReceipt: check(
      "data_principal_requests_answer_has_a_receipt",
      sql`${t.status} <> 'answered' OR ${t.outcomeManifest} IS NOT NULL`,
    ),
    refusalHasNotice: check(
      "data_principal_requests_refusal_has_a_notice",
      sql`${t.status} <> 'refused' OR ${t.refusalNotice} IS NOT NULL`,
    ),
    verifiedHowIsASentence: check(
      "data_principal_requests_verified_how_is_a_sentence",
      sql`length(btrim(${t.verifiedHow})) >= 10`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* WHICH ROWS ARE THIS PERSON                                          */
/* ------------------------------------------------------------------ */

/**
 * 🔴 ORDENCE DOES NOT MERGE IDENTITIES.
 *
 * A shared email address is not proof that two records are one person.
 * `info@` on a family business is the counter-example, and merging on it
 * would disclose one person's records to another — the exact harm s.11
 * exists to prevent, caused by the machinery built to satisfy it.
 */
export const dataPrincipalRequestAnchors = pgTable(
  "data_principal_request_anchors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),

    /** ⚠️ One of nine tables, so it cannot be a foreign key. Kept in step by a CHECK. */
    principalKind: varchar("principal_kind", { length: 20 }).notNull(),
    principalId: uuid("principal_id").notNull(),

    /** 🔴 Why this row is this person. Not a checkbox. */
    establishedBy: text("established_by").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    idTenantKey: uniqueIndex("data_principal_request_anchors_id_tenant_key").on(t.id, t.tenantId),
    unique: uniqueIndex("data_principal_request_anchors_unique").on(
      t.tenantId,
      t.requestId,
      t.principalKind,
      t.principalId,
    ),
    kindValid: check(
      "data_principal_request_anchors_kind_valid",
      sql`${t.principalKind} IN ('contact','lead','employee','user','worker','deductee','landowner','partner','vendor')`,
    ),
    establishedIsASentence: check(
      "data_principal_request_anchors_established_is_a_sentence",
      sql`length(btrim(${t.establishedBy})) >= 10`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* WHAT WAS ACTUALLY DONE                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ APPEND-ONLY BY TRIGGER (0113 §4), and granted INSERT and SELECT only.
 *
 * 🔴 IT STORES A TABLE NAME AND A ROW COUNT, NEVER THE ERASED ROWS.
 * Keeping a copy of what was erased in order to prove it was erased is
 * not a compliance record; it is the same personal data under a
 * different table name, and s.8(7) would apply to it identically.
 */
export const dataPrincipalRequestEvents = pgTable(
  "data_principal_request_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),

    action: varchar("action", { length: 24 }).notNull(),

    tableName: varchar("table_name", { length: 63 }),
    rowCount: integer("row_count"),

    /** ⭐ The rule id from lib/dpdp/retention.ts. A refusal with no rule names no statute. */
    retentionRule: varchar("retention_rule", { length: 60 }),
    because: text("because"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    idTenantKey: uniqueIndex("data_principal_request_events_id_tenant_key").on(t.id, t.tenantId),
    requestIdx: index("data_principal_request_events_request_idx").on(
      t.tenantId,
      t.requestId,
      t.occurredAt,
    ),
    actionValid: check(
      "data_principal_request_events_action_valid",
      sql`${t.action} IN ('planned','exported','erased','redacted','retained','referred','could_not_search','notice_sent')`,
    ),
    /** 🔴 s.8(7)'s exception, as a CHECK: a retention with no named law is not the exception. */
    retentionNamesARule: check(
      "data_principal_request_events_retention_names_a_rule",
      sql`${t.action} <> 'retained' OR ${t.retentionRule} IS NOT NULL`,
    ),
    countsAreSane: check(
      "data_principal_request_events_counts_are_sane",
      sql`${t.rowCount} IS NULL OR ${t.rowCount} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* THE BREACH INTIMATION                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE ARTEFACT s.8(6) REQUIRES AND `security_events` IS NOT.
 *
 * 🔴 THERE IS DELIBERATELY NO `isMaterial` COLUMN. Rule 7 of the DPDP
 * Rules 2025 has no materiality threshold — every personal data breach
 * is reportable — so such a field could only ever be used to justify not
 * reporting. 0113 §8 asserts its absence.
 */
export const personalDataBreaches = pgTable(
  "personal_data_breaches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    reference: varchar("reference", { length: 40 }).notNull(),
    /** ⚠️ The DPDP Rules commence in May 2027; this table exists before then. */
    breachClass: varchar("breach_class", { length: 24 }).default("anticipatory").notNull(),

    /**
     * 🔴 THE CLOCK STARTS AT NOTICING. Both CERT-In's six hours and
     * Rule 7's "without delay" run from awareness, not from occurrence
     * and not from confirmation.
     */
    noticedAt: timestamp("noticed_at", { withTimezone: true }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),

    /** Rule 7 content, one column each, so an incomplete intimation is a NULL rather than a short paragraph. */
    nature: text("nature").notNull(),
    extent: text("extent").notNull(),
    timingAndLocation: text("timing_and_location").notNull(),
    likelyConsequences: text("likely_consequences").notNull(),
    mitigationImplemented: text("mitigation_implemented").notNull(),
    safeguardsForPrincipals: text("safeguards_for_principals").notNull(),
    contactPerson: text("contact_person").notNull(),

    affectedPrincipalCount: integer("affected_principal_count"),

    /** Three duties, three timestamps. One boolean would let any of them stand for all. */
    boardIntimatedAt: timestamp("board_intimated_at", { withTimezone: true }),
    boardDetailedReportAt: timestamp("board_detailed_report_at", { withTimezone: true }),
    principalsIntimatedAt: timestamp("principals_intimated_at", { withTimezone: true }),
    /** ⚠️ CERT-In Direction (ii): six hours of noticing. A separate, shorter duty. */
    certinReportedAt: timestamp("certin_reported_at", { withTimezone: true }),

    principalIntimationText: text("principal_intimation_text"),

    status: varchar("status", { length: 20 }).default("open").notNull(),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    idTenantKey: uniqueIndex("personal_data_breaches_id_tenant_key").on(t.id, t.tenantId),
    referenceKey: uniqueIndex("personal_data_breaches_reference_key").on(t.tenantId, t.reference),
    openIdx: index("personal_data_breaches_open_idx").on(t.tenantId, t.status, t.noticedAt),
    classValid: check(
      "personal_data_breaches_class_valid",
      sql`${t.breachClass} IN ('anticipatory','dpdp_rules_2025')`,
    ),
    statusValid: check(
      "personal_data_breaches_status_valid",
      sql`${t.status} IN ('open','intimated','closed')`,
    ),
    countIsSane: check(
      "personal_data_breaches_count_is_sane",
      sql`${t.affectedPrincipalCount} IS NULL OR ${t.affectedPrincipalCount} >= 0`,
    ),
    /** 🔴 s.8(6) requires BOTH. A workflow that lets a team tidy an incident away will be used at 2 a.m. */
    closedMeansBothTold: check(
      "personal_data_breaches_closed_means_both_told",
      sql`${t.status} <> 'closed' OR (${t.boardIntimatedAt} IS NOT NULL AND ${t.principalsIntimatedAt} IS NOT NULL)`,
    ),
    intimationHasText: check(
      "personal_data_breaches_intimation_has_text",
      sql`${t.principalsIntimatedAt} IS NULL OR ${t.principalIntimationText} IS NOT NULL`,
    ),
    detailFollowsInitial: check(
      "personal_data_breaches_detail_follows_initial",
      sql`${t.boardDetailedReportAt} IS NULL OR ${t.boardIntimatedAt} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE EXPORT LOG — SQL 0116 · WAVE 5                            */
/* ------------------------------------------------------------------ */

/**
 * 🔴 IT LIVES IN THE DPDP SCHEMA AND NOT IN `billing.ts` OR A NEW
 * `export.ts`, BECAUSE THAT IS WHAT IT IS FOR. Wave 5 puts an Export
 * button on every register in the product. The button is the feature; this
 * table is the reason the feature is safe to ship.
 *
 * s.8(5) DPDPA 2023 makes the Data Fiduciary answerable for the personal
 * data it discloses, and the first question after an employee leaves with
 * a spreadsheet is always "what did they take". Before this table the
 * honest answer was that we could not tell you.
 *
 * ⚠️ IT DOES NOT HOLD THE FILE. Storing exports would create a second copy
 * of every personal record in the product, in a table nobody thinks of as
 * sensitive, that outlives the erasure meant to remove the original.
 */
export const dataExports = pgTable(
  "data_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /**
     * ⚠️ RESTRICT, NOT CASCADE. Deleting a user must not delete the record
     * of what they exported — that is the one deletion an investigation
     * cares about, and CASCADE would make it vanish as a side effect of
     * offboarding.
     */
    exportedBy: uuid("exported_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    subject: varchar("subject", { length: 120 }).notNull(),
    datasetKeys: text("dataset_keys").array().notNull(),

    format: varchar("format", { length: 20 }).notNull(),

    rowCount: integer("row_count").notNull(),
    byteCount: bigint("byte_count", { mode: "number" }).notNull(),

    /** 🔴 The column the table exists for. See the file header. */
    includesPersonalData: boolean("includes_personal_data").notNull(),

    /**
     * ⚠️ THE HEADINGS, NOT THE VALUES. "Name, Mobile, PAN" is what a
     * breach notification under s.8(6) has to state, and reconstructing it
     * later from a format id and a date is guesswork.
     */
    personalColumns: text("personal_columns").array().notNull().default([]),

    filters: jsonb("filters").notNull().default({}),

    /** What the format could not carry. See `lib/export/pdf.ts`. */
    notes: text("notes").array().notNull().default([]),

    outcome: varchar("outcome", { length: 16 }).notNull().default("delivered"),
    failureReason: text("failure_reason"),
  },
  (t) => ({
    personalIdx: index("data_exports_personal_idx").on(t.tenantId, t.occurredAt),
    tenantPeriodIdx: index("data_exports_tenant_period_idx").on(t.tenantId, t.occurredAt),
    actorIdx: index("data_exports_actor_idx").on(t.tenantId, t.exportedBy, t.occurredAt),

    formatKnown: check(
      "data_exports_format_known",
      sql`${t.format} IN ('csv', 'xlsx', 'json', 'pdf', 'docx', 'tally-xml')`,
    ),
    outcomeKnown: check(
      "data_exports_outcome_known",
      sql`${t.outcome} IN ('delivered', 'refused', 'failed')`,
    ),
    countsSane: check(
      "data_exports_counts_sane",
      sql`${t.rowCount} >= 0 AND ${t.byteCount} >= 0`,
    ),
    failureNamed: check(
      "data_exports_failure_named",
      sql`${t.outcome} = 'delivered' OR ${t.failureReason} IS NOT NULL`,
    ),
    personalColumnsPresent: check(
      "data_exports_personal_columns_present",
      sql`${t.outcome} <> 'delivered' OR ${t.includesPersonalData} = false OR cardinality(${t.personalColumns}) > 0`,
    ),
    datasetsNamed: check(
      "data_exports_datasets_named",
      sql`cardinality(${t.datasetKeys}) > 0`,
    ),
  }),
);
