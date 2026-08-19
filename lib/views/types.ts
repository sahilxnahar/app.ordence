/**
 * Ordence — The Saved-View Vocabulary
 * Version: v0.25.0-alpha
 *
 * Pure and isomorphic. No imports at all — not `@/db`, not `zod`, not a
 * Node API. Everything downstream (the registry, the operator catalogue,
 * the planner, the validator, the pgEnum in `db/schema/views.ts`, the
 * builder UI) reads its vocabulary from here.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEPENDENCY POINTS FROM THE DATABASE TOWARDS THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/views.ts` builds `view_type` from `VIEW_TYPES` below, the
 * same direction Phase 23 established for workflow actions and Phase 24
 * for field types. The reason is the same: the planner, the validator and
 * the renderer all reason about the list, while the column merely stores
 * a value from it. Two hand-maintained copies eventually disagree, and
 * the failure mode is a row the database accepts that no renderer can
 * draw — a saved view that exists and opens to a blank page.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ONE THING TO UNDERSTAND ABOUT THIS PHASE
 * ══════════════════════════════════════════════════════════════════════
 * A saved view stores FIELD NAMES — in its filter, in its sorts, in its
 * group-by, in its column list — and those names are replayed as SQL
 * IDENTIFIERS weeks later, by a different person, on a different request.
 *
 * A column name cannot be a bind parameter. `ORDER BY $1` sorts by the
 * literal string. So the name ends up interpolated, which is the thing
 * this codebase otherwise never does, and it is why `FilterCondition.field`
 * below is documented as UNTRUSTED INPUT WITH A LONG LIFE rather than as
 * a string.
 *
 * The defence is not escaping. It is that `lib/views/registry.ts` RESOLVES
 * every stored name against a per-object field table derived from real
 * Drizzle schema metadata, and the planner is only ever handed the
 * resolved descriptor — never the string that was stored. A name that is
 * not in the table does not resolve, and an unresolved name is a refusal,
 * never a fallback.
 */

/* ------------------------------------------------------------------ */
/* VIEW TYPES                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE ORDER OF THIS ARRAY IS THE ORDER OF THE POSTGRES ENUM.
 * Appending is free; reordering is an enum rewrite. Add to the end.
 */
export const VIEW_TYPES = ["table", "kanban", "calendar"] as const;

export type ViewType = (typeof VIEW_TYPES)[number];

