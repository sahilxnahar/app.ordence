/**
 * Ordence — ⭐⭐⭐ WAVE 2D PRIMITIVE 4: THE DENSE TABLE, WHOSE TOTAL ROW
 *           IS THE PLAINEST ROW ON THE SCREEN
 * Version: v1.89.0-alpha · Wave 2D
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS WRAPS `components/ui/table.tsx`. IT DOES NOT REPLACE IT.
 * ══════════════════════════════════════════════════════════════════════
 * Fifteen screens already render `<Table>`. A second, unrelated table
 * component is how a product ends up with two table paddings, two border
 * colours and two ideas about what a header is — and the wave brief is
 * explicit that a design system with forty components and two screens is
 * a maintenance surface nobody asked for. So every element here is the
 * existing one with a ledger's manners added, and a screen can adopt
 * `DenseTable` one cell at a time.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 RIGHT-ALIGNED NUMERICS ARE NOT A PREFERENCE
 * ══════════════════════════════════════════════════════════════════════
 * A column of money is scanned by the position of its decimal point. Left
 * or centre alignment moves that point on every row and the column stops
 * being a column. Combined with the `tabular-nums` base rule in
 * `app/globals.css`, right alignment is what makes ₹4,81,200 and
 * ₹48,120 legible as an order of magnitude apart WITHOUT reading either.
 *
 * ⭐ SO `<NumericCell>` EXISTS AND `align="right"` DOES NOT. An alignment
 * prop is a decision handed back to the caller forty times; a cell type
 * is the decision made once. The cell also renders through `<Figure>`,
 * so "the product formats money in one place" survives contact with the
 * table that shows the most of it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TOTAL ROW IS DELIBERATELY THE QUIETEST THING ON THE SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * It gets a hairline rule above it and semibold weight. No tint that
 * shouts, no accent colour, no badge. A trial balance that does not foot
 * is not a report with a warning on it — it is not a trial balance, and
 * the screen's response is to show the difference and refuse to export,
 * not to colour the total row red. Colouring it red would spend
 * `--ord-blocks` on a row that is correct 364 days a year, and on the
 * day it is wrong the reader would have nothing left to look at.
 *
 * ⚠️ THE TOTAL ROW'S TINT IS `bg-muted/40` AND NOT ONE OF THE SIX. The
 * six are meanings; a total is not a meaning, it is a summary. This is
 * the same reason `neutral` exists in `StatusPill`.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Figure, type FigureTone } from "@/components/ui/figure";

/**
 * ⭐ The container. `dense` is the default and the only mode — the name
 * is the documentation, not a prop.
 *
 * The row height comes down from the base table's `p-3` to `px-2.5 py-2`,
 * which is roughly 34px a row. On a 312-account trial balance that is the
 * difference between 20 rows on a laptop screen and 32, and an accountant
 * comparing two subtotals wants them both visible at once.
 */
export const DenseTable = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <Table
      ref={ref}
      data-primitive="dense-table"
      // ⚠️ `tabular-nums` is NOT set here. It is a base rule on `table`
      // in app/globals.css, so it holds for the fifteen screens already
      // rendering the plain <Table> too. Setting it here as well would
      // suggest it is this component's doing, and the next dense table
      // written without this wrapper would silently lose it.
      className={cn("text-[13.5px]", className)}
      {...props}
    />
  ),
);
DenseTable.displayName = "DenseTable";

export const DenseHeader = TableHeader;
export const DenseBody = TableBody;

export const DenseRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <TableRow ref={ref} className={cn("border-b border-border/60", className)} {...props} />
));
DenseRow.displayName = "DenseRow";

export interface DenseHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  /** Set on the columns whose cells are `<NumericCell>`. Nothing else. */
  numeric?: boolean;
}

/** 11/600 caps, muted — the label step of the type scale. */
export const DenseHead = React.forwardRef<HTMLTableCellElement, DenseHeadProps>(
  ({ numeric, className, ...props }, ref) => (
    <TableHead
      ref={ref}
      className={cn(
        "h-8 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  ),
);
DenseHead.displayName = "DenseHead";

export const DenseCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <TableCell ref={ref} className={cn("px-2.5 py-2 align-middle", className)} {...props} />
));
DenseCell.displayName = "DenseCell";

export interface NumericCellProps
  extends Omit<React.TdHTMLAttributes<HTMLTableCellElement>, "children"> {
  /** Minor units. `null`/unparseable renders the "not recorded" marker. */
  minor: bigint | string | null | undefined;
  currency?: boolean;
  /**
   * 🔴 A MEANING. THERE IS NO TONE FOR "NEGATIVE" — a credit balance is
   * ordinary in an Indian ledger and the debit/credit column carries the
   * sign. See `figure.tsx`.
   */
  tone?: FigureTone;
}

/**
 * ⭐ THE ONLY WAY A FIGURE ENTERS A TABLE. Right-aligned by construction,
 * formatted by the one formatter, and carrying `data-minor` so a test —
 * or a person copying a column into their own sheet — can recover the
 * exact value that was rendered.
 */
export const NumericCell = React.forwardRef<HTMLTableCellElement, NumericCellProps>(
  ({ minor, currency, tone, className, ...props }, ref) => (
    <TableCell
      ref={ref}
      className={cn("px-2.5 py-2 text-right align-middle", className)}
      {...props}
    >
      <Figure minor={minor} currency={currency} tone={tone} />
    </TableCell>
  ),
);
NumericCell.displayName = "NumericCell";

/**
 * 🔴 THE TOTAL ROW. A hairline above, semibold, and nothing else.
 *
 * ⚠️ IT IS A COMPONENT AND NOT A `className` ON `DenseRow` BECAUSE THE
 * RULE IS "there is one of these and it looks like this". A class can be
 * applied to two rows, or to none, by a screen in a hurry.
 */
export const DenseTotalRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <TableRow
    ref={ref}
    data-primitive="dense-total-row"
    className={cn(
      "border-b-0 border-t-2 border-t-foreground/70 bg-muted/40 font-semibold hover:bg-muted/40",
      className,
    )}
    {...props}
  />
));
DenseTotalRow.displayName = "DenseTotalRow";
