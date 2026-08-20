# Ordence — Service Level Objectives

Version: v1.82.0-alpha · Wave 14 · Track B
Source of truth: `server/observability/slo.ts`. This document restates it in
prose; `check:observability-callers` fails the build if the two disagree on an
objective's id, target or window.

---

## 0. Why there are four and not fourteen

An SLO is a promise with a price. Four promises that somebody will actually
argue about beat fourteen that nobody reads, and every one below is measured
from a table this product already writes — or is honestly reported as
**unmeasured**, which is the third state and the most important one.

**An SLO without an error budget and a written consequence for exhausting it is
a wish.** Every objective here has both. The consequence is a rule, not advice.

### The three states

| State | Meaning |
|---|---|
| **MET** | Measured over enough observations, and at or above target. |
| **BREACHED** | Measured, and below target. The budget is gone or going. |
| **UNMEASURED** | Not enough data, or the recorder is not running. |

🔴 **UNMEASURED is never rendered as healthy.** A ratio over an empty
denominator is `0/0`; reporting it as 100% is how a stopped recorder reads as a
perfect service. This repository has found that shape twenty-three times across
twelve audits — a coverage check written `count(*) >= 10 THEN 'PASS'` for a
property that needed to hold on 303 tables and passed at 48; a CI gate whose
skip path exited `0`; three observability modules with no callers whose
dashboards were all green because green meant "no data has ever arrived here".
`evaluateSlo()` refuses to produce a ratio below each objective's
`minimumSample`, and `server/observability/health.ts` probes every table with
`to_regclass` before reading it.

### Where the numbers come from

| Table | Created by | Carries |
|---|---|---|
| `request_outcomes` | SQL 0133 | Per-workspace, per-route, per-minute counts and a cumulative latency histogram. **The denominator.** |
| `error_events` | SQL 0011 | Server and browser exceptions, fingerprinted. |
| `email_outbox` | SQL 0097 | Queued mail and its terminal delivery status. |
| `observability_alerts` | SQL 0135 | Every alert raised, its runbook, its suppressions and its acknowledgement. |
| `scheduler_runs` + `scheduler_job_expectations` | **Track A** | The run ledger and the declared cadence. `scheduler_overdue()` is the authoritative answer to "which jobs are late". |

Before wave 14 there was no denominator at all. Errors were recorded in three
places and successes in none, so "what fraction of requests succeeded" had no
answer and could not be derived — and the missing denominator defaults to
green.

---

## 1. `app.availability` — The authenticated app answers

> **99.5% of authenticated requests over 30 days complete without a server
> error.**

| | |
|---|---|
| Target | 99.5% |
| Window | 30 days, rolling |
| Error budget | **3 hours 36 minutes** (216 minutes) |
| Minimum sample | 1,000 requests |
| Measured by | `request_outcomes`: `outcome = 'failed'` against `outcome IN ('ok','failed')`, `kind = 'http'` |

**What is excluded, and why.** `invalid` (4xx) and `denied` (401/403) are not
counted: a customer sending a bad request is not an outage, and counting it
would make a stricter validator look like a regression. `throttled` (429) is
also excluded — a rate limiter doing its job would otherwise burn the budget
every time it worked, and the remedy an on-call would reach for is to loosen the
limiter. `kind = 'job'` is excluded because a nightly sweep failing for every
workspace and a page failing for every user are the same count of failures and
two entirely different incidents.

**Why 99.5% and not 99.9%.** One Railway service, one region, a Neon Free-tier
database, no scheduler until this wave, no multi-region anything. 99.9% would be
a number nobody could hold and everybody would learn to ignore. 216 minutes is
roughly one bad deploy plus one Neon cold-start incident — a number that will
actually be spent, noticed and argued about.

**Consequence when the budget is exhausted.** Feature work stops. The next
deploy may contain only reliability fixes, and the burn is reviewed before any
release goes out. Exhausting this budget in two consecutive windows moves the
region/replica decision from the roadmap to the sprint.

**Runbook (`slo-availability`).** Open `/platform/reliability` and read the
**per-tenant** table before the total. One workspace at 40% among two hundred
healthy ones is a data problem in that workspace; a flat rise across all of them
is the platform. Then group `error_events` by `fingerprint` over the same
window — the top fingerprint is usually the whole incident. If it appeared with
the last deploy, roll back before diagnosing.

**Escalate if** the burn rate is above 14.4x for a full hour, or any single
tenant is above 25% for fifteen minutes.

---

## 2. `route.latency_p95` — The ten hottest routes stay quick

> **In 99% of five-minute buckets over 30 days, p95 latency on each of the ten
> busiest routes is at or below 800 ms.**

