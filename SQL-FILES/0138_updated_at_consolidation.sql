-- ############################################################################
-- 0138 — ONE `updated_at` FUNCTION, AND THE STATE REPAIR 0126 COULD NOT DO
--        (Wave 15 / Track C)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- PART ONE: THE CONSOLIDATION 0126 RECORDED AS OUTSTANDING
-- ══════════════════════════════════════════════════════════════════════════
-- Two functions do one job:
--
--     set_updated_at()            159 tables
--     ordence_touch_updated_at()   19 tables
--
-- and their bodies are the same statement written twice:
--
--     BEGIN NEW.updated_at := now(); RETURN NEW; END
--     BEGIN NEW.updated_at =  now(); RETURN NEW; END
--
-- 0126's own header names this as the defect underneath its defect, and says
-- why it did not fix it there: "dropping one would rewrite 19 trigger
-- definitions in a file about coverage, and a migration that does two things
-- is a migration nobody can revert cleanly." That reasoning was right. This
-- is the file it deferred to.
--
-- ⚠️ THE COST OF TWO NAMES IS NOT AESTHETIC. It has produced a wrong census
-- twice:
--   · 0126's first draft knew one function, saw the other 19 tables as
--     uncovered, and attached a SECOND trigger to twelve of them.
--   · Every name-keyed census (0017 and 0122 key on the trigger NAME) calls
--     `sales_orders` uncovered, because 0028 named its trigger
--     `trg_touch_sales_orders` rather than `sales_orders_set_updated_at`.
--
-- After this file there is one function and one trigger-naming convention,
-- so both classes of mistake stop being possible rather than being caught.
--
-- ══════════════════════════════════════════════════════════════════════════
-- PART TWO: 0126 SECTION 1 HAD NEVER RUN, ANYWHERE, AND LEFT STATE BEHIND
-- ══════════════════════════════════════════════════════════════════════════
-- `0126_updated_at_coverage.sql` Section 1 — the block that decides which
-- tables are append-only and therefore must NOT get a BEFORE UPDATE trigger
-- — failed on every database it was ever applied to:
--
--     ERROR:  relation "collations" does not exist
--
-- It called `has_any_column_privilege(name, TEXT, text)`, which resolves a
-- table NAME through `search_path`; the planner pushes that filter down onto
-- a `Seq Scan on pg_class` and evaluates it for every relation in every
-- schema, `information_schema.collations` included. The repair is in 0126
-- itself — it has to be, because CI applies the numbered files with
-- `ON_ERROR_STOP=1` and therefore never reaches any later file. See the
-- comment block there.
--
-- 🔴 WHAT THAT LEFT BEHIND, AND WHY A CODE FIX ALONE IS NOT ENOUGH.
-- With an empty exclusion list, 0126 Section 2 swept `plans` — a table on
-- which the application role holds no UPDATE privilege at all — and attached
-- `plans_set_updated_at`, a BEFORE UPDATE trigger that can never fire. 0126's
-- header states plainly that such a trigger "would suggest the row is
-- updatable", which is exactly the misreading it exists to prevent.
--
-- Production already ran the broken version. A corrected 0126 fixes new
-- databases; only a forward migration fixes the ones that exist. That is
-- this file's Section 1.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⭐ THE PROOF THIS FILE OWES: THE COVERED COUNT MUST NOT FALL
-- ══════════════════════════════════════════════════════════════════════════
-- Rewriting 19 triggers and dropping a function is exactly the kind of change
-- that can quietly lose coverage — one DROP that outruns its CREATE and 19
-- tables stop maintaining `updated_at`, with no error and no symptom until
-- somebody reads a "last modified" column a year later.
--
-- So the before-count is written to `updated_at_consolidation_audit` BEFORE
-- anything is touched, and Section 4 compares the after-count to the stored
-- row and RAISES on any decrease. The number is persisted rather than held in
-- a variable because this file has no file-level transaction — each statement
-- stands alone, the way the Neon console sends them — and because a proof
-- somebody can re-read next year is worth more than one that scrolled past.
--
-- IS THERE DATA LOSS?  No rows. Triggers are dropped and recreated in the
-- same statement, and one function is dropped after nothing references it.
--
-- RUN ORDER
-- ---------
-- After 0126 and after 0028–0031 (which create `ordence_touch_updated_at()`
-- and its 19 triggers). SQL FIRST, then the code — although nothing in the
-- application names either function.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent; running
-- this file twice is a no-op the second time.
--
-- RLS
-- ---
-- `updated_at_consolidation_audit` is platform data about the schema, carries
-- no `tenant_id`, and follows `updated_at_exclusions`: no RLS, readable by
-- the maintenance role, not writable by the application.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 0 — RECORD THE BEFORE STATE, BEFORE ANYTHING MOVES
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.updated_at_consolidation_audit (
  id                   bigserial PRIMARY KEY,
  observed_at          timestamptz NOT NULL DEFAULT now(),
  phase                text        NOT NULL,
  tables_with_column   integer     NOT NULL,
  tables_covered       integer     NOT NULL,
  covered_by_set       integer     NOT NULL,
  covered_by_touch     integer     NOT NULL,
  excluded             integer     NOT NULL
);

