/**
 * Ordence — Dashboard Panels
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY EACH PANEL IS ITS OWN ASYNC COMPONENT
 * ══════════════════════════════════════════════════════════════════════
 * Every panel below fetches its own data and is rendered inside its own
 * `<Suspense>` boundary in `page.tsx`.
 *
 * That structure is what makes the dashboard feel instant. If one component
 * awaited all four queries, the page would show nothing until the SLOWEST
 * one finished — and the slowest is the 30-day ledger aggregate, which is
 * also the least urgent thing on screen. Split, each panel streams in as
 * its own query resolves, so the quick ones are readable while the
 * expensive one is still running.
 *
 * The panels also fail independently. A broken analytics view takes out one
 * card, not the whole page, and the others still render — which matters
 * because a dashboard is often where someone looks when something is
 * already going wrong.
 */

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import {
  getAssetPortfolio,
  getLedgerTrailing30,
  getContractPipeline,
  getRecentActivity,
  getComplianceSummary,
  getReceivablesSummary,
  getAIInsights,
  getNotificationsSummary,
} from "@/server/actions/analytics";
import { FinancialBarChart } from "@/components/crm/charts/financial-bar-chart";
import { AssetPipelinePieChart } from "@/components/crm/charts/asset-pipeline-pie-chart";
import { RecentActivityFeed } from "@/components/crm/charts/recent-activity-feed";
import { QuickActions, buildQuickActions } from "@/components/crm/quick-actions";
import { formatCurrencyString, humaniseLabel } from "@/components/crm/charts/use-chart-mode";

