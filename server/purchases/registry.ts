import "server-only";

/**
 * Ordence — Purchase Registry Reads
 * Version: v0.33.0-alpha
 *
 * The thin database layer under `server/actions/purchases.ts`. Every
 * query goes through `withTenant`, so row-level security is applied by
 * the database and not by a `WHERE tenant_id = …` somebody can forget.
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. Section 17(5), Rule 42, the MSME
 * clock and the ageing buckets all live in `lib/purchases/`, which has no
 * database import and is therefore testable without one. This file loads
 * rows and hands them over. The split is what stops a tax rule being
 * written twice — once in the engine and once, subtly differently, in a
 * SQL predicate.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  vendors,
  purchaseInvoices,
  purchaseInvoiceLines,
  itcRegister,
  vendorLedgerEntries,
  type Vendor,
  type PurchaseInvoice,
  type PurchaseInvoiceLine,
  type ItcRegisterEntry,
} from "@/db/schema/purchases";
import { toBigIntAmount } from "@/lib/billing/money";
import type { LedgerEntry } from "@/lib/purchases/vendor-ledger";
import type { RegisterMovement } from "@/lib/purchases/register";
import type { AttributedLine } from "@/lib/purchases/apportionment";

/* ------------------------------------------------------------------ */
/* VENDORS                                                             */
/* ------------------------------------------------------------------ */

export async function listVendors(
  tenantId: string,
  options?: { includeInactive?: boolean },
): Promise<Vendor[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(vendors)
      .where(
        options?.includeInactive
          ? eq(vendors.tenantId, tenantId)
          : and(eq(vendors.tenantId, tenantId), eq(vendors.isActive, true)),
      )
      .orderBy(asc(vendors.legalName)),
  );
}

export async function findVendor(
  tenantId: string,
  vendorId: string,
): Promise<Vendor | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.id, vendorId)))
      .limit(1),
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* PURCHASE INVOICES                                                   */
/* ------------------------------------------------------------------ */

export async function listPurchaseInvoices(
  tenantId: string,
  filter?: { vendorId?: string; taxPeriod?: string; projectId?: string },
): Promise<PurchaseInvoice[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(purchaseInvoices)
      .where(
        and(
          eq(purchaseInvoices.tenantId, tenantId),
          filter?.vendorId ? eq(purchaseInvoices.vendorId, filter.vendorId) : undefined,
          filter?.taxPeriod ? eq(purchaseInvoices.taxPeriod, filter.taxPeriod) : undefined,
          filter?.projectId ? eq(purchaseInvoices.projectId, filter.projectId) : undefined,
        ),
      )
      .orderBy(desc(purchaseInvoices.invoiceDate)),
  );
}

export async function findPurchaseInvoice(
  tenantId: string,
  invoiceId: string,
): Promise<{ invoice: PurchaseInvoice; lines: PurchaseInvoiceLine[] } | null> {
  return withTenant(tenantId, async (tx) => {
    const [invoice] = await tx
      .select()
      .from(purchaseInvoices)
      .where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, invoiceId)))
      .limit(1);

    if (!invoice) return null;

    const lines = await tx
      .select()
      .from(purchaseInvoiceLines)
      .where(
        and(
          eq(purchaseInvoiceLines.tenantId, tenantId),
          eq(purchaseInvoiceLines.purchaseInvoiceId, invoiceId),
        ),
      )
      .orderBy(asc(purchaseInvoiceLines.lineNumber));

    return { invoice, lines };
  });
}

/**
 * ⭐ Has this vendor's bill already been entered?
 *
 * ⚠️ THE UNIQUE INDEX IS THE GUARANTEE AND THIS IS THE COURTESY. The
 * index refuses the second entry whatever route it arrives by; this lets
 * the form say "this is already recorded as PI-0412, entered by Priya on
 * Tuesday" instead of surfacing a constraint violation after the user has
 * typed twelve lines.
 *
 * ⚠️ `upper(btrim(...))` MATCHES THE INDEX EXPRESSION EXACTLY. If the two
 * ever diverge, this lookup finds nothing and the insert is refused —
 * which is the safe direction, but produces an error the user cannot act
 * on because the product just told them there was no duplicate.
 */
