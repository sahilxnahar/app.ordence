"use server";

/**
 * Ordence — ⭐ Inventory Actions
 * Version: v0.40.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that exports
 * anything else publishes it as an RPC endpoint reachable by anyone on
 * the internet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DOES NOT DO, AND WHY THAT IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 * It does not compute a balance. It does not decide whether stock may go
 * negative. It does not check that a reservation fits. Every one of those
 * lives in `SQL-FILES/0029_phase40_inventory.sql`, because this is one
 * write path and a warehouse scanner posting through the Phase 41 REST
 * API is another — and the scanner is the one that will fire the same
 * dispatch twice when the network hiccups.
 *
 * ⭐ THERE IS NO `updateMovement` AND NO `deleteMovement`, AND THERE NEVER
 * WILL BE. The ledger is append-only. A mistake is answered by
 * `reverseMovement`, which posts an equal and opposite row naming the one
 * it reverses. Writing the edit function "just for admins" is how the
 * guarantee dies, because the admin path is the one that gets used at 6pm
 * when something is wrong and somebody is in a hurry.
 *
 * ⚠️ QUANTITIES CROSS THE BOUNDARY AS STRINGS. `numeric(18,3)` does not
 * survive a round trip through a JS float — 12.5 tonnes becomes
 * 12.499999999999998, and a delivery challan that does not add up is an
 * argument with a customer.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  warehouses,
  stockItems,
  stockMovements,
  stockBalances,
  stockReservations,
  INWARD_REASONS,
  OUTWARD_REASONS,
  BIDIRECTIONAL_REASONS,
} from "@/db/schema/inventory";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, salesFail, toSalesActionError } from "@/server/sales/guards";
import { serializeAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const FEATURE = "inventory.stock" as const;

const quantityString = z
  .string()
  .trim()
  .regex(/^-?\d{1,15}(\.\d{1,3})?$/, "Enter a quantity with up to three decimals.");

const positiveQuantity = quantityString.refine(
  (v) => Number(v) > 0,
  "Quantity must be greater than zero.",
);

const minorAmount = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.")
  .transform((v) => BigInt(v));

const ALL_REASONS = [
  ...INWARD_REASONS,
  ...OUTWARD_REASONS,
  ...BIDIRECTIONAL_REASONS,
] as const;

/* ================================================================== */
/* WAREHOUSES                                                          */
/* ================================================================== */

const warehouseSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(1, "Give the store a short code.").max(40),
  name: z.string().trim().min(1, "Give the store a name.").max(200),
  warehouseType: z
    .enum(["own", "site", "consignment", "transit", "third_party", "quarantine"])
    .default("own"),
  projectId: z.string().uuid().optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  stateCode: z.string().trim().length(2).optional().nullable(),
  gstin: z.string().trim().length(15).optional().nullable(),
  /**
   * ⚠️ SURFACED AS AN EXPLICIT CHOICE, NEVER A SILENT DEFAULT. Switching
   * this on means every valuation for this store depends on the
   * paperwork catching up with the lorry.
   */
  allowNegativeStock: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export async function saveWarehouse(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = warehouseSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "inventory:warehouse:save",
      feature: FEATURE,
      permission: "inventory.warehouses.manage",
    });

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          await tx
            .update(warehouses)
            .set({
              code: data.code,
              name: data.name,
              warehouseType: data.warehouseType,
              projectId: data.projectId ?? null,
              city: data.city ?? null,
              state: data.state ?? null,
              stateCode: data.stateCode ?? null,
              gstin: data.gstin ?? null,
              allowNegativeStock: data.allowNegativeStock,
              notes: data.notes ?? null,
              updatedBy: ctx.user.id,
            })
            .where(
              and(eq(warehouses.tenantId, ctx.tenant.id), eq(warehouses.id, data.id)),
            );
          return data.id;
        }

        const [row] = await tx
          .insert(warehouses)
          .values({
            tenantId: ctx.tenant.id,
            code: data.code,
            name: data.name,
            warehouseType: data.warehouseType,
            projectId: data.projectId ?? null,
            city: data.city ?? null,
            state: data.state ?? null,
            stateCode: data.stateCode ?? null,
            gstin: data.gstin ?? null,
            allowNegativeStock: data.allowNegativeStock,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: warehouses.id });

        if (!row) throw new Error("The store could not be created.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "warehouse",
      resourceId: id,
      newValue: { code: data.code, allowNegativeStock: data.allowNegativeStock },
      // Allowing negative stock changes what every valuation for this
      // store means, so it is worth finding in an audit trail later.
      severity: data.allowNegativeStock ? "notice" : "info",
    });

    revalidatePath("/inventory");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "saveWarehouse");
  }
}

