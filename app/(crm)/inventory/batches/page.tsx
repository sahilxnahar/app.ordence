/**
 * Ordence — ⭐⭐ BATCHES & EXPIRY
 * Version: v1.4.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWO FIGURES AT THE TOP, AND THEY ARE NEVER ADDED TOGETHER
 * ══════════════════════════════════════════════════════════════════════
 * **Expired** is a loss that has already happened. **Expiring** is a
 * loss somebody can still prevent this week by shipping it. A single
 * "stock at risk" figure adding both hides the half that is still
 * actionable — which is the only half worth looking at a screen for.
 *
 * ⚠️ AND EVERY DATE IS EVALUATED AGAINST TODAY ON EVERY RENDER. There is
 * no stored `days_to_expiry` and no nightly sweep, because the night the
 * job does not run is the morning the screen says stock is fine on the
 * day it stopped being fine.
 */

import Link from "next/link";
import { getBatches, getWarehouseOptions } from "@/server/actions/batches";
import { getTeamMembers } from "@/server/actions/team";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  BatchStatusButton,
  EditBatch,
  WriteOffBatch,
} from "@/components/inventory/batch-actions";
import { expiryVerdict, type BatchStatus } from "@/lib/inventory/batch";

export const dynamic = "force-dynamic";

export const metadata = { title: "Batches & expiry · Ordence" };

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
  fresh: "default",
  expiring_soon: "secondary",
  expiring_now: "secondary",
  expired: "destructive",
  no_expiry: "outline",
};

export default async function BatchesPage() {
  const [batches, whs, team] = await Promise.all([
    getBatches(),
    getWarehouseOptions(),
    getTeamMembers(),
  ]);

  if (!batches.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Batches &amp; expiry</h1>
        <p className="text-sm text-destructive">{batches.error}</p>
      </main>
    );
  }

  const { rows, summary, today } = batches.data;
  const warehouses = whs.ok ? whs.data : [];
  const people = team.ok
    ? team.data.map((m) => ({
        id: m.id,
        name: [m.firstName, m.lastName].filter(Boolean).join(" ").trim() || m.email,
      }))
    : [];

  const withVerdict = rows.map((r) => ({
    row: r,
    verdict: expiryVerdict({
      expiryDate: r.expiryDate,
      today,
      status: r.status as BatchStatus,
    }),
  }));

  const urgent = withVerdict.filter(
    (x) =>
      x.verdict.bucket === "expired" ||
      x.verdict.bucket === "expiring_now" ||
      x.verdict.bucket === "expiring_soon",
  );
  const rest = withVerdict.filter((x) => !urgent.includes(x));

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Batches &amp; expiry</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * ⭐ FEFO NAMED ON THE SCREEN, because a distributor who does
           * not know which rule their software uses finds out from a
           * write-off.
           */}
          Ordence picks first-expired-first-out, not first-in-first-out. A batch
          received in January that expires in December ships after one received
          in March that expires in June.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={summary.expiredCount > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Already expired
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(summary.expiredValueMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/* 🔴 Still in stock on hand until somebody writes it off. */}
              {summary.expiredCount} batches. Still counted in stock until written
              off — and writing it off reverses the input tax credit.
            </p>
          </CardContent>
        </Card>

        <Card className={summary.expiringCount > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Expiring soon
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(summary.expiringValueMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/* ⚠️ Never added to the figure beside it. */}
              {summary.expiringCount} batches. This is the half somebody can still
              save by shipping it.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              In date
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(summary.freshValueMinor)}
            </p>
            <p className="text-xs text-muted-foreground">Nothing to do.</p>
          </CardContent>
        </Card>

        <Card className={summary.noExpiryCount > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              No expiry recorded
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary.noExpiryCount}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⚠️ Not an error for hardware. A real gap for anything
               * perishable — and FEFO ships these LAST, not first.
               */}
              Fine for hardware. For anything perishable it is a gap, and these
              batches ship last rather than first.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Needs a decision{" "}
            <span className="font-normal text-muted-foreground">({urgent.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {urgent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing expired and nothing close to it.
            </p>
          ) : (
            urgent.map(({ row: r, verdict }) => (
              <div key={r.id} className="space-y-3 border-b pb-4 last:border-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {r.itemName}{" "}
                      <span className="text-muted-foreground">· batch {r.batchNo}</span>
                    </p>
                    <p className="text-sm text-muted-foreground tabular-nums">
                      {r.quantity} {r.uom} · {inr(r.valueMinor)}
                      {r.expiryDate ? ` · expires ${r.expiryDate}` : ""}
                    </p>
                    {r.statusNote && (
                      <p className="text-xs text-muted-foreground">{r.statusNote}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={TONE[verdict.bucket] ?? "outline"}>
                      {verdict.label}
                    </Badge>
                    {r.status !== "active" && (
                      <Badge variant="outline">{r.status}</Badge>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{verdict.detail}</p>
                <div className="flex flex-wrap gap-2">
                  <EditBatch
                    batchId={r.id}
                    batchNo={r.batchNo}
                    expiryDate={r.expiryDate}
                    manufactureDate={r.manufactureDate}
                  />
                  <BatchStatusButton
                    batchId={r.id}
                    batchNo={r.batchNo}
                    status={r.status}
                  />
                  {Number(r.quantity) > 0 && warehouses.length > 0 && (
                    <WriteOffBatch
                      batchId={r.id}
                      batchNo={r.batchNo}
                      quantity={r.quantity}
                      valueMinor={r.valueMinor}
                      uom={r.uom}
                      warehouses={warehouses}
                      people={people}
                    />
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            All batches{" "}
            <span className="font-normal text-muted-foreground">({rest.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rest.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other batches. Batches appear here the first time stock is
              received against a batch number.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Item</th>
                  <th className="py-2 pr-3 font-medium">Batch</th>
                  <th className="py-2 pr-3 text-right font-medium">On hand</th>
                  <th className="py-2 pr-3 text-right font-medium">Value</th>
                  <th className="py-2 pr-3 font-medium">Expires</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {rest.map(({ row: r, verdict }) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      {r.itemName}
                      <p className="text-xs text-muted-foreground">{r.sku}</p>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{r.batchNo}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.quantity} {r.uom}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(r.valueMinor)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{r.expiryDate ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={TONE[verdict.bucket] ?? "outline"}>
                        {verdict.label}
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
        <Link href="/inventory/serials" className="underline">
          Serial numbers
        </Link>{" "}
        ·{" "}
        <Link href="/inventory/returns" className="underline">
          Goods returned
        </Link>
      </p>
    </main>
  );
}
