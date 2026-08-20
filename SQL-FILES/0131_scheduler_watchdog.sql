-- ############################################################################
-- 0131 — THE DEAD MAN SWITCH: AN ALERT THAT FIRES ON ABSENCE
--        (Wave 14 / Track A)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- 🔴 THE DANGEROUS FAILURE IS NOT A JOB THAT ERRORS. It is a job that stops
-- being scheduled, and nobody notices for six weeks.
--
-- Every alarm in this product today is downstream of something happening: a
-- 500 is logged, a failed workspace is counted, a red tick appears on a cron
-- dashboard. All of them require a run. None of them can fire when the run
-- does not happen — and "the run did not happen" is precisely the state this
-- product has been in since it was written. Eight registered jobs, correct,
-- tested, and never once executed, with nothing anywhere saying so. The
-- screens kept working. That is the shape of the failure, and an error-driven
-- alarm is structurally incapable of seeing it.
--
-- So the watchdog is inverted: every job DECLARES how long it may be silent,
-- and silence past that window IS the alert. No run is required to raise it.
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. `scheduler_job_expectations` — the declared cadence, mirrored from
--      `server/scheduler/policy.ts` on every tick. Code is the source of
--      truth; this is the copy the watchdog can read when the code is not
--      running, which is exactly the case it exists for.
--   2. `scheduler_heartbeat` — the tick itself says it is alive.
--   3. `scheduler_overdue(as_of)` — every job silent past its window.
--   4. `scheduler_watchdog_status(as_of, heartbeat_max_seconds)` — one row,
--      for `GET /api/workers?watchdog=1` to turn into a status code an
--      external uptime monitor understands.
--   5. `scheduler_reclaim_stale(as_of, stale_seconds)` — a run whose
--      heartbeat died is marked abandoned so its slot stops being held by a
--      process that no longer exists.
--   6. Verifies all of it by executing it, including the four ways this
--      function is normally written wrong.
--
-- ⚠️ THE WATCHDOG MUST NOT LIVE ONLY INSIDE THE THING THAT CAN DIE. If the
-- only evaluator were the tick, then a tick that stops also stops the alarm
-- about the tick stopping, and the whole file would be decorative. Three
-- independent readers therefore exist: the tick (routine), the admin jobs
-- calendar (a human looking), and `GET /api/workers?watchdog=1` (an external
-- monitor with no dependency on our scheduler at all). The third is the one
-- that survives us.
--
-- IS THERE DATA LOSS?  No. Two tables, three functions.
--
-- RUN ORDER: after 0129 and 0130. 0129 → 0130 → 0131 → 0132, then the code.
--
-- ⚠️ NO BEGIN/COMMIT. RLS: platform-scope, as 0129 Section 3.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — WHAT EACH JOB PROMISES
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scheduler_job_expectations (
  job_id              text PRIMARY KEY,
  lane                text        NOT NULL DEFAULT 'app',
  label               text        NOT NULL,

  -- The five-field UTC cron the code declares. Stored so a human reading
  -- this table alone can see what was meant, and so the calendar can render
  -- "next run" without the application being up.
  cron_utc            text        NOT NULL,

  -- 🔴 THE WINDOW. Longer than the cadence, by design and by a margin:
  -- an hourly job must not alarm because one tick was three minutes late.
  -- `server/scheduler/policy.ts` derives it as (2 x cadence + 15 minutes)
  -- unless the job overrides it, and the override has to be argued for.
  max_silence_seconds integer     NOT NULL CHECK (max_silence_seconds > 0),

  -- What stops working. Copied from `consequenceWhenStopped` in the
  -- registry, because an alert saying "dunning_sweep is overdue" tells the
  -- person woken by it nothing about whether to get up.
  consequence         text        NOT NULL,

  -- 🔴 THE BASELINE FOR A JOB THAT HAS NEVER RUN. Without it, "last success"
  -- is NULL for a new job and every natural way of writing the overdue query
  -- silently excludes it — so the very jobs most likely to be misconfigured
  -- are the ones the watchdog cannot see. Section 6c executes that case.
  declared_at         timestamptz NOT NULL DEFAULT now(),

  -- Set when the job leaves the code catalog. A retired job must stop
  -- alarming; deleting the row instead would lose the record that it existed.
  retired_at          timestamptz,

  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.scheduler_job_expectations IS
  'The declared cadence of every job, mirrored from server/scheduler/policy.ts '
  'on every tick. Code is authoritative; this is the copy the watchdog reads '
  'when the code is NOT running — which is the only case that matters.';


-- ----------------------------------------------------------------------------
-- SECTION 2 — THE CLOCK SAYS IT IS ALIVE
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scheduler_heartbeat (
  id       text PRIMARY KEY,          -- 'tick'
  beat_at  timestamptz NOT NULL,
  source   text        NOT NULL,      -- 'railway-cron', 'manual', ...
  detail   jsonb       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.scheduler_heartbeat IS
  'One row, id = ''tick''. The Railway cron service updates beat_at every '
  'time it runs. A stale beat means the CLOCK is gone, which is a different '
  'and worse fault than one job being overdue: it means every job is about '
  'to be overdue and none of them has noticed yet.';


-- ----------------------------------------------------------------------------
-- SECTION 3 — WHAT IS OVERDUE
-- ----------------------------------------------------------------------------
--
-- 🔴 THE FOUR WAYS THIS QUERY IS NORMALLY WRONG, ALL OF THEM SILENT:
--
--   1. `WHERE last_success_at < as_of - window` — drops every job that has
--      NEVER succeeded, because NULL fails the comparison. A job that has
--      never run once is reported healthy forever. Section 6c.
--   2. Using the last RUN rather than the last SUCCESS — a job failing every
--      night looks perfectly punctual. Section 6d.
--   3. Counting a run that is still IN FLIGHT as a success — a job wedged at
--      06:00 keeps its `claimed` row and never alarms. Only `finished_at`
--      with `state = 'succeeded'` counts.
--   4. Not excluding retired jobs — the alarm never clears and is switched
--      off, which removes the alarm for the jobs that still matter.

CREATE OR REPLACE FUNCTION public.scheduler_overdue(
  p_as_of timestamptz DEFAULT now()
)
RETURNS TABLE (
  job_id              text,
  label               text,
  lane                text,
  max_silence_seconds integer,
  last_success_at     timestamptz,
  silent_seconds      bigint,
  ever_ran            boolean,
  consequence         text
)
LANGUAGE sql
STABLE
AS $fn$
  WITH last_success AS (
    SELECT r.job_id, max(r.finished_at) AS at
      FROM public.scheduler_runs r
     WHERE r.state = 'succeeded'
       AND r.finished_at IS NOT NULL
       AND r.finished_at <= p_as_of
     GROUP BY r.job_id
  )
  SELECT
    e.job_id,
    e.label,
    e.lane,
    e.max_silence_seconds,
    s.at AS last_success_at,
    -- ⚠️ COALESCE ONTO `declared_at`, WHICH IS THE WHOLE POINT OF THAT
    -- COLUMN. A job declared this morning with an hourly cadence becomes
    -- overdue an hour and a bit from this morning, whether or not it has
    -- ever produced a row.
    EXTRACT(EPOCH FROM (p_as_of - COALESCE(s.at, e.declared_at)))::bigint
      AS silent_seconds,
    (s.at IS NOT NULL) AS ever_ran,
    e.consequence
  FROM public.scheduler_job_expectations e
  LEFT JOIN last_success s ON s.job_id = e.job_id
  WHERE e.retired_at IS NULL
    AND COALESCE(s.at, e.declared_at) < p_as_of - make_interval(secs => e.max_silence_seconds)
  ORDER BY
    -- Never-run first: a job that has never fired is a configuration fault,
    -- not a hiccup, and it is the one worth reading first.
    (s.at IS NOT NULL),
    (p_as_of - COALESCE(s.at, e.declared_at)) DESC;
$fn$;

COMMENT ON FUNCTION public.scheduler_overdue(timestamptz) IS
  'Jobs that have been silent longer than they declared they may be. Fires '
  'on ABSENCE: a job that has never succeeded is overdue once its window '
  'passes its declared_at. Counts only completed successes, so a job failing '
  'nightly and a job wedged mid-run both alarm.';


-- ----------------------------------------------------------------------------
-- SECTION 4 — ONE ROW, FOR A MONITOR THAT ONLY UNDERSTANDS RED AND GREEN
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.scheduler_watchdog_status(
  p_as_of                  timestamptz DEFAULT now(),
  p_heartbeat_max_seconds  integer     DEFAULT 900
)
RETURNS TABLE (
  ok                   boolean,
  overdue_count        integer,
  never_ran_count      integer,
  heartbeat_at         timestamptz,
  heartbeat_age_seconds bigint,
  heartbeat_stale      boolean,
  headline             text
)
LANGUAGE sql
STABLE
AS $fn$
  WITH o AS (
    SELECT * FROM public.scheduler_overdue(p_as_of)
  ),
  hb AS (
    SELECT beat_at FROM public.scheduler_heartbeat WHERE id = 'tick'
  ),
  agg AS (
    SELECT
      (SELECT count(*)::int FROM o)                          AS overdue_count,
      (SELECT count(*)::int FROM o WHERE NOT ever_ran)       AS never_ran_count,
      (SELECT beat_at FROM hb)                               AS heartbeat_at,
      -- 🔴 NULL HEARTBEAT IS NOT A MISSING MEASUREMENT, IT IS THE WORST
      -- READING AVAILABLE: the clock has never run at all. Mapping it to a
      -- huge age rather than to NULL is what stops `heartbeat_stale` being
      -- NULL and `ok` being NULL and the endpoint answering 200 on a
      -- deployment where the cron service was never created.
      COALESCE(
        EXTRACT(EPOCH FROM (p_as_of - (SELECT beat_at FROM hb)))::bigint,
        9223372036854775807
      )                                                       AS heartbeat_age_seconds
  )
  SELECT
    (agg.overdue_count = 0 AND agg.heartbeat_age_seconds <= p_heartbeat_max_seconds) AS ok,
    agg.overdue_count,
    agg.never_ran_count,
    agg.heartbeat_at,
    agg.heartbeat_age_seconds,
    (agg.heartbeat_age_seconds > p_heartbeat_max_seconds) AS heartbeat_stale,
    CASE
      WHEN agg.heartbeat_at IS NULL THEN
        'NO HEARTBEAT EVER. The scheduler clock has never run: the Railway '
        'cron service does not exist, or has never reached /api/workers. '
        'Every job below is dormant.'
      WHEN agg.heartbeat_age_seconds > p_heartbeat_max_seconds THEN
        'SCHEDULER CLOCK IS SILENT. Last tick ' || agg.heartbeat_age_seconds ||
        's ago, limit ' || p_heartbeat_max_seconds || 's. Nothing is being '
        'scheduled and no job-level alert can be trusted, because the thing '
        'that raises them is the thing that stopped.'
      WHEN agg.overdue_count > 0 THEN
        agg.overdue_count || ' job(s) overdue, ' || agg.never_ran_count ||
        ' of which have never succeeded. Call scheduler_overdue() for the list.'
      ELSE
        'Every declared job has completed within its window and the clock is beating.'
    END AS headline
  FROM agg;
$fn$;

COMMENT ON FUNCTION public.scheduler_watchdog_status(timestamptz, integer) IS
  'One row for GET /api/workers?watchdog=1 to turn into 200 or 503. ok is '
  'false when any job is overdue OR the clock itself has gone quiet. A NULL '
  'heartbeat is treated as infinitely stale, never as unknown.';


-- ----------------------------------------------------------------------------
-- SECTION 5 — RECLAIM A CLAIM HELD BY A PROCESS THAT NO LONGER EXISTS
-- ----------------------------------------------------------------------------
--
-- 🔴 WITHOUT THIS, ONE CRASH DISABLES A JOB PERMANENTLY. A run that claims
-- its slot and is then killed mid-flight — the container is recycled, the
-- deploy rolls, the request times out — leaves a `claimed` row that never
-- finishes. Every later tick sees an in-flight run, applies the `skip`
-- overrun policy, and skips. The job never runs again and every symptom
-- points at the schedule.
--
-- ⚠️ IT IS A WRITE, SO IT NEEDS THE PLATFORM MARKER. `scheduler_runs` is
-- FORCE ROW LEVEL SECURITY with a platform-scope policy, so the caller sets
-- `app.platform_scope` or this updates zero rows and reports success.
-- SECURITY INVOKER on purpose: this must run with the caller's rights, so a
-- role that may not write the ledger cannot launder a write through it.

CREATE OR REPLACE FUNCTION public.scheduler_reclaim_stale(
  p_as_of         timestamptz DEFAULT now(),
  p_stale_seconds integer     DEFAULT 1800
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $fn$
DECLARE
  n integer;
BEGIN
  IF p_stale_seconds < 60 THEN
    RAISE EXCEPTION
      'Refusing a staleness threshold under 60s (asked for %). A healthy run '
      'that heartbeats every 30s would be declared dead mid-flight and its '
      'slot handed to a second executor — which is a way of MANUFACTURING '
      'the double execution 0129 exists to prevent.', p_stale_seconds
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.scheduler_runs
     SET state       = 'abandoned',
         finished_at = p_as_of,
         error       = COALESCE(error, '')
                       || 'Reclaimed by scheduler_reclaim_stale(): no heartbeat for '
                       || EXTRACT(EPOCH FROM (p_as_of - heartbeat_at))::bigint
                       || 's (limit ' || p_stale_seconds || 's). The executing '
                       || 'process is gone; whether its work completed is unknown.'
   WHERE finished_at IS NULL
     AND state IN ('claimed', 'running')
     AND heartbeat_at < p_as_of - make_interval(secs => p_stale_seconds);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

COMMENT ON FUNCTION public.scheduler_reclaim_stale(timestamptz, integer) IS
  'Marks abandoned any run whose heartbeat died, so a crashed executor stops '
  'holding a slot forever. SECURITY INVOKER: needs app.platform_scope set by '
  'the caller. Refuses a threshold under 60s.';


-- ----------------------------------------------------------------------------
-- SECTION 5b — ROW LEVEL SECURITY AND GRANTS
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scheduler_job_expectations', 'scheduler_heartbeat']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_platform_only', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (app_platform_scope()) WITH CHECK (app_platform_scope())',
      t || '_platform_only', t);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.scheduler_job_expectations TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON public.scheduler_heartbeat        TO ordence_app;

    -- ══════════════════════════════════════════════════════════════════
    -- 🔴 GRANTING THREE PRIVILEGES DOES NOT TAKE THE FOURTH AWAY, AND ON
    --    THIS TABLE THE FOURTH IS THE ALARM ITSELF.
    -- ══════════════════════════════════════════════════════════════════
    -- `scheduler_job_expectations` IS the dead man switch's memory. A row
    -- deleted from it is a job that stops being watched — silently, with
    -- no alarm, which is precisely the state this file exists to end.
    -- Retiring a job is an UPDATE setting `retired_at`, never a DELETE,
    -- for exactly that reason: a retired row still records that the job
    -- existed and what it promised.
    --
    -- ⚠️ AND WITHHOLDING IS NOT REMOVING. `npm run test:bootstrap` sets
    -- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO
    -- ordence_app` (bootstrap-test-db.mjs:189), so every table created
    -- afterwards arrives with DELETE and TRUNCATE already granted.
    --
    -- 🔴 TRUNCATE IS THE WORSE OF THE TWO HERE. It is not subject to
    -- row-level security at all, and one TRUNCATE of this table turns
    -- `scheduler_overdue()` into a function that returns nothing, forever,
    -- for every job — a permanently green watchdog watching nothing.
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public.scheduler_job_expectations, public.scheduler_heartbeat
      FROM ordence_app;
    REVOKE ALL ON public.scheduler_job_expectations, public.scheduler_heartbeat
      FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.scheduler_overdue(timestamptz) TO ordence_app;
    GRANT EXECUTE ON FUNCTION public.scheduler_watchdog_status(timestamptz, integer) TO ordence_app;
    GRANT EXECUTE ON FUNCTION public.scheduler_reclaim_stale(timestamptz, integer) TO ordence_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT SELECT, INSERT, UPDATE ON public.scheduler_job_expectations TO ordence_maintenance;
    GRANT SELECT, INSERT, UPDATE ON public.scheduler_heartbeat        TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.scheduler_overdue(timestamptz) TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.scheduler_watchdog_status(timestamptz, integer) TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.scheduler_reclaim_stale(timestamptz, integer) TO ordence_maintenance;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 6 — VERIFY BY EXECUTING, INCLUDING THE FOUR WRONG ANSWERS
-- ----------------------------------------------------------------------------
--
-- ⚠️ EVERY ASSERTION BELOW USES A FIXED `as_of` RATHER THAN `now()`, so the
-- test is about the predicate and never about how long the migration took.

DO $$
DECLARE
  t0          timestamptz := timestamptz '2026-06-01 00:00:00+00';
  n           integer;
  hit         boolean;
  status_ok   boolean;
  status_head text;
BEGIN
  PERFORM set_config('app.platform_scope', 'on', true);

  BEGIN
    /* 6a. A job declared and never run is NOT overdue inside its window - */
    INSERT INTO public.scheduler_job_expectations
      (job_id, lane, label, cron_utc, max_silence_seconds, consequence, declared_at)
    VALUES
      ('__0131_never', 'app', 'Self-test: never run', '0 * * * *', 3600,
       'Self-test only.', t0);

    IF EXISTS (SELECT 1 FROM public.scheduler_overdue(t0 + interval '10 minutes')
                WHERE job_id = '__0131_never') THEN
      RAISE EXCEPTION
        '0131 FAILED: a job declared 10 minutes ago with a 3600s window is '
        'already overdue. The watchdog would page on every deploy, which is '
        'how a watchdog gets switched off.'
        USING ERRCODE = '23000';
    END IF;

    /* 6b. ...and IS overdue once the window passes ---------------------- */
    IF NOT EXISTS (SELECT 1 FROM public.scheduler_overdue(t0 + interval '61 minutes')
                    WHERE job_id = '__0131_never') THEN
      RAISE EXCEPTION
        '0131 FAILED: a job silent for 61 minutes against a 3600s window is '
        'NOT reported overdue. The alarm does not fire.'
        USING ERRCODE = '23000';
    END IF;

    /* 6c. THE NULL TRAP: never-run is reported, and reported as never-run */
    SELECT ever_ran INTO hit
      FROM public.scheduler_overdue(t0 + interval '61 minutes')
     WHERE job_id = '__0131_never';
    IF hit IS DISTINCT FROM false THEN
      RAISE EXCEPTION
        '0131 FAILED: a job that has never succeeded is not flagged '
        'ever_ran = false. If the overdue predicate compared a NULL '
        'last-success directly it would have excluded this row entirely, '
        'and a job that has never run once would read as healthy forever — '
        'which is the state this whole product was in.'
        USING ERRCODE = '23000';
    END IF;

    /* 6d. A FAILED run is not a success --------------------------------- */
    INSERT INTO public.scheduler_job_expectations
      (job_id, lane, label, cron_utc, max_silence_seconds, consequence, declared_at)
    VALUES
      ('__0131_failing', 'app', 'Self-test: fails nightly', '0 * * * *', 3600,
       'Self-test only.', t0);

    INSERT INTO public.scheduler_runs
      (job_id, slot_at, run_kind, state, triggered_by, claimed_at, started_at,
       finished_at, heartbeat_at, error)
    VALUES
      ('__0131_failing', t0 + interval '55 minutes', 'scheduled', 'failed',
       'migration:0131', t0 + interval '55 minutes', t0 + interval '55 minutes',
       t0 + interval '56 minutes', t0 + interval '56 minutes', 'self-test');

    IF NOT EXISTS (SELECT 1 FROM public.scheduler_overdue(t0 + interval '61 minutes')
                    WHERE job_id = '__0131_failing') THEN
      RAISE EXCEPTION
        '0131 FAILED: a job that ran five minutes ago AND FAILED is reported '
        'punctual. The predicate is measuring last RUN, not last SUCCESS, so '
        'a job failing every single night looks perfectly healthy.'
        USING ERRCODE = '23000';
    END IF;

    /* 6e. A run still IN FLIGHT is not a success ------------------------ */
    INSERT INTO public.scheduler_job_expectations
      (job_id, lane, label, cron_utc, max_silence_seconds, consequence, declared_at)
    VALUES
      ('__0131_wedged', 'app', 'Self-test: wedged mid-run', '0 * * * *', 3600,
       'Self-test only.', t0);

    INSERT INTO public.scheduler_runs
      (job_id, slot_at, run_kind, state, triggered_by, claimed_at, started_at, heartbeat_at)
    VALUES
      ('__0131_wedged', t0 + interval '55 minutes', 'scheduled', 'running',
       'migration:0131', t0 + interval '55 minutes', t0 + interval '55 minutes',
       t0 + interval '55 minutes');

    IF NOT EXISTS (SELECT 1 FROM public.scheduler_overdue(t0 + interval '61 minutes')
                    WHERE job_id = '__0131_wedged') THEN
      RAISE EXCEPTION
        '0131 FAILED: a job wedged mid-run counts as having run. A job stuck '
        'since 06:00 would hold its claim and never alarm.'
        USING ERRCODE = '23000';
    END IF;

    /* 6f. A SUCCESS clears it, and only until the window passes again ---- */
    INSERT INTO public.scheduler_runs
      (job_id, slot_at, run_kind, state, triggered_by, claimed_at, started_at,
       finished_at, heartbeat_at)
    VALUES
      ('__0131_never', t0 + interval '60 minutes', 'scheduled', 'succeeded',
       'migration:0131', t0 + interval '60 minutes', t0 + interval '60 minutes',
       t0 + interval '61 minutes', t0 + interval '61 minutes');

    IF EXISTS (SELECT 1 FROM public.scheduler_overdue(t0 + interval '70 minutes')
                WHERE job_id = '__0131_never') THEN
      RAISE EXCEPTION
        '0131 FAILED: a job that succeeded 9 minutes ago is still reported '
        'overdue. The alarm never clears, so it gets muted.'
        USING ERRCODE = '23000';
    END IF;

    -- ⭐ AND THIS IS THE "DEMONSTRATED BY DISABLING ONE" CASE: the same job,
    -- same row, nothing changed except that time passed and no further run
    -- arrived.
    IF NOT EXISTS (SELECT 1 FROM public.scheduler_overdue(t0 + interval '125 minutes')
                    WHERE job_id = '__0131_never') THEN
      RAISE EXCEPTION
        '0131 FAILED: a job that succeeded once and then stopped is never '
        'reported overdue again. That is the six-weeks-and-nobody-noticed '
        'failure, unchanged.'
        USING ERRCODE = '23000';
    END IF;

    /* 6g. A RETIRED job stops alarming ---------------------------------- */
    UPDATE public.scheduler_job_expectations
       SET retired_at = t0 + interval '30 minutes'
     WHERE job_id = '__0131_wedged';

    IF EXISTS (SELECT 1 FROM public.scheduler_overdue(t0 + interval '125 minutes')
                WHERE job_id = '__0131_wedged') THEN
      RAISE EXCEPTION
        '0131 FAILED: a retired job still alarms. An alarm that cannot be '
        'cleared correctly is one somebody clears incorrectly, by muting the '
        'lot.'
        USING ERRCODE = '23000';
    END IF;

    /* 6h. NO HEARTBEAT AT ALL is not "unknown", it is the worst reading -- */
    DELETE FROM public.scheduler_heartbeat WHERE id = 'tick';

    SELECT ok, headline INTO status_ok, status_head
      FROM public.scheduler_watchdog_status(t0 + interval '125 minutes', 900);

    IF status_ok IS DISTINCT FROM false THEN
      RAISE EXCEPTION
        '0131 FAILED: with NO heartbeat row at all, watchdog status ok = %. '
        'A deployment whose cron service was never created would answer '
        'green — which is the single most likely real-world state of this '
        'system on the day it ships.', coalesce(status_ok::text, 'NULL')
        USING ERRCODE = '23000';
    END IF;

    IF status_head NOT LIKE 'NO HEARTBEAT EVER%' THEN
      RAISE EXCEPTION
        '0131 FAILED: a missing heartbeat produced the headline "%", which '
        'does not tell the reader the clock has never run.', status_head
        USING ERRCODE = '23000';
    END IF;

    /* 6h2. NO HEARTBEAT *AND* NOTHING OVERDUE — THE THREE-VALUED-LOGIC HOLE
     *
     * 🔴 THIS CASE WAS ADDED AFTER 6h ABOVE FAILED TO CATCH A REAL DEFECT
     * IN THIS FILE, AND IT IS LEFT RECORDED RATHER THAN QUIETLY MERGED.
     *
     * The first draft of Section 4 was written without the COALESCE onto
     * bigint-max, so `heartbeat_age_seconds` was NULL when no heartbeat
     * existed. I removed that COALESCE from a copy of this file to check
     * that 6h would catch it. 6h reported PASS.
     *
     * The reason is three-valued logic. At the moment 6h runs, some jobs
     * ARE overdue, so `ok` evaluates to `false AND NULL`, which Postgres
     * folds to `false` — the assertion `ok IS false` held for a reason that
     * had nothing to do with the heartbeat. Retire every expectation first
     * and the same expression becomes `true AND NULL`, which is NULL: not
     * false, not true, and `NextResponse.json({ ok: null })` reaching a
     * monitor that tests `ok === false` is a green tick on a system with no
     * clock at all.
     *
     * A test that passes because of an unrelated term is a floor. This is
     * the same class of defect as `count(*) >= 10 THEN 'PASS'`, found in
     * the file written to prevent it, one hour after writing the comment
     * at the top of Section 3 that lists the four ways it goes wrong.
     */
    UPDATE public.scheduler_job_expectations SET retired_at = t0 WHERE retired_at IS NULL;
    DELETE FROM public.scheduler_heartbeat WHERE id = 'tick';

    SELECT ok, headline INTO status_ok, status_head
      FROM public.scheduler_watchdog_status(t0 + interval '125 minutes', 900);

    IF status_ok IS NULL THEN
      RAISE EXCEPTION
        '0131 FAILED: with nothing overdue and NO heartbeat, ok is NULL, not '
        'false. `overdue = 0 AND (NULL <= 900)` is NULL in SQL, and a JSON '
        'body carrying ok: null reads as "not false" to every monitor that '
        'tests for false. heartbeat_age_seconds must COALESCE a missing '
        'heartbeat to an infinitely stale value, never to NULL.'
        USING ERRCODE = '23000';
    END IF;

    IF status_ok IS DISTINCT FROM false THEN
      RAISE EXCEPTION
        '0131 FAILED: nothing overdue and no heartbeat at all reported '
        'ok = %. A deployment whose cron service was never created answers '
        'green.', status_ok::text
        USING ERRCODE = '23000';
    END IF;

    /* 6i. A stale heartbeat is red even with every job punctual ---------- */
    INSERT INTO public.scheduler_heartbeat (id, beat_at, source)
    VALUES ('tick', t0 + interval '60 minutes', 'migration:0131');

    SELECT ok INTO status_ok
      FROM public.scheduler_watchdog_status(t0 + interval '125 minutes', 900);
    IF status_ok IS DISTINCT FROM false THEN
      RAISE EXCEPTION
        '0131 FAILED: zero overdue jobs and a 65-minute-old heartbeat '
        'reported ok = %. The clock is dead and the answer was green — '
        'which is what happens when the only thing watched is the jobs.',
        coalesce(status_ok::text, 'NULL')
        USING ERRCODE = '23000';
    END IF;

    SELECT ok INTO status_ok
      FROM public.scheduler_watchdog_status(t0 + interval '65 minutes', 900);
    IF status_ok IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        '0131 FAILED: nothing overdue and a 5-minute-old heartbeat still '
        'reported ok = %. The endpoint would be red permanently and '
        'therefore ignored.', coalesce(status_ok::text, 'NULL')
        USING ERRCODE = '23000';
    END IF;

    /* 6j. Stale claims are reclaimed, live ones are not ------------------ */
    n := public.scheduler_reclaim_stale(t0 + interval '125 minutes', 1800);
    IF n <> 1 THEN
      RAISE EXCEPTION
        '0131 FAILED: scheduler_reclaim_stale reclaimed % rows, expected 1 '
        '(the wedged run whose heartbeat is 70 minutes old). A crashed '
        'executor would hold its slot forever and the job would never run '
        'again.', n
        USING ERRCODE = '23000';
    END IF;

    n := public.scheduler_reclaim_stale(t0 + interval '125 minutes', 1800);
    IF n <> 0 THEN
      RAISE EXCEPTION
        '0131 FAILED: reclaiming twice reclaimed % rows the second time. '
        'It is not idempotent.', n
        USING ERRCODE = '23000';
    END IF;

    /* 6k. A dangerous staleness threshold is refused --------------------- */
    hit := false;
    BEGIN
      n := public.scheduler_reclaim_stale(t0, 30);
    EXCEPTION WHEN OTHERS THEN
      hit := true;
    END;
    IF NOT hit THEN
      RAISE EXCEPTION
        '0131 FAILED: a 30-second staleness threshold was accepted. A '
        'healthy run would be declared dead and its slot handed to a second '
        'executor, manufacturing the double execution 0129 prevents.'
        USING ERRCODE = '23000';
    END IF;

    RAISE EXCEPTION 'ROLLBACK_0131_SELFTEST';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'ROLLBACK_0131_SELFTEST' THEN RAISE; END IF;
  END;

  RAISE NOTICE
    '0131 PASS: a new job does not alarm inside its window and does once it '
    'passes; a job that has NEVER succeeded is reported (the NULL trap); a '
    'failing job and a wedged job both alarm (last SUCCESS, not last run); a '
    'success clears the alarm and time re-raises it; a retired job stops; a '
    'missing heartbeat is red rather than unknown; a stale heartbeat is red '
    'with zero overdue jobs; stale claims are reclaimed exactly once; a '
    'sub-60s staleness threshold is refused; and with nothing overdue and no '
    'heartbeat, ok is FALSE and not NULL. All test rows rolled back.';
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 7 — `updated_at` MUST ACTUALLY MOVE
-- ----------------------------------------------------------------------------
--
-- 🔴 CAUGHT BY `npm run test:security`, NOT BY READING, AND IT IS THE SECOND
--    TIME IN THIS WAVE THAT A COLUMN LOOKED MAINTAINED AND WAS NOT.
--
-- `tests/security/wave13-coverage.test.ts` asserts that every base table with
-- an `updated_at` column has a trigger executing `set_updated_at()` or
-- `ordence_touch_updated_at()`. Without one the column is written once on
-- INSERT and never moves again — so it reads like a modification time, is
-- shown as a modification time, and is a creation time. 0126 swept 303 tables
-- to close exactly this, and this file re-opened it for scheduler_job_expectations.
--
-- ⚠️ THE SWEEP FUNCTION IS CALLED RATHER THAN THE TRIGGER HAND-WRITTEN, which
-- is what 0126's own COMMENT asks for: "Call this from a module migration
-- instead of hand-listing tables." It is keyed on the FUNCTION rather than the
-- trigger name, so it cannot attach a second trigger to a table another file
-- already covered under a different name — the bug 0126 shipped with and had
-- to repair.
--
-- ⚠️ AND THE CALL IS VERIFIED, because a sweep that attaches nothing looks
-- exactly like a sweep that had nothing to attach.

DO $$
DECLARE
  t          text;
  uncovered  text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'attach_updated_at_triggers') THEN
    RAISE NOTICE
      '0131: attach_updated_at_triggers() is not present, so 0126 has not been '
      'applied to this database. The updated_at columns on scheduler_job_expectations '
      'will not move on UPDATE until it is. Apply 0126, then re-run this file.';
    RETURN;
  END IF;

  PERFORM public.attach_updated_at_triggers();

  FOREACH t IN ARRAY ARRAY['scheduler_job_expectations']
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger tg
        JOIN pg_class pc     ON pc.oid = tg.tgrelid
        JOIN pg_namespace pn ON pn.oid = pc.relnamespace
        JOIN pg_proc pp      ON pp.oid = tg.tgfoid
       WHERE NOT tg.tgisinternal
         AND pn.nspname = 'public'
         AND pc.relname = t
         AND pp.proname IN ('set_updated_at', 'ordence_touch_updated_at')
    ) THEN
      uncovered := uncovered || E'\n  - ' || t;
    END IF;
  END LOOP;

  IF uncovered <> '' THEN
    RAISE EXCEPTION
      '0131 FAILED: these tables have an updated_at that is set once on '
      'INSERT and never moves again:%', uncovered
      USING ERRCODE = '23000';
  END IF;

  RAISE NOTICE
    '0131 PASS (updated_at): scheduler_job_expectations carry a trigger that '
    'moves updated_at on every UPDATE.';
END
$$;
