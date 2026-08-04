/**
 * Ordence — Runtime Record Value Validation
 * Version: v0.24.0-alpha
 *
 * Pure and isomorphic. No `@/db` import, no I/O.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE COLUMN TYPE IS THE REAL CHECK. THIS FILE IS THE POLITE ONE.
 * ══════════════════════════════════════════════════════════════════════
 * That sentence is the whole difference between this phase and the JSONB
 * engine it supersedes. In `custom_object_records`, a validator that
 * missed a case wrote a string into a "number" field and nobody found out
 * until a chart rendered `"12" + "7" = "127"`. Here, a string reaching a
 * `numeric` column is refused by PostgreSQL, in the transaction, before
 * anything is stored.
 *
 * So what is this file for? Two things the database is bad at:
 *
 *   1. TELLING A PERSON WHAT THEY DID WRONG. `invalid input syntax for
 *      type numeric: "twelve"` names the type and not the field, arrives
 *      as an exception rather than a form error, and aborts the whole
 *      transaction — so a form with three bad values reports one of them,
 *      three times, one round trip each.
 *
 *   2. NORMALISING. Lower-casing an email, trimming whitespace, turning a
 *      rupee amount into paise. The column accepts all of those; the
 *      product wants one of them.
 *
 * ⚠️ IT IS NOT A SECURITY BOUNDARY AND MUST NOT BE TREATED AS ONE. Every
 * value produced here is still bound as a QUERY PARAMETER, never
 * interpolated. If this file were the only thing between a form post and
 * the database, a missed branch would be an injection; because it is not,
 * a missed branch is a worse error message.
 */

import {
  fieldTypeSpec,
  isValidSelectValue,
  type DynamicFieldType,
  type SelectChoice,
} from "./field-types";
import {
  MAX_CURRENCY_MINOR_UNITS,
  MAX_LONG_TEXT_LENGTH,
  MAX_MULTI_SELECT_VALUES,
  MAX_TEXT_LENGTH,
} from "./limits";

/* ------------------------------------------------------------------ */
/* THE SHAPE A FIELD IS DESCRIBED BY                                   */
/* ------------------------------------------------------------------ */

/**
 * Everything this file needs to know about a field. A structural subset
 * of the `dynamic_fields` row, so `server/dynamic/records.ts` can pass
 * database rows straight in without a mapping step that could drift.
 */
export type ValidatableField = {
  apiName: string;
  label: string;
  fieldType: DynamicFieldType;
  isRequired: boolean;
  options: SelectChoice[];
};

export type ValidationOutcome =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; fieldErrors: Record<string, string[]> };

/* ------------------------------------------------------------------ */
/* PRIMITIVE COERCIONS                                                 */
/* ------------------------------------------------------------------ */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
/** Digits with the punctuation a phone number is written with, nothing else. */
const PHONE_PATTERN = /^\+?[0-9][0-9 ()\-.]{4,24}$/;
/** ISO-8601 calendar day. Range-checked below, because 2024-02-31 matches. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A whole number, optionally negative. No exponent, no decimal point. */
const INTEGER_PATTERN = /^-?\d{1,25}$/;
/** An exact decimal. No exponent — `1e400` is `Infinity` before it is a number. */
const DECIMAL_PATTERN = /^-?\d{1,28}(\.\d{1,10})?$/;

class ValueError extends Error {}

function reject(message: string): never {
  throw new ValueError(message);
}

/**
 * ⭐ MONEY. THE ONLY CONVERSION IN THIS FILE THAT LOSES DATA IF IT IS
 * WRONG, AND THE ONE PEOPLE GET WRONG.
 *
 * The wire format is MINOR UNITS — paise — as an integer or an integer
 * string. ₹1,250.50 arrives as `125050`. That is the house rule since
 * Phase 4 and it is not negotiable here.
 *
 * ⚠️ A FLOAT IS REFUSED RATHER THAN ROUNDED. `1250.5` almost certainly
 * means "₹1250.50 in the wrong unit", and the two readings differ by a
 * factor of a hundred. Rounding picks one silently; refusing makes the
 * caller say which they meant. The message says both.
 *
 * ⚠️ `Number` IS NEVER USED. `Number("9007199254740993")` is
 * 9007199254740992 — off by one paisa, silently, above 2^53. The parse is
 * a regex and a `BigInt`, and nothing in between is a JavaScript number.
 */
