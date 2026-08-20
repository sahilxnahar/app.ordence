/**
 * Ordence — ⭐⭐⭐ WAVE 2D PRIMITIVE 0: THE FIGURE, AND THE ONE FORMATTER
 * Version: v1.89.0-alpha · Wave 2D
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE DOES NOT CONTAIN A NUMBER FORMATTER. IT CONTAINS AN
 *    IMPORT OF ONE.
 * ══════════════════════════════════════════════════════════════════════
 * The wave brief says "ship the formatter as a primitive, because if each
 * screen does its own `toLocaleString` one of them will use the wrong
 * locale and nobody will notice until a customer does."
 *
 * That has already happened. Four times, on this tree, today:
 *
 *   lib/receivables/numbers.ts   groupIndian + formatPaise, exact string
 *                                surgery on a bigint's digits. Written
 *                                for legal notices.
 *   lib/registers/format.ts      a SECOND groupIndian, different code,
 *                                same output. Written for registers.
 *   components/returns/
 *     gstr3b-board.tsx           `export function rupees(minor: string)`
 *                                — `(abs / 100n).toLocaleString("en-IN")`
 *   components/sales/
 *     inventory-grid.tsx         `new Intl.NumberFormat("en-IN")`, and it
 *                                disagrees with the other three (below).
 *
 * ⚠️ SO SHIPPING A FIFTH WOULD HAVE BEEN THE DEFECT, NOT THE FIX. A
 * "design system formatter" that reimplements Indian grouping is a fifth
 * implementation with a nicer name, and the next disagreement is one
 * refactor away. THIS MODULE DELEGATES, and delegating is what makes the
 * agreement provable rather than asserted: `formatRupees` here IS
 * `formatRupees` in `lib/receivables/numbers.ts`, so no test can ever
 * find them apart, because there is only one of them.
 *
 * `lib/receivables/numbers.ts` is the one to delegate to, and not either
 * of the other three, for reasons that are written out in its own header
 * and are worth restating in one line each:
 *
 *   1. It never constructs a `Number`. It groups the DIGIT STRING of a
 *      bigint, so it is exact at every magnitude — including the ones a
 *      contractor's opening trial balance actually contains.
 *   2. It does not go through `Intl`, so its output does not vary with
 *      the ICU build. See the note below; this is not theoretical.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY `Intl.NumberFormat("en-IN")` IS A LATENT DEFECT AND NOT A STYLE
 *    CHOICE
 * ══════════════════════════════════════════════════════════════════════
 * `Intl` does LOCALE NEGOTIATION. Ask a Node built with `small-icu` — or
 * any runtime shipping a trimmed CLDR — for `en-IN` and it does not
 * throw and it does not warn. It falls back to `en`, and `en` groups in
 * THREES. The GSTR-3B screen then prints ₹20,93,750 in development and
 * ₹2,093,750 in production, and the only person who notices is a
 * customer looking at their own tax liability in a grouping that makes
 * them count digits.
 *
 * ⭐ `tests/ui/wave-2d-design-system.test.tsx` INDUCES EXACTLY THAT. It
 * substitutes an `Intl.NumberFormat` whose locale negotiation drops
 * `en-IN` — which is what a small-icu build does — and shows the screen's
 * own formatter drift to Western grouping while this one does not move.
 * A gate proven only by passing is not proven.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NEVER RED FOR A NEGATIVE NUMBER
 * ══════════════════════════════════════════════════════════════════════
 * `<Figure>` takes no colour prop for the sign and deliberately has no
 * `negative` variant. A credit balance is ORDINARY in an Indian ledger —
 * sundry creditors are a credit balance every day of the year and
 * nothing is wrong. Red is `--ord-blocks`, it means "this blocks the
 * cutover", and spending it on the minus sign spends the one colour the
 * cutover screens need. The debit/credit COLUMN carries the sign; see
 * `AccountTreeRow`, which is why that primitive takes two amounts and
 * not one signed one.
 *
 * The `tone` prop exists and is a `FigureTone`, which is the same closed
 * set as `StatusPill` — so a figure can be amber for "a person must look
 * at this 2,550 difference" (which is a meaning) but cannot be red for
 * "-2,550" (which is arithmetic).
 */

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * ⭐ THE DELEGATION. Re-exported so that a screen adopting the design
 * system imports ONE module, and so that `formatRupees` used through
 * this file and `formatRupees` used through `lib/receivables/numbers.ts`
 * are provably the same binding.
 *
 * ⚠️ EVERY ONE OF THESE TAKES `bigint` MINOR UNITS. There is no overload
 * that takes a `number` and there will not be one — that overload is the
 * whole of Rule 6, undone politely.
 */
