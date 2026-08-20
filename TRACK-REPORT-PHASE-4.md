# TRACK-REPORT — PHASE-4, entities: crm

Repo `app.ordence`, build **v1.85.0-alpha**, the tree shipped inside
`ordencePHASE4.zip`. Nothing was fetched; nothing was assumed about any
other version.

---

## 0. The tree was confirmed before a line was written

```
$ npx tsc --noEmit                    → exit 0, no output
$ npm run gates:static                → 28/28 passed
$ npm run check:import-contract
  ✅ 6 entities examined, every contract complete and coherent.
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills
$ npm run check:writer-registry
  ✅ server/actions/import.ts carries 0 literal destination comparisons.
     Induction: adding an unregistered destination FAILED to compile, and the
     error named the registry. Restored tree compiles clean.
```

6 entities, 2 waves — the brief's stated precondition. Phase 1 is in the
tree: the `if` chains are gone and `IMPORT_WRITERS` is a `Record` over the
destination union.

---

## 1. What is delivered, and what is refused

| entity | status |
|---|---|
| `contacts` | **delivered** — definition, writer, registry entry, migration, tests |
| `leads` | **delivered** — definition, writer, registry entry, migration, tests |
| `deals` | 🔴 **refused: no schema exists** |
| `activities` | 🔴 **refused: the schema exists and cannot be imported** |
| `notes` | 🔴 **refused: there is no table** |

Three of five were refused under the brief's own step 1 — *"If there is
no schema for this thing, the entity is not ready and you should say so
in your report rather than writing one"* — and rule 6. Each refusal is
evidence, not an opinion:

```
$ grep -rn "dealSchema\|DealSchema" --include=*.ts --include=*.tsx .
(no output)
```

There is no create or update schema for a deal anywhere in the product.
`server/actions/deals.ts` exports one function and it is a read; its own
header says so. The only deal write in the codebase is
`ordence_update_deal_stage` in `server/mcp/dispatch.ts:1451`, which
validates nothing and casts a raw string into the stage enum.

```
$ grep -rn 'pgTable("notes"' db/schema/    → 0 matches
$ sed -n '1465,1467p' server/mcp/dispatch.ts
    case "ordence_create_note": {
      // Notes are stored as audit log entries with resourceType = "note"
```

There is no `notes` destination to write to. An entity naming one would
not compile once `ImportTableKey` is the guard it is meant to be, and
forcing it in would mean an importer that writes the customer's notes
into the audit log.

`activities` is the near miss and the most useful of the three. The right
schema exists — `logSchema` in `server/actions/activities.ts:61` — and it
is a module-private const in a `"use server"` file whose first paragraph
says: *"EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that
exports anything else publishes it as an RPC endpoint reachable by anyone
on the internet."* The schema has to MOVE to `lib/validators/`, and that
file belongs to somebody else. §6 of `PATCH-REQUEST-PHASE-4.md` has the
move written out, including the two rules that currently live as `if`
statements in the action rather than in the schema — because an entity
built against the schema as it stands would validate more loosely than
the form does, which is the one thing rule 6 forbids.

**`deals` was the entity the brief said to think hardest about, and the
hard thinking produced a refusal.** §7 of the patch request lists the
four decisions its owner has to make first: the money convention
(`numeric(15,2)` rupees against the `bigint` minor units everything
newer uses), the unconstrained `currency` column against a coercion layer
fixed at two decimals, the `stage`/`probability` conflict that
`server/actions/deals.ts` already computes and calls one of the four
things that corrupt the pipeline number, and the fact that a deal has no
unique column at all — which may mean `update` cannot be offered, which
in turn decides the reversal policy. Writing an import-only schema would
have settled all four by accident, in the file least qualified to settle
them.

---

## 2. 🔴 The finding: M1's worked example does not do what it says, and only running it showed that

**The reference `contacts` entity — the one five other phases were told
to copy — links no contact to any company, silently, and reports full
success.**

The mechanism is three lines apart in two files:

* `lib/import/contract/worked-example.ts` states, with reasons,
  *"`companyName` IS DELIBERATELY NOT IN THE PAYLOAD"*.
