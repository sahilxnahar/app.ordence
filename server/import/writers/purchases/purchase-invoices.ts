/**
 * Ordence — writer: `purchase_invoices`
 * Version: v1.85.0-alpha · Phase 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS WRITER DOES NOT WRITE. IT CALLS `recordPurchaseInvoice`.
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THAT IS THE MOST IMPORTANT DECISION IN PHASE 6 AND IT DESERVES THE
 *    ARGUMENT IN FULL, BECAUSE THE OBVIOUS ALTERNATIVE LOOKS CHEAPER AND
 *    IS NOT.
 *
 * Recording one purchase bill is not an insert. It is, in one
 * transaction (`server/actions/purchases.ts:390`):
 *
 *   ① a duplicate check against `purchase_invoices_no_duplicate_bill`;
 *   ② `pricePurchase` — which resolves the issuing registration, decides
 *      the place of supply under Section 12(3), resolves the HSN/SAC
 *      against the rate master AS AT THE BILL'S OWN DATE, and runs
 *      `determineItcEligibility` per line for Section 17(5);
 *   ③ the header, whose `purchase_invoices_totals_balance` and
 *      `purchase_invoices_itc_splits_exactly` CHECK constraints must
 *      foot exactly;
 *   ④ the lines, past the `purchase_invoice_lines_gst_recomputes`
 *      trigger (SQL 0147);
 *   ⑤ the `vendor_ledger_entries` credit, EXCLUDING reverse-charge tax,
 *      because under 9(3)/9(4) the supplier never charged it and
 *      crediting it would make the payment run pay the vendor the
 *      Government's money;
 *   ⑥ `recognisePurchaseInvoice` — AS 11 ¶9 initial recognition, which
 *      fills `functional_total_minor` and without which the FIRST
 *      reporting-date restatement books the WHOLE bill as an exchange
 *      difference in the P&L;
 *   ⑦ the journal, through the posting engine, never blocking the record.
 *
 * ⚠️ A WRITER THAT REIMPLEMENTED THAT WOULD BE A SECOND MODEL OF THE
 *    PRODUCT'S MOST RULE-DENSE WRITE PATH. `lib/import/types.ts` insists
 *    the import validate through the schema the form uses because "an
 *    import that validates differently from the form is an import that
 *    writes rows the form would have refused". Every word of that
 *    applies with more force to the WRITE than to the validation, and
 *    `scripts/check-import-contract.mjs` says this repository "has been
 *    bitten four times by a second drifting model of its own code".
 *
 * ⭐ SO THE IMPORT GOES THROUGH THE FRONT DOOR, LITERALLY: the same
 *    function the form calls, with the same guard, the same audit row
 *    and the same ITC determination. The import cannot drift from the
 *    form because there is nothing to drift.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IT COSTS, STATED RATHER THAN DISCOVERED
 * ══════════════════════════════════════════════════════════════════════
 *   · `guardPurchaseWrite` runs per row. The import has already guarded
 *     (`guardImport`, on this entity's `feature` and `createPermission`,
 *     which are deliberately the SAME two keys), so this is a repeat,
 *     not a gap — a second permission read per bill, and no import can
 *     reach a permission the interactive path could not.
 *   · `revalidatePath("/purchases/invoices")` runs per row. Wasteful and
 *     harmless; `runImport` revalidates once more at the end.
 *   · The bill is written in ITS OWN transaction, not the import's.
 *     There is no import-wide transaction to join — `performWrites` in
 *     `server/actions/import.ts` writes row by row for every non-atomic
 *     entity — so this changes nothing about atomicity. It is stated
 *     because "the import is one transaction" is a thing people assume.
 *
 * ⚠️ AND `existingId` IS ALWAYS NULL HERE, WHICH IS CHECKED RATHER THAN
 *    ASSUMED. `purchase-bills` offers only `skip` and `fail`, so
 *    `runImport` never reaches the write with a matched row. If that
 *    ever changes, the guard below refuses loudly instead of silently
 *    inserting a duplicate that the database would then refuse with a
 *    constraint name.
 */

