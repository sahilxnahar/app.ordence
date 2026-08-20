# PATCH-REQUEST-A — changes Track A needs outside its ownership block

**Wave 14, revised wave 17. Track A (scheduler and the job control plane).**
Every item below is a change Track A could have made and did not, because
the file belongs to another stream or to nobody. They are ordered by
consequence, not by size.

Nothing here blocks the Track A zip from being applied. Items 1 and 2
change what a deployed scheduler is worth; items 4 to 9 are hygiene.

⚠️ **Changed in wave 17.** Item 3 is **withdrawn** — it was mine, and it
is fixed in my file. Item 9 is **new** and corrects the "Scheduler"
env-catalogue category integration added, which now has three rows too
many. Items 1, 2 and 4 stand unchanged.

---

## 1. 🔴 The jobs console is at `app/(platform)/jobs/`, not at the path the brief named — and it has to be

**Files:** `app/platform/jobs/page.tsx` (new, 3 lines), and one line in
`lib/platform/console-paths.ts`.

**This is also an ownership deviation, declared.** The brief's block named
`app/(platform)/admin/jobs/**`. The zip ships `app/(platform)/jobs/**`.
Read the reason before deciding whether to move it back, because moving it
back turns a security test red.

### Why the brief's path cannot be used

`tests/security/route-audit.test.ts:50`:

```ts
const FORBIDDEN_NAMES = new Set(["admin", "debug", "console", "test"]);
```

It walks every directory under `app/` and fails if any **URL segment** has
one of those names. Its header gives the rationale: no default admin route
should exist to be probed at all. A route group in parentheses is invisible
to that walk (`if (!entry.name.startsWith("(")) out.push(entry.name)`); a
literal directory named `admin` is not — whether or not anything routes
there.

Measured, not read. With the console at the brief's path:

```
FAIL |security| tests/security/route-audit.test.ts
     > no page or route file under any forbidden URL segment
AssertionError: expected [ 'admin' ] to deeply equal []
```

and with it at `app/(platform)/jobs/`, that file passes.

`server/scheduler/self-check.mjs` now re-walks `app/` for the same four
names, so the console cannot re-acquire one silently.

### Why it still is not where it belongs

A route group in parentheses is stripped from the URL, so
`app/(platform)/jobs/` serves at **`/jobs`**. Verified against
`middleware.ts` at v1.81.0-alpha:

- `:259` gates platform routes with `createRouteMatcher(["/platform(.*)"])` — `/jobs` does not match, so the middleware platform gate does not apply.
- `:882` rewrites non-`/platform`, non-`/api` paths on the console host to `/platform<path>`, so on `admin.ordence.com` this 404s.
- `app/platform/layout.tsx` — the console chrome, nav and second gate — does not wrap a `(platform)` route group.

`app/(platform)/jobs/layout.tsx` therefore performs the full
`getPlatformOperator()` check itself and `notFound()`s otherwise, exactly
as `app/platform/layout.tsx` does, so the page is not reachable by an
ordinary signed-in tenant user. It is gated. It is gated in the wrong
place, and it is invisible on the console host.

### The patch

Add `app/platform/jobs/page.tsx`:

```tsx
export { default, metadata, dynamic } from "@/app/(platform)/jobs/page";
```

and one entry in `CONSOLE_NAV` (`lib/platform/console-paths.ts:58`):

```ts
{ href: "/platform/jobs", label: "Scheduled jobs" },
```

That gives it the middleware gate, the console chrome, the nav and the
console host, with the page unchanged and its own gate still in place as a
second layer.

**If integration would rather have one path than two,** move
`app/(platform)/jobs/**` to `app/platform/jobs/**` wholesale and delete the
`(platform)` group — the four files move unchanged, `revalidatePath("/jobs")`
in `actions.ts` becomes `"/platform/jobs"`, and the two path literals in
`server/scheduler/self-check.mjs` §3 change. That is the better end state
and it is outside this track's block in both directions.

**What must NOT happen:** moving it to `app/(platform)/admin/jobs/**` to
match the brief. That is the one option the repository already refuses.

---

## 2. 🔴 The budget guard cannot stop work already inside `runScheduledJob`

**File:** `server/scheduling/registry.ts` — `runScheduledJob`.

**Why.** Track A's runner enforces `maxMs` at every boundary it owns,
which is between workspaces. That is real: a job that burns its budget on
workspace 3 does not go on to workspace 4. But a platform-scoped job is
one opaque call, and a per-tenant call for one workspace is likewise
opaque, so a run that goes long inside `runScheduledJob` cannot be
stopped — only observed afterwards and marked `budget_exceeded`.

**The patch.** Add an optional `signal?: AbortSignal` to
`runScheduledJob`'s args and pass it to `job.runForTenant` /
`job.runPlatform`, checking `signal.aborted` between workspaces in the
existing loop:

```ts
export async function runScheduledJob(args: {
  job: ScheduledJob;
  onlyTenantId?: string | null;
  limit?: number;
  signal?: AbortSignal;          // ← new
}): Promise<ScheduledJobRun>
```

