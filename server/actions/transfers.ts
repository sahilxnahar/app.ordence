"use server";

/**
 * Ordence — ⭐⭐ STOCK TRANSFERS
 * Version: v1.5.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT. The
 * arithmetic lives in `lib/inventory/transfer.ts`, which is pure.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 DISPATCH AND RECEIPT ARE TWO EVENTS AND FOUR MOVEMENTS
 * ══════════════════════════════════════════════════════════════════════
 *   dispatch : OUT of the source   → IN to transit
 *   receipt  : OUT of transit      → IN to the destination
 *
 * Between them the goods are ours and are in NEITHER godown. They sit in
 * a warehouse of type `transit`, which means the existing balance
 * trigger, the existing valuation and the existing stock counts all
 * handle them with no changes at all — and 0056's trigger refuses a
 * sale out of one.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  stockTransfers,
  stockTransferLines,
  stockMovements,
  stockItems,
  warehouses,
} from "@/db/schema/inventory";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  canTransitionTransfer,
  rule28Value,
  transferHealth,
  transferTaxTreatment,
  transferVariance,
  type TransferStatus,
} from "@/lib/inventory/transfer";
import { itcReversalOnWriteOff } from "@/lib/inventory/batch";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "inventory.stock.read" as const;
const WRITE = "inventory.movements.post" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const qty = z.string().regex(/^\d+(\.\d{1,3})?$/, "Quantity, up to three decimals.");

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
/* ① CREATE                                                            */
/* ================================================================== */

const lineSchema = z.object({
  stockItemId: z.string().uuid(),
  batchNo: z.string().trim().max(100).optional(),
  serialNo: z.string().trim().max(120).optional(),
  qtyDispatched: qty,
  unitCostMinor: z.string().regex(/^\d+$/).default("0"),
  taxRateBps: z.number().int().min(0).max(10000).default(0),
});

const createSchema = z.object({
  transferNo: z.string().trim().min(1).max(40),
  transferDate: civilDay,
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  transitWarehouseId: z.string().uuid(),
  documentNo: z.string().trim().max(40).optional(),
  transporterName: z.string().trim().max(255).optional(),
  vehicleNo: z.string().trim().max(20).optional(),
  distanceKm: z.number().int().min(0).max(4000).optional(),
  /** ⚠️ Rule 28 — only matters when the move is a supply. */
  recipientHasFullItc: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(lineSchema).min(1, "A transfer with no lines moves nothing."),
});

/**
 * ⭐⭐ RAISE A TRANSFER — and work out whether it is a supply.
 *
 * 🔴 THE ANSWER COMES FROM THE GSTINS ON THE TWO WAREHOUSES, NOT FROM
 *    THEIR STATE CODES. Two godowns in different states under one GSTIN
 *    are not a supply; two in one state under two GSTINs are. Deciding
 *    it on the state is the intuitive mistake and it is wrong both ways
 *    round.
 */
export async function createTransfer(input: unknown): Promise<
  ActionResult<{
    id: string;
    isTaxableSupply: boolean;
    documentType: string;
    reason: string;
    authority: string;
    needsOpenMarketValue: boolean;
  }>
