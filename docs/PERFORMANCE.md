# Ordence — Performance, scale and cost

**Version:** 1.81.0-alpha · Track F · Wave 16, re-verified in Wave 17
**Substrate for every number below:** PostgreSQL 16.13, the full Ordence
schema (319 tables, 309 under `FORCE ROW LEVEL SECURITY`, 1,499 indexes
before this track and 1,396 after, 979 non-internal triggers), loaded by `scripts/perf/seed-load.mjs` with
1.06 M rows across 12 tenants, connected as `ordence_app`
(`NOSUPERUSER NOBYPASSRLS`) with the tenant pinned exactly as
`withTenant()` pins it.

**Reproduce all of it:**

```bash
npm run test:bootstrap                     # schema + 130 numbered files + RLS
node scripts/perf/seed-load.mjs --truncate # the load profile
node scripts/perf/measure.mjs --tag=baseline
node scripts/perf/prove-indexes.mjs
node scripts/perf/measure-writes.mjs
node scripts/perf/pool-arithmetic.mjs
node scripts/perf/round-trips.mjs
node scripts/perf/cost-model.mjs
```

---

## 1. What was true before this document

Nothing had been measured. Not badly — not at all.

Searched across the repository at 1.81.0-alpha:

| Thing looked for | Occurrences |
|---|---|
| `performance.now()` | 0 |
| `console.time` | 0 |
| `EXPLAIN` in any executable path | 0 |
| A query-duration column anywhere in `db/schema/**` | 1 (`mcp_call_log.duration_ms`, MCP tool calls only) |
| A route or server-action timing | 0 |
| A declared query budget | 0 |
| A written pool size | 0 |

There was therefore no way to tell a regression from a Tuesday.

---

## 2. The load profile, and why it is skewed

`scripts/perf/seed-load.mjs` writes 12 tenants on a deliberate power law:
eight at one "scale point", three at four, one at forty.

| Tenant | Invoices | Journal legs | Change-log rows |
|---|---:|---:|---:|
| `enterprise-01` | 48,000 | 240,000 | 320,000 |
| `growth-01..03` | 4,800 each | 24,000 each | 32,000 each |
| `starter-01..08` | 1,200 each | 6,000 each | 8,000 each |

Two reasons for the skew rather than an even load:

1. **Real ERP tenancy is a power law.** The tenant who breaks Ordence
   already exists as a prospect, and an evenly-loaded benchmark never
   meets them.
2. **Under RLS every query filters `tenant_id`, and the planner's
   estimate for that predicate comes from `n_distinct` and the MCV
   list.** On a skewed column those estimates are wrong in a specific
   direction, and that is exactly where plans flip. `enterprise-01` is
   two thirds of `journal_entries`; `tenant_id = <enterprise>` is a
   *terrible* selectivity and the planner knows it, which changes what
   it chooses.

A plan measured on 40 rows is not a weaker measurement. It is a
different one, and it is usually the opposite one — a sequential scan is
genuinely optimal at 40 rows and catastrophic at 400,000.

---

## 3. 🔴 The finding: `enum_eq` is not leakproof, and it costs plans

This is the most important thing in this document and it is not about
any one table.

Every tenant policy in this schema has the shape

```sql
USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
```

Under row-level security PostgreSQL splits the WHERE clause into
**security quals** (from the policy) and **user quals** (from the query),
and a user qual may be evaluated *before* a security qual **only if it is
leakproof** — otherwise an error message from the operator could reveal
the existence of a row the policy was hiding.

```
SELECT proname, proleakproof FROM pg_proc WHERE proname IN ('enum_eq','date_lt');
 enum_eq | f      ← NOT leakproof
 date_lt | t      ← leakproof
```

**`status` is an enum. `status = ANY(...)` therefore cannot become an
index condition under RLS.** It is demoted to a heap filter that runs
after the policy check.

Measured on the overdue-receivables query, `enterprise-01`:

| | Plan | Rows removed by filter | Buffers | Median |
|---|---|---:|---:|---:|
| **With RLS** (as the app runs) | Bitmap Heap Scan using `sales_invoices_order_idx` — *the wrong index*, chosen only because it starts with `tenant_id` | 31,708 | 4,660 | **27.8 ms** |
| **RLS bypassed**, same indexes | Bitmap Index Scan using `sales_invoices_status_idx`, `status` and `due_date` both in the Index Cond | 0 | 985 | **9.3 ms** |
| **With RLS + `(tenant_id, due_date)`** (0151) | Index Scan, `due_date` in the Index Cond | 415 | 1,236 | **1.6 ms** |

The middle row is the finding: **the plan the planner would pick if RLS
were off is not available to the application**, and nothing in this
repository said so.

### What this generalises to

Every composite index in this schema of the shape
`(tenant_id, <enum column>, <something else>)` is, under RLS, an index on
`(tenant_id)` with two decorative columns. The third column can never be
reached, because the second one can never be an index condition.

The schema is full of them: `sales_invoices_status_idx`,
`transactions_status_idx`, `sales_invoices_company_idx (tenant_id,
company_id, status)`, and the same pattern across
`stock_movement_reason`, `entry_type`, `transaction_status`.

**Three ways out, in order of preference:**

1. **Put a leakproof column second.** `(tenant_id, due_date)` beats
   `(tenant_id, status, due_date)` under RLS even though it is strictly
   less informative. This is what 0151 does.
2. **Use a partial index.** A partial predicate is proven by *predicate
   implication at plan time* — a proof, never an execution — so
   leakproofness does not apply to it at all. `WHERE status IN
   ('issued','part_paid')` in the index definition works where the same
   text in the query does not. 0154 uses this shape.
3. **Mark the operator leakproof.** `ALTER FUNCTION enum_eq LEAKPROOF`
   requires superuser and is a *security* decision, not a performance
   one: it tells Postgres that this operator can never leak information
   through an error or a timing difference. **Do not do this.** It is
   listed only so that nobody rediscovers it as a clever shortcut.

---

## 4. The ten queries, measured

All figures: `enterprise-01`, `ordence_app`, RLS in force, median of 11
runs after a discarded warm-up. Full JSON with plans in
`scripts/perf/results/measure-baseline.json` (before) and
`scripts/perf/results/measure-after.json` (after).

| Query | Source | Before | After 0151–0157 | Plan after |
|---|---|---:|---:|---|
| `invoices.list` | `sales-invoices.ts:1666` | 1.5 ms | 1.9 ms | Index Scan `sales_invoices_tenant_idx` |
| `invoices.overdue` | derived from `:1666` + `documents.ts:185` | **27.8 ms** | **1.24 ms** | Index Scan `sales_invoices_tenant_due_idx` |
| `contacts.page` | `contacts.ts:153` | 0.9 ms | 0.8 ms | Index Scan `contacts_tenant_name_idx` |
| `contacts.count` | `contacts.ts:164` | 1.6 ms | **0.73 ms** (678→48 buffers) | Index Only Scan `contacts_tenant_live_idx` |
| `audit.page` | `audit-trail.ts:325` | 0.8 ms | **0.47 ms** (452→162 buffers) | Index Scan `audit_logs_tenant_keyset_idx` |
| `audit.byResource` | `audit.ts:780` | 0.9 ms | 1.2 ms | Index Scan `audit_logs_tenant_created_idx` |
| `journal.trialBalance` | period close | 49.2 ms | 44.5 ms | **Seq Scan** — see §7 |
| `journal.byLedger` | `accounting.ts:1416` | 1.0 ms | 1.4 ms | Index Scan `journal_entries_ledger_idx` |
| `journal.byTransaction` | transaction detail | 0.2 ms | 0.4 ms | Index Scan `journal_entries_transaction_idx` |
| `stock.balance` | derived, `inventory.ts:502` | 24.0 ms | 24.5 ms | Seq Scan — see §7 |
| `invoice.detail` | `sales-invoices.ts:1762` | 0.2 ms | 0.2 ms | Index Scan `sales_invoice_lines_invoice_idx` |
| `changeLog.retentionSweep` | `SQL-FILES/0128:156` | **83.4 ms**, 39,654 buffers | **13.2 ms**, 696 buffers | Index Only Scan `change_log_tenant_changed_at_idx` |
| `export.contacts` | `export/datasets.ts:208` | 12.5 ms, **8,000 rows** | unchanged | 🔴 unbounded — §8 |
| `campaign.recipientBoard` | `campaigns.ts:266` | 25.4 ms | unchanged | 🔴 no tenant-leading index — §8 |
| `audit.deepOffset` | pattern from `records.ts:255` | 65.9 ms | 35.6 ms | 🔴 `OFFSET 100000` — §8 |

