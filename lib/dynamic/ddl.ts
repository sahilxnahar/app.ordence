/**
 * Ordence — DDL Planning
 * Version: v0.24.0-alpha
 *
 * Pure and isomorphic. No `@/db` import, no I/O, no SQL string in sight.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS FILE PLANS DDL AND DOES NOT BUILD IT
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design is a function here that returns
 * `CREATE TABLE "cx_property_1a2b" (…)` as a string, which
 * `server/dynamic/` then executes. It is easy to read, easy to test, and
 * it puts the two dangerous things in the wrong places:
 *
 *   • THE INTERPOLATION HAPPENS IN JAVASCRIPT, where the only quoting
 *     available is one we wrote ourselves. `quote_ident` and `format('%I')`
 *     live in the database and know PostgreSQL's rules — including the
 *     ones about doubling embedded quotes, about `NAMEDATALEN`, and about
 *     which words need quoting in which version. A hand-rolled equivalent
 *     is a hand-rolled equivalent.
 *
 *   • THE ROW-LEVEL SECURITY BECOMES OPTIONAL. If the caller assembles
 *     the DDL, the caller is responsible for remembering to append
 *     `ENABLE ROW LEVEL SECURITY`, `FORCE`, and a policy with both a
 *     USING and a WITH CHECK clause. One future call site that forgets is
 *     one table that any tenant can read. ⭐ That is the failure this
 *     entire phase is organised to make unrepresentable.
 *
 * So the SQL text is built inside `dynamic_create_object_table()` and
 * `dynamic_add_field_column()` in `SQL-FILES/0019_phase24_dynamic_objects.sql`,
 * which take identifiers as ORDINARY PARAMETERS, re-validate them, quote
 * them with `%I`, and attach RLS in the same statement block. There is no
 * way to call them that produces an unprotected table, because they do
 * not accept "without RLS" as an input.
 *
 * What this file produces is a PLAN: a fully validated, fully typed
 * description of what those functions will be asked to do. It is pure, so
 * every naming rule, every cap and every "that combination makes no
 * sense" is decided without a database — and therefore tested without
 * one.
 */

import {
  assertIdentifier,
  physicalTableName,
  assertPhysicalTableName,
  IdentifierError,
} from "./identifiers";
import {
  fieldTypeSpec,
  isDynamicFieldType,
  isRelationCoreTable,
  isValidSelectValue,
  pgTypeFor,
  type DynamicFieldType,
  type RelationTarget,
  type SelectChoice,
} from "./field-types";
import {
  MAX_FIELDS_PER_OBJECT,
  MAX_INDEXED_FIELDS_PER_OBJECT,
  MAX_SELECT_OPTIONS,
} from "./limits";

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

/** A plan that cannot be built. Every message names the remedy. */
export class DdlPlanError extends Error {
  constructor(
    readonly field: string | null,
    message: string,
  ) {
    super(message);
    this.name = "DdlPlanError";
  }
}

/* ------------------------------------------------------------------ */
/* OBJECT PLAN                                                         */
/* ------------------------------------------------------------------ */

export type ObjectPlan = {
  /** The immutable machine name. Appears in URLs and the API. */
  apiName: string;
  /** ⭐ The physical table. Derived once and never recomputed. */
  tableName: string;
};

/**
 * Decide what an object's physical table is called.
 *
 * ⚠️ CALLED EXACTLY ONCE PER OBJECT, AT CREATION. `renameObject` does not
 * call it. The label is what changes; the table is an address.
 */
export function planObject(input: { apiName: unknown; objectId: string }): ObjectPlan {
  const apiName = assertIdentifier(input.apiName, "object");
  return { apiName, tableName: physicalTableName(apiName, input.objectId) };
}

/* ------------------------------------------------------------------ */
/* FIELD PLAN                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY STRING IN HERE IS ABOUT TO BE INTERPOLATED INTO DDL.
 *
 * `columnName` and `relationTable` have both passed `assertIdentifier`
 * or `assertPhysicalTableName`. `pgType` is looked up from the frozen
 * catalogue and never supplied by a caller. `optionValues` are LITERALS,
 * not identifiers, and are quoted with `%L` on the far side — see the
 * note on `SELECT_VALUE_PATTERN`.
 */
