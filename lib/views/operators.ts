/**
 * Ordence — The Operator Catalogue
 * Version: v0.25.0-alpha
 *
 * Pure. A frozen table plus the coercion rules for operands. No SQL is
 * built here — that is `lib/views/planner.ts` — because the question
 * "may this operator be used on this field, with this operand?" is asked
 * in three places that have nothing to do with SQL: the builder UI while
 * somebody is typing, the validator at save time, and the planner again
 * at replay time.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY OPERATOR APPLICABILITY IS A SECURITY CONCERN AND NOT A UI NICETY
 * ══════════════════════════════════════════════════════════════════════
 * It is tempting to let any operator meet any field and leave PostgreSQL
 * to complain. Three reasons not to:
 *
 *   1. `contains` on a uuid column compiles to `col::text ILIKE '%…%'`.
 *      That is a full scan of a table whose index is useless for it, and
 *      it is also an ORACLE — a caller who cannot read a record can still
 *      learn whether one exists whose owner id starts with a given prefix,
 *      one character at a time, from nothing but the row COUNT.
 *
 *   2. A type error from PostgreSQL is a 500 with a message that names
 *      the column and the table. `invalid input syntax for type uuid` is
 *      a schema disclosure with a stack trace attached.
 *
 *   3. ⚠️ THE OPERAND IS COERCED HERE, ONCE, AND EVERY COERCION FAILURE
 *      IS A REFUSAL RATHER THAN A CAST. `Number("")` is 0 and `new
 *      Date("")` is Invalid Date; both would otherwise reach a bound
 *      parameter and quietly match the wrong rows. A filter that returns
 *      the wrong rows is worse than one that errors, because it is used.
 *
 * ⚠️ NONE OF THIS IS THE INJECTION DEFENCE. Operands are ALWAYS bound
 * parameters, whatever they contain. The allowlist that matters for
 * injection is the FIELD one, in `lib/views/registry.ts`. This file stops
 * a filter being expensive, wrong, or an oracle.
 */

import type { FieldKind, FilterOperator } from "./types";

/* ------------------------------------------------------------------ */
/* ARITY                                                               */
/* ------------------------------------------------------------------ */

export type OperatorArity =
  /** No operand at all: `is_empty`, `today`, `overdue`, `is_true`. */
  | "none"
  /** Exactly one: `eq`, `contains`, `gt`. */
  | "one"
  /** Exactly two, ordered: `between`. */
  | "two"
  /** One to `MAX_IN_VALUES`: `in`. */
  | "many";

export type OperatorSpec = {
  label: string;
  arity: OperatorArity;
  /** Field kinds this operator may be applied to. */
  kinds: readonly FieldKind[];
  /**
   * True when the operator's meaning comes from the clock rather than
   * from an operand. The planner resolves these against an INJECTED
   * `now`, never `Date.now()` — see the note there.
   */
  relativeDate?: true;
};

/* ------------------------------------------------------------------ */
/* THE CATALOGUE                                                       */
/* ------------------------------------------------------------------ */

const TEXTUAL: readonly FieldKind[] = ["text", "enum", "uuid"];
const ORDERED: readonly FieldKind[] = ["number", "money", "date"];
const DATES: readonly FieldKind[] = ["date"];

/**
 * ⚠️ `json` APPEARS IN NO LIST, DELIBERATELY.
 *
 * A jsonb column (`leads.custom_fields`) is describable — the registry
 * lists it so a caller can be told the field exists — and it is filterable
 * by nothing. Filtering inside it means a path expression, and a path is a
 * second untrusted identifier-shaped string with its own allowlist
 * problem. When custom fields need filtering they get it through Phase
 * 24's runtime objects, which have real typed columns.
 */
