/**
 * Ordence — ⭐ Possession
 * Version: v1.0.0-rc.4
 *
 * 🔴 WITHOUT THIS SCREEN NO PROPERTY REVENUE COULD EVER BE RECOGNISED.
 *    `postPossession()` shipped tested in rc.3 with nothing able to call
 *    it — so a developer would collect a whole project, watch "Advance
 *    from Customers" grow to the full book value, and report zero
 *    turnover forever. Every figure correct, the P&L empty.
 */

import Link from "next/link";
import { listPossessionCandidates } from "@/server/actions/sales-posting";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecordPossession } from "@/components/invoices/record-possession";

export const dynamic = "force-dynamic";

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

export default async function PossessionPage() {
  const result = await listPossessionCandidates();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Possession</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { rows, pendingTotalMinor } = result.data;
  const waiting = rows.filter((r) => r.possessionDate === null);
  const done = rows.filter((r) => r.possessionDate !== null);

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Possession</h1>
        <p className="text-sm text-muted-foreground">
          Handing over a flat is the moment its revenue is earned. Until it is
          recorded, everything collected on a booking sits as a liability.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Held as advances, not yet revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(pendingTotalMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              across {waiting.length} booking{waiting.length === 1 ? "" : "s"} awaiting
              handover
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Why it sits there
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              {/* Ind AS 115 — control transfers at possession, a point in time. */}
              Under Ind AS 115 a buyer&apos;s money is theirs until control of the flat
              transfers. Recognising it earlier reports profit that does not exist yet.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Awaiting handover{" "}
            <span className="font-normal text-muted-foreground">({waiting.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {waiting.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {/* Only bookings with a served demand appear — see the action. */}
              No booking has an advance waiting to be recognised. Bookings appear here
              once a demand has been served on them.
            </p>
          ) : (
            waiting.map((r) => (
              <div
                key={r.bookingId}
                className="flex flex-wrap items-start justify-between gap-3 border-b pb-4 last:border-0"
              >
                <div>
                  <p className="font-medium">
                    {r.reference}{" "}
                    <Badge variant="outline" className="ml-1">
                      {r.status}
                    </Badge>
                  </p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {inr(r.advanceMinor)} demanded · {inr(r.collectedMinor)} collected
                  </p>
                </div>
                <RecordPossession
                  bookingId={r.bookingId}
                  reference={r.reference}
                  advanceMinor={r.advanceMinor}
                  collectedMinor={r.collectedMinor}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {done.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Handed over{" "}
              <span className="font-normal text-muted-foreground">({done.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Booking</th>
                  <th className="py-2 pr-3 font-medium">Possession</th>
                  <th className="py-2 text-right font-medium">Revenue recognised</th>
                </tr>
              </thead>
              <tbody>
                {done.map((r) => (
                  <tr key={r.bookingId} className="border-b last:border-0">
                    <td className="py-2 pr-3">{r.reference}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.possessionDate}</td>
                    <td className="py-2 text-right tabular-nums">{inr(r.advanceMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
