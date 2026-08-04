/**
 * Ordence — Sales orders
 * Version: v0.39.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WAVE 3 — THE KEYSTONE SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * An order is a promise with a date on it. So the thing this page leads
 * with is not a count and not a total — it is the promises that are LATE,
 * because that is the only figure on the screen that costs somebody a
 * phone call this morning.
 *
 * ⚠️ THE OVERDUE FIGURE IS A VALUE, NOT A COUNT. "Six orders overdue" and
 * "₹41 lakh overdue" are the same six rows and completely different
 * meetings. A count treats a ₹5,000 order and a ₹40 lakh order as equal,
 * and the one that gets chased is whichever is at the top of the list.
 *
 * ⚠️ COMPLETION IS VALUE-WEIGHTED, NEVER LINE-COUNTED. An order with one
 * ₹50 line dispatched and one ₹50,00,000 line outstanding is not half
 * done. `completionPercent` divides in bigint paise for exactly this
 * reason — see `lib/orders/pricing.ts`.
 *
 * ⚠️ NOTHING ON THIS PAGE COMPUTES TAX OR RE-PRICES A LINE. Every figure
 * shown was decided once at order entry and stored. A screen that
 * recomputes is a screen that can disagree with the document the customer
 * is holding.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listOrders } from "@/server/actions/orders";
import { completionPercent } from "@/lib/orders/pricing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sales orders · Ordence" };

function inr(minorUnits: string | bigint | null | undefined): string {
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

/** Statuses in which an order is a live commitment somebody is waiting on. */
const LIVE = new Set(["confirmed", "partially_fulfilled", "on_hold"]);

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Awaiting approval",
  confirmed: "Confirmed",
  partially_fulfilled: "Part delivered",
  fulfilled: "Delivered",
  closed: "Closed",
  cancelled: "Cancelled",
  on_hold: "On hold",
};

