/**
 * Ordence — Platform Console · ⭐⭐⭐ TENANT 360
 * Version: v1.52.0-alpha (Batch 125)
 *
 * ⚠️ REACHING THIS PAGE IS AN AUDITED EVENT — TWICE. `getTenantDetail()`
 * writes a row into the CUSTOMER'S own audit log saying the workspace was
 * opened, and `getTenantInsights()` writes a second one saying their
 * usage, invoices and security events were read. Two rows because they
 * are two different accesses: "I looked at their plan" and "I read their
 * payment history and their sign-in failures" are not the same sentence,
 * and a customer reviewing the trail is entitled to both.
 *
 * 🔴 AND EXACTLY TWO, NO MATTER HOW MANY PANELS ASK. Six panels now read
 * insights independently, and six audit rows saying the same thing at the
 * same second would turn the customer's trail into noise — which is how a
 * trail stops being read. Both readers are wrapped in React `cache()`
 * below, which dedupes them for the life of ONE request. See the note on
 * `insightsOnce`.
 *
 * That is also why the directory listing writes nothing: if every glance
 * at a dashboard wrote a row, the rows that matter would be buried.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ EIGHT TABS, ONE PER QUESTION SOMEBODY ARRIVES WITH
 * ══════════════════════════════════════════════════════════════════════
 *   Overview        what is this workspace, in nine facts
 *   Plan and seats  what they bought, and the one thing editable here
 *   Health          why we think they are fine, or not
 *   Incidents       🔴 NOT WIRED — and it says so, see below
 *   Entitlements    which switches are flipped for them
 *   Billing         what they were charged and whether they paid
 *   Activity        what we did to them
 *   Access          who can get in, who has been in, and the two
 *                   irreversible acts (rename, termination)
 *
 * The tab lives in `?tab=` so a link in a ticket lands on the tab the
 * writer meant — see the header of `components/platform/tenant-tabs.tsx`.
 *
 * ⚠️ EACH PANEL HAS ITS OWN `<Suspense>`, and that is not decoration.
 * The three reads behind this page — the workspace row, the insights
 * bundle, the flag list — hit different tables with different failure
 * modes. Awaiting all three before painting anything means the slowest
 * one sets the speed of a screen somebody opened during an incident.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS PAGE SHOWS, AND THE ONE THING IT NEVER WILL
 * ══════════════════════════════════════════════════════════════════════
 * Plan and subscription state, revenue, seats and storage, usage over
 * time, invoices, security events, consent history, feature flags, and
 * every platform action taken against this workspace.
 *
 * NOT: contacts, companies, deals, documents by name, contract text,
 * journal narrations — anything the customer typed about a third party.
 * If an operator needs to see a record, that is impersonation: consented,
 * expiring, bannered, and attributable to them by name.
 */

import { Suspense, cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTenantDetail, type TenantDetail } from "@/server/platform/tenants";
import { getTenantInsights } from "@/server/platform/insights";
import { listTenantFlags } from "@/server/platform/flags";
import { hasLiveConsent } from "@/server/platform/consent";
import { getPlatformOperator } from "@/server/platform/guard";
import {
  suspendTenantAction,
  reactivateTenantAction,
  startImpersonationAction,
  setTenantFlagAction,
  requestTerminationAction,
  cancelTerminationAction,
  exportOffboardingSnapshotAction,
  renameTenantSlugAction,
} from "@/server/platform/actions";
import { setPlanAndLimitsAction } from "@/server/platform/config-actions";
import { TenantActions } from "@/components/platform/tenant-actions";
import { RenameSlugCard } from "@/components/platform/rename-slug-card";
import { FlagEditor } from "@/components/platform/flag-editor";
import { consoleHref, onConsoleHost } from "@/lib/platform/console-href";
import { rejection } from "@/lib/slug";
import { OffboardingPanel } from "@/components/platform/offboarding-panel";
import { PlanSeatsCard } from "@/components/platform/plan-seats-card";
import { TenantTabs, type TenantTabDef } from "@/components/platform/tenant-tabs";
import { TenantActivityTable } from "@/components/platform/tenant-activity-table";
import {
  UsagePanel,
  InvoicePanel,
  SecurityPanel,
  PeoplePanel,
  ConsentPanel,
  IncidentsNotWiredPanel,
  SessionHistoryLink,
} from "@/components/platform/tenant-panels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HEALTH_LABELS, healthBadgeVariant, formatStorage } from "@/lib/platform/health";
import { MODE_LABELS, SCOPE_LABELS } from "@/lib/platform/impersonation-policy";
import { formatMoney } from "@/lib/billing/money";
import type { ImpersonationMode, ImpersonationScope } from "@/db/schema/platform";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* THE TWO AUDITED READS, DEDUPED FOR THE LIFE OF ONE REQUEST          */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ `cache()` IS DOING TWO JOBS AT ONCE HERE, AND BOTH MATTER.
 *
 *   1. It keeps the audit trail honest. Six panels awaiting the insights
 *      bundle would otherwise write six identical rows into the
 *      customer's log for one page view.
 *   2. It keeps the panels independent ANYWAY. Every caller awaits the
 *      SAME promise, so each `<Suspense>` boundary resolves the moment
 *      that one read lands — and a panel backed by a different read (the
 *      flag list) is not held up by it at all.
 *
 * ⚠️ THE CACHE IS PER-REQUEST, NOT A CACHE OF DATA. React discards it
 * when the render finishes; nothing here can serve one operator a
 * workspace row fetched during another operator's request.
 */
