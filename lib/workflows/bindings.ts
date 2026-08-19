/**
 * Ordence — Bindings and Condition Evaluation
 * Version: v0.23.0-alpha
 *
 * Pure. This is the whole of the "expression language", and its most
 * important property is how little it does.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THERE IS NO EXPRESSION EVALUATOR HERE
 * ══════════════════════════════════════════════════════════════════════
 * Every workflow builder eventually gets asked for `{{ price * 1.18 }}`,
 * and the shortest route to it is `new Function("ctx", "return " + expr)`.
 * That single line hands every workspace administrator arbitrary code
 * execution inside the server process that holds the database
 * credentials, the Clerk secret and the tenant context of whoever
 * happened to trigger the run. `eval`, `vm.runInNewContext` and a
 * hand-written parser with a `call` node are the same thing wearing
 * different hats.
 *
 * So bindings do exactly one operation: READ A PATH OUT OF THE RUN
 * CONTEXT. `{{ trigger.record.status }}` is a property lookup and nothing
 * else. Arithmetic, formatting and conditionals are the engine's job —
 * `if_else` exists precisely so the author never needs an expression to
 * make a decision.
 *
 * When arithmetic is genuinely needed it arrives as a named action with a
 * fixed shape, not as a language. That is slower to build and it is the
 * only version of this feature that can be reasoned about.
 */

import type {
  RunContext,
  WorkflowCondition,
  WorkflowConditionGroup,
} from "./program";

/* ------------------------------------------------------------------ */
/* PATH READING                                                        */
/* ------------------------------------------------------------------ */

/**
 * Keys that must never be traversed.
 *
 * ⚠️ `__proto__` is the one that matters and it is not theoretical.
 * Reading it is how a "harmless" lookup reaches `Object.prototype`, and
 * the same path list is reused by `interpolate` and by the value-writing
 * code in the executor — where a WRITE to `__proto__` would pollute every
 * object in the process, not just this run's.
 *
 * Refusing the segment on the READ side as well costs nothing and means
 * there is one rule rather than two that must agree.
 */
const FORBIDDEN_SEGMENTS = Object.freeze(["__proto__", "constructor", "prototype"]);

