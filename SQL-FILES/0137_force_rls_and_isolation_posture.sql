-- ############################################################################
-- 0137 — FORCE IS NOT THE GUARANTEE. THE ROLE IS.
--        (Wave 15 / Track C)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 READ THIS BEFORE THE CODE. THE BRIEF THIS FILE WAS WRITTEN FROM IS
--    WRONG, AND THE WAY IT IS WRONG IS THE MOST DANGEROUS THING IN THIS
--    DATABASE.
-- ══════════════════════════════════════════════════════════════════════════
-- The wave-15 brief states, as the single most important fact in the
-- codebase:
--
--     "production connects as neondb_owner, and that role OWNS the tables.
--      A table owner is not subject to GRANT or REVOKE, and plain ENABLE ROW
--      LEVEL SECURITY does not apply to the owner. Only FORCE ROW LEVEL
--      SECURITY does. So every grant-based control you read in the
--      migrations is inert against the running application. RLS policies and
--      triggers DO work."
--
-- The first three sentences are correct. **The last one is not**, and this
-- repository already contains the measurement that disproves it.
-- `SQL-FILES/WHO-DOES-THE-APP-CONNECT-AS-neon-safe.sql` and
-- `SQL-FILES/CAN-WE-SWITCH-TO-ordence_app-neon-safe.sql` both record the
-- same reading from this Neon project:
--
--     neondb_owner has rolbypassrls = TRUE
--
-- 🔴 `BYPASSRLS` OUTRANKS `FORCE`. FORCE removes the owner's exemption. It
-- does not remove a BYPASSRLS exemption; nothing does, short of taking the
-- attribute off the role. Measured on PostgreSQL 16.13, on a table owned by
-- a NON-superuser role holding BYPASSRLS, with relrowsecurity = t,
-- relforcerowsecurity = t and a correct `tenant_id = app_current_tenant_id()`
-- policy in place:
--
--     as the BYPASSRLS owner, app.current_tenant_id = 'A'
--         → 2 rows visible: 'tenant A ledger' / 'tenant B ledger'
--     as a NOBYPASSRLS role, same query, same table
--         → 1 row visible:  'tenant A ledger'
--
-- The full transcript is in TRACK-REPORT.md §3 and the drill that reproduces
-- it is `DRILL-DO-NOT-RUN-IN-NEON-0137.sql`.
--
-- ⚠️ SO THE STATE OF THE GUARANTEE IS: 303 tenant tables, every one of them
-- ENABLED, FORCED and policied — and if `DATABASE_URL` names a role with
-- rolbypassrls, none of it executes. The policies are correct. The catalog
-- is correct. The engine skips them.
--
-- ⚠️ AND THE GATE THAT WATCHES THIS COULD NOT SEE IT.
-- `scripts/check-rls-coverage.mjs` reads `pg_class.relrowsecurity` and
-- `relforcerowsecurity` and passes. It is exhaustive, it has no floor, it
-- was written specifically against the "verified by a floor" defect — and it
-- reads the CATALOG, which stays green on a database where every policy is
-- bypassed. That is this repository's characteristic defect ("declared and
-- unenforced") sitting inside the control that is supposed to catch it.
-- This wave adds the role check to that script; see TRACK-REPORT.md §1.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE DOES, AND WHAT IT DELIBERATELY DOES NOT
-- ══════════════════════════════════════════════════════════════════════════
--   1. Reports FORCE state for EVERY tenant-scoped table, turns it on where
--      it is missing, and re-reads the catalog afterwards. Exact counts.
--      A table left un-forced is a named EXCEPTION, not a warning.
--
--   2. Adds `isolation_posture()`, which answers the question the catalog
--      cannot: for each role that can log in, does row security actually
--      apply to it? This is the thing to run in the Neon console.
--
--   3. RAISES if any tenant table is un-forced.
--      RAISES **WARNING**, not EXCEPTION, on a bypassing login role.
--
-- ⚠️ WHY 3 IS A WARNING HERE AND A HARD FAILURE IN THE GATE, WHICH IS A
--    DECISION AND NOT AN OVERSIGHT.
-- A migration cannot fix this. The attribute lives on the role and the
-- choice lives in `DATABASE_URL`; there is nothing this file could ALTER
-- that would make the statement true, and `ALTER ROLE neondb_owner
-- NOBYPASSRLS` is refused on Neon anyway. A migration that raises on a
-- condition it cannot repair is a migration that can never be applied, and
-- an un-appliable migration blocks every migration behind it. So the fact is
-- MEASURED here, persisted to `isolation_posture_log` so the reading has a
-- date on it, and ENFORCED in `scripts/check-rls-coverage.mjs`, which runs
-- on every push and whose whole job is to fail.
--
-- 🔴 IF YOU ARE READING THIS BECAUSE THE WARNING FIRED: the fix is not SQL.
-- It is to point `DATABASE_URL` at `ordence_app` (rolbypassrls = false), and
-- `CAN-WE-SWITCH-TO-ordence_app-neon-safe.sql` in this directory measures
-- whether that role holds enough privilege to do it today. Until then the
-- product's tenant isolation is every code path remembering `withTenant`,
-- with no database backstop, which is the one failure this product cannot
-- survive.
--
-- IS THERE DATA LOSS?  No. One new platform table, one function, and
-- `ALTER TABLE … FORCE ROW LEVEL SECURITY` on tables that already have RLS
-- enabled. No row is deleted.
--
-- RUN ORDER
-- ---------
-- After 0136, which is what makes the six phase-4 tables visible to the
-- sweep below at all. SQL FIRST, then the code.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent.
--
-- RLS
-- ---
-- `isolation_posture_log` is platform data about the database itself, not
-- about any tenant, and carries no `tenant_id`. It is readable by nobody but
-- the owner and the maintenance role; a tenant session has no business
-- reading a list of which roles can see everything.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — THE SWEEP: FORCE ON EVERY TENANT-SCOPED TABLE
-- ----------------------------------------------------------------------------
--
-- ⚠️ DISCOVERED, NOT LISTED. Every hand-maintained list of tenant tables in
-- this repository has been wrong: 0014's impersonation array (19 of 303),
-- 0122's change-log list, 0126's updated_at census. The criterion is the one
-- `check-rls-coverage.mjs` uses — the table carries a `tenant_id` column —
-- so the two cannot disagree about what they are measuring.

