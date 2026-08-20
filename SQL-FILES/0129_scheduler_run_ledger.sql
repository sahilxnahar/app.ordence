-- ############################################################################
-- 0129 — THE RUN LEDGER: ONE ROW PER (JOB, SCHEDULED SLOT), CLAIMED ONCE
--        (Wave 14 / Track A — scheduler and the job control plane)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- `server/scheduling/registry.ts` registers eight jobs and
-- `app/api/workers/route.ts` runs them. Nothing records that a run happened.
-- `runScheduledJob` returns a `ScheduledJobRun` object, the route serialises
-- it into an HTTP response, and the response is discarded. So:
--
--   • "did dunning_sweep run last night?" has no answer,
--   • "has it run twice?" has no answer,
--   • "has it stopped running?" has no answer, which is the dangerous one,
--   • and nothing anywhere prevents the same slot executing twice.
--
-- 🔴 WHY DOUBLE EXECUTION IS NOT A COSMETIC PROBLEM HERE. `dunning_sweep`
-- advances a statutory collections ladder. A second execution of the same
-- day's slot against a workspace whose ON CONFLICT key does not cover the
-- case sends a customer a second demand notice carrying a different serial
-- number. In India a demand notice is an instrument served under statute;
-- two of them for one debt at two serial numbers is a defect a court can see.
-- The individual jobs argue their own idempotency (see `idempotency:` on each
-- registry entry) and those arguments are good, but they are arguments about
-- the WORK. This file is about the SLOT, which is a different claim: even a
-- job whose work is not idempotent must not have its slot executed twice.
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. Creates `scheduler_runs`, one row per attempt.
--   2. Creates the partial unique index that IS the claim. A run for a slot
--      is taken by `INSERT ... ON CONFLICT DO NOTHING RETURNING id`: the
--      first caller gets a row back and runs, every other caller gets zero
--      rows back and stands down. There is no read-then-write window.
--   3. FORCE ROW LEVEL SECURITY with a platform-scope policy, and grants that
--      let the application write the ledger but never delete from it.
--   4. PROVES THE CLAIM BY EXECUTING IT. Section 5 inserts a slot twice
--      inside a savepoint and RAISES if the second insert succeeds, then
--      rolls the savepoint back. A catalog check ("the index exists") would
--      have passed on an index created without `NULLS NOT DISTINCT`, under
--      which two platform-scoped runs of the same slot BOTH claim it,
--      because in SQL two NULLs are not equal. That is a floor, not a proof.
--
-- IS THERE DATA LOSS?  No. One new table, one new index, no existing object
-- is altered and no row anywhere is deleted or updated.
--
-- RUN ORDER
-- ---------
-- 🔴 THIS SQL RUNS FIRST, THEN THE CODE. `server/scheduler/ledger.ts` writes
-- to `scheduler_runs` on the first tick. Code first means every tick fails
-- with 42P01 until the SQL lands — which is loud and recoverable, but there
-- is no reason to choose it. 0129 → 0130 → 0131 → 0132, then push.
--
-- ⚠️ NO BEGIN/COMMIT. The Neon console sends each statement on its own
-- connection, so a file-level transaction is decoration: a failure halfway
-- through leaves the earlier statements committed and the console reports
-- success. Each block below is independently idempotent instead.
--
-- RLS
-- ---
-- `scheduler_runs` is OPERATIONAL DATA OWNED BY THE PLATFORM, not tenant
-- content. `subject_tenant_id` records which workspace a run was FOR; it does
-- not make the row that workspace's property, and the column is deliberately
-- NOT called `tenant_id` for that reason. The policy is therefore
-- `app_platform_scope()` on both USING and WITH CHECK, which is the same
-- shape `reserved_slugs` uses (0091).
--
-- ⚠️ WITH CHECK CARRIES THE PLATFORM CLAUSE HERE, WHICH MOST TABLES DO NOT.
-- `withPlatformScope()` in `db/index.ts` documents itself as READ ONLY
-- because the marker appears in no other table's WITH CHECK. That property
-- is deliberate and is not weakened by this file: a policy on a NEW table
-- that holds no tenant content cannot widen the write boundary on any
-- existing one. The scheduler must be able to record that it ran, and there
-- is no tenant whose context it could record that under — a platform sweep
-- has no current tenant when it starts.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — THE TABLE
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scheduler_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The registry id, e.g. 'dunning_sweep'. Text and not an enum: the catalog
  -- is code, jobs are added by writing TypeScript, and a migration required
  -- to add a job is a job nobody adds.
  job_id            text        NOT NULL,

  -- 'app'         — executed by the Next.js application as `ordence_app`.
  -- 'maintenance' — executed by the cron service as `ordence_maintenance`,
  --                 because the function it calls is one 0121 and 0128
  --                 deliberately refuse to the application role. See
  --                 0132 and docs/SCHEDULER.md.
  lane              text        NOT NULL DEFAULT 'app',

  -- The workspace this run was FOR. NULL for a platform-scoped job.
  -- ⚠️ NOT `tenant_id`, and not a foreign key. A run against a workspace
  -- that is later deleted is still a record that the run happened; ON DELETE
  -- CASCADE here would erase operational history as a side effect of a
  -- customer leaving.
  subject_tenant_id uuid,

  -- The scheduled slot this run belongs to, truncated to the minute.
  -- NULL means "no slot" — a manual run, which is never blocked and never
  -- blocks. Everything else must name its slot.
  slot_at           timestamptz,

  -- 'scheduled' — the clock reached this slot.
  -- 'backfill'  — an operator is deliberately running a slot in the past.
  --               🔴 THIS IS THE REPLAY MARKER. It shares the slot claim
  --               with 'scheduled' on purpose (see the index below): a slot
  --               that already ran cannot be replayed into a second
  --               execution, only read.
  -- 'manual'    — "run now", slot_at NULL, always permitted, always recorded.
  run_kind          text        NOT NULL,

  state             text        NOT NULL DEFAULT 'claimed',

  claimed_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,

  -- ⚠️ THE LIVENESS SIGNAL, AND IT IS NOT `started_at`. A run that began an
  -- hour ago and is still working is healthy; a run that began an hour ago
  -- and last spoke fifty-nine minutes ago is dead and holding a claim.
  -- Only `heartbeat_at` can tell those apart.
  heartbeat_at      timestamptz NOT NULL DEFAULT now(),

  -- ⭐ THE BUDGET GUARD. Written at claim time from the job's declared
  -- budget. The runner compares against them between workspaces and stops.
  -- A job with a six-hour runaway costs a Railway invoice and a table lock;
  -- a job that stops at its declared budget costs an alert.
  deadline_at       timestamptz,
  max_rows          bigint,
  rows_processed    bigint      NOT NULL DEFAULT 0,

  -- ⭐ COOPERATIVE CANCELLATION. An HTTP handler cannot be preempted from
  -- outside, so 'kill' overrun policy and the operator's Cancel button both
  -- work by setting this and letting the runner notice at its next workspace
  -- boundary. Bounded by one workspace's work, not instantaneous, and said
  -- so in docs/SCHEDULER.md rather than implied to be a real kill.
  cancel_requested  boolean     NOT NULL DEFAULT false,

  outcome           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error             text,

  -- 'tick', 'watchdog', or 'operator:<email>'. Free text on purpose: this is
  -- evidence, and evidence that cannot record an unanticipated actor records
  -- the wrong one.
  triggered_by      text        NOT NULL,

  -- 🔴 REQUIRED FOR ANYTHING A HUMAN STARTED. See the CHECK below.
  justification     text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scheduler_runs_kind_known
    CHECK (run_kind IN ('scheduled', 'backfill', 'manual')),

  CONSTRAINT scheduler_runs_lane_known
    CHECK (lane IN ('app', 'maintenance')),

  CONSTRAINT scheduler_runs_state_known
    CHECK (state IN (
      'claimed',          -- the slot is taken, work has not begun
      'running',
      'succeeded',
      'failed',
      'skipped_paused',   -- a control said do not run this
      'skipped_overrun',  -- the previous run of this job is still going
      'cancelled',
      'abandoned',        -- heartbeat went stale; reclaimed by the watchdog
      'budget_exceeded'
    )),

  -- 🔴 A MANUAL RUN HAS NO SLOT AND A SLOTTED RUN IS NOT MANUAL. Without
  -- this, a 'manual' row carrying a slot would take the slot claim, and a
  -- "run it now to check something" would silently cancel that evening's
  -- real run. That is a bug that only appears in production, once, on the
  -- night somebody was checking something.
  CONSTRAINT scheduler_runs_manual_has_no_slot
    CHECK ((run_kind = 'manual') = (slot_at IS NULL)),

  -- 🔴 A RUN A HUMAN STARTED MUST SAY WHY. The admin surface refuses an
  -- empty justification, but a constraint in the application is a constraint
  -- until somebody adds a second caller. Twenty characters, because "test"
  -- and "asdf" are what an unbounded text field collects.
  CONSTRAINT scheduler_runs_hand_started_is_justified
    CHECK (run_kind = 'scheduled' OR length(coalesce(justification, '')) >= 20),

  -- A finished run has an end. An unfinished one does not claim to.
  CONSTRAINT scheduler_runs_terminal_states_are_finished
    CHECK (
      (state IN ('claimed', 'running')) = (finished_at IS NULL)
    )
);

