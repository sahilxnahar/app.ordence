# PATCH-REQUEST-PHASE-7

Phase 7 (inventory entities) needs seven changes in files it does not own.
Every one of them was applied locally and the whole gate suite was run with
them in place — `npx tsc --noEmit` clean, `npm run gates:static` **28/28**,
`npm run check:import-contract` reading **9 entities in 2 waves**, and 17
database-backed tests passing. The diffs below are that exact state.

**Order matters for two of them.** ① and ② must land in the SAME commit as
this phase's files, because `ImportTableKey` and `IMPORT_WRITERS` are held
in step by the compiler on purpose: either alone does not build. ⑤ must land
with them too, because `lib/import/entities-inventory.ts` imports the
schemas it moves.

| # | File | Owner | Without it |
|---|---|---|---|
| ① | `lib/import/types.ts` | M1 | the three destinations do not exist |
| ② | `server/import/writers/registry.ts` | PHASE-1 | ① alone is a compile error |
| ③ | `lib/import/entities.ts` | nobody (integration) | the entities are unreachable |
| ④ | `lib/import/contract/opening-policies.ts` | M1 | opening stock still loads first, and fails on every row |
| ⑤ | `server/actions/inventory.ts` | — | two copies of the item/warehouse rules |
| ⑥ | `server/actions/import.ts` | PHASE-1 | a lookup resolves onto a soft-deleted item — **defect, proven** |
| ⑦ | `scripts/track-ownership.json` | integration | `check:migrations` and `check:track-ownership` are red for every phase, not just this one |

---

## ① `lib/import/types.ts` — three destinations

⚠️ This is the change that makes the compiler ask for ②. Applied on its own it
produced exactly this, which is Phase 1's induction working:

```
server/import/writers/registry.ts(64,14): error TS2739: Type '{ companies: ImportWriter; ... }'
is missing the following properties from type 'Record<ImportTableKey, ImportWriter>':
stock_items, warehouses, stock_batches
```

```diff
@@ -482,7 +482,25 @@
   | "transactions"
   | "sales_invoices"
   | "vendor_ledger_entries"
-  | "stock_movements";
+  | "stock_movements"
+  /**
+   * ⭐⭐ PHASE 7 — THE INVENTORY MASTERS.
+   *
+   * ⚠️ THESE THREE ARE WHAT MAKE `opening-stock` RESOLVE. That entity
+   * has declared `stock_item_by_sku` and `warehouse_by_code` lookups
+   * since Batch 58, with `missing` sentences already written — and
+   * nothing in the product could create the rows those lookups look for.
+   * A customer's first migration therefore failed on every line of the
+   * stock file until somebody typed the item master in by hand.
+   *
+   * 🔴 ADDING A MEMBER HERE IS A COMPILE ERROR AT
+   *    `server/import/writers/registry.ts` UNTIL A WRITER EXISTS FOR IT.
+   *    That is Phase 1's induction and it is why these three were added
+   *    in the same change as their three writer modules, not before.
+   */
+  | "stock_items"
+  | "warehouses"
+  | "stock_batches";
 
 /* ------------------------------------------------------------------ */
 /* LOOKUPS — THINGS A ROW REFERS TO BUT DOES NOT CREATE                */
```

## ② `server/import/writers/registry.ts` — three writers

The modules are in this phase's zip under `server/import/writers/inventory/`,
which `track-ownership-phases.json` assigns to PHASE-7. The registry itself
stays PHASE-1's and stays flat.

