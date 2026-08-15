/**
 * Ordence — ⭐⭐⭐ GSTR-3B
 * Version: v1.24.0-alpha · Batch 16
 *
 * ⚠️ The guards are on the actions, not on this route.
 */

import Link from "next/link";
import {
  finaliseGstr3b,
  listReturns,
  postReturnJournal,
  prepareGstr3b,
  recordGstr3bFiled,
  supersedeReturn,
} from "@/server/actions/returns";
import { getRegistrations } from "@/server/actions/gst";
import { Gstr3bBoard, type ReturnView } from "@/components/returns/gstr3b-board";
import { checkPermission } from "@/server/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "GSTR-3B · Ordence" };

export default async function Gstr3bPage() {
  const [returns, registrations, prepare, post] = await Promise.all([
    listReturns(),
    getRegistrations(),
    checkPermission("gst:manage_rates"),
    checkPermission("transactions:post"),
  ]);

  if (!returns.ok) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">GSTR-3B</h1>
        <p className="text-sm text-destructive">{returns.error}</p>
      </main>
    );
  }

  const defaultGstin =
    registrations.ok && registrations.data.rows.length > 0
      ? String((registrations.data.rows[0] as Record<string, unknown>).gstin ?? "")
      : "";

  const rows: ReturnView[] = returns.data.rows.map((r) => ({
    id: String(r.id),
    gstin: String(r.gstin),
    taxPeriod: String(r.taxPeriod),
    status: String(r.status),
    dueOn: r.dueOn ? String(r.dueOn).slice(0, 10) : null,
    arn: r.arn ? String(r.arn) : null,
    hasJournal: Boolean(r.transactionId),
    outputIgstMinor: String(r.outputIgstMinor ?? "0"),
    outputCgstMinor: String(r.outputCgstMinor ?? "0"),
    outputSgstMinor: String(r.outputSgstMinor ?? "0"),
    itcIgstMinor: String(r.itcIgstMinor ?? "0"),
    itcCgstMinor: String(r.itcCgstMinor ?? "0"),
    itcSgstMinor: String(r.itcSgstMinor ?? "0"),
    cashIgstMinor: String(r.cashIgstMinor ?? "0"),
    cashCgstMinor: String(r.cashCgstMinor ?? "0"),
    cashSgstMinor: String(r.cashSgstMinor ?? "0"),
    cashCessMinor: String(r.cashCessMinor ?? "0"),
    interestMinor: String(r.interestMinor ?? "0"),
    lateFeeMinor: String(r.lateFeeMinor ?? "0"),
    totalCashMinor: String(r.totalCashMinor ?? "0"),
    carriedIgstMinor: String(r.carriedIgstMinor ?? "0"),
    carriedCgstMinor: String(r.carriedCgstMinor ?? "0"),
    carriedSgstMinor: String(r.carriedSgstMinor ?? "0"),
    setoffMoves: Array.isArray(r.setoffMoves)
      ? (r.setoffMoves as Array<Record<string, unknown>>).map((m) => ({
          creditHead: String(m.creditHead ?? ""),
          liabilityHead: String(m.liabilityHead ?? ""),
          amountMinor: String(m.amountMinor ?? "0"),
          rule: String(m.rule ?? ""),
        }))
      : [],
    notes: Array.isArray(r.notes) ? (r.notes as string[]) : [],
    problems: Array.isArray(r.problems) ? (r.problems as string[]) : [],
  }));

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">GSTR-3B</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          GSTR-1 lists what you sold. This is the one you pay from: output tax meets input credit,
          and whatever is left has to leave a bank account by the twentieth. Assembled from the
          ledger rather than the invoice table, because the return and the books are the two
          documents an assessment compares.
        </p>
        <p className="mt-2 text-xs">
          <Link href="/compliance/due" className="underline">
            What else is due this month
          </Link>
        </p>
      </div>

      <Gstr3bBoard
        rows={rows}
        defaultGstin={defaultGstin}
        canPrepare={prepare.allowed}
        canPost={post.allowed}
        onPrepare={prepareGstr3b}
        onFinalise={finaliseGstr3b}
        onFile={recordGstr3bFiled}
        onPost={postReturnJournal}
        onSupersede={supersedeReturn}
      />
    </main>
  );
}
