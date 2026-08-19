-- ############################################################################
-- 0125 — SUPPORT CAN DELETE A BOOKING, A PAYSLIP OR A BANK RECONCILIATION
--        WHILE IMPERSONATING (Infra wave 13 / v1.80.0-alpha)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- `no_delete_under_impersonation` is attached to **48 of 303** tenant-scoped
-- tables. The other 255 have no guard, so an Ordence engineer inside an
-- impersonation session can DELETE from them, and the refusal 0014 wrote for
-- exactly that case never fires:
--
--     'Deletion is not permitted while impersonating a customer (session %).
--      Support may diagnose; only the customer may destroy their own records.'
--
-- Named, unguarded, and squarely inside 0014's own stated scope of "customer
-- records and money": `bookings`, `units`, `projects`, `leads`,
-- `payment_milestones`, `sales_invoices`, `customer_receipts`, `employees`,
-- `payslips`, `payroll_runs`, `leave_ledger`, `bank_accounts`,
-- `bank_reconciliations`, `fixed_assets`, `purchase_orders`, `goods_receipts`,
-- `vendor_payments`, `stock_write_offs`, `legal_matters`, `legal_hearings`,
-- `client_account_entries`, `vault_secrets`, `ai_provider_credentials`,
-- `mcp_tokens`, `data_principal_requests`, `personal_data_breaches`, and more.
--
-- HOW IT HAPPENED
-- ---------------
-- 0014 attaches the trigger by looping over a HARD-CODED array of 19 names.
-- Five later module files copied that block for their own tables , 0023, 0024,
-- 0025, 0026, 0027 , and then it stopped. Nothing after 0027 carries it, and
-- roughly 90 module files have shipped since.
--
-- ⚠️ AND 0014'S OWN VERIFICATION IS A FLOOR, NOT A CONTROL:
--
--     CASE WHEN count(*) FILTER (WHERE tgname = 'no_delete_under_impersonation') >= 10
--          THEN 'PASS: the impersonation delete guard is installed'
--
-- 48 is greater than 10, so it prints PASS. This is character for character
-- the antipattern `scripts/check-rls-coverage.mjs` was written to eliminate
-- ("only 12 tables had RLS and the CI step tested `>= 100`"), still live in a
-- different file.
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. Declares the exclusions ONCE, as a table with a written reason per row,
--      the same shape 0122 used for the change log.
--   2. Adds `attach_impersonation_guards()`, which any later module migration
--      should CALL rather than copying 0014's block a seventh time.
--   3. Runs it.
--   4. RAISES if any tenant-scoped table is still unguarded. Not a floor.
--
-- ⚠️ WHY THE EXCLUSIONS ARE NARROW. The guard refuses DELETE only while an
-- impersonation session is active. For a normal tenant session it is a no-op.
-- So "this table needs deletes to work" is NOT a reason to exclude it , the
-- customer's own deletes are unaffected. The only real reasons are: the table
-- is platform-owned rather than customer-owned, or a support engineer
-- genuinely must be able to clear it as part of diagnosis.
--
-- IS THERE DATA LOSS?  No. Triggers and one new platform table.
--
-- RUN ORDER
-- ---------
-- Last. It guards whatever exists when it runs, so later files must call
-- `attach_impersonation_guards()` themselves. SQL FIRST, then the code.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent.
--
-- RLS
-- ---
-- `impersonation_guard_exclusions` is platform data describing the SCHEMA. No
-- tenant_id, no RLS, SELECT only for the application role.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — THE EXCLUSIONS, ONCE, WITH A REASON EACH
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.impersonation_guard_exclusions (
  table_name  text PRIMARY KEY,
  reason      text NOT NULL,
  category    text NOT NULL CHECK (category IN ('platform-owned', 'support-must-clear', 'derived')),
  declared_in text NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.impersonation_guard_exclusions IS
  'Tenant-scoped tables that deliberately allow DELETE while a support '
  'engineer is impersonating. Read by attach_impersonation_guards(). The '
  'guard is a no-op for ordinary tenant sessions, so "the customer needs to '
  'delete these" is not a reason to appear here.';

INSERT INTO public.impersonation_guard_exclusions (table_name, reason, category, declared_in)
VALUES
  ('change_log',
   'The sync feed is derived from the tables it mirrors. Pruning synced rows is administrative maintenance, not destruction of a customer record.',
   'derived', '0125'),
  ('usage_counters',
   'Counters, not content. They are derived from metered events and are reconciled rather than authored.',
   'derived', '0125'),
  ('usage_levels',
   'Counters, not content. Same reasoning as usage_counters.',
   'derived', '0125'),
  ('platform_impersonation_sessions',
   'Platform-owned evidence about support activity, and already protected by prevent_impersonation_tamper() which refuses DELETE outright, for everyone.',
   'platform-owned', '0125'),
  ('platform_tenant_flags',
   'Platform-owned. Written by staff under withPlatformScope, never by the customer.',
   'platform-owned', '0125'),
  ('platform_action_log',
   'Platform-owned append-only evidence of what staff did. Protected separately.',
   'platform-owned', '0125'),
  ('tenant_support_consents',
   'Platform-owned record of the consent that permits the support session in the first place.',
   'platform-owned', '0125'),
  ('tenant_health_events',
   'Platform-owned observations about a workspace. The workspace is the subject, not the author.',
   'platform-owned', '0125'),
  ('security_events',
   'Already refuses DELETE for everyone through the append-only trigger, which is a stronger control than this one.',
   'platform-owned', '0125'),
  ('error_events',
   'Platform telemetry, append-only, and subject to its own retention sweep.',
   'platform-owned', '0125'),
  ('web_vital_events',
   'Platform telemetry, append-only, and subject to its own retention sweep.',
   'platform-owned', '0125'),
  ('audit_logs',
   'Already refuses DELETE for everyone through the append-only trigger.',
   'platform-owned', '0125'),
  ('permission_denials',
   'Append-only evidence with its own guard.',
   'platform-owned', '0125')
ON CONFLICT (table_name) DO NOTHING;


-- ----------------------------------------------------------------------------
-- SECTION 2 — THE SWEEP
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.attach_impersonation_guards()
RETURNS TABLE (table_name text, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name AS tbl
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      LEFT JOIN pg_trigger tg
        ON tg.tgrelid = (quote_ident(c.table_name))::regclass
       AND tg.tgname  = 'no_delete_under_impersonation'
       AND NOT tg.tgisinternal
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'tenant_id'
       AND t.table_type   = 'BASE TABLE'
       AND tg.tgname IS NULL
       AND c.table_name NOT IN (SELECT e.table_name FROM impersonation_guard_exclusions e)
     ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'CREATE TRIGGER no_delete_under_impersonation BEFORE DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION refuse_delete_under_impersonation()',
      r.tbl
    );
    table_name := r.tbl;
    action     := 'guarded';
    RETURN NEXT;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.attach_impersonation_guards() IS
  'Attaches no_delete_under_impersonation to every tenant-scoped base table '
  'that does not have it and is not in impersonation_guard_exclusions. '
  'Idempotent. A module migration that creates tenant tables should CALL THIS '
  'rather than copying 0014''s hard-coded array, which is how the guard came '
  'to cover 48 tables out of 303.';

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.attach_impersonation_guards() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON FUNCTION public.attach_impersonation_guards() FROM ordence_app;
    REVOKE ALL ON impersonation_guard_exclusions FROM ordence_app;
    GRANT SELECT ON impersonation_guard_exclusions TO ordence_app;
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 3 — RUN IT
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  guarded text[];
BEGIN
  SELECT coalesce(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[])
    INTO guarded
    FROM attach_impersonation_guards() t;

  RAISE NOTICE '0125: attached the impersonation delete guard to % table(s).',
    cardinality(guarded);
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 4 — VERIFY EXHAUSTIVELY. NOT A FLOOR.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT coalesce(array_agg(c.table_name ORDER BY c.table_name), ARRAY[]::text[])
    INTO missing
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    LEFT JOIN pg_trigger tg
      ON tg.tgrelid = (quote_ident(c.table_name))::regclass
     AND tg.tgname  = 'no_delete_under_impersonation'
     AND NOT tg.tgisinternal
   WHERE c.table_schema = 'public'
     AND c.column_name  = 'tenant_id'
     AND t.table_type   = 'BASE TABLE'
     AND tg.tgname IS NULL
     AND c.table_name NOT IN (SELECT e.table_name FROM impersonation_guard_exclusions e);

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION
      '0125 FAILED: % tenant-scoped table(s) can still be DELETED from during '
      'an impersonation session: %. Either guard them or add them to '
      'impersonation_guard_exclusions WITH A REASON.',
      cardinality(missing), array_to_string(missing, ', ')
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE
    '0125 PASS: every tenant-scoped table refuses DELETE under impersonation, '
    'or is excluded with a stated reason.';
END
$$;
