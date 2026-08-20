-- ############################################################################
-- DRILL 0141 — PROVE THAT AN UNSCOPED RETENTION `DELETE` REMOVES NOTHING
--              AND REPORTS SUCCESS  (Wave 15 / Track C)
-- ############################################################################
--
-- 🔴 DO NOT RUN THIS IN NEON. It CREATEs and DROPs a role, a table and two
--    functions. Run it against a throwaway local PostgreSQL:
--
--      createdb -h localhost -p 5433 -U postgres drill0141
--      psql -h localhost -p 5433 -U postgres -d drill0141 \
--           -v ON_ERROR_STOP=1 -f DRILL-DO-NOT-RUN-IN-NEON-0141.sql
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT IT PROVES
-- ══════════════════════════════════════════════════════════════════════════
-- `prune_usage_counters()` as 0013 wrote it is one statement:
--
--     DELETE FROM usage_counters WHERE period_end < now() - older_than;
--
-- `usage_counters` has FORCE ROW LEVEL SECURITY and the policy
-- `USING (tenant_id = app_current_tenant_id())`. The function is SECURITY
-- DEFINER, so it runs as the OWNER — and FORCE is exactly the setting that
-- makes policies apply to the owner. No tenant is set inside the function, so
-- the predicate is NULL for every row and the DELETE matches none of them.
--
-- The function returns 0 and exits cleanly. Nothing anywhere reads a 0 from a
-- retention job as an error; a table that is not growing is what success
-- looks like.
--
-- ⚠️ AND IT CANNOT BE REPRODUCED THE OBVIOUS WAY. On a throwaway PostgreSQL
-- the owner is `postgres`, a SUPERUSER, which bypasses row security — so the
-- old function works there and only there. That is precisely why this bug
-- survived: every place it was ever exercised was a place it could not
-- happen. So this drill creates a NON-superuser owner, which is what
-- `neondb_owner` is.
--
-- ⭐ IT THEN RUNS THE 0141 REPLACEMENT ON THE SAME DATA and asserts it
-- removes both rows. A drill that only demonstrates the bug leaves open the
-- possibility that the fix does not fix it.
--
-- IS THERE DATA LOSS? On a throwaway database, no. Read the file name.
-- ############################################################################

DROP FUNCTION IF EXISTS public.drill_prune_old(interval);
DROP FUNCTION IF EXISTS public.drill_prune_new(interval, boolean);
DROP TABLE IF EXISTS public.drill_usage_counters;
DROP TABLE IF EXISTS public.drill_tenants;
DROP ROLE IF EXISTS drill_owner_norls;

CREATE ROLE drill_owner_norls NOSUPERUSER NOBYPASSRLS NOLOGIN;
GRANT CREATE, USAGE ON SCHEMA public TO drill_owner_norls;

CREATE OR REPLACE FUNCTION public.drill_current_tenant_id()
RETURNS text LANGUAGE sql STABLE AS
$fn$ SELECT nullif(current_setting('app.current_tenant_id', true), '') $fn$;

CREATE OR REPLACE FUNCTION public.drill_platform_scope()
RETURNS boolean LANGUAGE sql STABLE AS
$fn$ SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on' $fn$;

CREATE TABLE public.drill_tenants (id text PRIMARY KEY);
INSERT INTO public.drill_tenants VALUES ('A'), ('B');

CREATE TABLE public.drill_usage_counters (
  tenant_id  text        NOT NULL,
  period_end timestamptz NOT NULL
);
INSERT INTO public.drill_usage_counters VALUES
  ('A', now() - interval '5 years'),
  ('B', now() - interval '5 years');

ALTER TABLE public.drill_tenants         OWNER TO drill_owner_norls;
ALTER TABLE public.drill_usage_counters  OWNER TO drill_owner_norls;

ALTER TABLE public.drill_usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drill_usage_counters FORCE  ROW LEVEL SECURITY;
CREATE POLICY drill_uc_iso ON public.drill_usage_counters
  FOR ALL USING (tenant_id = drill_current_tenant_id());

-- `tenants` carries a platform branch by design, and that is the ONLY policy
-- the per-tenant sweep leans on. Mirrored here so the drill is honest about
-- what the real fix depends on.
ALTER TABLE public.drill_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drill_tenants FORCE  ROW LEVEL SECURITY;
CREATE POLICY drill_tenants_iso ON public.drill_tenants
  FOR ALL USING (id = drill_current_tenant_id() OR drill_platform_scope());


-- ---- the OLD shape: one unscoped DELETE ------------------------------------
CREATE FUNCTION public.drill_prune_old(older_than interval DEFAULT interval '2 years')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE removed bigint;
BEGIN
  DELETE FROM drill_usage_counters WHERE period_end < now() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$fn$;

-- ---- the 0141 shape: platform scope to read the tenant list, then one
--      DELETE inside each tenant's own context -------------------------------
CREATE FUNCTION public.drill_prune_new(
  older_than interval DEFAULT interval '2 years',
  dry_run    boolean  DEFAULT false)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$fn$
