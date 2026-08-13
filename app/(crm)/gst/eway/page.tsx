/**
 * Ordence — ⭐⭐ E-WAY BILLS
 * Version: v1.3.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO NUMBERS AT THE TOP ARE THE ONLY REASON THIS SCREEN EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * "Prepared but never generated" and "expiring within 8 hours" are the
 * two states in which a lorry is on a road it should not be on. Every
 * other column is reference.
 *
 * ⚠️ EXPIRY IS COMPUTED FROM THE TIMESTAMP ON EVERY RENDER, never read
 * from a stored flag. A flag needs a job to maintain it, and the gap
 * between a bill expiring and the job running is a gap in which this
 * screen says a truck is legal and it is not.
 */

import Link from "next/link";
import { getEwayBills, getEwayCandidates } from "@/server/actions/eway";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PrepareEway } from "@/components/gst/prepare-eway";
import { ewayHealth, type EwayStatus } from "@/lib/gst/eway";
import { placeOfSupplyName } from "@/lib/gst/constants";

export const dynamic = "force-dynamic";

export const metadata = { title: "E-way bills · Ordence" };

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

const TONE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "default",
  warn: "secondary",
  danger: "destructive",
  neutral: "outline",
};

export default async function EwayPage() {
  const [bills, candidates] = await Promise.all([getEwayBills(), getEwayCandidates()]);

  if (!bills.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">E-way bills</h1>
        <p className="text-sm text-destructive">{bills.error}</p>
      </main>
    );
  }

  const now = new Date();
  const { rows, atRisk, ungenerated } = bills.data;
  const waiting = candidates.ok ? candidates.data.rows : [];

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">E-way bills</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * ⚠️ THE CONSEQUENCE, NOT THE RULE NUMBER. Nobody reads a
           * screen for Rule 138; they read it because a truck is waiting.
           */}
          A consignment stopped without one is a penalty and a detained
          vehicle. Rule 138 requires one above ₹50,000 of goods moving.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className={ungenerated > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Prepared, never generated
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{ungenerated}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * 🔴 THE MOST DANGEROUS ROW IN THE TABLE. It looks like an
               * e-way bill and it covers nothing.
               */}
              These have no portal number. Nothing may move on them.
            </p>
          </CardContent>
        </Card>

        <Card className={atRisk > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Expiring or expired
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{atRisk}</p>
            <p className="text-xs text-muted-foreground">
              Within the 8-hour extension window, or already past it.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Goods invoices with no live bill
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{waiting.length}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⚠️ NOT FILTERED BY VALUE. Whether Rule 138 bites depends
               * on the consignment value under Explanation 2, which is
               * computed from the lines — filtering on the invoice total
               * would hide exactly the mixed invoices that are hardest
               * to judge.
               */}
              Not all of them need one — the threshold is decided from the
              lines, on the prepare form.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Waiting to be covered{" "}
            <span className="font-normal text-muted-foreground">({waiting.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {waiting.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every issued goods invoice has a live e-way bill against it.
            </p>
          ) : (
            waiting.map((c) => (
              <div
                key={c.invoiceId}
                className="flex flex-wrap items-start justify-between gap-3 border-b pb-4 last:border-0"
              >
                <div>
                  <p className="font-medium">
                    <Link href={`/invoices/${c.invoiceId}`} className="underline">
                      {c.invoiceNumber}
                    </Link>{" "}
                    <span className="text-muted-foreground">
                      {c.customerLegalName ?? "—"}
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {c.invoiceDate} · {inr(c.totalMinor)} ·{" "}
                    {c.isInterState ? "inter-state" : "intra-state"}
                  </p>
                </div>
                <PrepareEway
                  invoiceId={c.invoiceId}
                  invoiceNumber={c.invoiceNumber}
                  isInterState={c.isInterState}
                  defaultFromStateCode={c.supplierStateCode}
                  defaultToStateCode={c.placeOfSupplyCode}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            All e-way bills{" "}
            <span className="font-normal text-muted-foreground">({rows.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None yet. Prepare one from an issued goods invoice above.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Document</th>
                  <th className="py-2 pr-3 font-medium">EWB no.</th>
                  <th className="py-2 pr-3 font-medium">Route</th>
                  <th className="py-2 pr-3 text-right font-medium">Value</th>
                  <th className="py-2 pr-3 font-medium">Vehicle</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const health = ewayHealth({
                    status: r.status as EwayStatus,
                    validUntil: r.validUntil ? new Date(r.validUntil) : null,
                    vehicleNo: r.vehicleNo,
                    now,
                  });
                  return (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-3">
                        <Link href={`/gst/eway/${r.id}`} className="underline">
                          {r.documentNo}
                        </Link>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {r.documentDate}
                        </p>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{r.ewbNo ?? "—"}</td>
                      <td className="py-2 pr-3">
                        <p className="tabular-nums">
                          {r.fromPincode} → {r.toPincode}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {placeOfSupplyName(r.fromStateCode)} →{" "}
                          {placeOfSupplyName(r.toStateCode)} · {r.distanceKm} km
                        </p>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {inr(r.consignmentValueMinor)}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {r.vehicleNo ?? "—"}
                        {r.vehicleType === "odc" && (
                          <Badge variant="outline" className="ml-1">
                            ODC
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={TONE_VARIANT[health.tone] ?? "outline"}>
                          {health.label}
                        </Badge>
                        {r.extensionCount > 0 && (
                          <p className="text-xs text-muted-foreground">
                            extended {r.extensionCount}×
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
