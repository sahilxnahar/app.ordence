/**
 * Ordence — ⭐⭐ ONE PURCHASE INVOICE, LINE BY LINE, WITH THE ITC VERDICT
 * Version: v1.78.0-alpha · Wave 10
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `getPurchaseInvoice` RETURNS THE ONE THING THE LIST CANNOT SHOW AND
 *    HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * The purchases list shows an invoice's totals. The decision that
 * actually matters is per LINE: which lines carry recoverable tax, which
 * are blocked by Section 17(5), under which statutory reference, and what
 * the note says.
 *
 * An invoice whose header says "ITC blocked ₹40,000" and cannot say WHICH
 * line is where a dispute with the CA starts, and the action that answers
 * it was written and never called.
 *
 * ⚠️ ALSO WHERE `recordItcMovement` LIVES. A reversal is always about a
 * specific invoice for a specific statutory reason , Rule 37 at 180 days,
 * Rule 42 on common credit, a credit note received , and recording one
 * from a list of periods would mean choosing the invoice from memory.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ReceiptText } from "lucide-react";

import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import { getPurchaseInvoice, recordItcMovement } from "@/server/actions/purchases";
import { getRegistrations } from "@/server/actions/gst";
import { Badge } from "@/components/ui/badge";
import { ItcMovementForm } from "./itc-movement-form";

export const dynamic = "force-dynamic";

function inr(minor: string | null | undefined): string {
  if (!minor) return "₹0.00";
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

export default async function PurchaseInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePageContext();

  const [result, registrations] = await Promise.all([
    getPurchaseInvoice(id),
    getRegistrations(),
  ]);

  if (!result.ok) notFound();
  const { invoice, lines } = result.data;

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const canReverse = can(subject, "purchases:reverse_itc");

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="space-y-3">
        <Link
          href="/purchases"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to purchases
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <ReceiptText className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              {invoice.invoiceNumber}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {invoice.invoiceDate}
              {invoice.supplierGstin ? ` · ${invoice.supplierGstin}` : " · no supplier GSTIN"}
              {invoice.taxPeriod ? ` · period ${invoice.taxPeriod}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {invoice.isReverseCharge && <Badge variant="outline">Reverse charge</Badge>}
            {invoice.isTdsDeductible && <Badge variant="outline">TDS</Badge>}
            <Badge variant="secondary">{invoice.status}</Badge>
          </div>
        </div>
      </div>

      <dl className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Taxable value</dt>
          <dd className="font-semibold tabular-nums">{inr(invoice.taxableValueMinor)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Total</dt>
          <dd className="font-semibold tabular-nums">{inr(invoice.totalMinor)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">ITC eligible</dt>
          <dd className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
            {inr(invoice.itcEligibleTaxMinor)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">ITC blocked</dt>
          <dd className="font-semibold tabular-nums text-destructive">
            {inr(invoice.itcBlockedTaxMinor)}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="lines-heading" className="space-y-3">
        <h2 id="lines-heading" className="text-lg font-semibold">
          Lines
        </h2>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">#</th>
                <th scope="col" className="px-3 py-2 font-medium">Description</th>
                <th scope="col" className="px-3 py-2 font-medium">HSN/SAC</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Taxable</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Rate</th>
                <th scope="col" className="px-3 py-2 font-medium">ITC</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-t align-top">
                  <td className="px-3 py-2 tabular-nums">{line.lineNumber}</td>
                  <td className="px-3 py-2">
                    {line.description}
                    <span className="block text-xs text-muted-foreground">
                      {line.itcPurpose.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{line.hsnSacCode ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {inr(line.taxableValueMinor)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {(line.rateBps / 100).toFixed(2)}%
                  </td>
                  <td className="px-3 py-2">
                    {/*
                      ⭐ THE VERDICT AND ITS STATUTORY REFERENCE, TOGETHER.
                      "Blocked" without the section is an assertion; with
                      it, it is something the CA can check.
                    */}
                    <span
                      className={
                        line.itcEligibility === "eligible"
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-destructive"
                      }
                    >
                      {line.itcEligibility.replace(/_/g, " ")}
                    </span>
                    {line.itcBlockReason && (
                      <span className="block text-xs text-muted-foreground">
                        {line.itcBlockReason.replace(/_/g, " ")}
                        {line.itcStatutoryRef ? ` · ${line.itcStatutoryRef}` : ""}
                      </span>
                    )}
                    <span className="block text-xs tabular-nums text-muted-foreground">
                      eligible {inr(line.itcEligibleTaxMinor)} · blocked{" "}
                      {inr(line.itcBlockedTaxMinor)}
                    </span>
                    {line.itcNote && (
                      <span className="block text-xs text-muted-foreground">{line.itcNote}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canReverse && (
        <ItcMovementForm
          invoiceId={invoice.id}
          vendorId={invoice.vendorId}
          taxPeriod={invoice.taxPeriod}
          lines={lines.map((line) => ({ id: line.id, label: `${line.lineNumber}. ${line.description}` }))}
          registrations={
            registrations.ok
              ? registrations.data.rows.map((r) => ({ id: r.id, label: r.gstin }))
              : []
          }
          record={recordItcMovement}
        />
      )}
    </main>
  );
}