export function parseMinorUnits(raw: unknown, label: string): bigint {
  if (typeof raw === "bigint") return boundMinorUnits(raw, label);

  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      reject(
        `${label} must be a whole number of paise. ${raw} has a decimal part — ` +
          `if you meant ₹${raw}, send ${Math.round(raw * 100)}. Money is never ` +
          `rounded on our side, because "₹1250.50" and "1250.50 paise" differ ` +
          `by a factor of a hundred and only you know which you meant.`,
      );
    }
    if (!Number.isSafeInteger(raw)) {
      reject(
        `${label} is too large to have arrived accurately as a number. Send it ` +
          `as a string instead — above 9,007,199,254,740,992 a JavaScript ` +
          `number silently loses the last paise.`,
      );
    }
    return boundMinorUnits(BigInt(raw), label);
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!INTEGER_PATTERN.test(trimmed)) {
      reject(
        `${label} must be a whole number of paise, written as digits — for ` +
          `example 125050 for ₹1,250.50. Currency symbols, commas and decimal ` +
          `points are refused rather than stripped.`,
      );
    }
    return boundMinorUnits(BigInt(trimmed), label);
  }

  return reject(`${label} must be a whole number of paise.`);
}

function boundMinorUnits(value: bigint, label: string): bigint {
  // ⚠️ A `bigint` column RAISES on overflow rather than wrapping, which
  // sounds safe until it happens inside a transaction that has already
  // written six other rows. Bounding here means the refusal names the
  // field instead of naming the column.
  if (value > MAX_CURRENCY_MINOR_UNITS || value < -MAX_CURRENCY_MINOR_UNITS) {
    reject(`${label} is outside the range this system can hold.`);
  }
  return value;
}

function parseText(raw: unknown, label: string, max: number): string {
  if (typeof raw !== "string") reject(`${label} must be text.`);
  const trimmed = raw.trim();
  // ⚠️ Measured in characters here and not bytes, unlike identifiers.
  // A `text` column has no length limit in PostgreSQL, so nothing is
  // truncated — the cap is a product decision about what a field is for,
  // and telling a person "500 characters" when the box counts characters
  // is the honest unit.
  if (trimmed.length > max) {
    reject(`${label} may be at most ${max} characters (this is ${trimmed.length}).`);
  }
  return trimmed;
}

function parseBoolean(raw: unknown, label: string): boolean {
  if (typeof raw === "boolean") return raw;
  // Form posts and CSV imports both send strings. "false" is TRUE under
  // JavaScript's own coercion, which is the single most common way a
  // boolean ends up inverted.
  if (raw === "true" || raw === "1" || raw === 1) return true;
  if (raw === "false" || raw === "0" || raw === 0) return false;
  return reject(`${label} must be yes or no.`);
}

function parseDate(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !DATE_PATTERN.test(raw.trim())) {
    reject(`${label} must be a date written as YYYY-MM-DD.`);
  }
  const trimmed = raw.trim();
  const [y, m, d] = trimmed.split("-").map(Number);
  // ⚠️ The regex matches 2024-02-31 and 2024-13-01. `Date.UTC` normalises
  // both into a neighbouring month rather than failing, so the round trip
  // is what actually catches them.
  const parsed = new Date(Date.UTC(y!, m! - 1, d!));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m! - 1 ||
    parsed.getUTCDate() !== d
  ) {
    reject(`${label} is not a real date.`);
  }
  return trimmed;
}

