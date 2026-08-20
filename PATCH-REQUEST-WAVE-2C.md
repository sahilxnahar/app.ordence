# PATCH REQUEST — WAVE 2C (money)

Everything here is in a file **Wave 2C does not own**. Each block is exact
and mechanical. The byte-for-byte version of this whole request is
`PATCH-REQUEST-WAVE-2C.patch`, which applies clean with `patch -p1` to the
untouched v1.89.0-alpha tree and was verified end to end (see
TRACK-REPORT.md §3.5).

**Why any of it is needed:** `money: ImportMoneyContract` is a REQUIRED
member of `ImportEntityDefinition`, and `planImport`/`planImportRecords`
take a required `ImportContext`. Both are required on purpose — see
TRACK-REPORT.md §2.1. Until this is applied, `npx tsc --noEmit` reports 20
errors: 18 "Property 'money' is missing", one per entity, and 2 at the
caller. **That list is the point:** the compiler, not a convention, is what
makes every entity answer the currency question.

---

## A. The eighteen entities — one member each

Insert immediately after each entity's `key:` line. Order inside an object
literal does not matter; next to `columns` reads better if you prefer.

**Eight entities have money columns → `{ source: "workspace" }`:**
`leads`, `stock-items`, `purchase-bills`, `receipts`,
`opening-trial-balance`, `opening-customer-invoices`,
`opening-vendor-bills`, `opening-stock`

```ts
  /**
   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
   * currency; there is no currency column. The exponent follows from
   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
   */
  money: { source: "workspace" },
```

**Ten entities have none → `{ source: "none" }`:**
`chart-of-accounts`, `cost-centres`, `tax-codes`, `contacts`,
`warehouses`, `batches`, `vendors`, `customers`, `companies`,
`gst-parties`

```ts
  /** ⭐ WAVE 2C. No money column on this entity. */
  money: { source: "none" },
```

🔴 **Do not "simplify" by giving the ten `{ source: "workspace" }` too.**
Gate 29 refuses a currency source on an entity with no amount: the member
would read as enforced and enforce nothing, and the next person to add an
amount column would believe the question was already answered for it.

Files: `lib/import/entities.ts` (2), `entities-accounting.ts` (3),
`entities-crm.ts` (2), `entities-inventory.ts` (3),
`entities-purchases.ts` (2), `entities-sales.ts` (2),
`opening-entities.ts` (4).

---

## B. `server/actions/import.ts` — the caller supplies the workspace currency

This is the whole of rule 4's other side: the pure layer never reads
`tenants`, so the one caller that has a session does, on the shared line
that both the preview and the commit go through.

---

## C. `lib/import/index.ts` — two type re-exports

`ImportContext` and `ImportMoneyContract` alongside the existing
`ImportColumnKind` / `ImportEntityDefinition`.

---

## D. `lib/import/contract/check.ts` — the gate-29 rule

Three refusals, added above the provenance block:

1. `{ source: "none" }` on an entity **with** money columns.
2. a currency source on an entity with **no** money column.
3. `{ source: "column" }` naming a `field` that is not one of the
   entity's columns, or naming one whose `kind` is not `text`/`enum`.

Shown failing, and then green again, in TRACK-REPORT.md §3.3.

---

## E. Tests — mechanical, and every one was run

* `tests/ui/csv-import.test.ts`, `tests/ui/import-profiles.test.ts` — 15
  `coerceMoneyMinor(x)` calls become `coerceMoneyMinor(x, 2)`. The
  exponent is now required (TRACK-REPORT.md §2.5); `2` preserves exactly
  what each of those assertions was already asserting.
* seven files gain `const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;`
  and pass it as the planner's third argument (59 call sites).
* `tests/ui/csv-import.test.ts` + `tests/ui/opening-balances.test.ts` —
  the two SOURCE-TEXT assertions that pin the planner's signature are
  updated to the new one. ⚠️ **They are not weakened.** Both still assert
  the planner has no `mode`/`quick`/`skipValidation` argument; a context
  of tenant data is not a run-mode, and the whole design is that the two
  runs receive the SAME one.
* `tests/ui/import-opening.test.ts:65` — `"not an amount"` becomes
  `"not a valid amount in INR"`, because the message now names the
  currency (TRACK-REPORT.md §2.4).

After the patch: `12 failed | 6817 passed` — the same twelve pre-existing
failures as the untouched tree, in the same four files. See
TRACK-REPORT.md §3.6, which also corrects the brief about which files
those are.

---

## F. Recommended, NOT done — `purchase-bills` gains a currency column

`entities-purchases.ts` lines 54–83 already say it needs one. With this
wave the framework can now carry it:

```ts
  money: { source: "column", field: "currency", whenBlank: "workspace" },
```

plus a `text` column with `maxLength: 3`. I have not written it: it is not
my file, and a foreign-currency purchase bill also needs an FX rate on the
invoice date before it is worth anything, which is a wave of its own.

---

## THE PATCH

Byte-for-byte, `patch -p1` against v1.89.0-alpha:

