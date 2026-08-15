"use server";

/**
 * Ordence — Team & Role Administration
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE THREE RULES THAT MAKE ROLE ASSIGNMENT SAFE
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. NOBODY MAY GRANT A ROLE THEY DO NOT THEMSELVES HOLD.
 *    Without this, a `tenant_admin` could promote a colleague — or
 *    themselves — to `platform_super_admin` and step outside the tenant
 *    entirely. Privilege escalation is rarely a dramatic exploit; usually
 *    it is a missing comparison exactly like this one.
 *
 * 2. NOBODY MAY CHANGE THEIR OWN ROLE.
 *    Not even an owner. An owner who demotes themselves by accident locks
 *    the workspace out of its only administrator, and self-promotion makes
 *    every other check meaningless. Role changes always involve two people.
 *
 * 3. THE LAST OWNER CANNOT BE DEMOTED OR SUSPENDED.
 *    A tenant with zero owners has nobody who can restore one. This is
 *    checked inside the same statement path as the write, not as advice in
 *    the UI.
 *
 * `platform_super_admin` is never assignable through this action at all —
 * it is a platform-operator role, not a tenant role, and a tenant
 * administrator has no business minting one.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { users } from "@/db/schema";
import { requirePermission, writeAudit, auditMeta } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { PermissionDeniedError } from "@/lib/permissions";
import { permissionsForRole } from "@/db/schema/auth";
import type { ActionResult } from "@/lib/validators/crm";
import { ASSIGNABLE_ROLES, ROLE_RANK } from "@/lib/validators/team";
import { requireSeat, SeatLimitError, getSeatSummary } from "@/server/billing/seats";
import type { AssignableRole } from "@/lib/validators/team";
import type { SystemRole } from "@/db/schema";

const updateRoleSchema = z.object({
  userId: z.string().uuid("Invalid identifier."),
  role: z.enum(ASSIGNABLE_ROLES),
});

const updateStatusSchema = z.object({
  userId: z.string().uuid("Invalid identifier."),
  status: z.enum(["active", "suspended"]),
});

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHO COUNTS AS AN OWNER WHO COULD ACTUALLY RESCUE THIS WORKSPACE
 * ══════════════════════════════════════════════════════════════════════
 * Both last-owner guards used `ne(status, "suspended")` and applied no
 * `deletedAt` filter. `user_status` has FOUR values, so `offboarded`
 * survived that test, and so did a soft-deleted row.
 *
 * ⚠️ A GHOST COULD THEREFORE BE THE LAST OWNER. An owner removed from
 * the Clerk organisation is set to `offboarded` with `deleted_at` filled
 * in and their role untouched, and was then counted. A workspace whose
 * only remaining `tenant_owner` rows were people who left two years ago
 * read as having two owners, and the real one could be demoted or
 * suspended on that basis, leaving nobody who could pay for it.
 *
 * ⭐ Only `active`, not deleted, and holding the role: the set of people
 * who could sign in right now and fix it.
 */
function usableOwners(tenantId: string) {
  return and(
    eq(users.tenantId, tenantId),
    eq(users.role, "tenant_owner"),
    eq(users.status, "active"),
    isNull(users.deletedAt),
  );
}

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  // A seat denial is a purchasing answer with its own remedy — "buy a
  // seat, or free one". It is not a permission problem and not an
  // entitlement problem, and surfacing it as "something went wrong"
  // leaves the admin with nothing to act on.
  if (err instanceof SeatLimitError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof ImpersonationForbiddenError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[team action]", err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export type TeamMember = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  role: SystemRole;
  status: string;
  jobTitle: string | null;
  department: string | null;
  lastSeenAt: string | null;
  permissionCount: number;
};

