import "server-only";

/**
 * Ordence — Tally Registry Reads
 * Version: v0.37.0-alpha
 *
 * The thin database layer under `server/actions/tally.ts`. Every query
 * goes through `withTenant`, so row-level security is applied by the
 * database and not by a `WHERE tenant_id = …` somebody can forget.
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. The XML, the escaping, the
 * deterministic keys, the balance assertion, the parser and the
 * reconciliation diff all live in `lib/tally/`, which has no database
 * import and is therefore testable without one. This file loads rows and
 * hands them over.
 */

import { and, asc, desc, eq, gte, lte, inArray } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  tallyConnections,
  tallyLedgerMappings,
  tallyCostCentreMappings,
  tallyExportBatches,
  tallyVouchers,
  tallyImportBatches,
  tallyReconciliationItems,
  type TallyConnection,
  type TallyLedgerMapping as TallyLedgerMappingRow,
  type TallyCostCentreMapping,
  type TallyExportBatch,
  type TallyVoucher,
  type TallyImportBatch,
} from "@/db/schema/tally";
import { toBigIntAmount } from "@/lib/billing/money";
import type { LedgerMapping } from "@/lib/tally/ledgers";
import type { OurVoucherFacts } from "@/lib/tally/reconcile";

/* ------------------------------------------------------------------ */
/* CONNECTIONS                                                         */
/* ------------------------------------------------------------------ */

export async function listConnections(
  tenantId: string,
  options?: { includeInactive?: boolean },
): Promise<TallyConnection[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tallyConnections)
      .where(
        options?.includeInactive
          ? eq(tallyConnections.tenantId, tenantId)
          : and(
              eq(tallyConnections.tenantId, tenantId),
              eq(tallyConnections.isActive, true),
            ),
      )
      .orderBy(asc(tallyConnections.name)),
  );
}

export async function findConnection(
  tenantId: string,
  connectionId: string,
): Promise<TallyConnection | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tallyConnections)
      .where(
        and(
          eq(tallyConnections.tenantId, tenantId),
          eq(tallyConnections.id, connectionId),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* ⭐ MAPPINGS                                                          */
/* ------------------------------------------------------------------ */

export async function listLedgerMappings(
  tenantId: string,
  options?: { includeInactive?: boolean },
): Promise<TallyLedgerMappingRow[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tallyLedgerMappings)
      .where(
        options?.includeInactive
          ? eq(tallyLedgerMappings.tenantId, tenantId)
          : and(
              eq(tallyLedgerMappings.tenantId, tenantId),
              eq(tallyLedgerMappings.isActive, true),
            ),
      )
      .orderBy(asc(tallyLedgerMappings.tallyLedgerName)),
  );
}

/**
 * ⚠️ THE ROW → THE PURE SHAPE, in one place.
 *
 * `lib/tally/ledgers.ts` must not know about Drizzle, so the translation
 * happens here. Doing it inline at each call site is how two call sites
 * end up disagreeing about whether a null GSTIN is `null` or `undefined`
 * — which is invisible until one of them writes `PARTYGSTIN` as the
 * string "undefined" into a customer's ledger master.
 */
export function toLedgerMapping(row: TallyLedgerMappingRow): LedgerMapping {
  return {
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    sourceKey: row.sourceKey,
    tallyLedgerName: row.tallyLedgerName,
    tallyParentGroup: row.tallyParentGroup,
    isParty: row.isParty,
    partyGstin: row.partyGstin,
    partyStateCode: row.partyStateCode,
    createMasterOnExport: row.createMasterOnExport,
  };
}

export async function listCostCentreMappings(
  tenantId: string,
  options?: { includeInactive?: boolean },
): Promise<TallyCostCentreMapping[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tallyCostCentreMappings)
      .where(
        options?.includeInactive
          ? eq(tallyCostCentreMappings.tenantId, tenantId)
          : and(
              eq(tallyCostCentreMappings.tenantId, tenantId),
              eq(tallyCostCentreMappings.isActive, true),
            ),
      )
      .orderBy(asc(tallyCostCentreMappings.tallyCostCentreName)),
  );
}

