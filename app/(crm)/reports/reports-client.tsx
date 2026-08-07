"use client";

/**
 * Ordence — Reports Gallery
 * Version: v0.82.0-alpha
 *
 * Shows predefined report cards. Clicking a card loads the report
 * inline with formatted output. Each report has its own loading and
 * error state.
 */

import { useState, useTransition, Suspense } from "react";
import {
  getGstSummary,
  getReceivablesAging,
  getTdsSummary,
  getComplianceStatus,
  getInventoryValuation,
  getProjectProfitability,
} from "@/server/actions/reports";

const REPORTS = [
  { id: "gst", label: "GST Summary", description: "Output tax, input tax credit, pending filings", icon: "🧾" },
  { id: "receivables", label: "Receivables Aging", description: "Outstanding by age bucket (0-30, 31-60, 61-90, 90+)", icon: "📞" },
  { id: "tds", label: "TDS Summary", description: "Deductions by section, pending challans", icon: "💰" },
  { id: "compliance", label: "Compliance Status", description: "Tasks by status and category, overdue count", icon: "📋" },
  { id: "inventory", label: "Inventory Valuation", description: "Stock on hand, reserved, low stock items", icon: "📦" },
  { id: "profitability", label: "Project Profitability", description: "Contract value vs certified vs purchase cost", icon: "📈" },
] as const;

type ReportId = (typeof REPORTS)[number]["id"];

