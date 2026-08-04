/**
 * Ordence — The View Query Planner
 * Version: v0.25.0-alpha
 *
 * Pure. No `@/db` import, no I/O, no clock. Everything this file needs
 * arrives as an argument, which is why the hardest part of the phase —
 * turning a customer-authored filter tree into SQL — is testable without
 * a database and therefore actually tested.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WHAT THIS FILE EMITS, AND WHY IT IS NOT A STRING
 * ══════════════════════════════════════════════════════════════════════
 * A function that returns `"WHERE status = 'new'"` has already lost. The
 * moment SQL and data live in the same string, every caller downstream is
 * one concatenation away from an injection, and no amount of care in this
 * file helps.
 *
 * So the planner emits a TOKEN LIST — alternating fragments of SQL text
 * and BOUND VALUES:
 *
 *     [ {sql: '('}, {sql: '"status"'}, {sql: ' = '}, {param: 'new'}, {sql: ')'} ]
 *
 * The two are structurally different types. A value cannot become SQL by
 * accident, because there is no code path that renders a `param` token as
 * text: `renderTokens()` turns it into `$1` and pushes it onto a separate
 * array, and `server/views/query.ts` turns it into a Drizzle placeholder.
 * The only way to get a value into the statement is to have written it as
 * a `sql` token, deliberately, in this file.
 *
 * ⚠️ AND EVERY `sql` TOKEN IN THIS FILE IS EITHER A LITERAL WRITTEN HERE
 * OR AN IDENTIFIER FROM `quoteColumn()`. There is no third source. Grep
 * for `kind: "sql"` and check it — that grep is the audit of this phase.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE THREE THINGS A COMPILED QUERY IS MADE OF
 * ══════════════════════════════════════════════════════════════════════
 *   1. SCOPE     — supplied by the CALLER'S context. Tenant, soft-delete,
 *                  and ownership narrowing. NEVER by the view.
 *   2. FILTER    — supplied by the VIEW. Arbitrary within the allowlist.
 *   3. ORDER     — supplied by the view, resolved against the allowlist.
 *
 * They are ANDed in that order and the scope is not optional: `compileWhere`
 * takes it as a required argument rather than reading it off the view, so
 * a call site cannot forget it. A shared view is then, by construction,
 * incapable of widening what its reader may see — it can only ever remove
 * rows from a set the caller was already entitled to. That is the whole
 * answer to "is a shared view a privilege escalation?", and it is
 * structural rather than a rule somebody remembers.
 */

import {
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_IN_VALUES,
  MAX_SORTS,
  MAX_VISIBLE_COLUMNS,
} from "./limits";
import { OPERATORS, coerceOperand, resolveDateWindow } from "./operators";
import {
  resolveField,
  type ViewFieldDescriptor,
  type ViewObjectDefinition,
} from "./registry";
import {
  isFilterGroup,
  type FilterCondition,
  type FilterGroup,
  type SortSpec,
} from "./types";

/* ------------------------------------------------------------------ */
/* TOKENS                                                              */
/* ------------------------------------------------------------------ */

export type QueryToken =
  | { kind: "sql"; text: string }
  | { kind: "param"; value: unknown };

/** Thrown for anything a saved view may legitimately contain but must not run. */
export class ViewPlanError extends Error {
  constructor(
    message: string,
    /** The field or node the message is about, for the builder UI. */
    readonly at?: string,
  ) {
    super(message);
    this.name = "ViewPlanError";
  }
}

const sqlToken = (text: string): QueryToken => ({ kind: "sql", text });
const param = (value: unknown): QueryToken => ({ kind: "param", value });

