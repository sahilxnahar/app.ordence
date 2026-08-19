import "server-only";

/**
 * Ordence — Tenant-Side Support Consent
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONLY FILE IN `server/platform/**` THAT RUNS AS THE CUSTOMER
 * ══════════════════════════════════════════════════════════════════════
 * Everything else here authenticates a platform operator. This does the
 * opposite, and that inversion is the point: CONSENT THAT WE CAN WRITE IS
 * NOT CONSENT.
 *
 * So every function below goes through `requireTenantContext()` and
 * writes through `withTenant()`. The RLS policy on
 * `tenant_support_consents` backs it up independently — `WITH CHECK` is
 * `tenant_id = app_current_tenant_id()`, which the platform-scoped
 * connection (context NULL) can never satisfy. A platform operator
 * cannot insert a consent row even with direct database access through
 * the application role.
 *
 * ⚠️ IT LIVES HERE, NOT IN `server/actions/`, ONLY BECAUSE THIS PHASE
 * DOES NOT OWN THAT DIRECTORY. The thin `"use server"` wrapper the
 * settings page needs is INTEGRATION step 5 in the phase notes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHO MAY GRANT IT
 * ══════════════════════════════════════════════════════════════════════
 * Standing consent — owner only. It is a standing permission for an
 * outside organisation to enter, of the kind that belongs on a contract,
 * and it should be granted by whoever would sign one.
 *
 * Incident consent — owner or admin. It is scoped to one incident and
 * expires in an hour; requiring the owner would mean the person who can
 * say yes is asleep exactly when the person with the problem is not.
 */

import { and, eq, isNull, desc, gt } from "drizzle-orm";
import { headers } from "next/headers";
import { withTenant } from "@/db";
import { tenantSupportConsents } from "@/db/schema/platform";
import { requireTenantContext } from "@/server/tenant-context";
import { assertImpersonationAllows } from "./impersonation";
import {
  STANDING_CONSENT_DAYS,
  INCIDENT_CONSENT_MINUTES,
} from "@/lib/platform/impersonation-policy";
import {
  grantSupportConsentSchema,
  revokeSupportConsentSchema,
  type PlatformResult,
} from "@/lib/platform/schemas";

export type ConsentView = {
  id: string;
  mode: string;
  scope: string;
  grantedByEmail: string | null;
  grantedAt: string;
  expiresAt: string;
  reference: string | null;
  live: boolean;
};

/* ------------------------------------------------------------------ */
/* GRANT                                                               */
/* ------------------------------------------------------------------ */

export async function grantSupportConsent(
  input: unknown,
): Promise<PlatformResult<{ consentId: string; expiresAt: string }>> {
  const ctx = await requireTenantContext();

  /*
    ══════════════════════════════════════════════════════════════════
    ⭐⭐ THE CIRCULARITY GATE. DO NOT REMOVE THIS.
    ══════════════════════════════════════════════════════════════════
    Until v0.31.0 this file was protected by an accident of plumbing:
    a platform operator had no tenant context at all, so `withTenant()`
    could not be reached and the RLS `WITH CHECK` refused the insert.
    Wiring `getImpersonatedTenantContext()` into `requireTenantContext()`
    REMOVED that accident — an operator inside a live session now has a
    perfectly valid tenant context, and this insert would pass every
    database check there is.

    Which would make the consent model circular: our staff enter with
    the customer's one-hour permission, use that hour to write
    themselves a ninety-day standing permission, and the audit trail
    shows the workspace granting it.

    `support:consent` is on the forbidden list for exactly this. The
    gate is the whole defence now; nothing below it would refuse.
  */
  await assertImpersonationAllows("support:consent", ctx);

  const parsed = grantSupportConsentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { mode, scope, reference, note } = parsed.data;

  if (mode === "standing" && ctx.role !== "tenant_owner") {
    return {
      ok: false,
      error:
        "Only the workspace owner can give support standing access. An administrator " +
        "can grant access for a single incident instead.",
    };
  }
  if (mode === "incident" && ctx.role !== "tenant_owner" && ctx.role !== "tenant_admin") {
    return { ok: false, error: "Only an owner or administrator can grant support access." };
  }
  if (mode === "incident" && !reference) {
    return {
      ok: false,
      error: "Add the ticket or incident this is for.",
      fieldErrors: { reference: ["Required for incident access."] },
    };
  }

  const now = new Date();
  const expiresAt =
    mode === "standing"
      ? new Date(now.getTime() + STANDING_CONSENT_DAYS * 86_400_000)
      : new Date(now.getTime() + INCIDENT_CONSENT_MINUTES * 60_000);

  const facts = await requestFacts();

  const rows = await withTenant(ctx.tenant.id, async (tx) => {
    // Supersede any live consent of the same kind rather than stacking
    // them. Two live standing grants with different scopes is a question
    // with no correct answer, and the answer that gets picked is
    // whichever row sorted first.
    await tx
      .update(tenantSupportConsents)
      .set({ revokedAt: now, revokedByUserId: ctx.user.id })
      .where(
        and(
          eq(tenantSupportConsents.tenantId, ctx.tenant.id),
          eq(tenantSupportConsents.mode, mode),
          isNull(tenantSupportConsents.revokedAt),
        ),
      );

    return tx
      .insert(tenantSupportConsents)
      .values({
        tenantId: ctx.tenant.id,
        mode,
        scope,
        grantedByUserId: ctx.user.id,
        grantedByEmail: ctx.user.email,
        grantedByRole: ctx.role,
        grantedAt: now,
        expiresAt,
        reference: reference ?? null,
        note: note ?? null,
        ipAddress: facts.ipAddress,
        userAgent: facts.userAgent,
      })
      .returning({ id: tenantSupportConsents.id });
  });

  const created = rows[0];
  if (!created) return { ok: false, error: "Could not record consent." };

  return {
    ok: true,
    data: { consentId: created.id, expiresAt: expiresAt.toISOString() },
  };
}