export default function ReportsClient() {
  const [activeReport, setActiveReport] = useState<ReportId | null>(null);
  const [pending, start] = useTransition();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadReport(id: ReportId) {
    setError(null);
    setData(null);
    setActiveReport(id);
    start(async () => {
      const fn = {
        gst: getGstSummary,
        receivables: getReceivablesAging,
        tds: getTdsSummary,
        compliance: getComplianceStatus,
        inventory: getInventoryValuation,
        profitability: getProjectProfitability,
      }[id];

      const res = await fn();
      if (res.ok) {
        setData(res.data);
      } else {
        setError(res.error);
      }
    });
  }

  function formatPaise(s: string): string {
    const n = Number(s);
    if (isNaN(n)) return s;
    const rupees = n / 100;
    if (rupees >= 10000000) return `₹${(rupees / 10000000).toFixed(2)} Cr`;
    if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(2)} L`;
    if (rupees >= 1000) return `₹${(rupees / 1000).toFixed(1)}K`;
    return `₹${rupees.toFixed(0)}`;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Predefined reports across GST, receivables, TDS, compliance, inventory, and projects.
        </p>
      </div>

      {/* Report cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((report) => (
          <button
            key={report.id}
            type="button"
            onClick={() => loadReport(report.id)}
            className={`rounded-lg border p-4 text-left transition-colors ${
              activeReport === report.id
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/30"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xl">{report.icon}</span>
              <span className="text-sm font-medium">{report.label}</span>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{report.description}</p>
          </button>
        ))}
      </div>

      {/* Cost control link */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">📊 Cost Control</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Over-measured lines, unbilled work, committed vs certified</p>
          </div>
          <a href="/reports/cost" className="text-sm font-medium text-primary hover:underline">Open →</a>
        </div>
      </div>

      {/* Report output */}
      {activeReport && (
        <div className="rounded-lg border border-border p-6">
          <h2 className="mb-4 text-lg font-medium">
            {REPORTS.find((r) => r.id === activeReport)?.label}
          </h2>

          {pending && (
            <div className="h-32 animate-pulse rounded-md bg-muted" />
          )}

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* GST Summary */}
          {!pending && !error && data && activeReport === "gst" && <GstReportView data={data} formatPaise={formatPaise} />}

          {/* Receivables Aging */}
          {!pending && !error && data && activeReport === "receivables" && <ReceivablesReportView data={data} formatPaise={formatPaise} />}

          {/* TDS Summary */}
          {!pending && !error && data && activeReport === "tds" && <TdsReportView data={data} formatPaise={formatPaise} />}

          {/* Compliance Status */}
          {!pending && !error && data && activeReport === "compliance" && <ComplianceReportView data={data} />}

          {/* Inventory Valuation */}
          {!pending && !error && data && activeReport === "inventory" && <InventoryReportView data={data} />}

          {/* Project Profitability */}
          {!pending && !error && data && activeReport === "profitability" && <ProfitabilityReportView data={data} formatPaise={formatPaise} />}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* REPORT VIEWS                                                        */
/* ------------------------------------------------------------------ */

function GstReportView({ data, formatPaise }: { data: Record<string, unknown>; formatPaise: (s: string) => string }) {
  const d = data as {
    outputTax: { count: number; totalTax: string; totalValue: string };
    inputTax: { count: number; totalItc: string };
    pendingFilings: number;
    nextFilingDue: string | null;
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-md border border-border p-4">
          <p className="text-xs text-muted-foreground">Output tax (issued invoices)</p>
          <p className="mt-1 text-2xl font-bold">{formatPaise(d.outputTax.totalTax)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{d.outputTax.count} invoices · taxable value {formatPaise(d.outputTax.totalValue)}</p>
        </div>
        <div className="rounded-md border border-border p-4">
          <p className="text-xs text-muted-foreground">Input tax credit claimed</p>
          <p className="mt-1 text-2xl font-bold">{formatPaise(d.inputTax.totalItc)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{d.inputTax.count} entries</p>
        </div>
      </div>
      <div className="rounded-md border border-border p-4">
        <p className="text-xs text-muted-foreground">Net GST liability</p>
        <p className="mt-1 text-2xl font-bold">
          {formatPaise(String(Number(d.outputTax.totalTax) - Number(d.inputTax.totalItc)))}
        </p>
      </div>
      {d.pendingFilings > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-700">
          ⏰ {d.pendingFilings} GST filing(s) pending{d.nextFilingDue ? ` · next due ${d.nextFilingDue}` : ""}
        </div>
      )}
    </div>
  );
}

function ReceivablesReportView({ data, formatPaise }: { data: Record<string, unknown>; formatPaise: (s: string) => string }) {
  const d = data as {
    buckets: Array<{ bucket: string; count: number; total: string }>;
    receipts30Days: { count: number; total: string };
  };

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2">Age bucket</th>
            <th className="pb-2 text-right">Count</th>
            <th className="pb-2 text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {d.buckets.map((b) => (
            <tr key={b.bucket} className="border-b border-border/50">
              <td className="py-2.5 font-medium">{b.bucket} days</td>
              <td className="py-2.5 text-right tabular-nums">{b.count}</td>
              <td className="py-2.5 text-right tabular-nums font-medium">{formatPaise(b.total)}</td>
            </tr>
          ))}
          {d.buckets.length === 0 && (
            <tr><td colSpan={3} className="py-6 text-center text-muted-foreground">No outstanding receivables</td></tr>
          )}
        </tbody>
      </table>
      <div className="rounded-md border border-border p-4">
        <p className="text-xs text-muted-foreground">Collections (last 30 days)</p>
        <p className="mt-1 text-xl font-bold">{formatPaise(d.receipts30Days.total)}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{d.receipts30Days.count} receipts</p>
      </div>
    </div>
  );
}

