-- ############################################################################
-- DRILL 0136 — IS A DATABASE BUILT FROM THE NUMBERED MIGRATIONS ALONE
--              EQUIVALENT TO PRODUCTION?   (Wave 15 / Track C)
-- ############################################################################
--
-- 🔴 DO NOT RUN THIS IN NEON. Section 3 deliberately removes the tenant
--    isolation policy from `contracts` for the duration of one statement, to
--    prove the comparison is capable of noticing. On a live database that is
--    a window in which one customer can read another's contracts. Run it
--    against a throwaway local PostgreSQL and nothing else.
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE QUESTION, AND WHY NOBODY COULD ANSWER IT BEFORE THIS WAVE
-- ══════════════════════════════════════════════════════════════════════════
-- Production was built by pasting `ALL-IN-ONE-SETUP.sql` into the Neon
-- console and then applying the numbered files. CI builds the same way.
-- `scripts/bootstrap-test-db.mjs` builds the same way. Every database anybody
-- has ever looked at was built that way.
--
-- A new region, a disaster-recovery rebuild, or a developer following
-- `SQL-FILES/` in order gets a DIFFERENT database, and until this wave nobody
-- had built one to find out how different. It is different by:
--
--     6 tables with no RLS at all   clause_library, contracts,
--                                   contract_versions, ledgers,
--                                   transactions, journal_entries
--     3 functions                   app_is_platform_scope,
--                                   assert_contract_refs_same_tenant,
--                                   assert_journal_entry_tenant
--     9 triggers                    including journal_entries_balance_check,
--                                   the deferred constraint trigger that
--                                   refuses an unbalanced journal
--
-- `0136_phase4_clm_and_ledger_isolation.sql` closes that gap. This drill is
-- how you check that it still is closed, on any database, at any time.
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE PROCEDURE. THE SHELL PART IS THE DRILL; THIS FILE IS THE ASSERTION.
-- ══════════════════════════════════════════════════════════════════════════
--
--   # 1. Build A — the way production and CI are built.
--   node scripts/bootstrap-test-db.mjs --force
--
--   # 2. Build B — migrations only. Same push, no ALL-IN-ONE-SETUP.sql.
--   createdb ordence_migonly
--   node scripts/drizzle-kit.mjs push --force        # DATABASE_URL → B
--   for f in SQL-FILES/[0-9][0-9][0-9][0-9]_*.sql; do
--       psql -d ordence_migonly -v ON_ERROR_STOP=1 -f "$f"
--   done
--
--   # 3. Run THIS FILE against each of them and compare the two fingerprints
--   #    it prints. They must be identical.
--   psql -d ordence_test     -v ON_ERROR_STOP=1 -f DRILL-DO-NOT-RUN-IN-NEON-0136.sql
--   psql -d ordence_migonly  -v ON_ERROR_STOP=1 -f DRILL-DO-NOT-RUN-IN-NEON-0136.sql
--
-- ⚠️ THE FINGERPRINT IS `schema_contract_fingerprint()` FROM 0139, WHICH
-- COVERS TENANT TABLES, POLICIES, TRIGGERS AND FUNCTIONS AND DELIBERATELY
-- NOT COLUMNS. Two databases whose fingerprints match have the same security
-- shape. They may still differ in a column somebody added; that is a
-- different question, and one `drizzle-kit push` answers on every run.
--
-- ⚠️ AND `drizzle-kit push` HAS TO BE IN BOTH LEGS. It is banned in
-- production and it is the only thing that creates most of the tables; the
-- numbered files ALTER tables into safety, they do not create them. A "build
-- B" that skipped it would compare production against an empty schema and
-- report a difference of 300 tables, which tells you nothing.
--
-- IS THERE DATA LOSS? Section 3 drops and immediately recreates one policy
-- inside a single statement. If that statement is interrupted the policy is
-- restored by the rollback. On a throwaway database this is safe; the file is
-- named the way it is because on a real one it is not.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — THE SIX PHASE-4 TABLES, INDIVIDUALLY
-- ----------------------------------------------------------------------------

SELECT
  c.relname                                        AS table_name,
  c.relrowsecurity                                 AS rls_enabled,
  c.relforcerowsecurity                            AS rls_forced,
  (SELECT count(*) FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname
      AND p.qual::text LIKE '%app_current_tenant_id%') AS tenant_policies,
  (SELECT count(*) FROM pg_trigger tg
    WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal) AS triggers
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('clause_library', 'contracts', 'contract_versions',
                    'ledgers', 'transactions', 'journal_entries')
ORDER BY c.relname;


-- ----------------------------------------------------------------------------
-- SECTION 2 — THE FINGERPRINT TO COMPARE BETWEEN THE TWO DATABASES
-- ----------------------------------------------------------------------------

SELECT
  schema_contract_fingerprint()                                   AS fingerprint,
  (SELECT count(*) FROM schema_contract_rows())                   AS contract_rows,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public')  AS policies,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity) AS forced_tables;


