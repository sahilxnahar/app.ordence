-- ############################################################################
-- 0205 — WHICH RUN PUT THIS ROW HERE, AND WHAT DID IT DO TO IT
--        (Phase 2 — the run ledger, idempotency and reversal)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 READ THIS FIRST: SQL 0196 DOES NOT EXIST, AND THIS FILE IS WHY
-- ══════════════════════════════════════════════════════════════════════════
-- `lib/import/types.ts` says, twice, that `import_row_provenance` is written
-- "by the same transaction as the row it describes — see SQL 0196". The Phase
-- 2 brief repeats it: *"M1 shipped SQL 0196, the `import_row_provenance`
-- sidecar"*.
--
-- It did not. Measured on the delivered v1.84.1-alpha tree:
--
--     $ ls SQL-FILES | grep -E '^0(19|20)' | wc -l
--     0
--     $ ls SQL-FILES/*.sql | tail -1
--     SQL-FILES/0168_audit_stream_comment_correction.sql
--     $ grep -rl import_row_provenance . --exclude-dir=node_modules
--     ./lib/import/types.ts          ← the prose, and nothing else
--
-- Track M1's block in `scripts/track-ownership.json` is [196, 199]. It
-- reserved the number, described the table in a comment, made `provenance`
-- a required member of every contract, and shipped no DDL. So every entity
-- in `ALL_IMPORT_ENTITIES` today declares a provenance policy pointing at a
-- table that has never existed — declared-and-unenforced, which is the exact
-- defect the contract's own header says it was written to remove.
--
-- ⚠️ THIS FILE CARRIES THE NUMBER 0205, NOT 0196. 0196 belongs to M1's block
--    and reusing another track's number is the mistake `check:migrations`
--    has now refused four times (0062, 0072, 0076, 0107). Every statement
--    below is `IF NOT EXISTS` or `CREATE OR REPLACE`, so if M1 later lands a
--    real 0196 that creates the same table, whichever runs second is a
--    no-op — and §6 refuses to leave a table whose SHAPE disagrees with what
--    this file needs, rather than assuming the two agree.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT THE SIDECAR IS FOR, IN ONE SENTENCE EACH
-- ══════════════════════════════════════════════════════════════════════════
--   REVERSAL     "Which rows did this run create?" The only other available
--                answer is "rows created between these two timestamps",
--                which catches every row the customer's staff typed by hand
--                during the migration window. A migration takes hours and
--                the office does not stop.
--   SUPPORT      "Which file, which line, which run put this here."
--   RECONCILIATION  40 input lines producing 1 document is correct for an
--                opening trial balance and a 39-row loss for a contact list.
--                `cardinality` is what tells those apart.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴🔴 THE COLUMN THAT IS NOT IN THE BRIEF AND IS LOAD-BEARING: `operation`
-- ══════════════════════════════════════════════════════════════════════════
-- The brief lists the sidecar's contents as "(run, entity, input row number,
-- target table, target id)". That set cannot undo a `restore-prior` entity.
--
-- `companies` offers duplicate mode `update` and declares `restore-prior`. A
-- single run over one file does BOTH of these, row by row, and which one it
-- did is decided by whether the natural key matched:
--
--     row 1  no match  → INSERT.  There is no prior. Undo = DELETE.
--     row 2  matched   → UPDATE.  There is a prior. Undo = RESTORE.
--
-- An undo that only restores leaves every row the run CREATED behind, and
-- reports success. An undo that only deletes destroys the customer's
-- pre-existing records — which is the precise catastrophe CI gate 29 exists
-- to refuse, arrived at from the other side, at undo time, where gate 29
-- cannot see it.
--
-- Only the write path knows which happened, and only for the instant it is
-- happening. `operation` is where it says so.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 AND `reversal_kind` IS COPIED IN, NOT LOOKED UP AT UNDO TIME
-- ══════════════════════════════════════════════════════════════════════════
-- `lib/import/types.ts` states the reason for the contract existing at all:
-- reversal is "declared at DEFINITION time because at undo time the entity
-- that wrote the row may no longer be the one being asked." The same
-- argument applies one level down. An entity whose `reversal.kind` is
-- changed from `delete` to `restore-prior` next quarter must not change how
-- a run written last quarter is undone — that run captured no prior values,
-- so a `restore-prior` undo of it would restore nothing and say it had.
--
-- This is the same discipline as `sales_invoices` storing the GST split it
-- was issued under rather than re-deriving it: captured at issue, because
-- the master data moves.
--
-- ############################################################################


-- ############################################################################
-- SECTION 1 — `import_runs` GAINS A COMPOSITE KEY TO BE POINTED AT
-- ############################################################################
--
-- ⚠️ SINGLE-COLUMN FOREIGN KEYS ARE NOT ENOUGH IN THIS SCHEMA, and 0021,
-- 0146 and 0150 each say so at length: referential integrity runs as the
-- REFERENCED table's owner with row security OFF, so a single-column FK
-- happily resolves a run row the writing session cannot even SELECT. The
-- composite key is what makes `(run_id, tenant_id)` a statement about one
-- workspace rather than about the whole database.
--
-- Free now. An ALTER, a backfill and an argument later.

-- ⚠️ ADDED IF ABSENT, NEVER DROPPED AND RE-ADDED. `DROP CONSTRAINT IF EXISTS`
-- followed by `ADD CONSTRAINT` is the ordinary idempotent idiom in this
-- directory and it is WRONG for a key that other tables reference: once
-- 0205 §2 and 0206 §1 point composite foreign keys at it, the DROP fails
-- with `2BP01 cannot drop constraint … because other objects depend on it`
-- and the ADD then fails with `42P07 already exists`. Two refused statements
-- on the second application, from a file that reads as idempotent.
--
-- Measured: `node scripts/bootstrap-test-db.mjs` reported exactly those two
-- errors, because it pushes the Drizzle schema (which now declares the same
-- constraint) before applying the numbered files.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname  = 'import_runs_id_tenant_key'
       AND conrelid = 'public.import_runs'::regclass
  ) THEN
    ALTER TABLE public.import_runs
      ADD CONSTRAINT import_runs_id_tenant_key UNIQUE (id, tenant_id);
    RAISE NOTICE '0205: import_runs_id_tenant_key added.';
  ELSE
    RAISE NOTICE '0205: import_runs_id_tenant_key already present, left alone.';
  END IF;
END $$;


-- ############################################################################
-- SECTION 2 — THE SIDECAR
-- ############################################################################

CREATE TABLE IF NOT EXISTS public.import_row_provenance (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    run_id        uuid NOT NULL,
    entity_key    varchar(60) NOT NULL,

    -- ⚠️ NULL ONLY FOR `whole-file`. An opening trial balance is one document
    -- assembled from every line in the file; there is no single input row to
    -- name and inventing one would make reconciliation report 39 losses on a
    -- correct import. §3's CHECK ties this to `cardinality` so the NULL is a
    -- statement rather than an omission.
    input_row_number integer,

    -- Copied from `contract.provenance.cardinality` at write time.
    cardinality   varchar(12) NOT NULL,

    target_table  varchar(63) NOT NULL,
    target_id     uuid NOT NULL,

    -- 🔴 SEE THE HEADER. This is what makes a `restore-prior` undo able to
    -- tell a row it created from a row it overwrote.
    operation     varchar(6) NOT NULL,

    -- 🔴 SEE THE HEADER. The kind IN FORCE WHEN THE ROW WAS WRITTEN.
    reversal_kind varchar(16) NOT NULL,

    written_at    timestamptz NOT NULL DEFAULT now(),

    -- ⭐⭐ THE TRANSACTION THAT WROTE THE ROW, AS POSTGRES COUNTED IT.
    -- §4 is the only reason this column exists and the only thing that reads
    -- it. Recorded rather than derived so the evidence survives the check.
    written_xid   bigint NOT NULL,

    -- Filled by `server/import/reversal.ts` in the same transaction as the
    -- undo of the row it names. A provenance row with `reversed_at` set is a
    -- row a second reversal must skip rather than fail on.
    reversed_at   timestamptz,
    reversal_id   uuid,

    CONSTRAINT import_row_provenance_id_tenant_key UNIQUE (id, tenant_id),

    CONSTRAINT import_row_provenance_run_same_tenant
        FOREIGN KEY (run_id, tenant_id)
        REFERENCES public.import_runs (id, tenant_id) ON DELETE CASCADE,

    -- ⚠️ ONE PROVENANCE ROW PER (run, target row, operation). A run that
    -- writes the same destination row twice — two file rows sharing a
    -- natural key — has written it once as far as an undo is concerned, and
    -- two provenance rows would make the undo try twice and count the second
    -- attempt as a failure ("row not found") on a correct import.
    CONSTRAINT import_row_provenance_once
        UNIQUE (run_id, target_table, target_id),

    CONSTRAINT import_row_provenance_operation_known
        CHECK (operation IN ('insert', 'update')),

    CONSTRAINT import_row_provenance_cardinality_known
        CHECK (cardinality IN ('one-to-one', 'many', 'whole-file')),

    CONSTRAINT import_row_provenance_reversal_kind_known
        CHECK (reversal_kind IN ('delete', 'restore-prior', 'reverse-entry', 'irreversible')),

    -- ⚠️ THE ROW NUMBER IS REQUIRED EXCEPT FOR `whole-file`, AND IT IS THE
    -- ONLY PLACE THE THREE CARDINALITIES DIFFER IN THE DATA. Without this a
    -- `one-to-one` entity that forgot to pass the row number writes NULLs
    -- and support loses the one question the sidecar exists to answer.
    CONSTRAINT import_row_provenance_row_number_present
        CHECK ((cardinality = 'whole-file') = (input_row_number IS NULL)),

    CONSTRAINT import_row_provenance_row_number_sane
        CHECK (input_row_number IS NULL OR input_row_number >= 1),

    -- ⚠️ A ROW IS REVERSED WITH A TIME AND A REVERSAL, OR NEITHER. Half of
    -- the pair is how a row becomes invisible to the next undo without any
    -- record of what undid it.
    CONSTRAINT import_row_provenance_reversal_pair
        CHECK ((reversed_at IS NULL) = (reversal_id IS NULL))
);

COMMENT ON TABLE public.import_row_provenance IS
    'One row per row a migration wrote: which run, which entity, which input '
    'line, which destination table and id, and — the part no other table can '
    'supply — whether the run CREATED that destination row or OVERWROTE one '
    'that already existed. Written in the same database transaction as the row '
    'it describes; §4''s trigger refuses any row for which that is not true. '
    'This is the table `lib/import/types.ts` attributes to SQL 0196, which was '
    'reserved by track M1 and never written. Phase 2, SQL 0205.';

COMMENT ON COLUMN public.import_row_provenance.operation IS
    'insert | update. A `restore-prior` undo DELETES the rows the run inserted '
    'and RESTORES the rows it updated. Undoing both the same way either leaves '
    'created rows behind while reporting success, or deletes records the '
    'customer had before the migration — the combination CI gate 29 refuses at '
    'definition time and cannot see at undo time.';

COMMENT ON COLUMN public.import_row_provenance.reversal_kind IS
    'The entity''s declared reversal kind AS AT THE WRITE, copied rather than '
    'looked up. Changing an entity''s declaration must not change how runs '
    'already written are undone: a run that captured no prior values cannot be '
    'undone by a policy that has since become `restore-prior`.';

COMMENT ON COLUMN public.import_row_provenance.written_xid IS
    'pg_current_xact_id() of the transaction that wrote this row, recorded so '
    'the same-transaction property is evidence rather than an assurance. Read '
    'only by import_row_provenance_same_transaction().';

-- "Undo run X" — every row it wrote, in one index scan.
CREATE INDEX IF NOT EXISTS import_row_provenance_run_idx
    ON public.import_row_provenance (tenant_id, run_id, target_table);

-- "Which run put this row here" — the support question, from the other end.
CREATE INDEX IF NOT EXISTS import_row_provenance_target_idx
    ON public.import_row_provenance (tenant_id, target_table, target_id);

-- The undo's working set: rows this run wrote and has not yet reversed.
CREATE INDEX IF NOT EXISTS import_row_provenance_unreversed_idx
    ON public.import_row_provenance (tenant_id, run_id)
    WHERE reversed_at IS NULL;


-- ############################################################################
-- SECTION 3 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ⚠️ FORCE, NOT JUST ENABLE. `ENABLE ROW LEVEL SECURITY` alone does not apply
-- to the table's OWNER, and production connects as the owner. A new tenant
-- table that is merely ENABLEd has no isolation at all in production while
-- reading as correct in the catalogue.
--
-- The pair is the one `import_runs` itself uses: read within the tenant or
-- under platform scope, write only within the tenant. Not a variant — a
-- sidecar readable by somebody who cannot read the run would be a way to
-- enumerate another workspace's destination row ids.

ALTER TABLE public.import_row_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_row_provenance FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_row_provenance_tenant_isolation ON public.import_row_provenance;
CREATE POLICY import_row_provenance_tenant_isolation
    ON public.import_row_provenance
    USING      ((tenant_id = app_current_tenant_id()) OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 4 — 🔴 "THE SAME TRANSACTION" MADE INTO A FACT THE DATABASE CHECKS
-- ############################################################################
--
-- The brief is unambiguous: *"A separate transaction is not an option. A row
-- whose provenance failed to commit is a row no undo can find and no
-- reconciliation can count, and it is indistinguishable from a row that was
-- never written."*
--
-- ⚠️ EVERY OBVIOUS WAY OF ENFORCING THAT IS A CONVENTION. Passing a `tx`
-- handle enforces it in the type system of one language, in one process, for
-- as long as nobody writes `await withTenant(...)` inside the loop — which is
-- exactly what `server/actions/import.ts` does today, once per branch of
-- `writeRow`. A code review is not a control.
--
-- ⭐ SO IT IS CHECKED AGAINST THE HEAP. Every tuple in PostgreSQL carries a
-- system column `xmin`: the id of the transaction that produced that version
-- of the row. If provenance is being written by the same transaction that
-- wrote the row, the row's `xmin` IS this transaction's id. If the row was
-- written by an earlier transaction that has already committed, it is not,
-- and nothing the caller can do makes it so.
--
-- That gives the sidecar a second property nobody asked for and everybody
-- wants: a run cannot claim provenance over a row it did not touch. The
-- attribution is as strong as the write.
--
-- ⚠️ `xmin` IS 32-BIT AND `pg_current_xact_id()` IS 64-BIT, so the comparison
-- is against the low 32 bits. Getting that wrong would make the check pass
-- for the first two billion transactions of a database's life and then start
-- refusing every correct write, on a date nobody could predict.
--
-- ⚠️ AND THE LOOKUP IS DYNAMIC, WHICH IS THE ONE THING TO BE CAREFUL ABOUT.
-- `target_table` arrives in a row. It is resolved through `to_regclass` and
-- interpolated with `%I`, so it cannot be anything but a real relation name;
-- it is required to be an ordinary table in `public` carrying `tenant_id`;
-- and a short deny list refuses the tables no import may ever attribute rows
-- to. The REAL allowlist is `contract.provenance.targets`, in TypeScript,
-- which gate 29 already checks includes the entity's own destination — this
-- is the second lock, not a restatement of the first.

CREATE OR REPLACE FUNCTION public.import_row_provenance_same_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_rel     regclass;
  v_xmin    bigint;
  v_current bigint;
  v_denied  text[] := ARRAY[
    'tenants', 'users', 'audit_logs', 'change_log', 'security_events',
    'permission_denials', 'error_events', 'vault_items', 'vault_secrets',
    'import_runs', 'import_run_chunks', 'import_row_provenance',
    'import_row_prior_values', 'import_reversals', 'import_reversal_failures'
  ];
BEGIN
  IF NEW.target_table = ANY (v_denied) THEN
    RAISE EXCEPTION
      'An import may not record provenance against "%". That table is not an '
      'import destination, and a run that could claim rows in it could ask an '
      'undo to delete them.',
      NEW.target_table
      USING ERRCODE = '42501';
  END IF;

  v_rel := to_regclass('public.' || quote_ident(NEW.target_table));
  IF v_rel IS NULL THEN
    RAISE EXCEPTION
      'Provenance names destination table "%", which does not exist. A row '
      'attributed to a table that is not there can never be reversed and never '
      'be reconciled, and the contract would still read as complete.',
      NEW.target_table
      USING ERRCODE = '42P01';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = NEW.target_table
       AND column_name  = 'tenant_id'
  ) THEN
    RAISE EXCEPTION
      'Provenance names destination table "%", which has no tenant_id. An undo '
      'of it could not be scoped to one workspace.',
      NEW.target_table
      USING ERRCODE = '42703';
  END IF;

  -- ⚠️ `xmin::text::bigint` and not a cast between xid types: there is no
  -- direct xid → xid8 cast, and `age()` answers a different question.
  EXECUTE format(
    'SELECT xmin::text::bigint FROM public.%I WHERE id = $1 AND tenant_id = $2',
    NEW.target_table
  ) INTO v_xmin USING NEW.target_id, NEW.tenant_id;

  IF v_xmin IS NULL THEN
    RAISE EXCEPTION
      'Provenance claims row % in "%" for this workspace, and no such row is '
      'visible to this transaction. Either the row was never written or it '
      'belongs to another tenant.',
      NEW.target_id, NEW.target_table
      USING ERRCODE = '23503';
  END IF;

  v_current := (pg_current_xact_id()::text::bigint) % 4294967296;

  IF v_xmin <> v_current THEN
    RAISE EXCEPTION
      'Provenance for row % in "%" is being written by transaction %, but that '
      'row was last written by transaction %. Provenance MUST be written in the '
      'same transaction as the row it describes: a row whose provenance failed '
      'to commit is a row no undo can find and no reconciliation can count, and '
      'it is indistinguishable from a row that was never written.',
      NEW.target_id, NEW.target_table, v_current, v_xmin
      USING ERRCODE = '25000';
  END IF;

  NEW.written_xid := v_current;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.import_row_provenance_same_transaction() IS
    'Refuses a provenance row unless the destination row''s xmin is this '
    'transaction''s id — i.e. unless the row and its provenance are being '
    'committed together. Also refuses a destination that does not exist, has '
    'no tenant_id, or is on the deny list. Phase 2, SQL 0205 §4.';

DROP TRIGGER IF EXISTS import_row_provenance_same_transaction
    ON public.import_row_provenance;
CREATE TRIGGER import_row_provenance_same_transaction
    BEFORE INSERT ON public.import_row_provenance
    FOR EACH ROW EXECUTE FUNCTION public.import_row_provenance_same_transaction();


-- ############################################################################
-- SECTION 5 — PROVENANCE IS EVIDENCE: WHAT MAY BE CHANGED AFTER THE FACT
-- ############################################################################
--
-- ⚠️ AND WHY THIS IS NOT AN APPEND-ONLY TRIGGER. Making the sidecar
-- undeletable by anyone is what already makes a tenant carrying
-- `security_events` rows impossible to delete — the wave-15 §4.2 finding that
-- the DPDPA erasure work now has to solve. Repeating it here would make a
-- workspace that ever ran an import unerasable, in the name of protecting a
-- record of that import. The cascade from `tenants` must stay open.
--
-- What is refused is a REWRITE of the attribution. Marking a row reversed is
-- the only lawful update.

CREATE OR REPLACE FUNCTION public.import_row_provenance_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.id            IS DISTINCT FROM OLD.id
  OR NEW.tenant_id     IS DISTINCT FROM OLD.tenant_id
  OR NEW.run_id        IS DISTINCT FROM OLD.run_id
  OR NEW.entity_key    IS DISTINCT FROM OLD.entity_key
  OR NEW.input_row_number IS DISTINCT FROM OLD.input_row_number
  OR NEW.cardinality   IS DISTINCT FROM OLD.cardinality
  OR NEW.target_table  IS DISTINCT FROM OLD.target_table
  OR NEW.target_id     IS DISTINCT FROM OLD.target_id
  OR NEW.operation     IS DISTINCT FROM OLD.operation
  OR NEW.reversal_kind IS DISTINCT FROM OLD.reversal_kind
  OR NEW.written_at    IS DISTINCT FROM OLD.written_at
  OR NEW.written_xid   IS DISTINCT FROM OLD.written_xid THEN
    RAISE EXCEPTION
      'Provenance is evidence of what a run did and cannot be rewritten. Only '
      'reversed_at and reversal_id may be set after the write. Row %.',
      OLD.id
      USING ERRCODE = '42501';
  END IF;

  IF OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS NULL THEN
    RAISE EXCEPTION
      'Row % is already recorded as reversed by %. Un-marking it would let a '
      'second undo try to reverse it again and count the failure against the '
      'customer.',
      OLD.id, OLD.reversal_id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.import_row_provenance_immutable() IS
    'Provenance may only ever gain (reversed_at, reversal_id). Every other '
    'column is the record of what a run did. DELETE is deliberately left open '
    'so the cascade from tenants still works — see wave 15 §4.2. SQL 0205 §5.';

DROP TRIGGER IF EXISTS import_row_provenance_immutable
    ON public.import_row_provenance;
CREATE TRIGGER import_row_provenance_immutable
    BEFORE UPDATE ON public.import_row_provenance
    FOR EACH ROW EXECUTE FUNCTION public.import_row_provenance_immutable();


-- ############################################################################
-- SECTION 6 — THE TENANT-TABLE OBLIGATIONS, AND THEN SELF-VERIFICATION
-- ############################################################################
--
-- ⚠️ `attach_change_log_triggers()` AND `attach_impersonation_guards()` ARE
-- NOT EVENT TRIGGERS. 0125's own header says so: *"It guards whatever exists
-- when it runs, so later files must call attach_impersonation_guards()
-- themselves."* A new tenant table that does not call them is a table
-- `tenant_table_drift()` reports as drifted the next time `npm run check:rls`
-- is run against a real database — which is the gate, not this file.

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
    '0205: change-log triggers attached to [%]; impersonation guards attached to [%].',
    array_to_string(v_logged, ', '), array_to_string(v_guarded, ', ');
END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- SELF-VERIFICATION
-- ══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ EXACT COUNTS, NOT FLOORS. `count(*) >= 1` is the shape this repository
-- has shipped a restore script under that reported RESTORE COMPLETE while
-- expecting 2 policies against 313 present. Every assertion below names the
-- number it expects and raises on any other, and the message says what the
-- absence would cost rather than merely that it happened.
--
-- 🔴 AND IT CHECKS THE SHAPE, NOT ONLY THE NAME. If M1 ever lands its 0196
-- creating a table of the same name with a different set of columns, the
-- CREATE TABLE IF NOT EXISTS above is a silent no-op and everything Phase 2
-- writes would fail at runtime with a missing column. That is the specific
-- accident this block exists to convert into a refusal.

DO $$
DECLARE
  v_required text[] := ARRAY[
    'id', 'tenant_id', 'run_id', 'entity_key', 'input_row_number',
    'cardinality', 'target_table', 'target_id', 'operation',
    'reversal_kind', 'written_at', 'written_xid', 'reversed_at', 'reversal_id'
  ];
  v_missing  text[];
  v_enabled  boolean;
  v_forced   boolean;
  v_policies integer;
  v_triggers integer;
BEGIN
  SELECT coalesce(array_agg(c ORDER BY c), ARRAY[]::text[])
    INTO v_missing
    FROM unnest(v_required) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'import_row_provenance'
        AND column_name  = c
   );

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'import_row_provenance exists but is missing column(s): %. A table of '
      'this name created by another file with a different shape makes the '
      'CREATE TABLE IF NOT EXISTS above a silent no-op, and every write Phase 2 '
      'makes would fail at runtime instead of here.',
      array_to_string(v_missing, ', ');
  END IF;

  SELECT relrowsecurity, relforcerowsecurity
    INTO v_enabled, v_forced
    FROM pg_class
   WHERE oid = 'public.import_row_provenance'::regclass;

  -- ⚠️ THE PAIR, NOT EITHER HALF. `FORCE ROW LEVEL SECURITY` on a table whose
  -- row security is DISABLED is accepted and does nothing, and the catalogue
  -- then reads force = true. `forced_not_enabled` is the count nobody checks.
  IF NOT (v_enabled AND v_forced) THEN
    RAISE EXCEPTION
      'import_row_provenance has row security enabled=% forced=%. Both must be '
      'true: ENABLE alone does not apply to the table owner, which is what '
      'production connects as, and FORCE on a table that is not ENABLEd is '
      'accepted and does nothing while the catalogue reads force = true.',
      v_enabled, v_forced;
  END IF;

  SELECT count(*)::int INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'import_row_provenance';
  IF v_policies <> 1 THEN
    RAISE EXCEPTION
      'import_row_provenance carries % policies; exactly 1 was written. More '
      'than one is a permissive OR nobody intended; none is a table with FORCE '
      'row security and no way to read or write it at all.',
      v_policies;
  END IF;

  /*
   * ══════════════════════════════════════════════════════════════════════
   * ⭐ AMENDED AT INTEGRATION — THE CHANGE-LOG TRIGGER IS CONDITIONAL
   * ══════════════════════════════════════════════════════════════════════
   * This block originally demanded FOUR triggers, one of them
   * `import_row_provenance_change_log`. 0215 then declares this table in
   * `change_log_exclusions` and detaches that recorder, for reasons stated
   * in its header: one change_log row per imported row, each carrying two
   * JSONB copies of a row that can never differ, written into the
   * fastest-growing table in the product during a bulk import.
   *
   * So the two files asserted opposite things about the same trigger. A
   * first forward run happened to pass, because 0205 runs first and the
   * recorder was still attached when it looked. RE-RUNNING 0205 AFTER 0215
   * FAILED — and these files are written idempotent precisely so they can
   * be re-run.
   *
   * ⚠️ THE FIX IS NOT TO DROP THE ASSERTION. It now asks the same question
   * `attach_change_log_triggers()` asks: the recorder must be attached
   * UNLESS the table is declared excluded. Present-and-excluded is refused
   * too, because that is the contradictory state 0215 §3 exists to clear.
   *
   * The other three are unconditional and unchanged. Without
   * `same_transaction` the whole guarantee of this file is a comment.
   */
  SELECT count(*)::int INTO v_triggers
    FROM pg_trigger tg
   WHERE tg.tgrelid = 'public.import_row_provenance'::regclass
     AND NOT tg.tgisinternal
     AND tg.tgname IN (
       'import_row_provenance_same_transaction',
       'import_row_provenance_immutable',
       'no_delete_under_impersonation'
     );
  IF v_triggers <> 3 THEN
    RAISE EXCEPTION
      'import_row_provenance carries % of the 3 unconditional triggers '
      '(same_transaction, immutable, no_delete_under_impersonation). '
      'Without same_transaction the whole guarantee of this file is a comment.',
      v_triggers;
  END IF;

  DECLARE
    v_logged   boolean;
    v_excluded boolean;
  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger tg
       WHERE tg.tgrelid = 'public.import_row_provenance'::regclass
         AND NOT tg.tgisinternal
         AND tg.tgname = 'import_row_provenance_change_log'
    ) INTO v_logged;

    SELECT EXISTS (
      SELECT 1 FROM public.change_log_exclusions
       WHERE table_name = 'import_row_provenance'
    ) INTO v_excluded;

    IF NOT v_logged AND NOT v_excluded THEN
      RAISE EXCEPTION
        'import_row_provenance has no change_log recorder and is not in '
        'change_log_exclusions. That is the silent gap 0122 exists to close: '
        'a tenant table nothing records and nothing declares exempt.';
    END IF;

    IF v_logged AND v_excluded THEN
      RAISE EXCEPTION
        'import_row_provenance is BOTH recorded and declared exempt. 0122''s '
        'coverage check passes on either, so nothing else would ever report '
        'this. Re-run 0215, whose section 3 detaches the recorder.';
    END IF;

    IF v_excluded THEN
      RAISE NOTICE
        '0205: change_log recorder correctly absent — the table is declared '
        'in change_log_exclusions (see 0215 section 3).';
    END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'import_runs_id_tenant_key'
       AND conrelid = 'public.import_runs'::regclass
  ) THEN
    RAISE EXCEPTION
      'import_runs_id_tenant_key is absent, so the composite foreign key from '
      'the sidecar resolves a run row across tenants.';
  END IF;

  RAISE NOTICE
    '0205: import_row_provenance verified — % columns, RLS enabled and forced, '
    '1 policy, 3 unconditional triggers, change-log posture consistent, '
    'composite key on import_runs.',
    array_length(v_required, 1);
END $$;
