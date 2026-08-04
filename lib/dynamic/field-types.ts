/**
 * Ordence — Runtime Field Type System
 * Version: v0.24.0-alpha
 *
 * Pure and isomorphic. No `@/db` import, no I/O.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEPENDENCY POINTS FROM HERE INTO THE SCHEMA, AS IN PHASE 23
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/dynamic-objects.ts` builds its `dynamic_field_type` pgEnum
 * FROM the array below, and `SQL-FILES/0019` restates it once. Three
 * places would be two too many: a type the database accepts and the DDL
 * planner has never heard of is a field that can be created and can never
 * be written to.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS PHASE EXISTS — THE ARGUMENT AGAINST THE JSONB VERSION
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/custom-objects.ts` (Phase 2) stores every custom record as a
 * JSONB blob in one shared table. It was the right call at the time and
 * it does not survive scale, for reasons that are all the same reason:
 *
 *   • A JSONB key cannot carry a type. `data->>'price'` is text. Sorting
 *     a price column sorts "1000" before "9", and every customer who
 *     notices reports it as a bug in the grid.
 *   • A GIN index answers "which rows contain this key/value" and cannot
 *     answer "the ten most expensive", "the sum of this column", or "the
 *     ones due next week" without reading every row of every object.
 *   • There is no NOT NULL, no UNIQUE, no FOREIGN KEY. Every constraint
 *     is application code, so every path that forgets to call the
 *     validator is a path that writes data the validator would refuse.
 *
 * Real columns give all three back — at the cost of runtime DDL, which is
 * the risk this whole phase is organised around.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE: `formula`, `rollup`, `file`. A
 * formula field is an expression language evaluated against customer
 * data, which is the `run_code` argument from Phase 23 in a smaller
 * costume. A rollup is a cross-table aggregate that has to be maintained
 * on write, which means triggers writing to other tenants' tables unless
 * it is designed very carefully. Both are real features; neither is
 * something to bolt on beside a `CREATE TABLE` executor.
 */

/* ------------------------------------------------------------------ */
/* THE VOCABULARY                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE ORDER OF THIS ARRAY IS THE ORDER OF THE POSTGRES ENUM.
 *
 * Appending is free. Inserting in the middle is an enum rewrite, and on
 * an instance with thousands of runtime tables that is a long lock on the
 * metadata every one of them is described by. Add to the end.
 */
export const DYNAMIC_FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "currency",
  "boolean",
  "date",
  "datetime",
  "select",
  "multi_select",
  "email",
  "phone",
  "url",
  "relation",
] as const;

export type DynamicFieldType = (typeof DYNAMIC_FIELD_TYPES)[number];

