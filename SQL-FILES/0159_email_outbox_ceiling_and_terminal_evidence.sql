-- ############################################################################
-- 0159 , THE RETRY CEILING AND THE TERMINAL EVIDENCE, AS DATABASE FACTS
--        (Track G / wave 16 / v1.82.0-alpha)
-- ############################################################################
--
-- PURPOSE
-- -------
-- 0097 built `email_outbox` and got the hard part right. Three of its rules,
-- though, live only in TypeScript:
--
--   ① A QUEUED ROW HAS ATTEMPTS LEFT.
--      `decideAfterAttempt()` in `lib/email/outbox.ts` turns a row into `dead`
--      the moment `attempts + 1 >= max_attempts`. Nothing in the database says
--      so. A row that reached `attempts = max_attempts` while still `queued`
--      , written by a back-fill, a support fix, a future caller, or a bug in
--      a file nobody re-read , is offered to the provider on every sweep for
--      the rest of time. §6.2 of this track's brief names that exactly: "an
--      unbounded retry against a permanent failure is a denial of service you
--      built yourself." Nothing refuses it today.
--
--   ② `max_attempts` IS AT LEAST ONE.
--      `max_attempts = 0` is a row that can never be attempted and can never
--      become terminal. It is not queued and it is not dead; it is invisible
--      in both directions.
--
--   ③ A TERMINAL ROW CARRIES ITS EVIDENCE.
--      0097 already refuses `sent` or `bounced` without a provider message id
--      , the rule that makes `sent` mean something. But `sent` with a NULL
--      `sent_at`, and `dead` with no `dead_at` and no `last_error_code`, are
--      both still insertable. "Why did this customer never hear from us" is
--      the question the dead-letter queue exists to answer, and a row with no
--      reason on it cannot answer it.
--
-- 🔴 WHY A CHECK CONSTRAINT AND NOT A GRANT, AND WHY THAT DECIDES IT.
--    A REVOKE binds only a role that does not own the table. A row-level
--    policy binds the owner only under FORCE, and not at all under a role
--    carrying `rolbypassrls`. A CHECK constraint is evaluated by the executor
--    for EVERY write by EVERY role , owner, superuser and bypassing role
--    alike. Of the mechanisms available to this migration it is the only one
--    whose answer does not depend on which role the application turned out to
--    connect as, and that question is currently disputed between this track's
--    brief and `RAILWAY-VARIABLES-PASTE.txt`.
--
-- ⚠️ WHAT THIS FILE DOES NOT CLAIM. It does not stop a message being lost, it
--    does not send anything, and it adds no policy. It makes three sentences
--    that were previously only comments impossible to contradict.
--
-- ORDER RELATIVE TO THE CODE PUSH
-- -------------------------------
-- EITHER ORDER IS SAFE. The constraints describe states the shipped code
-- already never writes; nothing in Track G's TypeScript depends on them
-- existing. Run it before the push if you want the guarantee earlier.
--
-- SAFETY
-- ------
-- · No BEGIN, no COMMIT. Every statement stands alone and is re-runnable.
-- · No DML. Nothing here writes a row, so nothing here can be refused by a
--   FORCE ROW LEVEL SECURITY policy.
-- · Additive only. No column, index, policy or grant is altered or dropped.
-- · Every ADD is preceded by a count of the rows that would violate it, and
--   RAISES with that count rather than letting Postgres fail with a bare
--   constraint error that names no rows.
-- ############################################################################


-- ───────────────────────────────────────────────────────────────────────────
-- 1 · REFUSE TO PROCEED BLIND
--
-- ⚠️ THIS STATEMENT EXISTS BECAUSE THE ALTERNATIVE IS A CONFUSING FAILURE.
-- `ALTER TABLE ... ADD CONSTRAINT` on a table holding a violating row fails
-- with "check constraint is violated by some row" and names neither the row
-- nor how many there are. On a mail queue that is the difference between a
-- five-minute fix and an afternoon.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_ceiling   bigint;
    v_maxatt    bigint;
    v_terminal  bigint;
