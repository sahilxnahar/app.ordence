-- =====================================================================
-- 0090 , Period-close refusal wording, normalised (Wave 9 hardening)
-- ⚠️ AMENDED BY REVIEW: section 3 dropped a production guard. Restored.
-- =====================================================================
-- Context (audit trail):
--   Wave 8's accounting-triggers security suite asserts that every
--   period-close refusal says "closed accounting period" so the refusal
--   is machine-auditable and consistent across every code path. Two
--   guard functions had drifted into two different dialects:
--     enforce_period_close               -> 'falls inside closed period "%"'
--     ordence_guard_closed_period (0073) -> 'The period % is closed and cannot accept a posting dated %'
--   Both refuse the write with the same ERRCODE (check_violation); only
--   the wording differed. This file normalises both to the auditable
--   phrase WITHOUT changing behaviour: same ERRCODE, same deferral model,
--   same reopen-deliberately semantics.
-- Applies:   idempotent (CREATE OR REPLACE + trigger re-bind by name,
--            guarded by DO blocks — re-running is a no-op)
-- Reversal:  re-run 0073 / 0078 originals
-- Order:     after 0073 (period lock) and 0078 (transactions lock)
-- =====================================================================

BEGIN;

-- 1. enforce_period_close: identical behaviour, message now carries the
--    auditable phrase "closed accounting period" (it already did in part;
--    this is a no-op re-bind for wording consistency with 0090's suite).
CREATE OR REPLACE FUNCTION public.enforce_period_close()
RETURNS trigger
LANGUAGE plpgsql AS
$fn$
DECLARE
  v_tenant_id uuid;
  v_txn_date  date;
  v_txn_id    uuid;
  v_period    record;
BEGIN
  v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_txn_id    := COALESCE(NEW.transaction_id, OLD.transaction_id);

  IF v_tenant_id IS NULL OR v_txn_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT transaction_date INTO v_txn_date
    FROM public.transactions
   WHERE id = v_txn_id;

  IF v_txn_date IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT id, name, status, start_date, end_date, closed_at
    INTO v_period
    FROM public.financial_periods
   WHERE tenant_id = v_tenant_id
     AND status <> 'open'
     AND v_txn_date BETWEEN start_date AND end_date
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot % this entry: % falls inside closed accounting period "%" (% to %).',
      lower(TG_OP), v_txn_date, v_period.name, v_period.start_date, v_period.end_date
      USING ERRCODE = 'check_violation',
            HINT = 'Post the entry to an open period, or reopen this period first. '
                   'Reopening requires the periods:reopen permission and is fully audited.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$fn$;

-- 2. ordence_guard_closed_period: fold the auditable phrase in.
CREATE OR REPLACE FUNCTION public.ordence_guard_closed_period()
RETURNS trigger
LANGUAGE plpgsql AS
$fn$
DECLARE
  locked_period record;
BEGIN
  SELECT name, status, end_date INTO locked_period
    FROM public.financial_periods
   WHERE tenant_id = NEW.tenant_id
     AND NEW.transaction_date BETWEEN start_date AND end_date
     AND status IN ('closed', 'locked')
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'The closed accounting period "%" cannot accept a posting dated %. '
      'Closing a period is a statement that its numbers are final; if this '
      'entry genuinely belongs in that month, the period has to be reopened '
      'deliberately, with a reason, by somebody who may do that.',
      locked_period.name, NEW.transaction_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

-- 3. 🔴 THE TRIGGER DROP THAT WAS HERE HAS BEEN REVERSED. READ THIS.
--
--    This file is titled "message normalization" and its header says it
--    normalises wording "WITHOUT changing behaviour". Section 3 contained:
--
--        DROP TRIGGER IF EXISTS ordence_guard_closed_period ON transactions;
--
--    That is not a wording change. It removes the ONLY guard that refuses
--    an INSERT into `transactions` dated inside a closed period.
--
--    ⚠️ THE OTHER GUARD DOES NOT COVER INSERT. `transactions_period_lock`
--    (0005) fires BEFORE UPDATE OR DELETE ON transactions , there is no
--    INSERT in its event list. `ordence_guard_closed_period` (0073) fires
--    BEFORE INSERT OR UPDATE OF transaction_date. Dropping it leaves the
--    header unguarded on INSERT, and 0073's own comment says exactly what
--    that guard is for: "Checks the document date, never the insert time."
--
--    🔴 AND THE REASON FOR THE DROP IS THE REAL PROBLEM. The original
--    comment said it plainly: the binding "made the header INSERT fail
--    before the journal entry could be rejected , the exact failure mode
--    the SEC-012 suite asserts must NOT happen". A test expected the
--    header to land and only the leg to be refused. The database was
--    STRICTER than the test expected, and the guard was deleted so the
--    test would pass.
--
--    ⭐ A TEST THAT DISAGREES WITH A SAFETY GUARD IS EVIDENCE ABOUT THE
--    TEST. If this product genuinely wants the header to land and only
--    the leg refused, that is a decision to take deliberately, with the
--    accounting consequence written down , not a side effect of a file
--    about wording. Until then the strict behaviour stands, because it is
--    the one that cannot let a posting into a closed month.
--
--    The re-bind below is idempotent and restores 0073's binding exactly.
DROP TRIGGER IF EXISTS ordence_guard_closed_period ON transactions;
CREATE TRIGGER ordence_guard_closed_period
  BEFORE INSERT OR UPDATE OF transaction_date ON transactions
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_closed_period();

-- 4. enforce_period_close_transactions: same behaviour, wording normalised
--    to the auditable phrase "closed accounting period".
--    NOTE: behaviour is byte-for-byte identical to the original — the only
--    change is the RAISE wording (audit-phrase consistency). The FOREACH
--    over old AND new dates on UPDATE is preserved.
CREATE OR REPLACE FUNCTION public.enforce_period_close_transactions()
RETURNS trigger
LANGUAGE plpgsql AS
$fn$
DECLARE
  v_period     record;
  v_check_date date;
BEGIN
  -- On UPDATE, check BOTH the old and new dates: moving an entry OUT of a closed
  -- period is just as much a violation as moving one in.
  FOREACH v_check_date IN ARRAY
    ARRAY[COALESCE(NEW.transaction_date, OLD.transaction_date),
          COALESCE(OLD.transaction_date, NEW.transaction_date)]
  LOOP
    SELECT name, start_date, end_date INTO v_period
      FROM public.financial_periods
     WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
       AND status <> 'open'
       AND v_check_date BETWEEN start_date AND end_date
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION
        'Cannot % this transaction: % falls inside closed accounting period "%" (% to %).',
        lower(TG_OP), v_check_date, v_period.name, v_period.start_date, v_period.end_date
        USING ERRCODE = 'check_violation',
              HINT = 'Post to an open period, or reopen this period first. '
                     'Reopening requires the periods:reopen permission and is fully audited.';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$fn$;

COMMIT;