export function isDynamicFieldType(value: unknown): value is DynamicFieldType {
  return (
    typeof value === "string" &&
    (DYNAMIC_FIELD_TYPES as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* THE CATALOGUE                                                       */
/* ------------------------------------------------------------------ */

export type FieldTypeSpec = {
  label: string;
  /**
   * ⭐ THE PHYSICAL COLUMN TYPE.
   *
   * ⚠️ THIS STRING IS INTERPOLATED INTO DDL. It never comes from user
   * input — it is looked up from this frozen table by an enum value the
   * database itself has already constrained — and `SQL-FILES/0019`
   * repeats the mapping in `dynamic_pg_type()` so that a caller reaching
   * the SQL function directly gets the same answer. Two copies, checked
   * against each other by the verification section, is the price of not
   * accepting a type name over the wire.
   */
  pgType: string;
  /** `select` and `multi_select` are meaningless without a choice list. */
  requiresOptions: boolean;
  /** `relation` is meaningless without something to point at. */
  requiresTarget: boolean;
  /** May a tenant ask for a UNIQUE constraint on this? */
  supportsUnique: boolean;
  /** May a tenant ask for a btree index on this? */
  supportsIndex: boolean;
  /** One line shown next to the type in the field builder. */
  hint: string;
};

export const FIELD_TYPE_CATALOG: Readonly<Record<DynamicFieldType, FieldTypeSpec>> =
  Object.freeze({
    text: {
      label: "Text",
      pgType: "text",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: true,
      supportsIndex: true,
      hint: "A single line. Bounded at 500 characters by the validator.",
    },
    long_text: {
      label: "Long text",
      pgType: "text",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: false,
      // ⚠️ NO INDEX. A btree index entry may not exceed roughly a third of
      // a page (~2700 bytes). Postgres accepts the CREATE INDEX and then
      // refuses the INSERT that first exceeds it — a failure that appears
      // months later, on one long note, in the middle of a customer's
      // working day. Refusing the index up front is the honest trade.
      supportsIndex: false,
      hint: "Notes and descriptions. Not indexable — long values break btree.",
    },
    number: {
      label: "Number",
      // `numeric` rather than `double precision`, deliberately. A CRM
      // multiplies areas by rates and sums the results; binary floating
      // point makes 0.1 + 0.2 visible to a customer in a total.
      pgType: "numeric(38,10)",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: true,
      supportsIndex: true,
      hint: "Quantities and measurements. Exact decimal, not floating point.",
    },
    currency: {
      /**
       * ⭐ MONEY IS `bigint` MINOR UNITS. PAISE. NEVER A FLOAT, NEVER A
       * DECIMAL STRING IN A TEXT COLUMN.
       *
       * The house rule since Phase 4, and the reason is that ₹0.10 has no
       * exact binary representation: a plan of ten ₹0.10 instalments sums
       * to ₹0.9999999999999999 and the last demand is raised for one
       * paisa. `bigint` cannot do that, and it raises on overflow instead
       * of wrapping.
       *
       * ⚠️ THE CURRENCY CODE IS NOT STORED PER ROW. It belongs to the
       * workspace. A per-row code invites summing two currencies into one
       * number, which is worse than being unable to hold two.
       */
      label: "Money",
      pgType: "bigint",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: false,
      supportsIndex: true,
      hint: "Stored in paise. ₹1,250.50 is 125050.",
    },
    boolean: {
      label: "Yes / No",
      pgType: "boolean",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: false,
      // A two-valued btree index answers nothing a sequential scan does
      // not answer faster, and it is written on every update.
      supportsIndex: false,
      hint: "A checkbox.",
    },
    date: {
      label: "Date",
      // `date`, not `timestamptz`. A handover date is a calendar day, and
      // storing it as an instant makes it move across a timezone boundary
      // — the classic "the birthday shows as the day before" defect.
      pgType: "date",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: false,
      supportsIndex: true,
      hint: "A calendar day, with no time and no timezone.",
    },
    datetime: {
      label: "Date and time",
      pgType: "timestamptz",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: false,
      supportsIndex: true,
      hint: "An instant. Always stored with a timezone.",
    },
    select: {
      /**
       * `text` plus a CHECK, NOT a Postgres `ENUM` type.
       *
       * ⚠️ AND THE REASON IS OPERATIONAL, NOT AESTHETIC. Removing a value
       * from a PG enum is impossible — there is no `ALTER TYPE … DROP
       * VALUE`. A tenant who adds a status by mistake could never remove
       * it, and the only remedy is recreating the type and rewriting every
       * column that uses it. A CHECK constraint is dropped and recreated
       * in one statement.
       */
      label: "Choice",
      pgType: "text",
      requiresOptions: true,
      requiresTarget: false,
      supportsUnique: false,
      supportsIndex: true,
      hint: "One value from a list you define.",
    },
    multi_select: {
      label: "Multiple choice",
      pgType: "text[]",
      requiresOptions: true,
      requiresTarget: false,
      supportsUnique: false,
      // A btree index on an array indexes the whole array as one value,
      // which answers no question anybody asks. GIN would be right, and
      // is not offered until somebody needs it.
      supportsIndex: false,
      hint: "Any number of values from a list you define.",
    },
    email: {
      label: "Email",
      pgType: "text",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: true,
      supportsIndex: true,
      hint: "Validated on write. Stored lower-cased.",
    },
    phone: {
      label: "Phone",
      pgType: "text",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: true,
      supportsIndex: true,
      hint: "Digits, spaces and +() only. Not normalised — see the validator.",
    },
    url: {
      label: "Link",
      pgType: "text",
      requiresOptions: false,
      requiresTarget: false,
      supportsUnique: false,
      supportsIndex: false,
      hint: "http:// or https:// only.",
    },
    relation: {
      /**
       * ⭐ A REAL FOREIGN KEY — the single biggest thing the JSONB engine
       * could not do.
       *
       * ⚠️ AND IT IS A COMPOSITE ONE, `(column, tenant_id)` referencing
       * `(id, tenant_id)`. The reason is the hole Phase 22 §2d and Phase
       * 23 §3 both document at length: FOREIGN-KEY CHECKS RUN AS THE
       * SYSTEM AND IGNORE ROW-LEVEL SECURITY. A single-column FK to
       * `leads(id)` would happily accept another tenant's lead id, and the
       * row would then render that tenant's lead name in a picker.
       */
      label: "Link to a record",
      pgType: "uuid",
      requiresOptions: false,
      requiresTarget: true,
      supportsUnique: false,
      supportsIndex: true,
      hint: "Points at another record, in this workspace only.",
    },
  });

export function fieldTypeSpec(type: DynamicFieldType): FieldTypeSpec {
  const spec = FIELD_TYPE_CATALOG[type];
  // Fails CLOSED. An unknown type must never fall through to a default
  // column type — `text` would accept anything, including the money the
  // planner thought was a bigint.
  if (!spec) {
    throw new Error(
      `[dynamic] Unknown field type "${String(type)}". Refusing to guess a ` +
        `column type: a wrong guess is a column that silently accepts data ` +
        `the rest of the product cannot read back.`,
    );
  }
  return spec;
}

/** The physical column type for a field. See the ⚠️ on `pgType`. */
export function pgTypeFor(type: DynamicFieldType): string {
  return fieldTypeSpec(type).pgType;
}

/* ------------------------------------------------------------------ */
/* RELATION TARGETS                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE CORE TABLES A RELATION FIELD MAY POINT AT. AN ALLOWLIST.
 *
 * ⚠️ A DENYLIST HERE WOULD BE A CATASTROPHE AND IT IS WORTH SAYING WHY.
 *
 * The obvious implementation is "any table with a tenant_id column".
 * That set includes `audit_logs`, `permission_denials`, `security_events`
 * and `invoices`. A foreign key to `audit_logs` means a tenant's own
 * record can pin an audit row in place — `ON DELETE RESTRICT` would let a
 * customer prevent retention from ever removing evidence about them. A
 * key to `subscriptions` couples customer content to billing state, so
 * deleting a lapsed subscription starts failing.
 *
 * So the set is named, it is short, and everything in it is CUSTOMER
 * CONTENT that the customer already owns outright.
 *
 * ⚠️ EVERY TABLE HERE MUST HAVE A `UNIQUE (id, tenant_id)` INDEX, or the
 * composite foreign key cannot be created at all. `SQL-FILES/0019` §3
 * creates them and the verification section checks them.
 */
export const RELATION_CORE_TABLES: readonly string[] = Object.freeze([
  "contacts",
  "companies",
  "deals",
  "leads",
  "projects",
  "units",
  "bookings",
  "users",
]);

const RELATION_CORE_TABLE_SET = new Set(RELATION_CORE_TABLES);

export function isRelationCoreTable(value: unknown): value is string {
  return typeof value === "string" && RELATION_CORE_TABLE_SET.has(value);
}

/**
 * Where a relation points. Exactly one of the two, never both, never
 * neither — enforced by a CHECK constraint on `dynamic_fields` as well,
 * because a field with two targets has no defined foreign key and a field
 * with none has no column type.
 */
export type RelationTarget =
  | { kind: "object"; objectId: string }
  | { kind: "core"; table: string };

/* ------------------------------------------------------------------ */
/* SELECT OPTIONS                                                      */
/* ------------------------------------------------------------------ */

/**
 * A choice on a `select` / `multi_select`.
 *
 * ⚠️ `value` IS WHAT LANDS IN THE COLUMN AND IN THE CHECK CONSTRAINT.
 * `label` is what a person sees. They are separate so that renaming a
 * choice from "In progress" to "Under way" is a metadata edit rather than
 * an `UPDATE` over every row plus a constraint rebuild.
 */
export type SelectChoice = {
  value: string;
  label: string;
  color?: string;
};

/**
 * ⚠️ OPTION VALUES REACH SQL AS LITERALS, NOT IDENTIFIERS.
 *
 * They are built into a `CHECK (col = ANY (ARRAY[…]))` using `format('%L')`,
 * which is the correct quoting for a VALUE and is not the same function as
 * `%I`. Confusing the two is the classic version of this bug: `%I` on a
 * value produces `"active"` — a column reference — and the constraint
 * silently compares the column to itself, which is true for every row.
 *
 * So option values are still constrained to a conservative character set.
 * `%L` would handle a quote correctly; a value containing one would still
 * make every hand-written query about that data unpleasant, and nothing
 * about a status code needs an apostrophe.
 */
export const SELECT_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,58}$/;

export function isValidSelectValue(value: unknown): value is string {
  return typeof value === "string" && SELECT_VALUE_PATTERN.test(value);
}
