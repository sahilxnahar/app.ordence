-- ############################################################################
-- 0216 — ONE SNAPSHOT OF EVERY DESTINATION, OR A REFUSAL
--        (Phase 3 — discovery and the dry run)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 WHAT THIS IS FOR
-- ══════════════════════════════════════════════════════════════════════════
-- The claim Phase 3 has to prove is *"a dry run touches nothing"*. The only
-- honest way to prove it is to count the rows in every destination before
-- the preview and after it, and require the difference to be zero.
--
-- ⚠️ AND THE OBVIOUS IMPLEMENTATION OF THAT PROOF IS WRONG IN THREE WAYS,
-- ALL THREE OF WHICH THIS REPOSITORY HAS ALREADY BEEN BITTEN BY.
--
--   ① IT MEASURES AS THE WRONG ROLE.
--      *"a query measurer that measured as a superuser under a header
--      saying NOBYPASSRLS"* is a defect this project has recorded. A
--      superuser, or any role with BYPASSRLS, sees every tenant's rows —
--      so the "destination" being counted is not the workspace under test,
--      and a write into a NEIGHBOURING tenant would show up as drift while
--      a write into this one is lost in the noise of the others.
--
--   ② IT MEASURES WITH NO TENANT SET, AND EVERY COUNT IS ZERO.
--      This is the one that makes the proof PASS while proving nothing.
--      Under FORCE ROW LEVEL SECURITY, `app_current_tenant_id()` returns
--      NULL outside `withTenant()`, every policy evaluates false, and
--      `count(*)` returns 0 on a table with a million rows. Before = 0,
--      after = 0, delta = 0, "the dry run wrote nothing" — measured on a
--      connection that could not have seen a write if there had been one.
--      🔴 THIS IS THE SINGLE MOST IMPORTANT REFUSAL IN PHASE 3.
--
--   ③ IT TAKES N SNAPSHOTS AND CALLS THEM ONE.
--      Nine tables counted in nine statements is nine points in time. On a
--      workspace where anything else is happening — and a migration takes
--      hours while the office does not stop — a row written by a colleague
--      between statement three and statement four is indistinguishable
--      from drift caused by the preview. One function call inside one
--      transaction is one snapshot.
--
-- ⭐ SO THE COUNTING LIVES HERE, IN SQL, AND NOT IN TYPESCRIPT. Not because
-- SQL is nicer, but because ① and ② are properties of the CONNECTION, and a
-- guard that lives in the database cannot be removed by a refactor in the
-- caller. `server/import/dryrun.ts` calls this and nothing else.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ NOT `SECURITY DEFINER`, AND THAT IS THE ENTIRE DESIGN
-- ══════════════════════════════════════════════════════════════════════════
-- A SECURITY DEFINER function here would run as the owner, bypass the
-- policies it is measuring, and return counts that describe a database
-- nobody is connected to. The whole value of the measurement is that it is
-- taken through the same policies the import writes through.
-- ############################################################################


-- ############################################################################
-- SECTION 1 — THE FUNCTION
-- ############################################################################

DROP FUNCTION IF EXISTS public.import_destination_row_count(text[]);

CREATE FUNCTION public.import_destination_row_count(p_tables text[])
RETURNS TABLE (destination text, row_count bigint)
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_table    text;
  v_count    bigint;
  v_missing  text[] := ARRAY[]::text[];
  v_bypasses boolean;