* `lib/import/plan.ts:337` calls `lookups: entity.lookups?.(parsedPayload)`
  — the payload **after** Zod.
* `createContactSchema` is a `z.object`, and a `z.object` **strips**
  unknown keys.

So `parsed.companyName` is `undefined` in every row, in both `lookups`
and `naturalKey`. Two consequences, neither of which fails loudly:

1. **No row ever contributes a lookup.** No contact is linked to a
   company, and — worse — a row naming a company that does not exist is
   never refused. The preview promises it, the commit writes it, and the
   customer's contact lands with a null company.
2. **The fallback natural key silently degrades** from `name|company` to
   `name|` , so two different people with the same name at two different
   companies collapse onto one contact, in a product whose own comment
   says it *"will hold several Rajesh Kumars"*.

It reads correctly. It typechecks. Gate 29 passes it — the gate reads
declarations, and the declaration is fine. It was caught by the first
test that ran it:

```
AssertionError: expected { create: 4, … } to deeply equal { create: 3, … }
```

Four rows created where the preview had promised three, because the row
naming `Nonexistent Ltd` was never checked against anything.

**The fix**, in `lib/import/entities-crm.ts`: `companyName` goes into the
payload and the schema is `createContactSchema.passthrough()`. That is
the same object the form parses, with every rule it carries; `z.object`
defaults to *strip*, and `.passthrough()` changes only that. Nothing is
validated differently and nothing becomes optional. The three
alternatives are all worse and are argued in the file: a copy of the
schema (rule 6), adding `companyName` to the form's schema (a field the
form does not have, in a file this phase does not own), or leaving it as
it is (the two silent failures above).

⚠️ **The four opening-balance entities do not have this defect** — they
keep their lookup inputs (`customerName`, `accountCode`, `vendorCode`) in
their own schemas, which they can, because those schemas are theirs. The
worked example is the only one that had to borrow a form's schema, and
that is exactly the case the other phases will hit.

**Read this before deleting `worked-example.ts`** (patch 4). Five phases
were told to copy that file.

---

## 3. Second finding: `requiredness` is declared everywhere and read nowhere

```
$ grep -rn "requiredness" --include=*.ts lib server components app \
    | grep -v "lib/import/types.ts" | grep -v "lib/import/contract/"
lib/import/entities.ts:312:    requiredness: { structural: [], messages: {} },
lib/import/entities.ts:643:    requiredness: { structural: [], messages: {} },
```

Two entity declarations, and nothing else in the entire tree. Gate 29
checks that every structural field has a message and that no message
names a non-structural field — but no code on the run path consults
`requiredness.structural` at all.

That matters most for the entity the contract documentation uses to
explain the member: `opening-customer-invoices` declares
`structural: ["companyId"]` with the sentence *"The Zod schema cannot
refuse a missing `companyId`, because the schema runs BEFORE the lookup
resolves … Without this declaration, an unresolvable customer becomes a
foreign-key violation at write time."* Today the declaration exists and
the refusal it describes is not performed by anything.

⚠️ **It is not currently a live defect**, because the run path refuses a
row whose lookup missed before it reaches the write (`server/actions/
import.ts:578`), which covers every structural field declared so far —
all of them lookup targets. It becomes one the first time a phase
declares a structural field that is *not* a lookup target, and expects
the framework to enforce it. Phase 4's two entities declare
`structural: []`, deliberately and for reasons written in the file, so
nothing here depends on it.

The enforcement point belongs in the shared decision loop, next to the
lookup check, in a file this phase does not own. Flagged for Phase 2/3
rather than patched, because a refusal added in the wrong place is a
refusal that fires in one of the two runs.

---

## 4. Third finding: the phases ownership file does not merge

Measured, in the tree, with `track-ownership-phases.json` applied
verbatim:

```
$ npm run check:track-ownership     → 28 violation(s)
$ npm run check:migrations          → ❌ FAILED, 15 missing numbers (0181–0195)
```

Three separate causes, all in §5 of the patch request with the
reconciliation that was measured green. The one that concerns this phase
directly:

🔴 **`M7` holds SQL 219–222 and `M8` holds 223–226. Phase 4's brief
allocates it 220–229.** Seven of this phase's ten numbers are already
reserved by two wave-19 tracks that are still in the ownership file.

