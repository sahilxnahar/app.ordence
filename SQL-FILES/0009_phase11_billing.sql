-- ============================================================================
-- Ordence — Phase 11: Billing Foundation
-- Version: v0.11.0-alpha
--
-- Run AFTER `npx drizzle-kit push` has created the six billing tables:
--   plans, subscriptions, invoices, invoice_lines, payment_events,
--   payment_methods
--
-- Contents:
--   1. Row-Level Security (5 tenant-scoped tables; `plans` deliberately not)
--   2. payment_events is APPEND-ONLY
--   3. Invoice numbering — a database sequence, not application logic
--   4. Immutability of issued invoices
--   5. The one-live-subscription guarantee
--   6. Grants
--   7. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Billing is the first subsystem in this platform where a bug costs REAL
-- MONEY in a direction that cannot be undone by a support ticket. Charging a
-- customer twice is a refund, an apology and a chargeback risk. Failing to
-- charge them is revenue you never learn you lost.
--
-- Three guarantees below are enforced by the DATABASE rather than by the
-- application, because the application will be rewritten several times and
-- these must survive it:
--
--   • A duplicate provider event CANNOT be recorded twice.
--     (UNIQUE index created by Drizzle; asserted in Section 7.)
--   • A payment event, once written, CANNOT be altered.        (Section 2)
--   • An issued invoice's money columns CANNOT be altered.     (Section 4)
--
-- The application also checks all three. That is not redundancy for its own
-- sake — the app check gives a good error message, the database check is the
-- one that is actually true.
-- ============================================================================


-- The tenant-context accessor. Idempotent; also created by earlier phases.
CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on for ordinary roles.
-- FORCE additionally applies them to the table OWNER, which is usually the
-- role the application connects as. Without FORCE the isolation is decorative.

-- ---------------------------------------------------------------------------
-- `plans` IS NOT PROTECTED, AND THAT IS DELIBERATE
-- ---------------------------------------------------------------------------
-- It is platform catalogue data: the same "Advanced ₹4,999/mo" row is read by
-- every tenant, exactly like `permissions` in Phase 1. It contains no customer
-- data. Adding a tenant_id to it in order to have something to filter on would
-- mean duplicating the catalogue per tenant, which is worse in every respect.
--
-- Writes are restricted by GRANT (Section 6), not by RLS — tenants have no
-- INSERT/UPDATE/DELETE on it at all.
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_tenant_isolation ON subscriptions;
CREATE POLICY subscriptions_tenant_isolation ON subscriptions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoices_tenant_isolation ON invoices;
CREATE POLICY invoices_tenant_isolation ON invoices
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_lines_tenant_isolation ON invoice_lines;
CREATE POLICY invoice_lines_tenant_isolation ON invoice_lines
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_methods_tenant_isolation ON payment_methods;
CREATE POLICY payment_methods_tenant_isolation ON payment_methods
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ---------------------------------------------------------------------------
-- `payment_events` — THE ONE POLICY WITH A NULL ALLOWANCE
-- ---------------------------------------------------------------------------
-- Every other tenant-scoped table in this platform has a NOT NULL tenant_id
-- and a policy that is a plain equality. This one is different, and the
-- difference is worth stating precisely because it looks like a hole.
--
-- A webhook can arrive that maps to NO tenant: test-mode traffic, an object
-- created by hand in the provider's dashboard, a customer migrated from
-- another system. Dropping those events would be the worst option — an
-- unexplained payment webhook is exactly the one you will want to read six
-- months from now, during a dispute.
--
-- So orphan events are recorded with tenant_id IS NULL. The policy permits
-- READING them only when NO tenant context is set — i.e. from the
-- platform-scoped connection used by super-admin tooling. A tenant session,
-- which always has app.current_tenant_id populated, sees exactly its own rows
-- and never an orphan.
--
--   tenant session (context = A)  ->  rows where tenant_id = A
--   platform scope (context NULL) ->  rows where tenant_id IS NULL
--
-- Note what this does NOT do: it does not let a tenant see another tenant's
-- events, and it does not let a tenant see orphans. Verified in Section 7 and
-- in tests/security/billing-isolation.test.ts.
-- ---------------------------------------------------------------------------

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_events_tenant_isolation ON payment_events;
CREATE POLICY payment_events_tenant_isolation ON payment_events
  USING (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  )
  WITH CHECK (
    (tenant_id = app_current_tenant_id())
    OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  );


