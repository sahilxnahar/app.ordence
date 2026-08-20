-- ############################################################################
-- 0210 — THE THREE THINGS AN UNDO ACTUALLY DOES TO A ROW
--        (Phase 2 — the run ledger, idempotency and reversal)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHY THESE ARE FUNCTIONS AND NOT THREE TEMPLATE STRINGS IN TYPESCRIPT
-- ══════════════════════════════════════════════════════════════════════════
-- Every one of them needs the destination table's NAME at run time, and a
-- name is not a bind parameter. Done in TypeScript that is three places
-- assembling an identifier into SQL, three places that must each remember to
-- validate it, and — the thing that actually bites — three places `tsc` and
-- every gate in this repository are blind to. `ledgerBalanceAt()` has queried
-- a column that never existed since 0102 for exactly that reason: raw SQL in
-- a template string, invisible to the compiler, wrong on every call.
--
-- ⭐ ONE PLACE INSTEAD, WITH `to_regclass` AND `%I`, AND THE SAME THREE
-- ADMISSIBILITY RULES THE PROVENANCE TRIGGER USES: a real ordinary table in
-- `public`, carrying `tenant_id`, and not on the deny list.
--
-- ⚠️ `SECURITY INVOKER`, EVERY ONE. A `SECURITY DEFINER` version would run as
-- the owner and quietly become the way an undo reaches another tenant's rows
-- — row-level security is the sole isolation mechanism in this product and a
-- definer function is the standard way to lose it. Every statement below runs
-- under the caller's policies, and the explicit `tenant_id = $` predicate is
-- the belt to that brace.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴🔴 AND THE RESTORE VERIFIES ITS OWN WORK, WHICH IS THE POINT OF §3
-- ══════════════════════════════════════════════════════════════════════════
-- `contract.reversal.escapes` is a sentence an author wrote. `companies`
-- declares `escapes: null` — a claim that NOTHING survives an undo of it.
--
-- `companies` also carries `companies_set_updated_at`, a BEFORE UPDATE
-- trigger whose whole body is `NEW.updated_at = now()`. Any restore of that
-- row, by anybody, by any means available to the application, leaves
-- `updated_at` reading the moment of the undo. The declared claim is false,
-- and it is false for two of the six contracted entities.
--
-- ⭐ SO THE RESTORE RE-READS THE ROW AFTER WRITING IT AND RETURNS EVERY
-- COLUMN THAT DID NOT COME BACK. `escapes` stops being an assurance and
-- becomes a measurement, per row, made by the same statement that did the
-- work. What the customer is told escaped is then what actually did.
--
-- ############################################################################


-- ############################################################################
-- SECTION 1 — ADMISSIBILITY, IN ONE PLACE
-- ############################################################################

CREATE OR REPLACE FUNCTION public.import_assert_destination(p_table text)
RETURNS regclass
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_rel    regclass;
  v_denied text[] := ARRAY[
    'tenants', 'users', 'audit_logs', 'change_log', 'security_events',
    'permission_denials', 'error_events', 'vault_items', 'vault_secrets',
    'import_runs', 'import_run_chunks', 'import_row_provenance',
    'import_row_prior_values', 'import_reversals', 'import_reversal_failures'
  ];
BEGIN
  IF p_table = ANY (v_denied) THEN
    RAISE EXCEPTION
      'An import undo may not touch "%". It is not an import destination.',
      p_table USING ERRCODE = '42501';
  END IF;

  v_rel := to_regclass('public.' || quote_ident(p_table));
  IF v_rel IS NULL THEN
    RAISE EXCEPTION 'Import destination "%" does not exist.', p_table
      USING ERRCODE = '42P01';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = v_rel AND c.relkind = 'r'
       AND c.relnamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION
      '"%" is not an ordinary table in public. An undo of a view or a foreign '
      'table is not an undo of anything this product wrote.', p_table
      USING ERRCODE = '42809';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = p_table AND column_name = 'tenant_id'
  ) THEN
    RAISE EXCEPTION
      '"%" has no tenant_id, so an undo of it could not be scoped to one '
      'workspace.', p_table USING ERRCODE = '42703';
  END IF;

  RETURN v_rel;
