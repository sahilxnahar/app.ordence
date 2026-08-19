-- ############################################################################
-- CONFIRM 0093 THROUGH 0102 , WHICH ONES ARE ACTUALLY IN YOUR DATABASE
-- ############################################################################
--
-- WHY THIS FILE EXISTS
-- --------------------
-- Every migration in this project opens with a DIAGNOSTIC that runs BEFORE its
-- own change. That tab is meant to tell you what you are about to do, and it
-- correctly reports `false` for a thing that is not there yet. Exporting that
-- tab and reading it as a result is the single most common confusion in this
-- project, and it has now happened three times.
--
-- 🔴 A PRE-CHECK SAYING `already_present: false` IS NOT A FAILURE. It is the
--    file telling you there is work to do, moments before it does it.
--
-- ⭐ THIS FILE HAS NO PRE-CHECK AND NO ORDER OF OPERATIONS. It is ONE
--    STATEMENT that reads the PostgreSQL catalog and reports, for each
--    migration, whether the objects it creates exist right now.
--
-- ############################################################################
-- 🔴 WHY IT CANNOT FAIL THE WAY MY EARLIER DIAGNOSTICS FAILED
-- ############################################################################
--
-- Two of my own diagnostic files in this project were broken in the same way:
-- they tried to guard a read of a table with `CASE WHEN to_regclass(...) IS
-- NULL THEN ... ELSE (SELECT count(*) FROM that_table) END`.
--
-- ⚠️ THE PLANNER RESOLVES BOTH BRANCHES OF A `CASE` BEFORE THE GUARD EVER
--    RUNS. A file diagnosing whether a table exists cannot mention that table
--    in a FROM clause. It fails with "relation does not exist" and tells you
--    nothing, on precisely the database where you needed the answer.
--
-- ⭐ EVERYTHING BELOW READS ONLY `to_regclass` AND `information_schema`, both
--    of which are catalog lookups that return NULL or zero rows for something
--    absent. There is no table name in any FROM clause that might not exist.
--    This file is safe on an empty database and safe on a fully migrated one.
--
-- READ ONLY. It writes nothing, locks nothing, and is safe to run any number
-- of times, on production, at any hour.
--
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


SELECT
    v.migration,
    v.what_it_adds,
    v.present                                   AS applied,
    CASE WHEN v.present THEN '✅ in the database'
                        ELSE '⬜ not yet , run it'
    END                                         AS verdict
FROM (
    VALUES
    ('0093', 'users.preferences',
        (SELECT count(*) > 0 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'
            AND column_name = 'preferences')),

    ('0094', 'payroll_runs.paid_on + employee_settlements',
        (SELECT count(*) > 0 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'payroll_runs'
            AND column_name = 'paid_on')
        AND to_regclass('public.employee_settlements') IS NOT NULL),

    ('0095', 'employees.tax_regime_elections',
        (SELECT count(*) > 0 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'employees'
            AND column_name = 'tax_regime_elections')),

    ('0096', 'employee_advances + recoveries + reimbursements',
        to_regclass('public.employee_advances')             IS NOT NULL
    AND to_regclass('public.employee_advance_recoveries')   IS NOT NULL
    AND to_regclass('public.employee_reimbursement_claims') IS NOT NULL),

    ('0097', 'email_outbox + email_suppressions',
        to_regclass('public.email_outbox')      IS NOT NULL
    AND to_regclass('public.email_suppressions') IS NOT NULL),

    ('0098', 'dunning_events raised / dispatched / served split',
        (SELECT count(*) = 3 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'dunning_events'
            AND column_name IN ('raised_at', 'dispatched_at', 'service_evidence'))),

    ('0099', 'the stock movement trigger stops overwriting value_minor',
        (SELECT count(*) > 0 FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = 'ordence_validate_stock_movement'
            AND pg_get_functiondef(p.oid)
                LIKE '%COALESCE(NEW.value_minor, 0) = 0%')),

    ('0100', 'fixed_assets + it_asset_blocks + depreciation_runs/lines',
        to_regclass('public.fixed_assets')       IS NOT NULL
    AND to_regclass('public.it_asset_blocks')    IS NOT NULL
    AND to_regclass('public.depreciation_runs')  IS NOT NULL
    AND to_regclass('public.depreciation_lines') IS NOT NULL),

    ('0101', 'currency_units + fx_rates + fx_revaluations',
        to_regclass('public.currency_units')       IS NOT NULL
    AND to_regclass('public.fx_reference_rates')   IS NOT NULL
    AND to_regclass('public.fx_rates')             IS NOT NULL
    AND to_regclass('public.fx_revaluations')      IS NOT NULL
    AND to_regclass('public.fx_revaluation_lines') IS NOT NULL),

    ('0102', 'bank_reconciliations + items + the lock trigger',
        to_regclass('public.bank_reconciliations')      IS NOT NULL
    AND to_regclass('public.bank_reconciliation_items') IS NOT NULL
    AND (SELECT count(*) > 0 FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal
            AND t.tgname = 'ordence_guard_reconciled_bank_line'))
) AS v(migration, what_it_adds, present)
ORDER BY v.migration;