COMMENT ON TABLE public.updated_at_consolidation_audit IS
  'Before/after census for 0138. The "after" row is compared to the "before" '
  'row by 0138 Section 4, which RAISES if coverage fell. Kept rather than '
  'discarded so the proof can be re-read: SELECT * FROM '
  'updated_at_consolidation_audit ORDER BY id.';

CREATE OR REPLACE FUNCTION public.updated_at_census()
RETURNS TABLE (
  -- ⚠️ "with_column" means "carries an updated_at column AND is not
  -- excluded" — i.e. the set of tables that are supposed to have a trigger.
  -- See the comment on the `cols` CTE for why the exclusions come out here
  -- rather than at the comparison.
  tables_with_column integer,
  tables_covered     integer,
  covered_by_set     integer,
  covered_by_touch   integer,
  excluded           integer
)
LANGUAGE sql
STABLE
AS $fn$
  -- ⚠️ EXCLUDED TABLES ARE OUT OF THE COVERAGE NUMBERS ENTIRELY, AND THIS
  -- DETAIL IS LOAD-BEARING. Section 1 deliberately REMOVES a trigger from an
  -- excluded table. Counting that table as "covered" beforehand and not
  -- afterwards makes the before/after comparison in Section 4 read as a
  -- coverage regression — which it is not — and the first instinct on seeing
  -- that would be to weaken the assertion. Measured: without this clause the
  -- census reports 178 → 177 and Section 4 fails on a correct run. The
  -- denominator has to be "tables that are supposed to have a trigger".
  WITH cols AS (
    SELECT c.oid, c.relname::text AS tbl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'updated_at'
                      AND a.attnum > 0 AND NOT a.attisdropped)
       AND c.relname NOT IN (SELECT e.table_name FROM updated_at_exclusions e)
  ),
  -- ⭐ KEYED ON THE FUNCTION, NEVER ON THE TRIGGER NAME. That is 0126's one
  -- correct instinct and the reason its coverage number was right even while
  -- half the file had not run.
  trig AS (
    SELECT cols.tbl, pp.proname::text AS fn
      FROM cols
      JOIN pg_trigger tg ON tg.tgrelid = cols.oid AND NOT tg.tgisinternal
      JOIN pg_proc    pp ON pp.oid = tg.tgfoid
     WHERE pp.proname IN ('set_updated_at', 'ordence_touch_updated_at')
  )
  SELECT
    (SELECT count(*) FROM cols)::integer,
    (SELECT count(DISTINCT tbl) FROM trig)::integer,
    (SELECT count(DISTINCT tbl) FROM trig WHERE fn = 'set_updated_at')::integer,
    (SELECT count(DISTINCT tbl) FROM trig WHERE fn = 'ordence_touch_updated_at')::integer,
    (SELECT count(*) FROM updated_at_exclusions)::integer;
$fn$;

-- ⚠️ ONE "before" ROW PER RUN, AND ONLY IF THERE IS WORK TO DO. Re-running
-- this file on a consolidated database must not append a second, misleading
-- pair of rows suggesting the consolidation happened twice.
INSERT INTO public.updated_at_consolidation_audit
  (phase, tables_with_column, tables_covered, covered_by_set, covered_by_touch, excluded)
SELECT 'before', c.tables_with_column, c.tables_covered, c.covered_by_set,
       c.covered_by_touch, c.excluded
  FROM updated_at_census() c
 WHERE c.covered_by_touch > 0
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'ordence_touch_updated_at');


