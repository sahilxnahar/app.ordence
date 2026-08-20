/**
 * Ordence — writer: `companies`
 * Version: v1.85.0-alpha · Phase 1
 *
 * ⚠️ MOVED, NOT REWRITTEN. Every line below came out of
 * `server/actions/import.ts` verbatim, with its comments, because a
 * refactor that also changes behaviour is a refactor nobody can review.
 * The only edits are the removal of the `if (entity.table === ...)`
 * wrapper and the arguments the wrapper used to close over.
 */

import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  companies,
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

  const domains = valuesOf("domain");
  const names = valuesOf("name");
  if (domains.length === 0 && names.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: companies.id,
        domain: companies.domain,
        name: companies.name,
      })
      .from(companies)
      .where(
        and(
          // The tenant predicate is written even though RLS enforces it
          // independently. Relying on a single layer is how single
          // layers become the only layer.
          eq(companies.tenantId, ctx.tenant.id),
          // ⚠️ SOFT-DELETED ROWS ARE NOT MATCHES. The partial unique
          // index excludes them too, so treating one as an existing
          // record would mean `skip` silently discarded a row the
          // database would have happily accepted — and the customer's
          // deleted company would stay deleted with no new one created.
          isNull(companies.deletedAt),
          matchAny([
            /*
             * ⚠️ `lower(...)` ON BOTH SIDES. The pure layer lower-cases
             * the key it built from the file; comparing that against a
             * mixed-case column would find nothing, and "finds nothing"
             * here does not fail loudly — it reports every row as a
             * creation and then duplicates the workspace.
             */
            domains.length > 0
              ? inArray(sql`lower(${companies.domain})`, domains)
              : null,
            names.length > 0
              ? inArray(
                  // ⚠️ `\\s` NOT `\s`. This is a template literal, where
                  // `\s` is a NonEscapeCharacter and collapses to a bare
                  // `s` — so the pattern would become `'s+'` and the
                  // query would strip the letter s out of every company
                  // name before comparing. It matches nothing, silently,
                  // and "matches nothing" here reports every row as new
                  // and duplicates the workspace.
                  sql`lower(regexp_replace(${companies.name}, '\\s+', ' ', 'g'))`,
                  names,
                )
              : null,
          ]),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    if (row.domain) {
      const key = `domain:${row.domain.toLowerCase()}`;
      if (!found.has(key)) found.set(key, row.id);
    }
    const nameKey = `name:${row.name.toLowerCase().replace(/\s+/g, " ")}`;
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
    const values = {
      name: String(payload.name ?? ""),
      domain: (payload.domain as string | null) ?? null,
      industry: (payload.industry as string | null) ?? null,
      employeeCount: (payload.employeeCount as number | null) ?? null,
      companySize: (payload.companySize as (typeof companies.$inferInsert)["companySize"]) ?? null,
      website: (payload.website as string | null) ?? null,
      phone: (payload.phone as string | null) ?? null,
      addressLine1: (payload.addressLine1 as string | null) ?? null,
      addressLine2: (payload.addressLine2 as string | null) ?? null,
      city: (payload.city as string | null) ?? null,
      state: (payload.state as string | null) ?? null,
      postalCode: (payload.postalCode as string | null) ?? null,
      country: (payload.country as string | null) ?? null,
      notes: (payload.notes as string | null) ?? null,
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        await tx
          .update(companies)
          .set({ ...values, updatedAt: new Date() })
          .where(
            and(
              eq(companies.id, existingId),
              eq(companies.tenantId, ctx.tenant.id),
              isNull(companies.deletedAt),
            ),
          );
        return;
      }
      await tx.insert(companies).values({
        ...values,
        tenantId: ctx.tenant.id,
        customFields: {},
        ownerId: ctx.user.id,
        createdBy: ctx.user.id,
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const companiesWriter: ImportWriter = {
  revalidatePath: "/companies",
  findExisting,
  writeRow,
};
