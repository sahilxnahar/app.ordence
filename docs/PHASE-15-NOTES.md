# Phase 15 — Usage Metering

Version: v0.14.0-alpha
Provides the substrate for **Phase 16** (overage billing) and for a later AI
token budget.

> ⚠️ **This phase is NOT complete until the "INTEGRATION REQUIRED" section at
> the bottom is applied.** Everything here is a schema, two pure libraries, two
> server modules and a SQL file. A counter that is never incremented reads zero
> for ever, and reads zero *silently* — no error, no empty screen, no failed
> request. The wiring was left out deliberately: this phase does not own
> `db/schema/index.ts`, `server/actions/**`, `app/**`, `lib/email/**` or
> `scripts/verify-security.ts`.

---

## 1. What was built

| File | What it is |
|---|---|
| `lib/metering/quota.ts` | Metric definitions (kind, unit, plan column, block point), quota comparison in exact bigint arithmetic, the warning ladder, the human copy, the RSC serialiser. Pure, isomorphic. |
| `lib/metering/period.ts` | Billing-period resolution. Imports `addInterval` from `lib/billing/money.ts`; does not reimplement month arithmetic. Pure. |
| `db/schema/metering.ts` | `usage_counters` (cumulative buckets) and `usage_levels` (storage as a reading). The `usage_metric` enum is **imported** from the pure module, not retyped. |
| `server/metering/record.ts` | Atomic increment / decrement / set-level recorders. Best-effort by default; `reserveUsage()` is the one writer that throws. |
| `server/metering/query.ts` | Current-period usage, quota state, the UI summary, per-period history, `requireQuota()`. |
| `SQL-FILES/0013_phase15_metering.sql` | RLS with `USING` **and** `WITH CHECK`, the monotonic trigger, the level guards, an arbiter-index assertion, REVOKE-before-GRANT, retention under a separate credential, 12 numbered verification checks. |
| `tests/ui/metering.test.tsx` | 48 assertions. Pure: metric kinds, bigint exactness, the ladder, where each metric blocks, period boundaries including the 31st. |
| `tests/security/metering-isolation.test.ts` | 34 assertions against real PostgreSQL as `ameya_app`, including a live concurrency comparison. |

**No new npm dependencies.**

---

## 2. Counters, not events — and what that costs

A row per metered occurrence is the obvious design and it is unaffordable: one
tenant on the 10,000-call plan is 10,000 rows a month, two hundred tenants is
two million, and rendering a usage bar becomes a month-wide aggregate on a page
that must be instant — on the hot path of every quota check. The table also
grows in proportion to how much a customer *uses the product*, which is the
worst possible correlation.

A single mutable counter per tenant is the opposite extreme: cheap and useless.
It cannot answer "what did they use in May", which is the only question an
overage invoice asks, and it has nowhere to reset to at a period boundary
without destroying history.

**So: one row per `(tenant, metric, period_start)`.** About four rows per tenant
per month. It answers the billing question directly and last month's bucket is
still there when the customer disputes the line.

**What is lost, stated plainly:** per-occurrence forensics. "Which endpoint made
those 9,000 calls" is *not* answerable from this table. That is an
observability question and it belongs in request logs and Phase 19 telemetry,
not in a billing counter that has to be both correct and cheap.

### Are the buckets append-only? No.

`audit_logs`, `payment_events`, `contract_signatures` and `security_events` all
refuse UPDATE outright. This table cannot: the entire concurrency design is
`ON CONFLICT DO UPDATE SET value = value + excluded.value`, which *is* an
UPDATE. Refusing it forces the event table we just rejected.

So the guarantee is narrowed to the one that still has teeth, and it is enforced
by trigger (`usage_counters_monotonic`, SQLSTATE 42501):

> **A counter may go up. It may never go down, and it may never be moved to
> another tenant, metric or period.**

The only reasons to lower a cumulative counter are to under-bill, to hide usage
from a customer about to be charged for it, or to paper over a bug — and the
realistic one is the third. `DELETE` is withheld from the application role
entirely; pruning is `prune_usage_counters()`, granted to nobody by default.

