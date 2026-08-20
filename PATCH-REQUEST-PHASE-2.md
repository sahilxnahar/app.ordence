# PATCH-REQUEST — Phase 2 (run ledger, idempotency, reversal)

Twelve changes in files Phase 2 does not own. Three of them (**A, B, C**) are
required for the tree to compile and for `gates:static` to reach the state
reported in `TRACK-REPORT.md` §6 — the finished files are in the delivery under
`PATCHED-FILES-NOT-OWNED-BY-PHASE-2/`, at their real repo paths. The rest are
findings with the remedy written out; none of them is applied.

Ordered by what breaks if it is skipped.

---

## A. `server/actions/import.ts` — `beginImportRun` must fingerprint the file
**Owner: PHASE-1. Required to compile. Finished file supplied.**

`StartRunArgs.sourceFingerprint` is required, for the reason
`lib/import/types.ts` gives about every member of the import contract: an
optional one is a mechanism that protects the first caller who remembers it.
Without this change:

```
$ npx tsc --noEmit
server/actions/import.ts(1870,40): error TS2345: … Property 'sourceFingerprint'
  is missing in type '{ tenantId: string; … }' but required in type 'StartRunArgs'.
server/actions/import.ts(1881,32): error TS2322: Type 'StartRunResult' is not
  assignable to type 'string'.
```

Three edits inside `beginImportRun`:

**A1 — the input schema gains a field.** After `expectedRows`:

```ts
        /**
         * ⭐⭐⭐ PHASE 2 · RUN-LEVEL IDEMPOTENCY. `sha256:<64 lower-case hex>`
         * over the BYTES of the file, computed in the browser with WebCrypto
         * — the server never receives them.
         *
         * 🔴 REQUIRED. Without it two browser tabs start two runs over one
         * file, and in `update` mode the second captures the FIRST run's
         * values as the prior: undoing run 2 restores the migration, undoing
         * run 1 afterwards destroys what run 2 put back. There is no order in
         * which the customer can be told what will happen.
         */
        sourceFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/, {
          message:
            "The file could not be fingerprinted in your browser. Nothing has been started — " +
            "without it, starting the same file twice would create two migrations that cannot " +
            "both be undone.",
        }),
```

**A2 — pass it through, and stop discarding the answer.**

```ts
    const run = await startImportRun({ …, sourceFingerprint: params.sourceFingerprint });

    return {
      ok: true,
      data: { runId: run.runId, chunkSize: MAX_IMPORT_ROWS,
              resumed: run.resumed, note: run.note },
    };
```

**A3 — widen the return type** to
`ActionResult<{ runId: string; chunkSize: number; resumed: boolean; note: string | null }>`.

⚠️ `resumed` and `note` must reach the wizard rather than being swallowed.
"Starting" and "picking up where the last attempt stopped, the rows already
here will be recognised rather than duplicated" are different sentences, and a
customer shown the first when the second is true will wonder why the progress
bar begins at 60%.

### A4 — and the browser has to compute it (PHASE-10, `components/settings/import-wizard.tsx`)

```ts
const bytes = new Uint8Array(await file.arrayBuffer());
const digest = await crypto.subtle.digest("SHA-256", bytes);
const sourceFingerprint =
  "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
```

⚠️ **Over the bytes of the file, not over the parsed records and not over the
name.** A customer who fixes one cell and re-uploads has a different file and
is entitled to a different run; a customer who renames the file has not.
`importSourceFingerprint()` in `server/import/runs.ts` is the same algorithm
for a caller that genuinely has the bytes — a test, a server-side re-import —
so the two collide rather than merely looking alike.

---

## B. `lib/dpdp/classification.ts` — four new tables
**Owner: no phase. Required for `check:data-classification`. Finished file supplied.**

Without it:

```
$ npm run check:data-classification
::error::`import_reversals` … column `requested_by` matched the "link-actor" rule …
::error::`import_reversal_failures` … column `blocked_by` matched the "link-actor" rule …
❌ Data classification FAILED — 2 problem(s).
```

Four entries are added after `IMPORT_MAPPING_PROPOSALS`, and the four names
appended to `export const CLASSIFICATION`:
`IMPORT_ROW_PROVENANCE`, `IMPORT_ROW_PRIOR_VALUES`, `IMPORT_REVERSALS`,
`IMPORT_REVERSAL_FAILURES`. All four `scope: "tenant"`, `holds: "personal"`,
`retention: "companies-act-128-5"`, reaching a person through `run_id →
import_runs` (and `requested_by → user` for the reversal).

🔴 **The gate asked for two of the four. The other two are the important ones.**
See **H** below.