Sub-millisecond differences in either direction are run-to-run noise on
this container; only the bolded rows are signal.

---

## 5. Indexes: four added, 107 removed, three rejected

`scripts/perf/prove-indexes.mjs` creates each candidate, re-measures,
**checks the index name appears in the resulting plan**, and drops it
again. A candidate that makes a query faster without the planner
touching it is not evidence. Verdicts in
`scripts/perf/results/index-verdicts.json`.

### Accepted

| Index | Migration | Claim | Measured |
|---|---|---|---|
| `sales_invoices (tenant_id, due_date)` | 0151 | `enum_eq` is not leakproof, `date_lt` is | 27.8 → 1.6 ms · 4,660 → 1,236 buffers |
| `audit_logs (tenant_id, created_at DESC, id DESC)` | 0152 | the keyset cursor's tiebreak is in no index | 0.88 → 0.43 ms · 452 → 162 buffers |
| `change_log (tenant_id, changed_at)` | 0153 | the only non-partial tenant-leading index on the fastest-growing table | 83.4 → 13.0 ms · 39,654 → 696 buffers |
| `contacts (tenant_id, created_at) WHERE deleted_at IS NULL` | 0154 | every customer-visible read filters it; nothing carried it | 1.72 → 0.92 ms · 678 → 48 buffers |

### Rejected — by the harness, not by taste

| Candidate | Verdict |
|---|---|
| `journal_entries (tenant_id, ledger_id, entry_type) INCLUDE (amount_minor)` | **The planner did not choose it.** See §7 — it is the right index and the cost model refuses it. |
| `stock_movements (tenant_id, stock_item_id, warehouse_id) INCLUDE (quantity)` | The planner did not choose it, and did not choose it even with `enable_seqscan = off`. Genuinely not useful. |
| `campaign_recipients (tenant_id, campaign_id)` | Used, but removed 0% of median time and 28% of buffers at 150,000 rows — below the bar. Revisit above ~2 M rows; §8. |

### Removed

107 indexes, by rule rather than by list — `ordence_index_health()`
(0155) defines the rule, 0156 and 0157 apply it,
`scripts/perf/check-index-health.mjs` enforces it from then on.

- **102 bare `(tenant_id)` indexes** on tables that already have a wider
  index beginning with `tenant_id`. By the B-tree prefix rule they serve
  no query the wide one cannot.
- **5 exact duplicates** — the same index under two names, from two
  migrations that each used `IF NOT EXISTS` and each thought it was
  first.

UNIQUE and PARTIAL indexes are excluded even when they look redundant: a
unique index is a *constraint*, and a partial index serves queries a
wider plain one cannot.

**The removals were shown not to cost a read.**
`node scripts/perf/check-query-budgets.mjs` was run immediately before
and after 0156 + 0157, on the same corpus, and every catalogued query
stayed within budget.

---

## 6. 🔴 Writes: 92% of a journal-leg insert is triggers

`scripts/perf/measure-writes.mjs`, 2,000 inserts per scenario, each
scenario inside a transaction that is rolled back:

| | `sales_invoices` | `journal_entries` |
|---|---:|---:|
| A · production shape | 94 µs/row | **321 µs/row** |
| B · change-log trigger off | 30 µs/row | 275 µs/row |
| C · redundant bare index dropped | n/a — no such index on this table | 278 µs/row |
| D · all user triggers off | 29 µs/row | **27 µs/row** |

That table is the run **before** 0157. Re-run **after** 0157 the harness
prints, for `journal_entries`:

```
(no redundant bare (tenant_id) index on this table — scenario C skipped)
A · production shape        349 µs/row     change_log +4000
B · change-log trigger off  281 µs/row     change_log +2000   19.6% cheaper
D · all user triggers off    26 µs/row     change_log +0      92.6% cheaper
```