export type FieldPlan = {
  apiName: string;
  columnName: string;
  fieldType: DynamicFieldType;
  pgType: string;
  isRequired: boolean;
  isUnique: boolean;
  isIndexed: boolean;
  /** Empty for every type but `select` and `multi_select`. */
  optionValues: string[];
  /** The table a relation points at — physical `cx_…` or a core table. */
  relationTable: string | null;
  /** ⭐ See the note below. Null when this is not a relation. */
  onDelete: "set_null" | "restrict" | null;
};

export type PlanFieldInput = {
  apiName: unknown;
  fieldType: unknown;
  isRequired?: boolean;
  isUnique?: boolean;
  isIndexed?: boolean;
  options?: SelectChoice[];
  relation?: RelationTarget | null;
};

/**
 * Resolve a relation target to the physical table it points at.
 *
 * Supplied by the caller because only `server/dynamic/` can look an
 * object id up — this file has no database. The lookup is the caller's
 * job; deciding whether the ANSWER is acceptable is this file's.
 */
export type RelationResolver = (objectId: string) => string | null;

export function planField(
  input: PlanFieldInput,
  resolveObjectTable: RelationResolver,
): FieldPlan {
  const apiName = assertIdentifier(input.apiName, "field");

  if (!isDynamicFieldType(input.fieldType)) {
    throw new DdlPlanError(
      apiName,
      `"${String(input.fieldType)}" is not a field type this engine knows. ` +
        `Refusing rather than falling back to text: a fallback would create a ` +
        `column that accepts anything, including the money somebody meant to ` +
        `store as a whole number of paise.`,
    );
  }

  const spec = fieldTypeSpec(input.fieldType);
  const isRequired = input.isRequired === true;
  const isUnique = input.isUnique === true;
  const isIndexed = input.isIndexed === true;

  /* --- Options ---------------------------------------------------- */

  const options = input.options ?? [];
  if (spec.requiresOptions && options.length === 0) {
    throw new DdlPlanError(
      apiName,
      `A "${spec.label}" field needs at least one choice. Without one the ` +
        `CHECK constraint would allow nothing at all and every write to the ` +
        `field would fail.`,
    );
  }
  if (!spec.requiresOptions && options.length > 0) {
    throw new DdlPlanError(
      apiName,
      `A "${spec.label}" field does not take a list of choices. Storing them ` +
        `anyway would put a rule in the metadata that nothing enforces — the ` +
        `worst kind, because the UI would show it.`,
    );
  }
  if (options.length > MAX_SELECT_OPTIONS) {
    throw new DdlPlanError(
      apiName,
      `A choice field may have at most ${MAX_SELECT_OPTIONS} options. Beyond ` +
        `that it is a list of records, not a list of choices — use a "Link to ` +
        `a record" field pointing at an object.`,
    );
  }

  const seenValues = new Set<string>();
  const optionValues: string[] = [];
  for (const option of options) {
    if (!isValidSelectValue(option?.value)) {
      throw new DdlPlanError(
        apiName,
        `"${String(option?.value)}" is not a usable choice value. Use letters, ` +
          `digits, spaces, dots, hyphens and underscores — up to 59 ` +
          `characters. The value is written into a CHECK constraint on the ` +
          `column, so it has to stay simple enough to read in an error message.`,
      );
    }
    if (seenValues.has(option.value)) {
      throw new DdlPlanError(
        apiName,
        `The choice "${option.value}" is listed twice. Duplicates make the ` +
          `constraint ambiguous and the picker show the same option repeatedly.`,
      );
    }
    seenValues.add(option.value);
    optionValues.push(option.value);
  }

  /* --- Relation --------------------------------------------------- */

  let relationTable: string | null = null;
  let onDelete: FieldPlan["onDelete"] = null;

  if (spec.requiresTarget) {
    const relation = input.relation ?? null;
    if (!relation) {
      throw new DdlPlanError(
        apiName,
        `A "Link to a record" field must say what it links to.`,
      );
    }

    if (relation.kind === "core") {
      if (!isRelationCoreTable(relation.table)) {
        throw new DdlPlanError(
          apiName,
          `A field cannot link to "${String(relation.table)}". Only a short ` +
            `list of built-in record types may be linked to, and it is an ` +
            `ALLOWLIST rather than "anything with a tenant": a foreign key ` +
            `into the audit log or the billing tables would let one workspace ` +
            `pin our own records in place.`,
        );
      }
      relationTable = relation.table;
    } else {
      const resolved = resolveObjectTable(relation.objectId);
      if (!resolved) {
        throw new DdlPlanError(
          apiName,
          `The record type this field links to does not exist in this ` +
            `workspace. ⚠️ That message is deliberately the same whether it ` +
            `belongs to somebody else or to nobody — the alternative tells a ` +
            `caller which ids exist elsewhere.`,
        );
      }
      // ⚠️ Re-validated even though it came from our own metadata. See
      // `assertPhysicalTableName` for why a value out of the database is
      // still untrusted on its way into an interpolated string.
      relationTable = assertPhysicalTableName(resolved);
    }

    /**
     * ⭐ WHAT HAPPENS TO THIS RECORD WHEN THE THING IT POINTS AT IS
     * DELETED — AND WHY THE ANSWER DEPENDS ON `isRequired`.
     *
     * An OPTIONAL link becomes NULL. The record survives with a blank
     * field, which is what "optional" means.
     *
     * A REQUIRED link cannot become NULL — the NOT NULL would refuse the
     * cascade, and the delete would fail with a constraint error naming a
     * table the person deleting has never heard of. So a required link is
     * RESTRICT: the delete is refused up front, with a message about the
     * records that depend on it.
     *
     * ⚠️ CASCADE IS NOT OFFERED, AND WILL NOT BE. "Delete this contact"
     * silently deleting eighty site visits is a data-loss feature with a
     * confirmation dialog in front of it that nobody reads. If a customer
     * wants that, they can ask for it per-record.
     */
    onDelete = isRequired ? "restrict" : "set_null";
  } else if (input.relation) {
    throw new DdlPlanError(
      apiName,
      `A "${spec.label}" field cannot link to another record. Change the type ` +
        `to "Link to a record" first.`,
    );
  }

  /* --- Unique / indexed ------------------------------------------- */

  if (isUnique && !spec.supportsUnique) {
    throw new DdlPlanError(
      apiName,
      `A "${spec.label}" field cannot be unique. ${uniqueRefusalReason(input.fieldType)}`,
    );
  }
  if (isIndexed && !spec.supportsIndex) {
    throw new DdlPlanError(
      apiName,
      `A "${spec.label}" field cannot be indexed. ${indexRefusalReason(input.fieldType)}`,
    );
  }

  return {
    apiName,
    // ⚠️ THE COLUMN NAME IS THE API NAME, NOT A PREFIXED VERSION.
    //
    // A `f_` prefix would make shadowing a system column structurally
    // impossible and was seriously considered. It was rejected because
    // this data is read directly by customers' BI tools and by our own
    // support engineers at a psql prompt, and `f_unit_number` in every
    // query, forever, is a tax paid by humans to avoid one check that a
    // machine performs perfectly. `assertIdentifier` refuses the shadow
    // instead — see `SYSTEM_COLUMNS`.
    columnName: apiName,
    fieldType: input.fieldType,
    pgType: pgTypeFor(input.fieldType),
    isRequired,
    isUnique,
    isIndexed,
    optionValues,
    relationTable,
    onDelete,
  };
}

