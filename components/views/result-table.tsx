"use client";

/**
 * Ordence — The Generic Result Table
 * Version: v0.28.0-alpha
 *
 * Draws whatever `runView` returned: a column per descriptor, a row per
 * record, for any of the seven built-in objects and for a Phase 24
 * runtime object nobody has written a component for.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SORT HEADERS ARE THE ONLY INTERESTING PART
 * ══════════════════════════════════════════════════════════════════════
 * `aria-sort` goes on the `<th>`, and it must be `"none"` on the OTHER
 * sortable columns rather than absent. A table where only the sorted
 * column carries the attribute reads, to a screen reader, as a table with
 * exactly one sortable column — so the user never discovers that the
 * others can be sorted at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE HEADER USED TO SAY "UNSORTED" ABOUT SORTED ROWS — FIXED v0.31.0
 * ══════════════════════════════════════════════════════════════════════
 * A view that names no sort is not unsorted. `resolveRequest()` in
 * `server/views/query.ts` substitutes the object's `defaultSorts`, so the
 * first page of leads arrives in `updated_at desc` — while `sorts` here
 * was `[]` and EVERY sortable column rendered `aria-sort="none"`.
 *
 * Sighted users never noticed; the arrow glyph is small and they can see
 * the dates. A screen-reader user was told, with confidence, that a table
 * was unsorted when it was not — and then read rows in an order nothing
 * on the page accounted for. A wrong answer stated confidently is worse
 * than no answer, because there is nothing to prompt them to check.
 *
 * ⚠️ `defaultSorts` DRIVES THE INDICATOR AND NEVER THE CYCLE. The
 * indicator shows the order the rows are ACTUALLY in. `onSortChange`
 * still cycles from the caller's real `sorts`, which is empty — so the
 * first press of the default-sorted column produces `desc` and something
 * visibly changes. Cycling from the default instead would compute
 * "already ascending → clear it", clearing would fall back to the
 * default, and the header would be a button that does nothing.
 *
 * The control inside the header is a `<button>`, not an `onClick` on the
 * `<th>`. A clickable table cell is not in the tab order and cannot be
 * activated with a keyboard.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY CELL IS TEXT AND NOTHING IS HTML
 * ══════════════════════════════════════════════════════════════════════
 * This table renders customer content out of tables whose shape it does
 * not control — including a runtime object whose columns a customer named
 * and filled. There is no `dangerouslySetInnerHTML` in this file and
 * there must never be one. Same rule, same reason, as `generic-kanban.tsx`.
 */

import { Button } from "@/components/ui/button";
import type { SortSpec } from "@/lib/views/types";
import type { RenderField, ViewRow } from "./types";

export type ResultTableProps = {
  fields: RenderField[];
  rows: ViewRow[];
  sorts: SortSpec[];
  /**
   * The order the SERVER applies when `sorts` is empty.
   *
   * ⚠️ DISPLAY ONLY. See the header. Omit it and an unsorted-looking
   * view goes back to claiming `aria-sort="none"` about sorted rows.
   */
  defaultSorts?: readonly SortSpec[];
  /** Omit to make the headers plain text — a read-only result set. */
  onSortChange?: (sorts: SortSpec[]) => void;
  /** Which fields may be sorted at all, by name. Omit to allow all of them. */
  sortableFields?: ReadonlySet<string>;
  hrefFor?: (row: ViewRow) => string | null;
  total: number;
  page: number;
  pageSize: number;
  onPageChange?: (page: number) => void;
  scopedToOwnRecords?: boolean;
  emptyMessage?: string;
  busy?: boolean;
};

