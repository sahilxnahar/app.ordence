-- =====================================================================
-- ⭐⭐⭐ 0086 — THE TWO POLICIES, RESTORED TO THE HOUSE FORM
-- =====================================================================
-- 🔴 WHY THIS FILE EXISTS
--    `SQL-FILES/0079_rls_opt_in_and_telemetry.sql` made the platform
--    policies on `tenant_health_events` and `platform_entitlement_history`
--    say the same thing twice — `USING (app_platform_scope())` and
--    `WITH CHECK (app_platform_scope())` — and that broke the house
--    convention the rest of the platform tables keep:
--
--        USING      (app_current_tenant_id() IS NULL)     -- reads: any non-tenant session
--        WITH CHECK (app_platform_scope())                -- writes: EXPLICIT platform scope only
--
--    The asymmetry is load-bearing. `app_platform_scope()` is true ONLY
--    inside `withPlatformScope(reason, ...)`, where a human wrote down
--    WHY the session may write as the platform. `app_current_tenant_id()
--    IS NULL` is true for ANY session that has not set a tenant: a cron
--    job, a background worker, a fresh pooled connection, a code path
--    that forgot withTenant. Granting that half of the pair to the write
--    side would hand write access to every forgotten withTenant in the
--    product — so the write clause STAYS `app_platform_scope()` here, in
--    the house form, and this file restores the read side to the same
--    shape every other platform table has (`app_current_tenant_id() IS
--    NULL`, with the OR letting an explicitly-scoped session read too).
--
--    ⚠️ WHY THE READ SIDE IS WIDENED BUT THE WRITE SIDE IS NOT: a read
--    clause can never leak a row that was not written, so widening it
--    changes what is visible, not what is protected. A write clause is
--    the half that decides whether a row can be created at all — it is
--    the half that must never be the comfortable one.
--
--    ⚠️ IF A CHECKER EVER FLAGS `WITH CHECK (app_platform_scope())`
--    AGAIN, the checker is misreading the safest form in the codebase.
--    Fix the checker and write down why — never widen the policy to
--    quiet a census.
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
      WITH CHECK (app_platform_scope());
  END IF;

  IF to_regclass('public.platform_entitlement_history') IS NOT NULL
     AND to_regproc('app_current_tenant_id') IS NOT NULL
     AND to_regproc('app_platform_scope') IS NOT NULL
  THEN
    DROP POLICY IF EXISTS platform_entitlement_history_platform_only ON platform_entitlement_history;
    CREATE POLICY platform_entitlement_history_platform_only ON platform_entitlement_history
      USING      (app_current_tenant_id() IS NULL OR app_platform_scope())
      WITH CHECK (app_platform_scope());
  END IF;
END
$$;

COMMIT;
