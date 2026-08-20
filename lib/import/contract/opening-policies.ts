/**
 * Ordence — ⭐⭐ THE MIGRATION CONTRACT FOR THE OPENING-BALANCE ENTITIES
 * Version: v1.84.0-alpha · Track M1
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THESE FOUR CONTRACTS LIVE HERE AND NOT NEXT TO THEIR ENTITIES
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/opening-entities.ts` is owned by another track. Track M1
 * owns the contract and may not edit that file, and the honest options
 * were three:
 *
 *   ① Make `contract` optional. Rejected. An optional reversal policy is
 *      an undo that silently does nothing for the entities that omitted
 *      it, while the run report says "reversed". That is precisely the
 *      declared-and-unenforced defect this codebase keeps producing.
 *
 *   ② Ship the tree red and file a patch request. Rejected. Six tracks
 *      are waiting on this contract; a tree that does not typecheck
 *      blocks all six for the sake of a mechanical edit.
 *
 *   ③ Declare the four contracts in a file this track DOES own and merge
 *      them where the single allowlist is assembled. Chosen.
 *
 * 🔴 AND ③ IS ONLY ACCEPTABLE BECAUSE IT IS NOT A SECOND REGISTRY. This
 *    map is never consulted on the write path. It cannot make an entity
 *    REACHABLE — an entity key absent from `ALL_IMPORT_ENTITIES` and
 *    present here resolves to nothing at all. It decorates entities that
 *    already exist and it is checked against the allowlist by
 *    `checkImportContract()`, which refuses a decoration with no entity
 *    and an entity with no decoration alike.
 *
 * ⚠️ THIS FILE SHOULD NOT SURVIVE. Once the owning track folds these
 * five objects into their own definitions, delete it. `PATCH-REQUEST-M1.md`
 * carries them as paste-ready blocks for exactly that purpose.
 */

import type { ImportContract } from "../types";

/* ------------------------------------------------------------------ */
/* OPENING TRIAL BALANCE                                               */
/* ------------------------------------------------------------------ */

const openingTrialBalance: ImportContract = {
  /**
   * ⚠️ NOTHING. And it is a decision, not an oversight.
   *
   * A trial balance names ACCOUNT CODES, and the chart of accounts is
   * not imported — it is seeded when the workspace is created and edited
   * in the product. So the file's prerequisite is a setup step rather
   * than another import, and expressing it as a dependency on an entity
   * that does not exist would put a permanent dangling key in the graph.
   *
   * ⭐ THE TRIAL BALANCE IS THE FIRST WAVE OF EVERY MIGRATION for exactly
   * this reason: it is the control total the other three are measured
   * against, and it depends on nothing.
   */
  dependsOn: [],
  reversal: {
    kind: "reverse-entry",
    escapes:
      "The reversing entry is itself a posted transaction and stays in the ledger permanently. Undoing an opening balance leaves two entries visible, not none, because that is what a ledger does.",
    because:
      "`transactions` and `journal_entries` are append-only by design; the schema says so where `updatedAt` and `deletedAt` would have been. A posted entry is corrected by reversing it, which is an accounting act with its own date and its own audit trail. Deleting it would be a rewrite of history under a transaction somebody may already have reconciled against.",
  },
  provenance: {
    targets: ["transactions"],
    /**
     * ⭐ `whole-file`, AND THIS IS THE MEMBER THAT STOPS TRACK M8 FROM
     * RAISING A FALSE ALARM. An opening trial balance of forty lines
     * writes ONE document. A reconciliation that expected one output row
     * per input row would report thirty-nine missing rows on a perfectly
     * correct import, every time.
     */
    cardinality: "whole-file",
  },
  requiredness: {
    /**
     * ⚠️ EMPTY, AND CHECKED RATHER THAN ASSUMED. Every field a trial
     * balance line structurally needs is already refused by
     * `openingTrialBalanceRowSchema` — an account code and an amount on
     * exactly one side. Restating them here would be a second copy of a
     * rule, and the two copies would disagree the first time the schema
     * moved.
     */
    structural: [],
    messages: {},
  },
  duplicateDecision: {
    recommended: "fail",
    because:
      "An opening position posted twice doubles the books, and the account codes are identical both times, so the second posting looks entirely reasonable. `fail` makes the second attempt stop and say so. `skip` is offered for the customer who is deliberately re-running after a partial failure.",
  },
};

/* ------------------------------------------------------------------ */
/* OPENING CUSTOMER INVOICES                                           */
/* ------------------------------------------------------------------ */

