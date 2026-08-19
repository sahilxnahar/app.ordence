/**
 * Ordence — ⭐⭐ THE QUERY-STRING CONTRACT FOR `<DataTable>`
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE TABLE'S STATE IS A URL AND NOT REACT STATE
 * ══════════════════════════════════════════════════════════════════════
 * The complaint that produced this file was not "sorting is missing". It
 * was that the console is not usable: an operator narrows a list of four
 * hundred workspaces down to the six that matter, hits refresh or follows
 * a row and comes back, and the six are gone. Worse, they cannot SEND the
 * view to anybody. "Look at the overdue Karnataka workspaces" is a
 * sentence plus twelve clicks of instructions, when it should be a link
 * pasted into a ticket.
 *
 * So sort, filter, page and selection are all query parameters. Three
 * consequences, all of them wanted:
 *
 *   • A filtered view survives a refresh and a back button.
 *   • A filtered view is a link somebody can send.
 *   • A SERVER component can read the same parameters (that is what this
 *     module is for) and do the sorting and paging in SQL, over the whole
 *     result set, instead of over the fifty rows that happen to be
 *     loaded. A list sorted client-side across one page looks ordered and
 *     is not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY EVERY KEY IS PREFIXED
 * ══════════════════════════════════════════════════════════════════════
 * A workspace detail page shows a table of users and a table of invoices
 * on the same screen. Unprefixed `sort=name` would sort both, and paging
 * one would page the other. The `id` prop is not decoration; it is the
 * namespace, and it is required for that reason.
 *
 * ⚠️ NO STORAGE, ANYWHERE. Not `localStorage`, not `sessionStorage`, not
 * a cookie. A view remembered in storage is a view that cannot be shared
 * and that differs between two operators looking at "the same" screen
 * during an incident.
 */

/** Sort direction as it appears in the URL. */
export type SortDir = "asc" | "desc";

/**
 * The exact parameter names one table owns. Build them with this, never
 * by string concatenation at the call site — a server page and the client
 * table disagreeing about a key is a filter that silently does nothing.
 */
export type DataTableParamKeys = {
  sort: string;
  dir: string;
  page: string;
  q: string;
  sel: string;
  /** The parameter carrying one named filter's value. */
  filter: (filterKey: string) => string;
};

export function dataTableParamKeys(id: string): DataTableParamKeys {
  return {
    sort: `${id}_sort`,
    dir: `${id}_dir`,
    page: `${id}_page`,
    q: `${id}_q`,
    sel: `${id}_sel`,
    filter: (filterKey: string) => `${id}_f_${filterKey}`,
  };
}

/**
 * What Next.js hands a page as `searchParams`, in either the awaited
 * object form or a plain map. Accepting both means a server page can pass
 * its own `searchParams` straight through.
 */
export type RawSearchParams =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function readOne(params: RawSearchParams, key: string): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const raw = params[key];
  if (raw === undefined) return null;
  // ⚠️ A repeated parameter (`?x=a&x=b`) arrives as an array. Taking the
  // FIRST is arbitrary but must be decided somewhere; silently reading
  // `undefined` off an array is how a filter stops working only for the
  // operator who double-clicked.
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

export type DataTableQuery = {
  /** Column key, or null when the caller's default ordering applies. */
  sortKey: string | null;
  sortDir: SortDir;
  /** 1-based, clamped to at least 1. Never trust `?page=-3`. */
  page: number;
  /** Trimmed free-text query, or "" when absent. */
  query: string;
  /** Only the filters the caller declared, only with allowed values. */
  filters: Record<string, string>;
  /**
   * 🔴 IDS THE BROWSER SENT BACK. NOT A PERMISSION, NOT A PROOF THAT THE
   * OPERATOR MAY TOUCH THESE ROWS, AND NOT EVEN A PROOF THAT THE ROWS
   * EXIST. Anyone can type `?t_sel=<any uuid>` into the address bar. The
   * server MUST re-fetch every one of these by id, inside the same
   * capability check it would apply to a single row, and drop the ones
   * that do not come back.
   */
  selectedIds: string[];
  /** Offset for the caller's SQL, derived from `page` and `pageSize`. */
  offset: number;
  limit: number;
};

/**
 * Read one table's state out of a request's query string, on the SERVER.
 *
 * ⚠️ ALLOW-LISTED, NOT PARSED. `sortKeys` and `filterValues` are the only
 * things that can come out of this function, because the sort key
 * frequently ends up interpolated near a SQL `ORDER BY` and a filter
 * value near a `WHERE`. A validated-elsewhere string is a string that one
 * day is not validated.
 */
export function readDataTableParams(
  id: string,
  params: RawSearchParams,
  options: {
    /** Column keys this table will accept in `?_sort`. */
    sortKeys?: readonly string[];
    defaultSort?: { key: string; dir: SortDir };
    /** For each declared filter, the values it will accept. */
    filterValues?: Record<string, readonly string[]>;
    pageSize?: number;
    /** Refuses a runaway `?_sel=` list. */
    maxSelected?: number;
  } = {},
): DataTableQuery {
  const keys = dataTableParamKeys(id);
  const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 25;
  const maxSelected = options.maxSelected ?? 500;

  const rawSort = readOne(params, keys.sort);
  const allowedSort = options.sortKeys ?? [];
  const sortKey =
    rawSort && allowedSort.includes(rawSort) ? rawSort : (options.defaultSort?.key ?? null);

  const rawDir = readOne(params, keys.dir);
  const sortDir: SortDir =
    rawDir === "asc" || rawDir === "desc" ? rawDir : (options.defaultSort?.dir ?? "asc");

  const rawPage = Number.parseInt(readOne(params, keys.page) ?? "", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const query = (readOne(params, keys.q) ?? "").trim();

  const filters: Record<string, string> = {};
  for (const [filterKey, allowed] of Object.entries(options.filterValues ?? {})) {
    const value = readOne(params, keys.filter(filterKey));
    // "" is the "no filter" value and is never passed on as a filter.
    if (value && allowed.includes(value)) filters[filterKey] = value;
  }

  const rawSel = readOne(params, keys.sel) ?? "";
  const selectedIds = rawSel
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, maxSelected);

  return {
    sortKey,
    sortDir,
    page,
    query,
    filters,
    selectedIds,
    offset: (page - 1) * pageSize,
    limit: pageSize,
  };
}
