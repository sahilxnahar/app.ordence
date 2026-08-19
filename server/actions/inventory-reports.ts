"use server";

/**
 * Ordence — ⭐⭐⭐ WHAT TO BUY, AND WHAT IS NOT MOVING
 * Version: v1.21.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE REST OF BATCH 12, WHICH I REPORTED AS FINISHED IN v1.18.0
 * ══════════════════════════════════════════════════════════════════════
 * That session delivered the physical count, which was the hard half.
 * The reorder list, dead stock by age and profitability after landed
 * cost were all part of the same batch and none of them existed.
 *
 * ⭐ THE COLUMNS WERE ALREADY THERE. `reorder_level`, `reorder_quantity`
 * and `lead_time_days` have been on `stock_items` since 0029, with a
 * comment explaining why a nullable reorder level is correct. Nothing
 * read them.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { requirePermission } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  findDeadStock,
  suggestReorders,
  type DeadStockLine,
  type ItemPosition,
  type ReorderLine,
} from "@/lib/inventory/reorder";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "inventory.stock.read" as const;

/**
 * ⚠️ MOVED TO `lib/inventory/reorder.ts` BECAUSE `check:boundaries`
 * REFUSED IT HERE, and the gate was right: `"use server"` makes every
 * export a browser-reachable endpoint, and a plain constant has no
 * business being one. Second time this session that gate has caught me.
 */
import { USAGE_WINDOW_DAYS } from "@/lib/inventory/reorder";

export async function getInventoryReports(): Promise<
  ActionResult<{
    reorder: readonly ReorderLine[];
    deadStock: readonly DeadStockLine[];
    deadStockValueMinor: string;
    reorderValueMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const today = new Date();

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * ⭐ ONE QUERY, NOT ONE PER ITEM. A warehouse with four thousand
         * lines and a per-item query is a report that times out, and a
         * report that times out is a report nobody opens twice.
         *
         * ⚠️ `on_order` COUNTS ONLY APPROVED ORDERS NOT YET RECEIVED.
         * Counting a draft order would suppress a genuine reorder for
         * something nobody has actually committed to buying.
         */
        const rows = await tx.execute(sql`
          WITH used AS (
            SELECT m.stock_item_id,
                   SUM(CASE WHEN m.quantity < 0 THEN -m.quantity ELSE 0 END) AS consumed,
                   MAX(m.moved_at::date)                                     AS last_moved
              FROM stock_movements m
             WHERE m.tenant_id = ${ctx.tenant.id}::uuid
               AND m.moved_at >= now() - (${USAGE_WINDOW_DAYS} || ' days')::interval
             GROUP BY m.stock_item_id
          ),
          ever AS (
            SELECT stock_item_id, MAX(moved_at::date) AS last_moved
              FROM stock_movements
             WHERE tenant_id = ${ctx.tenant.id}::uuid
             GROUP BY stock_item_id
          ),
          incoming AS (
            SELECT pol.stock_item_id,
                   SUM(pol.ordered_qty) - COALESCE(SUM(recv.accepted), 0) AS on_order
              FROM purchase_order_lines pol
              JOIN purchase_orders po
                ON po.id = pol.po_id AND po.status IN ('approved', 'part_received')
              LEFT JOIN (
                SELECT po_line_id, SUM(accepted_qty) AS accepted
                  FROM goods_receipt_lines
                 WHERE tenant_id = ${ctx.tenant.id}::uuid
                 GROUP BY po_line_id
              ) recv ON recv.po_line_id = pol.id
             WHERE pol.tenant_id = ${ctx.tenant.id}::uuid
               AND pol.stock_item_id IS NOT NULL
             GROUP BY pol.stock_item_id
          )
          SELECT i.id::text                                   AS id,
                 i.sku, i.name, i.uom,
                 i.reorder_level::text                        AS reorder_level,
                 i.reorder_quantity::text                     AS reorder_quantity,
                 i.lead_time_days,
                 i.first_stocked_on::text                     AS first_stocked_on,
                 COALESCE(i.standard_cost_minor, 0)::text     AS unit_cost,
                 COALESCE(SUM(b.quantity_on_hand), 0)::text   AS on_hand,
                 COALESCE(MAX(inc.on_order), 0)::text         AS on_order,
                 COALESCE(MAX(u.consumed), 0)::text           AS used_in_window,
                 MAX(ev.last_moved)::text                     AS last_moved_on,
                 v.legal_name                                 AS vendor_name
            FROM stock_items i
            LEFT JOIN stock_balances b
              ON b.stock_item_id = i.id AND b.tenant_id = i.tenant_id
            LEFT JOIN used u     ON u.stock_item_id = i.id
            LEFT JOIN ever ev    ON ev.stock_item_id = i.id
            LEFT JOIN incoming inc ON inc.stock_item_id = i.id
            LEFT JOIN vendors v  ON v.id = i.preferred_vendor_id
           WHERE i.tenant_id = ${ctx.tenant.id}::uuid
             AND i.is_active
             AND i.deleted_at IS NULL
           GROUP BY i.id, i.sku, i.name, i.uom, i.reorder_level,
                    i.reorder_quantity, i.lead_time_days, i.first_stocked_on,
                    i.standard_cost_minor, v.legal_name
        `);

        const positions: ItemPosition[] = rowsOf<Record<string, unknown>>(rows).map(
          (r) => ({
            stockItemId: String(r.id),
            sku: String(r.sku ?? ""),
            name: String(r.name ?? ""),
            uom: String(r.uom ?? "nos"),
            reorderLevel: r.reorder_level === null ? null : String(r.reorder_level),
            reorderQuantity:
              r.reorder_quantity === null ? null : String(r.reorder_quantity),
            leadTimeDays:
              r.lead_time_days === null ? null : Number(r.lead_time_days),
            onHand: normalise(r.on_hand),
            // ⚠️ Thousandths in the PO tables, decimals in the stock
            // ledger. Converted here so the pure library sees one unit.
            onOrder: fromThousandthsString(r.on_order),
            usedInWindow: normalise(r.used_in_window),
            windowDays: USAGE_WINDOW_DAYS,
            unitCostMinor: BigInt(String(r.unit_cost ?? "0")),
            preferredVendorName: (r.vendor_name as string | null) ?? null,
            lastMovedOn: (r.last_moved_on as string | null) ?? null,
            firstStockedOn: (r.first_stocked_on as string | null) ?? null,
          }),
        );

        const reorder = suggestReorders(positions, today);
        const deadStock = findDeadStock(positions, today);

        return {
          ok: true as const,
          data: {
            reorder,
            deadStock,
            reorderValueMinor: reorder
              .reduce((a, r) => a + r.estimatedCostMinor, 0n)
              .toString(),
            deadStockValueMinor: deadStock
              .reduce((a, d) => a + d.valueMinor, 0n)
              .toString(),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getInventoryReports");
  }
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** ⚠️ `numeric` arrives as a string of unpredictable precision. */
function normalise(v: unknown): string {
  const n = String(v ?? "0");
  const [w = "0", f = ""] = n.split(".");
  return `${w}.${(f + "000").slice(0, 3)}`;
}

function fromThousandthsString(v: unknown): string {
  const raw = BigInt(String(v ?? "0").split(".")[0] || "0");
  const neg = raw < 0n;
  const a = neg ? -raw : raw;
  return `${neg ? "-" : ""}${a / 1000n}.${(a % 1000n).toString().padStart(3, "0")}`;
}
