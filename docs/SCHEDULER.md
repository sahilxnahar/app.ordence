# Ordence — the scheduler and the job control plane

**Wave 14, Track A. Repo: `app.ordence`. SQL 0129–0132, then the code push.**

This document is written by hand and is not generated.
`docs/current/CRON-RUNBOOK.md` **is** generated, from
`server/scheduling/registry.ts`, and a UI test compares the two — so
where this document and that one disagree about a job's cadence, that one
is right and this one has rotted. Tell somebody.

---

## The thing to understand first

Before this wave, Ordence had jobs and no clock.

Eight of them were registered in `server/scheduling/registry.ts`,
documented in a runbook, entitlement-gated, argued for in comments, and
reachable at `POST /api/workers {"mode":"scheduled","jobId":"…"}`. Six
more existed at `POST /api/workers/ai-monitors` in a second registry that
appears in no document at all. Nothing called either endpoint on a clock.
No Railway cron service, no `schedule:` in `.github/workflows/`, no
`triggers.crons` in `wrangler.jsonc`.

Nothing in the product said so. The screens kept working, the collections
board kept showing what it showed yesterday, and the customer kept not
receiving the reminder. That is the failure this wave exists to end, and
the shape of it is worth naming: **an alarm that fires on errors cannot
see a job that never ran.**

---

## The shape of it

```
  ┌──────────────────────────┐        ┌──────────────────────────────┐
  │  Railway cron service    │  POST  │  web service                 │
  │  railway.cron.json       │───────▶│  /api/workers  {mode:"tick"} │
  │  */5 * * * *             │        │                              │
  │  cron-entrypoint.mjs     │        │  server/scheduler/tick.ts    │
  │                          │◀───────│  → which slots are due?      │
  │  exit 0 / 1 / 2 / 3      │ handoff│  → claim, run, record        │
  └───────────┬──────────────┘        └──────────────┬───────────────┘
              │                                      │
              │ as ordence_maintenance               │ as ordence_app
              ▼                                      ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  scheduler_runs   ← the ledger. One row per (job, slot, tenant). │
  │  scheduler_job_controls / _tenant_pauses / _tenant_schedules     │
  │  scheduler_job_expectations / _heartbeat                         │
  └──────────────────────────────────────────────────────────────────┘
              ▲                                      ▲
              │                                      │
  GET /api/workers?watchdog=1              /jobs  (the calendar)      
  200 or 503, for an external monitor      what an operator looks at
```

**One cron service, on one schedule, forever.** It does not know what the
jobs are. It POSTs `{"mode":"tick"}` and the application answers from
`server/scheduler/catalog.ts`. That is why adding a ninth job schedules it
by the commit that adds it, rather than by somebody remembering to open
the Railway console.

The cost is five minutes of granularity: a slot at 19:30 runs by 19:34.
Every cadence in this product is fifteen minutes or slower, so today this
is invisible. It is written down because it stops being invisible the
moment somebody adds a per-minute job.

---

## Setting it up, once

### 1. Apply the SQL, in order

```
SQL-FILES/0129_scheduler_run_ledger.sql
SQL-FILES/0130_scheduler_control_plane.sql
SQL-FILES/0131_scheduler_watchdog.sql
SQL-FILES/0132_scheduler_retention_and_seal.sql
```

Each one verifies itself by executing the property it claims and raises if
the claim is false. 0132 additionally refuses if 0129–0131 are only partly
applied, which is the likeliest real fault: these are pasted into a
browser SQL console one at a time, and a tab closed after 0130 leaves a
database with a control plane and no watchdog — with no symptom.

**Do not run `drizzle-kit push`.** It silently drops RLS policies on 300+
tables. `npm run db:push` is wired to refuse in production and should be
treated as forbidden everywhere.

### 2. Create the cron service in Railway

Same project, same repository, a **new service**. Point its config-as-code
path at `railway.cron.json` (Settings → Config as code), or set
`RAILWAY_CONFIG_FILE=railway.cron.json` on it.

