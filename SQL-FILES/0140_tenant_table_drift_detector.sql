-- ############################################################################
-- 0140 — ONE PREDICATE FOR "IS THIS TABLE PROTECTED", RUN CONTINUOUSLY
--        (Wave 15 / Track C)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHY A DETECTOR RATHER THAN A SIXTH SWEEP
-- ══════════════════════════════════════════════════════════════════════════
-- Four separate properties have to hold for every tenant-scoped table:
--
--   1. a policy referencing `app_current_tenant_id()`
--   2. `FORCE ROW LEVEL SECURITY`, because the application owns the tables
--   3. a `record_change()` trigger, or the row cannot reach a second machine
--   4. a `refuse_delete_under_impersonation()` trigger
--
-- Each was installed by a sweep, and each sweep ran once:
--
--     0122  change-log triggers      215 tables, one afternoon
--     0125  impersonation guards     255 tables, one afternoon
--     0126  updated_at triggers       86 tables, one afternoon
--     0136  the six phase-4 tables    this wave
--
-- ⚠️ EVERY ONE OF THOSE FILES EXISTS BECAUSE THE SWEEP BEFORE IT STOPPED
-- BEING RUN. 0014 attached the impersonation guard to a hard-coded array of
-- 19 names; five module files copied the block; then ninety module files
-- shipped without it and 255 tables went unguarded. The same thing happened
-- to the change log, and to `updated_at`. The pattern is not carelessness:
-- it is that a sweep is a THING THAT HAPPENED and coverage is a PROPERTY THAT
-- HAS TO KEEP HOLDING.
--
-- 🔴 AND 0014'S OWN CHECK WAS A FLOOR:
--
--     CASE WHEN count(*) FILTER (WHERE tgname = 'no_delete_under_impersonation') >= 10
--          THEN 'PASS: the impersonation delete guard is installed'
--
-- It printed PASS at 48 of 303. A floor measures how much was done right and
-- cannot see what was done wrong.
--
-- ⭐ SO THIS FILE ADDS NO SWEEP. It adds ONE FUNCTION that returns one row per
-- defect, with the table, the property and what to do about it, and it
-- returns zero rows when the database is clean. `scripts/check-rls-coverage.mjs`
-- calls it on every CI run and fails on any row. The four sweeps stay where
-- they are; what changes is that the day a new table lands without the four
-- properties, the build goes red in that commit rather than in an audit two
-- waves later.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ EXCLUSIONS ARE READ FROM THE TABLES THAT ALREADY DECLARE THEM
-- ══════════════════════════════════════════════════════════════════════════
-- `change_log_exclusions` (15 rows) and `impersonation_guard_exclusions`
-- (13 rows) already exist, each row carrying a written reason and the file
-- that declared it. This function reads them rather than keeping a fifth
-- list. A hard-coded list inside a detector is the thing that goes stale, and
-- there would then be two answers to "is this table exempt".
--
-- `tenants` and `plans` are excluded from the RLS properties for the same
-- reason `scripts/check-rls-coverage.mjs` excludes them: they are the tenant
-- list and the global price list, read across tenants by design. They are
-- named here rather than derived so that adding to the list is visible.
--
-- IS THERE DATA LOSS?  No. One function and one assertion wrapper.
--
-- RUN ORDER
-- ---------
-- After 0122, 0125 and 0136 — it measures what those files installed.
-- SQL FIRST.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent.
--
-- RLS
-- ---
-- No new table. The function is not granted to the application.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — THE PREDICATE
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tenant_table_drift()
RETURNS TABLE (table_name text, property text, detail text)
LANGUAGE sql
STABLE
AS $fn$
  WITH tenant_tables AS (
    SELECT c.oid, c.relname::text AS tbl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                      AND a.attnum > 0 AND NOT a.attisdropped)
       AND c.relname NOT IN ('tenants', 'plans')
  ),
  trig AS (
    SELECT t.oid, p.proname::text AS fn
      FROM tenant_tables t
      JOIN pg_trigger tg ON tg.tgrelid = t.oid AND NOT tg.tgisinternal
      JOIN pg_proc p     ON p.oid = tg.tgfoid
  )

  /* 1 — row security switched on at all */
  SELECT t.tbl, 'rls-enabled'::text,
         'ALTER TABLE ' || t.tbl || ' ENABLE ROW LEVEL SECURITY; then FORCE, '
         'then a tenant policy. Until then every tenant reads every other '
         'tenant''s rows in this table.'
    FROM tenant_tables t
    JOIN pg_class c ON c.oid = t.oid
   WHERE NOT c.relrowsecurity

  UNION ALL

  /* 2 — and FORCED, which is the part that binds the owner */
  SELECT t.tbl, 'rls-forced'::text,
         'ALTER TABLE ' || t.tbl || ' FORCE ROW LEVEL SECURITY. The application '
         'owns this table on Neon, and ENABLE does not apply to a table''s '
         'owner. Without FORCE the policy exists and never runs.'
    FROM tenant_tables t
    JOIN pg_class c ON c.oid = t.oid
   WHERE c.relrowsecurity AND NOT c.relforcerowsecurity

  UNION ALL

  /* 3 — a policy that actually names the tenant function */
  -- ⚠️ "HAS A POLICY" IS NOT THE TEST. RLS with no policy denies everything,
  -- which fails closed and breaks the table; RLS with a policy that does not
  -- mention `app_current_tenant_id()` may permit everything. Both are
  -- reported, and they are different sentences.
  SELECT t.tbl, 'tenant-policy'::text,
         CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies p
                                WHERE p.schemaname = 'public' AND p.tablename = t.tbl)
              THEN 'no policy at all. With RLS enabled that denies every read '
                   'and write — it fails closed, but the table is unusable.'
              ELSE 'has policies, none of whose USING clause references '
                   'app_current_tenant_id(). Whatever it filters on, it is not '
                   'the tenant.'
         END
    FROM tenant_tables t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = t.tbl
        AND p.qual::text LIKE '%app_current_tenant_id%')

  UNION ALL

  /* 4 — the change recorder */
  SELECT t.tbl, 'change-log-trigger'::text,
         'no trigger executes record_change(). Writes to this table cannot '
         'reach a second machine and are absent from the edit history. Call '
         'attach_change_log_triggers(), or add a row to change_log_exclusions '
         'with a reason.'
    FROM tenant_tables t
   WHERE t.tbl NOT IN (SELECT e.table_name FROM change_log_exclusions e)
     AND NOT EXISTS (SELECT 1 FROM trig WHERE trig.oid = t.oid
                       AND trig.fn = 'record_change')

  UNION ALL

  /* 5 — the impersonation delete guard */
  SELECT t.tbl, 'impersonation-guard'::text,
         'no trigger executes refuse_delete_under_impersonation(). An Ordence '
         'engineer inside an impersonation session can DELETE from this table. '
         'Call attach_impersonation_guards(), or add a row to '
         'impersonation_guard_exclusions with a reason.'
    FROM tenant_tables t
   WHERE t.tbl NOT IN (SELECT e.table_name FROM impersonation_guard_exclusions e)
     AND NOT EXISTS (SELECT 1 FROM trig WHERE trig.oid = t.oid
                       AND trig.fn = 'refuse_delete_under_impersonation')

  ORDER BY 1, 2
