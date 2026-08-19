/**
 * Ordence — ⭐⭐ DISBURSEMENTS AND COURT FEE REFUNDS
 * Version: v1.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ₹500 THAT COSTS ₹9,090
 * ══════════════════════════════════════════════════════════════════════
 * Under Rule 33 a pure agent receives "only the actual amount incurred".
 * Round a ₹50,000 court fee up to ₹50,500 on the bill and the exclusion
 * is lost — not on the ₹500, on the whole ₹50,500, which then bears tax.
 *
 * ⚠️ THE "AT RISK" COUNTER SHOULD ALWAYS BE ZERO, for the same reason
 * the client account's "in debit" counter should: the constraint makes
 * it impossible through the product. It is shown because a restored
 * backup or a bulk import is not the product, and because a control
 * nobody displays is a control nobody trusts.
 */

import Link from "next/link";
import { getDisbursements, getRefundClaims } from "@/server/actions/disbursements";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Disbursements · Ordence" };

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

const ROUTE_LABEL: Record<string, string> = {
  lok_adalat: "Lok Adalat award",
  court_referred_mediation: "Court-referred mediation",
  court_referred_arbitration: "Court-referred arbitration",
  private_settlement: "Private settlement",
  withdrawal: "Withdrawn",
};

export default async function DisbursementsPage() {
  const [d, refunds] = await Promise.all([getDisbursements(), getRefundClaims()]);

  if (!d.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Disbursements</h1>
        <p className="text-sm text-destructive">{d.error}</p>
      </main>
    );
  }

  const {
    rows,
    unbilledMinor,
    unbilledCount,
    pureAgentMinor,
    taxableRecoveriesMinor,
    atRiskCount,
  } = d.data;
  const claims = refunds.ok ? refunds.data : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Disbursements</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * 🔴 The rule first, in the words that make it expensive.
           */}
          A court fee paid for a client and recovered at exactly what was paid
          is outside the value of supply altogether — Rule 33 of the CGST Rules.
          Recover a rupee more and the exclusion is lost on the{" "}
          <em>whole</em> recovery, not on the rupee.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={atRiskCount > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Rule 33 at risk
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{atRiskCount}</p>
            <p className="text-xs text-muted-foreground">
              {atRiskCount === 0
                ? "Zero, and the database refuses to create one. A pure agent line whose recovery differs from its payment is rejected at the point of entry."
                : "🔴 A line marked as a pure agent recovery does not satisfy Rule 33 on today's figures. This should be impossible through the product — check what wrote these rows."}
            </p>
          </CardContent>
        </Card>

        <Card className={unbilledCount > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Paid out, not billed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(unbilledMinor)}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * 🔴 The quietest leak in a law firm — no invoice exists,
               * so nothing shows it as overdue.
               */}
              {unbilledCount} item{unbilledCount === 1 ? "" : "s"}. No invoice was
              ever raised for these, so nothing chases them and nothing shows
              them as overdue. They simply sit.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Outside the value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{inr(pureAgentMinor)}</p>
            <p className="text-xs text-muted-foreground">
              Pure agent recoveries. These carry no tax and are printed on their
              own lines — Rule 33(ii) requires them to be separately indicated.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              In the value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(taxableRecoveriesMinor)}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⚠️ Travel and courier belong here and firms constantly
               * put them in the other column.
               */}
              Recoveries that are part of what the firm supplied — travel,
              courier, anything the client was never liable to the third party
              for. They bear tax at the rate the fee bears.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Everything paid out{" "}
            <span className="font-normal text-muted-foreground">({rows.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded. Court fees, process fees and stamp duty paid for
              a client appear here and go onto the fee note as separate lines.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Matter</th>
                  <th className="py-2 pr-3 font-medium">What</th>
                  <th className="py-2 pr-3 text-right font-medium">Paid</th>
                  <th className="py-2 pr-3 text-right font-medium">Recovered</th>
                  <th className="py-2 pr-3 font-medium">Rule 33</th>
                  <th className="py-2 pr-3 font-medium">Billed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 tabular-nums">{r.disbursementDate}</td>
                    <td className="py-2 pr-3">
                      <Link href={`/legal/matters/${r.matterId}`} className="underline">
                        {r.matterNo}
                      </Link>
                      <p className="text-xs text-muted-foreground">{r.clientName ?? "—"}</p>
                    </td>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{r.kindLabel}</span>
                      <p className="text-xs text-muted-foreground">{r.description}</p>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{inr(r.paidMinor)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(r.recoveredMinor)}
                    </td>
                    <td className="py-2 pr-3">
                      {r.atRisk ? (
                        <>
                          <Badge variant="destructive">at risk</Badge>
                          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                            {r.riskReason}
                          </p>
                        </>
                      ) : r.isPureAgent ? (
                        <Badge variant="default">outside value</Badge>
                      ) : (
                        <Badge variant="outline">taxable</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {r.billed ? (
                        <Badge variant="outline">billed</Badge>
                      ) : (
                        <Badge variant="secondary">not billed</Badge>
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
            Court fee refunds{" "}
            <span className="font-normal text-muted-foreground">
              ({claimCount(claims)})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 The 2024 Supreme Court distinction, stated where the
             * decision is made.
             */}
            How the case ended decides whether the fee comes back, not how much
            it was. A Lok Adalat award carries a full statutory refund under
            s.21 of the Legal Services Authorities Act. A mediated settlement
            does <em>not</em> get that refund by extension — the Supreme Court
            held on 20 December 2024 that the two cannot be equated — and gets
            whatever the State&apos;s own Court Fees Act gives it.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {claims === null || claims.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No refund claims recorded. A settled matter with a court fee on it
              is usually worth one.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-4 text-sm">
                <span>
                  Outstanding:{" "}
                  <span className="font-semibold tabular-nums">
                    {inr(claims.outstandingMinor)}
                  </span>
                </span>
                {claims.needStateCheck > 0 && (
                  <span className="text-amber-700">
                    ⚠️ {claims.needStateCheck} depend on the State&apos;s own Act —
                    check before promising the client
                  </span>
                )}
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Matter</th>
                    <th className="py-2 pr-3 font-medium">How it ended</th>
                    <th className="py-2 pr-3 font-medium">Settled</th>
                    <th className="py-2 pr-3 text-right font-medium">Claimed</th>
                    <th className="py-2 pr-3 text-right font-medium">Received</th>
                    <th className="py-2 pr-3 font-medium">Entitlement</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.rows.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">{c.matterNo}</td>
                      <td className="py-2 pr-3">
                        {ROUTE_LABEL[c.settlementRoute] ?? c.settlementRoute}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{c.settledOn}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {inr(c.claimedMinor)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {inr(c.receivedMinor)}
                      </td>
                      <td className="py-2 pr-3">
                        {c.verdict === "full" ? (
                          <Badge variant="default">full refund</Badge>
                        ) : c.verdict === "none" ? (
                          <Badge variant="outline">not refundable</Badge>
                        ) : (
                          <Badge variant="secondary">depends on the State</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Ordence ships no court fee rates, and that is deliberate
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Court fees are a State subject. The Court Fees Act 1870 still runs in
            some States; Maharashtra has the Bombay Court Fees Act 1959; a dozen
            other States each have their own Act, Schedule, ad valorem slabs and
            maximum, amended on State budget cycles that are not published
            anywhere a software vendor reliably sees.
          </p>
          <p>
            🔴 A stale slab is worse than an empty table. A firm that reads the
            fee off the schedule on the registry wall is right. A firm that
            trusts a number Ordence computed from an eighteen-month-old table
            while filing in another State has its plaint returned for deficit
            court fee — which loses the filing date, and can lose the limitation
            with it.
          </p>
          <p>
            ⭐ So the firm types its own schedule once, from the Act, and Ordence
            does the arithmetic and shows its working. That is the honest
            division of labour.
          </p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/legal/matters" className="underline">
          Matters
        </Link>{" "}
        ·{" "}
        <Link href="/legal/fee-note" className="underline">
          Fee note
        </Link>{" "}
        ·{" "}
        <Link href="/legal/client-account" className="underline">
          Client account
        </Link>
      </p>
    </main>
  );
}

/** ⚠️ Refund claims load independently; a failure there must not blank the page. */
function claimCount(claims: { rows: unknown[] } | null): number {
  return claims === null ? 0 : claims.rows.length;
}
