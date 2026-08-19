/**
 * Ordence — TDS
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WAVE 1 — PHASE 36's ENGINE, FINALLY VISIBLE
 * ══════════════════════════════════════════════════════════════════════
 * Deductees, cumulative thresholds, rate determination, challans, returns
 * and certificates were all built and tested. None of it had a screen.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE TWO NUMBERS THAT COST REAL MONEY
 * ══════════════════════════════════════════════════════════════════════
 * 1. UNDEPOSITED TDS. Tax deducted from a vendor but not yet paid to the
 *    government accrues interest at 1.5% PER MONTH under s.201(1A) — and
 *    the month is counted as a whole month, so being one day late costs
 *    the same as being thirty. It is also a personal liability of the
 *    principal officer, not just the company's.
 *
 * 2. SECTION 206AB deductees. A vendor who has not filed returns attracts
 *    DOUBLE the normal rate. Deduct at the ordinary rate and the shortfall
 *    is recovered from you, not from them.
 *
 * Both are shown as headline figures, before anything reassuring. The
 * ordinary total is one scroll down; these two are what somebody needs to
 * act on today.
 *
 * ⚠️ CATCH-UP BASE IS SHOWN SEPARATELY FROM PAYMENT BASE. When a vendor
 * crosses a cumulative threshold mid-year, TDS becomes payable on
 * EVERYTHING paid earlier in the year, not just the payment that crossed
 * it. That retrospective amount is `catchUpBaseMinor`, and an accountant
 * who cannot see it separately cannot explain the deduction to the vendor.
 *
 * Rates are basis points — 1000 is 10%. Divided by 100 exactly once, here.
 */

import { Suspense } from "react";
import Link from "next/link";
import { getDeductees, getRegister, getInterestExposure } from "@/server/actions/tds";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "TDS · Ordence" };

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

/** Basis points → percentage. The only place this conversion happens. */
function bps(value: number): string {
  return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
}

/**
 * The Indian financial year for a date — April to March.
 *
 * ⚠️ Not the calendar year. A deduction on 1 April 2026 belongs to FY
 * 2026-27; one on 31 March 2026 belongs to 2025-26. Getting this wrong
 * files the amount in the wrong year's return.
 */
