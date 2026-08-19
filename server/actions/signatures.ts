"use server";

/**
 * Ordence — External Signature Engine
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS IS THE MOST DANGEROUS ACTION IN THE PLATFORM
 * ══════════════════════════════════════════════════════════════════════
 * Every other server action requires a Clerk session, a tenant context and
 * a permission. This one is invoked by an ANONYMOUS visitor and its effect
 * is to legally execute a contract.
 *
 * There is exactly one thing standing between the internet and that
 * outcome: the token. So the token is re-verified here, from scratch,
 * on every call. Nothing is carried over from the page render — a server
 * action is a public RPC endpoint, and the fact that our portal page
 * called it politely says nothing about who else might.
 *
 * ══════════════════════════════════════════════════════════════════════
 * HOW REPLAY IS PREVENTED — THREE INDEPENDENT LAYERS
 * ══════════════════════════════════════════════════════════════════════
 * A signing URL is a bearer credential that will sit in an inbox forever.
 * "Sign it twice" must be impossible, not merely discouraged.
 *
 *   1. COMPARE-AND-SWAP. The link is consumed with
 *      `UPDATE ... SET is_active = false WHERE id = ? AND is_active = true`.
 *      That statement is atomic: of two concurrent submissions exactly one
 *      updates a row, and the loser sees `rowCount = 0` and stops. This is
 *      why the link is deactivated BEFORE the signature is written — a
 *      check-then-act would leave a window between them.
 *
 *   2. A UNIQUE INDEX on `contract_signatures.portal_link_id`. If layer 1
 *      were ever removed or bypassed, the database still refuses a second
 *      signature for the same link.
 *
 *   3. STATUS GUARD. A contract already `signed` or `executed` is refused
 *      outright, whatever the link says.
 *
 * Any one of these would usually be enough. All three are here because
 * this is the operation where being wrong is unrecoverable.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { portalLinks, contracts, contractSignatures } from "@/db/schema";
import {
  resolvePortalToken,
  getVisitorFacts,
  writePortalAudit,
} from "@/server/portal-context";
import { signContractSchema, CONSENT_STATEMENT } from "@/lib/validators/portal";
import type { ActionResult } from "@/lib/validators/crm";
import type { SignContractInput } from "@/lib/validators/portal";

export type { SignContractInput };

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * The single message shown for every token failure.
 *
 * Distinguishing "no such link" from "that link was revoked yesterday"
 * tells an anonymous caller which tokens were once valid. That is
 * information they did not have, and it costs us nothing to withhold. The
 * specific reason is written to the server log instead.
 */
const GENERIC_LINK_FAILURE =
  "This link is no longer valid. It may have expired, been withdrawn, or already been used. " +
  "Please contact the sender for a new one.";

export type SignatureResult = {
  signatureId: string;
  signedAt: string;
  contractTitle: string;
  signerName: string;
};

/* ------------------------------------------------------------------ */
/* SIGN                                                                */
/* ------------------------------------------------------------------ */

