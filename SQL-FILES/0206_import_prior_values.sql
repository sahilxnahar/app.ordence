-- ############################################################################
-- 0206 — WHAT THE ROW SAID BEFORE THE MIGRATION OVERWROTE IT
--        (Phase 2 — the run ledger, idempotency and reversal)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHY A SEPARATE TABLE AND NOT A COLUMN ON THE SIDECAR
-- ══════════════════════════════════════════════════════════════════════════
-- The obvious shape is `import_row_provenance.prior_values jsonb NULL`. It is
-- rejected for a reason that only shows up when you write the constraint:
-- the two tables assert OPPOSITE things about the same transaction.
--
--   provenance   the destination row's xmin MUST EQUAL this transaction —
--                the row and its attribution commit together (0205 §4).
--   prior values the destination row's xmin MUST NOT EQUAL this transaction —
--                the values were read BEFORE this transaction overwrote them.
--
-- One nullable column cannot carry both, and a trigger that switches on
-- whether the column is null is a trigger that does nothing for the null
-- case, which is the case that matters.
--
-- ⭐ AND IT MAKES "DO NOT CAPTURE DEFENSIVELY" MEASURABLE. The brief is
-- explicit: *"Capture is not free and it is not universal. An entity
-- declaring `delete` must not pay for it."* With a separate table the cost of
-- a `delete` entity is a row count of zero, which a test can assert. With a
-- nullable column it is a NULL per row, which nothing can distinguish from a
-- capture that was attempted and lost.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 THE FAILURE THIS FILE IS ACTUALLY BUILT AGAINST
-- ══════════════════════════════════════════════════════════════════════════
-- Not "the capture is missing". A missing capture fails loudly at undo time,
-- when there is nothing to restore.
--
-- The failure is a capture taken ONE STATEMENT TOO LATE — after the UPDATE
-- rather than before it. Everything about it looks right: there is a row, it
-- has values in it, the undo runs, it reports success, and it restores the
-- values the import itself just wrote. The customer is told their migration
-- has been undone and their records still say what the migration made them
-- say. It is the purest possible form of "verified by a floor", and no amount
-- of reading the TypeScript catches it, because both orderings compile.
--
-- ⭐ SO THE ORDER IS RECORDED AS EVIDENCE. `observed_xmin` is the
-- destination row's `xmin` AT THE MOMENT OF THE READ. Captured before the
-- overwrite it is some earlier transaction's id. Captured after, it is this
-- transaction's own id — and §3 refuses that, by name, with the sentence
-- above in the error message.
--
-- ############################################################################


-- ############################################################################
-- SECTION 1 — THE TABLE
-- ############################################################################

CREATE TABLE IF NOT EXISTS public.import_row_prior_values (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- ⚠️ THE PROVENANCE ROW, NOT JUST THE RUN. A captured prior with no
    -- provenance row is a set of values with nothing saying which write they
    -- precede, and the undo would have to match them back by (table, id) —
    -- which is the join the sidecar exists to make unnecessary.
    provenance_id uuid NOT NULL,
    run_id        uuid NOT NULL,

    target_table  varchar(63) NOT NULL,
    target_id     uuid NOT NULL,

    -- ⚠️ THE DECLARATION, COPIED. `['*']` means the whole row and is what
    -- both contracted `restore-prior` entities use today. Storing the list
    -- rather than inferring it from the keys of `prior_values` means an undo
    -- can tell "the author asked for three fields" from "the row only had
    -- three non-null columns".
    captured_fields text[] NOT NULL,

    -- ⚠️ EVERY COLUMN THE CAPTURE ASKED FOR, INCLUDING THE NULLS. A field
    -- that was NULL before the import and is not represented here would come
    -- back as "not restored" rather than "restored to NULL", and the row
    -- would keep whatever the import put in it.
    prior_values  jsonb NOT NULL,

    -- 🔴 SEE THE HEADER. The destination row's xmin at the moment it was READ.
    observed_xmin bigint NOT NULL,
    captured_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT import_row_prior_values_id_tenant_key UNIQUE (id, tenant_id),

    CONSTRAINT import_row_prior_values_provenance_same_tenant
        FOREIGN KEY (provenance_id, tenant_id)
        REFERENCES public.import_row_provenance (id, tenant_id) ON DELETE CASCADE,

    CONSTRAINT import_row_prior_values_run_same_tenant
        FOREIGN KEY (run_id, tenant_id)
        REFERENCES public.import_runs (id, tenant_id) ON DELETE CASCADE,

    -- One capture per write.
    CONSTRAINT import_row_prior_values_one_per_write UNIQUE (provenance_id),

    -- ⭐⭐ THE FIRST CAPTURE WINS, AND THIS INDEX IS WHAT MAKES THAT TRUE.
    -- A file with two rows sharing a natural key updates the same destination
    -- row twice in one run. The second capture would read what the FIRST
    -- write left behind — the import's own values — and an undo built on it
    -- restores the migration rather than removing it. The writer inserts with
    -- ON CONFLICT DO NOTHING against this constraint, so the second capture
    -- is discarded and the true prior survives.
    CONSTRAINT import_row_prior_values_first_wins
        UNIQUE (run_id, target_table, target_id),

    -- 🔴 AN EMPTY CAPTURE LIST IS THE SAME FAILURE AS A MISSING ONE: an undo
    -- that runs, reports success, and restores nothing. `checkImportContract`
    -- refuses it at definition time; this refuses it at write time, because
    -- the two are different moments and the contract can be edited.
    CONSTRAINT import_row_prior_values_fields_named
        CHECK (array_length(captured_fields, 1) >= 1),

    CONSTRAINT import_row_prior_values_values_present
        CHECK (jsonb_typeof(prior_values) = 'object' AND prior_values <> '{}'::jsonb)
);

