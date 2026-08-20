/**
 * Ordence — writer: `cost_centres`
 * Version: v1.85.0-alpha · Phase 8
 *
 * ⚠️ THE SHORTEST WRITER IN THE PHASE, AND THE ONE WITH THE SHARPEST
 *    MATCHING RULE. `cost_centres_code_key` is
 *    `UNIQUE (tenant_id, upper(code))`, so the query below compares
 *    `upper()` on both sides — and the entity's natural key upper-cases
 *    the value it builds from the file, so the two halves cannot drift.
 *
 * 🔴 THERE IS NO `deleted_at` ON THIS TABLE and no soft-delete predicate
 *    below. That is not an omission: `db/schema/budgets.ts` argues at
 *    length that a cost centre which has been posted to must never
 *    disappear, because the journal lines pointing at it are append-only
 *    and a report grouping by a removed cost centre prints a UUID as a
 *    column heading. `is_active = false` is retirement, and a retired
 *    cost centre IS a match — a re-import must not create a second one
 *    beside it, and the unique index would refuse that in any case.
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { costCentres } from "@/db/schema";
import { describeWriteFailure } from "../shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "../types";

async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const codes = Array.from(
    new Set(keys.filter((k) => k.kind === "costCentreCode").map((k) => k.value)),
  );
  if (codes.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: costCentres.id, code: costCentres.code })
      .from(costCentres)
      .where(
        and(
          eq(costCentres.tenantId, ctx.tenant.id),
          /*
           * ⚠️ `upper()` ON BOTH SIDES. The entity upper-cases the key it
           * builds from the file; comparing that against a mixed-case
           * column would find nothing — and "finds nothing" here does not
           * fail loudly, it reports every row as a creation and then
           * meets a unique violation on the first one Postgres already
           * has.
           */
          inArray(sql`upper(${costCentres.code})`, codes),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    const key = `costCentreCode:${row.code.toUpperCase()}`;
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
      description: (payload.description as string | undefined) ?? null,
      /*
       * ⚠️ THE SCHEMA'S DEFAULT, NOT A SECOND ONE WRITTEN HERE.
       * `costCentreSchema` gives `displayOrder` a `.default(100)`, so a
       * parsed payload always carries a number and this coalesce is
       * unreachable in practice. It is written anyway because `?? 100`
       * appearing in two files with two different numbers is exactly how
       * a default drifts — and if it is ever reached, 100 is the one the
       * form uses.
       */
      displayOrder: (payload.displayOrder as number | undefined) ?? 100,
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        await tx
          .update(costCentres)
          .set({ ...values, updatedAt: new Date() })
          .where(
            and(eq(costCentres.id, existingId), eq(costCentres.tenantId, ctx.tenant.id)),
          );
        return;
      }
      await tx.insert(costCentres).values({
        ...values,
        tenantId: ctx.tenant.id,
        createdBy: ctx.user.id,
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const costCentresWriter: ImportWriter = {
  /**
   * ⚠️ THE COST-CENTRE SCREEN, NOT `/accounting`. `app/(crm)/accounting/
   * cost-centres/page.tsx` is the page that lists them, and revalidating
   * the parent would leave a customer looking at a stale list on the one
   * screen the import just changed.
   */
  revalidatePath: "/accounting/cost-centres",
  findExisting,
  writeRow,
};
