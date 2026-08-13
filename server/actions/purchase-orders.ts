"use server";

/**
 * Ordence — ⭐⭐⭐ PURCHASE ORDERS, GOODS RECEIPTS AND THE MATCH
 * Version: v1.19.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE HALF OF v1.11.0 THAT WAS NEVER BUILT
 * ══════════════════════════════════════════════════════════════════════
 * That session shipped 0063 and reported "purchase orders, goods
 * receipts, three-way match, vendor payments and the payment run". The
 * payment run is real and works. The rest was four tables nobody wrote
 * to: `purchase_orders`, `purchase_order_lines`, `goods_receipts` and
 * `goods_receipt_lines`. The orphan census in v1.19.0 found them.
 *
 * ⚠️ AND `purchase_invoices.match_state` HAS BEEN READ BY THE PAYMENT
 * RUN SINCE v1.11.0 WITHOUT ANYTHING EVER SETTING IT. Every bill in the
 * payment screen has shown a blank match state, which reads as "not
 * checked" and was in fact "not checkable".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE CHAIN, AND WHY EACH STEP IS SEPARATE
 * ══════════════════════════════════════════════════════════════════════
 * ORDER: what was agreed, before anything arrives.
 * RECEIPT: what actually turned up, recorded by whoever took delivery.
 * MATCH: run against the bill, by somebody in the office.
 *
 * 🔴 THE THREE ARE DELIBERATELY WRITTEN BY DIFFERENT PEOPLE AT DIFFERENT
 * TIMES. A system where one person can raise the order, book the receipt
 * and approve the bill has a three-way match that proves nothing at all,
 * because the same hand wrote all three documents.
 */

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  goodsReceiptLines,
  goodsReceipts,
  purchaseOrderLines,
  purchaseOrders,
} from "@/db/schema/procurement";
import { purchaseInvoices, purchaseInvoiceLines, vendors } from "@/db/schema/purchases";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { tryEmitAutomationEvent } from "@/server/automation/emit";
import {
  DEFAULT_TOLERANCE,
  matchThreeWay,
  fromThousandths,
  toThousandths,
  type MatchLine,
  type MatchResult,
} from "@/lib/purchases/three-way";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * 🔴 THREE PERMISSIONS, AND THE SEPARATION IS THE CONTROL.
 *
 * ⚠️ Collapsing these to one means whoever orders also receives and also
 * approves, and a three-way match between three documents one person
 * wrote is theatre.
 */
const ORDER = "settings.manage" as const;
const RECEIVE = "inventory.stock.read" as const;
const APPROVE = "settings.manage" as const;

/* ------------------------------------------------------------------ */
/* THE ORDER                                                           */
/* ------------------------------------------------------------------ */

const raiseSchema = z.object({
  vendorId: z.string().uuid(),
  poDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        stockItemId: z.string().uuid().optional().nullable(),
        hsnSacCode: z.string().max(20).optional().nullable(),
        uom: z.string().max(20).default("nos"),
        orderedQty: z.string().regex(/^\d+(\.\d{1,3})?$/),
        unitPriceMinor: z.string(),
        taxRateBps: z.number().int().min(0).max(10_000).default(0),
      }),
    )
    .min(1)
    .max(500),
});

