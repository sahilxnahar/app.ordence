# Phase 2 — the run ledger, idempotency and reversal

Repo `app.ordence`, built and verified against **v1.84.1-alpha** (the zip that
came with the brief). SQL block **0205–0210**; **0211–0214 unused** and this
report says what has to happen about that.

Everything below was executed. Where a claim rests on a number, the command
that produced it is beside it, and so is the output that would have differed
had the claim been false.

---

## 0. Read this first: three things in the brief are not true of this tree

I checked the brief's own premises before building on them. Two of the three
are wrong, and one of them is wrong in a way that changed what this phase had
to build.

### 0.1 🔴 SQL 0196 does not exist. `import_row_provenance` had never been created.

The brief says: *"M1 shipped SQL 0196, the `import_row_provenance` sidecar:
one row per written row … **You write it, in the same transaction as the row
it describes.**"* `lib/import/types.ts` says the same thing twice, in prose.

```
$ ls SQL-FILES/*.sql | tail -1
SQL-FILES/0168_audit_stream_comment_correction.sql

$ ls SQL-FILES | grep -cE '^019[0-9]_'
0

$ grep -rl "import_row_provenance" . --exclude-dir=node_modules --exclude-dir=.git
./lib/import/types.ts          ← the comment, and nothing else in the repository
```

Track M1's block in `scripts/track-ownership.json` is `[196, 199]`. It reserved
the number, made `provenance` a **required** member of every contract, wired
CI gate 29 to enforce it — and shipped no DDL. So on the delivered tree every
entity in `ALL_IMPORT_ENTITIES` declares a provenance policy naming a table
that has never existed. Declared-and-unenforced, which is the defect the
contract's own header says it was written to remove.

**Phase 2 writes it, as `0205`, not as `0196`.** Reusing another track's
number is the mistake `check:migrations` has already refused four times (0062,
0072, 0076, 0107). Every statement in 0205 is `IF NOT EXISTS` /
`CREATE OR REPLACE`, and its self-verification block asserts the **column
list**, so if M1 ever lands a 0196 creating a table of the same name with a
different shape, the `CREATE TABLE IF NOT EXISTS` no-op is caught there
instead of failing at runtime on a missing column.

### 0.2 The "measured gaps" do not reproduce

The brief gives two commands and their outputs as the reason the phase exists:

| brief says | actually, on v1.84.1-alpha |
|---|---|
| `grep -rn "idempot" server/ lib/ \| wc -l` → **1** | **138** |
| `grep -rniE "rollback\|undo\|revert" server/import/ lib/import/ \| wc -l` → **0** | **33** |

The 138 are spread over 27 directories — `server/notifications/proofs` (21),
`server/scheduler` (13), `lib/email` (12) and so on. Scoped to the import
subsystem the first command returns **2**, both comments. The 33 are all
prose: contract declarations, the checker's own refusal messages, and
`lib/import/types.ts` explaining what an undo is.

**The substantive claim survives and the numbers do not.** There was no undo
implementation and no run-level idempotency. But a brief that hands over two
`wc -l` outputs as evidence, and is out by 138 and 33, is a brief whose
premises had to be re-derived — which is what §0.1 turned up.

### 0.3 🔴 `opening-stock` declares an undo the database refuses, and always has

`lib/import/entities.ts` (through `contract/opening-policies.ts`) declares:

```ts
"opening-stock": { reversal: { kind: "delete",
  escapes: "Deleting an opening stock movement changes the current quantity on
            hand for that item. …" } }
```

`stock_movements` carries `trg_stock_ledger_append_only`:

```
$ psql "$TEST_DATABASE_URL" -c "\df+ ordence_stock_ledger_append_only"
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stock movements cannot be deleted. This one is dated % for
    % unit(s). To correct it, post a REVERSAL for the opposite quantity with
    reverses_movement_id = %'
```

BEFORE DELETE OR UPDATE, `SECURITY DEFINER`, no condition on role or session.
The declared undo is not risky or lossy — it is **refused, every time, for
every role**, and has been since the entity was written. The `escapes`
sentence describes in detail the consequences of a deletion that cannot occur.

**CI gate 29 passes and always will.** `checkImportContract()` is pure — its
header says so twice, and being pure is what lets the wizard run it in a
browser. A pure checker cannot ask `pg_trigger` anything. The contract is
internally coherent: `delete` is a valid kind, `duplicateModes` excludes
`update`, both sentences are present.

There is a second, independent reason `delete` is wrong there:
`trg_refresh_stock_balance` is **AFTER INSERT only**, so even with the guard
removed, deleting a movement would leave `stock_balances` holding the opening
quantity for ever — a balance no movement explains.

