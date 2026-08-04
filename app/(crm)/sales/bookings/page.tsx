/**
 * Ordence — Bookings
 * Version: v0.22.0-alpha
 * Runtime: Node
 */

import Link from "next/link";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listBookings } from "@/server/actions/sales-bookings";
import { SavedViewsShell } from "@/components/views/saved-views-shell";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  tentative: "Tentative",
  confirmed: "Confirmed",
  agreement: "Agreement",
  registered: "Registered",
  cancelled: "Cancelled",
};

const PAYMENT_LABELS: Record<string, string> = {
  pending: "Nothing received",
  partial: "Part paid",
  paid: "Paid in full",
  overdue: "Overdue",
};

function formatPaise(minor: bigint | null): string {
  if (minor === null) return "—";
  return `₹${new Intl.NumberFormat("en-IN").format(minor / 100n)}`;
}

export default function BookingsPage() {
  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Bookings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every unit committed to a buyer, and what has been collected against it.
          </p>
        </div>
        <Button asChild>
          <Link href="/sales/bookings/new">New booking</Link>
        </Button>
      </div>

      <Suspense
        fallback={<div className="h-64 animate-pulse rounded-lg border border-border bg-muted/30" />}
      >
        {/*
          ⭐ PHASE 28. `bookings` has no `deleted_at` — a booking is
          cancelled, never deleted, because it moved money — and the
          registry says so (`softDelete: false`). Every view over this
          object therefore omits the soft-delete clause, which is the
          reason that flag exists rather than being assumed.
        */}
        <SavedViewsShell objectKey="booking" hrefPattern="/sales/bookings/{id}">
          <BookingList />
        </SavedViewsShell>
      </Suspense>
    </div>
  );
}

async function BookingList() {
  const result = await listBookings();

  if (!result.ok) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-8 text-center">
        <p className="text-sm text-muted-foreground">{result.error}</p>
      </div>
    );
  }

  if (result.data.rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <p className="text-sm font-medium">No bookings yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A booking is created against a unit and a lead. It takes the unit off the
          market immediately — no two buyers can be booked into the same flat.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">{result.data.total} bookings</caption>
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Booking</th>
            <th scope="col" className="px-3 py-2 font-medium">Unit</th>
            <th scope="col" className="px-3 py-2 font-medium">Buyer</th>
            <th scope="col" className="px-3 py-2 font-medium">Stage</th>
            <th scope="col" className="px-3 py-2 font-medium">Payment</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {result.data.rows.map((booking) => (
            <tr key={booking.id} className="border-t border-border">
              <td className="px-3 py-2">
                <Link
                  href={`/sales/bookings/${booking.id}`}
                  className="font-medium hover:underline"
                >
                  {booking.reference}
                </Link>
                <div className="text-[11px] text-muted-foreground">
                  {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(
                    booking.bookedAt,
                  )}
                  {booking.partnerFirmName ? ` · via ${booking.partnerFirmName}` : ""}
                </div>
              </td>
              <td className="px-3 py-2 text-xs">
                {booking.unitCode ?? "—"}
                {booking.projectName ? (
                  <div className="text-[11px] text-muted-foreground">
                    {booking.projectName}
                  </div>
                ) : null}
              </td>
              <td className="px-3 py-2 text-xs">{booking.leadName ?? "—"}</td>
              <td className="px-3 py-2">
                <Badge
                  variant={booking.status === "cancelled" ? "destructive" : "outline"}
                  className="text-[11px]"
                >
                  {STATUS_LABELS[booking.status] ?? booking.status}
                </Badge>
              </td>
              <td className="px-3 py-2 text-xs">
                <span
                  className={
                    booking.paymentStatus === "overdue"
                      ? "font-medium text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {PAYMENT_LABELS[booking.paymentStatus] ?? booking.paymentStatus}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatPaise(booking.agreementValueMinor)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