CREATE OR REPLACE FUNCTION public.tenant_tables_missing_force()
RETURNS TABLE (table_name text, rls_enabled boolean, rls_forced boolean)
LANGUAGE sql
STABLE
AS $fn$
  SELECT c.relname::text, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)
     AND c.relname NOT IN ('tenants', 'plans')
     AND NOT c.relforcerowsecurity
   ORDER BY c.relname;
$fn$;

COMMENT ON FUNCTION public.tenant_tables_missing_force() IS
  'Every table with a tenant_id column on which row security is not FORCED. '
  'Should always return zero rows. `tenants` and `plans` are excluded for the '
  'same reason scripts/check-rls-coverage.mjs excludes them: they are the '
  'tenant list and the global price list, read across tenants by design.';

DO $$
DECLARE
  r         record;
  fixed     text[] := ARRAY[]::text[];
  enabled   text[] := ARRAY[]::text[];
BEGIN
  FOR r IN SELECT * FROM tenant_tables_missing_force() LOOP
    -- ⚠️ ENABLE FIRST WHERE IT IS ABSENT. `FORCE` on a table with row
    -- security disabled is accepted by PostgreSQL and does nothing, which
    -- is the quietest possible way to write a migration that reports
    -- success and changes no behaviour.
    IF NOT r.rls_enabled THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
      enabled := enabled || r.table_name;
    END IF;
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    fixed := fixed || r.table_name;
  END LOOP;

  IF cardinality(fixed) = 0 THEN
    RAISE NOTICE '0137: every tenant-scoped table already had FORCE ROW LEVEL SECURITY.';
  ELSE
    RAISE NOTICE '0137: FORCE turned on for % table(s): %. Of those, % also had row '
                 'security DISABLED entirely: %.',
      cardinality(fixed), array_to_string(fixed, ', '),
      cardinality(enabled), array_to_string(enabled, ', ');
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 2 — THE QUESTION THE CATALOG CANNOT ANSWER
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.isolation_posture_log (
  observed_at      timestamptz NOT NULL DEFAULT now(),
  role_name        text        NOT NULL,
  can_log_in       boolean     NOT NULL,
  is_superuser     boolean     NOT NULL,
  bypasses_rls     boolean     NOT NULL,
  holds_table_priv boolean     NOT NULL,
  verdict          text        NOT NULL,
  PRIMARY KEY (observed_at, role_name)
);

