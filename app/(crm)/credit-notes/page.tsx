/**
 * Ordence — The credit-note register
 * Version: v0.96.0-alpha
 *
 * ⚠️ IT LEADS WITH VALUE REVERSED, NOT A COUNT. Twelve credit notes
 * could be ₹1,200 of returns or ₹12 lakh of them, and only one of those
 * is a conversation with a sales manager.
 *
 * ⚠️ DRAFTS ARE COUNTED SEPARATELY AND NEVER ADDED INTO THE VALUE.
 * Nothing is reversed until a note is issued. A total that included
 * drafts would report money back that the customer still owes.
 *
 * ⚠️ THERE IS NO "NEW CREDIT NOTE" BUTTON ON THIS PAGE, DELIBERATELY.
 * Every credit note is raised from the invoice it reverses — see
 * `/invoices/[id]/credit`. A free-standing one is unreconcilable.
 */

import Link from "next/link";
import { listCreditNotes } from "@/server/actions/sales-invoices";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CREDIT_NOTE_REASON_META } from "@/lib/invoicing/credit-note";

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

export default async function CreditNotesPage() {
  const result = await listCreditNotes({ limit: 200 });

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Credit notes</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { rows, summary } = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Credit notes</h1>
        <p className="text-sm text-muted-foreground">
          Reversals of issued tax invoices, under Section 34(1). Raised from the invoice
          they reverse.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Value reversed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(summary.issuedValueMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              across {summary.issuedCount} issued {summary.issuedCount === 1 ? "note" : "notes"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Drafts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{summary.draftCount}</p>
            <p className="text-xs text-muted-foreground">
              nothing reversed, no numbers taken
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Where they come from
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              Open an invoice and choose{" "}
              <span className="font-medium">Raise a credit note</span>.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="overflow-x-auto py-4">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No credit notes yet. One is raised from the invoice it reverses.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Number</th>
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Against</th>
                  <th className="py-2 pr-3 font-medium">Customer</th>
                  <th className="py-2 pr-3 font-medium">Ground</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <Link href={`/credit-notes/${r.id}`} className="hover:underline">
                        {r.status === "draft" ? "Draft" : r.creditNoteNumber}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{r.noteDate}</td>
                    <td className="py-2 pr-3">
                      <Link href={`/invoices/${r.invoiceId}`} className="hover:underline">
                        {r.invoiceNumber}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">{r.customerLegalName ?? "—"}</td>
                    <td className="py-2 pr-3">
                      {CREDIT_NOTE_REASON_META[
                        r.reasonCode as keyof typeof CREDIT_NOTE_REASON_META
                      ]?.label ?? r.reasonCode}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={r.status === "issued" ? "secondary" : "outline"}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-2 text-right tabular-nums">{inr(r.totalMinor)}</td>
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
