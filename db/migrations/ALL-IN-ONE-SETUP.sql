-- ============================================================================
-- ============================================================================
--
--   ORDENCE — COMPLETE DATABASE SETUP
--   Version: v0.5.0-alpha
--
--   ⭐ THIS IS THE ONLY SQL FILE YOU NEED TO RUN. ⭐
--
--   It combines every migration from Phase 1 through Phase 4:
--     · 0001  Row-Level Security + append-only audit        (Phase 1)
--     · 0002  CRM tables + cross-tenant reference guards     (Phase 2)
--     · 0003  Asset tables + graph integrity                 (Phase 3)
--     · 0004  CLM + double-entry accounting                  (Phase 4)
--     · 0005  Period close + RBAC + audit controls            (Phase 5)
--
--   ────────────────────────────────────────────────────────────────────────
--   HOW TO USE
--   ────────────────────────────────────────────────────────────────────────
--     1. First run `npx drizzle-kit push` in your terminal.
--        That creates the TABLES.
--     2. Then paste this whole file into Neon's SQL Editor and click Run.
--        That switches on the SECURITY.
--
--     Order matters. Tables must exist before policies can be attached to them.
--
--   ────────────────────────────────────────────────────────────────────────
--   IS IT SAFE TO RUN TWICE?
--   ────────────────────────────────────────────────────────────────────────
--     Yes. Every statement uses CREATE OR REPLACE or DROP IF EXISTS.
--     Running it again simply reapplies the same rules. It never deletes data.
--
--   ────────────────────────────────────────────────────────────────────────
--   WHAT THIS ACTUALLY DOES, IN PLAIN ENGLISH
--   ────────────────────────────────────────────────────────────────────────
--     Your application code already filters data by customer. This file makes
--     the DATABASE ITSELF refuse to hand over one customer's data to another —
--     even if the application has a bug, even if someone runs raw SQL.
--
--     It also makes your audit log and your financial ledger impossible to
--     edit after the fact, and makes unbalanced accounting entries impossible
--     to save at all.
--
-- ============================================================================
-- ============================================================================


-- ############################################################################
-- SECTION 1 — TENANT CONTEXT
-- ############################################################################
-- Everything below depends on this one function. It reads the "which customer
-- am I?" value that the application sets at the start of every database
-- transaction. If it is unset, it returns NULL — and every policy below then
-- matches NOTHING. That is deliberate: no context means no data, never all data.

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app_current_tenant_id() IS
  'Returns the tenant id pinned for the current transaction, or NULL if unset.';


-- ############################################################################
-- SECTION 2 — SHARED TRIGGER FUNCTIONS
-- ############################################################################

-- Keeps `updated_at` accurate without the application having to remember.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Blocks UPDATE and DELETE on append-only tables.
CREATE OR REPLACE FUNCTION block_mutation_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;


-- ############################################################################
-- SECTION 3 — ROW-LEVEL SECURITY ON EVERY TENANT TABLE
-- ############################################################################
-- ENABLE turns RLS on. FORCE makes it apply even to the table's owner —
-- without FORCE, the role your app connects as would bypass its own policies.

-- ---------------------------------------------------------------- Phase 1 ---
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self_isolation ON tenants;
CREATE POLICY tenant_self_isolation ON tenants
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roles_tenant_isolation ON roles;
CREATE POLICY roles_tenant_isolation ON roles
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
CREATE POLICY role_permissions_tenant_isolation ON role_permissions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_roles_tenant_isolation ON user_roles;
CREATE POLICY user_roles_tenant_isolation ON user_roles
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- NOTE: `permissions` is intentionally NOT protected. It is a global catalogue
-- of permission definitions and contains no customer data.

