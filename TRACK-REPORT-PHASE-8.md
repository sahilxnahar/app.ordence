# TRACK-REPORT.md — Phase 8, accounting and master data

Repo `app.ordence`, build **v1.85.0-alpha**, unpacked from
`ordence-DEPLOY-v1.85.0-alpha.zip` as instructed. No other version was fetched
or assumed.

**Three entities are delivered. Five are refused, each with the command that
proves it.** The brief's own first instruction is what decides them:

> *"Find the existing validator. If there is no schema for this thing, the
> entity is not ready and you should say so in your report rather than writing
> one."*

Everything below is a claim with the command that produced it and the output
that would have differed if the claim were false.

---

## §0 — THE TREE WAS CONFIRMED BEFORE ANYTHING WAS WRITTEN

```
$ npx tsc --noEmit                       # exit 0, no output
$ npm run gates:static                   # 28/28 passed
$ npm run check:import-contract
✅ check:import-contract
   6 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills
$ npm run check:writer-registry
✅ check:writer-registry
   server/actions/import.ts carries 0 literal destination comparisons.
   Induction: adding an unregistered destination FAILED to compile, and the
   error named the registry. Restored tree compiles clean.
```

**6 entities and a 2-wave load order, as the brief said it must print.** Phase 1
is in this tree: the four `entity.table === …` chains are gone and
`IMPORT_WRITERS` is a `Record` over the destination union.

⚠️ **A real PostgreSQL was stood up, because most of what this phase claims
cannot be proven by reading source.**

```
$ node scripts/bootstrap-test-db.mjs --force
  push the base schema (drizzle-kit)…                 ✅  308 base tables
  apply ALL-IN-ONE-SETUP.sql (the base tables)…       ✅  461 statements, 0 refused
  apply the numbered SQL files, in order…             ✅  154 files, 0 refused
  confirm row-level security is actually enabled…     ✅  319 tables protected
  confirm ordence_app cannot create a table…          ✅  no CREATE, no owned tables
✅ Ready.
```

The suite connects as `ordence_app`, **NOSUPERUSER NOBYPASSRLS**, so a missing
policy is a failing test rather than a test that passes for the wrong reason.

---

## §1 — WHAT IS DELIVERED

| Entity | Destination | Schema — and whose | Wave |
|---|---|---|---|
| `chart-of-accounts` | `ledgers` | `createLedgerSchema`, the one `createLedger` parses | 0 |
| `cost-centres` | `cost_centres` | `costCentreSchema`, the one `createCostCentre` parses | 0 |
| `tax-codes` | `hsn_sac_codes` | `createHsnSacSchema`, the one `createHsnSacCode` parses | 0 |

Files, at real repo paths from the repo root:

```
lib/import/entities-accounting.ts                     (the three entities, one exported map)
server/import/writers/accounting/ledgers.ts
server/import/writers/accounting/cost-centres.ts
server/import/writers/accounting/hsn-sac-codes.ts
```

Everything else the phase needed is in a file it does not own and is in
`PATCH-REQUEST-PHASE-8.md` — including the proof suite, which lives under
`tests/security/`.

The zip also carries **one file Phase 8 does not own**, deliberately and
declared:

```
tests/security/import-accounting.test.ts              (Track D's / Track H's)
```

⚠️ **The ownership gate flags it, and that is the point of shipping it at its
real path rather than hiding it in a folder the gate does not read.** Run
against the delivered listing, with `PHASE-8` added to the map (patch request
item 0):

```
$ node scripts/check-track-ownership.mjs --track PHASE-8 --files <zip listing>
check:track-ownership , violations:

  x track PHASE-8 wrote outside its ownership: tests/security/import-accounting.test.ts

1 violation(s).
```

**One violation, and it is the one named in the patch request.** With that file
removed from the listing the delivery is clean:

```
$ node scripts/check-track-ownership.mjs --track PHASE-8 --files <the four owned files + two reports>
OK track PHASE-8: 6 delivered files, all inside its block
```

The suite is what proves every behavioural claim in this report, so shipping it
somewhere the gate cannot see would have been the worse trade. Item 7 of the
patch request asks Track D or integration to adopt it.

**SQL block 0260–0274 is unused and stays free.** All three destinations already
exist and provenance is M1's `import_row_provenance` sidecar from 0196. A phase
that invents a migration it does not need turns `check:migrations` red for every
parallel stream that follows it.

---

