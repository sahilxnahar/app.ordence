-- =====================================================================
--  Ordence · 0079 · RLS opt-in markers, and the telemetry rows that
--                   were being silently thrown away
--  Version: v1.36.0-alpha
-- =====================================================================
--
--  🔴 RUN THIS AFTER PUSHING THE CODE, NOT BEFORE.
--
--  Nothing here depends on new code, but the reverse is not true: the
--  policies below get STRICTER, and they are only satisfiable because
--  v1.34.0 and v1.35.0 moved every statement in the product inside a
--  scope. On an older build these tighten onto writes that no longer
--  qualify, and the platform action log stops recording.
--
--  ⚠️ SAFE TO RUN TWICE. Every statement is DROP ... IF EXISTS followed
--  by CREATE, inside one transaction.
--
-- =====================================================================
--  WHAT THIS FILE IS, IN ONE PARAGRAPH
-- =====================================================================
--
--  Six platform tables say "only a session with NO tenant may write
--  here". That is satisfied by FORGETTING to set something, which is
--  precisely the failure mode `app_platform_scope()` was introduced to
--  eliminate — the marker is an OPT IN, and absence of a tenant is not.
--  They become `app_platform_scope()`.
--
--  Three telemetry tables say "the row's tenant must equal the session's
--  tenant, or both must be null". They are written from a platform-
--  scoped connection with a REAL tenant id on the row, so neither branch
--  holds and every attributed row is rejected — silently, because the
--  callers swallow 42501 by design. They gain a platform branch.
--
-- =====================================================================
--  ⭐ AND WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  🔴 IT DOES NOT NARROW THE `tenants` POLICY, WHICH THE PLAN SAID IT
--     WOULD.
--
--  `SQL-FILES/0014_phase17_platform.sql` puts `app_platform_scope()` in
--  the WITH CHECK on `tenants`, which is the one place in 78 migrations
--  that breaks the house rule "platform reads across tenants, never
--  writes". The audit called it the single house-rule violation and
--  proposed replacing it with a `SECURITY DEFINER` function for status
--  changes.
--
--  ⚠️ THEN I COUNTED WHAT ACTUALLY WRITES THE TABLE. Thirteen call
--  sites, and four of them are platform-scoped by necessity:
--
--     app/api/webhooks/clerk/route.ts   INSERT a workspace, mirror its
--                                       name and slug from Clerk, mark
--                                       it deleted
--     server/platform/provisioning.ts   create a workspace from the
--                                       console
--     server/platform/configuration.ts  plan tier, limits, industry
--     server/platform/tenants.ts        suspend and reactivate
--
--  Narrowing the WITH CHECK breaks provisioning, the Clerk mirror, plan
--  configuration and suspension, and would need a `SECURITY DEFINER`
--  function per operation to put them back — four functions that each
--  bypass RLS, to replace one policy that grants exactly what those four
--  functions would.
--
--  ⭐ THE POLICY IS RIGHT AND THE COMMENT ABOVE IT IS WRONG. It claims
--  the console "may write exactly one thing that matters: `status`".
--  The console legitimately configures workspaces, and the control on
--  that is `requireCapability`, the approval queue and the audit row —
--  not row-level security, which cannot tell a suspension from a plan
--  change. The comment is corrected below rather than the policy.
--
-- =====================================================================

BEGIN;

-- =====================================================================
--  SECTION 1 — THE OPT-IN MARKER, ON SIX PLATFORM TABLES
-- =====================================================================
--
--  BEFORE:  WITH CHECK (app_current_tenant_id() IS NULL)
--  AFTER:   WITH CHECK (app_platform_scope())
--
--  🔴 THE DIFFERENCE IS THE DIFFERENCE BETWEEN "I MEANT TO" AND "I
--     FORGOT".
--
--  `app_current_tenant_id() IS NULL` is true for the plain HTTP client,
--  for a background job that never set anything, for a script, and for
--  any future code path that simply does not know it was supposed to
--  set a variable. `app_platform_scope()` is true only inside
--  `withPlatformScope()`, which requires a written justification of at
--  least ten characters and logs it.
--
--  ⚠️ THIS ONLY BECAME SAFE IN v1.35.0. Before that, `recordPlatformAudit`
--  wrote `platform_action_log` on the unscoped client, so this change
--  would have silently stopped the append-only record of what staff did.
--  It is now written inside `withPlatformScope`, and there is a gate
--  that fails if that regresses.
--
--  ⭐ USING IS UNTOUCHED. `platform_impersonation_sessions` and
--  `platform_tenant_flags` deliberately let a CUSTOMER read the rows
--  about their own workspace, which is the most persuasive answer to
--  the question every enterprise security review asks. Only the write
--  side changes.

DROP POLICY IF EXISTS platform_staff_platform_only ON platform_staff;
CREATE POLICY platform_staff_platform_only ON platform_staff
  USING      (app_current_tenant_id() IS NULL)
  WITH CHECK (app_platform_scope());

DROP POLICY IF EXISTS platform_action_log_platform_only ON platform_action_log;
CREATE POLICY platform_action_log_platform_only ON platform_action_log
  USING      (app_current_tenant_id() IS NULL)
  WITH CHECK (app_platform_scope());

