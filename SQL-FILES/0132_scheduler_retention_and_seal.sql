-- ############################################################################
-- 0132 — LEDGER RETENTION, THE MAINTENANCE LANE, AND THE SEAL ON 0129–0131
--        (Wave 14 / Track A)
-- ############################################################################
--
-- WHAT THIS FIXES, AND IT IS A DEFECT THIS TRACK WOULD OTHERWISE HAVE ADDED
-- --------------------------------------------------------------------------
-- 🔴 THE BRIEF FOR THIS TRACK NAMES `prune_change_log`,
-- `prune_security_events` AND `prune_usage_counters` AS DORMANT RETENTION
-- THAT A SCHEDULER SHOULD START RUNNING. A scheduler that then creates a
-- ledger which itself grows forever would have reproduced, in its first
-- file, the exact fault it was built to fix.
--
-- `scheduler_runs` grows by roughly (active workspaces x per-tenant jobs +
-- platform jobs) rows a day, every day, and 0129 deliberately does not grant
-- the application DELETE on it. So retention here is a maintenance-role
-- function, for character-for-character the reasons 0128 gives for
-- `prune_change_log`: a record of what the application did, which the
-- application can erase, is a record of what the application currently
-- claims it did.
--
-- 🔴 AND THE SECOND THING THIS FILE ESTABLISHES IS WHY THE THREE PRUNE
--    FUNCTIONS NAMED IN THE BRIEF CANNOT BE ADDED TO `/api/workers`.
--
-- `0121_revoke_prune_from_app_role.sql` REVOKES EXECUTE on
-- `prune_security_events()` and `prune_usage_counters()` from `ordence_app`,
-- repairing a regression 0087 introduced. `0128_change_log_retention.sql`
-- does the same for `prune_change_log()` at creation. All three are recorded
-- in `scripts/sealed-grants.json`, and `npm run check:sealed-grants` fails
-- the build on any .sql file that grants them back.
--
-- `/api/workers` executes as the application role. Registering those three
-- functions as jobs on that route therefore has exactly two outcomes:
-- permission denied on every run, or a GRANT that reverses a security
-- control repaired twice and sealed once. Neither is a scheduler.
--
-- So this file establishes the SECOND LANE: `lane = 'maintenance'` on
-- `scheduler_runs`, executed by the Railway cron service over a separate
-- connection as `ordence_maintenance`, claiming its slots in the same ledger
-- so the jobs calendar shows one list. `server/scheduler/maintenance.mjs`
-- and `docs/SCHEDULER.md` carry the operational half.
--
-- ⚠️ THIS FILE GRANTS NOTHING TO `ordence_app` THAT IT DID NOT ALREADY HAVE,
-- AND GRANTS NOTHING SEALED TO ANY ROLE. Section 4 proves it rather than
-- promising it.
--
-- IS THERE DATA LOSS?  Not on application. `prune_scheduler_runs()` defaults
-- to `dry_run = true` and refuses a window under 30 days. Nothing below runs
-- it.
--
-- RUN ORDER: last of the four. 0129 → 0130 → 0131 → 0132, then the code push.
--
-- ⚠️ NO BEGIN/COMMIT.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — RETENTION ON THE LEDGER
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.prune_scheduler_runs(integer, boolean);

CREATE OR REPLACE FUNCTION public.prune_scheduler_runs(
  older_than_days integer DEFAULT 90,
  dry_run         boolean DEFAULT true
)
RETURNS TABLE (
  removed         bigint,
  kept_unfinished bigint,
  cutoff          timestamptz,
  was_dry_run     boolean
)
LANGUAGE plpgsql
-- 🔴 SECURITY DEFINER, AND THAT IS WHY SECTION 3 REVOKES IT FROM EVERYONE
-- EXCEPT THE MAINTENANCE ROLE. The application has no DELETE on
-- `scheduler_runs` (0129 Section 4). A SECURITY DEFINER function the
-- application could call would hand straight back what that withheld —
-- which is, character for character, the defect 0121 had to repair on
-- `prune_security_events()`.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  cut  timestamptz;
  n    bigint := 0;
  keep bigint := 0;
