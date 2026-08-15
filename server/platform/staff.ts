import "server-only";

/**
 * Ordence — Platform Staff Administration
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONLY OPERATION IN THE CONSOLE THAT CREATES ANOTHER OPERATOR
 * ══════════════════════════════════════════════════════════════════════
 * Which makes it the one an attacker who has already got in most wants,
 * because it is the difference between a session and a foothold.
 *
 * Three things constrain it, and the third is the one that matters:
 *
 *   1. `owner` grade only.
 *   2. A fresh step-up (see the honest caveat in `guard.ts`).
 *   3. ⭐ THE TARGET MUST ALREADY BE IN `PLATFORM_ADMIN_EMAILS`.
 *
 * (3) is what makes this form incapable of minting access on its own. It
 * turns KEY 2 for somebody who already holds KEY 1, and KEY 1 cannot be
 * granted from inside the application at all — it needs a reviewed commit
 * and production environment access. So an attacker holding a stolen
 * owner session can promote only people the organisation has already
 * decided to trust, which is a materially smaller prize.
 *
 * REVOCATION IS DELIBERATELY EASIER THAN GRANTING: any `owner`, no
 * allowlist requirement, one statement, effective on the next request.
 * The asymmetry is the design — the cheap operation should be the safe
 * one.
 *
 * ⚠️ NOTHING HERE DELETES. Revocation is a status change, so the record
 * of who held platform access, when, and who granted it survives the
 * revocation. A `DELETE` would let somebody remove the evidence that they
 * were ever staff.
 */

import { and, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { platformStaff } from "@/db/schema/platform";
import { getServerEnv } from "@/lib/env";
import { parseAdminAllowlist, isAllowlisted, GRADE_LABELS } from "@/lib/platform/roles";
import {
  grantPlatformStaffSchema,
  revokePlatformStaffSchema,
  type PlatformResult,
} from "@/lib/platform/schemas";
import { requireCapability, recordPlatformAudit } from "./guard";

export type StaffRow = {
  id: string;
  email: string;
  displayName: string | null;
  grade: string;
  gradeLabel: string;
  status: string;
  grantedByEmail: string | null;
  grantedAt: string;
  expiresAt: string | null;
  expired: boolean;
  /** False when the row exists but the env allowlist no longer names them. */
  allowlisted: boolean;
};

/* ------------------------------------------------------------------ */
/* LIST                                                                */
/* ------------------------------------------------------------------ */

/**
 * Everyone who holds — or held — platform access.
 *
 * ⭐ `allowlisted` IS THE COLUMN TO READ. A row that is `active` but no
 * longer in `PLATFORM_ADMIN_EMAILS` cannot sign in (both keys are
 * required), and that is the correct behaviour, but it is also a stale
 * grant nobody cleaned up. Showing it makes the drift between the two
 * keys visible instead of leaving it to be discovered during an audit.
 */
export async function listPlatformStaff(): Promise<PlatformResult<StaffRow[]>> {
  await requireCapability("staff:read");
  const allowlist = parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS);
  const now = new Date();

  const rows = await withPlatformScope(
    "Platform console: list platform staff grants for access review",
    async (db) =>
      db.select().from(platformStaff).orderBy(desc(platformStaff.grantedAt)).limit(200),
  );

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.displayName,
      grade: r.grade,
      gradeLabel: GRADE_LABELS[r.grade],
      status: r.status,
      grantedByEmail: r.grantedByEmail,
      grantedAt: r.grantedAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      expired: Boolean(r.expiresAt && r.expiresAt.getTime() <= now.getTime()),
      allowlisted: isAllowlisted(r.email, allowlist),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* GRANT                                                               */
/* ------------------------------------------------------------------ */

export async function grantPlatformStaff(input: unknown): Promise<PlatformResult<void>> {
  const operator = await requireCapability("staff:manage");

  const parsed = grantPlatformStaffSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { clerkUserId, email, displayName, grade, reason, expiresAt } = parsed.data;

  /**
   * 🔴 (0): NOT YOURSELF.
   *
   * `onConflictDoUpdate` targets `clerk_user_id`, so this function is
   * also the RENEWAL path. Without this check an owner could extend
   * their own grant indefinitely, clear their own `revoked_at` and
   * re-grade themselves, with no second party anywhere in the flow —
   * which makes the mandatory expiry, the whole point of which is that
   * a grant ends without somebody choosing to end it, self-serviceable.
   *
   * ⚠️ REVOCATION IS DELIBERATELY NOT SYMMETRIC. Revoking your own
   * compromised access must stay available at 3am; extending it must
   * not.
   */
  if (clerkUserId === operator.staff.clerkUserId) {
    return {
      ok: false,
      error:
        "You cannot grant or renew your own platform access. Ask another " +
        "owner. If you are the only owner, the grant has to be made in the " +
        "database, which is the same door the first one came through.",
      fieldErrors: { clerkUserId: ["This is your own account."] },
    };
  }

  /* ---- (3): KEY 1 must already be held --------------------------- */
  const allowlist = parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS);
  if (!isAllowlisted(email, allowlist)) {
    return {
      ok: false,
      error:
        `${email} is not in PLATFORM_ADMIN_EMAILS. Platform access needs both a ` +
        `config change (reviewed, deployed) and this grant — one of them on its own ` +
        `is not enough, deliberately.`,
      fieldErrors: { email: ["Not on the deploy-time allowlist."] },
    };
  }

  const expiry = new Date(expiresAt);
  if (expiry.getTime() <= Date.now()) {
    return { ok: false, error: "The end date is in the past." };
  }

  await withPlatformScope(
    `Platform console: grant ${grade} platform access to ${email} — ${reason.slice(0, 80)}`,
    async (db) => {
      await db
        .insert(platformStaff)
        .values({
          clerkUserId,
          email,
          displayName: displayName ?? null,
          grade,
          status: "active",
          expiresAt: expiry,
          grantedByEmail: operator.email,
          grantReason: reason,
        })
        .onConflictDoUpdate({
          target: platformStaff.clerkUserId,
          set: {
            email,
            displayName: displayName ?? null,
            grade,
            status: "active",
            expiresAt: expiry,
            grantedByEmail: operator.email,
            grantReason: reason,
            revokedAt: null,
            revokedBy: null,
            revokeReason: null,
            // ⚠️ Cleared on every re-grant. A newly granted operator must
            // prove a factor before doing anything dangerous, rather than
            // inheriting a step-up from a previous grant.
            lastStepUpAt: null,
            updatedAt: new Date(),
          },
        });
    },
  );

  await recordPlatformAudit({
    operator,
    tenantId: null,
    action: "config_change",
    resourceType: "platform_staff_grant",
    resourceId: clerkUserId,
    newValue: { email, grade, expiresAt: expiry.toISOString() },
    severity: "critical",
    reason,
    metadata: { grantedTo: email, grade },
  });

  return { ok: true, data: undefined };
}

