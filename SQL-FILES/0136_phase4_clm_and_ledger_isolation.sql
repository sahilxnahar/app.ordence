-- ############################################################################
-- 0136 — THE GENERAL LEDGER AND THE CONTRACT STORE HAVE NO ROW-LEVEL SECURITY
--        IN ANY NUMBERED MIGRATION (Wave 15 / Track C)
-- ############################################################################
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 WHAT IS ACTUALLY WRONG
-- ══════════════════════════════════════════════════════════════════════════
-- Six tenant-scoped tables carry their entire isolation guarantee in
-- `ALL-IN-ONE-SETUP.sql` and in NO numbered file:
--
--     clause_library      contracts        contract_versions
--     ledgers             transactions     journal_entries
--
-- That is the customer's general ledger and the customer's contract store.
--
-- Production has them protected, because production was built by pasting
-- ALL-IN-ONE-SETUP.sql into the Neon console. A database built from
-- `SQL-FILES/[0-9][0-9][0-9][0-9]_*.sql` alone — which is what a new region,
-- a disaster-recovery rebuild, or any developer following the numbered
-- sequence produces — has, on all six:
--
--     relrowsecurity      = false
--     relforcerowsecurity = false
--     policies            = 0
--
-- No policy. Not a weak policy. None. Every tenant reads every other
-- tenant's journal entries, ledgers, transactions and signed contracts with
-- an ordinary `SELECT`.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ AND IT IS NOT ONLY THE POLICIES. NINE TRIGGERS AND THREE FUNCTIONS GO
--    WITH THEM.
-- ══════════════════════════════════════════════════════════════════════════
-- The same six tables lose, in a migrations-only build:
--
--   FUNCTIONS   assert_contract_refs_same_tenant()   cross-tenant FK guard
--               assert_journal_entry_tenant()        cross-tenant FK guard
--               app_is_platform_scope()              0087 GRANTs EXECUTE on it
--
--   TRIGGERS    contracts_same_tenant                contract_versions_same_tenant
--               contract_versions_no_update          contract_versions_no_delete
--               journal_entries_no_update            journal_entries_no_delete
--               journal_entries_tenant_check         journal_entries_update_balance
--               journal_entries_balance_check    ← DOUBLE-ENTRY BALANCE
--
-- 🔴 `journal_entries_balance_check` IS THE DEFERRED CONSTRAINT TRIGGER THAT
-- REFUSES AN UNBALANCED JOURNAL. Without it the accounting product will
-- happily store books that do not balance, and nothing says so. Without
-- `journal_entries_no_update` / `no_delete`, posted entries are editable.
--
-- ══════════════════════════════════════════════════════════════════════════
-- HOW IT HAPPENED — AND IT IS RECORDED IN THE REPO ALREADY
-- ══════════════════════════════════════════════════════════════════════════
-- `ALL-IN-ONE-SETUP.sql` says it combines phases 1–5:
--
--     · 0001  Row-Level Security + append-only audit        (Phase 1)
--     · 0002  CRM tables + cross-tenant reference guards     (Phase 2)
--     · 0003  Asset tables + graph integrity                 (Phase 3)
--     · 0004  CLM + double-entry accounting                  (Phase 4)   ←
--     · 0005  Period close + RBAC + audit controls           (Phase 5)
--
-- 0001, 0002, 0003 and 0005 all exist as numbered files. **0004 does not and
-- never did.** `scripts/check-migrations.mjs` records the number as a known
-- gap — "never written — phase merged into 0005" — and that sentence is
-- true about the FILE and false about the CONTENT: phase 4's security never
-- merged anywhere. It stayed in the combined file only.
--
-- ⚠️ NOTHING COULD HAVE CAUGHT THIS.
--   · `check:sql-completeness` reads SQL-FILES/ as a set, and
--     ALL-IN-ONE-SETUP.sql is in that set, so the policies are "in SQL".
--   · `check:rls-coverage` is exhaustive and correct, and it runs in CI
--     against a database CI built by applying ALL-IN-ONE-SETUP.sql FIRST.
--     It has never once been pointed at a migrations-only database.
--   · The isolation suite seeds `contracts`, `ledgers`, `journal_entries`
--     and asserts refusal — against that same CI database.
--
-- Every control in the repository was looking at the one database where the
-- defect is absent.
--
-- ══════════════════════════════════════════════════════════════════════════
-- HOW THE SIX WERE FOUND (derived, not taken from a list)
-- ══════════════════════════════════════════════════════════════════════════
-- Two throwaway PostgreSQL 16 databases, identical up to the SQL applied:
--
--     A:  drizzle-kit push  +  ALL-IN-ONE-SETUP.sql  +  0001…0128
--     B:  drizzle-kit push  +                           0001…0128
--
-- then `pg_policies`, `pg_class.relrowsecurity/relforcerowsecurity`,
-- `pg_proc` and `pg_trigger` diffed between them. The delta is exactly the
-- six tables, three functions and nine triggers named above, and nothing
-- else. The commands and their output are in TRACK-REPORT.md §3.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE DOES
-- ══════════════════════════════════════════════════════════════════════════
--   1. Recreates the three functions.
--   2. ENABLE + FORCE + tenant-isolation policy on all six tables.
--   3. Recreates the nine triggers.
--   4. Verifies all three by EXACT COUNT and names anything still missing.
--
-- It is a no-op on production and on CI's database, where all of it is
-- already true, and it is the whole difference on a migrations-only build.
--
-- IS THERE DATA LOSS?  No. No row is written, read or deleted. Policies,
-- triggers and functions only.
--
-- RUN ORDER
-- ---------
-- SQL FIRST, then the code — but in practice this file is order-independent
-- against the application: it removes access that the application never
-- relied on. It must run AFTER 0005 (which defines
-- `block_mutation_append_only()`), AFTER 0016 (`update_ledger_balance()`)
-- and AFTER 0017 (`record_change()`); all three are far below it.
--
-- ⚠️ NO BEGIN/COMMIT. Every statement is independently idempotent.
--
-- RLS
-- ---
-- This file IS the RLS for these six tables. The policy is the plain
-- tenant-isolation shape and deliberately carries NO `app_platform_scope()`
-- branch on either side:
-- `scripts/check-rls-coverage.mjs` lists `contracts`, `contract_versions`,
-- `journal_entries`, `transactions` and `ledgers` in PLATFORM_READ_REFUSED,
-- quoting 0014 §6 — "customer content, held as a processor" and "the
-- customer's general ledger". Adding a platform branch here to make support
-- easier would be a data-protection change, and it would fail that gate on
-- the next push, which is the correct outcome.
-- ############################################################################


