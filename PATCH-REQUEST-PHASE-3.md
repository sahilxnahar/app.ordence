# PATCH-REQUEST-PHASE-3 — what Phase 3 needs in files it does not own

Build **v1.84.1-alpha**. Phase 3 owns `server/import/discovery.ts`,
`server/import/dryrun.ts` and SQL **0215–0219**. Everything below is outside
that and is therefore a request, not a change. Nothing here has been applied
to the delivered tree except where it says **APPLIED** (there are no such
items; the tree is unmodified outside Phase 3's own paths, plus the three test
files listed in §6).

Ordered by what blocks whom.

---

## 1. 🔴 BLOCKS EVERY MIGRATION PHASE — `scripts/check-migrations.mjs` ignores `sqlAlso`

**Owner:** track H (Integration) — `scripts/**`.
**Effect:** `npm run gates:static` is **26/27** for Phase 1 through Phase 10,
every one of them, on a defect none of them can fix.

`scripts/track-ownership.json` gives track H a reserve block through `sqlAlso`:

```json
"H": { "sql": [166, 168], "sqlAlso": [181, 195], … }
```

`scripts/check-track-ownership.mjs` honours it:

```js
for (const [lo, hi] of [t.sql, ...(t.sqlAlso ? [t.sqlAlso] : [])]) {
```

`scripts/check-migrations.mjs::reservedNumbers()` does not:

```js
if (!t.sql) continue;
for (let n = t.sql[0]; n <= t.sql[1]; n++) { … }
```

So 0181–0195 are reserved for the tree checker and unreserved for the
sequence checker. The moment ANY file lands at 0196 or above — which is
where M1's block starts and where all ten phases live — the sequence checker
reports fifteen phantom gaps:

```
$ npm run check:migrations
::error::Missing migration 0181 — the sequence jumps over it. …
… ×15 …
❌ Migration numbering FAILED — 15 problem(s).
```

**The fix, and it is the loop the other checker already uses:**

```js
    for (const [letter, t] of Object.entries(map.tracks)) {
      if (!t.sql) continue;
      for (const [lo, hi] of [t.sql, ...(t.sqlAlso ? [t.sqlAlso] : [])]) {
        for (let n = lo; n <= hi; n++) {
          reserved.set(n, `reserved for track ${letter} (${t.name}) during waves 14 to 16`);
        }
      }
    }
```

**Proven, by applying it to a copy and re-running:**

```
$ npm run check:migrations          # with the four-line change
  98 numbers reserved for parallel tracks, 64 still unused. A gap inside a
  reserved block is expected until every track has delivered.
✅ Migrations contiguous — 156 files, 0001…0216 (6 documented historical
   gaps). Next number: 0217.
```

The change was then **reverted** — `scripts/` is not Phase 3's — and the
delivered tree ships with the gate red for this reason and this reason only.

⚠️ **Do not close it with `KNOWN_GAPS`.** That list means "never written, and
never will be", and 0181–0195 are held for a track that has not delivered yet.
Putting them there would make a real future gap invisible.

---

## 2. 🔴 `import_row_provenance` has no Drizzle definition

**Owner:** Phase 2 — `db/schema/import-runs.ts`.

SQL 0215 (Phase 3) creates the sidecar `lib/import/types.ts` has referred to
since Track M1 — see §5 for why Phase 3 created it at all. `npm run check:sql`
reports it as an orphan, which is accurate and which means `drizzle-kit push`
would offer to drop it. Paste-ready:

```ts
/**
 * ⭐ WHICH RUN, WHICH FILE, WHICH LINE PRODUCED THIS ROW — the sidecar,
 * SQL 0215. Written in the same transaction as the row it describes.
 *
 * 🔴 `runId` IS NOT NULL AND THAT IS THE DRY RUN'S TEETH. A preview has no
 * run, so the database refuses provenance from a preview even if a future
 * edit tried to write it.
 */
export const importRowProvenance = pgTable(
  "import_row_provenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "cascade" }),
    entityKey: varchar("entity_key", { length: 60 }).notNull(),
    /** NULL exactly when cardinality is `whole-file`. Enforced by a CHECK. */
    recordNumber: integer("record_number"),
    sourceName: varchar("source_name", { length: 255 }),
    targetTable: varchar("target_table", { length: 63 }).notNull(),
    targetId: uuid("target_id").notNull(),
    cardinality: varchar("cardinality", { length: 12 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("import_row_provenance_run_idx").on(t.tenantId, t.runId, t.targetTable),
    index("import_row_provenance_target_idx").on(t.tenantId, t.targetTable, t.targetId),
    uniqueIndex("import_row_provenance_once_per_run").on(t.runId, t.targetTable, t.targetId),
  ],
);
```

