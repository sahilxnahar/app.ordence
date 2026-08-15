/**
 * Ordence — ⭐⭐ ONE PURCHASE ORDER, AND THE TWO THINGS DONE TO IT
 * Version: v1.43.0-alpha (Mega-wave 1, Batch 38, second half)
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `recordGoodsReceipt` AND `runThreeWayMatch` HAD ZERO UI CALLERS
 * ══════════════════════════════════════════════════════════════════════
 * The purchase-orders list could raise an order and approve it, and then
 * the chain stopped. Nothing in the product could record what arrived,
 * and nothing could check a bill against the order and the receipt.
 *
 * ⚠️ SO TWO SEPARATE CONTROLS WERE INERT. The stock ledger never saw a
 * purchase — inventory could only go down, because `sales_dispatch`
 * writes movements and nothing wrote the inward ones. And
 * `purchase_invoices.match_state` has been read by the payment run since
 * v1.11.0 while nothing on earth could set it: every bill in the payment
 * screen showed a blank match state, which reads as "not checked yet"
 * and meant "not checkable".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE SCREEN, TWO PERMISSIONS, AND THAT IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 * The receipt is guarded on `inventory.movements.post` and the match on
 * `settings:update`. The match control is rendered only for somebody who
 * holds the second, so the storekeeper who books the delivery in is not
 * offered a button that passes the bill for it. A three-way match
 * between three documents one person wrote is theatre.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPurchaseOrder,
  recordGoodsReceipt,
  runThreeWayMatch,
} from "@/server/actions/purchase-orders";
import { listWarehouseOptions } from "@/server/actions/purchases-form";
import { ReceiptForm, BillMatch } from "@/components/purchases/receipt-form";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Purchase order · Ordence" };

/** ⚠️ Paise to rupees for display only. The arithmetic never leaves bigint. */
function money(minor: string, currency: string): string {
  const negative = minor.startsWith("-");
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, "0");
  const rupees = padded.slice(0, -2);
  const paise = padded.slice(-2);
  const grouped = Number(rupees).toLocaleString("en-IN");
  return `${negative ? "-" : ""}${currency === "INR" ? "₹" : `${currency} `}${grouped}.${paise}`;
}

/**
 * ⭐ TODAY IN INDIA, NOT TODAY IN UTC.
 *
 * 🔴 `new Date().toISOString().slice(0, 10)` IS THE OBVIOUS VERSION AND
 * IT IS WRONG FOR FIVE AND A HALF HOURS A DAY. IST is UTC+05:30, so
 * between midnight and 05:30 in a godown the UTC date is still
 * yesterday's. A receipt defaulted to yesterday dates the MSME
 * acceptance clock a day early, and nobody checks a date that was
 * already filled in.
 */
function todayInIndia(): string {
  // en-CA formats as YYYY-MM-DD, which is what a date input expects.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );
}