---

## C. `tests/security/import-reversal.test.ts` — the proof
**Owner: track D (`tests/security/**`). Offered, not claimed. Supplied.**

1,061 lines, 9 tests. **Without this file nothing in `TRACK-REPORT.md` §4 is
verifiable**, and "the state after import-then-undo is byte-identical to the
state before the import" is a sentence rather than a measurement.

It lives here because `tests/security/**` is the only directory in the
repository wired to a real PostgreSQL — `tests/setup.ts` bridges the Neon
serverless driver to a local server, so `withTenant()` (the function that pins
the RLS session variable) is the one under test, connected as `ordence_app`,
which is NOSUPERUSER and NOBYPASSRLS. A proof of reversal that does not touch a
database is not a proof of anything.

It exercises the real modules — `writeRowWithLedger`, `reverseImportRun`,
`startImportRun` — and re-implements none of them. Both halves of its central
claim have been induced:

```
$ # reversal.ts: make restore-prior ignore `operation`
 × kind: restore-prior …  → expected 'partial' to be 'reversed'

$ # ledger.ts: capture only the columns the import writes
 × kind: restore-prior …  → expected null to be 'Rang de Basanti — MD prefers…'
```

If track D would rather own a different shape, the one property to keep is
`snapshotWorkspace()`: it reads **every tenant-scoped table discovered from
`information_schema`**, not a list, and compares with `toEqual` against an
exact divergence list. A hand-written list of "tables the import touches" is
correct on the day it is written and silently wrong the first time a trigger
writes somewhere nobody expected — `sales_invoices_order_writeback` and
`ordence_refresh_stock_balance` both do exactly that.

---

## D. 🔴 `scripts/check-migrations.mjs` — `reservedNumbers()` ignores `sqlAlso`
**Owner: track H. Fires for every phase that ships SQL above 0180.**

```
$ npm run check:migrations
::error::Missing migration 0181 … through … 0195
❌ Migration numbering FAILED — 15 problem(s).
```

Fifteen errors, none of them in 0205–0210, and they appear the moment ANY file
above 0180 lands. Reproduced on a scratch tree of zero-length files carrying
only the real names plus `0205..0209`: `grep -c '::error::Missing'` → `15`,
all `0181`–`0195`.

```js
// scripts/check-migrations.mjs, reservedNumbers()
for (const [letter, t] of Object.entries(map.tracks)) {
  if (!t.sql) continue;
  for (let n = t.sql[0]; n <= t.sql[1]; n++) reserved.set(n, `reserved for track ${letter} …`);
}
```

`t.sqlAlso` is never read. Track H holds `sql: [166,168]` **and**
`sqlAlso: [181,195]`; `check-track-ownership.mjs --tree`, five files away,
already reads both:

```js
for (const [lo, hi] of [t.sql, ...(t.sqlAlso ? [t.sqlAlso] : [])]) { … }
```

**The fix, matching the shape the other gate already uses:**

```js
for (const [letter, t] of Object.entries(map.tracks)) {
  if (!t.sql) continue;
  // ⚠️ `sqlAlso` TOO. Track H holds a second block (181–195) and reading only
  // `sql` makes it invisible here while `check-track-ownership.mjs --tree`
  // reads both — so the ownership map says a number is reserved and the
  // numbering gate says it is missing. Fifteen errors, for every track that
  // ships above 0180.
  for (const [lo, hi] of [t.sql, ...(t.sqlAlso ? [t.sqlAlso] : [])]) {
    for (let n = lo; n <= hi; n++) reserved.set(n, `reserved for track ${letter} …`);
  }
}
```

🔴 **Do NOT close this with `KNOWN_GAPS`.** That list means "never written and
never will be"; a reservation is the opposite claim. Batch 0108 wrote this down
already: adding another stream's in-flight number to `KNOWN_GAPS` makes the
gate lie about the exact fault it exists for.

---

## E. `scripts/check-migrations.mjs` — `KNOWN_GAPS` for 0211–0214
**Owner: track H. Not urgent today; four errors the moment Phase 3 ships 0215.**

Phase 2's block is 0205–0214 and the work took six files. Gaps are only counted
up to the highest number present, so 0211–0214 are invisible now and become
four `::error::Missing` the moment `0215` lands.

This is the third shape of migration gap — not *retired* (0062/0072/0076), not
*reserved and superseded* (0107), but **allocated in a block and never
claimed**, which is what happened to 0143–0145. Here `KNOWN_GAPS` **is** the
right instrument: these will never be written.

