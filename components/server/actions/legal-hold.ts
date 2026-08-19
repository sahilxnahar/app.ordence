"use server";

/**
 * Ordence — ⭐⭐⭐ PLACING AND LIFTING A LEGAL HOLD
 * Version: v1.77.0-alpha · Wave 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE DID NOT EXIST, AND WHY THAT WAS A HOLE
 * ══════════════════════════════════════════════════════════════════════
 * `contracts.legal_hold` and `contracts.legal_hold_reason` have been
 * columns since the CLM schema was written. The flag is HONOURED in five
 * places, each of them a real refusal:
 *
 *   server/actions/documents.ts   assembly refuses to modify a held contract
 *   server/actions/portal.ts      no new client link may be issued
 *   server/actions/signatures.ts  no signature may be taken
 *   lib/dpdp/retention.ts         retention purge skips held records
 *   app/(crm)/contracts/[id]      uploads and deletions are hidden
 *
 * NOTHING COULD SET IT. There was no action, no screen and no API — the
 * only way to place a hold was an UPDATE typed into a database console,
 * which means: no audit row, no attributable actor, no recorded reason,
 * and no possibility of a customer doing it at all.
 *
 * That is the shape of defect this codebase keeps finding: a control
 * declared, honoured everywhere, and reachable from nowhere. Here it is
 * worse than usual, because a legal hold is a thing a firm is TOLD to do
 * by its counsel, on a deadline, and "we have that feature" was true of
 * every part of it except the button.
 *
 * ⚠️ `contracts:legal_hold` IS ITS OWN PERMISSION AND IS HELD BY
 * `manager` AND THE THREE WILDCARD ROLES ONLY. It is deliberately not
 * `contracts:update`: placing a hold FREEZES a record against the people
 * who normally maintain it, and lifting one un-freezes evidence while
 * litigation may still be live. Somebody who may edit a contract is not
 * automatically somebody who may decide it is now beyond editing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A REASON IS REQUIRED TO PLACE ONE AND TO LIFT ONE
 * ══════════════════════════════════════════════════════════════════════
 * Both directions are recorded with a written justification, because the
 * question asked afterwards is never "was there a hold" — it is "who
 * decided, when, and on what basis", and a boolean cannot answer it. The
 * lift is the more dangerous of the two: releasing a record for deletion
 * while a matter is live is spoliation, and an unexplained lift is
 * indistinguishable from an accidental one.
 *
 * ⚠️ SEVERITY `critical` ON BOTH AUDIT ROWS. This is one of the few
 * operations in the product where the AUDIT ROW is the deliverable — it
 * is what gets produced in a dispute — and a `notice` would let it be
 * filtered out of the view somebody is reading.
 */

import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { withTenant } from "@/db";
import { contracts } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { PermissionDeniedError } from "@/lib/permissions";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import type { ActionResult } from "@/lib/validators/crm";

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof AccessRestrictedError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    return fail(first?.message ?? "That request was not valid.");
  }
  console.error("[legal-hold action]", err);
  return fail("That could not be completed. Please try again.");
}

/**
 * ⚠️ NO `requireFeature`. A legal hold is not a paid capability and must
 * never be one: telling a customer their plan does not include preserving
 * evidence for a court is not a pricing decision, it is a liability. It is
 * also a READ-PROTECTIVE operation — it only ever makes the product do
 * less — so gating it on plan could only ever cause harm.
 *
 * ⚠️ `requireAccess` STAYS, because a workspace whose account is
 * suspended should not be writing at all, and the message that says so is
 * actionable.
 */
async function guardLegalHold() {
  const ctx = await requirePermission("contracts:legal_hold");
  await requireAccess("contracts:legal_hold", ctx);
  return ctx;
}

const reasonSchema = z
  .string()
  .trim()
  .min(
    10,
    "Write down why. A hold with no stated basis cannot be explained to anybody afterwards, " +
      "including the person who placed it.",
  )
  .max(2000);

const placeSchema = z.object({
  contractId: z.string().uuid(),
  reason: reasonSchema,
});

const liftSchema = z.object({
  contractId: z.string().uuid(),
  reason: reasonSchema,
});

export type LegalHoldState = {
  readonly contractId: string;
  readonly legalHold: boolean;
  readonly legalHoldReason: string | null;
};

/**
 * Place a hold.
 *
 * ⚠️ THE UPDATE IS CONDITIONAL ON THE CURRENT STATE (`legal_hold = false`)
 * rather than unconditional. Two people placing a hold at the same moment
 * is not a conflict worth an error, but the SECOND one must not produce a
 * second audit row claiming to have frozen a record that was already
 * frozen — that reads later as two separate legal decisions.
 */
