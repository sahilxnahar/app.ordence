-- ============================================================================
-- Ordence — Phase 20: SecOps, SIEM Export & Rate Limiting
-- Version: v0.12.0-alpha
--
-- Run AFTER `npx drizzle-kit push` has created:
--   security_events   (db/schema/secops.ts)
--   and the two enums: security_event_type, security_severity
--
-- Contents:
--   1. Row-Level Security (with the NULL-tenant policy, as payment_events)
--   2. security_events is APPEND-ONLY
--   3. The tenant of an event is fixed for life
--   4. Retention — pruning belongs to a privileged role, not the app
--   5. Grants (REVOKE FIRST — see the warning in that section)
--   6. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- `security_events` is the table an intruder has the strongest possible
-- motive to alter. Every other evidence table in this platform records what
-- someone DID; this one records HOW THEY GOT IN. An attacker editing
-- `audit_logs` is hiding a business action. An attacker editing this table is
-- hiding themselves.
--
-- Three guarantees are therefore enforced by the DATABASE and not by the
-- application, because the application will be rewritten several times and
-- these must survive it:
--
--   • A tenant CANNOT read another tenant's security events, and CANNOT read
--     the unattributed perimeter events.                          (Section 1)
--   • An event, once written, CANNOT be altered or removed.       (Section 2)
--   • An event CANNOT be moved to another tenant.                 (Section 3)
--
-- ============================================================================
-- WHY THIS TABLE EXISTS ALONGSIDE audit_logs AND permission_denials
-- ============================================================================
-- The boundary is sharp and it is worth restating in the file that grants
-- privileges on all three:
--
--   audit_logs         — what an authenticated principal DID.
--   permission_denials — what a known principal was REFUSED.
--   security_events    — everything that is NOT a user action: rate-limit
--                        trips, forged webhook signatures, garbage portal
--                        tokens, and inferences drawn from patterns.
--
-- Nothing is written to two of the three. The split is not tidiness: a
-- scraper generates ten thousand rate-limit trips a minute, and putting those
-- in `audit_logs` would bury the twelve rows a year that say a human closed
-- an accounting period — inside the very table that has to be defensible in
-- a dispute.
-- ============================================================================


-- The tenant-context accessor. Idempotent; also created by earlier phases.
CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on for ordinary roles.
-- FORCE additionally applies them to the table OWNER, which is usually the
-- role the application connects as. Without FORCE the isolation is decorative.

ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- THE NULL-TENANT ALLOWANCE — THE SAME SHAPE AS payment_events, AND WHY
-- ---------------------------------------------------------------------------
-- Almost every tenant-scoped table in this platform has NOT NULL tenant_id
-- and a policy that is a plain equality. This is the second exception, after
-- `payment_events`, and the case for it is stronger.
--
-- The events most worth having arrive where NO TENANT IS KNOWN:
--
--   • A webhook whose HMAC failed. We never got far enough to map it, and we
--     must not parse an unverified payload in order to try.
--   • A portal token that does not exist. There is nothing to resolve.
--   • A sign-in attempt for an address that has no account.
--   • A rate-limit trip in middleware, before any session is loaded.
--
-- Dropping those would leave a security table that can only see attacks which
-- already got past authentication — blind to exactly the perimeter it exists
-- to watch. Substituting a placeholder tenant would be worse: a real
-- tenant_id meaning "unknown" corrupts every per-tenant count in the table.
--
-- So orphan events are stored with tenant_id IS NULL, and the policy permits
-- reading them ONLY when NO tenant context is set — i.e. from the
-- platform-scoped connection used by super-admin tooling and the SIEM
-- exporter.
--
--   tenant session (context = A)  ->  rows where tenant_id = A
--   platform scope (context NULL) ->  rows where tenant_id IS NULL
--
-- Note what this does NOT do: a tenant cannot see another tenant's events,
-- and a tenant cannot see the orphans. Verified in Section 6 and in
-- tests/security/secops-isolation.test.ts.
--
-- ⚠️ WITH CHECK IS NOT OPTIONAL. A policy with only USING filters READS. The
-- application could still INSERT a row stamped with another tenant's id —
-- which on THIS table means forging security history against a customer, or
-- hiding your own by filing it under someone else.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS security_events_tenant_isolation ON security_events;
CREATE POLICY security_events_tenant_isolation ON security_events
  USING (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  );


