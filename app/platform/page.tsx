/**
 * Ordence — Platform Console · Workspaces
 * Version: v0.29.0-alpha (Phase 29)
 *
 * The directory. Streamed: the shell and the filters render immediately
 * and the table arrives when the rollups have run. A support console that
 * shows a blank page for 800ms is a support console people keep a
 * database client open beside.
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY CONTROL ON THIS PAGE IS A URL (Phase 29)
 * ══════════════════════════════════════════════════════════════════════
 * Filters are a GET form, sorting is a set of links, paging is two links.
 * No client state anywhere. That is not minimalism for its own sake:
 *
 *   • The server sorts and pages over the WHOLE result set, so page 2 of
 *     "sorted by MRR" is really the second page. A table that sorts the
 *     rows it happens to have loaded is a table that lies quietly.
 *   • A view can be pasted into a ticket and reproduced exactly.
 *   • It works when the JavaScript bundle does not, which is the state
 *     the support console is in on precisely the day it is needed most.
 *
 * ⚠️ WHAT IS NOT HERE, AND WILL NOT BE: a customer's records. This page
 * shows the commercial relationship — plan, seats, storage, revenue,
 * health. Seeing anything a customer typed requires an impersonation
 * session: consented, time-limited, bannered and audited.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listTenants, type TenantSortKey } from "@/server/platform/tenants";
import { getPlatformOperator } from "@/server/platform/guard";
import { TenantTable, type TenantSortLinks } from "@/components/platform/tenant-table";
import { TablePager } from "@/components/platform/table-pager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HEALTH_LABELS } from "@/lib/platform/health";
import { formatMoney } from "@/lib/billing/money";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const PAGE_SIZE = 50;

/** One place that reads the query string, so the filters cannot drift. */
function readParams(params: Record<string, string | string[] | undefined>) {
  const str = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  const offset = Number.parseInt(str("offset") ?? "0", 10);
  return {
    status: str("status") ?? "all",
    planTier: str("plan") ?? "all",
    health: str("health") ?? "all",
    query: str("q"),
    sort: (str("sort") ?? "created") as TenantSortKey,
    direction: (str("dir") === "asc" ? "asc" : "desc") as "asc" | "desc",
    offset: Number.isFinite(offset) && offset > 0 ? Math.min(offset, 10_000) : 0,
  };
}

/** Rebuild the whole query string with one or two values changed. */
function hrefWith(
  current: ReturnType<typeof readParams>,
  changes: Partial<
    Record<"sort" | "dir" | "offset" | "q" | "status" | "health" | "plan", string>
  >,
): string {
  const search = new URLSearchParams();
  const base: Record<string, string> = {
    q: current.query ?? "",
    status: current.status,
    plan: current.planTier,
    health: current.health,
    sort: current.sort,
    dir: current.direction,
    offset: String(current.offset),
  };
  for (const [key, value] of Object.entries({ ...base, ...changes })) {
    // Defaults are omitted so the common URL stays short and readable.
    if (!value || value === "all" || (key === "offset" && value === "0")) continue;
    search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `/platform?${qs}` : "/platform";
}

export default async function PlatformHomePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = readParams(await searchParams);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Workspaces</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Plan, health, usage and revenue. Opening a workspace is recorded in that
          customer&rsquo;s own audit log.
        </p>
      </div>

      <FilterBar params={params} />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton />}>
        <TenantList params={params} />
      </Suspense>
    </div>
  );
}

async function TenantList({ params }: { params: ReturnType<typeof readParams> }) {
  const operator = await getPlatformOperator();
  if (!operator) return null;

  const result = await listTenants({
    status: params.status,
    planTier: params.planTier,
    health: params.health,
    query: params.query,
    sort: params.sort,
    direction: params.direction,
    limit: PAGE_SIZE,
    offset: params.offset,
  });

  if (!result.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {result.error}
      </p>
    );
  }

  const { rows, total, sort, direction, healthFilterNarrowedPage } = result.data;
  const live = rows.filter((r) => r.impersonationLive).length;
  const atRisk = rows.filter((r) => r.health.level === "at_risk").length;

  // MRR on this page only, and LABELLED as such. A "total MRR" that
  // silently means "of the fifty rows you can see" is the kind of number
  // that ends up in a board deck.
  const pageMrr = rows.reduce((sum, r) => sum + BigInt(r.mrrMinor || "0"), 0n);
  const currency = rows[0]?.currency ?? "INR";

  /** One link per sortable column, direction flipped when it is active. */
  const sortLinks: TenantSortLinks = Object.fromEntries(
    (["name", "plan", "seats", "storage", "activity", "mrr"] as const).map((key) => {
      const isActive = sort === key;
      const nextDir = isActive && direction === "desc" ? "asc" : "desc";
      return [
        key,
        {
          // Changing the sort returns to page one. Keeping the offset
          // would land the operator in the middle of a different order.
          href: hrefWith(params, { sort: key, dir: nextDir, offset: "0" }),
          active: isActive
            ? direction === "asc"
              ? ("ascending" as const)
              : ("descending" as const)
            : ("none" as const),
        },
      ];
    }),
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Workspaces</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{total}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Needing attention</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{atRisk}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>MRR on this page</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatMoney(pageMrr, currency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Staff inside a workspace</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-2xl font-semibold tabular-nums">
            {live}
            {live > 0 ? <Badge variant="destructive">live now</Badge> : null}
          </CardContent>
        </Card>
      </div>

      {live > 0 ? (
        <p className="text-sm">
          <Link href="/platform/sessions?live=1" className="underline">
            {live === 1 ? "One session is" : `${live} sessions are`} open inside a
            customer&rsquo;s workspace — review them
          </Link>
        </p>
      ) : null}

      <TenantTable rows={rows} sortLinks={sortLinks} />

      <TablePager
        total={total}
        limit={PAGE_SIZE}
        offset={params.offset}
        unit="workspaces"
        hrefFor={(offset) => hrefWith(params, { offset: String(offset) })}
        note={
          healthFilterNarrowedPage
            ? "Health is scored per workspace after loading, so that filter narrows this page rather than the whole list."
            : undefined
        }
      />
    </div>
  );
}

function FilterBar({ params }: { params: ReturnType<typeof readParams> }) {
  // A plain GET form. No client state, no JavaScript needed — the console
  // has to work on the day something else in the bundle is broken.
  return (
    <form className="flex flex-wrap items-end gap-3" method="get">
      {/* Carried through so filtering does not silently reset the order. */}
      <input type="hidden" name="sort" value={params.sort} />
      <input type="hidden" name="dir" value={params.direction} />

      <div className="space-y-1">
        <label htmlFor="q" className="text-xs text-muted-foreground">
          Name or address starts with
        </label>
        <input
          id="q"
          name="q"
          defaultValue={params.query}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="status" className="text-xs text-muted-foreground">
          Status
        </label>
        <select
          id="status"
          name="status"
          defaultValue={params.status}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {["all", "active", "pending", "suspended", "archived"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="plan" className="text-xs text-muted-foreground">
          Plan
        </label>
        <select
          id="plan"
          name="plan"
          defaultValue={params.planTier}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {["all", "trial", "basic", "advanced", "ai", "enterprise"].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="health" className="text-xs text-muted-foreground">
          Health (narrows this page)
        </label>
        <select
          id="health"
          name="health"
          defaultValue={params.health}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">all</option>
          {(["healthy", "watch", "at_risk", "suspended"] as const).map((h) => (
            <option key={h} value={h}>
              {HEALTH_LABELS[h]}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className="h-9 rounded-md border border-input px-4 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Apply
      </button>
    </form>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}
