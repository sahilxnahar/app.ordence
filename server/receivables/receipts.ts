import "server-only";

/**
 * Ordence — ⭐⭐ Receipts and Their Allocation
 * Version: v0.38.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ONE THING THIS FILE MUST NEVER GET WRONG
 * ══════════════════════════════════════════════════════════════════════
 * A buyer pays ₹5,00,000 against three outstanding demands. The split has
 * to be EXACT — allocations plus credit equal the receipt, to the paisa —
 * and EXPLAINABLE, so the buyer can be shown where their money went.
 *
 * The arithmetic is `lib/receivables/allocation.ts`, which asserts its own
 * invariant and throws rather than returning a split that does not
 * reconcile. This file writes what it returns, in ONE TRANSACTION, and
 * the deferred triggers in SQL 0027 §5 refuse the commit if the stored
 * totals and the allocation rows disagree.
 *
 * ⚠️ THE THREE WRITES ARE INSEPARABLE. The receipt, its allocation rows
 * and the `allocated_minor` on each demand are one fact recorded three
 * times because three different screens read them. Any two of the three
 * without the third produces a buyer who is told they have paid when they
 * have not, or chased when they have.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  demandNotices,
  receiptAllocations,
  receipts,
  type Receipt,
} from "@/db/schema/receivables";
import { financialYearOf, toCivilDay } from "@/lib/gst/constants";
import {
  allocateReceipt,
  type AllocationResult,
} from "@/lib/receivables/allocation";
import { toBigIntAmount } from "@/lib/billing/money";
import type { RecordReceiptInput } from "@/lib/validators/receivables";
import {
  findBookingContext,
  nextReceiptNumber,
  openDemandsForBooking,
  resolvePolicies,
} from "./registry";

export type ReceiptFailure = { ok: false; error: string };

export type RecordReceiptOutcome =
  | { ok: true; receipt: Receipt; allocation: AllocationResult }
  | ReceiptFailure;

const REFERENCE_RETRY_LIMIT = 5;

/* ------------------------------------------------------------------ */
/* RECORD                                                              */
/* ------------------------------------------------------------------ */

