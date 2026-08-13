/**
 * Ordence — ⭐⭐ LANDED COST
 * Version: v1.5.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE UPLIFT IS THE NUMBER A TRADER ACTUALLY WANTS
 * ══════════════════════════════════════════════════════════════════════
 * "₹4,80,000 of goods" is the invoice. "**8.4% on top** before it
 * reached the shelf" is the figure that decides whether the selling
 * price works — and it is the figure nobody has until the last freight
 * bill lands, which is usually after some of the stock has been sold.
 *
 * ⚠️ AND THE RECOVERABLE COLUMN IS SHOWN SEPARATELY, ALWAYS. Ind AS 2
 * excludes duties and taxes recoverable from the taxing authorities.
 * IGST on imports arrives on the same bill of entry as basic customs
 * duty, in the adjacent box, and capitalising it inflates stock AND
 * loses the credit — with a balance sheet that still balances.
 */

import Link from "next/link";
import { getLandedCosts } from "@/server/actions/landed-cost";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LANDED_COST_TYPES, type LandedCostType } from "@/lib/inventory/landed-cost";

export const dynamic = "force-dynamic";

export const metadata = { title: "Landed cost · Ordence" };

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

export default async function LandedCostPage() {
  const result = await getLandedCosts();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Landed cost</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { purchases, totals } = result.data;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Landed cost</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * ⚠️ The sentence that explains why the screen exists at all.
           */}
          Goods bought at ₹100 do not cost ₹100. Freight, duty, insurance and
          clearing all belong in the cost of the stock — and the recoverable
          taxes on the same document do not.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Capitalised into stock
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(totals.capitalisedMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              Freight, duty and handling directly attributable to acquisition.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Recoverable — deliberately NOT capitalised
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(totals.recoverableMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * 🔴 The half everybody capitalises by accident.
               */}
              IGST on imports is an input tax credit, not a cost. Putting it into
              stock would inflate the balance sheet and lose the credit at the
              same time.
            </p>
          </CardContent>
        </Card>

        <Card className={totals.unapplied > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Charges not yet applied
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{totals.unapplied}</p>
            <p className="text-xs text-muted-foreground">
              Until these are applied, the stock is carried at the invoice price
              and every margin computed off it is overstated.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Purchases by uplift{" "}
            <span className="font-normal text-muted-foreground">
              ({purchases.length})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * ⚠️ Sorted by uplift, not by date. The consignment that cost
             * 14% more to land than its invoice said is the one worth
             * looking at.
             */}
            Ordered by how much the invoice price understated the real cost.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {purchases.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No landed-cost charges recorded yet. Add freight, duty or clearing
              against a posted purchase and it appears here.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Purchase</th>
                  <th className="py-2 pr-3 text-right font-medium">Invoice</th>
                  <th className="py-2 pr-3 text-right font-medium">Added</th>
                  <th className="py-2 pr-3 text-right font-medium">Landed</th>
                  <th className="py-2 pr-3 text-right font-medium">Uplift</th>
                  <th className="py-2 pr-3 font-medium">Charges</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((p) => (
                  <tr key={p.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      {p.invoiceNumber ?? "—"}
                      <p className="text-xs text-muted-foreground">
                        {p.vendorName ?? ""} {p.invoiceDate ?? ""}
                      </p>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(p.purchaseMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(p.capitalisedMinor)}
                      {p.recoverableMinor !== "0" && (
                        <p className="text-xs text-muted-foreground">
                          + {inr(p.recoverableMinor)} recoverable
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-medium tabular-nums">
                      {inr(p.landedMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      <Badge
                        variant={
                          p.upliftBps >= 1000
                            ? "destructive"
                            : p.upliftBps >= 500
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {(p.upliftBps / 100).toFixed(2)}%
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {p.chargeCount}
                      {p.unappliedCount > 0 && (
                        <Badge variant="secondary" className="ml-1">
                          {p.unappliedCount} unapplied
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What counts, and what does not</CardTitle>
          <p className="text-sm text-muted-foreground">
            Ind AS 2 — the cost of purchase is the price, plus duties and taxes
            <em> other than those subsequently recoverable</em>, plus transport
            and handling directly attributable to acquisition.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Charge</th>
                <th className="py-2 pr-3 font-medium">Into stock?</th>
                <th className="py-2 pr-3 font-medium">Spread by</th>
                <th className="py-2 pr-3 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(LANDED_COST_TYPES) as LandedCostType[]).map((k) => {
                const m = LANDED_COST_TYPES[k];
                return (
                  <tr key={k} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 font-medium">{m.label}</td>
                    <td className="py-2 pr-3">
                      {m.recoverable ? (
                        <Badge variant="destructive">no — recoverable</Badge>
                      ) : (
                        <Badge variant="outline">yes</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3">{m.defaultBasis}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{m.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/purchases" className="underline">
          Purchases
        </Link>{" "}
        ·{" "}
        <Link href="/inventory/transfers" className="underline">
          Stock transfers
        </Link>
      </p>
    </main>
  );
}
