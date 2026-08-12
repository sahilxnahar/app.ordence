"use server";

/**
 * Ordence — ⭐ Sales Order Actions
 * Version: v0.39.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. Schemas live in
 * `lib/validators/orders.ts`, arithmetic in `lib/orders/pricing.ts`. A
 * `"use server"` file that exports anything else publishes it as an RPC
 * endpoint reachable by anyone on the internet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It asks the right questions before writing — access, entitlement,
 * permission, impersonation — computes the money once, and turns a
 * refusal into a sentence somebody can act on.
 *
 * It does NOT make the guarantees. A frozen confirmed line, a legal
 * status transition, a dispatch that cannot exceed the order, a
 * cancellation that carries a named human — those are triggers in
 * `SQL-FILES/0028_phase39_orders.sql`. This is ONE write path. A
 * back-fill of a year of order history and the public REST API of Phase
 * 41 are the others, and the API is where the malformed input lives.
 *
 * ⭐ AND IT NEVER TAKES AN ORDER NUMBER FROM THE CALLER. `nextOrderNo`
 * derives it inside the same transaction that writes the row. A caller
 * who can choose the number can collide with a document already sitting
 * in a customer's file, and the collision surfaces as two different
 * orders quoting one reference in a dispute.
 *
 * ⚠️ MONEY CROSSES THE BOUNDARY AS A STRING. `JSON.stringify` throws on a
 * bigint, so every amount returned goes through `serializeAmount`.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  salesOrders,
  salesOrderLines,
  salesOrderFulfillments,
  salesOrderFulfillmentLines,
  salesOrderEvents,
} from "@/db/schema/orders";
import { gstRegistrations } from "@/db/schema/gst";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, salesFail, toSalesActionError } from "@/server/sales/guards";
import {
  amendOrderSchema,
  cancelOrderSchema,
  closeOrderSchema,
  confirmOrderSchema,
  createOrderSchema,
  holdOrderSchema,
  markDeliveredSchema,
  orderQuerySchema,
  recordFulfillmentSchema,
  releaseOrderSchema,
  type OrderLineInput,
} from "@/lib/validators/orders";
import { priceLine, summarise, type LinePricing } from "@/lib/orders/pricing";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import { assessOrderCredit, assessApprovalAuthority } from "@/server/credit/position";
import { approveOrderCreditSchema } from "@/lib/validators/credit";
import type { ActionResult } from "@/lib/validators/crm";

const FEATURE_ORDERS = "sales.orders" as const;
const FEATURE_FULFILMENT = "sales.fulfilment" as const;

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/* ================================================================== */
/* NUMBERING                                                           */
/* ================================================================== */

/**
 * ⭐ THE ORDER NUMBER IS DERIVED INSIDE THE TRANSACTION THAT WRITES THE
 * ROW, AND NEVER ACCEPTED FROM A FORM.
 *
 * ⚠️ THE UNIQUE INDEX IS THE ACTUAL GUARANTEE, NOT THIS FUNCTION. Two
 * concurrent creates can both read the same maximum; one of them then
 * fails on `sales_orders_tenant_order_no_unique` and is retried. That is
 * the correct design: a sequence read outside a lock is a hint, and the
 * index is the truth. Making this function "safe" with an advisory lock
 * would serialise every order creation in the workspace to gain nothing
 * the index does not already give.
 *
 * Format: SO-YYYYMM-NNNN. The month is in the number because that is how
 * every accounts department in India files paper, and a number that does
 * not sort into a month is a number somebody re-keys into a spreadsheet.
 */