function uniqueRefusalReason(type: DynamicFieldType): string {
  switch (type) {
    case "long_text":
      return "A unique index on unbounded text hits btree's ~2700-byte entry limit, and the failure appears months later on one long value.";
    case "currency":
      return "Two records legitimately cost the same amount.";
    case "boolean":
      return "There are two possible values; a unique constraint would allow two rows in the whole table.";
    case "multi_select":
      return "Uniqueness over an array compares whole arrays, which is never the question anybody meant to ask.";
    default:
      return "Uniqueness is not meaningful for this type.";
  }
}

function indexRefusalReason(type: DynamicFieldType): string {
  switch (type) {
    case "long_text":
      return "btree index entries are capped at roughly a third of a page; a long note would be refused at INSERT time, not at CREATE INDEX time.";
    case "boolean":
      return "A two-valued index answers nothing a scan does not answer faster, and it is written on every update.";
    case "multi_select":
      return "An array wants a GIN index, which is a different feature.";
    case "url":
      return "Links are read, not searched.";
    default:
      return "Indexing is not meaningful for this type.";
  }
}

/* ------------------------------------------------------------------ */
/* WHOLE-OBJECT PLANNING                                               */
/* ------------------------------------------------------------------ */

/**
 * Plan a whole field list, applying the rules that only make sense
 * across fields: duplicates, the field cap and the index cap.
 *
 * ⚠️ `existing` IS THE FIELDS THAT ARE ALREADY THERE. Adding one field to
 * an object that already has a hundred must be refused, and a function
 * that only ever saw the new field could not know that. The database
 * counts again inside `dynamic_add_field_column()`, because a concurrent
 * pair of requests could each see ninety-nine.
 */