| | |
|---|---|
| Target | 99% of buckets compliant |
| Threshold | p95 ≤ 800 ms |
| Window | 30 days, rolling |
| Error budget | **432 minutes** — 86 non-compliant five-minute buckets |
| Minimum sample | 288 buckets (one day) |
| Measured by | The cumulative histogram in `request_outcomes`, grouped into five-minute windows per `route_pattern` |

**Why buckets and not a single p95.** A month-wide p95 is one number that hides
every bad afternoon inside a good month. Bucketing asks "how often was it bad",
which is what a person experiences.

**Why the ten busiest routes and not all of them.** Averaging across every route
lets a hundred fast health checks hide one slow page, and the slow page is the
product.

**How p95 is read.** Off the cumulative histogram — the smallest bucket edge at
or below which 95% of observations fall. When the 95th percentile is above the
last edge (5,000 ms), `p95FromHistogram()` returns **null** and the surface
renders `> 5000 ms`. It does not interpolate: interpolating past the last edge
invents a number, and the number it invents is always reassuringly close to the
last edge.

**Consequence.** The slowest route by budget spend gets an owner and a written
plan before the next planning cycle. If one route is responsible for more than
half the spend it is capped or paginated, not optimised in place.

**Runbook (`slo-latency`).** Identify which route, then find the statement: the
trace id travels into Postgres in a `sqlcommenter` comment
(`/*traceparent='00-…'*/`), so the query can be found by trace id rather than
guessed. If every route moved at once it is the database, not the code — check
whether Neon's compute suspended and resumed, which shows as a uniform
multi-second step across unrelated routes.

**Escalate if** p95 is above 5 seconds on any route for more than fifteen
minutes.

---

## 3. `mail.delivery` — Mail we accepted actually leaves

> **99.0% of messages the product queues over 30 days are accepted by the
> provider.**

| | |
|---|---|
| Target | 99.0% |
| Window | 30 days, rolling |
| Error budget | **432 minutes**, i.e. 1 in 100 messages |
| Minimum sample | 200 terminal messages |
| Measured by | `email_outbox.status`: `dead` against `status IN ('sent','dead')` |

🔴 **This objective is UNMEASURED until SQL 0133-era prerequisites are met, and
the reason is instructive.** `SQL-FILES/0127` exists because
`0087_hardening_narrow_grants.sql` revoked `UPDATE` on the dunning log while
`0083` had explicitly documented that the delivery columns must stay mutable.
The same class of defect is why this objective cannot be trusted before 0127 is
applied *and* a delivery result has actually been written back: a `status`
column that can never be updated reports every message as `queued` forever,
which produces a sample of zero — and a sample of zero is reported here as
unmeasured, never as 100%.

**Consequence.** Below target, outbound campaigns are paused before
transactional mail is touched: an invoice that does not arrive costs a customer
money, a newsletter that does not arrive costs nothing. Sustained failure means
the sending domain's reputation is investigated before any code is changed.

**Runbook (`slo-mail`).** Check the provider's own status page first — a Resend
outage is not a code defect and the queue drains on its own. If the provider is
healthy, read `last_error_message`: a concentration on one recipient domain is a
reputation problem; a spread across every domain is an API key or a quota.

**Escalate if** invoices or password resets are among the failures.

---

## 4. `job.cadence` — Scheduled work runs when it says it does

> **In 99% of checks over 30 days, no scheduled job is outside its declared
> cadence window.**

| | |
|---|---|
| Target | 99% |
| Window | 30 days, rolling |
| Error budget | **432 minutes**, i.e. 1 check in 100 |
| Minimum sample | 100 checks |
| Measured by | `scheduler_overdue()` — Track A's own answer — observed by each sweep and recorded into `request_outcomes` under `kind='job'`, route `/jobs/scheduler.cadence` |

**🔴 `scheduler_overdue()` is read, never recomputed.** Track A's scheduler
holds the declared cadence in `scheduler_job_expectations` and already answers
"which jobs have not run inside their window". Deriving lateness a second time
from `scheduler_runs` would give this page its own definition of overdue — one
that agrees with Track A's for a while and then quietly disagrees, with the
untested one on the status board. `server/observability/health.ts` reads only
`count(*)` from the function, so a change to what it *returns* cannot break this
page; the single thing it depends on is that a row means an overdue job.

**Why the sample is checks and not runs.** `scheduler_overdue()` answers a
question about *now*, not a thirty-day history. Turning it into a rate without
recomputing lateness means recording what each sweep saw: one observation per
check, `ok` when nothing was overdue, `failed` when something was. The cost,
stated: the objective is **unmeasured** until the sweep has run 100 times —
about a day at a fifteen-minute cadence — and it is unmeasured whenever
`scheduler_overdue()` is absent or has grown an argument list. Unmeasured is the
honest answer for a window nothing observed.

