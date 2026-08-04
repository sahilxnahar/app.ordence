/**
 * Ordence — Receivables
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * A FINISHED ENGINE WITH NO FACE
 * ══════════════════════════════════════════════════════════════════════
 * Phase 38 built the whole receivables stack — ageing buckets, dunning
 * ladders, demand notices in six languages, receipt allocation, bounce
 * handling — and shipped exactly zero screens. Every number below already
 * existed; nobody could see any of it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE BUCKET BOUNDARIES ARE NOT COSMETIC
 * ══════════════════════════════════════════════════════════════════════
 * 0–30, 31–60, 61–90, 90+ — matching what a bank asks for when it releases
 * a construction tranche. Day 90 is the LAST day of the 61–90 bucket, not
 * the first day of 90+. A screen that renders the boundary differently
 * from `lib/receivables/ageing.ts` would move accounts between buckets on
 * screen only, and the figure a developer reads off this page would stop
 * matching the figure the bank reads off the export. So this page renders
 * the buckets it is given and computes none of them.
 *
 * ⚠️ INTEREST SITS BESIDE THE BUCKETS, NEVER INSIDE THEM. Accrued interest
 * is not principal in arrears; adding it to a bucket would overstate the
 * arrears position to the one audience that checks.
 */

import { Suspense } from "react";
import Link from "next/link";
import { getAgeingReport } from "@/server/actions/receivables";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Receivables · Ordence" };

/** Minor units in, display out. Never parsed to a number — see the page header. */
function inr(minorUnits: string | null | undefined): string {
  if (!minorUnits) return "₹0.00";
  const negative = minorUnits.startsWith("-");
  const digits = (negative ? minorUnits.slice(1) : minorUnits).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

/** Display order and labels. Mirrors the engine — see the header. */
const BUCKETS = [
  { key: "current", label: "Not yet due", tone: "text-muted-foreground" },
  { key: "0-30", label: "0–30 days", tone: "text-foreground" },
  { key: "31-60", label: "31–60 days", tone: "text-amber-600" },
  { key: "61-90", label: "61–90 days", tone: "text-orange-600" },
  { key: "90+", label: "90+ days", tone: "text-red-600" },
] as const;

async function AgeingBody() {
  const result = await getAgeingReport({});

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Receivables unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { asOf, totals, totalMinor, overdueMinor, interestMinor, byProject, byBuyer } =
    result.data;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total outstanding
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">{inr(totalMinor)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Everything raised and unpaid, due or not
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              In arrears
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums text-red-600">
              {inr(overdueMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Past its due date. This is the number a bank asks for.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Interest accrued
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">{inr(interestMinor)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Reported beside the buckets, never inside them
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ageing</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Bucket</th>
                <th className="p-3 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {BUCKETS.map((bucket) => (
                <tr key={bucket.key}>
                  <td className="p-3 font-medium">{bucket.label}</td>
                  <td className={`p-3 text-right tabular-nums ${bucket.tone}`}>
                    {inr(totals[bucket.key])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Arrears by project</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {byProject.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">Nothing in arrears.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Project</th>
                    <th className="p-3 text-right font-medium">Demands</th>
                    <th className="p-3 text-right font-medium">Arrears</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {byProject.map((group) => (
                    <tr key={group.key}>
                      <td className="p-3">{group.label}</td>
                      <td className="p-3 text-right tabular-nums text-muted-foreground">
                        {group.demandCount}
                      </td>
                      <td className="p-3 text-right font-medium tabular-nums">
                        {inr(group.overdueMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Worst accounts</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {byBuyer.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">Nothing in arrears.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Buyer</th>
                    <th className="p-3 text-right font-medium">Oldest</th>
                    <th className="p-3 text-right font-medium">Arrears</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {byBuyer.map((group) => (
                    <tr key={group.key}>
                      <td className="p-3">{group.label}</td>
                      <td className="p-3 text-right">
                        <Badge
                          variant={
                            group.oldestDaysOverdue > 90 ? "destructive" : "outline"
                          }
                        >
                          {group.oldestDaysOverdue}d
                        </Badge>
                      </td>
                      <td className="p-3 text-right font-medium tabular-nums">
                        {inr(group.overdueMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        As at {asOf}. Buckets are computed by{" "}
        <code className="font-mono">lib/receivables/ageing.ts</code> — this page
        renders them and calculates nothing, so the figure here always matches
        the figure in the export.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-32 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function ReceivablesPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Receivables</h1>
          <p className="text-sm text-muted-foreground">
            What is owed, how late it is, and who to chase.
          </p>
        </div>
        <Link
          href="/settings/financial"
          className="text-sm text-muted-foreground hover:underline"
        >
          Dunning settings
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <AgeingBody />
      </Suspense>
    </div>
  );
}
