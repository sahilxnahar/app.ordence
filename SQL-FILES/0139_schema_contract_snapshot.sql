-- ############################################################################
-- 0139 — A FINGERPRINT OF THE SECURITY SHAPE, SO `drizzle-kit push` CANNOT
--        REMOVE 300 POLICIES QUIETLY (Wave 15 / Track C)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE DISASTER THIS FILE IS ABOUT
-- ══════════════════════════════════════════════════════════════════════════
-- `drizzle-kit push` treats anything absent from `db/schema/*.ts` as drift
-- and removes it. Policies, triggers and functions are all absent from
-- `db/schema/*.ts`. Measured during Phase 10 and quoted in
-- `.github/workflows/security-ci.yml`:
--
--     before push -> 25 tables with RLS, 25 policies
--     after  push ->  0 tables with RLS,  0 policies
--
-- Today that is 303 tables and 314 policies.
--
-- 🔴 THE FAILURE HAS NO SYMPTOM. The application keeps working — it filters
-- by tenant in code as well — every page loads, every test that goes through
-- the ORM passes. The only observable difference is that one customer can
-- read another customer's data, and nobody looks.
--
-- ⚠️ AND THE EXISTING DEFENCES ARE ALL PROCEDURAL. `npm run db:push` carries
-- a `NODE_ENV=production` guard; `drizzle.config.ts` is checked in;
-- `scripts/drizzle-kit.mjs` is the sanctioned wrapper; four documents say
-- never to run it. Every one of those stops the command being run BY THIS
-- REPOSITORY. None of them notices if it is run from a laptop, from a
-- different checkout, or from `npx drizzle-kit push` typed directly — which
-- is the way it actually gets run.
--
-- ⭐ SO THIS RECORDS WHAT THE SHAPE IS, AND MAKES THE DIFFERENCE COMPUTABLE.
-- A committed fingerprint plus a live one; if they disagree, something
-- removed or added a control and the difference is printed by name.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT IS IN THE FINGERPRINT, AND WHY NOT MORE
-- ══════════════════════════════════════════════════════════════════════════
--   · every table with a tenant_id, with relrowsecurity and relforcerowsecurity
--   · every policy: table, name, command, USING text, WITH CHECK text
--   · every non-internal trigger: table, name, the FUNCTION it executes
--   · every function in `public`, by name and argument types
--
-- ⚠️ COLUMNS AND INDEXES ARE DELIBERATELY OUT. They change on every ordinary
-- feature commit, so including them would make the fingerprint differ every
-- day, and a check that is red every day is a check that gets ignored — the
-- same failure as a gate nobody runs. This fingerprint covers exactly the
-- objects that `drizzle-kit push` destroys and that ordinary development does
-- not touch, so a difference here is worth reading.
--
-- ⚠️ AND THE POLICY TEXT IS NORMALISED, NOT RAW. PostgreSQL re-prints a
-- policy expression with its own parenthesisation and casts, and that
-- rendering can differ between minor versions. Whitespace is collapsed and
-- the text lower-cased so a `16.4` → `16.13` upgrade is not reported as 314
-- policy changes. A semantic change still shows, because the identifiers do.
--
-- ══════════════════════════════════════════════════════════════════════════
-- HOW IT IS USED
-- ══════════════════════════════════════════════════════════════════════════
--     SELECT schema_contract_fingerprint();       -- one sha256 over everything
--     SELECT * FROM schema_contract_rows();       -- the individual entries
--     SELECT capture_schema_contract('why');      -- store today's shape
--     SELECT * FROM diff_schema_contract();       -- live vs the last capture
--
-- `scripts/check-rls-coverage.mjs` calls `diff_schema_contract()` on every
-- CI run and fails on any row it returns. The capture is made deliberately,
-- by a human, when a change to the security shape is intended — so an
-- unexplained difference is a difference nobody intended.
--
-- IS THERE DATA LOSS?  No. One table, four functions. No row is deleted.
--
-- RUN ORDER
-- ---------
-- After 0136–0138, so the first capture records the REPAIRED shape rather
-- than freezing the six missing policies into the baseline. SQL FIRST.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent.
--
-- RLS
-- ---
-- `schema_contract_snapshots` describes the schema, not any tenant, and
-- carries no `tenant_id`. Not readable by the application: the list of every
-- policy expression in the database is a map of the isolation boundary and
-- there is no product reason for a tenant session to hold it.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — WHAT THE SHAPE IS
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.schema_contract_rows()
RETURNS TABLE (kind text, ident text, detail text)
LANGUAGE sql
STABLE
AS $fn$
  /* ---- tenant tables, and whether row security binds --------------- */
  SELECT 'table'::text,
         c.relname::text,
         format('rls=%s force=%s', c.relrowsecurity, c.relforcerowsecurity)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)

  UNION ALL

  /* ---- policies ---------------------------------------------------- */
  -- ⚠️ NORMALISED. See the header: raw `pg_get_expr` output is a rendering,
  -- and renderings change between server versions.
  SELECT 'policy'::text,
         (p.tablename || '.' || p.policyname)::text,
         lower(regexp_replace(
           format('cmd=%s using=%s check=%s',
                  p.cmd, coalesce(p.qual::text, '-'), coalesce(p.with_check::text, '-')),
           '\s+', ' ', 'g'))
    FROM pg_policies p
   WHERE p.schemaname = 'public'

  UNION ALL

  /* ---- triggers, keyed on the FUNCTION they run -------------------- */
  -- ⭐ THE FUNCTION, NOT THE NAME. 0028's `trg_touch_sales_orders` and
  -- 0001's `sales_orders_set_updated_at` are the same control under two
  -- names; a fingerprint keyed on names alone reports a rename as a change
  -- and a repointed function as no change, which is exactly backwards.
  SELECT 'trigger'::text,
         (c.relname || '.' || t.tgname)::text,
         format('executes=%s enabled=%s deferrable=%s',
                p.proname, t.tgenabled, t.tgdeferrable)
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p      ON p.oid = t.tgfoid
   WHERE n.nspname = 'public' AND NOT t.tgisinternal

  UNION ALL

  /* ---- functions --------------------------------------------------- */
  -- ⚠️ EXTENSION-OWNED FUNCTIONS ARE EXCLUDED, AND WAVE 17 IS WHY.
  -- `0158_perf_slow_query_visibility.sql` does `CREATE EXTENSION IF NOT
  -- EXISTS pg_stat_statements`, which lands three functions in `public` —
  -- one of them with a forty-four-column OUT list. They are not part of
  -- the security shape this repository controls, they change with the
  -- server version, and they made the contract report three differences
  -- that nobody could act on. `pg_depend.deptype = 'e'` is the catalog's
  -- own answer to "does this belong to an extension".
  SELECT 'function'::text,
         (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text,
         format('security_definer=%s', p.prosecdef)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid
          AND d.deptype = 'e')
