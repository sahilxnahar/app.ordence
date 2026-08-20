-- ############################################################################
-- 0130 — THE CONTROL PLANE: PAUSE A JOB, PAUSE ONE WORKSPACE, RESCHEDULE ONE
--        WORKSPACE  (Wave 14 / Track A)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- A crontab has one control: delete the line. That is the wrong granularity
-- for this product, and the two cases are both near-certain:
--
--   🔴 A WORKSPACE IN A BILLING DISPUTE MUST BE SUSPENDABLE FROM DUNNING
--      WITHOUT DISABLING DUNNING FOR EVERYONE. `dunning_sweep` advances a
--      statutory collections ladder and queues a demand notice. Continuing
--      to serve notices on a debt the customer has formally disputed is a
--      decision nobody made; the only lever available today is to stop
--      dunning for every workspace, which stops collections for the whole
--      customer base to protect one account. This will be asked for within
--      a month of dunning going live, and the answer must not be "edit the
--      cron".
--
--   🔴 TENANTS ARE IN DIFFERENT STATES WITH DIFFERENT STATUTORY DEADLINES.
--      A single `30 19 * * *` in UTC is one moment for everybody. GST
--      returns, professional tax and labour-welfare-fund filings fall on
--      state-specific days, and a workspace in Karnataka and one in Gujarat
--      do not want the same cadence.
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. `scheduler_job_controls`     — per-job enable/pause + budget and cron
--                                     overrides, global.
--   2. `scheduler_tenant_pauses`    — per-(job, workspace) pause, with a
--                                     mandatory reason, an actor, and an
--                                     optional expiry. `job_id = '*'` pauses
--                                     the workspace from every job.
--   3. `scheduler_tenant_schedules` — per-(job, workspace) cadence override
--                                     with the workspace's own timezone.
--   4. `scheduler_pause_reason(job, tenant, as_of)` — ONE function that
--      answers "is this (job, workspace) paused right now, and why". The
--      application asks the database rather than re-deriving the precedence
--      of global pause / wildcard pause / specific pause / expiry in
--      TypeScript, because two implementations of that precedence would
--      drift and the divergence would be invisible.
--   5. Verifies every one of the above BY EXECUTING IT.
--
-- 🔴 A PAUSE WITHOUT A REASON IS NOT A PAUSE, IT IS AN OUTAGE.
-- Every pause table below has a NOT NULL reason and a CHECK on its length.
-- The failure this prevents is specific and has a shape: somebody pauses
-- dunning for a workspace during a support call in March, the reason lives
-- in that person's memory, they leave in June, and in September nobody can
-- say whether it is safe to resume — so it is never resumed, and that
-- workspace is never chased for anything again. The reason column is what
-- makes a pause reversible.
--
-- IS THERE DATA LOSS?  No. Three new tables and one new function. Nothing
-- existing is altered.
--
-- RUN ORDER: after 0129, before the code push. 0129 → 0130 → 0131 → 0132.
--
-- ⚠️ NO BEGIN/COMMIT — each block is independently idempotent.
--
-- RLS: platform-scope policies on all three tables, for the reason given at
-- length in 0129 Section 3. These are operating controls, not tenant content:
-- a workspace must not be able to read that it has been paused from dunning,
-- and must certainly not be able to pause itself.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — GLOBAL PER-JOB CONTROLS
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scheduler_job_controls (
  job_id            text PRIMARY KEY,

  enabled           boolean     NOT NULL DEFAULT true,

  -- 🔴 REQUIRED WHEN DISABLED. See the CHECK.
  paused_reason     text,
  paused_by         text,
  paused_at         timestamptz,

  -- ⚠️ OVERRIDES ARE NULL BY DEFAULT AND THE CODE IS THE DEFAULT.
  -- A row here does not define the schedule; `server/scheduler/policy.ts`
  -- does. This is an operator's override for an incident, and an override
  -- that has outlived its incident is visible on the jobs calendar as an
  -- override rather than as the schedule.
  cron_override     text,
  max_ms_override   integer     CHECK (max_ms_override IS NULL OR max_ms_override > 0),
  max_rows_override bigint      CHECK (max_rows_override IS NULL OR max_rows_override > 0),

  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text,

  CONSTRAINT scheduler_job_controls_pause_is_explained
    CHECK (enabled OR length(coalesce(paused_reason, '')) >= 20)
);