COMMENT ON TABLE public.isolation_posture_log IS
  'One row per login role per observation. Records whether row-level security '
  'actually applies to that role. The catalog columns relrowsecurity and '
  'relforcerowsecurity say a table is protected; this says whether the role '
  'reading it is subject to that protection. A role with rolbypassrls skips '
  'every policy on every table regardless of FORCE.';


CREATE OR REPLACE FUNCTION public.isolation_posture()
RETURNS TABLE (
  role_name        text,
  can_log_in       boolean,
  is_superuser     boolean,
  bypasses_rls     boolean,
  holds_table_priv boolean,
  is_current_role  boolean,
  verdict          text
)
LANGUAGE sql
STABLE
AS $fn$
  SELECT
    r.rolname::text,
    r.rolcanlogin,
    r.rolsuper,
    r.rolbypassrls,
    -- ⚠️ "Could this role read a tenant table at all?" A bypassing role that
    -- holds no privilege on anything is a curiosity; one that holds SELECT on
    -- the ledger is the whole problem. Measured against a real tenant table
    -- rather than assumed.
    EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                        AND a.attnum > 0 AND NOT a.attisdropped)
         AND has_table_privilege(r.oid, c.oid, 'SELECT')
    ),
    r.rolname = current_user,
    CASE
      WHEN NOT r.rolcanlogin
        THEN 'group role, cannot connect — not a concern'
      WHEN r.rolsuper
        THEN 'SUPERUSER. Row security does not apply. Every policy in this database is skipped for it.'
      WHEN r.rolbypassrls
        THEN 'BYPASSRLS. Row security does not apply, and FORCE ROW LEVEL SECURITY does not change that. If DATABASE_URL names this role, tenant isolation rests entirely on the application calling withTenant().'
      ELSE
        'row security APPLIES to this role. FORCE ROW LEVEL SECURITY is a real backstop for it.'
    END::text
    FROM pg_roles r
   ORDER BY r.rolbypassrls DESC, r.rolsuper DESC, r.rolname;
$fn$;

COMMENT ON FUNCTION public.isolation_posture() IS
  'Answers "does row-level security actually apply?" per role. Run this in the '
  'Neon console. A row with bypasses_rls = true and holds_table_priv = true is '
  'a role for which every policy in this database is decoration — including '
  'the 303 FORCE ROW LEVEL SECURITY settings. Fixing it is a DATABASE_URL '
  'change, not a migration.';


-- ----------------------------------------------------------------------------
-- SECTION 3 — RECORD THE READING, WITH A DATE ON IT
-- ----------------------------------------------------------------------------
--
-- ⚠️ A MEASUREMENT WITHOUT A TIMESTAMP IS A RUMOUR. The two neon-safe
-- diagnostic files in this directory both recorded `neondb_owner has
-- rolbypassrls = true` and neither wrote it down anywhere a later reader
-- could find it; the fact then had to be rediscovered a wave later. This
-- table is where it lives now.

INSERT INTO public.isolation_posture_log
  (role_name, can_log_in, is_superuser, bypasses_rls, holds_table_priv, verdict)
SELECT role_name, can_log_in, is_superuser, bypasses_rls, holds_table_priv, verdict
  FROM isolation_posture()
 WHERE can_log_in
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  REVOKE ALL ON public.isolation_posture_log FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.isolation_posture() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.tenant_tables_missing_force() FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    -- The application has no business reading which roles can see everything.
    REVOKE ALL ON public.isolation_posture_log FROM ordence_app;
    REVOKE ALL ON FUNCTION public.isolation_posture() FROM ordence_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT SELECT ON public.isolation_posture_log TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.isolation_posture() TO ordence_maintenance;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 4 — VERIFY. THE CATALOG PART IS FATAL; THE ROLE PART IS LOUD.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  unforced   text[];
  n_tenant   integer;
  n_forced   integer;
  bypassers  text[];