async function nextOrderNo(tx: Tx, tenantId: string, orderDate: string): Promise<string> {
  const period = orderDate.slice(0, 7).replace("-", "");
  const prefix = `SO-${period}-`;
  const rows = await tx
    .select({ orderNo: salesOrders.orderNo })
    .from(salesOrders)
    .where(
      and(
        eq(salesOrders.tenantId, tenantId),
        sql`${salesOrders.orderNo} LIKE ${prefix + "%"}`,
      ),
    )
    .orderBy(desc(salesOrders.orderNo))
    .limit(1);

  const last = rows[0]?.orderNo;
  const lastSeq = last ? Number.parseInt(last.slice(prefix.length), 10) : 0;
  const next = Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq + 1 : 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

async function nextFulfillmentNo(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx
    .select({ no: salesOrderFulfillments.fulfillmentNo })
    .from(salesOrderFulfillments)
    .where(eq(salesOrderFulfillments.tenantId, tenantId))
    .orderBy(desc(salesOrderFulfillments.createdAt))
    .limit(1);
  const last = rows[0]?.no ?? "DC-0000";
  const lastSeq = Number.parseInt(last.replace(/^\D+/, ""), 10);
  const next = Number.isFinite(lastSeq) ? lastSeq + 1 : 1;
  return `DC-${String(next).padStart(4, "0")}`;
}

/* ================================================================== */
/* PRICING                                                             */
/* ================================================================== */

/**
 * Price every line once, here, and never again.
 *
 * ⚠️ `isInterState` IS DECIDED ONCE FOR THE ORDER, NOT PER LINE. One
 * order is one supply between one pair of GSTINs; a line that split
 * differently from its siblings would be an order that cannot be
 * invoiced as a single document.
 */
function priceAll(lines: OrderLineInput[], isInterState: boolean): LinePricing[] {
  return lines.map((line) =>
    priceLine({
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      taxRateBps: line.taxRateBps,
      cessRateBps: line.cessRateBps,
      isInterState,
    }),
  );
}

function lineValuesFor(
  line: OrderLineInput,
  priced: LinePricing,
): Record<string, unknown> {
  return {
    lineNo: line.lineNo,
    kind: line.kind,
    assetId: line.assetId ?? null,
    sku: line.sku ?? null,
    description: line.description,
    hsnSacCodeId: line.hsnSacCodeId ?? null,
    hsnSacRateId: line.hsnSacRateId ?? null,
    taxRateBps: line.taxRateBps ?? null,
    cessRateBps: line.cessRateBps ?? null,
    quantity: line.quantity,
    uom: line.uom,
    unitPriceMinor: line.unitPriceMinor,
    discountMinor: priced.discountMinor,
    taxableValueMinor: priced.taxableValueMinor,
    cgstMinor: priced.cgstMinor,
    sgstMinor: priced.sgstMinor,
    igstMinor: priced.igstMinor,
    cessMinor: priced.cessMinor,
    lineTotalMinor: priced.lineTotalMinor,
    warehouseCode: line.warehouseCode ?? null,
    requestedDate: line.requestedDate ?? null,
    notes: line.notes ?? null,
  };
}

/* ================================================================== */
/* CREATE                                                              */
/* ================================================================== */

export async function createOrder(
  input: unknown,
): Promise<ActionResult<{ id: string; orderNo: string; totalMinor: string }>> {
  try {
    const data = createOrderSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "orders:create",
      feature: FEATURE_ORDERS,
      permission: "sales.orders.create",
    });

    /**
     * ⭐ THE SPLIT IS DERIVED FROM TWO STATE CODES, NEVER FROM A CHECKBOX.
     *
     * ⚠️ IT IS COMPUTED INSIDE THE TRANSACTION, because it needs OUR
     * registration's state — a fact that lives in the database, not on
     * the form. A boolean posted by the client would let a caller choose
     * their own tax treatment, and the total is identical either way, so
     * nothing on the screen would look wrong.
     *
     * Where the caller has not given a place of supply, the order is
     * created intra-state and `confirmOrder` refuses until one is set.
     * An order confirmed on a guessed split puts the wrong tax on every
     * invoice, e-way bill and return derived from it.
     */
    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        let sellerStateCode: string | null = null;
        if (data.sellerRegistrationId) {
          const [reg] = await tx
            .select({ gstin: gstRegistrations.gstin })
            .from(gstRegistrations)
            .where(
              and(
                eq(gstRegistrations.tenantId, ctx.tenant.id),
                eq(gstRegistrations.id, data.sellerRegistrationId),
              ),
            )
            .limit(1);
          // The first two characters of a GSTIN are the state code. Always.
          sellerStateCode = reg?.gstin ? reg.gstin.slice(0, 2) : null;
        }

        const isInterState =
          data.placeOfSupplyCode !== null &&
          data.placeOfSupplyCode !== undefined &&
          sellerStateCode !== null
            ? data.placeOfSupplyCode !== sellerStateCode
            : false;

        const priced = priceAll(data.lines, isInterState);
        const totals = summarise(priced);

        const orderNo = await nextOrderNo(tx, ctx.tenant.id, data.orderDate);

        const [order] = await tx
          .insert(salesOrders)
          .values({
            tenantId: ctx.tenant.id,
            orderNo,
            customerReference: data.customerReference ?? null,
            status: "draft",
            source: "manual",
            orderDate: data.orderDate,
            promisedDate: data.promisedDate ?? null,
            expectedDispatchDate: data.expectedDispatchDate ?? null,
            companyId: data.companyId ?? null,
            contactId: data.contactId ?? null,
            gstPartyId: data.gstPartyId ?? null,
            sellerRegistrationId: data.sellerRegistrationId ?? null,
            placeOfSupplyCode: data.placeOfSupplyCode ?? null,
            isInterState,
            dealId: data.dealId ?? null,
            projectId: data.projectId ?? null,
            bookingId: data.bookingId ?? null,
            channelPartnerId: data.channelPartnerId ?? null,
            currency: data.currency,
            subtotalMinor: totals.grossMinor,
            discountMinor: totals.discountMinor,
            taxableValueMinor: totals.taxableValueMinor,
            cgstMinor: totals.cgstMinor,
            sgstMinor: totals.sgstMinor,
            igstMinor: totals.igstMinor,
            cessMinor: totals.cessMinor,
            otherChargesMinor: data.otherChargesMinor ?? 0n,
            roundOffMinor: data.roundOffMinor ?? 0n,
            totalMinor:
              totals.lineTotalMinor +
              (data.otherChargesMinor ?? 0n) +
              (data.roundOffMinor ?? 0n),
            paymentTermsDays: data.paymentTermsDays ?? null,
            paymentTermsNote: data.paymentTermsNote ?? null,
            incoterm: data.incoterm ?? null,
            shippingName: data.shippingName ?? null,
            shippingLine1: data.shippingLine1 ?? null,
            shippingLine2: data.shippingLine2 ?? null,
            shippingCity: data.shippingCity ?? null,
            shippingState: data.shippingState ?? null,
            shippingPostalCode: data.shippingPostalCode ?? null,
            shippingCountry: data.shippingCountry,
            shippingPhone: data.shippingPhone ?? null,
            ownerUserId: data.ownerUserId ?? ctx.user.id,
            notes: data.notes ?? null,
            customerNotes: data.customerNotes ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: salesOrders.id, orderNo: salesOrders.orderNo });
        if (!order) throw new Error("The order could not be written.");

        await tx.insert(salesOrderLines).values(
          data.lines.map((line, i) => ({
            tenantId: ctx.tenant.id,
            orderId: order.id,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
            ...lineValuesFor(line, priced[i]!),
          })) as never,
        );

        await tx.insert(salesOrderEvents).values({
          tenantId: ctx.tenant.id,
          orderId: order.id,
          eventType: "created",
          toStatus: "draft",
          revision: 0,
          summary: `Order ${order.orderNo} drafted with ${data.lines.length} line${
            data.lines.length === 1 ? "" : "s"
          }.`,
          actorUserId: ctx.user.id,
          impersonationId: ctx.impersonationId,
        });

        return { ...order, totalMinor: serializeAmount(totals.lineTotalMinor) };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "sales_order",
      resourceId: outcome.id,
      newValue: { orderNo: outcome.orderNo, lines: data.lines.length },
      metadata: { totalMinor: outcome.totalMinor },
    });

    revalidatePath("/orders");
    return {
      ok: true,
      data: {
        id: outcome.id,
        orderNo: outcome.orderNo,
        totalMinor: outcome.totalMinor,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "createOrder");
  }
}