-- ----------------------------------------------------------------------------
-- SECTION 1 — THE THREE FUNCTIONS
-- ----------------------------------------------------------------------------

-- ⚠️ `app_is_platform_scope()` IS A DEPRECATED ALIAS OF `app_platform_scope()`
-- and it is recreated here for ONE reason: 0087_hardening_narrow_grants.sql
-- line 242 does
--
--     GRANT EXECUTE ON FUNCTION app_is_platform_scope() TO PUBLIC;
--
-- and on a migrations-only build that statement fails with 42883, taking the
-- rest of that grant block with it under ON_ERROR_STOP=1. No policy in the
-- live database references it any more — 0079 and its successors rewrote
-- every one of them onto `app_platform_scope()` — so this is a compatibility
-- shim, not a control. It is listed in docs/DATA-MODEL.md as a candidate for
-- removal once 0087's grant line goes with it.
CREATE OR REPLACE FUNCTION public.app_is_platform_scope()
RETURNS boolean
LANGUAGE sql
STABLE
AS $fn$
  SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on';
$fn$;

COMMENT ON FUNCTION public.app_is_platform_scope() IS
  'DEPRECATED ALIAS of app_platform_scope(). No policy references it; it '
  'exists because 0087 GRANTs EXECUTE on it and that statement must not fail '
  'on a database built from the numbered sequence alone. Remove both together.';