-- ############################################################################
-- SECTION 2 — payment_events IS APPEND-ONLY
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   `payment_events` is the evidence table. If a customer disputes a charge,
--   or a regulator asks how a subscription came to be in a given state, this
--   is the record that answers. A record that can be edited answers nothing —
--   it only shows what someone was willing to say.
--
--   The concrete attack is narrow and realistic: an engineer with database
--   access "fixing" a bad reconciliation by UPDATEing an event, rather than
--   inserting a correcting one. The history then describes a past that did
--   not happen, and the bug that caused it becomes invisible.
--
-- THE FIX:
--   UPDATE and DELETE are refused outright by a trigger, exactly as for
--   `audit_logs` (Phase 1) and `contract_signatures` (Phase 9). Corrections
--   are made by INSERTING a new event, which is what an append-only log is
--   for.
--
--   SQLSTATE 42501 (insufficient_privilege) is raised deliberately so the
--   application can distinguish this from an ordinary constraint failure.

CREATE OR REPLACE FUNCTION prevent_payment_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'payment_events is append-only. % is not permitted on payment evidence. '
    'Record a correcting event instead.',
    TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS payment_events_no_update ON payment_events;
CREATE TRIGGER payment_events_no_update
  BEFORE UPDATE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_event_mutation();

DROP TRIGGER IF EXISTS payment_events_no_delete ON payment_events;
CREATE TRIGGER payment_events_no_delete
  BEFORE DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_event_mutation();


-- ############################################################################
-- SECTION 3 — INVOICE NUMBERING
-- ############################################################################
--
-- WHY A DATABASE SEQUENCE AND NOT `SELECT MAX(number) + 1`
--
--   Two concurrent invoice creations reading MAX at the same moment both get
--   the same answer, and one of them fails on the unique index — or worse,
--   succeeds against a differently-shaped number. On a serverless platform
--   where a hundred function instances can exist simultaneously, this is not
--   a theoretical race.
--
--   It is also not solvable with an application-level lock, because the
--   instances share nothing.
--
-- WHY THE SEQUENCE IS GLOBAL AND NOT PER-TENANT
--
--   These are invoices WE issue to OUR customers. There is one issuing entity
--   — Ordence — so there is one series. Under Indian GST rules an
--   invoice series must be consecutive and unique for the financial year
--   across the whole registration, not per customer.
--
--   A gap in the series is a question an auditor is entitled to ask, and
--   sequences do produce gaps on rollback. That is accepted deliberately: a
--   gap you can explain ("transaction rolled back") is far better than a
--   duplicate number, which is a compliance failure.
--
-- FINANCIAL YEAR
--
--   India's FY runs April–March, so an invoice dated 2 April 2026 belongs to
--   FY 2026-27 and one dated 30 March 2026 belongs to FY 2025-26. The label is
--   computed rather than stored so it cannot drift from the date.

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

