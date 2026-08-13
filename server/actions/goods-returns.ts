"use server";

/**
 * Ordence — ⭐⭐ GOODS COMING BACK
 * Version: v1.4.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A SALES RETURN IS THREE FACTS, AND MOST SOFTWARE MERGES THEM
 * ══════════════════════════════════════════════════════════════════════
 *   1. Goods physically arrived back        → a stock movement
 *   2. The customer owes less               → a credit note, s.34
 *   3. Some of what came back is unsaleable → a different warehouse
 *
 * 🔴 (1) AND (3) MERGED IS THE EXPENSIVE ONE. Damaged goods returned
 *    into the selling warehouse are goods that WILL be picked, and the
 *    person who finds out is the next customer.
 *
 * 🔴 (2) HAS A DEADLINE THAT COSTS REAL MONEY. Section 34(2): the tax on
 *    a credit note can only be adjusted until 30 November following the
 *    end of the financial year of the ORIGINAL SUPPLY. After that the
 *    note can still be raised — the customer still owes less — but the
 *    GST is gone.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  goodsReturns,
  goodsReturnLines,
  stockMovements,
  stockItems,
  warehouses,
} from "@/db/schema/inventory";
import { salesInvoices } from "@/db/schema/sales-invoices";
import { companies } from "@/db/schema/crm";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  creditNoteDeadlineVerdict,
  creditNoteTaxDeadline,
  itcReversalOnWriteOff,
  RETURN_CONDITION_META,
  type ReturnCondition,
} from "@/lib/inventory/batch";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "sales.invoices.read" as const;
const WRITE = "inventory.movements.post" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const conditions = ["saleable", "damaged", "expired", "opened", "scrap"] as const;

const lineSchema = z.object({
  stockItemId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(500),
  batchNo: z.string().trim().max(100).optional(),
  serialNo: z.string().trim().max(120).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "Quantity, up to three decimals."),
  uom: z.string().trim().max(20).default("nos"),
  condition: z.enum(conditions).default("saleable"),
  warehouseId: z.string().uuid(),
  taxableValueMinor: z.string().regex(/^\d+$/).default("0"),
  taxRateBps: z.number().int().min(0).max(10000).default(0),
  taxValueMinor: z.string().regex(/^\d+$/).default("0"),
  notes: z.string().trim().max(500).optional(),
});

const returnSchema = z.object({
  returnNo: z.string().trim().min(1).max(40),
  returnDate: civilDay,
  companyId: z.string().uuid().optional(),
  invoiceId: z.string().uuid().optional(),
  reason: z
    .enum([
      "damaged_in_transit",
      "wrong_item",
      "quality_rejection",
      "expired",
      "excess_supply",
      "order_cancelled",
      "sale_or_return",
      "other",
    ])
    .default("other"),
  inwardChallanNo: z.string().trim().max(40).optional(),
  ewayBillNo: z.string().trim().max(20).optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(lineSchema).min(1, "A return with no lines describes nothing."),
});

/* ================================================================== */
/* ① RECEIVE THE GOODS                                                 */
/* ================================================================== */

/**
 * ⭐⭐ RECORD A RETURN AND PUT THE STOCK WHERE IT BELONGS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE STOCK MOVEMENTS AND THE RETURN ARE ONE TRANSACTION
 * ══════════════════════════════════════════════════════════════════════
 * A return recorded without its movements is a customer credited for
 * goods the warehouse does not have. Movements without the return are
 * stock that appeared from nowhere.
 *
 * ⚠️ AND NO EXPIRY DATE IS EVER SENT WITH A RETURN MOVEMENT. Whoever is
 * at the door would type today plus the shelf life, which silently
 * RESETS the clock on stock that has spent nine months at a customer.
 * The batch already knows when it expires — it has since the day it was
 * received — and 0055's trigger refuses a movement that disagrees.
 */
export async function receiveGoodsReturn(input: unknown): Promise<
  ActionResult<{
    id: string;
    taxAdjustmentDeadline: string | null;
    deadlineLabel: string | null;
    unsaleableLines: number;
    itcReversalMinor: string;
  }>
