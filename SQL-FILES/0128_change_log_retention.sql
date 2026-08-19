-- ############################################################################
-- 0128 — change_log HAS A RETENTION POLICY AND SOMETHING THAT EXECUTES IT
--        (Infra wave 13 / v1.80.0-alpha)
-- ############################################################################
--
-- WHY THIS FILE EXISTS
-- --------------------
-- 0122 attached the change recorder to 215 tables, which was correct and
-- overdue: anything written to those tables could not otherwise reach a second
-- machine. But it means every write in the product is now at least two writes,
-- and the second carries a full `old_row` and `new_row` JSONB snapshot, so the
-- row is roughly doubled again.
--
-- 🔴 AND NOTHING PRUNES IT. `change_log` is the fastest-growing table in this
-- product, nothing in the application ever reads it, `synced_at` stays NULL
-- forever because the sync feature it feeds does not exist yet, and its growth
-- is therefore invisible: no screen shows it and no query touches it.
--
-- ⚠️ THE ARGUMENT FOR THE TABLE IS STILL RIGHT. 0017 makes it well: you cannot
-- reconstruct history you never wrote down, and the two decisions it protects
-- (locally-generated ids, changes recorded as they happen) become impossible
-- to retrofit once data exists. This file does not weaken that. It bounds it.
--
-- ############################################################################
-- 🔴 THE ONE DECISION IN THIS FILE, STATED PLAINLY
-- ############################################################################
--
-- 0017 §5 says pruning is "an administrative operation, deliberately outside
-- the app's reach", and it says pruning SYNCED rows. Every row is unsynced,
-- because there is no sync client. So "delete synced rows older than N" would
-- delete nothing, forever.
--
-- ⚠️ SO THIS PRUNES UNSYNCED ROWS, AND THAT IS A REAL TRADE. A row deleted
-- here is a change no future sync client can ever replay. The alternative is
-- an unbounded table, which on a Neon Free plan is a storage bill and
-- eventually an outage.
--
-- ⭐ THE POLICY IS THEREFORE: retain a WINDOW, not a status.
--
--    • Default 180 days. A client that has been offline six months is doing a
--      full re-sync anyway, which is the supported path for a table that was
--      never in the feed.
--    • REFUSES anything under 30 days, the same floor
--      `prune_security_events()` uses, for the same reason.
--    • Reports what it removed. A retention job that runs silently is
--      indistinguishable from one that does not run.
--
-- 🔴 WHEN SYNC SHIPS, THIS POLICY MUST CHANGE. The predicate must become
--    `synced_at IS NOT NULL AND changed_at < cutoff`, or the first client to
--    go offline for longer than the window loses changes with no error. That
--    is written into the function's own COMMENT so the next reader finds it.
--
-- ############################################################################
--
-- IS THERE DATA LOSS?  Creating the function: no. CALLING it: yes, by design,
-- and only rows older than the window you pass. This file CREATES the
-- machinery and does NOT run it. Running it is a separate, deliberate act.
--
-- RUN ORDER
-- ---------
-- After 0122. SQL FIRST, then the code. Nothing in the application calls this.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent.
--
-- RLS
-- ---
-- Unchanged. `change_log` keeps 0017's tenant-isolation policy. This function
-- is SECURITY DEFINER and runs outside it, which is the point: retention is a
-- platform act across every tenant, not a tenant act.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — THE PRUNE
-- ----------------------------------------------------------------------------

-- ⚠️ DROP FIRST. `CREATE OR REPLACE FUNCTION` cannot change the shape of the
-- returned row, and an earlier draft of this file returned three columns
-- rather than four. Without this DROP, re-running the file on a database that
-- saw the earlier draft fails with "cannot change return type of existing
-- function", which reads as a broken migration rather than a superseded one.
DROP FUNCTION IF EXISTS public.prune_change_log(integer, boolean);

