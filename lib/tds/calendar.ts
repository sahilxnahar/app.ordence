/**
 * Ordence — The TDS Calendar
 * Version: v0.36.0-alpha
 *
 * Pure. Civil days as `YYYY-MM-DD` strings, never `Date` objects with a
 * time on them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY EVERY DATE IN THIS PHASE IS A STRING
 * ══════════════════════════════════════════════════════════════════════
 * `new Date("2025-04-01").getMonth()` reads the month in the machine's
 * local zone. On any server west of UTC that is 31 March — which puts a
 * deduction in the previous financial year, the previous quarter and the
 * previous return. The deduction is then reported in a statement that was
 * filed two months ago, the deductee's Form 26AS shows nothing, and the
 * correction is a revised return.
 *
 * `lib/gst/constants.ts` made the same decision in Phase 32 for the same
 * reason, and `toCivilDay` / `financialYearOf` are imported from there
 * rather than rewritten. Two functions that answer "which financial year"
 * slightly differently is worse than one that answers it at all.
 */

import { toCivilDay, financialYearOf } from "@/lib/gst/constants";
import type { TdsQuarter, TdsSectionCode } from "@/db/schema/tds";

export { toCivilDay, financialYearOf };

/* ------------------------------------------------------------------ */
/* QUARTERS                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE TDS QUARTER IS THE FINANCIAL-YEAR QUARTER, NOT THE CALENDAR ONE.
 *
 *   Q1 = April, May, June
 *   Q2 = July, August, September
 *   Q3 = October, November, December
 *   Q4 = January, February, March
 *
 * A January deduction is Q4 of the PREVIOUS financial year. Filing it in
 * "Q1" because January is the first quarter of the calendar year puts it
 * in a return for a year that has not started, which the Department
 * rejects — after the due date.
 */
export function quarterOf(day: string | Date): TdsQuarter {
  const month = Number(toCivilDay(day).slice(5, 7));
  if (month >= 4 && month <= 6) return "Q1";
  if (month >= 7 && month <= 9) return "Q2";
  if (month >= 10 && month <= 12) return "Q3";
  return "Q4";
}

/** The first and last civil day of a TDS quarter in a financial year. */
export function quarterRange(
  financialYear: string,
  quarter: TdsQuarter,
): { from: string; to: string } {
  const startYear = Number(financialYear.slice(0, 4));
  switch (quarter) {
    case "Q1":
      return { from: `${startYear}-04-01`, to: `${startYear}-06-30` };
    case "Q2":
      return { from: `${startYear}-07-01`, to: `${startYear}-09-30` };
    case "Q3":
      return { from: `${startYear}-10-01`, to: `${startYear}-12-31` };
    case "Q4":
      // ⚠️ February's length is not guessed — `lastDayOfMonth` derives it,
      // so 2024 (a leap year) ends Q4 correctly whether or not anybody
      // remembered.
      return { from: `${startYear + 1}-01-01`, to: `${startYear + 1}-03-31` };
  }
}

export function isWithinQuarter(
  day: string,
  financialYear: string,
  quarter: TdsQuarter,
): boolean {
  const { from, to } = quarterRange(financialYear, quarter);
  return day >= from && day <= to;
}

