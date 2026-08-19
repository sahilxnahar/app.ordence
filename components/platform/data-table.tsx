"use client";

/**
 * Ordence — ⭐⭐ THE CONSOLE TABLE WHOSE VIEW IS A LINK
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE COMPLAINT THIS EXISTS TO ANSWER
 * ══════════════════════════════════════════════════════════════════════
 * "The console is not usable." Not "sorting is missing" — usable. An
 * operator narrows four hundred workspaces to the six that matter, opens
 * one, comes back, and the six are gone. They cannot hand the view to a
 * colleague either: "the overdue Karnataka workspaces, sorted by MRR" is
 * a sentence plus twelve clicks of instructions.
 *
 * ⭐ SO SORT, FILTER, PAGE AND SELECTION ALL LIVE IN THE QUERY STRING.
 * A filtered view survives a refresh and a back button, and it is a link
 * somebody can paste into a ticket. That is the whole idea; everything
 * below is in service of it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `id` IS NOT DECORATION — IT IS THE NAMESPACE
 * ══════════════════════════════════════════════════════════════════════
 * A workspace detail page shows users and invoices on one screen.
 * Unprefixed `?sort=name` would sort both tables and paging one would
 * page the other. Every parameter this component reads or writes is
 * `<id>_…`, built by `dataTableParamKeys()` so a server page reading the
 * same request cannot drift from what the browser writes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `mode` DECIDES WHO SORTS, AND GETTING IT WRONG IS SILENT
 * ══════════════════════════════════════════════════════════════════════
 *   "client" (default) — this component sorts, filters and pages the
 *   `rows` it was given. Correct only when `rows` is the WHOLE list.
 *
 *   "server" — the page already ran the query with
 *   `readDataTableParams()`; `rows` is one page of it and `total` is the
 *   real count. This component then only writes the URL and renders.
 *
 * 🔴 USING "client" WITH A SERVER-PAGED LIST PRODUCES A TABLE THAT LOOKS
 * ORDERED AND IS NOT — it sorts the fifty rows that happen to be loaded,
 * so "highest MRR" means "highest MRR on this page". Nothing in the type
 * system can catch that, which is why it is written here in capitals.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT HERE
 * ══════════════════════════════════════════════════════════════════════
 *   • No `localStorage` / `sessionStorage`. A view remembered in storage
 *     cannot be shared, and two operators looking at "the same" screen
 *     during an incident see different lists.
 *   • No websocket. Live data is `router.refresh()` on an interval,
 *     PAUSED while the tab is hidden — Railway behind a proxy with
 *     multiple instances is not where you want to debug a socket.
 *   • No colour-only state. Every state here is a WORD; roughly one in
 *     twelve Indian men is colour-blind and an empty grey area is
 *     indistinguishable from a broken one.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { TablePager } from "@/components/platform/table-pager";
import {
  dataTableParamKeys,
  type SortDir,
} from "@/lib/platform/data-table-params";

/**
 * 🔴 TYPES ONLY. `dataTableParamKeys()` AND `readDataTableParams()` ARE
 * DELIBERATELY NOT RE-EXPORTED FROM HERE.
 *
 * Next.js turns EVERY export of a `"use client"` module into a client
 * reference. A server page doing
 *
 *     import { readDataTableParams } from "@/components/platform/data-table";
 *
 * would compile, ship, and then throw at request time — "attempted to
 * call ... from the server" — on the page, not in the build. Server code
 * imports those two functions from `@/lib/platform/data-table-params`,
 * which is a plain module both sides may have.
 *
 * A re-export here would be a convenience that costs a production 500.
 */
export type {
  SortDir,
  DataTableQuery,
  DataTableParamKeys,
} from "@/lib/platform/data-table-params";

/* ------------------------------------------------------------------ */
/* THE COLUMN CONTRACT                                                 */
/* ------------------------------------------------------------------ */

/**
 * What an accessor may return.
 *
 * 🔴 `bigint` IS IN THIS UNION ON PURPOSE. Money in this product is
 * bigint minor units everywhere. An accessor that returns
 * `Number(row.mrrMinor)` to make sorting "simpler" silently loses
 * precision above ₹90,00,00,000 and there is no error when it does.
 */
export type DataTableValue = string | number | bigint | boolean | null | undefined;