```diff
@@ -61,6 +61,15 @@
 import { transactionsWriter } from "./transactions";
 import { vendorLedgerEntriesWriter } from "./vendor-ledger-entries";
 
+/**
+ * ⭐ PHASE 7 — THE INVENTORY MASTERS, ONE SUBDIRECTORY PER ENTITY PHASE.
+ * The registry stays flat and stays here; only the modules move, so the
+ * `Record` below is still the one place a destination is remembered.
+ */
+import { stockBatchesWriter } from "./inventory/stock-batches";
+import { stockItemsWriter } from "./inventory/stock-items";
+import { warehousesWriter } from "./inventory/warehouses";
+
 export const IMPORT_WRITERS: Record<ImportTableKey, ImportWriter> = {
   companies: companiesWriter,
   gst_parties: gstPartiesWriter,
@@ -68,6 +77,9 @@
   sales_invoices: salesInvoicesWriter,
   vendor_ledger_entries: vendorLedgerEntriesWriter,
   stock_movements: stockMovementsWriter,
+  stock_items: stockItemsWriter,
+  warehouses: warehousesWriter,
+  stock_batches: stockBatchesWriter,
 };
 
 /**
```

## ③ `lib/import/entities.ts` — one spread

The whole reason the entities live in their own file. Five phases, five of
these, no shared rewrite.

```diff
@@ -40,6 +40,7 @@
 
 import { COMPANY_SIZES, createCompanySchema } from "@/lib/validators/crm";
 import { upsertPartySchema } from "@/lib/validators/gst";
+import { INVENTORY_IMPORT_ENTITIES } from "./entities-inventory";
 import { OPENING_IMPORT_ENTITIES } from "./opening-entities";
 import { OPENING_CONTRACTS } from "./contract/opening-policies";
 import type { ContractedImportEntity } from "./types";
@@ -656,6 +657,12 @@
 export const IMPORT_ENTITIES = {
   companies: companiesEntity,
   "gst-parties": gstPartiesEntity,
+  /**
+   * ⭐ PHASE 7 — the inventory masters, defined in their own file so
+   * that five entity phases are five one-line merges here rather than
+   * five rewrites of this file. Nothing else reads that map.
+   */
+  ...INVENTORY_IMPORT_ENTITIES,
 } as const satisfies Record<string, ContractedImportEntity>;
 
 export type ImportEntityKey = keyof typeof IMPORT_ENTITIES;
```

## ④ `lib/import/contract/opening-policies.ts` — the two edges that could not be declared

🔴 **This is a live defect, not a tidy-up.** `opening-stock` has resolved
`stock_item_by_sku` and `warehouse_by_code` since Batch 58 and declared no
dependency on either, because there was no entity to name and gate 29 refuses
a dependency on an entity that does not exist. So the planner put opening
stock in **wave 0** and told the customer to load it first — into a workspace
with no items and no warehouses, where every row fails.

Before and after, from `npm run check:import-contract`:

```
wave 0: companies, gst-parties, opening-stock, opening-trial-balance, stock-items, warehouses
wave 1: batches, opening-customer-invoices, opening-vendor-bills

wave 0: companies, gst-parties, opening-trial-balance, stock-items, warehouses
wave 1: batches, opening-customer-invoices, opening-stock, opening-vendor-bills
```

```diff
@@ -187,6 +187,53 @@
 
 const openingStock: ImportContract = {
   dependsOn: [
+    /**
+     * ⭐⭐ PHASE 7 — THE TWO EDGES THIS CONTRACT COULD NOT DECLARE WHEN
+     *    IT WAS WRITTEN.
+     *
+     * ⚠️ `opening-stock` HAS RESOLVED `stock_item_by_sku` AND
+     *    `warehouse_by_code` SINCE BATCH 58 AND DEPENDED ON NEITHER,
+     *    because there was no entity to name: an entity key that names
+     *    nothing is refused by `checkImportContract()`. So the wizard
+     *    put opening stock in wave 0 and the customer loaded it first —
+     *    into a workspace with no items and no warehouses, where every
+     *    single row comes back unresolved.
+     *
+     * ⭐ BOTH ARE `hard`, and unlike the contacts example there is no
+     * softness to argue about: BOTH lookups are emitted for every row
+     * (`opening-entities.ts` emits them whenever the cell is non-empty,
+     * and both cells are `required` headers refused blank by the
+     * schema), so out of order the file fails completely rather than
+     * partially.
+     */
+    {
+      entity: "stock-items",
+      strength: "hard",
+      because:
+        "Every line of your opening stock names an item by its SKU. Load your stock items first, or every line comes back saying the item was not found.",
+    },
+    {
+      entity: "warehouses",
+      strength: "hard",
+      because:
+        "Every line names the store the stock is sitting in, by its code. Load your warehouses first, or every line comes back saying the warehouse was not found.",
+    },
+    /**
+     * ⚠️ SOFT, AND THE DISTINCTION IS REAL RATHER THAN DECORATIVE. A
+     * customer with no batch-tracked items has no batch file and must
+     * still be able to start. But loading batches AFTERWARDS is not the
+     * same as loading them first: the movement trigger in SQL 0055
+     * creates any lot it has not seen, with a NULL expiry, and this
+     * entity has no expiry column to give it one. The lot then exists,
+     * the batches import skips it as already present, and the printed
+     * date can only be put back one lot at a time.
+     */
+    {
+      entity: "batches",
+      strength: "soft",
+      because:
+        "If any of your stock is batch-tracked, load the batches first. A lot that arrives here before its batch record is created with no expiry date, and after that the date has to be corrected one lot at a time.",
+    },
     {
       entity: "opening-trial-balance",
       strength: "soft",
```