BEGIN
  SELECT coalesce(array_agg(table_name ORDER BY table_name), ARRAY[]::text[])
    INTO unforced FROM tenant_tables_missing_force();

  SELECT count(*) FILTER (WHERE true),
         count(*) FILTER (WHERE c.relforcerowsecurity)
    INTO n_tenant, n_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)
     AND c.relname NOT IN ('tenants', 'plans');

  -- 🔴 A SWEEP THAT SAW NO TABLES IS A BROKEN SWEEP, NOT A CLEAN ONE. This
  -- is the `verify-restore.mjs` rule and the one every vacuous check in this
  -- repository has been missing: zero is never a pass.
  IF n_tenant = 0 THEN
    RAISE EXCEPTION
      '0137 FAILED: ZERO tables with a tenant_id column were found. This file '
      'would otherwise have reported complete FORCE coverage over nothing at '
      'all, which is worse than reporting a failure.'
      USING ERRCODE = '23514';
  END IF;

  IF cardinality(unforced) > 0 THEN
    RAISE EXCEPTION
      '0137 FAILED: % of % tenant-scoped table(s) still lack FORCE ROW LEVEL '
      'SECURITY after the sweep: %.',
      cardinality(unforced), n_tenant, array_to_string(unforced, ', ')
      USING ERRCODE = '23514';
  END IF;

  -- ⭐ EXACT, NOT A FLOOR. `n_forced = n_tenant`, both counted from the same
  -- catalog query. `>= some number` is what let four unprotected tables ship.
  IF n_forced <> n_tenant THEN
    RAISE EXCEPTION
      '0137 FAILED: % tenant table(s) but only % forced. The sweep reported '
      'nothing left to do and the counts disagree, so one of the two queries '
      'is wrong — do not "fix" this by lowering the assertion.',
      n_tenant, n_forced
      USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(array_agg(role_name ORDER BY role_name), ARRAY[]::text[])
    INTO bypassers
    FROM isolation_posture()
   WHERE can_log_in AND holds_table_priv AND (bypasses_rls OR is_superuser);

  IF cardinality(bypassers) > 0 THEN
    RAISE WARNING E'\n'
      '════════════════════════════════════════════════════════════════════\n'
      '🔴 0137: % LOGIN ROLE(S) HOLD PRIVILEGE ON TENANT TABLES AND ARE NOT\n'
      '   SUBJECT TO ROW-LEVEL SECURITY: %\n'
      '════════════════════════════════════════════════════════════════════\n'
      'All % tenant tables are ENABLED, FORCED and policied. For these roles\n'
      'the engine skips every one of those policies. FORCE removes the table\n'
      'OWNER''s exemption; it does not remove a BYPASSRLS or SUPERUSER one.\n'
      '\n'
      'If DATABASE_URL names one of them, this product has no database-level\n'
      'tenant isolation at all — only every code path remembering withTenant().\n'
      '\n'
      'This is not fixable in SQL. Point DATABASE_URL at a role with\n'
      'rolbypassrls = false. SQL-FILES/CAN-WE-SWITCH-TO-ordence_app-neon-safe.sql\n'
      'measures whether ordence_app holds enough privilege to do it today.\n'
      'scripts/check-rls-coverage.mjs fails the build on this condition.\n'
      '════════════════════════════════════════════════════════════════════',
      cardinality(bypassers), array_to_string(bypassers, ', '), n_tenant;
  END IF;

  RAISE NOTICE
    '0137 PASS (catalog): % of % tenant-scoped tables ENABLED and FORCED, '
    'exact match, no floor. % bypassing login role(s) recorded in '
    'isolation_posture_log — see the warning above if that number is not 0.',
    n_forced, n_tenant, cardinality(bypassers);
END
$$;