export type DataTableColumn<TRow> = {
  /**
   * Stable identifier. It is also the value written to `?<id>_sort`, so
   * changing it invalidates links people have already sent.
   */
  key: string;
  /** Plain text. Used as the `<th>`, and as the label on the mobile card. */
  header: string;
  /**
   * The comparable/searchable value behind the cell. Required for
   * `sortable`, and used by the default free-text search.
   *
   * ⚠️ Return the raw value, not the formatted one. `formatMoney()`
   * output sorts as text: "₹9" lands after "₹10,00,000".
   */
  accessor?: (row: TRow) => DataTableValue;
  /** No accessor → not sortable, whatever this says. */
  sortable?: boolean;
  /** Omitted → the accessor's value is rendered as text. */
  cell?: (row: TRow) => ReactNode;
  align?: "left" | "right";
  className?: string;
  /**
   * Kept out of the phone layout. Use it for the third supporting number,
   * never for the column that carries the row's meaning.
   */
  hideOnMobile?: boolean;
};

export type DataTableFilterOption = {
  /** "" is reserved: it is the "no filter" option and is never matched. */
  value: string;
  label: string;
};

export type DataTableFilter<TRow> = {
  key: string;
  label: string;
  options: readonly DataTableFilterOption[];
  /**
   * Client mode only. In server mode the page already applied the filter
   * via `readDataTableParams()`, and a `match` here would apply it twice.
   */
  match?: (row: TRow, value: string) => boolean;
  /** Shown under the control, e.g. what the filter does NOT cover. */
  hint?: string;
};

export type DataTableStatus = "ready" | "loading" | "error";

export type DataTableProps<TRow> = {
  /**
   * 🔴 REQUIRED, AND UNIQUE PER TABLE ON A PAGE. It prefixes every query
   * parameter this table owns. Two tables sharing an `id` share a sort.
   */
  id: string;
  rows: readonly TRow[];
  columns: readonly DataTableColumn<TRow>[];
  /** Must be stable across renders — it keys React and keys selection. */
  rowId: (row: TRow) => string;
  /**
   * Describes the table to a screen reader and names the thing being
   * counted: "412 workspaces." Required because "412 rows" is what a
   * table says when nobody decided what it holds.
   */
  caption: string;
  /** Plural noun for counts. Defaults to a lowercased `caption`. */
  unit?: string;

  /** See the header. Default "client". */
  mode?: "client" | "server";
  /** Server mode: the real row count behind this page. */
  total?: number;
  /** Default 25. In server mode it must match the page's own limit. */
  pageSize?: number;

  status?: DataTableStatus;
  /** Rendered as an alert when `status === "error"`. */
  error?: string | null;
  /** Shown when there are no rows AND no filter is narrowing them. */
  emptyTitle?: string;
  emptyHint?: string;

  selectable?: boolean;
  /**
   * Controlled selection. Omit and the URL is the source of truth, which
   * is what makes a selected batch survive a refresh.
   */
  selectedIds?: readonly string[];
  /**
   * 🔴 THESE IDS CAME FROM THE BROWSER'S ADDRESS BAR. They are a
   * convenience, never a permission. Anyone can type
   * `?t_sel=<any-uuid>,<any-other-uuid>`; nothing here proves the rows
   * exist, belong to a workspace this operator may touch, or are still in
   * a state the action allows.
   *
   * 🔴 THE PARENT MUST RE-CHECK EVERY ID SERVER-SIDE — re-fetch each one
   * inside the same capability check it would apply to a single row, and
   * drop whatever does not come back. Never pass this array to a bulk
   * `WHERE id IN (…)` and call it authorised.
   */
  onSelectionChange?: (ids: string[]) => void;

  searchable?: boolean;
  searchLabel?: string;
  searchPlaceholder?: string;
  /**
   * Client mode: the text one row is searched against. Defaults to every
   * column accessor joined by a space.
   */
  searchText?: (row: TRow) => string;

  filters?: readonly DataTableFilter<TRow>[];

  /** Applied when the URL names no sort. */
  defaultSort?: { key: string; dir: SortDir };

  /**
   * Poll interval in ms for live screens. `router.refresh()`, PAUSED
   * while the tab is hidden — a backgrounded console tab left open
   * overnight must not keep hitting the database.
   */
  refreshMs?: number;

  /** Right-hand controls per row. Rendered in an extra trailing column. */
  rowActions?: (row: TRow) => ReactNode;
  /** Enter on the keyboard-focused row. Optional. */
  onRowActivate?: (row: TRow) => void;

  /** Extra controls beside the search box, e.g. a bulk-action button. */
  toolbar?: ReactNode;
  className?: string;
};