```js
  /**
   * ⭐ 0211–0214 WERE ALLOCATED TO PHASE 2 AND NEVER CLAIMED — the third
   * shape of gap, after `retired` (0062/0072/0076) and `reserved then
   * superseded` (0107). Phase 2's block was 0205–0214 and the work took six
   * files: 0205 provenance, 0206 prior values, 0207 idempotency, 0208 the
   * reversal ledger, 0209 destination reversibility, 0210 the primitives.
   * They will never self-resolve, exactly as 0143–0145 did not.
   */
  [211, "allocated to Phase 2 (block 0205–0214) and never written — the work took six files, 0205–0210"],
  [212, "allocated to Phase 2 (block 0205–0214) and never written"],
  [213, "allocated to Phase 2 (block 0205–0214) and never written"],
  [214, "allocated to Phase 2 (block 0205–0214) and never written"],
```

---

## F. ⚠️ `SQL-FILES/0140` §3 — a precondition that cannot hold during a rebuild
**Owner: track C (0140) and track H (`scripts/bootstrap-test-db.mjs`).**

```
$ node scripts/bootstrap-test-db.mjs --force
  apply the numbered SQL files, in order…  ✅  160 files, 1 statement(s) refused
     0140_tenant_table_drift_detector.sql: 23514
       0140 FAILED: the database already has 4 drift finding(s) before the self-test.
```

Measured, on a scratch database stopped at 0139:

```
DRIFT AT 0140: [
  {"table_name":"import_reversal_failures","property":"tenant-policy"},
  {"table_name":"import_reversals",        "property":"tenant-policy"},
  {"table_name":"import_row_prior_values", "property":"tenant-policy"},
  {"table_name":"import_row_provenance",   "property":"tenant-policy"}
]
```

The chain: the bootstrap runs `drizzle-kit push` **before** the numbered files,
so the four tables exist — bare — from 0001 onward. `0122` and `0125` are
discovery loops and attach their triggers. `0137` is a discovery loop and turns
row security **on and FORCED**. The policies do not arrive until 0205. Between
0137 and 0205 the four tables are forced with no policy: they deny everything,
fail closed, and `tenant_table_drift()` reports them, correctly.

🔴 **The root cause is `drizzle-kit push` in the bootstrap** — the command this
project bans in production because it *drops* RLS policies. Here it does the
mirror-image damage: it creates tables **ahead of** the migrations that protect
them. In production, where migrations run alone, 0205 creates each table
complete and 0140 never sees a bare one.

**This will get worse.** Phases 4–8 each add entity tables to `db/schema/`.
Every one of them adds four more findings at 0140. The precedent — keeping
post-0140 tables out of `db/schema/` entirely, as `tax_decisions` (0150) is —
is not available to a phase whose server modules must query its tables through
Drizzle.

**Proposed fix (0140 §3), which does not weaken anything.** The self-test needs
a clean *baseline*, not an empty *database*. Record the count before the probe
and assert the DELTA:

```sql
DO $$
DECLARE baseline integer; found integer; after integer;
BEGIN
  -- ⚠️ A BASELINE, NOT A ZERO. During a from-scratch rebuild the Drizzle push
  -- creates later phases' tables before the migrations that give them
  -- policies, so tables legitimately drift between 0137 and the migration that
  -- creates their policy. That does not invalidate this self-test — it only
  -- means "clean" is not 0. The ABSOLUTE assertion still exists, in
  -- `check:rls-coverage`, which runs against the FINISHED database and fails
  -- on any row at all. Asserting it here as well, at a position where it
  -- cannot hold, is the same "control that must be last" mistake wave 17
  -- removed from 0142.
  SELECT count(*) INTO baseline FROM tenant_table_drift();
  … create the deliberately unprotected probe table …
  SELECT count(*) INTO found FROM tenant_table_drift();
  IF found <> baseline + 4 THEN
    RAISE EXCEPTION '0140: the detector found % findings for the probe table, not 4 …',
      found - baseline;
  END IF;
  … drop the probe …
  SELECT count(*) INTO after FROM tenant_table_drift();
  IF after <> baseline THEN
    RAISE EXCEPTION '0140: the detector still reports the dropped probe …';
  END IF;
END $$;
```

The property 0140 exists to prove — *"it returned zero rows is not evidence"* —
is fully preserved: the detector is still made to find something and then made
to stop.

---

## G. 🔴 `lib/import/contract/opening-policies.ts` — `opening-stock` declares an impossible undo
**Owner: track M1 / no phase. This is the headline finding.**

`stock_movements` carries `trg_stock_ledger_append_only`, BEFORE DELETE OR
UPDATE, whose first statement is

