-- ============================================================================
-- Ordence — Phase 8: Document Storage
-- Version: v0.8.0-alpha
--
-- Run AFTER `npx drizzle-kit push` has created the `documents` table.
--
-- Contents:
--   1. Row-Level Security on `documents`
--   2. Guard against re-pointing a document at another tenant
--   3. Guard against re-pointing a document at another parent record
--   4. Verification queries
--
-- ============================================================================
-- ⚠️  WHAT THIS FILE PROTECTS, AND WHAT IT CANNOT PROTECT
-- ============================================================================
-- Everything below secures ROWS IN POSTGRES. The actual file bytes live in
-- Vercel Blob, which has never heard of `app.current_tenant_id`.
--
-- If a file is uploaded with `access: 'public'`, its URL is readable by
-- anyone who ever sees it — a forwarded email, a browser history, a proxy
-- log — and NOTHING in this file changes that.
--
-- The application therefore uploads with `access: 'private'` and streams
-- downloads through `/api/documents/[id]/download`, which re-checks the
-- session and tenant on every request. These policies and that private
-- access are two halves of one control. Either half alone leaks files.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns the policy on for ordinary roles.
-- FORCE additionally applies it to the table's OWNER.
--
-- Without FORCE, the role that created the table bypasses every policy — and
-- in a great many deployments the application connects as exactly that role.
-- The isolation would then be decorative. FORCE is not optional here.
--
-- Note the policy is intentionally NOT `FOR SELECT` only. A single policy with
-- both USING and WITH CHECK covers all four verbs:
--   USING       — which existing rows this tenant may see, update or delete
--   WITH CHECK  — which new or modified rows this tenant may write
-- A USING-only policy would let a tenant INSERT a row stamped with someone
-- else's tenant_id, which they could then never see but which would still be
-- there, attached to another tenant's contract.

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
CREATE POLICY documents_tenant_isolation ON documents
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 2 — TENANT REASSIGNMENT GUARD
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   The policy above compares `tenant_id` to the session's tenant on both read
--   and write. An UPDATE that changes `tenant_id` from A to B is evaluated with
--   USING against the OLD row and WITH CHECK against the NEW one — so tenant A
--   cannot hand a row to tenant B while acting as A.
--
--   But `tenant_id` is still a mutable column. Any future code path that runs
--   with the tenant setting unset or elevated (a migration, a background job, a
--   superuser console) could rewrite it. A document is evidence; silently
--   moving evidence between tenants must not be a thing that can happen by
--   accident.
--
-- THE FIX:
--   The column is immutable after insert. Moving a document to another tenant
--   requires deleting it and uploading it again — which leaves a trail.

CREATE OR REPLACE FUNCTION prevent_document_tenant_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'A document cannot be moved between tenants (attempted % -> %)',
      OLD.tenant_id, NEW.tenant_id
      USING ERRCODE = '42501';   -- insufficient_privilege
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_tenant_immutable ON documents;
CREATE TRIGGER documents_tenant_immutable
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION prevent_document_tenant_change();


-- ############################################################################
-- SECTION 3 — PARENT REASSIGNMENT GUARD
-- ############################################################################
--
-- The `(entity_type, entity_id)` link is polymorphic, so PostgreSQL cannot
-- enforce it with a foreign key — it does not know which table to look in.
-- `saveDocumentRecord` checks that the parent exists and belongs to the
-- caller's tenant BEFORE inserting.
--
-- That check happens once, at insert. This trigger makes it stick: the parent
-- link is immutable afterwards, so a later UPDATE cannot silently re-attach a
-- signed agreement from one contract to another without re-running the
-- ownership check. Re-filing a document means deleting and re-uploading it.

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

  -- The blob pathname identifies the object in storage. Rewriting it would
  -- point this row at a DIFFERENT file while keeping the same audit history,
  -- and a later delete would remove an object this row never described.
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
-- SECTION 4 — VERIFICATION
-- ############################################################################
-- Each query prints PASS or FAIL. Read the output; do not assume.

-- Check 1 — RLS is enabled AND forced.
SELECT
  CASE WHEN relrowsecurity AND relforcerowsecurity
       THEN 'PASS: documents has RLS enabled and FORCED'
       ELSE 'FAIL: documents RLS incomplete — enabled=' || relrowsecurity
            || ' forced=' || relforcerowsecurity
  END AS check_1_rls
FROM pg_class WHERE relname = 'documents';

-- Check 2 — the isolation policy exists with BOTH USING and WITH CHECK.
SELECT
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS: documents_tenant_isolation covers read and write'
       ELSE 'FAIL: policy is missing USING or WITH CHECK'
  END AS check_2_policy
FROM pg_policies
WHERE tablename = 'documents' AND policyname = 'documents_tenant_isolation';

-- Check 3 — both immutability triggers are installed.
SELECT
  CASE WHEN count(*) = 2
       THEN 'PASS: both document immutability triggers installed'
       ELSE 'FAIL: expected 2 triggers, found ' || count(*)
  END AS check_3_triggers
FROM pg_trigger
WHERE tgrelid = 'documents'::regclass
  AND tgname IN ('documents_tenant_immutable', 'documents_parent_immutable');

-- Check 4 — the entity lookup index exists (correctness of plans, not security).
SELECT
  CASE WHEN count(*) >= 1
       THEN 'PASS: documents entity index present'
       ELSE 'FAIL: documents_entity_idx missing'
  END AS check_4_index
FROM pg_indexes
WHERE tablename = 'documents' AND indexname = 'documents_entity_idx';

-- Check 5 — total RLS coverage across the platform (22 before Phase 8, 23 now).
SELECT
  CASE WHEN count(*) >= 23
       THEN 'PASS: ' || count(*) || ' tables protected by RLS'
       ELSE 'FAIL: only ' || count(*) || ' tables protected — expected 23+'
  END AS check_5_coverage
FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = true;
