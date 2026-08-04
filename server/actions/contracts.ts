"use server";

/**
 * Ordence — Contract Read & Dispatch Actions
 * Version: v0.8.0-alpha
 *
 * Phase 4 built contract CREATION and document assembly. This adds the
 * read side the detail page needs, plus "Send to Client" — the first thing
 * in this system that transmits tenant data to someone OUTSIDE the tenant.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY SENDING AN EMAIL GETS THE SAME SCRUTINY AS A DATABASE WRITE
 * ══════════════════════════════════════════════════════════════════════
 * Every control built in Phases 1–7 governs who may read data INSIDE the
 * platform. Row-Level Security, tenant context, permissions — all of it
 * assumes the data stays in the system.
 *
 * An email leaves. Once it is delivered there is no revocation, no audit
 * of who forwarded it, and no way to un-send. That makes the recipient
 * address the most security-relevant field on this screen, and it is why:
 *
 *   - the address is NOT taken from the request. It is read from the
 *     contract's linked contact row, inside this tenant. A caller cannot
 *     pass `to: "attacker@example.com"` and have the platform mail a draft
 *     agreement there.
 *   - the send is recorded in the audit log at raised severity, with the
 *     recipient, before anyone has to ask "who sent this out?"
 *   - `contracts:read` is required. Someone who cannot open a contract
 *     must not be able to mail it to a third party.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractVersions, contacts, companies, assets } from "@/db/schema";
import { requirePermission, writeAudit, auditMeta } from "@/server/audit";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { PermissionDeniedError } from "@/lib/permissions";
import { sendContractReadyEmail, isEmailEnabled } from "@/lib/email/resend";
import type { ActionResult } from "@/lib/validators/crm";
import type { Contract } from "@/db/schema";

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
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[contracts action]", err);
  return fail("Something went wrong. Please try again.");
}

/** Format paise-safe decimal strings for display. Never a float. */
function formatMoney(value: string | null, currency: string): string | null {
  if (!value) return null;
  const [whole = "0", fraction = "00"] = String(value).split(".");
  const withSeparators = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${withSeparators}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

/* ------------------------------------------------------------------ */
/* LIST                                                                */
/* ------------------------------------------------------------------ */

export type ContractListItem = {
  id: string;
  title: string;
  contractNumber: string | null;
  contractType: string;
  status: string;
  value: string | null;
  currency: string;
  effectiveDate: string | null;
  expiryDate: string | null;
  counterpartyName: string | null;
};

export async function getContracts(): Promise<ActionResult<ContractListItem[]>> {
  try {
    const ctx = await requirePermission("contracts:read");

    const rows = await db.query.contracts.findMany({
      where: and(
        eq(contracts.tenantId, ctx.tenant.id),
        isNull(contracts.deletedAt),
      ),
      orderBy: [desc(contracts.updatedAt)],
      limit: 500,
      with: {
        contact: { columns: { firstName: true, lastName: true } },
        company: { columns: { name: true } },
      },
    });

    return {
      ok: true,
      data: rows.map((row) => {
        const contact = row.contact
          ? [row.contact.firstName, row.contact.lastName].filter(Boolean).join(" ").trim()
          : null;

        return {
          id: row.id,
          title: row.title,
          contractNumber: row.contractNumber,
          contractType: row.contractType,
          status: row.status,
          value: row.value,
          currency: row.currency,
          effectiveDate: row.effectiveDate ? String(row.effectiveDate) : null,
          expiryDate: row.expiryDate ? String(row.expiryDate) : null,
          counterpartyName: row.company?.name ?? contact ?? null,
        };
      }),
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* READ ONE                                                            */
/* ------------------------------------------------------------------ */

export type ContractDetail = {
  contract: Contract;
  counterparty: {
    contactId: string | null;
    contactName: string | null;
    contactEmail: string | null;
    companyId: string | null;
    companyName: string | null;
  };
  assetName: string | null;
  versions: Array<{
    id: string;
    versionNumber: number;
    changeType: string;
    changeSummary: string | null;
    createdAt: string;
    contentHash: string | null;
  }>;
};

export async function getContractById(id: string): Promise<ActionResult<ContractDetail>> {
  try {
    const ctx = await requirePermission("contracts:read", { type: "contract", id });
    const contractId = z.string().uuid("Invalid identifier.").parse(id);

    const row = await db.query.contracts.findFirst({
      where: and(
        eq(contracts.id, contractId),
        // Explicit tenant predicate as well as RLS. Two independent checks.
        eq(contracts.tenantId, ctx.tenant.id),
        isNull(contracts.deletedAt),
      ),
      with: {
        contact: {
          columns: { id: true, firstName: true, lastName: true, email: true },
        },
        company: { columns: { id: true, name: true } },
        asset: { columns: { name: true } },
      },
    });

    if (!row) return fail("Contract not found.");

    const versions = await db
      .select({
        id: contractVersions.id,
        versionNumber: contractVersions.versionNumber,
        changeType: contractVersions.changeType,
        changeSummary: contractVersions.changeSummary,
        createdAt: contractVersions.createdAt,
        contentHash: contractVersions.contentHash,
      })
      .from(contractVersions)
      .where(
        and(
          eq(contractVersions.tenantId, ctx.tenant.id),
          eq(contractVersions.contractId, contractId),
        ),
      )
      .orderBy(desc(contractVersions.versionNumber))
      .limit(100);

    const contactName = row.contact
      ? [row.contact.firstName, row.contact.lastName].filter(Boolean).join(" ").trim()
      : null;

    return {
      ok: true,
      data: {
        contract: row as Contract,
        counterparty: {
          contactId: row.contact?.id ?? null,
          contactName: contactName || null,
          contactEmail: row.contact?.email ?? null,
          companyId: row.company?.id ?? null,
          companyName: row.company?.name ?? null,
        },
        assetName: row.asset?.name ?? null,
        versions: versions.map((v) => ({
          ...v,
          createdAt: new Date(v.createdAt).toISOString(),
        })),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* SEND TO CLIENT                                                      */
/* ------------------------------------------------------------------ */

const sendToClientSchema = z.object({
  contractId: z.string().uuid("Invalid identifier."),
  /** An optional covering note typed by the sender. */
  message: z.string().trim().max(2000).optional(),
  /**
   * Move the contract to `counterparty_review` on a successful send.
   *
   * Default true: mailing a draft to the other side IS the act of putting
   * it out for review, and a status that silently disagrees with what
   * actually happened is worse than no status at all.
   */
  advanceStatus: z.boolean().default(true),
});

export type SendContractResult = {
  recipient: string;
  emailId: string;
  statusAdvanced: boolean;
};

export async function sendContractToClient(input: {
  contractId: string;
  message?: string;
  advanceStatus?: boolean;
}): Promise<ActionResult<SendContractResult>> {
  try {
    const ctx = await requirePermission("contracts:read", { type: "contract" });
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("contracts:send", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("clm.esignature", ctx);
    const data = sendToClientSchema.parse(input);

    if (!isEmailEnabled()) {
      return fail(
        "Email is not configured for this deployment. Set RESEND_API_KEY and redeploy.",
      );
    }

    const row = await db.query.contracts.findFirst({
      where: and(
        eq(contracts.id, data.contractId),
        eq(contracts.tenantId, ctx.tenant.id),
        isNull(contracts.deletedAt),
      ),
      with: {
        contact: { columns: { firstName: true, lastName: true, email: true } },
      },
    });

    if (!row) return fail("Contract not found.");

    // ════════════════════════════════════════════════════════════════
    // THE RECIPIENT COMES FROM THE DATABASE, NOT THE REQUEST.
    //
    // There is deliberately no `to` field on this action. The address is
    // the one on the contract's linked contact, inside this tenant. A
    // caller cannot direct a draft agreement to an arbitrary mailbox, and
    // changing who receives it requires changing the contact record —
    // which is itself tenant-scoped and audited.
    // ════════════════════════════════════════════════════════════════
    const recipientEmail = row.contact?.email?.trim();

    if (!recipientEmail) {
      return fail(
        "This contract has no client contact with an email address. " +
          "Link a contact first, then send.",
      );
    }

    const recipientName =
      [row.contact?.firstName, row.contact?.lastName].filter(Boolean).join(" ").trim() ||
      "Sir or Madam";

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") || "http://localhost:3000";

    const result = await sendContractReadyEmail({
      to: recipientEmail,
      contractId: row.id,
      props: {
        recipientName,
        organizationName: ctx.tenant.name,
        contractTitle: row.title,
        contractNumber: row.contractNumber,
        contractType: row.contractType.replace(/_/g, " "),
        contractValue: formatMoney(row.value, row.currency),
        effectiveDate: row.effectiveDate ? String(row.effectiveDate) : null,
        reviewUrl: `${appUrl}/contracts/${row.id}`,
        message: data.message ?? null,
        senderName:
          [ctx.user.firstName, ctx.user.lastName].filter(Boolean).join(" ").trim() || null,
      },
    });

    if (!result.ok) {
      // The failure is recorded too. "We tried to send and could not" is
      // information an auditor wants as much as a successful send.
      await writeAudit(ctx, {
        action: "update",
        resourceType: "contract",
        resourceId: row.id,
        severity: "warning",
        metadata: auditMeta({
          event: "contract_send_failed",
          recipient: recipientEmail,
          reason: result.reason,
        }),
      });

      return fail(result.message);
    }

    // Advance the status only AFTER the email actually went out. Doing it
    // first would leave a contract marked "with the counterparty" that the
    // counterparty never received.
    let statusAdvanced = false;

    if (data.advanceStatus && (row.status === "draft" || row.status === "internal_review")) {
      const [updated] = await db
        .update(contracts)
        .set({
          status: "counterparty_review",
          updatedAt: new Date(),
          updatedBy: ctx.user.id,
        })
        .where(and(eq(contracts.id, row.id), eq(contracts.tenantId, ctx.tenant.id)))
        .returning({ id: contracts.id });

      statusAdvanced = Boolean(updated);
    }

    // Sending tenant data outside the tenant is a notable event, not a
    // routine one. `notice` rather than `info` so it stands out in a review.
    await writeAudit(ctx, {
      action: "update",
      resourceType: "contract",
      resourceId: row.id,
      severity: "notice",
      metadata: auditMeta({
        event: "contract_sent_to_client",
        recipient: recipientEmail,
        emailId: result.id,
        statusAdvanced,
        hadCoveringNote: Boolean(data.message),
      }),
    });

    revalidatePath(`/contracts/${row.id}`);
    revalidatePath("/contracts");

    return {
      ok: true,
      data: { recipient: recipientEmail, emailId: result.id, statusAdvanced },
    };
  } catch (err) {
    return toActionError(err);
  }
}
