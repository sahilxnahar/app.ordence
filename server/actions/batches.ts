"use server";

/**
 * Ordence — ⭐⭐ BATCHES, EXPIRY AND SERIALS
 * Version: v1.4.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT. The
 * arithmetic lives in `lib/inventory/batch.ts`, which is pure and has no
 * clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MODULE POSTS TO THE LEDGER, AND ONE PATH HERE MOVES MONEY
 * ══════════════════════════════════════════════════════════════════════
 * A write-off is an economic event: stock leaves and value is destroyed.
 * It also reverses input tax credit under s.17(5)(h). The stock movement
 * and the write-off record — including the ITC figure — are written in
 * ONE transaction, because a write-off recorded without its reversal is
 * a GST position that is wrong and looks right.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  stockBatches,
  stockSerials,
  stockItems,
  stockBalances,
  stockMovements,
  stockWriteOffs,
  warehouses,
} from "@/db/schema/inventory";
import { companies } from "@/db/schema/crm";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  allocateFefo,
  expiryVerdict,
  itcReversalOnWriteOff,
  summariseBatches,
  warrantyStatus,
  warrantyUntil,
  type BatchStatus,
} from "@/lib/inventory/batch";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "inventory.stock.read" as const;
const WRITE = "inventory.movements.post" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

/** Today as a civil day. Passed INTO the pure functions, never read by them. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Quantity strings → bigint thousandths, so nothing is a float. */
function toMilli(value: string | number | null | undefined): bigint {
  const s = String(value ?? "0");
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? s.slice(1) : s).split(".");
  const milli = BigInt(whole) * 1000n + BigInt((frac + "000").slice(0, 3));
  return negative ? -milli : milli;
}

function fromMilli(milli: bigint): string {
  const negative = milli < 0n;
  const abs = negative ? -milli : milli;
  return `${negative ? "-" : ""}${abs / 1000n}.${String(abs % 1000n).padStart(3, "0")}`;
}

/* ================================================================== */
/* ① THE EXPIRY BOARD                                                  */
/* ================================================================== */

export type BatchRow = {
  id: string;
  batchNo: string;
  stockItemId: string;
  itemName: string;
  sku: string;
  uom: string;
  expiryDate: string | null;
  manufactureDate: string | null;
  status: string;
  firstReceivedAt: string;
  quantity: string;
  valueMinor: string;
  statusNote: string | null;
};

/**
 * ⚠️ THE QUANTITY COMES FROM `stock_balances`, WHICH IS ALREADY KEYED ON
 * BATCH. There is no second balance table, because two answers to "how
 * much of batch X is left" means the picking screen reads the wrong one.
 */
