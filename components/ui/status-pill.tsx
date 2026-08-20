/**
 * Ordence — ⭐⭐⭐ WAVE 2D PRIMITIVE 3: FIVE STATUSES, AND A SIXTH IS A
 *           COMPILE ERROR
 * Version: v1.89.0-alpha · Wave 2D
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE VALUE OF THIS COMPONENT IS THE SET IT REFUSES, NOT THE PILL IT
 *    DRAWS
 * ══════════════════════════════════════════════════════════════════════
 * A rounded rectangle with a tint is thirty seconds of CSS. The thing
 * that is hard, and that decays first, is that green keeps meaning ONE
 * thing across 218 routes. The moment green means both "reconciled" and
 * "saved", a customer stops reading it — and after that the colour is
 * decoration and every screen has to be read word by word.
 *
 * So the set is closed:
 *
 *   ties       THIS TIES. Two figures that had to agree, agree. The
 *              books foot. The bank matches. The IRN came back.
 *              🔴 NOT "success" and NOT "saved". A draft that saved is
 *              not a reconciliation and does not get this colour.
 *   check      A PERSON MUST LOOK. NOT "warning" and NOT a failure.
 *              "Awaiting IRN" wears this: the IRP goes down, an invoice
 *              issued at 11pm and registered at 7am is entirely normal,
 *              and the screen must read as normal.
 *   blocks     THIS BLOCKS THE CUTOVER. NOT "error". A 3B due today
 *              blocks; a form field that failed validation does not —
 *              that is the field's business and it has `--destructive`.
 *   statutory  A DUTY OWED TO THE STATE, WITH A DATE ON IT. There is no
 *              precedent for this in any product we studied, because
 *              every tax screen in that library is a US one-time
 *              identity form. It is ours, and it is where Ordence is
 *              actually differentiated.
 *   neutral    A count, a category, a "3 accounts" badge on a collapsed
 *              group. It carries NO judgement, which is a status too and
 *              is the one most often faked with grey text.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ HOW THE SIXTH IS PREVENTED, AND WHY IT IS NOT A LINT RULE
 * ══════════════════════════════════════════════════════════════════════
 * `PILL` is a `Record<StatusMeaning, …>` over a closed union — the same
 * construction `server/import/writers/registry.ts` uses to make a
 * destination with no writer a compile error, and for the same reason.
 * Adding a member to `StatusMeaning` without adding its row does not
 * lint badly, it does not fail at runtime on the one path nobody
 * exercises: `tsc` refuses the file.
 *
 * ⚠️ AND THE PROP IS THE MEANING, NOT THE COLOUR. `<StatusPill
 * meaning="check">` can be read six months from now; `<StatusPill
 * color="amber">` cannot, and the person reading it will pick amber
 * because the mock was amber rather than because a person must look.
 * There is no `color` prop and there is no `className` override of the
 * tint — `className` is merged for LAYOUT only, and a screen that wants
 * a colour outside the six is a screen that has found a meaning outside
 * the six, which is a conversation and not a class name.
 *
 * ⚠️ `label` IS REQUIRED AND IS NOT DERIVED FROM `meaning`. A pill
 * reading "Ties" is meaningless; the ones on real screens read
 * "Registered", "Awaiting IRN", "Rejected", "Due in 0 days". The meaning
 * chooses the colour; the screen writes the words. Deriving the words
 * from the meaning is how five different screens end up saying "OK".
 */

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 🔴 FIVE. ADDING A SIXTH IS A DELIBERATE ACT WITH A COMPILE ERROR
 * ATTACHED, WHICH IS THE POINT.
 */
export type StatusMeaning = "ties" | "check" | "blocks" | "statutory" | "neutral";

/**
 * ⚠️ `Record<StatusMeaning, string>` — NOT `Partial`, NOT an index
 * signature, NOT a `switch` with a `default`. Each of those three lets a
 * new member through silently, and the `default` case is the worst of
 * them because it renders something plausible.
 */
const PILL: Record<StatusMeaning, string> = {
  ties: "bg-[hsl(var(--ord-ties-bg))] text-[hsl(var(--ord-ties))]",
  check: "bg-[hsl(var(--ord-check-bg))] text-[hsl(var(--ord-check))]",
  blocks: "bg-[hsl(var(--ord-blocks-bg))] text-[hsl(var(--ord-blocks))]",
  statutory: "bg-[hsl(var(--ord-statutory-bg))] text-[hsl(var(--ord-statutory))]",
  neutral: "bg-[hsl(var(--ord-action-bg))] text-[hsl(var(--ord-action))]",
};

export interface StatusPillProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color"> {
  meaning: StatusMeaning;
  /** The words. Written by the screen, never derived from `meaning`. */
  label: string;
}

export const StatusPill = React.forwardRef<HTMLSpanElement, StatusPillProps>(
  ({ meaning, label, className, ...props }, ref) => (
    <span
      ref={ref}
      data-primitive="status-pill"
      data-meaning={meaning}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-[1.45]",
        PILL[meaning],
        className,
      )}
      {...props}
    >
      {label}
    </span>
  ),
);
StatusPill.displayName = "StatusPill";