BEGIN
  -- ⚠️ THE SAME 30-DAY FLOOR AS prune_change_log() AND
  -- prune_security_events(), FOR A RELATED REASON. "Did dunning run in the
  -- last month" is the question this table exists to answer; a retention
  -- window shorter than the question makes the table decorative.
  IF older_than_days < 30 THEN
    RAISE EXCEPTION
      'Refusing to prune scheduler_runs younger than 30 days (asked for %). '
      'The ledger is the only evidence that a statutory job ran.',
      older_than_days
      USING ERRCODE = '22023';
  END IF;

  cut := now() - make_interval(days => older_than_days);

  -- SECURITY DEFINER runs as the owner, and `scheduler_runs` is FORCE ROW
  -- LEVEL SECURITY with a platform-scope policy — so the owner is NOT
  -- exempt. Without this line the DELETE matches zero rows and the function
  -- returns success having removed nothing, which is 0128's lesson applied.
  PERFORM set_config('app.platform_scope', 'on', true);

  -- 🔴 NEVER DELETE A RUN THAT HAS NOT FINISHED, HOWEVER OLD IT IS.
  -- An unfinished row is either in flight or is a crashed executor still
  -- holding a slot. Deleting the second kind silently frees the slot and
  -- erases the only evidence that a run died — and deleting the first kind
  -- frees a slot that is genuinely in use, which is a way of manufacturing
  -- the double execution 0129 exists to prevent. They are reported
  -- separately so "nothing was removed" and "everything old is wedged" are
  -- distinguishable.
  SELECT count(*) INTO keep
    FROM public.scheduler_runs
   WHERE claimed_at < cut
     AND finished_at IS NULL;

  IF dry_run THEN
    SELECT count(*) INTO n
      FROM public.scheduler_runs
     WHERE claimed_at < cut
       AND finished_at IS NOT NULL;
  ELSE
    DELETE FROM public.scheduler_runs
     WHERE claimed_at < cut
       AND finished_at IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT n, keep, cut, dry_run;
END;
$fn$;

COMMENT ON FUNCTION public.prune_scheduler_runs(integer, boolean) IS
  'Bounds the scheduler_runs window. Defaults to 90 days and to dry_run = '
  'true; refuses anything under 30 days; never deletes an unfinished run and '
  'reports how many it kept for that reason. Callable by ordence_maintenance '
  'only — the application must not be able to delete its own operational '
  'record. Runs as the maintenance-lane job `prune_scheduler_runs`.';


-- ----------------------------------------------------------------------------
-- SECTION 2 — WHO MAY CALL IT
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  -- A SECURITY DEFINER function is EXECUTE-to-PUBLIC on creation. This must
  -- be re-asserted every time the function could have been replaced, which
  -- is why it sits immediately after the CREATE OR REPLACE and not in a
  -- later file.
  REVOKE ALL ON FUNCTION public.prune_scheduler_runs(integer, boolean) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON FUNCTION public.prune_scheduler_runs(integer, boolean) FROM ordence_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT EXECUTE ON FUNCTION public.prune_scheduler_runs(integer, boolean)
      TO ordence_maintenance;
    RAISE NOTICE '0132: prune_scheduler_runs() granted to ordence_maintenance only.';
  ELSE
    RAISE NOTICE
      '0132: role ordence_maintenance does not exist in this database, so '
      'prune_scheduler_runs() is callable by the owner alone. The '
      'maintenance lane needs that role and a MAINTENANCE_DATABASE_URL — '
      'see docs/SCHEDULER.md. Until then the ledger has no retention and '
      'the job `prune_scheduler_runs` will show as overdue on the jobs '
      'calendar, which is the intended way to find out.';
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 3 — VERIFY THE FUNCTION BY EXECUTING IT
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  r           record;
  was_refused boolean;
