/**
 * Ordence — Sales invoices
 * Version: v0.93.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THIS PAGE LEADS WITH, AND WHY IT IS NOT A COUNT
 * ══════════════════════════════════════════════════════════════════════
 * An invoice is money somebody promised to send. So the figure at the top
 * is not "how many invoices" — it is **how much is overdue**, because that
 * is the only number on the screen that costs somebody a phone call this
 * morning.
 *
 * ⚠️ OVERDUE IS A VALUE, NOT A COUNT. "Six invoices overdue" and "₹41 lakh
 * overdue" are the same six rows and completely different mornings. A
 * count treats a ₹5,000 invoice and a ₹40 lakh invoice as equal, and the
 * one that gets chased is whichever sits at the top of the list.
 *
 * ⚠️ NOTHING ON THIS PAGE COMPUTES TAX OR RE-DERIVES A TOTAL. Every figure
 * was decided when the invoice was raised and frozen when it was issued. A
 * screen that recomputes is a screen that can disagree with the document
 * the customer is holding.
 *
 * ⚠️ AND "OVERDUE" IS MEASURED FROM THE DUE DATE, NEVER THE INVOICE DATE.
 * An invoice on 60-day terms raised 45 days ago is not late. Ageing it from
 * the invoice date makes somebody ring a customer who owes nothing yet —
 * the one relationship-damaging call in the whole process, and the one that
 * should never have happened.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listInvoices } from "@/server/actions/sales-invoices";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Invoices · Ordence" };

/**
 * Paise → `₹1,23,456.78`, with Indian digit grouping.
 *
 * ⚠️ STRING ARITHMETIC, NOT `Number(x) / 100`. The value arrives as digits
 * precisely because a crore in paise is past the point where a float can
 * be trusted, and converting it here to make it pretty would undo that on
 * the largest invoice of the year.
 */
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

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  issued: "Issued",
  part_paid: "Part paid",
  paid: "Paid",
  cancelled: "Cancelled",
};

/**
 * ⚠️ `cancelled` IS NOT STYLED AS AN ERROR AND `paid` IS NOT STYLED AS A
 * SUCCESS BANNER. Both are ordinary outcomes. Colour here means "needs
 * attention", so only overdue earns it — otherwise the page is a wall of
 * red and the genuinely late invoice hides among the settled ones.
 */
function statusTone(status: string, daysOverdue: number): "destructive" | "secondary" | "outline" {
  if (daysOverdue > 0 && status !== "paid" && status !== "cancelled") return "destructive";
  if (status === "paid") return "secondary";
  return "outline";
}

async function InvoiceRegister() {
  const result = await listInvoices({ limit: 200 });

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">{result.error}</CardContent>
      </Card>
    );
  }

  const { rows, summary } = result.data;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {/**
         * ⭐ OVERDUE FIRST, AND ALONE IN ITS EMPHASIS. The other two tiles
         * are context; this one is the reason to open the page.
         */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Overdue</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(summary.overdueMinor)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.overdueCount === 0
                ? "Nothing past its due date."
                : `${summary.overdueCount} invoice${summary.overdueCount === 1 ? "" : "s"} past due`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Outstanding</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(summary.outstandingMinor)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Issued and not yet settled</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Drafts</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{summary.draftCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {/* A draft is not a document until it is issued. */}
              Not yet issued — no number assigned
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invoice register</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-sm text-muted-foreground">
              No invoices yet.{" "}
              <Link href="/invoices/new" className="underline">
                Raise one from a confirmed order
              </Link>
              .
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Number</th>
                    <th className="py-2 pr-4 font-medium">Customer</th>
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">Due</th>
                    <th className="py-2 pr-4 text-right font-medium">Total</th>
                    <th className="py-2 pr-4 text-right font-medium">Outstanding</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">
                        <Link href={`/invoices/${row.id}`} className="hover:underline">
                          {row.invoiceNumber}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">{row.customerLegalName ?? "—"}</td>
                      <td className="py-2 pr-4 tabular-nums">{row.invoiceDate}</td>
                      <td className="py-2 pr-4 tabular-nums">{row.dueDate ?? "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{inr(row.totalMinor)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {inr(row.outstandingMinor)}
                      </td>
                      <td className="py-2">
                        <Badge variant={statusTone(row.status, row.daysOverdue)}>
                          {STATUS_LABEL[row.status] ?? row.status}
                          {row.daysOverdue > 0 && row.status !== "paid" && row.status !== "cancelled"
                            ? ` · ${row.daysOverdue}d`
                            : ""}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function InvoicesPage() {
  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Invoices</h1>
          <p className="text-sm text-muted-foreground">
            Tax invoices raised against confirmed orders, and what is still owed on them.
          </p>
        </div>
        <Link
          href="/invoices/new"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Raise an invoice
        </Link>
      </div>

      <Suspense
        fallback={<Card><CardContent className="py-8 text-sm text-muted-foreground">Loading…</CardContent></Card>}
      >
        <InvoiceRegister />
      </Suspense>
    </main>
  );
}
