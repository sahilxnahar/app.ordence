-- =====================================================================
--  ORDENCE — VERIFY 0075 IN NEON
--  Version: v1.23.0-alpha
--
--  ⭐ READ-ONLY. Every statement is a SELECT. It writes nothing and is
--  safe to run against production as many times as you like.
--
--  ⚠️ THIS IS NOT THE DRILL. The drill proves the constraints REFUSE
--  things, which it does by inserting bad rows — that belongs on a
--  throwaway database and its filename says so. This file only asks the
--  database what 0075 actually created.
--
--  Paste the whole thing into the Neon SQL editor and press Run. You
--  get eight result tabs; every one should read "yes" or "0".
-- =====================================================================

-- ① The six new tables
SELECT 'tables' AS check_name, table_name, 'yes' AS present
  FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN (
     'employees', 'pay_components', 'employee_pay_structure',
     'statutory_rates', 'payroll_runs', 'payslips'
   )
 ORDER BY table_name;

-- ② The two new enums
SELECT 'enums' AS check_name, t.typname AS enum_name,
       string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS values
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
 WHERE t.typname IN ('payroll_run_status', 'tax_regime')
 GROUP BY t.typname
 ORDER BY t.typname;

-- ③ The constraints that keep a payslip honest
SELECT 'constraints' AS check_name, conname AS constraint_name, 'yes' AS present
  FROM pg_constraint
 WHERE conname IN (
   'payslips_adds_up',
   'payslips_days_sane',
   'payroll_runs_period_ordered',
   'payroll_runs_cancel_explained',
   'payroll_runs_posted_has_journal',
   'employees_pan_shape',
   'employees_uan_shape',
   'employees_dates_ordered',
   'employee_pay_structure_amount_sane'
 )
 ORDER BY conname;

-- ④ 🔴 The indexes that stop a wage bill being paid twice
SELECT 'unique indexes' AS check_name, indexname, 'yes' AS present
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND indexname IN (
     'payroll_runs_one_live_per_period',
     'payslips_run_employee_key',
     'employee_pay_structure_one_open',
     'employees_code_key',
     'employees_uan_key'
   )
 ORDER BY indexname;

-- ⑤ The two guards
SELECT 'triggers' AS check_name,
       t.tgname AS trigger_name,
       c.relname AS on_table,
       'yes' AS present
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE t.tgname IN ('ordence_guard_payroll_frozen', 'ordence_guard_payroll_status')
 ORDER BY t.tgname;

-- ⑥ Row level security on every payroll table
SELECT 'rls' AS check_name,
       c.relname AS table_name,
       CASE WHEN c.relrowsecurity THEN 'yes' ELSE 'NO' END AS rls_enabled,
       CASE WHEN c.relforcerowsecurity THEN 'yes' ELSE 'NO' END AS rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN (
     'employees', 'pay_components', 'employee_pay_structure',
     'statutory_rates', 'payroll_runs', 'payslips'
   )
 ORDER BY c.relname;

-- ⑦ The policies, and the house rule they must obey
--
--  ⚠️ `app_platform_scope()` belongs in USING and NEVER in WITH CHECK.
--  `with_check_is_clean` must read "yes" on all six rows.
SELECT 'policies' AS check_name,
       tablename,
       policyname,
       CASE WHEN qual LIKE '%app_platform_scope%' THEN 'yes' ELSE 'NO' END
         AS using_has_platform_scope,
       CASE WHEN coalesce(with_check, '') LIKE '%app_platform_scope%'
            THEN 'NO — house rule broken' ELSE 'yes' END AS with_check_is_clean
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN (
     'employees', 'pay_components', 'employee_pay_structure',
     'statutory_rates', 'payroll_runs', 'payslips'
   )
 ORDER BY tablename;

-- ⑧ ⭐ NOTHING JUNK LANDED
--
--  Every count should be 0 on a database where payroll has not been set
--  up yet. `drill_leftovers` in particular would be non-zero only if the
--  drill had been run here, which it must never be.
SELECT 'row counts' AS check_name,
       (SELECT count(*) FROM employees)              AS employees,
       (SELECT count(*) FROM pay_components)         AS components,
       (SELECT count(*) FROM employee_pay_structure) AS structure_rows,
       (SELECT count(*) FROM statutory_rates)        AS rates,
       (SELECT count(*) FROM payroll_runs)           AS runs,
       (SELECT count(*) FROM payslips)               AS payslips,
       (SELECT count(*) FROM employees
         WHERE employee_code LIKE 'E-EVIL%'
            OR employee_code LIKE 'E-PLATFORM%'
            OR full_name IN ('Asha Rao', 'Bhaskar N', 'Time Traveller'))
                                                     AS drill_leftovers;
