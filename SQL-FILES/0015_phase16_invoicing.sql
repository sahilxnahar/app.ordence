-- ============================================================================
-- Ordence — Phase 16: Invoicing & the Billing Portal
-- Version: v0.16.0-alpha
--
-- Run AFTER `npx drizzle-kit push`.
--
-- Contents:
--   1. ⭐ One invoice per subscription period — enforced, not checked
--   2. An issued invoice must have lines
--   3. Invoice numbers are immutable and never reused
--   4. Grants
--   5. Verification
--
-- ============================================================================
-- ⚠️  WHY THIS FILE EXISTS AT ALL
-- ============================================================================
-- Phase 11 built the invoice TABLE and proved it could not be tampered with
-- after issue. This phase builds the code that CREATES invoices, and creation
-- has its own failure mode that immutability does nothing about:
--
--     ISSUING THE SAME PERIOD TWICE.
--
-- A redelivered webhook, a cron that ran twice, an operator who clicked again
-- because the first attempt seemed slow. Each produces a second, perfectly
-- valid, perfectly immutable invoice for a month the customer has already
-- been billed for.
--
-- The customer notices. There is no way to withdraw it except a credit note,
-- which means the mistake is now permanently in both parties' filings. And an
-- application-level "check if one exists" races: two concurrent runs both
-- read "none", both write.
--
-- So it is a UNIQUE INDEX. Section 1.
-- ============================================================================


CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ⭐ ONE INVOICE PER SUBSCRIPTION PERIOD
-- ############################################################################
--
-- PARTIAL, and each exclusion is deliberate:
--
--   • `status <> 'void'` — a voided invoice must not block a corrected one.
--     Voiding is exactly how you recover from a mistaken issue, and if the
--     void still occupied the slot there would be no route back.
--
--   • `subscription_id IS NOT NULL` — one-off invoices (a manual enterprise
--     bill, an adjustment) have no period to collide on.
--
--   • `period_start IS NOT NULL` — same reasoning.
--
-- ⚠️ This index is the ONLY thing standing between a retried webhook and a
-- duplicate charge on a real customer. `npm run db:verify` asserts it exists,
-- because `drizzle-kit push` removes what it does not recognise.

CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_per_period
  ON invoices (subscription_id, period_start, period_end)
  WHERE subscription_id IS NOT NULL
    AND period_start IS NOT NULL
    AND status <> 'void';


-- ############################################################################
-- SECTION 2 — AN ISSUED INVOICE MUST HAVE LINES
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   `generateInvoice()` inserts the header, then the lines, then seals it —
--   all in one transaction, so a crash between steps rolls everything back.
--
--   But that is a property of ONE function. A future migration, a support
--   script, or an operator with a SQL console can move an invoice to `open`
--   with nothing attached. The customer then receives a document with a total
--   and no explanation of what it is for, which is both useless and, under
--   GST rules, not a valid invoice.
--
--   The header trigger from Phase 11 does not catch it: that one prevents
--   CHANGING an issued invoice, not issuing an empty one.
--
-- THE FIX:
--   Refuse the draft → issued transition when no lines exist.
--
--   ⚠️ Deliberately checks only the transition, not every UPDATE. Recording a
--   payment on an issued invoice must stay possible, and re-counting lines on
--   every status change would make that needlessly expensive.

CREATE OR REPLACE FUNCTION prevent_empty_invoice_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  line_count integer;
BEGIN
  -- Only the moment of issue matters.
  IF OLD.status <> 'draft' OR NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO line_count FROM invoice_lines WHERE invoice_id = NEW.id;

  IF line_count = 0 THEN
    RAISE EXCEPTION
      'Invoice % cannot be issued with no line items. A total with nothing '
      'itemised is not a valid GST invoice.',
      NEW.invoice_number
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_require_lines ON invoices;
CREATE TRIGGER invoices_require_lines
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION prevent_empty_invoice_issue();


-- ############################################################################
-- SECTION 3 — NUMBERS ARE NEVER REUSED
-- ############################################################################
--
-- The sequence guarantees uniqueness going forward. What it does not prevent
-- is somebody RESETTING it — `ALTER SEQUENCE invoice_number_seq RESTART` is
-- one line, and the usual motivation is entirely well-meaning: tidying up
-- after test data.
--
-- The consequence is two different invoices bearing one number, months apart,
-- both filed. That is indistinguishable from fraud after the fact.
--
-- There is no way to forbid ALTER SEQUENCE to an owner, so this records the
-- high-water mark and lets `db:verify` shout if the sequence ever falls below
-- a number already issued.

