import "server-only";

/**
 * Ordence — What The WORKSPACE Sees And Can Do About Support Access
 * Version: v1.52.0-alpha (Batch 28)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY OTHER FILE IN `server/platform` IS WRITTEN FOR US. THIS ONE IS
 *    WRITTEN FOR THEM.
 * ══════════════════════════════════════════════════════════════════════
 * It runs on a CUSTOMER'S request, under the CUSTOMER'S tenant context,
 * and answers two questions they are entitled to have answered without
 * asking us:
 *
 *     "Is one of Ordence's staff inside my workspace right now?"
 *     "Can I make them leave?"
 *
 * ⚠️ NOTHING HERE USES `withPlatformScope()`, AND THAT IS THE DESIGN.
 * `platform_impersonation_sessions` carries the SHAPE B policy from
 * `0014_phase17_platform.sql`:
 *
 *     USING (app_current_tenant_id() IS NULL OR tenant_id = app_current_tenant_id())
 *
 * — so a workspace can read the record of every time we entered it, from
 * its own connection, with its own isolation intact. Reaching for the
 * platform scope here would have worked and would have been strictly
 * worse: it would mean the code that renders a customer's banner is code
 * that CAN read every other customer's sessions, and the only thing
 * stopping it would be a WHERE clause.
 *
 * ⚠️ THE ONE WRITE — ending a session — CANNOT go through tenant scope,
 * because the same policy's `WITH CHECK (app_current_tenant_id() IS NULL)`
 * refuses it. That is correct too: the session row is OUR evidence, and a
 * customer's connection must not be able to write to it. So the write is
 * performed by `endSessionForTenantOwner()` on the platform connection,
 * AFTER this file has proved the caller administers that exact workspace
 * and has pinned the update to that tenant id.
 */

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { auditLogs } from "@/db/schema";
import { platformImpersonationSessions } from "@/db/schema/platform";
import type { ImpersonationScope } from "@/db/schema/platform";
import {
  cappedExpiry,
  effectiveScope,
  isSessionLive,
  minutesRemaining,
  MODE_LABELS,
  SCOPE_LIFT_RESOURCE,
} from "@/lib/platform/impersonation-policy";
import { endSupportSessionSchema } from "@/lib/platform/schemas";
import type { ActionResult } from "@/lib/validators/crm";
import { requireTenantContext, requireRole, ADMIN_ROLES } from "@/server/tenant-context";
import {
  assertImpersonationAllows,
  endSessionForTenantOwner,
} from "./impersonation";

/**
 * What the workspace's banner needs. Deliberately small.
 *
 * ⚠️ NO IP ADDRESS, NO CLERK ID, NO STAFF ID, NO CONSENT ID. This object
 * is serialised into a page every user of the workspace loads, including
 * the ones with no admin rights. It carries the four facts the banner
 * exists to state — who, why, what they can do, how long left — and
 * nothing that would turn a transparency notice into an inventory of our
 * internal identifiers.
 */
export type SupportAccessNotice = {
  sessionId: string;
  /** The REAL human at Ordence. The whole point of the banner. */
  operatorEmail: string;
  /** The words, not the enum: "Standing consent", "BREAK-GLASS — no consent". */
  authority: string;
  mode: string;
  /** ⭐ EFFECTIVE scope — what they can do now, not what consent permits. */
  scope: ImpersonationScope;
  /** True once write access has been taken. Stated in words in the banner. */
  writeAccessTaken: boolean;
  /** Why they came in. Written by the operator when the session started. */
  reason: string;
  /** Why they took write access, if they did. */
  writeAccessReason: string | null;
  startedAt: string;
  /** ⚠️ THE CAPPED expiry, computed server-side from `started_at`. */
  expiresAt: string;
  minutesLeft: number;
};

/**
 * The live support session in this workspace, or null.
 *
 * ⚠️ CALLED ON EVERY CRM PAGE RENDER, so it is one query in the tenant's
 * own transaction plus one more only when a session exists. On the
 * overwhelmingly common path — nobody is inside — it is a single indexed
 * read against `impersonation_live_idx` that returns no rows.
 */