-- ---------------------------------------------------------------- Phase 2 ---
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companies_tenant_isolation ON companies;
CREATE POLICY companies_tenant_isolation ON companies
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contacts_tenant_isolation ON contacts;
CREATE POLICY contacts_tenant_isolation ON contacts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deals_tenant_isolation ON deals;
CREATE POLICY deals_tenant_isolation ON deals
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE custom_object_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_object_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cod_tenant_isolation ON custom_object_definitions;
CREATE POLICY cod_tenant_isolation ON custom_object_definitions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cfd_tenant_isolation ON custom_field_definitions;
CREATE POLICY cfd_tenant_isolation ON custom_field_definitions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE custom_object_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_object_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cor_tenant_isolation ON custom_object_records;
CREATE POLICY cor_tenant_isolation ON custom_object_records
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------- Phase 3 ---
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assets_tenant_isolation ON assets;
CREATE POLICY assets_tenant_isolation ON assets
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE asset_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_relationships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_rel_tenant_isolation ON asset_relationships;
CREATE POLICY asset_rel_tenant_isolation ON asset_relationships
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------- Phase 4 ---
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contracts_tenant_isolation ON contracts;
CREATE POLICY contracts_tenant_isolation ON contracts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE contract_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_versions_tenant_isolation ON contract_versions;
CREATE POLICY contract_versions_tenant_isolation ON contract_versions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE clause_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE clause_library FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clause_library_tenant_isolation ON clause_library;
CREATE POLICY clause_library_tenant_isolation ON clause_library
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledgers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledgers_tenant_isolation ON ledgers;
CREATE POLICY ledgers_tenant_isolation ON ledgers
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transactions_tenant_isolation ON transactions;
CREATE POLICY transactions_tenant_isolation ON transactions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS journal_entries_tenant_isolation ON journal_entries;
CREATE POLICY journal_entries_tenant_isolation ON journal_entries
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 4 — APPEND-ONLY TABLES
-- ############################################################################
-- These three tables are the legal record. Once a row is written it can never
-- be changed or removed — not by the app, not by a support engineer, not by
-- anyone with a database console. Corrections are made by adding a new row.

-- ---- audit_logs ----------------------------------------------------------
DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

-- ---- contract_versions ---------------------------------------------------
-- A contract dispute is settled by proving what the document said on a date.
-- If versions could be edited, the record would prove nothing.
DROP TRIGGER IF EXISTS contract_versions_no_update ON contract_versions;
CREATE TRIGGER contract_versions_no_update
  BEFORE UPDATE ON contract_versions
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

DROP TRIGGER IF EXISTS contract_versions_no_delete ON contract_versions;
CREATE TRIGGER contract_versions_no_delete
  BEFORE DELETE ON contract_versions
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

-- ---- journal_entries -----------------------------------------------------
-- Standard bookkeeping: you never erase an entry, you post a reversing one.
DROP TRIGGER IF EXISTS journal_entries_no_update ON journal_entries;
CREATE TRIGGER journal_entries_no_update
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

DROP TRIGGER IF EXISTS journal_entries_no_delete ON journal_entries;
CREATE TRIGGER journal_entries_no_delete
  BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();


-- ############################################################################
-- SECTION 5 — ⭐ DOUBLE-ENTRY BALANCE ENFORCEMENT ⭐
-- ############################################################################
--
-- THE MOST IMPORTANT RULE IN THIS FILE.
--
-- In double-entry bookkeeping every transaction has two sides that must be
-- equal. Money moves FROM somewhere TO somewhere; it is never created or
-- destroyed. If debits and credits do not match, money has been invented on
-- paper — and for a TRUST ledger holding client funds, that is not a bug,
-- it is a compliance failure.
--
-- WHY THIS TRIGGER IS "DEFERRED":
--   Saving a transaction means inserting several rows — one per side. If we
--   checked after EACH row, the very first insert would always fail, because
--   one side alone can never balance. DEFERRABLE INITIALLY DEFERRED tells
--   Postgres to wait until the whole save is finished (COMMIT) and check then.
--
-- WHY IT USES numeric AND NOT floating point:
--   In binary floating point 0.1 + 0.2 = 0.30000000000000004. Over thousands
--   of entries that drift makes a ledger silently unbalanced. `numeric` is
--   exact decimal arithmetic.

CREATE OR REPLACE FUNCTION enforce_double_entry_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_transaction_id uuid;
  v_debits   numeric(20,2);
  v_credits  numeric(20,2);
  v_diff     numeric(20,2);
  v_count    integer;