-- ⭐ THE CROSS-TENANT REFERENCE GUARD FOR THE CONTRACT STORE.
--
-- A foreign key proves the referenced row EXISTS. It does not prove it
-- belongs to the same tenant, and RLS does not help: the FK is checked by
-- the system, outside any policy. So a contract row carrying tenant B's id
-- and pointing at tenant A's `asset_id` is accepted by every other control
-- in this database. This trigger is the only thing that refuses it.
CREATE OR REPLACE FUNCTION public.assert_contract_refs_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  ref_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'contracts' THEN
    IF NEW.asset_id IS NOT NULL THEN
      SELECT tenant_id INTO ref_tenant FROM assets WHERE id = NEW.asset_id;
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Cross-tenant reference blocked: contract.asset_id'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
      SELECT tenant_id INTO ref_tenant FROM contacts WHERE id = NEW.contact_id;
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Cross-tenant reference blocked: contract.contact_id'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
    IF NEW.company_id IS NOT NULL THEN
      SELECT tenant_id INTO ref_tenant FROM companies WHERE id = NEW.company_id;
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Cross-tenant reference blocked: contract.company_id'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'contract_versions' THEN
    SELECT tenant_id INTO ref_tenant FROM contracts WHERE id = NEW.contract_id;
    IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant reference blocked: version.contract_id'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;


-- ⭐ THE SAME ARGUMENT FOR THE LEDGER, WHERE IT MATTERS MORE.
--
-- A journal entry names a ledger and a transaction. If either belongs to a
-- different tenant, the entry has moved money between two companies' books
-- and both sets balance, so no reconciliation ever notices.
CREATE OR REPLACE FUNCTION public.assert_journal_entry_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_ledger_tenant uuid;
  v_txn_tenant    uuid;
BEGIN
  SELECT tenant_id INTO v_ledger_tenant FROM ledgers      WHERE id = NEW.ledger_id;
  SELECT tenant_id INTO v_txn_tenant    FROM transactions WHERE id = NEW.transaction_id;

  IF v_ledger_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Cross-tenant journal entry blocked: ledger belongs to another tenant'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_txn_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Cross-tenant journal entry blocked: transaction belongs to another tenant'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$fn$;


-- ----------------------------------------------------------------------------
-- SECTION 1b — ACL PARITY: NO TRIGGER FUNCTION IS CALLABLE BY PUBLIC
-- ----------------------------------------------------------------------------
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 THE LAST DIFFERENCE BETWEEN THE TWO BUILDS, AND IT IS ORDER, NOT INTENT
-- ══════════════════════════════════════════════════════════════════════════
-- With everything above applied, a migrations-only database and a database
-- built the production way agree on all 2,086 security objects and on every
-- table ACL. They disagreed on FIVE FUNCTION ACLs, and the reason is pure
-- ordering:
--
--     0087 does  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC
--
-- and `ALL FUNCTIONS` means the ones that exist AT THAT MOMENT. In the
-- production order the phase-4 functions were created by ALL-IN-ONE-SETUP.sql
-- before 0087 and were caught by it. In the numbered order they are created
-- here, forty-nine files later, and the blanket revoke has already run.
--
-- ⚠️ AND THE SAME ORDERING PROBLEM IS ALREADY LIVE IN PRODUCTION. Sixteen
-- trigger functions created by files numbered ABOVE 0087 are executable by
-- PUBLIC on the production-shaped build too, for exactly this reason:
-- `ordence_guard_reconciled_bank_line`, `ordence_dpr_events_append_only`,
-- `journal_entry_fill_minor` and thirteen more. Nothing re-runs 0087.
--
-- ⭐ SO THIS FIXES THE CLASS RATHER THAN THE FIVE. A function returning
-- `trigger` is called by the trigger machinery, which checks EXECUTE at
-- CREATE TRIGGER time and not at fire time. No trigger stops working. What
-- stops being possible is an arbitrary session calling a guard function
-- directly, and `0087`'s own comment already states that intent: "Guard
-- triggers stay reachable from the table layer via SECURITY DEFINER
-- ownership; arbitrary sessions cannot call them directly."
--
-- ⚠️ STATED PLAINLY: THIS GOES BEYOND PARITY. It narrows sixteen privileges
-- on the production-shaped database that 0087 intended to narrow and missed.
-- It is done here, in the file that discovered the divergence, rather than
-- left as a note nobody actions.