function parseDateTime(raw: unknown, label: string): string {
  if (typeof raw !== "string") reject(`${label} must be a date and time.`);
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    reject(`${label} must be a date and time — ISO-8601, for example 2026-04-01T09:30:00Z.`);
  }
  // Normalised to UTC on the way in. A `timestamptz` column stores an
  // instant regardless, and normalising means the value in the audit log
  // reads the same as the value in the column.
  return parsed.toISOString();
}

function parseNumber(raw: unknown, label: string): string {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) reject(`${label} must be a number.`);
    return String(raw);
  }
  if (typeof raw === "string" && DECIMAL_PATTERN.test(raw.trim())) return raw.trim();
  return reject(
    `${label} must be a number — digits with at most one decimal point, and ` +
      `no exponent. Exponent notation is refused because "1e400" becomes ` +
      `Infinity before anything has a chance to complain about it.`,
  );
}

/**
 * ⭐ A UUID, AND NOTHING ELSE, FOR A RELATION.
 *
 * The composite foreign key is what actually stops a cross-tenant link
 * (see `field-types.ts`), and it fires inside the transaction. This is
 * the shape check in front of it, so that "not a uuid" is a form error
 * and not a Postgres exception that rolls back six other fields.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseUuid(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw.trim())) {
    reject(`${label} must be a record this workspace can see.`);
  }
  return (raw as string).trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* THE DISPATCHER                                                      */
/* ------------------------------------------------------------------ */

/**
 * Coerce ONE value for ONE field. Throws `ValueError` with a sentence.
 *
 * ⚠️ THE `switch` IS EXHAUSTIVE AND THE `default` THROWS. TypeScript
 * proves the first half at compile time; the `default` covers the case
 * where a `dynamic_field_type` value arrives from the database that this
 * build has never heard of — which happens exactly once, during a
 * rollback to a previous release after a new type was added. Silently
 * storing it as text would corrupt the column.
 */
