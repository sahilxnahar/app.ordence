import "server-only";

/**
 * Ordence — ⭐ GSTR-2B Registry Reads
 * Version: v0.34.0-alpha
 *
 * The thin database layer under `server/actions/gstr2b.ts`. Every query
 * goes through `withTenant`, so row-level security is applied by the
 * database and not by a `WHERE tenant_id = …` somebody can forget.
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. Parsing, invoice-number
 * normalisation, the matching engine, the tolerance rules, the vendor
 * chase and the summary arithmetic all live in `lib/gstr2b/`, which has
 * no database import and is therefore testable without one. This file
 * loads rows and hands them over.
 *
 * ⚠️ AND THE SPLIT IS LOAD-BEARING HERE IN A WAY IT IS NOT ELSEWHERE. A
 * matching rule expressed as a SQL join and a matching rule expressed in
 * the engine WILL diverge, and the divergence is undetectable: the
 * workbench would show a candidate the engine did not pair, or pair one
 * the workbench cannot find. The engine is the only place a match is
 * decided.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  gstr2bDocuments,
  gstr2bMatches,
  gstr2bReconciliations,
  gstr2bRows,
  type Gstr2bDocument,
  type Gstr2bMatch,
  type Gstr2bReconciliation,
  type Gstr2bRow,
} from "@/db/schema/gstr2b";
import { purchaseInvoices, vendors } from "@/db/schema/purchases";
import { toBigIntAmount } from "@/lib/billing/money";
import type { BookInvoiceFacts, TwoBRowFacts } from "@/lib/gstr2b/matching";

/* ------------------------------------------------------------------ */
/* STATEMENTS                                                          */
/* ------------------------------------------------------------------ */

export async function listGstr2bDocuments(
  tenantId: string,
  filter?: { gstin?: string; returnPeriod?: string },
): Promise<Gstr2bDocument[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstr2bDocuments)
      .where(
        and(
          eq(gstr2bDocuments.tenantId, tenantId),
          filter?.gstin ? eq(gstr2bDocuments.gstin, filter.gstin) : undefined,
          filter?.returnPeriod
            ? eq(gstr2bDocuments.returnPeriod, filter.returnPeriod)
            : undefined,
        ),
      )
      .orderBy(desc(gstr2bDocuments.createdAt)),
  );
}

export async function findGstr2bDocument(
  tenantId: string,
  documentId: string,
): Promise<Gstr2bDocument | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstr2bDocuments)
      .where(
        and(eq(gstr2bDocuments.tenantId, tenantId), eq(gstr2bDocuments.id, documentId)),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * ⭐ The statement a reconciliation should be built from: the LATEST
 * successfully parsed one for that GSTIN and period.
 *
 * ⚠️ LATEST, NOT ONLY. The portal regenerates 2B whenever a supplier
 * files late, so one period legitimately has several statements and every
 * one of them is evidence. The reconciliation is built from the newest,
 * and `gstr2b_reconciliations.document_id` records WHICH — because "the
 * credit was not available when we filed" is a defensible position only
 * if we can name the statement that did not show it.
 */
export async function findLatestParsedStatement(
  tenantId: string,
  args: { gstin: string; returnPeriod: string },
): Promise<Gstr2bDocument | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstr2bDocuments)
      .where(
        and(
          eq(gstr2bDocuments.tenantId, tenantId),
          eq(gstr2bDocuments.gstin, args.gstin),
          eq(gstr2bDocuments.returnPeriod, args.returnPeriod),
          eq(gstr2bDocuments.parseStatus, "parsed"),
        ),
      )
      .orderBy(desc(gstr2bDocuments.createdAt))
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listGstr2bRows(
  tenantId: string,
  documentId: string,
): Promise<Gstr2bRow[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstr2bRows)
      .where(and(eq(gstr2bRows.tenantId, tenantId), eq(gstr2bRows.documentId, documentId)))
      .orderBy(asc(gstr2bRows.supplierGstin), asc(gstr2bRows.invoiceNumber)),
  );
}

/* ------------------------------------------------------------------ */
/* ⭐ FACTS FOR THE ENGINE                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `toBigIntAmount` ON EVERY MONEY COLUMN. Drizzle returns `bigint`
 * columns as strings on some driver paths and as bigints on others, and
 * a comparison of `"1800000"` against `1800000n` is false in every case —
 * so EVERY invoice would fall out as a mismatch, every supplier would
 * appear not to have filed, and the reconciliation would report the
 * entire month's credit at risk. Loud, at least; the quieter version is
 * a SUM over strings, which produces a number nine hundred thousand
 * times too large with a plausible shape. The same reasoning as Phase 11.
 */
export function toTwoBRowFacts(row: Gstr2bRow): TwoBRowFacts {
  return {
    id: row.id,
    section: row.section,
    supplierGstin: row.supplierGstin,
    supplierName: row.supplierTradeName ?? row.supplierLegalName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    taxableValueMinor: toBigIntAmount(row.taxableValueMinor),
    cgstMinor: toBigIntAmount(row.cgstMinor),
    sgstMinor: toBigIntAmount(row.sgstMinor),
    igstMinor: toBigIntAmount(row.igstMinor),
    cessMinor: toBigIntAmount(row.cessMinor),
    itcAvailable: row.itcAvailable,
    isAmendment: row.isAmendment,
    isCancelled: row.isCancelled,
    originalInvoiceNumber: row.originalInvoiceNumber,
    originalInvoiceDate: row.originalInvoiceDate,
  };
}