```ts
  for (const tenant of candidates) {
    if (args.signal?.aborted) break;   // ← new, before the entitlement check
```

Track A's `server/scheduler/runner.ts` already computes the deadline and
already polls `cancel_requested` at the ledger; it would pass a controller
whose signal fires on either.

**Consequence of not doing it.** "Budget exceeded" stays an alert rather
than a stop for a single workspace's work, and the operator's Cancel
button on `/jobs` is honoured only at the next workspace boundary.
Both are documented as such in `docs/SCHEDULER.md` rather than implied to
be more than they are.

---

## 3. ~~Per-workspace fan-out re-lists the workspace table on every call~~ — **WITHDRAWN, wave 17**

**Nothing is needed from anyone. Do not apply this.**

The waste was real — `runScheduledJob(job, { onlyTenantId })` opened a
`withPlatformScope` transaction, selected up to 501 workspace rows and
filtered them to the one it was given, once per workspace per job per
slot. But I had filed it against the wrong file. **The wasteful loop was
mine:** `server/scheduler/runner.ts` was calling a fan-out function once
per fan-out unit. The fix was to stop making the call, not to make the
call cheaper.

`runner.ts` now calls `job.runForTenant(tenant)` with the workspace row
the tick already holds, and imports `tenantAllowsFeature` from
`server/scheduling/entitlement.ts` so the entitlement gate that
`runScheduledJob` was providing is applied by the same function rather
than a reimplementation of its rules. `server/scheduling/registry.ts` is
**unchanged**, and `app/api/workers/route.ts` still calls
`runScheduledJob` for the documented `{"mode":"scheduled"}` path.

See `TRACK-REPORT-WAVE-17.md` §6 for what else that call was providing and
where each property now lives.

---

## 4. The six AI background workers have no entitlement gate

**File:** `server/ai/background-workers.ts`.

**Why.** `BACKGROUND_WORKERS` declares six per-tenant workers reachable at
`/api/workers/ai-monitors`. `runAllWorkers` loops every active workspace
and runs every worker, with no equivalent of the registry's
`tenantAllowsFeature` check. They also appear in **no** document — grep
`ai-monitors` in `docs/current/CRON-RUNBOOK.md` returns nothing.

Track A therefore did **not** schedule them, and lists them in
`DORMANT_NOT_SCHEDULED` with this reason, visible on `/jobs` and in
`GET /api/workers` under `notScheduled`. Putting them on a clock as they
stand would deliver GST deadline watching, receivables ageing,
reconciliation drift, inventory reorder, compliance-gap and site-labour
anomaly detection nightly to workspaces that have not paid for them —
which is the eleventh instance of the pattern `server/scheduling/registry.ts`
names in its own header.

**The patch.** Add `feature: string | null` to `BackgroundWorker`, plus
`ungatedBecause` where a null is genuinely right, and gate inside
`runAllWorkers`. Candidate keys that already exist in
`lib/entitlements/features.ts`: `gst.registry`, `sales.receivables`,
`purchases.itc`, `inventory.stock`, `compliance.licences`,
`field.jobs`. Choosing them is a commercial decision, not a scheduling
one, which is why Track A did not choose them.

Once that lands, add one entry to `server/scheduler/policy.ts` and one
`ScheduledJob` to `EXTRA_SCHEDULED_JOBS` in `server/scheduler/catalog.ts`,
and remove the `ai_background_workers` entry from
`DORMANT_NOT_SCHEDULED`. The catalog's module-load assertion will refuse
to load until all three are consistent, which is the intended behaviour.

---

## 5. Drizzle definitions for the six `scheduler_*` tables

**File:** `db/schema/scheduler.ts` (new) and one `export * from "./scheduler"`
line in `db/schema/index.ts`.

**Why.** `db/schema/**` belongs to another stream this wave, so 0129–0131
create six tables with no Drizzle definition. `npm run check:sql` reports
them under "CREATED IN SQL BUT ABSENT FROM db/schema" — a **warning**, not
a failure (the gate exits non-zero only on tenant-scoped schema tables
with no RLS, and these are not in the schema at all).

Nothing is blocked: every scheduler read and write uses raw `sql`
templates, as 166 files under `server/` and `lib/` already do. The listed
risk — "`drizzle-kit push` may DROP them" — is not new, because
`drizzle-kit push` is banned outright in this project.

**Tables:** `scheduler_runs`, `scheduler_job_controls`,
`scheduler_tenant_pauses`, `scheduler_tenant_schedules`,
`scheduler_job_expectations`, `scheduler_heartbeat`. Column definitions
are in 0129–0131 with comments.

⚠️ `subject_tenant_id` is deliberately **not** named `tenant_id` and is
deliberately **not** a foreign key: the rows are platform-owned
operational history about a workspace, not that workspace's property, and
they must survive it. Please do not "fix" that when writing the Drizzle
definition.

---

## 6. Two seals for `scripts/sealed-grants.json`

**File:** `scripts/sealed-grants.json`.

