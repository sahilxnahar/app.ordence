/**
 * Ordence — Platform Console · The Action Register
 * Version: v0.29.0-alpha (Phase 29)
 *
 * ══════════════════════════════════════════════════════════════════════
 * "WHO DID WHAT TO WHICH CUSTOMER" — AND WHY THE ANSWER IS IN TWO PLACES
 * ══════════════════════════════════════════════════════════════════════
 * This page shows `platform_action_log`: the actions that belong to NO
 * SINGLE TENANT — a cross-tenant search, a staff grant, a capability
 * denial, a step-up accepted without a verified second factor.
 *
 * Everything aimed at ONE workspace — opening it, suspending it, setting
 * a flag, starting or ending an impersonation — is written to that
 * CUSTOMER'S OWN audit log instead, and appears on their workspace page
 * under "Platform activity". Nothing is written to both, so nothing is
 * counted twice.
 *
 * That split is not a preference. The Phase 1 policy on `audit_logs` is
 * `WITH CHECK (tenant_id = app_current_tenant_id())`, so a row with no
 * tenant evaluates `NULL = NULL` → NULL and is REFUSED by the database.
 * A cross-tenant search genuinely cannot be stored there. The upside is
 * the one that matters: everything we do TO a customer is something the
 * customer can see us doing, in their own log, without asking us.
 *
 * ⚠️ THIS TABLE IS APPEND-ONLY IN THE DATABASE — a trigger refuses UPDATE
 * and DELETE, and the application role holds no DELETE privilege at all.
 * A console that could tidy its own access log would be a console whose
 * log means nothing.
 */

import { Suspense } from "react";
import { listPlatformActions, listPlatformActionKinds } from "@/server/platform/action-log";
import { ActionLogTable } from "@/components/platform/action-log-table";
import { TablePager } from "@/components/platform/table-pager";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readParams(params: Record<string, string | string[] | undefined>) {
  const str = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  const offset = Number.parseInt(str("offset") ?? "0", 10);
  const days = Number.parseInt(str("days") ?? "7", 10);
  return {
    actor: str("actor"),
    action: str("action"),
    severity: str("severity") ?? "all",
    days: Number.isFinite(days) ? Math.min(Math.max(days, 1), 90) : 7,
    offset: Number.isFinite(offset) && offset > 0 ? Math.min(offset, 10_000) : 0,
  };
}

function hrefWith(
  current: ReturnType<typeof readParams>,
  changes: Record<string, string | undefined>,
): string {
  const search = new URLSearchParams();
  const base: Record<string, string | undefined> = {
    actor: current.actor,
    action: current.action,
    severity: current.severity,
    days: String(current.days),
    offset: String(current.offset),
  };
  for (const [key, value] of Object.entries({ ...base, ...changes })) {
    if (
      !value ||
      value === "all" ||
      (key === "offset" && value === "0") ||
      (key === "days" && value === "7")
    ) {
      continue;
    }
    search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `/platform/log?${qs}` : "/platform/log";
}

export default async function PlatformLogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = readParams(await searchParams);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Platform action register</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every action by platform staff that belongs to no single workspace — searches
          across every customer, staff grants, refused capabilities. Actions aimed at one
          workspace live in that customer&rsquo;s own audit log and are shown on their
          page.
        </p>
      </div>

      <Suspense key={JSON.stringify(params)} fallback={<Skeleton />}>
        <LogBody params={params} />
      </Suspense>
    </div>
  );
}

async function LogBody({ params }: { params: ReturnType<typeof readParams> }) {
  const [result, kinds] = await Promise.all([
    listPlatformActions({
      actor: params.actor,
      action: params.action,
      severity: params.severity as "all" | "info" | "notice" | "warning" | "critical",
      days: params.days,
      limit: PAGE_SIZE,
      offset: params.offset,
    }),
    listPlatformActionKinds().catch(() => [] as string[]),
  ]);

  if (!result.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {result.error}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <Filters params={params} kinds={kinds} />

      {params.actor ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-xs">
          You have narrowed the register to one named operator. That is an investigation
          rather than browsing, so it has been recorded against your name — the same trail
          everybody else gets.
        </p>
      ) : null}

      <ActionLogTable rows={result.data.rows} />

      <TablePager
        total={result.data.total}
        limit={PAGE_SIZE}
        offset={params.offset}
        unit="entries"
        hrefFor={(offset) => hrefWith(params, { offset: String(offset) })}
      />
    </div>
  );
}

function Filters({
  params,
  kinds,
}: {
  params: ReturnType<typeof readParams>;
  kinds: string[];
}) {
  return (
    <form className="flex flex-wrap items-end gap-3" method="get">
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
        <label htmlFor="action" className="text-xs text-muted-foreground">
          Action
        </label>
        <select
          id="action"
          name="action"
          defaultValue={params.action ?? ""}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">any</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="severity" className="text-xs text-muted-foreground">
          Severity
        </label>
        <select
          id="severity"
          name="severity"
          defaultValue={params.severity}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {["all", "info", "notice", "warning", "critical"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
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

      <button
        type="submit"
        className="h-9 rounded-md border border-input px-4 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Apply
      </button>
    </form>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}