const insightsOnce = cache((tenantId: string) => getTenantInsights(tenantId));
const detailOnce = cache((tenantId: string) => getTenantDetail(tenantId));

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-md bg-muted" />}>
      <TenantDetailBody tenantId={id} />
    </Suspense>
  );
}

/** The eight tabs, in the order an operator reads them. */
const TABS: readonly TenantTabDef[] = [
  { value: "overview", label: "Overview" },
  { value: "plan", label: "Plan and seats" },
  { value: "health", label: "Health" },
  { value: "incidents", label: "Incidents" },
  { value: "entitlements", label: "Entitlements" },
  { value: "billing", label: "Billing" },
  { value: "activity", label: "Activity" },
  { value: "access", label: "Access" },
] as const;

/** One skeleton, so a loading panel is recognisably a loading panel. */
function PanelSkeleton({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-border p-6" role="status" aria-live="polite">
      {/* The WORD, not just a shimmer: a grey box is indistinguishable
          from an empty tab for anybody who cannot see the animation. */}
      <p className="text-sm text-muted-foreground">Loading {label}…</p>
      <div aria-hidden className="mt-3 h-24 animate-pulse rounded-md bg-muted" />
    </div>
  );
}

async function TenantDetailBody({ tenantId }: { tenantId: string }) {
  // ⚠️ Two base paths for this console. An entitlement write held by
  // `entitlement.override_paid` links to the approvals queue, and
  // `/platform/...` on the console host is a 404 rather than a rewrite.
  const isConsole = await onConsoleHost();
  const operator = await getPlatformOperator();
  if (!operator) notFound();

  const result = await detailOnce(tenantId);
  if (!result.ok) notFound();

  const tenant = result.data;
  const consent = await hasLiveConsent(tenantId);
  const can = (c: string) => operator.capabilities.includes(c as never);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <h1 className="text-lg font-semibold">{tenant.name}</h1>
          <p className="font-mono text-xs text-muted-foreground">{tenant.slug}</p>
        </div>
        <Badge variant={healthBadgeVariant(tenant.health.level)}>
          {HEALTH_LABELS[tenant.health.level]}
        </Badge>
        {tenant.status === "suspended" ? <Badge variant="destructive">suspended</Badge> : null}
        {tenant.impersonationLive ? (
          <Badge variant="destructive" data-testid="detail-live-impersonation">
            platform staff inside right now
          </Badge>
        ) : null}

        {/*
          The one write-heavy surface, kept off this page on purpose — see
          the header of `configure/page.tsx`. This page is what somebody
          reads with a customer on the phone; that one changes what the
          customer sees tomorrow.
        */}
        <Link
          href={consoleHref(`/platform/tenants/${tenant.id}/configure`, isConsole)}
          className="text-sm underline"
        >
          Configure modules, plan and industry
        </Link>

        <div className="ml-auto">
          {/*
            ⚠️ THE ACTION BAR NEEDS THE USER LIST, WHICH IS AN INSIGHTS
            READ — so it gets its own boundary too rather than holding
            the workspace name and the health badge hostage behind it.
          */}
          <Suspense fallback={<PanelSkeleton label="the action bar" />}>
            <ActionBar
              tenant={tenant}
              hasConsent={consent}
              canSuspend={can("tenants:suspend")}
              canImpersonate={can("impersonate:consented")}
              canBreakGlass={can("impersonate:breakglass")}
            />
          </Suspense>
        </div>
      </div>

      {/*
        The customer's OWN access state, computed by the same
        `evaluateAccess()` their banner uses. A console with its own idea
        of what a customer can do turns every support call into two people
        describing different systems.
      */}
      <Card>
        <CardHeader>
          <CardTitle>What this customer currently sees</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            Access level: <strong>{tenant.accessLevel}</strong>
          </p>
          <p className="text-muted-foreground">
            {tenant.accessHeadline ?? "No banner is shown to them."}
          </p>
          {tenant.status === "suspended" ? (
            <p className="text-xs text-muted-foreground">
              Suspended workspaces stay read-locked but keep sign-in, billing and export.
              Nothing has been deleted.
            </p>
          ) : null}

          {/*
            ⭐⭐ THE SUSPENSION MESSAGE, RESOLVED THROUGH THE CHAIN —
            BATCH 47. It was collected by the suspend form and dropped
            into an audit blob nothing could read back. It now has a
            global default, a plan-level variant and a per-workspace
            override, and this is where an operator can see which of the
            three is on file before they lock anybody out.

            ⚠️ AND THE HONEST SENTENCE UNDERNEATH. The banner the
            customer actually sees is built by `evaluateAccess()` in
            `lib/billing/access-state.ts` and does not read this value.
            Saying so here is the difference between a control and a
            control-shaped text box.
          */}
          <div className="rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">
              Customer-facing suspension message ·{" "}
              <strong>{LAYER_WORDS[tenant.suspensionMessage.layer]}</strong>
              {tenant.suspensionMessage.setByEmail
                ? ` · set by ${tenant.suspensionMessage.setByEmail}`
                : ""}
            </p>
            <p className="mt-1">{tenant.suspensionMessage.effective}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              ⚠️ Not yet rendered to the customer: the lockout banner they see is a fixed
              sentence in <code className="font-mono">lib/billing/access-state.ts</code>,
              which does not consult this value. This is what is on file, not what they read.
            </p>
          </div>
        </CardContent>
      </Card>

      <Suspense fallback={null}>
        <DegradedNotice tenantId={tenantId} />
      </Suspense>

      <TenantTabs
        tabs={TABS}
        panels={{
          overview: <OverviewPanel tenant={tenant} />,

          plan: (
            <div className="space-y-6">
              <PlanSeatsCard
                tenantId={tenant.id}
                tenantName={tenant.name}
                planTier={tenant.planTier}
                seatLimit={tenant.seatLimit}
                seatsInUse={tenant.seatsInUse}
                storageLimitMb={tenant.storageLimitMb}
                storageUsedMb={tenant.storageUsedMb}
                mrrMinor={tenant.mrrMinor}
                perSeatMinor={tenant.subscription?.perSeatAmountMinor ?? null}
                currency={tenant.currency}
                /*
                  ⚠️ A COURTESY, NOT A CONTROL. `setPlanAndLimits()`
                  re-checks `tenants:configure` and re-runs the
                  over-commit test against usage read inside its own
                  transaction — because a `"use server"` export is a
                  public HTTP endpoint reachable from any page.
                */
                canEdit={can("tenants:configure")}
                onSave={setPlanAndLimitsAction}
              />
              <section aria-labelledby="seat-holders-heading">
                <h2 id="seat-holders-heading" className="text-sm font-medium">
                  Who is holding those seats
                </h2>
                <Suspense fallback={<PanelSkeleton label="the people in this workspace" />}>
                  <PeopleTab tenantId={tenantId} />
                </Suspense>
              </section>
            </div>
          ),

          health: (
            <Suspense fallback={<PanelSkeleton label="health and usage" />}>
              <HealthTab tenantId={tenantId} tenant={tenant} />
            </Suspense>
          ),

          incidents: (
            <IncidentsNotWiredPanel
              tenantName={tenant.name}
              incidentsHref={consoleHref("/platform/incidents", isConsole)}
            />
          ),

          entitlements: (
            <Suspense fallback={<PanelSkeleton label="entitlements" />}>
              <EntitlementsTab
                tenantId={tenantId}
                canWrite={can("flags:write")}
                isConsoleHost={isConsole}
                configureHref={consoleHref(
                  `/platform/tenants/${tenant.id}/configure`,
                  isConsole,
                )}
              />
            </Suspense>
          ),

          billing: (
            <Suspense fallback={<PanelSkeleton label="billing" />}>
              <BillingTab tenantId={tenantId} tenant={tenant} />
            </Suspense>
          ),

          activity: (
            <Suspense fallback={<PanelSkeleton label="platform activity" />}>
              <ActivityTab tenantId={tenantId} />
            </Suspense>
          ),

          access: (
            <AccessTab
              tenant={tenant}
              isConsoleHost={isConsole}
              canRename={can("tenants:provision")}
              canTerminate={can("tenants:suspend")}
            />
          ),
        }}
      />
    </div>
  );
}