🔴 **Do not put a cron schedule on the web service.** Railway's cron
feature *restarts a service* on a schedule, so attaching it to a service
that never exits restarts the website every five minutes. And a scaled web
tier runs N replicas: a scheduler inside it fires every job once per
replica, which for `dunning_sweep` means two statutory demand notices for
one debt at two different serial numbers. The ledger claim would refuse
the second, but a design that leans on its last line of defence every
night is not a design.

### 3. Variables on the cron service

| Variable | New? | What it is |
|---|---|---|
| `WORKER_API_SECRET` | **no — already set on the live service** | The bearer token `/api/workers` checks. Use the existing value |
| `NEXT_PUBLIC_APP_URL` | no — already catalogued and set | Default address of the web service |
| `SCHEDULER_APP_URL` | yes, optional | Overrides the above. Set it to reach the web service over Railway private networking |
| `MAINTENANCE_DATABASE_URL` | yes, optional | The `ordence_maintenance` connection string. Without it, retention does not run — see below |

⭐ **`WORKER_API_SECRET` and `CRON_SECRET` are already set on the live
Railway service.** Somebody prepared for scheduled work years ago and
nothing ever called it. Use those names; do not mint new ones. Two secrets
for one job is how a scheduler authenticates against the wrong one at 3am.

🔴 **`CRON_SECRET` is deliberately not read by the cron service.** It
belongs to `/api/cron/canary`, whose response names real workspace ids and
should not be reachable with the token a cron runner holds for everything
else. The canary now runs as the `rls_canary` job *inside* the
application, which calls `runCanaryProbe()` directly — so the clock never
needs a second secret.

The first delivery of this track read five environment names that were in
no category, and `check:env-catalogue` refused it. Two survive, both
optional. `APP_URL`, `SCHEDULER_SOURCE` and `SCHEDULER_TIMEOUT_MS` were
deleted rather than catalogued: a knob nobody will turn is a catalogue
entry nobody will read.

With no `WORKER_API_SECRET` configured, `/api/workers` answers **503** and
refuses to run anything. That is deliberate: an unauthenticated worker
endpoint is worse than no worker endpoint.

### 4. Point a monitor at the dead man switch

```bash
curl -fsS -H "Authorization: Bearer $WORKER_API_SECRET" \
  "https://app.ordence.com/api/workers?watchdog=1"
```

**200** — every declared job has completed inside its declared window and
the clock is beating.
**503** — it has not.

Put that in cron-job.org, UptimeRobot, a Railway healthcheck on a third
service, or anything else that polls a URL and shouts.

🔴 **This is the only part of the system that does not depend on the
scheduler.** Every other signal here is downstream of a run happening: a
failed workspace is counted, a tick returns 500, a red tick appears in
Railway. All of them require the scheduler to be alive. The failure this
product has actually had for years is the scheduler *not existing*, and no
run-driven signal can see it. The windows live in
`scheduler_job_expectations`, the evaluation is `scheduler_overdue()` in
SQL, and both keep working when the tick stops.

**`-f` is not optional.** Without it `curl` exits 0 on an HTTP 503.

---

## The two lanes

### The `app` lane

Runs inside the web service as the application database role. Everything
in `server/scheduling/registry.ts` plus the four jobs Wave 14 added:

| Job | What it does | Why it was dormant |
|---|---|---|
| `contract_expiry_scan` | Enqueues the expiry scan per workspace | The scan, the processor and the queue kind all existed; the only thing that enqueued one was the `{"mode":"cron"}` branch nothing called |
| `automation_event_purge` | Deletes automation events past `purge_after` | The deleter existed and its only caller was a **button** on `/automations/queue` |
| `platform_impersonation_sweep` | Closes expired impersonation sessions | Piggybacked on somebody opening the platform action log |
| `platform_health_sweep` | Opens and closes tenant health events | Ran only when an operator clicked, or opened `/platform/health` |
| `rls_canary` | Proves tenant isolation is still enforced by the database | 🔴 Added wave 17. The probe existed at `/api/cron/canary` with a suggested hourly schedule in the runbook, and nothing has ever called it. RLS is the *only* tenant isolation in this product |

🔴 **`rls_canary` fails the run on `inconclusive`, not only on `breach`.**
A 503 from that probe is what you get when the database role *bypasses*
row-level security — the probe could not put itself in a position to prove
anything. `docs/current/CRON-RUNBOOK.md` says it exactly: "A green tick
from a connection that bypasses row-level security is the worst outcome
available here. It is believed, and it is evidence of nothing." So an
inconclusive verdict lands in the ledger as a failure and takes
`?watchdog=1` red.

