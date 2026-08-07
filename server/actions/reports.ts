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

import { and, eq, desc, sql, gte, isNull } from "drizzle-orm";
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

type ReportResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* GST SUMMARY                                                         */
/* ------------------------------------------------------------------ */

export async function getGstSummary(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const outputTax = await tx
        .select({
          count: sql<number>`count(*)::int`,
          totalTax: sql<string>`coalesce(sum(invoice_lines.cgst_minor + invoice_lines.sgst_minor + invoice_lines.igst_minor), 0)::text`,
          totalValue: sql<string>`coalesce(sum(invoice_lines.taxable_value_minor), 0)::text`,
        })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
        .where(sql`invoices.status = 'open'`);

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
        outputTax: {
          count: outputTax[0]?.count ?? 0,
          totalTax: outputTax[0]?.totalTax ?? "0",
          totalValue: outputTax[0]?.totalValue ?? "0",
        },
        inputTax: {
          count: inputTax[0]?.count ?? 0,
          totalItc: inputTax[0]?.totalItc ?? "0",
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

export async function getReceivablesAging(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();

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
        buckets: aging.map((b) => ({ bucket: b.bucket, count: b.count, total: b.total })),
        receipts30Days: {
          count: totalReceipts[0]?.count ?? 0,
          total: totalReceipts[0]?.total ?? "0",
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

export async function getTdsSummary(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();

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
        quarterly: {
          count: deductions[0]?.count ?? 0,
          totalTds: deductions[0]?.totalTds ?? "0",
        },
        pendingChallans: {
          count: pendingChallans[0]?.count ?? 0,
          totalTds: pendingChallans[0]?.totalTds ?? "0",
        },
        bySection: bySection.map((s) => ({ section: s.section, count: s.count, totalTds: s.totalTds })),
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

export async function getProjectProfitability(): Promise<ReportResult> {
  try {
    const ctx = await requireTenantContext();

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

      return {
        projects: projectRows.map((p) => ({
          id: p.id,
          name: p.name,
          status: "active",
          contractValue: p.contractValue,
          certifiedValue: "0",
          purchaseValue: "0",
          margin: "0",
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to generate project profitability." };
  }
}