END
$fn$;

COMMENT ON FUNCTION public.import_assert_destination(text) IS
    'The single admissibility test for a table an import undo is about to '
    'touch: not on the deny list, a real ordinary table in public, carrying '
    'tenant_id. Shared by the capture, restore and delete primitives so the '
    'three cannot drift apart. SQL 0210 §1.';


-- ############################################################################
-- SECTION 2 — READ THE PRIOR VALUES, AND RECORD WHEN THEY WERE READ
-- ############################################################################
--
-- ⚠️ `xmin` IS RETURNED ALONGSIDE THE VALUES AND THE CALLER MUST STORE IT.
-- It is the evidence that the read happened BEFORE the overwrite: 0206 §3
-- refuses a capture whose `observed_xmin` is the writing transaction's own
-- id, which is what a capture taken one statement too late looks like.
--
-- ⚠️ `to_jsonb(t)` KEEPS NUMBERS AS `numeric`, NOT AS DOUBLES. That matters
-- here more than it looks: money in this schema is `bigint` minor units and a
-- crore of rupees is 10^9 paise, with balance-sheet totals a hundred times
-- that. A jsonb round trip through a float would start losing paise around
-- 2^53; jsonb's own numeric type does not.
--
-- ⚠️ AND EVERY REQUESTED COLUMN IS PRESENT, INCLUDING THE NULLS. A column
-- that was NULL before the import and is simply absent from the capture would
-- be restored as "not mentioned" rather than "restored to NULL", and the row
-- would keep whatever the import put in it.