/* ------------------------------------------------------------------ */
/* EXPORT BATCHES                                                      */
/* ------------------------------------------------------------------ */

export async function listExportBatches(
  tenantId: string,
  options?: { limit?: number },
): Promise<TallyExportBatch[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tallyExportBatches)
      .where(eq(tallyExportBatches.tenantId, tenantId))
      .orderBy(desc(tallyExportBatches.createdAt))
      .limit(options?.limit ?? 50),
  );
}

export async function findExportBatch(
  tenantId: string,
  batchId: string,
): Promise<TallyExportBatch | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tallyExportBatches)
      .where(
        and(
          eq(tallyExportBatches.tenantId, tenantId),
          eq(tallyExportBatches.id, batchId),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listBatchVouchers(
  tenantId: string,
  batchId: string,
): Promise<TallyVoucher[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tallyVouchers)
      .where(
        and(eq(tallyVouchers.tenantId, tenantId), eq(tallyVouchers.batchId, batchId)),
      )
      .orderBy(asc(tallyVouchers.voucherDate), asc(tallyVouchers.remoteId)),
  );
}

/**
 * ⭐⭐ WHAT HAS ALREADY BEEN SENT, AND UNDER WHICH KEY.
 *
 * ⚠️ THIS IS THE QUERY THE RE-EXPORT DEPENDS ON. A source row that has
 * been exported before must go out again under the SAME key with
 * `ACTION="Alter"`; a source row that has not must go out as a `Create`.
 * Getting it the wrong way round in either direction is a real failure:
 *
 *   • `Create` on something Tally already has → a second voucher, and
 *     the period is doubled.
 *   • `Alter` on something Tally does NOT have → Tally reports it
 *     "ignored", cheerfully, and the voucher silently never arrives.
 *
 * ⭐ ONLY DELIVERED BATCHES COUNT. A file that was generated and never
 * imported means Tally has nothing, so the next export must still be a
 * `Create` — which is exactly why `delivered_at` is a separate act from
 * generating.
 */
export async function loadPreviouslyDelivered(
  tenantId: string,
  sourceIds: readonly string[],
): Promise<Map<string, { remoteId: string; contentHash: string }>> {
  const found = new Map<string, { remoteId: string; contentHash: string }>();
  if (sourceIds.length === 0) return found;

  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        sourceType: tallyVouchers.sourceType,
        sourceId: tallyVouchers.sourceId,
        voucherType: tallyVouchers.voucherType,
        remoteId: tallyVouchers.remoteId,
        contentHash: tallyVouchers.contentHash,
      })
      .from(tallyVouchers)
      .innerJoin(
        tallyExportBatches,
        and(
          eq(tallyExportBatches.id, tallyVouchers.batchId),
          eq(tallyExportBatches.tenantId, tallyVouchers.tenantId),
        ),
      )
      .where(
        and(
          eq(tallyVouchers.tenantId, tenantId),
          inArray(tallyVouchers.sourceId, [...sourceIds]),
          eq(tallyExportBatches.status, "delivered"),
        ),
      ),
  );

  for (const row of rows) {
    found.set(`${row.sourceType}:${row.sourceId}:${row.voucherType}`, {
      remoteId: row.remoteId,
      contentHash: row.contentHash,
    });
  }
  return found;
}

/**
 * ⭐ OUR SIDE OF THE RECONCILIATION — every voucher we have DELIVERED
 * whose date falls in the period being compared.
 *
 * ⚠️ DELIVERED, NOT GENERATED, AND THE DIFFERENCE IS THE WHOLE REPORT.
 * Comparing generated-but-never-imported vouchers against Tally would
 * report every one of them as "missing in Tally" — which is true, and
 * useless, and would bury the four findings that matter under two
 * thousand that do not.
 */