CREATE OR REPLACE FUNCTION invoice_sequence_is_sane()
RETURNS TABLE (verdict text, highest_issued bigint, sequence_at bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  max_issued bigint;
  seq_value bigint;
BEGIN
  -- The trailing 6 digits of every number we have ever written.
  SELECT coalesce(max(NULLIF(regexp_replace(invoice_number, '^.*/', ''), '')::bigint), 0)
    INTO max_issued
    FROM invoices
   WHERE invoice_number ~ '/[0-9]+$';

  SELECT last_value INTO seq_value FROM invoice_number_seq;

  RETURN QUERY SELECT
    CASE WHEN seq_value >= max_issued
         THEN 'PASS: the sequence is ahead of every number issued'
         ELSE '*** FAIL: the sequence has been reset below an issued number — '
              'the next invoice will REUSE a number already filed ***'
    END,
    max_issued,
    seq_value;
END;
$$;


-- ############################################################################
-- SECTION 4 — GRANTS
-- ############################################################################
--
-- REVOKE before GRANT. An additive-only block is defeated by any prior
-- `GRANT ALL ON ALL TABLES` — which is the first thing most people run when a
-- query fails with "permission denied", and which several hosting guides
-- recommend outright. (Found the hard way in Phase 11.)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON invoices      FROM ordence_app;
    REVOKE ALL ON invoice_lines FROM ordence_app;

    -- No DELETE on either. An invoice is a document the customer holds a
    -- copy of; the correction for a bad one is a void or a credit note,
    -- never a deletion. Lines keep DELETE so a DRAFT can be rebuilt — the
    -- trigger from Phase 11 already refuses it once issued.
    GRANT SELECT, INSERT, UPDATE ON invoices TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_lines TO ordence_app;

    GRANT USAGE ON SEQUENCE invoice_number_seq TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — VERIFICATION
-- ############################################################################

-- Check 1 — ⭐ the duplicate-period index exists.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'invoices' AND indexname = 'invoices_one_per_period'
  ) THEN 'PASS: a subscription period cannot be invoiced twice'
  ELSE  '*** FAIL: invoices_one_per_period IS MISSING — a retried webhook '
        'WILL issue a second invoice for a period already billed ***'
  END AS check_one_invoice_per_period;


-- Check 2 — no period is currently double-invoiced.
-- Belt and braces: if the index was created after data existed, duplicates
-- could predate it.
SELECT
  subscription_id, period_start, period_end, count(*) AS invoices_issued,
  '*** FAIL — this period has been invoiced more than once ***' AS verdict
FROM invoices
WHERE subscription_id IS NOT NULL AND period_start IS NOT NULL AND status <> 'void'
GROUP BY subscription_id, period_start, period_end
HAVING count(*) > 1;
-- (No rows returned = PASS.)


-- Check 3 — the empty-invoice guard is installed and enabled.
SELECT
  tgname AS trigger_name,
  CASE WHEN tgenabled = 'O' THEN 'PASS (enabled)'
       ELSE '*** FAIL — trigger disabled: ' || tgenabled::text || ' ***' END AS verdict
FROM pg_trigger
WHERE tgrelid = 'invoices'::regclass
  AND tgname = 'invoices_require_lines'
  AND NOT tgisinternal;


-- Check 4 — no issued invoice is empty.
SELECT
  i.invoice_number,
  '*** FAIL — issued with no line items ***' AS verdict
FROM invoices i
LEFT JOIN invoice_lines l ON l.invoice_id = i.id
WHERE i.status <> 'draft'
GROUP BY i.id, i.invoice_number
HAVING count(l.id) = 0;
-- (No rows returned = PASS.)


-- Check 5 — the number sequence has not been wound back.
SELECT * FROM invoice_sequence_is_sane();


-- Check 6 — every invoice's arithmetic still balances.
SELECT
  invoice_number,
  '*** FAIL — total does not equal its components ***' AS verdict
FROM invoices
WHERE total_minor <> subtotal_minor - discount_minor + cgst_minor + sgst_minor + igst_minor;
-- (No rows returned = PASS.)


-- Check 7 — every issued invoice's LINES sum to its subtotal.
--
-- The header check constraint proves the header is internally consistent. It
-- says nothing about whether the header agrees with the itemisation beneath
-- it — and a customer reading the document adds up the lines.
SELECT
  i.invoice_number,
  i.subtotal_minor AS header_subtotal,
  coalesce(sum(l.amount_minor), 0) AS line_total,
  '*** FAIL — the lines do not add up to the subtotal ***' AS verdict
FROM invoices i
JOIN invoice_lines l ON l.invoice_id = i.id
WHERE i.status <> 'draft'
GROUP BY i.id, i.invoice_number, i.subtotal_minor
HAVING coalesce(sum(l.amount_minor), 0) <> i.subtotal_minor;
-- (No rows returned = PASS.)


-- Check 8 — the app cannot DELETE an invoice.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN NOT has_table_privilege('ordence_app', 'invoices', 'DELETE')
      THEN 'PASS: invoices can be voided but never deleted'
    ELSE '*** FAIL: the application role can DELETE an invoice ***'
  END AS check_invoice_delete_privilege;