/* ================================================================== */
/* STOCK ITEMS                                                         */
/* ================================================================== */

const stockItemSchema = z.object({
  id: z.string().uuid().optional(),
  assetId: z.string().uuid().optional().nullable(),
  sku: z.string().trim().min(1, "Every stock item needs an SKU.").max(100),
  name: z.string().trim().min(1).max(300),
  description: z.string().trim().max(2000).optional().nullable(),
  uom: z.string().trim().min(1).max(20).default("nos"),
  trackingMode: z.enum(["none", "batch", "serial"]).default("none"),
  valuationMethod: z
    .enum(["fifo", "weighted_average", "specific", "standard"])
    .default("weighted_average"),
  standardCostMinor: minorAmount.optional().nullable(),
  reorderLevel: quantityString.optional().nullable(),
  reorderQuantity: quantityString.optional().nullable(),
  leadTimeDays: z.number().int().min(0).max(3650).optional().nullable(),
  shelfLifeDays: z.number().int().min(0).max(36500).optional().nullable(),
  hsnSacCode: z.string().trim().max(20).optional().nullable(),
});

export async function saveStockItem(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = stockItemSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "inventory:item:save",
      feature: FEATURE,
      permission: "inventory.items.manage",
    });

    const values = {
      assetId: data.assetId ?? null,
      sku: data.sku,
      name: data.name,
      description: data.description ?? null,
      uom: data.uom,
      trackingMode: data.trackingMode,
      valuationMethod: data.valuationMethod,
      standardCostMinor: data.standardCostMinor ?? null,
      reorderLevel: data.reorderLevel ?? null,
      reorderQuantity: data.reorderQuantity ?? null,
      leadTimeDays: data.leadTimeDays ?? null,
      shelfLifeDays: data.shelfLifeDays ?? null,
      hsnSacCode: data.hsnSacCode ?? null,
      updatedBy: ctx.user.id,
    };

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          await tx
            .update(stockItems)
            .set(values)
            .where(
              and(eq(stockItems.tenantId, ctx.tenant.id), eq(stockItems.id, data.id)),
            );
          return data.id;
        }
        const [row] = await tx
          .insert(stockItems)
          .values({ tenantId: ctx.tenant.id, createdBy: ctx.user.id, ...values })
          .returning({ id: stockItems.id });
        if (!row) throw new Error("The stock item could not be created.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "stock_item",
      resourceId: id,
      newValue: { sku: data.sku, valuationMethod: data.valuationMethod },
    });

    revalidatePath("/inventory");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "saveStockItem");
  }
}

/* ================================================================== */
/* ⭐ MOVEMENTS — INSERT ONLY                                           */
/* ================================================================== */

const movementSchema = z.object({
  stockItemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  /**
   * ⚠️ SIGNED, AND THE SIGN IS THE CALLER'S RESPONSIBILITY. The database
   * checks it against the stated reason and refuses a mismatch, which is
   * better than silently flipping it — a caller whose sign is wrong has a
   * bug, and quietly correcting it hides the bug while leaving every
   * other consequence of it in place.
   */
  quantity: quantityString.refine((v) => Number(v) !== 0, "Quantity cannot be zero."),
  reason: z.enum(ALL_REASONS as unknown as [string, ...string[]]),
  unitCostMinor: minorAmount.optional().nullable(),
  batchNo: z.string().trim().max(100).optional().nullable(),
  serialNo: z.string().trim().max(120).optional().nullable(),
  expiryDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  salesOrderId: z.string().uuid().optional().nullable(),
  salesOrderLineId: z.string().uuid().optional().nullable(),
  documentNo: z.string().trim().max(80).optional().nullable(),
  adjustmentNote: z.string().trim().max(2000).optional().nullable(),
  approvedBy: z.string().uuid().optional().nullable(),
});

