/**
 * Ordence — Money received and not yet applied
 * Version: v0.98.0-alpha
 *
 * 🔴 THE REGISTER OF OUR OWN FILING FAILURES, AND THAT IS THE POINT.
 *    Every row here is money a customer has already sent that no invoice
 *    has been told about. Each one makes an invoice look unpaid and a
 *    customer look overdue — so the dunning ladder chases somebody who
 *    paid, which is the fastest way to lose them.
 *
 * ⚠️ IT LEADS WITH THE UNAPPLIED VALUE, NOT A COUNT. Twelve receipts
 * could be ₹1,200 of rounding or ₹12 lakh sitting idle, and only one of
 * those needs doing this afternoon.
 */

import Link from "next/link";
import { listUnappliedReceipts } from "@/server/actions/sales-invoices";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

export default async function ReceiptsPage() {
  const result = await listUnappliedReceipts({ limit: 200 });

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Unapplied receipts</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { rows, summary } = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Unapplied receipts</h1>
        <p className="text-sm text-muted-foreground">
          Money received that no invoice has been credited with yet.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Sitting unapplied
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(summary.unappliedTotalMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              across {summary.receiptCount} receipt{summary.receiptCount === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Why it matters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              Until a receipt is applied, the invoice it covers still reads as unpaid — and
              the customer can be chased for money they have already sent.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="overflow-x-auto py-4">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {/* Genuinely good news, said plainly rather than as an empty table. */}
              Nothing is sitting unapplied. Every receipt has been matched to an invoice.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Receipt</th>
                  <th className="py-2 pr-3 font-medium">Received</th>
                  <th className="py-2 pr-3 font-medium">Customer</th>
                  <th className="py-2 pr-3 font-medium">Method</th>
                  <th className="py-2 pr-3 text-right font-medium">Amount</th>
                  <th className="py-2 pr-3 text-right font-medium">TDS</th>
                  <th className="py-2 text-right font-medium">Unapplied</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <Link href={`/receipts/${r.id}`} className="hover:underline">
                        {r.receiptNumber}
                      </Link>
                      {r.instrumentRef && (
                        <span className="block text-xs text-muted-foreground">
                          {r.instrumentRef}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{r.receivedOn}</td>
                    <td className="py-2 pr-3">{r.customerName ?? "—"}</td>
                    <td className="py-2 pr-3 uppercase">{r.method}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(r.amountMinor)}
                    </td>
                    {/* ⚠️ TDS is money received — the customer paid it to the Government for us. */}
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.tdsCreditMinor === "0" ? "—" : inr(r.tdsCreditMinor)}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">
                      {inr(r.unappliedMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
