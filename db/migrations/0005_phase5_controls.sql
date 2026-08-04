-- ============================================================================
-- Ordence — Phase 5: Financial Controls, RBAC & Audit
-- Version: v0.5.0-alpha
--
-- Run AFTER `npx drizzle-kit push` has created the Phase 5 tables.
--
-- Contents:
--   1. RLS for financial_periods and permission_denials
--   2. ⭐ THE PERIOD-CLOSE TRIGGER (SEC-012) — blocks back-dated entries
--   3. Non-overlapping period constraint
--   4. Append-only protection extended to permission_denials
--   5. Verification queries
-- ============================================================================

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
-- ############################################################################

ALTER TABLE financial_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_periods_tenant_isolation ON financial_periods;
CREATE POLICY financial_periods_tenant_isolation ON financial_periods
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE permission_denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_denials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS permission_denials_tenant_isolation ON permission_denials;
CREATE POLICY permission_denials_tenant_isolation ON permission_denials
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 2 — ⭐ PERIOD CLOSE ENFORCEMENT (SEC-012)
-- ############################################################################
--
-- THE PROBLEM:
--   You close March, file your numbers with the bank, and then someone posts a
--   back-dated entry into March. Your books now silently disagree with what you
--   filed. Nobody notices until an audit.
--
-- THE FIX:
--   Once a period is closed, the database REFUSES any journal entry whose
--   transaction date falls inside it. INSERT, UPDATE and DELETE alike.
--
-- WHY IT CHECKS THE TRANSACTION DATE, NOT created_at:
--   `created_at` is when the row was typed. `transaction_date` is when the money
--   actually moved — that is what determines which period an entry belongs to.
--   Checking created_at would let anyone back-date freely, which is the exact
--   hole we are closing.

CREATE OR REPLACE FUNCTION enforce_period_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id  uuid;
  v_txn_date   date;
  v_txn_id     uuid;
  v_period     record;
BEGIN
  -- Works for INSERT/UPDATE (NEW) and DELETE (OLD).
  v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_txn_id    := COALESCE(NEW.transaction_id, OLD.transaction_id);

  IF v_tenant_id IS NULL OR v_txn_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- The authoritative date lives on the parent transaction.
  SELECT transaction_date INTO v_txn_date
  FROM transactions
  WHERE id = v_txn_id;

  IF v_txn_date IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Is that date inside a period that is no longer open?
  SELECT id, name, status, start_date, end_date, closed_at
    INTO v_period
  FROM financial_periods
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
$$;

-- Fires BEFORE the write, so a blocked entry never touches the table.
DROP TRIGGER IF EXISTS journal_entries_period_lock ON journal_entries;
CREATE TRIGGER journal_entries_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_period_close();


-- Transactions themselves are also locked, so their dates cannot be moved into
-- or out of a closed period after the fact.
CREATE OR REPLACE FUNCTION enforce_period_close_transactions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_period record;
  v_check_date date;
BEGIN
  -- On UPDATE, check BOTH the old and new dates: moving an entry OUT of a closed
  -- period is just as much a violation as moving one in.
  FOREACH v_check_date IN ARRAY
    ARRAY[COALESCE(NEW.transaction_date, OLD.transaction_date),
          COALESCE(OLD.transaction_date, NEW.transaction_date)]
  LOOP
    SELECT name, start_date, end_date INTO v_period
    FROM financial_periods
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND status <> 'open'
      AND v_check_date BETWEEN start_date AND end_date
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION
        'Cannot % transaction: % falls inside closed period "%".',
        lower(TG_OP), v_check_date, v_period.name
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS transactions_period_lock ON transactions;
CREATE TRIGGER transactions_period_lock
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION enforce_period_close_transactions();


-- ############################################################################
-- SECTION 3 — PERIODS MUST NOT OVERLAP
-- ############################################################################
-- If two periods covered the same day — one open, one closed — the question
-- "is this date locked?" would have two answers. This makes overlap impossible.
--
-- Requires the btree_gist extension so a uuid (tenant_id) and a daterange can
-- live in the same exclusion constraint.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE financial_periods DROP CONSTRAINT IF EXISTS financial_periods_no_overlap;
ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