export function isViewType(value: unknown): value is ViewType {
  return typeof value === "string" && (VIEW_TYPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* FIELD KINDS                                                         */
/* ------------------------------------------------------------------ */

/**
 * The SEMANTIC type of a field, which is not the same as its PostgreSQL
 * type and is deliberately coarser.
 *
 * `money` is the example that justifies the distinction: it is a `bigint`
 * of minor units in the database, and treating it as a plain number in
 * the UI prints ₹450000000 for ₹4.5 crore. `uuid` is the other: it is a
 * string to Postgres and a RELATION to a person reading the screen, so it
 * gets `eq`/`in` and never `contains`.
 */
export const FIELD_KINDS = [
  "text",
  "number",
  "money",
  "boolean",
  "date",
  "enum",
  "uuid",
  /** Present so the registry can describe the column, and filterable by nothing. */
  "json",
] as const;

export type FieldKind = (typeof FIELD_KINDS)[number];

/* ------------------------------------------------------------------ */
/* OPERATORS                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every comparison a saved filter may express.
 *
 * ⚠️ THE RELATIVE-DATE OPERATORS ARE OPERATORS, NOT VALUES, AND THAT IS
 * THE WHOLE POINT OF THEM.
 *
 * "Leads due this week" saved on Monday must still mean *this* week when
 * it is opened in March. Storing the resolved boundary — the thing a date
 * picker would give you — produces a view that is correct for one day and
 * quietly wrong forever after, which nobody notices because it still
 * returns rows.
 *
 * So the boundary is computed at QUERY time, from a clock the caller
 * passes in (see `lib/views/planner.ts`), and bound as an ordinary
 * parameter.
 */
export const FILTER_OPERATORS = [
  /* --- Equality ---------------------------------------------------- */
  "eq",
  "neq",
  /* --- Text -------------------------------------------------------- */
  "contains",
  "starts_with",
  /* --- Ordering ---------------------------------------------------- */
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  /* --- Sets -------------------------------------------------------- */
  "in",
  /* --- Presence ---------------------------------------------------- */
  "is_empty",
  "is_not_empty",
  /* --- Booleans ---------------------------------------------------- */
  //
  // ⚠️ SEPARATE OPERATORS RATHER THAN `eq: true`. A tri-state column
  // (true / false / NULL) filtered with `neq: true` includes the NULLs on
  // some databases and excludes them on others, and a saved view is the
  // worst place to discover which. `is_true` and `is_false` are both
  // explicit and both exclude NULL, which is what a checkbox means.
  "is_true",
  "is_false",
  /* --- Relative dates ---------------------------------------------- */
  "today",
  "this_week",
  "last_7_days",
  "last_30_days",
  /** Strictly in the past, and not null. The follow-up nobody made. */
  "overdue",
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export function isFilterOperator(value: unknown): value is FilterOperator {
  return (
    typeof value === "string" && (FILTER_OPERATORS as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* THE FILTER TREE                                                     */
/* ------------------------------------------------------------------ */

/**
 * One comparison.
 *
 * ⚠️ `field` IS UNTRUSTED INPUT WITH A LONG LIFE, AND IT BECOMES AN SQL
 * IDENTIFIER. It is never interpolated as it stands anywhere in this
 * codebase: `resolveField()` in `lib/views/registry.ts` turns it into a
 * descriptor or into `null`, and only the descriptor's `column` — a value
 * that came out of Drizzle's own schema metadata, not out of the row —
 * ever reaches a statement.
 *
 * `values` is separate from `value` rather than a union, because `between`
 * and `in` take lists and a single field that is sometimes an array is how
 * a validator ends up accepting `["'; DROP …"]` for `eq` and passing it to
 * something that stringifies it.
 */
export type FilterCondition = {
  type: "condition";
  field: string;
  operator: FilterOperator;
  /** For the single-operand operators. Absent for `is_empty`, `today`, … */
  value?: unknown;
  /** For `between` (exactly 2) and `in` (1..MAX_IN_VALUES). */
  values?: unknown[];
};

/**
 * A nested AND/OR group.
 *
 * ⚠️ `match` IS REQUIRED, WITH NO DEFAULT — the same rule Phase 23 applied
 * to workflow condition groups, for the same reason. "All of these" and
 * "any of these" are opposite instructions, and guessing one means the
 * view silently returns rows the author wrote it to exclude. Their
 * evidence that it works is that it returned something.
 */
export type FilterGroup = {
  type: "group";
  match: "all" | "any";
  children: FilterNode[];
};

export type FilterNode = FilterGroup | FilterCondition;

export function isFilterGroup(node: FilterNode): node is FilterGroup {
  return node.type === "group";
}

/** The neutral filter: no conditions, therefore every row. */
export function emptyFilter(): FilterGroup {
  return { type: "group", match: "all", children: [] };
}

/* ------------------------------------------------------------------ */
/* SORTS, GROUPING, COLUMNS                                            */
/* ------------------------------------------------------------------ */

export type SortDirection = "asc" | "desc";

export type SortSpec = {
  field: string;
  direction: SortDirection;
  /**
   * Where NULLs go.
   *
   * Defaults to `last` in the planner regardless of direction, which is
   * NOT PostgreSQL's default (it puts NULLs first on DESC). The database
   * default means "highest score first" opens on a screenful of leads
   * that have no score, and every reviewer reads that as an empty board.
   */
  nulls?: "first" | "last";
};

export type ColumnSpec = {
  field: string;
  /** Pixels, for the table renderer. Advisory; never reaches SQL. */
  width?: number;
};

/**
 * Everything a saved view says about HOW to look at an object. The stored
 * row in `saved_views` is this plus a name, an owner and sharing state.
 */
export type ViewDefinition = {
  viewType: ViewType;
  filter: FilterGroup;
  sorts: SortSpec[];
  /** Required for `kanban` — the column a card sits in. */
  groupBy?: string | null;
  /** Required for `calendar` — the date a card is drawn on. */
  dateField?: string | null;
  columns: ColumnSpec[];
};
