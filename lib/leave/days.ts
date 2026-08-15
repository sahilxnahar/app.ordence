/**
 * Ordence — ⭐⭐ LEAVE, THE UNIT OF ACCOUNT
 * Version: v1.46.0-alpha · Batch 59
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY DAYS ARE INTEGERS IN HERE AND STRINGS EVERYWHERE ELSE
 * ══════════════════════════════════════════════════════════════════════
 * A leave balance is added up dozens of times a year, half a day at a
 * time, and then read out to the person whose days they are. Doing that
 * in IEEE-754 doubles produces `12.299999999999999` on a completely
 * ordinary sequence of half days, and there is no way to explain that
 * number to anybody. It is the same failure money has, and it gets the
 * same treatment money gets in this codebase:
 *
 *   MONEY   `numeric(18,0)` in Postgres  ↔  `bigint` paise in TypeScript
 *   DAYS    `numeric(7,2)`  in Postgres  ↔  `number` CENTIDAYS in TS
 *
 * ⭐ A CENTIDAY IS ONE HUNDREDTH OF A DAY, and every arithmetic function
 * in `lib/leave/*` takes and returns them. `number` rather than `bigint`
 * is safe here in a way it is not for money: a balance measured in
 * centidays would have to exceed 90,071,992,547,409 days to leave the
 * safe integer range, and the CHECK constraints cap a leave type at 365
 * days a year.
 *
 * ⚠️ THE CONVERSION HAPPENS EXACTLY TWICE — reading a row and writing
 * one. Anything in between that handles a `"2.50"` is a bug, and anything
 * that handles a `2.5` is a worse one.
 */

/** One hundredth of a day. The unit every function in `lib/leave` uses. */
export type Centidays = number;

/**
 * 🔴 PARSES THE STRING DRIZZLE HANDS BACK FROM A `numeric`, AND REFUSES
 * ANYTHING IT DOES NOT UNDERSTAND.
 *
 * ⚠️ THE TEMPTING IMPLEMENTATION IS `Math.round(parseFloat(s) * 100)`.
 * It is correct for every value this product will ever store, and it is
 * correct BY LUCK: `parseFloat("0.07") * 100` is 7.000000000000001 and
 * rounds right, `parseFloat("8.115") * 100` is 811.4999999999999 and does
 * not. Splitting on the decimal point never touches a float at all.
 *
 * Returns `null` for anything that is not a decimal number, so a caller
 * can report a bad row rather than silently treating it as zero — a
 * silent zero in a leave ledger reads as "you have no leave".
 */
export function parseDays(value: string | number | null | undefined): Centidays | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;

  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] === "" ? 0 : Number(m[2]);
  /* ⚠️ Pad, do not parse: ".5" is fifty centidays, not five. */
  const frac = (m[3] ?? "").padEnd(2, "0").slice(0, 2);
  const hundredths = frac === "" ? 0 : Number(frac);
  if (!Number.isFinite(whole) || !Number.isFinite(hundredths)) return null;

  return sign * (whole * 100 + hundredths);
}

/**
 * ⚠️ THE SAME PARSE, BUT A BAD VALUE IS A ZERO.
 *
 * 🔴 USE THIS ONLY WHERE A MISSING ROW GENUINELY MEANS NOTHING HAPPENED —
 * summing a ledger, where the column is `NOT NULL` and a null can only
 * mean the query did not select it. Never on user input.
 */
export function parseDaysOrZero(value: string | number | null | undefined): Centidays {
  return parseDays(value) ?? 0;
}

/**
 * ⭐ BACK TO THE STRING POSTGRES WANTS, WITH EXACTLY TWO DECIMALS AND NO
 * FLOAT IN SIGHT.
 */
export function formatDays(centidays: Centidays): string {
  const n = Math.trunc(centidays);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * ⭐ HOW A HUMAN READS IT. `1.00` is "1 day", `0.50` is "half a day",
 * `2.50` is "2.5 days".
 *
 * ⚠️ NOT `toFixed(2)` EVERYWHERE. "You have 12.00 days" is a machine
 * talking; the trailing zeros are noise on the one screen in this module
 * an ordinary employee actually reads.
 */
export function describeDays(centidays: Centidays): string {
  if (centidays === 50) return "half a day";
  if (centidays === 100) return "1 day";
  const whole = centidays % 100 === 0;
  const text = whole ? String(centidays / 100) : (centidays / 100).toFixed(2).replace(/0$/, "");
  return `${text} days`;
}

/**
 * 🔴 ROUNDING TO A GRANULARITY, HALF AWAY FROM ZERO.
 *
 * ⚠️ `Math.round` IS HALF-UP TOWARDS POSITIVE INFINITY, so it rounds
 * −0.5 to −0 and +0.5 to +1. On a signed ledger that means a debit and a
 * credit of the same size round differently and a balance that should
 * net to zero does not. Away-from-zero keeps the two symmetric.
 *
 * `granularity` of 0 means no rounding at all, which is a legitimate
 * policy and the reason `accrual_round_to_days` permits it.
 */
export function roundToGranularity(
  centidays: Centidays,
  granularityCentidays: Centidays,
): Centidays {
  if (granularityCentidays <= 0) return Math.trunc(centidays);
  const q = centidays / granularityCentidays;
  const rounded = q < 0 ? -Math.round(-q) : Math.round(q);
  return rounded * granularityCentidays;
}

/**
 * ⭐ INCLUSIVE DAY COUNT BETWEEN TWO ISO DATES, IN CIVIL DAYS.
 *
 * ⚠️ `Date.UTC` AND NOT `new Date(iso)`. The latter is parsed in the
 * runtime's local zone for some formats, and a server in Asia/Kolkata and
 * a server in UTC would disagree about whether a leave period contains
 * 31 March — which is the day the whole leave year turns on.
 */
export function inclusiveDayCount(fromIso: string, toIso: string): number {
  const a = utcDay(fromIso);
  const b = utcDay(toIso);
  if (a === null || b === null) return 0;
  const days = Math.round((b - a) / 86_400_000) + 1;
  return days < 0 ? 0 : days;
}

/** UTC midnight for an ISO `YYYY-MM-DD`, or null if it is not one. */
export function utcDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** ISO `YYYY-MM-DD` for a UTC millisecond value. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * ⭐ THE OVERLAP OF TWO INCLUSIVE DATE RANGES, IN DAYS.
 *
 * This is the whole of the mid-year-joiner answer: the days an employee
 * was on the rolls INSIDE a leave period is the overlap of
 * (joined, left) with (period start, period end). Everything about
 * pro-rating an entitlement follows from it, and writing it once means
 * the joiner case and the leaver case cannot drift apart.
 */
export function overlapDays(
  aFrom: string,
  aTo: string,
  bFrom: string,
  bTo: string,
): number {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  if (from > to) return 0;
  return inclusiveDayCount(from, to);
}

/** Adds whole days to an ISO date, staying in UTC. */
export function addDays(iso: string, days: number): string {
  const base = utcDay(iso);
  if (base === null) return iso;
  return isoDay(base + days * 86_400_000);
}

/** The 0-6 weekday (Sunday = 0) of an ISO date, in UTC. */
export function weekdayOf(iso: string): number {
  const base = utcDay(iso);
  if (base === null) return 0;
  return new Date(base).getUTCDay();
}