The remedy is one word in `lib/import/contract/opening-policies.ts`, a file
this phase does not own. It is written out in `PATCH-REQUEST-PHASE-2.md` and
is deliberately **not** applied here.

---

## 1. The tree, confirmed before anything was written

```
$ npx tsc --noEmit
(clean)

$ npm run gates:static
  27/27 passed

$ npm run check:import-contract
✅ check:import-contract
   6 entities examined, every contract complete and coherent.
   Load order resolves in 2 wave(s):
     wave 0: companies, gst-parties, opening-stock, opening-trial-balance
     wave 1: opening-customer-invoices, opening-vendor-bills
```

6 entities, 2 waves — as the brief requires. This is the right tree.

---

## 2. What was built

| file | lines | what it is |
|---|---:|---|
| `SQL-FILES/0205_import_row_provenance.sql` | 616 | the sidecar M1's 0196 never wrote, plus the same-transaction trigger |
| `SQL-FILES/0206_import_prior_values.sql` | 405 | prior-value capture, the before-the-overwrite trigger, the capture obligation |
| `SQL-FILES/0207_import_run_idempotency.sql` | 287 | the run-level claim: two tabs, two clicks, one file |
| `SQL-FILES/0208_import_reversals.sql` | 486 | the reversal ledger; a partial reversal cannot report success |
| `SQL-FILES/0209_import_destination_reversibility.sql` | 252 | what the database will actually allow — the half of the contract gate 29 cannot check |
| `SQL-FILES/0210_import_reversal_primitives.sql` | 418 | capture / restore / delete, and the restore measures what did not come back |
| `SQL-FILES/DRILL-…-0208a-partial-reversal.sql` | 150 | the four dishonest endings, induced as `ordence_app` |
| `SQL-FILES/DRILL-…-0210a-restore-measures-escapes.sql` | 148 | the restore, exercised as `ordence_app` |
| `db/schema/import-runs.ts` | 900 | +4 tables, +4 columns on `import_runs` |
| `server/import/ledger.ts` | 675 | the provenance writer and the capture, in one call |
| `server/import/reversal.ts` | 1197 | the four kinds, and the partial report |
| `server/import/runs.ts` | 542 | run-level idempotency added to the existing chunk ledger |

Plus three files this phase does **not** own — see §7 and
`PATCH-REQUEST-PHASE-2.md`.

---

## 3. The four design decisions that are not in the brief

### 3.1 🔴 `operation` — without it a `restore-prior` undo cannot be written

The brief describes the sidecar as holding *"(run, entity, input row number,
target table, target id)"*. **That set cannot undo `companies`.**

`companies` offers duplicate mode `update` and declares `restore-prior`. A
single run over one file does both of these, row by row, decided by whether
the natural key matched:

```
no match  → INSERT.  There is no prior. Undo = DELETE.
matched   → UPDATE.  There is a prior. Undo = RESTORE.
```

An undo that only restores leaves every row the run **created** behind and
reports success. An undo that only deletes destroys records the customer had
before the migration — the exact combination gate 29 refuses at definition
time, arrived at from the other side, at undo time, where gate 29 cannot see
it. Only the write path knows which happened, and only while it is happening.

Induced, by making `restore-prior` ignore `operation`:

```
$ # server/import/reversal.ts: `kind === "delete" || (restore-prior && insert)`
$ #                         →  `kind === "delete"`
$ npx vitest run --project=security tests/security/import-reversal.test.ts
 × kind: restore-prior > restores what it overwrote, deletes what it created…
   → expected 'partial' to be 'reversed'
      Tests  1 failed | 8 passed (9)
```

### 3.2 🔴 "Same transaction" is checked against the heap, not asserted in a comment

The brief: *"A separate transaction is not an option."* Every obvious way of
enforcing that is a convention — passing a `tx` handle enforces it in one
language, in one process, for as long as nobody writes `await withTenant(...)`
inside the loop. Which is exactly what every branch of `writeRow` in
`server/actions/import.ts` does **today**, once per destination.

So SQL 0205 §4 compares the destination row's `xmin` — the id of the
transaction that produced that version of the tuple — against
`pg_current_xact_id()`. If the row was written by an earlier transaction that
has already committed, they differ, and nothing the caller can do makes them
match.

```
=== A. row in tx1, provenance in tx2 — MUST be refused ===
ERROR:  Provenance for row 4444…4444 in "companies" is being written by
transaction 5956, but that row was last written by transaction 5955.
Provenance MUST be written in the same transaction as the row it describes…

=== B. row and provenance in ONE transaction — MUST be accepted ===
ACCEPTED

=== C. provenance naming users — MUST be refused ===
ERROR:  An import may not record provenance against "users". …
```

It buys a second property nobody asked for: **a run cannot claim provenance
over a row it did not touch.** The attribution is as strong as the write.

