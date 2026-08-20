/**
 * Ordence — Executive Dashboard
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * HOW THIS PAGE STREAMS
 * ══════════════════════════════════════════════════════════════════════
 * This component itself awaits almost nothing. It renders the header and
 * five `<Suspense>` boundaries, and returns.
 *
 * Each boundary wraps an async panel that fetches its own data. React
 * streams each one to the browser as its query resolves, so the page is
 * interactive immediately and fills in progressively — rather than showing
 * a blank screen until the slowest aggregate finishes.
 *
 * The slowest is the 30-day ledger view, which is also the least urgent
 * thing on the page. Under a single `await`, that one query would set the
 * arrival time for everything, including the quick actions someone came
 * here to click.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE PANELS FETCH RATHER THAN RECEIVING PROPS
 * ══════════════════════════════════════════════════════════════════════
 * Passing data down from here would mean awaiting it here, which collapses
 * the streaming back into one blocking render. Each panel owning its own
 * query is what makes the boundaries meaningful.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SECURITY POSITION, RESTATED BECAUSE THIS PAGE AGGREGATES
 * ══════════════════════════════════════════════════════════════════════
 * Every figure here comes from a SQL view created with
 * `security_invoker = true`, queried inside `withTenant()`.
 *
 * That combination is load-bearing. PostgreSQL views do NOT inherit
 * Row-Level Security by default — a view runs as its OWNER, so an ordinary
 * view over `journal_entries` returns every tenant's money to anyone who
 * can read it. Measured on PostgreSQL 16 during this phase: a session
 * pinned to one tenant saw 6 tenants through a naive view and 1 through a
 * `security_invoker` view.
 *
 * The failure mode has no symptom. Nothing errors; the dashboard renders;
 * the numbers are simply the whole platform's, shown to one customer as
 * their own. `npm run db:verify` asserts the setting is still in place.
 */

import { Suspense } from "react";
import { LayoutDashboard } from "lucide-react";
import { requirePageContext } from "@/server/tenant-context";
import { redirect } from "next/navigation";
import { BrandWatermark } from "@/components/branding/brand-watermark";
import { logoSrc } from "@/lib/branding/logo";
import { shouldPromptBrandingSetup, BRANDING_SETUP_PATH } from "@/lib/branding/first-run";
import { resolveIndustryTemplate } from "@/lib/industry-templates";
import {
  HeadlineTiles,
  FinancialPanel,
  AssetPanel,
  ContractPipelinePanel,
  ActivityPanel,
  QuickActionsPanel,
  CompliancePanel,
  ReceivablesPanel,
  AIInsightsPanel,
  NotificationsSummaryPanel,
} from "./panels";
import {
  StatTilesSkeleton,
  FinancialChartSkeleton,
  PieChartSkeleton,
  ActivityFeedSkeleton,
} from "./skeletons";

