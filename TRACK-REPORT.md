# TRACK-REPORT — Track G, wave 17

Against `1.81.0-alpha` + Track G's wave-16 delivery · reconciled with Track A's
scheduler (SQL 0129–0132) from integration's written description.

Eight files. **§0 is the answer to the two questions wave 17 asked**; everything
after it is the work that came out of answering them.

| | wave 16 result | now |
|---|---|---|
| `node scripts/run-gates.mjs static` | 23/24 | **23/24** — only `check:migrations`, see below |
| `node scripts/check-rls-coverage.mjs` | pass | **pass** — 303 tenant tables enabled, forced, policied |
| `node scripts/check-sql-executes.mjs` | pass | **pass** |
| `rm -f tsconfig.tsbuildinfo && npx tsc --noEmit` | exit 0 | **exit 0** |
| `npx vitest run` | 249 files · 7,940 passed · 2 failed · 8 skipped | **identical** |
| Track G proofs | 3 files, 29 claims | **4 files, 40 claims**, all green |

⚠️ Two caveats on those numbers, both about my local tree rather than the code.

- **`check:migrations` reports 30 gaps (0129–0158) here and is green in the
  assembled tree.** My container holds `1.81.0-alpha` plus Track G only; the
  other six tracks' files are not in it. `0160` is `max + 1` within my block
  and integration reported 26/26 after assembly.
- **The two `tests/ui/wave13-tooling.test.ts` failures are the ones integration
  has already fixed.** My local copy predates that fix. They are the same two
  assertions, failing for the same reason, and they are not a new regression —
  the count is identical to wave 16's.

---

## 0. The two answers

### 0.1 The two notions of "claim" do **not** disagree — and they must not be unified

They are different objects at different granularities, and they nest. Track A
claims **a run of a job** in `scheduler_runs`; the outbox claims **one message
row** in `email_outbox`.

| | Track A | the outbox |
|---|---|---|
| Recovery from a dead worker | `scheduler_reclaim_stale` — run it again | `reclaimExpiredClaims()` — re-offer the row, an attempt spent |
| What makes recovery safe | the drain is idempotent | the **same idempotency key on every attempt**, so the provider deduplicates |
| The lease | A's threshold | `CLAIM_LEASE_MS` = **10 minutes** |

Neither is wrong. A single lease covering both would be worse in both
directions: A would wait out a ten-minute mail lease before re-running a job
whose worker is already dead, and the outbox would re-offer a row a live worker
still legitimately owns. They compose — A's reclaim is the outer loop that
causes the drain to run again, which is what makes the inner reclaim fire.

**But looking for the disagreement found two real things.**

**(a) The staleness windows are unrelated numbers, and nothing says so.**
`CLAIM_LEASE_MS` is 10 minutes. If A's threshold is shorter, a second
`mail_drain` run starts while the first still owns rows. That is *safe* —
`claimBatch()` only takes `queued` rows under `FOR UPDATE SKIP LOCKED`, so the
second run simply finds less work — but it writes a `scheduler_runs` row
reporting few or zero messages claimed, and a watchdog tuned on throughput
rather than on completion reads that as a drain doing nothing. Question for A
in `PATCH-REQUEST-G.md` §7.2.

**(b) 🔴 A paused workspace never reclaims a stranded message.**
`reclaimExpiredClaims()` is called at the top of `dispatchTenantOutbox()` and is
scoped by `tenant_id` — **the only thing that recovers a workspace's abandoned
claims is that workspace's own next drain.** `scheduler_tenant_pauses` is a new
way to reach that: a paused workspace does not drain, so a row left in `sending`
by a container that died stays there for the length of the pause. It is outside
`0159`'s ceiling, which constrains `queued` only, and invisible to
`scheduler_watchdog_status`, which watches runs and not rows.

Chasing that produced `0160` and `PATCH-REQUEST-G.md` §1. See §2 below.

### 0.2 Delete the bounded immediate drain? **No — not today.**

Track A delivered the **ledger**, the **controls**, the **expectations**, the
**heartbeat** and the **watchdog**. None of those is the clock. The wave-16 gap
was a deployment configuration — something has to POST to `/api/workers` on a
schedule (`docs/current/CRON-RUNBOOK.md` Option A: a second Railway service;
Option B: an external scheduler). A's tables make the absence **measurable**,
which it was not before. They do not make the call.

**What has to be true first — three conditions, and every one is now a query
against Track A's own tables rather than a matter of opinion:**

