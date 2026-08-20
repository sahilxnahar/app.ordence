-- ############################################################################
-- 0215 — WHICH FILE, WHICH LINE, WHICH RUN
--        (Phase 3 — discovery and the dry run)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 READ THIS FIRST: THIS TABLE WAS SPECIFIED BY TRACK M1 AS SQL 0196, AND
--    0196 IS NOT IN THE TREE PHASE 3 WAS GIVEN
-- ══════════════════════════════════════════════════════════════════════════
-- `lib/import/types.ts` says, on `ImportProvenancePolicy`:
--
--     "SO PROVENANCE IS A SIDECAR: one table, `import_row_provenance` …
--      written by the same transaction as the row it describes — see SQL
--      0196 — so a row and its provenance cannot disagree."
--
-- The type shipped. The table did not: the highest numbered migration in
-- v1.84.1-alpha is 0168, and 0196 belongs to a block Phase 3 does not own.
-- So every entity in `ALL_IMPORT_ENTITIES` declares a `provenance` policy
-- naming a sidecar that does not exist.
--
-- 🔴 AND PHASE 3 CANNOT DO ITS JOB WITHOUT IT. The brief is explicit:
--    *"prove the dry run wrote nothing: count rows in every destination
--    before and after, and count `import_row_provenance` too."* A footprint
--    check that silently skips the one table it was told to count is
--    verified-by-absence, which is the same family as verified-by-a-floor —
--    and `server/import/dryrun.ts` therefore REFUSES rather than skipping
--    when a destination it was asked to count does not exist. That refusal
--    is proven in `tests/security/import-dry-run-parity.test.ts`.
--
-- ⚠️ SO THIS FILE CREATES IT, IDEMPOTENTLY, AND VERIFIES THE SHAPE RATHER
--    THAN ASSUMING IT AUTHORED IT. Every statement is `IF NOT EXISTS` or
--    `DROP … IF EXISTS` + `CREATE`, and §5 asserts the final shape from
--    `information_schema` — so applying this AFTER M1's 0196 is a check, not
--    a second definition. `PATCH-REQUEST-PHASE-3.md` asks integration to
--    delete this file if 0196 lands first, and states what must be true of
--    0196 for that to be safe.
--
-- ⚠️ AND THERE IS NO DRIZZLE DEFINITION FOR IT, WHICH `npm run check:sql`
--    REPORTS AS AN ORPHAN. `db/schema/import-runs.ts` belongs to Phase 2.
--    The exact block to paste is in `PATCH-REQUEST-PHASE-3.md`. Until it
--    lands, `drizzle-kit push` would treat this table as drift and offer to
--    drop it — which is one more reason push is banned in production
--    (rule 10) and why `scripts/bootstrap-test-db.mjs` pushes BEFORE it
--    applies the numbered files, never after.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⭐ WHY A SIDECAR AND NOT TWO COLUMNS ON EVERY DESTINATION
-- ══════════════════════════════════════════════════════════════════════════
-- The obvious implementation adds `import_run_id` and `import_row_no` to
-- every destination table. There are 313 tables here and the migration
-- phases will target roughly thirty of them; each column pair is a
-- migration, an index, a schema change on a live table, and a nullable
-- column every non-import write leaves empty. One sidecar is one migration.
--
-- ⭐ AND THE SIDECAR IS WHAT MAKES REVERSAL POSSIBLE AT ALL. `delete`
-- reversal needs to know which ids THIS run created. Without provenance the
-- only available answer is "rows created between these two timestamps",
-- which catches every row the customer's staff typed by hand during the
-- migration window. A migration takes hours and the office does not stop.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 `run_id` IS NOT NULL, AND THAT IS THE DRY RUN'S TEETH
-- ══════════════════════════════════════════════════════════════════════════
-- A dry run has no run. `beginImportRun` is called on the commit path and
-- nowhere else, so a preview that ever tried to write provenance would have
-- no `run_id` to write and the database would refuse the row.
--
-- ⚠️ THAT IS A GUARANTEE, NOT AN ASSERTION IN A COMMENT. The TypeScript
-- proof in `tests/security/import-dry-run-parity.test.ts` counts this table
-- before and after a preview and requires the delta to be zero; this
-- constraint is what would stop the write even if that proof were deleted.
-- Two independent mechanisms, because the whole product rests on the claim
-- that a dry run touches nothing.
-- ############################################################################


