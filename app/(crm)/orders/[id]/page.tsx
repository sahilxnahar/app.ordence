/**
 * Ordence — ⭐⭐ ONE ORDER
 * Version: v1.41.0-alpha (Mega-wave 1, Batch 34)
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `getOrder` WAS COMPLETE AND HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * It returns the order, its lines, and its full event history. The
 * orders list linked every order number to `/orders/${o.id}`, and that
 * route did not exist. Every row on the only working screen in the
 * domain was a 404, which is why `check:links` found it.
 *
 * ⭐ THE EVENT HISTORY IS ON THE PAGE, NOT IN AN AUDIT VIEWER SOMEWHERE.
 * `sales_order_events` records every transition with who and why. An
 * order that changed and cannot say when is an order somebody has to
 * defend from memory.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getOrder,
  confirmOrder,
  cancelOrder,
  holdOrder,
  releaseOrder,
  closeOrder,
} from "@/server/actions/orders";
import { OrderLifecycle } from "@/components/orders/order-lifecycle";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

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

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getOrder(id);

  if (!result.ok) {
    /**
     * ⚠️ A REFUSAL IS NOT A 404. "You do not have permission to read
     * orders" and "that order does not exist" are different answers, and
     * collapsing them means an operator with the wrong role spends the
     * afternoon looking for a record that is right there.
     */
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 p-6">
        <Link href="/orders" className="text-sm text-muted-foreground hover:underline">
          ← All orders
        </Link>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { order, lines, events } = result.data;
  if (!order) notFound();

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link href="/orders" className="text-sm text-muted-foreground hover:underline">
          ← All orders
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{order.orderNo}</h1>
          <Badge variant="outline">{order.status.replace(/_/g, " ")}</Badge>
          {order.revision > 0 ? (
            <Badge variant="outline">revision {order.revision}</Badge>
          ) : null}
          {/*
            ⭐ THE TAX SPLIT IS SHOWN, because after Batch 33 it is a
            determination with a reason behind it rather than a guess,
            and it is the thing a customer queries.
          */}
          {order.isInterState === null ? null : (
            <Badge variant="outline">
              {order.isInterState ? "IGST" : "CGST + SGST"}
              {order.placeOfSupplyCode ? ` · place of supply ${order.placeOfSupplyCode}` : ""}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Ordered {order.orderDate}
          {order.promisedDate ? ` · promised ${order.promisedDate}` : ""}
          {order.customerReference ? ` · their ref ${order.customerReference}` : ""}
        </p>
      </div>

      {order.holdReason ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <strong>On hold:</strong> {order.holdReason}
        </p>
      ) : null}
      {order.cancellationReason ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <strong>Cancelled:</strong> {order.cancellationReason}
        </p>
      ) : null}

      <OrderLifecycle
        orderId={order.id}
        status={order.status}
        confirmAction={confirmOrder}
        cancelAction={cancelOrder}
        holdAction={holdOrder}
        releaseAction={releaseOrder}
        closeAction={closeOrder}
      />

      <div className="rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="p-3 font-medium">#</th>
              <th className="p-3 font-medium">Description</th>
              <th className="p-3 text-right font-medium">Qty</th>
              <th className="p-3 text-right font-medium">Done</th>
              <th className="p-3 text-right font-medium">Unit</th>
              <th className="p-3 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b last:border-0">
                <td className="p-3">{l.lineNo}</td>
                <td className="p-3">
                  {l.description}
                  {l.sku ? (
                    <span className="ml-2 text-xs text-muted-foreground">{l.sku}</span>
                  ) : null}
                </td>
                <td className="p-3 text-right">
                  {l.quantity} {l.uom}
                </td>
                {/*
                  ⚠️ FULFILLED AND CANCELLED ARE SHOWN SEPARATELY, NOT AS
                  ONE "REMAINING". Those two states owe the customer
                  opposite things: one owes goods, the other owes a credit
                  note, and a single number cannot tell them apart.
                */}
                <td className="p-3 text-right text-muted-foreground">
                  {l.qtyFulfilled}
                  {Number(l.qtyCancelled) > 0 ? ` · ${l.qtyCancelled} cancelled` : ""}
                </td>
                <td className="p-3 text-right">{money(l.unitPriceMinor, order.currency)}</td>
                <td className="p-3 text-right">{money(l.lineTotalMinor, order.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t">
            <tr>
              <td colSpan={5} className="p-3 text-right text-muted-foreground">
                Taxable
              </td>
              <td className="p-3 text-right">{money(order.taxableValueMinor, order.currency)}</td>
            </tr>
            {order.igstMinor !== "0" ? (
              <tr>
                <td colSpan={5} className="p-3 text-right text-muted-foreground">
                  IGST
                </td>
                <td className="p-3 text-right">{money(order.igstMinor, order.currency)}</td>
              </tr>
            ) : (
              <>
                <tr>
                  <td colSpan={5} className="p-3 text-right text-muted-foreground">
                    CGST
                  </td>
                  <td className="p-3 text-right">{money(order.cgstMinor, order.currency)}</td>
                </tr>
                <tr>
                  <td colSpan={5} className="p-3 text-right text-muted-foreground">
                    SGST
                  </td>
                  <td className="p-3 text-right">{money(order.sgstMinor, order.currency)}</td>
                </tr>
              </>
            )}
            <tr className="font-medium">
              <td colSpan={5} className="p-3 text-right">
                Total
              </td>
              <td className="p-3 text-right">{money(order.totalMinor, order.currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h2 className="font-medium">What has happened to this order</h2>
        {events.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ol className="mt-3 space-y-2 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-40 shrink-0 text-muted-foreground">
                  {new Date(e.occurredAt).toLocaleString()}
                </span>
                <span>{e.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}
