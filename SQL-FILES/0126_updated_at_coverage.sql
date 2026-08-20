-- ############################################################################
-- 0126 — 86 TABLES HAVE AN `updated_at` THAT NEVER UPDATES
--        (Infra wave 13 / v1.80.0-alpha)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- 178 tables carry an `updated_at` column. 92 have a trigger that maintains
-- it. The other 86 have a column that is set once by `DEFAULT now()` on INSERT
-- and never moves again, so it reads as "last changed at creation" forever.
--
-- ⚠️ THERE IS NO SECOND MECHANISM. `db/schema/*.ts` contains zero uses of
-- drizzle's `$onUpdate()`, so nothing in the application maintains it either.
-- A stale `updated_at` is not merely a cosmetic "Last modified" line:
--
--   • 0017_change_log.sql argues at length that `updated_at > lastSync` is not
--     sufficient for sync. On these 86 tables it is not even ADVANCING, so any
--     future reader who reaches for it as a cheap filter gets an empty set and
--     concludes nothing changed.
--   • Any "recently touched" list, staleness report or cache key built on it
--     is silently wrong, and wrong in the direction that looks calm.
--
-- HOW IT HAPPENED
-- ---------------
-- 0001 defines `set_updated_at()` and attaches it to three tables by hand.
-- Every module since has hand-listed its own. There is no discovery step, no
-- registry, and 0028 introduced a SECOND naming convention
-- (`trg_touch_sales_orders` rather than `sales_orders_set_updated_at`), so
-- even a census keyed on the trigger NAME would have been wrong.
--
-- ⭐ THIS FILE KEYS ON THE FUNCTION, NOT THE NAME. A table is covered if ANY
-- non-internal trigger on it executes `set_updated_at()` OR
-- `ordence_touch_updated_at()`, whatever that trigger is called. That is the
-- property that matters and it is the one a name-based census kept getting
-- wrong.
--
-- ⚠️ THERE ARE TWO SUCH FUNCTIONS AND THAT IS ITSELF THE DEFECT UNDERNEATH.
-- `set_updated_at()` covers 150 tables and `ordence_touch_updated_at()`
-- covers 19. They do the same thing. They are not consolidated here because
-- dropping one would rewrite 19 trigger definitions in a file about
-- coverage, and a migration that does two things is a migration nobody can
-- revert cleanly. It is recorded in the wave report as outstanding.
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. Adds `attach_updated_at_triggers()`, discovered from
--      `information_schema.columns WHERE column_name = 'updated_at'`.
--   2. Declares the exclusions once, with a reason each.
--   3. Runs it.
--   4. RAISES if any table with an `updated_at` column is still uncovered.
--
-- ⚠️ APPEND-ONLY TABLES ARE EXCLUDED AND MUST BE. A table whose UPDATE is
-- refused by a trigger cannot have `updated_at` maintained by another trigger,
-- and attaching one there would create a BEFORE UPDATE trigger that can never
-- run. Worse, it would suggest the row is updatable.
--
-- ⚠️ EXISTING ROWS ARE NOT BACKFILLED. Setting `updated_at = now()` on 86
-- tables would assert that every row in the product changed this morning,
-- which is exactly the false signal this file exists to remove. The column
-- starts telling the truth from the next real write.
--
-- IS THERE DATA LOSS?  No. Triggers and one platform table. No row is written.
--
-- RUN ORDER
-- ---------
-- Last. SQL FIRST, then the code.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent.
--
-- RLS
-- ---
-- `updated_at_exclusions` is platform data describing the schema. No RLS.
-- ############################################################################