COMMENT ON TABLE public.import_row_prior_values IS
    'What a destination row said BEFORE a migration running in `update` mode '
    'overwrote it — the only thing a `restore-prior` undo has to restore, '
    'because by undo time the values are gone. `observed_xmin` records the '
    'destination row''s xmin at the moment of the read, and §3 refuses any row '
    'whose capture happened after the overwrite rather than before it. '
    'Phase 2, SQL 0206.';

COMMENT ON COLUMN public.import_row_prior_values.observed_xmin IS
    'The destination row''s xmin AS READ. Equal to this transaction''s id means '
    'the capture ran after the overwrite and holds the values the import just '
    'wrote — an undo built on it restores the migration instead of removing it. '
    'Refused by import_row_prior_values_before_overwrite().';

COMMENT ON COLUMN public.import_row_prior_values.prior_values IS
    'Every column the capture asked for, including the ones that were NULL. '
    'Omitting a NULL would make it "not restored" rather than "restored to '
    'NULL", and the row would keep whatever the import put there.';

CREATE INDEX IF NOT EXISTS import_row_prior_values_run_idx
    ON public.import_row_prior_values (tenant_id, run_id);


-- ############################################################################
-- SECTION 2 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ⚠️ THIS TABLE HOLDS WHOLE COPIES OF CUSTOMER RECORDS. `capturePriorFields:
-- ["*"]` is the right answer for both contracted entities and it means a
-- verbatim snapshot of a `companies` row, addresses and all. Its isolation is
-- not "the same as the sidecar's because they are neighbours" — it is the
-- same because it must be at least as strict as the table it copies.

