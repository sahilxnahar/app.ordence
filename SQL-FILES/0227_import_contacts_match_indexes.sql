-- =====================================================================
-- 0227 — contacts: the two expressions the importer matches on
-- Repo: app.ordence · PHASE-4 (entities: crm) · block 0220–0229
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS
-- ══════════════════════════════════════════════════════════════════════
-- `server/import/writers/crm/contacts.ts` answers one question per
-- import: "which of these people do I already have?". It asks it in two
-- ways, because the entity declares two natural keys —
--
--   ① lower(btrim(email))                       — the strong key
--   ② the full name, whitespace-collapsed, qualified by the company name
--                                               — the weak fallback
--
-- Neither is indexable today. `contacts_tenant_email_unique` is on the
-- RAW column, and the importer matches case-insensitively on purpose (a
-- customer's spreadsheet spells the address however the customer spells
-- it), so the existing index cannot serve the query. The name index
-- `contacts_tenant_name_idx` is on (tenant_id, last_name, first_name),
-- raw and in the wrong order for a match on the assembled name.
--
-- 🔴 THE CONSEQUENCE IS NOT SLOWNESS, IT IS ABANDONMENT. The duplicate
-- check runs once per import over up to 5,000 keys. On a workspace with
-- 200,000 contacts that is a sequential scan plus a join, on the PREVIEW
-- path, while somebody watches a spinner — and the way a check like that
-- gets "fixed" under pressure is by being removed, at which point every
-- re-run duplicates the workspace. This product's own history is the
-- argument: re-running the whole file is the NORMAL second action.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ WHY THE NAME EXPRESSION IS `a || ' ' || coalesce(b,'')` AND NOT
--    `concat_ws(' ', a, b)`, WHICH READS BETTER
-- ══════════════════════════════════════════════════════════════════════
-- `concat_ws` is STABLE, not IMMUTABLE, and Postgres refuses it in an
-- index expression:
--
--   ERROR:  functions in index expression must be marked IMMUTABLE
--
-- (executed, not assumed). So the writer uses the immutable form, and
-- this file indexes the SAME expression, character for character. If the
-- two ever diverge the index is silently not used — nothing fails, the
-- import merely gets slower every year.
--
-- The `coalesce` is not decoration either: `'Rajesh' || ' ' || NULL` is
-- NULL, so without it every contact with no surname would be missing
-- from the index AND from the comparison.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ NEITHER INDEX IS UNIQUE, DELIBERATELY
-- ══════════════════════════════════════════════════════════════════════
-- A unique index on lower(email) would be the stronger thing to want and
-- it would FAIL TO BUILD on any workspace that already holds "A@x.com"
-- and "a@x.com" — both of which the current case-sensitive unique index
-- permits. A migration that aborts on live data at 2am is worse than a
-- non-unique index, and de-duplicating a customer's contacts is a
-- decision for the customer, not for a migration.
--
-- ORDER: safe before or after the code push. Indexes only; no data is
-- read, written or moved.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_import_email_match_idx
    ON public.contacts (tenant_id, lower(btrim(email)))
    WHERE deleted_at IS NULL AND email IS NOT NULL;

COMMENT ON INDEX public.contacts_import_email_match_idx IS
  'PHASE-4 / 0227. The importer''s strong natural key: lower(btrim(email)), '
  'case-insensitively, live rows only. The existing contacts_tenant_email_unique '
  'is on the raw column and cannot serve a case-insensitive match.';

CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_import_name_match_idx
    ON public.contacts (
      tenant_id,
      lower(regexp_replace(btrim(first_name || ' ' || coalesce(last_name, '')), '\s+', ' ', 'g'))
    )
    WHERE deleted_at IS NULL;

COMMENT ON INDEX public.contacts_import_name_match_idx IS
  'PHASE-4 / 0227. The importer''s weak fallback key, the half of it that lives '
  'on this table: the whitespace-collapsed lower-cased full name. The company '
  'half comes from the join. Expression must stay identical to the one in '
  'server/import/writers/crm/contacts.ts or the index is silently unused.';

-- =====================================================================
-- ⚠️ THE FILE CHECKS ITSELF. A migration that reports success without
--    having produced what it promised is the defect shape this project
--    has found more than thirty times, including in its own checkers.
-- =====================================================================
DO $$
DECLARE
  v_def   text;
  v_valid boolean;
  v_ready boolean;
BEGIN
  FOR v_def, v_valid, v_ready IN
    SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname IN ('contacts_import_email_match_idx', 'contacts_import_name_match_idx')
  LOOP
    IF NOT v_valid OR NOT v_ready THEN
      RAISE EXCEPTION
        '0227 FAILED: an index is INVALID (indisvalid=%, indisready=%). '
        'A CONCURRENTLY build that was interrupted leaves the index behind and '
        'unusable. DROP INDEX CONCURRENTLY it, then re-run. Definition: %',
        v_valid, v_ready, v_def;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'contacts_import_email_match_idx') THEN
    RAISE EXCEPTION '0227 FAILED: contacts_import_email_match_idx does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'contacts_import_name_match_idx') THEN
    RAISE EXCEPTION '0227 FAILED: contacts_import_name_match_idx does not exist.';
  END IF;

  -- 🔴 THE EXPRESSION IS THE INDEX. An index on the raw column under
  -- these names would satisfy every check above and serve neither query.
  SELECT pg_get_indexdef(i.indexrelid) INTO v_def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'contacts_import_email_match_idx';
  IF v_def !~* 'lower\(btrim\(' THEN
    RAISE EXCEPTION
      '0227 FAILED: contacts_import_email_match_idx does not carry lower(btrim(email)). '
      'Definition: %', v_def;
  END IF;

  SELECT pg_get_indexdef(i.indexrelid) INTO v_def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'contacts_import_name_match_idx';
  -- ⚠️ `!~*`, CASE-INSENSITIVELY. `pg_get_indexdef` prints the function
  -- as `COALESCE` even though the file wrote `coalesce`, so the
  -- case-sensitive form of this check FAILED a correct index on the
  -- first execution of this file. Found by running it, not by reading it.
  IF v_def !~* 'regexp_replace' OR v_def !~* 'coalesce' THEN
    RAISE EXCEPTION
      '0227 FAILED: contacts_import_name_match_idx is not the collapsed-name '
      'expression. Definition: %', v_def;
  END IF;

  RAISE NOTICE '0227 PASS: both contact import-match indexes are present, valid and carry their expressions.';
END
$$;
