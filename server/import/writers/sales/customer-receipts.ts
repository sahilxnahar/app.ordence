/**
 * Ordence — writer: `customer_receipts`
 * Version: v1.85.0-alpha · Phase 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE FILE, ONE DESTINATION, REACHED ONLY THROUGH `IMPORT_WRITERS`
 * ══════════════════════════════════════════════════════════════════════
 * Phase 1 replaced four `entity.table === ...` dispatch chains with a
 * `Record` over the destination union, so a destination with no writer is
 * a compile error at the registry rather than a fall-through that wrote a
 * GST party. This file is the `customer_receipts` member of that record.
 * Adding `"customer_receipts"` to `ImportTableKey` without adding the
 * line in `registry.ts` does not compile — which is why both edits are
 * requested together in `PATCH-REQUEST-PHASE-5.md`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS WRITER POSTS NOTHING TO THE GENERAL LEDGER, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * `recordCustomerReceipt` in `server/actions/sales-invoices.ts` calls
 * `postCustomerReceipt` — Dr Bank, Dr TDS receivable, Cr Sundry Debtors —
 * and it is right to. THIS path does not, and the missing call is the
 * most important line in the file, so it is written down rather than left
 * to be noticed:
 *
 *   A receipt banked BEFORE the cutover is already inside two figures the
 *   opening trial balance carries — the bank balance it increased and the
 *   debtors balance it reduced. Posting it again would add it twice, and
 *   the balance sheet would still balance because the contra doubles too.
 *   Nothing would report an error, ever.
 *
 * `lib/import/opening-entities.ts` settled this for the whole product:
 * "SO EXACTLY ONE OF THEM POSTS, AND IT IS THE TRIAL BALANCE." An
 * imported receipt is sub-ledger detail, exactly as an opening customer
 * invoice is. `lib/import/entities-sales.ts` carries the same note where
 * the customer can read it.
 *
 * ⚠️ IF SOMEBODY EVER ADDS THE POSTING CALL HERE, they must also decide
 * what happens when the trial balance has already been loaded, and there
 * is no answer to that which does not depend on the order the customer
 * uploaded their files in.
 */

import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies, customerReceipts } from "@/db/schema";
import { recordReceiptSchema } from "@/lib/validators/sales-invoices";
import { matchAny, describeWriteFailure, minorOf } from "../shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "./../types";

/**
 * ⚠️ THE SAME NORMALISATION THE PURE LAYER USED, IN SQL.
 *
 * `lib/import/entities-sales.ts` folds the customer's name with
 * `.toLowerCase().replace(/\s+/g, " ")` when it builds the natural key.
 * This is that expression in Postgres, and the two have to agree exactly
 * or `findExisting` returns nothing and every re-run duplicates.
 *
 * ⚠️ `\\s` AND NOT `\s`. This is a template literal: `\s` collapses to a
 * bare `s`, and the pattern would strip the letter s out of every company
 * name before comparing. It matches nothing, silently — the same trap
 * `server/actions/import.ts` documents on its own company branch.
 */
const FOLDED_COMPANY_NAME = sql`lower(regexp_replace(${companies.name}, '\\s+', ' ', 'g'))`;

/**
 * Find receipts already in the workspace matching these natural keys.
 *
 * ⚠️ THE KEYS ARE COMPOSITES BUILT FROM THE CUSTOMER'S NAME, not from
 * `company_id`, because the pure layer computes them before the lookup
 * has resolved a uuid. So this joins `companies` and rebuilds the same
 * composite from the database side.
 *
 * ⚠️ A CANCELLED OR BOUNCED RECEIPT IS STILL A MATCH. It is the same
 * money — the row is kept precisely so the history survives — and
 * re-importing the file must not create a second copy of a payment
 * somebody already recorded and then marked as failed.
 */