/**
 * ⭐ THE ONLY PLACE AN IDENTIFIER IS TURNED INTO TEXT.
 *
 * The argument is a DESCRIPTOR, not a string, so this function is
 * unreachable with a name that has not already been resolved against the
 * registry. That is the primary defence and it is a type-level one.
 *
 * ⚠️ The regex below is the SECOND defence, and it is not redundant. For
 * Phase 24 runtime objects the descriptor's `column` came out of a
 * database row rather than out of the compiled schema (see
 * `buildDynamicViewObject`), so it gets checked here as well — a defence
 * that exists once exists until somebody refactors it.
 *
 * ⚠️ The quotes are the THIRD. Doubling any embedded quote is what makes
 * the result a single identifier no matter what is inside it, and the
 * throw above it is what makes sure nothing ever is.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function quoteColumn(field: ViewFieldDescriptor, alias?: string): string {
  const column = field.column;
  if (!SAFE_IDENTIFIER.test(column) || column.length > 63) {
    throw new ViewPlanError(
      `The field "${field.name}" maps to a column name this system will not put ` +
        `in a statement. This is a defect, not a configuration problem — report it.`,
      field.name,
    );
  }
  const quoted = `"${column.replace(/"/g, '""')}"`;
  if (!alias) return quoted;
  if (!SAFE_IDENTIFIER.test(alias)) {
    throw new ViewPlanError("Invalid table alias.");
  }
  return `"${alias}".${quoted}`;
}

/* ------------------------------------------------------------------ */
/* SCOPE — THE HALF THE VIEW DOES NOT GET TO CHOOSE                    */
/* ------------------------------------------------------------------ */

/**
 * Everything about the CALLER that constrains which rows they may see.
 *
 * ⚠️ NONE OF THIS COMES FROM THE VIEW. It is built by
 * `server/views/guards.ts` from the tenant context and the caller's own
 * permissions, and it is ANDed on the outside of whatever the view says.
 */
export type ViewerScope = {
  /** Belt to RLS's braces. The policy would refuse anyway; this is cheap. */
  tenantId: string;
  /**
   * ⭐ Non-null → the caller may see only records they own.
   *
   * Set by `resolveViewerScope` when the caller lacks
   * `views:read_all_records`. The object must have an `ownerColumn` for
   * it to mean anything — and when it does not, an object with no
   * ownership concept is visible to anyone holding its read permission,
   * which is the pre-existing behaviour of the product.
   */
  restrictToOwnerUserId: string | null;
};

/* ------------------------------------------------------------------ */
/* THE FILTER TREE                                                     */
/* ------------------------------------------------------------------ */

export type CompiledWhere = {
  tokens: QueryToken[];
  /** Nodes walked. Exposed so the caller can log an expensive view. */
  nodeCount: number;
  maxDepth: number;
};

export type CompileOptions = {
  /**
   * The clock, INJECTED.
   *
   * ⚠️ `new Date()` inside this file would make every relative-date test
   * a race against midnight, and would make "what did this view return on
   * the 3rd?" unanswerable. It is an argument, always.
   */
  now: Date;
  /** Table alias, when the query joins. Omitted for the single-table case. */
  alias?: string;
};

/**
 * Compile scope + filter into one `WHERE` expression.
 *
 * ⚠️ `scope` IS A REQUIRED ARGUMENT AND IT IS THE FIRST ONE. A signature
 * where it were optional, or where it lived on the view, is a signature
 * where the fourth call site somebody adds is the one that omits it — and
 * that call site is a cross-tenant read with no error and no log.
 */