### The `maintenance` lane

🔴 **This lane exists because the application role must not be able to run
these functions, and a `GRANT` would not be a fix.**

| Function | Refused to `ordence_app` by | Sealed |
|---|---|---|
| `prune_security_events()` | 0012 in a comment; 0087 granted it back 75 files later; 0121 revoked it | yes |
| `prune_usage_counters()` | 0013; sealed by 0121 | yes |
| `prune_change_log()` | 0128, at creation | — |
| `prune_scheduler_runs()` | 0132, at creation | — |

`0087_hardening_narrow_grants.sql` is the cautionary tale. It revoked
EXECUTE on all functions from PUBLIC — correct and overdue — then
re-granted the ones the application legitimately calls, by copying
signatures "verbatim from the modules that GRANT them". Every other
signature on that list is granted to `ordence_app` by its module.
`prune_security_events` is granted to `ordence_maintenance`. The signature
was copied, the role was not read, and the line was indistinguishable from
its thirty neighbours for four waves.

`npm run check:sealed-grants` now fails the build on any `.sql` file that
grants a sealed privilege. So this lane runs over a second connection.

**Creating the role** — in a Neon SQL console, connected as the owner:

```sql
CREATE ROLE ordence_maintenance LOGIN PASSWORD '<generate one>'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO ordence_maintenance;
-- then re-run 0129, 0131 and 0132. Their grant blocks are guarded on the
-- role existing and are idempotent.
```

⚠️ `NOBYPASSRLS` is not optional. A maintenance role with BYPASSRLS reads
every workspace's data on every query, and none of these functions needs
it: each sets the platform marker or loops workspaces explicitly.

**If `MAINTENANCE_DATABASE_URL` is not set, nothing breaks and nothing is
hidden.** The jobs stay declared in the catalog, so
`scheduler_overdue()` reports them and the watchdog endpoint goes red.
"Retention is not configured" becomes visible, which is the entire
difference between this and the years before it.

**By hand**, as `ordence_maintenance`:

```sql
SELECT * FROM prune_scheduler_runs(90, true);   -- counts only
SELECT * FROM prune_scheduler_runs(90, false);  -- deletes
SELECT * FROM prune_change_log(180, true);
SELECT * FROM prune_security_events(365, true);
SELECT prune_usage_counters('25 months');
```

---

## Two triggers, one ledger

`{"mode":"cron"}` — the sweep that predates this track — enqueues a
contract-expiry scan for every workspace and drains the mail outbox.
`{"mode":"tick"}` has a `contract_expiry_scan` job and a `mail_drain` job
that do the same two things. `docs/current/CRON-RUNBOOK.md` tells
operators "Keep it if you are already running it", so a deployment may
well be driving both.

**Running both is safe, and was already safe.** Each job argues its own
idempotency: the outbox claim is `FOR UPDATE SKIP LOCKED` with a fixed
key per row, and the expiry scan raises notifications that coalesce on
their own key. Nothing is sent twice.

🔴 **What was not safe is that the legacy path left no trace.** A
deployment driving only `{"mode":"cron"}` would do the work every night
while `scheduler_overdue()` reported `mail_drain` and
`contract_expiry_scan` as never having run — a red watchdog on a healthy
system, which is the fastest way to get a watchdog ignored. Since wave 17
the sweep writes a ledger row (`legacy_cron_sweep`) and its response
carries `deprecated: true` and `replacedBy`.

⚠️ It writes a **manual** row with no slot. The sweep has no declared
cadence — whoever calls it decides — so claiming a slot would let a legacy
caller consume the slot the tick was going to use and silently cancel it.

**Move the schedule to `{"mode":"tick"}` and stop calling the old one.**

### `ORDENCE_INLINE_JOBS`

It is set on production, and `isInlineFallbackEnabled()` reads
`?? "1"` — so inline execution is **on by default even when unset**. With
no Cloudflare queue bound, and Railway binds none, every `enqueueJob()`
call runs its processor synchronously inside the caller's request.