---

## 3. Level vs cumulative — the modelling that matters most

| | `usage_counters` | `usage_levels` |
|---|---|---|
| Metrics | `emails_sent`, `api_calls`, `portal_links_created` | `storage_bytes` |
| Semantics | a tally within a billing period | a reading, right now |
| Direction | up only | up **and down** |
| Period | one row per period; resets by getting a new row | one row, for ever; does not reset |
| Guard | monotonic trigger | `GREATEST(0, …)` clamp + `>= 0` CHECK |

**Why two tables rather than one with a `kind` column.** The monotonic trigger
must apply to one and must *not* apply to the other. One table needs a trigger
with a branch in it, and the day that branch is wrong is the day either storage
stops decreasing — a customer who deletes 30 GB is still billed for it, and is
eventually locked out of an account they have been diligently tidying — or
emails become decrementable, and usage vanishes before invoicing. Two tables
make each guarantee unconditional. Two CHECK constraints keep a metric from
being written into the wrong one.

`usage_levels` also carries `peak_value` scoped to `peak_period_start`. Phase 16
has a genuine choice — bill storage on the closing reading (rewards deleting
everything on the last day) or on the peak (charges for an hour-long spike) —
and that choice cannot be made retrospectively if the peak was never recorded.

---

## 4. Concurrency — the proof, not the claim

Every increment is one statement:

```sql
INSERT INTO usage_counters (...) VALUES (...)
ON CONFLICT (tenant_id, metric, period_start) DO UPDATE
  SET value = usage_counters.value + excluded.value;
```

A read-modify-write is not "slightly racy" here, it is wrong by construction:
there may be a hundred concurrent Vercel instances sharing no lock, no memory
and no leader, so there is no layer in which a mutex could exist; and under
READ COMMITTED two transactions that both read 41 both write 42, with no error.
The loss is always in the customer's favour, so nobody ever reports it.

`tests/security/metering-isolation.test.ts` runs **both shapes, concurrently,
against the real database on four real connections**, with `pg_sleep` forcing
the overlap:

- upsert × 4 → final value **4** (nothing lost);
- read-modify-write × 4 → final value **1** (three increments gone, silently).

The test also records what the monotonic trigger does *not* catch: each of those
stale writes is an *increase* relative to the row it overwrote, so the guard
stays silent. Nothing in the database can detect a lost update after the fact —
which is exactly why the arithmetic must happen inside the statement.

**A real bug this suite caught.** The first version of `adjustLevelStatement()`
used `excluded.current_value` in the DO UPDATE branch. Because the VALUES row
must clamp (`GREATEST(0, delta)`, so a decrement against a not-yet-existing row
inserts 0), `excluded.current_value` is **zero for every decrement** — making
every document deletion a silent no-op and storage rise for ever. The
"a decrement genuinely lowers the figure" test failed on the first run. That
failure is the phase's central risk, reproduced in miniature.

---

## 5. Metering never breaks the request it measures — with one exception

Everything that **observes** swallows its own errors and returns a boolean
(logged loudly with tenant, metric and quantity). If a recorder could throw:

- a database hiccup turns a served API call into a 500, caused by bookkeeping
  the customer does not know exists;
- the busiest tenants — the ones paying most — hit it first and hardest;
- worst: an email is sent, the counter write fails, the request 500s, the caller
  retries, **the email is sent again**. A lost count becomes a duplicated side
  effect.

**The exception is `reserveUsage()`,** used only for hard-capped metrics
(storage, today) and only inside the caller's transaction. There the counter is
not a report, it is the mechanism deciding whether the next upload is allowed.
Best-effort there means anyone who can make the write fail gets an unmetered,
unbounded plan: uploads succeed, the level never moves, the quota never trips,
and the first symptom is a blob-storage bill. So it throws, and the upload it
was reserving for rolls back. "Please try again" is honest and costs nothing.

