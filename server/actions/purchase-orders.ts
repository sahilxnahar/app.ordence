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
import { stockMovements } from "@/db/schema/inventory";
import { requirePermission, writeAudit } from "@/server/audit";
/**
 * ⚠️ THE PURE EVALUATOR, NOT `checkPermission`. Used once, to decide
 * whether the screen offers the match button. See `getPurchaseOrder` for
 * why the logging version is the wrong tool for a UI question.
 */
import { evaluatePermission } from "@/lib/permissions";
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
const ORDER = "settings:update" as const;
/**
 * 🔴 WAS `inventory.stock.read`. A goods receipt POSTS STOCK and closes
 * a purchase-order line; guarding it on the permission to *look* at
 * stock let the read-only role receive goods.
 */
const RECEIVE = "inventory.movements.post" as const;
const APPROVE = "settings:update" as const;

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
            /**
             * ⭐ v1.43.0: SELECTED SO THE STOCK MOVEMENT CARRIES A COST.
             *
             * ⚠️ Without it `unitCostMinor` on the movement would be
             * null, and a movement with no cost is invisible to every
             * valuation method. Batch 86 makes `valuationMethod` actually
             * read, and it would have read a ledger of costless receipts:
             * quantity right, value zero, inventory asset understated to
             * nothing on the balance sheet.
             */
            unitPriceMinor: purchaseOrderLines.unitPriceMinor,
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

        /* ---------------------------------------------------------- */
        /* ⭐⭐ v1.43.0 (Batch 38): THE GRN NOW MOVES THE STOCK         */
        /* ---------------------------------------------------------- */
        //
        // ══════════════════════════════════════════════════════════════
        // 🔴 IT DID NOT, AND THAT IS THE MOST EXPENSIVE KIND OF WRONG.
        // ══════════════════════════════════════════════════════════════
        // A goods receipt is the moment stock arrives. Until now this
        // action wrote a `goods_receipts` row, wrote its lines, moved the
        // purchase order's status, emitted an automation event, and left
        // the stock ledger untouched.
        //
        // ⚠️ SO EVERY QUANTITY IN THE PRODUCT WAS UNDERSTATED, silently,
        // by exactly the amount that had been received. Not "inventory is
        // a bit off": inventory could only ever go DOWN, because
        // `sales_dispatch` writes movements and `purchase_receipt` did
        // not. A warehouse that received a hundred and sold ten showed
        // minus ten.
        //
        // ⭐ ACCEPTED QUANTITY ONLY, NOT ACCEPTED PLUS REJECTED. Rejected
        // goods are physically on the premises and are NOT ours: they are
        // awaiting return to the vendor, they were never bought, and no
        // credit is owed on them. Counting them would inflate stock and
        // inflate the value of the inventory asset on the balance sheet.
        //
        // ⚠️ A LINE WITH NO `stockItemId` IS SKIPPED, NOT DEFAULTED. A
        // purchase order line for a service, a freight charge or a
        // one-off with no catalogue item has nothing to move. Inventing a
        // stock item for it would put a phantom row in the ledger that
        // nobody could ever count.
        const movements = data.lines
          .map((l) => {
            const poLine = byId.get(l.poLineId);
            const stockItemId = (poLine?.stockItemId as string | null) ?? null;
            const accepted = toThousandths(l.acceptedQty);
            return { stockItemId, accepted, unitCostMinor: poLine?.unitPriceMinor };
          })
          .filter((m) => m.stockItemId !== null && m.accepted > 0n);

        if (movements.length > 0) {
          /**
           * 🔴 A RECEIPT WITHOUT A WAREHOUSE CANNOT MOVE STOCK, AND IS
           * REFUSED RATHER THAN GUESSED.
           *
           * `goods_receipts.warehouse_id` is nullable, because a receipt
           * of pure services has no warehouse. But a receipt of ITEMS
           * with nowhere to put them is a data problem, and defaulting to
           * "the first warehouse" would put a hundred bags of cement in
           * whichever godown happened to sort first.
           */
          if (!data.warehouseId) {
            throw new Error(
              "This receipt includes stock items but no warehouse was chosen. " +
                "Stock has to arrive somewhere, and picking one for you would " +
                "put the goods in the wrong godown without telling anybody.",
            );
          }

          await tx.insert(stockMovements).values(
            movements.map((m) => ({
              tenantId: ctx.tenant.id,
              stockItemId: m.stockItemId as string,
              warehouseId: data.warehouseId as string,
              /**
               * ⭐ SIGNED, POSITIVE FOR IN. The schema comment is
               * explicit that a direction flag alongside an unsigned
               * quantity is two facts that can disagree.
               */
              quantity: fromThousandths(m.accepted),
              reason: "purchase_receipt" as const,
              movedAt: now,
              referenceType: "goods_receipt",
              referenceId: grn.id,
              unitCostMinor:
                typeof m.unitCostMinor === "bigint" ? m.unitCostMinor : null,
              createdBy: ctx.user.id,
            })) as never,
          );
        }

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
        /**
         * ══════════════════════════════════════════════════════════════
         * 🔴🔴 THE BILL IS COMPARED TO ITS OWN ORDER AND TO NOTHING ELSE
         * ══════════════════════════════════════════════════════════════
         * This join used to reach every `purchase_order_lines` row in the
         * TENANT whose description matched, with no `po_id` anywhere in
         * it. Two orders for "OPC 53 grade cement" — which is what a
         * builder's purchase ledger is made of — and a bill against the
         * first was measured against the second's quantities and the
         * second's agreed price. The verdict named a discrepancy that did
         * not exist, or worse, cleared one that did because the OTHER
         * order happened to cover the quantity.
         *
         * ⚠️ AND IT MULTIPLIED. A LEFT JOIN that matches three order lines
         * returns three rows for one bill line, so one line produced three
         * findings and its value landed in `netImpactMinor` three times.
         * The number on the approval screen was not the money at stake, it
         * was the money at stake times however many orders in the
         * workspace happened to spell the item the same way.
         *
         * ⭐ `purchase_invoices.po_id` HAS EXISTED SINCE 0063 and is what
         * `getPurchaseOrder` already lists the bills of. The match is the
         * one place that ignored it.
         *
         * ⭐ LATERAL … LIMIT 1, SO ONE BILL LINE IS AT MOST ONE ROW.
         * Restricting to `pi.po_id` alone is not enough: one order may
         * legitimately carry the same description on two lines (two
         * delivery dates, two rates). A plain join would still double the
         * finding. The lateral picks the lowest line number, and the cost
         * of that choice is visible — the second order line reads as
         * un-invoiced on the order screen, which is a fact somebody can
         * look at — where a doubled `netImpactMinor` is a wrong number
         * nobody can see is wrong.
         *
         * 🔴 A BILL WITH NO `po_id` MATCHES NOTHING, DELIBERATELY.
         * `pol.po_id = pi.po_id` is never true when `pi.po_id` is null, so
         * every line comes back with a null order and `matchThreeWay`
         * returns `no_order` — "there is no purchase order behind this
         * bill … somebody still has to approve it on its own merits". That
         * is the honest answer: a utility bill, a rent demand or a
         * professional fee never had an order, and a three-way match
         * needs three documents. The alternative — the old behaviour —
         * was to compare a non-PO bill against every order in the tenant
         * and print a verdict, which is a control saying "checked" about
         * something it never checked.
         *
         * ⚠️ `pi.tenant_id = pil.tenant_id` IS ON THE JOIN even though
         * `pi.id` is a primary key, because `pi.po_id` now decides what a
         * bill is compared with, and a cross-tenant row reaching that
         * comparison is the one bug in this file nobody would ever be
         * shown.
         */
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
           AND pi.tenant_id = pil.tenant_id
          -- ⚠️ LEFT JOINS THROUGHOUT. A bill line with no order behind it
          -- is a finding, not a row to drop: dropping it is how an
          -- unordered line gets silently approved.
          LEFT JOIN LATERAL (
            SELECT pol.id, pol.ordered_qty, pol.unit_price_minor
              FROM purchase_order_lines pol
             WHERE pol.tenant_id = pil.tenant_id
               -- 🔴 THE BILL'S OWN ORDER. Never the tenant's other orders.
               AND pol.po_id = pi.po_id
               AND lower(pol.description) = lower(pil.description)
             ORDER BY pol.line_no, pol.id
             LIMIT 1
          ) pol ON TRUE
          LEFT JOIN goods_receipt_lines grl
            ON grl.tenant_id = pil.tenant_id
           AND grl.po_line_id = pol.id
         WHERE pil.tenant_id = ${ctx.tenant.id}::uuid
           AND pil.purchase_invoice_id = ${invoiceId}::uuid
         GROUP BY pil.id, pil.description, pol.id, pol.ordered_qty,
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
/* ONE ORDER, WITH WHAT HAS ARRIVED AGAINST IT                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THOUSANDTHS ON THE WIRE, AS STRINGS, NOT NUMBERS.
 *
 * ⚠️ `orderedQty` is a bigint of thousandths. Serialising it as a
 * JavaScript number survives every quantity anybody will ever type and
 * then loses the last digit on the one that matters. Strings cross the
 * boundary and the screen divides by a thousand with string arithmetic.
 */
