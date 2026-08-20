-- ############################################################################
-- 0207 — TWO BROWSER TABS, TWO CLICKS, ONE FILE
--        (Phase 2 — the run ledger, idempotency and reversal)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT ALREADY EXISTS, AND WHY IT IS NOT ENOUGH
-- ══════════════════════════════════════════════════════════════════════════
-- Two layers of retry safety are already in the tree and both are correct:
--
--   ① THE ROWS.   Every entity declares a natural key, so a re-run MATCHES
--                 rather than duplicates. `lib/import/types.ts` makes it a
--                 required member with no opt-out.
--   ② THE COUNTS. `import_run_chunks` has a unique index on (run, index), so
--                 a replayed chunk is REPORTED as already done rather than
--                 added to the totals twice.
--
-- Both are scoped to ONE RUN. Neither has anything to say about two runs.
--
-- ⚠️ AND TWO RUNS IS THE ORDINARY CASE, NOT AN EDGE CASE. The wizard lives
-- in a browser; the file lives on the customer's machine. Nothing about that
-- design stops the same person opening it in a second tab, or clicking Start
-- again when the first click appears to have done nothing, or reloading after
-- a timeout. Each of those calls `startImportRun`, which today inserts a row
-- unconditionally. Two runs then plan the same file and submit the same
-- chunks under two different run ids:
--
--   · ① keeps the destination rows correct — in `skip` mode. In `update`
--     mode the second run overwrites what the first one wrote, and (this is
--     the part that matters) CAPTURES THE FIRST RUN'S VALUES AS THE PRIOR.
--     Undoing run 2 then restores the migration. Undoing run 1 afterwards
--     restores the customer's data. Undo them in the other order and the
--     customer's data is gone. There is no ordering in which the customer
--     can be told what will happen.
--   · ② is per-run, so the totals are right twice and the report says the
--     file was imported twice, which it was.
--   · The sidecar records both runs as having written the same destination
--     rows, which is true and is exactly the ambiguity an undo cannot resolve.
--
-- ⭐ SO THE RUN-LEVEL MECHANISM IS: THE SAME FILE, FOR THE SAME ENTITY, IN
-- ONE WORKSPACE, IS ONE RUN. The second click does not fail — it RESUMES,
-- and gets back the run id the first click created. A refusal would be worse
-- than the disease: the customer whose first tab has closed would be locked
-- out of their own migration with no way to name the run they cannot see.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 THE CLAIM IS THE INSERT, NOT A CHECK BEFORE IT
-- ══════════════════════════════════════════════════════════════════════════
-- `server/import/runs.ts` already argues this for chunks and the argument is
-- unchanged here: *"Checking first and inserting after is a race two browser
-- tabs — or one browser and its own retry — will lose: both read 'not
-- committed', both insert."* A unique index is the only version that is
-- correct without a lock held across the whole operation.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ WHAT THE FINGERPRINT IS OF, AND WHERE IT IS COMPUTED
-- ══════════════════════════════════════════════════════════════════════════
-- The bytes of the file. Not the row count, not the name, not a hash of the
-- parsed records: a customer who fixes one cell and re-uploads has a
-- different file and is entitled to a different run, and a customer who
-- renames the file has not.
--
-- 🔴 IT IS COMPUTED IN THE BROWSER, AND THAT IS FORCED BY THE ARCHITECTURE,
-- not chosen. `db/schema/import-runs.ts` says in its header that none of
-- these tables holds the customer's file and gives the reason at length. The
-- server never sees the bytes. `server/import/runs.ts` exports
-- `importSourceFingerprint()` for callers that do have them — a test, a
-- server-side re-import — and the wizard uses WebCrypto's SHA-256 over the
-- same bytes to produce the same string.
--
-- ⚠️ SO THE SHAPE IS CHECKED HERE. A caller that passes a truncated hash, or
-- an upper-case one, or the file name, would silently create a claim that
-- never collides — idempotency that is present, declared, and inert.
--
-- ############################################################################


