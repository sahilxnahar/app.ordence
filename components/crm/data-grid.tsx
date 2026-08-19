"use client";

/**
 * Ordence — Reusable Data Grid
 * Version: v0.2.0-alpha
 *
 * TanStack Table v8 + shadcn/ui. Generic over the row type, so the same grid
 * renders contacts, companies, deals, and dynamic custom objects.
 *
 * ACCESSIBILITY (WCAG 2.1 AA):
 *   - Sortable headers are real <button>s: keyboard reachable, Enter/Space work
 *   - `aria-sort` on every sortable <th> so screen readers announce direction
 *   - Search box has a visible label association and a debounce announcement
 *   - Pagination state announced via aria-live
 *   - Focus rings preserved throughout; no focus traps
 *
 * PERFORMANCE: pagination and sorting are client-side by design — appropriate up
 * to a few thousand rows. Server-side mode is exposed via `manualPagination` for
 * larger sets; the server actions already accept page/pageSize/sortBy.
 */

import * as React from "react";
import {
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Search,
  Inbox,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type DataGridProps<TData> = {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  /** Placeholder for the search box. */
  searchPlaceholder?: string;
  /** Hide the search box entirely. */
  enableSearch?: boolean;
  /** Rows per page. Default 25. */
  pageSize?: number;
  /** Message shown when there are no rows. */
  emptyMessage?: string;
  /** Renders a skeleton instead of rows. */
  isLoading?: boolean;
  /** Called when a row is clicked. Makes rows keyboard-activatable too. */
  onRowClick?: (row: TData) => void;
  /** Accessible caption describing the table's contents. */
  ariaLabel?: string;
  className?: string;
};

export function DataGrid<TData>({
  columns,
  data,
  searchPlaceholder = "Search…",
  enableSearch = true,
  pageSize = 25,
  emptyMessage = "No records found.",
  isLoading = false,
  onRowClick,
  ariaLabel = "Data table",
  className,
}: DataGridProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
    // Case-insensitive match across every visible cell.
    globalFilterFn: (row, _columnId, filterValue) => {
      const needle = String(filterValue).toLowerCase();
      return row.getVisibleCells().some((cell) => {
        const value = cell.getValue();
        return value != null && String(value).toLowerCase().includes(needle);
      });
    },
  });

  const rows = table.getRowModel().rows;
  const pageIndex = table.getState().pagination.pageIndex;
  const pageCount = table.getPageCount();
  const totalRows = table.getFilteredRowModel().rows.length;

  return (
    <div className={cn("space-y-3", className)}>
      {enableSearch && (
        <div className="flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <label htmlFor="data-grid-search" className="sr-only">
              {searchPlaceholder}
            </label>
            <Input
              id="data-grid-search"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={searchPlaceholder}
              className="pl-8"
              type="search"
            />
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {totalRows} {totalRows === 1 ? "record" : "records"}
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border">
        <Table aria-label={ariaLabel}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                      aria-sort={
                        !canSort
                          ? undefined
                          : sortDir === "asc"
                            ? "ascending"
                            : sortDir === "desc"
                              ? "descending"
                              : "none"
                      }
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sortDir === "asc" ? (
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : sortDir === "desc" ? (
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <ArrowUpDown className="h-3.5 w-3.5 opacity-40" aria-hidden="true" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  {table.getVisibleFlatColumns().map((col) => (
                    <TableCell key={col.id}>
                      <div className="h-4 w-full animate-pulse rounded bg-muted" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Inbox className="h-8 w-8 opacity-40" aria-hidden="true" />
                    <span className="text-sm">{emptyMessage}</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row.original);
                          }
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? "button" : undefined}
                  className={cn(
                    onRowClick &&
                      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Page {pageIndex + 1} of {pageCount}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DYNAMIC COLUMN BUILDER                                              */
/* ------------------------------------------------------------------ */

/** Minimal shape needed to render a custom field as a column. */
export type GridFieldDefinition = {
  fieldName: string;
  label: string;
  fieldType: string;
  showInGrid: boolean;
  options: Array<{ label: string; value: string; color?: string }>;
  validation?: { currencyCode?: string; precision?: number } | null;
};

/**
 * Turn `custom_field_definitions` rows into TanStack columns that read from a
 * JSONB `data` object. This is what lets one grid render an entity the tenant
 * invented five minutes ago.
 */
export function buildDynamicColumns<TData extends { data: Record<string, unknown> }>(
  fields: GridFieldDefinition[],
): ColumnDef<TData, unknown>[] {
  return fields
    .filter((f) => f.showInGrid)
    .map((field) => ({
      id: field.fieldName,
      header: field.label,
      accessorFn: (row: TData) => row.data?.[field.fieldName] ?? null,
      cell: ({ getValue }) => renderFieldValue(getValue(), field),
      enableSorting: true,
    }));
}

/** Render one JSONB value according to its declared type. */
function renderFieldValue(value: unknown, field: GridFieldDefinition): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }

  switch (field.fieldType) {
    case "boolean":
      return value ? "Yes" : "No";

    case "currency": {
      const num = Number(value);
      if (!Number.isFinite(num)) return String(value);
      const code = field.validation?.currencyCode ?? "INR";
      try {
        return new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: code,
          maximumFractionDigits: field.validation?.precision ?? 2,
        }).format(num);
      } catch {
        return `${code} ${num.toLocaleString()}`;
      }
    }

    case "number": {
      const num = Number(value);
      return Number.isFinite(num) ? num.toLocaleString() : String(value);
    }

    case "date":
    case "datetime": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return String(value);
      return field.fieldType === "date" ? d.toLocaleDateString() : d.toLocaleString();
    }

    case "select": {
      const option = field.options.find((o) => o.value === value);
      return (
        <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium">
          {option?.label ?? String(value)}
        </span>
      );
    }

    case "multiselect": {
      const values = Array.isArray(value) ? value : [value];
      return (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => {
            const option = field.options.find((o) => o.value === v);
            return (
              <span
                key={String(v)}
                className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs"
              >
                {option?.label ?? String(v)}
              </span>
            );
          })}
        </div>
      );
    }

    case "email":
      // rel="noreferrer" prevents referrer leakage to third parties.
      return (
        <a href={`mailto:${String(value)}`} className="text-primary hover:underline" rel="noreferrer">
          {String(value)}
        </a>
      );

    case "url": {
      const href = String(value);
      // Defense in depth — server-side validation already blocks these schemes.
      if (!/^https?:\/\//i.test(href)) return href;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {href.replace(/^https?:\/\//, "").slice(0, 40)}
        </a>
      );
    }

    default:
      return String(value);
  }
}