function statusTone(status: string): string {
  switch (status) {
    case "cancelled":
      return "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300";
    case "on_hold":
      return "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300";
    case "fulfilled":
    case "closed":
      return "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300";
    default:
      return "";
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function OrdersBody() {
  const result = await listOrders({ limit: 200 });

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Orders unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const rows = result.data.rows;
  const now = today();

  const live = rows.filter((r) => LIVE.has(r.status));

  /**
   * ⚠️ "OVERDUE" MEANS THE PROMISED DATE HAS PASSED AND THE ORDER IS NOT
   * FULLY OUT — not that the order is old. An order promised for next
   * month with nothing dispatched is on schedule; the difference matters
   * because one of these needs a call today and the other does not.
   */
  const overdue = live.filter(
    (r) =>
      r.promisedDate !== null &&
      r.promisedDate < now &&
      BigInt(r.fulfilledValueMinor) < BigInt(r.totalMinor),
  );

  const overdueValue = overdue.reduce(
    (acc, r) => acc + (BigInt(r.totalMinor) - BigInt(r.fulfilledValueMinor)),
    0n,
  );
  const openValue = live.reduce(
    (acc, r) => acc + (BigInt(r.totalMinor) - BigInt(r.fulfilledValueMinor)),
    0n,
  );
  /**
   * ⭐ DISPATCHED BUT NOT INVOICED — the number nobody looks for and
   * everybody eventually finds. Goods have left the building and no
   * invoice exists, which means the revenue is not in the books and the
   * clock on the customer's payment terms has not started.
   */
  const uninvoiced = rows.reduce((acc, r) => {
    const gap = BigInt(r.fulfilledValueMinor) - BigInt(r.invoicedValueMinor);
    return acc + (gap > 0n ? gap : 0n);
  }, 0n);

  const amended = rows.filter((r) => r.revision > 0);

  return (
    <div className="space-y-6">
      {overdue.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {inr(overdueValue)} promised and not delivered
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {overdue.length} order{overdue.length === 1 ? "" : "s"} past the date
              the customer was given. The figure is the undelivered value, not
              the order value — it is what is still owed.
            </p>
            <ul className="divide-y rounded-md border">
              {overdue.slice(0, 8).map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-baseline gap-3 px-3 py-2"
                >
                  <Link
                    href={`/orders/${r.id}`}
                    className="font-mono text-xs hover:underline"
                  >
                    {r.orderNo}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    promised {r.promisedDate}
                  </span>
                  <span className="flex-1" />
                  <span className="tabular-nums">
                    {inr(BigInt(r.totalMinor) - BigInt(r.fulfilledValueMinor))}
                  </span>
                </li>
              ))}
            </ul>
            {overdue.length > 8 && (
              <p className="text-xs text-muted-foreground">
                and {overdue.length - 8} more.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Open order book
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(openValue)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {live.length} live order{live.length === 1 ? "" : "s"}, undelivered
              value only.
            </p>
          </CardContent>
        </Card>
        <Card className={overdueValue > 0n ? "border-red-300 dark:border-red-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Past promised date
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={`text-2xl font-semibold tabular-nums ${
                overdueValue > 0n ? "text-red-600" : ""
              }`}
            >
              {inr(overdueValue)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Value, not a count. Six small orders is not the same meeting as
              one large one.
            </p>
          </CardContent>
        </Card>
        <Card className={uninvoiced > 0n ? "border-amber-300 dark:border-amber-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Dispatched, not invoiced
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(uninvoiced)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Goods gone, revenue not booked, payment clock not started.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Amended after confirmation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{amended.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Each carries a revision number and a reason. A warehouse holding
              an older revision can tell.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All orders</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No orders yet. An order records what a customer has agreed to buy
              and has not yet received — the step between a deal and an invoice.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Order</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Promised</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Value</th>
                    <th className="px-4 py-2 text-right font-medium">Delivered</th>
                    <th className="px-4 py-2 text-right font-medium">Invoiced</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => {
                    const pct = completionPercent(
                      BigInt(r.fulfilledValueMinor),
                      BigInt(r.totalMinor),
                    );
                    const late =
                      r.promisedDate !== null &&
                      r.promisedDate < now &&
                      LIVE.has(r.status) &&
                      BigInt(r.fulfilledValueMinor) < BigInt(r.totalMinor);
                    return (
                      <tr key={r.id} className="hover:bg-muted/40">
                        <td className="px-4 py-2">
                          <Link
                            href={`/orders/${r.id}`}
                            className="font-mono text-xs hover:underline"
                          >
                            {r.orderNo}
                          </Link>
                          {r.revision > 0 && (
                            <Badge variant="outline" className="ml-2 text-[10px]">
                              rev {r.revision}
                            </Badge>
                          )}
                          {r.customerReference && (
                            <div className="text-xs text-muted-foreground">
                              their ref {r.customerReference}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs tabular-nums text-muted-foreground">
                          {r.orderDate}
                        </td>
                        <td
                          className={`px-4 py-2 text-xs tabular-nums ${
                            late ? "font-medium text-red-600" : "text-muted-foreground"
                          }`}
                        >
                          {r.promisedDate ?? "—"}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className={statusTone(r.status)}>
                            {STATUS_LABEL[r.status] ?? r.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {inr(r.totalMinor)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {inr(r.fulfilledValueMinor)}
                          <div className="text-[10px] text-muted-foreground">
                            {pct}% by value
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {inr(r.invoicedValueMinor)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Every amount is integer paise, decided once at order entry and stored —
        nothing on this page recomputes tax or re-prices a line, so what is
        shown here is what is on the customer&apos;s copy. A confirmed line
        cannot be edited; a change is an amendment with a revision number and a
        reason, enforced in the database rather than in this screen.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function OrdersPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Sales orders</h1>
          <p className="text-sm text-muted-foreground">
            What customers have agreed to buy and have not yet received.
          </p>
        </div>
        <Link
          href="/receivables"
          className="text-sm text-muted-foreground hover:underline"
        >
          Receivables
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <OrdersBody />
      </Suspense>
    </div>
  );
}