> {
  try {
    const data = returnSchema.parse(input);
    const ctx = await requirePermission(WRITE);
    const day = today();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * ⭐ THE DEADLINE IS COMPUTED FROM THE ORIGINAL SUPPLY DATE, NOT
         * FROM THE RETURN DATE. A March invoice returned in December has
         * already missed it; a December invoice returned in March has
         * eight months. Using the return date gets both backwards.
         */
        let supplyDate: string | null = null;
        let companyId = data.companyId ?? null;

        if (data.invoiceId) {
          const [inv] = await tx
            .select({
              id: salesInvoices.id,
              invoiceDate: salesInvoices.invoiceDate,
              status: salesInvoices.status,
              companyId: salesInvoices.companyId,
            })
            .from(salesInvoices)
            .where(
              and(
                eq(salesInvoices.tenantId, ctx.tenant.id),
                eq(salesInvoices.id, data.invoiceId),
              ),
            )
            .limit(1);
          if (!inv) throw new Error("That invoice does not exist.");
          if (inv.status === "draft") {
            throw new Error(
              "That invoice is still a draft, so nothing was ever supplied on it. Goods cannot come back from a sale that has not happened.",
            );
          }
          supplyDate = String(inv.invoiceDate);
          companyId = companyId ?? inv.companyId;
        }

        const deadline = supplyDate ? creditNoteTaxDeadline({ supplyDate }) : null;

        const [row] = await tx
          .insert(goodsReturns)
          .values({
            tenantId: ctx.tenant.id,
            returnNo: data.returnNo,
            returnDate: data.returnDate,
            companyId,
            invoiceId: data.invoiceId ?? null,
            reason: data.reason,
            status: "received",
            taxAdjustmentDeadline: deadline,
            inwardChallanNo: data.inwardChallanNo ?? null,
            ewayBillNo: data.ewayBillNo ?? null,
            notes: data.notes ?? null,
            /** ⚠️ "Received" names who opened the carton, or it is a claim. */
            receivedAt: new Date(),
            receivedBy: ctx.user.id,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: goodsReturns.id });

        if (!row) throw new Error("The return could not be recorded.");

        let unsaleable = 0;
        let itcReversalTotal = 0n;

        for (const [i, l] of data.lines.entries()) {
          const meta = RETURN_CONDITION_META[l.condition as ReturnCondition];

          /**
           * 🔴 CHECKED HERE AS WELL AS BY THE TRIGGER. The trigger is the
           * guarantee; this is the sentence a person can act on, before
           * the whole transaction is thrown away for one wrong line.
           */
          if (!meta.saleable) {
            const [wh] = await tx
              .select({ name: warehouses.name, type: warehouses.warehouseType })
              .from(warehouses)
              .where(
                and(
                  eq(warehouses.tenantId, ctx.tenant.id),
                  eq(warehouses.id, l.warehouseId),
                ),
              )
              .limit(1);
            if (wh && wh.type !== "quarantine") {
              throw new Error(
                `Line ${i + 1} came back ${l.condition}, so it cannot go into "${wh.name}" — that is a selling location and the goods would be picked for the next customer. Send it to a quarantine warehouse.`,
              );
            }
            unsaleable += 1;
          }

          /**
           * ⭐ SECTION 17(5)(h), COMPUTED AT THE DOOR.
           *
           * ⚠️ Goods coming back EXPIRED or as SCRAP will be destroyed,
           * and the credit claimed on them is not available. Computing it
           * now — while somebody is looking at the carton and knows the
           * rate — is the difference between a reversal that gets
           * declared and one that is found at an assessment.
           */
          const willBeDestroyed = l.condition === "expired" || l.condition === "scrap";
          const itc = willBeDestroyed
            ? itcReversalOnWriteOff({
                costMinor: BigInt(l.taxableValueMinor),
                itcRateBps: l.taxRateBps,
                reason: l.condition === "expired" ? "expiry" : "damage",
              }).reversalMinor
            : 0n;
          itcReversalTotal += itc;

          await tx.insert(goodsReturnLines).values({
            tenantId: ctx.tenant.id,
            goodsReturnId: row.id,
            lineNo: i + 1,
            stockItemId: l.stockItemId ?? null,
            description: l.description,
            batchNo: l.batchNo ?? null,
            serialNo: l.serialNo ?? null,
            quantity: l.quantity,
            uom: l.uom,
            condition: l.condition,
            warehouseId: l.warehouseId,
            taxableValueMinor: BigInt(l.taxableValueMinor),
            taxRateBps: l.taxRateBps,
            taxValueMinor: BigInt(l.taxValueMinor),
            itcReversalMinor: itc,
            notes: l.notes ?? null,
          });

          /**
           * ⚠️ ONLY LINES THAT NAME A STOCK ITEM MOVE STOCK. A return of
           * something never stocked — a delivery charge credited back, a
           * free sample — is a real line on a real return and has no
           * ledger consequence.
           */
          if (l.stockItemId) {
            await tx.insert(stockMovements).values({
              tenantId: ctx.tenant.id,
              stockItemId: l.stockItemId,
              warehouseId: l.warehouseId,
              /** Positive — stock is coming back in. */
              quantity: l.quantity,
              reason: "sales_return",
              batchNo: l.batchNo ?? null,
              serialNo: l.serialNo ?? null,
              /**
               * 🔴 NO `expiryDate`. The batch already knows. Sending one
               * here is how a returned lot silently gets a fresh clock.
               */
              documentNo: data.returnNo,
              referenceType: "goods_return",
              referenceId: row.id,
              createdBy: ctx.user.id,
            });
          }
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "goods_return",
          resourceId: row.id,
          newValue: {
            returnNo: data.returnNo,
            lines: data.lines.length,
            unsaleable,
            taxAdjustmentDeadline: deadline,
            itcReversalMinor: serializeAmount(itcReversalTotal),
          },
          severity: "warning",
        });

        const verdict = supplyDate
          ? creditNoteDeadlineVerdict({ supplyDate, today: day })
          : null;

        return {
          id: row.id,
          taxAdjustmentDeadline: deadline,
          deadlineLabel: verdict?.label ?? null,
          unsaleableLines: unsaleable,
          itcReversalMinor: serializeAmount(itcReversalTotal),
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/returns");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "receiveGoodsReturn");
  }
}