export async function recordReceipt(args: {
  tenantId: string;
  userId: string | null;
  input: RecordReceiptInput;
}): Promise<RecordReceiptOutcome> {
  const { tenantId, userId, input } = args;

  const booking = await findBookingContext(tenantId, input.bookingId);
  if (!booking) {
    return { ok: false, error: "That booking does not exist in this workspace." };
  }

  const receivedOn = toCivilDay(input.receivedOn);
  const policies = await resolvePolicies(tenantId, booking.projectId);
  const { demands } = await openDemandsForBooking(tenantId, input.bookingId, receivedOn);

  const appropriationOrder = input.appropriationOrder ?? policies.appropriationOrder;

  // ⚠️ `credit` WHEN THERE IS NOTHING OPEN, AND IT IS NOT AN ERROR. A
  // buyer who transfers ahead of the next slab is doing exactly what they
  // were asked to; refusing the receipt would leave the money unrecorded
  // and the developer holding cash it cannot explain.
  const strategy =
    demands.length === 0 && input.strategy !== "specified" ? "credit" : input.strategy;

  const allocation = allocateReceipt({
    // ⚠️ Provisional — the real number is allocated inside the
    // transaction below. It appears in the explanations, so it is
    // re-rendered there rather than patched afterwards.
    receiptNumber: "…",
    amountMinor: input.amountMinor,
    tdsCreditMinor: input.tdsCreditMinor ?? 0n,
    receivedOn,
    demands,
    strategy,
    appropriationOrder,
    instructions: input.instructions,
  });

  const financialYear = financialYearOf(receivedOn);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < REFERENCE_RETRY_LIMIT; attempt += 1) {
    try {
      const written = await withTenant(tenantId, async (tx) => {
        const receiptNumber = await nextReceiptNumber(tx, financialYear, attempt);

        // ⭐ Re-run with the real number so every `explanation` names the
        // receipt the buyer will quote. Deterministic — same inputs, same
        // split — so this cannot change a single amount.
        const final = allocateReceipt({
          receiptNumber,
          amountMinor: input.amountMinor,
          tdsCreditMinor: input.tdsCreditMinor ?? 0n,
          receivedOn,
          demands,
          strategy,
          appropriationOrder,
          instructions: input.instructions,
        });

        const inserted = await tx
          .insert(receipts)
          .values({
            tenantId,
            receiptNumber,
            bookingId: booking.bookingId,
            projectId: booking.projectId,
            leadId: booking.leadId,
            receivedOn,
            amountMinor: input.amountMinor,
            tdsCreditMinor: input.tdsCreditMinor ?? 0n,
            allocatedMinor: final.totalAllocatedMinor,
            method: input.method,
            status: "cleared",
            allocationStrategy: strategy,
            appropriationOrder,
            instrumentRef: input.instrumentRef ?? null,
            bankRef: input.bankRef ?? null,
            clearedOn: input.clearedOn ?? null,
            notes: input.notes ?? null,
            createdBy: userId,
          })
          .returning();

        const receipt = inserted[0];
        if (!receipt) throw new Error("The receipt could not be written.");

        for (const line of final.lines) {
          await tx.insert(receiptAllocations).values({
            tenantId,
            receiptId: receipt.id,
            demandId: line.demandId,
            sequence: line.sequence,
            principalMinor: line.principalMinor,
            taxMinor: line.taxMinor,
            interestMinor: line.interestMinor,
            amountMinor: line.amountMinor,
            basis: line.basis,
            appropriationOrder: line.appropriationOrder,
            explanation: line.explanation,
            allocatedBy: userId,
          });

          // ⭐ The demand's own totals, moved in the SAME transaction.
          // SQL 0027 §5 checks both sides at COMMIT, so a missing update
          // here is a refused transaction rather than a silent drift.
          await tx
            .update(demandNotices)
            .set({
              allocatedMinor: sql`${demandNotices.allocatedMinor} + ${line.principalMinor + line.taxMinor}`,
              interestPaidMinor: sql`${demandNotices.interestPaidMinor} + ${line.interestMinor}`,
              status: sql`CASE
                WHEN ${demandNotices.allocatedMinor} + ${line.principalMinor + line.taxMinor}
                     >= ${demandNotices.totalMinor} THEN 'paid'::demand_status
                ELSE 'part_paid'::demand_status
              END`,
            })
            .where(
              and(
                eq(demandNotices.tenantId, tenantId),
                eq(demandNotices.id, line.demandId),
              ),
            );
        }

        return { receipt, final };
      });

      return { ok: true, receipt: written.receipt, allocation: written.final };
    } catch (err) {
      if (!isNumberCollision(err)) throw err;
      lastError = err;
    }
  }

  throw lastError ??
    new Error(
      `Could not allocate a receipt number after ${REFERENCE_RETRY_LIMIT} attempts.`,
    );
}

function isNumberCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code !== "23505") return false;
  const name = "receipts_number_tenant_unique";
  if (candidate.constraint === name) return true;
  return typeof candidate.message === "string" && candidate.message.includes(name);
}

/* ------------------------------------------------------------------ */
/* BOUNCE                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A CHEQUE THAT CAME BACK WAS NEVER MONEY.
 *
 * ⚠️ AND THE INTEREST CLOCK NEVER STOPPED. The demands this receipt was
 * applied to were outstanding the whole time it was sitting with us, so
 * releasing the allocations puts them back exactly where they were — with
 * interest still running from their ORIGINAL due dates. Recomputing from
 * the bounce date would forgive the buyer the period their unpaid cheque
 * bought them, which is the wrong way round.
 *
 * ⚠️ THE ALLOCATION ROWS ARE DELETED AND THE RECEIPT IS NOT. That is the
 * one DELETE grant in this phase (SQL 0027 §9), and it exists precisely
 * for this: the receipt row stays as the record that an instrument was
 * presented and returned — which the buyer can be shown — while the money
 * it never was stops being applied to anything.
 */
