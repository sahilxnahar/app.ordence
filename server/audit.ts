import "server-only";

/**
 * Ordence — Audit & Authorization Enforcement
 * Version: v0.5.0-alpha
 *
 * ONE PATH FOR BOTH CONCERNS.
 *
 * `checkPermission()` does two things that must never be separated: it decides
 * whether an action is allowed, and — when it is not — it records the denial.
 * Splitting them would mean every call site has to remember to log, and some
 * would not. Attempted-but-blocked actions are precisely the events a security
 * review needs; losing them is worse than losing successful ones.
 *
 * The audit table is `audit_logs` (Phase 1), already append-only at the database
 * level and already under RLS. Phase 5 adds `metadata` and `severity` to it
 * rather than creating a second table — an audit trail split across two tables
 * cannot prove anything, because you would have to trust that both were complete.
 */

import { headers } from "next/headers";
import { db, withTenant } from "@/db";
import { auditLogs, permissionDenials } from "@/db/schema";
import { DANGEROUS_PERMISSIONS, type PermissionKey } from "@/db/schema/auth";
import {
  evaluatePermission,
  PermissionDeniedError,
  isPermissionKey,
  type PermissionDecision,
} from "@/lib/permissions";
import { requireTenantContext, type TenantContext } from "@/server/tenant-context";

/* ------------------------------------------------------------------ */
/* AUDIT ACTIONS                                                       */
/* ------------------------------------------------------------------ */

export type AuditAction =
  | "create" | "read" | "update" | "delete"
  | "login" | "logout" | "login_failed"
  | "permission_change" | "role_change"
  | "export" | "impersonate" | "config_change" | "security_event";

export type AuditSeverity = "info" | "notice" | "warning" | "critical";

export type AuditEntry = {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  /** Circumstance of the event — period id, contract version, amounts, etc. */
  metadata?: Record<string, unknown>;
  reason?: string;
  severity?: AuditSeverity;
};

/* ------------------------------------------------------------------ */
/* REQUEST CONTEXT                                                     */
/* ------------------------------------------------------------------ */

type RequestFacts = {
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  requestId: string | null;
};

/**
 * Extract forensic detail from the request.
 *
 * `x-forwarded-for` is client-controllable in general, but on Vercel the edge
 * network overwrites it, so the first entry is trustworthy here. It is recorded
 * as evidence, never used for an authorization decision.
 */
async function getRequestFacts(): Promise<RequestFacts> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for");
    return {
      ipAddress: forwarded?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
      country: h.get("x-vercel-ip-country") ?? null,
      requestId: h.get("x-request-id") ?? null,
    };
  } catch {
    // No request context (background job) — not an error, just no forensics.
    return { ipAddress: null, userAgent: null, country: null, requestId: null };
  }
}

/* ------------------------------------------------------------------ */
/* AUDIT WRITER                                                        */
/* ------------------------------------------------------------------ */

/**
 * Write an audit record.
 *
 * NEVER THROWS. An audit failure must not roll back the user's work — but it is
 * logged loudly to stderr so a broken audit pipeline is visible in monitoring
 * rather than silently swallowing history.
 */