/* ================================================================== */
/* PANELS — each one owns its own read and its own failure             */
/* ================================================================== */

/**
 * ⚠️ EMPTY IS NOT THE SAME AS NOTHING HAPPENED, and this banner is the
 * only thing standing between those two readings. It stays above the
 * tabs, not inside one, because the operator who needs it is the one who
 * is about to say "no, there were no failed sign-ins".
 */
async function DegradedNotice({ tenantId }: { tenantId: string }) {
  const insights = await insightsOnce(tenantId);
  if (!insights.ok || insights.data.degraded.length === 0) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      Some panels could not be read ({insights.data.degraded.join(", ")}). Empty is not the
      same as nothing happened — treat those tabs as unknown, not as clear.
    </p>
  );
}

async function ActionBar({
  tenant,
  hasConsent,
  canSuspend,
  canImpersonate,
  canBreakGlass,
}: {
  tenant: TenantDetail;
  hasConsent: boolean;
  canSuspend: boolean;
  canImpersonate: boolean;
  canBreakGlass: boolean;
}) {
  const insights = await insightsOnce(tenant.id);
  const users = insights.ok ? insights.data.users : [];

  return (
    <TenantActions
      tenantId={tenant.id}
      tenantSlug={tenant.slug}
      tenantName={tenant.name}
      status={tenant.status}
      hasConsent={hasConsent}
      canSuspend={canSuspend}
      canImpersonate={canImpersonate}
      canBreakGlass={canBreakGlass}
      onSuspend={suspendTenantAction}
      onReactivate={reactivateTenantAction}
      onImpersonate={startImpersonationAction}
      subjectUsers={users
        .filter((u) => u.status === "active" && !u.isPlatformStaff)
        .map((u) => ({ id: u.id, email: u.email, role: u.role }))}
    />
  );
}

