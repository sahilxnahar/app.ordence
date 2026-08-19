import "server-only";

/**
 * Ordence — ⭐ THE VALUATION SERVICE — WHERE THE ENGINE MEETS THE LEDGER
 * Batches 85–87 · v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE FROM `lib/inventory/valuation.ts`
 * ══════════════════════════════════════════════════════════════════════
 * The engine is pure so that FIFO, weighted average, standard and
 * specific identification can be tested without a database — because
 * accounting that can only be exercised through a transaction is
 * accounting that never gets exercised. This file is the other half: it
 * reads the movement history, the item's chosen method, and the closed
 * periods, and hands them over.
 *
 * ⚠️ IT REPLAYS THE LEDGER RATHER THAN KEEPING A RUNNING FIGURE. A cached
 * average drifts from the ledger the first time a movement is backdated
 * or reversed, and inventory corrections are backdated constantly. The
 * cost written onto a movement and the cost an auditor recomputes come
 * out of the same replay, so they cannot disagree.
 *
 * 🔴 THE SCOPE IS (ITEM, WAREHOUSE). Valuing an item across all its
 * warehouses would let a receipt in Bengaluru pay for an issue in Hubli,
 * which is not what either store's stock card says. If a business wants
 * one company-wide pool, that is a decision with a disclosure attached
 * and it is not made silently here.
 */

import { and, asc, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { stockItems, stockMovements } from "@/db/schema/inventory";
import { financialPeriods } from "@/db/schema/accounting";
import {
  assertKnownMethod,
  costProposedIssue,
  parseQuantity,
  runValuation,
  type ClosedPeriod,
  type ValuationMethod,
  type ValuationMovement,
  type ValuationRun,
} from "@/lib/inventory/valuation";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

export type ValuationScope = {
  tenantId: string;
  stockItemId: string;
  warehouseId: string;
};

/**
 * ⚠️ CLOSED AND LOCKED ONLY. `closing` deliberately still accepts
 * postings — it is the state somebody works in while finishing a month,
 * and locking there would make a month impossible to close. This mirrors
 * `closedPeriodFor` in `server/accounting/post-sales.ts` rather than
 * inventing a second opinion about what "closed" means.
 */
async function closedPeriodsFor(tx: Tx, tenantId: string): Promise<ClosedPeriod[]> {
  const rows = await tx
    .select({
      name: financialPeriods.name,
      startDate: financialPeriods.startDate,
      endDate: financialPeriods.endDate,
      status: financialPeriods.status,
    })
    .from(financialPeriods)
    .where(eq(financialPeriods.tenantId, tenantId));

  return rows
    .filter((r) => r.status === "closed" || r.status === "locked")
    .map((r) => ({ name: r.name, startDate: r.startDate, endDate: r.endDate }));
}

/**
 * The item's declared method and its standard cost.
 *
 * 🔴 THROWS IF THE ITEM IS GONE. A valuation that quietly defaults when
 * it cannot find the item is exactly the defect this batch exists to
 * close.
 */
async function methodFor(
  tx: Tx,
  scope: ValuationScope,
): Promise<{ method: ValuationMethod; standardCostMinor: bigint | null; sku: string }> {
  const [item] = await tx
    .select({
      sku: stockItems.sku,
      valuationMethod: stockItems.valuationMethod,
      standardCostMinor: stockItems.standardCostMinor,
    })
    .from(stockItems)
    .where(
      and(eq(stockItems.tenantId, scope.tenantId), eq(stockItems.id, scope.stockItemId)),
    )
    .limit(1);

  if (!item) {
    throw new Error(
      "That stock item does not exist, so there is no valuation method to apply and nothing has been costed.",
    );
  }
  assertKnownMethod(item.valuationMethod);
  return {
    method: item.valuationMethod,
    standardCostMinor: item.standardCostMinor,
    sku: item.sku,
  };
}

/**
 * ⭐ THE MOVEMENT HISTORY, IN THE ORDER IT HAPPENED.
 *
 * ⚠️ REVERSALS ARE REPLAYED AS ORDINARY MOVEMENTS AND THAT IS CORRECT.
 * A reversal is an equal and opposite row; a negative reversal of a
 * receipt consumes the layer it created, and a positive reversal of an
 * issue puts a layer back. Filtering them out would value stock that the
 * ledger says is not there.
 */
async function movementsFor(tx: Tx, scope: ValuationScope): Promise<ValuationMovement[]> {
  const rows = await tx
    .select({
      id: stockMovements.id,
      movedAt: stockMovements.movedAt,
      quantity: stockMovements.quantity,
      unitCostMinor: stockMovements.unitCostMinor,
      valueMinor: stockMovements.valueMinor,
      reason: stockMovements.reason,
      batchNo: stockMovements.batchNo,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.tenantId, scope.tenantId),
        eq(stockMovements.stockItemId, scope.stockItemId),
        eq(stockMovements.warehouseId, scope.warehouseId),
      ),
    )
    .orderBy(asc(stockMovements.movedAt), asc(stockMovements.id));

  return rows.map((r) => ({
    id: r.id,
    movedAt: r.movedAt.toISOString(),
    quantity: parseQuantity(r.quantity),
    unitCostMinor: r.unitCostMinor,
    /**
     * ⭐ A STORED `value_minor` OF ZERO IS NOT A STATED VALUE, IT IS THE
     * COLUMN DEFAULT — every movement written before this engine existed
     * carries it. Treating it as "this receipt was free" would put a
     * fabricated cost into the accounts, so it is passed as absent and
     * the engine raises MISSING_RECEIPT_COST rather than back-computing
     * a history nobody recorded.
     */
    valueMinor: r.valueMinor === 0n ? null : r.valueMinor,
    reason: r.reason,
    batchNo: r.batchNo,
  }));
}