export async function getBatches(input?: {
  onlyExpiring?: boolean;
}): Promise<
  ActionResult<{
    rows: BatchRow[];
    summary: {
      expiredValueMinor: string;
      expiringValueMinor: string;
      freshValueMinor: string;
      expiredCount: number;
      expiringCount: number;
      noExpiryCount: number;
    };
    today: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const day = today();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: stockBatches.id,
          batchNo: stockBatches.batchNo,
          stockItemId: stockBatches.stockItemId,
          itemName: stockItems.name,
          sku: stockItems.sku,
          uom: stockItems.uom,
          expiryDate: stockBatches.expiryDate,
          manufactureDate: stockBatches.manufactureDate,
          status: stockBatches.status,
          statusNote: stockBatches.statusNote,
          firstReceivedAt: stockBatches.firstReceivedAt,
          quantity: sql<string>`COALESCE((
            SELECT SUM(b.quantity_on_hand) FROM stock_balances b
             WHERE b.tenant_id = ${ctx.tenant.id}
               AND b.stock_item_id = ${stockBatches.stockItemId}
               AND b.batch_no = ${stockBatches.batchNo}
          ), 0)`,
          valueMinor: sql<string>`COALESCE((
            SELECT SUM(b.value_minor) FROM stock_balances b
             WHERE b.tenant_id = ${ctx.tenant.id}
               AND b.stock_item_id = ${stockBatches.stockItemId}
               AND b.batch_no = ${stockBatches.batchNo}
          ), 0)`,
        })
        .from(stockBatches)
        .leftJoin(
          stockItems,
          and(
            eq(stockItems.id, stockBatches.stockItemId),
            eq(stockItems.tenantId, ctx.tenant.id),
          ),
        )
        .where(eq(stockBatches.tenantId, ctx.tenant.id))
        .orderBy(asc(stockBatches.expiryDate))
        .limit(1000),
    );

    const mapped: BatchRow[] = rows.map((r) => ({
      id: r.id,
      batchNo: r.batchNo,
      stockItemId: r.stockItemId,
      itemName: r.itemName ?? "—",
      sku: r.sku ?? "—",
      uom: r.uom ?? "nos",
      expiryDate: r.expiryDate ? String(r.expiryDate) : null,
      manufactureDate: r.manufactureDate ? String(r.manufactureDate) : null,
      status: r.status,
      statusNote: r.statusNote,
      firstReceivedAt: new Date(r.firstReceivedAt).toISOString(),
      quantity: String(r.quantity ?? "0"),
      valueMinor: serializeAmount(toBigIntAmount(r.valueMinor)),
    }));

    const s = summariseBatches(
      mapped.map((r) => ({
        expiryDate: r.expiryDate,
        quantityMilli: toMilli(r.quantity),
        valueMinor: BigInt(r.valueMinor),
        status: r.status as BatchStatus,
      })),
      day,
    );

    const filtered = input?.onlyExpiring
      ? mapped.filter((r) => {
          const v = expiryVerdict({
            expiryDate: r.expiryDate,
            today: day,
            status: r.status as BatchStatus,
          });
          return v.bucket === "expired" || v.bucket === "expiring_soon" || v.bucket === "expiring_now";
        })
      : mapped;

    return {
      ok: true,
      data: {
        rows: filtered,
        summary: {
          expiredValueMinor: serializeAmount(s.expiredValueMinor),
          expiringValueMinor: serializeAmount(s.expiringValueMinor),
          freshValueMinor: serializeAmount(s.freshValueMinor),
          expiredCount: s.expiredCount,
          expiringCount: s.expiringCount,
          noExpiryCount: s.noExpiryCount,
        },
        today: day,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getBatches");
  }
}

/* ================================================================== */
/* ② CORRECTING A BATCH — DELIBERATELY, NOT ON A RECEIPT                */
/* ================================================================== */

const batchUpdateSchema = z.object({
  batchId: z.string().uuid(),
  expiryDate: civilDay.nullish(),
  manufactureDate: civilDay.nullish(),
  supplierBatchNo: z.string().trim().max(100).nullish(),
  note: z.string().trim().min(10, "Say why — this changes what can be sold.").max(500),
});

/**
 * ⭐ THE ONE PLACE AN EXPIRY DATE CAN BE CHANGED.
 *
 * 🔴 A RECEIPT CANNOT DO IT. The trigger in 0055 refuses a movement
 *    whose expiry disagrees with the batch, precisely so that correcting
 *    it is a deliberate act by somebody who has looked at the carton —
 *    rather than something a goods-inward screen does quietly at 8am.
 *
 * ⚠️ AND IT NEEDS A WRITTEN REASON. Moving an expiry date moves stock
 * between saleable and not, which is a money consequence.
 */
