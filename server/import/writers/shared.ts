/**
 * Ordence — helpers shared by every writer
 * Version: v1.85.0-alpha · Phase 1
 *
 * ⚠️ MOVED FROM `server/actions/import.ts`, VERBATIM. These were local to
 * that file when every destination was an `if` branch inside it. With the
 * destinations in modules they need one home, and one home is this file ,
 * not a copy in each writer, which is how two writers end up disagreeing
 * about what a duplicate-key error means.
 */

import "server-only";

import { or, sql, type SQL } from "drizzle-orm";

/**
 * OR together the predicates that are actually present.
 *
 * ⚠️ AN EMPTY LIST MUST BECOME `false`, NEVER `true`. Drizzle's `or()`
 * with nothing in it returns `undefined`, which `and()` then drops — and
 * a dropped predicate here would turn "find the rows matching these
 * keys" into "find every row in the table". The caller returns early when
 * both lists are empty, and this is the second layer that makes the
 * mistake impossible rather than merely unlikely.
 */
export function matchAny(parts: Array<SQL | undefined | null>): SQL {
  const present = parts.filter((p): p is SQL => p !== null && p !== undefined);
  if (present.length === 0) return sql`false`;
  return or(...present) ?? sql`false`;
}

/** Minor units held as a digit string, as the coercion layer produces them. */
export function minorOf(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || value.trim() === "") return 0n;
  /*
   * 🔴 NEVER `Number(value)`. These are paise and routinely run past
   * 2^53 — a crore of rupees is 10^9 paise and a balance-sheet total is
   * a hundred times that. `BigInt` of a digit string cannot lose a digit
   * it never converted.
   */
  return BigInt(value);
}

/**
 * Integer thousandths to the `numeric(18,3)` literal Postgres wants.
 *
 * ⚠️ ASSEMBLED FROM THE QUOTIENT AND THE REMAINDER, never
 * `Number(n) / 1000`. That division is exact for small numbers and
 * silently lossy for large ones, and the symptom is a stock ledger that
 * is a fraction out on the movements nobody looks at.
 */
export function thousandthsToDecimal(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 1000n;
  const fraction = magnitude % 1000n;
  return `${negative ? "-" : ""}${whole.toString()}.${fraction.toString().padStart(3, "0")}`;
}

/**
 * ⚠️ THE DATABASE'S OWN SENTENCE, WHERE IT WROTE ONE FOR A PERSON.
 *
 * `server/gst/guards.ts` makes the same argument: the CHECK constraints
 * and triggers in this product raise messages written to be read, and
 * replacing them with a generic string discards the only explanation of
 * a rule nobody understands on first encounter. What is NOT passed
 * through is anything without a recognised SQLSTATE — an unexpected error
 * could carry internals, and a row-level message ends up in a CSV the
 * customer may forward.
 */
export function describeWriteFailure(err: unknown): string {
  const candidate = err as { code?: unknown; constraint?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : null;
  const constraint =
    typeof candidate?.constraint === "string" ? candidate.constraint : "";

  if (code === "23505") {
    return (
      `The database already has a record this would collide with (${constraint || "unique constraint"}). ` +
      `Another user may have created it since the preview ran.`
    );
  }
  if (code === "23514" && typeof candidate.message === "string") {
    return candidate.message.replace(/^error:\s*/i, "").split("\nCONTEXT:")[0] ?? "Refused.";
  }
  if (code === "23503") {
    return "Something this row refers to no longer exists.";
  }

  console.error("[import:writeRow]", err);
  return "This row was refused by the database and has not been imported.";
}

