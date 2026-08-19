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

import { and, desc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import {
  salesInvoices,
  salesInvoiceLines,
  customerReceipts,
  salesCreditNotes,
  salesCreditNoteLines,
} from "@/db/schema/sales-invoices";
import { salesOrders, salesOrderLines } from "@/db/schema/orders";
import { companies } from "@/db/schema/crm";
import { gstParties } from "@/db/schema/gst";
import { toBigIntAmount } from "@/lib/billing/money";
import { financialYearOf } from "@/lib/gst/constants";
import { formatInvoiceNumber, type OrderLineFacts } from "@/lib/invoicing/build";
import type {
  CustomerLedgerEntry,
  OpenDocument,
} from "@/lib/receivables/customer-ledger";
import type { Gstr1Document } from "@/lib/gstr1/build";
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

/* ------------------------------------------------------------------ */
/* ⭐ THE CUSTOMER LEDGER — Phase 51                                    */
/* ------------------------------------------------------------------ */

/**
 * Every document on a customer's account, as ledger entries.
 *
 * ⚠️ CANCELLED AND DRAFT INVOICES ARE EXCLUDED. A draft is a working
 * paper the customer has never seen, and a cancelled invoice is one that
 * was withdrawn — putting either on a statement means sending a customer
 * a document they cannot reconcile against anything they hold.
 *
 * ⚠️ AND TDS IS ITS OWN LINE, NOT PART OF THE RECEIPT. A customer who
 * withheld ₹10,000 of tax wants to see that ₹10,000 named on the
 * statement — it is the figure they will match against their own Form
 * 26AS. Folding it into the receipt amount makes the two documents
 * disagree by exactly the tax.
 */
export async function loadCustomerLedger(tx: Tx, tenantId: string, companyId: string) {
  const invoices = await tx
    .select({
      id: salesInvoices.id,
      reference: salesInvoices.invoiceNumber,
      entryDate: salesInvoices.invoiceDate,
      dueDate: salesInvoices.dueDate,
      totalMinor: salesInvoices.totalMinor,
      receivedMinor: salesInvoices.receivedMinor,
      status: salesInvoices.status,
    })
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.tenantId, tenantId),
        eq(salesInvoices.companyId, companyId),
        notInArray(salesInvoices.status, ["draft", "cancelled"]),
      ),
    );

  const receipts = await tx
    .select({
      id: customerReceipts.id,
      reference: customerReceipts.receiptNumber,
      entryDate: customerReceipts.receivedOn,
      amountMinor: customerReceipts.amountMinor,
      tdsCreditMinor: customerReceipts.tdsCreditMinor,
      allocatedMinor: customerReceipts.allocatedMinor,
      status: customerReceipts.status,
    })
    .from(customerReceipts)
    .where(
      and(
        eq(customerReceipts.tenantId, tenantId),
        eq(customerReceipts.companyId, companyId),
        notInArray(customerReceipts.status, ["bounced", "cancelled"]),
      ),
    );

  const entries: CustomerLedgerEntry[] = [
    ...invoices.map((i) => ({
      id: i.id,
      entryDate: String(i.entryDate),
      entryType: "invoice" as const,
      reference: i.reference,
      dueDate: i.dueDate ? String(i.dueDate) : null,
      debitMinor: toBigIntAmount(i.totalMinor),
      creditMinor: 0n,
    })),
    ...receipts.flatMap((r) => {
      const rows: CustomerLedgerEntry[] = [
        {
          id: r.id,
          entryDate: String(r.entryDate),
          entryType: "receipt" as const,
          reference: r.reference,
          debitMinor: 0n,
          creditMinor: toBigIntAmount(r.amountMinor),
        },
      ];
      const tds = toBigIntAmount(r.tdsCreditMinor);
      if (tds > 0n) {
        rows.push({
          id: `${r.id}-tds`,
          entryDate: String(r.entryDate),
          entryType: "tds_withheld" as const,
          reference: `${r.reference} · TDS`,
          debitMinor: 0n,
          creditMinor: tds,
        });
      }
      return rows;
    }),
  ];

  const openDocuments: OpenDocument[] = invoices
    .map((i) => ({
      id: i.id,
      reference: i.reference,
      documentDate: String(i.entryDate),
      dueDate: i.dueDate ? String(i.dueDate) : null,
      outstandingMinor: toBigIntAmount(i.totalMinor) - toBigIntAmount(i.receivedMinor),
    }))
    .filter((d) => d.outstandingMinor > 0n);

  /**
   * ⭐ Money on the account with no invoice to answer. Cash plus withheld
   * tax is a receipt's total settling power, so unapplied is measured
   * against both — not against the cash alone.
   */
  const unappliedCreditMinor = receipts.reduce((sum, r) => {
    const power = toBigIntAmount(r.amountMinor) + toBigIntAmount(r.tdsCreditMinor);
    const spare = power - toBigIntAmount(r.allocatedMinor);
    return spare > 0n ? sum + spare : sum;
  }, 0n);

  return { entries, openDocuments, unappliedCreditMinor };
}

/* ------------------------------------------------------------------ */
/* ⭐ GSTR-1 — Phase 53                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every outward document issued in a period.
 *
 * ⚠️ THE FILTER IS ON `issued_at`, NOT ON `invoice_date`, AND THE
 *    DIFFERENCE IS A LATE FILING.
 *
 * A document dated 30 April and issued on 3 May belongs to the return for
 * the month it was ISSUED — you cannot report a document that did not
 * exist when the period closed, and back-dating one into a filed period
 * means amending a return that has already been transmitted.
 *
 * ⚠️ AND DRAFTS AND CANCELLED DOCUMENTS ARE EXCLUDED. A draft was never
 * issued; a cancelled one was withdrawn. Either in a return is a supply
 * the Government believes happened.
 */