function OverviewPanel({ tenant }: { tenant: TenantDetail }) {
  return (
    <div>
      <dl className="grid gap-4 rounded-md border border-border p-4 text-sm sm:grid-cols-3">
        <Fact label="Plan" value={tenant.planTier} />
        <Fact label="Subscription" value={tenant.subscriptionStatus ?? "none"} />
        {/* 🔴 paise as `bigint`. Never `Number`, never `toFixed`. */}
        <Fact
          label="Committed MRR"
          value={formatMoney(BigInt(tenant.mrrMinor), tenant.currency)}
        />
        <Fact label="Seats" value={`${tenant.seatsInUse} of ${tenant.seatLimit}`} />
        <Fact
          label="Storage"
          value={`${formatStorage(tenant.storageUsedMb)} of ${formatStorage(
            tenant.storageLimitMb,
          )}`}
        />
        <Fact label="Failed payments" value={String(tenant.failedPaymentCount)} />
        <Fact label="Created" value={tenant.createdAt.slice(0, 10)} />
        <Fact label="Renews" value={tenant.currentPeriodEnd?.slice(0, 10) ?? "—"} />
        <Fact label="Last activity" value={tenant.lastActivityAt?.slice(0, 10) ?? "never"} />
      </dl>
    </div>
  );
}

