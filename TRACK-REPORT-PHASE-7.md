# TRACK-REPORT — Phase 7, inventory entities

Repo `app.ordence`, build **v1.85.0-alpha**, the tree that shipped in
`ordencePHASE7.zip`. Nothing here was worked against any other version.

---

## 0. The tree, confirmed before anything was written

The brief asks for four commands and says to stop if the last one does not
print 6 entities and a 2-wave load order.

```
$ npx tsc --noEmit
(no output)

$ npm run gates:static
  28/28 passed

$ npm run check:import-contract
✅ check:import-contract
   6 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills

$ npm run check:writer-registry
✅ check:writer-registry
   Induction: adding an unregistered destination FAILED to compile, and the
   error named the registry. Restored tree compiles clean.
```

Right tree. Phase 1 is in it.

⚠️ **One thing the brief did not mention and I am not going to leave out: the
shipped tree's test suites are already red.** Measured on a pristine unzip,
before I changed a character:

```
$ npx vitest run --project=ui         →  12 failed | 6687 passed | 8 skipped (6707)
$ npx vitest run --project=security   →   2 failed | 1518 passed (1520)
```

The twelve are ten in `tests/ui/opening-balances.test.ts`, one in
`tests/ui/csv-import.test.ts` and one in `tests/ui/assemble-wave.test.ts`;
the two are both in `tests/security/tax-call-sites.test.ts`
(`server/import/writers/sales-invoices.ts writes sales_invoices` with no entry
in the tax call-site register). All of them are Phase 1's move of code out of
`server/actions/import.ts` colliding with tests that read that file's source
and with a register keyed on file paths. **After my work the same 12 and the
same 2 fail, by name, and nothing else does** — plus 17 new passing tests. I
did not fix them: `tests/ui/**`, `server/tax/call-sites.ts` and
`server/import/writers/sales-invoices.ts` are not mine, and a phase that
quietly repairs another phase's tests is a phase whose own result cannot be
read.

---

## 1. What shipped

Three entities, three writers, one migration, one validator module, one
database-backed test suite.

| Entity | Destination | Wave | Duplicate modes | Reversal |
|---|---|---|---|---|
| `stock-items` | `stock_items` | 0 | skip · update · fail | `restore-prior` `["*"]` |
| `warehouses` | `warehouses` | 0 | skip · update · fail | `restore-prior` `["*"]` |
| `batches` | `stock_batches` | 1 | skip · fail | `delete` |

```
$ npm run check:import-contract
✅ check:import-contract
   9 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, opening-trial-balance, stock-items, warehouses
     wave 1: batches, opening-customer-invoices, opening-stock, opening-vendor-bills
```

⭐ **The census names the three, in the waves I expect, and it moved
`opening-stock` out of wave 0** — see §3.

Files in this zip, at real repo paths:

```
lib/import/entities-inventory.ts                    (mine alone)
lib/validators/inventory.ts                         (new; see §2)
server/import/writers/inventory/stock-items.ts      (mine alone)
server/import/writers/inventory/warehouses.ts
server/import/writers/inventory/stock-batches.ts
SQL-FILES/0250_stock_batches_tenant_scoped_item.sql (my block, 0250–0259)
tests/security/import-inventory.test.ts
TRACK-REPORT.md
PATCH-REQUEST-PHASE-7.md
```

Seven changes in files I do not own are in `PATCH-REQUEST-PHASE-7.md`, as
diffs, all of them applied and gate-tested locally.

---

## 2. Two of the five briefed entities are NOT READY, and that is a finding

Step 1 of the brief: *"If there is no schema for this thing, the entity is not
ready and you should say so in your report rather than writing one."* Two of
the five are worse than that — the DESTINATION is wrong.

### 2.1 `units-of-measure → units` would have imported flats

`units` is real estate.

