/**
 * Ordence — ⭐⭐ STOCK TRANSFERS
 * Version: v1.5.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE COUNTER THAT MATTERS IS "ON THE ROAD TOO LONG"
 * ══════════════════════════════════════════════════════════════════════
 * A transfer dispatched and never received is stock sitting in a transit
 * location nobody visits, on a balance nobody counts — and it stays
 * there indefinitely, because the transit warehouse is a real place.
 *
 * ⚠️ Three weeks in transit almost never means a long journey. It means
 * the goods arrived and the receipt was never entered, and the far end
 * has been selling from a balance that does not exist.
 */

import Link from "next/link";
import { getTransfers } from "@/server/actions/transfers";
import { getWarehouseOptions } from "@/server/actions/batches";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Stock transfers · Ordence" };

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

const TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "default",
  warn: "secondary",
  danger: "destructive",
  neutral: "outline",
};

export default async function TransfersPage() {
  const [transfers, whs] = await Promise.all([getTransfers(), getWarehouseOptions()]);

  if (!transfers.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Stock transfers</h1>
        <p className="text-sm text-destructive">{transfers.error}</p>
      </main>
    );
  }

  const { rows, inTransit, stale, taxableCount } = transfers.data;
  const warehouses = whs.ok ? whs.data : [];
  const hasTransit = warehouses.some((w) => w.type === "transit");

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Stock transfers</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * 🔴 The sentence that matters, first. A transfer between our
           * own places can be a taxable supply.
           */}
          Moving stock between our own places. Between two GSTINs it is a
          taxable supply and needs a tax invoice — not a delivery challan.
        </p>
      </div>

      {!hasTransit && (
        <div className="rounded border-l-2 border-amber-500 bg-amber-50 p-3 text-sm">
          <p className="font-medium">There is no transit location set up.</p>
          <p className="mt-1 text-muted-foreground">
            {/**
             * ⭐ The `transit` warehouse type has existed since 0029 and
             * nothing ever used it. Without one, goods on a lorry have to
             * live in a selling warehouse — where they can be picked.
             */}
            Goods on a lorry are ours and are in neither godown. Without a
            warehouse of type &ldquo;transit&rdquo; they would have to sit in a
            selling location, where a picker would be sent to them.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className={stale > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              On the road too long
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{stale}</p>
            <p className="text-xs text-muted-foreground">
              Almost always a receipt nobody entered — and the far end has been
              selling from a balance that does not exist.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              In transit
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inTransit}</p>
            <p className="text-xs text-muted-foreground">
              Ours, on the balance sheet, in neither godown.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Taxable supplies
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{taxableCount}</p>
            <p className="text-xs text-muted-foreground">
              {/* s.25(4) + Schedule I para 2 — distinct persons. */}
              Between two GSTINs. These appear on one branch&apos;s GSTR-1 and
              the other&apos;s input credit.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            All transfers{" "}
            <span className="font-normal text-muted-foreground">({rows.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has been moved between locations yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Transfer</th>
                  <th className="py-2 pr-3 font-medium">Route</th>
                  <th className="py-2 pr-3 font-medium">Document</th>
                  <th className="py-2 pr-3 text-right font-medium">Tax</th>
                  <th className="py-2 pr-3 font-medium">Short</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <Link href={`/inventory/transfers/${r.id}`} className="underline">
                        {r.transferNo}
                      </Link>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {r.transferDate} · {r.lineCount} lines
                      </p>
                    </td>
                    <td className="py-2 pr-3">
                      {r.fromName ?? "—"} → {r.toName ?? "—"}
                    </td>
                    <td className="py-2 pr-3">
                      {r.isTaxableSupply ? (
                        <Badge variant="secondary">tax invoice</Badge>
                      ) : (
                        <Badge variant="outline">challan</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.taxMinor === "0" ? "—" : inr(r.taxMinor)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {r.shortLines > 0 ? (
                        <Badge variant="destructive">{r.shortLines}</Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={TONE[r.healthTone] ?? "outline"}>
                        {r.healthLabel}
                      </Badge>
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
        <Link href="/purchases/landed-cost" className="underline">
          Landed cost
        </Link>
      </p>
    </main>
  );
}
