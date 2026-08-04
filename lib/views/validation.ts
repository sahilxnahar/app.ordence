/**
 * Ordence — Saved-View Validation
 * Version: v0.25.0-alpha
 *
 * Pure. Structural checks on a view definition, run at SAVE time against
 * a resolved object.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS WHEN THE PLANNER ALREADY REFUSES EVERYTHING BAD
 * ══════════════════════════════════════════════════════════════════════
 * The planner throws on the first problem it meets, because a query that
 * is about to run either runs correctly or does not run. That is the
 * right behaviour there and the wrong behaviour in a form: an author who
 * has made four mistakes gets told about one, fixes it, and is told about
 * the next. Four round trips, and the fourth message contradicts what
 * they were told in the first.
 *
 * So this file collects EVERY problem and names the node each one is
 * about. It is the same rule set — it calls into the same registry and
 * the same operator catalogue — expressed as a report rather than as an
 * exception.
 *
 * ⚠️ IT IS NOT A SUBSTITUTE FOR THE PLANNER'S CHECKS AND MUST NEVER BE
 * TREATED AS ONE. A view saved today is replayed in eight months, after a
 * field has been removed, after an operator has been retired, after this
 * validator has been tightened. The planner re-checks everything from
 * scratch on every single run, and the correct reaction to "the validator
 * already did that" is to leave both in place.
 */

import {
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_IN_VALUES,
  MAX_SORTS,
  MAX_VIEW_NAME_LENGTH,
  MAX_VISIBLE_COLUMNS,
} from "./limits";
import { OPERATORS, coerceOperand } from "./operators";
import { resolveField, type ViewObjectDefinition } from "./registry";
import {
  isFilterGroup,
  isFilterOperator,
  type FilterGroup,
  type FilterNode,
  type SortSpec,
  type ViewDefinition,
} from "./types";

export type ViewProblem = {
  /** A dotted path into the definition: `filter.children.0.field`. */
  path: string;
  message: string;
};

export type ViewValidation =
  | { ok: true }
  | { ok: false; problems: ViewProblem[] };

/* ------------------------------------------------------------------ */
/* THE FILTER TREE                                                     */
/* ------------------------------------------------------------------ */

export function validateFilter(
  object: ViewObjectDefinition,
  filter: FilterGroup,
): ViewProblem[] {
  const problems: ViewProblem[] = [];
  const counter = { nodes: 0 };
  walkGroup(object, filter, "filter", 1, counter, problems);
  return problems;
}

function walkGroup(
  object: ViewObjectDefinition,
  group: FilterGroup,
  path: string,
  depth: number,
  counter: { nodes: number },
  problems: ViewProblem[],
): void {
  counter.nodes += 1;

  if (counter.nodes > MAX_FILTER_NODES) {
    // Reported once, then the walk stops — a tree of 40,000 nodes would
    // otherwise produce 40,000 identical messages, which is its own kind
    // of denial of service against the person reading them.
    if (!problems.some((p) => p.path === "filter" && p.message.includes("conditions"))) {
      problems.push({
        path: "filter",
        message: `A filter may hold at most ${MAX_FILTER_NODES} conditions and groups.`,
      });
    }
    return;
  }

  if (depth > MAX_FILTER_DEPTH) {
    problems.push({
      path,
      message: `Filter groups may not nest more than ${MAX_FILTER_DEPTH} deep.`,
    });
    return;
  }

  if (group.match !== "all" && group.match !== "any") {
    problems.push({ path: `${path}.match`, message: `Choose “all” or “any”.` });
  }

  const children = Array.isArray(group.children) ? group.children : [];

  // ⚠️ AN EMPTY NESTED GROUP IS REFUSED AT SAVE TIME, though the planner
  // tolerates one at replay time. The two are consistent: refusing it here
  // stops the shape being created, and tolerating it there stops a row
  // saved before this rule existed from making a view unopenable.
  if (children.length === 0 && depth > 1) {
    problems.push({
      path,
      message: "This group has no conditions in it. Remove it or add one.",
    });
  }

  children.forEach((child: FilterNode, index) => {
    const childPath = `${path}.children.${index}`;
    if (isFilterGroup(child)) {
      walkGroup(object, child, childPath, depth + 1, counter, problems);
    } else {
      counter.nodes += 1;
      walkCondition(object, child, childPath, problems);
    }
  });
}

