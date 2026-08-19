/**
 * Ordence — Raise an invoice
 * Version: v0.94.0-alpha
 *
 * A server component that loads what is billable and hands it to the
 * client form. The form calls `raiseInvoiceFromOrder` — a `"use server"`
 * action — and never touches `server/invoicing/`, which is `server-only`.
 */

import Link from "next/link";
import { listInvoiceableOrders } from "@/server/actions/sales-invoices";
import { RaiseInvoice } from "@/components/invoices/raise-invoice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata = { title: "Raise an invoice · Ordence" };

export default async function NewInvoicePage() {
  const result = await listInvoiceableOrders();

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <Link href="/invoices" className="text-sm text-muted-foreground hover:underline">
          ← Invoices
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Raise an invoice</h1>
        <p className="text-sm text-muted-foreground">
          From a confirmed order. Prices, tax rates and the place of supply come from the
          order and are not recalculated here.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order and lines</CardTitle>
        </CardHeader>
        <CardContent>
          {result.ok ? (
            <RaiseInvoice orders={result.data} />
          ) : (
            <p className="text-sm text-destructive">{result.error}</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
