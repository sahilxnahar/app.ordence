/**
 * Ordence — Platform Console · Configure a Workspace
 * Version: v0.53.0 · Sections C, D and E
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SCREEN THAT REPLACES A DEPLOY
 * ══════════════════════════════════════════════════════════════════════
 * Before this page, turning a feature on for one customer meant editing a
 * file and shipping it. Everything here writes rows instead — rows with a
 * named author, a written reason, an expiry, and an entry in the
 * CUSTOMER'S own audit log.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS A SIBLING ROUTE AND NOT ANOTHER TAB ON THE DETAIL PAGE
 * ══════════════════════════════════════════════════════════════════════
 * `/platform/tenants/[id]` is a READING page: plan, usage, invoices,
 * security events, who has been inside. It is the page somebody opens
 * with a customer on the phone, and its eight tabs are already at the
 * limit of what a person scans.
 *
 * This one WRITES, and everything on it changes what the customer sees
 * tomorrow. Keeping the two apart means the URL in a ticket says which
 * one somebody was on, the audit resource types do not blur together,
 * and — the practical reason — an operator cannot land on a
 * configuration control while looking for an invoice.
 *
 * ⚠️ GUARDED THREE TIMES, AND ALL THREE ARE LOAD-BEARING. The layout
 * refuses non-staff, `getWorkspaceConfiguration()` re-checks
 * `tenants:read`, and every server action re-checks its own capability —
 * because a server action is a public endpoint whether or not this page
 * ever renders a button for it.
 */

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlatformOperator } from "@/server/platform/guard";
import {
  getWorkspaceConfiguration,
  getConfigChain,
  listConfigVersions,
} from "@/server/platform/configuration";
import {
  setModuleEntitlementAction,
  setPlanAndLimitsAction,
  setTenantIndustryAction,
} from "@/server/platform/config-actions";
import {
  recordStepUpAction,
  previewConfigOverrideAction,
  setConfigOverrideAction,
} from "@/server/platform/actions";
import { previewEntitlementChange } from "@/server/platform/control-actions";
import { ModuleSwitchboard } from "@/components/platform/module-switchboard";
import { PlanLimitsEditor } from "@/components/platform/plan-limits-editor";
import { IndustryPicker } from "@/components/platform/industry-picker";
import { ConfigChainPanel } from "@/components/platform/config-chain-panel";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Configure workspace · Ordence Platform",
  robots: { index: false, follow: false },
};

export default async function ConfigureTenantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-md bg-muted" />}>
      <ConfigureBody tenantId={id} />
    </Suspense>
  );
}

