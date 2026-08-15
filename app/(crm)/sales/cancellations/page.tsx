/**
 * Ordence — ⭐⭐⭐ CANCELLATIONS
 * Version: v1.25.0-alpha · Batch 17
 *
 * ⚠️ The guards are on the actions, not on this route.
 *
 * 🔴 THE GAP THIS CLOSES IS ELEVEN SESSIONS OLD. `cancelBooking()` has
 * recorded a forfeit and a refund since Phase 22 and posted neither, so
 * a cancelled booking left its advance, its unpaid demands and its
 * output tax sitting in the ledger forever — against a buyer who had
 * gone.
 */

import Link from "next/link";
import {
  listCancellations,
  previewCancellationPosting,
  postBookingCancellation,
  recordBuyerRefund,
} from "@/server/actions/sales-bookings";
import {
  CancellationBoard,
  type CancellationView,
} from "@/components/sales/cancellation-board";
import { checkPermission } from "@/server/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cancellations · Ordence" };

export default async function CancellationsPage() {
  const [list, post] = await Promise.all([
    listCancellations(),
    checkPermission("transactions:post"),
  ]);

  if (!list.ok) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Cancellations</h1>
        <p className="text-sm text-destructive">{list.error}</p>
      </main>
    );
  }

  const rows: CancellationView[] = list.data.rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    cancelledOn: r.cancelledOn,
    cancelReason: r.cancelReason,
    forfeitMinor: r.forfeitMinor,
    refundMinor: r.refundMinor,
    agreementValueMinor: r.agreementValueMinor,
    posted: r.posted,
    refundPaid: r.refundPaid,
    refundPaidOn: r.refundPaidOn,
    creditNoteNumber: r.creditNoteNumber,
    warning: r.warning,
  }));

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Cancellations</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          A cancellation has to return every balance on the booking to zero in one entry: the
          advance the buyer built up, the demands they never paid, and the output tax charged on
          a sale that did not happen. What is kept becomes income, what goes back becomes a
          liability until the transfer clears.
        </p>
        <p className="mt-2 text-xs">
          <Link href="/sales/bookings" className="underline">
            Bookings
          </Link>
        </p>
      </div>

      <CancellationBoard
        rows={rows}
        unpostedCount={list.data.unpostedCount}
        unpaidRefundMinor={list.data.unpaidRefundMinor}
        canPost={post.allowed}
        onPreview={previewCancellationPosting}
        onPost={postBookingCancellation}
        onRefund={recordBuyerRefund}
      />
    </main>
  );
}
