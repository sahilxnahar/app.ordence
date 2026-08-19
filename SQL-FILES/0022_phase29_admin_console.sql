-- ============================================================================
-- Ordence — Phase 29: Finishing the Super Admin Console
-- Version: v0.29.0-alpha
--
-- Run AFTER `SQL-FILES/0014_phase17_platform.sql`. It depends on the tables,
-- policies, triggers and grants that file creates. Safe to re-run: every
-- statement is guarded, and nothing here drops or replaces anything from 0014.
--
-- Contents:
--   1. Indexes the console's new registers need
--   2. One integrity constraint 0014 left to the application
--   3. ⭐ RE-ASSERTED RESTRICTIONS — the two privileges that must stay absent
--   4. Verification (14 numbered checks; every one prints PASS or FAIL)
--
-- ============================================================================
-- ⚠️  WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ============================================================================
-- IT DOES NOT WIDEN `app_platform_scope()`. Not by one table.
--
-- Phase 29 added five panels to the tenant detail page — usage over time,
-- invoices, security events, consent history, and the platform's own trail
-- against that workspace. Three of those read tables that are NOT in the
-- platform read scope: `usage_counters`, `security_events` and `audit_logs`.
--
-- The obvious thing was to add the marker to their policies. It is refused,
-- and the reason is a difference in blast radius rather than taste:
--
--     WITH the marker      one query reads every customer's security events
--     WITHOUT the marker   the console opens ONE tenant context, for the one
--                          workspace whose id is in the URL and in the audit
--                          row, and reads exactly that customer's rows
--
-- Same feature. One of them can be turned into a cross-tenant export by a
-- missing WHERE clause; the other cannot, because the isolation is the
-- database's and not the query's. So `server/platform/insights.ts` reads
-- those three tables inside `withTenant()`, exactly as `readPreviousStatus()`
-- in `server/platform/tenants.ts` already reads `audit_logs`.
--
-- Check 12 below FAILS LOUDLY if any of the three ever acquires the marker,
-- and Check 11 keeps 0014's guarantee that customer CONTENT never does.
--
-- The narrowing of `withPlatformScope()` was itself the fix for an
-- over-broad earlier version. Widening it back, one convenient table at a
-- time, is how that fix gets undone without anybody deciding to undo it.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — INDEXES FOR THE NEW REGISTERS
-- ############################################################################
--
-- Three screens arrived in Phase 29 and each one has a default query that
-- runs on every page load. None of them is fast on a sequential scan once
-- the tables have a year of rows in them, and a support console that is slow
-- during an incident is a support console people abandon for a database
-- client — which is the exact behaviour this phase exists to remove.
--
-- All are `IF NOT EXISTS`, all are plain btrees, and none is unique: a
-- unique index here would be a constraint pretending to be a performance
-- change.

-- The action register, unfiltered, newest first — the default view.
CREATE INDEX IF NOT EXISTS platform_action_log_created_idx
  ON platform_action_log (created_at DESC);

-- "Show me everything critical this month."
CREATE INDEX IF NOT EXISTS platform_action_log_severity_created_idx
  ON platform_action_log (severity, created_at DESC);

-- The session register spans every tenant, so `impersonation_tenant_started_idx`
-- (tenant_id, started_at) does not serve it — that one is for a single
-- workspace's history.
CREATE INDEX IF NOT EXISTS impersonation_started_idx
  ON platform_impersonation_sessions (started_at DESC);

-- The tenant detail security panel filters on `occurred_at`, not `created_at`.
-- Those are different columns for a good reason — an event can be recorded
-- after it happened — and the existing (tenant_id, created_at) index does
-- not cover a range on the other one.
DO $$
BEGIN
  IF to_regclass('public.security_events') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS security_events_tenant_occurred_idx '
            'ON security_events (tenant_id, occurred_at DESC)';
  END IF;
END
$$;

-- ⭐ A PARTIAL INDEX FOR "WHAT HAS THE PLATFORM DONE TO US?"
--
-- The tenant's own audit log holds every action by everybody; the console
-- panel wants only the rows written by `recordPlatformAudit()`, which stamps
-- `metadata->>'source' = 'platform_console'`. A partial index keeps that
-- lookup cheap without adding a column, and — the part that matters — it
-- indexes only OUR rows, so it does not grow with the customer's own
-- activity.
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS audit_logs_platform_source_idx '
            'ON audit_logs (tenant_id, created_at DESC) '
            'WHERE metadata ->> ''source'' = ''platform_console''';
  END IF;