export async function postMovement(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = movementSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "inventory:movement:post",
      feature: FEATURE,
      permission: "inventory.movements.post",
      // An adjustment is somebody overruling the system; support staff
      // wearing a customer's face may not do it silently on their behalf.
      impersonationOperation:
        data.reason === "adjustment" ? "adjust:stock" : undefined,
    });

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(stockMovements)
          .values({
            tenantId: ctx.tenant.id,
            stockItemId: data.stockItemId,
            warehouseId: data.warehouseId,
            quantity: data.quantity,
            reason: data.reason as never,
            unitCostMinor: data.unitCostMinor ?? null,
            batchNo: data.batchNo ?? null,
            serialNo: data.serialNo ?? null,
            expiryDate: data.expiryDate ?? null,
            salesOrderId: data.salesOrderId ?? null,
            salesOrderLineId: data.salesOrderLineId ?? null,
            documentNo: data.documentNo ?? null,
            adjustmentNote: data.adjustmentNote ?? null,
            approvedBy: data.approvedBy ?? null,
            createdBy: ctx.user.id,
            impersonationId: ctx.impersonationId,
          })
          .returning({ id: stockMovements.id });
        if (!row) throw new Error("The movement could not be posted.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "stock_movement",
      resourceId: id,
      newValue: { quantity: data.quantity, reason: data.reason },
      reason: data.adjustmentNote ?? undefined,
      severity: data.reason === "adjustment" ? "warning" : "info",
    });

    revalidatePath("/inventory");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "postMovement");
  }
}

/**
 * ⭐ THE ONLY WAY TO UNDO A MOVEMENT.
 *
 * ⚠️ THE QUANTITY IS READ FROM THE ORIGINAL AND NEGATED HERE — it is not
 * accepted from the caller. A partial reversal posted as a full one, or a
 * reversal for a quantity that was never there, leaves a balance that is
 * wrong in a way that looks deliberate and reconciles to nothing.
 */
export async function reverseMovement(input: unknown): Promise<
  ActionResult<{ id: string; reversedQuantity: string }>
> {
  try {
    const data = z
      .object({
        movementId: z.string().uuid(),
        reason: z
          .string()
          .trim()
          .min(10, "Say why this is being reversed — it stays on the record.")
          .max(2000),
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "inventory:movement:reverse",
      feature: FEATURE,
      permission: "inventory.movements.post",
      impersonationOperation: "adjust:stock",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [original] = await tx
          .select()
          .from(stockMovements)
          .where(
            and(
              eq(stockMovements.tenantId, ctx.tenant.id),
              eq(stockMovements.id, data.movementId),
            ),
          )
          .limit(1);

        if (!original) throw new Error("That movement does not exist.");
        if (original.reversesMovementId) {
          throw new Error(
            "That row is itself a reversal. Reversing a reversal leaves a chain nobody can read — post the correct movement instead.",
          );
        }

        const [existing] = await tx
          .select({ id: stockMovements.id })
          .from(stockMovements)
          .where(
            and(
              eq(stockMovements.tenantId, ctx.tenant.id),
              eq(stockMovements.reversesMovementId, data.movementId),
            ),
          )
          .limit(1);

        if (existing) {
          throw new Error(
            "That movement has already been reversed. Reversing it twice would take the stock out a second time.",
          );
        }

        const negated = original.quantity.startsWith("-")
          ? original.quantity.slice(1)
          : `-${original.quantity}`;

        const [row] = await tx
          .insert(stockMovements)
          .values({
            tenantId: ctx.tenant.id,
            stockItemId: original.stockItemId,
            warehouseId: original.warehouseId,
            quantity: negated,
            reason: "reversal",
            unitCostMinor: original.unitCostMinor,
            batchNo: original.batchNo,
            serialNo: original.serialNo,
            reversesMovementId: original.id,
            adjustmentNote: data.reason,
            documentNo: original.documentNo,
            createdBy: ctx.user.id,
            impersonationId: ctx.impersonationId,
          })
          .returning({ id: stockMovements.id });

        if (!row) throw new Error("The reversal could not be posted.");
        return { id: row.id, reversedQuantity: negated };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "stock_movement",
      resourceId: result.id,
      metadata: { reverses: data.movementId },
      reason: data.reason,
      severity: "warning",
    });

    revalidatePath("/inventory");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "reverseMovement");
  }
}

/* ================================================================== */
/* RESERVATIONS                                                        */
/* ================================================================== */

export async function reserveStock(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = z
      .object({
        stockItemId: z.string().uuid(),
        warehouseId: z.string().uuid(),
        quantity: positiveQuantity,
        batchNo: z.string().trim().max(100).optional().nullable(),
        salesOrderId: z.string().uuid().optional().nullable(),
        salesOrderLineId: z.string().uuid().optional().nullable(),
        expiresAt: z.string().trim().min(1).optional().nullable(),
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "inventory:reserve",
      feature: FEATURE,
      permission: "inventory.reservations.manage",
    });

    /**
     * ⚠️ THE AVAILABILITY CHECK IS NOT DONE HERE. The trigger in SQL 0029
     * §7 locks the balance row before comparing, which is what makes the
     * answer true under concurrency. A check in TypeScript would read a
     * number that two people can read at once and both act on.
     */
    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(stockReservations)
          .values({
            tenantId: ctx.tenant.id,
            stockItemId: data.stockItemId,
            warehouseId: data.warehouseId,
            quantity: data.quantity,
            batchNo: data.batchNo ?? null,
            salesOrderId: data.salesOrderId ?? null,
            salesOrderLineId: data.salesOrderLineId ?? null,
            expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
            createdBy: ctx.user.id,
          })
          .returning({ id: stockReservations.id });
        if (!row) throw new Error("The reservation could not be created.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "stock_reservation",
      resourceId: id,
      newValue: { quantity: data.quantity },
    });

    revalidatePath("/inventory");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "reserveStock");
  }
}

