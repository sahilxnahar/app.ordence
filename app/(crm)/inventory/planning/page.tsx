/**
 * Ordence — ⭐⭐ WHAT TO BUY, AND WHAT IS NOT MOVING
 * Version: v1.21.0-alpha
 *
 * ⚠️ The reorder figure is not "what is on the shelf". It is the shelf on
 * the day new goods would actually arrive, which is the only number a
 * purchase manager can act on without checking anything else.
 */

import { getInventoryReports } from "@/server/actions/inventory-reports";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock planning · Ordence" };

function rupees(minor: string): string {
  const n = BigInt(minor || "0");
  return `₹${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
}

export default async function PlanningPage() {
  const result = await getInventoryReports();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Stock planning</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { reorder, deadStock, reorderValueMinor, deadStockValueMinor } = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Stock planning</h1>
        <p className="text-sm text-muted-foreground">
          What to buy, and what is sitting still. Both are ranked by money rather
          than by age or percentage, because the oldest item in most warehouses is
          a box of washers nobody will ever care about.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Buy these ({reorder.length}) · about {rupees(reorderValueMinor)}
        </h2>
        {reorder.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing needs ordering. Items with no reorder level set are not counted,
            deliberately: an item nobody reorders would otherwise sit at the top of
            this list forever showing zero.
          </p>
        ) : (
          reorder.map((r) => (
            <Card
              key={r.stockItemId}
              className={r.urgency === "out_of_stock" ? "border-destructive" : undefined}
            >
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">{r.name}</CardTitle>
                  <Badge variant="secondary">{r.sku}</Badge>
                  <Badge
                    variant={
                      r.urgency === "out_of_stock" || r.urgency === "order_now"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {r.urgency.replace(/_/g, " ")}
                  </Badge>
                  {r.vendorName && <Badge variant="secondary">{r.vendorName}</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p>
                  <strong>
                    Order {r.suggestedQuantity} {r.uom}
                  </strong>{" "}
                  · about {rupees(r.estimatedCostMinor.toString())}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.onHand} on hand · {r.onOrder} already on order ·{" "}
                  {r.projectedOnArrival} projected when goods land · level{" "}
                  {r.reorderLevel}
                </p>
                <p className="text-muted-foreground">{r.why}</p>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Not moving ({deadStock.length}) · {rupees(deadStockValueMinor)} sitting still
        </h2>
        {deadStock.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has been still for more than ninety days.
          </p>
        ) : (
          deadStock.slice(0, 40).map((d) => (
            <Card key={d.stockItemId}>
              <CardContent className="space-y-1 pt-6 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.name}</span>
                  <Badge variant="secondary">{d.sku}</Badge>
                  <Badge variant={d.neverMoved ? "destructive" : "secondary"}>
                    {d.neverMoved ? "never moved" : `${d.daysStill} days`}
                  </Badge>
                  <span className="tabular-nums font-semibold">
                    {rupees(d.valueMinor.toString())}
                  </span>
                </div>
                <p className="text-muted-foreground">{d.note}</p>
              </CardContent>
            </Card>
          ))
        )}
      </section>
    </main>
  );
}