The disappearance of scenario C is the confirmation that 0157 took
effect: the harness computes the redundant set from the catalogue at run
time and there is no longer one on that table. The ~9% drift between the
two runs (321 vs 349 µs/row) is run-to-run noise on a shared container;
the 92% figure is stable across both. Current JSON:
`scripts/perf/results/write-cost.json`.

`journal_entries` carries **nine** triggers. Two of them do the damage:

**`update_ledger_balance`** — `BEFORE ROW`. For every journal leg it runs
a `SELECT` on `ledgers` and then an `UPDATE` of `ledgers.current_balance`.

> 🔴 This is not primarily a speed problem. It takes an **exclusive row
> lock on one `ledgers` row, held to end of transaction, once per leg**.
> Every posting to the same bank or sales ledger therefore serialises on
> that row. Adding Railway replicas does not help; it makes the queue
> longer. This is a concurrency ceiling that no index and no cache can
> move, and it does not appear in any monthly cost total.

**`record_change`** — `AFTER ROW`, on 289 tables, writing a full
`to_jsonb(OLD)` + `to_jsonb(NEW)` image per row.

Measured amplification: **2,000 `journal_entries` inserts produce 4,000
`change_log` rows.** Two per leg — the leg's own entry, plus the one
generated by `update_ledger_balance`'s write to `ledgers`.

**`enforce_double_entry_balance`** — `AFTER ROW`, re-aggregating every leg
of the transaction for each leg. Measured across transaction sizes:

| Legs | Total | Per leg | change_log rows |
|---:|---:|---:|---:|
| 4 | 8.6 ms | 2.16 ms | 8 |
| 50 | 11.8 ms | 0.237 ms | 100 |
| 200 | 47.5 ms | 0.238 ms | 400 |
| 800 | 221.4 ms | 0.277 ms | 1,600 |

The quadratic term is visible (0.237 → 0.277 ms/leg from 50 to 800 legs)
but small; the dominant cost is the fixed ~0.24 ms/leg from the two
`ledgers` statements and the two change-log rows. A 500-employee payroll
journal is ~1,000 legs and therefore ~275 ms of pure trigger work.

**None of these triggers is Track F's file.** Recommendations are in
`PATCH-REQUEST-F.md`.

---

## 7. `random_page_cost` is probably wrong for Neon

The trial-balance covering index was rejected because the planner would
not choose it. It was then asked what it was refusing:

| `random_page_cost` | Plan | Buffers | Time |
|---:|---|---:|---:|
| 4.0 (default) | Seq Scan | 6,861 | 86 ms |
| 2.0 | Index Only Scan | 1,971 | 66 ms |
| 1.5 | Index Only Scan | 1,971 | 55 ms |
| 1.1 | Index Only Scan | 1,971 | 54 ms |

The flip point is between 4.0 and 2.0.

`random_page_cost = 4` encodes the seek penalty of a spinning disk.
Ordence runs on **Neon, whose storage is network-attached**: a page miss
is a request to a page server, and sequential and random access cost
nearly the same. On that storage the default systematically prefers
sequential scans — which means shipping the whole relation over the
network instead of the 29% of it the index would have touched.

**This is reported, not changed.** `random_page_cost` is a server or
role-level setting, it affects every plan in the product, and changing it
on the basis of one query would be exactly the kind of confident,
unmeasured decision this track exists to avoid. The experiment to run is
in `PATCH-REQUEST-F.md`.

---

## 8. Pagination: the contract exists and has zero callers

`lib/pagination.ts` is 344 lines of correct, well-argued cursor
pagination: `ABSOLUTE_MAX_PAGE_SIZE = 500`, `MAX_PAGE_OFFSET = 50_000`,
`boundPage()`, `paginate()`, a probe row, an honest `clamped` flag.

**Production callers of its functions: zero.** Its only importer is
`app/(crm)/settings/limits/page.tsx`, which renders two of its constants
to the customer as prose — *"N rows on your plan"* — a number no query in
the codebase consults. `maxPageSizeForPlan()` (`lib/edge/budgets.ts:443`)
is dead for the same reason: its only non-test caller is the dead
`lib/pagination.ts`.