CREATE OR REPLACE FUNCTION public.import_capture_prior_values(
    p_table  text,
    p_id     uuid,
    p_tenant uuid,
    p_fields text[]
)
RETURNS TABLE (prior_values jsonb, observed_xmin bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_rel     regclass;
  v_whole   jsonb;
  v_xmin    bigint;
  v_missing text[];
BEGIN
  v_rel := import_assert_destination(p_table);

  EXECUTE format(
    'SELECT to_jsonb(t), t.xmin::text::bigint FROM public.%I t '
    'WHERE t.id = $1 AND t.tenant_id = $2', p_table
  ) INTO v_whole, v_xmin USING p_id, p_tenant;

  IF v_whole IS NULL THEN
    RETURN;                      -- no such row: the caller reports it
  END IF;

  IF p_fields = ARRAY['*'] THEN
    prior_values := v_whole;
  ELSE
    -- ⚠️ A NAMED FIELD THAT IS NOT A COLUMN IS A REFUSAL, NOT A SKIP. It is
    -- what a rename on one side looks like, and skipping it produces an undo
    -- that restores everything except the column somebody renamed.
    SELECT coalesce(array_agg(f ORDER BY f), ARRAY[]::text[]) INTO v_missing
      FROM unnest(p_fields) AS f
     WHERE NOT (v_whole ? f);
    IF array_length(v_missing, 1) IS NOT NULL THEN
      RAISE EXCEPTION
        'capturePriorFields names %, which "%" does not have. A field renamed '
        'on one side only would otherwise be silently left out of every undo.',
        array_to_string(v_missing, ', '), p_table
        USING ERRCODE = '42703';
    END IF;
    SELECT jsonb_object_agg(f, v_whole -> f) INTO prior_values
      FROM unnest(p_fields) AS f;
  END IF;

  observed_xmin := v_xmin;
  RETURN NEXT;
END
$fn$;

COMMENT ON FUNCTION public.import_capture_prior_values(text, uuid, uuid, text[]) IS
    'Reads a destination row''s prior values BEFORE an import overwrites it, '
    'with the row''s xmin as evidence of when the read happened. Returns no row '
    'when the destination row does not exist. Refuses a named field that is not '
    'a column. SQL 0210 §2.';


-- ############################################################################
-- SECTION 3 — 🔴 PUT THEM BACK, AND SAY WHAT DID NOT COME BACK
-- ############################################################################
--
-- ⚠️ `jsonb_populate_record` AND NOT A HAND-BUILT `SET` LIST. It converts
-- each value using the COLUMN'S OWN TYPE — enums, timestamptz, numeric,
-- arrays, jsonb — which a string-assembled `SET col = '...'` gets right for
-- text and wrong for everything else, one type at a time, in production.
--
-- ⚠️ `id` AND `tenant_id` ARE NEVER IN THE SET LIST even when the capture was
-- `['*']`. Restoring a row's own primary key to itself is a no-op on a good
-- day; on a bad one it is how a restore moves a row between workspaces.

CREATE OR REPLACE FUNCTION public.import_restore_prior_values(
    p_table  text,
    p_id     uuid,
    p_tenant uuid,
    p_values jsonb,
    p_fields text[]
)
RETURNS TABLE (rows_affected integer, unrestored text[])
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_rel      regclass;
  v_cols     text[];
  v_set      text;
  v_n        integer;
  v_after    jsonb;
  v_diff     text[];
BEGIN
  PERFORM import_assert_destination(p_table);

  SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::text[]) INTO v_cols
    FROM jsonb_object_keys(p_values) AS k
   WHERE k NOT IN ('id', 'tenant_id')
     AND (p_fields = ARRAY['*'] OR k = ANY (p_fields))
     AND EXISTS (
       SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = p_table
          AND c.column_name = k
          AND c.is_generated = 'NEVER'
          AND c.is_updatable = 'YES'
     );

  IF array_length(v_cols, 1) IS NULL THEN
    RAISE EXCEPTION
      'Nothing to restore into "%": the capture holds no updatable column. An '
      'undo that runs and restores nothing is worse than one that refuses.',
      p_table USING ERRCODE = '22023';
  END IF;

  -- (a, b, c) = (SELECT a, b, c FROM jsonb_populate_record(NULL::t, $1))
  SELECT string_agg(quote_ident(c), ', ' ORDER BY c) INTO v_set FROM unnest(v_cols) AS c;

  EXECUTE format(
    'UPDATE public.%I AS t SET (%s) = '
    '(SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1)) '
    'WHERE t.id = $2 AND t.tenant_id = $3',
    p_table, v_set, v_set, p_table
  ) USING p_values, p_id, p_tenant;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  rows_affected := v_n;

  IF v_n = 0 THEN
    unrestored := ARRAY[]::text[];
    RETURN NEXT;
    RETURN;
  END IF;

  -- 🔴 RE-READ AND COMPARE. See the header: the point is that "what escapes an
  -- undo" stops being a sentence somebody wrote and becomes a measurement the
  -- restore makes about its own work.
  EXECUTE format(
    'SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1 AND t.tenant_id = $2',
    p_table
  ) INTO v_after USING p_id, p_tenant;

  SELECT coalesce(array_agg(c ORDER BY c), ARRAY[]::text[]) INTO v_diff
    FROM unnest(v_cols) AS c
   WHERE (v_after -> c) IS DISTINCT FROM (p_values -> c);

  unrestored := v_diff;
  RETURN NEXT;
END
$fn$;

COMMENT ON FUNCTION public.import_restore_prior_values(text, uuid, uuid, jsonb, text[]) IS
    'Restores a destination row to its captured prior values and then RE-READS '
    'it, returning every column that did not come back. `companies` declares '
    'escapes: null and carries companies_set_updated_at, whose whole body is '
    'NEW.updated_at = now() — so updated_at never comes back, for any caller. '
    'Measuring it is what stops `escapes` being an assurance. SQL 0210 §3.';


-- ############################################################################
-- SECTION 4 — REMOVE A ROW THIS RUN CREATED
-- ############################################################################
--
-- ⚠️ NO `CASCADE`, NO SECOND STATEMENT TO CLEAN UP CHILDREN. If a destination
-- row has acquired children since the import — a payment against an invoice —
-- the foreign key refuses the delete and the caller reports that row as
-- blocked, with the database's own message. Deleting the children too would
-- be an undo removing rows the run never created, which is the same mistake
-- as `delete` on a `restore-prior` entity, one level down.