-- ----------------------------------------------------------------------------
-- SECTION 3 — ASSERT, AND THEN PROVE THE ASSERTION CAN FAIL
-- ----------------------------------------------------------------------------
--
-- ⭐ THE SECOND HALF IS THE WHOLE VALUE. A drill that checks six tables and
-- says "all good" is indistinguishable from a drill whose query is wrong,
-- and this repository has shipped that exact thing at least three times. So
-- the isolation policy is dropped from `contracts`, the same check is asked
-- again, and it must FAIL. Then it is put back and must pass.
--
-- ⚠️ ALL OF IT INSIDE ONE `DO` BLOCK, WHICH IS ONE STATEMENT AND THEREFORE
-- ONE TRANSACTION. There is no point at which this file can be interrupted
-- and leave `contracts` unprotected — the rollback restores it. That is not
-- a small detail: an earlier draft did it as three top-level statements, and
-- in the Neon console (which sends each statement on its own connection)
-- that would have left the policy off if the middle one failed.

-- ⚠️ THE PREDICATE BELOW IS WRITTEN OUT THREE TIMES AND THAT IS NOT AN
-- OVERSIGHT. The obvious tidy-up is to declare it once as a local function
-- inside the DO block; PL/pgSQL has no nested function declaration, and the
-- attempt fails to PARSE, which takes the whole file down with it. Recorded
-- here so the next reader does not spend the same twenty minutes discovering
-- it, and so nobody "cleans this up" into a file that will not run.

DO $$
DECLARE
  missing   text[];
  detected  text[];
  fp_before text;
  fp_after  text;
  fn        text;
BEGIN
  /* ---- 1. the six tables are protected ---------------------------- */
  SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO missing
    FROM unnest(ARRAY['clause_library', 'contracts', 'contract_versions',
                      'ledgers', 'transactions', 'journal_entries']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t
        AND c.relrowsecurity AND c.relforcerowsecurity
        AND EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = t
                       AND p.qual::text LIKE '%app_current_tenant_id%'));

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION
      E'DRILL 0136 FAILED: % of the six phase-4 tables are NOT enabled, forced and '
       'policied: %.\n'
       'If this is a migrations-only database, 0136 has not been applied. If it is '
       'production, something removed them — check diff_schema_contract().',
      cardinality(missing), array_to_string(missing, ', ');
  END IF;

  /* ---- 2. and the three functions are here ------------------------ */
  FOREACH fn IN ARRAY ARRAY['app_is_platform_scope', 'assert_contract_refs_same_tenant',
                            'assert_journal_entry_tenant'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = fn) THEN
      RAISE EXCEPTION 'DRILL 0136 FAILED: function %() is missing.', fn;
    END IF;
  END LOOP;

  /* ---- 3. and the check is capable of failing --------------------- */
  fp_before := schema_contract_fingerprint();

  DROP POLICY contracts_tenant_isolation ON public.contracts;

  SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO detected
    FROM unnest(ARRAY['clause_library', 'contracts', 'contract_versions',
                      'ledgers', 'transactions', 'journal_entries']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t
        AND c.relrowsecurity AND c.relforcerowsecurity
        AND EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = t
                       AND p.qual::text LIKE '%app_current_tenant_id%'));

  CREATE POLICY contracts_tenant_isolation ON public.contracts
    FOR ALL
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

  fp_after := schema_contract_fingerprint();

  IF detected IS DISTINCT FROM ARRAY['contracts'] THEN
    RAISE EXCEPTION
      'DRILL 0136 FAILED: the isolation policy was dropped from `contracts` and the check '
      'reported % rather than {contracts}. It cannot see the thing it exists to see, so its '
      'clean result above means nothing.', detected;
  END IF;

  IF fp_before IS DISTINCT FROM fp_after THEN
    RAISE EXCEPTION
      E'DRILL 0136 FAILED: the schema fingerprint did not return to its original value '
       'after the policy was restored (% → %).\n'
       '🔴 CHECK `contracts` RIGHT NOW: SELECT * FROM pg_policies WHERE tablename = ''contracts'';',
      left(fp_before, 16), left(fp_after, 16);
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE '  DRILL 0136 PASS on this database.';
  RAISE NOTICE '';
  RAISE NOTICE '  All six phase-4 tables are ENABLED, FORCED and policied on';
  RAISE NOTICE '  app_current_tenant_id(); all three functions are present; and';
  RAISE NOTICE '  the check reported {contracts} when its policy was momentarily';
  RAISE NOTICE '  removed, so it is not vacuous. The policy is back and the';
  RAISE NOTICE '  fingerprint matches its pre-probe value.';
  RAISE NOTICE '';
  RAISE NOTICE '  fingerprint: %', schema_contract_fingerprint();
  RAISE NOTICE '';
  RAISE NOTICE '  ⚠️ THE DRILL IS NOT FINISHED UNTIL YOU HAVE RUN THIS FILE ON';
  RAISE NOTICE '     BOTH DATABASES AND COMPARED THE TWO FINGERPRINTS BY EYE.';
  RAISE NOTICE '     One database passing says nothing about equivalence.';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
END
$$;