import "server-only";

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { purchaseInvoices, vendors } from "@/db/schema";
import { recordPurchaseInvoice } from "@/server/actions/purchases";
import { financialYearOf } from "@/lib/gst/constants";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "./../types";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MATCH IS THE UNIQUE INDEX, EXPRESSION FOR EXPRESSION.
 * ══════════════════════════════════════════════════════════════════════
 * `SQL-FILES/0023_phase33_purchases.sql:539`:
 *
 *   UNIQUE (tenant_id, vendor_id, upper(btrim(invoice_number)),
 *           indian_financial_year(invoice_date))
 *   WHERE status <> 'cancelled'
 *
 * and the composite this builds is
 * `lower(vendors.code) || '|' || upper(btrim(invoice_number)) || '|' ||
 * indian_financial_year(invoice_date)`, which is the same identity with
 * the vendor named by its code rather than its id — because the pure
 * layer has only the code. `naturalKey` in
 * `lib/import/entities-purchases.ts` builds the identical string in
 * TypeScript using `financialYearOf`, which produces the same `2024-25`
 * spelling as `indian_financial_year`.
 *
 * 🔴 IF THOSE TWO EVER DIVERGE, RE-RUN SAFETY DIES SILENTLY: this finds
 *    nothing, every row is planned as a create, and the database refuses
 *    each one with `23505`. SQL 0240 in this phase proves the index
 *    still refuses by attempting the write, and the unit test in
 *    `tests/import/purchases.test.ts` proves the TypeScript half builds
 *    the string the SQL half expects.
 *
 * ⚠️ `status <> 'cancelled'` IS MIRRORED HERE, AND LEAVING IT OUT WOULD
 *    BE THE SUBTLE BUG. A bill somebody cancelled does not occupy its
 *    number as far as the index is concerned, so it can be entered
 *    again. Matching it would make the importer report "already there,
 *    skipped" for a bill the customer deliberately voided and is now
 *    re-entering — and the preview would say so, and the customer would
 *    believe it.
 *
 * ⚠️ `btrim` ON THE DATABASE SIDE AND `.trim()` ON OURS. `btrim` with no
 *    second argument strips spaces, tabs, newlines and carriage returns
 *    exactly as JavaScript's `trim()` does for those characters. A bill
 *    number with a trailing space — which is most of them, out of a
 *    spreadsheet — must match the one without.
 */
async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const composites = Array.from(
    new Set(keys.filter((k) => k.kind === "vendorBillFy").map((k) => k.value)),
  );
  if (composites.length === 0) return found;

  const identity = sql`(
    lower(${vendors.code}) || '|' ||
    upper(btrim(${purchaseInvoices.invoiceNumber})) || '|' ||
    indian_financial_year(${purchaseInvoices.invoiceDate})
  )`;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: purchaseInvoices.id,
        code: vendors.code,
        number: purchaseInvoices.invoiceNumber,
        date: purchaseInvoices.invoiceDate,
      })
      .from(purchaseInvoices)
      .innerJoin(
        vendors,
        and(
          eq(vendors.id, purchaseInvoices.vendorId),
          /*
           * ⚠️ THE JOIN CARRIES THE TENANT TOO. `purchase_invoices.
           * vendor_id` is a COMPOSITE foreign key onto `(id, tenant_id)`
           * — `db/schema/purchases.ts:607` says so and SQL 0023 line 661
           * adds `purchase_invoices_vendor_same_tenant` for it. Joining
           * on the id alone would be a join the schema deliberately does
           * not permit, and under FORCE RLS it would quietly return
           * nothing rather than the wrong thing — which is the safe
           * direction and still a bug, because "nothing" here means
           * "every bill looks new".
           */
          eq(vendors.tenantId, purchaseInvoices.tenantId),
        ),
      )
      .where(
        and(
          eq(purchaseInvoices.tenantId, ctx.tenant.id),
          ne(purchaseInvoices.status, "cancelled"),
          inArray(identity, composites),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    /*
     * ⚠️ THE KEY IS REBUILT FROM THE ROW IN TYPESCRIPT, NOT SELECTED AS
     * THE COMPOSITE. Selecting the expression would let the SQL's answer
     * and the pure layer's answer differ without anything noticing;
     * rebuilding it here means the map's keys are produced by the same
     * two lines of TypeScript that produced the ones being looked up —
     * including `financialYearOf`, the ONE place in this product that
     * decides where 1 April falls, which is also what
     * `lib/import/entities-purchases.ts` calls. The SQL expression's
     * only job is to narrow the rows fetched.
     */
    const year = financialYearOf(row.date);
    const key = `vendorBillFy:${row.code.toLowerCase()}|${row.number.trim().toUpperCase()}|${year}`;
    if (!found.has(key)) found.set(key, row.id);
  }
  return found;
}

