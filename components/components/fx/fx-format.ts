/**
 * Ordence — ⭐ FX DISPLAY HELPERS
 * Batch 0101 · the multi-currency console
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ STRING WORK ONLY. NO ARITHMETIC LIVES HERE.
 * ══════════════════════════════════════════════════════════════════════
 * Every money figure on these screens arrives already formatted by
 * `lib/fx/currency.ts#formatMinorPlain`, which knows how many decimal
 * places the currency has. Nothing in the browser divides by a hundred,
 * because a hundred is wrong for the yen and wrong by a factor of ten for
 * the Kuwaiti dinar.
 */

/**
 * ⭐ A LABELLED AMOUNT, AS TEXT. The one function every figure goes
 * through, so "a total with no currency label" cannot be produced by
 * forgetting rather than by deciding.
 */
export function labelled(amount: string, currency: string): string {
  return `${currency} ${amount}`;
}

/**
 * A stored rate carries twelve decimal places because the inverse of a
 * four-decimal rate needs them. Twelve on a screen is unreadable, so the
 * trailing zeros are trimmed — but never below four, which is what the
 * Reserve Bank publishes, and never by rounding.
 *
 * ⚠️ TRIMMING IS NOT ROUNDING. Only zeros come off the end; a rate with
 * significant digits at the twelfth place keeps all twelve, because
 * shortening it would show the customer a number their books did not use.
 */
export function trimRate(rate: string, minDecimals = 4): string {
  if (!rate.includes(".")) return rate;
  const [whole = "0", fraction = ""] = rate.split(".");
  let end = fraction.length;
  while (end > minDecimals && fraction[end - 1] === "0") end -= 1;
  return `${whole}.${fraction.slice(0, end)}`;
}