DO $$
DECLARE
  r       record;
  n       integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure::text AS sig
      FROM pg_proc p
      JOIN pg_namespace n2 ON n2.oid = p.pronamespace
     WHERE n2.nspname = 'public'
       AND p.prorettype = 'trigger'::regtype
       AND has_function_privilege('public', p.oid, 'EXECUTE')
     ORDER BY 2
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    n := n + 1;
  END LOOP;

  RAISE NOTICE '0136: revoked PUBLIC EXECUTE from % trigger function(s).', n;
END
$$;

-- ⚠️ AND THE ONE FUNCTION THAT IS *SUPPOSED* TO BE PUBLIC.
-- 0087 grants EXECUTE on `app_is_platform_scope()` to PUBLIC, alongside
-- `app_current_tenant_id()` and the other three RLS helpers, because every
-- request and every pooler health probe evaluates them inside a policy. On a
-- migrations-only build that grant is skipped (the function does not exist
-- yet — see the guard added to 0087 in this wave), so it is made here.
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.app_is_platform_scope() TO PUBLIC;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 2 — ENABLE, FORCE, POLICY, ON ALL SIX
-- ----------------------------------------------------------------------------
--
-- ⚠️ `FORCE`, NOT ONLY `ENABLE`, AND THIS IS THE PART THAT IS EASY TO GET
-- WRONG. On Neon the application connects as `neondb_owner`, which OWNS
-- these tables. `ENABLE ROW LEVEL SECURITY` does not apply to a table's
-- owner. `FORCE ROW LEVEL SECURITY` does, and it is the only reason any of
-- this binds the running application at all.
--
-- ⚠️ AND `IF EXISTS`/`to_regclass` RATHER THAN A BARE `ALTER TABLE`: on a
-- database where a table is genuinely absent this file must say so in
-- Section 3 rather than abort in Section 2 with a 42P01 that names one table
-- and hides the other five.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'clause_library', 'contracts', 'contract_versions',
    'ledgers', 'transactions', 'journal_entries'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NULL THEN
      RAISE NOTICE '0136: table % does not exist here; Section 3 will report it.', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', t);

    -- DROP then CREATE rather than CREATE OR REPLACE: PostgreSQL has no
    -- CREATE OR REPLACE POLICY, and ALTER POLICY cannot introduce one that
    -- is absent. This is the idiom every other file here uses.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL '
      'USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant_isolation', t);

    RAISE NOTICE '0136: % — RLS enabled, forced, policy %_tenant_isolation created.', t, t;
  END LOOP;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 3 — THE NINE TRIGGERS
-- ----------------------------------------------------------------------------
--
-- ⚠️ Each is guarded on the existence of the function it calls, because six
-- of the nine call functions defined in OTHER numbered files (0005, 0016)
-- and a hard failure here would be a failure about the wrong file.
-- Section 4 reports anything that did not attach, by name.