function walkCondition(
  object: ViewObjectDefinition,
  condition: { field?: unknown; operator?: unknown; value?: unknown; values?: unknown },
  path: string,
  problems: ViewProblem[],
): void {
  const field = resolveField(object, condition.field);
  if (!field) {
    problems.push({
      path: `${path}.field`,
      message: `${object.label} has no field called "${String(condition.field)}".`,
    });
    return;
  }
  if (!field.filterable) {
    problems.push({ path: `${path}.field`, message: `${field.label} cannot be filtered on.` });
    return;
  }

  if (!isFilterOperator(condition.operator)) {
    problems.push({
      path: `${path}.operator`,
      message: `"${String(condition.operator)}" is not a comparison this system knows.`,
    });
    return;
  }

  const spec = OPERATORS[condition.operator];
  if (!spec.kinds.includes(field.kind)) {
    problems.push({
      path: `${path}.operator`,
      message: `“${spec.label}” cannot be used on ${field.label}.`,
    });
    return;
  }

  const values = Array.isArray(condition.values) ? condition.values : null;

  switch (spec.arity) {
    case "none":
      break;

    case "one": {
      const coerced = coerceOperand(field.kind, condition.value);
      if (!coerced.ok) {
        problems.push({ path: `${path}.value`, message: coerced.error });
      } else if (field.kind === "enum") {
        checkEnumValue(field.enumValues, condition.value, `${path}.value`, problems);
      }
      break;
    }

    case "two": {
      if (!values || values.length !== 2) {
        problems.push({ path: `${path}.values`, message: "Give a start and an end." });
        break;
      }
      values.forEach((raw, index) => {
        const coerced = coerceOperand(field.kind, raw);
        if (!coerced.ok) {
          problems.push({ path: `${path}.values.${index}`, message: coerced.error });
        }
      });
      // ⚠️ An inverted range matches nothing and produces no error at any
      // layer — the single most common way a filter is silently wrong.
      if (values.length === 2 && isInverted(field.kind, values[0], values[1])) {
        problems.push({
          path: `${path}.values`,
          message: "The end of the range is before the start, so nothing can match it.",
        });
      }
      break;
    }

    case "many": {
      if (!values || values.length === 0) {
        problems.push({ path: `${path}.values`, message: "Choose at least one value." });
        break;
      }
      if (values.length > MAX_IN_VALUES) {
        problems.push({
          path: `${path}.values`,
          message: `At most ${MAX_IN_VALUES} values.`,
        });
        break;
      }
      values.forEach((raw, index) => {
        const coerced = coerceOperand(field.kind, raw);
        if (!coerced.ok) {
          problems.push({ path: `${path}.values.${index}`, message: coerced.error });
          return;
        }
        if (field.kind === "enum") {
          checkEnumValue(field.enumValues, raw, `${path}.values.${index}`, problems);
        }
      });
      break;
    }
  }
}

/**
 * An enum operand must be one of the column's own values.
 *
 * ⚠️ NOT AN INJECTION DEFENCE — the operand is a bound parameter whatever
 * it says. It is a CORRECTNESS defence: `status = 'Qualified'` (capital Q)
 * is a filter that never matches and never errors, and the author's
 * conclusion is that they have no qualified leads.
 */
function checkEnumValue(
  allowed: readonly string[] | null,
  value: unknown,
  path: string,
  problems: ViewProblem[],
): void {
  if (!allowed || allowed.length === 0) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    problems.push({
      path,
      message: `Choose one of: ${allowed.join(", ")}.`,
    });
  }
}

function isInverted(kind: string, low: unknown, high: unknown): boolean {
  const a = coerceOperand(kind as never, low);
  const b = coerceOperand(kind as never, high);
  if (!a.ok || !b.ok) return false;
  if (kind === "date") return String(a.value) > String(b.value);
  if (kind === "money") return BigInt(String(a.value)) > BigInt(String(b.value));
  if (kind === "number") return Number(a.value) > Number(b.value);
  return false;
}

/* ------------------------------------------------------------------ */
/* THE WHOLE DEFINITION                                                */
/* ------------------------------------------------------------------ */