export const OPERATORS: Readonly<Record<FilterOperator, OperatorSpec>> = Object.freeze({
  eq: { label: "is", arity: "one", kinds: [...TEXTUAL, ...ORDERED] },
  neq: { label: "is not", arity: "one", kinds: [...TEXTUAL, ...ORDERED] },

  // ⚠️ TEXT ONLY. Not uuid, not enum — see reason 1 in the header. An enum
  // has a fixed, short value list, so `in` says the same thing exactly and
  // uses the index.
  contains: { label: "contains", arity: "one", kinds: ["text"] },
  starts_with: { label: "starts with", arity: "one", kinds: ["text"] },

  gt: { label: "is after / greater than", arity: "one", kinds: ORDERED },
  gte: { label: "is on or after / at least", arity: "one", kinds: ORDERED },
  lt: { label: "is before / less than", arity: "one", kinds: ORDERED },
  lte: { label: "is on or before / at most", arity: "one", kinds: ORDERED },
  between: { label: "is between", arity: "two", kinds: ORDERED },

  in: { label: "is any of", arity: "many", kinds: [...TEXTUAL, "number", "money"] },

  is_empty: {
    label: "is empty",
    arity: "none",
    kinds: ["text", "enum", "uuid", "number", "money", "date", "boolean"],
  },
  is_not_empty: {
    label: "is not empty",
    arity: "none",
    kinds: ["text", "enum", "uuid", "number", "money", "date", "boolean"],
  },

  is_true: { label: "is yes", arity: "none", kinds: ["boolean"] },
  is_false: { label: "is no", arity: "none", kinds: ["boolean"] },

  today: { label: "is today", arity: "none", kinds: DATES, relativeDate: true },
  this_week: { label: "is this week", arity: "none", kinds: DATES, relativeDate: true },
  last_7_days: {
    label: "is in the last 7 days",
    arity: "none",
    kinds: DATES,
    relativeDate: true,
  },
  last_30_days: {
    label: "is in the last 30 days",
    arity: "none",
    kinds: DATES,
    relativeDate: true,
  },
  overdue: { label: "is overdue", arity: "none", kinds: DATES, relativeDate: true },
});

/** Operators offered for a field of this kind, in catalogue order. */
export function operatorsForKind(kind: FieldKind): FilterOperator[] {
  return (Object.keys(OPERATORS) as FilterOperator[]).filter((op) =>
    OPERATORS[op].kinds.includes(kind),
  );
}

export function operatorAppliesTo(operator: FilterOperator, kind: FieldKind): boolean {
  return OPERATORS[operator].kinds.includes(kind);
}

/* ------------------------------------------------------------------ */
/* OPERAND COERCION                                                    */
/* ------------------------------------------------------------------ */

export type CoercionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Turn one operand into the value that will be BOUND, or refuse it.
 *
 * ⚠️ REFUSES RATHER THAN COERCES, EVERY TIME THE ANSWER IS AMBIGUOUS.
 * `Number("")` is 0, `Number(" ")` is 0, `Number(null)` is 0 and
 * `new Date("last tuesday")` is Invalid Date. Each of those, bound into a
 * comparison, silently changes which rows come back — and a saved view
 * that returns the wrong rows is trusted precisely because it returns
 * something.
 *
 * ⚠️ `money` STAYS A STRING. Minor units are `bigint` in the database, and
 * `JSON.parse("87456330000000")` is a float once it exceeds 2^53. The
 * driver binds a numeric string to a bigint column correctly; a JavaScript
 * number is the value that has already lost its last digits.
 */