CREATE TABLE IF NOT EXISTS public.updated_at_exclusions (
  table_name  text PRIMARY KEY,
  reason      text NOT NULL,
  declared_in text NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.updated_at_exclusions IS
  'Tables with an updated_at column that deliberately have no trigger '
  'maintaining it. Almost always because the table is append-only, where a '
  'BEFORE UPDATE trigger could never fire and its presence would falsely '
  'suggest the row is updatable.';

-- Seeded by discovery below rather than by hand, so the list cannot be wrong
-- about which tables are append-only.


-- ----------------------------------------------------------------------------
-- SECTION 1 — EXCLUDE ONLY WHAT IS PROVABLY UNUPDATABLE
-- ----------------------------------------------------------------------------
--
-- ⚠️ THE FIRST VERSION OF THIS SECTION WAS WRONG AND ITS OWN TEST CAUGHT IT.
--
-- It called a table append-only if ANY of its BEFORE UPDATE trigger functions
-- contained the text `RAISE EXCEPTION`. That matches a CONDITIONAL guard just
-- as readily as an unconditional refusal, so `sales_orders` , which has
-- `ordence_guard_order_status`, a guard that raises only on an illegal status
-- transition , was classified as append-only and left with a dead
-- `updated_at`. A heuristic that reads a function body cannot tell "refuses
-- everything" from "refuses something".
--
-- ⭐ SO THE TEST IS A FACT, NOT A GUESS: the application role holds no UPDATE
-- privilege on the table, on any column. If nothing may UPDATE the row, the
-- column cannot move and a BEFORE UPDATE trigger there could never fire.
--
-- ⚠️ AND THE DEFAULT IS TO INCLUDE. Getting this wrong in the exclude
-- direction leaves a column silently lying about when a row last changed.
-- Getting it wrong in the include direction attaches a trigger that never
-- fires, which costs nothing. When a rule is uncertain, the cheap mistake is
-- the one to make.

DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    RAISE NOTICE
      '0126: role ordence_app does not exist here, so "can this row be '
      'updated at all" cannot be answered from privileges. Excluding nothing '
      'and attaching everywhere, which is the safe direction.';
    RETURN;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- 🔴 REPAIRED IN WAVE 15 (Track C). THIS BLOCK HAD NEVER EXECUTED, ANYWHERE.
  -- ══════════════════════════════════════════════════════════════════════
  -- It read:
  --
  --     FROM information_schema.columns c
  --     JOIN information_schema.tables  t ON …
  --    WHERE c.table_schema = 'public'
  --      AND NOT has_any_column_privilege('ordence_app',
  --                                       quote_ident(c.table_name), 'UPDATE')
  --
  -- and it failed, every time, with
  --
  --     ERROR:  relation "collations" does not exist
  --     CONTEXT: PL/pgSQL function inline_code_block line 13 at FOR over SELECT
  --
  -- ⚠️ THE CAUSE IS THE ARGUMENT TYPE, NOT THE QUERY SHAPE.
  -- `has_any_column_privilege(name, TEXT, text)` takes a table NAME, which
  -- PostgreSQL resolves through `search_path` at evaluation time. The planner
  -- is free to push that filter down below the join — and it does: `EXPLAIN`
  -- shows it as a `Filter:` on the `Seq Scan on pg_class`, i.e. applied to
  -- EVERY relation in EVERY schema before `nspname = 'public'` is ever
  -- considered. `information_schema.collations` is one of those relations;
  -- there is no `public.collations`; the function raises 42P01 and the whole
  -- block dies.
  --
  -- 🔴 CONSEQUENCES, ALL OF WHICH WERE LIVE UNTIL WAVE 15:
  --   · `updated_at_exclusions` was EMPTY on every database. The list this
  --     file exists to declare had zero rows in it.
  --   · Section 2 therefore treated append-only tables as sweepable and
  --     attached `set_updated_at` to `plans`, on which the application role
  --     holds no UPDATE — a BEFORE UPDATE trigger that can never fire, which
  --     is precisely what the header says must not happen.
  --   · Section 3 still printed `0126 PASS`, because with an empty exclusion
  --     list nothing can be "uncovered". The file's own verification could
  --     not see that half the file had not run.
  --   · `psql -v ON_ERROR_STOP=1 -f 0126_…sql` exits **3**. That is the exact
  --     invocation in `.github/workflows/security-ci.yml`'s "Apply the
  --     numbered SQL files, in order" step, so the security-tests job has
  --     been unable to go green since this file landed.
  --
  -- ⚠️ THIS FILE IS EDITED IN PLACE RATHER THAN SUPERSEDED BY A LATER
  -- MIGRATION, AND THAT IS DELIBERATE. CI reapplies every numbered file from
  -- scratch, in order, with ON_ERROR_STOP=1 — so a forward-only repair in a
  -- later file never runs: the pipeline stops HERE, at 0126, before reaching
  -- it. A defect that aborts the sequence has to be fixed in the file that
  -- aborts it. The state repair for databases where the broken version
  -- already ran is separate, and lives in
  -- `0138_updated_at_consolidation.sql`.
  --
  -- ⭐ THE FIX: pass the OID. `has_any_column_privilege(name, OID, text)`
  -- needs no name resolution, so a relation in another schema is simply a
  -- relation this predicate answers `false` about instead of an error. The
  -- query is rewritten onto `pg_class`/`pg_attribute` for the same reason —
  -- `information_schema` hands out names, and names are the bug.
  FOR r IN
    SELECT c.relname::text AS tbl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'updated_at'
                      AND a.attnum > 0 AND NOT a.attisdropped)
       AND NOT has_any_column_privilege('ordence_app', c.oid, 'UPDATE')
  LOOP
    INSERT INTO public.updated_at_exclusions (table_name, reason, declared_in)
    VALUES (
      r.tbl,
      'The application role holds no UPDATE privilege on any column of this '
      'table, so no row here is ever updated and a BEFORE UPDATE trigger '
      'could never fire. Verified from privileges rather than inferred from '
      'a trigger body.',
      '0126')
    ON CONFLICT (table_name) DO NOTHING;
  END LOOP;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 1b — REMOVE THE DUPLICATES AN EARLIER RUN OF THIS FILE CREATED
