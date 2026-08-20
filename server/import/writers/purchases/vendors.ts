/**
 * Ordence — writer: `vendors`
 * Version: v1.85.0-alpha · Phase 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE EXISTS BECAUSE OF WHAT PHASE 1 FOUND, AND IT IS WORTH
 *    REPEATING AT THE TOP OF EVERY NEW WRITER
 * ══════════════════════════════════════════════════════════════════════
 * Before Phase 1, `gst_parties` was the UNGUARDED FINAL BRANCH of both
 * `findExistingByNaturalKey` and `writeRow` — not an `if`, just the code
 * after the last one. A destination with no branch therefore did not
 * write nothing. It wrote a GST party. A vendor master imported without
 * this file would have landed in the customer's tax master, matched
 * against existing parties by natural key, and reported success.
 *
 * `IMPORT_WRITERS` is now a `Record` over the destination union, so
 * omitting this file is a compile error at
 * `server/import/writers/registry.ts` naming `vendors`. That is the
 * property; this module is one half of it and the registry entry in
 * `PATCH-REQUEST-PHASE-6.md` §2 is the other.
 *
 * ⚠️ THE WRITE MIRRORS `upsertVendor` IN `server/actions/purchases.ts:154`
 * COLUMN FOR COLUMN, including `?? null` and `?? {}` on every optional.
 * It is not delegated to that action the way the purchase-bill writer
 * delegates to `recordPurchaseInvoice`, and the reason is `update` mode:
 * `upsertVendor` decides insert-versus-update from `data.id`, which the
 * import does not have — the importer has already resolved the existing
 * row by natural key and passes `existingId`. Handing the action a
 * payload with an `id` we resolved ourselves would be the same write by
 * a longer route with one more place for the two to disagree.
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { vendors } from "@/db/schema";
import { describeWriteFailure } from "./../shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "./../types";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 BLOCKED VENDORS ARE MATCHES. NOT FILTERING `is_active` IS THE WHOLE
 *    POINT OF THIS FUNCTION.
 * ══════════════════════════════════════════════════════════════════════
 * `gstPartiesWriter` deliberately EXCLUDES inactive rows, because
 * `gst_parties_gstin_type_unique` is `WHERE ... AND is_active` and a
 * retired registration must be re-addable. `vendors_code_tenant_unique`
 * has NO such predicate — `db/schema/purchases.ts:474` — so a blocked
 * vendor still occupies its code.
 *
 * ⚠️ FILTERING `is_active` HERE WOULD THEREFORE PRODUCE THE WORST
 *    AVAILABLE OUTCOME: the importer would find no match, decide the row
 *    is a create, attempt the insert, and Postgres would refuse it with
 *    `23505` on a constraint the customer has never heard of — on every
 *    vendor they have ever blocked. Under `skip` that is a row silently
 *    lost; the preview would have promised it.
 *
 * `setVendorActive` in `server/actions/purchases.ts` says the same thing
 * from the other side: "BLOCK, NEVER DELETE … blocking stops new bills
 * and keeps the history." The history keeps the code with it.
 *
 * ⚠️ THE COMPARISON IS `lower(code)`, MATCHING `naturalKey`, AND IT IS
 * STRICTER THAN THE INDEX. The index is case-sensitive, so `V-42` and
 * `v-42` can both exist. Matching case-insensitively means a file that
 * says `v-42` updates the existing `V-42` rather than trying to create a
 * second vendor nobody can tell apart on a payment run. It is also what
 * `resolveLookups`' `vendor_by_code` does — `server/actions/import.ts:432`
 * — so a bill quoting either spelling reaches the same vendor.
 */
async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const codes = Array.from(
    new Set(keys.filter((k) => k.kind === "vendorCode").map((k) => k.value)),
  );
  if (codes.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: vendors.id, code: vendors.code })
      .from(vendors)
      .where(
        and(
          eq(vendors.tenantId, ctx.tenant.id),
          inArray(sql`lower(${vendors.code})`, codes),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    const key = `vendorCode:${row.code.toLowerCase()}`;
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
    /*
     * ⚠️ EVERY OPTIONAL IS `?? null` AND THE TWO JSONB COLUMNS ARE
     * `?? {}`, WHICH IS EXACTLY WHAT `upsertVendor` DOES.
     *
     * 🔴 AND THAT MAKES `update` MODE A FULL OVERWRITE, NOT A MERGE. A
     *    file with no MSME columns will clear the MSME status of every
     *    vendor it touches in `update` mode. That is the same behaviour
     *    the form has — saving the vendor form with a field cleared
     *    clears it — and making the importer merge instead would be a
     *    second, different write semantic for the same table, which is
     *    how the form and the import stop agreeing. The entity's
     *    `duplicateDecision` recommends `skip` and says this in the
     *    customer's words; `buildPayload` omits `address` and
     *    `bankDetails` ENTIRELY when every part is blank so that a file
     *    without those columns does not erase them.
     */
    const address = (payload.address ?? {}) as (typeof vendors.$inferInsert)["address"];
    const bankDetails = (payload.bankDetails ??
      {}) as (typeof vendors.$inferInsert)["bankDetails"];

    const values = {
      code: String(payload.code ?? ""),
      legalName: String(payload.legalName ?? ""),
      tradeName: (payload.tradeName as string | null) ?? null,
      vendorType: payload.vendorType as (typeof vendors.$inferInsert)["vendorType"],
      gstPartyId: null,
      companyId: null,
      panNumber: (payload.panNumber as string | null) ?? null,
      msmeRegistered: Boolean(payload.msmeRegistered),
      udyamNumber: (payload.udyamNumber as string | null) ?? null,
      msmeCategory: (payload.msmeCategory ??
        null) as (typeof vendors.$inferInsert)["msmeCategory"],
      msmeRegisteredOn: (payload.msmeRegisteredOn as string | null) ?? null,
      paymentTermsDays: Number(payload.paymentTermsDays ?? 30),
      tdsApplicable: Boolean(payload.tdsApplicable),
      defaultTdsSection: (payload.defaultTdsSection as string | null) ?? null,
      address,
      bankDetails,
      notes: (payload.notes as string | null) ?? null,
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        /*
         * ⚠️ `AND tenant_id = ...` ALONGSIDE THE PRIMARY KEY, AND IT IS
         * NOT REDUNDANT. `existingId` came from `findExisting` above,
         * which is already tenant-scoped — but this is the write, RLS is
         * the only isolation this product has, and a predicate that
         * costs nothing is cheaper than the argument about whether the
         * id could ever have come from anywhere else. `upsertVendor`
         * does the same.
         */
        await tx
          .update(vendors)
          .set(values)
          .where(and(eq(vendors.id, existingId), eq(vendors.tenantId, ctx.tenant.id)));
        return;
      }
      await tx
        .insert(vendors)
        .values({ ...values, tenantId: ctx.tenant.id, createdBy: ctx.user.id });
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const vendorsWriter: ImportWriter = {
  /**
   * ⚠️ THE VENDOR LIST, NOT `/purchases`. `upsertVendor` revalidates
   * `/purchases/vendors` and this is the same write; revalidating a
   * different path would leave the page the customer is looking at
   * showing the list they had before the import.
   */
  revalidatePath: "/purchases/vendors",
  findExisting,
  writeRow,
};
