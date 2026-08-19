/**
 * Ordence — GST Constants
 * Version: v0.32.0-alpha
 *
 * Pure and isomorphic. No `server-only`, no database, no I/O — the
 * invoice renderer, the booking form and the tax engine all read the same
 * tables of facts, and a second copy on the client is how a page offers a
 * rate the server refuses.
 *
 * ⚠️ `GST_STATE_CODES`, `isValidGstin`, `applyRateBps`, `splitEvenly` and
 * `computeGst` ALREADY EXIST in `lib/billing/money.ts` and are re-used
 * here rather than restated. A second GSTIN validator that disagrees with
 * the first by one character is worse than no second validator.
 */

import { GST_STATE_CODES } from "@/lib/billing/money";

export { GST_STATE_CODES };

/* ------------------------------------------------------------------ */
/* PLACE OF SUPPLY CODES                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A PLACE OF SUPPLY IS NOT THE SAME SET AS A GSTIN PREFIX.
 *
 * `GST_STATE_CODES` is the set a GSTIN may begin with, and it must stay
 * that way — accepting "96" there would make `isValidGstin` approve a
 * GSTIN that cannot exist.
 *
 * But a place of supply CAN be 96, "Other Country": that is what GSTR-1
 * expects on an export, and there is no registration behind it. So the
 * place-of-supply vocabulary is the state list PLUS 96, defined here and
 * used only for that purpose.
 */
export const OVERSEAS_PLACE_OF_SUPPLY = "96";

export const PLACE_OF_SUPPLY_CODES: Readonly<Record<string, string>> = Object.freeze({
  ...GST_STATE_CODES,
  [OVERSEAS_PLACE_OF_SUPPLY]: "Other Country",
});

export function isPlaceOfSupplyCode(code: string | null | undefined): boolean {
  return typeof code === "string" && Object.hasOwn(PLACE_OF_SUPPLY_CODES, code);
}

export function placeOfSupplyName(code: string | null | undefined): string {
  if (!code) return "Not recorded";
  return `${PLACE_OF_SUPPLY_CODES[code] ?? "Unknown"} (${code})`;
}

/* ------------------------------------------------------------------ */
/* ⭐ UNION TERRITORIES — WHY THE THIRD TAX EXISTS                      */
/* ------------------------------------------------------------------ */

/**
 * An intra-state supply is CGST + SGST. An intra-UNION-TERRITORY supply
 * is CGST + **UTGST**, under a different Act, and it is reported in a
 * different column of GSTR-3B.
 *
 * ⚠️ DELHI, PUDUCHERRY AND JAMMU & KASHMIR ARE NOT ON THIS LIST, AND
 * THAT IS THE WHOLE SUBTLETY. UTGST applies to a Union Territory WITHOUT
 * a legislature. Delhi (07), Puducherry (34) and J&K (01) have their own
 * legislatures and therefore levy SGST like any state. A developer
 * selling in Chandigarh charges UTGST; the same developer selling in
 * Delhi charges SGST; both look identical on a map.
 *
 * The amount is the same either way, so getting it wrong costs nothing on
 * the invoice total and everything at filing, when the figure sits in the
 * wrong box of the return.
 */
export const UNION_TERRITORY_CODES: ReadonlySet<string> = new Set([
  "04", // Chandigarh
  "26", // Dadra and Nagar Haveli and Daman and Diu
  "31", // Lakshadweep
  "35", // Andaman and Nicobar Islands
  "38", // Ladakh
  "97", // Other Territory
]);

export function isUnionTerritoryCode(code: string | null | undefined): boolean {
  return typeof code === "string" && UNION_TERRITORY_CODES.has(code);
}

/* ------------------------------------------------------------------ */
/* RATE SLABS                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A CONVENIENCE LIST FOR PICKERS, NOT A VALIDATION RULE.
 *
 * The temptation is to constrain `rate_bps` to these values. Do not: rate
 * notifications have produced 0.25% (rough diamonds), 3% (gold), 1% and
 * 8% (affordable housing), 6% and 7.5% on composition schemes, and the
 * schedule changes by notification faster than a deploy. A product that
 * refuses a rate the Government has just announced is a product nobody
 * can use in the week that matters.
 */
export const COMMON_GST_RATE_BPS: readonly number[] = Object.freeze([
  0, 25, 100, 300, 500, 600, 800, 1200, 1800, 2800,
]);

/** The two halves of an intra-state rate, for display only. */
export function halfRateBps(rateBps: number): number {
  return rateBps / 2;
}

/* ------------------------------------------------------------------ */
/* CIVIL DAYS                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE FUNCTION THAT KEEPS RATE RESOLUTION OFF THE TIMEZONE ROCKS.
 *
 * A notification takes effect on a CALENDAR DAY IN INDIA. Everything in
 * this module compares `YYYY-MM-DD` strings, never `Date` objects,
 * because two `Date`s an hour apart can straddle a rate change while
 * representing the same Indian day.
 *
 * IST is UTC+05:30 with no daylight saving, ever — which is why a fixed
 * offset is honest here and would not be for, say, Europe/London. A
 * `Date` at 2019-03-31T20:00:00Z is 1 April in Mumbai, and an invoice
 * raised then is a 5% invoice, not a 12% one.
 *
 * Anything already in `YYYY-MM-DD` form is passed through untouched: it
 * is already a civil day and re-parsing it through `Date` would drag it
 * back into UTC and shift it.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function toCivilDay(value: Date | string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`"${value}" is not a date this system can read.`);
    }
    return toCivilDay(parsed);
  }
  if (Number.isNaN(value.getTime())) {
    throw new Error("An invalid Date was passed where a tax date was expected.");
  }
  return new Date(value.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The Indian financial year a civil day falls in, as "2024-25".
 *
 * Rule 46(b) makes an invoice serial unique FOR A FINANCIAL YEAR, and the
 * Indian financial year runs 1 April to 31 March. A calendar-year
 * sequence resets three months late and produces duplicate serials in
 * the return.
 */
export function financialYearOf(value: Date | string): string {
  const day = toCivilDay(value);
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * ⭐ THE SAME FINANCIAL YEAR AS A HALF-OPEN WINDOW — added v1.25.0-alpha.
 *
 * ⚠️ HALF-OPEN, `start <= x < end`, and that is the whole reason it is a
 * function rather than two lines at each call site. An inclusive end of
 * "2026-03-31" silently drops everything timestamped during 31 March,
 * which for a year-end threshold is the single busiest day in it.
 *
 * ⚠️ AND IT IS DERIVED FROM `financialYearOf` RATHER THAN RE-DERIVED
 * FROM THE MONTH. Two places that each decide when a financial year
 * begins is two places that can disagree, and the one that disagrees is
 * never the one being read.
 */
export function financialYearWindow(value: Date | string): {
  financialYear: string;
  /** Inclusive. "2026-04-01". */
  start: string;
  /** EXCLUSIVE. "2027-04-01". */
  end: string;
} {
  const financialYear = financialYearOf(value);
  const startYear = Number(financialYear.slice(0, 4));
  return {
    financialYear,
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-04-01`,
  };
}
