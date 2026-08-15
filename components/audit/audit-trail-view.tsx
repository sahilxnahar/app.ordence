"use client";

/**
 * Ordence — ⭐⭐ THE AUDIT TRAIL, AS A CUSTOMER READS IT
 * Version: v1.60.0-alpha (Batch 30)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A ROW OF JSON IS NOT A CUSTOMER-FACING SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * The default way to build this page is a table of the columns:
 * `action`, `resource_type`, `resource_id`, `metadata`. It is quick, it
 * is faithful to the data, and it is unusable by the person it is for —
 * a business owner who wants to know whether anybody outside their
 * company has looked at their customers' phone numbers. `resource_type:
 * "sales_invoice"` next to `{"periodId":"0f2c…"}` does not answer that.
 *
 * So every row arrives from the server as a SENTENCE (`describeAudit
 * Event()` in `lib/audit/customer-view.ts`) and this component renders
 * sentences. It never receives `old_value`, `new_value`, `ip_address` or
 * raw `metadata` — those are dropped at the query, not hidden in the
 * CSS. ⚠️ Hiding a field in the UI still ships it to the browser, where
 * it is one devtools tab away from the colleague whose salary change it
 * describes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE STAFF-ACCESS ROWS ARE VISUALLY LOUD
 * ══════════════════════════════════════════════════════════════════════
 * They are the rows the page exists for, and they are also the rarest —
 * a handful among thousands. Rendered in the same grey as everything
 * else they are, in practice, invisible: nobody scrolls two hundred rows
 * looking for a colour they were not told to look for. The banner, the
 * left border and the "Ordence staff" badge are three chances to notice.
 */

import { useCallback, useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  AUDIT_CATEGORIES,
  CATEGORY_LABELS,
  CHAIN_CLAIM,
  STAFF_ACCESS_COVERAGE,
  type AuditCategory,
  type AuditEventView,
} from "@/lib/audit/customer-view";

type FilterState = {
  category: AuditCategory;
  from: string | null;
  to: string | null;
  actor: string | null;
};

type LoadAction = (input: unknown) => Promise<{
  events: AuditEventView[];
  nextCursor: string | null;
  hasMore: boolean;
}>;

type ExportAction = (input: unknown) => Promise<{
  filename: string;
  csv: string;
  rowCount: number;
  truncated: boolean;
}>;

export function AuditTrailView({
  initialEvents,
  initialCursor,
  initialHasMore,
  initialFilters,
  canExport,
  loadAction,
  exportAction,
}: {
  initialEvents: AuditEventView[];
  initialCursor: string | null;
  initialHasMore: boolean;
  initialFilters: FilterState;
  /**
   * ⚠️ A HINT, NOT A GATE. `exportAuditTrail()` asks for `audit:read`
   * AND `workspace:export` itself; this only decides whether somebody is
   * shown a button that would throw.
   */
  canExport: boolean;
  loadAction: LoadAction;
  exportAction: ExportAction;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [cursor, setCursor] = useState(initialCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const staffCount = useMemo(
    () => events.filter((e) => e.isStaffAccess).length,
    [events],
  );

  /**
   * ⚠️ A FILTER CHANGE RESETS THE CURSOR. Keeping it would resume the
   * new filter from a position computed under the old one, which does
   * not error — it silently starts partway down a different result set,
   * so the page appears to be missing its most recent rows.
   */
  const applyFilters = useCallback(
    (next: FilterState) => {
      setFilters(next);
      setError(null);
      setNote(null);
      start(async () => {
        try {
          const page = await loadAction({ ...next, cursor: null });
          setEvents(page.events);
          setCursor(page.nextCursor);
          setHasMore(page.hasMore);
        } catch {
          setError("Could not load the audit trail. Please try again.");
        }
      });
    },
    [loadAction],
  );

  const loadMore = useCallback(() => {
    if (!cursor) return;
    setError(null);
    start(async () => {
      try {
        const page = await loadAction({ ...filters, cursor });
        // ⚠️ APPEND, never replace. The cursor is a resume point, not a
        // page number, so the response is the NEXT slice and not the
        // whole set up to here.
        setEvents((current) => [...current, ...page.events]);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch {
        setError("Could not load more entries. Please try again.");
      }
    });
  }, [cursor, filters, loadAction]);

  /**
   * ⭐ THE DOWNLOAD IS BUILT FROM A BLOB, NOT A LINK TO AN ENDPOINT.
   *
   * The CSV comes back through the same guarded action as everything
   * else, so there is no second, unguarded URL serving the same rows.
   *
   * ⚠️ AND THE TRUNCATION NOTICE IS NOT OPTIONAL. A customer who asked
   * for "the log" and received a file that stops at fifty thousand rows
   * without saying so will hand an incomplete record to a regulator
   * believing it is complete. The file downloads either way; the sentence
   * is what makes it honest.
   */
  const download = useCallback(() => {
    setError(null);
    setNote(null);
    start(async () => {
      try {
        const result = await exportAction({ ...filters, cursor: null });
        const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        anchor.click();
        URL.revokeObjectURL(url);

        setNote(
          result.truncated
            ? `Downloaded ${result.rowCount} entries — this is NOT the complete set. ` +
              `The export stops at ${result.rowCount} rows. Narrow the dates and ` +
              `download again to get the rest.`
            : `Downloaded ${result.rowCount} ${result.rowCount === 1 ? "entry" : "entries"} — ` +
              `the complete set for these filters.`,
        );
      } catch {
        setError("Could not build the export. Please try again.");
      }
    });
  }, [exportAction, filters]);

  return (
    <div className="space-y-6">
      <StaffAccessCard visibleCount={staffCount} />

      <section
        aria-label="Filters"
        className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-5"
      >
        <div className="space-y-1">
          <Label htmlFor="audit-category">Show</Label>
          <Select
            id="audit-category"
            value={filters.category}
            disabled={pending}
            onChange={(e) =>
              applyFilters({ ...filters, category: e.target.value as AuditCategory })
            }
          >
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="audit-from">From (IST)</Label>
          <Input
            id="audit-from"
            type="date"
            value={filters.from ?? ""}
            disabled={pending}
            onChange={(e) => applyFilters({ ...filters, from: e.target.value || null })}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="audit-to">To (IST)</Label>
          <Input
            id="audit-to"
            type="date"
            value={filters.to ?? ""}
            disabled={pending}
            onChange={(e) => applyFilters({ ...filters, to: e.target.value || null })}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="audit-actor">Person (email)</Label>
          <Input
            id="audit-actor"
            type="search"
            placeholder="anyone"
            defaultValue={filters.actor ?? ""}
            disabled={pending}
            onBlur={(e) => {
              const value = e.target.value.trim() || null;
              if (value !== filters.actor) applyFilters({ ...filters, actor: value });
            }}
          />
        </div>

        <div className="flex items-end">
          {canExport ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={pending}
              onClick={download}
            >
              Download CSV
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Downloading the whole log needs the workspace export permission. Ask
              an owner or administrator.
            </p>
          )}
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className="text-sm text-muted-foreground">
          {note}
        </p>
      ) : null}

      {events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Nothing recorded for these filters.{" "}
          {filters.category === "staff_access"
            ? "No Ordence staff member has been inside this workspace in this period."
            : "Try widening the dates."}
        </p>
      ) : (
        <ol className="space-y-2">
          {events.map((event) => (
            <AuditRow key={event.id} event={event} />
          ))}
        </ol>
      )}

      {hasMore ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" disabled={pending} onClick={loadMore}>
            {pending ? "Loading…" : "Show older entries"}
          </Button>
        </div>
      ) : events.length > 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          That is the beginning of the record for these filters.
        </p>
      ) : null}

      <ChainClaimCard />
    </div>
  );
}

