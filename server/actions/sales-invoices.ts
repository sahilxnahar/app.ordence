"use server";

/**
 * Ordence — ⭐ Sales Invoice Actions
 * Version: v0.90.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION, AND NO EXPORT TAKES A TENANT.
 * Schemas live in `lib/validators/sales-invoices.ts`, arithmetic in
 * `lib/invoicing/build.ts` and `lib/gst/tax.ts`, database reads in
 * `server/invoicing/documents.ts` — which is `import "server-only"`
 * precisely because its functions DO take a tenant id.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ RAISING AND ISSUING ARE TWO ACTIONS, AND THAT IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * A draft is a working paper: delete it and nobody outside the workspace
 * ever knew. Issuing is irreversible — under Rule 53 the only lawful
 * correction to an issued tax invoice is a credit note, and the customer
 * is already holding their copy.
 *
 * One "create invoice" button would make that irreversible step the
 * default outcome of a mis-click. Two actions, two permissions.
 */

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  salesInvoices,
  salesInvoiceLines,
  customerReceipts,
  customerReceiptAllocations,
} from "@/db/schema/sales-invoices";
import { companies } from "@/db/schema/crm";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError } from "@/server/sales/guards";
import {
  captureCustomerIdentity,
  loadOrderForInvoicing,
  nextInvoiceNumber,
} from "@/server/invoicing/documents";
import { buildInvoice } from "@/lib/invoicing/build";
import {
  allocateReceiptSchema,
  bounceReceiptSchema,
  cancelInvoiceSchema,
  issueInvoiceSchema,
  raiseInvoiceFromOrderSchema,
  recordReceiptSchema,
} from "@/lib/validators/sales-invoices";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const FEATURE_ORDERS = "sales.orders" as const;

/** Statuses from which an order may be invoiced. */
const INVOICEABLE = ["confirmed", "partially_fulfilled", "fulfilled", "closed"];

/* ================================================================== */
/* RAISE — a draft, from a confirmed order                             */
/* ================================================================== */

