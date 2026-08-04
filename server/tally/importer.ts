import "server-only";

/**
 * Ordence — ⭐ Reading Tally Back
 * Version: v0.37.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS PRODUCES A REPORT. IT NEVER WRITES TO OUR LEDGER.
 * ══════════════════════════════════════════════════════════════════════
 * Not with a flag, not for one voucher, not "just the ones that are
 * obviously ours". The reasons are in `lib/tally/reconcile.ts`; the
 * shortest one is that our ledger is append-only and balance-enforced at
 * the database, and their file is a snapshot of a book anybody with the
 * Tally password can edit retrospectively — including inside a period we
 * have closed.
 *
 * ⭐ AND THE TWO ARE NOT SUPPOSED TO AGREE. Depreciation, provisions,
 * prepayment reversals and audit adjustments are posted directly in Tally
 * on purpose, because that is where the statutory accounts are prepared.
 * Pulling them in would put entries in our books that no user made and no
 * document supports.
 *
 * ⚠️ AND THE FILE IS A CUSTOMER-SUPPLIED DOCUMENT, so the parser it goes
 * through is hand-written and never resolves a DOCTYPE, expands an
 * entity, or reads anything outside the string it was given. See
 * `lib/tally/parse.ts` for why a general XML library was the wrong
 * choice here.
 */

import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  tallyImportBatches,
  tallyReconciliationItems,
} from "@/db/schema/tally";
import { parseTallyExport } from "@/lib/tally/parse";
import { reconcileVouchers, summariseReconciliation } from "@/lib/tally/reconcile";
import { payloadHash } from "@/lib/tally/keys";
import { loadDeliveredVoucherFacts } from "./registry";

export type ImportOutcome = {
  importBatchId: string;
  companyName: string | null;
  theirVoucherCount: number;
  matched: number;
  differences: number;
  actionable: number;
  warnings: number;
};

export async function importAndReconcile(args: {
  tenantId: string;
  userId: string | null;
  connectionId: string | null;
  sourceLabel: string;
  periodStart: string;
  periodEnd: string;
  payload: string;
  notes: string | null;
}): Promise<ImportOutcome> {
  /* --- Parse. Recovers rather than refusing; see the parser. ---- */

  const parsed = parseTallyExport(args.payload);

  /* --- ⭐ Our side: DELIVERED vouchers only. -------------------- */

  const ours = await loadDeliveredVoucherFacts(
    args.tenantId,
    args.periodStart,
    args.periodEnd,
  );

  const result = reconcileVouchers(ours, parsed.vouchers);
  const summary = summariseReconciliation(result);

  /**
   * ⚠️ `unresolved_count` STARTS EQUAL TO THE ACTIONABLE COUNT, NOT TO
   * THE TOTAL. `missing_in_ours` findings are the accountant doing their
   * job — a year-end journal, a depreciation entry — and counting them as
   * outstanding work would make a healthy reconciliation look like a
   * hundred-item backlog, which is how a report stops being opened.
   */
  const hash = payloadHash(args.payload);

  const importBatchId = await withTenant(args.tenantId, async (tx) => {
    const [batch] = await tx
      .insert(tallyImportBatches)
      .values({
        tenantId: args.tenantId,
        connectionId: args.connectionId,
        sourceLabel: args.sourceLabel,
        companyName: parsed.companyName,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        status: "reconciled",
        voucherCount: parsed.vouchers.length,
        totalDebitMinor: result.theirTotalDebitMinor,
        totalCreditMinor: result.theirTotalCreditMinor,
        payloadHash: hash,
        payloadBytes: Buffer.byteLength(args.payload, "utf8"),
        rawPayload: args.payload,
        parseWarnings: parsed.warnings,
        differenceCount: result.differences.length,
        unresolvedCount: summary.actionableCount,
        reconciledAt: new Date(),
        notes: args.notes,
        createdBy: args.userId,
      })
      .returning({ id: tallyImportBatches.id });

    const id = batch?.id;
    if (!id) throw new Error("The import could not be recorded.");

    if (result.differences.length > 0) {
      await tx.insert(tallyReconciliationItems).values(
        result.differences.map((difference) => ({
          tenantId: args.tenantId,
          importBatchId: id,
          kind: difference.kind,
          /**
           * ⭐ `missing_in_ours` OPENS AS `explained`, NOT `open`.
           *
           * ⚠️ It is the NORMAL case, not an error, and defaulting it to
           * `open` puts eighty entries the accountant deliberately made
           * into a worklist beside the four that mean something is wrong.
           * A worklist in which most items are noise is a worklist nobody
           * finishes.
           */
          status:
            difference.kind === "missing_in_ours"
              ? ("explained" as const)
              : ("open" as const),
          remoteId: difference.remoteId,
          ourVoucherId: difference.ourVoucherId,
          ourVoucherNumber: difference.ourVoucherNumber,
          ourVoucherDate: difference.ourVoucherDate,
          ourVoucherType: difference.ourVoucherType,
          ourAmountMinor: difference.ourAmountMinor,
          ourPartyLedgerName: difference.ourPartyLedgerName,
          theirVoucherNumber: difference.theirVoucherNumber,
          theirVoucherDate: difference.theirVoucherDate,
          theirVoucherType: difference.theirVoucherType,
          theirAmountMinor: difference.theirAmountMinor,
          theirPartyLedgerName: difference.theirPartyLedgerName,
          explanation: difference.explanation,
        })),
      );
    }

    return id;
  });

  return {
    importBatchId,
    companyName: parsed.companyName,
    theirVoucherCount: parsed.vouchers.length,
    matched: result.matchedCount,
    differences: result.differences.length,
    actionable: summary.actionableCount,
    warnings: parsed.warnings.length,
  };
}

/**
 * ⭐ Recount the outstanding findings after somebody resolves one.
 *
 * ⚠️ RECOUNTED FROM THE ITEMS, NOT DECREMENTED. A decrement drifts the
 * first time two people close a finding in the same second, and a stored
 * count that drifts is worse than no count — the list page would say
 * "3 open" beside a list showing none.
 */
export async function recountUnresolved(
  tenantId: string,
  importBatchId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ status: tallyReconciliationItems.status })
      .from(tallyReconciliationItems)
      .where(
        and(
          eq(tallyReconciliationItems.tenantId, tenantId),
          eq(tallyReconciliationItems.importBatchId, importBatchId),
        ),
      );

    await tx
      .update(tallyImportBatches)
      .set({
        differenceCount: rows.length,
        unresolvedCount: rows.filter((row) => row.status === "open").length,
      })
      .where(
        and(
          eq(tallyImportBatches.tenantId, tenantId),
          eq(tallyImportBatches.id, importBatchId),
        ),
      );
  });
}