-- ############################################################################
-- SECTION 2 — security_events IS APPEND-ONLY
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   The concrete attack is the one this whole phase is about. An intruder who
--   obtains application-level database access has, in order: an interest in
--   deleting the `rate_limit.exceeded` rows that show them probing, the
--   `auth.login_failed` burst that shows them guessing, and the
--   `webhook.signature_invalid` rows that show them forging. Every one of
--   those is a DELETE on this table.
--
--   The mundane version is likelier and just as damaging: an engineer
--   clearing "noise" from a dashboard before a board review, and removing the
--   only evidence of a probe that was still in progress.
--
-- THE FIX:
--   UPDATE and DELETE are refused outright, exactly as for `audit_logs`
--   (Phase 1), `contract_signatures` (Phase 9) and `payment_events`
--   (Phase 11). There are no exceptions — not even for `exported_at`, which
--   would have been the one defensible carve-out. SIEM export tracks its
--   progress with an external high-water-mark cursor instead
--   (`lib/security/siem.ts`), because a trigger with one exception is a
--   trigger with an UPDATE path, and the next change reuses it.
--
--   SQLSTATE 42501 (insufficient_privilege) is raised deliberately so the
--   application can distinguish this from an ordinary constraint failure.
--
--   ⚠️ Note this makes the guard indistinguishable, BY SQLSTATE ALONE, from
--   a missing GRANT. The tests must therefore also assert the message is not
--   "permission denied for table" — see the `expectGuard` helper in
--   tests/security/secops-isolation.test.ts. A test whose role simply had no
--   privileges would otherwise pass while proving nothing.

CREATE OR REPLACE FUNCTION prevent_security_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'security_events is append-only. % is not permitted on security evidence. '
    'Record a new event instead; retention is handled by prune_security_events().',
    TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS security_events_no_update ON security_events;
CREATE TRIGGER security_events_no_update
  BEFORE UPDATE ON security_events
  FOR EACH ROW EXECUTE FUNCTION prevent_security_event_mutation();

-- The DELETE guard is created in SECTION 4, not here, because it is the one
-- with a sanctioned exception (retention pruning by a privileged role) and
-- keeping the two guards in one place would blur that. UPDATE has NO
-- exception and its trigger above is unconditional.


-- ############################################################################
-- SECTION 3 — AN EVENT'S TENANT IS FIXED FOR LIFE
-- ############################################################################
--
-- Belt and braces behind Section 2. If the append-only triggers were ever
-- dropped — by `drizzle-kit push`, by a migration tool, by someone debugging —
-- this would still refuse the single most damaging edit available: moving a
-- row between tenants, which both hides it from the tenant it concerns and
-- plants it in the history of one it does not.
--
-- It is a separate trigger rather than a clause inside the first because the
-- first is unconditional. This one has to survive the first being gone.

CREATE OR REPLACE FUNCTION prevent_security_event_tenant_move()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'A security event cannot be reassigned to a different tenant.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS security_events_tenant_fixed ON security_events;
CREATE TRIGGER security_events_tenant_fixed
  BEFORE UPDATE ON security_events
  FOR EACH ROW EXECUTE FUNCTION prevent_security_event_tenant_move();


-- ############################################################################
-- SECTION 4 — RETENTION
-- ############################################################################
--
-- Security telemetry is high-volume and low-value-per-row after a while. It
-- is NOT audit data: `audit_logs` is kept for years because it answers
-- questions from customers and regulators, while a rate-limit trip from
-- eighteen months ago answers nothing.
--
-- But deletion is exactly what an intruder wants, so it may not be something
-- the WEB APPLICATION can do. The pruning function is therefore
-- SECURITY DEFINER — it runs as its owner, bypassing the append-only trigger
-- via a session flag — and EXECUTE on it is granted to nobody by default.
-- A DBA or a maintenance role calls it deliberately.
--
--   Application role  -> INSERT and SELECT. No DELETE, ever.
--   Maintenance role  -> may call prune_security_events().
--
-- That is a real separation of duty: compromising the web application does
-- not give you the ability to erase the record of having compromised it.
--
-- ⚠️ CRITICAL EVENTS ARE NEVER PRUNED BY DEFAULT. A forged webhook signature
-- or a cross-tenant access attempt from two years ago is precisely the row
-- you want when a pattern finally becomes visible.

