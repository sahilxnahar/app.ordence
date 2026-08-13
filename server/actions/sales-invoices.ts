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

import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  salesInvoices,
  salesInvoiceLines,
  customerReceipts,
  customerReceiptAllocations,
  salesCreditNotes,
  salesCreditNoteLines,
} from "@/db/schema/sales-invoices";
import { companies } from "@/db/schema/crm";
import { salesOrders } from "@/db/schema/orders";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError } from "@/server/sales/guards";
import {
  captureCustomerIdentity,
  loadCustomerLedger,
  loadGstr1Documents,
  loadOrderForInvoicing,
  nextInvoiceNumber,
} from "@/server/invoicing/documents";
import { customerPosition, runningBalance } from "@/lib/receivables/customer-ledger";
import { buildGstr1, type Gstr1Return } from "@/lib/gstr1/build";
import { checkRule46, type Rule46Finding } from "@/lib/gst/invoice-fields";
import { buildInvoice, billableQty, fromQtyMinor } from "@/lib/invoicing/build";
import { taxKindFor } from "@/lib/gst/place-of-supply";
import {
  allocateReceiptSchema,
  bounceReceiptSchema,
  cancelInvoiceSchema,
  issueInvoiceSchema,
  raiseInvoiceFromOrderSchema,
  recordReceiptSchema,
  statementSchema,
  raiseCreditNoteSchema,
  issueCreditNoteSchema,
  discardCreditNoteSchema,
  gstr1PeriodSchema,
} from "@/lib/validators/sales-invoices";
import {
  assessCreditLines,
  assessCreditHeadroom,
  headroomMinor,
  remainingCreditableQty,
  type CreditableInvoiceLine,
  type CreditLineFinding,
} from "@/lib/invoicing/credit-note";
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
         * ⭐ FIXED IN v0.92.0. Phase 49 billed every intra-UT supply as
         *    CGST + SGST and logged it as a known gap — the right money
         *    in the wrong Act, and the wrong box in GSTR-1.
         *
         * ⚠️ THE CAUTION THAT PRODUCED THAT GAP WAS MISPLACED, and the
         * distinction is worth keeping. Re-running `determinePlaceOfSupply()`
         * here WOULD be wrong: it judges from addresses and registrations,
         * which move, so a historical document would silently re-split the
         * day a customer changed a delivery address.
         *
         * `taxKindFor()` asks something far smaller of the code the order
         * ALREADY STORED: is `35` a Union Territory? That is a fact fixed
         * by statute about a frozen value. It cannot drift, and refusing
         * to use it did not avoid a divergence — it created one.
         */
        const taxKind = taxKindFor(order.isInterState ?? false, order.placeOfSupplyCode);

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
            isUnionTerritory: taxKind === "cgst_utgst",
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

/* ================================================================== */
/* ⭐ THE CUSTOMER LEDGER — Phase 51                                    */
/* ================================================================== */

/**
 * A statement of account: every document, a running balance, and ageing.
 *
 * ⭐ THIS IS THE NUMBER BATCH B HAS BEEN BUILDING TOWARD. Credit exposure
 * today means "what is on order". `balanceMinor` here means "what they
 * owe" — and once the credit check consults this instead, a limit will
 * finally mean what a business thinks it means.
 *
 * ⚠️ NOT WIRED INTO `assessCredit()` YET, DELIBERATELY. Changing what a
 * credit limit measures is a change to when orders stop, and it belongs
 * in its own release with the UI that explains it — not smuggled in
 * beside the report that first made the figure visible.
 */
export async function getCustomerStatement(input: unknown): Promise<
  ActionResult<{
    companyId: string;
    asOf: string;
    balanceMinor: string;
    unappliedCreditMinor: string;
    outstandingMinor: string;
    notYetDueMinor: string;
    oldestDocumentDays: number;
    buckets: { label: string; amountMinor: string; documentCount: number }[];
    rows: {
      id: string;
      entryDate: string;
      entryType: string;
      reference: string;
      debitMinor: string;
      creditMinor: string;
      balanceMinor: string;
    }[];
  }>
> {
  try {
    const data = statementSchema.parse(input);
    const ctx = await requirePermission("sales.invoices.read", {
      type: "company",
      id: data.companyId,
    });

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const ledger = await loadCustomerLedger(tx, ctx.tenant.id, data.companyId);

      const position = customerPosition({
        entries: ledger.entries,
        openDocuments: ledger.openDocuments,
        unappliedCreditMinor: ledger.unappliedCreditMinor,
        asOf: data.asOf,
      });

      const rows = runningBalance(ledger.entries);

      return {
        companyId: data.companyId,
        asOf: position.ageing.asOf,
        balanceMinor: serializeAmount(position.balanceMinor),
        unappliedCreditMinor: serializeAmount(position.unappliedCreditMinor),
        outstandingMinor: serializeAmount(position.ageing.outstandingMinor),
        notYetDueMinor: serializeAmount(position.ageing.notYetDueMinor),
        oldestDocumentDays: position.ageing.oldestDocumentDays,
        buckets: position.ageing.buckets.map((b) => ({
          label: b.label,
          amountMinor: serializeAmount(b.amountMinor),
          documentCount: b.documentCount,
        })),
        rows: rows.map((r) => ({
          id: r.id,
          entryDate: r.entryDate,
          entryType: r.entryType,
          reference: r.reference,
          debitMinor: serializeAmount(r.debitMinor),
          creditMinor: serializeAmount(r.creditMinor),
          balanceMinor: serializeAmount(r.balanceMinor),
        })),
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "getCustomerStatement");
  }
}

/* ================================================================== */
/* ⭐ CREDIT NOTES — Phase 52                                           */
/* ================================================================== */

/**
 * Raise a DRAFT credit note against an issued invoice.
 *
 * ⚠️ THE "CANNOT EXCEED THE INVOICE" RULE IS A TRIGGER, NOT A CHECK
 *    HERE. Credit notes are raised one at a time, months apart, by
 *    different people — and by the public API of Phase 41, and by a
 *    back-fill. `sales_credit_note_within_invoice()` in 0050 holds on
 *    every path. Over-crediting is a refund of tax never collected, and
 *    it reaches GSTR-1 as a negative supply.
 */