> {
  try {
    const data = createSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.fromWarehouseId === data.toWarehouseId) {
          throw new Error(
            "The source and the destination are the same place. That transfer would reconcile perfectly and mean nothing.",
          );
        }

        const whs = await tx
          .select({
            id: warehouses.id,
            name: warehouses.name,
            type: warehouses.warehouseType,
            gstin: warehouses.gstin,
            stateCode: warehouses.stateCode,
          })
          .from(warehouses)
          .where(eq(warehouses.tenantId, ctx.tenant.id));

        const from = whs.find((w) => w.id === data.fromWarehouseId);
        const to = whs.find((w) => w.id === data.toWarehouseId);
        const transit = whs.find((w) => w.id === data.transitWarehouseId);

        if (!from || !to) throw new Error("One of those warehouses does not exist.");
        if (!transit) throw new Error("That transit location does not exist.");

        /**
         * 🔴 THE TRANSIT LOCATION MUST ACTUALLY BE ONE. Parking goods in
         * a second selling warehouse while they are on a lorry puts them
         * back where they can be picked, which is the whole failure this
         * document exists to prevent.
         */
        if (transit.type !== "transit") {
          throw new Error(
            `"${transit.name}" is a ${transit.type} location, not a transit one. Goods parked there while they are on a lorry could be picked and sold. Create a warehouse of type "transit" for goods in movement.`,
          );
        }

        const treatment = transferTaxTreatment({
          fromGstin: from.gstin,
          toGstin: to.gstin,
          fromStateCode: from.stateCode,
          toStateCode: to.stateCode,
        });

        /** Rule 28 — only relevant once we know it is a supply. */
        let needsOpenMarketValue = false;
        let taxableTotal = 0n;
        let cgst = 0n;
        let sgst = 0n;
        let igst = 0n;

        const priced = data.lines.map((l) => {
          const costMinor =
            (BigInt(l.unitCostMinor) * toMilli(l.qtyDispatched) + 500n) / 1000n;
          if (!treatment.isTaxableSupply) {
            return { ...l, taxableValueMinor: 0n, taxRateBps: 0 };
          }
          const v = rule28Value({
            costMinor,
            recipientHasFullItc: data.recipientHasFullItc,
          });
          if (v.needsOpenMarketValue) needsOpenMarketValue = true;
          const tax = (v.valueMinor * BigInt(l.taxRateBps) + 5000n) / 10000n;
          taxableTotal += v.valueMinor;
          if (treatment.taxKind === "igst") {
            igst += tax;
          } else {
            /** ⚠️ Halved on the CGST leg and the remainder to SGST, so
             *  the two always add back to the whole tax. */
            const half = tax / 2n;
            cgst += half;
            sgst += tax - half;
          }
          return { ...l, taxableValueMinor: v.valueMinor, taxRateBps: l.taxRateBps };
        });

        const [row] = await tx
          .insert(stockTransfers)
          .values({
            tenantId: ctx.tenant.id,
            transferNo: data.transferNo,
            transferDate: data.transferDate,
            fromWarehouseId: data.fromWarehouseId,
            toWarehouseId: data.toWarehouseId,
            transitWarehouseId: data.transitWarehouseId,
            fromGstin: from.gstin,
            toGstin: to.gstin,
            fromStateCode: from.stateCode,
            toStateCode: to.stateCode,
            isTaxableSupply: treatment.isTaxableSupply,
            documentType: treatment.documentType,
            documentNo: data.documentNo ?? null,
            taxableValueMinor: taxableTotal,
            cgstMinor: cgst,
            sgstMinor: sgst,
            igstMinor: igst,
            transporterName: data.transporterName ?? null,
            vehicleNo: data.vehicleNo ?? null,
            distanceKm: data.distanceKm ?? null,
            status: "draft",
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: stockTransfers.id });

        if (!row) throw new Error("The transfer could not be created.");

        await tx.insert(stockTransferLines).values(
          priced.map((l, i) => ({
            tenantId: ctx.tenant.id,
            transferId: row.id,
            lineNo: i + 1,
            stockItemId: l.stockItemId,
            batchNo: l.batchNo ?? null,
            serialNo: l.serialNo ?? null,
            qtyDispatched: l.qtyDispatched,
            unitCostMinor: BigInt(l.unitCostMinor),
            taxableValueMinor: l.taxableValueMinor,
            taxRateBps: l.taxRateBps,
          })),
        );

        await writeAudit(ctx, {
          action: "create",
          resourceType: "stock_transfer",
          resourceId: row.id,
          newValue: {
            transferNo: data.transferNo,
            isTaxableSupply: treatment.isTaxableSupply,
            documentType: treatment.documentType,
            lines: data.lines.length,
          },
          /** A branch transfer that is a supply changes two GST returns. */
          severity: treatment.isTaxableSupply ? "critical" : "warning",
        });

        return {
          id: row.id,
          isTaxableSupply: treatment.isTaxableSupply,
          documentType: treatment.documentType,
          reason: treatment.reason,
          authority: treatment.authority,
          needsOpenMarketValue,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/transfers");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "createTransfer");
  }
}

/* ================================================================== */
/* ② DISPATCH — OUT OF THE SOURCE, INTO TRANSIT                        */
/* ================================================================== */

