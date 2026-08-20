# PATCH-REQUEST-PHASE-8.md

Phase 8 — accounting and master data. Build **v1.85.0-alpha**.

Everything below is a change in a file **Phase 8 does not own**. Nothing here
was invented for convenience: each item is something the delivered files
cannot compile or cannot be reached without, and each says which.

They were all applied to a local copy of v1.85.0-alpha and the whole tree was
re-verified with the assembled result — `npx tsc --noEmit` clean,
`npm run gates:static` 28/28, `check:import-contract` 9 entities in 2 waves,
`check:writer-registry` green by induction, and an 18-assertion suite against a
real PostgreSQL. The commands and their output are in `TRACK-REPORT.md`.

**Apply them in the order below.** Item 1 is the one that changes the product's
load order and it is the one to argue about; items 2 and 3 are moves that must
land before item 4 will compile.

---

## ⚠️ ITEM 0 — READ FIRST: `scripts/track-ownership.json` DOES NOT MERGE AS SHIPPED

`track-ownership-phases.json` ships with the instruction *"Merge these into
scripts/track-ownership.json."* **Merging it as written makes the ownership gate
refuse its own map with 23 violations**, and the gate is not wrong.

Verified:

```
$ python3 -c "merge track-ownership-phases.json into scripts/track-ownership.json"
$ npm run check:track-ownership
check:track-ownership , violations:

  x tracks M2 and PHASE-1 both claim: "server/import/**" vs "server/import/writers/**"
  x tracks M2 and PHASE-1 have overlapping SQL blocks: 200-206 and 200-204
  x tracks M2 and PHASE-2 both claim: "db/schema/import-runs.ts" vs "db/schema/import-runs.ts"
  x tracks M2 and PHASE-2 have overlapping SQL blocks: 200-206 and 205-214
  x tracks M6 and PHASE-9 both claim: "lib/import/sources/**" vs "lib/import/sources/**"
  x tracks M7 and PHASE-3 both claim: "server/import/dryrun.ts" vs "server/import/dryrun.ts"
  ... 23 violation(s).
```

The full list is in `TRACK-REPORT.md` §7.

**The cause is not a typo.** Wave 19's tracks M1–M8 and phases 1–10 are two
descriptions of the same work: M2 "Import ledger" is PHASE-2 "Run ledger,
idempotency, reversal"; M6 "Source adapters" is PHASE-9; M7's `dryrun.ts` is
PHASE-3's. Both sets are in the map at once and the map's own consistency check
is what says so.

**This is integration's decision and Phase 8 does not make it.** The likely
answer is that M1–M8 are RETIRED as phases 1–10 land, with one exception worth
naming: **M1's paths have no phase equivalent** — `lib/import/types.ts`,
`plan.ts`, `contract/**` — and `track-ownership-phases.json` says in its own
comment that `lib/import/entities.ts` is *"NOT owned by any phase"*. Deleting
M1 without rehoming those leaves four files this migration edits every week
owned by nobody.

**What Phase 8 needs is one line**, and it is much smaller than the merge:
`PHASE-1` owns `server/import/writers/**` by glob, which swallows
`server/import/writers/accounting/**`. The shipped file's own comment asks for
the fix — *"PHASE-1 must exclude those subdirectories once they exist"* — and it
does not carry it. Add to `PHASE-1` (and, while M2 remains in the map, to `M2`):

```json
"excludes": [
  "server/import/writers/crm/**",
  "server/import/writers/sales/**",
  "server/import/writers/purchases/**",
  "server/import/writers/inventory/**",
  "server/import/writers/accounting/**"
]
```

With that and `PHASE-8` present, the delivery is provably in bounds:

```
$ node scripts/check-track-ownership.mjs --track PHASE-8 --files /tmp/p8-files.txt
OK track PHASE-8: 6 delivered files, all inside its block
```

---

## 🔴🔴 ITEM 1 — THE KEYSTONE: the trial balance now depends on the chart of accounts

**File:** `lib/import/contract/opening-policies.ts` (Track M1)
**This is the one change in the whole migration that moves another track's wave
number, and it should not be applied without somebody reading it.**

`opening-trial-balance` declares `dependsOn: []` and M1 argues the case:

> *"A trial balance names ACCOUNT CODES, and the chart of accounts is not
> imported — it is seeded when the workspace is created and edited in the
> product. So the file's prerequisite is a setup step rather than another
> import, and expressing it as a dependency on an entity that does not exist
> would put a permanent dangling key in the graph."*

**The last clause is the one that expired.** `chart-of-accounts` is an entity as
of this phase, so the key is no longer dangling — and `checkImportContract()`
refuses a dangling one by name, which is the guard that makes this edit safe.

The cost of NOT applying it is not cosmetic and is proven in
`tests/security/import-accounting.test.ts` §7: an opening trial balance naming an
account that is not yet in the workspace is refused **in the preview**, every
line, about a file that is perfectly correct. With both entities in one wave the
planner is free to offer the trial balance first.

**What it does to the waves — measured, not reasoned:**

```
BEFORE   wave 0: companies, gst-parties, opening-stock, opening-trial-balance
         wave 1: opening-customer-invoices, opening-vendor-bills

AFTER    wave 0: chart-of-accounts, companies, cost-centres, gst-parties,
                 opening-stock, tax-codes
         wave 1: opening-customer-invoices, opening-trial-balance,
                 opening-vendor-bills
```

⚠️ **Note what did NOT move, because the obvious expectation is wrong.**
`opening-customer-invoices` and `opening-vendor-bills` depend on the trial
balance — but *softly*, and only `hard` edges constrain the order. Their hard
edges are on `companies` and `gst-parties`, still wave 0, so they stay in wave 1
rather than moving to wave 2. This was checked with
`npm run check:import-contract` rather than deduced; the first draft of this
patch request said "wave 2" and was wrong.

```diff
--- a/lib/import/contract/opening-policies.ts
+++ b/lib/import/contract/opening-policies.ts
@@ -42,19 +42,69 @@
 
 const openingTrialBalance: ImportContract = {
   /**
-   * ⚠️ NOTHING. And it is a decision, not an oversight.
+   * ══════════════════════════════════════════════════════════════════
+   * 🔴🔴 CHANGED BY PHASE 8, AND IT IS THE ONE EDIT IN THE MIGRATION
+   *      THAT MOVES EVERY OTHER TRACK'S WAVE NUMBER.
+   * ══════════════════════════════════════════════════════════════════
+   * ⚠️ WHAT THIS MEMBER USED TO SAY, AND WHY IT WAS RIGHT AT THE TIME:
    *
-   * A trial balance names ACCOUNT CODES, and the chart of accounts is
-   * not imported — it is seeded when the workspace is created and edited
-   * in the product. So the file's prerequisite is a setup step rather
-   * than another import, and expressing it as a dependency on an entity
-   * that does not exist would put a permanent dangling key in the graph.
-   *
-   * ⭐ THE TRIAL BALANCE IS THE FIRST WAVE OF EVERY MIGRATION for exactly
-   * this reason: it is the control total the other three are measured
-   * against, and it depends on nothing.
+   *     "NOTHING. And it is a decision, not an oversight. A trial
+   *      balance names ACCOUNT CODES, and the chart of accounts is not
+   *      imported — it is seeded when the workspace is created and
+   *      edited in the product. So the file's prerequisite is a setup
+   *      step rather than another import, and expressing it as a
+   *      dependency on an entity that does not exist would put a
+   *      permanent dangling key in the graph."
+   *
+   * 🔴 THE LAST CLAUSE IS THE ONE THAT EXPIRED. `chart-of-accounts` is
+   *    an entity as of Phase 8, so the dependency is no longer dangling
+   *    — and `checkImportContract()` would refuse it as a typo if it
+   *    were, which is the guard that makes this edit safe to make.
+   *
+   * ⭐ THE COST OF NOT MAKING IT IS NOT COSMETIC. Every line of a trial
+   * balance resolves `ledger_by_code` in the PREVIEW, and an unresolved
+   * lookup is a row error. With the two entities in one wave the planner
+   * would be free to offer the trial balance first, and a customer who
+   * took that order would see every line of a correct file refused with
+   * "that account was not found" — which reads as a problem with their
+   * data.
+   *
+   * ⚠️ AND THE EDGE IS `hard` RATHER THAN `soft` BECAUSE OF WHAT `soft`
+   * MEANS. A soft edge says the rows will succeed and be less complete.
+   * These rows do not succeed: they fail, all of them, one error each.
+   *
+   * ⭐ THE TRIAL BALANCE IS THEREFORE NO LONGER WAVE 0. It moves to
+   * wave 1, behind `chart-of-accounts`.
+   *
+   * ⚠️ AND NOTHING BEHIND IT MOVES, WHICH IS WORTH STATING BECAUSE THE
+   * OBVIOUS EXPECTATION IS WRONG. `opening-customer-invoices` and
+   * `opening-vendor-bills` do depend on the trial balance — but SOFTLY,
+   * and only `hard` edges constrain the order (see `resolveImportOrder`
+   * and `ImportDependency.strength`). Their hard edges are on
+   * `companies` and `gst-parties`, which are still wave 0, so they stay
+   * in wave 1 alongside the trial balance rather than moving to wave 2.
+   *
+   * Verified rather than reasoned: `npm run check:import-contract`
+   * prints the census, and it reads
+   *
+   *     wave 0: chart-of-accounts, companies, cost-centres, gst-parties,
+   *             opening-stock, tax-codes
+   *     wave 1: opening-customer-invoices, opening-trial-balance,
+   *             opening-vendor-bills
+   *
+   * It is the first thing integration should re-run after applying this.
    */
-  dependsOn: [],
+  dependsOn: [
+    {
+      entity: "chart-of-accounts",
+      strength: "hard",
+      because:
+        "Every line of a trial balance names an account by its code, and a line " +
+        "whose code is not already in your chart of accounts is refused before " +
+        "anything is written. Load your chart of accounts first, or every line " +
+        "comes back saying the account was not found.",
+    },
+  ],
   reversal: {
     kind: "reverse-entry",
     escapes:
```