export interface OrderLineRow {
  readonly id: string;
  readonly lineNo: number;
  readonly description: string;
  /** ⭐ Null for a service or a freight charge. See `recordGoodsReceipt`. */
  readonly stockItemId: string | null;
  readonly stockItemName: string | null;
  readonly uom: string;
  readonly orderedQty: string;
  /** Accepted so far, summed over every receipt against this line. */
  readonly receivedQty: string;
  /** ⭐ Kept apart from accepted, everywhere, always. */
  readonly rejectedQty: string;
  readonly unitPriceMinor: string;
}

export interface ReceiptRow {
  readonly id: string;
  readonly grnNumber: string;
  readonly receivedOn: string;
  readonly status: string;
  readonly challanNo: string | null;
  readonly challanDate: string | null;
  readonly rejectionReason: string | null;
  readonly warehouseName: string | null;
  readonly lines: number;
}

export interface BillRow {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly totalMinor: string;
  readonly status: string;
  /** ⚠️ Null means nothing has ever checked it, not "checked and clean". */
  readonly matchState: string | null;
  readonly matchNote: string | null;
}

export interface OrderDetail {
  readonly id: string;
  readonly poNumber: string;
  readonly vendorName: string;
  readonly poDate: string;
  readonly expectedOn: string | null;
  readonly status: string;
  readonly currency: string;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
  readonly notes: string | null;
}

