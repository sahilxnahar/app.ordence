/**
 * Ordence — Statement periods
 * Version: v1.43.0-alpha (Batch 37)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE THREE STATEMENTS WERE SINCE-INCEPTION ONLY
 * ══════════════════════════════════════════════════════════════════════
 * `getTrialBalance()` took no arguments and summed every journal entry
 * the tenant had ever posted. The profit & loss and the balance sheet
 * were both derived from that one call, so all three statements were
 * "everything, forever".
 *
 * That is survivable for exactly one year. In year two the customer's
 * P&L shows two years of revenue against two years of cost, which is not
 * a number that appears on any return, in any lender pack, or in any
 * audit file. There was no parameter to pass and no screen to pass it
 * from — the only way to produce a financial-year P&L was to not use the
 * product.
 *
 * This module holds the date arithmetic that fixes that. It is a plain
 * module, not a `"use server"` file, precisely so it can export
 * non-async helpers and be imported by both the server actions and the
 * server components that render the date pickers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A BALANCE SHEET IS A POINT IN TIME, NOT A RANGE
 * ══════════════════════════════════════════════════════════════════════
 * This is the classic error and it is worth stating here, at the top of
 * the module that hands out the dates, because this is where somebody
 * will be tempted to make it.
 *
 * A profit & loss and a trial balance measure MOVEMENT: what happened
 * between two dates. A balance sheet measures a POSITION: what is owned
 * and owed at one instant, and that position is the accumulation of
 * every entry since the business began.
 *
 * So a balance sheet gets an "as at" date and NOTHING ELSE. If you hand
 * it the period's from-date as a filter, you exclude the opening
 * position — the bank balance, the fixed assets, the share capital, the
 * loans — and every asset the business owned before 1 April vanishes.
 * The statement still *balances* (a filtered set of whole transactions
 * always does, because each one balances on its own), so nothing shouts.
 * It just quietly reports a company with no assets.
 *
 * `resolveStatementPeriod` therefore returns `asAt` alongside `from` and
 * `to`, and `asAt === to`. The balance sheet uses `asAt`. It must never
 * be given `from`.
 */

/* ------------------------------------------------------------------ */
/* THE INDIAN FINANCIAL YEAR                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 1 APRIL TO 31 MARCH, NOT JANUARY TO DECEMBER.
 *
 * Everything a customer files against — the income tax return, the tax
 * audit report, the statutory accounts filed with the MCA — is drawn to
 * 31 March. A statement drawn to 31 December agrees with nothing they
 * will ever submit, and the error is invisible on the page: the totals
 * are internally consistent, they are just for the wrong twelve months.
 *
 * ⚠️ WHY THIS IS A LOCAL COPY AND NOT AN IMPORT.
 * `server/payroll/run.ts` has an identical `fyStartFor`. Importing it
 * here would make the accounting statements depend on the payroll
 * module — a change to how payroll defines its year (a customer on a
 * non-standard payroll calendar, say) would silently move the boundary
 * of every P&L in the product. Twelve lines of duplicated date
 * arithmetic is much cheaper than that coupling. If the two ever need to
 * disagree, they can, and neither breaks.
 */
export const FY_START_MONTH = 4; // April, 1-indexed.

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** True for a well-formed `YYYY-MM-DD`. Does not check calendar validity. */
export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value);
}

/**
 * ⭐ THE FIRST DAY OF THE INDIAN FINANCIAL YEAR CONTAINING `date`.
 *
 * January to March belong to the year that STARTED the previous April:
 * 2026-02-14 is in FY 2025-26, which began 2025-04-01.
 */
export function fyStartFor(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= FY_START_MONTH ? year : year - 1;
  return `${startYear}-04-01`;
}

/**
 * ⭐ THE LAST DAY OF THE INDIAN FINANCIAL YEAR CONTAINING `date`.
 *
 * ⚠️ 31 MARCH IS HARD-CODED, DELIBERATELY. Computing it as "the day
 * before the next FY start" invites a Date object into this file, and a
 * Date object invites the timezone bug below. March has 31 days every
 * year; there is nothing to compute.
 */
