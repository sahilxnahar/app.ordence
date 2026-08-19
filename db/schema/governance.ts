/**
 * Ordence — Deployment, Flows & UI Governance
 * Version: v0.84.0-alpha
 *
 * The Drizzle definitions for the four tables created by
 * `SQL-FILES/0046_deployment_flows_governance.sql`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS FILE EXISTS AT ALL — IT IS NOT DECORATION
 * ══════════════════════════════════════════════════════════════════════
 * `0046` created these four tables in SQL. Nothing defined them in the
 * Drizzle schema, and `scripts/check-sql-completeness.mjs` flagged that
 * on its first run:
 *
 *     ⚠️ CREATED IN SQL BUT ABSENT FROM db/schema
 *        deployment_releases, deployment_backups,
 *        flow_submissions, ui_governance_checks
 *
 * That gap is not cosmetic. `drizzle-kit push` compares the live database
 * against this schema and DROPS whatever it does not recognise — the same
 * mechanism documented in `scripts/verify-security.ts`, which measured 25
 * tables with RLS before a push and 0 after.
 *
 * So a table present in SQL but missing here is one `npm run db:push`
 * away from being deleted, along with every row in it. Defining them
 * makes them visible to Drizzle and therefore safe from its cleanup.
 *
 * ⚠️ THE COLUMNS BELOW MUST MATCH 0046 EXACTLY. Drizzle does not create
 * these tables in production — 0046 does — so a mismatch here is silent
 * until a query references a column that is not there. Any change to one
 * file must be made in the other.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* DEPLOYMENT RELEASES                                                 */
/* ------------------------------------------------------------------ */

export const deploymentReleases = pgTable(
  "deployment_releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    version: varchar("version", { length: 40 }).notNull(),
    status: varchar("status", { length: 30 }).default("prepared").notNull(),
    manifest: jsonb("manifest")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    /**
     * ⚠️ The composite key every tenant table here carries. It is what
     * lets a child table use a COMPOSITE foreign key and be structurally
     * unable to reference a parent in another tenant.
     */
    idTenantKey: uniqueIndex("deployment_releases_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("deployment_releases_tenant_idx").on(t.tenantId, t.createdAt),
    /** One live release per version per tenant — a retried deploy must not duplicate. */
    tenantVersionKey: uniqueIndex("deployment_releases_tenant_version_key")
      .on(t.tenantId, t.version)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* DEPLOYMENT BACKUPS                                                  */
/* ------------------------------------------------------------------ */

export const deploymentBackups = pgTable(
  "deployment_backups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠️ 0046 enforces this with a COMPOSITE foreign key
     * `(release_id, tenant_id) → (id, tenant_id)`, so a backup physically
     * cannot point at another tenant's release. Drizzle's single-column
     * `references()` cannot express that; the database is the authority.
     */
    releaseId: uuid("release_id"),

    backupType: varchar("backup_type", { length: 60 }).notNull(),
    status: varchar("status", { length: 30 }).default("recorded").notNull(),
    location: text("location"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    idTenantKey: uniqueIndex("deployment_backups_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("deployment_backups_tenant_idx").on(t.tenantId, t.createdAt),
  }),
);

/* ------------------------------------------------------------------ */
/* UI GOVERNANCE CHECKS — the 460-batch tracker                        */
/* ------------------------------------------------------------------ */

/**
 * `batch_key` is CI-01 … CI-60, CT-01 …, UX-01 …, CP-01 …, AL-01 …,
 * IQ-01 …, CUS-01 …, plus S1 … S40 for the security track.
 *
 * ⚠️ This table was named by the batch plan as the thing tracking all 460
 * batches, and had never been created in any migration until 0046. The
 * plan referenced it; nothing defined it.
 */
export const uiGovernanceChecks = pgTable(
  "ui_governance_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    batchKey: varchar("batch_key", { length: 20 }).notNull(),
    department: varchar("department", { length: 40 }).notNull(),
    title: text("title").notNull(),
    status: varchar("status", { length: 30 }).default("todo").notNull(),
    notes: text("notes"),

    checkedBy: uuid("checked_by").references(() => users.id, { onDelete: "set null" }),
    checkedAt: timestamp("checked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantKey: uniqueIndex("ui_governance_checks_id_tenant_key").on(t.id, t.tenantId),
    /** One row per batch per tenant — what makes a re-run of the seed idempotent. */
    tenantBatchKey: uniqueIndex("ui_governance_checks_tenant_batch_key").on(
      t.tenantId,
      t.batchKey,
    ),
    tenantStatusIdx: index("ui_governance_checks_tenant_status_idx").on(
      t.tenantId,
      t.department,
      t.status,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* FLOW SUBMISSIONS                                                    */
/* ------------------------------------------------------------------ */

export const flowSubmissions = pgTable(
  "flow_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    flowType: varchar("flow_type", { length: 60 }).notNull(),
    title: text("title").notNull(),
    status: varchar("status", { length: 30 }).default("submitted").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    idTenantKey: uniqueIndex("flow_submissions_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("flow_submissions_tenant_idx").on(t.tenantId, t.flowType, t.createdAt),
  }),
);
