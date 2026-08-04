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