BEGIN
  -- Identify which transaction to check (works for INSERT, UPDATE and DELETE).
  v_transaction_id := COALESCE(NEW.transaction_id, OLD.transaction_id);

  IF v_transaction_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN entry_type = 'debit'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END), 0),
    COUNT(*)
  INTO v_debits, v_credits, v_count
  FROM journal_entries
  WHERE transaction_id = v_transaction_id;

  -- A transaction with no legs left (fully rolled back) is fine.
  IF v_count = 0 THEN
    RETURN NULL;
  END IF;

  -- A single leg can never balance.
  IF v_count < 2 THEN
    RAISE EXCEPTION
      'Transaction % is unbalanced: only % entry found. Double-entry requires at least two.',
      v_transaction_id, v_count
      USING ERRCODE = 'check_violation',
            HINT = 'Every transaction needs at least one debit and one credit.';
  END IF;

  v_diff := v_debits - v_credits;

  IF v_diff <> 0 THEN
    RAISE EXCEPTION
      'Transaction % does not balance. Debits = %, Credits = %, difference = %.',
      v_transaction_id, v_debits, v_credits, v_diff
      USING ERRCODE = 'check_violation',
            HINT = 'Debits must exactly equal credits. Check for a missing or mistyped entry.';
  END IF;

  RETURN NULL;
END;
$$;

-- CONSTRAINT TRIGGER + DEFERRABLE INITIALLY DEFERRED = check at COMMIT,
-- once every leg of the transaction has been inserted.
DROP TRIGGER IF EXISTS journal_entries_balance_check ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_double_entry_balance();


-- ---------------------------------------------------------------------------
-- Supporting rules for the ledger
-- ---------------------------------------------------------------------------

-- Amounts are always POSITIVE. Direction is carried by entry_type ('debit' or
-- 'credit'), never by a minus sign. Allowing both would give two ways to say
-- the same thing — and two ways to get it wrong.
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_amount_positive;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_amount_positive
  CHECK (amount > 0);

-- A journal entry must belong to the same tenant as its ledger and its
-- transaction. Without this, an entry with a valid tenant_id of its own could
-- still post into another tenant's trust account.
CREATE OR REPLACE FUNCTION assert_journal_entry_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ledger_tenant uuid;
  v_txn_tenant    uuid;
BEGIN
  SELECT tenant_id INTO v_ledger_tenant FROM ledgers      WHERE id = NEW.ledger_id;
  SELECT tenant_id INTO v_txn_tenant    FROM transactions WHERE id = NEW.transaction_id;

  IF v_ledger_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Cross-tenant journal entry blocked: ledger belongs to another tenant'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_txn_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Cross-tenant journal entry blocked: transaction belongs to another tenant'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journal_entries_tenant_check ON journal_entries;
CREATE TRIGGER journal_entries_tenant_check
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_tenant();


-- Maintain the cached ledger balance and the running balance on each entry.
-- The authoritative balance is always SUM(journal_entries); this cache exists
-- so a dashboard does not have to aggregate the full journal on every load.
CREATE OR REPLACE FUNCTION update_ledger_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_type text;
  v_delta        numeric(20,2);
  v_new_balance  numeric(20,2);
BEGIN
  SELECT account_type::text INTO v_account_type FROM ledgers WHERE id = NEW.ledger_id;

  -- Normal balance side depends on the account type:
  --   Assets and expenses increase with a DEBIT.
  --   Liabilities, equity and revenue increase with a CREDIT.
  IF v_account_type IN ('asset', 'expense') THEN
    v_delta := CASE WHEN NEW.entry_type = 'debit' THEN NEW.amount ELSE -NEW.amount END;
  ELSE
    v_delta := CASE WHEN NEW.entry_type = 'credit' THEN NEW.amount ELSE -NEW.amount END;
  END IF;

  UPDATE ledgers
     SET current_balance = current_balance + v_delta,
         updated_at      = now()
   WHERE id = NEW.ledger_id
  RETURNING current_balance INTO v_new_balance;

  -- Record the running balance on the entry itself, for statements of account.
  NEW.balance_after := v_new_balance;
  RETURN NEW;
END;
$$;

-- BEFORE INSERT so `balance_after` can be written onto the row itself.
DROP TRIGGER IF EXISTS journal_entries_update_balance ON journal_entries;
CREATE TRIGGER journal_entries_update_balance
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION update_ledger_balance();


