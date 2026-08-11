"use server";

/**
 * Ordence — Bulk Operations
 * Version: v0.83.1
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A "use server" file that exports
 * anything else publishes it as an RPC endpoint reachable by anyone.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY BULK IS A SEPARATE MODULE AND NOT A LOOP AT THE CALL SITE
 * ══════════════════════════════════════════════════════════════════════
 * The tempting implementation is `ids.map(id => deleteContact(id))`. It is
 * wrong in three specific ways, and each one is why this file exists:
 *
 *   1. IT IS N TRANSACTIONS. Each single-record action opens its own
 *      `withTenant()`. Two hundred selected rows is two hundred
 *      transactions, and a failure at row 140 leaves 139 committed with no
 *      record of where it stopped.
 *   2. IT AUDITS N TIMES, WITH NO LINK BETWEEN THE ENTRIES. A reviewer
 *      reading the log sees two hundred unrelated deletions rather than one
 *      deliberate act. `batchId` below is what makes them one act.
 *   3. IT RE-CHECKS PERMISSION N TIMES AND STILL GETS IT WRONG. The check
 *      belongs before the first write, not before each one — otherwise a
 *      denial halfway through is a partial apply.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ SOFT DELETE ONLY. NOTHING HERE ISSUES A `DELETE`.
 * ══════════════════════════════════════════════════════════════════════
 * `deleted_at` is set. The rows remain, the recycle bin in
 * `server/backup/restore.ts` can bring them back, and the 30-day window
 * governs what is SHOWN rather than what exists. A bulk hard delete is the
 * single most destructive button it is possible to put in a CRM, and this
 * file deliberately does not contain one.
 */

import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { contacts, companies, deals } from "@/db/schema";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { writeAudit } from "@/server/audit";
import { can } from "@/lib/permissions";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* WHAT CAN BE ACTED ON IN BULK                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ AN ALLOWLIST, NEVER A LOOKUP BY NAME.
 *
 * The entity is chosen from this table, not resolved from the caller's
 * string against the schema. A dynamic resolver is one migration away from
 * letting a crafted `entity` reach `users`, `subscriptions` or the vault —
 * tables where "set deleted_at on these 200 ids" is an attack, not a
 * feature. Adding an entity here is a deliberate act with a code review.
 */
const BULK_ENTITIES = {
  contact: {
    table: contacts,
    label: "contact",
    deletePermission: "contacts:delete",
    updatePermission: "contacts:update",
    resourceType: "contact",
  },
  company: {
    table: companies,
    label: "company",
    deletePermission: "companies:delete",
    updatePermission: "companies:update",
    resourceType: "company",
  },
  deal: {
    table: deals,
    label: "deal",
    deletePermission: "deals:delete",
    updatePermission: "deals:update",
    resourceType: "deal",
  },
} as const;

export type BulkEntity = keyof typeof BULK_ENTITIES;

/**
 * ⚠️ CAPPED AT 500, AND THE CAP IS THE POINT.
 *
 * An uncapped `inArray` builds a query with one parameter per id; a few
 * thousand of them is a statement large enough to stall the connection that
 * every other request in the process is now queued behind. 500 is well
 * inside Postgres' limits and still large enough that nobody selecting rows
 * by hand will meet it.
 */
const MAX_BULK = 500;

const bulkInputSchema = z.object({
  entity: z.enum(["contact", "company", "deal"]),
  ids: z
    .array(z.string().uuid("Each id must be a UUID."))
    .min(1, "Select at least one record.")
    .max(MAX_BULK, `You can act on at most ${MAX_BULK} records at once.`),
  /**
   * ⚠️ REQUIRED, and not for bureaucracy. It lands in the audit entry. A
   * bulk mutation with no stated reason is the one a reviewer cannot
   * evaluate six months later, and this is the cheapest possible moment to
   * capture it.
   */
  reason: z.string().trim().min(3, "Give a short reason for this bulk action.").max(500),
});

export type BulkResult = {
  requested: number;
  affected: number;
  /** Ids that were requested but not changed — already deleted, or absent. */
  skipped: number;
  batchId: string;
};

/* ------------------------------------------------------------------ */
/* BULK SOFT DELETE                                                    */
/* ------------------------------------------------------------------ */

