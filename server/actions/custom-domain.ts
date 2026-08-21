"use server";

/**
 * Ordence — Custom domains
 * Version: v1.94.0-alpha (Wave 3B)
 *
 * The first writer of `tenants.custom_domain_verified_at`, and the
 * reason `requireTenantContext` can now refuse an unverified hostname
 * instead of serving a workspace under any name that resolves to us.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ORDER OF OPERATIONS IS THE SECURITY PROPERTY
 * ══════════════════════════════════════════════════════════════════════
 *   1. `setCustomDomain` records a CLAIM. It always clears
 *      `custom_domain_verified_at`, including when the domain is
 *      unchanged. A claim is not a proof, and a path where setting the
 *      column left a stale timestamp behind would hand an attacker the
 *      verified state for free.
 *   2. `verifyCustomDomain` reads DNS and sets the timestamp only on a
 *      matching TXT record.
 *   3. `removeCustomDomain` clears both, together.
 *
 * There is no branch anywhere that sets the timestamp without the DNS
 * check, and no branch that sets the domain without clearing it.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, ne } from "drizzle-orm";
import { withTenant, withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import { requirePermission, writeAudit, auditMeta } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  checkDomainChallenge,
  domainChallengeRecord,
  validateClaimableDomain,
  DomainVerificationUnavailableError,
} from "@/lib/domains/verification";
import { normaliseHostname } from "@/lib/tenant";
import type { ActionResult } from "@/lib/validators/crm";

export type CustomDomainState = {
  domain: string | null;
  verifiedAt: string | null;
  record: { name: string; type: "TXT"; value: string } | null;
};

const domainInputSchema = z.object({
  domain: z.string().min(1, "Enter a domain.").max(253),
});

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof DomainVerificationUnavailableError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[custom-domain action]", err);
  return fail("Something went wrong. Please try again.");
}

function envRootDomain(): string {
  return process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "localhost:3000";
}
function envZoneDomain(): string | undefined {
  return process.env.NEXT_PUBLIC_ZONE_DOMAIN;
}

/**
 * Record the domain this workspace intends to use.
 *
 * ⚠️ GATED ON `settings:update`. A custom domain decides what hostname
 * this company's staff and customers sign in on; it is the same class of
 * decision as the letterhead, not a personal preference.
 */
