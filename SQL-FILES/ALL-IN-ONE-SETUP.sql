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
-- SECTION 0 — THE APPLICATION ROLE  (ameya_app → ordence_app)
-- ############################################################################
--
-- The product was renamed from "Ameya Heights OS" to "Ordence", and the role
-- the application connects as was renamed with it. Every GRANT and REVOKE in
-- the rest of this file now names `ordence_app`.
--
-- ⚠️ A ROLE NAME IS NOT A TEXT SUBSTITUTION.
--
--   Renaming it in the source files alone would leave an already-deployed
--   database holding a role called `ameya_app` that nothing grants to any
--   more. Every grant block below is wrapped in `IF EXISTS (… rolname =
--   'ordence_app')`, so it would not error — it would silently do nothing,
--   and the application would keep connecting as a role whose privileges
--   were last set by the previous release. That is the quiet kind of
--   failure this file exists to prevent, so the rename happens HERE, first,
--   before anything below can be skipped.
--
-- THREE CASES, AND THIS BLOCK IS A NO-OP IN TWO OF THEM:
--
--   · `ordence_app` already exists  → nothing to do. This is the steady
--     state, and it is what makes re-running this file safe.
--
--   · only `ameya_app` exists       → rename it. `ALTER ROLE … RENAME TO`
--     keeps every privilege, every role membership and the ownership of
--     every object, because all three are recorded against the role's OID
--     rather than its name. Existing sessions are not disturbed.
--
--     ⚠️ THE ONE THING A RENAME DOES NOT CARRY OVER IS AN md5 PASSWORD.
--     Postgres salts md5 hashes with the role name, so the stored hash stops
--     matching the moment the name changes and the next login fails. SCRAM
--     passwords (the default since PG 14) are unaffected. If this deployment
--     is old enough to still use md5, set the password again afterwards.
--
--   · neither exists                → create it, NOLOGIN and with no other
--     attributes. Deliberately not LOGIN: a setup file must never be the
--     thing that hands somebody a way in. Grant LOGIN and a password
--     yourself if this deployment connects as a separate role.
--
-- ⚠️ CREATE/ALTER ROLE needs privileges a managed provider may not give you.
-- On Neon the application connects as the database owner and no separate role
-- exists at all — which is exactly the case the grant blocks below already
-- describe. A refusal here must not abort the other 5,000 lines, so it
-- degrades to a NOTICE in the same way they do.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    RAISE NOTICE 'Role ordence_app already exists - nothing to rename.';
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ameya_app') THEN
    EXECUTE 'ALTER ROLE ameya_app RENAME TO ordence_app';
    RAISE NOTICE 'Renamed role ameya_app to ordence_app. All privileges and '
                 'object ownership carried over. If this deployment still '
                 'uses an md5 password, set it again now - md5 hashes are '
                 'salted with the role name and no longer match.';
  ELSE
    EXECUTE 'CREATE ROLE ordence_app NOLOGIN';
    RAISE NOTICE 'Created role ordence_app (NOLOGIN, no attributes). Grant it '
                 'LOGIN and a password if your application connects as a '
                 'separate role rather than as the database owner.';
  END IF;

  -- Same treatment for the maintenance role. It is optional — only the
  -- secops cleanup grants reference it, and they are guarded by IF EXISTS —
  -- so this renames one if it is there and creates nothing if it is not.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ameya_maintenance') THEN
    EXECUTE 'ALTER ROLE ameya_maintenance RENAME TO ordence_maintenance';
    RAISE NOTICE 'Renamed role ameya_maintenance to ordence_maintenance.';
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Not permitted to create or rename roles on this database - '
                 'skipping. This is expected on Neon, where the app connects '
                 'as the database owner and there is no separate role.';
END
$$;


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

-- ############################################################################
-- 🔴 PLATFORM SCOPE — AN EXPLICIT OPT-IN, NOT AN ABSENCE
-- ############################################################################
--
-- THE BUG THIS FIXES (found 31 July 2026, present since Phase 1):
--
--   `withPlatformScope()` in db/index.ts is the deliberate cross-tenant escape
--   hatch — used by the payment-webhook resolver, which must map a provider id
--   to a tenant BEFORE it knows which tenant to pin.
--
--   It ran with NO tenant context, on the assumption that "no context" meant
--   "unrestricted". It does not. Every policy reads
--   `tenant_id = app_current_tenant_id()`, and with no context that is
--   `tenant_id = NULL`, which in SQL is NULL — never TRUE. So the escape hatch
--   read ZERO ROWS FROM EVERY TABLE.
--
--   Measured on a real database:
--       tenants in the table                      12
--       tenants visible to withPlatformScope()     0
--
--   It failed CLOSED, so nothing ever leaked. But the webhook tenant resolver
--   could never have matched a subscription, and every real payment event
--   would have been recorded as "unknown tenant" the moment traffic arrived.
--
-- THE FIX, AND WHY IT IS SHAPED THIS WAY:
--
--   A setting the caller must EXPLICITLY turn on, rather than a condition that
--   is satisfied by forgetting to set something. The difference matters: the
--   old behaviour meant any code path that neglected to open a tenant
--   transaction was, in principle, one policy edit away from seeing
--   everything. Now the only way to read across tenants is to say so.
--
--   `app.platform_scope` is transaction-local (`set_config(..., true)`), so it
--   cannot leak to the next borrower of a pooled connection — the same
--   reasoning documented at length on `withTenant()`.
--
-- ⚠️ READ ONLY. This marker is added to every policy's USING clause and to
--    NO policy's WITH CHECK clause. Platform scope may LOOK across tenants; it
--    may never WRITE across them. A cross-tenant write has no legitimate
--    caller in this system, and leaving it impossible costs nothing.
-- ############################################################################

-- ⚠️ THE MARKER IS NOT ADDED TO EVERY TABLE.
--
-- It appears only on PLATFORM tables — tenants, users, subscriptions,
-- invoices, payment and usage records, and the observability streams.
--
-- It is deliberately ABSENT from every table holding customer CONTENT:
-- contacts, companies, deals, contracts, clauses, assets, ledgers, journal
-- entries, documents, portal links. Platform staff can see THAT a customer
-- exists, what they pay, how much they use and whether they are healthy.
-- They cannot read the customer's actual business records.
--
-- A first attempt at this fix added the marker to all 29 policies at once,
-- which quietly widened platform visibility to every contact and contract in
-- the system. A Phase 17 test caught it. The narrower list is the correct
-- one, and the breadth of an escape hatch is exactly the thing to get wrong
-- by being helpful.

CREATE OR REPLACE FUNCTION app_is_platform_scope()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on';
$$;



COMMENT ON FUNCTION app_current_tenant_id() IS
  'Returns the tenant id pinned for the current transaction, or NULL if unset.';


-- ############################################################################
-- SECTION 1b — BASELINE PRIVILEGES FOR THE APPLICATION ROLE
-- ############################################################################
--
-- ⚠️ THIS SECTION EXISTS BECAUSE A FRESH DATABASE HAD NONE.
--
-- Found the hard way: the container reclaimed the test database, it was
-- rebuilt by following the documented procedure exactly —
--
--     npm run db:push  →  ALL-IN-ONE-SETUP.sql  →  npm run db:verify
--
-- — and 106 of 467 security tests failed with SQLSTATE 42501,
-- "permission denied for table". Every RLS policy was correct. Every
-- trigger was correct. `db:verify` passed. The application simply could
-- not read or write anything.
--
-- The cause: `drizzle-kit push` creates tables owned by the MIGRATION
-- role. It grants nothing to anybody else. This file then went straight
-- to REVOKE-and-narrowly-GRANT on the dozen tables where a restriction
-- matters, and silently assumed a baseline that had been applied by hand,
-- once, months earlier, on a database that no longer exists.
--
-- That assumption is invisible on any database that has been running for
-- a while and fatal on the first genuinely fresh deploy — which is
-- exactly the deploy that matters, because it is production.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ ORDERING IS LOAD-BEARING. DO NOT MOVE THIS SECTION DOWN THE FILE.
-- ══════════════════════════════════════════════════════════════════════
-- Every restriction in this file works by REVOKE-then-narrow-GRANT, and
-- the first of those appears much later (Phase 11 billing: the app must
-- not be able to UPDATE `plans` and reprice itself).
--
-- A blanket GRANT placed AFTER those sections would silently hand back
-- every privilege they exist to remove. The application would work
-- perfectly and a tenant would be able to set their own subscription
-- price to zero.
--
-- So this must stay ahead of every REVOKE in the file. `npm run db:verify`
-- checks the billing privileges specifically, which is what would catch
-- it if somebody moves this block.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    RAISE NOTICE 'Role ordence_app does not exist - skipping baseline grants. '
                 'This is expected on Neon, where the app connects as the '
                 'database owner.';
    RETURN;
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA public TO ordence_app';

  -- The ordinary working set. Tables that must be more restricted than
  -- this are narrowed by the REVOKE blocks later in this file.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ordence_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ordence_app';

  -- ⚠️ NOT `ALTER DEFAULT PRIVILEGES`. That would grant on tables created
  -- in the FUTURE, which sounds convenient and means the next phase's
  -- evidence table arrives writable before anybody has decided whether it
  -- should be. Re-running this file after a schema change is the
  -- deliberate step, and it is already in the documented procedure.
  RAISE NOTICE 'Baseline privileges granted to ordence_app.';
END
$$;


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
  USING (id = app_current_tenant_id() OR app_is_platform_scope())
  -- ⚠️ THE ONE PLACE PLATFORM SCOPE MAY WRITE, AND ONLY HERE.
  --
  -- Suspending or reactivating a workspace is the core platform-admin
  -- action, and it is a write to THIS table. Every other table's WITH
  -- CHECK deliberately omits the marker, so platform scope stays
  -- read-only everywhere else.
  --
  -- The blast radius is bounded by the column set that matters:
  -- `tenants` holds configuration and status, not customer records. A
  -- platform admin can suspend a workspace; they still cannot write a
  -- contact, a contract or a ledger entry, because none of those
  -- policies admit the marker at all.
  WITH CHECK (id = app_current_tenant_id() OR app_is_platform_scope());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_scope())
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
-- SECTION 13 — PHASE 8: DOCUMENT STORAGE
-- ############################################################################
--
-- ⚠️  WHAT THIS SECTION PROTECTS, AND WHAT IT CANNOT PROTECT
--
-- Everything here secures ROWS IN POSTGRES. The file bytes live in Vercel
-- Blob, which has never heard of `app.current_tenant_id`.
--
-- If a file were uploaded with `access: 'public'`, its URL would be readable
-- by anyone who ever saw it — a forwarded email, a browser history, a proxy
-- log — and nothing below would change that.
--
-- The application uploads with `access: 'private'` and streams downloads
-- through `/api/documents/[id]/download`, which re-checks session and tenant
-- on every request. These policies and that private access are two halves of
-- one control. Either half alone leaks files.

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
CREATE POLICY documents_tenant_isolation ON documents
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- A document must not be movable between tenants. The policy above already
-- blocks this for a normal session, but `tenant_id` remains a mutable column
-- and a future migration or elevated job could rewrite it. A document is
-- evidence; moving evidence between tenants must never be accidental.
CREATE OR REPLACE FUNCTION prevent_document_tenant_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'A document cannot be moved between tenants (attempted % -> %)',
      OLD.tenant_id, NEW.tenant_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_tenant_immutable ON documents;
CREATE TRIGGER documents_tenant_immutable
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION prevent_document_tenant_change();


-- The (entity_type, entity_id) link is polymorphic, so no foreign key can
-- enforce it — PostgreSQL does not know which table to look in.
-- `saveDocumentRecord` verifies the parent exists and belongs to the caller's
-- tenant before inserting. This trigger makes that check stick: the parent
-- link and the storage location are immutable afterwards.
CREATE OR REPLACE FUNCTION prevent_document_reparenting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
    RAISE EXCEPTION
      'A document cannot be re-attached to a different record (% % -> % %)',
      OLD.entity_type, OLD.entity_id, NEW.entity_type, NEW.entity_id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.blob_pathname IS DISTINCT FROM OLD.blob_pathname THEN
    RAISE EXCEPTION 'A document''s storage location is immutable'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_parent_immutable ON documents;
CREATE TRIGGER documents_parent_immutable
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION prevent_document_reparenting();


-- ############################################################################
-- SECTION 14 — PHASE 9: EXTERNAL CLIENT PORTAL
-- ############################################################################
--
-- ENABLE turns policies on for ordinary roles.
-- FORCE additionally applies them to the table OWNER — which in many
-- deployments is the role the application itself connects as. Without FORCE
-- the isolation is decorative.

ALTER TABLE portal_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_links_tenant_isolation ON portal_links;
CREATE POLICY portal_links_tenant_isolation ON portal_links
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


ALTER TABLE contract_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signatures FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_signatures_tenant_isolation ON contract_signatures;
CREATE POLICY contract_signatures_tenant_isolation ON contract_signatures
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 15 — PORTAL LINK TAMPER GUARD
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   A portal link's authority comes entirely from its token. If `token_hash`
--   were mutable, anyone able to run an UPDATE could point an EXISTING link —
--   with its creation record, its recipient, its access history — at a token
--   of their own choosing. The audit trail would then describe a link that no
--   longer exists, and the forged one would inherit its history.
--
--   The same applies to what the link points AT. Re-aiming a live link from a
--   ₹50,000 purchase order to a ₹5 crore sale agreement, while the recipient
--   still holds the URL they were emailed, is the obvious attack.
--
-- THE FIX:
--   Credential and target are both fixed at creation. Changing either means
--   issuing a new link, which leaves a record.

CREATE OR REPLACE FUNCTION prevent_portal_link_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'A portal link cannot be moved between tenants'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    RAISE EXCEPTION 'A portal link''s token is immutable — issue a new link instead'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
    RAISE EXCEPTION 'A portal link cannot be re-aimed at a different record'
      USING ERRCODE = '42501';
  END IF;

  -- Permission can only ever be REDUCED. Silently upgrading a "view" link
  -- that a client already holds into one that can sign a contract would turn
  -- a read-only share into signing authority without the client ever being
  -- told. Downgrading is always safe.
  IF OLD.permission = 'view' AND NEW.permission = 'view_and_sign' THEN
    RAISE EXCEPTION 'A view-only portal link cannot be upgraded to signing — issue a new link'
      USING ERRCODE = '42501';
  END IF;

  -- Extending the life of a link that already expired resurrects a
  -- credential the recipient was told had lapsed. Issue a new one.
  IF OLD.expires_at < now() AND NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'An expired portal link cannot be extended — issue a new link'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS portal_links_tamper_guard ON portal_links;
CREATE TRIGGER portal_links_tamper_guard
  BEFORE UPDATE ON portal_links
  FOR EACH ROW EXECUTE FUNCTION prevent_portal_link_tampering();


-- ############################################################################
-- SECTION 16 — SIGNATURES ARE APPEND-ONLY
-- ############################################################################
--
-- A signature is evidence. Evidence that can be edited after the fact is not
-- evidence — and "we would never do that" is a policy, not a control.
--
-- The same trigger pattern already protects audit_logs, contract_versions and
-- journal_entries. UPDATE and DELETE are refused by the DATABASE, so an
-- application bug, a stray migration or a console session cannot rewrite a
-- signature.
--
-- A genuine mistake is corrected by voiding the contract and signing a new
-- one — which leaves both records visible, which is the point.

CREATE OR REPLACE FUNCTION prevent_signature_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'contract_signatures is append-only. A signature cannot be % once recorded.',
    lower(TG_OP)
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS contract_signatures_no_update ON contract_signatures;
CREATE TRIGGER contract_signatures_no_update
  BEFORE UPDATE ON contract_signatures
  FOR EACH ROW EXECUTE FUNCTION prevent_signature_mutation();

DROP TRIGGER IF EXISTS contract_signatures_no_delete ON contract_signatures;
CREATE TRIGGER contract_signatures_no_delete
  BEFORE DELETE ON contract_signatures
  FOR EACH ROW EXECUTE FUNCTION prevent_signature_mutation();


-- ############################################################################
-- SECTION 17 — PORTAL LINK EXPIRY SANITY
-- ############################################################################
--
-- Not security-critical, but it turns two classes of silent bug into loud
-- failures at insert time:
--   - `expires_at` in the past  → a link that never worked, reported as
--     "the client says the link is broken" three days later
--   - `expires_at` years away   → a bearer credential to a legal document
--     left live indefinitely because nobody chose a number

ALTER TABLE portal_links DROP CONSTRAINT IF EXISTS portal_links_expiry_sane;
ALTER TABLE portal_links ADD CONSTRAINT portal_links_expiry_sane
  CHECK (expires_at > created_at AND expires_at < created_at + INTERVAL '180 days');


