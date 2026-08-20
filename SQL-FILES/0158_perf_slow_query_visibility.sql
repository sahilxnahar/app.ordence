-- =====================================================================
-- 0158 — slow-query visibility, and an honest answer about tenants
-- Repo: app.ordence · Track F (performance) · Wave 16
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- WHAT EXISTS TODAY: NOTHING
-- ══════════════════════════════════════════════════════════════════════
-- Searched across the repository: `performance.now()` appears ZERO
-- times. `console.time` ZERO. `EXPLAIN` ZERO outside prose. There is
-- exactly one persisted server-side duration in the product —
-- `mcp_call_log.duration_ms`, written by `server/mcp/dispatch.ts:165` —
-- and it covers MCP tool calls only. No route, no server action and no
-- database query has ever been timed in production.
--
-- So tomorrow's regression is invisible until a customer describes it,
-- which is how this track came to exist.
--
-- ══════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE DOES, AND WHAT IT HONESTLY CANNOT
-- ══════════════════════════════════════════════════════════════════════
-- `pg_stat_statements` gives per-normalised-statement call counts, total
-- and mean execution time, and rows — for free, with no application
-- change and no new table. That is the slow-query log.
--
-- 🔴 IT CANNOT ATTRIBUTE A TENANT. `pg_stat_statements` aggregates by
-- normalised query text; the tenant id is a bind parameter and is
-- normalised away. There is no version of this view that carries a
-- tenant id, and pretending otherwise would be exactly the defect this
-- repository keeps finding: a column that exists and is always NULL.
--
-- ⭐ TENANT ATTRIBUTION NEEDS ONE LINE IN `db/index.ts`, and that file
-- belongs to another track. `PATCH-REQUEST-F.md` asks for it:
--
--     SELECT set_config('application_name', 'ord:t:' || $tenantId, true)
--
-- alongside the existing `set_config('app.current_tenant_id', ...)` in
-- `withTenant()`. With it, `pg_stat_activity.application_name` names the
-- tenant behind every RUNNING query, and `ordence_active_queries()`
-- below reports it. That is SAMPLING, not a log — it sees a query only
-- while it is running. It is the honest ceiling of what can be had
-- without a new table, and it is what actually catches the pathological
-- case: the query that is still running.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ THE EXTENSION MAY NOT BE INSTALLABLE, AND THAT IS REPORTED, NOT
--    SWALLOWED
-- ══════════════════════════════════════════════════════════════════════
-- `pg_stat_statements` must be in `shared_preload_libraries`, which is a
-- server setting no migration can change. Neon preloads it; a plain
-- Postgres may not. So:
--
--   • `CREATE EXTENSION` is attempted and its failure is caught.
--   • The VIEW and the FUNCTIONS are created either way.
--   • `ordence_slow_queries()` returns an `available` flag that is TRUE
--     only when the extension is really present.
--
-- 🔴 The verification below asserts that flag matches `pg_extension`.
-- A monitoring surface that reports "no slow queries" when it is simply
-- not collecting is worse than no monitoring at all — it is the
-- `count(*) >= 10` gate with a dashboard on it.
--
-- ORDER: independent of the code push. The `application_name` patch in
-- PATCH-REQUEST-F.md improves `ordence_active_queries()` and is not
-- required for this file to be correct.
-- =====================================================================

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    -- ⚠️ "created", NOT "available". They are different things on a
    -- server without the library preloaded, and calling this
    -- "available" here is the sentence that made the first draft of
    -- this file wrong. ordence_slow_queries() decides availability by
    -- reading the view.
    RAISE NOTICE '0158: pg_stat_statements extension created (availability is probed, not assumed).';
  EXCEPTION WHEN OTHERS THEN
    -- ⚠️ Named, not silent. The operator needs to know the log is off.
    RAISE WARNING
      '0158: pg_stat_statements could NOT be created (%). ordence_slow_queries() '
      'will report available => false. On Neon it is preloaded; on a plain Postgres '
      'it needs shared_preload_libraries and a restart.', SQLERRM;
  END;
END
$$;

-- ---------------------------------------------------------------------
-- The slow-query log.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.ordence_slow_queries(numeric, integer);

