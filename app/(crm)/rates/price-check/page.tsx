/**
 * Ordence — ⭐⭐ PRICE CHECK
 * Version: v1.6.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GAP THIS SCREEN CLOSES WAS NOT A MISSING TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `rate_cards` and `rate_slabs` have existed since 0034 and are good:
 * customer, item, priority, half-open validity, and `slab_mode` stating
 * whether bands read progressively or flat.
 *
 * **And nothing ever selected one.** `sales_order_lines.unit_price_minor`
 * is typed in by hand, so a distributor with negotiated customer prices
 * retyped them on every line and the price list was decoration.
 *
 * ⚠️ A SECOND PRICE LIST TABLE WOULD HAVE BEEN THE OBVIOUS FIX AND THE
 * MISTAKE. Two tables answering "what does this cost this customer
 * today" is two answers, and the wrong one is whichever the invoice
 * screen reads.
 */

import Link from "next/link";
import { getPricingOptions, getRateCardHealth } from "@/server/actions/pricing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PriceCheck } from "@/components/rates/price-check";

export const dynamic = "force-dynamic";

export const metadata = { title: "Price check · Ordence" };

function inr(minorUnits: string | null): string {
  if (minorUnits === null) return "—";
  const raw = String(minorUnits);
  const digits = raw.padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `₹${grouped}.${frac}`;
}

export default async function PriceCheckPage() {
  const [options, health] = await Promise.all([
    getPricingOptions(),
    getRateCardHealth(),
  ]);

  const companies = options.ok ? options.data.companies : [];
  const items = options.ok ? options.data.items : [];
  const rows = health.ok ? health.data.rows : [];
  const withProblems = health.ok ? health.data.withProblems : 0;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Price check</h1>
        <p className="text-sm text-muted-foreground">
          What a customer pays for a quantity on a date — and which rate card
          decided it.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Quote a line</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No stock items yet. Add one before a price can be quoted against it.
            </p>
          ) : (
            <PriceCheck companies={companies} items={items} today={today} />
          )}
        </CardContent>
      </Card>

      <Card className={withProblems > 0 ? "border-destructive" : undefined}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Rate cards{" "}
            <span className="font-normal text-muted-foreground">({rows.length})</span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 THE PROBLEMS COLUMN IS THE POINT. A gap between bands is
             * quiet and expensive — flat pricing falls through to the
             * last band, so a quantity matching nothing is charged at the
             * TOP rate rather than erroring, and nobody finds that by
             * looking at the card.
             */}
            {withProblems > 0
              ? `${withProblems} card${withProblems === 1 ? " has" : "s have"} a problem with their bands. A gap does not error — the quantity falls through to the top band and the customer is charged the wrong figure.`
              : "Every card's bands climb cleanly, with one open-ended band at the top."}
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rate cards yet. Until there is one, every price is typed by hand
              on the order line — which is what this whole screen exists to stop.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Card</th>
                  <th className="py-2 pr-3 font-medium">For</th>
                  <th className="py-2 pr-3 font-medium">Bands</th>
                  <th className="py-2 pr-3 font-medium">Valid</th>
                  <th className="py-2 pr-3 text-right font-medium">Floor</th>
                  <th className="py-2 pr-3 font-medium">Problems</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <span className="font-medium">{r.code}</span>
                      <p className="text-xs text-muted-foreground">{r.name}</p>
                    </td>
                    <td className="py-2 pr-3">
                      {r.customerName ? (
                        <Badge variant="default">{r.customerName}</Badge>
                      ) : (
                        <Badge variant="outline">any customer</Badge>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {r.itemName ?? "any item"}
                      </p>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {r.slabCount}
                      <p className="text-xs text-muted-foreground">{r.slabMode}</p>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-xs">
                      {r.validFrom ?? "always"} → {r.validTo ?? "open"}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(r.floorPriceMinor)}
                    </td>
                    <td className="py-2 pr-3">
                      {r.problems.length === 0 ? (
                        "—"
                      ) : (
                        <ul className="space-y-1 text-xs text-destructive">
                          {r.problems.map((p) => (
                            <li key={`${r.id}-${p.sequence}`}>
                              Band {p.sequence}: {p.problem}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/rates" className="underline">
          Rate cards
        </Link>{" "}
        ·{" "}
        <Link href="/gst/discounts" className="underline">
          Rebates &amp; discounts
        </Link>{" "}
        ·{" "}
        <Link href="/purchases/landed-cost" className="underline">
          Landed cost
        </Link>
      </p>
    </main>
  );
}
