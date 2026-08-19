/**
 * Ordence — Channel partner detail
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS PAGE EXISTED AS A LINK BEFORE IT EXISTED AS A PAGE
 * ══════════════════════════════════════════════════════════════════════
 * `/sales/partners` has linked here since Phase 22 and the route was never
 * built, so every click produced a 404. `getChannelPartner()` was already
 * written, already tested, already returning the commission and TDS maths.
 * Only the surface was missing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE PAYOUT BLOCKER IS THE POINT OF THIS SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * A channel partner in Indian real estate is paid on booking, and the two
 * ways that goes wrong are paying someone who should not be paid yet, and
 * failing to pay someone who should. `payoutBlocker` answers the first in
 * one sentence, and it is placed above the money for that reason: an
 * operator who sees a payable figure first has already decided to pay.
 *
 * Commission and TDS are computed server-side and arrive as `bigint` paise.
 * The sums below happen in this Server Component and only formatted strings
 * are rendered — a `bigint` cannot cross into a client component at all,
 * which turns the precision rule into something the compiler enforces
 * rather than something a reviewer has to notice.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getChannelPartner } from "@/server/actions/sales-partners";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

/** Minor units in, display string out. Never parsed into a number. */
function inr(minorUnits: string | number | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return "—";
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

export default async function PartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getChannelPartner({ id });

  if (!result.ok) {
    // ⚠️ notFound(), not the error message. A partner id that belongs to
    // another tenant is refused by row-level security and arrives here as
    // "not found" — and it must stay indistinguishable from a genuinely
    // missing id, or the 404 becomes an existence oracle.
    notFound();
  }

  const { partner, payoutBlocker, lockedLeads, pipeline } = result.data;

  /*
   * ⚠️ bigint arithmetic, and it stays server-side.
   *
   * `computeCommission()` and `computeTds()` return `bigint` because every
   * amount in this system is paise and a JavaScript number silently loses
   * precision above 2^53 — about ₹90,000 crore, which a real-estate
   * portfolio reaches. This is a Server Component, so the sums happen here
   * and only formatted strings are ever rendered. A `bigint` cannot cross
   * to a client component at all, which is a useful guard rail rather than
   * an obstacle.
   */
  const totalCommission = pipeline.reduce((sum, row) => sum + row.commission.grossMinor, 0n);
  const totalTds = pipeline.reduce((sum, row) => sum + row.tds.tdsMinor, 0n);

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <nav className="text-sm text-muted-foreground">
          <Link href="/sales/partners" className="hover:underline">
            Channel partners
          </Link>
          <span className="px-2">/</span>
          <span>{partner.firmName}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{partner.firmName}</h1>
          <Badge variant={partner.status === "active" ? "default" : "secondary"}>
            {partner.status}
          </Badge>
          {partner.reraNumber ? (
            <Badge variant="outline" className="font-mono text-xs">
              RERA {partner.reraNumber}
            </Badge>
          ) : null}
        </div>
      </header>

      {/* The blocker comes before the money. See the header comment. */}
      {payoutBlocker ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
          <p className="text-sm font-medium">Payout is blocked</p>
          <p className="mt-1 text-sm text-muted-foreground">{payoutBlocker}</p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Gross commission
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(totalCommission.toString())}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Across {pipeline.length} booking{pipeline.length === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              TDS to withhold
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(totalTds.toString())}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Deducted at source — not payable to the partner
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Net payable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr((totalCommission - totalTds).toString())}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {payoutBlocker ? "Blocked — see above" : "Clear to pay"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Commission by booking</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {pipeline.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No bookings attributed to this partner yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Booking</th>
                    <th className="p-3 text-right font-medium">Agreement value</th>
                    <th className="p-3 text-right font-medium">Commission</th>
                    <th className="p-3 text-right font-medium">TDS</th>
                    <th className="p-3 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pipeline.map((row) => {
                    const gross = row.commission.grossMinor;
                    const tds = row.tds.tdsMinor;
                    return (
                      <tr key={row.bookingReference} className="hover:bg-muted/30">
                        <td className="p-3 font-mono text-xs">{row.bookingReference}</td>
                        <td className="p-3 text-right tabular-nums">
                          {inr(row.agreementValueMinor)}
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          {inr(gross.toString())}
                        </td>
                        <td className="p-3 text-right tabular-nums text-muted-foreground">
                          {inr(tds.toString())}
                        </td>
                        <td className="p-3 text-right font-medium tabular-nums">
                          {inr((gross - tds).toString())}
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

      <Card>
        <CardHeader>
          <CardTitle>Leads currently locked to this partner</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {lockedLeads.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No active lock. Any lead this partner registers is exclusive to
              them for the lock window, and nobody else can claim it in that
              time.
            </p>
          ) : (
            <ul className="divide-y">
              {lockedLeads.map((lead) => (
                <li key={lead.id} className="flex items-center justify-between p-4">
                  <div>
                    <Link
                      href={`/sales/leads?lead=${lead.id}`}
                      className="font-medium hover:underline"
                    >
                      {lead.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">
                      {lead.reference}
                    </p>
                  </div>
                  <Badge variant="outline">
                    {lead.daysRemaining === null
                      ? "locked"
                      : `${lead.daysRemaining}d remaining`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