export async function activeSupportAccessForTenant(
  tenantId: string,
  now: Date = new Date(),
): Promise<SupportAccessNotice | null> {
  return withTenant(tenantId, async (tx) => {
    const [session] = await tx
      .select()
      .from(platformImpersonationSessions)
      .where(
        and(
          eq(platformImpersonationSessions.tenantId, tenantId),
          isNull(platformImpersonationSessions.endedAt),
          // Index-friendly prefilter only. The cap is applied below.
          gt(platformImpersonationSessions.expiresAt, now),
        ),
      )
      .orderBy(desc(platformImpersonationSessions.startedAt))
      .limit(1);

    if (!session) return null;

    // ⭐ THE SAME HARD CAP THE OPERATOR'S OWN PATH APPLIES, computed from
    // the same frozen `started_at`. If the two disagreed, one of the two
    // banners would be lying, and the customer's is the one that must not.
    if (!isSessionLive(session, now)) return null;

    /* ---- Did they take write access? ------------------------------ */
    //
    // ⭐ READ FROM THE CUSTOMER'S OWN AUDIT LOG. `liftImpersonationScope()`
    // writes the lift twice on purpose — once into the platform action
    // register, which is the authority the write gate consults, and once
    // here, tenant-attributed, which is what makes it visible to them.
    // This banner reads THEIR copy, from their own connection.
    //
    // ⚠️ IF THE TENANT-ATTRIBUTED COPY IS MISSING the banner understates:
    // it says read-only while the gate says read-write. That is the safe
    // direction for a display to be wrong in, and the row that decides
    // what the operator may actually do is the other one.
    const [lift] = await tx
      .select({ reason: auditLogs.reason })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          eq(auditLogs.resourceType, SCOPE_LIFT_RESOURCE),
          eq(auditLogs.resourceId, session.id),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);

    const scope = effectiveScope({ ceiling: session.scope, lifted: lift != null });

    return {
      sessionId: session.id,
      operatorEmail: session.actorEmail,
      authority: MODE_LABELS[session.mode],
      mode: session.mode,
      scope,
      writeAccessTaken: scope === "read_write",
      reason: session.justification,
      writeAccessReason: lift?.reason ?? null,
      startedAt: session.startedAt.toISOString(),
      expiresAt: cappedExpiry(session).toISOString(),
      minutesLeft: minutesRemaining(session, now),
    } satisfies SupportAccessNotice;
  });
}

/* ------------------------------------------------------------------ */
/* THE OWNER'S OWN CONTROL                                             */
/* ------------------------------------------------------------------ */

/**
 * End the support session in the caller's own workspace.
 *
 * ⭐ THE ARGUMENT FOR THIS BUTTON EXISTING AT ALL — including the case
 * against it, which is real — is written out at `endSessionForTenantOwner`
 * in `server/platform/impersonation.ts`. Read it before removing this.
 *
 * ⚠️ THE TENANT ID COMES FROM THE CALLER'S OWN CONTEXT, NEVER FROM THE
 * INPUT. `requireRole()` resolves the workspace from the Clerk session;
 * the session id in the payload is then matched against THAT tenant. An
 * owner of one workspace holding a session id from another closes
 * nothing, and gets the same sentence as somebody who guessed a uuid.
 */
export async function endSupportSession(input: unknown): Promise<ActionResult<void>> {
  const ctx = await requireRole(ADMIN_ROLES);

  /* ---- 🔴 AN IMPERSONATOR MAY NOT USE THE OWNER'S CONTROL --------- */
  //
  // `requireRole(ADMIN_ROLES)` is satisfied by an operator inside a
  // read-write session whose subject is an owner — the role ceiling
  // hands them the subject's own role, which is the whole point of it.
  // Without this refusal, an operator could end their own session
  // through this path and it would be filed as `revoked_by_tenant`:
  // a register entry that says the CUSTOMER asked us to leave when in
  // fact we chose to. That is a small lie in an important record, and
  // small lies in this particular record are the ones that matter.
  //
  // The operator's own exit is `stopImpersonation()`, which files
  // `operator_ended`. It is one click away in the same banner.
  if (ctx.impersonationId) {
    return {
      ok: false,
      error:
        "This control belongs to the workspace. End your own session with the " +
        "button in the support banner, which records that you chose to leave.",
    };
  }

  // Defence in depth: the deny-list already forbids an impersonated
  // session from touching the consent machinery, and this is the same
  // machinery viewed from the other side. Reached only if the check
  // above is ever removed.
  await assertImpersonationAllows("support:consent_session_end", ctx);

  const parsed = endSupportSessionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const closed = await endSessionForTenantOwner({
    sessionId: parsed.data.sessionId,
    tenantId: ctx.tenant.id,
    actorEmail: ctx.user.email,
    reason: parsed.data.reason || "No reason given.",
  });

  if (!closed) {
    // Never existed, already closed, or belongs to another workspace —
    // one sentence for all three, so this cannot be used to discover
    // which session ids are real.
    return { ok: false, error: "There is no support session to end." };
  }

  return { ok: true, data: undefined };
}

/**
 * ⚠️ Present so the CRM banner can ask "am I allowed to show the button"
 * without duplicating the role list in a component. The SERVER re-decides
 * inside `endSupportSession()`; this only decides what is polite to show.
 */
export async function canEndSupportSession(): Promise<boolean> {
  try {
    const ctx = await requireTenantContext();
    if (ctx.impersonationId) return false;
    return (ADMIN_ROLES as readonly string[]).includes(ctx.role);
  } catch {
    return false;
  }
}