Proved again through the real API, in the test suite:

```
 ✓ provenance > is refused when the row it describes was written by an
   earlier transaction   290ms
```

— and that test also asserts the row **is still there** afterwards, because
the inner transaction committed. Without the refusal there would now be a row
in the customer's workspace that no undo can find and no reconciliation can
count: indistinguishable from one that was never written.

### 3.3 🔴 The capture records *when it was read*, so "one statement too late" is a refusal

A missing capture fails loudly at undo time. The failure that does not is a
capture taken **after** the UPDATE instead of before it: there is a row, it has
values in it, the undo runs, it reports success, and it restores the values
the import itself just wrote. Both orderings compile.

`import_row_prior_values.observed_xmin` is the destination row's `xmin` **at
the moment of the read**. Captured before the overwrite it is an earlier
transaction's id; captured after, it is this transaction's own — and SQL 0206
§3 refuses that by name.

It is an **AFTER** INSERT trigger, deliberately: `first_wins` lets the writer
say `ON CONFLICT DO NOTHING` when a file has two rows sharing a natural key,
and a BEFORE trigger fires for the row the conflict then discards — refusing
the correct second capture, whose whole purpose is to be thrown away.

And the obligation runs the other way too. SQL 0206 §4 is a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger: at COMMIT, every
provenance row that is `(restore-prior, update)` must have exactly one
capture. Deferred because the writer may record the two in either order.

### 3.4 ⭐ What escapes an undo is measured, not declared

`companies` declares `escapes: null` — a claim that **nothing** survives an
undo of it. `companies` also carries `companies_set_updated_at`, a BEFORE
UPDATE trigger whose entire body is `NEW.updated_at = now()`. The claim is
false, for two of the six contracted entities, and gate 29 cannot see it.

`import_restore_prior_values()` (SQL 0210 §3) re-reads each row after writing
it and returns every column that did not come back:

```
=== the restore, and WHAT IT MEASURED ===
 rows_affected |  unrestored
---------------+--------------
             1 | {updated_at}
```

`server/import/reversal.ts` puts that in front of the customer instead of the
declaration:

```ts
expect(entity.contract.reversal.escapes).toBeNull();      // what was declared
expect(undo.measuredEscapes).toEqual(["companies.updated_at"]);  // what is true
```

⚠️ **A trap worth writing down.** The first draft of 0210's self-test did this
inside one transaction and reported that nothing escapes. Inside a transaction
`now()` is the *transaction* timestamp and does not move, so a row inserted,
overwritten and restored in one transaction has the same `updated_at`
throughout. The fixture is now dated in the past — which is also the real case,
a record the customer had before the migration.

---

## 4. The proof the brief asks for

> *"Not 'the undo ran'. **The state after import-then-undo is byte-identical to
> the state before the import**, for each of the four kinds, including the
> `restore-prior` case where a record existed beforehand and carried a field
> the import never touched. And prove a partial reversal is reported as
> partial."*

`tests/security/import-reversal.test.ts` — 1,061 lines, 9 tests, against a real
PostgreSQL 16, connected as `ordence_app` (`rolsuper = f`,
`rolbypassrls = f`). It calls `writeRowWithLedger`, `reverseImportRun` and
`startImportRun` directly; nothing in it re-implements them.

**The assertion is not made about the rows the test thought about.**
`snapshotWorkspace()` reads **every tenant-scoped table in the database** —
discovered from `information_schema`, not listed — for that workspace, and the
comparison is over the whole thing. The three tables that are *expected* to
differ are named, and the check uses `toEqual`, not `arrayContaining`: a table
that was expected to differ and did not is as much a failure as one that
differed unexpectedly, because it would mean the change recorder or the
migration ledger had stopped writing.

```
$ npx vitest run --project=security tests/security/import-reversal.test.ts

  Connected to: ordence_test as ordence_app
  RLS check: ✅ non-superuser role — isolation tests are meaningful

 ✓ kind: delete > returns the workspace byte-for-byte to where it started        1746ms
 ✓ kind: restore-prior > restores what it overwrote, deletes what it created,
                         and keeps a field it never wrote                        1458ms
 ✓ kind: irreversible > refuses, says what escapes, and leaves the workspace
                        exactly as the import left it                             740ms
 ✓ kind: reverse-entry > posts a mirror entry, leaves both visible, and returns
                         the net position to zero                                1232ms
 ✓ a partial reversal > names every row it could not reverse, and refuses to
                        call itself reversed                                     1301ms
 ✓ run-level idempotency > gives the second tab the run the first tab created     527ms
 ✓ run-level idempotency > refuses a fingerprint that is not one                   13ms
 ✓ provenance > is refused when the row it describes was written by an
                earlier transaction                                               290ms
 ✓ opening-stock > declares an undo the stock ledger refuses, and the refusal
                   comes before anything is touched                                 2ms

 Tests  9 passed (9)
```