export async function findDuplicateBill(
  tenantId: string,
  args: { vendorId: string; invoiceNumber: string; invoiceDate: string },
): Promise<PurchaseInvoice | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(purchaseInvoices)
      .where(
        and(
          eq(purchaseInvoices.tenantId, tenantId),
          eq(purchaseInvoices.vendorId, args.vendorId),
          sql`upper(btrim(${purchaseInvoices.invoiceNumber})) = upper(btrim(${args.invoiceNumber}))`,
          sql`indian_financial_year(${purchaseInvoices.invoiceDate})
              = indian_financial_year(${args.invoiceDate}::date)`,
          sql`${purchaseInvoices.status} <> 'cancelled'`,
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* THE ITC REGISTER                                                    */
/* ------------------------------------------------------------------ */

export async function listItcMovements(
  tenantId: string,
  filter?: { taxPeriod?: string; registrationId?: string; invoiceId?: string },
): Promise<ItcRegisterEntry[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(itcRegister)
      .where(
        and(
          eq(itcRegister.tenantId, tenantId),
          filter?.taxPeriod ? eq(itcRegister.taxPeriod, filter.taxPeriod) : undefined,
          filter?.registrationId
            ? eq(itcRegister.registrationId, filter.registrationId)
            : undefined,
          filter?.invoiceId
            ? eq(itcRegister.purchaseInvoiceId, filter.invoiceId)
            : undefined,
        ),
      )
      .orderBy(asc(itcRegister.taxPeriod), asc(itcRegister.createdAt)),
  );
}

/**
 * ⚠️ `toBigIntAmount` ON EVERY MONEY COLUMN. Drizzle returns `bigint`
 * columns as strings on some driver paths and as bigints on others, and a
 * summary that adds `"900000" + "900000"` produces `"900000900000"` — a
 * figure nine hundred thousand times too large, with no error and a
 * plausible shape. The same reasoning as Phase 11.
 */
export function toRegisterMovement(row: ItcRegisterEntry): RegisterMovement {
  return {
    taxPeriod: row.taxPeriod,
    status: row.status,
    reason: row.reason,
    cgstMinor: toBigIntAmount(row.cgstMinor),
    sgstMinor: toBigIntAmount(row.sgstMinor),
    igstMinor: toBigIntAmount(row.igstMinor),
    cessMinor: toBigIntAmount(row.cessMinor),
  };
}

/**
 * ⭐ Every line of every purchase in a tax period, bucketed for Rule 42.
 *
 * ⚠️ THE PERIOD IS `purchase_invoices.tax_period`, NOT THE INVOICE DATE.
 * A March bill received in May is claimed in May and belongs to May's
 * apportionment. Selecting on the invoice date would apportion it against
 * March's turnover — a month whose return was filed six weeks ago.
 */
export async function loadPeriodLinesForRule42(
  tenantId: string,
  taxPeriod: string,
  registrationId?: string | null,
): Promise<AttributedLine[]> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        rule42Attribution: purchaseInvoiceLines.rule42Attribution,
        isCapitalGoods: purchaseInvoiceLines.isCapitalGoods,
        cgstMinor: purchaseInvoiceLines.cgstMinor,
        sgstMinor: purchaseInvoiceLines.sgstMinor,
        igstMinor: purchaseInvoiceLines.igstMinor,
        cessMinor: purchaseInvoiceLines.cessMinor,
      })
      .from(purchaseInvoiceLines)
      .innerJoin(
        purchaseInvoices,
        and(
          eq(purchaseInvoices.id, purchaseInvoiceLines.purchaseInvoiceId),
          eq(purchaseInvoices.tenantId, purchaseInvoiceLines.tenantId),
        ),
      )
      .where(
        and(
          eq(purchaseInvoiceLines.tenantId, tenantId),
          eq(purchaseInvoices.taxPeriod, taxPeriod),
          // ⚠️ Cancelled bills are excluded. A cancelled document stays in
          // the table because it may already have fed a return, and
          // including it in a later apportionment would reverse credit
          // that was never availed.
          sql`${purchaseInvoices.status} <> 'cancelled'`,
          registrationId
            ? eq(purchaseInvoices.recipientRegistrationId, registrationId)
            : undefined,
        ),
      ),
  );

  return rows.map((row) => ({
    rule42Attribution: row.rule42Attribution,
    isCapitalGoods: row.isCapitalGoods,
    heads: {
      cgstMinor: toBigIntAmount(row.cgstMinor),
      sgstMinor: toBigIntAmount(row.sgstMinor),
      igstMinor: toBigIntAmount(row.igstMinor),
      cessMinor: toBigIntAmount(row.cessMinor),
    },
  }));
}