export function compileWhere(
  scope: ViewerScope,
  object: ViewObjectDefinition,
  filter: FilterGroup,
  options: CompileOptions,
): CompiledWhere {
  const scopeTokens: QueryToken[] = [];

  /* --- 1. Tenant ------------------------------------------------- */
  //
  // ⚠️ NOT A SUBSTITUTE FOR RLS AND NOT PRETENDING TO BE. The policy on
  // every one of these tables refuses another tenant's rows whatever this
  // clause says. It is here because a missing `WHERE tenant_id` in a
  // generic query builder is the exact defect that RLS was added to
  // survive, and surviving it silently is how nobody finds out.
  scopeTokens.push(sqlToken("("));
  scopeTokens.push(sqlToken(identifierFor("tenant_id", options.alias)));
  scopeTokens.push(sqlToken(" = "));
  scopeTokens.push(param(scope.tenantId));
  scopeTokens.push(sqlToken("::uuid)"));

  /* --- 2. Soft delete -------------------------------------------- */
  if (object.softDelete) {
    scopeTokens.push(sqlToken(" AND ("));
    scopeTokens.push(sqlToken(identifierFor("deleted_at", options.alias)));
    scopeTokens.push(sqlToken(" IS NULL)"));
  }

  /* --- 3. ⭐ OWNERSHIP -------------------------------------------- */
  //
  // The clause that makes a shared view safe. The view has no say in it:
  // whatever its filter says about `owner_id`, this is ANDed outside and
  // can only narrow the result further.
  //
  // ⚠️ A REFUSAL, NOT A SILENT PASS, WHEN THE OBJECT HAS NO OWNER COLUMN.
  // If the caller is restricted and the object cannot express ownership,
  // returning everything would be exactly the escalation this exists to
  // stop. `resolveViewerScope` therefore never sets the restriction for
  // an object with no owner column — and if it ever did, this throws
  // rather than guesses.
  if (scope.restrictToOwnerUserId !== null) {
    const ownerName = object.ownerColumn;
    if (!ownerName) {
      throw new ViewPlanError(
        `This record type has no owner, so it cannot be narrowed to one person. ` +
          `Ask an administrator for workspace-wide visibility.`,
      );
    }
    const ownerField = resolveField(object, ownerName);
    if (!ownerField) {
      throw new ViewPlanError(
        `The owner field for ${object.label} is missing from the registry. This is ` +
          `a defect — refusing rather than returning every record.`,
      );
    }
    scopeTokens.push(sqlToken(" AND ("));
    scopeTokens.push(sqlToken(quoteColumn(ownerField, options.alias)));
    scopeTokens.push(sqlToken(" = "));
    scopeTokens.push(param(scope.restrictToOwnerUserId));
    scopeTokens.push(sqlToken("::uuid)"));
  }

  /* --- 4. The view's own filter ---------------------------------- */
  const counter = { nodes: 0, depth: 0 };
  const filterTokens = compileGroup(object, filter, options, 1, counter);

  const tokens: QueryToken[] = [sqlToken("("), ...scopeTokens, sqlToken(")")];
  if (filterTokens.length > 0) {
    tokens.push(sqlToken(" AND "), ...filterTokens);
  }

  return { tokens, nodeCount: counter.nodes, maxDepth: counter.depth };
}

/**
 * The system columns the scope clause names.
 *
 * ⚠️ NOT ROUTED THROUGH `resolveField`, ON PURPOSE. `tenant_id` and
 * `deleted_at` are deliberately ABSENT from the registry (see
 * `ALWAYS_HIDDEN`) so that no view can name them — which means the scope
 * clause cannot resolve them either. They are literals of this file, from
 * this frozen pair, and nothing outside it chooses which.
 */
function identifierFor(system: "tenant_id" | "deleted_at", alias?: string): string {
  const quoted = `"${system}"`;
  if (!alias) return quoted;
  if (!SAFE_IDENTIFIER.test(alias)) throw new ViewPlanError("Invalid table alias.");
  return `"${alias}".${quoted}`;
}