DECLARE removed bigint := 0; n bigint; swept integer := 0; t text;
BEGIN
  PERFORM set_config('app.platform_scope', 'on', true);
  FOR t IN SELECT id FROM drill_tenants ORDER BY id LOOP
    swept := swept + 1;
    PERFORM set_config('app.current_tenant_id', t, true);
    IF dry_run THEN
      SELECT count(*) INTO n FROM drill_usage_counters WHERE period_end < now() - older_than;
    ELSE
      DELETE FROM drill_usage_counters WHERE period_end < now() - older_than;
      GET DIAGNOSTICS n = ROW_COUNT;
    END IF;
    removed := removed + n;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
  IF swept = 0 THEN
    RAISE EXCEPTION 'saw ZERO tenants — cannot read the tenant list' USING ERRCODE = '42501';
  END IF;
  RETURN removed;
END
$fn$;

ALTER FUNCTION public.drill_prune_old(interval)          OWNER TO drill_owner_norls;
ALTER FUNCTION public.drill_prune_new(interval, boolean) OWNER TO drill_owner_norls;
ALTER FUNCTION public.drill_current_tenant_id()          OWNER TO drill_owner_norls;
ALTER FUNCTION public.drill_platform_scope()             OWNER TO drill_owner_norls;


-- ----------------------------------------------------------------------------
-- THE MEASUREMENT
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  before_rows integer;
  old_says    bigint;
  after_old   integer;
  new_says    bigint;
  after_new   integer;
BEGIN
  -- Counted as the superuser running this file, which bypasses the policy —
  -- deliberately, because this line has to be the ground truth the two
  -- functions are measured against.
  SELECT count(*) INTO before_rows FROM public.drill_usage_counters;

  SELECT public.drill_prune_old() INTO old_says;
  SELECT count(*) INTO after_old FROM public.drill_usage_counters;

  RAISE NOTICE '';
  RAISE NOTICE '  rows before                        : %', before_rows;
  RAISE NOTICE '  drill_prune_old() reports removed  : %', old_says;
  RAISE NOTICE '  rows after the old prune           : %', after_old;

  IF before_rows <> 2 THEN
    RAISE EXCEPTION 'DRILL 0141 SETUP FAILED: expected 2 seed rows, found %.', before_rows;
  END IF;

  IF NOT (old_says = 0 AND after_old = 2) THEN
    RAISE EXCEPTION
      'DRILL 0141 DID NOT REPRODUCE: the unscoped prune reported % removed and left % row(s), '
      'expected 0 and 2. Either the owner of drill_usage_counters is not what this file '
      'created, or this PostgreSQL treats FORCE differently. Version: %.',
      old_says, after_old, version();
  END IF;

  SELECT public.drill_prune_new() INTO new_says;
  SELECT count(*) INTO after_new FROM public.drill_usage_counters;

  RAISE NOTICE '  drill_prune_new() reports removed  : %', new_says;
  RAISE NOTICE '  rows after the per-tenant prune    : %', after_new;
  RAISE NOTICE '';

  -- ⚠️ THE SECOND HALF MATTERS AS MUCH AS THE FIRST. Without it this drill
  -- proves a bug exists and says nothing about whether 0141 removes it.
  IF NOT (new_says = 2 AND after_new = 0) THEN
    RAISE EXCEPTION
      'DRILL 0141: THE FIX DOES NOT WORK. The per-tenant prune reported % removed and left '
      '% row(s), expected 2 and 0. 0141 must not ship in this state.',
      new_says, after_new;
  END IF;

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE '  DRILL 0141 REPRODUCED, AND THE FIX HOLDS.';
  RAISE NOTICE '';
  RAISE NOTICE '  One unscoped DELETE inside a SECURITY DEFINER function, on a';
  RAISE NOTICE '  table with FORCE ROW LEVEL SECURITY owned by a NON-superuser,';
  RAISE NOTICE '  matched ZERO rows, returned 0, and raised nothing. Both rows';
  RAISE NOTICE '  were five years past a two-year retention window.';
  RAISE NOTICE '';
  RAISE NOTICE '  The same window, swept one tenant at a time under the same';
  RAISE NOTICE '  ownership, removed both.';
  RAISE NOTICE '';
  RAISE NOTICE '  On a throwaway database owned by `postgres` the OLD function';
  RAISE NOTICE '  passes, because a superuser bypasses row security. That is';
  RAISE NOTICE '  why this drill creates its own non-superuser owner, and why';
  RAISE NOTICE '  the bug survived every test it was ever put through.';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
END
$$;


-- ----------------------------------------------------------------------------
-- CLEAN UP
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.drill_prune_old(interval);
DROP FUNCTION IF EXISTS public.drill_prune_new(interval, boolean);
DROP TABLE IF EXISTS public.drill_usage_counters;
DROP TABLE IF EXISTS public.drill_tenants;
DROP FUNCTION IF EXISTS public.drill_current_tenant_id();
DROP FUNCTION IF EXISTS public.drill_platform_scope();
REVOKE ALL ON SCHEMA public FROM drill_owner_norls;
DROP ROLE IF EXISTS drill_owner_norls;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drill_owner_norls')
     OR to_regclass('public.drill_usage_counters') IS NOT NULL THEN
    RAISE EXCEPTION 'DRILL 0141: cleanup did not complete — remove the drill objects by hand.';
  END IF;
  RAISE NOTICE 'DRILL 0141: cleaned up.';
END
$$;
