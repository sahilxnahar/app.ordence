-- ############################################################################
-- 0121 — RESTORE THE SEPARATION OF DUTIES ON SECURITY-HISTORY DELETION
--        (Infra wave 12 / v1.79.0-alpha)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- The application role can delete six months of security evidence.
--
-- `prune_security_events(integer, boolean)` is SECURITY DEFINER. It is the
-- ONE sanctioned way past the append-only trigger on `security_events`: it
-- sets `app.allow_security_event_prune` and the BEFORE DELETE trigger stands
-- aside for it. Any role that can EXECUTE it can therefore erase security
-- history regardless of what that role's own table privileges say, because
-- the function does not run with the caller's rights.
--
-- 0012_phase20_secops.sql understood this and said so, in a comment sitting
-- directly inside the grant block:
--
--     GRANT SELECT, INSERT ON security_events TO ordence_app;
--
--     -- Explicitly NOT granted: EXECUTE on prune_security_events(). The web
--     -- application must not be able to delete security history under any
--     -- circumstances, including via a function that is allowed to.
--
-- 0087_hardening_narrow_grants.sql line 282 then did this:
--
--     GRANT EXECUTE ON FUNCTION prune_security_events(integer, boolean)  TO ordence_app;
--
-- HOW A HARDENING FILE UNDID A SECURITY REFUSAL
-- ---------------------------------------------
-- 0087 is not malicious and it is not careless in the ordinary sense. It
-- revoked EXECUTE on ALL FUNCTIONS from PUBLIC, which is correct and
-- overdue, and then had to re-grant the functions the application legitimately
-- calls. Its own comment records the method:
--
--     -- Signatures copied verbatim from the modules that GRANT them.
--
-- That is the defect. Every other signature in that list is granted by its
-- module TO ordence_app. `prune_security_events` is granted by its module TO
-- ordence_maintenance. The signature was copied; the role was not read. The
-- line looks identical to its 30 neighbours and is the only one that reverses
-- an explicit, commented refusal.
--
-- 0012 shipped a verification query for exactly this (Section 6, Check 6:
-- "*** FAIL: the web application can delete security history via
-- prune_security_events(). REVOKE it. ***"). It never fired, because it lives
-- in 0012 and the regression arrived in 0087, seventy-five files later.
-- Nobody re-runs an old file's verification section.
--
-- The permanent control is not this file. It is `npm run check:sealed-grants`
-- (scripts/check-sealed-grants.mjs), added in the same wave, which reads
-- scripts/sealed-grants.json and fails the build if ANY .sql file in the
-- repository grants a sealed privilege — no matter how many files later, and
-- no matter how ordinary the line looks next to its neighbours.
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. REVOKE EXECUTE on prune_security_events() from ordence_app.
--   2. REVOKE it from PUBLIC again, because a SECURITY DEFINER function
--      re-created by any later CREATE OR REPLACE is granted to PUBLIC by
--      default and that alone would restore the hole.
--   3. Re-assert the maintenance-role grant, so the retention job still runs.
--   4. Do the same for prune_usage_counters(), which carries the identical
--      "Explicitly NOT granted" comment in 0013 and is the same shape. It is
--      NOT currently mis-granted; this is a seal, not a repair.
--   5. Verify, and RAISE EXCEPTION if the revoke did not take.
--
-- IS THERE DATA LOSS?  No. This file changes privileges only. It touches no
-- row in any table.
--
-- RUN ORDER
-- ---------
-- Any time after 0087. Idempotent. Safe to run repeatedly.
--
-- ⚠️ NO BEGIN/COMMIT. A browser SQL console sends each statement on its own
-- connection, so a file-level transaction is decoration: a failure halfway
-- through leaves the earlier statements committed and the console reports
-- success. Each DO block below is independently idempotent instead, which is
-- the property that actually holds. (`check:sql-rls-writes` enforces this and
-- caught the first draft of this very file.)
-- Ordered relative to the code push: THIS SQL RUNS FIRST, then the code.
-- (Nothing in the application calls prune_security_events, so the reverse
-- order is also safe — but SQL-first is the standing rule.)
--
-- RLS
-- ---
-- Not applicable. No table is created or altered.
-- ############################################################################

-- ----------------------------------------------------------------------------
-- SECTION 1 — REVOKE
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'prune_security_events'
  ) THEN
    RAISE NOTICE
      '0121: prune_security_events() is not present in this database. '
      'Nothing to revoke. This is expected only on a database that has not '
      'yet applied 0012_phase20_secops.sql.';
    RETURN;
  END IF;

  -- (2) PUBLIC first. A SECURITY DEFINER function is EXECUTE-to-PUBLIC by
  -- default on creation, so this must be re-asserted every time the function
  -- could have been replaced.
  REVOKE ALL ON FUNCTION prune_security_events(integer, boolean) FROM PUBLIC;

  -- (1) The application role. This is the line that closes the finding.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE EXECUTE ON FUNCTION prune_security_events(integer, boolean)
      FROM ordence_app;
    RAISE NOTICE '0121: EXECUTE on prune_security_events() revoked from ordence_app.';
  END IF;

  -- (3) The role that is SUPPOSED to hold it keeps holding it.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT EXECUTE ON FUNCTION prune_security_events(integer, boolean)
      TO ordence_maintenance;
  END IF;
END
$$;


-- (4) The same shape, one module over. Metering counters are billing evidence.
--
-- Written against pg_proc rather than a hard-coded signature. 0013 declares
-- prune_usage_counters(interval); a later file could add an overload, and a
-- hard-coded signature would silently miss it — which is the exact failure
-- mode this whole file exists to correct.

DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'prune_usage_counters'
      AND n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM ordence_app', fn);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ordence_maintenance', fn);
    END IF;

    RAISE NOTICE '0121: sealed %', fn;
  END LOOP;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 2 — VERIFY, AND FAIL THE MIGRATION IF THE REVOKE DID NOT TAKE
-- ----------------------------------------------------------------------------
--
-- 0012 put its equivalent check in a SELECT that prints a verdict. A printed
-- verdict is not a control: the migration runner exits 0 either way and
-- nobody reads the notices. This one raises.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prune_security_events') THEN
    RETURN;
  END IF;

  IF has_function_privilege(
       'ordence_app', 'prune_security_events(integer, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION
      '0121 FAILED: ordence_app still holds EXECUTE on prune_security_events(). '
      'The revoke did not take. The most likely cause is a role that INHERITS '
      'the privilege from a group — check pg_auth_members for ordence_app. '
      'Do not deploy with this outstanding: it lets a compromised web tier '
      'erase the record of the compromise.'
      USING ERRCODE = '42501';
  END IF;

  RAISE NOTICE
    '0121 PASS: pruning security history requires a privileged role again.';
END
$$;
