/**
 * Ordence — writer: `gst_parties`
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
  companies,
  gstParties,
} from "@/db/schema";
import { matchAny, describeWriteFailure } from "./shared";
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

  // gst_parties. The key is composite — `partyType|gstin` — because the
  // database's own unique index is `(tenant_id, party_type, gstin)`.
  const gstinValues = valuesOf("gstin");
  const nameValues = valuesOf("legalName");
  if (gstinValues.length === 0 && nameValues.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: gstParties.id,
        partyType: gstParties.partyType,
        gstin: gstParties.gstin,
        legalName: gstParties.legalName,
      })
      .from(gstParties)
      .where(
        and(
          eq(gstParties.tenantId, ctx.tenant.id),
          // ⚠️ THE INDEX IS `WHERE ... AND is_active`, so a retired row is
          // not a collision. Matching one would mean a party whose
          // registration lapsed could never be re-added.
          eq(gstParties.isActive, true),
          matchAny([
            gstinValues.length > 0
              ? inArray(
                  sql`(${gstParties.partyType}::text || '|' || ${gstParties.gstin})`,
                  gstinValues,
                )
              : null,
            nameValues.length > 0
              ? inArray(
                  // `\\s`, for the reason spelled out on the companies branch.
                  sql`(${gstParties.partyType}::text || '|' || lower(regexp_replace(${gstParties.legalName}, '\\s+', ' ', 'g')))`,
                  nameValues,
                )
              : null,
          ]),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    if (row.gstin) {
      const key = `gstin:${row.partyType}|${row.gstin}`;
      if (!found.has(key)) found.set(key, row.id);
    }
    const nameKey = `legalName:${row.partyType}|${row.legalName.toLowerCase().replace(/\s+/g, " ")}`;
    if (!found.has(nameKey)) found.set(nameKey, row.id);
  }
  return found;
}

async function writeRow(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<WriteOutcome> {
  try {
    const gstin = (payload.gstin as string | null) ?? null;
    const values = {
      partyType: payload.partyType as (typeof gstParties.$inferInsert)["partyType"],
      legalName: String(payload.legalName ?? ""),
      tradeName: (payload.tradeName as string | null) ?? null,
      gstin,
      panNumber: (payload.panNumber as string | null) ?? null,
      registrationType: payload.registrationType as (typeof gstParties.$inferInsert)["registrationType"],
      /*
       * ⚠️ DERIVED FROM THE GSTIN WHERE THERE IS ONE, exactly as
       * `saveParty` does. A GSTIN's first two digits ARE its state and
       * the CHECK constraint holds them equal; taking the CSV's value in
       * preference would let a mistyped state column flip an invoice
       * between IGST and CGST+SGST.
       */
      stateCode: gstin ? gstin.slice(0, 2) : ((payload.stateCode as string | null) ?? null),
      address:
        (payload.address as (typeof gstParties.$inferInsert)["address"]) ?? {},
      effectiveFrom: String(payload.effectiveFrom ?? ""),
      effectiveTo: (payload.effectiveTo as string | null) ?? null,
      notes: (payload.notes as string | null) ?? null,
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        await tx
          .update(gstParties)
          .set(values)
          .where(and(eq(gstParties.id, existingId), eq(gstParties.tenantId, ctx.tenant.id)));
        return;
      }
      await tx.insert(gstParties).values({ ...values, tenantId: ctx.tenant.id });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const gstPartiesWriter: ImportWriter = {
  revalidatePath: "/settings/gst",
  findExisting,
  writeRow,
};