-- ############################################################################
-- SECTION 17b — ⭐ ANALYTICS VIEWS: THE security_invoker REQUIREMENT
-- ############################################################################
--
-- ROW-LEVEL SECURITY DOES NOT AUTOMATICALLY APPLY THROUGH A VIEW.
--
-- By default a view runs with the privileges of its OWNER, not the caller.
-- If the owner can read every row of `journal_entries`, the view returns
-- every row of `journal_entries` — to anyone allowed to select from it. The
-- RLS policies on the underlying tables are never consulted.
--
-- Verified on PostgreSQL 16 before these views were written. A non-superuser
-- session pinned to ONE tenant queried two otherwise identical views:
--
--     naive view     (no option)               -> 6 tenants visible
--     safe  view     (security_invoker = true) -> 1 tenant  visible
--
-- The failure mode is quiet. Nothing errors, the dashboard renders, and the
-- numbers are simply the WHOLE PLATFORM'S — every tenant's assets and cash,
-- shown to one customer as their own.
--
-- Requires PostgreSQL 15+. The guard below fails loudly rather than creating
-- views that leak.

-- Fail immediately and loudly on an unsupported server, rather than creating
-- views that appear to work and quietly cross tenant boundaries.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'PostgreSQL 15+ is required for security_invoker views. Found %. '
      'Creating these views on an older server would expose every tenant''s '
      'aggregate data to every other tenant.',
      current_setting('server_version');
  END IF;
END
$$;


-- ############################################################################
-- SECTION 18 — ANALYTICS: ASSET PORTFOLIO
-- ############################################################################
--
-- Powers the donut chart. One row per (tenant, asset_type, status).
--
-- `tenant_id` is included in the projection even though RLS already
-- restricts it to one value. Two reasons: the application filters on it
-- explicitly as a second layer, and a view that omits the tenant column
-- makes an accidental cross-tenant aggregate impossible to SPOT in a query
-- plan or a debugging session.

DROP VIEW IF EXISTS v_asset_portfolio;

CREATE VIEW v_asset_portfolio
WITH (security_invoker = true) AS
SELECT
  a.tenant_id,
  a.asset_type,
  a.status,
  count(*)::int                                        AS asset_count,
  COALESCE(sum(a.value_amount), 0)::numeric(20, 2)     AS total_value,
  COALESCE(sum(a.area_value), 0)::numeric(20, 2)       AS total_area,
  COALESCE(sum(a.quantity), 0)::bigint                 AS total_quantity
FROM assets a
WHERE a.deleted_at IS NULL
GROUP BY a.tenant_id, a.asset_type, a.status;


-- ############################################################################
-- SECTION 19 — ANALYTICS: 30-DAY LEDGER BALANCES
-- ############################################################################
--
-- Powers the financial bar chart: one row per (tenant, day) for the last 30
-- days, with debits and credits side by side.
--
-- WHY generate_series AND A LEFT JOIN:
--   A plain `GROUP BY date` returns rows only for days that had activity. A
--   chart built on that silently compresses quiet days out of existence, so
--   a fortnight with three transactions renders as three adjacent bars and
--   reads like three consecutive days of trading. Generating the full date
--   spine and left-joining onto it means a day with no movement is an
--   explicit zero — which is the truth, and which the chart can draw.
--
-- WHY numeric AND NOT float:
--   Money. `sum()` over `double precision` accumulates representation error
--   across thousands of rows. `journal_entries.amount` is NUMERIC and the
--   sum stays NUMERIC all the way to the application, which converts it to
--   a display string without ever going through a float.

DROP VIEW IF EXISTS v_ledger_daily;

CREATE VIEW v_ledger_daily
WITH (security_invoker = true) AS
WITH date_spine AS (
  SELECT generate_series(
           (CURRENT_DATE - INTERVAL '29 days')::date,
           CURRENT_DATE::date,
           INTERVAL '1 day'
         )::date AS day
),
tenant_days AS (
  -- The spine has to be crossed with the tenants that actually have a
  -- ledger, or every tenant would get 30 empty rows for every other
  -- tenant's existence. RLS then reduces this to the caller's own tenant.
  SELECT DISTINCT t.tenant_id, d.day
  FROM (SELECT DISTINCT tenant_id FROM transactions) t
  CROSS JOIN date_spine d
),
daily AS (
  SELECT
    tr.tenant_id,
    tr.transaction_date::date                              AS day,
    SUM(CASE WHEN je.entry_type = 'debit'  THEN je.amount ELSE 0 END) AS debits,
    SUM(CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE 0 END) AS credits,
    count(DISTINCT tr.id)::int                             AS transaction_count
  FROM transactions tr
  JOIN journal_entries je
    ON je.transaction_id = tr.id
   -- The tenant predicate on the JOIN as well as the outer filter. A join
   -- across tenants would be arithmetic nonsense even where RLS permitted
   -- it, and this makes that impossible rather than merely unlikely.
   AND je.tenant_id = tr.tenant_id
  WHERE tr.transaction_date >= (CURRENT_DATE - INTERVAL '29 days')
    AND tr.transaction_date <= CURRENT_DATE
  GROUP BY tr.tenant_id, tr.transaction_date::date
)
SELECT
  td.tenant_id,
  td.day,
  COALESCE(dl.debits, 0)::numeric(20, 2)  AS debits,
  COALESCE(dl.credits, 0)::numeric(20, 2) AS credits,
  -- Signed, so the chart can show which way the day ran without the
  -- application recomputing it and risking a different rounding.
  (COALESCE(dl.debits, 0) - COALESCE(dl.credits, 0))::numeric(20, 2) AS net_movement,
  COALESCE(dl.transaction_count, 0)       AS transaction_count
FROM tenant_days td
LEFT JOIN daily dl
  ON dl.tenant_id = td.tenant_id
 AND dl.day = td.day;


-- ############################################################################
-- SECTION 20 — ANALYTICS: CONTRACT PIPELINE
-- ############################################################################
--
-- Powers the pipeline summary. One row per (tenant, status).

DROP VIEW IF EXISTS v_contract_pipeline;

CREATE VIEW v_contract_pipeline
WITH (security_invoker = true) AS
SELECT
  c.tenant_id,
  c.status,
  count(*)::int                                     AS contract_count,
  COALESCE(sum(c.value), 0)::numeric(20, 2)         AS total_value,
  count(*) FILTER (WHERE c.signed_at IS NOT NULL)::int   AS signed_count,
  count(*) FILTER (WHERE c.legal_hold)::int              AS on_hold_count,
  -- Contracts expiring inside 30 days: the number that should prompt an
  -- action, surfaced without the application having to run a second query.
  count(*) FILTER (
    WHERE c.expiry_date IS NOT NULL
      AND c.expiry_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '30 days')
  )::int AS expiring_soon_count
FROM contracts c
WHERE c.deleted_at IS NULL
GROUP BY c.tenant_id, c.status;


-- ############################################################################
-- SECTION 21 — ANALYTICS GRANTS
-- ############################################################################
--
-- SELECT only. These views exist to be read; nothing should ever write
-- through them, and PostgreSQL would otherwise permit updates through the
-- simple ones.
--
-- The role name differs per deployment, so this is written defensively —
-- a missing role must not abort the whole setup file.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    GRANT SELECT ON v_asset_portfolio   TO ordence_app;
    GRANT SELECT ON v_ledger_daily      TO ordence_app;
    GRANT SELECT ON v_contract_pipeline TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 22 — VERIFICATION
-- ############################################################################
-- Run each block below and confirm the expected result.
-- If any of them disagrees, STOP and re-run this file.


-- ── CHECK 1 ─────────────────────────────────────────────────────────────────
-- Every protected table must show rowsecurity = true.
-- EXPECT: 25 rows, every one `true`.

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
    'financial_periods','permission_denials',
    'documents',
    'portal_links','contract_signatures'
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




-- ############################################################################
-- SECTION 14 — PHASE 11: BILLING FOUNDATION
-- ############################################################################
--
-- Six new tables: plans, subscriptions, invoices, invoice_lines,
-- payment_events, payment_methods.
--
-- Five are tenant-scoped and under RLS. `plans` is platform catalogue data
-- and deliberately is not — it is protected by GRANT instead, because a
-- tenant repricing their own plan is the most obvious attack on a billing
-- system and the cleanest defence is that the privilege never existed.
--
-- Three guarantees here are enforced by the DATABASE rather than by the
-- application, because the application will be rewritten several times and
-- these must survive it:
--
--   * A duplicate provider event CANNOT be recorded twice, so a retried
--     webhook cannot charge a customer twice.
--   * A payment event, once written, CANNOT be altered.
--   * An issued invoice's amounts CANNOT be altered.
--
-- Full commentary, including the standalone verification queries, is in
-- SQL-FILES/0009_phase11_billing.sql. This section is the executable part.
-- ############################################################################

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

-- ---------------------------------------------------------------------------
-- `plans` IS NOT PROTECTED, AND THAT IS DELIBERATE
-- ---------------------------------------------------------------------------
-- It is platform catalogue data: the same "Advanced ₹4,999/mo" row is read by
-- every tenant, exactly like `permissions` in Phase 1. It contains no customer
-- data. Adding a tenant_id to it in order to have something to filter on would
-- mean duplicating the catalogue per tenant, which is worse in every respect.
--
-- Writes are restricted by GRANT (Section 6), not by RLS — tenants have no
-- INSERT/UPDATE/DELETE on it at all.
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_tenant_isolation ON subscriptions;
CREATE POLICY subscriptions_tenant_isolation ON subscriptions
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_scope())
  WITH CHECK (tenant_id = app_current_tenant_id());


ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoices_tenant_isolation ON invoices;
CREATE POLICY invoices_tenant_isolation ON invoices
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_scope())
  WITH CHECK (tenant_id = app_current_tenant_id());


ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_lines_tenant_isolation ON invoice_lines;
CREATE POLICY invoice_lines_tenant_isolation ON invoice_lines
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_scope())
  WITH CHECK (tenant_id = app_current_tenant_id());


ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_methods_tenant_isolation ON payment_methods;
CREATE POLICY payment_methods_tenant_isolation ON payment_methods
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_scope())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ---------------------------------------------------------------------------
-- `payment_events` — THE ONE POLICY WITH A NULL ALLOWANCE
-- ---------------------------------------------------------------------------
-- Every other tenant-scoped table in this platform has a NOT NULL tenant_id
-- and a policy that is a plain equality. This one is different, and the
-- difference is worth stating precisely because it looks like a hole.
--
-- A webhook can arrive that maps to NO tenant: test-mode traffic, an object
-- created by hand in the provider's dashboard, a customer migrated from
-- another system. Dropping those events would be the worst option — an
-- unexplained payment webhook is exactly the one you will want to read six
-- months from now, during a dispute.
--
-- So orphan events are recorded with tenant_id IS NULL. The policy permits
-- READING them only when NO tenant context is set — i.e. from the
-- platform-scoped connection used by super-admin tooling. A tenant session,
-- which always has app.current_tenant_id populated, sees exactly its own rows
-- and never an orphan.
--
--   tenant session (context = A)  ->  rows where tenant_id = A
--   platform scope (context NULL) ->  rows where tenant_id IS NULL
--
-- Note what this does NOT do: it does not let a tenant see another tenant's
-- events, and it does not let a tenant see orphans. Verified in Section 7 and
-- in tests/security/billing-isolation.test.ts.
-- ---------------------------------------------------------------------------

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_events_tenant_isolation ON payment_events;
CREATE POLICY payment_events_tenant_isolation ON payment_events
  USING (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_is_platform_scope())
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_is_platform_scope())
  );


-- ############################################################################
-- SECTION 2 — payment_events IS APPEND-ONLY
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   `payment_events` is the evidence table. If a customer disputes a charge,
--   or a regulator asks how a subscription came to be in a given state, this
--   is the record that answers. A record that can be edited answers nothing —
--   it only shows what someone was willing to say.
--
--   The concrete attack is narrow and realistic: an engineer with database
--   access "fixing" a bad reconciliation by UPDATEing an event, rather than
--   inserting a correcting one. The history then describes a past that did
--   not happen, and the bug that caused it becomes invisible.
--
-- THE FIX:
--   UPDATE and DELETE are refused outright by a trigger, exactly as for
--   `audit_logs` (Phase 1) and `contract_signatures` (Phase 9). Corrections
--   are made by INSERTING a new event, which is what an append-only log is
--   for.
--
--   SQLSTATE 42501 (insufficient_privilege) is raised deliberately so the
--   application can distinguish this from an ordinary constraint failure.

CREATE OR REPLACE FUNCTION prevent_payment_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'payment_events is append-only. % is not permitted on payment evidence. '
    'Record a correcting event instead.',
    TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS payment_events_no_update ON payment_events;
CREATE TRIGGER payment_events_no_update
  BEFORE UPDATE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_event_mutation();

DROP TRIGGER IF EXISTS payment_events_no_delete ON payment_events;
CREATE TRIGGER payment_events_no_delete
  BEFORE DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_event_mutation();


-- ############################################################################
-- SECTION 3 — INVOICE NUMBERING
-- ############################################################################
--
-- WHY A DATABASE SEQUENCE AND NOT `SELECT MAX(number) + 1`
--
--   Two concurrent invoice creations reading MAX at the same moment both get
--   the same answer, and one of them fails on the unique index — or worse,
--   succeeds against a differently-shaped number. On a serverless platform
--   where a hundred function instances can exist simultaneously, this is not
--   a theoretical race.
--
--   It is also not solvable with an application-level lock, because the
--   instances share nothing.
--
-- WHY THE SEQUENCE IS GLOBAL AND NOT PER-TENANT
--
--   These are invoices WE issue to OUR customers. There is one issuing entity
--   — Ordence — so there is one series. Under Indian GST rules an
--   invoice series must be consecutive and unique for the financial year
--   across the whole registration, not per customer.
--
--   A gap in the series is a question an auditor is entitled to ask, and
--   sequences do produce gaps on rollback. That is accepted deliberately: a
--   gap you can explain ("transaction rolled back") is far better than a
--   duplicate number, which is a compliance failure.
--
-- FINANCIAL YEAR
--
--   India's FY runs April–March, so an invoice dated 2 April 2026 belongs to
--   FY 2026-27 and one dated 30 March 2026 belongs to FY 2025-26. The label is
--   computed rather than stored so it cannot drift from the date.

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