/** A panel that could not load. One card fails; the page does not. */
function PanelError({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
      <p className="text-sm font-semibold text-destructive">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* HEADLINE TILES                                                      */
/* ------------------------------------------------------------------ */

/**
 * Four numbers, chosen because each one can prompt an action.
 *
 * "Total contracts" is a vanity number; "expiring in 30 days" is a task.
 * The tiles favour the second kind.
 */
export async function HeadlineTiles() {
  const [assets, contracts] = await Promise.all([
    getAssetPortfolio(),
    getContractPipeline(),
  ]);

  const tiles: Array<{
    label: string;
    value: string;
    hint: string;
    emphasis?: "normal" | "attention";
  }> = [];

  if (assets.ok) {
    tiles.push({
      label: "Assets under management",
      value: String(assets.data.totalAssets),
      hint: formatCurrencyString(assets.data.totalValue),
    });
  }

  if (contracts.ok) {
    tiles.push({
      label: "Contracts",
      value: String(contracts.data.totalContracts),
      hint: `${contracts.data.signedCount} signed`,
    });

    tiles.push({
      label: "Contract value",
      value: formatCurrencyString(contracts.data.totalValue),
      hint: "Across all stages",
    });

    tiles.push({
      label: "Expiring in 30 days",
      value: String(contracts.data.expiringSoonCount),
      hint:
        contracts.data.expiringSoonCount === 0
          ? "Nothing needs attention"
          : "Review before they lapse",
      // A word, not just a colour — status is never carried by hue alone.
      emphasis: contracts.data.expiringSoonCount > 0 ? "attention" : "normal",
    });
  }

  if (tiles.length === 0) {
    return (
      <PanelError
        title="Summary unavailable"
        message={
          (!assets.ok && assets.error) ||
          (!contracts.ok && contracts.error) ||
          "Could not load the summary figures."
        }
      />
    );
  }

  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-md border border-border p-4">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            {tile.label}
          </dt>
          <dd
            className={
              tile.emphasis === "attention"
                ? "mt-1.5 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-400"
                : "mt-1.5 text-2xl font-bold tabular-nums"
            }
          >
            {tile.value}
          </dd>
          <p className="mt-1 text-xs text-muted-foreground">{tile.hint}</p>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* FINANCIAL                                                           */
/* ------------------------------------------------------------------ */

export async function FinancialPanel() {
  const result = await getLedgerTrailing30();

  if (!result.ok) {
    return <PanelError title="Ledger unavailable" message={result.error} />;
  }

  return (
    <FinancialBarChart
      days={result.data.days}
      totalDebits={result.data.totalDebits}
      totalCredits={result.data.totalCredits}
      isBalanced={result.data.isBalanced}
      difference={result.data.difference}
      activeDays={result.data.activeDays}
    />
  );
}

/* ------------------------------------------------------------------ */
/* ASSETS                                                              */
/* ------------------------------------------------------------------ */

export async function AssetPanel() {
  const result = await getAssetPortfolio();

  if (!result.ok) {
    return <PanelError title="Portfolio unavailable" message={result.error} />;
  }

  return (
    <AssetPipelinePieChart
      slices={result.data.slices}
      totalAssets={result.data.totalAssets}
      totalValue={result.data.totalValue}
    />
  );
}

/* ------------------------------------------------------------------ */
/* CONTRACT PIPELINE                                                   */
/* ------------------------------------------------------------------ */

export async function ContractPipelinePanel() {
  const result = await getContractPipeline();

  if (!result.ok) {
    return <PanelError title="Pipeline unavailable" message={result.error} />;
  }

  const { stages, totalContracts, onHoldCount } = result.data;

  if (totalContracts === 0) {
    return (
      <section className="space-y-3" aria-labelledby="pipeline-heading">
        <h3 id="pipeline-heading" className="text-sm font-semibold">
          Contract pipeline
        </h3>
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No contracts yet.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3" aria-labelledby="pipeline-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="pipeline-heading" className="text-sm font-semibold">
          Contract pipeline
        </h3>
        {onHoldCount > 0 && (
          <span className="text-xs text-destructive">
            {onHoldCount} on legal hold
          </span>
        )}
      </div>

      {/*
        A proportional bar per stage rather than a second donut. Stages are
        ORDERED — draft precedes signed — and a donut throws that ordering
        away. Two donuts side by side would also invite comparison between
        two unrelated categorical scales.
      */}
      <ul className="space-y-2">
        {stages.map((stage) => {
          const share = (stage.contractCount / totalContracts) * 100;

          return (
            <li key={stage.status}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>{humaniseLabel(stage.status)}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {stage.contractCount}
                  <span className="ml-2 text-xs">
                    {formatCurrencyString(stage.totalValue)}
                  </span>
                </span>
              </div>

              <div
                className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`${humaniseLabel(stage.status)}: ${stage.contractCount} of ${totalContracts} contracts`}
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(share, 1.5)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* ACTIVITY                                                            */
/* ------------------------------------------------------------------ */

export async function ActivityPanel() {
  const result = await getRecentActivity(200);

  if (!result.ok) {
    // The audit log needs `audit:read`, which most roles do not have. A
    // permission refusal here is normal, not a fault, and should read that
    // way rather than as a red error card.
    return (
      <section className="space-y-3" aria-labelledby="activity-unavailable">
        <h3 id="activity-unavailable" className="text-sm font-semibold">
          Recent activity
        </h3>
        <p className="rounded-md border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          {result.error}
        </p>
      </section>
    );
  }

  return <RecentActivityFeed items={result.data} />;
}

/* ------------------------------------------------------------------ */
/* QUICK ACTIONS                                                       */
/* ------------------------------------------------------------------ */

export async function QuickActionsPanel() {
  const ctx = await requirePageContext();
  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };

  return (
    <QuickActions
      actions={buildQuickActions({
        canPostTransactions: can(subject, "transactions:post"),
        canUpdateContracts: can(subject, "contracts:update"),
        canApproveContracts: can(subject, "contracts:approve"),
        canCreateContacts: can(subject, "contacts:create"),
      })}
    />
  );
}


/* ------------------------------------------------------------------ */
/* COMPLIANCE PANEL (v0.82.0-alpha)                                    */
/* ------------------------------------------------------------------ */

export async function CompliancePanel() {
  const result = await getComplianceSummary();

  if (!result.ok) {
    return <PanelError title="Compliance unavailable" message={result.error} />;
  }

  const { pendingCount, overdueCount, dueIn7Days, nextDeadline, expiringLicences } = result.data;
  const hasAlerts = overdueCount > 0 || dueIn7Days > 0 || expiringLicences > 0;

  return (
    <section className="space-y-3" aria-labelledby="compliance-heading">
      <div className="flex items-baseline justify-between">
        <h3 id="compliance-heading" className="text-sm font-semibold">Compliance</h3>
        <a href="/compliance" className="text-xs text-primary hover:underline">View all →</a>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className={`rounded-md border p-3 ${overdueCount > 0 ? "border-red-300 bg-red-50" : "border-border"}`}>
          <p className="text-xs text-muted-foreground">Overdue</p>
          <p className={`mt-1 text-xl font-bold tabular-nums ${overdueCount > 0 ? "text-red-600" : ""}`}>{overdueCount}</p>
        </div>
        <div className={`rounded-md border p-3 ${dueIn7Days > 0 ? "border-amber-300 bg-amber-50" : "border-border"}`}>
          <p className="text-xs text-muted-foreground">Due in 7 days</p>
          <p className={`mt-1 text-xl font-bold tabular-nums ${dueIn7Days > 0 ? "text-amber-600" : ""}`}>{dueIn7Days}</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Pending</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{pendingCount}</p>
        </div>
      </div>

      {(nextDeadline || expiringLicences > 0) && (
        <div className="space-y-1.5 text-xs text-muted-foreground">
          {nextDeadline && (
            <p>⏰ Next deadline: <span className="font-medium text-foreground">{nextDeadline}</span></p>
          )}
          {expiringLicences > 0 && (
            <p>📋 <span className="font-medium text-amber-600">{expiringLicences} licence(s) expiring within 7 days</span></p>
          )}
        </div>
      )}

      {!hasAlerts && pendingCount === 0 && (
        <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          All compliance tasks are on track.
        </p>
      )}
    </section>
  );
}


/* ------------------------------------------------------------------ */
/* RECEIVABLES PANEL (v0.82.0-alpha)                                   */
/* ------------------------------------------------------------------ */

export async function ReceivablesPanel() {
  const result = await getReceivablesSummary();

  if (!result.ok) {
    return <PanelError title="Receivables unavailable" message={result.error} />;
  }

  const { totalOverdue, totalOutstanding, overdueCount, oldestDays } = result.data;

  function formatAmount(paise: number): string {
    const rupees = paise / 100;
    if (rupees >= 10000000) return `₹${(rupees / 10000000).toFixed(2)} Cr`;
    if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(2)} L`;
    if (rupees >= 1000) return `₹${(rupees / 1000).toFixed(1)}K`;
    return `₹${rupees.toFixed(0)}`;
  }

  return (
    <section className="space-y-3" aria-labelledby="receivables-heading">
      <div className="flex items-baseline justify-between">
        <h3 id="receivables-heading" className="text-sm font-semibold">Receivables</h3>
        <a href="/billing" className="text-xs text-primary hover:underline">View all →</a>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className={`rounded-md border p-3 ${overdueCount > 0 ? "border-red-300 bg-red-50" : "border-border"}`}>
          <p className="text-xs text-muted-foreground">Overdue</p>
          <p className={`mt-1 text-xl font-bold tabular-nums ${overdueCount > 0 ? "text-red-600" : ""}`}>{formatAmount(totalOverdue)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{overdueCount} notice(s)</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Total outstanding</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{formatAmount(totalOutstanding)}</p>
        </div>
      </div>

      {oldestDays > 0 && (
        <p className="text-xs text-muted-foreground">
          ⏳ Oldest overdue: <span className="font-medium text-foreground">{oldestDays} days</span>
        </p>
      )}

      {overdueCount === 0 && totalOutstanding === 0 && (
        <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          No outstanding receivables.
        </p>
      )}
    </section>
  );
}


/* ------------------------------------------------------------------ */
/* AI INSIGHTS PANEL (v0.82.0-alpha)                                   */
/* ------------------------------------------------------------------ */

const PATTERN_ICON: Record<string, string> = {
  late_compliance: "📋",
  overdue_receivable: "💰",
  gst_mismatch: "🧾",
  disputed_invoice: "⚠️",
  low_stock_reorder: "📦",
  licence_expiring: "📜",
  boq_variation_trend: "📊",
  field_job_repeat_visit: "🔧",
};

export async function AIInsightsPanel() {
  const result = await getAIInsights();

  if (!result.ok) {
    return <PanelError title="AI insights unavailable" message={result.error} />;
  }

  const { insights, totalPatterns } = result.data;

  return (
    <section className="space-y-3" aria-labelledby="ai-insights-heading">
      <div className="flex items-baseline justify-between">
        <h3 id="ai-insights-heading" className="text-sm font-semibold">AI insights</h3>
        {totalPatterns > insights.length && (
          <span className="text-xs text-muted-foreground">{totalPatterns} patterns</span>
        )}
      </div>

      {insights.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          No insights yet. Run the AI workers to generate patterns.
        </p>
      ) : (
        <ul className="space-y-2">
          {insights.map((insight) => (
            <li key={insight.patternKey} className="flex items-start gap-2 text-xs">
              <span className="shrink-0 text-base">
                {PATTERN_ICON[insight.patternType] ?? "•"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">{insight.summary}</p>
                <p className="mt-0.5 text-muted-foreground">
                  Seen {insight.occurrenceCount}× · {new Date(insight.lastSeen).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


/* ------------------------------------------------------------------ */
/* NOTIFICATIONS SUMMARY PANEL (v0.82.0-alpha)                         */
/* ------------------------------------------------------------------ */

const SEV_COLOR: Record<string, string> = {
  critical: "text-red-600",
  warning: "text-amber-600",
  info: "text-blue-600",
  success: "text-green-600",
};

export async function NotificationsSummaryPanel() {
  const result = await getNotificationsSummary();

  if (!result.ok) {
    return <PanelError title="Notifications unavailable" message={result.error} />;
  }

  const { unreadCount, recent } = result.data;

  return (
    <section className="space-y-3" aria-labelledby="notifications-heading">
      <div className="flex items-baseline justify-between">
        <h3 id="notifications-heading" className="text-sm font-semibold">
          Notifications
          {unreadCount > 0 && (
            <span className="ml-2 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
              {unreadCount}
            </span>
          )}
        </h3>
        <a href="/notifications" className="text-xs text-primary hover:underline">View all →</a>
      </div>

      {recent.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          No notifications yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {recent.map((n) => (
            <li key={n.id} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${n.severity === "critical" ? "bg-red-500" : n.severity === "warning" ? "bg-amber-500" : "bg-blue-500"}`} />
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${SEV_COLOR[n.severity] ?? "text-foreground"}`}>{n.title}</p>
                <p className="mt-0.5 text-muted-foreground">
                  {new Date(n.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · {n.category}
                </p>
              </div>
              {n.actionUrl && (
                <a href={n.actionUrl} className="shrink-0 text-xs text-primary hover:underline">→</a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