const dispatchSchema = z.object({
  transferId: z.string().uuid(),
  vehicleNo: z.string().trim().max(20).optional(),
  ewayBillNo: z.string().trim().max(20).optional(),
});

/**
 * ⭐⭐ THE GOODS LEAVE.
 *
 * 🔴 BOTH MOVEMENTS IN ONE TRANSACTION. If the OUT committed and the IN
 *    did not, 100 bags would be gone from the source and in no location
 *    at all — off the balance sheet entirely, with a transfer that says
 *    they are on a lorry.
 */
export async function dispatchTransfer(
  input: unknown,
): Promise<ActionResult<{ movements: number }>> {
  try {
    const data = dispatchSchema.parse(input);
    const ctx = await requirePermission(WRITE);
    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [t] = await tx
          .select()
          .from(stockTransfers)
          .where(
            and(
              eq(stockTransfers.tenantId, ctx.tenant.id),
              eq(stockTransfers.id, data.transferId),
            ),
          )
          .limit(1);
        if (!t) throw new Error("That transfer does not exist.");

        const verdict = canTransitionTransfer(t.status as TransferStatus, "dispatched");
        if (!verdict.allowed) throw new Error(verdict.reason);
        if (!t.transitWarehouseId) {
          throw new Error("This transfer has no transit location, so nothing can leave.");
        }

        const lines = await tx
          .select()
          .from(stockTransferLines)
          .where(
            and(
              eq(stockTransferLines.tenantId, ctx.tenant.id),
              eq(stockTransferLines.transferId, t.id),
            ),
          )
          .orderBy(stockTransferLines.lineNo);

        if (lines.length === 0) throw new Error("This transfer has no lines.");

        let movements = 0;
        for (const l of lines) {
          /** OUT of the source. */
          await tx.insert(stockMovements).values({
            tenantId: ctx.tenant.id,
            stockItemId: l.stockItemId,
            warehouseId: t.fromWarehouseId,
            quantity: `-${l.qtyDispatched}`,
            reason: "transfer_out",
            batchNo: l.batchNo,
            serialNo: l.serialNo,
            unitCostMinor: l.unitCostMinor,
            documentNo: t.transferNo,
            referenceType: "stock_transfer",
            referenceId: t.id,
            createdBy: ctx.user.id,
          });
          /**
           * IN to transit — ⭐ carrying the same unit cost, so the value
           * travels with the goods and the destination does not have to
           * guess what they were worth.
           */
          await tx.insert(stockMovements).values({
            tenantId: ctx.tenant.id,
            stockItemId: l.stockItemId,
            warehouseId: t.transitWarehouseId,
            quantity: l.qtyDispatched,
            reason: "transfer_in",
            batchNo: l.batchNo,
            serialNo: l.serialNo,
            unitCostMinor: l.unitCostMinor,
            documentNo: t.transferNo,
            referenceType: "stock_transfer",
            referenceId: t.id,
            createdBy: ctx.user.id,
          });
          movements += 2;
        }

        await tx
          .update(stockTransfers)
          .set({
            status: "dispatched",
            dispatchedAt: now,
            dispatchedBy: ctx.user.id,
            ...(data.vehicleNo ? { vehicleNo: data.vehicleNo } : {}),
            ...(data.ewayBillNo ? { ewayBillNo: data.ewayBillNo } : {}),
            updatedAt: now,
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(stockTransfers.tenantId, ctx.tenant.id),
              eq(stockTransfers.id, t.id),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "stock_transfer",
          resourceId: t.id,
          newValue: { dispatched: true, movements },
          severity: "warning",
        });

        return { movements };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/transfers");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "dispatchTransfer");
  }
}

/* ================================================================== */
/* ③ RECEIVE — OUT OF TRANSIT, INTO THE DESTINATION                    */
/* ================================================================== */

const receiveSchema = z.object({
  transferId: z.string().uuid(),
  counts: z
    .array(z.object({ lineNo: z.number().int().positive(), qtyReceived: qty }))
    .min(1),
  /** Required when anything is short — s.17(5)(h) needs a named human. */
  varianceApprovedBy: z.string().uuid().optional(),
  varianceNote: z.string().trim().max(1000).optional(),
  itcRateBps: z.number().int().min(0).max(10000).default(0),
});

