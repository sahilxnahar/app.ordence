/**
 * Ordence — Settings · Financial
 * Version: v0.7.0-alpha
 */

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import { getWorkspaceSettings } from "@/server/actions/settings";
import { FinancialSettingsForm } from "./financial-form";

export const dynamic = "force-dynamic";

export default async function FinancialSettingsPage() {
  const ctx = await requirePageContext();
  const result = await getWorkspaceSettings();

  if (!result.ok) {
    return <p className="text-sm text-destructive">{result.error}</p>;
  }

  const s = result.data.settings;

  return (
    <FinancialSettingsForm
      canEdit={can(
        { role: ctx.role, overrides: ctx.user.permissionOverrides },
        "settings:update",
      )}
      defaults={{
        currency: (s.currency as string) ?? "INR",
        country: (s.country as string) ?? "IN",
        fiscalYearStartMonth: String(s.fiscalYearStartMonth ?? 4),
        requireMfa: s.requireMfa === true,
        sessionIdleMinutes: String(s.sessionIdleMinutes ?? 60),
      }}
    />
  );
}