For the scheduler that means the tick performs the contract-expiry scan
itself rather than handing it to a queue. That is correct, and it is
visible: the ledger row records `via: "inline"`. It also means the job's
declared budget governs real work, which is what the budget guard is for.

It is **not** a double-execution path. Inline is one execution in a
different place, and the slot claim is unchanged.

---

## Exactly once

Every scheduled slot is claimed with a single statement:

```sql
INSERT INTO scheduler_runs (job_id, subject_tenant_id, slot_at, …)
VALUES (…)
ON CONFLICT DO NOTHING
RETURNING id;
```

One caller gets a row and runs. Every other caller gets **zero rows** and
stands down. There is no `SELECT`-then-`INSERT` anywhere, because the
window between them is exactly the window in which two ticks both decide
the slot is free.

The guarantee is the partial unique index in 0129:

```sql
CREATE UNIQUE INDEX scheduler_runs_slot_uq
  ON scheduler_runs (job_id, subject_tenant_id, slot_at)
  NULLS NOT DISTINCT
  WHERE slot_at IS NOT NULL;
```

🔴 **`NULLS NOT DISTINCT` is load-bearing and it is one phrase.**
Platform-scoped jobs — `rate_limit_sweep`, `anomaly_detection` — carry
`subject_tenant_id = NULL`. Two NULLs are *not equal* in SQL, so without
that phrase the same slot conflicts with nothing and both ticks run it.
The index exists, the catalog says UNIQUE, and the guarantee is absent for
exactly the two jobs that sweep the whole platform.

`WHERE slot_at IS NOT NULL` keeps manual runs out of the claim: a "run
now" must never be refused because a scheduled run exists, and must never
consume a slot.

`SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0129a-concurrent-claim.sql` races two
real sessions for one slot. Measured on PostgreSQL 16: session B blocked
for 3,052 ms and returned zero rows. With the phrase removed, B did not
block at all (62 ms) and both sessions claimed.

---

## The control plane

### Pause one job, globally

`/jobs` → operate → **Disable job**. A reason of at least 20
characters is required by a CHECK constraint, not merely by the form.

A disabled job stops alarming *for thirty days*. After that the watchdog
treats it as an outage — a pause nobody has revisited in a month is not a
decision any more.

### Pause one workspace from one job

The case this will be asked for within a month of dunning going live: a
workspace in a billing dispute must be suspendable from collections
without disabling dunning for everybody. `job_id = '*'` pauses a workspace
from every job.

Pauses may carry an expiry. An expired pause stops suppressing — the
predicate is in `scheduler_pause_reason()` and 0130 executes both halves
of that, because a `expires_at` column nothing reads is how every
"hold until the 15th" becomes permanent.

Lifting a pause is an UPDATE, never a DELETE. The record of who paused a
workspace from statutory dunning, when, and why, is evidence.

### Run one workspace on its own cadence

`scheduler_tenant_schedules` — a cron expression plus an **IANA timezone
name**, not an offset. India does not observe daylight saving so the
difference is invisible here; it is the kind of invisible that surfaces
in production for the first workspace outside it. An unknown zone is
refused by a CHECK constraint.

### Overrun policy, declared per job

| Policy | What happens when the previous run is still going |
|---|---|
| `skip` | The slot is recorded as `skipped_overrun`, with the reason. Not run. |
| `queue` | The slot is claimed and left `claimed`; a later tick starts it. Nothing lost, nothing overlapping. |
| `kill` | The in-flight run is asked to stop, and this slot runs. |

🔴 **`kill` is cooperative, and saying so is the specification rather than
a caveat.** An HTTP handler in another container cannot be preempted from
here. `kill` sets `cancel_requested` on the in-flight ledger row; the
runner reads it at every workspace boundary and stops. So the previous run
ends within one workspace's work, not instantly — and a run wedged *inside*
one workspace is not stopped by this at all. That case is
`scheduler_reclaim_stale()`, which ends the claim once the heartbeat dies
(30 minutes). Shipping a `kill` that claimed to preempt and did nothing
would be instance twenty-four of this codebase's pattern.

### Budget guard