/**
 * ⭐⭐ THE GOODS ARRIVE, AND SOMEBODY COUNTS THEM.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SHORTAGE IS THE POINT OF THIS FUNCTION
 * ══════════════════════════════════════════════════════════════════════
 * 100 bags leave and 98 arrive. The obvious thing is to receive 98 — and
 * then the two missing bags are simply gone, with nothing naming why.
 *
 * ⚠️ The transit location is what makes them visible: they are still
 * sitting in it, on a balance somebody has to explain. This function
 * refuses to leave them there — the shortfall is written off out of
 * transit, with an approver, and 🔴 **the input tax credit on it is
 * reversed under s.17(5)(h)**, which names "goods lost" directly.
 */
export async function receiveTransfer(input: unknown): Promise<
  ActionResult<{
    received: number;
    shortMilli: string;
    lossMinor: string;
    itcReversalMinor: string;
  }>
> {
  try {
    const data = receiveSchema.parse(input);
    const ctx = await requirePermission(WRITE);
    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [t] = await tx
          .select()
          .from(stockTransfers)
          .where(
            and(
              eq(stockTransfers.tenantId, ctx.tenant.id),
              eq(stockTransfers.id, data.transferId),
            ),
          )
          .limit(1);
        if (!t) throw new Error("That transfer does not exist.");

        const verdict = canTransitionTransfer(t.status as TransferStatus, "received");
        if (!verdict.allowed) throw new Error(verdict.reason);
        if (!t.transitWarehouseId) throw new Error("This transfer has no transit location.");

        const lines = await tx
          .select()
          .from(stockTransferLines)
          .where(
            and(
              eq(stockTransferLines.tenantId, ctx.tenant.id),
              eq(stockTransferLines.transferId, t.id),
            ),
          )
          .orderBy(stockTransferLines.lineNo);

        const byLine = new Map(data.counts.map((c) => [c.lineNo, c.qtyReceived]));
        if (byLine.size !== lines.length) {
          throw new Error(
            `Every line has to be counted. There are ${lines.length} lines and ${byLine.size} counts — an uncounted line would leave stock sitting in transit that nothing accounts for.`,
          );
        }

        /**
         * ⚠️ COMPUTED BY THE PURE FUNCTION, WHICH THROWS ON AN EXCESS.
         * More arriving than left is stock from nowhere.
         */
        const variance = transferVariance(
          lines.map((l) => ({
            lineNo: l.lineNo,
            description: l.batchNo ? `line ${l.lineNo} (batch ${l.batchNo})` : `line ${l.lineNo}`,
            qtyDispatchedMilli: toMilli(l.qtyDispatched),
            qtyReceivedMilli: toMilli(byLine.get(l.lineNo) ?? "0"),
            unitCostMinor: toBigIntAmount(l.unitCostMinor),
          })),
        );

        /**
         * 🔴 A SHORTAGE NEEDS A NAMED HUMAN BEFORE IT CAN BE WRITTEN OFF.
         * Stock that left and never arrived is a loss, and under
         * s.17(5)(h) it also gives back an input tax credit. Neither is
         * something a receipt screen should do quietly.
         */
        if (variance.lines.length > 0 && !data.varianceApprovedBy) {
          throw new Error(
            `${variance.lines.length} line${variance.lines.length === 1 ? "" : "s"} arrived short — ${fromMilli(variance.totalShortMilli)} units, worth ${serializeAmount(variance.totalLossMinor)} paise. That stock left and never arrived, so it has to be written off out of transit with somebody's name against it, and the input tax credit claimed on it reversed under s.17(5)(h). Name an approver.`,
          );
        }

        let itcReversal = 0n;

        for (const l of lines) {
          const receivedStr = byLine.get(l.lineNo) ?? "0";
          const receivedMilli = toMilli(receivedStr);

          if (receivedMilli > 0n) {
            /** OUT of transit. */
            await tx.insert(stockMovements).values({
              tenantId: ctx.tenant.id,
              stockItemId: l.stockItemId,
              warehouseId: t.transitWarehouseId,
              quantity: `-${receivedStr}`,
              reason: "transfer_out",
              batchNo: l.batchNo,
              serialNo: l.serialNo,
              unitCostMinor: l.unitCostMinor,
              documentNo: t.transferNo,
              referenceType: "stock_transfer",
              referenceId: t.id,
              createdBy: ctx.user.id,
            });
            /** IN to the destination. */
            await tx.insert(stockMovements).values({
              tenantId: ctx.tenant.id,
              stockItemId: l.stockItemId,
              warehouseId: t.toWarehouseId,
              quantity: receivedStr,
              reason: "transfer_in",
              batchNo: l.batchNo,
              serialNo: l.serialNo,
              unitCostMinor: l.unitCostMinor,
              documentNo: t.transferNo,
              referenceType: "stock_transfer",
              referenceId: t.id,
              createdBy: ctx.user.id,
            });
          }

          const shortMilli = toMilli(l.qtyDispatched) - receivedMilli;
          if (shortMilli > 0n) {
            /**
             * 🔴 THE MISSING STOCK LEAVES TRANSIT AS A LOSS, NOT AS
             *    NOTHING. `damage` is a ledger reason that takes stock
             *    out; it needs no adjustment note, but one is supplied
             *    anyway so the row explains itself.
             */
            const [loss] = await tx
              .insert(stockMovements)
              .values({
                tenantId: ctx.tenant.id,
                stockItemId: l.stockItemId,
                warehouseId: t.transitWarehouseId,
                quantity: `-${fromMilli(shortMilli)}`,
                reason: "damage",
                batchNo: l.batchNo,
                unitCostMinor: l.unitCostMinor,
                documentNo: `${t.transferNo}/SHORT`,
                referenceType: "stock_transfer_variance",
                referenceId: t.id,
                adjustmentNote:
                  data.varianceNote ??
                  `Short on transfer ${t.transferNo}: dispatched ${l.qtyDispatched}, received ${receivedStr}.`,
                approvedBy: data.varianceApprovedBy ?? null,
                createdBy: ctx.user.id,
              })
              .returning({ id: stockMovements.id });

            const lossMinor =
              (toBigIntAmount(l.unitCostMinor) * shortMilli + 500n) / 1000n;
            itcReversal += itcReversalOnWriteOff({
              costMinor: lossMinor,
              itcRateBps: data.itcRateBps,
              /** ⚠️ "Lost" is named in s.17(5)(h) directly. */
              reason: "theft",
            }).reversalMinor;

            await tx
              .update(stockTransferLines)
              .set({
                qtyReceived: receivedStr,
                varianceMovementId: loss?.id ?? null,
                varianceNote: data.varianceNote ?? null,
              })
              .where(
                and(
                  eq(stockTransferLines.tenantId, ctx.tenant.id),
                  eq(stockTransferLines.id, l.id),
                ),
              );
          } else {
            await tx
              .update(stockTransferLines)
              .set({ qtyReceived: receivedStr })
              .where(
                and(
                  eq(stockTransferLines.tenantId, ctx.tenant.id),
                  eq(stockTransferLines.id, l.id),
                ),
              );
          }
        }

        await tx
          .update(stockTransfers)
          .set({
            status: "received",
            receivedAt: now,
            receivedBy: ctx.user.id,
            updatedAt: now,
            updatedBy: ctx.user.id,
          })
          .where(
            and(eq(stockTransfers.tenantId, ctx.tenant.id), eq(stockTransfers.id, t.id)),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "stock_transfer",
          resourceId: t.id,
          newValue: {
            received: true,
            shortMilli: variance.totalShortMilli.toString(),
            lossMinor: serializeAmount(variance.totalLossMinor),
            itcReversalMinor: serializeAmount(itcReversal),
          },
          severity: variance.lines.length > 0 ? "critical" : "warning",
        });

        return {
          received: lines.length,
          shortMilli: fromMilli(variance.totalShortMilli),
          lossMinor: serializeAmount(variance.totalLossMinor),
          itcReversalMinor: serializeAmount(itcReversal),
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/transfers");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "receiveTransfer");
  }
}

