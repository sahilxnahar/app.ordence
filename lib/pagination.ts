/**
 * Ordence — Pagination Bounds
 * Version: v1.31.0-alpha (Batch 31)
 *
 * Pure arithmetic. No imports that do I/O — the list actions, the API
 * routes, the grids and the tests all read the same bounds from here.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A PAGE SIZE DEFAULTED IN A COMPONENT IS NOT A CAP
 * ══════════════════════════════════════════════════════════════════════
 * `<DataTable pageSize={50} />` bounds exactly one caller: the browser
 * running our own JavaScript. The `limit` that reaches the query does not
 * come from that component. It comes off the wire, and the wire is
 * whatever the caller decided to put on it:
 *
 *     curl '.../api/...?limit=1000000'
 *
 * There is no attacker in that story. It is an integration author who
 * read "limit" in our docs and reasonably concluded that a big number
 * fetches everything. What it actually fetches is a million rows through
 * a Neon connection shared with every other workspace on the instance,
 * serialised into a Worker with a hard memory ceiling, at a compute cost
 * charged to us.
 *
 * ⚠️ THE BOUND THEREFORE BELONGS TO THE QUERY, NOT THE CALLER AND NOT THE
 * RENDERER. `boundPage()` returns the number you pass to `.limit()`, and
 * that number is bounded before it is returned. A call site that forgets
 * to use it is visible in review as a raw `.limit(input.limit)`; a call
 * site that uses it cannot be wrong.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND SILENT TRUNCATION IS WORSE THAN THE UNBOUNDED QUERY
 * ══════════════════════════════════════════════════════════════════════
 * The obvious implementation — `limit = Math.min(input, 200)` — is a
 * correctness bug wearing a safety feature's clothes, and this repository
 * already contains eleven of them (`Math.min(Math.max(1, limit), 200)`
 * and friends, scattered across `server/actions/`).
 *
 * Ask for 1000 rows, get 200, and there is NOTHING in the response that
 * distinguishes "here are 200 rows, that is all there are" from "here are
 * the first 200 of 1000". A reconciliation screen showing 200 of 1000
 * unmatched transactions does not look broken. It looks finished. The
 * customer signs off a month-end close on a fifth of the data.
 *
 * So every bound here is reported:
 *
 *   • `clamped` / `clampReason` — the request was changed, and how.
 *   • `take` — ALWAYS `limit + 1`. The query fetches one row more than it
 *     returns, so `hasMore` is a FACT about the data rather than an
 *     inference from `rows.length === limit` (which is wrong exactly when
 *     the last page happens to be full, i.e. one time in `limit`).
 *   • `boundPageOrThrow()` — for surfaces where quietly changing the
 *     caller's request is worse than refusing it. An API client that
 *     asked for 1000 and got 200 without being told has a paging loop
 *     that skips 800 rows per page, forever, silently.
 */

import type { PlanTier } from "@/db/schema/core";
import { maxPageSizeForPlan } from "@/lib/edge/budgets";

/* ------------------------------------------------------------------ */
/* THE NUMBERS                                                         */
/* ------------------------------------------------------------------ */

/**
 * The ceiling no caller, plan, override or future edit can exceed.
 *
 * ⚠️ THIS IS THE LAST LINE, SO IT IS APPLIED LAST AND UNCONDITIONALLY.
 * Per-plan caps (`maxPageSizeForPlan`) and per-call-site caps are both
 * clamped against it, in that order, so loosening either one cannot
 * produce an unbounded query. A limit with an exception is not a limit.
 *
 * 500 rows is roughly a megabyte of JSON for a wide CRM row. It is above
 * every legitimate page in the product and far below the point at which a
 * single request threatens the instance.
 */
export const ABSOLUTE_MAX_PAGE_SIZE = 500;

/** What a caller gets when they ask for nothing. Matches the grids. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * How far into a result set an offset may reach.
 *
 * ⚠️ THE COST OF `OFFSET` IS THE OFFSET, NOT THE LIMIT, AND THIS IS THE
 * BOUND EVERY PAGINATION IMPLEMENTATION FORGETS. `OFFSET 900000 LIMIT 50`
 * asks PostgreSQL to produce, sort and DISCARD nine hundred thousand rows
 * to return fifty. The response is small, the query plan is enormous, and
 * a caller walking a large table with a naive loop reaches that state on
 * their own without meaning anything by it.
 *
 * Beyond this depth the answer is a keyset cursor, not a bigger offset.
 */
export const MAX_PAGE_OFFSET = 50_000;

/* ------------------------------------------------------------------ */
/* BOUNDS                                                              */
/* ------------------------------------------------------------------ */

