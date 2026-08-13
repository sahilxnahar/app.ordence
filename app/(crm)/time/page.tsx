/**
 * Ordence — ⭐⭐ TIME & BILLING
 * Version: v1.2.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WITHOUT THIS SCREEN THE WHOLE ENGINE WAS UNREACHABLE
 * ══════════════════════════════════════════════════════════════════════
 * v1.1.0 shipped rates, entries, approval, write-off and unbilled
 * summaries — every one of them tested, none of them callable by a human
 * being. A law firm would have kept its hours in a spreadsheet, which is
 * the outcome the module exists to prevent.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ APPROVED AND PENDING ARE SHOWN SEPARATELY AND NEVER ADDED
 * ══════════════════════════════════════════════════════════════════════
 * Approved time is money the firm will stand behind on a bill this week.
 * Pending time is a claim nobody has checked, and some of it will be
 * written down. One "unbilled WIP" figure adding both is the number that
 * makes a partner think the month was better than it was.
 *
 * ⚠️ AND THE UNRATED COUNT IS ITS OWN ALARM. An entry with no rate is
 * worth ₹0.00 — it is not missing from any total, it is silently zero
 * inside every one of them. That is the failure that is only found at
 * year end.
 */

import Link from "next/link";
import { getUnbilledTime, getBillingRates } from "@/server/actions/time-billing";
import { getCompanyOptions } from "@/server/actions/companies";
import { getTeamMembers } from "@/server/actions/team";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BillTime, type TimeRow } from "@/components/billing/bill-time";
import { RecordTime } from "@/components/billing/record-time";
import { BillingRateForm } from "@/components/billing/billing-rate-form";
import { minutesToHoursLabel } from "@/lib/billing/time";

export const dynamic = "force-dynamic";

export const metadata = { title: "Time & billing · Ordence" };

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

/** Today in the tenant's civil day, as YYYY-MM-DD. */
function today(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default async function TimePage() {
  const [unbilled, rates, companies, team] = await Promise.all([
    getUnbilledTime(),
    getBillingRates(),
    getCompanyOptions(),
    /**
     * ⚠️ THE PEOPLE LIST IS OPTIONAL AND ITS FAILURE IS NOT FATAL.
     * Reading the team needs `users:read`, which a billing clerk may not
     * have. Losing the person picker costs them a per-person rate; losing
     * the whole screen costs them the month's billing.
     */
    getTeamMembers(),
  ]);

  if (!unbilled.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Time &amp; billing</h1>
        <p className="text-sm text-destructive">{unbilled.error}</p>
      </main>
    );
  }

  const { rows, summary } = unbilled.data;
  const companyOptions = companies.ok ? companies.data : [];
  const rateRows = rates.ok ? rates.data.rows : [];
  const people = team.ok
    ? team.data.map((m) => ({
        id: m.id,
        name:
          [m.firstName, m.lastName].filter(Boolean).join(" ").trim() || m.email,
      }))
    : [];
  const day = today();

  /**
   * ⭐ GROUPED BY CLIENT ON THE SERVER, because that is the unit an
   * invoice is raised in. Grouping in the browser would work and would
   * put the decision in the wrong place.
   *
   * ⚠️ INTERNAL TIME — no client — gets its own group at the end and
   * cannot be billed. It is still shown, because a week that vanished
   * into internal work is exactly what a realisation figure is for.
   */
  const groups = new Map<string, { name: string; rows: TimeRow[] }>();
  for (const r of rows) {
    const key = r.companyId ?? "__internal__";
    const name = r.companyName ?? "Internal — no client";
    const g = groups.get(key) ?? { name, rows: [] };
    g.rows.push({
      id: r.id,
      userName: r.userName,
      subjectLabel: r.subjectLabel,
      entryDate: r.entryDate,
      minutes: r.minutes,
      billableMinutes: r.billableMinutes,
      isBillable: r.isBillable,
      rateMinor: r.rateMinor,
      valueMinor: r.valueMinor,
      narrative: r.narrative,
      status: r.status,
      rated: r.rated,
    });
    groups.set(key, g);
  }

  const grouped = [...groups.entries()].sort((a, b) => {
    if (a[0] === "__internal__") return 1;
    if (b[0] === "__internal__") return -1;
    return a[1].name.localeCompare(b[1].name);
  });

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Time &amp; billing</h1>
          <p className="text-sm text-muted-foreground">
            Hours recorded, what they are worth, and the invoice they become.
          </p>
        </div>
        <RecordTime companies={companyOptions} defaultDate={day} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Approved, ready to bill
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(summary.approvedValueMinor)}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {minutesToHoursLabel(summary.approvedMinutes)} approved
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Recorded, not yet approved
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(summary.pendingValueMinor)}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {/* ⚠️ Never added to the figure beside it. */}
              {minutesToHoursLabel(summary.pendingMinutes)} — a claim, not a bill
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Recoverable share of the day
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary.realisationPercent === null
                ? "—"
                : `${summary.realisationPercent}%`}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {minutesToHoursLabel(summary.nonBillableMinutes)} non-billable
            </p>
          </CardContent>
        </Card>

        <Card className={summary.unratedCount > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Entries with no rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary.unratedCount}
            </p>
            <p className="text-xs text-muted-foreground">
              {summary.unratedCount > 0
                ? "Worth ₹0.00 until a rate covers them — they are inside every total above as zero."
                : "Every recorded hour has a price."}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div>
            <CardTitle className="text-base">
              Rate card{" "}
              <span className="font-normal text-muted-foreground">
                ({rateRows.length})
              </span>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {/**
               * ⭐ THE HISTORY, NOT A CURRENT FIGURE. Every rate ever set
               * stays here, because March work billed in September has to
               * bill at March's rate.
               */}
              Every rate ever set stays here. Work bills at the rate that applied
              on the day it was done.
            </p>
          </div>
          <BillingRateForm
            companies={companyOptions}
            people={people}
            defaultDate={day}
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rateRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rates yet. Time can still be recorded — it saves unrated and
              waits for a partner to price it.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Person</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 text-right font-medium">Per hour</th>
                  <th className="py-2 pr-3 font-medium">From</th>
                  <th className="py-2 pr-3 font-medium">To</th>
                </tr>
              </thead>
              <tbody>
                {rateRows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">{r.userName ?? "—"}</td>
                    <td className="py-2 pr-3">{r.roleName ?? "—"}</td>
                    <td className="py-2 pr-3">{r.companyName ?? "any client"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(r.rateMinor)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{r.effectiveFrom}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {r.effectiveTo ?? (
                        <Badge variant="outline">still applies</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">Unbilled time</h2>
          <Link href="/invoices" className="text-sm underline">
            Invoices
          </Link>
        </div>

        {grouped.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nothing unbilled. Either the month has been billed, or nobody has
              written up their day.
            </CardContent>
          </Card>
        ) : (
          grouped.map(([key, g]) => (
            <BillTime
              key={key}
              companyId={key === "__internal__" ? null : key}
              companyName={g.name}
              rows={g.rows}
              defaultDate={day}
              canBill={key !== "__internal__"}
            />
          ))
        )}
      </div>
    </main>
  );
}
