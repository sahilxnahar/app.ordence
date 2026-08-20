# PATCH-REQUEST-F — changes Track F needs, outside its file ownership

Track F owns `scripts/perf/**`, `db/indexes/**`, `lib/cache/**`,
`docs/PERFORMANCE.md` and SQL numbers 0151–0158. Everything below is
outside that block, so none of it has been made. Each item states the
file, the change, the evidence, and what happens if it is not applied.

Ordered by consequence, worst first.

---

## 1. `db/index.ts` — the pool has no size and no timeout

**File:** `db/index.ts`, the `getPool()` function (~line 257).

**Today:**

```ts
const pool = new Pool({ connectionString: DATABASE_URL });
```

**Requested:**

```ts
const pool = new Pool({
  connectionString: DATABASE_URL,
  /**
   * ⚠️ WRITTEN DOWN BECAUSE IT DECIDES THE REPLICA COUNT.
   * replicas = floor((max_connections − reserved − headroom) / max)
   * See docs/PERFORMANCE.md §9. Ten is the inherited node-postgres
   * default; it is kept, but it is now a decision rather than an
   * accident, and changing it has a formula attached.
   */
  max: 10,
  /**
   * 🔴 WITHOUT THIS A FULL POOL QUEUES FOREVER. node-postgres' default
   * is no timeout: a request that cannot get a connection waits, with
   * no error anywhere, until something upstream gives up. The symptom
   * is "the site is slow" and adding a replica makes it worse.
   */
  connectionTimeoutMillis: 5_000,
});
```

**Evidence:** `node scripts/perf/pool-arithmetic.mjs` reads the effective
defaults out of `@neondatabase/serverless` (`max` 10,
`connectionTimeoutMillis` undefined) and asserts from the source of
`db/index.ts` that neither is configured.

**If not applied:** the first day Ordence exceeds ten concurrent
tenant-scoped transactions per process, it degrades into an unbounded
queue rather than a bounded failure, and nothing in the logs says so.

---

## 2. `db/index.ts` — one line that makes tenant attribution possible

**File:** `db/index.ts`, inside `withTenant()`, beside the existing
`set_config('app.current_tenant_id', ...)`.

**Requested:**

```ts
await tx.execute(
  sql`SELECT set_config('application_name', ${"ord:t:" + tenantId}, true)`,
);
```

**Why:** `SQL-FILES/0158` installs `ordence_active_queries()`, which
reports the tenant behind every query that is currently running — read
from `pg_stat_activity.application_name`. It returns NULL for every row
until something sets it.

`pg_stat_statements` cannot do this: it aggregates by normalised query
text and the tenant id is a bind parameter, normalised away. This is the
only mechanism that attributes a running query to a tenant without a new
table.

**Transaction-local (`true`) for the same reason every other setting in
that function is:** the value must be discarded at COMMIT, before the
connection returns to the shared pool. A session-scoped
`application_name` would follow the connection to its next borrower and
mis-attribute their queries.

**Cost:** one extra round trip per `withTenant()` call — measured at 4
today, this makes it 5. If that is judged too expensive, set it only when
`process.env.ORDENCE_TRACE_TENANTS === "1"` and turn it on during an
investigation. Say which was chosen; a silently-omitted line here leaves
`ordence_active_queries()` returning a column that is always NULL, which
is the defect this repository keeps finding.

---

## 3. `scripts/gates.mjs` + `package.json` — register four gates

**Files:** `scripts/gates.mjs` (the `GATES` array) and `package.json`
(the `scripts` block). Both are shared; neither has been touched.

`scripts/check-gate-coverage.mjs` enforces three rules that these entries
satisfy: every `check:*` npm script must appear in the manifest, every
manifest `script` file must exist with a matching npm script, and every
`why` must be at least 30 characters.

```js
// scripts/gates.mjs — static tier, before the database divider
{
  id: "perf-catalogue",
  script: "scripts/perf/check-catalogue-drift.mjs",
  tier: "static",
  wave: 16,
  why: "a performance catalogue entry citing a file that no longer exists, so the budget gate measures a query the product no longer issues",
},
{
  id: "perf-cache-adoption",
  script: "scripts/perf/check-cache-adoption.mjs",
  tier: "static",
  wave: 16,
  why: "lib/cache having zero production callers, which is this repository's characteristic defect applied to the caching layer itself",
},

// scripts/gates.mjs — database tier
{
  id: "perf-budgets",
  script: "scripts/perf/check-query-budgets.mjs",
  tier: "database",
  wave: 16,
  canSkip: true,
  why: "a query on a hot route exceeding its declared time or row budget, which is the only thing that stops performance work decaying the moment it stops being measured",
},
{
  id: "perf-index-health",
  script: "scripts/perf/check-index-health.mjs",
  tier: "database",
  wave: 16,
  canSkip: true,
  why: "a redundant, duplicate or INVALID index that costs a write on every insert and appears in no query plan, or a new RLS table with no index leading with tenant_id",
},
```