## ⑤ `server/actions/inventory.ts` — the schemas move, unchanged

⚠️ **Nothing about the rules changes.** Every regex, bound and message is the
same object; it now lives in `lib/validators/inventory.ts` (in this phase's
zip) and is imported back. It had to move because a `"use server"` module may
export only async functions, so `warehouseSchema` and `stockItemSchema` could
not be reached by anything — and `lib/import/` may not import from `server/`
at all. Until they moved, "the schema is the one the form uses" was a rule
this phase could not obey without breaking a different one.

```diff
@@ -34,6 +34,13 @@
 import { and, desc, eq, sql } from "drizzle-orm";
 import { revalidatePath } from "next/cache";
 import { z } from "zod";
+import {
+  minorAmount,
+  positiveQuantity,
+  quantityString,
+  stockItemSchema,
+  warehouseSchema,
+} from "@/lib/validators/inventory";
 import { withTenant } from "@/db";
 import {
   warehouses,
@@ -60,21 +67,17 @@
 
 const FEATURE = "inventory.stock" as const;
 
-const quantityString = z
-  .string()
-  .trim()
-  .regex(/^-?\d{1,15}(\.\d{1,3})?$/, "Enter a quantity with up to three decimals.");
-
-const positiveQuantity = quantityString.refine(
-  (v) => Number(v) > 0,
-  "Quantity must be greater than zero.",
-);
-
-const minorAmount = z
-  .string()
-  .trim()
-  .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.")
-  .transform((v) => BigInt(v));
+/**
+ * ⭐ PHASE 7 — THESE MOVED TO `lib/validators/inventory.ts`, UNCHANGED.
+ *
+ * ⚠️ THEY WERE UNREACHABLE FROM ANYWHERE ELSE AND THAT WAS THE PROBLEM.
+ * A `"use server"` module may export only async functions, so a Zod
+ * object declared here can never be imported — and the import framework
+ * requires an entity to validate through the SAME schema the form uses,
+ * "not a copy, not an import variant, not a looser one". Moving them is
+ * what makes that rule obeyable; nothing about the rules themselves
+ * changed. See `lib/validators/inventory.ts` and `PATCH-REQUEST-PHASE-7.md`.
+ */
 
 const ALL_REASONS = [
   ...INWARD_REASONS,
@@ -86,26 +89,7 @@
 /* WAREHOUSES                                                          */
 /* ================================================================== */
 
-const warehouseSchema = z.object({
-  id: z.string().uuid().optional(),
-  code: z.string().trim().min(1, "Give the store a short code.").max(40),
-  name: z.string().trim().min(1, "Give the store a name.").max(200),
-  warehouseType: z
-    .enum(["own", "site", "consignment", "transit", "third_party", "quarantine"])
-    .default("own"),
-  projectId: z.string().uuid().optional().nullable(),
-  city: z.string().trim().max(120).optional().nullable(),
-  state: z.string().trim().max(120).optional().nullable(),
-  stateCode: z.string().trim().length(2).optional().nullable(),
-  gstin: z.string().trim().length(15).optional().nullable(),
-  /**
-   * ⚠️ SURFACED AS AN EXPLICIT CHOICE, NEVER A SILENT DEFAULT. Switching
-   * this on means every valuation for this store depends on the
-   * paperwork catching up with the lorry.
-   */
-  allowNegativeStock: z.boolean().default(false),
-  notes: z.string().trim().max(2000).optional().nullable(),
-});
+/** ⭐ Moved to `lib/validators/inventory.ts`. See the note above. */
 
 export async function saveWarehouse(
   input: unknown,
@@ -189,24 +173,7 @@
 /* STOCK ITEMS                                                         */
 /* ================================================================== */
 
-const stockItemSchema = z.object({
-  id: z.string().uuid().optional(),
-  assetId: z.string().uuid().optional().nullable(),
-  sku: z.string().trim().min(1, "Every stock item needs an SKU.").max(100),
-  name: z.string().trim().min(1).max(300),
-  description: z.string().trim().max(2000).optional().nullable(),
-  uom: z.string().trim().min(1).max(20).default("nos"),
-  trackingMode: z.enum(["none", "batch", "serial"]).default("none"),
-  valuationMethod: z
-    .enum(["fifo", "weighted_average", "specific", "standard"])
-    .default("weighted_average"),
-  standardCostMinor: minorAmount.optional().nullable(),
-  reorderLevel: quantityString.optional().nullable(),
-  reorderQuantity: quantityString.optional().nullable(),
-  leadTimeDays: z.number().int().min(0).max(3650).optional().nullable(),
-  shelfLifeDays: z.number().int().min(0).max(36500).optional().nullable(),
-  hsnSacCode: z.string().trim().max(20).optional().nullable(),
-});
+/** ⭐ Moved to `lib/validators/inventory.ts`. See the note above. */
 
 export async function saveStockItem(
   input: unknown,
```