/* ================================================================== */
/* ② READS                                                             */
/* ================================================================== */

export type GoodsReturnRowView = {
  id: string;
  returnNo: string;
  returnDate: string;
  companyName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  reason: string;
  status: string;
  taxAdjustmentDeadline: string | null;
  deadlineLabel: string | null;
  taxRecoverable: boolean | null;
  lineCount: number;
  taxableValueMinor: string;
  taxValueMinor: string;
  itcReversalMinor: string;
  unsaleableLines: number;
};

/**
 * ⚠️ THE DEADLINE VERDICT IS COMPUTED ON EVERY READ, from the stored
 * date and today. A stored "expired" flag would need a nightly job, and
 * the morning the job did not run the screen would say a return was
 * still adjustable on the day it stopped being adjustable.
 */
export async function getGoodsReturns(): Promise<
  ActionResult<{
    rows: GoodsReturnRowView[];
    atRisk: number;
    lapsed: number;
    itcReversalTotalMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const day = today();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: goodsReturns.id,
          returnNo: goodsReturns.returnNo,
          returnDate: goodsReturns.returnDate,
          companyName: companies.name,
          invoiceNumber: salesInvoices.invoiceNumber,
          invoiceDate: salesInvoices.invoiceDate,
          reason: goodsReturns.reason,
          status: goodsReturns.status,
          taxAdjustmentDeadline: goodsReturns.taxAdjustmentDeadline,
          lineCount: sql<number>`(
            SELECT COUNT(*)::int FROM goods_return_lines l
             WHERE l.tenant_id = ${ctx.tenant.id} AND l.goods_return_id = ${goodsReturns.id}
          )`,
          unsaleableLines: sql<number>`(
            SELECT COUNT(*)::int FROM goods_return_lines l
             WHERE l.tenant_id = ${ctx.tenant.id} AND l.goods_return_id = ${goodsReturns.id}
               AND l.condition <> 'saleable'
          )`,
          taxableValueMinor: sql<string>`COALESCE((
            SELECT SUM(l.taxable_value_minor) FROM goods_return_lines l
             WHERE l.tenant_id = ${ctx.tenant.id} AND l.goods_return_id = ${goodsReturns.id}
          ), 0)`,
          taxValueMinor: sql<string>`COALESCE((
            SELECT SUM(l.tax_value_minor) FROM goods_return_lines l
             WHERE l.tenant_id = ${ctx.tenant.id} AND l.goods_return_id = ${goodsReturns.id}
          ), 0)`,
          itcReversalMinor: sql<string>`COALESCE((
            SELECT SUM(l.itc_reversal_minor) FROM goods_return_lines l
             WHERE l.tenant_id = ${ctx.tenant.id} AND l.goods_return_id = ${goodsReturns.id}
          ), 0)`,
        })
        .from(goodsReturns)
        .leftJoin(
          companies,
          and(
            eq(companies.id, goodsReturns.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .leftJoin(
          salesInvoices,
          and(
            eq(salesInvoices.id, goodsReturns.invoiceId),
            eq(salesInvoices.tenantId, ctx.tenant.id),
          ),
        )
        .where(eq(goodsReturns.tenantId, ctx.tenant.id))
        .orderBy(desc(goodsReturns.returnDate))
        .limit(500),
    );

    let itcTotal = 0n;
    const mapped: GoodsReturnRowView[] = rows.map((r) => {
      const verdict = r.invoiceDate
        ? creditNoteDeadlineVerdict({
            supplyDate: String(r.invoiceDate),
            today: day,
            taxAtStakeMinor: toBigIntAmount(r.taxValueMinor),
          })
        : null;
      itcTotal += toBigIntAmount(r.itcReversalMinor);
      return {
        id: r.id,
        returnNo: r.returnNo,
        returnDate: String(r.returnDate),
        companyName: r.companyName,
        invoiceNumber: r.invoiceNumber,
        invoiceDate: r.invoiceDate ? String(r.invoiceDate) : null,
        reason: r.reason,
        status: r.status,
        taxAdjustmentDeadline: r.taxAdjustmentDeadline
          ? String(r.taxAdjustmentDeadline)
          : null,
        deadlineLabel: verdict?.label ?? null,
        taxRecoverable: verdict ? verdict.taxRecoverable : null,
        lineCount: r.lineCount,
        unsaleableLines: r.unsaleableLines,
        taxableValueMinor: serializeAmount(toBigIntAmount(r.taxableValueMinor)),
        taxValueMinor: serializeAmount(toBigIntAmount(r.taxValueMinor)),
        itcReversalMinor: serializeAmount(toBigIntAmount(r.itcReversalMinor)),
      };
    });

    /**
     * ⭐ TWO COUNTERS, NEVER SUMMED. "Lapsed" is money already gone;
     * "at risk" is money somebody can still save this week. One combined
     * figure hides the half that is still actionable.
     */
    const open = mapped.filter((r) => r.status !== "credited" && r.status !== "cancelled");
    return {
      ok: true,
      data: {
        rows: mapped,
        atRisk: open.filter(
          (r) =>
            r.taxRecoverable === true &&
            r.taxAdjustmentDeadline !== null &&
            (Date.parse(r.taxAdjustmentDeadline) - Date.parse(day)) / 86_400_000 <= 30,
        ).length,
        lapsed: open.filter((r) => r.taxRecoverable === false).length,
        itcReversalTotalMinor: serializeAmount(itcTotal),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getGoodsReturns");
  }
}

export async function getReturnableInvoices(): Promise<
  ActionResult<{
    rows: {
      id: string;
      invoiceNumber: string;
      invoiceDate: string;
      customerLegalName: string | null;
      totalMinor: string;
      deadline: string;
      daysLeft: number;
      taxRecoverable: boolean;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const day = today();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: salesInvoices.id,
          invoiceNumber: salesInvoices.invoiceNumber,
          invoiceDate: salesInvoices.invoiceDate,
          customerLegalName: salesInvoices.customerLegalName,
          totalMinor: salesInvoices.totalMinor,
        })
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.tenantId, ctx.tenant.id),
            eq(salesInvoices.supplyType, "goods"),
            sql`${salesInvoices.status} NOT IN ('draft', 'cancelled')`,
          ),
        )
        .orderBy(desc(salesInvoices.invoiceDate))
        .limit(200),
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => {
          const v = creditNoteDeadlineVerdict({
            supplyDate: String(r.invoiceDate),
            today: day,
          });
          return {
            id: r.id,
            invoiceNumber: r.invoiceNumber,
            invoiceDate: String(r.invoiceDate),
            customerLegalName: r.customerLegalName,
            totalMinor: serializeAmount(toBigIntAmount(r.totalMinor)),
            deadline: v.deadline,
            daysLeft: v.daysLeft,
            taxRecoverable: v.taxRecoverable,
          };
        }),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getReturnableInvoices");
  }
}