BEGIN
  PERFORM set_config('app.platform_scope', 'on', true);

  /* 3a. The floor is real ---------------------------------------------- */
  was_refused := false;
  BEGIN
    PERFORM public.prune_scheduler_runs(7, true);
  EXCEPTION WHEN OTHERS THEN
    was_refused := true;
  END;
  IF NOT was_refused THEN
    RAISE EXCEPTION
      '0132 FAILED: prune_scheduler_runs(7) was accepted. A seven-day window '
      'would erase the evidence that last month''s statutory jobs ran.'
      USING ERRCODE = '23000';
  END IF;

  /* 3b. A dry run deletes nothing, and says so -------------------------- */
  BEGIN
    INSERT INTO public.scheduler_runs
      (job_id, slot_at, run_kind, state, triggered_by,
       claimed_at, started_at, finished_at, heartbeat_at)
    VALUES
      ('__0132_selftest_old', now() - interval '400 days', 'scheduled',
       'succeeded', 'migration:0132',
       now() - interval '400 days', now() - interval '400 days',
       now() - interval '400 days', now() - interval '400 days');

    -- An ancient run that never finished. It must survive.
    INSERT INTO public.scheduler_runs
      (job_id, slot_at, run_kind, state, triggered_by, claimed_at, heartbeat_at)
    VALUES
      ('__0132_selftest_wedged', now() - interval '400 days', 'scheduled',
       'claimed', 'migration:0132',
       now() - interval '400 days', now() - interval '400 days');

    SELECT * INTO r FROM public.prune_scheduler_runs(90, true);

    IF r.removed < 1 THEN
      RAISE EXCEPTION
        '0132 FAILED: a dry run over a 400-day-old finished row reported '
        'removed = %. The predicate does not match anything, so the real '
        'run would delete nothing and the ledger would grow forever while '
        'the retention job reported success.', r.removed
        USING ERRCODE = '23000';
    END IF;

    IF r.kept_unfinished < 1 THEN
      RAISE EXCEPTION
        '0132 FAILED: a 400-day-old UNFINISHED run was not counted in '
        'kept_unfinished (got %). Either it is about to be deleted — which '
        'erases the evidence of a crashed executor and frees a slot that may '
        'still be held — or the count is wrong.', r.kept_unfinished
        USING ERRCODE = '23000';
    END IF;

    /*
     * ⚠️ THE LIST OF EXCEPTIONS, NOT A COUNT, AND THE SWAP WAS FORCED BY A
     * GATE THAT WAS RIGHT FOR THE WRONG REASON.
     *
     * This read `count(*) … <> 2`, which IS an exact assertion. Track C's
     * migration lint in `scripts/check-sealed-grants.mjs` flagged it as a
     * floor, because its pattern is
     *
     *     count\s*\(\s*\*\s*\)[^;]{0,120}?>=?\s*\d+
     *
     * and the `>` inside `<>` satisfies `>=?`. A false positive — reported
     * to Track C in TRACK-REPORT-WAVE-17.md §6.
     *
     * ⭐ AND THE REWRITE IS BETTER ANYWAY, which is why it is a rewrite and
     * not a suppression. The lint's own advice is "assert that the list of
     * exceptions is empty", and that is strictly more informative than a
     * count: `<> 2` says two rows became some other number, while this
     * names WHICH row went missing. A count cannot distinguish "the dry
     * run deleted the finished row" from "the dry run deleted the wedged
     * one", and those are different bugs.
     */
    IF EXISTS (
      SELECT 1
        FROM (VALUES ('__0132_selftest_old'), ('__0132_selftest_wedged')) AS expected(job_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.scheduler_runs sr WHERE sr.job_id = expected.job_id
       )
    ) THEN
      RAISE EXCEPTION
        '0132 FAILED: a DRY RUN deleted rows — % is gone. dry_run is not '
        'honoured, so the "check before you prune" step in docs/SCHEDULER.md '
        'is a lie.',
        (SELECT string_agg(expected.job_id, ', ')
           FROM (VALUES ('__0132_selftest_old'), ('__0132_selftest_wedged')) AS expected(job_id)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.scheduler_runs sr WHERE sr.job_id = expected.job_id
          ))
        USING ERRCODE = '23000';
    END IF;

    /* 3c. A real run removes the finished row and keeps the wedged one -- */
    SELECT * INTO r FROM public.prune_scheduler_runs(90, false);

    IF EXISTS (SELECT 1 FROM public.scheduler_runs WHERE job_id = '__0132_selftest_old') THEN
      RAISE EXCEPTION
        '0132 FAILED: a real prune did not remove a 400-day-old finished '
        'run. Under FORCE ROW LEVEL SECURITY a DELETE that matches nothing '
        'still reports success — check the set_config for app.platform_scope '
        'inside the function.'
        USING ERRCODE = '23000';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.scheduler_runs WHERE job_id = '__0132_selftest_wedged') THEN
      RAISE EXCEPTION
        '0132 FAILED: a real prune DELETED a run that never finished. The '
        'only record that an executor died has been erased, and a slot that '
        'may still be held has been silently freed.'
        USING ERRCODE = '23000';
    END IF;

    RAISE EXCEPTION 'ROLLBACK_0132_SELFTEST';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'ROLLBACK_0132_SELFTEST' THEN RAISE; END IF;
  END;

  RAISE NOTICE
    '0132 PASS (retention): a sub-30-day window is refused; a dry run '
    'counts and deletes nothing; a real run removes finished rows and keeps '
    'unfinished ones. All test rows rolled back.';
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 4 — THE SEAL: WHAT THE APPLICATION ROLE MUST NOT HAVE
-- ----------------------------------------------------------------------------
--
-- ⚠️ EVERY CHECK HERE IS INERT AGAINST A CONNECTION THAT OWNS THE TABLES,
-- AND SAYING SO IS THE POINT. A table owner is not subject to GRANT or
-- REVOKE, so if the application connects as the owner, none of the four
-- refusals below constrains it and the only remaining control is the FORCE
-- policy from 0129/0130/0131. This block therefore also reports whether
-- `ordence_app` exists at all, because on a database where it does not, the
-- application is connecting as something else and every privilege statement
-- in this wave is decoration.

