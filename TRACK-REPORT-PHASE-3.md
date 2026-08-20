# TRACK REPORT — Phase 3: discovery and the dry run

> ⚠️ **Delivered as `TRACK-REPORT.md` because the brief asks for that name,
> and the tree already carries a `TRACK-REPORT.md` from an earlier track.
> Integration: rename this to `TRACK-REPORT-PHASE-3.md` rather than
> overwriting, the way `PATCH-REQUEST-A.md` … `PATCH-REQUEST-G.md` already
> sit side by side.**

Repo `app.ordence`, build **v1.84.1-alpha**, unpacked from
`ordence-DEPLOY-v1.84.1-alpha.zip` as shipped inside the brief zip. No other
version was fetched or assumed.

**Owned and delivered:** `server/import/discovery.ts`,
`server/import/dryrun.ts`, `SQL-FILES/0215_import_row_provenance.sql`,
`SQL-FILES/0216_import_destination_row_count.sql`.
**0217–0219 are unused.** A reserved block is not a quota.

Two test files sit outside Phase 3's declared paths because the phase map
allocates none; see `PATCH-REQUEST-PHASE-3.md` §6.

---

## 0. THE TREE, CONFIRMED FIRST

```
$ npx tsc --noEmit
(no output, exit 0)

$ npm run gates:static
  ✅ ×27
  27/27 passed

$ npm run check:import-contract
✅ check:import-contract
   6 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills
```

Six entities and a 2-wave load order. This is the right tree.

**A real PostgreSQL was stood up**, because none of what follows can be proven
without one:

```
$ scripts/bootstrap-test-db.mjs           # baseline, before any Phase 3 file
  push the base schema (drizzle-kit)…     ✅  308 base tables
  apply the numbered SQL files, in order… ✅  154 files, 0 statement(s) refused
  confirm row-level security is enabled…  ✅  319 tables protected
  confirm ordence_app cannot create a table… ✅

$ npm run test:security                   # baseline
  Test Files  63 passed (63)
       Tests  1520 passed (1520)
```

The suite connects as `ordence_app` — `rolsuper=false`, `rolbypassrls=false`.
That is asserted again inside the Phase 3 corpus (§4 below), because every row
count in this report is meaningless if it is not true.

---

## 1. WHAT WAS BUILT

### `server/import/discovery.ts` — the folder, classified from its values

Pure. No database, no network, no clock, no `node:` import, no `server-only`.
Only the folder READ needs the server, and it is the caller's; discovery takes
`CsvRecord[]`, which `lib/import/sources/` already produces in the browser.

The order of authority is written into the sort and proven by test:

```
① THE VALUES     lib/import/shapes.ts — what the column IS
② THE HEADER     normalised, aliased, tokenised
③ THE MODEL      an opinion, handed in as data, capped below ①
④ THE FILE NAME  a TIE-BREAK ONLY
```

**The scoring, and why it is not `proposeMapping`'s confidence.**

```
checkableClaims = claims this entity made on columns whose VALUES could
                  confirm or refute them (free-text fields and entirely
                  blank columns are excluded from the denominator, because
                  no value could ever settle them)
witnesses       = of those, the ones the values confirmed
confidence      = witnesses / checkableClaims
```

🔴 **The first draft used `overallConfidence` and it filed the one case this
module exists for under "nothing matches."** `overallConfidence` returns 0
when any REQUIRED column is unmatched, which is correct for MAPPING and wrong
for CLASSIFICATION: a file headed `F1 F2 F3 F4 F5` whose second column is 100%
GSTINs is unmistakably a GST party list AND has no matched `Legal name`. The
first execution caught it; the reasoning is now in the header of
`DISCOVERY_FLOOR` so the next author does not repeat it.

⭐ **The contradiction rule costs nothing to tune, because it is arithmetic.**
A column whose HEADER claims a checkable field and whose VALUES say otherwise
is in the denominator and not the numerator. There is no penalty constant, and
therefore none for anybody to soften later.

