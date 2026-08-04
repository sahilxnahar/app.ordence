/**
 * Ordence — Contract Lifecycle Management
 * Version: v0.4.0-alpha
 *
 * A contract is not a document — it is a document plus a history of who changed
 * what, when, and under whose authority. `contracts` holds the current state;
 * `contract_versions` is an immutable append-only chain of every prior state.
 *
 * WHY VERSIONS ARE IMMUTABLE:
 *   A contract dispute is settled by proving what the document said on a given
 *   date. If versions can be edited, the record proves nothing. A database
 *   trigger blocks UPDATE and DELETE on `contract_versions` outright — the same
 *   treatment `audit_logs` gets, and for the same reason.
 *
 * WHY A CONTENT HASH:
 *   Each version stores a SHA-256 of its body. Tampering at the storage layer
 *   (a restored backup, a direct database edit) breaks the hash chain and becomes
 *   detectable. `previous_version_hash` links each version to its parent, so the
 *   chain can be walked and verified end to end.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  integer,
  boolean,
  date,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { contacts, companies, deals } from "./crm";
import { assets } from "./assets";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

export const contractStatusEnum = pgEnum("contract_status", [
  "draft",
  "internal_review",
  "counterparty_review",
  "approved",
  "out_for_signature",
  "signed",
  "executed",
  "active",
  "expired",
  "terminated",
  "cancelled",
]);

export const contractTypeEnum = pgEnum("contract_type", [
  "sale_agreement",
  "lease_agreement",
  "construction_contract",
  "consultancy_agreement",
  "nda",
  "msa",
  "sow",
  "purchase_order",
  "joint_development",
  "loan_agreement",
  "employment",
  "vendor_agreement",
  "other",
]);

export const versionChangeTypeEnum = pgEnum("version_change_type", [
  "created",
  "edited",
  "clause_inserted",
  "clause_removed",
  "redlined",
  "status_changed",
  "approved",
  "signed",
  "restored",
]);

export const clauseCategoryEnum = pgEnum("clause_category", [
  "definitions",
  "payment_terms",
  "delivery",
  "warranties",
  "indemnity",
  "limitation_of_liability",
  "confidentiality",
  "intellectual_property",
  "termination",
  "force_majeure",
  "dispute_resolution",
  "governing_law",
  "notices",
  "miscellaneous",
]);

/* ------------------------------------------------------------------ */
/* TYPED JSONB SHAPES                                                  */
/* ------------------------------------------------------------------ */

/** The structured body of a contract — sections resolved from templates. */
export type ContractDocumentData = {
  /** Ordered sections making up the document body. */
  sections?: Array<{
    id: string;
    heading: string;
    body: string;
    /** Set when this section came from the clause library. */
    clauseId?: string;
    order: number;
  }>;
  /** Merge-field values resolved at assembly time. */
  mergeFields?: Record<string, string | number | boolean | null>;
  /** Named parties to the agreement. */
  parties?: Array<{
    role: string;
    name: string;
    entityType?: string;
    address?: string;
    signatoryName?: string;
    signatoryDesignation?: string;
  }>;
  /** Commercial summary surfaced without parsing the body. */
  commercials?: {
    value?: string;
    currency?: string;
    paymentSchedule?: Array<{ milestone: string; pct?: number; amount?: string; dueDate?: string }>;
    retentionPct?: number;
    penaltyPerWeekPct?: number;
  };
  /** Free-form annotations. */
  notes?: string;
};

export type RedlineChange = {
  sectionId: string;
  type: "insert" | "delete" | "replace";
  before?: string;
  after?: string;
  author: string;
  comment?: string;
};

/* ------------------------------------------------------------------ */
/* CONTRACTS                                                           */
/* ------------------------------------------------------------------ */