export async function setCustomDomain(
  input: z.input<typeof domainInputSchema>,
): Promise<ActionResult<CustomDomainState>> {
  try {
    const ctx = await requirePermission("settings:update", { type: "tenant" });
    const parsed = domainInputSchema.parse(input);

    const validated = validateClaimableDomain(parsed.domain, {
      rootDomain: envRootDomain(),
      zoneDomain: envZoneDomain(),
    });
    if (!validated.ok) return fail(validated.error, { domain: [validated.error] });

    /*
     * ══════════════════════════════════════════════════════════════
     * 🔴 THE COLLISION IS CHECKED BEFORE THE WRITE, AND UNDER
     *    PLATFORM SCOPE, BECAUSE THAT IS THE ONLY SCOPE THAT CAN
     *    SEE IT.
     * ══════════════════════════════════════════════════════════════
     * `tenants_custom_domain_unique` is the real guarantee and it
     * stays. But a tenant-scoped read can never see another
     * workspace's row, so without this the customer's only feedback
     * would be a raw unique-violation, which reads as "Ordence is
     * broken" rather than "somebody already claimed that name".
     *
     * ⚠️ THE REASON STRING IS THE AUDIT TRAIL for a cross-tenant read,
     * and `withPlatformScope` requires one of at least ten characters.
     */
    const taken = await withPlatformScope(
      `Check whether a custom domain is already claimed by another workspace`,
      (tx) =>
        tx.query.tenants.findFirst({
          columns: { id: true },
          where: and(
            eq(tenants.customDomain, validated.domain),
            ne(tenants.id, ctx.tenant.id),
            isNull(tenants.deletedAt),
          ),
        }),
    );
    if (taken) {
      return fail("That domain is already in use by another workspace.", {
        domain: ["Already claimed."],
      });
    }

    /*
     * ⚠️ `customDomainVerifiedAt: null` IS UNCONDITIONAL. Re-saving the
     * same domain still clears it: the only way the timestamp is ever
     * set is a successful DNS check in `verifyCustomDomain` below.
     */
    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(tenants)
        .set({
          customDomain: validated.domain,
          customDomainVerifiedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, ctx.tenant.id))
        .returning({ id: tenants.id }),
    );
    if (!updated) return fail("Could not save that domain.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      severity: "warning",
      metadata: auditMeta({
        event: "custom_domain_claimed",
        previousDomain: ctx.tenant.customDomain ?? null,
        newDomain: validated.domain,
        verificationCleared: true,
      }),
    });

    revalidatePath("/settings/domain");

    return {
      ok: true,
      data: {
        domain: validated.domain,
        verifiedAt: null,
        record: domainChallengeRecord(ctx.tenant.id, validated.domain),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Read the challenge TXT record and, if it matches, mark the domain
 * verified.
 *
 * ⚠️ THE DOMAIN COMES FROM THE STORED ROW, NEVER FROM THE CALLER. If the
 * caller could name the domain being verified, the check would prove
 * ownership of one name and the timestamp would be written against
 * whatever `custom_domain` happened to hold.
 */
export async function verifyCustomDomain(): Promise<ActionResult<CustomDomainState>> {
  try {
    const ctx = await requirePermission("settings:update", { type: "tenant" });

    const domain = ctx.tenant.customDomain;
    if (!domain) return fail("Add a domain before verifying it.");

    const result = await checkDomainChallenge(ctx.tenant.id, domain);

    if (!result.ok) {
      await writeAudit(ctx, {
        action: "update",
        resourceType: "tenant",
        resourceId: ctx.tenant.id,
        severity: "info",
        metadata: auditMeta({
          event: "custom_domain_verification_failed",
          domain: normaliseHostname(domain),
          reason: result.reason,
        }),
      });
      return fail(result.detail);
    }

    const verifiedAt = new Date();

    /*
     * ⚠️ THE WRITE IS GUARDED ON THE DOMAIN IT VERIFIED. Between the DNS
     * lookup and this UPDATE, another request could have changed
     * `custom_domain`. Without the second predicate this would stamp the
     * NEW name as verified on the strength of a check performed against
     * the OLD one — a small window, and the whole security property
     * inside it.
     */
    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(tenants)
        .set({ customDomainVerifiedAt: verifiedAt, updatedAt: verifiedAt })
        .where(and(eq(tenants.id, ctx.tenant.id), eq(tenants.customDomain, domain)))
        .returning({ id: tenants.id }),
    );

    if (!updated) {
      return fail("The domain changed while it was being verified. Try again.");
    }

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      severity: "warning",
      metadata: auditMeta({
        event: "custom_domain_verified",
        domain: normaliseHostname(domain),
      }),
    });

    revalidatePath("/settings/domain");

    return {
      ok: true,
      data: {
        domain: normaliseHostname(domain),
        verifiedAt: verifiedAt.toISOString(),
        record: domainChallengeRecord(ctx.tenant.id, domain),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Give the domain up.
 *
 * ⚠️ BOTH COLUMNS, IN ONE STATEMENT. Clearing the name and leaving the
 * timestamp would leave a workspace marked as having verified nothing,
 * and the next claim would inherit it.
 */
export async function removeCustomDomain(): Promise<ActionResult<CustomDomainState>> {
  try {
    const ctx = await requirePermission("settings:update", { type: "tenant" });
    const previous = ctx.tenant.customDomain ?? null;

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(tenants)
        .set({ customDomain: null, customDomainVerifiedAt: null, updatedAt: new Date() })
        .where(eq(tenants.id, ctx.tenant.id))
        .returning({ id: tenants.id }),
    );
    if (!updated) return fail("Could not remove that domain.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      severity: "warning",
      metadata: auditMeta({ event: "custom_domain_removed", previousDomain: previous }),
    });

    revalidatePath("/settings/domain");

    return { ok: true, data: { domain: null, verifiedAt: null, record: null } };
  } catch (err) {
    return toActionError(err);
  }
}