## §2 🔴🔴 — THE KEYSTONE, AND WHAT IT COST

The brief calls this *"the one change in the whole migration that moves every
other track's wave number"*, and it does.

`opening-trial-balance` declared `dependsOn: []`, and
`lib/import/contract/opening-policies.ts` argued it: *"the chart of accounts is
not imported — it is seeded when the workspace is created… expressing it as a
dependency on an entity that does not exist would put a permanent dangling key
in the graph."* That was true when written. This phase makes the last clause
false, so the dependency was added — item 1 of the patch request.

**Measured, not reasoned:**

```
$ npm run check:import-contract
✅ check:import-contract
   9 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: chart-of-accounts, companies, cost-centres, gst-parties,
             opening-stock, tax-codes
     wave 1: opening-customer-invoices, opening-trial-balance,
             opening-vendor-bills
```

⚠️ **The first draft of this report was wrong about this and the checker caught
it.** It said `opening-customer-invoices` and `opening-vendor-bills` would move
to wave 2 behind the trial balance. They do not: their edge to the trial balance
is `soft`, and only `hard` edges constrain the order. Their hard edges are on
`companies` and `gst-parties`, which are still wave 0. The claim was corrected
in the source comment as well as here, because a comment asserting a wave number
nobody re-ran is the next reader's false fact.

**Why the edge is `hard` and not `soft`** — a soft edge says the rows succeed and
are less complete. These rows do not succeed. Proven by execution
(`tests/security/import-accounting.test.ts` §7): an opening trial balance naming
an account that is not yet in the workspace is refused **in the preview**, every
line, about a file that is perfectly correct — and the same file passes with
`create: 2, error: 0` once the chart of accounts has been imported by the entity
delivered here.

---

## §3 — THE FIVE ENTITIES THAT ARE NOT DELIVERED

Each was refused, not forgotten. Each refusal has a command.

### 3.1 `journals` — the framework cannot express "many documents per file"

🔴 **This is the most important finding in the phase and it is a framework
limit, not a missing writer.**

The framework has exactly two shapes: **one document per FILE**
(`writeFile` — the opening trial balance) and **one document per ROW**
(`writeRow` — everything else). A general journal file is **many documents per
file**: R lines across V vouchers, each voucher one balanced transaction.

Every leg of one voucher must share a natural key, because the thing a re-run
must not create twice is the VOUCHER, not the line. `planImportRecords` refuses
the second row carrying a key the first row already had — deliberately, and its
comment argues the case well for the entities it was written for. Executed:

```
$ npx tsx /tmp/journals-proof.mts
① two legs of ONE voucher, planned:
   row 2: errors=0
   row 3: errors=1  This is the same account as row 2 — both have voucher
                    JV-0001. Only one row per account can be imported in a
                    single file; decide which of the two is right and delete
                    the other.
```

**A two-line voucher loses its second line before it reaches the database.**
Every workaround is worse:

- keying on `voucher + line number` — nothing in `journal_entries` holds a line
  number, so `findExisting` has nothing to match on and re-run safety is gone;
- `batchKey` over the whole file — that is one key for one document, and a
  journal file is many;
- one voucher per file — re-run safe and correct, and it means a customer with
  4,000 vouchers uploads 4,000 files.

The honest fix is a `documentKey(row)` member on the entity: the in-file
duplicate check keys on `(documentKey, line)`, `findExisting` keys on
`documentKey`, and the writer receives rows grouped. That is a change to
`lib/import/plan.ts` and `server/actions/import.ts` — M1's and Phase 1's — and
it is a phase of its own, not a paragraph in this one.

**⚠️ AND THERE IS A SECOND, INDEPENDENT BLOCKER.** `lib/import/plan.ts:94` reads

```ts
case "money":
  return coerceMoneyMinor(raw);
```

with no exponent argument, so **every money column in the product is coerced at
a hardcoded two decimal places.** Executed:

```
$ npx tsx /tmp/journals-proof.mts
② coerceMoneyMinor, called the way lib/import/plan.ts calls it:
   "1250.50" -> 125050
   "1.234"   -> REFUSED: "1.234" is not an amount. Write it as rupees with
                up to 2 decimal places, for example 1250.50 — no symbol needed.
```