CREATE OR REPLACE FUNCTION public.import_delete_row(
    p_table  text,
    p_id     uuid,
    p_tenant uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_n integer;
BEGIN
  PERFORM import_assert_destination(p_table);

  EXECUTE format(
    'DELETE FROM public.%I t WHERE t.id = $1 AND t.tenant_id = $2', p_table
  ) USING p_id, p_tenant;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

COMMENT ON FUNCTION public.import_delete_row(text, uuid, uuid) IS
    'Removes one row an import run created, scoped to the workspace and never '
    'cascading. A row that has acquired children since the import is refused by '
    'the foreign key and reported as blocked. SQL 0210 §4.';


-- ══════════════════════════════════════════════════════════════════════════
-- SELF-VERIFICATION
-- ══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ NO FIXTURES HERE, AND THE REASON IS THE SAME AS 0208's. Exercising these
-- three functions needs a tenant and a real `companies` row, and writing
-- those inside a migration is DML on live tenant tables under FORCE row level
-- security — the shape `scripts/check-sql-rls-writes.mjs` refuses, and the
-- 0092 incident it exists for. Applied as a superuser it would also prove
-- nothing: a superuser bypasses every policy, so the writes would succeed for
-- a reason unrelated to whether the functions are right.
--
-- ⭐ THE EXERCISE IS IN `DRILL-DO-NOT-RUN-IN-NEON-0210a-restore-measures-escapes.sql`,
-- run as `ordence_app` (NOSUPERUSER, NOBYPASSRLS). Output in TRACK-REPORT.md.
--
-- 🔴 WHAT IS ASSERTED HERE IS THE ONE THING A DRILL CANNOT BE TRUSTED WITH:
-- that none of the three is `SECURITY DEFINER`. A definer function would run
-- as the owner with row security effectively off, and would quietly become
-- the way an import undo reaches another workspace's rows — the single
-- largest isolation risk this batch could introduce, and invisible to every
-- test that only ever uses one tenant.

DO $$
DECLARE
  v_name      text;
  v_missing   text[] := ARRAY[]::text[];
  v_definer   text[] := ARRAY[]::text[];
  v_expected  text[] := ARRAY[
    'import_assert_destination',
    'import_capture_prior_values',
    'import_restore_prior_values',
    'import_delete_row'
  ];
BEGIN
  FOREACH v_name IN ARRAY v_expected LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.proname = v_name AND p.pronamespace = 'public'::regnamespace
    ) THEN
      v_missing := v_missing || v_name;
    ELSIF EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.proname = v_name AND p.pronamespace = 'public'::regnamespace
         AND p.prosecdef
    ) THEN
      v_definer := v_definer || v_name;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      '0210 did not leave behind: %. server/import/reversal.ts calls all four by '
      'name and would fail at the first row of the first undo.',
      array_to_string(v_missing, ', ');
  END IF;

  IF array_length(v_definer, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      '🔴 %  is SECURITY DEFINER. It runs as the table owner, for whom row-level '
      'security is not in force, so an import undo issued in one workspace could '
      'read and write rows in another. Row-level security is the SOLE tenant '
      'isolation mechanism in this product. Every one of these must be SECURITY '
      'INVOKER.',
      array_to_string(v_definer, ', ');
  END IF;

  -- ⚠️ AND THE MEASUREMENT IS PART OF THE SIGNATURE, NOT AN IMPLEMENTATION
  -- DETAIL. A future edit that simplified `import_restore_prior_values` to
  -- return a bare row count would compile, would restore rows correctly, and
  -- would turn `escapes` back into an assurance nobody can check.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'import_restore_prior_values'
       AND p.pronamespace = 'public'::regnamespace
       AND 'unrestored' = ANY (p.proargnames)
  ) THEN
    RAISE EXCEPTION
      'import_restore_prior_values no longer returns `unrestored`. That column is '
      'how "what escapes an undo" stops being a sentence somebody wrote and '
      'becomes something the restore measured about its own work — `companies` '
      'declares escapes: null and carries a trigger that rewrites updated_at on '
      'every UPDATE.';
  END IF;

  RAISE NOTICE
    '0210: four primitives present, all SECURITY INVOKER, and the restore still '
    'returns what did not come back. Exercise: DRILL-DO-NOT-RUN-IN-NEON-0210a.';
END $$;
