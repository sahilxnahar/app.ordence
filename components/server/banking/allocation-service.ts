import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE DATABASE HALF OF BANK LINE ALLOCATION
 * Version: v1.67.0-alpha (Batch 0110)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS SEPARATE FROM `lib/banking/allocation.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Same split as `lib/inventory/valuation.ts` against
 * `server/inventory/valuation-service.ts`: the arithmetic of "does this
 * allocation fit" is pure and must be testable with no database, and
 * everything that knows what a table is lives here.
 *
 * ⭐ `import "server-only"` AND EVERY FUNCTION TAKES A `tx`. A function
 * taking a transaction cannot be a browser-reachable endpoint, and the
 * work must share the caller's transaction: reading the sum already
 * allocated and inserting the row that changes it have to be one
 * transaction, or two operators allocating the last ₹4,000 of a line at
 * the same moment both succeed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE TRIGGER IS THE OTHER HALF, NOT A DUPLICATE
 * ══════════════════════════════════════════════════════════════════════
 * `ordence_guard_summed_bank_allocation` in 0110 enforces the same two
 * sums in the database. This file exists to produce a SENTENCE a person
 * can act on — "there are 400000 paise left on this line" — and the
 * trigger exists to make the rule true for the import, the support fix
 * and the API route that have not been written yet. Same doctrine as
 * `lineLockState` against `ordence_guard_reconciled_bank_line`.
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import type { withTenant } from "@/db";
import { bankLineMatches, bankStatementLines } from "@/db/schema/banking";
import { customerReceipts } from "@/db/schema/sales-invoices";
import { vendorPayments } from "@/db/schema/procurement";
import {
  allocationRefusal,
  isFullyAllocated,
  journalAllocationRefusal,
  remainingOf,
  residueOf,
  type AllocationRow,
  type AllocationTarget,
} from "@/lib/banking/allocation";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/* ------------------------------------------------------------------ */
/* READING WHAT IS ALREADY ALLOCATED                                   */
/* ------------------------------------------------------------------ */

function toAllocationRow(r: Record<string, unknown>): AllocationRow {
  return {
    id: r.id as string,
    statementLineId: r.statementLineId as string,
    matchedKind: r.matchedKind as string,
    matchedId: r.matchedId as string,
    allocatedMinor: BigInt(r.allocatedMinor as string | bigint),
  };
}

export async function allocationsForLines(
  tx: Tx,
  tenantId: string,
  statementLineIds: readonly string[],
): Promise<readonly AllocationRow[]> {
  if (statementLineIds.length === 0) return [];
  const rows = await tx
    .select({
      id: bankLineMatches.id,
      statementLineId: bankLineMatches.statementLineId,
      matchedKind: bankLineMatches.matchedKind,
      matchedId: bankLineMatches.matchedId,
      allocatedMinor: bankLineMatches.allocatedMinor,
    })
    .from(bankLineMatches)
    .where(
      and(
        eq(bankLineMatches.tenantId, tenantId),
        inArray(bankLineMatches.statementLineId, [...statementLineIds]),
      ),
    );
  return rows.map((r: Record<string, unknown>) => toAllocationRow(r));
}

/**
 * ⚠️ EVERY ROW POINTING AT ONE DOCUMENT, WHICHEVER LINE IT IS ON.
 *
 * 🔴 THIS IS THE QUERY THE OLD `bank_line_matches_one_per_document`
 *    INDEX MADE UNNECESSARY AND THE NEW MODEL MAKES ESSENTIAL. Without
 *    it a ₹10,000 receipt could be allocated in full to a January line
 *    and in full again to a February one, and each line on its own would
 *    balance.
 */
export async function allocationsForDocuments(
  tx: Tx,
  tenantId: string,
  documents: ReadonlyArray<{ kind: string; id: string }>,
): Promise<readonly AllocationRow[]> {
  if (documents.length === 0) return [];
  const rows = await tx
    .select({
      id: bankLineMatches.id,
      statementLineId: bankLineMatches.statementLineId,
      matchedKind: bankLineMatches.matchedKind,
      matchedId: bankLineMatches.matchedId,
      allocatedMinor: bankLineMatches.allocatedMinor,
    })
    .from(bankLineMatches)
    .where(
      and(
        eq(bankLineMatches.tenantId, tenantId),
        inArray(bankLineMatches.matchedId, documents.map((d) => d.id)),
      ),
    );

  /**
   * ⚠️ THE KIND IS FILTERED IN MEMORY RATHER THAN IN THE WHERE CLAUSE.
   * `matched_id` is a polymorphic uuid, so a (kind, id) pair is the real
   * key; a SQL `IN` over ids alone can return a row of a different kind
   * that happens to share a uuid. That will not happen with
   * `gen_random_uuid()`, and relying on it not happening is how a
   * polymorphic reference eventually bites.
   *
   * ⚠️ THE SEPARATOR IS `|` AND NOT THE LITERAL NUL THAT
   * `server/payroll/attendance-bridge.ts` and `lib/gstr2b/matching.ts`
   * use for the same job. Both are unambiguous here — a uuid is hex and
   * a dash, and `matched_kind` is one of three CHECK-constrained words,
   * so neither can contain either character. The difference is that a
   * NUL makes `grep` call the whole file binary and print "binary file
   * matches" instead of the line, which is how a reachability audit of
   * this batch came to report a function as uncalled when it was called
   * twelve lines further down. The gates read files through Node and are
   * unaffected; people are not.
   */
  const wanted = new Set(documents.map((d) => `${d.kind}|${d.id}`));
  return rows
    .map((r: Record<string, unknown>) => toAllocationRow(r))
    .filter((r) => wanted.has(`${r.matchedKind}|${r.matchedId}`));
}

/* ------------------------------------------------------------------ */
/* WHAT A DOCUMENT IS WORTH                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE SIGNED TOTAL OF A LEDGER DOCUMENT, or null where the document
 * cannot be found.
 *
 * 🔴 THE SIGN CONVENTION IS COPIED FROM `loadCandidates` AND MUST STAY
 *    IDENTICAL: a customer receipt is positive, a vendor payment is
 *    NEGATED. That single minus sign is the easiest thing in this module
 *    to get wrong, and getting it wrong here would refuse every vendor
 *    payment allocation while every one of them looked correct.
 *
 * ⚠️ A `journal_entry` HAS NO ENTRY HERE ON PURPOSE. The only journals
 *    matched to bank lines are the ones `postBankLineAdjustment` writes
 *    FROM a line, for that line's whole amount. `journalAllocationRefusal`
 *    covers them, and looking up a transaction total would invite
 *    somebody to match an arbitrary journal in part.
 */
export async function documentTotalMinor(
  tx: Tx,
  tenantId: string,
  kind: string,
  documentId: string,
): Promise<bigint | null> {
  if (kind === "customer_receipt") {
    const [row] = await tx
      .select({ amountMinor: customerReceipts.amountMinor })
      .from(customerReceipts)
      .where(
        and(
          eq(customerReceipts.tenantId, tenantId),
          eq(customerReceipts.id, documentId),
        ),
      )
      .limit(1);
    if (!row) return null;
    // ⭐ POSITIVE. Money in.
    return BigInt(row.amountMinor as string | bigint);
  }

  if (kind === "vendor_payment") {
    const [row] = await tx
      .select({ netMinor: vendorPayments.netMinor })
      .from(vendorPayments)
      .where(
        and(eq(vendorPayments.tenantId, tenantId), eq(vendorPayments.id, documentId)),
      )
      .limit(1);
    if (!row) return null;
    // 🔴 NEGATED. Money out. Same as loadCandidates.
    return -BigInt(row.netMinor as string | bigint);
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 🔴🔴 THE CHECK, RUN BEFORE EVERY WRITE                              */
/* ------------------------------------------------------------------ */

export interface AllocationCheck {
  /** Null when the allocation fits. A sentence for the operator otherwise. */
  readonly refusal: string | null;
  /** What was left on the line before this allocation, signed. */
  readonly lineRemainingMinor: bigint;
  /** What is left after it. Zero means the line is now fully explained. */
  readonly lineResidueAfterMinor: bigint;
  /**
   * ⭐ THE SAME FACT AS `lineResidueAfterMinor === 0n`, ASKED ONCE.
   *
   * 🔴 IT IS A FIELD RATHER THAN A COMPARISON EACH CALLER MAKES FOR
   *    ITSELF, for the reason `isLockedByReconciliation` exists: four
   *    inline comparisons is four chances for one of them to be `<=`
   *    where the others are `<`, and the wrong one is the one nobody
   *    tests. `confirmMatch` reads THIS to decide whether to tell the
   *    operator the line is finished.
   */
  readonly fullyExplainedAfter: boolean;
}

/**
 * ⭐⭐⭐ BOTH SUMS, PLUS THE JOURNAL RULE, IN ONE PLACE.
 *
 * ⚠️ `excludeMatchId` IS HOW AN EDIT WORKS. Re-checking a row against a
 * total that still includes its own stored allocation counts it twice
 * and refuses the one change somebody makes after getting it wrong —
 * shrinking it.
 *
 * 🔴 THE LINE CHECK RUNS EVEN WHEN THE DOCUMENT CANNOT BE FOUND. A
 *    document that has been deleted leaves the line side still worth
 *    protecting, and returning "no opinion" because half the lookup
 *    failed is how a check comes to permit everything.
 */
export async function checkAllocation(
  tx: Tx,
  args: {
    tenantId: string;
    statementLineId: string;
    matchedKind: string;
    matchedId: string;
    allocatedMinor: bigint;
    excludeMatchId?: string;
  },
): Promise<AllocationCheck> {
  const [line] = await tx
    .select({
      id: bankStatementLines.id,
      amountMinor: bankStatementLines.amountMinor,
      valueDate: bankStatementLines.valueDate,
    })
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.tenantId, args.tenantId),
        eq(bankStatementLines.id, args.statementLineId),
      ),
    )
    .limit(1);

  if (!line) {
    return {
      refusal: "No such statement line.",
      lineRemainingMinor: 0n,
      lineResidueAfterMinor: 0n,
      fullyExplainedAfter: false,
    };
  }

  const lineAmount = BigInt(line.amountMinor as string | bigint);

  const existingOnLineRows = await tx
    .select({
      id: bankLineMatches.id,
      statementLineId: bankLineMatches.statementLineId,
      matchedKind: bankLineMatches.matchedKind,
      matchedId: bankLineMatches.matchedId,
      allocatedMinor: bankLineMatches.allocatedMinor,
    })
    .from(bankLineMatches)
    .where(
      args.excludeMatchId === undefined
        ? and(
            eq(bankLineMatches.tenantId, args.tenantId),
            eq(bankLineMatches.statementLineId, args.statementLineId),
          )
        : and(
            eq(bankLineMatches.tenantId, args.tenantId),
            eq(bankLineMatches.statementLineId, args.statementLineId),
            ne(bankLineMatches.id, args.excludeMatchId),
          ),
    );

  const existingOnLine = existingOnLineRows.map((r: Record<string, unknown>) =>
    toAllocationRow(r),
  );

  const lineTarget: AllocationTarget = {
    id: args.statementLineId,
    amountMinor: lineAmount,
    label: `This bank line dated ${String(line.valueDate)}`,
  };

  const lineRemainingMinor = remainingOf(lineTarget, existingOnLine);

  /**
   * ⭐ THE JOURNAL RULE FIRST. It is the most specific refusal, and a
   * charge written up from a line that then fails a sum check would
   * produce the wrong sentence entirely.
   */
  const journalProblem = journalAllocationRefusal({
    matchedKind: args.matchedKind,
    lineAmountMinor: lineAmount,
    proposedMinor: args.allocatedMinor,
    existingRowCount: existingOnLine.length,
  });
  if (journalProblem !== null) {
    return {
      refusal: journalProblem,
      lineRemainingMinor,
      lineResidueAfterMinor: lineRemainingMinor,
      fullyExplainedAfter: false,
    };
  }

  const lineProblem = allocationRefusal({
    side: "line",
    target: lineTarget,
    existing: existingOnLine,
    proposedMinor: args.allocatedMinor,
  });
  if (lineProblem !== null) {
    return {
      refusal: lineProblem,
      lineRemainingMinor,
      lineResidueAfterMinor: lineRemainingMinor,
      fullyExplainedAfter: false,
    };
  }

  const documentTotal = await documentTotalMinor(
    tx,
    args.tenantId,
    args.matchedKind,
    args.matchedId,
  );

  if (documentTotal !== null) {
    const onDocument = (
      await allocationsForDocuments(tx, args.tenantId, [
        { kind: args.matchedKind, id: args.matchedId },
      ])
    ).filter((r) => r.id !== (args.excludeMatchId ?? null));

    const documentProblem = allocationRefusal({
      side: "document",
      target: {
        id: args.matchedId,
        amountMinor: documentTotal,
        label: `That ${args.matchedKind.replace(/_/g, " ")}`,
      },
      existing: onDocument,
      proposedMinor: args.allocatedMinor,
    });
    if (documentProblem !== null) {
      return {
        refusal: documentProblem,
        lineRemainingMinor,
        lineResidueAfterMinor: lineRemainingMinor,
        fullyExplainedAfter: false,
      };
    }
  }

  const afterThisOne: AllocationRow[] = [
    ...existingOnLine,
    {
      id: null,
      statementLineId: args.statementLineId,
      matchedKind: args.matchedKind,
      matchedId: args.matchedId,
      allocatedMinor: args.allocatedMinor,
    },
  ];

  return {
    refusal: null,
    lineRemainingMinor,
    lineResidueAfterMinor: residueOf(lineTarget, afterThisOne),
    fullyExplainedAfter: isFullyAllocated(lineTarget, afterThisOne),
  };
}