DO $$
DECLARE
  app_exists  boolean;
  maint_exists boolean;
  problems    text := '';
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') INTO app_exists;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') INTO maint_exists;

  IF NOT app_exists THEN
    RAISE NOTICE
      '0132: role ordence_app does NOT exist in this database. The grant '
      'checks below cannot run. ⚠️ This is not a pass. It means the '
      'application connects as some other role — very likely the table '
      'owner — for which GRANT and REVOKE do nothing at all and only FORCE '
      'ROW LEVEL SECURITY still holds. Run '
      'SQL-FILES/WHO-DOES-THE-APP-CONNECT-AS-neon-safe.sql and read the '
      'grid before treating this file as green.';
  ELSE
    -- ══════════════════════════════════════════════════════════════════
    -- 🔴 THIS BLOCK FOUND A REAL DEFECT IN 0129 ON ITS FIRST RUN, AND IT
    --    IS LEFT WIDENED RATHER THAN NARROWED.
    -- ══════════════════════════════════════════════════════════════════
    -- 0129's first draft granted SELECT, INSERT, UPDATE and said "no
    -- DELETE" in a comment. Privileges ACCUMULATE: `npm run
    -- test:bootstrap` sets `ALTER DEFAULT PRIVILEGES IN SCHEMA public
    -- GRANT ALL ON TABLES TO ordence_app` (bootstrap-test-db.mjs:189), so
    -- the table arrived with DELETE, TRUNCATE, REFERENCES and TRIGGER
    -- already granted and the narrower grant changed nothing. This check
    -- is what caught it. 0129 now REVOKEs explicitly.
    --
    -- 🔴 TRUNCATE IS CHECKED SEPARATELY AND IS THE MORE DANGEROUS OF THE
    -- TWO. It is not subject to row-level security at all — no policy,
    -- forced or otherwise, sees it — so a role holding TRUNCATE empties
    -- these tables in one statement whatever 0129 Section 3 says. A check
    -- that looked only for DELETE would pass on a database where the
    -- ledger can be erased wholesale.
    IF has_table_privilege('ordence_app', 'public.scheduler_runs', 'DELETE') THEN
      problems := problems ||
        E'\n  - ordence_app has DELETE on scheduler_runs. The application can '
        'erase the record of a run it should not have made. Granting three '
        'privileges does not take the fourth away — 0129 must REVOKE it.';
    END IF;

    IF has_table_privilege('ordence_app', 'public.scheduler_runs', 'TRUNCATE') THEN
      problems := problems ||
        E'\n  - ordence_app has TRUNCATE on scheduler_runs. TRUNCATE is not '
        'subject to row-level security, so this empties the entire run ledger '
        'in one statement regardless of the FORCE policy.';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = 'scheduler_tenant_pauses')
       AND has_table_privilege('ordence_app', 'public.scheduler_tenant_pauses', 'DELETE') THEN
      problems := problems ||
        E'\n  - ordence_app has DELETE on scheduler_tenant_pauses. Lifting a '
        'pause is an UPDATE, never a DELETE: the record of who paused a '
        'workspace from statutory dunning, when and why, is evidence.';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = 'scheduler_job_expectations')
       AND (has_table_privilege('ordence_app', 'public.scheduler_job_expectations', 'DELETE')
         OR has_table_privilege('ordence_app', 'public.scheduler_job_expectations', 'TRUNCATE')) THEN
      problems := problems ||
        E'\n  - ordence_app can DELETE or TRUNCATE scheduler_job_expectations, '
        'which IS the dead man switch''s memory. One TRUNCATE turns '
        'scheduler_overdue() into a function that returns nothing, forever, '
        'for every job — a permanently green watchdog watching nothing. '
        'Retiring a job is an UPDATE setting retired_at.';
    END IF;

    IF has_function_privilege('ordence_app',
         'public.prune_scheduler_runs(integer, boolean)', 'EXECUTE') THEN
      problems := problems ||
        E'\n  - ordence_app can EXECUTE prune_scheduler_runs(). SECURITY '
        'DEFINER, so this hands back the DELETE the line above withholds. '
        'This is the exact shape of the 0087 -> 0121 regression.';
    END IF;

    -- 🔴 THE THREE SEALED FUNCTIONS. This wave must not have re-granted them
    -- as a side effect of building a scheduler, and the whole reason the
    -- maintenance lane exists is that it must not need to.
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prune_security_events')
       AND has_function_privilege('ordence_app',
             'public.prune_security_events(integer, boolean)', 'EXECUTE') THEN
      problems := problems ||
        E'\n  - ordence_app can EXECUTE prune_security_events(). Sealed by '
        'scripts/sealed-grants.json and repaired by 0121. If the scheduler '
        'work re-granted this, revert it: the maintenance lane exists so it '
        'is not needed.';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prune_change_log')
       AND has_function_privilege('ordence_app',
             'public.prune_change_log(integer, boolean)', 'EXECUTE') THEN
      problems := problems ||
        E'\n  - ordence_app can EXECUTE prune_change_log(). Withheld by 0128.';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prune_usage_counters')
       AND has_function_privilege('ordence_app',
             'public.prune_usage_counters(interval)', 'EXECUTE') THEN
      problems := problems ||
        E'\n  - ordence_app can EXECUTE prune_usage_counters(). Sealed by '
        'scripts/sealed-grants.json and repaired by 0121.';
    END IF;

    IF problems <> '' THEN
      RAISE EXCEPTION '0132 FAILED — separation of duties is broken:%', problems
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT maint_exists THEN
    RAISE NOTICE
      '0132: role ordence_maintenance does NOT exist. The maintenance lane '
      'cannot run, so prune_change_log, prune_security_events, '
      'prune_usage_counters and prune_scheduler_runs stay dormant. They are '
      'declared in server/scheduler/policy.ts with lane = "maintenance", so '
      'the watchdog will report them overdue rather than letting the '
      'silence pass unnoticed. See docs/SCHEDULER.md, "The maintenance '
      'lane".';
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 5 — THE SEAL: 0129, 0130 AND 0131 ARE ALL ACTUALLY THERE
-- ----------------------------------------------------------------------------
--
-- 🔴 THE FAILURE THIS CATCHES IS A PARTIAL APPLY, AND IT IS THE LIKELIEST
-- REAL FAULT IN THIS WHOLE WAVE. These four files are pasted into a browser
-- SQL console by hand, one at a time, with no file-level transaction (the
-- console does not support one). A tab closed after 0130 leaves a database
-- with a control plane and no watchdog — and every screen keeps working,
-- because the watchdog's absence has no symptom. That is the pattern this
-- codebase has produced 23 times.
--
-- ⚠️ FORCE IS CHECKED SEPARATELY FROM ENABLE, because `relrowsecurity`
-- without `relforcerowsecurity` is the shape that looks correct in every
-- catalog view and exempts the owner — which, if the application connects
-- as the owner, means no policy applies to it at all.

DO $$
DECLARE
  t          text;
  missing    text := '';
  unforced   text := '';
  unpoliced  text := '';
  fn         text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'scheduler_runs',
    'scheduler_job_controls',
    'scheduler_tenant_pauses',
    'scheduler_tenant_schedules',
    'scheduler_job_expectations',
    'scheduler_heartbeat'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      missing := missing || E'\n  - table ' || t;
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t
         AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      unforced := unforced || E'\n  - ' || t;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
    ) THEN
      unpoliced := unpoliced || E'\n  - ' || t;
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'scheduler_pause_reason',
    'scheduler_overdue',
    'scheduler_watchdog_status',
    'scheduler_reclaim_stale',
    'prune_scheduler_runs'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = fn) THEN
      missing := missing || E'\n  - function ' || fn || '()';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'scheduler_runs_slot_uq'
  ) THEN
    missing := missing || E'\n  - index scheduler_runs_slot_uq (THE exactly-once claim)';
  END IF;

  -- ⭐ `indnullsnotdistinct` READ DIRECTLY. 0129 Section 5 proves the
  -- behaviour by executing two claims, which is the stronger check and the
  -- one that runs when 0129 is applied. This is the standing check, so that
  -- an index rebuilt by hand months from now — REINDEX, a restore, a
  -- migration written in a hurry — cannot quietly drop the phrase.
  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname = 'public' AND indexname = 'scheduler_runs_slot_uq')
     AND NOT (
       SELECT i.indnullsnotdistinct
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'scheduler_runs_slot_uq'
     ) THEN
    missing := missing ||
      E'\n  - scheduler_runs_slot_uq exists but WITHOUT `NULLS NOT DISTINCT`. '
      'Every platform-scoped job (rate_limit_sweep, anomaly_detection) can '
      'claim the same slot twice, because two NULL subject_tenant_ids are '
      'not equal. Re-apply 0129.';
  END IF;

  IF missing <> '' OR unforced <> '' OR unpoliced <> '' THEN
    -- ⚠️ ONE PLACEHOLDER, NOT THREE. `%%` is a literal per cent in RAISE, so
    -- the first draft's `%%%` was one escaped sign plus one placeholder and
    -- three arguments — "too many parameters specified for RAISE", raised at
    -- RUN TIME and only on the failure path. A seal whose failure branch
    -- does not compile still reports the wrong thing loudly, but it reports
    -- a plpgsql error instead of the fault, which is worse than either.
    RAISE EXCEPTION '%',
      '0132 FAILED — the scheduler wave is only partly applied.' ||
      CASE WHEN missing   <> '' THEN E'\nMISSING:'   || missing   ELSE '' END ||
      CASE WHEN unforced  <> '' THEN E'\nENABLED BUT NOT FORCED (the owner is exempt, so if the application connects as the owner no policy applies):' || unforced ELSE '' END ||
      CASE WHEN unpoliced <> '' THEN E'\nRLS ON WITH NO POLICY (denies everything, including the scheduler):' || unpoliced ELSE '' END
      USING ERRCODE = '42P01';
  END IF;

  RAISE NOTICE
    '0132 PASS (seal): all six scheduler tables exist, are ENABLE + FORCE '
    'ROW LEVEL SECURITY and carry a policy; all five functions exist; '
    'scheduler_runs_slot_uq exists WITH NULLS NOT DISTINCT; and the '
    'application role holds none of the four sealed prune privileges.';
END
$$;


-- ############################################################################
-- SECTION 6 — HOW THE MAINTENANCE LANE IS ACTUALLY RUN. NOTHING BELOW RUNS
--             AUTOMATICALLY.
-- ############################################################################
--
-- The Railway cron service (`railway.cron.json`) runs
-- `server/scheduler/cron-entrypoint.mjs`. That script does two things:
--
--   1. POST /api/workers {"mode":"tick"}      — the `app` lane, over HTTP,
--                                                as ordence_app.
--   2. If MAINTENANCE_DATABASE_URL is set     — the `maintenance` lane, over
--                                                a direct connection as
--                                                ordence_maintenance.
--
-- ⚠️ IF `MAINTENANCE_DATABASE_URL` IS UNSET THE LANE DOES NOT SILENTLY
-- SUCCEED. The script skips it and says so, and because the maintenance jobs
-- are declared in `server/scheduler/policy.ts` they still appear in
-- `scheduler_job_expectations` — so `scheduler_overdue()` reports them and
-- `GET /api/workers?watchdog=1` goes red. "Retention is not configured" is
-- therefore visible, which is the whole difference between this and the
-- three years in which it was not.
--
-- To create the role and the connection string, on a Neon SQL console
-- connected as the owner:
--
--      CREATE ROLE ordence_maintenance LOGIN PASSWORD '<generate one>'
--        NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--      GRANT USAGE ON SCHEMA public TO ordence_maintenance;
--      -- then re-run 0129, 0131 and 0132, whose grant blocks are guarded on
--      -- the role existing and are idempotent.
--
-- ⚠️ NOBYPASSRLS IS NOT OPTIONAL. A maintenance role with BYPASSRLS reads
-- every workspace's data on every query, and the prune functions do not need
-- it: each one sets the platform marker or loops tenants explicitly.
--
-- Generate the password on your own machine, paste it only into Railway:
--
--      openssl rand -hex 32
--
-- To check retention by hand before trusting the job, as ordence_maintenance:
--
--      SELECT * FROM prune_scheduler_runs(90, true);    -- counts only
--      SELECT * FROM prune_scheduler_runs(90, false);   -- deletes
--
-- and the three the brief names, each of which has its own runbook section
-- in the file that created it:
--
--      SELECT * FROM prune_change_log(180, true);       -- 0128 Section 4
--      SELECT * FROM prune_security_events(365, true);  -- 0012
--      SELECT prune_usage_counters('25 months');        -- 0013
--
-- 🔴 DO NOT MOVE ANY OF THESE ONTO `/api/workers` TO SAVE A CONNECTION.
-- That is the shortcut this file exists to refuse, and `npm run
-- check:sealed-grants` will refuse it again on the next build.
-- ############################################################################