function compileGroup(
  object: ViewObjectDefinition,
  group: FilterGroup,
  options: CompileOptions,
  depth: number,
  counter: { nodes: number; depth: number },
): QueryToken[] {
  counter.nodes += 1;
  counter.depth = Math.max(counter.depth, depth);

  /* ⚠️ THE DENIAL-OF-SERVICE GUARDS, CHECKED DURING THE WALK RATHER THAN
     BEFORE IT. Checking first means walking the tree twice — and the walk
     itself is what a 100,000-node tree is attacking. Counting as we go
     means the refusal happens at node 61, not after the recursion has
     already blown the stack. */
  if (counter.nodes > MAX_FILTER_NODES) {
    throw new ViewPlanError(
      `This filter has more than ${MAX_FILTER_NODES} conditions. Split it into two ` +
        `views — a filter this large is also a query nobody can read.`,
    );
  }
  if (depth > MAX_FILTER_DEPTH) {
    throw new ViewPlanError(
      `This filter nests more than ${MAX_FILTER_DEPTH} groups deep. Flatten it — ` +
        `nothing past that depth changes which records match in a way anybody can ` +
        `predict.`,
    );
  }

  if (group.match !== "all" && group.match !== "any") {
    // ⚠️ No default. "All" and "any" are opposite instructions, and
    // guessing one produces a view that returns rows its author wrote it
    // to exclude — with the author's evidence that it works being that it
    // returned something.
    throw new ViewPlanError(`A filter group must say "all" or "any".`);
  }

  const joiner = group.match === "all" ? " AND " : " OR ";
  const parts: QueryToken[][] = [];

  for (const child of group.children ?? []) {
    const compiled = isFilterGroup(child)
      ? compileGroup(object, child, options, depth + 1, counter)
      : compileCondition(object, child, options, counter);
    // An empty nested group contributes nothing rather than TRUE or
    // FALSE. `validateFilter` refuses to SAVE one; this handles the rows
    // saved before it did.
    if (compiled.length > 0) parts.push(compiled);
  }

  // ⚠️ AN EMPTY GROUP COMPILES TO NOTHING, NOT TO `FALSE`.
  //
  // Mathematically an empty OR is false. Operationally, "no conditions"
  // is what a brand-new view contains and what a user leaves behind when
  // they delete their last condition — and a view that shows zero records
  // because its filter is empty is a bug report every time. Nothing is
  // the honest reading: no filter, therefore no restriction.
  if (parts.length === 0) return [];
  if (parts.length === 1) return parts[0] as QueryToken[];

  const tokens: QueryToken[] = [sqlToken("(")];
  parts.forEach((part, index) => {
    if (index > 0) tokens.push(sqlToken(joiner));
    tokens.push(...part);
  });
  tokens.push(sqlToken(")"));
  return tokens;
}