/**
 * ⚠️ A LOCAL ALIAS, MATCHING `server/credit/position.ts`. The
 * transaction type is derived from `withTenant` rather than named
 * separately, so it cannot drift away from what `withTenant` actually
 * hands its callback.
 */
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⭐ WHAT IS STILL CREDITABLE ON AN INVOICE — lines and total.
 *
 * ⚠️ NOT EXPORTED, AND IT TAKES A `tx`. Both facts follow from the same
 * rule: this file is `"use server"`, so every export is a
 * browser-reachable RPC endpoint. A function taking a transaction cannot
 * be one. The exported read is `getCreditNoteContext` below, which opens
 * its own scope after checking a permission.
 *
 * ⚠️ IT SHARES THE CALLER'S TRANSACTION rather than opening its own. The
 * guard and the insert have to see one consistent picture; reading the
 * credited quantities outside the transaction that writes the new ones
 * is the race that lets two people credit the same goods.
 */
async function loadCreditableState(
  tx: Tx,
  tenantId: string,
  invoiceId: string,
): Promise<{
  lines: CreditableInvoiceLine[];
  issuedCreditTotalMinor: bigint;
}> {
  const invoiceLines = await tx
    .select()
    .from(salesInvoiceLines)
    .where(
      and(
        eq(salesInvoiceLines.tenantId, tenantId),
        eq(salesInvoiceLines.invoiceId, invoiceId),
      ),
    )
    .orderBy(salesInvoiceLines.lineNo);

  /**
   * ⚠️ `notInArray('draft', 'cancelled')` — THE SAME EXCLUSION THE
   * TRIGGER USES, and it must stay the same. A draft that consumed
   * headroom would let one person's abandoned working paper block
   * another person's lawful credit note, with nothing on either screen
   * explaining why.
   */
  const consuming = notInArray(salesCreditNotes.status, ["draft", "cancelled"]);

  const creditedRows = await tx
    .select({
      invoiceLineId: salesCreditNoteLines.invoiceLineId,
      qty: sql<string>`coalesce(sum(${salesCreditNoteLines.quantity}), 0)::text`,
    })
    .from(salesCreditNoteLines)
    .innerJoin(salesCreditNotes, eq(salesCreditNoteLines.creditNoteId, salesCreditNotes.id))
    .where(
      and(
        eq(salesCreditNoteLines.tenantId, tenantId),
        eq(salesCreditNotes.tenantId, tenantId),
        eq(salesCreditNotes.invoiceId, invoiceId),
        consuming,
      ),
    )
    .groupBy(salesCreditNoteLines.invoiceLineId);

  const [totalRow] = await tx
    .select({
      total: sql<string>`coalesce(sum(${salesCreditNotes.totalMinor}), 0)::text`,
    })
    .from(salesCreditNotes)
    .where(
      and(
        eq(salesCreditNotes.tenantId, tenantId),
        eq(salesCreditNotes.invoiceId, invoiceId),
        consuming,
      ),
    );

  const creditedByLine = new Map<string, string>();
  for (const r of creditedRows) {
    if (r.invoiceLineId) creditedByLine.set(r.invoiceLineId, String(r.qty));
  }

  return {
    lines: invoiceLines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      hsnSacCode: l.hsnSacCode,
      uom: l.uom,
      taxRateBps: l.taxRateBps,
      unitPriceMinor: toBigIntAmount(l.unitPriceMinor),
      quantity: String(l.quantity),
      quantityCreditedIssued: creditedByLine.get(l.id) ?? "0.000",
    })),
    issuedCreditTotalMinor: toBigIntAmount(totalRow?.total ?? "0"),
  };
}

/**
 * ⚠️ ONE MESSAGE FROM MANY FINDINGS, AND IT NAMES EVERY LINE.
 * Reporting only the first failure turns fixing a five-line return into
 * five round trips, each ending in a refusal that looks like a new
 * problem.
 */
function creditLineRefusal(findings: readonly CreditLineFinding[]): string {
  return findings.map((f) => f.message).join(" ");
}