export async function placeLegalHold(input: unknown): Promise<ActionResult<LegalHoldState>> {
  try {
    const data = placeSchema.parse(input);
    const ctx = await guardLegalHold();

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [existing] = await tx
        .select({
          id: contracts.id,
          title: contracts.title,
          legalHold: contracts.legalHold,
          legalHoldReason: contracts.legalHoldReason,
        })
        .from(contracts)
        .where(
          and(
            eq(contracts.id, data.contractId),
            eq(contracts.tenantId, ctx.tenant.id),
            isNull(contracts.deletedAt),
          ),
        );

      if (!existing) return null;
      if (existing.legalHold) {
        return { row: existing, changed: false };
      }

      const [updated] = await tx
        .update(contracts)
        .set({
          legalHold: true,
          legalHoldReason: data.reason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contracts.id, data.contractId),
            eq(contracts.tenantId, ctx.tenant.id),
            eq(contracts.legalHold, false),
          ),
        )
        .returning({
          id: contracts.id,
          title: contracts.title,
          legalHold: contracts.legalHold,
          legalHoldReason: contracts.legalHoldReason,
        });

      return updated ? { row: updated, changed: true } : { row: existing, changed: false };
    });

    if (!result) return fail("That contract could not be found.");

    if (result.changed) {
      await writeAudit(ctx, {
        action: "update",
        resourceType: "contract",
        resourceId: data.contractId,
        oldValue: { legalHold: false },
        newValue: { legalHold: true, legalHoldReason: data.reason },
        reason: `Legal hold placed on "${result.row.title}": ${data.reason}`,
        severity: "critical",
      });
    }

    revalidatePath(`/contracts/${data.contractId}`);
    revalidatePath("/contracts");

    return {
      ok: true,
      data: {
        contractId: result.row.id,
        legalHold: result.row.legalHold,
        legalHoldReason: result.row.legalHoldReason,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Lift a hold.
 *
 * ⚠️ THE OLD REASON IS CARRIED INTO THE AUDIT ROW BEFORE IT IS CLEARED.
 * Otherwise lifting a hold destroys the only record of why it existed,
 * and the audit trail shows a record that was frozen for no stated reason
 * and released for a stated one — which is exactly backwards.
 */
export async function liftLegalHold(input: unknown): Promise<ActionResult<LegalHoldState>> {
  try {
    const data = liftSchema.parse(input);
    const ctx = await guardLegalHold();

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [existing] = await tx
        .select({
          id: contracts.id,
          title: contracts.title,
          legalHold: contracts.legalHold,
          legalHoldReason: contracts.legalHoldReason,
        })
        .from(contracts)
        .where(
          and(
            eq(contracts.id, data.contractId),
            eq(contracts.tenantId, ctx.tenant.id),
            isNull(contracts.deletedAt),
          ),
        );

      if (!existing) return null;
      if (!existing.legalHold) return { row: existing, changed: false, previousReason: null };

      const previousReason = existing.legalHoldReason;

      const [updated] = await tx
        .update(contracts)
        .set({ legalHold: false, legalHoldReason: null, updatedAt: new Date() })
        .where(
          and(
            eq(contracts.id, data.contractId),
            eq(contracts.tenantId, ctx.tenant.id),
            eq(contracts.legalHold, true),
          ),
        )
        .returning({
          id: contracts.id,
          title: contracts.title,
          legalHold: contracts.legalHold,
          legalHoldReason: contracts.legalHoldReason,
        });

      return updated
        ? { row: updated, changed: true, previousReason }
        : { row: existing, changed: false, previousReason };
    });

    if (!result) return fail("That contract could not be found.");

    if (result.changed) {
      await writeAudit(ctx, {
        action: "update",
        resourceType: "contract",
        resourceId: data.contractId,
        oldValue: { legalHold: true, legalHoldReason: result.previousReason },
        newValue: { legalHold: false },
        reason:
          `Legal hold lifted on "${result.row.title}": ${data.reason} ` +
          `(the hold had been placed because: ${result.previousReason ?? "no reason was recorded"})`,
        severity: "critical",
      });
    }

    revalidatePath(`/contracts/${data.contractId}`);
    revalidatePath("/contracts");

    return {
      ok: true,
      data: {
        contractId: result.row.id,
        legalHold: result.row.legalHold,
        legalHoldReason: result.row.legalHoldReason,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}