CREATE OR REPLACE FUNCTION indian_financial_year(at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN EXTRACT(MONTH FROM at AT TIME ZONE 'Asia/Kolkata') >= 4
      THEN to_char(at AT TIME ZONE 'Asia/Kolkata', 'YYYY') || '-' ||
           to_char((at AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 year', 'YY')
    ELSE to_char((at AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 year', 'YYYY') || '-' ||
         to_char(at AT TIME ZONE 'Asia/Kolkata', 'YY')
  END;
$$;

CREATE OR REPLACE FUNCTION next_invoice_number(prefix text DEFAULT 'AH')
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  seq_value bigint;
BEGIN
  -- nextval is atomic and never returns the same value twice, even to
  -- concurrent transactions, and it is NOT rolled back — which is precisely
  -- the property that makes duplicates impossible.
  seq_value := nextval('invoice_number_seq');

  RETURN prefix || '/' || indian_financial_year(now()) || '/' ||
         lpad(seq_value::text, 6, '0');
END;
$$;


-- ############################################################################
-- SECTION 4 — AN ISSUED INVOICE'S MONEY IS IMMUTABLE
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   Once an invoice has been issued to a customer, they hold a copy. Changing
--   the amounts on our side then produces two documents with the same number
--   and different totals — which is indistinguishable, after the fact, from
--   fraud. Under GST rules a revision is a CREDIT NOTE or a fresh invoice,
--   never an edit.
--
--   A draft invoice is a different thing entirely and remains fully editable.
--
-- WHAT MAY STILL CHANGE ON AN ISSUED INVOICE:
--   status, amount_paid_minor, paid_at, voided_at, hosted_invoice_url,
--   notes, metadata, updated_at.
--   Payment arriving is not a change to the bill; it is a change to its state.
--
-- WHAT MAY NOT:
--   Every amount column, the invoice number, the tenant, the tax identity.

CREATE OR REPLACE FUNCTION prevent_issued_invoice_amendment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Drafts are working documents.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    RAISE EXCEPTION
      'Invoice number cannot be changed once issued (invoice %).', OLD.invoice_number
      USING ERRCODE = '42501';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'An issued invoice cannot be moved to another tenant (invoice %).', OLD.invoice_number
      USING ERRCODE = '42501';
  END IF;

  IF NEW.subtotal_minor  IS DISTINCT FROM OLD.subtotal_minor
     OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
     OR NEW.cgst_minor     IS DISTINCT FROM OLD.cgst_minor
     OR NEW.sgst_minor     IS DISTINCT FROM OLD.sgst_minor
     OR NEW.igst_minor     IS DISTINCT FROM OLD.igst_minor
     OR NEW.total_minor    IS DISTINCT FROM OLD.total_minor
     OR NEW.currency       IS DISTINCT FROM OLD.currency
  THEN
    RAISE EXCEPTION
      'Invoice % has been issued. Amounts are fixed — raise a credit note or a new invoice.',
      OLD.invoice_number
      USING ERRCODE = '42501';
  END IF;

  IF NEW.customer_gstin IS DISTINCT FROM OLD.customer_gstin
     OR NEW.place_of_supply_code IS DISTINCT FROM OLD.place_of_supply_code
  THEN
    RAISE EXCEPTION
      'Tax identity on issued invoice % is fixed at the moment of issue.',
      OLD.invoice_number
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_issued_immutable ON invoices;
CREATE TRIGGER invoices_issued_immutable
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION prevent_issued_invoice_amendment();


-- ---------------------------------------------------------------------------
-- Lines of an issued invoice cannot be added, changed or removed.
--
-- Without this, the trigger above is trivially bypassed: leave the header
-- totals alone and rewrite the line items. The customer's copy and ours would
-- then agree on the total and disagree on what was bought.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_issued_invoice_line_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  parent_id uuid;
BEGIN
  parent_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT status INTO parent_status FROM invoices WHERE id = parent_id;

  -- Parent already gone (cascade delete of a draft) — nothing to protect.
  IF parent_status IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION
      'Invoice % has been issued; its line items are fixed.', parent_id
      USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS invoice_lines_issued_immutable ON invoice_lines;
CREATE TRIGGER invoice_lines_issued_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_issued_invoice_line_change();


-- ############################################################################
-- SECTION 5 — THE ONE-LIVE-SUBSCRIPTION GUARANTEE
-- ############################################################################
--
-- Drizzle creates the partial unique index. This section documents WHY it is
-- load-bearing and asserts that it exists, because an index silently dropped
-- by `drizzle-kit push` would remove a double-billing guarantee with no
-- symptom whatsoever until an invoice run.
--
-- THE SCENARIO IT PREVENTS:
--   An upgrade creates a new subscription. The old one's cancellation fails,
--   or the webhook confirming it never arrives. The tenant now has two live
--   subscriptions, and next month both renew. The customer is charged twice,
--   notices, and asks why — and the honest answer is "our code has a race".
--
-- With the index, the second INSERT fails immediately and the upgrade is
-- rejected. A failed upgrade is an annoyance; a double charge is a refund and
-- a lost customer.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'subscriptions'
      AND indexname = 'subscriptions_one_live_per_tenant'
  ) THEN
    RAISE EXCEPTION
      'The partial unique index subscriptions_one_live_per_tenant is MISSING. '
      'Without it a tenant can hold two live subscriptions and be billed twice. '
      'Re-run `npm run db:push` before continuing.';
  END IF;
END
$$;


-- ---------------------------------------------------------------------------
-- A subscription's tenant is fixed for life.
--
-- Moving a subscription between tenants would move its entire billing history
-- with it — invoices, payment events, the lot — and leave the original
-- tenant's records referring to something that is no longer theirs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_subscription_tenant_move()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'A subscription cannot be reassigned to a different tenant.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_tenant_fixed ON subscriptions;
CREATE TRIGGER subscriptions_tenant_fixed
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION prevent_subscription_tenant_move();


-- ############################################################################
-- SECTION 6 — GRANTS
-- ############################################################################
--
-- The application role reads and writes tenant billing data, subject to the
-- policies above. It may READ the plan catalogue and may NOT write it —
-- a tenant altering the price of their own plan is the most obvious attack
-- on a billing system, and no RLS policy is needed to stop it if the GRANT
-- never existed.
--
-- Replace `ordence_app` with the role your application actually connects as.
-- On Neon this is usually the database owner; on a hardened deployment it
-- should be a dedicated non-owner role, which is what makes FORCE meaningful.

-- ---------------------------------------------------------------------------
-- ⚠️ REVOKE FIRST. THIS IS NOT DEFENSIVE PADDING.
-- ---------------------------------------------------------------------------
-- A GRANT block that only ever ADDS privileges is worthless as a restriction.
-- If anyone has ever run `GRANT ALL ON ALL TABLES IN SCHEMA public TO
-- ordence_app` — which is the first thing most people do when a query fails
-- with "permission denied", and which several hosting providers' setup
-- guides recommend outright — then the application role already holds UPDATE
-- on `plans` and DELETE on `payment_events`, and every GRANT below is a
-- no-op that changes nothing.
--
-- The restriction is only real if it is stated as a restriction. So the two
-- tables whose privileges are load-bearing are revoked to nothing first and
-- then granted exactly what they need.
--
-- Found while building a fresh test database for this phase: the baseline
-- grant had to be applied for the earlier phases' tests to run at all, which
-- is precisely the situation that would have silently defeated this section.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON plans          FROM ordence_app;
    REVOKE ALL ON payment_events FROM ordence_app;
    REVOKE ALL ON subscriptions  FROM ordence_app;
    REVOKE ALL ON invoices       FROM ordence_app;

    GRANT SELECT ON plans TO ordence_app;

    -- NO DELETE on either. Both are financial history and are SOFT-deleted
    -- (`deleted_at`), so the privilege has no legitimate use — while a hard
    -- DELETE of a subscription would orphan every invoice that references
    -- it, and a hard DELETE of an invoice would remove a document a
    -- customer is holding a copy of.
    GRANT SELECT, INSERT, UPDATE ON subscriptions   TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON invoices        TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_lines TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment_methods TO ordence_app;

    -- INSERT and SELECT only. No UPDATE, no DELETE — belt and braces
    -- alongside the trigger in Section 2. If the trigger were ever dropped,
    -- this still refuses.
    GRANT SELECT, INSERT ON payment_events TO ordence_app;

    GRANT USAGE ON SEQUENCE invoice_number_seq TO ordence_app;
  END IF;
END
$$;





-- ############################################################################
-- SECTION 15 — PHASE 19: TELEMETRY
-- ############################################################################
--
-- `error_events` and `web_vital_events`, plus the `telemetry_daily` rollup view.
--
-- Two things here are load-bearing and easy to lose:
--   * The view MUST carry `security_invoker = true`. A view without it runs as
--     its OWNER, so `telemetry_daily` would hand every tenant's error volume
--     and performance profile to every other tenant — with no error and no
--     visible symptom. Same failure mode as the Phase 10 analytics views.
--   * Telemetry rows may carry a NULL tenant, because Core Web Vitals fire
--     before a session exists. The policy admits NULL rows only when there is
--     NO tenant context — i.e. from the platform-scoped connection. A tenant
--     session sees its own rows and never an anonymous one.
-- ############################################################################

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

-- ---------------------------------------------------------------------------
-- BOTH TABLES CARRY THE `payment_events` NULL ALLOWANCE
-- ---------------------------------------------------------------------------
-- Every ordinary tenant-scoped table in this platform has a NOT NULL tenant_id
-- and a policy that is a plain equality. These two are different, for the same
-- structural reason `payment_events` is different, and the difference is worth
-- stating precisely because it looks like a hole.
--
-- A telemetry event can arrive with NO resolvable tenant, and not rarely:
--
--   • Web Vitals fire on the sign-in page and the marketing shell, where
--     there is no session at all.
--   • They fire during the first paint of an authenticated page, before the
--     session has resolved.
--   • A crash in the auth bootstrap has no tenant BY DEFINITION — and that is
--     the single most important error this system could ever record.
--
-- Refusing those events would mean the platform stops reporting precisely when
-- it is most broken. So they are recorded with tenant_id IS NULL, and the
-- policy permits READING them only when NO tenant context is set — i.e. from
-- the platform-scoped connection used by super-admin tooling.
--
--   tenant session (context = A)  ->  rows where tenant_id = A
--   platform scope (context NULL) ->  rows where tenant_id IS NULL
--
-- Note what this does NOT do: it does not let a tenant see another tenant's
-- events, and it does not let a tenant see the unattributed ones. The ingest
-- endpoint is public, so an anonymous POST can create a NULL row — and that
-- row is unreachable from every tenant session by this policy. Verified in
-- Section 6 and in tests/security/telemetry-isolation.test.ts.
--
-- WITH CHECK mirrors USING on both. A USING-only policy filters reads and
-- happily permits INSERTing a row attributed to somebody else — a write-side
-- leak that looks correct in every read-path test.
-- ---------------------------------------------------------------------------

ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS error_events_tenant_isolation ON error_events;
CREATE POLICY error_events_tenant_isolation ON error_events
  USING (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_is_platform_scope())
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_is_platform_scope())
  );


ALTER TABLE web_vital_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_vital_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS web_vital_events_tenant_isolation ON web_vital_events;
CREATE POLICY web_vital_events_tenant_isolation ON web_vital_events
  USING (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_is_platform_scope())
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_is_platform_scope())
  );


-- ############################################################################
-- SECTION 2 — error_events IS APPEND-ONLY
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   An error report is only worth anything if it is the same tomorrow as it
--   was today. The moment a row can be UPDATEd, "we fixed it" and "somebody
--   edited the evidence" become indistinguishable — and a support conversation
--   that turns on "your system logged this at 14:02" needs the log to be
--   something you can point at, not something you have to vouch for.
--
--   DELETE is blocked by the same trigger, with one deliberate exception: the
--   retention sweep in Section 4 needs to remove old rows, and it does so by
--   setting a session flag the trigger honours. That is a narrow, greppable,
--   explicitly-named escape hatch rather than a hole — an ordinary DELETE,
--   including one an application bug issues, still raises.
--
-- `web_vital_events` is NOT append-only. It is a measurement, not evidence;
-- it is the highest-volume table in the platform; and it is the one that most
-- needs cheap bulk deletion. Nothing about a p75 is disputable later.

CREATE OR REPLACE FUNCTION error_events_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The retention sweep sets this flag transaction-locally before deleting.
  -- `current_setting(..., true)` returns NULL rather than raising when the
  -- setting has never been defined, which is the normal case for every other
  -- statement in the system.
  IF TG_OP = 'DELETE'
     AND COALESCE(current_setting('app.telemetry_retention_sweep', true), '') = 'on'
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'error_events is append-only. % is not permitted on error evidence. '
    'Retention removal must run through telemetry_retention_sweep().',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS error_events_no_update ON error_events;
CREATE TRIGGER error_events_no_update
  BEFORE UPDATE ON error_events
  FOR EACH ROW EXECUTE FUNCTION error_events_block_mutation();

DROP TRIGGER IF EXISTS error_events_no_delete ON error_events;
CREATE TRIGGER error_events_no_delete
  BEFORE DELETE ON error_events
  FOR EACH ROW EXECUTE FUNCTION error_events_block_mutation();


-- ############################################################################
-- SECTION 3 — THE `telemetry_daily` HEALTH VIEW
-- ############################################################################
--
-- Per-tenant, per-day health signal: how many errors, how many were fatal,
-- how many DISTINCT bugs, and the p75 of each Core Web Vital.
--
-- ⚠️ `security_invoker = true` IS THE MOST IMPORTANT TOKEN IN THIS SECTION.
--
-- A view is executed with the privileges of its OWNER unless told otherwise.
-- The owner here is the role that ran this migration, which owns the tables
-- and therefore satisfies their policies trivially. Without this option, every
-- tenant querying `telemetry_daily` would receive AGGREGATES OVER EVERY
-- TENANT'S ROWS — a cross-platform data leak wearing the costume of a
-- dashboard, and one that no read-path test on the base tables would catch.
--
-- With it, the view is evaluated under the CALLER's context, so the same RLS
-- policies from Section 1 apply. Requires PostgreSQL 15+.
--
-- WHY p75 AND NOT AN AVERAGE: an average page load is dominated by the fast
-- majority and hides the tail entirely. Google's own Core Web Vitals
-- assessment is defined at the 75th percentile precisely because that is the
-- number that corresponds to "most of my users are having a bad time".
--
-- WHY A PLAIN VIEW AND NOT MATERIALIZED: a materialised view needs a refresh
-- job, and a stale health dashboard that looks live is worse than a slow one.
-- If this stops being fast enough, the answer is a real rollup TABLE written
-- by the retention sweep — noted as future work, not built speculatively.

DROP VIEW IF EXISTS telemetry_daily;

CREATE VIEW telemetry_daily
WITH (security_invoker = true) AS
WITH errors AS (
  SELECT
    tenant_id,
    date_trunc('day', captured_at)                                  AS day,
    count(*)                                                        AS error_count,
    count(*) FILTER (WHERE severity = 'fatal')                      AS fatal_count,
    count(DISTINCT fingerprint)                                     AS distinct_bugs,
    -- Which bug dominated the day. `mode()` rather than a window function
    -- because it stays correct when two fingerprints tie (it picks one
    -- deterministically) and it is a single pass.
    mode() WITHIN GROUP (ORDER BY fingerprint)                      AS top_fingerprint
  FROM error_events
  GROUP BY 1, 2
),
vitals AS (
  SELECT
    tenant_id,
    date_trunc('day', captured_at)                                  AS day,
    count(*)                                                        AS vital_samples,
    -- percentile_cont interpolates, which is what you want for a latency
    -- percentile; percentile_disc would snap to an observed value and make
    -- small samples jump between measurements.
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value)
      FILTER (WHERE metric = 'LCP')                                 AS p75_lcp,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value)
      FILTER (WHERE metric = 'INP')                                 AS p75_inp,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value)
      FILTER (WHERE metric = 'CLS')                                 AS p75_cls,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY value)
      FILTER (WHERE metric = 'TTFB')                                AS p75_ttfb,
    count(*) FILTER (WHERE rating = 'poor')                         AS poor_samples
  FROM web_vital_events
  GROUP BY 1, 2
)
-- FULL OUTER JOIN, not INNER: a day with errors but no vitals (a server-side
-- outage on a page nobody loaded successfully) and a day with vitals but no
-- errors are both real and both must appear. An inner join would silently drop
-- the outage day, which is the one anybody is looking for.
SELECT
  COALESCE(e.tenant_id, v.tenant_id)      AS tenant_id,
  COALESCE(e.day, v.day)                  AS day,
  COALESCE(e.error_count, 0)              AS error_count,
  COALESCE(e.fatal_count, 0)              AS fatal_count,
  COALESCE(e.distinct_bugs, 0)            AS distinct_bugs,
  e.top_fingerprint                       AS top_fingerprint,
  COALESCE(v.vital_samples, 0)            AS vital_samples,
  v.p75_lcp,
  v.p75_inp,
  v.p75_cls,
  v.p75_ttfb,
  COALESCE(v.poor_samples, 0)             AS poor_vital_samples
FROM errors e
FULL OUTER JOIN vitals v
  ON  e.day = v.day
  -- `IS NOT DISTINCT FROM` rather than `=`, because tenant_id is NULLABLE
  -- here and `NULL = NULL` is NULL, not true. With a plain `=` every
  -- unattributed day would appear TWICE — once from each side of the join —
  -- with half its columns empty, and the platform-scope dashboard would show
  -- double-counted rows that look like a data corruption bug.
  AND e.tenant_id IS NOT DISTINCT FROM v.tenant_id;

COMMENT ON VIEW telemetry_daily IS
  'Per-tenant daily health rollup. security_invoker=true — RLS applies to the '
  'CALLER, not the view owner. Do not recreate this view without that option.';


-- ############################################################################
-- SECTION 4 — RETENTION
-- ############################################################################
--
-- ⚠️ NOTHING BELOW IS SCHEDULED. READ THIS BEFORE ASSUMING RETENTION WORKS.
--
-- Diagnostics kept forever are diagnostics that eventually become a disclosure
-- question, even when scrubbed — an error message that survived the scrubber
-- with a customer's name in it is a personal-data record under the DPDP Act,
-- and "we did not know it was there" is not a defence for keeping it for five
-- years. Retention is a real obligation, not housekeeping.
--
-- The function is defined here and the indexes exist to make it a cheap ranged
-- delete. What does NOT exist is anything that CALLS it: this platform has no
-- scheduler in place (no pg_cron on Neon by default, no Vercel Cron entry for
-- it), and adding one touches files owned by another workstream this phase.
-- Written up as required follow-up in docs/PHASE-19-NOTES.md.
--
-- Until it is scheduled, retention is a MANUAL operation. Say so out loud
-- rather than letting a defined-but-uncalled function imply otherwise.

CREATE OR REPLACE FUNCTION telemetry_retention_sweep(p_days integer DEFAULT 90)
RETURNS TABLE (deleted_errors bigint, deleted_vitals bigint)
LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamptz;
  n_errors bigint;
  n_vitals bigint;