export function coerceValue(field: ValidatableField, raw: unknown): unknown {
  const label = field.label || field.apiName;

  switch (field.fieldType) {
    case "text":
      return parseText(raw, label, MAX_TEXT_LENGTH);

    case "long_text":
      return parseText(raw, label, MAX_LONG_TEXT_LENGTH);

    case "number":
      return parseNumber(raw, label);

    case "currency":
      // ⚠️ Returned as a STRING, not a bigint. `node-postgres` has no
      // serialiser for `BigInt` and would send `[object BigInt]`; the
      // decimal string is what a `bigint` column parses exactly.
      return parseMinorUnits(raw, label).toString();

    case "boolean":
      return parseBoolean(raw, label);

    case "date":
      return parseDate(raw, label);

    case "datetime":
      return parseDateTime(raw, label);

    case "email": {
      const value = parseText(raw, label, MAX_TEXT_LENGTH).toLowerCase();
      if (!EMAIL_PATTERN.test(value)) reject(`${label} must be an email address.`);
      return value;
    }

    case "phone": {
      const value = parseText(raw, label, 30);
      if (!PHONE_PATTERN.test(value)) {
        reject(
          `${label} must be a phone number — digits, optionally with +, ` +
            `spaces, brackets, dots or hyphens.`,
        );
      }
      // ⚠️ NOT normalised to E.164. Doing that needs a region, this
      // product runs in one country today and will not tomorrow, and a
      // wrong region silently rewrites somebody's phone number.
      return value;
    }

    case "url": {
      const value = parseText(raw, label, MAX_TEXT_LENGTH);
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return reject(`${label} must be a link starting with http:// or https://.`);
      }
      // ⚠️ SCHEME ALLOWLIST. `javascript:` and `data:` in an href that the
      // product later renders is stored cross-site scripting, and the
      // place to refuse it is before it is stored, not in every component
      // that might display it.
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        reject(
          `${label} must start with http:// or https://. Other schemes — ` +
            `javascript:, data:, file: — are refused because a link is ` +
            `eventually rendered as one.`,
        );
      }
      return parsed.toString();
    }

    case "select": {
      const value = parseText(raw, label, 60);
      const allowed = field.options.map((o) => o.value);
      if (!allowed.includes(value)) {
        reject(
          `${label} must be one of: ${allowed.join(", ") || "(no choices defined)"}.`,
        );
      }
      return value;
    }

    case "multi_select": {
      if (!Array.isArray(raw)) reject(`${label} must be a list of choices.`);
      if (raw.length > MAX_MULTI_SELECT_VALUES) {
        reject(`${label} may hold at most ${MAX_MULTI_SELECT_VALUES} choices.`);
      }
      const allowed = new Set(field.options.map((o) => o.value));
      const out: string[] = [];
      for (const item of raw) {
        if (typeof item !== "string" || !isValidSelectValue(item) || !allowed.has(item)) {
          reject(`${label} contains a choice that is not on its list: "${String(item)}".`);
        }
        // Silently de-duplicated. A picker that sends the same tag twice
        // is a UI bug, and refusing the whole write over it helps nobody.
        if (!out.includes(item as string)) out.push(item as string);
      }
      return out;
    }

    case "relation":
      return parseUuid(raw, label);

    default: {
      const exhaustive: never = field.fieldType;
      return reject(
        `${label} has a field type this version of the application does not ` +
          `understand ("${String(exhaustive)}"). Refusing to write rather than ` +
          `guessing — this usually means the database is ahead of the code.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* WHOLE-RECORD VALIDATION                                             */
/* ------------------------------------------------------------------ */

/**
 * Validate a whole record against its field list.
 *
 * ⚠️ UNKNOWN KEYS ARE REFUSED, NOT IGNORED.
 *
 * Ignoring them is friendlier and it is wrong twice. A typo (`emial`)
 * silently discards what somebody typed and the form reports success. And
 * a caller probing for `tenant_id`, `id` or `created_by` learns nothing
 * from a refusal and learns "that key is not rejected" from a success —
 * which is the first half of finding the one write path that forgot to
 * filter.
 *
 * ⚠️ EVERY FIELD IS CHECKED BEFORE ANYTHING IS REPORTED. The alternative
 * — throw on the first bad value — makes a form with four mistakes take
 * four round trips, and people fix the fourth one by giving up.
 *
 * @param mode `create` applies required-field rules. `update` is a PATCH:
 *   absent means "leave it alone", and requiring a field the caller was
 *   not editing would make it impossible to change anything else.
 *   ⚠️ An EXPLICIT null on a required field is still refused in both
 *   modes — that is a caller asking to clear it.
 */
export function validateRecordValues(
  fields: ValidatableField[],
  input: Record<string, unknown>,
  mode: "create" | "update",
): ValidationOutcome {
  const fieldErrors: Record<string, string[]> = {};
  const values: Record<string, unknown> = {};
  const byName = new Map(fields.map((f) => [f.apiName, f]));

  for (const key of Object.keys(input)) {
    if (!byName.has(key)) {
      fieldErrors[key] = [
        `"${key}" is not a field on this record type. Unknown values are ` +
          `refused rather than dropped, so a mistyped field name is visible ` +
          `instead of silently losing what you entered.`,
      ];
    }
  }

  for (const field of fields) {
    const present = Object.prototype.hasOwnProperty.call(input, field.apiName);
    const raw = input[field.apiName];

    if (!present) {
      if (mode === "create" && field.isRequired) {
        fieldErrors[field.apiName] = [`${field.label || field.apiName} is required.`];
      }
      continue;
    }

    if (raw === null || raw === undefined || raw === "") {
      if (field.isRequired) {
        fieldErrors[field.apiName] = [
          `${field.label || field.apiName} is required and cannot be cleared.`,
        ];
        continue;
      }
      values[field.apiName] = null;
      continue;
    }

    try {
      values[field.apiName] = coerceValue(field, raw);
    } catch (err) {
      fieldErrors[field.apiName] = [
        err instanceof ValueError ? err.message : `${field.label} is not valid.`,
      ];
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, values };
}