export async function bounceReceipt(args: {
  tenantId: string;
  receiptId: string;
  bouncedOn: string;
  reason: string;
}): Promise<{ ok: true; receipt: Receipt; releasedMinor: bigint } | ReceiptFailure> {
  const { tenantId, receiptId, reason } = args;
  const bouncedOn = toCivilDay(args.bouncedOn);

  const outcome = await withTenant(tenantId, async (tx) => {
    const found = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, receiptId)))
      .limit(1);

    const receipt = found[0];
    if (!receipt) return null;

    const lines = await tx
      .select()
      .from(receiptAllocations)
      .where(
        and(
          eq(receiptAllocations.tenantId, tenantId),
          eq(receiptAllocations.receiptId, receiptId),
        ),
      );

    let released = 0n;

    for (const line of lines) {
      const principalAndTax =
        toBigIntAmount(line.principalMinor) + toBigIntAmount(line.taxMinor);
      released += toBigIntAmount(line.amountMinor);

      await tx
        .update(demandNotices)
        .set({
          allocatedMinor: sql`${demandNotices.allocatedMinor} - ${principalAndTax}`,
          interestPaidMinor: sql`${demandNotices.interestPaidMinor} - ${toBigIntAmount(line.interestMinor)}`,
          status: sql`CASE
            WHEN ${demandNotices.allocatedMinor} - ${principalAndTax} <= 0
              THEN 'issued'::demand_status
            ELSE 'part_paid'::demand_status
          END`,
        })
        .where(
          and(eq(demandNotices.tenantId, tenantId), eq(demandNotices.id, line.demandId)),
        );
    }

    if (lines.length > 0) {
      await tx
        .delete(receiptAllocations)
        .where(
          and(
            eq(receiptAllocations.tenantId, tenantId),
            eq(receiptAllocations.receiptId, receiptId),
          ),
        );
    }

    const updated = await tx
      .update(receipts)
      .set({
        status: "bounced",
        bouncedOn,
        bounceReason: reason,
        allocatedMinor: 0n,
      })
      .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, receiptId)))
      .returning();

    return { receipt: updated[0] ?? receipt, released };
  });

  if (!outcome) return { ok: false, error: "That receipt does not exist." };

  return { ok: true, receipt: outcome.receipt, releasedMinor: outcome.released };
}

/* ------------------------------------------------------------------ */
/* RE-ALLOCATION                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ RE-APPLY A RECEIPT, USUALLY BECAUSE THE BUYER SAID WHICH DEMAND THEY
 * MEANT.
 *
 * ⚠️ SECTION 59 OF THE CONTRACT ACT MAKES THIS A RIGHT AND NOT A FAVOUR.
 * A debtor's express appropriation binds the creditor, so a buyer who
 * says afterwards "that ₹5,00,000 was for the 7th slab" is exercising
 * something, and a system that could not record it would be overriding
 * them.
 *
 * ⚠️ IT IS ON THE DANGEROUS PERMISSION LIST for the mirror-image reason:
 * the same capability, used the other way, moves money a buyer already
 * has a statement for.
 */
export async function reallocateReceipt(args: {
  tenantId: string;
  userId: string | null;
  receiptId: string;
  strategy: "oldest_first" | "specified" | "credit";
  appropriationOrder?: "interest_first" | "principal_first";
  instructions?: readonly { demandId: string; amountMinor: bigint }[];
}): Promise<
  { ok: true; receipt: Receipt; allocation: AllocationResult } | ReceiptFailure