BEGIN
  /* ---- ① THE ROLE ------------------------------------------------- */
  SELECT rolsuper OR rolbypassrls INTO v_bypasses
    FROM pg_roles WHERE rolname = current_user;

  IF coalesce(v_bypasses, true) THEN
    RAISE EXCEPTION
      'import_destination_row_count() was called as "%", which is a superuser or '
      'carries BYPASSRLS. Every count it returned would be across ALL tenants, so '
      'a dry-run footprint taken this way proves nothing about the workspace under '
      'test. Connect as the application role (NOSUPERUSER NOBYPASSRLS) — that is '
      'what DATABASE_URL must name in production and what tests/setup.ts asserts '
      'before the suite starts.',
      current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  /* ---- ② THE TENANT ----------------------------------------------- */
  /*
   * 🔴 WITHOUT THIS, EVERY COUNT IS ZERO AND THE PROOF PASSES VACUOUSLY.
   * See ② in the header. `app_current_tenant_id()` reads
   * `app.current_tenant_id`, which `withTenant()` sets transaction-locally;
   * outside one it is NULL, every policy is false, and this function would
   * cheerfully report an empty database.
   */
  IF app_current_tenant_id() IS NULL THEN
    RAISE EXCEPTION
      'import_destination_row_count() was called with no tenant scope. Under FORCE '
      'ROW LEVEL SECURITY every policy is then false and every count is 0 — so a '
      'before/after comparison would report "nothing moved" on a database where '
      'everything moved. Call it inside withTenant().'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  /* ---- ③ SOMETHING TO COUNT --------------------------------------- */
  /*
   * ⚠️ AN EMPTY LIST IS REFUSED RATHER THAN RETURNING NO ROWS. A footprint
   * of nothing compares equal to a footprint of nothing, so a caller whose
   * destination list came out empty by accident would get a clean bill of
   * health for a run that wrote a thousand rows. Same reasoning as
   * `check-sealed-grants.mjs` refusing an empty seal list, and as
   * `check-import-contract.mjs` refusing a census of fewer than 6.
   */
  IF p_tables IS NULL OR array_length(p_tables, 1) IS NULL THEN
    RAISE EXCEPTION
      'import_destination_row_count() was asked to count nothing. An empty '
      'footprint compares equal to an empty footprint, so this would report that '
      'a dry run moved no rows without having looked at a single table.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  /* ---- ④ EVERY NAME MUST BE A TABLE, AND ALL OF THEM ARE NAMED ----- */
  /*
   * ⚠️ THE WHOLE LIST IS CHECKED BEFORE ANY OF IT IS COUNTED, and every
   * missing name is reported at once. Failing on the first one means a
   * caller fixes them one migration at a time, which is how a five-table
   * problem becomes five rounds.
   *
   * 🔴 AND A MISSING TABLE IS A REFUSAL, NOT A SKIP. The table Phase 3 was
   * told to count and could not find is `import_row_provenance` — the one
   * that did not exist in the delivered tree. A footprint that quietly
   * omits it is a proof with a hole in exactly the place somebody asked
   * about.
   */
  FOREACH v_table IN ARRAY p_tables LOOP
    IF to_regclass(format('public.%I', v_table)) IS NULL THEN
      v_missing := v_missing || v_table;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'import_destination_row_count(): no such table(s) in the public schema: %. '
      'A destination that cannot be counted cannot be proven untouched, so this '
      'refuses rather than leaving it out of the footprint.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = 'undefined_table';
  END IF;

  /* ---- ⑤ ONE SNAPSHOT --------------------------------------------- */
  /*
   * ⚠️ `format('%I')` AND NOT CONCATENATION. The names arrive from an
   * entity contract rather than from a browser, so this is not the front
   * line — but a quoted identifier costs nothing and the function is
   * STABLE and not SECURITY DEFINER, so even a crafted name could not
   * reach past the caller's own privileges.
   */
  FOREACH v_table IN ARRAY p_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO v_count;
    destination := v_table;
    row_count   := v_count;
    RETURN NEXT;
  END LOOP;
END
$fn$;

COMMENT ON FUNCTION public.import_destination_row_count(text[]) IS
    'Row counts for a list of destination tables, in ONE snapshot inside the '
    'caller''s transaction and through the caller''s own RLS policies. Refuses a '
    'superuser or BYPASSRLS caller (the counts would span every tenant), refuses '
    'a call with no tenant scope (under FORCE RLS every count would be 0 and a '
    'dry-run footprint would pass vacuously), refuses an empty list, and refuses '
    'a name that is not a table. Read by server/import/dryrun.ts. Deliberately '
    'NOT SECURITY DEFINER: the measurement is only worth taking through the same '
    'policies the import writes through.';


-- ############################################################################
-- SECTION 2 — SELF-VERIFICATION, BY INDUCTION
-- ############################################################################
--
-- ⭐ THE GUARDS ARE PROVEN TO FIRE, NOT ASSERTED TO EXIST.
--
-- ⚠️ AND THAT IS WHY THIS SECTION IS POSSIBLE AT ALL: a migration is applied
-- by the OWNER — `neondb_owner` on Neon, which carries BYPASSRLS, or
-- `postgres` locally — with no tenant scope set. That is precisely the
-- caller guard ① and guard ② exist to refuse. So applying this file is
-- itself the negative case, and the file fails if the function answers.
--
-- 🔴 `WHEN OTHERS` WOULD PASS ON A FUNCTION THAT DOES NOT EXIST. Catching
-- any error and calling it a fired guard means a typo in the function name
-- reads as a proof. Each block therefore checks the SQLSTATE it expects and
-- re-raises anything else.

