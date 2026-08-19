import "server-only";

/**
 * Ordence — ⭐ Assembling a Statement of Account
 * Version: v0.38.0-alpha
 *
 * Loads a buyer's demands, receipts and allocations and hands them to
 * `buildStatement` in `lib/receivables/statement.ts`, which does the
 * arithmetic and refuses to produce a document that does not foot.
 *
 * ⚠️ THE INTEREST IS COMPUTED HERE, PER DEMAND, FROM THE TERMS FROZEN ON
 * THAT DEMAND — never from the project's current policy. A statement
 * prepared in September for a demand raised in January must show the
 * January terms; recomputing from today's settings would restate a
 * document that was served, and the buyer's copy is the one that counts.
 */

import { withTenant } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { receiptAllocations, receipts } from "@/db/schema/receivables";
import { toBigIntAmount } from "@/lib/billing/money";
import { buildStatement, type Statement } from "@/lib/receivables/statement";
import { demandPosition } from "@/lib/receivables/demand";
import { demandFacts, findBookingContext, listDemandsForBooking } from "./registry";

export async function assembleStatement(args: {
  tenantId: string;
  bookingId: string;
  asOf: string;
}): Promise<Statement | null> {
  const { tenantId, bookingId, asOf } = args;

  const booking = await findBookingContext(tenantId, bookingId);
  if (!booking) return null;

  const demandRows = await listDemandsForBooking(tenantId, bookingId);

  const { receiptRows, allocationRows } = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.tenantId, tenantId), eq(receipts.bookingId, bookingId)))
      .orderBy(receipts.receivedOn);

    if (rows.length === 0) return { receiptRows: rows, allocationRows: [] };

    const allocations = await tx
      .select()
      .from(receiptAllocations)
      .where(
        and(
          eq(receiptAllocations.tenantId, tenantId),
          inArray(
            receiptAllocations.receiptId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(receiptAllocations.sequence);

    return { receiptRows: rows, allocationRows: allocations };
  });

  const noticeNumberById = new Map(demandRows.map((d) => [d.id, d.noticeNumber]));

  return buildStatement({
    asOf,
    buyerName: booking.buyerName,
    bookingReference: booking.reference,
    unitLabel: booking.unitLabel,
    projectName: booking.projectName,
    agreementValueMinor: booking.agreementValueMinor,

    demands: demandRows
      // ⚠️ A DRAFT IS NOT ON THE STATEMENT. It has not been served, so
      // showing it would tell a buyer they owe money nobody has asked
      // them for — and they would, reasonably, pay it and then dispute
      // the demand when it arrives properly.
      .filter((demand) => demand.status !== "draft")
      .map((demand) => {
        const position = demandPosition(demandFacts(demand), asOf);
        return {
          demandId: demand.id,
          noticeNumber: demand.noticeNumber,
          noticeDate: demand.noticeDate,
          dueDate: demand.dueDate,
          triggerLabel: demand.triggerLabel,
          status: demand.status,
          principalMinor: toBigIntAmount(demand.principalMinor),
          taxMinor: toBigIntAmount(demand.taxMinor),
          totalMinor: toBigIntAmount(demand.totalMinor),
          allocatedMinor: toBigIntAmount(demand.allocatedMinor),
          interestAccruedMinor: position.interest.interestMinor,
          interestPaidMinor: toBigIntAmount(demand.interestPaidMinor),
          interestBasisNote: demand.interestBasisNote,
        };
      }),

    receipts: receiptRows.map((receipt) => ({
      receiptId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      receivedOn: receipt.receivedOn,
      amountMinor: toBigIntAmount(receipt.amountMinor),
      tdsCreditMinor: toBigIntAmount(receipt.tdsCreditMinor),
      allocatedMinor: toBigIntAmount(receipt.allocatedMinor),
      method: receipt.method,
      status: receipt.status,
      instrumentRef: receipt.instrumentRef,
      allocations: allocationRows
        .filter((a) => a.receiptId === receipt.id)
        .map((a) => ({
          demandId: a.demandId,
          noticeNumber: noticeNumberById.get(a.demandId) ?? a.demandId,
          amountMinor: toBigIntAmount(a.amountMinor),
          principalMinor: toBigIntAmount(a.principalMinor),
          taxMinor: toBigIntAmount(a.taxMinor),
          interestMinor: toBigIntAmount(a.interestMinor),
          // ⭐ THE SENTENCE WRITTEN WHEN THE MONEY WAS APPLIED, not one
          // generated now. An explanation regenerated at read time
          // changes when the code does, and the buyer was shown the old
          // one.
          explanation: a.explanation,
        })),
    })),
  });
}
