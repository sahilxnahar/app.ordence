-- =====================================================================
--  🔴🔴🔴 DRILL — DO NOT RUN THIS IN NEON 🔴🔴🔴
-- =====================================================================
--
--  It creates roles, tables and rows, and it deliberately provokes
--  permission failures. Throwaway Postgres only.
--
--  ⚠️ RUN IT AS A NON-SUPERUSER. A superuser bypasses row-level
--  security regardless of FORCE, so every refusal below would pass for
--  the wrong reason. Step 0 checks and stops.
--
--     createdb drill0079
--     psql -d drill0079 -f DRILL-DO-NOT-RUN-IN-NEON-0079.sql   (as owner)
--     then reconnect as app_user and run the ASSERTIONS section.
--
--  ⭐ EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL WORK. A
--  drill that only shows things being refused cannot tell "correctly
--  locked down" from "broken", and this migration's whole risk is that
--  it tightens onto a write somebody still needs.
-- =====================================================================


-- =====================================================================
--  STEP 0 — REFUSE TO RUN SOMEWHERE THAT MATTERS
-- =====================================================================
DO $$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production')
  THEN
    RAISE EXCEPTION
      '🔴 REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;
END
$$;


-- =====================================================================
--  STEP 1 — THE SHAPES, REPRODUCED FROM THE MIGRATIONS
-- =====================================================================

CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid;
$fn$;

CREATE OR REPLACE FUNCTION app_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on';
$fn$;

DROP TABLE IF EXISTS platform_action_log, error_events, tenants CASCADE;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE platform_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  justification text NOT NULL
);

CREATE TABLE error_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  message text NOT NULL
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'platform_action_log', 'error_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- The deliberate exception, unchanged by 0079.
CREATE POLICY tenant_self_isolation ON tenants
  USING      (id = app_current_tenant_id() OR app_platform_scope())
  WITH CHECK (id = app_current_tenant_id() OR app_platform_scope());

-- ⭐ AFTER 0079.
CREATE POLICY platform_action_log_platform_only ON platform_action_log
  USING      (app_current_tenant_id() IS NULL)
  WITH CHECK (app_platform_scope());

CREATE POLICY error_events_tenant_isolation ON error_events
  USING (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
    OR app_platform_scope()
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
    OR app_platform_scope()
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'drillpw' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE ON tenants, error_events TO app_user;
GRANT SELECT, INSERT ON platform_action_log TO app_user;
ALTER TABLE tenants             OWNER TO app_user;
ALTER TABLE platform_action_log OWNER TO app_user;
ALTER TABLE error_events        OWNER TO app_user;
ALTER FUNCTION app_current_tenant_id() OWNER TO app_user;
ALTER FUNCTION app_platform_scope()    OWNER TO app_user;


-- =====================================================================
--  ASSERTIONS — RECONNECT AS app_user BEFORE RUNNING THESE
--     psql "postgres://app_user:drillpw@127.0.0.1:5432/drill0079"
-- =====================================================================

DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      '🔴 REFUSING: % bypasses RLS, so every refusal below would pass for the wrong reason.',
      current_user;
  END IF;
END
$$;

\set ON_ERROR_STOP off

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 1 — the platform action log still records, under scope.
--     🔴 If this fails, the append-only record of what staff did has
--     stopped, and that is a reason to roll the CODE forward rather
--     than revert this migration.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.platform_scope', 'on', true);
  INSERT INTO platform_action_log (justification) VALUES ('a written reason');
COMMIT;
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 1 — the thing 0079 exists to stop. A connection that
--     merely FORGOT to set anything used to satisfy the old
--     `app_current_tenant_id() IS NULL` and write here.
-- ---------------------------------------------------------------------
INSERT INTO platform_action_log (justification) VALUES ('forgot to scope');
-- EXPECT: ERROR 42501 new row violates row-level security policy

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 2 — and a tenant session still cannot forge one.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO platform_action_log (justification) VALUES ('forged from a tenant');
ROLLBACK;
-- EXPECT: ERROR 42501

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 2 — an ATTRIBUTED telemetry row, written under platform
--     scope, is now kept. Before 0079 this raised 42501 and the caller
--     swallowed it, so the table held anonymous rows only.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.platform_scope', 'on', true);
  INSERT INTO error_events (tenant_id, message)
  VALUES ('11111111-1111-1111-1111-111111111111', 'a real error from a signed-in user');
COMMIT;
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 3 — an anonymous pre-auth row still works, which is what
--     the unauthenticated beacon endpoint writes.
-- ---------------------------------------------------------------------
INSERT INTO error_events (tenant_id, message) VALUES (NULL, 'anonymous, pre-auth');
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 4 — and a tenant may still write its own.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO error_events (tenant_id, message)
  VALUES ('11111111-1111-1111-1111-111111111111', 'written by the tenant itself');
COMMIT;
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 3 — tenant A still cannot write a row about tenant B.
--     ⚠️ THE ONE THAT MATTERS. Section 2 widens these policies, and a
--     widening that also opened cross-tenant writes would be a far worse
--     bug than the one it fixes.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO error_events (tenant_id, message)
  VALUES ('22222222-2222-2222-2222-222222222222', 'about somebody else');
ROLLBACK;
-- EXPECT: ERROR 42501

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 4 — and tenant A still cannot READ tenant B's rows.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.current_tenant_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT count(*) AS should_be_zero FROM error_events
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
COMMIT;
-- EXPECT: 0

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 5 — the platform CAN read across workspaces, which is
--     what the observability screens are for.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.platform_scope', 'on', true);
  SELECT count(*) AS should_be_three_or_more FROM error_events;
COMMIT;

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 6 — `tenants` is UNCHANGED by 0079. Provisioning, the
--     Clerk mirror, plan configuration and suspension all still work.
--     🔴 This is the assertion that would have caught the narrowing the
--     plan proposed and this migration declined to make.
-- ---------------------------------------------------------------------
BEGIN;
  SELECT set_config('app.platform_scope', 'on', true);
  INSERT INTO tenants (name) VALUES ('provisioned from the console');
  UPDATE tenants SET status = 'suspended' WHERE name = 'provisioned from the console';
  UPDATE tenants SET name   = 'renamed by the Clerk mirror'
   WHERE name = 'provisioned from the console';
COMMIT;
-- EXPECT: INSERT 0 1, UPDATE 1, UPDATE 1

\set ON_ERROR_STOP on

-- =====================================================================
--  SUMMARY OF WHAT MUST HAVE HAPPENED
-- =====================================================================
--    6 positives succeeded
--    4 refusals raised 42501 (or returned zero rows)
--
--  ⚠️ IF A REFUSAL SUCCEEDED, STOP. The most likely cause is that you
--  are connected as a role that bypasses RLS, which step 0 of the
--  assertions was supposed to catch.
-- =====================================================================