-- ----------------------------------------------------------------------------
-- SECTION 1 — THE STATE REPAIR: TRIGGERS THE BROKEN 0126 SHOULD NEVER HAVE
--             ATTACHED
-- ----------------------------------------------------------------------------
--
-- ⚠️ NARROW ON PURPOSE. It removes ONLY a trigger that (a) is on a table now
-- correctly listed in `updated_at_exclusions`, (b) carries the exact name
-- 0126 Section 2 generates, `<table>_set_updated_at`, and (c) executes
-- `set_updated_at()`. A trigger somebody attached deliberately under another
-- name is left alone, because this file cannot tell a deliberate one from an
-- accidental one and guessing in the destructive direction is the expensive
-- mistake.

DO $$
DECLARE
  r       record;
  removed text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT e.table_name AS tbl
      FROM updated_at_exclusions e
      JOIN pg_class c   ON c.relname = e.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_trigger tg ON tg.tgrelid = c.oid AND NOT tg.tgisinternal
      JOIN pg_proc pp    ON pp.oid = tg.tgfoid
     WHERE pp.proname = 'set_updated_at'
       AND tg.tgname  = e.table_name || '_set_updated_at'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
                   r.tbl || '_set_updated_at', r.tbl);
    removed := removed || r.tbl;
  END LOOP;

  IF cardinality(removed) > 0 THEN
    RAISE NOTICE
      '0138: removed % dead BEFORE UPDATE trigger(s) that the broken 0126 '
      'Section 1 allowed onto append-only tables: %. The application role '
      'holds no UPDATE privilege on any of them, so the trigger could never '
      'have fired.',
      cardinality(removed), array_to_string(removed, ', ');
  ELSE
    RAISE NOTICE '0138: no dead updated_at triggers to remove.';
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 2 — REWRITE THE 19 ONTO ONE FUNCTION
-- ----------------------------------------------------------------------------
--
-- ⚠️ CREATE BEFORE DROP, PER TABLE, IN ONE STATEMENT. PostgreSQL cannot
-- repoint a trigger at a different function; there is no ALTER for it. So
-- each table gets the new trigger created first and the old one dropped
-- second, inside the same `DO` block — which is one statement, so it is
-- atomic even in the Neon console where each statement arrives on its own
-- connection. Do it the other way round and a failure halfway through leaves
-- a table with no `updated_at` trigger at all and no error to say so.
--
-- ⭐ AND THE NEW TRIGGER TAKES THE CANONICAL NAME `<table>_set_updated_at`.
-- The second naming convention (`trg_touch_<table>`) is the reason a
-- name-keyed census called `sales_orders` uncovered. One function AND one
-- name, or the next census is wrong for the other reason.

DO $$
DECLARE
  r       record;
  moved   text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'ordence_touch_updated_at') THEN
    RAISE NOTICE '0138: ordence_touch_updated_at() is already gone — nothing to consolidate.';
    RETURN;
  END IF;

  FOR r IN
    SELECT c.relname::text AS tbl, tg.tgname::text AS trg
      FROM pg_trigger tg
      JOIN pg_class c     ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc pp     ON pp.oid = tg.tgfoid
     WHERE NOT tg.tgisinternal
       AND n.nspname = 'public'
       AND pp.proname = 'ordence_touch_updated_at'
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      r.tbl || '_set_updated_at', r.tbl);
    EXECUTE format('DROP TRIGGER %I ON public.%I', r.trg, r.tbl);
    moved := moved || r.tbl;
  END LOOP;

  RAISE NOTICE '0138: rewrote % trigger(s) from ordence_touch_updated_at() onto '
               'set_updated_at(): %.',
    cardinality(moved), array_to_string(moved, ', ');
END
$$;


-- ⚠️ NO `CASCADE`, AND THAT IS THE WHOLE SAFETY OF THIS STATEMENT.
-- `DROP FUNCTION … CASCADE` would silently delete any trigger Section 2
-- missed — turning "I did not find all the dependants" into "there are no
-- dependants any more", which is the same class of mistake as a recursive
-- `sed`. A plain DROP fails loudly with the dependant's name, which is
-- exactly what a reader needs.
DROP FUNCTION IF EXISTS public.ordence_touch_updated_at();


-- ----------------------------------------------------------------------------
-- SECTION 3 — THE AFTER READING
-- ----------------------------------------------------------------------------

INSERT INTO public.updated_at_consolidation_audit
  (phase, tables_with_column, tables_covered, covered_by_set, covered_by_touch, excluded)
SELECT 'after', c.tables_with_column, c.tables_covered, c.covered_by_set,
       c.covered_by_touch, c.excluded
  FROM updated_at_census() c
 WHERE EXISTS (SELECT 1 FROM updated_at_consolidation_audit a WHERE a.phase = 'before')
   AND (SELECT count(*) FROM updated_at_consolidation_audit a WHERE a.phase = 'after')
       < (SELECT count(*) FROM updated_at_consolidation_audit a WHERE a.phase = 'before');

