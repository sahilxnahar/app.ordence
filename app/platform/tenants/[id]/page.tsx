/**
 * Ordence — Platform Console · Workspace Detail
 * Version: v0.29.0-alpha (Phase 29)
 *
 * ⚠️ REACHING THIS PAGE IS AN AUDITED EVENT — TWICE. `getTenantDetail()`
 * writes a row into the CUSTOMER'S own audit log saying the workspace was
 * opened, and `getTenantInsights()` writes a second one saying their
 * usage, invoices and security events were read. Two rows because they
 * are two different accesses: "I looked at their plan" and "I read their
 * payment history and their sign-in failures" are not the same sentence,
 * and a customer reviewing the trail is entitled to both.
 *
 * That is also why the directory listing writes nothing: if every glance
 * at a dashboard wrote a row, the rows that matter would be buried.
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

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTenantDetail } from "@/server/platform/tenants";
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
import { TenantActions } from "@/components/platform/tenant-actions";
import { RenameSlugCard } from "@/components/platform/rename-slug-card";
import { FlagEditor } from "@/components/platform/flag-editor";
import { OffboardingPanel } from "@/components/platform/offboarding-panel";
import {
  UsagePanel,
  InvoicePanel,
  SecurityPanel,
  PeoplePanel,
  ConsentPanel,
  ActivityPanel,
  SessionHistoryLink,
} from "@/components/platform/tenant-panels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { HEALTH_LABELS, healthBadgeVariant, formatStorage } from "@/lib/platform/health";
import { MODE_LABELS, SCOPE_LABELS } from "@/lib/platform/impersonation-policy";
import { formatMoney } from "@/lib/billing/money";
import type { ImpersonationMode, ImpersonationScope } from "@/db/schema/platform";

export const dynamic = "force-dynamic";

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

async function TenantDetailBody({ tenantId }: { tenantId: string }) {
  const operator = await getPlatformOperator();
  if (!operator) notFound();

  const result = await getTenantDetail(tenantId);
  if (!result.ok) notFound();

  const tenant = result.data;
  const [flagsResult, consent, insightsResult] = await Promise.all([
    listTenantFlags(tenantId),
    hasLiveConsent(tenantId),
    getTenantInsights(tenantId),
  ]);

  const insights = insightsResult.ok ? insightsResult.data : null;
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
          href={`/platform/tenants/${tenant.id}/configure`}
          className="text-sm underline"
        >
          Configure modules, plan and industry
        </Link>

        <div className="ml-auto">
          <TenantActions
            tenantId={tenant.id}
            tenantSlug={tenant.slug}
            tenantName={tenant.name}
            status={tenant.status}
            hasConsent={consent}
            canSuspend={can("tenants:suspend")}
            canImpersonate={can("impersonate:consented")}
            canBreakGlass={can("impersonate:breakglass")}
            onSuspend={suspendTenantAction}
            onReactivate={reactivateTenantAction}
            onImpersonate={startImpersonationAction}
            subjectUsers={(insights?.users ?? [])
              .filter((u) => u.status === "active" && !u.isPlatformStaff)
              .map((u) => ({ id: u.id, email: u.email, role: u.role }))}
          />
        </div>
      </div>

      {/*
        ⭐ THE ADDRESS — v1.57.0-alpha.

        ⚠️ ON ITS OWN CARD RATHER THAN IN THE ACTION BAR, AND THAT IS A
        DELIBERATE PIECE OF FRICTION. The bar holds suspend, reactivate
        and impersonate: reversible things an operator does while a
        customer is on the phone. A rename changes a public hostname and
        burns the old one for 365 days, and it should not sit one
        mis-click away from "reactivate".

        `canRename` is a courtesy, not a control — the capability is
        re-checked inside `renameTenantSlug()`, one hop from the
        `"use server"` export, because that export is a public HTTP
        endpoint reachable from any page.
      */}
      <RenameSlugCard
        tenantId={tenant.id}
        currentSlug={tenant.slug}
        canRename={can("tenants:provision")}
        onRename={renameTenantSlugAction}
      />

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

      {insights && insights.degraded.length > 0 ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          Some panels could not be read ({insights.degraded.join(", ")}). Empty is not the
          same as nothing happened — treat those tabs as unknown, not as clear.
        </p>
      ) : null}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="flags">Feature flags</TabsTrigger>
          <TabsTrigger value="access">Support access</TabsTrigger>
          <TabsTrigger value="activity">Platform activity</TabsTrigger>
          {/*
            ⭐ ITS OWN TAB, LAST. Offboarding is the one thing on this
            page that ends a customer relationship, and putting it beside
            "Suspend" in the action bar would put the irreversible thing
            one pixel from the reversible one.
          */}
          <TabsTrigger value="offboarding">Offboarding</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <dl className="grid gap-4 rounded-md border border-border p-4 text-sm sm:grid-cols-3">
            <Fact label="Plan" value={tenant.planTier} />
            <Fact label="Subscription" value={tenant.subscriptionStatus ?? "none"} />
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
            <Fact
              label="Renews"
              value={tenant.currentPeriodEnd?.slice(0, 10) ?? "—"}
            />
            <Fact
              label="Last activity"
              value={tenant.lastActivityAt?.slice(0, 10) ?? "never"}
            />
          </dl>

          <ul className="mt-4 space-y-1 text-sm">
            {tenant.health.signals.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <Badge variant={s.severity === "risk" ? "destructive" : "outline"}>
                  {s.severity}
                </Badge>
                {s.label}
              </li>
            ))}
          </ul>
        </TabsContent>

        <TabsContent value="usage">
          {insights ? (
            <UsagePanel usage={insights.usage} levels={insights.levels} />
          ) : (
            <p className="text-sm text-destructive">Usage could not be read.</p>
          )}
        </TabsContent>

        <TabsContent value="billing">
          <div className="space-y-4">
            {tenant.subscription ? (
              <dl className="grid gap-4 rounded-md border border-border p-4 text-sm sm:grid-cols-3">
                <Fact label="Status" value={tenant.subscription.status} />
                <Fact label="Billed" value={tenant.subscription.interval} />
                <Fact label="Provider" value={tenant.subscription.provider} />
                <Fact
                  label="Seats purchased"
                  value={String(tenant.subscription.seatsPurchased)}
                />
                <Fact
                  label="Base amount"
                  value={formatMoney(
                    BigInt(tenant.subscription.unitAmountMinor),
                    tenant.subscription.currency,
                  )}
                />
                <Fact
                  label="Per seat"
                  value={formatMoney(
                    BigInt(tenant.subscription.perSeatAmountMinor),
                    tenant.subscription.currency,
                  )}
                />
                <Fact
                  label="Current period"
                  value={`${tenant.subscription.currentPeriodStart?.slice(0, 10) ?? "—"} → ${
                    tenant.subscription.currentPeriodEnd?.slice(0, 10) ?? "—"
                  }`}
                />
                <Fact
                  label="Cancels at period end"
                  value={tenant.subscription.cancelAtPeriodEnd ? "yes" : "no"}
                />
                <Fact
                  label="Cancelled"
                  value={tenant.subscription.cancelledAt?.slice(0, 10) ?? "—"}
                />
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                No subscription record. This workspace is not being billed.
              </p>
            )}

            {insights ? (
              <InvoicePanel invoices={insights.invoices} />
            ) : (
              <p className="text-sm text-destructive">Invoices could not be read.</p>
            )}

            <p className="text-xs text-muted-foreground">
              The console can read billing and cannot change it: the platform clause is on
              the read policy of <code className="font-mono">subscriptions</code> and{" "}
              <code className="font-mono">invoices</code> and on neither write policy. A
              plan change is a purchase decision and belongs to the customer.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="people">
          {insights ? (
            <PeoplePanel users={insights.users} />
          ) : (
            <p className="text-sm text-destructive">The workspace people could not be read.</p>
          )}
        </TabsContent>

        <TabsContent value="security">
          {insights ? (
            <SecurityPanel events={insights.securityEvents} />
          ) : (
            <p className="text-sm text-destructive">Security events could not be read.</p>
          )}
        </TabsContent>

        <TabsContent value="flags">
          {flagsResult.ok ? (
            <FlagEditor
              tenantId={tenant.id}
              flags={flagsResult.data}
              canWrite={can("flags:write")}
              onSet={setTenantFlagAction}
            />
          ) : (
            <p className="text-sm text-destructive">{flagsResult.error}</p>
          )}
        </TabsContent>

        <TabsContent value="access">
          <div className="space-y-6">
            <section aria-labelledby="consent-heading">
              <h2 id="consent-heading" className="text-sm font-medium">
                Consent on file
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Granted by the customer, in their own session. The platform can read these
                rows and the database refuses to let it write one — consent we could write
                ourselves would not be consent.
              </p>
              {insights ? (
                <ConsentPanel consents={insights.consents} />
              ) : (
                <p className="text-sm text-destructive">Consent could not be read.</p>
              )}
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
                <SessionHistoryLink tenantId={tenant.id} />
              </div>
            </section>
          </div>
        </TabsContent>

        <TabsContent value="activity">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Read back from this customer&rsquo;s own audit log — the same rows they can
              see. There is no private platform copy.
            </p>
            {insights ? (
              <ActivityPanel rows={insights.activity} />
            ) : (
              <p className="text-sm text-destructive">Activity could not be read.</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="offboarding">
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
            canTerminate={can("tenants:suspend")}
            offboarding={tenant.offboarding}
            onRequest={requestTerminationAction}
            onCancel={cancelTerminationAction}
            onExport={exportOffboardingSnapshotAction}
          />
        </TabsContent>
      </Tabs>
    </div>
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