CREATE OR REPLACE FUNCTION prune_security_events(
  older_than_days integer DEFAULT 180,
  include_critical boolean DEFAULT false
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed bigint;
BEGIN
  IF older_than_days < 30 THEN
    RAISE EXCEPTION
      'Refusing to prune security events younger than 30 days (asked for %).',
      older_than_days
      USING ERRCODE = '22023';  -- invalid_parameter_value
  END IF;

  -- The append-only trigger fires for everyone, including this function's
  -- owner. The flag below is the ONE sanctioned way past it, and it is
  -- transaction-local so it cannot leak onto a pooled connection.
  PERFORM set_config('app.allow_security_event_prune', 'on', true);

  DELETE FROM security_events
  WHERE created_at < now() - make_interval(days => older_than_days)
    AND (include_critical OR severity <> 'critical');

  GET DIAGNOSTICS removed = ROW_COUNT;

  PERFORM set_config('app.allow_security_event_prune', 'off', true);

  RETURN removed;
END;
$$;

-- The DELETE trigger must honour that flag, so it is redefined here to check
-- it. Written as a SEPARATE function from the UPDATE guard: UPDATE has no
-- legitimate path at all and must stay unconditional.
CREATE OR REPLACE FUNCTION prevent_security_event_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.allow_security_event_prune', true) = 'on' THEN
    RETURN OLD;  -- prune_security_events() only. Nothing else sets this.
  END IF;

  RAISE EXCEPTION
    'security_events is append-only. DELETE is not permitted on security '
    'evidence. Retention is handled by prune_security_events(), which '
    'requires a privileged role.'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS security_events_no_delete ON security_events;
CREATE TRIGGER security_events_no_delete
  BEFORE DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION prevent_security_event_delete();

-- ⚠️ EXECUTE is revoked from PUBLIC. A SECURITY DEFINER function is granted
-- to PUBLIC by default, which would hand every role — including the web
-- application's — the ability to delete six months of security history.
-- That single line would undo this entire section.
REVOKE ALL ON FUNCTION prune_security_events(integer, boolean) FROM PUBLIC;


-- ############################################################################
-- SECTION 5 — GRANTS
-- ############################################################################
--
-- Replace `ordence_app` with the role your application actually connects as.
--
-- ---------------------------------------------------------------------------
-- ⚠️ REVOKE FIRST. THIS IS NOT DEFENSIVE PADDING.
-- ---------------------------------------------------------------------------
-- A GRANT block that only ever ADDS privileges is worthless as a restriction.
-- If anyone has ever run `GRANT ALL ON ALL TABLES IN SCHEMA public TO
-- ordence_app` — the first thing most people do when a query fails with
-- "permission denied", and something several hosting providers' setup guides
-- recommend outright — then the application role ALREADY HOLDS DELETE on
-- `security_events`, and every GRANT below is a no-op that changes nothing.
--
-- On this table that matters more than anywhere else in the platform: the
-- privilege being restricted is "erase the evidence of the intrusion". The
-- restriction is only real if it is stated as a restriction, so the table is
-- revoked to nothing first and then granted exactly what it needs.
--
-- This is the same lesson recorded in Section 6 of 0009_phase11_billing.sql,
-- which was found while building a fresh test database: the baseline blanket
-- grant had to be applied for the earlier phases' tests to run at all, which
-- is precisely the situation that silently defeats an additive-only block.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON security_events FROM ordence_app;

    -- INSERT and SELECT only. No UPDATE, no DELETE — belt and braces
    -- alongside the triggers in Sections 2–4. If those triggers were ever
    -- dropped, this still refuses.
    GRANT SELECT, INSERT ON security_events TO ordence_app;

    -- Explicitly NOT granted: EXECUTE on prune_security_events(). The web
    -- application must not be able to delete security history under any
    -- circumstances, including via a function that is allowed to.
  END IF;

  -- The maintenance role, if the deployment has one, is what may prune.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT EXECUTE ON FUNCTION prune_security_events(integer, boolean)
      TO ordence_maintenance;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 6 — VERIFICATION
-- ############################################################################
--
-- Every check below prints a row. Read them. A silent success is not the same
-- as a success, and these failures have no other symptom — a dropped policy
-- on this table produces no error, no slowdown and no log line. It produces a
-- table one tenant can read in full, discovered by someone else.

-- Check 1 — RLS is enabled AND forced.
SELECT
  c.relname                                        AS table_name,
  c.relrowsecurity                                 AS rls_enabled,
  c.relforcerowsecurity                            AS rls_forced,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS' ELSE '*** FAIL — isolation is decorative without FORCE ***'
  END                                              AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'security_events';


-- Check 2 — the policy carries a WITH CHECK clause.
--
-- A policy with only USING filters what you can READ but permits INSERTing a
-- row belonging to another tenant. On this table that is the ability to file
-- your own intrusion under someone else's name.
SELECT
  tablename,
  policyname,
  CASE WHEN with_check IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — reads filtered, writes are not ***' END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'security_events';


-- Check 3 — the append-only and tenant-fix triggers exist and are enabled.
SELECT
  tgname AS trigger_name,
  CASE WHEN tgenabled = 'O' THEN 'PASS (enabled)'
       -- `tgenabled` is PostgreSQL's internal "char" type, not text. Without
       -- the cast this line fails with `operator is not unique: unknown || "char"`.
       ELSE '*** FAIL — trigger is disabled: ' || tgenabled::text || ' ***' END AS verdict
FROM pg_trigger
WHERE tgrelid = 'security_events'::regclass
  AND NOT tgisinternal
ORDER BY tgname;


-- Check 4 — all three expected triggers are present, not merely some.
--
-- ⭐ Check 3 lists what exists; this one asserts nothing is MISSING. A
-- dropped trigger is invisible in a list of the remaining ones.
SELECT
  CASE WHEN (
    SELECT count(*) FROM pg_trigger
    WHERE tgrelid = 'security_events'::regclass
      AND NOT tgisinternal
      AND tgname IN ('security_events_no_update',
                     'security_events_no_delete',
                     'security_events_tenant_fixed')
  ) = 3 THEN 'PASS: security history cannot be edited, deleted or reassigned'
  ELSE '*** FAIL: an append-only trigger is MISSING — security evidence '
       'can be altered. Re-run this file. ***'
  END AS verdict;


-- Check 5 — the application role cannot UPDATE or DELETE.
--
-- ⭐ THIS IS THE MOST IMPORTANT ROW IN THIS FILE. It is the check that
-- catches a prior `GRANT ALL` having defeated Section 5.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN has_table_privilege('ordence_app', 'security_events', 'SELECT')
     AND has_table_privilege('ordence_app', 'security_events', 'INSERT')
     AND NOT has_table_privilege('ordence_app', 'security_events', 'UPDATE')
     AND NOT has_table_privilege('ordence_app', 'security_events', 'DELETE')
      THEN 'PASS: the app can record security events but never erase them'
    ELSE '*** FAIL: the application role can MODIFY security history — a '
         'prior GRANT ALL has defeated Section 5. Re-run it. ***'
  END AS verdict;


-- Check 6 — the application role cannot call the pruning function.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN has_function_privilege(
           'ordence_app', 'prune_security_events(integer, boolean)', 'EXECUTE')
      THEN '*** FAIL: the web application can delete security history via '
           'prune_security_events(). REVOKE it. ***'
    ELSE 'PASS: pruning requires a privileged role'
  END AS verdict;


-- Check 7 — the pruning function is SECURITY DEFINER with a pinned
-- search_path.
--
-- Without `SET search_path`, a SECURITY DEFINER function is a privilege
-- escalation: a caller who can create objects in a schema earlier on their
-- own search_path can shadow `security_events` and have the function's owner
-- execute against theirs instead.
SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = 'prune_security_events'
    ) THEN '*** FAIL: prune_security_events() is missing ***'
    WHEN (SELECT prosecdef FROM pg_proc WHERE proname = 'prune_security_events' LIMIT 1)
     AND (SELECT proconfig::text FROM pg_proc WHERE proname = 'prune_security_events' LIMIT 1)
         LIKE '%search_path%'
      THEN 'PASS: definer rights with a pinned search_path'
    ELSE '*** FAIL: prune_security_events() is not SECURITY DEFINER with a '
         'pinned search_path ***'
  END AS verdict;


