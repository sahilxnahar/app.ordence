/**
 * Ordence — ⭐ ENGINE 1 · THE SCHEDULE
 * Version: v0.69.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PAGE LEADS WITH THE TWO THINGS THE ENGINE DELIBERATELY ALLOWS
 * ══════════════════════════════════════════════════════════════════════
 * Everything genuinely dangerous — two bookings on one room, a booking
 * on a resource that is out of service, a ward past its bed count — is
 * already impossible. The database refuses it under concurrency, not the
 * screen. So a schedule page has nothing useful to say about those.
 *
 * What it must say is what the engine PERMITS on purpose, because a
 * permitted thing nobody can find is indistinguishable from a bug:
 *
 *   1. OVERBOOKINGS — allowed, because a hotel that cannot oversell
 *      loses money on no-shows. Every one is flagged. A front desk that
 *      discovers these at 9pm has walked three guests.
 *   2. EXPIRING HOLDS — a hold occupies capacity exactly as a booking
 *      does. Abandoned ones are rooms nobody can sell, and they look
 *      completely normal in a list.
 *
 * ⚠️ THEN ARRIVALS AND DEPARTURES, because that is the actual shape of
 * somebody's morning. A list sorted by creation date is a list nobody
 * works from.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE STATUS LIST BELOW IS LOAD-BEARING
 * ══════════════════════════════════════════════════════════════════════
 * `OCCUPYING` must match `CAPACITY_CONSUMING_STATUSES` in the schema and
 * the five tagged predicates in SQL 0033. If the screen thinks a
 * cancelled booking still occupies a room, it shows a full house that
 * the database will happily sell. If it thinks a held one does not, it
 * offers a room the database then refuses — in front of a customer.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listSchedule } from "@/server/actions/scheduling";
import { ScheduleActions } from "@/components/scheduling/schedule-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Scheduling · Ordence" };

function inr(minorUnits: string | null | undefined): string {
  if (!minorUnits) return "₹0.00";
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

function when(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function clock(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const STATUS_LABEL: Record<string, string> = {
  held: "Held",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  in_progress: "In progress",
  completed: "Completed",
  no_show: "No show",
  cancelled: "Cancelled",
  waitlisted: "Waitlisted",
};

const KIND_LABEL: Record<string, string> = {
  room: "Room",
  bed: "Bed",
  table: "Table",
  hall: "Hall",
  practitioner: "Practitioner",
  vehicle: "Vehicle",
  equipment: "Equipment",
  staff: "Staff",
  slot: "Slot",
  other: "Other",
};

function statusTone(status: string): string {
  if (status === "cancelled" || status === "no_show") return "text-muted-foreground";
  if (status === "held")
    return "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300";
  if (status === "checked_in" || status === "in_progress")
    return "border-blue-400 text-blue-700 dark:border-blue-700 dark:text-blue-300";
  if (status === "confirmed" || status === "completed")
    return "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300";
  return "";
}

async function ScheduleBody() {
  const result = await listSchedule();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Schedule unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    resources,
    bookings,
    blocks,
    overbookings,
    expiringHolds,
    arrivingToday,
    departingToday,
    committedRevenueMinor,
  } = result.data;

  const OCCUPYING = new Set(["held", "confirmed", "checked_in", "in_progress"]);
  const live = bookings.filter((b) => OCCUPYING.has(b.status));
  const activeResources = resources.filter((r) => r.isActive);
  const blockedNow = blocks.filter(
    (b) =>
      new Date(b.startsAt).getTime() <= Date.now() &&
      new Date(b.endsAt).getTime() >= Date.now(),
  );

  return (
    <div className="space-y-6">
      <ScheduleActions resources={resources} />

      {/* ── 1 · OVERBOOKINGS. Permitted on purpose, never hidden. ──── */}
      {overbookings.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {overbookings.length} booking
              {overbookings.length === 1 ? " is" : "s are"} beyond stated capacity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {overbookings.slice(0, 12).map((b) => (
                <li key={b.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{b.resourceName}</span>
                  <span className="text-xs text-muted-foreground">
                    {b.partyName ?? b.reference ?? "—"}
                  </span>
                  <span className="tabular-nums">{when(b.startsAt)}</span>
                  <Badge variant="outline" className={statusTone(b.status)}>
                    {STATUS_LABEL[b.status] ?? b.status}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              This is allowed — a hotel that cannot oversell loses money on
              no-shows — but only up to the allowance somebody set on each
              resource, and every instance is flagged here. The alternative is
              a front desk discovering it at 9pm with three guests in the
              lobby.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · EXPIRING HOLDS. Capacity quietly disappearing. ──────── */}
      {expiringHolds.length > 0 && (
        <Card className="border-blue-300 dark:border-blue-800">
          <CardHeader>
            <CardTitle className="text-blue-700 dark:text-blue-300">
              {expiringHolds.length} hold
              {expiringHolds.length === 1 ? "" : "s"} expiring or already expired
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {expiringHolds.slice(0, 12).map((b) => (
                <li key={b.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{b.resourceName}</span>
                  <span className="text-xs text-muted-foreground">
                    {b.partyName ?? b.reference ?? "—"}
                  </span>
                  <span
                    className={
                      (b.holdMinutesLeft ?? 0) < 0
                        ? "tabular-nums text-red-600 dark:text-red-400"
                        : "tabular-nums"
                    }
                  >
                    {(b.holdMinutesLeft ?? 0) < 0
                      ? `expired ${Math.abs(b.holdMinutesLeft ?? 0)}m ago`
                      : `${b.holdMinutesLeft}m left`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              A hold occupies the resource exactly as a confirmed booking does.
              Left alone, an abandoned enquiry is a room nobody can sell — and
              it looks entirely normal in a list, which is why it gets its own
              panel rather than a column.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · The numbers. ──────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Live bookings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{live.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              across {activeResources.length} active resource
              {activeResources.length === 1 ? "" : "s"}.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Arriving today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {arrivingToday.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {departingToday.length} departing.
            </p>
          </CardContent>
        </Card>
        <Card
          className={blockedNow.length > 0 ? "border-amber-300 dark:border-amber-800" : ""}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Out of service now
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {blockedNow.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Maintenance beats the overbooking allowance.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Committed revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(committedRevenueMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Confirmed onward, including no-shows.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 4 · Today. The shape of somebody's morning. ────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Arrivals today</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {arrivingToday.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                Nothing arriving today.
              </p>
            ) : (
              <ul className="divide-y">
                {arrivingToday.map((b) => (
                  <li key={b.id} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                    <span className="w-12 shrink-0 tabular-nums text-muted-foreground">
                      {clock(b.startsAt)}
                    </span>
                    <span className="font-medium">{b.partyName ?? b.reference}</span>
                    <span className="text-xs text-muted-foreground">
                      {b.resourceName}
                    </span>
                    <Badge variant="outline" className={`ml-auto ${statusTone(b.status)}`}>
                      {STATUS_LABEL[b.status] ?? b.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Departures today</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {departingToday.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                Nothing departing today.
              </p>
            ) : (
              <ul className="divide-y">
                {departingToday.map((b) => (
                  <li key={b.id} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                    <span className="w-12 shrink-0 tabular-nums text-muted-foreground">
                      {clock(b.endsAt)}
                    </span>
                    <span className="font-medium">{b.partyName ?? b.reference}</span>
                    <span className="text-xs text-muted-foreground">
                      {b.resourceName}
                    </span>
                    <Badge variant="outline" className={`ml-auto ${statusTone(b.status)}`}>
                      {STATUS_LABEL[b.status] ?? b.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 5 · Resources. ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {resources.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No resources yet.
              </p>
              <p className="mx-auto max-w-xl text-xs text-muted-foreground">
                A resource is anything that can be committed for a period — a
                room, a bed, a surgeon, a truck, a table. Capacity 1 means it
                is exclusive and the database makes double-booking impossible;
                anything higher is counted instead, under a lock, so a ward
                never holds 21 patients in 20 beds.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Resource</th>
                    <th className="px-4 py-2 font-medium">Kind</th>
                    <th className="px-4 py-2 font-medium">Group</th>
                    <th className="px-4 py-2 text-right font-medium">Capacity</th>
                    <th className="px-4 py-2 text-right font-medium">Overbook</th>
                    <th className="px-4 py-2 text-right font-medium">Buffer</th>
                    <th className="px-4 py-2 text-right font-medium">Live</th>
                    <th className="px-4 py-2 text-right font-medium">Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {resources.map((r) => (
                    <tr
                      key={r.id}
                      className={r.isActive ? "hover:bg-muted/40" : "opacity-60"}
                    >
                      <td className="px-4 py-2">
                        <span className="font-medium">{r.name}</span>
                        <div className="font-mono text-xs text-muted-foreground">
                          {r.code}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {KIND_LABEL[r.kind] ?? r.kind}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {r.groupName ?? "—"}
                      </td>
                      {/* ⭐ Capacity 1 and capacity 20 are protected by
                          completely different mechanisms. Worth showing. */}
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r.capacity}
                        {r.capacity === 1 && (
                          <div className="text-[10px] text-muted-foreground">
                            exclusive
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r.overbookLimit > 0 ? `+${r.overbookLimit}` : "—"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">
                        {r.bufferMinutes > 0 ? `${r.bufferMinutes}m` : "—"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r.liveBookings}
                        {r.overbookings > 0 && (
                          <span className="ml-1 text-amber-700 dark:text-amber-300">
                            ({r.overbookings} over)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {inr(r.baseRateMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 6 · Bookings. ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Bookings</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {bookings.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No bookings yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Reference</th>
                    <th className="px-4 py-2 font-medium">Resource</th>
                    <th className="px-4 py-2 font-medium">Party</th>
                    <th className="px-4 py-2 font-medium">From</th>
                    <th className="px-4 py-2 font-medium">To</th>
                    <th className="px-4 py-2 font-medium">Channel</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {bookings.slice(0, 300).map((b) => (
                    <tr
                      key={b.id}
                      className={
                        b.isOverbooking
                          ? "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20"
                          : "hover:bg-muted/40"
                      }
                    >
                      <td className="px-4 py-2 font-mono text-xs">
                        {b.reference ?? "—"}
                      </td>
                      <td className="px-4 py-2">{b.resourceName}</td>
                      <td className="px-4 py-2">
                        {b.partyName ?? "—"}
                        {b.partyPhone && (
                          <div className="text-xs text-muted-foreground">
                            {b.partyPhone}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-xs">
                        {when(b.startsAt)}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-xs">
                        {when(b.endsAt)}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {b.channel ?? "—"}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={statusTone(b.status)}>
                          {STATUS_LABEL[b.status] ?? b.status}
                        </Badge>
                        {b.isOverbooking && (
                          <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                            over capacity
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {inr(b.quotedRateMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 7 · Blocks. ───────────────────────────────────────────── */}
      {blocks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Out of service</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {blocks.map((b) => (
                <li key={b.id} className="flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm">
                  <span className="font-medium">{b.resourceName}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {b.kind.replace("_", " ")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{b.reason}</span>
                  <span className="ml-auto tabular-nums text-xs text-muted-foreground">
                    {when(b.startsAt)} → {when(b.endsAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Double-booking an exclusive resource is not prevented by this screen —
        it is impossible in the database, enforced by an exclusion constraint
        that holds under two simultaneous requests. Shared capacity is counted
        under a row lock, so a twenty-bed ward cannot hold twenty-one. The
        changeover buffer is part of the reserved period, not a separate
        check, so back-to-back bookings respect it even on the busiest day.
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

export default function SchedulingPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Scheduling</h1>
          <p className="text-sm text-muted-foreground">
            What is committed, to whom, and what is free.
          </p>
        </div>
        <Link href="/rates" className="text-sm text-muted-foreground hover:underline">
          Rate cards
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <ScheduleBody />
      </Suspense>
    </div>
  );
}