COMMENT ON TABLE public.scheduler_runs IS
  'One row per scheduled-job attempt. The partial unique index '
  'scheduler_runs_slot_uq is the exactly-once claim: a slot is taken by '
  'INSERT ... ON CONFLICT DO NOTHING RETURNING id. Written by '
  'server/scheduler/ledger.ts and by the maintenance lane in '
  'server/scheduler/maintenance.mjs. The application role may INSERT and '
  'UPDATE and may NOT DELETE; retention is prune_scheduler_runs() in 0132.';

COMMENT ON COLUMN public.scheduler_runs.subject_tenant_id IS
  'Which workspace this run was for. NULL for platform-scoped jobs. '
  'Deliberately not named tenant_id and deliberately not a foreign key: the '
  'row is platform-owned operational history, not tenant content, and it '
  'must survive the workspace it describes.';

COMMENT ON COLUMN public.scheduler_runs.run_kind IS
  'scheduled = the clock reached the slot. backfill = an operator is '
  'replaying a missed slot; it shares the slot claim with scheduled so a '
  'slot that already executed cannot execute again. manual = run now, no '
  'slot, never blocked, always justified.';


-- ----------------------------------------------------------------------------
-- SECTION 2 — THE CLAIM
-- ----------------------------------------------------------------------------
--
-- 🔴 `NULLS NOT DISTINCT` IS THE ENTIRE CORRECTNESS OF THIS FILE FOR
--    PLATFORM-SCOPED JOBS, AND IT IS ONE PHRASE.
--
-- `rate_limit_sweep` and `anomaly_detection` are platform-scoped, so their
-- rows carry `subject_tenant_id = NULL`. Under the default index semantics
-- two NULLs are DISTINCT, so `(rate_limit_sweep, NULL, 20:00)` does not
-- conflict with `(rate_limit_sweep, NULL, 20:00)` and both callers claim the
-- slot and both run. The index exists, the catalog says UNIQUE, and the
-- guarantee is absent for exactly the two jobs that sweep the whole platform.
--
-- Section 5 executes that case rather than asserting the index is present.
--
-- ⚠️ `WHERE slot_at IS NOT NULL` keeps manual runs out of the claim. A "run
-- now" must never be refused because a scheduled run exists, and must never
-- consume a slot.