export function validateSorts(
  object: ViewObjectDefinition,
  sorts: readonly SortSpec[],
): ViewProblem[] {
  const problems: ViewProblem[] = [];

  if (sorts.length > MAX_SORTS) {
    problems.push({ path: "sorts", message: `At most ${MAX_SORTS} sort fields.` });
    return problems;
  }

  const seen = new Set<string>();
  sorts.forEach((sort, index) => {
    const field = resolveField(object, sort.field);
    if (!field) {
      problems.push({
        path: `sorts.${index}.field`,
        message: `${object.label} has no field called "${String(sort.field)}".`,
      });
      return;
    }
    if (!field.sortable) {
      problems.push({
        path: `sorts.${index}.field`,
        message: `${field.label} cannot be sorted on.`,
      });
      return;
    }
    // A repeated sort key does nothing at all — the second occurrence can
    // never break a tie the first has already broken — and it is always a
    // mistake in the builder rather than an intention.
    if (seen.has(field.name)) {
      problems.push({
        path: `sorts.${index}.field`,
        message: `${field.label} is already in the sort order.`,
      });
    }
    seen.add(field.name);

    if (sort.direction !== "asc" && sort.direction !== "desc") {
      problems.push({
        path: `sorts.${index}.direction`,
        message: `Sort direction must be “asc” or “desc”.`,
      });
    }
  });

  return problems;
}

/**
 * Validate a complete definition.
 *
 * ⚠️ THE TYPE-SPECIFIC REQUIREMENTS ARE CHECKED HERE **AND** AS DATABASE
 * CHECK CONSTRAINTS. A kanban with no group-by renders as one unlabelled
 * column containing everything, which reads as "the board is broken"
 * rather than as "this view is misconfigured"; a calendar with no date
 * field renders as nothing at all. Neither should be storable, so neither
 * is — see `SQL-FILES/0020_phase25_views.sql` §1.
 */
export function validateDefinition(
  object: ViewObjectDefinition,
  definition: ViewDefinition & { name?: string },
): ViewValidation {
  const problems: ViewProblem[] = [];

  if (definition.name !== undefined) {
    const name = definition.name.trim();
    if (name.length === 0) {
      problems.push({ path: "name", message: "Give the view a name." });
    } else if (name.length > MAX_VIEW_NAME_LENGTH) {
      problems.push({
        path: "name",
        message: `A name may be at most ${MAX_VIEW_NAME_LENGTH} characters.`,
      });
    }
  }

  problems.push(...validateFilter(object, definition.filter));
  problems.push(...validateSorts(object, definition.sorts));

  if (definition.columns.length > MAX_VISIBLE_COLUMNS) {
    problems.push({
      path: "columns",
      message: `A view may show at most ${MAX_VISIBLE_COLUMNS} columns.`,
    });
  }

  definition.columns.forEach((column, index) => {
    if (!resolveField(object, column.field)) {
      problems.push({
        path: `columns.${index}.field`,
        message: `${object.label} has no field called "${String(column.field)}".`,
      });
    }
  });

  if (definition.viewType === "kanban") {
    if (!definition.groupBy) {
      problems.push({
        path: "groupBy",
        message: "A board needs a field to make its columns from.",
      });
    } else {
      const field = resolveField(object, definition.groupBy);
      if (!field) {
        problems.push({
          path: "groupBy",
          message: `${object.label} has no field called "${definition.groupBy}".`,
        });
      } else if (!field.groupable) {
        problems.push({
          path: "groupBy",
          message: `${field.label} cannot be used as board columns. Pick a status, a yes/no field, or a person.`,
        });
      }
    }
  }

  if (definition.viewType === "calendar") {
    if (!definition.dateField) {
      problems.push({
        path: "dateField",
        message: "A calendar needs a date field to place records on.",
      });
    } else {
      const field = resolveField(object, definition.dateField);
      if (!field) {
        problems.push({
          path: "dateField",
          message: `${object.label} has no field called "${definition.dateField}".`,
        });
      } else if (field.kind !== "date") {
        problems.push({
          path: "dateField",
          message: `${field.label} is not a date.`,
        });
      }
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Field errors keyed by path, for an `ActionResult`'s `fieldErrors`. */
export function problemsToFieldErrors(
  problems: readonly ViewProblem[],
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const problem of problems) {
    (errors[problem.path] ??= []).push(problem.message);
  }
  return errors;
}