```diff
--- a/lib/import/index.ts	2026-08-19 08:56:00.000000000 +0000
+++ b/lib/import/index.ts	2026-08-20 20:42:54.388456683 +0000
@@ -99,7 +99,9 @@
   HeaderAssignment,
   ImportColumn,
   ImportColumnKind,
+  ImportContext,
   ImportEntityDefinition,
+  ImportMoneyContract,
   ImportLookup,
   ImportLookupKind,
   ImportNaturalKey,
--- a/lib/import/contract/check.ts	2026-08-20 13:59:29.000000000 +0000
+++ b/lib/import/contract/check.ts	2026-08-20 20:46:24.492586749 +0000
@@ -91,6 +91,57 @@
       }
     }
 
+    /* ---- ⭐⭐⭐ WAVE 2C — every money column has a currency ---- */
+
+    /*
+     * 🔴 `money: { source: "none" }` IS THE ONLY VARIANT THAT COULD BE
+     * USED AS A WAY OF NOT DECIDING, so it is the one this gate exists
+     * for. An entity that declares it while carrying a `kind: "money"`
+     * column would have every amount coerced at whatever exponent the
+     * framework fell back to — which is how "two decimal places" became
+     * true of the whole product in the first place.
+     *
+     * ⚠️ AND THE CONVERSE. An entity with NO money column that declares
+     * a currency source is not harmless: it is a member that reads as
+     * enforced and enforces nothing, and the next person adds an amount
+     * column believing the currency question was already answered for
+     * it. Both directions are refused.
+     */
+    const moneyColumns = def.columns.filter((col) => col.kind === "money");
+
+    if (def.money.source === "none" && moneyColumns.length > 0) {
+      problems.push({
+        entity: key,
+        member: "money",
+        problem: `declares money: { source: "none" } but has ${moneyColumns.length} money column(s): ${moneyColumns.map((col) => col.header).join(", ")}. An amount cannot be read without knowing how many decimal places its currency has — two is wrong by a factor of ten for the Gulf dinars and a hundred for the yen.`,
+      });
+    }
+
+    if (def.money.source !== "none" && moneyColumns.length === 0) {
+      problems.push({
+        entity: key,
+        member: "money",
+        problem: `declares a currency source ("${def.money.source}") but has no money column. The member reads as enforced and enforces nothing; declare money: { source: "none" } until it has an amount.`,
+      });
+    }
+
+    if (def.money.source === "column") {
+      const carrier = def.columns.find((col) => col.field === (def.money as { field: string }).field);
+      if (!carrier) {
+        problems.push({
+          entity: key,
+          member: "money.field",
+          problem: `says the currency is carried by field "${(def.money as { field: string }).field}", which is not one of its columns. Nothing in the file would ever supply it, so every row would silently fall back to the workspace currency or be refused.`,
+        });
+      } else if (carrier.kind !== "text" && carrier.kind !== "enum") {
+        problems.push({
+          entity: key,
+          member: "money.field",
+          problem: `names "${carrier.header}" as its currency column, but that column is a ${carrier.kind}. A currency code is text.`,
+        });
+      }
+    }
+
     /* ---- provenance covers the destination ---- */
     if (c.provenance.targets.length === 0) {
       problems.push({
--- a/lib/import/entities.ts	2026-08-20 19:18:32.000000000 +0000
+++ b/lib/import/entities.ts	2026-08-20 20:42:54.387414029 +0000
@@ -55,6 +55,8 @@
 
 const companiesEntity: ContractedImportEntity = {
   key: "companies",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "Companies",
   noun: { one: "company", many: "companies" },
   description:
@@ -369,6 +371,8 @@
  */
 const gstPartiesEntity: ContractedImportEntity = {
   key: "gst-parties",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "GST parties",
   noun: { one: "party", many: "parties" },
   description:
--- a/lib/import/entities-crm.ts	2026-08-20 18:07:08.000000000 +0000
+++ b/lib/import/entities-crm.ts	2026-08-20 20:42:54.383779845 +0000
@@ -91,6 +91,8 @@
  */
 const contacts: ContractedImportEntity = {
   key: "contacts",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "Contacts",
   noun: { one: "contact", many: "contacts" },
   description:
@@ -443,6 +445,12 @@
  */
 const leads: ContractedImportEntity = {
   key: "leads",
+  /**
+   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
+   * currency; there is no currency column. The exponent follows from
+   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
+   */
+  money: { source: "workspace" },
   label: "Leads",
   noun: { one: "lead", many: "leads" },
   description:
--- a/lib/import/entities-sales.ts	2026-08-20 19:17:27.000000000 +0000
+++ b/lib/import/entities-sales.ts	2026-08-20 20:46:41.555701197 +0000
@@ -107,6 +107,8 @@
  */
 const customersEntity: ContractedImportEntity = {
   key: "customers",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "Customers",
   noun: { one: "customer", many: "customers" },
   description:
@@ -472,6 +474,12 @@
  */
 const receiptsEntity: ContractedImportEntity = {
   key: "receipts",
+  /**
+   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
+   * currency; there is no currency column. The exponent follows from
+   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
+   */
+  money: { source: "workspace" },
   label: "Customer receipts",
   noun: { one: "receipt", many: "receipts" },
   description:
--- a/lib/import/entities-accounting.ts	2026-08-20 18:03:16.000000000 +0000
+++ b/lib/import/entities-accounting.ts	2026-08-20 20:42:54.382996907 +0000
@@ -104,6 +104,8 @@
  */
 const chartOfAccountsEntity: ContractedImportEntity = {
   key: "chart-of-accounts",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "Chart of accounts",
   noun: { one: "account", many: "accounts" },
   description:
@@ -505,6 +507,8 @@
  */
 const costCentresEntity: ContractedImportEntity = {
   key: "cost-centres",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "Cost centres",
   noun: { one: "cost centre", many: "cost centres" },
   description:
@@ -707,6 +711,8 @@
  */
 const taxCodesEntity: ContractedImportEntity = {
   key: "tax-codes",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "Tax codes (HSN and SAC)",
   noun: { one: "tax code", many: "tax codes" },
   description:
--- a/lib/import/entities-inventory.ts	2026-08-20 18:07:08.000000000 +0000
+++ b/lib/import/entities-inventory.ts	2026-08-20 20:42:54.384482325 +0000
@@ -145,6 +145,12 @@
  */
 const stockItemsEntity: ContractedImportEntity = {
   key: "stock-items",
+  /**
+   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
+   * currency; there is no currency column. The exponent follows from
+   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
+   */
+  money: { source: "workspace" },
   label: "Stock items",
   noun: { one: "stock item", many: "stock items" },
   description:
@@ -380,6 +386,8 @@
 
 const warehousesEntity: ContractedImportEntity = {
   key: "warehouses",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "Warehouses",
   noun: { one: "warehouse", many: "warehouses" },
   description:
@@ -578,6 +586,8 @@
  */
 const batchesEntity: ContractedImportEntity = {
   key: "batches",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "Batches",
   noun: { one: "batch", many: "batches" },
   description:
--- a/lib/import/entities-purchases.ts	2026-08-20 19:17:27.000000000 +0000
+++ b/lib/import/entities-purchases.ts	2026-08-20 20:42:54.385805256 +0000
@@ -162,6 +162,8 @@
  */
 const vendorsEntity: ContractedImportEntity = {
   key: "vendors",
+  /** ⭐ WAVE 2C. No money column on this entity. */
+  money: { source: "none" },
   label: "Vendors",
   noun: { one: "vendor", many: "vendors" },
   description:
@@ -740,6 +742,12 @@
  */
 const purchaseBillsEntity: ContractedImportEntity = {
   key: "purchase-bills",
+  /**
+   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
+   * currency; there is no currency column. The exponent follows from
+   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
+   */
+  money: { source: "workspace" },
   label: "Purchase bills",
   noun: { one: "bill", many: "bills" },
   description:
--- a/lib/import/opening-entities.ts	2026-08-16 13:17:24.000000000 +0000
+++ b/lib/import/opening-entities.ts	2026-08-20 20:42:54.387966977 +0000
@@ -92,6 +92,12 @@
 
 const openingTrialBalanceEntity: ImportEntityDefinition = {
   key: "opening-trial-balance",
+  /**
+   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
+   * currency; there is no currency column. The exponent follows from
+   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
+   */
+  money: { source: "workspace" },
   label: "Opening trial balance",
   noun: { one: "opening balance", many: "opening balances" },
   description:
@@ -302,6 +308,12 @@
 
 const openingCustomerInvoicesEntity: ImportEntityDefinition = {
   key: "opening-customer-invoices",
+  /**
+   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
+   * currency; there is no currency column. The exponent follows from
+   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
+   */
+  money: { source: "workspace" },
   label: "Unpaid customer invoices",
   noun: { one: "opening invoice", many: "opening invoices" },
   description:
@@ -471,6 +483,12 @@
 
 const openingVendorBillsEntity: ImportEntityDefinition = {
   key: "opening-vendor-bills",
+  /**
+   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
+   * currency; there is no currency column. The exponent follows from
+   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
+   */
+  money: { source: "workspace" },
   label: "Unpaid vendor bills",
   noun: { one: "opening bill", many: "opening bills" },
   description:
@@ -608,6 +626,12 @@
 
 const openingStockEntity: ImportEntityDefinition = {
   key: "opening-stock",
+  /**
+   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
+   * currency; there is no currency column. The exponent follows from
+   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
+   */
+  money: { source: "workspace" },
   label: "Stock on hand",
   noun: { one: "opening stock line", many: "opening stock lines" },
   description:
--- a/server/actions/import.ts	2026-08-20 18:02:22.000000000 +0000
+++ b/server/actions/import.ts	2026-08-20 20:42:54.388349077 +0000
@@ -77,6 +77,7 @@
 import { PermissionDeniedError } from "@/lib/permissions";
 import { financialYearOf } from "@/lib/gst/constants";
 import { formatMoneyPlain } from "@/lib/billing/money";
+import { functionalCurrencyFromSettings } from "@/lib/fx/currency";
 import {
   ALL_IMPORT_ENTITIES,
   buildReport,
@@ -84,6 +85,7 @@
   openingBatchKey,
   planImport,
   planImportRecords,
+  type ImportContext,
   type ImportEntityDefinition,
   type ImportLookup,
   type ImportNaturalKey,
@@ -545,9 +547,28 @@
      * what stops "we support Excel" from becoming a second importer with
      * its own bugs.
      */
+    /*
+     * ⭐⭐⭐ WAVE 2C — THE ONE FACT THE PURE LAYER CANNOT KNOW.
+     *
+     * 🔴 `lib/import/` MUST NOT IMPORT THE DATABASE (rule 4), and the
+     * number of decimal places an amount has is a fact about the
+     * workspace's currency, which is a row in `tenants`. So it is read
+     * HERE — by the same `functionalCurrencyFromSettings()` that
+     * `runFxRevaluation` and every sales posting read — and handed down
+     * as data.
+     *
+     * ⚠️ BOTH RUNS GET THE SAME OBJECT, on the same line, for the same
+     * reason the planner itself is shared: a preview that read INR and a
+     * commit that read KWD would disagree about which rows are valid,
+     * which is constraint 1's failure mode with a new cause.
+     */
+    const planContext: ImportContext = {
+      workspaceCurrency: functionalCurrencyFromSettings(ctx.tenant.settings).code,
+    };
+
     const plan = params.records
-      ? planImportRecords(entity, params.records)
-      : planImport(entity, params.csvText ?? "");
+      ? planImportRecords(entity, params.records, planContext)
+      : planImport(entity, params.csvText ?? "", planContext);
 
     if (plan.fatal) {
       return {
--- a/tests/ui/csv-import.test.ts	2026-08-20 17:12:25.000000000 +0000
+++ b/tests/ui/csv-import.test.ts	2026-08-20 21:04:24.566862377 +0000
@@ -37,6 +37,15 @@
 import { buildFailedRowsCsv, buildReport, buildTemplateCsv } from "@/lib/import/report";
 import { IMPORT_ENTITIES, isImportEntityKey } from "@/lib/import/entities";
 
+/**
+ * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
+ * `ImportContext`. These files are all about entities whose amounts are
+ * in rupees, so every call passes the same one; the exponent behaviour
+ * itself is proven in `tests/ui/import-money-exponent.test.ts`.
+ */
+const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;
+
+
 const ROOT = join(__dirname, "..", "..");
 const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
 
@@ -126,7 +135,7 @@
     const withBom = "﻿Name,City\nAcme,Pune";
     expect(cells(withBom)[0]).toEqual(["Name", "City"]);
     // And the whole way through: the header maps, so the row validates.
-    const plan = planImport(IMPORT_ENTITIES.companies, "﻿Name\nAcme Traders");
+    const plan = planImport(IMPORT_ENTITIES.companies, "﻿Name\nAcme Traders", IMPORT_CONTEXT);
     expect(plan.fatal).toBeNull();
     expect(plan.rows[0]?.errors).toEqual([]);
   });
@@ -305,7 +314,7 @@
   it("refuses the whole file when a required column is absent", () => {
     const plan = planImport(
       IMPORT_ENTITIES.companies,
-      "Nickname,Town\nAcme,Pune\nBeta,Delhi",
+      "Nickname,Town\nAcme,Pune\nBeta,Delhi", IMPORT_CONTEXT,
     );
     expect(plan.fatal).not.toBeNull();
     expect(plan.rows).toHaveLength(0);
@@ -323,7 +332,7 @@
   it("reports columns nothing claimed rather than silently dropping them", () => {
     const plan = planImport(
       IMPORT_ENTITIES.companies,
-      "Name,Favourite colour\nAcme,blue",
+      "Name,Favourite colour\nAcme,blue", IMPORT_CONTEXT,
     );
     expect(plan.fatal).toBeNull();
     expect(plan.unrecognisedHeaders).toEqual(["Favourite colour"]);
@@ -333,7 +342,7 @@
   it("treats the error column of a re-uploaded failed-rows file as ignorable", () => {
     const plan = planImport(
       IMPORT_ENTITIES.companies,
-      "Name,What was wrong with this row\nAcme,Name: required",
+      "Name,What was wrong with this row\nAcme,Name: required", IMPORT_CONTEXT,
     );
     expect(plan.fatal).toBeNull();
     expect(plan.rows[0]?.errors).toEqual([]);
@@ -353,34 +362,34 @@
    */
   it("the float version would have been wrong", () => {
     expect(Math.round(Number("1.005") * 100)).toBe(100);
-    expect(coerceMoneyMinor("1.005")).toEqual({ ok: false, message: expect.any(String) });
+    expect(coerceMoneyMinor("1.005", 2)).toEqual({ ok: false, message: expect.any(String) });
     // Two decimal places is the limit; 1.01 is unambiguous and exact.
-    expect(coerceMoneyMinor("1.01")).toEqual({ ok: true, value: "101" });
+    expect(coerceMoneyMinor("1.01", 2)).toEqual({ ok: true, value: "101" });
   });
 
   it("parses the string rather than multiplying a float", () => {
-    expect(coerceMoneyMinor("1250.50")).toEqual({ ok: true, value: "125050" });
-    expect(coerceMoneyMinor("0.01")).toEqual({ ok: true, value: "1" });
-    expect(coerceMoneyMinor("12345")).toEqual({ ok: true, value: "1234500" });
-    expect(coerceMoneyMinor("1.1")).toEqual({ ok: true, value: "110" });
-    expect(coerceMoneyMinor("-99.99")).toEqual({ ok: true, value: "-9999" });
+    expect(coerceMoneyMinor("1250.50", 2)).toEqual({ ok: true, value: "125050" });
+    expect(coerceMoneyMinor("0.01", 2)).toEqual({ ok: true, value: "1" });
+    expect(coerceMoneyMinor("12345", 2)).toEqual({ ok: true, value: "1234500" });
+    expect(coerceMoneyMinor("1.1", 2)).toEqual({ ok: true, value: "110" });
+    expect(coerceMoneyMinor("-99.99", 2)).toEqual({ ok: true, value: "-9999" });
   });
 
   /** Large enough that `Number` would already have lost digits. */
   it("survives an amount beyond the safe-integer range", () => {
-    expect(coerceMoneyMinor("999999999999.99")).toEqual({
+    expect(coerceMoneyMinor("999999999999.99", 2)).toEqual({
       ok: true,
       value: "99999999999999",
     });
   });
 
   it("accepts what a spreadsheet actually writes", () => {
-    expect(coerceMoneyMinor("1,250.50")).toEqual({ ok: true, value: "125050" });
-    expect(coerceMoneyMinor("₹1,250.50")).toEqual({ ok: true, value: "125050" });
+    expect(coerceMoneyMinor("1,250.50", 2)).toEqual({ ok: true, value: "125050" });
+    expect(coerceMoneyMinor("₹1,250.50", 2)).toEqual({ ok: true, value: "125050" });
   });
 
   it("returns a string, because a bigint cannot cross to the browser", () => {
-    const result = coerceMoneyMinor("10.00");
+    const result = coerceMoneyMinor("10.00", 2);
     expect(result.ok).toBe(true);
     if (!result.ok) return;
     expect(typeof result.value).toBe("string");
@@ -398,8 +407,8 @@
   });
 
   it("blank is nothing supplied, not zero", () => {
-    expect(coerceMoneyMinor("")).toEqual({ ok: true, value: null });
-    expect(coerceMoneyMinor("   ")).toEqual({ ok: true, value: null });
+    expect(coerceMoneyMinor("", 2)).toEqual({ ok: true, value: null });
+    expect(coerceMoneyMinor("   ", 2)).toEqual({ ok: true, value: null });
   });
 });
 
@@ -481,7 +490,7 @@
      */
     const modeReads = code.match(/mode === "commit"/g) ?? [];
     expect(modeReads).toHaveLength(3);
-    const plannerAt = code.indexOf("planImportRecords(entity, params.records)");
+    const plannerAt = code.indexOf("planImportRecords(entity, params.records, planContext)");
     for (const index of [...code.matchAll(/mode === "commit"/g)].map((m) => m.index ?? 0)) {
       expect(index).toBeGreaterThan(plannerAt);
     }
@@ -494,7 +503,7 @@
    */
   it("the planner has no mode, depth or skip argument", () => {
     const code = codeOnly(PLAN);
-    expect(code).toContain("export function planImport(\n  entity: ImportEntityDefinition,\n  csvText: string,\n): ImportPlan");
+    expect(code).toContain("export function planImport(\n  entity: ImportEntityDefinition,\n  csvText: string,\n  context: ImportContext,\n): ImportPlan");
     expect(code).not.toMatch(/skipValidation|quick|shallow|dryRun\b/i);
   });
 
@@ -528,7 +537,7 @@
       [
         "Customer or vendor,Legal name,GSTIN,Registration type,Effective from",
         "customer,Acme Traders,,regular,2026-04-01",
-      ].join("\n"),
+      ].join("\n"), IMPORT_CONTEXT,
     );
     expect(plan.fatal).toBeNull();
     expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
@@ -542,7 +551,7 @@
       [
         "Customer or vendor,Legal name,GSTIN,Registration type,Effective from,City,PIN code",
         "Customer,Acme Traders,27AAPFU0939F1ZV,Regular,2026-04-01,Pune,411001",
-      ].join("\n"),
+      ].join("\n"), IMPORT_CONTEXT,
     );
     expect(plan.rows[0]?.errors).toEqual([]);
     const payload = plan.rows[0]?.payload as Record<string, unknown>;
@@ -563,7 +572,7 @@
       [
         "Customer or vendor,Legal name,GSTIN,Registration type,Effective from",
         "customer,Acme Traders,27AAPFU0939F1ZV,regular,2026-04-01",
-      ].join("\n"),
+      ].join("\n"), IMPORT_CONTEXT,
     );
     const payload = plan.rows[0]?.payload as Record<string, unknown>;
     // Absent, not `{}` — and `{}` is what an over-eager `buildPayload`
@@ -587,7 +596,7 @@
   ].join("\n");
 
   it("good rows survive alongside bad ones", () => {
-    const plan = planImport(IMPORT_ENTITIES.companies, MIXED);
+    const plan = planImport(IMPORT_ENTITIES.companies, MIXED, IMPORT_CONTEXT);
     expect(plan.fatal).toBeNull();
     expect(plan.rows).toHaveLength(4);
     expect(plan.rows.filter((r) => r.errors.length === 0)).toHaveLength(2);
@@ -601,7 +610,7 @@
    * which 100 are not.
    */
   it("hands the failed rows back as a CSV with their original columns", () => {
-    const plan = planImport(IMPORT_ENTITIES.companies, MIXED);
+    const plan = planImport(IMPORT_ENTITIES.companies, MIXED, IMPORT_CONTEXT);
     const report = buildReport(IMPORT_ENTITIES.companies, plan, {
       mode: "preview",
       duplicateMode: "skip",
@@ -650,7 +659,7 @@
    * not, the loop the whole constraint exists for does not close.
    */
   it("the failed-rows file can be fixed and imported again", () => {
-    const plan = planImport(IMPORT_ENTITIES.companies, MIXED);
+    const plan = planImport(IMPORT_ENTITIES.companies, MIXED, IMPORT_CONTEXT);
     const report = buildReport(IMPORT_ENTITIES.companies, plan, {
       mode: "preview",
       duplicateMode: "skip",
@@ -664,7 +673,7 @@
     const fixed = (report.failedRowsCsv ?? "")
       .replace("\r\n,nameless.example", "\r\nNameless Ltd,nameless.example")
       .replace("not-a-number", "9");
-    const second = planImport(IMPORT_ENTITIES.companies, fixed);
+    const second = planImport(IMPORT_ENTITIES.companies, fixed, IMPORT_CONTEXT);
     expect(second.fatal).toBeNull();
     expect(second.rows.filter((r) => r.errors.length > 0)).toHaveLength(0);
   });
@@ -677,7 +686,7 @@
     const rows = ["Name"];
     for (let i = 0; i < 60; i += 1) rows.push(`Company ${i}`);
     for (let i = 0; i < 30; i += 1) rows.push(`"${"x".repeat(300)}"`);
-    const plan = planImport(IMPORT_ENTITIES.companies, rows.join("\n"));
+    const plan = planImport(IMPORT_ENTITIES.companies, rows.join("\n"), IMPORT_CONTEXT);
     const report = buildReport(IMPORT_ENTITIES.companies, plan, {
       mode: "commit",
       duplicateMode: "skip",
@@ -783,7 +792,7 @@
   it("refuses the second of two rows for the same record, naming the first", () => {
     const plan = planImport(
       IMPORT_ENTITIES.companies,
-      ["Name,Domain", "Acme Traders,acme.example", "Acme Trading,acme.example"].join("\n"),
+      ["Name,Domain", "Acme Traders,acme.example", "Acme Trading,acme.example"].join("\n"), IMPORT_CONTEXT,
     );
     expect(plan.rows[0]?.errors).toEqual([]);
     expect(plan.rows[1]?.errors).toHaveLength(1);
@@ -954,7 +963,7 @@
   it("refuses a file beyond the row cap instead of importing part of it", () => {
     const rows = ["Name"];
     for (let i = 0; i <= MAX_IMPORT_ROWS; i += 1) rows.push(`Company ${i}`);
-    const plan = planImport(IMPORT_ENTITIES.companies, rows.join("\n"));
+    const plan = planImport(IMPORT_ENTITIES.companies, rows.join("\n"), IMPORT_CONTEXT);
     expect(plan.fatal).toContain(String(MAX_IMPORT_ROWS));
     expect(plan.rows).toHaveLength(0);
   });
--- a/tests/ui/import-profiles.test.ts	2026-08-20 17:14:12.000000000 +0000
+++ b/tests/ui/import-profiles.test.ts	2026-08-20 20:46:54.790649997 +0000
@@ -382,12 +382,12 @@
      * rupee sign in would produce `-₹1,23,456.78`, which reaches
      * `coerceMoneyMinor`'s pattern with a symbol in the middle.
      */
-    expect(coerceMoneyMinor(parsed.value)).toEqual({ ok: true, value: "-12345678" });
+    expect(coerceMoneyMinor(parsed.value, 2)).toEqual({ ok: true, value: "-12345678" });
   });
 
   it("⚠️ and a bracketed amount read by anything that strips punctuation is a POSITIVE", () => {
     /** Which is why this module exists at all. */
-    expect(coerceMoneyMinor("(1,234.00)".replace(/[()]/g, ""))).toEqual({
+    expect(coerceMoneyMinor("(1,234.00)".replace(/[()]/g, ""), 2)).toEqual({
       ok: true,
       value: "123400",
     });
--- a/tests/ui/import-opening.test.ts	2026-08-16 13:17:24.000000000 +0000
+++ b/tests/ui/import-opening.test.ts	2026-08-20 21:04:51.422577926 +0000
@@ -14,6 +14,15 @@
 import { planImport } from "@/lib/import/plan";
 import { OPENING_IMPORT_ENTITIES } from "@/lib/import/opening-entities";
 
+/**
+ * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
+ * `ImportContext`. These files are all about entities whose amounts are
+ * in rupees, so every call passes the same one; the exponent behaviour
+ * itself is proven in `tests/ui/import-money-exponent.test.ts`.
+ */
+const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;
+
+
 const TRIAL_BALANCE = OPENING_IMPORT_ENTITIES["opening-trial-balance"];
 
 describe("hard review: malformed input", () => {
@@ -24,7 +33,7 @@
       "2100,Sundry Creditors,2026-03-31,,500000.00",
     ].join("\n");
 
-    const plan = planImport(TRIAL_BALANCE, badDateFile);
+    const plan = planImport(TRIAL_BALANCE, badDateFile, IMPORT_CONTEXT);
     
     // The file should have a fatal error or row errors
     if (plan.fatal) {
@@ -44,7 +53,7 @@
       "2100,Sundry Creditors,2026-03-31,,500000.00",
     ].join("\n");
 
-    const plan = planImport(TRIAL_BALANCE, badAmountFile);
+    const plan = planImport(TRIAL_BALANCE, badAmountFile, IMPORT_CONTEXT);
     
     // The file should have a fatal error or row errors
     if (plan.fatal) {
@@ -53,7 +62,7 @@
       // If it's a row error, the bad row should have an error
       const badRow = plan.rows[0];
       expect(badRow.errors.length).toBeGreaterThan(0);
-      expect(badRow.errors[0].message).toContain("not an amount");
+      expect(badRow.errors[0].message).toContain("not a valid amount in INR");
     }
   });
 });
@@ -67,7 +76,7 @@
       "3100,Capital,2026-03-31,,100000.00", // Total credit is 400,000, debit is 500,000
     ].join("\n");
 
-    const plan = planImport(TRIAL_BALANCE, unbalancedFile);
+    const plan = planImport(TRIAL_BALANCE, unbalancedFile, IMPORT_CONTEXT);
     
     // An unbalanced trial balance must be refused
     expect(plan.fatal).not.toBeNull();
@@ -83,7 +92,7 @@
       "3100,Capital,2026-03-31,,200000.00", // Total credit is 500,000, debit is 500,000
     ].join("\n");
 
-    const plan = planImport(TRIAL_BALANCE, balancedFile);
+    const plan = planImport(TRIAL_BALANCE, balancedFile, IMPORT_CONTEXT);
     
     // A balanced trial balance must be accepted
     expect(plan.fatal).toBeNull();
@@ -100,7 +109,7 @@
       "3100,Capital,2026-03-31,,200000.00",
     ].join("\n");
 
-    const plan = planImport(TRIAL_BALANCE, balancedFile);
+    const plan = planImport(TRIAL_BALANCE, balancedFile, IMPORT_CONTEXT);
     
     // The batch key should be generated based on the as-at date
     const key = TRIAL_BALANCE.batchKey?.(plan.rows);
@@ -125,8 +134,8 @@
       "3100,Capital,2026-04-01,,200000.00",
     ].join("\n");
 
-    const plan1 = planImport(TRIAL_BALANCE, balancedFile1);
-    const plan2 = planImport(TRIAL_BALANCE, balancedFile2);
+    const plan1 = planImport(TRIAL_BALANCE, balancedFile1, IMPORT_CONTEXT);
+    const plan2 = planImport(TRIAL_BALANCE, balancedFile2, IMPORT_CONTEXT);
     
     const key1 = TRIAL_BALANCE.batchKey?.(plan1.rows);
     const key2 = TRIAL_BALANCE.batchKey?.(plan2.rows);
--- a/tests/ui/opening-balances.test.ts	2026-08-20 17:28:48.000000000 +0000
+++ b/tests/ui/opening-balances.test.ts	2026-08-20 21:04:24.567471683 +0000
@@ -48,6 +48,15 @@
 } from "@/lib/import/opening";
 import { PERMISSION_CATALOG } from "@/db/schema/auth";
 
+/**
+ * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
+ * `ImportContext`. These files are all about entities whose amounts are
+ * in rupees, so every call passes the same one; the exponent behaviour
+ * itself is proven in `tests/ui/import-money-exponent.test.ts`.
+ */
+const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;
+
+
 const ROOT = join(__dirname, "..", "..");
 const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
 
@@ -145,7 +154,7 @@
    * balances is wrong, and the account it is wrong on is a real one.
    */
   it("is refused outright rather than imported", () => {
-    const plan = planImport(TRIAL_BALANCE, OUT_BY_FIFTY_PAISE);
+    const plan = planImport(TRIAL_BALANCE, OUT_BY_FIFTY_PAISE, IMPORT_CONTEXT);
     expect(plan.fatal).not.toBeNull();
     // Nothing may be written: the server writes only rows, and there are none.
     expect(plan.rows).toHaveLength(0);
@@ -157,7 +166,7 @@
    * short is the whole of what is needed to find it.
    */
   it("says how much it is out by and which side is short", () => {
-    const plan = planImport(TRIAL_BALANCE, OUT_BY_FIFTY_PAISE);
+    const plan = planImport(TRIAL_BALANCE, OUT_BY_FIFTY_PAISE, IMPORT_CONTEXT);
     expect(plan.fatal).toContain("0.50");
     expect(plan.fatal).toContain("debit");
     expect(plan.fatal).toContain("500000.00");
@@ -209,7 +218,7 @@
         "Account code,As at,Debit,Credit",
         "1100,2026-03-31,0.00,",
         "2100,2026-03-31,,0.00",
-      ].join("\n"),
+      ].join("\n"), IMPORT_CONTEXT,
     );
     for (const row of plan.rows) expect(row.errors.length).toBeGreaterThan(0);
   });
@@ -233,7 +242,7 @@
         "Account code,As at,Debit,Credit",
         "1100,2026-03-31,500000.00,",
         "3100,2026-04-01,,500000.00",
-      ].join("\n"),
+      ].join("\n"), IMPORT_CONTEXT,
     );
     expect(plan.fatal).toContain("2026-03-31");
     expect(plan.fatal).toContain("2026-04-01");
@@ -242,7 +251,7 @@
 
 describe("a trial balance that does balance", () => {
   it("plans every line with no errors", () => {
-    const plan = planImport(TRIAL_BALANCE, BALANCED);
+    const plan = planImport(TRIAL_BALANCE, BALANCED, IMPORT_CONTEXT);
     expect(plan.fatal).toBeNull();
     expect(plan.rows).toHaveLength(3);
     for (const row of plan.rows) expect(row.errors).toEqual([]);
@@ -259,7 +268,7 @@
       "1100,2026-03-31,999999999999999.99,",
       "3100,2026-03-31,,999999999999999.99",
     ].join("\n");
-    const plan = planImport(TRIAL_BALANCE, huge);
+    const plan = planImport(TRIAL_BALANCE, huge, IMPORT_CONTEXT);
     expect(plan.fatal).toBeNull();
 
     const totals = totalTrialBalance(plan.rows);
@@ -368,7 +377,7 @@
     expect(openingBatchKey("trial_balance", "2026-03-31")).toBe("OPENING:TB:2026-03-31");
     expect(openingBatchKey("stock", "2026-03-31")).toBe("OPENING:STK:2026-03-31");
 
-    const plan = planImport(TRIAL_BALANCE, BALANCED);
+    const plan = planImport(TRIAL_BALANCE, BALANCED, IMPORT_CONTEXT);
     const key = TRIAL_BALANCE.batchKey?.(plan.rows);
     expect(key?.value).toBe("OPENING:TB:2026-03-31");
     expect(key?.label).toContain("2026-03-31");
@@ -469,7 +478,7 @@
    * ledger that does not balance.
    */
   it("imports none of it, including the rows that were fine", () => {
-    const plan = planImport(TRIAL_BALANCE, ONE_BAD_ROW);
+    const plan = planImport(TRIAL_BALANCE, ONE_BAD_ROW, IMPORT_CONTEXT);
     expect(plan.rows).toHaveLength(3);
     for (const row of plan.rows) {
       expect(row.errors.length).toBeGreaterThan(0);
@@ -480,7 +489,7 @@
 
   /** ⚠️ And the clean rows say so, rather than showing a blank reason. */
   it("tells a clean row that it was fine and still was not imported", () => {
-    const plan = planImport(TRIAL_BALANCE, ONE_BAD_ROW);
+    const plan = planImport(TRIAL_BALANCE, ONE_BAD_ROW, IMPORT_CONTEXT);
     const clean = plan.rows[1];
     expect(clean?.errors[0]?.message).toContain("which is fine");
     expect(clean?.errors[0]?.message).toContain("upload the whole file again");
@@ -493,7 +502,7 @@
    * that was wrong.
    */
   it("still hands every row back as a re-uploadable CSV", () => {
-    const plan = planImport(TRIAL_BALANCE, ONE_BAD_ROW);
+    const plan = planImport(TRIAL_BALANCE, ONE_BAD_ROW, IMPORT_CONTEXT);
     const report = buildReport(TRIAL_BALANCE, plan, {
       mode: "preview",
       duplicateMode: "skip",
@@ -552,7 +561,7 @@
   ].join("\n");
 
   it("reads the invoice's own date, to the paisa", () => {
-    const plan = planImport(INVOICES, INVOICE_FILE);
+    const plan = planImport(INVOICES, INVOICE_FILE, IMPORT_CONTEXT);
     expect(plan.fatal).toBeNull();
     const row = plan.rows[0];
     expect(row?.errors).toEqual([]);
@@ -581,7 +590,7 @@
       [
         "Customer,Invoice number,Invoice date,Amount outstanding",
         "Acme Traders,AH/2025/0100,,125000.50",
-      ].join("\n"),
+      ].join("\n"), IMPORT_CONTEXT,
     );
     expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
     expect(plan.rows[0]?.errors[0]?.message).not.toContain("received null");
@@ -594,7 +603,7 @@
       [
         "Customer,Invoice number,Invoice date,Due date,Amount outstanding",
         "Acme Traders,AH/2025/0100,2025-11-14,2025-01-01,1000.00",
-      ].join("\n"),
+      ].join("\n"), IMPORT_CONTEXT,
     );
     expect(plan.rows[0]?.errors[0]?.message).toContain("before the invoice date");
   });
@@ -705,7 +714,7 @@
      */
     const modeReads = [...code.matchAll(/mode === "commit"/g)].map((m) => m.index ?? 0);
     expect(modeReads).toHaveLength(3);
-    const plannerAt = code.indexOf("planImportRecords(entity, params.records)");
+    const plannerAt = code.indexOf("planImportRecords(entity, params.records, planContext)");
     expect(plannerAt).toBeGreaterThan(0);
     for (const at of modeReads) expect(at).toBeGreaterThan(plannerAt);
 
@@ -739,7 +748,7 @@
   /** ⚠️ The planner still takes a file and an entity, and nothing else. */
   it("keeps the planner free of any run-mode argument", () => {
     expect(commentsOnly(PLAN)).toContain(
-      "export function planImport(\n  entity: ImportEntityDefinition,\n  csvText: string,\n): ImportPlan",
+      "export function planImport(\n  entity: ImportEntityDefinition,\n  csvText: string,\n  context: ImportContext,\n): ImportPlan",
     );
   });
 });
--- a/tests/ui/import-sales-entities.test.ts	2026-08-20 19:17:27.000000000 +0000
+++ b/tests/ui/import-sales-entities.test.ts	2026-08-20 20:57:13.642010612 +0000
@@ -34,6 +34,15 @@
 import type { CsvRecord } from "@/lib/import/csv";
 import type { ContractedImportEntity } from "@/lib/import/types";
 
+/**
+ * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
+ * `ImportContext`. These files are all about entities whose amounts are
+ * in rupees, so every call passes the same one; the exponent behaviour
+ * itself is proven in `tests/ui/import-money-exponent.test.ts`.
+ */
+const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;
+
+
 const ROOT = process.cwd();
 const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
 
@@ -63,7 +72,7 @@
   it("accepts a registered customer and fixes the party type itself", () => {
     const plan = planImportRecords(customers, customerFile(
       ["Acme Cements Ltd", "27AAACR5055K1Z7", "regular", "", "2024-04-01"],
-    ));
+    ), IMPORT_CONTEXT);
 
     expect(plan.fatal).toBeNull();
     expect(plan.rows[0]?.errors).toEqual([]);
@@ -85,7 +94,7 @@
   it("refuses a regular customer with no GSTIN, in the schema's own words", () => {
     const plan = planImportRecords(customers, customerFile(
       ["Beta Traders", "", "regular", "27", "2024-04-01"],
-    ));
+    ), IMPORT_CONTEXT);
     const messages = plan.rows[0]?.errors.map((e) => e.message).join(" ") ?? "";
     expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
     expect(messages.toLowerCase()).toContain("gstin");
@@ -94,7 +103,7 @@
   it("refuses a state code that disagrees with the GSTIN's first two digits", () => {
     const plan = planImportRecords(customers, customerFile(
       ["Gamma Steel Pvt Ltd", "27AAACR5055K1Z7", "regular", "29", "2024-04-01"],
-    ));
+    ), IMPORT_CONTEXT);
     expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
   });
 
@@ -114,7 +123,7 @@
         recordNumber: 2,
         cells: ["Delta Supplies", "vendor", "27AAACR5055K1Z7", "regular", "2024-04-01"],
       },
-    ]);
+    ], IMPORT_CONTEXT);
 
     expect(plan.unrecognisedHeaders).toContain("Customer or vendor");
     expect(plan.rows[0]?.payload?.partyType).toBe("customer");
@@ -126,7 +135,7 @@
   it("falls back to the name for an unregistered customer, and labels it weak", () => {
     const plan = planImportRecords(customers, customerFile(
       ["  Epsilon   Hardware  ", "", "unregistered", "", "2024-04-01"],
-    ));
+    ), IMPORT_CONTEXT);
     expect(plan.rows[0]?.errors).toEqual([]);
     expect(plan.rows[0]?.naturalKey).toEqual({
       kind: "legalName",
@@ -138,7 +147,7 @@
   it("omits the address entirely when every part is blank, so an update cannot erase one", () => {
     const plan = planImportRecords(customers, customerFile(
       ["Zeta Ltd", "27AAACR5055K1Z7", "regular", "", "2024-04-01"],
-    ));
+    ), IMPORT_CONTEXT);
     expect(Object.hasOwn(plan.rows[0]?.payload ?? {}, "address")).toBe(false);
   });
 });
@@ -148,7 +157,7 @@
   it("plans a referenced receipt, coerces the money to paise, and asks for the customer", () => {
     const plan = planImportRecords(receipts, receiptFile(
       ["Acme Cements Ltd", "2026-03-14", "1,25,000.50", "neft", "UTR9931", "2500"],
-    ));
+    ), IMPORT_CONTEXT);
 
     expect(plan.fatal).toBeNull();
     expect(plan.rows[0]?.errors).toEqual([]);
@@ -182,7 +191,7 @@
   it("keeps the customer's name through the schema — it is not stripped", () => {
     const plan = planImportRecords(receipts, receiptFile(
       ["Acme Cements Ltd", "2026-03-14", "1000", "upi", "", ""],
-    ));
+    ), IMPORT_CONTEXT);
     expect(plan.rows[0]?.payload?.customerName).toBe("Acme Cements Ltd");
     expect(plan.rows[0]?.naturalKey).not.toBeNull();
     expect(plan.rows[0]?.lookups?.length).toBe(1);
@@ -191,7 +200,7 @@
   it("refuses a receipt with no customer on it, in the preview, with the sentence written for it", () => {
     const plan = planImportRecords(receipts, receiptFile(
       ["", "2026-03-14", "1000", "cash", "", ""],
-    ));
+    ), IMPORT_CONTEXT);
     const messages = plan.rows[0]?.errors.map((e) => e.message) ?? [];
     expect(messages).toContain(
       "Name the customer exactly as their company record is named in Ordence.",
@@ -202,7 +211,7 @@
   it("falls back to a weak key when no reference is given, and says so in the label", () => {
     const plan = planImportRecords(receipts, receiptFile(
       ["Acme Cements Ltd", "2026-03-14", "5000", "cash", "", ""],
-    ));
+    ), IMPORT_CONTEXT);
     expect(plan.rows[0]?.naturalKey?.kind).toBe("unreferenced");
     expect(plan.rows[0]?.naturalKey?.value).toBe("acme cements ltd|2026-03-14|500000|cash");
     expect(plan.rows[0]?.naturalKey?.label).toContain("weak match");
@@ -211,7 +220,7 @@
   it("refuses a method the database's enum does not have", () => {
     const plan = planImportRecords(receipts, receiptFile(
       ["Acme Cements Ltd", "2026-03-14", "5000", "bitcoin", "", ""],
-    ));
+    ), IMPORT_CONTEXT);
     expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
   });
 
@@ -219,7 +228,7 @@
     const plan = planImportRecords(receipts, receiptFile(
       ["Acme Cements Ltd", "2026-03-14", "5000", "neft", "UTR9931", ""],
       ["ACME   cements ltd", "2026-03-14", "5000", "neft", "UTR9931", ""],
-    ));
+    ), IMPORT_CONTEXT);
     expect(plan.rows[0]?.errors).toEqual([]);
     expect(plan.rows[1]?.errors.length).toBeGreaterThan(0);
   });
@@ -238,8 +247,8 @@
       ["Acme Cements Ltd", "2026-03-14", "5000", "neft", "UTR9931", ""],
       ["Beta Traders", "2026-03-15", "2500.75", "cash", "", ""],
     );
-    const first = planImportRecords(receipts, rows).rows.map((r) => r.naturalKey);
-    const second = planImportRecords(receipts, rows).rows.map((r) => r.naturalKey);
+    const first = planImportRecords(receipts, rows, IMPORT_CONTEXT).rows.map((r) => r.naturalKey);
+    const second = planImportRecords(receipts, rows, IMPORT_CONTEXT).rows.map((r) => r.naturalKey);
     expect(second).toEqual(first);
     expect(first.every((k) => k !== null)).toBe(true);
   });
@@ -247,10 +256,10 @@
   it("a differently-spelled customer name lands on the same key", () => {
     const a = planImportRecords(receipts, receiptFile(
       ["Acme Cements Ltd", "2026-03-14", "5000", "neft", "utr9931", ""],
-    )).rows[0]?.naturalKey?.value;
+    ), IMPORT_CONTEXT).rows[0]?.naturalKey?.value;
     const b = planImportRecords(receipts, receiptFile(
       ["  ACME   Cements   Ltd ", "2026-03-14", "5000", "neft", "UTR9931", ""],
-    )).rows[0]?.naturalKey?.value;
+    ), IMPORT_CONTEXT).rows[0]?.naturalKey?.value;
     expect(a).toBe(b);
   });
 
--- a/tests/ui/import-migration.test.ts	2026-08-19 09:17:56.000000000 +0000
+++ b/tests/ui/import-migration.test.ts	2026-08-20 20:57:13.642453898 +0000
@@ -30,6 +30,15 @@
 import { IMPORT_ENTITIES } from "@/lib/import/entities";
 import type { CsvRecord } from "@/lib/import/csv";
 
+/**
+ * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
+ * `ImportContext`. These files are all about entities whose amounts are
+ * in rupees, so every call passes the same one; the exponent behaviour
+ * itself is proven in `tests/ui/import-money-exponent.test.ts`.
+ */
+const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;
+
+
 const ROOT = process.cwd();
 const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
 const codeOnly = (source: string) =>
@@ -50,7 +59,7 @@
       { recordNumber: 2, cells: ["Acme Ltd", "acme.example"] },
       { recordNumber: 3, cells: ["Beta Ltd", "beta.example"] },
     ];
-    const plan = planImportRecords(entity, records);
+    const plan = planImportRecords(entity, records, IMPORT_CONTEXT);
     expect(plan.fatal).toBeNull();
     expect(plan.rows).toHaveLength(2);
     expect(plan.rows.every((r) => r.errors.length === 0)).toBe(true);
@@ -59,7 +68,7 @@
   it("refuses a header row with nothing under it, in the same words", () => {
     const plan = planImportRecords(IMPORT_ENTITIES.companies, [
       { recordNumber: 1, cells: ["Name"] },
-    ]);
+    ], IMPORT_CONTEXT);
     expect(plan.fatal).toMatch(/header row and no data rows/);
   });
 
@@ -72,7 +81,7 @@
     for (let i = 0; i < MAX_IMPORT_ROWS + 1; i += 1) {
       rows.push({ recordNumber: i + 2, cells: [`Company ${i}`] });
     }
-    const plan = planImportRecords(IMPORT_ENTITIES.companies, rows);
+    const plan = planImportRecords(IMPORT_ENTITIES.companies, rows, IMPORT_CONTEXT);
     expect(plan.fatal).toMatch(new RegExp(String(MAX_IMPORT_ROWS)));
   });
 });
--- a/tests/security/import-receipts-rerun.test.ts	2026-08-20 19:17:27.000000000 +0000
+++ b/tests/security/import-receipts-rerun.test.ts	2026-08-20 20:57:13.643014517 +0000
@@ -35,6 +35,15 @@
 import { asSuperuser, asTenant, testPool } from "../setup";
 
 /**
+ * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
+ * `ImportContext`. These files are all about entities whose amounts are
+ * in rupees, so every call passes the same one; the exponent behaviour
+ * itself is proven in `tests/ui/import-money-exponent.test.ts`.
+ */
+const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;
+
+
+/**
  * ⚠️ MOCKED BEFORE THE WRITER IS IMPORTED, because the writer imports
  * `withTenant` at module load. The replacement is `db/index.ts`'s own
  * body over `drizzle-orm/node-postgres` and the suite's pool: the tenant
@@ -142,7 +151,7 @@
  * a row the commit does not land.
  */
 async function runImport(): Promise<{ created: number; skipped: number }> {
-  const plan = planImportRecords(SALES_IMPORT_ENTITIES.receipts, FILE);
+  const plan = planImportRecords(SALES_IMPORT_ENTITIES.receipts, FILE, IMPORT_CONTEXT);
   expect(plan.fatal).toBeNull();
   expect(plan.rows.every((r) => r.errors.length === 0)).toBe(true);
 
--- a/tests/security/import-crm-entities.test.ts	2026-08-20 18:07:08.000000000 +0000
+++ b/tests/security/import-crm-entities.test.ts	2026-08-20 20:57:13.643836346 +0000
@@ -48,6 +48,15 @@
 import type { TenantContext } from "@/server/tenant-context";
 import { asSuperuser } from "../setup";
 
+/**
+ * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
+ * `ImportContext`. These files are all about entities whose amounts are
+ * in rupees, so every call passes the same one; the exponent behaviour
+ * itself is proven in `tests/ui/import-money-exponent.test.ts`.
+ */
+const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;
+
+
 const RUN = randomUUID().slice(0, 8);
 
 type Fixtures = { tenant: string; user: string; acme: string };
@@ -135,7 +144,7 @@
   const entity = ALL_IMPORT_ENTITIES[entityKey];
   const writer = IMPORT_WRITERS[entity.table];
 
-  const plan = planImport(entity, csv);
+  const plan = planImport(entity, csv, IMPORT_CONTEXT);
   const dispositions = new Map<number, Disposition>();
   const errors = new Map<number, string[]>();
 
```
