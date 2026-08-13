-- =====================================================================
--  ORDENCE — 0073 · THE PERIOD LOCK THAT WAS NEVER ENFORCED
--  Version: v1.21.0-alpha
--
--  ⚠️ RUN AFTER 0071. It adds one trigger and two columns.
--
--  ⭐ NUMBERED 0073, NOT 0072. 0072 was used once and retired, and it
--  still sits in `SQL-FILES/_superseded`. The migration gate refused the
--  reuse, correctly: two different scripts sharing one position in
--  history is a migration log that cannot be trusted to replay.
--  ⭐ SAFE TO RE-RUN.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 A CLOSED MONTH HAS BEEN ACCEPTING POSTINGS THE WHOLE TIME
--  ══════════════════════════════════════════════════════════════════
--  `financial_periods` has existed since 0005. `closeFinancialPeriod`
--  exists. `isDateLocked` exists and is correct.
--
--  ⚠️ NOTHING HAS EVER CALLED IT. No server action, no posting path, no
--  trigger. A month can be closed on screen and journal entries continue
--  to land in it, silently, for as long as anybody keeps posting.
--
--  🔴 THIS IS WORSE THAN HAVING NO PERIOD CLOSE AT ALL. Closing a period
--  is a statement made to an auditor and to the tax authority: these
--  numbers are final. A close that does not lock means the March figures
--  reported in April are not the March figures that exist in June, and
--  nobody can tell which report was right.
--
--  ⭐ AND NOTICE WHICH GATE MISSED IT. The reachability census asks
--  whether anything references a TABLE, and `financial_periods` is
--  referenced. It cannot ask whether anything calls a GUARD. That is a
--  third kind of gap and this file is the answer to one instance of it.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① THE LOCK, IN THE DATABASE
-- =====================================================================
--
--  🔴 A TRIGGER RATHER THAN AN APPLICATION CHECK, AND THE REASON IS THE
--  SAME ONE 0064 GIVES ABOUT THE WORKFLOW CHAIN GUARD: the application
--  is not the only thing that will ever insert a transaction. An import,
--  a support fix, a future API route and a migration are all callers,
--  and a lock that only exists in the code path somebody remembered is a
--  lock with a hole in it.
--
--  ⚠️ IT CHECKS `transaction_date`, NOT `created_at`. The date on the
--  document is what decides which month it belongs to. Checking the
--  insert time would let somebody post a March-dated entry in June and
--  call it compliant because June is open, which is exactly the move the
--  lock exists to prevent.
CREATE OR REPLACE FUNCTION ordence_guard_closed_period()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked_period record;
BEGIN
  SELECT name, status, end_date INTO locked_period
    FROM financial_periods
   WHERE tenant_id = NEW.tenant_id
     AND NEW.transaction_date BETWEEN start_date AND end_date
     AND status IN ('closed', 'locked')
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'The period % is closed and cannot accept a posting dated %. Closing a period is a statement that its numbers are final; if this entry genuinely belongs in that month, the period has to be reopened deliberately, with a reason, by somebody who may do that.',
      locked_period.name, NEW.transaction_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_closed_period ON transactions;
CREATE TRIGGER ordence_guard_closed_period
  BEFORE INSERT OR UPDATE OF transaction_date ON transactions
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_closed_period();

--  ⭐ THE STATUS VALUES THE GUARD RECOGNISES, WRITTEN DOWN.
--
--  ⚠️ `open` and `closing` both permit postings on purpose. `closing` is
--  the state where somebody is doing the month-end work and still needs
--  to post the adjustments that finish it. Locking at `closing` would
--  make it impossible to close a month at all, which is the kind of rule
--  that gets disabled rather than fixed.
COMMENT ON FUNCTION ordence_guard_closed_period() IS
  'Refuses any transaction whose transaction_date falls inside a period with status closed or locked. Checks the document date, never the insert time.';

-- =====================================================================
--  ② WHAT A REORDER REPORT NEEDS THAT 0029 DID NOT HAVE
-- =====================================================================
--
--  ⭐ `reorder_level`, `reorder_quantity` AND `lead_time_days` ALREADY
--  EXIST on `stock_items` and have since 0029, with a comment explaining
--  that a nullable reorder level keeps items nobody reorders off the
--  report. That decision was right and nothing here changes it.
--
--  ⚠️ WHAT IS MISSING IS THE SUPPLIER AND THE MOVEMENT WINDOW. A reorder
--  list that says "order 200 bags" and not who from is a list somebody
--  has to research before acting on, which means a list nobody acts on.
ALTER TABLE stock_items
  ADD COLUMN IF NOT EXISTS preferred_vendor_id uuid
    REFERENCES vendors(id) ON DELETE SET NULL;

COMMENT ON COLUMN stock_items.preferred_vendor_id IS
  'Who this is normally bought from. Drives the suggested purchase list; nullable because plenty of items have no single supplier.';

--  ⭐ DEAD STOCK IS AN ABSENCE, AND ABSENCES NEED A START DATE.
--
--  ⚠️ "Nothing has moved since" cannot be computed from the movement
--  table alone: an item that has NEVER moved has no rows there at all,
--  and would either be invisible or would look infinitely dead. The date
--  it came into stock is the honest baseline.
ALTER TABLE stock_items
  ADD COLUMN IF NOT EXISTS first_stocked_on date;

COMMENT ON COLUMN stock_items.first_stocked_on IS
  'When this item first had stock. The baseline for ageing: an item that has never moved is aged from here rather than treated as infinitely old.';

CREATE INDEX IF NOT EXISTS stock_items_vendor_idx
  ON stock_items (tenant_id, preferred_vendor_id)
  WHERE preferred_vendor_id IS NOT NULL;

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  IT DOES NOT ADD TABLES FOR THE CRM SOURCES AND STAGES. `lead_sources`
--  and `pipeline_stages` were created by 0061 in v1.10.0 and have never
--  been referenced by any code. They do not need a migration; they need
--  a screen, and v1.21.0 gives them one.
--
--  IT DOES NOT ADD A DEAD-STOCK TABLE. Dead stock is a question asked of
--  the movement ledger, not a fact to be stored. Storing it would create
--  a second answer that goes stale the moment something moves.
--
--  IT DOES NOT LOCK `journal_entries` DIRECTLY. Every journal entry
--  belongs to a transaction, and the transaction carries the date. A
--  second trigger on the child would fire on every leg of every posting
--  for no additional protection.
-- =====================================================================
