/**
 * Ordence — ⭐ THE CREDIT CONTROL BOARD
 * Version: v1.46.0-alpha (Batch 40)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS SCREEN IS AND — MORE IMPORTANTLY — WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It is a view of who is exposed, who is held, and what the ladder would
 * do next. IT IS NOT THE CONTROL.
 *
 * ⚠️ HIDING A BUTTON IS A MISTAKE GUARD, NOT A BOUNDARY. Every action
 * this page can reach is a `"use server"` export, which is a
 * browser-reachable RPC endpoint, and `curl` has never rendered a
 * button. The refusal that matters lives in `confirmOrder`, inside its
 * transaction, and throws — see `lib/credit/enforce.ts`. If this file
 * were deleted tomorrow, a held customer's order would still be refused.
 * That is the test of whether a control is real.
 *
 * ⚠️ AND THE FIGURES ARE PASSED IN AS STRINGS OF PAISE AND NEVER PARSED.
 * `Number("420000000")` is fine today and silently wrong at
 * ₹90,07,19,92,54,740.99. Nothing on this page does arithmetic; the
 * arithmetic happened in `lib/credit/headroom.ts` against `bigint`.
 */

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReconciliationNotice } from "@/components/reconciliation/reconciliation-notice";
import type { SerializedReconciliation } from "@/lib/reconciliation/gate";

/** Minor units in, display out. Never parsed to a number — see the header. */
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

export type CreditBoardRow = {
  companyId: string;
  companyName: string;
  limitMinor: string | null;
  exposureMinor: string;
  billedMinor: string;
  unbilledMinor: string;
  /**
   * 🔴 NULL WHEN THE RECONCILIATION BREACHED, and the type says so. A
   * page that ignored the gate would fail to compile rather than quietly
   * print an unverified ceiling.
   */
  figures: { headroomMinor: string | null; overLimit: boolean } | null;
  onHold: boolean;
  holdId: string | null;
  holdSource: "manual" | "automatic" | null;
  holdReason: string | null;
  autoHoldEnabled: boolean;
  autoHoldNote: string;
  reconciliation: SerializedReconciliation;
};

/**
 * ⚠️ THE HOLD BADGE SAYS WHY, NOT JUST THAT. "On hold" on its own sends
 * whoever reads it to find somebody who knows; the reason travels with
 * the hold precisely so that it does not have to.
 */
function HoldBadge({ row }: { row: CreditBoardRow }) {
  if (!row.onHold) return null;
  return (
    <Badge className="bg-red-600 text-white hover:bg-red-600">
      On hold{row.holdSource === "automatic" ? " (automatic)" : ""}
    </Badge>
  );
}

function HeadroomCell({ row }: { row: CreditBoardRow }) {
  /**
   * 🔴 THE BREACHED CASE PRINTS NO NUMBER AT ALL. Not a dash with a
   * tooltip, not the figure in grey — nothing. A correct number under a
   * heading that has just failed its own check reads to the person
   * holding it as verification.
   */
  if (row.figures === null) {
    return (
      <span className="text-red-700 dark:text-red-300">
        Not shown — this customer&rsquo;s position does not reconcile
      </span>
    );
  }
  if (row.figures.headroomMinor === null) {
    return <span className="text-muted-foreground">No limit set</span>;
  }
  return (
    <span className={row.figures.overLimit ? "font-medium text-red-600" : "text-foreground"}>
      {inr(row.figures.headroomMinor)}
    </span>
  );
}

export function CreditControlBoard({
  rows,
  scopeNote,
}: {
  rows: readonly CreditBoardRow[];
  scopeNote: string;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No customer has a credit limit or a hold</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            A customer with no limit and no hold has no ceiling and cannot be over
            it, so there is nothing here to say about them that their own record
            does not already say.
          </p>
          <p>{scopeNote}</p>
        </CardContent>
      </Card>
    );
  }

  const breached = rows.filter((r) => r.reconciliation.state === "breached");

  return (
    <div className="space-y-6">
      {/*
        ⚠️ ONE BANNER PER BREACHED CUSTOMER, NOT ONE FOR THE PAGE. The
        breach is per-customer arithmetic — one account's receipts have
        come apart from its invoices — and a page-level banner would
        suppress figures for the ninety customers who are fine.
      */}
      {breached.map((r) => (
        <ReconciliationNotice
          key={r.companyId}
          reconciliation={r.reconciliation}
          breachCauses={[
            "A receipt was marked bounced and the invoice it settled was not re-opened.",
            "An allocation row was written or removed outside the application.",
            "A restore or a backfill wrote `sales_invoices.received_minor` directly.",
          ]}
        />
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Credit position by customer</CardTitle>
          <p className="text-xs text-muted-foreground">{scopeNote}</p>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2 text-right">Limit</th>
                <th className="px-4 py-2 text-right">Billed</th>
                <th className="px-4 py-2 text-right">Committed, unbilled</th>
                <th className="px-4 py-2 text-right">Exposure</th>
                <th className="px-4 py-2 text-right">Headroom</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.companyId} className="border-b align-top last:border-0">
                  <td className="px-4 py-3">
                    {/*
                      ⚠️ THE STATEMENT, NOT A CUSTOMER OVERVIEW PAGE.
                      There is no `/companies/[id]` route — the question
                      somebody asks from this table is "what does this
                      figure consist of", and the statement is the answer.
                      A link to a page that does not exist is a 404 with
                      a customer's name on it.
                    */}
                    <Link
                      className="font-medium hover:underline"
                      href={`/companies/${row.companyId}/statement`}
                    >
                      {row.companyName}
                    </Link>
                    {row.holdReason ? (
                      <p className="mt-1 max-w-md text-xs text-muted-foreground">
                        {row.holdReason}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.limitMinor === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      inr(row.limitMinor)
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">{inr(row.billedMinor)}</td>
                  <td className="px-4 py-3 text-right">
                    {inr(row.unbilledMinor)}
                    {/*
                      ⚠️ THE UNVERIFIED HALF IS MARKED WHERE IT IS SHOWN,
                      not only in a note at the bottom. Nothing outside
                      the order book records a commitment that has not
                      become a document, so this column has no second
                      source and cannot have one.
                    */}
                    <span className="ml-1 text-xs text-muted-foreground" title="No second source">
                      *
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium">
                    {inr(row.exposureMinor)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <HeadroomCell row={row} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <HoldBadge row={row} />
                      <span className="text-xs text-muted-foreground">
                        {row.autoHoldNote}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        * The committed-but-not-yet-invoiced column has no second source to
        check it against. It is included in the exposure total and it is not
        verified.
      </p>
    </div>
  );
}
