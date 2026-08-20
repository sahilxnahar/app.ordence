-- ############################################################################
-- 0160 , A CLAIMED MESSAGE MUST CARRY ITS CLAIM
--        (Track G / wave 17 / v1.83.0-alpha)
-- ############################################################################
--
-- PURPOSE
-- -------
-- 🔴 A ROW IN `sending` WITH A NULL `claimed_at` OR A NULL `claim_token` IS
--    PERMANENTLY STRANDED. Not reclaimable, not writable, never terminal, and
--    invisible to every check that exists. Three separate mechanisms all miss
--    it, and each one misses it for a different reason:
--
--    ① `reclaimExpiredClaims()` (server/email/outbox.ts) recovers a row a dead
--       worker left behind with:
--
--           WHERE status = 'sending' AND claimed_at < <now minus the lease>
--
--       `NULL < timestamptz` is NULL, not true. A `sending` row with no
--       `claimed_at` is skipped by the one query written to rescue it, silently
--       and forever.
--
--    ② `writeBack()` names the claim token in its WHERE clause , correctly,
--       so a worker whose lease expired cannot stamp a stale verdict over a
--       newer worker's state. But a row whose `claim_token` is NULL matches no
--       token, so no worker can ever complete it either.
--
--    ③ `0159_email_outbox_ceiling_and_terminal_evidence.sql` bounds `queued`
--       and describes the terminal states. It says nothing about `sending`,
--       ON PURPOSE , a claimed row has not yet had its attempt counted, and
--       covering it there would refuse the last legitimate attempt of every
--       message in the queue. So the ceiling does not catch this either.
--
--    The result is a message that is owed to somebody, is not queued, is not
--    sent, is not dead, and that nothing in the system will ever look at
--    again. It is the exact defect shape this project keeps finding: a
--    recovery path that exists, reports success, and cannot reach the row it
--    was written for.
--
-- ⚠️ WHY THIS IS WORTH A MIGRATION WHEN NO CODE PATH PRODUCES IT TODAY.
--    `claimBatch()` is the ONLY writer of `status = 'sending'` in the
--    repository , verified by grep across server/, lib/, app/, db/ and
--    SQL-FILES/ , and it sets `status`, `claim_token` and `claimed_at` in one
--    UPDATE, so the three can never disagree while that stays true. This file
--    is what makes "while that stays true" a fact rather than a hope. A
--    support fix, a back-fill, a restore that drops a column default, or a
--    second claimer written by somebody who has not read this comment all
--    produce the stranded row, and none of them would be told.
--
-- 🔴 WHY A CHECK CONSTRAINT AND NOT A GRANT.
--    Same reasoning as 0159, and the wave-16 ruling behind it: a REVOKE binds
--    only a role that does not own the table, and a row-level policy binds the
--    owner only under FORCE and not at all under a role carrying
--    `rolbypassrls`. A CHECK is evaluated by the executor for every write by
--    every role. It is the only mechanism here whose answer does not depend on
--    whether the application connects as `ordence_app` or as `neondb_owner`.
--
-- WHAT THIS DOES NOT CLAIM
-- ------------------------
-- ⚠️ It does not make a stranded row RECOVER, and it does not shorten the
--    window in which a message waits. It makes the unrecoverable state
--    unwritable. The recovery gap it exposes , that `reclaimExpiredClaims()`
--    only runs inside a drain for that same workspace, so a workspace paused
--    in `scheduler_tenant_pauses` (Track A, 0129-0132) never reclaims anything
--    , is NOT fixed here. That fix belongs in `server/email/outbox.ts`, which
--    is outside this track's ownership, and it is written up in
--    `PATCH-REQUEST-G.md` §7 with the query it needs.
--
-- ORDER RELATIVE TO THE CODE PUSH
-- -------------------------------
-- EITHER ORDER IS SAFE, and this file ships with no code change at all. The
-- constraint describes a state the shipped dispatcher already cannot write.
--
-- SAFETY
-- ------
-- · No BEGIN, no COMMIT. Two statements, each independently re-runnable.
-- · No DML. Nothing here writes a row, so nothing here can be refused by a
--   FORCE ROW LEVEL SECURITY policy.
-- · Additive only. No column, index, policy or grant is altered or dropped.
-- · The ADD is preceded by a count of the rows that would violate it and
--   RAISES with that count and with instructions, rather than letting Postgres
--   fail with a bare constraint error that names no rows , and on this table
--   a violating row is a real customer message that somebody needs to look at
--   rather than delete.
-- ############################################################################


-- ───────────────────────────────────────────────────────────────────────────
-- 1 · ADD IT, BUT REFUSE TO PROCEED BLIND
--
-- ⚠️ THE TWO STEPS ARE IN ONE STATEMENT DELIBERATELY. Counting in one
-- statement and adding in another leaves a window in which the count is stale;
-- on a table a worker is actively claiming from, that window is exactly when
-- a new `sending` row appears.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_stranded bigint;
BEGIN
    IF to_regclass('public.email_outbox') IS NULL THEN
        RAISE EXCEPTION
            '0160 cannot run: public.email_outbox does not exist. Apply 0097 first.';
    END IF;

    SELECT count(*) INTO v_stranded
      FROM public.email_outbox
     WHERE status = 'sending'
       AND (claim_token IS NULL OR claimed_at IS NULL);

    IF v_stranded > 0 THEN
        RAISE EXCEPTION
            '0160 refuses to add its constraint: % row(s) are already stranded in sending with an incomplete claim. Each one is a message a workspace is owed that nothing will ever look at again. Do NOT delete them. Set claimed_at to a timestamp older than the ten-minute lease and claim_token to gen_random_uuid(), which puts them back in reach of reclaimExpiredClaims(); it will re-offer each one with the SAME idempotency key, so the provider deduplicates any that did already go out.',
            v_stranded;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.email_outbox'::regclass
           AND conname  = 'email_outbox_claim_is_complete_check'
    ) THEN
        ALTER TABLE public.email_outbox
            ADD CONSTRAINT email_outbox_claim_is_complete_check
            CHECK (
                status <> 'sending'
                OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
            );
    END IF;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · VERIFY, AND RAISE IF THE CHANGE DID NOT TAKE
--
-- 🔴 `convalidated` IS CHECKED, NOT JUST EXISTENCE. A constraint added
-- `NOT VALID` sits in the catalogue enforcing nothing against the rows already
-- there, and reporting that as success is the `count(*) >= 10 THEN 'PASS'`
-- shape this project keeps finding.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_ok boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.email_outbox'::regclass
           AND contype  = 'c'
           AND convalidated
           AND conname  = 'email_outbox_claim_is_complete_check'
    ) INTO v_ok;

    IF NOT v_ok THEN
        RAISE EXCEPTION
            '0160 did not take: email_outbox_claim_is_complete_check is absent or not validated. The migration has done nothing and must not be recorded as applied.';
    END IF;

    RAISE NOTICE '0160 ✅ a row in sending must carry both claim_token and claimed_at. Enforced for every role including the table owner, so the permanently-stranded claim is now unwritable.';
END $$;