END
$$;


-- ############################################################################
-- SECTION 2 — ONE CONSTRAINT 0014 LEFT TO THE APPLICATION
-- ############################################################################
--
-- `platform_action_log.justification` is the entire value of a row six months
-- later. `withPlatformScope()` already refuses a reason under ten characters
-- and every console path writes one — but that is TypeScript, and this table
-- is the record of what our own staff did with cross-tenant access. The
-- version that is actually true belongs in the database, exactly as the
-- twenty-character floor on `platform_impersonation_sessions.justification`
-- already is (Section 7 of 0014).
--
-- ⚠️ ADDED ONLY IF NO EXISTING ROW WOULD VIOLATE IT. A constraint that fails
-- to apply on a live database leaves the deployment half-done and the error
-- scrolled off the top of a terminal. If rows violate it, this prints a
-- notice and Check 8 reports the state honestly rather than pretending.

DO $$
DECLARE
  offenders integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_action_justification_length') THEN
    RAISE NOTICE 'platform_action_justification_length already present — nothing to do.';
    RETURN;
  END IF;

  SELECT count(*) INTO offenders
    FROM platform_action_log
   WHERE length(btrim(justification)) < 10;

  IF offenders > 0 THEN
    RAISE NOTICE
      'SKIPPED platform_action_justification_length: % existing row(s) have a '
      'justification shorter than 10 characters. Investigate those rows — they '
      'were written by a path that did not go through the console.', offenders;
  ELSE
    ALTER TABLE platform_action_log
      ADD CONSTRAINT platform_action_justification_length
      CHECK (length(btrim(justification)) >= 10);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 3 — RE-ASSERTED RESTRICTIONS
-- ############################################################################
--
-- ⚠️ THIS SECTION EXISTS BECAUSE PRIVILEGES DRIFT BACK.
--
-- `drizzle-kit push`, a hurried `GRANT ALL ON ALL TABLES IN SCHEMA public TO
-- ordence_app` after a "permission denied" error, a restore from a dump taken
-- before 0014 — each of these silently regrants DELETE on the two tables
-- where a DELETE privilege is functionally an "erase the record of what I
-- did" privilege.
--
-- Re-asserting costs nothing and is idempotent. The triggers in Sections 2
-- and 3 of 0014 refuse the DELETE anyway; this is the second lock on the
-- same door, because a trigger dropped by a schema push is a silent failure
-- and these are the two tables where silent failure means an operator can
-- erase their own tracks.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE DELETE ON platform_impersonation_sessions FROM ordence_app;
    REVOKE DELETE ON platform_action_log             FROM ordence_app;

    -- Consent is written by the CUSTOMER and revoked by the CUSTOMER.
    -- Nothing deletes it: a consent row that can vanish cannot prove that
    -- permission was given, which is the only reason the table exists.
    REVOKE DELETE ON tenant_support_consents         FROM ordence_app;

    -- The console needs to read the register it renders. Asserted rather
    -- than assumed: a missing SELECT here shows up as an empty page, which
    -- looks exactly like "nothing happened".
    GRANT SELECT ON platform_action_log              TO ordence_app;
    GRANT SELECT ON platform_impersonation_sessions  TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 4 — VERIFICATION
-- ############################################################################
--
-- Every check prints a row. Read them. A silent success is not the same as a
-- success, and none of these failures has another symptom.

-- Check 1 — the Phase 29 indexes exist.
SELECT
  expected.idx AS index_name,
  CASE WHEN i.indexname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — missing; the console register will scan the table ***'
  END AS verdict
FROM (VALUES
  ('platform_action_log_created_idx'),
  ('platform_action_log_severity_created_idx'),
  ('impersonation_started_idx'),
  ('security_events_tenant_occurred_idx'),
  ('audit_logs_platform_source_idx')
) AS expected(idx)
LEFT JOIN pg_indexes i ON i.indexname = expected.idx AND i.schemaname = 'public'
ORDER BY expected.idx;