export {
  groupIndian,
  formatPaise,
  formatRupees,
  formatRateBps,
} from "@/lib/receivables/numbers";

import { formatPaise, formatRupees } from "@/lib/receivables/numbers";

/**
 * Minor units arrive from the server as a STRING, because `numeric(18,0)`
 * comes out of Drizzle as one and because a bigint does not survive JSON.
 * Every screen therefore starts with a string, and every screen currently
 * writes its own `BigInt(x || "0")`.
 *
 * 🔴 THIS RETURNS `null` ON ANYTHING THAT IS NOT A MINOR-UNIT INTEGER,
 * AND THE COMPONENT RENDERS THE "not recorded" MARKER FOR IT. It does
 * not return `0n`. A zero is a claim — it says this customer owes
 * nothing, or this employee was deducted nothing — and the one thing a
 * money cell must never do is invent that claim out of a parse failure.
 * `BigInt(x || "0")`, which is what three screens on this tree do today,
 * makes exactly that claim for `undefined`, for `""`, and for `null`.
 */
export function minorFromString(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

/**
 * The marker for a figure that is not recorded. An em dash, not a zero
 * and not an empty cell — an empty cell in a ledger reads as "nobody has
 * filled this in yet", which is a different statement from "there is no
 * value here", and only one of them is true.
 */
export const NOT_RECORDED = "—";

/**
 * ⚠️ THE SAME CLOSED SET AS `StatusPill`, AND CLOSED FOR THE SAME
 * REASON. `undefined` is the ordinary case: most figures are just
 * figures and wear the foreground colour.
 */
export type FigureTone = "ties" | "check" | "blocks" | "statutory" | "action";

const TONE_CLASS: Record<FigureTone, string> = {
  ties: "text-[hsl(var(--ord-ties))]",
  check: "text-[hsl(var(--ord-check))]",
  blocks: "text-[hsl(var(--ord-blocks))]",
  statutory: "text-[hsl(var(--ord-statutory))]",
  action: "text-[hsl(var(--ord-action))]",
};

export interface FigureProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Minor units. `bigint` if you have one, the server's string if you do not. */
  minor: bigint | string | null | undefined;
  /** `true` prefixes ₹. Off by default — a column heading that already says "₹" does not want it repeated 40 times. */
  currency?: boolean;
  /**
   * 🔴 A MEANING, NEVER A SIGN. There is no tone for "negative"; see the
   * file header.
   */
  tone?: FigureTone;
}

/**
 * ⭐ THE ATOM EVERY OTHER PRIMITIVE RENDERS ITS NUMBERS THROUGH.
 * `MetricCard`, `AccountTreeRow` and `DenseTable`'s numeric cell all call
 * this rather than formatting themselves, so "the product formats money
 * in one place" is a fact about the import graph and not a convention.
 */
export const Figure = React.forwardRef<HTMLSpanElement, FigureProps>(
  ({ minor, currency = false, tone, className, ...props }, ref) => {
    const value = typeof minor === "bigint" ? minor : minorFromString(minor);
    const text =
      value === null ? NOT_RECORDED : currency ? formatRupees(value) : formatPaise(value);

    return (
      <span
        ref={ref}
        // ⚠️ `ord-num` and not a bare class name: see the base rule in
        // app/globals.css. A figure outside a <table> gets no tabular
        // alignment from the element selector and has to say so.
        className={cn("ord-num", tone && TONE_CLASS[tone], className)}
        // The unformatted value, for anyone who copies the cell into
        // their own sheet and for a test that wants the input back.
        data-minor={value === null ? undefined : value.toString()}
        {...props}
      >
        {text}
      </span>
    );
  },
);
Figure.displayName = "Figure";