---

## ITEM 2 — move `createLedgerSchema` where both callers can reach it

**Files:** `lib/validators/accounting.ts` and `server/actions/accounting.ts` (Track N)

`createLedgerSchema` was declared at `server/actions/accounting.ts:72` and
**could not have been exported**: that file is `"use server"`, and the reason is
stated at the top of `lib/validators/accounting.ts` itself — such a file may only
export async functions, and a schema exported from one is compiled into a
public RPC endpoint.

So the rule deciding what a ledger is had exactly one possible caller. The
chart-of-accounts importer is the second, and `lib/import/types.ts` forbids the
alternative by name: *"THE SAME SCHEMA THE SINGLE-RECORD SERVER ACTION PARSES.
NOT A COPY, NOT AN 'IMPORT VARIANT', NOT A LOOSER ONE."* An account is the one
record every later number in the product is classified by.

🔴 **It is a MOVE.** The original is deleted rather than left behind; two copies
starting identical is the only state in which nobody notices there are two.
No rule changed — the members, bounds and defaults are the ones that were there.

```diff
--- a/lib/validators/accounting.ts
+++ b/lib/validators/accounting.ts
@@ -189,3 +189,59 @@
   });
 
 export type PostTransactionInput = z.input<typeof postTransactionSchema>;
+
+/* ------------------------------------------------------------------ */
+/* ⭐⭐ PHASE 8 — THE CHART OF ACCOUNTS                                 */
+/* ------------------------------------------------------------------ */
+
+/**
+ * ══════════════════════════════════════════════════════════════════════
+ * 🔴 MOVED HERE FROM `server/actions/accounting.ts`. NOT COPIED.
+ * ══════════════════════════════════════════════════════════════════════
+ * This object was declared at `server/actions/accounting.ts:72` and was
+ * unreachable from anywhere else, for a reason that file states at its
+ * own top: **a `"use server"` file may only export async functions.** So
+ * the schema that decides what a ledger is could not be exported, and any
+ * other caller needing it had exactly two options — import a file that
+ * refuses to export it, or write a second one.
+ *
+ * ⚠️ THE SECOND OPTION IS THE ONE THE IMPORT FRAMEWORK FORBIDS BY NAME.
+ * `lib/import/types.ts` on `schema`: *"THE SAME SCHEMA THE SINGLE-RECORD
+ * SERVER ACTION PARSES. NOT A COPY, NOT AN 'IMPORT VARIANT', NOT A LOOSER
+ * ONE."* An import that validated a ledger differently from the form
+ * would be a way to create accounts the form refuses — and an account is
+ * the one record in this product that every later number is classified
+ * by. So the schema moved to where both callers can reach it, which is
+ * what the header of this file says schemas are for.
+ *
+ * 🔴 IT MOVED. `server/actions/accounting.ts` now imports it from here
+ *    and declares nothing. Leaving the original in place "for safety"
+ *    would be the two-copies outcome this move exists to prevent, with
+ *    the copies starting identical — which is the only state in which
+ *    nobody notices there are two.
+ */
+export const createLedgerSchema = z.object({
+  name: z.string().trim().min(1).max(200),
+  code: z
+    .string()
+    .trim()
+    .min(1)
+    .max(40)
+    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore."),
+  description: z.string().trim().max(1_000).optional(),
+  type: z.enum(["operating", "trust", "escrow", "retention", "suspense"]).default("operating"),
+  accountType: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
+  currency: z.string().length(3).default("INR"),
+  requiresReconciliation: z.boolean().default(false),
+  bankDetails: z
+    .object({
+      bankName: z.string().trim().max(200).optional(),
+      accountNumber: z.string().trim().max(40).optional(),
+      ifsc: z.string().trim().max(20).optional(),
+      branch: z.string().trim().max(200).optional(),
+      accountHolder: z.string().trim().max(200).optional(),
+    })
+    .default({}),
+});
+
+export type CreateLedgerInput = z.input<typeof createLedgerSchema>;
```

