-- ############################################################################
-- DRILL 0137 — PROVE THAT `FORCE ROW LEVEL SECURITY` IS NOT THE GUARANTEE
--              (Wave 15 / Track C)
-- ############################################################################
--
-- 🔴 DO NOT RUN THIS IN NEON. It CREATEs and DROPs roles and tables. Run it
--    against a throwaway local PostgreSQL and nothing else:
--
--      createdb -h localhost -p 5433 -U postgres drill0137
--      psql -h localhost -p 5433 -U postgres -d drill0137 \
--           -v ON_ERROR_STOP=1 -f DRILL-DO-NOT-RUN-IN-NEON-0137.sql
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT IT PROVES, AND WHY IT HAD TO BE A DRILL RATHER THAN AN ARGUMENT
-- ══════════════════════════════════════════════════════════════════════════
-- The wave-15 brief states that on Neon "the application connects as
-- `neondb_owner`, and that role OWNS the tables … plain ENABLE ROW LEVEL
-- SECURITY does not apply to the owner. Only FORCE ROW LEVEL SECURITY does.
-- So every grant-based control you read in the migrations is inert against
-- the running application. RLS policies and triggers DO work."
--
-- The last sentence is false whenever the connecting role holds
-- `rolbypassrls`, and this repository's own diagnostics
-- (`WHO-DOES-THE-APP-CONNECT-AS-neon-safe.sql`,
-- `CAN-WE-SWITCH-TO-ordence_app-neon-safe.sql`) record exactly that about
-- `neondb_owner` on this project.
--
-- ⚠️ IT IS NOT A SUBTLE READING OF THE DOCUMENTATION. It is a different
-- exemption from the one FORCE removes:
--
--     ENABLE   → policies apply to everyone EXCEPT the table owner
--     FORCE    → …and to the owner as well
--     BYPASSRLS→ this ROLE is exempt from every policy on every table,
--                whatever the table says. FORCE does not reach it.
--                SUPERUSER implies the same thing under a different word.
--
-- ⭐ SO THE ISOLATION GUARANTEE IS A PROPERTY OF THE ROLE IN
-- `DATABASE_URL`, AND THE CATALOG CANNOT SEE IT. `check-rls-coverage.mjs`
-- reads `relforcerowsecurity` and would print ✅ on a database where every
-- one of the 303 policies is skipped. That is why 0137 adds
-- `isolation_posture()` and why the gate now checks role attributes.
--
-- WHAT IT DOES
-- ------------
--   1. Two non-superuser roles: one WITH bypassrls, one WITHOUT.
--   2. A table owned by the bypassing role, with RLS enabled, FORCED, and
--      a correct `tenant_id = app_current_tenant_id()` policy.
--   3. Two rows, one per tenant.
--   4. Reads it as each role with tenant A selected, and RAISES unless the
--      bypassing owner sees BOTH rows and the other role sees ONE.
--
-- ⚠️ THE ASSERTION IS TWO-SIDED ON PURPOSE. "The bypassing role saw two
-- rows" alone would also be true on a table with no policy at all, which is
-- the failure this whole track is about.
--
-- IS THERE DATA LOSS? On a throwaway database, no. On any database you care
-- about, this file drops a table and two roles — which is why the name says
-- what it says.
-- ############################################################################

DROP TABLE IF EXISTS public.drill_ledger;
DROP ROLE IF EXISTS drill_owner_bypass;
DROP ROLE IF EXISTS drill_reader_plain;

CREATE ROLE drill_owner_bypass NOSUPERUSER BYPASSRLS   NOLOGIN;
CREATE ROLE drill_reader_plain NOSUPERUSER NOBYPASSRLS NOLOGIN;

CREATE OR REPLACE FUNCTION public.drill_current_tenant_id()
RETURNS text LANGUAGE sql STABLE AS
$fn$ SELECT nullif(current_setting('app.current_tenant_id', true), '') $fn$;

CREATE TABLE public.drill_ledger (tenant_id text NOT NULL, secret text NOT NULL);
INSERT INTO public.drill_ledger VALUES
  ('A', 'tenant A general ledger'),
  ('B', 'tenant B general ledger');

-- The role that OWNS the table is the one the application connects as on
-- Neon. That is the whole point of the arrangement.
ALTER TABLE public.drill_ledger OWNER TO drill_owner_bypass;

ALTER TABLE public.drill_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drill_ledger FORCE  ROW LEVEL SECURITY;

CREATE POLICY drill_ledger_tenant_isolation ON public.drill_ledger
  FOR ALL
  USING      (tenant_id = drill_current_tenant_id())
  WITH CHECK (tenant_id = drill_current_tenant_id());