const openingCustomerInvoices: ImportContract = {
  dependsOn: [
    {
      entity: "companies",
      strength: "hard",
      because:
        "Each unpaid invoice names the customer it is owed by. Load your customer list first, or every line comes back saying the customer was not found.",
    },
    {
      entity: "opening-trial-balance",
      strength: "soft",
      because:
        "Load the trial balance first if you have it. Its debtors total is what these invoices are checked against, and without it there is nothing to tie them to.",
    },
  ],
  reversal: {
    kind: "delete",
    escapes: null,
    because:
      "These rows did not exist before the run — an opening invoice is created, never matched onto an existing one, which is why `update` is not among the duplicate modes. Deleting the rows this run created restores the prior state exactly.",
  },
  provenance: { targets: ["sales_invoices"], cardinality: "one-to-one" },
  requiredness: {
    /**
     * 🔴 THE LOOKUP TARGET, AND THIS IS THE CASE THE WHOLE
     *    `requiredness` MEMBER EXISTS FOR. The Zod schema cannot refuse a
     *    missing `companyId`, because the schema runs BEFORE the lookup
     *    resolves and the field is legitimately absent at that moment.
     *    Without this declaration, an unresolvable customer becomes a
     *    foreign-key violation at write time — after the customer has
     *    read a preview that promised the rows would land.
     */
    structural: ["companyId"],
    messages: {
      companyId:
        "No customer in your workspace matched this invoice. Import your customer list first, or correct the spelling in this row.",
    },
  },
  duplicateDecision: {
    recommended: "skip",
    because:
      "A re-run after a partial failure is the normal second action, and the file the customer re-uploads is usually the whole file. `skip` makes that safe. `fail` is there for the customer who wants to be told rather than to have it handled quietly.",
  },
};

/* ------------------------------------------------------------------ */
/* OPENING VENDOR BILLS                                                */
/* ------------------------------------------------------------------ */

const openingVendorBills: ImportContract = {
  dependsOn: [
    {
      entity: "gst-parties",
      strength: "hard",
      because:
        "Each unpaid bill names the supplier it is owed to. Load your supplier list first, or every line comes back saying the supplier was not found.",
    },
    {
      entity: "opening-trial-balance",
      strength: "soft",
      because:
        "Load the trial balance first if you have it. Its creditors total is what these bills are checked against.",
    },
  ],
  reversal: {
    kind: "delete",
    escapes: null,
    because:
      "Same as opening customer invoices: the row is created by the run and matched onto nothing, so removing it restores the prior state exactly.",
  },
  provenance: { targets: ["vendor_ledger_entries"], cardinality: "one-to-one" },
  requiredness: {
    structural: ["vendorId"],
    messages: {
      vendorId:
        "No supplier in your workspace matched this bill. Import your supplier list first, or correct the code in this row.",
    },
  },
  duplicateDecision: {
    recommended: "skip",
    because:
      "As for opening customer invoices — a re-run of the whole file after fixing a handful of rows must not double the creditors.",
  },
};

/* ------------------------------------------------------------------ */
/* OPENING STOCK                                                       */
/* ------------------------------------------------------------------ */

const openingStock: ImportContract = {
  dependsOn: [
    {
      entity: "opening-trial-balance",
      strength: "soft",
      because:
        "Load the trial balance first if you have it. Its stock value is what the opening quantities are checked against.",
    },
  ],
  reversal: {
    kind: "delete",
    escapes:
      "Deleting an opening stock movement changes the current quantity on hand for that item. If anything has been sold or received since the import, the resulting balance is correct but the movement history has a gap where the opening sat.",
    because:
      "`stock_movements` rows created by this run did not exist before it. It is not an append-only ledger in the accounting sense — but the escape above is real and the customer is told before the run, not after.",
  },
  provenance: { targets: ["stock_movements"], cardinality: "one-to-one" },
  requiredness: {
    /**
     * ⚠️ TWO LOOKUP TARGETS, AND BOTH ARE STRUCTURAL. A stock movement
     * with no item is not a movement, and one with no warehouse is a
     * quantity nobody can find.
     */
    structural: ["stockItemId", "warehouseId"],
    messages: {
      stockItemId:
        "No stock item in your workspace matched this SKU. Check the code, or add the item first.",
      warehouseId:
        "No warehouse in your workspace matched this code. Check the code, or add the warehouse first.",
    },
  },
  duplicateDecision: {
    recommended: "skip",
    because:
      "Opening stock posted twice doubles the quantity on hand, and the second posting looks identical to the first. `skip` makes the whole-file re-run safe.",
  },
};

/**
 * ⚠️ KEYED BY THE SAME STRINGS `OPENING_IMPORT_ENTITIES` USES. A key
 * here that names no entity is caught by `checkImportContract()` rather
 * than silently doing nothing, which is the only reason it is safe for
 * this map to live apart from the definitions it decorates.
 */
export const OPENING_CONTRACTS = {
  "opening-trial-balance": openingTrialBalance,
  "opening-customer-invoices": openingCustomerInvoices,
  "opening-vendor-bills": openingVendorBills,
  "opening-stock": openingStock,
} as const satisfies Record<string, ImportContract>;