**So Phase 4's migrations are numbered 0227 and 0228** — inside its own
block and outside both M-blocks, so they are correct whichever way
integration resolves the overlap. Nothing was numbered 0220.

The second cause is worth naming separately because it will hit every
phase: `SQL-FILES` currently tops out at 0168, and **0181–0195 belongs to
no track's block** even though the ownership file's own `_comment` says
Track H "holds 0181-0195 for later". Nothing notices while no file is
numbered above 0180. The first phase to ship any migration — this one —
makes `check:migrations` report 15 missing numbers that are not its
doing.

---

## 5. What was built

```
lib/import/entities-crm.ts                        the two entities, one exported map
server/import/writers/crm/contacts.ts             destination writer
server/import/writers/crm/leads.ts                destination writer
SQL-FILES/0227_import_contacts_match_indexes.sql
SQL-FILES/0228_import_leads_match_indexes.sql
tests/security/import-crm-entities.test.ts        16 assertions against real Postgres
```

Zero new npm dependencies (`package.json` untouched). No database import
anywhere in `lib/import/`. One map, spread into `ALL_IMPORT_ENTITIES` by
a single line in the patch request — no second registry.

### The decisions worth reading

**`contacts` depends `hard` on `companies` although the column is
optional.** The strength is about the FILE, not the field: a contacts
export out of any real CRM names the company on nearly every row, so
loading it first means nearly every row comes back unresolved. M1's
reasoning, kept.

**`contacts.requiredness.structural` is empty although the lookup can
miss.** A contact who belongs to no company is a real contact. An
unresolved company is an ordinary row error with the entity's own
sentence, not a refusal of every sole trader in the file. Compare
`opening-customer-invoices`, where the identical lookup shape IS
structural, because an invoice owed by nobody is not an invoice.

**`leads` uses `createLeadRefined`, not `createLeadSchema`.** The action
parses the bare schema and then hand-checks the refinement's rule four
lines later with the same sentence. Using the bare schema would have made
the importer looser than the form and written leads nobody can contact,
at scale. It also carries the re-run guarantee: `naturalKey` keys on
email then phone, so a row with neither has no key — and a keyless row is
created again on every re-run. The refinement makes that row impossible
rather than unlikely.

**`leads` matches on the generated columns `email_key` and
`phone_digits`, not on `email` and `phone`.** The database computes both
on every write from every path, so the importer's idea of identity cannot
drift from the stored one. `+91 98765 43210`, `098765 43210` and
`9876543210` are one lead, proven below.

**`leads` loads in wave 0 with an empty `dependsOn`**, which is a
decision and not an omission: the three columns that would have made it
depend on something (project, owner, channel partner) are uuids nobody's
export carries, so they are not offered at all rather than half-built.
The brief warns that a sales team's export is usually the first file they
reach for; wave 0 is what makes that work.

**Neither entity offers `delete` reversal.** Both offer `update`, so both
declare `restore-prior` with `capturePriorFields: ["*"]` — gate 29
refuses the other combination by name, and it is right to. For `leads`,
`escapes` is `null` and that is checked rather than hoped: rows the run
created take their `lead_activities` history with them, because that
table's FK to `leads` is `ON DELETE CASCADE`.

**The lead writer reads the existing row before updating it.** `scoreLead`
scores a lost lead zero, and this path does not import a status —
recomputing the score against the file's implied "new" would put dead
leads back at the top of every list sorted by score. It also refuses to
re-stamp `consent_at` on a lead that already has one: the earliest
recorded basis is the DPDP evidence, and overwriting it with today's date
destroys the only thing that made the contact lawful.

**Money.** `budgetMin`/`budgetMax` make a full round trip — the file says
rupees, `coerceMoneyMinor` produces a paise string (the report is JSON
and `JSON.stringify` throws on a bigint), `fromMinorUnits` converts back
to the rupee string `createLeadSchema` insists on, and `toMinorUnits`
converts once more at the insert. A single missed step multiplies or
divides every budget in the file by a hundred and passes every check on
the way, so the exact paise value is asserted in the tests.

---

