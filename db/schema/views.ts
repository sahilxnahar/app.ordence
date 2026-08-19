/**
 * Ordence — Saved Views (the generalised views engine)
 * Version: v0.25.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS PHASE REPLACES
 * ══════════════════════════════════════════════════════════════════════
 * Phase 22 shipped a Kanban that works on leads and nothing else, with
 * eight hardcoded columns (`components/sales/pipeline-board.tsx`), and a
 * `saveViewSchema` in `lib/validators/sales.ts` that could store a filter
 * for one of three scopes. Both were right for one object. Neither
 * generalises, and the reason is stated in that validator:
 *
 *     ⚠️ `sortBy` is an ENUM, not a free string. A saved view is stored
 *     and replayed, so an arbitrary column name here would be an ORDER BY
 *     injection with a nice UI on top.
 *
 * That note is the whole design problem of this phase. An enum of nine
 * column names is a fine answer for two objects. For seven built-in
 * objects plus however many record types a customer defined at runtime in
 * Phase 24, it is not an answer at all — and "widen the enum" fails in the
 * direction nobody notices, because a column that is missing from it is
 * simply a column nobody can sort by, forever, with no error.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE TWO RISKS THIS TABLE CARRIES
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. IT STORES IDENTIFIERS AND REPLAYS THEM. `filter`, `sorts`,
 *    `group_by`, `date_field` and `visible_columns` all hold FIELD NAMES
 *    that become SQL identifiers on every read, months later. A column
 *    name cannot be a bind parameter, so it is interpolated.
 *
 *    ⚠️ THE DEFENCE IS NOT IN THIS FILE AND CANNOT BE. There is no column
 *    type, no CHECK constraint and no trigger that makes a stored string
 *    safe to interpolate. The defence is `lib/views/registry.ts`, which
 *    RESOLVES every stored name against a field table derived from real
 *    Drizzle schema metadata and returns nothing for a name that is not
 *    there. This table's job is to keep the payload SMALL (see the size
 *    constraint below), because that is the part a database can enforce.
 *
 * 2. ⭐ A SHARED VIEW IS A PERMISSION PROBLEM, NOT A SHARING FEATURE.
 *    `is_shared` puts a view in everybody's picker. It must not put the
 *    RECORDS in everybody's hands. The natural implementation — replay
 *    the query the author saved — authorises at save time, against the
 *    author, and hands a contractor the order book. See
 *    `lib/views/access.ts`; the enforcement is there, on every open,
 *    against the reader.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO `object_table` COLUMN
 * ══════════════════════════════════════════════════════════════════════
 * The obvious schema stores the table name so the query builder knows
 * what to select from. It would also mean the table a generic reader
 * queries is a varchar out of a row — so a single UPDATE on this table,
 * by anything, points a saved view at `users` and reads it under the
 * caller's own tenant scope, with RLS satisfied because the rows really
 * are theirs to read.
 *
 * So the table name is never stored. `object_key` selects an entry from a
 * frozen registry compiled into the application, and a runtime object is
 * reached through `dynamic_object_id` — a real foreign key to a row whose
 * `physical_table_name` is itself constrained to `^cx_[a-z][a-z0-9_]*$`
 * by Phase 24 and re-validated on every read.
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
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { dynamicObjects } from "./dynamic-objects";
import { VIEW_TYPES, type ViewType } from "@/lib/views/types";
import type { ColumnSpec, FilterGroup, SortSpec } from "@/lib/views/types";
import { MAX_FILTER_BYTES } from "@/lib/views/limits";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BUILT FROM `lib/views/types.ts`, NOT RESTATED.
 *
 * The same direction Phase 23 established for workflow actions and Phase
 * 24 for field types, for the same reason: the planner, the validator and
 * three renderers all reason about this list while the column merely
 * stores a value from it. Two hand-maintained copies eventually disagree,
 * and the failure mode is a row the database accepts that no renderer can
 * draw — a saved view that opens to a blank page.
 */
export const viewTypeEnum = pgEnum(
  "view_type",
  VIEW_TYPES as unknown as [ViewType, ...ViewType[]],
);

/* ------------------------------------------------------------------ */
/* SAVED VIEWS                                                         */
/* ------------------------------------------------------------------ */

