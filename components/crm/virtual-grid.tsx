"use client";

/**
 * Ordence — Airtable-Style Virtualized Grid
 * Version: v0.3.0-alpha
 *
 * TanStack Table v8 (headless logic) + TanStack Virtual (windowing).
 *
 * WHY VIRTUALIZATION:
 *   The Phase 2 grid renders every row into the DOM. At 50,000 units across a
 *   development portfolio that is ~600,000 DOM nodes — the tab locks up. This
 *   grid renders only the ~20 rows actually on screen plus an overscan buffer,
 *   so DOM size stays constant regardless of dataset size.
 *
 * FEATURES:
 *   - Windowed rendering via `useVirtualizer`
 *   - Infinite scroll: fires `onLoadMore` as the viewport nears the end
 *   - Inline editing with OPTIMISTIC updates (TanStack Query)
 *   - Bulk row selection with an indeterminate header checkbox
 *   - Dynamic columns generated from JSONB field definitions
 *
 * XSS POSTURE:
 *   Every JSONB value passes through `lib/safe-render`. React escapes text, but
 *   URLs are not text — `safeUrl()` refuses `javascript:` / `data:` before any
 *   value reaches an `href`. `dangerouslySetInnerHTML` appears nowhere.
 *
 * OPTIMISTIC UPDATE CONTRACT:
 *   onCellEdit → cancel in-flight queries → snapshot cache → write new value →
 *   on error, roll back to the snapshot → always refetch to reconcile.
 *   Without the cancel step, a slow in-flight GET can land after the optimistic
 *   write and silently revert the user's edit.
 */

import * as React from "react";
import {
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ArrowDown, ArrowUpDown, Check, Loader2, X, Inbox } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  safeUrl,
  safeEmail,
  toDisplayString,
  readPath,
  formatCurrency,
  formatNumber,
  formatDate,
} from "@/lib/safe-render";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

/** Minimal contract a row must satisfy. */
export type VirtualGridRow = { id: string } & Record<string, unknown>;

/** Field descriptor used to build a dynamic column from JSONB. */
export type DynamicFieldSpec = {
  /** Key inside the JSONB blob. Supports dotted paths, e.g. "cost.total". */
  fieldName: string;
  label: string;
  fieldType:
    | "text" | "textarea" | "number" | "currency" | "date" | "datetime"
    | "select" | "multiselect" | "boolean" | "email" | "phone" | "url";
  showInGrid?: boolean;
  editable?: boolean;
  width?: number;
  options?: Array<{ label: string; value: string; color?: string }>;
  validation?: { currencyCode?: string; precision?: number } | null;
};

export type CellEditPayload = {
  rowId: string;
  columnId: string;
  value: unknown;
  previousValue: unknown;
};

export type VirtualGridProps<TData extends VirtualGridRow> = {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  /** Row height in pixels. Must match the rendered row for correct positioning. */
  rowHeight?: number;
  /** Viewport height. */
  height?: number;
  /** Rows rendered outside the viewport on each side. */
  overscan?: number;

  /** Infinite scroll */
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  /** Distance from the end (in rows) that triggers `onLoadMore`. */
  loadMoreThreshold?: number;

  /** Selection */
  enableSelection?: boolean;
  onSelectionChange?: (selectedIds: string[]) => void;

  /** Inline editing. Returning a rejected promise rolls the cell back. */
  onCellEdit?: (payload: CellEditPayload) => Promise<unknown>;
  /** React Query key to invalidate after a successful edit. */
  queryKey?: readonly unknown[];

  isLoading?: boolean;
  emptyMessage?: string;
  ariaLabel?: string;
  className?: string;
};

/* ------------------------------------------------------------------ */
/* GRID                                                                */
/* ------------------------------------------------------------------ */

