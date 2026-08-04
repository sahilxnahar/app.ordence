/**
 * Ordence — ⭐ Paise ↔ Tally Decimal
 * Version: v0.37.0-alpha
 *
 * Pure and isomorphic.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE ONE-LINE VERSION OF THIS FILE IS A BUG
 * ══════════════════════════════════════════════════════════════════════
 * `(minor / 100).toFixed(2)` is the obvious implementation and it is
 * wrong in two independent ways at once:
 *
 *   1. `Number(minor)` on a bigint above 2^53 loses digits silently. A
 *      developer's land purchase is ₹18 crore — 1,800,000,000 paise, well
 *      inside the safe range — but a YEAR of consolidated turnover in a
 *      batch total is not, and a batch total that is off by a paisa fails
 *      the balance CHECK for reasons nobody can reproduce.
 *   2. Division by 100 in binary floating point is not exact.
 *      `(3 / 100).toFixed(2)` happens to be right; there are values for
 *      which the round-trip is not, and the failure appears as a Tally
 *      import that is one paisa out on a single voucher in a file of two
 *      thousand.
 *
 * So the conversion is STRING MANIPULATION on the decimal representation
 * of the bigint. No division, no float, no `Number` anywhere near it.
 *
 * ⚠️ AND TALLY WANTS RUPEES. Its `<AMOUNT>` is a decimal number of the
 * base currency with two places. Sending paise would multiply every
 * figure in the accountant's books by one hundred, which — because it is
 * uniform — still balances, still imports, and looks like a company a
 * hundred times bigger than it is.
 */

/**
 * ⭐ Paise → Tally's decimal rupees. Exact, by string surgery.
 *
 * `1234n` → `"12.34"`, `100n` → `"1.00"`, `5n` → `"0.05"`, `0n` → `"0.00"`.
 * Negatives keep their sign: `-1234n` → `"-12.34"`.
 */
export function formatTallyAmount(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const rupees = digits.slice(0, -2);
  const paise = digits.slice(-2);
  return `${negative ? "-" : ""}${rupees}.${paise}`;
}

/**
 * ⭐ Tally's decimal rupees → paise. The inverse, and the round trip is
 * asserted by the test suite in both directions.
 *
 * ⚠️ TALLY IS NOT CONSISTENT ABOUT WHAT IT EMITS, which is why this is
 * more tolerant than the formatter:
 *
 *   • `"1234.56"`, `"1234.5"`, `"1234"` and `"1234.00"` all occur.
 *   • ⭐ `"-1234.56"` is a DEBIT, and the sign is meaningful — see
 *     `lib/tally/vouchers.ts`.
 *   • Amounts sometimes arrive with a currency symbol prefix from
 *     Tally's own printed formats: `"₹ 1,234.56"`. Commas are the Indian
 *     grouping, `1,23,456.00`, not the western one, so they are simply
 *     removed rather than parsed.
 *
 * ⚠️ MORE THAN TWO DECIMAL PLACES IS A REFUSAL, NOT A ROUNDING. Tally can
 * be configured to more, and a company that has done so is a company
 * whose figures will not tie out to a two-place ledger. Rounding it here
 * would hide that permanently; refusing it surfaces it once.
 */
export class TallyAmountError extends Error {
  constructor(raw: string, why: string) {
    super(`Cannot read "${raw}" as an amount: ${why}`);
    this.name = "TallyAmountError";
  }
}

export function parseTallyAmount(raw: string): bigint {
  const cleaned = raw
    .trim()
    .replace(/[,\s]/g, "")
    // ⚠️ ₹, Rs, Rs. and the odd non-breaking space all appear.
    .replace(/^(?:₹|rs\.?|inr)/i, "")
    .trim();

  if (cleaned.length === 0) throw new TallyAmountError(raw, "it is empty.");

  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) throw new TallyAmountError(raw, "it is not a decimal number.");

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";

  if (fraction.length > 2) {
    throw new TallyAmountError(
      raw,
      "it has more than two decimal places. This ledger is kept in paise, and " +
        "silently rounding a third place would make every reconciliation against " +
        "this company approximately right forever.",
    );
  }

  const paise = fraction.padEnd(2, "0");
  return sign * (BigInt(whole) * 100n + BigInt(paise));
}

/**
 * ⚠️ TALLY'S DATE FORMAT IS `YYYYMMDD` WITH NO SEPARATORS, and it is not
 * negotiable — `<DATE>20260401</DATE>`. A hyphenated ISO date is accepted
 * by some builds and silently read as 1 January 1900 by others, which
 * puts a month of vouchers into a period the company does not have open,
 * where they are invisible in every report.
 */
export function toTallyDate(isoDay: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay.trim());
  if (!match) {
    throw new TallyAmountError(isoDay, "it is not a YYYY-MM-DD calendar day.");
  }
  return `${match[1]}${match[2]}${match[3]}`;
}

/** `20260401` → `2026-04-01`. The inverse, for reading their exports. */
export function fromTallyDate(raw: string): string | null {
  const trimmed = raw.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  // Some Tally exports carry `1-Apr-2026`. Read it rather than dropping it.
  const spelled = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(trimmed);
  if (spelled) {
    const month = MONTHS[(spelled[2] ?? "").toLowerCase()];
    if (!month) return null;
    return `${spelled[3]}-${month}-${(spelled[1] ?? "").padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

const MONTHS: Readonly<Record<string, string>> = Object.freeze({
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
});
