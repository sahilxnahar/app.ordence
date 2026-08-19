-- ============================================================================
-- Ordence — Phase 9: External Client Portal
-- Version: v0.9.0-alpha
--
-- Run AFTER `npx drizzle-kit push` has created `portal_links` and
-- `contract_signatures`.
--
-- Contents:
--   1. Row-Level Security on both new tables
--   2. Token-hash immutability
--   3. Append-only protection on contract_signatures
--   4. Expiry sanity constraint
--   5. Verification queries
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- `portal_links` is the ONLY table in this platform whose rows are consulted
-- WITHOUT a tenant context. It has to be: a visitor arriving at
-- /portal/<token> has no session, so the application cannot know which tenant
-- to pin until it has resolved the token itself. That single lookup runs
-- through `withPlatformScope()`, and everything after it is pinned to the
-- tenant the token resolved to.
--
-- That makes the policies below slightly unusual in purpose. They are NOT what
-- protects the portal from an anonymous visitor — the token's 256 bits of
-- entropy and the application's expiry/revocation checks do that. What these
-- policies protect against is TENANT A READING OR FORGING TENANT B's LINKS
-- through the ordinary authenticated application: the manager UI, a server
-- action, a future report.
--
-- Both threats are real. They need different mechanisms, and confusing them is
-- how one of them ends up unprotected.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
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
-- SECTION 2 — THE TOKEN HASH IS IMMUTABLE
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
-- SECTION 3 — SIGNATURES ARE APPEND-ONLY
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
-- SECTION 4 — A LINK CANNOT BE BORN EXPIRED OR IMMORTAL
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
-- SECTION 5 — VERIFICATION
-- ############################################################################
-- Each query prints PASS or FAIL. Read the output; do not assume.

-- Check 1 — RLS enabled AND forced on both tables.
SELECT
  CASE WHEN count(*) = 2
       THEN 'PASS: portal_links and contract_signatures both have RLS enabled and FORCED'
       ELSE 'FAIL: only ' || count(*) || ' of 2 portal tables fully protected'
  END AS check_1_rls
FROM pg_class
WHERE relname IN ('portal_links', 'contract_signatures')
  AND relrowsecurity = true
  AND relforcerowsecurity = true;

-- Check 2 — both policies define USING and WITH CHECK.
SELECT
  CASE WHEN count(*) = 2
       THEN 'PASS: both portal policies cover read and write'
       ELSE 'FAIL: expected 2 complete policies, found ' || count(*)
  END AS check_2_policies
FROM pg_policies
WHERE tablename IN ('portal_links', 'contract_signatures')
  AND qual IS NOT NULL
  AND with_check IS NOT NULL;

-- Check 3 — the tamper guard is installed.
SELECT
  CASE WHEN count(*) = 1
       THEN 'PASS: portal_links tamper guard installed'
       ELSE 'FAIL: portal_links_tamper_guard missing'
  END AS check_3_tamper_guard
FROM pg_trigger
WHERE tgrelid = 'portal_links'::regclass AND tgname = 'portal_links_tamper_guard';

-- Check 4 — signatures are append-only (both triggers).
SELECT
  CASE WHEN count(*) = 2
       THEN 'PASS: contract_signatures is append-only'
       ELSE 'FAIL: expected 2 append-only triggers, found ' || count(*)
  END AS check_4_append_only
FROM pg_trigger
WHERE tgrelid = 'contract_signatures'::regclass
  AND tgname IN ('contract_signatures_no_update', 'contract_signatures_no_delete');

-- Check 5 — the token hash index is UNIQUE.
-- Not merely a performance matter: uniqueness makes a hash collision
-- impossible to insert rather than just improbable.
SELECT
  CASE WHEN count(*) = 1
       THEN 'PASS: portal_links.token_hash is UNIQUE'
       ELSE 'FAIL: unique index on token_hash missing'
  END AS check_5_token_unique
FROM pg_indexes
WHERE tablename = 'portal_links' AND indexname = 'portal_links_token_hash_unique';

-- Check 6 — one signature per link, enforced by the database.
SELECT
  CASE WHEN count(*) = 1
       THEN 'PASS: a portal link can produce at most ONE signature'
       ELSE 'FAIL: unique index on portal_link_id missing — replay is possible'
  END AS check_6_one_signature
FROM pg_indexes
WHERE tablename = 'contract_signatures' AND indexname = 'contract_signatures_link_unique';

-- Check 7 — total RLS coverage (23 before Phase 9, 25 now).
SELECT
  CASE WHEN count(*) >= 25
       THEN 'PASS: ' || count(*) || ' tables protected by RLS'
       ELSE 'FAIL: only ' || count(*) || ' tables protected — expected 25+'
  END AS check_7_coverage
FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = true;
