-- ############################################################################
-- DRILL 0129a — TWO SCHEDULERS RACE FOR ONE SLOT. ONE WINS.
--
-- 🔴 DO NOT RUN THIS IN NEON. 🔴
--
-- It inserts rows into `scheduler_runs` under a fabricated job id, holds an
-- open transaction against a production table long enough for a second
-- session to block on it, and deletes what it wrote. Run it against a
-- throwaway PostgreSQL 16 and nothing else. The `prune_scheduler_runs()`
-- retention function is the sanctioned way to remove ledger rows on a real
-- database, and it refuses anything under 30 days precisely so that this
-- file's cleanup cannot be repurposed there.
-- ############################################################################
--
-- WHAT THIS PROVES, AND WHY 0129 SECTION 5 IS NOT ENOUGH ON ITS OWN
-- ------------------------------------------------------------------
-- 0129's own self-test issues two claims for one slot SEQUENTIALLY, in one
-- session, and shows the second returns no row. That proves the index is
-- unique and that `ON CONFLICT DO NOTHING ... RETURNING` yields nothing to
-- the loser.
--
-- It does NOT prove the thing the brief actually asks for: "run the same
-- slot twice CONCURRENTLY, show one claim and one skip." Those are
-- different claims. A sequential test passes on a design with a
-- read-then-write race — `SELECT ... IF NOT EXISTS THEN INSERT` is
-- sequentially correct and concurrently broken, and it is the shape most
-- people write first. The window between the read and the write is exactly
-- the window in which two ticks both decide the slot is free.
--
-- ⚠️ AND THIS IS NOT A HYPOTHETICAL RACE. Railway restarts the cron
-- service on a schedule; a tick that overruns its five-minute interval
-- overlaps its successor. Two ticks in flight at once is the normal
-- consequence of one slow night, not an exotic failure.
--
-- THE PROCEDURE — TWO TERMINALS, IN THIS ORDER
-- --------------------------------------------
-- Both connect to the same throwaway database, as a NON-SUPERUSER role
-- that owns the tables (a superuser bypasses RLS and would prove nothing
-- about a database whose only tenant isolation is RLS).
--
--     createdb sched_drill
--     psql -d sched_drill -f SQL-FILES/0129_scheduler_run_ledger.sql
--
-- Then run SESSION A and SESSION B below in two terminals, A first.
--
-- WHAT YOU SHOULD SEE
-- -------------------
--   • A's INSERT returns exactly one id and does NOT commit.
--   • B's identical INSERT HANGS. It is blocked on the unique index, which
--     is the mechanism doing the work: B cannot know whether A's row will
--     exist until A decides.
--   • The moment A commits, B returns ZERO ROWS.
--   • `scheduler_runs` holds ONE row for that slot.
--
-- 🔴 IF B RETURNS A ROW, TWO SCHEDULERS JUST RAN THE SAME SLOT. For
-- `dunning_sweep` that is two statutory demand notices for one debt at two
-- serial numbers, which in India is a legal problem and not a cosmetic one.
--
-- 🔴 IF B DOES NOT HANG, the claim is not being decided by the database.
-- Look for a `SELECT`-then-`INSERT` somewhere: it will pass every
-- sequential test ever written.
-- ############################################################################


-- ────────────────────────────────────────────────────────────────────────
-- SESSION A  — the tick that wins
-- ────────────────────────────────────────────────────────────────────────

-- A1.
BEGIN;
SET LOCAL app.platform_scope = 'on';

INSERT INTO public.scheduler_runs
  (job_id, subject_tenant_id, slot_at, run_kind, triggered_by)
VALUES
  ('__drill_0129a', NULL, timestamptz '2000-01-01 00:00:00+00', 'scheduled', 'drill:A')
ON CONFLICT DO NOTHING
RETURNING id;
--  ⇒ expect: exactly 1 row.

-- ⏸ STOP HERE. Leave this transaction OPEN and go run SESSION B.

-- A2. Only after B is visibly hanging:
COMMIT;


-- ────────────────────────────────────────────────────────────────────────
-- SESSION B  — the tick that stands down
-- ────────────────────────────────────────────────────────────────────────

-- B1. Run this while A's transaction is still open.
BEGIN;
SET LOCAL app.platform_scope = 'on';

INSERT INTO public.scheduler_runs
  (job_id, subject_tenant_id, slot_at, run_kind, triggered_by)
VALUES
  ('__drill_0129a', NULL, timestamptz '2000-01-01 00:00:00+00', 'scheduled', 'drill:B')
ON CONFLICT DO NOTHING
RETURNING id;
--  ⇒ expect: HANGS until A commits, then returns 0 rows.
--
--  ⚠️ THE NULL `subject_tenant_id` IS THE POINT OF USING A PLATFORM-SCOPED
--  ROW HERE. Two NULLs are NOT equal in SQL, so without `NULLS NOT
--  DISTINCT` on the index this insert does not conflict at all: B returns
--  a row immediately, does not hang, and both schedulers run. That is the
--  failure mode for `rate_limit_sweep` and `anomaly_detection`, the two
--  platform-scoped jobs in the registry.

COMMIT;


-- ────────────────────────────────────────────────────────────────────────
-- EITHER SESSION — the verdict
-- ────────────────────────────────────────────────────────────────────────

SET app.platform_scope = 'on';

SELECT
  count(*)                                            AS rows_for_this_slot,
  count(*) FILTER (WHERE triggered_by = 'drill:A')    AS claimed_by_a,
  count(*) FILTER (WHERE triggered_by = 'drill:B')    AS claimed_by_b,
  CASE
    WHEN count(*) = 1 THEN '✅ PASS — one claim, one skip. The slot cannot execute twice.'
    WHEN count(*) = 0 THEN '❓ Neither session inserted. Re-run; A must go first.'
    ELSE '🔴 FAIL — ' || count(*) || ' rows for one slot. Two schedulers ran it. '
         || 'Check scheduler_runs_slot_uq exists WITH NULLS NOT DISTINCT.'
  END                                                 AS verdict
FROM public.scheduler_runs
WHERE job_id = '__drill_0129a';


-- ────────────────────────────────────────────────────────────────────────
-- CLEAN UP  — throwaway database only
-- ────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM set_config('app.platform_scope', 'on', true);

  -- ⚠️ A GUARD, NOT A COURTESY. This DELETE is the one statement in the
  -- file that could do harm somewhere it does not belong, and the whole
  -- point of the fabricated job id is that it matches nothing real.
  IF EXISTS (SELECT 1 FROM public.scheduler_runs WHERE job_id <> '__drill_0129a') THEN
    RAISE NOTICE
      'This database contains real scheduler_runs rows. The DELETE below is '
      'scoped to job_id = ''__drill_0129a'' and touches nothing else — but if '
      'you are reading this notice on Neon, you have run a drill against '
      'production. Stop and check what else this session has done.';
  END IF;

  DELETE FROM public.scheduler_runs WHERE job_id = '__drill_0129a';
END
$$;