function TdsReportView({ data, formatPaise }: { data: Record<string, unknown>; formatPaise: (s: string) => string }) {
  const d = data as {
    quarterly: { count: number; totalTds: string };
    pendingChallans: { count: number; totalTds: string };
    bySection: Array<{ section: string; count: number; totalTds: string }>;
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-md border border-border p-4">
          <p className="text-xs text-muted-foreground">TDS deducted (last 3 months)</p>
          <p className="mt-1 text-2xl font-bold">{formatPaise(d.quarterly.totalTds)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{d.quarterly.count} deductions</p>
        </div>
        <div className="rounded-md border border-border p-4">
          <p className="text-xs text-muted-foreground">Pending challans</p>
          <p className="mt-1 text-2xl font-bold">{formatPaise(d.pendingChallans.totalTds)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{d.pendingChallans.count} challans</p>
        </div>
      </div>
      {d.bySection.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2">Section</th>
              <th className="pb-2 text-right">Count</th>
              <th className="pb-2 text-right">TDS Amount</th>
            </tr>
          </thead>
          <tbody>
            {d.bySection.map((s) => (
              <tr key={s.section} className="border-b border-border/50">
                <td className="py-2.5 font-mono">{s.section}</td>
                <td className="py-2.5 text-right tabular-nums">{s.count}</td>
                <td className="py-2.5 text-right tabular-nums font-medium">{formatPaise(s.totalTds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ComplianceReportView({ data }: { data: Record<string, unknown> }) {
  const d = data as {
    byStatus: Array<{ status: string; count: number }>;
    overdueCount: number;
    oldestOverdue: string | null;
    byCategory: Array<{ category: string; pending: number; completed: number; overdue: number }>;
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {d.byStatus.map((s) => (
          <div key={s.status} className={`rounded-md border p-3 ${s.status === "overdue" ? "border-red-300 bg-red-50" : "border-border"}`}>
            <p className="text-xs text-muted-foreground capitalize">{s.status}</p>
            <p className="mt-1 text-xl font-bold tabular-nums">{s.count}</p>
          </div>
        ))}
      </div>
      {d.overdueCount > 0 && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          ⚠️ {d.overdueCount} overdue task(s){d.oldestOverdue ? ` · oldest since ${d.oldestOverdue}` : ""}
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2">Category</th>
            <th className="pb-2 text-right">Pending</th>
            <th className="pb-2 text-right">Completed</th>
            <th className="pb-2 text-right">Overdue</th>
          </tr>
        </thead>
        <tbody>
          {d.byCategory.map((c) => (
            <tr key={c.category} className="border-b border-border/50">
              <td className="py-2.5 capitalize">{c.category}</td>
              <td className="py-2.5 text-right tabular-nums">{c.pending}</td>
              <td className="py-2.5 text-right tabular-nums">{c.completed}</td>
              <td className="py-2.5 text-right tabular-nums text-red-600">{c.overdue}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventoryReportView({ data }: { data: Record<string, unknown> }) {
  const d = data as {
    totals: { itemCount: number; totalQty: string; reservedQty: string };
    lowStock: Array<{ id: string; name: string; sku: string | null; onHand: number; reserved: number; available: number; reorderPoint: number | null }>;
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Active items</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{d.totals.itemCount}</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Total quantity</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{d.totals.totalQty}</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Reserved</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{d.totals.reservedQty}</p>
        </div>
      </div>
      {d.lowStock.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">Low stock items ({d.lowStock.length})</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2">Item</th>
                <th className="pb-2">SKU</th>
                <th className="pb-2 text-right">Available</th>
                <th className="pb-2 text-right">Reorder point</th>
              </tr>
            </thead>
            <tbody>
              {d.lowStock.map((item) => (
                <tr key={item.id} className="border-b border-border/50">
                  <td className="py-2.5 font-medium">{item.name}</td>
                  <td className="py-2.5 font-mono text-xs">{item.sku ?? "—"}</td>
                  <td className="py-2.5 text-right tabular-nums text-amber-600">{item.available}</td>
                  <td className="py-2.5 text-right tabular-nums text-muted-foreground">{item.reorderPoint ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.lowStock.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          All stock levels are above reorder points.
        </p>
      )}
    </div>
  );
}

function ProfitabilityReportView({ data, formatPaise }: { data: Record<string, unknown>; formatPaise: (s: string) => string }) {
  const d = data as {
    projects: Array<{
      id: string; name: string; status: string;
      contractValue: string; certifiedValue: string; purchaseValue: string; margin: string;
    }>;
  };

  return (
    <div className="space-y-4">
      {d.projects.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          No active projects.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2">Project</th>
              <th className="pb-2 text-right">Contract</th>
              <th className="pb-2 text-right">Certified</th>
              <th className="pb-2 text-right">Purchases</th>
              <th className="pb-2 text-right">Est. margin</th>
            </tr>
          </thead>
          <tbody>
            {d.projects.map((p) => {
              const cv = Number(p.contractValue);
              const pv = Number(p.purchaseValue);
              const margin = cv > 0 ? ((cv - pv) / cv) * 100 : 0;
              return (
                <tr key={p.id} className="border-b border-border/50">
                  <td className="py-2.5 font-medium">{p.name}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatPaise(p.contractValue)}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatPaise(p.certifiedValue)}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatPaise(p.purchaseValue)}</td>
                  <td className={`py-2.5 text-right tabular-nums font-medium ${margin >= 20 ? "text-green-600" : margin >= 10 ? "text-amber-600" : "text-red-600"}`}>
                    {margin.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