async function writeRow(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<WriteOutcome> {
  if (existingId !== null) {
    /*
     * 🔴 UNREACHABLE TODAY AND REFUSED ANYWAY. `purchase-bills` declares
     *    `duplicateModes: ["skip", "fail"]`, so `runImport` disposes of
     *    a matched row before the write. If somebody adds `update` to
     *    that list, gate 29 will refuse it first (`update` with
     *    `reverse-entry` is refused by name) — and if both were somehow
     *    changed together, this is the third guard, and it refuses with
     *    a sentence rather than inserting a bill the database would
     *    reject with a constraint name.
     */
    return {
      ok: false,
      error:
        "This bill already exists and a recorded bill cannot be overwritten. " +
        "A posted bill is corrected by reversing it and entering a new one, " +
        "which is an accounting act with its own audit trail.",
    };
  }

  /*
   * 🔴 THE SECOND GUARD ON THE PLACEHOLDER. `importPurchaseBillSchema`
   *    DELETES the sentinel `vendorId` it fed the form's schema, so the
   *    only thing that can put one back is `resolveLookups` writing the
   *    resolved uuid into `into: "vendorId"`. If that lookup is ever
   *    renamed, removed, or misspelled, the payload arrives here with no
   *    vendor — and `recordPurchaseInvoice` would fail on `uuid` parse
   *    with a message about a string, on every row, which reads as a
   *    framework bug rather than as what it is.
   *
   * ⚠️ `requiredness.structural` NAMES `vendorId` FOR THE SAME REASON,
   *    and that is where the customer-facing sentence lives. This is the
   *    developer-facing one, and it exists because the two failures have
   *    different audiences: a row whose vendor code did not match is the
   *    customer's problem, and a payload with no `vendorId` field at all
   *    is ours.
   */
  const vendorId = payload.vendorId;
  if (typeof vendorId !== "string" || vendorId === "") {
    return {
      ok: false,
      error:
        "This bill reached the write with no vendor attached. That is not a " +
        "problem with your file — the vendor code lookup did not run. Nothing " +
        "was written.",
    };
  }

  /*
   * ⚠️ THE PAYLOAD IS PASSED WHOLE AND `recordPurchaseInvoice` PARSES IT
   * AGAIN. That second parse is not waste: it is the same
   * `recordPurchaseInvoiceSchema` the preview already ran through the
   * delegating schema, and re-running it here means the write is guarded
   * by the schema even if a future change to `buildPayload` stops
   * producing the shape the delegate checked. A write that trusts its
   * caller is a write with no rules on it.
   */
  const result = await recordPurchaseInvoice(payload);

  if (!result.ok) {
    /*
     * ⚠️ THE ACTION'S OWN SENTENCE, PASSED THROUGH. `recordPurchaseInvoice`
     * returns the duplicate-bill explanation, `pricePurchase`'s "that
     * vendor is blocked" and the database's CHECK-constraint messages —
     * all written to be read by the person holding the bill. Replacing
     * them with a generic string is what `shared.ts:describeWriteFailure`
     * argues against at length, and it applies here too.
     */
    return { ok: false, error: result.error };
  }

  return { ok: true };
}

export const purchaseInvoicesWriter: ImportWriter = {
  revalidatePath: "/purchases/invoices",
  findExisting,
  writeRow,
};