ALTER TABLE public.import_row_prior_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_row_prior_values FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_row_prior_values_tenant_isolation ON public.import_row_prior_values;
CREATE POLICY import_row_prior_values_tenant_isolation
    ON public.import_row_prior_values
    USING      ((tenant_id = app_current_tenant_id()) OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 3 — 🔴 CAPTURED BEFORE THE OVERWRITE, OR NOT AT ALL
-- ############################################################################
--
-- ⚠️ AN `AFTER` TRIGGER, DELIBERATELY, AND THE CHOICE IS LOAD-BEARING.
-- `import_row_prior_values_first_wins` above is only useful if the writer can
-- say `ON CONFLICT DO NOTHING`. A BEFORE trigger fires for a row that is then
-- discarded by the conflict, so a BEFORE version of this check would raise on
-- the perfectly correct second capture — the one whose whole purpose is to be
-- thrown away. AFTER row triggers do not fire for rows ON CONFLICT DO NOTHING
-- discards, which is exactly the behaviour this needs.
--
-- ⚠️ AND IT STILL ABORTS. An AFTER trigger raising rolls the statement and
-- its transaction back like any other. "AFTER" is about ordering, not force.

CREATE OR REPLACE FUNCTION public.import_row_prior_values_before_overwrite()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_current bigint;
  v_kind    text;
BEGIN
  SELECT p.reversal_kind INTO v_kind
    FROM public.import_row_provenance p
   WHERE p.id = NEW.provenance_id AND p.tenant_id = NEW.tenant_id;

  -- ⚠️ THE OTHER DIRECTION, AND THE BRIEF ASKS FOR IT BY NAME: *"An entity
  -- declaring `delete` must not pay for it."* A capture against a write whose
  -- declared reversal never reads one is either a misdeclared entity or a
  -- writer capturing defensively for everything — and a full copy of every
  -- customer record written on every import is not a small mistake.
  IF v_kind IS DISTINCT FROM 'restore-prior' THEN
    RAISE EXCEPTION
      'Prior values were captured for a write whose declared reversal kind is '
      '"%". Only `restore-prior` ever reads them, so this is either a '
      'misdeclared entity or a writer capturing defensively for every entity — '
      'which writes a verbatim copy of a customer record on every imported row.',
      coalesce(v_kind, '(no provenance row)')
      USING ERRCODE = '22023';
  END IF;

  v_current := (pg_current_xact_id()::text::bigint) % 4294967296;

  IF NEW.observed_xmin = v_current THEN
    RAISE EXCEPTION
      'Prior values for row % in "%" were read by transaction % — the same '
      'transaction that overwrote it. They are therefore the values the import '
      'just wrote, not the values that preceded it. An undo built on this row '
      'would run, report success, and restore the migration.',
      NEW.target_id, NEW.target_table, v_current
      USING ERRCODE = '25000';
  END IF;

  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.import_row_prior_values_before_overwrite() IS
    'Refuses a capture taken after the overwrite (observed_xmin = this '
    'transaction) and a capture taken for an entity whose declared reversal '
    'kind is not restore-prior. AFTER INSERT so ON CONFLICT DO NOTHING can '
    'discard the second capture of the same row without tripping it. 0206 §3.';

DROP TRIGGER IF EXISTS import_row_prior_values_before_overwrite
    ON public.import_row_prior_values;
CREATE TRIGGER import_row_prior_values_before_overwrite
    AFTER INSERT ON public.import_row_prior_values
    FOR EACH ROW EXECUTE FUNCTION public.import_row_prior_values_before_overwrite();


-- ############################################################################
-- SECTION 4 — 🔴🔴 A `restore-prior` UPDATE WITHOUT A CAPTURE IS REFUSED
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE ONE CONSTRAINT IN THIS BATCH THAT HAD TO BE DEFERRED, AND WHY
-- ══════════════════════════════════════════════════════════════════════════
-- Everything above refuses a BAD capture. Nothing yet refuses a MISSING one,
-- and a missing capture is the more likely accident by a wide margin: the
-- writer for a new entity is copied from the `delete` one next to it, the
-- contract says `restore-prior`, gate 29 is happy because the contract is
-- internally coherent, and the undo silently restores nothing for that
-- entity while the run report says "reversed".
--
-- ⭐ THE OBLIGATION IS: a provenance row with
-- `reversal_kind = 'restore-prior'` AND `operation = 'update'` must have
-- exactly one capture. Insert, no. Any other kind, no. That pair is the only
-- shape that has something to restore.
--
-- ⚠️ IT CANNOT BE AN ORDINARY TRIGGER. The provenance row and the capture are
-- written by the same transaction in whichever order the writer finds
-- convenient, and an immediate check on the provenance insert would refuse a
-- correct writer that captures second. `DEFERRABLE INITIALLY DEFERRED` moves
-- the question to COMMIT, where the answer is the one that matters: when this
-- transaction ends, does every restore-prior update have its prior values?
--
-- ⚠️ NOTE FOR ANY FILE THAT LATER TOUCHES THESE TABLES IN BULK: a deferred
-- constraint trigger that has fired makes `ALTER TABLE ... ENABLE TRIGGER`
-- fail with "cannot ALTER TABLE because it has pending trigger events" for
-- the rest of the transaction. `journal_entries_balance_check` has cost this
-- repository a batch already (0108).

CREATE OR REPLACE FUNCTION public.import_row_provenance_capture_required()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_captures integer;
BEGIN
  IF NEW.reversal_kind <> 'restore-prior' OR NEW.operation <> 'update' THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::int INTO v_captures
    FROM public.import_row_prior_values v
   WHERE v.provenance_id = NEW.id AND v.tenant_id = NEW.tenant_id;

  IF v_captures <> 1 THEN
    RAISE EXCEPTION
      'Run % overwrote row % in "%" under a `restore-prior` policy and committed '
      '% prior-value captures for it; exactly 1 is required. By the time an undo '
      'runs the prior values are gone, so an undo of this row would restore '
      'nothing while reporting that it did.',
      NEW.run_id, NEW.target_id, NEW.target_table, v_captures
      USING ERRCODE = '23502';
  END IF;

  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.import_row_provenance_capture_required() IS
    'At COMMIT: every provenance row that is (restore-prior, update) must have '
    'exactly one prior-value capture. Deferred because the writer may record '
    'the two in either order within its transaction. 0206 §4.';

DROP TRIGGER IF EXISTS import_row_provenance_capture_required
    ON public.import_row_provenance;
CREATE CONSTRAINT TRIGGER import_row_provenance_capture_required
    AFTER INSERT ON public.import_row_provenance
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.import_row_provenance_capture_required();


-- ############################################################################
-- SECTION 5 — TENANT-TABLE OBLIGATIONS
-- ############################################################################

DO $$
DECLARE
  v_logged  text[];
  v_guarded text[];
BEGIN
  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO v_logged FROM attach_change_log_triggers() t;
  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO v_guarded FROM attach_impersonation_guards() t;

  RAISE NOTICE
    '0206: change-log triggers attached to [%]; impersonation guards attached to [%].',
    array_to_string(v_logged, ', '), array_to_string(v_guarded, ', ');
END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- SELF-VERIFICATION
-- ══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_enabled  boolean;
  v_forced   boolean;
  v_policies integer;
  v_deferred boolean;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity
    INTO v_enabled, v_forced
    FROM pg_class WHERE oid = 'public.import_row_prior_values'::regclass;

  IF NOT (v_enabled AND v_forced) THEN
    RAISE EXCEPTION
      'import_row_prior_values has row security enabled=% forced=%. This table '
      'holds verbatim copies of customer records; ENABLE alone does not apply '
      'to the owner, which is what production connects as.',
      v_enabled, v_forced;
  END IF;

  SELECT count(*)::int INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'import_row_prior_values';
  IF v_policies <> 1 THEN
    RAISE EXCEPTION
      'import_row_prior_values carries % policies; exactly 1 was written.',
      v_policies;
  END IF;

  -- 🔴 THE OBLIGATION TRIGGER MUST BE DEFERRED, NOT MERELY PRESENT. An
  -- immediate version of it refuses every correct writer that records the
  -- capture after the provenance row — which reads, from the outside, as
  -- "the capture requirement does not work" and gets removed.
  SELECT tgdeferrable
    INTO v_deferred
    FROM pg_trigger
   WHERE tgrelid = 'public.import_row_provenance'::regclass
     AND tgname  = 'import_row_provenance_capture_required';

  IF v_deferred IS NULL THEN
    RAISE EXCEPTION
      'import_row_provenance_capture_required is absent. Without it a writer '
      'that declares restore-prior and captures nothing produces an undo that '
      'restores nothing and reports success — and CI gate 29 cannot see it, '
      'because the contract it reads is internally coherent.';
  END IF;

  IF NOT v_deferred THEN
    RAISE EXCEPTION
      'import_row_provenance_capture_required exists but is not DEFERRABLE. It '
      'would then refuse any writer that records the provenance row before the '
      'capture, which is a correct writer.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.import_row_prior_values'::regclass
       AND tgname  = 'import_row_prior_values_before_overwrite'
       AND (tgtype::int & 2) = 0     -- AFTER, not BEFORE
  ) THEN
    RAISE EXCEPTION
      'import_row_prior_values_before_overwrite is absent or is a BEFORE '
      'trigger. As a BEFORE trigger it fires for the second capture of a row '
      'that ON CONFLICT DO NOTHING then discards, and refuses a correct write.';
  END IF;

  RAISE NOTICE
    '0206: import_row_prior_values verified — RLS enabled and forced, 1 policy, '
    'the ordering check is AFTER INSERT, the capture obligation is deferred.';
END $$;
