"use client";

/**
 * Ordence — The Generic Board
 * Version: v0.25.0-alpha
 *
 * `components/sales/pipeline-board.tsx`, generalised to any record type
 * and any groupable field.
 *
 * ⚠️ THAT FILE IS STILL THERE AND STILL WORKS. It is not deleted and it
 * is not a duplicate to be tidied away: the lead board knows things this
 * one cannot — that `won` is reached by registering a booking and must
 * not be offered as a drop target, that a lead with a live booking cannot
 * move backwards, what a "stale" follow-up looks like. Those are Phase 22
 * domain rules living in `lib/sales/pipeline.ts`, and a generic board that
 * tried to express them would have to grow a rules engine per object.
 *
 * The rule this file follows instead: THE BOARD MOVES CARDS, IT DOES NOT
 * DECIDE WHETHER THEY MAY MOVE. See `onMove` below.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS CARRIED OVER FROM THE LEAD BOARD, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 *   • ⭐ EVERY CARD HAS A REAL `<select>` AS WELL AS DRAG-AND-DROP. A
 *     Kanban that only responds to dragging is unusable with a keyboard,
 *     invisible to a screen reader, and unusable on a phone in a site
 *     office — which is where a sales executive actually stands. The drag
 *     is the fast path; the select is the guaranteed one.
 *
 *   • ⭐ TRUNCATION IS STATED. A column silently showing the first 50 of
 *     900 tells the reader those are all the records there are, and they
 *     stop looking. This board says so per column AND says when whole
 *     COLUMNS were dropped, which the hardcoded board never had to.
 *
 *   • The optimistic move is reversible and the failure is explained. A
 *     silent snap-back is worse than no optimism at all: the user sees
 *     the card move, sees it move again, and concludes the app is losing
 *     their work.
 */