-- Check 2 — RLS is enabled AND forced on all five platform tables.
--
-- Re-checked here rather than assumed from 0014: `ALTER TABLE ... DISABLE ROW
-- LEVEL SECURITY` is one line, and nothing else would notice.
SELECT
  c.relname                                AS table_name,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS'
       ELSE '*** FAIL — RLS is not forced; the owner bypasses every policy ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('platform_staff','platform_impersonation_sessions',
                    'tenant_support_consents','platform_tenant_flags',
                    'platform_action_log')
ORDER BY c.relname;


-- Check 3 — ⭐ THE PLATFORM STILL CANNOT MANUFACTURE CONSENT.
--
-- The most important row in this file. The platform-scoped connection must
-- be able to READ consent and must NOT be able to WRITE it. If this reads
-- FAIL, "the customer agreed" becomes a claim we can write ourselves and
-- every impersonation in the system rests on nothing.
SELECT
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'tenant_support_consents'
        AND with_check LIKE '%app_current_tenant_id()%'
        AND with_check NOT LIKE '%IS NULL%'
        AND with_check NOT LIKE '%app_platform_scope%'
    )
    THEN 'PASS: consent can only be written by the customer''s own session'
    ELSE '*** FAIL: the platform connection can manufacture consent ***'
  END AS verdict;


-- Check 4 — the application role holds NO DELETE on the evidence tables.
SELECT
  t.tbl AS table_name,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN has_table_privilege('ordence_app', t.tbl, 'DELETE')
      THEN '*** FAIL: the application role can DELETE its own access evidence ***'
    ELSE 'PASS: evidence cannot be deleted by the application role'
  END AS verdict
FROM (VALUES
  ('platform_impersonation_sessions'),
  ('platform_action_log'),
  ('tenant_support_consents')
) AS t(tbl);


-- Check 5 — the console can READ what it renders.
--
-- The mirror of Check 4, and the failure it catches is the opposite one: a
-- REVOKE that went too far leaves the registers permanently empty, which is
-- indistinguishable from "nothing has happened yet".
SELECT
  t.tbl AS table_name,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN has_table_privilege('ordence_app', t.tbl, 'SELECT')
      THEN 'PASS: the console can read this register'
    ELSE '*** FAIL: the register will render empty, which reads as "nothing happened" ***'
  END AS verdict
FROM (VALUES
  ('platform_action_log'),
  ('platform_impersonation_sessions'),
  ('tenant_support_consents'),
  ('platform_tenant_flags')
) AS t(tbl);


-- Check 6 — the tamper triggers are present AND enabled on both evidence
-- tables. `tgenabled = 'O'` is "origin", i.e. on.
SELECT
  c.relname AS table_name,
  t.tgname  AS trigger_name,
  CASE WHEN t.tgenabled = 'O' THEN 'PASS (enabled)'
       ELSE '*** FAIL — trigger is disabled: ' || t.tgenabled::text || ' ***'
  END AS verdict
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
  AND c.relname IN ('platform_impersonation_sessions','platform_action_log')
ORDER BY c.relname, t.tgname;


-- Check 7 — the impersonation integrity constraints from 0014 are still there.
SELECT
  expected.conname,
  CASE WHEN c.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — constraint is missing; run 0014 ***' END AS verdict
FROM (VALUES
  ('impersonation_justification_length'),
  ('impersonation_max_duration'),
  ('breakglass_is_read_only'),
  ('consented_session_has_consent'),
  ('consent_expires_after_grant')
) AS expected(conname)
LEFT JOIN pg_constraint c ON c.conname = expected.conname
ORDER BY expected.conname;


-- Check 8 — the Phase 29 justification floor on the action register.
SELECT
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_action_justification_length')
      THEN 'PASS: a cross-tenant action cannot be logged without a written reason'
    WHEN EXISTS (SELECT 1 FROM platform_action_log
                  WHERE length(btrim(justification)) < 10)
      THEN '*** FAIL — not added: existing rows have reasons under 10 characters. '
           'Those rows were written by a path that bypassed the console. ***'
    ELSE '*** FAIL — constraint missing and no offending rows; Section 2 did not run ***'
  END AS verdict;


-- Check 9 — ⭐ NO BREAK-GLASS SESSION HAS EVER HELD WRITE ACCESS.
--
-- The CHECK makes it impossible going forward. This looks BACKWARDS, because
-- a constraint added after data existed would not have validated the rows
-- that were already there.
SELECT
  id, tenant_slug, actor_email, started_at,
  '*** FAIL — a break-glass session had write access ***' AS verdict