async function PeopleTab({ tenantId }: { tenantId: string }) {
  const insights = await insightsOnce(tenantId);
  if (!insights.ok) {
    return <ReadFailed what="The workspace people" error={insights.error} />;
  }
  return <PeoplePanel users={insights.data.users} />;
}

/**
 * ⭐ HEALTH IS THE VERDICT AND THE EVIDENCE ON ONE TAB.
 *
 * The badge in the header says "at risk". This tab is why: the signals
 * that produced the verdict, then the metered usage those signals were
 * computed from. A score with no evidence under it is a number an
 * operator either believes or ignores — never one they can argue with.
 */
async function HealthTab({
  tenantId,
  tenant,
}: {
  tenantId: string;
  tenant: TenantDetail;
}) {
  const insights = await insightsOnce(tenantId);

  return (
    <div className="space-y-6">
      <section aria-labelledby="health-verdict-heading">
        <h2 id="health-verdict-heading" className="text-sm font-medium">
          Verdict: {HEALTH_LABELS[tenant.health.level]}
        </h2>
        {tenant.health.signals.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No signal fired. Nothing about this workspace looks wrong.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {tenant.health.signals.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                {/* The severity WORD is the meaning; the colour repeats it. */}
                <Badge variant={s.severity === "risk" ? "destructive" : "outline"}>
                  {s.severity}
                </Badge>
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="health-usage-heading">
        <h2 id="health-usage-heading" className="text-sm font-medium">
          The usage those signals were read from
        </h2>
        <div className="mt-2">
          {insights.ok ? (
            <UsagePanel usage={insights.data.usage} levels={insights.data.levels} />
          ) : (
            <ReadFailed what="Usage" error={insights.error} />
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * ⚠️ ENTITLEMENTS ON THIS PAGE MEANS THE PER-WORKSPACE OVERRIDES — the
 * flags somebody flipped for this customer specifically, with a reason
 * and an expiry.
 *
 * The MODULE MATRIX (which product areas this plan includes) deliberately
 * is not duplicated here. It lives on the configure screen, behind
 * `getWorkspaceConfiguration()`, which writes its own audit row against
 * the customer — and rendering it here would write a THIRD row into their
 * log for every glance at this page. The link says where it is instead.
 */
async function EntitlementsTab({
  tenantId,
  canWrite,
  isConsoleHost,
  configureHref,
}: {
  tenantId: string;
  canWrite: boolean;
  isConsoleHost: boolean;
  configureHref: string;
}) {
  const flags = await listTenantFlags(tenantId);
  if (!flags.ok) return <ReadFailed what="Entitlement overrides" error={flags.error} />;

  return (
    <div className="space-y-4">
      <FlagEditor
        tenantId={tenantId}
        flags={flags.data}
        canWrite={canWrite}
        onSet={setTenantFlagAction}
        isConsoleHost={isConsoleHost}
      />
      <p className="text-xs text-muted-foreground">
        These are the overrides written for this workspace. Which modules the PLAN itself
        includes is on the configure screen — not repeated here, because reading it writes
        another row into this customer&rsquo;s audit log.{" "}
        <Link href={configureHref} className="underline underline-offset-2">
          Open the configure screen
        </Link>
        .
      </p>
    </div>
  );
}

async function BillingTab({
  tenantId,
  tenant,
}: {
  tenantId: string;
  tenant: TenantDetail;
}) {
  const insights = await insightsOnce(tenantId);
  const sub = tenant.subscription;

  return (
    <div className="space-y-4">
      {sub ? (
        <dl className="grid gap-4 rounded-md border border-border p-4 text-sm sm:grid-cols-3">
          <Fact label="Status" value={sub.status} />
          <Fact label="Billed" value={sub.interval} />
          <Fact label="Provider" value={sub.provider} />
          <Fact label="Seats purchased" value={String(sub.seatsPurchased)} />
          {/* 🔴 Every amount below is paise as `bigint`. */}
          <Fact
            label="Base amount"
            value={formatMoney(BigInt(sub.unitAmountMinor), sub.currency)}
          />
          <Fact
            label="Per seat"
            value={formatMoney(BigInt(sub.perSeatAmountMinor), sub.currency)}
          />
          <Fact
            label="Seats at the per-seat price"
            value={formatMoney(
              BigInt(sub.perSeatAmountMinor) * BigInt(sub.seatsPurchased),
              sub.currency,
            )}
          />
          <Fact
            label="Current period"
            value={`${sub.currentPeriodStart?.slice(0, 10) ?? "—"} → ${
              sub.currentPeriodEnd?.slice(0, 10) ?? "—"
            }`}
          />
          <Fact
            label="Cancels at period end"
            value={sub.cancelAtPeriodEnd ? "yes" : "no"}
          />
          <Fact label="Cancelled" value={sub.cancelledAt?.slice(0, 10) ?? "—"} />
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          No subscription record. This workspace is not being billed.
        </p>
      )}

      {insights.ok ? (
        <InvoicePanel invoices={insights.data.invoices} />
      ) : (
        <ReadFailed what="Invoices" error={insights.error} />
      )}

      <p className="text-xs text-muted-foreground">
        The console can read billing and cannot change it: the platform clause is on the
        read policy of <code className="font-mono">subscriptions</code> and{" "}
        <code className="font-mono">invoices</code> and on neither write policy. A plan
        change is a purchase decision and belongs to the customer.
      </p>
    </div>
  );
}

async function ActivityTab({ tenantId }: { tenantId: string }) {
  const insights = await insightsOnce(tenantId);
  if (!insights.ok) {
    return <ReadFailed what="Platform activity" error={insights.error} />;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Read back from this customer&rsquo;s own audit log — the same rows they can see.
        There is no private platform copy.
      </p>
      <TenantActivityTable
        rows={insights.data.activity.map((r) => ({
          id: r.id,
          actorEmail: r.actorEmail,
          action: r.action,
          resourceType: r.resourceType,
          reason: r.reason,
          severity: r.severity,
          impersonationId: r.impersonationId,
          createdAt: r.createdAt,
        }))}
      />
    </div>
  );
}

/**
 * ⭐ ACCESS IS "WHO CAN GET IN, AND UNDER WHAT NAME".
 *
 * ⚠️ THE TWO IRREVERSIBLE ACTS LIVE HERE, TOGETHER AND AT THE BOTTOM,
 * away from the action bar. That bar holds suspend, reactivate and
 * impersonate — reversible things done while a customer is on the phone.
 * A rename burns a public hostname for 365 days and a termination ends
 * the relationship; neither should sit one mis-click from "reactivate".
 */
function AccessTab({
  tenant,
  isConsoleHost,
  canRename,
  canTerminate,
}: {
  tenant: TenantDetail;
  isConsoleHost: boolean;
  canRename: boolean;
  canTerminate: boolean;
}) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="consent-heading">
        <h2 id="consent-heading" className="text-sm font-medium">
          Consent on file
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Granted by the customer, in their own session. The platform can read these rows
          and the database refuses to let it write one — consent we could write ourselves
          would not be consent.
        </p>
        <Suspense fallback={<PanelSkeleton label="consent" />}>
          <ConsentTab tenantId={tenant.id} />
        </Suspense>
      </section>

      <section aria-labelledby="sessions-heading">
        <h2 id="sessions-heading" className="text-sm font-medium">
          Who has been inside this workspace
        </h2>
        {tenant.recentImpersonations.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nobody from the platform has ever entered this workspace.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {tenant.recentImpersonations.map((s) => (
              <li key={s.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{s.actorEmail}</span>
                  <Badge variant={s.mode === "break_glass" ? "destructive" : "outline"}>
                    {MODE_LABELS[s.mode as ImpersonationMode] ?? s.mode}
                  </Badge>
                  <Badge variant="secondary">
                    {SCOPE_LABELS[s.scope as ImpersonationScope] ?? s.scope}
                  </Badge>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {s.startedAt.slice(0, 16).replace("T", " ")} →{" "}
                    {(s.endedAt ?? s.expiresAt).slice(11, 16)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{s.justification}</p>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <SessionHistoryLink tenantId={tenant.id} isConsoleHost={isConsoleHost} />
        </div>
      </section>

      <section aria-labelledby="failed-access-heading">
        <h2 id="failed-access-heading" className="text-sm font-medium">
          Who tried and did not get in
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Sign-in failures and other access events from the last 30 days. Metadata only —
          the IP is a prefix and the detail blob is never fetched.
        </p>
        <Suspense fallback={<PanelSkeleton label="security events" />}>
          <SecurityTab tenantId={tenant.id} />
        </Suspense>
      </section>

      {/*
        ⭐ "WHY IS OUR ADDRESS NOT OUR COMPANY NAME?"

        Shown ONLY when this workspace is not on the address its Clerk
        organisation asked for — which happens when 0091 refused the
        requested one and the webhook granted a different one rather than
        failing the signup. That is the right trade (a different address
        beats no workspace), but it is invisible to everyone afterwards,
        and support is the one who gets asked about it.

        ⚠️ It sits immediately above the rename card on purpose: the
        operator reading this is usually one click from deciding whether
        to move the workspace onto a better name, and the reason it is
        not already on one is the first thing they need.
      */}
      {tenant.slugOrigin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              This address is not the one Clerk asked for
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              The Clerk organisation asked for{" "}
              <code className="rounded bg-muted px-1">{tenant.slugOrigin.requested}</code>{" "}
              and was granted{" "}
              <code className="rounded bg-muted px-1">{tenant.slugOrigin.granted}</code>.
            </p>
            <p className="text-xs text-muted-foreground">
              {rejection(tenant.slugOrigin.reason).operatorMessage}
            </p>
          </CardContent>
        </Card>
      )}

      {/*
        ⚠️ THE ADDRESS. On its own card and below the reading material,
        because a rename changes a public hostname and burns the old one
        for 365 days. `canRename` is a courtesy — the capability is
        re-checked inside `renameTenantSlug()`.
      */}
      <RenameSlugCard
        tenantId={tenant.id}
        currentSlug={tenant.slug}
        canRename={canRename}
        onRename={renameTenantSlugAction}
      />

      <section aria-labelledby="offboarding-heading">
        <h2 id="offboarding-heading" className="text-sm font-medium">
          Ending the relationship
        </h2>
        <div className="mt-2">
          <OffboardingPanel
            tenantId={tenant.id}
            tenantSlug={tenant.slug}
            tenantName={tenant.name}
            status={tenant.status}
            /*
              ⚠️ `tenants:suspend`, because no `tenants:terminate`
              capability exists — see the comment on
              `scheduleTenantTermination`. It is the strictest gate
              available: owner grade, and on the step-up list.
            */
            canTerminate={canTerminate}
            offboarding={tenant.offboarding}
            onRequest={requestTerminationAction}
            onCancel={cancelTerminationAction}
            onExport={exportOffboardingSnapshotAction}
          />
        </div>
      </section>
    </div>
  );
}

async function ConsentTab({ tenantId }: { tenantId: string }) {
  const insights = await insightsOnce(tenantId);
  if (!insights.ok) return <ReadFailed what="Consent" error={insights.error} />;
  return <ConsentPanel consents={insights.data.consents} />;
}

async function SecurityTab({ tenantId }: { tenantId: string }) {
  const insights = await insightsOnce(tenantId);
  if (!insights.ok) return <ReadFailed what="Security events" error={insights.error} />;
  return <SecurityPanel events={insights.data.securityEvents} />;
}

/* ------------------------------------------------------------------ */
/* SHARED                                                              */
/* ------------------------------------------------------------------ */

/**
 * 🔴 A FAILED READ MUST NOT LOOK LIKE AN EMPTY ONE. The word "could not
 * be read" is the whole point — an operator who mistakes this for "there
 * is nothing here" tells a customer the wrong thing with confidence.
 */
function ReadFailed({ what, error }: { what: string; error: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      {what} could not be read — this is a failure, not an empty result. {error}
    </p>
  );
}

/** Which layer of the configuration chain a value came from, in words. */
const LAYER_WORDS: Readonly<Record<"global" | "plan" | "tenant", string>> = {
  global: "the global default",
  plan: "this plan's version",
  tenant: "written for this workspace",
};

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
