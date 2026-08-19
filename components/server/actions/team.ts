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
/**
 * ⭐ 0114 — the approval queue. `server/billing/seat-approval.ts` holds
 * the decisions; these actions are the door onto them.
 */
import {
  listPendingSeats,
  approvePendingSeat,
  declinePendingSeat,
  SeatApprovalRefusal,
} from "@/server/billing/seat-approval";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { PermissionDeniedError } from "@/lib/permissions";
import { permissionsForRole, ROLE_TEMPLATES, PERMISSION_CATALOG } from "@/db/schema/auth";
import type { ActionResult } from "@/lib/validators/crm";
import { ASSIGNABLE_ROLES, ROLE_RANK } from "@/lib/validators/team";
import {
  requireSeatTx,
  countSeatsPurchased,
  SeatLimitError,
  getSeatSummary,
} from "@/server/billing/seats";
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
    /**
     * 🔴 THE SEAT COUNT AND THE SEAT WRITE ARE ONE TRANSACTION.
     *
     * This used to be `await requireSeat(...)` on the line before the
     * update — two separate connections, and therefore two separate
     * snapshots. Two admins reinstating two people at once both read the
     * same "4 of 5", both passed, and both wrote. A `curl` replay did the
     * same thing on its own. The screen that hides the button is a
     * mistake guard; this is the boundary, and it has to hold when the
     * screen is bypassed entirely.
     *
     * `seatsPurchased` is resolved OUTSIDE the transaction on purpose —
     * see `requireSeatTx`. It races with nothing that matters.
     */
    const seatsPurchased =
      data.status === "active"
        ? await countSeatsPurchased(ctx.tenant.id, ctx.tenant.seatLimit)
        : 0;

    const [updated] = await withTenant(ctx.tenant.id, async (tx) => {
      if (data.status === "active") {
        // Throws `SeatLimitError`, which aborts this transaction. There is
        // no ordering in which the row is written and the check said no.
        await requireSeatTx(tx, ctx.tenant.id, seatsPurchased, 1);
      }

      return tx
        .update(users)
        .set({ status: data.status, updatedAt: new Date() })
        .where(and(eq(users.id, data.userId), eq(users.tenantId, ctx.tenant.id)))
        .returning({ id: users.id, status: users.status });
    });

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

/* ================================================================== */
/* ⭐⭐⭐ THE SEAT APPROVAL QUEUE — 0114                                */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * There is no in-product invite, so people arrive through Clerk. That
 * path used to check the seat limit, write an audit row, and admit them
 * anyway — which made a ten-seat licence a ten-seat suggestion.
 *
 * They now arrive as `pending_seat`, which consumes no seat, and land in
 * this queue. Clerk gets its 200 and stops retrying; the person can sign
 * in and sees one screen explaining that a seat has been requested.
 */

export type PendingSeatView = {
  requestId: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  source: string;
  requestedAt: string;
  seatsUsedAtRequest: number;
  seatsAvailableAtRequest: number;
  waitingDays: number;
};

/**
 * ⚠️ `users:read`, THE SAME AS SEEING THE MEMBER LIST, and for the reason
 * `getSeatUsage` gives above: the person managing the team needs to see
 * why somebody is waiting, and gating it behind a billing permission
 * would hide the queue from exactly the person who works it.
 */
export async function getPendingSeats(): Promise<
  ActionResult<{ rows: PendingSeatView[]; seatsAvailable: number }>
> {
  try {
    const ctx = await requirePermission("users:read");

    const [rows, summary] = await Promise.all([
      withTenant(ctx.tenant.id, (tx) => listPendingSeats(tx, ctx.tenant.id)),
      getSeatSummary(ctx.tenant.id, ctx.tenant.seatLimit),
    ]);

    return {
      ok: true,
      data: { rows: [...rows], seatsAvailable: summary.available },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * ⭐⭐ APPROVE, AND IT CONSUMES A SEAT.
 *
 * 🔴 IT CAN FAIL, AND THAT IS THE POINT. If no seat is free the approval
 * is refused with the price named, rather than letting the person in and
 * adding a line to next month's invoice. `lib/billing/seats.ts` already
 * argues that case: *"an admin adding twelve people on a Friday afternoon
 * discovers a bill they never agreed to on the first of the month, and
 * the support conversation that follows is one you cannot win."*
 *
 * ⚠️ `users:manage` AND NOT `users:read`. Reading the queue is
 * operational; letting somebody into the workspace is not.
 */
export async function approveSeatRequest(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const data = z.object({ requestId: z.string().uuid() }).parse(input);
    /**
     * ⚠️ `users:invite`, NOT `users:update`. Approving a seat is letting
     * somebody INTO the workspace, which is exactly what the invite
     * permission is for. `users:update` is for changing somebody who is
     * already in, and an admin trusted to edit a job title is not
     * necessarily trusted to add a person and a line to the bill.
     */
    const ctx = await requirePermission("users:invite");

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const outcome = await approvePendingSeat(tx, {
        tenantId: ctx.tenant.id,
        requestId: data.requestId,
        approvedByUserId: ctx.user.id,
        fallbackSeatLimit: ctx.tenant.seatLimit,
      });

      await writeAudit(ctx, {
        action: "update",
        resourceType: "seat_request",
        resourceId: data.requestId,
        newValue: { resolution: "approved", userId: outcome.userId },
        reason: "A seat was approved for a person who arrived without one.",
        severity: "notice",
      });

      return outcome;
    });

    revalidatePath("/settings/team");
    return {
      ok: true,
      data: {
        note:
          result.seatsRemaining === 0
            ? "Approved. That was your last seat."
            : `Approved. ${result.seatsRemaining} seat${result.seatsRemaining === 1 ? "" : "s"} remaining.`,
      },
    };
  } catch (err) {
    if (err instanceof SeatApprovalRefusal) return fail(err.message);
    return toActionError(err);
  }
}

