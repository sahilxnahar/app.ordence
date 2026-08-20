/**
 * Ordence — writer: `warehouses`
 * Version: v1.85.0-alpha · Phase 7
 *
 * ⚠️ THE STORE, NOT THE STOCK. Nothing here touches a balance or a
 * movement: creating a warehouse creates a place, and the quantity in it
 * arrives through `opening-stock`, which is a different entity with a
 * different destination and its own append-only ledger.
 */

import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { warehouses } from "@/db/schema";
import { describeWriteFailure } from "../shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "../types";

async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const codes = Array.from(
    new Set(keys.filter((k) => k.kind === "code").map((k) => k.value)),
  );
  if (codes.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: warehouses.id, code: warehouses.code })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, ctx.tenant.id),
          // The partial unique index excludes soft-deleted rows, so this
          // must too — see the same note in `stock-items.ts`.
          isNull(warehouses.deletedAt),
          // Case-insensitive for the same reason, and stricter than the
          // index for the same reason: `warehouse_by_code` resolves
          // case-insensitively, so two codes differing only in case are
          // a lookup nobody can predict the answer to.
          inArray(sql`lower(${warehouses.code})`, codes),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    const key = `code:${row.code.toLowerCase()}`;
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
    const values = {
      code: String(payload.code ?? ""),
      name: String(payload.name ?? ""),
      warehouseType:
        (payload.warehouseType as (typeof warehouses.$inferInsert)["warehouseType"]) ?? "own",
      city: (payload.city as string | null) ?? null,
      state: (payload.state as string | null) ?? null,
      stateCode: (payload.stateCode as string | null) ?? null,
      gstin: (payload.gstin as string | null) ?? null,
      /**
       * ⚠️ `false` RATHER THAN `null`, AND THE COLUMN IS `NOT NULL`.
       * `allowNegativeStock` defaults to `false` in the schema the form
       * uses, and the database comment is emphatic that permitting
       * negative stock must be a decision somebody made about a specific
       * store. A blank cell is therefore "no", which is the same answer
       * the form gives when nobody ticks the box.
       */
      allowNegativeStock: payload.allowNegativeStock === true,
      notes: (payload.notes as string | null) ?? null,
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        await tx
          .update(warehouses)
          .set({ ...values, updatedAt: new Date(), updatedBy: ctx.user.id })
          .where(
            and(
              eq(warehouses.id, existingId),
              eq(warehouses.tenantId, ctx.tenant.id),
              isNull(warehouses.deletedAt),
            ),
          );
        return;
      }
      await tx.insert(warehouses).values({
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

export const warehousesWriter: ImportWriter = {
  revalidatePath: "/inventory",
  findExisting,
  writeRow,
};
