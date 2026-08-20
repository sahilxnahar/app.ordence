-- ############################################################################
-- 0141 — TWO RETENTION FUNCTIONS THAT DELETE NOTHING AND REPORT SUCCESS
--        (Wave 15 / Track C)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 THE DEFECT, MEASURED RATHER THAN ARGUED
-- ══════════════════════════════════════════════════════════════════════════
-- `prune_usage_counters()` is one unscoped statement:
--
--     DELETE FROM usage_counters WHERE period_end < now() - older_than;
--     GET DIAGNOSTICS removed = ROW_COUNT;
--     RETURN removed;
--
-- `usage_counters` has FORCE ROW LEVEL SECURITY and the policy
-- `USING (tenant_id = app_current_tenant_id())`. The function is SECURITY
-- DEFINER, so it runs as the table's OWNER — and FORCE is precisely the
-- setting that makes policies apply to the owner. No tenant is set inside the
-- function, so `app_current_tenant_id()` is NULL, the predicate is NULL for
-- every row, and the DELETE matches nothing.
--
-- Reproduced on PostgreSQL 16.13, on a table owned by a NON-superuser role
-- (which is what `neondb_owner` is), with two rows five years old and a
-- retention window of two years:
--
--     rows before                     2
--     prune_usage_counters() returns  0
--     rows after                      2
--
-- The function did nothing, said so in a number nobody reads as an error, and
-- exited cleanly. The transcript is in TRACK-REPORT.md §3.
--
-- ⚠️ IT PASSED ITS OWN TESTING FOR A REASON WORTH NAMING. Against a throwaway
-- PostgreSQL the owner is `postgres`, a SUPERUSER, which bypasses row
-- security entirely — so the DELETE works there and only there.
-- `0128_change_log_retention.sql` caught this on itself and wrote the
-- explanation down. This file applies the same treatment to the two functions
-- 0128 left alone.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ `prune_security_events()` IS WORSE, BECAUSE IT DELETES SOME
-- ══════════════════════════════════════════════════════════════════════════
-- Its policy, after 0079, is
--
--     USING ( tenant_id = app_current_tenant_id()
--          OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
--          OR app_platform_scope() )
--
-- and the function sets neither a tenant nor platform scope. So the middle
-- branch matches — and only the middle branch. It deletes exactly the
-- UNATTRIBUTED events, the perimeter rows with no workspace, and silently
-- skips every event attributed to a tenant.
--
-- 🔴 THAT RETURNS A NON-ZERO NUMBER. `prune_usage_counters()` at least
-- reports 0, which somebody might eventually question. This one reports a
-- plausible count, deletes the wrong subset, and leaves the operator
-- believing the retention window is being honoured on the attributed events
-- when it never has been. `server/security/anomalies.ts` reads exactly those
-- unattributed rows for its perimeter sweep, so the one thing this prune
-- reliably destroys is the input to the anomaly detector.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE DOES
-- ══════════════════════════════════════════════════════════════════════════
-- Rewrites both onto 0128's pattern, which is the only one that works for a
-- non-superuser owner without widening a single policy:
--
--   1. read the tenant list under platform scope — the `tenants` policy has
--      a platform branch by design, and it is the only one used here;
--   2. set `app.current_tenant_id` per tenant, transaction-local;
--   3. delete inside that tenant's own context;
--   4. sum, and RAISE if the sweep saw ZERO tenants, because a sweep that
--      cannot see the tenant list is broken rather than finished.
--
-- Both gain `dry_run boolean DEFAULT true` and both return a row rather than
-- a bare count, so "how many, across how many tenants, to what cutoff" is
-- answerable before anything is destroyed.
--
-- ⚠️ AND `prune_security_events()` KEEPS ITS `app.allow_security_event_prune`
-- MARKER. That flag is what gets past the append-only trigger; it is
-- orthogonal to RLS and removing it would replace a silent no-op with a loud
-- one. Both are needed, for different reasons, which is exactly why the
-- original looked complete.
--
-- 🔴 THE SEALS ARE RE-APPLIED IN SECTION 3 AND THAT IS NOT OPTIONAL.
-- `DROP FUNCTION` takes the function's ACL with it, and a freshly created
-- function is EXECUTE-able by PUBLIC. `scripts/sealed-grants.json` seals
-- EXECUTE on both of these against `ordence_app`, `0121` repaired that seal
-- once already, and dropping-and-recreating without re-revoking would undo
-- 0121 in a file about retention. The verification in Section 4 checks the
-- seal held, by privilege, not by reading this file's own intent.
--
-- IS THERE DATA LOSS?  Creating the functions: no. CALLING them with
-- dry_run => false: yes, by design, and only rows older than the window.
-- This file creates the machinery and does NOT run a destructive prune.
--
-- RUN ORDER
-- ---------
-- After 0121 (the seal repair) and after 0128 (whose pattern this copies).
-- SQL FIRST. Nothing in the application calls either function.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent.
--
-- RLS
-- ---
-- Unchanged. Not one policy is touched, and that is the point: the previous
-- shape tempts a reader into adding `OR app_platform_scope()` to
-- `usage_counters` to make the retention job work, which would widen the read
-- boundary on every customer's metered usage — the exact widening
-- `scripts/check-rls-coverage.mjs` lists `usage_counters` on the refusal list
-- for, quoting 0022: "one query would read every customer's metered usage".
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — usage_counters
-- ----------------------------------------------------------------------------