```diff
--- a/server/actions/accounting.ts
+++ b/server/actions/accounting.ts
@@ -42,6 +42,7 @@
 import type { ActionResult } from "@/lib/validators/crm";
 import {
   postTransactionSchema,
+  createLedgerSchema,
   toMinorUnits,
   fromMinorUnits,
 } from "@/lib/validators/accounting";
@@ -69,25 +70,17 @@
 
 export type { PostTransactionInput };
 
-const createLedgerSchema = z.object({
-  name: z.string().trim().min(1).max(200),
-  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore."),
-  description: z.string().trim().max(1_000).optional(),
-  type: z.enum(["operating", "trust", "escrow", "retention", "suspense"]).default("operating"),
-  accountType: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
-  currency: z.string().length(3).default("INR"),
-  requiresReconciliation: z.boolean().default(false),
-  bankDetails: z
-    .object({
-      bankName: z.string().trim().max(200).optional(),
-      accountNumber: z.string().trim().max(40).optional(),
-      ifsc: z.string().trim().max(20).optional(),
-      branch: z.string().trim().max(200).optional(),
-      accountHolder: z.string().trim().max(200).optional(),
-    })
-    .default({}),
-});
-
+/*
+ * ⭐⭐ PHASE 8 — `createLedgerSchema` MOVED TO `lib/validators/accounting.ts`.
+ *
+ * ⚠️ IT WAS DECLARED HERE AND COULD NOT BE EXPORTED, for the reason the
+ * top of this file gives about `"use server"`. That made the rule
+ * deciding what a ledger is unreachable by anything but this file — and
+ * the chart-of-accounts importer needs THE SAME OBJECT, not a copy of
+ * it. `lib/import/types.ts` refuses "an import variant" of a schema by
+ * name, and an account is the record every later number is classified
+ * by. Nothing about the rules changed in the move.
+ */
 export type CreateLedgerInput = z.input<typeof createLedgerSchema>;
 
 /** Only these roles may touch the ledger. */
```

---

## ITEM 3 — move the cost-centre schema out of a `"use server"` file

**Files:** `lib/validators/budgets.ts` (NEW) and `server/actions/budgets.ts`

Same situation, same reason: `costCentreInput` was unexported inside a
`"use server"` file at `server/actions/budgets.ts:174`.

Two messages were added in the move, and nothing else. A bare `.min(1)` lands in
the failed-rows CSV of an import as *"String must contain at least 1
character(s)"*, which is not a sentence a bookkeeper can act on — and a blank
cell arrives as `null`, whose default Zod message is *"Expected string, received
null"*. `createCostCentre` shows a human the same improved messages.

⚠️ The code's real rule is deliberately NOT in the new file:
`validateCostCentreCode` in `lib/accounting/cost-centre.ts` is the pure function
that decides whether a code is usable, and `createCostCentre` calls it after the
parse. Restating it would be the two-copies problem one level down.

