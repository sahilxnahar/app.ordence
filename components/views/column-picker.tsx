"use client";

/**
 * Ordence — The Column Picker
 * Version: v0.28.0-alpha
 *
 * Which fields a table view shows, and in what order.
 *
 * ⚠️ ORDER IS PART OF THE ANSWER, NOT A PREFERENCE. The first column is
 * the one `ResultTable` turns into the link to the record, and the first
 * field is what `GenericKanban` draws as a card's headline. So the
 * reordering controls are not a nicety — moving "Name" to the top is how
 * a board stops showing forty cards labelled with a status.
 *
 * ⚠️ UP AND DOWN BUTTONS, NOT A DRAG. Same rule as the filter editor: a
 * list that can only be rearranged with a mouse cannot be rearranged by
 * everybody, and the HTML5 drag API is not keyboard-operable at all.
 */

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { MAX_VISIBLE_COLUMNS } from "@/lib/views/limits";
import type { ColumnSpec } from "@/lib/views/types";
import type { ViewObjectDescription } from "./types";

export type ColumnPickerProps = {
  object: ViewObjectDescription;
  columns: ColumnSpec[];
  onChange: (columns: ColumnSpec[]) => void;
};

export function ColumnPicker({ object, columns, onChange }: ColumnPickerProps) {
  const addId = useId();

  const byName = new Map(object.fields.map((field) => [field.name, field]));
  const chosen = new Set(columns.map((column) => column.field));

  /*
    ⚠️ `id` IS NOT OFFERED. The planner adds it to every result whether or
    not the view asks (see `resolveColumns`), and `ResultTable` hides it —
    so a person who "adds" it would see nothing change and conclude the
    control is broken.
  */
  const available = object.fields.filter(
    (field) => field.name !== "id" && !chosen.has(field.name) && field.kind !== "json",
  );

  const atLimit = columns.length >= MAX_VISIBLE_COLUMNS;

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= columns.length) return;
    const next = columns.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-1">
        {columns.map((column, index) => {
          const field = byName.get(column.field) ?? null;
          return (
            <li
              key={column.field}
              className="flex items-center gap-2 rounded border border-border px-2 py-1"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {field?.label ?? column.field}
                {index === 0 ? (
                  <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                    first column
                  </span>
                ) : null}
                {/*
                  ⚠️ A column naming a field the object no longer has is
                  SHOWN and removable rather than silently dropped. The
                  planner drops it at query time — correctly, so an old
                  view still opens — which means this list is the only
                  place anybody can find out why a column vanished.
                */}
                {!field ? (
                  <span className="ml-2 text-[10px] text-destructive">
                    no longer a field of {object.label}
                  </span>
                ) : null}
              </span>

              <Button
                type="button"
                variant="ghost"
                className="h-7 w-7 p-0 text-xs"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <span aria-hidden="true">↑</span>
                <span className="sr-only">
                  Move {field?.label ?? column.field} earlier
                </span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-7 w-7 p-0 text-xs"
                disabled={index === columns.length - 1}
                onClick={() => move(index, 1)}
              >
                <span aria-hidden="true">↓</span>
                <span className="sr-only">
                  Move {field?.label ?? column.field} later
                </span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-7 text-xs text-destructive"
                /*
                  ⚠️ The last column cannot be removed. `compileSelectList`
                  throws on an empty list — "a view must show at least one
                  column" — and a control that produces a refusal every
                  time it is pressed should not be pressable.
                */
                disabled={columns.length <= 1}
                onClick={() => onChange(columns.filter((_, at) => at !== index))}
              >
                <span aria-hidden="true">Remove</span>
                <span className="sr-only">
                  Remove the {field?.label ?? column.field} column
                </span>
              </Button>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm" htmlFor={addId}>
          <span>Add a column</span>
          <select
            id={addId}
            value=""
            disabled={atLimit || available.length === 0}
            onChange={(event) => {
              const name = event.target.value;
              if (!name || !byName.has(name)) return;
              onChange([...columns, { field: name }]);
            }}
            className="rounded border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="">Choose a field…</option>
            {available.map((field) => (
              <option key={field.name} value={field.name}>
                {field.label}
              </option>
            ))}
          </select>
        </label>

        {atLimit ? (
          <p className="text-xs text-muted-foreground">
            A view may show at most {MAX_VISIBLE_COLUMNS} columns. Beyond that the
            browser, not the database, is the bottleneck.
          </p>
        ) : null}
        {available.length === 0 && !atLimit ? (
          <p className="text-xs text-muted-foreground">
            Every field of {object.label} is already shown.
          </p>
        ) : null}
      </div>
    </div>
  );
}
