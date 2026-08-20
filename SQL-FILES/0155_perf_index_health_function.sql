-- =====================================================================
-- 0155 — ordence_index_health(): name the indexes that cost and give nothing
-- Repo: app.ordence · Track F (performance) · Wave 16
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY A FUNCTION AND NOT A LIST
-- ══════════════════════════════════════════════════════════════════════
-- This database has 1,499 indexes across 319 tables. 102 of them are a
-- bare `(tenant_id)` index on a table that also has a wider index
-- beginning with `tenant_id`; 5 more are exact duplicates created twice
-- under two names by two migrations. 0156 and 0157 remove them.
--
-- A hand-written list of 107 index names in a migration is a list that
-- is wrong the week after it is written — six other tracks are editing
-- this repository right now, and every one of them can add an index. So
-- the rule is written down instead of the answer, and 0156, 0157 and
-- `scripts/perf/check-index-health.mjs` all read the same rule from the
-- same place.
--
-- ══════════════════════════════════════════════════════════════════════
-- THE THREE CATEGORIES, AND WHY EACH IS SAFE TO ACT ON
-- ══════════════════════════════════════════════════════════════════════
-- 'redundant-prefix'
--     A non-unique, non-partial index on `(tenant_id)` ALONE, on a table
--     that also has a non-partial index whose first key column is
--     `tenant_id` and which has more key columns.
--
--     B-TREE PREFIX RULE: any lookup the narrow index can serve, the
--     wide one serves by scanning the same leading column. The narrow
--     one contributes to no plan and costs a page write on every INSERT
--     and every non-HOT UPDATE. It is pure loss.
--
--     ⚠️ UNIQUE and PARTIAL indexes are EXCLUDED even when they look
--     redundant. A unique index is a CONSTRAINT, not an optimisation —
--     dropping it changes what the database permits. A partial index
--     serves queries the wide one cannot, because the planner may use it
--     only where it can prove the predicate.
--
-- 'exact-duplicate'
--     Same table, identical key columns in identical order, identical
--     predicate, identical uniqueness. One of the pair is reported; the
--     other is kept. Which one is kept is decided by name order so that
--     two runs agree.
--
-- 'missing-tenant-leading'
--     A table with a `tenant_id` column and RLS enabled, with NO valid
--     non-partial index whose first key column is `tenant_id`. Under RLS
--     every read of such a table acquires a `tenant_id` predicate no
--     index can serve, so every read is a sequential scan.
--
--     ⚠️ THIS CATEGORY IS REPORTED, NEVER ACTED ON AUTOMATICALLY. Adding
--     an index has a write cost that must be justified by a measured
--     plan — see `db/indexes/candidates.mjs` and
--     `scripts/perf/prove-indexes.mjs`, which rejected two of Track F's
--     own seven proposals and one of these very tables.
--
-- ORDER: must run BEFORE 0156 and 0157, which call it.
-- =====================================================================

DROP FUNCTION IF EXISTS public.ordence_index_health();

CREATE OR REPLACE FUNCTION public.ordence_index_health()
RETURNS TABLE (
  category    text,
  table_name  text,
  index_name  text,
  detail      text
)
LANGUAGE sql
STABLE
AS $$
  WITH ix AS (
    SELECT c.oid          AS reloid,
           c.relname::text AS tbl,
           ic.relname::text AS idx,
           i.indisunique,
           i.indisvalid,
           i.indpred IS NOT NULL AS is_partial,
           i.indnkeyatts AS nkeys,
           i.indkey::text AS keysig,
           coalesce(pg_get_expr(i.indpred, i.indrelid), '') AS pred,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum = i.indkey[0]) AS col1
      FROM pg_index i
      JOIN pg_class c   ON c.oid  = i.indrelid
      JOIN pg_class ic  ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  ),
  -- ⚠️ A constraint's index may never be dropped directly; Postgres
  -- refuses, and the refusal would abort the whole migration.
  constraint_backed AS (
    SELECT conindid FROM pg_constraint WHERE conindid <> 0
  ),
  redundant AS (
    SELECT 'redundant-prefix'::text AS category, a.tbl, a.idx,
           'superseded by ' || (
              SELECT string_agg(b.idx, ', ' ORDER BY b.idx) FROM ix b
               WHERE b.reloid = a.reloid AND b.col1 = 'tenant_id'
                 AND b.nkeys > 1 AND NOT b.is_partial AND b.indisvalid
           ) AS detail
      FROM ix a
     WHERE a.col1 = 'tenant_id' AND a.nkeys = 1
       AND NOT a.is_partial AND NOT a.indisunique AND a.indisvalid
       AND NOT EXISTS (SELECT 1 FROM constraint_backed cb
                        WHERE cb.conindid = (SELECT oid FROM pg_class WHERE relname = a.idx))
       AND EXISTS (SELECT 1 FROM ix b
                    WHERE b.reloid = a.reloid AND b.col1 = 'tenant_id'
                      AND b.nkeys > 1 AND NOT b.is_partial AND b.indisvalid)
  ),
  dup_groups AS (
    SELECT reloid, tbl, keysig, pred, indisunique,
           array_agg(idx ORDER BY idx) AS names,
           count(*) AS n
      FROM ix
     WHERE indisvalid
     GROUP BY reloid, tbl, keysig, pred, indisunique
    HAVING count(*) > 1
  ),
  duplicates AS (
    -- ⚠️ names[1] is KEPT. Everything after it is reported for removal,
    -- and the ordering is by name so two runs never disagree about which
    -- survives.
    SELECT 'exact-duplicate'::text AS category, d.tbl, u.name AS idx,
           'identical to ' || d.names[1] AS detail
      FROM dup_groups d
      CROSS JOIN LATERAL unnest(d.names[2:]) AS u(name)
     WHERE NOT EXISTS (SELECT 1 FROM constraint_backed cb
                        WHERE cb.conindid = (SELECT oid FROM pg_class WHERE relname = u.name))
  ),
  tenant_tables AS (
    SELECT c.oid, c.relname::text AS tbl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                         AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  ),
  missing AS (
    SELECT 'missing-tenant-leading'::text AS category, t.tbl, ''::text AS idx,
           'every tenant-scoped read of this table is a sequential scan'::text AS detail
      FROM tenant_tables t
     WHERE NOT EXISTS (
             SELECT 1 FROM ix b
              WHERE b.reloid = t.oid AND b.col1 = 'tenant_id'
                AND NOT b.is_partial AND b.indisvalid)
  )
  SELECT category, tbl, idx, detail FROM redundant
  UNION ALL
  SELECT category, tbl, idx, detail FROM duplicates
  UNION ALL
  SELECT category, tbl, idx, detail FROM missing
  ORDER BY 1, 2, 3;
