# WAVE 2C — money. Build v1.89.0-alpha.

**Owned and changed:** `lib/import/types.ts`, `lib/import/plan.ts`,
`lib/import/values.ts`.
**Added:** `tests/ui/import-money-exponent.test.ts` (a new file; contested nothing).
**SQL 0290–0294: NOT USED.** No migration was written. `currency_units`
already carries `exponent`, `amount_minor` columns are already `bigint`,
and nothing about this changes storage. `check:migrations` still reads
`168 files, 0001…0275. Next number: 0276.`

Everything else is in `PATCH-REQUEST-WAVE-2C.md` (and, byte-for-byte, in
`PATCH-REQUEST-WAVE-2C.patch`).

---

## 0. The tree was confirmed before anything was touched

```
$ npx tsc --noEmit                 # no output, exit 0
$ npm run gates:static             # 29/29 passed
$ npm run check:import-contract
   18 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: chart-of-accounts, companies, cost-centres, customers, gst-parties,
             leads, opening-stock, stock-items, tax-codes, vendors, warehouses
     wave 1: batches, contacts, opening-customer-invoices, opening-trial-balance,
             opening-vendor-bills, purchase-bills, receipts
```

Matches the census in the brief exactly. This is the right tree.

## 1. The defect, re-measured on this tree

```
$ npx tsx -e '…coerceMoneyMinor as plan.ts line 94 calls it…'
"1250.50" -> {"ok":true,"value":"125050"}
"1.234"   -> {"ok":false,"message":"\"1.234\" is not an amount. Write it as
              rupees with up to 2 decimal places, for example 1250.50 — no
              symbol needed."}
"1234"    -> {"ok":true,"value":"123400"}
```

The third line is the one the brief does not spell out and is the worse
half: `1.234` in KWD is *refused*, which is loud. `1234` in JPY is
**silently multiplied by a hundred** and reported as a success.

---

## 2. What was built

### 2.1 `ImportMoneyContract` — a required member on the entity

```ts
export type ImportMoneyContract =
  | { readonly source: "none" }
  | { readonly source: "workspace" }
  | { readonly source: "column"; readonly field: string;
      readonly whenBlank: "workspace" | "refuse" };
```

`money: ImportMoneyContract` is **required** on `ImportEntityDefinition`.
Not `exponent?: number = 2` — that is the present behaviour wearing a
member, and the file's own header already argues the case about
`reversal`: *"there is no such thing as an entity with no reversal
policy; there are only entities whose policy nobody wrote down."*

**The proof that it is required is the compiler, and it named all
eighteen.** Adding the member with nothing else changed:

```
$ npx tsc --noEmit | grep -c "Property 'money' is missing"
18
```

…one per entity — `chart-of-accounts`, `cost-centres`, `tax-codes`,
`contacts`, `leads`, `stock-items`, `warehouses`, `batches`, `vendors`,
`purchase-bills`, `customers`, `receipts`, `companies`, `gst-parties`,
`opening-trial-balance`, `opening-customer-invoices`,
`opening-vendor-bills`, `opening-stock` — plus two errors at the caller.
That list is the patch request. **An entity cannot be added to this
product from now on without answering the currency question.**

`{ source: "none" }` is the only variant that could be used as a way of
*not* deciding, so it is checked in both directions, twice — §3.3.

### 2.2 `whenBlank`, and why it is required too

A currency column with an empty cell is ordinary (an export that fills it
only for foreign invoices). "Assume the workspace currency" and "refuse
the row" are both defensible, so the entity says which. A framework
default here would be the same defect one level down.

### 2.3 The boundary — what crosses it, and what deliberately does not

`lib/import/` must not import the database (rule 4). Two facts were
needed and they are **not** the same kind of fact:

| fact | where it lives | how it reaches the pure layer |
|---|---|---|
| the workspace's functional currency | `tenants.settings.currency`, a row | **as data**, in the new `ImportContext`, from `functionalCurrencyFromSettings(ctx.tenant.settings).code` in `server/actions/import.ts` |
| code → number of decimals | `lib/fx/currency.ts` (pure) and `currency_units` (SQL) | **imported directly** — `minorUnitExponent()` |

🔴 **The tempting design was to put an exponent map in `ImportContext`
too**, and call that "the pure layer takes the exponent as data". That
would make a **third copy** of a fact that already exists twice, assembled
by whichever caller happened to be writing, with **no checker over the
third copy** — while the two that exist are compared by
`server/fx/rate-service.ts#verifyCurrencyUnits()`, which is the entire
reason that function was written. What is tenant state crosses as data.
What is a published ISO constant is imported from the module that already
owns it.

