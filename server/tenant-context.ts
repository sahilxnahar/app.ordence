/**
 * Ordence — Authoritative Server-Side Tenant Context
 * Version: v0.1.0-alpha
 * Runtime: Node (server components, route handlers, server actions)
 *
 * Middleware decides which tenant is being *requested*. This module decides
 * whether that request is *legitimate* — it re-reads the Clerk session on the
 * server and resolves the real tenant row from the database.
 *
 * Defense in depth: even if middleware were bypassed entirely (misconfigured
 * matcher, direct invocation), nothing here trusts a header on its own.
 */

import "server-only";

import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { eq, and, isNull } from "drizzle-orm";
import { db, withPlatformScope, withTenant } from "@/db";
import { SENTRY_ENABLED } from "@/lib/observability/sentry-options";
import { tenants, users } from "@/db/schema";
import { TENANT_HEADERS } from "@/lib/tenant";
import { getImpersonatedTenantContext } from "@/server/platform/impersonation-context";
import type { SystemRole, Tenant, User } from "@/db/schema";
import type { ImpersonationScope } from "@/db/schema/platform";

export type TenantContext = {
  tenant: Tenant;
  user: User;
  clerkUserId: string;
  clerkOrgId: string;
  role: SystemRole;
  requestId: string;
  /**
   * ⭐ THE LIVE IMPERSONATION SESSION, OR NULL — v0.31.0.
   *
   * ⚠️ REQUIRED, NOT OPTIONAL, AND THAT IS THE POINT. Every consumer of
   * this type — `writeAudit()`, `withTenant()`, `assertImpersonationAllows()`
   * — has to answer "was this action taken while wearing somebody else's
   * face". An optional field lets a caller construct a context that
   * silently answers "no" by omission, which is the one wrong answer:
   * an action recorded as the customer's own, taken by our staff.
   *
   * `null` for every ordinary request, which is almost all of them.
   */
  impersonationId: string | null;
  /** The session's scope. Null when not impersonating. */
  impersonationScope: ImpersonationScope | null;
  /**
   * The REAL human behind an impersonated request — our staff member.
   * Null when not impersonating. `user` is the customer's user whose
   * view is being reproduced; this is who is actually typing.
   */
  operatorEmail: string | null;
};

export class TenantAccessError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unauthenticated"
      | "no_organization"
      | "tenant_not_found"
      | "tenant_inactive"
      | "user_not_provisioned"
      | "user_suspended"
      | "tenant_mismatch",
  ) {
    super(message);
    this.name = "TenantAccessError";
  }
}

/**
 * Resolve and verify the caller's tenant context.
 * Throws `TenantAccessError` rather than returning null so a forgotten check
 * fails closed instead of silently continuing with no tenant.
 */