export async function raisePurchaseOrder(
  input: unknown,
): Promise<ActionResult<{ id: string; poNumber: string; totalMinor: string }>> {
  try {
    const data = raiseSchema.parse(input);
    const ctx = await requirePermission(ORDER);
    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [vendor] = await tx
          .select({ id: vendors.id, name: vendors.legalName })
          .from(vendors)
          .where(and(eq(vendors.tenantId, ctx.tenant.id), eq(vendors.id, data.vendorId)))
          .limit(1);

        if (!vendor) throw new Error("No such vendor.");

        // ⚠️ TOTALS ARE COMPUTED HERE AND NEVER ACCEPTED FROM THE CALLER.
        // Every export in this file is a browser-reachable endpoint, and a
        // total that arrives from the browser is a total somebody can
        // choose.
        // ⚠️ 0063 STORES QUANTITIES AS bigint THOUSANDTHS, "the same
        // convention as the stock ledger", and its own comment says so.
        // Converting once here keeps the rest of the file in one unit.
        let subtotal = 0n;
        let tax = 0n;
        const thousandths = data.lines.map((l) => toThousandths(l.orderedQty));
        data.lines.forEach((l, i) => {
          const lineValue = (thousandths[i]! * BigInt(l.unitPriceMinor)) / 1000n;
          subtotal += lineValue;
          tax += (lineValue * BigInt(l.taxRateBps)) / 10_000n;
        });

        const poNumber = await nextNumber(tx, ctx.tenant.id);

        const [po] = await tx
          .insert(purchaseOrders)
          .values({
            tenantId: ctx.tenant.id,
            vendorId: data.vendorId,
            poNumber,
            poDate: data.poDate,
            expectedOn: data.expectedOn ?? null,
            subtotalMinor: subtotal,
            taxMinor: tax,
            totalMinor: subtotal + tax,
            // 🔴 DRAFT, NOT APPROVED. An order that commits money the
            // moment it is typed is an order nobody reviews.
            status: "draft",
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: purchaseOrders.id });

        if (!po) throw new Error("The order could not be saved.");

        await tx.insert(purchaseOrderLines).values(
          data.lines.map((l, i) => ({
            tenantId: ctx.tenant.id,
            poId: po.id,
            lineNo: i + 1,
            description: l.description,
            stockItemId: l.stockItemId ?? null,
            hsnSacCode: l.hsnSacCode ?? null,
            uom: l.uom,
            orderedQty: thousandths[i]!,
            unitPriceMinor: BigInt(l.unitPriceMinor),
            taxRateBps: l.taxRateBps,
          })),
        );

        // ⭐⭐ THE EVENT. See `server/automation/emit.ts` for why this is
        // best-effort: a storm brake refusing the twenty-first event must
        // not take the twenty-first genuine order down with it.
        const emitted = await tryEmitAutomationEvent({
          tx,
          tenantId: ctx.tenant.id,
          trigger: "record_created",
          recordType: "purchase_order",
          recordId: po.id,
          payload: { poNumber, totalMinor: (subtotal + tax).toString() },
          now,
        });

        await writeAudit(ctx, {
          action: "create",
          resourceType: "purchase_order",
          resourceId: po.id,
          newValue: {
            poNumber,
            vendor: vendor.name,
            lines: data.lines.length,
            totalMinor: (subtotal + tax).toString(),
            automationEvent: emitted.emitted ? "written" : emitted.reason,
          },
          severity: "notice",
        });

        return { id: po.id, poNumber, totalMinor: (subtotal + tax).toString() };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/purchases/orders");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "raisePurchaseOrder");
  }
}

