/**
 * Ordence — writer: `ledgers` (the chart of accounts)
 * Version: v1.85.0-alpha · Phase 8
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS WRITER IS WHAT MAKES `chart-of-accounts` REACHABLE, AND
 *    NOTHING ELSE DOES
 * ══════════════════════════════════════════════════════════════════════
 * `server/import/writers/registry.ts` is a `Record` over the destination
 * union, so adding `"ledgers"` to `ImportTableKey` without this file is a
 * compile error naming the registry. That is the guard Phase 1 built and
 * it is the reason this phase could not do what the brief warns about —
 * *"do not skip step 8 and register anyway"* — even by accident.
 *
 * ⚠️ IT DOES NOT CALL `createLedger`, AND THAT IS NOT A SHORTCUT.
 * `server/actions/accounting.ts` exports a server ACTION: it calls
 * `requireRole`, `requireAccess`, `requireFeature` and `revalidatePath`,
 * every one of which the import path has already done once for the whole
 * file rather than a thousand times per row. What must not be skipped is
 * the SCHEMA, and it is not: `planImportRecords` parses every row through
 * `createLedgerSchema` — the same object `createLedger` parses — before
 * this file sees a payload.
 *
 * 🔴 ONE RULE IN THAT ACTION IS NOT IN THE SCHEMA AND IS REPRODUCED HERE
 *    BY CALLING THE SAME LINE OF REASONING: trust and escrow ledgers hold
 *    client money and are forced to require reconciliation. Leaving it
 *    out would mean an imported trust account is the one trust account in
 *    the workspace nobody reconciles. See `applyTrustRule`.
 */

import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { ledgers } from "@/db/schema";
import { describeWriteFailure } from "../shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "../types";

/**
 * ⚠️ THE ONE BUSINESS RULE `createLedgerSchema` CANNOT CARRY.
 *
 * `createLedger` computes it as
 * `data.type === "trust" || data.type === "escrow" || data.requiresReconciliation`
 * and the schema cannot, because it is a rule ACROSS two fields whose
 * result overrides one of them — a `.superRefine()` can refuse a
 * combination but cannot rewrite a value. Both write paths must apply it
 * or the import becomes the way to create an unreconciled trust ledger.
 *
 * 🔴 IT IS A FUNCTION AND NOT AN INLINE EXPRESSION so that the next
 *    reader can find every place the rule is applied by searching for its
 *    name, which is the property the original inline version did not have.
 */
function applyTrustRule(
  type: "operating" | "trust" | "escrow" | "retention" | "suspense",
  requested: boolean,
): boolean {
  return type === "trust" || type === "escrow" || requested;
}

async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const codes = Array.from(
    new Set(keys.filter((k) => k.kind === "accountCode").map((k) => k.value)),
  );
  /*
   * ⚠️ AN EMPTY LIST NEVER REACHES `inArray`. Drizzle turns
   * `inArray(x, [])` into something that is not the refusal anybody
   * expects, and the consequence here would be reading the whole chart of
   * accounts and reporting every row of the file as an update.
   */
  if (codes.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: ledgers.id, code: ledgers.code })
      .from(ledgers)
      .where(
        and(
          /*
           * The tenant predicate is written even though RLS enforces it
           * independently. Relying on a single layer is how single layers
           * become the only layer.
           */
          eq(ledgers.tenantId, ctx.tenant.id),
          /*
           * ⚠️ SOFT-DELETED ACCOUNTS ARE NOT MATCHES, and the partial
           * unique index agrees: `ledgers_tenant_code_unique` is
           * `WHERE deleted_at IS NULL`. Treating a deleted account as an
           * existing one would make `skip` discard a row the database
           * would have accepted — the customer's deleted account stays
           * deleted and no new one is created, silently.
           *
           * ⚠️ INACTIVE ONES DO MATCH, which is the opposite decision and
           * a deliberate one. `is_active = false` is a retired account
           * that still holds history; a re-import must not create a
           * second account with the same code beside it, and the unique
           * index would refuse that anyway.
           */
          isNull(ledgers.deletedAt),
          /*
           * ⚠️ NO `lower()` ON EITHER SIDE, unlike the `companies`
           * writer. The index this must agree with is on the raw column
           * and `createLedger` compares raw. See the natural key's own
           * note in `entities-accounting.ts`.
           */
          inArray(ledgers.code, codes),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    const key = `accountCode:${row.code}`;
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
    const type =
      (payload.type as "operating" | "trust" | "escrow" | "retention" | "suspense" | undefined) ??
      "operating";

    /*
     * ⚠️ `bankDetails` IS WRITTEN ONLY WHEN THE PAYLOAD CARRIES IT.
     *
     * 🔴 AND THE PAYLOAD CARRIES IT ONLY WHEN A BANK COLUMN WAS FILLED —
     *    see `buildPayload`. Both halves are needed. `createLedgerSchema`
     *    gives `bankDetails` a `.default({})`, so by the time a parsed
     *    payload reaches here the key EXISTS and is `{}` even for a file
     *    with no bank columns at all. Writing that on an update would
     *    erase the IFSC and account number already on the ledger —
     *    digits a payment is made against — because the customer
     *    re-uploaded a file that never mentioned them.
     *
     *    So the emptiness is tested here rather than the key's presence.
     */
    const bank = payload.bankDetails as Record<string, string> | undefined;
    const hasBank = !!bank && Object.keys(bank).length > 0;

    const values = {
      name: String(payload.name ?? ""),
      code: String(payload.code ?? ""),
      description: (payload.description as string | null) ?? null,
      type,
      accountType: payload.accountType as (typeof ledgers.$inferInsert)["accountType"],
      currency: (payload.currency as string | undefined) ?? "INR",
      requiresReconciliation: applyTrustRule(
        type,
        (payload.requiresReconciliation as boolean | undefined) ?? false,
      ),
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        await tx
          .update(ledgers)
          .set({
            ...values,
            ...(hasBank ? { bankDetails: bank } : {}),
            updatedAt: new Date(),
            /*
             * 🔴 `currentBalance` IS ABSENT AND MUST STAY ABSENT. It is
             * maintained by a database trigger on every posting and the
             * authoritative figure is `SUM(journal_entries)`. An importer
             * writing it would be an importer with an opinion about a
             * number it has not seen the journal for.
             */
          })
          .where(
            and(
              eq(ledgers.id, existingId),
              eq(ledgers.tenantId, ctx.tenant.id),
              isNull(ledgers.deletedAt),
            ),
          );
        return;
      }
      await tx.insert(ledgers).values({
        ...values,
        ...(hasBank ? { bankDetails: bank } : {}),
        tenantId: ctx.tenant.id,
        createdBy: ctx.user.id,
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const ledgersWriter: ImportWriter = {
  revalidatePath: "/accounting",
  findExisting,
  writeRow,
};