/**
 * ⭐⭐ THE READ THE RECEIPT SCREEN IS BUILT ON.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT IS GUARDED ON `RECEIVE`, NOT ON `ORDER`, AND THAT IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════
 * `getPurchaseOrders` — the list — is guarded on `ORDER`, because raising
 * and approving orders is what that screen does. This one is different:
 * the only write on this page is the goods receipt, and the person who
 * takes delivery is a storekeeper, not an administrator.
 *
 * ⚠️ GUARDING IT ON `ORDER` WOULD HAVE LEFT `recordGoodsReceipt` EXACTLY
 * AS UNREACHABLE AS IT WAS BEFORE. The storekeeper would hold the
 * permission to post the receipt and be refused the only screen that
 * offers it, so in practice the receipt would be booked by whoever holds
 * `settings:update` — which is the administrator who also raised and
 * approved the order. One hand writes all three documents and the
 * three-way match proves nothing, which is the failure this whole file
 * is arranged to prevent.
 */
export async function getPurchaseOrder(poId: unknown): Promise<
  ActionResult<{
    order: OrderDetail | null;
    lines: readonly OrderLineRow[];
    receipts: readonly ReceiptRow[];
    bills: readonly BillRow[];
    /** ⭐ May THIS viewer run the match? See below. */
    canMatch: boolean;
  }>
