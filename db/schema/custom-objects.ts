/**
 * Ordence — Dynamic Custom Object Metadata Framework
 * Version: v0.2.0-alpha
 *
 * THE VERTICAL SaaS ENGINE.
 *
 * A tenant in real estate needs "Properties". A construction firm needs "Sites".
 * A logistics operator needs "Vehicles". Creating a physical table per tenant per
 * entity would mean unbounded DDL, migration chaos, and a schema that no longer
 * fits in one head.
 *
 * Instead: tenants describe their entities as METADATA (`custom_object_definitions`
 * + `custom_field_definitions`), and the actual rows live in a single
 * `custom_object_records` table with a JSONB `data` column.
 *
 * TRADE-OFF, stated honestly:
 *   ✅ Zero migrations — a tenant defines a new entity in seconds
 *   ✅ One set of RLS policies protects every custom entity
 *   ✅ GIN indexes keep JSONB queries fast at CRM-scale data volumes
 *   ⚠️  No per-field FK constraints — validation is enforced in the application
 *       layer (`lib/validators/custom-objects.ts`) against the field definitions
 *   ⚠️  Aggregations over JSONB are slower than over native columns. If a tenant
 *       outgrows this, the migration path is to promote that entity to a real table.
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
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* FIELD TYPE SYSTEM                                                   */
/* ------------------------------------------------------------------ */

export const customFieldTypeEnum = pgEnum("custom_field_type", [
  "text",
  "textarea",
  "number",
  "currency",
  "date",
  "datetime",
  "select",
  "multiselect",
  "boolean",
  "email",
  "phone",
  "url",
]);

export type CustomFieldType = (typeof customFieldTypeEnum.enumValues)[number];

/** Options payload for `select` / `multiselect` fields. */
export type SelectOption = { label: string; value: string; color?: string };

/** Validation rules stored alongside a field definition. */
export type FieldValidation = {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** ISO-4217 code for `currency` fields. */
  currencyCode?: string;
  /** Decimal places for `number` / `currency`. */
  precision?: number;
};

/* ------------------------------------------------------------------ */
/* OBJECT DEFINITIONS — "what entities does this tenant have?"         */
/* ------------------------------------------------------------------ */

export const customObjectDefinitions = pgTable(
  "custom_object_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Singular display label, e.g. "Property". */
    name: varchar("name", { length: 100 }).notNull(),
    /** Plural display label, e.g. "Properties". */
    pluralName: varchar("plural_name", { length: 100 }).notNull(),
    /** URL-safe identifier, e.g. "property" → /objects/property */
    slug: varchar("slug", { length: 63 }).notNull(),

    /** Lucide icon name rendered in navigation, e.g. "building-2". */
    icon: varchar("icon", { length: 60 }).default("box").notNull(),
    color: varchar("color", { length: 20 }).default("#B08D3C").notNull(),
    description: text("description"),

    /**
     * Which field's value represents a record in lists and pickers.
     * Points at `custom_field_definitions.field_name`.
     */
    displayFieldName: varchar("display_field_name", { length: 100 }),

    /** System objects are seeded by an industry template and are not user-deletable. */
    isSystem: boolean("is_system").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),

    /** Ordering within the tenant's navigation sidebar. */
    sortOrder: integer("sort_order").default(0).notNull(),

    /** Industry template this object came from, if any (e.g. "real_estate"). */
    industryTemplate: varchar("industry_template", { length: 60 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantSlugUnique: uniqueIndex("cod_tenant_slug_unique")
      .on(t.tenantId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdx: index("cod_tenant_idx").on(t.tenantId),
    tenantActiveIdx: index("cod_tenant_active_idx").on(t.tenantId, t.isActive),
  }),
);

/* ------------------------------------------------------------------ */
/* FIELD DEFINITIONS — "what does each entity look like?"              */
/* ------------------------------------------------------------------ */

