/**
 * Ordence — writer: `stock_items`
 * Version: v1.85.0-alpha · Phase 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS FILE EXISTS BEFORE THE ENTITY DOES
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/types.ts`: "do not register an entity whose writer does not
 * exist". Before Phase 1 that was advice; now `IMPORT_WRITERS` is a
 * `Record` over the destination union, so adding `"stock_items"` to
 * `ImportTableKey` without this module is a compile error at the
 * registry. It was — the error is quoted in `TRACK-REPORT.md`.
 *
 * ⚠️ THE SHAPE IS COPIED FROM `../companies.ts` DELIBERATELY. Two
 * writers that solve the same problem differently are two behaviours to
 * keep in step; the interesting differences are commented where they
 * occur and there are only two of them.
 */

import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { stockItems } from "@/db/schema";
import { describeWriteFailure } from "../shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "../types";

/**
 * ⚠️ THE ONLY KEY IS THE SKU, AND THERE IS NO FALLBACK TO THE NAME.
 *
 * `companies` falls back from domain to name because a company with no
 * domain is ordinary. An item with no SKU is not a stock item — the
 * schema refuses it — so there is nothing to fall back FOR, and a
 * name-based fallback would match "Cement" against "Cement" in a file
 * where those are two different grades.
 */
async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const skus = Array.from(
    new Set(keys.filter((k) => k.kind === "sku").map((k) => k.value)),
  );
  if (skus.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: stockItems.id, sku: stockItems.sku })
      .from(stockItems)
      .where(
        and(
          // Written even though RLS enforces it independently. Relying on
          // a single layer is how single layers become the only layer.
          eq(stockItems.tenantId, ctx.tenant.id),
          /*
           * ⚠️ SOFT-DELETED ROWS ARE NOT MATCHES, because
           * `stock_items_tenant_sku_unique` is a PARTIAL index excluding
           * them. Treating a deleted item as existing would make `skip`
           * discard a row the database would have accepted, and the
           * customer's deleted item would stay deleted with no new one
           * created.
           */
          isNull(stockItems.deletedAt),
          /*
           * ⚠️ `lower(...)` ON BOTH SIDES, and this is DELIBERATELY
           * STRICTER THAN THE DATABASE. The unique index is on the SKU
           * exactly as typed, so `ABC` and `abc` are two rows to
           * Postgres. They are one item in every real warehouse, and the
           * `stock_item_by_sku` lookup that `opening-stock` resolves is
           * already case-insensitive — matching case-sensitively here
           * would let an import create the second spelling that the
           * lookup then resolves to arbitrarily one of the two.
           *
           * The cost of being stricter is a row reported as a duplicate
           * that the database would have accepted, which the customer
           * can see in the report. The cost of being looser is an
           * ambiguous item master, which nobody sees.
           */
          inArray(sql`lower(${stockItems.sku})`, skus),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    const key = `sku:${row.sku.toLowerCase()}`;
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
    /**
     * ⚠️ `standardCostMinor` ARRIVES AS A `bigint`, not a string.
     * `minorAmount` in `lib/validators/inventory.ts` carries a
     * `.transform(BigInt)`, so by the time a payload reaches a writer the
     * conversion has already happened — in the schema the form uses,
     * once, rather than here and again in every other caller.
     */
    const values = {
      sku: String(payload.sku ?? ""),
      name: String(payload.name ?? ""),
      description: (payload.description as string | null) ?? null,
      uom: (payload.uom as string | undefined) ?? "nos",
      trackingMode:
        (payload.trackingMode as (typeof stockItems.$inferInsert)["trackingMode"]) ?? "none",
      valuationMethod:
        (payload.valuationMethod as (typeof stockItems.$inferInsert)["valuationMethod"]) ??
        "weighted_average",
      standardCostMinor: (payload.standardCostMinor as bigint | null) ?? null,
      reorderLevel: (payload.reorderLevel as string | null) ?? null,
      reorderQuantity: (payload.reorderQuantity as string | null) ?? null,
      leadTimeDays: (payload.leadTimeDays as number | null) ?? null,
      shelfLifeDays: (payload.shelfLifeDays as number | null) ?? null,
      hsnSacCode: (payload.hsnSacCode as string | null) ?? null,
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        await tx
          .update(stockItems)
          .set({ ...values, updatedAt: new Date(), updatedBy: ctx.user.id })
          .where(
            and(
              eq(stockItems.id, existingId),
              eq(stockItems.tenantId, ctx.tenant.id),
              isNull(stockItems.deletedAt),
            ),
          );
        return;
      }
      await tx.insert(stockItems).values({
        ...values,
        tenantId: ctx.tenant.id,
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const stockItemsWriter: ImportWriter = {
  revalidatePath: "/inventory",
  findExisting,
  writeRow,
};