export function fyEndFor(date: string): string {
  const startYear = Number(fyStartFor(date).slice(0, 4));
  return `${startYear + 1}-03-31`;
}

/** "FY 2025-26" — the label an Indian accountant expects to read. */
export function fyLabelFor(date: string): string {
  const startYear = Number(fyStartFor(date).slice(0, 4));
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * ⚠️ TODAY IN INDIA, NOT TODAY IN UTC.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date. India is
 * UTC+5:30, so between midnight and 05:30 IST it returns YESTERDAY. On
 * one night a year that yesterday is 31 March, and an accountant opening
 * the statements at 2am on 1 April would be shown the closing year
 * rather than the opening one, with no indication that anything odd had
 * happened. On the other 364 nights it is off by a day in a way nobody
 * notices, which is how the bug survives to reach 31 March.
 *
 * `en-CA` is used because it formats as `YYYY-MM-DD`; the locale is a
 * formatting trick, not a statement about the user.
 */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/* ------------------------------------------------------------------ */
/* THE RESOLVED PERIOD                                                 */
/* ------------------------------------------------------------------ */

export type StatementPeriodInput = {
  from?: string | null;
  to?: string | null;
};

export type StatementPeriod = {
  /** Inclusive first day of the P&L / trial balance window. */
  from: string;
  /** Inclusive last day of the P&L / trial balance window. */
  to: string;
  /**
   * 🔴 THE BALANCE SHEET DATE. Equal to `to`, and exposed under its own
   * name so that a caller reaching for a balance sheet cutoff never has
   * to look at `from` and never has to decide what to do with it.
   * A balance sheet has no from-date. See the header.
   */
  asAt: string;
  /** True when the caller supplied nothing and got the current FY. */
  isDefault: boolean;
  /** "FY 2025-26" when the range is exactly a financial year, else null. */
  fyLabel: string | null;
};

/**
 * ⭐⭐ RESOLVE WHAT THE USER ASKED FOR INTO A USABLE WINDOW.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEFAULT IS THE CURRENT FINANCIAL YEAR, NOT ALL TIME
 * ══════════════════════════════════════════════════════════════════════
 * "Since inception" is the wrong default even though it is the honest
 * one, and the reason is what happens when it is wrong.
 *
 * A since-inception P&L is not obviously broken. In year two it shows a
 * revenue figure that is roughly double the real one and a profit figure
 * that is plausible-looking, internally consistent, and cross-foots
 * against its own expenses. Nothing on the page contradicts it. The
 * person reading it has no reason to suspect the range, because no range
 * is shown — and the number goes into a bank pack.
 *
 * A current-FY default is wrong in the opposite direction: it can only
 * ever UNDER-report, and it under-reports against a period that is
 * printed at the top of the statement, so the reader who wants something
 * else can see immediately that they are not looking at it.
 *
 * Defaulting to the period every Indian business actually reports on
 * also means the common case needs no interaction at all.
 *
 * ⚠️ AN INVALID DATE FALLS BACK, IT DOES NOT THROW. These values arrive
 * from a query string, which means from anything. A malformed `?from=`
 * must not 500 a financial statement; it produces the default window,
 * and the resolved dates are rendered in the pickers so the user can see
 * what they actually got.
 */
export function resolveStatementPeriod(
  input: StatementPeriodInput | null | undefined,
  today: string = todayInIndia(),
): StatementPeriod {
  const anchor = isIsoDate(today) ? today : todayInIndia();

  const defaultFrom = fyStartFor(anchor);
  const defaultTo = fyEndFor(anchor);

  const requestedFrom = isIsoDate(input?.from) ? input!.from! : null;
  const requestedTo = isIsoDate(input?.to) ? input!.to! : null;

  let from = requestedFrom ?? defaultFrom;
  let to = requestedTo ?? defaultTo;

  /**
   * ⚠️ A REVERSED RANGE IS SWAPPED, NOT REJECTED. `from > to` selects no
   * transactions at all, and an empty P&L looks exactly like a business
   * that traded nothing — the one failure mode this file exists to
   * prevent. Swapping gives the user the statement they plainly meant.
   */
  if (from > to) {
    const swapped = from;
    from = to;
    to = swapped;
  }

  const isDefault = requestedFrom === null && requestedTo === null;
  const fyLabel =
    from === fyStartFor(from) && to === fyEndFor(from) ? fyLabelFor(from) : null;

  return {
    from,
    to,
    // 🔴 asAt IS `to`. The balance sheet accumulates from inception up to
    // this date; `from` plays no part in it whatsoever.
    asAt: to,
    isDefault,
    fyLabel,
  };
}

/* ------------------------------------------------------------------ */
/* THE DAY BEFORE A DAY                                                */
/* ------------------------------------------------------------------ */

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Gregorian leap year. Every four, except centuries, except every four hundred. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * ⭐⭐ THE DAY BEFORE `iso`, AS A `YYYY-MM-DD` STRING.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS AT ALL: AN OPENING BALANCE IS A CLOSING BALANCE
 * ══════════════════════════════════════════════════════════════════════
 * The cash flow statement needs cash and bank AS AT THE INSTANT THE
 * PERIOD OPENED. There is no such query. A balance is cumulative up to
 * and including a date, and `ledgerBalances` filters with `<= to`, so
 * "the position before 1 April" is spelled "the position as at 31 March"
 * and there is no other way to spell it.
 *
 * ⚠️ GETTING THIS OFF BY ONE DAY IS NOT A ROUNDING ERROR. Passing
 * `period.from` itself as the opening cutoff includes every transaction
 * dated on the first day of the year in BOTH the opening balance and the
 * period's movement. Day one is then counted twice, the statement fails
 * to reconcile by exactly the first day's trading, and — worse, on the
 * many days where nothing was posted on 1 April — it reconciles
 * perfectly and is wrong only in the months where it matters.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ PURE STRING ARITHMETIC. NO `Date` OBJECT, DELIBERATELY.
 * ══════════════════════════════════════════════════════════════════════
 * `new Date("2025-04-01")` is UTC midnight; subtracting a day and
 * formatting it back through anything locale- or zone-aware lands on
 * 30 March for half the planet. This module's whole doctrine (see
 * `formatIso` and `fyEndFor` above) is that dates here are strings and
 * stay strings. A month-length table plus a leap-year rule is twelve
 * lines and cannot be wrong in one timezone and right in another.
 *
 * ⚠️ A MALFORMED INPUT IS RETURNED UNCHANGED rather than throwing, for
 * the same reason `resolveStatementPeriod` falls back: these values
 * originate in a query string, and a financial statement must not 500.
 * The caller has already resolved the period through `isIsoDate`, so in
 * practice this branch is unreachable — it exists so that it stays
 * unreachable when somebody calls this from somewhere new.
 */