$fn$;

COMMENT ON FUNCTION public.schema_contract_rows() IS
  'One row per security-relevant schema object: tenant tables with their RLS '
  'flags, every policy, every non-internal trigger keyed on the function it '
  'executes, and every function in public. Columns and indexes are '
  'deliberately absent — they change daily and would make the contract noisy.';


CREATE OR REPLACE FUNCTION public.schema_contract_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  SELECT encode(
           sha256(convert_to(
             coalesce(string_agg(kind || '|' || ident || '|' || detail, E'\n'
                                 ORDER BY kind, ident), ''),
             'UTF8')),
           'hex')
    FROM schema_contract_rows();
$fn$;

COMMENT ON FUNCTION public.schema_contract_fingerprint() IS
  'One sha256 over every row of schema_contract_rows(), ordered. Two databases '
  'with the same fingerprint have the same security shape. Cheap enough to '
  'print in a deploy log.';


-- ----------------------------------------------------------------------------
-- SECTION 2 — STORING A CAPTURE
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.schema_contract_snapshots (
  id           bigserial   PRIMARY KEY,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  captured_by  text        NOT NULL DEFAULT current_user,
  reason       text        NOT NULL,
  fingerprint  text        NOT NULL,
  row_count    integer     NOT NULL,
  rows_jsonb   jsonb       NOT NULL
);

COMMENT ON TABLE public.schema_contract_snapshots IS
  'Deliberate captures of the security shape. `diff_schema_contract()` '
  'compares the live database to the most recent row. A capture is an act, '
  'not a side effect: it is how somebody says "this change was intended".';