**Create `lib/validators/budgets.ts` with this content:**

```ts
/**
 * Ordence — Budget and Cost-Centre Validation Schemas
 * Version: v1.85.0-alpha · Phase 8
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS, AND WHY IT IS A MOVE RATHER THAN A NEW RULE
 * ══════════════════════════════════════════════════════════════════════
 * `costCentreInput` was declared at `server/actions/budgets.ts:174`,
 * unexported, and could not have been exported: that file is
 * `"use server"`, and such a file may only export async functions. The
 * header of `lib/validators/accounting.ts` sets out the consequence in
 * full — a schema left in a server-action file is a rule with exactly one
 * caller, and the second caller writes a second copy.
 *
 * ⚠️ THE SECOND CALLER ARRIVED. The cost-centre importer must validate
 * through the object `createCostCentre` parses, because
 * `lib/import/types.ts` refuses an "import variant" of a schema by name:
 * a bulk path that validated more loosely than the form is a way to
 * create records the form would have refused, a thousand at a time.
 *
 * 🔴 NOTHING ABOUT THE RULES CHANGED IN THE MOVE. The four members, their
 *    bounds and their default are the ones that were there. The only
 *    additions are the two messages, because a `min(1)` with no message
 *    lands in the failed-rows CSV of an import as "String must contain at
 *    least 1 character(s)", which is not a sentence a bookkeeper can act
 *    on. `createCostCentre` shows the same messages to a form, where they
 *    are also better than the default.
 *
 * ⚠️ THE CODE'S REAL RULE IS NOT HERE, AND THAT IS DELIBERATE.
 * `validateCostCentreCode` in `lib/accounting/cost-centre.ts` is the pure
 * function that decides whether a code is usable, and
 * `createCostCentre` calls it AFTER this parse. Restating its rule here
 * would be the two-copies problem again, one level down.
 */

import { z } from "zod";

export const costCentreSchema = z.object({
  code: z
    .string({
      /*
       * ⚠️ A BLANK CELL ARRIVES AS `null`, not as "". `blankIsNull` in
       * `lib/import/values.ts` makes that distinction on purpose — absent
       * and empty mean different things to an update — and Zod's default
       * message for a null here is "Expected string, received null",
       * which is what the customer would read in the "what was wrong"
       * column of the CSV they downloaded to fix.
       */
      required_error: "Every cost centre needs a short code, such as PROD or HO.",
      invalid_type_error: "Every cost centre needs a short code, such as PROD or HO.",
    })
    .trim()
    .min(1, "Every cost centre needs a short code, such as PROD or HO.")
    .max(40),
  name: z
    .string({
      required_error: "Every cost centre needs a name.",
      invalid_type_error: "Every cost centre needs a name.",
    })
    .trim()
    .min(1, "Every cost centre needs a name.")
    .max(200),
  description: z.string().trim().max(1_000).optional(),
  displayOrder: z.number().int().min(0).max(100_000).default(100),
});

export type CostCentreInput = z.input<typeof costCentreSchema>;
```

```diff
--- a/server/actions/budgets.ts
+++ b/server/actions/budgets.ts
@@ -133,6 +133,7 @@
   type BudgetTotals,
   type BudgetVsActualRow,
 } from "@/lib/accounting/budget";
+import { costCentreSchema } from "@/lib/validators/budgets";
 import type { ActionResult } from "@/lib/validators/crm";
 
 /* ------------------------------------------------------------------ */
@@ -171,12 +172,14 @@
   displayOrder: number;
 };
 
-const costCentreInput = z.object({
-  code: z.string().trim().min(1).max(40),
-  name: z.string().trim().min(1).max(200),
-  description: z.string().trim().max(1_000).optional(),
-  displayOrder: z.number().int().min(0).max(100_000).default(100),
-});
+/*
+ * ⭐⭐ PHASE 8 — MOVED TO `lib/validators/budgets.ts`.
+ *
+ * ⚠️ IT WAS DECLARED HERE AND COULD NOT BE EXPORTED — this file is
+ * `"use server"`. The cost-centre importer must parse THE SAME OBJECT
+ * this action parses rather than a copy of it; see that file's header.
+ */
+const costCentreInput = costCentreSchema;
 
 /**
  * ⭐ ARCHIVED ONES ARE RETURNED TOO, FLAGGED RATHER THAN OMITTED.
```