import { useCallback, useMemo, useOptimistic, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";

export type BoardCardData = Record<string, unknown> & { id: string };

export type GenericBoardColumn = {
  /** The raw group value. `null` is a real column — "no owner", "no stage". */
  value: string | null;
  label: string;
  total: number;
  cards: BoardCardData[];
  truncated: boolean;
};

export type GenericBoardProps = {
  columns: GenericBoardColumn[];
  /** Field descriptors for the visible columns, in order, from the server. */
  fields: Array<{ name: string; label: string; kind: string }>;
  /** Which field the board is grouped by. Shown in the empty state. */
  groupLabel: string;
  /** The field to draw as a card's headline. Falls back to the first one. */
  titleField?: string;
  /** Build a link for a card, or omit for a board of un-clickable cards. */
  hrefFor?: (card: BoardCardData) => string;

  /**
   * ⭐ THE BOARD DOES NOT KNOW HOW TO WRITE, AND THAT IS THE POINT.
   *
   * Moving a card means updating a record — which is a different action,
   * a different permission and a different set of domain rules for every
   * object in the product. A generic board that issued the update itself
   * would need a table of "how to write to each object", which is exactly
   * the arbitrary-write primitive Phase 23 spends a file refusing to
   * build.
   *
   * So the owner of the page supplies `onMove`. It returns an error
   * string to refuse the move, or null to accept it. Omit it entirely and
   * the board is read-only — which is the correct default, because a
   * board over a field with no write path must not offer a drag that
   * silently does nothing.
   */
  onMove?: (card: BoardCardData, to: string | null) => Promise<string | null>;

  /** True when the caller is seeing only records they own. Announced. */
  scopedToOwnRecords?: boolean;
  /** True when there were more groups than the board draws. Announced. */
  columnsTruncated?: boolean;
  /** How many cards each column loaded, for the truncation note. */
  cardLimit: number;
};

export function GenericKanban({
  columns,
  fields,
  groupLabel,
  titleField,
  hrefFor,
  onMove,
  scopedToOwnRecords = false,
  columnsTruncated = false,
  cardLimit,
}: GenericBoardProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const [optimistic, applyOptimistic] = useOptimistic(
    columns,
    (state: GenericBoardColumn[], move: { id: string; to: string | null }) =>
      moveCard(state, move.id, move.to),
  );

  const cardsById = useMemo(() => {
    const map = new Map<string, { card: BoardCardData; column: string | null }>();
    for (const column of optimistic) {
      for (const card of column.cards) map.set(card.id, { card, column: column.value });
    }
    return map;
  }, [optimistic]);

  const headline = titleField ?? fields[0]?.name ?? "id";
  const detailFields = fields.filter((field) => field.name !== headline).slice(0, 3);

  const move = useCallback(
    (id: string, to: string | null) => {
      if (!onMove) return;
      const entry = cardsById.get(id);
      if (!entry || entry.column === to) return;

      setError(null);

      startTransition(async () => {
        applyOptimistic({ id, to });
        const failure = await onMove(entry.card, to);
        if (failure) {
          // ⚠️ No manual revert needed — `useOptimistic` discards the
          // optimistic state when the transition ends, so the card
          // returns to the server's answer. The message is what stops
          // that looking like a glitch.
          setError(failure);
        }
      });
    },
    [cardsById, applyOptimistic, onMove],
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

      {/*
        ⚠️ THE SCOPE IS SHOWN, NOT HIDDEN. A rep whose board holds 12 cards
        where their manager's holds 400 will report the difference as
        missing data unless the reason is on the screen — and the honest
        sentence is also the one that tells them who to ask.
      */}
      {scopedToOwnRecords ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          You are seeing only the records assigned to you. Ask an administrator for
          workspace-wide visibility if you need the rest.
        </p>
      ) : null}

      <div className="flex gap-3 overflow-x-auto pb-4" aria-busy={pending}>
        {optimistic.map((column) => (
          <section
            key={column.value ?? "__none"}
            aria-label={`${column.label} — ${column.total} records`}
            className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/30"
            onDragOver={(event) => {
              if (dragging && onMove) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData("text/plain") || dragging;
              setDragging(null);
              if (id) move(id, column.value);
            }}
          >
            <header className="flex items-baseline justify-between border-b border-border px-3 py-2">
              <h2 className="text-sm font-semibold">{column.label}</h2>
              <span className="text-xs tabular-nums text-muted-foreground">
                {column.total.toLocaleString("en-IN")}
              </span>
            </header>

            <div className="flex flex-col gap-2 p-2">
              {column.cards.map((card) => (
                <article
                  key={card.id}
                  draggable={Boolean(onMove)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", card.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragging(card.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={[
                    "rounded-md border border-border bg-card p-2.5 shadow-sm",
                    dragging === card.id ? "opacity-50" : "",
                  ].join(" ")}
                >
                  {hrefFor ? (
                    <a
                      href={hrefFor(card)}
                      className="text-sm font-medium hover:underline"
                    >
                      {display(card[headline])}
                    </a>
                  ) : (
                    <p className="text-sm font-medium">{display(card[headline])}</p>
                  )}

                  {detailFields.length > 0 ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {detailFields
                        .map((field) => display(card[field.name]))
                        .filter((value) => value !== "—")
                        .join(" · ") || "—"}
                    </p>
                  ) : null}

                  {/*
                    ⚠️ THE KEYBOARD PATH. Not a fallback — for anyone not
                    using a mouse this IS the interface, and it is the only
                    reason this board is operable on a phone.

                    Rendered only when the board can actually move a card.
                    A select that does nothing is worse than no select.
                  */}
                  {onMove ? (
                    <label className="mt-2 block">
                      <span className="sr-only">
                        Move this record to another {groupLabel.toLowerCase()}
                      </span>
                      <select
                        value={column.value ?? ""}
                        onChange={(event) =>
                          move(card.id, event.target.value === "" ? null : event.target.value)
                        }
                        className="w-full rounded border border-input bg-background px-1.5 py-1 text-[11px]"
                      >
                        {optimistic.map((target) => (
                          <option key={target.value ?? "__none"} value={target.value ?? ""}>
                            {target.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </article>
              ))}

              {column.cards.length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                  Nothing here
                </p>
              ) : null}

              {column.truncated ? (
                <div className="rounded border border-dashed border-border px-2 py-2 text-center">
                  <p className="text-[11px] text-muted-foreground">
                    Showing {column.cards.length} of {column.total.toLocaleString("en-IN")}
                  </p>
                </div>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Grouped by {groupLabel.toLowerCase()}. Each column loads up to {cardLimit}{" "}
          records.
        </span>
        {/*
          ⚠️ A BOARD OVER AN ARBITRARY FIELD CAN HAVE MORE COLUMNS THAN A
          SCREEN. Group by owner in a workspace with 300 people and the
          server draws the busiest few — saying so is the difference
          between "these are the groups" and "these are some of them".
        */}
        {columnsTruncated ? (
          <Badge variant="outline" className="text-[10px]">
            Some groups are not shown — there are more than this board can draw
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Render a value from an arbitrary record.
 *
 * ⚠️ EVERYTHING BECOMES A STRING AND NOTHING BECOMES HTML. React escapes
 * it, and this board draws customer content from tables whose shape it
 * does not control — including a Phase 24 runtime object whose columns a
 * customer named and filled. There is no `dangerouslySetInnerHTML` in
 * this file and there must never be one.
 */
function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toLocaleDateString("en-IN");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return "—";
  return String(value);
}

/**
 * Pure. Exported for the UI test — the same arrangement the lead board
 * uses, and for the same reason: the reordering is the part that has a
 * bug in it, and it is the part that does not need a DOM to test.
 */
export function moveCard(
  columns: GenericBoardColumn[],
  id: string,
  to: string | null,
): GenericBoardColumn[] {
  let moved: BoardCardData | null = null;

  const stripped = columns.map((column) => {
    const remaining = column.cards.filter((card) => {
      if (card.id !== id) return true;
      moved = card;
      return false;
    });
    if (remaining.length === column.cards.length) return column;
    return {
      ...column,
      cards: remaining,
      total: Math.max(0, column.total - 1),
    };
  });

  if (!moved) return columns;
  const card = moved as BoardCardData;

  return stripped.map((column) =>
    column.value === to
      ? { ...column, cards: [card, ...column.cards], total: column.total + 1 }
      : column,
  );
}
