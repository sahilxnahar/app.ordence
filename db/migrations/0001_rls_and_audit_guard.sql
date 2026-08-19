-- ============================================================================
-- Ordence — Row-Level Security & Append-Only Audit Guard
-- Version: v0.1.0-alpha
--
-- Run this AFTER `npm run db:push` has created the tables.
--
-- WHAT THIS DOES
--   1. Defines a helper that reads the per-transaction tenant context.
--   2. Turns on RLS for every tenant-owned table and adds an isolation policy.
--   3. Makes `audit_logs` physically append-only via a trigger.
--
-- WHY IT MATTERS
--   Application-level `WHERE tenant_id = ...` is one layer. If a developer ever
--   forgets it, RLS still refuses to return another tenant's rows. Two
--   independent layers must both fail before data can leak.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. TENANT CONTEXT HELPER
-- ---------------------------------------------------------------------------
-- Reads the setting pinned by `withTenant()` in db/index.ts.
-- Returns NULL when unset, which makes every policy below evaluate to FALSE
-- (fail-closed: no context means no rows, never all rows).

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app_current_tenant_id() IS
  'Returns the tenant id pinned for the current transaction, or NULL if unset.';


-- ---------------------------------------------------------------------------
-- 2. ENABLE RLS + ISOLATION POLICIES
-- ---------------------------------------------------------------------------

-- ---- tenants -------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_self_isolation ON tenants;
CREATE POLICY tenant_self_isolation ON tenants
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

-- ---- users ---------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- roles ---------------------------------------------------------------
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS roles_tenant_isolation ON roles;
CREATE POLICY roles_tenant_isolation ON roles
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- role_permissions ----------------------------------------------------
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
CREATE POLICY role_permissions_tenant_isolation ON role_permissions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- user_roles ----------------------------------------------------------
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_roles_tenant_isolation ON user_roles;
CREATE POLICY user_roles_tenant_isolation ON user_roles
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- audit_logs ----------------------------------------------------------
-- Readable only within your own tenant; platform-level rows (tenant_id IS NULL)
-- are invisible to tenants entirely.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- NOTE: `permissions` is intentionally NOT under RLS. It is a global catalogue
-- of permission definitions containing no customer data.


-- ---------------------------------------------------------------------------
-- 3. APPEND-ONLY AUDIT TRAIL
-- ---------------------------------------------------------------------------
-- Blocks UPDATE and DELETE on audit_logs at the engine level. Even a compromised
-- application account cannot rewrite history.

CREATE OR REPLACE FUNCTION audit_logs_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();


-- ---------------------------------------------------------------------------
-- 4. AUTO-MAINTAIN updated_at
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_set_updated_at ON tenants;
CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS roles_set_updated_at ON roles;
CREATE TRIGGER roles_set_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------------
-- 5. VERIFICATION
-- ---------------------------------------------------------------------------
-- Run this to confirm RLS is live. Every row must show rowsecurity = true.
--
--   SELECT tablename, rowsecurity
--   FROM pg_tables
--   WHERE schemaname = 'public'
--     AND tablename IN ('tenants','users','roles','role_permissions',
--                       'user_roles','audit_logs')
--   ORDER BY tablename;
--
-- Isolation smoke test (should return 0 rows, not an error):
--   BEGIN;
--   SELECT set_config('app.current_tenant_id',
--                     '00000000-0000-4000-8000-000000000000', true);
--   SELECT count(*) FROM users;   -- expect 0
--   ROLLBACK;
-- ---------------------------------------------------------------------------
