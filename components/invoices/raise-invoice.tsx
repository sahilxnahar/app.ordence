"use client";

/**
 * Ordence — Raise an invoice from a confirmed order
 * Version: v0.94.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS RAISES A DRAFT. IT DOES NOT ISSUE ONE.
 * ══════════════════════════════════════════════════════════════════════
 * Two steps, two permissions, and the separation is the product. A draft
 * is a working paper — delete it and nobody outside the workspace knew.
 * Issuing is irreversible under Rule 53. One button doing both would make
 * the irreversible step the default outcome of a mis-click.
 *
 * ⚠️ QUANTITIES ARE STRINGS ALL THE WAY DOWN. They are `numeric(18,3)` in
 * the database for the same reason money is `bigint`: a part-invoiced
 * order whose remaining quantity drifts by 0.001 can never be closed.
 * Nothing here parses one to a number.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { raiseInvoiceFromOrder } from "@/server/actions/sales-invoices";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type InvoiceableOrder = {
  id: string;
  orderNo: string;
  status: string;
  totalMinor: string;
  lines: {
    id: string;
    lineNo: number;
    description: string;
    uom: string;
    billableQty: string;
    unitPriceMinor: string;
  }[];
};

export function RaiseInvoice({ orders }: { orders: InvoiceableOrder[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [orderId, setOrderId] = useState(orders[0]?.id ?? "");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  /** Line id → quantity string. Absent means "not on this invoice". */
  const [picked, setPicked] = useState<Record<string, string>>({});

  const order = orders.find((o) => o.id === orderId);

  function toggle(lineId: string, fullQty: string) {
    setPicked((prev) => {
      const next = { ...prev };
      if (lineId in next) delete next[lineId];
      else next[lineId] = fullQty;
      return next;
    });
  }

  function submit() {
    setError(null);
    const lines = Object.entries(picked).map(([id, quantity]) => ({
      orderLineId: id,
      quantity,
    }));

    start(async () => {
      const res = await raiseInvoiceFromOrder({
        orderId,
        invoiceDate,
        dueDate: dueDate === "" ? undefined : dueDate,
        lines,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/invoices/${res.data.id}`);
    });
  }

  if (orders.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {/**
         * ⚠️ THE EMPTY STATE NAMES THE CAUSE, NOT THE SYMPTOM. "No orders
         * available" sends somebody looking for a bug. The real reason is
         * always one of two things, and both are actionable.
         */}
        No order has anything left to invoice. An invoice is raised from a{" "}
        <strong>confirmed</strong> order — a draft order cannot be billed, and an order
        already fully invoiced will not appear here.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-3">
          <Label htmlFor="order">Order</Label>
          <select
            id="order"
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
            value={orderId}
            onChange={(e) => {
              setOrderId(e.target.value);
              setPicked({});
            }}
          >
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.orderNo} · {o.lines.length} line{o.lines.length === 1 ? "" : "s"} billable
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="invoiceDate">Invoice date</Label>
          <Input
            id="invoiceDate"
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dueDate">Due date</Label>
          <Input
            id="dueDate"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {/* Ageing runs from this. Without it, payable on presentation. */}
            Ageing runs from this date.
          </p>
        </div>
      </div>

      {order && (
        <div className="space-y-2">
          <p className="text-sm font-medium">What to bill</p>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="p-2 font-medium"> </th>
                  <th className="p-2 font-medium">Line</th>
                  <th className="p-2 font-medium">Description</th>
                  <th className="p-2 text-right font-medium">Billable</th>
                  <th className="p-2 text-right font-medium">Quantity to bill</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((l) => {
                  const on = l.id in picked;
                  return (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(l.id, l.billableQty)}
                          aria-label={`Bill line ${l.lineNo}`}
                        />
                      </td>
                      <td className="p-2 tabular-nums">{l.lineNo}</td>
                      <td className="p-2">{l.description}</td>
                      <td className="p-2 text-right tabular-nums">
                        {l.billableQty} {l.uom}
                      </td>
                      <td className="p-2 text-right">
                        <Input
                          className="ml-auto w-32 text-right"
                          value={picked[l.id] ?? ""}
                          onChange={(e) =>
                            setPicked((prev) => ({ ...prev, [l.id]: e.target.value }))
                          }
                          disabled={!on}
                          inputMode="decimal"
                          aria-label={`Quantity for line ${l.lineNo}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            {/**
             * ⚠️ THE SERVER REFUSES OVER-INVOICING AND SO DOES A CHECK
             * CONSTRAINT. This note explains the rule; it is not the rule.
             */}
            You can bill part of a line. Billing more than remains is refused, with both
            figures named.
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={submit}
          disabled={pending || invoiceDate === "" || Object.keys(picked).length === 0}
        >
          {pending ? "Raising…" : "Raise draft invoice"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        This creates a <strong>draft</strong>. It gets its number, and becomes a tax
        invoice, only when you issue it.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