COMMENT ON TABLE public.scheduler_job_controls IS
  'Operator overrides for one job, globally. Absence of a row means "run as '
  'the code declares", which is the intended steady state — this table '
  'should normally be empty. Disabling a job requires a written reason, '
  'because an unexplained pause is never safely resumed.';


-- ----------------------------------------------------------------------------
-- SECTION 2 — PER-WORKSPACE PAUSE
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scheduler_tenant_pauses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The registry id, or '*' meaning every job.
  job_id            text        NOT NULL,

  -- ⚠️ NOT `tenant_id`, and not a foreign key — see 0129. This row is a
  -- platform decision ABOUT a workspace, not a row belonging to it.
  subject_tenant_id uuid        NOT NULL,

  reason            text        NOT NULL,
  paused_by         text        NOT NULL,
  paused_at         timestamptz NOT NULL DEFAULT now(),

  -- ⭐ NULL means indefinite, which is allowed and is the honest default for
  -- a dispute with no agreed end date. An expiry is offered because the
  -- commonest real case — "hold dunning until the 15th while we reconcile"
  -- — otherwise becomes a permanent pause that nobody remembers to lift.
  expires_at        timestamptz,

  lifted_at         timestamptz,
  lifted_by         text,
  lifted_reason     text,

  CONSTRAINT scheduler_tenant_pauses_reason_is_written
    CHECK (length(reason) >= 20),

  CONSTRAINT scheduler_tenant_pauses_lift_is_complete
    CHECK ((lifted_at IS NULL) = (lifted_by IS NULL))
);

-- One ACTIVE pause per (job, workspace). Lifted rows stay forever: the
-- history of who paused what and why is the point.
CREATE UNIQUE INDEX IF NOT EXISTS scheduler_tenant_pauses_active_uq
  ON public.scheduler_tenant_pauses (job_id, subject_tenant_id)
  WHERE lifted_at IS NULL;

CREATE INDEX IF NOT EXISTS scheduler_tenant_pauses_subject_idx
  ON public.scheduler_tenant_pauses (subject_tenant_id, job_id);

COMMENT ON TABLE public.scheduler_tenant_pauses IS
  'Suspends one workspace from one job (or from every job, job_id = ''*'') '
  'without disabling that job for anybody else. Lifted rows are retained: '
  'the record of who paused a workspace from statutory dunning, when and '
  'why, is evidence.';


