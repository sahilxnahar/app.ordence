/**
 * Ordence — Purchases
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WAVE 1 — A FINISHED ENGINE THAT NOBODY COULD SEE
 * ══════════════════════════════════════════════════════════════════════
 * Phase 33 built vendors, purchase invoices, the input-tax-credit register
 * and Section 17(5) blocked-credit determination. Every rule is tested and
 * none of it had a screen. This is that screen.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ BLOCKED CREDIT IS THE NUMBER THIS PAGE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Section 17(5) of the CGST Act lists purchases whose GST can never be
 * reclaimed — motor vehicles, food and beverage, club memberships, works
 * contracts for immovable property. A developer who claims that credit
 * gets it reversed with interest at assessment, often years later.
 *
 * So blocked tax is shown as a headline figure in its own right, beside
 * the claimable one, rather than being netted off quietly. The whole point
 * is that somebody sees it *before* filing, not after.
 *
 * ⚠️ MSME status is surfaced on every vendor row. Under Section 43B(h),
 * payment to a registered micro or small enterprise beyond 45 days is
 * disallowed as an expense for that year. It is a payment-timing rule with
 * a tax consequence, and it is invisible unless the flag is on the screen.
 *
 * Money is bigint paise in strings throughout. Nothing here does
 * arithmetic on it beyond adding paise as BigInt — never a float.
 */

import { Suspense } from "react";
import Link from "next/link";
import { getVendors, getPurchaseInvoices, getItcRegister } from "@/server/actions/purchases";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Purchases · Ordence" };

/** Minor units in, Indian-grouped display out. Never parsed to a number. */
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

/** Sum a column of paise strings without ever touching a float. */
function sumPaise(values: Array<string | null | undefined>): string {
  return values.reduce((acc: bigint, v) => acc + BigInt(v ?? "0"), 0n).toString();
}

