/**
 * Ordence — Cell Coercion
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY CELL ARRIVES AS A STRING AND MOST OF THEM MUST NOT STAY ONE
 * ══════════════════════════════════════════════════════════════════════
 * A CSV has exactly one type. Turning `"18"` into a number, `"yes"` into
 * `true` and `"1,250.50"` into paise is the entire job of this file, and
 * every one of those conversions has a wrong version that looks right.
 *
 * ⚠️ NOTHING HERE THROWS. A coercion failure is a fact about ONE cell in
 * one row, and the framework's whole premise (constraint 2 — partial
 * success is the default) is that one bad cell must not end the run. A
 * thrown error would have to be caught per cell anyway; returning a
 * result makes that explicit and makes the message the caller's to place.
 *
 * ⚠️ PURE. No I/O, no locale lookups, no `Intl`. Same input, same output,
 * on the server during a commit and in the browser during a preview.
 */

export type CoercionResult =
  | { ok: true; value: string | number | boolean | null }
  | { ok: false; message: string };

/** An empty cell is `null`, never `""`. See `blankIsNull` below. */
const NOTHING: CoercionResult = { ok: true, value: null };

/**
 * ⚠️ A BLANK CELL IS "NOT SUPPLIED", NOT "SET IT TO EMPTY STRING".
 *
 * The distinction decides what an UPDATE does. `""` written into
 * `companies.domain` makes the column an empty string, which is not NULL,
 * which means the partial unique index on `(tenant_id, domain)` now has a
 * second workspace-wide value that every subsequent blank-domain import
 * collides with. `null` is the only correct reading of an empty cell.
 */