async function ConfigureBody({ tenantId }: { tenantId: string }) {
  const operator = await getPlatformOperator();
  if (!operator) notFound();

  const result = await getWorkspaceConfiguration(tenantId);
  // ⚠️ `notFound()` rather than an error message. A workspace id that does
  // not resolve should not tell the caller whether it exists and was
  // refused, or never existed.
  if (!result.ok) notFound();

  const config = result.data;
  const can = (c: string) => operator.capabilities.includes(c as never);
  const canOverride = can("entitlements:override");
  const canConfigure = can("tenants:configure");

  // ⚠️ Both are already-guarded reads (`tenants:read`), and the history
  // one fails SOFT: it returns `readable: false` rather than throwing,
  // so an unreadable audit log costs this page a panel rather than the
  // whole screen. The panel says "unknown", not "empty".
  const [chainResult, versionsResult] = await Promise.all([
    getConfigChain(config.tenantId),
    listConfigVersions(config.tenantId),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <nav className="text-sm text-muted-foreground">
            <Link href="/platform" className="hover:underline">
              Platform
            </Link>
            <span className="px-2">/</span>
            <Link href={`/platform/tenants/${config.tenantId}`} className="hover:underline">
              {config.name}
            </Link>
            <span className="px-2">/</span>
            <span>Configure</span>
          </nav>
          <h1 className="text-lg font-semibold">Configure {config.name}</h1>
          <p className="font-mono text-xs text-muted-foreground">{config.slug}</p>
        </div>
        <Badge variant="outline">{config.planTier}</Badge>
        <Badge variant="outline">{config.industryLabel}</Badge>
        {config.status === "suspended" ? (
          <Badge variant="destructive">suspended</Badge>
        ) : null}
      </div>

      <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
        Every change on this page is written to{" "}
        <strong>{config.name}&rsquo;s own audit log</strong> with your name and your
        reason. Nothing here deletes a customer&rsquo;s records — the worst it can do is
        take a screen away, and they keep everything they put in it.
      </p>

      <Tabs defaultValue="modules">
        <TabsList>
          <TabsTrigger value="modules">Modules</TabsTrigger>
          <TabsTrigger value="plan">Plan &amp; limits</TabsTrigger>
          <TabsTrigger value="industry">Industry</TabsTrigger>
          <TabsTrigger value="chain">Configuration</TabsTrigger>
        </TabsList>

        <TabsContent value="modules">
          <ModuleSwitchboard
            tenantId={config.tenantId}
            matrix={config.matrix}
            canWrite={canOverride}
            onSet={setModuleEntitlementAction}
            onStepUp={recordStepUpAction}
            /*
              ⭐⭐⭐ THE GAP THIS SESSION CLOSED. Until now this screen
              would happily turn a paying customer's module off and say
              nothing at all about what happens to the eighteen hundred
              records inside it. The operator's hesitation on that call is
              the whole reason the preview exists.
            */
            onPreview={previewEntitlementChange}
          />
        </TabsContent>

        <TabsContent value="plan">
          <PlanLimitsEditor
            tenantId={config.tenantId}
            planTier={config.planTier}
            seats={config.seats}
            storage={config.storage}
            subscriptionStatus={config.subscriptionStatus}
            subscriptionIsAuthority={config.subscriptionIsAuthority}
            subscriptionGrantsAccess={config.subscriptionGrantsAccess}
            canWrite={canConfigure}
            onSave={setPlanAndLimitsAction}
            onStepUp={recordStepUpAction}
          />
        </TabsContent>

        <TabsContent value="industry">
          <IndustryPicker
            tenantId={config.tenantId}
            slug={config.slug}
            current={config.industry}
            currentLabel={config.industryLabel}
            wasUnrecognised={config.industryWasUnrecognised}
            navAllowed={config.navAllowed}
            canWrite={canConfigure}
            onApply={setTenantIndustryAction}
            onStepUp={recordStepUpAction}
          />
        </TabsContent>

        <TabsContent value="chain">
          {chainResult.ok ? (
            <ConfigChainPanel
              tenantId={config.tenantId}
              tenantName={config.name}
              planTier={chainResult.data.planTier}
              storageColumnMb={chainResult.data.storageColumnMb}
              storageColumnDisagrees={chainResult.data.storageColumnDisagrees}
              rows={chainResult.data.resolutions.map((r) => ({
                key: r.key,
                label: r.definition.label,
                description: r.definition.description,
                type: r.definition.type,
                consumers: r.definition.consumers,
                layers: r.layers.map((l) => ({
                  layer: l.layer,
                  label: l.label,
                  present: l.present,
                  value: l.value,
                  formatted: l.formatted,
                  reason: l.reason ?? null,
                  setByEmail: l.setByEmail ?? null,
                  setAt: l.setAt ?? null,
                })),
                effective: r.effective,
                effectiveFormatted: r.effectiveFormatted,
                effectiveLayer: r.effectiveLayer,
                invalidOverride: r.invalidOverride,
              }))}
              versions={versionsResult.ok ? versionsResult.data.versions : []}
              versionsReadable={versionsResult.ok ? versionsResult.data.readable : false}
              canWrite={canConfigure}
              onPreview={previewConfigOverrideAction}
              onSave={setConfigOverrideAction}
              onStepUp={recordStepUpAction}
            />
          ) : (
            <p className="text-sm text-destructive">{chainResult.error}</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
