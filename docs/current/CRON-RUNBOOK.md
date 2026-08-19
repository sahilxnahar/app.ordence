# Ordence, the scheduled work and how to make it run

**Repo: `app.ordence`. No SQL. Code push only, in any order.**

GENERATED from `server/scheduling/registry.ts` by
`scripts/generate-cron-runbook.mjs`. Do not edit by hand;
`npx vitest run --project=ui` compares the two.

## The thing to understand first

Railway runs ONE service for Ordence and that service has no
scheduler attached to it. Until something calls the endpoints
below on a clock, every job in this document does not run, and
nothing in the product says so: the screens keep working, the
collections board keeps showing what it showed yesterday, and the
customer keeps not receiving the reminder.

Railway's own cron feature RESTARTS A SERVICE on a schedule. That
is the wrong shape for a web service that never exits, so do not
attach it to `app.ordence` itself. Two options that work:

**Option A, a second Railway service.** Same repository, same
project, a Cron Schedule set on it, and a start command that
POSTs and exits. It shares the project's variables, so
`WORKER_API_SECRET` is already there.

**Option B, an external scheduler.** cron-job.org, GitHub Actions,
Upstash QStash. `/api/workers` already verifies a QStash signature
if you would rather not hold a bearer token in a third party.

Option A keeps the secret inside Railway and is the recommendation.

## Before any of it works

`WORKER_API_SECRET` must be set in Railway. Generate it on your own
machine and paste only into Railway:

```
openssl rand -hex 32
```

With no secret configured `/api/workers` answers **503** and
refuses to run anything. That is deliberate. An unauthenticated
worker endpoint is worse than no worker endpoint: it would let a
stranger drive background work against any workspace.

Check what the deployment thinks it has:

```bash
curl -fsS -H "Authorization: Bearer $WORKER_API_SECRET" \
  https://app.ordence.com/api/workers
```

That lists every job below, straight out of the running code. If
this document and that response ever disagree, the response is
right.

## The jobs

Every call is the same shape. Only `jobId` changes.

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"dunning_sweep"}'
```

**`-f` is not optional.** Without it `curl` exits 0 on an HTTP 500,
so a run in which every workspace failed reports green to whatever
is watching. With it, a partial failure is a non-zero exit and a
red tick.

| Job id | Runs | Cron (UTC) | In IST | Entitlement |
|---|---|---|---|---|
| `dunning_sweep` | Advance the collections ladder | `30 19 * * *` | 01:00 IST every day | `sales.orders` |
| `mail_drain` | Send what the outbox is holding | `5 * * * *` | five minutes past every hour | none, deliberately |
| `workflow_maintenance` | Fire, resume and expire tenant workflows | `*/15 * * * *` | every fifteen minutes | `workflows.scheduled` |
| `rhythms` | Recompute who is about to order and who has gone quiet | `0 20 * * *` | 01:30 IST every day | `crm.contacts` |
| `storage_reconcile` | Recount stored bytes from the documents table | `45 20 * * 0` | 02:15 IST on Monday morning | `storage.documents` |
| `rera_dunning_plan` | Report which RERA demand notices are due for a rung | `0 3 * * 1-5` | 08:30 IST on weekdays | `sales.receivables` |
| `rate_limit_sweep` | Delete expired rate limit windows | `7 * * * *` | seven minutes past every hour | platform, not a customer plan |
| `anomaly_detection` | Run the five security detectors across the perimeter | `*/30 * * * *` | every thirty minutes | platform, not a customer plan |

Cron expressions are UTC because every scheduler is. India is
UTC+5:30, so `30 19 * * *` is 01:00 the next morning in Bengaluru.

### `dunning_sweep`, Advance the collections ladder

Scope: every entitled workspace.

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"dunning_sweep"}'
```

**Schedule:** `30 19 * * *` UTC, which is 01:00 IST every day.

**What a red tick means:** The collections ladder does not advance. No credit_dunning_log row is written, so no reminder is queued, so nothing is sent and no credit hold is placed. A statutory demand notice that was never swept is a notice that was never served, and the provider message id that constitutes proof of service under Indian law is never obtained.

**Why running it twice is safe:** The insert is ON CONFLICT DO NOTHING against credit_dunning_log_once_per_stage_key and only the rows RETURNING gives back earn a letter, so a second run in the same day queues nothing. Credit holds are ON CONFLICT DO NOTHING against the one-active-hold index. The outbox row carries the fixed key dunning:<row id>.