-- ############################################################################
-- SECTION 6 — CROSS-TENANT REFERENCE GUARDS
-- ############################################################################
-- A normal foreign key proves a row EXISTS. It does not prove it belongs to
-- the same customer. These triggers close that gap: they make it impossible to
-- link your record to somebody else's record, even by accident.

-- ---- CRM entities --------------------------------------------------------
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

-- ---- Asset graph ---------------------------------------------------------
-- An edge joins two assets. An edge with a correct tenant_id could still link
-- YOUR building to ANOTHER customer's unit — the row looks fine, the
-- relationship does not.
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

  -- A self-referencing edge would make tree traversal loop forever.
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

-- ---- Asset → CRM references ----------------------------------------------
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

-- ---- Contract references -------------------------------------------------
CREATE OR REPLACE FUNCTION assert_contract_refs_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ref_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'contracts' THEN
    IF NEW.asset_id IS NOT NULL THEN
      SELECT tenant_id INTO ref_tenant FROM assets WHERE id = NEW.asset_id;
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Cross-tenant reference blocked: contract.asset_id'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
      SELECT tenant_id INTO ref_tenant FROM contacts WHERE id = NEW.contact_id;
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Cross-tenant reference blocked: contract.contact_id'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
    IF NEW.company_id IS NOT NULL THEN
      SELECT tenant_id INTO ref_tenant FROM companies WHERE id = NEW.company_id;
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Cross-tenant reference blocked: contract.company_id'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'contract_versions' THEN
    SELECT tenant_id INTO ref_tenant FROM contracts WHERE id = NEW.contract_id;
    IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant reference blocked: version.contract_id'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contracts_same_tenant ON contracts;
CREATE TRIGGER contracts_same_tenant
  BEFORE INSERT OR UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION assert_contract_refs_same_tenant();

DROP TRIGGER IF EXISTS contract_versions_same_tenant ON contract_versions;
CREATE TRIGGER contract_versions_same_tenant
  BEFORE INSERT ON contract_versions
  FOR EACH ROW EXECUTE FUNCTION assert_contract_refs_same_tenant();


-- ############################################################################
-- SECTION 7 — AUTOMATIC updated_at
-- ############################################################################

DROP TRIGGER IF EXISTS tenants_set_updated_at ON tenants;
CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS roles_set_updated_at ON roles;
CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS companies_set_updated_at ON companies;
CREATE TRIGGER companies_set_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS contacts_set_updated_at ON contacts;
CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS deals_set_updated_at ON deals;
CREATE TRIGGER deals_set_updated_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS cod_set_updated_at ON custom_object_definitions;
CREATE TRIGGER cod_set_updated_at BEFORE UPDATE ON custom_object_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS cfd_set_updated_at ON custom_field_definitions;
CREATE TRIGGER cfd_set_updated_at BEFORE UPDATE ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS cor_set_updated_at ON custom_object_records;
CREATE TRIGGER cor_set_updated_at BEFORE UPDATE ON custom_object_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS assets_set_updated_at ON assets;
CREATE TRIGGER assets_set_updated_at BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS contracts_set_updated_at ON contracts;
CREATE TRIGGER contracts_set_updated_at BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS clause_library_set_updated_at ON clause_library;
CREATE TRIGGER clause_library_set_updated_at BEFORE UPDATE ON clause_library
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS ledgers_set_updated_at ON ledgers;
CREATE TRIGGER ledgers_set_updated_at BEFORE UPDATE ON ledgers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ############################################################################
-- SECTION 8 — PHASE 5: ROW-LEVEL SECURITY
-- ############################################################################

ALTER TABLE financial_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_periods_tenant_isolation ON financial_periods;
CREATE POLICY financial_periods_tenant_isolation ON financial_periods
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE permission_denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_denials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS permission_denials_tenant_isolation ON permission_denials;
CREATE POLICY permission_denials_tenant_isolation ON permission_denials
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 9 — ⭐ PERIOD CLOSE ENFORCEMENT (SEC-012)
-- ############################################################################
--
-- THE PROBLEM:
--   You close March, file your numbers with the bank, and then someone posts a
--   back-dated entry into March. Your books now silently disagree with what you
--   filed. Nobody notices until an audit.
--
-- THE FIX:
--   Once a period is closed, the database REFUSES any journal entry whose
--   transaction date falls inside it. INSERT, UPDATE and DELETE alike.
--
-- WHY IT CHECKS THE TRANSACTION DATE, NOT created_at:
--   `created_at` is when the row was typed. `transaction_date` is when the money
--   actually moved — that is what determines which period an entry belongs to.
--   Checking created_at would let anyone back-date freely, which is the exact
--   hole we are closing.