CREATE UNIQUE INDEX IF NOT EXISTS scheduler_runs_slot_uq
  ON public.scheduler_runs (job_id, subject_tenant_id, slot_at)
  NULLS NOT DISTINCT
  WHERE slot_at IS NOT NULL;

COMMENT ON INDEX public.scheduler_runs_slot_uq IS
  'THE exactly-once claim. NULLS NOT DISTINCT is load-bearing: without it a '
  'platform-scoped job (subject_tenant_id NULL) can claim the same slot '
  'twice, because two NULLs are not equal. Proven by execution in 0129 '
  'Section 5 and by DRILL-DO-NOT-RUN-IN-NEON-0129a-double-claim.sql.';

-- Reads the jobs calendar makes: newest first, per job.
CREATE INDEX IF NOT EXISTS scheduler_runs_job_slot_idx
  ON public.scheduler_runs (job_id, slot_at DESC NULLS LAST);

-- "What is running right now" and "what is holding a claim". Partial, because
-- the answer is a handful of rows out of a table that only grows.
CREATE INDEX IF NOT EXISTS scheduler_runs_inflight_idx
  ON public.scheduler_runs (job_id, heartbeat_at)
  WHERE finished_at IS NULL;

-- The watchdog's read: last success per job.
CREATE INDEX IF NOT EXISTS scheduler_runs_success_idx
  ON public.scheduler_runs (job_id, finished_at DESC)
  WHERE state = 'succeeded';

