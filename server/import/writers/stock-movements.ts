/**
 * Ordence — writer: `stock_movements`
 * Version: v1.85.0-alpha · Phase 1
 *
 * ⚠️ MOVED, NOT REWRITTEN. Every line below came out of
 * `server/actions/import.ts` verbatim, with its comments, because a
 * refactor that also changes behaviour is a refactor nobody can review.
 * The only edits are the removal of the `if (entity.table === ...)`
 * wrapper and the arguments the wrapper used to close over.
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  stockItems,
  stockMovements,
  warehouses,
} from "@/db/schema";
import { openingBatchKey } from "@/lib/import";
import { minorOf, thousandthsToDecimal, describeWriteFailure } from "./shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "./types";

async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const valuesOf = (kind: string) =>
    Array.from(new Set(keys.filter((k) => k.kind === kind).map((k) => k.value)));

  const slots = valuesOf("stockSlot");
  if (slots.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: stockMovements.id,
        sku: stockItems.sku,
        code: warehouses.code,
        batchNo: stockMovements.batchNo,
      })
      .from(stockMovements)
      .innerJoin(
        stockItems,
        and(
          eq(stockItems.id, stockMovements.stockItemId),
          eq(stockItems.tenantId, stockMovements.tenantId),
        ),
      )
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.id, stockMovements.warehouseId),
          eq(warehouses.tenantId, stockMovements.tenantId),
        ),
      )
      .where(
        and(
          eq(stockMovements.tenantId, ctx.tenant.id),
          eq(stockMovements.reason, "opening_balance"),
          inArray(
            sql`(lower(${stockItems.sku}) || '|' || lower(${warehouses.code}) || '|' || lower(coalesce(${stockMovements.batchNo}, '')))`,
            slots,
          ),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    const key = `stockSlot:${row.sku.toLowerCase()}|${row.code.toLowerCase()}|${(row.batchNo ?? "").toLowerCase()}`;
    if (!found.has(key)) found.set(key, row.id);
  }
  return found;
}

async function writeRow(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<WriteOutcome> {
  try {
    const asAt = String(payload.asAt ?? "");
    const quantityThousandths = minorOf(payload.quantityThousandths);
    const unitCostMinor = minorOf(payload.unitCostMinor);

    await withTenant(ctx.tenant.id, async (tx) => {
      await tx.insert(stockMovements).values({
        tenantId: ctx.tenant.id,
        stockItemId: String(payload.stockItemId),
        warehouseId: String(payload.warehouseId),
        /*
         * ⚠️ `numeric(18,3)` FROM INTEGER THOUSANDTHS BY STRING, never
         * by dividing. `Number(n) / 1000` is where `0.1 + 0.2 !== 0.3`
         * gets into a stock ledger, and a ledger that is out by a
         * millionth on every movement stops reconciling after a few
         * thousand of them.
         */
        quantity: thousandthsToDecimal(quantityThousandths),
        reason: "opening_balance",
        /*
         * ⚠️ THE DAY IT WAS COUNTED, NOT THE DAY IT WAS UPLOADED. A
         * count done on the 31st and imported on the 4th is a count as
         * at the 31st, and every valuation report that reads
         * `moved_at` would otherwise put four days of trading on the
         * wrong side of it.
         */
        movedAt: new Date(`${asAt}T00:00:00+05:30`),
        unitCostMinor,
        /*
         * ⚠️ VALUE IS COMPUTED IN `BigInt` FROM THE THOUSANDTHS AND
         * THE PAISE, then divided by 1000 — integer arithmetic
         * throughout. The rounding is toward zero, which is worth at
         * most a paisa on a line, and it is the same direction every
         * time rather than whichever way a float happened to land.
         */
        valueMinor: (quantityThousandths * unitCostMinor) / 1000n,
        batchNo: (payload.batchNo as string | null) ?? null,
        referenceType: "opening_balance",
        documentNo: openingBatchKey("stock", asAt),
        createdBy: ctx.user.id,
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const stockMovementsWriter: ImportWriter = {
  revalidatePath: "/inventory",
  findExisting,
  writeRow,
};