-- Check 8 — no security event carries a tenant_id that no longer exists.
--
-- The FK is ON DELETE SET NULL by design (deleting a tenant must not erase
-- the record of attacks against them), so this should always be empty. It is
-- here because a dropped FK would be silent.
SELECT
  e.id,
  e.tenant_id,
  '*** FAIL — orphaned tenant reference ***' AS verdict
FROM security_events e
LEFT JOIN tenants t ON t.id = e.tenant_id
WHERE e.tenant_id IS NOT NULL AND t.id IS NULL;
-- (No rows returned = PASS.)


-- Check 9 — the event-type enum matches the TypeScript vocabulary.
--
-- `db/schema/secops.ts` derives the Postgres enum from SECURITY_EVENT_TYPES,
-- so drift is impossible via that path. This catches the OTHER path: someone
-- adding a value with `ALTER TYPE ... ADD VALUE` directly on the database.
-- An event type that exists in Postgres and not in the application is a value
-- nothing can ever query for.
SELECT
  count(*)                                    AS event_type_count,
  CASE WHEN count(*) = 18 THEN 'PASS: 18 event types, matching lib/security/events.ts'
       ELSE '*** FAIL: enum has ' || count(*)::text ||
            ' values; lib/security/events.ts declares 18. They have drifted. ***'
  END                                         AS verdict
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'security_event_type';


-- Check 10 — the indexes the anomaly detectors depend on exist.
--
-- Without them the detector's two-hour window scan becomes a sequential scan
-- of the largest table in the database, on a schedule. The symptom is not an
-- error; it is the detector timing out and quietly reporting nothing.
SELECT
  expected.name AS index_name,
  CASE WHEN i.indexname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — missing; the anomaly detector will scan sequentially ***'
  END AS verdict
FROM (VALUES
  ('security_events_tenant_created_idx'),
  ('security_events_severity_idx'),
  ('security_events_type_idx'),
  ('security_events_ip_prefix_idx'),
  ('security_events_created_idx')
) AS expected(name)
LEFT JOIN pg_indexes i
  ON i.indexname = expected.name AND i.tablename = 'security_events';