DO $$
DECLARE
  v_fired  boolean := false;
  v_state  text;
  v_result bigint;
BEGIN
  /* ---- ① or ② : the owner applying this file is refused ----------- */
  BEGIN
    SELECT row_count INTO v_result
      FROM public.import_destination_row_count(ARRAY['tenants']);
  EXCEPTION WHEN OTHERS THEN
    v_fired := true;
    v_state := SQLSTATE;
  END;

  IF NOT v_fired THEN
    RAISE EXCEPTION
      'import_destination_row_count() answered a call from "%", which is applying '
      'a migration and therefore has either BYPASSRLS or no tenant scope or both. '
      'One of the two caller guards is missing, and a dry-run footprint taken '
      'through this function would be measuring a database nobody is connected to.',
      current_user;
  END IF;

  IF v_state NOT IN ('42501', '25000') THEN
    RAISE EXCEPTION
      'import_destination_row_count() refused the migration role with SQLSTATE %, '
      'which is neither insufficient_privilege (42501) nor '
      'invalid_transaction_state (25000). It failed for some reason other than '
      'its own guards — a missing function raises 42883 and would otherwise read '
      'as a proof.',
      v_state;
  END IF;

  RAISE NOTICE
    '0216 OK — the caller guard refused "%" with SQLSTATE %, which is what it is for.',
    current_user, v_state;
END
$$;

-- ############################################################################
-- SECTION 3 — AND THE ARGUMENT GUARDS, WHICH DO NOT DEPEND ON THE ROLE
-- ############################################################################
--
-- ⚠️ SECTION 2 CANNOT REACH GUARDS ③ AND ④, because ① refuses first and the
-- order is deliberate: a superuser must be turned away before it is told
-- anything about which tables exist. So they are proven here against the
-- function's own source rather than by calling it — the ONE place in this
-- file where a property is read rather than executed, stated plainly rather
-- than hidden.
--
-- 🔴 THE EXECUTED PROOF OF ③ AND ④ IS IN
--    `tests/security/import-dry-run-parity.test.ts`, which connects as
--    `ordence_app` inside `withTenant()` and can therefore get past ① and ②.
--    A source read here and an execution there is the same division
--    `0167_impersonation_guard_exemption_record.sql` uses and for the same
--    reason: the migration is for the database's own copy of the decision,
--    the test is what fails a build.

DO $$
DECLARE
  v_src   text;
  v_gone  text[] := ARRAY[]::text[];
  v_needs text[] := ARRAY[
    'invalid_parameter_value',   -- ③ an empty list is refused
    'undefined_table',           -- ④ an unknown name is refused
    'insufficient_privilege',    -- ① a bypassing role is refused
    'invalid_transaction_state'  -- ② no tenant scope is refused
  ];
  v_marker text;
  v_secdef boolean;
  v_volat  char;
BEGIN
  SELECT prosrc, prosecdef, provolatile
    INTO v_src, v_secdef, v_volat
    FROM pg_proc
   WHERE oid = 'public.import_destination_row_count(text[])'::regprocedure;

  IF v_src IS NULL THEN
    RAISE EXCEPTION '0216 created no function called import_destination_row_count(text[]).';
  END IF;

  IF v_secdef THEN
    RAISE EXCEPTION
      'import_destination_row_count() is SECURITY DEFINER. It would then run as the '
      'owner, bypass the policies it exists to measure through, and return counts '
      'describing a database nobody is connected to.';
  END IF;

  IF v_volat <> 's' THEN
    RAISE EXCEPTION
      'import_destination_row_count() is volatility "%", and must be STABLE. A '
      'VOLATILE function is one Postgres will let write, and the one thing a '
      'dry-run measurer must never do is change what it is measuring.',
      v_volat;
  END IF;

  FOREACH v_marker IN ARRAY v_needs LOOP
    IF position(v_marker IN v_src) = 0 THEN
      v_gone := v_gone || v_marker;
    END IF;
  END LOOP;

  IF array_length(v_gone, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'import_destination_row_count() no longer raises with ERRCODE(s): %. Each one '
      'is a refusal the dry-run proof depends on; a missing one is a footprint that '
      'returns an answer where it should have refused.',
      array_to_string(v_gone, ', ');
  END IF;

  RAISE NOTICE '0216 OK — STABLE, SECURITY INVOKER, all four refusals present.';
END
$$;
