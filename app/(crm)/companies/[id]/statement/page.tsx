/**
 * Ordence — ⭐ Statement of account, per customer
 * Version: v0.98.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DOCUMENT YOU SEND WHEN SOMEBODY SAYS "WE ALREADY PAID"
 * ══════════════════════════════════════════════════════════════════════
 * `getCustomerStatement()` and `lib/receivables/customer-ledger.ts` have
 * been finished and tested since Session 2, and nothing has ever rendered
 * them. Until now the answer to "what does this customer actually owe"
 * lived only in code.
 *
 * ⚠️ IT LIVES UNDER THE COMPANY, NOT UNDER `/statements`. That route is
 * already the P&L and balance sheet — a different document for a
 * different reader. Putting a customer statement there would mean two
 * unrelated things behind one word.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE NUMBERS THAT MUST NEVER BE NETTED INTO ONE
 * ══════════════════════════════════════════════════════════════════════
 *   • **Outstanding** — invoiced, due, unpaid
 *   • **Not yet due** — invoiced, not due yet. NOT bucket zero.
 *   • **Unapplied credit** — their money, sitting unallocated
 *
 * ⚠️ Netting unapplied credit against outstanding produces a smaller,
 * friendlier number that is wrong in the one conversation this page
 * exists for. The customer HAS paid it; we have not applied it. Showing
 * ₹0 owed hides our own filing failure, and showing the full amount owed
 * without mentioning the credit gets the statement disputed on the spot.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { getCustomerStatement } from "@/server/actions/sales-invoices";
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

const ENTRY_LABELS: Record<string, string> = {
  invoice: "Invoice",
  credit_note: "Credit note",
  receipt: "Receipt",
  allocation: "Allocation",
  bounce: "Payment returned",
};

export default async function CustomerStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ asOf?: string }>;
}) {
  const { id } = await params;
  const { asOf } = await searchParams;

  /**
   * ⚠️ `asOf` DEFAULTS TO TODAY AND IS OVERRIDABLE BY QUERY STRING.
   * Ageing is meaningless without a date, and the date somebody disputes
   * is usually a month end rather than today.
   */
  const result = await getCustomerStatement({
    companyId: id,
    asOf: asOf ?? new Date().toISOString().slice(0, 10),
  });

  if (!result.ok) notFound();

  const s = result.data;
  const hasUnappliedCredit = s.unappliedCreditMinor !== "0";

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        {/*
          ⭐ WAVE 10 — THIS POINTED AT `/companies/:id`, WHICH DOES NOT
          EXIST. A company has an edit screen and a statement, and no
          overview between them; the breadcrumb was written for a page
          that was never built. It goes to the edit screen, which is the
          only screen about this company there is.
        */}
        <Link
          href={`/companies/${id}/edit`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to the customer
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Statement of account</h1>
        <p className="text-sm text-muted-foreground tabular-nums">
          As at {s.asOf}
          {s.oldestDocumentDays > 0 &&
            ` · oldest open document is ${s.oldestDocumentDays} days old`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Overdue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(s.outstandingMinor)}</p>
            <p className="text-xs text-muted-foreground">past the due date</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Not yet due
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(s.notYetDueMinor)}</p>
            {/* Its own figure. A bill on 60-day terms raised 45 days ago is not late. */}
            <p className="text-xs text-muted-foreground">invoiced, within terms</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Unapplied credit
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(s.unappliedCreditMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {hasUnappliedCredit ? "their money, not yet allocated" : "nothing outstanding"}
            </p>
          </CardContent>
        </Card>
      </div>

      {hasUnappliedCredit && (
        <div className="rounded border-l-2 border-amber-500 bg-amber-50 p-4 text-sm">
          {/**
           * 🔴 NAMED AS OUR PROBLEM, NOT THEIRS. This is money the
           * customer has already paid that nobody has applied to an
           * invoice. Chasing them for it is how a paying customer is sent
           * a dunning letter.
           */}
          <p className="font-medium">
            {inr(s.unappliedCreditMinor)} has been received and not applied to any invoice.
          </p>
          <p className="mt-1 text-muted-foreground">
            Until it is allocated, the invoices it covers still show as unpaid and this
            customer can be chased for money they have already sent.{" "}
            <Link href="/receipts" className="underline underline-offset-4">
              Allocate it
            </Link>
            .
          </p>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Ageing</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {/* ⚠️ Aged from the DUE date, never the invoice date. */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Days past due</th>
                <th className="py-2 pr-3 text-right font-medium">Documents</th>
                <th className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {s.buckets.map((b) => (
                <tr key={b.label} className="border-b last:border-0">
                  <td className="py-2 pr-3">{b.label}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{b.documentCount}</td>
                  <td className="py-2 text-right tabular-nums">{inr(b.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pt-2 text-xs text-muted-foreground">
            Aged from the due date, not the invoice date. An invoice on 60-day terms raised
            45 days ago is not late.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Account activity</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {s.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has been billed to this customer yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Reference</th>
                  <th className="py-2 pr-3 text-right font-medium">Debit</th>
                  <th className="py-2 pr-3 text-right font-medium">Credit</th>
                  <th className="py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 tabular-nums">{r.entryDate}</td>
                    <td className="py-2 pr-3">
                      {ENTRY_LABELS[r.entryType] ?? r.entryType.replace(/_/g, " ")}
                    </td>
                    <td className="py-2 pr-3">{r.reference}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.debitMinor === "0" ? "—" : inr(r.debitMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.creditMinor === "0" ? "—" : inr(r.creditMinor)}
                    </td>
                    {/**
                     * ⭐ THE RUNNING BALANCE IS THE POINT OF THE TABLE.
                     * A statement without one is a list of documents; a
                     * customer disputing a figure walks down this column
                     * until they find the line they disagree with.
                     */}
                    <td className="py-2 text-right font-medium tabular-nums">
                      {inr(r.balanceMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2">
                  <td className="py-2 font-semibold" colSpan={5}>
                    Balance as at {s.asOf}
                  </td>
                  <td className="py-2 text-right font-semibold tabular-nums">
                    {inr(s.balanceMinor)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
