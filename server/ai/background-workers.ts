import "server-only";

/**
 * Ordence — ⭐ BACKGROUND INTELLIGENCE WORKERS
 * Version: v0.77.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ══════════════════════════════════════════════════════════════════════
 * Six scheduled monitors that run periodically, query the tenant's data,
 * and use the AI to surface anomalies and risks before they become
 * problems. Each worker:
 *
 *   1. Runs inside `withTenant()` under RLS (same as every other query)
 *   2. Fetches a small, targeted dataset (not the whole database)
 *   3. Sends the data to the AI for analysis
 *   4. Records any patterns in `tenant_patterns`
 *   5. Returns a summary of findings (alerts, insights, counts)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SECURITY: READ-ONLY, TENANT-SCOPED
 * ══════════════════════════════════════════════════════════════════════
 * Every worker runs inside `withTenant(tenantId, ...)`. No worker writes
 * to any business table. The only write is to `tenant_patterns`, which
 * is also RLS-protected and append-or-update.
 *
 * ⚠️ The AI receives a SUMMARY of the data (counts, aggregates, top
 * items), not raw rows. This keeps the AI call small and prevents
 * exposing individual customer records to the LLM provider beyond what
 * is needed for analysis.
 */

import { withTenant } from "@/db";
import { chatCompletion, type ChatMessage } from "@/lib/ai/client";
import { recordPattern } from "@/lib/ai/patterns";
import { createNotification } from "@/server/notifications/create";
import {
  complianceTasks,
  complianceObligations,
  complianceLicences,
  gstRegistrations,
  purchaseInvoices,
  itcRegister,
  demandNotices,
  stockItems,
  stockBalances,
  dailySiteLogs,
  projects,
} from "@/db/schema";
import { and, eq, lte, gte, sql, desc, asc, lt, isNotNull } from "drizzle-orm";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type WorkerResult = {
  workerId: string;
  tenantId: string;
  ok: boolean;
  alertCount: number;
  summary: string;
  findings: Array<{ key: string; severity: "info" | "warning" | "critical"; detail: string }>;
  error?: string;
};

/* ------------------------------------------------------------------ */
/* SHARED HELPERS                                                      */
/* ------------------------------------------------------------------ */

/** Today's date as `YYYY-MM-DD` — for comparing against `date()` columns. */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** N days from now as `YYYY-MM-DD`. */
function daysFromNowStr(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Days between two `YYYY-MM-DD` strings (positive = future, negative = past). */
function daysBetween(from: string, to: string): number {
  return Math.ceil(
    (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000),
  );
}

async function analyzeWithAI(
  systemPrompt: string,
  dataSummary: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: dataSummary },
  ];

  const response = await chatCompletion({
    messages,
    temperature: 0.2,
    sensitivity: "tenant",
  });

  if (!response.ok) return null;
  return response.result.message.content ?? null;
}

/* ------------------------------------------------------------------ */
/* 1. GST DEADLINE WATCHER                                             */
/* ------------------------------------------------------------------ */

