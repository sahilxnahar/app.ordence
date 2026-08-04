import "server-only";

/**
 * Ordence — The Bridge From An Impersonation Session Into A Tenant Context
 * Version: v0.29.0-alpha (Phase 29)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHY IT IS NOT WIRED UP YET
 * ══════════════════════════════════════════════════════════════════════
 * Everything else in the console works today. This is the one piece that
 * needs a change in a file Phase 29 does not own — `server/tenant-context.ts`
 * — so it ships as a READY-MADE FUNCTION with the six-line edit written
 * out in `docs/PHASE-29-DEPLOYMENT.md`, rather than as a description of
 * what somebody should write.
 *
 * Until that edit lands, an operator can start a consented session, see
 * the banner, and have every action they take audited — but the CRM pages
 * will still refuse them, because `requireTenantContext()` resolves a
 * tenant from the caller's Clerk ORGANISATION and a platform operator is
 * not a member of the customer's organisation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ FOUR RULES THIS FUNCTION OBEYS. EACH ONE IS A REFUSAL.
 * ══════════════════════════════════════════════════════════════════════
 *   1. IT RETURNS NULL FOR EVERY ORDINARY REQUEST. It reads a session for
 *      THIS Clerk user and finds none for a customer's employee, so the
 *      existing path is untouched. A bridge that could widen an ordinary
 *      user's context would be a privilege escalation with a friendly
 *      name.
 *
 *   2. IT REFUSES WITHOUT A NAMED SUBJECT. `TenantContext` carries a real
 *      `user` row, which is what `writeAudit()` stamps and what every
 *      permission check reads. There is no synthetic user to substitute,
 *      and borrowing the workspace OWNER'S row would attribute our
 *      actions to the customer — the single worst thing an audit trail
 *      can do. So the operator picks whose view they are reproducing when
 *      they start the session, or they do not get in.
 *
 *   3. THE ROLE IS THE LOWER OF THE SESSION SCOPE AND THE SUBJECT'S OWN
 *      ROLE. A read-only session is `read_only` whatever the subject can
 *      do. A read-write session cannot exceed what the person whose view
 *      is being reproduced could do themselves — impersonating a viewer
 *      must not grant an operator more than the viewer has.
 *
 *   4. IT CARRIES `impersonationId`, so `writeAudit()` can stamp it and
 *      `withTenant(..., { impersonationId })` can arm the database DELETE
 *      guard. An action attributed to the real human but NOT FLAGGED as
 *      impersonated is an action a reviewer cannot tell apart from the
 *      customer's own.
 */

import { and, eq, isNull } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { tenants, users } from "@/db/schema";
import type { SystemRole, Tenant, User } from "@/db/schema";
import type { ImpersonationScope } from "@/db/schema/platform";
import { getActiveImpersonation } from "./impersonation";

/**
 * Shaped to be assignable to `TenantContext` in `server/tenant-context.ts`,
 * plus the two impersonation fields. Declared structurally rather than by
 * importing the type so this module does not create an import cycle with
 * the file that will import it.
 */
export type ImpersonatedTenantContext = {
  tenant: Tenant;
  user: User;
  clerkUserId: string;
  clerkOrgId: string;
  role: SystemRole;
  requestId: string;
  /** The session id. Stamp it on every audit row and every transaction. */
  impersonationId: string;
  impersonationScope: ImpersonationScope;
  /** The REAL human. Never the customer's user. */
  operatorEmail: string;
};

/**
 * Read-only means read-only, whatever the subject could do.
 *
 * ⚠️ This is a CEILING, not a mapping. It can only ever lower a role.
 * The write path is additionally refused by the impersonation deny-list
 * (`assertImpersonationAllows`) and, for deletions, by the database
 * trigger armed by `app.impersonation_id` — three independent layers,
 * because this one is the layer a refactor could quietly remove.
 */
function ceilingRole(scope: ImpersonationScope, subjectRole: SystemRole): SystemRole {
  if (scope === "read_only") return "read_only";
  // `platform_super_admin` inside a customer's workspace is a seat-billing
  // marker, not an authority. An operator reproducing that user's view is
  // capped at the ordinary member level rather than inheriting a role
  // whose name suggests more than it means.
  if (subjectRole === "platform_super_admin") return "member";
  return subjectRole;
}

/**
 * The caller's live impersonation, as a tenant context — or null.
 *
 * NEVER THROWS for an ordinary caller: `getActiveImpersonation()` demands
 * platform staff and this swallows that refusal, because the overwhelming
 * majority of requests are customers' employees and their path must not
 * be slowed or broken by a lookup that will always come back empty.
 */
export async function getImpersonatedTenantContext(
  requestId: string,
): Promise<ImpersonatedTenantContext | null> {
  let active: Awaited<ReturnType<typeof getActiveImpersonation>> = null;
  try {
    active = await getActiveImpersonation();
  } catch {
    // Not platform staff at all. The common case, and not an error.
    return null;
  }
  if (!active) return null;

  // Rule 2. Without a subject there is no user row to act as, and
  // borrowing somebody else's would falsify the audit trail.
  const session = await withPlatformScope(
    `Platform console: resolve tenant context for impersonation session ${active.sessionId}`,
    async (db) => {
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(and(eq(tenants.id, active!.tenantId), isNull(tenants.deletedAt)))
        .limit(1);

      if (!tenant) return null;

      // The same refusal `requireTenantContext()` applies to a customer:
      // an archived or suspended workspace is not enterable, and the
      // console must not be the one door that ignores that.
      if (tenant.status !== "active" && tenant.status !== "pending") return null;

      return { tenant };
    },
  );

  if (!session) return null;

  const subjectUserId = await subjectFor(active.sessionId);
  if (!subjectUserId) return null;

  const subject = await withPlatformScope(
    `Platform console: resolve the impersonation subject for session ${active.sessionId}`,
    async (db) => {
      const [user] = await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.id, subjectUserId),
            eq(users.tenantId, active!.tenantId),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      return user ?? null;
    },
  );

  // A suspended or offboarded subject is refused for exactly the reason a
  // suspended customer is: reproducing the view of an account that is not
  // allowed to sign in would be reproducing a view that does not exist.
  if (!subject || subject.status === "suspended" || subject.status === "offboarded") {
    return null;
  }

  return {
    tenant: session.tenant,
    user: subject,
    clerkUserId: subject.clerkUserId,
    clerkOrgId: session.tenant.clerkOrgId,
    role: ceilingRole(active.scope, subject.role),
    requestId,
    impersonationId: active.sessionId,
    impersonationScope: active.scope,
    operatorEmail: active.actorEmail,
  };
}

/**
 * The subject recorded on the session.
 *
 * Read separately and from the evidence row itself — never from anything
 * the client sent. The column is frozen by the tamper trigger, so the
 * answer cannot have changed since the session started.
 */
async function subjectFor(sessionId: string): Promise<string | null> {
  const { platformImpersonationSessions } = await import("@/db/schema/platform");
  return withPlatformScope(
    `Platform console: read the recorded subject of impersonation session ${sessionId}`,
    async (db) => {
      const [row] = await db
        .select({ subjectUserId: platformImpersonationSessions.subjectUserId })
        .from(platformImpersonationSessions)
        .where(eq(platformImpersonationSessions.id, sessionId))
        .limit(1);
      return row?.subjectUserId ?? null;
    },
  );
}
