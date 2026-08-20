/**
 * Ordence — ⭐⭐⭐ THE WRITER REGISTRY
 * Version: v1.85.0-alpha · Phase 1
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS `Record` IS THE ENTIRE POINT OF PHASE 1
 * ══════════════════════════════════════════════════════════════════════
 * It is keyed on `ImportTableKey`, the destination union. Adding a member
 * to that union without adding a writer here is a COMPILE ERROR, at this
 * line, naming the destination that is missing.
 *
 * ⚠️ WHAT IT REPLACED, AND WHY THAT WAS WORSE THAN ANYONE THOUGHT.
 * `server/actions/import.ts` used to dispatch on `entity.table` with `if`
 * chains in three places. An `if` chain has no exhaustiveness, so adding
 * a destination meant remembering all three, and nothing checked.
 *
 * 🔴 AND THE FINAL BRANCH WAS NOT AN `if`. `gst_parties` was simply the
 *    code after the last one, in BOTH `findExistingByNaturalKey` and
 *    `writeRow`. So an unhandled destination did not write nothing.
 *
 *    **It wrote a GST party.**
 *
 *    A `stock-items` entity that forgot its branch would have matched
 *    existing GST parties by natural key and inserted the customer's
 *    stock list into their tax master, reporting success.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THINGS THAT WOULD UNDO ALL OF THIS, AND MUST NEVER BE DONE HERE
 * ══════════════════════════════════════════════════════════════════════
 *   · `Record<string, ImportWriter>`      , any string compiles
 *   · `Partial<Record<...>>`              , omission compiles
 *   · an index signature                  , omission compiles
 *   · `const w = WRITERS[t]; if (!w) throw` as the ONLY guard
 *                                         , omission compiles, fails at 3am
 *
 * Each of those reproduces the fall-through this file exists to delete,
 * one level down. A runtime guard IN ADDITION is welcome; a runtime guard
 * INSTEAD is the defect.
 *
 * ⭐ CI gate 30, `scripts/check-writer-registry.mjs`, proves the property
 * by INDUCTION rather than by reading this file: it adds a sentinel
 * destination to the union, runs the real compiler, and requires the
 * build to fail naming this file, then restores it and requires a pass.
 *
 * ⚠️ THIS IS NOT A SECOND ALLOWLIST. `ALL_IMPORT_ENTITIES` remains the
 * one guard on reachability and `isImportEntityKey` remains membership in
 * it. This map is keyed by DESTINATION, not by entity key, and is reached
 * only after that guard has already passed. Nothing here can make an
 * entity importable.
 */

import "server-only";

import type { ImportTableKey } from "@/lib/import/types";
import type { ImportWriter } from "./types";

import { companiesWriter } from "./companies";
import { gstPartiesWriter } from "./gst-parties";
import { salesInvoicesWriter } from "./sales-invoices";
import { stockMovementsWriter } from "./stock-movements";
import { transactionsWriter } from "./transactions";
import { vendorLedgerEntriesWriter } from "./vendor-ledger-entries";

/*
 * ⭐⭐ PHASE 8 , the accounting and master-data destinations. Each lives in
 * `./accounting/`, Phase 8's own subdirectory; these three lines are the
 * only Phase-1 surface they touch, which is the whole point of the split.
 */
import { costCentresWriter } from "./accounting/cost-centres";
import { hsnSacCodesWriter } from "./accounting/hsn-sac-codes";
import { ledgersWriter } from "./accounting/ledgers";

/* ⭐⭐ PHASE 4 , CRM. */
import { contactsWriter } from "./crm/contacts";
import { leadsWriter } from "./crm/leads";

/* ⭐⭐ PHASE 7 , inventory. */
import { stockBatchesWriter } from "./inventory/stock-batches";
import { stockItemsWriter } from "./inventory/stock-items";
import { warehousesWriter } from "./inventory/warehouses";

/* ⭐⭐ PHASE 5 , sales. */
import { customerReceiptsWriter } from "./sales/customer-receipts";

/* ⭐⭐ PHASE 6 , purchases. */
import { purchaseInvoicesWriter } from "./purchases/purchase-invoices";
import { vendorsWriter } from "./purchases/vendors";

export const IMPORT_WRITERS: Record<ImportTableKey, ImportWriter> = {
  companies: companiesWriter,
  gst_parties: gstPartiesWriter,
  transactions: transactionsWriter,
  sales_invoices: salesInvoicesWriter,
  vendor_ledger_entries: vendorLedgerEntriesWriter,
  stock_movements: stockMovementsWriter,
  ledgers: ledgersWriter,
  cost_centres: costCentresWriter,
  hsn_sac_codes: hsnSacCodesWriter,
  contacts: contactsWriter,
  leads: leadsWriter,
  stock_items: stockItemsWriter,
  warehouses: warehousesWriter,
  stock_batches: stockBatchesWriter,
  customer_receipts: customerReceiptsWriter,
  vendors: vendorsWriter,
  purchase_invoices: purchaseInvoicesWriter,
};

/**
 * ⚠️ EXACTLY ONE OF `writeRow` AND `writeFile`, CHECKED AT MODULE LOAD.
 *
 * A writer with both has two write paths and the second is the one nobody
 * tests. A writer with neither compiles fine and silently writes nothing
 * , which is the failure shape this whole phase exists to remove, so it
 * would be absurd to leave one instance of it in the registry itself.
 *
 * ⭐ AT MODULE LOAD, NOT ON FIRST USE. `next build` collects page data by
 * importing the modules a route reaches, so a malformed registry breaks
 * the BUILD rather than a customer's import. That is the same mechanism
 * that caught the v1.84.0 scheduler defect, and it is the earliest point
 * at which this can be caught at all.
 */
for (const [table, writer] of Object.entries(IMPORT_WRITERS)) {
  const hasRow = typeof writer.writeRow === "function";
  const hasFile = typeof writer.writeFile === "function";
  if (hasRow === hasFile) {
    throw new Error(
      `Import writer for "${table}" declares ${hasRow ? "BOTH writeRow and writeFile" : "NEITHER writeRow nor writeFile"}. ` +
        `Exactly one is required: writeRow for a destination written one row at a time, ` +
        `writeFile for one written as a single document for the whole file (the opening trial balance).`,
    );
  }
}
