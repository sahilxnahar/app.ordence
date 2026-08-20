# PATCH-REQUEST-C — changes Track C needs outside its ownership

**Revised wave 17.** Track C owns `SQL-FILES/**`,
`scripts/check-rls-coverage.mjs`, `scripts/check-sealed-grants.mjs` and
`docs/DATA-MODEL.md`. Everything below is outside that list.

Items 1 and 2 are the ones that matter. Item 1 is the **assertion
specification** wave 17 asked for: integration wires the workflow, this says
exactly what it must assert and what each assertion catches.

---

## 1. 🔴 CI must build a database from the numbered migrations ALONE

**File:** `.github/workflows/security-ci.yml` — a second job.
**Why:** this is the job that would have caught `0087` and `0136` on the day
they were written, and it is the one that stops the shape recurring.

Every database anybody has ever looked at is built
`drizzle-kit push → ALL-IN-ONE-SETUP.sql → numbered files`. A defect living in
the difference between that and a numbered-files-only build is invisible to
every control in the repository. There were two, and one of them was the
customer's general ledger with no row-level security at all.

### 1.1 The eight assertions, in order

Each is stated as: **what it asserts · the command · the exact expected output
· what it catches · how to prove it can fail.** An assertion nobody has seen
fail is an assertion nobody should trust, so the last column is not optional.

---

**A1 — the numbered sequence applies from nothing, with no ALL-IN-ONE.**

```bash
for f in $(find SQL-FILES -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' | sort); do
  psql -h localhost -U postgres -d migonly -v ON_ERROR_STOP=1 -f "$f" || exit 1
done
```

Expected: **every file exits 0.** Measured on the wave-17 partial assembly
(146 numbered files): `0 failed`.

Catches: a migration that depends on an object only `ALL-IN-ONE-SETUP.sql`
creates. `0087` was exactly this — `GRANT EXECUTE ON FUNCTION
app_is_platform_scope()` where the function is defined nowhere in the numbered
sequence — and it stopped the build at **file 87 of 129**, which is the
mechanism behind the 111 refusals integration measured.

Proof it can fail: revert the guard added to `0087` in wave 15 and this step
stops with `ERROR: function app_is_platform_scope() does not exist`.

⚠️ **`ON_ERROR_STOP=1` and one file per `psql` invocation.** Applying the whole
directory in one connection hides which file failed, and applying without
`ON_ERROR_STOP` hides that anything failed at all — that is how `0126` was
green in CI for two waves.

---

**A2 — `ANALYZE`, before any gate reads the database.**

```bash
psql -h localhost -U postgres -d migonly -c 'ANALYZE'
```

🔴 **This single line is not housekeeping, and it belongs in the EXISTING job
as well.** `0126_updated_at_coverage.sql` raised `relation "collations" does
not exist` on every database that had statistics and **succeeded on one that
did not**, because the planner only pushes the offending filter down when it
has row counts to plan with. A fresh CI service container is always in the
second state. Production, with autovacuum, is always in the first.

Measured, same file, same database, twice:

```
before ANALYZE : psql exit 0
psql -c 'ANALYZE'
after  ANALYZE : psql exit 3   ERROR: relation "collations" does not exist
```

Catches: the whole class of migration bug that only appears once a table has
statistics. CI cannot see any of them today.

---

**A3 — the schema is real and the count is a floor nobody can drift under.**

```bash
psql -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'"
```

Expected: **326** on the wave-17 partial assembly; integration's full assembly
will be higher. Assert `>= 300` here and only here — it is a smoke test that
the push happened, not a coverage claim, and the coverage claims below are all
exact.

---

**A4 — enabled and forced are the SAME number, and neither is a floor.**

```bash
psql -tAc "
  SELECT count(*) FILTER (WHERE relrowsecurity)                       AS enabled,
         count(*) FILTER (WHERE relforcerowsecurity)                  AS forced,
         count(*) FILTER (WHERE relrowsecurity AND NOT relforcerowsecurity) AS enabled_not_forced,
         count(*) FILTER (WHERE relforcerowsecurity AND NOT relrowsecurity) AS forced_not_enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'"
```

Expected on the wave-17 partial assembly:

```
enabled = 313 · forced = 313 · enabled_not_forced = 0 · forced_not_enabled = 0
```

Integration's full assembly reports **319** for both. The assertion is
`enabled = forced` and `enabled_not_forced = 0`, **not** a threshold: the two
must agree, whatever the number is.