DROP POLICY IF EXISTS impersonation_sessions_visibility ON platform_impersonation_sessions;
CREATE POLICY impersonation_sessions_visibility ON platform_impersonation_sessions
  USING (
    app_current_tenant_id() IS NULL
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (app_platform_scope());

DROP POLICY IF EXISTS platform_tenant_flags_visibility ON platform_tenant_flags;
CREATE POLICY platform_tenant_flags_visibility ON platform_tenant_flags
  USING (
    app_current_tenant_id() IS NULL
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (app_platform_scope());

-- ---- the two from 0074 ---------------------------------------------
--
-- ⚠️ These already had `app_platform_scope()` on USING and the weaker
-- marker on WITH CHECK, which is the inconsistency that makes the
-- pattern hard to see. Both clauses now say the same thing.

DO $$
BEGIN
  IF to_regclass('public.tenant_health_events') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_health_events_platform_only ON tenant_health_events;
    CREATE POLICY tenant_health_events_platform_only ON tenant_health_events
      USING      (app_platform_scope())
      WITH CHECK (app_platform_scope());
  END IF;

  IF to_regclass('public.platform_entitlement_history') IS NOT NULL THEN
    DROP POLICY IF EXISTS platform_entitlement_history_platform_only ON platform_entitlement_history;
    CREATE POLICY platform_entitlement_history_platform_only ON platform_entitlement_history
      USING      (app_platform_scope())
      WITH CHECK (app_platform_scope());
  END IF;
END
$$;

-- =====================================================================
--  SECTION 2 — THE TELEMETRY ROWS NOBODY WAS KEEPING
-- =====================================================================
--
--  🔴 `error_events`, `web_vital_events` AND `security_events` HAVE BEEN
--     DISCARDING EVERY ROW THAT NAMES A TENANT.
--
--  The policy admits two cases: the row's tenant equals the session's
--  tenant, or BOTH are null. The writers — `app/api/telemetry/route.ts`,
--  `lib/telemetry/report.ts`, `server/security/record.ts` — run under
--  `withPlatformScope`, where the session tenant is null, and set a REAL
--  tenant id on the row when the caller is signed in.
--
--  Null session tenant + non-null row tenant satisfies neither branch,
--  so Postgres raises 42501, and all three call sites catch it and move
--  on, by design, because telemetry must never break the request it is
--  describing.
--
--  ⚠️ SO THOSE TABLES CONTAIN ANONYMOUS PRE-AUTH ROWS AND NOTHING ELSE.
--  Every error from a signed-in user, every web vital from a real
--  session, and every security event attributed to a workspace has been
--  dropped on the floor. This is character for character the defect
--  already found and fixed on `audit_logs`, left standing here.
--
--  ⭐ THE PLATFORM BRANCH IS THE HONEST FIX, not a tenant scope. These
--  rows are the PLATFORM'S observations ABOUT a workspace: an error the
--  server saw, a vital the browser reported, a security event the
--  perimeter noticed. The workspace is the subject, not the author. A
--  tenant session may still write its own, which is what keeps a
--  tenant-scoped caller working.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['error_events', 'web_vital_events', 'security_events']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I '
        'USING ('
        '  (tenant_id = app_current_tenant_id()) '
        '  OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL) '
        '  OR app_platform_scope()'
        ') '
        'WITH CHECK ('
        '  (tenant_id = app_current_tenant_id()) '
        '  OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL) '
        '  OR app_platform_scope()'
        ')',
        t || '_tenant_isolation', t);
    END IF;
  END LOOP;
END
$$;

-- =====================================================================
--  SECTION 3 — THE COMMENT THAT WAS WRONG
-- =====================================================================
--
--  The `tenants` policy is unchanged and correct. What was wrong is the
--  sentence above it in 0014, which a reader would take as a guarantee.
--  Recorded here because a migration is the only place a future reader
--  reliably looks for why a policy is the shape it is.

COMMENT ON TABLE tenants IS
  'The platform connection may READ and WRITE any row, by design: '
  'provisioning creates workspaces, the Clerk webhook mirrors name and '
  'slug, the console sets plan tier and limits, and suspension flips '
  'status. 0014 claimed the console "may write exactly one thing that '
  'matters: status" and that was never true. The control on platform '
  'writes here is requireCapability, the approval queue and the audit '
  'row, not row-level security, which cannot tell a suspension from a '
  'plan change.';

COMMIT;

-- =====================================================================
--  ⚠️ WHAT TO CHECK AFTER RUNNING THIS
-- =====================================================================
--
--  VERIFY-0079-neon-safe.sql        read-only, safe against Neon
--  DRILL-DO-NOT-RUN-IN-NEON-0079.sql  paired positives and refusals,
--                                     throwaway Postgres only
--
--  🔴 IF THE PLATFORM CONSOLE STOPS RECORDING AUDIT ROWS AFTER THIS,
--  the cause is a build older than v1.35.0. Roll the code forward rather
--  than reverting this file: the previous policy accepted those writes
--  because it accepted ANY connection that had forgotten to set a
--  tenant, which is the thing being fixed.