`1.234` in KWD is 1,234 fils — an ordinary amount. The importer refuses it, and
`Rule 8` of the contract, `db/schema/accounting.ts`'s `amount_minor` column and
`lib/validators/accounting.ts`'s own four-decimal regex all exist precisely
because *"two decimal places CANNOT REPRESENT A DINAR"*. **This is not a defect
Phase 8 introduces — it applies to the opening trial balance shipping today.**
`ImportColumn` needs an `exponent`, and the entity needs to name the field
carrying the currency; both are in `lib/import/types.ts`.

The brief's own item — *"Currencies carry the exponent… `coerceMoneyMinor`
already takes an `exponent` argument"* — is correct about the function and
incorrect about the caller. Nothing passes it.

### 3.2 `currencies` — the destination is platform-scoped

There is no `currencies` table. `currency_units` is the nearest thing and it is
**not per tenant**:

```
$ psql -d ordence_test -c "select column_name from information_schema.columns
                            where table_name='currency_units'"
 code, exponent, name, is_active, updated_at          # no tenant_id

$ ... where column_name='tenant_id'
 0
```

Its primary key is `code`, it is checked against `lib/fx/currency.ts` by
`server/fx/rate-service.ts#verifyCurrencyUnits()`, and one tenant importing it
would change the minor-unit exponent of **every other tenant's money**. There is
no version of this entity that is safe, and the exponent the brief wants is
already in the product twice, deliberately, with a checker comparing the copies.

### 3.3 `tax-codes` — delivered, but not to the table the brief names

Shipped against `hsn_sac_codes`. There is no `tax_codes`:

```
$ grep -rhA1 'pgTable(' db/schema/*.ts | ... | sort -u | wc -l
312
$ grep -cx tax_codes         → 0
$ grep -cx payment_terms     → 0
$ grep -cx numbering_series  → 0
$ grep -cx currencies        → 0
```

⚠️ **And it imports the CODES and not the RATES**, which the entity's
`description` says in the picker before the upload. `db/schema/gst.ts` gives
four defences for one rule — a rate is a fact about a dated period and never a
property of a code — and its warning is that violating it is silent: *"every
2019 invoice re-renders at 5%… AND NOTHING ERRORS."* A code arrives with no rate
and cannot be used on an invoice until somebody opens a period for it.
`codesWithoutRateOn` in `server/gst/registry.ts` exists to list them. Proven:
after importing `995411`, `hsn_sac_rates` holds 0 rows for it.

### 3.4 `payment-terms` and `numbering-series` — no table, no schema, no form

0 of 312 tables, as above. `payment_terms` exists only as
`payment_terms_days` integer columns on `orders` and `purchases` and as a string
in a `clm` enum; `numbering_series` does not appear anywhere.

Building the table, the form's schema and the importer in one phase would mean
**the importer IS the form**, which inverts rule 6 rather than satisfying it. The
precedent for the legitimate exception is `lib/import/opening-schemas.ts`, and it
justifies itself by there being *no single-record way to enter an opening
balance* — a gap the batch existed to fix. There is no such argument here: a
numbering series is an ordinary settings screen nobody has built yet.

### 3.5 `custom-fields` — two systems, and neither has a per-record form

The brief says to read `lib/validators/dynamic.ts` first. Doing so is what
refuses the entity.

There are **two** field-definition systems in this product and they are not
variants of each other:

- `custom_field_definitions` (`lib/validators/crm.ts`, `server/actions/custom-objects.ts`)
  — JSONB-backed. Fields are only ever created **wholesale** by
  `defineCustomObject`; `grep "^export async function" server/actions/custom-objects.ts`
  returns six functions and none of them adds a single field. There is no
  per-record form to share a schema with.
- `dynamic_fields` (`lib/validators/dynamic.ts`, `server/actions/dynamic-objects.ts`)
  — real DDL columns. `addDynamicField` runs `ALTER TABLE … ADD COLUMN` under an
  ACCESS EXCLUSIVE lock, and `removeDynamicField` **drops the column and every
  value in it** — the file says so in a comment on the export.

🔴 **The reversal contract is what settles it.** An import of `dynamic_fields`
would declare `reversal: delete`, and the undo would issue DDL that destroys
customer data written into those columns between the import and the undo. That
is not `restore-prior` and it is not `irreversible`-with-a-sentence; it is an
undo that is more destructive than the run it reverses.

---

## §4 — WHAT THE THREE ENTITIES DECIDE, AND WHY

The full reasoning is in the source, next to each decision. The three that would
be wrong if copied from each other:

**The natural keys disagree, and each matches its own table's index.**