## 6. Proof

### 6.1 The tree, with everything applied

```
$ npx tsc --noEmit
EXIT:0

$ npm run gates:static
  28/28 passed
EXIT:0
```

That run includes `check:track-ownership` and `check:migrations` green
with the reconciled ownership file, `check:writer-registry` green with
both new destinations registered, and `check:sql` reporting no
unprotected tenant tables.

### 6.2 Gate 29 — the census moved, and by the right amount

```
$ npm run check:import-contract
✅ check:import-contract
   8 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, leads, opening-stock, opening-trial-balance
     wave 1: contacts, opening-customer-invoices, opening-vendor-bills
```

6 → 8. `contacts` in wave 1 behind `companies`; `leads` in wave 0. If the
`dependsOn` on `contacts` had been dropped it would have appeared in wave
0 and this line would read differently, which is what makes it a proof
rather than a green tick.

### 6.3 The tests — 16 assertions, real Postgres, non-superuser role

Postgres 16.13, schema built by `drizzle-kit push` and then
`db/migrations/ALL-IN-ONE-SETUP.sql`, connected as `ordence_app`
(`NOSUPERUSER NOBYPASSRLS`) exactly as production does — the harness in
`tests/setup.ts` refuses to run as a superuser, and it refused the first
attempt of this work, which was against the `postgres` role:

```
🚨 TEST_DATABASE_URL connects as "postgres", which is a SUPERUSER.
```

```
$ npx vitest run --project security tests/security/import-crm-entities.test.ts
  Connected to: ordence_test as ordence_app
  RLS check: ✅ non-superuser role — isolation tests are meaningful

 ✓ contacts › preview decides exactly what commit does — including when a lookup misses
 ✓ contacts › 🔴 a re-run of the whole file creates nothing the second time
 ✓ contacts › matches case-insensitively on email and on name+company for the row that has none
 ✓ contacts › 🔴 update mode does not touch a field the import never mentions
 ✓ contacts › 🔴 a row that names no company does not UNLINK a contact somebody linked by hand
 ✓ contacts › refuses two rows in one file that are the same person, in the preview
 ✓ leads › preview decides exactly what commit does, and the money survives the round trip
 ✓ leads › writes the lead's first history entry, exactly as the form does
 ✓ leads › 🔴 a re-run of the whole file creates nothing the second time
 ✓ leads › 🔴 the same phone written three different ways is one lead, not three
 ✓ leads › 🔴 refuses a lead with neither phone nor email — in the PREVIEW, with the form's sentence
 ✓ leads › 🔴 update mode does not resurrect a lead the team has already lost
 ✓ leads › does not re-stamp consent on a lead that already had it
 ✓ leads › appends no history entry on an update
 ✓ reachability › both entities are in the single allowlist and both destinations have a writer
 ✓ reachability › the SQL this phase ships is applied to the database it is tested against

 Tests  16 passed (16)
```

**What would have differed if the claims were false**, test by test:

* *re-run creates nothing* — asserts `create === 0`, `skip === 3` (and
  `2` for leads) **and** that the live row count is unchanged. A broken
  natural key gives `create: 3` and a doubled table; this is the assertion
  the brief calls the single most important one in the track.
* *preview equals commit* — the two runs differ by one statement in the
  runner, exactly as `server/actions/import.ts` does, and the whole counts
  object is compared. Before the passthrough fix this failed with
  `create: 4` against `create: 3`.
* *a field the import never mentions* — `last_contacted_at` is set to a
  fixed timestamp before an `update` run and asserted byte-identical
  after. An update implemented as delete-and-reinsert, or as a spread of
  the payload over the row, loses it.
* *does not UNLINK* — a contact is linked to Acme by hand, then a file
  with a blank company column is re-imported in `update` mode, and the
  link is asserted intact. Writing `companyId: null` for an absent column
  would fail here — and would be a deletion of data the file never
  mentioned.
* *three phone formats, one lead* — `(022) 2345-6789` and `0 2223 456789`
  are re-imported against a lead created as `022-2345 6789`; asserts zero
  creations. Matching on the raw `phone` column fails all three.
