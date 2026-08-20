/**
 * Ordence — writer: `stock_batches`
 * Version: v1.85.0-alpha · Phase 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A BATCH IS NORMALLY BORN FROM A MOVEMENT, AND THAT IS WHY THIS
 *    WRITER EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `ordence_stock_movement_batch()` (SQL 0055) creates a `stock_batches`
 * row the first time a receipt names a lot — with whatever expiry that
 * receipt carried, or none. `opening-stock` has no expiry column at all,
 * so a customer who imports their opening stock first ends up with one
 * batch row per lot and NOT ONE EXPIRY DATE, on exactly the items that
 * were marked batch-tracked because their expiry matters.
 *
 * ⭐ SO THE ORDER IS: batches, then opening stock. Loaded that way the
 * lots exist with their printed dates, and the movement trigger finds
 * them instead of inventing them. `contract.dependsOn` in
 * `lib/import/entities-inventory.ts` states it and the wizard shows it.
 *
 * ⚠️ AND THIS WRITER NEVER CHANGES AN EXPIRY DATE. The entity offers
 * only `skip` and `fail`, so `existingId` cannot arrive here — and if it
 * ever did, the guard below refuses rather than writing. Correcting an
 * expiry is `updateBatch` in `server/actions/batches.ts`, which demands
 * a written reason because moving a date moves stock between saleable
 * and not. An importer that quietly rewrote five hundred of them would
 * be the one path around that rule.
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { stockBatches, stockItems } from "@/db/schema";
import { describeWriteFailure } from "../shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "../types";

/**
 * ⚠️ THE KEY IS `sku|batchNo` AND IT IS RESOLVED THROUGH A JOIN.
 *
 * `stock_batches_item_batch_unique` is `(tenant_id, stock_item_id,
 * batch_no)` — the id, not the SKU. The file has the SKU, so the join is
 * unavoidable; doing it in the natural key rather than in the write is
 * what lets the PREVIEW say "this lot is already here" instead of the
 * commit discovering it against a unique index.
 */
async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const wanted = Array.from(
    new Set(keys.filter((k) => k.kind === "itemBatch").map((k) => k.value)),
  );
  if (wanted.length === 0) return found;

  /*
   * ⚠️ THE COMPOSITE IS BUILT IN SQL AND COMPARED WHOLE, rather than
   * fetching every batch of every SKU in the file and filtering in JS.
   * A customer with 400 lots of one item would otherwise pull 400 rows
   * to match one, and the `limit(5000)` above every other writer would
   * start silently truncating — which reports rows as new and then
   * duplicates them.
   */
  const composite = sql`lower(${stockItems.sku}) || '|' || lower(${stockBatches.batchNo})`;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: stockBatches.id, key: sql<string>`${composite}` })
      .from(stockBatches)
      .innerJoin(
        stockItems,
        and(
          eq(stockItems.id, stockBatches.stockItemId),
          // ⚠️ THE JOIN IS TENANT-SCOPED TOO. The FK on
          // `stock_batches.stock_item_id` says the item EXISTS, not that
          // it is ours — see SQL 0250, which closes that hole at the
          // database. Until every deployment has 0250, this predicate is
          // what stops a cross-tenant row being matched as existing.
          eq(stockItems.tenantId, ctx.tenant.id),
        ),
      )
      .where(and(eq(stockBatches.tenantId, ctx.tenant.id), inArray(composite, wanted)))
      .limit(5000),
  );

  for (const row of rows) {
    const key = `itemBatch:${row.key}`;
    if (!found.has(key)) found.set(key, row.id);
  }
  return found;
}

async function writeRow(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<WriteOutcome> {
  /*
   * 🔴 A GUARD, NOT A FALL-THROUGH. `duplicateModes` for this entity is
   * `["skip", "fail"]`, so `server/actions/import.ts` can only reach
   * this function with `existingId === null`. If that ever stops being
   * true the honest answer is a refused row that says so, not a quiet
   * UPDATE of a lot's expiry date — which is the one write this module's
   * header promises never to make.
   */
  if (existingId) {
    return {
      ok: false,
      error:
        "This lot is already recorded. Batches are never overwritten by an import — " +
        "correcting an expiry or a manufacture date is done on the batch itself, with " +
        "a written reason, because it moves stock between saleable and not.",
    };
  }

  const stockItemId = payload.stockItemId;
  /*
   * ⚠️ BELT AND BRACES. `contract.requiredness.structural` already
   * refuses a row whose SKU did not resolve, in the PREVIEW, with a
   * sentence the customer can act on. This is the second layer, and it
   * exists because the first one lives in a different file: a lookup
   * renamed on one side only would otherwise insert `undefined` and get
   * a not-null violation at 3am instead of a refusal at 11.
   */
  if (typeof stockItemId !== "string" || stockItemId === "") {
    return {
      ok: false,
      error:
        "No stock item in your workspace matched this SKU, so there is nothing for this " +
        "lot to belong to.",
    };
  }

  try {
    const status =
      (payload.status as (typeof stockBatches.$inferInsert)["status"] | undefined) ?? "active";

    await withTenant(ctx.tenant.id, (tx) =>
      tx.insert(stockBatches).values({
        tenantId: ctx.tenant.id,
        stockItemId,
        batchNo: String(payload.batchNo ?? ""),
        supplierBatchNo: (payload.supplierBatchNo as string | null) ?? null,
        manufactureDate: (payload.manufactureDate as string | null) ?? null,
        expiryDate: (payload.expiryDate as string | null) ?? null,
        status,
        statusNote: (payload.statusNote as string | null) ?? null,
        /*
         * ⚠️ A NON-DEFAULT STATUS IS A STATUS CHANGE, AND IT IS DATED.
         * `status_changed_at` left null on a quarantined lot means the
         * batches screen shows "quarantined" with no answer to "since
         * when", which is the first question anybody asks about it.
         */
        statusChangedAt: status === "active" ? null : new Date(),
        statusChangedBy: status === "active" ? null : ctx.user.id,
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      }),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const stockBatchesWriter: ImportWriter = {
  revalidatePath: "/inventory/batches",
  findExisting,
  writeRow,
};
