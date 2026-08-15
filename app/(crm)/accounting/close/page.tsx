/**
 * Ordence — ⭐⭐⭐ CLOSING A MONTH
 * Version: v1.27.0-alpha · Batch 19
 *
 * ⚠️ The guards are on the actions, not on this route.
 *
 * 🔴 THIS SCREEN IS WHY THE CHECKPOINT KEPT BEING DEFERRED. "Close a
 * month for real" has been the standing next step for four sessions, and
 * there was nothing in the product that told anybody whether it was safe
 * to — only a button that would have said yes.
 */

import Link from "next/link";
import {
  getFinancialPeriods,
  getCloseReadiness,
  closeFinancialPeriod,
} from "@/server/actions/periods";
import { CloseBoard, type CloseReadinessData } from "@/components/accounting/close-board";
import { checkPermission } from "@/server/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Close a period · Ordence" };

export default async function ClosePeriodPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const params = await searchParams;
  const [periods, mayClose] = await Promise.all([
    getFinancialPeriods(),
    checkPermission("periods:close"),
  ]);

  if (!periods.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Close a period</h1>
        <p className="text-sm text-destructive">{periods.error}</p>
      </main>
    );
  }

  /**
   * ⚠️ THE OLDEST OPEN PERIOD, NOT THE NEWEST.
   *
   * Periods close in order — sealing October while September is open
   * would let a September document be posted into a month that has
   * already been reported. Defaulting to the newest would put the wrong
   * one in front of somebody who came here to close "the month".
   */
  const open = periods.data
    .filter((p) => p.status === "open")
    .sort((a, b) => (a.endDate < b.endDate ? -1 : 1));

  const selected = params.period
    ? open.find((p) => p.id === params.period)
    : open[0];

  if (!selected) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Close a period</h1>
        <p className="text-sm text-muted-foreground">
          There is no open period to close.{" "}
          <Link href="/accounting" className="underline">
            Accounting
          </Link>
        </p>
      </main>
    );
  }

  const readiness = await getCloseReadiness({ periodId: selected.id });

  if (!readiness.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Close a period</h1>
        <p className="text-sm text-destructive">{readiness.error}</p>
      </main>
    );
  }

  const data: CloseReadinessData = readiness.data;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Close a period</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Closing a month says the numbers in it are final. A month with documents still
          outside the ledger balances perfectly — the missing entries are missing from both
          sides — so this page checks what is missing rather than only what adds up.
        </p>
        {open.length > 1 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {open.length} periods are open. Close them oldest first:{" "}
            {open.map((p, i) => (
              <span key={p.id}>
                {i > 0 ? " · " : ""}
                <Link href={`/accounting/close?period=${p.id}`} className="underline">
                  {p.name}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
      </div>

      <CloseBoard
        periodId={selected.id}
        data={data}
        canClose={mayClose.allowed}
        onClose={closeFinancialPeriod}
      />
    </main>
  );
}
