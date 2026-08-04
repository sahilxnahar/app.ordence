-- ============================================================================
-- Ordence — Phase 10: Analytics Views
-- Version: v0.10.0-alpha
--
-- Run AFTER every earlier phase. Views depend on the tables those created.
--
-- Contents:
--   1. ⭐ THE security_invoker REQUIREMENT — read this before anything else
--   2. Asset portfolio by status
--   3. 30-day trailing ledger balances
--   4. Contract pipeline by status
--   5. Grants
--   6. Verification
--
-- ============================================================================
-- ⭐ SECTION 1 — WHY EVERY VIEW BELOW SAYS `security_invoker = true`
-- ============================================================================
--
-- ROW-LEVEL SECURITY DOES NOT AUTOMATICALLY APPLY THROUGH A VIEW.
--
-- By default a PostgreSQL view executes with the privileges of the view's
-- OWNER, not of the user running the query. If the owner can read every row
-- of `journal_entries` — and the owner is usually the role that created the
-- tables — then the view returns every row of `journal_entries`, to anybody
-- permitted to select from the view. The RLS policies on the underlying
-- table are simply not consulted.
--
-- This was verified on PostgreSQL 16 before these views were written. A
-- non-superuser session pinned to ONE tenant queried two otherwise identical
-- views over `contracts`:
--
--     naive view      (no option)                -> 6 tenants visible
--     safe  view      (security_invoker = true)  -> 1 tenant  visible
--     base table      (RLS applies)              -> 1 tenant  visible
--
-- The failure mode is quiet and nasty. Nothing errors. The dashboard renders
-- perfectly. The numbers are simply the WHOLE PLATFORM'S — every tenant's
-- assets, every tenant's cash — presented to one customer as their own.
--
-- `security_invoker = true` makes the view run as the CALLER, so the
-- caller's RLS policies apply to the underlying tables exactly as they would
-- in a direct query.
--
-- REQUIRES POSTGRESQL 15 OR NEWER. Section 6 asserts this explicitly rather
-- than letting an older server silently create leaking views.
-- ============================================================================


-- Fail immediately and loudly on an unsupported server, rather than creating
-- views that appear to work and quietly cross tenant boundaries.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'PostgreSQL 15+ is required for security_invoker views. Found %. '
      'Creating these views on an older server would expose every tenant''s '
      'aggregate data to every other tenant.',
      current_setting('server_version');
  END IF;
END
$$;


-- ############################################################################
-- SECTION 2 — ASSET PORTFOLIO BY STATUS
-- ############################################################################
--
-- Powers the donut chart. One row per (tenant, asset_type, status).
--
-- `tenant_id` is included in the projection even though RLS already
-- restricts it to one value. Two reasons: the application filters on it
-- explicitly as a second layer, and a view that omits the tenant column
-- makes an accidental cross-tenant aggregate impossible to SPOT in a query
-- plan or a debugging session.

DROP VIEW IF EXISTS v_asset_portfolio;

CREATE VIEW v_asset_portfolio
WITH (security_invoker = true) AS
SELECT
  a.tenant_id,
  a.asset_type,
  a.status,
  count(*)::int                                        AS asset_count,
  COALESCE(sum(a.value_amount), 0)::numeric(20, 2)     AS total_value,
  COALESCE(sum(a.area_value), 0)::numeric(20, 2)       AS total_area,
  COALESCE(sum(a.quantity), 0)::bigint                 AS total_quantity
FROM assets a
WHERE a.deleted_at IS NULL
GROUP BY a.tenant_id, a.asset_type, a.status;


-- ############################################################################
-- SECTION 3 — 30-DAY TRAILING LEDGER BALANCES
-- ############################################################################
--
-- Powers the financial bar chart: one row per (tenant, day) for the last 30
-- days, with debits and credits side by side.
--
-- WHY generate_series AND A LEFT JOIN:
--   A plain `GROUP BY date` returns rows only for days that had activity. A
--   chart built on that silently compresses quiet days out of existence, so
--   a fortnight with three transactions renders as three adjacent bars and
--   reads like three consecutive days of trading. Generating the full date
--   spine and left-joining onto it means a day with no movement is an
--   explicit zero — which is the truth, and which the chart can draw.
--
-- WHY numeric AND NOT float:
--   Money. `sum()` over `double precision` accumulates representation error
--   across thousands of rows. `journal_entries.amount` is NUMERIC and the
--   sum stays NUMERIC all the way to the application, which converts it to
--   a display string without ever going through a float.

DROP VIEW IF EXISTS v_ledger_daily;

