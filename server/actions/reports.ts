"use server";

/**
 * Ordence — Reports Server Actions
 * Version: v0.82.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION.
 *
 * Predefined report executors that aggregate tenant data into structured
 * summaries. Each report runs inside `withTenant()` under RLS.
 */

import { and, eq, desc, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  complianceTasks,
  complianceObligations,
  demandNotices,
  receipts,
  tdsDeductions,
  tdsChallans,
  stockBalances,
  stockItems,
  projects,
  invoices,
  invoiceLines,
  itcRegister,
} from "@/db/schema";
import { requireTenantContext } from "@/server/tenant-context";
import { functionalCurrencyFromSettings, formatMinorPlain } from "@/lib/fx/currency";
import { sumByCurrency } from "@/lib/fx/aggregate";

type ReportResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ BATCH 0101 — EVERY TOTAL BELOW CARRIES A CURRENCY
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS WRONG. Every figure this file produced was a bare
 * `coalesce(sum(...), 0)::text` with no currency anywhere near it. Two
 * distinct faults were hiding in that, and they need different fixes:
 *
 *   ① A SUM OVER A TABLE THAT HAS A `currency` COLUMN. `getGstSummary`
 *      summed `billing.invoices`, which carries one. Dollars and rupees
 *      were added together. FIXED BELOW by grouping.
 *
 *   ② A SUM OVER A TABLE WITH NO `currency` COLUMN — `demand_notices`,
 *      `receipts`, `tds_deductions`, `itc_register`, `tds_challans`.
 *      These are single-currency BY CONSTRUCTION and the arithmetic was
 *      never wrong. What was wrong is that the number reached a screen
 *      with nothing saying what it was a quantity of. FIXED BELOW by
 *      labelling with the workspace's functional currency and saying, on
 *      the payload, that the label is an assumption the schema forces
 *      rather than a fact the row carries.
 *
 * ⚠️ ② IS NOT COSMETIC. `demand_notices` holding no currency is itself
 * the reason a developer who starts selling to a Gulf buyer will silently
 * get a wrong ageing — and a payload that says "assumed INR because the
 * table cannot hold anything else" is the only place that fact is visible.
 */
type SingleCurrencyTotal = {
  currency: string;
  amountMinor: string;
  formatted: string;
  /**
   * 🔴 TRUE when the currency is the workspace's functional currency
   * applied by assumption, because the underlying table has no `currency`
   * column at all. False when the row carried its own.
   */
  currencyAssumed: boolean;
};

function labelled(
  amountMinor: bigint,
  currency: string,
  currencyAssumed: boolean,
): SingleCurrencyTotal {
  return {
    currency,
    amountMinor: amountMinor.toString(),
    formatted: `${currency} ${formatMinorPlain(amountMinor, currency)}`,
    currencyAssumed,
  };
}

/** `numeric`/`bigint` arrives as a string on some paths. Never via `Number`. */
function toMinor(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  return BigInt(String(value).trim().split(".")[0] || "0");
}

/* ------------------------------------------------------------------ */
/* GST SUMMARY                                                         */
/* ------------------------------------------------------------------ */