> {
  try {
    // ⚠️ PARSED, NOT TRUSTED. This is a browser-reachable URL and the id
    // is interpolated into SQL casts; a value that is not a uuid must be
    // refused here rather than by Postgres three statements later.
    const id = z.string().uuid().parse(poId);
    const ctx = await requirePermission(RECEIVE);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [po] = await tx
          .select({
            id: purchaseOrders.id,
            poNumber: purchaseOrders.poNumber,
            poDate: purchaseOrders.poDate,
            expectedOn: purchaseOrders.expectedOn,
            status: purchaseOrders.status,
            currency: purchaseOrders.currency,
            subtotalMinor: purchaseOrders.subtotalMinor,
            taxMinor: purchaseOrders.taxMinor,
            totalMinor: purchaseOrders.totalMinor,
            notes: purchaseOrders.notes,
            vendorName: vendors.legalName,
          })
          .from(purchaseOrders)
          .innerJoin(
            vendors,
            and(eq(vendors.id, purchaseOrders.vendorId), eq(vendors.tenantId, ctx.tenant.id)),
          )
          .where(and(eq(purchaseOrders.tenantId, ctx.tenant.id), eq(purchaseOrders.id, id)))
          .limit(1);

        /**
         * ⚠️ A MISSING ORDER RETURNS `ok` WITH A NULL ORDER, NOT AN ERROR.
         *
         * 🔴 The screen has to tell "you may not read this" apart from
         * "there is no such order", and it cannot if both arrive as
         * `{ ok: false }`. Somebody with the wrong role would spend the
         * afternoon hunting for a record that is sitting right there.
         */
        if (!po) {
          return {
            ok: true as const,
            data: { order: null, lines: [], receipts: [], bills: [], canMatch: false },
          };
        }

        /**
         * ⭐ RECEIVED IS SUMMED FROM THE RECEIPT LINES, never stored on the
         * order line.
         *
         * ⚠️ A running `received_qty` column on the order line is a second
         * copy of a number the receipts already prove, and the two drift
         * the first time a receipt is corrected. The sum cannot drift from
         * the rows it is a sum of.
         */
        const lineRows = await tx.execute(sql`
          SELECT pol.id::text                         AS id,
                 pol.line_no                          AS line_no,
                 pol.description                      AS description,
                 pol.stock_item_id::text              AS stock_item_id,
                 si.name                              AS stock_item_name,
                 COALESCE(pol.uom, 'nos')             AS uom,
                 pol.ordered_qty::text                AS ordered_qty,
                 pol.unit_price_minor::text           AS unit_price_minor,
                 COALESCE(SUM(grl.accepted_qty), 0)::text AS received_qty,
                 COALESCE(SUM(grl.rejected_qty), 0)::text AS rejected_qty
            FROM purchase_order_lines pol
            LEFT JOIN stock_items si
              ON si.id = pol.stock_item_id
             AND si.tenant_id = pol.tenant_id
            LEFT JOIN goods_receipt_lines grl
              ON grl.tenant_id = pol.tenant_id
             AND grl.po_line_id = pol.id
           WHERE pol.tenant_id = ${ctx.tenant.id}::uuid
             AND pol.po_id = ${id}::uuid
           GROUP BY pol.id, pol.line_no, pol.description, pol.stock_item_id,
                    si.name, pol.uom, pol.ordered_qty, pol.unit_price_minor
           ORDER BY pol.line_no
        `);

        const receiptRows = await tx.execute(sql`
          SELECT g.id::text            AS id,
                 g.grn_number          AS grn_number,
                 g.received_on::text   AS received_on,
                 g.status              AS status,
                 g.challan_no          AS challan_no,
                 g.challan_date::text  AS challan_date,
                 g.rejection_reason    AS rejection_reason,
                 w.name                AS warehouse_name,
                 (SELECT count(*) FROM goods_receipt_lines l
                   WHERE l.grn_id = g.id)::int AS line_count
            FROM goods_receipts g
            LEFT JOIN warehouses w
              ON w.id = g.warehouse_id
             AND w.tenant_id = g.tenant_id
           WHERE g.tenant_id = ${ctx.tenant.id}::uuid
             AND g.po_id = ${id}::uuid
           ORDER BY g.received_on DESC, g.grn_number DESC
        `);

        /**
         * ⭐ THE BILLS AGAINST THIS ORDER, so the match has somewhere to be
         * run from. `purchase_invoices.po_id` has existed since 0063.
         *
         * ⚠️ `status` IS AN ENUM AND IS CAST TO text. A pg enum arrives as
         * an object through some drivers and as a string through others,
         * and `String(...)` on the object form yields "[object Object]" in
         * production and nothing suspicious in a test.
         */
        const billRows = await tx.execute(sql`
          SELECT pi.id::text          AS id,
                 pi.invoice_number    AS invoice_number,
                 pi.invoice_date::text AS invoice_date,
                 pi.total_minor::text AS total_minor,
                 pi.status::text      AS status,
                 pi.match_state       AS match_state,
                 pi.match_note        AS match_note
            FROM purchase_invoices pi
           WHERE pi.tenant_id = ${ctx.tenant.id}::uuid
             AND pi.po_id = ${id}::uuid
           ORDER BY pi.invoice_date DESC, pi.invoice_number DESC
        `);

        /**
         * 🔴 WHETHER THE MATCH BUTTON IS OFFERED IS ANSWERED HERE, PURELY.
         *
         * ⚠️ `checkPermission` WOULD HAVE BEEN THE OBVIOUS CALL AND IT
         * WRITES A ROW TO `permission_denials` EVERY TIME IT SAYS NO. The
         * storekeeper who legitimately cannot approve bills would log a
         * denial on every page view, and `permission_denials` is read as a
         * security signal — a cluster of them is how somebody probing for
         * access is spotted. Filling it with the expected answer to a
         * question nobody asked destroys the signal.
         *
         * ⭐ AND THE BUTTON BEING HIDDEN IS NOT THE CONTROL.
         * `runThreeWayMatch` still calls `requirePermission(APPROVE)`
         * itself; this only stops the screen offering what the server will
         * refuse.
         */
        const canMatch = evaluatePermission(
          { role: ctx.role, overrides: ctx.user.permissionOverrides },
          APPROVE,
        ).allowed;

        return {
          ok: true as const,
          data: {
            order: {
              id: po.id,
              poNumber: po.poNumber,
              vendorName: po.vendorName,
              poDate: po.poDate,
              expectedOn: po.expectedOn ?? null,
              status: po.status,
              currency: po.currency,
              subtotalMinor: po.subtotalMinor.toString(),
              taxMinor: po.taxMinor.toString(),
              totalMinor: po.totalMinor.toString(),
              notes: po.notes ?? null,
            },
            lines: rowsOf<Record<string, unknown>>(lineRows).map((r) => ({
              id: String(r.id),
              lineNo: Number(r.line_no ?? 0),
              description: String(r.description ?? ""),
              stockItemId: r.stock_item_id === null ? null : String(r.stock_item_id),
              stockItemName: r.stock_item_name === null ? null : String(r.stock_item_name),
              uom: String(r.uom ?? "nos"),
              orderedQty: String(r.ordered_qty ?? "0"),
              receivedQty: String(r.received_qty ?? "0"),
              rejectedQty: String(r.rejected_qty ?? "0"),
              unitPriceMinor: String(r.unit_price_minor ?? "0"),
            })),
            receipts: rowsOf<Record<string, unknown>>(receiptRows).map((r) => ({
              id: String(r.id),
              grnNumber: String(r.grn_number),
              receivedOn: String(r.received_on),
              status: String(r.status),
              challanNo: r.challan_no === null ? null : String(r.challan_no),
              challanDate: r.challan_date === null ? null : String(r.challan_date),
              rejectionReason:
                r.rejection_reason === null ? null : String(r.rejection_reason),
              warehouseName: r.warehouse_name === null ? null : String(r.warehouse_name),
              lines: Number(r.line_count ?? 0),
            })),
            bills: rowsOf<Record<string, unknown>>(billRows).map((r) => ({
              id: String(r.id),
              invoiceNumber: String(r.invoice_number),
              invoiceDate: String(r.invoice_date),
              totalMinor: String(r.total_minor ?? "0"),
              status: String(r.status ?? ""),
              matchState: r.match_state === null ? null : String(r.match_state),
              matchNote: r.match_note === null ? null : String(r.match_note),
            })),
            canMatch,
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getPurchaseOrder");
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
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 LINE BY LINE. THE TOTAL IS NOT THE TEST — IT NEVER WAS.
 * ══════════════════════════════════════════════════════════════════════
 * This compared `SUM(ordered)` against `SUM(accepted)` across the whole
 * order, and a sum lets two lines cancel each other out. Order 100 bags
 * of cement and 100 of sand; 120 bags of cement arrive and 80 of sand;
 * the totals are 200 and 200, the order flips to `received`, and 20 bags
 * of sand nobody ever delivered are closed and stop being chased. The
 * over-delivery on one line PAID FOR the shortfall on the other.
 *
 * ⭐ IT IS THE SAME MISTAKE `lib/purchases/three-way.ts` REFUSES TO MAKE
 * in its own headline comment — "two lines that are wrong in opposite
 * directions net to a correct total". A file that matches bills line by
 * line and closes orders on a total is arguing with itself.
 *
 * ⚠️ AND THE COUNTING NOW HAPPENS IN POSTGRES, NOT IN JAVASCRIPT.
 * The old version pulled two quantity sums out as `Number(...)`, which is
 * a float over `bigint` thousandths: an order of ten thousand tonnes,
 * expressed in thousandths, is past the point where `Number` still tells
 * the truth about its last digit. What crosses the boundary now is three
 * counts of lines, which are small integers by construction.
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
      count(*)::int AS line_count,
      count(*) FILTER (WHERE COALESCE(recv.accepted, 0) > 0)::int
        AS lines_started,
      -- ⚠️ GREATER-OR-EQUAL RATHER THAN EQUAL, PER LINE. (No backticks in
      -- here: this is a template literal and one would end the query.)
      -- Over-delivery is common and a line that received 101 of 100 is not
      -- still outstanding; it is complete, and the extra unit is a finding
      -- for the three-way match rather than a reason to leave the order
      -- open forever. What it must NOT do is let that extra unit count
      -- towards a DIFFERENT line, which is exactly what summing did.
      count(*) FILTER (WHERE COALESCE(recv.accepted, 0) >= pol.ordered_qty)::int
        AS lines_complete
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
  const lineCount = Number(row.line_count ?? 0);
  const linesStarted = Number(row.lines_started ?? 0);
  const linesComplete = Number(row.lines_complete ?? 0);

  // ⭐ EVERY line has to be complete before the order is. An order with no
  // lines at all has nothing started and stays `approved`, which is the
  // only answer that is not a claim about goods.
  const status =
    linesStarted === 0
      ? "approved"
      : linesComplete >= lineCount
        ? "received"
        : "part_received";

  await tx
    .update(purchaseOrders)
    .set({ status, updatedAt: now, updatedBy: userId })
    .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, poId)));

  return status;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE NUMBER IS A HINT. THE UNIQUE INDEX IS THE GUARANTEE.
 * ══════════════════════════════════════════════════════════════════════
 * Both of these read `MAX(...) + 1` with nothing holding the row they
 * read, so two receipts booked in the same second read the same maximum
 * and propose the same number. That is not an oversight being ignored:
 * `purchase_orders_number_unique (tenant_id, po_number)` and
 * `goods_receipts_number_unique (tenant_id, grn_number)` — both in 0063 —
 * are what actually decides. The second INSERT raises 23505, the WHOLE
 * transaction rolls back, and nothing partial survives: no receipt row,
 * no receipt lines, no stock movements, no order-status change. The
 * storekeeper presses save again and reads the new maximum.
 *
 * 🔴 THE SAME REASONING AS `nextOrderNo` IN `server/actions/orders.ts`,
 * ON PURPOSE. Two numbering schemes in one product where one takes a lock
 * and one does not is a difference somebody has to hold in their head
 * forever, and the first person to "make them consistent" will pick the
 * wrong direction.
 *
 * ⚠️ WHY THE ADVISORY LOCK WAS REJECTED, since it is the obvious fix.
 * `pg_advisory_xact_lock(hashtext(tenant || ':grn'))` would hand out
 * numbers with no collisions — and would hold that lock until COMMIT,
 * because an xact lock cannot be released earlier. `recordGoodsReceipt`
 * does real work after the number is drawn: it writes the receipt, its
 * lines, a stock movement per line, and recomputes the order status. So
 * the lock would serialise the ENTIRE receipt path for a tenant, and a
 * godown with four bays booking four lorries in would process them one
 * after another to prevent a collision that the index already prevents.
 * It buys a nicer error message for a rare loser and pays for it with
 * throughput on every single receipt.
 *
 * ⚠️ THE COST OF THIS CHOICE, STATED PLAINLY: the loser of the race gets
 * `toSalesActionError`'s generic "That record already exists.", which
 * does not tell a storekeeper to simply try again. Naming
 * `goods_receipts_number_unique` in `server/sales/guards.ts` — where
 * `units_code_project_unique` and its siblings already are — is the fix
 * for that, and it is a change to a different file.
 */
async function nextNumber(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.execute(sql`
    SELECT COALESCE(MAX(NULLIF(regexp_replace(po_number, '\\D', '', 'g'), '')::int), 0) + 1 AS next
      FROM purchase_orders WHERE tenant_id = ${tenantId}::uuid
  `);
  const n = Number(rowsOf<{ next?: number }>(r)[0]?.next ?? 1);
  return `PO-${String(n).padStart(5, "0")}`;
}

/** ⭐ A hint, exactly as `nextNumber` above. See the note there for why the
 * advisory lock was rejected and what `goods_receipts_number_unique` does
 * about the collision. */
async function nextGrnNumber(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.execute(sql`
    SELECT COALESCE(MAX(NULLIF(regexp_replace(grn_number, '\\D', '', 'g'), '')::int), 0) + 1 AS next
      FROM goods_receipts WHERE tenant_id = ${tenantId}::uuid
  `);
  const n = Number(rowsOf<{ next?: number }>(r)[0]?.next ?? 1);
  return `GRN-${String(n).padStart(5, "0")}`;
}

void purchaseInvoiceLines;