CREATE OR REPLACE FUNCTION public.capture_schema_contract(reason text)
RETURNS TABLE (snapshot_id bigint, fingerprint text, row_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  fp   text;
  n    integer;
  js   jsonb;
  sid  bigint;
BEGIN
  IF reason IS NULL OR btrim(reason) = '' THEN
    RAISE EXCEPTION
      'capture_schema_contract() needs a reason. A snapshot with no stated '
      'reason is indistinguishable from one taken to make a failing check go '
      'away, which is the only way this control can be defeated.'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer,
         jsonb_agg(jsonb_build_array(kind, ident, detail) ORDER BY kind, ident)
    INTO n, js
    FROM schema_contract_rows();

  -- 🔴 ZERO IS NEVER A CAPTURE. An empty database fingerprints to the sha256
  -- of the empty string, and a later diff against it would report every
  -- object in the product as an addition — or, worse, a diff taken while
  -- something was dropping objects would come out clean.
  IF n = 0 THEN
    RAISE EXCEPTION
      'Refusing to capture a schema contract with ZERO rows. This database has '
      'no tenant tables, no policies, no triggers and no functions, so the '
      'snapshot would certify an empty schema as the intended shape.'
      USING ERRCODE = '23514';
  END IF;

  fp := schema_contract_fingerprint();

  INSERT INTO schema_contract_snapshots (reason, fingerprint, row_count, rows_jsonb)
  VALUES (btrim(reason), fp, n, js)
  RETURNING id INTO sid;

  RETURN QUERY SELECT sid, fp, n;
END;
$fn$;


-- ----------------------------------------------------------------------------
-- SECTION 3 — THE DIFF
-- ----------------------------------------------------------------------------
--
-- ⚠️ IT RETURNS ROWS RATHER THAN RAISING, and the caller decides. The gate
-- fails the build on any row; an operator investigating a suspected push
-- wants the list, not an exception with the first entry in it.

CREATE OR REPLACE FUNCTION public.diff_schema_contract(snapshot bigint DEFAULT NULL)
RETURNS TABLE (change text, kind text, ident text, was text, is_now text)
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  sid bigint;
BEGIN
  SELECT coalesce(snapshot, (SELECT max(id) FROM schema_contract_snapshots))
    INTO sid;

  -- 🔴 NO SNAPSHOT IS NOT "NO DIFFERENCES". A function that returns zero rows
  -- when it has nothing to compare against is a check that passes loudest at
  -- the moment it is least able to say anything.
  IF sid IS NULL THEN
    RAISE EXCEPTION
      'No schema contract has ever been captured, so there is nothing to diff '
      'against. Run: SELECT * FROM capture_schema_contract(''baseline'');'
      USING ERRCODE = '42704';
  END IF;

  RETURN QUERY
  WITH snap AS (
    SELECT e->>0 AS kind, e->>1 AS ident, e->>2 AS detail
      FROM schema_contract_snapshots s,
           jsonb_array_elements(s.rows_jsonb) e
     WHERE s.id = sid
  ),
  live AS (SELECT * FROM schema_contract_rows())
  SELECT 'REMOVED'::text, s.kind, s.ident, s.detail, NULL::text
    FROM snap s LEFT JOIN live l ON l.kind = s.kind AND l.ident = s.ident
   WHERE l.ident IS NULL
  UNION ALL
  SELECT 'ADDED'::text, l.kind, l.ident, NULL::text, l.detail
    FROM live l LEFT JOIN snap s ON s.kind = l.kind AND s.ident = l.ident
   WHERE s.ident IS NULL
  UNION ALL
  SELECT 'CHANGED'::text, l.kind, l.ident, s.detail, l.detail
    FROM live l JOIN snap s ON s.kind = l.kind AND s.ident = l.ident
   WHERE s.detail IS DISTINCT FROM l.detail
  ORDER BY 1, 2, 3;
END;
$fn$;

COMMENT ON FUNCTION public.diff_schema_contract(bigint) IS
  'Live security shape versus a captured snapshot (the latest by default). '
  'A REMOVED policy row is what `drizzle-kit push` looks like. Raises rather '
  'than returning empty when no snapshot exists.';


DO $$
BEGIN
  REVOKE ALL ON public.schema_contract_snapshots FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.capture_schema_contract(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.diff_schema_contract(bigint) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.schema_contract_rows() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.schema_contract_fingerprint() FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    -- ⚠️ NOT THE APPLICATION, ON EITHER SIDE. Reading it hands a tenant
    -- session the full text of every isolation policy. Writing it would let
    -- the application re-baseline the contract, which is the one act that
    -- turns this control off.
    REVOKE ALL ON public.schema_contract_snapshots FROM ordence_app;
    REVOKE ALL ON FUNCTION public.capture_schema_contract(text) FROM ordence_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_maintenance') THEN
    GRANT SELECT ON public.schema_contract_snapshots TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.diff_schema_contract(bigint) TO ordence_maintenance;
    GRANT EXECUTE ON FUNCTION public.schema_contract_fingerprint() TO ordence_maintenance;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 4 — TAKE THE FIRST CAPTURE, AND VERIFY THE MACHINERY WORKS
-- ----------------------------------------------------------------------------
--
-- ⚠️ THE VERIFICATION BELOW DOES NOT ASK "DOES THE FUNCTION EXIST". It makes
-- the diff report a change that is really there and then report none — because
-- "the object was created" is what every migration in this repository that
-- later turned out to do nothing was able to prove about itself.

SELECT capture_schema_contract('0139 baseline — first capture after the wave-15 repairs');

DO $$
DECLARE
  n_rows     integer;
  n_diff     integer;
  fp_a       text;
  fp_b       text;
  n_detected integer;
BEGIN
  SELECT count(*) INTO n_rows FROM schema_contract_rows();
  IF n_rows = 0 THEN
    RAISE EXCEPTION '0139 FAILED: schema_contract_rows() returned nothing.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM schema_contract_snapshots) THEN
    RAISE EXCEPTION '0139 FAILED: the baseline capture did not store a row.'
      USING ERRCODE = '23514';
  END IF;

  /* -- 1. the live database matches the capture just taken ----------- */
  SELECT count(*) INTO n_diff FROM diff_schema_contract();
  IF n_diff <> 0 THEN
    RAISE EXCEPTION
      '0139 FAILED: % difference(s) between the live schema and the snapshot '
      'taken moments ago. The comparison is not stable, so every future run '
      'would be red and would be ignored.', n_diff
      USING ERRCODE = '23514';
  END IF;

  /* -- 2. THE DIFF ACTUALLY DETECTS A REMOVED POLICY ----------------- */
  -- ⭐ THIS IS THE PART THAT MATTERS. A comparison that returns zero rows
  -- proves nothing unless it can also return one. A policy is dropped, the
  -- diff is asked, and the policy is put straight back — inside one DO block,
  -- so it is a single statement and cannot be interrupted half-done.
  fp_a := schema_contract_fingerprint();

  ALTER TABLE public.audit_logs DISABLE ROW LEVEL SECURITY;

  SELECT count(*) INTO n_detected
    FROM diff_schema_contract()
   WHERE kind = 'table' AND ident = 'audit_logs' AND change = 'CHANGED';

  ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

  fp_b := schema_contract_fingerprint();

  IF n_detected <> 1 THEN
    RAISE EXCEPTION
      '0139 FAILED: row security was turned OFF on audit_logs and '
      'diff_schema_contract() reported % change(s) rather than 1. The contract '
      'cannot see the thing it exists to see.', n_detected
      USING ERRCODE = '23514';
  END IF;

  IF fp_a IS DISTINCT FROM fp_b THEN
    RAISE EXCEPTION
      '0139 FAILED: the fingerprint did not return to its original value after '
      'the probe. audit_logs may have been left with row security disabled — '
      'check `SELECT relrowsecurity FROM pg_class WHERE relname=''audit_logs''` '
      'NOW.'
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE
    '0139 PASS: % contract rows, fingerprint %. The diff reported 0 changes '
    'against the fresh capture AND 1 change when row security was momentarily '
    'removed from audit_logs, so it is not vacuous. audit_logs was restored '
    'and the fingerprint matches its pre-probe value.',
    n_rows, left(fp_a, 16) || '…';
END
$$;