/* ------------------------------------------------------------------ */
/* THE VENDOR LEDGER                                                   */
/* ------------------------------------------------------------------ */

export async function loadVendorLedger(
  tenantId: string,
  vendorId?: string | null,
): Promise<LedgerEntry[]> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(vendorLedgerEntries)
      .where(
        and(
          eq(vendorLedgerEntries.tenantId, tenantId),
          vendorId ? eq(vendorLedgerEntries.vendorId, vendorId) : undefined,
        ),
      )
      // ⚠️ The tie-break on `id` matches `runningBalance()` in
      // `lib/purchases/vendor-ledger.ts` exactly. A bill and the TDS
      // withheld on it share a date constantly; without a deterministic
      // second key the balance column differs between two renders of the
      // same data, and a vendor comparing our statement with theirs sees
      // two different documents from us.
      .orderBy(asc(vendorLedgerEntries.entryDate), asc(vendorLedgerEntries.id)),
  );

  return rows.map((row) => ({
    id: row.id,
    entryDate: row.entryDate,
    entryType: row.entryType,
    description: row.description,
    referenceNumber: row.referenceNumber,
    purchaseInvoiceId: row.purchaseInvoiceId,
    debitMinor: toBigIntAmount(row.debitMinor),
    creditMinor: toBigIntAmount(row.creditMinor),
    dueDate: row.dueDate,
    excludeFromAgeing: row.excludeFromAgeing,
  }));
}

/**
 * Outstanding balance per vendor, in one query.
 *
 * ⚠️ COMPUTED, NEVER READ FROM A STORED COLUMN. There is no
 * `vendors.balance_minor` and there must not be: the first backdated bill
 * — and on a construction site the contractor's March invoice arrives in
 * May, every month — makes every stored balance after that date wrong,
 * with no error and no screen that looks different.
 *
 * ⚠️ BATCH 0104 — THE SUM IS SINGLE-CURRENCY BY CONSTRUCTION AND RETURNS
 * NO LABEL. `vendor_ledger_entries` has no `currency` column, so this
 * `sum(credit_minor - debit_minor)` cannot be adding two currencies
 * together — unlike the analytics views, there is nothing to group by.
 *
 * 🔴 IT IS STILL A BARE `bigint` AND THAT IS DELIBERATE AT THIS LAYER. A
 * registry function has no tenant settings to read, so the functional
 * currency is not knowable here without a second query. The label is
 * applied one layer up, in `server/actions/purchases.ts#getVendorBalances`,
 * where `ctx.tenant.settings` is already in hand — and it is applied with
 * `currencyAssumed: true`, because it is an assumption the schema forces
 * rather than a fact any row carries.
 */
export async function vendorBalances(
  tenantId: string,
): Promise<{ vendorId: string; legalName: string; balanceMinor: bigint }[]> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        vendorId: vendors.id,
        legalName: vendors.legalName,
        balance: sql<string>`COALESCE(sum(${vendorLedgerEntries.creditMinor}
                                        - ${vendorLedgerEntries.debitMinor}), 0)`,
      })
      .from(vendors)
      .leftJoin(
        vendorLedgerEntries,
        and(
          eq(vendorLedgerEntries.vendorId, vendors.id),
          eq(vendorLedgerEntries.tenantId, vendors.tenantId),
        ),
      )
      .where(eq(vendors.tenantId, tenantId))
      .groupBy(vendors.id, vendors.legalName)
      .orderBy(asc(vendors.legalName)),
  );

  return rows.map((row) => ({
    vendorId: row.vendorId,
    legalName: row.legalName,
    balanceMinor: toBigIntAmount(row.balance),
  }));
}
