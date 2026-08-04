/**
 * Ordence — ⭐ Vendor Chase: who has not filed, and what it costs
 * Version: v0.34.0-alpha
 *
 * Pure. `bigint` paise, no database, no clock — `asOf` is passed in.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS IS A SEPARATE VIEW AND NOT A FILTER ON THE WORKLIST
 * ══════════════════════════════════════════════════════════════════════
 * The mismatch workbench answers "what do I do about this invoice". This
 * answers a different question, asked by a different person:
 *
 *     "Which suppliers have not filed, how much of OUR money is sitting
 *      behind them, and how long has it been sitting there?"
 *
 * That is a purchasing conversation, not an accounting one. It is held
 * with the person who signs the next purchase order, and its unit is the
 * VENDOR, not the invoice. A worklist sorted by invoice cannot show that
 * one contractor accounts for 60% of the exposure — which is the fact
 * that changes behaviour, because it converts "chase everybody" into "do
 * not release next month's running account bill until July is filed".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE AGEING IS FROM THE INVOICE DATE, NOT FROM THE IMPORT DATE
 * ══════════════════════════════════════════════════════════════════════
 * The clock that matters is Section 16(4): credit for an invoice may not
 * be taken after 30 November following the end of the financial year in
 * which THE INVOICE was issued. It runs from the supplier's document,
 * not from when we noticed. Ageing from the reconciliation date would
 * reset every invoice to zero on the day it was first imported and hide
 * exactly the old exposure that is about to expire.
 *
 * ⚠️ AND THE DEADLINE IS A CLIFF, NOT A TAPER. One month late is not a
 * reduced credit; it is no credit, permanently. The invoices most likely
 * to be late are the large ones, because a large bill is the one that
 * sits in a dispute for eight months.
 */

import { itcClaimDeadlinePeriod } from "@/lib/purchases/register";
import { daysBetween } from "@/lib/purchases/vendor-ledger";
import type { BookInvoiceFacts, MatchResult } from "./matching";

/**
 * ⚠️ THE SAME BUCKET BOUNDARIES AS THE VENDOR AGEING IN PHASE 33
 * (`AGEING_BUCKET_DAYS`), and deliberately so. A payables ageing that
 * says "90+" and a credit-at-risk ageing that says "over 3 months" are
 * the same conversation with the same vendor, and two vocabularies for
 * one thing is how the two reports stop being comparable.
 */
export const CHASE_BUCKET_DAYS: readonly number[] = Object.freeze([30, 60, 90, 180]);

export type ChaseBucket = {
  label: string;
  fromDays: number;
  toDays: number | null;
  invoiceCount: number;
  itcAtRiskMinor: bigint;
};

export type ChaseInvoice = {
  purchaseInvoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  ageDays: number;
  itcAtRiskMinor: bigint;
  /** ⭐ `YYYY-MM`: the last period this credit may still be claimed in. */
  claimDeadlinePeriod: string;
  /** True once `asOf` is past the deadline. The credit is gone. */
  deadlinePassed: boolean;
};

export type VendorChaseRow = {
  supplierGstin: string | null;
  vendorId: string | null;
  vendorName: string | null;

  invoiceCount: number;
  taxableMinor: bigint;
  /** ⭐ Eligible credit held up by this supplier's failure to file. */
  itcAtRiskMinor: bigint;
  /** The subset already past its Section 16(4) deadline. Unrecoverable. */
  itcLostMinor: bigint;

  oldestInvoiceDate: string;
  newestInvoiceDate: string;
  oldestAgeDays: number;

  buckets: ChaseBucket[];
  invoices: ChaseInvoice[];
};

function emptyBuckets(): ChaseBucket[] {
  const buckets: ChaseBucket[] = [];
  let from = 0;
  for (const boundary of CHASE_BUCKET_DAYS) {
    buckets.push({
      label: `${from}-${boundary} days`,
      fromDays: from,
      toDays: boundary,
      invoiceCount: 0,
      itcAtRiskMinor: 0n,
    });
    from = boundary + 1;
  }
  buckets.push({
    label: `${from}+ days`,
    fromDays: from,
    toDays: null,
    invoiceCount: 0,
    itcAtRiskMinor: 0n,
  });
  return buckets;
}

/**
 * ⭐ Who has not filed, and what it costs.
 *
 * ⚠️ ONLY `in_books_not_in_2b` AND `cancelled` FEED THIS LIST, AND THE
 * OMISSIONS ARE THE DESIGN.
 *
 *   • `in_2b_not_in_books` is a supplier who DID file. There is nothing
 *     to chase them for; the work is ours, to find the bill.
 *   • `probable` and `number_mismatch` are documents the supplier filed.
 *     A value difference is worth a letter, but it is not credit held up
 *     by a non-filer, and mixing it in inflates the headline number by
 *     invoices that are already in 2B.
 *   • `cancelled` IS here, because a supplier who filed and then
 *     withdrew the document has put the credit exactly as far out of
 *     reach as one who never filed — and unlike a non-filer, we may
 *     already have claimed it.
 */