### 4.1 `delete` — byte-identical

Fixture: a workspace with a company the customer already had. Import writes
three `sales_invoices`. Undo removes them. Divergence after the undo:
`change_log`, `import_row_provenance`, `import_reversals`, `import_runs` —
each on the list with its reason. `sales_invoices` is not on it, in either
direction.

### 4.2 `restore-prior` — including the field the import never touched

A file with two rows: one matches an existing company, one does not. One run,
one UPDATE and one INSERT; one RESTORE and one DELETE on the way back.

The existing company carries a note the import never writes:

```ts
notes: "Rang de Basanti — MD prefers a call before 10am. Do not email."
```

After the import it is `NULL`. After the undo it is back, verbatim, together
with a `website` the import had blanked. The company the run *created* is
gone. And:

```ts
const census = await ledgerCensus({ tenantId: t, runId, rowsWritten: 2 });
expect(census.inserts).toBe(1);
expect(census.updates).toBe(1);
expect(census.priorCaptures).toBe(1);   // ⭐ ONE, not two — the insert paid nothing
```

That last line is the brief's *"An entity declaring `delete` must not pay for
it"* made measurable. It is a row count, and it is only a row count because
prior values are a separate table rather than a nullable column on the sidecar
— a NULL is indistinguishable from a capture that was attempted and lost.

Induced, by having the entity capture only the columns the import writes:

```
$ # ledger.ts: fields: contract.reversal.capturePriorFields → ["name","website"]
 × kind: restore-prior > … keeps a field it never wrote
   → expected null to be 'Rang de Basanti — MD prefers a call b…'
```

### 4.3 `irreversible` — refuses, and changes nothing

No contracted entity declares `irreversible`, so the test builds one. It is
**not** registered in `ALL_IMPORT_ENTITIES` — and that is the point:
`server/import/reversal.ts` never consults the registry. Everything an undo
needs is in the ledger, written when the run was written.

The refusal is recorded (`status = 'refused'`), the escape sentence is repeated
back, the rows the import wrote are **still there**, and the only table that
differs is `import_reversals` (plus `change_log`).

`import_reversals_irreversible_refuses` makes that the only ending such a row
can have: kind `irreversible` may never reach status `reversed` and may never
report a reversed row. Otherwise the product could claim it un-sent an email.

### 4.4 `reverse-entry` — 🔴 byte-identical is FALSE here, by design

This is the one place the brief's bar cannot be met, and saying so is the
result rather than a failure to reach it. The entity's own `escapes` says it:

> *"The reversing entry is itself a posted transaction and stays in the ledger
> permanently. Undoing an opening balance leaves two entries visible, not none,
> because that is what a ledger does."*

So the strongest **true** statement is proved instead: the ledger's **net
position** returns exactly to where it was, the original is marked `reversed`
and linked to its mirror, and the residue is precisely the two entries the
escape sentence promised.

```
net by account after the undo:   1000 Cash → 0     3000 Opening Equity → 0
transactions: 2      journal_entries: 4       (not 0, and not 1)
```

The divergence list is enumerated, not filtered: `transactions`,
`journal_entries`, `ledgers` (because `update_ledger_balance` maintains
`current_balance` on every posting — it moved out and back, and `updated_at`
moved with it), plus the three that always differ and `import_runs`.

### 4.5 The partial reversal, induced

> *"Induce it: revoke DELETE on one destination mid-undo and show the report
> names the rows it could not reverse rather than rounding up to success."*

```ts
await asSuperuser((c) => c.query(`REVOKE DELETE ON sales_invoices FROM ordence_app`));
const undo = await reverseImportRun({ tenantId: t, runId, requestedBy: u });
```

```
undo.status          = "partial"        ← not "reversed", not rounded up
undo.rowsConsidered  = 4
undo.rowsReversed    = 0
undo.rowsUnreversed  = 4
undo.failures.length = 4                ← every one named
  each: targetTable "sales_invoices", inputRowNumber 1..4,
        sqlstate "42501", blockedBy /permission denied/
undo.message contains "could NOT be undone"
undo.message contains "Do not import this file again"
```

And two things that matter more than the counts:

**The run does NOT release its claim on the file.** `superseded_at` stays
`NULL` after a partial undo. That single line is what protects the customer
the brief describes: importing the same file again is still refused, because
the rows that were never removed are still there to be matched as "already
here" and never looked at again.

**The database refused the dishonest ending, not the code.** The test re-reads
the row afterwards and asserts `status = 'partial'`, `rows_unreversed = 4` and
`count(failures) = 4` — a combination the deferred trigger only permits when
the three agree.

