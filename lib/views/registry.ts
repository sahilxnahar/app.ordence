/**
 * Ordence — The View Registry
 * Version: v0.25.0-alpha
 *
 * Pure. No `@/db` client import, no I/O — the same rule Phase 5's
 * `lib/permissions.ts` follows when it imports the permission catalogue
 * from `@/db/schema/auth`. What is imported here is SCHEMA METADATA
 * (Drizzle's own description of the tables), never a database connection.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THIS FILE IS THE SECURITY BOUNDARY OF THE ENTIRE PHASE ⭐⭐
 * ══════════════════════════════════════════════════════════════════════
 * A saved view stores field names. Those names come back weeks later and
 * become SQL IDENTIFIERS — in `WHERE`, in `ORDER BY`, in `GROUP BY`, in
 * the select list. An identifier cannot be a bind parameter:
 *
 *     ORDER BY $1        sorts every row by the constant string "name"
 *     SELECT $1 FROM $2  is not valid SQL in any database
 *
 * So the name is interpolated. That is unavoidable, and it is exactly the
 * ORDER BY injection that `lib/validators/sales.ts` warns about where it
 * pins `sortBy` to a `z.enum`. That enum worked because there were two
 * objects and nine columns. It does not generalise, and "make the enum
 * bigger" is how a column somebody added last week ends up unsortable and
 * a column somebody typed ends up in a statement.
 *
 * ⚠️ THE RULE, AND IT HAS NO EXCEPTIONS:
 *
 *   A field name that arrives from outside is RESOLVED, never used. It is
 *   looked up in the table below; the lookup returns a descriptor or
 *   `null`. Only `descriptor.column` reaches SQL, and that string came out
 *   of Drizzle's schema metadata — not out of the request, not out of the
 *   `saved_views` row, not out of a `format()` call. An unresolved name is
 *   a refusal. There is no fallback, no sanitiser, no "strip the bad
 *   characters and carry on".
 *
 * Note what that buys beyond escaping: even a PERFECTLY VALID identifier
 * is refused if it is not a field of THIS object. `sortBy: "tenant_id"`
 * is not an injection and it is still a refusal, because `tenant_id` is
 * not in the table. So is `password_hash` on a table that has one. An
 * escape function would have passed both.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE FIELD LISTS ARE DERIVED AND NOT TYPED OUT
 * ══════════════════════════════════════════════════════════════════════
 * `lib/workflows/records.ts` lists its columns by hand, correctly: that
 * catalogue is a policy about what an automation may WRITE, and a column
 * added later must be opt-in, because the safe default for a write is
 * "no".
 *
 * This file is the opposite case. It describes what may be READ, sorted
 * and filtered on by somebody who already holds the object's read
 * permission — and a hand-written list there fails in the direction
 * nobody notices: a developer adds `leads.locality`, nobody adds it here,
 * and eight months later a customer asks why they cannot filter by
 * locality. The answer is a shrug, and the fix is a deploy.
 *
 * So the field table is built by `getTableColumns()` from the Drizzle
 * definition, and each object states only what to HIDE. A new column is
 * filterable the day it exists; a new column that must not be is one line
 * in a `hide` list, right next to the reason.
 */

import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { leads, units, bookings, projects, channelPartners } from "@/db/schema/sales";
import { contacts, companies, deals } from "@/db/schema/crm";

import type { FieldKind, SortSpec } from "./types";

/* ------------------------------------------------------------------ */
/* DESCRIPTORS                                                         */
/* ------------------------------------------------------------------ */

export type ViewFieldDescriptor = {
  /** The stable name a saved view stores. Equal to the column name. */
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  /**
   * ⭐ THE ONLY STRING IN THIS PHASE THAT EVER BECOMES AN SQL IDENTIFIER.
   *
   * It comes from `getTableColumns()` — Drizzle's own metadata, compiled
   * into the bundle — so it is a constant of the deployed program rather
   * than data. It is quoted anyway by `quoteColumn()` in the planner,
   * because a defence that exists once exists until somebody refactors
   * it.
   */
  readonly column: string;
  /** Non-null for enums, and checked against by the validator. */
  readonly enumValues: readonly string[] | null;
  readonly filterable: boolean;
  readonly sortable: boolean;
  /**
   * May a Kanban board or a group-by use it?
   *
   * ⚠️ ENUM, BOOLEAN AND RELATION ONLY. Grouping by a free-text column in
   * a workspace with 400,000 leads asks PostgreSQL for 400,000 distinct
   * values and then asks the browser to draw a board with 400,000
   * columns. Neither refuses; both stop responding.
   */
  readonly groupable: boolean;
};