Every job declares `maxMs`. The scheduler owns the boundary *between
workspaces*, so a job that has burned its budget on workspace 3 does not
go on to workspace 4 — the remaining workspaces keep their slots unclaimed
and the next tick picks them up.

⚠️ **What it cannot do is stop work already inside `runScheduledJob`.**
A platform-scoped job is one opaque call; its budget can only be observed
after it returns, at which point the run is marked `budget_exceeded` and
the operator alerted. Making that real needs an `AbortSignal` on the
registry's job functions, which is another stream's file this wave. It is
in `PATCH-REQUEST-A.md`.

### Backfill and replay

A **missed** slot is one with no ledger row at all — the scheduler was
down. A **skipped** slot has a row saying why, and is deliberately *not*
offered for replay: offering it would mean an operator accidentally
undoing a colleague's pause by clicking Replay.

Replays run **oldest first** and stop at the first failure. Dunning is a
ladder: rung two is only correct if rung one was recorded, and replaying
Friday before Thursday would advance a workspace past a rung it never
received a letter for. There is no way to un-send the wrong notice.

Some jobs declare themselves not replayable, with the reason written
against them in `server/scheduler/policy.ts`. `workflow_maintenance` is
the clearest: its dispatcher advances `next_run_at` **from now** rather
than from the missed slot, so a four-hour outage fires each workflow once
on recovery — replaying the four missed slots would fire it four more
times, which is exactly what that design avoids.

### Run now

`run_kind = 'manual'`, `slot_at = NULL`. It never takes a slot, so a "run
now" at 19:29 cannot silently consume the 19:30 slot and cancel that
evening's real run. 0129 has a CHECK constraint refusing the row that
would do it — because this is the kind of rule obeyed by the code written
next to it and forgotten by the code written six months later.

Every hand-started run requires a justification of at least 20 characters,
enforced by the database, and lands in `platform_action_log` alongside the
run.

---

## The dead man switch

Every job declares how long it may be silent. The window is **derived from
the job's own cron**, never typed in: two full cadences plus fifteen
minutes, measured from the **worst** gap between consecutive slots.

Two cadences and not one, because a scheduled job legitimately misses a
slot — a deploy, a slow tick, a Railway restart — and an alarm that fires
on every one of those is an alarm that gets muted. Two consecutive misses
is a pattern.

The **worst** gap and not the typical one, because `rera_dunning_plan` is
`0 3 * * 1-5`: 24 hours Monday→Tuesday and **72 hours Friday→Monday**. A
window built from the typical gap alarms every single weekend, and an
alarm that cries wolf every Saturday is one somebody mutes on the third
Saturday.

The four ways this query is normally written wrong, all of them silent,
all of them executed as tests in 0131 Section 6:

1. `WHERE last_success < as_of - window` — **drops every job that has
   never succeeded**, because NULL fails the comparison. A job that has
   never run once reads healthy forever. That is the state this entire
   product was in.
2. Measuring the last **run** rather than the last **success** — a job
   failing every single night looks perfectly punctual.
3. Counting an in-flight run as a success — a job wedged at 06:00 keeps
   its `claimed` row and never alarms.
4. Not excluding retired jobs — the alarm never clears, so it gets muted.

And a fifth, found in this file's own first draft and left recorded in
0131 Section 6h2: with nothing overdue and no heartbeat at all,
`overdue = 0 AND (NULL <= 900)` evaluates to **NULL**, not false. A
response body carrying `ok: null` reads as "not false" to every monitor
that tests for false. A missing heartbeat is therefore mapped to an
infinitely stale value, never to NULL.

---

## Reading the ledger

```sql
-- Did dunning run last night?
SET app.platform_scope = 'on';
SELECT job_id, slot_at, state, finished_at - started_at AS took, error
  FROM scheduler_runs
 WHERE job_id = 'dunning_sweep'
 ORDER BY claimed_at DESC LIMIT 20;

-- What is overdue right now, and what breaks because of it?
SELECT job_id, ever_ran, silent_seconds / 3600 AS silent_hours, consequence
  FROM scheduler_overdue();

-- One row, for a monitor.
SELECT * FROM scheduler_watchdog_status();

-- Is anything holding a claim it is not using?
SELECT id, job_id, state, now() - heartbeat_at AS silent
  FROM scheduler_runs WHERE finished_at IS NULL;
```