CREATE OR REPLACE FUNCTION public.ordence_slow_queries(
  min_mean_ms numeric DEFAULT 25,
  max_rows    integer DEFAULT 50
)
RETURNS TABLE (
  available    boolean,
  mean_ms      numeric,
  max_ms       numeric,
  calls        bigint,
  total_ms     numeric,
  rows_per_call numeric,
  query_text   text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_present boolean;
  v_probe   bigint;
BEGIN
  /*
   * ══════════════════════════════════════════════════════════════════
   * 🔴 `pg_extension` IS NOT THE ANSWER, AND FINDING THAT OUT COST THIS
   *    FILE ONE REVISION.
   * ══════════════════════════════════════════════════════════════════
   * `CREATE EXTENSION pg_stat_statements` SUCCEEDS on a server where the
   * library is not in `shared_preload_libraries`. The extension object
   * is created, the view is created, `pg_extension` reports it present —
   * and every SELECT from the view raises:
   *
   *     ERROR: pg_stat_statements must be loaded via shared_preload_libraries
   *
   * That is precisely this repository's characteristic defect: declared
   * and unenforced. A catalogue check would have reported "available"
   * for a log that collects nothing and errors on every read.
   *
   * ⭐ SO AVAILABILITY IS DETERMINED BY TRYING, NOT BY ASKING. One
   * count against the view, inside an exception handler. It is the only
   * test that distinguishes "installed" from "working".
   */
  BEGIN
    EXECUTE 'SELECT count(*) FROM pg_stat_statements' INTO v_probe;
    v_present := true;
  EXCEPTION WHEN OTHERS THEN
    v_present := false;
  END;

  IF NOT v_present THEN
    -- ⭐ ONE ROW, SAYING SO. Not zero rows — zero rows reads as "nothing
    -- is slow", which is the lie this whole file is written against.
    RETURN QUERY
      SELECT false, NULL::numeric, NULL::numeric, NULL::bigint, NULL::numeric,
             NULL::numeric,
             'pg_stat_statements is not readable on this server; no query timings are '
             'being collected. The extension may exist while the library is absent from '
             'shared_preload_libraries — CREATE EXTENSION succeeds and every read fails.'::text;
    RETURN;
  END IF;

  -- ⚠️ `max_rows` is CLAMPED, not trusted. This function is the kind of
  -- thing that ends up behind an admin endpoint, and an endpoint that
  -- can return unbounded rows is an availability incident with a polite
  -- name — the same rule this track applied to every application query.
  RETURN QUERY EXECUTE format(
    $q$
      SELECT true,
             round(s.mean_exec_time::numeric, 3),
             round(s.max_exec_time::numeric, 3),
             s.calls,
             round(s.total_exec_time::numeric, 1),
             round((s.rows::numeric / GREATEST(s.calls, 1)), 1),
             left(s.query, 400)
        FROM pg_stat_statements s
       WHERE s.mean_exec_time >= %L
         AND s.query NOT LIKE '%%pg_stat_statements%%'
       ORDER BY s.mean_exec_time DESC
       LIMIT %s
    $q$,
    GREATEST(min_mean_ms, 0),
    LEAST(GREATEST(max_rows, 1), 200)
  );
END
$$;

COMMENT ON FUNCTION public.ordence_slow_queries(numeric, integer) IS
  'Track F / 0158. The slow-query log. Returns available=false as a ROW, never as '
  'zero rows, so "not collecting" can never be read as "nothing is slow". '
  'No tenant attribution is possible here — see ordence_active_queries().';

-- ---------------------------------------------------------------------
-- Live queries, with a tenant when the application supplies one.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.ordence_active_queries(integer);

CREATE OR REPLACE FUNCTION public.ordence_active_queries(
  min_running_ms integer DEFAULT 250
)
RETURNS TABLE (
  running_ms   numeric,
  tenant_id    uuid,
  state        text,
  wait_event   text,
  query_text   text
)
LANGUAGE sql
STABLE
AS $$
  SELECT round(EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)) * 1000, 0)::numeric,
         /*
          * ⚠️ NULL UNTIL `withTenant()` SETS `application_name`. That is
          * the patch in PATCH-REQUEST-F.md. A NULL here means "the
          * application did not say", which is a different and more
          * useful statement than a zero.
          */
         CASE WHEN a.application_name LIKE 'ord:t:%'
              THEN substring(a.application_name from 7)::uuid END,
         a.state::text,
         coalesce(a.wait_event_type || ':' || a.wait_event, '')::text,
         left(a.query, 400)
    FROM pg_stat_activity a
   WHERE a.datname = current_database()
     AND a.pid <> pg_backend_pid()
     AND a.state <> 'idle'
     AND a.query_start IS NOT NULL
     AND clock_timestamp() - a.query_start
           > make_interval(secs => GREATEST(min_running_ms, 0) / 1000.0)
   ORDER BY a.query_start
   LIMIT 200;
$$;

COMMENT ON FUNCTION public.ordence_active_queries(integer) IS
  'Track F / 0158. Sampling, not a log: reports queries that are STILL RUNNING. '
  'tenant_id is non-NULL only once withTenant() sets application_name to '
  'ord:t:<uuid> — see PATCH-REQUEST-F.md.';

-- ---------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_declared boolean;
  v_working  boolean;
  v_reported boolean;
  v_rows     int;
  v_probe    bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ordence_slow_queries') THEN
    RAISE EXCEPTION '0158 FAILED: ordence_slow_queries() was not created.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ordence_active_queries') THEN
    RAISE EXCEPTION '0158 FAILED: ordence_active_queries() was not created.';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')
    INTO v_declared;

  -- The independent probe: can the view actually be read?
  BEGIN
    EXECUTE 'SELECT count(*) FROM pg_stat_statements' INTO v_probe;
    v_working := true;
  EXCEPTION WHEN OTHERS THEN
    v_working := false;
  END;

  -- 🔴 THE CHECK WITH TEETH. The function's `available` flag must track
  -- WHETHER THE VIEW READS, not whether the extension is declared. Those
  -- two differ on exactly the server where this matters most.
  SELECT available INTO v_reported FROM public.ordence_slow_queries(0, 1) LIMIT 1;

  IF v_reported IS DISTINCT FROM v_working THEN
    RAISE EXCEPTION
      '0158 FAILED: ordence_slow_queries() reports available=% but a direct probe of '
      'the view says %. The availability flag does not track reality, so "no slow '
      'queries" would be indistinguishable from "not collecting".', v_reported, v_working;
  END IF;

  IF v_declared AND NOT v_working THEN
    RAISE WARNING
      '0158: pg_stat_statements EXISTS as an extension but cannot be read — the '
      'library is not in shared_preload_libraries. No query timings are being '
      'collected. ordence_slow_queries() reports this honestly; nothing else will.';
  END IF;

  -- And it must ANSWER, not merely exist. A function that raises on call
  -- is the `RETURNS TABLE(... bigint)` trap 0108 already found here.
  SELECT count(*) INTO v_rows FROM public.ordence_active_queries(0);

  RAISE NOTICE
    '0158 PASS: extension declared=%, view readable=%, ordence_active_queries() '
    'returned % row(s). Tenant attribution requires the application_name change in '
    'PATCH-REQUEST-F.md.', v_declared, v_working, v_rows;
END
$$;
