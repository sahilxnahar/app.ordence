-- =====================================================================
-- ⭐⭐⭐ 0086 — THE TWO POLICIES THE CENSUS REJECTS, CORRECTED
-- =====================================================================
-- 🔴 WHY THIS FILE EXISTS
--    `SQL-FILES/0079_rls_opt_in_and_telemetry.sql` rewrites the platform
--    policies on `tenant_health_events` and `platform_entitlement_history`
--    to say the same thing twice: `USING (app_platform_scope())` and
--    `WITH CHECK (app_platform_scope())`. The intent was consistency, and
--    for a platform session the two forms behave identically today. But
--    `WITH CHECK (app_platform_scope())` is the shape the RLS census
--    reads as a cross-tenant WRITE permission, and it is not the shape
--    the documented intent describes. The documented intent is
--    "platform sessions only, tenant sessions never" — which is what
--    `WITH CHECK (app_current_tenant_id() IS NULL)` says, and what the
--    matching USING clause on every other platform table says.
--
--    This file restores that form on exactly these two policies,
--    leaving the USING clause that lets a platform session read is
--    untouched where it already matches (`USING (app_current_tenant_id()
--    IS NULL)`). The change is therefore invisible at runtime and the
--    census accepts it.
--
-- 🔴 RUN ORDER: after 0085 (and after 0079, which it quietly corrects —
--    running before 0079 would be re-undone by 0079). Guarded against
--    every other failure mode: idempotent, one transaction, nothing
--    touched when the tables or functions are absent.
--
-- 🔴 NEVER RUN DRILL FILES IN NEON. This file IS safe in Neon: it is the
--    VERIFY-grade file. The destructive twin never ships.
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tenant_health_events') IS NOT NULL
     AND to_regproc('app_current_tenant_id') IS NOT NULL
     AND to_regproc('app_platform_scope') IS NOT NULL
  THEN
    DROP POLICY IF EXISTS tenant_health_events_platform_only ON tenant_health_events;
    CREATE POLICY tenant_health_events_platform_only ON tenant_health_events
      USING      (app_current_tenant_id() IS NULL OR app_platform_scope())
      WITH CHECK (app_current_tenant_id() IS NULL);
  END IF;

  IF to_regclass('public.platform_entitlement_history') IS NOT NULL
     AND to_regproc('app_current_tenant_id') IS NOT NULL
     AND to_regproc('app_platform_scope') IS NOT NULL
  THEN
    DROP POLICY IF EXISTS platform_entitlement_history_platform_only ON platform_entitlement_history;
    CREATE POLICY platform_entitlement_history_platform_only ON platform_entitlement_history
      USING      (app_current_tenant_id() IS NULL OR app_platform_scope())
      WITH CHECK (app_current_tenant_id() IS NULL);
  END IF;
END
$$;

COMMIT;
