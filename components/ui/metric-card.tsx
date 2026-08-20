/**
 * Ordence — ⭐⭐⭐ WAVE 2D PRIMITIVE 1: TWO NUMBERS AND THE DISTANCE
 *           BETWEEN THEM
 * Version: v1.89.0-alpha · Wave 2D
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MOST IMPORTANT COMPONENT IN THE PRODUCT, AND THE REASON IS ONE
 *    SENTENCE
 * ══════════════════════════════════════════════════════════════════════
 * XERO DOES NOT SHOW A BANK BALANCE. It shows two numbers and how far
 * apart they are — what the statement says, what the books say, and the
 * gap. Every reconciliation screen in this product is that card: bank vs
 * ledger, 2B vs claimed ITC, issued invoices vs registered IRNs, opening
 * trial balance vs what the import actually wrote.
 *
 * ⚠️ SO `difference` IS A REQUIRED PROP AND NOT AN OPTIONAL ONE. A single
 * figure on a card is a fact with no question attached, and a person
 * reading it cannot act on it. "₹6,12,480" tells an accountant nothing.
 * "₹6,12,480 on the statement, ₹6,09,930 in Ordence, 4 items to
 * reconcile, ₹2,550" tells them what to do next, and the last part is the
 * only part that is work.
 *
 * ⭐ THE DIFFERENCE LINE IS BELOW A RULE AND IN SMALLER TYPE THAN THE TWO
 * FIGURES. It is the most important row on the card and it is the
 * quietest, which is the same decision as the totals row of a trial
 * balance being the plainest row on the screen. Loud is for things that
 * are competing for attention; this has none.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS COMPONENT REFUSES TO DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not compute the difference. It is handed one.
 *
 * That looks like a missed convenience and it is a deliberate refusal.
 * The distance between two figures is not always subtraction: the gap
 * between a bank statement and a ledger is a COUNT of unmatched items as
 * much as a sum, the gap between 2B and claimed ITC is credit available
 * but not taken, and the gap on a GST card is a liability with a
 * statutory date on it. A component that did `a - b` would be right for
 * the bank card, silently wrong for the other three, and the wrongness
 * would look exactly like rightness. The screens own their arithmetic;
 * this owns the grammar.
 *
 * ⚠️ IT ALSO REFUSES A `variant="success"`. See `FigureTone` — the tone
 * on the difference line is a MEANING, and the meanings are the six in
 * `app/globals.css`. A card whose difference is `tone="ties"` is saying
 * "these two agree", which is a claim the screen has to have checked.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { Figure, type FigureTone } from "@/components/ui/figure";

/**
 * One of the two figures. `minor` when it is money, `text` when it is
 * not — a count of invoices, a date, "112 days".
 *
 * ⚠️ EXACTLY ONE OF THEM. Both is a bug the type cannot express cheaply,
 * so `minor` wins and `text` is ignored; see `renderValue`.
 */
export interface MetricValue {
  /** Money, in minor units. Rendered through the one formatter. */
  minor?: bigint | string | null;
  /** Anything that is not money: "112 days", "Friday", "130". */
  text?: string;
  /**
   * 🔴 THE QUALIFIER IS NOT DECORATION AND IS REQUIRED. "₹4,81,200" is a
   * number; "₹4,81,200 / 7 invoices" is a number a person can check. The
   * qualifier is what makes the figure auditable at a glance, and making
   * it optional is how half the cards end up without one.
   */
  qualifier: string;
  tone?: FigureTone;
}

export interface MetricCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The label. Rendered 11/600 caps — see the type scale. */
  title: string;
  /** The two figures. Always two. */
  primary: MetricValue;
  secondary: MetricValue;
  /**
   * 🔴 REQUIRED. The distance between them, and what it means.
   * `label` is the left side ("Oldest unpaid", "4 items to reconcile",
   * "Payable by 20 Aug"), `value` the right ("112 days", "₹2,550").
   */
  difference: {
    label: string;
    minor?: bigint | string | null;
    text?: string;
    tone?: FigureTone;
  };
  /**
   * ⚠️ FOR THE ONE CARD ON A SCREEN THAT IS THE POINT OF THE SCREEN —
   * "payable in cash" on a 3B due today. It tints the whole card, and it
   * is `emphasis`, not `variant="danger"`, because the tone still comes
   * from the six meanings and this only says "and turn it up".
   */
  emphasis?: FigureTone;
}