```
$ file gstins.csv:  header "GSTIN", 15 rows, every value an email address
  gst-parties: checkableClaims=1  witnesses=0  confidence=0.00
  chosen: null
  "GSTIN" is named as the "GSTIN" of a party, but 100% of its values are an
  email. The heading and the contents disagree, and the contents are the part
  that can be counted.
```

⭐ **And the same rule catches the model.** `lib/import/proposal.ts` reports a
conflict when a model disagrees with a decisive shape that already won a
column — it cannot report one when nothing else claimed the field, because the
model then takes it unopposed at `SCORE.MODEL_ONLY`. Discovery consults the
values anyway. `server/import/ai-mapper.ts` was read and **not modified**; the
model's opinion enters as data, exactly as its leash requires.

### `server/import/dryrun.ts` — the guarantee, made executable

🔴 **It is not a second import engine.** It is handed a RUNNER whose only
argument is `mode` — the single argument `previewImport` and `commitImport`
themselves differ by — and it executes the shipping actions twice and
measures. A verifier that could pass anything else could drive a path the
product does not have.

```
before → preview → afterPreview → commit → afterCommit
```

The order is the proof. Measuring only before-and-after-both would let a
preview that wrote a row and a commit that failed to write one cancel out.

Four ways the obvious footprint check passes while the property is false, all
four handled, three of them in SQL so a refactor in the caller cannot remove
them:

| | how it passes falsely | where it is refused |
|---|---|---|
| ⓐ | counts as a BYPASSRLS role — every count spans every tenant | SQL 0216 §1 |
| ⓑ | counts with no tenant set — under FORCE RLS every count is 0 | SQL 0216 §1 |
| ⓒ | counts only the entity's own table | `everyTenantScopedDestination()` |
| ⓓ | skips `import_row_provenance` because it does not exist | SQL 0216 §1 |

ⓑ is the one that matters most and it is the one this repository has already
shipped a version of. Under FORCE ROW LEVEL SECURITY, outside `withTenant()`,
`count(*)` returns 0 on a table of a million rows. Before = 0, after = 0,
"the dry run wrote nothing" — measured on a connection that could not have
seen a write if there had been one.

### SQL 0215 — `import_row_provenance`

The sidecar `lib/import/types.ts` has referred to since Track M1 as "SQL
0196". 0196 is not in this tree and is not Phase 3's. The brief says count it;
a footprint that skips a table it was told to count is verified-by-absence. It
is created idempotently and §7 asserts the SHAPE rather than asserting that
0215 did the work, so applying it after 0196 is a conformance check on 0196.
`PATCH-REQUEST-PHASE-3.md` §5 says what integration should do in each case.

🔴 **`run_id` is `NOT NULL`, and that is the dry run's second set of teeth.**
A preview has no run. Even if a future edit made the preview write provenance,
the database would refuse the row.

### SQL 0216 — `import_destination_row_count(text[])`

One snapshot of N destinations, inside the caller's transaction, through the
caller's own policies. STABLE, **not** `SECURITY DEFINER` — a definer function
would bypass the very policies the measurement is only worth taking through.

⚠️ **Nine tables counted in nine statements is nine points in time.** A
migration takes hours and the office does not stop; a row written by a
colleague between statement three and statement four is indistinguishable from
drift caused by the preview. One function call is one snapshot.

---

## 2. THE COMMANDS, AND THE OUTPUT THAT WOULD HAVE DIFFERED

### `npm run gates:static` — **26/27, and the one failure is not Phase 3's**

```
  🔴  check:migrations           duplicate or out-of-sequence SQL files

$ npm run check:migrations
::error::Missing migration 0181 … ::error::Missing migration 0195
❌ Migration numbering FAILED — 15 problem(s).
```

`scripts/check-migrations.mjs::reservedNumbers()` reads `t.sql` and ignores
`t.sqlAlso`; `scripts/check-track-ownership.mjs` reads both. Track H holds
0181–0195 through `sqlAlso`, so the two checkers disagree about the same map
and **any** file at 0196 or above turns the gate red — which is every one of
Phases 1 to 10. `scripts/**` belongs to track H.

