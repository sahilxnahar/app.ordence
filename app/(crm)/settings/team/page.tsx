/**
 * Ordence — Settings · Team
 * Version: v0.7.0-alpha
 */

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import { getTeamMembers } from "@/server/actions/team";
import { TeamClient } from "./team-client";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const ctx = await requirePageContext();
  const result = await getTeamMembers();

  if (!result.ok) {
    return <p className="text-sm text-destructive">{result.error}</p>;
  }

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">People</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {result.data.length} {result.data.length === 1 ? "person" : "people"} in this
          workspace.
        </p>
      </div>

      <TeamClient
        members={result.data}
        currentUserId={ctx.user.id}
        currentUserRole={ctx.role}
        canManageRoles={can(subject, "roles:manage")}
        canManageUsers={can(subject, "users:update")}
      />
    </div>
  );
}