export function readPath(context: unknown, path: string): unknown {
  if (typeof path !== "string" || path.length === 0) return undefined;

  let current: unknown = context;

  for (const rawSegment of path.split(".")) {
    const segment = rawSegment.trim();
    if (segment.length === 0) return undefined;
    if (FORBIDDEN_SEGMENTS.includes(segment)) return undefined;
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      // Numeric index, or `length`. Anything else on an array is a method,
      // and handing a workflow author a function reference is how a
      // "read-only" binding becomes callable somewhere downstream.
      if (segment === "length") {
        current = current.length;
        continue;
      }
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }

    if (typeof current !== "object") return undefined;

    // `Object.hasOwn`, not `in` — same reasoning as `isFeatureKey` in
    // Phase 12. `in` walks the prototype chain, so `toString` would
    // resolve to a function on every object in the context.
    if (!Object.hasOwn(current as Record<string, unknown>, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/* ------------------------------------------------------------------ */
/* INTERPOLATION                                                       */
/* ------------------------------------------------------------------ */

const BINDING_PATTERN = /\{\{\s*([a-zA-Z0-9_.\[\]]+)\s*\}\}/g;

/**
 * Replace every `{{ path }}` in a string with its value.
 *
 * ⚠️ AN UNRESOLVABLE BINDING BECOMES AN EMPTY STRING, AND THAT IS THE
 * WRONG-LOOKING CHOICE UNTIL YOU SEE THE ALTERNATIVE.
 *
 * The tempting behaviour is to leave `{{ trigger.record.nmae }}` in place
 * so the mistake is visible. Then the typo is emailed to a customer
 * verbatim, or written into a record, or sent to a third-party API — the
 * defect escapes the workspace. An empty string keeps it inside, and
 * `describeUnresolved()` gives the run history the list so the author can
 * still see exactly which binding produced nothing.
 */
export function interpolate(
  template: string,
  context: RunContext | Record<string, unknown>,
): string {
  if (typeof template !== "string") return "";
  return template.replace(BINDING_PATTERN, (_match, path: string) => {
    const value = readPath(context, path ?? "");
    return stringifyBinding(value);
  });
}

/** The bindings in `template` that resolve to nothing. For run history. */
export function describeUnresolved(
  template: string,
  context: RunContext | Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const match of template.matchAll(BINDING_PATTERN)) {
    const path = match[1] ?? "";
    const value = readPath(context, path);
    if (value === undefined || value === null) missing.push(path);
  }
  return missing;
}

/**
 * Resolve a step value that may be a whole binding.
 *
 * `"{{ trigger.record.score }}"` returns the NUMBER 42, not the string
 * "42" — because it is about to be written into an integer column, and a
 * quoted number is either a type error or, worse, an implicit cast that
 * succeeds and rounds. A string with text around the binding stays a
 * string, since that is unambiguously text.
 */
export function resolveValue(
  value: unknown,
  context: RunContext | Record<string, unknown>,
): unknown {
  if (typeof value !== "string") return value;

  const whole = value.trim().match(/^\{\{\s*([a-zA-Z0-9_.\[\]]+)\s*\}\}$/);
  if (whole) return readPath(context, whole[1] ?? "");

  return interpolate(value, context);
}

function stringifyBinding(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  // An object interpolated into a sentence is `[object Object]` in every
  // naive implementation, which then gets emailed to a buyer. JSON at
  // least says what it is.
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* CONDITIONS                                                          */
/* ------------------------------------------------------------------ */

/**
 * Evaluate one condition against the run context.
 *
 * ⚠️ COMPARISON IS DELIBERATELY LOOSE ON NUMBERS AND STRICT ON EVERYTHING
 * ELSE. `trigger.record.score` arrives as a number from the database and
 * as the string "80" from a form the administrator typed into. A strict
 * `===` there means the condition silently never matches and the workflow
 * "does nothing" with no error anywhere — the single most common support
 * ticket every automation product has.
 */
export function evaluateCondition(
  condition: WorkflowCondition,
  context: RunContext | Record<string, unknown>,
): boolean {
  const left = readPath(context, condition.path);
  const right = resolveValue(condition.value, context);

  switch (condition.operator) {
    case "is_empty":
      return isEmpty(left);
    case "is_not_empty":
      return !isEmpty(left);

    case "changed": {
      // The field-scoped trigger's condition form. `path` here names a
      // field, not a context path, so it is matched against the list the
      // dispatcher recorded.
      const changed = readPath(context, "trigger.changedFields");
      if (!Array.isArray(changed)) return false;
      const field = condition.path.split(".").pop() ?? condition.path;
      return changed.includes(field);
    }

    case "eq":
      return looseEquals(left, right);
    case "neq":
      return !looseEquals(left, right);

    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const comparison = compare(left, right);
      if (comparison === null) return false;
      if (condition.operator === "gt") return comparison > 0;
      if (condition.operator === "gte") return comparison >= 0;
      if (condition.operator === "lt") return comparison < 0;
      return comparison <= 0;
    }

    case "contains":
      return containsValue(left, right);
    case "not_contains":
      return !containsValue(left, right);

    case "in":
      return Array.isArray(right) && right.some((candidate) => looseEquals(left, candidate));

    default:
      // ⚠️ FAILS CLOSED. An operator this file has never heard of came
      // from a definition written by a newer version of the product, or
      // from a hand-edited row. Treating it as TRUE would run actions
      // that were meant to be gated.
      return false;
  }
}

/**
 * Evaluate a group.
 *
 * ⚠️ AN EMPTY CONDITION LIST IS TRUE, AND THAT IS CHECKED IN TWO PLACES.
 *
 * "No conditions" means "no restriction", which is the intuitive reading
 * for a filter step someone has not finished configuring — but it is the
 * dangerous reading for a filter whose conditions were lost by a bad
 * migration. `validation.ts` therefore refuses to PUBLISH a filter with
 * no conditions; this function still returns true, so the semantics are
 * simple and the refusal lives where the author can act on it.
 */
export function evaluateGroup(
  group: WorkflowConditionGroup | undefined | null,
  context: RunContext | Record<string, unknown>,
): boolean {
  if (!group || !Array.isArray(group.conditions) || group.conditions.length === 0) {
    return true;
  }
  if (group.match === "any") {
    return group.conditions.some((c) => evaluateCondition(c, context));
  }
  return group.conditions.every((c) => evaluateCondition(c, context));
}

/* ------------------------------------------------------------------ */
/* COMPARISON HELPERS                                                  */
/* ------------------------------------------------------------------ */

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  // ⚠️ NOT `!value`. Zero and `false` are values somebody stored on
  // purpose — a lead score of 0 is a real score, and treating it as
  // "empty" is how a scoring workflow skips exactly the leads it exists
  // to catch.
  return false;
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }

  if (left instanceof Date || right instanceof Date) {
    const a = toTime(left);
    const b = toTime(right);
    return a !== null && b !== null && a === b;
  }

  if (typeof left === "boolean" || typeof right === "boolean") {
    return toBoolean(left) === toBoolean(right);
  }

  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber === rightNumber;

  return String(left) === String(right);
}

/** -1, 0, 1 — or null when the two are not comparable at all. */
function compare(left: unknown, right: unknown): number | null {
  const leftTime = toTime(left);
  const rightTime = toTime(right);
  if (leftTime !== null && rightTime !== null) {
    return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
  }

  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }

  if (typeof left === "string" && typeof right === "string") {
    return left === right ? 0 : left < right ? -1 : 1;
  }

  // ⚠️ Not comparable. Returning 0 here would make `gte` true for a
  // comparison that is meaningless, which is the friendliest possible way
  // to run an action nobody authorised.
  return null;
}

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) {
    return haystack.some((candidate) => looseEquals(candidate, needle));
  }
  if (typeof haystack === "string") {
    return haystack.toLowerCase().includes(String(needle ?? "").toLowerCase());
  }
  return false;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    // ⚠️ Only strings that LOOK like a date. `Date.parse("7")` is a valid
    // date in several engines, so an unguarded parse turns every numeric
    // string comparison into a date comparison.
    if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(value)) return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "yes" || lowered === "1") return true;
    if (lowered === "false" || lowered === "no" || lowered === "0" || lowered === "") {
      return false;
    }
  }
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}
