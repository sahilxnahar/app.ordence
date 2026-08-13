/**
 * Ordence — ⭐⭐⭐ THE PAYMENT RUN
 * Version: v1.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MONEY GOING OUT HAS LESS DISCIPLINE ON IT THAN THE MONEY COMING
 *    IN, WHICH IS THE WRONG WAY ROUND
 * ══════════════════════════════════════════════════════════════════════
 * Receivables have ageing, credit limits, statements and reminders.
 * Payables, in most businesses, have a printout and a partner deciding
 * on a Friday.
 *
 * ⭐ AND THE DECISION IS NOT "WHO IS OLDEST". Two bills of the same size
 * and the same age are not equally urgent. One of them costs the
 * deduction on its whole value if it is still unpaid on 31 March.
 *
 * ⚠️ SO BLOCKED BILLS SORT TO THE TOP, NOT THE BOTTOM. They are the ones
 * needing a decision, and pushing them to the end of a long list is how
 * a bill sits unmatched for five months while everybody assumes somebody
 * else is looking at it.
 */

import Link from "next/link";
import { getPaymentRun } from "@/server/actions/vendor-payments";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Payment run · Ordence" };

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

export default async function PaymentRunPage() {
  const result = await getPaymentRun({});

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Payment run</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const {
    lines,
    payableTotalMinor,
    blockedTotalMinor,
    blockedCount,
    deductionAtRiskMinor,
    deductionAtRiskCount,
    interestAccruedMinor,
    byBucket,
    financialYearEndsOn,
    bankRateBps,
  } = result.data;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Payment run</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * 🔴 The sentence that explains the ordering.
           */}
          Not sorted by age. A bill to a micro or small enterprise costs the
          deduction on its whole value if it is still unpaid on 31 March, and a
          bill whose goods never arrived should not be paid at all. Both of
          those beat being old.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={deductionAtRiskCount > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Deduction at risk
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(deductionAtRiskMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * 🔴 Not delayed. Added back.
               */}
              {deductionAtRiskCount} bill{deductionAtRiskCount === 1 ? "" : "s"} to
              micro or small enterprises. Still unpaid on {financialYearEndsOn} and
              the whole expense is added back to taxable income for the year.
            </p>
          </CardContent>
        </Card>

        <Card className={blockedCount > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Cannot be paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(blockedTotalMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {blockedCount} bill{blockedCount === 1 ? "" : "s"} held back. These
              sort to the top because they need a decision, not to the bottom
              where nobody sees them.
            </p>
          </CardContent>
        </Card>

        <Card className={interestAccruedMinor !== "0" ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Interest running
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(interestAccruedMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⚠️ Compounding, mandatory, and never deductible.
               */}
              Section 16 MSMED interest at three times the RBI bank rate
              ({(bankRateBps / 100).toFixed(2)}%), compounded monthly. It is not
              deductible under any section of the Income Tax Act.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Payable now
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(payableTotalMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              Everything that has passed its three-way match and is not on hold.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Ageing, from the due date</CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 Not from the bill date. Two different numbers, one true.
             */}
            From the due date, never the bill date. A bill dated the 1st on sixty
            day terms is not sixty days overdue on the 1st of March; it is not
            due at all.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                {byBucket.map((b) => (
                  <th key={b.bucket} className="py-2 pr-3 text-right font-medium">
                    {b.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {byBucket.map((b) => (
                  <td key={b.bucket} className="py-2 pr-3 text-right tabular-nums">
                    {inr(b.amountMinor)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            What to pay{" "}
            <span className="font-normal text-muted-foreground">({lines.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing outstanding. Either every bill is settled or none has been
              approved yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Vendor</th>
                  <th className="py-2 pr-3 font-medium">Bill</th>
                  <th className="py-2 pr-3 font-medium">Due</th>
                  <th className="py-2 pr-3 text-right font-medium">Outstanding</th>
                  <th className="py-2 pr-3 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr
                    key={l.invoiceId}
                    className={`border-b last:border-0 align-top ${
                      !l.payable ? "bg-red-50/50" : ""
                    }`}
                  >
                    <td className="py-2 pr-3">{l.vendorName}</td>
                    <td className="py-2 pr-3">
                      {l.invoiceNumber}
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {l.invoiceDate}
                      </p>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {l.dueOn ?? <span className="text-destructive">no date</span>}
                      {l.daysOverdue > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {l.daysOverdue} days over
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums font-medium">
                      {inr(l.outstandingMinor)}
                      {l.msmeInterestMinor !== "0" && (
                        <p className="text-xs text-amber-700">
                          + {inr(l.msmeInterestMinor)} interest
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {!l.payable ? (
                        <>
                          <Badge variant="destructive">cannot pay</Badge>
                          <p className="mt-1 max-w-md text-xs">{l.blockedReason}</p>
                        </>
                      ) : (
                        <>
                          {l.deductionAtRisk && (
                            <Badge variant="destructive">deduction at risk</Badge>
                          )}
                          {l.msmeHeadline && (
                            <p className="mt-1 text-xs font-medium">{l.msmeHeadline}</p>
                          )}
                          <p className="mt-1 max-w-md text-xs text-muted-foreground">
                            {l.why}
                          </p>
                        </>
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
          <CardTitle className="text-base">Why an MSME bill jumps the queue</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            🔴 A sum payable to a <strong>micro or small</strong> enterprise beyond
            the section 15 MSMED limit is deductible <strong>only on actual
            payment</strong>. Unpaid at 31 March and the whole expense is added
            back to taxable income for that year. Not delayed. Added back. The
            deduction returns in whichever year the money finally moves.
          </p>
          <p>
            ⚠️ <strong>Fifteen days, not forty-five, unless there is a written
            agreement.</strong> Forty-five is the maximum a written agreement can
            reach, and no contract can exceed it however it is drafted. Most firms
            assume 45 and most of their purchases have nothing in writing.
          </p>
          <p>
            ⚠️ <strong>Medium enterprises are not covered, and nor are
            traders.</strong> Only manufacturers and service providers are
            suppliers under section 15. Treating every registered MSME as in scope
            makes this report cry wolf until nobody reads it.
          </p>
          <p>
            ⭐ <strong>Paid late but before 31 March still keeps the
            deduction.</strong> The disallowance bites on what is outstanding at
            year end, not on lateness. Lateness costs interest instead, and that
            interest is never deductible.
          </p>
          <p>
            The rule arrived as section 43B(h) of the Income Tax Act 1961 and is
            section 37(2)(g) of the Income Tax Act 2025 from tax year 2026-27.
            Both are cited because a firm looking at an older assessment needs the
            older number.
          </p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/purchases" className="underline">
          Purchases
        </Link>{" "}
        ·{" "}
        <Link href="/tds" className="underline">
          TDS
        </Link>{" "}
        ·{" "}
        <Link href="/accounting" className="underline">
          Ledger
        </Link>
      </p>
    </main>
  );
}