-- ⚠️ DROP FIRST. The return type changes from `bigint` to a row, and
-- `CREATE OR REPLACE FUNCTION` cannot change a return type: without this the
-- file fails with "cannot change return type of existing function", which
-- reads as a broken migration rather than a superseded one. Same note as 0128.
DROP FUNCTION IF EXISTS public.prune_usage_counters(interval);

CREATE OR REPLACE FUNCTION public.prune_usage_counters(
  older_than interval DEFAULT interval '2 years 1 month',
  dry_run    boolean  DEFAULT true
)
RETURNS TABLE (rows_affected bigint, tenants_swept integer, cutoff timestamptz, was_dry_run boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  cut     timestamptz;
  removed bigint := 0;
  n       bigint;
  swept   integer := 0;
  t       uuid;
BEGIN
  -- ⚠️ A FLOOR ON THE WINDOW, LIKE BOTH ITS SIBLINGS. `usage_counters` is the
  -- evidence behind every invoice; a window short enough to save storage is
  -- short enough to destroy a billing dispute. Thirteen months is the
  -- shortest that still spans a full year-on-year comparison.
  IF older_than < interval '13 months' THEN
    RAISE EXCEPTION
      'Refusing to prune usage_counters with a window shorter than 13 months '
      '(asked for %). These rows are what the customer was billed on.', older_than
      USING ERRCODE = '22023';
  END IF;

  cut := now() - older_than;

  PERFORM set_config('app.platform_scope', 'on', true);

  FOR t IN SELECT id FROM tenants ORDER BY id
  LOOP
    swept := swept + 1;
    PERFORM set_config('app.current_tenant_id', t::text, true);

    IF dry_run THEN
      SELECT count(*) INTO n FROM usage_counters WHERE period_end < cut;
    ELSE
      DELETE FROM usage_counters WHERE period_end < cut;
      GET DIAGNOSTICS n = ROW_COUNT;
    END IF;

    removed := removed + n;
  END LOOP;

  PERFORM set_config('app.current_tenant_id', '', true);

  -- 🔴 ZERO TENANTS IS THE BROKEN CASE, NOT THE EMPTY ONE. Without this the
  -- function returns 0 forever the day the `tenants` policy loses its
  -- platform branch, and 0 is what a clean database also looks like.
  IF swept = 0 THEN
    RAISE EXCEPTION
      'prune_usage_counters() saw ZERO tenants and therefore pruned nothing. '
      'That is not an empty database — it is a function that cannot read the '
      'tenant list. Check the `tenants` policy still carries its platform branch.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT removed, swept, cut, dry_run;
END;
$fn$;

COMMENT ON FUNCTION public.prune_usage_counters(interval, boolean) IS
  'Bounds usage_counters, one tenant at a time. Defaults to a 25-month window '
  'and dry_run = true; refuses anything under 13 months. The per-tenant loop '
  'is not style: the previous single unscoped DELETE matched ZERO rows under '
  'FORCE RLS for a non-superuser owner and returned 0 having done nothing.';


-- ----------------------------------------------------------------------------
-- SECTION 2 — security_events
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.prune_security_events(integer, boolean);

CREATE OR REPLACE FUNCTION public.prune_security_events(
  older_than_days  integer DEFAULT 180,
  include_critical boolean DEFAULT false,
  dry_run          boolean DEFAULT true
)
RETURNS TABLE (
  rows_affected      bigint,
  unattributed_rows  bigint,
  tenants_swept      integer,
  cutoff             timestamptz,
  was_dry_run        boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  cut       timestamptz;
  removed   bigint := 0;
  orphaned  bigint := 0;
  n         bigint;
  swept     integer := 0;
  t         uuid;
BEGIN
  IF older_than_days < 30 THEN
    RAISE EXCEPTION
      'Refusing to prune security events younger than 30 days (asked for %).',
      older_than_days
      USING ERRCODE = '22023';
  END IF;

  cut := now() - make_interval(days => older_than_days);

  -- ⚠️ TWO MARKERS, AND THEY DO DIFFERENT JOBS. `allow_security_event_prune`
  -- gets past the append-only TRIGGER. `platform_scope` here is used only to
  -- read the tenant list and to reach the unattributed rows in the second
  -- pass. Neither substitutes for the other, and the original function set
  -- only the first — which is why it looked complete and deleted the wrong
  -- rows. Both are transaction-local so neither can leak onto a pooled
  -- connection.
  PERFORM set_config('app.allow_security_event_prune', 'on', true);
  PERFORM set_config('app.platform_scope', 'on', true);

  /* ---- pass 1: each tenant's own events, inside that tenant ---------- */
  FOR t IN SELECT id FROM tenants ORDER BY id
  LOOP
    swept := swept + 1;
    PERFORM set_config('app.current_tenant_id', t::text, true);

    IF dry_run THEN
      SELECT count(*) INTO n FROM security_events
       WHERE created_at < cut AND (include_critical OR severity <> 'critical');
    ELSE
      DELETE FROM security_events
       WHERE created_at < cut AND (include_critical OR severity <> 'critical');
      GET DIAGNOSTICS n = ROW_COUNT;
    END IF;

    removed := removed + n;
  END LOOP;

  /* ---- pass 2: the unattributed perimeter rows ---------------------- */
  -- ⚠️ COUNTED SEPARATELY AND RETURNED SEPARATELY. `server/security/
  -- anomalies.ts` reads exactly these rows and its own comment says an
  -- anomaly detector that silently sees zero events is the most dangerous
  -- shape of broken there is. An operator pruning security history should see
  -- how much of what they removed was the anomaly detector's input, rather
  -- than finding out from a quiet dashboard.
  PERFORM set_config('app.current_tenant_id', '', true);

  IF dry_run THEN
    SELECT count(*) INTO orphaned FROM security_events
     WHERE created_at < cut AND tenant_id IS NULL
       AND (include_critical OR severity <> 'critical');
  ELSE
    DELETE FROM security_events
     WHERE created_at < cut AND tenant_id IS NULL
       AND (include_critical OR severity <> 'critical');
    GET DIAGNOSTICS orphaned = ROW_COUNT;
  END IF;

  PERFORM set_config('app.allow_security_event_prune', 'off', true);

  IF swept = 0 THEN
    RAISE EXCEPTION
      'prune_security_events() saw ZERO tenants. Every attributed event was '
      'therefore skipped, and the count this function would have returned '
      'covers the unattributed rows only. Check the `tenants` policy still '
      'carries its platform branch.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT removed, orphaned, swept, cut, dry_run;
END;
$fn$;

COMMENT ON FUNCTION public.prune_security_events(integer, boolean, boolean) IS
  'Bounds security_events, one tenant at a time, then the unattributed '
  'perimeter rows in a second pass reported separately. Defaults to 180 days '
  'and dry_run = true; refuses anything under 30 days. The previous version '
  'ran one unscoped DELETE which, under FORCE RLS with no tenant set, matched '
  'ONLY the unattributed rows — deleting the anomaly detector''s input and '
  'silently keeping every attributed event past its retention window.';


-- ----------------------------------------------------------------------------
-- SECTION 3 — RE-APPLY THE SEALS THE DROPs REMOVED
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.prune_usage_counters(interval, boolean) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.prune_security_events(integer, boolean, boolean) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON FUNCTION public.prune_usage_counters(interval, boolean) FROM ordence_app;
    REVOKE ALL ON FUNCTION public.prune_security_events(integer, boolean, boolean) FROM ordence_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT EXECUTE ON FUNCTION public.prune_usage_counters(interval, boolean)
      TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.prune_security_events(integer, boolean, boolean)
      TO ordence_maintenance;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 4 — VERIFY
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  problems  text[] := ARRAY[]::text[];
  n_tenants integer;
  r         record;
BEGIN
  /* -- 1. both exist, with the new shape ----------------------------- */
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       -- ⚠️ `oid::regprocedure`, NOT `pg_get_function_identity_arguments()`.
       -- The latter includes PARAMETER NAMES when the function declares them:
       -- it returns "older_than interval, dry_run boolean" here, not
       -- "interval, boolean". A comparison against the bare type list
       -- therefore never matches, and this check reported "was not created"
       -- about a function sitting right there in pg_proc. Measured on the
       -- first run of this file, which is the only reason it is not still
       -- written that way.
       AND p.oid::regprocedure::text = 'prune_usage_counters(interval,boolean)') THEN
    problems := problems || 'prune_usage_counters(interval, boolean) was not created.'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.oid::regprocedure::text = 'prune_security_events(integer,boolean,boolean)') THEN
    problems := problems || 'prune_security_events(integer, boolean, boolean) was not created.'::text;
  END IF;

  /* -- 2. and the OLD shapes are gone -------------------------------- */
  -- ⚠️ AN OVERLOAD IS NOT A REPLACEMENT. Leaving the old signature behind
  -- means a caller that passes the old argument list gets the old, broken
  -- body, and PostgreSQL resolves it silently.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.oid::regprocedure::text = 'prune_usage_counters(interval)') THEN
    problems := problems || 'the old prune_usage_counters(interval) still exists as an overload.'::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.oid::regprocedure::text = 'prune_security_events(integer,boolean)') THEN
    problems := problems || 'the old prune_security_events(integer, boolean) still exists as an overload.'::text;
  END IF;

  /* -- 3. THE SEAL. Measured from the ACL, not from Section 3's intent. */
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    FOR r IN
      SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('prune_usage_counters', 'prune_security_events')
         AND has_function_privilege('ordence_app', p.oid, 'EXECUTE')
    LOOP
      problems := problems || format(
        'THE SEAL IS BROKEN: ordence_app can EXECUTE %s(). DROP FUNCTION took '
        'the ACL with it and the re-REVOKE in Section 3 did not hold. This is '
        'the exact regression 0121 was written to repair.', r.proname);
    END LOOP;
  END IF;

  /* -- 4. non-vacuous where the data allows -------------------------- */
  -- ⚠️ A DRY RUN, AND ONLY WHERE THERE IS A TENANT LIST TO SWEEP. On a fresh
  -- CI database `tenants` is empty, the sweep would see zero and RAISE by
  -- design, and a migration that cannot be applied to an empty database
  -- blocks every migration behind it. So this SAYS it skipped rather than
  -- passing quietly, which is the distinction this whole wave is about.
  SELECT count(*) INTO n_tenants FROM tenants;

  IF n_tenants > 0 THEN
    FOR r IN SELECT * FROM prune_usage_counters(interval '2 years 1 month', true) LOOP
      IF r.tenants_swept <> n_tenants THEN
        problems := problems || format(
          'a dry run of prune_usage_counters() swept %s tenant(s) but the '
          'database has %s. The function cannot see the whole tenant list, so '
          'it would silently skip the rest.', r.tenants_swept, n_tenants);
      END IF;
      IF NOT r.was_dry_run THEN
        problems := problems || 'prune_usage_counters() reported was_dry_run = false '
                                'for a call that passed dry_run => true.'::text;
      END IF;
    END LOOP;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION E'0141 FAILED — % problem(s):\n  %',
      cardinality(problems), array_to_string(problems, E'\n  ')
      USING ERRCODE = '23514';
  END IF;

  IF n_tenants = 0 THEN
    RAISE NOTICE
      '0141 PASS (structure only): both retention functions rewritten per '
      'tenant, old overloads gone, seals intact. THE DRY RUN WAS SKIPPED — '
      'this database has zero tenants, so there was nothing to sweep. Re-run '
      'the Section 4 dry run on a database with tenants before believing the '
      'sweep works.';
  ELSE
    RAISE NOTICE
      '0141 PASS: both retention functions rewritten per tenant; old overloads '
      'gone; ordence_app cannot execute either; a dry run swept all % tenant(s) '
      'and deleted nothing.', n_tenants;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — HOW TO USE THEM. NOTHING BELOW RUNS AUTOMATICALLY.
-- ############################################################################
--
-- 🔴 THERE IS STILL NO SCHEDULER ATTACHED TO THIS PRODUCT. All three prune
-- functions — `prune_change_log`, `prune_security_events`,
-- `prune_usage_counters` — are now written, per-tenant, dry-run by default,
-- and waiting on the same half-day of configuration.
--
--   -- SEE what would go. Removes nothing.
--      SELECT * FROM prune_usage_counters(interval '2 years 1 month', true);
--      SELECT * FROM prune_security_events(180, false, true);
--
--   -- If the numbers look right, DO it.
--      SELECT * FROM prune_usage_counters(interval '2 years 1 month', false);
--      SELECT * FROM prune_security_events(180, false, false);
--
--   -- Reclaim the disk. Separately, and NOT inside a transaction.
--      VACUUM (ANALYZE) public.usage_counters;
--      VACUUM (ANALYZE) public.security_events;
--
-- ⚠️ READ `unattributed_rows` IN THE SECURITY-EVENTS RESULT BEFORE THE REAL
-- RUN. Those are the perimeter events with no workspace, and they are the
-- only input `server/security/anomalies.ts` has.
-- ############################################################################