/** The full auditable working for one item in one warehouse. */
export async function valuationFor(
  tx: Tx,
  scope: ValuationScope,
): Promise<{ sku: string; run: ValuationRun }> {
  const [{ method, standardCostMinor, sku }, movements, closedPeriods] = await Promise.all(
    [methodFor(tx, scope), movementsFor(tx, scope), closedPeriodsFor(tx, scope.tenantId)],
  );

  return {
    sku,
    run: runValuation({ method, movements, standardCostMinor, closedPeriods }),
  };
}

export type CostedIssue = {
  method: ValuationMethod;
  /** Signed like the quantity: negative on an issue. */
  valueMinor: bigint;
  /** Positive. What hits cost of sales. */
  cogsMinor: bigint;
  warnings: { code: string; message: string }[];
  /** False when something was missing and the engine refused to invent it. */
  complete: boolean;
};

/**
 * ⭐⭐ WHAT ONE MOVEMENT ABOUT TO BE POSTED IS WORTH.
 *
 * ⚠️ COMPUTED BEFORE THE INSERT, NOT PATCHED AFTER IT. `stock_movements`
 * is append-only and guarded; an UPDATE to fill in the value afterwards
 * would either be refused by the trigger or, worse, quietly allowed and
 * turn the ledger into something editable. So the value is decided
 * first, with a hypothetical row, and written as part of the insert.
 *
 * ⚠️ THE INWARD CASE IS NOT COSTED HERE. A receipt's cost comes from its
 * document — the purchase invoice — and is passed in by the caller. The
 * engine's job on the way IN is only to remember it.
 */
export async function costMovement(
  tx: Tx,
  scope: ValuationScope,
  proposed: {
    id: string;
    movedAt: Date;
    quantity: bigint;
    unitCostMinor: bigint | null;
    batchNo: string | null;
    reason: string;
  },
): Promise<CostedIssue> {
  const [{ method, standardCostMinor }, movements, closedPeriods] = await Promise.all([
    methodFor(tx, scope),
    movementsFor(tx, scope),
    closedPeriodsFor(tx, scope.tenantId),
  ]);

  const { valueMinor, cogsMinor, run } = costProposedIssue({
    method,
    movements,
    standardCostMinor,
    closedPeriods,
    proposed: {
      id: proposed.id,
      movedAt: proposed.movedAt.toISOString(),
      quantity: proposed.quantity,
      unitCostMinor: proposed.unitCostMinor,
      reason: proposed.reason,
      batchNo: proposed.batchNo,
    },
  });

  /**
   * ⭐ ONLY THE WARNINGS THAT BELONG TO THIS MOVEMENT ARE RETURNED. The
   * history's own gaps are real and are reported by `valuationFor`, but
   * showing a user posting today a warning about a receipt from 2023
   * teaches them to dismiss warnings.
   */
  const mine = run.warnings.filter((w) => w.movementId === proposed.id);

  return {
    method,
    valueMinor,
    cogsMinor,
    warnings: mine.map((w) => ({ code: w.code, message: w.message })),
    complete: run.complete,
  };
}