export async function releaseReservation(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = z
      .object({
        id: z.string().uuid(),
        reason: z.string().trim().min(3).max(2000),
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "inventory:release",
      feature: FEATURE,
      permission: "inventory.reservations.manage",
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(stockReservations)
          .set({
            status: "released",
            releasedAt: new Date(),
            releaseReason: data.reason,
          })
          .where(
            and(
              eq(stockReservations.tenantId, ctx.tenant.id),
              eq(stockReservations.id, data.id),
            ),
          );
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "stock_reservation",
      resourceId: data.id,
      newValue: { status: "released" },
      reason: data.reason,
    });

    revalidatePath("/inventory");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toSalesActionError(err, "releaseReservation");
  }
}

/* ================================================================== */
/* READS                                                               */
/* ================================================================== */

export type StockRow = {
  stockItemId: string;
  sku: string;
  name: string;
  uom: string;
  warehouseId: string;
  warehouseName: string;
  warehouseAllowsNegative: boolean;
  batchNo: string;
  onHand: string;
  reserved: string;
  available: string;
  valueMinor: string;
  reorderLevel: string | null;
  lastMovementAt: string | null;
};

/**
 * ⭐ AVAILABLE IS COMPUTED HERE AND SHOWN AS ITS OWN COLUMN.
 *
 * ⚠️ IT IS NOT LEFT FOR THE READER TO SUBTRACT. A screen that shows "on
 * hand 400" and "reserved 300" in two columns and expects a salesperson
 * to do the arithmetic under time pressure will get the same answer as a
 * screen that only showed 400, most of the time.
 */
export async function getStockPosition(): Promise<
  ActionResult<{ rows: StockRow[] }>
> {
  try {
    const ctx = await requirePermission("inventory.stock.read");

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx
          .select({
            stockItemId: stockBalances.stockItemId,
            sku: stockItems.sku,
            name: stockItems.name,
            uom: stockItems.uom,
            reorderLevel: stockItems.reorderLevel,
            warehouseId: stockBalances.warehouseId,
            warehouseName: warehouses.name,
            warehouseAllowsNegative: warehouses.allowNegativeStock,
            batchNo: stockBalances.batchNo,
            onHand: stockBalances.quantityOnHand,
            reserved: stockBalances.quantityReserved,
            valueMinor: stockBalances.valueMinor,
            lastMovementAt: stockBalances.lastMovementAt,
          })
          .from(stockBalances)
          .innerJoin(
            stockItems,
            and(
              eq(stockItems.id, stockBalances.stockItemId),
              eq(stockItems.tenantId, ctx.tenant.id),
            ),
          )
          .innerJoin(
            warehouses,
            and(
              eq(warehouses.id, stockBalances.warehouseId),
              eq(warehouses.tenantId, ctx.tenant.id),
            ),
          )
          .where(eq(stockBalances.tenantId, ctx.tenant.id))
          .orderBy(stockItems.name, warehouses.name)
          .limit(2000),
      { impersonationId: ctx.impersonationId },
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          stockItemId: r.stockItemId,
          sku: r.sku,
          name: r.name,
          uom: r.uom,
          warehouseId: r.warehouseId,
          warehouseName: r.warehouseName,
          warehouseAllowsNegative: r.warehouseAllowsNegative,
          batchNo: r.batchNo,
          onHand: r.onHand,
          reserved: r.reserved,
          available: (Number(r.onHand) - Number(r.reserved)).toFixed(3),
          valueMinor: serializeAmount(r.valueMinor),
          reorderLevel: r.reorderLevel,
          lastMovementAt: r.lastMovementAt ? r.lastMovementAt.toISOString() : null,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getStockPosition");
  }
}

export type MovementRow = {
  id: string;
  movedAt: string;
  quantity: string;
  reason: string;
  documentNo: string | null;
  batchNo: string | null;
  valueMinor: string;
  isReversal: boolean;
  reversesMovementId: string | null;
  adjustmentNote: string | null;
};

