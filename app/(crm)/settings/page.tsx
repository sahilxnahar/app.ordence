/**
 * Ordence — Settings · General
 * Version: v0.7.0-alpha
 */

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import { getWorkspaceSettings } from "@/server/actions/settings";
import { getIndustryOptions } from "@/lib/industry-templates";
import { GeneralSettingsForm } from "./general-form";

export const dynamic = "force-dynamic";

export default async function GeneralSettingsPage() {
  const ctx = await requirePageContext();
  const result = await getWorkspaceSettings();

  if (!result.ok) {
    return <p className="text-sm text-destructive">{result.error}</p>;
  }

  const workspace = result.data;
  const s = workspace.settings;

  // `can()` rather than `checkPermission()` — the latter writes an audit
  // denial, and rendering a disabled form is not an access attempt.
  const canEdit = can(
    { role: ctx.role, overrides: ctx.user.permissionOverrides },
    "settings:update",
  );

  return (
    <div className="space-y-6">
      <GeneralSettingsForm
        canEdit={canEdit}
        industryChoices={getIndustryOptions().map((o) => ({
          value: o.value,
          label: o.label,
        }))}
        defaults={{
          name: workspace.name,
          industry: (s.industry as string) ?? "generic",
          timezone: (s.timezone as string) ?? "Asia/Kolkata",
          locale: (s.locale as string) ?? "en-IN",
          dateFormat: (s.dateFormat as string) ?? "dd/MM/yyyy",
        }}
      />

      <dl className="grid gap-3 rounded-md border border-border p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Workspace address</dt>
          <dd className="font-mono text-xs">{workspace.slug}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Plan</dt>
          <dd>{workspace.planTier}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Seats</dt>
          <dd>{workspace.seatLimit}</dd>
        </div>
      </dl>
    </div>
  );
}