const EMPHASIS_CARD: Record<FigureTone, string> = {
  ties: "border-[hsl(var(--ord-ties))]/35 bg-[hsl(var(--ord-ties-bg))]",
  check: "border-[hsl(var(--ord-check))]/35 bg-[hsl(var(--ord-check-bg))]",
  blocks: "border-[hsl(var(--ord-blocks))]/35 bg-[hsl(var(--ord-blocks-bg))]",
  statutory: "border-[hsl(var(--ord-statutory))]/35 bg-[hsl(var(--ord-statutory-bg))]",
  action: "border-[hsl(var(--ord-action))]/35 bg-[hsl(var(--ord-action-bg))]",
};

const TONE_TEXT: Record<FigureTone, string> = {
  ties: "text-[hsl(var(--ord-ties))]",
  check: "text-[hsl(var(--ord-check))]",
  blocks: "text-[hsl(var(--ord-blocks))]",
  statutory: "text-[hsl(var(--ord-statutory))]",
  action: "text-[hsl(var(--ord-action))]",
};

/**
 * ⚠️ `minor` WINS OVER `text` WHEN BOTH ARE GIVEN, AND `minor: null` IS
 * NOT "absent". A null minor is a money value that is not recorded and
 * must render the marker — falling through to `text` there would let a
 * screen paper over a missing figure with a caption.
 */
function renderValue(v: { minor?: bigint | string | null; text?: string; tone?: FigureTone }, className: string) {
  if (v.minor !== undefined) {
    return <Figure minor={v.minor} currency tone={v.tone} className={className} />;
  }
  return (
    <span className={cn("ord-num", v.tone && TONE_TEXT[v.tone], className)}>{v.text ?? "—"}</span>
  );
}

export const MetricCard = React.forwardRef<HTMLDivElement, MetricCardProps>(
  ({ title, primary, secondary, difference, emphasis, className, ...props }, ref) => (
    <div
      ref={ref}
      data-primitive="metric-card"
      className={cn(
        "rounded-lg border border-border bg-card p-4 text-card-foreground",
        emphasis && EMPHASIS_CARD[emphasis],
        className,
      )}
      {...props}
    >
      {/* Label · 11/600 caps. The type scale is in the design brief and
          is repeated in exactly two places: here and AccountTreeRow. */}
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.055em] text-muted-foreground">
        {title}
      </h3>

      {/* ⚠️ `flex`, NOT a 2-column grid. The two figures are read left to
          right as a pair; a grid would give the shorter one a column of
          its own and put a gutter between "₹4,81,200" and "7 invoices"
          wide enough to read as two separate cards. */}
      <div className="flex flex-wrap gap-x-7 gap-y-3">
        <div>
          {renderValue(primary, "block text-[26px] font-semibold leading-none tracking-[-0.015em]")}
          <div className="mt-1.5 text-xs text-muted-foreground">{primary.qualifier}</div>
        </div>
        <div>
          {renderValue(secondary, "block text-[26px] font-semibold leading-none tracking-[-0.015em]")}
          <div className="mt-1.5 text-xs text-muted-foreground">{secondary.qualifier}</div>
        </div>
      </div>

      {/* 🔴 THE ROW THE CARD EXISTS FOR. Above a rule, quiet, and always
          present — there is no branch that omits it. */}
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-2.5 text-[13px]">
        <span className={cn(difference.tone ? TONE_TEXT[difference.tone] : "text-muted-foreground")}>
          {difference.label}
        </span>
        {difference.minor !== undefined ? (
          <Figure minor={difference.minor} currency tone={difference.tone} className="font-semibold" />
        ) : (
          <b className={cn("ord-num font-semibold", difference.tone && TONE_TEXT[difference.tone])}>
            {difference.text ?? "—"}
          </b>
        )}
      </div>
    </div>
  ),
);
MetricCard.displayName = "MetricCard";