-- ############################################################################
-- SECTION 1 — THE TABLE
-- ############################################################################

CREATE TABLE IF NOT EXISTS public.import_row_provenance (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    -- 🔴 SEE THE HEADER. NOT NULL is the constraint that makes "a dry run
    --    writes no provenance" a fact about the database rather than a fact
    --    about the current shape of the TypeScript.
    --
    -- ⚠️ CASCADE, unlike `import_runs.started_by`. The provenance of a run
    --    that no longer exists cannot be reversed, cannot be reconciled and
    --    cannot be explained to anybody — it is not evidence, it is litter.
    run_id         uuid NOT NULL REFERENCES public.import_runs(id) ON DELETE CASCADE,

    -- The `ALL_IMPORT_ENTITIES` key. Denormalised from the run on purpose:
    -- "which entity wrote this row" is asked of the row, and joining back to
    -- the run to answer it makes every reconciliation query a join.
    entity_key     varchar(60) NOT NULL,

    -- ⚠️ A RECORD NUMBER, NOT A LINE NUMBER, and the header is record 1 —
    --    the same numbering `lib/import/csv.ts` uses and the same numbering
    --    a spreadsheet shows in its row gutter. Reporting anything else
    --    sends the customer to the middle of a quoted cell.
    record_number  integer,

    -- ⭐ WHAT THEY CALLED THE FILE. Not the file. Same decision as
    --    `import_runs.source_name`: a folder of twenty exports is
    --    unnavigable without it, and the bytes are the customer's.
    source_name    varchar(255),

    -- ── WHERE THE ROW LANDED ────────────────────────────────────────────
    -- ⚠️ 63 CHARACTERS BECAUSE THAT IS `NAMEDATALEN - 1`. A varchar(40)
    --    would refuse a legal Postgres table name, and the refusal would
    --    arrive at the end of a customer's migration.
    target_table   varchar(63) NOT NULL,
    target_id      uuid NOT NULL,

    -- ⭐ COPIED FROM THE ENTITY'S CONTRACT AT WRITE TIME, NOT LOOKED UP AT
    --    READ TIME. `ImportProvenancePolicy.cardinality` decides whether a
    --    provenance miss is a bug: a `one-to-one` entity that wrote 900 rows
    --    and recorded 880 has lost 20, while a `whole-file` entity that
    --    wrote 1 row for 40 input lines is correct. Reading today's contract
    --    to judge last year's run would re-judge it under a rule that was
    --    not in force.
    cardinality    varchar(12) NOT NULL,

    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT import_row_provenance_cardinality_known
        CHECK (cardinality IN ('one-to-one', 'many', 'whole-file')),

    -- 🔴 THE ONE ROW THAT MAY NOT NAME A RECORD IS THE ONE ASSEMBLED FROM
    --    THE WHOLE FILE, AND IT MUST NOT NAME ONE.
    --
    -- An opening trial balance of forty lines writes ONE journal entry.
    -- Attributing it to line 1 would be a lie that reads as a fact: a
    -- reconciliation would report 39 missing rows, and a human asking "which
    -- line produced this entry" would be told "the first one", which is
    -- false in a way nothing else in the system would contradict.
    CONSTRAINT import_row_provenance_record_number_matches_cardinality
        CHECK ((cardinality = 'whole-file') = (record_number IS NULL)),

    CONSTRAINT import_row_provenance_record_number_positive
        CHECK (record_number IS NULL OR record_number > 1)
);