CREATE OR REPLACE FUNCTION enforce_period_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id  uuid;
  v_txn_date   date;
  v_txn_id     uuid;
  v_period     record;
BEGIN
  -- Works for INSERT/UPDATE (NEW) and DELETE (OLD).
  v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_txn_id    := COALESCE(NEW.transaction_id, OLD.transaction_id);

  IF v_tenant_id IS NULL OR v_txn_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- The authoritative date lives on the parent transaction.
  SELECT transaction_date INTO v_txn_date
  FROM transactions
  WHERE id = v_txn_id;

  IF v_txn_date IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Is that date inside a period that is no longer open?
  SELECT id, name, status, start_date, end_date, closed_at
    INTO v_period
  FROM financial_periods
  WHERE tenant_id = v_tenant_id
    AND status <> 'open'
    AND v_txn_date BETWEEN start_date AND end_date
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot % this entry: % falls inside closed accounting period "%" (% to %).',
      lower(TG_OP), v_txn_date, v_period.name, v_period.start_date, v_period.end_date
      USING ERRCODE = 'check_violation',
            HINT = 'Post the entry to an open period, or reopen this period first. '
                   'Reopening requires the periods:reopen permission and is fully audited.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Fires BEFORE the write, so a blocked entry never touches the table.
DROP TRIGGER IF EXISTS journal_entries_period_lock ON journal_entries;
CREATE TRIGGER journal_entries_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_period_close();


-- Transactions themselves are also locked, so their dates cannot be moved into
-- or out of a closed period after the fact.
CREATE OR REPLACE FUNCTION enforce_period_close_transactions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_period record;
  v_check_date date;
BEGIN
  -- On UPDATE, check BOTH the old and new dates: moving an entry OUT of a closed
  -- period is just as much a violation as moving one in.
  FOREACH v_check_date IN ARRAY
    ARRAY[COALESCE(NEW.transaction_date, OLD.transaction_date),
          COALESCE(OLD.transaction_date, NEW.transaction_date)]
  LOOP
    SELECT name, start_date, end_date INTO v_period
    FROM financial_periods
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND status <> 'open'
      AND v_check_date BETWEEN start_date AND end_date
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION
        'Cannot % transaction: % falls inside closed period "%".',
        lower(TG_OP), v_check_date, v_period.name
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS transactions_period_lock ON transactions;
CREATE TRIGGER transactions_period_lock
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION enforce_period_close_transactions();


-- ############################################################################
-- SECTION 10 — PERIODS MUST NOT OVERLAP
-- ############################################################################
-- If two periods covered the same day — one open, one closed — the question
-- "is this date locked?" would have two answers. This makes overlap impossible.
--
-- Requires the btree_gist extension so a uuid (tenant_id) and a daterange can
-- live in the same exclusion constraint.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE financial_periods DROP CONSTRAINT IF EXISTS financial_periods_no_overlap;
ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

-- End date cannot precede start date.
ALTER TABLE financial_periods DROP CONSTRAINT IF EXISTS financial_periods_valid_range;
ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_valid_range
  CHECK (start_date <= end_date);


-- ############################################################################
-- SECTION 11 — APPEND-ONLY: PERMISSION DENIALS
-- ############################################################################
-- A denial record is security evidence. If it can be edited or deleted, someone
-- who probes the system can erase the trace of having done so.

-- (block_mutation_append_only is defined in Section 2)

DROP TRIGGER IF EXISTS permission_denials_no_update ON permission_denials;
CREATE TRIGGER permission_denials_no_update
  BEFORE UPDATE ON permission_denials
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

DROP TRIGGER IF EXISTS permission_denials_no_delete ON permission_denials;
CREATE TRIGGER permission_denials_no_delete
  BEFORE DELETE ON permission_denials
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();