## ⑥ `server/actions/import.ts` — a lookup must not resolve onto a deleted record

🔴 **A defect in the shipped tree, proven by running it.** `resolveLookups`
filters `stock_items` on `is_active` and never on `deleted_at`, while
`stock_items_tenant_sku_unique` is a PARTIAL index that excludes deleted rows
— so a workspace can hold a deleted `CEM-53` and a live one at once, and the
lookup can return the deleted one. `warehouses` has the same shape.

Measured on the unpatched tree, a preview of one row naming a soft-deleted SKU:

```
PROBE RESULT: {"create":1,"update":0,"skip":0,"error":0}   errors: []
```

and with the patch:

```
PROBE RESULT: {"create":0,"update":0,"skip":0,"error":1}
errors: [{"message":"There is no active stock item with SKU \"DEL-1\" ..."}]
```

⚠️ **`opening-stock` resolves these same two lookups**, so today it will post
a customer's entire opening quantity onto an item nobody can see, and report
success. The regression test is
`tests/security/import-inventory.test.ts` → "a deleted stock item is not a
match".

```diff
@@ -454,6 +454,18 @@
             and(
               eq(stockItems.tenantId, ctx.tenant.id),
               eq(stockItems.isActive, true),
+              /*
+               * 🔴 PHASE 7 — SOFT-DELETED ITEMS ARE NOT MATCHES, and the
+               * omission was not cosmetic. `stock_items_tenant_sku_unique`
+               * is a PARTIAL index excluding deleted rows, so a deleted
+               * `CEM-53` and a live `CEM-53` can both exist; without this
+               * predicate the lookup could resolve the SKU to the DELETED
+               * one, and `opening-stock` would post the customer's entire
+               * opening quantity onto an item nobody can see. Proven
+               * before the fix: a preview of a row naming a soft-deleted
+               * SKU reported `{"create":1,...,"error":0}`.
+               */
+              isNull(stockItems.deletedAt),
               inArray(sql`lower(${stockItems.sku})`, list),
             ),
           )
@@ -472,6 +484,9 @@
             and(
               eq(warehouses.tenantId, ctx.tenant.id),
               eq(warehouses.isActive, true),
+              // 🔴 PHASE 7 — the same omission, on the same reasoning.
+              // `warehouses_tenant_code_unique` is partial too.
+              isNull(warehouses.deletedAt),
               inArray(sql`lower(${warehouses.code})`, list),
             ),
           )
```