**Probed by name, not by guess.** The first version of this probe tried
`scheduled_job_runs`, `job_runs`, `cron_runs` and `scheduler_runs` and took the
first that existed. Three of those never existed. A probe that guesses will one
day match a table belonging to something else and report its rows as job health.
The six tables it now looks for are Track A's: `scheduler_runs`,
`scheduler_job_controls`, `scheduler_job_expectations`,
`scheduler_tenant_schedules`, `scheduler_tenant_pauses`, `scheduler_heartbeat`.

**Why this matters more than it sounds.** `server/scheduling/registry.ts` was
written because six functions — the dunning sweep, workflow maintenance, anomaly
detection, rhythm recomputation, storage reconciliation and dunning planning —
existed, were correct, were tested, and were called by nothing at all.

**Consequence.** A job that is overdue in two consecutive checks is disabled
rather than left to retry. A job that silently half-runs is worse than one that
is visibly off.

**Runbook (`slo-jobs`).** Ask whether the scheduler is **running** before asking
why a job is late — `scheduler_heartbeat` and `scheduler_watchdog_status()`
answer that, and "nothing has run at all" is a different incident from "one job
is slow". Then read `scheduler_overdue()` itself rather than this page: it names
the jobs. If a job is per-tenant, check `scheduler_tenant_pauses` before assuming
it is broken — a paused workspace is a decision somebody made, and
`scheduler_pause_reason()` says who and why.

**Escalate if** the dunning sweep or the storage reconciliation has been overdue
across two checks. Both move money or quota, and both are silent when they do not
run.

---

## 5. Burn rate and when somebody is woken up

A burn rate of `1.0` means the budget lasts exactly the window. `14.4x` over one
hour spends 2% of a 30-day budget in that hour.

| Window | Burn rate | Meaning | Action |
|---|---|---|---|
| 1 hour | ≥ 14.4x | 2% of a 30-day budget in one hour | Page somebody |
| 6 hours | ≥ 6x | 5% of a 30-day budget in six hours | Look today, not now |

These are the Google SRE Workbook's multi-window thresholds, used unmodified.
The arithmetic behind them does not depend on our traffic, and inventing our own
numbers would be inventing our own answer to "how long may we not notice" — a
question the literature has already answered well.

**A floor on volume.** No burn rate is computed from fewer than 100 requests in
the window. Two failures out of three at 4am is a 66% failure rate, a 133x burn
rate, and also three requests. Paging for it is how an alert channel gets muted.

---

## 6. Every alert has a runbook, and the database enforces it

`observability_alerts.runbook_key` is `NOT NULL` with a length `CHECK`. There is
no code path that can raise an alert without naming the paragraph that says what
to do about it — TypeScript enforces the key, and the database enforces it again
on the day somebody reaches for a cast during an incident.

The eight runbooks live in `server/observability/alerts.ts` and are rendered on
the status surface beside the objective they belong to:

| Key | Fires when |
|---|---|
| `slo-availability` | The availability budget is burning fast |
| `slo-latency` | A hot route's p95 has moved |
| `slo-mail` | Queued mail is not being accepted |
| `slo-jobs` | Scheduled work is missing its cadence |
| `tenant-error-rate` | One workspace is failing far more than the rest |
| `security-event-unrecorded` | A CRITICAL security event could not be written down |
| `anomaly-detected` | The anomaly sweep found something |
| `recorder-stalled` | The recorder itself has stopped writing |

**Rate limiting is in Postgres, not in memory.** One `INSERT … ON CONFLICT DO
UPDATE … RETURNING (xmax = 0)` decides whether a raise is delivered or counted.
`lib/security/rate-limit.ts` has warned since Phase 20 that per-instance memory
counters are a speed bump — on a serverless deployment the effective limit is
`limit × instances` — and wave 8 found that had been literally true of the
authentication limiter for the life of the deployment. A `Map` here would have
been that defect a third time, in the file whose whole job is to not flood a
channel.

There is also a hard global ceiling of **12 delivered messages per ten
minutes**, counted in the database across every instance. Suppressed raises are
still recorded; only the delivery is skipped. A channel with fifty messages in
it is a channel nobody reads, at the moment it matters most.

---

## 7. What is deliberately not an SLO

- **Uptime of the marketing site.** It is static and its failure costs nothing
  a customer notices.
- **Anything measured by a third party's dashboard.** Cloudflare's graphs answer
  "is the platform up" and stop there, because one Worker served every tenant
  and Cloudflare does not know tenants exist.
- **Storage durability.** R2's own guarantee is stronger than anything we could
  measure, and measuring it badly would produce a number weaker than the truth.
- **Database time per tenant.** Not recorded anywhere. It is reported as
  unmeasured on the cost panel rather than approximated from request wall-clock,
  which is a different quantity — see `server/observability/cost.ts`.