export type PageBounds = {
  /** Rows to RETURN. Already bounded. */
  limit: number;
  /** Rows to SKIP. Already bounded. */
  offset: number;
  /**
   * Rows to FETCH — always `limit + 1`.
   *
   * ⚠️ PASS THIS TO `.limit()`, NOT `limit`. The extra row is the probe
   * that makes `hasMore` a measurement. See the module header.
   */
  take: number;
  /** What the caller actually asked for, once coerced. Null if unset. */
  requestedLimit: number | null;
  requestedOffset: number | null;
  /** True when the request was changed to fit inside the bounds. */
  clamped: boolean;
  /** A sentence naming what was changed, for the response envelope. */
  clampReason: string | null;
  /** The ceiling that applied to this call, after every clamp. */
  maxLimit: number;
};

export type BoundPageInput = {
  /**
   * ⚠️ TYPED `unknown` ON PURPOSE. This value came off the wire. Typing
   * it `number` would be a lie the compiler cheerfully believes, and the
   * lie is exactly how `limit=1e9` reaches a query: `input.limit` is a
   * string, `Math.min(string, 200)` is `NaN`, and Drizzle emits
   * `LIMIT NaN`. Coercion happens here, once, defensively.
   */
  limit?: unknown;
  offset?: unknown;
  /** 1-based page number, an alternative to `offset`. Ignored if `offset` is set. */
  page?: unknown;
  /** The workspace's plan, when known. Chooses the per-plan ceiling. */
  planTier?: PlanTier | null;
  /** A call-site ceiling tighter than the plan's. Never looser. */
  maxLimit?: number;
  /** What to use when the caller asked for nothing. */
  defaultLimit?: number;
};

/**
 * Coerce anything into a non-negative integer, or null.
 *
 * Handles the whole zoo that arrives from a query string: `"50"`,
 * `"50.7"`, `"1e9"`, `"abc"`, `""`, `"-5"`, `Infinity`, `NaN`, `null`,
 * `[]`, `{}`. Everything that is not a finite non-negative number becomes
 * null, and null means "the caller did not specify", which is the only
 * safe reading of junk.
 */
function coerceCount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const truncated = Math.trunc(n);
  if (truncated < 0) return null;
  return truncated;
}

/**
 * Bound a caller-supplied page request.
 *
 * ⚠️ NEVER THROWS, ALWAYS REPORTS. Use this on surfaces where a human is
 * looking at a screen — clamping to 200 and rendering the grid is a
 * better experience than an error, PROVIDED the envelope says so, which
 * `paginate()` makes it do. Use `boundPageOrThrow` on programmatic
 * surfaces, where being quietly given a different page than you asked for
 * corrupts a paging loop.
 */
export function boundPage(input: BoundPageInput = {}): PageBounds {
  const requestedLimit = coerceCount(input.limit);
  const requestedOffset = coerceCount(input.offset);
  const requestedPage = coerceCount(input.page);

  /**
   * ⚠️ THE CEILING IS THE TIGHTEST OF THREE, AND THE ABSOLUTE ONE IS
   * APPLIED LAST. A call site asking for a bigger `maxLimit` than the
   * plan allows gets the plan's; a plan matrix edited to allow more than
   * `ABSOLUTE_MAX_PAGE_SIZE` gets the absolute. Order matters: applying
   * the absolute cap first and the call-site cap second would let a
   * loosened plan slip through.
   */
  const planCeiling = maxPageSizeForPlan(input.planTier);
  const siteCeiling = input.maxLimit ?? planCeiling;
  const maxLimit = Math.max(1, Math.min(siteCeiling, planCeiling, ABSOLUTE_MAX_PAGE_SIZE));

  const fallback = Math.min(
    Math.max(1, input.defaultLimit ?? DEFAULT_PAGE_SIZE),
    maxLimit,
  );

  const reasons: string[] = [];

  let limit: number;
  if (requestedLimit === null) {
    limit = fallback;
  } else if (requestedLimit === 0) {
    // A zero page is a request for nothing that still costs a round trip
    // and a query plan. Treat it as "unspecified" rather than returning an
    // empty page a caller will loop on forever.
    limit = fallback;
    reasons.push(`A page size of 0 returns nothing; using ${fallback}.`);
  } else if (requestedLimit > maxLimit) {
    limit = maxLimit;
    reasons.push(
      `Requested page size ${requestedLimit} exceeds the maximum of ${maxLimit}; ` +
        `returning ${maxLimit} rows. Use the offset or cursor to read the rest — ` +
        `this page is NOT the end of the data.`,
    );
  } else {
    limit = requestedLimit;
  }

  /** `page` is 1-based; `page=0` and `page=1` both mean the first page. */
  const offsetFromPage =
    requestedPage !== null && requestedPage > 1 ? (requestedPage - 1) * limit : 0;

  let offset = requestedOffset ?? offsetFromPage;
  if (offset > MAX_PAGE_OFFSET) {
    offset = MAX_PAGE_OFFSET;
    reasons.push(
      `Offset beyond ${MAX_PAGE_OFFSET} is refused because the database must ` +
        `produce and discard every skipped row. Filter or sort to narrow the ` +
        `result set instead of paging deeper.`,
    );
  }

  return {
    limit,
    offset,
    take: limit + 1,
    requestedLimit,
    requestedOffset,
    clamped: reasons.length > 0,
    clampReason: reasons.length > 0 ? reasons.join(" ") : null,
    maxLimit,
  };
}