| Entity | Key | The index it must agree with |
|---|---|---|
| `chart-of-accounts` | the code, **exactly** | `ledgers_tenant_code_unique` on `(tenant_id, code)`, raw column |
| `cost-centres` | the code, **upper-cased** | `cost_centres_code_key` on `(tenant_id, upper(code))` |
| `tax-codes` | the code, exactly | `hsn_sac_codes_code_tenant_unique` on `(tenant_id, code)`; the schema refuses non-digits so there is no case |

⚠️ `companies` lower-cases its key and this phase's first entity does not.
Neither is a style preference: `entities.ts` argues at length that the
framework's idea of "the same thing" must be the database's, and the two tables
genuinely have different indexes. Copying either rule to the other table gives a
preview that reports an update while Postgres performs an insert.

**Three `buildPayload` functions and three different treatments of a blank
cell**, because the three schemas differ:

- `createLedgerSchema` — `z.enum([...]).default("operating")` **refuses `null`**;
  the default only applies to an ABSENT key. A blank fund-type cell passed
  through as `null` fails the row with *"Expected 'operating' | 'trust' | …,
  received null"*. The key is omitted instead. Same for `displayOrder` on cost
  centres.
- `createHsnSacSchema` — `uqc` and `notes` are `.optional().nullable()`, so
  `null` is correct and means "no unit", which is what blank means for a service.

Each `buildPayload` states which case it is in, so the next author does not copy
the wrong one.

**`requiredness.structural` is empty on all three, and the candidates were
considered in writing rather than skipped.** The closest call is `uqc`: Rule
46(g) requires the quantity and its unit for goods and GSTR-1 rejects a
free-text unit, so a UQC-less HSN cannot be filed. It is still not structural,
because `createHsnSacSchema` accepts it and therefore the form does — and an
import **stricter** than the form is the same defect as one that is looser, in
the direction nobody checks for. If a UQC-less HSN should be refused, the place
to say so is the schema, once.

---

## §5 — PROVEN AGAINST A REAL DATABASE

`tests/security/import-accounting.test.ts`, 18 assertions, calling the **real**
`previewImport` and `commitImport`. Identity and authorisation are mocked in the
shape `tests/security/idempotency-money-movement.test.ts` established; nothing
about planning, matching, coercion, validation or writing is stubbed.

```
$ npx vitest run --project=security tests/security/import-accounting.test.ts
  Connected to: ordence_test as ordence_app
  RLS check: ✅ non-superuser role — isolation tests are meaningful

 ✓ ① the PREVIEW promises three creations and writes nothing
 ✓ ② the COMMIT writes exactly what the preview promised
 ✓ 🔴🔴 ③ THE SAME FILE AGAIN CREATES NOTHING — three skips, not three rows
 ✓ ④ and the row the second run skipped is named, so nobody thinks it failed
 ✓ ⑤ the trust rule the SCHEMA cannot carry was applied at the write
 ✓ ⑥ a blank optional enum column did not fail the row
 ✓ both runs report 1 create and 1 error, and the message is the same one
 ✓ the refused row is in the failed-rows CSV with its ORIGINAL values
 ✓ names the column and the rule, in the preview
 ✓ and a file with NO account-type column at all is refused once, not once per row
 ✓ leaves a column the file has no header for exactly as it was
 ✓ a re-upload spelled in a different case is a skip, not a unique violation
 ✓ a file with no sort-order column does not fail every row on the schema default
 ✓ a SAC that does not begin 99 is refused in the preview, by name
 ✓ 🔴 and a code arrives with NO rate, which is the correct and dangerous outcome
 ✓ an opening trial balance naming an unknown account is refused in the PREVIEW
 ✓ and the same file works once the account has been imported
 ✓ every entity this phase registers has a writer, and it is its own

 Test Files  1 passed (1)
      Tests  18 passed (18)
```

Against the brief's list, item by item:

- **"A re-run of the whole file creates nothing the second time."** ③. The file
  is committed, then committed again: `{create: 0, update: 0, skip: 3, error: 0}`
  and `count(ledgers)` unchanged. **The number that would have been 6.**
- **"Preview counts equal commit counts, including when a lookup misses."** Both
  runs of a file with one good row and one bad report `{create: 1, error: 1}`,
  and the two error **sentences** are compared as well as the counts — a preview
  that refuses a row for one reason and a commit that refuses it for another is
  drift the counts cannot see. The lookup-miss case is §7's trial balance.
