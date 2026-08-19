/**
 * Ordence — One receipt, and where it goes
 * Version: v0.98.0-alpha
 *
 * ⚠️ THE FORM IS ABOVE THE HISTORY. Whoever opens a receipt has come to
 * apply it, not to admire it.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { getReceiptAllocation } from "@/server/actions/sales-invoices";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AllocateReceipt } from "@/components/invoices/allocate-receipt";

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

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getReceiptAllocation({ receiptId: id });
  if (!result.ok) notFound();

  const { receipt, openInvoices } = result.data;
  const fullyApplied = receipt.unappliedMinor === "0";

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/receipts" className="text-sm text-muted-foreground hover:underline">
            ← Unapplied receipts
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tabular-nums">
            {receipt.receiptNumber}
          </h1>
          <p className="text-sm text-muted-foreground">
            {receipt.customerName ?? "—"} · received {receipt.receivedOn} ·{" "}
            {receipt.method.toUpperCase()}
            {receipt.instrumentRef ? ` · ${receipt.instrumentRef}` : ""}
          </p>
        </div>
        <Badge variant={receipt.status === "cleared" ? "secondary" : "outline"}>
          {receipt.status}
        </Badge>
      </div>

      <Card>
        <CardContent className="grid gap-3 py-4 text-sm sm:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Cash received</p>
            <p className="text-lg font-semibold tabular-nums">{inr(receipt.amountMinor)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">TDS withheld</p>
            <p className="text-lg font-semibold tabular-nums">
              {inr(receipt.tdsCreditMinor)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Applied</p>
            <p className="text-lg font-semibold tabular-nums">
              {inr(receipt.allocatedMinor)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Unapplied</p>
            <p className="text-lg font-semibold tabular-nums">
              {inr(receipt.unappliedMinor)}
            </p>
          </div>
        </CardContent>
      </Card>

      {receipt.tdsCreditMinor !== "0" && (
        <p className="rounded border-l-2 border-muted pl-3 text-sm text-muted-foreground">
          {/**
           * ⚠️ TDS SETTLES AN INVOICE AS SURELY AS CASH. The customer paid
           * it to the Government on our behalf. Treating it as a shortfall
           * is how a fully-settled account shows as overdue.
           */}
          {inr(receipt.tdsCreditMinor)} was withheld as TDS. That money was paid to the
          Government on your behalf and settles the invoice exactly as cash does.
        </p>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {fullyApplied ? "Fully applied" : "Apply this receipt"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {fullyApplied ? (
            <p className="text-sm text-muted-foreground">
              Every rupee on this receipt has been applied to an invoice. Nothing to do.
            </p>
          ) : (
            <AllocateReceipt
              receiptId={receipt.id}
              unappliedMinor={receipt.unappliedMinor}
              openInvoices={openInvoices}
            />
          )}
        </CardContent>
      </Card>

      <p className="text-sm">
        <Link
          href={`/companies/${receipt.companyId}/statement`}
          className="underline underline-offset-4"
        >
          Statement of account for this customer
        </Link>
      </p>
    </main>
  );
}