```jsonc
// package.json — scripts
"check:perf-catalogue":     "node scripts/perf/check-catalogue-drift.mjs",
"check:perf-cache-adoption":"node scripts/perf/check-cache-adoption.mjs",
"check:perf-budgets":       "node scripts/perf/check-query-budgets.mjs",
"check:perf-index-health":  "node scripts/perf/check-index-health.mjs",
```

### 🔴 Two of these will be RED on the day they are registered. Read this before registering them.

**`perf-cache-adoption` fails until item 4 below is applied.** That is
deliberate and it is the point: `lib/cache/**` currently has zero
production callers, which is exactly the shape of defect this repository
has found twenty-three times. **Register it AFTER item 4**, or CI turns
red for six other tracks on Track F's account.

**`perf-budgets` fails unless `scripts/perf/seed-load.mjs` has been run
against the target database.** It refuses to certify budgets against a
corpus smaller than 20,000 invoices — a budget met against 40 rows is met
against nothing. The CI job that runs the database tier needs one extra
line after `npm run test:bootstrap`:

```yaml
- run: node scripts/perf/seed-load.mjs
```

Without it the gate exits 78 (SKIPPED), and `run-gates.mjs:44` makes a
skip fatal in CI — so it fails, loudly and correctly, rather than
passing.

`perf-catalogue` and `perf-index-health` are green today.

---

## 4. `server/gst/registry.ts` — the first cache call site

**File:** `server/gst/registry.ts`, `findHsnSacByCode()` (~line 156) and
`loadRateHistory()` (~line 182).

**Today:** each opens its own `withTenant()` transaction, and
`server/gst/engine.ts:96` calls both **once per invoice line**. A
ten-line invoice is 20 transactions and 80 database round trips where 5
would do. `server/purchases/engine.ts:231` has the identical shape.

**Requested,** using the namespace that already exists for it:

```ts
import { cached } from "@/lib/cache";

const rates = await cached(
  tenantId,
  "hsn-rate",
  [hsnCode, asOfDate],
  () => withTenant(tenantId, (tx) => /* the existing query */),
);
```

`CACHE_NAMESPACES["hsn-rate"]` (`lib/cache/namespaces.ts`) carries a
one-hour TTL and its justification: GST rates change on a Council
notification, not on a customer action.

**Two things to do at the same time, and the second is the bigger win:**

1. **Hoist both lookups out of the per-line loop** in
   `server/gst/engine.ts:96` and `server/purchases/engine.ts:231` — one
   `inArray(hsnSacCodes.code, codes)` before the loop. Caching an N+1
   makes it a fast N+1; removing the loop removes it.
2. Wire the cache for the cross-request case.

**If not applied:** `scripts/perf/check-cache-adoption.mjs` stays red and
`lib/cache/**` is a module that was built and is not reached.

---

## 5. `lib/pagination.ts` and its call sites — a contract nobody consults

**Files:** `lib/pagination.ts` (dead), `server/export/datasets.ts`,
`server/dynamic/records.ts`, `lib/validators/dynamic.ts`,
`lib/platform/data-table-params.ts`, `server/views/query.ts`.

`lib/pagination.ts` is 344 lines of correct cursor pagination with
**zero production callers**. Its only importer,
`app/(crm)/settings/limits/page.tsx:212`, renders `ABSOLUTE_MAX_PAGE_SIZE`
and `MAX_PAGE_OFFSET` **to the customer as enforced platform limits** —
numbers no query in the codebase consults.

Smallest changes that stop the measured harm:

| File | Change |
|---|---|
| `lib/validators/dynamic.ts:309` | `page: z.number().int().min(1).max(1000)` — today there is no `.max()`, and `server/actions/dynamic-objects.ts:119` is browser-callable. `{page: 1e9}` becomes `OFFSET 50000000000`. |
| `lib/platform/data-table-params.ts:154` | clamp `page` — it is read straight from the query string with no ceiling. |
| `server/export/datasets.ts:100,414` | apply `MAX_EXPORT_ROWS` as a `LIMIT` **in the query**, not after `buildDataset()` has put every row in the heap (`server/export/render.ts:117`). A 400k-row workspace runs out of memory before it reaches the refusal. |
| `server/views/query.ts:225` | `page` ≤ 10,000 × `pageSize` 200 = offset 1,999,800, forty times the `MAX_PAGE_OFFSET` the product advertises. |