- **"A row missing a structural field is refused in the PREVIEW, with the
  message you wrote, and appears in the failed-rows CSV with its original
  values intact."** The refusal names the column `Account type`; the CSV contains
  the customer's own typo `liabilty` and their code, not a normalised value.
- **"Undo restores the prior state exactly, including for a record that existed
  before the import and carried a field the import never touched."** The undo
  ledger is Track M2's and is not built. What Phase 8 owes it is proven: a
  ledger pre-existing with `bank_details` `{ifsc: HDFC0001234, accountNumber: …}`
  is updated in `update` mode by a file with **no bank columns**, and the bank
  details survive byte for byte. Without that, an undo would have nothing to
  restore — the values would have been destroyed by a write nobody asked for,
  in a run that reported success.
- **"`npm run check:import-contract` passes and its census names your entities
  in the wave you expect."** §2. All three in wave 0.

---

## §6 🔴 — THE PROOFS WERE PROVEN

*"A gate proven only by passing is not proven."* Three properties were broken
deliberately and the suite was re-run. Each induction failed **exactly** the
assertions that name it and nothing else.

**① `findExisting` made to always miss** (one line added to `ledgersWriter`):

```
 × 🔴🔴 ③ THE SAME FILE AGAIN CREATES NOTHING — three skips, not three rows
 × ④ and the row the second run skipped is named, so nobody thinks it failed
 × leaves a column the file has no header for exactly as it was
      Tests  3 failed | 15 passed (18)
```

**② `bankDetails` written unconditionally** (`const hasBank = true`):

```
 × leaves a column the file has no header for exactly as it was
      Tests  1 failed | 17 passed (18)
```

**③ the cost-centre key not upper-cased** (`value: code` instead of
`code.toUpperCase()`):

```
 × a re-upload spelled in a different case is a skip, not a unique violation
   → expected { create: +0, update: +0, …(2) } to match object
     { create: +0, skip: 2, error: +0 }
      Tests  1 failed | 17 passed (18)
```

**Restored, and green again:** `Tests  18 passed (18)`.

---

## §7 — THE OWNERSHIP MAP DOES NOT MERGE AS SHIPPED

`track-ownership-phases.json` says *"Merge these into
scripts/track-ownership.json."* Doing so makes the gate refuse its own map:

```
$ npm run check:track-ownership
check:track-ownership , violations:

  x tracks M2 and PHASE-1 both claim: "server/import/**" vs "server/import/writers/**"
  x tracks M2 and PHASE-1 have overlapping SQL blocks: 200-206 and 200-204
  x tracks M2 and PHASE-10 both claim: "server/import/**" vs "server/import/cutover.ts"
  x tracks M2 and PHASE-10 both claim: "server/import/**" vs "server/import/reconcile.ts"
  x tracks M2 and PHASE-2 both claim: "db/schema/import-runs.ts" vs "db/schema/import-runs.ts"
  x tracks M2 and PHASE-2 both claim: "server/import/**" vs "server/import/ledger.ts"
  x tracks M2 and PHASE-2 both claim: "server/import/**" vs "server/import/reversal.ts"
  x tracks M2 and PHASE-2 both claim: "server/import/**" vs "server/import/runs.ts"
  x tracks M2 and PHASE-2 have overlapping SQL blocks: 200-206 and 205-214
  x tracks M2 and PHASE-3 both claim: "server/import/**" vs "server/import/discovery.ts"
  x tracks M2 and PHASE-4 both claim: "server/import/**" vs "server/import/writers/crm/**"
  x tracks M2 and PHASE-5 both claim: "server/import/**" vs "server/import/writers/sales/**"
  x tracks M2 and PHASE-6 both claim: "server/import/**" vs "server/import/writers/purchases/**"
  x tracks M2 and PHASE-7 both claim: "server/import/**" vs "server/import/writers/inventory/**"
  x tracks M2 and PHASE-8 both claim: "server/import/**" vs "server/import/writers/accounting/**"
  x tracks M3 and PHASE-2 have overlapping SQL blocks: 207-210 and 205-214
  x tracks M4 and PHASE-2 have overlapping SQL blocks: 211-214 and 205-214
  x tracks M5 and PHASE-3 have overlapping SQL blocks: 215-218 and 215-219
  x tracks M6 and PHASE-9 both claim: "lib/import/sources/**" vs "lib/import/sources/**"
  x tracks M7 and PHASE-3 both claim: "server/import/dryrun.ts" vs "server/import/dryrun.ts"
  x tracks M7 and PHASE-3 have overlapping SQL blocks: 219-222 and 215-219
  x tracks M7 and PHASE-4 have overlapping SQL blocks: 219-222 and 220-229
  x tracks M8 and PHASE-4 have overlapping SQL blocks: 223-226 and 220-229

23 violation(s).
```

