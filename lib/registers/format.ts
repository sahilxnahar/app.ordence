/**
 * Ordence — Register formatting: paise in, string out, no float in between
 * Version: v1.50.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 MONEY NEVER LEAVES BIGINT ARITHMETIC, INCLUDING ON THE WAY TO THE
 *    PAGE
 * ══════════════════════════════════════════════════════════════════════
 * The usual leak is not in the calculation — it is in the display.
 * `(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })`
 * looks harmless, and it is a `Number()` on a money value with extra
 * steps. At ₹90,07,199.25 crore it starts losing paise, which nobody
 * will ever hit; the reason to refuse it anyway is that the habit is
 * what reaches the salary that IS large enough, and a register is
 * precisely the document where a rounded figure gets noticed by somebody
 * with a statutory power to act on it.
 *
 * ⭐ So the grouping is done on the DIGIT STRING of a bigint. There is
 * no division, no `Number`, and no `Intl` anywhere in this file.
 *
 * ⚠️ INDIAN GROUPING IS NOT WESTERN GROUPING. ₹12,34,567.89, not
 * ₹1,234,567.89 — last three digits, then twos. Getting this wrong makes
 * a lakh look like a hundred thousand to a reader who reads by shape.
 */

/* ------------------------------------------------------------------ */
/* PARSING WHAT THE DATABASE HANDS BACK                                */
/* ------------------------------------------------------------------ */

/**
 * `numeric(18,0)` arrives from Drizzle as a string. It should be pure
 * digits with an optional sign.
 *
 * 🔴 RETURNS `null` ON ANYTHING ELSE RATHER THAN THROWING OR COERCING.
 * A register that cannot read one figure must print a blank in that one
 * cell and say so, not fail the whole document and not print a zero. A
 * zero here is the exact defect this batch is about: it would state that
 * an employee was deducted nothing.
 *
 * ⚠️ A TRAILING `.00` IS ACCEPTED AND ONLY WHEN IT IS ZEROES. Some
 * drivers and some views widen a numeric on the way out. A non-zero
 * fraction on a paise column means the column is not paise, and that is
 * a fact worth refusing rather than truncating.
 */
export function paiseFromNumeric(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  if (m[2] !== undefined && /[^0]/.test(m[2])) return null;
  try {
    return BigInt(m[1]!);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* FORMATTING                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Paise → "12,34,567.89". No currency symbol: the column heading
 * already says what it is, and a register printed for an inspector wants
 * a clean numeric column.
 */
export function formatPaise(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return `${negative ? "-" : ""}${groupIndian(whole)}.${fraction}`;
}

/**
 * 🔴 THE ONLY PLACE A MONEY CELL IS ALLOWED TO BE EMPTY.
 *
 * `null` in, `null` out — and the renderer prints the "not recorded"
 * marker for it. Every other path returns a formatted number.
 */
export function formatPaiseOrBlank(minor: bigint | null): string | null {
  return minor === null ? null : formatPaise(minor);
}

/** Last three digits, then groups of two. Pure string work. */
function groupIndian(whole: string): string {
  const trimmed = whole.replace(/^0+(?=\d)/, "");
  if (trimmed.length <= 3) return trimmed;
  const lastThree = trimmed.slice(-3);
  const rest = trimmed.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`;
}

/* ------------------------------------------------------------------ */
/* DAYS                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ DAYS ARE `numeric(6,2)` / `numeric(7,2)` AND ARE HANDLED IN
 * CENTIDAYS — integer hundredths — for the same reason money is handled
 * in paise. `lib/leave/days.ts` already owns that arithmetic and this
 * module borrows it rather than writing a second implementation, because
 * a register that disagrees with the leave screen about a half day is a
 * register nobody trusts again.
 *
 * This wrapper exists only so a register cell can be blank when the
 * value is missing, which `parseDaysOrZero` deliberately never is.
 */
export function centidaysFromNumeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number.parseInt(m[2]!, 10);
  const frac = Number.parseInt((m[3] ?? "0").padEnd(2, "0"), 10);
  return sign * (whole * 100 + frac);
}

/** 250 → "2.5", 100 → "1", 0 → "0". Trailing zeroes trimmed. */
export function formatCentidays(centidays: number): string {
  const negative = centidays < 0;
  const abs = Math.abs(Math.trunc(centidays));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const body =
    frac === 0
      ? String(whole)
      : frac % 10 === 0
        ? `${whole}.${frac / 10}`
        : `${whole}.${String(frac).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

export function formatCentidaysOrBlank(centidays: number | null): string | null {
  return centidays === null ? null : formatCentidays(centidays);
}

/* ------------------------------------------------------------------ */
/* DATES                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ ISO `YYYY-MM-DD` → `DD-MM-YYYY`, which is what every Indian form
 * expects and what an inspector reads without pausing.
 *
 * ⚠️ NO `Date` OBJECT IS CONSTRUCTED. `new Date("2026-03-31")` is parsed
 * as UTC midnight and then formatted in the runtime's zone, so a server
 * running west of Greenwich prints 30 March on the one date in the year
 * the financial year turns on. String surgery cannot do that.
 */
export function formatIsoDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}