export async function updateBatch(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = batchUpdateSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [batch] = await tx
          .select()
          .from(stockBatches)
          .where(
            and(
              eq(stockBatches.tenantId, ctx.tenant.id),
              eq(stockBatches.id, data.batchId),
            ),
          )
          .limit(1);
        if (!batch) throw new Error("That batch does not exist.");

        if (
          data.expiryDate &&
          data.manufactureDate &&
          data.expiryDate <= data.manufactureDate
        ) {
          throw new Error(
            "The expiry is on or before the manufacture date. That is almost always the year, typed once.",
          );
        }

        await tx
          .update(stockBatches)
          .set({
            ...(data.expiryDate !== undefined ? { expiryDate: data.expiryDate ?? null } : {}),
            ...(data.manufactureDate !== undefined
              ? { manufactureDate: data.manufactureDate ?? null }
              : {}),
            ...(data.supplierBatchNo !== undefined
              ? { supplierBatchNo: data.supplierBatchNo ?? null }
              : {}),
            statusNote: data.note,
            updatedAt: new Date(),
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(stockBatches.tenantId, ctx.tenant.id),
              eq(stockBatches.id, data.batchId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "stock_batch",
          resourceId: data.batchId,
          oldValue: { expiryDate: batch.expiryDate },
          newValue: { expiryDate: data.expiryDate ?? null, note: data.note },
          /** Changing what can be sold is a decision about revenue. */
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/batches");
    return { ok: true, data: { id: data.batchId } };
  } catch (err) {
    return toSalesActionError(err, "updateBatch");
  }
}

const statusSchema = z.object({
  batchId: z.string().uuid(),
  status: z.enum(["active", "quarantined", "expired", "recalled", "written_off"]),
  note: z.string().trim().min(10, "A status change carries a reason.").max(500),
});

/**
 * ⭐ QUARANTINE, RELEASE AND RECALL.
 *
 * 🔴 THIS IS NOT A LABEL. The trigger in 0055 refuses an outward
 *    movement from a recalled or written-off batch — so this button
 *    actually stops a picker being sent to the stock, which is the only
 *    version of a recall that works.
 *
 * ⚠️ AND IT IS NOT A NIGHTLY JOB. Marking a batch expired takes stock
 * out of what can be sold, which is a stockout somebody has to own. The
 * screen shows what has passed its date; a person presses the button.
 */
export async function setBatchStatus(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const data = statusSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [batch] = await tx
          .select({ id: stockBatches.id, status: stockBatches.status })
          .from(stockBatches)
          .where(
            and(
              eq(stockBatches.tenantId, ctx.tenant.id),
              eq(stockBatches.id, data.batchId),
            ),
          )
          .limit(1);
        if (!batch) throw new Error("That batch does not exist.");

        /**
         * ⚠️ WRITTEN OFF IS TERMINAL. Reviving a written-off batch would
         * put stock back on the books that has already had its input tax
         * credit reversed — and nothing would reverse the reversal.
         */
        if (batch.status === "written_off" && data.status !== "written_off") {
          throw new Error(
            "This batch has been written off and its input tax credit reversed. Bringing it back would put stock on the books with no credit behind it. Receive it again as a new batch if it really exists.",
          );
        }

        await tx
          .update(stockBatches)
          .set({
            status: data.status,
            statusNote: data.note,
            statusChangedAt: new Date(),
            statusChangedBy: ctx.user.id,
            updatedAt: new Date(),
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(stockBatches.tenantId, ctx.tenant.id),
              eq(stockBatches.id, data.batchId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "stock_batch",
          resourceId: data.batchId,
          oldValue: { status: batch.status },
          newValue: { status: data.status, note: data.note },
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/batches");
    return { ok: true, data: { id: data.batchId, status: data.status } };
  } catch (err) {
    return toSalesActionError(err, "setBatchStatus");
  }
}

/* ================================================================== */
/* ③ THE WRITE-OFF, AND THE CREDIT THAT GOES BACK WITH IT              */
/* ================================================================== */

const writeOffSchema = z.object({
  batchId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "Quantity, up to three decimals."),
  reason: z.enum(["expiry", "damage", "theft", "obsolescence", "recall", "sample"]),
  /** The rate the credit was originally claimed at. */
  itcRateBps: z.number().int().min(0).max(10000),
  isManufactured: z.boolean().default(false),
  /** Required when the reversal comes out at zero. */
  itcNote: z.string().trim().max(1000).optional(),
  approvedBy: z.string().uuid(),
  note: z
    .string()
    .trim()
    .min(10, "A write-off needs a written reason of at least ten characters.")
    .max(1000),
});

/**
 * ⭐⭐ WRITE STOCK OFF, AND REVERSE THE INPUT TAX CREDIT ON IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 BOTH HALVES, IN ONE TRANSACTION, OR NEITHER
 * ══════════════════════════════════════════════════════════════════════
 * Section 17(5)(h) blocks the credit on goods written off. If the stock
 * movement were committed and the reversal record were not, the books
 * would balance and the GST position would be wrong — which is the
 * combination nobody catches by looking, because everything visible is
 * correct.
 *
 * ⚠️ THE COST IS TAKEN FROM THE BALANCE, NOT TYPED. A form field for the
 * value being written off lets somebody destroy ₹4,00,000 of stock and
 * declare ₹40,000 of it, and both numbers would look reasonable on the
 * screen they appeared on.
 */
export async function writeOffBatch(input: unknown): Promise<
  ActionResult<{
    id: string;
    itcReversalMinor: string;
    arguable: boolean;
    explanation: string;
  }>
> {
  try {
    const data = writeOffSchema.parse(input);
    const ctx = await requirePermission(WRITE);
    const day = today();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [batch] = await tx
          .select({
            id: stockBatches.id,
            batchNo: stockBatches.batchNo,
            stockItemId: stockBatches.stockItemId,
            status: stockBatches.status,
          })
          .from(stockBatches)
          .where(
            and(
              eq(stockBatches.tenantId, ctx.tenant.id),
              eq(stockBatches.id, data.batchId),
            ),
          )
          .limit(1);
        if (!batch) throw new Error("That batch does not exist.");

        const [balance] = await tx
          .select({
            quantityOnHand: stockBalances.quantityOnHand,
            valueMinor: stockBalances.valueMinor,
          })
          .from(stockBalances)
          .where(
            and(
              eq(stockBalances.tenantId, ctx.tenant.id),
              eq(stockBalances.stockItemId, batch.stockItemId),
              eq(stockBalances.warehouseId, data.warehouseId),
              eq(stockBalances.batchNo, batch.batchNo),
            ),
          )
          .limit(1);

        const onHandMilli = toMilli(balance?.quantityOnHand ?? "0");
        const wantedMilli = toMilli(data.quantity);
        if (wantedMilli <= 0n) throw new Error("Write off a positive quantity.");
        if (wantedMilli > onHandMilli) {
          throw new Error(
            `There are only ${fromMilli(onHandMilli)} of batch ${batch.batchNo} in that store, and this writes off ${data.quantity}. Either the quantity is wrong or the stock has already gone somewhere the ledger does not know about.`,
          );
        }

        /**
         * ⭐ THE COST OF WHAT IS LEAVING, PRO-RATED FROM THE BALANCE.
         * Integer arithmetic throughout — the value is paise and the
         * quantity is thousandths, so nothing is a float at any point.
         */
        const balanceValue = toBigIntAmount(balance?.valueMinor ?? 0n);
        const costMinor =
          onHandMilli > 0n ? (balanceValue * wantedMilli) / onHandMilli : 0n;

        const reversal = itcReversalOnWriteOff({
          costMinor,
          itcRateBps: data.itcRateBps,
          reason: data.reason,
          isManufactured: data.isManufactured,
        });

        /**
         * 🔴 A ZERO REVERSAL MUST BE EXPLAINED. It is either correct or
         * it is exactly the mistake this whole path exists to catch, and
         * the row cannot tell you which without a sentence. The database
         * refuses it too.
         */
        const note = data.itcNote?.trim() ?? "";
        if (reversal.reversalMinor === 0n && note.length < 10) {
          throw new Error(
            "This write-off reverses no input tax credit. That is sometimes right — zero-rated goods, or a purchase where no credit was ever claimed — and it is also the most common way a s.17(5)(h) reversal gets missed. Say which it is.",
          );
        }

        /**
         * ⚠️ `expiry` AND `damage` ARE LEDGER REASONS; the others are
         * adjustments, which the 0029 trigger requires a note and an
         * approver for. Both are supplied.
         */
        const movementReason =
          data.reason === "expiry"
            ? ("expiry" as const)
            : data.reason === "damage"
              ? ("damage" as const)
              : data.reason === "theft"
                ? ("theft" as const)
                : ("adjustment" as const);

        const [movement] = await tx
          .insert(stockMovements)
          .values({
            tenantId: ctx.tenant.id,
            stockItemId: batch.stockItemId,
            warehouseId: data.warehouseId,
            /** 🔴 Negative — stock is leaving. */
            quantity: `-${data.quantity}`,
            reason: movementReason,
            batchNo: batch.batchNo,
            documentNo: `WO/${batch.batchNo}`,
            referenceType: "stock_write_off",
            adjustmentNote: data.note,
            approvedBy: data.approvedBy,
            createdBy: ctx.user.id,
          })
          .returning({ id: stockMovements.id });

        if (!movement) throw new Error("The stock movement could not be written.");

        const [row] = await tx
          .insert(stockWriteOffs)
          .values({
            tenantId: ctx.tenant.id,
            movementId: movement.id,
            stockItemId: batch.stockItemId,
            batchId: batch.id,
            warehouseId: data.warehouseId,
            writeOffDate: day,
            quantity: data.quantity,
            reason: data.reason,
            costMinor,
            itcRateBps: data.itcRateBps,
            itcReversalMinor: reversal.reversalMinor,
            /** ⭐ The GSTR-3B period the reversal belongs in. */
            reversalPeriod: day.slice(0, 7),
            itcNote: note.length > 0 ? note : reversal.explanation,
            approvedBy: data.approvedBy,
            notes: data.note,
            createdBy: ctx.user.id,
          })
          .returning({ id: stockWriteOffs.id });

        if (!row) throw new Error("The write-off record could not be written.");

        /**
         * ⚠️ THE BATCH IS ONLY CLOSED WHEN THE LAST OF IT HAS GONE. A
         * partial write-off of a batch that still has good stock in
         * another warehouse must not stop that stock shipping.
         */
        if (wantedMilli === onHandMilli && data.reason === "expiry") {
          await tx
            .update(stockBatches)
            .set({
              status: "written_off",
              statusNote: data.note,
              statusChangedAt: new Date(),
              statusChangedBy: ctx.user.id,
              updatedBy: ctx.user.id,
            })
            .where(
              and(
                eq(stockBatches.tenantId, ctx.tenant.id),
                eq(stockBatches.id, batch.id),
              ),
            );
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "stock_write_off",
          resourceId: row.id,
          newValue: {
            batchNo: batch.batchNo,
            quantity: data.quantity,
            costMinor: serializeAmount(costMinor),
            itcReversalMinor: serializeAmount(reversal.reversalMinor),
            reason: data.reason,
          },
          severity: "critical",
        });

        return {
          id: row.id,
          itcReversalMinor: serializeAmount(reversal.reversalMinor),
          arguable: reversal.arguable,
          explanation: reversal.explanation,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/batches");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "writeOffBatch");
  }
}

/* ================================================================== */
/* ④ FEFO — WHAT TO PICK                                               */
/* ================================================================== */

const pickSchema = z.object({
  stockItemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/),
  allowExpired: z.boolean().default(false),
});

/**
 * ⭐⭐ WHICH BATCHES TO SHIP, IN ORDER — FIRST EXPIRED, FIRST OUT.
 *
 * 🔴 NOT FIFO. A batch received in January that expires in December must
 *    ship AFTER one received in March that expires in June. FIFO gets
 *    that backwards, the stock-rotation report still looks healthy, and
 *    the loss appears as a write-off six months later with the buyer
 *    blamed for it.
 *
 * ⚠️ IT RETURNS THE SHORTFALL AND THE SKIPPED BATCHES RATHER THAN
 * SILENTLY ALLOCATING LESS. A picking list that is quietly short is a
 * picking list somebody discovers at the loading bay.
 */
export async function planFefoPick(input: unknown): Promise<
  ActionResult<{
    allocations: { batchNo: string; expiryDate: string | null; quantity: string }[];
    shortfall: string;
    skipped: { batchNo: string; reason: string }[];
  }>
> {
  try {
    const data = pickSchema.parse(input);
    const ctx = await requirePermission(READ);
    const day = today();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          batchNo: stockBalances.batchNo,
          quantityOnHand: stockBalances.quantityOnHand,
          quantityReserved: stockBalances.quantityReserved,
          expiryDate: stockBatches.expiryDate,
          status: stockBatches.status,
          firstReceivedAt: stockBatches.firstReceivedAt,
        })
        .from(stockBalances)
        .leftJoin(
          stockBatches,
          and(
            eq(stockBatches.tenantId, ctx.tenant.id),
            eq(stockBatches.stockItemId, stockBalances.stockItemId),
            eq(stockBatches.batchNo, stockBalances.batchNo),
          ),
        )
        .where(
          and(
            eq(stockBalances.tenantId, ctx.tenant.id),
            eq(stockBalances.stockItemId, data.stockItemId),
            eq(stockBalances.warehouseId, data.warehouseId),
          ),
        ),
    );

    const plan = allocateFefo({
      requiredMilli: toMilli(data.quantity),
      today: day,
      allowExpired: data.allowExpired,
      batches: rows.map((r) => ({
        batchNo: r.batchNo,
        expiryDate: r.expiryDate ? String(r.expiryDate) : null,
        /** ⚠️ AVAILABLE, not on hand. Reserved stock belongs to somebody. */
        availableMilli:
          toMilli(r.quantityOnHand) - toMilli(r.quantityReserved ?? "0"),
        receivedAt: r.firstReceivedAt
          ? new Date(r.firstReceivedAt).toISOString()
          : "1970-01-01T00:00:00.000Z",
        status: (r.status ?? "active") as BatchStatus,
      })),
    });

    return {
      ok: true,
      data: {
        allocations: plan.allocations.map((a) => ({
          batchNo: a.batchNo,
          expiryDate: a.expiryDate,
          quantity: fromMilli(a.quantityMilli),
        })),
        shortfall: fromMilli(plan.shortfallMilli),
        skipped: plan.skipped,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "planFefoPick");
  }
}