GRANT SELECT ON public.drill_ledger TO drill_reader_plain;
GRANT EXECUTE ON FUNCTION public.drill_current_tenant_id() TO drill_reader_plain, drill_owner_bypass;


-- ----------------------------------------------------------------------------
-- THE MEASUREMENT
-- ----------------------------------------------------------------------------
--
-- ⚠️ `SET ROLE` RATHER THAN A SECOND CONNECTION, because row security is
-- evaluated against the CURRENT role and this file has to be one pasteable
-- unit. The rows are read inside one DO block so the role is always reset.

DO $$
DECLARE
  catalog_enabled boolean;
  catalog_forced  boolean;
  seen_by_bypass  integer;
  seen_by_plain   integer;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO catalog_enabled, catalog_forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'drill_ledger';

  IF NOT (catalog_enabled AND catalog_forced) THEN
    RAISE EXCEPTION
      'DRILL 0137 SETUP FAILED: the table is not ENABLED and FORCED (enabled=%, '
      'forced=%). The drill would prove nothing about FORCE.',
      catalog_enabled, catalog_forced;
  END IF;

  PERFORM set_config('app.current_tenant_id', 'A', true);

  SET LOCAL ROLE drill_owner_bypass;
  SELECT count(*) INTO seen_by_bypass FROM public.drill_ledger;
  RESET ROLE;

  SET LOCAL ROLE drill_reader_plain;
  SELECT count(*) INTO seen_by_plain FROM public.drill_ledger;
  RESET ROLE;

  RAISE NOTICE '';
  RAISE NOTICE '  catalog says            : rls=% force=%', catalog_enabled, catalog_forced;
  RAISE NOTICE '  tenant selected         : A';
  RAISE NOTICE '  drill_owner_bypass sees : % row(s)   [NOSUPERUSER, BYPASSRLS, owns the table]',
    seen_by_bypass;
  RAISE NOTICE '  drill_reader_plain sees : % row(s)   [NOSUPERUSER, NOBYPASSRLS]',
    seen_by_plain;
  RAISE NOTICE '';

  IF seen_by_plain <> 1 THEN
    RAISE EXCEPTION
      'DRILL 0137 FAILED: the NOBYPASSRLS role saw % row(s), expected exactly 1. '
      'The policy itself is wrong, so this drill cannot say anything about BYPASSRLS.',
      seen_by_plain;
  END IF;

  IF seen_by_bypass <> 2 THEN
    RAISE EXCEPTION
      'DRILL 0137 DID NOT REPRODUCE: the BYPASSRLS owner saw % row(s), expected 2. '
      'On this PostgreSQL, FORCE ROW LEVEL SECURITY apparently DOES bind a role with '
      'BYPASSRLS — which would mean the conclusion in 0137 and in TRACK-REPORT.md is '
      'wrong for this version. Do not delete this drill; report the version: %.',
      seen_by_bypass, version();
  END IF;

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE '  DRILL 0137 REPRODUCED.';
  RAISE NOTICE '';
  RAISE NOTICE '  A table with RLS ENABLED, FORCED and a correct tenant policy';
  RAISE NOTICE '  handed BOTH tenants'' rows to the role that owns it, because that';
  RAISE NOTICE '  role holds BYPASSRLS. FORCE removes the OWNER exemption. It does';
  RAISE NOTICE '  not remove the BYPASSRLS exemption, and nothing does except';
  RAISE NOTICE '  taking the attribute off the role.';
  RAISE NOTICE '';
  RAISE NOTICE '  If DATABASE_URL names such a role, this product has NO';
  RAISE NOTICE '  database-level tenant isolation, and every catalog-reading';
  RAISE NOTICE '  check in the repository will report that it does.';
  RAISE NOTICE '';
  RAISE NOTICE '  Run SELECT * FROM isolation_posture() against the real database.';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
END
$$;


-- ----------------------------------------------------------------------------
-- CLEAN UP. A drill that leaves a role behind is a drill that eventually
-- leaves one behind somewhere it matters.
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS public.drill_ledger;
DROP FUNCTION IF EXISTS public.drill_current_tenant_id();
DROP ROLE IF EXISTS drill_owner_bypass;
DROP ROLE IF EXISTS drill_reader_plain;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('drill_owner_bypass', 'drill_reader_plain'))
     OR to_regclass('public.drill_ledger') IS NOT NULL THEN
    RAISE EXCEPTION
      'DRILL 0137: cleanup did not complete. A drill role or table is still present — '
      'remove it by hand before doing anything else on this database.';
  END IF;
  RAISE NOTICE 'DRILL 0137: cleaned up. No drill roles, no drill table.';
END
$$;