BEGIN
    IF to_regclass('public.email_outbox') IS NULL THEN
        RAISE EXCEPTION
            '0159 cannot run: public.email_outbox does not exist. Apply 0097 first.';
    END IF;

    SELECT count(*) INTO v_ceiling
      FROM public.email_outbox
     WHERE status = 'queued' AND attempts >= max_attempts;

    SELECT count(*) INTO v_maxatt
      FROM public.email_outbox
     WHERE max_attempts < 1;

    SELECT count(*) INTO v_terminal
      FROM public.email_outbox
     WHERE (status = 'sent' AND sent_at IS NULL)
        OR (status = 'dead' AND (dead_at IS NULL OR last_error_code IS NULL));

    IF v_ceiling > 0 OR v_maxatt > 0 OR v_terminal > 0 THEN
        RAISE EXCEPTION
            '0159 refuses to add its constraints: % queued row(s) are already at or past their attempt ceiling, % row(s) have max_attempts < 1, % terminal row(s) carry no evidence. Investigate those rows first — each one is a message that is either being retried forever or cannot explain itself. None of them were written by the shipped dispatcher.',
            v_ceiling, v_maxatt, v_terminal;
    END IF;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · max_attempts IS AT LEAST ONE
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.email_outbox'::regclass
           AND conname  = 'email_outbox_max_attempts_check'
    ) THEN
        ALTER TABLE public.email_outbox
            ADD CONSTRAINT email_outbox_max_attempts_check
            CHECK (max_attempts >= 1);
    END IF;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 3 · A QUEUED ROW HAS ATTEMPTS LEFT
--
-- ⭐ THE ONE THAT MATTERS. Read it as: a message may only be waiting to go out
-- if it is still allowed another try. The moment it is not, it is `dead` and a
-- human can see it in the dead-letter list , which is the entire point of
-- having one.
--
-- ⚠️ `sending` IS DELIBERATELY NOT COVERED. A claimed row has not yet had its
-- attempt counted; `attempts` is incremented at write-back, not at claim.
-- Including `sending` here would refuse the last legitimate attempt of every
-- message in the queue.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.email_outbox'::regclass
           AND conname  = 'email_outbox_attempt_ceiling_check'
    ) THEN
        ALTER TABLE public.email_outbox
            ADD CONSTRAINT email_outbox_attempt_ceiling_check
            CHECK (status <> 'queued' OR attempts < max_attempts);
    END IF;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 4 · A TERMINAL ROW CARRIES ITS EVIDENCE
--
-- ⚠️ `bounced` IS NOT REQUIRED TO CARRY `bounced_at` HERE. A bounce is written
-- by the Resend webhook against a row that was already `sent`, and 0097
-- already requires a provider message id for both states. Adding a fourth
-- rule about a column this migration has not audited would be guessing.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.email_outbox'::regclass
           AND conname  = 'email_outbox_terminal_evidence_check'
    ) THEN
        ALTER TABLE public.email_outbox
            ADD CONSTRAINT email_outbox_terminal_evidence_check
            CHECK (
                (status <> 'sent' OR sent_at IS NOT NULL)
                AND
                (status <> 'dead' OR (dead_at IS NOT NULL AND last_error_code IS NOT NULL))
            );
    END IF;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 5 · VERIFY, AND RAISE IF THE CHANGE DID NOT TAKE
--
-- 🔴 `convalidated` IS CHECKED, NOT JUST EXISTENCE. A constraint added
-- `NOT VALID` is present in the catalogue and enforced only against new rows;
-- reporting that as success is precisely the `count(*) >= 10 THEN 'PASS'`
-- shape this project keeps finding. Nothing above adds one NOT VALID, and
-- this is what proves that stayed true.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_present integer;
BEGIN
    SELECT count(*) INTO v_present
      FROM pg_constraint
     WHERE conrelid = 'public.email_outbox'::regclass
       AND contype  = 'c'
       AND convalidated
       AND conname IN (
            'email_outbox_max_attempts_check',
            'email_outbox_attempt_ceiling_check',
            'email_outbox_terminal_evidence_check'
       );

    IF v_present <> 3 THEN
        RAISE EXCEPTION
            '0159 did not take: expected 3 validated CHECK constraints on public.email_outbox, found %. The migration has done nothing and must not be recorded as applied.',
            v_present;
    END IF;

    RAISE NOTICE '0159 ✅ three validated CHECK constraints on public.email_outbox: attempt ceiling, max_attempts >= 1, terminal evidence. All three bind every role including the table owner.';
END $$;