CREATE OR REPLACE FUNCTION public.prune_change_log(
  older_than_days integer DEFAULT 180,
  dry_run         boolean DEFAULT true
)
RETURNS TABLE (rows_affected bigint, tenants_swept integer, oldest_kept timestamptz, was_dry_run boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  cutoff   timestamptz;
  removed  bigint := 0;
  n        bigint;
  swept    integer := 0;
  t        uuid;
BEGIN
  -- ⚠️ THE SAME 30-DAY FLOOR AS prune_security_events(), FOR THE SAME REASON.
  -- A retention window short enough to be useful for storage is short enough
  -- to destroy the thing the table exists for.
  IF older_than_days < 30 THEN
    RAISE EXCEPTION
      'Refusing to prune change_log younger than 30 days (asked for %).',
      older_than_days
      USING ERRCODE = '22023';
  END IF;

  cutoff := now() - make_interval(days => older_than_days);

  -- ══════════════════════════════════════════════════════════════════════
  -- 🔴 WHY THIS LOOPS OVER TENANTS INSTEAD OF ONE `DELETE FROM change_log`
  -- ══════════════════════════════════════════════════════════════════════
  -- The first draft of this file was exactly that one statement, and
  -- `npm run check:sql-rls-writes` refused it:
  --
  --     DELETE FROM on "change_log", which has FORCE ROW LEVEL SECURITY.
  --     The file never sets app.platform_scope, so this is refused for any
  --     role without BYPASSRLS.
  --
  -- ⚠️ AND IT PASSED THE TEST THAT WAS SUPPOSED TO CATCH IT, because the
  -- throwaway PostgreSQL it was tested against owns the function as
  -- `postgres`, a SUPERUSER, which bypasses RLS. On Neon the owner is
  -- `neondb_owner`, which is NOT a superuser and has NO bypassrls, so the
  -- policy applies: `app_current_tenant_id()` is NULL, the DELETE matches
  -- ZERO ROWS, and the function reports success having removed nothing.
  --
  -- That is the same defect this whole wave has been chasing, in a file
  -- written to close one. It is recorded here rather than quietly fixed.
  --
  -- ⭐ AND SETTING PLATFORM SCOPE WOULD NOT HAVE HELPED. 0017's policy is
  -- `USING (tenant_id = app_current_tenant_id())` with no platform branch,
  -- deliberately. Adding one to make a retention job easier would widen the
  -- read boundary on every tenant's entire edit history, which is a
  -- data-protection change and does not belong in a retention file.
  --
  -- So: read the tenant list under platform scope (the `tenants` policy DOES
  -- carry a platform branch, by design), then delete inside each tenant's own
  -- context. No policy changes, no widening, and it works for a non-superuser
  -- owner, which is the only case that matters in production.
  -- ══════════════════════════════════════════════════════════════════════

  PERFORM set_config('app.platform_scope', 'on', true);

  FOR t IN SELECT id FROM tenants ORDER BY id
  LOOP
    swept := swept + 1;

    -- ⚠️ Transaction-local, and re-set on every iteration. The platform
    -- marker above stays on for the tenants read; the tenant marker below is
    -- what the change_log policy actually matches.
    PERFORM set_config('app.current_tenant_id', t::text, true);

    IF dry_run THEN
      SELECT count(*) INTO n FROM change_log WHERE changed_at < cutoff;
    ELSE
      DELETE FROM change_log WHERE changed_at < cutoff;
      GET DIAGNOSTICS n = ROW_COUNT;
    END IF;

    removed := removed + n;
  END LOOP;

  PERFORM set_config('app.current_tenant_id', '', true);

  -- 🔴 A SWEEP THAT SAW NO TENANTS IS A BROKEN SWEEP, NOT AN EMPTY ONE.
  -- Without this, a policy change that hides the tenant list would turn this
  -- function into one that returns 0 forever and looks like a clean database.
  IF swept = 0 THEN
    RAISE EXCEPTION
      'prune_change_log() found ZERO tenants and therefore pruned nothing. '
      'It is not that there is nothing to prune , it is that this function '
      'cannot see the tenant list. Check the `tenants` policy still carries '
      'its platform branch.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT removed, swept, cutoff, dry_run;
END;
$fn$;

COMMENT ON FUNCTION public.prune_change_log(integer, boolean) IS
  'Bounds the change_log window. Defaults to a 180-day retention and to '
  'dry_run = true. Refuses anything under 30 days. '
  '🔴 WHEN SYNC SHIPS THIS MUST CHANGE: the predicate has to become '
  '"synced_at IS NOT NULL AND changed_at < cutoff", or the first client to go '
  'offline longer than the window loses changes with no error. Today every '
  'row is unsynced because no sync client exists, so a status-based predicate '
  'would delete nothing forever, which is why this prunes on age alone.';


-- ----------------------------------------------------------------------------
-- SECTION 2 — WHO MAY CALL IT
-- ----------------------------------------------------------------------------
--
-- ⚠️ NOT THE APPLICATION. 0017 §5 grants the app SELECT and INSERT on
-- change_log and no DELETE, and says why: "a change log the application can
-- rewrite is not a record of what happened, it is a record of what the
-- application currently claims happened." A SECURITY DEFINER prune the app
-- could call would hand back exactly what that REVOKE withheld , which is
-- character for character the defect 0121 had to repair on
-- prune_security_events().

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.prune_change_log(integer, boolean) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON FUNCTION public.prune_change_log(integer, boolean) FROM ordence_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT EXECUTE ON FUNCTION public.prune_change_log(integer, boolean)
      TO ordence_maintenance;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 3 — VERIFY
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prune_change_log') THEN
    RAISE EXCEPTION '0128 FAILED: prune_change_log() was not created.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
     AND EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                   JOIN pg_roles r ON r.oid = a.grantee
                  WHERE p.proname = 'prune_change_log'
                    AND r.rolname = 'ordence_app' AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION
      '0128 FAILED: the application role can execute prune_change_log(). '
      'That hands back the DELETE that 0017 deliberately withheld.'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO n FROM change_log;

  RAISE NOTICE
    '0128 PASS: prune_change_log() exists, dry-run by default, 30-day floor, '
    'not callable by the application. change_log currently holds % row(s). '
    'NOTHING HAS BEEN DELETED. See Section 4 for how to actually run it.', n;
END
$$;


-- ############################################################################
-- SECTION 4 — HOW TO USE IT. NOTHING BELOW RUNS AUTOMATICALLY.
-- ############################################################################
--
-- 🔴 THERE IS NO SCHEDULER ATTACHED TO THIS PRODUCT, so this function will
-- never run on its own. Until a cron service exists, this is a thing you do
-- by hand, roughly monthly, and the dry run tells you whether it is worth it.
--
--   -- 1. SEE what a 180-day window would remove. Removes nothing.
--      SELECT * FROM prune_change_log(180, true);
--
--   -- 2. If the number looks right, DO it.
--      SELECT * FROM prune_change_log(180, false);
--
--   -- 3. Reclaim the disk. DELETE marks rows dead; it does not shrink the
--      -- table. On Neon this is what actually reduces your storage bill.
--      VACUUM (ANALYZE) public.change_log;
--
-- ⚠️ RUN THE VACUUM SEPARATELY AND NOT INSIDE A TRANSACTION. VACUUM cannot run
-- in a transaction block. In the Neon console, run it as its own statement.
--
-- ⚠️ THE FIRST PRUNE MAY BE LARGE AND SLOW. If step 1 reports more than a few
-- hundred thousand rows, do it in slices rather than one statement, so you are
-- not holding a long DELETE against a live database:
--
--      SELECT * FROM prune_change_log(360, false);   -- oldest first
--      SELECT * FROM prune_change_log(270, false);
--      SELECT * FROM prune_change_log(180, false);
--
-- ⭐ AND WHEN THE SCHEDULER EXISTS, this belongs beside prune_security_events()
-- and prune_usage_counters() as a maintenance-role job, not an application one.
-- All three are now written and all three are waiting on the same half-day of
-- configuration.
-- ############################################################################