-- The per-workspace history the admin surface shows on a tenant row.
CREATE INDEX IF NOT EXISTS scheduler_runs_subject_idx
  ON public.scheduler_runs (subject_tenant_id, job_id, claimed_at DESC)
  WHERE subject_tenant_id IS NOT NULL;

-- Retention (0132) deletes on this.
CREATE INDEX IF NOT EXISTS scheduler_runs_claimed_at_idx
  ON public.scheduler_runs (claimed_at);


-- ----------------------------------------------------------------------------
-- SECTION 3 — ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

ALTER TABLE public.scheduler_runs ENABLE ROW LEVEL SECURITY;

-- 🔴 FORCE, NOT MERELY ENABLE. Plain ENABLE exempts the table OWNER, and on
-- Neon the owner is the role that applies migrations and, on some
-- deployments, the role the application connects as. A control that the
-- running application is exempt from is not a control.
ALTER TABLE public.scheduler_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduler_runs_platform_only ON public.scheduler_runs;
CREATE POLICY scheduler_runs_platform_only ON public.scheduler_runs
  USING      (app_platform_scope())
  WITH CHECK (app_platform_scope());

COMMENT ON POLICY scheduler_runs_platform_only ON public.scheduler_runs IS
  'Operational history owned by the platform. A tenant session (which sets '
  'app.current_tenant_id and not app.platform_scope) sees nothing here and '
  'can write nothing here, which is correct: a workspace has no business '
  'reading when the platform swept it, and less business writing it.';


