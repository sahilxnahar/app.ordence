# Durable delivery in Ordence — what exists, what does not, and what to trust

Track G · waves 16–17 · v1.83.0-alpha · reconciled against Track A's scheduler (SQL 0129–0132)

This document is about **side effects that must survive**: an email a customer
is owed, a webhook a tenant's system is waiting for, a job that must finish or
be picked up by the next container. It is deliberately short on architecture
and long on which claims are enforced by what.

---

## 1. The one-paragraph version

Ordence has **one** durable side-effect path, and it is email. A message is
written into `email_outbox` **inside the transaction that decided to send it**,
and a separate dispatcher delivers it with a claim lease, a bounded backoff, a
suppression check at send time, a dead-letter state that keeps its reason, and
provider-side idempotency so a crash between "sent" and "marked sent" does not
send twice. Everything else — background jobs, outbound webhooks, multi-step
sequences — has **no durability at all**: `enqueueJob()` writes to no table, and
a job lost between the producer and the consumer leaves no trace anywhere.

**Whether anything is on a clock is now measurable rather than unknown.** Track A
built the ledger, the controls and the watchdog; whether a scheduler actually
calls `/api/workers` in production is a deployment fact that A's own tables can
answer. See §5 and §8.

---

## 2. The parts, and where they live

| Part | File | Owns |
|---|---|---|
| The policy: statuses, retry vs dead-letter, backoff, suppression vocabulary | `lib/email/outbox.ts` | Pure. No I/O. The only copy of these rules. |
| The rules for turning a notification into outbox rows | `lib/email/notification-outbox.ts` | Pure. Keys, subject, recipient planning. |
| Who may call the provider at all | `lib/email/provider-callers.ts` | Pure. The ratchet — see §9. |
| The dispatcher: claim, send, write back, mirror | `server/email/outbox.ts` | The only thing that calls the provider. |
| The provider client | `lib/email/resend.ts` | The only `Resend` instance in the product. |
| The table | `db/schema/email.ts`, SQL `0097`, `0159`, `0160` | `email_outbox`, `email_suppressions`. |
| Bounce and complaint intake | `app/api/webhooks/resend/_webhook.ts` | Writes suppressions; Svix-verified. |
| The operator view | `app/platform/mail/page.tsx` | Platform staff only. **No tenant-facing view exists.** |
| The job transport | `lib/queue/jobs.ts`, `lib/queue/processors.ts` | Cloudflare Queues **or inline**. No table. |
| The scheduled work | `server/scheduling/registry.ts` | Eight jobs, as data. |
| The scheduler | Track A, SQL `0129`–`0132` | `scheduler_runs` and five sibling tables. See §8. |

---

## 3. The rules, and what actually enforces each one

This is the section to read before trusting anything above. The application
connects to Postgres as a role whose identity is currently **disputed** — this
track's brief says `neondb_owner`, which owns the tables, and
`RAILWAY-VARIABLES-PASTE.txt` says `ordence_app`, which does not. The two
answers give different verdicts on GRANTs and on row-level security, so every
rule below is listed with the mechanism that carries it.

| Rule | Enforced by | Holds against the table owner? | Holds against a `rolbypassrls` role? |
|---|---|---|---|
| A row marked `sent` carries a provider message id | CHECK (`0097`) | **yes** | **yes** |
| A queued row still has an attempt left | CHECK (`0159`) | **yes** | **yes** |
| A claimed row carries both `claim_token` and `claimed_at` | CHECK (`0160`) | **yes** | **yes** |
| `max_attempts >= 1` | CHECK (`0159`) | **yes** | **yes** |
| A terminal row carries its evidence (`sent_at`; `dead_at` + `last_error_code`) | CHECK (`0159`) | **yes** | **yes** |
| One row per `(tenant, idempotency_key)` | UNIQUE INDEX (`0097`) | **yes** | **yes** |
| A workspace reads only its own messages | RLS policy + FORCE (`0097`) | yes, **because of FORCE** | 🔴 **no** |
| Only one worker holds a row at a time | `FOR UPDATE SKIP LOCKED` + claim token | **yes** | **yes** |
| A suppressed address is not mailed | **application code only** (`server/email/outbox.ts`) | 🔴 no | 🔴 no |
| A retry does not double-send after a crash | **the provider** (Resend idempotency key) | n/a | n/a |
| Notification email cannot outlive a rolled-back transaction | **the transaction** | **yes** | **yes** |

