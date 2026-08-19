/**
 * Ordence — Platform Console · Impersonation Sessions
 * Version: v0.29.0-alpha (Phase 29)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SCREEN THAT ANSWERS "IS ANYONE INSIDE A CUSTOMER RIGHT NOW?"
 * ══════════════════════════════════════════════════════════════════════
 * Before this page, that question could only be answered with a database
 * query — which means, in practice, that it was never asked. A control
 * nobody can observe is a control nobody maintains.
 *
 * The live count is deliberately the first thing on the page and is
 * computed over EVERY session, not over the filtered view: "nobody is
 * inside" must not depend on which filter happens to be applied.
 *
 * ⚠️ THE ROWS ARE APPEND-ONLY EVIDENCE. Nothing on this page edits one.
 * The single write available is the one-way close — `ended_at` and
 * `ended_reason` — and the database trigger refuses every other change,
 * refuses re-closing a closed session, and refuses DELETE outright.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listImpersonationSessions } from "@/server/platform/action-log";
import { getPlatformOperator } from "@/server/platform/guard";
import { revokeImpersonationSessionAction } from "@/server/platform/actions";
import { SessionRegister } from "@/components/platform/session-register";
import { TablePager } from "@/components/platform/table-pager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readParams(params: Record<string, string | string[] | undefined>) {
  const str = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  const offset = Number.parseInt(str("offset") ?? "0", 10);
  const days = Number.parseInt(str("days") ?? "30", 10);
  return {
    liveOnly: str("live") === "1",
    tenantId: str("tenant"),
    actor: str("actor"),
    days: Number.isFinite(days) ? Math.min(Math.max(days, 1), 90) : 30,
    offset: Number.isFinite(offset) && offset > 0 ? Math.min(offset, 10_000) : 0,
  };
}

function hrefWith(
  current: ReturnType<typeof readParams>,
  changes: Record<string, string | undefined>,
): string {
  const search = new URLSearchParams();
  const base: Record<string, string | undefined> = {
    live: current.liveOnly ? "1" : undefined,
    tenant: current.tenantId,
    actor: current.actor,
    days: String(current.days),
    offset: String(current.offset),
  };
  for (const [key, value] of Object.entries({ ...base, ...changes })) {
    if (!value || (key === "offset" && value === "0") || (key === "days" && value === "30")) {
      continue;
    }
    search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `/platform/sessions?${qs}` : "/platform/sessions";
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = readParams(await searchParams);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Impersonation sessions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every time one of us has been inside a customer&rsquo;s workspace. These rows
          cannot be edited or deleted — an expiry cannot be extended, a justification
          cannot be rewritten, and a break-glass session cannot be relabelled as
          consented.
        </p>
      </div>

      <Filters params={params} />

      <Suspense key={JSON.stringify(params)} fallback={<Skeleton />}>
        <Register params={params} />
      </Suspense>
    </div>
  );
}

async function Register({ params }: { params: ReturnType<typeof readParams> }) {
  const operator = await getPlatformOperator();
  if (!operator) return null;

  const result = await listImpersonationSessions({
    liveOnly: params.liveOnly,
    tenantId: params.tenantId,
    actor: params.actor,
    days: params.days,
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

  const { rows, total, liveCount } = result.data;
  const canRevoke = operator.capabilities.includes("staff:manage");

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Live right now</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {liveCount}
            <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
              across every workspace
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>In this window</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{total}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Refused actions</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {rows.reduce((sum, r) => sum + r.blockedActionCount, 0)}
            <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
              blocked by the deny-list on this page
            </span>
          </CardContent>
        </Card>
      </div>

      <SessionRegister
        rows={rows}
        canRevoke={canRevoke}
        onRevoke={revokeImpersonationSessionAction}
      />

      <TablePager
        total={total}
        limit={PAGE_SIZE}
        offset={params.offset}
        unit="sessions"
        hrefFor={(offset) => hrefWith(params, { offset: String(offset) })}
      />

      <p className="text-xs text-muted-foreground">
        A session ends when its clock runs out, whether or not anything writes the row.
        &ldquo;Live&rdquo; here means <code className="font-mono">now &lt; expires_at</code>{" "}
        and no end recorded — never the end column on its own, because a background job
        that stops running must not be able to make an expired session look open.
      </p>
    </div>
  );
}

function Filters({ params }: { params: ReturnType<typeof readParams> }) {
  return (
    <div className="space-y-3">
      <form className="flex flex-wrap items-end gap-3" method="get">
        {params.tenantId ? (
          <input type="hidden" name="tenant" value={params.tenantId} />
        ) : null}
        <div className="space-y-1">
          <label htmlFor="actor" className="text-xs text-muted-foreground">
            Operator email starts with
          </label>
          <input
            id="actor"
            name="actor"
            defaultValue={params.actor}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="days" className="text-xs text-muted-foreground">
            Look back (days)
          </label>
          <select
            id="days"
            name="days"
            defaultValue={String(params.days)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {[1, 7, 30, 90].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 pb-1">
          <input
            id="live"
            name="live"
            type="checkbox"
            value="1"
            defaultChecked={params.liveOnly}
            className="h-4 w-4 rounded border-input"
          />
          <label htmlFor="live" className="text-sm">
            Only sessions that are live now
          </label>
        </div>
        <button
          type="submit"
          className="h-9 rounded-md border border-input px-4 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Apply
        </button>
      </form>

      {params.tenantId ? (
        <p className="text-xs">
          Filtered to one workspace.{" "}
          <Link href={hrefWith(params, { tenant: undefined, offset: "0" })} className="underline">
            Show every workspace
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}