export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Optional link to the asset this contract governs. */
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),

    title: varchar("title", { length: 400 }).notNull(),
    /** Tenant-facing reference, e.g. "AHD/CIV/2025/003". */
    contractNumber: varchar("contract_number", { length: 120 }),
    contractType: contractTypeEnum("contract_type").default("other").notNull(),
    status: contractStatusEnum("status").default("draft").notNull(),

    /** Current document body. History lives in `contract_versions`. */
    documentData: jsonb("document_data")
      .$type<ContractDocumentData>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Monotonic counter — matches the newest row in `contract_versions`. */
    currentVersion: integer("current_version").default(1).notNull(),

    /* --- Commercial terms promoted for indexing/reporting ---------- */
    value: numeric("value", { precision: 18, scale: 2 }),
    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    effectiveDate: date("effective_date"),
    expiryDate: date("expiry_date"),
    /** Days before expiry to raise a renewal reminder. */
    renewalNoticeDays: integer("renewal_notice_days").default(30).notNull(),
    autoRenew: boolean("auto_renew").default(false).notNull(),

    signedAt: timestamp("signed_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),

    governingLaw: varchar("governing_law", { length: 150 }).default("India"),
    jurisdiction: varchar("jurisdiction", { length: 150 }),

    /** Blocks deletion and archival while litigation is anticipated. */
    legalHold: boolean("legal_hold").default(false).notNull(),
    legalHoldReason: text("legal_hold_reason"),

    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    tenantIdx: index("contracts_tenant_idx").on(t.tenantId),
    tenantStatusIdx: index("contracts_tenant_status_idx").on(t.tenantId, t.status),
    tenantTypeIdx: index("contracts_tenant_type_idx").on(t.tenantId, t.contractType),
    assetIdx: index("contracts_asset_idx").on(t.tenantId, t.assetId),
    contactIdx: index("contracts_contact_idx").on(t.tenantId, t.contactId),
    // Expiry sweep for renewal reminders.
    expiryIdx: index("contracts_expiry_idx").on(t.tenantId, t.expiryDate),
    numberUnique: uniqueIndex("contracts_tenant_number_unique")
      .on(t.tenantId, t.contractNumber)
      .where(sql`${t.contractNumber} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    documentGinIdx: index("contracts_document_gin").using("gin", t.documentData),
  }),
);

/* ------------------------------------------------------------------ */
/* CONTRACT VERSIONS  (immutable)                                      */
/* ------------------------------------------------------------------ */

export const contractVersions = pgTable(
  "contract_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),

    versionNumber: integer("version_number").notNull(),
    changeType: versionChangeTypeEnum("change_type").default("edited").notNull(),

    /** Full snapshot of the document at this version — not a diff. */
    documentData: jsonb("document_data")
      .$type<ContractDocumentData>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Structured redlines relative to the previous version. */
    redlines: jsonb("redlines")
      .$type<RedlineChange[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /**
     * SHA-256 of the canonical JSON body. Tampering breaks the hash;
     * `previousVersionHash` chains versions so the whole history is verifiable.
     */
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    previousVersionHash: varchar("previous_version_hash", { length: 64 }),

    statusAtVersion: contractStatusEnum("status_at_version").default("draft").notNull(),
    changeSummary: text("change_summary"),

    /* --- Attribution: who, from where, when ------------------------ */
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorName: varchar("author_name", { length: 200 }),
    authorEmail: varchar("author_email", { length: 320 }),
    ipAddress: varchar("ip_address", { length: 45 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One row per version per contract.
    contractVersionUnique: uniqueIndex("contract_versions_unique").on(
      t.contractId,
      t.versionNumber,
    ),
    tenantIdx: index("contract_versions_tenant_idx").on(t.tenantId),
    contractIdx: index("contract_versions_contract_idx").on(t.tenantId, t.contractId, t.versionNumber),
    hashIdx: index("contract_versions_hash_idx").on(t.contentHash),
  }),
);

/* ------------------------------------------------------------------ */
/* CLAUSE LIBRARY                                                      */
/* ------------------------------------------------------------------ */

export const clauseLibrary = pgTable(
  "clause_library",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    title: varchar("title", { length: 300 }).notNull(),
    /** Short reference used when inserting, e.g. "IND-STD-01". */
    code: varchar("code", { length: 60 }),
    category: clauseCategoryEnum("category").default("miscellaneous").notNull(),

    /**
     * Clause body. May contain `{{merge_field}}` placeholders resolved at
     * assembly time by the document engine.
     */
    content: text("content").notNull(),

    /** Merge fields this clause expects, for validation before assembly. */
    requiredMergeFields: jsonb("required_merge_fields")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /** Which contract types this clause is appropriate for. Empty = any. */
    applicableContractTypes: jsonb("applicable_contract_types")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /** Approved clauses may be inserted without legal review. */
    isApproved: boolean("is_approved").default(false).notNull(),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),

    /** Negotiation guidance shown alongside the clause. */
    fallbackPosition: text("fallback_position"),
    riskLevel: varchar("risk_level", { length: 20 }).default("standard"),

    version: integer("version").default(1).notNull(),
    usageCount: integer("usage_count").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("clause_library_tenant_idx").on(t.tenantId),
    tenantCategoryIdx: index("clause_library_tenant_category_idx").on(t.tenantId, t.category),
    codeUnique: uniqueIndex("clause_library_tenant_code_unique")
      .on(t.tenantId, t.code)
      .where(sql`${t.code} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    approvedIdx: index("clause_library_approved_idx").on(t.tenantId, t.isApproved),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const contractsRelations = relations(contracts, ({ one, many }) => ({
  tenant: one(tenants, { fields: [contracts.tenantId], references: [tenants.id] }),
  asset: one(assets, { fields: [contracts.assetId], references: [assets.id] }),
  contact: one(contacts, { fields: [contracts.contactId], references: [contacts.id] }),
  company: one(companies, { fields: [contracts.companyId], references: [companies.id] }),
  deal: one(deals, { fields: [contracts.dealId], references: [deals.id] }),
  owner: one(users, { fields: [contracts.ownerId], references: [users.id] }),
  versions: many(contractVersions),
}));

export const contractVersionsRelations = relations(contractVersions, ({ one }) => ({
  tenant: one(tenants, { fields: [contractVersions.tenantId], references: [tenants.id] }),
  contract: one(contracts, {
    fields: [contractVersions.contractId],
    references: [contracts.id],
  }),
  author: one(users, { fields: [contractVersions.authorUserId], references: [users.id] }),
}));

export const clauseLibraryRelations = relations(clauseLibrary, ({ one }) => ({
  tenant: one(tenants, { fields: [clauseLibrary.tenantId], references: [tenants.id] }),
  creator: one(users, { fields: [clauseLibrary.createdBy], references: [users.id] }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type Contract = typeof contracts.$inferSelect;
export type NewContract = typeof contracts.$inferInsert;
export type ContractVersion = typeof contractVersions.$inferSelect;
export type NewContractVersion = typeof contractVersions.$inferInsert;
export type Clause = typeof clauseLibrary.$inferSelect;
export type NewClause = typeof clauseLibrary.$inferInsert;
export type ContractStatus = (typeof contractStatusEnum.enumValues)[number];
export type ContractType = (typeof contractTypeEnum.enumValues)[number];
export type ClauseCategory = (typeof clauseCategoryEnum.enumValues)[number];
