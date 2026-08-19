/**
 * Ordence — Runtime Custom Objects (the METADATA layer)
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS PHASE CHANGES, AND WHY IT IS NOT A REFACTOR
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/custom-objects.ts` (Phase 2) is still here and still works.
 * It stores every tenant-defined record as a row in one shared table with
 * a JSONB `data` column. That was the right first answer and it has three
 * limits that no amount of indexing fixes:
 *
 *   • A JSONB key has no type. `data->>'price'` is text, so sorting by
 *     price puts "1000" before "9" and summing it is a cast per row.
 *   • A GIN index answers containment. It cannot answer "the ten most
 *     expensive", "the total for this project", or "due next week"
 *     without reading every row of every custom object in the workspace.
 *   • There is no NOT NULL, no UNIQUE, no FOREIGN KEY. Every rule is
 *     application code, so every path that forgets the validator is a
 *     path that stores data the validator would have refused.
 *
 * So this phase issues REAL `CREATE TABLE` at runtime. A tenant defining
 * "Site Visit" gets a physical table with typed columns, real indexes and
 * real foreign keys.
 *
 * The idea is not ours — Twenty CRM does runtime DDL and it is the right
 * shape. Two things here are deliberately unlike theirs:
 *
 *   ⭐ 1. THEIR RUNTIME TABLES HAVE NO ROW-LEVEL SECURITY. Isolation is
 *         enforced by the application layer adding a `WHERE`. Ours cannot
 *         work that way: a single-tenant deployment can afford an
 *         application-layer boundary, and a shared instance holding forty
 *         developers' buyer lists cannot. So `tenant_id NOT NULL`,
 *         `ENABLE` + `FORCE ROW LEVEL SECURITY` and a policy with both
 *         USING and WITH CHECK are attached IN THE SAME FUNCTION as the
 *         CREATE TABLE, in the same transaction. There is no code path
 *         that produces a table without them, because the function does
 *         not take "without RLS" as an argument. See
 *         `SQL-FILES/0019_phase24_dynamic_objects.sql` §4.
 *
 *   ⭐ 2. THE PHYSICAL TABLE NAME IS AN ADDRESS, NOT A LABEL. Renaming
 *         "Site Visit" to "Inspection" changes one varchar in this table
 *         and nothing else. No `ALTER TABLE … RENAME`, which would take
 *         an ACCESS EXCLUSIVE lock on a table that may hold millions of
 *         rows because somebody fixed a typo — and would invalidate every
 *         foreign key, index name, saved view and runbook naming the old
 *         one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE TWO RISKS THIS PHASE INTRODUCES THAT NO EARLIER PHASE HAD
 * ══════════════════════════════════════════════════════════════════════
 *   A. A TABLE WITHOUT RLS IS A CROSS-CUSTOMER LEAK. Not a bug — a leak.
 *      One forgotten `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and every
 *      tenant reads every other tenant's records of that type. Mitigated
 *      structurally (above) and verified after the fact: the create
 *      function RE-READS `pg_class` and `pg_policies` and raises if what
 *      it just made is not protected, which rolls the whole transaction
 *      back.
 *
 *   B. IDENTIFIERS CANNOT BE PARAMETERISED. `CREATE TABLE $1` is not
 *      valid SQL anywhere. Table and column names come from customers and
 *      end up INTERPOLATED. Mitigated by a strict allowlist in
 *      `lib/dynamic/identifiers.ts`, by `format('%I')` in the database,
 *      and by the SQL functions re-validating rather than trusting their
 *      caller. That file's header is the one to read.
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
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import {
  DYNAMIC_FIELD_TYPES,
  type DynamicFieldType,
  type SelectChoice,
} from "@/lib/dynamic/field-types";
import { MAX_FIELDS_PER_OBJECT, MAX_OBJECTS_PER_TENANT } from "@/lib/dynamic/limits";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BUILT FROM `lib/dynamic/field-types.ts`, NOT RESTATED.
 *
 * Same direction as `workflows.ts` and for the same reason: the DDL
 * planner, the value validator and the field builder all reason about
 * this list, while the column merely stores it. Two hand-maintained
 * copies eventually disagree, and the failure mode is a field the
 * database accepts and the planner cannot map to a column type — a field
 * that exists and can never be written to.
 */