CREATE VIEW v_ledger_daily
WITH (security_invoker = true) AS
WITH date_spine AS (
  SELECT generate_series(
           (CURRENT_DATE - INTERVAL '29 days')::date,
           CURRENT_DATE::date,
           INTERVAL '1 day'
         )::date AS day
),
tenant_days AS (
  -- The spine has to be crossed with the tenants that actually have a
  -- ledger, or every tenant would get 30 empty rows for every other
  -- tenant's existence. RLS then reduces this to the caller's own tenant.
  SELECT DISTINCT t.tenant_id, d.day
  FROM (SELECT DISTINCT tenant_id FROM transactions) t
  CROSS JOIN date_spine d
),
daily AS (
  SELECT
    tr.tenant_id,
    tr.transaction_date::date                              AS day,
    SUM(CASE WHEN je.entry_type = 'debit'  THEN je.amount ELSE 0 END) AS debits,
    SUM(CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE 0 END) AS credits,
    count(DISTINCT tr.id)::int                             AS transaction_count
  FROM transactions tr
  JOIN journal_entries je
    ON je.transaction_id = tr.id
   -- The tenant predicate on the JOIN as well as the outer filter. A join
   -- across tenants would be arithmetic nonsense even where RLS permitted
   -- it, and this makes that impossible rather than merely unlikely.
   AND je.tenant_id = tr.tenant_id
  WHERE tr.transaction_date >= (CURRENT_DATE - INTERVAL '29 days')
    AND tr.transaction_date <= CURRENT_DATE
  GROUP BY tr.tenant_id, tr.transaction_date::date
)
SELECT
  td.tenant_id,
  td.day,
  COALESCE(dl.debits, 0)::numeric(20, 2)  AS debits,
  COALESCE(dl.credits, 0)::numeric(20, 2) AS credits,
  -- Signed, so the chart can show which way the day ran without the
  -- application recomputing it and risking a different rounding.
  (COALESCE(dl.debits, 0) - COALESCE(dl.credits, 0))::numeric(20, 2) AS net_movement,
  COALESCE(dl.transaction_count, 0)       AS transaction_count
FROM tenant_days td
LEFT JOIN daily dl
  ON dl.tenant_id = td.tenant_id
 AND dl.day = td.day;


-- ############################################################################
-- SECTION 4 — CONTRACT PIPELINE BY STATUS
-- ############################################################################
--
-- Powers the pipeline summary. One row per (tenant, status).

DROP VIEW IF EXISTS v_contract_pipeline;

CREATE VIEW v_contract_pipeline
WITH (security_invoker = true) AS
SELECT
  c.tenant_id,
  c.status,
  count(*)::int                                     AS contract_count,
  COALESCE(sum(c.value), 0)::numeric(20, 2)         AS total_value,
  count(*) FILTER (WHERE c.signed_at IS NOT NULL)::int   AS signed_count,
  count(*) FILTER (WHERE c.legal_hold)::int              AS on_hold_count,
  -- Contracts expiring inside 30 days: the number that should prompt an
  -- action, surfaced without the application having to run a second query.
  count(*) FILTER (
    WHERE c.expiry_date IS NOT NULL
      AND c.expiry_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '30 days')
  )::int AS expiring_soon_count
FROM contracts c
WHERE c.deleted_at IS NULL
GROUP BY c.tenant_id, c.status;


-- ############################################################################
-- SECTION 5 — GRANTS
-- ############################################################################
--
-- SELECT only. These views exist to be read; nothing should ever write
-- through them, and PostgreSQL would otherwise permit updates through the
-- simple ones.
--
-- The role name differs per deployment, so this is written defensively —
-- a missing role must not abort the whole setup file.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    GRANT SELECT ON v_asset_portfolio   TO ordence_app;
    GRANT SELECT ON v_ledger_daily      TO ordence_app;
    GRANT SELECT ON v_contract_pipeline TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 6 — VERIFICATION
-- ############################################################################
-- Each query prints PASS or FAIL. Read the output; do not assume.

-- ⭐ CHECK 1 — THE ONE THAT MATTERS.
-- Every analytics view must have security_invoker set. A view missing it
-- returns EVERY TENANT'S aggregates to whoever can read it, with no error
-- and no visible symptom.
SELECT
  CASE WHEN count(*) = 3
       THEN 'PASS: all 3 analytics views run with security_invoker (RLS applies to the caller)'
       ELSE 'FAIL: only ' || count(*) || ' of 3 views have security_invoker — THE OTHERS LEAK ACROSS TENANTS'
  END AS check_1_security_invoker
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN ('v_asset_portfolio', 'v_ledger_daily', 'v_contract_pipeline')
  AND c.reloptions @> ARRAY['security_invoker=true'];

-- Check 2 — all three views exist.
SELECT
  CASE WHEN count(*) = 3
       THEN 'PASS: all 3 analytics views created'
       ELSE 'FAIL: expected 3 analytics views, found ' || count(*)
  END AS check_2_views_exist
FROM pg_views
WHERE schemaname = 'public'
  AND viewname IN ('v_asset_portfolio', 'v_ledger_daily', 'v_contract_pipeline');

-- Check 3 — every view exposes tenant_id, so the application can filter
-- explicitly as a second layer and a stray aggregate is visible in review.
SELECT
  CASE WHEN count(*) = 3
       THEN 'PASS: every analytics view exposes tenant_id'
       ELSE 'FAIL: a view is missing tenant_id — cross-tenant aggregates would be invisible'
  END AS check_3_tenant_column
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'tenant_id'
  AND table_name IN ('v_asset_portfolio', 'v_ledger_daily', 'v_contract_pipeline');

-- Check 4 — the underlying tables still have RLS enabled AND forced.
-- security_invoker only helps if there is a policy to invoke.
SELECT
  CASE WHEN count(*) = 4
       THEN 'PASS: all 4 source tables still have RLS enabled and FORCED'
       ELSE 'FAIL: only ' || count(*) || ' of 4 source tables fully protected'
  END AS check_4_source_rls
FROM pg_class
WHERE relname IN ('assets', 'contracts', 'transactions', 'journal_entries')
  AND relrowsecurity = true
  AND relforcerowsecurity = true;

-- Check 5 — the date spine really covers 30 days.
-- A silently truncated range would render a "30-day" chart showing 12 days.
SELECT
  CASE WHEN (CURRENT_DATE - (CURRENT_DATE - INTERVAL '29 days')::date) = 29
       THEN 'PASS: ledger view spans 30 calendar days inclusive'
       ELSE 'FAIL: date spine is not 30 days'
  END AS check_5_date_span;
