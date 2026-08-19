-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — FILE 17
-- Why does /dashboard say "This screen failed to load"?
--
-- READ-ONLY. Creates nothing, changes nothing, deletes nothing.
-- Paste the whole thing into the Neon SQL Editor and send me the output.
--
-- The dashboard is not like other screens. It reads three SQL VIEWS
-- rather than tables, and those views must exist AND carry the setting
-- `security_invoker = true`. Without that setting a view runs as its
-- OWNER, so row-level security does not apply and one tenant sees every
-- tenant's money — with no error and no symptom. That is why the
-- dashboard is the screen most likely to fail on a fresh database, and
-- why it must fail loudly rather than quietly show the wrong numbers.
-- ══════════════════════════════════════════════════════════════════════


-- ── CHECK 1 — Do the three dashboard views exist at all? ──────────────
--
-- Expect exactly three rows, all saying EXISTS.
-- A view reported MISSING means SQL-FILES/0008_phase10_analytics.sql
-- never ran, and that alone would produce the error you are seeing.

SELECT
  '1. VIEWS EXIST'                              AS check,
  needed.view_name,
  CASE WHEN v.viewname IS NULL
       THEN '🔴 MISSING — run 0008_phase10_analytics.sql'
       ELSE '✅ EXISTS'
  END                                           AS status
FROM (VALUES
        ('v_asset_portfolio'),
        ('v_ledger_daily'),
        ('v_contract_pipeline')
     ) AS needed(view_name)
LEFT JOIN pg_views v
       ON v.schemaname = 'public'
      AND v.viewname   = needed.view_name
ORDER BY needed.view_name;


-- ── CHECK 2 — ⭐ Is security_invoker actually ON? ─────────────────────
--
-- The check that matters most, and the one with no symptom when it is
-- wrong. A view that EXISTS but has security_invoker OFF does not throw;
-- it returns other tenants' rows. If any row below says 🔴, stop and
-- tell me before opening the dashboard again.

SELECT
  '2. SECURITY_INVOKER'                         AS check,
  c.relname                                     AS view_name,
  COALESCE(
    (SELECT o FROM unnest(c.reloptions) AS o
      WHERE o LIKE 'security_invoker=%'),
    'security_invoker=(not set → defaults to FALSE)'
  )                                             AS setting,
  CASE
    WHEN 'security_invoker=true' = ANY(c.reloptions) THEN '✅ SAFE'
    ELSE '🔴 CROSS-TENANT LEAK — this view returns every tenant''s rows'
  END                                           AS status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN ('v_asset_portfolio','v_ledger_daily','v_contract_pipeline')
ORDER BY c.relname;


-- ── CHECK 3 — Did your sign-up actually create a tenant? ──────────────
--
-- You are signed in and the sidebar says "Ordence / General Business",
-- so the Clerk webhook fired. This confirms it landed in the database
-- rather than only in Clerk.

SELECT
  '3. TENANT ROW'                               AS check,
  COUNT(*)                                      AS tenants,
  CASE WHEN COUNT(*) = 0
       THEN '🔴 NONE — the webhook did not write. Every screen will fail'
       ELSE '✅ ' || COUNT(*)::text || ' tenant(s)'
  END                                           AS status
FROM tenants;

SELECT
  '3b. TENANT DETAIL'                           AS check,
  id, slug, name, created_at
FROM tenants
ORDER BY created_at DESC
LIMIT 5;


-- ── CHECK 4 — The tables the dashboard's panels read ──────────────────
--
-- `subscriptions` and `roles` being empty was flagged as a likely cause
-- of the earlier digest 817564861. This says whether that is still true.

SELECT
  '4. SUPPORTING ROWS'                          AS check,
  t.table_name,
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=t.table_name
    ) THEN '🔴 TABLE MISSING'
    ELSE '✅ table exists'
  END                                           AS status
FROM (VALUES
        ('subscriptions'), ('roles'), ('plans'),
        ('journal_entries'), ('assets'), ('contracts')
     ) AS t(table_name)
ORDER BY t.table_name;


-- ── CHECK 5 — Row counts, only for tables that exist ──────────────────

SELECT '5. ROW COUNTS' AS check, 'tenants'         AS table_name, COUNT(*) AS rows FROM tenants
UNION ALL SELECT '5. ROW COUNTS', 'subscriptions',  COUNT(*) FROM subscriptions
UNION ALL SELECT '5. ROW COUNTS', 'roles',          COUNT(*) FROM roles
UNION ALL SELECT '5. ROW COUNTS', 'plans',          COUNT(*) FROM plans
UNION ALL SELECT '5. ROW COUNTS', 'journal_entries',COUNT(*) FROM journal_entries
UNION ALL SELECT '5. ROW COUNTS', 'assets',         COUNT(*) FROM assets
UNION ALL SELECT '5. ROW COUNTS', 'contracts',      COUNT(*) FROM contracts
ORDER BY table_name;


-- ── CHECK 6 — Can the views be SELECTed without error? ────────────────
--
-- Existing is not the same as working. A view whose underlying column was
-- renamed still appears in pg_views and throws the moment it is read —
-- which is exactly what the dashboard does. This reads each one and
-- reports the error text instead of aborting.

DO $$
DECLARE
  v   text;
  n   bigint;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_asset_portfolio','v_ledger_daily','v_contract_pipeline']
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM %I', v) INTO n;
      RAISE NOTICE '✅ % — readable, % row(s)', v, n;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '🔴 % — FAILED: %', v, SQLERRM;
    END;
  END LOOP;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- WHAT TO SEND ME
-- ══════════════════════════════════════════════════════════════════════
-- All six results, including the NOTICE lines from check 6 — in the Neon
-- SQL Editor those appear under the results grid, not in it. Check 6 is
-- the one most likely to name the actual fault.
-- ══════════════════════════════════════════════════════════════════════