⚠️ There is deliberately no `updatedAt` and no `deletedAt`: SQL 0215 §4
refuses every UPDATE for every role, and the absence of the columns is how
`journal_entries` says the same thing.

---

## 3. 🔴 FINDING — `opening-trial-balance` declares one destination and writes two

**Owner:** Track M1 / whoever folds `contract/opening-policies.ts` into
`lib/import/opening-entities.ts`.

`lib/import/contract/opening-policies.ts`:

```ts
provenance: { targets: ["transactions"], cardinality: "whole-file" },
```

`writeOpeningTrialBalance` in `server/actions/import.ts` inserts into
`transactions` **and** `journal_entries`.

**Proven by execution** — `tests/security/import-dry-run-parity.test.ts` §7:

```
undeclaredDestinations for opening-trial-balance after a commit:
  ["journal_entries", …]
declaredDestinations(opening-trial-balance):
  ["import_row_provenance", "transactions"]
```

**Why it matters.** `ImportProvenancePolicy` is what makes reversal possible:
*"`delete` needs to know which ids this run created"*. The reversal for this
entity is `reverse-entry` rather than `delete`, so nothing is destroyed today
— but a reconciliation reading the declared targets sees one row per file and
never looks at the legs that carry the money, and the first entity Phase 8
adds with a `delete` reversal and an undeclared second table will delete the
parent and leave the children.

**The fix:**

```ts
provenance: { targets: ["transactions", "journal_entries"], cardinality: "whole-file" },
```

⚠️ `journal_entries` is not currently in `ImportTableKey`, so this needs the
union widened too. `ImportProvenancePolicy.targets` is
`readonly (ImportTableKey | PendingImportTableKey)[]` — a destination an
entity WRITES but does not have as its own `table` is exactly the case the
union was widened for, and gate 29 already checks `targets` includes `table`
rather than requiring the two to be equal.

---

## 4. 🔴 FINDING — an atomic entity with one unresolvable lookup promises rows that cannot land

**Owner:** `server/actions/import.ts` (Phase 1) with
`lib/import/opening-entities.ts`.

This is the one case in the delivered corpus where **preview counts do not
equal commit counts**, and it is the exact drift this phase exists to catch.

**Reproduction** (`tests/security/import-dry-run-parity.test.ts` §7, executed):

```
file: three trial-balance lines as at 2026-09-30, balanced,
      one naming an account code that does not exist

preview : { create: 2, update: 0, skip: 0, error: 1 }
commit  : { create: 0, update: 0, skip: 0, error: 3 }
previewMoved: []        ← the dry run still touched nothing
commitMoved : []        ← and nothing landed
```

**Why.** `runImport` removes lookup misses from `validRows` **after**
`planImportRecords` has already run `fileRule` over the WHOLE file and found
it balanced. What reaches `writeOpeningTrialBalance` is an unbalanced subset,
and the deferred `journal_entries_balance_check` refuses the transaction at
COMMIT. Nothing is written, so this is not data loss — it is the preview
promising two rows that were never possible.

**Two candidate fixes, and the second is the one Phase 3 recommends:**

① Re-run `fileRule` after lookup resolution. Rejected here: `fileRule` is
   pure by design and lives in `lib/import/`; feeding it a database result
   would end the purity that makes constraint 1 testable at all.

② **An atomic entity refuses the whole file when any lookup misses**, the
   same way it already refuses the whole file when any row fails validation.
   The reasoning on `atomic` in `types.ts` applies unchanged: *"importing 38
   of its 40 lines does not give the customer 95% of their opening
   position"*. The refusal is written as row errors and not as a `fatal`, so
   the failed-rows CSV survives. In `runImport`, immediately after the
   `missing.length > 0` branch:

```ts
    /*
     * 🔴 AN ATOMIC ENTITY CANNOT LOSE A ROW TO A LOOKUP EITHER. `fileRule`
     * balanced the whole file; the writer is about to be handed a subset of
     * it, and the ledger's deferred balance trigger will refuse that subset
     * at COMMIT — after the preview promised the rows.
     */
    if (entity.atomic && outcomes.size > 0) {
      const refusal = describeAtomicRefusal(entity.noun.many, outcomes.size, parsedRows.length);
      for (const row of validRows) {
        outcomes.set(row.recordNumber, {
          disposition: "error",
          matchedOn: null,
          errors: [{ column: null, message: refusal }],
        });
      }
      validRows.length = 0;
    }
```

`tests/security/import-dry-run-parity.test.ts` asserts the **defect** today,
with the reasoning in a comment. It goes red when this lands, which is when
somebody should read that comment and change the expectation to
`{ create: 0, error: 3 }` in BOTH runs.

---

## 5. ⚠️ `import_row_provenance` was specified as SQL 0196, which is not in this tree

**Owner:** Track M1 (0196–0199) / integration.