async function gstDeadlineWatcher(tenantId: string): Promise<WorkerResult> {
  try {
    const today = todayStr();
    const thirtyAhead = daysFromNowStr(30);

    const upcoming = await withTenant(tenantId, async (tx) => {
      const tasks = await tx
        .select({
          id: complianceTasks.id,
          periodLabel: complianceTasks.periodLabel,
          dueDate: complianceTasks.dueDate,
          status: complianceTasks.status,
          obligationName: complianceObligations.name,
        })
        .from(complianceTasks)
        .leftJoin(
          complianceObligations,
          eq(complianceTasks.obligationId, complianceObligations.id),
        )
        .where(
          and(
            lte(complianceTasks.dueDate, thirtyAhead),
            eq(complianceTasks.status, "pending"),
          ),
        )
        .orderBy(asc(complianceTasks.dueDate))
        .limit(50);

      const regs = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(gstRegistrations);

      return { tasks, regCount: regs[0]?.count ?? 0 };
    });

    const overdue = upcoming.tasks.filter((t) => t.dueDate < today);
    const dueSoon = upcoming.tasks.filter((t) => {
      const d = daysBetween(today, t.dueDate);
      return d >= 0 && d <= 7;
    });

    const dataSummary = JSON.stringify({
      totalRegistrations: upcoming.regCount,
      pendingTasks: upcoming.tasks.length,
      overdue: overdue.length,
      dueIn7Days: dueSoon.length,
      tasks: upcoming.tasks.slice(0, 15).map((t) => ({
        period: t.periodLabel,
        obligation: t.obligationName,
        dueDate: t.dueDate,
        daysUntilDue: daysBetween(today, t.dueDate),
      })),
    });

    const summary = (await analyzeWithAI(
      "You are a GST compliance monitor for an Indian business. Analyze the upcoming GST deadlines and highlight risks. Be concise — 3-5 bullet points max.",
      dataSummary,
    )) ?? `${overdue.length} overdue, ${dueSoon.length} due within 7 days, ${upcoming.tasks.length} total pending.`;

    if (overdue.length > 0) {
      await recordPattern(tenantId, "late_compliance", "gst_deadlines_overdue", {
        summary: `${overdue.length} GST deadlines are overdue`,
        count: overdue.length,
      }, "compliance_monitor");
    }

    return {
      workerId: "gst_deadline_watcher",
      tenantId,
      ok: true,
      alertCount: overdue.length + dueSoon.length,
      summary,
      findings: [
        ...overdue.map((t) => ({
          key: t.id,
          severity: "critical" as const,
          detail: `OVERDUE: ${t.periodLabel} (due ${t.dueDate})`,
        })),
        ...dueSoon.map((t) => ({
          key: t.id,
          severity: "warning" as const,
          detail: `DUE SOON: ${t.periodLabel} (due ${t.dueDate})`,
        })),
      ],
    };
  } catch (err) {
    return {
      workerId: "gst_deadline_watcher",
      tenantId,
      ok: false,
      alertCount: 0,
      summary: "",
      findings: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/* ------------------------------------------------------------------ */
/* 2. RECEIVABLES AGING                                                */
/* ------------------------------------------------------------------ */

async function receivablesAging(tenantId: string): Promise<WorkerResult> {
  try {
    const today = todayStr();

    const data = await withTenant(tenantId, async (tx) => {
      const overdue = await tx
        .select({
          id: demandNotices.id,
          noticeNumber: demandNotices.noticeNumber,
          principalMinor: demandNotices.principalMinor,
          noticeDate: demandNotices.noticeDate,
          dueDate: demandNotices.dueDate,
          status: demandNotices.status,
        })
        .from(demandNotices)
        .where(
          and(
            eq(demandNotices.status, "issued"),
            lt(demandNotices.dueDate, today),
          ),
        )
        .orderBy(asc(demandNotices.dueDate))
        .limit(100);

      const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
      let totalOverdueMinor = 0n;

      for (const d of overdue) {
        const daysPast = daysBetween(d.dueDate, today);
        totalOverdueMinor += d.principalMinor;

        if (daysPast <= 30) buckets["0-30"]++;
        else if (daysPast <= 60) buckets["31-60"]++;
        else if (daysPast <= 90) buckets["61-90"]++;
        else buckets["90+"]++;
      }

      return { overdue, buckets, totalOverdueMinor };
    });

    const totalRs = Number(data.totalOverdueMinor) / 100;

    const dataSummary = JSON.stringify({
      totalOverdue: data.overdue.length,
      totalAmountRs: Math.floor(totalRs),
      ageBuckets: data.buckets,
      topOverdue: data.overdue.slice(0, 10).map((d) => ({
        noticeNumber: d.noticeNumber,
        amountRs: Math.floor(Number(d.principalMinor) / 100),
        daysPastDue: daysBetween(d.dueDate, today),
      })),
    });

    const summary = (await analyzeWithAI(
      "You are a receivables monitor for an Indian business. Analyze the overdue receivables and recommend collection actions. Be concise — 3-5 bullet points. Amounts are in rupees.",
      dataSummary,
    )) ?? `${data.overdue.length} overdue receivables totaling ₹${Math.floor(totalRs).toLocaleString("en-IN")}.`;

    if (data.buckets["90+"] > 0) {
      await recordPattern(tenantId, "overdue_receivable", "demand_notices_90_plus", {
        summary: `${data.buckets["90+"]} receivables over 90 days past due`,
        count: data.buckets["90+"],
      }, "receivables_agent");
    }

    return {
      workerId: "receivables_aging",
      tenantId,
      ok: true,
      alertCount: data.buckets["61-90"] + data.buckets["90+"],
      summary,
      findings: data.overdue.slice(0, 20).map((d) => {
        const days = daysBetween(d.dueDate, today);
        return {
          key: d.id,
          severity: days > 90 ? "critical" : days > 60 ? "warning" : "info",
          detail: `${d.noticeNumber}: ₹${Math.floor(Number(d.principalMinor) / 100).toLocaleString("en-IN")} — ${days} days past due`,
        };
      }),
    };
  } catch (err) {
    return {
      workerId: "receivables_aging",
      tenantId,
      ok: false,
      alertCount: 0,
      summary: "",
      findings: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/* ------------------------------------------------------------------ */
/* 3. RECONCILIATION DRIFT                                             */
/* ------------------------------------------------------------------ */

async function reconciliationDrift(tenantId: string): Promise<WorkerResult> {
  try {
    const data = await withTenant(tenantId, async (tx) => {
      // Unreconciled purchase invoices (status "recorded" = not yet matched)
      const unreconciled = await tx
        .select({
          id: purchaseInvoices.id,
          invoiceNumber: purchaseInvoices.invoiceNumber,
          taxableValueMinor: purchaseInvoices.taxableValueMinor,
          itcEligibleTaxMinor: purchaseInvoices.itcEligibleTaxMinor,
          status: purchaseInvoices.status,
        })
        .from(purchaseInvoices)
        .where(eq(purchaseInvoices.status, "recorded"))
        .orderBy(desc(purchaseInvoices.taxableValueMinor))
        .limit(50);

      // ITC register summary by status
      const itcSummary = await tx
        .select({
          status: itcRegister.status,
          count: sql<number>`count(*)::int`,
          totalTaxMinor: sql<number>`coalesce(sum(${itcRegister.cgstMinor} + ${itcRegister.sgstMinor} + ${itcRegister.igstMinor} + ${itcRegister.cessMinor}), 0)::bigint`,
        })
        .from(itcRegister)
        .groupBy(itcRegister.status);

      return { unreconciled, itcSummary };
    });

    let totalUnreconciledMinor = 0n;
    for (const inv of data.unreconciled) {
      totalUnreconciledMinor += inv.taxableValueMinor + inv.itcEligibleTaxMinor;
    }

    const dataSummary = JSON.stringify({
      unreconciledCount: data.unreconciled.length,
      unreconciledValueRs: Math.floor(Number(totalUnreconciledMinor) / 100),
      itcBreakdown: data.itcSummary.map((s) => ({
        status: s.status,
        count: s.count,
        totalTaxRs: Math.floor(Number(s.totalTaxMinor) / 100),
      })),
      topUnreconciled: data.unreconciled.slice(0, 10).map((inv) => ({
        invoiceNumber: inv.invoiceNumber,
        valueRs: Math.floor(
          (Number(inv.taxableValueMinor) + Number(inv.itcEligibleTaxMinor)) / 100,
        ),
      })),
    });

    const summary = (await analyzeWithAI(
      "You are a GSTR-2B reconciliation monitor. Analyze the reconciliation status and highlight ITC at risk. Be concise — 3-5 bullet points. Amounts are in rupees.",
      dataSummary,
    )) ?? `${data.unreconciled.length} unreconciled invoices worth ₹${Math.floor(Number(totalUnreconciledMinor) / 100).toLocaleString("en-IN")}.`;

    if (data.unreconciled.length > 10) {
      await recordPattern(tenantId, "gst_mismatch", "reconciliation_drift", {
        summary: `${data.unreconciled.length} invoices unreconciled with GSTR-2B`,
        count: data.unreconciled.length,
      }, "reconciliation_agent");
    }

    return {
      workerId: "reconciliation_drift",
      tenantId,
      ok: true,
      alertCount: data.unreconciled.length,
      summary,
      findings: data.unreconciled.slice(0, 15).map((inv) => ({
        key: inv.id,
        severity: "warning" as const,
        detail: `Unreconciled: ${inv.invoiceNumber} — ₹${Math.floor(
          (Number(inv.taxableValueMinor) + Number(inv.itcEligibleTaxMinor)) / 100,
        ).toLocaleString("en-IN")}`,
      })),
    };
  } catch (err) {
    return {
      workerId: "reconciliation_drift",
      tenantId,
      ok: false,
      alertCount: 0,
      summary: "",
      findings: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/* ------------------------------------------------------------------ */
/* 4. INVENTORY REORDER                                                */
/* ------------------------------------------------------------------ */

async function inventoryReorder(tenantId: string): Promise<WorkerResult> {
  try {
    const data = await withTenant(tenantId, async (tx) => {
      // Items that have a reorder level set
      const items = await tx
        .select({
          id: stockItems.id,
          name: stockItems.name,
          sku: stockItems.sku,
          uom: stockItems.uom,
          reorderLevel: stockItems.reorderLevel,
          onHand: stockBalances.quantityOnHand,
          reserved: stockBalances.quantityReserved,
        })
        .from(stockItems)
        .leftJoin(stockBalances, eq(stockBalances.stockItemId, stockItems.id))
        .where(
          and(
            isNotNull(stockItems.reorderLevel),
            sql`${stockBalances.quantityOnHand} <= coalesce(${stockItems.reorderLevel}, 0)`,
          ),
        )
        .limit(100);

      return { items };
    });

    const critical = data.items.filter(
      (s) => Number(s.onHand ?? 0) <= 0,
    );
    const low = data.items.filter(
      (s) => Number(s.onHand ?? 0) > 0 && Number(s.onHand ?? 0) <= Number(s.reorderLevel ?? 0),
    );

    const dataSummary = JSON.stringify({
      totalLowStock: data.items.length,
      outOfStock: critical.length,
      belowReorder: low.length,
      items: data.items.slice(0, 20).map((s) => ({
        name: s.name,
        sku: s.sku,
        onHand: Number(s.onHand ?? 0),
        reorderLevel: Number(s.reorderLevel ?? 0),
        reserved: Number(s.reserved ?? 0),
        available: Number(s.onHand ?? 0) - Number(s.reserved ?? 0),
      })),
    });

    const summary = (await analyzeWithAI(
      "You are an inventory monitor for an Indian business. Analyze stock levels and recommend reorders. Be concise — 3-5 bullet points.",
      dataSummary,
    )) ?? `${critical.length} out of stock, ${low.length} below reorder level, ${data.items.length} total items needing attention.`;

    if (critical.length > 0) {
      await recordPattern(tenantId, "low_stock_reorder", "inventory_stockout", {
        summary: `${critical.length} items out of stock`,
        count: critical.length,
      }, "field_dispatcher");
    }

    return {
      workerId: "inventory_reorder",
      tenantId,
      ok: true,
      alertCount: critical.length + low.length,
      summary,
      findings: data.items.slice(0, 20).map((s) => ({
        key: s.id,
        severity: Number(s.onHand ?? 0) <= 0 ? "critical" : "warning",
        detail: `${s.name} (${s.sku}): ${Number(s.onHand ?? 0)} on hand, reorder at ${Number(s.reorderLevel ?? 0)}`,
      })),
    };
  } catch (err) {
    return {
      workerId: "inventory_reorder",
      tenantId,
      ok: false,
      alertCount: 0,
      summary: "",
      findings: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/* ------------------------------------------------------------------ */
/* 5. COMPLIANCE GAP                                                   */
/* ------------------------------------------------------------------ */

async function complianceGap(tenantId: string): Promise<WorkerResult> {
  try {
    const today = todayStr();
    const sixtyAhead = daysFromNowStr(60);

    const data = await withTenant(tenantId, async (tx) => {
      const expiring = await tx
        .select({
          id: complianceLicences.id,
          name: complianceLicences.name,
          authority: complianceLicences.authority,
          validUntil: complianceLicences.validUntil,
        })
        .from(complianceLicences)
        .where(
          and(
            isNotNull(complianceLicences.validUntil),
            lte(complianceLicences.validUntil, sixtyAhead),
            gte(complianceLicences.validUntil, today),
          ),
        )
        .orderBy(asc(complianceLicences.validUntil))
        .limit(50);

      const overdue = await tx
        .select({
          id: complianceTasks.id,
          periodLabel: complianceTasks.periodLabel,
          dueDate: complianceTasks.dueDate,
        })
        .from(complianceTasks)
        .where(
          and(
            lt(complianceTasks.dueDate, today),
            eq(complianceTasks.status, "pending"),
          ),
        )
        .limit(50);

      return { expiring, overdue };
    });

    const dataSummary = JSON.stringify({
      expiringLicences: data.expiring.length,
      overdueTasks: data.overdue.length,
      licences: data.expiring.map((l) => ({
        name: l.name,
        authority: l.authority,
        validUntil: l.validUntil,
        daysToExpiry: l.validUntil ? daysBetween(today, l.validUntil) : null,
      })),
      overdueTaskDetails: data.overdue.map((t) => ({
        period: t.periodLabel,
        dueDate: t.dueDate,
        daysPastDue: daysBetween(t.dueDate, today),
      })),
    });

    const summary = (await analyzeWithAI(
      "You are a compliance monitor for an Indian business. Analyze expiring licences and overdue compliance tasks. Recommend actions. Be concise — 3-5 bullet points.",
      dataSummary,
    )) ?? `${data.expiring.length} licences expiring within 60 days, ${data.overdue.length} overdue compliance tasks.`;

    if (data.expiring.length > 0) {
      await recordPattern(tenantId, "licence_expiring", "compliance_licences_expiring", {
        summary: `${data.expiring.length} licences expiring within 60 days`,
        count: data.expiring.length,
      }, "compliance_monitor");
    }

    return {
      workerId: "compliance_gap",
      tenantId,
      ok: true,
      alertCount: data.expiring.length + data.overdue.length,
      summary,
      findings: [
        ...data.expiring.map((l) => ({
          key: l.id,
          severity: "warning" as const,
          detail: `EXPIRING: ${l.name} (${l.authority}) — valid until ${l.validUntil}`,
        })),
        ...data.overdue.map((t) => ({
          key: t.id,
          severity: "critical" as const,
          detail: `OVERDUE: ${t.periodLabel} (due ${t.dueDate})`,
        })),
      ],
    };
  } catch (err) {
    return {
      workerId: "compliance_gap",
      tenantId,
      ok: false,
      alertCount: 0,
      summary: "",
      findings: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/* ------------------------------------------------------------------ */
/* 6. SITE LABOUR ANOMALY                                              */
/* ------------------------------------------------------------------ */

async function siteLabourAnomaly(tenantId: string): Promise<WorkerResult> {
  try {
    const sevenDaysAgo = daysFromNowStr(-7);
    const threeDaysAgo = daysFromNowStr(-3);

    const data = await withTenant(tenantId, async (tx) => {
      const recentLogs = await tx
        .select({
          id: dailySiteLogs.id,
          logDate: dailySiteLogs.logDate,
          projectId: dailySiteLogs.projectId,
          labourCount: dailySiteLogs.labourCount,
        })
        .from(dailySiteLogs)
        .where(gte(dailySiteLogs.logDate, sevenDaysAgo))
        .orderBy(desc(dailySiteLogs.logDate))
        .limit(100);

      const activeProjects = await tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.isActive, true))
        .limit(20);

      // Check which projects have NO logs in the last 3 days
      const recentLogProjectIds = new Set(
        recentLogs
          .filter((l) => l.logDate >= threeDaysAgo)
          .map((l) => l.projectId),
      );
      const missingLogs = activeProjects.filter(
        (p) => !recentLogProjectIds.has(p.id),
      );

      return { recentLogs, activeProjects, missingLogs };
    });

    // Detect worker count drops (>50% drop day over day per project)
    const drops: Array<{ projectId: string; drop: number }> = [];
    const byProject = new Map<string, typeof data.recentLogs>();
    for (const log of data.recentLogs) {
      const arr = byProject.get(log.projectId) ?? [];
      arr.push(log);
      byProject.set(log.projectId, arr);
    }

    for (const [projectId, logs] of byProject) {
      const sorted = logs.sort((a, b) => a.logDate.localeCompare(b.logDate));
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!.labourCount;
        const curr = sorted[i]!.labourCount;
        if (prev > 0 && curr / prev < 0.5) {
          drops.push({ projectId, drop: Math.round((1 - curr / prev) * 100) });
        }
      }
    }

    const dataSummary = JSON.stringify({
      totalLogs: data.recentLogs.length,
      activeProjects: data.activeProjects.length,
      projectsWithMissingLogs: data.missingLogs.length,
      workerCountDrops: drops.length,
      missingProjects: data.missingLogs.map((p) => p.name),
      drops: drops.slice(0, 10),
      recentActivity: data.recentLogs.slice(0, 10).map((l) => ({
        date: l.logDate,
        workers: l.labourCount,
      })),
    });

    const summary = (await analyzeWithAI(
      "You are a construction site monitor. Analyze daily site logs for anomalies — missing logs, worker count drops, or unusual patterns. Be concise — 3-5 bullet points.",
      dataSummary,
    )) ?? `${data.missingLogs.length} projects with missing logs, ${drops.length} worker count drops detected.`;

    return {
      workerId: "site_labour_anomaly",
      tenantId,
      ok: true,
      alertCount: drops.length + data.missingLogs.length,
      summary,
      findings: [
        ...data.missingLogs.map((p) => ({
          key: p.id,
          severity: "warning" as const,
          detail: `NO RECENT LOGS: ${p.name} — no site logs in 3 days`,
        })),
        ...drops.slice(0, 10).map((d) => ({
          key: d.projectId,
          severity: "warning" as const,
          detail: `WORKER DROP: ${d.drop}% reduction in worker count`,
        })),
      ],
    };
  } catch (err) {
    return {
      workerId: "site_labour_anomaly",
      tenantId,
      ok: false,
      alertCount: 0,
      summary: "",
      findings: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/* ------------------------------------------------------------------ */
/* THE WORKER REGISTRY                                                 */
/* ------------------------------------------------------------------ */

export type BackgroundWorker = {
  id: string;
  label: string;
  description: string;
  cadence: string;
  run: (tenantId: string) => Promise<WorkerResult>;
};

export const BACKGROUND_WORKERS: readonly BackgroundWorker[] = [
  {
    id: "gst_deadline_watcher",
    label: "GST Deadline Watcher",
    description: "Monitors upcoming GST return due dates and alerts on overdue filings.",
    cadence: "0 9 * * *",
    run: gstDeadlineWatcher,
  },
  {
    id: "receivables_aging",
    label: "Receivables Aging",
    description: "Tracks overdue receivables by age band and flags high-risk accounts.",
    cadence: "0 10 * * 1-5",
    run: receivablesAging,
  },
  {
    id: "reconciliation_drift",
    label: "Reconciliation Drift",
    description: "Checks GSTR-2B purchase reconciliation status and ITC at risk.",
    cadence: "0 8 * * 1",
    run: reconciliationDrift,
  },
  {
    id: "inventory_reorder",
    label: "Inventory Reorder",
    description: "Identifies stock items at or below reorder point.",
    cadence: "0 6 * * *",
    run: inventoryReorder,
  },
  {
    id: "compliance_gap",
    label: "Compliance Gap",
    description: "Checks for expiring licences and overdue compliance tasks.",
    cadence: "0 9 * * 1",
    run: complianceGap,
  },
  {
    id: "site_labour_anomaly",
    label: "Site Labour Anomaly",
    description: "Detects unusual patterns in daily site logs and worker counts.",
    cadence: "0 18 * * 1-5",
    run: siteLabourAnomaly,
  },
];

/* ------------------------------------------------------------------ */
/* NOTIFICATION CREATION FROM WORKER RESULTS                           */
/* ------------------------------------------------------------------ */

/** Category mapping from worker ID to notification category. */
const WORKER_CATEGORY: Record<string, string> = {
  gst_deadline_watcher: "gst",
  receivables_aging: "receivables",
  reconciliation_drift: "gst",
  inventory_reorder: "inventory",
  compliance_gap: "compliance",
  site_labour_anomaly: "field_ops",
};

/** Action URL mapping from worker ID to the relevant page. */
const WORKER_ACTION_URL: Record<string, string> = {
  gst_deadline_watcher: "/compliance",
  receivables_aging: "/billing",
  reconciliation_drift: "/gstr2b",
  inventory_reorder: "/inventory",
  compliance_gap: "/compliance/licences",
  site_labour_anomaly: "/field-jobs",
};

/**
 * Convert a WorkerResult's findings into notifications. Only critical and
 * warning findings generate notifications — info findings are too noisy.
 */
async function notifyFromResult(result: WorkerResult): Promise<void> {
  if (!result.ok || result.alertCount === 0) return;

  const notable = result.findings.filter(
    (f) => f.severity === "critical" || f.severity === "warning",
  );
  if (notable.length === 0) return;

  const category = WORKER_CATEGORY[result.workerId] ?? "system";
  const actionUrl = WORKER_ACTION_URL[result.workerId];

  // Create one summary notification per worker run (not one per finding,
  // which would flood the notification center).
  const criticalCount = notable.filter((f) => f.severity === "critical").length;
  const warningCount = notable.filter((f) => f.severity === "warning").length;

  const titleParts: string[] = [];
  if (criticalCount > 0) titleParts.push(`${criticalCount} critical`);
  if (warningCount > 0) titleParts.push(`${warningCount} warning`);
  const title = `${titleParts.join(", ")} — ${result.workerId.replace(/_/g, " ")}`;

  const body = notable
    .slice(0, 5)
    .map((f) => f.detail)
    .join("\n");

  await createNotification({
    tenantId: result.tenantId,
    category,
    severity: criticalCount > 0 ? "critical" : "warning",
    title: title.replace(/\b\w/g, (c) => c.toUpperCase()),
    body,
    actionUrl,
    metadata: {
      workerId: result.workerId,
      alertCount: result.alertCount,
      criticalCount,
      warningCount,
    },
    source: result.workerId,
  });
}

export async function runAllWorkers(tenantId: string): Promise<WorkerResult[]> {
  const results: WorkerResult[] = [];
  for (const worker of BACKGROUND_WORKERS) {
    const result = await worker.run(tenantId);
    results.push(result);
    // Create notifications for any critical/warning findings.
    await notifyFromResult(result);
  }
  return results;
}

export async function runWorker(
  workerId: string,
  tenantId: string,
): Promise<WorkerResult | null> {
  const worker = BACKGROUND_WORKERS.find((w) => w.id === workerId);
  if (!worker) return null;
  const result = await worker.run(tenantId);
  // Create notifications for any critical/warning findings.
  await notifyFromResult(result);
  return result;
}