```
IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'Stock movements cannot be deleted. … To correct it, post a
  REVERSAL for the opposite quantity with reverses_movement_id = %'
```

for every role, owner or not. `opening-stock` declares `kind: "delete"`. The
declared undo is refused, every time, and always has been. CI gate 29 passes
and always will: `checkImportContract()` is pure and cannot ask `pg_trigger`
anything.

```
$ psql "$TEST_DATABASE_URL" -c "SELECT * FROM import_destination_reversibility('stock_movements')"
   target_table    |        delete_blocked_by         |        update_blocked_by         | unknown_guards
-------------------+----------------------------------+----------------------------------+----------------
 stock_movements   | ordence_stock_ledger_append_only  | ordence_stock_ledger_append_only | {}
```

A second, independent reason: `trg_refresh_stock_balance` is **AFTER INSERT
only**, so even with the guard removed, deleting a movement would leave
`stock_balances` holding the opening quantity for ever — a balance no movement
explains, which is what `stock_movements` exists to make impossible.

**The change** (`lib/import/contract/opening-policies.ts`, `openingStock`):

```ts
  reversal: {
    kind: "reverse-entry",
    escapes:
      "The reversing movement stays in the stock ledger permanently. Undoing " +
      "opening stock leaves two movements visible — the opening and its " +
      "reversal — not none, because a stock history that can be rewritten is a " +
      "stock history that proves nothing.",
    because:
      "`stock_movements` is append-only and the database enforces it: " +
      "`trg_stock_ledger_append_only` refuses every DELETE and every UPDATE, " +
      "for every role, and its own message names the remedy — post a reversal " +
      "with `reverses_movement_id`. `delete` was declared here until Phase 2 " +
      "asked the database; it was refused on the first row of every undo.",
  },
```

`server/import/reversal.ts` already implements it:
`postReversingStockMovement()` writes the negated movement with
`reverses_movement_id` set, negating the `numeric(18,3)` quantity **in SQL**
rather than through a JS number — the same discipline
`thousandthsToDecimal()` applies on the way in.

⚠️ **The word is one word and the sentence around it is not.** `escapes` has to
change too: the current one describes the consequences of a deletion that
cannot occur.

---

## H. 🔴 `lib/dpdp/detector.ts` — a verbatim copy of a customer record it cannot see
**Owner: no phase. A gap the next phase will hit too.**

`check:data-classification` flagged `import_reversals` and
`import_reversal_failures`. It did **not** flag `import_row_prior_values` —
which is by a wide margin the most personal-data-carrying table in this batch.
`prior_values` holds a **verbatim copy** of a destination row before the
migration overwrote it, and for both contracted `restore-prior` entities
`capturePriorFields` is `["*"]`: a whole `companies` record, address and all,
or a whole `gst_parties` record including its GSTIN and PAN.

The 41 rules match on **column names**. `freeform-jsonb` looks for `detail`,
`details`, `payload`, `metadata`, `raw`, `lines`. Nothing matches
`prior_values`. A column holding an entire copy of another table under an
unfamiliar name is invisible.

It has been classified anyway (**B**), because the table needs it — an erasure
that removed a person from `contacts` while a pre-migration copy of their
record sat here would have removed the visible copy and kept the hidden one.
But the gap should not be left to be rediscovered.

Two possible remedies, and the second is better:

1. Add `prior|previous|snapshot|before|copy` to the `freeform-jsonb` rule.
   Cheap, and it only moves the boundary.
2. 🔴 **Treat an unclassified `jsonb` column on a tenant table as suspect by
   default.** The current rule is an allowlist of names somebody thought of;
   the failure mode is silence. `import_destination_reversibility()` in SQL
   0209 takes the inverse approach for the same class of problem — it returns
   trigger functions nobody has classified rather than assuming them harmless
   — and it is the right shape here too.

---

## I. `lib/import/entities.ts` — `escapes: null` is false on two entities
**Owner: track M1 / no phase.**

`companies` and `gst-parties` both declare `restore-prior`, and `companies`
declares `escapes: null` — a claim that nothing survives an undo. Both tables
carry a `*_set_updated_at` BEFORE UPDATE trigger whose entire body is
`NEW.updated_at = now()`. Measured, by the restore, on its own work:

```
$ psql "$TEST_DATABASE_URL" -f SQL-FILES/DRILL-…-0210a-restore-measures-escapes.sql
 rows_affected |  unrestored
---------------+--------------
             1 | {updated_at}
```

`escapes: null` is not a default — `lib/import/types.ts` says so: *"`null` IS A
CLAIM, NOT A DEFAULT. It says the author looked."* Suggested:

```ts
    escapes:
      "The record's `last updated` timestamp will read the moment of the undo " +
      "rather than the moment before the import. Every other field comes back " +
      "exactly as it was; a database trigger rewrites that one on any change.",
```

⚠️ Phase 2 does not depend on this. `server/import/reversal.ts` reports the
**measured** list and not the declared one, precisely because a declaration
nothing checks is a declaration that drifts. The patch is so the two agree.

---

## J. `server/accounting/post-sales.ts` — lift `postReversingEntry(tx, …)`
**Owner: track N.**

The reversing-journal-entry shape now exists in three places: `reverseTransaction`
in `server/actions/accounting.ts`, a person doing it by hand, and
`postReversingJournalEntry` in `server/import/reversal.ts`. Three is one too
many, and the third one is Phase 2's.

It is not imported from `server/actions/accounting.ts` because that module is
`"use server"`: calling it would run `requireRole` against a cookie jar and
`revalidatePath` against a request that does not exist — the difference between
a module that can be proven against a real database and one that cannot.

`server/accounting/post-sales.ts` is where the other twenty `post*(tx, args)`
primitives live and is the right home:

```ts
export async function postReversingEntry(
  tx: Tx,
  args: { tenantId: string; userId: string; transactionId: string;
          reason: string; reversalDate?: string },
): Promise<PostOutcome>
```

⚠️ **Keep the Batch 0108 refusal verbatim.** A leg with `amount_minor IS NULL`
has no integer to negate, and reversing it from the two-decimal `amount` mirror
leaves up to 9 fils per leg in a real account. Both existing copies refuse by
name; a merged one must too.

---

## K. `server/actions/import.ts` — the undo action
**Owner: PHASE-1 (registry) / PHASE-10 (wizard). Not supplied — it is a screen decision.**

`server/import/reversal.ts` does no permission checking, deliberately, in this
repository's own pattern: `server/accounting/post-sales.ts` posts and
`server/actions/*` guards. The wrapper:

```ts
export async function undoImportRun(input: unknown): Promise<ActionResult<ReversalResult>> {
  const params = z.object({ runId: uuidSchema }).parse(input);
  const ctx = await requireTenantContext();
  await requireAccess("crm:bulkImport", ctx);          // ⚠️ see the note below
  await requireFeature("crm.bulk_import", ctx);
  const result = await reverseImportRun({
    tenantId: ctx.tenant.id, runId: params.runId, requestedBy: ctx.user.id,
  });
  await writeAudit(ctx, { action: "delete", resourceType: "import_run",
                          resourceId: params.runId, reason: result.message });
  return { ok: true, data: result };
}
```

🔴 **Two things for whoever writes it.**

1. **The permission is not obviously the import permission.** Undoing a run in
   `update` mode writes to every record the run overwrote. Somebody who may
   import may not automatically be somebody who may mass-restore. That is a
   product decision and it belongs to whoever owns the permission catalogue,
   not to Phase 2.
2. **`reverseImportRun` can post to the ledger.** For a `reverse-entry` run it
   creates a `transactions` row and journal legs. Whatever guard the accounting
   side puts on posting should be reachable from here, or the undo button is a
   way to post without `accounting:reverseTransaction`.

---

## L. `scripts/track-ownership.json` — merge the phases map
**Owner: track H.**

`track-ownership-phases.json` shipped with the brief and says *"Merge these
into `scripts/track-ownership.json`."* It has not been merged. The tree's map
still carries the older scheme:

```json
"M1": { "sql": [196,199], "paths": ["lib/import/entities.ts", …] },
"M2": { "name": "Import ledger", "sql": [200,206],
        "paths": ["server/import/**", "db/schema/import-runs.ts"] },
"M3": { "sql": [207,210], "paths": ["lib/import/entities/sales/**"] },
"M4": { "sql": [211,214], "paths": ["lib/import/entities/supply/**"] }
```

Under the phases map, PHASE-1 holds 0200–0204 and PHASE-2 holds 0205–0214.
Under the tree's map, 0207–0210 belong to M3 and M4. **Both maps pass
`npm run check:track-ownership` on this delivery** — `--tree` only asks whether
*some* track owns each number, and one does under either — but they disagree
about who, and a map that disagrees with the briefs is a map nobody can use to
resolve a collision.

⚠️ Note also that M1's block `[196,199]` is now known to be **entirely
unwritten** (`TRACK-REPORT.md` §0.1). Whether those four numbers are reserved
or retired is a decision for integration; they are not Phase 2's to take, and
0205 explains at length why it did not simply take 0196.