-- End date cannot precede start date.
ALTER TABLE financial_periods DROP CONSTRAINT IF EXISTS financial_periods_valid_range;
ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_valid_range
  CHECK (start_date <= end_date);


-- ############################################################################
-- SECTION 4 — APPEND-ONLY: PERMISSION DENIALS
-- ############################################################################
-- A denial record is security evidence. If it can be edited or deleted, someone
-- who probes the system can erase the trace of having done so.

CREATE OR REPLACE FUNCTION block_mutation_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS permission_denials_no_update ON permission_denials;
CREATE TRIGGER permission_denials_no_update
  BEFORE UPDATE ON permission_denials
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

DROP TRIGGER IF EXISTS permission_denials_no_delete ON permission_denials;
CREATE TRIGGER permission_denials_no_delete
  BEFORE DELETE ON permission_denials
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();


-- ############################################################################
-- SECTION 5 — updated_at
-- ############################################################################

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS financial_periods_set_updated_at ON financial_periods;
CREATE TRIGGER financial_periods_set_updated_at
  BEFORE UPDATE ON financial_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ############################################################################
-- SECTION 6 — VERIFICATION
-- ############################################################################

-- ── CHECK 1 ── Both new tables must be protected. EXPECT 2 rows, both true.
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('financial_periods', 'permission_denials')
ORDER BY tablename;

-- ── CHECK 2 ── The period-lock triggers must exist. EXPECT 2 rows.
SELECT c.relname AS table_name, t.tgname AS trigger_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE t.tgname IN ('journal_entries_period_lock', 'transactions_period_lock')
ORDER BY c.relname;

-- ── CHECK 3 ── The overlap constraint must exist. EXPECT 1 row.
SELECT conname, contype
FROM pg_constraint
WHERE conname = 'financial_periods_no_overlap';

-- ── CHECK 4 ── PROVE the period lock works.
-- Replace the placeholders with real values, then run. It SHOULD fail.
--
-- Step 1 — close a period:
--   INSERT INTO financial_periods (tenant_id, name, start_date, end_date, status)
--   VALUES ('<tenant-uuid>', 'Q1 2026 TEST', '2026-01-01', '2026-03-31', 'closed');
--
-- Step 2 — try to post an entry dated inside it:
--   BEGIN;
--     INSERT INTO transactions (id, tenant_id, description, transaction_date, currency)
--     VALUES ('22222222-2222-4222-8222-222222222222', '<tenant-uuid>',
--             'Back-dated test', '2026-02-15', 'INR');
--
--     INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
--     VALUES ('<tenant-uuid>', '22222222-2222-4222-8222-222222222222',
--             '<ledger-uuid>', 'debit', 100.00);
--   COMMIT;
--
-- EXPECTED:
--   ERROR: Cannot insert this entry: 2026-02-15 falls inside closed accounting
--          period "Q1 2026 TEST" (2026-01-01 to 2026-03-31).
--
-- Note the error appears on the journal_entries INSERT, not at COMMIT. The
-- period lock is a BEFORE trigger — it stops the write before it happens.
-- (The balance trigger from Phase 4 is deferred and fires at COMMIT. Different
--  jobs, different timing, both correct.)

-- ── CHECK 5 ── List closed periods and how many entries each protects.
SELECT
  fp.name,
  fp.start_date,
  fp.end_date,
  fp.status,
  fp.closed_at,
  COUNT(je.id) AS entries_locked
FROM financial_periods fp
LEFT JOIN transactions t
       ON t.tenant_id = fp.tenant_id
      AND t.transaction_date BETWEEN fp.start_date AND fp.end_date
LEFT JOIN journal_entries je ON je.transaction_id = t.id
GROUP BY fp.id, fp.name, fp.start_date, fp.end_date, fp.status, fp.closed_at
ORDER BY fp.start_date DESC;

-- ── CHECK 6 ── Recent permission denials — the security signal to watch.
SELECT permission, actor_role, was_dangerous, COUNT(*) AS attempts
FROM permission_denials
WHERE created_at > now() - interval '7 days'
GROUP BY permission, actor_role, was_dangerous
ORDER BY was_dangerous DESC, attempts DESC
LIMIT 20;

-- ============================================================================
--   PHASE 5 CONTROLS ACTIVE
-- ============================================================================
