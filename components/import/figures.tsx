/**
 * Ordence — ⭐⭐ EVERY FIGURE ON A MIGRATION SCREEN
 * Version: v1.89.0-alpha · Wave 2A
 *
 * ══════════════════════════════════════════════════════════════════════
 * THREE RULES THAT ARE NOT STYLE PREFERENCES
 * ══════════════════════════════════════════════════════════════════════
 * ① `font-variant-numeric: tabular-nums` ON EVERY FIGURE. Without it the
 *    digits are proportional, a column of amounts does not line up, and a
 *    person checking a total against their own has to read each row
 *    twice. It is one CSS line and it is the difference between a ledger
 *    and a web page.
 *
 * ② INDIAN DIGIT GROUPING. `20,93,750`, never `2,093,750`. Getting this
 *    wrong tells every customer in one glance that the product was not
 *    built for them.
 *
 *    ⚠️ GROUPED HERE RATHER THAN BY `toLocaleString("en-IN")`. The
 *    browser's answer depends on which ICU data that browser shipped
 *    with; a build of Node or of a mobile browser without the `en-IN`
 *    locale silently falls back to thousands separators and nothing
 *    fails. Fourteen lines of arithmetic cannot fall back.
 *
 * ③ 🔴 NEVER RED FOR A NEGATIVE NUMBER. A credit balance is ordinary in
 *    an Indian ledger. Colour in this product carries one meaning each —
 *    red is "this blocks the cutover", not "this number is below zero" —
 *    and the moment red means both, a customer stops reading it. A
 *    negative is carried by the WORD (`short`, `over`, `Cr`) and by the
 *    column it sits in.
 *
 * ⚠️ PURE, AND NO `"use client"`. These are plain functions and plain
 * spans with no state, so they render inside a server component and
 * inside the wizard alike. A `"use client"` here would pull every screen
 * that shows a number into the client bundle for nothing.
 */

import type { ReactNode } from "react";
import { minorUnitExponent } from "@/lib/fx/currency";

/* ------------------------------------------------------------------ */
/* GROUPING                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ `20,93,750`. The last three digits, then groups of two.
 *
 * 🔴 RE-EXPORTED, NOT REIMPLEMENTED. `lib/receivables/numbers.ts` already
 * does this, exactly, on strings, with no ICU — and this repository
 * already carries FIVE money formatters that disagree at the edges. A
 * sixth would be the sixth, and the two would agree until the first time
 * one of them was corrected.
 *
 * ⚠️ AGREEMENT BY IDENTITY, NOT BY TEST. A test asserting that two
 * implementations produce the same string is a test somebody updates when
 * one of them changes. There is one implementation.
 *
 * ⚠️ IT TAKES AND RETURNS A STRING, which is why it is exact at any
 * magnitude: a `bigint`'s digits go in and the same digits come out with
 * commas. `Intl.NumberFormat("en-IN")` is not used ANYWHERE in this file,
 * because it silently falls back to grouping in threes on a small-ICU
 * runtime — which is a wrong answer that raises nothing.
 */
export { groupIndian } from "@/lib/receivables/numbers";
import { groupIndian } from "@/lib/receivables/numbers";

/** A whole number of things — rows, invoices, accounts. */
export function formatCount(value: number): string {
  const negative = value < 0;
  const text = groupIndian(Math.abs(Math.trunc(value)).toString());
  return negative ? `-${text}` : text;
}

/**
 * Minor units → the figure a person reads.
 *
 * 🔴 THE EXPONENT COMES FROM THE CURRENCY AND IS NOT TWO. Minor units
 * are not universally two decimals: JPY has 0; KWD, BHD, OMR, JOD, TND,
 * LYD and IQD have 3. `minorUnitExponent` is the one place that knows,
 * and dividing by 100 here would be a second, wrong copy of it.
 *
 * ⚠️ THE SIGN IS DROPPED ON PURPOSE. Every caller in this folder shows
 * direction with a word — see rule ③ above — so a `-` here would be a
 * second, quieter statement of the same thing in the place the design
 * says must not carry it.
 */
export function formatMinorIndian(minor: bigint, currency: string): string {
  const exponent = minorUnitExponent(currency);
  const abs = minor < 0n ? -minor : minor;
  if (exponent === 0) return groupIndian(abs.toString());
  const scale = 10n ** BigInt(exponent);
  const whole = groupIndian((abs / scale).toString());
  const fraction = (abs % scale).toString().padStart(exponent, "0");
  return `${whole}.${fraction}`;
}

/* ------------------------------------------------------------------ */
/* THE SPANS                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE ONLY WAY A NUMBER REACHES A MIGRATION SCREEN.
 *
 * ⚠️ `tabular-nums` IS ON THE COMPONENT AND NOT ON THE TABLE. A figure
 * that escapes into a sentence — "difference 1,400 short" — needs it
 * just as much as one in a column, and a rule set on the table misses
 * every one of those.
 */
export function Figure({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`tabular-nums ${className}`.trim()}>{children}</span>
  );
}
