import "server-only";

/**
 * Ordence — Invoice document reads (internal)
 * Version: v0.90.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NOT IN `server/actions/`
 * ══════════════════════════════════════════════════════════════════════
 * Every function here takes a `tenantId` and an open transaction. In a
 * `"use server"` file that is the v005 bug exactly: an export that
 * accepts the tenant to operate on is the single route past row-level
 * security. `import "server-only"` makes the module unreachable from a
 * browser, and `check:boundaries` enforces the declaration.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { salesInvoices } from "@/db/schema/sales-invoices";
import { salesOrders, salesOrderLines } from "@/db/schema/orders";
import { companies } from "@/db/schema/crm";
import { gstParties } from "@/db/schema/gst";
import { toBigIntAmount } from "@/lib/billing/money";
import { financialYearOf } from "@/lib/gst/constants";
import { formatInvoiceNumber, type OrderLineFacts } from "@/lib/invoicing/build";
import type { withTenant } from "@/db";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⭐ THE NEXT NUMBER IN THE SERIES, DERIVED INSIDE THE CALLER'S
 *    TRANSACTION AND NEVER ACCEPTED FROM A FORM.
 *
 * ⚠️ THIS FUNCTION IS NOT THE GUARANTEE. The unique index
 * `sales_invoices_number_tenant_key` is. Two concurrent issues can read
 * the same maximum; one of them then fails the insert, and the action
 * turns that into a retry rather than a duplicate document. A caller who
 * could choose the number could collide with a document already sitting
 * in a customer's file.
 *
 * ⚠️ AND THE SERIES RESTARTS EACH FINANCIAL YEAR, because Rule 46(b)
 * requires a serial unique *for a financial year* — not for all time.
 */
export async function nextInvoiceNumber(
  tx: Tx,
  tenantId: string,
  invoiceDate: string,
  prefix?: string,
): Promise<{ invoiceNumber: string; financialYear: string }> {
  const financialYear = financialYearOf(invoiceDate);

  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.tenantId, tenantId),
        eq(salesInvoices.financialYear, financialYear),
      ),
    );

  return {
    invoiceNumber: formatInvoiceNumber({
      prefix,
      financialYear,
      sequence: (row?.count ?? 0) + 1,
    }),
    financialYear,
  };
}

/**
 * The order and its lines, in the shape `lib/invoicing/build.ts` needs.
 *
 * ⚠️ MONEY IS NORMALISED WITH `toBigIntAmount`, QUANTITY IS LEFT AS A
 * STRING. Drizzle returns `mode: "bigint"` columns as strings on the
 * HTTP driver path and bigints on the WebSocket one; quantity is
 * `numeric` and must never become a number at all.
 */
export async function loadOrderForInvoicing(
  tx: Tx,
  tenantId: string,
  orderId: string,
): Promise<{
  order: typeof salesOrders.$inferSelect;
  lines: OrderLineFacts[];
  companyName: string | null;
} | null> {
  const [order] = await tx
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.tenantId, tenantId), eq(salesOrders.id, orderId)))
    .limit(1);

  if (!order) return null;

  const rows = await tx
    .select()
    .from(salesOrderLines)
    .where(and(eq(salesOrderLines.tenantId, tenantId), eq(salesOrderLines.orderId, orderId)))
    .orderBy(salesOrderLines.lineNo);

  const lines: OrderLineFacts[] = rows.map((l) => ({
    id: l.id,
    lineNo: l.lineNo,
    description: l.description,
    sku: l.sku,
    assetId: l.assetId,
    hsnSacCodeId: l.hsnSacCodeId,
    hsnSacRateId: l.hsnSacRateId,
    hsnSacCode: null,
    taxRateBps: l.taxRateBps,
    cessRateBps: l.cessRateBps,
    uom: l.uom,
    quantity: String(l.quantity),
    qtyInvoiced: String(l.qtyInvoiced),
    qtyCancelled: String(l.qtyCancelled),
    unitPriceMinor: toBigIntAmount(l.unitPriceMinor),
    discountMinor: toBigIntAmount(l.discountMinor),
  }));

  let companyName: string | null = null;
  if (order.companyId) {
    const [c] = await tx
      .select({ name: companies.name })
      .from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, order.companyId)))
      .limit(1);
    companyName = c?.name ?? null;
  }

  return { order, lines, companyName };
}

/**
 * The counterparty's tax identity **as it stands now**, to be frozen onto
 * the document.
 *
 * ⚠️ CAPTURED AT ISSUE, NEVER JOINED AT READ TIME — Rule 46(d)–(f). A
 * customer who re-registers or changes their legal name next year must
 * not restate the document we gave them this year. The billing invoices
 * already follow this rule; so does `purchase_invoices`.
 */
export async function captureCustomerIdentity(
  tx: Tx,
  tenantId: string,
  gstPartyId: string | null,
): Promise<{ legalName: string | null; gstin: string | null; stateCode: string | null }> {
  if (!gstPartyId) return { legalName: null, gstin: null, stateCode: null };

  const [party] = await tx
    .select({
      legalName: gstParties.legalName,
      gstin: gstParties.gstin,
      stateCode: gstParties.stateCode,
    })
    .from(gstParties)
    .where(and(eq(gstParties.tenantId, tenantId), eq(gstParties.id, gstPartyId)))
    .limit(1);

  return {
    legalName: party?.legalName ?? null,
    gstin: party?.gstin ?? null,
    stateCode: party?.stateCode ?? null,
  };
}

/** Most recent invoices for a company — the customer ledger's spine. */
export async function loadCompanyInvoices(tx: Tx, tenantId: string, companyId: string) {
  return tx
    .select({
      id: salesInvoices.id,
      invoiceNumber: salesInvoices.invoiceNumber,
      invoiceDate: salesInvoices.invoiceDate,
      dueDate: salesInvoices.dueDate,
      status: salesInvoices.status,
      totalMinor: salesInvoices.totalMinor,
      receivedMinor: salesInvoices.receivedMinor,
    })
    .from(salesInvoices)
    .where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.companyId, companyId)))
    .orderBy(desc(salesInvoices.invoiceDate));
}
