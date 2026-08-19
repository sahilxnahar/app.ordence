-- ############################################################################
-- 0123 — THE LADDER'S CHRONOLOGY CHECK STOPPED FIRING IN 0098
--        (Infra wave 12 / v1.79.0-alpha)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- A dunning ladder can be recorded out of chronological order, and the refusal
-- that was written to prevent it cannot fire on any row created since 0098.
--
-- 0027 §6 put a BEFORE-ROW trigger on `dunning_events` with two halves. The
-- first refuses a skipped rung. The second refuses a rung dated before the one
-- below it, and its message says exactly what is at stake:
--
--     '⚠️ REFUSED: a ladder whose rungs are out of order reads, in the bundle
--      produced at a hearing, as a file reconstructed after the event.'
--
-- It compares `sent_at`:
--
--     SELECT max(rung), max(sent_at) INTO v_previous_rung, v_last_sent ...
--     IF v_last_sent IS NOT NULL AND NEW.sent_at < v_last_sent THEN
--
-- 🔴 0098 MADE `sent_at` NULL ON EVERY NEW ROW, ON PURPOSE. Its own summary
-- says so: "A freshly created row is ALWAYS 'none' (that is the column
-- default), so an INSERT can no longer carry a send timestamp at all. Evidence
-- is established by a LATER statement or not at all." That is the right
-- decision , `sent_at` was a timestamp for a notice the allottee may never
-- have received, and cancelling a family's allotment on it is the developer's
-- own system testifying against them.
--
-- But the chronology check was left reading the column 0098 emptied. At
-- INSERT, `NEW.sent_at` is NULL, so `NEW.sent_at < v_last_sent` is NULL, so
-- the IF is not taken. `v_last_sent` is `max(sent_at)` over sibling rows that
-- are also NULL, so it is NULL as well and the guard short-circuits first.
--
-- ⚠️ NEITHER HALF ERRORS. The insert succeeds and the log says nothing. The
-- skipped-rung half still works, so the trigger looks alive.
--
-- ⚠️ AND THE TEST THAT COVERS IT STILL PASSES, because the test supplies
-- `sent_at` on the insert , which 0098 also made impossible for real callers
-- (a CHECK refuses `sent_at` on a row whose `service_evidence` is 'none').
-- The test asserts the behaviour of an INSERT the product can no longer make.
--
-- WHAT THIS FILE DOES
-- -------------------
-- Orders on the rung's EFFECTIVE DATE instead:
--
--     coalesce(sent_at, served_at, dispatched_at, raised_at)
--
-- `raised_at` is the one 0098 guarantees , `dunning_events_raised_at_present`
-- makes it NOT NULL for every non-legacy row , so the check has something to
-- read at INSERT again. The stronger facts win when they are present, which is
-- the same precedence 0098 uses everywhere else: served beats dispatched beats
-- raised.
--
-- ⚠️ LEGACY ROWS ARE STILL EXEMPT. A 'legacy_unverified' row may have no date
-- at all, and inventing an order for it would be the same crime 0098 refused
-- to commit with a backfill. `coalesce(...)` is NULL for those, the comparison
-- is NULL, and the row passes , exactly as before.
--
-- IS THERE DATA LOSS?  No. One function is replaced. No row is read or
-- written. The trigger is recreated so it also fires when a date column that
-- now participates in the ordering changes.
--
-- RUN ORDER
-- ---------
-- After 0098. SQL FIRST, then the code.
--
-- ⚠️ NO BEGIN/COMMIT. Every statement is independently idempotent.
--
-- RLS
-- ---
-- Not applicable. No table is created or altered.
-- ############################################################################

CREATE OR REPLACE FUNCTION dunning_ladder_has_no_gaps()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_previous_rung integer;
  v_missing       text;
  v_last_effective timestamptz;
  v_new_effective  timestamptz;