export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⭐ WHICH RECORD TYPE. A KEY INTO A FROZEN REGISTRY, NOT A TABLE NAME.
     *
     * One of `lib/views/registry.ts`'s `VIEW_OBJECTS` keys — `lead`,
     * `unit`, `booking`, `project`, `contact`, `company`, `deal` — or the
     * literal `dynamic_object`, in which case `dynamic_object_id` names
     * the Phase 24 record type.
     *
     * ⚠️ NOT AN ENUM COLUMN, DELIBERATELY, AND IT IS THE ONE PLACE THIS
     * FILE DIVERGES FROM THE `view_type` DECISION ABOVE. Adding an object
     * to the registry would otherwise be an enum migration coordinated
     * with a deploy — and during the window between them, half the
     * instances accept a value the other half reject. An unrecognised key
     * fails CLOSED in `viewObject()`, which returns null, which is a
     * refusal. A varchar with a fail-closed reader is safer here than an
     * enum with a deploy-order problem.
     */
    objectKey: varchar("object_key", { length: 60 }).notNull(),

    /** Set only for `object_key = 'dynamic_object'`. Composite FK in §3. */
    dynamicObjectId: uuid("dynamic_object_id"),

    name: varchar("name", { length: 80 }).notNull(),
    description: text("description"),

    viewType: viewTypeEnum("view_type").default("table").notNull(),

    /**
     * ⭐ THE FILTER TREE. Nested AND/OR groups; shape in `lib/views/types.ts`.
     *
     * ⚠️ THE FIELD NAMES IN HERE ARE UNTRUSTED INPUT WITH A LONG LIFE.
     * They were written by a customer, they have been sitting in this
     * column for months, and they become SQL identifiers every time
     * somebody opens the view. `lib/views/planner.ts` resolves every one
     * of them against the registry on every single run — never on the way
     * in, never once and cached, and never trusted because it is "our own
     * data". That assumption is what second-order SQL injection is.
     */
    filter: jsonb("filter")
      .$type<FilterGroup>()
      .default(sql`'{"type":"group","match":"all","children":[]}'::jsonb`)
      .notNull(),

    /** Multi-key sort. `SortSpec[]`, capped at `MAX_SORTS` by the validator. */
    sorts: jsonb("sorts")
      .$type<SortSpec[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /**
     * Kanban columns come from here. NOT NULL for `kanban` — see the
     * check constraint, and the note on it about why a board with no
     * grouping is worse than no board.
     */
    groupBy: varchar("group_by", { length: 63 }),

    /** Which date a calendar draws a record on. NOT NULL for `calendar`. */
    dateField: varchar("date_field", { length: 63 }),

    /**
     * Visible columns AND THEIR ORDER, as an array — not a set.
     *
     * ⚠️ The order is the data. A `jsonb` object keyed by field name would
     * lose it, and "why do my columns keep rearranging?" is a bug report
     * that takes a week to reproduce because jsonb key order is stable
     * right up until a row is rewritten.
     */
    visibleColumns: jsonb("visible_columns")
      .$type<ColumnSpec[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /* --- ⭐ OWNERSHIP AND SHARING ---------------------------------- */

    /**
     * Whose view this is.
     *
     * ⚠️ THIS DECIDES WHO MAY EDIT IT. IT NEVER DECIDES WHAT IT RETURNS.
     * The distinction is the whole of `lib/views/access.ts`: a shared
     * view replayed with its author's scope is a privilege escalation with
     * a friendly name, and the only structural defence is that no code
     * path takes this column into a query's WHERE clause.
     */
    ownerUserId: uuid("owner_user_id").notNull(),

    /** In everybody's picker. Grants nothing — see the note above. */
    isShared: boolean("is_shared").default(false).notNull(),

    /**
     * The workspace's default view for this object, for people who have
     * not chosen one. At most one per object — see the partial index.
     *
     * A per-USER default lives in `saved_view_defaults`, because a user's
     * choice is about them and this is about the workspace, and storing
     * both here would mean one boolean answering two questions.
     */
    isWorkspaceDefault: boolean("is_workspace_default").default(false).notNull(),

    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ ONE NAME PER PERSON PER OBJECT. Not globally unique per tenant:
     * two people both having a view called "My leads" is the expected
     * case, and refusing the second one tells one user about the other's
     * private view.
     *
     * ⚠️⚠️ TWO PARTIAL INDEXES RATHER THAN ONE INDEX OVER FOUR COLUMNS,
     * AND THE REASON IS THE SUBTLEST BUG IN THIS FILE.
     *
     * `dynamic_object_id` is NULL for every built-in object, and in a
     * PostgreSQL unique index NULLs are DISTINCT FROM EACH OTHER. So a
     * single index on (tenant, owner, object_key, dynamic_object_id,
     * name) enforces nothing at all for built-ins: (A, u, 'lead', NULL,
     * 'My leads') twice is two distinct keys and both rows are accepted.
     *
     * The index looks correct, `\d` shows it as UNIQUE, and it silently
     * enforces nothing. Splitting on `IS NULL` removes the nullable
     * column from the key in the case where it is always null.
     */
    nameUniquePerOwner: uniqueIndex("saved_views_name_unique")
      .on(t.tenantId, t.ownerUserId, t.objectKey, t.name)
      .where(sql`${t.dynamicObjectId} IS NULL`),
    nameUniquePerOwnerDynamic: uniqueIndex("saved_views_name_unique_dynamic")
      .on(t.tenantId, t.ownerUserId, t.dynamicObjectId, t.name)
      .where(sql`${t.dynamicObjectId} IS NOT NULL`),

    tenantIdx: index("saved_views_tenant_idx").on(t.tenantId),
    /** The picker's query: my views plus the shared ones, for this object. */
    pickerIdx: index("saved_views_picker_idx").on(t.tenantId, t.objectKey, t.isShared),
    ownerIdx: index("saved_views_owner_idx").on(t.tenantId, t.ownerUserId),
    dynamicIdx: index("saved_views_dynamic_idx")
      .on(t.tenantId, t.dynamicObjectId)
      .where(sql`${t.dynamicObjectId} IS NOT NULL`),

    /**
     * ⭐ AT MOST ONE WORKSPACE DEFAULT PER OBJECT.
     *
     * Two defaults means the list page picks whichever the planner
     * returned first, so half the workspace opens one view and half opens
     * another and nobody can reproduce the other's screen.
     */
    oneWorkspaceDefault: uniqueIndex("saved_views_one_workspace_default")
      .on(t.tenantId, t.objectKey)
      .where(sql`${t.isWorkspaceDefault} AND ${t.dynamicObjectId} IS NULL`),
    oneWorkspaceDefaultDynamic: uniqueIndex("saved_views_one_workspace_default_dyn")
      .on(t.tenantId, t.dynamicObjectId)
      .where(sql`${t.isWorkspaceDefault} AND ${t.dynamicObjectId} IS NOT NULL`),

    /** Exactly one of the two object selectors. Mirrors the zod refinement. */
    objectSelectorCoherent: check(
      "saved_views_object_selector",
      sql`(${t.objectKey} = 'dynamic_object') = (${t.dynamicObjectId} IS NOT NULL)`,
    ),

    /**
     * ⚠️ A BOARD WITHOUT COLUMNS IS WORSE THAN NO BOARD.
     *
     * A kanban with a null `group_by` renders as one unlabelled column
     * holding every record — which reads as "the board is broken", not as
     * "this view is misconfigured", and the person seeing it has no idea
     * what to fix. A calendar with no date field renders as nothing at
     * all. Neither is a state worth being able to save.
     */
    kanbanHasGrouping: check(
      "saved_views_kanban_has_grouping",
      sql`${t.viewType} <> 'kanban' OR ${t.groupBy} IS NOT NULL`,
    ),
    calendarHasDate: check(
      "saved_views_calendar_has_date",
      sql`${t.viewType} <> 'calendar' OR ${t.dateField} IS NOT NULL`,
    ),

    /**
     * ⭐ THE DENIAL-OF-SERVICE BACKSTOP, AND THE ONLY LIMIT IN THIS PHASE
     * THAT SURVIVES A HAND-WRITTEN INSERT.
     *
     * Depth and node count are enforced by `lib/views/validation.ts` at
     * save time and by `lib/views/planner.ts` at replay time. Both are
     * application rules, and a support engineer in psql, a restore from
     * an older schema, a bulk import or a future API route each walk past
     * them. A tree of 200,000 nodes is a query that never finishes,
     * holding a connection from a pool every other workspace on the
     * instance shares — so the size ceiling is stated where nothing can
     * route around it.
     */
    filterIsBounded: check(
      "saved_views_filter_bounded",
      sql`pg_column_size(${t.filter}) <= ${sql.raw(String(MAX_FILTER_BYTES))}`,
    ),

    /**
     * ⚠️ A SHARED VIEW MAY BE THE WORKSPACE DEFAULT; A PRIVATE ONE MAY
     * NOT. Making somebody's private working list the default for
     * everybody would show the whole workspace a view they cannot see in
     * their picker, cannot edit and cannot find the owner of.
     */
    workspaceDefaultIsShared: check(
      "saved_views_workspace_default_is_shared",
      sql`NOT ${t.isWorkspaceDefault} OR ${t.isShared}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* PER-USER DEFAULTS                                                   */
/* ------------------------------------------------------------------ */

/**
 * "When I open Leads, show me this view."
 *
 * ⚠️ A SEPARATE TABLE RATHER THAN A COLUMN ON `saved_views`, AND THE
 * REASON IS THAT THE CHOICE IS NOT A PROPERTY OF THE VIEW.
 *
 * Forty people can each choose the same shared view as their default. As
 * a boolean on the view that is one row with forty meanings; as a row per
 * person it is forty rows with one meaning each, and unsharing the view
 * cleans up correctly by cascade instead of leaving a flag that used to
 * mean something.
 *
 * It also keeps the write cheap: choosing a default is one upsert into a
 * tiny table, not an UPDATE on a row half the workspace is reading.
 */
export const savedViewDefaults = pgTable(
  "saved_view_defaults",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    userId: uuid("user_id").notNull(),

    /** Repeated from the view so the lookup needs no join. */
    objectKey: varchar("object_key", { length: 60 }).notNull(),
    dynamicObjectId: uuid("dynamic_object_id"),

    /**
     * ⚠️ CASCADES ON DELETE. A default pointing at a deleted view would
     * make the object's list page fail to open, for one user, with an
     * error nobody else can reproduce. Losing the preference is the
     * correct outcome: they fall back to the workspace default.
     */
    viewId: uuid("view_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** Split on `IS NULL` for the reason spelled out on `saved_views`. */
    onePerUserPerObject: uniqueIndex("saved_view_defaults_unique")
      .on(t.tenantId, t.userId, t.objectKey)
      .where(sql`${t.dynamicObjectId} IS NULL`),
    onePerUserPerDynamicObject: uniqueIndex("saved_view_defaults_unique_dynamic")
      .on(t.tenantId, t.userId, t.dynamicObjectId)
      .where(sql`${t.dynamicObjectId} IS NOT NULL`),
    tenantIdx: index("saved_view_defaults_tenant_idx").on(t.tenantId),
    viewIdx: index("saved_view_defaults_view_idx").on(t.viewId),

    objectSelectorCoherent: check(
      "saved_view_defaults_object_selector",
      sql`(${t.objectKey} = 'dynamic_object') = (${t.dynamicObjectId} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const savedViewsRelations = relations(savedViews, ({ one, many }) => ({
  tenant: one(tenants, { fields: [savedViews.tenantId], references: [tenants.id] }),
  owner: one(users, { fields: [savedViews.ownerUserId], references: [users.id] }),
  dynamicObject: one(dynamicObjects, {
    fields: [savedViews.dynamicObjectId],
    references: [dynamicObjects.id],
  }),
  defaults: many(savedViewDefaults),
}));

export const savedViewDefaultsRelations = relations(savedViewDefaults, ({ one }) => ({
  tenant: one(tenants, { fields: [savedViewDefaults.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [savedViewDefaults.userId], references: [users.id] }),
  view: one(savedViews, {
    fields: [savedViewDefaults.viewId],
    references: [savedViews.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type SavedView = typeof savedViews.$inferSelect;
export type NewSavedView = typeof savedViews.$inferInsert;
export type SavedViewDefault = typeof savedViewDefaults.$inferSelect;
export type NewSavedViewDefault = typeof savedViewDefaults.$inferInsert;

/** Re-exported so a caller holding the schema needs no second import. */
export type { ViewType } from "@/lib/views/types";