-- ----------------------------------------------------------------------------
--
-- 🔴 THERE ARE TWO updated_at FUNCTIONS IN THIS SCHEMA: `set_updated_at()`
-- (150 tables) and `ordence_touch_updated_at()` (19 tables). The first draft
-- of this file knew about one of them, so it attached a SECOND trigger to
-- twelve tables that were already covered by the other , `warehouses`,
-- `stock_items`, `khata_records`, `powers_of_attorney`, `works_contracts` and
-- seven more.
--
-- ⚠️ TWO TRIGGERS BOTH SETTING `updated_at = now()` IS HARMLESS TODAY AND IS
-- STILL WRONG. The next person to change one of the two functions changes the
-- behaviour of half the tables and not the other half, and nothing says which
-- is which. This drops the one this file created and keeps the one that was
-- already there.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT pc.relname AS tbl
      FROM pg_trigger tg
      JOIN pg_class pc ON pc.oid = tg.tgrelid
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace
      JOIN pg_proc pp ON pp.oid = tg.tgfoid
     WHERE NOT tg.tgisinternal
       AND pn.nspname = 'public'
       AND pp.proname IN ('set_updated_at', 'ordence_touch_updated_at')
     GROUP BY pc.relname
    HAVING count(*) > 1
       AND bool_or(pp.proname = 'ordence_touch_updated_at')
       AND bool_or(tg.tgname = pc.relname || '_set_updated_at')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.tbl || '_set_updated_at', r.tbl);
    RAISE NOTICE '0126: removed the duplicate updated_at trigger on %', r.tbl;
  END LOOP;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 2 — THE SWEEP
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.attach_updated_at_triggers()
RETURNS TABLE (table_name text, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name AS tbl
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'updated_at'
       AND t.table_type   = 'BASE TABLE'
       AND c.table_name NOT IN (SELECT e.table_name FROM updated_at_exclusions e)
       -- ⭐ KEYED ON THE FUNCTION, NOT THE TRIGGER NAME. 0028 named its
       -- trigger `trg_touch_sales_orders`; a name-based census called that
       -- table uncovered and would have attached a second trigger.
       AND NOT EXISTS (
         SELECT 1
           FROM pg_trigger tg
           JOIN pg_class  pc ON pc.oid = tg.tgrelid
           JOIN pg_namespace pn ON pn.oid = pc.relnamespace
           JOIN pg_proc   pp ON pp.oid = tg.tgfoid
          WHERE NOT tg.tgisinternal
            AND pn.nspname   = 'public'
            AND pc.relname   = c.table_name
            -- ⭐ BOTH FUNCTIONS. This is the bug that produced twelve
            -- duplicate triggers: `ordence_touch_updated_at` does the same
            -- job under a different name, on 19 tables, and a sweep that
            -- knows about one of them sees the other 19 as uncovered.
            AND pp.proname IN ('set_updated_at', 'ordence_touch_updated_at')
       )
     ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      r.tbl || '_set_updated_at', r.tbl
    );
    table_name := r.tbl;
    action     := 'attached';
    RETURN NEXT;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.attach_updated_at_triggers() IS
  'Attaches set_updated_at() to every base table with an updated_at column '
  'that has no trigger executing that function, whatever such a trigger might '
  'be named, and that is not in updated_at_exclusions. Idempotent. Call this '
  'from a module migration instead of hand-listing tables.';

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.attach_updated_at_triggers() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON FUNCTION public.attach_updated_at_triggers() FROM ordence_app;
    REVOKE ALL ON updated_at_exclusions FROM ordence_app;
    GRANT SELECT ON updated_at_exclusions TO ordence_app;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 3 — RUN IT, AND VERIFY EXHAUSTIVELY
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  attached text[];
BEGIN
  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO attached
    FROM attach_updated_at_triggers() t;
  RAISE NOTICE '0126: attached set_updated_at to % table(s).', cardinality(attached);
END
$$;

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT coalesce(array_agg(c.table_name ORDER BY c.table_name), ARRAY[]::text[])
    INTO missing
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = 'public'
     AND c.column_name  = 'updated_at'
     AND t.table_type   = 'BASE TABLE'
     AND c.table_name NOT IN (SELECT e.table_name FROM updated_at_exclusions e)
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger tg
         JOIN pg_class pc ON pc.oid = tg.tgrelid
         JOIN pg_namespace pn ON pn.oid = pc.relnamespace
         JOIN pg_proc pp ON pp.oid = tg.tgfoid
        WHERE NOT tg.tgisinternal AND pn.nspname='public'
          AND pc.relname = c.table_name
          AND pp.proname IN ('set_updated_at', 'ordence_touch_updated_at'));

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION
      '0126 FAILED: % table(s) still have an updated_at that never updates: %.',
      cardinality(missing), array_to_string(missing, ', ')
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE
    '0126 PASS: every updated_at column is maintained, or its table is '
    'append-only and excluded with a stated reason.';
END
$$;
