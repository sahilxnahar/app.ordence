-- =====================================================================
--  Ordence · VERIFY 0079 · read-only, SAFE AGAINST NEON
-- =====================================================================
--  ⭐ SELECT statements only. Nothing is created, altered or written.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. THE SIX PLATFORM TABLES: both clauses must now say
--     `app_platform_scope()` on the WRITE side.
--
--     `opt_in_write` false means the table still accepts a write from
--     any connection that merely FORGOT to set a tenant.
-- ---------------------------------------------------------------------
SELECT tablename,
       policyname,
       (with_check LIKE '%app_platform_scope%')       AS opt_in_write,
       (with_check LIKE '%app_current_tenant_id() IS NULL%')
                                                      AS still_forgettable,
       qual                                           AS using_clause,
       with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN (
         'platform_staff',
         'platform_action_log',
         'platform_impersonation_sessions',
         'platform_tenant_flags',
         'tenant_health_events',
         'platform_entitlement_history'
       )
 ORDER BY tablename;


-- ---------------------------------------------------------------------
--  2. ⭐ THE CUSTOMER CAN STILL SEE ITSELF.
--
--     Only the write side changed. These two must keep their tenant
--     branch on USING, or a workspace loses the ability to read the
--     record of when support was inside it.
-- ---------------------------------------------------------------------
SELECT tablename,
       (qual LIKE '%tenant_id = app_current_tenant_id()%')
         AS customer_can_still_read_its_own
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('platform_impersonation_sessions', 'platform_tenant_flags');


-- ---------------------------------------------------------------------
--  3. THE THREE TELEMETRY TABLES: a platform branch on BOTH clauses.
--
--     `accepts_attributed_rows` false means every error, vital and
--     security event that names a workspace is still being discarded.
-- ---------------------------------------------------------------------
SELECT tablename,
       (with_check LIKE '%app_platform_scope%') AS accepts_attributed_rows,
       (qual       LIKE '%app_platform_scope%') AS platform_can_read
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('error_events', 'web_vital_events', 'security_events')
 ORDER BY tablename;


-- ---------------------------------------------------------------------
--  4. ⚠️ HOW MUCH WAS LOST, AND WHETHER IT HAS STOPPED.
--
--     Before 0079 these tables held anonymous pre-auth rows ONLY. If
--     `attributed` is zero and `anonymous` is not, the discard was
--     happening and this is the evidence. Run it again a day after
--     deploying: `attributed` should start climbing.
-- ---------------------------------------------------------------------
SELECT 'error_events' AS table_name,
       count(*) FILTER (WHERE tenant_id IS NOT NULL) AS attributed,
       count(*) FILTER (WHERE tenant_id IS NULL)     AS anonymous
  FROM error_events
UNION ALL
SELECT 'web_vital_events',
       count(*) FILTER (WHERE tenant_id IS NOT NULL),
       count(*) FILTER (WHERE tenant_id IS NULL)
  FROM web_vital_events
UNION ALL
SELECT 'security_events',
       count(*) FILTER (WHERE tenant_id IS NOT NULL),
       count(*) FILTER (WHERE tenant_id IS NULL)
  FROM security_events;


-- ---------------------------------------------------------------------
--  5. THE HOUSE RULE, EVERYWHERE ELSE.
--
--     `app_platform_scope()` belongs in USING and not in WITH CHECK,
--     because platform staff read across workspaces and never write
--     into one. `tenants` is the ONE deliberate exception, explained in
--     0079 section 3 and in the table comment.
--
--     ⚠️ THIS MATCHES BOTH SPELLINGS. Two function names exist for the
--     same setting — `app_platform_scope()` and `app_is_platform_scope()`
--     — and a checker that knew only one of them would have reported
--     this clean while a policy using the other spelling did whatever it
--     liked.
-- ---------------------------------------------------------------------
SELECT tablename,
       policyname,
       with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND with_check LIKE '%platform_scope%'
   AND tablename NOT IN (
         -- the deliberate exception
         'tenants',
         -- the six from section 1: platform-only tables, where a
         -- platform write is the ONLY kind of write there is
         'platform_staff',
         'platform_action_log',
         'platform_impersonation_sessions',
         'platform_tenant_flags',
         'tenant_health_events',
         'platform_entitlement_history',
         -- the three from section 2
         'error_events',
         'web_vital_events',
         'security_events'
       )
 ORDER BY tablename;
-- ⭐ ZERO ROWS IS THE PASS. Any row here is a tenant-scoped table that
--    the platform connection can write into, which is the failure this
--    rule exists to prevent.


-- ---------------------------------------------------------------------
--  6. AND THE THING THAT DECIDES WHETHER ANY OF THIS IS RUNNING.
-- ---------------------------------------------------------------------
SELECT current_user,
       rolsuper,
       rolbypassrls,
       CASE
         WHEN rolsuper OR rolbypassrls
           THEN '🔴 This connection BYPASSES row-level security. Every policy above is inert.'
         ELSE '✅ This connection is subject to row-level security.'
       END AS verdict
  FROM pg_roles
 WHERE rolname = current_user;
