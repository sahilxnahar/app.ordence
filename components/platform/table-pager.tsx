/**
 * Ordence — Console Pagination
 * Version: v0.29.0-alpha (Phase 29)
 *
 * Links, not buttons. The page you are looking at is a URL, so it can be
 * bookmarked, pasted into a ticket, and reached with JavaScript disabled.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY IT STATES THE RANGE IN WORDS
 * ══════════════════════════════════════════════════════════════════════
 * "51–100 of 412 workspaces" is the only honest way to render a page of a
 * cross-tenant list. Two failure modes it prevents:
 *
 *   • An operator concluding "there are 50 customers on this plan"
 *     because that is what the page showed.
 *   • A silently truncated list looking identical to a complete one.
 *
 * ⚠️ NOT USED FOR SEARCH RESULTS, DELIBERATELY. `platformSearch()` caps
 * at fifty and does NOT paginate — fifty at a time, repeated, is the
 * customer directory. This control is for the tenant directory and the
 * platform's own registers, which are lists of OUR records.
 */

import Link from "next/link";

export function TablePager({
  total,
  limit,
  offset,
  hrefFor,
  unit = "rows",
  note,
}: {
  total: number;
  limit: number;
  offset: number;
  /** Built on the server so the whole query string is preserved. */
  hrefFor: (offset: number) => string;
  unit?: string;
  /** Extra honesty, e.g. that a filter narrowed only this page. */
  note?: string;
}) {
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm"
    >
      <p className="text-muted-foreground" aria-live="polite">
        {total === 0
          ? `No ${unit}.`
          : `${first}–${last} of ${total} ${unit}.`}
        {note ? <span className="ml-2">{note}</span> : null}
      </p>

      <div className="ml-auto flex items-center gap-2">
        {hasPrev ? (
          <Link
            href={hrefFor(Math.max(0, offset - limit))}
            rel="prev"
            className="rounded-md border border-input px-3 py-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ← Previous
          </Link>
        ) : (
          <span className="rounded-md border border-transparent px-3 py-1.5 text-muted-foreground">
            ← Previous
          </span>
        )}

        {hasNext ? (
          <Link
            href={hrefFor(offset + limit)}
            rel="next"
            className="rounded-md border border-input px-3 py-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Next →
          </Link>
        ) : (
          <span className="rounded-md border border-transparent px-3 py-1.5 text-muted-foreground">
            Next →
          </span>
        )}
      </div>
    </nav>
  );
}