1. **`scheduler_runs` contains `mail_drain` rows with a `finished_at`, on its
   cron, in production.** Not "a scheduler exists" — evidence that *this job*
   ran, authenticated, against the real deployment. Deleting the drain before
   that re-creates exactly what `lib/email/outbox.ts` opens by describing: a
   queue with no drain is not a deferred send, it is a deletion with a receipt.
2. **A cadence somebody has accepted, recorded in
   `scheduler_job_expectations`, with `scheduler_overdue` wired to alarm when
   it is missed.** `mail_drain`'s cron decides how long a `critical`
   notification waits. Today it leaves immediately; an hourly drain means an
   hour. That is a product decision, not an implementation detail, and nobody
   has made it yet.
3. **The pause question settled** — §0.1(b) and `PATCH-REQUEST-G.md` §2.

**And the third condition is the one that argues for deletion**, so it is worth
stating plainly rather than burying: the inline drain does **not** consult
`scheduler_tenant_pauses`. An operator who pauses a workspace stops `mail_drain`
for it and `createNotification` keeps sending. A pause that does not pause.

That is a reason to remove the call, not a reason to teach it to read another
track's table. But removing it before conditions 1 and 2 hold would trade a
pause that does not pause for **mail that does not send**, which is worse. So it
stays, and the reason it stays is now written at the call site with the exit
criteria beside it.

**Track G will make that deletion in one commit the day integration confirms
conditions 1 and 2 — it is four lines and an import.** `docs/JOBS.md` §5 is the
checklist.

---

## 1. The wave-16 assumption, reconciled

