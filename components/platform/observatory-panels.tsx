/**
 * Ordence — Observatory panels
 * Version: v0.32.0-alpha
 *
 * Presentational only. Every number arrives already computed by
 * `server/platform/observatory.ts`; nothing here queries, derives or
 * rounds. That split is deliberate — a dashboard that does its own maths
 * in the browser is a dashboard that disagrees with the database the
 * first time a rounding rule changes on one side.
 */

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type {
  ObservatoryTotals,
  TenantVital,
  FeatureAdoption,
  CohortRetention,
} from "@/server/platform/observatory";

/* ------------------------------------------------------------------ */
/* MONEY                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Takes a STRING. Money is bigint minor units in Postgres and it stays a
 * string the whole way here — parsing it into a JavaScript number to format
 * it would reintroduce exactly the precision loss the string exists to
 * prevent, at the very last step, where nobody would look for it.
 */
function money(minorUnits: string, currency: string): string {
  const negative = minorUnits.startsWith("-");
  const digits = (negative ? minorUnits.slice(1) : minorUnits).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);

  // Indian grouping: last three digits, then pairs. 1234567 → 12,34,567
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;

  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${negative ? "-" : ""}${symbol}${grouped}.${frac}`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/* ------------------------------------------------------------------ */
/* BUDGET BURN-DOWN                                                    */
/* ------------------------------------------------------------------ */

/**
 * The shared daily request ceiling.
 *
 * ⚠️ THE MOST IMPORTANT NUMBER ON THE PLATFORM, and the least obvious.
 * Every other limit in Ordence is per-tenant: one customer exceeding it
 * affects one customer. This one is shared across the whole account, so
 * the tenant who blows through it takes every other tenant offline with
 * them — and none of them, including the offender, can see it from inside
 * their own workspace.
 */
function BudgetBar({ totals }: { totals: ObservatoryTotals }) {
  const pct = totals.budgetUsedPct;
  const tone =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  const verdict =
    pct >= 90
      ? "Critical — requests will start being refused platform-wide."
      : pct >= 70
        ? "Watch this. Consider Workers Paid before it matters."
        : "Comfortable.";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Shared daily request budget
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">{pct}%</span>
          <span className="text-sm text-muted-foreground">
            {compact(totals.requestsToday)} of {compact(totals.requestBudget)} today
          </span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Share of the platform-wide daily request budget consumed"
        >
          <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">{verdict}</p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* TOTALS                                                              */
/* ------------------------------------------------------------------ */

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tabular-nums">{value}</div>
        {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

export function ObservatoryTotalsRow({ totals }: { totals: ObservatoryTotals }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label="Committed MRR"
        value={money(totals.mrrMinor, totals.currency)}
        sub={`${totals.activeTenants} active · ${totals.trialTenants} trialing · ${totals.suspendedTenants} suspended`}
      />
      <Stat
        label="Workspaces"
        value={String(totals.tenants)}
        sub="Every tenant on the platform"
      />
      <Stat
        label="Errors · 24h"
        value={String(totals.errorsLast24h)}
        sub={`${totals.errorRatePerK} per 1,000 requests`}
      />
      <BudgetBar totals={totals} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CHURN SIREN                                                         */
/* ------------------------------------------------------------------ */

/**
 * Tenants with at least one alarm, worst first.
 *
 * ⚠️ THIS PANEL IS FIRST ON THE PAGE ON PURPOSE. A cockpit that opens on
 * a revenue total trains you to feel good; a cockpit that opens on the
 * accounts about to leave trains you to act. The revenue total is one
 * scroll away and it is not going anywhere.
 */
export function NeedsAttention({ rows }: { rows: TenantVital[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Needs attention</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Nothing is alarming right now — no silent accounts, no error spikes,
            nobody near a quota.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Needs attention
          <Badge variant="destructive">{rows.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.tenantId} className="flex flex-wrap items-start gap-3 p-4">
              <div className="min-w-48 flex-1">
                <Link
                  href={`/platform/tenants/${row.tenantId}`}
                  className="font-medium hover:underline"
                >
                  {row.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {row.slug} · {row.planTier}
                </p>
              </div>
              <ul className="flex flex-1 flex-wrap gap-2">
                {row.alarms.map((alarm) => (
                  <li key={alarm}>
                    <Badge variant="outline" className="text-xs font-normal">
                      {alarm}
                    </Badge>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* FLEET VITALS                                                        */
/* ------------------------------------------------------------------ */

export function FleetVitals({
  rows,
  currency,
}: {
  rows: TenantVital[];
  currency: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fleet vitals</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Workspace</th>
                <th className="p-3 text-right font-medium">MRR</th>
                <th className="p-3 text-right font-medium">Requests today</th>
                <th className="p-3 text-right font-medium">Budget share</th>
                <th className="p-3 text-right font-medium">Errors 24h</th>
                <th className="p-3 text-right font-medium">p75 LCP</th>
                <th className="p-3 text-right font-medium">Storage</th>
                <th className="p-3 text-right font-medium">Last active</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.tenantId} className="hover:bg-muted/30">
                  <td className="p-3">
                    <Link
                      href={`/platform/tenants/${row.tenantId}`}
                      className="font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{row.slug}</div>
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {money(row.mrrMinor, currency)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {compact(row.requestsToday)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {row.budgetSharePct >= 25 ? (
                      <span className="font-medium text-amber-600">
                        {row.budgetSharePct}%
                      </span>
                    ) : (
                      `${row.budgetSharePct}%`
                    )}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {row.errors24h > 0 ? (
                      <span className="font-medium text-red-600">{row.errors24h}</span>
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="p-3 text-right tabular-nums text-muted-foreground">
                    {/* No sample is not the same as fast. Say which. */}
                    {row.p75LcpMs === null ? "—" : `${Math.round(row.p75LcpMs)}ms`}
                  </td>
                  <td className="p-3 text-right tabular-nums text-muted-foreground">
                    {row.storageLimitMb > 0 ? `${row.storagePct}%` : "—"}
                  </td>
                  <td className="p-3 text-right text-muted-foreground">
                    {row.daysSilent === null
                      ? "never"
                      : row.daysSilent === 0
                        ? "today"
                        : `${row.daysSilent}d ago`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* ADOPTION HEATMAP                                                    */
/* ------------------------------------------------------------------ */

/**
 * Which modules earn their keep.
 *
 * A bar per metered capability, showing what share of tenants touched it in
 * the last 30 days. A module at 3% is either badly placed, badly explained,
 * or genuinely unwanted — and all three are worth knowing before more of it
 * gets built.
 */
export function AdoptionHeatmap({ rows }: { rows: FeatureAdoption[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Feature adoption · 30 days</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No metered activity yet. Adoption appears once tenants start using
            metered capabilities.
          </p>
        ) : (
          rows.map((row) => (
            <div key={row.metric} className="space-y-1">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium">{row.metric.replace(/_/g, " ")}</span>
                <span className="tabular-nums text-muted-foreground">
                  {row.tenantsUsing}/{row.tenantsTotal} · {row.adoptionPct}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${row.adoptionPct}%` }}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* COHORT RETENTION                                                    */
/* ------------------------------------------------------------------ */

export function CohortTable({ rows }: { rows: CohortRetention[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Retention by signup month</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Cohort</th>
              <th className="p-3 text-right font-medium">Started</th>
              <th className="p-3 text-right font-medium">Active now</th>
              <th className="p-3 text-right font-medium">Retained</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.cohortMonth}>
                <td className="p-3 font-medium">{row.cohortMonth}</td>
                <td className="p-3 text-right tabular-nums">{row.tenantsStarted}</td>
                <td className="p-3 text-right tabular-nums">{row.stillActive}</td>
                <td className="p-3 text-right tabular-nums">
                  <span
                    className={
                      row.retentionPct >= 80
                        ? "text-emerald-600"
                        : row.retentionPct >= 50
                          ? "text-amber-600"
                          : "text-red-600"
                    }
                  >
                    {row.retentionPct}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