BEGIN
  IF NEW.rung = 1 THEN
    RETURN NEW;
  END IF;

  -- ⭐ THE EFFECTIVE DATE OF A RUNG, in order of evidential strength. Kept
  -- identical on both sides of the comparison below; if these two expressions
  -- ever diverge the check silently compares two different things, which is
  -- the shape of the bug this file exists to fix.
  v_new_effective := coalesce(NEW.sent_at, NEW.served_at, NEW.dispatched_at, NEW.raised_at);

  SELECT max(rung),
         max(coalesce(sent_at, served_at, dispatched_at, raised_at))
    INTO v_previous_rung, v_last_effective
    FROM dunning_events
   WHERE tenant_id = NEW.tenant_id
     AND demand_id = NEW.demand_id
     AND id       <> NEW.id
     AND rung      < NEW.rung;

  IF v_previous_rung IS NULL OR v_previous_rung <> NEW.rung - 1 THEN
    v_missing := CASE NEW.rung - 1
                   WHEN 1 THEN 'reminder'
                   WHEN 2 THEN 'first notice'
                   WHEN 3 THEN 'final notice'
                   ELSE 'previous notice'
                 END;
    RAISE EXCEPTION
      'This demand has not been sent a %, so a % cannot be sent. ⚠️ REFUSED: '
      'the ladder is reminder → first notice → final notice → cancellation '
      'warning, and a buyer shown a later rung who never received an earlier '
      'one has a complete answer at the Authority — with this table, which is '
      'the record the developer would produce, as the evidence against them. '
      'Send the % first. If it was sent outside this system, record it here '
      'with its real date and channel; back-filling the history is the '
      'supported path and skipping it is not.',
      v_missing, replace(NEW.stage::text, '_', ' '), v_missing
      USING ERRCODE = 'check_violation';
  END IF;

  -- ⚠️ AND THE RUNGS MUST BE IN CHRONOLOGICAL ORDER. A final notice dated
  -- before the first notice reads, in the bundle produced at a hearing, as a
  -- developer who reconstructed the file afterwards.
  --
  -- 🔴 THIS USED TO READ `NEW.sent_at < v_last_sent` AND HAD NOT FIRED SINCE
  -- 0098, which made sent_at NULL on every new row by design. See the header.
  IF v_last_effective IS NOT NULL
     AND v_new_effective IS NOT NULL
     AND v_new_effective < v_last_effective THEN
    RAISE EXCEPTION
      'This % is dated %, which is before the previous rung (%). '
      '⚠️ REFUSED: a ladder whose rungs are out of order reads, in the bundle '
      'produced at a hearing, as a file reconstructed after the event.',
      replace(NEW.stage::text, '_', ' '), v_new_effective, v_last_effective
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;


-- ⚠️ THE TRIGGER IS RECREATED because its UPDATE OF list named only `sent_at`.
-- Now that three more columns decide the ordering, a statement that sets
-- `raised_at`, `served_at` or `dispatched_at` must be checked too — otherwise
-- the ordering can be rewritten after the fact by an UPDATE the trigger does
-- not watch, which is precisely the reconstruction the message warns about.
DROP TRIGGER IF EXISTS dunning_events_no_skipped_rung ON dunning_events;
CREATE TRIGGER dunning_events_no_skipped_rung
  BEFORE INSERT OR UPDATE OF stage, rung, demand_id, sent_at, raised_at,
                             served_at, dispatched_at ON dunning_events
  FOR EACH ROW EXECUTE FUNCTION dunning_ladder_has_no_gaps();


-- ----------------------------------------------------------------------------
-- VERIFY
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'dunning_ladder_has_no_gaps';

  IF src IS NULL THEN
    RAISE EXCEPTION '0123 FAILED: dunning_ladder_has_no_gaps() is missing.';
  END IF;

  IF position('v_new_effective' in src) = 0 THEN
    RAISE EXCEPTION
      '0123 FAILED: the ladder trigger is still the sent_at version. The '
      'chronological check cannot fire on any row created since 0098.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'dunning_events'::regclass
       AND tgname  = 'dunning_events_no_skipped_rung'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0123 FAILED: the trigger was dropped and not recreated.';
  END IF;

  RAISE NOTICE
    '0123 PASS: the ladder orders on the rung effective date, which every '
    'non-legacy row has.';
END
$$;
