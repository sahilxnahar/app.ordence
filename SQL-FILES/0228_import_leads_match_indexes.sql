-- =====================================================================
-- 0228 — leads: the two generated columns the importer matches on
-- Repo: app.ordence · PHASE-4 (entities: crm) · block 0220–0229
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS
-- ══════════════════════════════════════════════════════════════════════
-- `leads.email_key` and `leads.phone_digits` already exist. They are
-- GENERATED ALWAYS columns, added precisely because +91 98765 43210,
-- 098765 43210 and 9876543210 are the same man and a match on the raw
-- text finds none of them.
--
-- 🔴 NOTHING INDEXES EITHER OF THEM. `leads` carries six indexes
-- (tenant, status, owner, follow-up, NRI, partner) and not one covers
-- the two columns whose entire purpose is identity. The lead importer
-- asks exactly one question of this table — "which of these enquiries do
-- I already have?" — and asks it against both columns, for up to 5,000
-- keys, on the PREVIEW path.
--
-- Without an index that is a sequential scan of every lead the workspace
-- has ever taken. A developer sales pipeline is one of the larger tables
-- in this product.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ THE PREDICATES EXCLUDE THE EMPTY STRING, AND THAT IS NOT TIDINESS
-- ══════════════════════════════════════════════════════════════════════
-- Both generated columns are `coalesce(..., '')`, so EVERY lead with no
-- email has `email_key = ''` and every lead with no phone has
-- `phone_digits = ''`. In a workspace of 50,000 leads that is one value
-- repeated tens of thousands of times — the least selective entry
-- possible, occupying most of the index and never usefully matched,
-- because a match on `''` would mean "this row is the same as every
-- other row that also has no email".
--
-- The writer refuses an empty key on its own account as well. Two layers,
-- because a query that returns the whole table under `update` mode is
-- not a slow import — it is one enquiry's details written over thousands
-- of other people's.
--
-- ⚠️ AND NEITHER IS UNIQUE. Two leads may legitimately share a phone
-- number (a couple enquiring separately, the same buyer twice before
-- anybody merged them), and `leads.duplicate_of` exists precisely because
-- this product records a decided duplicate rather than preventing one. A
-- unique index here would refuse a lead the product is designed to
-- accept, and would abort on live data.
--
-- ORDER: safe before or after the code push. Indexes only.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_import_email_match_idx
    ON public.leads (tenant_id, email_key)
    WHERE deleted_at IS NULL AND email_key <> '';

COMMENT ON INDEX public.leads_import_email_match_idx IS
  'PHASE-4 / 0228. The lead importer''s strong natural key. email_key is '
  'GENERATED ALWAYS AS lower(btrim(coalesce(email,''''))), so the empty string '
  'means "no email" and is excluded rather than indexed tens of thousands of times.';

CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_import_phone_match_idx
    ON public.leads (tenant_id, phone_digits)
    WHERE deleted_at IS NULL AND phone_digits <> '';

COMMENT ON INDEX public.leads_import_phone_match_idx IS
  'PHASE-4 / 0228. The lead importer''s second natural key: the last ten digits '
  'of the phone, as the database itself computes them. Matching on the raw phone '
  'column instead finds none of +91 98765 43210 / 098765 43210 / 9876543210.';

-- =====================================================================
-- ⚠️ THE FILE CHECKS ITSELF, INCLUDING THE PREDICATE. An index built
--    without its WHERE clause satisfies "the index exists" and throws
--    away the reason it was written.
-- =====================================================================
DO $$
DECLARE
  v_def   text;
  v_valid boolean;
  v_ready boolean;
  v_name  text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['leads_import_email_match_idx', 'leads_import_phone_match_idx']
  LOOP
    SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready
      INTO v_def, v_valid, v_ready
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = v_name;

    IF v_def IS NULL THEN
      RAISE EXCEPTION '0228 FAILED: % does not exist.', v_name;
    END IF;
    IF NOT v_valid OR NOT v_ready THEN
      RAISE EXCEPTION
        '0228 FAILED: % is INVALID (indisvalid=%, indisready=%). An interrupted '
        'CONCURRENTLY build leaves the index behind and unusable. '
        'DROP INDEX CONCURRENTLY %, then re-run.', v_name, v_valid, v_ready, v_name;
    END IF;
    IF v_def !~ 'WHERE' OR v_def !~ 'deleted_at IS NULL' THEN
      RAISE EXCEPTION
        '0228 FAILED: % carries no live-rows predicate. Definition: %', v_name, v_def;
    END IF;
    IF v_def !~ '<> ''''::text' AND v_def !~ '<> ''''' THEN
      RAISE EXCEPTION
        '0228 FAILED: % indexes the empty string, which means "no email" / "no '
        'phone" and matches every such row against every other. Definition: %',
        v_name, v_def;
    END IF;
  END LOOP;

  RAISE NOTICE '0228 PASS: both lead import-match indexes are present, valid and carry their predicates.';
END
$$;