🔴 **`forced_not_enabled` is the one nobody thinks to check.** `ALTER TABLE …
FORCE ROW LEVEL SECURITY` on a table whose row security is *disabled* is
accepted by PostgreSQL and does nothing at all. The catalog then says `force =
true` and the engine applies no policy. It is the quietest possible way to
write a migration that reports success and changes no behaviour.

---

**A5 — every tenant-scoped table, exactly.**

```bash
psql -tAc "
  WITH t AS (
    SELECT c.relrowsecurity AS en, c.relforcerowsecurity AS fo
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid=c.oid AND a.attname='tenant_id'
                      AND a.attnum>0 AND NOT a.attisdropped))
  SELECT count(*), count(*) FILTER (WHERE en), count(*) FILTER (WHERE fo) FROM t"
```

Expected on the partial assembly: **306 · 306 · 306**. All three equal.

Catches a tenant table that arrived with no row security. `deployment_releases`,
`deployment_backups`, `security_batches` and `flow_submissions` shipped exactly
that way, and the CI step of the day asserted `count >= 100` and passed.

---

**A6 — the exhaustive gate, on this database.**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/migonly \
DATABASE_URL_UNPOOLED=postgresql://postgres:postgres@localhost:5432/migonly \
  node scripts/check-rls-coverage.mjs
```

Expected: **exit 0**, and the summary line reports four things —

```
drift: 0 findings across 306 tenant tables
schema contract: 0 removed/changed · N added
probed 262/306 tenant tables · 0 cross-tenant read(s) · 44 NOT PROVEN, could not seed
rollback verified — no probe rows remain
```

⚠️ **`N added` is expected to be non-zero and is not a failure.** See item 2.

⚠️ **The `NOT PROVEN` number is the one to watch across waves.** It is the
count of tenant tables the cross-tenant probe could not seed because of a
`CHECK` constraint it cannot satisfy; they are printed by name on every run and
are never counted as passing. It went 41 → 44 when three tracks added tables.
A rise means coverage fell.

Proof it can fail — run this once, by hand, before trusting the job:

```sql
CREATE TABLE public.zz_probe (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                              tenant_id uuid NOT NULL, note text);
```

The gate must then exit 1 with **seven** findings from four independent
mechanisms, including a real observed cross-tenant read:

```
::error::zz_probe has a tenant_id column but ROW LEVEL SECURITY IS NOT ENABLED
::error::zz_probe is missing rls-enabled / tenant-policy / change-log-trigger / impersonation-guard
::error::schema contract ADDED: table zz_probe
::error::🔴 CROSS-TENANT READ on zz_probe: a row belonging to tenant A was visible
         to tenant B (1 row(s)) on a connection as ordence_app, which has NOBYPASSRLS
```

`DROP TABLE public.zz_probe;` and it must exit 0 again.

---

**A7 — the two builds are the same database.**

```bash
psql -d ameya_test -tAc 'SELECT schema_contract_fingerprint()'
psql -d migonly    -tAc 'SELECT schema_contract_fingerprint()'
```

Expected: **byte-identical**. Measured on the wave-17 partial assembly:
`55df4fd596df02940e8c379a74b51c4af518e32878afa64cede7ac925d6a583e`, 1,884
objects, from both legs — and the table ACLs (326 rows) and function ACLs (506
rows) diff clean as well.

This is the assertion that makes the whole job worth running: it says a
disaster-recovery rebuild produces the product, not a shape that resembles it.

⚠️ **`drizzle-kit push` must be in BOTH legs.** It is banned in production and
it is the only thing that creates most of the tables; the numbered files ALTER
tables into safety, they do not create them. A leg without it compares
production against an empty schema and reports a difference of 300 tables,
which tells you nothing.

---

**A8 — the security suite, against the migrations-only database.**

Point `TEST_DATABASE_URL` at `migonly` as `ordence_app` and run
`npx vitest run --project=security`. Expected on the partial assembly:
**58 files, 1442 tests, all passing.**

⚠️ The role must be `ordence_app` — `NOSUPERUSER NOBYPASSRLS`. A suite run as
`postgres` passes every isolation test on a database with no policies at all.

### 1.2 What the job must NOT do

- **Do not** apply `ALL-IN-ONE-SETUP.sql`. That is the entire point.
- **Do not** create the application role after the SQL. Every numbered file
  narrows its grants, and a blanket `GRANT … ON ALL TABLES` landing last
  silently undoes all of them. Measured: `npm run db:verify` then reports the
  app role can reprice itself and delete payment evidence.
- **Do not** let this job be `continue-on-error`. A job that cannot go red is
  the `exit 0` skip path with a nicer name.

---

## 2. `check:migrations` is red on the assembled tree until 0143–0145 are in `KNOWN_GAPS`

**File:** `scripts/check-migrations.mjs`.
**This blocks assembly and it is one edit.**

`check:migrations` fails on a **gap**, not only on a duplicate. Track C's block
was 0136–0145 and it used 0136–0142. **Nobody holds 0143, 0144 or 0145** — they
are permanent gaps, not gaps waiting to be filled, so they will never
self-resolve.

Measured on the partial assembly with Track A's four files stubbed in:

```
❌ Migration numbering FAILED — 3 problem(s).
::error::Missing migration 0143 … 0144 … 0145
```

With three entries added to `KNOWN_GAPS`:

```
✅ Migrations contiguous — 150 files, 0001…0159 (9 documented historical gaps). Next number: 0160.
```

The entries, in the style of the five already there:

```js
  /**
   * ⭐ 0143–0145 WERE ALLOCATED AND NEVER WRITTEN, WHICH IS A THIRD SHAPE.
   * Not retired like 0062/0072/0076 — no script ever held them. Not
   * reserved-and-superseded like 0107. Track C's wave-15 block was
   * 0136–0145 and the work took seven files; the remaining three numbers
   * were never claimed by anybody and never will be, because every
   * delivered report and every comment in this wave describes a sequence
   * in which 0142 is followed by 0146.
   */
  [143, "allocated to Track C's wave-15 block (0136-0145), never written — the work took 0136-0142"],
  [144, "allocated to Track C's wave-15 block (0136-0145), never written — the work took 0136-0142"],
  [145, "allocated to Track C's wave-15 block (0136-0145), never written — the work took 0136-0142"],
