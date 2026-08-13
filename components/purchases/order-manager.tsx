"use client";

/**
 * Ordence — ⭐⭐ PURCHASE ORDERS, GOODS RECEIPTS, AND THE MATCH
 * Version: v1.19.0-alpha
 *
 * ⚠️ THREE ACTIONS ON ONE SCREEN AND THEY ARE NOT THREE BUTTONS IN A
 * ROW. Raising, receiving and matching are done by different people at
 * different times, and a screen that presents them as one flow invites
 * one person to do all three, which makes the three-way match prove
 * nothing.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface Order {
  id: string;
  poNumber: string;
  vendorName: string;
  poDate: string;
  status: string;
  totalMinor: string;
  lines: number;
  receipts: number;
}

function rupees(minor: string): string {
  const n = BigInt(minor || "0");
  return `₹${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
}

export function OrderManager({
  orders,
  vendors,
  raiseAction,
  approveAction,
}: {
  orders: readonly Order[];
  vendors: ReadonlyArray<{ id: string; name: string }>;
  raiseAction: (
    i: unknown,
  ) => Promise<Result<{ id: string; poNumber: string; totalMinor: string }>>;
  approveAction: (i: unknown) => Promise<Result<{ approved: true }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    vendorId: vendors[0]?.id ?? "",
    poDate: new Date().toISOString().slice(0, 10),
    description: "",
    qty: "",
    price: "",
  });

  function raise() {
    if (!form.vendorId || !form.description || !form.qty || !form.price) {
      toast.error("A vendor, a description, a quantity and a price are all needed.");
      return;
    }
    startTransition(async () => {
      const r = await raiseAction({
        vendorId: form.vendorId,
        poDate: form.poDate,
        lines: [
          {
            description: form.description,
            uom: "nos",
            orderedQty: form.qty,
            // ⚠️ Rupees to paise here, with strings, never `* 100`.
            unitPriceMinor: toMinor(form.price),
            taxRateBps: 0,
          },
        ],
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setForm((p) => ({ ...p, description: "", qty: "", price: "" }));
      toast.success(`${r.data.poNumber} raised as a draft for ${rupees(r.data.totalMinor)}.`);
    });
  }

  function approve(id: string, no: string) {
    startTransition(async () => {
      const r = await approveAction({ poId: id });
      if (!r.ok) toast.error(r.error);
      else toast.success(`${no} approved. Goods can now be booked in against it.`);
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Raise an order</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {vendors.length === 0 ? (
            <p className="text-muted-foreground">No vendors are set up yet.</p>
          ) : (
            <>
              <p className="text-muted-foreground">
                An order is raised as a draft. Approving it is a separate step,
                because an order that commits money the moment it is typed is an
                order nobody reviews.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="v">Vendor</Label>
                  <select
                    id="v"
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={form.vendorId}
                    onChange={(e) => setForm((p) => ({ ...p, vendorId: e.target.value }))}
                  >
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="d">Date</Label>
                  <Input
                    id="d"
                    type="date"
                    value={form.poDate}
                    onChange={(e) => setForm((p) => ({ ...p, poDate: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="desc">What are you ordering</Label>
                  <Input
                    id="desc"
                    value={form.description}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, description: e.target.value }))
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="q">Quantity</Label>
                    <Input
                      id="q"
                      inputMode="decimal"
                      value={form.qty}
                      onChange={(e) => setForm((p) => ({ ...p, qty: e.target.value }))}
                    />
                  </div>
                  <div>
                    <Label htmlFor="p">Rate</Label>
                    <Input
                      id="p"
                      inputMode="decimal"
                      value={form.price}
                      onChange={(e) => setForm((p) => ({ ...p, price: e.target.value }))}
                    />
                  </div>
                </div>
              </div>
              <Button disabled={pending} onClick={raise}>
                Raise as draft
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {orders.map((o) => (
        <Card key={o.id}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{o.poNumber}</CardTitle>
              <Badge variant="secondary">{o.vendorName}</Badge>
              <Badge variant={o.status === "received" ? "default" : "secondary"}>
                {o.status.replace(/_/g, " ")}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              {o.poDate} · {o.lines} line{o.lines === 1 ? "" : "s"} · {rupees(o.totalMinor)}{" "}
              · {o.receipts} receipt{o.receipts === 1 ? "" : "s"}
            </p>
            {o.status === "draft" && (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => approve(o.id, o.poNumber)}
              >
                Approve
              </Button>
            )}
            {o.status === "approved" && o.receipts === 0 && (
              <p className="text-xs text-muted-foreground">
                Approved and nothing booked in yet. Whoever takes delivery records the
                receipt, and the bill is matched against both afterwards.
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** ⚠️ Strings throughout. 1234.56 × 100 is 123455.99999999999 in IEEE 754. */
function toMinor(value: string): string {
  const cleaned = value.replace(/,/g, "").trim();
  const [whole = "0", frac = ""] = cleaned.split(".");
  return (BigInt(whole || "0") * 100n + BigInt((frac + "00").slice(0, 2))).toString();
}