**Measured:** `OFFSET 100000 LIMIT 50` on 120,000 audit rows takes 65.9 ms
(35.0 ms after 0152) and scales linearly with an offset the caller
chooses. `export.contacts` returns 8,000 rows with no ceiling at the
enterprise tenant — three years of one mid-sized customer.

`scripts/perf/check-query-budgets.mjs` carries `export.contacts` and
`audit.deepOffset` as known defects **and fails if either starts
passing**, so fixing them is visible without anybody remembering to check.

---

## 6. `SQL-FILES/` (another track's number) — the posting write path

Three triggers on `journal_entries`, measured in
`docs/PERFORMANCE.md` §6. **92% of a journal-leg insert is triggers**
(321 µs/row with them, 27 µs without).

**`update_ledger_balance`** — `BEFORE ROW`. A `SELECT` on `ledgers` plus
an `UPDATE` of `ledgers.current_balance`, per leg.

> 🔴 The cost is not the two statements. It is an **exclusive row lock on
> one `ledgers` row, held to end of transaction, once per leg.** Every
> posting to the same bank or sales ledger serialises on it. Railway
> replicas make the queue longer, not shorter. This is a concurrency
> ceiling nothing in Track F's ownership can move.
>
> The usual shape is a per-ledger balance *delta* table written
> append-only, with the cached balance derived. **That is a correctness
> change to the accounting core, not a performance tweak, and it must not
> be made on the strength of this measurement alone.** What is requested
> here is that somebody who owns the accounting engine looks at the
> number.

**`record_change`** — `AFTER ROW` on 289 tables, writing a full
`to_jsonb(OLD)` + `to_jsonb(NEW)` image per row. Measured: **2,000
`journal_entries` inserts produce 4,000 `change_log` rows** — two per
leg, because `update_ledger_balance`'s write to `ledgers` logs itself as
well. Removing the ledger write removes half the change-log volume too.

**`enforce_double_entry_balance`** — `AFTER ROW`, re-aggregating every
leg of the transaction for each leg. Measured 0.237 ms/leg at 50 legs
rising to 0.277 ms/leg at 800 — the quadratic term is real but small.
A statement-level trigger with `REFERENCING NEW TABLE`, checking each
distinct `transaction_id` once, would make it O(n) and change no
behaviour. **This one is a safe, contained change** and is the one to do
first.

---

## 7. Two settings to measure, not to change

Neither is a code change and neither should be applied on Track F's word.

**`random_page_cost`.** Measured on the trial-balance query: at the
default 4.0 the planner chooses a sequential scan touching 6,861
buffers; at 2.0 or below it chooses an index-only scan touching 1,971.
`random_page_cost = 4` encodes a spinning disk's seek penalty. Neon's
storage is network-attached, where sequential and random access cost
nearly the same, so the default systematically prefers shipping the whole
relation over the network.

**The experiment:** set `random_page_cost = 1.5` for one session on a
Neon branch, re-run `node scripts/perf/measure.mjs --tag=rpc15`, and
compare against `--tag=baseline`. It affects every plan in the product,
so it needs the whole catalogue, not one query.

**Which Neon endpoint `DATABASE_URL` points at.** The direct hostname and
the `-pooler` hostname have different capacity arithmetic *and different
isolation properties*: transaction-mode pooling carries no session state,
which is safe here only because every setting Ordence uses is
transaction-local (`db/index.ts:311`). The repository does not record
which one is in use. **Write it down in `DEPLOY.md`** — it is a tenant
isolation fact, not a performance detail.

---

## 8. Two facts to confirm — no secret required, and one may be a real incident

`docs/PERFORMANCE.md` §10 cannot be completed from inside a build
container.

1. **Which region does Railway serve from?** The brief says `sfo`. Visible
   on the Railway service page.
2. **Which region is the Neon project in?** `DEPLOY.md:17` and `:49`
   specify `ap-southeast-1` (Singapore). `.env.example` uses a literal
   placeholder `region` in the hostname, so the repository does not know.
   Visible on the Neon project page.

**If those two are different regions, every database round trip crosses
an ocean — and `withTenant()` costs four of them, measured.** A ten-line
invoice save makes twenty `withTenant()` calls today because of the N+1
in item 4: eighty round trips. At a 170 ms Pacific RTT that is thirteen
seconds.

That would be a larger problem than the 250 ms of user latency the Track
F brief asks about, and it would be paid per transaction rather than per
page. **Confirm the two regions before anybody schedules a migration to
Mumbai** — moving the app closer to users while leaving the database in
Singapore would make it worse.
