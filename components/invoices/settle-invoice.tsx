"use client";

/**
 * Ordence — Record a payment against an invoice
 * Version: v0.94.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE STEP, BECAUSE TWO IS HOW UNAPPLIED CASH ACCUMULATES
 * ══════════════════════════════════════════════════════════════════════
 * "A customer paid this invoice" is what happens ninety times out of a
 * hundred. Making somebody record a receipt and then separately allocate
 * it means the receipt gets entered, the allocation gets forgotten, and
 * the invoice reads as overdue while the money sits on the account.
 *
 * ⚠️ MONEY IS TYPED IN RUPEES AND SENT AS PAISE. The conversion happens
 * once, here, by string surgery — never `Number(x) * 100`, which turns
 * ₹1,234.56 into 123455.99999999999 and then into a rupee that vanishes.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { settleInvoice } from "@/server/actions/sales-invoices";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const METHODS = [
  { value: "neft", label: "NEFT" },
  { value: "rtgs", label: "RTGS" },
  { value: "imps", label: "IMPS" },
  { value: "upi", label: "UPI" },
  { value: "cheque", label: "Cheque" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "adjustment", label: "Adjustment" },
];

/**
 * `"1234.56"` → `"123456"`.
 *
 * ⚠️ STRING SURGERY, NOT ARITHMETIC. `Math.round(Number(v) * 100)` is
 * right for almost every value and wrong for the ones that matter. The
 * paise are taken as digits and padded.
 */
function rupeesToPaise(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "0";
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const paise = (fraction + "00").slice(0, 2);
  const digits = `${whole.replace(/\D/g, "") || "0"}${paise}`;
  return digits.replace(/^0+(?=\d)/, "");
}

export function SettleInvoice({
  invoiceId,
  companyId,
  outstandingMinor,
}: {
  invoiceId: string;
  companyId: string;
  outstandingMinor: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [tds, setTds] = useState("");
  const [method, setMethod] = useState("neft");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState("");

  function submit() {
    setError(null);
    start(async () => {
      const res = await settleInvoice({
        invoiceId,
        companyId,
        receivedOn,
        amountMinor: rupeesToPaise(amount),
        tdsCreditMinor: tds.trim() === "" ? undefined : rupeesToPaise(tds),
        method,
        instrumentRef: reference.trim() === "" ? undefined : reference.trim(),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setAmount("");
      setTds("");
      setReference("");
      router.refresh();
    });
  }

  if (outstandingMinor === "0") {
    return <p className="text-sm text-muted-foreground">Nothing outstanding on this invoice.</p>;
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        Record a payment
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded border p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="amount">Amount received (₹)</Label>
          <Input
            id="amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tds">TDS withheld (₹)</Label>
          <Input
            id="tds"
            inputMode="decimal"
            value={tds}
            onChange={(e) => setTds(e.target.value)}
            placeholder="0.00"
          />
          {/**
           * ⚠️ TDS SETTLES THE INVOICE AS SURELY AS CASH. A customer who
           * withheld it has paid that money — to the Government, on our
           * behalf. Leaving it out is how a fully-settled account shows
           * as overdue and a dunning letter goes to somebody who paid in
           * full.
           */}
          <p className="text-xs text-muted-foreground">
            Tax the customer deducted. It settles the invoice too.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="receivedOn">Received on</Label>
          <Input
            id="receivedOn"
            type="date"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="method">Method</Label>
          <select
            id="method"
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="reference">Reference</Label>
          <Input
            id="reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="UTR, cheque number or UPI reference"
          />
          <p className="text-xs text-muted-foreground">
            {/* What the customer will quote when they ring about it. */}
            What the customer will quote if they ask about this payment.
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={submit}
          disabled={pending || amount.trim() === "" || receivedOn === ""}
        >
          {pending ? "Recording…" : "Record payment"}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
