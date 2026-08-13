/**
 * Ordence — ⭐ Sales → the books
 * Version: v0.99.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GAP THIS SCREEN EXISTS TO CLOSE
 * ══════════════════════════════════════════════════════════════════════
 * `server/tally/exporter.ts` has said since Phase 37 that the source is
 * the ledger and only the ledger. It is right — and it exposed that the
 * sales invoice subsystem built across Phases 49–57 posted NOTHING to
 * `transactions` / `journal_entries`.
 *
 * So every sales invoice raised before v0.99.0 is missing from the P&L,
 * the balance sheet, the trial balance, the GST output liability and the
 * Tally export. The documents were right the whole time. The books had
 * never been told.
 *
 * ⚠️ THIS PAGE IS BOTH HALVES ON PURPOSE — the mapping and the backlog.
 * Splitting them means somebody maps nine ledgers, sees a success
 * message, and never learns there are two hundred documents waiting.
 */

import Link from "next/link";
import {
  getSalesPostingSetup,
  getSalesPostingBacklog,
} from "@/server/actions/sales-posting";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PostingSetup, PostBacklogButton } from "@/components/invoices/posting-setup";

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

const KIND_LABELS: Record<string, string> = {
  invoice: "Sales invoice",
  credit_note: "Credit note",
  receipt: "Receipt",
  purchase: "Vendor bill",
  ra_bill: "RA bill",
};

export default async function SalesPostingPage() {
  const [setup, backlog] = await Promise.all([
    getSalesPostingSetup(),
    getSalesPostingBacklog(),
  ]);

  if (!setup.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Sales posting</h1>
        <p className="text-sm text-destructive">{setup.error}</p>
      </main>
    );
  }

  const rows = backlog.ok ? backlog.data.rows : [];
  const backlogTotal = backlog.ok ? backlog.data.totalMinor : "0";

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link href="/accounting" className="text-sm text-muted-foreground hover:underline">
          ← Accounting
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Sales posting</h1>
        <p className="text-sm text-muted-foreground">
          Which ledger each part of an invoice, credit note and receipt lands in — and
          anything issued that the books have not been told about yet.
        </p>
      </div>

      {setup.data.unmappedCount > 0 && (
        <div className="rounded border-l-2 border-destructive bg-red-50 p-4 text-sm">
          {/**
           * 🔴 STATED IN TERMS OF CONSEQUENCE, NOT CONFIGURATION.
           * "4 roles unmapped" means nothing to the person who has to act
           * on it. "Your P&L is missing this revenue" does.
           */}
          <p className="font-medium">
            {setup.data.unmappedCount} of {setup.data.roles.length} roles are not mapped.
          </p>
          <p className="mt-1 text-muted-foreground">
            Until they are, issued invoices do not reach your P&amp;L, your balance sheet,
            your trial balance or the Tally export — the export reads the ledger and only
            the ledger. Nothing is lost; it waits in the backlog below.
          </p>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Where each part posts</CardTitle>
        </CardHeader>
        <CardContent>
          <PostingSetup roles={setup.data.roles} ledgers={setup.data.ledgers} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Waiting to be posted{" "}
            <span className="font-normal text-muted-foreground">
              ({rows.length} · {inr(backlogTotal)})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <PostBacklogButton count={rows.length} />

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Everything issued is in the books.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Document</th>
                    <th className="py-2 pr-3 font-medium">Number</th>
                    <th className="py-2 pr-3 font-medium">Date</th>
                    <th className="py-2 pr-3 font-medium">Customer</th>
                    <th className="py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 200).map((r) => (
                    <tr key={`${r.kind}-${r.id}`} className="border-b last:border-0">
                      <td className="py-2 pr-3">{KIND_LABELS[r.kind] ?? r.kind}</td>
                      <td className="py-2 pr-3 tabular-nums">{r.number}</td>
                      <td className="py-2 pr-3 tabular-nums">{r.date}</td>
                      <td className="py-2 pr-3">{r.customerName ?? "—"}</td>
                      <td className="py-2 text-right tabular-nums">{inr(r.amountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 200 && (
                <p className="pt-2 text-xs text-muted-foreground">
                  {/* ⚠️ Said out loud. A silent cap reads as "that is all of them". */}
                  Showing the oldest 200 of {rows.length}. The button posts all of them.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
