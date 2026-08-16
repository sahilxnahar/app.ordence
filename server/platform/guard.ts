import { chainScopeFor, nextChainLink, type AuditChainHead } from "@/lib/audit/chain";
import { isChainRace } from "@/server/audit";
import "server-only";

/**
 * Ordence — The Platform Console Gate
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY OTHER GATE IN THIS SYSTEM ASKS "WHICH TENANT?". THIS ONE DOES NOT.
 * ══════════════════════════════════════════════════════════════════════
 * `requireTenantContext()` resolves a tenant and refuses if it cannot.
 * That is what makes cross-tenant access impossible everywhere else, and
 * it is why NOTHING in this file uses it: a platform operator has no
 * tenant, and forcing one would either fail (they belong to no
 * organisation) or — far worse — succeed by picking whichever workspace
 * they happen to be a member of and quietly scoping the console to it.
 *
 * So this is a second, parallel authorisation path. Two independent gates
 * for two independent kinds of principal is correct; the danger is that
 * the second one gets less scrutiny than the first because it is used by
 * "us". Hence the size of this file relative to what it does.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TWO KEYS (full argument in `lib/platform/roles.ts`)
 * ══════════════════════════════════════════════════════════════════════
 *   KEY 1  Clerk-verified primary email ∈ `PLATFORM_ADMIN_EMAILS`
 *          → cannot be changed without a reviewed deploy
 *   KEY 2  active, unexpired row in `platform_staff` for the Clerk id
 *          → can be revoked in one statement, no deploy
 *
 * BOTH are required. A tenant administrator holds neither, and — this is
 * the property worth stating plainly — an attacker with full write access
 * to the DATABASE still cannot let themselves in, because KEY 1 is not in
 * the database.
 *
 * ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT TRUST:
 *   • `x-tenant-role: platform_super_admin` — middleware sets that header
 *     after its own check, and a header is not evidence. Defense in depth
 *     means the server re-decides.
 *   • `sessionClaims.metadata.platformAdmin` — the middleware routing
 *     check. Whether it is forgeable depends on the Clerk JWT template
 *     (see roles.ts and the phase notes). Reaching the route is worth
 *     nothing on its own.
 *   • `users.role = 'platform_super_admin'` — a row inside a customer's
 *     tenant. It means "does not consume a seat", nothing more.
 */

import { cache } from "react";
import { auth, currentUser } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db, withPlatformScope } from "@/db";
import { auditLogs } from "@/db/schema";
import {
  platformStaff,
  platformActionLog,
  type PlatformStaff,
} from "@/db/schema/platform";
import { getServerEnv } from "@/lib/env";
import { recordSecurityEvent } from "@/server/security/record";
import {
  evaluatePlatformAccess,
  evaluatePlatformCapability,
  parseAdminAllowlist,
  isAllowlisted,
  isStepUpFresh,
  requiresStepUp,
  capabilitiesForGrade,
  STEP_UP_MAX_AGE_MINUTES,
  type PlatformCapability,
  type PlatformGrade,
  type PlatformSubject,
} from "@/lib/platform/roles";

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

/**
 * Distinct from `TenantAccessError` and `PermissionDeniedError`.
 *
 * They mean different things and need different handling: a tenant
 * permission denial is shown to the user with a remedy ("ask your
 * admin"). A platform denial has NO remedy to offer and must never
 * explain itself — the message is identical for "you are not staff", "your
 * grant expired" and "your grade is too low", because the difference
 * between those answers is a map of our internal access model handed to
 * whoever is probing.
 */
export class PlatformAccessError extends Error {
  constructor(
    readonly code:
      | "unauthenticated"
      | "not_platform_staff"
      | "capability_denied"
      | "step_up_required",
    /** Internal, for logs and audit. NEVER returned to the caller. */
    readonly detail: string,
  ) {
    super(
      code === "step_up_required"
        ? "Confirm your identity to continue."
        : "Platform staff only.",
    );
    this.name = "PlatformAccessError";
  }
}

/* ------------------------------------------------------------------ */
/* THE OPERATOR                                                        */
/* ------------------------------------------------------------------ */

export type PlatformOperator = {
  staff: PlatformStaff;
  clerkUserId: string;
  email: string;
  grade: PlatformGrade;
  capabilities: readonly PlatformCapability[];
  /** Recorded on everything this operator does, for session binding. */
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
};

type RequestFacts = {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
};

async function getRequestFacts(): Promise<RequestFacts> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for");
    return {
      ipAddress: forwarded?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
      requestId: h.get("x-request-id") ?? null,
    };
  } catch {
    return { ipAddress: null, userAgent: null, requestId: null };
  }
}

