-- ══════════════════════════════════════════════════════════════════════════
-- 0047 — GRANT SELECT ON THREE VIEWS THE APPLICATION ROLE COULD NOT READ
-- Ordence · 11 August 2026
-- ══════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT
-- ----------
-- `ALL-IN-ONE-SETUP.sql` §"GRANTS" runs
--
--     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
--       TO ordence_app;
--
-- and its own comment is explicit that this is deliberately NOT
-- `ALTER DEFAULT PRIVILEGES`, because default privileges would silently grant
-- on every future object — including ones added later that were meant to stay
-- restricted.
--
-- That decision is right. Its consequence is that **any object created after
-- that statement needs its own explicit GRANT**, and every SQL file that
-- creates a view has duly carried one:
--
--     0008  v_asset_portfolio, v_ledger_daily, v_contract_pipeline
--     0032  v_compliance_board, v_compliance_licence_board
--     0033  v_schedule_utilisation
--     0034  v_rate_card_candidates
--     0035  v_meter_status, v_meter_estimates_outstanding
--     0036  v_field_dispatch_board, v_field_technician_performance
--     0037  v_vault_retention_due, v_vault_access_summary
--     0038  v_boq_consumption, v_site_labour_summary
--
-- Three did not:
--
--     0040_stock_reservation_floor.sql   v_stock_over_committed
--     0041_contracting_depth.sql         v_boq_billing_position
--     0042_mcp_access.sql                v_mcp_activity
--
-- Measured on a freshly built database: 19 views in `public`, 16 readable by
-- `ordence_app`. These are the missing three.
--
-- ⚠️ THIS IS A PRODUCTION DEFECT, NOT A TEST-SETUP ARTEFACT.
-- The application connects as `ordence_app`. Any query against these three
-- views fails at runtime with
--
--     ERROR:  permission denied for view v_boq_billing_position  (SQLSTATE 42501)
--
-- It is not a data leak — a missing GRANT fails closed, which is the safe
-- direction. It is a feature that cannot work: BOQ billing position on
-- contracting/RA bills, the over-commitment check on stock reservations, and
-- the MCP activity view.
--
-- HOW IT WENT UNNOTICED
-- ---------------------
-- `npm run check:rls` reports "all 166 tenant-scoped tables enabled, forced and
-- policied" — and that is true. RLS coverage and GRANT coverage are different
-- questions, and nothing was asking the second one. The security suite caught
-- it the first time it was ever run against a real database.
--
-- WHY THE VIEWS DO NOT NEED RLS OF THEIR OWN
-- ------------------------------------------
-- Each selects from base tables that are themselves RLS-forced, and none is
-- defined with `security_invoker = off` in a way that would bypass the caller's
-- policies. Isolation therefore still comes from the underlying tables; this
-- file changes reachability only, never visibility.
--
-- IDEMPOTENT. Safe to run more than once, and safe to run before or after the
-- files that create the views — the guard skips anything not yet present.
-- ══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v text;
  granted int := 0;
  missing int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    RAISE NOTICE '0047: role ordence_app does not exist here — nothing to do.';
    RETURN;
  END IF;

  FOREACH v IN ARRAY ARRAY[
    'v_stock_over_committed',   -- 0040_stock_reservation_floor.sql
    'v_boq_billing_position',   -- 0041_contracting_depth.sql
    'v_mcp_activity'            -- 0042_mcp_access.sql
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v AND c.relkind = 'v'
    ) THEN
      EXECUTE format('GRANT SELECT ON public.%I TO ordence_app', v);
      granted := granted + 1;
    ELSE
      missing := missing + 1;
      RAISE NOTICE '0047: view % not present — skipped.', v;
    END IF;
  END LOOP;

  RAISE NOTICE '0047: granted SELECT on % view(s); % not present.', granted, missing;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- ASSERTION — fail loudly rather than report success on a no-op.
--
-- A migration that grants nothing and prints nothing is indistinguishable from
-- one that worked. If the views exist, the role must be able to read them by
-- the time this file finishes.
-- ══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    RETURN;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'v'
    AND c.relname IN ('v_stock_over_committed', 'v_boq_billing_position', 'v_mcp_activity')
    AND NOT has_table_privilege('ordence_app', c.oid, 'SELECT');

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0047 FAILED — ordence_app still cannot SELECT: %', bad;
  END IF;
END $$;