`lib/fx/currency.ts` is pure — no `server-only`, no database, no clock —
so this import does not weaken rule 4. §3.4 shows the gate that says so
failing when it is weakened.

### 2.4 The message stopped lying

`describeAmountRefusal(value, exponent, code)` in `values.ts`:

```
before (every currency on earth):
  "1.234" is not an amount. Write it as rupees with up to 2 decimal
  places, for example 1250.50 — no symbol needed.

after, KWD:  "1.2345" is not a valid amount in KWD. Write it with up to
             3 decimal places, for example 1250.500 — no symbol needed.
after, INR:  "1.234"  is not a valid amount in INR. Write it with up to
             2 decimal places, for example 1250.50 — no symbol needed.
after, JPY:  "12.34"  is not a valid amount in JPY. JPY has no decimal
             places — write whole units, for example 1250 — no symbol needed.
```

The example is generated from the exponent, because *"for example
1250.50"* is itself unwritable in yen.

### 2.5 The default on `coerceMoneyMinor` was removed, not just the caller fixed

`(raw: string, exponent = 2)` → `(raw: string, exponent: number, code?: string)`.
Fixing only the caller leaves the wrong answer available for free to the
next one. Required makes omission a **compile error**, which is the
standard the writer registry already sets in this framework. `code` feeds
the message only; the arithmetic is driven by `exponent` alone, so
`coerceQuantityThousandths` can keep calling it with a bare `3`.

### 2.6 Nothing rounds

A third decimal in an INR column is still refused, and §3.1 asserts it.

---

## 3. Proof — every claim with the command, and the failure induced

### 3.1 The behaviour

`tests/ui/import-money-exponent.test.ts`, 15 tests, all green:

```
$ npx vitest run --project=ui tests/ui/import-money-exponent.test.ts
Test Files  1 passed (1)
     Tests  15 passed (15)
```

They assert, among others: `1.234` in KWD → `"1234"`; `1234` in JPY →
`"1234"` (not `"123400"`); `0.001` KWD → `"1"`; `1.234` in INR still
refused, message naming INR and two places; one file carrying `KWD` and
`INR` rows producing `["1234","123"]`; a blank currency cell honouring
`whenBlank` both ways; an unknown code refusing the **row once, on the
currency cell**, not once per amount; an unknown *workspace* currency
refusing rather than falling back to INR. Two of them go through a real
shipped entity (`receipts`), not a fixture.

### 3.2 The regression, induced

`plan.ts` reverted to the old call (`coerceMoneyMinor(raw, 2)`), same tests:

```
$ npx vitest run --project=ui tests/ui/import-money-exponent.test.ts
Tests  9 failed | 6 passed (15)

FAIL > 1.234 in a KWD workspace is 1234 minor units
AssertionError: expected [ { column: 'Amount', …(1) } ] to deeply equal []
```

Restored, 15/15 again. **A test that passes on both the fixed and the
broken code is not a test**; nine of these fifteen do not.

### 3.3 `{ source: "none" }` cannot be used to not decide — and the gate fires

Two enforcements, because they catch different things.

**Runtime**, in `planImportRecords`, above the header read — for an
entity the allowlist has not seen. Asserted by test:

```
fatal: The "test-money" importer declares no currency for its amounts
(money: { source: "none" }) but has 1 money column: Amount. Nothing has
been read. …
```

**CI gate 29**, in `checkImportContract()`, over the whole allowlist,
both directions (`none` with money columns; a currency source with none).
Induced by flipping `receipts` to `{ source: "none" }`:

```
$ npm run check:import-contract
🔴 check:import-contract , 1 problem(s):
   receipts  ·  money
      declares money: { source: "none" } but has 2 money column(s): Amount,
      TDS deducted. An amount cannot be read without knowing how many decimal
      places its currency has — two is wrong by a factor of ten for the Gulf
      dinars and a hundred for the yen.
```

Reverted → `18 entities examined, every contract complete and coherent.`

### 3.4 The pure layer still imports no database — gate 8, induced