export type ViewObjectDefinition = {
  readonly key: string;
  /** ⭐ The real table. Never taken from input, never from a stored row. */
  readonly table: string;
  readonly label: string;
  readonly pluralLabel: string;
  /**
   * ⭐ THE PERMISSION THE CALLER MUST HOLD — checked against the person
   * OPENING the view, never against the person who saved it. See the
   * header of `server/views/guards.ts`.
   */
  readonly readPermission: string;
  /**
   * The column naming who a record belongs to, or null when the object
   * has no owner concept (a unit belongs to the building, not to a rep).
   *
   * ⭐ THE SCOPE NARROWING HANGS OFF THIS. A caller without
   * `views:read_all_records` has `owner = me` ANDed into every query over
   * this object — supplied by the caller's context, never by the view.
   */
  readonly ownerColumn: string | null;
  /** True when the table has `deleted_at` and reads must exclude it. */
  readonly softDelete: boolean;
  readonly defaultSorts: readonly SortSpec[];
  readonly defaultColumns: readonly string[];
  readonly defaultGroupBy: string | null;
  readonly defaultDateField: string | null;
  readonly fields: Readonly<Record<string, ViewFieldDescriptor>>;
};

/* ------------------------------------------------------------------ */
/* DERIVATION                                                          */
/* ------------------------------------------------------------------ */

/**
 * Columns hidden from EVERY object, whatever the table.
 *
 * ⚠️ `tenant_id` IS THE IMPORTANT ONE AND IT IS NOT ABOUT INJECTION.
 * A filterable `tenant_id` is a filter on the isolation boundary itself.
 * RLS would still refuse to return another workspace's rows — but a view
 * that can say `tenant_id != <mine>` is a probe that answers "does that
 * workspace exist" from the row count, and a view that says
 * `tenant_id = <mine>` is a UI that has taught its users the boundary is
 * a field like any other. It is never offered.
 *
 * `deleted_by` and `deleted_at` are hidden because soft-deleted rows are
 * excluded by the planner, so filtering on them can only ever produce an
 * empty result and a support ticket.
 */
const ALWAYS_HIDDEN: readonly string[] = Object.freeze([
  "tenant_id",
  "deleted_at",
  "deleted_by",
]);

type ObjectPolicy = {
  key: string;
  label: string;
  pluralLabel: string;
  readPermission: string;
  ownerColumn: string | null;
  softDelete: boolean;
  /** Columns to withhold, each with the reason in a comment at the call site. */
  hide?: readonly string[];
  /** Columns that are text in Postgres and a relation to a person. */
  defaultSorts: readonly SortSpec[];
  defaultColumns: readonly string[];
  defaultGroupBy?: string | null;
  defaultDateField?: string | null;
};

/**
 * PostgreSQL type → semantic kind.
 *
 * ⚠️ THE `_minor` SUFFIX IS LOAD-BEARING. Phase 11 settled on bigint minor
 * units for every amount in the product, and the suffix is the convention
 * that marks them. Without this branch `agreement_value_minor` is a plain
 * number, the filter box asks for "450000000" instead of "45000000.00",
 * and somebody eventually types the rupee figure into a paise field.
 */
function inferKind(columnName: string, columnType: string, isEnum: boolean): FieldKind {
  if (isEnum) return "enum";
  if (columnType === "PgBoolean") return "boolean";
  if (columnType.startsWith("PgTimestamp") || columnType.startsWith("PgDate")) return "date";
  if (columnType === "PgUUID") return "uuid";
  if (columnType === "PgJsonb" || columnType === "PgJson") return "json";
  if (columnName.endsWith("_minor")) return "money";
  if (
    columnType === "PgInteger" ||
    columnType === "PgSmallInt" ||
    columnType === "PgBigInt53" ||
    columnType === "PgBigInt64" ||
    columnType === "PgDoublePrecision" ||
    columnType === "PgReal" ||
    columnType === "PgNumeric"
  ) {
    return "number";
  }
  return "text";
}