export const dynamicFieldTypeEnum = pgEnum(
  "dynamic_field_type",
  DYNAMIC_FIELD_TYPES as unknown as [DynamicFieldType, ...DynamicFieldType[]],
);

/* ------------------------------------------------------------------ */
/* OBJECTS                                                             */
/* ------------------------------------------------------------------ */

/**
 * One row per tenant-defined record type, and one PHYSICAL TABLE behind
 * each of them.
 *
 * ⚠️ THIS ROW AND THAT TABLE ARE CREATED IN ONE TRANSACTION, ALWAYS.
 *
 * The two failure modes if they are not:
 *
 *   • A metadata row with no table. Every read of that object type fails
 *     with `relation "cx_…" does not exist` — an error the customer
 *     cannot act on, about a table they have never heard of, and the
 *     object appears in their navigation.
 *
 *   • A table with no metadata row. Invisible to the product, invisible
 *     to the tenant, counted against nobody's cap, and holding customer
 *     data that no retention or export path knows about. That is the
 *     worse one: it is a table full of personal data that nothing in the
 *     system can enumerate.
 *
 * `server/dynamic/objects.ts` writes both inside one `withTenant`
 * transaction. DDL is transactional in PostgreSQL — one of the few places
 * where it is — and this phase depends on that.
 */