COMMENT ON TABLE public.import_row_provenance IS
    'Which run, which file, which line produced this row — one sidecar rather '
    'than a column pair on 313 tables. Written in the same transaction as the '
    'row it describes, so a row and its provenance cannot disagree. `run_id` '
    'is NOT NULL because a dry run has no run: the database refuses provenance '
    'from a preview. Specified by Track M1 as SQL 0196; created here by Phase 3 '
    'because 0196 was not in the tree and a dry-run proof that cannot count '
    'this table is not a proof. See PATCH-REQUEST-PHASE-3.md.';

COMMENT ON COLUMN public.import_row_provenance.run_id IS
    'NOT NULL on purpose. A preview has no run, so a preview cannot write here '
    'even if a future edit tried to. This is the second of two independent '
    'mechanisms behind "a dry run touches nothing"; the first is that the only '
    'branch on mode in server/actions/import.ts sits below every decision.';

COMMENT ON COLUMN public.import_row_provenance.record_number IS
    'NULL exactly when cardinality is whole-file. An opening trial balance is '
    'one document assembled from every line of the file, and attributing it to '
    'line 1 would make a reconciliation report 39 missing rows on a correct '
    'import. Header is record 1, as in lib/import/csv.ts.';


-- ############################################################################
-- SECTION 2 — THE INDEXES, AND EACH ONE IS A QUESTION SOMEBODY ASKS
-- ############################################################################
--
-- ⚠️ NO INDEX ON `(tenant_id)` ALONE. Every query below already leads with
--    it, and a single-column duplicate of a composite's leading column is
--    exactly what 0157 was written to remove.

-- ⭐ "Undo this run." The reversal path reads every row a run created, in
--    the order it created them, and deletes or reverses them. Without this
--    index that is a sequential scan of the sidecar per undo.
CREATE INDEX IF NOT EXISTS import_row_provenance_run_idx
    ON public.import_row_provenance (tenant_id, run_id, target_table);

-- ⭐ "Where did THIS row come from?" — asked of a single record in the UI,
--    months later, by somebody who does not know the run.
CREATE INDEX IF NOT EXISTS import_row_provenance_target_idx
    ON public.import_row_provenance (tenant_id, target_table, target_id);

-- 🔴 AND THE UNIQUENESS THAT MAKES A RE-RUN SAFE. One run may attribute one
--    destination row exactly once. A chunk that timed out after committing
--    and was retried by the browser would otherwise record its provenance
--    twice, and a reconciliation counting provenance rows against written
--    rows would report a surplus that never happened.
--
-- ⚠️ IT IS A UNIQUE INDEX AND NOT A CONSTRAINT, so a writer can say
--    `ON CONFLICT DO NOTHING` and let the second attempt lose the race —
--    which is the correct outcome and the one `recordChunk` already relies
--    on for `import_run_chunks`.
CREATE UNIQUE INDEX IF NOT EXISTS import_row_provenance_once_per_run
    ON public.import_row_provenance (run_id, target_table, target_id);


-- ############################################################################
-- SECTION 3 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ⚠️ FORCE, NOT JUST ENABLE. `ENABLE ROW LEVEL SECURITY` does not apply to
-- the table's OWNER and production connects as the owner, so a merely
-- ENABLEd table has no isolation at all in production while looking correct
-- in the catalogue. This is rule 9 and it is the reason
-- `scripts/check-rls-coverage.mjs` asserts `relforcerowsecurity` rather than
-- `relrowsecurity`.
--
-- ⚠️ AND THE POLICY IS THE PAIR `import_runs` USES, NOT A VARIANT. A sidecar
-- readable by somebody who cannot read the run it belongs to is a leak
-- wearing a join. No `app_platform_scope()` in USING either, for the same
-- reason 0117 left it off `import_runs`: support does not need to read which
-- of a customer's rows came from a spreadsheet.