/* ================================================================== */
/* CONFIRM — the moment the lines freeze                               */
/* ================================================================== */

export async function confirmOrder(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string; creditMessage: string | null }>> {
  try {
    const data = confirmOrderSchema.parse(input);
    let outcome: { routeToApproval: boolean; creditMessage: string | null } = {
      routeToApproval: false,
      creditMessage: null,
    };
    const ctx = await guardSalesWrite({
      operation: "orders:confirm",
      feature: FEATURE_ORDERS,
      permission: "sales.orders.confirm",
      resource: { type: "sales_order", id: data.id },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [order] = await tx
          .select()
          .from(salesOrders)
          .where(and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, data.id)))
          .limit(1);

        if (!order) throw new Error("That order no longer exists.");

        /**
         * ⚠️ REFUSED RATHER THAN GUESSED. Confirming without a place of
         * supply means committing to a tax split nobody decided, and
         * every invoice, e-way bill and return derived from this order
         * inherits it. The fix takes five seconds now and a revised
         * return later.
         */
        if (!order.placeOfSupplyCode) {
          throw new Error(
            "Set the place of supply before confirming. It decides whether this order is CGST + SGST or IGST — the total is the same either way, which is exactly why a wrong split is not noticed until a return is filed.",
          );
        }

        /**
         * ══════════════════════════════════════════════════════════════
         * 🔴 THE CREDIT GATE — v0.89.0
         * ══════════════════════════════════════════════════════════════
         * ⚠️ IT RUNS INSIDE THIS TRANSACTION, NOT BEFORE IT.
         *
         * Reading a customer's exposure on one connection and writing the
         * confirmation on another is a race with money in it: two reps
         * confirm two orders for one customer in the same second, each
         * reads an exposure that excludes the other, and both clear a
         * limit that neither should. Sharing `tx` puts the read behind
         * the same lock as the write.
         *
         * ⚠️ AND IT RETURNS `approval_required`, NEVER "denied". An order
         * over the limit is not refused — it goes to `pending_approval`,
         * where somebody holding `sales.orders.approve_credit` releases
         * it. A credit system that says no gets switched off in week one.
         */
        let creditMessage: string | null = null;
        let needsCreditApproval = false;

        if (order.companyId) {
          const decision = await assessOrderCredit({
            tx,
            tenantId: ctx.tenant.id,
            companyId: order.companyId,
            orderId: order.id,
            orderTotalMinor: toBigIntAmount(order.totalMinor),
          });
          needsCreditApproval = decision.outcome === "approval_required";
          creditMessage = decision.message;
        }

        /**
         * ⚠️ AN ORDER WITH NO CUSTOMER RECORD IS NOT CREDIT-CHECKED, AND
         * THAT IS NOT A HOLE — `companyId` is nullable because a cash
         * counter sale has no company row. There is no account to run up,
         * because there is no account.
         */

        /**
         * ══════════════════════════════════════════════════════════════
         * 🔴 AND THE FIX THAT MAKES THE GATE MEAN ANYTHING
         * ══════════════════════════════════════════════════════════════
         * Until v0.89.0 this block read:
         *
         *   approvedBy: order.requiresApproval ? ctx.user.id : ...
         *   approvedAt: order.requiresApproval ? new Date()   : ...
         *
         * The person pressing confirm was written as the person who
         * approved it. `requiresApproval` therefore enforced nothing: the
         * same click that raised the flag satisfied it. Worse, the audit
         * trail then recorded an approval naming a real person at a real
         * time — every fact true, the sentence they form false.
         *
         * ⚠️ NOTHING IN THIS ACTION MAY EVER WRITE `approvedBy` AGAIN.
         * Approval is `approveOrderCredit`, which requires a different
         * permission and therefore, in any sane role setup, a different
         * person. If a future change needs to confirm-and-approve in one
         * step, that step must check `sales.orders.approve_credit`
         * explicitly — not infer it from having reached this line.
         */
        const routeToApproval = needsCreditApproval || order.requiresApproval;

        await tx
          .update(salesOrders)
          .set({
            status: routeToApproval ? "pending_approval" : "confirmed",
            confirmedAt: routeToApproval ? null : new Date(),
            confirmedBy: routeToApproval ? null : ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .where(and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, data.id)));

        await tx.insert(salesOrderEvents).values({
          tenantId: ctx.tenant.id,
          orderId: data.id,
          eventType: routeToApproval ? "held" : "confirmed",
          fromStatus: order.status,
          toStatus: routeToApproval ? "pending_approval" : "confirmed",
          revision: order.revision,
          summary: routeToApproval
            ? `Order ${order.orderNo} needs approval before it can be confirmed. ${creditMessage ?? "This order is marked as requiring approval."}`
            : `Order ${order.orderNo} confirmed. Prices and quantities are now fixed; any change from here is a recorded amendment.`,
          detail: {
            ...(data.approvalNote ? { approvalNote: data.approvalNote } : {}),
            ...(creditMessage ? { credit: creditMessage } : {}),
          },
          actorUserId: ctx.user.id,
          impersonationId: ctx.impersonationId,
        });

        outcome = { routeToApproval, creditMessage };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "sales_order",
      resourceId: data.id,
      newValue: {
        status: outcome.routeToApproval ? "pending_approval" : "confirmed",
        credit: outcome.creditMessage,
      },
      severity: "warning",
    });

    revalidatePath("/orders");
    revalidatePath(`/orders/${data.id}`);
    return {
      ok: true,
      data: {
        id: data.id,
        status: outcome.routeToApproval ? "pending_approval" : "confirmed",
        creditMessage: outcome.creditMessage,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "confirmOrder");
  }
}

