/**
 * Ordence — Inventory
 * Version: v0.40.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WAVE 3 — THE SECOND KEYSTONE SCREEN
 * ══════════════════════════════════════════════════════════════════════
 *
 * ⭐ THE COLUMN THIS PAGE EXISTS FOR IS "AVAILABLE", NOT "ON HAND".
 *
 * Four hundred bags in the shed with three hundred already promised to
 * Thursday's order means one hundred are sellable. A screen that shows
 * "on hand" prominently and leaves the subtraction to the reader will,
 * under time pressure, produce the same decision as a screen that never
 * mentioned reservations at all — and the result is the same cement
 * promised to two customers, discovered on Thursday by whichever of them
 * matters less.
 *
 * So `available` is the emphasised figure. On hand and reserved are shown
 * beside it as the working, not as the answer.
 *
 * ⚠️ THE RECONCILIATION IS RUN ON EVERY LOAD AND SHOWN IF IT FAILS.
 * `stock_balances` is a cache the trigger maintains; the ledger is the
 * truth. If the two ever disagree, this page says so at the top in red
 * rather than rendering a plausible-looking stock position. A stock
 * figure that is wrong and confident is worse than none, because
 * somebody purchases against it.
 *
 * ⚠️ NEGATIVE STOCK IS SHOWN AS AN ALARM, NOT A MINUS SIGN. It means the
 * system believes goods were issued that were never received — the
 * paperwork is behind the lorry — and every valuation derived from that
 * row is meaningless until it is fixed.
 */

import { Suspense } from "react";
import Link from "next/link";
/**
 * ⭐⭐⭐ `saveWarehouse` AND `saveStockItem` ADDED AS CALLERS — wave two.
 *
 * 🔴 They are the only inserts into `warehouses` and `stock_items`, and
 * nothing called either — while the empty state below instructed the
 * operator to "add a store and a stock item". Twenty reachable actions
 * read one of those two tables.
 */
import {
  getStockPosition,
  reconcileStockLedger,
  saveStockItem,
  saveWarehouse,
} from "@/server/actions/inventory";
import { InventorySetupForms } from "@/components/inventory/setup-forms";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Inventory · Ordence" };