/**
 * ⭐ DECLINE, AND IT NEEDS A REASON.
 *
 * ⚠️ THE PERSON IS NOT DELETED. They stay `pending_seat`, so they can
 * still sign in and still see where they stand. Deleting them would make
 * the decision invisible to the only person it affects, and they would go
 * on waiting for an answer that already exists.
 */
export async function declineSeatRequest(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const data = z
      .object({
        requestId: z.string().uuid(),
        reason: z.string().trim().min(1),
      })
      .parse(input);
    /**
     * ⚠️ `users:invite`, NOT `users:update`. Approving a seat is letting
     * somebody INTO the workspace, which is exactly what the invite
     * permission is for. `users:update` is for changing somebody who is
     * already in, and an admin trusted to edit a job title is not
     * necessarily trusted to add a person and a line to the bill.
     */
    const ctx = await requirePermission("users:invite");

    await withTenant(ctx.tenant.id, async (tx) => {
      await declinePendingSeat(tx, {
        tenantId: ctx.tenant.id,
        requestId: data.requestId,
        declinedByUserId: ctx.user.id,
        reason: data.reason,
      });

      await writeAudit(ctx, {
        action: "update",
        resourceType: "seat_request",
        resourceId: data.requestId,
        newValue: { resolution: "declined" },
        reason: data.reason.trim(),
        severity: "notice",
      });
    });

    revalidatePath("/settings/team");
    return {
      ok: true,
      data: {
        note: "Declined, with your reason recorded. They can see that they are not being given a seat.",
      },
    };
  } catch (err) {
    if (err instanceof SeatApprovalRefusal) return fail(err.message);
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* WAVE 9 — WHAT A ROLE ACTUALLY GRANTS                                */
/* ------------------------------------------------------------------ */

export type RolePermissionRow = {
  readonly role: string;
  readonly label: string;
  readonly description: string;
  readonly grantsEverything: boolean;
  readonly permissions: readonly { readonly key: string; readonly label: string }[];
};

/**
 * ⭐⭐⭐ THE ONLY THING IN THE PRODUCT THAT READS `roles:read`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PERMISSION EXISTED, `security_admin` HELD IT, NOTHING USED IT
 * ══════════════════════════════════════════════════════════════════════
 * `roles:manage` gates `updateUserRole` and has since Phase 8.
 * `roles:read` — its read counterpart, granted to `security_admin` and
 * to nobody else outside the wildcard roles — gated nothing, because
 * there was nothing to gate: the product had no way to see what a role
 * grants before assigning it. The team screen showed a permission COUNT
 * per member, which tells an administrator that "manager" has 45 of
 * something and not which 45.
 *
 * That is the gap this closes, and closing it is why the key is now
 * enforced rather than merely enforceable. An administrator choosing
 * between `manager` and `member` for a new hire is making an
 * authorisation decision with a number as their only evidence.
 *
 * ⚠️ `roles:read` AND NOT `users:read`. Reading the team list is an
 * everyday operation almost every role can do. Reading the authorisation
 * model is reconnaissance if the reader is not trusted with it — it is
 * the map of what each account can reach — which is precisely why the
 * role template gives it to `security_admin` and withholds it from
 * `member`, who does hold `users:read`.
 *
 * ⚠️ IT RETURNS THE TEMPLATES, NOT ANY INDIVIDUAL'S EFFECTIVE SET. A
 * user's real permissions are their role plus their overrides, and
 * showing one person's effective list on a screen about ROLES would
 * invite the reader to conclude the template says something it does not.
 */
export async function getRolePermissionMatrix(): Promise<ActionResult<RolePermissionRow[]>> {
  try {
    await requirePermission("roles:read");

    const labels = PERMISSION_CATALOG as Record<string, string>;

    const rows: RolePermissionRow[] = Object.values(ROLE_TEMPLATES)
      /**
       * ⚠️ `platform_super_admin` IS EXCLUDED. It is an Ordence staff
       * role, it is never assignable inside a workspace, and listing it
       * on a customer's screen tells them a role exists that can see
       * their data and that they cannot control. That conversation
       * belongs in the support-access screen, which is built for it.
       */
      .filter((template) => template.key !== "platform_super_admin")
      .map((template) => {
        const keys = permissionsForRole(template.key as SystemRole);
        return {
          role: template.key,
          label: template.label,
          description: template.description,
          grantsEverything: template.permissions === "*",
          permissions: [...keys]
            .sort()
            .map((key) => ({ key, label: labels[key] ?? key })),
        };
      });

    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}