/* ------------------------------------------------------------------ */
/* SORTING                                                             */
/* ------------------------------------------------------------------ */

const isBlank = (v: DataTableValue) => v === null || v === undefined || v === "";

/**
 * 🔴 NEVER `Number(bigint)`. Two bigints are compared as bigints; a mixed
 * pair falls through to a numeric-aware string compare, which is still
 * exact for digit strings. Widening money to a float to "simplify the
 * comparator" is how a sort quietly disagrees with the invoice.
 */
function compareValues(a: DataTableValue, b: DataTableValue): number {
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function renderValue(v: DataTableValue): ReactNode {
  if (isBlank(v)) return <span className="text-muted-foreground">—</span>;
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/* ------------------------------------------------------------------ */
/* THE COMPONENT                                                       */
/* ------------------------------------------------------------------ */

export function DataTable<TRow>({
  id,
  rows,
  columns,
  rowId,
  caption,
  unit,
  mode = "client",
  total,
  pageSize = 25,
  status = "ready",
  error = null,
  emptyTitle,
  emptyHint,
  selectable = false,
  selectedIds,
  onSelectionChange,
  searchable = false,
  searchLabel = "Filter",
  searchPlaceholder = "Type to narrow this list",
  searchText,
  filters,
  defaultSort,
  refreshMs,
  rowActions,
  onRowActivate,
  toolbar,
  className,
}: DataTableProps<TRow>) {
  const router = useRouter();
  const pathname = usePathname();
  /**
   * ⚠️ `useSearchParams()` opts this subtree into dynamic rendering. Every
   * console page is already `export const dynamic = "force-dynamic"`, so
   * there is nothing to suspend around here. On a statically rendered
   * page it would need a `<Suspense>` boundary.
   */
  const searchParams = useSearchParams();
  const qs = searchParams?.toString() ?? "";

  const keys = useMemo(() => dataTableParamKeys(id), [id]);
  const noun = unit ?? caption.toLowerCase();

  const read = useCallback(
    (key: string): string => {
      const params = new URLSearchParams(qs);
      return params.get(key) ?? "";
    },
    [qs],
  );

  /**
   * ⚠️ `replace`, not `push`, and `scroll: false`. Sorting a table is not
   * a navigation: pushing would make the back button undo a sort one step
   * at a time, and scrolling to the top after re-sorting throws away the
   * operator's place in a four-hundred-row list.
   */
  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(qs);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const built = next.toString();
      router.replace(built ? `${pathname}?${built}` : pathname, { scroll: false });
    },
    [qs, pathname, router],
  );

  /* ---------------- state, read back out of the URL ---------------- */

  const sortableKeys = useMemo(
    () => columns.filter((c) => c.sortable && c.accessor).map((c) => c.key),
    [columns],
  );

  const rawSort = read(keys.sort);
  const sortKey = sortableKeys.includes(rawSort) ? rawSort : (defaultSort?.key ?? null);
  const rawDir = read(keys.dir);
  const sortDir: SortDir =
    rawDir === "asc" || rawDir === "desc" ? rawDir : (defaultSort?.dir ?? "asc");

  const query = read(keys.q);

  const filterValues = useMemo(() => {
    const out: Record<string, string> = {};
    const params = new URLSearchParams(qs);
    for (const f of filters ?? []) out[f.key] = params.get(keys.filter(f.key)) ?? "";
    return out;
  }, [filters, keys, qs]);

  const anyNarrowing =
    query.length > 0 || Object.values(filterValues).some((v) => v.length > 0);

  const rawPage = Number.parseInt(read(keys.page), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  /* ---------------- selection ---------------- */

  const selParam = read(keys.sel);
  const urlSelected = useMemo(
    () => selParam.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    [selParam],
  );
  const effectiveSelection = selectedIds ? [...selectedIds] : urlSelected;
  // Keyed on the joined string, not the array: a parent that rebuilds
  // `selectedIds` every render would otherwise rebuild the Set every
  // render and re-run everything downstream of it.
  const selectionKey = effectiveSelection.join(",");
  const selectedSet = useMemo(
    () => new Set(selectionKey ? selectionKey.split(",") : []),
    [selectionKey],
  );

  /**
   * ⚠️ Reported through a ref-guarded effect rather than straight from the
   * click handler, because a selection can also arrive in a pasted URL —
   * the parent has to hear about that one too, and it never passes
   * through a handler.
   */
  const lastReported = useRef<string | null>(null);
  useEffect(() => {
    if (!onSelectionChange) return;
    if (lastReported.current === selParam) return;
    lastReported.current = selParam;
    onSelectionChange(selParam.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }, [selParam, onSelectionChange]);

  const writeSelection = useCallback(
    (ids: string[]) => {
      // Paging resets, sorting does not: a selection is about rows, and
      // losing it because you sorted would make bulk work impossible.
      setParams({ [keys.sel]: ids.length ? ids.join(",") : null });
    },
    [keys.sel, setParams],
  );

  const toggleOne = useCallback(
    (rowKey: string) => {
      const next = new Set(effectiveSelection);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      writeSelection([...next]);
    },
    [effectiveSelection, writeSelection],
  );

  /* ---------------- the visible rows ---------------- */

  const defaultSearchText = useCallback(
    (row: TRow) =>
      columns
        .map((c) => (c.accessor ? c.accessor(row) : undefined))
        .filter((v) => !isBlank(v))
        .map((v) => String(v))
        .join(" "),
    [columns],
  );

  const view = useMemo(() => {
    // In server mode the page already did all of this in SQL, over the
    // whole result set. Doing it again here would filter a filtered page.
    if (mode === "server") return [...rows];

    let out = [...rows];

    for (const f of filters ?? []) {
      const value = filterValues[f.key] ?? "";
      if (!value || !f.match) continue;
      const match = f.match;
      out = out.filter((row) => match(row, value));
    }

    if (query) {
      const needle = query.toLowerCase();
      const text = searchText ?? defaultSearchText;
      out = out.filter((row) => text(row).toLowerCase().includes(needle));
    }

    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      const accessor = col?.accessor;
      if (accessor) {
        out.sort((x, y) => {
          const a = accessor(x);
          const b = accessor(y);
          // ⭐ Blanks last in BOTH directions. A missing value and a zero
          // are different facts; letting blanks float to the top of a
          // descending sort makes "highest MRR" a list of customers whose
          // MRR nobody has recorded.
          const ax = isBlank(a);
          const bx = isBlank(b);
          if (ax && bx) return 0;
          if (ax) return 1;
          if (bx) return -1;
          const c = compareValues(a, b);
          return sortDir === "desc" ? -c : c;
        });
      }
    }

    return out;
  }, [
    mode,
    rows,
    filters,
    filterValues,
    query,
    searchText,
    defaultSearchText,
    sortKey,
    sortDir,
    columns,
  ]);

  const rowCount = mode === "server" ? (total ?? rows.length) : view.length;
  const pageCount = Math.max(1, Math.ceil(rowCount / pageSize));
  /**
   * ⚠️ Clamped for display, NOT rewritten into the URL. Rewriting inside
   * a render is a loop waiting for a slow network; and keeping `page=9`
   * means clearing the filter puts the operator back where they were.
   */
  const safePage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => (mode === "server" ? view : view.slice((safePage - 1) * pageSize, safePage * pageSize)),
    [mode, view, safePage, pageSize],
  );

  const pageKeys = useMemo(() => pageRows.map(rowId), [pageRows, rowId]);
  const allOnPageSelected =
    pageKeys.length > 0 && pageKeys.every((k) => selectedSet.has(k));
  const someOnPageSelected = pageKeys.some((k) => selectedSet.has(k));

  const togglePage = useCallback(() => {
    const next = new Set(effectiveSelection);
    if (allOnPageSelected) for (const k of pageKeys) next.delete(k);
    else for (const k of pageKeys) next.add(k);
    writeSelection([...next]);
  }, [allOnPageSelected, pageKeys, effectiveSelection, writeSelection]);

  /* ---------------- keyboard ---------------- */

  const [focusIndex, setFocusIndex] = useState(-1);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /**
   * ⚠️ MIRRORED IN A REF, AND THE HANDLER READS THE REF. Reading it out of
   * a `setFocusIndex(i => …)` updater instead would put `toggleOne()`
   * inside a state updater, and React StrictMode invokes updaters twice —
   * so `x` would select and immediately deselect, in development only.
   */
  const focusIndexRef = useRef(-1);
  focusIndexRef.current = focusIndex;

  useEffect(() => {
    // A row index that outlived its row (the filter changed under it)
    // would move selection onto whatever slid into that position.
    setFocusIndex((i) => (i >= pageRows.length ? -1 : i));
  }, [pageRows.length]);

  useEffect(() => {
    if (status !== "ready") return;

    function onKeyDown(event: KeyboardEvent) {
      // ⚠️ NEVER while the operator is typing. `j` is a letter before it
      // is a shortcut, and stealing it inside the filter box makes the
      // filter box unusable — which is the control this table is built
      // around.
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (target?.isContentEditable) return;
      // Leaves Cmd+K, Ctrl+R and friends alone.
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "j" || event.key === "k") {
        if (pageRows.length === 0) return;
        event.preventDefault();
        setFocusIndex((i) => {
          const next = event.key === "j" ? i + 1 : i - 1;
          if (next < 0) return 0;
          if (next > pageRows.length - 1) return pageRows.length - 1;
          return next;
        });
        return;
      }

      if (event.key === "x") {
        if (!selectable) return;
        const row = pageRows[focusIndexRef.current];
        if (row === undefined) return;
        event.preventDefault();
        toggleOne(rowId(row));
        return;
      }

      if (event.key === "Enter" && onRowActivate) {
        const row = pageRows[focusIndexRef.current];
        if (row === undefined) return;
        event.preventDefault();
        onRowActivate(row);
        return;
      }

      if (event.key === "Escape") {
        // Escape clears the SELECTION, which is the state that can do
        // damage. Filters are a view and stay put.
        setFocusIndex(-1);
        if (selectable && effectiveSelection.length > 0) writeSelection([]);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    status,
    pageRows,
    rowId,
    selectable,
    toggleOne,
    onRowActivate,
    effectiveSelection.length,
    writeSelection,
  ]);

  useEffect(() => {
    if (focusIndex < 0) return;
    const holder = bodyRef.current;
    if (!holder) return;
    // Two DOM copies exist (table + phone cards); only one is laid out.
    const candidates = holder.querySelectorAll<HTMLElement>(
      `[data-row-index="${focusIndex}"]`,
    );
    for (const el of Array.from(candidates)) {
      if (el.offsetParent !== null) {
        el.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }, [focusIndex]);

  /* ---------------- live refresh ---------------- */

  useEffect(() => {
    if (!refreshMs || refreshMs <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), refreshMs);
    };
    // ⚠️ PAUSED WHILE HIDDEN. A console tab left open overnight would
    // otherwise poll the database until morning for nobody.
    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshMs, router]);

  /* ---------------- rendering ---------------- */

  const clearAll = () => {
    const patch: Record<string, string | null> = { [keys.q]: null, [keys.page]: null };
    for (const f of filters ?? []) patch[keys.filter(f.key)] = null;
    setParams(patch);
  };

  const sortAriaFor = (key: string): "ascending" | "descending" | "none" =>
    sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none";

  const controls =
    searchable || (filters && filters.length > 0) || toolbar ? (
      <div className="flex flex-wrap items-end gap-3">
        {searchable ? (
          <div className="min-w-[220px] flex-1 space-y-1">
            <Label htmlFor={`${id}-q`}>{searchLabel}</Label>
            <Input
              id={`${id}-q`}
              value={query}
              autoComplete="off"
              spellCheck={false}
              placeholder={searchPlaceholder}
              onChange={(e) =>
                // Paging resets: page 7 of the old list is not page 7 of
                // the new one, and landing on an empty page reads as "no
                // results" when there are plenty.
                setParams({ [keys.q]: e.target.value, [keys.page]: null })
              }
            />
          </div>
        ) : null}

        {(filters ?? []).map((f) => (
          <div key={f.key} className="min-w-[160px] space-y-1">
            <Label htmlFor={`${id}-f-${f.key}`}>{f.label}</Label>
            <Select
              id={`${id}-f-${f.key}`}
              value={filterValues[f.key] ?? ""}
              onChange={(e) =>
                setParams({ [keys.filter(f.key)]: e.target.value, [keys.page]: null })
              }
            >
              <option value="">All</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {f.hint ? <p className="text-xs text-muted-foreground">{f.hint}</p> : null}
          </div>
        ))}

        {anyNarrowing ? (
          <Button type="button" variant="outline" size="sm" onClick={clearAll}>
            Clear filters
          </Button>
        ) : null}

        {toolbar ? <div className="ml-auto flex items-center gap-2">{toolbar}</div> : null}
      </div>
    ) : null;

  /**
   * ⭐ THE LIVE REGION. A filter that changes the list without saying so
   * is invisible to a screen reader — the rows simply become different
   * ones. The count is stated in words, and it is stated whether or not
   * anything was found.
   */
  const announcement = (
    <p
      role="status"
      aria-live="polite"
      data-testid={`${id}-count`}
      className="text-xs text-muted-foreground"
    >
      {status === "loading"
        ? `Loading ${noun}…`
        : status === "error"
          ? `Could not load ${noun}.`
          : anyNarrowing
            ? // ⚠️ In server mode `rowCount` is ALREADY the filtered
              // total, so there is no honest "of N" to state here — the
              // unfiltered count was never sent to the browser.
              mode === "server"
              ? `${rowCount} ${noun} match these filters.`
              : `${rowCount} of ${rows.length} ${noun} match these filters.`
            : `${rowCount} ${noun}.`}
      {selectable && effectiveSelection.length > 0
        ? ` ${effectiveSelection.length} selected.`
        : ""}
    </p>
  );

  /* -- the three states that are not a table ------------------------ */

  let body: ReactNode;

  if (status === "loading") {
    body = (
      <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {/* The word, not a grey rectangle. A skeleton and a broken table
            look identical to somebody who cannot tell them apart. */}
        Loading {noun}…
      </div>
    );
  } else if (status === "error") {
    body = (
      <div
        role="alert"
        className="space-y-2 rounded-md border border-destructive p-6 text-sm"
      >
        <p className="font-medium">Could not load {noun}.</p>
        <p className="text-muted-foreground">
          {error ?? "The server did not say why. Nothing has been changed."}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
          Try again
        </Button>
      </div>
    );
  } else if (pageRows.length === 0) {
    body = (
      <div className="space-y-2 rounded-md border border-dashed border-border p-6 text-center text-sm">
        <p className="font-medium">
          {anyNarrowing
            ? `No ${noun} match these filters.`
            : (emptyTitle ?? `No ${noun} yet.`)}
        </p>
        <p className="text-muted-foreground">
          {anyNarrowing
            ? "The filters are still applied — clear them to see the whole list."
            : (emptyHint ??
              "Nothing is wrong. This list is genuinely empty right now.")}
        </p>
        {anyNarrowing ? (
          <Button type="button" variant="outline" size="sm" onClick={clearAll}>
            Clear filters
          </Button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div ref={bodyRef}>
        {/* -------- the table, from 640px up -------- */}
        <div className="hidden sm:block">
          <Table>
            <caption className="sr-only">{caption}</caption>
            <TableHeader>
              <TableRow>
                {selectable ? (
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      className="h-4 w-4 align-middle"
                      checked={allOnPageSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected;
                      }}
                      onChange={togglePage}
                      aria-label={
                        allOnPageSelected
                          ? `Clear the ${pageKeys.length} ${noun} selected on this page`
                          : `Select all ${pageKeys.length} ${noun} on this page`
                      }
                    />
                  </TableHead>
                ) : null}

                {columns.map((col) => {
                  const canSort = Boolean(col.sortable && col.accessor);
                  if (!canSort) {
                    return (
                      <TableHead
                        key={col.key}
                        className={cn(col.align === "right" && "text-right")}
                      >
                        {col.header}
                      </TableHead>
                    );
                  }
                  const active = sortKey === col.key;
                  const nextDir: SortDir = active && sortDir === "asc" ? "desc" : "asc";
                  return (
                    <TableHead
                      key={col.key}
                      aria-sort={sortAriaFor(col.key)}
                      className={cn(col.align === "right" && "text-right")}
                    >
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() =>
                          setParams({
                            [keys.sort]: col.key,
                            [keys.dir]: nextDir,
                            [keys.page]: null,
                          })
                        }
                      >
                        <span>{col.header}</span>
                        {/* ⚠️ The glyph is decoration. The direction is
                            also in the accessible name below, because an
                            arrow is meaning carried by a shape. */}
                        <span aria-hidden className="text-xs">
                          {active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                        <span className="sr-only">
                          {active
                            ? sortDir === "asc"
                              ? " — sorted lowest first, activate to reverse"
                              : " — sorted highest first, activate to reverse"
                            : " — activate to sort by this column"}
                        </span>
                      </button>
                    </TableHead>
                  );
                })}

                {rowActions ? (
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>

            <TableBody>
              {pageRows.map((row, index) => {
                const key = rowId(row);
                const isSelected = selectedSet.has(key);
                return (
                  <TableRow
                    key={key}
                    data-row-index={index}
                    data-testid={`${id}-row-${key}`}
                    data-state={isSelected ? "selected" : undefined}
                    aria-selected={selectable ? isSelected : undefined}
                    className={cn(focusIndex === index && "ring-2 ring-inset ring-ring")}
                  >
                    {selectable ? (
                      <TableCell>
                        <input
                          type="checkbox"
                          className="h-4 w-4 align-middle"
                          checked={isSelected}
                          onChange={() => toggleOne(key)}
                          aria-label={`Select this row`}
                        />
                      </TableCell>
                    ) : null}

                    {columns.map((col) => (
                      <TableCell
                        key={col.key}
                        className={cn(col.align === "right" && "text-right tabular-nums", col.className)}
                      >
                        {col.cell
                          ? col.cell(row)
                          : renderValue(col.accessor ? col.accessor(row) : undefined)}
                      </TableCell>
                    ))}

                    {rowActions ? (
                      <TableCell className="text-right">{rowActions(row)}</TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* -------- stacked cards below 640px --------
            ⚠️ NOT a horizontally scrolling table. The console gets opened
            from a phone — on a train, after a page — and a seven-column
            table on a 390px screen means the operator reads the first
            column and guesses the rest. */}
        <ul className="space-y-2 sm:hidden">
          {pageRows.map((row, index) => {
            const key = rowId(row);
            const isSelected = selectedSet.has(key);
            return (
              <li
                key={key}
                data-row-index={index}
                className={cn(
                  "rounded-md border border-border p-3 text-sm",
                  isSelected && "bg-muted",
                  focusIndex === index && "ring-2 ring-inset ring-ring",
                )}
              >
                {selectable ? (
                  <label className="mb-2 flex items-center gap-2 text-xs font-medium">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={isSelected}
                      onChange={() => toggleOne(key)}
                    />
                    {/* The word, so selection is never colour alone. */}
                    {isSelected ? "Selected" : "Select"}
                  </label>
                ) : null}

                <dl className="space-y-1">
                  {columns
                    .filter((c) => !c.hideOnMobile)
                    .map((col) => (
                      <div key={col.key} className="flex gap-2">
                        <dt className="min-w-[92px] shrink-0 text-xs text-muted-foreground">
                          {col.header}
                        </dt>
                        <dd className="min-w-0 break-words">
                          {col.cell
                            ? col.cell(row)
                            : renderValue(col.accessor ? col.accessor(row) : undefined)}
                        </dd>
                      </div>
                    ))}
                </dl>

                {rowActions ? <div className="mt-2">{rowActions(row)}</div> : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {controls}
      {announcement}
      {body}

      {status === "ready" && rowCount > pageSize ? (
        <TablePager
          total={rowCount}
          limit={pageSize}
          offset={(safePage - 1) * pageSize}
          unit={noun}
          hrefFor={(offset) => {
            const next = new URLSearchParams(qs);
            const targetPage = Math.floor(offset / pageSize) + 1;
            if (targetPage <= 1) next.delete(keys.page);
            else next.set(keys.page, String(targetPage));
            const built = next.toString();
            // ⚠️ RELATIVE TO `usePathname()`, never a literal
            // `/platform/…`. On admin.ordence.com the served path is
            // `/tenants`, and a hard-coded canonical path there is the
            // 404 chain documented in `lib/platform/console-paths.ts`.
            return built ? `${pathname}?${built}` : pathname;
          }}
        />
      ) : null}

      {selectable ? (
        <p className="text-xs text-muted-foreground">
          Keyboard: <kbd>j</kbd> / <kbd>k</kbd> move, <kbd>x</kbd> selects,{" "}
          <kbd>Escape</kbd> clears the selection.
        </p>
      ) : null}
    </div>
  );
}