```
$ sed -n '320,336p' db/schema/sales.ts
export const units = pgTable(
  "units",
  {
    id: ...,
    projectId: uuid("project_id").notNull().references(() => projects.id, ...),
    /** e.g. "A-1203". Unique within the project. */
    code: varchar("code", { length: 60 }).notNull(),
    tower: ..., floor: ..., typology: ...,   /* "2BHK", "3BHK", "Penthouse" */
    carpetAreaSqft: ...,                     /* RERA requires carpet area ... */
```

A unit of measure is not a row in that table, and there is no
unit-of-measure master anywhere in the 313 tables:

```
$ grep -rln "unit_of_measure\|units_of_measure\|uom_master" db lib server
(no output)
```

The stocking unit is `stock_items.uom`, a `varchar(20)` **on the item**, and
`db/schema/inventory.ts` says why it is there rather than in a table: *"every
quantity in the ledger is in it … conversions happen at the edges — on a
purchase order, on a delivery note — and never inside."*

🔴 **This also corrects the brief's dependency claim.** It says "Wave 0. Items
depend on these." Items depend on nothing: `stock-items.contract.dependsOn`
is `[]`, and it has to be, because a dependency on an entity that does not
exist is refused by gate 29 — correctly, since it would put a step in the
customer's migration plan they can never complete.

⚠️ Note what would have happened without Phase 1. `"units"` is a real table
name; a writer aimed at it would have compiled. Before Phase 1, an entity
whose destination had no branch fell through to the *unguarded code after the
last `if`* and **wrote a GST party**. The registry is why the worst outcome
available here was a compile error.

### 2.2 `price-lists → price_list_items` — the table does not exist, on purpose

```
$ grep -rn "price_list" db/schema/*.ts SQL-FILES/*.sql
SQL-FILES/0057_pricing_discounts.sql:18:--  ⚠️ A `customer_price_lists` TABLE WOULD HAVE BEEN THE OBVIOUS THING
SQL-FILES/0057_pricing_discounts.sql:421:--  NO `customer_price_lists` TABLE. See the header.
```

0057's header refuses it by name:

> 🔴 THERE IS NO NEW PRICE LIST TABLE. … A `customer_price_lists` TABLE WOULD
> HAVE BEEN THE OBVIOUS THING TO WRITE, AND IT WOULD HAVE BEEN THE MISTAKE.
> Two tables answering "what does this cost this customer today" is two
> answers, and the wrong one is whichever the invoice screen happens to read.

Prices live in `rate_cards` / `rate_slabs`, which carry a customer, a subject,
a priority, a half-open validity window, a currency, a tax rate and
`slab_mode` — *"whether 'first 100 at ₹4.50, next 200 at ₹6.20' is read
progressively or flat. That distinction is 27% of the bill on a common
example."*

So a price-list importer is a **pricing** entity with a validity window and a
slab mode, not an inventory one, and writing it would have meant either
creating the banned table or inventing a flattened shape for `rate_slabs`
that discards `slab_mode`. It needs a product decision and it is not this
phase's to make. Reported, not written.

### 2.3 There was no `lib/validators/inventory.ts`, and there could not be

`warehouseSchema` and `stockItemSchema` existed — as unexported `const`s
inside `server/actions/inventory.ts`, which carries `"use server"`. A
`"use server"` module may export **only async functions**, and `lib/import/`
may not import from `server/` at all (`check:boundaries`, and the purity
argument in `lib/import/types.ts`). So "the schema is the one the form uses"
was a rule this phase could not obey without breaking another one.

⭐ The schemas moved to `lib/validators/inventory.ts` **unchanged** — every
regex, bound and message — and `server/actions/inventory.ts` imports them
back (patch ⑤). One definition, two callers.

`stockBatchSchema` had no original to move: there is no "new batch" form and
never was, because a batch row is born inside the movement trigger in SQL
0055. That puts it in the same position as
`lib/import/opening-schemas.ts` — this file **is** the original, and the rule
points forwards: a future batch form must import it.
`batchUpdateSchema` in `server/actions/batches.ts` is NOT a second copy of it:
that one validates a *correction command* (`batchId` + a mandatory
ten-character reason), this one validates a *batch*.

---

## 3. `opening-stock` was in the wrong wave and would have failed on every row