### `mail_drain`, Send what the outbox is holding

Scope: every entitled workspace.

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"mail_drain"}'
```

**Schedule:** `5 * * * *` UTC, which is five minutes past every hour.

**What a red tick means:** Nothing leaves the building. Queued dunning letters, RERA demand notices and every other transactional message stay in email_outbox with delivery 'queued', and a message whose first send failed is never retried. This is also the only thing that writes a provider message id back onto the row it came from, so it is the only thing that can turn 'we recorded a reminder' into 'we can prove we sent one'.

**Why running it twice is safe:** dispatchTenantOutbox claims rows with an atomic FOR UPDATE SKIP LOCKED and a claim token. A row already claimed by a running worker is invisible to a second one; a claim from a worker that died is reclaimed by expiry and re-offered WITH THE SAME idempotency key, so the provider de-duplicates rather than sending twice.

**Runs for every workspace regardless of plan:** The outbox holds work that a gated feature already authorised. Refusing to drain it would not withhold a capability, it would strand statutory notices that the product has already recorded as queued.

### `workflow_maintenance`, Fire, resume and expire tenant workflows

Scope: every entitled workspace.

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"workflow_maintenance"}'
```

**Schedule:** `*/15 * * * *` UTC, which is every fifteen minutes.

**What a red tick means:** Every tenant-configured scheduled workflow stops. Nothing fires on its schedule, nothing that is waiting resumes, and an approval request nobody answered stays open forever holding its run's cursor. The workflow builder keeps accepting schedules and none of them mean anything.

**Why running it twice is safe:** dispatchScheduled claims a due workflow with UPDATE ... WHERE next_run_at = <the value it read>, so exactly one of two concurrent dispatchers changes the row. next_run_at advances from now rather than from the missed slot, so a four-hour outage fires each workflow once on recovery and not four times. executeRun claims the run and returns 'skipped' when it cannot, so a second pass performs no effect twice.

### `rhythms`, Recompute who is about to order and who has gone quiet

Scope: every entitled workspace.

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"rhythms"}'
```

**Schedule:** `0 20 * * *` UTC, which is 01:30 IST every day.

**What a red tick means:** The /rhythms board reads what was computed and nothing computes. Both halves of the feature go dark: the nudge that a regular customer is due, and the more valuable half, the customer who ordered every month for two years and has not ordered for seven weeks. No task is raised, so nobody calls them.

**Why running it twice is safe:** The rhythm row is an upsert keyed on (tenant, subject_type, subject_id) and always replaces rather than patches. The signal is ON CONFLICT DO NOTHING against an occurrence key that is the expected date for a due signal and the calendar month for a lapse, so a second run the same day raises no second signal and therefore creates no second task.

### `storage_reconcile`, Recount stored bytes from the documents table

Scope: every entitled workspace.

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"storage_reconcile"}'
```

**Schedule:** `45 20 * * 0` UTC, which is 02:15 IST on Monday morning.

**What a red tick means:** Stored-bytes metering drifts upward after every bulk delete and never comes back. The customer is billed against, and quota-limited by, a number that is too high. Five comments in server/metering name this function as the corrective and nothing called it.

**Why running it twice is safe:** It is a recomputation, not an increment: SUM(size_bytes) over the tenant's live documents is written as the level. Running it a hundred times writes the same value a hundred times. It never throws, a workspace it cannot compute returns null and is reported as failed rather than silently counted as done.

### `rera_dunning_plan`, Report which RERA demand notices are due for a rung

Scope: every entitled workspace.

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"rera_dunning_plan"}'
```

**Schedule:** `0 3 * * 1-5` UTC, which is 08:30 IST on weekdays.

**What a red tick means:** Nobody is told which allottees have fallen due for the next rung of the statutory ladder, so the letters are sent when somebody happens to look. The rungs themselves are NOT sent by this job and must not be.

**Why running it twice is safe:** It writes nothing. It is a read of demand_notices joined against the configured policy, so a hundred runs produce a hundred identical reports and change no row.

### `rate_limit_sweep`, Delete expired rate limit windows

Scope: the whole platform, one run.

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"rate_limit_sweep"}'
```

**Schedule:** `7 * * * *` UTC, which is seven minutes past every hour.

**What a red tick means:** rate_limit_counters grows without bound. One row per key per window, on every guarded request, forever. The table is on the critical path of every rate-limited route, so the first symptom is not a disk warning but every login getting slower. Nothing else deletes from it.