function currentFinancialYear(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const start = now.getUTCMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function TdsBody() {
  const financialYear = currentFinancialYear();

  const [deductees, register, interest] = await Promise.all([
    getDeductees(true),
    getRegister({ financialYear }),
    getInterestExposure({ financialYear, asOf: today() }),
  ]);

  const deducteeRows = deductees.ok ? deductees.data.rows : [];
  const summary = register.ok ? register.data.summary : null;
  const deductionRows = register.ok ? register.data.rows : [];
  const exposure = interest.ok ? interest.data : null;

  const deducteeName = new Map(deducteeRows.map((d) => [d.id, d.legalName]));

  const specified206ab = deducteeRows.filter((d) => d.isSpecifiedPerson206ab);
  const missingPan = deducteeRows.filter(
    (d) => !d.panNumber || d.panStatus !== "valid",
  );

  return (
    <div className="space-y-6">
      {/**
       * ⭐⭐⭐ THE LINK THAT MAKES EVERY PANEL BELOW CAPABLE OF BEING
       * NON-ZERO — wave one.
       *
       * 🔴 UNTIL THIS SHIPPED, THIS PAGE READ A TABLE NOTHING COULD
       * WRITE. `recordDeduction` holds the only INSERT into
       * `tds_deductions` and no screen, route or job called it. So
       * "deducted, not deposited" was structurally zero, the interest
       * exposure was structurally zero, and the quarterly return was
       * structurally empty — and all three looked like good news.
       */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
        <p className="text-muted-foreground">
          Deducting tax on a payment you are about to make? Ask what comes off
          it before the money moves — once the annual threshold is crossed the
          whole year&apos;s aggregate comes into charge at once, and the payee
          receives materially less than they expect.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/tds/deduct"
            className="rounded-md border px-3 py-1.5 font-medium underline"
          >
            Record a deduction
          </Link>
          {/*
            ⭐⭐ WAVE 10 — THE REST OF THE QUARTER, WHICH HAD NO SCREEN.
            Deducting was reachable; depositing, mapping, reconciling,
            filing and certifying were nine server actions with no caller.
            The deadlines and the penalties are all in that half.
          */}
          <Link
            href="/tds/compliance"
            className="rounded-md border px-3 py-1.5 font-medium underline"
          >
            Challans, returns and certificates
          </Link>
        </div>
      </div>

      {/* ── The two that cost money, first. See the page header. ─────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          className={
            exposure && exposure.notDepositedTdsMinor !== "0"
              ? "border-red-300 dark:border-red-800"
              : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Deducted, not deposited
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums text-red-600">
              {inr(exposure?.notDepositedTdsMinor ?? "0")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {exposure?.notDepositedCount ?? 0} deduction
              {(exposure?.notDepositedCount ?? 0) === 1 ? "" : "s"} · interest
              accruing at 1.5% per month
            </p>
          </CardContent>
        </Card>

        <Card
          className={
            exposure && exposure.interestMinor !== "0"
              ? "border-red-300 dark:border-red-800"
              : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Interest exposure · s.201(1A)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums text-red-600">
              {inr(exposure?.interestMinor ?? "0")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Part months count as whole months
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              TDS deducted · {financialYear}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(summary?.totalTdsMinor ?? "0")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary?.deductionCount ?? 0} deductions ·{" "}
              {summary?.deducteeCount ?? 0} deductees
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Deposited
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums text-emerald-600">
              {inr(summary?.totalDepositedMinor ?? "0")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Paid to the government against challans
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Compliance alarms ────────────────────────────────────────── */}
      {(specified206ab.length > 0 || missingPan.length > 0) && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader>
            <CardTitle>Deduct at a higher rate for these</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {specified206ab.length > 0 && (
              <div>
                <p className="font-medium">
                  {specified206ab.length} specified person{specified206ab.length === 1 ? "" : "s"} · s.206AB
                </p>
                <p className="text-xs text-muted-foreground">
                  Non-filers of income tax returns. Deduct at twice the ordinary
                  rate — the shortfall is recovered from you, not from them.
                </p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {specified206ab.map((d) => (
                    <li key={d.id}>
                      <Badge variant="destructive" className="text-xs font-normal">
                        {d.legalName}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {missingPan.length > 0 && (
              <div>
                <p className="font-medium">
                  {missingPan.length} without a valid PAN · s.206AA
                </p>
                <p className="text-xs text-muted-foreground">
                  No PAN means 20% flat, or the ordinary rate if higher.
                </p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {missingPan.slice(0, 20).map((d) => (
                    <li key={d.id}>
                      <Badge variant="outline" className="text-xs font-normal">
                        {d.legalName}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── By section ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>By section · {financialYear}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!summary || summary.bySection.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No deductions recorded this financial year.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Section</th>
                    <th className="p-3 text-right font-medium">Paid</th>
                    <th className="p-3 text-right font-medium">Chargeable</th>
                    <th className="p-3 text-right font-medium">TDS</th>
                    <th className="p-3 text-right font-medium">Undeposited</th>
                    <th className="p-3 text-right font-medium">Below threshold</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {summary.bySection.map((s) => (
                    <tr key={s.section} className="hover:bg-muted/30">
                      <td className="p-3">
                        <span className="font-mono text-xs">{s.section}</span>
                        <span className="block text-xs text-muted-foreground">
                          {s.label}
                        </span>
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {inr(s.paidBaseMinor)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {inr(s.chargeableBaseMinor)}
                      </td>
                      <td className="p-3 text-right font-medium tabular-nums">
                        {inr(s.tdsMinor)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {s.undepositedMinor !== "0" ? (
                          <span className="text-red-600">{inr(s.undepositedMinor)}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums text-muted-foreground">
                        {/*
                          Payments recorded but below the cumulative threshold,
                          so no TDS was due yet. Worth showing: these are the
                          amounts that will trigger a catch-up deduction the
                          moment the vendor crosses the limit.
                        */}
                        {s.belowThresholdCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Deduction register ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Deduction register</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {deductionRows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              Nothing yet. Deductions appear as vendor payments are recorded.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Date</th>
                    <th className="p-3 font-medium">Deductee</th>
                    <th className="p-3 font-medium">Section</th>
                    <th className="p-3 text-right font-medium">Payment</th>
                    <th className="p-3 text-right font-medium">Catch-up</th>
                    <th className="p-3 text-right font-medium">Rate</th>
                    <th className="p-3 text-right font-medium">TDS</th>
                    <th className="p-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {deductionRows.map((r) => (
                    <tr key={r.id} className="hover:bg-muted/30">
                      <td className="p-3 text-xs text-muted-foreground">
                        {r.deductionDate}
                        <span className="block">{r.quarter}</span>
                      </td>
                      <td className="p-3">{deducteeName.get(r.deducteeId) ?? "—"}</td>
                      <td className="p-3 font-mono text-xs">{r.section}</td>
                      <td className="p-3 text-right tabular-nums">
                        {inr(r.paymentBaseMinor)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {/*
                          Retrospective base, charged when a cumulative
                          threshold is crossed mid-year. Shown separately so an
                          accountant can explain the deduction to the vendor.
                        */}
                        {r.catchUpBaseMinor !== "0" ? (
                          <span className="text-amber-600">
                            {inr(r.catchUpBaseMinor)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {bps(r.rateBps)}
                        <span className="block text-xs text-muted-foreground">
                          {r.rateBasis}
                        </span>
                      </td>
                      <td className="p-3 text-right font-medium tabular-nums">
                        {inr(r.tdsMinor)}
                      </td>
                      <td className="p-3">
                        <Badge
                          variant={r.challanId ? "secondary" : "destructive"}
                          className="text-[10px]"
                        >
                          {r.challanId ? "deposited" : "not deposited"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Deductees ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Deductees</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {deducteeRows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No deductees yet. Each one carries its PAN, residency and s.206AB
              status, so the correct rate is chosen without anyone remembering
              to check.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Code</th>
                    <th className="p-3 font-medium">Name</th>
                    <th className="p-3 font-medium">PAN</th>
                    <th className="p-3 font-medium">Type</th>
                    <th className="p-3 font-medium">Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {deducteeRows.map((d) => (
                    <tr key={d.id} className="hover:bg-muted/30">
                      <td className="p-3 font-mono text-xs">{d.code}</td>
                      <td className="p-3">{d.legalName}</td>
                      <td className="p-3 font-mono text-xs">
                        {d.panNumber ?? "—"}
                        {d.panStatus !== "valid" ? (
                          <span className="block text-xs text-red-600">
                            {d.panStatus}
                          </span>
                        ) : null}
                      </td>
                      <td className="p-3 text-muted-foreground">{d.deducteeType}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {d.isSpecifiedPerson206ab && (
                            <Badge variant="destructive" className="text-[10px]">
                              206AB
                            </Badge>
                          )}
                          {d.isNonResident && (
                            <Badge variant="outline" className="text-[10px]">
                              non-resident
                            </Badge>
                          )}
                          {!d.isActive && (
                            <Badge variant="secondary" className="text-[10px]">
                              inactive
                            </Badge>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Financial year {financialYear}, as at {today()}. Thresholds are
        cumulative across the year and evaluated per deductee per section — the
        engine decides, this page renders.
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
      <div className="h-64 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function TdsPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">TDS</h1>
          <p className="text-sm text-muted-foreground">
            Deductees, deductions, thresholds and what is still owed to the
            government.
          </p>
        </div>
        <Link href="/purchases" className="text-sm text-muted-foreground hover:underline">
          Purchases
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <TdsBody />
      </Suspense>
    </div>
  );
}