export function chaseVendors(args: {
  matches: readonly MatchResult[];
  bookInvoices: readonly BookInvoiceFacts[];
  /** `YYYY-MM-DD`. Passed in — this module has no clock. */
  asOf: string;
}): VendorChaseRow[] {
  const bookById = new Map(args.bookInvoices.map((b) => [b.id, b]));
  const period = args.asOf.slice(0, 7);
  const byVendor = new Map<string, VendorChaseRow>();

  for (const match of args.matches) {
    if (match.category !== "in_books_not_in_2b" && match.category !== "cancelled") {
      continue;
    }
    if (!match.bookInvoiceId) continue;
    const invoice = bookById.get(match.bookInvoiceId);
    if (!invoice) continue;

    // ⚠️ KEYED ON GSTIN FIRST, VENDOR SECOND. A supplier who
    // re-registers has two `vendors` rows over time but one continuing
    // GSTIN on the documents in this period, and the portal knows them
    // only by the GSTIN. Grouping by our own vendor id would split one
    // conversation into two.
    const key = invoice.supplierGstin ?? `vendor:${invoice.vendorId ?? "unknown"}`;

    let row = byVendor.get(key);
    if (!row) {
      row = {
        supplierGstin: invoice.supplierGstin ?? null,
        vendorId: invoice.vendorId ?? null,
        vendorName: invoice.vendorName ?? null,
        invoiceCount: 0,
        taxableMinor: 0n,
        itcAtRiskMinor: 0n,
        itcLostMinor: 0n,
        oldestInvoiceDate: invoice.invoiceDate,
        newestInvoiceDate: invoice.invoiceDate,
        oldestAgeDays: 0,
        buckets: emptyBuckets(),
        invoices: [],
      };
      byVendor.set(key, row);
    }

    const ageDays = Math.max(0, daysBetween(invoice.invoiceDate, args.asOf));
    const deadline = itcClaimDeadlinePeriod(invoice.invoiceDate);
    const deadlinePassed = period > deadline;

    row.invoiceCount += 1;
    row.taxableMinor += invoice.taxableValueMinor;
    row.itcAtRiskMinor += match.itcAtRiskMinor;
    if (deadlinePassed) row.itcLostMinor += match.itcAtRiskMinor;

    if (invoice.invoiceDate < row.oldestInvoiceDate) {
      row.oldestInvoiceDate = invoice.invoiceDate;
    }
    if (invoice.invoiceDate > row.newestInvoiceDate) {
      row.newestInvoiceDate = invoice.invoiceDate;
    }
    row.oldestAgeDays = Math.max(row.oldestAgeDays, ageDays);

    const bucket =
      row.buckets.find((b) => b.toDays !== null && ageDays <= b.toDays) ??
      row.buckets[row.buckets.length - 1]!;
    bucket.invoiceCount += 1;
    bucket.itcAtRiskMinor += match.itcAtRiskMinor;

    row.invoices.push({
      purchaseInvoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      ageDays,
      itcAtRiskMinor: match.itcAtRiskMinor,
      claimDeadlinePeriod: deadline,
      deadlinePassed,
    });
  }

  for (const row of byVendor.values()) {
    // Oldest first inside a vendor: the invoice nearest its cliff is the
    // one the letter has to name.
    row.invoices.sort((a, b) =>
      a.invoiceDate < b.invoiceDate
        ? -1
        : a.invoiceDate > b.invoiceDate
          ? 1
          : a.purchaseInvoiceId < b.purchaseInvoiceId
            ? -1
            : 1,
    );
  }

  // ⭐ Most exposure first — that is the order the calls get made in.
  // Ties broken on the GSTIN so the list is stable between runs.
  return [...byVendor.values()].sort((a, b) => {
    if (a.itcAtRiskMinor !== b.itcAtRiskMinor) {
      return a.itcAtRiskMinor > b.itcAtRiskMinor ? -1 : 1;
    }
    const left = a.supplierGstin ?? "";
    const right = b.supplierGstin ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Total exposure across every vendor. The headline on the chase screen. */
export function totalItcAtRisk(rows: readonly VendorChaseRow[]): bigint {
  let total = 0n;
  for (const row of rows) total += row.itcAtRiskMinor;
  return total;
}

/** ⭐ The part already past its Section 16(4) cliff. Not recoverable. */
export function totalItcLost(rows: readonly VendorChaseRow[]): bigint {
  let total = 0n;
  for (const row of rows) total += row.itcLostMinor;
  return total;
}
