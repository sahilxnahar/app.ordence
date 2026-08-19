/**
 * Ordence — Settings · Team
 * Version: v0.7.0-alpha
 */

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
/**
 * ⭐⭐⭐ 0114 — THE APPROVAL QUEUE.
 *
 * 🔴 Until this, a workspace on ten seats could have thirty people: there
 * is no in-product invite, everybody arrives through Clerk, and that path
 * admitted them over the limit and wrote an audit row nobody read.
 */
import {
  getTeamMembers,
  getPendingSeats,
  approveSeatRequest,
  declineSeatRequest,
  getRolePermissionMatrix,
} from "@/server/actions/team";
import { RoleMatrix } from "@/components/team/role-matrix";
import { PendingSeats } from "@/components/team/pending-seats";
import { TeamClient } from "./team-client";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const ctx = await requirePageContext();
  /**
   * ⭐ WAVE 9 — the matrix is fetched here and rendered only if the
   * caller is allowed it. `getRolePermissionMatrix` requires
   * `roles:read`, so a member who does not hold it gets `ok: false` and
   * the section simply is not there. No branch in this page decides who
   * may see it; the action does, which is the only place that decision
   * cannot be forgotten.
   */
  const [result, pending, roleMatrix] = await Promise.all([
    getTeamMembers(),
    getPendingSeats(),
    getRolePermissionMatrix(),
  ]);

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

      {pending.ok && (
        <PendingSeats
          rows={pending.data.rows}
          seatsAvailable={pending.data.seatsAvailable}
          canManage={can(subject, "users:invite")}
          approveAction={approveSeatRequest}
          declineAction={declineSeatRequest}
        />
      )}

      {roleMatrix.ok && <RoleMatrix rows={roleMatrix.data} />}

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