export async function getMovementHistory(args?: {
  stockItemId?: string;
  warehouseId?: string;
  limit?: number;
}): Promise<ActionResult<{ rows: MovementRow[] }>> {
  try {
    const ctx = await requirePermission("inventory.stock.read");
    const limit = Math.min(Math.max(args?.limit ?? 200, 1), 1000);

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const conditions = [eq(stockMovements.tenantId, ctx.tenant.id)];
        if (args?.stockItemId)
          conditions.push(eq(stockMovements.stockItemId, args.stockItemId));
        if (args?.warehouseId)
          conditions.push(eq(stockMovements.warehouseId, args.warehouseId));

        return tx
          .select({
            id: stockMovements.id,
            movedAt: stockMovements.movedAt,
            quantity: stockMovements.quantity,
            reason: stockMovements.reason,
            documentNo: stockMovements.documentNo,
            batchNo: stockMovements.batchNo,
            valueMinor: stockMovements.valueMinor,
            reversesMovementId: stockMovements.reversesMovementId,
            adjustmentNote: stockMovements.adjustmentNote,
          })
          .from(stockMovements)
          .where(and(...conditions))
          .orderBy(desc(stockMovements.movedAt))
          .limit(limit);
      },
      { impersonationId: ctx.impersonationId },
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          movedAt: r.movedAt.toISOString(),
          quantity: r.quantity,
          reason: r.reason,
          documentNo: r.documentNo,
          batchNo: r.batchNo,
          valueMinor: serializeAmount(r.valueMinor),
          isReversal: r.reversesMovementId !== null,
          reversesMovementId: r.reversesMovementId,
          adjustmentNote: r.adjustmentNote,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getMovementHistory");
  }
}

/**
 * ⭐ THE LEDGER-VERSUS-CACHE RECONCILIATION.
 *
 * ⚠️ THIS IS THE FUNCTION THAT PROVES THE DESIGN. `stock_balances` is a
 * cache maintained by a trigger; this sums the ledger independently and
 * compares. If it ever reports a discrepancy, the LEDGER is right and the
 * cache is rebuilt from it — which is possible only because no movement
 * was ever edited or deleted.
 *
 * A system where this check cannot be written is a system where a wrong
 * balance has no explanation and no remedy but a physical count.
 */
export async function reconcileStockLedger(): Promise<
  ActionResult<{
    checked: number;
    discrepancies: Array<{
      stockItemId: string;
      warehouseId: string;
      batchNo: string;
      cached: string;
      ledger: string;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission("inventory.stock.read");

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx.execute(sql`
          SELECT b.stock_item_id::text        AS stock_item_id,
                 b.warehouse_id::text         AS warehouse_id,
                 b.batch_no                   AS batch_no,
                 b.quantity_on_hand::text     AS cached,
                 COALESCE(l.total, 0)::text   AS ledger
            FROM stock_balances b
            LEFT JOIN (
              SELECT stock_item_id, warehouse_id,
                     COALESCE(batch_no, '') AS batch_no,
                     SUM(quantity) AS total
                FROM stock_movements
               WHERE tenant_id = ${ctx.tenant.id}
               GROUP BY stock_item_id, warehouse_id, COALESCE(batch_no, '')
            ) l
              ON l.stock_item_id = b.stock_item_id
             AND l.warehouse_id  = b.warehouse_id
             AND l.batch_no      = b.batch_no
           WHERE b.tenant_id = ${ctx.tenant.id}
        `),
      { impersonationId: ctx.impersonationId },
    );

    // ⚠️ The driver returns either a QueryResult with a `.rows` array or a
    // bare array depending on which client is in play. Narrowing through
    // `unknown` rather than asserting one shape keeps both working.
    const raw = rows as unknown;
    const all: unknown[] = Array.isArray(raw)
      ? raw
      : ((raw as { rows?: unknown[] })?.rows ?? []);
    const list = all as Array<{
      stock_item_id: string;
      warehouse_id: string;
      batch_no: string;
      cached: string;
      ledger: string;
    }>;

    const discrepancies = list
      .filter((r) => Number(r.cached) !== Number(r.ledger))
      .map((r) => ({
        stockItemId: r.stock_item_id,
        warehouseId: r.warehouse_id,
        batchNo: r.batch_no,
        cached: r.cached,
        ledger: r.ledger,
      }));

    return { ok: true, data: { checked: list.length, discrepancies } };
  } catch (err) {
    return toSalesActionError(err, "reconcileStockLedger");
  }
}