CREATE OR REPLACE FUNCTION indian_financial_year(at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN EXTRACT(MONTH FROM at AT TIME ZONE 'Asia/Kolkata') >= 4
      THEN to_char(at AT TIME ZONE 'Asia/Kolkata', 'YYYY') || '-' ||
           to_char((at AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 year', 'YY')
    ELSE to_char((at AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 year', 'YYYY') || '-' ||
         to_char(at AT TIME ZONE 'Asia/Kolkata', 'YY')
  END;
$$;

CREATE OR REPLACE FUNCTION next_invoice_number(prefix text DEFAULT 'AH')
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  seq_value bigint;
BEGIN
  -- nextval is atomic and never returns the same value twice, even to
  -- concurrent transactions, and it is NOT rolled back — which is precisely
  -- the property that makes duplicates impossible.
  seq_value := nextval('invoice_number_seq');

  RETURN prefix || '/' || indian_financial_year(now()) || '/' ||
         lpad(seq_value::text, 6, '0');
END;
$$;


-- ############################################################################
-- SECTION 4 — AN ISSUED INVOICE'S MONEY IS IMMUTABLE
-- ############################################################################
--
-- THE HOLE THIS CLOSES:
--   Once an invoice has been issued to a customer, they hold a copy. Changing
--   the amounts on our side then produces two documents with the same number
--   and different totals — which is indistinguishable, after the fact, from
--   fraud. Under GST rules a revision is a CREDIT NOTE or a fresh invoice,
--   never an edit.
--
--   A draft invoice is a different thing entirely and remains fully editable.
--
-- WHAT MAY STILL CHANGE ON AN ISSUED INVOICE:
--   status, amount_paid_minor, paid_at, voided_at, hosted_invoice_url,
--   notes, metadata, updated_at.
--   Payment arriving is not a change to the bill; it is a change to its state.
--
-- WHAT MAY NOT:
--   Every amount column, the invoice number, the tenant, the tax identity.

CREATE OR REPLACE FUNCTION prevent_issued_invoice_amendment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Drafts are working documents.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    RAISE EXCEPTION
      'Invoice number cannot be changed once issued (invoice %).', OLD.invoice_number
      USING ERRCODE = '42501';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'An issued invoice cannot be moved to another tenant (invoice %).', OLD.invoice_number
      USING ERRCODE = '42501';
  END IF;

  IF NEW.subtotal_minor  IS DISTINCT FROM OLD.subtotal_minor
     OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
     OR NEW.cgst_minor     IS DISTINCT FROM OLD.cgst_minor
     OR NEW.sgst_minor     IS DISTINCT FROM OLD.sgst_minor
     OR NEW.igst_minor     IS DISTINCT FROM OLD.igst_minor
     OR NEW.total_minor    IS DISTINCT FROM OLD.total_minor
     OR NEW.currency       IS DISTINCT FROM OLD.currency
  THEN
    RAISE EXCEPTION
      'Invoice % has been issued. Amounts are fixed — raise a credit note or a new invoice.',
      OLD.invoice_number
      USING ERRCODE = '42501';
  END IF;

  IF NEW.customer_gstin IS DISTINCT FROM OLD.customer_gstin
     OR NEW.place_of_supply_code IS DISTINCT FROM OLD.place_of_supply_code
  THEN
    RAISE EXCEPTION
      'Tax identity on issued invoice % is fixed at the moment of issue.',
      OLD.invoice_number
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_issued_immutable ON invoices;
CREATE TRIGGER invoices_issued_immutable
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION prevent_issued_invoice_amendment();


-- ---------------------------------------------------------------------------
-- Lines of an issued invoice cannot be added, changed or removed.
--
-- Without this, the trigger above is trivially bypassed: leave the header
-- totals alone and rewrite the line items. The customer's copy and ours would
-- then agree on the total and disagree on what was bought.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_issued_invoice_line_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  parent_id uuid;
BEGIN
  parent_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT status INTO parent_status FROM invoices WHERE id = parent_id;

  -- Parent already gone (cascade delete of a draft) — nothing to protect.
  IF parent_status IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION
      'Invoice % has been issued; its line items are fixed.', parent_id
      USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS invoice_lines_issued_immutable ON invoice_lines;
CREATE TRIGGER invoice_lines_issued_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_issued_invoice_line_change();


-- ############################################################################
-- SECTION 5 — THE ONE-LIVE-SUBSCRIPTION GUARANTEE
-- ############################################################################
--
-- Drizzle creates the partial unique index. This section documents WHY it is
-- load-bearing and asserts that it exists, because an index silently dropped
-- by `drizzle-kit push` would remove a double-billing guarantee with no
-- symptom whatsoever until an invoice run.
--
-- THE SCENARIO IT PREVENTS:
--   An upgrade creates a new subscription. The old one's cancellation fails,
--   or the webhook confirming it never arrives. The tenant now has two live
--   subscriptions, and next month both renew. The customer is charged twice,
--   notices, and asks why — and the honest answer is "our code has a race".
--
-- With the index, the second INSERT fails immediately and the upgrade is
-- rejected. A failed upgrade is an annoyance; a double charge is a refund and
-- a lost customer.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'subscriptions'
      AND indexname = 'subscriptions_one_live_per_tenant'
  ) THEN
    RAISE EXCEPTION
      'The partial unique index subscriptions_one_live_per_tenant is MISSING. '
      'Without it a tenant can hold two live subscriptions and be billed twice. '
      'Re-run `npm run db:push` before continuing.';
  END IF;
END
$$;


-- ---------------------------------------------------------------------------
-- A subscription's tenant is fixed for life.
--
-- Moving a subscription between tenants would move its entire billing history
-- with it — invoices, payment events, the lot — and leave the original
-- tenant's records referring to something that is no longer theirs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_subscription_tenant_move()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION
      'A subscription cannot be reassigned to a different tenant.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_tenant_fixed ON subscriptions;
CREATE TRIGGER subscriptions_tenant_fixed
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION prevent_subscription_tenant_move();


-- ############################################################################
-- SECTION 6 — GRANTS
-- ############################################################################
--
-- The application role reads and writes tenant billing data, subject to the
-- policies above. It may READ the plan catalogue and may NOT write it —
-- a tenant altering the price of their own plan is the most obvious attack
-- on a billing system, and no RLS policy is needed to stop it if the GRANT
-- never existed.
--
-- Replace `ordence_app` with the role your application actually connects as.
-- On Neon this is usually the database owner; on a hardened deployment it
-- should be a dedicated non-owner role, which is what makes FORCE meaningful.

-- ---------------------------------------------------------------------------
-- ⚠️ REVOKE FIRST. THIS IS NOT DEFENSIVE PADDING.
-- ---------------------------------------------------------------------------
-- A GRANT block that only ever ADDS privileges is worthless as a restriction.
-- If anyone has ever run `GRANT ALL ON ALL TABLES IN SCHEMA public TO
-- ordence_app` — which is the first thing most people do when a query fails
-- with "permission denied", and which several hosting providers' setup
-- guides recommend outright — then the application role already holds UPDATE
-- on `plans` and DELETE on `payment_events`, and every GRANT below is a
-- no-op that changes nothing.
--
-- The restriction is only real if it is stated as a restriction. So the two
-- tables whose privileges are load-bearing are revoked to nothing first and
-- then granted exactly what they need.
--
-- Found while building a fresh test database for this phase: the baseline
-- grant had to be applied for the earlier phases' tests to run at all, which
-- is precisely the situation that would have silently defeated this section.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON plans          FROM ordence_app;
    REVOKE ALL ON payment_events FROM ordence_app;
    REVOKE ALL ON subscriptions  FROM ordence_app;
    REVOKE ALL ON invoices       FROM ordence_app;

    GRANT SELECT ON plans TO ordence_app;

    -- NO DELETE on either. Both are financial history and are SOFT-deleted
    -- (`deleted_at`), so the privilege has no legitimate use — while a hard
    -- DELETE of a subscription would orphan every invoice that references
    -- it, and a hard DELETE of an invoice would remove a document a
    -- customer is holding a copy of.
    GRANT SELECT, INSERT, UPDATE ON subscriptions   TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON invoices        TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_lines TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment_methods TO ordence_app;

    -- INSERT and SELECT only. No UPDATE, no DELETE — belt and braces
    -- alongside the trigger in Section 2. If the trigger were ever dropped,
    -- this still refuses.
    GRANT SELECT, INSERT ON payment_events TO ordence_app;

    GRANT USAGE ON SEQUENCE invoice_number_seq TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 7 — VERIFICATION
-- ############################################################################
--
-- Every check below prints a row. Read them. A silent success is not the same
-- as a success, and the whole point of Phase 10's `db:verify` lesson is that
-- these failures have no other symptom.

-- Check 1 — RLS is enabled AND forced on all five tenant-scoped tables.
SELECT
  c.relname                                        AS table_name,
  c.relrowsecurity                                 AS rls_enabled,
  c.relforcerowsecurity                            AS rls_forced,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS' ELSE '*** FAIL ***' END         AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('subscriptions','invoices','invoice_lines',
                    'payment_events','payment_methods')
ORDER BY c.relname;


-- Check 2 — every policy carries a WITH CHECK clause.
--
-- A policy with only USING filters what you can READ but permits INSERTing a
-- row belonging to another tenant. That is a write-side leak and it is easy to
-- miss because reads look correct.
SELECT
  tablename,
  policyname,
  CASE WHEN with_check IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — reads filtered, writes are not ***' END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('subscriptions','invoices','invoice_lines',
                    'payment_events','payment_methods')
ORDER BY tablename;


-- Check 3 — the append-only triggers exist on payment_events.
SELECT
  tgname AS trigger_name,
  CASE WHEN tgenabled = 'O' THEN 'PASS (enabled)'
       -- `tgenabled` is PostgreSQL's internal "char" type, not text. Without
       -- the cast this line fails with `operator is not unique: unknown || "char"`.
       ELSE '*** FAIL — trigger is disabled: ' || tgenabled::text || ' ***' END AS verdict
FROM pg_trigger
WHERE tgrelid = 'payment_events'::regclass
  AND NOT tgisinternal
ORDER BY tgname;


-- Check 4 — the idempotency index exists.
--
-- ⭐ THIS IS THE MOST IMPORTANT ROW IN THIS FILE.
-- Without this index a retried webhook is processed twice, and a customer is
-- charged twice, and nothing anywhere reports a problem.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'payment_events'
      AND indexname = 'payment_events_provider_event_unique'
  ) THEN 'PASS: webhook replay protection is in place'
  ELSE  '*** FAIL: payment_events_provider_event_unique IS MISSING — '
        'duplicate webhooks WILL be processed twice ***'
  END AS verdict;


-- Check 5 — the one-live-subscription index exists.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'subscriptions'
      AND indexname = 'subscriptions_one_live_per_tenant'
  ) THEN 'PASS: a tenant cannot hold two live subscriptions'
  ELSE  '*** FAIL: subscriptions_one_live_per_tenant IS MISSING — '
        'double billing is possible ***'
  END AS verdict;