export async function signContractViaPortal(
  input: SignContractInput,
): Promise<ActionResult<SignatureResult>> {
  const facts = await getVisitorFacts();

  try {
    // ---- 1. VALIDATE THE SUBMISSION --------------------------------
    // Including `consent: z.literal(true)`. An unchecked box submits
    // `false` or nothing; both are refused rather than coerced, because
    // consent that can be absent is not consent.
    const data = signContractSchema.parse(input);

    // ---- 2. RE-VERIFY THE TOKEN FROM SCRATCH -----------------------
    // Not trusted from the page that rendered the form. This action is
    // reachable by anyone who can POST to it.
    const resolution = await resolvePortalToken(data.token);

    if (!resolution.ok) {
      console.warn("[signature] refused — token invalid", {
        reason: resolution.reason,
        ip: facts.ipAddress,
      });
      return fail(GENERIC_LINK_FAILURE);
    }

    const { link, tenantId } = resolution;

    // ---- 3. THE LINK MUST GRANT SIGNING ----------------------------
    // A `view` link that could sign would make the permission field
    // decorative. Someone forwarded a read-only link must not be able to
    // execute the agreement by calling this endpoint directly.
    if (link.permission !== "view_and_sign") {
      console.warn("[signature] refused — link is view-only", {
        linkId: link.id,
        ip: facts.ipAddress,
      });

      await writePortalAudit({
        tenantId,
        action: "security_event",
        resourceType: "portal_link",
        resourceId: link.id,
        severity: "warning",
        portalLinkId: link.id,
        actorEmail: link.recipientEmail,
        facts,
        metadata: {
          event: "signature_attempted_on_view_only_link",
          entityId: link.entityId,
        },
      });

      return fail("This link allows viewing only. Please ask the sender for a signing link.");
    }

    if (link.entityType !== "contract") {
      return fail("Only contracts can be signed.");
    }

    // ---- 4. LOAD THE CONTRACT, TENANT-PINNED -----------------------
    // From here on every query runs inside `withTenant`, so full RLS
    // applies exactly as it would for an authenticated user.
    const contract = await withTenant(tenantId, async (tx) => {
      const row = await tx.query.contracts.findFirst({
        where: and(eq(contracts.id, link.entityId), eq(contracts.tenantId, tenantId)),
      });
      return row ?? null;
    });

    if (!contract || contract.deletedAt) {
      return fail(GENERIC_LINK_FAILURE);
    }

    // ---- 5. IS THIS CONTRACT SIGNABLE AT ALL? ----------------------
    if (contract.legalHold) {
      // A hold freezes the position. Executing under one would be exactly
      // the thing a hold exists to prevent.
      return fail(
        "This document is currently on hold and cannot be signed. Please contact the sender.",
      );
    }

    const alreadyFinal = ["signed", "executed", "terminated", "cancelled", "expired"];
    if (alreadyFinal.includes(contract.status)) {
      return fail(
        `This document has already been ${contract.status.replace(/_/g, " ")} and cannot be signed again.`,
      );
    }

    // ---- 6. CONTENT HASH — what they are actually signing -----------
    // The difference between "they signed something" and "they signed
    // THIS". If the contract is edited later, this hash stops matching and
    // the discrepancy is detectable rather than arguable.
    const contentHash = createHash("sha256")
      .update(
        JSON.stringify({
          id: contract.id,
          title: contract.title,
          contractNumber: contract.contractNumber,
          value: contract.value,
          currency: contract.currency,
          effectiveDate: contract.effectiveDate,
          expiryDate: contract.expiryDate,
          governingLaw: contract.governingLaw,
          jurisdiction: contract.jurisdiction,
          documentData: contract.documentData,
          version: contract.currentVersion,
        }),
        "utf8",
      )
      .digest("hex");

    const signedAt = new Date();

    // ---- 7. THE ATOMIC PART -----------------------------------------
    const outcome = await withTenant(tenantId, async (tx) => {
      // ════════════════════════════════════════════════════════════
      // COMPARE-AND-SWAP: consume the link FIRST.
      //
      // `WHERE is_active = true` makes this a single atomic test-and-set.
      // Two concurrent submissions of the same URL — a double-clicked
      // button on a slow connection, or a deliberate replay — race here,
      // and exactly one of them updates a row. The other sees zero and
      // stops before writing anything.
      //
      // Doing this AFTER the signature insert would leave a window in
      // which both requests believed they were first.
      // ════════════════════════════════════════════════════════════
      const consumed = await tx
        .update(portalLinks)
        .set({ isActive: false, signedAt })
        .where(
          and(
            eq(portalLinks.id, link.id),
            eq(portalLinks.tenantId, tenantId),
            eq(portalLinks.isActive, true),
          ),
        )
        .returning({ id: portalLinks.id });

      if (consumed.length === 0) {
        // Lost the race, or the link was revoked between resolution and
        // now. Either way: do nothing further.
        return { raced: true as const };
      }

      // The signature record. `contract_signatures` is append-only at the
      // database level, so this row can never be edited or deleted.
      const [signature] = await tx
        .insert(contractSignatures)
        .values({
          tenantId,
          contractId: contract.id,
          portalLinkId: link.id,
          signerName: data.signerName,
          // From the LINK, not the form. The signer cannot claim a
          // different address than the one we sent the link to.
          signerEmail: link.recipientEmail ?? "unknown@portal.local",
          signerTitle: data.signerTitle ?? null,
          signedAt,
          ipAddress: facts.ipAddress,
          userAgent: facts.userAgent,
          country: facts.country,
          contentHash,
          contractVersion: contract.currentVersion,
          // Stored verbatim. If this wording ever changes, historical
          // signatures keep the text that was actually shown at the time.
          consentStatement: CONSENT_STATEMENT,
        })
        .returning({ id: contractSignatures.id });

      if (!signature) return { raced: true as const };

      // Advance the contract only after the evidence is committed.
      await tx
        .update(contracts)
        .set({
          status: "signed",
          signedAt,
          updatedAt: signedAt,
        })
        .where(and(eq(contracts.id, contract.id), eq(contracts.tenantId, tenantId)));

      return { raced: false as const, signatureId: signature.id };
    });

    if (outcome.raced) {
      console.warn("[signature] refused — link already consumed", {
        linkId: link.id,
        ip: facts.ipAddress,
      });
      return fail(
        "This document has already been signed through this link. Please contact the sender if you believe this is a mistake.",
      );
    }

    // ---- 8. AUDIT ----------------------------------------------------
    // `critical` severity. An external party has just bound this tenant's
    // counterparty to an agreement — there is no routine version of that.
    await writePortalAudit({
      tenantId,
      action: "update",
      resourceType: "contract",
      resourceId: contract.id,
      severity: "critical",
      portalLinkId: link.id,
      actorEmail: link.recipientEmail,
      facts,
      metadata: {
        event: "contract_signed_externally",
        signatureId: outcome.signatureId,
        signerName: data.signerName,
        signerTitle: data.signerTitle ?? null,
        contractTitle: contract.title,
        contractNumber: contract.contractNumber,
        contentHash,
        contractVersion: contract.currentVersion,
        previousStatus: contract.status,
        // How many times the link was opened before it was used. A
        // signature on a link never previously viewed is worth a look.
        viewCountBeforeSigning: link.viewCount,
      },
    });

    revalidatePath(`/contracts/${contract.id}`);

    return {
      ok: true,
      data: {
        signatureId: outcome.signatureId,
        signedAt: signedAt.toISOString(),
        contractTitle: contract.title,
        signerName: data.signerName,
      },
    };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(
        "Please check the form and try again.",
        err.flatten().fieldErrors as Record<string, string[]>,
      );
    }

    // A unique-violation here means layer 2 caught a replay that got past
    // layer 1 — worth knowing about, and still refused.
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      console.error("[signature] unique violation — replay caught by the database", {
        ip: facts.ipAddress,
      });
      return fail("This document has already been signed through this link.");
    }

    console.error("[signature]", err);
    return fail("The signature could not be recorded. Please try again.");
  }
}