**Proven by applying the four-line fix to a copy and re-running:**

```
$ npm run check:migrations          # with the fix
  98 numbers reserved for parallel tracks, 64 still unused.
✅ Migrations contiguous — 156 files, 0001…0216 (6 documented historical gaps).
```

The change was then reverted. The delivered tree does not touch `scripts/`.
Full diff in `PATCH-REQUEST-PHASE-3.md` §1.

The other 26 gates pass with the Phase 3 files present, including
`check:boundaries` (which is what would fire if `discovery.ts` stopped being
pure), `check:sql`, `check:sql-rls-writes`, `check:sealed-grants` (156
migrations linted, no floor assertion, self-verification present) and
`check:import-contract`.

### `npm run check:import-contract` — unchanged

```
✅ 6 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills
```

Phase 3 adds no entity and touches no contract. Gate 29 still reads 6.

### `scripts/bootstrap-test-db.mjs` — the whole chain, from nothing

```
  apply the numbered SQL files, in order… ✅  156 files, 0 statement(s) refused
  confirm row-level security is enabled…  ✅  320 tables protected
```

154 → 156 files, 319 → 320 protected tables. The +1 is
`import_row_provenance`, forced and policied.

### `npx vitest run` — the whole suite

```
 Test Files  2 failed | 272 passed (274)
      Tests  2 failed | 8267 passed | 8 skipped (8277)

 FAIL  tests/ui/assemble-wave.test.ts     > REFUSES a delivery that turns the gates red…
 FAIL  tests/ui/opening-balances.test.ts  > resolves through the same allowlist as everything else
```

🔴 **Both failures are in the tree as delivered and neither is Phase 3's.**
Verified by unpacking `ordence-DEPLOY-v1.84.1-alpha.zip` into a second
directory and running those two files against it unmodified:

```
$ cd /tmp/base && npx vitest run --project=ui \
    tests/ui/opening-balances.test.ts tests/ui/assemble-wave.test.ts
 FAIL  tests/ui/assemble-wave.test.ts     > REFUSES a delivery that turns the gates red…
 FAIL  tests/ui/opening-balances.test.ts  > resolves through the same allowlist as everything else
 Test Files  2 failed (2)
      Tests  2 failed | 53 passed (55)
```

⚠️ Two tenant-coverage tests DID go red on the first Phase 3 run and they were
right — see §5.

### `npm run gates:database` — 1/2, and the failure is environmental

```
  ✅  check:sql-executes
  🔴  check:rls   ::error::RLS coverage check could not run:
                           permission denied for function tenant_table_drift
```

Reproduced identically against the pristine tree. `ordence_app` has no EXECUTE
on `tenant_table_drift` in a database built by `bootstrap-test-db.mjs`; the
gate stops at section C before reaching any Phase 3 object. Sections A and B
pass, including `ordence_app: NOSUPERUSER, NOBYPASSRLS`.

---

## 3. THE CORPUS — preview counts equal commit counts

`tests/security/import-dry-run-parity.test.ts`, **26 tests, all passing**,
against a real PostgreSQL as `ordence_app`, calling the real `previewImport`
and `commitImport`. Only identity and authorisation are mocked. `@/db`,
`lib/import/` and `server/actions/import.ts` are not.

Every case measures **307 destinations** — every tenant-scoped table plus the
sidecar — three times.

| § | case | preview | commit | preview moved | equal? |
|---|---|---|---|---|---|
| 1 | control: 5 clean companies | `create 5` | `create 5` | `[]` | ✅ exact |
| 2 | unresolvable lookup (1 of 3 invoices names a customer nobody has) | `create 2, error 1` | `create 2, error 1` | `[]` | ✅ exact |
| 3 | duplicate natural key in one file (same domain twice) | `create 2, error 1` | `create 2, error 1` | `[]` | ✅ exact |
| 4 | mis-detected entity (a company list offered as GST parties) | `fatal`, `0/0/0/0` | identical `fatal` | `[]` | ✅ exact |
| 5a | atomic entity failing its file rule (unbalanced TB) | `fatal`, `0/0/0/0` | identical `fatal` | `[]` | ✅ exact |
| 5b | atomic entity, one unreadable amount | `error 2`, CSV present | `error 2` | `[]` | ✅ exact |
| 5c | atomic entity, balanced | `create 2` | `create 2` | `[]` | ✅ exact |
| 6 | the row ceiling (1001 rows) | `fatal` naming 1001 | identical `fatal` | `[]` | ✅ exact |
| 7 | **atomic + unresolvable lookup** | `create 2, error 1` | `create 0, error 3` | `[]` | 🔴 **drift** |

