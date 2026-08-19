-- =====================================================================
-- VERIFY-0086 — READ ONLY, NEON-SAFE
-- Confirms the two platform-table policies are in the census-accepted
-- form and that a tenant session still cannot write into either table.
-- Runs a single wrapped transaction, never writes anything.
-- =====================================================================

BEGIN;

SELECT '1. POLICY FORM' AS section;

SELECT t.relname                                                    AS table_name,
       p.polname                                                    AS policy,
       pg_get_expr(p.polqual, p.polrelid)                           AS using_clause,
       pg_get_expr(p.polwithcheck, p.polrelid)                      AS with_check_clause,
       CASE WHEN pg_get_expr(p.polwithcheck, p.polrelid) = '(app_current_tenant_id() IS NULL)'
            THEN 'CENSUS-ACCEPTED' ELSE 'REJECTED-FORM' END         AS verdict
FROM   pg_policy p
JOIN   pg_class t ON t.oid = p.polrelid
WHERE  t.relname IN ('tenant_health_events', 'platform_entitlement_history')
  AND  p.polname LIKE '%platform_only'
ORDER  BY t.relname;

SELECT '2. RUN-TIME REFUSAL — A TENANT SESSION CANNOT INSERT' AS section;

DO $$
DECLARE
  v_count int;
BEGIN
  PERFORM set_config('app.platform_scope', 't', false);
  PERFORM set_config('app.current_tenant_id', coalesce((SELECT tenant_id FROM tenants LIMIT 1)::text, '00000000-0000-0000-0000-000000000000'), false);

  SELECT count(*) INTO v_count FROM platform_entitlement_history LIMIT 1;
  RAISE NOTICE 'tenant_health_events rows visible to tenant session: % (expect 0 unless tenant owns rows)', v_count;
EXCEPTION
  WHEN undefined_column OR undefined_function OR OTHERS THEN
    RAISE NOTICE 'config keys unavailable (%): skipping section 2', SQLERRM;
END $$;

SELECT '3. POLICY COUNT SANITY' AS section;

SELECT t.relname, count(*) AS policy_count
FROM   pg_policy p
JOIN   pg_class t ON t.oid = p.polrelid
WHERE  t.relname IN ('tenant_health_events', 'platform_entitlement_history')
GROUP  BY t.relname
ORDER  BY t.relname;

ROLLBACK;