/* ================================================================== */
/* ④ CANCEL — ONLY BEFORE ANYTHING HAS MOVED                           */
/* ================================================================== */

const cancelSchema = z.object({
  transferId: z.string().uuid(),
  reason: z.string().trim().min(3, "A cancellation carries a reason.").max(500),
});

export async function cancelTransfer(
  input: unknown,
): Promise<ActionResult<{ cancelled: true }>> {
  try {
    const data = cancelSchema.parse(input);
    const ctx = await requirePermission(WRITE);
    const now = new Date();

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [t] = await tx
          .select({ id: stockTransfers.id, status: stockTransfers.status })
          .from(stockTransfers)
          .where(
            and(
              eq(stockTransfers.tenantId, ctx.tenant.id),
              eq(stockTransfers.id, data.transferId),
            ),
          )
          .limit(1);
        if (!t) throw new Error("That transfer does not exist.");

        /**
         * 🔴 A DISPATCHED TRANSFER CANNOT BE CANCELLED, and the pure
         *    function says why: the goods are on a lorry and something
         *    has to account for them. Cancelling would leave stock in a
         *    transit warehouse that no document explains.
         */
        const verdict = canTransitionTransfer(t.status as TransferStatus, "cancelled");
        if (!verdict.allowed) throw new Error(verdict.reason);

        await tx
          .update(stockTransfers)
          .set({
            status: "cancelled",
            cancelledAt: now,
            cancelledBy: ctx.user.id,
            cancelReason: data.reason,
            updatedAt: now,
            updatedBy: ctx.user.id,
          })
          .where(
            and(eq(stockTransfers.tenantId, ctx.tenant.id), eq(stockTransfers.id, t.id)),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "stock_transfer",
          resourceId: t.id,
          newValue: { cancelled: true, reason: data.reason },
          severity: "warning",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/transfers");
    return { ok: true, data: { cancelled: true } };
  } catch (err) {
    return toSalesActionError(err, "cancelTransfer");
  }
}

/* ================================================================== */
/* ⑤ READS                                                             */
/* ================================================================== */

export type TransferRowView = {
  id: string;
  transferNo: string;
  transferDate: string;
  fromName: string | null;
  toName: string | null;
  status: string;
  isTaxableSupply: boolean;
  documentType: string;
  taxableValueMinor: string;
  taxMinor: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
  lineCount: number;
  shortLines: number;
  healthTone: string;
  healthLabel: string;
  healthDetail: string;
};

export async function getTransfers(): Promise<
  ActionResult<{
    rows: TransferRowView[];
    inTransit: number;
    stale: number;
    taxableCount: number;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const now = new Date();

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      const fromW = warehouses;
      return tx
        .select({
          id: stockTransfers.id,
          transferNo: stockTransfers.transferNo,
          transferDate: stockTransfers.transferDate,
          fromName: fromW.name,
          toWarehouseId: stockTransfers.toWarehouseId,
          status: stockTransfers.status,
          isTaxableSupply: stockTransfers.isTaxableSupply,
          documentType: stockTransfers.documentType,
          taxableValueMinor: stockTransfers.taxableValueMinor,
          cgstMinor: stockTransfers.cgstMinor,
          sgstMinor: stockTransfers.sgstMinor,
          igstMinor: stockTransfers.igstMinor,
          dispatchedAt: stockTransfers.dispatchedAt,
          receivedAt: stockTransfers.receivedAt,
          lineCount: sql<number>`(
            SELECT COUNT(*)::int FROM stock_transfer_lines l
             WHERE l.tenant_id = ${ctx.tenant.id} AND l.transfer_id = ${stockTransfers.id}
          )`,
          shortLines: sql<number>`(
            SELECT COUNT(*)::int FROM stock_transfer_lines l
             WHERE l.tenant_id = ${ctx.tenant.id} AND l.transfer_id = ${stockTransfers.id}
               AND l.qty_received IS NOT NULL AND l.qty_received < l.qty_dispatched
          )`,
          toName: sql<string>`(
            SELECT w.name FROM warehouses w
             WHERE w.id = ${stockTransfers.toWarehouseId} AND w.tenant_id = ${ctx.tenant.id}
          )`,
        })
        .from(stockTransfers)
        .leftJoin(
          fromW,
          and(
            eq(fromW.id, stockTransfers.fromWarehouseId),
            eq(fromW.tenantId, ctx.tenant.id),
          ),
        )
        .where(eq(stockTransfers.tenantId, ctx.tenant.id))
        .orderBy(desc(stockTransfers.transferDate), desc(stockTransfers.createdAt))
        .limit(500);
    });

    const mapped: TransferRowView[] = rows.map((r) => {
      const health = transferHealth({
        status: r.status as TransferStatus,
        dispatchedAt: r.dispatchedAt ? new Date(r.dispatchedAt) : null,
        now,
      });
      return {
        id: r.id,
        transferNo: r.transferNo,
        transferDate: String(r.transferDate),
        fromName: r.fromName,
        toName: r.toName,
        status: r.status,
        isTaxableSupply: r.isTaxableSupply,
        documentType: r.documentType,
        taxableValueMinor: serializeAmount(toBigIntAmount(r.taxableValueMinor)),
        taxMinor: serializeAmount(
          toBigIntAmount(r.cgstMinor) +
            toBigIntAmount(r.sgstMinor) +
            toBigIntAmount(r.igstMinor),
        ),
        dispatchedAt: r.dispatchedAt ? new Date(r.dispatchedAt).toISOString() : null,
        receivedAt: r.receivedAt ? new Date(r.receivedAt).toISOString() : null,
        lineCount: r.lineCount,
        shortLines: r.shortLines,
        healthTone: health.tone,
        healthLabel: health.label,
        healthDetail: health.detail,
      };
    });

    return {
      ok: true,
      data: {
        rows: mapped,
        inTransit: mapped.filter((r) => r.status === "dispatched").length,
        /** ⚠️ On the road too long — almost always a receipt nobody entered. */
        stale: mapped.filter((r) => r.healthTone === "danger").length,
        taxableCount: mapped.filter((r) => r.isTaxableSupply).length,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getTransfers");
  }
}