BEGIN
  IF p_days < 7 THEN
    -- A sweep with a tiny window is almost always a typo (`7` meant as days
    -- typed as `0`), and it destroys the data you were about to investigate.
    RAISE EXCEPTION 'telemetry_retention_sweep: refusing a retention window under 7 days (got %)', p_days;
  END IF;

  cutoff := now() - make_interval(days => p_days);

  -- Transaction-local, so the append-only trigger's exception is back in force
  -- the moment this function's transaction ends. `true` is what makes it
  -- local; `false` would set it for the whole pooled CONNECTION and leave the
  -- next request on that connection able to delete error evidence at will.
  PERFORM set_config('app.telemetry_retention_sweep', 'on', true);

  DELETE FROM error_events WHERE captured_at < cutoff;
  GET DIAGNOSTICS n_errors = ROW_COUNT;

  DELETE FROM web_vital_events WHERE captured_at < cutoff;
  GET DIAGNOSTICS n_vitals = ROW_COUNT;

  PERFORM set_config('app.telemetry_retention_sweep', 'off', true);

  deleted_errors := n_errors;
  deleted_vitals := n_vitals;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION telemetry_retention_sweep(integer) IS
  'Manual retention sweep. NOT scheduled — see SQL-FILES/0011 Section 4.';


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
-- "permission denied" — then the application role already holds UPDATE and
-- DELETE on `error_events`, and every GRANT below is a no-op.
--
-- The restriction is only real if it is stated as a restriction.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON error_events     FROM ordence_app;
    REVOKE ALL ON web_vital_events FROM ordence_app;

    -- INSERT and SELECT only. No UPDATE, no DELETE — belt and braces
    -- alongside the trigger in Section 2. If the trigger were ever dropped,
    -- this still refuses.
    GRANT SELECT, INSERT ON error_events TO ordence_app;

    -- Vitals are measurements, not evidence, so DELETE is permitted — it is
    -- how a retention sweep run by the application role would work. Still no
    -- UPDATE: there is no legitimate reason to alter a recorded measurement,
    -- and permitting it would let a bad deploy quietly rewrite its own p75.
    GRANT SELECT, INSERT, DELETE ON web_vital_events TO ordence_app;

    GRANT SELECT ON telemetry_daily TO ordence_app;
  END IF;
END
$$;




-- ############################################################################
-- SECTION 16 — PHASE 20: SECURITY OPERATIONS
-- ############################################################################
--
-- `security_events` — the structured stream of things that are NOT user
-- actions: rate-limit trips, forged webhook signatures, garbage portal tokens,
-- inferred anomalies.
--
-- Deliberately a SEPARATE table from `audit_logs` and `permission_denials`:
--   audit_logs         — what an authenticated principal DID
--   permission_denials — what a KNOWN principal was REFUSED
--   security_events    — everything that is not a user action at all
--
-- A scraper produces ten thousand limiter trips a minute. Merging those into
-- `audit_logs` would bury the dozen rows a year that have to be defensible in
-- a dispute, and the two have completely different retention lives.
--
-- Append-only, for the same reason as payment evidence: a record of a security
-- incident that can be edited is a record that proves nothing.
-- ############################################################################

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
    OR (tenant_id IS NULL AND app_is_platform_scope())
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_is_platform_scope())
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
-- SECTION 17 — PHASE 15: USAGE METERING
-- ############################################################################
--
-- `usage_counters` (monotonic per-period buckets) and `usage_levels`
-- (current storage, which goes down as well as up).
--
-- Counters are MONOTONIC but NOT append-only, which is a deliberate and
-- unusual combination: an increment is an UPDATE, and a DECREASE is refused
-- by trigger. A meter that can be wound backwards is a meter you cannot bill
-- from. Levels are exempt, because deleting a file must genuinely free space.
-- ############################################################################

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
--
-- ---------------------------------------------------------------------------
-- NOTE THE ABSENCE OF A NULL ALLOWANCE
-- ---------------------------------------------------------------------------
-- `payment_events` (Phase 11), `error_events` (Phase 19) and `security_events`
-- (Phase 20) all carry a NULLABLE tenant_id, because each of them records
-- things that happen before a tenant is known — an unmappable webhook, a Web
-- Vital fired pre-session, a forged HMAC.
--
-- Usage is not like that. There is no such thing as an email sent by nobody or
-- a byte stored by no one; if we cannot attribute a unit of usage to a tenant,
-- we cannot bill it and we must not invent a row for it. So `tenant_id` is
-- NOT NULL on both tables and both policies are a plain equality — which is
-- also the strictest form, and the one that needs no commentary to be read
-- correctly six months from now.
-- ---------------------------------------------------------------------------

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_counters_tenant_isolation ON usage_counters;
CREATE POLICY usage_counters_tenant_isolation ON usage_counters
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


ALTER TABLE usage_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_levels FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_levels_tenant_isolation ON usage_levels;
CREATE POLICY usage_levels_tenant_isolation ON usage_levels
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 2 — usage_counters IS MONOTONIC, AND ITS IDENTITY IS FIXED
-- ############################################################################
--
-- WHY THIS TABLE IS NOT APPEND-ONLY LIKE THE OTHER EVIDENCE TABLES
--
--   `audit_logs`, `payment_events`, `contract_signatures` and
--   `security_events` all refuse UPDATE outright. This one cannot: the whole
--   concurrency design is
--
--       INSERT ... ON CONFLICT DO UPDATE SET value = value + excluded.value
--
--   which IS an UPDATE. Refusing it would force one row per metered
--   occurrence — an event table — and a row per API call is a cost we
--   deliberately declined to pay (see db/schema/metering.ts).
--
--   So the guarantee is narrowed to the one that still has teeth:
--
--       ⭐ A COUNTER MAY GO UP. IT MAY NEVER GO DOWN, AND IT MAY NEVER BE
--         MOVED TO ANOTHER TENANT, METRIC OR PERIOD.
--
-- THE HOLE THIS CLOSES:
--   The only reasons to lower a cumulative counter are to under-bill, to hide
--   usage from a customer who is about to be charged for it, or to paper over
--   a bug. The realistic version is the third: an engineer "fixing" a
--   double-counted month with an UPDATE rather than investigating why it
--   double-counted. The evidence of the bug disappears along with the symptom.
--
--   Moving a bucket's period is the same class of problem wearing a different
--   hat — it silently relocates usage onto a different invoice.
--
--   SQLSTATE 42501 is raised deliberately, so the application (and the test
--   suite) can distinguish this from an ordinary constraint failure.

CREATE OR REPLACE FUNCTION prevent_usage_counter_regression()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.value < OLD.value THEN
    RAISE EXCEPTION
      'usage_counters.value cannot decrease (% -> % for metric % on tenant %). '
      'A cumulative counter only goes up. Record a correcting adjustment in the '
      'current period instead of editing a closed one.',
      OLD.value, NEW.value, OLD.metric, OLD.tenant_id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.tenant_id    IS DISTINCT FROM OLD.tenant_id
     OR NEW.metric       IS DISTINCT FROM OLD.metric
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end   IS DISTINCT FROM OLD.period_end
  THEN
    RAISE EXCEPTION
      'A usage bucket cannot be re-identified. tenant_id, metric and the period '
      'are fixed at creation — moving them relocates usage onto a different '
      'invoice.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usage_counters_monotonic ON usage_counters;
CREATE TRIGGER usage_counters_monotonic
  BEFORE UPDATE ON usage_counters
  FOR EACH ROW EXECUTE FUNCTION prevent_usage_counter_regression();


-- ############################################################################
-- SECTION 3 — usage_levels: IDENTITY FIXED, FLOOR ENFORCED
-- ############################################################################
--
-- A level DOES go down — that is the entire point of it being a level, and it
-- is what stops a customer who has spent an afternoon deleting old files from
-- still being told they are full. So there is no monotonicity guard here, and
-- adding one "for consistency" would break the phase's central requirement.
--
-- What IS guarded:
--
--   • The row's identity. A level row moved between tenants would transfer a
--     storage reading — and with it a quota — to somebody else.
--
--   • The floor. `usage_levels_current_non_negative` (a CHECK created by
--     Drizzle) refuses a negative reading. The application clamps with
--     GREATEST(0, ...) on every decrement, so the constraint should never
--     fire; it exists for the NEXT call site, written by someone who did not
--     read this file. A tenant whose storage reads -2 GB has an allowance
--     2 GB larger than the one they paid for, and nothing anywhere reports it.

CREATE OR REPLACE FUNCTION prevent_usage_level_reidentification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.metric IS DISTINCT FROM OLD.metric
  THEN
    RAISE EXCEPTION
      'A usage level cannot be reassigned to a different tenant or metric.'
      USING ERRCODE = '42501';
  END IF;

  -- The peak is a high-water mark for the period. Lowering it below the
  -- current reading would understate what was actually stored, which is the
  -- figure Phase 16 may bill on.
  IF NEW.peak_value < NEW.current_value THEN
    RAISE EXCEPTION
      'usage_levels.peak_value (%) cannot be below current_value (%).',
      NEW.peak_value, NEW.current_value
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usage_levels_identity_fixed ON usage_levels;
CREATE TRIGGER usage_levels_identity_fixed
  BEFORE UPDATE ON usage_levels
  FOR EACH ROW EXECUTE FUNCTION prevent_usage_level_reidentification();


-- ############################################################################
-- SECTION 4 — THE ATOMICITY GUARANTEE
-- ############################################################################
--
-- ⭐ THIS SECTION IS THE MOST IMPORTANT ONE IN THE FILE.
--
-- Every increment in this phase is a single statement:
--
--   INSERT INTO usage_counters (...) VALUES (...)
--   ON CONFLICT (tenant_id, metric, period_start) DO UPDATE
--     SET value = usage_counters.value + excluded.value;
--
-- That statement is atomic ONLY BECAUSE the unique index named below exists.
-- It is the arbiter the ON CONFLICT clause names. Without it:
--
--   • PostgreSQL raises 42P10 ("no unique or exclusion constraint matching the
--     ON CONFLICT specification") — inside a recorder that SWALLOWS ITS OWN
--     ERRORS by design. Every increment fails, nothing is logged to the user,
--     no request breaks, and usage silently reads zero forever.
--
-- The index is created by Drizzle. It is asserted here because `drizzle-kit
-- push` treats anything it does not recognise as drift and drops it, and this
-- particular loss has no symptom whatsoever until an invoice run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'usage_counters'
      AND indexname = 'usage_counters_tenant_metric_period_unique'
  ) THEN
    RAISE EXCEPTION
      'usage_counters_tenant_metric_period_unique is MISSING. Without it the '
      'ON CONFLICT upsert has no arbiter, every increment raises 42P10 inside a '
      'best-effort recorder, and ALL USAGE SILENTLY READS ZERO. '
      'Re-run `npm run db:push` before continuing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'usage_levels'
      AND indexname = 'usage_levels_tenant_metric_unique'
  ) THEN
    RAISE EXCEPTION
      'usage_levels_tenant_metric_unique is MISSING. Without it every storage '
      'adjustment INSERTs a second row for the same tenant, and the reported '
      'level stops tracking reality. Re-run `npm run db:push`.';
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — RETENTION, UNDER A DIFFERENT CREDENTIAL
-- ############################################################################
--
-- Old buckets are evidence for a bill that has already been paid, so they are
-- kept for years, not months — an overage dispute can arrive long after the
-- invoice. But they are not kept forever, and the pruning is deliberately NOT
-- available to the application role.
--
-- Same reasoning as `prune_security_events()` in Phase 20: deleting billing
-- history should require a different credential from the one the web
-- application holds. The application has no DELETE on either table (Section 6),
-- so this function is the only path, and it is granted to nobody by default.
--
-- 25 months is the default: two full years plus a month, so a
-- year-on-year comparison and a GST assessment window both still work.

CREATE OR REPLACE FUNCTION prune_usage_counters(older_than interval DEFAULT '25 months')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM usage_counters
   WHERE period_end < now() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;

  RAISE NOTICE 'prune_usage_counters: removed % closed buckets older than %',
    removed, older_than;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION prune_usage_counters(interval) FROM PUBLIC;


-- ############################################################################
-- SECTION 6 — GRANTS
-- ############################################################################
--
-- ---------------------------------------------------------------------------
-- ⚠️ REVOKE FIRST. THIS IS NOT DEFENSIVE PADDING.
-- ---------------------------------------------------------------------------
-- A GRANT block that only ever ADDS privileges is worthless as a restriction.
-- If anyone has ever run `GRANT ALL ON ALL TABLES IN SCHEMA public TO
-- ordence_app` — which is the first thing most people do when a query fails with
-- "permission denied", and which several hosting providers' guides recommend
-- outright — then the application role already holds DELETE on both tables and
-- every GRANT below is a no-op.
--
-- WHY NO DELETE, ON EITHER TABLE:
--
--   usage_counters — a deleted bucket is usage that was consumed and will
--     never be billed. It is also the only record of what a customer used in
--     a month they may later dispute. Deletion is retention (Section 5), under
--     a different credential.
--
--   usage_levels — deleting a level row resets a tenant's stored bytes to
--     zero. That is not a cleanup, it is a free storage upgrade, available to
--     any code path that can issue a DELETE. Tenant teardown is handled by
--     ON DELETE CASCADE from `tenants`, which needs no privilege here.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON usage_counters FROM ordence_app;
    REVOKE ALL ON usage_levels   FROM ordence_app;

    -- SELECT, INSERT and UPDATE only. UPDATE is required — it is the second
    -- half of every ON CONFLICT DO UPDATE — and is constrained by the
    -- monotonic trigger in Section 2 rather than by withholding the privilege.
    GRANT SELECT, INSERT, UPDATE ON usage_counters TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON usage_levels   TO ordence_app;

    -- Explicitly NOT granted: EXECUTE on prune_usage_counters().
  END IF;
END
$$;





-- ############################################################################
-- SECTION 18 — PHASES 17/18: PLATFORM ADMINISTRATION
-- ############################################################################
--
-- ⚠️ THE MOST DANGEROUS SURFACE IN THE PRODUCT. Every other subsystem exists
-- to make cross-tenant access impossible; this one deliberately crosses that
-- boundary, under audit, for our own support staff.
--
-- `platform_impersonation_sessions` is append-only evidence: if a support
-- engineer acted inside a customer's workspace, the record of when, why and
-- under whose consent must be something you can point at rather than
-- something you have to vouch for.
--
-- The DELETE guard installed here is armed across the customer-content tables
-- so that an impersonated session physically cannot destroy anything, whatever
-- the application layer believes.
-- ############################################################################

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- THE IMPERSONATION CONTEXT ACCESSOR
-- ---------------------------------------------------------------------------
-- Mirrors `app_current_tenant_id()` exactly, including the fail-closed NULL:
-- an unset or empty setting reads as NULL, which every guard below treats as
-- "nobody is impersonating".
--
-- ⚠️ IT IS NOT SET BY ANYTHING YET. `withTenant()` in db/index.ts pins the
-- tenant id and nothing else, and this phase does not own that file. Until
-- INTEGRATION step 2 in docs/PHASE-17-18-NOTES.md is applied, the guard in
-- Section 5 is armed but never fires. That is stated here rather than left
-- for someone to discover from a test that passes for the wrong reason.
CREATE OR REPLACE FUNCTION app_current_impersonation_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.impersonation_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on for ordinary roles.
-- FORCE additionally applies them to the table OWNER, which is usually the
-- role the application connects as. Without FORCE the isolation is decorative.
--
-- ---------------------------------------------------------------------------
-- THREE POLICY SHAPES, AND THE REASON EACH ONE IS DIFFERENT
-- ---------------------------------------------------------------------------
-- Most tables in this platform share one policy shape. These do not, and the
-- differences are the design rather than an inconsistency:
--
--   SHAPE A — PLATFORM ONLY          (platform_staff, platform_action_log)
--     USING / WITH CHECK: app_current_tenant_id() IS NULL
--     A tenant session ALWAYS has a tenant id pinned, so it matches nothing.
--     Not "sees fewer rows" — sees zero, and can write none.
--
--   SHAPE B — PLATFORM WRITES, TENANT READS   (platform_tenant_flags,
--                                              platform_impersonation_sessions)
--     USING:      tenant_id = app_current_tenant_id() OR context IS NULL
--     WITH CHECK: app_current_tenant_id() IS NULL
--     The customer can SEE their own flags (the app must, to render) and can
--     SEE who entered their workspace (transparency they are entitled to),
--     and can write neither. The asymmetry is deliberate and is the whole
--     point of the shape.
--
--   SHAPE C — TENANT WRITES, PLATFORM READS   (tenant_support_consents)
--     USING:      tenant_id = app_current_tenant_id() OR context IS NULL
--     WITH CHECK: tenant_id = app_current_tenant_id()
--     ⭐ THE MOST IMPORTANT POLICY IN THIS FILE. The platform-scoped
--     connection (context NULL) can read consent and CANNOT INSERT IT. So
--     "the customer consented" is a statement only the customer's own
--     session is capable of making. Consent we could write ourselves would
--     not be consent, and no amount of application code could fix that.
-- ---------------------------------------------------------------------------

-- ---- SHAPE A: platform_staff ---------------------------------------------
ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_staff FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_staff_platform_only ON platform_staff;
CREATE POLICY platform_staff_platform_only ON platform_staff
  USING      (app_current_tenant_id() IS NULL)
  WITH CHECK (app_current_tenant_id() IS NULL);