export function previousDay(iso: string): string {
  if (!isIsoDate(iso)) return iso;

  let year = Number(iso.slice(0, 4));
  let month = Number(iso.slice(5, 7)); // 1-indexed.
  let day = Number(iso.slice(8, 10));

  day -= 1;
  if (day === 0) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    day = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 30);
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The financial year immediately before the one containing `date`.
 * Used for the "previous FY" shortcut — the range a customer in year two
 * most often wants and previously could not ask for at all.
 */
export function previousFyFor(date: string): { from: string; to: string } {
  const startYear = Number(fyStartFor(date).slice(0, 4)) - 1;
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}

/** "1 Apr 2025 to 31 Mar 2026" — for the line under the statement title. */
export function describePeriod(period: StatementPeriod): string {
  return period.fyLabel
    ? `${period.fyLabel} · ${formatIso(period.from)} to ${formatIso(period.to)}`
    : `${formatIso(period.from)} to ${formatIso(period.to)}`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * ⚠️ FORMATTED BY STRING SLICING, NOT BY `new Date(iso)`.
 * `new Date("2026-03-31")` parses as UTC midnight and renders as
 * 30 March in any timezone west of Greenwich — and as the wrong day
 * either side of a year end, which is the only place it matters.
 */
export function formatIso(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const month = MONTHS[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7);
  return `${Number(iso.slice(8, 10))} ${month} ${iso.slice(0, 4)}`;
}