function blankIsNull(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export function coerceText(raw: string, maxLength?: number): CoercionResult {
  const value = blankIsNull(raw);
  if (value === null) return NOTHING;
  if (maxLength !== undefined && value.length > maxLength) {
    return {
      ok: false,
      message: `This is ${value.length} characters; the limit is ${maxLength}.`,
    };
  }
  return { ok: true, value };
}

/**
 * A whole number.
 *
 * ⚠️ NOT `Number(raw)`. `Number("")` is 0, `Number(" 12 ")` is 12,
 * `Number("12abc")` is NaN and `Number("1e3")` is 1000. Only one of those
 * four is the behaviour anybody wants from a spreadsheet cell, so the
 * shape is checked with a regular expression first and the conversion
 * happens only on something already known to be an integer.
 *
 * Thousands separators are accepted and stripped because Excel writes
 * them by default when the column is formatted as a number, and a
 * customer cannot see the difference between `1200` and `1,200` on
 * screen.
 */
export function coerceInteger(
  raw: string,
  bounds?: { min?: number; max?: number },
): CoercionResult {
  const value = blankIsNull(raw);
  if (value === null) return NOTHING;

  const cleaned = value.replace(/,/g, "");
  if (!/^-?\d+$/.test(cleaned)) {
    return { ok: false, message: `"${value}" is not a whole number.` };
  }

  const n = Number(cleaned);
  if (!Number.isSafeInteger(n)) {
    return { ok: false, message: `"${value}" is too large to be a count.` };
  }
  if (bounds?.min !== undefined && n < bounds.min) {
    return { ok: false, message: `Must be ${bounds.min} or more.` };
  }
  if (bounds?.max !== undefined && n > bounds.max) {
    return { ok: false, message: `Must be ${bounds.max} or less.` };
  }
  return { ok: true, value: n };
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 MONEY. RUPEES IN THE FILE, PAISE ON THE WIRE, NEVER A FLOAT.
 * ══════════════════════════════════════════════════════════════════════
 * The obvious implementation is `Math.round(Number(raw) * 100)` and it is
 * wrong in a way that does not show up in testing with round numbers:
 *
 *     Math.round(Number("1.005") * 100)  ->  100      (should be 101)
 *
 * because `1.005 * 100` evaluates to `100.49999999999999`. Binary
 * floating point cannot hold 1.005, so the multiplication is performed on
 * a number slightly BELOW it and the rounding goes down. Every amount
 * ending in half a paisa is a paisa short, in the customer's favour on
 * some rows and against them on others, and the error is invisible until
 * a reconciliation months later fails by a few rupees across ten thousand
 * imported rows with no single row obviously wrong.
 *
 * The string is split on the decimal point instead — the arithmetic is
 * done in `BigInt`, which cannot lose a digit it never converted. This is
 * the same discipline as `parseMoney` in `lib/billing/money.ts` and
 * `rupeesToPaise` in `components/orders/new-order-form.tsx`; it is
 * restated here rather than imported because `parseMoney` THROWS, and a
 * throw is the one thing this module must not do (see the header).
 *
 * ⚠️ THE RESULT IS A STRING OF MINOR UNITS, NOT A BIGINT.
 *
 * The coerced value travels from a server action to the browser inside
 * the preview report. `JSON.stringify` throws outright on a bigint —
 * `TypeError: Do not know how to serialize a BigInt` — so a bigint here
 * would make the whole report unserialisable. `server/actions/gst.ts`
 * documents the same constraint and reaches the same answer. The caller
 * that writes to a `bigint` column converts once, at the insert.
 *
 * ⚠️ AND WHY THIS EXISTS BEFORE EITHER SEED ENTITY HAS A MONEY COLUMN.
 * Neither `companies` nor `gst_parties` carries an amount today. The next
 * three importers anybody asks for do: opening balances, price lists, and
 * `credit_limits.credit_limit_minor`. Written then, under the pressure of
 * "we just need the customer's credit limits loaded", the line that gets
 * written is `Number(x) * 100` — because it is shorter, it passes every
 * hand-written test, and the person writing it has not read this comment.
 * Establishing the coercion as part of the framework contract, tested,
 * before the first caller, is the cheapest moment this decision is ever
 * available.
 */
/**
 * ⭐ WAVE 2C — THE MESSAGE STOPPED LYING.
 *
 * 🔴 IT USED TO SAY, FOR EVERY CURRENCY IN THE WORLD: *"Write it as
 * rupees with up to 2 decimal places."* Shown to a Kuwaiti workspace
 * about a perfectly good `1.234`, that sentence does active harm — the
 * customer believes it, deletes the third digit, and turns 1.234 dinars
 * into 1.230. The importer would then accept it silently, so the damage
 * is a wrong number in a ledger rather than a failed import.
 *
 * ⚠️ THE EXAMPLE IS GENERATED FROM THE EXPONENT rather than hardcoded,
 * because "for example 1250.50" is itself unwritable in JPY.
 */
export function describeAmountRefusal(
  value: string,
  exponent: number,
  code?: string,
): string {
  const named = code ? `a valid amount in ${code}` : "an amount";
  const example =
    exponent === 0 ? "1250" : `1250.${"5".padEnd(exponent, "0")}`;
  const places =
    exponent === 0
      ? `${code ?? "This currency"} has no decimal places — write whole units, for example ${example}`
      : `Write it with up to ${exponent} decimal place${exponent === 1 ? "" : "s"}, for example ${example}`;
  return `"${value}" is not ${named}. ${places} — no symbol needed.`;
}

/**
 * ⭐⭐⭐ WAVE 2C — THE EXPONENT IS REQUIRED, AND THE DEFAULT IS GONE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS PARAMETER'S DEFAULT CAUSED
 * ══════════════════════════════════════════════════════════════════════
 * The signature was `(raw: string, exponent = 2)`. `lib/import/plan.ts`
 * line 94 read `coerceMoneyMinor(raw)`, and so EVERY money column in the
 * product was coerced at two decimal places:
 *
 *     "1.234" -> refused: "is not an amount ... up to 2 decimal places"
 *     "1234"  -> 123400
 *
 * `1.234` in KWD is 1,234 fils and is an ordinary amount. `1234` in JPY
 * is ¥1,234 and became ¥123,400. The FUNCTION was right the whole time
 * and the CALLER never passed anything.
 *
 * ⚠️ SO THE DEFAULT IS REMOVED RATHER THAN THE CALLER MERELY FIXED. A
 * default of 2 is not a convenience, it is a wrong answer available for
 * free: the next caller written under time pressure omits the argument
 * and reintroduces this exact bug with no diagnostic anywhere. Required,
 * so the omission is a compile error — which is the standard the writer
 * registry (a destination with no writer is a compile error) already
 * sets in this framework.
 *
 * ⚠️ `code` IS FOR THE MESSAGE AND NOTHING ELSE. The arithmetic is
 * driven by `exponent` alone, so this function stays free of the
 * currency table and can be called with a bare exponent by
 * `coerceQuantityThousandths`, which is not money at all.
 */
export function coerceMoneyMinor(
  raw: string,
  exponent: number,
  code?: string,
): CoercionResult {
  const value = blankIsNull(raw);
  if (value === null) return NOTHING;

  // Thousands separators, a currency symbol and spaces are all things a
  // spreadsheet puts there on the customer's behalf.
  const cleaned = value.replace(/[,\s]/g, "").replace(/^₹|^Rs\.?/i, "");

  const pattern =
    exponent === 0
      ? /^-?\d{1,15}$/
      : new RegExp(`^-?\\d{1,15}(?:\\.\\d{1,${exponent}})?$`);

  if (!pattern.test(cleaned)) {
    return {
      ok: false,
      message: describeAmountRefusal(value, exponent, code),
    };
  }

  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  const scale = 10n ** BigInt(exponent);
  const padded = exponent === 0 ? "0" : fraction.padEnd(exponent, "0");

  const magnitude = BigInt(whole) * scale + BigInt(padded || "0");
  return { ok: true, value: String(negative ? -magnitude : magnitude) };
}

/**
 * ⚠️ A SPREADSHEET HAS NO BOOLEAN, SO THE VOCABULARY IS WIDE ON PURPOSE.
 *
 * Excel writes `TRUE`, Google Sheets writes `TRUE`, a human types `yes`,
 * an export from another CRM writes `1`, and an Indian user may well type
 * `Y`. Accepting only `true`/`false` means most files fail a column the
 * customer filled in correctly by any reasonable reading.
 *
 * What is NOT accepted is anything outside the list — in particular a
 * blank is `null` (not supplied) rather than `false`, because defaulting
 * an unfilled flag to "off" silently deactivates records.
 */
const TRUE_WORDS = new Set(["true", "yes", "y", "1", "t", "on", "active"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "f", "off", "inactive"]);

export function coerceBoolean(raw: string): CoercionResult {
  const value = blankIsNull(raw);
  if (value === null) return NOTHING;

  const word = value.toLowerCase();
  if (TRUE_WORDS.has(word)) return { ok: true, value: true };
  if (FALSE_WORDS.has(word)) return { ok: true, value: false };

  return {
    ok: false,
    message: `"${value}" is not a yes or no. Use yes/no, true/false or 1/0.`,
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A CALENDAR DAY AS A STRING, AND ONLY ONE FORMAT IS ACCEPTED.
 * ══════════════════════════════════════════════════════════════════════
 * `new Date("01/02/2026")` parses without complaint and means 2 January
 * in India and 1 February in the United States. Both are valid readings
 * of the same eight characters, nothing in the file says which was meant,
 * and the consequence in this product is not cosmetic: `gst_parties`
 * rows are DATED, and `effective_from` decides whether a supply on a
 * given day was B2B or B2C. Guessing wrong moves an invoice between
 * tax treatments.
 *
 * So DD/MM/YYYY is refused rather than guessed, and the message says
 * exactly what to write. ISO order is also the only format that sorts
 * correctly as text, which is what the column is compared as in SQL.
 *
 * ⚠️ AND IT STAYS A STRING. `lib/validators/gst.ts` says why at length:
 * a `Date` carries a time, and `2019-03-31T20:00:00Z` is 1 April in
 * Mumbai — one timezone conversion away from the wrong side of a rate
 * change.
 */
export function coerceCivilDay(raw: string): CoercionResult {
  const value = blankIsNull(raw);
  if (value === null) return NOTHING;

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    return {
      ok: false,
      message:
        `"${value}" is not a date this can read. Write it as YYYY-MM-DD, for ` +
        `example 2026-04-01. Day-first and month-first dates are refused ` +
        `rather than guessed — 01/02/2026 is two different days.`,
    };
  }

  // A shape check is not a calendar check: 2026-02-31 matches the regex.
  const [, y = "", mo = "", d = ""] = m;
  const probe = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  const roundTrips =
    probe.getUTCFullYear() === Number(y) &&
    probe.getUTCMonth() + 1 === Number(mo) &&
    probe.getUTCDate() === Number(d);

  if (!roundTrips) {
    return { ok: false, message: `"${value}" is not a real date.` };
  }

  return { ok: true, value };
}

/**
 * One of a fixed set.
 *
 * ⚠️ MATCHED CASE- AND PUNCTUATION-INSENSITIVELY, RETURNED CANONICALLY.
 * The database enum is `immovable_property`; the customer's spreadsheet
 * says `Immovable Property`. Refusing that is refusing a correct answer
 * over its formatting. The value stored is always the canonical one.
 *
 * The failure message LISTS the accepted values. An enum error that says
 * only "invalid value" leaves the customer guessing at a vocabulary that
 * exists in full, in this file, for free.
 */
export function coerceEnum(raw: string, allowed: readonly string[]): CoercionResult {
  const value = blankIsNull(raw);
  if (value === null) return NOTHING;

  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = normalise(value);
  const match = allowed.find((a) => normalise(a) === target);

  if (!match) {
    return {
      ok: false,
      message: `"${value}" is not one of: ${allowed.join(", ")}.`,
    };
  }
  return { ok: true, value: match };
}
