/**
 * Ordence — One invoice, and whether it is legally complete
 * Version: v0.93.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE RULE 46 PANEL IS THE POINT OF THIS SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * `checkRule46()` has existed since Phase 32 and nothing has ever
 * rendered it. An invoice missing a field Rule 46 requires is a document
 * the customer's accountant rejects — and until now the only way to find
 * that out was to send it and wait for the phone call.
 *
 * ⚠️ THE PANEL REPORTS; IT DOES NOT REFUSE. A draft is legitimately
 * incomplete — that is what a draft is. The refusal belongs at ISSUE.
 * A screen that blocked on a draft's findings would be unusable on the
 * first day of building an invoice.
 *
 * ⚠️ AND IT SHOWS THE CLAUSE. "Missing field" teaches nobody anything;
 * "Rule 46(g) — HSN or SAC code" can be looked up, argued with, and
 * checked against the Rules by the person who has to defend it.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { getInvoiceDetail } from "@/server/actions/sales-invoices";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InvoiceActions } from "@/components/invoices/invoice-actions";
import { SettleInvoice } from "@/components/invoices/settle-invoice";

export const dynamic = "force-dynamic";

function inr(minorUnits: string | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return "₹0.00";
  const raw = String(minorUnits);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

function pct(bps: number | null): string {
  if (bps === null) return "—";
  return bps % 100 === 0 ? `${bps / 100}%` : `${(bps / 100).toFixed(2)}%`;
}

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getInvoiceDetail({ invoiceId: id });

  /**
   * ⚠️ `notFound()`, NOT an error page. A tenant asking for an invoice
   * that is not theirs and one asking for an invoice that does not exist
   * must be indistinguishable — a different response to each tells a
   * prober which ids are real.
   */
  if (!result.ok) notFound();

  const { invoice, lines, rule46 } = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/invoices" className="text-sm text-muted-foreground hover:underline">
            ← Invoices
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tabular-nums">
            {invoice.status === "draft" ? "Draft invoice" : invoice.invoiceNumber}
          </h1>
          <p className="text-sm text-muted-foreground">
            {invoice.customerLegalName ?? "No customer name captured"}
            {invoice.customerGstin ? ` · ${invoice.customerGstin}` : " · unregistered"}
          </p>
        </div>
        <Badge variant={invoice.status === "paid" ? "secondary" : "outline"}>
          {invoice.status.replace(/_/g, " ")}
        </Badge>
      </div>

      {/* ⭐ THE LEGAL-COMPLETENESS PANEL */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Rule 46 — {rule46.ok ? "complete" : "incomplete"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {rule46.blocking.length === 0 && rule46.advisory.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every field Rule 46 requires is present.
            </p>
          ) : (
            <>
              {rule46.blocking.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Must be fixed before issuing
                  </p>
                  {rule46.blocking.map((f) => (
                    <div key={`${f.rule}-${f.field}`} className="rounded border-l-2 border-destructive pl-3">
                      <p className="text-sm font-medium">
                        {f.rule} — {f.message}
                      </p>
                      <p className="text-xs text-muted-foreground">{f.remedy}</p>
                    </div>
                  ))}
                </div>
              )}
              {rule46.advisory.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Worth fixing
                  </p>
                  {rule46.advisory.map((f) => (
                    <div key={`${f.rule}-${f.field}`} className="rounded border-l-2 border-muted pl-3">
                      <p className="text-sm">
                        {f.rule} — {f.message}
                      </p>
                      <p className="text-xs text-muted-foreground">{f.remedy}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/**
        * ⭐ THE ACTIONS SIT ABOVE THE LINES, NOT BURIED BELOW THE TOTALS.
        *
        * ⚠️ Whoever opens an invoice has come to DO something — issue it,
        * or record the payment that just landed. Making them scroll past
        * every line to find the button is how a screen that technically
        * works still gets called unusable.
        */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <InvoiceActions
            invoiceId={invoice.id}
            status={invoice.status}
            hasBlockingFindings={rule46.blocking.length > 0}
            receivedMinor={invoice.receivedMinor}
          />
          {/**
           * ⚠️ A DRAFT CANNOT BE SETTLED, AND THE FORM IS NOT SHOWN AT
           * ALL RATHER THAN SHOWN DISABLED. Money against a document the
           * customer has never seen is a data-entry error, not a payment
           * — the action refuses it, and offering the form invites it.
           */}
          {invoice.status !== "draft" && invoice.status !== "cancelled" && (
            <SettleInvoice
              invoiceId={invoice.id}
              companyId={invoice.companyId}
              outstandingMinor={invoice.outstandingMinor}
            />
          )}
          {/**
           * ⭐ THE ONLY LAWFUL CORRECTION TO AN ISSUED INVOICE.
           *
           * ⚠️ IT IS A LINK, NOT A BUTTON THAT ACTS. Choosing which
           * lines come back and on what statutory ground is a form, and
           * a one-click "credit this invoice" would make the full
           * reversal the default outcome of a mis-click on a document
           * the customer is holding.
           *
           * ⚠️ AND IT IS ABSENT ON A DRAFT rather than disabled. A draft
           * is corrected by editing it — offering the credit route
           * teaches the wrong habit on the invoice where it is cheapest
           * to learn.
           */}
          {invoice.status !== "draft" && invoice.status !== "cancelled" && (
            <Link
              href={`/invoices/${invoice.id}/credit`}
              className="inline-block text-sm underline underline-offset-4"
            >
              Raise a credit note against this invoice
            </Link>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">HSN/SAC</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Rate</th>
                <th className="py-2 pr-3 text-right font-medium">Taxable</th>
                <th className="py-2 pr-3 text-right font-medium">GST</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 tabular-nums">{l.lineNo}</td>
                  <td className="py-2 pr-3">{l.description}</td>
                  <td className="py-2 pr-3 tabular-nums">{l.hsnSacCode ?? "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {l.quantity} {l.uom}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pct(l.taxRateBps)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{inr(l.taxableValueMinor)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {inr(
                      String(
                        BigInt(l.cgstMinor) + BigInt(l.sgstMinor) + BigInt(l.igstMinor),
                      ),
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{inr(l.lineTotalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-1 py-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Taxable value</span>
            <span className="tabular-nums">{inr(invoice.taxableValueMinor)}</span>
          </div>
          {/**
           * ⚠️ THE TAX HEADS ARE SHOWN SEPARATELY AND NOT SUMMED INTO
           * "GST". A customer's accountant reconciles CGST, SGST and IGST
           * against three different ledgers, and a single combined figure
           * makes them do the split by hand from a document that already
           * knew the answer.
           */}
          {invoice.igstMinor !== "0" ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">IGST</span>
              <span className="tabular-nums">{inr(invoice.igstMinor)}</span>
            </div>
          ) : (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">CGST</span>
                <span className="tabular-nums">{inr(invoice.cgstMinor)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {invoice.isUnionTerritory ? "UTGST" : "SGST"}
                </span>
                <span className="tabular-nums">{inr(invoice.sgstMinor)}</span>
              </div>
            </>
          )}
          {invoice.roundOffMinor !== "0" && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Round off</span>
              <span className="tabular-nums">{inr(invoice.roundOffMinor)}</span>
            </div>
          )}
          <div className="flex justify-between border-t pt-2 font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{inr(invoice.totalMinor)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Received</span>
            <span className="tabular-nums">{inr(invoice.receivedMinor)}</span>
          </div>
          <div className="flex justify-between font-medium">
            <span>Outstanding</span>
            <span className="tabular-nums">{inr(invoice.outstandingMinor)}</span>
          </div>
          {invoice.isReverseCharge && (
            <p className="pt-2 text-xs text-muted-foreground">
              {/* Shown and not collected — the recipient pays it direct. */}
              Tax payable on reverse charge. Not collected on this invoice.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
