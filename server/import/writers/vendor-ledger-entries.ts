/**
 * Ordence — writer: `vendor_ledger_entries`
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
  vendorLedgerEntries,
  vendors,
} from "@/db/schema";
import { minorOf, describeWriteFailure } from "./shared";
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

  const composites = valuesOf("vendorBill");
  if (composites.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: vendorLedgerEntries.id,
        code: vendors.code,
        reference: vendorLedgerEntries.referenceNumber,
      })
      .from(vendorLedgerEntries)
      .innerJoin(
        vendors,
        and(
          eq(vendors.id, vendorLedgerEntries.vendorId),
          eq(vendors.tenantId, vendorLedgerEntries.tenantId),
        ),
      )
      .where(
        and(
          eq(vendorLedgerEntries.tenantId, ctx.tenant.id),
          inArray(
            sql`(lower(${vendors.code}) || '|' || coalesce(${vendorLedgerEntries.referenceNumber}, ''))`,
            composites,
          ),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    found.set(`vendorBill:${row.code.toLowerCase()}|${row.reference ?? ""}`, row.id);
  }
  return found;
}

async function writeRow(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<WriteOutcome> {
  try {
    await withTenant(ctx.tenant.id, async (tx) => {
      await tx.insert(vendorLedgerEntries).values({
        tenantId: ctx.tenant.id,
        vendorId: String(payload.vendorId),
        entryDate: String(payload.billDate ?? ""),
        entryType: "purchase_invoice",
        referenceNumber: String(payload.billNumber ?? ""),
        description:
          (payload.notes as string | null) ??
          "Opening balance brought forward from the previous system.",
        debitMinor: 0n,
        creditMinor: minorOf(payload.outstandingMinor),
        dueDate: (payload.dueDate as string | null) ?? null,
        createdBy: ctx.user.id,
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const vendorLedgerEntriesWriter: ImportWriter = {
  revalidatePath: "/purchases",
  findExisting,
  writeRow,
};