* *does not resurrect a lost lead* — the lead is set to `lost` with score
  0, then updated from the file; asserts the file's `temperature` landed,
  the status stayed `lost` and the score stayed 0. A writer that
  recomputed the score against "new" fails here.
* *money* — asserts `budget_min_minor = '450000000'` and
  `budget_max_minor = '450000050'` from a file saying `4500000` and
  `4500000.50`. Any single missed conversion in the four-step chain is
  off by 100×.
* *unreachable lead refused in the preview* — asserts the error text
  contains the form's own sentence, and then asserts the commit writes
  nothing.
* *the SQL is applied* — queries `pg_indexes` for all four index names.
  Not "the file exists", which is the check that passes on a migration
  nobody ran.

⚠️ **What these tests do NOT prove.** They reproduce the decision loop
between `resolveLookups` and `performWrites` rather than calling
`previewImport`/`commitImport`, which begin with `requirePermission()`
and cannot run without a Clerk session. So they prove the entities, the
writers, the keys, the lookup and the SQL; they do not prove that
`server/actions/import.ts` calls them in that order. That property is
Phase 1's and is proven by gate 30's induction, which compiles the real
tree with a sentinel destination and requires the build to fail naming
the registry. Stated here because "verified by a floor" and "verified by
a mock" are the same failure.

### 6.4 The migrations were executed, not merely written

```
$ psql -v ON_ERROR_STOP=1 … -f SQL-FILES/0227_import_contacts_match_indexes.sql
NOTICE:  0227 PASS: both contact import-match indexes are present, valid and carry their expressions.
$ psql -v ON_ERROR_STOP=1 … -f SQL-FILES/0228_import_leads_match_indexes.sql
NOTICE:  0228 PASS: both lead import-match indexes are present, valid and carry their predicates.
```

Both were then run a **second** time against the same database and passed
again — `CREATE INDEX CONCURRENTLY IF NOT EXISTS` plus a self-check that
re-reads `pg_get_indexdef`, so a re-run is a verification rather than an
error.

**Two things were found only by executing them:**

1. `concat_ws(' ', first_name, last_name)` reads better than
   `first_name || ' ' || coalesce(last_name, '')` and **cannot be
   indexed**:

   ```
   $ psql -c "CREATE INDEX tmp ON contacts (lower(concat_ws(' ', first_name, last_name)));"
   ERROR:  functions in index expression must be marked IMMUTABLE
   ```

   `concat_ws` is STABLE. The writer's SQL was changed to the immutable
   form so that the query and the index carry the *same* expression —
   otherwise the index is built, is correct, and is silently never used.

2. **0227's own self-check failed on its first run, on a correct index.**
   `pg_get_indexdef` prints `COALESCE` in upper case, and the check used
   `!~ 'coalesce'`, which is case-sensitive:

   ```
   ERROR:  0227 FAILED: contacts_import_name_match_idx is not the collapsed-name expression.
   ```

   Fixed to `!~*`. A checker that fails on a correct input is the same
   family of defect as one that passes on a wrong one, and this repository
   has found four of those in its own checkers.

### 6.5 What was NOT run

* `npm run gates:database` and `npm run check:sql-executes` need a
  **seeded** harness database (their queries assert on fixture totals
  such as `customer_receipts totalled 2500000`). The database used here
  was built from `drizzle-kit push` plus the RLS setup, with no seed, so
  that gate reports missing seed rows and says nothing about this phase's
  work. Not claimed either way.
* `next build` was not run. `npx tsc --noEmit` and the 28 static gates
  were.
* The reversal machinery itself is Phase 2's. This phase declares the
  policies and proves the properties they depend on (that `update`
  overwrites pre-existing rows; that `lead_activities` cascades). It does
  not claim an undo works, because there is nothing here to run one.

---

## 7. Handover

* Apply `PATCH-REQUEST-PHASE-4.md` §§1–4 or these two entities are not
  reachable. They are the whole delivery.
* §5 before any phase ships a migration.
* **§2 of this report before deleting `worked-example.ts`** — the
  reference entity five phases were told to copy has a defect that only
  shows up when it runs.
* `deals`, `activities` and `notes` come back when their owners have done
  §§6–7. None of the three is blocked on Phase 4.