ALTER TABLE public.import_row_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_row_provenance FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_row_provenance_tenant_isolation ON public.import_row_provenance;
CREATE POLICY import_row_provenance_tenant_isolation
    ON public.import_row_provenance
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 4 — PROVENANCE IS NOT EDITABLE
-- ############################################################################
--
-- 🔴 AN UPDATE IS REFUSED FOR EVERY ROLE, THE OWNER INCLUDED.
--
-- Provenance answers "which run created this row". That answer was true at
-- the moment of the write and can never become a different true answer. A
-- row that can be repointed at a different run is a row that can be used to
-- make a reversal delete somebody else's records — and the reversal path
-- reads exactly this table to decide what to delete.
--
-- ⚠️ DELETE IS *NOT* REFUSED, AND THE ASYMMETRY IS DELIBERATE. A tenant
-- being erased under the DPDPA cascades through `tenant_id`, and a trigger
-- that refused every delete would make such a tenant undeletable — which is
-- precisely what `security_events` already does to lawful erasure (Track D
-- wave 15 §4.2) and which is not a mistake worth making twice. Undoing a run
-- deletes its provenance along with the rows; falsifying one does not.
--
-- ⚠️ SECURITY INVOKER. The function reads nothing but the row in front of
-- it, so there is nothing RLS could blind and no reason to escalate. A
-- SECURITY DEFINER that does not need to be one is a privilege-escalation
-- surface bought for nothing.

CREATE OR REPLACE FUNCTION public.import_row_provenance_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION
    'import_row_provenance is append-only. Row % attributes a % row to import '
    'run %, and that was either true when it was written or it was never true. '
    'Undo the run (which deletes both the rows and their provenance) rather '
    'than repointing the record of what happened.',
    OLD.id, OLD.target_table, OLD.run_id
    USING ERRCODE = 'restrict_violation';
END
$fn$;

DROP TRIGGER IF EXISTS import_row_provenance_no_update ON public.import_row_provenance;
CREATE TRIGGER import_row_provenance_no_update
    BEFORE UPDATE ON public.import_row_provenance
    FOR EACH ROW EXECUTE FUNCTION public.import_row_provenance_is_append_only();


-- ############################################################################
-- SECTION 5 — A DESTINATION THAT DOES NOT EXIST IS NOT A DESTINATION
-- ############################################################################
--
-- ⭐ `target_table` NAMES A TABLE, AND THE DATABASE CHECKS THAT IT DOES.
--
-- ⚠️ WHY A TRIGGER AND NOT A CHECK CONSTRAINT. The check has to be
-- `to_regclass('public.' || target_table) IS NOT NULL`, and `to_regclass` is
-- STABLE rather than IMMUTABLE, so Postgres refuses it in a CHECK. The
-- refusal is correct — a CHECK is re-evaluated on restore and the catalogue
-- it consults may differ — and a BEFORE trigger is the honest shape.
--
-- 🔴 AND WHY NOT AN ENUM OF THE KNOWN DESTINATIONS. `ImportTableKey` in
-- `lib/import/types.ts` is the list, and Phases 4 to 8 will add roughly
-- twenty entries to it. A CHECK listing today's six would refuse Phase 5's
-- first write, and the migration that widened it would be a second model of
-- a list TypeScript already holds — which is the drift this repository has
-- been bitten by four times, including in the checkers written to catch it.
-- Asking the catalogue is asking the only authority that cannot drift.

CREATE OR REPLACE FUNCTION public.import_row_provenance_target_exists()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF to_regclass(format('public.%I', NEW.target_table)) IS NULL THEN
    RAISE EXCEPTION
      'import_row_provenance names destination table "%", which does not exist '
      'in the public schema. A row attributed to a table nobody can read is a '
      'row that cannot be reversed and cannot be reconciled — which is the '
      'exact state the provenance sidecar exists to prevent.',
      NEW.target_table
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS import_row_provenance_target_known ON public.import_row_provenance;
CREATE TRIGGER import_row_provenance_target_known
    BEFORE INSERT ON public.import_row_provenance
    FOR EACH ROW EXECUTE FUNCTION public.import_row_provenance_target_exists();