**Decrements never throw, even for hard-capped metrics.** A failed decrement
leaves the figure too *high*; failing the delete instead would leave an
over-quota customer unable to use the one remedy available to them.
`reconcileStorageLevel()` corrects the drift from `SUM(documents.size_bytes)`.

---

## 6. Advisory before blocking (consistent with Phase 14)

Ladder: `ok` → `notice` (80%) → `warning` (95%) → `exceeded` (100%). Thresholds
are **basis points**, never floats.

`exceeded` is not the same as blocked. Where each metric actually refuses:

| Metric | Refuses at | Why |
|---|---|---|
| `storage_bytes` | **100%**, new uploads only | The only metric whose cost to us is unbounded and permanent, and the only one with a free, immediate, self-service remedy. |
| `emails_sent` | **150%** | Refusing the 501st email on a 500 plan does not inconvenience the customer — it strands a **third party** waiting for a contract, who has no idea a quota exists. 50% headroom absorbs a busy week; a runaway loop still stops. |
| `api_calls` | **never** | This is Phase 16's metered overage. An API that starts erroring at an unannounced threshold is an outage we caused. |
| `portal_links_created` | never | `plans` has no column for it. Measured, not capped — inventing a quota here would duplicate a commercial decision nobody has made. |

Nothing in this phase hides data, blocks a read, blocks an export, or blocks a
**delete**. The storage refusal message names the remedy and states explicitly
that nothing uploaded has been hidden or removed.

**A tenant with no live subscription is measured, not capped.** The objection —
"so cancelling is an unlimited plan" — is already answered by Phase 14: a
workspace without a live subscription reaches `restricted`, which is read-only,
and a read-only workspace cannot upload, send or mint a link. Inventing a
default quota here would instead refuse the first upload of a workspace ten
minutes into signup, before its subscription row exists.

---

## 7. Periods follow the subscription, not the calendar

Priority order in `resolveMeteringPeriod()`:

1. `subscriptions.current_period_start/_end` — authoritative, maintained by the
   Phase 11 webhook path.
2. Rolled forward with `addInterval` when `now` has passed the stored end (the
   renewal happened, the webhook has not landed). Putting that usage in the old
   period would inflate a month that is about to be invoiced.
3. A UTC calendar month **only** when there is no subscription at all, flagged
   `calendar_fallback` so a reader can tell.

A subscription anchored on the 9th buckets 9th→9th. The bucket key is the start
**instant**, never `YYYY-MM` — two subscriptions anchored on different days of
the same month must not collide.

`addInterval` is imported, not rewritten: it already solves the 31st (31 Jan →
28 Feb, clamped, rather than JavaScript's silent roll to 2 March, which walks
the anchor day forward for ever).

**One honest caveat.** Rolling forward repeatedly from a *clamped* date drifts
(31 Jan → 28 Feb → 28 Mar where the provider says 31 Mar). That needs the
renewal webhook to be missing for an entire extra period — a billing incident
with its own alarm — and rule 1 restores the exact boundary the moment the
webhook lands. The alternative is reimplementing the month-length clamp this
module exists to avoid.

---

## 8. Verified vs written

**Executed:**

- `npx vitest run --config vitest.ui.config.ts tests/ui/metering.test.tsx` →
  **48 passed**.
- `npx vitest run --config vitest.config.ts tests/security/metering-isolation.test.ts`
  → **34 passed**, as `ameya_app` (non-superuser) against PostgreSQL 16 on
  127.0.0.1.
- `psql -f SQL-FILES/0013_phase15_metering.sql` against `ameya_test` → applied
  clean, all 12 verification checks PASS.
- `npx tsc --noEmit` → **no errors in any Phase 15 file**. Errors do remain in
  `server/platform/impersonation.ts`, which belongs to another phase being
  edited concurrently and was not touched here — the count changed between two
  runs minutes apart, so it is live work, not something introduced by this
  phase.
- `drizzle-kit generate` into a **temp directory** — used only to confirm the
  DDL Drizzle emits for `db/schema/metering.ts` matches, name for name, the
  scratch DDL the tests ran against. No migration file was written into the
  repo, and neither `db:push` nor `npm run build` was run.