function inr(minorUnits: string | bigint | null | undefined): string {
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

/** Trim the trailing zeros numeric(18,3) always brings back. */
function qty(value: string | null | undefined): string {
  if (value === null || value === undefined) return "0";
  const s = String(value);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

async function InventoryBody() {
  const [position, reconciliation] = await Promise.all([
    getStockPosition(),
    reconcileStockLedger(),
  ]);

  if (!position.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Inventory unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{position.error}</p>
        </CardContent>
      </Card>
    );
  }

  const rows = position.data.rows;
  const drift = reconciliation.ok ? reconciliation.data.discrepancies : [];

  const negative = rows.filter((r) => Number(r.onHand) < 0);
  const belowReorder = rows.filter(
    (r) => r.reorderLevel !== null && Number(r.available) <= Number(r.reorderLevel),
  );
  const totalValue = rows.reduce((acc, r) => acc + BigInt(r.valueMinor), 0n);
  const totalReserved = rows.reduce((acc, r) => acc + Number(r.reserved), 0);

  return (
    <div className="space-y-6">
      {drift.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              The stock figures do not match the ledger — do not purchase
              against them
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              {drift.length} stock position{drift.length === 1 ? "" : "s"}{" "}
              disagree with the sum of their own movements.
            </p>
            <ul className="space-y-1 font-mono text-xs">
              {drift.slice(0, 5).map((d) => (
                <li key={`${d.stockItemId}-${d.warehouseId}-${d.batchNo}`}>
                  shown {qty(d.cached)} · ledger says {qty(d.ledger)}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              The ledger is the truth and the shown figure is a cache, so
              nothing has been lost — every position here can be rebuilt from
              the movement history, because no movement has ever been edited or
              deleted. This normally cannot happen; it means something wrote to
              the balance table directly.
            </p>
          </CardContent>
        </Card>
      )}

      {negative.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {negative.length} position{negative.length === 1 ? "" : "s"} showing
              negative stock
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              This means goods were issued that were never entered as received —
              the paperwork is behind the lorry. Every value figure for these
              rows is meaningless until the receipt is entered.
            </p>
            <ul className="divide-y rounded-md border">
              {negative.slice(0, 6).map((r) => (
                <li
                  key={`${r.stockItemId}-${r.warehouseId}-${r.batchNo}`}
                  className="flex flex-wrap items-baseline gap-3 px-3 py-2"
                >
                  <span className="font-mono text-xs">{r.sku}</span>
                  <span>{r.name}</span>
                  <span className="text-xs text-muted-foreground">
                    at {r.warehouseName}
                  </span>
                  <span className="flex-1" />
                  <span className="font-medium tabular-nums text-amber-700 dark:text-amber-300">
                    {qty(r.onHand)} {r.uom}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Stock value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(totalValue)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              At the cost each lot came in at, not today&apos;s price.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Promised to orders
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {totalReserved.toFixed(0)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Units reserved against confirmed orders. Not sellable.
            </p>
          </CardContent>
        </Card>
        <Card
          className={belowReorder.length > 0 ? "border-amber-300 dark:border-amber-800" : ""}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              At or below reorder level
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{belowReorder.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Measured on available, not on hand — reserved stock cannot
              refill a shelf.
            </p>
          </CardContent>
        </Card>
        <Card className={drift.length === 0 ? "" : "border-red-300 dark:border-red-800"}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Ledger check
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={`text-2xl font-semibold ${
                drift.length === 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {drift.length === 0 ? "Agrees" : `${drift.length} off`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Every figure re-derived from the movement history on this load.
            </p>
          </CardContent>
        </Card>
      </div>

      {belowReorder.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Needs reordering</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {belowReorder.map((r) => (
                <li
                  key={`ro-${r.stockItemId}-${r.warehouseId}-${r.batchNo}`}
                  className="flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm"
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {r.sku}
                  </span>
                  <span className="flex-1">
                    {r.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.warehouseName}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {qty(r.available)} available
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    reorder at {qty(r.reorderLevel)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Stock position</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <InventorySetupForms
            saveWarehouseAction={saveWarehouse}
            saveStockItemAction={saveStockItem}
          />
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No stock recorded yet. Add a store and a stock item, then post an
              opening balance — every quantity from then on is a movement, and
              the history is what lets a wrong figure be explained rather than
              just corrected.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Item</th>
                    <th className="px-4 py-2 font-medium">Store</th>
                    <th className="px-4 py-2 font-medium">Batch</th>
                    <th className="px-4 py-2 text-right font-medium">Available</th>
                    <th className="px-4 py-2 text-right font-medium">On hand</th>
                    <th className="px-4 py-2 text-right font-medium">Reserved</th>
                    <th className="px-4 py-2 text-right font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => {
                    const isNegative = Number(r.onHand) < 0;
                    const noneLeft = Number(r.available) <= 0;
                    return (
                      <tr
                        key={`${r.stockItemId}-${r.warehouseId}-${r.batchNo}`}
                        className="hover:bg-muted/40"
                      >
                        <td className="px-4 py-2">
                          <div>{r.name}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {r.sku}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {r.warehouseName}
                          {r.warehouseAllowsNegative && (
                            <Badge variant="outline" className="ml-2 text-[10px]">
                              may go negative
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                          {r.batchNo || "—"}
                        </td>
                        {/* ⭐ The emphasised figure. See the file header. */}
                        <td
                          className={`px-4 py-2 text-right text-base font-semibold tabular-nums ${
                            noneLeft ? "text-amber-700 dark:text-amber-300" : ""
                          }`}
                        >
                          {qty(r.available)}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            {r.uom}
                          </span>
                        </td>
                        <td
                          className={`px-4 py-2 text-right tabular-nums ${
                            isNegative ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground"
                          }`}
                        >
                          {qty(r.onHand)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                          {qty(r.reserved)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {inr(r.valueMinor)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Stock on hand is not stored anywhere — it is the sum of every movement
        ever posted. Movements cannot be edited or deleted; a mistake is
        corrected by a reversal that names what it reverses, so both the error
        and the fix stay on the record with a date and a person against each.
        That is what makes the ledger check above possible.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function InventoryPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            What is actually sellable — on hand less what is already promised.
          </p>
        </div>
        <Link href="/orders" className="text-sm text-muted-foreground hover:underline">
          Sales orders
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <InventoryBody />
      </Suspense>
    </div>
  );
}