-- ############################################################################
-- SECTION 1 — THE CLAIM
-- ############################################################################

ALTER TABLE public.import_runs
  ADD COLUMN IF NOT EXISTS source_fingerprint varchar(71);

-- ⭐ WHY A RUN STOPS HOLDING THE CLAIM, AS A DATE RATHER THAN A STATUS.
-- After a migration has been undone, the customer is entitled to import the
-- same file again — that is the whole point of undoing it. Expressing that by
-- moving `status` to a new value would need `import_runs_status_known`,
-- `import_runs_finished_has_time` and `import_runs_stop_named` all reasoned
-- about again, and would put two meanings ("how did this run end", "does it
-- still hold the file") in one column. A run that has been reversed keeps the
-- status that describes how it ended.
ALTER TABLE public.import_runs
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

ALTER TABLE public.import_runs
  ADD COLUMN IF NOT EXISTS superseded_reason text;

COMMENT ON COLUMN public.import_runs.source_fingerprint IS
    'sha256:<64 lower-case hex> over the BYTES of the source file, computed in '
    'the browser because the server never receives them. The run-level '
    'idempotency key: the same file for the same entity in one workspace is one '
    'run, and a second Start resumes it rather than creating a second run that '
    'would capture the first run''s values as the prior. SQL 0207.';

COMMENT ON COLUMN public.import_runs.superseded_at IS
    'When this run stopped holding the claim on its source file — set by a '
    'completed reversal, so the customer can import the same file again after '
    'undoing it. A date rather than a status because "how did this run end" and '
    '"does it still hold the file" are two questions.';

-- ⚠️ THE SHAPE, NOT MERELY THE PRESENCE. A fingerprint that is the file name,
-- or a truncated hash, or upper-case hex, produces a claim that never
-- collides with the one the second tab computes — idempotency that is
-- declared and inert, which is this repository's characteristic defect.
-- ⚠️ ADDED IF ABSENT rather than dropped and re-added, for the reason 0205
-- §1 sets out at length: the drop-then-add idiom stops being idempotent the
-- moment anything depends on the constraint, and it fails in a way that
-- reads as two unrelated errors.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'import_runs_fingerprint_shape'
       AND conrelid = 'public.import_runs'::regclass
  ) THEN
    ALTER TABLE public.import_runs
      ADD CONSTRAINT import_runs_fingerprint_shape
      CHECK (source_fingerprint IS NULL OR source_fingerprint ~ '^sha256:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'import_runs_superseded_named'
       AND conrelid = 'public.import_runs'::regclass
  ) THEN
    ALTER TABLE public.import_runs
      ADD CONSTRAINT import_runs_superseded_named
      CHECK ((superseded_at IS NULL) = (superseded_reason IS NULL));
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 THE INDEX IS THE MECHANISM. EVERYTHING ELSE IN THIS FILE IS COMMENTARY.
-- ══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ PARTIAL ON THREE CONDITIONS AND EACH ONE IS A DECISION:
--
--   source_fingerprint IS NOT NULL
--       Runs that pre-date this file, and any caller that has not been
--       updated, are not swept into a claim they never made. NULLs do not
--       collide in a unique index in any case; saying so in the predicate
--       makes it a statement rather than an accident of SQL semantics.
--
--   superseded_at IS NULL
--       A reversed run has released the file. See above.
--
--   status <> 'abandoned'
--       A person who walked away from a half-finished migration and comes
--       back tomorrow is starting again, not resuming. `abandoned` is set
--       deliberately by `finishImportRun`, never by a timeout.
--
-- ⚠️ AND `incomplete` IS DELIBERATELY NOT IN THAT LIST. An incomplete run is
-- the exact case the resume path exists for — `finishImportRun`'s own message
-- tells the customer to *"upload the same file again"*, and this index is
-- what makes that land in the same run instead of a second one.
DROP INDEX IF EXISTS import_runs_one_live_per_source;
CREATE UNIQUE INDEX import_runs_one_live_per_source
    ON public.import_runs (tenant_id, entity_key, source_fingerprint)
    WHERE source_fingerprint IS NOT NULL
      AND superseded_at IS NULL
      AND status <> 'abandoned';