$fn$;

COMMENT ON FUNCTION public.tenant_table_drift() IS
  'One row per protection a tenant-scoped table is missing: RLS enabled, RLS '
  'forced, a policy naming app_current_tenant_id(), a record_change() trigger, '
  'a refuse_delete_under_impersonation() trigger. Zero rows is the only '
  'acceptable answer. Exclusions come from change_log_exclusions and '
  'impersonation_guard_exclusions, so there is no fifth list to go stale. '
  'scripts/check-rls-coverage.mjs fails the build on any row.';


-- ----------------------------------------------------------------------------
-- SECTION 2 — THE ASSERTION, FOR ANYTHING THAT WANTS TO FAIL RATHER THAN READ
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_no_tenant_table_drift()
RETURNS void
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  n        integer;
  n_tables integer;
  lines    text;
BEGIN
  SELECT count(*) INTO n_tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND a.attnum > 0 AND NOT a.attisdropped);

  -- 🔴 ZERO TENANT TABLES IS A BROKEN CHECK, NOT A CLEAN DATABASE. This is
  -- the one input on which a naive loop is silent, and it is exactly the
  -- state a half-applied restore is in.
  IF n_tables = 0 THEN
    RAISE EXCEPTION
      'assert_no_tenant_table_drift() found ZERO tables with a tenant_id '
      'column. It is not that nothing is wrong — it is that there is nothing '
      'here to be wrong. The schema is not applied.'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*), string_agg(format('%s — %s: %s', table_name, property, detail), E'\n  ')
    INTO n, lines
    FROM tenant_table_drift();

  IF n > 0 THEN
    RAISE EXCEPTION E'% protection(s) missing across the tenant tables:\n  %', n, lines
      USING ERRCODE = '23514';
  END IF;
