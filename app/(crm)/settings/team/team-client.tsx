"use client";

/**
 * Ordence — Team & Role Assignment
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN CAN AND CANNOT ENFORCE
 * ══════════════════════════════════════════════════════════════════════
 * The dropdown below only offers roles at or beneath the current user's own
 * level, and it is disabled on their own row. Both are courtesies: they stop
 * an honest person making a mistake and make the rules visible.
 *
 * NEITHER IS A SECURITY CONTROL. Anyone with dev-tools can re-enable a
 * disabled <select> and post any value they like. The actual enforcement is
 * in `updateUserRole`, which re-derives the actor from the session and
 * refuses self-modification, upward grants and last-owner demotion —
 * regardless of what the browser sends.
 *
 * The rule of thumb this codebase follows: the UI explains the rule, the
 * server enforces it, the audit log remembers it.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { updateUserRole, updateUserStatus, type TeamMember } from "@/server/actions/team";
import {
  ASSIGNABLE_ROLES,
  ROLE_RANK,
  roleLabel,
  type AssignableRole,
} from "@/lib/validators/team";

function displayName(member: TeamMember): string {
  const full = [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
  return full || member.email;
}

export function TeamClient({
  members,
  currentUserId,
  currentUserRole,
  canManageRoles,
  canManageUsers,
}: {
  members: TeamMember[];
  currentUserId: string;
  currentUserRole: string;
  canManageRoles: boolean;
  canManageUsers: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const actorRank = ROLE_RANK[currentUserRole] ?? 0;

  // Only roles at or beneath the actor's own level are offered. The server
  // checks this again; this is here so the impossible option is not visible.
  const assignableForActor = ASSIGNABLE_ROLES.filter(
    (r) => (ROLE_RANK[r] ?? 0) <= actorRank,
  );

  const activeOwners = members.filter(
    (m) => m.role === "tenant_owner" && m.status !== "suspended",
  ).length;

  function handleRoleChange(member: TeamMember, nextRole: string) {
    if (nextRole === member.role) return;

    setBusyId(member.id);
    void (async () => {
      try {
        const result = await updateUserRole({
          userId: member.id,
          role: nextRole as AssignableRole,
        });

        if (result.ok) {
          toast.success(
            `${displayName(member)} is now ${roleLabel(nextRole)}.`,
          );
          router.refresh();
        } else {
          toast.error(result.error);
          // Re-sync the <select> back to the value the server still holds.
          router.refresh();
        }
      } catch (err) {
        console.error("[role change]", err);
        toast.error("Could not reach the server. Please try again.");
      } finally {
        setBusyId(null);
      }
    })();
  }

  function handleStatusToggle(member: TeamMember) {
    const next = member.status === "suspended" ? "active" : "suspended";
    setBusyId(member.id);

    void (async () => {
      try {
        const result = await updateUserStatus({ userId: member.id, status: next });
        if (result.ok) {
          toast.success(
            next === "suspended"
              ? `${displayName(member)} has been suspended.`
              : `${displayName(member)} has been reinstated.`,
          );
          router.refresh();
        } else {
          toast.error(result.error);
        }
      } catch (err) {
        console.error("[status change]", err);
        toast.error("Could not reach the server. Please try again.");
      } finally {
        setBusyId(null);
      }
    })();
  }

  if (members.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Nobody else is in this workspace yet. Invite people from your Clerk
        organisation and they will appear here on first sign-in.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border rounded-md border border-border">
        {members.map((member) => {
          const isSelf = member.id === currentUserId;
          const targetRank = ROLE_RANK[member.role] ?? 0;
          const outranksActor = targetRank > actorRank;
          const isLastOwner = member.role === "tenant_owner" && activeOwners <= 1;
          const isBusy = busyId === member.id;

          const roleLocked =
            !canManageRoles || isSelf || outranksActor || isBusy;

          const reason = isSelf
            ? "You cannot change your own role."
            : outranksActor
              ? "This person is more senior than you."
              : isLastOwner
                ? "The only owner cannot be demoted."
                : !canManageRoles
                  ? "You do not have permission to assign roles."
                  : null;

          return (
            <li
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate font-medium">
                  {displayName(member)}
                  {isSelf && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                      you
                    </span>
                  )}
                  {member.status === "suspended" && (
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-normal text-destructive">
                      suspended
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {member.email}
                  {member.jobTitle ? ` · ${member.jobTitle}` : ""}
                  {" · "}
                  {member.permissionCount} permissions
                </p>
                {reason && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{reason}</p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {isBusy && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
                )}

                <label className="sr-only" htmlFor={`role-${member.id}`}>
                  Role for {displayName(member)}
                </label>
                <Select
                  id={`role-${member.id}`}
                  value={member.role}
                  disabled={roleLocked || isLastOwner}
                  onChange={(e) => handleRoleChange(member, e.target.value)}
                  className="w-44"
                >
                  {/* A role the actor cannot assign still has to appear, or
                      the current value would render as blank. */}
                  {!assignableForActor.includes(
                    member.role as AssignableRole,
                  ) && (
                    <option value={member.role}>
                      {roleLabel(member.role)}
                    </option>
                  )}
                  {assignableForActor.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </Select>

                {canManageUsers && !isSelf && !outranksActor && (
                  <Button
                    variant={member.status === "suspended" ? "outline" : "ghost"}
                    size="sm"
                    disabled={isBusy || (isLastOwner && member.status !== "suspended")}
                    onClick={() => handleStatusToggle(member)}
                  >
                    {member.status === "suspended" ? (
                      <>
                        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                        Reinstate
                      </>
                    ) : (
                      <>
                        <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                        Suspend
                      </>
                    )}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        Role changes take effect immediately and are written to the audit log at
        raised severity, recording who changed what and what the previous value
        was. Separation of duties is deliberate: an Accountant can post entries
        but cannot close a period.
      </p>
    </div>
  );
}