⚠️ **An honest limitation of this particular induction.** The REVOKE bites
because `ordence_app` is not the table owner. In production the application
connects as the Neon owner, for whom GRANT and REVOKE are inert, so this exact
induction would prove nothing there. What it establishes is the behaviour of
the reversal engine when the database refuses a row — the same shape a foreign
key, a period lock or an append-only trigger produces, and **those do bind the
owner**. `trg_stock_ledger_append_only` is the live example, in §0.3.

### 4.6 The four dishonest endings, induced in SQL as `ordence_app`

```
$ psql "$TEST_DATABASE_URL" -f SQL-FILES/DRILL-…-0208a-partial-reversal.sql

(1) "reversed" with 100 of 1000 rows left behind
    ERROR: … violates check constraint "import_reversals_reversed_is_complete"
(2) "partial" reporting 100 unreversed rows and naming none of them
    ERROR: Reversal … reports 100 row(s) that could not be reversed and names 0.
           Every one of them has to be named with what blocked it: a customer
           told that a hundred rows are still there, and given no way to find
           them, has been given a number rather than an answer — and will start
           their migration again on top of those rows.
(3) an `irreversible` reversal recording 5 rows reversed
    ERROR: … violates check constraint "import_reversals_irreversible_refuses"
(4) a named failure whose whole reason is "failed"
    ERROR: … violates check constraint "import_reversal_failures_named"

(5) THE CONTROL — an honest partial, named row by row
 status  | rows_considered | rows_reversed | rows_unreversed | rows_named
---------+-----------------+---------------+-----------------+------------
 partial |               2 |             1 |               1 |          1

(6)  current_user | is_superuser | bypasses_rls
     ordence_app  | f            | f
```

⑤ is not decoration. A drill that only shows things being refused cannot tell
"correctly locked down" from "broken".

**② is the control this codebase needed.** A reversal that says 100 and names
three satisfies every CHECK constraint perfectly: the count is honest and the
report is useless. That true-summary-over-absent-detail shape is the one this
repository keeps finding, and a CHECK cannot see it because the evidence is in
another table.

---

## 5. Run-level idempotency

Two layers already existed and both are correct — the natural key protects the
**rows**, `import_run_chunks_once` protects the **counts**. Both are scoped to
one run. Neither has anything to say about the same file being started twice,
which is the ordinary case: the wizard lives in a browser and a customer
watching nothing happen presses the button again.

🔴 **And in `update` mode two runs over one file is not merely untidy.** The
second run overwrites what the first wrote and captures the **first run's
values** as the prior. Undoing run 2 restores the migration; undoing run 1
afterwards destroys what run 2 put back. There is no order in which the
customer can be told what will happen.

`import_runs_one_live_per_source` — `UNIQUE (tenant_id, entity_key,
source_fingerprint) WHERE source_fingerprint IS NOT NULL AND superseded_at IS
NULL AND status <> 'abandoned'`. All three predicates are load-bearing and
each removal is a different product bug that still reads as "the index is
present"; 0207's self-verification asserts the predicate text, not the index
name.

The second click **resumes** rather than failing — a refusal would lock a
customer whose first tab has closed out of their own migration with no way to
name the run they cannot see:

```
 ✓ run-level idempotency > gives the second tab the run the first tab created
     first.resumed  = false
     second.resumed = true
     second.runId   = first.runId
     count(import_runs for this workspace) = 1
     a DIFFERENT file → a different run
     the same file with a different duplicate mode → refused, by name
 ✓ run-level idempotency > refuses a fingerprint that is not one
     sourceFingerprint: "customers-final-v3.csv"  → "…is not a source fingerprint"
```

`sourceFingerprint` is **required**, for the reason `lib/import/types.ts` gives
about every member of the contract: an optional one is a mechanism that
protects the first caller who remembers it. It is validated in three places on
purpose — the action (names the caller), `startImportRun` (names the
mechanism), and `import_runs_fingerprint_shape` (makes it unavoidable). A
fingerprint that is the file *name* creates a claim that never collides, which
is idempotency that is present, declared and inert.

---

## 6. Gates, and the one that is red

```
$ npx tsc --noEmit                       (clean)

$ npm run gates:static
  26/27 passed  ·  1 FAILED
  🔴  check:migrations   duplicate or out-of-sequence SQL files

$ npm run check:rls        # database tier, against the bootstrap database
✅ RLS coverage complete — all 310 tenant-scoped tables enabled, forced and
   policied; row security applies to the application role; 0 drift findings;
   the schema contract matches; and 263 tables were probed with two real
   tenants and refused the cross-tenant read.

$ npx vitest run --project=security
 Test Files  64 passed (64)
      Tests  1529 passed (1529)
```