function compileCondition(
  object: ViewObjectDefinition,
  condition: FilterCondition,
  options: CompileOptions,
  counter: { nodes: number; depth: number },
): QueryToken[] {
  counter.nodes += 1;
  if (counter.nodes > MAX_FILTER_NODES) {
    throw new ViewPlanError(
      `This filter has more than ${MAX_FILTER_NODES} conditions. Split it into two views.`,
    );
  }

  /* --- ⭐ RESOLUTION. THE LINE THE WHOLE PHASE IS ABOUT ----------- */
  //
  // `condition.field` is a string out of a jsonb column that a customer
  // wrote and that has been sitting in the database for months. It is
  // never used. It is LOOKED UP, and what comes back is either a
  // descriptor built from Drizzle's schema metadata or nothing at all.
  const field = resolveField(object, condition.field);
  if (!field) {
    // ⚠️ The message names the object but NOT which fields exist. A
    // caller enumerating field names against an object they cannot read
    // would otherwise get a schema dump one guess at a time.
    throw new ViewPlanError(
      `"${String(condition.field)}" is not a field of ${object.label}. It may have ` +
        `been removed since this view was saved — edit the view and pick another.`,
      String(condition.field),
    );
  }

  if (!field.filterable) {
    throw new ViewPlanError(`${field.label} cannot be filtered on.`, field.name);
  }

  const operator = condition.operator;
  const spec = Object.hasOwn(OPERATORS, operator) ? OPERATORS[operator] : undefined;
  if (!spec) {
    throw new ViewPlanError(
      `"${String(operator)}" is not a comparison this system knows.`,
      field.name,
    );
  }

  if (!spec.kinds.includes(field.kind)) {
    throw new ViewPlanError(
      `“${spec.label}” cannot be used on ${field.label}.`,
      field.name,
    );
  }

  const column = quoteColumn(field, options.alias);

  /* --- Presence -------------------------------------------------- */
  if (operator === "is_empty" || operator === "is_not_empty") {
    // ⚠️ For text and enum, EMPTY means null OR blank. A trimmed empty
    // string is what a form posts when somebody clears a box, and a
    // filter for "leads with no email" that misses them is a filter that
    // is quietly wrong on real data.
    const treatBlankAsEmpty = field.kind === "text" || field.kind === "enum";
    if (operator === "is_empty") {
      return treatBlankAsEmpty
        ? [sqlToken(`(${column} IS NULL OR btrim(${column}::text) = '')`)]
        : [sqlToken(`(${column} IS NULL)`)];
    }
    return treatBlankAsEmpty
      ? [sqlToken(`(${column} IS NOT NULL AND btrim(${column}::text) <> '')`)]
      : [sqlToken(`(${column} IS NOT NULL)`)];
  }

  /* --- Booleans -------------------------------------------------- */
  if (operator === "is_true" || operator === "is_false") {
    // `IS TRUE` / `IS FALSE` rather than `= true` — both exclude NULL,
    // which `<> true` does not, and the difference is the whole reason
    // these are separate operators.
    return [sqlToken(`(${column} IS ${operator === "is_true" ? "TRUE" : "FALSE"})`)];
  }

  /* --- Relative dates -------------------------------------------- */
  if (spec.relativeDate) {
    const window = resolveDateWindow(operator, options.now);
    if (!window) {
      throw new ViewPlanError(`Could not work out what “${spec.label}” means.`, field.name);
    }
    const tokens: QueryToken[] = [sqlToken("(")];
    if (window.from) {
      tokens.push(sqlToken(`${column} >= `), param(window.from.toISOString()));
      tokens.push(sqlToken("::timestamptz"));
    }
    if (window.from && window.until) tokens.push(sqlToken(" AND "));
    if (window.until) {
      // ⚠️ STRICTLY LESS THAN. Half-open windows — see `resolveDateWindow`.
      tokens.push(sqlToken(`${column} < `), param(window.until.toISOString()));
      tokens.push(sqlToken("::timestamptz"));
    }
    tokens.push(sqlToken(")"));
    return tokens;
  }

  /* --- Text matching --------------------------------------------- */
  if (operator === "contains" || operator === "starts_with") {
    const coerced = coerceOperand(field.kind, condition.value);
    if (!coerced.ok) throw new ViewPlanError(coerced.error, field.name);

    // ⚠️ `%` AND `_` IN THE OPERAND ARE ESCAPED, AND THIS IS A CORRECTNESS
    // BUG BEFORE IT IS ANYTHING ELSE. A user searching for a phone number
    // with an underscore, or for "50%", otherwise gets a pattern that
    // matches every row — and a filter that matches everything looks like
    // a filter that is not applied.
    const escaped = String(coerced.value).replace(/([\\%_])/g, "\\$1");
    const pattern = operator === "contains" ? `%${escaped}%` : `${escaped}%`;
    return [sqlToken(`(${column}::text ILIKE `), param(pattern), sqlToken(")")];
  }

  /* --- between --------------------------------------------------- */
  if (operator === "between") {
    const values = condition.values;
    if (!Array.isArray(values) || values.length !== 2) {
      throw new ViewPlanError(`“Is between” needs exactly two values.`, field.name);
    }
    const low = coerceOperand(field.kind, values[0]);
    const high = coerceOperand(field.kind, values[1]);
    if (!low.ok) throw new ViewPlanError(low.error, field.name);
    if (!high.ok) throw new ViewPlanError(high.error, field.name);

    return [
      sqlToken(`(${column} >= `),
      param(low.value),
      castFor(field.kind),
      sqlToken(` AND ${column} <= `),
      param(high.value),
      castFor(field.kind),
      sqlToken(")"),
    ];
  }

  /* --- in -------------------------------------------------------- */
  if (operator === "in") {
    const values = condition.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new ViewPlanError(`“Is any of” needs at least one value.`, field.name);
    }
    if (values.length > MAX_IN_VALUES) {
      throw new ViewPlanError(
        `“Is any of” takes at most ${MAX_IN_VALUES} values.`,
        field.name,
      );
    }

    // ⚠️ EXPANDED INTO INDIVIDUAL PLACEHOLDERS RATHER THAN `= ANY($1)`.
    // An array parameter needs an explicit element-type cast, and getting
    // that cast wrong on an enum column produces `operator does not exist:
    // lead_status = text[]` at a customer's site rather than in a test.
    const tokens: QueryToken[] = [sqlToken(`(${column} IN (`)];
    values.forEach((raw, index) => {
      const coerced = coerceOperand(field.kind, raw);
      if (!coerced.ok) throw new ViewPlanError(coerced.error, field.name);
      if (index > 0) tokens.push(sqlToken(", "));
      tokens.push(param(coerced.value), castFor(field.kind));
    });
    tokens.push(sqlToken("))"));
    return tokens;
  }

  /* --- Ordinary comparisons -------------------------------------- */
  const coerced = coerceOperand(field.kind, condition.value);
  if (!coerced.ok) throw new ViewPlanError(coerced.error, field.name);

  const sqlOperator = {
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  }[operator as "eq" | "neq" | "gt" | "gte" | "lt" | "lte"];

  if (!sqlOperator) {
    throw new ViewPlanError(`Unsupported comparison.`, field.name);
  }

  // ⚠️ `neq` INCLUDES NULLS DELIBERATELY. `status <> 'lost'` in SQL
  // excludes rows where status is NULL, because NULL compares to nothing.
  // A person choosing "source is not portal" means "everything that is
  // not portal", including the ones with no source recorded — and a
  // filter that silently drops them is how a lead disappears from every
  // list without anybody deleting it.
  if (operator === "neq") {
    return [
      sqlToken(`(${column} IS DISTINCT FROM `),
      param(coerced.value),
      castFor(field.kind),
      sqlToken(")"),
    ];
  }

  return [
    sqlToken(`(${column} ${sqlOperator} `),
    param(coerced.value),
    castFor(field.kind),
    sqlToken(")"),
  ];
}

