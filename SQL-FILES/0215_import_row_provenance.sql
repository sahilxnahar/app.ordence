-- ############################################################################
-- 0215 — PROVENANCE, RECONCILED
--        (Phase 3's delivery, rewritten at integration against Phase 2's table)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 READ THIS FIRST: PHASE 2 AND PHASE 3 BOTH BUILT THIS TABLE, AND THEIR
--    TWO VERSIONS COULD NOT BOTH BE APPLIED
-- ══════════════════════════════════════════════════════════════════════════
-- Track M1 specified `import_row_provenance` as SQL 0196 and shipped no DDL.
-- Phase 2 and Phase 3 each noticed the gap independently and each wrote the
-- table: 0205 and the original 0215. Neither could see the other. The
-- original is kept verbatim at
-- `_superseded/0215_import_row_provenance.PHASE-3-ORIGINAL.sql`.
--
-- Integration found three collisions, and two of them were live faults, not
-- tidiness:
--
-- ┌──────────────────────────────────────────────────────────────────────────
-- │ ① THE SHAPES DISAGREE, SO THE SECOND FILE TO RUN WOULD ABORT THE PACK.
-- │   0205 carries `input_row_number`, `operation`, `reversal_kind`,
-- │   `written_at`, `written_xid`, `reversed_at`, `reversal_id`.
-- │   The original 0215 carried `record_number`, `source_name`, `created_at`
-- │   and none of the reversal columns. Both are `CREATE TABLE IF NOT
-- │   EXISTS`, so whichever ran second was a silent no-op — and then its own
-- │   shape assertion, correctly, refused.
-- │
-- │   0205 IS THE SHAPE THAT SHIPS, and not by seniority: it is the shape
-- │   `db/schema/import-runs.ts` declares, which is the definition the
-- │   product typechecks against and the only one any TypeScript reads.
-- │   Nothing in the tree reads `record_number` or `source_name` from this
-- │   table. `server/import/dryrun.ts` has a `recordNumber`, and it is an
-- │   in-memory field on a plan row, not a column.
-- │
-- │ ② 🔴 THE ORIGINAL'S APPEND-ONLY TRIGGER WOULD HAVE BROKEN EVERY UNDO.
-- │   `import_row_provenance_no_update` raised on EVERY update, for every
-- │   role, unconditionally. But reversal is recorded ON THIS ROW:
-- │   `server/import/reversal.ts:444` does
-- │       .set({ reversedAt: new Date(), reversalId })
-- │   so the first customer to undo an import would have been told the table
-- │   is append-only, their rows would have stayed imported, and the
-- │   feature would have read as broken rather than the migration.
-- │
-- │   0205's `import_row_provenance_immutable` is the correct trigger and it
-- │   is kept: it refuses every rewrite of the twelve evidential columns and
-- │   permits exactly `reversed_at` and `reversal_id`, which is the
-- │   difference between evidence and a locked file.
-- │
-- │ ③ ONE SAID LOG IT, THE OTHER SAID DO NOT.
-- │   0205 calls `attach_change_log_triggers()`; the original 0215 declared
-- │   the table excluded from the change log. `attach_change_log_triggers()`
-- │   skips anything already in `change_log_exclusions`, so the outcome
-- │   depended purely on which file ran first — and in this pack 0205 runs
-- │   first, which is the losing order.
-- │
-- │   THE EXCLUSION IS RIGHT, and §3 below therefore also DETACHES the
-- │   recorder if 0205 already attached it. One change_log row per imported
-- │   row, carrying two JSONB copies of a row that can never differ, written
-- │   into the fastest-growing table in the product, during a bulk import,
-- │   is not an audit trail — it is the reason a migration times out.
-- └──────────────────────────────────────────────────────────────────────────
--
-- ⚠️ WHAT SURVIVES FROM PHASE 3'S FILE: THE CHANGE-LOG DECISION, AND
--    NOTHING ELSE. An earlier draft of this reconciliation also kept Phase
--    3's `target_known` trigger, which refuses provenance naming a
--    destination table that does not exist. IT WAS REMOVED BEFORE SHIPPING,
--    because 0205's `same_transaction` trigger already refuses exactly that
--    — and refuses more besides: a denied table, a table with no tenant_id,
--    and a target row not written by this transaction. Both are BEFORE
--    INSERT, and triggers fire in name order, so `same_transaction` fired
--    first every time and the second copy could never even produce its
--    message.
--
--    🔴 A SECOND COPY OF A GUARD IS NOT DEFENCE IN DEPTH, IT IS TWO PLACES
--    TO FIX AND ONE OF THEM WILL BE MISSED. This repository has the scar:
--    a duplicate race guard was written into `server/platform/provision.ts`
--    at Wave 1 and deleted the same day, against a header that warned about
--    exactly that.
--
-- ⚠️ THIS FILE CREATES NO TABLE, NO POLICY AND NO INDEX. 0205 does all of
--    that. If 0205 has not been applied, §1 refuses rather than creating a
--    second opinion about what this table is.
--
-- 🔴 RUN 0205 BEFORE THIS FILE. The pack's numbered order already does.
--
-- ############################################################################