-- ----------------------------------------------------------------------------
-- SECTION 4 — GRANTS
-- ----------------------------------------------------------------------------
--
-- ⚠️ EVERY GRANT IN THIS SECTION IS INERT AGAINST A CONNECTION THAT OWNS THE
-- TABLE. A table owner is not subject to GRANT or REVOKE. If the application
-- ever connects as the owner, the absence of DELETE below stops nothing, and
-- the only control that still holds is the FORCE policy in Section 3. That is
-- why Section 3 exists and why this section is second.
--
-- The grants are still written, because `ordence_app` is the role
-- 0087_hardening_narrow_grants.sql, RAILWAY-EVERYTHING-STEP-BY-STEP.md and
-- scripts/bootstrap-test-db.mjs all say the application connects as, and
-- under that role they are real.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.scheduler_runs TO ordence_app;

    -- ══════════════════════════════════════════════════════════════════
    -- 🔴 THE REVOKE IS NOT DECORATION. GRANTING THREE PRIVILEGES DOES NOT
    --    TAKE THE FOURTH AWAY.
    -- ══════════════════════════════════════════════════════════════════
    -- ⚠️ CAUGHT BY EXECUTING, NOT BY READING, AND THE FIRST DRAFT OF THIS
    -- FILE HAD THE BUG. It granted SELECT, INSERT, UPDATE and said "no
    -- DELETE" in a comment. Privileges ACCUMULATE. `npm run
    -- test:bootstrap` builds its database with
    --
    --     ALTER DEFAULT PRIVILEGES IN SCHEMA public
    --       GRANT ALL ON TABLES TO ordence_app;      (bootstrap-test-db.mjs:189)
    --
    -- so every table created afterwards — including this one — arrives
    -- with DELETE, TRUNCATE, REFERENCES and TRIGGER already granted, and
    -- the narrower grant above sat quietly on top of it changing nothing.
    -- 0132's seal is what found it, on the first bootstrap run.
    --
    -- 0032_engine4_compliance.sql recorded this exact lesson for
    -- `compliance_evidence` and headed it "🔴 CAUGHT BY TESTING, NOT BY
    -- READING". It is the same defect, in a file written four waves later
    -- by somebody who had read that comment.
    --
    -- 🔴 TRUNCATE IS REVOKED TOO, AND IT IS THE MORE DANGEROUS OF THE TWO.
    -- TRUNCATE is not subject to row-level security at all — no policy,
    -- forced or otherwise, sees it — so a role holding TRUNCATE can empty
    -- this table in one statement regardless of Section 3. DELETE at least
    -- has to get past the policy.
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public.scheduler_runs FROM ordence_app;

    RAISE NOTICE
      '0129: ordence_app granted SELECT, INSERT, UPDATE on scheduler_runs; '
      'DELETE, TRUNCATE, REFERENCES and TRIGGER explicitly REVOKED (granting '
      'three does not take the fourth away).';
  END IF;

  -- The same reasoning for PUBLIC, which a `GRANT ... TO PUBLIC` anywhere
  -- in this database's history would have handed the lot to.
  REVOKE DELETE, TRUNCATE ON public.scheduler_runs FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    -- The maintenance lane claims its own slots in the same ledger, so the
    -- jobs calendar shows one list rather than two. It gets DELETE because
    -- prune_scheduler_runs() in 0132 runs as this role's job.
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_runs TO ordence_maintenance;
    RAISE NOTICE '0129: ordence_maintenance granted SELECT, INSERT, UPDATE, DELETE on scheduler_runs.';
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 5 — VERIFY BY EXECUTING, NOT BY READING THE CATALOG
-- ----------------------------------------------------------------------------
--
-- 🔴 WHY THIS DOES THE INSERTS INSTEAD OF CHECKING pg_index.
--
-- Every catalog check available here — "the index exists", "it is unique",
-- "it is partial" — passes on an index built WITHOUT `NULLS NOT DISTINCT`.
-- `indnullsnotdistinct` is readable, so a catalog check COULD be written
-- correctly; but the property that matters is "a second claim is refused",
-- and the only statement that establishes that is a second claim. This is
-- the `count(*) >= 10 THEN 'PASS'` lesson applied to the file that would
-- otherwise repeat it.
--
-- ⚠️ THE SAVEPOINT IS WHY THIS IS SAFE TO RUN ON PRODUCTION. Both inserts
-- are rolled back. The table is empty when this block finishes.

DO $$
DECLARE
  first_id    uuid;
  second_id   uuid;
  was_refused boolean;
  tenant_a    uuid := '00000000-0000-0000-0000-0000000000aa';
  slot        timestamptz := timestamptz '2000-01-01 00:00:00+00';
BEGIN
  -- The policy in Section 3 requires the platform marker for the writes
  -- below. Transaction-local; this DO block is its own transaction.
  PERFORM set_config('app.platform_scope', 'on', true);

  /* ---- 5a. PER-TENANT SLOT: the second claim must return nothing -------- */
  BEGIN
    INSERT INTO public.scheduler_runs
      (job_id, subject_tenant_id, slot_at, run_kind, triggered_by)
    VALUES
      ('__0129_selftest', tenant_a, slot, 'scheduled', 'migration:0129')
    ON CONFLICT DO NOTHING
    RETURNING id INTO first_id;

    INSERT INTO public.scheduler_runs
      (job_id, subject_tenant_id, slot_at, run_kind, triggered_by)
    VALUES
      ('__0129_selftest', tenant_a, slot, 'scheduled', 'migration:0129')
    ON CONFLICT DO NOTHING
    RETURNING id INTO second_id;

    IF first_id IS NULL THEN
      RAISE EXCEPTION
        '0129 FAILED: the FIRST claim for a per-tenant slot returned no row. '
        'The claim cannot succeed even once, so no job would ever run.'
        USING ERRCODE = '23000';
    END IF;

    IF second_id IS NOT NULL THEN
      RAISE EXCEPTION
        '0129 FAILED: the SECOND claim for the SAME (job, tenant, slot) also '
        'returned a row (% and %). The slot can execute twice. '
        'scheduler_runs_slot_uq is missing, not unique, or its predicate '
        'excludes this row.', first_id, second_id
        USING ERRCODE = '23505';
    END IF;

    /* ---- 5b. PLATFORM SLOT: subject_tenant_id IS NULL ------------------- */
    --
    -- 🔴 THE CASE THAT FAILS SILENTLY WITHOUT `NULLS NOT DISTINCT`, and the
    -- reason this block exists at all. rate_limit_sweep and
    -- anomaly_detection are both platform-scoped.
    first_id := NULL;
    second_id := NULL;

    INSERT INTO public.scheduler_runs
      (job_id, subject_tenant_id, slot_at, run_kind, triggered_by)
    VALUES
      ('__0129_selftest_platform', NULL, slot, 'scheduled', 'migration:0129')
    ON CONFLICT DO NOTHING
    RETURNING id INTO first_id;

    INSERT INTO public.scheduler_runs
      (job_id, subject_tenant_id, slot_at, run_kind, triggered_by)
    VALUES
      ('__0129_selftest_platform', NULL, slot, 'scheduled', 'migration:0129')
    ON CONFLICT DO NOTHING
    RETURNING id INTO second_id;

    IF first_id IS NULL THEN
      RAISE EXCEPTION
        '0129 FAILED: the first PLATFORM-scoped claim returned no row.'
        USING ERRCODE = '23000';
    END IF;

    IF second_id IS NOT NULL THEN
      RAISE EXCEPTION
        '0129 FAILED: a PLATFORM-scoped slot (subject_tenant_id IS NULL) was '
        'claimed TWICE (% and %). scheduler_runs_slot_uq was created without '
        'NULLS NOT DISTINCT, so two NULLs are not equal and every '
        'platform-scoped job — rate_limit_sweep, anomaly_detection — can '
        'execute the same slot twice. Drop the index and re-create it with '
        'NULLS NOT DISTINCT.', first_id, second_id
        USING ERRCODE = '23505';
    END IF;

    /* ---- 5c. MANUAL RUNS MUST NOT BE BLOCKED --------------------------- */
    --
    -- Two manual runs of the same job at the same moment are legitimate: an
    -- operator retrying. If the partial predicate were wrong, "run now"
    -- would silently do nothing the second time and look like a UI bug.
    first_id := NULL;
    second_id := NULL;

    INSERT INTO public.scheduler_runs
      (job_id, subject_tenant_id, slot_at, run_kind, triggered_by, justification)
    VALUES
      ('__0129_selftest', tenant_a, NULL, 'manual', 'migration:0129',
       'Migration 0129 self-test: two manual runs must both be recorded.')
    RETURNING id INTO first_id;

    INSERT INTO public.scheduler_runs
      (job_id, subject_tenant_id, slot_at, run_kind, triggered_by, justification)
    VALUES
      ('__0129_selftest', tenant_a, NULL, 'manual', 'migration:0129',
       'Migration 0129 self-test: two manual runs must both be recorded.')
    RETURNING id INTO second_id;

    IF first_id IS NULL OR second_id IS NULL THEN
      RAISE EXCEPTION
        '0129 FAILED: a manual run (slot_at IS NULL) was refused. The claim '
        'index predicate must be WHERE slot_at IS NOT NULL.'
        USING ERRCODE = '23505';
    END IF;

    /* ---- 5d. A HAND-STARTED RUN WITHOUT A REASON MUST BE REFUSED ------- */
    --
    -- ⚠️ THE REFUSAL IS RECORDED IN A FLAG AND ASSERTED AFTERWARDS, not
    -- raised inside the handler's own block. A first draft raised
    -- `USING ERRCODE = '23514'` on the "it was accepted" path — which is
    -- check_violation, which the `WHEN check_violation` handler two lines
    -- below then swallowed. The self-test would have reported PASS on a
    -- database with no CHECK constraint at all. That is this repository's
    -- characteristic defect, reproduced inside the block written to prove
    -- it does not happen, and it is left recorded here rather than quietly
    -- corrected.
    was_refused := false;
    BEGIN
      INSERT INTO public.scheduler_runs
        (job_id, subject_tenant_id, slot_at, run_kind, triggered_by)
      VALUES
        ('__0129_selftest', tenant_a, NULL, 'manual', 'migration:0129');
    EXCEPTION
      WHEN check_violation THEN
        was_refused := true;
    END;

    IF NOT was_refused THEN
      RAISE EXCEPTION
        '0129 FAILED: a manual run with no justification was ACCEPTED. '
        'scheduler_runs_hand_started_is_justified is missing.'
        USING ERRCODE = '23000';
    END IF;

    /* ---- 5e. A MANUAL RUN CARRYING A SLOT MUST BE REFUSED -------------- */
    was_refused := false;
    BEGIN
      INSERT INTO public.scheduler_runs
        (job_id, subject_tenant_id, slot_at, run_kind, triggered_by, justification)
      VALUES
        ('__0129_selftest', tenant_a, slot, 'manual', 'migration:0129',
         'Migration 0129 self-test: a manual run must not take a slot.');
    EXCEPTION
      WHEN check_violation THEN
        was_refused := true;
    END;

    IF NOT was_refused THEN
      RAISE EXCEPTION
        '0129 FAILED: a manual run carrying a slot was ACCEPTED. It would '
        'consume that slot''s claim and silently cancel the real run.'
        USING ERRCODE = '23000';
    END IF;

    -- Everything above proved itself. None of it is kept.
    RAISE EXCEPTION 'ROLLBACK_0129_SELFTEST';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'ROLLBACK_0129_SELFTEST' THEN
        RAISE;
      END IF;
  END;

  RAISE NOTICE
    '0129 PASS: scheduler_runs exists; a second claim on the same '
    '(job, tenant, slot) is refused; a second claim on a PLATFORM slot '
    '(subject_tenant_id IS NULL) is refused, which is the NULLS NOT '
    'DISTINCT case; manual runs are never blocked; a hand-started run '
    'without a justification is refused; a manual run carrying a slot is '
    'refused. All test rows rolled back — the table is empty.';
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 6 — WHAT THIS FILE DOES NOT DO
-- ----------------------------------------------------------------------------
--
-- • It does not schedule anything. The clock is a Railway cron service
--   (railway.cron.json) calling POST /api/workers {"mode":"tick"}. Until
--   that service exists this table stays empty, and `scheduler_overdue()`
--   in 0131 is what makes that emptiness visible rather than restful.
--
-- • It does not retain anything. `scheduler_runs` grows by roughly
--   (tenants x per-tenant jobs) rows a day. At 12 workspaces and the eight
--   registered jobs that is a few hundred rows a day, which is nothing for
--   a year and something after three. `prune_scheduler_runs()` in 0132 is
--   the answer, and it is a maintenance-role function for the same reason
--   prune_change_log() is: the application must not be able to delete its
--   own operational record.
--
-- • It does not add a Drizzle definition, because `db/schema/**` belongs to
--   another stream this wave. `scripts/check-sql-completeness.mjs` will
--   report these tables under "CREATED IN SQL BUT ABSENT FROM db/schema",
--   which is a warning and not a failure. All scheduler reads and writes use
--   raw `sql` templates, as ~166 files in server/ and lib/ already do, so
--   nothing is blocked. PATCH-REQUEST-A.md asks for the definitions.
--   ⚠️ The listed risk — "drizzle-kit push may DROP them" — is not a new
--   one: `npm run db:push` is banned outright in this project.
-- ############################################################################