DO $$
BEGIN
  REVOKE ALL ON public.updated_at_consolidation_audit FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.updated_at_census() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON public.updated_at_consolidation_audit FROM ordence_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT SELECT ON public.updated_at_consolidation_audit TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.updated_at_census() TO ordence_maintenance;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 4 — VERIFY. THE COUNT MUST NOT HAVE FALLEN.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  before_row  record;
  after_c     record;
  uncovered   text[];
  doubled     text[];
  problems    text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO after_c FROM updated_at_census();

  /* -- 1. one function, and only one -------------------------------- */
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'ordence_touch_updated_at') THEN
    problems := problems || 'ordence_touch_updated_at() still exists — the DROP did not take.'::text;
  END IF;

  IF after_c.covered_by_touch <> 0 THEN
    problems := problems || format(
      '%s table(s) still run a trigger on ordence_touch_updated_at().',
      after_c.covered_by_touch);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'set_updated_at') THEN
    problems := problems || 'set_updated_at() does not exist — the surviving function is gone.'::text;
  END IF;

  /* -- 2. coverage did not fall -------------------------------------- */
  SELECT * INTO before_row
    FROM updated_at_consolidation_audit
   WHERE phase = 'before' ORDER BY id DESC LIMIT 1;

  IF before_row IS NULL THEN
    -- Nothing to compare against means this file has already run to
    -- completion on this database, OR it ran on a database that never had
    -- the second function. Both are fine; say which rather than skip.
    RAISE NOTICE
      '0138: no "before" reading recorded, so this database never carried '
      'ordence_touch_updated_at(). Nothing was consolidated.';
  ELSIF after_c.tables_covered < before_row.tables_covered THEN
    problems := problems || format(
      'COVERAGE FELL: %s table(s) had a working updated_at before this file '
      'and %s do now. %s table(s) stopped being maintained and nothing else '
      'would have said so.',
      before_row.tables_covered, after_c.tables_covered,
      before_row.tables_covered - after_c.tables_covered);
  END IF;

  /* -- 3. nothing acquired a second trigger --------------------------- */
  SELECT coalesce(array_agg(t.tbl ORDER BY t.tbl), ARRAY[]::text[]) INTO doubled
    FROM (
      SELECT c.relname::text AS tbl
        FROM pg_trigger tg
        JOIN pg_class c     ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc pp     ON pp.oid = tg.tgfoid
       WHERE NOT tg.tgisinternal AND n.nspname = 'public'
         AND pp.proname = 'set_updated_at'
       GROUP BY c.relname HAVING count(*) > 1
    ) t;

  IF cardinality(doubled) > 0 THEN
    problems := problems || format(
      '%s table(s) now run TWO set_updated_at triggers: %s. Section 2 created '
      'one beside an existing one instead of replacing it.',
      cardinality(doubled), array_to_string(doubled, ', '));
  END IF;

  /* -- 4. every non-excluded table with the column is still covered --- */
  SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname), ARRAY[]::text[])
    INTO uncovered
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'updated_at'
                    AND a.attnum > 0 AND NOT a.attisdropped)
     AND c.relname NOT IN (SELECT e.table_name FROM updated_at_exclusions e)
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger tg JOIN pg_proc pp ON pp.oid = tg.tgfoid
        WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal
          AND pp.proname = 'set_updated_at');

  IF cardinality(uncovered) > 0 THEN
    problems := problems || format(
      '%s table(s) have an updated_at column, are not excluded, and have no '
      'trigger maintaining it: %s.',
      cardinality(uncovered), array_to_string(uncovered, ', '));
  END IF;

  /* -- 5. and the sweep is not vacuous -------------------------------- */
  IF after_c.tables_with_column = 0 THEN
    problems := problems || 'ZERO tables carry an updated_at column. This file '
                            'would otherwise report a clean consolidation of nothing.'::text;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION E'0138 FAILED — % problem(s):\n  %',
      cardinality(problems), array_to_string(problems, E'\n  ')
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE
    '0138 PASS: one updated_at function. % of % tables that are SUPPOSED to '
    'have one are maintained by set_updated_at(); % more are excluded with a '
    'stated reason; 0 on ordence_touch_updated_at(); 0 running two triggers. '
    'Coverage before/after is in updated_at_consolidation_audit.',
    after_c.tables_covered, after_c.tables_with_column, after_c.excluded;
END
$$;
