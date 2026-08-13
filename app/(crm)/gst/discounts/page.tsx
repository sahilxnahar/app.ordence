/**
 * Ordence — ⭐⭐ REBATES AND POST-SUPPLY DISCOUNTS
 * Version: v1.6.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO TOTALS ARE NEVER SUMMED
 * ══════════════════════════════════════════════════════════════════════
 * **Tax lost** is GST already paid on sales that were rebated and cannot
 * be recovered — money gone, because the agreement did not exist when
 * the supply was made. **Tax recoverable** is money a credit note can
 * still bring back.
 *
 * A single "rebates outstanding" figure hides which half is actionable,
 * and the actionable half is the only reason to open the screen.
 */

import Link from "next/link";
import { getDiscounts } from "@/server/actions/discounts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Rebates & discounts · Ordence" };

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

export default async function DiscountsPage() {
  const result = await getDiscounts();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Rebates &amp; discounts</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { agreements, discounts, taxLostMinor, taxRecoverableMinor } = result.data;
  const lateAgreements = agreements.filter((a) => !a.inTime);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Rebates &amp; discounts</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * 🔴 The trap, stated first. It is the reason the screen exists.
           */}
          A discount given after the sale reduces the GST only if the agreement
          behind it existed <em>before</em> that sale. A year-end rebate agreed
          in December cannot take back the tax on April&apos;s invoices.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className={taxLostMinor !== "0" ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              GST that cannot be recovered
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(taxLostMinor)}</p>
            <p className="text-xs text-muted-foreground">
              {/* 🔴 Paid on sales that were rebated. Money gone. */}
              Already paid on sales that were later rebated. The customer is
              credited; the tax is not.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              GST a credit note can still bring back
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(taxRecoverableMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/* ⚠️ Never added to the figure beside it. */}
              Every s.15(3)(b) condition is met on these.
            </p>
          </CardContent>
        </Card>

        <Card className={lateAgreements.length > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Agreements signed too late
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {lateAgreements.length}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⭐ The fix for next year, said now: sign it before the
               * period, not after it.
               */}
              Dated after the period they cover. Perfectly lawful, and no rebate
              under them can reduce tax. Next year, sign before the period
              starts.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Agreements{" "}
            <span className="font-normal text-muted-foreground">
              ({agreements.length})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Section 15(3)(b)(i) — the discount must be established under an
            agreement entered into <em>at or before</em> the supply.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {agreements.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rebate agreements recorded. Without one on file, a post-supply
              discount cannot reduce GST at all.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Agreement</th>
                  <th className="py-2 pr-3 font-medium">Customer</th>
                  <th className="py-2 pr-3 font-medium">Signed</th>
                  <th className="py-2 pr-3 font-medium">Covers</th>
                  <th className="py-2 pr-3 font-medium">Bands</th>
                  <th className="py-2 pr-3 font-medium">Tax adjustment</th>
                </tr>
              </thead>
              <tbody>
                {agreements.map((a) => (
                  <tr key={a.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <span className="font-medium">{a.referenceNo}</span>
                      <p className="text-xs text-muted-foreground">{a.title}</p>
                    </td>
                    <td className="py-2 pr-3">{a.companyName ?? "—"}</td>
                    <td className="py-2 pr-3 tabular-nums">{a.agreementDate}</td>
                    <td className="py-2 pr-3 tabular-nums text-xs">
                      {a.effectiveFrom} → {a.effectiveTo ?? "open"}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{a.slabCount}</td>
                    <td className="py-2 pr-3">
                      {a.inTime ? (
                        <Badge variant="default">possible</Badge>
                      ) : (
                        <Badge variant="destructive">not possible</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Rebates computed{" "}
            <span className="font-normal text-muted-foreground">
              ({discounts.length})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 The invoice count is not decoration. A rebate credited
             * as one lump against a period's turnover is exactly what
             * s.15(3)(b)(i) refuses — and it is also the only way the
             * customer can work out how much credit to reverse.
             */}
            Each one is apportioned across the invoices that earned it — the
            linkage s.15(3)(b)(i) requires, and the only way the customer can
            work out how much input credit to reverse.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {discounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None computed yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Rebate</th>
                  <th className="py-2 pr-3 font-medium">Period</th>
                  <th className="py-2 pr-3 text-right font-medium">Turnover</th>
                  <th className="py-2 pr-3 text-right font-medium">Rebate</th>
                  <th className="py-2 pr-3 text-right font-medium">GST at stake</th>
                  <th className="py-2 pr-3 font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {discounts.map((d) => (
                  <tr key={d.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <span className="font-medium">{d.referenceNo}</span>
                      <p className="text-xs text-muted-foreground">
                        {d.companyName ?? ""} · {d.invoiceCount} invoices
                      </p>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-xs">
                      {d.periodFrom} → {d.periodTo}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(d.turnoverMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(d.discountMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(d.taxAtStakeMinor)}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={d.reducesTax ? "default" : "destructive"}>
                        {d.reducesTax ? "tax reduces" : "tax lost"}
                      </Badge>
                      <p className="mt-1 max-w-md text-xs text-muted-foreground">
                        {d.verdictReason}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            One thing that changed, which most software has wrong
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Circular <strong>212/6/2024-GST</strong> required the supplier to
            hold a certificate or undertaking from the customer proving the input
            tax credit had been reversed.
          </p>
          <p>
            🔴 That circular was <strong>withdrawn by Circular
            253/10/2025-GST</strong> with effect from 1 October 2025. No separate
            evidentiary procedure is required now.
          </p>
          <p className="text-muted-foreground">
            {/**
             * ⚠️ The distinction that matters. Reading the withdrawal as
             * "the condition is gone" is wrong in the direction that
             * loses an assessment.
             */}
            ⚠️ The condition itself survived the withdrawal. Section
            15(3)(b)(ii) was not amended — the customer still has to have
            reversed the credit. Only the paperwork requirement went.
          </p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/rates/price-check" className="underline">
          Price check
        </Link>{" "}
        ·{" "}
        <Link href="/credit-notes" className="underline">
          Credit notes
        </Link>
      </p>
    </main>
  );
}