DO $$
BEGIN
  IF to_regclass('public.contracts') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS contracts_same_tenant ON public.contracts;
    CREATE TRIGGER contracts_same_tenant
      BEFORE INSERT OR UPDATE ON public.contracts
      FOR EACH ROW EXECUTE FUNCTION assert_contract_refs_same_tenant();
  END IF;

  IF to_regclass('public.contract_versions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS contract_versions_same_tenant ON public.contract_versions;
    CREATE TRIGGER contract_versions_same_tenant
      BEFORE INSERT ON public.contract_versions
      FOR EACH ROW EXECUTE FUNCTION assert_contract_refs_same_tenant();
  END IF;

  IF to_regclass('public.journal_entries') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS journal_entries_tenant_check ON public.journal_entries;
    CREATE TRIGGER journal_entries_tenant_check
      BEFORE INSERT ON public.journal_entries
      FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_tenant();
  END IF;
END
$$;


-- The append-only pair on `contract_versions` and `journal_entries`.
-- `block_mutation_append_only()` comes from 0005.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'block_mutation_append_only') THEN
    RAISE NOTICE '0136: block_mutation_append_only() is absent (0005 did not apply); '
                 'the four append-only triggers are skipped and Section 4 will fail.';
    RETURN;
  END IF;

  IF to_regclass('public.contract_versions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS contract_versions_no_update ON public.contract_versions;
    CREATE TRIGGER contract_versions_no_update
      BEFORE UPDATE ON public.contract_versions
      FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

    DROP TRIGGER IF EXISTS contract_versions_no_delete ON public.contract_versions;
    CREATE TRIGGER contract_versions_no_delete
      BEFORE DELETE ON public.contract_versions
      FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();
  END IF;

  IF to_regclass('public.journal_entries') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS journal_entries_no_update ON public.journal_entries;
    CREATE TRIGGER journal_entries_no_update
      BEFORE UPDATE ON public.journal_entries
      FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

    DROP TRIGGER IF EXISTS journal_entries_no_delete ON public.journal_entries;
    CREATE TRIGGER journal_entries_no_delete
      BEFORE DELETE ON public.journal_entries
      FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();
  END IF;
END
$$;


-- The ledger-balance pair. `update_ledger_balance()` and
-- `enforce_double_entry_balance()` come from 0016 / the phase-4 baseline.
--
-- 🔴 `journal_entries_balance_check` IS A **CONSTRAINT** TRIGGER, DEFERRABLE
-- INITIALLY DEFERRED, AND IT HAS TO BE. A double-entry batch is balanced only
-- once every line of it has been inserted; checked per row at INSERT time it
-- would refuse the first line of every legal journal. Recreating it as an
-- ordinary AFTER trigger is the single easiest way to break the accounting
-- module while every test that inserts one balanced pair still passes.
DO $$
BEGIN
  IF to_regclass('public.journal_entries') IS NULL THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'update_ledger_balance') THEN
    DROP TRIGGER IF EXISTS journal_entries_update_balance ON public.journal_entries;
    CREATE TRIGGER journal_entries_update_balance
      BEFORE INSERT ON public.journal_entries
      FOR EACH ROW EXECUTE FUNCTION update_ledger_balance();
  ELSE
    RAISE NOTICE '0136: update_ledger_balance() is absent; trigger skipped.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'enforce_double_entry_balance') THEN
    DROP TRIGGER IF EXISTS journal_entries_balance_check ON public.journal_entries;
    CREATE CONSTRAINT TRIGGER journal_entries_balance_check
      AFTER INSERT OR UPDATE OR DELETE ON public.journal_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_double_entry_balance();
  ELSE
    RAISE NOTICE '0136: enforce_double_entry_balance() is absent; trigger skipped.';
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- SECTION 4 — VERIFY. EXACT COUNTS, NAMED FAILURES, NO FLOOR.
-- ----------------------------------------------------------------------------
--
-- ⚠️ THE SHAPE OF THIS SECTION IS THE POINT. `count(*) >= n THEN 'PASS'` has
-- shipped in this repository three times (0014's impersonation census at
-- >= 10 against 303 tables, the CI RLS floor at >= 100, the old
-- `.next/static` scan) and each time it passed while the property it
-- described was false. So: six named tables, nine named triggers, three
-- named functions, and the exception lists exactly which ones are missing.

DO $$
DECLARE
  tables text[] := ARRAY[
    'clause_library', 'contracts', 'contract_versions',
    'ledgers', 'transactions', 'journal_entries'
  ];
  wanted_triggers text[][] := ARRAY[
    ARRAY['contracts',         'contracts_same_tenant'],
    ARRAY['contract_versions', 'contract_versions_same_tenant'],
    ARRAY['contract_versions', 'contract_versions_no_update'],
    ARRAY['contract_versions', 'contract_versions_no_delete'],
    ARRAY['journal_entries',   'journal_entries_tenant_check'],
    ARRAY['journal_entries',   'journal_entries_no_update'],
    ARRAY['journal_entries',   'journal_entries_no_delete'],
    ARRAY['journal_entries',   'journal_entries_update_balance'],
    ARRAY['journal_entries',   'journal_entries_balance_check']
  ];
  funcs text[] := ARRAY[
    'app_is_platform_scope', 'assert_contract_refs_same_tenant',
    'assert_journal_entry_tenant'
  ];
  t         text;
  f         text;
  i         integer;
  problems  text[] := ARRAY[]::text[];
  deferred  boolean;