§7 is a finding, not a failure of the harness — see §6 below.

**Not just the totals.** `compareRuns` compares the disposition of every
RECORD NUMBER, because a run that turns row 4 from `create` into `skip` and
row 9 from `skip` into `create` reports four identical totals and is a
different import. That case is asserted directly against two hand-built
reports (§0, "catches drift that leaves the TOTALS identical").

**And the dry run wrote nothing.** `previewMoved` is `[]` in every case above,
across all 307 destinations including `import_row_provenance`.

⭐ **`cardinality: "whole-file"`, measured.** §5c: two report rows, one
`transactions` row, two `journal_entries` rows. A reconciliation expecting one
output per input row would report a missing row on a correct import — which is
the reason the member exists.

---

## 4. THE HARNESS PROVES ITSELF BEFORE IT IS BELIEVED

*A gate proven only by passing is not proven.* §0 of the corpus induces the
measurement to fail seven ways before anything else runs:

| induced | refused with |
|---|---|
| a row inserted behind its back | `[{destination: "companies", moved: 1}]` — it SEES a write |
| a destination that does not exist | *no such table(s) in the public schema: no_such_table_at_all* |
| an empty destination list | *was asked to count nothing* |
| a superuser caller | *is a superuser or carries BYPASSRLS* |
| a caller with no tenant scope | *under FORCE ROW LEVEL SECURITY every policy is then false and every count is 0* |
| two reports, same totals, swapped rows | `countDrift: []`, `drift: [2, 3]` |
| `create → error` | kept out of `drift`, into `writeResidue` |

⚠️ **And one of the assertions in this file was itself a false pass**, found
by making it fail. `expect(promise).rejects.toThrow(/run_id/)` matched
Drizzle's `Failed query: INSERT INTO import_row_provenance (…, run_id, …)`
wrapper — the QUERY TEXT — and would have gone on matching with the `NOT NULL`
removed. Every database assertion now walks the `cause` chain to the driver's
own message through `expectRefusal()`.

### The migrations, induced twelve ways

Each run is `BEGIN; <damage>; \i <the verification section>; ROLLBACK;`.

⚠️ **The first attempt at this proved nothing and it is worth recording why.**
Running the WHOLE migration after the damage repairs it — `DROP TRIGGER IF
EXISTS … CREATE TRIGGER` restores what was dropped, so the file printed OK.
Correct behaviour for an idempotent migration and a useless induction. Only
`run_id`'s nullability survived, because `CREATE TABLE IF NOT EXISTS` cannot
repair a column.

| # | induced | refused with |
|---|---|---|
| 1 | `DROP TRIGGER import_row_provenance_no_update` | *carries 1 of the 2 required triggers* |
| 2 | `NO FORCE ROW LEVEL SECURITY` | *enabled=t, forced=f. Both must be true* |
| 3 | `DROP INDEX …_once_per_run` | *carries 2 of the 3 required indexes* |
| 4 | drop the cardinality/record CHECK | *carries 2 of the 3 required CHECK constraints* |
| 5 | `DROP TRIGGER no_delete_under_impersonation` | *the sweep no longer sees new tables* |
| 6 | delete the `change_log_exclusions` row | *will attach the change recorder to an append-only table* |
| 7 | `run_id` made nullable | *a nullable run_id is a dry run that CAN write provenance* |
| 8 | `DROP COLUMN source_name` | *is missing column(s): source_name* |
| 9 | `DROP POLICY` | *has 0 policy/policies … there must be exactly one* |
| 10 | replace 0216's function with a guardless one | *answered a call from "postgres", which is applying a migration* |
| 11 | make 0216's function `SECURITY DEFINER` | *would then run as the owner, bypass the policies it exists to measure through* |
| 12 | `DROP FUNCTION` entirely | *refused with SQLSTATE 42883, which is neither … a missing function raises 42883 and would otherwise read as a proof* |