⚠️ `SET app.platform_scope = 'on'` first, in every one of these. The
scheduler tables are FORCE ROW LEVEL SECURITY with a platform-scope
policy, so without it these queries return **zero rows and no error** —
which reads exactly like a clean database.

---

## The jobs calendar

`/jobs`. Read access is `observatory:read`, which every platform
grade holds: "did the dunning sweep run last night" is a question the
person answering the phone needs answered, and a console only engineers
can open is a console that gets screenshotted into chat. The write actions
are `flags:write`, which is engineer and owner and requires step-up.

🔴 **The page currently serves at `/jobs` and gates itself, and it is not
where this track's brief asked for it.** The brief named
`app/(platform)/admin/jobs/**`. That path cannot be used:
`tests/security/route-audit.test.ts:50` forbids the URL segments `admin`,
`debug`, `console` and `test` anywhere under `app/`, with a written
rationale — no default admin route should exist to be probed at all — and
a literal directory named `admin` fails it whether or not anything routes
there. Running the suite is what established this, not reading it.

And a Next.js route group in parentheses is stripped from the URL, so
`app/(platform)/jobs/` serves at `/jobs` — *not* under `/platform`.
`middleware.ts`'s `/platform(.*)` matcher does not cover it, the console
host rewrites it to a 404, and `app/platform/layout.tsx` does not wrap it.
The layout in that directory therefore performs the full
`getPlatformOperator()` check itself and 404s otherwise.

`PATCH-REQUEST-A.md` item 1 asks for the three-line change that moves it
to `/platform/jobs` with the middleware gate, the console chrome and a nav
entry. That is where it belongs.

---

## What is dormant and deliberately not scheduled

The calendar's last section, and `GET /api/workers` under `notScheduled`.
A control plane that lists only what it runs implies that what it runs is
everything. Six AI background workers exist at `/api/workers/ai-monitors`,
in no document, with **no entitlement gate at all** — scheduling them
would deliver paid capabilities nightly to workspaces that have not paid
for them. GSTR-2B reconciliation exists only as a permission-gated server
action and needs a `sweepGstr2bForTenant` split before a cron can hold it.
Licence renewal reminders and metering rollups do not exist to schedule.
Four more retention TTLs are stamped onto rows with no deleter anywhere.

Each is listed with a reason and a named owner. See `TRACK-REPORT.md`
section 4.

---

## When something is wrong

| Symptom | Where to look |
|---|---|
| Watchdog 503, "NO HEARTBEAT EVER" | The cron service does not exist, or has never reached `/api/workers`. Check `SCHEDULER_APP_URL` and `WORKER_API_SECRET` on it |
| Watchdog 503, "CLOCK IS SILENT" | The cron service exists and stopped. Railway → the cron service → Deployments |
| `/api/workers` answers 503 | No authentication configured on the **web** service. `WORKER_API_SECRET` is unset there |
| Tick returns 500, `tenantsNotReached > 0` | More active workspaces than `MAX_TENANTS_PER_JOB` (500). Raise it or split the schedule. It is red on purpose: a silent cap is a lie |
| Tick returns 500, `budgetExhausted: true` | The tick ran out of its four minutes. Work was left for the next tick, which is fine once and a problem every night |
| A job shows `NEVER` under last success | It has genuinely never succeeded. If it is in the maintenance lane, `MAINTENANCE_DATABASE_URL` is probably unset |
| Everything shows NEVER and the ledger is empty | 0129–0132 are applied but no tick has run, or they are not applied. `GET /api/workers?watchdog=1` distinguishes the two |
| A run is stuck in `claimed` or `running` | Its executor died. `scheduler_reclaim_stale()` marks it abandoned after 30 minutes; the next tick calls it |
| The catalog refuses to load (`/api/workers` 500 naming the catalog) | A job was added to a registry with no policy in `server/scheduler/policy.ts`, or a policy names a job that no longer exists. The message says which |

```bash
node server/scheduler/self-check.mjs
```

54 checks, no database, no network. Runs the cron parser and the
maintenance lane for real, and greps the source for the one-phrase
properties whose absence has no symptom.