export async function approvePurchaseOrder(
  input: unknown,
): Promise<ActionResult<{ approved: true }>> {
  try {
    const { poId } = z.object({ poId: z.string().uuid() }).parse(input);
    const ctx = await requirePermission(APPROVE);
    const now = new Date();

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(purchaseOrders)
          .set({
            status: "approved",
            approvedBy: ctx.user.id,
            approvedAt: now,
            updatedAt: now,
            updatedBy: ctx.user.id,
          })
          .where(
            and(eq(purchaseOrders.tenantId, ctx.tenant.id), eq(purchaseOrders.id, poId)),
          );

        await tryEmitAutomationEvent({
          tx,
          tenantId: ctx.tenant.id,
          trigger: "record_updated",
          recordType: "purchase_order",
          recordId: poId,
          // ⭐ NAMED, so a workflow watching `status` fires and one
          // watching `notes` does not. See the loop brake note in emit.ts.
          changedFields: ["status", "approved_at"],
          now,
        });

        await writeAudit(ctx, {
          action: "update",
          resourceType: "purchase_order",
          resourceId: poId,
          newValue: { status: "approved" },
          severity: "notice",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/purchases/orders");
    return { ok: true, data: { approved: true } };
  } catch (err) {
    return toSalesActionError(err, "approvePurchaseOrder");
  }
}

/* ------------------------------------------------------------------ */
/* THE RECEIPT                                                         */
/* ------------------------------------------------------------------ */

const receiveSchema = z.object({
  poId: z.string().uuid(),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  warehouseId: z.string().uuid().optional().nullable(),
  challanNo: z.string().max(100).optional().nullable(),
  challanDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  rejectionReason: z.string().max(1000).optional().nullable(),
  lines: z
    .array(
      z.object({
        poLineId: z.string().uuid(),
        acceptedQty: z.string().regex(/^\d+(\.\d{1,3})?$/),
        /** ⭐ Separate from accepted, always. See below. */
        rejectedQty: z.string().regex(/^\d+(\.\d{1,3})?$/).default("0"),
      }),
    )
    .min(1),
});

/**
 * ⭐⭐ RECEIVED IS NOT THE SAME AS ACCEPTED, AND THE DIFFERENCE IS THE
 * WHOLE REASON THIS RECORDS TWO NUMBERS.
 *
 * 🔴 Forty bags arrive, six are torn, thirty-four are accepted. A system
 * that stores one quantity has to choose which lie to tell: "forty
 * arrived" makes the bill matchable and pays for six torn bags, and
 * "thirty-four arrived" loses the fact that six came and went back.
 *
 * ⚠️ The three-way match reads `accepted`, and `rejected` is what turns
 * a bill charging for them into a named finding rather than a silent
 * over-payment.
 */
export async function recordGoodsReceipt(
  input: unknown,
): Promise<ActionResult<{ id: string; grnNumber: string; poStatus: string }>> {
  try {
    const data = receiveSchema.parse(input);
    const ctx = await requirePermission(RECEIVE);
    const now = new Date();

    const rejectedAnything = data.lines.some((l) => Number(l.rejectedQty) > 0);
    if (rejectedAnything && !data.rejectionReason) {
      // ⚠️ 0063 carries the same rule as a CHECK. Asking here turns a
      // constraint violation into a sentence.
      return {
        ok: false,
        error:
          "Something was rejected and no reason was given. A rejection with no reason cannot be argued with the vendor later, which is the only moment it matters.",
      };
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [po] = await tx
          .select({
            id: purchaseOrders.id,
            vendorId: purchaseOrders.vendorId,
            status: purchaseOrders.status,
          })
          .from(purchaseOrders)
          .where(
            and(eq(purchaseOrders.tenantId, ctx.tenant.id), eq(purchaseOrders.id, data.poId)),
          )
          .limit(1);

        if (!po) throw new Error("No such purchase order.");
        if (po.status === "draft") {
          throw new Error(
            "This order has not been approved yet. Booking goods in against an unapproved order records a commitment nobody made.",
          );
        }

        const grnNumber = await nextGrnNumber(tx, ctx.tenant.id);

        const [grn] = await tx
          .insert(goodsReceipts)
          .values({
            tenantId: ctx.tenant.id,
            vendorId: po.vendorId,
            poId: data.poId,
            grnNumber,
            receivedOn: data.receivedOn,
            challanNo: data.challanNo ?? null,
            challanDate: data.challanDate ?? null,
            warehouseId: data.warehouseId ?? null,
            receivedBy: ctx.user.id,
            status: rejectedAnything ? "part_rejected" : "received",
            rejectionReason: data.rejectionReason ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: goodsReceipts.id });

        if (!grn) throw new Error("The receipt could not be saved.");

        const poLines = await tx
          .select({
            id: purchaseOrderLines.id,
            lineNo: purchaseOrderLines.lineNo,
            description: purchaseOrderLines.description,
            stockItemId: purchaseOrderLines.stockItemId,
          })
          .from(purchaseOrderLines)
          .where(
            and(
              eq(purchaseOrderLines.tenantId, ctx.tenant.id),
              eq(purchaseOrderLines.poId, data.poId),
            ),
          );

        const byId = new Map(
          (poLines as Array<Record<string, unknown>>).map((l) => [l.id as string, l]),
        );

        await tx.insert(goodsReceiptLines).values(
          data.lines.map((l, i) => {
            const poLine = byId.get(l.poLineId);
            if (!poLine) throw new Error("A receipt line names an order line that is not on this order.");
            return {
              tenantId: ctx.tenant.id,
              grnId: grn.id,
              poLineId: l.poLineId,
              lineNo: i + 1,
              description: poLine.description as string,
              stockItemId: (poLine.stockItemId as string | null) ?? null,
              acceptedQty: toThousandths(l.acceptedQty),
              rejectedQty: toThousandths(l.rejectedQty),
            };
          }),
        );

        // ⭐ THE ORDER'S STATUS FOLLOWS FROM WHAT HAS ARRIVED, computed
        // from the receipts rather than typed. A status somebody sets by
        // hand is a status that disagrees with the rows underneath it.
        const poStatus = await recomputeOrderStatus(tx, ctx.tenant.id, data.poId, now, ctx.user.id);

        await tryEmitAutomationEvent({
          tx,
          tenantId: ctx.tenant.id,
          trigger: "record_created",
          recordType: "goods_receipt",
          recordId: grn.id,
          payload: { grnNumber, poId: data.poId, rejected: rejectedAnything },
          now,
        });

        await writeAudit(ctx, {
          action: "create",
          resourceType: "goods_receipt",
          resourceId: grn.id,
          newValue: { grnNumber, poId: data.poId, lines: data.lines.length, poStatus },
          severity: "notice",
        });

        return { id: grn.id, grnNumber, poStatus };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/purchases/orders");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recordGoodsReceipt");
  }
}

/* ------------------------------------------------------------------ */
/* THE MATCH                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ THE FUNCTION THAT FINALLY SETS `match_state`.
 *
 * ⚠️ The payment run has read this column since v1.11.0 and has only
 * ever seen null, which the screen renders as an empty cell. An empty
 * cell reads as "not checked yet". It meant "nothing in this system has
 * ever been able to check it".
 *
 * 🔴 THE RESULT IS STORED AT APPROVAL, not recomputed on display. 0063's
 * own comment says why: the reason a bill was passed has to survive the
 * tolerance being changed later. A screen that recomputes shows today's
 * verdict against today's tolerance for a decision taken in March.
 */
export async function runThreeWayMatch(
  input: unknown,
): Promise<ActionResult<MatchResult & { invoiceId: string }>> {
  try {
    const { invoiceId } = z.object({ invoiceId: z.string().uuid() }).parse(input);
    const ctx = await requirePermission(APPROVE);
    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const lines = await tx.execute(sql`
          SELECT
            pil.id::text                       AS line_key,
            pil.description                    AS description,
            pol.ordered_qty                    AS ordered_qty,
            pol.unit_price_minor               AS ordered_price,
            COALESCE(SUM(grl.accepted_qty), 0) AS received_qty,
            COALESCE(SUM(grl.rejected_qty), 0) AS rejected_qty,
            pil.quantity                       AS invoiced_qty,
            pil.unit_price_minor               AS invoiced_price
          FROM purchase_invoice_lines pil
          JOIN purchase_invoices pi
            ON pi.id = pil.purchase_invoice_id
          -- ⚠️ LEFT JOINS THROUGHOUT. A bill line with no order behind it
          -- is a finding, not a row to drop: dropping it is how an
          -- unordered line gets silently approved.
          LEFT JOIN purchase_order_lines pol
            ON pol.tenant_id = pil.tenant_id
           AND lower(pol.description) = lower(pil.description)
          LEFT JOIN goods_receipt_lines grl
            ON grl.tenant_id = pol.tenant_id
           AND grl.po_line_id = pol.id
         WHERE pil.tenant_id = ${ctx.tenant.id}::uuid
           AND pil.purchase_invoice_id = ${invoiceId}::uuid
         GROUP BY pil.id, pil.description, pol.ordered_qty,
                  pol.unit_price_minor, pil.quantity, pil.unit_price_minor
        `);

        const rows = rowsOf<Record<string, unknown>>(lines);

        const matchLines: MatchLine[] = rows.map((r) => ({
          lineKey: String(r.line_key),
          description: String(r.description ?? "line"),
          orderedQty:
            r.ordered_qty === null ? null : fromThousandths(BigInt(String(r.ordered_qty))),
          orderedUnitPriceMinor:
            r.ordered_price === null ? null : BigInt(String(r.ordered_price)),
          receivedQty:
            r.ordered_qty === null
              ? null
              : fromThousandths(BigInt(String(r.received_qty ?? "0"))),
          rejectedQty: fromThousandths(BigInt(String(r.rejected_qty ?? "0"))),
          invoicedQty: String(r.invoiced_qty ?? "0"),
          invoicedUnitPriceMinor: BigInt(String(r.invoiced_price ?? "0")),
        }));

        const verdict = matchThreeWay(matchLines, DEFAULT_TOLERANCE, now);

        await tx
          .update(purchaseInvoices)
          .set({
            matchState: verdict.state,
            // 🔴 0063 refuses `matched_within_tolerance` with no note.
            matchNote: verdict.note,
          })
          .where(
            and(
              eq(purchaseInvoices.tenantId, ctx.tenant.id),
              eq(purchaseInvoices.id, invoiceId),
            ),
          );

        await tryEmitAutomationEvent({
          tx,
          tenantId: ctx.tenant.id,
          trigger: "record_updated",
          recordType: "purchase_invoice",
          recordId: invoiceId,
          changedFields: ["match_state"],
          payload: { matchState: verdict.state },
          now,
        });

        await writeAudit(ctx, {
          action: "update",
          resourceType: "purchase_invoice",
          resourceId: invoiceId,
          newValue: {
            matchState: verdict.state,
            findings: verdict.findings.length,
            netImpactMinor: verdict.netImpactMinor.toString(),
          },
          severity: verdict.state === "unmatched" ? "critical" : "notice",
        });

        return { ...verdict, invoiceId };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/purchases");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "runThreeWayMatch");
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export interface OrderCard {
  readonly id: string;
  readonly poNumber: string;
  readonly vendorName: string;
  readonly poDate: string;
  readonly status: string;
  readonly totalMinor: string;
  readonly lines: number;
  readonly receipts: number;
}

export async function getPurchaseOrders(): Promise<
  ActionResult<{
    orders: readonly OrderCard[];
    vendors: ReadonlyArray<{ id: string; name: string }>;
  }>
> {
  try {
    const ctx = await requirePermission(ORDER);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx.execute(sql`
          SELECT po.id::text, po.po_number, po.po_date::text, po.status,
                 po.total_minor::text,
                 v.legal_name AS vendor_name,
                 (SELECT count(*) FROM purchase_order_lines l
                   WHERE l.po_id = po.id)::int AS line_count,
                 (SELECT count(*) FROM goods_receipts g
                   WHERE g.po_id = po.id)::int AS receipt_count
            FROM purchase_orders po
            JOIN vendors v ON v.id = po.vendor_id
           WHERE po.tenant_id = ${ctx.tenant.id}::uuid
           ORDER BY po.po_date DESC, po.po_number DESC
           LIMIT 100
        `);

        const vendorRows = await tx
          .select({ id: vendors.id, name: vendors.legalName })
          .from(vendors)
          .where(eq(vendors.tenantId, ctx.tenant.id))
          .limit(500);

        return {
          ok: true as const,
          data: {
            orders: rowsOf<Record<string, unknown>>(rows).map((r) => ({
              id: String(r.id),
              poNumber: String(r.po_number),
              vendorName: String(r.vendor_name),
              poDate: String(r.po_date),
              status: String(r.status),
              totalMinor: String(r.total_minor),
              lines: Number(r.line_count ?? 0),
              receipts: Number(r.receipt_count ?? 0),
            })),
            vendors: vendorRows,
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getPurchaseOrders");
  }
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * ⭐ THE ORDER'S STATUS IS COMPUTED FROM ITS RECEIPTS, NEVER TYPED.
 *
 * ⚠️ A status somebody sets by hand is a status that disagrees with the
 * rows underneath it, and the disagreement is invisible until a report
 * says nine orders are outstanding and the warehouse says four.
 */
async function recomputeOrderStatus(
  tx: Tx,
  tenantId: string,
  poId: string,
  now: Date,
  userId: string,
): Promise<string> {
  const result = await tx.execute(sql`
    SELECT
      COALESCE(SUM(pol.ordered_qty), 0)                       AS ordered,
      COALESCE(SUM(recv.accepted), 0)                         AS accepted
      FROM purchase_order_lines pol
      LEFT JOIN (
        SELECT grl.po_line_id, SUM(grl.accepted_qty) AS accepted
          FROM goods_receipt_lines grl
         WHERE grl.tenant_id = ${tenantId}::uuid
         GROUP BY grl.po_line_id
      ) recv ON recv.po_line_id = pol.id
     WHERE pol.tenant_id = ${tenantId}::uuid
       AND pol.po_id = ${poId}::uuid
  `);

  const row = rowsOf<Record<string, unknown>>(result)[0] ?? {};
  const ordered = Number(row.ordered ?? 0);
  const accepted = Number(row.accepted ?? 0);

  // ⚠️ `>=` RATHER THAN `===`. Over-delivery is common and an order that
  // received 101 of 100 is not still part received; it is received, and
  // the extra unit is a finding for the three-way match rather than a
  // reason to leave the order open forever.
  const status = accepted <= 0 ? "approved" : accepted >= ordered ? "received" : "part_received";

  await tx
    .update(purchaseOrders)
    .set({ status, updatedAt: now, updatedBy: userId })
    .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, poId)));

  return status;
}

async function nextNumber(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.execute(sql`
    SELECT COALESCE(MAX(NULLIF(regexp_replace(po_number, '\\D', '', 'g'), '')::int), 0) + 1 AS next
      FROM purchase_orders WHERE tenant_id = ${tenantId}::uuid
  `);
  const n = Number(rowsOf<{ next?: number }>(r)[0]?.next ?? 1);
  return `PO-${String(n).padStart(5, "0")}`;
}

async function nextGrnNumber(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.execute(sql`
    SELECT COALESCE(MAX(NULLIF(regexp_replace(grn_number, '\\D', '', 'g'), '')::int), 0) + 1 AS next
      FROM goods_receipts WHERE tenant_id = ${tenantId}::uuid
  `);
  const n = Number(rowsOf<{ next?: number }>(r)[0]?.next ?? 1);
  return `GRN-${String(n).padStart(5, "0")}`;
}

void purchaseInvoiceLines;