### 6.1 🔴 `check:migrations` is red, none of the 15 errors is mine, and every phase will hit it

```
$ npm run check:migrations
::error::Missing migration 0181 — the sequence jumps over it. …
::error::Missing migration 0182 …
   … through …
::error::Missing migration 0195 …
❌ Migration numbering FAILED — 15 problem(s).
```

Exactly fifteen, `0181`–`0195`, and not one of them in 0205–0210.

The cause is a one-line omission in `scripts/check-migrations.mjs`:

```js
for (const [letter, t] of Object.entries(map.tracks)) {
  if (!t.sql) continue;
  for (let n = t.sql[0]; n <= t.sql[1]; n++) reserved.set(n, `reserved for track ${letter}`);
}
```

It reads `t.sql` and **never `t.sqlAlso`**. Track H holds
`sql: [166,168], sqlAlso: [181,195]`, so its second block is invisible to the
gate while `--tree` mode in `check-track-ownership.mjs`, five files away, reads
both. Ranges covered by a `t.sql` — `0169–0180` (I, N), `0196–0204` (M1, M2) —
are tolerated silently; only H's reserve is not.

Reproduced independently, on a scratch tree of empty files:

```
$ # /tmp/sim3: every real SQL-FILES name, zero-length, + 0205..0209
$ node scripts/check-migrations.mjs | grep -c '::error::Missing'
15
$ node scripts/check-migrations.mjs | grep '::error::Missing' | sed 's/ — .*//'
… 0181 … 0195      (and nothing else)
```

**This fires for every phase that ships SQL above 0180.** Phases 1 and 3–10
will each see the same fifteen. The one-line fix is in
`PATCH-REQUEST-PHASE-2.md`; `scripts/**` is track H's, so it is not applied
here.

🔴 **And do not close it with `KNOWN_GAPS`.** That list means "never written
and never will be". A reservation is the opposite claim, and putting
`0181–0195` in it would make the gate lie about the exact fault it exists for
— the finding Batch 0108 already wrote down.

### 6.2 0211–0214 are allocated and unclaimed, and will go red later

Phase 2's block is 0205–0214 and the work took six files. `check:migrations`
counts gaps up to the highest number present, so `0211–0214` are invisible
today and become four errors the moment Phase 3 ships `0215`.

That is the third shape of migration gap — not *retired* (0062/0072/0076), not
*reserved and superseded* (0107), but **allocated in a block and never
claimed**, which is what happened to `0143–0145`. They will never self-resolve.
The exact `KNOWN_GAPS` entries are in `PATCH-REQUEST-PHASE-2.md`. Unlike
§6.1, `KNOWN_GAPS` **is** the right instrument here: these numbers will never
be written.

### 6.3 ⚠️ `scripts/bootstrap-test-db.mjs` now reports one refused statement

```
$ node scripts/bootstrap-test-db.mjs --force
  push the base schema (drizzle-kit)…               ✅  312 base tables
  apply ALL-IN-ONE-SETUP.sql…                       ✅  461 statements, 0 refused
  apply the numbered SQL files, in order…           ✅  160 files, 1 refused
     0140_tenant_table_drift_detector.sql: 23514
       0140 FAILED: the database already has 4 drift finding(s) before the self-test.
  confirm row-level security is actually enabled…   ✅  323 tables protected
```

The bootstrap still exits 0 and `check:rls` is green on the finished database
(§6). But the number went from 0 to 1 and that is worth understanding, because
**every entity phase will make it worse.**

Reproduced exactly, on a scratch database stopped at migration 0139:

```
DRIFT AT 0140: [
  {"table_name":"import_reversal_failures","property":"tenant-policy"},
  {"table_name":"import_reversals",        "property":"tenant-policy"},
  {"table_name":"import_row_prior_values", "property":"tenant-policy"},
  {"table_name":"import_row_provenance",   "property":"tenant-policy"}
]
```

The chain: `bootstrap-test-db.mjs` runs `drizzle-kit push` **before** the
numbered files, so the four new tables exist — bare — from migration 0001
onward. `0122` and `0125` are discovery loops and attach the change-log and
impersonation triggers to them. `0137` is a discovery loop and turns row
security **on and FORCED** for them. Their policies do not arrive until 0205.
Between 0137 and 0205 the four tables are forced with no policy — which denies
everything, fails closed, and is exactly what `tenant_table_drift()` is for.

🔴 **The root cause is `drizzle-kit push` in the bootstrap** — the command this
project bans in production because it *drops* RLS policies. Here it does the
mirror-image damage: it creates tables **ahead of** the migrations that protect
them. In production, where migrations run alone, 0205 creates each table
complete and 0140 never sees a bare one.