export default async function PurchaseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  /**
   * ⚠️ BOTH READS ARE GUARDED ON `inventory.movements.post`, so a viewer
   * who reached the order can always be offered the warehouses. The
   * failure branch is still handled: an empty list is passed to the form,
   * which explains that stock cannot be received until a godown exists
   * rather than rendering an empty dropdown.
   */
  const [result, warehouseResult] = await Promise.all([
    getPurchaseOrder(id),
    listWarehouseOptions(),
  ]);

  if (!result.ok) {
    /**
     * ⚠️ A REFUSAL IS NOT A 404. "You do not have permission to receive
     * goods" and "that order does not exist" are different answers, and
     * collapsing them sends an operator with the wrong role hunting for a
     * record that is sitting right there.
     */
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 p-6">
        <Link
          href="/purchases/orders"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← All purchase orders
        </Link>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { order, lines, receipts, bills, canMatch } = result.data;
  if (!order) notFound();

  const warehouses = warehouseResult.ok ? warehouseResult.data.rows : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link
          href="/purchases/orders"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← All purchase orders
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{order.poNumber}</h1>
          <Badge variant="secondary">{order.vendorName}</Badge>
          {/*
            ⭐ THE STATUS IS COMPUTED FROM THE RECEIPTS, NEVER TYPED.
            `recomputeOrderStatus` derives it after every receipt, so a
            status here can never disagree with the rows underneath it.
          */}
          <Badge variant="outline">{order.status.replace(/_/g, " ")}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Ordered {order.poDate}
          {order.expectedOn ? ` · expected ${order.expectedOn}` : ""} ·{" "}
          {money(order.subtotalMinor, order.currency)} plus{" "}
          {money(order.taxMinor, order.currency)} tax ={" "}
          {money(order.totalMinor, order.currency)}
        </p>
        {order.notes ? (
          <p className="mt-2 text-sm text-muted-foreground">{order.notes}</p>
        ) : null}
      </div>

      {/*
        ⭐ WHAT HAS ALREADY ARRIVED, ABOVE THE FORM. The quantities in the
        form are typed against these, and a receipt entered without seeing
        them is a receipt entered twice.
      */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="font-medium">What has arrived so far</h2>
        {receipts.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing has been booked in against this order yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {receipts.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.grnNumber}</span>
                <span className="text-muted-foreground">
                  received {r.receivedOn} · {r.lines} line{r.lines === 1 ? "" : "s"}
                  {r.warehouseName ? ` · into ${r.warehouseName}` : " · no warehouse"}
                  {r.challanNo ? ` · challan ${r.challanNo}` : ""}
                </span>
                {/*
                  ⚠️ A PART-REJECTED RECEIPT SAYS SO AND SAYS WHY, on the
                  same line. The reason is the only thing that can be
                  argued with the vendor later, and burying it behind a
                  click means it is written once and never read.
                */}
                {r.status === "part_rejected" ? (
                  <Badge variant="destructive">
                    part rejected{r.rejectionReason ? ` · ${r.rejectionReason}` : ""}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ReceiptForm
        poId={order.id}
        poStatus={order.status}
        lines={lines}
        warehouses={warehouses}
        today={todayInIndia()}
        action={recordGoodsReceipt}
      />

      {/*
        ══════════════════════════════════════════════════════════════
        ⭐⭐ THE BILLS, AND THE MATCH THAT NOTHING COULD RUN
        ══════════════════════════════════════════════════════════════
        🔴 A NULL `match_state` IS RENDERED AS A SENTENCE, NOT AS AN EMPTY
        CELL. The payment run has shown that empty cell since v1.11.0 and
        it reads as "not checked yet"; it meant "nothing in this system
        has ever been able to check it". Those are opposite facts and only
        one of them is safe to pay against.
      */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="font-medium">Bills against this order</h2>
        {bills.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            No bill has been entered against this order yet. The match compares
            the bill with what was ordered and what was accepted, so it needs
            all three to exist.
          </p>
        ) : (
          <ul className="mt-3 space-y-3 text-sm">
            {bills.map((b) => (
              <li key={b.id} className="space-y-1 border-b pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{b.invoiceNumber}</span>
                  <span className="text-muted-foreground">
                    {b.invoiceDate} · {money(b.totalMinor, order.currency)} ·{" "}
                    {b.status.replace(/_/g, " ")}
                  </span>
                  {b.matchState === null ? (
                    <Badge variant="outline">never checked</Badge>
                  ) : (
                    <Badge
                      variant={b.matchState === "unmatched" ? "destructive" : "secondary"}
                    >
                      {b.matchState.replace(/_/g, " ")}
                    </Badge>
                  )}
                </div>
                {b.matchNote ? (
                  <p className="text-xs text-muted-foreground">{b.matchNote}</p>
                ) : null}
                {/*
                  🔴 THE BUTTON IS NOT THE CONTROL. `runThreeWayMatch`
                  calls `requirePermission("settings:update")` itself; this
                  only stops the screen offering what the server would
                  refuse, and stops the person who received the goods
                  passing the bill for them.
                */}
                {canMatch ? (
                  <BillMatch
                    invoiceId={b.id}
                    invoiceNumber={b.invoiceNumber}
                    matchState={b.matchState}
                    action={runThreeWayMatch}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Checking the bill is somebody else&apos;s step. Whoever
                    booked the goods in does not also pass the invoice for
                    them — that is what makes the match worth running.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