**Not executed:** `npm run build`, `drizzle-kit push`, `npm run db:verify`
(needs the barrel line first).

**State left in `ameya_test`:** `usage_counters`, `usage_levels` and the
`usage_metric` enum exist, created from a scratch DDL identical to Drizzle's
output, with 0013 applied. The scratch file itself was deleted. ⚠️ If
`drizzle-kit push` is run **before** the barrel line in step 0 below is added,
push will treat these tables as drift and **drop them** — add the barrel line
first.

**Created outside the ownership list, deliberately:** `.env.test` (four lines,
gitignored) — the security suite refuses to start without it, so it could not
otherwise have been run. Delete it if you keep that file elsewhere:

```
TEST_DATABASE_URL="postgresql://ameya_app@127.0.0.1:5432/ameya_test"
TEST_ADMIN_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/ameya_test"
ALLOW_DESTRUCTIVE_TESTS="true"
NODE_ENV="test"
```

---

## 9. What still worries me

1. **`withTenant()` opens a WebSocket pool per call.** Standalone recorders
   therefore cost a connection each. On the API-call path that is the wrong
   shape at volume — which is why every recorder has a `*Tx` twin, and why the
   integration steps below prefer them wherever a transaction already exists.
   A batched/queued recorder is the obvious Phase 16 follow-up.
2. **Nothing calls the recorders yet.** Until INTEGRATION is applied, every
   counter reads zero and the usage page will say so, convincingly.
3. **The 60-second context cache** means that for up to a minute after a plan
   change the previous quota applies. `resetMeteringContext(tenantId)` after a
   plan change (step 6) removes that; without it, it is a minute, per instance.
4. **Reconciliation is not scheduled.** `reconcileStorageLevel()` exists and is
   tested by hand only; nothing runs it nightly yet (step 7).
5. **`documents.sizeBytes` is `mode: "number"`** (Phase 8). Fine per file,
   wrong for a library-wide SUM — which is why the reconciliation query casts
   `SUM(size_bytes)::text` and parses it as a `BigInt`. Changing that column is
   a Phase 8 decision, not one taken here.

---

# INTEGRATION REQUIRED

Apply these yourself; this phase does not own any of the files below.

### 0. Schema barrel — `db/schema/index.ts`

Add, after the telemetry/secops lines:

```ts
// Usage metering — per-tenant counters and levels (Phase 15)
export * from "./metering";
```

Then `npm run db:push`, then run `SQL-FILES/0013_phase15_metering.sql`, then
`npm run db:verify`. Also fold 0013 into `SQL-FILES/ALL-IN-ONE-SETUP.sql`.

### 1. `scripts/verify-security.ts`

```ts
// in REQUIRED_RLS_TABLES, after the Phase 20 entry:
  // Phase 15 — usage metering. Both are NOT NULL tenant_id with a plain
  // equality policy: there is no such thing as usage belonging to nobody.
  "usage_counters", "usage_levels",

// in REQUIRED_TRIGGERS:
  // Phase 15 — a cumulative counter may never be lowered, and a level row
  // may never change tenant. Both are invisible if dropped.
  "usage_counters_monotonic",
  "usage_levels_identity_fixed",
```

### 2. Storage — reserve on write, release on delete

`server/actions/storage.ts`, **`saveDocumentRecord()`** (~line 238). The
document row and the reservation must succeed or fail together, so the plain
`db.insert` becomes a transaction:

```ts
import { withTenant } from "@/db";
import { reserveStorageBytes } from "@/server/metering/record";
import { getTenantMeteringContext } from "@/server/metering/query";

const { period } = await getTenantMeteringContext(ctx.tenant.id);

const created = await withTenant(ctx.tenant.id, async (tx) => {
  const [row] = await tx.insert(documents).values({ /* …unchanged… */ }).returning();
  if (!row) return null;

  // THROWS if it cannot be recorded — see PHASE-15-NOTES §5. An upload we
  // cannot meter is an upload that did not happen.
  await reserveStorageBytes(tx, {
    tenantId: ctx.tenant.id,
    bytes: BigInt(data.sizeBytes),
    period,
  });

  return row;
});
if (!created) return fail("Could not record that file.");
```