FROM platform_impersonation_sessions
WHERE mode = 'break_glass' AND scope <> 'read_only';
-- (No rows returned = PASS.)


-- Check 10 — ⭐ NO CONSENTED SESSION EXISTS WITHOUT A CONSENT ROW.
--
-- `consented_session_has_consent` requires a non-NULL `consent_id`, which is
-- necessary and not sufficient: it does not check that the consent row is
-- real, belongs to the SAME tenant, and had not been revoked before the
-- session started. This does. A session pointing at another workspace's
-- consent would be the single most damaging bug possible in this subsystem,
-- and it would be invisible to every constraint in 0014.
SELECT
  s.id, s.tenant_slug, s.actor_email, s.started_at,
  CASE
    WHEN c.id IS NULL
      THEN '*** FAIL — consented session references a consent row that does not exist ***'
    WHEN c.tenant_id <> s.tenant_id
      THEN '*** FAIL — session leans on ANOTHER WORKSPACE''S consent ***'
    WHEN c.revoked_at IS NOT NULL AND c.revoked_at <= s.started_at
      THEN '*** FAIL — consent had already been revoked when the session started ***'
    WHEN c.expires_at <= s.started_at
      THEN '*** FAIL — consent had already expired when the session started ***'
  END AS verdict
FROM platform_impersonation_sessions s
LEFT JOIN tenant_support_consents c ON c.id = s.consent_id
WHERE s.mode <> 'break_glass'
  AND (
       c.id IS NULL
    OR c.tenant_id <> s.tenant_id
    OR (c.revoked_at IS NOT NULL AND c.revoked_at <= s.started_at)
    OR c.expires_at <= s.started_at
  );
-- (No rows returned = PASS.)


-- Check 11 — ⭐⭐ THE DATA-PROTECTION LINE, RE-ASSERTED.
--
-- Customer CONTENT tables must carry NO platform clause. If one appears, a
-- platform operator can read a customer's contact list — a change to what
-- this product promises, not a bug fix. It belongs in a review.
SELECT
  p.tablename,
  CASE WHEN p.qual LIKE '%app_platform_scope%'
       THEN '*** FAIL — platform staff can now read CUSTOMER CONTENT here ***'
       ELSE 'PASS: customer content is unreachable from the platform scope'
  END AS verdict
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.tablename IN ('contacts','companies','deals','custom_object_records',
                      'assets','contracts','contract_versions',
                      'journal_entries','transactions','ledgers')
ORDER BY p.tablename;


-- Check 12 — ⭐ PHASE 29 DID NOT WIDEN THE PLATFORM SCOPE.
--
-- The three tables the new console panels read in the CUSTOMER'S OWN context
-- must not have acquired the marker as a shortcut. If they ever do, one
-- query reads every customer's usage, security events and audit trail at
-- once — see the header of this file for why that trade was refused.
SELECT
  p.tablename,
  CASE WHEN p.qual LIKE '%app_platform_scope%'
       THEN '*** FAIL — Phase 29 panels must read these per-tenant, not across tenants ***'
       ELSE 'PASS: read only inside a single tenant context'
  END AS verdict
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.tablename IN ('usage_counters','usage_levels','security_events','audit_logs')
ORDER BY p.tablename;


-- Check 13 — the relationship tables ARE readable from the console and are
-- NOT writable from it. Without this the directory renders an empty page;
-- with the write clause, a support engineer could edit a customer's user
-- roles or subscription.
SELECT
  p.tablename,
  CASE
    WHEN p.qual NOT LIKE '%app_platform_scope%'
      THEN '*** FAIL — the console cannot read this; it will show an empty page ***'
    WHEN p.tablename <> 'tenants' AND p.with_check LIKE '%app_platform_scope%'
      THEN '*** FAIL — the console can WRITE this table ***'
    ELSE 'PASS'
  END AS verdict
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.tablename IN ('tenants','users','subscriptions','invoices','documents')
ORDER BY p.tablename;


-- Check 14 — the platform scope is INERT in a fresh session.
--
-- If this ever reads FAIL, some connection starts with the marker already
-- set, and "no context means zero rows" has become "no context means every
-- customer".
SELECT
  CASE WHEN app_platform_scope() = false
       THEN 'PASS: platform scope is off by default (fail-closed)'
       ELSE '*** FAIL: platform scope is ON in a fresh session ***'
  END AS verdict;
