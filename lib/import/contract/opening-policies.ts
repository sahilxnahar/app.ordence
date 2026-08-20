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
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 CHANGED BY PHASE 8, AND IT IS THE ONE EDIT IN THE MIGRATION
   *      THAT MOVES EVERY OTHER TRACK'S WAVE NUMBER.
   * ══════════════════════════════════════════════════════════════════
   * This member used to be `[]`, and argued: "the chart of accounts is not
   * imported , it is seeded when the workspace is created and edited in the
   * product, so expressing it as a dependency on an entity that does not
   * exist would put a permanent dangling key in the graph."
   *
   * 🔴 THE LAST CLAUSE IS THE ONE THAT EXPIRED. `chart-of-accounts` is an
   *    entity as of Phase 8, so the key is no longer dangling , and
   *    `checkImportContract()` refuses a dangling one by name, which is the
   *    guard that makes this edit safe to make at all.
   *
   * ⭐ THE COST OF NOT MAKING IT IS NOT COSMETIC. Every line of a trial
   * balance resolves `ledger_by_code` in the PREVIEW. With both entities in
   * one wave the planner is free to offer the trial balance first, and a
   * customer who took that order would see every line of a perfectly
   * correct file refused with "that account was not found" , which reads as
   * a problem with their data.
   *
   * ⚠️ THE EDGE IS `hard`, NOT `soft`. A soft edge says the rows succeed and
   * are less complete. These rows do not succeed: they fail, all of them,
   * one error each.
   *
   * ⚠️ AND NOTHING BEHIND IT MOVES, WHICH IS WORTH STATING BECAUSE THE
   * OBVIOUS EXPECTATION IS WRONG. `opening-customer-invoices` and
   * `opening-vendor-bills` depend on the trial balance SOFTLY, and only
   * hard edges constrain the order. Their hard edges are on `companies` and
   * `gst-parties`, still wave 0, so they stay in wave 1 rather than moving
   * to wave 2. Phase 8's first draft said wave 2 and the checker caught it.
   */
  dependsOn: [
    {
      entity: "chart-of-accounts",
      strength: "hard",
      because:
        "Every line of a trial balance names an account by its code, and a line " +
        "whose code is not already in your chart of accounts is refused before " +
        "anything is written. Load your chart of accounts first, or every line " +
        "comes back saying the account was not found.",
    },
  ],
  reversal: {
    kind: "reverse-entry",
    escapes:
      "The reversing entry is itself a posted transaction and stays in the ledger permanently. Undoing an opening balance leaves two entries visible, not none, because that is what a ledger does.",
    because:
      "`transactions` and `journal_entries` are append-only by design; the schema says so where `updatedAt` and `deletedAt` would have been. A posted entry is corrected by reversing it, which is an accounting act with its own date and its own audit trail. Deleting it would be a rewrite of history under a transaction somebody may already have reconciled against.",
  },
  provenance: {
    /**
     * 🔴 TWO TABLES, NOT ONE. PHASE 3'S FINDING 1, AND IT WAS RIGHT.
     *
     * This declared `["transactions"]` while `writeOpeningTrialBalance`
     * inserts into `transactions` AND one `journal_entries` row per
     * account. Provenance is what decides what a reversal can undo and
     * what a reconciliation can tie, so an undeclared destination is rows
     * that no undo will find and no reconciliation will count , while the
     * contract reads as complete.
     *
     * ⚠️ IT WAS NOT CAUGHT BY GATE 29, and that is worth saying. The gate
     * checks that `targets` includes the entity's own `table`. It cannot
     * know about a second table the writer reaches, because that is a fact
     * about code rather than about the declaration. Phase 3's dry-run
     * corpus found it by MEASURING which tables moved , which is the only
     * way it could have been found.
     */
    targets: ["transactions", "journal_entries"],
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
    /**
     * ══════════════════════════════════════════════════════════════════
     * 🔴 WAS `delete`. PHASE 2 ASKED THE DATABASE AND THE DATABASE SAID NO.
     * ══════════════════════════════════════════════════════════════════
     * `stock_movements` carries `trg_stock_ledger_append_only`, BEFORE
     * DELETE OR UPDATE, SECURITY DEFINER, with no condition on role or
     * session. Its first statement raises:
     *
     *   "Stock movements cannot be deleted. … To correct it, post a
     *    REVERSAL for the opposite quantity with reverses_movement_id = %"
     *
     * So the declared undo was not risky or lossy , it was REFUSED, every
     * time, for every role, and had been since the entity was written. The
     * old `escapes` sentence described in detail the consequences of a
     * deletion that cannot occur.
     *
     * ⚠️ CI GATE 29 PASSED AND ALWAYS WOULD HAVE. `checkImportContract()`
     * is pure , its header says so twice, and being pure is what lets the
     * wizard run it in a browser. A pure checker cannot ask `pg_trigger`
     * anything. The contract was internally coherent and externally false,
     * and only executing it against a real database could tell.
     *
     * ⭐ A SECOND, INDEPENDENT REASON. `trg_refresh_stock_balance` is AFTER
     * INSERT only, so even with the guard removed, deleting a movement
     * would leave `stock_balances` holding the opening quantity for ever ,
     * a balance no movement explains, which is the thing `stock_movements`
     * exists to make impossible.
     */
    kind: "reverse-entry",
    escapes:
      "The reversing movement stays in the stock ledger permanently. Undoing opening stock leaves two movements visible, the opening and its reversal, not none, because a stock history that can be rewritten is a stock history that proves nothing.",
    because:
      "`stock_movements` is append-only and the database enforces it: `trg_stock_ledger_append_only` refuses every DELETE and every UPDATE, for every role, and its own message names the remedy, post a reversal with `reverses_movement_id`. `delete` was declared here until Phase 2 asked the database; it would have been refused on the first row of every undo.",
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
