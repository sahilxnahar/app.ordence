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
import { formatMinorPlain, minorUnitExponent } from "@/lib/fx/currency";

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ BATCH 0101 — THE LABELLED TOTAL, AS IT ARRIVES FROM THE SERVER
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE HELD THE OTHER HALF OF THE BUG. `server/actions/reports.ts`
 * returned unlabelled numbers and `formatPaise` below turned them into
 * rupees:
 *
 *     const rupees = n / 100;  ... return `₹${rupees.toFixed(0)}`;
 *
 * Two faults in one line. The hardcoded ₹ is wrong for any workspace whose
 * books are not in rupees, and the `/100` is wrong for JPY (no decimals at
 * all) and wrong by a factor of ten for KWD, BHD, OMR and the other
 * three-decimal currencies. "Right in the code and wrong in the display"
 * is exactly the shape this batch was told to check for, and it was here.
 */
type LabelledTotal = {
  currency: string;
  amountMinor: string;
  formatted: string;
  currencyAssumed: boolean;
};

/**
 * ⭐ THE CURRENCY AND THE EXPONENT BOTH COME FROM THE SERVER'S LABEL.
 *
 * ⚠️ THE LAKH/CRORE ABBREVIATION IS APPLIED ONLY TO INR, because "₹1.2 Cr"
 * is the Indian numbering system and "$1.2 Cr" is not a thing anybody
 * reads. Everything else falls through to the exact figure.
 *
 * ⚠️ AND `Number` APPEARS ONLY IN THE ABBREVIATION BRANCH, where the value
 * is already being turned into an approximation on purpose. The exact
 * figure is formatted from the `bigint` by `formatMinorPlain`.
 */
function formatTotal(total: LabelledTotal | null | undefined): string {
  if (!total) return "—";
  const currency = total.currency;
  let minor: bigint;
  try {
    minor = BigInt(total.amountMinor);
  } catch {
    return total.formatted;
  }
  let exponent: number;
  try {
    exponent = minorUnitExponent(currency);
  } catch {
    // An unknown code never becomes "assume two decimals" — it is shown
    // exactly as the server labelled it, which at least is not a lie.
    return total.formatted;
  }

  if (currency === "INR") {
    const scale = 10 ** exponent;
    const major = Number(minor) / scale;
    const abs = Math.abs(major);
    if (abs >= 10_000_000) return `₹${(major / 10_000_000).toFixed(2)} Cr`;
    if (abs >= 100_000) return `₹${(major / 100_000).toFixed(2)} L`;
    if (abs >= 1_000) return `₹${(major / 1_000).toFixed(1)}K`;
  }
  return `${currency} ${formatMinorPlain(minor, currency)}`;
}

/** The sentence a screen must show when the label is an assumption. */
function AssumedCurrencyNote({ currency, show }: { currency: string; show: boolean }) {
  if (!show) return null;
  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
      ⚠️ Figures are shown in {currency} because the tables behind this report hold no currency
      of their own. A foreign-currency document cannot be recorded in them, so this label is a
      property of the schema rather than a measurement.
    </p>
  );
}

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
          {!pending && !error && data && activeReport === "gst" && <GstReportView data={data} />}

          {/* Receivables Aging */}
          {!pending && !error && data && activeReport === "receivables" && <ReceivablesReportView data={data} />}

          {/* TDS Summary */}
          {!pending && !error && data && activeReport === "tds" && <TdsReportView data={data} />}

          {/* Compliance Status */}
          {!pending && !error && data && activeReport === "compliance" && <ComplianceReportView data={data} />}

          {/* Inventory Valuation */}
          {!pending && !error && data && activeReport === "inventory" && <InventoryReportView data={data} />}

          {/* Project Profitability */}
          {!pending && !error && data && activeReport === "profitability" && <ProfitabilityReportView data={data} />}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* REPORT VIEWS                                                        */
/* ------------------------------------------------------------------ */