-- ############################################################################
-- SECTION 1 — REFUSE IF 0205 IS NOT THERE, OR IS NOT THE SHAPE WE EXPECT
-- ############################################################################
--
-- ⚠️ COLUMN BY COLUMN, NOT `to_regclass(...) IS NOT NULL`. A table of the
-- right name and the wrong shape is precisely the state this reconciliation
-- exists to prevent, and a presence probe cannot tell the two apart. This is
-- the same lesson the SQL checker learned when 0134 and 0138 read PRESENT
-- while half-applied.

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_col     text;
BEGIN
  IF to_regclass('public.import_row_provenance') IS NULL THEN
    RAISE EXCEPTION
      '0215 FAILED: import_row_provenance does not exist. This file no longer '
      'creates it — 0205 does. Apply 0205 first, then re-run this file.'
      USING ERRCODE = 'undefined_table';
  END IF;

  FOREACH v_col IN ARRAY ARRAY[
    'id', 'tenant_id', 'run_id', 'entity_key', 'input_row_number',
    'cardinality', 'target_table', 'target_id', 'operation',
    'reversal_kind', 'written_at', 'written_xid', 'reversed_at', 'reversal_id'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'import_row_provenance'
         AND column_name  = v_col
    ) THEN
      v_missing := v_missing || v_col;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      '0215 FAILED: import_row_provenance exists but is missing column(s) [%]. '
      'That is the shape Phase 3''s original file created, and it is not the '
      'shape db/schema/import-runs.ts declares or server/import/reversal.ts '
      'writes. Do not patch it by hand: work out which file created this '
      'table and reconcile it against 0205 before going further.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = 'datatype_mismatch';
  END IF;

  RAISE NOTICE '0215 §1: import_row_provenance present with 0205''s shape.';
END $$;


-- ############################################################################
-- SECTION 2 — DECLARE THE EXCLUSION, AND UNDO 0205'S ATTACHMENT
-- ############################################################################
--
-- ⚠️ THE INSERT ALONE IS NOT ENOUGH, AND THAT IS THE WHOLE POINT OF THIS
-- SECTION. `attach_change_log_triggers()` skips excluded tables, but 0205
-- ran it BEFORE this row existed. Declaring the exclusion without removing
-- the trigger leaves a table that is both recorded and declared exempt —
-- and 0122's coverage check passes either way, so nothing would ever have
-- reported it. Declared-and-unenforced, one more time.

INSERT INTO public.change_log_exclusions (table_name, reason, category, declared_in)
VALUES (
  'import_row_provenance',
  'Provenance is already its own history. import_row_provenance_immutable (0205) refuses every rewrite of the twelve evidential columns for every role including the owner, and permits only reversed_at and reversal_id, so a change recorder could add nothing a reader cannot get from the row. Attaching it would also write one change_log row per imported row, each carrying two JSONB copies of a row that can never differ, into the fastest-growing table in the product, during a bulk import. Same reasoning as audit_logs and payment_events.',
  'append-only',
  '0215'
)
ON CONFLICT (table_name) DO UPDATE
  SET reason      = EXCLUDED.reason,
      category    = EXCLUDED.category,
      declared_in = EXCLUDED.declared_in;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'import_row_provenance_change_log'
       AND NOT tgisinternal
       AND tgrelid = 'public.import_row_provenance'::regclass
  ) THEN
    DROP TRIGGER import_row_provenance_change_log ON public.import_row_provenance;
    RAISE NOTICE
      '0215 §2: detached the change_log recorder that 0205 attached before this '
      'exclusion existed.';
  ELSE
    RAISE NOTICE '0215 §2: no change_log recorder attached, nothing to detach.';
  END IF;
