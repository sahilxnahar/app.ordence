"use client";

/**
 * Ordence — ⭐⭐ THE FORM THAT LETS THE PRODUCT TAKE AN ORDER
 * Version: v1.42.0-alpha (Mega-wave 1, Batch 34, second half)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `createOrder` HAD NO CALLER, SO NO ORDER COULD BE CREATED
 * ══════════════════════════════════════════════════════════════════════
 * The orders list, the detail page, fulfilment, invoicing and every sales
 * report all read a table that the product could not write to. The only
 * way an order existed was an INSERT at a psql prompt.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FORM DOES NOT COMPUTE THE TAX, AND THAT IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT WOULD BE EASY TO SHOW A RUNNING TOTAL HERE. It would also be a
 * second implementation of `priceLine`, in floating point, in a browser,
 * and the two would disagree by a paisa on the first multi-rate order.
 * The number the customer sees must be the number that was posted, so
 * this form collects facts and the server returns the money.
 *
 * 🔴 AND IT DOES NOT SEND A PLACE OF SUPPLY. After Batch 33 the server
 * determines it from the buyer, the seller registration and the site,
 * and REFUSES if what it was sent disagrees. A form that guessed would
 * turn that refusal into a routine obstacle, and the first fix anybody
 * reached for would be to stop sending it. So it never sends one.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Option = { id: string; label: string; hint?: string };

type Line = {
  key: string;
  description: string;
  quantity: string;
  uom: string;
  /** ⚠️ RUPEES IN THE FIELD, PAISE ON THE WIRE. Converted once, below. */
  unitPrice: string;
  taxPercent: string;
};

type Result =
  | { ok: true; data: { id: string; orderNo: string } }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * ⭐ RUPEES TO PAISE WITHOUT TOUCHING A FLOAT.
 *
 * 🔴 `Math.round(Number("12345.67") * 100)` IS THE OBVIOUS VERSION AND IT
 * IS WRONG. `1.005 * 100` is `100.49999999999999`, so a price ending in
 * half a paisa rounds down, and the invoice is a paisa short of the
 * quotation. The string is split on the decimal point instead, which
 * cannot lose a digit it never converted.
 */
function rupeesToPaise(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "0";
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!m) return "";
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").padEnd(2, "0");
  return String(BigInt(whole) * 100n + BigInt(frac));
}

/** Percent to basis points, same discipline. 18 → 1800, 2.5 → 250. */
function percentToBps(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!m) return null;
  const whole = Number(m[1] ?? "0");
  const frac = (m[2] ?? "").padEnd(2, "0");
  return whole * 100 + Number(frac);
}

let nextKey = 0;
const blankLine = (): Line => ({
  key: `l${nextKey++}`,
  description: "",
  quantity: "1",
  uom: "nos",
  unitPrice: "",
  taxPercent: "18",
});