export async function bulkSoftDelete(
  input: z.input<typeof bulkInputSchema>,
): Promise<ActionResult<BulkResult>> {
  try {
    const params = bulkInputSchema.parse(input);
    const spec = BULK_ENTITIES[params.entity];
    const ctx = await requireTenantContext();

    /*
     * ⚠️ ACCESS BEFORE PERMISSION — the call order `server/billing/access.ts`
     * documents: broadest reason first, so a customer whose card expired is
     * told to pay rather than told they "lack permission" and sent to an
     * administrator who is themselves.
     *
     * ⚠️ AND IT IS ESPECIALLY LOAD-BEARING FOR A BULK ACTION. If a
     * restricted workspace is meant to be read-only, the single most
     * damaging thing it could still be allowed to do is soft-delete five
     * hundred records at once.
     */
    await requireAccess(`${params.entity}s:delete`, ctx);

    /*
     * ⚠️ ONCE, BEFORE ANY WRITE. Checking inside the loop would mean a
     * denial could arrive after some rows had already been changed.
     */
    if (!can({ role: ctx.role, overrides: ctx.user.permissionOverrides }, spec.deletePermission)) {
      return {
        ok: false,
        error: `You do not have permission to delete ${spec.label} records.`,
      };
    }

    /*
     * ⚠️ Deduplicated. A selection UI that lets the same id arrive twice
     * would otherwise inflate `affected` and make the audit entry claim
     * more than happened.
     */
    const ids = Array.from(new Set(params.ids));
    const batchId = crypto.randomUUID();
    const now = new Date();

    const changed = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /*
         * ⚠️ `isNull(deletedAt)` is load-bearing. Without it, re-running a
         * bulk delete would rewrite `deleted_at` on rows already in the
         * recycle bin — silently restarting their 30-day retention clock
         * and making a record look freshly deleted by whoever pressed the
         * button second.
         *
         * The tenant predicate is here AND enforced by RLS underneath. The
         * explicit one means a missing policy is a bug rather than a
         * breach.
         */
        const rows = await tx
          .update(spec.table)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(spec.table.tenantId, ctx.tenant.id),
              inArray(spec.table.id, ids),
              isNull(spec.table.deletedAt),
            ),
          )
          .returning({ id: spec.table.id });

        return rows.map((r) => r.id);
      },
      { impersonationId: ctx.impersonationId },
    );

    /*
     * ⚠️ ONE audit entry for the batch, carrying every affected id — not
     * one entry per row. The `batchId` is what lets a reviewer ask "what
     * else happened in this action?" and get an answer.
     */
    await writeAudit(ctx, {
      action: "delete",
      resourceType: spec.resourceType,
      resourceId: null,
      metadata: {
        bulk: true,
        batchId,
        requested: ids.length,
        affected: changed.length,
        affectedIds: changed,
      },
      reason: params.reason,
      /*
       * ⚠️ A large bulk delete is a `warning`, not routine. The severity
       * ladder is info → notice → warning → critical; anything above fifty
       * rows in one act is the entry a reviewer should find when scanning
       * for what went wrong last Tuesday.
       */
      severity: changed.length > 50 ? "warning" : "notice",
    });

    return {
      ok: true,
      data: {
        requested: ids.length,
        affected: changed.length,
        skipped: ids.length - changed.length,
        batchId,
      },
    };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.issues[0]?.message ?? "Invalid bulk request." };
    }
    /*
     * ⚠️ Caught BEFORE the generic handler, and reported with the billing
     * wording. Letting this fall through to "The bulk action failed" would
     * tell a customer whose subscription lapsed that the software is broken,
     * which is the one message guaranteed to produce a support ticket
     * instead of a payment.
     */
    if (err instanceof AccessRestrictedError) {
      return { ok: false, error: err.decision.detail ?? err.decision.headline ?? err.message };
    }
    if (err instanceof TenantAccessError) return { ok: false, error: err.message };
    console.error("[bulkSoftDelete]", err);
    return { ok: false, error: "The bulk action failed. Nothing was changed." };
  }
}

/* ------------------------------------------------------------------ */
/* BULK OWNER REASSIGNMENT                                             */
/* ------------------------------------------------------------------ */

const bulkAssignSchema = bulkInputSchema.extend({
  /** Null clears the owner. */
  ownerUserId: z.string().uuid().nullable(),
});

export async function bulkAssignOwner(
  input: z.input<typeof bulkAssignSchema>,
): Promise<ActionResult<BulkResult>> {
  try {
    const params = bulkAssignSchema.parse(input);
    const spec = BULK_ENTITIES[params.entity];
    const ctx = await requireTenantContext();

    // Access first — see the note in `bulkSoftDelete`.
    await requireAccess(`${params.entity}s:update`, ctx);

    if (!can({ role: ctx.role, overrides: ctx.user.permissionOverrides }, spec.updatePermission)) {
      return {
        ok: false,
        error: `You do not have permission to edit ${spec.label} records.`,
      };
    }

    const ids = Array.from(new Set(params.ids));
    const batchId = crypto.randomUUID();
    const now = new Date();

    const changed = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /*
         * ⚠️ The new owner must belong to THIS tenant. RLS already makes a
         * foreign user id unresolvable, but an explicit failure here names
         * the problem instead of leaving a dangling reference to explain.
         */
        if (params.ownerUserId) {
          const { users } = await import("@/db/schema");
          const owner = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, params.ownerUserId), eq(users.tenantId, ctx.tenant.id)))
            .limit(1);

          if (owner.length === 0) {
            throw new Error("That user is not a member of this workspace.");
          }
        }

        const rows = await tx
          .update(spec.table)
          .set({ ownerId: params.ownerUserId, updatedAt: now })
          .where(
            and(
              eq(spec.table.tenantId, ctx.tenant.id),
              inArray(spec.table.id, ids),
              isNull(spec.table.deletedAt),
            ),
          )
          .returning({ id: spec.table.id });

        return rows.map((r) => r.id);
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: spec.resourceType,
      resourceId: null,
      newValue: { ownerId: params.ownerUserId },
      metadata: {
        bulk: true,
        batchId,
        requested: ids.length,
        affected: changed.length,
        affectedIds: changed,
      },
      reason: params.reason,
    });

    return {
      ok: true,
      data: {
        requested: ids.length,
        affected: changed.length,
        skipped: ids.length - changed.length,
        batchId,
      },
    };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.issues[0]?.message ?? "Invalid bulk request." };
    }
    if (err instanceof AccessRestrictedError) {
      return { ok: false, error: err.decision.detail ?? err.decision.headline ?? err.message };
    }
    if (err instanceof TenantAccessError) return { ok: false, error: err.message };
    console.error("[bulkAssignOwner]", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The bulk action failed. Nothing was changed.",
    };
  }
}