export async function loadDeliveredVoucherFacts(
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): Promise<OurVoucherFacts[]> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        id: tallyVouchers.id,
        remoteId: tallyVouchers.remoteId,
        voucherType: tallyVouchers.voucherType,
        voucherNumber: tallyVouchers.voucherNumber,
        voucherDate: tallyVouchers.voucherDate,
        partyLedgerName: tallyVouchers.partyLedgerName,
        totalDebitMinor: tallyVouchers.totalDebitMinor,
        isCancelled: tallyVouchers.isCancelled,
      })
      .from(tallyVouchers)
      .innerJoin(
        tallyExportBatches,
        and(
          eq(tallyExportBatches.id, tallyVouchers.batchId),
          eq(tallyExportBatches.tenantId, tallyVouchers.tenantId),
        ),
      )
      .where(
        and(
          eq(tallyVouchers.tenantId, tenantId),
          eq(tallyExportBatches.status, "delivered"),
          gte(tallyVouchers.voucherDate, periodStart),
          lte(tallyVouchers.voucherDate, periodEnd),
        ),
      )
      .orderBy(asc(tallyVouchers.voucherDate)),
  );

  /**
   * ⚠️ DE-DUPLICATED ON THE REMOTE ID. The same source row legitimately
   * appears in several delivered batches — that is what a corrected
   * re-export IS — and counting it twice on our side would report a
   * `duplicate_in_tally` against a Tally that holds exactly one.
   * The LAST delivery is the one Tally now holds.
   */
  const byRemote = new Map<string, OurVoucherFacts>();
  for (const row of rows) {
    byRemote.set(row.remoteId, {
      id: row.id,
      remoteId: row.remoteId,
      voucherType: row.voucherType,
      voucherNumber: row.voucherNumber,
      voucherDate: row.voucherDate,
      partyLedgerName: row.partyLedgerName,
      amountMinor: toBigIntAmount(row.totalDebitMinor),
      isCancelled: row.isCancelled,
    });
  }
  return [...byRemote.values()];
}

/* ------------------------------------------------------------------ */
/* IMPORT BATCHES                                                      */
/* ------------------------------------------------------------------ */

export async function listImportBatches(
  tenantId: string,
  options?: { limit?: number },
): Promise<TallyImportBatch[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tallyImportBatches)
      .where(eq(tallyImportBatches.tenantId, tenantId))
      .orderBy(desc(tallyImportBatches.createdAt))
      .limit(options?.limit ?? 50),
  );
}

export async function listReconciliationItems(
  tenantId: string,
  importBatchId: string,
) {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tallyReconciliationItems)
      .where(
        and(
          eq(tallyReconciliationItems.tenantId, tenantId),
          eq(tallyReconciliationItems.importBatchId, importBatchId),
        ),
      )
      .orderBy(
        asc(tallyReconciliationItems.kind),
        asc(tallyReconciliationItems.createdAt),
      ),
  );
}

/* ------------------------------------------------------------------ */
/* NUMBERING                                                           */
/* ------------------------------------------------------------------ */

/**
 * `TALLY/2026-04/003`.
 *
 * ⚠️ COUNTED, NOT SEQUENCED, AND THE DIFFERENCE IS ACKNOWLEDGED HERE
 * RATHER THAN DISCOVERED LATER. Two exports started in the same second
 * would race and one would fail on the unique index — which is a retry,
 * not a corruption, and is the right trade for a number a person reads
 * rather than a key anything depends on. Nothing in this phase keys on
 * the batch number; the identity that matters is `remote_id`.
 */
export async function nextBatchNumber(
  tenantId: string,
  periodStart: string,
): Promise<string> {
  const prefix = `TALLY/${periodStart.slice(0, 7)}/`;
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({ batchNumber: tallyExportBatches.batchNumber })
      .from(tallyExportBatches)
      .where(eq(tallyExportBatches.tenantId, tenantId)),
  );
  const used = rows.filter((r) => r.batchNumber.startsWith(prefix)).length;
  return `${prefix}${String(used + 1).padStart(3, "0")}`;
}