/* ------------------------------------------------------------------ */
/* INTERNAL READ                                                       */
/* ------------------------------------------------------------------ */

/**
 * Signatures recorded against a contract, for the internal detail page.
 *
 * Requires a real session — this reads evidence, and evidence is not
 * public. Imported from the internal side only.
 */
export async function getContractSignatures(contractId: string): Promise<
  ActionResult<
    Array<{
      id: string;
      signerName: string;
      signerEmail: string;
      signerTitle: string | null;
      signedAt: string;
      ipAddress: string | null;
      country: string | null;
      contentHash: string | null;
      contractVersion: number | null;
    }>
  >
> {
  const { requirePermission } = await import("@/server/audit");

  try {
    const ctx = await requirePermission("contracts:read", { type: "contract" });
    const id = z.string().uuid("Invalid identifier.").parse(contractId);

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      return tx
        .select({
          id: contractSignatures.id,
          signerName: contractSignatures.signerName,
          signerEmail: contractSignatures.signerEmail,
          signerTitle: contractSignatures.signerTitle,
          signedAt: contractSignatures.signedAt,
          ipAddress: contractSignatures.ipAddress,
          country: contractSignatures.country,
          contentHash: contractSignatures.contentHash,
          contractVersion: contractSignatures.contractVersion,
        })
        .from(contractSignatures)
        .where(
          and(
            eq(contractSignatures.tenantId, ctx.tenant.id),
            eq(contractSignatures.contractId, id),
          ),
        )
        .limit(50);
    });

    return {
      ok: true,
      data: rows.map((r) => ({
        ...r,
        signedAt: new Date(r.signedAt).toISOString(),
      })),
    };
  } catch (err) {
    console.error("[signatures read]", err);
    return fail("Could not load the signature record.");
  }
}