/**
 * Resolve the caller, or null.
 *
 * Wrapped in React `cache()` so a page that renders four panels performs
 * ONE Clerk lookup and ONE staff read per request. Without it the console
 * would issue a Clerk backend call per component, which is both slow and
 * a rate-limit hazard on the one surface that must stay reachable during
 * an incident.
 *
 * ⚠️ RETURNS NULL, NEVER THROWS. The throwing wrapper is below. A gate
 * that throws from inside a cached resolver produces a cached rejected
 * promise, and the second caller gets an error with no stack of its own —
 * which is a genuinely horrible thing to debug at 03:00.
 */
export const getPlatformOperator = cache(async (): Promise<PlatformOperator | null> => {
  const { userId } = await auth();
  if (!userId) return null;

  /* ---- KEY 1: the deploy-time allowlist ------------------------- */
  //
  // The email comes from Clerk's backend, not from a session claim, and
  // it must be VERIFIED. An unverified address is an address somebody
  // typed; if an allowlisted address could be claimed by typing it into a
  // signup form, the allowlist would be an invitation.
  const user = await currentUser();
  const primary = user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  const verified = primary?.verification?.status === "verified";
  const email = verified ? (primary?.emailAddress ?? null) : null;

  const allowlist = parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS);
  const allowlisted = isAllowlisted(email, allowlist);

  /* ---- KEY 2: the revocable database grant ---------------------- */
  //
  // Read under `withPlatformScope` because `platform_staff` is not
  // tenant-scoped and its RLS policy admits only the platform-scoped
  // connection. The justification string is mandatory and greppable.
  const staff = await withPlatformScope(
    "Resolve platform staff record for console authorisation",
    async (database) =>
      database
        .select()
        .from(platformStaff)
        .where(eq(platformStaff.clerkUserId, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
  );

  const facts = await getRequestFacts();

  // ⚠️ THE DENIAL PATH RUNS EVEN WHEN THERE IS NO STAFF ROW. Someone
  // who is on the env allowlist but has no grant, or who has a grant but
  // is not on the allowlist, is a materially interesting event — it is
  // either a half-finished onboarding or somebody probing. Both are worth
  // a security row; neither is worth telling the caller about.
  if (!staff || !allowlisted) {
    if (allowlisted || staff) {
      await recordSecurityEvent({
        type: "tenant.cross_access_attempt",
        severity: "warning",
        source: "platform-console",
        subjectType: "platform_staff",
        subjectId: userId,
        ipAddress: facts.ipAddress,
        userAgent: facts.userAgent,
        requestId: facts.requestId,
        reason: "Platform console reached with only one of the two required keys.",
        detail: {
          allowlisted,
          hasStaffRecord: Boolean(staff),
          emailVerified: verified,
        },
      });
    }
    return null;
  }

  const subject: PlatformSubject = {
    clerkUserId: userId,
    email: email ?? staff.email,
    grade: staff.grade,
    status: staff.status,
    expiresAt: staff.expiresAt,
    allowlisted,
    now: new Date(),
  };

  const decision = evaluatePlatformAccess(subject);
  if (!decision.allowed) {
    await recordSecurityEvent({
      type: "tenant.cross_access_attempt",
      severity: "warning",
      source: "platform-console",
      subjectType: "platform_staff",
      subjectId: userId,
      ipAddress: facts.ipAddress,
      userAgent: facts.userAgent,
      requestId: facts.requestId,
      reason: `Platform console refused: ${decision.reason}`,
      detail: { reason: decision.reason, grade: staff.grade },
    });
    return null;
  }

  return {
    staff,
    clerkUserId: userId,
    email: subject.email,
    grade: staff.grade,
    capabilities: capabilitiesForGrade(staff.grade),
    ipAddress: facts.ipAddress,
    userAgent: facts.userAgent,
    requestId: facts.requestId,
  };
});

/**
 * Require platform staff. Throws `PlatformAccessError` otherwise.
 *
 * This is the form every server action and every console page must use.
 * It fails closed and cannot be forgotten the way an `if` can.
 */
export async function requirePlatformAdmin(): Promise<PlatformOperator> {
  const operator = await getPlatformOperator();
  if (!operator) {
    throw new PlatformAccessError("not_platform_staff", "No valid platform operator.");
  }
  return operator;
}

/**
 * Require a specific capability, and a fresh second factor when the
 * capability is on the step-up list.
 *
 * @example
 *   const operator = await requireCapability("tenants:suspend");
 */
export async function requireCapability(
  capability: PlatformCapability,
): Promise<PlatformOperator> {
  const operator = await requirePlatformAdmin();

  const decision = evaluatePlatformCapability(
    {
      clerkUserId: operator.clerkUserId,
      email: operator.email,
      grade: operator.grade,
      status: operator.staff.status,
      expiresAt: operator.staff.expiresAt,
      allowlisted: true, // already proved in getPlatformOperator()
      now: new Date(),
    },
    capability,
  );

  if (!decision.allowed) {
    await recordPlatformAudit({
      operator,
      tenantId: null,
      action: "security_event",
      resourceType: "platform_capability",
      resourceId: capability,
      severity: "warning",
      reason: `Refused: ${decision.reason}`,
      metadata: { capability, grade: operator.grade },
    });
    throw new PlatformAccessError("capability_denied", decision.message);
  }

  if (requiresStepUp(capability)) {
    await assertStepUpFresh(operator, capability);
  }

  return operator;
}

/* ------------------------------------------------------------------ */
/* STEP-UP                                                             */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ READ THIS BEFORE TRUSTING STEP-UP. IT IS THE WEAKEST CONTROL HERE.
 * ══════════════════════════════════════════════════════════════════════
 * The threat is a stolen session: an attacker holding the console cookie
 * but not the operator's second factor. The defence is to demand a fresh
 * factor before anything dangerous.
 *
 * A real implementation reads Clerk's `fva` (factor verification age)
 * session claim, which is signed by Clerk and cannot be set by the
 * client. This phase does not own `middleware.ts`, `lib/env.ts` or the
 * Clerk JWT template, so the claim may not be present at all.
 *
 * So there are two behaviours, and the difference between them is stated
 * out loud rather than hidden:
 *
 *   • `fva` PRESENT  → cryptographic. A stale factor is REFUSED.
 *   • `fva` ABSENT   → `platform_staff.last_step_up_at` is consulted
 *                      instead. That column records that somebody clicked
 *                      "confirm", which an attacker holding the session
 *                      can also do. It is A SPEED BUMP, NOT A CONTROL,
 *                      and every use of it writes a `warning` audit row
 *                      saying so.
 *
 * Closing the gap is INTEGRATION step 4 in docs/PHASE-17-18-NOTES.md. It
 * is listed there rather than silently ignored because a security control
 * everyone believes exists is worse than one everyone knows is missing.
 */
export async function assertStepUpFresh(
  operator: PlatformOperator,
  capability: PlatformCapability,
): Promise<void> {
  const { sessionClaims } = await auth();

  // Clerk emits `fva` as [factor1Age, factor2Age] in minutes; -1 means
  // "never verified". Read defensively — the claim shape is Clerk's, not
  // ours, and a missing or malformed value must not read as "fresh".
  const fva = (sessionClaims as { fva?: unknown } | null)?.fva;
  if (Array.isArray(fva)) {
    const secondFactorAge = typeof fva[1] === "number" ? fva[1] : -1;
    if (secondFactorAge < 0 || secondFactorAge > STEP_UP_MAX_AGE_MINUTES) {
      throw new PlatformAccessError(
        "step_up_required",
        `Second factor age ${secondFactorAge}m exceeds ${STEP_UP_MAX_AGE_MINUTES}m.`,
      );
    }
    return;
  }

  // Degraded path.
  if (!isStepUpFresh(operator.staff.lastStepUpAt, new Date())) {
    throw new PlatformAccessError(
      "step_up_required",
      "No fresh step-up recorded for this operator.",
    );
  }

  await recordPlatformAudit({
    operator,
    tenantId: null,
    action: "security_event",
    resourceType: "platform_step_up",
    resourceId: capability,
    severity: "warning",
    reason:
      "Step-up accepted WITHOUT a Clerk `fva` claim — this is a click, not a " +
      "verified factor. See INTEGRATION step 4.",
    metadata: { capability },
  });
}

/**
 * Record that the operator re-confirmed. See the caveat above: without
 * `fva` this is an assertion, not a verification.
 */
export async function recordStepUp(operator: PlatformOperator): Promise<void> {
  await withPlatformScope(
    "Record platform operator step-up timestamp for dangerous-action gating",
    async (database) => {
      await database
        .update(platformStaff)
        .set({ lastStepUpAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(platformStaff.id, operator.staff.id),
            eq(platformStaff.status, "active"),
          ),
        );
    },
  );
}

/* ------------------------------------------------------------------ */
/* PLATFORM AUDIT                                                      */
/* ------------------------------------------------------------------ */

export type PlatformAuditEntry = {
  operator: PlatformOperator;
  /**
   * The tenant this concerns, or null for genuinely cross-tenant events
   * (a directory search spans everybody and belongs to nobody).
   *
   * ⚠️ THIS CHOICE DECIDES WHO CAN SEE THE ROW. `audit_logs` RLS is
   * `tenant_id = app_current_tenant_id()`, so a row written with a tenant
   * id is visible IN THAT CUSTOMER'S OWN AUDIT LOG, and a NULL row is
   * visible to nobody but platform tooling. Both are deliberate:
   * everything we do TO a tenant should be something they can see us
   * doing.
   */
  tenantId: string | null;
  action:
    | "read"
    | "update"
    | "config_change"
    | "impersonate"
    | "security_event"
    | "export";
  resourceType: string;
  resourceId?: string | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  reason: string;
  severity?: "info" | "notice" | "warning" | "critical";
  /** Set when the action happened under an impersonation session. */
  impersonationId?: string | null;
};

/**
 * Write a platform action into `audit_logs`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY `audit_logs` AND NOT A `platform_actions` TABLE
 * ══════════════════════════════════════════════════════════════════════
 * A separate table was the obvious design and it is wrong for the same
 * reason Phase 5 refused to split the audit trail: an audit trail spread
 * across two tables cannot prove anything, because a reader has to trust
 * that BOTH are complete. The question this data exists to answer —
 * "everything that touched Acme's workspace last Tuesday" — becomes a
 * union of two schemas that drift.
 *
 * `audit_logs` already has every column needed: an `impersonation_id`
 * column that exists for no other purpose, an `actor_role` that can say
 * `platform_owner`, and an append-only trigger that already makes it
 * tamper-evident. Adding a table would have meant re-earning all of that.
 *
 * ⚠️ TENANT-ATTRIBUTED ROWS GO THROUGH `withTenant()`. The RLS `WITH
 * CHECK` on `audit_logs` demands `tenant_id = app_current_tenant_id()`,
 * so writing a tenant-owned audit row from the platform connection is
 * refused by the database. That is the policy working correctly, not an
 * obstacle: the row belongs to the tenant, so it is written in the
 * tenant's context.
 *
 * ⚠️ TENANT-LESS ROWS CANNOT GO IN `audit_logs` AT ALL. The same policy
 * evaluates `NULL = NULL` → NULL for a NULL-tenant insert, so it is
 * refused too — verified against PostgreSQL 16, see the header of
 * `db/schema/platform.ts`. Those rows go to `platform_action_log`, and
 * the routing below is mechanical (`tenantId` set or not) precisely so
 * nobody has to remember which table to pick.
 *
 * NEVER THROWS — same contract as `writeAudit()`. A failed audit write
 * must not roll back an operator's action, but it is logged loudly so a
 * broken trail is visible in monitoring rather than silently absent.
 */
export async function recordPlatformAudit(entry: PlatformAuditEntry): Promise<void> {
  const values = {
    actorUserId: null,
    actorClerkId: entry.operator.clerkUserId,
    actorEmail: entry.operator.email,
    actorRole: `platform_${entry.operator.grade}`,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
    metadata: {
      ...(entry.metadata ?? {}),
      source: "platform_console",
      operatorGrade: entry.operator.grade,
    },
    severity: entry.severity ?? "notice",
    reason: entry.reason,
    ipAddress: entry.operator.ipAddress,
    userAgent: entry.operator.userAgent,
    requestId: entry.operator.requestId,
    impersonationId: entry.impersonationId ?? null,
    tenantId: entry.tenantId ?? null,
  };
  
  const tenantId = entry.tenantId;
  const scope = chainScopeFor(tenantId);
  
  try {
    if (tenantId) {
      const { withTenant } = await import("@/db");
      const { desc, and, eq, isNotNull } = await import("drizzle-orm");
      const { MAX_CHAIN_ATTEMPTS } = await import("@/server/audit");
      
      for (let attempt = 1; attempt <= MAX_CHAIN_ATTEMPTS; attempt++) {
        try {
          await withTenant(tenantId, async (tx) => {
            const [row] = await tx
              .select({ chainSeq: auditLogs.chainSeq, rowHash: auditLogs.rowHash })
              .from(auditLogs)
              .where(and(eq(auditLogs.tenantId, tenantId), isNotNull(auditLogs.chainSeq)))
              .orderBy(desc(auditLogs.chainSeq))
              .limit(1);
              
            const head: AuditChainHead =
              row?.chainSeq != null && row.rowHash != null
                ? { chainSeq: row.chainSeq, rowHash: row.rowHash }
                : null;
                
            const link = nextChainLink({ scope, head, content: values });
            
            await tx.insert(auditLogs).values({
              ...(values as typeof auditLogs.$inferInsert),
              tenantId: tenantId,
              chainSeq: link.chainSeq,
              prevHash: link.prevHash,
              contentHash: link.contentHash,
              rowHash: link.rowHash,
            });
          });
          return; // Success
        } catch (err) {
          if (!isChainRace(err) || attempt === MAX_CHAIN_ATTEMPTS) {
            // Fallback to unchained write if chained write fails
            const { withTenant } = await import("@/db");
            await withTenant(tenantId, async (tx) => {
              await tx.insert(auditLogs).values({ ...(values as typeof auditLogs.$inferInsert), tenantId: tenantId });
            });
            console.error("[PLATFORM AUDIT CHAIN DEGRADED]", {
              tenantId,
              action: entry.action,
              resourceType: entry.resourceType,
              actor: entry.operator.email,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
      }
    } else {
      const { withPlatformScope } = await import("@/db");
      const { desc, and, eq, isNotNull } = await import("drizzle-orm");
      const { MAX_CHAIN_ATTEMPTS } = await import("@/server/audit");
      
      for (let attempt = 1; attempt <= MAX_CHAIN_ATTEMPTS; attempt++) {
        try {
          await withPlatformScope(
            `Record a platform action: ${entry.action} on ${entry.resourceType}`,
            async (tx) => {
              const [row] = await tx
                .select({ chainSeq: platformActionLog.chainSeq, rowHash: platformActionLog.rowHash })
                .from(platformActionLog)
                .where(isNotNull(platformActionLog.chainSeq))
                .orderBy(desc(platformActionLog.chainSeq))
                .limit(1);
                
              const head: AuditChainHead =
                row?.chainSeq != null && row.rowHash != null
                  ? { chainSeq: row.chainSeq, rowHash: row.rowHash }
                  : null;
                  
              const content = {
                actorClerkId: entry.operator.clerkUserId,
                actorEmail: entry.operator.email,
                actorGrade: entry.operator.grade,
                action: entry.action,
                resourceType: entry.resourceType,
                resourceId: entry.resourceId ?? null,
                justification: entry.reason,
                metadata: entry.metadata ?? {},
                resultCount:
                  typeof entry.metadata?.resultCount === "number"
                    ? entry.metadata.resultCount
                    : null,
                severity: entry.severity ?? "notice",
                ipAddress: entry.operator.ipAddress,
                userAgent: entry.operator.userAgent,
                requestId: entry.operator.requestId,
              };
                  
              const link = nextChainLink({ scope, head, content });
              
              await tx.insert(platformActionLog).values({
                ...content,
                chainSeq: link.chainSeq,
                prevHash: link.prevHash,
                contentHash: link.contentHash,
                rowHash: link.rowHash,
              });
            },
          );
          return; // Success
        } catch (err) {
          if (!isChainRace(err) || attempt === MAX_CHAIN_ATTEMPTS) {
            // Fallback to unchained write if chained write fails
            const { withPlatformScope } = await import("@/db");
            await withPlatformScope(
              `Record a platform action: ${entry.action} on ${entry.resourceType}`,
              (tx) =>
                tx.insert(platformActionLog).values({
                  actorClerkId: entry.operator.clerkUserId,
                  actorEmail: entry.operator.email,
                  actorGrade: entry.operator.grade,
                  action: entry.action,
                  resourceType: entry.resourceType,
                  resourceId: entry.resourceId ?? null,
                  justification: entry.reason,
                  metadata: entry.metadata ?? {},
                  resultCount:
                    typeof entry.metadata?.resultCount === "number"
                      ? entry.metadata.resultCount
                      : null,
                  severity: entry.severity ?? "notice",
                  ipAddress: entry.operator.ipAddress,
                  userAgent: entry.operator.userAgent,
                  requestId: entry.operator.requestId,
                }),
            );
            console.error("[PLATFORM AUDIT CHAIN DEGRADED]", {
              tenantId,
              action: entry.action,
              resourceType: entry.resourceType,
              actor: entry.operator.email,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
      }
    }
  } catch (err) {
    console.error("[PLATFORM AUDIT WRITE FAILED]", {
      tenantId: entry.tenantId,
      action: entry.action,
      resourceType: entry.resourceType,
      actor: entry.operator.email,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}