async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const valuesOf = (kind: string) =>
    Array.from(new Set(keys.filter((k) => k.kind === kind).map((k) => k.value)));

  const referenced = valuesOf("reference");
  const unreferenced = valuesOf("unreferenced");
  if (referenced.length === 0 && unreferenced.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: customerReceipts.id,
        folded: sql<string>`${FOLDED_COMPANY_NAME}`,
        receivedOn: customerReceipts.receivedOn,
        amountMinor: customerReceipts.amountMinor,
        method: customerReceipts.method,
        instrumentRef: customerReceipts.instrumentRef,
      })
      .from(customerReceipts)
      .innerJoin(
        companies,
        and(
          eq(companies.id, customerReceipts.companyId),
          eq(companies.tenantId, ctx.tenant.id),
          isNull(companies.deletedAt),
        ),
      )
      .where(
        and(
          eq(customerReceipts.tenantId, ctx.tenant.id),
          /*
           * ⚠️ `matchAny` AND NOT `or(...)` DIRECTLY. An empty list must
           * become `false`, never `undefined` — Drizzle's `and()` drops
           * an `undefined` member, and a dropped predicate here turns
           * "find the receipts matching these keys" into "find every
           * receipt in the workspace", which under `skip` would report
           * every row of the file as already imported.
           */
          matchAny([
            referenced.length > 0
              ? inArray(
                  sql`(${FOLDED_COMPANY_NAME} || '|' || upper(${customerReceipts.instrumentRef}))`,
                  referenced,
                )
              : null,
            unreferenced.length > 0
              ? inArray(
                  sql`(${FOLDED_COMPANY_NAME} || '|' || ${customerReceipts.receivedOn}::text || '|' || ${customerReceipts.amountMinor}::text || '|' || ${customerReceipts.method}::text)`,
                  unreferenced,
                )
              : null,
          ]),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    if (row.instrumentRef && row.instrumentRef.trim() !== "") {
      const key = `reference:${row.folded}|${row.instrumentRef.toUpperCase()}`;
      if (!found.has(key)) found.set(key, row.id);
    }
    const weak = `unreferenced:${row.folded}|${row.receivedOn}|${row.amountMinor.toString()}|${row.method}`;
    if (!found.has(weak)) found.set(weak, row.id);
  }
  return found;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE NUMBER IS OURS TO INVENT, AND IT IS NOT A SERIES
 * ══════════════════════════════════════════════════════════════════════
 * `customer_receipts.receipt_number` is `NOT NULL` and unique per tenant,
 * and nothing in the imported file can supply it: `recordReceiptSchema`
 * has no such field because the product assigns it.
 *
 * ⚠️ AND THE PRODUCT ASSIGNS IT AS `RCP/` + `count(*) + 1`, WHICH THIS
 *    WRITER MUST NOT IMITATE. Two reasons, and the second is the one that
 *    costs a customer a failed write months later:
 *
 *    ① `count(*)` is not a reservation. Two imports running at once
 *       compute the same next number and one of them dies on
 *       `customer_receipts_number_tenant_key`.
 *    ② It counts rows rather than reading the highest number issued, so
 *       ANY deletion — including this entity's own undo — makes it hand
 *       out a number that has already been on a statement. See
 *       `TRACK-REPORT.md §5`; it is a pre-existing defect in
 *       `recordCustomerReceipt` and is reported rather than fixed here,
 *       because that function belongs to another track.
 *
 * ⭐ SO AN IMPORTED RECEIPT CARRIES A NUMBER THAT IS UNIQUE BY
 * CONSTRUCTION AND OBVIOUSLY NOT PART OF THE `RCP/` SERIES. Rule 46(b)'s
 * consecutive-series requirement is about tax invoices, not receipts, so
 * there is no numbering rule to break here — and a number that announces
 * where it came from is worth more on a statement than one that pretends
 * to be sequential. The same shape `raiseInvoiceFromOrder` uses for its
 * draft placeholder, and for the same reason.
 *
 * ⚠️ RE-RUN SAFETY DOES NOT DEPEND ON THIS VALUE. It comes from
 * `findExisting` matching the natural key before anything is written; the
 * number is an output, never a key.
 */
function importedReceiptNumber(): string {
  return `IMP-RCP/${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

async function writeRow(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<WriteOutcome> {
  try {
    /**
     * 🔴 THE FORM'S OWN SCHEMA, IN FULL, WITH THE RESOLVED `companyId`.
     *
     * The entity parsed `recordReceiptSchema.omit({ companyId: true })`,
     * because the file names the customer rather than identifying them.
     * The lookup has since written the uuid into the payload, so the
     * WHOLE schema — the object `recordCustomerReceipt` parses — is
     * applied here, before the insert. Nothing reaches this table that
     * the single-record form would have refused; the schema is applied in
     * two steps only because the identity is resolved between them.
     *
     * ⚠️ IT IS `.parse` AND NOT `.safeParse` INSIDE A `try`. A failure
     * here is a programming error in the entity, not a customer error,
     * and `describeWriteFailure` will say so rather than blaming the row
     * — but it must not be able to reach the insert.
     */
    const data = recordReceiptSchema.parse({
      companyId: payload.companyId,
      receivedOn: payload.receivedOn,
      amountMinor: payload.amountMinor,
      tdsCreditMinor: payload.tdsCreditMinor,
      method: payload.method,
      instrumentRef: payload.instrumentRef,
      bankRef: payload.bankRef,
      notes: payload.notes,
    });

    /**
     * 🔴 `existingId` CANNOT BE NON-NULL HERE, and this is not defensive
     *    clutter.
     *
     * The entity offers `duplicateModes: ["skip", "fail"]`, and
     * `server/actions/import.ts` passes an id only in `update` mode. If
     * one ever arrives, something upstream has started offering `update`
     * for this entity — at which point the contract's `reversal: delete`
     * has become an undo that deletes receipts the customer had before
     * the migration. Refusing the row is the only safe answer, and gate
     * 29 refusing the combination is the guard that should have caught
     * it first.
     */
    if (existingId !== null) {
      return {
        ok: false,
        error:
          "This receipt already exists and receipts cannot be overwritten by an import. " +
          "A receipt that did not arrive is bounced, not edited — that keeps the row and " +
          "releases what it settled.",
      };
    }

    await withTenant(ctx.tenant.id, async (tx) => {
      await tx.insert(customerReceipts).values({
        tenantId: ctx.tenant.id,
        receiptNumber: importedReceiptNumber(),
        companyId: data.companyId,
        receivedOn: data.receivedOn,
        /*
         * ⚠️ `minorOf`, NOT `BigInt(...)` AND CERTAINLY NOT `Number(...)`.
         * These are paise and routinely run past 2^53. `minorOf` is the
         * one place the coercion layer's digit string becomes a bigint.
         */
        amountMinor: minorOf(data.amountMinor),
        tdsCreditMinor: minorOf(data.tdsCreditMinor ?? "0"),
        /*
         * ⚠️ ZERO ALLOCATED, AND THAT IS THE POINT OF THE ENTITY. This
         * is money on account: what has already been applied to a
         * pre-cutover invoice is netted off `outstandingMinor` in the
         * opening invoice list, so importing it here as well would show
         * the customer their money twice.
         */
        allocatedMinor: 0n,
        method: data.method,
        /*
         * ⚠️ `cleared`, WHICH IS THE PRODUCT'S OWN DEFAULT. An imported
         * receipt is money that arrived before the cutover; if it had
         * bounced, it would not be in the file. `pending` would leave it
         * out of the roll-up trigger and show as money that has not
         * settled anything.
         */
        status: "cleared",
        instrumentRef: data.instrumentRef ?? null,
        bankRef: data.bankRef ?? null,
        notes: data.notes ?? null,
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      });
      /*
       * 🔴 NO `postCustomerReceipt` CALL. See the head of this file: the
       * opening trial balance is what carries the bank and the debtors,
       * and exactly one of the two may post.
       *
       * 🔴 NO `customer_receipt_allocations` INSERT EITHER. Allocating
       * would need a target table this entity's provenance does not
       * name, so the rows would be unattributable and an undo would
       * leave them behind, still driving the `received_minor` trigger in
       * `0049 §2` against an invoice whose payment no longer exists.
       */
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const customerReceiptsWriter: ImportWriter = {
  /**
   * ⚠️ THE CUSTOMER'S ACCOUNT IS WHERE AN IMPORTED RECEIPT SHOWS UP, and
   * `/invoices` is the page that lists money in — the same path
   * `recordCustomerReceipt` revalidates.
   */
  revalidatePath: "/invoices",
  findExisting,
  writeRow,
};
