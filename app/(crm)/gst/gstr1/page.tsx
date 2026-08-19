/**
 * Ordence — ⭐ GSTR-1, built and checkable
 * Version: v0.98.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS SCREEN BUILDS THE RETURN. IT DOES NOT FILE IT.
 * ══════════════════════════════════════════════════════════════════════
 * Transmission needs a GSP, an API contract that changes, and credentials
 * against a GSTIN that does not exist yet. That is not a limitation to
 * apologise for: an accountant reconciles a built return against their
 * working papers BEFORE anything is transmitted, and a first filing is a
 * bad moment to also be debugging somebody's API.
 *
 * ⚠️ THE FIGURES ARE IN RUPEES, NOT PAISE, AND THAT IS DELIBERATE.
 * `lib/gstr1/build.ts` converts once, at the edge, because the portal
 * expects rupees with two decimals. Every other surface in this product
 * carries minor units; this one does not, and a reader comparing the two
 * needs to know which they are looking at.
 *
 * ⚠️ WARNINGS ARE SHOWN AT THE TOP AND NEVER SUPPRESS THE RETURN. A
 * return you cannot look at because it has a problem is a return nobody
 * can diagnose.
 */

import Link from "next/link";
import { buildGstr1Return } from "@/server/actions/sales-invoices";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/** ⚠️ Already rupees. Do not divide. */
function rs(value: string | null | undefined): string {
  return value === null || value === undefined ? "—" : value;
}

function previousMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed; this is last month already
  const d = new Date(Date.UTC(y, m, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function InvoiceTable({
  title,
  note,
  rows,
  showAgainst = false,
}: {
  title: string;
  note: string;
  rows: {
    gstin: string | null;
    customerName: string | null;
    number: string;
    date: string;
    placeOfSupply: string | null;
    reverseCharge: string;
    taxableValue: string;
    cgst: string;
    sgst: string;
    igst: string;
    total: string;
    againstInvoiceNumber?: string | null;
    againstInvoiceDate?: string | null;
  }[];
  showAgainst?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {title}{" "}
          <span className="font-normal text-muted-foreground">({rows.length})</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">{note}</p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing in this table this month.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">GSTIN</th>
                <th className="py-2 pr-3 font-medium">Customer</th>
                <th className="py-2 pr-3 font-medium">Number</th>
                <th className="py-2 pr-3 font-medium">Date</th>
                {showAgainst && <th className="py-2 pr-3 font-medium">Against</th>}
                <th className="py-2 pr-3 font-medium">POS</th>
                <th className="py-2 pr-3 font-medium">RC</th>
                <th className="py-2 pr-3 text-right font-medium">Taxable</th>
                <th className="py-2 pr-3 text-right font-medium">CGST</th>
                <th className="py-2 pr-3 text-right font-medium">SGST</th>
                <th className="py-2 pr-3 text-right font-medium">IGST</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.number}-${r.date}`} className="border-b last:border-0">
                  <td className="py-2 pr-3 tabular-nums">{r.gstin ?? "—"}</td>
                  <td className="py-2 pr-3">{r.customerName ?? "—"}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.number}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.date}</td>
                  {showAgainst && (
                    <td className="py-2 pr-3 tabular-nums">
                      {/* Rule 53 — the original document. Without it this is unmatched. */}
                      {r.againstInvoiceNumber ?? "🔴 missing"}
                    </td>
                  )}
                  <td className="py-2 pr-3 tabular-nums">{r.placeOfSupply ?? "—"}</td>
                  <td className="py-2 pr-3">{r.reverseCharge}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{rs(r.taxableValue)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{rs(r.cgst)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{rs(r.sgst)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{rs(r.igst)}</td>
                  <td className="py-2 text-right tabular-nums">{rs(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

export default async function Gstr1Page({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period } = await searchParams;
  /**
   * ⚠️ DEFAULTS TO LAST MONTH, NOT THIS ONE. GSTR-1 is filed for a
   * completed month. Opening on the current month shows a half-finished
   * return that changes under the reader all day, and somebody will
   * eventually reconcile against it.
   */
  const selected = period ?? previousMonth();
  const result = await buildGstr1Return({ period: selected });

  const months: string[] = [];
  {
    const [y0, m0] = previousMonth().split("-");
    const cursor = new Date(Date.UTC(Number(y0), Number(m0) - 1, 1));
    for (let i = 0; i < 12; i += 1) {
      months.push(
        `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`,
      );
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <Link href="/gst" className="text-sm text-muted-foreground hover:underline">
          ← GST
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">GSTR-1 — outward supplies</h1>
        <p className="text-sm text-muted-foreground">
          Built from issued invoices and credit notes. Reconcile this against your working
          papers before anything is filed.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {months.map((m) => (
          <Link
            key={m}
            href={`/gst/gstr1?period=${m}`}
            className={`rounded border px-3 py-1 text-sm tabular-nums ${
              m === selected ? "border-foreground font-medium" : "border-muted"
            }`}
          >
            {m}
          </Link>
        ))}
      </div>

      {!result.ok ? (
        <p className="text-sm text-destructive">{result.error}</p>
      ) : (
        <>
          {result.data.warnings.length > 0 && (
            <div className="rounded border-l-2 border-amber-500 bg-amber-50 p-4 text-sm">
              {/**
               * ⚠️ WARNINGS ARE RETURNED, NEVER THROWN — and rendered
               * above the figures. A return that refused to build because
               * one invoice lacks a place of supply is a return nobody can
               * diagnose; one that builds silently is worse.
               */}
              <p className="font-medium">
                {result.data.warnings.length} thing
                {result.data.warnings.length === 1 ? "" : "s"} to check before filing
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {result.data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Taxable value
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-semibold tabular-nums">
                  {rs(result.data.totals.taxableValue)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {result.data.totals.documentCount} documents
                </p>
              </CardContent>
            </Card>
            {/* Three heads, three ledgers. Never one combined figure. */}
            {(
              [
                ["CGST", result.data.totals.cgst],
                ["SGST / UTGST", result.data.totals.sgst],
                ["IGST", result.data.totals.igst],
              ] as const
            ).map(([label, value]) => (
              <Card key={label}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {label}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xl font-semibold tabular-nums">{rs(value)}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <p className="text-xs text-muted-foreground tabular-nums">
            Period {result.data.period} · GSTIN {result.data.gstin ?? "— not set —"} ·
            figures in rupees, as the portal expects
          </p>

          <InvoiceTable
            title="4A — B2B"
            note="Supplies to registered persons. A registered buyer is always B2B, whatever the value."
            rows={result.data.b2b}
          />
          <InvoiceTable
            title="5A — B2C Large"
            note="Unregistered, inter-State, above the threshold. Needs BOTH conditions — an intra-State supply of any size is never B2CL."
            rows={result.data.b2cl}
          />
          <InvoiceTable
            title="9B — Credit notes, registered (CDNR)"
            note="Rule 53 — each must name the original invoice, or it cannot be matched."
            rows={result.data.cdnr}
            showAgainst
          />
          <InvoiceTable
            title="9B — Credit notes, unregistered (CDNUR)"
            note="Reversals against unregistered recipients."
            rows={result.data.cdnur}
            showAgainst
          />

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                7 — B2C Small{" "}
                <span className="font-normal text-muted-foreground">
                  ({result.data.b2cs.length})
                </span>
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Summarised by place of supply and rate, never listed invoice by invoice.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {result.data.b2cs.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing in this table.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">POS</th>
                      <th className="py-2 pr-3 font-medium">Rate</th>
                      <th className="py-2 pr-3 text-right font-medium">Taxable</th>
                      <th className="py-2 pr-3 text-right font-medium">CGST</th>
                      <th className="py-2 pr-3 text-right font-medium">SGST</th>
                      <th className="py-2 text-right font-medium">IGST</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.b2cs.map((r) => (
                      <tr
                        key={`${r.placeOfSupply}-${r.taxRatePercent}`}
                        className="border-b last:border-0"
                      >
                        <td className="py-2 pr-3 tabular-nums">{r.placeOfSupply ?? "—"}</td>
                        <td className="py-2 pr-3 tabular-nums">{r.taxRatePercent}%</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {rs(r.taxableValue)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{rs(r.cgst)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{rs(r.sgst)}</td>
                        <td className="py-2 text-right tabular-nums">{rs(r.igst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                12 — HSN summary{" "}
                <span className="font-normal text-muted-foreground">
                  ({result.data.hsn.length})
                </span>
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Credit notes subtract here. A month with returns shows a smaller quantity
                than the invoices alone.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {result.data.hsn.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing in this table.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">HSN/SAC</th>
                      <th className="py-2 pr-3 font-medium">Description</th>
                      <th className="py-2 pr-3 font-medium">UQC</th>
                      <th className="py-2 pr-3 text-right font-medium">Qty</th>
                      <th className="py-2 pr-3 text-right font-medium">Rate</th>
                      <th className="py-2 pr-3 text-right font-medium">Taxable</th>
                      <th className="py-2 text-right font-medium">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.hsn.map((h) => (
                      <tr
                        key={`${h.hsnSacCode}-${h.uom}-${h.taxRatePercent}`}
                        className="border-b last:border-0"
                      >
                        <td className="py-2 pr-3 tabular-nums">{h.hsnSacCode}</td>
                        <td className="py-2 pr-3">{h.description}</td>
                        <td className="py-2 pr-3">{h.uom}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{h.quantity}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {h.taxRatePercent}%
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {rs(h.taxableValue)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {rs(h.cgst)} / {rs(h.sgst)} / {rs(h.igst)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">13 — Documents issued</CardTitle>
              <p className="text-xs text-muted-foreground">
                The series, with gaps declared. A gap nobody declared is a question an
                officer asks and nobody can answer three years later.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">From</th>
                    <th className="py-2 pr-3 font-medium">To</th>
                    <th className="py-2 pr-3 text-right font-medium">Total</th>
                    <th className="py-2 text-right font-medium">Cancelled</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.docIssued.map((d) => (
                    <tr key={`${d.from}-${d.to}`} className="border-b last:border-0">
                      <td className="py-2 pr-3 tabular-nums">{d.from}</td>
                      <td className="py-2 pr-3 tabular-nums">{d.to}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{d.totalNumber}</td>
                      <td className="py-2 text-right tabular-nums">{d.cancelled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <div className="rounded border p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">This return has not been filed.</p>
            <p className="mt-1">
              Transmission needs a GSP account against a live GSTIN. Until then this page is
              the artefact you or your CA reconcile against — which is the step that should
              happen before filing anyway.
            </p>
          </div>
        </>
      )}
    </main>
  );
}