🔴 **Read the two rows marked "application code only" as unprotected.** The
suppression check is a `SELECT` in a TypeScript function. Any future writer
that inserts into `email_outbox` and calls the provider itself goes around it,
and nothing in the database will say so. That is the shape this codebase keeps
finding, and it is named here rather than counted as done.

---

## 4. How to add a side effect that survives

1. **Write it in the transaction that decided it.** `enqueueEmail(tx, …)`
   takes the caller's transaction on purpose. If your side effect cannot be a
   row in a table the business change also writes, it is not durable and no
   amount of retry logic afterwards makes it so.
2. **Derive the idempotency key from what the message IS** — never from the
   clock, never from the attempt number, never from a UUID minted at send
   time. Two containers running the same sweep in the same millisecond must
   compute the same string, or the unique index cannot help them.
3. **Bound the key.** `idempotency_key` is `varchar(200)`. A key built from an
   address (`varchar(320)`) can overflow the column and fail the INSERT
   *inside the caller's transaction* — the delivery path destroying the thing
   it was delivering.
4. **Classify failures into three dispositions, not two.** `retry`, `dead`,
   and `defer`. The third is the one people miss: a deployment with no
   provider key configured must reschedule **without spending an attempt**, or
   an unconfigured environment dead-letters every message it was ever asked to
   send and then reports the queue as drained.
5. **Default an unrecognised failure to `retry`.** An unfamiliar error string
   is far more often a blip than a permanent refusal, and the attempt ceiling
   — now a CHECK constraint — stops it running forever.
6. **Never mark terminal-success without the provider's own identifier.**

---

## 5. The clock: what changed, and why the inline drain is still here

Wave 16 recorded that Railway ran one service with no scheduler attached, so
none of the eight jobs in `server/scheduling/registry.ts` ever ran — including
`mail_drain`. Track A has since delivered `scheduler_runs`,
`scheduler_job_controls`, `scheduler_job_expectations`,
`scheduler_tenant_schedules`, `scheduler_tenant_pauses` and
`scheduler_heartbeat`, with `scheduler_overdue` and `scheduler_watchdog_status`
on top.

**That is the ledger, the controls and the watchdog. It is not the clock.**
The wave-16 gap was a deployment configuration — something has to POST to
`/api/workers` on a schedule (`docs/current/CRON-RUNBOOK.md` Option A: a second
Railway service in the same project; Option B: an external scheduler). A's
tables make the absence *measurable*, which it was not before. They do not make
the call.

### 🔴 So: is today the day to delete the bounded immediate drain? No.

`createNotification()` still calls `dispatchTenantOutbox` once, bounded, after
its transaction commits. Three things have to be true before that call is
deleted, and every one of them is now checkable against Track A's own tables
rather than being a matter of opinion:

1. **`scheduler_runs` contains `mail_drain` rows with a `finished_at`, on its
   cron, in production.** Not "a scheduler exists" — evidence that this job
   ran. `scheduler_heartbeat` showing recent rows is the weaker version of the
   same question. Deleting the drain before that re-creates the failure
   `lib/email/outbox.ts` opens with: a queue with no drain is not a deferred
   send, it is a deletion with a receipt.
2. **A cadence somebody has accepted.** `mail_drain`'s cron decides how long a
   `critical` notification waits. Today it leaves immediately. An hourly drain
   means a workspace's critical alert can sit for an hour, and that is a
   product decision, not an implementation detail. It belongs in
   `scheduler_job_expectations`, with `scheduler_overdue` wired to alarm when
   it is missed.