/* ------------------------------------------------------------------ */

const TONE_CLASS: Readonly<Record<AuditEventView["tone"], string>> = {
  alarm: "border-l-4 border-l-destructive bg-destructive/5",
  staff: "border-l-4 border-l-primary bg-primary/5",
  notice: "border-l-4 border-l-amber-500",
  plain: "border-l-4 border-l-transparent",
};

function AuditRow({ event }: { event: AuditEventView }) {
  return (
    <li className={cn("rounded-md border border-border p-3 text-sm", TONE_CLASS[event.tone])}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{event.headline}</p>
        <time className="shrink-0 text-xs tabular-nums text-muted-foreground">{event.when}</time>
      </div>

      <p className="mt-0.5 text-xs text-muted-foreground">{event.actor}</p>

      {event.staffNote ? (
        <p className="mt-2 rounded bg-background/60 p-2 text-xs">
          <Badge variant={event.tone === "alarm" ? "destructive" : "default"} className="mr-2">
            Ordence staff
          </Badge>
          {event.staffNote}
        </p>
      ) : null}

      {event.reason ? (
        <p className="mt-1 text-xs italic text-muted-foreground">“{event.reason}”</p>
      ) : null}

      {event.details.length > 0 ? (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {event.details.map((detail) => (
            <div key={detail.label} className="flex gap-1">
              <dt className="font-medium">{detail.label}:</dt>
              {/*
                ⚠️ `detail.value` IS ALWAYS A STRING. `describeMetadata()`
                converts scalars and summarises anything else by shape.
                Rendering a raw metadata value here would put `[object
                Object]` on the page in the good case and throw in React
                in the bad one.
              */}
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {!event.attested ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="mr-2">
            not sealed
          </Badge>
          Recorded, but outside the tamper-evident chain.
        </p>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */

function StaffAccessCard({ visibleCount }: { visibleCount: number }) {
  return (
    <section className="rounded-lg border border-border bg-muted/30 p-4">
      <h2 className="text-sm font-semibold">{STAFF_ACCESS_COVERAGE.heading}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{STAFF_ACCESS_COVERAGE.covered}</p>
      <p className="mt-1 text-xs text-muted-foreground">{STAFF_ACCESS_COVERAGE.notCovered}</p>
      <p className="mt-2 text-xs font-medium">
        {visibleCount === 0
          ? "No Ordence staff entries in what is loaded below."
          : `${visibleCount} Ordence staff ${visibleCount === 1 ? "entry" : "entries"} in what is loaded below.`}
      </p>
    </section>
  );
}

/**
 * ⚠️ THE COPY IS IMPORTED, NOT TYPED HERE.
 *
 * Every sentence about what the hash chain proves lives in
 * `lib/audit/customer-view.ts` as a frozen constant, so the test can
 * assert on it and so nobody tightens "tamper-evident" into
 * "tamper-proof" while editing JSX. The distinction is the difference
 * between a true statement and one that fails in the exact circumstance
 * a customer would rely on it.
 */
function ChainClaimCard() {
  return (
    <section className="rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">{CHAIN_CLAIM.heading}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{CHAIN_CLAIM.evident}</p>
      <p className="mt-1 text-xs text-muted-foreground">{CHAIN_CLAIM.notProof}</p>
      <p className="mt-1 text-xs text-muted-foreground">{CHAIN_CLAIM.anchor}</p>
      <p className="mt-1 text-xs text-muted-foreground">{CHAIN_CLAIM.unattested}</p>
    </section>
  );
}
