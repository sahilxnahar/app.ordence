# Deploy v1.95.0-alpha , one file, no terminal

**Repo: `app.ordence`**
**Contains: Wave 3B (custom domains, v1.94.0) AND Wave 4 (the SQL pack, v1.95.0).**
Both are in this one zip. There is nothing outstanding from v1.94.0.

---

## 1. The environment variable , ALREADY DONE

`CUSTOM_DOMAIN_VERIFICATION_SECRET` is already set in Railway. I checked the
service config and the name is there. Nothing to do.

⚠️ Two things only you can confirm, because I can read variable NAMES and never
values: that it is **at least 16 characters** (shorter, and domain verification
refuses), and that it is a fresh random value rather than something reused.
If you are unsure, replace it with a new `openssl rand -hex 32` , no already
verified domain breaks, because the timestamp is the stored fact.

**No other new variables.**

---

## 2. The code , without touching a terminal

Unzip this file. It is the complete, tested tree.

**Either** (GitHub Desktop, the easier one)

1. Open GitHub Desktop on `app.ordence`.
2. In Finder, copy the unzipped contents over your local repo folder, replacing
   files when asked.
3. GitHub Desktop shows the changed files. Write a summary, Commit to `main`,
   then Push origin.

**Or** (github.com, no app at all)

1. Go to `github.com/sahilxnahar/app.ordence`.
2. Add file, Upload files, and drag the unzipped folders in.
3. Commit directly to `main`.

Railway deploys from `main` automatically. The push IS the deploy.

⚠️ **The zip has no `node_modules` and no `.next`.** That is correct , Railway
installs and builds from `package.json`. Do not copy those from anywhere.

---

## 3. The SQL , AFTER the deploy is live and green

Fourteen files, in this order, in the Neon SQL editor:

```
0205  0206  0207  0208  0209  0210  0215  0216
0227  0228  0230  0240  0250  0275
```

🔴 **Run 0227, 0228 and 0230 ONE FILE AT A TIME, ALONE.** They use
`CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block. The
others can be pasted one after another, but one at a time is safer and costs
you a minute.

🔴 **Order is not a suggestion for 0205 and 0215.** 0215 refuses outright if
0205 has not run, and says so in a sentence rather than half-applying.

**Before and after, run `SQL-FILES/WHATS-PENDING-neon-safe.sql`.** Before it
should list these fourteen. After it should list none.

Each file verifies itself and raises with a readable sentence if anything is
not as it expects. If one stops, stop , do not run the next , and send me the
message it printed.

---

## 4. What was actually in this wave

The pack was **not** ready to run, and finding that out is what Wave 4 turned
out to be.

- **Phase 2 and Phase 3 each built `import_row_provenance`**, neither able to
  see the other. Their shapes disagree. Both are `CREATE TABLE IF NOT EXISTS`,
  so the second to run was a silent no-op and then refused on its own shape
  assertion. **The pack would have aborted on the seventh file, in production.**
- **Phase 3's version would have broken every undo.** Its append-only trigger
  refused every UPDATE, and a reversal is recorded by updating that very row.
  Proved on a real database: 0 of 3 rows undone with it, 3 of 3 without.
- **The two files disagreed about the change log**, and 0205 then refused its
  own re-run because of it.
- **A soft-deleted stock item still matched an import lookup** , a preview
  reported `create: 1` with no error against an item nobody can see. Three
  lookups had it, not the one the patch request named.
- **Most of the thirty CI gates had never run in CI.** The workflow ran four
  hand-picked ones. It now runs the manifest.
- **A Wave 1 regression of mine**, caught the moment the test suite finally had
  a database to run against.

Full detail is in `CHANGELOG.md` at the top.

---

## 5. What this was verified against

- `tsc --noEmit` clean.
- **31 of 31 gates pass**, including the two that need a live database and had
  been skipping.
- **1,656 tests across 71 files, all passing.** This suite had never been run in
  the integration chat before, because it needs PostgreSQL.
- **The pack applied end to end against a real PostgreSQL 16**, from an empty
  database, then re-applied twice more to prove it is idempotent.

⚠️ **One thing I could not verify: the production build.** `next build` was
OOM-killed in my sandbox at both a 6 GB and a 3.5 GB heap , the same signature
as the v1.88.0 failure. My sandbox is smaller than Railway's builder and
v1.88.0 died on the default heap, so this may well pass. If it does not, the
cause is unchanged and known: 108 modules import the whole `@/db/schema`
barrel, so each drags in all 70 schema files. That is a wave of its own and I
will scope it the moment you say so.

---

## 6. Still open, and still yours

- **`leads:assign`** , Track D recommends option A now, option C later.
- **Ordence's own invoicing is unconfigured on production.** No GSTIN, legal
  name, address or invoice prefix. **You cannot bill a customer until it is** ,
  an invoice without them is not a valid Indian tax invoice.
- **Whether a workspace can ever be hard-deleted.** Two independent mechanisms
  now block it, both correct on their own. Track D's decision.
- **Wave 5** , the deferred list: the test suite's own typecheck (`tsconfig`
  excludes `tests`, 192 errors), `change_log` has no delete trigger,
  `resolveLookups` is still an unguarded `if` chain, `fail-open-registry.json`
  keys on line numbers.