-- ----------------------------------------------------------------------------
-- SECTION 3 — PER-WORKSPACE CADENCE
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scheduler_tenant_schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            text        NOT NULL,
  subject_tenant_id uuid        NOT NULL,

  -- A five-field cron expression. Interpreted in `timezone` below, and the
  -- resulting instant is converted to UTC before it becomes a slot, so every
  -- `scheduler_runs.slot_at` in the ledger is comparable regardless of which
  -- workspace it belongs to.
  cron_expr         text        NOT NULL,

  -- ⚠️ AN IANA NAME, NOT AN OFFSET. 'Asia/Kolkata', not '+05:30'. India does
  -- not observe daylight saving so the difference is invisible here today,
  -- and it is exactly the kind of invisible-until-it-is-not that this
  -- product's first non-Indian workspace would discover in production.
  timezone          text        NOT NULL DEFAULT 'Asia/Kolkata',

  reason            text        NOT NULL,
  set_by            text        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scheduler_tenant_schedules_reason_is_written
    CHECK (length(reason) >= 20),

  -- 🔴 THE TIMEZONE MUST BE ONE POSTGRES KNOWS. Without this, a typo
  -- ('Asia/Calcuta') is accepted, every conversion silently falls back, and
  -- that workspace's job runs at the wrong hour with nothing to show why.
  CONSTRAINT scheduler_tenant_schedules_timezone_is_real
    CHECK (now() AT TIME ZONE timezone IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS scheduler_tenant_schedules_uq
  ON public.scheduler_tenant_schedules (job_id, subject_tenant_id);

COMMENT ON TABLE public.scheduler_tenant_schedules IS
  'Runs one job for one workspace on that workspace''s own cadence, in that '
  'workspace''s own timezone. Absent row = the job''s declared UTC cron.';


-- ----------------------------------------------------------------------------
-- SECTION 4 — THE ONE PLACE PRECEDENCE IS DECIDED
-- ----------------------------------------------------------------------------
--
-- 🔴 WHY THIS IS A DATABASE FUNCTION AND NOT TYPESCRIPT.
--
-- Four things can suppress a run: the job is globally disabled, the
-- workspace is paused from this job, the workspace is paused from every job,
-- or a pause has expired and therefore does NOT suppress. Written in
-- TypeScript this is four branches the runner evaluates; written in
-- TypeScript AND consulted by an admin screen that also wants to say "this
-- one is paused", it is four branches in two places, and the day they
-- disagree is the day the screen says paused and the job runs anyway.
--
-- It returns the REASON rather than a boolean, because every caller needs
-- the reason: the runner records it in `scheduler_runs.outcome`, the calendar
-- shows it, and the ledger row that says `skipped_paused` with no reason is
-- the one nobody can act on.

CREATE OR REPLACE FUNCTION public.scheduler_pause_reason(
  p_job_id    text,
  p_tenant_id uuid,
  p_as_of     timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  SELECT reason FROM (
    -- 1. The job is globally disabled. Highest precedence: nothing runs.
    SELECT 1 AS rank,
           'job disabled: ' || coalesce(c.paused_reason, '(no reason recorded)') AS reason
      FROM public.scheduler_job_controls c
     WHERE c.job_id = p_job_id
       AND c.enabled = false

    UNION ALL

    -- 2. This workspace is paused from this job, or from every job.
    --
    -- ⚠️ `p_tenant_id IS NOT NULL` GUARDS THE PLATFORM-SCOPED CASE. A
    -- platform job has no workspace, and `subject_tenant_id = NULL` matches
    -- nothing, so without the guard the branch is simply never true — which
    -- is the right answer reached by accident. Stated, so a later edit
    -- cannot turn it into the wrong answer reached the same way.
    SELECT 2 AS rank,
           'workspace paused from ' ||
             CASE WHEN p.job_id = '*' THEN 'every job' ELSE p.job_id END ||
             ': ' || p.reason AS reason
      FROM public.scheduler_tenant_pauses p
     WHERE p_tenant_id IS NOT NULL
       AND p.subject_tenant_id = p_tenant_id
       AND p.job_id IN (p_job_id, '*')
       AND p.lifted_at IS NULL
       -- 🔴 AN EXPIRED PAUSE DOES NOT SUPPRESS. Without this the expiry
       -- column would be decoration: recorded, displayed, and never
       -- consulted, so every "hold until the 15th" becomes permanent.
       AND (p.expires_at IS NULL OR p.expires_at > p_as_of)
  ) reasons
  ORDER BY rank
  LIMIT 1;
$fn$;

COMMENT ON FUNCTION public.scheduler_pause_reason(text, uuid, timestamptz) IS
  'NULL when this (job, workspace) may run at p_as_of; otherwise the human '
  'reason it may not. The single authority on pause precedence — the runner '
  'and the admin calendar both call this rather than each deciding.';


-- ----------------------------------------------------------------------------
-- SECTION 5 — ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'scheduler_job_controls',
    'scheduler_tenant_pauses',
    'scheduler_tenant_schedules'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE, so the owner is not exempt. See 0129 Section 3.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_platform_only', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (app_platform_scope()) WITH CHECK (app_platform_scope())',
      t || '_platform_only', t);
  END LOOP;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 6 — GRANTS
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    -- ⭐ DELETE IS GRANTED HERE AND WAS REFUSED ON `scheduler_runs`, AND THE
    -- DIFFERENCE IS THE POINT. These three tables are CURRENT INTENT: a
    -- pause is a thing an operator sets and clears, and clearing a control
    -- row is not erasing history. `scheduler_runs` is the RECORD OF WHAT
    -- HAPPENED, and nothing the application does should be able to remove a
    -- row from it.
    --
    -- ⚠️ Lifting a workspace pause is an UPDATE (lifted_at, lifted_by), not
    -- a DELETE — see the active-pause partial index. The DELETE grant covers
    -- removing an override row from scheduler_job_controls and
    -- scheduler_tenant_schedules, which hold no history.
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_job_controls TO ordence_app;
    GRANT SELECT, INSERT, UPDATE          ON public.scheduler_tenant_pauses TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_tenant_schedules TO ordence_app;
    GRANT EXECUTE ON FUNCTION public.scheduler_pause_reason(text, uuid, timestamptz) TO ordence_app;

    -- ══════════════════════════════════════════════════════════════════
    -- 🔴 GRANTING THREE PRIVILEGES DOES NOT TAKE THE FOURTH AWAY.
    -- ══════════════════════════════════════════════════════════════════
    -- The line above withholds DELETE on `scheduler_tenant_pauses`, and
    -- withholding is not removing: privileges accumulate. `npm run
    -- test:bootstrap` sets `ALTER DEFAULT PRIVILEGES IN SCHEMA public
    -- GRANT ALL ON TABLES TO ordence_app` (bootstrap-test-db.mjs:189), so
    -- every table created afterwards arrives with the lot already granted
    -- and a narrower grant on top of it changes nothing. 0032 recorded
    -- this for `compliance_evidence`; 0132's seal caught it here.
    --
    -- 🔴 LIFTING A PAUSE IS AN UPDATE, NEVER A DELETE — see the partial
    -- unique index on `WHERE lifted_at IS NULL`. The record of who paused
    -- a workspace from statutory dunning, when and why, is evidence, and
    -- an application that can delete the row can erase the decision.
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public.scheduler_tenant_pauses FROM ordence_app;

    -- ⚠️ TRUNCATE IS NOT SUBJECT TO ROW-LEVEL SECURITY AT ALL. No policy,
    -- forced or otherwise, sees it — so a role holding TRUNCATE empties
    -- the table in one statement regardless of Section 5. The two tables
    -- that legitimately allow DELETE (an operator clearing an override)
    -- still have no business being truncated.
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON public.scheduler_job_controls, public.scheduler_tenant_schedules
      FROM ordence_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    -- The maintenance lane must honour a global pause on its own jobs.
    GRANT SELECT ON public.scheduler_job_controls    TO ordence_maintenance;
    GRANT SELECT ON public.scheduler_tenant_pauses   TO ordence_maintenance;
    GRANT SELECT ON public.scheduler_tenant_schedules TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.scheduler_pause_reason(text, uuid, timestamptz) TO ordence_maintenance;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
      public.scheduler_job_controls, public.scheduler_tenant_pauses,
      public.scheduler_tenant_schedules FROM ordence_maintenance;
  END IF;

  REVOKE ALL ON public.scheduler_job_controls, public.scheduler_tenant_pauses,
                public.scheduler_tenant_schedules FROM PUBLIC;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 7 — VERIFY BY EXECUTING
-- ----------------------------------------------------------------------------
--
-- Six properties, each one a thing that would otherwise be true only in the
-- comments above it. All rows are rolled back.

DO $$
DECLARE
  tenant_a    uuid := '00000000-0000-0000-0000-0000000000aa';
  tenant_b    uuid := '00000000-0000-0000-0000-0000000000bb';
  was_refused boolean;
  got         text;
  now_fixed   timestamptz := timestamptz '2026-06-01 12:00:00+00';
BEGIN
  PERFORM set_config('app.platform_scope', 'on', true);

  BEGIN
    /* 7a. A pause with no reason is refused ----------------------------- */
    was_refused := false;
    BEGIN
      INSERT INTO public.scheduler_tenant_pauses
        (job_id, subject_tenant_id, reason, paused_by)
      VALUES ('dunning_sweep', tenant_a, 'billing', 'ops');
    EXCEPTION WHEN check_violation THEN
      was_refused := true;
    END;
    IF NOT was_refused THEN
      RAISE EXCEPTION
        '0130 FAILED: a workspace pause with a four-character reason was '
        'ACCEPTED. scheduler_tenant_pauses_reason_is_written is missing, so '
        'a pause can be set that nobody can later judge safe to lift.'
        USING ERRCODE = '23000';
    END IF;

    /* 7b. A real pause suppresses the right (job, workspace) and only it - */
    INSERT INTO public.scheduler_tenant_pauses
      (job_id, subject_tenant_id, reason, paused_by)
    VALUES ('dunning_sweep', tenant_a,
            'Workspace has formally disputed invoice INV-2026-0041; hold the ladder until legal responds.',
            'ops@ordence.com');

    got := public.scheduler_pause_reason('dunning_sweep', tenant_a, now_fixed);
    IF got IS NULL THEN
      RAISE EXCEPTION
        '0130 FAILED: a workspace with an active, unexpired, unlifted pause '
        'on dunning_sweep was reported as RUNNABLE. Dunning would continue '
        'against a disputed debt.'
        USING ERRCODE = '23000';
    END IF;

    IF public.scheduler_pause_reason('mail_drain', tenant_a, now_fixed) IS NOT NULL THEN
      RAISE EXCEPTION
        '0130 FAILED: pausing tenant A from dunning_sweep also paused it '
        'from mail_drain. The pause is not per-job, so pausing one workspace '
        'from collections would also strand its statutory notices in the '
        'outbox.'
        USING ERRCODE = '23000';
    END IF;

    IF public.scheduler_pause_reason('dunning_sweep', tenant_b, now_fixed) IS NOT NULL THEN
      RAISE EXCEPTION
        '0130 FAILED: pausing tenant A also paused tenant B. This is the '
        'exact behaviour the table exists to avoid.'
        USING ERRCODE = '23000';
    END IF;

    /* 7c. An EXPIRED pause does not suppress ---------------------------- */
    INSERT INTO public.scheduler_tenant_pauses
      (job_id, subject_tenant_id, reason, paused_by, expires_at)
    VALUES ('rhythms', tenant_b,
            'Holding rhythm recompute during the data migration agreed on the 2026-05-28 call.',
            'ops@ordence.com',
            now_fixed - interval '1 day');

    IF public.scheduler_pause_reason('rhythms', tenant_b, now_fixed) IS NOT NULL THEN
      RAISE EXCEPTION
        '0130 FAILED: a pause whose expires_at is in the past still '
        'suppresses. Every time-boxed hold becomes permanent.'
        USING ERRCODE = '23000';
    END IF;

    -- ...but it DID suppress before it expired.
    IF public.scheduler_pause_reason('rhythms', tenant_b, now_fixed - interval '2 days') IS NULL THEN
      RAISE EXCEPTION
        '0130 FAILED: a pause did not suppress even BEFORE its expiry. The '
        'expiry predicate is inverted, so every time-boxed pause does '
        'nothing at all.'
        USING ERRCODE = '23000';
    END IF;

    /* 7d. The wildcard pauses every job --------------------------------- */
    INSERT INTO public.scheduler_tenant_pauses
      (job_id, subject_tenant_id, reason, paused_by)
    VALUES ('*', tenant_b,
            'Workspace suspended pending KYC re-verification; no background work of any kind.',
            'ops@ordence.com');

    IF public.scheduler_pause_reason('storage_reconcile', tenant_b, now_fixed) IS NULL THEN
      RAISE EXCEPTION
        '0130 FAILED: a wildcard pause (job_id = ''*'') did not suppress a '
        'named job. A workspace-wide hold would silently apply to nothing.'
        USING ERRCODE = '23000';
    END IF;

    /* 7e. A global disable outranks everything -------------------------- */
    INSERT INTO public.scheduler_job_controls (job_id, enabled, paused_reason, paused_by, paused_at)
    VALUES ('anomaly_detection', false,
            'Detector produced 4,000 findings an hour after the 0128 deploy; paused pending Track F.',
            'ops@ordence.com', now_fixed);

    got := public.scheduler_pause_reason('anomaly_detection', NULL, now_fixed);
    IF got IS NULL OR got NOT LIKE 'job disabled:%' THEN
      RAISE EXCEPTION
        '0130 FAILED: a globally disabled job was reported runnable for a '
        'platform-scoped call (tenant NULL). Got: %', coalesce(got, '(null)')
        USING ERRCODE = '23000';
    END IF;

    /* 7f. Two active pauses for one (job, workspace) are refused --------- */
    was_refused := false;
    BEGIN
      INSERT INTO public.scheduler_tenant_pauses
        (job_id, subject_tenant_id, reason, paused_by)
      VALUES ('dunning_sweep', tenant_a,
              'A second, contradictory hold entered by a different operator on the same account.',
              'other@ordence.com');
    EXCEPTION WHEN unique_violation THEN
      was_refused := true;
    END;
    IF NOT was_refused THEN
      RAISE EXCEPTION
        '0130 FAILED: two ACTIVE pauses were accepted for the same '
        '(job, workspace). Lifting one would leave the other in place and '
        'the screen would report the workspace resumed while it was not.'
        USING ERRCODE = '23000';
    END IF;

    /* 7g. An unknown timezone is refused -------------------------------- */
    was_refused := false;
    BEGIN
      INSERT INTO public.scheduler_tenant_schedules
        (job_id, subject_tenant_id, cron_expr, timezone, reason, set_by)
      VALUES ('dunning_sweep', tenant_a, '0 3 * * *', 'Asia/Calcuta',
              'Customer asked for the ladder to advance at 08:30 their time, not 01:00.',
              'ops@ordence.com');
    EXCEPTION WHEN OTHERS THEN
      was_refused := true;
    END;
    IF NOT was_refused THEN
      RAISE EXCEPTION
        '0130 FAILED: the timezone ''Asia/Calcuta'' (a typo for '
        '''Asia/Calcutta'') was ACCEPTED. Every slot for that workspace '
        'would be computed in the wrong zone with nothing to show why.'
        USING ERRCODE = '23000';
    END IF;

    RAISE EXCEPTION 'ROLLBACK_0130_SELFTEST';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'ROLLBACK_0130_SELFTEST' THEN RAISE; END IF;
  END;

  RAISE NOTICE
    '0130 PASS: a reasonless pause is refused; a pause suppresses exactly '
    'one (job, workspace) and neither the neighbouring job nor the '
    'neighbouring workspace; an expired pause stops suppressing and '
    'suppressed before it expired; the ''*'' wildcard covers every job; a '
    'global disable outranks and applies to platform-scoped jobs; two '
    'active pauses on one pair are refused; an unknown timezone is refused. '
    'All test rows rolled back.';
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 8 — `updated_at` MUST ACTUALLY MOVE
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
-- to close exactly this, and this file re-opened it for scheduler_job_controls and scheduler_tenant_schedules.
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
      '0130: attach_updated_at_triggers() is not present, so 0126 has not been '
      'applied to this database. The updated_at columns on scheduler_job_controls and scheduler_tenant_schedules '
      'will not move on UPDATE until it is. Apply 0126, then re-run this file.';
    RETURN;
  END IF;

  PERFORM public.attach_updated_at_triggers();

  FOREACH t IN ARRAY ARRAY['scheduler_job_controls', 'scheduler_tenant_schedules']
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
      '0130 FAILED: these tables have an updated_at that is set once on '
      'INSERT and never moves again:%', uncovered
      USING ERRCODE = '23000';
  END IF;

  RAISE NOTICE
    '0130 PASS (updated_at): scheduler_job_controls and scheduler_tenant_schedules carry a trigger that '
    'moves updated_at on every UPDATE.';
END
$$;