export function NewOrderForm({
  action,
  registrations,
  parties,
  projects,
  today,
}: {
  action: (input: unknown) => Promise<Result>;
  registrations: Option[];
  parties: Option[];
  projects: Option[];
  today: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [supplyType, setSupplyType] = useState("services");

  function setLine(key: string, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function submit(formData: FormData) {
    setError(null);

    const bad = lines.find((l) => rupeesToPaise(l.unitPrice) === "");
    if (bad) {
      setError(
        `"${bad.unitPrice}" is not a price. Use rupees with up to two decimal places.`,
      );
      return;
    }

    const payload = {
      orderDate: String(formData.get("orderDate") ?? today),
      promisedDate: String(formData.get("promisedDate") ?? "") || undefined,
      customerReference: String(formData.get("customerReference") ?? "") || undefined,
      sellerRegistrationId: String(formData.get("sellerRegistrationId") ?? "") || undefined,
      gstPartyId: String(formData.get("gstPartyId") ?? "") || undefined,
      projectId: String(formData.get("projectId") ?? "") || undefined,
      supplyType,
      deliveryStateCode: String(formData.get("deliveryStateCode") ?? "") || undefined,
      currency: "INR",
      notes: String(formData.get("notes") ?? "") || undefined,
      lines: lines.map((l, i) => ({
        lineNo: i + 1,
        kind: supplyType === "immovable_property" ? "works_contract" : "goods",
        description: l.description,
        quantity: l.quantity,
        uom: l.uom,
        unitPriceMinor: rupeesToPaise(l.unitPrice),
        taxRateBps: percentToBps(l.taxPercent),
      })),
    };

    start(async () => {
      const result = await action(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      /**
       * ⭐ STRAIGHT TO THE ORDER, NOT BACK TO THE LIST. The next thing
       * anybody does after drafting an order is confirm it, and the
       * confirm button is on the detail page.
       */
      router.push(`/orders/${result.data.id}`);
    });
  }

  return (
    <form action={submit} className="space-y-6">
      <div className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="gstPartyId">Customer</Label>
          <select
            id="gstPartyId"
            name="gstPartyId"
            required
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <option value="">Choose…</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.hint ? ` · ${p.hint}` : ""}
              </option>
            ))}
          </select>
          {/*
            ⚠️ THE BUYER'S REGISTRATION IS WHAT DECIDES THE TAX, not their
            address. An SEZ buyer is inter-state under s.7(5)(b) even
            across the road, and that fact lives on this record.
          */}
          <p className="text-xs text-muted-foreground">
            Their GSTIN decides the tax, so pick the registration you are
            billing, not just the company.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sellerRegistrationId">Billed from</Label>
          <select
            id="sellerRegistrationId"
            name="sellerRegistrationId"
            required
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <option value="">Choose…</option>
            {registrations.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
                {r.hint ? ` · ${r.hint}` : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Which of your GSTINs supplies this.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="supplyType">What is being supplied</Label>
          <select
            id="supplyType"
            name="supplyType"
            value={supplyType}
            onChange={(e) => setSupplyType(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <option value="services">Services</option>
            <option value="goods">Goods</option>
            <option value="immovable_property">
              Works contract or property
            </option>
          </select>
          {/*
            🔴 THIS SELECTS A SECTION OF THE ACT, NOT A LABEL.
            `immovable_property` is s.12(3): the place of supply is the
            SITE, whatever the buyer's address says.
          */}
          {supplyType === "immovable_property" ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              The tax follows where the site is, not where the buyer is. Pick the
              project below, and it needs a GST state code set on it.
            </p>
          ) : null}
        </div>

        {supplyType === "immovable_property" ? (
          <div className="space-y-1.5">
            <Label htmlFor="projectId">Site</Label>
            <select
              id="projectId"
              name="projectId"
              required
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
            >
              <option value="">Choose…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.hint ? ` · ${p.hint}` : " · no GST state set"}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {supplyType === "goods" ? (
          <div className="space-y-1.5">
            <Label htmlFor="deliveryStateCode">Delivered to (state code)</Label>
            <Input
              id="deliveryStateCode"
              name="deliveryStateCode"
              maxLength={2}
              inputMode="numeric"
              pattern="[0-9]{2}"
              placeholder="27"
            />
            {/*
              ⚠️ A CODE, NOT A NAME. s.10(1)(a) puts the place of supply
              where the movement ends, and that comparison needs "29", not
              "Karnataka". Prose fails the check quietly and falls back to
              our own state, making every consignment intra-state.
            */}
            <p className="text-xs text-muted-foreground">
              Two digits. Where the goods finish their journey decides the tax.
            </p>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="orderDate">Order date</Label>
          <Input id="orderDate" name="orderDate" type="date" defaultValue={today} required />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="promisedDate">Promised</Label>
          <Input id="promisedDate" name="promisedDate" type="date" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="customerReference">Their reference</Label>
          <Input id="customerReference" name="customerReference" maxLength={100} />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <Input id="notes" name="notes" maxLength={5000} />
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-medium">Lines</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((ls) => [...ls, blankLine()])}
          >
            <Plus className="mr-1 h-4 w-4" /> Add line
          </Button>
        </div>

        <div className="space-y-3 p-4">
          {lines.map((l, i) => (
            <div key={l.key} className="grid gap-2 sm:grid-cols-12">
              <div className="sm:col-span-5">
                <Input
                  aria-label={`Line ${i + 1} description`}
                  placeholder="What is being supplied"
                  required
                  maxLength={2000}
                  value={l.description}
                  onChange={(e) => setLine(l.key, { description: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <Input
                  aria-label={`Line ${i + 1} quantity`}
                  placeholder="Qty"
                  required
                  value={l.quantity}
                  onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                />
              </div>
              <div className="sm:col-span-1">
                <Input
                  aria-label={`Line ${i + 1} unit`}
                  value={l.uom}
                  onChange={(e) => setLine(l.key, { uom: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <Input
                  aria-label={`Line ${i + 1} unit price in rupees`}
                  placeholder="Price ₹"
                  required
                  inputMode="decimal"
                  value={l.unitPrice}
                  onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                />
              </div>
              <div className="sm:col-span-1">
                <Input
                  aria-label={`Line ${i + 1} tax percent`}
                  placeholder="%"
                  inputMode="decimal"
                  value={l.taxPercent}
                  onChange={(e) => setLine(l.key, { taxPercent: e.target.value })}
                />
              </div>
              <div className="flex items-center sm:col-span-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove line ${i + 1}`}
                  disabled={lines.length === 1}
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        {/*
          ⭐ NO RUNNING TOTAL, DELIBERATELY. Computing it here would be a
          second implementation of `priceLine` in floating point, and the
          two would disagree by a paisa on the first multi-rate order. The
          server returns the money, and the order page shows it.
        */}
        <p className="border-t p-4 text-xs text-muted-foreground">
          The tax and the total are worked out when you save, so the figures you
          see are the figures that were posted. The split between CGST, SGST and
          IGST follows the place of supply, which is determined from the buyer,
          your registration and the site.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Create draft order"}
      </Button>
    </form>
  );
}