Meanwhile `server/actions/audit-trail.ts` independently reimplemented
about 80% of it and wired it to a real screen. That implementation is the
repository's gold standard and 0152 exists to serve it.

### What is unbounded today

| Path | Bound |
|---|---|
| `server/export/datasets.ts:142,208,268,321,373` | **None.** All five export datasets. `MAX_EXPORT_ROWS = 200_000` (`export/render.ts:62`) is checked *after* `buildDataset()` has materialised every row in the heap. |
| `server/dynamic/records.ts:255` | `page` has no `.max()` (`lib/validators/dynamic.ts:309`), reachable from a browser-callable server action. `{page: 1e9}` → `OFFSET 50000000000`. |
| `lib/platform/data-table-params.ts:154` | `page` read from the raw query string, no ceiling. |
| `server/views/query.ts:225` | `page` capped at 10,000 × `pageSize` 200 = offset 1,999,800 — 40× the declared `MAX_PAGE_OFFSET`. |
| 126 tenant-scoped list queries in `server/actions/**` | No `LIMIT`. Worst: `getFxExposure` (all invoice history), `getGstSummary` (no period filter), `getLedgerTrailing30` (no 30-day predicate despite the name), `listLandParcels` (six full tenant scans in one action). |

Measured cost of the deep-offset pattern at 120,000 audit rows:
**65.9 ms for `OFFSET 100000 LIMIT 50`** (35.0 ms after 0152). It scales
linearly with the offset, which is user-supplied and unbounded.

**Five different page-size ceilings coexist** and none of them is
`ABSOLUTE_MAX_PAGE_SIZE`: `lib/views/limits.ts:101` (200),
`lib/dynamic/limits.ts:88` (200), `lib/validators/crm.ts:71` (100),
`lib/validators/sales.ts:413` (100/200), `lib/platform/schemas.ts:65`
(200).

None of these files belongs to Track F. The gate that reports them is
`scripts/perf/check-query-budgets.mjs`, which carries `export.contacts`,
`audit.deepOffset` and `campaign.recipientBoard` as known defects — and
**fails if one of them starts passing**, because a stale exemption hides
the next regression.

---

## 9. Connection pool arithmetic

`db/index.ts:257` constructs the shared pool as
`new Pool({ connectionString: DATABASE_URL })`. Read out of
`@neondatabase/serverless` rather than out of documentation:

```
max                      10          per Node process
idleTimeoutMillis        10000
connectionTimeoutMillis  undefined   ← a full pool queues FOREVER
```

**Neither is a decision. Both are inherited defaults, written down
nowhere.**

```
replicas = floor( (max_connections − superuser_reserved − headroom) / pool_max )
```

`headroom` covers what the application does not account for:
`scripts/migrate.mjs` (one connection per statement), an open Neon
console, a `db:studio` session, the readiness probe — and the one that
actually bites, **the old replica during a rolling deploy, which holds
its pool until it drains.** 15 is the working figure.