function GstReportView({ data }: { data: Record<string, unknown> }) {
  const d = data as {
    outputTaxByCurrency: Array<{
      currency: string;
      count: number;
      /** ⚠️ GROSS. What was supplied, before Rule 53. */
      totalTax: LabelledTotal;
      totalValue: LabelledTotal;
      creditNotes: {
        count: number;
        nettedCount: number;
        timeBarredCount: number;
        windowUnverifiedCount: number;
        timeBarredTax: LabelledTotal;
        reducedTax: { total: LabelledTotal };
      };
      /** ⭐ What Rule 53 leaves payable, head by head. Never negative. */
      liability: {
        cgst: LabelledTotal;
        sgst: LabelledTotal;
        igst: LabelledTotal;
        total: LabelledTotal;
      };
      carriedForward: { total: LabelledTotal };
      hasNegativePeriod: boolean;
      tiesToDocument: { agrees: boolean; differenceMinor: string };
    }>;
    outputTaxCurrencies: string[];
    outputTaxExcludesCreditNotes: boolean;
    inputTax: { count: number; totalItc: LabelledTotal };
    pendingFilings: number;
    nextFilingDue: string | null;
  };

  /**
   * 🔴 THE NET LIABILITY IS ONLY A NUMBER WHEN THERE IS ONE CURRENCY.
   *
   * It used to be `Number(outputTax) - Number(inputItc)` over an output
   * figure that had every currency added together. When the outputs span
   * currencies there is no subtraction to do: the credit ledger is in
   * rupees and the output tax is not, so the two are not comparable
   * without a rate, and inventing one on a compliance screen would be the
   * worst possible place to guess.
   */
  // ⚠️ `noUncheckedIndexedAccess` — index access is `T | undefined`, and
  // the `?? null` is what makes the narrowing below sound.
  const singleOutput =
    d.outputTaxByCurrency.length === 1 ? (d.outputTaxByCurrency[0] ?? null) : null;
  const netComparable =
    singleOutput !== null && singleOutput.liability.total.currency === d.inputTax.totalItc.currency;
  /**
   * ⭐ THE OUTPUT SIDE OF THIS SUBTRACTION IS THE RULE 53 LIABILITY, NOT
   * THE GROSS TAX. It used to be the gross figure, so every workspace
   * that had ever issued a credit note was shown a net liability that was
   * too high by the whole tax on every return it had ever taken.
   */
  const net: LabelledTotal | null = netComparable && singleOutput
    ? {
        currency: singleOutput.liability.total.currency,
        amountMinor: (
          BigInt(singleOutput.liability.total.amountMinor) -
          BigInt(d.inputTax.totalItc.amountMinor)
        ).toString(),
        formatted: "",
        currencyAssumed: singleOutput.totalTax.currencyAssumed,
      }
    : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-md border border-border p-4">
          {/*
            ⭐ THE LABEL NAMES THE DOCUMENTS. This tile used to read "open
            invoices" over figures taken from Ordence's own subscription
            billing, and nothing on the screen said which invoices they
            were — which is precisely why nobody noticed.
          */}
          <p className="text-xs text-muted-foreground">
            Output tax — your issued sales invoices
          </p>
          {d.outputTaxByCurrency.length === 0 ? (
            <p className="mt-1 text-2xl font-bold">—</p>
          ) : (
            d.outputTaxByCurrency.map((row) => (
              <div key={row.currency} className="mt-1">
                {/*
                  ⭐ THE HEADLINE IS THE LIABILITY, NOT THE GROSS TAX.
                  The gross figure is kept underneath it, because an
                  accountant reconciling to the sales register needs to
                  see both and the difference between them.
                */}
                <p className="text-2xl font-bold">{formatTotal(row.liability.total)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {row.count} invoices · gross {formatTotal(row.totalTax)} · less credit notes{" "}
                  {formatTotal(row.creditNotes.reducedTax.total)} · taxable value{" "}
                  {formatTotal(row.totalValue)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  CGST {formatTotal(row.liability.cgst)} · SGST/UTGST{" "}
                  {formatTotal(row.liability.sgst)} · IGST {formatTotal(row.liability.igst)}
                </p>
              </div>
            ))
          )}
        </div>
        <div className="rounded-md border border-border p-4">
          <p className="text-xs text-muted-foreground">Input tax credit claimed</p>
          <p className="mt-1 text-2xl font-bold">{formatTotal(d.inputTax.totalItc)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{d.inputTax.count} entries</p>
        </div>
      </div>
      <div className="rounded-md border border-border p-4">
        <p className="text-xs text-muted-foreground">Net GST liability</p>
        {net ? (
          <p className="mt-1 text-2xl font-bold">{formatTotal(net)}</p>
        ) : (
          <p className="mt-1 text-sm text-amber-700">
            ⚠️ Not shown. The output tax above spans{" "}
            {d.outputTaxCurrencies.join(", ") || "no"} currenc
            {d.outputTaxCurrencies.length === 1 ? "y" : "ies"} and the input credit is in{" "}
            {d.inputTax.totalItc.currency}, so there is no single figure to subtract without an
            exchange rate. Read the two sides separately.
          </p>
        )}
      </div>
      <AssumedCurrencyNote
        currency={d.inputTax.totalItc.currency}
        show={d.inputTax.totalItc.currencyAssumed}
      />
      {d.outputTaxExcludesCreditNotes && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          ⚠️ Output tax above is gross of credit notes. A Rule 53 credit note reduces an outward
          supply and is not subtracted here, so a period with returns in it reads high. Check the
          credit notes before you file.
        </p>
      )}
      {/*
        ⭐ THE THREE FACTS A NETTED FIGURE CANNOT BE READ WITHOUT: what
        was subtracted, what was refused as out of time, and what could
        not be used this period and is carrying forward. A single netted
        number with none of them is a figure nobody can defend.
      */}
      {d.outputTaxByCurrency.map((row) =>
        row.creditNotes.count === 0 ? null : (
          <div
            key={`cn-${row.currency}`}
            className="rounded-md border border-border p-3 text-xs text-muted-foreground"
          >
            <p>
              Rule 53 · {row.currency}: {row.creditNotes.nettedCount} of{" "}
              {row.creditNotes.count} credit note(s) reduced output tax by{" "}
              {formatTotal(row.creditNotes.reducedTax.total)}.
            </p>
            {row.creditNotes.timeBarredCount > 0 && (
              <p className="mt-1 text-amber-800">
                ⚠️ {row.creditNotes.timeBarredCount} note(s) carrying{" "}
                {formatTotal(row.creditNotes.timeBarredTax)} fall after the section 34(2)
                deadline — 30 November following the end of the year of the supply. The credit is
                commercial; the output tax stays.
              </p>
            )}
            {row.creditNotes.windowUnverifiedCount > 0 && (
              <p className="mt-1 text-amber-800">
                ⚠️ {row.creditNotes.windowUnverifiedCount} note(s) name no original supply date,
                so the section 34(2) window could not be checked. They were deducted; confirm
                before filing.
              </p>
            )}
            {BigInt(row.carriedForward.total.amountMinor) !== 0n && (
              <p className="mt-1">
                {formatTotal(row.carriedForward.total)} of reduction exceeded the supplies of the
                period it was declared in and is carrying forward. It is not zero and it is not
                lost.
              </p>
            )}
            {!row.tiesToDocument.agrees && (
              <p className="mt-1 text-red-700">
                🔴 Document totals and line totals differ by {row.tiesToDocument.differenceMinor}{" "}
                minor units on these invoices. The return files the document totals; this report&apos;s
                gross figure sums the lines. Fix the documents before filing.
              </p>
            )}
          </div>
        ),
      )}
      {d.pendingFilings > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-700">
          ⏰ {d.pendingFilings} GST filing(s) pending{d.nextFilingDue ? ` · next due ${d.nextFilingDue}` : ""}
        </div>
      )}
    </div>
  );
}