/* ================================================================== */
/* ⭐ APPROVE — the second person                                       */
/* ================================================================== */

/**
 * Release an order that the credit check, or an explicit
 * `requiresApproval` flag, routed to a human.
 *
 * ⚠️ THE APPROVER IS THE SESSION AND CAN NEVER BE AN ARGUMENT. A field
 * naming the approver is a field an attacker fills in with somebody
 * senior, and the audit trail then carries a signature that person never
 * gave. `approveOrderCreditSchema` has no such field, and this is the
 * comment that stops one being added.
 *
 * ⚠️ AND THE APPROVER'S ROLE IS CHECKED AGAINST ITS APPROVAL LIMIT, not
 * just against the permission. `sales.orders.approve_credit` says "this
 * role may approve credit overrides at all"; the limit says "up to how
 * much". Without the second question a junior with the permission
 * approves a crore, which is exactly the shape of the loss this whole
 * phase exists to prevent.
 */
export async function approveOrderCredit(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = approveOrderCreditSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "orders:approve_credit",
      feature: FEATURE_ORDERS,
      permission: "sales.orders.approve_credit",
      resource: { type: "sales_order", id: data.orderId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [order] = await tx
          .select()
          .from(salesOrders)
          .where(
            and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, data.orderId)),
          )
          .limit(1);

        if (!order) throw new Error("That order no longer exists.");

        if (order.status !== "pending_approval") {
          throw new Error(
            `Order ${order.orderNo} is not waiting for approval — it is ${order.status.replace(/_/g, " ")}. Nothing has been changed.`,
          );
        }

        /**
         * ⚠️ SELF-APPROVAL IS REFUSED HERE, EXPLICITLY, EVEN THOUGH THE
         * PERMISSIONS USUALLY MAKE IT IMPOSSIBLE.
         *
         * "Usually" is not a control. A workspace where one person holds
         * both keys is a legitimate configuration — a two-person company
         * — and the honest thing is to refuse and say so, rather than to
         * record a second signature that is the first signature.
         */
        if (order.createdBy && order.createdBy === ctx.user.id) {
          throw new Error(
            `You raised order ${order.orderNo}, so you cannot also approve it. Somebody else with approval rights has to release it — that separation is the whole point of the credit limit.`,
          );
        }

        const authority = await assessApprovalAuthority({
          tx,
          tenantId: ctx.tenant.id,
          role: ctx.role,
          scope: "sales_order",
          valueMinor: toBigIntAmount(order.totalMinor),
        });

        if (!authority.allowed) throw new Error(authority.message);

        await tx
          .update(salesOrders)
          .set({
            status: "confirmed",
            approvedBy: ctx.user.id,
            approvedAt: new Date(),
            confirmedAt: new Date(),
            confirmedBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .where(
            and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, data.orderId)),
          );

        await tx.insert(salesOrderEvents).values({
          tenantId: ctx.tenant.id,
          orderId: data.orderId,
          eventType: "confirmed",
          fromStatus: "pending_approval",
          toStatus: "confirmed",
          revision: order.revision,
          summary: `Order ${order.orderNo} approved over the customer's credit limit and confirmed. ${data.note}`,
          detail: { approvalNote: data.note, approverRole: ctx.role },
          actorUserId: ctx.user.id,
          impersonationId: ctx.impersonationId,
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "sales_order",
      resourceId: data.orderId,
      newValue: { status: "confirmed", creditApproval: data.note },
      reason: data.note,
      /**
       * ⚠️ `critical`. Somebody has just extended credit past a ceiling
       * another person set. If a workspace reviews one class of event a
       * month, this is the class.
       */
      severity: "critical",
    });

    revalidatePath("/orders");
    revalidatePath(`/orders/${data.orderId}`);
    return { ok: true, data: { id: data.orderId } };
  } catch (err) {
    return toSalesActionError(err, "approveOrderCredit");
  }
}

