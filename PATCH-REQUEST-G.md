# PATCH-REQUEST-G

Track G · wave 17 · v1.83.0-alpha

Wave 16's items 1 and 3 are **done** — integration replaced the two
`tests/ui/wave13-tooling.test.ts` assertions and accepted the argument for
deleting the unreachable sender. Items 2, 4, 5 and 6 are carried forward
below, updated where Track A's arrival changed them, plus two new ones.

Ordered by urgency.

---

## 1. 🔴 NEW — a stranded `sending` row is only reclaimed by its own workspace's next drain

**The defect.** `reclaimExpiredClaims()` (`server/email/outbox.ts:409`) is
called at the top of `dispatchTenantOutbox()` and is scoped by `tenant_id`. So
the only thing that ever recovers a workspace's abandoned claims is that
workspace's own next drain.

Track A's `scheduler_tenant_pauses` makes that reachable in a new way: a paused
workspace never drains, so a row left in `sending` by a container that died
mid-send stays there for the length of the pause. It is outside `0159`'s
ceiling, which constrains `queued` only, and invisible to
`scheduler_watchdog_status`, which watches runs and not rows.

`0160` (this delivery) closes the *permanently* unrecoverable version — a
`sending` row missing `claim_token` or `claimed_at` is now unwritable, because
`claimed_at < cutoff` is NULL for such a row and the one query written to
rescue it would skip it forever. The *temporarily* stranded row still needs a
reclaim that does not depend on the paused workspace's own drain.

**Wanted, in `server/email/outbox.ts`** (Track G does not own it) — a
platform-scoped reclaim, callable from a scheduled job:

```ts
/**
 * Reclaim abandoned claims across every workspace, not just one.
 * Runs under withPlatformScope because a workspace that is paused, deleted or
 * simply idle never runs its own drain — and its stranded rows are exactly the
 * ones nobody is coming back for.
 */
export async function reclaimStrandedClaimsEverywhere(now = new Date()) {
  const cutoff = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
  return withPlatformScope("Reclaim outbox claims a dead worker left behind", (tx) =>
    tx.execute(sql`
      UPDATE email_outbox
         SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'queued' END,
             attempts = attempts + 1,
             next_attempt_at = ${now.toISOString()}::timestamptz + interval '1 minute',
             dead_at = CASE WHEN attempts + 1 >= max_attempts
                            THEN ${now.toISOString()}::timestamptz ELSE dead_at END,
             claim_token = NULL,
             last_error_code = 'claim_expired',
             last_error_message = 'A worker claimed this message and never reported back. Reclaimed by the platform sweep; it is offered again with the same idempotency key, so no second copy is delivered.'
       WHERE status = 'sending'
         AND claimed_at < ${cutoff}::timestamptz
      RETURNING id, tenant_id
    `),
  );
}
```

It is deliberately the same statement as the per-tenant version minus the
tenant predicate — the recovery rule must not fork.

**And a `platform`-scope entry in `server/scheduling/registry.ts`** so it has a
caller. Suggested `id: "outbox_reclaim"`, `consequenceWhenStopped:` "a message
claimed by a container that died is never offered again, and no screen says
so", `idempotency:` "the UPDATE is conditional on the lease having expired, so
two concurrent runs cannot both reclaim the same row."

⚠️ **Do not merge this into `mail_drain`.** `mail_drain` is per-tenant and
entitlement-gated; the whole point of this one is that it must run for
workspaces whose scheduled work is off.

---

## 2. 🔴 NEW — settle the pause semantics for notification mail

`createNotification()` performs a bounded drain after its transaction commits
(`server/notifications/create.ts`, `drainAfterCommit`). It does **not** consult
`scheduler_tenant_pauses`. An operator who pauses a workspace stops
`mail_drain` for it, and that call keeps sending. **A pause that does not
pause.**

Two ways to settle it, and the choice is integration's because it spans tracks:

- **Preferred — delete the inline drain.** That is the end state `docs/JOBS.md`
  §5 describes, and it needs the three conditions there to hold first:
  `mail_drain` rows in `scheduler_runs` with a `finished_at`; an accepted
  cadence in `scheduler_job_expectations`; and `scheduler_overdue` wired to
  alarm. Track G will make that deletion in one commit the day integration
  confirms them — it is four lines and an import.
- **Otherwise — teach the drain to read the pause table.** This creates a
  dependency from `server/notifications/**` on a Track A table. Track G has not
  done it unilaterally for that reason.

Doing neither leaves a control that reports success and does nothing, which is
this codebase's signature defect.

---

## 3. `mirrorToSubject()` does not know `subject_type = 'notification'`

Carried from wave 16 item 4, now with the exact change. `server/email/outbox.ts`
mirrors a delivery outcome back onto the record that asked for the message — for
`dunning_event` and `credit_dunning_log` — and returns quietly for anything
else. A notification's outbox row records the outcome; the `notifications` row
never learns it, so the in-app feed cannot say "we emailed you about this, and
it bounced".

**Two columns on `notifications`** (`db/schema/core.ts`, and a migration
numbered from whoever owns that file — **not** from Track G's block):

```ts
/** When the outbox confirmed the provider accepted this notification's email. */
emailedAt: timestamp("emailed_at", { withTimezone: true }),
/**
 * Why it did not arrive. Set only on a terminal failure — a retry in progress
 * is not a failure and must not put a red line on the feed.
 */
emailFailureReason: varchar("email_failure_reason", { length: 500 }),
```

```sql
ALTER TABLE public.notifications
    ADD COLUMN IF NOT EXISTS emailed_at            timestamptz,
    ADD COLUMN IF NOT EXISTS email_failure_reason  varchar(500);

-- ⚠️ The pair must not contradict each other: a notification cannot both have
--    been delivered and carry a failure reason.
ALTER TABLE public.notifications
    ADD CONSTRAINT notifications_email_outcome_check
    CHECK (emailed_at IS NULL OR email_failure_reason IS NULL);
```

**The third branch in `mirrorToSubject()`**, before the
`credit_dunning_log` branch:

```ts
if (row.subjectType === "notification" && row.subjectId) {
  /*
   * ⚠️ ONE NOTIFICATION, MANY RECIPIENTS. Each recipient has its own outbox
   * row pointing at the same subject_id, so this runs once per recipient.
   * `emailed_at` is therefore FIRST-DELIVERY, not all-delivered — the honest
   * reading of "we emailed you about this". A per-recipient view is the
   * outbox itself, filtered by subject_id.
   */
  await tx
    .update(notifications)
    .set(
      outcome.delivery === "sent"
        ? { emailedAt: outcome.at, emailFailureReason: null }
        : { emailFailureReason: (outcome.reason ?? "The send did not succeed.").slice(0, 500) },
    )
    .where(and(eq(notifications.id, row.subjectId), eq(notifications.tenantId, tenantId)));
  return;
}
```

⚠️ A `suppressed` outcome must reach the second branch, not be treated as
success: the address is deliberately not being mailed, and the feed should say
so rather than showing a blank that reads like nothing has happened yet.

---

## 4. Move Track G's proofs into `tests/`, and delete the delivery vehicle

Carried from wave 16 item 2, updated for the two new proofs. `tests/**` is not
in Track G's ownership block, so the proofs ship as runnable scripts and one
throwaway vitest config **inside** the block. Move them, then delete
`server/notifications/proofs/` and `lib/email/proofs/` in the same commit.

| Ship as | Move to | One-line assertion |
|---|---|---|
| `lib/email/proofs/notification-outbox-rules.proof.ts` | `tests/ui/notification-outbox-rules.test.ts` | The pure planner: keys are derived from the message and fit `varchar(200)`; one shared mailbox yields one row whose retained user id does not depend on input order; `info` does not email. |
| `lib/email/proofs/provider-callers.proof.ts` | `tests/ui/provider-callers.test.ts` | The set of modules importing the provider module equals `PERMITTED_PROVIDER_CALLERS` exactly — `diffProviderCallers(actual)` returns empty `added` **and** empty `removed`. |
| `server/notifications/proofs/notification-outbox.proof.test.ts` | `tests/security/notification-outbox.test.ts` | `createNotification` writes one `email_outbox` row per recipient in its own transaction; a failed transaction leaves neither the notification nor the email; a globally suppressed address ends `suppressed`; an unconfigured provider defers without spending an attempt. |
| `server/notifications/proofs/outbox-ceiling.proof.ts` | `tests/security/outbox-constraints.test.ts` | `0159`'s three and `0160`'s one CHECK constraint refuse their bad rows **as the table owner as well as** as `ordence_app`, with positive controls; the row `0160` refuses is demonstrably invisible to the real reclaim query; and RLS does not bind the owner while the CHECKs do. |
| `server/notifications/proofs/vitest.proofs.config.ts` | *delete* | — |

The moved files should use `asTenant` / `asSuperuser` from `tests/setup.ts`
rather than the local `pg` helpers they carry — those exist only to keep
`tests/setup.ts` out of the TypeScript program (see §5).

⚠️ **`tests/ui/provider-callers.test.ts` is the ratchet and should be treated
as one.** When a module moves onto the outbox, the correct change is to delete
its entry from `PROVIDER_CALLERS` — not to widen the assertion.

---

## 5. `tsconfig.json` excludes `tests`, so `tests/setup.ts` has never been typechecked

Carried unchanged from wave 16 item 3. `"exclude": ["node_modules", "tests"]`
means importing `@/tests/setup` from anywhere else drags it into the program,
where it does not compile:

```
tests/setup.ts(601,24): error TS2532: Object is possibly 'undefined'.
tests/setup.ts(602,25): error TS2532: Object is possibly 'undefined'.
tests/setup.ts(603,19): error TS2532: Object is possibly 'undefined'.
tests/setup.ts(620,52): error TS2532: Object is possibly 'undefined'.
tests/setup.ts(620,66): error TS2532: Object is possibly 'undefined'.
```

Five `noUncheckedIndexedAccess` violations in the file that decides whether the
security suite is pointed at a throwaway database. Entirely latent.

---

## 6. A tenant-facing delivery view, and dead-letter replay

Carried from wave 16 item 5. `app/platform/mail/page.tsx` is platform staff
only and read-only. Three lines of Track G's Definition of Done — "dead letter
queue visible and re-drivable", "a delivery log the tenant can inspect and
replay", "a delivery ledger the tenant can see" — are user interface, and
`app/**` and `components/**` are in no Track G list.

`readOutboxForConsole()` already returns the rows. What is missing is a
tenant-scoped screen and a re-drive action that records the replay **as a
distinct event, never as a fresh one**.

⚠️ A replay must not reuse the original `idempotency_key`. Resend deduplicates
on it and would return the original message id without sending anything — a
replay button that reports success and delivers nothing.

---

## 7. Two questions for Track A

Neither blocks Track G. Both are cheaper to answer now than to discover later.

1. **Is `EXECUTE` on `prune_scheduler_runs` granted to `ordence_app`?** If it is
   `SECURITY DEFINER` and grantable, it is the same shape as
   `prune_security_events`, which `0121_revoke_prune_from_app_role.sql` exists
   to undo: `0087` re-granted it while restoring a long list of signatures, and
   the application could delete six months of security evidence. A retention
   function the web application can call is a retention policy the web
   application can bypass. `scripts/sealed-grants.json` is where the answer
   belongs if the answer is "no".
2. **What is `scheduler_reclaim_stale`'s threshold, in minutes?** The outbox's
   `CLAIM_LEASE_MS` is **10 minutes**. They are unrelated numbers and should
   stay unrelated — but if A's is shorter, a second `mail_drain` run starts
   while the first still legitimately owns rows, and writes a `scheduler_runs`
   row reporting few or zero claimed. A watchdog tuned on throughput rather
   than on completion would read that as a drain doing nothing. `docs/JOBS.md`
   §8.1.