function ReceivablesReportView({ data }: { data: Record<string, unknown> }) {
  const d = data as {
    currency: string;
    currencyAssumed: boolean;
    currencyNote: string;
    buckets: Array<{ bucket: string; count: number; total: LabelledTotal }>;
    receipts30Days: { count: number; total: LabelledTotal };
  };

  return (
    <div className="space-y-4">
      <AssumedCurrencyNote currency={d.currency} show={d.currencyAssumed} />
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2">Age bucket</th>
            <th className="pb-2 text-right">Count</th>
            <th className="pb-2 text-right">Outstanding ({d.currency})</th>
          </tr>
        </thead>
        <tbody>
          {d.buckets.map((b) => (
            <tr key={b.bucket} className="border-b border-border/50">
              <td className="py-2.5 font-medium">{b.bucket} days</td>
              <td className="py-2.5 text-right tabular-nums">{b.count}</td>
              <td className="py-2.5 text-right tabular-nums font-medium">{formatTotal(b.total)}</td>
            </tr>
          ))}
          {d.buckets.length === 0 && (
            <tr><td colSpan={3} className="py-6 text-center text-muted-foreground">No outstanding receivables</td></tr>
          )}
        </tbody>
      </table>
      <div className="rounded-md border border-border p-4">
        <p className="text-xs text-muted-foreground">Collections (last 30 days)</p>
        <p className="mt-1 text-xl font-bold">{formatTotal(d.receipts30Days.total)}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{d.receipts30Days.count} receipts</p>
      </div>
    </div>
  );
}

