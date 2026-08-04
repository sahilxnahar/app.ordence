/**
 * Ordence — Channel Partners
 * Version: v0.22.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PAYOUT BLOCKER COLUMN IS WHY THIS PAGE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * A broker registry that lists names and phone numbers is an address
 * book. What a finance team actually needs to know is which of these
 * counterparties can legally be paid — and every reason one cannot is a
 * compliance exposure for the PAYER, not the payee.
 *
 * So the blocker is a first-class column, not a detail on a sub-page.
 *
 * ══════════════════════════════════════════════════════════════════════
 * SAVED VIEWS — WIRED IN v0.31.0, AND WHAT HAD TO HAPPEN FIRST
 * ══════════════════════════════════════════════════════════════════════
 * This page carried no `<SavedViewsShell>` until now, because
 * `channel_partners` was not an object in `lib/views/registry.ts` and
 * wiring the shell against a key the registry does not know produces a
 * view bar that refuses every action with "that record type does not
 * exist" — worse than the honest absence of one.
 *
 * The registry entry now exists, and the load-bearing part of it is the
 * `hide` list: `pan_number`, `gstin` and `notes` are absent from the
 * field map entirely, so a saved view cannot be built that turns this
 * register of third-party brokers into a bulk export of their taxpayer
 * identity numbers. The reasoning is written out in full next to the
 * entry itself, which is where somebody adding a column will be.
 *
 * ⚠️ THE SHELL FAILS SOFT. If the caller lacks `views:read`, or the
 * workspace's plan does not include saved views, the shell renders the
 * table below and nothing else. This page never depends on it.
 */

import Link from "next/link";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listChannelPartners } from "@/server/actions/sales-partners";
import { SavedViewsShell } from "@/components/views/saved-views-shell";

export const dynamic = "force-dynamic";

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  pending: "secondary",
  suspended: "destructive",
  terminated: "destructive",
};

function describeCommission(partner: {
  commissionBasis: string;
  commissionRateBps: number;
  commissionMonthsCentis: number | null;
  commissionFlatMinor: bigint | null;
}): string {
  switch (partner.commissionBasis) {
    case "percent_of_sale":
      return `${(partner.commissionRateBps / 100).toFixed(2)}% of sale`;
    case "months_of_rent":
      return partner.commissionMonthsCentis
        ? `${(partner.commissionMonthsCentis / 100).toFixed(2)} months of rent`
        : "Months of rent — not agreed";
    case "flat_fee":
      return partner.commissionFlatMinor
        ? `₹${new Intl.NumberFormat("en-IN").format(partner.commissionFlatMinor / 100n)} flat`
        : "Flat fee — not agreed";
    default:
      return "—";
  }
}

export default function PartnersPage() {
  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Channel partners</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Brokers, their commission terms, and whether they can be paid.
          </p>
        </div>
        <Button asChild>
          <Link href="/sales/partners/new">Register a partner</Link>
        </Button>
      </div>

      <Suspense
        fallback={<div className="h-64 animate-pulse rounded-lg border border-border bg-muted/30" />}
      >
        {/*
          ⚠️ NO `hrefPattern`, DELIBERATELY. It would make every row of a
          saved view link to `/sales/partners/<id>`, and that route does
          not exist yet — this page's own table already links there and
          already 404s, which is a separate outstanding item. Adding a
          second source of the same dead link because the prop was
          available would multiply the bug rather than fix it. Pass the
          pattern the day the detail page ships.
        */}
        <SavedViewsShell objectKey="channel_partner">
          <PartnerList />
        </SavedViewsShell>
      </Suspense>
    </div>
  );
}

async function PartnerList() {
  const result = await listChannelPartners();

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
        <p className="text-sm font-medium">No channel partners registered.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Registering a partner records their commission terms and starts the
          protection window on any lead they introduce.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Firm</th>
            <th scope="col" className="px-3 py-2 font-medium">Commission</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="px-3 py-2 font-medium">Pipeline</th>
            <th scope="col" className="px-3 py-2 font-medium">Can be paid?</th>
          </tr>
        </thead>
        <tbody>
          {result.data.rows.map((partner) => (
            <tr key={partner.id} className="border-t border-border">
              <td className="px-3 py-2">
                <Link
                  href={`/sales/partners/${partner.id}`}
                  className="font-medium hover:underline"
                >
                  {partner.firmName}
                </Link>
                <div className="text-[11px] text-muted-foreground">
                  {partner.code} · {partner.contactName} · {partner.phone}
                </div>
              </td>
              <td className="px-3 py-2 text-xs">{describeCommission(partner)}</td>
              <td className="px-3 py-2">
                <Badge
                  variant={STATUS_VARIANTS[partner.status] ?? "outline"}
                  className="text-[11px]"
                >
                  {partner.status}
                </Badge>
              </td>
              <td className="px-3 py-2 text-xs tabular-nums">
                {partner.registeredLeads} leads · {partner.liveBookings} bookings
              </td>
              <td className="px-3 py-2 text-xs">
                {partner.payoutBlocker ? (
                  <span className="text-destructive">{partner.payoutBlocker}</span>
                ) : (
                  <span className="text-emerald-700">Yes</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
