/**
 * Ordence — ⭐⭐ GOODS RETURNED
 * Version: v1.4.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO COUNTERS AT THE TOP ARE NEVER SUMMED
 * ══════════════════════════════════════════════════════════════════════
 * **Lapsed** is GST already gone — the s.34(2) window closed and the tax
 * on those sales cannot be recovered. **At risk** is GST somebody can
 * still save by raising a credit note this month. A single "returns
 * outstanding" figure hides the half that is still actionable.
 *
 * ⚠️ AND THE VERDICT IS COMPUTED FROM THE STORED DATE AND TODAY, on
 * every render. A stored flag needs a nightly job, and the morning the
 * job does not run the screen says a return is still adjustable on the
 * day it stopped being adjustable.
 */

import Link from "next/link";
import {
  getGoodsReturns,
  getReturnableInvoices,
} from "@/server/actions/goods-returns";
import { getWarehouseOptions } from "@/server/actions/batches";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ReceiveReturn } from "@/components/inventory/receive-return";

export const dynamic = "force-dynamic";

export const metadata = { title: "Goods returned · Ordence" };

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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function ReturnsPage() {
  const [returns, invoices, whs] = await Promise.all([
    getGoodsReturns(),
    getReturnableInvoices(),
    getWarehouseOptions(),
  ]);

  if (!returns.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Goods returned</h1>
        <p className="text-sm text-destructive">{returns.error}</p>
      </main>
    );
  }

  const { rows, atRisk, lapsed, itcReversalTotalMinor } = returns.data;
  const warehouses = whs.ok ? whs.data : [];
  const day = today();

  /** ⚠️ Sorted by how little time is left, not by date. */
  const candidates = invoices.ok
    ? [...invoices.data.rows].sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 25)
    : [];

  const hasQuarantine = warehouses.some((w) => w.type === "quarantine");

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Goods returned</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * ⭐ THE THREE FACTS, NAMED. Most software merges them and the
           * merge of (1) and (3) is what sends damaged stock to the next
           * customer.
           */}
          Three separate things happen when goods come back: the stock arrives,
          the customer owes less, and some of what arrived cannot be sold again.
        </p>
      </div>

      {!hasQuarantine && (
        <div className="rounded border-l-2 border-amber-500 bg-amber-50 p-3 text-sm">
          <p className="font-medium">
            {/**
             * 🔴 NAMED BEFORE IT BLOCKS SOMEBODY. Without a quarantine
             * location there is nowhere lawful for damaged stock to land,
             * and the database refuses to put it in a selling warehouse.
             */}
            There is no quarantine warehouse set up.
          </p>
          <p className="mt-1 text-muted-foreground">
            Damaged and expired returns cannot be put back into a selling
            location — the database refuses it, because that stock would be
            picked for the next customer. Create a warehouse of type
            &ldquo;quarantine&rdquo; before the first damaged return arrives.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className={lapsed > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tax adjustment lapsed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{lapsed}</p>
            <p className="text-xs text-muted-foreground">
              {/* 🔴 Money already gone. s.34(2) closed. */}
              The s.34(2) window closed. A credit note still reduces what the
              customer owes; the GST on the original sale cannot be recovered.
            </p>
          </CardContent>
        </Card>

        <Card className={atRisk > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Closing within 30 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{atRisk}</p>
            <p className="text-xs text-muted-foreground">
              {/* ⚠️ Never added to the figure beside it. */}
              Still saveable. Raise the credit notes.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Input tax credit to reverse
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(itcReversalTotalMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⭐ s.17(5)(h). On returns that came back expired or as
               * scrap — those goods will be destroyed and the credit
               * claimed on them is not available.
               */}
              On goods that came back expired or as scrap. Section 17(5)(h)
              blocks the credit on anything written off.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Invoices goods can come back against{" "}
            <span className="font-normal text-muted-foreground">
              ({candidates.length})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * ⚠️ Sorted by time remaining, not by invoice date. The
             * oldest invoice is the one whose tax lapses first.
             */}
            Ordered by how long the tax adjustment has left, not by date.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No issued goods invoices yet.
            </p>
          ) : (
            candidates.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-start justify-between gap-3 border-b pb-4 last:border-0"
              >
                <div>
                  <p className="font-medium">
                    <Link href={`/invoices/${c.id}`} className="underline">
                      {c.invoiceNumber}
                    </Link>{" "}
                    <span className="text-muted-foreground">
                      {c.customerLegalName ?? "—"}
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {c.invoiceDate} · {inr(c.totalMinor)}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {c.taxRecoverable
                      ? `Tax adjustable until ${c.deadline} · ${c.daysLeft} days`
                      : `Tax adjustment lapsed on ${c.deadline}`}
                  </p>
                </div>
                <ReceiveReturn
                  invoiceId={c.id}
                  invoiceNumber={c.invoiceNumber}
                  invoiceDate={c.invoiceDate}
                  warehouses={warehouses}
                  today={day}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Returns received{" "}
            <span className="font-normal text-muted-foreground">({rows.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing has come back yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Return</th>
                  <th className="py-2 pr-3 font-medium">Against</th>
                  <th className="py-2 pr-3 text-right font-medium">Value</th>
                  <th className="py-2 pr-3 text-right font-medium">ITC reversal</th>
                  <th className="py-2 pr-3 font-medium">Unsaleable</th>
                  <th className="py-2 pr-3 font-medium">Tax adjustment</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <Link href={`/inventory/returns/${r.id}`} className="underline">
                        {r.returnNo}
                      </Link>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {r.returnDate} · {r.reason.replace(/_/g, " ")}
                      </p>
                    </td>
                    <td className="py-2 pr-3">
                      {r.invoiceNumber ?? "—"}
                      <p className="text-xs text-muted-foreground">
                        {r.companyName ?? ""}
                      </p>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(r.taxableValueMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.itcReversalMinor === "0" ? "—" : inr(r.itcReversalMinor)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {r.unsaleableLines > 0 ? (
                        <Badge variant="secondary">
                          {r.unsaleableLines} of {r.lineCount}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {r.taxRecoverable === null ? (
                        <span className="text-muted-foreground">no invoice</span>
                      ) : (
                        <Badge
                          variant={r.taxRecoverable ? "outline" : "destructive"}
                        >
                          {r.deadlineLabel}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/inventory/batches" className="underline">
          Batches &amp; expiry
        </Link>{" "}
        ·{" "}
        <Link href="/inventory/serials" className="underline">
          Serial numbers
        </Link>
      </p>
    </main>
  );
}