🔴 **#12 is the one worth reading twice.** 0216's self-verification proves its
caller guard fires by catching an exception — and `WHEN OTHERS` would have
called a missing function a fired guard. The SQLSTATE is checked, so a typo in
the function name fails loudly instead of reading as a proof.

⭐ **And a deliberate non-refusal, also induced:** adding a column 0215 does
not know about produces a `RAISE NOTICE`, not an exception. 0196 is allowed to
know things Phase 3 does not; a MISSING column is fatal because `dryrun.ts`
and any reversal path read those ten by name.

### The sidecar's teeth, at runtime

`tests/security/import-dry-run-parity.test.ts` §0b, executed as `ordence_app`:

- provenance with a NULL `run_id` → refused (*null value in column "run_id"*)
- `target_table` naming no table → refused (*cannot be reversed and cannot be reconciled*)
- `whole-file` + a record number → refused; `one-to-one` without one → refused;
  `whole-file` without one → **accepted**, so it is a rule and not a locked door
- any `UPDATE` → refused (*import_row_provenance is append-only*)

### Discovery, proven pure by where its tests live

`tests/ui/import-discovery.test.ts`, **24 tests**, runs in the `ui` project:
JSDOM, no `tests/setup.ts`, no `TEST_DATABASE_URL`, no Postgres. `import
"server-only"` anywhere in the module's import graph, or a stray `@/db`, and
the file fails to collect. That is the alarm, and it is why the discovery
tests are not in the security suite with the rest of Phase 3's proof.

---

## 5. TWO TESTS WENT RED AND THEY WERE RIGHT

Creating a tenant-scoped table broke two coverage tests that Phase 3 had no
reason to expect:

```
FAIL tests/security/impersonation-guard-exemptions.test.ts
  → the live unguarded set is EXACTLY the recorded one
FAIL tests/security/wave13-coverage.test.ts
  → attach_change_log_triggers() attached something on a second run:
    expected [] to deeply equal [{ action: "attached",
                                   table_name: "import_row_provenance" }]
```

⭐ **That is the mechanism working.** 0167 says so in as many words: the
tenant tables that arrived from other tracks *"all received the guard
automatically from 0125's `attach_impersonation_guards()`"*. A migration that
creates a tenant table and does not call the sweeps ships a table outside
every cross-cutting control in the product, and nothing but those two tests
would have said so.

0215 §6 now calls `attach_impersonation_guards()` and records
`import_row_provenance` in `change_log_exclusions` as `append-only` with a
reason — §4 refuses every UPDATE for every role, so the table IS its history
and a recorder could only ever record inserts, at the cost of one change row
per imported row during a migration. Both tests pass.

⚠️ `'append-only'` and not a word of my own choosing:
`change_log_exclusions_category_check` permits exactly
`self | append-only | derived | platform`. 0133 records that its first draft
wrote `'telemetry'` and was refused — caught only by executing the file.

---

## 6. WHAT THE CORPUS FOUND

Full detail, reproductions and proposed fixes in `PATCH-REQUEST-PHASE-3.md`.

**FINDING 1 — `opening-trial-balance` declares one destination and writes two.**
`provenance.targets` is `["transactions"]`; `writeOpeningTrialBalance` inserts
into `transactions` **and** `journal_entries`. Provenance is what decides what
a reversal can undo and what a reconciliation can tie. Reported as
`undeclaredDestinations` and asserted by test.