🔴 The most consequential thing found this phase, and it is not in my files.

`opening-stock` has declared `stock_item_by_sku` and `warehouse_by_code`
lookups since Batch 58, with `missing` sentences already written. Its
contract declared **no dependency on either** — because there was no entity
to name, and `checkImportContract()` refuses a dependency on an entity that
does not exist. So `resolveImportOrder()` put it in **wave 0** and the wizard
told the customer to load it first, into a workspace with no items and no
warehouses, where every single row comes back unresolved with a message
telling them to fix something the product would not let them fix in bulk.

Patch ④ adds the two `hard` edges and one `soft` edge (batches), and the
census moves it to wave 1. Both edges are `hard` and there is no softness to
argue about: unlike the contacts worked example, **both** lookups are emitted
for **every** row, because both cells are required headers the schema refuses
blank — so out of order the file fails completely, not partially.

The `soft` batches edge earns its keep separately: SQL 0055's trigger creates
any lot a movement names, **with a NULL expiry**, and `opening-stock` has no
expiry column. Load stock first and every lot in the workspace has no printed
date — on exactly the items that were marked batch-tracked because their dates
matter — and the `batches` importer will then skip them as already present.

---

## 4. `contract.requiredness` is declared, checked, and never read

```
$ grep -rn "requiredness" lib/import/plan.ts lib/import/report.ts server/actions/import.ts | wc -l
0
```

Every match in the repository is in `contract/check.ts` (gate 29's coherence
check) or in a declaration. Nothing on the write path consults it.

`lib/import/types.ts` claims otherwise — *"the planner reports a row missing a
structural field as `error` with a sentence naming what is missing, BEFORE the
write, in the dry run"* — and `opening-policies.ts` repeats it:
*"Without this declaration, an unresolvable customer becomes a foreign-key
violation at write time."* Neither is true today. What actually refuses those
rows is the missing-lookup branch in `resolveLookups`, which is a different
mechanism with a different message source (`lookup.missing`, not
`requiredness.messages`).

⚠️ **This is not currently causing damage**, because for all four opening
entities and all three of mine the same absence is refused by the Zod schema
or by an always-emitted lookup. It is a declared-and-unenforced member with
two comments asserting it is enforced, which is one refactor away from being
the real thing.

⭐ **How this phase handled it rather than relying on it.** `batches` declares
`stockItemId` structural AND emits the lookup unconditionally for every row,
so the refusal happens in something that runs, with the sentence the entity
wrote. There is a test that asserts the behaviour, not the declaration:

```
✓ names the SKU that matched nothing, in the sentence the entity wrote
```

`stock-items` and `warehouses` declare `structural: []` deliberately, for the
reason the contacts example gives: a second copy of "the SKU is required" is
the copy that would still say `sku` after somebody renamed the field.

---

## 5. Reversal cannot be tested, because provenance does not exist

```
$ grep -rn "import_row_provenance" --include=*.ts --include=*.sql .
lib/import/types.ts:337: * ⭐ SO PROVENANCE IS A SIDECAR: one table, `import_row_provenance`,
lib/import/types.ts:356:   * discriminants used by `import_row_provenance.target_table`.
```

Two comments. No table, no SQL 0196 (the highest numbered migration in this
tree is 0168), no writer of it, nothing capturing prior values for a
`restore-prior`. So the brief's fourth proof — *"Undo restores the prior state
exactly"* — **cannot be run in this tree by anybody**, for any of the nine
entities, and a test asserting it would be a test asserting nothing. That is
the honest answer and I am not dressing it up.

⭐ What I proved instead is the property each of my reversal policies depends
on:

- **`batches` declares `delete`, and that is only safe because no run can ever
  overwrite a lot.** Asserted, not assumed: the action refuses `update` for
  this entity outright, and a re-run against a lot that already exists leaves
  its expiry and status byte-identical.
- **`stock-items` / `warehouses` declare `restore-prior ["*"]`** because they
  offer `update`. Gate 29 refuses `update` + `delete` by name; the test
  asserts the other half — that a pre-existing record carrying a field no
  column maps to (`is_active`, a hand-typed description) survives a `skip`
  run unchanged, which is exactly what an undo would have to put back.