/** "2024-25" → "2025-26". The assessment year printed on a challan. */
export function assessmentYearOf(financialYear: string): string {
  const startYear = Number(financialYear.slice(0, 4));
  return `${startYear + 1}-${String((startYear + 2) % 100).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* DUE DATES — DEPOSIT                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHEN THE TAX DEDUCTED ON A GIVEN DAY MUST REACH THE GOVERNMENT.
 *
 * Rule 30(2): the seventh day of the month following the month of
 * deduction — EXCEPT for tax deducted in March, which is due on 30 April.
 *
 * ⚠️ THE MARCH EXCEPTION IS WHERE THE MONEY IS. It looks like a
 * concession and it behaves like a trap: a March deduction not deposited
 * by 30 April misses the Q4 return due on 31 May, and a return filed
 * without the challan cannot claim it — so the deductee's Form 26AS is
 * short for the whole year, in the quarter that matters most, because
 * that is the one their own return is filed from.
 *
 * ⚠️ SECTION 194-IA IS DIFFERENT AND IT IS NOT AN EDGE CASE. Rule 30(2C)
 * gives THIRTY DAYS FROM THE END OF THE MONTH of deduction, on Form 26QB.
 * Applying the 7th-of-next-month rule to a land purchase declares a
 * default three weeks before one exists — and the 1.5%-a-month interest
 * that the software then reports is money somebody will actually pay.
 */
export function depositDueDate(
  deductionDay: string,
  section?: TdsSectionCode | null,
): string {
  const day = toCivilDay(deductionDay);
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));

  if (section === "194IA") {
    // Thirty days from the END of the month of deduction.
    const endOfMonth = `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`;
    return addDays(endOfMonth, 30);
  }

  // ⭐ March deductions: 30 April.
  if (month === 3) return `${year}-04-30`;

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${pad(nextMonth)}-07`;
}

/* ------------------------------------------------------------------ */
/* DUE DATES — RETURN AND CERTIFICATE                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHEN THE QUARTERLY STATEMENT IS DUE. Rule 31A(2).
 *
 *   Q1 → 31 July      Q2 → 31 October
 *   Q3 → 31 January   Q4 → 31 May
 *
 * ⚠️ Q4 IS THE ODD ONE — TWO MONTHS, NOT ONE. Everybody's calendar
 * reminder says "one month after the quarter", which makes Q4 due on
 * 30 April; the extra month is real and is why nothing happens on
 * 30 April. The reverse mistake is worse: assuming Q4 is due on 30 June
 * accrues ₹200 a day under Section 234E for a month before anybody looks.
 */
export function returnDueDate(financialYear: string, quarter: TdsQuarter): string {
  const startYear = Number(financialYear.slice(0, 4));
  switch (quarter) {
    case "Q1":
      return `${startYear}-07-31`;
    case "Q2":
      return `${startYear}-10-31`;
    case "Q3":
      return `${startYear + 1}-01-31`;
    case "Q4":
      return `${startYear + 1}-05-31`;
  }
}

/**
 * When the Form 16A must be in the deductee's hands. Rule 31(3): fifteen
 * days from the due date for furnishing the quarterly statement.
 *
 * ⚠️ IT IS FIFTEEN DAYS FROM THE DUE DATE, NOT FROM THE FILING DATE. A
 * return filed late does not move the certificate deadline — it just
 * makes the certificate late too, at ₹100 a day under Section 272A(2)(g),
 * capped at the tax deducted. Two penalties, one delay.
 */
export function certificateDueDate(
  financialYear: string,
  quarter: TdsQuarter,
): string {
  return addDays(returnDueDate(financialYear, quarter), 15);
}

/* ------------------------------------------------------------------ */
/* CIVIL-DAY ARITHMETIC                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ DONE IN UTC AND RETURNED AS A CIVIL DAY. `Date.UTC` has no zone to
 * drift in; constructing the date from the local constructor and reading
 * it back would move it by up to a day depending on where the server is.
 */
export function addDays(day: string, days: number): string {
  const ms = utcOf(day) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / 86_400_000);
}

/**
 * ⚠️ SLICED, NOT DESTRUCTURED FROM `split("-").map(Number)`. Under
 * `noUncheckedIndexedAccess` that produces `number | undefined`, and the
 * obvious `!` on each element is how a malformed day silently becomes
 * `NaN` and then `Invalid Date` — which compares false against every
 * threshold and reports a late deposit as on time.
 */
export function utcOf(day: string): number {
  const civil = toCivilDay(day);
  return Date.UTC(
    Number(civil.slice(0, 4)),
    Number(civil.slice(5, 7)) - 1,
    Number(civil.slice(8, 10)),
  );
}

export function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one, and it
  // handles February in a leap year without anybody encoding the rule.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