`docs/JOBS.md` §7 said: *"a scheduled job is a `{ id, scope, runForTenant |
runPlatform }` entry in a registry, invoked over HTTP with a shared secret, and
a run either completes or is retried whole. Nothing in Track G depends on a run
ledger, an advisory lock or an overlap guard existing."*

**Agreed:**

- Jobs are still registry entries keyed by id — `scheduler_job_controls` and
  `scheduler_job_expectations` are per-job-id, the shape
  `server/scheduling/registry.ts` already had.
- Nothing in Track G depended on the ledger existing and **nothing broke when
  it arrived**. That was the entire point of writing the assumption down
  instead of building into A's territory, and it held.
- What §7 *wanted* — one row per drain attempt, so a drain that stopped running
  is visible as an absence rather than as silence — came back as three objects
  rather than one: `scheduler_runs`, plus `scheduler_job_expectations` with
  `scheduler_overdue` and `scheduler_watchdog_status`. More than was asked for.

**Did not agree:**

- 🔴 **"A run either completes or is retried whole" is wrong.**
  `scheduler_reclaim_stale` means a run is claimed and *reclaimable*: it can
  stop half-way and be picked up again. For `mail_drain` that is harmless —
  every message is claimed individually and carries a provider idempotency key,
  so re-running the drain re-does nothing. But the sentence would be wrong for
  any future job that is not row-idempotent, and it should not be quoted back
  as a guarantee. Corrected in `docs/JOBS.md` §7.
- **Per-tenant cadence and pause were not assumed at all.**
  `scheduler_tenant_schedules` and `scheduler_tenant_pauses` are genuinely new
  surface, and they turned out to be where the two systems actually interact —
  §0.1(b) and §0.2. The assumption was not wrong here so much as silent, and
  the silence is what nearly hid the reclaim gap.

---

## 2. Files changed or added

| File | New/changed | What, and why |
|---|---|---|
| `SQL-FILES/0160_email_outbox_claim_is_complete.sql` | **new** | A row in `sending` must carry both `claim_token` and `claimed_at`. Without both it is permanently stranded — see §3. |
| `lib/email/provider-callers.ts` | **new** | The ratchet as data: who may call the mail provider, one reason per entry, plus a pure `diffProviderCallers()` so the assertion is one call. Wave 17 asked for the list to be kept and made to shrink; a list in a report is a list that gets re-discovered. |
| `lib/email/proofs/provider-callers.proof.ts` | **new** | Re-derives that list from the repository. Fails in **both** directions — §4.2. |
| `server/notifications/proofs/outbox-ceiling.proof.ts` | changed | Six new claims for `0160`, including the stranding demonstrated rather than asserted. Two existing probes repaired — `0160` caught them. §4.1. |
| `server/notifications/create.ts` | changed | **Comment only, no behaviour change.** `drainAfterCommit` now carries the wave-17 reasoning and the three exit conditions, so the next person to read it finds out why it survived Track A rather than deleting it as a leftover. |
| `docs/JOBS.md` | changed | §5 rewritten (the clock, and the deletion checklist), §6 (`dispatchWebhook()` recorded permanently), §7 (the reconciliation), §8 (new — the two claims and where they interact), §9 (new — the ratchet). `0160` added to the enforcement table in §3. |
| `PATCH-REQUEST-G.md` | rewritten | Two new items, three carried forward with the exact code, two questions for Track A. |
| `TRACK-REPORT.md` | rewritten | This. |

**Nothing was written to `server/jobs/**`, `lib/outbox/**` or
`server/webhooks/**`.** `mirrorToSubject()`, the four direct senders,
`db/schema/core.ts` and `tests/**` were **not touched** — per the wave-17
correction, the findings are Track G's to carry, the files are not.

---

## 3. The SQL

**`0160_email_outbox_claim_is_complete.sql`** — the only migration.
`0161`–`0165` unused. Creates no table, column, index, policy or grant. Adds one
CHECK to `public.email_outbox`:

```
status <> 'sending' OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
```

**Why that state is worse than "invalid data".** A `sending` row missing either
column is a message somebody is owed that **nothing will ever look at again**,
and three separate mechanisms miss it for three different reasons:

1. `reclaimExpiredClaims()` (`server/email/outbox.ts:432`) selects
   `status = 'sending' AND claimed_at < <cutoff>`. **`NULL < timestamptz` is
   NULL, not true** — the one query written to rescue an abandoned claim skips
   the row it was written for.
2. `writeBack()` names `claim_token` in its WHERE clause — correctly, so a
   worker whose lease expired cannot stamp a stale verdict. But a NULL token
   matches nothing, so no worker can complete it either.
3. `0159` bounds `queued` and describes the terminal states. It says nothing
   about `sending`, deliberately: a claimed row has not had its attempt counted,
   and covering it there would refuse the last legitimate attempt of every
   message in the queue.

Not queued, not sent, not dead, not reclaimable, not writable, and invisible to
`scheduler_watchdog_status`, which watches runs and not rows.

**Why a migration when no code path produces it today.** `claimBatch()` is the
**only** writer of `status = 'sending'` in the repository — verified by grep
across `server/`, `lib/`, `app/`, `db/` and `SQL-FILES/`; the other matches are
`campaigns.status`, a different table — and it sets all three columns in one
UPDATE. This file is what makes "while that stays true" a fact instead of a
hope. A support fix, a back-fill, a restore that drops a column default, or a
second claimer written by somebody who has not read the comment all produce the
stranded row, and none of them would be told.

**Why a CHECK and not a grant or a policy.** The wave-16 ruling: a REVOKE binds
only a role that does not own the table, and a policy binds the owner only under
FORCE and not at all under `rolbypassrls`. A CHECK is evaluated by the executor
for every write by every role. §4.1 shows the refusal happening **as the table
owner**, and in the same run shows RLS not binding that role.

**Order relative to the code push: either.** This file ships with no behavioural
code change at all.

Safety: no `BEGIN`/`COMMIT`; two statements, each independently re-runnable and
verified twice one-statement-per-connection; **no DML**, so nothing here can be
refused by a FORCE RLS policy; additive only. The ADD is preceded by a count of
violating rows and raises with that count **plus the repair instruction** —
`claimed_at` older than the lease and a fresh `claim_token` puts them back in
reach of `reclaimExpiredClaims()`, which re-offers each with the same
idempotency key so the provider deduplicates any that did already go out. On
this table a violating row is a real customer message, and "delete the bad
rows" would be the wrong advice.

---

## 4. Proofs, and what was broken to confirm each

Four proofs now, 40 claims, each one command. Both new disproofs were actually
run; outputs are quoted.

### 4.1 `0160` binds the owner, and the row it refuses really is stranded

```
npx tsx server/notifications/proofs/outbox-ceiling.proof.ts
```

17 claims, all green. The six new ones:

> ✅ a 'sending' row with no claim_token is REFUSED — no worker could ever write it back
> ✅ a 'sending' row with no claimed_at is REFUSED — the reclaim query could never match it
> ✅ 🔴 as the TABLE OWNER (and superuser): the incomplete claim is refused by the same constraint
> ✅ POSITIVE CONTROL — a properly claimed row is ACCEPTED
> ✅ 🔴 the row 0160 refuses IS a stranded message: it exists, and the real reclaim query cannot see it
> ✅ the constraint is intact after the demonstration rolled back

**The fifth is the one that makes `0160` worth a migration.** Refusing a row
proves the constraint works; it does not prove the row was dangerous. So the
proof drops the constraint *inside a transaction*, inserts the row it would have
refused, and runs **the real reclaim predicate** — the same
`status = 'sending' AND claimed_at < cutoff` the dispatcher uses — against it.
The row exists (`exists=1`) and the reclaim query cannot see it
(`reachableByReclaim=0`). DDL is transactional in Postgres, so the constraint is
never absent outside that transaction and no row survives it; the sixth claim
confirms the constraint came back validated.

**Disproof.** `email_outbox_claim_is_complete_check` was dropped and the
identical command re-run:

```
🔴 0159's three and 0160's one CHECK constraint exist and are VALIDATED
🔴 a 'sending' row with no claim_token is REFUSED — no worker could ever write it back
🔴 a 'sending' row with no claimed_at is REFUSED — the reclaim query could never match it
🔴 🔴 as the TABLE OWNER (and superuser): the incomplete claim is refused by the same constraint
🔴 the proof could not run: error: constraint "email_outbox_claim_is_complete_check" of
   relation "email_outbox" does not exist
```

Four claims red, and then the run aborts — because §6b tries to DROP a
constraint that is already gone. The abort is itself evidence: the
demonstration cannot be faked without the thing it demonstrates. Re-applied
with `scripts/run-sql-statement-per-connection.mjs` (one statement per
connection, the Neon console's behaviour, run twice): `ALL STATEMENTS
SUCCEEDED`, and the proof went green again.

**⚠️ `0160` caught two of my own probes on the day it applied.** Both
`proof:sending` and `proof:zero-max` were written for `0159` as `status:
"sending"` with no claim columns — which is precisely the stranded state — and
went red the moment the constraint existed. They now carry a complete claim, and
the comment at each says so. A constraint whose first victim is the test suite
that was meant to check it is a constraint that was needed.

### 4.2 The ratchet matches the repository

```
npx tsx lib/email/proofs/provider-callers.proof.ts
```

Walks `app/`, `components/`, `lib/`, `server/` and `db/`, matches **import
statements only** (`from "<module>"` / `import("<module>")`, never a mention in
prose — several files name the provider correctly while warning against it), and
compares the result with `PERMITTED_PROVIDER_CALLERS`. `lib/email/` is excluded
because the provider and the catalogue both live there, and a catalogue that
appears in its own scan is `check:reachability`'s problem one layer down.

Green, and it prints the number wave 17 asked to be kept:

```
  4 module(s) still send without the outbox:
    · server/actions/contracts.ts
    · server/actions/portal.ts
    · server/platform/impersonation.ts
    · server/workflows/effects.ts
```

**Disproof, direction one — a fifth caller.** A `sendEmail` import was added to
`server/notifications/create.ts`:

```
  🔴 🔴 no module calls the mail provider that is not on the list
     NEW DIRECT CALLER(S): server/notifications/create.ts
     Each one bypasses the suppression list, the attempt ceiling, the retry
     schedule and the delivery record. Route it through enqueueEmail() in
     server/email/outbox.ts, or add it to PROVIDER_CALLERS with an honest reason.
🔴 1 claim(s) FAILED.        EXIT=1
```

**Disproof, direction two — the list over-stating.** One entry was renamed so
the repository no longer matched it:

```
  🔴 🔴 no module calls the mail provider that is not on the list
  🔴 ⭐ every listed caller still exists, so the ratchet is not over-stating the problem
🔴 2 claim(s) FAILED.
```

Both restored: green. **The second direction is deliberate.** A list that
silently over-states the problem stops being believed, and a ratchet is only
worth having while the number is trusted.

Two guards keep it honest: a vacuous-pass check that the walk read more than
500 files (a broken walk agrees with any list), and a check that the pattern
found any importer at all.

### 4.3 Unchanged and re-run

`npx tsx lib/email/proofs/notification-outbox-rules.proof.ts` — 12 claims green.
`npx vitest run --config server/notifications/proofs/vitest.proofs.config.ts` —
5 passed. Neither was touched this wave; both re-run clean against the new
constraints, which is itself worth knowing: `0160` did not disturb the
notification path.

---

## 5. Found and not fixed

New this wave:

1. 🔴 **A paused workspace never reclaims a stranded message.** §0.1(b). The fix
   is a platform-scoped reclaim that does not depend on the paused workspace's
   own drain, plus a registry entry to call it. Both files are outside the
   block. `PATCH-REQUEST-G.md` §1 carries the query — deliberately the same
   statement as the per-tenant version minus the tenant predicate, so the
   recovery rule does not fork.
2. 🔴 **The inline drain ignores `scheduler_tenant_pauses`.** §0.2.
   `PATCH-REQUEST-G.md` §2, with both ways to settle it and a recommendation.
3. **`prune_scheduler_runs` may be the `prune_security_events` shape again.** If
   it is `SECURITY DEFINER` and `EXECUTE` is granted to `ordence_app`, the web
   application can delete its own scheduler history — which is what
   `0121_revoke_prune_from_app_role.sql` exists to undo for security events,
   after `0087` re-granted it while restoring a list of signatures. Question for
   A, `PATCH-REQUEST-G.md` §7.1. I have not seen A's SQL and am not asserting it
   is wrong; the shape is common enough to be worth one query.

Carried, unchanged and still true:

4. **Four modules still call the provider directly** — now a ratchet with a
   proof rather than a note. §4.2.
5. **`mirrorToSubject()` does not know `subject_type = 'notification'`** —
   `PATCH-REQUEST-G.md` §3 now carries the exact columns, the CHECK that stops
   `emailed_at` and `email_failure_reason` contradicting each other, and the
   third branch, including the subtlety that one notification has many
   recipients so `emailed_at` means first-delivery.
6. **`dispatchWebhook()` has zero call sites** — a tenant can configure a
   workflow webhook trigger, be shown a rotating token, and wait forever for an
   endpoint that does not exist. Wave 17 asked for this to be written somewhere
   that survives a report: it is now `docs/JOBS.md` §6, which is in the block
   and ships with the product.
7. **`tests/setup.ts` has never been typechecked** — `tsconfig.json` excludes
   `tests`. Five latent `TS2532`s. `PATCH-REQUEST-G.md` §5.
8. **No tenant-facing delivery view or dead-letter replay.**
   `PATCH-REQUEST-G.md` §6 — now with the trap noted: a replay must **not**
   reuse the original idempotency key, or Resend returns the original message id
   and the replay button reports success while delivering nothing.

---

## 6. Decided under uncertainty

**6.1 The inline drain stays, and the decision is written at the call site.**
The easy read of wave 17 is "A landed, so delete it". Track A delivered the
ledger and the watchdog, not the clock, and I have no evidence any scheduler is
attached in production — only that its absence is now measurable. Deleting on
the strength of "a scheduler exists somewhere" would be the same class of
mistake as the wave-16 brief's "Track A has landed". So it stays, with three
falsifiable conditions and an offer to remove it in one commit.

**6.2 One migration, not seven.** `0161`–`0165` unused. `0160` exists because
chasing the claim question found a state that is unrecoverable by construction.
Nothing else this wave needed schema, and wave 17 cautioned against volume.

**6.3 The ratchet went in `lib/email/`, not into a test.** `tests/**` is not in
the block, so the assertion cannot ship — but the *data* can, and putting it in
a pure module means the eventual test is one call to `diffProviderCallers()`
rather than a hardcoded array in another track's file that drifts from reality.
The proof script re-derives it today; the test inherits it later.

**6.4 `predicate-only` is a third category, not an omission.**
`app/(crm)/contracts/[id]/page.tsx` imports `isEmailEnabled` and sends nothing.
It could have been left off the list. It is on it, classified, because the
import is what a future edit turns into a send without anybody noticing a line
was crossed.

**6.5 I did not teach `createNotification` to read `scheduler_tenant_pauses`.**
It would fix the pause-that-does-not-pause today, in a file I own. It would also
create a dependency from `server/notifications/**` on a Track A table that
neither track agreed to, and it makes the eventual deletion of the inline drain
harder rather than easier. Written up as a choice for integration instead.

**6.6 I answered A's shape from integration's description without seeing the
code.** Every claim in §0 and §1 about *Track G's* side is proven against the
running database. Every claim about *A's* side is derived from the table and
function names integration supplied, and is phrased so that it can be checked
rather than assumed — which is why §7 of the patch request is two questions and
not two assertions.

---

## 7. What integration must do

1. **Confirm or deny the two conditions in §0.2.** If `scheduler_runs` shows
   `mail_drain` completing on its cron in production and a cadence is accepted,
   say so and Track G deletes `drainAfterCommit` next round.
2. **Decide the pause semantics** — `PATCH-REQUEST-G.md` §2. Doing neither
   leaves a control that reports success and does nothing.
3. **Ask Track A the two questions** in `PATCH-REQUEST-G.md` §7.
4. `0160` may run before or after the code push. Expect `check:migrations` red
   in isolation and green in the assembled tree.
5. Move the four proofs per `PATCH-REQUEST-G.md` §4 and delete
   `server/notifications/proofs/` and `lib/email/proofs/`. The provider-callers
   test is the ratchet — when a module moves onto the outbox, delete its entry
   from `PROVIDER_CALLERS` rather than widening the assertion.