-- ############################################################################
-- SECTION 12 — PHASE 5 updated_at
-- ############################################################################

-- (set_updated_at is defined in Section 2)

DROP TRIGGER IF EXISTS financial_periods_set_updated_at ON financial_periods;
CREATE TRIGGER financial_periods_set_updated_at
  BEFORE UPDATE ON financial_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ############################################################################
-- SECTION 13 — VERIFICATION
-- ############################################################################
-- Run each block below and confirm the expected result.
-- If any of them disagrees, STOP and re-run this file.


-- ── CHECK 1 ─────────────────────────────────────────────────────────────────
-- Every protected table must show rowsecurity = true.
-- EXPECT: 22 rows, every one `true`.

SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'tenants','users','roles','role_permissions','user_roles','audit_logs',
    'companies','contacts','deals',
    'custom_object_definitions','custom_field_definitions','custom_object_records',
    'assets','asset_relationships',
    'contracts','contract_versions','clause_library',
    'ledgers','transactions','journal_entries',
    'financial_periods','permission_denials'
  )
ORDER BY tablename;


-- ── CHECK 2 ─────────────────────────────────────────────────────────────────
-- The double-entry trigger must exist and be DEFERRED.
-- EXPECT: 1 row, tgdeferrable = true, tginitdeferred = true.

SELECT tgname,
       tgdeferrable  AS is_deferrable,
       tginitdeferred AS starts_deferred
FROM pg_trigger
WHERE tgname = 'journal_entries_balance_check';


-- ── CHECK 3 ─────────────────────────────────────────────────────────────────
-- Append-only protection must be in place on all three tables.
-- EXPECT: 8 rows.

SELECT c.relname AS table_name, t.tgname AS trigger_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE t.tgname LIKE '%_no_update' OR t.tgname LIKE '%_no_delete'
ORDER BY c.relname, t.tgname;


-- ── CHECK 4 ─────────────────────────────────────────────────────────────────
-- PROVE the balance rule actually works. This block INTENTIONALLY fails.
-- EXPECT: ERROR "Transaction ... does not balance. Debits = 100.00, Credits = 60.00"
--
-- Uncomment and run it once to see the protection fire, then leave it alone.
-- Nothing is saved — the ROLLBACK undoes everything either way.
--
-- BEGIN;
--   -- (replace the UUIDs with real ones from your own tenant/ledgers)
--   INSERT INTO transactions (id, tenant_id, description, transaction_date, currency)
--   VALUES ('11111111-1111-4111-8111-111111111111', '<your-tenant-uuid>',
--           'Deliberately unbalanced test', CURRENT_DATE, 'INR');
--
--   INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
--   VALUES ('<your-tenant-uuid>', '11111111-1111-4111-8111-111111111111',
--           '<ledger-a-uuid>', 'debit',  100.00);
--
--   INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
--   VALUES ('<your-tenant-uuid>', '11111111-1111-4111-8111-111111111111',
--           '<ledger-b-uuid>', 'credit',  60.00);
-- COMMIT;   -- ← the error appears HERE, not on the inserts. That is the deferral working.
--
-- ROLLBACK;


-- ── CHECK 5 ─────────────────────────────────────────────────────────────────
-- Ledger reconciliation: the cached balance must equal the sum of its entries.
-- EXPECT: 0 rows. Any row returned means a cached balance has drifted.

SELECT l.code,
       l.name,
       l.current_balance AS cached_balance,
       COALESCE(SUM(
         CASE
           WHEN l.account_type IN ('asset','expense') THEN
             CASE WHEN je.entry_type = 'debit' THEN je.amount ELSE -je.amount END
           ELSE
             CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE -je.amount END
         END
       ), 0) AS computed_balance
FROM ledgers l
LEFT JOIN journal_entries je ON je.ledger_id = l.id
WHERE l.deleted_at IS NULL
GROUP BY l.id, l.code, l.name, l.current_balance, l.account_type
HAVING l.current_balance <> COALESCE(SUM(
         CASE
           WHEN l.account_type IN ('asset','expense') THEN
             CASE WHEN je.entry_type = 'debit' THEN je.amount ELSE -je.amount END
           ELSE
             CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE -je.amount END
         END
       ), 0);