-- ############################################################################
-- SECTION 2 — THE FINGERPRINT IS EVIDENCE, NOT A FIELD
-- ############################################################################
--
-- ⚠️ WITHOUT THIS, THE CLAIM IS A SUGGESTION. A caller that hit the unique
-- index could clear its own fingerprint and insert again, which is the same
-- double run arrived at in two statements instead of one. Rewriting it to a
-- different file's hash is worse: the run report would then name a file the
-- run did not read.

CREATE OR REPLACE FUNCTION public.import_runs_fingerprint_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF OLD.source_fingerprint IS NOT NULL
     AND NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint THEN
    RAISE EXCEPTION
      'Run % already names source file %. Changing or clearing it would release '
      'a claim the run still holds, which is the two-tab double import arrived '
      'at in two statements instead of one.',
      OLD.id, OLD.source_fingerprint
      USING ERRCODE = '42501';
  END IF;

  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION
      'Run % was superseded at % (%). Un-superseding it would put two runs back '
      'in contention for the same file.',
      OLD.id, OLD.superseded_at, OLD.superseded_reason
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.import_runs_fingerprint_immutable() IS
    'A run''s source fingerprint may be set once and never changed or cleared, '
    'and a superseded run may not be un-superseded. Without this the run-level '
    'claim in SQL 0207 §1 is advisory.';

DROP TRIGGER IF EXISTS import_runs_fingerprint_immutable ON public.import_runs;
CREATE TRIGGER import_runs_fingerprint_immutable
    BEFORE UPDATE ON public.import_runs
    FOR EACH ROW EXECUTE FUNCTION public.import_runs_fingerprint_immutable();


-- ══════════════════════════════════════════════════════════════════════════
-- SELF-VERIFICATION
-- ══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ IT ASSERTS THE PREDICATE, NOT JUST THE INDEX. An index on the same three
-- columns with a different WHERE clause is a different control: drop
-- `superseded_at IS NULL` and a customer can never re-import a file they
-- undid; drop `status <> 'abandoned'` and they can never start again after
-- walking away. Both read as "the idempotency index is present".

DO $$
DECLARE
  v_def     text;
  v_columns integer;
BEGIN
  SELECT indexdef INTO v_def
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename  = 'import_runs'
     AND indexname  = 'import_runs_one_live_per_source';

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      'import_runs_one_live_per_source is absent. Two browser tabs then create '
      'two runs over one file, and in `update` mode the second captures the '
      'first run''s values as the prior — after which no order of undoing them '
      'returns the customer to where they started.';
  END IF;

  IF v_def NOT LIKE '%UNIQUE%'
     OR v_def NOT LIKE '%source_fingerprint IS NOT NULL%'
     OR v_def NOT LIKE '%superseded_at IS NULL%'
     OR v_def NOT LIKE '%abandoned%' THEN
    RAISE EXCEPTION
      'import_runs_one_live_per_source exists with an unexpected definition: %. '
      'All three predicates are load-bearing and each removal is a different '
      'product bug that still reads as "the index is present".',
      v_def;
  END IF;

  SELECT count(*)::int INTO v_columns
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'import_runs'
     AND column_name IN ('source_fingerprint', 'superseded_at', 'superseded_reason');
  IF v_columns <> 3 THEN
    RAISE EXCEPTION
      'import_runs carries % of the 3 columns 0207 adds.', v_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.import_runs'::regclass
       AND tgname  = 'import_runs_fingerprint_immutable'
  ) THEN
    RAISE EXCEPTION
      'import_runs_fingerprint_immutable is absent, so a caller that hit the '
      'unique index can clear its own fingerprint and insert again.';
  END IF;

  RAISE NOTICE
    '0207: run-level idempotency verified — 3 columns, the unique index carries '
    'all three predicates, the fingerprint is immutable.';
END $$;
