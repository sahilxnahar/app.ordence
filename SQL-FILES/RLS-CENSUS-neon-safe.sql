-- =====================================================================
--  ORDENCE , IS TENANT ISOLATION STILL INTACT?
--  Read only. SAFE AGAINST NEON. Safe to run on production.
-- =====================================================================
--  🔴 RUN THIS IF `drizzle-kit push` MAY HAVE TOUCHED THIS DATABASE.
--
--  `drizzle-kit push` reconciles the schema and DROPS ROW LEVEL SECURITY
--  POLICIES while doing it. The product's npm script blocks it for that
--  reason. A database that has been pushed to looks completely normal:
--  every table is there, every column is there, every query works. The
--  only difference is that RLS is no longer enforcing anything, so every
--  tenant can read every other tenant's rows.
--
--  This file asks the one question that distinguishes those two states.
--
--
--  ⚠️ EIGHT TABLES ARE DELIBERATELY EXEMPT, and the list is not mine.
--  It is `OPT_IN_PLATFORM_WRITE` in `scripts/check-rls-coverage.mjs`,
--  copied verbatim. These carry a `tenant_id` column but are PLATFORM
--  evidence tables: their policy is written against `app_platform_scope()`
--  rather than `app_current_tenant_id()`, on purpose. Version 1 of this
--  file flagged two of them as a BREACH on a database that was perfectly
--  healthy, because it asserted the SHAPE of a policy instead of asking
--  what the table is for. If a NEW name ever appears in section 2, it is
--  real: it means a tenant table lost its policy.
--
--  WHAT GOOD LOOKS LIKE: section 1 says ALL CLEAR, and section 2 is empty.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. THE HEADLINE.
--     Every table in `public` that carries a `tenant_id` column must
--     have RLS ENABLED, RLS FORCED, and at least one policy that
--     mentions `app_current_tenant_id`. Enabled-but-not-forced is not a
--     lesser problem: the table's OWNER ignores a policy that is not
--     forced, and this application has connected as an owner before.
-- ---------------------------------------------------------------------
WITH scoped AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
    )
    AND c.relname NOT IN (
      'login_lockouts','error_events','platform_entitlement_history',
      'platform_impersonation_sessions','platform_tenant_flags','security_events',
      'tenant_health_events','web_vital_events'
    )
),
judged AS (
  SELECT
    s.relname,
    s.relrowsecurity                          AS rls_enabled,
    s.relforcerowsecurity                     AS rls_forced,
    COALESCE((SELECT count(*) FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = s.relname), 0) AS policies,
    COALESCE((SELECT bool_or(p.qual::text LIKE '%app_current_tenant_id%')
              FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = s.relname), false) AS has_tenant_policy
  FROM scoped s
)
SELECT
  '1. TENANT ISOLATION' AS section,
  count(*)                                                        AS tenant_scoped_tables,
  count(*) FILTER (WHERE rls_enabled AND rls_forced AND has_tenant_policy) AS fully_protected,
  count(*) FILTER (WHERE NOT rls_enabled)                         AS rls_off,
  count(*) FILTER (WHERE rls_enabled AND NOT rls_forced)          AS enabled_but_not_forced,
  count(*) FILTER (WHERE rls_enabled AND NOT has_tenant_policy)   AS no_tenant_policy,
  CASE
    WHEN count(*) FILTER (WHERE NOT (rls_enabled AND rls_forced AND has_tenant_policy)) = 0
      THEN 'ALL CLEAR , tenant isolation is intact on every tenant-scoped table.'
    ELSE '🔴 BREACH , ' ||
         count(*) FILTER (WHERE NOT (rls_enabled AND rls_forced AND has_tenant_policy))::text ||
         ' table(s) are not protected. Section 2 names them. Treat this as a live incident.'
  END AS verdict
FROM judged;

-- ---------------------------------------------------------------------
--  2. THE TABLES THEMSELVES. Empty result is the answer you want.
-- ---------------------------------------------------------------------
WITH scoped AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                  AND a.attnum > 0 AND NOT a.attisdropped)
    AND c.relname NOT IN (
      'login_lockouts','error_events','platform_entitlement_history',
      'platform_impersonation_sessions','platform_tenant_flags','security_events',
      'tenant_health_events','web_vital_events'
    )
),
judged AS (
  SELECT s.relname, s.relrowsecurity AS rls_enabled, s.relforcerowsecurity AS rls_forced,
    COALESCE((SELECT count(*) FROM pg_policies p
              WHERE p.schemaname='public' AND p.tablename=s.relname),0) AS policies,
    COALESCE((SELECT bool_or(p.qual::text LIKE '%app_current_tenant_id%') FROM pg_policies p
              WHERE p.schemaname='public' AND p.tablename=s.relname),false) AS has_tenant_policy
  FROM scoped s
)
SELECT relname AS unprotected_table, rls_enabled, rls_forced, policies,
  CASE
    WHEN NOT rls_enabled       THEN 'RLS IS OFF , every tenant reads every other tenant'
    WHEN NOT rls_forced        THEN 'NOT FORCED , the table owner ignores its own policy'
    WHEN NOT has_tenant_policy THEN 'NO TENANT POLICY , nothing scopes the rows'
  END AS what_is_wrong
FROM judged
WHERE NOT (rls_enabled AND rls_forced AND has_tenant_policy)
ORDER BY relname;

-- ---------------------------------------------------------------------
--  3. THE CONNECTION ITSELF. True on either flag means none of the
--     above is being enforced for this role regardless of section 1.
-- ---------------------------------------------------------------------
SELECT current_user, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = current_user;