export function coerceOperand(kind: FieldKind, raw: unknown): CoercionResult {
  switch (kind) {
    case "text": {
      if (typeof raw !== "string") return fail("Expected some text.");
      return { ok: true, value: raw };
    }

    case "enum":
      // The VALUE list is checked against the field's own enum in
      // `validation.ts`, where the descriptor is in scope. Here we only
      // insist it is a string.
      if (typeof raw !== "string") return fail("Expected one of the allowed choices.");
      return { ok: true, value: raw };

    case "uuid": {
      if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
        // ⚠️ Checked in TypeScript even though the parameter is bound.
        // Without it, `WHERE owner_id = 'abc'` is a Postgres cast error —
        // a 500 whose message names the column and the table.
        return fail("Expected a record identifier.");
      }
      return { ok: true, value: raw };
    }

    case "number": {
      if (typeof raw === "number") {
        if (!Number.isFinite(raw)) return fail("Expected a number.");
        return { ok: true, value: raw };
      }
      if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
        return { ok: true, value: Number(raw) };
      }
      return fail("Expected a number.");
    }

    case "money": {
      const text = typeof raw === "number" ? String(raw) : raw;
      if (typeof text !== "string" || !/^-?\d{1,19}$/.test(text.trim())) {
        return fail("Expected an amount in whole minor units, e.g. 450000000.");
      }
      return { ok: true, value: text.trim() };
    }

    case "date": {
      if (raw instanceof Date) {
        if (Number.isNaN(raw.getTime())) return fail("Expected a date.");
        return { ok: true, value: raw.toISOString() };
      }
      if (typeof raw === "string") {
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) return fail("Expected a date.");
        return { ok: true, value: parsed.toISOString() };
      }
      return fail("Expected a date.");
    }

    case "boolean":
      // Booleans only ever meet `is_true`/`is_false`/`is_empty`, all of
      // which take no operand. Reaching here means the tree is malformed.
      return fail("A yes/no field does not take a value — use “is yes” or “is no”.");

    case "json":
      return fail("This field cannot be filtered on.");
  }
}

function fail(error: string): CoercionResult {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* RELATIVE DATE WINDOWS                                               */
/* ------------------------------------------------------------------ */

export type DateWindow = {
  /** Inclusive lower bound, or null for "unbounded below". */
  from: Date | null;
  /** EXCLUSIVE upper bound, or null for "unbounded above". */
  until: Date | null;
};

/**
 * Resolve a relative-date operator into a half-open window `[from, until)`.
 *
 * ⚠️ HALF-OPEN, NOT INCLUSIVE-BOTH-ENDS, AND IT MATTERS FOR TIMESTAMPS.
 * "Today" expressed as `>= 00:00 AND <= 23:59:59` loses every row between
 * 23:59:59.001 and midnight. On a `date` column nobody notices; on a
 * `timestamptz` written by an automation at 23:59:59.4 somebody does, once,
 * in an audit.
 *
 * ⚠️ `now` IS AN ARGUMENT, NOT `new Date()`. Two reasons: the window is
 * then a pure function of its inputs and testable at any instant, and a
 * future phase can pass a tenant-local clock so that "today" means the
 * customer's today rather than UTC's.
 *
 * ⚠️ THE WEEK STARTS ON MONDAY. Sunday-start is the US convention and this
 * product's users close deals on Saturdays; a "this week" that rolls over
 * on Sunday night splits their weekend across two reports.
 */
export function resolveDateWindow(operator: FilterOperator, now: Date): DateWindow | null {
  const spec = OPERATORS[operator];
  if (!spec?.relativeDate) return null;

  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  switch (operator) {
    case "today":
      return { from: startOfToday, until: addDays(startOfToday, 1) };

    case "this_week": {
      // getUTCDay(): 0 = Sunday. Monday-start means Sunday is 6 days in.
      const dayOffset = (now.getUTCDay() + 6) % 7;
      const monday = addDays(startOfToday, -dayOffset);
      return { from: monday, until: addDays(monday, 7) };
    }

    case "last_7_days":
      // Includes today, so the window is 7 days ending tomorrow morning.
      return { from: addDays(startOfToday, -6), until: addDays(startOfToday, 1) };

    case "last_30_days":
      return { from: addDays(startOfToday, -29), until: addDays(startOfToday, 1) };

    case "overdue":
      // ⚠️ Strictly before NOW, not before midnight. A follow-up due at
      // 10am is overdue at 11am, not tomorrow — the whole reason anybody
      // filters on it is to find the calls that have already been missed.
      return { from: null, until: now };

    default:
      return null;
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
