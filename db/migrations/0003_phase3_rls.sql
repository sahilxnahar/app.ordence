-- ============================================================================
-- Ordence — Phase 3 Row-Level Security
-- Version: v0.3.0-alpha
--
-- Run AFTER `npx drizzle-kit push` has created the Phase 3 tables.
--
-- ⚠️  Same rule as Phase 2: new tables arrive with RLS OFF. The two asset tables
-- hold the highest-value data in the system — an entire development portfolio,
-- its cost structure and its contractor commercials. They need policies before
-- any real data lands.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

-- ---- assets --------------------------------------------------------------
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assets_tenant_isolation ON assets;
CREATE POLICY assets_tenant_isolation ON assets
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- asset_relationships -------------------------------------------------
ALTER TABLE asset_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_relationships FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asset_rel_tenant_isolation ON asset_relationships;
CREATE POLICY asset_rel_tenant_isolation ON asset_relationships
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ---------------------------------------------------------------------------
-- CROSS-TENANT GRAPH PROTECTION
-- ---------------------------------------------------------------------------
-- An edge joins two assets. Without this, a bug could link YOUR building to
-- ANOTHER tenant's unit — the edge itself would pass RLS (its own tenant_id is
-- correct) while quietly bridging two tenants. This closes that hole.

CREATE OR REPLACE FUNCTION assert_asset_edge_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_tenant uuid;
  child_tenant  uuid;
BEGIN
  SELECT tenant_id INTO parent_tenant FROM assets WHERE id = NEW.parent_asset_id;
  SELECT tenant_id INTO child_tenant  FROM assets WHERE id = NEW.child_asset_id;

  IF parent_tenant IS DISTINCT FROM NEW.tenant_id
     OR child_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Cross-tenant asset relationship blocked'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A self-referencing edge would create an infinite loop in tree traversal.
  IF NEW.parent_asset_id = NEW.child_asset_id THEN
    RAISE EXCEPTION 'An asset cannot contain itself'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS asset_rel_same_tenant ON asset_relationships;
CREATE TRIGGER asset_rel_same_tenant
  BEFORE INSERT OR UPDATE ON asset_relationships
  FOR EACH ROW EXECUTE FUNCTION assert_asset_edge_same_tenant();

-- Assets referencing CRM entities must stay within the tenant too.
CREATE OR REPLACE FUNCTION assert_asset_refs_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ref_tenant uuid;
BEGIN
  IF NEW.owner_company_id IS NOT NULL THEN
    SELECT tenant_id INTO ref_tenant FROM companies WHERE id = NEW.owner_company_id;
    IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant reference blocked: asset.owner_company_id'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF NEW.primary_contact_id IS NOT NULL THEN
    SELECT tenant_id INTO ref_tenant FROM contacts WHERE id = NEW.primary_contact_id;
    IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant reference blocked: asset.primary_contact_id'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF NEW.linked_deal_id IS NOT NULL THEN
    SELECT tenant_id INTO ref_tenant FROM deals WHERE id = NEW.linked_deal_id;
    IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant reference blocked: asset.linked_deal_id'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assets_refs_same_tenant ON assets;
CREATE TRIGGER assets_refs_same_tenant
  BEFORE INSERT OR UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION assert_asset_refs_same_tenant();

-- ---- updated_at ----------------------------------------------------------
DROP TRIGGER IF EXISTS assets_set_updated_at ON assets;
CREATE TRIGGER assets_set_updated_at
  BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------------
-- VERIFICATION — expect 14 rows, all true
-- ---------------------------------------------------------------------------
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public'
--     AND tablename IN ('tenants','users','roles','role_permissions','user_roles',
--                       'audit_logs','companies','contacts','deals',
--                       'custom_object_definitions','custom_field_definitions',
--                       'custom_object_records','assets','asset_relationships')
--   ORDER BY tablename;
--
-- Graph smoke test (must RAISE):
--   INSERT INTO asset_relationships (tenant_id, parent_asset_id, child_asset_id)
--   VALUES ('<tenant-A>', '<asset-owned-by-A>', '<asset-owned-by-B>');
--   -- expected: ERROR  Cross-tenant asset relationship blocked
-- ---------------------------------------------------------------------------