```

⚠️ **Do not close them by renumbering 0146–0159 downward.** Four delivered
batches and five reports already name those numbers.

---

## 3. Two settings read by code and absent from the catalogue

**File:** `lib/platform/env-catalog.ts` (not Track C's, and not the reporting
tracks' either).

`check:env-catalogue` is **red on the assembled tree** — found while verifying,
not looked for:

```
• DISCORD_ALERT_WEBHOOK_URL is read by server/observability/alerts.ts and is
  NOT in lib/platform/env-catalog.ts
• ORDENCE_EINVOICE_IRP_ENABLED is read by server/tax/einvoice.ts and is
  NOT in lib/platform/env-catalog.ts
```

Track B and Track E respectively. `/api/diag` reports only catalogued names, so
a deploy missing either setting gets no explanation from the one endpoint built
to give one.

---

## 4. Optional — split the migration linter into its own gate

Unchanged from wave 15, and now a little more worth doing: the linter has grown
a fourth rule and a self-test.

`scripts/check-sealed-grants.mjs` carries the migration lint because a new
`check:*` script needs entries in `package.json` and `scripts/gates.mjs`, and
`check:gate-coverage` fails the build on a `check:*` script missing from the
manifest — all shared files. If the split is wanted, move section 5
(`lintMigration`, the three strippers, the four grandfather lists and
`SELF_TEST_CASES`) out verbatim and add:

```jsonc
"check:migration-lint": "node scripts/check-migration-lint.mjs"
```

```js
{ id: "migration-lint", script: "scripts/check-migration-lint.mjs",
  tier: "static", wave: 15,
  why: "a migration that cannot fail, writes without a WHERE, or asserts coverage on a floor" },
```

⚠️ Carry `--self-test` across with it. It is 25 cases and it is the thing that
stops the next one-character regex bug blocking every track.

---

## 5. Optional — `bootstrap-test-db.mjs` should name what it refused

Unchanged from wave 15. It prints `122 files, 1 statement(s) refused` and hides
the name behind `VERBOSE=1`. That one refused statement was `0126`'s Section 1,
failing on every bootstrap for two waves. Three lines:

```js
if (failed > 0) console.log(`\n     refused in: ${[...new Set(refusedFiles)].slice(0, 5).join(", ")}`);
```

---

## 6. Optional — print `isolation_posture()` from `verify-security.ts`

Unchanged from wave 15, and still the only place the question can be answered.
`scripts/verify-security.ts` is what an operator runs by hand against a Neon
branch. The role posture — does row security apply to the role in
`DATABASE_URL` at all — cannot be answered from CI, and it is the question
everything else in Track C depends on.

```sql
SELECT * FROM isolation_posture();
```