-- ---- SHAPE A: platform_action_log ----------------------------------------
ALTER TABLE platform_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_action_log FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_action_log_platform_only ON platform_action_log;
CREATE POLICY platform_action_log_platform_only ON platform_action_log
  USING      (app_current_tenant_id() IS NULL)
  WITH CHECK (app_current_tenant_id() IS NULL);


-- ---- SHAPE B: platform_impersonation_sessions ----------------------------
--
-- A customer being able to read the record of every time we entered their
-- workspace — who, when, under what authority, with what written reason — is
-- not a concession. It is the single most persuasive answer to the question
-- every enterprise security review asks, and it costs one OR clause.
ALTER TABLE platform_impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_impersonation_sessions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impersonation_sessions_visibility ON platform_impersonation_sessions;
CREATE POLICY impersonation_sessions_visibility ON platform_impersonation_sessions
  USING (
    app_current_tenant_id() IS NULL
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (app_current_tenant_id() IS NULL);


-- ---- SHAPE B: platform_tenant_flags --------------------------------------
ALTER TABLE platform_tenant_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_tenant_flags FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_tenant_flags_visibility ON platform_tenant_flags;
CREATE POLICY platform_tenant_flags_visibility ON platform_tenant_flags
  USING (
    app_current_tenant_id() IS NULL
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (app_current_tenant_id() IS NULL);


-- ---- SHAPE C: tenant_support_consents ------------------------------------
ALTER TABLE tenant_support_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_support_consents FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_support_consents_visibility ON tenant_support_consents;
CREATE POLICY tenant_support_consents_visibility ON tenant_support_consents
  USING (
    app_current_tenant_id() IS NULL
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 2 — IMPERSONATION EVIDENCE IS WRITE-ONCE
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   The impersonation row is the only durable proof of what happened. If it
--   can be edited, it proves nothing — it only shows what somebody was later
--   willing to say. And the person with the strongest motive to edit it is
--   the operator whose access is being questioned, who by definition has
--   application credentials.
--
--   The specific rewrites this prevents, all of which look innocuous in a
--   diff and all of which destroy the record:
--     • extending `expires_at` so a 15-minute break-glass reads as an hour
--     • rewriting `justification` after the customer complains
--     • changing `mode` from `break_glass` to `standing_consent`
--     • moving `tenant_id` to a workspace where the access was authorised
--     • re-opening a closed session, or closing it with a different reason
--     • deleting the row entirely
--
-- THE FIX — a one-way close, and nothing else:
--   UPDATE is permitted ONLY when `ended_at` was NULL and is being set, and
--   ONLY when every other column is unchanged. `blocked_action_count` and
--   `action_count` are the two exceptions (they are counters the application
--   increments), and `tenant_notified_at` may be set once. DELETE is refused
--   outright.
--
--   This is the same pattern as issued invoices in Phase 11 (Section 4 of
--   0009): freeze the record, allow exactly one forward transition.
--
--   SQLSTATE 42501 is raised deliberately so the application can distinguish
--   this from an ordinary constraint failure.

CREATE OR REPLACE FUNCTION prevent_impersonation_tamper()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'platform_impersonation_sessions is evidence and cannot be deleted. '
      'Session % concerns tenant %.',
      OLD.id, OLD.tenant_id
      USING ERRCODE = '42501';
  END IF;

  -- A closed session is closed forever. Re-opening it, or re-closing it with
  -- a different reason, would let an operator rewrite the duration of their
  -- own access.
  IF OLD.ended_at IS NOT NULL AND (
       NEW.ended_at IS DISTINCT FROM OLD.ended_at
    OR NEW.ended_reason IS DISTINCT FROM OLD.ended_reason
  ) THEN
    RAISE EXCEPTION
      'Impersonation session % is already closed; its end cannot be changed.',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  -- ⭐ THE FROZEN COLUMNS. Everything that answers who, which workspace,
  -- under what authority, and until when.
  IF NEW.id                IS DISTINCT FROM OLD.id
  OR NEW.tenant_id         IS DISTINCT FROM OLD.tenant_id
  OR NEW.tenant_slug       IS DISTINCT FROM OLD.tenant_slug
  OR NEW.staff_id          IS DISTINCT FROM OLD.staff_id
  OR NEW.actor_clerk_id    IS DISTINCT FROM OLD.actor_clerk_id
  OR NEW.actor_email       IS DISTINCT FROM OLD.actor_email
  OR NEW.mode              IS DISTINCT FROM OLD.mode
  OR NEW.scope             IS DISTINCT FROM OLD.scope
  OR NEW.consent_id        IS DISTINCT FROM OLD.consent_id
  OR NEW.justification     IS DISTINCT FROM OLD.justification
  OR NEW.subject_user_id   IS DISTINCT FROM OLD.subject_user_id
  OR NEW.started_at        IS DISTINCT FROM OLD.started_at
  OR NEW.expires_at        IS DISTINCT FROM OLD.expires_at
  OR NEW.ip_address        IS DISTINCT FROM OLD.ip_address
  OR NEW.user_agent        IS DISTINCT FROM OLD.user_agent
  OR NEW.created_at        IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Impersonation evidence is immutable. Only ended_at/ended_reason, the '
      'action counters and tenant_notified_at may change on session %.',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  -- The notification stamp is write-once too: "we told the customer" must
  -- not be removable, and re-stamping it would hide a delay.
  IF OLD.tenant_notified_at IS NOT NULL
     AND NEW.tenant_notified_at IS DISTINCT FROM OLD.tenant_notified_at THEN
    RAISE EXCEPTION
      'tenant_notified_at is write-once on session %.', OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS impersonation_no_delete ON platform_impersonation_sessions;
CREATE TRIGGER impersonation_no_delete
  BEFORE DELETE ON platform_impersonation_sessions
  FOR EACH ROW EXECUTE FUNCTION prevent_impersonation_tamper();

DROP TRIGGER IF EXISTS impersonation_freeze ON platform_impersonation_sessions;
CREATE TRIGGER impersonation_freeze
  BEFORE UPDATE ON platform_impersonation_sessions
  FOR EACH ROW EXECUTE FUNCTION prevent_impersonation_tamper();


-- ############################################################################
-- SECTION 3 — THE PLATFORM ACTION LOG IS APPEND-ONLY
-- ############################################################################
--
-- This table records "an operator searched every workspace for an email
-- address" and "an operator was granted access to every customer's data".
-- A DELETE privilege on it is, functionally, an "erase the record of what I
-- looked at" privilege — the same argument as `security_events` in Phase 20,
-- with the aggravating detail that the people with access to this table are
-- the people it is about.
--
-- Corrections are made by INSERTING a correcting row, which is what an
-- append-only log is for.

CREATE OR REPLACE FUNCTION prevent_platform_action_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'platform_action_log is append-only. % is not permitted on the '
    'cross-tenant access log.',
    TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS platform_action_log_no_update ON platform_action_log;
CREATE TRIGGER platform_action_log_no_update
  BEFORE UPDATE ON platform_action_log
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_action_log_mutation();

DROP TRIGGER IF EXISTS platform_action_log_no_delete ON platform_action_log;
CREATE TRIGGER platform_action_log_no_delete
  BEFORE DELETE ON platform_action_log
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_action_log_mutation();


-- ############################################################################
-- SECTION 4 — CONSENT INTEGRITY
-- ############################################################################
--
-- Section 1 already makes it impossible for the platform connection to INSERT
-- a consent row. This section closes the two remaining ways a consent record
-- could be made to say something it did not:
--
--   • back-dating or re-writing a consent after the fact
--   • un-revoking one the customer withdrew
--
-- Note what is NOT forbidden: revoking. A customer must always be able to
-- withdraw consent, instantly, without asking anybody.

CREATE OR REPLACE FUNCTION protect_support_consent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Support consent records are evidence and cannot be deleted. '
      'Revoke instead (set revoked_at).'
      USING ERRCODE = '42501';
  END IF;

  -- Revocation is one-way. A consent the customer withdrew cannot be
  -- silently restored — they would have to grant a new one, which creates a
  -- new row with a new timestamp and a new actor.
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION
      'Support consent % was revoked and cannot be un-revoked.', OLD.id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.tenant_id          IS DISTINCT FROM OLD.tenant_id
  OR NEW.mode               IS DISTINCT FROM OLD.mode
  OR NEW.scope              IS DISTINCT FROM OLD.scope
  OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
  OR NEW.granted_by_email   IS DISTINCT FROM OLD.granted_by_email
  OR NEW.granted_at         IS DISTINCT FROM OLD.granted_at
  OR NEW.expires_at         IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION
      'What was consented to cannot be changed after the fact (consent %). '
      'Grant a new consent instead.', OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS support_consent_no_delete ON tenant_support_consents;
CREATE TRIGGER support_consent_no_delete
  BEFORE DELETE ON tenant_support_consents
  FOR EACH ROW EXECUTE FUNCTION protect_support_consent();

DROP TRIGGER IF EXISTS support_consent_freeze ON tenant_support_consents;
CREATE TRIGGER support_consent_freeze
  BEFORE UPDATE ON tenant_support_consents
  FOR EACH ROW EXECUTE FUNCTION protect_support_consent();


-- ############################################################################
-- SECTION 5 — THE IMPERSONATION DELETE GUARD
-- ############################################################################
--
-- ⭐ THE ONE CONTROL IN THIS PHASE THAT DOES NOT DEPEND ON APPLICATION CODE
-- ---------------------------------------------------------------------------
-- `lib/platform/impersonation-policy.ts` forbids an impersonator from
-- deleting anything, and `assertImpersonationAllows()` enforces it. Both live
-- in TypeScript, and both are only as good as the developer who remembers to
-- call the gate at the top of the next action they write. In eighteen months
-- somebody will not.
--
-- Deletion is the one forbidden operation the customer cannot undo and cannot
-- even detect — a deleted contact leaves no trace in their UI. So it gets a
-- second enforcement point, in the database, that no application refactor can
-- forget:
--
--     if an impersonation context is set, DELETE is refused. Full stop.
--
-- The guard is a NO-OP when nobody is impersonating: `app.impersonation_id`
-- is unset, the accessor returns NULL, and the row deletes normally. The cost
-- is one function call per deleted row on the guarded tables.
--
-- ⚠️ IT IS ARMED BUT NOT YET LOADED. Nothing sets `app.impersonation_id` —
-- `withTenant()` pins only the tenant id, and this phase does not own
-- db/index.ts. INTEGRATION step 2 in docs/PHASE-17-18-NOTES.md is the
-- three-line change that makes this fire. Until then the guard is inert and
-- the TypeScript policy is the only enforcement. Said plainly here because a
-- control everyone believes is live is worse than one everyone knows is not.

CREATE OR REPLACE FUNCTION refuse_delete_under_impersonation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF app_current_impersonation_id() IS NOT NULL THEN
    RAISE EXCEPTION
      'Deletion is not permitted while impersonating a customer (session %). '
      'Support may diagnose; only the customer may destroy their own records.',
      app_current_impersonation_id()
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

-- Applied to the tables holding customer records and money. Written as a loop
-- over a list with a `to_regclass` existence check so this file stays runnable
-- against a database where a later phase's tables do not exist yet.
DO $$
DECLARE
  guarded text;
BEGIN
  FOREACH guarded IN ARRAY ARRAY[
    -- Customer records
    'contacts', 'companies', 'deals', 'custom_object_records',
    'assets', 'documents', 'contracts', 'contract_versions',
    -- Financial history
    'journal_entries', 'transactions', 'ledgers',
    -- Money
    'subscriptions', 'invoices', 'invoice_lines', 'payment_methods',
    -- Access
    'users', 'user_roles', 'roles', 'portal_links'
  ]
  LOOP
    IF to_regclass('public.' || guarded) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %I', 'no_delete_under_impersonation', guarded
      );
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW '
        'EXECUTE FUNCTION refuse_delete_under_impersonation()',
        'no_delete_under_impersonation', guarded
      );
    END IF;
  END LOOP;
END
$$;


-- ############################################################################
-- SECTION 6 — THE PLATFORM READ SCOPE
-- ############################################################################
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ READ THIS SECTION IN FULL. IT DOCUMENTS A PRE-EXISTING BUG AND FIXES IT
--    IN THE ONLY WAY THAT DOES NOT WIDEN THE BLAST RADIUS.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DISCOVERY
-- -------------
-- `withPlatformScope()` in db/index.ts is documented as "the escape hatch for
-- genuine platform-wide operations (super-admin tooling, cross-tenant billing
-- rollups)". It is not one. It runs on the ordinary `db` client with NO tenant
-- context, so `app_current_tenant_id()` returns NULL, and every tenant-scoped
-- policy in this database is a plain equality:
--
--     USING (tenant_id = app_current_tenant_id())
--
-- `tenant_id = NULL` evaluates to NULL, which is not TRUE, so the row is
-- filtered. Verified against PostgreSQL 16 as `ordence_app`, with data present:
--
--     SELECT count(*) FROM tenants;        -> 0
--     SELECT count(*) FROM users;          -> 0
--     SELECT count(*) FROM subscriptions;  -> 0
--
-- It fails CLOSED, which is the right direction and is why nothing has leaked.
-- But it means the escape hatch has never actually opened: any code that
-- relies on it silently sees an empty database. (The `OR (tenant_id IS NULL
-- AND app_current_tenant_id() IS NULL)` clauses on `payment_events` and
-- `security_events` are the exception that proves it — they were added so
-- platform tooling could read ORPHAN rows, and they grant nothing else.)
--
-- THE OBVIOUS FIX, AND WHY IT IS REFUSED
-- --------------------------------------
-- Adding `OR app_current_tenant_id() IS NULL` to the tenant policies would
-- make the console work in one line. It would also mean that ANY connection
-- that forgot to set a tenant context reads EVERY customer's data — turning
-- the single most valuable property in this codebase ("no context means zero
-- rows, never all rows", db/index.ts) into "no context means all rows". One
-- missed `withTenant()` would become a full breach instead of an empty page.
-- REJECTED, absolutely.
--
-- THE FIX APPLIED HERE
-- --------------------
-- An EXPLICIT, POSITIVE, transaction-local marker — `app.platform_scope` —
-- that a caller must deliberately set, exactly as `app.current_tenant_id` is
-- deliberately set. Absence means no access, so the fail-closed default is
-- untouched.
--
-- ⭐ AND — THE PART THAT MATTERS MOST — IT IS GRANTED PER TABLE.
--
-- This is where the data-protection line argued in
-- `lib/platform/search-scopes.ts` stops being a policy and becomes a
-- guarantee. The platform scope is added to the tables holding the
-- COMMERCIAL RELATIONSHIP:
--
--     tenants, users, subscriptions, invoices, documents (metadata)
--
-- and is DELIBERATELY NOT ADDED to the tables holding CUSTOMER CONTENT:
--
--     contacts, companies, deals, custom_object_records, contract_versions,
--     journal_entries, transactions
--
-- So a platform operator — at any grade, through any bug in the TypeScript,
-- with a fully working platform connection — reads ZERO rows from a
-- customer's contact list. Not "is not supposed to". Cannot. Seeing a
-- customer's record requires impersonation, which means a tenant context,
-- which means consent, a banner, an expiry and an audit row.
--
-- Verified in Section 9, Check 14, and in tests/security/platform-isolation.
--
-- ⚠️ NOTHING SETS `app.platform_scope` YET. `withPlatformScope()` must be
-- changed to open a transaction and pin it, exactly as `withTenant()` pins
-- the tenant id — three lines, in a file this phase does not own. It is
-- INTEGRATION step 1 in docs/PHASE-17-18-NOTES.md, with the exact diff. Until
-- it lands, the console reads nothing and the policies below are inert.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_platform_scope()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on';
$$;

-- ---- tenants: read AND write (suspension flips one column) ---------------
--
-- The only tenant-scoped table the console may WRITE, and it may write
-- exactly one thing that matters: `status`. There is no policy anywhere that
-- lets the platform connection delete a tenant.
DROP POLICY IF EXISTS tenant_self_isolation ON tenants;
CREATE POLICY tenant_self_isolation ON tenants
  USING      (id = app_current_tenant_id() OR app_platform_scope())
  WITH CHECK (id = app_current_tenant_id() OR app_platform_scope());

-- ---- users: READ ONLY for the platform ------------------------------------
--
-- Support must be able to answer "which workspace is this person in?" and
-- "who here is an admin?". Support must never be able to edit a customer's
-- user record — that is role and status, which outlive any session. So the
-- platform clause is on USING and NOT on WITH CHECK.
DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---- billing: READ ONLY for the platform ----------------------------------
--
-- The console shows plan, status and invoice state. It does not change them:
-- a plan change is a purchase decision and a support engineer making one is
-- indistinguishable from fraud. Same asymmetry — USING only.
DO $$
DECLARE
  readable text;
BEGIN
  FOREACH readable IN ARRAY ARRAY['subscriptions', 'invoices', 'documents']
  LOOP
    IF to_regclass('public.' || readable) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
                     readable || '_tenant_isolation', readable);
      EXECUTE format(
        'CREATE POLICY %I ON %I '
        'USING (tenant_id = app_current_tenant_id() OR app_platform_scope()) '
        'WITH CHECK (tenant_id = app_current_tenant_id())',
        readable || '_tenant_isolation', readable);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- ⭐ WHAT IS DELIBERATELY ABSENT FROM THE LIST ABOVE
-- ---------------------------------------------------------------------------
-- contacts, companies, deals, custom_object_records, assets, contracts,
-- contract_versions, journal_entries, transactions, ledgers.
--
-- These hold data about the customer's OWN customers — third parties who
-- never had a relationship with us and whose data we hold as a PROCESSOR.
-- Reading it for our own convenience is processing with no lawful basis;
-- "it made the ticket faster" is not a purpose.
--
-- If a future phase adds a platform clause to any of them, that is a change
-- to the data-protection posture of the product and it belongs in a review,
-- not in a bug fix. Check 14 in Section 9 fails loudly if it happens.
-- ---------------------------------------------------------------------------


-- ############################################################################
-- SECTION 7 — INTEGRITY CONSTRAINTS
-- ############################################################################
--
-- The application validates all of these with Zod and produces a good error
-- message. These are the versions that are actually true.

DO $$
BEGIN
  -- A justification is the whole value of the record. "fix" is not one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'impersonation_justification_length'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT impersonation_justification_length
      CHECK (length(btrim(justification)) >= 20);
  END IF;

  -- A session that expires before it starts is either a clock problem or an
  -- attempt to create a record of access that "never happened".
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'impersonation_expiry_after_start'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT impersonation_expiry_after_start
      CHECK (expires_at > started_at);
  END IF;

  -- ⭐ THE HARD CEILING ON SESSION LENGTH, IN THE DATABASE.
  -- `lib/platform/impersonation-policy.ts` caps it at 60 minutes. If that
  -- constant is ever raised without this being reviewed, the INSERT fails
  -- rather than quietly granting somebody a nine-hour session.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'impersonation_max_duration'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT impersonation_max_duration
      CHECK (expires_at <= started_at + interval '60 minutes');
  END IF;

  -- ⭐ BREAK-GLASS IS READ-ONLY, ENFORCED BY THE ENGINE.
  -- This is the load-bearing rule of the whole consent model: access
  -- obtained WITHOUT the customer's agreement may look and may not touch.
  -- A bug in `resolveScope()` cannot widen it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'breakglass_is_read_only'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT breakglass_is_read_only
      CHECK (mode <> 'break_glass' OR scope = 'read_only');
  END IF;

  -- A consented session must point at the consent it leans on. A session
  -- claiming consent with no consent row is unverifiable.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consented_session_has_consent'
  ) THEN
    ALTER TABLE platform_impersonation_sessions
      ADD CONSTRAINT consented_session_has_consent
      CHECK (mode = 'break_glass' OR consent_id IS NOT NULL);
  END IF;

  -- Consent always expires. A grant with no end date is how a checkbox
  -- ticked in 2024 becomes permanent access in 2027.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consent_expires_after_grant'
  ) THEN
    ALTER TABLE tenant_support_consents
      ADD CONSTRAINT consent_expires_after_grant
      CHECK (expires_at > granted_at);
  END IF;

  -- Every flag carries a written reason.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_flag_reason_present'
  ) THEN
    ALTER TABLE platform_tenant_flags
      ADD CONSTRAINT tenant_flag_reason_present
      CHECK (length(btrim(reason)) >= 10);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 8 — GRANTS