$$;

COMMENT ON FUNCTION public.ordence_index_health() IS
  'Track F / 0155. Names indexes that cost writes and serve no plan, and tables '
  'under RLS with no index leading with tenant_id. The rule, not the answer: '
  '0156, 0157 and scripts/perf/check-index-health.mjs all read it from here.';

-- ---------------------------------------------------------------------
-- VERIFY. Not "does the function exist" — does it ANSWER, and does its
-- answer agree with the catalogue when asked a question with a known
-- result. A function that returns zero rows for every category would
-- pass an existence check and make 0156 and 0157 into no-ops.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_total     int;
  v_redundant int;
  v_dupes     int;
  v_missing   int;
  v_control   int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ordence_index_health') THEN
    RAISE EXCEPTION '0155 FAILED: ordence_index_health() was not created.';
  END IF;

  SELECT count(*) INTO v_total FROM public.ordence_index_health();
  SELECT count(*) INTO v_redundant
    FROM public.ordence_index_health() WHERE category = 'redundant-prefix';
  SELECT count(*) INTO v_dupes
    FROM public.ordence_index_health() WHERE category = 'exact-duplicate';
  SELECT count(*) INTO v_missing
    FROM public.ordence_index_health() WHERE category = 'missing-tenant-leading';

  -- 🔴 THE CONTROL. Counted straight from the catalogue, by hand, with
  -- the same rule. If the function and this disagree, the function is
  -- wrong and 0157 would drop the wrong indexes.
  SELECT count(*) INTO v_control
    FROM pg_index i
    JOIN pg_class c  ON c.oid  = i.indrelid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND i.indnkeyatts = 1 AND i.indpred IS NULL
     AND NOT i.indisunique AND i.indisvalid
     AND (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attnum = i.indkey[0]) = 'tenant_id'
     AND EXISTS (
           SELECT 1 FROM pg_index b
            WHERE b.indrelid = i.indrelid AND b.indnkeyatts > 1
              AND b.indpred IS NULL AND b.indisvalid
              AND (SELECT a2.attname FROM pg_attribute a2
                    WHERE a2.attrelid = b.indrelid AND a2.attnum = b.indkey[0]) = 'tenant_id');

  IF v_redundant <> v_control THEN
    RAISE EXCEPTION
      '0155 FAILED: ordence_index_health() reports % redundant-prefix indexes but an '
      'independent catalogue count finds %. The rule in the function does not match '
      'the rule in this check; do not run 0157 until they agree.', v_redundant, v_control;
  END IF;

  -- ⚠️ A floor with a reason, not a floor for its own sake. This
  -- database is known to carry ~100 redundant bare tenant indexes. Zero
  -- would mean the WITH clauses silently returned nothing — the
  -- `count(*) >= 10` failure in a new coat.
  IF v_total = 0 THEN
    RAISE EXCEPTION
      '0155 FAILED: ordence_index_health() returned no rows at all across three '
      'categories on a schema with 1,499 indexes. That is a broken query, not a '
      'clean schema.';
  END IF;

  RAISE NOTICE
    '0155 PASS: ordence_index_health() answers — % redundant-prefix (control: %), '
    '% exact-duplicate, % missing-tenant-leading.',
    v_redundant, v_control, v_dupes, v_missing;
END
$$;