export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    objectDefinitionId: uuid("object_definition_id")
      .notNull()
      .references(() => customObjectDefinitions.id, { onDelete: "cascade" }),

    /** Key used inside `custom_object_records.data`. Immutable once created. */
    fieldName: varchar("field_name", { length: 100 }).notNull(),
    /** Human label shown in forms and grids. */
    label: varchar("label", { length: 150 }).notNull(),
    helpText: text("help_text"),
    placeholder: varchar("placeholder", { length: 200 }),

    fieldType: customFieldTypeEnum("field_type").notNull(),

    isRequired: boolean("is_required").default(false).notNull(),
    isUnique: boolean("is_unique").default(false).notNull(),
    /** Hidden fields still store data but are not rendered in the default UI. */
    isHidden: boolean("is_hidden").default(false).notNull(),
    /** Whether this column appears in the data grid by default. */
    showInGrid: boolean("show_in_grid").default(true).notNull(),

    /** Choices for select/multiselect. Empty for all other types. */
    options: jsonb("options")
      .$type<SelectOption[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /** Type-specific constraints applied at validation time. */
    validation: jsonb("validation")
      .$type<FieldValidation>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    defaultValue: text("default_value"),
    sortOrder: integer("sort_order").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    // Field names must be unique within their object, per tenant.
    objectFieldUnique: uniqueIndex("cfd_object_field_unique")
      .on(t.objectDefinitionId, t.fieldName)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdx: index("cfd_tenant_idx").on(t.tenantId),
    objectIdx: index("cfd_object_idx").on(t.tenantId, t.objectDefinitionId),
  }),
);

/* ------------------------------------------------------------------ */
/* RECORDS — the actual tenant data                                    */
/* ------------------------------------------------------------------ */

export const customObjectRecords = pgTable(
  "custom_object_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    definitionId: uuid("definition_id")
      .notNull()
      .references(() => customObjectDefinitions.id, { onDelete: "cascade" }),

    /**
     * Dynamic payload keyed by `custom_field_definitions.field_name`.
     * Validated against the field definitions before every write —
     * never trusted as-is.
     */
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /**
     * Denormalised copy of the display field, maintained on write.
     * Lets list views and pickers avoid unnesting JSONB for every row.
     */
    displayValue: varchar("display_value", { length: 500 }),

    /** Optional links back to core CRM entities. */
    relatedCompanyId: uuid("related_company_id"),
    relatedContactId: uuid("related_contact_id"),
    relatedDealId: uuid("related_deal_id"),

    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    tenantIdx: index("cor_tenant_idx").on(t.tenantId),
    // The hot path: "all records of object X for tenant Y".
    tenantDefinitionIdx: index("cor_tenant_definition_idx").on(t.tenantId, t.definitionId),
    // GIN index makes `data @> '{"status":"active"}'` fast.
    dataGinIdx: index("cor_data_gin").using("gin", t.data),
    displayValueIdx: index("cor_display_value_idx").on(t.tenantId, t.displayValue),
    ownerIdx: index("cor_owner_idx").on(t.tenantId, t.ownerId),
    createdAtIdx: index("cor_created_at_idx").on(t.tenantId, t.createdAt),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const customObjectDefinitionsRelations = relations(
  customObjectDefinitions,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [customObjectDefinitions.tenantId],
      references: [tenants.id],
    }),
    fields: many(customFieldDefinitions),
    records: many(customObjectRecords),
  }),
);

export const customFieldDefinitionsRelations = relations(
  customFieldDefinitions,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [customFieldDefinitions.tenantId],
      references: [tenants.id],
    }),
    objectDefinition: one(customObjectDefinitions, {
      fields: [customFieldDefinitions.objectDefinitionId],
      references: [customObjectDefinitions.id],
    }),
  }),
);

export const customObjectRecordsRelations = relations(customObjectRecords, ({ one }) => ({
  tenant: one(tenants, { fields: [customObjectRecords.tenantId], references: [tenants.id] }),
  definition: one(customObjectDefinitions, {
    fields: [customObjectRecords.definitionId],
    references: [customObjectDefinitions.id],
  }),
  owner: one(users, { fields: [customObjectRecords.ownerId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type CustomObjectDefinition = typeof customObjectDefinitions.$inferSelect;
export type NewCustomObjectDefinition = typeof customObjectDefinitions.$inferInsert;
export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect;
export type NewCustomFieldDefinition = typeof customFieldDefinitions.$inferInsert;
export type CustomObjectRecord = typeof customObjectRecords.$inferSelect;
export type NewCustomObjectRecord = typeof customObjectRecords.$inferInsert;

/** A definition together with its field list — the shape the UI renders from. */
export type CustomObjectWithFields = CustomObjectDefinition & {
  fields: CustomFieldDefinition[];
};