Both `escapes` sentences are real and are shown before the run: an item or a
warehouse with movements against it cannot be deleted (`ON DELETE RESTRICT`),
and neither can a lot that has been moved (`stock_movements.batch_id`).

---

## 6. A lookup resolved onto a soft-deleted item. Proven, then fixed.

`resolveLookups` filters `stock_items` on `is_active` and never on
`deleted_at`, while `stock_items_tenant_sku_unique` is a **partial** index
excluding deleted rows — so a deleted `CEM-53` and a live `CEM-53` can coexist
and the lookup can return the deleted one. `warehouses` is the same shape.

Measured, by previewing one row naming a soft-deleted SKU on the unpatched
tree:

```
PROBE RESULT: {"create":1,"update":0,"skip":0,"error":0}   errors: []
```

The dry run promising a lot attached to an item nobody can see. With patch ⑥:

```
PROBE RESULT: {"create":0,"update":0,"skip":0,"error":1}
errors: [{"message":"There is no active stock item with SKU \"DEL-1\" ..."}]
```

⚠️ **`opening-stock` resolves these same two lookups**, so on the shipped tree
it will post a customer's whole opening quantity onto a deleted item and
report success. Regression test:
`a deleted stock item is not a match, and the row is refused with the entity's sentence`.

**Related, not fixed:** the lookup matches `lower(sku)` while the unique index
is case-sensitive, so a workspace CAN hold `ABC` and `abc` as two items, and
which one the lookup returns is whichever row Postgres hands back first. My
writers match case-insensitively — **deliberately stricter than the index** —
so an import can never create the second spelling. Making the index itself
case-insensitive is a change to a live table with existing data in it and
belongs to whoever owns `stock_items`, not to an entity phase.

---

## 7. SQL 0250 — a batch could belong to another tenant's item

`SQL-FILES/0250_stock_batches_tenant_scoped_item.sql`, my block, my number.

0029's own header: *"A plain `warehouse_id -> warehouses(id)` says the parent
EXISTS. It does not say the parent is MINE"* — and it rewrote eight inventory
foreign keys as composite `(tenant_id, parent_id)` keys. **`stock_batches` was
created afterwards, in 0055, and missed that treatment.** A batch row carrying
tenant A's `tenant_id` and tenant B's `stock_item_id` satisfied everything:
the FK (the item exists), the RLS policy (it tests the batch's own
`tenant_id`), and the unique index (scoped by tenant, first such row).

This phase is the one that closes it because this phase adds an importer whose
whole job is to write `stock_item_id` from a spreadsheet value.

Applied to a real database and proved by induction rather than by reading it:

```
$ psql -d ordence_test -f SQL-FILES/0250_stock_batches_tenant_scoped_item.sql
NOTICE:  0250 OK — stock_batches.(stock_item_id, tenant_id) references stock_items.(id, tenant_id).

$ psql -d ordence_test -f SQL-FILES/0250_...sql     # again, unchanged
NOTICE:  0250 OK — ...                              # idempotent

✓ refuses a batch pointing at another tenant's item, even as the superuser
    → the insert failed with constraint "stock_batches_item_tenant_fkey"
```

Notes on the file itself, because three gate rules bit:

- **No `BEGIN`/`COMMIT`.** `check:sql-rls-writes` refused them, and its reason
  is right: a browser SQL console sends each statement on its own connection,
  so a wrapper gives the appearance of atomicity and none of it. Every
  statement is independently idempotent instead.
- **`IF EXISTS`, never `count(*) > 0`.** A count compared to a literal in a
  pass/fail decision is the floor idiom `check:sealed-grants` refuses.
  §3's assertions are exact (`<> 2`, `<> 0`).
- **It creates `stock_items_id_tenant_unique` itself, `IF NOT EXISTS`.** That
  index is declared in `db/schema/inventory.ts` and shipped in
  `RUN-THESE-IN-ORDER-14.sql`, which is **not** a numbered migration — a
  composite FK depending on a file outside the numbered sequence is a
  migration that fails on a database built from `SQL-FILES/0001..0249`.