> {
  const { tenantId, userId, receiptId } = args;

  const receipt = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, receiptId)))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!receipt) return { ok: false, error: "That receipt does not exist." };
  if (receipt.status === "bounced" || receipt.status === "cancelled") {
    return {
      ok: false,
      error:
        "A bounced or cancelled receipt cannot be applied to anything — it was never " +
        "money. Record a new receipt when the payment is actually made.",
    };
  }

  const booking = await findBookingContext(tenantId, receipt.bookingId);
  if (!booking) return { ok: false, error: "That booking no longer exists." };

  // ⚠️ THE ORDER COMES FROM THE RECEIPT, NOT FROM TODAY'S POLICY. The
  // buyer was already shown how their payment was appropriated; a
  // re-allocation that also quietly switched interest-first to
  // principal-first because the policy changed in between would move
  // money for a second reason nobody asked for.
  const appropriationOrder = args.appropriationOrder ?? receipt.appropriationOrder;

  const written = await withTenant(tenantId, async (tx) => {
    /* --- Release what is applied today. -------------------------- */
    const lines = await tx
      .select()
      .from(receiptAllocations)
      .where(
        and(
          eq(receiptAllocations.tenantId, tenantId),
          eq(receiptAllocations.receiptId, receiptId),
        ),
      );

    for (const line of lines) {
      const principalAndTax =
        toBigIntAmount(line.principalMinor) + toBigIntAmount(line.taxMinor);
      await tx
        .update(demandNotices)
        .set({
          allocatedMinor: sql`${demandNotices.allocatedMinor} - ${principalAndTax}`,
          interestPaidMinor: sql`${demandNotices.interestPaidMinor} - ${toBigIntAmount(line.interestMinor)}`,
          status: sql`CASE
            WHEN ${demandNotices.allocatedMinor} - ${principalAndTax} <= 0
              THEN 'issued'::demand_status
            ELSE 'part_paid'::demand_status
          END`,
        })
        .where(
          and(eq(demandNotices.tenantId, tenantId), eq(demandNotices.id, line.demandId)),
        );
    }

    if (lines.length > 0) {
      await tx
        .delete(receiptAllocations)
        .where(
          and(
            eq(receiptAllocations.tenantId, tenantId),
            eq(receiptAllocations.receiptId, receiptId),
          ),
        );
      await tx
        .update(receipts)
        .set({ allocatedMinor: 0n })
        .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, receiptId)));
    }

    /* --- Work out the new split from what is open NOW. ----------- */
    //
    // ⚠️ READ AFTER THE RELEASE, INSIDE THE SAME TRANSACTION. Computing
    // the new split from the pre-release position would treat the money
    // being moved as though it were still applied, and the demand it came
    // off would look settled to the allocator.
    const openRows = await tx
      .select()
      .from(demandNotices)
      .where(
        and(
          eq(demandNotices.tenantId, tenantId),
          eq(demandNotices.bookingId, receipt.bookingId),
          inArray(demandNotices.status, ["issued", "part_paid"]),
        ),
      );

    const { demandPosition } = await import("@/lib/receivables/demand");
    const { demandFacts } = await import("./registry");

    const open = openRows
      .map((row) => {
        const position = demandPosition(demandFacts(row), receipt.receivedOn);
        return {
          demandId: row.id,
          noticeNumber: row.noticeNumber,
          dueDate: row.dueDate,
          outstandingPrincipalMinor: position.outstandingPrincipalMinor,
          outstandingTaxMinor: position.outstandingTaxMinor,
          outstandingInterestMinor: position.outstandingInterestMinor,
        };
      })
      .filter(
        (d) =>
          d.outstandingPrincipalMinor +
            d.outstandingTaxMinor +
            d.outstandingInterestMinor >
          0n,
      );

    const final = allocateReceipt({
      receiptNumber: receipt.receiptNumber,
      amountMinor: toBigIntAmount(receipt.amountMinor),
      tdsCreditMinor: toBigIntAmount(receipt.tdsCreditMinor),
      receivedOn: receipt.receivedOn,
      demands: open,
      strategy: args.strategy,
      appropriationOrder,
      instructions: args.instructions,
    });

    for (const line of final.lines) {
      await tx.insert(receiptAllocations).values({
        tenantId,
        receiptId,
        demandId: line.demandId,
        sequence: line.sequence,
        principalMinor: line.principalMinor,
        taxMinor: line.taxMinor,
        interestMinor: line.interestMinor,
        amountMinor: line.amountMinor,
        basis: line.basis,
        appropriationOrder: line.appropriationOrder,
        explanation: line.explanation,
        allocatedBy: userId,
      });

      await tx
        .update(demandNotices)
        .set({
          allocatedMinor: sql`${demandNotices.allocatedMinor} + ${line.principalMinor + line.taxMinor}`,
          interestPaidMinor: sql`${demandNotices.interestPaidMinor} + ${line.interestMinor}`,
          status: sql`CASE
            WHEN ${demandNotices.allocatedMinor} + ${line.principalMinor + line.taxMinor}
                 >= ${demandNotices.totalMinor} THEN 'paid'::demand_status
            ELSE 'part_paid'::demand_status
          END`,
        })
        .where(
          and(eq(demandNotices.tenantId, tenantId), eq(demandNotices.id, line.demandId)),
        );
    }

    const updated = await tx
      .update(receipts)
      .set({
        allocatedMinor: final.totalAllocatedMinor,
        allocationStrategy: args.strategy,
        appropriationOrder,
      })
      .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, receiptId)))
      .returning();

    return { receipt: updated[0] ?? receipt, final };
  });

  return { ok: true, receipt: written.receipt, allocation: written.final };
}
