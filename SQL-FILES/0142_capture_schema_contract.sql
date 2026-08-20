-- ############################################################################
-- 0142 — CAPTURE THE SCHEMA CONTRACT
--        (Wave 15 / Track C · corrected wave 17)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHY THIS IS A SEPARATE FILE AND NOT THE LAST LINE OF 0139
-- ══════════════════════════════════════════════════════════════════════════
-- `0139_schema_contract_snapshot.sql` builds the machinery and takes a
-- capture, because its own self-test needs something to diff against. But
-- 0140 adds two functions and 0141 replaces two more, so a snapshot taken
-- inside 0139 is stale by the time the sequence finishes.
--
-- Measured, applying 0136…0141 in order and then running
-- `scripts/check-rls-coverage.mjs`:
--
--     schema contract: 6 difference(s)
--       ADDED   function assert_no_tenant_table_drift()
--       ADDED   function tenant_table_drift()
--       ADDED   function prune_security_events(integer,boolean,boolean)
--       ADDED   function prune_usage_counters(interval,boolean)
--       REMOVED function prune_security_events(integer,boolean)
--       REMOVED function prune_usage_counters(interval)
--
-- Every one of those is intended, and a check that is red on every run for
-- reasons everybody knows about is a check that gets ignored — which is how
-- fourteen gates in this repository stopped being run.
--
-- ⭐ SO THE CAPTURE IS ITS OWN FILE, AND IT IS NOTHING BUT A CAPTURE.
-- (Wave 15 said "the highest-numbered file in the sequence". That was
-- wrong for a reason the next section sets out.)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 WAVE 17 CORRECTION — "0142 IS LAST" WAS NEVER A PROPERTY A TRACK
--    COULD OWN, AND IT STOPPED BEING TRUE ON THE DAY THE WAVE ASSEMBLED
-- ══════════════════════════════════════════════════════════════════════════
-- This file was written on the assumption that it would be the highest
-- number in the sequence, so the snapshot it takes would always be current.
-- Six other tracks then landed 0133-0135 and 0146-0159, and the assumption
-- was gone. Measured on the assembled tree, `diff_schema_contract()` returned
-- **22 rows, every single one of them ADDED** — a table and five functions
-- from the tax work, six triggers, nothing wrong anywhere.
--
-- ⚠️ AND THE NEXT WAVE WILL DO IT AGAIN. There is no number this file could
-- hold that a later migration cannot exceed. A control whose correctness
-- depends on being last is a control that is wrong from its second wave on.
--
-- ⭐ SO THE GATE WAS RESHAPED, NOT THIS FILE. `scripts/check-rls-coverage.mjs`
-- now fails on **REMOVED** and **CHANGED** and merely reports **ADDED**:
--
--     drizzle-kit push  TAKES AWAY — 303 tables lose rls, 314 policies go.
--                       It has never added anything in its life.
--     a new migration   ADDS.
--
-- Two opposite signatures, and the check can simply tell them apart. A
-- policy REWRITTEN without a capture still fails, because that is a change
-- to the isolation boundary nobody recorded — and it caught exactly that
-- during wave-17 verification, when a policy was restored by hand with an
-- extra `OR app_platform_scope()` branch that the original did not have.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHO RECAPTURES, AND WHEN
-- ══════════════════════════════════════════════════════════════════════════
-- This file's capture is the Track C baseline and it is still worth taking:
-- it is the shape at position 0142, and a REMOVED row measured against it is
-- a real alarm.
--
-- 🔴 THE AUTHORITATIVE CAPTURE IS INTEGRATION'S, AFTER ASSEMBLY, because
-- only integration knows when the sequence has stopped growing:
--
--     SELECT * FROM capture_schema_contract(
--       'wave NN assembled: tracks A-G, 0001-0159');
--
-- Any track may also capture at the end of its own batch. One line:
--
--     SELECT capture_schema_contract('0147 — added the X policy on Y');
--
-- ⚠️ AND THAT LINE IS A DECLARATION, NOT A CHORE. `capture_schema_contract()`
-- REFUSES an empty reason, precisely so that re-baselining cannot be done
-- silently to make a red gate go green. If you find yourself capturing
-- without being able to write the sentence, the difference is one to look at.
--
-- IS THERE DATA LOSS?  No. One row in `schema_contract_snapshots`.
--
-- RUN ORDER
-- ---------
-- LAST WITHIN TRACK C'S BLOCK — after 0136-0141, which is all this file can
-- guarantee. It is NOT last in the sequence and it cannot be; see the wave-17
-- correction above. Integration recaptures after assembly.
--
-- ⚠️ NO BEGIN/COMMIT.
--
-- RLS
-- ---
-- Unchanged.
-- ############################################################################

SELECT capture_schema_contract(
  '0142 — wave 15 baseline: the security shape after 0136 (phase-4 isolation), '
  '0137 (FORCE + posture), 0138 (one updated_at function), 0139 (the contract '
  'machinery), 0140 (drift detector) and 0141 (retention with teeth).');


-- ----------------------------------------------------------------------------
-- VERIFY
-- ----------------------------------------------------------------------------
--
-- ⚠️ THE ASSERTION IS THAT THE DIFF IS EMPTY, WHICH IS THE ONE THING A
-- CAPTURE CANNOT GUARANTEE BY EXISTING. A capture that stored a truncated row
-- set, or that ran against a different search_path, would still INSERT a row
-- and still look like a success.

DO $$
DECLARE
  n_diff  integer;
  n_rows  integer;
  fp      text;
  latest  record;
BEGIN
  SELECT * INTO latest FROM schema_contract_snapshots ORDER BY id DESC LIMIT 1;

  IF latest IS NULL THEN
    RAISE EXCEPTION '0142 FAILED: no snapshot exists after the capture.'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO n_rows FROM schema_contract_rows();
  SELECT count(*) INTO n_diff FROM diff_schema_contract();
  fp := schema_contract_fingerprint();

  IF latest.row_count <> n_rows THEN
    RAISE EXCEPTION
      '0142 FAILED: the snapshot stored % row(s) and the live schema has %. '
      'The capture did not record everything it measured.', latest.row_count, n_rows
      USING ERRCODE = '23514';
  END IF;

  IF latest.fingerprint <> fp THEN
    RAISE EXCEPTION
      '0142 FAILED: the stored fingerprint (%) does not match the live one (%).',
      left(latest.fingerprint, 16), left(fp, 16)
      USING ERRCODE = '23514';
  END IF;

  IF n_diff <> 0 THEN
    RAISE EXCEPTION
      '0142 FAILED: % difference(s) between the live schema and the snapshot '
      'taken in the statement above. Run: SELECT * FROM diff_schema_contract();',
      n_diff
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE
    '0142 PASS: schema contract captured as snapshot #% — % objects, '
    'fingerprint %. check:rls will now FAIL on a policy, trigger or function '
    'that is REMOVED or CHANGED without a capture, and REPORT anything ADDED. '
    'Recapture after assembly.',
    latest.id, n_rows, left(fp, 16) || '…';
END
$$;