function TdsReportView({ data }: { data: Record<string, unknown> }) {
  const d = data as {
    currency: string;
    currencyAssumed: boolean;
    quarterly: { count: number; totalTds: LabelledTotal };
    pendingChallans: { count: number; totalTds: LabelledTotal };
    bySection: Array<{ section: string; count: number; totalTds: LabelledTotal }>;
  };

  return (
    <div className="space-y-4">
      <AssumedCurrencyNote currency={d.currency} show={d.currencyAssumed} />
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-md border border-border p-4">
          <p className="text-xs text-muted-foreground">TDS deducted (last 3 months)</p>
          <p className="mt-1 text-2xl font-bold">{formatTotal(d.quarterly.totalTds)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{d.quarterly.count} deductions</p>
        </div>
        <div className="rounded-md border border-border p-4">
          <p className="text-xs text-muted-foreground">Pending challans</p>
          <p className="mt-1 text-2xl font-bold">{formatTotal(d.pendingChallans.totalTds)}</p>
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
                <td className="py-2.5 text-right tabular-nums font-medium">{formatTotal(s.totalTds)}</td>
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

function ProfitabilityReportView({ data }: { data: Record<string, unknown> }) {
  const d = data as {
    currency: string;
    currencyAssumed: boolean;
    projects: Array<{
      id: string; name: string; status: string;
      contractValue: LabelledTotal; certifiedValue: LabelledTotal;
      purchaseValue: LabelledTotal; margin: LabelledTotal;
    }>;
  };

  return (
    <div className="space-y-4">
      <AssumedCurrencyNote currency={d.currency} show={d.currencyAssumed} />
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
              /**
               * ⚠️ A PERCENTAGE IS ONLY DEFINED WHEN BOTH SIDES ARE IN THE
               * SAME CURRENCY, and it is nil when the contract value is
               * nil. `Number(labelled)` on the object would have produced
               * NaN silently, which is why the minor-unit strings are what
               * is read here.
               */
              const comparable = p.contractValue.currency === p.purchaseValue.currency;
              const cv = Number(p.contractValue.amountMinor);
              const pv = Number(p.purchaseValue.amountMinor);
              const margin = comparable && cv > 0 ? ((cv - pv) / cv) * 100 : 0;
              return (
                <tr key={p.id} className="border-b border-border/50">
                  <td className="py-2.5 font-medium">{p.name}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatTotal(p.contractValue)}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatTotal(p.certifiedValue)}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatTotal(p.purchaseValue)}</td>
                  <td className={`py-2.5 text-right tabular-nums font-medium ${margin >= 20 ? "text-green-600" : margin >= 10 ? "text-amber-600" : "text-red-600"}`}>
                    {comparable ? `${margin.toFixed(1)}%` : "—"}
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