3. **The pause semantics settled.** See §8.3: the inline drain does not consult
   `scheduler_tenant_pauses`, so a paused workspace still gets notification
   mail. That is an argument *for* deleting the drain — but doing it before (1)
   and (2) trades a pause that does not pause for mail that does not send,
   which is worse.

When all three hold: delete `drainAfterCommit` and the `dispatchTenantOutbox`
import from `server/notifications/create.ts`, and say in the commit message
that `mail_drain` is now genuinely scheduled. Nothing else has to change — the
outbox row was always the guarantee and the drain was always only latency.

---

## 6. What does not exist, stated so nobody looks for it

- **Durable job records.** `enqueueJob()` mints an in-memory id and either
  calls a Cloudflare Queues binding or runs the processor inline in the
  caller's request. Nothing is written to Postgres. A job lost in transit
  leaves no trace. (Track A's `scheduler_runs` records *scheduled* runs; this
  is the separate `lib/queue/` path.)
- **Outbound webhooks.** None. No subscription, endpoint, secret or
  delivery-attempt table; no HMAC signing of any outgoing request anywhere in
  the repository. Inbound is mature and verified: Clerk, Resend, Stripe,
  Razorpay, and the tenant-connector intake. Roadmap Phase 71.
- 🔴 **`dispatchWebhook()` in `server/workflows/dispatch.ts:443` has zero call
  sites.** The workflow "webhook" trigger type mints and rotates a secret token
  (`server/actions/workflows.ts:131-165`) for an HTTP endpoint that does not
  exist — no route consumes it. A tenant can configure a webhook trigger, be
  shown a token, and wait forever. Built and unreachable, and recorded here
  because a finding that lives only in a track report is a finding that gets
  re-discovered.
- **Compensation for multi-step work.** No step declares how to undo itself.
- **Per-tenant fair queueing.** The sweep loops over up to 500 workspaces and
  drains up to 50 messages each — bounded, but the order is arbitrary and there
  is no fairness under contention. Track A's `scheduler_tenant_schedules` is
  the natural place for this to become real.
- **A tenant-visible delivery ledger, and dead-letter replay.** The console at
  `app/platform/mail` is platform staff only, and read-only.
- **A poison-pill guard for jobs.** The outbox has an attempt ceiling
  (`0159`); the `lib/queue/` path has nothing equivalent.

---

## 7. The interface Track G assumed, and what Track A actually built

Wave 16 wrote the assumption down rather than building into A's territory.
This is the reconciliation, kept because an assumption that is never checked is
just a guess with better manners.