export async function writeAudit(
  ctx: Pick<TenantContext, "tenant" | "user" | "role" | "clerkUserId"> &
    Partial<Pick<TenantContext, "impersonationId">>,
  entry: AuditEntry,
): Promise<void> {
  try {
    const facts = await getRequestFacts();

    /**
     * ══════════════════════════════════════════════════════════════
     * ⭐ THE IMPERSONATION STAMP — v0.31.0
     * ══════════════════════════════════════════════════════════════
     * `audit_logs.impersonation_id` has existed since Phase 17 and
     * nothing wrote it, because nothing upstream knew. Now
     * `requireTenantContext()` resolves a live session into the
     * context, so this is the line that makes the whole thing
     * attributable.
     *
     * ⚠️ IT IS THE FLAG, NOT THE ACTOR. The actor columns already
     * name the real human — `getImpersonatedTenantContext()` refuses
     * to run without a named subject precisely so those columns are
     * never the customer's own user. This column answers the second
     * question, which is the one a reviewer actually asks: "was this
     * OUR staff, acting inside their workspace?"
     *
     * Both, not either. Attribution without the flag records that
     * priya@ourcompany.com updated a contact — true, and
     * indistinguishable from priya having been a customer employee.
     * The flag without attribution records that somebody was
     * impersonating and not who. A session that is not attributable
     * is worse than no session at all, because it looks accountable.
     *
     * ⚠️ `?? null` RATHER THAN OMISSION. Some callers pass a narrowed
     * `Pick<>` that predates this field; those actions are ordinary
     * tenant work and NULL is the honest value for them.
     */
    const impersonationId = ctx.impersonationId ?? null;

    /**
     * ══════════════════════════════════════════════════════════════
     * 🔴 THIS MUST RUN INSIDE `withTenant()`. IT DID NOT, UNTIL NOW.
     * ══════════════════════════════════════════════════════════════
     * `audit_logs` is under RLS with `ENABLE` + `FORCE` and a policy
     * whose WITH CHECK clause is `tenant_id = app_current_tenant_id()`.
     *
     * The plain `db` client carries NO tenant context, so
     * `app_current_tenant_id()` returns NULL, `tenant_id = NULL` is
     * never TRUE, and PostgreSQL rejects the INSERT:
     *
     *     ERROR: new row violates row-level security policy
     *            for table "audit_logs"
     *
     * The catch block below then swallowed it and logged to the
     * console — which on a serverless platform means it went into a
     * log nobody reads, once per audited action, forever.
     *
     * The result: EVERY AUDIT WRITE THROUGH THIS FUNCTION FAILED
     * SILENTLY, on any deployment where the application role is
     * subject to RLS. The table was empty. Nothing anywhere said so.
     *
     * It survived a security suite of 238 tests because those tests
     * insert audit rows as a SUPERUSER (which bypasses RLS entirely)
     * in order to then prove the append-only triggers work. They
     * proved the guard on a table nothing was writing to.
     *
     * Verified against PostgreSQL 16 on 31 July 2026:
     *     no tenant context   → RLS violation
     *     inside withTenant() → INSERT 0 1
     *
     * The fix is one wrapper. The lesson is that "the audit trail
     * works" was never actually tested end to end — only its
     * immutability was.
     */
    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx.insert(auditLogs).values({
          tenantId: ctx.tenant.id,
          actorUserId: ctx.user.id,
          actorClerkId: ctx.clerkUserId,
          actorEmail: ctx.user.email,
          actorRole: ctx.role,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          oldValue: entry.oldValue ?? null,
          newValue: entry.newValue ?? null,
          metadata: entry.metadata ?? {},
          severity: entry.severity ?? "info",
          reason: entry.reason ?? null,
          impersonationId,
          ipAddress: facts.ipAddress,
          userAgent: facts.userAgent,
          country: facts.country,
          requestId: facts.requestId,
        });
      },
      // ⚠️ The marker is set on the audit transaction too. It changes
      // nothing here — the DELETE guard only refuses DELETEs and this
      // is an INSERT — but a transaction that writes the evidence of an
      // impersonated action should not be the one place in the request
      // where the session is invisible to the database.
      { impersonationId },
    );
  } catch (err) {
    console.error("[AUDIT WRITE FAILED]", {
      tenantId: ctx.tenant.id,
      action: entry.action,
      resourceType: entry.resourceType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Audit write for background jobs, where there is no logged-in user. */
export async function writeSystemAudit(
  tenantId: string,
  entry: AuditEntry & { actorLabel?: string },
): Promise<void> {
  try {
    // Same RLS requirement as `writeAudit` above — see the block there.
    await withTenant(tenantId, async (tx) => {
      await tx.insert(auditLogs).values({
      tenantId,
      actorEmail: entry.actorLabel ?? "system",
      actorRole: "system",
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      metadata: entry.metadata ?? {},
      severity: entry.severity ?? "info",
      reason: entry.reason ?? null,
      });
    });
  } catch (err) {
    console.error("[SYSTEM AUDIT WRITE FAILED]", err);
  }
}

/* ------------------------------------------------------------------ */
/* PERMISSION ENFORCEMENT                                              */
/* ------------------------------------------------------------------ */

/**
 * Check whether the current user may perform an action.
 *
 * Returns the decision without throwing — use when you want to branch, e.g. to
 * hide a button. Denials are still recorded.
 *
 * @example
 *   const { allowed } = await checkPermission("periods:close");
 */
export async function checkPermission(
  permission: string,
  resource?: { type?: string; id?: string },
): Promise<PermissionDecision & { ctx: TenantContext }> {
  const ctx = await requireTenantContext();

  const decision = evaluatePermission(
    { role: ctx.role, overrides: ctx.user.permissionOverrides },
    permission,
  );

  if (!decision.allowed) {
    await recordDenial(ctx, decision, resource);
  }

  return { ...decision, ctx };
}

/**
 * Enforce a permission. Throws `PermissionDeniedError` if the user lacks it.
 *
 * This is the form to use at the top of a server action — it fails closed and
 * cannot be forgotten the way an `if` can.
 *
 * @example
 *   const ctx = await requirePermission("transactions:post");
 */
export async function requirePermission(
  permission: string,
  resource?: { type?: string; id?: string },
): Promise<TenantContext> {
  const result = await checkPermission(permission, resource);
  if (!result.allowed) {
    throw new PermissionDeniedError(result);
  }
  return result.ctx;
}

/** Require every listed permission. */
export async function requireAllPermissions(
  permissions: string[],
  resource?: { type?: string; id?: string },
): Promise<TenantContext> {
  let ctx: TenantContext | null = null;
  for (const permission of permissions) {
    ctx = await requirePermission(permission, resource);
  }
  if (!ctx) throw new Error("requireAllPermissions() called with an empty list.");
  return ctx;
}

/** Record a failed permission check. Best-effort; never blocks the response. */
async function recordDenial(
  ctx: TenantContext,
  decision: PermissionDecision,
  resource?: { type?: string; id?: string },
): Promise<void> {
  try {
    const facts = await getRequestFacts();

    await db.insert(permissionDenials).values({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      clerkUserId: ctx.clerkUserId,
      actorRole: ctx.role,
      permission: String(decision.permission),
      resourceType: resource?.type ?? null,
      resourceId: resource?.id ?? null,
      wasDangerous: decision.isDangerous,
      ipAddress: facts.ipAddress,
      userAgent: facts.userAgent,
      requestId: facts.requestId,
      metadata: { reason: decision.reason },
    });

    // A blocked attempt at a dangerous permission also lands in the main audit
    // trail as a security event — that is the record a reviewer actually reads.
    if (decision.isDangerous) {
      await writeAudit(ctx, {
        action: "security_event",
        resourceType: resource?.type ?? "permission",
        resourceId: resource?.id ?? null,
        metadata: {
          permission: decision.permission,
          reason: decision.reason,
          role: ctx.role,
        },
        reason: `Blocked attempt at a privileged action: ${decision.permission}`,
        severity: "warning",
      });
    }
  } catch (err) {
    console.error("[DENIAL RECORD FAILED]", err);
  }
}

/* ------------------------------------------------------------------ */
/* AUDIT READS                                                         */
/* ------------------------------------------------------------------ */

export type AuditLogRow = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  severity: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

/** Recent audit entries for this tenant. Requires `audit:read`. */
export async function getRecentAuditLogs(limit = 50): Promise<AuditLogRow[]> {
  const ctx = await requirePermission("audit:read");
  const { eq, desc } = await import("drizzle-orm");

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      actorEmail: auditLogs.actorEmail,
      actorRole: auditLogs.actorRole,
      severity: auditLogs.severity,
      reason: auditLogs.reason,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(eq(auditLogs.tenantId, ctx.tenant.id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(Math.max(1, limit), 200));

  return rows as AuditLogRow[];
}

/** Helper for building metadata payloads without stray `undefined` values. */
export function auditMeta(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

export { DANGEROUS_PERMISSIONS, isPermissionKey };
export type { PermissionKey };
