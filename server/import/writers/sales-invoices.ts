/**
 * Ordence — writer: `sales_invoices`
 * Version: v1.85.0-alpha · Phase 1
 *
 * ⚠️ MOVED, NOT REWRITTEN. Every line below came out of
 * `server/actions/import.ts` verbatim, with its comments, because a
 * refactor that also changes behaviour is a refactor nobody can review.
 * The only edits are the removal of the `if (entity.table === ...)`
 * wrapper and the arguments the wrapper used to close over.
 */

import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  salesInvoices,
} from "@/db/schema";
import { financialYearOf } from "@/lib/gst/constants";
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

  const numbers = valuesOf("invoiceNumber");
  if (numbers.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: salesInvoices.id, number: salesInvoices.invoiceNumber })
      .from(salesInvoices)
      .where(
        and(
          eq(salesInvoices.tenantId, ctx.tenant.id),
          inArray(salesInvoices.invoiceNumber, numbers),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) found.set(`invoiceNumber:${row.number}`, row.id);
  return found;
}

async function writeRow(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<WriteOutcome> {
  try {
    const invoiceDate = String(payload.invoiceDate ?? "");
    const outstanding = minorOf(payload.outstandingMinor);
    const invoiceNumber = String(payload.invoiceNumber ?? "");

    await withTenant(ctx.tenant.id, async (tx) => {
      await tx.insert(salesInvoices).values({
        tenantId: ctx.tenant.id,
        invoiceNumber,
        /*
         * ⚠️ THE FINANCIAL YEAR OF THE INVOICE'S OWN DATE. Rule 46(b)
         * makes a serial unique for a financial year, and the Indian
         * one runs 1 April to 31 March — `financialYearOf` is the
         * single place that decides where the boundary is, so this
         * cannot drift from the numbering the rest of the product does.
         */
        financialYear: financialYearOf(invoiceDate),
        status: "issued",
        companyId: String(payload.companyId),
        invoiceDate,
        dueDate: (payload.dueDate as string | null) ?? null,
        currency: "INR",
        subtotalMinor: outstanding,
        taxableValueMinor: 0n,
        totalMinor: outstanding,
        issuedAt: new Date(`${invoiceDate}T00:00:00+05:30`),
        issuedBy: ctx.user.id,
        notes:
          (payload.notes as string | null) ??
          "Opening balance brought forward from the previous system.",
        createdBy: ctx.user.id,
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const salesInvoicesWriter: ImportWriter = {
  revalidatePath: "/invoices",
  findExisting,
  writeRow,
};