## ⑦ `scripts/track-ownership.json` — the phases map does not merge as shipped

`track-ownership-phases.json` says "merge these into
`scripts/track-ownership.json`". Merged verbatim, `check:track-ownership`
reports **28 violations**, and they are of three kinds:

1. **M2–M8 are still in the map.** Phases 1–10 supersede them and their SQL
   blocks and paths collide head-on (`M2 200-206` vs `PHASE-1 200-204` and
   `PHASE-2 205-214`; `server/import/**` vs six phase paths). Removed here.
   M1 stays: it has landed and its block 0196–0199 is still reserved.
2. **PHASE-1 ships no `excludes`.** Its own `_comment` says "PHASE-1 must
   exclude those subdirectories once they exist" and the JSON does not. So
   PHASE-1 collides with PHASE-4/5/6/7/8 over
   `server/import/writers/<phase>/**`. The five excludes are added here.
3. **PHASE-7 needs two paths its brief did not list.**
   `lib/validators/inventory.ts` (the moved schemas — see ⑤) and
   `tests/security/import-inventory.test.ts`. The test file needs an exclude
   on track D's `tests/security/**`, in exactly the way D already excludes
   `gst-*` and `tax-*`. Without both, `check:track-ownership --track PHASE-7`
   refuses this delivery:
   `x track PHASE-7 wrote outside its ownership: lib/validators/inventory.ts`.

4. **0181–0195 belong to no track.** Nothing owns them, so `check:migrations`
   refuses the gap the moment ANY phase ships a numbered migration — this is
   not specific to 0250. Recorded as a retired reserve rather than silently
   widened, so somebody has to look at it.

After all four, both gates are green, and so is the delivery check:

```
171 numbers reserved for parallel tracks, 138 still unused.
✅ Migrations contiguous — 155 files, 0001…0250 (6 documented historical gaps). Next number: 0251.
OK SQL blocks , 33 post-128 migration(s), all inside an allocated block
OK track PHASE-7: 9 delivered files, all inside its block
```