// Never cached. A dashboard showing yesterday's ledger is worse than one
// that takes another 200ms, and a cached page keyed without the tenant
// would be a cross-tenant leak of the most consequential kind.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardPage() {
  // The only await in this component. It is a single indexed lookup that
  // the session already implies, and the header cannot render without it.
  const ctx = await requirePageContext();

  /*
   * ⭐ WAVE 2E , THE FIRST RUN, ONCE AND ONLY FOR SOMEBODY WHO CAN ACT.
   *
   * The whole rule lives in `shouldPromptBrandingSetup()`, in `lib/`,
   * where it can be exercised against every combination of role and
   * stored branding without a browser.
   *
   * ⚠️ A MEMBER IS NEVER SENT. They cannot pass `settings:update`, so
   * they would land on a form they cannot submit , which is worse than
   * not being asked. And skipping counts as deciding: the prompt does
   * not come back, because a setup screen that reappears every morning
   * is a setup screen people learn to dismiss without reading.
   */
  if (shouldPromptBrandingSetup({ branding: ctx.tenant.branding, role: ctx.role })) {
    redirect(BRANDING_SETUP_PATH);
  }

  const settings = (ctx.tenant.settings ?? {}) as Record<string, unknown>;
  const template = resolveIndustryTemplate(settings.industry);

  const firstName = ctx.user.firstName?.trim();

  return (
    <main className="relative space-y-8 p-6">
      {/*
        ⚠️ BEHIND, AND OUT OF THE WAY. Bottom-right, at most 4% opacity,
        `aria-hidden`, `pointer-events-none`, hidden below `lg`.

        🔴 A WASH UNDER THE METRIC CARDS WOULD REDUCE THE CONTRAST OF THE
        FIGURES, which is the opposite of what a ledger is for. A
        watermark that makes a number harder to read has cost more than
        the branding is worth.
      */}
      <BrandWatermark src={logoSrc(ctx.tenant.branding)} />
      {/* ── HEADER ───────────────────────────────────────────────── */}
      <header>
        <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />
          {template.label} · Executive dashboard
        </p>

        <h1 className="mt-1 text-2xl font-bold">
          {firstName ? `Good to see you, ${firstName}` : ctx.tenant.name}
        </h1>

        <p className="mt-1 text-sm text-muted-foreground">
          Everything below is scoped to {ctx.tenant.name} and refreshed on every load.
        </p>
      </header>

      {/* ── HEADLINE FIGURES ─────────────────────────────────────── */}
      <Suspense fallback={<StatTilesSkeleton />}>
        <HeadlineTiles />
      </Suspense>

      {/* ── FINANCIAL + QUICK ACTIONS ────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="rounded-md border border-border p-4">
          <Suspense fallback={<FinancialChartSkeleton />}>
            <FinancialPanel />
          </Suspense>
        </div>

        <div className="rounded-md border border-border p-4">
          {/*
            Quick actions resolve from the session alone — no aggregate
            query — so this boundary almost always settles first. That is
            deliberate: the fastest thing on the page is the one someone
            most often came here to click.
          */}
          <Suspense
            fallback={
              <div className="space-y-2" aria-hidden="true">
                <div className="h-4 w-28 animate-pulse rounded bg-muted" />
                <div className="h-3 w-44 animate-pulse rounded bg-muted" />
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />
                ))}
              </div>
            }
          >
            <QuickActionsPanel />
          </Suspense>
        </div>
      </div>

      {/* ── PORTFOLIO + PIPELINE ─────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-md border border-border p-4">
          <Suspense fallback={<PieChartSkeleton />}>
            <AssetPanel />
          </Suspense>
        </div>

        <div className="rounded-md border border-border p-4">
          <Suspense
            fallback={
              <div className="space-y-3" aria-hidden="true">
                <div className="h-4 w-36 animate-pulse rounded bg-muted" />
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="h-3 w-full animate-pulse rounded bg-muted" />
                    <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
                  </div>
                ))}
              </div>
            }
          >
            <ContractPipelinePanel />
          </Suspense>
        </div>
      </div>

      {/* ── COMPLIANCE + RECEIVABLES (v0.82.0-alpha) ─────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-md border border-border p-4">
          <Suspense
            fallback={
              <div className="space-y-3" aria-hidden="true">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="grid grid-cols-3 gap-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />
                  ))}
                </div>
              </div>
            }
          >
            <CompliancePanel />
          </Suspense>
        </div>

        <div className="rounded-md border border-border p-4">
          <Suspense
            fallback={
              <div className="space-y-3" aria-hidden="true">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="grid grid-cols-2 gap-3">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />
                  ))}
                </div>
              </div>
            }
          >
            <ReceivablesPanel />
          </Suspense>
        </div>
      </div>

      {/* ── AI INSIGHTS + NOTIFICATIONS (v0.82.0-alpha) ──────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-md border border-border p-4">
          <Suspense
            fallback={
              <div className="space-y-3" aria-hidden="true">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-8 animate-pulse rounded bg-muted" />
                ))}
              </div>
            }
          >
            <AIInsightsPanel />
          </Suspense>
        </div>

        <div className="rounded-md border border-border p-4">
          <Suspense
            fallback={
              <div className="space-y-3" aria-hidden="true">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-8 animate-pulse rounded bg-muted" />
                ))}
              </div>
            }
          >
            <NotificationsSummaryPanel />
          </Suspense>
        </div>
      </div>

      {/* ── ACTIVITY ─────────────────────────────────────────────── */}
      <div className="rounded-md border border-border p-4">
        <Suspense fallback={<ActivityFeedSkeleton />}>
          <ActivityPanel />
        </Suspense>
      </div>

      <p className="border-t border-border pt-4 text-xs text-muted-foreground">
        Figures are read from tenant-scoped database views and are current as of
        this page load. Amounts are computed in exact decimal arithmetic — never
        floating point — so the totals here reconcile with the ledger.
      </p>
    </main>
  );
}
