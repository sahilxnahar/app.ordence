/**
 * Ordence — ⭐⭐⭐ WAVE 2D PRIMITIVE 5: THE MAPPING ROW, WHOSE WARNING IS
 *           ON THE ROW
 * Version: v1.89.0-alpha · Wave 2D
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE WARNING SITS ON THE ROW. NEVER IN A SUMMARY AT THE BOTTOM.
 * ══════════════════════════════════════════════════════════════════════
 * This is the only rule in this file and everything else is in service
 * of it.
 *
 * A summary panel that says "3 columns need attention" is a to-do list
 * whose items are somewhere else. The person reading it has to hold three
 * column names in their head, scroll back up, find each one, and decide
 * — and they will do that for the first mapping and not for the fourth.
 * A warning ON the row is read by the person whose eyes are already on
 * the row, at the moment they are deciding that row, which is the only
 * moment the warning is worth anything.
 *
 * ⚠️ SO `warning` IS RENDERED INSIDE THE ROW'S OWN BOX AND THE COMPONENT
 * HAS NO WAY TO HOIST IT. There is no `onWarning` callback, no
 * `warnings` array a parent could collect and no id to correlate with a
 * panel elsewhere. A screen that wants a count at the bottom counts its
 * own data; it cannot get one out of this component, deliberately.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SAMPLE VALUES UNDER EVERY COLUMN, INCLUDING THE OBVIOUS ONES
 * ══════════════════════════════════════════════════════════════════════
 * `samples` is REQUIRED and takes an array, not an optional string.
 *
 * A column headed "Amount" mapped to `total_minor` looks correct and
 * proves nothing — the question that matters is whether it holds
 * "1,24,600", "124600", "₹1,24,600.00" or "1,24,600 Dr", and those are
 * four different imports. Three real values from the customer's own file
 * answer it in one glance and no amount of confidence scoring does.
 *
 * ⚠️ THEY ARE RENDERED IN A MONOSPACE FACE. Proportional digits hide
 * exactly the differences a person is looking at here — a trailing space,
 * a non-breaking space inside a number, an O where a 0 should be. This is
 * the one place in the design system where a monospace face is correct
 * and it is not a stylistic flourish.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ CONFIDENCE IS A WORD, AND IT IS NOT A PERCENTAGE
 * ══════════════════════════════════════════════════════════════════════
 * "82%" invites a reader to work out where the threshold is, and there
 * isn't one they can act on — the honest content is what the mapper knew:
 *
 *   exact      the header matched a declared synonym. Nothing to decide.
 *   likely     inferred from the header text or the value shapes.
 *   guess      the AI mapper proposed it and a person must confirm.
 *   none       no proposal. NOT an error — an unmapped column is the
 *              ordinary state of a column the customer does not need
 *              imported, and colouring it red would mark half a Tally
 *              export as broken.
 *
 * 🔴 `guess` AND `none` ARE NOT THE SAME AND MUST NOT LOOK THE SAME.
 * `guess` wears `check` — a person must look. `none` wears nothing at
 * all. Collapsing them is how a wizard trains its user to click past the
 * amber, and after that the amber on the row that mattered is invisible.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/ui/status-pill";

/** See the header. A word, never a percentage. */
export type MappingConfidence = "exact" | "likely" | "guess" | "none";

/**
 * ⚠️ `Record` over the closed union again — the same construction as
 * `StatusPill`. A fifth confidence is a compile error, not a blank cell.
 */
const CONFIDENCE: Record<
  MappingConfidence,
  { label: string; meaning: "ties" | "check" | "neutral" } | null
> = {
  exact: { label: "Exact match", meaning: "ties" },
  likely: { label: "Likely", meaning: "neutral" },
  guess: { label: "Confirm this", meaning: "check" },
  // 🔴 NULL, AND NOT A GREY PILL. An unmapped column is the ordinary
  // state and gets no chip; a "None" chip on twenty rows is twenty
  // pieces of furniture between the reader and the four rows that matter.
  none: null,
};

export interface MappingRowProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The heading exactly as it appears in the customer's file. Never cleaned up. */
  sourceColumn: string;
  /**
   * 🔴 REQUIRED. Real values from their file — three is the useful number.
   * An empty array is legitimate (a column that is blank all the way
   * down) and renders as such, which is itself the answer to "why did
   * nothing map here".
   */
  samples: string[];
  /**
   * The destination field, already chosen. `null` means unmapped, and
   * unmapped is a normal outcome.
   */
  destinationField?: string | null;
  /** The `<select>` the screen supplies. This primitive owns the row, not the control. */
  destinationControl?: React.ReactNode;
  confidence: MappingConfidence;
  /**
   * 🔴 THE WHOLE POINT OF THE COMPONENT. Rendered on this row, under
   * this row's destination, in this row's box.
   */
  warning?: string | null;
}

/**
 * ⚠️ A `div` GRID AND NOT A `<tr>`. A mapping row is two-line content
 * with a form control in it and a warning that wraps to a third line —
 * inside a table that means `rowSpan` arithmetic and a warning that
 * either stretches a column or escapes into one. The trial balance is a
 * table because it is tabular; this is a list of decisions.
 */
export const MappingRow = React.forwardRef<HTMLDivElement, MappingRowProps>(
  (
    {
      sourceColumn,
      samples,
      destinationField = null,
      destinationControl,
      confidence,
      warning = null,
      className,
      ...props
    },
    ref,
  ) => {
    const chip = CONFIDENCE[confidence];

    return (
      <div
        ref={ref}
        data-primitive="mapping-row"
        data-confidence={confidence}
        className={cn(
          "grid grid-cols-1 gap-3 border-b border-border/60 px-3 py-3 last:border-b-0 sm:grid-cols-[1fr_1fr_auto]",
          className,
        )}
        {...props}
      >
        {/* Column 1 — their file, in their words. */}
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium">{sourceColumn}</div>
          <div className="mt-1 space-y-0.5 font-mono text-[11.5px] leading-[1.5] text-muted-foreground">
            {samples.length === 0 ? (
              // ⚠️ Said out loud. A blank block here reads as "the
              // preview failed to load", which is a different problem
              // with a different fix.
              <div className="italic">no values in this column</div>
            ) : (
              samples.map((s, i) => (
                <div key={`${i}-${s}`} className="truncate">
                  {/* An empty string in a data column is a real value and
                      has to be visible as one. */}
                  {s === "" ? <span className="italic">(empty)</span> : s}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Column 2 — ours, plus the warning. */}
        <div className="min-w-0">
          {destinationControl ?? (
            <div
              className={cn(
                "truncate rounded-md border border-border px-2.5 py-1.5 text-[12.5px]",
                destinationField === null && "text-muted-foreground",
                // ⚠️ The tint is on the CONTROL, not on the whole row. A
                // tinted row draws the eye to the source column, which is
                // not the thing that needs deciding.
                warning && "border-[hsl(var(--ord-check))]/45 bg-[hsl(var(--ord-check-bg))]",
              )}
            >
              {destinationField ?? "Not imported"}
            </div>
          )}

          {/* 🔴 HERE. On the row. Not at the bottom of the screen. */}
          {warning ? (
            <p className="mt-1.5 text-[11.5px] leading-[1.45] text-[hsl(var(--ord-check))]">
              {warning}
            </p>
          ) : null}
        </div>

        {/* Column 3 — what the mapper knew. */}
        <div className="sm:pl-2 sm:pt-1">
          {chip ? <StatusPill meaning={chip.meaning} label={chip.label} /> : null}
        </div>
      </div>
    );
  },
);
MappingRow.displayName = "MappingRow";