export const dynamicObjects = pgTable(
  "dynamic_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⭐ IMMUTABLE. The machine name: `site_visit`.
     *
     * Appears in URLs, in the API, and in the physical table name. It is
     * validated by `assertIdentifier` before it is ever written, and
     * there is no code path that updates it — a rename changes `label`.
     * Changing it would either orphan the table (if the physical name
     * were left alone) or require an `ALTER TABLE … RENAME` (if it were
     * not), and both are described in the file header.
     */
    apiName: varchar("api_name", { length: 40 }).notNull(),

    /** What people see. Changes freely; the table never moves. */
    label: varchar("label", { length: 120 }).notNull(),
    pluralLabel: varchar("plural_label", { length: 120 }).notNull(),
    description: text("description"),

    icon: varchar("icon", { length: 60 }).default("box").notNull(),
    color: varchar("color", { length: 20 }).default("#B08D3C").notNull(),

    /**
     * ⭐ THE PHYSICAL TABLE. `cx_<api_name>_<8 hex>`.
     *
     * ⚠️ GLOBALLY UNIQUE, NOT UNIQUE PER TENANT — and the difference is
     * the point. Two workspaces both defining "Property" is the EXPECTED
     * case, and without the uuid discriminator the second `CREATE TABLE`
     * would fail with "relation already exists", telling one customer
     * about the existence of another. The physical namespace is shared;
     * the logical one is not.
     *
     * ⚠️ Every read of this column passes `assertPhysicalTableName()`
     * before it reaches a query. A value out of the database is still
     * untrusted on its way into an interpolated string.
     */
    physicalTableName: varchar("physical_table_name", { length: 63 }).notNull(),

    /** Which field represents a record in lists and pickers. An api name. */
    displayFieldApiName: varchar("display_field_api_name", { length: 50 }),

    isActive: boolean("is_active").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by"),

    /**
     * ⚠️ ARCHIVED, NOT DELETED — AND UNLIKE EVERY OTHER SOFT DELETE IN
     * THIS CODEBASE, THIS ONE IS ABOUT A TABLE RATHER THAN A ROW.
     *
     * Archiving hides the object from navigation and leaves the physical
     * table exactly where it is, with all of its data. Dropping it is a
     * separate, explicitly confirmed act (`dropDynamicObject`) that
     * requires the caller to state the row count they are destroying.
     *
     * Deleting a metadata row without dropping the table would produce
     * the second failure mode in the note above: a table full of personal
     * data that nothing in the product can enumerate. So the metadata row
     * is the last thing removed, in the same transaction as the DROP.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by"),
  },
  (t) => ({
    /** One live api name per workspace. */
    apiNamePerTenant: uniqueIndex("dynamic_objects_api_name_unique")
      .on(t.tenantId, t.apiName)
      .where(sql`${t.archivedAt} IS NULL`),

    /**
     * ⭐ GLOBAL. Two rows may never claim the same physical table, even
     * across tenants — that would be two workspaces reading and writing
     * one table, which the RLS policy would then be the only thing
     * separating. Not archived-scoped either: an archived object still
     * owns its table until somebody drops it.
     */
    physicalUnique: uniqueIndex("dynamic_objects_physical_unique").on(t.physicalTableName),

    tenantIdx: index("dynamic_objects_tenant_idx").on(t.tenantId),
    tenantActiveIdx: index("dynamic_objects_tenant_active_idx")
      .on(t.tenantId, t.isActive)
      .where(sql`${t.archivedAt} IS NULL`),

    /**
     * ⚠️ THE PREFIX, AS A CONSTRAINT RATHER THAN A CONVENTION.
     *
     * `lib/dynamic/identifiers.ts` builds the name with the prefix and
     * the SQL function refuses to create a table without it. This is the
     * third statement of the same rule, and it is the one that survives
     * somebody editing a row by hand: a metadata row pointing at `users`
     * would make the generic CRUD layer read and write the users table
     * under the caller's own tenant scope.
     */
    physicalIsPrefixed: check(
      "dynamic_objects_physical_prefixed",
      sql`${t.physicalTableName} ~ '^cx_[a-z][a-z0-9_]*$'`,
    ),

    apiNameShape: check(
      "dynamic_objects_api_name_shape",
      sql`${t.apiName} ~ '^[a-z][a-z0-9_]*$'`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* FIELDS                                                              */
/* ------------------------------------------------------------------ */

/**
 * One row per column on a runtime table.
 *
 * ⚠️ THIS TABLE IS A DESCRIPTION, NOT THE TRUTH. The truth is
 * `information_schema.columns` on the physical table. They agree because
 * both are written in one transaction, and the verification section of
 * `SQL-FILES/0019` checks that they still do — a metadata row describing
 * a column that does not exist produces a form field whose every write
 * fails, and a column with no metadata row is data the product cannot
 * show anybody.
 */
export const dynamicFields = pgTable(
  "dynamic_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => dynamicObjects.id, { onDelete: "cascade" }),

    /** ⭐ Immutable, and identical to the physical column name. */
    apiName: varchar("api_name", { length: 50 }).notNull(),
    label: varchar("label", { length: 150 }).notNull(),
    helpText: text("help_text"),
    placeholder: varchar("placeholder", { length: 200 }),

    fieldType: dynamicFieldTypeEnum("field_type").notNull(),

    /**
     * Stored separately from `api_name` even though they are equal today.
     *
     * ⚠️ NOT REDUNDANCY — A SEAM. If a future phase ever needs to prefix
     * physical columns (to allow a field called `select`, say, or to
     * migrate an object between shapes), the api name is what customers'
     * integrations and saved views reference and the column name is what
     * SQL references. Collapsing them now would make that migration a
     * breaking API change instead of an internal one.
     */
    physicalColumnName: varchar("physical_column_name", { length: 63 }).notNull(),

    isRequired: boolean("is_required").default(false).notNull(),
    isUnique: boolean("is_unique").default(false).notNull(),
    isIndexed: boolean("is_indexed").default(false).notNull(),
    isHidden: boolean("is_hidden").default(false).notNull(),
    showInGrid: boolean("show_in_grid").default(true).notNull(),

    /** Choices for `select` / `multi_select`. `SelectChoice[]`. */
    options: jsonb("options")
      .$type<SelectChoice[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /**
     * ⭐ WHERE A `relation` POINTS. EXACTLY ONE OF THESE TWO.
     *
     * `relationObjectId` — another runtime object in the same workspace.
     * `relationCoreTable` — one of a SHORT ALLOWLIST of built-in tables
     *   (`RELATION_CORE_TABLES`). Not "anything with a tenant_id": a
     *   foreign key into `audit_logs` would let a customer's own record
     *   pin an audit row in place and block retention from removing
     *   evidence about them.
     */
    relationObjectId: uuid("relation_object_id"),
    relationCoreTable: varchar("relation_core_table", { length: 63 }),

    defaultValue: text("default_value"),
    sortOrder: integer("sort_order").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * ⚠️ A SOFT-DELETED FIELD IS A DROPPED COLUMN.
     *
     * There is no "hidden but still there" state hiding behind this
     * timestamp. `removeDynamicField` drops the physical column in the
     * same transaction as it stamps this, because a column that the
     * product has stopped showing but is still storing is personal data
     * nobody knows they hold. Use `isHidden` for "do not show it".
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    fieldPerObject: uniqueIndex("dynamic_fields_object_name_unique")
      .on(t.objectId, t.apiName)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdx: index("dynamic_fields_tenant_idx").on(t.tenantId),
    objectIdx: index("dynamic_fields_object_idx").on(t.tenantId, t.objectId, t.sortOrder),

    apiNameShape: check(
      "dynamic_fields_api_name_shape",
      sql`${t.apiName} ~ '^[a-z][a-z0-9_]*$'
          AND ${t.physicalColumnName} ~ '^[a-z][a-z0-9_]*$'`,
    ),

    /**
     * ⚠️ A FIELD MAY NOT BE NAMED AFTER A SYSTEM COLUMN.
     *
     * Stated here as well as in `lib/dynamic/identifiers.ts` because this
     * one holds against a hand-written INSERT. `tenant_id` is the one
     * that matters: a writable field of that name is a form post choosing
     * which workspace a record belongs to, and the only thing refusing it
     * would be one clause in one policy.
     */
    notASystemColumn: check(
      "dynamic_fields_not_system_column",
      sql`${t.apiName} NOT IN ('id','tenant_id','created_at','updated_at',
                               'created_by','updated_by','deleted_at','deleted_by',
                               'ctid','oid','xmin','xmax','cmin','cmax','tableoid')`,
    ),

    /** Exactly one relation target, and only on a relation field. */
    relationTargetIsCoherent: check(
      "dynamic_fields_relation_target",
      sql`(${t.fieldType} = 'relation') = (
            (${t.relationObjectId} IS NOT NULL)::int
            + (${t.relationCoreTable} IS NOT NULL)::int = 1
          )
          AND NOT (${t.relationObjectId} IS NOT NULL AND ${t.relationCoreTable} IS NOT NULL)`,
    ),

    /**
     * A choice field with no choices allows nothing, so every write to it
     * fails — a field that exists and cannot be used.
     */
    choicesArePresent: check(
      "dynamic_fields_choices_present",
      sql`${t.fieldType} NOT IN ('select','multi_select')
          OR jsonb_array_length(${t.options}) > 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const dynamicObjectsRelations = relations(dynamicObjects, ({ one, many }) => ({
  tenant: one(tenants, { fields: [dynamicObjects.tenantId], references: [tenants.id] }),
  creator: one(users, { fields: [dynamicObjects.createdBy], references: [users.id] }),
  fields: many(dynamicFields),
}));

export const dynamicFieldsRelations = relations(dynamicFields, ({ one }) => ({
  tenant: one(tenants, { fields: [dynamicFields.tenantId], references: [tenants.id] }),
  object: one(dynamicObjects, {
    fields: [dynamicFields.objectId],
    references: [dynamicObjects.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type DynamicObject = typeof dynamicObjects.$inferSelect;
export type NewDynamicObject = typeof dynamicObjects.$inferInsert;
export type DynamicField = typeof dynamicFields.$inferSelect;
export type NewDynamicField = typeof dynamicFields.$inferInsert;

/** A definition with its columns — the shape every screen renders from. */
export type DynamicObjectWithFields = DynamicObject & { fields: DynamicField[] };

/**
 * Re-exported so a caller that has the schema does not need a second
 * import to know what the caps are. The numbers themselves live in
 * `lib/dynamic/limits.ts`, which is pure.
 */
export { MAX_OBJECTS_PER_TENANT, MAX_FIELDS_PER_OBJECT };
