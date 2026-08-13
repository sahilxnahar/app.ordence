/**
 * Ordence — ⭐ SERIAL NUMBERS
 * Version: v1.4.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE QUESTION THIS SCREEN EXISTS TO ANSWER: "WHERE IS SN-4471?"
 * ══════════════════════════════════════════════════════════════════════
 * Before 0055 a serial number existed only as a string on a movement.
 * Nothing said who has it now, when it shipped, or when its warranty
 * ends — which is every question an installer standing in front of a
 * dead inverter is asked, and none of which a movement ledger can answer
 * without replaying itself.
 *
 * ⚠️ THE REGISTER IS MAINTAINED BY TRIGGER FROM THE LEDGER, never typed.
 * The same discipline as `stock_balances`: dropped entirely, it could be
 * rebuilt by replaying `stock_movements`.
 */

import Link from "next/link";
import { getSerials } from "@/server/actions/batches";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SerialWarranty } from "@/components/inventory/serial-warranty";

export const dynamic = "force-dynamic";

export const metadata = { title: "Serial numbers · Ordence" };

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  in_stock: "default",
  reserved: "secondary",
  dispatched: "outline",
  returned: "secondary",
  quarantined: "secondary",
  scrapped: "destructive",
};

export default async function SerialsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const result = await getSerials(q ? { search: q } : undefined);

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Serial numbers</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { rows, counts } = result.data;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Serial numbers</h1>
        <p className="text-sm text-muted-foreground">
          Where each unit is, who has it, and how long its warranty has left.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              In stock
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{counts.inStock}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              With customers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{counts.dispatched}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * 🔴 The database refuses a second dispatch of one serial.
               * Two invoices carrying one number is one machine promised
               * to two customers, and the second one finds out at
               * delivery.
               */}
              A dispatched unit cannot be dispatched again — the database refuses
              it.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Still in warranty
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{counts.inWarranty}</p>
            <p className="text-xs text-muted-foreground">
              {/* ⚠️ Counted from dispatch, not from receipt into our store. */}
              Counted from the day each unit shipped, not from when we received
              it.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Units{" "}
            <span className="font-normal text-muted-foreground">({rows.length})</span>
          </CardTitle>
          <form className="pt-2" action="/inventory/serials">
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search a serial number"
              className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm"
            />
          </form>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {q
                ? `Nothing matches "${q}".`
                : "No serial numbers yet. Units appear here the first time stock moves with a serial number on it."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Serial</th>
                  <th className="py-2 pr-3 font-medium">Item</th>
                  <th className="py-2 pr-3 font-medium">Where</th>
                  <th className="py-2 pr-3 font-medium">Batch</th>
                  <th className="py-2 pr-3 font-medium">Warranty</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 tabular-nums font-medium">{r.serialNo}</td>
                    <td className="py-2 pr-3">
                      {r.itemName}
                      <p className="text-xs text-muted-foreground">{r.sku}</p>
                    </td>
                    <td className="py-2 pr-3">
                      {r.companyName ?? r.warehouseName ?? "—"}
                      {r.dispatchedAt && (
                        <p className="text-xs text-muted-foreground tabular-nums">
                          shipped {r.dispatchedAt.slice(0, 10)}
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{r.batchNo ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <p
                        className={
                          r.inWarranty ? "text-emerald-700" : "text-muted-foreground"
                        }
                      >
                        {r.warrantyLabel}
                      </p>
                      <SerialWarranty
                        serialId={r.id}
                        serialNo={r.serialNo}
                        dispatched={r.dispatchedAt !== null}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={STATUS_TONE[r.status] ?? "outline"}>
                        {r.status.replace("_", " ")}
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
        <Link href="/inventory/returns" className="underline">
          Goods returned
        </Link>
      </p>
    </main>
  );
}