END;
$fn$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.tenant_table_drift() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.assert_no_tenant_table_drift() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON FUNCTION public.tenant_table_drift() FROM ordence_app;
    REVOKE ALL ON FUNCTION public.assert_no_tenant_table_drift() FROM ordence_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT EXECUTE ON FUNCTION public.tenant_table_drift() TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.assert_no_tenant_table_drift() TO ordence_maintenance;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 3 — VERIFY, BY MAKING IT FIND SOMETHING
-- ----------------------------------------------------------------------------
--
-- ⭐ "IT RETURNED ZERO ROWS" IS NOT EVIDENCE. `SELECT … WHERE false` also
-- returns zero rows, and so does a detector whose join is wrong. So this
-- block creates a deliberately unprotected tenant table, asserts that the
-- detector reports it on all four properties, drops it, and asserts the
-- detector is quiet again.
--
-- ⚠️ ALL OF IT INSIDE ONE `DO` BLOCK, WHICH IS ONE STATEMENT. If the
-- assertion fails, the whole statement rolls back and the probe table goes
-- with it. A probe table left behind in a database is worse than no probe:
-- `tests/security/dynamic-objects.test.ts` once left a real table called
-- `leak_probe` in a test database for exactly this reason.

DO $$
DECLARE
  found      integer;
  props      text[];
  clean      integer;
BEGIN
  -- Clean first: if this database has drift already, this file must say so
  -- rather than report a successful self-test on top of it.
  SELECT count(*) INTO clean FROM tenant_table_drift();
  IF clean > 0 THEN
    RAISE EXCEPTION
      E'0140 FAILED: the database already has % drift finding(s) before the '
       'self-test. Run: SELECT * FROM tenant_table_drift();', clean
      USING ERRCODE = '23514';
  END IF;

  CREATE TABLE public.zz_drift_probe (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL
  );

  SELECT count(*), array_agg(property ORDER BY property)
    INTO found, props
    FROM tenant_table_drift() WHERE table_name = 'zz_drift_probe';

  DROP TABLE public.zz_drift_probe;

  -- rls-enabled, tenant-policy, change-log-trigger, impersonation-guard.
  -- NOT rls-forced: property 2 only fires on a table where RLS is enabled and
  -- not forced, and this probe has it disabled entirely, which property 1
  -- reports. Asserting the exact set rather than "at least one" is what makes
  -- this a test of the detector rather than of the word "SELECT".
  IF found <> 4
     OR props IS DISTINCT FROM ARRAY['change-log-trigger', 'impersonation-guard',
                                     'rls-enabled', 'tenant-policy'] THEN
    RAISE EXCEPTION
      '0140 FAILED: an unprotected tenant table produced % finding(s) %, '
      'expected 4 [change-log-trigger, impersonation-guard, rls-enabled, '
      'tenant-policy]. The detector cannot see the thing it exists to see.',
      found, props
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO clean FROM tenant_table_drift();
  IF clean <> 0 THEN
    RAISE EXCEPTION
      '0140 FAILED: % finding(s) remain after the probe table was dropped. '
      'zz_drift_probe may still exist — check pg_tables NOW.', clean
      USING ERRCODE = '23514';
  END IF;

  PERFORM assert_no_tenant_table_drift();

  RAISE NOTICE
    '0140 PASS: tenant_table_drift() is quiet on this database, reported all '
    '4 properties on a deliberately unprotected table, and went quiet again '
    'when it was dropped. zz_drift_probe does not exist.';
END
$$;