/**
 * A caller asked for more than they may have, on a surface where quietly
 * giving them something else is the wrong answer.
 */
export class PageLimitError extends Error {
  readonly code = "page_limit_exceeded" as const;
  readonly status = 400 as const;
  constructor(
    readonly requested: number,
    readonly maxLimit: number,
  ) {
    super(
      `Requested page size ${requested} exceeds the maximum of ${maxLimit}. ` +
        `Request at most ${maxLimit} rows per page and use the offset to continue.`,
    );
    this.name = "PageLimitError";
  }
}

/**
 * ⚠️ THE STRICT VARIANT, FOR PROGRAMMATIC SURFACES.
 *
 * The failure this prevents: a client pages with `limit=1000`, is quietly
 * served 200, and advances `offset` by 1000 each time. It reads rows
 * 0–199, then 1000–1199, then 2000–2199. It never errors, it never
 * notices, and it silently loses 80% of the dataset on every sync — a
 * defect that surfaces months later as "why is our warehouse missing
 * invoices" and is close to unfindable from the symptom.
 *
 * Refusing loudly the first time costs the integration author ten minutes.
 */
export function boundPageOrThrow(input: BoundPageInput = {}): PageBounds {
  const bounds = boundPage(input);
  if (bounds.requestedLimit !== null && bounds.requestedLimit > bounds.maxLimit) {
    throw new PageLimitError(bounds.requestedLimit, bounds.maxLimit);
  }
  return bounds;
}

/* ------------------------------------------------------------------ */
/* THE ENVELOPE                                                        */
/* ------------------------------------------------------------------ */

export type Page<T> = {
  rows: T[];
  /** How many rows this page actually contains. */
  pageSize: number;
  /**
   * Whether more rows exist after this page. A MEASUREMENT, from the
   * probe row, not a guess from `rows.length`.
   */
  hasMore: boolean;
  /** Offset to pass for the next page, or null when there is none. */
  nextOffset: number | null;
  /** True when the caller's request was changed to fit the bounds. */
  clamped: boolean;
  /** Null unless something was changed. Surface this to the reader. */
  notice: string | null;
};

/**
 * Turn `take` rows into a page of `limit`.
 *
 * ⚠️ CALL THIS WITH THE RAW QUERY RESULT — the one fetched with
 * `bounds.take`. It drops the probe row itself; passing already-sliced
 * rows makes `hasMore` permanently false, which is the exact bug the
 * probe exists to prevent, reintroduced one layer up.
 */
export function paginate<T>(rows: readonly T[], bounds: PageBounds): Page<T> {
  const hasMore = rows.length > bounds.limit;
  const page = hasMore ? rows.slice(0, bounds.limit) : rows.slice();

  return {
    rows: page,
    pageSize: page.length,
    hasMore,
    nextOffset: hasMore ? bounds.offset + page.length : null,
    clamped: bounds.clamped,
    notice: bounds.clampReason,
  };
}

/**
 * A page whose rows were fetched WITHOUT the probe.
 *
 * ⚠️ Present because not every existing call site can be changed to fetch
 * `take`, and a helper that only works after a refactor is a helper
 * nobody adopts. It is strictly weaker and says so: `hasMore` is inferred
 * from a full page, which is wrong precisely when the last page happens
 * to be exactly full. Prefer `paginate()`.
 */
export function paginateWithoutProbe<T>(rows: readonly T[], bounds: PageBounds): Page<T> {
  const hasMore = rows.length >= bounds.limit;
  return {
    rows: rows.slice(0, bounds.limit),
    pageSize: Math.min(rows.length, bounds.limit),
    hasMore,
    nextOffset: hasMore ? bounds.offset + Math.min(rows.length, bounds.limit) : null,
    clamped: bounds.clamped,
    notice: bounds.clampReason,
  };
}
