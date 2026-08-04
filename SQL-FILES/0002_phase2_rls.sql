-- ============================================================================
-- Ordence — Phase 2 Row-Level Security
-- Version: v0.2.0-alpha
--
-- Run AFTER `npm run db:push` has created the Phase 2 tables.
--
-- ⚠️  CRITICAL: new tables are NOT automatically protected. Postgres creates
-- them with RLS disabled. Every table added in Phase 2 needs an explicit policy,
-- or it silently becomes a cross-tenant data leak the application layer alone
-- must catch. This file closes that gap.
-- ============================================================================

-- Depends on app_current_tenant_id(), created in 0001_rls_and_audit_guard.sql.
-- Re-declared here so this file is safe to run standalone.
CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ---------------------------------------------------------------------------
-- CRM ENTITIES
-- ---------------------------------------------------------------------------

-- ---- companies -----------------------------------------------------------
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS companies_tenant_isolation ON companies;
CREATE POLICY companies_tenant_isolation ON companies
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- contacts ------------------------------------------------------------
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contacts_tenant_isolation ON contacts;
CREATE POLICY contacts_tenant_isolation ON contacts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- deals ---------------------------------------------------------------
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deals_tenant_isolation ON deals;
CREATE POLICY deals_tenant_isolation ON deals
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ---------------------------------------------------------------------------
-- CUSTOM OBJECT ENGINE
-- ---------------------------------------------------------------------------

-- ---- custom_object_definitions -------------------------------------------
ALTER TABLE custom_object_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_object_definitions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cod_tenant_isolation ON custom_object_definitions;
CREATE POLICY cod_tenant_isolation ON custom_object_definitions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- custom_field_definitions --------------------------------------------
ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cfd_tenant_isolation ON custom_field_definitions;
CREATE POLICY cfd_tenant_isolation ON custom_field_definitions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- custom_object_records -----------------------------------------------
-- The highest-value target in the schema: this holds every tenant's dynamic
-- business data in one physical table.
ALTER TABLE custom_object_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_object_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cor_tenant_isolation ON custom_object_records;
CREATE POLICY cor_tenant_isolation ON custom_object_records
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ---------------------------------------------------------------------------
-- REFERENTIAL INTEGRITY ACROSS TENANTS
-- ---------------------------------------------------------------------------
-- A standard FK guarantees "this company exists" but NOT "this company belongs
-- to the same tenant". Without the checks below, a bug could attach a contact to
-- another tenant's company — a genuine cross-tenant reference.
--
-- These triggers make that impossible at the database level.

CREATE OR REPLACE FUNCTION assert_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ref_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'contacts' AND NEW.company_id IS NOT NULL THEN
    SELECT tenant_id INTO ref_tenant FROM companies WHERE id = NEW.company_id;
    IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant reference blocked: contact.company_id'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'deals' THEN
    IF NEW.company_id IS NOT NULL THEN
      SELECT tenant_id INTO ref_tenant FROM companies WHERE id = NEW.company_id;
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Cross-tenant reference blocked: deal.company_id'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
      SELECT tenant_id INTO ref_tenant FROM contacts WHERE id = NEW.contact_id;
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Cross-tenant reference blocked: deal.contact_id'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'custom_object_records' THEN
    SELECT tenant_id INTO ref_tenant
    FROM custom_object_definitions WHERE id = NEW.definition_id;
    IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant reference blocked: record.definition_id'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'custom_field_definitions' THEN
    SELECT tenant_id INTO ref_tenant
    FROM custom_object_definitions WHERE id = NEW.object_definition_id;
    IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant reference blocked: field.object_definition_id'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_same_tenant ON contacts;
CREATE TRIGGER contacts_same_tenant
  BEFORE INSERT OR UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION assert_same_tenant();

DROP TRIGGER IF EXISTS deals_same_tenant ON deals;
CREATE TRIGGER deals_same_tenant
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION assert_same_tenant();

DROP TRIGGER IF EXISTS cor_same_tenant ON custom_object_records;
CREATE TRIGGER cor_same_tenant
  BEFORE INSERT OR UPDATE ON custom_object_records
  FOR EACH ROW EXECUTE FUNCTION assert_same_tenant();

DROP TRIGGER IF EXISTS cfd_same_tenant ON custom_field_definitions;
CREATE TRIGGER cfd_same_tenant
  BEFORE INSERT OR UPDATE ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION assert_same_tenant();


-- ---------------------------------------------------------------------------
-- updated_at MAINTENANCE
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS companies_set_updated_at ON companies;
CREATE TRIGGER companies_set_updated_at
  BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS contacts_set_updated_at ON contacts;
CREATE TRIGGER contacts_set_updated_at
  BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS deals_set_updated_at ON deals;
CREATE TRIGGER deals_set_updated_at
  BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS cod_set_updated_at ON custom_object_definitions;
CREATE TRIGGER cod_set_updated_at
  BEFORE UPDATE ON custom_object_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS cfd_set_updated_at ON custom_field_definitions;
CREATE TRIGGER cfd_set_updated_at
  BEFORE UPDATE ON custom_field_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS cor_set_updated_at ON custom_object_records;
CREATE TRIGGER cor_set_updated_at
  BEFORE UPDATE ON custom_object_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------------
-- VERIFICATION — run this and confirm ALL rows show rowsecurity = true
-- ---------------------------------------------------------------------------
--
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public'
--     AND tablename IN ('tenants','users','roles','role_permissions','user_roles',
--                       'audit_logs','companies','contacts','deals',
--                       'custom_object_definitions','custom_field_definitions',
--                       'custom_object_records')
--   ORDER BY tablename;
--
-- Expect 12 rows, every one `true`.
--
-- Cross-tenant reference smoke test (must RAISE, not succeed):
--   INSERT INTO contacts (tenant_id, first_name, company_id)
--   VALUES ('<tenant-A-uuid>', 'Test', '<company-owned-by-tenant-B>');
--   -- expected: ERROR  Cross-tenant reference blocked: contact.company_id
-- ---------------------------------------------------------------------------