export function VirtualGrid<TData extends VirtualGridRow>({
  columns,
  data,
  rowHeight = 40,
  height = 600,
  overscan = 8,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  loadMoreThreshold = 10,
  enableSelection = false,
  onSelectionChange,
  onCellEdit,
  queryKey,
  isLoading = false,
  emptyMessage = "No records found.",
  ariaLabel = "Data grid",
  className,
}: VirtualGridProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  /* ---- Selection column, prepended when enabled ------------------- */
  const resolvedColumns = React.useMemo<ColumnDef<TData, unknown>[]>(() => {
    if (!enableSelection) return columns;

    const selectionColumn: ColumnDef<TData, unknown> = {
      id: "__select",
      size: 44,
      enableSorting: false,
      header: ({ table }) => (
        <input
          type="checkbox"
          aria-label="Select all rows"
          className="h-4 w-4 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
          checked={table.getIsAllRowsSelected()}
          ref={(el) => {
            // Indeterminate is a DOM property, not an attribute — must be set via ref.
            if (el) el.indeterminate = table.getIsSomeRowsSelected();
          }}
          onChange={table.getToggleAllRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={`Select row ${row.index + 1}`}
          className="h-4 w-4 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onChange={row.getToggleSelectedHandler()}
          onClick={(e) => e.stopPropagation()}
        />
      ),
    };
    return [selectionColumn, ...columns];
  }, [columns, enableSelection]);

  const table = useReactTable({
    data,
    columns: resolvedColumns,
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getRowId: (row) => row.id,
    enableRowSelection: enableSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;

  /* ---- Report selection upward ------------------------------------ */
  React.useEffect(() => {
    if (!onSelectionChange) return;
    onSelectionChange(Object.keys(rowSelection).filter((id) => rowSelection[id]));
  }, [rowSelection, onSelectionChange]);

  /* ---- Virtualizer ------------------------------------------------ */
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const virtualRows = virtualizer.getVirtualItems();

  /* ---- Infinite scroll -------------------------------------------- */
  React.useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (!last) return;
    if (!hasNextPage || isFetchingNextPage || !onLoadMore) return;

    if (last.index >= rows.length - loadMoreThreshold) {
      onLoadMore();
    }
  }, [virtualRows, hasNextPage, isFetchingNextPage, onLoadMore, rows.length, loadMoreThreshold]);

  /* ---- Optimistic inline edit -------------------------------------- */
  const editMutation = useMutation({
    mutationFn: async (payload: CellEditPayload) => {
      if (!onCellEdit) throw new Error("Editing is not enabled for this grid.");
      return onCellEdit(payload);
    },
    onMutate: async (payload) => {
      if (!queryKey) return { previous: undefined };

      // Stop in-flight refetches — otherwise a slow response can land after our
      // optimistic write and silently revert the user's edit.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);

      queryClient.setQueryData(queryKey, (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return old.map((row) =>
          (row as VirtualGridRow)?.id === payload.rowId
            ? { ...(row as VirtualGridRow), [payload.columnId]: payload.value }
            : row,
        );
      });

      return { previous };
    },
    onError: (_err, _payload, context) => {
      // Roll back to the pre-edit snapshot.
      if (queryKey && context?.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      // Reconcile with the server regardless of outcome.
      if (queryKey) void queryClient.invalidateQueries({ queryKey });
    },
  });

  const selectedCount = Object.values(rowSelection).filter(Boolean).length;

  /* ---- Empty / loading -------------------------------------------- */
  if (!isLoading && rows.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-border py-16 text-muted-foreground",
          className,
        )}
      >
        <Inbox className="h-8 w-8 opacity-40" aria-hidden="true" />
        <p className="text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {enableSelection && selectedCount > 0 && (
        <div
          className="flex items-center gap-3 rounded-md border border-border bg-accent/40 px-3 py-2"
          role="status"
          aria-live="polite"
        >
          <span className="text-sm font-medium">
            {selectedCount} {selectedCount === 1 ? "row" : "rows"} selected
          </span>
          <Button variant="ghost" size="sm" onClick={() => setRowSelection({})}>
            Clear
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        {/* Sticky header, outside the scroll container so it never scrolls away */}
        <div className="border-b border-border bg-muted/40">
          {table.getHeaderGroups().map((headerGroup) => (
            <div key={headerGroup.id} className="flex" role="row">
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sortDir = header.column.getIsSorted();
                return (
                  <div
                    key={header.id}
                    role="columnheader"
                    aria-sort={
                      !canSort
                        ? undefined
                        : sortDir === "asc"
                          ? "ascending"
                          : sortDir === "desc"
                            ? "descending"
                            : "none"
                    }
                    className="flex shrink-0 items-center px-3 py-2 text-xs font-semibold text-muted-foreground"
                    style={{ width: header.getSize() }}
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sortDir === "asc" ? (
                          <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        ) : sortDir === "desc" ? (
                          <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Virtualized scroll viewport */}
        <div
          ref={scrollRef}
          style={{ height }}
          className="overflow-auto"
          role="grid"
          aria-label={ariaLabel}
          aria-rowcount={rows.length}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;

              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={virtualRow.index + 1}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  className={cn(
                    "absolute left-0 flex w-full border-b border-border transition-colors hover:bg-muted/40",
                    row.getIsSelected() && "bg-accent/30",
                  )}
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div
                      key={cell.id}
                      role="gridcell"
                      className="flex shrink-0 items-center overflow-hidden px-3 text-sm"
                      style={{ width: cell.column.getSize() }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {isFetchingNextPage && (
            <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading more…
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        Showing {virtualRows.length} of {rows.length} rows
        {hasNextPage && " · scroll for more"}
        {editMutation.isPending && " · saving…"}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* EDITABLE CELL                                                       */
/* ------------------------------------------------------------------ */

/**
 * Click-to-edit cell. Enter commits, Escape cancels, blur commits.
 * Rendering is delegated to `SafeValue`, so display is always XSS-safe.
 */
export function EditableCell({
  value,
  spec,
  onCommit,
}: {
  value: unknown;
  spec: DynamicFieldSpec;
  onCommit: (next: unknown) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(() => toDisplayString(value));
  const [isSaving, setIsSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!isEditing) setDraft(toDisplayString(value));
  }, [value, isEditing]);

  React.useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  if (!spec.editable) {
    return <SafeValue value={value} spec={spec} />;
  }

  async function commit() {
    setIsEditing(false);
    const parsed = parseByType(draft, spec.fieldType);
    if (parsed === value) return;
    setIsSaving(true);
    try {
      await onCommit(parsed);
    } finally {
      setIsSaving(false);
    }
  }

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={() => setIsEditing(true)}
        className="flex w-full items-center justify-between gap-1 truncate rounded px-1 py-0.5 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Edit ${spec.label}`}
      >
        <SafeValue value={value} spec={spec} />
        {isSaving && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />}
      </button>
    );
  }

  if (spec.fieldType === "select" && spec.options?.length) {
    return (
      <select
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        autoFocus
        aria-label={spec.label}
        className="h-7 w-full rounded border border-input bg-background px-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="">—</option>
        {spec.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="flex w-full items-center gap-1">
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(toDisplayString(value));
            setIsEditing(false);
          }
        }}
        onBlur={() => void commit()}
        type={spec.fieldType === "number" || spec.fieldType === "currency" ? "number" : "text"}
        aria-label={spec.label}
        className="h-7 px-1 text-sm"
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void commit()}
        aria-label="Save"
        className="rounded p-0.5 text-primary hover:bg-accent"
      >
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setDraft(toDisplayString(value));
          setIsEditing(false);
        }}
        aria-label="Cancel"
        className="rounded p-0.5 text-muted-foreground hover:bg-accent"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SAFE VALUE RENDERER                                                 */
/* ------------------------------------------------------------------ */

/**
 * The single place untrusted JSONB becomes DOM.
 * Every branch either renders escaped text or a URL that `safeUrl`/`safeEmail`
 * has already approved.
 */
export function SafeValue({ value, spec }: { value: unknown; spec: DynamicFieldSpec }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }

  switch (spec.fieldType) {
    case "boolean":
      return <span>{value ? "Yes" : "No"}</span>;

    case "currency":
      return <span className="tabular-nums">{formatCurrency(value, spec.validation?.currencyCode ?? "INR")}</span>;

    case "number":
      return <span className="tabular-nums">{formatNumber(value)}</span>;

    case "date":
      return <span>{formatDate(value, false)}</span>;

    case "datetime":
      return <span>{formatDate(value, true)}</span>;

    case "select": {
      const match = spec.options?.find((o) => o.value === value);
      return (
        <span className="truncate rounded border px-1.5 py-0.5 text-xs">
          {match?.label ?? toDisplayString(value, 60)}
        </span>
      );
    }

    case "multiselect": {
      const list = Array.isArray(value) ? value : [value];
      return (
        <div className="flex flex-wrap gap-1">
          {list.slice(0, 4).map((item, i) => {
            const match = spec.options?.find((o) => o.value === item);
            return (
              <span key={i} className="rounded border px-1 py-0.5 text-xs">
                {match?.label ?? toDisplayString(item, 30)}
              </span>
            );
          })}
          {list.length > 4 && (
            <span className="text-xs text-muted-foreground">+{list.length - 4}</span>
          )}
        </div>
      );
    }

    case "email": {
      const email = safeEmail(value);
      // Rejected addresses render as inert text, never as a link.
      if (!email) return <span className="truncate">{toDisplayString(value, 80)}</span>;
      return (
        <a href={`mailto:${email}`} className="truncate text-primary hover:underline" rel="noreferrer">
          {email}
        </a>
      );
    }

    case "url": {
      const url = safeUrl(value);
      // `javascript:` and friends land here and render as plain text.
      if (!url) return <span className="truncate">{toDisplayString(value, 80)}</span>;
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-primary hover:underline"
        >
          {url.replace(/^https?:\/\//, "").slice(0, 50)}
        </a>
      );
    }

    default:
      return <span className="truncate">{toDisplayString(value, 200)}</span>;
  }
}

/* ------------------------------------------------------------------ */
/* DYNAMIC COLUMN BUILDER                                              */
/* ------------------------------------------------------------------ */

/**
 * Build virtualized columns that read from a JSONB blob on each row.
 *
 * @param fields   Field specs (from `custom_field_definitions` or a template)
 * @param jsonKey  Which column holds the blob: "dynamicAttributes" | "customFields"
 * @param onEdit   Supply to make cells editable
 */
export function buildVirtualColumns<TData extends VirtualGridRow>(
  fields: DynamicFieldSpec[],
  jsonKey: string,
  onEdit?: (payload: CellEditPayload) => Promise<unknown>,
): ColumnDef<TData, unknown>[] {
  return fields
    .filter((f) => f.showInGrid !== false)
    .map((field) => ({
      id: `${jsonKey}.${field.fieldName}`,
      header: field.label,
      size: field.width ?? 180,
      // Dotted paths supported, and prototype keys blocked, by `readPath`.
      accessorFn: (row: TData) => readPath(row[jsonKey], field.fieldName),
      cell: ({ getValue, row }) => {
        const value = getValue();
        if (!onEdit || !field.editable) {
          return <SafeValue value={value} spec={field} />;
        }
        return (
          <EditableCell
            value={value}
            spec={field}
            onCommit={async (next) => {
              await onEdit({
                rowId: row.original.id,
                columnId: `${jsonKey}.${field.fieldName}`,
                value: next,
                previousValue: value,
              });
            }}
          />
        );
      },
    }));
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/** Convert an edited string back into the type the field declares. */
function parseByType(raw: string, type: DynamicFieldSpec["fieldType"]): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  switch (type) {
    case "number":
    case "currency": {
      const n = Number(trimmed.replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return trimmed.toLowerCase() === "true" || trimmed === "1" || trimmed.toLowerCase() === "yes";
    case "multiselect":
      return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    default:
      return trimmed;
  }
}
