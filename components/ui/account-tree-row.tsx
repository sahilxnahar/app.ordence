/**
 * Ordence — ⭐⭐⭐ WAVE 2D PRIMITIVE 2: THE ACCOUNT TREE ROW
 * Version: v1.89.0-alpha · Wave 2D
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWO AMOUNT PROPS, NOT ONE SIGNED ONE. THIS IS THE WHOLE DESIGN.
 * ══════════════════════════════════════════════════════════════════════
 * `debitMinor` and `creditMinor` are separate, each nullable, and there
 * is no `amountMinor`. A ledger row is not a number with a sign on it —
 * it is a figure in one of two columns, and WHICH COLUMN is the fact. A
 * signed amount would force every consumer to decide, per row, whether
 * a negative goes left or right, and every consumer would decide
 * differently.
 *
 * ⭐ IT IS ALSO WHAT MAKES "never red for a negative number" ENFORCEABLE
 * RATHER THAN ADVISORY. There is no negative to colour. Sundry creditors
 * ₹2,94,000 sits in the credit column and is entirely ordinary — the
 * position says so, and no colour is spent saying it. A component that
 * took one signed figure would have made red-for-minus the obvious thing
 * to reach for, and a rule that has to be remembered against the shape
 * of the API is a rule that lasts one wave.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PRIOR-PERIOD COLUMN IS THE SAME IDEA AS THE METRIC CARD
 * ══════════════════════════════════════════════════════════════════════
 * A closing balance on its own is a fact nobody can check. Beside last
 * year's it becomes a question — "stock is up 68 thousand, is that the
 * new warehouse?" — and questions are what a trial balance is read for.
 * It is optional because an opening trial balance imported at cutover
 * genuinely has no prior year, and rendering a zero there would be a
 * claim that the business had nothing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ INDENT IS A `depth` NUMBER, NOT A `className`
 * ══════════════════════════════════════════════════════════════════════
 * The steps are fixed: 0 for a group, then 18px a level. Handing the
 * caller a class would produce three different indents on one screen
 * within a month, and the tree would stop reading as a hierarchy — which
 * is the only thing it is for.
 *
 * ⚠️ AND IT IS CLAMPED. A chart of accounts arriving from an import can
 * be nested eight deep; at 18px a level that is 144px of white space and
 * the account name falls off a laptop. Past four the indent stops and the
 * caret still nests, because a reader who is eight levels in is following
 * carets, not measuring margins.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE COUNT BADGE APPEARS ONLY WHEN COLLAPSED, AND THAT IS NOT COSMETIC
 * ══════════════════════════════════════════════════════════════════════
 * "Expenses ▸ 61 accounts" tells a reader what they are not looking at.
 * The same badge on an EXPANDED group tells them what they can already
 * count, and worse, it competes with the figures. It is `neutral` —
 * a count carries no judgement, and this is exactly why `StatusPill` has
 * a fifth member that means nothing.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { TableRow, TableCell } from "@/components/ui/table";
import { NumericCell } from "@/components/ui/dense-table";
import { StatusPill } from "@/components/ui/status-pill";

/** 18px a level, and it stops at four. See the header. */
const INDENT_STEP_PX = 18;
const MAX_INDENT_DEPTH = 4;

export interface AccountTreeRowProps
  extends Omit<React.HTMLAttributes<HTMLTableRowElement>, "onToggle"> {
  /** The account name, or the group name when `isGroup`. */
  name: string;
  /** The account code. Tabular, muted, and absent on a group. */
  code?: string | null;
  /** 0 is a top-level group. */
  depth?: number;
  /**
   * `undefined` = a leaf, and no caret is rendered — not a disabled one.
   * A caret that does nothing is a control a person clicks twice before
   * concluding the screen is broken.
   */
  expanded?: boolean;
  onToggle?: () => void;
  /** Groups are semibold on a tinted ground and carry no figures of their own. */
  isGroup?: boolean;
  /**
   * ⚠️ ONLY RENDERED WHEN `expanded === false`. Passing it on an expanded
   * group is silently ignored rather than warned about, because the
   * component is the rule.
   */
  childCount?: number;

  /** 🔴 TWO COLUMNS. Never one signed figure. `null` renders blank. */
  debitMinor?: bigint | string | null;
  creditMinor?: bigint | string | null;
  /**
   * Prior period, as a single net figure — it is a comparison, not a
   * posting, and nobody reconciles against last year's debit column.
   * Omit the prop entirely (not `null`) on a screen with no prior period,
   * and the column is not rendered at all.
   */
  priorMinor?: bigint | string | null;
  /** Set on every row of a table that has no prior-period column. */
  hidePrior?: boolean;
}

export const AccountTreeRow = React.forwardRef<HTMLTableRowElement, AccountTreeRowProps>(
  (
    {
      name,
      code,
      depth = 0,
      expanded,
      onToggle,
      isGroup = false,
      childCount,
      debitMinor = null,
      creditMinor = null,
      priorMinor = null,
      hidePrior = false,
      className,
      ...props
    },
    ref,
  ) => {
    const indent = Math.min(Math.max(depth, 0), MAX_INDENT_DEPTH) * INDENT_STEP_PX;
    const hasCaret = expanded !== undefined;
    const showCount = expanded === false && typeof childCount === "number";

    return (
      <TableRow
        ref={ref}
        data-primitive="account-tree-row"
        data-depth={depth}
        className={cn(
          "border-b border-border/60",
          isGroup && "bg-muted/40 font-semibold",
          className,
        )}
        {...props}
      >
        <TableCell className="px-2.5 py-2 align-middle">
          {/* ⚠️ The indent is padding on an inner span, not on the <td>.
              A padded cell shifts its own left border and the tree grows
              a ragged edge down the left of the table. */}
          <span className="flex items-center gap-1.5" style={{ paddingLeft: indent }}>
            {hasCaret ? (
              <button
                type="button"
                onClick={onToggle}
                // ⚠️ The caret is the control, so it carries the state.
                // A screen reader on a collapsed "Expenses" must hear
                // that there is something behind it; `aria-expanded` is
                // the only thing that says so, and the ▸ glyph is
                // decorative and hidden.
                aria-expanded={expanded}
                aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
                className="-m-1 rounded p-1 text-[10px] leading-none text-muted-foreground hover:text-foreground"
              >
                <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
              </button>
            ) : null}
            <span>{name}</span>
            {showCount ? (
              <StatusPill
                meaning="neutral"
                label={`${childCount} ${childCount === 1 ? "account" : "accounts"}`}
                className="ml-1"
              />
            ) : null}
          </span>
        </TableCell>

        {/* The code column. Tabular so codes of unequal length still
            align, muted because nobody reads it unless they are looking
            for one specific account. */}
        <TableCell className="ord-num px-2.5 py-2 align-middle text-muted-foreground">
          {isGroup ? null : (code ?? null)}
        </TableCell>

        {/* 🔴 THE TWO COLUMNS. A group carries no figures — its subtotal
            is the row below it in the running total, and printing a
            group's own debit invites a reader to add it to the children. */}
        <NumericCell minor={isGroup ? null : debitMinor} />
        <NumericCell minor={isGroup ? null : creditMinor} />
        {hidePrior ? null : <NumericCell minor={isGroup ? null : priorMinor} />}
      </TableRow>
    );
  },
);
AccountTreeRow.displayName = "AccountTreeRow";