-- Check 6 — no tenant currently holds two live subscriptions.
--
-- Belt and braces: the index makes this impossible going forward, but if the
-- index was created AFTER data existed, duplicates could predate it.
SELECT
  tenant_id,
  count(*) AS live_subscriptions,
  '*** FAIL — this tenant will be billed more than once ***' AS verdict
FROM subscriptions
WHERE status IN ('trialing','active','past_due','unpaid','paused')
  AND deleted_at IS NULL
GROUP BY tenant_id
HAVING count(*) > 1;
-- (No rows returned = PASS.)


-- Check 7 — every invoice's arithmetic balances.
--
-- The CHECK constraint makes a bad row impossible to insert, so this should
-- always return zero rows. It is here because a constraint dropped by
-- `drizzle-kit push` would be silent, and an invoice whose total does not
-- equal its parts is a document you may have to defend in front of someone.
SELECT
  invoice_number,
  subtotal_minor, discount_minor, cgst_minor, sgst_minor, igst_minor, total_minor,
  '*** FAIL — total does not equal its components ***' AS verdict
FROM invoices
WHERE total_minor <> subtotal_minor - discount_minor + cgst_minor + sgst_minor + igst_minor;
-- (No rows returned = PASS.)


-- Check 8 — the invoice number generator works and is unique.
SELECT
  next_invoice_number('TEST') AS sample_1,
  next_invoice_number('TEST') AS sample_2,
  CASE WHEN next_invoice_number('TEST') <> next_invoice_number('TEST')
       THEN 'PASS: consecutive calls differ'
       ELSE '*** FAIL: the sequence is returning duplicates ***' END AS verdict;


-- Check 9 — `plans` is readable but not writable by the app role.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIPPED: role ordence_app does not exist in this database'
    WHEN has_table_privilege('ordence_app', 'plans', 'SELECT')
     AND NOT has_table_privilege('ordence_app', 'plans', 'UPDATE')
      THEN 'PASS: the app can read the plan catalogue but not reprice it'
    ELSE '*** FAIL: the application role can WRITE the plan catalogue ***'
  END AS verdict;