**Why.** 0129 withholds DELETE on `scheduler_runs` from `ordence_app`, and
0132 withholds EXECUTE on `prune_scheduler_runs()`. Both are checked by
0132's own verification section — but that is a check inside a file, and
`0012 → 0087` is the recorded case of exactly that not being enough:
0012 shipped a verification query for the very grant 0087 later added, and
it never fired, because nobody re-runs an old file's verification section.

```json
{
  "id": "app-cannot-delete-scheduler-runs",
  "role": "ordence_app",
  "object": "scheduler_runs",
  "privilege": "DELETE",
  "kind": "table",
  "why": "The run ledger is the evidence that a scheduled job ran or did not. An application that can delete from it can erase the record of a run it should not have made. Retention is prune_scheduler_runs(), a maintenance-role function.",
  "declaredBy": "SQL-FILES/0129_scheduler_run_ledger.sql",
  "brokenBy": null,
  "repairedBy": null
},
{
  "id": "app-cannot-prune-scheduler-runs",
  "role": "ordence_app",
  "object": "prune_scheduler_runs",
  "privilege": "EXECUTE",
  "kind": "function",
  "why": "SECURITY DEFINER. Granting it to the application hands back the DELETE the line above withholds, which is character for character the 0087 -> 0121 regression on prune_security_events.",
  "declaredBy": "SQL-FILES/0132_scheduler_retention_and_seal.sql",
  "brokenBy": null,
  "repairedBy": null
}
```

---

## 7. Run the scheduler self-check as a gate

**File:** `scripts/run-gates.mjs` (shared, owned by nobody).

**Why.** Track A's ownership block does not include `tests/**`, so the
proofs live in `server/scheduler/self-check.mjs` — 47 checks, no database,
no network, ~1 second. It runs the cron parser and the maintenance lane
for real, and greps the source for one-phrase properties whose absence has
no symptom (`NULLS NOT DISTINCT` on the claim index;
`COALESCE(last_success, declared_at)` in the overdue predicate;
`state = 'succeeded'` rather than any state; the platform marker being the
first statement of every maintenance transaction).

Add to the `static` group:

```js
{ id: "scheduler", cmd: "node server/scheduler/self-check.mjs",
  what: "The scheduler's claim, watchdog and lane separation" },
```

⚠️ It exits non-zero on failure and prints one line per check. It does not
need `--full` and does not touch the network.

---

## 8. An npm script for the cron entrypoint, and a `scheduler:operate` capability

**Files:** `package.json` (shared), `lib/platform/roles.ts`.

**8a.** `railway.cron.json` runs `node server/scheduler/cron-entrypoint.mjs`
directly because no npm script could be added. `"scheduler:tick": "node
server/scheduler/cron-entrypoint.mjs"` would be tidier and would let the
start command be `npm run scheduler:tick`. Purely cosmetic.

**8b.** The `/jobs` write actions use `flags:write`, which is the
closest existing capability: engineer and owner, and already in
`STEP_UP_CAPABILITIES`. A dedicated key would be a better fit:

```ts
"scheduler:read":    "See the jobs calendar, run history and watchdog",
"scheduler:operate": "Run, pause, replay and cancel scheduled jobs",
```

with `scheduler:read` on all three grades, `scheduler:operate` on engineer
and owner, and `scheduler:operate` added to `STEP_UP_CAPABILITIES`.

⚠️ Track A did **not** invent these keys, and the reason is in
`lib/platform/roles.ts`'s own header: keys are stable identifiers that
fail closed. A key added by this track and not yet present in
`GRADE_CAPABILITIES` would mean **every grade lacks it** until the other
change lands — a console nobody can use. If you add them, change
`app/(platform)/jobs/actions.ts` (`requireCapability("flags:write")`
→ `requireCapability("scheduler:operate")`, six sites) and
`app/(platform)/jobs/page.tsx` (`observatory:read` →
`scheduler:read`) in the same commit.

---

## 9. 🔴 The "Scheduler" env-catalogue category needs **two** rows, not five

**File:** whichever file `check:env-catalogue` reads (integration added
the category; Track A does not own it).

**Why.** Integration catalogued five names as optional. Wave 17 deleted
three of them, so three of those five rows are now catalogued-but-unread
and will fail the same gate from the other direction.

| Row | Action |
|---|---|
| `SCHEDULER_APP_URL` | **keep**, optional |
| `MAINTENANCE_DATABASE_URL` | **keep**, optional |
| `APP_URL` | **remove** — replaced by `NEXT_PUBLIC_APP_URL`, already catalogued |
| `SCHEDULER_SOURCE` | **remove** — hardcoded; `scheduler_runs.triggered_by` already distinguishes clocks |
| `SCHEDULER_TIMEOUT_MS` | **remove** — hardcoded at 280 s |

Every name the scheduler reads is listed in `TRACK-REPORT-WAVE-17.md` §2,
produced by grep rather than by memory. `CRON_SECRET` and
`WORKER_API_SECRET` are pre-existing and already catalogued; the cron
service reads only `WORKER_API_SECRET`.

**Consequence of not doing it.** `check:env-catalogue` refuses the tree
for three settings nothing reads.