```diff
@@ -70,7 +70,8 @@
       ],
       "excludes": [
         "tests/security/gst-*.test.ts",
-        "tests/security/tax-*.test.ts"
+        "tests/security/tax-*.test.ts",
+        "tests/security/import-*.test.ts"
       ]
     },
     "E": {
@@ -197,79 +198,136 @@
         "lib/import/contract/**"
       ]
     },
-    "M2": {
-      "name": "Import ledger",
+    "PHASE-1": {
+      "name": "Writer registry",
       "sql": [
         200,
-        206
+        204
       ],
       "paths": [
-        "server/import/**",
-        "db/schema/import-runs.ts"
+        "server/actions/import.ts",
+        "server/import/writers/**"
       ],
       "excludes": [
+        "server/import/writers/crm/**",
+        "server/import/writers/sales/**",
+        "server/import/writers/purchases/**",
+        "server/import/writers/inventory/**",
+        "server/import/writers/accounting/**"
+      ]
+    },
+    "PHASE-2": {
+      "name": "Run ledger, idempotency, reversal",
+      "sql": [
+        205,
+        214
+      ],
+      "paths": [
+        "server/import/runs.ts",
+        "server/import/ledger.ts",
+        "server/import/reversal.ts",
+        "db/schema/import-runs.ts"
+      ]
+    },
+    "PHASE-3": {
+      "name": "Discovery and dry run",
+      "sql": [
+        215,
+        219
+      ],
+      "paths": [
+        "server/import/discovery.ts",
         "server/import/dryrun.ts"
       ]
     },
-    "M3": {
-      "name": "Sales entities",
+    "PHASE-9": {
+      "name": "Source adapters",
+      "sql": [
+        275,
+        284
+      ],
+      "paths": [
+        "lib/import/sources/**",
+        "lib/import/profiles/**"
+      ]
+    },
+    "PHASE-10": {
+      "name": "Reconciliation, cutover, wizard",
       "sql": [
-        207,
-        210
+        285,
+        299
       ],
       "paths": [
-        "lib/import/entities/sales/**"
+        "server/import/reconcile.ts",
+        "server/import/cutover.ts",
+        "app/(crm)/settings/import/**",
+        "components/settings/import-wizard.tsx"
       ]
     },
-    "M4": {
-      "name": "Supply entities",
+    "PHASE-4": {
+      "name": "Entities: crm",
       "sql": [
-        211,
-        214
+        220,
+        229
       ],
       "paths": [
-        "lib/import/entities/supply/**"
+        "lib/import/entities-crm.ts",
+        "server/import/writers/crm/**"
       ]
     },
-    "M5": {
-      "name": "People entities",
+    "PHASE-5": {
+      "name": "Entities: sales",
       "sql": [
-        215,
-        218
+        230,
+        239
       ],
       "paths": [
-        "lib/import/entities/people/**"
+        "lib/import/entities-sales.ts",
+        "server/import/writers/sales/**"
       ]
     },
-    "M6": {
-      "name": "Source adapters",
-      "sql": null,
+    "PHASE-6": {
+      "name": "Entities: purchases",
+      "sql": [
+        240,
+        249
+      ],
       "paths": [
-        "lib/import/sources/**",
-        "lib/import/dictionaries/**"
+        "lib/import/entities-purchases.ts",
+        "server/import/writers/purchases/**"
       ]
     },
-    "M7": {
-      "name": "Discovery and dry run",
+    "PHASE-7": {
+      "name": "Entities: inventory",
       "sql": [
-        219,
-        222
+        250,
+        259
       ],
       "paths": [
-        "lib/import/discover/**",
-        "server/import/dryrun.ts"
+        "lib/import/entities-inventory.ts",
+        "lib/validators/inventory.ts",
+        "server/import/writers/inventory/**",
+        "tests/security/import-inventory.test.ts"
       ]
     },
-    "M8": {
-      "name": "Reconcile and cutover",
+    "PHASE-8": {
+      "name": "Entities: accounting",
       "sql": [
-        223,
-        226
+        260,
+        274
       ],
       "paths": [
-        "lib/import/reconcile/**",
-        "docs/CUTOVER.md"
+        "lib/import/entities-accounting.ts",
+        "server/import/writers/accounting/**"
       ]
+    },
+    "RESERVED-181-195": {
+      "name": "Unused wave-16 reserve, retired",
+      "sql": [
+        181,
+        195
+      ],
+      "paths": []
     }
   },
   "anyTrack": [
```

---

## Two smaller things, not patched here

**(a) A `project_by_code` lookup kind.** `warehouseSchema` carries
`projectId`, a site store belongs to a project, and every customer export
names the project by code — but `ImportLookupKind` and `resolveLookups` are
PHASE-1's, and inventing a lookup kind inside an entity phase is how two
tracks end up with two resolvers. So the `warehouses` entity ships without a
Project column rather than shipping a heading that silently does nothing.
Whoever owns lookups next: one more `if` branch in `resolveLookups`, keyed on
`projects.code` scoped by tenant and `deleted_at IS NULL`.

**(b) The duplicate-mode refusal names the wrong reason.**
`server/actions/import.ts` refuses a mode an entity does not offer with a
sentence about posted entries and reversing them. That is right for
`opening-trial-balance` and wrong for `batches`, which refuses `update`
because a lot has one printed expiry. The customer is told about accounting
when they asked about a carton. It wants the sentence to come from the
entity — one optional member beside `duplicateRule` — and that is a change to
a file and a type this phase does not own.