export async function getGoodsReturnDetail(id: string): Promise<
  ActionResult<{
    header: GoodsReturnRowView & { notes: string | null; inwardChallanNo: string | null };
    lines: {
      lineNo: number;
      description: string;
      itemName: string | null;
      batchNo: string | null;
      serialNo: string | null;
      quantity: string;
      uom: string;
      condition: string;
      conditionNote: string;
      warehouseName: string | null;
      taxableValueMinor: string;
      itcReversalMinor: string;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const day = today();

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const [h] = await tx
        .select({
          id: goodsReturns.id,
          returnNo: goodsReturns.returnNo,
          returnDate: goodsReturns.returnDate,
          companyName: companies.name,
          invoiceNumber: salesInvoices.invoiceNumber,
          invoiceDate: salesInvoices.invoiceDate,
          reason: goodsReturns.reason,
          status: goodsReturns.status,
          taxAdjustmentDeadline: goodsReturns.taxAdjustmentDeadline,
          notes: goodsReturns.notes,
          inwardChallanNo: goodsReturns.inwardChallanNo,
        })
        .from(goodsReturns)
        .leftJoin(
          companies,
          and(
            eq(companies.id, goodsReturns.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .leftJoin(
          salesInvoices,
          and(
            eq(salesInvoices.id, goodsReturns.invoiceId),
            eq(salesInvoices.tenantId, ctx.tenant.id),
          ),
        )
        .where(and(eq(goodsReturns.tenantId, ctx.tenant.id), eq(goodsReturns.id, id)))
        .limit(1);

      if (!h) throw new Error("That return does not exist.");

      const lines = await tx
        .select({
          lineNo: goodsReturnLines.lineNo,
          description: goodsReturnLines.description,
          itemName: stockItems.name,
          batchNo: goodsReturnLines.batchNo,
          serialNo: goodsReturnLines.serialNo,
          quantity: goodsReturnLines.quantity,
          uom: goodsReturnLines.uom,
          condition: goodsReturnLines.condition,
          warehouseName: warehouses.name,
          taxableValueMinor: goodsReturnLines.taxableValueMinor,
          taxValueMinor: goodsReturnLines.taxValueMinor,
          itcReversalMinor: goodsReturnLines.itcReversalMinor,
        })
        .from(goodsReturnLines)
        .leftJoin(
          stockItems,
          and(
            eq(stockItems.id, goodsReturnLines.stockItemId),
            eq(stockItems.tenantId, ctx.tenant.id),
          ),
        )
        .leftJoin(
          warehouses,
          and(
            eq(warehouses.id, goodsReturnLines.warehouseId),
            eq(warehouses.tenantId, ctx.tenant.id),
          ),
        )
        .where(
          and(
            eq(goodsReturnLines.tenantId, ctx.tenant.id),
            eq(goodsReturnLines.goodsReturnId, id),
          ),
        )
        .orderBy(goodsReturnLines.lineNo);

      const verdict = h.invoiceDate
        ? creditNoteDeadlineVerdict({ supplyDate: String(h.invoiceDate), today: day })
        : null;

      let taxable = 0n;
      let tax = 0n;
      let itc = 0n;
      for (const l of lines) {
        taxable += toBigIntAmount(l.taxableValueMinor);
        tax += toBigIntAmount(l.taxValueMinor);
        itc += toBigIntAmount(l.itcReversalMinor);
      }

      return {
        header: {
          id: h.id,
          returnNo: h.returnNo,
          returnDate: String(h.returnDate),
          companyName: h.companyName,
          invoiceNumber: h.invoiceNumber,
          invoiceDate: h.invoiceDate ? String(h.invoiceDate) : null,
          reason: h.reason,
          status: h.status,
          taxAdjustmentDeadline: h.taxAdjustmentDeadline
            ? String(h.taxAdjustmentDeadline)
            : null,
          deadlineLabel: verdict?.label ?? null,
          taxRecoverable: verdict ? verdict.taxRecoverable : null,
          lineCount: lines.length,
          unsaleableLines: lines.filter((l) => l.condition !== "saleable").length,
          taxableValueMinor: serializeAmount(taxable),
          taxValueMinor: serializeAmount(tax),
          itcReversalMinor: serializeAmount(itc),
          notes: h.notes,
          inwardChallanNo: h.inwardChallanNo,
        },
        lines: lines.map((l) => ({
          lineNo: l.lineNo,
          description: l.description,
          itemName: l.itemName,
          batchNo: l.batchNo,
          serialNo: l.serialNo,
          quantity: String(l.quantity),
          uom: l.uom,
          condition: l.condition,
          conditionNote:
            RETURN_CONDITION_META[l.condition as ReturnCondition]?.note ?? "",
          warehouseName: l.warehouseName,
          taxableValueMinor: serializeAmount(toBigIntAmount(l.taxableValueMinor)),
          itcReversalMinor: serializeAmount(toBigIntAmount(l.itcReversalMinor)),
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getGoodsReturnDetail");
  }
}