The precedent in this repo is to keep post-0140 tables out of `db/schema/`
entirely — `tax_decisions` (0150) is not there, which is why the count was 0
before this batch. That is not available to Phase 2: the phases map assigns
`db/schema/import-runs.ts` to it, and `server/import/*.ts` has to query these
tables through Drizzle.

A fix that keeps 0140's intent — a **delta** assertion rather than an absolute
zero — is written out in `PATCH-REQUEST-PHASE-2.md`. `SQL-FILES/0140` is track
C's file and `scripts/bootstrap-test-db.mjs` is track H's, so neither is
touched here.

### 6.4 Two `--project=ui` tests fail, and both fail on the pristine tree too

```
$ npx vitest run --project=ui
 Test Files  2 failed | 207 passed (209)
      Tests  2 failed | 6697 passed | 8 skipped (6707)

 × tests/ui/opening-balances.test.ts > … resolves through the same allowlist
   → expected { key: 'opening-trial-balance', …(19) } to be { …(18) }
 × tests/ui/assemble-wave.test.ts > REFUSES a delivery that turns the gates red
   → expected 78 to be 1
```

Both reproduce on an untouched extraction of `ordence-DEPLOY-v1.84.1-alpha.zip`:

```
$ cd /home/claude/p2/pristine   # fresh unzip, nothing from this phase
$ npx vitest run --project=ui tests/ui/opening-balances.test.ts \
                              tests/ui/assemble-wave.test.ts
 Test Files  2 failed (2)
      Tests  2 failed | 53 passed (55)
```

The first is Track M1's `openingWithContracts` spread: `ALL_IMPORT_ENTITIES[k]`
is now `{...OPENING_IMPORT_ENTITIES[k], contract}`, a **new object**, and the
test asserts `toBe` — object identity — against the original. 19 keys against
18. Neither is Phase 2's to fix; both are recorded here so nobody attributes
them to this batch.

---

## 7. What is in the delivery, and what is not this phase's to ship

`ordence-phase-2-ledger.zip`, real repo paths from the repo root.

**Owned by Phase 2** (per `track-ownership-phases.json`), delivered in place:

```
SQL-FILES/0205_import_row_provenance.sql
SQL-FILES/0206_import_prior_values.sql
SQL-FILES/0207_import_run_idempotency.sql
SQL-FILES/0208_import_reversals.sql
SQL-FILES/0209_import_destination_reversibility.sql
SQL-FILES/0210_import_reversal_primitives.sql
SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0208a-partial-reversal.sql
SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0210a-restore-measures-escapes.sql
db/schema/import-runs.ts
server/import/ledger.ts
server/import/reversal.ts
server/import/runs.ts
```

**NOT owned by Phase 2**, needed by it, and therefore delivered under
`PATCHED-FILES-NOT-OWNED-BY-PHASE-2/` rather than in place:

| file | owner | why |
|---|---|---|
| `server/actions/import.ts` | PHASE-1 | `beginImportRun` must pass `sourceFingerprint`. Without it `tsc` fails: `Property 'sourceFingerprint' is missing`. |
| `lib/dpdp/classification.ts` | no phase | four new tables. Without it `check:data-classification` fails. |
| `tests/security/import-reversal.test.ts` | track D | **the proof**. Without it nothing in §4 is verifiable. |

Every gate result in §6 was measured **with all three applied**. Applied
selectively, the tree does not compile. Each is set out line by line in
`PATCH-REQUEST-PHASE-2.md`.

⚠️ **A note on `scripts/track-ownership.json`.** The tree's own map still
carries the older M1–M8 scheme, in which `M2 "Import ledger"` holds
`sql: [200, 206]` and the same two paths. `track-ownership-phases.json` — the
file that came with the brief — says to merge the PHASE-* entries into it.
Under either map `npm run check:track-ownership` passes on this delivery
(0205–0210 are owned by M2/M3 in the old map and by PHASE-2 in the new one),
but the two disagree about who owns 0207–0210 and integration should apply the
merge rather than leave both.

---

## 8. What Phase 2 deliberately did not do

- **`lib/import/entities.ts` and `contract/opening-policies.ts` are untouched**,
  so `opening-stock` still declares an undo the stock ledger refuses (§0.3).
  The one-word change is in the patch request. Editing another track's contract
  from inside a migration batch would be worse than recording the disagreement
  — wave 17's lesson about a control that must be "last".
- **No entity is registered and no writer is written.** Phase 1 owns
  `server/import/writers/**` and the registry. `writeRowWithLedger` takes the
  write as a callback and is waiting for them.