-- ############################################################################
--
-- ---------------------------------------------------------------------------
-- ⚠️ REVOKE FIRST. THIS IS NOT DEFENSIVE PADDING.
-- ---------------------------------------------------------------------------
-- A GRANT block that only ADDS privileges is worthless as a restriction. If
-- anyone has ever run `GRANT ALL ON ALL TABLES IN SCHEMA public TO ordence_app`
-- — the first thing most people do when a query fails with "permission
-- denied", and something several hosting guides recommend outright — then the
-- application role already holds DELETE on the impersonation evidence, and
-- every GRANT below is a no-op that changes nothing.
--
-- The restriction is only real if it is stated as a restriction.
--
-- The privilege that matters most here is the one that is NOT granted:
-- DELETE on `platform_impersonation_sessions` and `platform_action_log`.
-- Both also have triggers refusing it (Sections 2 and 3) — belt and braces,
-- because a trigger dropped by `drizzle-kit push` is a silent failure and
-- these are the two tables where a silent failure means an operator can erase
-- the record of their own access.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON platform_staff                   FROM ordence_app;
    REVOKE ALL ON platform_impersonation_sessions  FROM ordence_app;
    REVOKE ALL ON tenant_support_consents          FROM ordence_app;
    REVOKE ALL ON platform_tenant_flags            FROM ordence_app;
    REVOKE ALL ON platform_action_log              FROM ordence_app;

    -- Staff grants are revoked by STATUS, never removed. The history of who
    -- held platform access has to survive the revocation.
    GRANT SELECT, INSERT, UPDATE ON platform_staff TO ordence_app;

    -- INSERT and the one-way close. No DELETE.
    GRANT SELECT, INSERT, UPDATE ON platform_impersonation_sessions TO ordence_app;

    -- The tenant grants and revokes; nothing deletes.
    GRANT SELECT, INSERT, UPDATE ON tenant_support_consents TO ordence_app;

    -- Flags are the one table here where a hard DELETE is harmless — a
    -- removed override simply means "no override", which is the default.
    -- It is still not granted: `enabled = false` is the honest record, and
    -- it keeps the reason and the author.
    GRANT SELECT, INSERT, UPDATE ON platform_tenant_flags TO ordence_app;

    -- ⭐ INSERT AND SELECT ONLY. The cross-tenant access log.
    GRANT SELECT, INSERT ON platform_action_log TO ordence_app;
  END IF;
END
$$;





-- ############################################################################
-- SECTION 19 — PHASE 16: INVOICING
-- ############################################################################
--
-- Phase 11 proved an issued invoice cannot be TAMPERED WITH. This section
-- addresses the other half: an invoice being CREATED wrongly.
--
--   * One invoice per subscription period, enforced by a partial unique index.
--     A redelivered webhook or a double-clicked button cannot bill a customer
--     twice for one month — and there is no way to withdraw a duplicate except
--     a credit note, which puts the mistake permanently in both filings.
--   * An invoice cannot be ISSUED with no line items. A total with nothing
--     itemised is not a valid GST invoice, and the Phase 11 trigger does not
--     catch it — that one prevents CHANGING an issued invoice, not issuing an
--     empty one.
--   * No DELETE on invoices for the application role. The correction for a bad
--     invoice is a void or a credit note; a number that vanishes from a series
--     is exactly what an auditor asks about.
-- ############################################################################

CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_per_period
  ON invoices (subscription_id, period_start, period_end)
  WHERE subscription_id IS NOT NULL
    AND period_start IS NOT NULL
    AND status <> 'void';


-- ############################################################################
-- SECTION 2 — AN ISSUED INVOICE MUST HAVE LINES
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   `generateInvoice()` inserts the header, then the lines, then seals it —
--   all in one transaction, so a crash between steps rolls everything back.
--
--   But that is a property of ONE function. A future migration, a support
--   script, or an operator with a SQL console can move an invoice to `open`
--   with nothing attached. The customer then receives a document with a total
--   and no explanation of what it is for, which is both useless and, under
--   GST rules, not a valid invoice.
--
--   The header trigger from Phase 11 does not catch it: that one prevents
--   CHANGING an issued invoice, not issuing an empty one.
--
-- THE FIX:
--   Refuse the draft → issued transition when no lines exist.
--
--   ⚠️ Deliberately checks only the transition, not every UPDATE. Recording a
--   payment on an issued invoice must stay possible, and re-counting lines on
--   every status change would make that needlessly expensive.

CREATE OR REPLACE FUNCTION prevent_empty_invoice_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  line_count integer;
BEGIN
  -- Only the moment of issue matters.
  IF OLD.status <> 'draft' OR NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO line_count FROM invoice_lines WHERE invoice_id = NEW.id;

  IF line_count = 0 THEN
    RAISE EXCEPTION
      'Invoice % cannot be issued with no line items. A total with nothing '
      'itemised is not a valid GST invoice.',
      NEW.invoice_number
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_require_lines ON invoices;
CREATE TRIGGER invoices_require_lines
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION prevent_empty_invoice_issue();


-- ############################################################################
-- SECTION 3 — NUMBERS ARE NEVER REUSED
-- ############################################################################
--
-- The sequence guarantees uniqueness going forward. What it does not prevent
-- is somebody RESETTING it — `ALTER SEQUENCE invoice_number_seq RESTART` is
-- one line, and the usual motivation is entirely well-meaning: tidying up
-- after test data.
--
-- The consequence is two different invoices bearing one number, months apart,
-- both filed. That is indistinguishable from fraud after the fact.
--
-- There is no way to forbid ALTER SEQUENCE to an owner, so this records the
-- high-water mark and lets `db:verify` shout if the sequence ever falls below
-- a number already issued.

CREATE OR REPLACE FUNCTION invoice_sequence_is_sane()
RETURNS TABLE (verdict text, highest_issued bigint, sequence_at bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  max_issued bigint;
  seq_value bigint;
BEGIN
  -- The trailing 6 digits of every number we have ever written.
  SELECT coalesce(max(NULLIF(regexp_replace(invoice_number, '^.*/', ''), '')::bigint), 0)
    INTO max_issued
    FROM invoices
   WHERE invoice_number ~ '/[0-9]+$';

  SELECT last_value INTO seq_value FROM invoice_number_seq;

  RETURN QUERY SELECT
    CASE WHEN seq_value >= max_issued
         THEN 'PASS: the sequence is ahead of every number issued'
         ELSE '*** FAIL: the sequence has been reset below an issued number — '
              'the next invoice will REUSE a number already filed ***'
    END,
    max_issued,
    seq_value;
END;
$$;


-- ############################################################################
-- SECTION 4 — GRANTS
-- ############################################################################
--
-- REVOKE before GRANT. An additive-only block is defeated by any prior
-- `GRANT ALL ON ALL TABLES` — which is the first thing most people run when a
-- query fails with "permission denied", and which several hosting guides
-- recommend outright. (Found the hard way in Phase 11.)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON invoices      FROM ordence_app;
    REVOKE ALL ON invoice_lines FROM ordence_app;

    -- No DELETE on either. An invoice is a document the customer holds a
    -- copy of; the correction for a bad one is a void or a credit note,
    -- never a deletion. Lines keep DELETE so a DRAFT can be rebuilt — the
    -- trigger from Phase 11 already refuses it once issued.
    GRANT SELECT, INSERT, UPDATE ON invoices TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_lines TO ordence_app;

    GRANT USAGE ON SEQUENCE invoice_number_seq TO ordence_app;
  END IF;
END
$$;



-- ============================================================================
--   SETUP COMPLETE
--
--   Confirm:
--     Check 1  → 25 tables, every one `true`
--     Analytics → all 3 views report security_invoker
--     Check 2  → the balance trigger is DEFERRED
--     Check 3  → 8 append-only triggers
--     Check 5  → 0 rows (ledger balances all reconcile)
--     Check 6  → difference = 0.00
--     Check 7  → 2 tables, both `true`
--     Check 8  → 2 period-lock triggers
--     Check 9  → the overlap constraint exists
--     Billing  → replay protection, one-live-subscription, 5 tables RLS, grants
--     Observ.  → 3 tables RLS, telemetry_daily security_invoker, append-only
--
--   If all of those agree, your database is fully protected.
-- ============================================================================


-- ── CHECK: ANALYTICS VIEWS RUN AS THE CALLER ────────────────────────────────
-- ⭐ The single most important check added in Phase 10.
-- A view missing `security_invoker` returns EVERY TENANT'S aggregates with no
-- error and no visible symptom.
SELECT
  CASE WHEN count(*) = 3
       THEN 'PASS: all 3 analytics views run with security_invoker'
       ELSE 'FAIL: only ' || count(*) || ' of 3 views have security_invoker — THE OTHERS LEAK ACROSS TENANTS'
  END AS check_analytics_security_invoker
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN ('v_asset_portfolio', 'v_ledger_daily', 'v_contract_pipeline')
  AND c.reloptions @> ARRAY['security_invoker=true'];


-- == CHECK: WEBHOOK REPLAY PROTECTION =======================================
-- The single most important check added in Phase 11. Without this index a
-- retried webhook is processed twice, a customer is charged twice, and
-- nothing anywhere reports a problem.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'payment_events'
      AND indexname = 'payment_events_provider_event_unique'
  ) THEN 'PASS: webhook replay protection is in place'
  ELSE  'FAIL: payment_events_provider_event_unique IS MISSING - duplicate webhooks WILL be processed twice'
  END AS check_webhook_idempotency;


-- == CHECK: NO TENANT CAN HOLD TWO LIVE SUBSCRIPTIONS =======================
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'subscriptions'
      AND indexname = 'subscriptions_one_live_per_tenant'
  ) THEN 'PASS: a tenant cannot hold two live subscriptions'
  ELSE  'FAIL: subscriptions_one_live_per_tenant IS MISSING - double billing is possible'
  END AS check_one_live_subscription;


-- == CHECK: BILLING TABLES ARE UNDER FORCED RLS =============================
SELECT
  CASE WHEN count(*) = 5
       THEN 'PASS: all 5 tenant-scoped billing tables are ENABLE + FORCE'
       ELSE 'FAIL: only ' || count(*) || ' of 5 billing tables are fully protected'
  END AS check_billing_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('subscriptions','invoices','invoice_lines','payment_events','payment_methods')
  AND c.relrowsecurity AND c.relforcerowsecurity;


-- == CHECK: BILLING PRIVILEGES ARE RESTRICTED ===============================
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN has_table_privilege('ordence_app','plans','SELECT')
     AND NOT has_table_privilege('ordence_app','plans','UPDATE')
     AND NOT has_table_privilege('ordence_app','payment_events','UPDATE')
     AND NOT has_table_privilege('ordence_app','subscriptions','DELETE')
      THEN 'PASS: billing privileges are correctly restricted'
    ELSE 'FAIL: the application role holds a billing privilege it should not'
  END AS check_billing_grants;


-- == CHECK: TELEMETRY + SECOPS TABLES ARE UNDER FORCED RLS ==================
SELECT
  CASE WHEN count(*) = 3
       THEN 'PASS: telemetry and security_events are ENABLE + FORCE'
       ELSE 'FAIL: only ' || count(*) || ' of 3 observability tables are protected'
  END AS check_observability_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('error_events','web_vital_events','security_events')
  AND c.relrowsecurity AND c.relforcerowsecurity;


-- == CHECK: telemetry_daily RUNS AS THE CALLER ==============================
-- Without security_invoker this view hands every tenant's error volume and
-- performance profile to every other tenant, silently.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v'
      AND c.relname = 'telemetry_daily'
      AND c.reloptions @> ARRAY['security_invoker=true']
  ) THEN 'PASS: telemetry_daily applies the caller''s RLS'
  ELSE  'FAIL: telemetry_daily is MISSING security_invoker — IT LEAKS ACROSS TENANTS'
  END AS check_telemetry_view_invoker;


-- == CHECK: SECURITY EVENTS ARE APPEND-ONLY =================================
SELECT
  CASE WHEN count(*) >= 2
       THEN 'PASS: security_events refuses UPDATE and DELETE'
       ELSE 'FAIL: security_events is mutable — an incident record that can be edited proves nothing'
  END AS check_security_events_append_only
FROM pg_trigger
WHERE tgrelid = 'security_events'::regclass
  AND NOT tgisinternal
  AND (tgname LIKE '%_no_update' OR tgname LIKE '%_no_delete');


-- == CHECK: A PERIOD CANNOT BE INVOICED TWICE ===============================
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'invoices' AND indexname = 'invoices_one_per_period'
  ) THEN 'PASS: a subscription period cannot be invoiced twice'
  ELSE  'FAIL: invoices_one_per_period IS MISSING - a retried webhook WILL bill a period twice'
  END AS check_one_invoice_per_period;


-- == CHECK: NO ISSUED INVOICE IS EMPTY ======================================
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every issued invoice has line items'
       ELSE 'FAIL: ' || count(*) || ' issued invoice(s) have no line items'
  END AS check_no_empty_invoices
FROM (
  SELECT i.id
    FROM invoices i
    LEFT JOIN invoice_lines l ON l.invoice_id = i.id
   WHERE i.status <> 'draft'
   GROUP BY i.id
  HAVING count(l.id) = 0
) empty_invoices;