END $$;

-- The impersonation guard is a different question and the answer is yes.
-- 0125's header: it guards whatever exists when it runs, so every later file
-- that creates or changes a tenant table calls it itself.
SELECT * FROM public.attach_impersonation_guards();


-- ############################################################################
-- SECTION 3 — RECORD THE REMOVAL, BECAUSE A REMOVAL IS WHAT DAMAGE LOOKS LIKE
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 `check:rls` REFUSED THIS FILE UNTIL THIS SECTION EXISTED, AND IT WAS
--    RIGHT TO
-- ══════════════════════════════════════════════════════════════════════════
-- 0139's schema contract compares the live catalogue against the last
-- captured snapshot, and it treats ADDED and REMOVED completely
-- differently. Added objects are "expected after a new migration, and not
-- fatal". A REMOVED policy, trigger or function is an error, and its
-- message says why in one sentence:
--
--     *"A REMOVED policy, trigger or function is what `drizzle-kit push`
--      looks like — it takes away, it never adds."*
--
-- §2 above detaches `import_row_provenance_change_log` ON PURPOSE. To the
-- contract that is indistinguishable from the accident the contract exists
-- to catch — a banned `drizzle-kit push` against production quietly
-- dropping objects, which is the failure that would take RLS off 300+
-- tables and exit 0.
--
-- ⚠️ SO THE REMOVAL IS DECLARED, IN THE SAME FILE THAT PERFORMS IT, WITH
-- THE REASON ATTACHED. The alternative — capturing later, by hand, from a
-- run book — is how a contract stops meaning anything: whoever runs the
-- capture is not the person who knows what changed.
--
-- ⚠️ AND IT CAPTURES THE WHOLE PACK'S ADDITIONS TOO. 0205 through 0275 add
-- roughly forty functions and triggers between them. They are not fatal to
-- the check, but leaving them uncaptured means the next genuine removal is
-- reported against a snapshot that is months stale.
--
-- 🔴 THIS IS THE LAST STATEMENT OF THE LAST FILE THAT CHANGES THE SHAPE OF
--    THE SIDECAR. If files are ever re-ordered so that something after
--    0215 adds or drops an object, the capture moves with it.

DO $$
DECLARE
  v_reason text :=
    'Import pack 0205-0275. Reconciled Phase 2 and Phase 3''s two versions of '
    'import_row_provenance onto 0205''s shape, and DETACHED '
    'import_row_provenance_change_log: the table is declared in '
    'change_log_exclusions because it is already append-only by trigger, and '
    'recording it would write one change_log row per imported row during a '
    'bulk migration. See 0215 sections 1 and 2.';
BEGIN
  IF to_regproc('public.capture_schema_contract') IS NULL THEN
    RAISE NOTICE
      '0215 §3: capture_schema_contract() is not present (0139 not applied); '
      'nothing to record.';
  ELSE
    PERFORM public.capture_schema_contract(v_reason);
    RAISE NOTICE '0215 §3: schema contract re-captured with the reason attached.';
  END IF;
END $$;


-- ############################################################################
-- SELF-VERIFICATION — EXACT COUNTS, NOT FLOORS
-- ############################################################################
--
-- ⚠️ EVERY ASSERTION NAMES THE NUMBER IT EXPECTS. `count(*) >= 1` is the
-- shape this repository has already shipped a restore script under, which
-- reported RESTORE COMPLETE while expecting 2 policies against 313 present.

DO $$
DECLARE
  v_int integer;