/**
 * The cast that goes after a bound parameter.
 *
 * ⚠️ NEEDED BECAUSE THE PARAMETER IS UNTYPED AT THE PROTOCOL LEVEL.
 * PostgreSQL infers `$1`'s type from context, and against an enum column
 * or a uuid column it infers `text`, then fails with "operator does not
 * exist". The cast is on the PARAMETER, never on the column — casting the
 * column would throw the index away, which turns a keyed lookup into a
 * sequential scan on the biggest table the customer has.
 *
 * `enum` gets NO cast: `col = $1` where `$1` is text resolves through the
 * enum's implicit input conversion, and naming the enum type here would
 * require the type name — a second identifier from a stored row, which is
 * the thing this phase exists to avoid.
 */
function castFor(kind: string): QueryToken {
  switch (kind) {
    case "uuid":
      return sqlToken("::uuid");
    case "date":
      return sqlToken("::timestamptz");
    case "money":
      return sqlToken("::bigint");
    case "number":
      return sqlToken("::numeric");
    default:
      return sqlToken("");
  }
}

/* ------------------------------------------------------------------ */
/* ORDER BY                                                            */
/* ------------------------------------------------------------------ */

export type CompiledOrder = {
  /** Ready to follow `ORDER BY`. Contains identifiers and keywords only. */
  text: string;
  /** The fields actually used, after unresolvable ones were refused. */
  fields: ViewFieldDescriptor[];
};

/**
 * Compile the sort list.
 *
 * ⚠️ THIS IS THE `sortBy` INJECTION `lib/validators/sales.ts` PINS TO A
 * `z.enum`, GENERALISED. Two things make the general version safe where a
 * regex would not be:
 *
 *   • the name is RESOLVED against this object's field table, so it
 *     provably came out of Drizzle's schema metadata rather than out of
 *     the request; and
 *   • the DIRECTION is not a string at all. `sortDir` is mapped to one of
 *     two literals written here. Interpolating even a validated
 *     `"asc"`/`"desc"` string is the shape of the bug, and the shape is
 *     what gets copied into the next file.
 *
 * ⚠️ A TIEBREAKER IS ALWAYS APPENDED. Without one, two rows with the same
 * `updated_at` come back in whatever order the executor happened to
 * produce — which differs between page 1 and page 2 of the same query, so
 * a record appears twice and another never appears at all. Paginated
 * lists with an unstable sort lose rows, silently, and only under load.
 */