export async function requireTenantContext(): Promise<TenantContext> {
  const { userId, orgId } = await auth();

  if (!userId) {
    throw new TenantAccessError("No authenticated session.", "unauthenticated");
  }

  const headerList = await headers();
  const requestId = headerList.get(TENANT_HEADERS.requestId) ?? crypto.randomUUID();

  /* --- ⭐ THE IMPERSONATION BRIDGE (Phase 29, wired in Phase 31) ---- */
  //
  // ══════════════════════════════════════════════════════════════════
  // THIS IS THE MOST DANGEROUS SIX LINES IN THE PRODUCT. READ THEM.
  // ══════════════════════════════════════════════════════════════════
  // A platform operator does not belong to the customer's Clerk
  // organisation, so `orgId` is absent for them and every CRM page
  // refused them — the console could start a consented session, show
  // the banner, email the customer and audit everything, and then the
  // operator still could not see a single screen.
  //
  // ⚠️ IT IS INSIDE `if (!orgId)`, AND THAT PLACEMENT IS THE CONTROL.
  // Reached only when the caller has NO organisation of their own,
  // this can never WIDEN an ordinary member's context — the one shape
  // of bug that would turn a support tool into a privilege escalation.
  // A customer's employee always has an org and never reaches here.
  //
  // ⚠️ `getImpersonatedTenantContext()` RETURNS NULL FOR EVERYBODY WHO
  // IS NOT PLATFORM STAFF WITH A LIVE SESSION. It re-reads liveness
  // from the database on every request (`now() < expires_at AND
  // ended_at IS NULL`), so ending a session takes effect on the very
  // next click — there is no cookie and nothing cached.
  //
  // ⚠️ THE CONTEXT IT RETURNS CARRIES `impersonationId`, and everything
  // downstream depends on that: `writeAudit()` stamps it,
  // `withTenant()` arms the database DELETE guard with it, and
  // `assertImpersonationAllows()` reads it to refuse the forbidden
  // operations. An impersonation session that resolved a tenant but
  // did NOT carry this id would be the worst outcome available —
  // access that looks accountable and is not.
  if (!orgId) {
    const impersonated = await getImpersonatedTenantContext(requestId);
    if (impersonated) return impersonated;
    throw new TenantAccessError("No active organization selected.", "no_organization");
  }

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE BOOTSTRAP READ, AND IT CANNOT BE TENANT-SCOPED
   * ══════════════════════════════════════════════════════════════════
   * Authoritative lookup: Clerk org id → tenant row. The header is never
   * the source.
   *
   * ⚠️ THIS RAN ON THE UNSCOPED CLIENT UNTIL v1.34.0. Under a database
   * role that does not bypass RLS, `app_current_tenant_id()` is NULL
   * here — there is no tenant yet, that is what this query is for — so
   * the `tenants` policy matched nothing and this returned undefined.
   * Every signed-in request in the product would have failed with
   * `tenant_not_found`, which reads as "your workspace is not
   * provisioned" and is the most misleading error the product can show.
   *
   * ⭐ PLATFORM SCOPE IS THE CORRECT ANSWER, not a workaround: resolving
   * which workspace a session belongs to is by definition a question no
   * single workspace can answer. The `tenants` policy admits platform
   * scope on USING and the read is by `clerk_org_id`, which the caller's
   * verified session supplies.
   */
  const tenantRow = await withPlatformScope(
    `Resolve the workspace for an authenticated session`,
    (tx) =>
      tx.query.tenants.findFirst({
        where: and(eq(tenants.clerkOrgId, orgId), isNull(tenants.deletedAt)),
      }),
  );

  if (!tenantRow) {
    throw new TenantAccessError("Workspace not provisioned.", "tenant_not_found");
  }
  if (tenantRow.status !== "active" && tenantRow.status !== "pending") {
    throw new TenantAccessError(
      `Workspace is ${tenantRow.status}.`,
      "tenant_inactive",
    );
  }

  // Cross-check the middleware-supplied header against the authoritative row.
  // A mismatch means something upstream is wrong — refuse rather than guess.
  const headerOrgId = headerList.get(TENANT_HEADERS.clerkOrgId);
  if (headerOrgId && headerOrgId !== orgId) {
    throw new TenantAccessError(
      "Tenant header does not match session organization.",
      "tenant_mismatch",
    );
  }

  /**
   * ⭐ AND THIS ONE IS TENANT-SCOPED, because by now the workspace IS
   * known. Reading the caller's own membership as that workspace is
   * exactly the check the policy exists to perform, so it runs under
   * the same isolation every later query in the request will.
   */
  const userRow = await withTenant(tenantRow.id, (tx) =>
    tx.query.users.findFirst({
      where: and(
        eq(users.clerkUserId, userId),
        eq(users.tenantId, tenantRow.id),
        isNull(users.deletedAt),
      ),
    }),
  );

  if (!userRow) {
    throw new TenantAccessError("User not provisioned in this workspace.", "user_not_provisioned");
  }
  if (userRow.status === "suspended" || userRow.status === "offboarded") {
    throw new TenantAccessError(`User is ${userRow.status}.`, "user_suspended");
  }

  /**
   * ⭐ TAG THE ERROR SCOPE WITH THE TENANT — v0.95.0.
   *
   * ⚠️ THIS IS WHAT TURNS "SOMETHING BROKE" INTO A FIX. An untagged
   * exception in a multi-tenant ERP tells you a code path failed; it does
   * not tell you whether one workspace has bad data or every workspace is
   * down, and those need opposite responses at opposite speeds.
   *
   * ⚠️ THE TENANT ID AND THE ROLE. NEVER THE NAME, THE EMAIL OR THE SLUG.
   * A uuid identifies a workspace to us and means nothing to anyone else;
   * a workspace NAME is a customer's identity, and it would sit in a
   * third party's database under someone else's retention policy. The
   * scrubber would strip an email anyway — this is about never putting
   * one there.
   *
   * ⚠️ FAILURE HERE IS SWALLOWED. Tagging is a convenience for whoever
   * debugs later; it must never be the reason a request fails now.
   */
  if (SENTRY_ENABLED) {
    void import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.setUser({ id: userRow.id });
        Sentry.setTags({
          tenant_id: tenantRow.id,
          role: userRow.role,
          plan: tenantRow.planTier ?? "unknown",
        });
      })
      .catch(() => {
        /* Monitoring must never break the request it is watching. */
      });
  }

  return {
    tenant: tenantRow,
    user: userRow,
    clerkUserId: userId,
    clerkOrgId: orgId,
    role: userRow.role,
    requestId,
    // ⚠️ Stated explicitly rather than left undefined. This is the
    // ordinary path — a customer's own employee acting as themselves —
    // and "not impersonating" is a fact worth writing down, not an
    // absence for a later reader to infer.
    impersonationId: null,
    impersonationScope: null,
    operatorEmail: null,
  };
}

