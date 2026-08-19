/**
 * Ordence — ⭐⭐ SUPPORT ACCESS
 * Version: v1.40.0-alpha (Mega-wave 2, Batch 41)
 * Runtime: Node
 *
 * 🔴 Before this page existed, `grantSupportConsent` had zero callers, so
 * a customer could not grant support access by any means. Which meant
 * every support visit had to use break-glass, the emergency path, and
 * the emergency path stopped meaning anything.
 */

import {
  grantSupportAccess,
  revokeSupportAccess,
  listSupportAccess,
} from "@/server/actions/support-access";
import { requireTenantContext } from "@/server/tenant-context";
import { SupportAccessPanel } from "@/components/settings/support-access-panel";
import {
  STANDING_CONSENT_DAYS,
  INCIDENT_CONSENT_MINUTES,
} from "@/lib/platform/impersonation-policy";

export const dynamic = "force-dynamic";

export const metadata = { title: "Support access · Ordence" };

export default async function SupportAccessPage() {
  const [ctx, result] = await Promise.all([
    requireTenantContext(),
    listSupportAccess(),
  ]);

  return (
    <main className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Support access</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Ordence support cannot open your workspace unless you let them. When
          you do, it is for a fixed time, it ends by itself, and every visit is
          recorded below whether you are watching or not.
        </p>
      </div>

      {result.ok ? (
        <SupportAccessPanel
          consents={result.data}
          grantAction={grantSupportAccess}
          revokeAction={revokeSupportAccess}
          standingDays={STANDING_CONSENT_DAYS}
          incidentMinutes={INCIDENT_CONSENT_MINUTES}
          isOwner={ctx.role === "tenant_owner"}
        />
      ) : (
        <p className="text-sm text-destructive">{result.error}</p>
      )}
    </main>
  );
}
