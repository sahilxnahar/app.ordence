/**
 * Ordence — writer: `hsn_sac_codes` (tax codes)
 * Version: v1.85.0-alpha · Phase 8
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS WRITES A CODE. IT DOES NOT AND CANNOT WRITE A RATE.
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/gst.ts` sets out four defences for one rule — that a GST
 * rate is a fact about a dated PERIOD and never a property of the code —
 * and the reason it needs four is that violating it is completely silent:
 * *"every 2019 invoice re-renders at 5%, the reconciliation against
 * GSTR-1 fails for a whole quarter, and NOTHING ERRORS."*
 *
 * So there is no `rateBps` anywhere in this file, no `hsn_sac_rates`
 * insert, and no "helpfully" opening a period for a newly imported code.
 * A code arrives with no rate, `codesWithoutRateOn` lists it, and the
 * customer opens its first period deliberately with a date on it. The
 * entity's own `description` says so in the picker, before the upload,
 * because a customer who believes the import finished the job is a
 * customer who invoices at no rate at all.
 *
 * ⚠️ NOTHING IS SOFT-DELETED HERE EITHER. `hsn_sac_codes` has no
 * `deleted_at`; `is_active` is what retirement means, and a retired code
 * still matches on re-import because `hsn_sac_codes_code_tenant_unique`
 * does not exclude it.
 */

import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db";
import { hsnSacCodes } from "@/db/schema";
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
    new Set(keys.filter((k) => k.kind === "taxCode").map((k) => k.value)),
  );
  if (codes.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: hsnSacCodes.id, code: hsnSacCodes.code })
      .from(hsnSacCodes)
      .where(
        and(
          eq(hsnSacCodes.tenantId, ctx.tenant.id),
          /*
           * ⚠️ NO CASE NORMALISATION, AND NONE IS POSSIBLE TO GET WRONG:
           * `createHsnSacSchema` refuses anything but digits, and the
           * database repeats the rule as `hsn_sac_codes_shape`. Adding a
           * `lower()` here would be a normalisation of a value that has
           * no letters in it — dead code that reads like a rule.
           *
           * 🔴 AND THE INDEX IS ON THE CODE ALONE, NOT ON (code, kind).
           * So one workspace cannot hold `995411` as both an HSN and a
           * SAC, and the natural key must not include `kind` either — a
           * composite key here would report the second spelling as a new
           * row and Postgres would refuse it with a unique violation
           * halfway through the file.
           */
          inArray(hsnSacCodes.code, codes),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    const key = `taxCode:${row.code}`;
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
      kind: payload.kind as (typeof hsnSacCodes.$inferInsert)["kind"],
      description: String(payload.description ?? ""),
      uqc: (payload.uqc as string | null) ?? null,
      notes: (payload.notes as string | null) ?? null,
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        await tx
          .update(hsnSacCodes)
          .set({ ...values, updatedAt: new Date() })
          .where(
            and(eq(hsnSacCodes.id, existingId), eq(hsnSacCodes.tenantId, ctx.tenant.id)),
          );
        return;
      }
      await tx.insert(hsnSacCodes).values({ ...values, tenantId: ctx.tenant.id });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const hsnSacCodesWriter: ImportWriter = {
  /**
   * ⚠️ `/settings/gst`, WHICH IS WHERE THE CODES ARE, and it is the path
   * `createHsnSacCode` revalidates. Two write paths revalidating two
   * different pages is how one of them starts showing a stale list.
   */
  revalidatePath: "/settings/gst",
  findExisting,
  writeRow,
};