/** Non-throwing variant for optional/marketing surfaces. */
export async function getTenantContext(): Promise<TenantContext | null> {
  try {
    return await requireTenantContext();
  } catch {
    return null;
  }
}

/**
 * ⭐ THE PAGE-LEVEL VARIANT — v0.67.0. USE THIS IN `page.tsx`, ALWAYS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FIXES: `/dashboard`, ref 2120306202
 * ══════════════════════════════════════════════════════════════════════
 * `app/(crm)/layout.tsx` calls `getTenantContext()` and, on null,
 * `redirect("/onboarding")`. Every page underneath it called
 * `requireTenantContext()`, which THROWS.
 *
 * Those two are not the same answer to the same question, and in the App
 * Router the layout and the page render CONCURRENTLY — neither one gets
 * to decide first. So a user whose Clerk organisation exists but whose
 * `tenants` row does not (which, before Session 4, was every user who had
 * ever signed up, because provisioning inserted an invalid `plan_tier`
 * and failed) hit a race between a redirect and an exception.
 *
 * When the exception won, the whole `(crm)` group was replaced by the
 * error boundary and a digest — a number that tells the person nothing,
 * on a screen with no way forward, for a condition that is not an error
 * at all. Their workspace simply is not provisioned yet.
 *
 * ⚠️ THE BUG WAS NOT IN THE DASHBOARD. It was in seven pages agreeing
 * with each other and disagreeing with their own layout. Fixing the
 * dashboard alone would have left six identical faults, each waiting for
 * whichever page an unprovisioned user happened to open first.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS REDIRECTS RATHER THAN RENDERING AN ERROR
 * ══════════════════════════════════════════════════════════════════════
 * Every `TenantAccessError` code describes a state the USER can act on —
 * sign in, pick an organisation, ask an admin to un-suspend them — or one
 * where showing them anything at all is wrong. None of them is a fault in
 * the code, and none should reach an error boundary. `/onboarding` is
 * where all of them lead, and it is the same destination the layout
 * already chose.
 *
 * ⚠️ THIS FUNCTION NEVER SWALLOWS A REAL ERROR. It re-throws anything
 * that is not a `TenantAccessError` — a database outage, a bug in a
 * query — because those genuinely are faults, the digest genuinely is
 * the right tool, and turning them into a redirect would hide an outage
 * behind an onboarding screen.
 *
 * ⚠️ `redirect()` WORKS BY THROWING, so it must not be called inside a
 * `try`. It is called after the catch has completed, deliberately.
 */
export async function requirePageContext(): Promise<TenantContext> {
  let ctx: TenantContext | null = null;
  let denied: TenantAccessError | null = null;

  try {
    ctx = await requireTenantContext();
  } catch (err) {
    if (err instanceof TenantAccessError) {
      denied = err;
    } else {
      // A real fault. The digest screen is correct for this, and hiding
      // it behind a redirect would make an outage look like onboarding.
      throw err;
    }
  }

  if (denied) {
    /*
     * ⚠️ TWO DESTINATIONS, MATCHING `app/(crm)/layout.tsx` EXACTLY.
     *
     * `unauthenticated` means there is no session at all — which happens
     * on every sign-out, because Clerk refreshes the current route before
     * navigating away. Sending that to `/onboarding` would make the
     * middleware redirect a SECOND time to `/sign-in`, and a two-hop
     * redirect chain on an RSC fetch is what the client router cannot
     * follow. It surfaces as a client-side exception thrown at the user
     * on their way out of the app.
     *
     * Everything else is a real session that has no usable workspace, and
     * `/onboarding` is public to a signed-in user, so it resolves in one
     * hop.
     *
     * ⚠️ IF YOU CHANGE THIS, CHANGE THE LAYOUT TOO. The two disagreeing
     * about where a failure goes is the entire bug class this function
     * exists to close — they render concurrently and neither one wins.
     */
    const { redirect } = await import("next/navigation");
    redirect(denied.code === "unauthenticated" ? "/sign-in" : "/onboarding");
  }

  // Unreachable when `denied` is set — `redirect()` never returns — but
  // TypeScript cannot know that across the dynamic import.
  return ctx as TenantContext;
}

/** Role gate. Throws unless the caller holds one of `allowed`. */
export async function requireRole(allowed: readonly SystemRole[]): Promise<TenantContext> {
  const ctx = await requireTenantContext();
  if (!allowed.includes(ctx.role)) {
    throw new TenantAccessError(
      `Requires one of: ${allowed.join(", ")}. Caller is ${ctx.role}.`,
      "tenant_mismatch",
    );
  }
  return ctx;
}

/** Convenience: roles permitted to change workspace configuration. */
export const ADMIN_ROLES = [
  "tenant_owner",
  "tenant_admin",
  "platform_super_admin",
] as const satisfies readonly SystemRole[];