---

## ITEM 4 — three destinations on `ImportTableKey`

**File:** `lib/import/types.ts` (Track M1)

`ledgers`, `cost_centres` and `hsn_sac_codes`. Without these the delivered
entities do not typecheck, because `ContractedImportEntity.table` is this union.

⚠️ **`hsn_sac_codes`, not `tax_codes`.** The phase brief names the destination
`tax_codes`; there is no such table and there never was. Over all 312
`pgTable(...)` declarations in `db/schema/`, `tax_codes` returns 0 matches. See
`TRACK-REPORT.md` §3.

🔴 Adding a member here is a **compile error at
`server/import/writers/registry.ts`** until item 5 lands. That is Phase 1's guard
working exactly as designed and it is why item 5 is not optional.

```diff
--- a/lib/import/types.ts
+++ b/lib/import/types.ts
@@ -482,7 +482,37 @@
   | "transactions"
   | "sales_invoices"
   | "vendor_ledger_entries"
-  | "stock_movements";
+  | "stock_movements"
+  /**
+   * ⭐⭐ PHASE 8 — THE ACCOUNTING AND MASTER-DATA DESTINATIONS.
+   *
+   * 🔴 `ledgers` IS THE CHART OF ACCOUNTS, AND ADDING IT HERE IS THE
+   *    SINGLE MOST CONSEQUENTIAL LINE IN PHASE 8.
+   *
+   * Until this line, the chart of accounts was NOT importable: it was
+   * seeded at workspace creation and edited in the product, which is why
+   * `opening-trial-balance` declared `dependsOn: []` and why
+   * `contract/opening-policies.ts` argued at length that its prerequisite
+   * was "a setup step rather than another import". That argument was
+   * correct and this line ends it. The trial balance now depends on the
+   * chart of accounts, which moves it out of wave 0 and moves the wave
+   * number of every entity that depends on IT.
+   *
+   * ⚠️ ADDING A MEMBER HERE IS A COMPILE ERROR AT
+   * `server/import/writers/registry.ts` UNTIL A WRITER EXISTS, which is
+   * the whole point of Phase 1 and is exactly the guard that should fire.
+   */
+  | "ledgers"
+  | "cost_centres"
+  /**
+   * ⚠️ `hsn_sac_codes`, NOT `tax_codes`. The phase brief names the
+   * destination `tax_codes`; there is no such table and there never was.
+   * `grep -rhoE 'pgTable\(' db/schema/` over all 312 tables returns
+   * `hsn_sac_codes` and `hsn_sac_rates` and nothing called `tax_codes`.
+   * The code and the RATE are deliberately two tables — see the argument
+   * in `db/schema/gst.ts` — and only the CODE is imported here.
+   */
+  | "hsn_sac_codes";
 
 /* ------------------------------------------------------------------ */
 /* LOOKUPS — THINGS A ROW REFERS TO BUT DOES NOT CREATE                */
```

---

## ITEM 5 — three writers in the registry

**File:** `server/import/writers/registry.ts` (Track PHASE-1)

Three imports and three entries. The writer modules themselves are Phase 8's and
are in `server/import/writers/accounting/`.

⚠️ This is the change that makes item 4 compile, and the two must land together
or the tree is red in between.

```diff
--- a/server/import/writers/registry.ts
+++ b/server/import/writers/registry.ts
@@ -61,6 +61,15 @@
 import { transactionsWriter } from "./transactions";
 import { vendorLedgerEntriesWriter } from "./vendor-ledger-entries";
 
+/*
+ * ⭐⭐ PHASE 8 — the accounting and master-data destinations. Each lives
+ * in `./accounting/`, which is Phase 8's owned subdirectory; this file
+ * and the three lines below are the only Phase-1 surface they touch.
+ */
+import { costCentresWriter } from "./accounting/cost-centres";
+import { hsnSacCodesWriter } from "./accounting/hsn-sac-codes";
+import { ledgersWriter } from "./accounting/ledgers";
+
 export const IMPORT_WRITERS: Record<ImportTableKey, ImportWriter> = {
   companies: companiesWriter,
   gst_parties: gstPartiesWriter,
@@ -68,6 +77,9 @@
   sales_invoices: salesInvoicesWriter,
   vendor_ledger_entries: vendorLedgerEntriesWriter,
   stock_movements: stockMovementsWriter,
+  ledgers: ledgersWriter,
+  cost_centres: costCentresWriter,
+  hsn_sac_codes: hsnSacCodesWriter,
 };
 
 /**
```