/* ------------------------------------------------------------------ */
/* REVOKE                                                              */
/* ------------------------------------------------------------------ */

export async function revokePlatformStaff(input: unknown): Promise<PlatformResult<void>> {
  const operator = await requireCapability("staff:manage");

  const parsed = revokePlatformStaffSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { staffId, reason } = parsed.data;

  const outcome = await withPlatformScope(
    `Platform console: revoke platform access ${staffId} — ${reason.slice(0, 80)}`,
    async (db) => {
      const [target] = await db
        .select()
        .from(platformStaff)
        .where(eq(platformStaff.id, staffId))
        .limit(1);

      if (!target) return { error: "No such grant." } as const;

      /**
       * 🔴 THE LAST OWNER STAYS.
       *
       * Nothing stopped this before v1.31.0, and the console is the
       * only door back in: `grantPlatformStaff` requires
       * `staff:manage`, which only `owner` holds. So an owner revoking
       * themselves — or an attacker with a stolen owner session
       * revoking every owner in turn — locked the console permanently
       * for everybody, and recovery meant a hand-written INSERT against
       * the production database. That is a denial of service with a
       * one-line trigger.
       *
       * ⚠️ SELF-REVOCATION IS STILL PERMITTED while somebody else can
       * still get in. Being unable to kill your own compromised access
       * at 3am is the worse failure, and it is the reason this check
       * counts REMAINING owners rather than refusing self-revocation.
       */
      if (target.grade === "owner") {
        const remaining = await db
          .select({ id: platformStaff.id })
          .from(platformStaff)
          .where(
            and(
              eq(platformStaff.grade, "owner"),
              eq(platformStaff.status, "active"),
              isNull(platformStaff.revokedAt),
              ne(platformStaff.id, staffId),
              or(
                isNull(platformStaff.expiresAt),
                gt(platformStaff.expiresAt, new Date()),
              ),
            ),
          )
          .limit(1);

        if (remaining.length === 0) {
          return {
            error:
              "This is the last usable owner. Revoking it would lock the " +
              "console for everybody, including you, and the only way back " +
              "in would be a hand-written row in the production database. " +
              "Grant somebody else owner grade first.",
          } as const;
        }
      }

      await db
        .update(platformStaff)
        .set({
          status: "revoked",
          revokedAt: new Date(),
          revokeReason: reason,
          /**
           * 🔴 THE COLUMN EXISTED SINCE PHASE 17 AND NOTHING WROTE IT.
           * `platform_staff.revoked_by` was always NULL, so the table
           * alone could not say who revoked a grant — you had to join
           * `platform_action_log`, which is exactly the two-table
           * problem the guard argues against elsewhere.
           */
          revokedBy: operator.staff.id,
          lastStepUpAt: null,
          updatedAt: new Date(),
        })
        .where(eq(platformStaff.id, staffId));

      return { email: target.email, grade: target.grade } as const;
    },
  );

  if (outcome.error) return { ok: false, error: outcome.error };

  await recordPlatformAudit({
    operator,
    tenantId: null,
    action: "config_change",
    resourceType: "platform_staff_revoke",
    resourceId: staffId,
    oldValue: { email: outcome.email, grade: outcome.grade, status: "active" },
    newValue: { status: "revoked" },
    severity: "critical",
    reason,
    metadata: { revokedFrom: outcome.email, selfRevoke: outcome.email === operator.email },
  });

  return { ok: true, data: undefined };
}