**FINDING 2 — an atomic entity with one unresolvable lookup promises rows that
cannot land.** The lookup miss is removed from `validRows` *after* `fileRule`
has balanced the whole file, so the writer is handed an unbalanced subset and
the deferred `journal_entries_balance_check` refuses it at COMMIT. Preview
`create 2`; commit `create 0, error 3`. Nothing is written — the dry run still
touched nothing — but this is precisely the number that does not match.

⚠️ **The test asserts the DEFECT, not the fix.** A test asserting the correct
behaviour would be red on delivery and would be deleted by somebody in a
hurry. This one goes red the moment the fix lands, which is when somebody
should read the comment above it.

**FINDING 3 — the ledger's best refusal is discarded.** `describeWriteFailure`
passes a 23514 through verbatim and is right to, but the balance check is a
DEFERRED constraint trigger: it fires at COMMIT, so the driver raises it from
`COMMIT` and Drizzle wraps it with `code` on `cause`. The customer is shown
*"This row was refused by the database and has not been imported"*; the
sentence discarded is *"Transaction … is unbalanced"*. Both are asserted, side
by side, in §7 of the corpus.

**FINDING 4 — `check:migrations` ignores `sqlAlso`.** §2 above. Blocks all ten
phases; four-line fix; proven.

**FINDING 5 — two UI tests are red in the delivered tree.** §2 above. Proven
pre-existing against an unmodified unpack.

---

## 7. WHAT PHASE 3 DID NOT DO, AND WHY

- **No new npm dependency.** `package.json` is untouched.
- **`server/import/ai-mapper.ts` was read and not modified.** The leash holds;
  the model's opinion enters discovery as data and is scored against
  detectors, which is what the leash asks for.
- **No second registry.** `discoverFolder` and every `dryrun.ts` helper take
  `ALL_IMPORT_ENTITIES` as an argument. Nothing here enumerates entities, and
  a correction naming an unknown key is refused rather than looked up —
  proven against `constructor`, `__proto__`, `toString` and a trailing space.
- **No entity registered.** The write path has no branch Phase 3 could reach;
  registering one would produce the built-offered-unreachable defect the
  contract document names.
- **0217–0219 unused.** Two migrations were needed. A third table would have
  been reachable only from a test.
- **`describeVerdict` and `allDeclaredDestinations` are exercised** (§8 of the
  corpus) rather than exported and left unreached.

## 8. WHAT IS STILL NOT PROVEN

Stated rather than left to be discovered.

1. **Nothing writes provenance yet.** SQL 0215 creates the sidecar and proves
   its constraints refuse what they should; the writer that fills it is Phase
   1's. `previewMoved` therefore proves the preview does not write provenance
   on a tree where the commit does not either. The `run_id` NOT NULL is what
   will still hold when Phase 1 lands.

2. **`undeclaredDestinations` is reported, never asserted empty.** A commit
   legitimately moves tables no contract declares — `change_log` on every
   insert, `audit_logs` when it is not stubbed. Deciding which of those is a
   gap and which is evidence needs a human; a hand-written list of "expected"
   side-effects here would be the second drifting model this repository has
   been bitten by four times. The test singles out `journal_entries` by name.

3. **Discovery has been proven against six entities.** Phases 4 to 8 add
   roughly twenty. The scoring is derived from `SHAPE_SUGGESTS` and each
   entity's own columns, so it needs no edit — but `distinctiveness` falls as
   more entities claim the same shapes, and the margin rule will decline more
   often. That is the safe direction and it is still a change worth re-running
   `tests/ui/import-discovery.test.ts` against.

4. **The corpus runs at most 1001 rows.** The row ceiling is `MAX_IMPORT_ROWS`
   and a real migration is chunked by the browser across many runs. Parity
   across a CHUNKED run — where `recordChunk` and the run ledger are involved
   — is Phase 2's ledger and is not measured here.

5. **`check:rls` did not reach section C** in this environment, so the live
   drift/schema-contract half of the RLS gate has not run against
   `import_row_provenance`. Sections A and B did, and 0215 §7 asserts
   `relrowsecurity`, `relforcerowsecurity` and exactly one tenant policy from
   inside the migration.