/* ================================================================== */
/* AMEND — the only legal way to change a confirmed order              */
/* ================================================================== */

/**
 * ⭐ AN AMENDMENT IS A NEW REVISION, NOT AN EDIT.
 *
 * ⚠️ THE `app.order_amendment_id` SETTING IS WHAT UNLOCKS THE FREEZE
 * TRIGGER, AND IT IS SET FOR THE DURATION OF ONE TRANSACTION ONLY.
 * `set_config(..., true)` is transaction-local — it disappears on commit
 * or rollback. Setting it session-wide would leave every subsequent
 * query on that pooled connection able to rewrite confirmed orders, which
 * is the freeze switched off for everybody by one caller.
 */
export async function amendOrder(
  input: unknown,
): Promise<ActionResult<{ id: string; revision: number }>> {
  try {
    const data = amendOrderSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "orders:amend",
      feature: FEATURE_ORDERS,
      permission: "sales.orders.amend",
      resource: { type: "sales_order", id: data.id },
      impersonationOperation: "amend:sales_order",
    });

    const revision = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [order] = await tx
          .select()
          .from(salesOrders)
          .where(and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, data.id)))
          .limit(1);

        if (!order) throw new Error("That order no longer exists.");
        if (order.status === "cancelled" || order.status === "closed") {
          throw new Error(
            `Order ${order.orderNo} is ${order.status}. A finished order is not amended — raise a new order for the additional supply, so both documents stay true to what actually happened.`,
          );
        }

        const nextRevision = order.revision + 1;

        // Transaction-local. See the note above.
        await tx.execute(
          sql`SELECT set_config('app.order_amendment_id', ${data.id}, true)`,
        );

        const priced = priceAll(data.lines, order.isInterState ?? false);
        const totals = summarise(priced);

        /**
         * ⚠️ LINES ARE REPLACED WHOLESALE, INSIDE ONE TRANSACTION. A
         * differential update — patch these, insert those, delete the
         * rest — is three chances to leave the order half-amended if any
         * one of them fails a constraint. The whole set goes or none
         * does.
         */
        await tx
          .delete(salesOrderLines)
          .where(
            and(
              eq(salesOrderLines.tenantId, ctx.tenant.id),
              eq(salesOrderLines.orderId, data.id),
            ),
          );

        await tx.insert(salesOrderLines).values(
          data.lines.map((line, i) => ({
            tenantId: ctx.tenant.id,
            orderId: data.id,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
            ...lineValuesFor(line, priced[i]!),
          })) as never,
        );

        await tx
          .update(salesOrders)
          .set({ revision: nextRevision, updatedBy: ctx.user.id })
          .where(and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, data.id)));

        await tx.insert(salesOrderEvents).values({
          tenantId: ctx.tenant.id,
          orderId: data.id,
          eventType: "amended",
          fromStatus: order.status,
          toStatus: order.status,
          revision: nextRevision,
          summary: `Order ${order.orderNo} amended to revision ${nextRevision}. ${data.reason}`,
          detail: {
            previousTotalMinor: serializeAmount(order.totalMinor),
            newTotalMinor: serializeAmount(totals.lineTotalMinor),
            lineCount: data.lines.length,
          },
          actorUserId: ctx.user.id,
          impersonationId: ctx.impersonationId,
        });

        return nextRevision;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "sales_order",
      resourceId: data.id,
      newValue: { revision },
      reason: data.reason,
      severity: "warning",
    });

    revalidatePath("/orders");
    revalidatePath(`/orders/${data.id}`);
    return { ok: true, data: { id: data.id, revision } };
  } catch (err) {
    return toSalesActionError(err, "amendOrder");
  }
}