async function PurchasesBody() {
  const [vendors, invoices, itc] = await Promise.all([
    getVendors(true),
    getPurchaseInvoices(),
    getItcRegister(),
  ]);

  const vendorRows = vendors.ok ? vendors.data.rows : [];
  const invoiceRows = invoices.ok ? invoices.data.rows : [];
  const itcPeriods = itc.ok ? itc.data.periods : [];

  const vendorName = new Map(vendorRows.map((v) => [v.id, v.tradeName ?? v.legalName]));

  const totalTaxable = sumPaise(invoiceRows.map((r) => r.taxableValueMinor));
  const totalClaimable = sumPaise(invoiceRows.map((r) => r.itcEligibleTaxMinor));
  const totalBlocked = sumPaise(invoiceRows.map((r) => r.itcBlockedTaxMinor));

  const msmeVendors = vendorRows.filter((v) => v.msmeRegistered);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Taxable value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(totalTaxable)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {invoiceRows.length} purchase invoice{invoiceRows.length === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              ITC claimable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums text-emerald-600">
              {inr(totalClaimable)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Recoverable against output GST
            </p>
          </CardContent>
        </Card>

        {/* Shown as its own figure, never netted off. See the page header. */}
        <Card className={totalBlocked !== "0" ? "border-red-300 dark:border-red-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              ITC blocked · s.17(5)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums text-red-600">
              {inr(totalBlocked)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Can never be reclaimed. Claiming it invites reversal with interest.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              MSME vendors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{msmeVendors.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Section 43B(h) — pay within 45 days or lose the deduction
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Input tax credit by period</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {itcPeriods.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No ITC movements recorded yet. The register fills as purchase
              invoices are posted.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Period</th>
                    <th className="p-3 text-right font-medium">Claimed</th>
                    <th className="p-3 text-right font-medium">Blocked</th>
                    <th className="p-3 text-right font-medium">Deferred</th>
                    <th className="p-3 text-right font-medium">Reversed</th>
                    <th className="p-3 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {itcPeriods.map((p) => (
                    <tr key={p.taxPeriod} className="hover:bg-muted/30">
                      <td className="p-3 font-mono text-xs">{p.taxPeriod}</td>
                      <td className="p-3 text-right tabular-nums">
                        {inr(p.claimedTotalMinor)}
                      </td>
                      <td className="p-3 text-right tabular-nums text-red-600">
                        {inr(p.blockedTotalMinor)}
                      </td>
                      <td className="p-3 text-right tabular-nums text-muted-foreground">
                        {inr(p.deferredTotalMinor)}
                      </td>
                      <td className="p-3 text-right tabular-nums text-amber-600">
                        {inr(p.reversedTotalMinor)}
                      </td>
                      <td className="p-3 text-right font-medium tabular-nums">
                        {inr(p.netTotalMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Purchase invoices</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {invoiceRows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No purchase invoices yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Invoice</th>
                    <th className="p-3 font-medium">Vendor</th>
                    <th className="p-3 font-medium">Date</th>
                    <th className="p-3 text-right font-medium">Taxable</th>
                    <th className="p-3 text-right font-medium">Total</th>
                    <th className="p-3 text-right font-medium">ITC</th>
                    <th className="p-3 font-medium">Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {invoiceRows.map((r) => (
                    <tr key={r.id} className="hover:bg-muted/30">
                      <td className="p-3 font-mono text-xs">{r.invoiceNumber}</td>
                      <td className="p-3">{vendorName.get(r.vendorId) ?? "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.invoiceDate}</td>
                      <td className="p-3 text-right tabular-nums">
                        {inr(r.taxableValueMinor)}
                      </td>
                      <td className="p-3 text-right tabular-nums">{inr(r.totalMinor)}</td>
                      <td className="p-3 text-right tabular-nums">
                        {inr(r.itcEligibleTaxMinor)}
                        {r.itcBlockedTaxMinor !== "0" ? (
                          <span className="block text-xs text-red-600">
                            {inr(r.itcBlockedTaxMinor)} blocked
                          </span>
                        ) : null}
                      </td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {r.isReverseCharge && (
                            <Badge variant="outline" className="text-[10px]">RCM</Badge>
                          )}
                          {r.isTdsDeductible && (
                            <Badge variant="outline" className="text-[10px]">TDS</Badge>
                          )}
                          <Badge variant="secondary" className="text-[10px]">
                            {r.status}
                          </Badge>
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

      <Card>
        <CardHeader>
          <CardTitle>Vendors</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {vendorRows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No vendors yet. A vendor carries its GSTIN, PAN, MSME status and
              default TDS section, so every invoice raised against it is treated
              correctly without anyone remembering to.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-3 font-medium">Code</th>
                    <th className="p-3 font-medium">Name</th>
                    <th className="p-3 font-medium">Type</th>
                    <th className="p-3 font-medium">PAN</th>
                    <th className="p-3 text-right font-medium">Terms</th>
                    <th className="p-3 font-medium">Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {vendorRows.map((v) => (
                    <tr key={v.id} className="hover:bg-muted/30">
                      <td className="p-3 font-mono text-xs">{v.code}</td>
                      <td className="p-3">
                        {v.tradeName ?? v.legalName}
                        {v.tradeName ? (
                          <span className="block text-xs text-muted-foreground">
                            {v.legalName}
                          </span>
                        ) : null}
                      </td>
                      <td className="p-3 text-muted-foreground">{v.vendorType}</td>
                      <td className="p-3 font-mono text-xs">{v.panNumber ?? "—"}</td>
                      <td className="p-3 text-right tabular-nums">
                        {/*
                          Highlighted past 45 days for MSME vendors only —
                          that is where the deduction is actually at risk.
                        */}
                        <span
                          className={
                            v.msmeRegistered && v.paymentTermsDays > 45
                              ? "font-medium text-red-600"
                              : ""
                          }
                        >
                          {v.paymentTermsDays}d
                        </span>
                      </td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {v.msmeRegistered && (
                            <Badge className="text-[10px]">
                              MSME{v.msmeCategory ? ` · ${v.msmeCategory}` : ""}
                            </Badge>
                          )}
                          {v.tdsApplicable && (
                            <Badge variant="outline" className="text-[10px]">
                              TDS{v.defaultTdsSection ? ` ${v.defaultTdsSection}` : ""}
                            </Badge>
                          )}
                          {!v.isActive && (
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

export default function PurchasesPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Purchases</h1>
          <p className="text-sm text-muted-foreground">
            Vendors, purchase invoices and the input tax credit register.
          </p>
        </div>
        <Link href="/gst" className="text-sm text-muted-foreground hover:underline">
          GST settings
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <PurchasesBody />
      </Suspense>
    </div>
  );
}