export async function raiseCreditNote(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = raiseCreditNoteSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "invoices:create",
      feature: FEATURE_ORDERS,
      permission: "sales.invoices.create",
      resource: { type: "sales_invoice", id: data.invoiceId },
    });

    const creditNoteId = await withTenant(
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
         * ⚠️ ONLY AN ISSUED INVOICE CAN BE CREDITED. Crediting a draft is
         * meaningless — edit the draft. Crediting a cancelled one credits
         * a supply that never happened.
         */
        if (invoice.status === "draft" || invoice.status === "cancelled") {
          throw new Error(
            `Invoice ${invoice.invoiceNumber} is ${invoice.status}. A credit note reverses a document the customer holds — edit the draft instead.`,
          );
        }

        /**
         * 🔴 THE LINE CEILING — ADDED IN v0.96.0, AND IT CLOSES A REAL
         *    HOLE. `sales_credit_note_within_invoice()` compares
         *    DOCUMENT TOTALS. Crediting 100 units of a 10-unit line at
         *    ₹0.01 each passes it: the total is small, the quantity is
         *    absurd, and the HSN summary of GSTR-1 carries the absurd
         *    figure. A trigger cannot see this without a join the
         *    trigger has no business doing.
         *
         * ⚠️ CHECKED AT RAISE *AND* AT ISSUE. Here it is the fast fail
         * that tells someone while the form is still open. At issue it
         * is the one that counts, because another credit note may have
         * been issued in between.
         */
        const state = await loadCreditableState(tx, ctx.tenant.id, invoice.id);
        const lineFindings = assessCreditLines({
          invoiceLines: state.lines,
          proposed: data.lines,
        });
        if (lineFindings.length > 0) {
          throw new Error(creditLineRefusal(lineFindings));
        }

        const built = buildInvoice({
          orderLines: data.lines.map((l, i) => ({
            id: `cn-${i}`,
            lineNo: i + 1,
            description: l.description,
            uom: "nos",
            quantity: l.quantity,
            qtyInvoiced: "0.000",
            qtyCancelled: "0.000",
            unitPriceMinor: BigInt(l.unitPriceMinor),
            discountMinor: 0n,
            taxRateBps: l.taxRateBps,
            cessRateBps: 0,
            hsnSacCode: l.hsnSacCode ?? null,
          })),
          selection: data.lines.map((_, i) => ({ orderLineId: `cn-${i}` })),
          taxKind: invoice.isInterState ? "igst" : "cgst_sgst",
          placeOfSupplyCode: invoice.placeOfSupplyCode ?? "27",
        });

        /**
         * ⚠️ THE DOCUMENT CEILING IS PREDICTED HERE AND ENFORCED BY THE
         * TRIGGER AT ISSUE. A draft that could never be issued is a trap
         * — somebody fills in five lines, presses Issue, and only then
         * learns the invoice had ₹200 of headroom left. Refusing now
         * costs one message; refusing later costs the work.
         */
        const room = headroomMinor({
          invoiceTotalMinor: toBigIntAmount(invoice.totalMinor),
          issuedCreditTotalMinor: state.issuedCreditTotalMinor,
        });
        const verdict = assessCreditHeadroom({
          noteTotalMinor: built.tax.amountPayableMinor,
          headroomMinor: room,
        });
        if (!verdict.ok) {
          throw new Error(
            `Invoice ${invoice.invoiceNumber} has ${serializeAmount(room)} paise of credit left on it and this note comes to ${serializeAmount(built.tax.amountPayableMinor)}. A credit note can only reverse what was actually billed.`,
          );
        }

        const [created] = await tx
          .insert(salesCreditNotes)
          .values({
            tenantId: ctx.tenant.id,
            creditNoteNumber: `DRAFT-CN-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
            financialYear: data.noteDate.slice(0, 4),
            status: "draft",
            invoiceId: invoice.id,
            companyId: invoice.companyId,
            noteDate: data.noteDate,
            reasonCode: data.reasonCode,
            reason: data.reason,
            customerLegalName: invoice.customerLegalName,
            customerGstin: invoice.customerGstin,
            supplierGstin: invoice.supplierGstin,
            placeOfSupplyCode: invoice.placeOfSupplyCode,
            isInterState: invoice.isInterState,
            taxableValueMinor: built.tax.taxableMinor,
            cgstMinor: built.tax.cgstMinor,
            sgstMinor: built.tax.sgstMinor,
            igstMinor: built.tax.igstMinor,
            cessMinor: built.tax.cessMinor,
            roundOffMinor: built.tax.roundOffMinor,
            totalMinor: built.tax.amountPayableMinor,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: salesCreditNotes.id });

        if (!created) throw new Error("The credit note could not be created.");

        const byKey = new Map(built.tax.lines.map((l) => [l.key, l]));
        await tx.insert(salesCreditNoteLines).values(
          built.lines.map((l, i) => {
            const c = byKey.get(l.orderLineId);
            return {
              tenantId: ctx.tenant.id,
              creditNoteId: created.id,
              lineNo: i + 1,
              invoiceLineId: data.lines[i]?.invoiceLineId ?? null,
              description: l.description,
              hsnSacCode: l.hsnSacCode,
              taxRateBps: l.taxRateBps,
              quantity: l.quantity,
              uom: l.uom,
              unitPriceMinor: l.unitPriceMinor,
              taxableValueMinor: c?.taxableMinor ?? 0n,
              cgstMinor: c?.cgstMinor ?? 0n,
              sgstMinor: c?.sgstMinor ?? 0n,
              igstMinor: c?.igstMinor ?? 0n,
              cessMinor: c?.cessMinor ?? 0n,
              lineTotalMinor:
                (c?.taxableMinor ?? 0n) +
                (c?.cgstMinor ?? 0n) +
                (c?.sgstMinor ?? 0n) +
                (c?.igstMinor ?? 0n),
            };
          }),
        );

        await writeAudit(ctx, {
          action: "create",
          resourceType: "sales_credit_note",
          resourceId: created.id,
          newValue: {
            invoice: invoice.invoiceNumber,
            reasonCode: data.reasonCode,
            totalMinor: serializeAmount(built.tax.amountPayableMinor),
          },
          reason: data.reason,
          severity: "warning",
        });

        return created.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/invoices");
    return { ok: true, data: { id: creditNoteId } };
  } catch (err) {
    return toSalesActionError(err, "raiseCreditNote");
  }
}

/**
 * ⭐ Issue it. This is where the over-credit trigger actually fires — a
 * draft does not consume the invoice's headroom, so a colleague's
 * legitimate credit note is never blocked by somebody's abandoned draft.
 */
export async function issueCreditNote(
  input: unknown,
): Promise<ActionResult<{ id: string; creditNoteNumber: string }>> {
  try {
    const data = issueCreditNoteSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "invoices:issue",
      feature: FEATURE_ORDERS,
      permission: "sales.invoices.issue",
      resource: { type: "sales_credit_note", id: data.creditNoteId },
    });

    const issued = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [note] = await tx
          .select()
          .from(salesCreditNotes)
          .where(
            and(
              eq(salesCreditNotes.tenantId, ctx.tenant.id),
              eq(salesCreditNotes.id, data.creditNoteId),
            ),
          )
          .limit(1);

        if (!note) throw new Error("That credit note no longer exists.");
        if (note.status !== "draft") {
          throw new Error(
            `Credit note ${note.creditNoteNumber} has already been issued. It cannot be issued twice — the customer has already reversed credit against it.`,
          );
        }

        /**
         * 🔴 THE LINE CEILING, RE-CHECKED AT THE MOMENT THAT COUNTS.
         *
         * ⚠️ THE CHECK AT RAISE IS NOT ENOUGH AND WAS NEVER MEANT TO BE.
         * Two drafts can each be raised legitimately against the same
         * ten units. The first to be issued consumes them; the second
         * must be refused here, or the same goods come back twice.
         *
         * This is exactly why the document ceiling lives in a trigger:
         * the check has to run against the state at WRITE time, not at
         * form time.
         */
        const state = await loadCreditableState(tx, ctx.tenant.id, note.invoiceId);
        const noteLines = await tx
          .select({
            invoiceLineId: salesCreditNoteLines.invoiceLineId,
            quantity: salesCreditNoteLines.quantity,
          })
          .from(salesCreditNoteLines)
          .where(
            and(
              eq(salesCreditNoteLines.tenantId, ctx.tenant.id),
              eq(salesCreditNoteLines.creditNoteId, data.creditNoteId),
            ),
          );

        const lineFindings = assessCreditLines({
          invoiceLines: state.lines,
          proposed: noteLines.map((l) => ({
            invoiceLineId: l.invoiceLineId,
            quantity: String(l.quantity),
          })),
        });
        if (lineFindings.length > 0) {
          throw new Error(creditLineRefusal(lineFindings));
        }

        /**
         * 🔴 COUNTS ISSUED NOTES ONLY — FIXED IN v0.96.0.
         *
         * ⚠️ IT USED TO COUNT EVERY ROW IN THE YEAR, DRAFTS INCLUDED,
         * and that broke the one thing the series exists to guarantee.
         * Five open drafts made the FIRST issued note `CN/00006`, and
         * Rule 46(b) — applied to credit notes by Rule 53 — requires the
         * series to be CONSECUTIVE. A series starting at six is a
         * question an auditor is entitled to ask and nobody can answer
         * three years later.
         *
         * ⚠️ AND IT MADE DISCARDING A DRAFT UNSAFE. If a discarded draft
         * left the table the count would shrink, the next issue would
         * reuse a number, and `sales_credit_notes_number_tenant_key`
         * would refuse it — a legitimate credit note failing because
         * somebody tidied up.
         */
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(salesCreditNotes)
          .where(
            and(
              eq(salesCreditNotes.tenantId, ctx.tenant.id),
              eq(salesCreditNotes.financialYear, note.financialYear),
              notInArray(salesCreditNotes.status, ["draft", "cancelled"]),
            ),
          );

        /** ⚠️ Its OWN consecutive series — Rule 53 requires it. */
        const creditNoteNumber = `CN/${String((row?.count ?? 0) + 1).padStart(5, "0")}`;

        await tx
          .update(salesCreditNotes)
          .set({
            creditNoteNumber,
            status: "issued",
            issuedAt: new Date(),
            issuedBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(salesCreditNotes.tenantId, ctx.tenant.id),
              eq(salesCreditNotes.id, data.creditNoteId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "sales_credit_note",
          resourceId: data.creditNoteId,
          newValue: {
            creditNoteNumber,
            status: "issued",
            totalMinor: serializeAmount(note.totalMinor),
          },
          severity: "critical",
        });

        return { id: data.creditNoteId, creditNoteNumber };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/invoices");
    return { ok: true, data: issued };
  } catch (err) {
    return toSalesActionError(err, "issueCreditNote");
  }
}

/* ================================================================== */
/* ⭐ GSTR-1 — Phase 53                                                 */
/* ================================================================== */

/**
 * Build the outward supplies return for a month.
 *
 * ⚠️ THIS BUILDS THE RETURN. IT DOES NOT FILE IT. Transmission needs a
 * GSP, an API contract that changes, and credentials — and a checkable
 * artefact is worth having on its own. An accountant reconciles this
 * against their working papers BEFORE anything is transmitted, which is
 * exactly what a first filing needs.
 *
 * ⚠️ GATED ON `sales.invoices.read`, NOT on a write permission. Producing
 * a return changes nothing. Gating it behind a write key would mean the
 * accountant who files it needs the power to issue invoices, which is
 * backwards.
 */
export async function buildGstr1Return(
  input: unknown,
): Promise<ActionResult<Gstr1Return>> {
  try {
    const data = gstr1PeriodSchema.parse(input);
    const ctx = await requirePermission("sales.invoices.read");

    /**
     * ⚠️ THE WINDOW IS HALF-OPEN — `[from, to)`. A closed range on a
     * timestamp column loses every document issued after 00:00:00 on the
     * last day, which is most of them. This is the classic month-boundary
     * bug and it under-reports a return.
     */
    const [year, month] = data.period.split("-").map(Number);
    const from = `${data.period}-01`;
    const to =
      month === 12
        ? `${(year ?? 0) + 1}-01-01`
        : `${year}-${String((month ?? 0) + 1).padStart(2, "0")}-01`;

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const documents = await loadGstr1Documents(tx, ctx.tenant.id, from, to);
      return buildGstr1({
        period: data.period,
        supplierGstin: null,
        documents,
      });
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "buildGstr1Return");
  }
}

/**
 * The invoice register.
 *
 * ⚠️ RETURNS THE FIGURES THE SCREEN LEADS WITH, NOT A RAW LIST. The page
 * needs "how much is overdue", and computing that in the component would
 * mean every render re-deriving money from strings. It is derived once,
 * here, in `bigint`.
 */
export async function listInvoices(input?: { limit?: number }): Promise<
  ActionResult<{
    rows: {
      id: string;
      invoiceNumber: string;
      invoiceDate: string;
      dueDate: string | null;
      status: string;
      customerLegalName: string | null;
      totalMinor: string;
      receivedMinor: string;
      outstandingMinor: string;
      daysOverdue: number;
    }[];
    summary: {
      overdueMinor: string;
      outstandingMinor: string;
      overdueCount: number;
      draftCount: number;
    };
  }>
> {
  try {
    const limit = Math.min(Math.max(input?.limit ?? 200, 1), 500);
    const ctx = await requirePermission("sales.invoices.read");

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          id: salesInvoices.id,
          invoiceNumber: salesInvoices.invoiceNumber,
          invoiceDate: salesInvoices.invoiceDate,
          dueDate: salesInvoices.dueDate,
          status: salesInvoices.status,
          customerLegalName: salesInvoices.customerLegalName,
          totalMinor: salesInvoices.totalMinor,
          receivedMinor: salesInvoices.receivedMinor,
        })
        .from(salesInvoices)
        .where(eq(salesInvoices.tenantId, ctx.tenant.id))
        .orderBy(desc(salesInvoices.invoiceDate))
        .limit(limit);

      /**
       * ⚠️ "TODAY" IS TAKEN ONCE, HERE, AND NOT PER ROW. A loop that
       * called `new Date()` each iteration could straddle midnight on a
       * long list and age two invoices differently for no reason a user
       * could ever explain.
       */
      const today = new Date().toISOString().slice(0, 10);

      let overdueMinor = 0n;
      let outstandingMinor = 0n;
      let overdueCount = 0;
      let draftCount = 0;

      const mapped = rows.map((r) => {
        const outstanding =
          toBigIntAmount(r.totalMinor) - toBigIntAmount(r.receivedMinor);
        const settled = r.status === "paid" || r.status === "cancelled";
        const live = !settled && r.status !== "draft";

        if (r.status === "draft") draftCount += 1;
        if (live && outstanding > 0n) outstandingMinor += outstanding;

        const due = r.dueDate ? String(r.dueDate) : String(r.invoiceDate);
        const daysOverdue = Math.max(
          0,
          Math.floor(
            (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000,
          ),
        );

        if (live && outstanding > 0n && daysOverdue > 0) {
          overdueMinor += outstanding;
          overdueCount += 1;
        }

        return {
          id: r.id,
          invoiceNumber: r.invoiceNumber,
          invoiceDate: String(r.invoiceDate),
          dueDate: r.dueDate ? String(r.dueDate) : null,
          status: r.status,
          customerLegalName: r.customerLegalName,
          totalMinor: serializeAmount(toBigIntAmount(r.totalMinor)),
          receivedMinor: serializeAmount(toBigIntAmount(r.receivedMinor)),
          outstandingMinor: serializeAmount(outstanding > 0n ? outstanding : 0n),
          daysOverdue: live ? daysOverdue : 0,
        };
      });

      return {
        rows: mapped,
        summary: {
          overdueMinor: serializeAmount(overdueMinor),
          outstandingMinor: serializeAmount(outstandingMinor),
          overdueCount,
          draftCount,
        },
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "listInvoices");
  }
}

/**
 * One invoice, its lines, and its Rule 46 report — everything the detail
 * screen and the print view need, in one round trip.
 *
 * ⭐ `checkRule46()` HAS EXISTED SINCE PHASE 32 AND NOTHING RENDERED IT.
 *    An invoice that is legally incomplete is a document the customer's
 *    accountant rejects, and until now the only way to find out was to
 *    send it. The report is returned on every read so the screen can say
 *    so before anybody prints.
 *
 * ⚠️ IT REPORTS, IT DOES NOT REFUSE. A draft is legitimately incomplete —
 * that is what a draft is. `issueInvoice` is where a blocking finding
 * should stop the world; a checker that threw here would make the draft
 * screen unusable.
 */
export async function getInvoiceDetail(input: unknown): Promise<
  ActionResult<{
    invoice: {
      id: string;
      invoiceNumber: string;
      invoiceDate: string;
      dueDate: string | null;
      status: string;
      companyId: string;
      customerLegalName: string | null;
      customerGstin: string | null;
      supplierGstin: string | null;
      placeOfSupplyCode: string | null;
      isInterState: boolean;
      isUnionTerritory: boolean;
      isReverseCharge: boolean;
      taxableValueMinor: string;
      cgstMinor: string;
      sgstMinor: string;
      igstMinor: string;
      cessMinor: string;
      roundOffMinor: string;
      totalMinor: string;
      receivedMinor: string;
      outstandingMinor: string;
      notes: string | null;
      terms: string | null;
    };
    lines: {
      id: string;
      lineNo: number;
      description: string;
      hsnSacCode: string | null;
      quantity: string;
      uom: string;
      taxRateBps: number | null;
      unitPriceMinor: string;
      discountMinor: string;
      taxableValueMinor: string;
      cgstMinor: string;
      sgstMinor: string;
      igstMinor: string;
      lineTotalMinor: string;
    }[];
    rule46: { ok: boolean; blocking: Rule46Finding[]; advisory: Rule46Finding[] };
  }>
> {
  try {
    const data = issueInvoiceSchema.parse(input);
    const ctx = await requirePermission("sales.invoices.read", {
      type: "sales_invoice",
      id: data.invoiceId,
    });

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [inv] = await tx
        .select()
        .from(salesInvoices)
        .where(
          and(eq(salesInvoices.tenantId, ctx.tenant.id), eq(salesInvoices.id, data.invoiceId)),
        )
        .limit(1);

      if (!inv) throw new Error("That invoice no longer exists.");

      const lines = await tx
        .select()
        .from(salesInvoiceLines)
        .where(
          and(
            eq(salesInvoiceLines.tenantId, ctx.tenant.id),
            eq(salesInvoiceLines.invoiceId, data.invoiceId),
          ),
        )
        .orderBy(salesInvoiceLines.lineNo);

      const report = checkRule46({
        invoiceNumber: inv.status === "draft" ? "" : inv.invoiceNumber,
        issuedAt: inv.issuedAt ?? inv.invoiceDate,
        supplierLegalName: null,
        supplierGstin: inv.supplierGstin,
        supplierStateCode: inv.supplierStateCode,
        supplierAddress: null,
        recipientLegalName: inv.customerLegalName,
        recipientGstin: inv.customerGstin,
        recipientRegistration: inv.customerGstin ? "regular" : "unregistered",
        recipientAddress: inv.customerAddress as Record<string, unknown>,
        recipientStateCode: null,
        placeOfSupplyCode: inv.placeOfSupplyCode,
        supplyType: inv.supplyType === "services" ? "services" : "goods",
        propertyStateCode: inv.propertyStateCode,
        isInterState: inv.isInterState,
        isReverseCharge: inv.isReverseCharge,
        /**
         * ⚠️ `deliveryAddress` AND `signedBy` ARE NULL AND THAT IS HONEST.
         * Neither is captured on a sales invoice yet, so Rule 46(o) and
         * 46(q) will come back as findings. That is the correct outcome —
         * the report is meant to tell you what the document is missing,
         * and silencing it by inventing a value would make the check
         * pass on a document that would still be rejected.
         */
        deliveryAddress: null,
        signedBy: null,
        totalMinor: toBigIntAmount(inv.totalMinor),
        lines: lines.map((l) => ({
          description: l.description,
          hsnSacCode: l.hsnSacCode,
          quantity: Number(l.quantity),
          uqc: l.uom,
          taxableMinor: toBigIntAmount(l.taxableValueMinor),
          rateBps: l.taxRateBps ?? 0,
        })),
      });

      const total = toBigIntAmount(inv.totalMinor);
      const received = toBigIntAmount(inv.receivedMinor);

      return {
        invoice: {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: String(inv.invoiceDate),
          dueDate: inv.dueDate ? String(inv.dueDate) : null,
          status: inv.status,
          companyId: inv.companyId,
          customerLegalName: inv.customerLegalName,
          customerGstin: inv.customerGstin,
          supplierGstin: inv.supplierGstin,
          placeOfSupplyCode: inv.placeOfSupplyCode,
          isInterState: inv.isInterState,
          isUnionTerritory: inv.isUnionTerritory,
          isReverseCharge: inv.isReverseCharge,
          taxableValueMinor: serializeAmount(toBigIntAmount(inv.taxableValueMinor)),
          cgstMinor: serializeAmount(toBigIntAmount(inv.cgstMinor)),
          sgstMinor: serializeAmount(toBigIntAmount(inv.sgstMinor)),
          igstMinor: serializeAmount(toBigIntAmount(inv.igstMinor)),
          cessMinor: serializeAmount(toBigIntAmount(inv.cessMinor)),
          roundOffMinor: serializeAmount(toBigIntAmount(inv.roundOffMinor)),
          totalMinor: serializeAmount(total),
          receivedMinor: serializeAmount(received),
          outstandingMinor: serializeAmount(total - received),
          notes: inv.notes,
          terms: inv.terms,
        },
        lines: lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          description: l.description,
          hsnSacCode: l.hsnSacCode,
          quantity: String(l.quantity),
          uom: l.uom,
          taxRateBps: l.taxRateBps,
          unitPriceMinor: serializeAmount(toBigIntAmount(l.unitPriceMinor)),
          discountMinor: serializeAmount(toBigIntAmount(l.discountMinor)),
          taxableValueMinor: serializeAmount(toBigIntAmount(l.taxableValueMinor)),
          cgstMinor: serializeAmount(toBigIntAmount(l.cgstMinor)),
          sgstMinor: serializeAmount(toBigIntAmount(l.sgstMinor)),
          igstMinor: serializeAmount(toBigIntAmount(l.igstMinor)),
          lineTotalMinor: serializeAmount(toBigIntAmount(l.lineTotalMinor)),
        })),
        rule46: {
          ok: report.ok,
          blocking: report.blocking,
          advisory: report.advisory,
        },
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "getInvoiceDetail");
  }
}

/**
 * Orders that can still be invoiced, with what remains billable on each.
 *
 * ⚠️ AN ORDER WITH NOTHING LEFT TO BILL IS EXCLUDED, NOT SHOWN GREYED
 *    OUT. A picker full of orders you cannot choose is a picker nobody
 *    reads — and the one order that IS billable hides in it.
 */
export async function listInvoiceableOrders(): Promise<
  ActionResult<
    {
      id: string;
      orderNo: string;
      companyId: string | null;
      status: string;
      totalMinor: string;
      lines: {
        id: string;
        lineNo: number;
        description: string;
        uom: string;
        billableQty: string;
        unitPriceMinor: string;
      }[];
    }[]
  >
> {
  try {
    const ctx = await requirePermission("sales.invoices.create");

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const orders = await tx
        .select({
          id: salesOrders.id,
          orderNo: salesOrders.orderNo,
          companyId: salesOrders.companyId,
          status: salesOrders.status,
          totalMinor: salesOrders.totalMinor,
        })
        .from(salesOrders)
        .where(
          and(
            eq(salesOrders.tenantId, ctx.tenant.id),
            inArray(salesOrders.status, [
              "confirmed",
              "partially_fulfilled",
              "fulfilled",
              "closed",
            ]),
          ),
        )
        .orderBy(desc(salesOrders.orderDate))
        .limit(100);

      const out = [];
      for (const o of orders) {
        const loaded = await loadOrderForInvoicing(tx, ctx.tenant.id, o.id);
        if (!loaded) continue;

        const lines = loaded.lines
          .map((l) => ({
            id: l.id,
            lineNo: l.lineNo,
            description: l.description,
            uom: l.uom,
            billableQty: fromQtyMinor(billableQty(l)),
            unitPriceMinor: serializeAmount(l.unitPriceMinor),
            raw: billableQty(l),
          }))
          .filter((l) => l.raw > 0n)
          .map(({ raw: _raw, ...rest }) => rest);

        if (lines.length === 0) continue;

        out.push({
          id: o.id,
          orderNo: o.orderNo,
          companyId: o.companyId,
          status: o.status,
          totalMinor: serializeAmount(toBigIntAmount(o.totalMinor)),
          lines,
        });
      }
      return out;
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "listInvoiceableOrders");
  }
}

/**
 * Record a receipt AND apply it to one invoice, in one transaction.
 *
 * ⭐ THE COMMON CASE DESERVES ONE ACTION. "A customer paid this invoice"
 *    is what happens ninety times out of a hundred, and making somebody
 *    perform two steps for it is how unapplied cash accumulates — the
 *    receipt gets recorded, the allocation gets forgotten, and the
 *    invoice still reads as overdue while the money sits on the account.
 *
 * ⚠️ IT DELEGATES; IT DOES NOT DUPLICATE. Both halves run through
 *    `recordCustomerReceipt` and `allocateReceipt`, so every guarantee
 *    they carry — the customer match, the bounced-receipt refusal, the
 *    over-allocation constraints — applies here unchanged.
 */
export async function settleInvoice(input: {
  invoiceId: string;
  companyId: string;
  receivedOn: string;
  amountMinor: string;
  tdsCreditMinor?: string;
  method: string;
  instrumentRef?: string;
}): Promise<ActionResult<{ receiptId: string }>> {
  try {
    const receipt = await recordCustomerReceipt({
      companyId: input.companyId,
      receivedOn: input.receivedOn,
      amountMinor: input.amountMinor,
      tdsCreditMinor: input.tdsCreditMinor,
      method: input.method,
      instrumentRef: input.instrumentRef,
    });

    if (!receipt.ok) return receipt;

    /**
     * ⚠️ THE ALLOCATION IS CASH PLUS WITHHELD TAX. A customer who paid
     * ₹90,000 and withheld ₹10,000 has settled ₹1,00,000 of the invoice.
     * Allocating only the cash leaves ₹10,000 showing as overdue forever
     * and sends a dunning letter to somebody who paid in full.
     */
    const settled = BigInt(input.amountMinor) + BigInt(input.tdsCreditMinor ?? "0");

    const allocation = await allocateReceipt({
      receiptId: receipt.data.id,
      allocations: [{ invoiceId: input.invoiceId, amountMinor: settled.toString() }],
    });

    if (!allocation.ok) return allocation;

    return { ok: true, data: { receiptId: receipt.data.id } };
  } catch (err) {
    return toSalesActionError(err, "settleInvoice");
  }
}

/* ================================================================== */
/* ⭐ CREDIT-NOTE READS — Phase 54, the screens                         */
/* ================================================================== */

/**
 * Everything the "raise a credit note" form needs, in one call.
 *
 * ⚠️ THE FORM DOES NOT GET TO ASK FOR THE INVOICE AND THE HEADROOM
 * SEPARATELY. Two calls means two moments, and between them another
 * credit note can be issued — so the screen would show a total from one
 * instant and a remaining figure from another, which is how a person
 * ends up typing a number the server then refuses.
 *
 * ⚠️ GATED ON `sales.invoices.read`, NOT on a write permission. Looking
 * at what is creditable changes nothing. The refusal belongs at raise.
 */
export async function getCreditNoteContext(input: unknown): Promise<
  ActionResult<{
    invoice: {
      id: string;
      invoiceNumber: string;
      invoiceDate: string;
      status: string;
      customerLegalName: string | null;
      customerGstin: string | null;
      placeOfSupplyCode: string | null;
      isInterState: boolean;
      isUnionTerritory: boolean;
      totalMinor: string;
    };
    /** ⭐ `remainingQty` is the figure the form limits against. */
    lines: {
      id: string;
      lineNo: number;
      description: string;
      hsnSacCode: string | null;
      uom: string;
      taxRateBps: number | null;
      unitPriceMinor: string;
      quantity: string;
      quantityCreditedIssued: string;
      remainingQty: string;
    }[];
    headroomMinor: string;
    issuedCreditTotalMinor: string;
    notes: {
      id: string;
      creditNoteNumber: string;
      noteDate: string;
      status: string;
      reasonCode: string;
      reason: string;
      totalMinor: string;
    }[];
  }>
> {
  try {
    const data = issueInvoiceSchema.parse(input);
    const ctx = await requirePermission("sales.invoices.read", {
      type: "sales_invoice",
      id: data.invoiceId,
    });

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [inv] = await tx
        .select()
        .from(salesInvoices)
        .where(
          and(eq(salesInvoices.tenantId, ctx.tenant.id), eq(salesInvoices.id, data.invoiceId)),
        )
        .limit(1);

      if (!inv) throw new Error("That invoice no longer exists.");

      const state = await loadCreditableState(tx, ctx.tenant.id, inv.id);

      const notes = await tx
        .select({
          id: salesCreditNotes.id,
          creditNoteNumber: salesCreditNotes.creditNoteNumber,
          noteDate: salesCreditNotes.noteDate,
          status: salesCreditNotes.status,
          reasonCode: salesCreditNotes.reasonCode,
          reason: salesCreditNotes.reason,
          totalMinor: salesCreditNotes.totalMinor,
        })
        .from(salesCreditNotes)
        .where(
          and(
            eq(salesCreditNotes.tenantId, ctx.tenant.id),
            eq(salesCreditNotes.invoiceId, inv.id),
          ),
        )
        .orderBy(desc(salesCreditNotes.noteDate), desc(salesCreditNotes.createdAt));

      const room = headroomMinor({
        invoiceTotalMinor: toBigIntAmount(inv.totalMinor),
        issuedCreditTotalMinor: state.issuedCreditTotalMinor,
      });

      return {
        invoice: {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: String(inv.invoiceDate),
          status: inv.status,
          customerLegalName: inv.customerLegalName,
          customerGstin: inv.customerGstin,
          placeOfSupplyCode: inv.placeOfSupplyCode,
          isInterState: inv.isInterState,
          isUnionTerritory: inv.isUnionTerritory,
          totalMinor: serializeAmount(toBigIntAmount(inv.totalMinor)),
        },
        lines: state.lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          description: l.description,
          hsnSacCode: l.hsnSacCode,
          uom: l.uom,
          taxRateBps: l.taxRateBps,
          unitPriceMinor: serializeAmount(l.unitPriceMinor),
          quantity: l.quantity,
          quantityCreditedIssued: l.quantityCreditedIssued,
          remainingQty: remainingCreditableQty(l),
        })),
        headroomMinor: serializeAmount(room),
        issuedCreditTotalMinor: serializeAmount(state.issuedCreditTotalMinor),
        notes: notes.map((n) => ({
          id: n.id,
          creditNoteNumber: n.creditNoteNumber,
          noteDate: String(n.noteDate),
          status: n.status,
          reasonCode: n.reasonCode,
          reason: n.reason,
          totalMinor: serializeAmount(toBigIntAmount(n.totalMinor)),
        })),
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "getCreditNoteContext");
  }
}

/**
 * One credit note, with its lines and the invoice it reverses.
 */
export async function getCreditNoteDetail(input: unknown): Promise<
  ActionResult<{
    note: {
      id: string;
      creditNoteNumber: string;
      noteDate: string;
      status: string;
      reasonCode: string;
      reason: string;
      invoiceId: string;
      invoiceNumber: string;
      customerLegalName: string | null;
      customerGstin: string | null;
      placeOfSupplyCode: string | null;
      isInterState: boolean;
      taxableValueMinor: string;
      cgstMinor: string;
      sgstMinor: string;
      igstMinor: string;
      cessMinor: string;
      roundOffMinor: string;
      totalMinor: string;
    };
    lines: {
      id: string;
      lineNo: number;
      description: string;
      hsnSacCode: string | null;
      quantity: string;
      uom: string;
      taxRateBps: number | null;
      unitPriceMinor: string;
      taxableValueMinor: string;
      cgstMinor: string;
      sgstMinor: string;
      igstMinor: string;
      lineTotalMinor: string;
    }[];
  }>
> {
  try {
    const data = issueCreditNoteSchema.parse(input);
    const ctx = await requirePermission("sales.invoices.read", {
      type: "sales_credit_note",
      id: data.creditNoteId,
    });

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [note] = await tx
        .select()
        .from(salesCreditNotes)
        .where(
          and(
            eq(salesCreditNotes.tenantId, ctx.tenant.id),
            eq(salesCreditNotes.id, data.creditNoteId),
          ),
        )
        .limit(1);

      if (!note) throw new Error("That credit note no longer exists.");

      /**
       * ⚠️ THE INVOICE NUMBER IS LOOKED UP, NOT COPIED ONTO THE NOTE.
       * A draft invoice carries a placeholder number that becomes a real
       * one at issue; a credit note can only be raised against an issued
       * invoice, so the number is stable by the time it is read — but
       * reading it live means the two documents can never disagree.
       */
      const [inv] = await tx
        .select({
          invoiceNumber: salesInvoices.invoiceNumber,
        })
        .from(salesInvoices)
        .where(
          and(eq(salesInvoices.tenantId, ctx.tenant.id), eq(salesInvoices.id, note.invoiceId)),
        )
        .limit(1);

      const lines = await tx
        .select()
        .from(salesCreditNoteLines)
        .where(
          and(
            eq(salesCreditNoteLines.tenantId, ctx.tenant.id),
            eq(salesCreditNoteLines.creditNoteId, note.id),
          ),
        )
        .orderBy(salesCreditNoteLines.lineNo);

      return {
        note: {
          id: note.id,
          creditNoteNumber: note.creditNoteNumber,
          noteDate: String(note.noteDate),
          status: note.status,
          reasonCode: note.reasonCode,
          reason: note.reason,
          invoiceId: note.invoiceId,
          invoiceNumber: inv?.invoiceNumber ?? "—",
          customerLegalName: note.customerLegalName,
          customerGstin: note.customerGstin,
          placeOfSupplyCode: note.placeOfSupplyCode,
          isInterState: note.isInterState,
          taxableValueMinor: serializeAmount(toBigIntAmount(note.taxableValueMinor)),
          cgstMinor: serializeAmount(toBigIntAmount(note.cgstMinor)),
          sgstMinor: serializeAmount(toBigIntAmount(note.sgstMinor)),
          igstMinor: serializeAmount(toBigIntAmount(note.igstMinor)),
          cessMinor: serializeAmount(toBigIntAmount(note.cessMinor)),
          roundOffMinor: serializeAmount(toBigIntAmount(note.roundOffMinor)),
          totalMinor: serializeAmount(toBigIntAmount(note.totalMinor)),
        },
        lines: lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          description: l.description,
          hsnSacCode: l.hsnSacCode,
          quantity: String(l.quantity),
          uom: l.uom,
          taxRateBps: l.taxRateBps,
          unitPriceMinor: serializeAmount(toBigIntAmount(l.unitPriceMinor)),
          taxableValueMinor: serializeAmount(toBigIntAmount(l.taxableValueMinor)),
          cgstMinor: serializeAmount(toBigIntAmount(l.cgstMinor)),
          sgstMinor: serializeAmount(toBigIntAmount(l.sgstMinor)),
          igstMinor: serializeAmount(toBigIntAmount(l.igstMinor)),
          lineTotalMinor: serializeAmount(toBigIntAmount(l.lineTotalMinor)),
        })),
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "getCreditNoteDetail");
  }
}

/**
 * The credit-note register.
 *
 * ⚠️ IT LEADS WITH THE ISSUED VALUE, NOT A COUNT. Twelve credit notes
 * could be ₹1,200 of returns or ₹12 lakh of them, and only one of those
 * is worth a conversation. Drafts are counted separately and never added
 * into the value — nothing has been reversed until a note is issued.
 */
export async function listCreditNotes(input?: { limit?: number }): Promise<
  ActionResult<{
    rows: {
      id: string;
      creditNoteNumber: string;
      noteDate: string;
      status: string;
      reasonCode: string;
      invoiceId: string;
      invoiceNumber: string;
      customerLegalName: string | null;
      totalMinor: string;
    }[];
    summary: { issuedValueMinor: string; issuedCount: number; draftCount: number };
  }>
> {
  try {
    /**
     * ⚠️ NO RESOURCE ID — this is a register, not a document. Passing a
     * placeholder id would put a resource on the audit line that nobody
     * touched, and `listInvoices` above does the same thing for the same
     * reason.
     */
    const ctx = await requirePermission("sales.invoices.read");
    const limit = Math.min(Math.max(input?.limit ?? 100, 1), 500);

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          id: salesCreditNotes.id,
          creditNoteNumber: salesCreditNotes.creditNoteNumber,
          noteDate: salesCreditNotes.noteDate,
          status: salesCreditNotes.status,
          reasonCode: salesCreditNotes.reasonCode,
          invoiceId: salesCreditNotes.invoiceId,
          invoiceNumber: salesInvoices.invoiceNumber,
          customerLegalName: salesCreditNotes.customerLegalName,
          totalMinor: salesCreditNotes.totalMinor,
        })
        .from(salesCreditNotes)
        .leftJoin(
          salesInvoices,
          and(
            eq(salesInvoices.id, salesCreditNotes.invoiceId),
            eq(salesInvoices.tenantId, ctx.tenant.id),
          ),
        )
        .where(eq(salesCreditNotes.tenantId, ctx.tenant.id))
        .orderBy(desc(salesCreditNotes.noteDate), desc(salesCreditNotes.createdAt))
        .limit(limit);

      let issuedValueMinor = 0n;
      let issuedCount = 0;
      let draftCount = 0;
      for (const r of rows) {
        if (r.status === "draft") {
          draftCount += 1;
          continue;
        }
        if (r.status === "cancelled") continue;
        issuedCount += 1;
        issuedValueMinor += toBigIntAmount(r.totalMinor);
      }

      return {
        rows: rows.map((r) => ({
          id: r.id,
          creditNoteNumber: r.creditNoteNumber,
          noteDate: String(r.noteDate),
          status: r.status,
          reasonCode: r.reasonCode,
          invoiceId: r.invoiceId,
          invoiceNumber: r.invoiceNumber ?? "—",
          customerLegalName: r.customerLegalName,
          totalMinor: serializeAmount(toBigIntAmount(r.totalMinor)),
        })),
        summary: {
          issuedValueMinor: serializeAmount(issuedValueMinor),
          issuedCount,
          draftCount,
        },
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "listCreditNotes");
  }
}

/**
 * Discard a credit-note DRAFT.
 *
 * 🔴 IT SETS `cancelled`; IT DOES NOT DELETE THE ROW. A deleted draft
 *    would be invisible to the numbering count, to the audit trail, and
 *    to anyone asking why a figure on a reconciliation moved. Rows that
 *    represent documents do not leave this database.
 *
 * ⚠️ IT REFUSES ON ANYTHING BUT A DRAFT, and the message says why rather
 * than saying "not allowed". An issued credit note is held by the
 * customer, who has already reversed input tax credit against it. The
 * correction for a wrong credit note is another document, not an eraser.
 *
 * ⚠️ GATED ON `sales.invoices.issue`, NOT `create`. Whoever can abandon
 * a document in flight is making a decision about a document, not
 * starting one — and `create` is the weaker of the two keys.
 */
export async function discardCreditNoteDraft(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = discardCreditNoteSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "invoices:issue",
      feature: FEATURE_ORDERS,
      permission: "sales.invoices.issue",
      resource: { type: "sales_credit_note", id: data.creditNoteId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [note] = await tx
          .select()
          .from(salesCreditNotes)
          .where(
            and(
              eq(salesCreditNotes.tenantId, ctx.tenant.id),
              eq(salesCreditNotes.id, data.creditNoteId),
            ),
          )
          .limit(1);

        if (!note) throw new Error("That credit note no longer exists.");
        if (note.status !== "draft") {
          throw new Error(
            `Credit note ${note.creditNoteNumber} has been issued. The customer holds it and has reversed input credit against it — it cannot be withdrawn, only corrected by a further document.`,
          );
        }

        await tx
          .update(salesCreditNotes)
          .set({
            status: "cancelled",
            cancelledAt: new Date(),
            cancelReason: "Draft discarded before issue.",
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(salesCreditNotes.tenantId, ctx.tenant.id),
              eq(salesCreditNotes.id, data.creditNoteId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "sales_credit_note",
          resourceId: data.creditNoteId,
          newValue: { status: "cancelled" },
          reason: "Draft discarded before issue.",
          severity: "info",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/credit-notes");
    revalidatePath("/invoices");
    return { ok: true, data: { id: data.creditNoteId } };
  } catch (err) {
    return toSalesActionError(err, "discardCreditNoteDraft");
  }
}