- **No permission check in `server/import/reversal.ts`**, deliberately, and it
  is this repository's own pattern: `server/accounting/post-sales.ts` posts and
  `server/actions/*` does `requireRole` / `requireAccess` / `requireFeature`.
  Putting the checks in the module would make it unrunnable outside a request,
  which is to say unverifiable against a real database. The action wrapper is
  in the patch request.
- **The reversing-entry shape is written a third time and that is one too
  many.** `reverseTransaction` in `server/actions/accounting.ts` has it, a
  person doing it by hand is the second, and `postReversingJournalEntry` here
  is the third. It is not imported from there because that module is
  `"use server"` — calling it would run `requireRole` against a cookie jar and
  `revalidatePath` against a request that does not exist. The extraction into
  `server/accounting/post-sales.ts`, where the other twenty posting primitives
  live, is in the patch request.
- **Zero new npm dependencies.** `node:crypto` for the fingerprint, nothing else.

---

## 9. Open, and honest about it

1. **`escapes: null` is wrong on `companies` and `gst_parties`.** Measured, not
   argued (§3.4). The reversal reports the truth; the declaration still says
   otherwise, and gate 29 will never notice. Patch request.
2. **`opening-stock` cannot be undone at all today** (§0.3). The reversal
   refuses up front, naming the trigger, rather than failing a thousand times —
   but refusing is not the same as working.
3. **`import_row_prior_values` holds verbatim customer records and the DPDPA
   detector did not flag it.** Its 41 rules match column *names*, and no rule
   matches `prior_values` — `freeform-jsonb` looks for `detail`, `details`,
   `payload`, `metadata`, `raw`, `lines`. A column holding an entire copy of
   another table under an unfamiliar name is invisible to it. Classified
   anyway, because the table needs it; the detector gap is in the patch
   request, because the next phase to store a record under an unusual column
   name will hit it too.
4. **A `running` reversal whose process dies holds the one-live lock for ever.**
   `abandonReversal()` is the deliberate way out — it names every row it did
   not reach, because `import_reversal_failures_named` would refuse anything
   less. There is no timeout, on purpose: "it has been running an hour so it
   must be dead" is a guess, and acting on it while the first undo is still
   going is how two reversals remove the same rows.
5. **Nothing calls any of this yet.** `writeRowWithLedger` needs Phase 1's
   writers; `reverseImportRun` needs the action wrapper and the wizard's undo
   button. `check:reachability` is satisfied (the tables are named in
   `server/import/*.ts`) and that is a weaker statement than "reachable from a
   screen". Until Phase 1 and Phase 10 land, this is built-and-not-yet-reached
   — which is the honest description, and the thing to check first at
   integration.

---

## 10. Cross-checks against the other phases

Two findings in this report were reached independently by Phase 3, working
from the same tree, and the agreement is worth recording because both are
things a single reader could plausibly have got wrong.

- **The `sqlAlso` bug (§6.1).** Phase 3 reports it in the same terms: *"any
  migration numbered 0196+ makes `check:migrations` report 15 phantom missing
  files — which is every one of Phases 1–10"*, and reaches the same conclusion
  about `KNOWN_GAPS` being the wrong instrument. Two phases, two measurements,
  one one-line fix that nobody who is not track H can apply.
- **The two red `--project=ui` tests (§6.4).** Phase 3 verified them *"against
  an unmodified unpack"* of v1.84.1-alpha. So did this phase, separately. They
  are the tree's, not any phase's.

And one finding of Phase 3's bears directly on this one, in a way that is
worth stating precisely rather than filing away:

> *"`opening-trial-balance` declares `provenance.targets: ["transactions"]` and
> its writer also inserts `journal_entries`. Provenance decides what a reversal
> can undo."*

That is correct, and for **this** entity it is harmless — for one reason that
is worth being explicit about rather than lucky. `opening-trial-balance`
declares `reverse-entry`, whose unit is the TRANSACTION: the undo posts a
mirror transaction and lets the legs follow, and `journal_entries` is
append-only anyway (`journal_entries_no_delete`, `journal_entries_no_update`,
for every role), so there is nothing a row-by-row undo could have done to it.

🔴 **It would be fatal for any kind that acts row by row.** An entity that
wrote a second table and declared `delete` would have that table's rows
attributed to nothing, and the undo would remove the parent, report success,
and leave the children — which is precisely what `provenance.targets` exists to
prevent and what gate 29 checks only for the entity's own `table`. The gate
requires `targets` to *include* `table`; it cannot know what else the writer
touches, because the writer is in another file and another track.

The remedy belongs with Phase 3's patch request, not this one. What Phase 2
adds is that the consequence is now measurable rather than theoretical:
`ledgerCensus()` compares a run's `rowsWritten` against its provenance rows and
names the difference — exempting `whole-file` and `many` by cardinality, so an
opening trial balance of 40 lines writing one document is not reported as 39
losses.