BEGIN
  -- ① 🔴 AND THE DUPLICATE MUST NOT BE THERE EITHER.
  --    An earlier draft of this file added `target_known`, a second copy of
  --    a check `same_transaction` already performs. If a database has it,
  --    that draft was applied and the duplicate should go.
  SELECT count(*) INTO v_int
    FROM pg_trigger
   WHERE tgname = 'import_row_provenance_target_known'
     AND NOT tgisinternal
     AND tgrelid = 'public.import_row_provenance'::regclass;
  IF v_int <> 0 THEN
    RAISE EXCEPTION
      '0215 FAILED: import_row_provenance_target_known is attached (found %). '
      'It duplicates 0205''s same_transaction trigger, which fires first and '
      'checks strictly more. Drop it: DROP TRIGGER '
      'import_row_provenance_target_known ON public.import_row_provenance;',
      v_int
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ② 0205's same_transaction trigger, which is the real destination check
  SELECT count(*) INTO v_int
    FROM pg_trigger
   WHERE tgname = 'import_row_provenance_same_transaction'
     AND NOT tgisinternal
     AND tgrelid = 'public.import_row_provenance'::regclass;
  IF v_int <> 1 THEN
    RAISE EXCEPTION
      '0215 FAILED: 0205''s same_transaction trigger is not attached (found %). '
      'That is the trigger that refuses a destination which does not exist, '
      'has no tenant_id, is a denied table, or was not written by this '
      'transaction.', v_int
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ③ 0205's immutable trigger, which this file depends on and must not have
  --    displaced. Its absence would mean provenance can be rewritten.
  SELECT count(*) INTO v_int
    FROM pg_trigger
   WHERE tgname = 'import_row_provenance_immutable'
     AND NOT tgisinternal
     AND tgrelid = 'public.import_row_provenance'::regclass;
  IF v_int <> 1 THEN
    RAISE EXCEPTION
      '0215 FAILED: 0205''s import_row_provenance_immutable trigger is not '
      'attached (found %). Provenance would be rewritable, and this file '
      'has just declared the table exempt from the change log on the '
      'strength of that trigger existing.', v_int
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ④ 🔴 THE ORIGINAL 0215'S BLANKET TRIGGER MUST NOT BE PRESENT.
  --    If it is, this database has the superseded file applied and every
  --    undo will fail at server/import/reversal.ts:444.
  SELECT count(*) INTO v_int
    FROM pg_trigger
   WHERE tgname = 'import_row_provenance_no_update'
     AND NOT tgisinternal
     AND tgrelid = 'public.import_row_provenance'::regclass;
  IF v_int <> 0 THEN
    RAISE EXCEPTION
      '0215 FAILED: import_row_provenance_no_update is attached. That is the '
      'superseded Phase 3 trigger and it refuses EVERY update, including the '
      'one server/import/reversal.ts makes to record a reversal. Every undo '
      'would fail. Drop it: DROP TRIGGER import_row_provenance_no_update ON '
      'public.import_row_provenance;'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⑤ excluded from the change log, AND not recorded
  IF NOT EXISTS (
    SELECT 1 FROM public.change_log_exclusions
     WHERE table_name = 'import_row_provenance'
  ) THEN
    RAISE EXCEPTION
      '0215 FAILED: import_row_provenance is not in change_log_exclusions, so '
      'the next call to attach_change_log_triggers() re-attaches the recorder.'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO v_int
    FROM pg_trigger
   WHERE tgname = 'import_row_provenance_change_log'
     AND NOT tgisinternal
     AND tgrelid = 'public.import_row_provenance'::regclass;
  IF v_int <> 0 THEN
    RAISE EXCEPTION
      '0215 FAILED: the change_log recorder is still attached (found %) while '
      'the table is declared exempt. Both states at once is what §3 exists to '
      'prevent.', v_int
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⑥ RLS, the pair. FORCE is the half that binds the owner.
  SELECT count(*) INTO v_int
    FROM pg_class
   WHERE oid = 'public.import_row_provenance'::regclass
     AND relrowsecurity AND relforcerowsecurity;
  IF v_int <> 1 THEN
    RAISE EXCEPTION
      '0215 FAILED: import_row_provenance does not have BOTH ENABLE and FORCE '
      'row level security. Production connects as the table owner, and ENABLE '
      'alone does not apply to an owner.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RAISE NOTICE
    '0215 OK: no duplicate destination guard, 0205''s same_transaction and '
    'immutable triggers intact, the superseded blanket trigger absent, '
    'change log excluded and detached, RLS enabled and forced.';
END $$;