/* ------------------------------------------------------------------ */
/* REVOKE                                                              */
/* ------------------------------------------------------------------ */

/**
 * Revoking consent does NOT end a session that is already running.
 *
 * That is a deliberate choice and it is worth stating because the
 * opposite is the obvious expectation. Ending a live session from here
 * would need a cross-tenant write into
 * `platform_impersonation_sessions`, from a TENANT'S connection — which
 * the RLS policy correctly refuses, and which would be a strange hole to
 * open: a tenant able to write to the platform's evidence table.
 *
 * What revocation does is immediate and sufficient: no NEW session can
 * start, because consent is re-read from the database at start time. The
 * running session expires within the hour on its own, and the customer
 * can see it and its end time in their own audit log.
 */
export async function revokeSupportConsent(input: unknown): Promise<PlatformResult<void>> {
  const ctx = await requireTenantContext();
  // ⚠️ REVOKING IS GATED TOO, and it is not symmetry for its own sake.
  // An operator who could revoke could clear the record of the consent
  // they entered under — leaving a session whose authority no longer
  // appears anywhere. Withdrawal of consent belongs to the customer as
  // much as granting it does.
  await assertImpersonationAllows("support:consent_revoke", ctx);
  if (ctx.role !== "tenant_owner" && ctx.role !== "tenant_admin") {
    return { ok: false, error: "Only an owner or administrator can change support access." };
  }

  const parsed = revokeSupportConsentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid consent record." };

  await withTenant(ctx.tenant.id, async (tx) => {
    await tx
      .update(tenantSupportConsents)
      .set({ revokedAt: new Date(), revokedByUserId: ctx.user.id })
      .where(
        and(
          eq(tenantSupportConsents.id, parsed.data.consentId),
          eq(tenantSupportConsents.tenantId, ctx.tenant.id),
          isNull(tenantSupportConsents.revokedAt),
        ),
      );
  });

  return { ok: true, data: undefined };
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

/**
 * What the customer sees in their own settings.
 *
 * Every tenant user may read this, not only admins. "Can Ordence staff get
 * into our workspace?" is a question anybody in the workspace is entitled
 * to have answered, and hiding the answer behind an admin role is how a
 * customer's engineer finds out from a support ticket instead.
 */
export async function getSupportConsentState(): Promise<PlatformResult<ConsentView[]>> {
  const ctx = await requireTenantContext();
  const now = new Date();

  const rows = await withTenant(ctx.tenant.id, async (tx) =>
    tx
      .select()
      .from(tenantSupportConsents)
      .where(eq(tenantSupportConsents.tenantId, ctx.tenant.id))
      .orderBy(desc(tenantSupportConsents.grantedAt))
      .limit(20),
  );

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      mode: r.mode,
      scope: r.scope,
      grantedByEmail: r.grantedByEmail,
      grantedAt: r.grantedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      reference: r.reference,
      live: r.revokedAt === null && r.expiresAt.getTime() > now.getTime(),
    })),
  };
}

/** Live consent for a tenant, used by the console to show what is possible. */
export async function hasLiveConsent(tenantId: string): Promise<boolean> {
  const now = new Date();
  try {
    const rows = await withTenant(tenantId, async (tx) =>
      tx
        .select({ id: tenantSupportConsents.id })
        .from(tenantSupportConsents)
        .where(
          and(
            eq(tenantSupportConsents.tenantId, tenantId),
            isNull(tenantSupportConsents.revokedAt),
            gt(tenantSupportConsents.expiresAt, now),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  } catch {
    // Fails CLOSED: unknown consent is no consent.
    return false;
  }
}

async function requestFacts(): Promise<{
  ipAddress: string | null;
  userAgent: string | null;
}> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for");
    return {
      ipAddress: forwarded?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
    };
  } catch {
    return { ipAddress: null, userAgent: null };
  }
}