export function planFields(
  inputs: PlanFieldInput[],
  resolveObjectTable: RelationResolver,
  existing: { apiName: string; isIndexed: boolean }[] = [],
): FieldPlan[] {
  const total = existing.length + inputs.length;
  if (total > MAX_FIELDS_PER_OBJECT) {
    throw new DdlPlanError(
      null,
      `A record type may have at most ${MAX_FIELDS_PER_OBJECT} fields, and ` +
        `this would make ${total}. PostgreSQL allows far more; a table near ` +
        `its limit is unusable in every grid the product renders and takes an ` +
        `ACCESS EXCLUSIVE lock for measurably longer on every change.`,
    );
  }

  const seen = new Set(existing.map((f) => f.apiName));
  const plans: FieldPlan[] = [];

  for (const input of inputs) {
    const plan = planField(input, resolveObjectTable);
    if (seen.has(plan.apiName)) {
      throw new DdlPlanError(
        plan.apiName,
        `This record type already has a field called "${plan.apiName}". ` +
          `Two columns of one name cannot be told apart.`,
      );
    }
    seen.add(plan.apiName);
    plans.push(plan);
  }

  const indexed =
    existing.filter((f) => f.isIndexed).length + plans.filter((p) => p.isIndexed).length;
  if (indexed > MAX_INDEXED_FIELDS_PER_OBJECT) {
    throw new DdlPlanError(
      null,
      `At most ${MAX_INDEXED_FIELDS_PER_OBJECT} fields on a record type may be ` +
        `indexed, and this would make ${indexed}. Every index is written on ` +
        `every insert and every update — an object with an index on all its ` +
        `fields is slower to write than to scan, and it gets reported as our bug.`,
    );
  }

  return plans;
}

/* ------------------------------------------------------------------ */
/* HUMAN-READABLE PLAN                                                 */
/* ------------------------------------------------------------------ */

/**
 * What the plan will do, in sentences, for the confirmation dialog and
 * for the audit entry.
 *
 * ⚠️ A SCHEMA CHANGE IS THE ONE KIND OF CHANGE THAT CANNOT BE UNDONE BY
 * EDITING A ROW. The audit trail records what somebody intended, in the
 * words they were shown before they agreed to it — not a diff of two
 * metadata rows that a reader has to reconstruct the meaning of.
 */
export function describePlan(object: ObjectPlan, fields: FieldPlan[]): string[] {
  const lines = [
    `Create the record type "${object.apiName}" in its own table, ${object.tableName}, ` +
      `protected by row-level security from the moment it exists.`,
  ];

  for (const field of fields) {
    const bits = [`${field.apiName} (${field.fieldType})`];
    if (field.isRequired) bits.push("required");
    if (field.isUnique) bits.push("unique");
    if (field.isIndexed) bits.push("indexed");
    if (field.relationTable) {
      bits.push(`links to ${field.relationTable}, ${field.onDelete === "restrict" ? "which then cannot be deleted while it is referenced" : "cleared if that record is deleted"}`);
    }
    if (field.optionValues.length) {
      bits.push(`one of ${field.optionValues.length} choices`);
    }
    lines.push(`Add ${bits.join(", ")}.`);
  }

  return lines;
}

/** Re-exported so callers catch one error family from this module. */
export { IdentifierError };