export function ResultTable({
  fields,
  rows,
  sorts,
  defaultSorts,
  onSortChange,
  sortableFields,
  hrefFor,
  total,
  page,
  pageSize,
  onPageChange,
  scopedToOwnRecords = false,
  emptyMessage = "No records match this view.",
  busy = false,
}: ResultTableProps) {
  /*
    ⚠️ `id` IS DROPPED FROM THE VISIBLE COLUMNS AND KEPT ON THE ROW.
    `resolveColumns` in the planner always selects it — every renderer
    keys rows by it and every row link needs it — but a column of uuids is
    forty characters of noise in the widest column of the table.
  */
  const visible = fields.filter((field) => field.name !== "id");
  const lastPage = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

  /*
    ⭐ WHAT THE ROWS ARE ACTUALLY ORDERED BY. Not what the view asked
    for — what came back. See the header for why the two differ and why
    only the indicator reads this.
  */
  const shown: readonly SortSpec[] = sorts.length > 0 ? sorts : (defaultSorts ?? []);

  return (
    <div className="flex flex-col gap-3" aria-busy={busy}>
      {scopedToOwnRecords ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          You are seeing only the records assigned to you. Ask an administrator for
          workspace-wide visibility if you need the rest.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {rows.length} of {total} records
          </caption>
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              {visible.map((field) => {
                const sortable =
                  Boolean(onSortChange) &&
                  (sortableFields ? sortableFields.has(field.name) : true);
                const at = shown.findIndex((sort) => sort.field === field.name);
                const direction = at >= 0 ? shown[at]!.direction : null;

                return (
                  <th
                    key={field.name}
                    scope="col"
                    className={[
                      "px-3 py-2 font-medium",
                      isNumericKind(field.kind) ? "text-right" : "",
                    ].join(" ")}
                    /*
                      ⭐ `"none"` ON EVERY SORTABLE COLUMN, not just on the
                      one in use. See the header.
                    */
                    aria-sort={
                      sortable
                        ? direction === "asc"
                          ? "ascending"
                          : direction === "desc"
                            ? "descending"
                            : "none"
                        : undefined
                    }
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onSortChange?.(nextSorts(sorts, field.name))}
                      >
                        <span>{field.label}</span>
                        {/*
                          ⚠️ The arrow is `aria-hidden` and the state is in
                          the `aria-sort` above. Two announcements of the
                          same fact is how a table header ends up read as
                          "Name ascending ascending".
                        */}
                        <span aria-hidden="true" className="text-[10px]">
                          {direction === "asc" ? "▲" : direction === "desc" ? "▼" : "↕"}
                        </span>
                      </button>
                    ) : (
                      field.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const href = hrefFor?.(row) ?? null;
              const key = typeof row.id === "string" ? row.id : `row-${index}`;

              return (
                <tr key={key} className="border-t border-border">
                  {visible.map((field, column) => {
                    const text = formatValue(row[field.name], field.kind);
                    return (
                      <td
                        key={field.name}
                        className={[
                          "px-3 py-2",
                          isNumericKind(field.kind) ? "text-right tabular-nums" : "",
                        ].join(" ")}
                      >
                        {column === 0 && href ? (
                          <a href={href} className="font-medium hover:underline">
                            {text}
                          </a>
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(1, visible.length)}
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Showing {rows.length.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}{" "}
          — page {page} of {lastPage}.
        </span>
        {onPageChange ? (
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              className="h-8 text-xs"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              Previous page
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-8 text-xs"
              disabled={page >= lastPage}
              onClick={() => onPageChange(page + 1)}
            >
              Next page
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SORT CYCLING                                                        */
/* ------------------------------------------------------------------ */

/**
 * One header press: unsorted → descending → ascending → unsorted.
 *
 * ⚠️ DESCENDING FIRST, AND IT IS NOT A COIN TOSS. Every default sort in
 * the registry that matters is descending — `updated_at`, `booked_at`,
 * `score`. Somebody pressing "Score" wants the highest first; giving them
 * the lowest first means every single use of the control takes two
 * presses.
 *
 * ⚠️ SINGLE-KEY, replacing whatever was there. Multi-key sorting from
 * header clicks needs a modifier nobody discovers, and the engine caps
 * the list at `MAX_SORTS` anyway. The saved view can hold several; the
 * header sets one.
 */
export function nextSorts(sorts: readonly SortSpec[], field: string): SortSpec[] {
  const current = sorts.find((sort) => sort.field === field) ?? null;
  if (!current) return [{ field, direction: "desc" }];
  if (current.direction === "desc") return [{ field, direction: "asc" }];
  return [];
}

/* ------------------------------------------------------------------ */
/* FORMATTING                                                          */
/* ------------------------------------------------------------------ */

function isNumericKind(kind: string): boolean {
  return kind === "number" || kind === "money";
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" });
const NUMBER_FORMAT = new Intl.NumberFormat("en-IN");

/**
 * A value from an arbitrary column, as text.
 *
 * ⚠️ `money` IS DIVIDED BY 100 WITH `BigInt`, NOT WITH `Number`. Minor
 * units are `bigint` in PostgreSQL and the driver hands them over as a
 * string precisely because `JSON.parse("87456330000000")` loses its last
 * digits past 2^53. Converting to a float here to divide by 100 puts the
 * precision loss back — on the agreement value of a flat.
 */
export function formatValue(value: unknown, kind: string): string {
  if (value === null || value === undefined || value === "") return "—";

  switch (kind) {
    case "money": {
      try {
        const minor = BigInt(String(value));
        const negative = minor < 0n;
        const absolute = negative ? -minor : minor;
        const major = absolute / 100n;
        const paise = absolute % 100n;
        return `${negative ? "-" : ""}₹${NUMBER_FORMAT.format(major)}.${paise
          .toString()
          .padStart(2, "0")}`;
      } catch {
        // A non-numeric value in a money column is a data defect, not a
        // reason to blank the cell — showing it is how it gets reported.
        return String(value);
      }
    }

    case "date": {
      const date = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : DATE_FORMAT.format(date);
    }

    case "boolean":
      return value ? "Yes" : "No";

    case "number":
      return typeof value === "number" ? NUMBER_FORMAT.format(value) : String(value);

    case "json":
      // ⚠️ Never stringified into the cell. A jsonb column can hold
      // kilobytes, and one row of it destroys the table's layout.
      return "—";

    default:
      if (typeof value === "object") return "—";
      return String(value);
  }
}