**What was assumed:** *"a scheduled job is a `{ id, scope, runForTenant |
runPlatform }` entry in a registry, invoked over HTTP with a shared secret, and
a run either completes or is retried whole. Nothing in Track G depends on a run
ledger, an advisory lock or an overlap guard existing."*

**What was wanted:** *"one row per drain attempt — job id, workspace, started,
finished, claimed/sent/deferred/dead counts — so 'did the letters go out last
night' is answerable without opening the console, and so a drain that stopped
running is visible as an absence rather than as silence."*

### Where it agreed

- **Jobs are still registry entries keyed by id.** `scheduler_job_controls` and
  `scheduler_job_expectations` are per-job-id, which is the shape
  `server/scheduling/registry.ts` already had and the shape assumed.
- **Nothing in Track G depended on the ledger existing, and nothing broke when
  it arrived.** That was the point of the assumption and it held.
- **The wanted thing exists, and more of it than was asked for.**
  `scheduler_runs` is the per-run record; `scheduler_job_expectations` plus
  `scheduler_overdue` and `scheduler_watchdog_status` are the "visible as an
  absence rather than as silence" half, which was written as a wish and came
  back as three objects.

### Where it did not agree

- 🔴 **"A run either completes or is retried whole" is wrong.**
  `scheduler_reclaim_stale` means a run is *claimed and reclaimable*: it can
  stop half-way and be picked up again. For `mail_drain` that is harmless —
  every message is claimed individually and carries a provider idempotency key,
  so re-running the drain re-does nothing. But the sentence as written would be
  wrong for any future job that is not row-idempotent, and it should not be
  quoted back as though it were a guarantee.
- **Per-tenant cadence and pause were not assumed at all.**
  `scheduler_tenant_schedules` and `scheduler_tenant_pauses` are genuinely new
  surface, and they are where the two systems actually interact. §8.

---

## 8. The two notions of "claim", and where they interact

Both systems have a claim. They are **different objects at different
granularities, and they nest** — A claims a *run of a job*, the outbox claims a
*message row*. Neither is wrong, and they must not be unified.

| | Track A | the outbox |
|---|---|---|
| What is claimed | a run, in `scheduler_runs` | one row of `email_outbox` |
| Recovery from a dead worker | `scheduler_reclaim_stale` — run it again | `reclaimExpiredClaims()` — re-offer the row with an attempt spent |
| What makes recovery safe | the drain is idempotent | **the same idempotency key on every attempt**, so the provider deduplicates |
| The lease | A's threshold | `CLAIM_LEASE_MS` = **10 minutes** |

A single lease covering both would be worse in both directions: A would have to
wait out a ten-minute mail lease before re-running a job whose worker is
already dead, and the outbox would re-offer a row that a live worker still
legitimately owns.

### 8.1 The two staleness windows are unrelated numbers — say so out loud

`CLAIM_LEASE_MS` is **10 minutes**. If A's run-stale threshold is shorter, a
second `mail_drain` run can start while the first still legitimately owns rows.
That is *safe* — `claimBatch()` only takes rows in `queued`, under
`FOR UPDATE SKIP LOCKED`, so the second run simply finds less work — but it
writes a `scheduler_runs` row reporting few or zero messages claimed. A
watchdog tuned on throughput rather than on completion could read that as "the
drain is doing nothing". Whoever sets A's threshold should know that ten
minutes is the number on the other side.

### 8.2 🔴 A paused workspace never reclaims a stranded message

`reclaimExpiredClaims()` is called at the top of `dispatchTenantOutbox()` and
is scoped by `tenant_id`. **The only thing that reclaims a workspace's
abandoned rows is that workspace's own next drain.**

So a workspace paused in `scheduler_tenant_pauses` does not reclaim. A row left
in `sending` by a container that died mid-send stays there for the length of
the pause — outside `0159`'s ceiling, which constrains `queued` only, and
invisible to `scheduler_watchdog_status`, which watches runs and not rows.
A's pause is a new way to reach an old hole.

`0160` closes the *permanently* unrecoverable version of this state: a
`sending` row missing `claim_token` or `claimed_at` can no longer be written at
all, because `reclaimExpiredClaims()` compares `claimed_at < cutoff` and
`NULL < timestamptz` is NULL, so such a row would never be reclaimed by the one
query written to rescue it. The *temporarily* stranded row still needs a
reclaim that does not depend on the paused workspace's own drain.
`PATCH-REQUEST-G.md` §7 carries the query; it belongs in
`server/email/outbox.ts`, which Track G does not own.

### 8.3 🔴 The inline drain does not consult `scheduler_tenant_pauses`

An operator who pauses a workspace stops `mail_drain` for it — and
`createNotification()`'s post-commit drain still sends that workspace's
notification mail. A pause that does not pause.

This is the sharpest argument for deleting the inline drain, and it is why §5
lists pause semantics as one of the three conditions rather than as a footnote.
The alternative — teaching the notification path to read one of A's tables —
creates a coupling between two tracks' modules that neither owns, and it should
not be done unilaterally.

---

## 9. The ratchet: who may call the mail provider

`lib/email/provider-callers.ts` is the list, as data, with a reason per entry.
`lib/email/proofs/provider-callers.proof.ts` re-derives it from the repository
and fails in both directions: a caller that is not on the list is a regression,
and a listed caller that no longer exists is progress that has not been
recorded.

**Four modules still send without the outbox** — `server/actions/contracts.ts`,
`server/actions/portal.ts`, `server/platform/impersonation.ts`,
`server/workflows/effects.ts`. Every one of them sends unsuppressed, unretried
and unrecorded. The number may only fall.
