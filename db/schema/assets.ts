/**
 * Ordence — Universal Asset & Catalog Schema
 * Version: v0.3.0-alpha
 *
 * ONE TABLE, MANY INDUSTRIES.
 *
 * A real-estate developer tracks Buildings and Units. A construction firm tracks
 * Sites and Machinery. A logistics operator tracks Vehicles and Warehouses. These
 * are structurally the same problem: a named thing, with a status, with
 * industry-specific attributes, that can contain or relate to other things.
 *
 * `assets` models all of it. `asset_type` says what kind of thing it is;
 * `dynamic_attributes` (JSONB) holds whatever that industry needs.
 * `asset_relationships` is a proper graph edge table, so a Building can contain
 * Units, a Unit can be adjacent to another Unit, and a Vehicle can be assigned
 * to a Site — without inventing a new join table each time.
 *
 * WHY A GRAPH TABLE, not a parent_id column:
 *   A single `parent_id` only expresses containment, and only one hierarchy.
 *   Real portfolios need many relationship kinds at once (contains, serves,
 *   depends_on, replaces). An edge table gives us that for free and lets us add
 *   new relationship types without a migration.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  numeric,
  integer,
  boolean,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { companies, contacts, deals } from "./crm";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * Deliberately broad. Adding a value here is a migration, so the list covers the
 * verticals in the blueprint up front rather than one industry at a time.
 */
export const assetTypeEnum = pgEnum("asset_type", [
  // Real estate & construction
  "property",
  "building",
  "unit",
  "plot",
  "project",
  "site",
  // Physical operations
  "vehicle",
  "machinery",
  "equipment",
  "warehouse",
  "inventory_item",
  // Commercial
  "product",
  "service",
  "subscription_plan",
  "license",
  // Professional services
  "case",
  "matter",
  "contract",
  "policy",
  // Catch-all for tenant-defined types
  "custom",
]);

export const assetStatusEnum = pgEnum("asset_status", [
  "draft",
  "planned",
  "in_progress",
  "available",
  "reserved",
  "under_offer",
  "occupied",
  "sold",
  "leased",
  "maintenance",
  "inactive",
  "archived",
]);

export const assetRelationshipTypeEnum = pgEnum("asset_relationship_type", [
  "contains",        // Building contains Unit
  "part_of",         // Unit is part of Building
  "adjacent_to",     // Plot adjacent to Plot
  "serves",          // Machinery serves Site
  "assigned_to",     // Vehicle assigned to Project
  "depends_on",      // Phase depends on Phase
  "replaces",        // Equipment replaces Equipment
  "related_to",      // Generic association
]);

/* ------------------------------------------------------------------ */
/* TYPED JSONB SHAPES                                                  */
/* ------------------------------------------------------------------ */

/**
 * `dynamic_attributes` is intentionally open. These helper types document the
 * shapes we actually produce so consumers get autocomplete, without constraining
 * what a tenant may store.
 */
export type AssetDynamicAttributes = Record<string, unknown>;

/** Money figures are stored as strings to avoid float drift in JSONB. */
export type CostLineItem = {
  category: string;
  description?: string;
  budgeted: string;
  committed?: string;
  spent?: string;
  currency: string;
  variancePct?: number;
};

export type ContractorAssignment = {
  contractorName: string;
  scope: string;
  contractValue?: string;
  currency?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  retentionPct?: number;
};

export type ContractStage = {
  stage: string;
  status: "not_started" | "drafting" | "internal_review" | "counterparty_review" | "signed" | "executed";
  owner?: string;
  dueDate?: string;
  completedDate?: string;
  notes?: string;
};