-- ############################################################################
-- SECTION 6 — THE TWO CROSS-CUTTING SWEEPS A NEW TENANT TABLE MUST JOIN
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ THIS SECTION EXISTS BECAUSE TWO TESTS WENT RED, AND THEY WERE RIGHT
-- ══════════════════════════════════════════════════════════════════════════
-- `tests/security/impersonation-guard-exemptions.test.ts` asserts that the
-- live set of tenant tables WITHOUT `no_delete_under_impersonation` is
-- EXACTLY the twelve recorded in 0167. `tests/security/wave13-coverage.test.ts`
-- asserts that a second run of each sweep attaches nothing. Creating this
-- table broke both — a thirteenth unguarded tenant table, and a sweep with
-- work left to do.
--
-- ⭐ THAT IS THE MECHANISM WORKING. 0167 says as much: *"The three tenant
-- tables that arrived from other tracks all received the guard automatically
-- from 0125's attach_impersonation_guards()"*. A migration that creates a
-- tenant table and does not call the sweeps ships a table outside every
-- cross-cutting control in the product, and nothing but those two tests
-- would ever say so.

-- ----------------------------------------------------------------------------
-- ⑥.1 THE IMPERSONATION DELETE GUARD — attached
-- ----------------------------------------------------------------------------
--
-- ⚠️ IT MATTERS EVEN THOUGH THE APPLICATION SHOULD NEVER DELETE FROM HERE
-- OUTSIDE A REVERSAL. Provenance is what a reversal reads to decide which
-- rows a run created; a support engineer wearing a customer's face who could
-- delete it could make a run unreversible and unreconcilable in one
-- statement, silently.

SELECT * FROM public.attach_impersonation_guards();

-- ----------------------------------------------------------------------------
-- ⑥.2 THE CHANGE RECORDER — deliberately NOT attached, with the reason on a row
-- ----------------------------------------------------------------------------
--
-- 🔴 THE TABLE IS APPEND-ONLY: THE TABLE *IS* ITS HISTORY.
--
-- §4 refuses every UPDATE for every role including the owner, so a change
-- recorder here could only ever record inserts — a second copy of a row that
-- can never differ from the first. `audit_logs`, `payment_events` and the
-- rest of the append-only family are excluded on exactly this ground.
--
-- ⚠️ AND THE COST IS NOT THEORETICAL. Provenance is written once per
-- imported row. A 40,000-row migration would write 40,000 change rows, each
-- carrying two JSONB copies of a row nobody will ever diff, into what 0128
-- already calls "the fastest-growing table in this product" — during the
-- hours when the workspace is under the heaviest write load it will ever see.
--
-- ⚠️ `'append-only'` AND NOT A WORD OF MY OWN CHOOSING.
-- `change_log_exclusions_category_check` permits exactly
-- self | append-only | derived | platform, and 0133 records that its first
-- draft wrote `'telemetry'` and was refused — caught only by executing the
-- file, because a CHECK on a registry table is invisible from the schema.
--
-- ⭐ THE COST, STATED: nothing in this product can UPDATE a provenance row,
-- so there is no edit for the recorder to have missed. A DELETE leaves no
-- change_log trace — and a delete here is either a reversal (which deletes
-- the rows it describes in the same transaction) or a tenant erasure.

INSERT INTO public.change_log_exclusions (table_name, reason, category, declared_in)
VALUES (
  'import_row_provenance',
  'Append-only by trigger: import_row_provenance_no_update refuses every UPDATE for every role, so the table IS its history and a change recorder could only record inserts. Attaching it would also write one change row per imported row — two JSONB copies of a row that can never differ — into the fastest-growing table in the product, during a migration. Same reasoning as audit_logs and payment_events.',
  'append-only',
  '0215_import_row_provenance.sql'
)
ON CONFLICT (table_name) DO NOTHING;