export function compileOrderBy(
  object: ViewObjectDefinition,
  sorts: readonly SortSpec[],
  alias?: string,
): CompiledOrder {
  if (sorts.length > MAX_SORTS) {
    throw new ViewPlanError(`A view may sort by at most ${MAX_SORTS} fields.`);
  }

  const parts: string[] = [];
  const fields: ViewFieldDescriptor[] = [];

  for (const sort of sorts) {
    const field = resolveField(object, sort.field);
    if (!field) {
      throw new ViewPlanError(
        `Cannot sort by "${String(sort.field)}" — ${object.label} has no such field.`,
        String(sort.field),
      );
    }
    if (!field.sortable) {
      throw new ViewPlanError(`${field.label} cannot be sorted on.`, field.name);
    }

    // ⭐ Two literals. Never the caller's string, even a validated one.
    const direction = sort.direction === "asc" ? "ASC" : "DESC";
    const nulls = sort.nulls === "first" ? "NULLS FIRST" : "NULLS LAST";

    parts.push(`${quoteColumn(field, alias)} ${direction} ${nulls}`);
    fields.push(field);
  }

  // The stable tiebreaker. `id` exists on every object in the registry
  // and on every Phase 24 runtime table.
  const idField = resolveField(object, "id");
  parts.push(`${idField ? quoteColumn(idField, alias) : '"id"'} DESC`);

  return { text: parts.join(", "), fields };
}

/* ------------------------------------------------------------------ */
/* SELECT LIST AND GROUP BY                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve the visible-column list into descriptors.
 *
 * ⚠️ `id` IS ALWAYS INCLUDED WHETHER OR NOT THE VIEW ASKS FOR IT. Every
 * renderer keys rows by it, every row action needs it, and a view that
 * hid it would produce a table whose rows cannot be opened.
 */
export function resolveColumns(
  object: ViewObjectDefinition,
  columns: readonly { field: string }[],
): ViewFieldDescriptor[] {
  if (columns.length > MAX_VISIBLE_COLUMNS) {
    throw new ViewPlanError(`A view may show at most ${MAX_VISIBLE_COLUMNS} columns.`);
  }

  const resolved: ViewFieldDescriptor[] = [];
  const seen = new Set<string>();

  const idField = resolveField(object, "id");
  if (idField) {
    resolved.push(idField);
    seen.add(idField.name);
  }

  for (const column of columns) {
    const field = resolveField(object, column.field);
    // ⚠️ A COLUMN THAT NO LONGER EXISTS IS DROPPED, NOT REFUSED — and this
    // is the one place in the phase where silence is right. A field
    // removed from an object should not make every saved view over it
    // fail to open; the reader loses a column and keeps their view. A
    // FILTER on a missing field still refuses, because dropping it would
    // silently widen what the view returns.
    if (!field || seen.has(field.name)) continue;
    resolved.push(field);
    seen.add(field.name);
  }

  return resolved;
}

/** `"a", "b", "c"` — identifiers only, from resolved descriptors. */
export function compileSelectList(
  fields: readonly ViewFieldDescriptor[],
  alias?: string,
): string {
  if (fields.length === 0) throw new ViewPlanError("A view must show at least one column.");
  return fields.map((field) => quoteColumn(field, alias)).join(", ");
}

/** The Kanban / group-by column, resolved and refused if not groupable. */
export function resolveGroupBy(
  object: ViewObjectDefinition,
  groupBy: unknown,
): ViewFieldDescriptor {
  const field = resolveField(object, groupBy);
  if (!field) {
    throw new ViewPlanError(
      `Cannot group by "${String(groupBy)}" — ${object.label} has no such field.`,
    );
  }
  if (!field.groupable) {
    throw new ViewPlanError(
      `${field.label} cannot be used as board columns. Pick a status, a yes/no ` +
        `field, or a person.`,
      field.name,
    );
  }
  return field;
}

export function compileGroupByColumn(
  field: ViewFieldDescriptor,
  alias?: string,
): string {
  return quoteColumn(field, alias);
}

/* ------------------------------------------------------------------ */
/* RENDERING                                                           */
/* ------------------------------------------------------------------ */

/**
 * Turn a token list into a `$n` statement fragment plus its parameters.
 *
 * Used by the tests (which run the result through `pg` directly) and by
 * anything speaking the wire protocol. `server/views/query.ts` uses the
 * Drizzle path instead, which consumes the same tokens — one compiler,
 * two consumers, so the thing the tests exercise is the thing that runs.
 */
export function renderTokens(
  tokens: readonly QueryToken[],
  startIndex = 1,
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  let next = startIndex;
  let text = "";

  for (const token of tokens) {
    if (token.kind === "sql") {
      text += token.text;
    } else {
      text += `$${next}`;
      next += 1;
      params.push(token.value);
    }
  }

  return { text, params };
}