-- == CHECK: THE INVOICE NUMBER SEQUENCE HAS NOT BEEN WOUND BACK =============
SELECT verdict AS check_invoice_sequence FROM invoice_sequence_is_sane();



-- ############################################################################
-- ############################################################################
-- SECTION 20 — PHASE 22: SALES PIPELINE & INVENTORY
-- ############################################################################
-- ############################################################################
--
-- Verbatim from SQL-FILES/0016_phase22_sales.sql, sections 1-9. Read that
-- file for the full reasoning; the short version is:
--
--   * Seven new tables under ENABLE + FORCE row-level security.
--   * Composite foreign keys, because FK checks IGNORE row-level security and
--     a single-column FK lets one tenant point a row at another tenant's
--     parent record.
--   * One live booking per unit, enforced by a partial unique index. Two
--     buyers promised the same flat is the one failure in this system that no
--     UPDATE can repair.
--
-- ############################################################################

-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER as well,
-- which is the half everybody forgets: without it, the role that created the
-- table reads everything and the policies look like they are working.
--
-- ⚠️ NOTE WHAT IS ABSENT: none of these policies carry
-- `OR app_is_platform_scope()`. That marker exists so platform staff can
-- resolve a webhook to a subscription; it deliberately does NOT extend to
-- customer content. A support engineer has no business reading a customer's
-- pipeline, and the narrowing was itself a defect found and fixed in v0.14.1.

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_tenant_isolation ON projects;
CREATE POLICY projects_tenant_isolation ON projects
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS units_tenant_isolation ON units;
CREATE POLICY units_tenant_isolation ON units
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leads_tenant_isolation ON leads;
CREATE POLICY leads_tenant_isolation ON leads
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_activities_tenant_isolation ON lead_activities;
CREATE POLICY lead_activities_tenant_isolation ON lead_activities
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE channel_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_partners FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_partners_tenant_isolation ON channel_partners;
CREATE POLICY channel_partners_tenant_isolation ON channel_partners
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bookings_tenant_isolation ON bookings;
CREATE POLICY bookings_tenant_isolation ON bookings
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE payment_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_milestones FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_milestones_tenant_isolation ON payment_milestones;
CREATE POLICY payment_milestones_tenant_isolation ON payment_milestones
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 2 — ⭐ CROSS-TENANT REFERENCE INTEGRITY
-- ############################################################################
--
-- ⚠️ THIS IS THE ONE THAT IS NOT OBVIOUS, AND IT IS A REAL HOLE.
--
-- Row-level security governs which rows a session can SEE and WRITE. It does
-- not govern what a row POINTS AT, because **foreign-key checks run as the
-- system and ignore RLS entirely**. That is documented PostgreSQL behaviour
-- and it is easy to read past.
--
-- The consequence, concretely:
--
--   Tenant A inserts a unit with
--       tenant_id  = A          ← passes WITH CHECK, it is their own tenant
--       project_id = <a UUID belonging to tenant B>
--
--   The WITH CHECK passes. The foreign key passes, because the referenced
--   project genuinely exists. Tenant A now owns a unit attached to tenant B's
--   development. Nothing errors. Nothing logs. Every page renders.
--
-- Is it exploitable? It needs a UUID from another tenant, which is not
-- guessable. But UUIDs leak — a support ticket, a screenshot, a CSV, a URL
-- pasted into a chat. "Requires a leaked identifier" is a description of the
-- attack, not a defence against it, and the same reasoning is why we do not
-- rely on unguessable ids anywhere else in this system.
--
-- THE FIX: composite foreign keys.
--
-- Reference (tenant_id, id) rather than (id). The child row must then name
-- the SAME tenant as its parent — and since WITH CHECK has already pinned the
-- child's tenant_id to the current tenant, a cross-tenant pointer becomes
-- arithmetically impossible rather than merely unlikely.
--
-- The parent needs a UNIQUE index on (id, tenant_id) for the composite key to
-- reference. `id` is already the primary key, so this index is redundant for
-- lookups and exists purely to give the FK something to attach to. That is a
-- normal and accepted cost of the pattern.