export async function getGstSummary(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      /**
       * 🔴 GROUPED BY `invoices.currency` — BATCH 0101.
       *
       * ⚠️ `invoices` HERE IS `billing.invoices`, WHICH CARRIES A
       * `currency` COLUMN, and the old ungrouped `sum()` added every
       * currency together. Grouping is the fix that needs no rate and
       * cannot be wrong.
       *
       * ⚠️ SEPARATELY, AND NOT FIXED BY THIS BATCH: this report reads
       * ORDENCE'S OWN SUBSCRIPTION INVOICES to the tenant, not the
       * tenant's outward GST supplies. `db/schema/index.ts` says in as
       * many words that `billing.invoices` is "Ordence billing its own
       * tenants" while `sales_invoices` is "a tenant billing its
       * customers", and this GST summary reads the wrong one. That is a
       * pre-existing defect of a different kind and it is named in the
       * batch report rather than silently repaired here.
       */
      const outputTaxRows = await tx
        .select({
          currency: invoices.currency,
          count: sql<number>`count(*)::int`,
          totalTax: sql<string>`coalesce(sum(invoice_lines.cgst_minor + invoice_lines.sgst_minor + invoice_lines.igst_minor), 0)::text`,
          totalValue: sql<string>`coalesce(sum(invoice_lines.taxable_value_minor), 0)::text`,
        })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
        .where(sql`invoices.status = 'open'`)
        .groupBy(invoices.currency)
        .orderBy(invoices.currency);

      const inputTax = await tx
        .select({
          count: sql<number>`count(*)::int`,
          totalItc: sql<string>`coalesce(sum(itc_register.cgst_minor + itc_register.sgst_minor + itc_register.igst_minor), 0)::text`,
        })
        .from(itcRegister)
        .where(eq(itcRegister.status, "claimed"));

      const pendingTasks = await tx
        .select({
          count: sql<number>`count(*)::int`,
          oldest: sql<string>`min(${complianceTasks.dueDate})`,
        })
        .from(complianceTasks)
        .leftJoin(complianceObligations, eq(complianceTasks.obligationId, complianceObligations.id))
        .where(and(
          eq(complianceTasks.status, "pending"),
          sql`${complianceObligations.authority} = 'gst'`,
        ));

      return {
        /**
         * ⭐ AN ARRAY, ONE ENTRY PER CURRENCY. Never a single scalar,
         * because there is no single scalar to give when the underlying
         * set spans currencies — and a shape that can only hold one
         * number is how the previous version came to hold a wrong one.
         */
        outputTaxByCurrency: outputTaxRows.map((r) => ({
          currency: r.currency,
          count: r.count,
          totalTax: labelled(toMinor(r.totalTax), r.currency, false),
          totalValue: labelled(toMinor(r.totalValue), r.currency, false),
        })),
        outputTaxCurrencies: outputTaxRows.map((r) => r.currency),
        /**
         * ⚠️ `itc_register` HAS NO `currency` COLUMN, and it correctly has
         * none: input tax credit under the CGST Act is a rupee amount in a
         * rupee electronic credit ledger. So the label is the functional
         * currency by assumption and the payload says so.
         */
        inputTax: {
          count: inputTax[0]?.count ?? 0,
          totalItc: labelled(toMinor(inputTax[0]?.totalItc), functional.code, true),
        },
        pendingFilings: pendingTasks[0]?.count ?? 0,
        nextFilingDue: pendingTasks[0]?.oldest ?? null,
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate GST summary." };
  }
}

/* ------------------------------------------------------------------ */
/* RECEIVABLES AGING                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BATCH 0101 — WHY THIS ONE IS LABELLED AND NOT GROUPED.
 *
 * `demand_notices` and `receipts` have NO `currency` column. That is not
 * an oversight this batch can fix from here — adding one means a
 * migration on two tables plus every write path that fills them — so the
 * arithmetic below was, and remains, correct: it sums one currency
 * because the schema cannot hold two.
 *
 * 🔴 WHAT WAS WRONG IS THAT THE NUMBER LEFT THIS FUNCTION NAKED. A
 * receivables ageing is read by somebody deciding whom to chase, and a
 * bare "412000" is a figure they will read as rupees whatever the
 * workspace's books are actually kept in. Every total below now carries
 * the functional currency AND a flag saying the label is an assumption
 * the schema forces.
 *
 * ⚠️ STATED GAP: a workspace whose functional currency is not INR and
 * which raises a foreign-currency demand has no way to record it here at
 * all. Listed in the batch report.
 */
export async function getReceivablesAging(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const aging = await tx
        .select({
          bucket: sql<string>`
            CASE
              WHEN (${demandNotices.noticeDate}::date) >= (now() - interval '30 days')::date THEN '0-30'
              WHEN (${demandNotices.noticeDate}::date) >= (now() - interval '60 days')::date THEN '31-60'
              WHEN (${demandNotices.noticeDate}::date) >= (now() - interval '90 days')::date THEN '61-90'
              ELSE '90+'
            END
          `,
          count: sql<number>`count(*)::int`,
          total: sql<string>`coalesce(sum(outstanding_minor), 0)::text`,
        })
        .from(demandNotices)
        .where(sql`outstanding_minor > 0`)
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      const totalReceipts = await tx
        .select({
          count: sql<number>`count(*)::int`,
          total: sql<string>`coalesce(sum(${receipts.amountMinor}), 0)::text`,
        })
        .from(receipts)
        .where(sql`received_on >= (now() - interval '30 days')::date`);

      return {
        currency: functional.code,
        currencyAssumed: true,
        currencyNote:
          `demand_notices has no currency column, so every figure here is ${functional.code} ` +
          `by construction rather than by measurement. A foreign-currency demand cannot be ` +
          `recorded in this table at all.`,
        buckets: aging.map((b) => ({
          bucket: b.bucket,
          count: b.count,
          total: labelled(toMinor(b.total), functional.code, true),
        })),
        receipts30Days: {
          count: totalReceipts[0]?.count ?? 0,
          total: labelled(toMinor(totalReceipts[0]?.total), functional.code, true),
        },
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate receivables aging." };
  }
}