-- ############################################################################
-- SECTION 7 — SELF-VERIFICATION
-- ############################################################################
--
-- ⚠️ EVERY ASSERTION BELOW IS AN EXACT COUNT OR AN EMPTY-LIST TEST. Not one
-- of them is a floor. 0014 asserted `>= 10` for a property that had to hold
-- on 303 tables and printed PASS at 48; this file would rather fail than
-- report a partial success as a success.
--
-- ⭐ AND IT VERIFIES THE SHAPE RATHER THAN VERIFYING THAT IT DID THE WORK.
-- Applied on a database where M1's 0196 already created the table, every
-- CREATE above is a no-op and this section is the only part that runs — at
-- which point it is a conformance check on somebody else's migration, which
-- is exactly what is wanted.

DO $$
DECLARE
  v_missing   text[];
  v_expected  text[] := ARRAY[
    'id', 'tenant_id', 'run_id', 'entity_key', 'record_number',
    'source_name', 'target_table', 'target_id', 'cardinality', 'created_at'
  ];
  v_actual    text[];
  v_extra     text[];
  v_nullable  integer;
  v_enabled   boolean;
  v_forced    boolean;
  v_policies  integer;
  v_indexes   integer;
  v_triggers  integer;
  v_checks    integer;
BEGIN
  /* ---- ① the table exists at all --------------------------------- */
  IF to_regclass('public.import_row_provenance') IS NULL THEN
    RAISE EXCEPTION
      '0215 ran and public.import_row_provenance does not exist. The CREATE '
      'TABLE above is IF NOT EXISTS, so this means it was dropped between the '
      'statement and this block, or the file was applied to a schema other '
      'than public.';
  END IF;

  /* ---- ② exactly the ten columns, no more and no fewer ------------ */
  SELECT coalesce(array_agg(column_name::text ORDER BY column_name), ARRAY[]::text[])
    INTO v_actual
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'import_row_provenance';

  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_missing
    FROM unnest(v_expected) AS x WHERE NOT (x = ANY(v_actual));
  SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_extra
    FROM unnest(v_actual) AS x WHERE NOT (x = ANY(v_expected));

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'import_row_provenance is missing column(s): %. If SQL 0196 created this '
      'table with a different shape, the two definitions have diverged and '
      'server/import/dryrun.ts is counting a table it does not understand.',
      array_to_string(v_missing, ', ');
  END IF;

  /* ⚠️ AN EXTRA COLUMN IS REPORTED AND NOT REFUSED, and the difference is
     argued rather than assumed: 0196 is allowed to know things Phase 3 does
     not, and refusing its additions would make this file a veto over a
     track that owns the design. A MISSING column is fatal because
     dryrun.ts and the reversal path read those ten by name. */
  IF array_length(v_extra, 1) IS NOT NULL THEN
    RAISE NOTICE
      'import_row_provenance carries column(s) 0215 does not know about: %. '
      'That is expected if SQL 0196 has been applied; the ten columns Phase 3 '
      'relies on are all present.',
      array_to_string(v_extra, ', ');
  END IF;

  /* ---- ③ run_id is NOT NULL — the dry run's teeth ----------------- */
  SELECT count(*) INTO v_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'import_row_provenance'
     AND column_name IN ('tenant_id', 'run_id', 'target_table', 'target_id', 'cardinality')
     AND is_nullable  = 'YES';

  IF v_nullable <> 0 THEN
    RAISE EXCEPTION
      '% of the five columns that must be NOT NULL on import_row_provenance are '
      'nullable. `run_id` above all: a preview has no run, and a nullable run_id '
      'is a dry run that CAN write provenance. The whole product rests on it '
      'not being able to.',
      v_nullable;
  END IF;

  /* ---- ④ RLS enabled AND forced ---------------------------------- */
  SELECT relrowsecurity, relforcerowsecurity INTO v_enabled, v_forced
    FROM pg_class WHERE oid = 'public.import_row_provenance'::regclass;

  IF NOT v_enabled OR NOT v_forced THEN
    RAISE EXCEPTION
      'import_row_provenance: row level security enabled=%, forced=%. Both must '
      'be true. ENABLE alone does not apply to the table owner and production '
      'connects as the owner, so ENABLE without FORCE is decoration.',
      v_enabled, v_forced;
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'import_row_provenance'
     AND qual       LIKE '%app_current_tenant_id%'
     AND with_check LIKE '%app_current_tenant_id%';

  IF v_policies <> 1 THEN
    RAISE EXCEPTION
      'import_row_provenance has % policy/policies scoping both reads and writes '
      'to app_current_tenant_id(), and there must be exactly one. Zero is no '
      'isolation; more than one is an OR of two rules, and the permissive one wins.',
      v_policies;
  END IF;

  /* ---- ⑤ the two triggers and the three checks -------------------- */
  SELECT count(*) INTO v_triggers
    FROM pg_trigger
   WHERE tgrelid = 'public.import_row_provenance'::regclass
     AND NOT tgisinternal
     AND tgname IN ('import_row_provenance_no_update', 'import_row_provenance_target_known');

  IF v_triggers <> 2 THEN
    RAISE EXCEPTION
      'import_row_provenance carries % of the 2 required triggers. Without '
      'no_update, provenance can be repointed at another run and the reversal '
      'path will delete the rows it names. Without target_known, a row can be '
      'attributed to a table that does not exist.',
      v_triggers;
  END IF;

  SELECT count(*) INTO v_checks
    FROM pg_constraint
   WHERE conrelid = 'public.import_row_provenance'::regclass
     AND contype  = 'c'
     AND conname IN (
       'import_row_provenance_cardinality_known',
       'import_row_provenance_record_number_matches_cardinality',
       'import_row_provenance_record_number_positive'
     );

  IF v_checks <> 3 THEN
    RAISE EXCEPTION
      'import_row_provenance carries % of the 3 required CHECK constraints. The '
      'one that matters most is record_number_matches_cardinality: without it a '
      'whole-file entity can attribute one journal entry to line 1 of forty, and '
      'reconciliation reports 39 missing rows on a correct import.',
      v_checks;
  END IF;

  /* ---- ⑥ the three indexes --------------------------------------- */
  SELECT count(*) INTO v_indexes
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename  = 'import_row_provenance'
     AND indexname IN (
       'import_row_provenance_run_idx',
       'import_row_provenance_target_idx',
       'import_row_provenance_once_per_run'
     );

  IF v_indexes <> 3 THEN
    RAISE EXCEPTION
      'import_row_provenance carries % of the 3 required indexes. '
      'import_row_provenance_once_per_run is the one a retried chunk depends '
      'on: without it a chunk that committed and then timed out records its '
      'provenance twice on the retry.',
      v_indexes;
  END IF;

  /* ---- ⑦ the two cross-cutting sweeps actually took ---------------- */
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.import_row_provenance'::regclass
       AND tgname  = 'no_delete_under_impersonation'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      '0215 FAILED: import_row_provenance has no no_delete_under_impersonation '
      'trigger. attach_impersonation_guards() ran in §6 and did not attach it, '
      'which means the sweep no longer sees new tables — and every tenant table '
      'created after this one is unguarded too.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.change_log_exclusions WHERE table_name = 'import_row_provenance'
  ) THEN
    RAISE EXCEPTION
      '0215 FAILED: import_row_provenance is not in change_log_exclusions, so the '
      'next attach_change_log_triggers() sweep will attach the change recorder to '
      'an append-only table and write one change row per imported row during every '
      'migration.';
  END IF;

  RAISE NOTICE
    '0215 OK — import_row_provenance: 10 columns, RLS forced, 1 tenant policy, '
    '2 triggers, 3 checks, 3 indexes, impersonation guard attached, change '
    'recorder excluded with a reason.';
END
$$;