/**
 * ⭐ The purchase invoices a period's reconciliation is matched against.
 *
 * ⚠️ FILTERED ON `tax_period`, NOT ON `invoice_date`, AND THE DIFFERENCE
 * IS THE WHOLE POINT OF PHASE 33 HAVING THE COLUMN. A March invoice
 * received in May is CLAIMED in May, so it belongs to May's
 * reconciliation — and the 2B row for it will also appear in May, because
 * the supplier filed it late. Filtering on the invoice date would put the
 * bill in March's worklist and the supplier's declaration in May's, and
 * the same invoice would then be reported as unfiled in one month and
 * unrecorded in another.
 *
 * ⚠️ AND `cancelled` INVOICES ARE EXCLUDED. A bill entered wrongly,
 * cancelled and re-entered correctly would otherwise appear twice — the
 * cancelled copy having nothing in 2B to match, and therefore landing on
 * the chase list as a supplier who has not filed.
 */
export async function loadBookInvoicesForPeriod(
  tenantId: string,
  args: { gstin: string; taxPeriod: string },
): Promise<BookInvoiceFacts[]> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        id: purchaseInvoices.id,
        supplierGstin: purchaseInvoices.supplierGstin,
        invoiceNumber: purchaseInvoices.invoiceNumber,
        invoiceDate: purchaseInvoices.invoiceDate,
        taxableValueMinor: purchaseInvoices.taxableValueMinor,
        cgstMinor: purchaseInvoices.cgstMinor,
        sgstMinor: purchaseInvoices.sgstMinor,
        igstMinor: purchaseInvoices.igstMinor,
        cessMinor: purchaseInvoices.cessMinor,
        itcEligibleTaxMinor: purchaseInvoices.itcEligibleTaxMinor,
        vendorId: purchaseInvoices.vendorId,
        vendorName: vendors.legalName,
      })
      .from(purchaseInvoices)
      .leftJoin(
        vendors,
        and(
          eq(vendors.id, purchaseInvoices.vendorId),
          eq(vendors.tenantId, purchaseInvoices.tenantId),
        ),
      )
      .where(
        and(
          eq(purchaseInvoices.tenantId, tenantId),
          eq(purchaseInvoices.taxPeriod, args.taxPeriod),
          eq(purchaseInvoices.recipientGstin, args.gstin),
          sql`${purchaseInvoices.status} <> 'cancelled'`,
        ),
      )
      .orderBy(asc(purchaseInvoices.invoiceNumber)),
  );

  return rows.map((row) => ({
    id: row.id,
    supplierGstin: row.supplierGstin,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    taxableValueMinor: toBigIntAmount(row.taxableValueMinor),
    cgstMinor: toBigIntAmount(row.cgstMinor),
    sgstMinor: toBigIntAmount(row.sgstMinor),
    igstMinor: toBigIntAmount(row.igstMinor),
    cessMinor: toBigIntAmount(row.cessMinor),
    itcEligibleTaxMinor: toBigIntAmount(row.itcEligibleTaxMinor),
    vendorId: row.vendorId,
    vendorName: row.vendorName,
  }));
}

/* ------------------------------------------------------------------ */
/* RECONCILIATIONS AND MATCHES                                         */
/* ------------------------------------------------------------------ */

export async function findReconciliation(
  tenantId: string,
  args: { gstin: string; taxPeriod: string },
): Promise<Gstr2bReconciliation | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstr2bReconciliations)
      .where(
        and(
          eq(gstr2bReconciliations.tenantId, tenantId),
          eq(gstr2bReconciliations.gstin, args.gstin),
          eq(gstr2bReconciliations.taxPeriod, args.taxPeriod),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listReconciliations(
  tenantId: string,
): Promise<Gstr2bReconciliation[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstr2bReconciliations)
      .where(eq(gstr2bReconciliations.tenantId, tenantId))
      .orderBy(desc(gstr2bReconciliations.taxPeriod)),
  );
}

/**
 * The worklist.
 *
 * ⚠️ ORDERED BY `itc_at_risk_minor` DESCENDING WITHIN THE CATEGORY, not
 * by date or by supplier name. A worklist is read top-down and abandoned
 * part-way; whatever is at the bottom is what nobody looks at, so what is
 * at the bottom has to be what costs least to ignore.
 */
export async function listMatches(
  tenantId: string,
  reconciliationId: string,
  filter?: { category?: string; action?: string; limit?: number },
): Promise<Gstr2bMatch[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstr2bMatches)
      .where(
        and(
          eq(gstr2bMatches.tenantId, tenantId),
          eq(gstr2bMatches.reconciliationId, reconciliationId),
          filter?.category
            ? sql`${gstr2bMatches.matchCategory}::text = ${filter.category}`
            : undefined,
          filter?.action
            ? sql`${gstr2bMatches.action}::text = ${filter.action}`
            : undefined,
        ),
      )
      .orderBy(desc(gstr2bMatches.itcAtRiskMinor), asc(gstr2bMatches.id))
      .limit(filter?.limit ?? 500),
  );
}

export async function findMatch(
  tenantId: string,
  matchId: string,
): Promise<Gstr2bMatch | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstr2bMatches)
      .where(and(eq(gstr2bMatches.tenantId, tenantId), eq(gstr2bMatches.id, matchId)))
      .limit(1),
  );
  return rows[0] ?? null;
}