/* ================================================================== */
/* LIFECYCLE                                                           */
/* ================================================================== */

async function transition(args: {
  id: string;
  operation: string;
  permission: string;
  eventType: string;
  to: "cancelled" | "on_hold" | "confirmed" | "closed";
  summary: (orderNo: string) => string;
  patch: (userId: string) => Record<string, unknown>;
  reason?: string;
}): Promise<ActionResult<{ id: string }>> {
  const ctx = await guardSalesWrite({
    operation: args.operation,
    feature: FEATURE_ORDERS,
    permission: args.permission,
    resource: { type: "sales_order", id: args.id },
    impersonationOperation: args.to === "cancelled" ? "delete:sales_order" : undefined,
  });

  await withTenant(
    ctx.tenant.id,
    async (tx) => {
      const [order] = await tx
        .select({
          orderNo: salesOrders.orderNo,
          status: salesOrders.status,
          revision: salesOrders.revision,
        })
        .from(salesOrders)
        .where(and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, args.id)))
        .limit(1);

      if (!order) throw new Error("That order no longer exists.");

      await tx
        .update(salesOrders)
        .set({ status: args.to, updatedBy: ctx.user.id, ...args.patch(ctx.user.id) })
        .where(and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, args.id)));

      await tx.insert(salesOrderEvents).values({
        tenantId: ctx.tenant.id,
        orderId: args.id,
        eventType: args.eventType,
        fromStatus: order.status,
        toStatus: args.to,
        revision: order.revision,
        summary: args.summary(order.orderNo),
        actorUserId: ctx.user.id,
        impersonationId: ctx.impersonationId,
      });
    },
    { impersonationId: ctx.impersonationId },
  );

  await writeAudit(ctx, {
    action: "update",
    resourceType: "sales_order",
    resourceId: args.id,
    newValue: { status: args.to },
    reason: args.reason,
    severity: args.to === "cancelled" ? "critical" : "notice",
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${args.id}`);
  return { ok: true, data: { id: args.id } };
}

export async function cancelOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = cancelOrderSchema.parse(input);
    return await transition({
      id: data.id,
      operation: "orders:cancel",
      permission: "sales.orders.cancel",
      eventType: "cancelled",
      to: "cancelled",
      reason: data.reason,
      summary: (no) => `Order ${no} cancelled. ${data.reason}`,
      patch: (userId) => ({
        cancelledAt: new Date(),
        cancelledBy: userId,
        cancellationReason: data.reason,
      }),
    });
  } catch (err) {
    return toSalesActionError(err, "cancelOrder");
  }
}

export async function holdOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = holdOrderSchema.parse(input);
    return await transition({
      id: data.id,
      operation: "orders:hold",
      permission: "sales.orders.update",
      eventType: "held",
      to: "on_hold",
      reason: data.reason,
      summary: (no) => `Order ${no} placed on hold. ${data.reason}`,
      patch: () => ({ holdReason: data.reason }),
    });
  } catch (err) {
    return toSalesActionError(err, "holdOrder");
  }
}

export async function releaseOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = releaseOrderSchema.parse(input);
    return await transition({
      id: data.id,
      operation: "orders:release",
      permission: "sales.orders.update",
      eventType: "released",
      to: "confirmed",
      summary: (no) => `Order ${no} released from hold.`,
      patch: () => ({ holdReason: null }),
    });
  } catch (err) {
    return toSalesActionError(err, "releaseOrder");
  }
}

export async function closeOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = closeOrderSchema.parse(input);
    return await transition({
      id: data.id,
      operation: "orders:close",
      permission: "sales.orders.update",
      eventType: "closed",
      to: "closed",
      summary: (no) =>
        `Order ${no} closed.${data.note ? ` ${data.note}` : ""} Nothing further will be dispatched against it.`,
      patch: () => ({ closedAt: new Date() }),
    });
  } catch (err) {
    return toSalesActionError(err, "closeOrder");
  }
}

/* ================================================================== */
/* FULFILMENT                                                          */
/* ================================================================== */

export async function recordFulfillment(
  input: unknown,
): Promise<ActionResult<{ id: string; fulfillmentNo: string }>> {
  try {
    const data = recordFulfillmentSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "orders:dispatch",
      feature: FEATURE_FULFILMENT,
      permission: "sales.orders.dispatch",
      resource: { type: "sales_order", id: data.orderId },
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const fulfillmentNo = await nextFulfillmentNo(tx, ctx.tenant.id);

        const [fulfilment] = await tx
          .insert(salesOrderFulfillments)
          .values({
            tenantId: ctx.tenant.id,
            orderId: data.orderId,
            fulfillmentNo,
            status: data.dispatchedAt ? "dispatched" : "planned",
            dispatchedAt: data.dispatchedAt ? new Date(data.dispatchedAt) : null,
            carrierName: data.carrierName ?? null,
            trackingNumber: data.trackingNumber ?? null,
            vehicleNumber: data.vehicleNumber ?? null,
            driverName: data.driverName ?? null,
            driverPhone: data.driverPhone ?? null,
            ewayBillNo: data.ewayBillNo ?? null,
            ewayBillDate: data.ewayBillDate ?? null,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({
            id: salesOrderFulfillments.id,
            fulfillmentNo: salesOrderFulfillments.fulfillmentNo,
          });

        if (!fulfilment) throw new Error("The delivery challan could not be written.");

        /**
         * ⚠️ THE OVER-DISPATCH CHECK IS NOT DONE HERE. The trigger in
         * SQL 0028 §5 locks the line, compares against what is already
         * out, and raises a message naming the line and the outstanding
         * quantity. Checking it here as well would mean two answers to
         * one question, and under concurrency the one in TypeScript is
         * the one that is wrong.
         */
        await tx.insert(salesOrderFulfillmentLines).values(
          data.lines.map((line) => ({
            tenantId: ctx.tenant.id,
            fulfillmentId: fulfilment.id,
            orderLineId: line.orderLineId,
            quantity: line.quantity,
            batchNo: line.batchNo ?? null,
            serialNumbers: line.serialNumbers ?? [],
            createdBy: ctx.user.id,
          })) as never,
        );

        await tx.insert(salesOrderEvents).values({
          tenantId: ctx.tenant.id,
          orderId: data.orderId,
          eventType: "dispatched",
          summary: `Delivery challan ${fulfilment.fulfillmentNo} raised for ${data.lines.length} line${
            data.lines.length === 1 ? "" : "s"
          }${data.vehicleNumber ? ` on vehicle ${data.vehicleNumber}` : ""}.`,
          detail: {
            ewayBillNo: data.ewayBillNo ?? null,
            carrier: data.carrierName ?? null,
          },
          actorUserId: ctx.user.id,
          impersonationId: ctx.impersonationId,
        });

        return fulfilment;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "sales_order_fulfillment",
      resourceId: result.id,
      newValue: { fulfillmentNo: result.fulfillmentNo, lines: data.lines.length },
      metadata: { orderId: data.orderId },
    });

    revalidatePath("/orders");
    revalidatePath(`/orders/${data.orderId}`);
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recordFulfillment");
  }
}

export async function markDelivered(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = markDeliveredSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "orders:deliver",
      feature: FEATURE_FULFILMENT,
      permission: "sales.orders.dispatch",
      resource: { type: "sales_order_fulfillment", id: data.fulfillmentId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(salesOrderFulfillments)
          .set({
            status: "delivered",
            deliveredAt: data.deliveredAt ? new Date(data.deliveredAt) : new Date(),
            receivedBy: data.receivedBy,
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(salesOrderFulfillments.tenantId, ctx.tenant.id),
              eq(salesOrderFulfillments.id, data.fulfillmentId),
            ),
          );
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "sales_order_fulfillment",
      resourceId: data.fulfillmentId,
      newValue: { status: "delivered", receivedBy: data.receivedBy },
    });

    revalidatePath("/orders");
    return { ok: true, data: { id: data.fulfillmentId } };
  } catch (err) {
    return toSalesActionError(err, "markDelivered");
  }
}

/* ================================================================== */
/* READS                                                               */
/* ================================================================== */

export type OrderListRow = {
  id: string;
  orderNo: string;
  status: string;
  revision: number;
  orderDate: string;
  promisedDate: string | null;
  customerReference: string | null;
  companyId: string | null;
  totalMinor: string;
  fulfilledValueMinor: string;
  invoicedValueMinor: string;
  currency: string;
  isInterState: boolean | null;
};

export async function listOrders(
  input?: unknown,
): Promise<ActionResult<{ rows: OrderListRow[] }>> {
  try {
    const query = orderQuerySchema.parse(input ?? {});
    const ctx = await requirePermission("sales.orders.read");

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const conditions = [eq(salesOrders.tenantId, ctx.tenant.id)];
        if (query.status) conditions.push(eq(salesOrders.status, query.status));
        if (query.companyId) conditions.push(eq(salesOrders.companyId, query.companyId));
        if (query.projectId) conditions.push(eq(salesOrders.projectId, query.projectId));

        return tx
          .select({
            id: salesOrders.id,
            orderNo: salesOrders.orderNo,
            status: salesOrders.status,
            revision: salesOrders.revision,
            orderDate: salesOrders.orderDate,
            promisedDate: salesOrders.promisedDate,
            customerReference: salesOrders.customerReference,
            companyId: salesOrders.companyId,
            totalMinor: salesOrders.totalMinor,
            fulfilledValueMinor: salesOrders.fulfilledValueMinor,
            invoicedValueMinor: salesOrders.invoicedValueMinor,
            currency: salesOrders.currency,
            isInterState: salesOrders.isInterState,
          })
          .from(salesOrders)
          .where(and(...conditions))
          .orderBy(desc(salesOrders.orderDate), desc(salesOrders.createdAt))
          .limit(query.limit);
      },
      { impersonationId: ctx.impersonationId },
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          ...r,
          totalMinor: serializeAmount(r.totalMinor),
          fulfilledValueMinor: serializeAmount(r.fulfilledValueMinor),
          invoicedValueMinor: serializeAmount(r.invoicedValueMinor),
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "listOrders");
  }
}

export type OrderLineRow = {
  id: string;
  lineNo: number;
  description: string;
  sku: string | null;
  uom: string;
  quantity: string;
  qtyFulfilled: string;
  qtyInvoiced: string;
  qtyCancelled: string;
  unitPriceMinor: string;
  lineTotalMinor: string;
  taxRateBps: number | null;
  warehouseCode: string | null;
};

export async function getOrder(orderId: string): Promise<
  ActionResult<{
    order: OrderListRow & {
      notes: string | null;
      customerNotes: string | null;
      cancellationReason: string | null;
      holdReason: string | null;
      placeOfSupplyCode: string | null;
      taxableValueMinor: string;
      cgstMinor: string;
      sgstMinor: string;
      igstMinor: string;
      cessMinor: string;
    };
    lines: OrderLineRow[];
    events: Array<{
      id: string;
      eventType: string;
      summary: string;
      revision: number | null;
      occurredAt: string;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission("sales.orders.read", {
      type: "sales_order",
      id: orderId,
    });

    const payload = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [order] = await tx
          .select()
          .from(salesOrders)
          .where(and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, orderId)))
          .limit(1);

        if (!order) return null;

        const lines = await tx
          .select()
          .from(salesOrderLines)
          .where(
            and(
              eq(salesOrderLines.tenantId, ctx.tenant.id),
              eq(salesOrderLines.orderId, orderId),
            ),
          )
          .orderBy(salesOrderLines.lineNo);

        const events = await tx
          .select({
            id: salesOrderEvents.id,
            eventType: salesOrderEvents.eventType,
            summary: salesOrderEvents.summary,
            revision: salesOrderEvents.revision,
            occurredAt: salesOrderEvents.occurredAt,
          })
          .from(salesOrderEvents)
          .where(
            and(
              eq(salesOrderEvents.tenantId, ctx.tenant.id),
              eq(salesOrderEvents.orderId, orderId),
            ),
          )
          .orderBy(desc(salesOrderEvents.occurredAt))
          .limit(50);

        return { order, lines, events };
      },
      { impersonationId: ctx.impersonationId },
    );

    if (!payload) return salesFail("That order no longer exists.");

    const { order, lines, events } = payload;

    return {
      ok: true,
      data: {
        order: {
          id: order.id,
          orderNo: order.orderNo,
          status: order.status,
          revision: order.revision,
          orderDate: order.orderDate,
          promisedDate: order.promisedDate,
          customerReference: order.customerReference,
          companyId: order.companyId,
          currency: order.currency,
          isInterState: order.isInterState,
          notes: order.notes,
          customerNotes: order.customerNotes,
          cancellationReason: order.cancellationReason,
          holdReason: order.holdReason,
          placeOfSupplyCode: order.placeOfSupplyCode,
          totalMinor: serializeAmount(order.totalMinor),
          fulfilledValueMinor: serializeAmount(order.fulfilledValueMinor),
          invoicedValueMinor: serializeAmount(order.invoicedValueMinor),
          taxableValueMinor: serializeAmount(order.taxableValueMinor),
          cgstMinor: serializeAmount(order.cgstMinor),
          sgstMinor: serializeAmount(order.sgstMinor),
          igstMinor: serializeAmount(order.igstMinor),
          cessMinor: serializeAmount(order.cessMinor),
        },
        lines: lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          description: l.description,
          sku: l.sku,
          uom: l.uom,
          quantity: l.quantity,
          qtyFulfilled: l.qtyFulfilled,
          qtyInvoiced: l.qtyInvoiced,
          qtyCancelled: l.qtyCancelled,
          unitPriceMinor: serializeAmount(l.unitPriceMinor),
          lineTotalMinor: serializeAmount(l.lineTotalMinor),
          taxRateBps: l.taxRateBps,
          warehouseCode: l.warehouseCode,
        })),
        events: events.map((e) => ({
          id: e.id,
          eventType: e.eventType,
          summary: e.summary,
          revision: e.revision,
          occurredAt: e.occurredAt.toISOString(),
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getOrder");
  }
}