/* ------------------------------------------------------------------ */
/* ASSETS                                                              */
/* ------------------------------------------------------------------ */

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    assetType: assetTypeEnum("asset_type").notNull(),
    /** Free-text subtype when `assetType` is "custom" or needs refining. */
    assetSubtype: varchar("asset_subtype", { length: 100 }),

    name: varchar("name", { length: 300 }).notNull(),
    /** Tenant-facing reference code, e.g. "BSVN-TWR-A-U304". */
    code: varchar("code", { length: 100 }),
    description: text("description"),

    status: assetStatusEnum("status").default("draft").notNull(),

    /** Everything industry-specific lives here. */
    dynamicAttributes: jsonb("dynamic_attributes")
      .$type<AssetDynamicAttributes>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /* --- Commonly queried values, promoted to real columns ---------- */
    /* Kept out of JSONB so they can be indexed, sorted and aggregated
       efficiently. Everything else stays dynamic.                      */

    valueAmount: numeric("value_amount", { precision: 18, scale: 2 }),
    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    /** Measured area with an explicit unit — never assume square feet. */
    areaValue: numeric("area_value", { precision: 14, scale: 2 }),
    areaUnit: varchar("area_unit", { length: 20 }).default("sqft"),

    quantity: integer("quantity").default(1).notNull(),

    addressLine1: varchar("address_line1", { length: 255 }),
    addressLine2: varchar("address_line2", { length: 255 }),
    locality: varchar("locality", { length: 150 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 120 }),
    postalCode: varchar("postal_code", { length: 20 }),
    country: varchar("country", { length: 2 }).default("IN"),

    /** WGS-84. Stored as numeric rather than PostGIS to stay on free Postgres. */
    latitude: numeric("latitude", { precision: 10, scale: 7 }),
    longitude: numeric("longitude", { precision: 10, scale: 7 }),

    acquiredDate: date("acquired_date"),
    commissionedDate: date("commissioned_date"),
    disposedDate: date("disposed_date"),

    isActive: boolean("is_active").default(true).notNull(),

    /* --- Optional links to CRM entities ----------------------------- */
    ownerCompanyId: uuid("owner_company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    primaryContactId: uuid("primary_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    linkedDealId: uuid("linked_deal_id").references(() => deals.id, {
      onDelete: "set null",
    }),

    assignedUserId: uuid("assigned_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    tenantIdx: index("assets_tenant_idx").on(t.tenantId),
    // The hot path: "all assets of type X for tenant Y".
    tenantTypeIdx: index("assets_tenant_type_idx").on(t.tenantId, t.assetType),
    tenantStatusIdx: index("assets_tenant_status_idx").on(t.tenantId, t.status),
    tenantNameIdx: index("assets_tenant_name_idx").on(t.tenantId, t.name),
    // Asset codes are unique per tenant when present.
    tenantCodeUnique: uniqueIndex("assets_tenant_code_unique")
      .on(t.tenantId, t.code)
      .where(sql`${t.code} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    // Makes `dynamic_attributes @> '{"phase":"foundation"}'` fast.
    attributesGinIdx: index("assets_attributes_gin").using("gin", t.dynamicAttributes),
    localityIdx: index("assets_locality_idx").on(t.tenantId, t.city, t.locality),
    ownerCompanyIdx: index("assets_owner_company_idx").on(t.tenantId, t.ownerCompanyId),
    assignedIdx: index("assets_assigned_idx").on(t.tenantId, t.assignedUserId),
    createdAtIdx: index("assets_created_at_idx").on(t.tenantId, t.createdAt),
  }),
);

/* ------------------------------------------------------------------ */
/* ASSET RELATIONSHIPS  (graph edges)                                  */
/* ------------------------------------------------------------------ */

export const assetRelationships = pgTable(
  "asset_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    parentAssetId: uuid("parent_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    childAssetId: uuid("child_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),

    relationshipType: assetRelationshipTypeEnum("relationship_type")
      .default("contains")
      .notNull(),

    /** Ordering of siblings, e.g. floor 1 before floor 2. */
    sortOrder: integer("sort_order").default(0).notNull(),

    /** Edge-specific data, e.g. { "shareOfCommonArea": 0.031 }. */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    // The same edge must not be recorded twice.
    edgeUnique: uniqueIndex("asset_rel_edge_unique")
      .on(t.parentAssetId, t.childAssetId, t.relationshipType)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdx: index("asset_rel_tenant_idx").on(t.tenantId),
    // Traverse downward: "children of this asset".
    parentIdx: index("asset_rel_parent_idx").on(t.tenantId, t.parentAssetId, t.sortOrder),
    // Traverse upward: "what contains this asset".
    childIdx: index("asset_rel_child_idx").on(t.tenantId, t.childAssetId),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const assetsRelations = relations(assets, ({ one, many }) => ({
  tenant: one(tenants, { fields: [assets.tenantId], references: [tenants.id] }),
  ownerCompany: one(companies, {
    fields: [assets.ownerCompanyId],
    references: [companies.id],
  }),
  primaryContact: one(contacts, {
    fields: [assets.primaryContactId],
    references: [contacts.id],
  }),
  linkedDeal: one(deals, { fields: [assets.linkedDealId], references: [deals.id] }),
  assignedUser: one(users, { fields: [assets.assignedUserId], references: [users.id] }),
  childRelationships: many(assetRelationships, { relationName: "parentAsset" }),
  parentRelationships: many(assetRelationships, { relationName: "childAsset" }),
}));

export const assetRelationshipsRelations = relations(assetRelationships, ({ one }) => ({
  tenant: one(tenants, { fields: [assetRelationships.tenantId], references: [tenants.id] }),
  parentAsset: one(assets, {
    fields: [assetRelationships.parentAssetId],
    references: [assets.id],
    relationName: "parentAsset",
  }),
  childAsset: one(assets, {
    fields: [assetRelationships.childAssetId],
    references: [assets.id],
    relationName: "childAsset",
  }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type AssetRelationship = typeof assetRelationships.$inferSelect;
export type NewAssetRelationship = typeof assetRelationships.$inferInsert;
export type AssetType = (typeof assetTypeEnum.enumValues)[number];
export type AssetStatus = (typeof assetStatusEnum.enumValues)[number];
export type AssetRelationshipType = (typeof assetRelationshipTypeEnum.enumValues)[number];

/** An asset with its immediate children resolved — the shape tree views use. */
export type AssetWithChildren = Asset & {
  children: Array<{ relationship: AssetRelationship; asset: Asset }>;
};