export async function loadGstr1Documents(
  tx: Tx,
  tenantId: string,
  fromInclusive: string,
  toExclusive: string,
): Promise<Gstr1Document[]> {
  const invoices = await tx
    .select()
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.tenantId, tenantId),
        notInArray(salesInvoices.status, ["draft", "cancelled"]),
        gte(salesInvoices.issuedAt, new Date(`${fromInclusive}T00:00:00Z`)),
        lt(salesInvoices.issuedAt, new Date(`${toExclusive}T00:00:00Z`)),
      ),
    );

  const invoiceIds = invoices.map((i) => i.id);
  const lines = invoiceIds.length
    ? await tx
        .select()
        .from(salesInvoiceLines)
        .where(
          and(
            eq(salesInvoiceLines.tenantId, tenantId),
            inArray(salesInvoiceLines.invoiceId, invoiceIds),
          ),
        )
    : [];

  const linesByInvoice = new Map<string, typeof lines>();
  for (const l of lines) {
    const list = linesByInvoice.get(l.invoiceId) ?? [];
    list.push(l);
    linesByInvoice.set(l.invoiceId, list);
  }

  const notes = await tx
    .select()
    .from(salesCreditNotes)
    .where(
      and(
        eq(salesCreditNotes.tenantId, tenantId),
        notInArray(salesCreditNotes.status, ["draft", "cancelled"]),
        gte(salesCreditNotes.issuedAt, new Date(`${fromInclusive}T00:00:00Z`)),
        lt(salesCreditNotes.issuedAt, new Date(`${toExclusive}T00:00:00Z`)),
      ),
    );

  const noteIds = notes.map((n) => n.id);
  const noteLines = noteIds.length
    ? await tx
        .select()
        .from(salesCreditNoteLines)
        .where(
          and(
            eq(salesCreditNoteLines.tenantId, tenantId),
            inArray(salesCreditNoteLines.creditNoteId, noteIds),
          ),
        )
    : [];

  const noteLinesByNote = new Map<string, typeof noteLines>();
  for (const l of noteLines) {
    const list = noteLinesByNote.get(l.creditNoteId) ?? [];
    list.push(l);
    noteLinesByNote.set(l.creditNoteId, list);
  }

  /** The invoice a credit note reduces, so CDNR can name it. */
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));

  const docs: Gstr1Document[] = [
    ...invoices.map((i) => ({
      id: i.id,
      number: i.invoiceNumber,
      date: String(i.invoiceDate),
      kind: "invoice" as const,
      customerGstin: i.customerGstin,
      customerName: i.customerLegalName,
      placeOfSupplyCode: i.placeOfSupplyCode,
      isInterState: i.isInterState,
      isReverseCharge: i.isReverseCharge,
      taxableValueMinor: toBigIntAmount(i.taxableValueMinor),
      cgstMinor: toBigIntAmount(i.cgstMinor),
      sgstMinor: toBigIntAmount(i.sgstMinor),
      igstMinor: toBigIntAmount(i.igstMinor),
      cessMinor: toBigIntAmount(i.cessMinor),
      totalMinor: toBigIntAmount(i.totalMinor),
      lines: (linesByInvoice.get(i.id) ?? []).map((l) => ({
        hsnSacCode: l.hsnSacCode,
        description: l.description,
        uom: l.uom,
        quantity: String(l.quantity),
        taxRateBps: l.taxRateBps ?? 0,
        taxableValueMinor: toBigIntAmount(l.taxableValueMinor),
        cgstMinor: toBigIntAmount(l.cgstMinor),
        sgstMinor: toBigIntAmount(l.sgstMinor),
        igstMinor: toBigIntAmount(l.igstMinor),
        cessMinor: toBigIntAmount(l.cessMinor),
      })),
    })),
    ...notes.map((n) => {
      const parent = invoiceById.get(n.invoiceId);
      return {
        id: n.id,
        number: n.creditNoteNumber,
        date: String(n.noteDate),
        kind: "credit_note" as const,
        customerGstin: n.customerGstin,
        customerName: n.customerLegalName,
        placeOfSupplyCode: n.placeOfSupplyCode,
        isInterState: n.isInterState,
        isReverseCharge: false,
        taxableValueMinor: toBigIntAmount(n.taxableValueMinor),
        cgstMinor: toBigIntAmount(n.cgstMinor),
        sgstMinor: toBigIntAmount(n.sgstMinor),
        igstMinor: toBigIntAmount(n.igstMinor),
        cessMinor: toBigIntAmount(n.cessMinor),
        totalMinor: toBigIntAmount(n.totalMinor),
        againstInvoiceNumber: parent?.invoiceNumber ?? null,
        againstInvoiceDate: parent ? String(parent.invoiceDate) : null,
        lines: (noteLinesByNote.get(n.id) ?? []).map((l) => ({
          hsnSacCode: l.hsnSacCode,
          description: l.description,
          uom: l.uom,
          quantity: String(l.quantity),
          taxRateBps: l.taxRateBps ?? 0,
          taxableValueMinor: toBigIntAmount(l.taxableValueMinor),
          cgstMinor: toBigIntAmount(l.cgstMinor),
          sgstMinor: toBigIntAmount(l.sgstMinor),
          igstMinor: toBigIntAmount(l.igstMinor),
          cessMinor: toBigIntAmount(l.cessMinor),
        })),
      };
    }),
  ];

  return docs;
}
