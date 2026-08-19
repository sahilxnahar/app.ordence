"use client";

/**
 * Ordence — User Actions (Platform Console)
 * Version: v0.80.0-alpha
 *
 * Inline controls for changing a user's role and status within a
 * workspace. Each action calls the server action and refreshes the page.
 *
 * ⚠️ The role and status changes are per-membership (per user-per-tenant),
 * not global. A person who is an admin in one workspace and a member in
 * another keeps each role independently.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
/*
 * ⚠️ IMPORTED FROM `actions`, NOT FROM `users` — v0.83.1.
 *
 * This is a `"use client"` file. `@/server/platform/users` begins with
 * `import "server-only"` and reaches `guard.ts`, so importing it here
 * failed the production build:
 *
 *     x You're importing a component that needs "server-only".
 *     > Build failed because of webpack errors
 *
 * `updateUserStatusAction` / `updateUserRoleAction` are the `"use server"`
 * wrappers over the same two functions. They are the supported way for a
 * browser to reach them, and they keep the authorisation check where it
 * belongs — inside the server-only implementation.
 */
import {
  updateUserStatusAction,
  updateUserRoleAction,
} from "@/server/platform/actions";
import { Button } from "@/components/ui/button";

const ROLES = [
  { value: "tenant_owner", label: "Owner" },
  { value: "tenant_admin", label: "Admin" },
  { value: "security_admin", label: "Security" },
  { value: "billing_admin", label: "Billing" },
  { value: "manager", label: "Manager" },
  { value: "member", label: "Member" },
  { value: "read_only", label: "Read Only" },
  { value: "guest", label: "Guest" },
];

export function UserActions({
  userId,
  tenantId,
  currentRole,
  currentStatus,
}: {
  userId: string;
  tenantId: string;
  currentRole: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showRolePicker, setShowRolePicker] = useState(false);

  function changeStatus(status: string) {
    setError(null);
    start(async () => {
      const res = await updateUserStatusAction({ userId, tenantId, status });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function changeRole(role: string) {
    setError(null);
    setShowRolePicker(false);
    start(async () => {
      const res = await updateUserRoleAction({ userId, tenantId, role });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {currentStatus !== "active" && (
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => changeStatus("active")}
          >
            Activate
          </Button>
        )}
        {currentStatus === "active" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => changeStatus("suspended")}
          >
            Suspend
          </Button>
        )}
        {currentStatus !== "offboarded" && (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => changeStatus("offboarded")}
          >
            Offboard
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setShowRolePicker((v) => !v)}
        >
          Change role
        </Button>
      </div>

      {showRolePicker && (
        <div className="flex flex-wrap gap-1.5 rounded-md border border-border bg-muted/30 p-2">
          {ROLES.map((r) => (
            <button
              key={r.value}
              type="button"
              disabled={pending || r.value === currentRole}
              onClick={() => changeRole(r.value)}
              className={`rounded px-2 py-1 text-xs ${
                r.value === currentRole
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
