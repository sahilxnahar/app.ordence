"use client";

/**
 * Ordence — The Pipeline Board
 * Version: v0.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY DRAG-AND-DROP IS NOT THE ONLY WAY TO MOVE A CARD
 * ══════════════════════════════════════════════════════════════════════
 * A Kanban board that ONLY responds to dragging is unusable with a
 * keyboard and invisible to a screen reader. It is also unusable on a
 * phone in a site office, which is where a sales executive actually
 * stands.
 *
 * So every card carries a real `<select>` of stages as well. The drag is
 * the fast path; the select is the guaranteed one, and it is what makes
 * the board operable by anyone.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE OPTIMISTIC UPDATE HAS TO BE REVERSIBLE
 * ══════════════════════════════════════════════════════════════════════
 * The card moves immediately, because a board that waits for a round
 * trip feels broken. But the server can legitimately refuse — a lead
 * with a live booking cannot go backwards, a lost lead needs a reason —
 * and when it does, the card must return to where it was AND say why.
 *
 * A silent snap-back is worse than no optimism at all: the rep sees the
 * card move, sees it move again, and concludes the app is losing their
 * work.
 */

import { useCallback, useMemo, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { transitionLead } from "@/server/actions/sales-leads";
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  SOURCE_LABELS,
  canTransition,
  BOARD_COLUMN_LIMIT,
} from "@/lib/sales/pipeline";
import type { LeadStatus, LeadTemperature, LeadSource } from "@/db/schema/sales";

export type BoardCard = {
  id: string;
  reference: string;
  name: string;
  status: LeadStatus;
  temperature: LeadTemperature;
  source: LeadSource;
  score: number;
  locality: string | null;
  isNri: boolean;
  urgency: "none" | "scheduled" | "due" | "overdue" | "stale";
  hasLiveBooking: boolean;
};

export type BoardData = {
  status: LeadStatus;
  total: number;
  shown: number;
  truncated: boolean;
  leads: BoardCard[];
};

const TEMPERATURE_STYLES: Record<LeadTemperature, string> = {
  hot: "bg-red-500/10 text-red-600 border-red-500/20",
  warm: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  cold: "bg-slate-500/10 text-slate-500 border-slate-500/20",
};

const URGENCY_STYLES: Record<BoardCard["urgency"], string | null> = {
  none: null,
  scheduled: null,
  due: "border-l-amber-500",
  overdue: "border-l-orange-600",
  // ⚠️ Stale reads differently from overdue on purpose. Three weeks late
  // is an abandoned lead that should go back in the pool, not a call
  // somebody is running behind on.
  stale: "border-l-red-600",
};

const URGENCY_LABELS: Record<BoardCard["urgency"], string | null> = {
  none: null,
  scheduled: null,
  due: "Due today",
  overdue: "Overdue",
  stale: "Stale — no contact in weeks",
};