**Why running it twice is safe:** It deletes rows whose expires_at has passed, up to a bounded batch. Running it twice deletes nothing the second time. It never touches a live window: expires_at is set to two windows out, so a request that started inside a window still finds its row. Deleting a row that should not have been deleted would reset one counter to zero, which is why the batch is bounded and the predicate is time rather than count.

### `anomaly_detection`, Run the five security detectors across the perimeter

Scope: the whole platform, one run.

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"anomaly_detection"}'
```

**Schedule:** `*/30 * * * *` UTC, which is every thirty minutes.

**What a red tick means:** Five detectors report nothing: failed-login bursts, permission-denial spikes, portal-token sharing, off-hours bulk export and rate-limit pressure. An anomaly detector that never runs is indistinguishable from one that always passes, and the unattributed perimeter rows, forged signatures, unknown portal tokens, pre-session limiter trips, are seen by nothing else in the product.

**Why running it twice is safe:** It reads a rolling two-hour window and records findings with noCoalesce. Two runs thirty minutes apart over overlapping windows can record the same ongoing burst twice, and that is the intended behaviour for an aggregate: suppressing the second row would drop the second distinct finding of the same rule in the same window, which is precisely when two networks are brute-forcing at once. It acts on nothing, locks nobody out and revokes no token, so a duplicate finding costs a duplicate row and nothing else.

## Reading a response

```json
{
  "ok": true,
  "jobId": "dunning_sweep",
  "tenantsConsidered": 12,
  "tenantsRun": 9,
  "tenantsSkipped": 3,
  "tenantsFailed": 0,
  "notReached": 0
}
```

`tenantsSkipped` is not a failure. A workspace whose plan does not
include the capability is skipped on purpose, and each skipped row
says which entitlement it was.

`notReached` is the one to watch. The endpoint runs at most 500
workspaces per call. If there are more, the extra ones are counted
here and `ok` is **false**, so the run goes red rather than
reporting that it swept everything. When that number stops being
zero, either raise `MAX_TENANTS_PER_JOB` or split the schedule.

`tenantsFailed` above zero also makes `ok` false, and each failed
row carries its own error. One broken workspace does not stop the
others: the loop carries on and reports.

## Re-running one workspace

```bash
curl -fsS -X POST https://app.ordence.com/api/workers \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"scheduled","jobId":"dunning_sweep","tenantId":"<uuid>"}'
```

Safe at any time. Every job in the table is idempotent, and the
reason is written against each one above.

## The two endpoints that were already there

### `/api/workers` with `{"mode":"cron"}`

The original nightly sweep. It enqueues a contract-expiry scan per
workspace and drains the mail outbox. Keep it if you are already
running it; the `mail_drain` job above does the outbox half on its
own hourly schedule, and running both is harmless because the
outbox claim is atomic.

### `/api/cron/canary`, the isolation probe

```bash
curl -fsS -X POST https://app.ordence.com/api/cron/canary \
  -H "Authorization: Bearer $CRON_SECRET"
```

Suggested schedule: `0 * * * *`, hourly.

**This one uses `CRON_SECRET`, not `WORKER_API_SECRET`.** It is a
different secret on purpose: the canary's response names real
workspace ids, and it should not be reachable with the token that
a cron runner holds for everything else.

Three answers, and only one of them is green:

- **200** a real cross-tenant read was attempted and returned
  nothing, on a connection that could not have bypassed row-level
  security. This is the expected answer today: production connects
  as `ordence_app` with `rolbypassrls = f`.
- **500** it returned something. This is a P0. Every workspace can
  potentially read every other workspace's data.
- **503** the probe could not put itself in a position to prove
  anything. **This is not green.** It is what you get when the
  database role bypasses row-level security, and the fix is the
  role in `DATABASE_URL`, never a setting that downgrades this to
  a 200.

A green tick from a connection that bypasses row-level security is
the worst outcome available here. It is believed, and it is
evidence of nothing.

## What is still not wired

`sendDunningNotice` in `server/actions/receivables.ts` sends one
rung of a RERA statutory demand ladder, and nothing calls it. It is
deliberately NOT on a schedule: the permission depends on the rung,
and a cancellation warning needs a key the accountant who does
every other collections task does not hold, because that letter
precedes terminating an allotment and forfeiting what a family has
paid towards a home. A cron holds no permission at all, so putting
it on a clock would not be running it as somebody with the right;
it would be removing the right from the design.

The `rera_dunning_plan` job above reports which notices have come
due. Acting on that report needs a screen, and that screen does not
exist yet.

