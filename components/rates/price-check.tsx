"use client";

/**
 * Ordence — ⭐⭐ WHICH PRICE APPLIES, AND WHY
 * Version: v1.6.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE "WHY" IS THE POINT OF THIS SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * When a customer rings up holding an invoice at a different price, the
 * question is never "what is the price" — it is **which card applied and
 * what beat what**. A tool that produces a number and no reasoning is a
 * tool nobody can use on the phone.
 */

import { useState, useTransition } from "react";
import { quoteLine } from "@/server/actions/pricing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

function inr(minorUnits: string): string {
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

type Result = Awaited<ReturnType<typeof quoteLine>>;

export function PriceCheck({
  companies,
  items,
  today,
}: {
  companies: readonly { id: string; name: string }[];
  items: readonly { id: string; name: string; uom: string }[];
  today: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<Result, { ok: true }>["data"] | null>(
    null,
  );

  const [companyId, setCompanyId] = useState("");
  const [stockItemId, setStockItemId] = useState(items[0]?.id ?? "");
  const [quantity, setQuantity] = useState("100");
  const [onDate, setOnDate] = useState(today);

  function submit() {
    setError(null);
    setResult(null);
    if (!/^\d+$/.test(quantity) || Number(quantity) <= 0) {
      setError("Quote a whole, positive quantity.");
      return;
    }
    start(async () => {
      const res = await quoteLine({
        ...(companyId ? { companyId } : {}),
        stockItemId,
        quantity,
        onDate,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult(res.data);
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="pc-co">Customer</Label>
          <Select id="pc-co" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">— the general public —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {/**
             * 🔴 The rule people are most surprised by until it protects
             * them: a card naming the customer always wins.
             */}
            A card naming this customer always beats a general list, however
            recently the list was published.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pc-it" required>
            Item
          </Label>
          <Select
            id="pc-it"
            value={stockItemId}
            onChange={(e) => setStockItemId(e.target.value)}
          >
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pc-q" required>
            Quantity
          </Label>
          <Input
            id="pc-q"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pc-d" required>
            On date
          </Label>
          <Input
            id="pc-d"
            type="date"
            value={onDate}
            onChange={(e) => setOnDate(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            {/* ⚠️ A price is a fact about a date, not a property of an item. */}
            An order placed in March keeps March&apos;s price.
          </p>
        </div>
      </div>

      <Button type="button" onClick={submit} disabled={pending}>
        {pending ? "Checking…" : "What does this cost?"}
      </Button>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {result && !result.found && (
        <div className="rounded border-l-2 border-amber-500 bg-amber-50 p-3 text-sm">
          <p className="font-medium">No price applies.</p>
          <p className="mt-1 text-muted-foreground">{result.selectionReason}</p>
        </div>
      )}

      {result && result.found && (
        <div className="space-y-3 rounded border p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-2xl font-semibold tabular-nums">
                {inr(result.lineAmountMinor)}
              </p>
              <p className="text-muted-foreground tabular-nums">
                {inr(result.unitPriceMinor)} a unit ·{" "}
                {inr(result.taxableMinor)} taxable + {inr(result.taxMinor)} GST at{" "}
                {result.taxRateBps / 100}%
              </p>
            </div>
            <div className="text-right">
              <Badge variant="default">{result.cardCode}</Badge>
              <p className="mt-1 text-xs text-muted-foreground">{result.cardName}</p>
            </div>
          </div>

          <div className="rounded bg-muted p-3">
            <p className="font-medium">{result.selectionReason}</p>
            <p className="mt-1 text-muted-foreground">
              {/**
               * 🔴 The slab mode, stated. "First 100 at ₹4.50, next 200
               * at ₹6.20" reads two ways and the difference is 27% on a
               * common example.
               */}
              {result.reason}
            </p>
          </div>

          {result.warnings.length > 0 && (
            <ul className="space-y-1 rounded border-l-2 border-destructive bg-red-50 p-3">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          {result.runnersUp.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase text-muted-foreground">
                Also applied, and lost
              </p>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {result.runnersUp.map((r) => (
                  <li key={r.code} className="tabular-nums">
                    {r.code} — {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