export async function getTransferDetail(id: string): Promise<
  ActionResult<{
    header: TransferRowView & {
      fromGstin: string | null;
      toGstin: string | null;
      documentNo: string | null;
      notes: string | null;
      vehicleNo: string | null;
      ewayBillNo: string | null;
      transitName: string | null;
      treatmentReason: string;
      treatmentAuthority: string;
    };
    lines: {
      lineNo: number;
      itemName: string | null;
      batchNo: string | null;
      serialNo: string | null;
      qtyDispatched: string;
      qtyReceived: string | null;
      unitCostMinor: string;
      taxableValueMinor: string;
      shortBy: string | null;
      varianceNote: string | null;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const now = new Date();

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const [t] = await tx
        .select()
        .from(stockTransfers)
        .where(
          and(eq(stockTransfers.tenantId, ctx.tenant.id), eq(stockTransfers.id, id)),
        )
        .limit(1);
      if (!t) throw new Error("That transfer does not exist.");

      const whs = await tx
        .select({ id: warehouses.id, name: warehouses.name })
        .from(warehouses)
        .where(eq(warehouses.tenantId, ctx.tenant.id));
      const nameOf = (wid: string | null) =>
        wid ? (whs.find((w) => w.id === wid)?.name ?? null) : null;

      const lines = await tx
        .select({
          lineNo: stockTransferLines.lineNo,
          itemName: stockItems.name,
          batchNo: stockTransferLines.batchNo,
          serialNo: stockTransferLines.serialNo,
          qtyDispatched: stockTransferLines.qtyDispatched,
          qtyReceived: stockTransferLines.qtyReceived,
          unitCostMinor: stockTransferLines.unitCostMinor,
          taxableValueMinor: stockTransferLines.taxableValueMinor,
          varianceNote: stockTransferLines.varianceNote,
        })
        .from(stockTransferLines)
        .leftJoin(
          stockItems,
          and(
            eq(stockItems.id, stockTransferLines.stockItemId),
            eq(stockItems.tenantId, ctx.tenant.id),
          ),
        )
        .where(
          and(
            eq(stockTransferLines.tenantId, ctx.tenant.id),
            eq(stockTransferLines.transferId, id),
          ),
        )
        .orderBy(stockTransferLines.lineNo);

      const treatment = transferTaxTreatment({
        fromGstin: t.fromGstin,
        toGstin: t.toGstin,
        fromStateCode: t.fromStateCode,
        toStateCode: t.toStateCode,
      });
      const health = transferHealth({
        status: t.status as TransferStatus,
        dispatchedAt: t.dispatchedAt ? new Date(t.dispatchedAt) : null,
        now,
      });

      return {
        header: {
          id: t.id,
          transferNo: t.transferNo,
          transferDate: String(t.transferDate),
          fromName: nameOf(t.fromWarehouseId),
          toName: nameOf(t.toWarehouseId),
          transitName: nameOf(t.transitWarehouseId),
          status: t.status,
          isTaxableSupply: t.isTaxableSupply,
          documentType: t.documentType,
          documentNo: t.documentNo,
          fromGstin: t.fromGstin,
          toGstin: t.toGstin,
          taxableValueMinor: serializeAmount(toBigIntAmount(t.taxableValueMinor)),
          taxMinor: serializeAmount(
            toBigIntAmount(t.cgstMinor) +
              toBigIntAmount(t.sgstMinor) +
              toBigIntAmount(t.igstMinor),
          ),
          dispatchedAt: t.dispatchedAt ? new Date(t.dispatchedAt).toISOString() : null,
          receivedAt: t.receivedAt ? new Date(t.receivedAt).toISOString() : null,
          lineCount: lines.length,
          shortLines: lines.filter(
            (l) => l.qtyReceived !== null && toMilli(l.qtyReceived) < toMilli(l.qtyDispatched),
          ).length,
          healthTone: health.tone,
          healthLabel: health.label,
          healthDetail: health.detail,
          notes: t.notes,
          vehicleNo: t.vehicleNo,
          ewayBillNo: t.ewayBillNo,
          treatmentReason: treatment.reason,
          treatmentAuthority: treatment.authority,
        },
        lines: lines.map((l) => {
          const short =
            l.qtyReceived === null
              ? null
              : toMilli(l.qtyDispatched) - toMilli(l.qtyReceived);
          return {
            lineNo: l.lineNo,
            itemName: l.itemName,
            batchNo: l.batchNo,
            serialNo: l.serialNo,
            qtyDispatched: String(l.qtyDispatched),
            qtyReceived: l.qtyReceived === null ? null : String(l.qtyReceived),
            unitCostMinor: serializeAmount(toBigIntAmount(l.unitCostMinor)),
            taxableValueMinor: serializeAmount(toBigIntAmount(l.taxableValueMinor)),
            shortBy: short && short > 0n ? fromMilli(short) : null,
            varianceNote: l.varianceNote,
          };
        }),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getTransferDetail");
  }
}

/**
 * ⚠️ EXPOSED SO THE FORM CAN SAY WHETHER A MOVE IS A SUPPLY BEFORE
 * ANYBODY FILLS IN THE LINES. Finding out at save time that a delivery
 * challan should have been a tax invoice means re-keying the whole
 * thing.
 */
export async function previewTransferTreatment(input: {
  fromWarehouseId: string;
  toWarehouseId: string;
}): Promise<
  ActionResult<{
    isTaxableSupply: boolean;
    documentType: string;
    taxKind: string;
    reason: string;
    authority: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const whs = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: warehouses.id,
          gstin: warehouses.gstin,
          stateCode: warehouses.stateCode,
        })
        .from(warehouses)
        .where(eq(warehouses.tenantId, ctx.tenant.id)),
    );
    const from = whs.find((w) => w.id === input.fromWarehouseId);
    const to = whs.find((w) => w.id === input.toWarehouseId);
    const t = transferTaxTreatment({
      fromGstin: from?.gstin ?? null,
      toGstin: to?.gstin ?? null,
      fromStateCode: from?.stateCode ?? null,
      toStateCode: to?.stateCode ?? null,
    });
    return {
      ok: true,
      data: {
        isTaxableSupply: t.isTaxableSupply,
        documentType: t.documentType,
        taxKind: t.taxKind,
        reason: t.reason,
        authority: t.authority,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "previewTransferTreatment");
  }
}