Against the local Postgres (`max_connections = 100`) that gives 8
replicas. **That number is not Neon's** — Neon's `max_connections` is a
function of compute size and is typically much lower on small computes.
The formula is the deliverable; fill it in with

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
SELECT count(*) FROM pg_stat_activity;
```

on the production endpoint. `node scripts/perf/pool-arithmetic.mjs` does
the arithmetic once you have them.

### Two findings that matter more than the number

**`connectionTimeoutMillis` is unset.** A request that cannot get a
connection does not fail — it waits indefinitely. The pool filling up
presents as "the site is slow", with no error anywhere, and adding a
replica makes it worse. This is the hardest possible version of this
incident to diagnose. Recommended: `connectionTimeoutMillis: 5000` and a
`max` that is written down. See `PATCH-REQUEST-F.md`.

**Which Neon endpoint `DATABASE_URL` uses is a tenant-isolation
decision, not only a capacity one.** Neon publishes a direct hostname and
a `-pooler` hostname fronting PgBouncer in transaction mode. On the
pooler the arithmetic above stops binding — and transaction-mode pooling
does not carry session state. That is safe here *only* because every
setting Ordence uses is written with `set_config(..., is_local => true)`
inside an explicit transaction (`db/index.ts:311`). A single
session-scoped setting anywhere would become the cross-tenant leak that
comment warns about. **The repository does not record which endpoint is
in use.**

---

## 10. Region and latency — the decision material

**Do not move anything on the basis of this section. Verify the two
facts first.**

`withTenant()` is not one round trip. Measured by counting statements:

```
BEGIN
SELECT set_config('app.current_tenant_id', $1, true)
... the callback's own queries ...
COMMIT
```

**Four round trips for a single-query transaction; three of them fixed
overhead, paid per `withTenant()` call.**

| Placement | Per transaction | 10-line invoice save (20 transactions) |
|---|---:|---:|
| app and database in the same region | ~4 ms | ~0.1 s |
| app `sfo` → database `ap-southeast-1` | ~680 ms | **~13.6 s** |
| app `sfo` → database `ap-south-1` | ~920 ms | ~18.4 s |

| User latency, for contrast | |
|---|---:|
| Indian user → `sfo` | ~250 ms |
| Indian user → `ap-southeast-1` | ~60 ms |
| Indian user → `ap-south-1` (Mumbai) | ~25 ms |

**The round-trip count is measured. The RTT column is published
reference data, not a measurement of this deployment.**

### 🔴 One fact is now confirmed. The other is still the bigger half.

✅ **CONFIRMED** by the wave-17 production environment audit: one Railway
replica, in `sfo`, serving Indian customers. That is roughly **250 ms of
user round trip**, and it is paid **once per page**.

🔴 **STILL UNCONFIRMED:** the Neon region. `DEPLOY.md:17` and `:49`
specify `ap-southeast-1` (Singapore). If the app is in `sfo` and the
database is in Singapore, then **every database round trip crosses the
Pacific**, and that is paid **four times per `withTenant()` call** — of
which a 10-line invoice save makes twenty. At a 170 ms Pacific RTT that
is 13.6 seconds for one invoice.

That is 54× the confirmed 250 ms, and it is per transaction rather than
per page. **The confirmed fact is not the important one.**

It cannot be verified from this container: `.env.example` uses a literal
placeholder `region` in the Neon hostname, and asking for a connection
string is forbidden. **It is visible without any secret** — the Neon
project page shows the region.

`node scripts/perf/round-trips.mjs` now prints the four options and what
each would involve: co-locate the app with the database (low risk, one
deploy), move both to Mumbai (medium risk — it is a Neon project
migration wearing a region change), move the app to Mumbai alone (**do
not** — a net loss on the write path), or fix the N+1s first
(recommended, and free of the region decision entirely).

If they are in different regions, **co-locating the app with the
database is an order of magnitude larger than moving the app closer to
users** — and moving the app to Mumbai *without* moving the database
would make it worse, not better.

### And before any move: the N+1 findings dominate both

`server/gst/engine.ts:96` opens **two `withTenant` transactions per
invoice line**. A 10-line invoice is 20 transactions, 80 round trips,
where 5 would do. `server/actions/import.ts:1176` opens **one
transaction per imported row**. At 4 ms of RTT nobody notices; at 170 ms
these are the whole page. Full list in `TRACK-REPORT.md` §4.

**Fix the N+1s before moving a region.** They are cheaper, they are
reversible, and they multiply whatever the RTT turns out to be.

---

## 11. Cost to serve, per tier

`node scripts/perf/cost-model.mjs`. Measured per-operation cost and
measured bytes-per-row; **assumed** activity model and unit prices, both
isolated in `ACTIVITY` and `RATES` at the top of that file so they can be
argued with.

| Tier | Users | DB seconds/month | Storage | Compute $ | Storage $ | Total $ | $/user |
|---|---:|---:|---:|---:|---:|---:|---:|
| starter | 5 | 29.8 | 7 MB | 0.001 | 0.002 | **0.004** | 0.0007 |
| growth | 20 | 129.1 | 26 MB | 0.006 | 0.009 | **0.015** | 0.0007 |
| enterprise | 200 | 1,290.7 | 265 MB | 0.057 | 0.090 | **0.148** | 0.0007 |

At $0.16/CU-hour and $0.35/GB-month — **placeholder prices; confirm
against the provider's current pricing before quoting any of this.**

**What it says:**

- An enterprise tenant costs **41.2×** a starter tenant on **40×** the
  seats. Cost per seat is flat to within 3% across the whole range.
- **Database cost is not the constraint on pricing.** Fourteen cents a
  month for the largest tenant modelled. Whatever governs Ordence's
  margins, it is Railway compute, Clerk seats, Resend volume or R2 —
  not Postgres.
- **Reads are >99.9% of database time at every tier.** Which is why the
  index budget went to reads and the removals went to write cost.
- **Storage is 60% of the database bill at the enterprise tier**, and
  `change_log` is the largest contributor. `prune_change_log()` (0128)
  is what keeps that from compounding, and 0153 is what makes running it
  affordable.

**Excluded:** Railway compute, Clerk, Resend, R2, Upstash. This is the
database only — the part this track measured.

---

## 12. What now enforces this

Performance work decays the moment it stops being measured. Four gates,
none of which is registered in `scripts/gates.mjs` yet — that file is
shared and Track F does not own it. `PATCH-REQUEST-F.md` asks for the
registration.

| Gate | Tier | What it refuses |
|---|---|---|
| `scripts/perf/check-query-budgets.mjs` | database | any catalogued query over its declared time or row budget; a corpus too small to mean anything; a known-defect exemption that no longer reproduces |
| `scripts/perf/check-index-health.mjs` | database | a bare `(tenant_id)` index beside a wider one; an exact duplicate; an INVALID index left by a failed `CREATE INDEX CONCURRENTLY`; a *new* RLS table with no tenant-leading index |
| `scripts/perf/check-catalogue-drift.mjs` | static | a catalogue entry citing a file that no longer exists or no longer names the table |
| `scripts/perf/check-cache-adoption.mjs` | static | `lib/cache` having zero production callers — **red today, deliberately** |

`check-query-budgets.mjs --self-test` runs the whole gate with every
budget forced to 0.001 ms and asserts it exits non-zero. A gate nobody
has watched fail is a gate nobody knows works.

---

## 13. Caching

`lib/cache/**` is a tenant-safe read-through cache over the Upstash
client that `lib/redis.ts` already builds. Zero new dependencies.

✅ **Upstash Redis is configured on production** (wave-17 environment
audit). The degradation path below is therefore the *development* path,
not the production one — and the cross-tenant risk this module is built
against is live rather than hypothetical.

**RLS does not protect a cache.** Postgres enforces isolation on 309
tables; Redis has never heard of `app.current_tenant_id`. Three
independent defences, because the third one assumes the first two were
edited away:

1. **Compile time** — `TenantCacheKey` is a branded type. A plain string
   will not type-check, so the only way to obtain a key is
   `tenantCacheKey()`, which requires a tenant id.
2. **Key construction** — the tenant id is validated against the same
   UUID regex `withTenant()` uses, so `""`, `"undefined"` and the nil
   UUID all throw rather than producing a key every tenant shares. Key
   parts may not contain `:`, because a part that did could forge
   another tenant's prefix — and `invalidateTenant()` deletes by prefix.
3. **Read time** — every value is stored in an envelope carrying the
   tenant id it was computed for. On read that id is compared to the
   caller's *and* to the id encoded in the key; a mismatch is a MISS, the
   entry is deleted, and `cacheStats().refusedCrossTenant` increments.
   That counter must always be zero; a non-zero value is evidence, not a
   handled condition.

4. **Environment tag** — added in wave 17, once Upstash was confirmed
   real. Ordence has exactly ONE pair of Upstash credentials
   (`lib/env.ts:70-71`), so the moment a staging deploy or a preview
   branch is pointed at the same database, `ord:v1:t:<uuid>:ledger-list`
   is byte-identical in both. **Defence ③ cannot catch that** — the
   tenant id in the envelope matches. It is the right tenant and the
   wrong universe. The key now carries a slug of
   `NEXT_PUBLIC_ROOT_DOMAIN`:

   ```
   ord:v1:ordence-com:t:11111111-1111-4111-8111-111111111111:ledger-list
   ord:v1:staging-ordence-com:t:11111111-1111-4111-8111-111111111111:ledger-list
   ```

   Proved by a subprocess, because the tag is frozen at module load on
   purpose — a key built from a value that can change mid-process would
   write under one prefix and read under another.

`npx tsx scripts/perf/prove-cache-isolation.mts` proves all four (16
assertions) against a poisoned store — the state no correct caller can produce, which is
precisely why defence ③ has to exist. Deleting the envelope check makes
that proof fail with *"tenant A would have been served tenant B's
data"*.

Degradation is counted, never thrown: `UPSTASH_REDIS_REST_URL` is
`.optional()` (`lib/env.ts:70`), so Redis is absent in development and
CI, and a cache that threw there would turn a missing optional variable
into a total outage.

**`lib/cache` has zero production callers today** and
`check-cache-adoption.mjs` fails because of it. Every call site belongs
to another track. The first one requested is `server/gst/registry.ts:156`
and `:182` — two `withTenant` transactions per invoice line to resolve a
GST rate that changes on a Council notification.

---

## 14. Slow-query visibility

`SQL-FILES/0158` installs `ordence_slow_queries(min_mean_ms, max_rows)`
over `pg_stat_statements` and `ordence_active_queries(min_running_ms)`
over `pg_stat_activity`.

**Two things it does honestly that are easy to get wrong:**

`CREATE EXTENSION pg_stat_statements` **succeeds** on a server where the
library is not in `shared_preload_libraries`. The extension object
exists, `pg_extension` reports it present, and every read of the view
raises `ERROR: pg_stat_statements must be loaded via
shared_preload_libraries`. A catalogue check would report "available" for
a log that collects nothing. **Availability is therefore determined by
reading the view inside an exception handler, not by asking the
catalogue** — and 0158's own verification block compares the function's
flag against an independent probe. Both branches were exercised.

`ordence_slow_queries()` returns **one row saying so** when unavailable,
never zero rows. Zero rows reads as "nothing is slow", which is the lie
the whole file is written against.

**Tenant attribution is not possible in `pg_stat_statements`** — it
aggregates by normalised query text and the tenant id is a bind
parameter. `ordence_active_queries()` reports one, from
`pg_stat_activity.application_name`, and it is NULL until `withTenant()`
sets it. That is one line in `db/index.ts`, requested in
`PATCH-REQUEST-F.md`:

```ts
await tx.execute(sql`SELECT set_config('application_name', ${'ord:t:' + tenantId}, true)`);
```

It is sampling, not a log — it sees a query only while it is running,
which is exactly the case that matters.

---

## 15. Known and not fixed

Everything in this section is real, measured where possible, and outside
Track F's file ownership. Detail and reproduction in `TRACK-REPORT.md`
§4.

- **`lib/pagination.ts` is dead code** and the customer is shown limits
  it does not enforce (§8).
- **All five export datasets are unbounded**, and the 200,000-row guard
  runs after the rows are already in memory (§8).
- **`page` has no ceiling** in three separate readers (§8).
- **21 N+1 sites**, worst first: `server/gst/engine.ts:96` and
  `server/purchases/engine.ts:231` (two transactions per invoice line),
  `server/actions/import.ts:1176` (one transaction per imported row).
- **`update_ledger_balance` serialises every posting to a ledger** on one
  row lock (§6).
- **`random_page_cost` is probably miscalibrated for Neon** (§7).
- **`connectionTimeoutMillis` is unset**, so pool exhaustion presents as
  unexplained latency (§9).
- **10 tables under RLS have no tenant-leading index** —
  `campaign_recipients`, `consents`, `court_fee_refund_claims`,
  `court_fee_schedules`, `email_suppressions`, `goods_receipt_lines`,
  `lead_intake_failures`, `login_lockouts`, `message_templates`,
  `webhook_endpoints`. `campaign_recipients` was measured and its index
  rejected at current size; the rest are small config tables where a
  sequential scan is genuinely cheap. `check-index-health.mjs` fails if
  an eleventh appears.
- **`lib/redis.ts` `cacheGet`/`cacheSet`/`tenantKey`/`getRateLimiter`
  have zero callers** and are superseded by `lib/cache/**`. Track F did
  not delete them; the file is not its own.