```
$ npm run check:boundaries
✅ Server boundaries intact — 218 server-only modules, 122 action modules,
   1377 files scanned.

# with `import { db } from "@/db";` added to lib/import/plan.ts:
$ npm run check:boundaries ; echo $?
::error::lib/import/plan.ts reaches the database or session but declares no
boundary. Add `import "server-only";` … or `"use server";`.
❌ Server boundary census FAILED — 1 violation(s).
1
```

Reverted → green. The gate is real and it is watching this file.

### 3.5 The whole tree, from a clean unpack

`pristine/` = the zip, untouched. `verify/` = `pristine` + my four files +
`PATCH-REQUEST-WAVE-2C.patch`:

```
$ patch -p1 < PATCH-REQUEST-WAVE-2C.patch     # applies clean, 18 files
$ npx tsc --noEmit ; echo $?                  # 0
$ npm run gates:static                        # 29/29 passed
$ npm run check:import-contract               # 18 entities, 2 waves — unchanged
$ npm run check:boundaries                    # intact
$ npm run check:migrations                    # 168 files, 0001…0275. Next: 0276.
```

### 3.6 The suite — measured against the untouched tree, not against the brief

🔴 **The "known-red" paragraph in the brief is wrong about which files.**
The count is right; the names are not. On `pristine/`, untouched:

```
$ npx vitest run --project=ui
Test Files  4 failed | 208 passed (212)
     Tests  12 failed | 6802 passed | 8 skipped (6822)

  1  tests/ui/assemble-wave.test.ts
  7  tests/ui/import-discovery.test.ts
  2  tests/ui/import-profiles.test.ts
  2  tests/ui/import-sales-entities.test.ts
```

`csv-import` and `opening-balances` are **green** on an untouched tree;
`import-discovery` (7) and `import-profiles` (2) are red and are not named
in the brief. None of the twelve is mine. After this wave, with the patch
applied:

```
Test Files  4 failed | 209 passed (213)
     Tests  12 failed | 6817 passed | 8 skipped (6837)

  same four files, same twelve tests.
```

**+15 passing, 0 new failures.** I did not fix any of the twelve.

### 3.7 The security project, against a real PostgreSQL

Two security tests call the planner and needed the third argument, so
they were run rather than reasoned about — `scripts/bootstrap-test-db.mjs`
against local Postgres 16 as `ordence_app` (`NOSUPERUSER NOBYPASSRLS`):

```
  apply the numbered SQL files, in order… ✅ 168 files, 3 statement(s) refused
  confirm row-level security is actually enabled… ✅ 323 tables protected

$ npx vitest run --project=security tests/security/import-receipts-rerun.test.ts \
      tests/security/import-crm-entities.test.ts
Tests  1 failed | 28 passed (29)
```

The one failure (`and the tree still has nothing that could have
identified those rows`) and the `import-crm-entities` teardown error
(`block_mutation_append_only()` refusing a `DELETE` on `lead_activities`)
are **identical on `pristine/`**, byte for byte. Neither is mine.

---

## 4. Judgement calls, stated rather than buried

1. **`{ source: "column" }` has no shipped user today.** No entity in the
   tree carries a currency column, so all eight money-bearing entities
   declare `workspace`. I built the variant anyway because the brief asks
   for it and because the alternative — a per-column constant — is wrong
   for a file with two currencies in it, which is the ordinary case the
   moment anyone imports foreign invoices. **It is not unreachable:** it
   is exercised by six tests, checked by gate 29 (`money.field` must name
   a real column, and that column must be `text` or `enum`), and the
   runtime path is the same one the `workspace` variant takes. This is
   the one place I chose mechanism over minimalism, and it is the one
   claim in this report a reviewer should push on.
2. **`entities-purchases.ts` already argues for a currency column** on
   `purchase-bills` (lines 54–83: *"need a currency column, a per-row
   exponent and an FX rate on the date"*). Two of those three now exist.
   I have not added the column — it is not my file and it needs the FX
   rate decision, which is a wave of its own. Recommended, not done.
3. **The `₹`/`Rs.` strip in `coerceMoneyMinor` is still unconditional.**
   Stripping a rupee sign off a KWD cell is odd but harmless — the value
   still has to parse — and making it currency-aware is a symbol table I
   was not asked for. Named so it is not discovered later as a surprise.
4. **The workspace-currency refusal is a per-row error, not a `fatal`.**
   Every row gets the same sentence, which is repetitive. A `fatal` would
   read better and would empty `rows`, taking the failed-rows CSV with it
   — the same argument `plan.ts` already makes about atomic entities.
   Repetition beats losing the download.