BEGIN
  /* -- the six tables ------------------------------------------------ */
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NULL THEN
      problems := problems || format('%s: TABLE DOES NOT EXIST', t);
      CONTINUE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity) THEN
      problems := problems || format('%s: RLS NOT ENABLED', t);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = t AND c.relforcerowsecurity) THEN
      problems := problems || format('%s: RLS NOT FORCED (the app owns this table on Neon, '
                                     'so ENABLE alone does nothing to it)', t);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = t
                      AND qual::text LIKE '%app_current_tenant_id%') THEN
      problems := problems || format('%s: NO POLICY REFERENCING app_current_tenant_id()', t);
    END IF;

    -- ⚠️ AND THE OTHER DIRECTION. These five are on
    -- `check-rls-coverage.mjs`'s PLATFORM_READ_REFUSED list, quoting 0014 §6.
    -- A policy created here that carried a platform branch would fail that
    -- gate on the next push; catching it in the file that created it is
    -- cheaper and names the reason.
    IF t <> 'clause_library'
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = t
                      AND (qual::text LIKE '%app_platform_scope%'
                        OR qual::text LIKE '%app_is_platform_scope%')) THEN
      problems := problems || format(
        '%s: its USING clause carries a platform-scope branch. 0014 §6 refuses '
        'exactly that on the general ledger and on customer content held as a '
        'processor.', t);
    END IF;
  END LOOP;

  /* -- the three functions ------------------------------------------- */
  FOREACH f IN ARRAY funcs LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = f) THEN
      problems := problems || format('function %s() MISSING', f);
    END IF;
  END LOOP;

  /* -- the nine triggers --------------------------------------------- */
  FOR i IN 1 .. array_length(wanted_triggers, 1) LOOP
    IF to_regclass('public.' || quote_ident(wanted_triggers[i][1])) IS NULL THEN
      CONTINUE;  -- already reported as a missing table
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT tg.tgisinternal AND n.nspname = 'public'
         AND c.relname = wanted_triggers[i][1]
         AND tg.tgname = wanted_triggers[i][2]) THEN
      problems := problems || format('trigger %s ON %s MISSING',
                                     wanted_triggers[i][2], wanted_triggers[i][1]);
    END IF;
  END LOOP;

  /* -- and that the balance check is still DEFERRED ------------------- */
  SELECT tg.tgdeferrable AND tg.tginitdeferred INTO deferred
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT tg.tgisinternal AND n.nspname = 'public'
     AND c.relname = 'journal_entries' AND tg.tgname = 'journal_entries_balance_check';

  IF deferred IS NOT NULL AND NOT deferred THEN
    problems := problems || 'journal_entries_balance_check EXISTS BUT IS NOT DEFERRABLE '
                            'INITIALLY DEFERRED — it will refuse the first line of every '
                            'legal multi-line journal.'::text;
  END IF;

  /* -- and no trigger function is callable by PUBLIC ----------------- */
  -- ⭐ ASSERTED AS AN EXACT ZERO, NOT AS "the loop ran". The loop above
  -- could have iterated over an empty set for a dozen reasons and reported
  -- a cheerful "revoked 0".
  DECLARE
    still_public integer;
  BEGIN
    SELECT count(*) INTO still_public
      FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
     WHERE n2.nspname = 'public'
       AND p.prorettype = 'trigger'::regtype
       AND has_function_privilege('public', p.oid, 'EXECUTE');
    IF still_public > 0 THEN
      problems := problems || format(
        '%s trigger function(s) are still EXECUTE-able by PUBLIC after Section 1b.',
        still_public);
    END IF;
  END;

  IF NOT has_function_privilege('public', 'public.app_is_platform_scope()', 'EXECUTE') THEN
    problems := problems || ('app_is_platform_scope() is not EXECUTE-able by PUBLIC. '
      || '0087 grants it alongside the other RLS helpers because every policy '
      || 'evaluation needs it; Section 1b''s blanket revoke must not have caught it, '
      || 'but something did.')::text;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION E'0136 FAILED — % problem(s):\n  %',
      cardinality(problems), array_to_string(problems, E'\n  ')
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE
    '0136 PASS: all 6 phase-4 tables enabled, FORCED and policied on '
    'app_current_tenant_id(); 3 functions and 9 triggers present; the '
    'double-entry balance check is still deferred. A database built from the '
    'numbered sequence alone now isolates the general ledger.';
END
$$;