export async function getTeamMembers(): Promise<ActionResult<TeamMember[]>> {
  try {
    const ctx = await requirePermission("users:read");

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          avatarUrl: users.avatarUrl,
          role: users.role,
          status: users.status,
          jobTitle: users.jobTitle,
          department: users.department,
          lastSeenAt: users.lastSeenAt,
        })
        .from(users)
        /**
         * ⚠️ SOFT-DELETED ROWS ARE NOT TEAM MEMBERS. The team screen
         * computes its own owner count from this list, so an offboarded
         * owner appeared as a colleague AND as an owner, and the page
         * agreed with the server about a number both had wrong.
         */
        .where(and(eq(users.tenantId, ctx.tenant.id), isNull(users.deletedAt)))
        .orderBy(asc(users.email))
        .limit(500)
    );

    return {
      ok: true,
      data: rows.map((r) => ({
        ...r,
        lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
        permissionCount: permissionsForRole(r.role).length,
      })),
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* ROLE ASSIGNMENT                                                     */
/* ------------------------------------------------------------------ */

export async function updateUserRole(input: {
  userId: string;
  role: AssignableRole;
}): Promise<ActionResult<{ id: string; role: string }>> {
  try {
    const ctx = await requirePermission("roles:manage", { type: "user" });
    /*
      ⭐ THE SINGLE MOST IMPORTANT GATE IN THIS FILE.
      A role change OUTLIVES the session. An impersonating operator who
      can mint a `tenant_owner` — or promote an account they control —
      has converted a sixty-minute consented window into permanent
      access, and every expiry mechanism in the product would keep
      reporting that the session ended on time.
    */
    await assertImpersonationAllows("roles:update", ctx);
    const data = updateRoleSchema.parse(input);

    // RULE 2 — no self-modification, whatever your role.
    if (data.userId === ctx.user.id) {
      return fail(
        "You cannot change your own role. Ask another administrator to make this change.",
      );
    }

    const target = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.users.findFirst({
        where: and(eq(users.id, data.userId), eq(users.tenantId, ctx.tenant.id)),
        columns: { id: true, role: true, email: true, status: true },
      })
    );

    if (!target) return fail("That person is not a member of this workspace.");

    const actorRank = ROLE_RANK[ctx.role] ?? 0;
    const newRank = ROLE_RANK[data.role] ?? 0;
    const targetRank = ROLE_RANK[target.role] ?? 0;

    // RULE 1 — you cannot grant above your own level…
    if (newRank > actorRank) {
      return fail("You cannot assign a role more senior than your own.");
    }
    // …nor modify someone already more senior than you.
    if (targetRank > actorRank) {
      return fail("You cannot change the role of someone more senior than you.");
    }

    // RULE 3 — never remove the last owner.
    if (target.role === "tenant_owner" && data.role !== "tenant_owner") {
      const [owners] = await withTenant(ctx.tenant.id, (tx) =>
        tx
          .select({ value: count() })
          .from(users)
          .where(
            usableOwners(ctx.tenant.id),
          )
      );

      if ((owners?.value ?? 0) <= 1) {
        return fail(
          "This is the only owner of the workspace. Promote someone else to owner first.",
        );
      }
    }

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(users)
        .set({ role: data.role, updatedAt: new Date() })
        .where(and(eq(users.id, data.userId), eq(users.tenantId, ctx.tenant.id)))
        .returning({ id: users.id, role: users.role })
    );

    if (!updated) return fail("Could not update that person's role.");

    // A role change is a security event. It goes in the audit log at raised
    // severity with both the old and the new value — "changed to manager"
    // alone does not tell an auditor what was lost.
    await writeAudit(ctx, {
      action: "update",
      resourceType: "user",
      resourceId: data.userId,
      severity: "critical",
      metadata: auditMeta({
        event: "role_changed",
        targetEmail: target.email,
        previousRole: target.role,
        newRole: data.role,
      }),
    });

    revalidatePath("/settings/team");
    return { ok: true, data: updated };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* SUSPEND / REINSTATE                                                 */
/* ------------------------------------------------------------------ */

export async function updateUserStatus(input: {
  userId: string;
  status: "active" | "suspended";
}): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const ctx = await requirePermission("users:update", { type: "user" });
    // Suspending or reactivating an account is an access decision that
    // survives the session, and reactivating a dormant account is the
    // quiet half of the same escalation the role gate above refuses.
    await assertImpersonationAllows("users:update", ctx);
    const data = updateStatusSchema.parse(input);

    if (data.userId === ctx.user.id) {
      return fail("You cannot suspend your own account.");
    }

    const target = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.users.findFirst({
        where: and(eq(users.id, data.userId), eq(users.tenantId, ctx.tenant.id)),
        columns: { id: true, role: true, email: true },
      })
    );

    if (!target) return fail("That person is not a member of this workspace.");

    if ((ROLE_RANK[target.role] ?? 0) > (ROLE_RANK[ctx.role] ?? 0)) {
      return fail("You cannot suspend someone more senior than you.");
    }

    if (target.role === "tenant_owner" && data.status === "suspended") {
      const [owners] = await withTenant(ctx.tenant.id, (tx) =>
        tx
          .select({ value: count() })
          .from(users)
          .where(
            usableOwners(ctx.tenant.id),
          )
      );

      if ((owners?.value ?? 0) <= 1) {
        return fail("This is the only active owner. Suspending them would lock the workspace.");
      }
    }

    /**
     * ⚠️ REACTIVATION CONSUMES A SEAT, AND CAN THEREFORE FAIL.
     *
     * Suspension frees a seat — that is the whole point of it, and it is
     * how a customer swaps one employee for another without buying a
     * seat they do not need. The symmetric consequence is that
     * un-suspending someone takes a seat back, and if the workspace has
     * filled up in the meantime there may not be one.
     *
     * That asymmetry genuinely surprises people ("I'm only turning them
     * back on"), so the message explains the remedy rather than just
     * refusing.
     *
     * Suspension itself is never blocked. Preventing a customer from
     * reducing their usage would be indefensible.
     */
    if (data.status === "active") {
      await requireSeat(ctx.tenant.id, ctx.tenant.seatLimit, 1);
    }

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(users)
        .set({ status: data.status, updatedAt: new Date() })
        .where(and(eq(users.id, data.userId), eq(users.tenantId, ctx.tenant.id)))
        .returning({ id: users.id, status: users.status })
    );

    if (!updated) return fail("Could not update that person's status.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "user",
      resourceId: data.userId,
      severity: data.status === "suspended" ? "critical" : "notice",
      metadata: auditMeta({
        event: data.status === "suspended" ? "user_suspended" : "user_reinstated",
        targetEmail: target.email,
      }),
    });

    revalidatePath("/settings/team");
    return { ok: true, data: updated };
  } catch (err) {
    return toActionError(err);
  }
}


/* ------------------------------------------------------------------ */
/* SEAT USAGE (Phase 13)                                               */
/* ------------------------------------------------------------------ */

/**
 * Seat usage for the team page.
 *
 * Requires only `users:read` — the same permission as seeing the member
 * list — rather than a billing permission. Knowing "4 of 5 seats used"
 * is operational information an admin needs in order to manage the team
 * at all; gating it behind `billing:read` would mean the person adding
 * people cannot see why they are about to be refused.
 */
export async function getSeatUsage(): Promise<
  ActionResult<{
    used: number;
    purchased: number;
    available: number;
    isAtLimit: boolean;
    isOverLimit: boolean;
    overageMessage: string | null;
    warningMessage: string | null;
  }>
> {
  try {
    const ctx = await requirePermission("users:read");
    const summary = await getSeatSummary(ctx.tenant.id, ctx.tenant.seatLimit);

    return {
      ok: true,
      data: {
        used: summary.used,
        purchased: summary.purchased,
        available: summary.available,
        isAtLimit: summary.isAtLimit,
        isOverLimit: summary.isOverLimit,
        overageMessage: summary.overageMessage,
        warningMessage: summary.warningMessage,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}