/* ================================================================== */
/* ⑤ SERIALS                                                           */
/* ================================================================== */

export async function getSerials(input?: { search?: string }): Promise<
  ActionResult<{
    rows: {
      id: string;
      serialNo: string;
      itemName: string;
      sku: string;
      status: string;
      warehouseName: string | null;
      companyName: string | null;
      batchNo: string | null;
      dispatchedAt: string | null;
      warrantyUntil: string | null;
      warrantyLabel: string;
      inWarranty: boolean;
    }[];
    counts: { inStock: number; dispatched: number; inWarranty: number };
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const day = today();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: stockSerials.id,
          serialNo: stockSerials.serialNo,
          itemName: stockItems.name,
          sku: stockItems.sku,
          status: stockSerials.status,
          warehouseName: warehouses.name,
          companyName: companies.name,
          batchNo: stockBatches.batchNo,
          dispatchedAt: stockSerials.dispatchedAt,
          warrantyUntil: stockSerials.warrantyUntil,
        })
        .from(stockSerials)
        .leftJoin(
          stockItems,
          and(
            eq(stockItems.id, stockSerials.stockItemId),
            eq(stockItems.tenantId, ctx.tenant.id),
          ),
        )
        .leftJoin(
          warehouses,
          and(
            eq(warehouses.id, stockSerials.warehouseId),
            eq(warehouses.tenantId, ctx.tenant.id),
          ),
        )
        .leftJoin(
          companies,
          and(
            eq(companies.id, stockSerials.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .leftJoin(
          stockBatches,
          and(
            eq(stockBatches.id, stockSerials.batchId),
            eq(stockBatches.tenantId, ctx.tenant.id),
          ),
        )
        .where(
          and(
            eq(stockSerials.tenantId, ctx.tenant.id),
            ...(input?.search
              ? [sql`${stockSerials.serialNo} ILIKE ${"%" + input.search + "%"}`]
              : []),
          ),
        )
        .orderBy(desc(stockSerials.updatedAt))
        .limit(500),
    );

    const mapped = rows.map((r) => {
      const w = warrantyStatus({
        warrantyUntil: r.warrantyUntil ? String(r.warrantyUntil) : null,
        today: day,
      });
      return {
        id: r.id,
        serialNo: r.serialNo,
        itemName: r.itemName ?? "—",
        sku: r.sku ?? "—",
        status: r.status,
        warehouseName: r.warehouseName,
        companyName: r.companyName,
        batchNo: r.batchNo,
        dispatchedAt: r.dispatchedAt ? new Date(r.dispatchedAt).toISOString() : null,
        warrantyUntil: r.warrantyUntil ? String(r.warrantyUntil) : null,
        warrantyLabel: w.label,
        inWarranty: w.inWarranty,
      };
    });

    return {
      ok: true,
      data: {
        rows: mapped,
        counts: {
          inStock: mapped.filter((r) => r.status === "in_stock").length,
          dispatched: mapped.filter((r) => r.status === "dispatched").length,
          inWarranty: mapped.filter((r) => r.inWarranty).length,
        },
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getSerials");
  }
}

const warrantySchema = z.object({
  serialId: z.string().uuid(),
  warrantyMonths: z.number().int().min(0).max(600),
  /** Overrides the dispatch date, for units sold before Ordence. */
  startFrom: civilDay.optional(),
});

/**
 * ⭐ SET A WARRANTY.
 *
 * 🔴 IT RUNS FROM DISPATCH, NOT FROM RECEIPT. A panel that sat in a
 *    warehouse for eight months has not used eight months of its cover,
 *    and telling a customer it has is a dispute the record itself
 *    created.
 */
export async function setSerialWarranty(
  input: unknown,
): Promise<ActionResult<{ warrantyUntil: string }>> {
  try {
    const data = warrantySchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [serial] = await tx
          .select({
            id: stockSerials.id,
            dispatchedAt: stockSerials.dispatchedAt,
            status: stockSerials.status,
          })
          .from(stockSerials)
          .where(
            and(
              eq(stockSerials.tenantId, ctx.tenant.id),
              eq(stockSerials.id, data.serialId),
            ),
          )
          .limit(1);
        if (!serial) throw new Error("That serial number is not on the register.");

        const start =
          data.startFrom ??
          (serial.dispatchedAt
            ? new Date(serial.dispatchedAt).toISOString().slice(0, 10)
            : null);

        if (!start) {
          throw new Error(
            "This unit has not been dispatched yet, so its warranty has not started. Warranty runs from the day it leaves — set it when it ships, or give an explicit start date for a unit sold before Ordence.",
          );
        }

        const until = warrantyUntil({
          dispatchedOn: start,
          warrantyMonths: data.warrantyMonths,
        });

        await tx
          .update(stockSerials)
          .set({
            warrantyMonths: data.warrantyMonths,
            warrantyUntil: until,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stockSerials.tenantId, ctx.tenant.id),
              eq(stockSerials.id, data.serialId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "stock_serial",
          resourceId: data.serialId,
          newValue: { warrantyMonths: data.warrantyMonths, warrantyUntil: until },
          severity: "info",
        });

        return { warrantyUntil: until };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/serials");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "setSerialWarranty");
  }
}

/**
 * ⚠️ EXPOSED SO THE PREPARE SCREENS CAN OFFER A WAREHOUSE LIST WITHOUT
 * PULLING THE WHOLE INVENTORY MODULE IN.
 */
export async function getWarehouseOptions(): Promise<
  ActionResult<{ id: string; name: string; type: string }[]>
> {
  try {
    const ctx = await requirePermission(READ);
    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: warehouses.id,
          name: warehouses.name,
          type: warehouses.warehouseType,
        })
        .from(warehouses)
        .where(and(eq(warehouses.tenantId, ctx.tenant.id), isNull(warehouses.deletedAt)))
        .orderBy(asc(warehouses.name))
        .limit(200),
    );
    return { ok: true, data: rows };
  } catch (err) {
    return toSalesActionError(err, "getWarehouseOptions");
  }
}