- **§1 refuses to run if the hole has already been used**, naming the count
  and an offending row, rather than repairing it. A cross-tenant batch is a
  tenant-isolation breach; a migration that "fixed" it by nulling a column
  would destroy the evidence.

---

## 8. Proof — 17 tests, against a real Postgres, as a role with NOBYPASSRLS

`tests/security/import-inventory.test.ts` runs the **real** server actions —
`previewImport` and `commitImport` out of `server/actions/import.ts`, the real
planner, the real lookup resolution, the real writers — against PostgreSQL 16
with all 154 SQL files applied and RLS forced on 319 tables. Only the four
auth/billing gates are mocked; they are proved elsewhere.

⚠️ **This is deliberately not another source-reading test.** Every existing
import test asserts that a line is present in a file. No amount of reading
`entities-inventory.ts` can answer "if the customer uploads the same file
twice, is the data there once or twice", because the answer depends on a
natural key agreeing with a partial unique index across a `lower()` on both
sides, in SQL, with RLS on.

```
$ npm run test:bootstrap
  apply the numbered SQL files, in order… ✅  154 files, 0 statement(s) refused
  confirm row-level security is actually enabled… ✅  319 tables protected
  confirm ordence_app cannot create a table… ✅  no CREATE, no owned tables

$ npx vitest run --project=security tests/security/import-inventory.test.ts
  Connected to: ordence_test as ordence_app
  RLS check: ✅ non-superuser role — isolation tests are meaningful

 ✓ the three entities are reachable at all > are in the one allowlist, with the destinations Phase 1 requires
 ✓ a re-run … > stock items: 3 created, then 0 created and 3 skipped, and the table still has 3
 ✓ a re-run … > warehouses: the same, on the code
 ✓ a re-run … > batches: the same, on the item AND the lot together
 ✓ a re-run … > a file that shouts the SKUs is still the same three items
 ✓ the preview promises exactly what the commit does > a batch file naming an SKU that is not there fails identically in both runs
 ✓ the preview promises exactly what the commit does > the preview writes nothing at all
 ✓ refused in the PREVIEW > names the SKU that matched nothing, in the sentence the entity wrote
 ✓ refused in the PREVIEW > and the failed-rows CSV hands the row back exactly as it arrived
 ✓ refused in the PREVIEW > an expiry before the manufacture date is refused before the write, not by the CHECK constraint
 ✓ quantity is not money and is not a float > 12.5 in the file is 12.500 in numeric(18,3), not 12500
 ✓ quantity is not money and is not a float > and three decimals survive a number that a float would round
 ✓ what an undo would have to put back > `skip` leaves a pre-existing record byte-identical, including fields no column maps to
 ✓ what an undo would have to put back > `batches` cannot be run in overwrite mode at all — the action refuses before the guard
 ✓ what an undo would have to put back > and a lot that was already there keeps the expiry somebody put on it
 ✓ tenant isolation … > refuses a batch pointing at another tenant's item, even as the superuser
 ✓ a lookup must not resolve onto a soft-deleted record > a deleted stock item is not a match …

 Tests  17 passed (17)
```

### 8.1 The tests were checked by breaking the code they test

A test that has never failed is a test nobody has any reason to believe. Three
mutations, each reverted immediately:

| Mutation | Result |
|---|---|
| `reorderLevel: quantityCell(...)` → pass the raw coerced cell | 2 failed — `expected '12500.000' to be '12.500'`, `expected '1250750.000' to be '1250.750'` |
| `inArray(sql`lower(sku)`, …)` → `inArray(stockItems.sku, …)` in the items writer | 3 failed, including the re-run test and the shouted-SKU test |
| delete `writeRow` from `warehousesWriter` | the whole file failed to load: *"Import writer for "warehouses" declares NEITHER writeRow nor writeFile"* |

⭐ The third one is worth naming: that guard is the registry's module-load
check, and this suite is what executes it, because importing
`server/actions/import.ts` imports the registry.