---

## ITEM 6 — one line in the single allowlist

**File:** `lib/import/entities.ts` (owned by no phase; five phases each add one
line)

One import and one spread inside `ALL_IMPORT_ENTITIES`. Phase 8 declares its
entities in `lib/import/entities-accounting.ts` and does not otherwise touch this
file, so the five entity phases merge cleanly against each other.

```diff
--- a/lib/import/entities.ts
+++ b/lib/import/entities.ts
@@ -40,6 +40,7 @@
 
 import { COMPANY_SIZES, createCompanySchema } from "@/lib/validators/crm";
 import { upsertPartySchema } from "@/lib/validators/gst";
+import { ACCOUNTING_IMPORT_ENTITIES } from "./entities-accounting";
 import { OPENING_IMPORT_ENTITIES } from "./opening-entities";
 import { OPENING_CONTRACTS } from "./contract/opening-policies";
 import type { ContractedImportEntity } from "./types";
@@ -719,6 +720,19 @@
 
 export const ALL_IMPORT_ENTITIES = {
   ...IMPORT_ENTITIES,
+  /*
+   * ⭐⭐ PHASE 8 — accounting and master data. One line, and the entities
+   * are declared in `entities-accounting.ts` because ownership of THIS
+   * file is contested by five phases at once. Five phases each adding one
+   * line here is five clean merges; five phases each rewriting this file
+   * is five conflicts.
+   *
+   * 🔴 `chart-of-accounts` ARRIVES WITH IT, AND IT MOVES THE LOAD ORDER
+   *    OF THE WHOLE MIGRATION. Until this line the chart of accounts was
+   *    not imported and `opening-trial-balance` said so in its contract.
+   *    See `contract/opening-policies.ts`, which now depends on it.
+   */
+  ...ACCOUNTING_IMPORT_ENTITIES,
   ...openingWithContracts,
 } as const satisfies Record<string, ContractedImportEntity>;
```

---

## ITEM 7 — adopt the proof suite

**File:** `tests/security/import-accounting.test.ts` (NEW — `tests/security/**`
is Track D's, `tests/**` is Track H's)

704 lines, 18 assertions, all passing. It runs the **real** `previewImport` and
`commitImport` against the throwaway PostgreSQL that
`scripts/bootstrap-test-db.mjs` stands up, connected as `ordence_app`
(NOSUPERUSER, NOBYPASSRLS). Identity and authorisation are mocked in exactly the
shape `tests/security/idempotency-money-movement.test.ts` established; nothing
about planning, matching, coercion, validation or writing is stubbed.

⚠️ **It is in `tests/security/` and not `tests/ui/` for a reason worth
keeping.** The existing import suites are source-level: they assert a file
CONTAINS a line. That is the right test for "the mapping the person settled is
the mapping that runs" and the wrong one for "the second run created nothing",
which is a claim about what the database holds. `tests/ui/` runs in JSDOM with
no database at all.

The file is delivered in full inside the Phase 8 zip **at its intended path**,
which means the ownership gate flags it — deliberately:

```
$ node scripts/check-track-ownership.mjs --track PHASE-8 --files <zip listing>
  x track PHASE-8 wrote outside its ownership: tests/security/import-accounting.test.ts
1 violation(s).
```

One violation, and it is this one. Hiding it under a folder the gate does not
read would have been quieter and worse: this suite is what proves every
behavioural claim Phase 8 makes.
Three of its assertions were proven to FAIL when the property they test is
broken — see `TRACK-REPORT.md` §6. A test proven only by passing is not proven.

---

## What Phase 8 did NOT need

- **No SQL.** Block **0260–0274 is unused and stays free.** All three
  destinations exist; provenance is the `import_row_provenance` sidecar M1
  built in 0196. A phase that invents a migration it does not need is a phase
  that turns `check:migrations` red for every parallel stream.
- **No new npm dependency.** `package.json` is untouched.
- **No second registry, and no second allowlist.** `ALL_IMPORT_ENTITIES` is
  still the only thing `isImportEntityKey` is membership in.