-- ── CHECK 6 ─────────────────────────────────────────────────────────────────
-- Global trial balance. Across the whole database, debits must equal credits.
-- EXPECT: difference = 0.00

SELECT
  COALESCE(SUM(CASE WHEN entry_type = 'debit'  THEN amount ELSE 0 END), 0) AS total_debits,
  COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END), 0) AS total_credits,
  COALESCE(SUM(CASE WHEN entry_type = 'debit'  THEN amount ELSE -amount END), 0) AS difference
FROM journal_entries;


SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('financial_periods', 'permission_denials')
ORDER BY tablename;

-- ── CHECK 7 ─────────────────────────────────────────────────────────────────
-- Phase 5 tables must be protected too. EXPECT 2 rows, both `true`.

SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('financial_periods', 'permission_denials')
ORDER BY tablename;


-- ── CHECK 8 ── The period-lock triggers must exist. EXPECT 2 rows.
SELECT c.relname AS table_name, t.tgname AS trigger_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE t.tgname IN ('journal_entries_period_lock', 'transactions_period_lock')
ORDER BY c.relname;

-- ── CHECK 9 ── The overlap constraint must exist. EXPECT 1 row.
SELECT conname, contype
FROM pg_constraint
WHERE conname = 'financial_periods_no_overlap';

-- ── CHECK 10 ── PROVE the period lock works.
-- Replace the placeholders with real values, then run. It SHOULD fail.
--
-- Step 1 — close a period:
--   INSERT INTO financial_periods (tenant_id, name, start_date, end_date, status)
--   VALUES ('<tenant-uuid>', 'Q1 2026 TEST', '2026-01-01', '2026-03-31', 'closed');
--
-- Step 2 — try to post an entry dated inside it:
--   BEGIN;
--     INSERT INTO transactions (id, tenant_id, description, transaction_date, currency)
--     VALUES ('22222222-2222-4222-8222-222222222222', '<tenant-uuid>',
--             'Back-dated test', '2026-02-15', 'INR');
--
--     INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
--     VALUES ('<tenant-uuid>', '22222222-2222-4222-8222-222222222222',
--             '<ledger-uuid>', 'debit', 100.00);
--   COMMIT;
--
-- EXPECTED:
--   ERROR: Cannot insert this entry: 2026-02-15 falls inside closed accounting
--          period "Q1 2026 TEST" (2026-01-01 to 2026-03-31).
--
-- Note the error appears on the journal_entries INSERT, not at COMMIT. The
-- period lock is a BEFORE trigger — it stops the write before it happens.
-- (The balance trigger from Phase 4 is deferred and fires at COMMIT. Different
--  jobs, different timing, both correct.)

-- ── CHECK 11 ── List closed periods and how many entries each protects.
SELECT
  fp.name,
  fp.start_date,
  fp.end_date,
  fp.status,
  fp.closed_at,
  COUNT(je.id) AS entries_locked
FROM financial_periods fp
LEFT JOIN transactions t
       ON t.tenant_id = fp.tenant_id
      AND t.transaction_date BETWEEN fp.start_date AND fp.end_date
LEFT JOIN journal_entries je ON je.transaction_id = t.id
GROUP BY fp.id, fp.name, fp.start_date, fp.end_date, fp.status, fp.closed_at
ORDER BY fp.start_date DESC;

-- ── CHECK 12 ── Recent permission denials — the security signal to watch.
SELECT permission, actor_role, was_dangerous, COUNT(*) AS attempts
FROM permission_denials
WHERE created_at > now() - interval '7 days'
GROUP BY permission, actor_role, was_dangerous
ORDER BY was_dangerous DESC, attempts DESC
LIMIT 20;


-- ============================================================================
--   SETUP COMPLETE
--
--   Confirm:
--     Check 1  → 22 tables, every one `true`
--     Check 2  → the balance trigger is DEFERRED
--     Check 3  → 8 append-only triggers
--     Check 5  → 0 rows (ledger balances all reconcile)
--     Check 6  → difference = 0.00
--     Check 7  → 2 tables, both `true`
--     Check 8  → 2 period-lock triggers
--     Check 9  → the overlap constraint exists
--
--   If all of those agree, your database is fully protected.
-- ============================================================================