**`deleteDocument()`** (~line 425), *after* the row is stamped and **outside**
any transaction — best-effort, must never fail the delete:

```ts
import { releaseStorageBytes } from "@/server/metering/record";

await releaseStorageBytes(ctx.tenant.id, BigInt(existing.sizeBytes));
```

### 3. The upload gate — `app/api/upload/route.ts`

In `POST()`, after the tenant context is resolved and before a token is issued,
using the client-declared size:

```ts
import { requireQuota, QuotaExceededError } from "@/server/metering/query";

try {
  await requireQuota(ctx.tenant.id, "storage_bytes", BigInt(declaredSizeBytes));
} catch (err) {
  if (err instanceof QuotaExceededError) {
    return NextResponse.json({ error: err.message }, { status: 413 });
  }
  throw err;
}
```

⚠️ Gate the **upload** only. Never call `requireQuota` before a delete, a
download or an export.

### 4. Email — `lib/email/resend.ts`

Preferred (one place, cannot drift): add an optional field to
`SendEmailOptions` and record inside `sendEmail()` after a successful send.

```ts
export type SendEmailOptions = {
  /* …existing… */
  /** Attribution for Phase 15 metering. Omit for platform-internal mail. */
  tenantId?: string;
};

// …after `const { data, error } = await client.emails.send(...)` succeeds:
if (options.tenantId) {
  // One unit per accepted RECIPIENT — that is how the provider bills us.
  void recordEmailSent(options.tenantId, valid.length);
}
```

`import { recordEmailSent } from "@/server/metering/record";` — and note
`sendEmail()` must keep never throwing; `recordEmailSent` never throws either.
Then pass `tenantId` from `sendContractReadyEmail`, `sendLedgerAlertEmail` and
the signature/portal senders.

### 5. Portal links — `server/actions/portal.ts`

In **`createPortalLink()`** (~line 152), after the link row is created:

```ts
import { recordPortalLinkCreated } from "@/server/metering/record";

void recordPortalLinkCreated(ctx.tenant.id);
```

### 6. API calls, and the cache reset

**API calls** — record in the route handlers under `app/api/**` *after* the
tenant is resolved, one line each:

```ts
import { recordApiCall } from "@/server/metering/record";
void recordApiCall(ctx.tenant.id);
```

⚠️ **Not in `middleware.ts`.** Middleware runs on the Edge runtime, has no
database client, and runs for static assets — three separate reasons it is the
wrong place. A count that includes `/favicon.ico` is not a count of API calls.

**Cache reset** — in `server/actions/billing.ts`, wherever a plan change or a
subscription state change is committed:

```ts
import { resetMeteringContext } from "@/server/metering/query";
resetMeteringContext(ctx.tenant.id);
```

Without it the previous plan's quota applies for up to 60 seconds per instance.

### 7. Nightly reconciliation (recommended)

From an existing cron route, for each active tenant:

```ts
import { reconcileStorageLevel } from "@/server/metering/record";
await reconcileStorageLevel(tenantId);
```

Delta drift is small and bounded but accumulates over years; this collapses it
back to `SUM(documents.size_bytes)` and stamps `last_reconciled_at`.

### 8. `CHANGELOG.md`

```md
### Added — Phase 15: Usage Metering
- Period-bucketed per-tenant counters (`usage_counters`) and storage as a
  level (`usage_levels`), both RLS-isolated and bigint throughout.
- Atomic `ON CONFLICT DO UPDATE` recorders; best-effort by default, with
  `reserveUsage()` the single writer that fails its caller.
- Quota ladder (80/95/100%) that warns long before it refuses, refuses only
  the narrowest action, and never blocks a read, an export or a delete.
```