export async function raiseInvoiceFromOrder(
  input: unknown,
): Promise<ActionResult<{ id: string; totalMinor: string }>> {
  try {
    const data = raiseInvoiceFromOrderSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "invoices:create",
      feature: FEATURE_ORDERS,
      permission: "sales.invoices.create",
      resource: { type: "sales_order", id: data.orderId },
    });

    const invoiceId = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const loaded = await loadOrderForInvoicing(tx, ctx.tenant.id, data.orderId);
        if (!loaded) throw new Error("That order no longer exists.");
        const { order, lines } = loaded;

        /**
         * ⚠️ A DRAFT ORDER MAY NOT BE INVOICED. Its lines are still
         * editable, so the invoice would freeze figures that can still
         * move underneath it — and the customer would hold a document
         * quoting a price nobody committed to.
         */
        if (!INVOICEABLE.includes(order.status)) {
          throw new Error(
            `Order ${order.orderNo} is ${order.status.replace(/_/g, " ")}. Only a confirmed order can be invoiced — its prices and quantities have to be fixed before a tax invoice can quote them.`,
          );
        }

        if (!order.companyId) {
          throw new Error(
            `Order ${order.orderNo} has no customer on it. A tax invoice has to name who it is issued to (Rule 46(d)).`,
          );
        }

        if (!order.placeOfSupplyCode) {
          throw new Error(
            "Set the place of supply on the order before invoicing. It decides whether this is CGST + SGST or IGST — the total is the same either way, which is exactly why a wrong split is not noticed until a return is filed.",
          );
        }

        /**
         * ⭐ THE TAX KIND COMES FROM THE ORDER'S OWN DETERMINATION, made
         * when the order was confirmed and stored since. Re-deriving it
         * here from today's addresses would silently re-split a
         * historical document.
         */
        /**
         * ⚠️ `sales_orders` HAS NO `is_union_territory` COLUMN, so an
         * intra-UT supply is billed as CGST + SGST here. That is the
         * right split in the wrong Act — an intra-UT supply is CGST +
         * UTGST, same rates and same total, but a different box in the
         * return.
         *
         * Deliberately NOT fixed by guessing from the state code: the
         * order made a determination and stored it, and inventing a
         * second one here is exactly the divergence this codebase keeps
         * refusing. The column belongs on `sales_orders`, added with the
         * order-side determination that fills it.
         */
        const taxKind = order.isInterState ? ("igst" as const) : ("cgst_sgst" as const);

        const built = buildInvoice({
          orderLines: lines,
          selection: data.lines,
          taxKind,
          placeOfSupplyCode: order.placeOfSupplyCode,
          roundToRupee: data.roundToRupee ?? false,
        });

        const identity = await captureCustomerIdentity(tx, ctx.tenant.id, order.gstPartyId);
        const [company] = await tx
          .select({ name: companies.name })
          .from(companies)
          .where(
            and(eq(companies.tenantId, ctx.tenant.id), eq(companies.id, order.companyId)),
          )
          .limit(1);

        /**
         * ⚠️ A DRAFT CARRIES A PLACEHOLDER NUMBER, NOT A REAL ONE.
         *
         * Rule 46(b) requires the series to be CONSECUTIVE. Numbering at
         * draft time means every abandoned draft leaves a hole, and a
         * gap in the series is a question an auditor is entitled to ask
         * — one nobody will be able to answer three years later.
         *
         * The real number is assigned by `issueInvoice`, inside the
         * transaction that issues.
         */
        const placeholder = `DRAFT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

        const [created] = await tx
          .insert(salesInvoices)
          .values({
            tenantId: ctx.tenant.id,
            invoiceNumber: placeholder,
            financialYear: data.invoiceDate.slice(0, 4),
            status: "draft",
            companyId: order.companyId,
            contactId: order.contactId,
            orderId: order.id,
            invoiceDate: data.invoiceDate,
            dueDate: data.dueDate ?? null,
            customerLegalName: identity.legalName ?? company?.name ?? null,
            customerGstin: identity.gstin,
            supplierRegistrationId: order.sellerRegistrationId,
            gstPartyId: order.gstPartyId,
            placeOfSupplyCode: order.placeOfSupplyCode,
            isInterState: order.isInterState ?? false,
            isUnionTerritory: false,
            supplyType: "goods",
            subtotalMinor: built.tax.grossMinor,
            discountMinor: built.tax.discountMinor,
            taxableValueMinor: built.tax.taxableMinor,
            cgstMinor: built.tax.cgstMinor,
            sgstMinor: built.tax.sgstMinor,
            igstMinor: built.tax.igstMinor,
            cessMinor: built.tax.cessMinor,
            roundOffMinor: built.tax.roundOffMinor,
            totalMinor: built.tax.amountPayableMinor,
            notes: data.notes ?? null,
            terms: data.terms ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: salesInvoices.id });

        if (!created) throw new Error("The invoice could not be created.");

        const computedByKey = new Map(built.tax.lines.map((l) => [l.key, l]));

        await tx.insert(salesInvoiceLines).values(
          built.lines.map((l, index) => {
            const computed = computedByKey.get(l.orderLineId);
            return {
              tenantId: ctx.tenant.id,
              invoiceId: created.id,
              lineNo: index + 1,
              orderLineId: l.orderLineId,
              assetId: l.assetId,
              sku: l.sku,
              description: l.description,
              hsnSacCodeId: l.hsnSacCodeId,
              hsnSacRateId: l.hsnSacRateId,
              hsnSacCode: l.hsnSacCode,
              taxRateBps: l.taxRateBps,
              cessRateBps: l.cessRateBps,
              quantity: l.quantity,
              uom: l.uom,
              unitPriceMinor: l.unitPriceMinor,
              discountMinor: l.discountMinor,
              taxableValueMinor: computed?.taxableMinor ?? 0n,
              cgstMinor: computed?.cgstMinor ?? 0n,
              sgstMinor: computed?.sgstMinor ?? 0n,
              igstMinor: computed?.igstMinor ?? 0n,
              cessMinor: computed?.cessMinor ?? 0n,
              lineTotalMinor:
                (computed?.taxableMinor ?? 0n) +
                (computed?.cgstMinor ?? 0n) +
                (computed?.sgstMinor ?? 0n) +
                (computed?.igstMinor ?? 0n) +
                (computed?.cessMinor ?? 0n),
            };
          }),
        );

        await writeAudit(ctx, {
          action: "create",
          resourceType: "sales_invoice",
          resourceId: created.id,
          newValue: {
            order: order.orderNo,
            status: "draft",
            totalMinor: serializeAmount(built.tax.amountPayableMinor),
          },
          severity: "notice",
        });

        return created.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/invoices");
    revalidatePath(`/orders/${data.orderId}`);
    return { ok: true, data: { id: invoiceId, totalMinor: "0" } };
  } catch (err) {
    return toSalesActionError(err, "raiseInvoiceFromOrder");
  }
}

/* ================================================================== */
/* ⭐ ISSUE — the irreversible step                                     */
/* ================================================================== */

/**
 * ⚠️ THIS IS WHERE THE NUMBER IS ASSIGNED, AND WHERE THE DOCUMENT
 *    BECOMES A LEGAL ONE.
 *
 * After this returns, the freeze trigger in `0049_sales_invoices.sql`
 * refuses every edit to the figures, and §3 writes the quantities back
 * onto the order — which is what finally moves
 * `sales_orders.received_value_minor` and brings the 0048 credit limits
 * to life.
 */
export async function issueInvoice(
  input: unknown,
): Promise<ActionResult<{ id: string; invoiceNumber: string }>> {
  try {
    const data = issueInvoiceSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "invoices:issue",
      feature: FEATURE_ORDERS,
      permission: "sales.invoices.issue",
      resource: { type: "sales_invoice", id: data.invoiceId },
    });

    const issued = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [invoice] = await tx
          .select()
          .from(salesInvoices)
          .where(
            and(
              eq(salesInvoices.tenantId, ctx.tenant.id),
              eq(salesInvoices.id, data.invoiceId),
            ),
          )
          .limit(1);

        if (!invoice) throw new Error("That invoice no longer exists.");

        /**
         * ⚠️ REFUSED RATHER THAN MADE IDEMPOTENT. "Issue it again" is not
         * a harmless repeat — it would consume a second number from a
         * series that must be consecutive, and leave the customer holding
         * one document while our books show two.
         */
        if (invoice.status !== "draft") {
          throw new Error(
            `Invoice ${invoice.invoiceNumber} has already been issued. An issued tax invoice is corrected with a credit note, never re-issued.`,
          );
        }

        if (invoice.totalMinor <= 0n) {
          throw new Error(
            "This invoice is for zero. There is nothing to issue — delete the draft instead.",
          );
        }

        const { invoiceNumber, financialYear } = await nextInvoiceNumber(
          tx,
          ctx.tenant.id,
          invoice.invoiceDate,
        );

        await tx
          .update(salesInvoices)
          .set({
            invoiceNumber,
            financialYear,
            status: "issued",
            issuedAt: new Date(),
            issuedBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(salesInvoices.tenantId, ctx.tenant.id),
              eq(salesInvoices.id, data.invoiceId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "sales_invoice",
          resourceId: data.invoiceId,
          newValue: {
            invoiceNumber,
            status: "issued",
            totalMinor: serializeAmount(invoice.totalMinor),
          },
          /**
           * ⚠️ `critical`. A tax invoice has just entered a statutory
           * return and the customer's input-credit claim. If a workspace
           * reviews one class of event a month, this is it.
           */
          severity: "critical",
        });

        return { id: data.invoiceId, invoiceNumber };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/invoices");
    return { ok: true, data: issued };
  } catch (err) {
    return toSalesActionError(err, "issueInvoice");
  }
}

/* ================================================================== */
/* CANCEL                                                              */
/* ================================================================== */

export async function cancelInvoice(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = cancelInvoiceSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "invoices:cancel",
      feature: FEATURE_ORDERS,
      permission: "sales.invoices.cancel",
      resource: { type: "sales_invoice", id: data.invoiceId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [invoice] = await tx
          .select()
          .from(salesInvoices)
          .where(
            and(
              eq(salesInvoices.tenantId, ctx.tenant.id),
              eq(salesInvoices.id, data.invoiceId),
            ),
          )
          .limit(1);

        if (!invoice) throw new Error("That invoice no longer exists.");

        /**
         * ⚠️ MONEY AGAINST IT BLOCKS CANCELLATION. Cancelling a document
         * a customer has paid against would strand their payment on a
         * document that no longer exists, and the ledger would show cash
         * with nothing to answer.
         */
        if (invoice.receivedMinor > 0n) {
          throw new Error(
            `Invoice ${invoice.invoiceNumber} has ₹${(invoice.receivedMinor / 100n).toString()} received against it. Un-apply the receipt first, or raise a credit note instead of cancelling.`,
          );
        }

        await tx
          .update(salesInvoices)
          .set({
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledBy: ctx.user.id,
            cancelReason: data.reason,
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(salesInvoices.tenantId, ctx.tenant.id),
              eq(salesInvoices.id, data.invoiceId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "sales_invoice",
          resourceId: data.invoiceId,
          oldValue: { status: invoice.status },
          newValue: { status: "cancelled" },
          reason: data.reason,
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/invoices");
    return { ok: true, data: { id: data.invoiceId } };
  } catch (err) {
    return toSalesActionError(err, "cancelInvoice");
  }
}

/* ================================================================== */
/* MONEY IN                                                            */
/* ================================================================== */

export async function recordCustomerReceipt(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = recordReceiptSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "receipts:record",
      feature: FEATURE_ORDERS,
      permission: "sales.receipts.record",
      resource: { type: "company", id: data.companyId },
    });

    const receiptId = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [company] = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(
            and(eq(companies.tenantId, ctx.tenant.id), eq(companies.id, data.companyId)),
          )
          .limit(1);

        if (!company) throw new Error("That customer no longer exists.");

        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(customerReceipts)
          .where(eq(customerReceipts.tenantId, ctx.tenant.id));

        const receiptNumber = `RCP/${String((row?.count ?? 0) + 1).padStart(6, "0")}`;

        const [created] = await tx
          .insert(customerReceipts)
          .values({
            tenantId: ctx.tenant.id,
            receiptNumber,
            companyId: data.companyId,
            receivedOn: data.receivedOn,
            amountMinor: BigInt(data.amountMinor),
            tdsCreditMinor: BigInt(data.tdsCreditMinor ?? "0"),
            method: data.method,
            status: "cleared",
            instrumentRef: data.instrumentRef ?? null,
            bankRef: data.bankRef ?? null,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: customerReceipts.id });

        if (!created) throw new Error("The receipt could not be recorded.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "customer_receipt",
          resourceId: created.id,
          newValue: {
            company: company.name,
            receiptNumber,
            amountMinor: data.amountMinor,
            tdsCreditMinor: data.tdsCreditMinor ?? "0",
            method: data.method,
          },
          severity: "warning",
        });

        return created.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/invoices");
    revalidatePath(`/crm/companies/${data.companyId}`);
    return { ok: true, data: { id: receiptId } };
  } catch (err) {
    return toSalesActionError(err, "recordCustomerReceipt");
  }
}

/**
 * ⭐ APPLY A RECEIPT TO INVOICES — the write that closes the whole loop.
 *
 * The allocation rows drive the trigger in `0049 §2`, which sets
 * `sales_invoices.received_minor`, which drives `0049 §3`, which sets
 * `sales_orders.received_value_minor` — the column that had no writer and
 * made the 0048 credit limits inert.
 *
 * ⚠️ THE OVER-ALLOCATION GUARANTEES ARE CHECK CONSTRAINTS, NOT THIS
 * FUNCTION. `customer_receipts_allocated_within_amount` and
 * `sales_invoices_received_within_total` hold on every write path; this
 * is one of them.
 */
export async function allocateReceipt(
  input: unknown,
): Promise<ActionResult<{ receiptId: string; applied: number }>> {
  try {
    const data = allocateReceiptSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "receipts:allocate",
      feature: FEATURE_ORDERS,
      permission: "sales.receipts.allocate",
      resource: { type: "customer_receipt", id: data.receiptId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [receipt] = await tx
          .select()
          .from(customerReceipts)
          .where(
            and(
              eq(customerReceipts.tenantId, ctx.tenant.id),
              eq(customerReceipts.id, data.receiptId),
            ),
          )
          .limit(1);

        if (!receipt) throw new Error("That receipt no longer exists.");

        /**
         * ⚠️ A BOUNCED OR CANCELLED RECEIPT SETTLES NOTHING. The trigger
         * already excludes it from the roll-up, so allocating one would
         * create rows that look like settlement and move no figure —
         * the most confusing possible outcome.
         */
        if (receipt.status !== "cleared" && receipt.status !== "pending") {
          throw new Error(
            `Receipt ${receipt.receiptNumber} is ${receipt.status}. Money that did not arrive cannot settle an invoice.`,
          );
        }

        for (const allocation of data.allocations) {
          const [invoice] = await tx
            .select({
              id: salesInvoices.id,
              invoiceNumber: salesInvoices.invoiceNumber,
              status: salesInvoices.status,
              companyId: salesInvoices.companyId,
            })
            .from(salesInvoices)
            .where(
              and(
                eq(salesInvoices.tenantId, ctx.tenant.id),
                eq(salesInvoices.id, allocation.invoiceId),
              ),
            )
            .limit(1);

          if (!invoice) throw new Error("One of those invoices no longer exists.");

          /**
           * ⚠️ ONE CUSTOMER'S MONEY MAY NOT SETTLE ANOTHER'S INVOICE.
           * Both rows are inside this tenant, so row-level security
           * cannot catch this — it is a within-tenant correctness rule,
           * and getting it wrong silently moves a debt between two of the
           * workspace's own customers.
           */
          if (invoice.companyId !== receipt.companyId) {
            throw new Error(
              `Invoice ${invoice.invoiceNumber} belongs to a different customer than this receipt. A payment can only settle the account it was received for.`,
            );
          }

          if (invoice.status === "draft" || invoice.status === "cancelled") {
            throw new Error(
              `Invoice ${invoice.invoiceNumber} is ${invoice.status}. Only an issued invoice can be settled.`,
            );
          }

          await tx
            .insert(customerReceiptAllocations)
            .values({
              tenantId: ctx.tenant.id,
              receiptId: data.receiptId,
              invoiceId: allocation.invoiceId,
              amountMinor: BigInt(allocation.amountMinor),
              allocatedOn: receipt.receivedOn,
              createdBy: ctx.user.id,
            })
            .onConflictDoUpdate({
              target: [
                customerReceiptAllocations.receiptId,
                customerReceiptAllocations.invoiceId,
              ],
              /**
               * ⚠️ REPLACES, NEVER ADDS. An amendment that added to the
               * existing figure is how a ledger quietly double-counts a
               * payment somebody corrected.
               */
              set: { amountMinor: BigInt(allocation.amountMinor) },
            });
        }

        await writeAudit(ctx, {
          action: "update",
          resourceType: "customer_receipt",
          resourceId: data.receiptId,
          newValue: {
            allocations: data.allocations.length,
            totalMinor: serializeAmount(
              data.allocations.reduce((sum, a) => sum + BigInt(a.amountMinor), 0n),
            ),
          },
          severity: "warning",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/invoices");
    revalidatePath("/orders");
    return { ok: true, data: { receiptId: data.receiptId, applied: data.allocations.length } };
  } catch (err) {
    return toSalesActionError(err, "allocateReceipt");
  }
}

/**
 * Mark a payment as failed.
 *
 * ⭐ THE CASCADE IS AUTOMATIC. `customer_receipts_status_cascade` in 0049
 * re-runs the settlement arithmetic for every invoice this receipt
 * touched, so a bounce re-opens them with no cleanup path to forget.
 */
export async function bounceReceipt(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = bounceReceiptSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "receipts:record",
      feature: FEATURE_ORDERS,
      permission: "sales.receipts.record",
      resource: { type: "customer_receipt", id: data.receiptId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(customerReceipts)
          .set({
            status: "bounced",
            bouncedOn: data.bouncedOn,
            bounceReason: data.reason,
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(customerReceipts.tenantId, ctx.tenant.id),
              eq(customerReceipts.id, data.receiptId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "customer_receipt",
          resourceId: data.receiptId,
          newValue: { status: "bounced" },
          reason: data.reason,
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/invoices");
    return { ok: true, data: { id: data.receiptId } };
  } catch (err) {
    return toSalesActionError(err, "bounceReceipt");
  }
}

/* ================================================================== */
/* READ                                                                */
/* ================================================================== */

export async function getInvoice(input: unknown): Promise<
  ActionResult<{
    id: string;
    invoiceNumber: string;
    status: string;
    totalMinor: string;
    receivedMinor: string;
    outstandingMinor: string;
  }>
> {
  try {
    const data = issueInvoiceSchema.parse(input);
    const ctx = await requirePermission("sales.invoices.read", {
      type: "sales_invoice",
      id: data.invoiceId,
    });

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [invoice] = await tx
        .select()
        .from(salesInvoices)
        .where(
          and(eq(salesInvoices.tenantId, ctx.tenant.id), eq(salesInvoices.id, data.invoiceId)),
        )
        .limit(1);

      if (!invoice) throw new Error("That invoice no longer exists.");

      const total = toBigIntAmount(invoice.totalMinor);
      const received = toBigIntAmount(invoice.receivedMinor);

      return {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        totalMinor: serializeAmount(total),
        receivedMinor: serializeAmount(received),
        outstandingMinor: serializeAmount(total - received),
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "getInvoice");
  }
}