### 8.2 What the numbers say, in words

- **Re-run safety.** Three entities, three files, uploaded twice each: 3+2+2
  rows created on the first run, **0** on the second, and the tables still
  hold 3, 2 and 2. Plus a fourth case the database itself would have allowed
  — the same file with the SKUs in lower case — which also creates nothing.
- **Preview equals commit, including when a lookup misses.**
  `expect(preview.counts).toEqual(commit.counts)` on a file with one
  unresolvable SKU in it, and the commit moved the row count by zero.
- **A row missing a structural field is refused in the PREVIEW**, with the
  sentence the entity wrote, and the failed-rows CSV hands back
  `"  NOPE-9  "` — leading and trailing spaces intact — so the customer can
  find the row in their own file.
- **Quantity is not money and is not a float.** `12.5` in the file is
  `12.500` in `numeric(18,3)`; `1250.750` survives to the third decimal. The
  conversion is the one thing between "reorder level 12.5 bags" and "reorder
  level 12,500 bags", and it validates cleanly either way — which is why it
  has a test with a mutation behind it.

---

## 9. Gates, with everything applied

```
$ npx tsc --noEmit
(no output)

$ npm run gates:static
  ✅ check:boundaries        ✅ check:import-contract   ✅ check:writer-registry
  ✅ check:migrations        ✅ check:sql               ✅ check:rls-writes
  ✅ check:sql-rls-writes    ✅ check:tenant-isolation  ✅ check:track-ownership
  … 28/28 passed

$ npx vitest run --project=security      2 failed | 1535 passed (1537)   (the 2 pre-existing, §0)
$ npx vitest run --project=ui           12 failed | 6687 passed (6707)   (the 12 pre-existing, §0)

   security: 1520 tests before, 1537 after — +17, all mine, all passing.
   The two failures are the same two, by name; the twelve are the same twelve.
```

⚠️ **`next build` was not run, and I am not claiming it passes.** This
container has 8 GB and 2 vCPUs and the Next compile was killed by the OOM
reaper twice, including with `--max-old-space-size=6000`. That is an
environment limit, not a finding about the code — but "the build is green" is
a claim I have no evidence for, so I am not making it. The one build-time
behaviour my files add — the registry's module-load check over the three new
writers — is exercised by the test suite, and §8.1 shows it firing.

---

## 10. Decisions worth arguing with

- **`batches` offers no `update`.** SQL 0055 refuses a receipt that disagrees
  with a lot's recorded expiry, so that correcting it is *"a deliberate act
  rather than something a receipt should do quietly"*, and `updateBatch`
  demands a written reason. An importer offering overwrite would be the quiet
  path around that rule, five hundred lots at a time. The cost is real: a
  customer who imports batches with wrong dates must correct them one at a
  time. I think that is the right trade and it is the reason the load ORDER
  matters rather than a limitation somebody can work around.
- **`stock-items` and `warehouses` recommend `skip`, not `update`.** An item's
  valuation method restates the cost of everything sold against it; a
  warehouse's GSTIN and its negative-stock permission change how tax and
  valuation are computed for everything in it. `update` is offered, because a
  corrected master file is a real thing customers have — but it is a decision
  somebody makes, with the reason next to the radio button.
- **No Project column on `warehouses`**, though the schema has `projectId`.
  There is no `project_by_code` lookup kind, and inventing one inside an
  entity phase means two tracks with two resolvers. A heading in the blank
  template with nothing behind it is the built-and-unreachable shape this
  project keeps finding.
- **No `Active` column on either master.** Neither `stockItemSchema` nor
  `warehouseSchema` has an `isActive` member — the forms do not offer it — so
  an import cannot deactivate a record. Adding the column would have meant
  widening the schema the form uses, which is the one thing the framework
  says not to do.
- **Case-insensitive natural keys, stricter than the database.** Discussed in
  §6. The cost is a row reported as a duplicate that Postgres would have
  accepted, which the customer can see in the report. The cost of the other
  choice is an ambiguous item master, which nobody sees.
