"use server";

/**
 * Ordence — Options the goods-receipt form needs
 * Version: v1.43.0-alpha (Mega-wave 1, Batch 38, second half)
 *
 * ⚠️ SEPARATE FROM `purchase-orders.ts` ON PURPOSE, for the same reason
 * `orders-form.ts` is separate from `orders.ts`. That file is the write
 * path — raise, approve, receive, match — and every export of it is a
 * browser-reachable RPC endpoint. A read helper for a dropdown sitting
 * between `recordGoodsReceipt` and `runThreeWayMatch` makes the guard
 * audit of that file harder to read, and the guard audit of that file is
 * the whole control: three permissions, deliberately not one.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { warehouses } from "@/db/schema/inventory";
import { requirePermission } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

export async function listWarehouseOptions(): Promise<
  ActionResult<{ rows: Array<{ id: string; label: string; hint?: string }> }>
> {
  try {
    /**
     * 🔴 GUARDED ON THE PERMISSION THAT POSTS THE MOVEMENT, not on the
     * one that reads stock.
     *
     * ⚠️ `inventory.stock.read` would have been the instinctive choice —
     * it is only a list of names. But this list exists solely to be fed
     * back into `recordGoodsReceipt`, which requires
     * `inventory.movements.post`. Offering the choice to somebody who
     * will be refused the save is how a form teaches an operator that the
     * product is unreliable, and `inventory.warehouses.manage` would have
     * been the opposite error: a storekeeper who takes delivery has no
     * business creating godowns.
     */
    const ctx = await requirePermission("inventory.movements.post");

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: warehouses.id,
          code: warehouses.code,
          name: warehouses.name,
          isActive: warehouses.isActive,
          city: warehouses.city,
          stateCode: warehouses.stateCode,
        })
        .from(warehouses)
        .where(
          and(
            eq(warehouses.tenantId, ctx.tenant.id),
            /**
             * ⚠️ SOFT-DELETED WAREHOUSES ARE EXCLUDED HERE, NOT FILTERED
             * IN THE BROWSER. A deleted godown that reaches the form is a
             * godown somebody can still book a lorry into, and the stock
             * movement would be perfectly valid and permanently invisible
             * to every screen that lists live warehouses.
             */
            isNull(warehouses.deletedAt),
            /**
             * ⭐ AND INACTIVE ONES TOO. `is_active` is how a site store
             * that has closed is retired without destroying its history;
             * receiving into one puts goods somewhere nobody visits.
             */
            eq(warehouses.isActive, true),
          ),
        )
        .orderBy(asc(warehouses.name)),
    );

    return {
      ok: true,
      data: {
        rows: rows.map((w) => ({
          id: w.id,
          label: `${w.code} · ${w.name}`,
          /**
           * ⭐ WHERE IT IS, because a business with a godown in Pune and
           * one in Bhiwandi has two rows whose names differ by a word.
           * Receiving forty tonnes into the wrong one is corrected by a
           * transfer somebody has to notice first.
           */
          hint: [w.city, w.stateCode ? `state ${w.stateCode}` : null]
            .filter(Boolean)
            .join(" · ") || undefined,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "listWarehouseOptions");
  }
}