/** `next_follow_up_at` → "Next follow up", `owner_id` → "Owner". */
export function humaniseFieldName(column: string): string {
  const stripped = column.replace(/_id$/, "").replace(/_minor$/, "").replace(/_at$/, "");
  const words = stripped.split("_").filter(Boolean);
  if (words.length === 0) return column;
  return words
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function describeTable(
  table: PgTable,
  policy: ObjectPolicy,
): Readonly<Record<string, ViewFieldDescriptor>> {
  const hidden = new Set([...ALWAYS_HIDDEN, ...(policy.hide ?? [])]);
  const fields: Record<string, ViewFieldDescriptor> = {};

  for (const column of Object.values(getTableColumns(table))) {
    const name = column.name;
    if (hidden.has(name)) continue;

    const columnType = (column as { columnType?: string }).columnType ?? "";
    const enumValues = (column as { enumValues?: readonly string[] }).enumValues ?? null;
    const kind = inferKind(name, columnType, Array.isArray(enumValues) && enumValues.length > 0);

    fields[name] = Object.freeze({
      name,
      label: humaniseFieldName(name),
      kind,
      column: name,
      enumValues: kind === "enum" ? Object.freeze([...(enumValues ?? [])]) : null,
      filterable: kind !== "json",
      sortable: kind !== "json",
      groupable: kind === "enum" || kind === "boolean" || kind === "uuid",
    });
  }

  return Object.freeze(fields);
}

function defineObject(table: PgTable, policy: ObjectPolicy): ViewObjectDefinition {
  const fields = describeTable(table, policy);

  // ⚠️ Fail LOUDLY at module load if a default names a field that does not
  // exist. The alternative is a view that opens with no columns and a
  // customer who reports "the leads page is blank" — a bug that is
  // invisible in every test that does not render that exact page.
  for (const name of policy.defaultColumns) {
    if (!Object.hasOwn(fields, name)) {
      throw new Error(
        `View registry: "${policy.key}" lists default column "${name}", which is ` +
          `not a field of ${policy.label}. Fix lib/views/registry.ts.`,
      );
    }
  }

  return Object.freeze({
    key: policy.key,
    // ⚠️ Read out of Drizzle's own metadata rather than retyped as a
    // literal. A retyped table name is a second source of truth, and the
    // day somebody renames a table it produces `relation "leads" does not
    // exist` from this one file and nowhere else in the codebase.
    table: getTableName(table),
    label: policy.label,
    pluralLabel: policy.pluralLabel,
    readPermission: policy.readPermission,
    ownerColumn: policy.ownerColumn,
    softDelete: policy.softDelete,
    defaultSorts: Object.freeze([...policy.defaultSorts]),
    defaultColumns: Object.freeze([...policy.defaultColumns]),
    defaultGroupBy: policy.defaultGroupBy ?? null,
    defaultDateField: policy.defaultDateField ?? null,
    fields,
  });
}

/* ------------------------------------------------------------------ */
/* THE OBJECTS                                                         */
/* ------------------------------------------------------------------ */

export const VIEW_OBJECTS: Readonly<Record<string, ViewObjectDefinition>> = Object.freeze({
  lead: defineObject(leads, {
    key: "lead",
    label: "Lead",
    pluralLabel: "Leads",
    readPermission: "leads:read",
    ownerColumn: "owner_id",
    softDelete: true,
    // ⚠️ `consent_source` and `consent_at` are DPDP evidence. They are not
    // hidden — a compliance officer filtering "leads with no consent on
    // record" is exactly the report this engine exists to make possible.
    hide: [
      // Free-text of arbitrary length. Sorting and grouping it is a full
      // sort of a text column nobody indexes; it is shown, not filtered.
      "requirement",
      // Two floats that mean one place. Filtering "latitude > 12.9" is
      // never what anybody wants and the pair needs a geo operator this
      // engine does not have.
      "latitude",
      "longitude",
    ],
    defaultSorts: [{ field: "updated_at", direction: "desc" }],
    defaultColumns: [
      "name",
      "status",
      "temperature",
      "source",
      "score",
      "owner_id",
      "next_follow_up_at",
    ],
    defaultGroupBy: "status",
    defaultDateField: "next_follow_up_at",
  }),

  unit: defineObject(units, {
    key: "unit",
    label: "Unit",
    pluralLabel: "Units",
    readPermission: "units:read",
    // A unit has no owner. `held_by_user_id` is who is holding it TODAY,
    // which is a state that expires — using it as an ownership boundary
    // would make inventory appear and disappear as holds lapse.
    ownerColumn: null,
    softDelete: true,
    hide: ["hold_note"],
    defaultSorts: [{ field: "code", direction: "asc" }],
    defaultColumns: ["code", "tower", "floor", "typology", "carpet_area_sqft", "price_minor", "status"],
    defaultGroupBy: "status",
    defaultDateField: "hold_until",
  }),

  booking: defineObject(bookings, {
    key: "booking",
    label: "Booking",
    pluralLabel: "Bookings",
    readPermission: "bookings:read",
    ownerColumn: "sales_rep_id",
    // ⚠️ `bookings` has NO `deleted_at`, and that is Phase 22 being
    // deliberate: a booking is cancelled, never deleted, because it moved
    // money. Claiming soft-delete here would add `deleted_at IS NULL` to
    // every query and every one of them would fail.
    softDelete: false,
    hide: ["cancel_reason"],
    defaultSorts: [{ field: "booked_at", direction: "desc" }],
    defaultColumns: [
      "reference",
      "status",
      "payment_status",
      "agreement_value_minor",
      "sales_rep_id",
      "booked_at",
    ],
    defaultGroupBy: "status",
    defaultDateField: "booked_at",
  }),

  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐ CHANNEL PARTNERS — THE `hide` LIST IS THE WHOLE ENTRY
   * ══════════════════════════════════════════════════════════════════
   * Every other object in this registry is a record about the
   * customer's own business. This one is a register of THIRD PARTIES —
   * individual brokers, most of them sole proprietors — and it holds
   * their statutory identity numbers.
   *
   * ⚠️ THE THREAT IS NOT SQL INJECTION. It is a completely legitimate
   * saved view. Anybody holding `partners:read` can build one, tick
   * `pan_number` as a visible column, share it with the workspace, and
   * every rep now has a one-click, paginated, sortable export of every
   * broker's PAN. Nothing errors, nothing is logged as unusual, and it
   * survives the person who built it leaving the company.
   *
   * A PAN is an Indian taxpayer identity number. Under the DPDP Act it
   * is personal data of a natural person, and the developer holding it
   * is the fiduciary. "It was in a report" is not a defence, and the
   * broker never agreed that the whole sales floor could read it.
   *
   * ⚠️ HIDDEN HERE MEANS ABSENT FROM THE FIELD MAP ENTIRELY — not
   * merely unfilterable. `resolveField()` returns null for these
   * names, so a stored view naming one is refused on replay, and a
   * view saved before this entry existed cannot become an export
   * either. The partner DETAIL page still shows them to somebody who
   * opened that one broker on purpose. Reading one record is a
   * different act from listing four hundred.
   *
   * ⚠️ WHAT IS DELIBERATELY *NOT* HIDDEN, so the next reader does not
   * assume it was forgotten:
   *
   *   `rera_number` — a RERA agent registration is a PUBLIC register
   *     entry by statute. It is also the single most useful compliance
   *     filter in the product: "which of our brokers have no RERA
   *     number on file" is precisely the report a developer must be
   *     able to run before paying anybody.
   *
   *   the four `commission_*` columns — the partners LIST PAGE already
   *     prints the commission terms to everyone holding
   *     `partners:read`. Hiding them from saved views while showing
   *     them on the page would be theatre: it would block "sort
   *     brokers by rate" without withholding a single fact.
   *
   *   bank details — there are none on this table. Bank accounts live
   *     on `ledgers.bank_details`, which is jsonb and is not a views
   *     object at all. Stated because the absence looks like an
   *     oversight and is not.
   */
  channel_partner: defineObject(channelPartners, {
    key: "channel_partner",
    label: "Channel partner",
    pluralLabel: "Channel partners",
    readPermission: "partners:read",
    // A broker belongs to the firm, not to a rep. `leads.channel_partner_id`
    // records who introduced a buyer; that is an attribution, and using it
    // as an ownership boundary would hide a broker from the finance team
    // who have to pay them.
    ownerColumn: null,
    softDelete: true,
    hide: [
      // ⭐ Permanent Account Number. A taxpayer identity, unique to one
      // person for life, and the key that joins this broker to every
      // other record about them anywhere.
      "pan_number",
      // ⭐ The GSTIN embeds the PAN — characters 3 to 12 ARE the PAN.
      // Hiding `pan_number` and offering `gstin` would withhold the
      // field and hand over the value, which is worse than doing
      // neither, because it would look like a control.
      "gstin",
      // Free text about a counterparty: disputes, why a payout was
      // held, what somebody was told on the phone. Sorting and
      // filtering it is a search across unstructured commentary about
      // named individuals.
      "notes",
    ],
    defaultSorts: [{ field: "firm_name", direction: "asc" }],
    defaultColumns: [
      "firm_name",
      "contact_name",
      "phone",
      "commission_basis",
      "commission_rate_bps",
      "kyc_status",
      "status",
    ],
    defaultGroupBy: "status",
    defaultDateField: "created_at",
  }),

  project: defineObject(projects, {
    key: "project",
    label: "Project",
    pluralLabel: "Projects",
    readPermission: "projects:read",
    ownerColumn: null,
    softDelete: true,
    hide: ["description", "address_line", "latitude", "longitude"],
    defaultSorts: [{ field: "code", direction: "asc" }],
    defaultColumns: ["code", "name", "city", "is_active", "expected_completion_at"],
    defaultGroupBy: "is_active",
    defaultDateField: "expected_completion_at",
  }),

  contact: defineObject(contacts, {
    key: "contact",
    label: "Contact",
    pluralLabel: "Contacts",
    readPermission: "contacts:read",
    ownerColumn: "owner_id",
    softDelete: true,
    hide: ["notes"],
    defaultSorts: [{ field: "updated_at", direction: "desc" }],
    defaultColumns: ["first_name", "last_name", "email", "phone", "company_id", "owner_id"],
    defaultGroupBy: "owner_id",
    defaultDateField: "last_contacted_at",
  }),

  company: defineObject(companies, {
    key: "company",
    label: "Company",
    pluralLabel: "Companies",
    readPermission: "companies:read",
    ownerColumn: "owner_id",
    softDelete: true,
    hide: ["notes", "address_line1", "address_line2"],
    defaultSorts: [{ field: "name", direction: "asc" }],
    defaultColumns: ["name", "domain", "industry", "city", "owner_id"],
    defaultGroupBy: "industry",
    defaultDateField: "created_at",
  }),

  deal: defineObject(deals, {
    key: "deal",
    label: "Deal",
    pluralLabel: "Deals",
    readPermission: "deals:read",
    ownerColumn: "owner_id",
    softDelete: true,
    hide: ["description"],
    defaultSorts: [{ field: "expected_close_date", direction: "asc" }],
    defaultColumns: ["title", "stage", "amount", "probability", "owner_id", "expected_close_date"],
    defaultGroupBy: "stage",
    defaultDateField: "expected_close_date",
  }),
});

export type ViewObjectKey = keyof typeof VIEW_OBJECTS;

export const VIEW_OBJECT_KEYS = Object.keys(VIEW_OBJECTS);

/**
 * The object key reserved for Phase 24 runtime objects.
 *
 * ⚠️ A runtime object CANNOT have a key in `VIEW_OBJECTS`. Its table is
 * created at run time, it differs per workspace, and two workspaces both
 * defining "Property" would collide. So a saved view over one stores this
 * constant in `object_key` and the object's uuid in `dynamic_object_id`,
 * and `server/views/objects.ts` builds the definition per request from
 * `dynamic_fields` — under the caller's own tenant scope, so one tenant
 * can never resolve another's object.
 */
export const DYNAMIC_OBJECT_KEY = "dynamic_object";

export function isBuiltInObjectKey(value: unknown): value is ViewObjectKey {
  return typeof value === "string" && Object.hasOwn(VIEW_OBJECTS, value);
}

/**
 * ⚠️ `Object.hasOwn`, never `in` — the same rule Phase 23 states in
 * `lib/workflows/records.ts`. `"constructor" in VIEW_OBJECTS` is true on
 * any object literal, and an object key of "constructor" resolving to a
 * function is the start of a much worse afternoon.
 */
export function viewObject(key: unknown): ViewObjectDefinition | null {
  return isBuiltInObjectKey(key) ? (VIEW_OBJECTS[key] ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* ⭐ RESOLUTION — THE FUNCTION EVERY IDENTIFIER GOES THROUGH           */
/* ------------------------------------------------------------------ */

/**
 * Turn a STORED field name into a descriptor, or into nothing.
 *
 * ⚠️ THIS IS THE CHOKE POINT. Every filter field, every sort key, every
 * group-by and every visible column passes through here before the
 * planner sees it, and the planner takes descriptors rather than strings
 * precisely so that a caller CANNOT skip it — there is no overload that
 * accepts a name.
 *
 * ⚠️ IT RETURNS `null` FOR "NOT A FIELD" AND FOR "NOT A FIELD OF THIS
 * OBJECT", AND THE CALLER MUST TREAT THEM THE SAME. Distinguishing them
 * in an error message tells a probing caller which columns exist on a
 * table they cannot read.
 */
export function resolveField(
  object: ViewObjectDefinition,
  name: unknown,
): ViewFieldDescriptor | null {
  if (typeof name !== "string") return null;
  if (!Object.hasOwn(object.fields, name)) return null;
  return object.fields[name] ?? null;
}

export function filterableFields(object: ViewObjectDefinition): ViewFieldDescriptor[] {
  return Object.values(object.fields).filter((f) => f.filterable);
}

export function sortableFields(object: ViewObjectDefinition): ViewFieldDescriptor[] {
  return Object.values(object.fields).filter((f) => f.sortable);
}

export function groupableFields(object: ViewObjectDefinition): ViewFieldDescriptor[] {
  return Object.values(object.fields).filter((f) => f.groupable);
}

export function dateFields(object: ViewObjectDefinition): ViewFieldDescriptor[] {
  return Object.values(object.fields).filter((f) => f.kind === "date");
}

/* ------------------------------------------------------------------ */
/* ⭐ PHASE 24 RUNTIME OBJECTS                                          */
/* ------------------------------------------------------------------ */

/**
 * The shape `server/views/objects.ts` reads out of `dynamic_objects` and
 * `dynamic_fields` and hands to the builder below.
 *
 * ⚠️ PLAIN DATA, NOT THE DRIZZLE ROW TYPE, SO THIS FILE STAYS PURE. It is
 * also why the server layer — not this one — is responsible for having
 * passed `physicalTableName` and `physicalColumnName` through
 * `assertPhysicalTableName` / `assertPhysicalColumnName` first. See the
 * ⚠️ on `buildDynamicViewObject`.
 */
export type DynamicObjectShape = {
  apiName: string;
  label: string;
  pluralLabel: string;
  /** ⭐ Already validated by the caller. See the warning below. */
  physicalTableName: string;
  displayFieldApiName: string | null;
  fields: readonly {
    apiName: string;
    label: string;
    fieldType: string;
    /** ⭐ Already validated by the caller. */
    physicalColumnName: string;
    options: readonly { value: string }[];
  }[];
};

/**
 * Phase 24 field type → this phase's semantic kind.
 *
 * ⚠️ `multi_select` MAPS TO `json`, WHICH MAKES IT UNFILTERABLE, AND THAT
 * IS CORRECT RATHER THAN LAZY. It is a `text[]` column, so `= 'x'` is a
 * type error and `@> ARRAY['x']` is a different operator with different
 * NULL semantics. Offering `eq` on it would produce a filter that always
 * errors; offering `contains` would produce one that quietly matches
 * substrings across element boundaries. It gets a real operator when the
 * catalogue gets `has_any` / `has_all`, not before.
 */
const DYNAMIC_KIND_MAP: Readonly<Record<string, FieldKind>> = Object.freeze({
  text: "text",
  long_text: "text",
  email: "text",
  phone: "text",
  url: "text",
  number: "number",
  currency: "money",
  boolean: "boolean",
  date: "date",
  datetime: "date",
  select: "enum",
  multi_select: "json",
  relation: "uuid",
});

/**
 * Build a view object for a tenant-defined record type.
 *
 * ⚠️ THE IDENTIFIERS HERE CAME OUT OF A DATABASE ROW, NOT OUT OF THE
 * DRIZZLE SCHEMA, AND THAT IS THE ONE PLACE THIS PHASE'S GUARANTEE IS
 * WEAKER THAN IT LOOKS.
 *
 * For the seven built-in objects, `descriptor.column` is a constant of the
 * compiled program. For a runtime object it is a varchar somebody wrote
 * months ago, into a table a restore or a support fix could have touched.
 * "It came from our own database" is the assumption behind a large share
 * of second-order SQL injection.
 *
 * So the CALLER must have passed every name through
 * `assertPhysicalTableName` / `assertPhysicalColumnName` from
 * `lib/dynamic/identifiers.ts` before calling this — `server/views/objects.ts`
 * does, on every request, and the planner quotes them again on the way
 * out. This function cannot do it itself without importing that module's
 * throwing API into a builder that also runs in the browser.
 */
export function buildDynamicViewObject(shape: DynamicObjectShape): ViewObjectDefinition {
  const fields: Record<string, ViewFieldDescriptor> = {};

  // The system columns every runtime table has. `tenant_id` is absent for
  // the reason given on `ALWAYS_HIDDEN`; `deleted_at` because the planner
  // already excludes soft-deleted rows.
  for (const [name, kind] of [
    ["id", "uuid"],
    ["created_at", "date"],
    ["updated_at", "date"],
    ["created_by", "uuid"],
    ["updated_by", "uuid"],
  ] as const) {
    fields[name] = Object.freeze({
      name,
      label: humaniseFieldName(name),
      kind,
      column: name,
      enumValues: null,
      filterable: true,
      sortable: true,
      groupable: kind === "uuid",
    });
  }

  for (const field of shape.fields) {
    const kind = DYNAMIC_KIND_MAP[field.fieldType] ?? "text";
    // A customer field may not shadow a system column — that would let a
    // saved view's `created_at` mean two different columns depending on
    // which object it was saved against.
    if (Object.hasOwn(fields, field.apiName)) continue;

    fields[field.apiName] = Object.freeze({
      name: field.apiName,
      label: field.label,
      kind,
      column: field.physicalColumnName,
      enumValues:
        kind === "enum" ? Object.freeze(field.options.map((option) => option.value)) : null,
      filterable: kind !== "json",
      sortable: kind !== "json",
      groupable: kind === "enum" || kind === "boolean" || kind === "uuid",
    });
  }

  const display = shape.displayFieldApiName;
  const defaultColumns = [
    ...(display && Object.hasOwn(fields, display) ? [display] : []),
    ...shape.fields
      .filter((f) => f.apiName !== display && DYNAMIC_KIND_MAP[f.fieldType] !== "json")
      .slice(0, 6)
      .map((f) => f.apiName),
  ];

  return Object.freeze({
    key: DYNAMIC_OBJECT_KEY,
    table: shape.physicalTableName,
    label: shape.label,
    pluralLabel: shape.pluralLabel,
    // ⚠️ ONE PERMISSION FOR EVERY RUNTIME OBJECT, matching Phase 24's own
    // CRUD layer. Per-object permissions would need a per-object entry in
    // the permission catalogue, which is a frozen constant — so a tenant
    // defining an object would be defining a permission, and
    // `evaluatePermission` fails closed on keys it has never heard of.
    readPermission: "custom_objects:read",
    // A runtime object has no ownership convention. `created_by` is who
    // typed it in, which is not the same as who it belongs to, and using
    // it as a boundary would hide a record from the person it was
    // reassigned to.
    ownerColumn: null,
    softDelete: true,
    defaultSorts: Object.freeze([{ field: "created_at", direction: "desc" } as SortSpec]),
    defaultColumns: Object.freeze(defaultColumns.length > 0 ? defaultColumns : ["id"]),
    defaultGroupBy:
      Object.values(fields).find((f) => f.kind === "enum")?.name ?? null,
    defaultDateField: "created_at",
    fields: Object.freeze(fields),
  });
}