-- 2a. Targets for the composite keys.
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_tenant_key
  ON projects (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS units_id_tenant_key
  ON units (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS leads_id_tenant_key
  ON leads (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_id_tenant_key
  ON bookings (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_partners_id_tenant_key
  ON channel_partners (id, tenant_id);

-- 2b. The composite keys themselves.
--
-- Each is added only if absent, so this file is safe to re-run. The
-- single-column FKs that drizzle created stay: they are not wrong, they are
-- merely insufficient, and dropping them would remove the ON DELETE behaviour
-- the application relies on.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'units_project_same_tenant') THEN
    ALTER TABLE units
      ADD CONSTRAINT units_project_same_tenant
      FOREIGN KEY (project_id, tenant_id)
      REFERENCES projects (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_project_same_tenant') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_project_same_tenant
      FOREIGN KEY (project_id, tenant_id)
      REFERENCES projects (id, tenant_id)
      ON DELETE SET NULL (project_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_activities_lead_same_tenant') THEN
    ALTER TABLE lead_activities
      ADD CONSTRAINT lead_activities_lead_same_tenant
      FOREIGN KEY (lead_id, tenant_id)
      REFERENCES leads (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_unit_same_tenant') THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_unit_same_tenant
      FOREIGN KEY (unit_id, tenant_id)
      REFERENCES units (id, tenant_id)
      ON DELETE SET NULL (unit_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_lead_same_tenant') THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_lead_same_tenant
      FOREIGN KEY (lead_id, tenant_id)
      REFERENCES leads (id, tenant_id)
      ON DELETE SET NULL (lead_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_partner_same_tenant') THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_partner_same_tenant
      FOREIGN KEY (channel_partner_id, tenant_id)
      REFERENCES channel_partners (id, tenant_id)
      ON DELETE SET NULL (channel_partner_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestones_booking_same_tenant') THEN
    ALTER TABLE payment_milestones
      ADD CONSTRAINT milestones_booking_same_tenant
      FOREIGN KEY (booking_id, tenant_id)
      REFERENCES bookings (id, tenant_id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- 2c. `leads.channel_partner_id` and `units.held_for_lead_id` were declared
-- in the schema WITHOUT a foreign key, to avoid a circular table definition
-- in TypeScript. They get theirs here, composite from the start.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_partner_same_tenant') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_partner_same_tenant
      FOREIGN KEY (channel_partner_id, tenant_id)
      REFERENCES channel_partners (id, tenant_id)
      ON DELETE SET NULL (channel_partner_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'units_held_lead_same_tenant') THEN
    ALTER TABLE units
      ADD CONSTRAINT units_held_lead_same_tenant
      FOREIGN KEY (held_for_lead_id, tenant_id)
      REFERENCES leads (id, tenant_id)
      ON DELETE SET NULL (held_for_lead_id);
  END IF;
END
$$;


-- 2d. ⚠️ THE EDGES SECTION 2 MISSED: EVERY POINTER INTO `users`.
--
-- Found by an adversarial review, and it is worth recording exactly how
-- it slipped through. Section 2 was written as "give every sales→sales
-- relationship a composite key", and it did that completely. But four
-- columns point at `users`, which is NOT a sales table, so they were
-- never in scope — and Check 8 tested only the sales→sales edges, so the
-- verification reported PASS.
--
--     leads.owner_id            units.held_by_user_id
--     bookings.sales_rep_id     lead_activities.user_id
--
-- `users` carries a tenant_id, so these are the same defect as the rest
-- of Section 2. Verified accepted before this fix:
--
--     UPDATE leads SET owner_id = '<a user in ANOTHER tenant>';   -- UPDATE 1
--
-- Three consequences, in ascending order of seriousness:
--
--   1. Tenant A stores tenant B's user ids in its own rows.
--   2. A clean EXISTENCE ORACLE. A real UUID from any workspace on the
--      platform is accepted; a random one is refused with a foreign-key
--      error. That difference is enough to confirm whether a given id is
--      a real user somewhere — the exact leak the `bookings.unit_id`
--      path already avoids by returning the same message either way.
--   3. When tenant B later deletes that user, the ON DELETE SET NULL
--      performs a WRITE into tenant A's rows. One customer's admin
--      action silently mutating another customer's data is the single
--      worst outcome in this list, and nothing anywhere would report it.
--
-- The lesson generalises: "every table in this phase" is the wrong scope
-- for a cross-tenant audit. The right scope is EVERY COLUMN THAT POINTS
-- AT A TENANT-SCOPED TABLE, wherever that table happens to live.

CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_key
  ON users (id, tenant_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_owner_same_tenant') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_owner_same_tenant
      FOREIGN KEY (owner_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (owner_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'units_held_by_same_tenant') THEN
    ALTER TABLE units
      ADD CONSTRAINT units_held_by_same_tenant
      FOREIGN KEY (held_by_user_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (held_by_user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_rep_same_tenant') THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_rep_same_tenant
      FOREIGN KEY (sales_rep_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (sales_rep_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_activities_user_same_tenant') THEN
    ALTER TABLE lead_activities
      ADD CONSTRAINT lead_activities_user_same_tenant
      FOREIGN KEY (user_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (user_id);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 3 — ⭐ ONE LIVE BOOKING PER UNIT
-- ############################################################################
--
-- The index is declared in `db/schema/sales.ts`, which means `drizzle-kit
-- push` creates it. It is restated here for one reason: **push removes what
-- it does not recognise, and a future schema edit could drop it silently.**
-- This file is the belt; the schema is the braces.
--
-- WHY AN INDEX AND NOT A CHECK IN THE SERVER ACTION:
--
--   Two reps click "Book" on unit A-1203 within the same second.
--
--     T1: SELECT ... FROM bookings WHERE unit_id = X AND status <> 'cancelled'
--         → 0 rows. Proceed.
--     T2: SELECT ... same query
--         → 0 rows. Proceed.          ← T1 has not committed yet
--     T1: INSERT booking. COMMIT.
--     T2: INSERT booking. COMMIT.
--
--   Both transactions were individually correct. Both read a consistent
--   snapshot. READ COMMITTED — Postgres's default, and ours — permits this
--   exactly. There is no arrangement of application code that closes it
--   without either a lock or a unique index.
--
--   The unique index makes T2 fail with 23505. Section 4's trigger takes the
--   lock as well, so the common case is a clean error rather than a
--   constraint violation surfacing to a user.
--
-- PARTIAL, and both exclusions are deliberate:
--   • `status <> 'cancelled'` — a cancelled booking must free the unit.
--     Otherwise a buyer who walks away permanently poisons the flat.
--   • `unit_id IS NOT NULL` — a booking can exist before a unit is allotted
--     (a "soft" booking against a project), and those must not collide.

CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_live_per_unit
  ON bookings (unit_id)
  WHERE status <> 'cancelled' AND unit_id IS NOT NULL;


-- ############################################################################
-- SECTION 4 — UNIT STATUS COHERENCE
-- ############################################################################
--
-- The index in Section 3 stops two rows existing. It does not stop the FIRST
-- one being wrong — booking a unit that management has blocked, or one
-- already sold, or one another rep is holding for a different buyer.
--
-- Those are business rules, so they could live in the server action. They do
-- not, for the same reason as Section 3: an import script, a support fix and
-- a future API route are all write paths, and a rule enforced in one of four
-- write paths is a rule that will eventually be bypassed by the other three.
--
-- ⚠️ THE `FOR UPDATE` IS THE POINT OF THIS FUNCTION.
--
-- Reading the unit's status without locking it reproduces the exact race
-- Section 3 describes, one table across. The lock serialises concurrent
-- attempts on the same unit, so the second one sees the first one's effect
-- instead of a stale snapshot.

CREATE OR REPLACE FUNCTION enforce_unit_bookable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  unit_row units%ROWTYPE;
BEGIN
  -- A booking with no unit has nothing to check.
  IF NEW.unit_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A cancellation never needs the unit to be free.
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, only re-check when the unit or the liveness actually changed.
  --
  -- ⚠️ NESTED, NOT `TG_OP = 'UPDATE' AND OLD.…`. PL/pgSQL does not guarantee
  -- short-circuit evaluation of AND — the condition is handed to the SQL
  -- executor, which may evaluate either side first. On an INSERT, OLD is
  -- unassigned and touching it raises `record "old" is not assigned yet`,
  -- turning a guard into an outage on the happy path.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.unit_id IS NOT DISTINCT FROM NEW.unit_id
       AND OLD.status <> 'cancelled' THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ⚠️ FOR UPDATE. See the note above — without it this is decorative.
  SELECT * INTO unit_row FROM units WHERE id = NEW.unit_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unit % does not exist.', NEW.unit_id
      USING ERRCODE = '23503';
  END IF;

  IF unit_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Unit % has been deleted and cannot be booked. Restore it first.',
      unit_row.code
      USING ERRCODE = '23514';
  END IF;

  IF unit_row.status = 'blocked' THEN
    RAISE EXCEPTION
      'Unit % is blocked and is not available for sale. Management removed it '
      'from the market — unblock it before booking.',
      unit_row.code
      USING ERRCODE = '23514';
  END IF;

  IF unit_row.status = 'sold' THEN
    RAISE EXCEPTION
      'Unit % is already sold.', unit_row.code
      USING ERRCODE = '23514';
  END IF;

  -- ⚠️ A HOLD BELONGS TO A NAMED BUYER.
  --
  -- Booking a held unit for somebody ELSE is the quiet version of the
  -- double-sale: the rep who placed the hold made a promise, and the system
  -- let a colleague break it without either of them noticing. A live hold
  -- for a different lead is refused; an EXPIRED hold is not, because the
  -- whole point of the deadline is that it releases.
  IF unit_row.status = 'held'
     AND unit_row.hold_until > now()
     AND unit_row.held_for_lead_id IS DISTINCT FROM NEW.lead_id THEN
    RAISE EXCEPTION
      'Unit % is held for another buyer until %. Release the hold first, or '
      'wait for it to expire.',
      unit_row.code, unit_row.hold_until
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_unit_bookable ON bookings;
CREATE TRIGGER bookings_unit_bookable
  BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_unit_bookable();


-- ----------------------------------------------------------------------------
-- 4b. The unit follows the booking.
-- ----------------------------------------------------------------------------
--
-- Keeping `units.status` in step with its live booking is the sort of thing
-- an application usually does in a second UPDATE after the insert — and that
-- second UPDATE is exactly what fails to run when the request times out, the
-- process is killed, or somebody writes the booking from a script.
--
-- The result is an inventory board that says "available" for a flat that is
-- sold. In this product the inventory board is what the sales team trusts.
--
-- ⚠️ Deliberately does NOT touch `blocked`. Management blocking a unit
-- outranks the pipeline, and having the trigger quietly override a
-- management decision would be worse than the inconsistency it fixes.

-- ══════════════════════════════════════════════════════════════════════
-- 🔴 THE DEFECT AN ADVERSARIAL REVIEW FOUND HERE, AND WHY IT MATTERED
-- ══════════════════════════════════════════════════════════════════════
-- The first version of this function keyed off NEW.status alone. A
-- security reviewer turned that into a write primitive against `units`
-- in a single statement:
--
--     INSERT INTO bookings (..., unit_id, status, cancel_reason)
--     VALUES (..., <a unit held for someone else>, 'cancelled', 'oops');
--
-- `enforce_unit_bookable` waves cancelled rows through deliberately — a
-- cancellation does not need the unit to be free. This function then ran
-- its "cancelled" branch and freed the unit: hold_until, held_for_lead_id,
-- held_by_user_id, the token and the note, all wiped. A second INSERT
-- then booked the flat for whoever wanted it.
--
-- No error. No cross-tenant access needed. Any rep with `bookings:create`
-- could strip a colleague's hold on any unit in the workspace — which is
-- precisely the "quiet version of the double-sale" this file claims to
-- prevent.
--
-- THE ROOT CAUSE was asking "is this booking cancelled?" instead of "did
-- this booking just STOP occupying that unit?". Those coincide on the
-- happy path and diverge on every abusive one.
--
-- The same mistake produced a second, quieter bug: re-pointing a booking
-- from unit A to unit B synced only B, leaving A stuck at `booked` with
-- no live booking — permanently unsellable, on the board the sales team
-- trusts.
--
-- Both are fixed by computing the VACATED unit explicitly.

CREATE OR REPLACE FUNCTION sync_unit_status_from_booking()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  vacated uuid;
BEGIN
  /* ---------------------------------------------------------------- */
  /* 1. Which unit, if any, has this booking just STOPPED occupying?   */
  /* ---------------------------------------------------------------- */
  --
  -- ⚠️ Only ever on UPDATE, and only when the booking was previously
  -- LIVE ON THAT UNIT. An INSERT cannot vacate anything — a booking that
  -- did not exist a moment ago was not holding a flat. That single
  -- condition is what closes the born-cancelled hole above.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'cancelled' AND OLD.unit_id IS NOT NULL THEN
      IF NEW.status = 'cancelled' OR NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
        vacated := OLD.unit_id;
      END IF;
    END IF;
  END IF;

  IF vacated IS NOT NULL THEN
    UPDATE units
       SET status           = 'available',
           hold_until       = NULL,
           held_for_lead_id = NULL,
           held_by_user_id  = NULL,
           hold_token_minor = NULL,
           hold_note        = NULL,
           updated_at       = now()
     WHERE id = vacated
       -- Management's decision outranks the pipeline. A blocked unit
       -- stays blocked whatever happens to bookings around it.
       AND status <> 'blocked'
       -- And only if nothing ELSE live is attached to it.
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.unit_id = vacated
            AND b.status <> 'cancelled'
            AND b.id <> NEW.id
       );
  END IF;

  /* ---------------------------------------------------------------- */
  /* 2. Apply this booking's effect on the unit it now occupies.       */
  /* ---------------------------------------------------------------- */
  IF NEW.status = 'cancelled' OR NEW.unit_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'registered' THEN
    UPDATE units
       SET status = 'sold', hold_until = NULL, held_for_lead_id = NULL,
           held_by_user_id = NULL, updated_at = now()
     WHERE id = NEW.unit_id AND status <> 'blocked';
  ELSE
    -- tentative | confirmed | agreement — all mean "spoken for".
    UPDATE units
       SET status = 'booked', hold_until = NULL, held_for_lead_id = NULL,
           held_by_user_id = NULL, updated_at = now()
     WHERE id = NEW.unit_id AND status <> 'blocked';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_sync_unit ON bookings;
CREATE TRIGGER bookings_sync_unit
  AFTER INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_unit_status_from_booking();


-- ############################################################################
-- SECTION 5 — THE HOLD, AND HOW IT RELEASES ITSELF
-- ############################################################################
--
-- A hold with no deadline is a unit removed from sale by somebody who has
-- since left the company. The schema already refuses a `held` unit with no
-- `hold_until` (constraint `units_hold_is_complete`); this section is what
-- makes the deadline mean something.
--
-- ⚠️ IT IS A FUNCTION, NOT A CRON JOB THAT DELETES THINGS.
--
-- Same reasoning as the recycle bin in Phase 21: an unattended sweeper whose
-- failure mode is destroying customer state is a bad trade. This one only
-- ever moves `held` → `available`, which is recoverable by re-holding, and it
-- returns what it did so a caller can log it.
--
-- Call it from the inventory page load and from a scheduled route. Running it
-- twice is harmless.

-- ⚠️ THE `FROM prev` SUBQUERY IS NOT DECORATION.
--
-- The first version did `RETURNING u.held_for_lead_id` in the very
-- statement that sets `held_for_lead_id = NULL`. RETURNING yields the
-- NEW value, so the function dutifully reported that every hold had been
-- released from nobody.
--
-- Nothing errored. The sweep worked. Only the evidence was empty — which
-- is the exact failure mode that made the audit trail useless for
-- fourteen phases, arriving again in a new costume. Reading the OLD row
-- from a subquery first is the only way to report what was actually
-- there.

CREATE OR REPLACE FUNCTION release_expired_unit_holds(p_tenant_id uuid DEFAULT NULL)
RETURNS TABLE (unit_id uuid, unit_code text, released_from uuid)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE units u
     SET status           = 'available',
         hold_until       = NULL,
         held_for_lead_id = NULL,
         held_by_user_id  = NULL,
         hold_token_minor = NULL,
         hold_note        = NULL,
         updated_at       = now()
    FROM (
      SELECT p.id, p.code, p.held_for_lead_id
        FROM units p
       WHERE p.status = 'held'
         AND p.hold_until IS NOT NULL
         AND p.hold_until <= now()
         -- A held unit that somehow also has a live booking is NOT freed.
         -- That combination should be impossible; if it happens, the
         -- booking wins and a human should look at it.
         AND NOT EXISTS (
           SELECT 1 FROM bookings b
            WHERE b.unit_id = p.id AND b.status <> 'cancelled'
         )
         AND (p_tenant_id IS NULL OR p.tenant_id = p_tenant_id)
       -- ⚠️ FOR UPDATE, so two concurrent sweeps cannot both claim the
       -- same unit and both report having released it.
       FOR UPDATE
    ) prev
   WHERE u.id = prev.id
  RETURNING prev.id, prev.code::text, prev.held_for_lead_id;
END;
$$;


-- ----------------------------------------------------------------------------
-- 5b. A hold cannot be placed on a unit that is not free.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_unit_hold_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'held' THEN
    RETURN NEW;
  END IF;

  -- ⚠️ Every OLD reference below is nested inside `TG_OP = 'UPDATE'`, never
  -- combined with it by AND. PL/pgSQL will not promise to evaluate the left
  -- side first, and on an INSERT `OLD` is unassigned — reading it raises.
  IF TG_OP = 'UPDATE' THEN
    -- ══════════════════════════════════════════════════════════════
    -- 🔴 THE HOLE A SECURITY REVIEW FOUND HERE
    -- ══════════════════════════════════════════════════════════════
    -- This block used to early-return only when the lead was UNCHANGED,
    -- and fall through to the generic checks when it differed. A live
    -- hold passes every one of those checks trivially — not sold, not
    -- blocked, deadline in the future, no live booking.
    --
    -- So this was accepted, in two statements, with no error:
    --
    --     UPDATE units SET status='held', hold_until=now()+'5 days',
    --                      held_for_lead_id = <buyer A>  WHERE id = :u;
    --     UPDATE units SET held_for_lead_id = <buyer B>  WHERE id = :u;
    --
    -- Buyer A's hold silently became buyer B's, and `enforce_unit_bookable`
    -- then let B book the flat — because as far as it could tell, the
    -- unit was held for exactly the person now booking it. The headline
    -- hold guarantee was defeated without touching bookings at all.
    --
    -- A LIVE hold is now released explicitly or it is not moved.
    IF OLD.status = 'held'
       AND OLD.hold_until IS NOT NULL
       AND OLD.hold_until > now()
       AND OLD.held_for_lead_id IS DISTINCT FROM NEW.held_for_lead_id THEN
      RAISE EXCEPTION
        'Unit % is held for another buyer until %. Release that hold before '
        'holding it for someone else — reassigning it silently is how one '
        'buyer''s reservation becomes another''s.',
        NEW.code, OLD.hold_until
        USING ERRCODE = '23514';
    END IF;

    -- Re-saving a hold that is already in place, for the same buyer, is the
    -- ordinary case: extending a deadline, adding a note.
    --
    -- ⚠️ The deadline check below is deliberately NOT skipped here. The
    -- earlier version returned before it, which let an existing hold be
    -- backdated into the past — an expired hold that the sweep then had
    -- to clean up, created by a write path that should have refused it.
    IF OLD.status = 'held'
       AND OLD.held_for_lead_id IS NOT DISTINCT FROM NEW.held_for_lead_id THEN
      IF NEW.hold_until <= now() THEN
        RAISE EXCEPTION
          'A hold on unit % must expire in the future. Given: %.',
          NEW.code, NEW.hold_until
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    -- A sold or blocked unit is not available to hold. `sold` is obvious;
    -- `blocked` is the one that matters, because a rep holding a unit
    -- management has withdrawn is how a withdrawn unit gets sold anyway.
    IF OLD.status IN ('sold', 'blocked') THEN
      RAISE EXCEPTION
        'Unit % is %, so it cannot be held.', NEW.code, OLD.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.hold_until <= now() THEN
    RAISE EXCEPTION
      'A hold on unit % must expire in the future. Given: %.',
      NEW.code, NEW.hold_until
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM bookings b
     WHERE b.unit_id = NEW.id AND b.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION
      'Unit % already has a live booking and cannot be held.', NEW.code
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS units_hold_valid ON units;
CREATE TRIGGER units_hold_valid
  BEFORE INSERT OR UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION enforce_unit_hold_valid();


-- ############################################################################
-- SECTION 6 — THE COMMISSION-PROTECTION WINDOW
-- ############################################################################
--
-- A broker registers a buyer; for a defined period that buyer is theirs. It
-- is one of the most argued-about mechanics in Indian real estate, and the
-- argument is always about the same thing: somebody re-attributed the lead.
--
-- The re-attribution is rarely malicious. A rep merges duplicates, an import
-- overwrites a column, a manager reassigns a pipeline. The broker finds out
-- when the commission does not arrive, and the company has no record of the
-- change because a plain UPDATE leaves none.
--
-- ⚠️ THIS TRIGGER REFUSES, IT DOES NOT WARN.
--
-- A warning in the UI is bypassed by every write path that is not the UI.
-- Clearing the lock is a deliberate, separate act — set `cp_locked_until` to
-- NULL or to the past first, which is itself an UPDATE that the audit trail
-- records. That turns a silent overwrite into a decision somebody made.

CREATE OR REPLACE FUNCTION enforce_cp_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Nothing to protect.
  IF OLD.channel_partner_id IS NULL OR OLD.cp_locked_until IS NULL THEN
    RETURN NEW;
  END IF;

  -- The window has closed. The lead is fair game.
  IF OLD.cp_locked_until <= now() THEN
    RETURN NEW;
  END IF;

  -- Unchanged attribution — the usual case, every other edit to the lead.
  IF NEW.channel_partner_id IS NOT DISTINCT FROM OLD.channel_partner_id THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Lead % is registered to a channel partner until %. Re-attributing it now '
    'would move a commission that has already been earned. Clear the '
    'protection window first if that is genuinely what you intend.',
    OLD.reference, OLD.cp_locked_until
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS leads_cp_lock ON leads;
CREATE TRIGGER leads_cp_lock
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION enforce_cp_lock();


-- ############################################################################
-- SECTION 7 — LEAD ACTIVITY IS APPEND-ONLY
-- ############################################################################
--
-- `lead_activities` is the record of what was said to a buyer and when. It is
-- the first thing anybody reads in a dispute — a RERA complaint, a broker
-- argument, a customer saying they were promised something.
--
-- A record that can be edited afterwards is not evidence, and the edit that
-- matters is never done by an attacker. It is done by the rep who wants the
-- note to read better before a review.
--
-- Correcting a mistake means adding a new entry saying so. That is how a
-- ledger works, and this table is a ledger.

DROP TRIGGER IF EXISTS lead_activities_append_only ON lead_activities;
CREATE TRIGGER lead_activities_append_only
  BEFORE UPDATE OR DELETE ON lead_activities
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();


-- ############################################################################
-- SECTION 8 — updated_at
-- ############################################################################

DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS units_set_updated_at ON units;
CREATE TRIGGER units_set_updated_at BEFORE UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS leads_set_updated_at ON leads;
CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS channel_partners_set_updated_at ON channel_partners;
CREATE TRIGGER channel_partners_set_updated_at BEFORE UPDATE ON channel_partners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS bookings_set_updated_at ON bookings;
CREATE TRIGGER bookings_set_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS payment_milestones_set_updated_at ON payment_milestones;
CREATE TRIGGER payment_milestones_set_updated_at BEFORE UPDATE ON payment_milestones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ############################################################################
-- SECTION 9 — GRANTS
-- ############################################################################
--
-- REVOKE before GRANT. An additive-only block is defeated by any prior
-- `GRANT ALL ON ALL TABLES`, which is the first thing most people run when a
-- query fails with "permission denied". Found the hard way in Phase 11.
--
-- ⚠️ NO DELETE ON `bookings`.
--
-- A booking is a commercial commitment. The correction for a wrong one is
-- `cancelled` with a reason — which keeps the history, keeps the audit trail,
-- and frees the unit through Section 4b. A DELETE would do the same thing to
-- the inventory while erasing the fact that it ever happened, which is
-- precisely what somebody covering up a double-sale would want.
--
-- ⚠️ NO DELETE ON `lead_activities` either. Section 7's trigger already
-- refuses; removing the privilege means the attempt fails at the door rather
-- than inside a transaction that has already done other work.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON projects           FROM ordence_app;
    REVOKE ALL ON units              FROM ordence_app;
    REVOKE ALL ON leads              FROM ordence_app;
    REVOKE ALL ON lead_activities    FROM ordence_app;
    REVOKE ALL ON channel_partners   FROM ordence_app;
    REVOKE ALL ON bookings           FROM ordence_app;
    REVOKE ALL ON payment_milestones FROM ordence_app;

    -- Soft-deleted, so no DELETE.
    GRANT SELECT, INSERT, UPDATE ON projects         TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON units            TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON leads            TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON channel_partners TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON bookings         TO ordence_app;

    -- Append-only.
    GRANT SELECT, INSERT ON lead_activities TO ordence_app;

    -- Milestones are a plan, and a plan gets redrawn. DELETE is legitimate
    -- here — the payments themselves live in the Phase 11 ledger, not in
    -- this table, so removing a milestone destroys no financial record.
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment_milestones TO ordence_app;

    GRANT EXECUTE ON FUNCTION release_expired_unit_holds(uuid) TO ordence_app;
  END IF;
END
$$;

-- == CHECK: PHASE 22 ROW-LEVEL SECURITY =====================================
SELECT
  CASE WHEN count(*) = 7
       THEN 'PASS: all 7 sales tables are ENABLE + FORCE'
       ELSE 'FAIL: only ' || count(*) || ' of 7 sales tables are ENABLE + FORCE'
  END AS check_sales_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relrowsecurity AND c.relforcerowsecurity
  AND c.relname IN ('projects','units','leads','lead_activities',
                    'channel_partners','bookings','payment_milestones');


-- == CHECK: THE DOUBLE-SALE INDEX ===========================================
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'bookings' AND indexname = 'bookings_one_live_per_unit'
  ) THEN 'PASS: one unit cannot carry two live bookings'
  ELSE  'FAIL: bookings_one_live_per_unit IS MISSING - two reps booking the same flat WILL both succeed'
  END AS check_no_double_sale;


-- == CHECK: NO UNIT IS CURRENTLY DOUBLE-SOLD ================================
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: no unit carries two live bookings'
       ELSE 'FAIL: ' || count(*) || ' unit(s) have been promised to more than one buyer'
  END AS check_no_existing_double_sale
FROM (
  SELECT unit_id FROM bookings
   WHERE status <> 'cancelled' AND unit_id IS NOT NULL
   GROUP BY unit_id HAVING count(*) > 1
) doubles;


-- == CHECK: CROSS-TENANT REFERENCE CONSTRAINTS ==============================
SELECT
  CASE WHEN count(*) = 13
       THEN 'PASS: all 13 composite foreign keys are present'
       ELSE 'FAIL: only ' || count(*) || ' of 13 composite foreign keys exist - a row can point at another tenant''s parent'
  END AS check_composite_fks
FROM pg_constraint
WHERE conname IN (
  'units_project_same_tenant','leads_project_same_tenant',
  'lead_activities_lead_same_tenant','bookings_unit_same_tenant',
  'bookings_lead_same_tenant','bookings_partner_same_tenant',
  'milestones_booking_same_tenant','leads_partner_same_tenant',
  'units_held_lead_same_tenant',
  -- The four edges into `users`, absent from the first version of this
  -- list -- which is precisely why the gap reported PASS for a phase.
  'leads_owner_same_tenant','units_held_by_same_tenant',
  'bookings_rep_same_tenant','lead_activities_user_same_tenant'
);


-- == CHECK: THE SALES GUARD TRIGGERS ARE ENABLED ============================
SELECT
  CASE WHEN count(*) = 5
       THEN 'PASS: all 5 sales guard triggers are installed and enabled'
       ELSE 'FAIL: only ' || count(*) || ' of 5 sales guard triggers are enabled'
  END AS check_sales_triggers
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgenabled::text = 'O'
  AND tgname IN ('bookings_unit_bookable','bookings_sync_unit','units_hold_valid',
                 'leads_cp_lock','lead_activities_append_only');


-- == CHECK: NO HELD UNIT IS MISSING ITS DEADLINE ============================
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every held unit has a deadline and a buyer'
       ELSE 'FAIL: ' || count(*) || ' held unit(s) will never release'
  END AS check_holds_complete
FROM units
WHERE status = 'held' AND (hold_until IS NULL OR held_for_lead_id IS NULL);


-- == CHECK: THE APPLICATION ROLE CAN ACTUALLY WORK ==========================
--
-- The inverse of every other check in this file. All of those ask "is the
-- app sufficiently restricted?". This one asks "is it able to function at
-- all?" — the question nobody thinks to ask, because on a database that
-- has been running a while the answer is always yes.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: no ordence_app role (expected on Neon)'
    WHEN has_table_privilege('ordence_app','contacts','SELECT')
     AND has_table_privilege('ordence_app','contacts','INSERT')
     AND has_table_privilege('ordence_app','leads','SELECT')
     AND has_table_privilege('ordence_app','bookings','INSERT')
      THEN 'PASS: the application role can read and write its own tables'
    ELSE 'FAIL: the app role lacks baseline privileges - EVERY request will '
         'fail with 42501 permission denied. Re-run this file from the top.'
  END AS check_baseline_privileges;
