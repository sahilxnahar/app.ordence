"use server";

/**
 * Ordence — Portal Link Management
 * Version: v0.9.0-alpha
 *
 * Internal actions for issuing, listing and revoking external portal links.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ISSUING A LINK IS A PRIVILEGED ACT, AND A SIGNING LINK MORE SO
 * ══════════════════════════════════════════════════════════════════════
 * Creating a portal link takes a document that lives behind Clerk, RLS and
 * a permission system, and makes it readable by anyone holding a URL. That
 * is not a neutral operation, so it requires `contracts:update`.
 *
 * Creating a link that can SIGN requires `contracts:approve` instead —
 * strictly more. The reasoning is the same separation of duties that lets
 * an Accountant post entries but not close a period: sharing a draft for
 * comment and delegating the authority to execute an agreement are
 * different jobs, and someone who cannot approve a contract internally
 * should not be able to hand that power to an outsider.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TOKEN IS RETURNED EXACTLY ONCE
 * ══════════════════════════════════════════════════════════════════════
 * Only the SHA-256 hash is stored, so the raw token cannot be recovered
 * later — not by us, not by a database leak, not by a rogue admin.
 *
 * `createPortalLink` returns the full URL in its response, and that is the
 * only moment it exists outside the recipient's inbox. Staff who need the
 * link again regenerate it, which invalidates the old one. That is a real
 * cost in convenience and it buys the property that a stolen backup
 * contains no working credentials.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { portalLinks, contracts, assets } from "@/db/schema";
import { requirePermission, writeAudit, auditMeta } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { recordPortalLinkCreated } from "@/server/metering/record";
import { PermissionDeniedError } from "@/lib/permissions";
import { generatePortalToken, buildPortalUrl, maskToken } from "@/lib/portal/tokens";
import { sendContractReadyEmail, isEmailEnabled } from "@/lib/email/resend";
import {
  createPortalLinkSchema,
  revokePortalLinkSchema,
  MAX_EXPIRY_DAYS,
} from "@/lib/validators/portal";
import type { ActionResult } from "@/lib/validators/crm";
import type {
  CreatePortalLinkInput,
  RevokePortalLinkInput,
  PortalEntityTypeInput,
} from "@/lib/validators/portal";

export type { CreatePortalLinkInput, RevokePortalLinkInput };

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  // A read-only workspace is an account-standing answer with its own
  // remedy. It must not surface as a generic failure — and it must not
  // be confused with a permission or plan problem.
  if (err instanceof AccessRestrictedError) return fail(err.message);
  // A locked feature is a commercial answer, not a fault. It must
  // never surface as "something went wrong" — the customer can act
  // on "upgrade to Advanced" and cannot act on a generic error.
  if (err instanceof FeatureLockedError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof ImpersonationForbiddenError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[portal action]", err);
  return fail("Something went wrong. Please try again.");
}

/** Format a decimal money string for display. Never a float. */
function formatMoney(value: string | null, currency: string): string | null {
  if (!value) return null;
  const [whole = "0", fraction = "00"] = String(value).split(".");
  const withSeparators = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${withSeparators}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

/* ------------------------------------------------------------------ */
/* PARENT OWNERSHIP                                                    */
/* ------------------------------------------------------------------ */

/**
 * Confirm the record a link points at exists AND belongs to this tenant.
 *
 * Like `documents`, the `(entity_type, entity_id)` link is polymorphic and
 * cannot be backed by a foreign key — PostgreSQL does not know which table
 * to look in. And existence alone would not be enough even with one: a
 * foreign key proves a row EXISTS, not that it is YOURS. Tenant B passing
 * tenant A's contract id would satisfy `EXISTS` perfectly, and the result
 * would be a live external link to another tenant's agreement.
 */
async function loadOwnedEntity(
  entityType: PortalEntityTypeInput,
  entityId: string,
  tenantId: string,
): Promise<
  | { kind: "contract"; row: typeof contracts.$inferSelect }
  | { kind: "asset"; row: typeof assets.$inferSelect }
  | null
> {
  if (entityType === "contract") {
    const row = await db.query.contracts.findFirst({
      where: and(
        eq(contracts.id, entityId),
        eq(contracts.tenantId, tenantId),
        isNull(contracts.deletedAt),
      ),
    });
    return row ? { kind: "contract", row } : null;
  }

  const row = await db.query.assets.findFirst({
    where: and(
      eq(assets.id, entityId),
      eq(assets.tenantId, tenantId),
      isNull(assets.deletedAt),
    ),
  });
  return row ? { kind: "asset", row } : null;
}

/* ------------------------------------------------------------------ */
/* CREATE                                                              */
/* ------------------------------------------------------------------ */

export type CreatedPortalLink = {
  id: string;
  /** The full URL. Shown once and never recoverable afterwards. */
  url: string;
  tokenPrefix: string;
  expiresAt: string;
  permission: string;
  emailSent: boolean;
  emailError: string | null;
};

export async function createPortalLink(
  input: CreatePortalLinkInput,
): Promise<ActionResult<CreatedPortalLink>> {
  try {
    const data = createPortalLinkSchema.parse(input);

    // ════════════════════════════════════════════════════════════════
    // SEPARATION OF DUTIES.
    // A signing link delegates the authority to execute an agreement, so
    // it demands `contracts:approve`. A view link only exposes it for
    // reading, so `contracts:update` is enough.
    // ════════════════════════════════════════════════════════════════
    const requiredPermission =
      data.permission === "view_and_sign" ? "contracts:approve" : "contracts:update";

    const ctx = await requirePermission(requiredPermission, {
      type: data.entityType,
      id: data.entityId,
    });
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("portal:create", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("portal.external_links", ctx);
    /*
      ⭐ A PORTAL LINK IS A BEARER CREDENTIAL.
      It works for whoever holds it, from anywhere, after the session
      has expired, with no sign-in. Issuing one under impersonation is
      an export of the customer's contract to an address of our
      choosing — and it would still be working next week.
    */
    await assertImpersonationAllows("portal:create", ctx);

    const entity = await loadOwnedEntity(data.entityType, data.entityId, ctx.tenant.id);
    if (!entity) {
      return fail("That record could not be found in this workspace.");
    }

    // An asset cannot be signed — there is nothing to execute. Refusing
    // here rather than rendering a signing portal that cannot work.
    if (entity.kind === "asset" && data.permission === "view_and_sign") {
      return fail("Only contracts can be signed. Share this asset as view-only.");
    }

    // A contract under legal hold must not gain new external exposure. The
    // point of a hold is that the position is frozen.
    if (entity.kind === "contract" && entity.row.legalHold) {
      return fail(
        "This contract is under legal hold. New client links cannot be issued while a hold is in force.",
      );
    }

    // Already executed contracts are shareable, but not signable again.
    if (
      entity.kind === "contract" &&
      data.permission === "view_and_sign" &&
      ["signed", "executed", "terminated", "cancelled", "expired"].includes(
        entity.row.status,
      )
    ) {
      return fail(
        `This contract is already ${entity.row.status.replace(/_/g, " ")} and cannot be signed again. Share it as view-only.`,
      );
    }

    // ---- Mint the credential ---------------------------------------
    const { token, tokenHash, tokenPrefix } = generatePortalToken();

    const expiresAt = new Date(Date.now() + data.expiresInDays * 86_400_000);

    // Belt and braces: the database also enforces a 180-day ceiling with a
    // CHECK constraint, so this bound cannot be bypassed by calling the
    // action with a crafted payload.
    if (data.expiresInDays > MAX_EXPIRY_DAYS) {
      return fail(`A link cannot last longer than ${MAX_EXPIRY_DAYS} days.`);
    }

    const [created] = await db
      .insert(portalLinks)
      .values({
        // From the session. Never from `input`.
        tenantId: ctx.tenant.id,
        entityType: data.entityType,
        entityId: data.entityId,
        tokenHash,
        tokenPrefix,
        expiresAt,
        permission: data.permission,
        recipientEmail: data.recipientEmail ?? null,
        recipientName: data.recipientName ?? null,
        createdBy: ctx.user.id,
      })
      .returning();

    if (!created) return fail("Could not create the link.");

    const url = buildPortalUrl(token);

    // ---- Optionally email it ---------------------------------------
    let emailSent = false;
    let emailError: string | null = null;

    if (data.sendEmail) {
      if (!data.recipientEmail) {
        emailError = "No recipient address was supplied, so no email was sent.";
      } else if (!isEmailEnabled()) {
        emailError = "Email is not configured for this deployment.";
      } else if (entity.kind !== "contract") {
        emailError = "Email dispatch is only available for contracts.";
      } else {
        const result = await sendContractReadyEmail({
          to: data.recipientEmail,
          contractId: entity.row.id,
          props: {
            recipientName: data.recipientName ?? "Sir or Madam",
            organizationName: ctx.tenant.name,
            contractTitle: entity.row.title,
            contractNumber: entity.row.contractNumber,
            contractType: entity.row.contractType.replace(/_/g, " "),
            contractValue: formatMoney(entity.row.value, entity.row.currency),
            effectiveDate: entity.row.effectiveDate
              ? String(entity.row.effectiveDate)
              : null,
            // ⭐ THE SECURE PORTAL URL, not an internal app route.
            // The recipient has no Clerk account; a link to /contracts/<id>
            // would bounce them to a sign-in page they can never pass.
            reviewUrl: url,
            portalExpiresAt: expiresAt.toISOString().slice(0, 10),
            canSign: data.permission === "view_and_sign",
            message: data.message ?? null,
            senderName:
              [ctx.user.firstName, ctx.user.lastName].filter(Boolean).join(" ").trim() ||
              null,
          },
        });

        emailSent = result.ok;
        if (!result.ok) emailError = result.message;
      }
    }

    // ---- Audit ------------------------------------------------------
    // Issuing external access is a notable event. A signing link is more
    // than notable — it delegates the power to bind the counterparty.
    //
    // NOTE the token itself is NEVER logged, only its prefix. An audit log
    // containing live credentials would be a worse leak than the thing it
    // was written to protect against.
    // Metered AFTER creation and best-effort: a counter that could
    // fail the operation would mean a customer cannot send a contract
    // because bookkeeping had a bad moment.
    await recordPortalLinkCreated(ctx.tenant.id);

    await writeAudit(ctx, {
      action: "create",
      resourceType: "portal_link",
      resourceId: created.id,
      severity: data.permission === "view_and_sign" ? "warning" : "notice",
      metadata: auditMeta({
        event: "portal_link_created",
        entityType: data.entityType,
        entityId: data.entityId,
        permission: data.permission,
        tokenPrefix,
        maskedToken: maskToken(token),
        expiresAt: expiresAt.toISOString(),
        recipientEmail: data.recipientEmail ?? null,
        emailSent,
      }),
    });

    revalidatePath(`/contracts/${data.entityId}`);

    return {
      ok: true,
      data: {
        id: created.id,
        url,
        tokenPrefix,
        expiresAt: expiresAt.toISOString(),
        permission: created.permission,
        emailSent,
        emailError,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* LIST                                                                */
/* ------------------------------------------------------------------ */

export type PortalLinkListItem = {
  id: string;
  tokenPrefix: string;
  permission: string;
  isActive: boolean;
  expiresAt: string;
  createdAt: string;
  recipientEmail: string | null;
  recipientName: string | null;
  viewCount: number;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  signedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
};

export async function getPortalLinks(input: {
  entityType: PortalEntityTypeInput;
  entityId: string;
}): Promise<ActionResult<PortalLinkListItem[]>> {
  try {
    const ctx = await requirePermission("contracts:read");

    const params = z
      .object({
        entityType: z.enum(["contract", "asset"]),
        entityId: z.string().uuid("Invalid record identifier."),
      })
      .parse(input);

    const rows = await db
      .select({
        id: portalLinks.id,
        tokenPrefix: portalLinks.tokenPrefix,
        permission: portalLinks.permission,
        isActive: portalLinks.isActive,
        expiresAt: portalLinks.expiresAt,
        createdAt: portalLinks.createdAt,
        recipientEmail: portalLinks.recipientEmail,
        recipientName: portalLinks.recipientName,
        viewCount: portalLinks.viewCount,
        firstViewedAt: portalLinks.firstViewedAt,
        lastViewedAt: portalLinks.lastViewedAt,
        signedAt: portalLinks.signedAt,
        revokedAt: portalLinks.revokedAt,
        revokedReason: portalLinks.revokedReason,
      })
      .from(portalLinks)
      .where(
        and(
          // Tenant predicate first. RLS enforces it independently.
          eq(portalLinks.tenantId, ctx.tenant.id),
          eq(portalLinks.entityType, params.entityType),
          eq(portalLinks.entityId, params.entityId),
        ),
      )
      .orderBy(desc(portalLinks.createdAt))
      .limit(200);

    // NOTE: `tokenHash` is deliberately absent from the projection above.
    // It is not a usable credential, but there is no reason for it to
    // travel to a browser, and a column that never leaves the server
    // cannot be leaked by a future component that logs its props.
    return {
      ok: true,
      data: rows.map((r) => ({
        ...r,
        expiresAt: new Date(r.expiresAt).toISOString(),
        createdAt: new Date(r.createdAt).toISOString(),
        firstViewedAt: r.firstViewedAt ? new Date(r.firstViewedAt).toISOString() : null,
        lastViewedAt: r.lastViewedAt ? new Date(r.lastViewedAt).toISOString() : null,
        signedAt: r.signedAt ? new Date(r.signedAt).toISOString() : null,
        revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
      })),
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* REVOKE                                                              */
/* ------------------------------------------------------------------ */

/**
 * Kill a link immediately.
 *
 * Revocation is the only remedy available once a link has left the
 * building — it cannot be un-emailed, un-forwarded or un-screenshotted.
 * So it takes effect on the very next request: `is_active` is read fresh
 * on every portal load and is never cached.
 *
 * The row is kept, not deleted. "This link existed, was used twice, and
 * was revoked on Tuesday by Anita" is exactly the history that gets asked
 * for later; deleting it would erase the reason anyone would look.
 */
export async function revokePortalLink(
  input: RevokePortalLinkInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission("contracts:update", { type: "portal_link" });
    const data = revokePortalLinkSchema.parse(input);

    const existing = await db.query.portalLinks.findFirst({
      where: and(
        eq(portalLinks.id, data.linkId),
        eq(portalLinks.tenantId, ctx.tenant.id),
      ),
    });

    if (!existing) return fail("Link not found.");

    if (!existing.isActive) {
      // Not an error worth alarming anyone about — the desired end state
      // already holds. Reporting failure here would push people to click
      // again, wondering what went wrong.
      return { ok: true, data: { id: existing.id } };
    }

    const [revoked] = await db
      .update(portalLinks)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedBy: ctx.user.id,
        revokedReason: data.reason ?? null,
      })
      .where(
        and(eq(portalLinks.id, data.linkId), eq(portalLinks.tenantId, ctx.tenant.id)),
      )
      .returning({ id: portalLinks.id });

    if (!revoked) return fail("Link not found.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "portal_link",
      resourceId: data.linkId,
      severity: "notice",
      metadata: auditMeta({
        event: "portal_link_revoked",
        tokenPrefix: existing.tokenPrefix,
        entityType: existing.entityType,
        entityId: existing.entityId,
        reason: data.reason ?? null,
      }),
    });

    revalidatePath(`/contracts/${existing.entityId}`);
    return { ok: true, data: { id: revoked.id } };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Revoke every active link for a record, in one action.
 *
 * The button people reach for when something has gone wrong and they do
 * not want to work out which of six links was the problem. Under pressure,
 * "revoke everything" needs to be one click.
 */
export async function revokeAllPortalLinks(input: {
  entityType: PortalEntityTypeInput;
  entityId: string;
  reason?: string;
}): Promise<ActionResult<{ revokedCount: number }>> {
  try {
    const ctx = await requirePermission("contracts:update", { type: "portal_link" });

    const params = z
      .object({
        entityType: z.enum(["contract", "asset"]),
        entityId: z.string().uuid("Invalid record identifier."),
        reason: z.string().trim().max(500).optional(),
      })
      .parse(input);

    const revoked = await db
      .update(portalLinks)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedBy: ctx.user.id,
        revokedReason: params.reason ?? "Bulk revocation",
      })
      .where(
        and(
          eq(portalLinks.tenantId, ctx.tenant.id),
          eq(portalLinks.entityType, params.entityType),
          eq(portalLinks.entityId, params.entityId),
          eq(portalLinks.isActive, true),
        ),
      )
      .returning({ id: portalLinks.id });

    if (revoked.length > 0) {
      await writeAudit(ctx, {
        action: "update",
        resourceType: "portal_link",
        resourceId: params.entityId,
        severity: "warning",
        metadata: auditMeta({
          event: "portal_links_bulk_revoked",
          entityType: params.entityType,
          entityId: params.entityId,
          revokedCount: revoked.length,
          reason: params.reason ?? null,
        }),
      });
    }

    revalidatePath(`/contracts/${params.entityId}`);
    return { ok: true, data: { revokedCount: revoked.length } };
  } catch (err) {
    return toActionError(err);
  }
}