export function PipelineBoard({ columns }: { columns: BoardData[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const [optimistic, applyOptimistic] = useOptimistic(
    columns,
    (state: BoardData[], move: { id: string; to: LeadStatus }) =>
      moveCard(state, move.id, move.to),
  );

  const cardsById = useMemo(() => {
    const map = new Map<string, BoardCard>();
    for (const column of optimistic) {
      for (const card of column.leads) map.set(card.id, card);
    }
    return map;
  }, [optimistic]);

  const move = useCallback(
    (id: string, to: LeadStatus) => {
      const card = cardsById.get(id);
      if (!card || card.status === to) return;

      // The SAME function the server action runs. Two copies of this rule
      // is how a board offers a move the server then refuses.
      const verdict = canTransition({
        from: card.status,
        to,
        hasLiveBooking: card.hasLiveBooking,
      });

      if (!verdict.allowed) {
        setError(`${verdict.reason} ${verdict.remedy}`);
        return;
      }

      setError(null);

      startTransition(async () => {
        applyOptimistic({ id, to });
        const result = await transitionLead({ id, status: to });
        if (!result.ok) {
          // ⚠️ No manual revert needed — `useOptimistic` discards the
          // optimistic state when the transition ends, so the card
          // returns to the server's answer. The message is what stops
          // that looking like a glitch.
          setError(result.error);
        }
      });
    },
    [cardsById, applyOptimistic],
  );

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex gap-3 overflow-x-auto pb-4" aria-busy={pending}>
        {optimistic.map((column) => (
          <section
            key={column.status}
            aria-label={`${STAGE_LABELS[column.status]} — ${column.total} leads`}
            className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/30"
            onDragOver={(event) => {
              if (dragging) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData("text/plain") || dragging;
              setDragging(null);
              if (id) move(id, column.status);
            }}
          >
            <header className="flex items-baseline justify-between border-b border-border px-3 py-2">
              <h2 className="text-sm font-semibold">{STAGE_LABELS[column.status]}</h2>
              <span className="text-xs tabular-nums text-muted-foreground">
                {column.total.toLocaleString("en-IN")}
              </span>
            </header>

            <div className="flex flex-col gap-2 p-2">
              {column.leads.map((card) => (
                <article
                  key={card.id}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", card.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragging(card.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={[
                    "rounded-md border border-l-4 border-border bg-card p-2.5 shadow-sm",
                    URGENCY_STYLES[card.urgency] ?? "border-l-transparent",
                    dragging === card.id ? "opacity-50" : "",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/sales/leads/${card.id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {card.name}
                    </Link>
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${TEMPERATURE_STYLES[card.temperature]}`}
                    >
                      {card.temperature}
                    </span>
                  </div>

                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {card.reference} · {SOURCE_LABELS[card.source]}
                    {card.locality ? ` · ${card.locality}` : ""}
                  </p>

                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {card.isNri ? (
                      <Badge variant="outline" className="text-[10px]">
                        NRI
                      </Badge>
                    ) : null}
                    {URGENCY_LABELS[card.urgency] ? (
                      <Badge variant="outline" className="text-[10px]">
                        {URGENCY_LABELS[card.urgency]}
                      </Badge>
                    ) : null}
                    <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                      {card.score}
                    </span>
                  </div>

                  {/*
                    ⚠️ THE KEYBOARD PATH. Not a fallback — for anyone not
                    using a mouse this IS the interface, and it is the
                    only reason this board is operable on a phone.
                  */}
                  <label className="mt-2 block">
                    <span className="sr-only">Move {card.name} to another stage</span>
                    <select
                      value={card.status}
                      onChange={(event) => move(card.id, event.target.value as LeadStatus)}
                      className="w-full rounded border border-input bg-background px-1.5 py-1 text-[11px]"
                    >
                      {PIPELINE_STAGES.map((stage) => (
                        <option key={stage} value={stage}>
                          {STAGE_LABELS[stage]}
                        </option>
                      ))}
                      {/*
                        `lost` is present because it is reachable; `won`
                        is NOT, because a lead is won by registering a
                        booking. Offering it here would produce a refusal
                        every single time it was chosen.
                      */}
                      <option value="lost">{STAGE_LABELS.lost}</option>
                    </select>
                  </label>
                </article>
              ))}

              {column.leads.length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                  Nothing here
                </p>
              ) : null}

              {/*
                ⚠️ THE TRUNCATION IS STATED. A board silently showing the
                first 50 of 900 tells the rep those are all the leads
                there are, and they stop looking.
              */}
              {column.truncated ? (
                <div className="rounded border border-dashed border-border px-2 py-2 text-center">
                  <p className="text-[11px] text-muted-foreground">
                    Showing {column.shown} of {column.total.toLocaleString("en-IN")}
                  </p>
                  <Button asChild variant="ghost" className="mt-1 h-7 text-[11px]">
                    <Link href={`/sales/leads?status=${column.status}`}>
                      See all {STAGE_LABELS[column.status].toLowerCase()}
                    </Link>
                  </Button>
                </div>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Each column loads up to {BOARD_COLUMN_LIMIT} leads, highest score first.
        Drag a card, or use the stage selector on it.
      </p>
    </div>
  );
}

/** Pure. Exported for the UI test. */
export function moveCard(
  columns: BoardData[],
  id: string,
  to: LeadStatus,
): BoardData[] {
  let moved: BoardCard | null = null;

  const stripped = columns.map((column) => {
    const remaining = column.leads.filter((card) => {
      if (card.id !== id) return true;
      moved = card;
      return false;
    });
    if (remaining.length === column.leads.length) return column;
    return {
      ...column,
      leads: remaining,
      total: Math.max(0, column.total - 1),
      shown: remaining.length,
    };
  });

  if (!moved) return columns;
  const card: BoardCard = { ...(moved as BoardCard), status: to };

  return stripped.map((column) =>
    column.status === to
      ? {
          ...column,
          leads: [card, ...column.leads],
          total: column.total + 1,
          shown: column.leads.length + 1,
        }
      : column,
  );
}