The cause is that wave 19's M1–M8 and phases 1–10 are two descriptions of the
same work, both present at once. Retiring M1–M8 is integration's call and Phase
8 does not make it — but note that **M1's paths have no phase equivalent**
(`lib/import/types.ts`, `plan.ts`, `contract/**`) and the phases file's own
comment says `lib/import/entities.ts` is *"NOT owned by any phase"*. Deleting M1
without rehoming those leaves four files this migration edits constantly owned
by nobody. Item 0 of the patch request has the minimum Phase 8 actually needs.

---

## §8 — THE ASSEMBLED TREE, RE-VERIFIED

With every patch-request item applied to a local copy of v1.85.0-alpha:

```
$ npx tsc --noEmit                       # exit 0, no output
$ npm run gates:static                   # 28/28 passed
$ npm run check:import-contract          # 9 entities, 2 waves (§2)
$ npm run check:writer-registry
✅ check:writer-registry
   Induction: adding an unregistered destination FAILED to compile, and the
   error named the registry. Restored tree compiles clean.
$ npx vitest run --project=security      # 1536 passed, 2 failed
$ npx vitest run --project=ui            # 6687 passed, 12 failed
```

🔴 **The 14 failures are pre-existing and Phase 8 did not cause one of them.**
Proven rather than asserted: the same suites were run against the untouched
zip, extracted to a second directory, and the failure lists are identical.

```
UNTOUCHED v1.85.0-alpha           WITH PHASE 8 APPLIED
tests/ui              12 failed   tests/ui              12 failed
tests/security         2 failed   tests/security         2 failed
                                  tests/security/import-accounting  18 PASSED
```

They are all one defect with two faces: **Phase 1 moved the write path out of
`server/actions/import.ts` into writer modules, and the source-level tests still
grep the action file.**

```
 × opening-balances > writes transactions and journal entries, not a column beside them
   → expected '"use server";\n\n/** Ordence — CS…' to contain 'insert(transactions)'
 × tax-call-sites §2 > no file inserts a registered table without a register entry
   → server/import/writers/sales-invoices.ts writes sales_invoices (salesInvoices)
```

Byte-identical in both trees. `server/tax/call-sites.ts` and the anchors in
`tests/ui/opening-balances.test.ts` need to follow the code Phase 1 moved —
which is a Phase-1 or integration repair, and is exactly what those anchors
exist to detect. **Phase 8's three writers are not among the undeclared writers
reported**: `hsn_sac_codes` is not a tax-bearing money table in that register,
and the list is one entry long in both trees.

---

## §9 — WHAT THE NEXT PHASE SHOULD KNOW

1. 🔴 **`lib/import/plan.ts:94` coerces every money column at two decimals.**
   Every phase importing money into a KWD, BHD, OMR, JOD, TND, LYD, IQD, JPY,
   CLF or UYW workspace is wrong by a factor of ten, a hundred or a thousand,
   silently. It affects the shipping opening trial balance today. §3.1.
2. 🔴 **There is no "many documents per file" shape.** Every entity that groups
   rows into documents — journals, and any invoice-with-lines import — hits the
   same wall. §3.1.
3. ⚠️ **`resolveLookups` in `server/actions/import.ts` is still an `if` chain
   with an unguarded end.** It is the same shape Phase 1 removed from `writeRow`,
   one file over. It fails safe today — an unhandled lookup kind resolves to
   nothing and every row errors — which is why nobody has noticed, and it is one
   edit away from not failing safe.
4. ⚠️ **Lookups cannot resolve within a file.** They run once, against the
   database, before any row is written. That is why `chart-of-accounts` imports
   flat and its `parent_ledger_id` hierarchy is set in the product afterwards;
   the comment saying so is in the entity so the next author does not add the
   column and discover the reason by shipping it.
5. ⚠️ **Two schemas were only reachable from inside `"use server"` files** and
   are now in `lib/validators/`. Expect more: the rule *"the schema is the one
   the form uses"* cannot be satisfied for any entity whose schema is still
   trapped, and the trap is invisible until somebody tries to import it.