/* ------------------------------------------------------------------ */
/* TDS SUMMARY                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BATCH 0101 — LABELLED, NOT GROUPED, AND FOR A GOOD REASON.
 *
 * `tds_deductions` and `tds_challans` hold no currency and must not: tax
 * deducted at source under Chapter XVII-B is paid to the Government in
 * rupees, on a rupee challan, whatever currency the underlying payment was
 * made in. So these figures ARE rupees.
 *
 * 🔴 WHICH IS ITSELF A GAP WORTH NAMING: a payment to a non-resident under
 * s.195 is frequently made in foreign currency and the TDS is computed on
 * the rupee equivalent at the rate prescribed by Rule 26 — the telegraphic
 * transfer buying rate on the date the tax is required to be deducted.
 * Ordence does not apply Rule 26 anywhere, so a s.195 deduction entered
 * here is whatever rupee figure somebody typed. Named in the batch report.
 */
export async function getTdsSummary(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const deductions = await tx
        .select({
          count: sql<number>`count(*)::int`,
          totalTds: sql<string>`coalesce(sum(tax_minor + surcharge_minor + cess_minor), 0)::text`,
        })
        .from(tdsDeductions)
        .where(sql`deduction_date >= date_trunc('month', now())::date - interval '3 months'`);

      const pendingChallans = await tx
        .select({
          count: sql<number>`count(*)::int`,
          totalTds: sql<string>`coalesce(sum(total_tds_minor), 0)::text`,
        })
        .from(tdsChallans)
        .where(eq(tdsChallans.status, "pending"));

      const bySection = await tx
        .select({
          section: tdsDeductions.section,
          count: sql<number>`count(*)::int`,
          totalTds: sql<string>`coalesce(sum(tax_minor + surcharge_minor + cess_minor), 0)::text`,
        })
        .from(tdsDeductions)
        .where(sql`deduction_date >= date_trunc('month', now())::date - interval '3 months'`)
        .groupBy(tdsDeductions.section)
        .orderBy(desc(sql`2`));

      return {
        currency: functional.code,
        currencyAssumed: true,
        quarterly: {
          count: deductions[0]?.count ?? 0,
          totalTds: labelled(toMinor(deductions[0]?.totalTds), functional.code, true),
        },
        pendingChallans: {
          count: pendingChallans[0]?.count ?? 0,
          totalTds: labelled(toMinor(pendingChallans[0]?.totalTds), functional.code, true),
        },
        bySection: bySection.map((s) => ({
          section: s.section,
          count: s.count,
          totalTds: labelled(toMinor(s.totalTds), functional.code, true),
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate TDS summary." };
  }
}

/* ------------------------------------------------------------------ */
/* COMPLIANCE STATUS                                                   */
/* ------------------------------------------------------------------ */

export async function getComplianceStatus(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const today = new Date().toISOString().slice(0, 10);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const byStatus = await tx
        .select({
          status: complianceTasks.status,
          count: sql<number>`count(*)::int`,
        })
        .from(complianceTasks)
        .groupBy(complianceTasks.status);

      const overdue = await tx
        .select({
          count: sql<number>`count(*)::int`,
          oldest: sql<string>`min(${complianceTasks.dueDate})`,
        })
        .from(complianceTasks)
        .where(and(eq(complianceTasks.status, "pending"), sql`${complianceTasks.dueDate} < ${today}`));

      const byAuthority = await tx
        .select({
          authority: complianceObligations.authority,
          pending: sql<number>`count(*) FILTER (WHERE ${complianceTasks.status} = 'pending')::int`,
          completed: sql<number>`count(*) FILTER (WHERE ${complianceTasks.status} = 'completed')::int`,
          overdue: sql<number>`count(*) FILTER (WHERE ${complianceTasks.status} = 'pending' AND ${complianceTasks.dueDate} < ${today})::int`,
        })
        .from(complianceTasks)
        .leftJoin(complianceObligations, eq(complianceTasks.obligationId, complianceObligations.id))
        .groupBy(complianceObligations.authority)
        .orderBy(complianceObligations.authority);

      return {
        byStatus: byStatus.map((s) => ({ status: s.status, count: s.count })),
        overdueCount: overdue[0]?.count ?? 0,
        oldestOverdue: overdue[0]?.oldest ?? null,
        byCategory: byAuthority.map((c) => ({
          category: c.authority ?? "uncategorised",
          pending: c.pending,
          completed: c.completed,
          overdue: c.overdue,
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate compliance status." };
  }
}

/* ------------------------------------------------------------------ */
/* INVENTORY VALUATION                                                 */
/* ------------------------------------------------------------------ */

export async function getInventoryValuation(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const totals = await tx
        .select({
          itemCount: sql<number>`count(distinct ${stockBalances.stockItemId})::int`,
          totalQty: sql<string>`coalesce(sum(${stockBalances.quantityOnHand} - ${stockBalances.quantityReserved}), 0)::text`,
          reservedQty: sql<string>`coalesce(sum(${stockBalances.quantityReserved}), 0)::text`,
        })
        .from(stockBalances)
        .where(sql`${stockBalances.quantityOnHand} > 0`);

      const lowStock = await tx
        .select({
          id: stockItems.id,
          name: stockItems.name,
          sku: stockItems.sku,
          onHand: stockBalances.quantityOnHand,
          reserved: stockBalances.quantityReserved,
          reorderLevel: stockItems.reorderLevel,
        })
        .from(stockItems)
        .innerJoin(stockBalances, eq(stockBalances.stockItemId, stockItems.id))
        .where(and(
          sql`${stockBalances.quantityOnHand} - ${stockBalances.quantityReserved} <= coalesce(${stockItems.reorderLevel}, 0)`,
          sql`${stockBalances.quantityOnHand} > 0`,
        ))
        .orderBy(sql`${stockBalances.quantityOnHand} ASC`)
        .limit(20);

      return {
        totals: {
          itemCount: totals[0]?.itemCount ?? 0,
          totalQty: totals[0]?.totalQty ?? "0",
          reservedQty: totals[0]?.reservedQty ?? "0",
        },
        lowStock: lowStock.map((item) => ({
          id: item.id,
          name: item.name,
          sku: item.sku,
          onHand: Number(item.onHand),
          reserved: Number(item.reserved),
          available: Number(item.onHand) - Number(item.reserved),
          reorderPoint: item.reorderLevel ? Number(item.reorderLevel) : null,
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate inventory valuation." };
  }
}

/* ------------------------------------------------------------------ */
/* PROJECT PROFITABILITY                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BATCH 0101. `projects` has no `currency` column either, so
 * `contract_value_minor` is the functional currency by construction. The
 * label below is the assumption made visible; `sumByCurrency` is used even
 * on a single bucket so that the day a currency column arrives, this
 * function produces several labelled figures rather than one wrong one.
 */
export async function getProjectProfitability(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const projectRows = await tx
        .select({
          id: projects.id,
          name: projects.name,
          contractValue: sql<string>`coalesce(contract_value_minor, 0)::text`,
        })
        .from(projects)
        .where(eq(projects.isActive, true))
        .orderBy(desc(projects.name))
        .limit(20);

      const totals = sumByCurrency(
        projectRows.map((p) => ({
          currency: functional.code,
          amountMinor: toMinor(p.contractValue),
        })),
      );

      return {
        currency: functional.code,
        currencyAssumed: true,
        contractValueTotals: totals.map((t) =>
          labelled(t.amountMinor, t.currency, true),
        ),
        projects: projectRows.map((p) => ({
          id: p.id,
          name: p.name,
          status: "active",
          contractValue: labelled(toMinor(p.contractValue), functional.code, true),
          certifiedValue: labelled(0n, functional.code, true),
          purchaseValue: labelled(0n, functional.code, true),
          margin: labelled(0n, functional.code, true),
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate project profitability." };
  }
}