`lib/import/types.ts` says the sidecar is "SQL 0196". The highest numbered
migration in v1.84.1-alpha is 0168, and 0196 is not Phase 3's to write. Phase
3 needs the table to obey its own brief — *"count `import_row_provenance`
too"* — and a footprint that silently skips a table it was told to count is
verified-by-absence.

So `SQL-FILES/0215_import_row_provenance.sql` creates it, **idempotently**:
every statement is `IF NOT EXISTS` or `DROP … IF EXISTS` + `CREATE`, and §7
asserts the final shape from `information_schema` rather than asserting that
it did the work. Applied after M1's 0196 it is a conformance check on 0196.

**At integration, do one of:**

- 0196 has not been written → **keep 0215** and delete the "SQL 0196" phrase
  from `lib/import/types.ts`, or change it to 0215.
- 0196 has been written and creates the same ten columns → **delete 0215**;
  nothing else in Phase 3 depends on the file, only on the table.
- 0196 has been written and creates something different → **do not delete
  0215.** Apply it; §7 will name every column it is missing. The ten columns
  `server/import/dryrun.ts` and any reversal path read are:
  `id, tenant_id, run_id, entity_key, record_number, source_name,
  target_table, target_id, cardinality, created_at`. An EXTRA column is a
  `RAISE NOTICE`, not a refusal — 0196 is allowed to know things Phase 3
  does not.

---

## 6. ⚠️ The phase map allocates no test paths, so three test files sit outside every phase's ownership

**Owner:** whoever merges `track-ownership-phases.json` into
`scripts/track-ownership.json`.

`track-ownership-phases.json` gives PHASE-3 two source files and a SQL block
and no test path. The brief requires proof by execution, so Phase 3 ships:

| file | project | what it proves |
|---|---|---|
| `tests/security/import-dry-run-parity.test.ts` | security (real Postgres) | the corpus; the footprint; SQL 0215's runtime teeth |
| `tests/ui/import-discovery.test.ts` | ui (jsdom, no database) | discovery, and — by running at all — that it is pure |

`tests/security/**` is track D's and `tests/ui/**` is track H's. Every phase
will have this problem. Suggested addition to each phase's `paths`:

```json
"tests/security/import-*.test.ts",
"tests/ui/import-*.test.ts"
```

with track D and track H excluding `import-*` from their broad globs, the way
D already excludes `tests/security/gst-*.test.ts` for track E.

---

## 7. ⚠️ `server/import/discovery.ts` is pure and belongs under `lib/import/`

**Owner:** integration.

The decision layer is pure — no database, no network, no clock, no `node:`
import, no `server-only` — because the brief requires it and because the
wizard has to run it in the browser. It sits in `server/` only because Phase
3 owns `server/import/discovery.ts` and owns nothing under `lib/import/`.

At integration, move it to `lib/import/discovery.ts` and update the two
imports in the tests. Nothing else references it yet.

⚠️ **The move must not be a re-home into `server/`-shaped code.** If a later
phase needs a folder READ, that belongs in `server/actions/import.ts` or the
wizard, handing `CsvRecord[]` in. The moment `discovery.ts` needs
`import "server-only"` it has stopped being the decision layer, and the
wizard's folder screen stops being able to run it.

---

## 8. ℹ️ A gate for the parity guarantee

**Owner:** track H — `package.json` is `shared`, `scripts/**` is H's.

The corpus runs inside the security suite, which CI runs. If integration
wants it as a named gate in the manifest:

```json
"check:dry-run-parity": "vitest run --project=security tests/security/import-dry-run-parity.test.ts"
```

⚠️ It would need adding to `scripts/gates.json` / `run-gates.mjs` and to the
CI workflow together — `check:gate-coverage` asserts that package.json, the
files and the workflow all agree, and it will refuse a half-registered gate.

---

## 9. ℹ️ Observation, not a request — the ledger's best refusal is discarded

`describeWriteFailure` in `server/actions/import.ts` passes a 23514 through
to the customer verbatim, which is right. It does not reach that branch for
the balance check, because `journal_entries_balance_check` is a **deferred**
constraint trigger: it fires at COMMIT, so the driver raises it from `COMMIT`
rather than from an INSERT and Drizzle wraps it with `code` on `cause`.

Measured (`§7`, executed): the customer is shown

> This row was refused by the database and has not been imported.

and the sentence that was discarded is

> `23514` … Transaction … is unbalanced …

`server/import/dryrun.ts` has a `withDatabaseSentence()` helper that walks the
`cause` chain for the first object carrying a `code`; four lines of the same
in `describeWriteFailure` would recover it. Phase 3 does not own that file and
the fix in §4 makes this particular case unreachable — but the wrapper is
between every write in the product and every message a customer reads.
