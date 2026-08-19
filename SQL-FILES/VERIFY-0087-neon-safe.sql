-- ############################################################################
-- VERIFY-0087 — READ-ONLY GRANT AUDIT (Neon-safe, no writes)
-- ############################################################################
--
-- Reads the privilege catalogue back and reports, for every table this
-- release narrowed, exactly what `ordence_app` holds and whether the
-- privilege set matches the certified table. One row per table; the
-- `status` column spells it out in plain words — this output is what the
-- deployer reads before signing the release off.
--
-- Certified sets (from 0087):
--   APPEND-ONLY EVIDENCE — SELECT, INSERT:
--     bank_line_matches, bank_statement_lines, bank_statements,
--     credit_dunning_log, leave_ledger, appraisal_amendments, payslips
--   MUTABLE WORKING DATA — SELECT, INSERT, UPDATE:
--     bank_accounts, agent_definitions, agent_runs, agent_triggers,
--     platform_entitlement_history, platform_incidents, tenant_health_events,
--     employee_pay_structure, employees, pay_components, statutory_rates,
--     payroll_runs, gst_returns, channel_partner_commissions,
--     holiday_calendar, leave_periods, leave_requests, leave_types,
--     staff_attendance, credit_dunning_ladders, credit_dunning_stages,
--     credit_hold_events, credit_hold_overrides, cost_centres, budget_lines,
--     appraisal_cycles, appraisal_reviews, appraisal_subjects
--   FULL ADMIN — SELECT, INSERT, UPDATE, DELETE:
--     platform_approval_queue, reporting_lines
--
-- Run: psql -d <database> -f VERIFY-0087-neon-safe.sql
-- ---------------------------------------------------------------------------

WITH target AS (
  SELECT table_name, privilege_set,
         CASE privilege_set
           WHEN 'INSERT'  THEN ARRAY['INSERT']::text[]
           WHEN 'SI'      THEN ARRAY['SELECT','INSERT']::text[]
           WHEN 'SIU'     THEN ARRAY['SELECT','INSERT','UPDATE']::text[]
           WHEN 'ALL'     THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']::text[]
         END AS wants
  FROM (VALUES
    ('bank_line_matches','SI'), ('bank_statement_lines','SI'), ('bank_statements','SI'),
    ('credit_dunning_log','SI'), ('leave_ledger','SI'), ('appraisal_amendments','SI'),
    ('payslips','SI'),
    ('bank_accounts','SIU'), ('agent_definitions','SIU'), ('agent_runs','SIU'),
    ('platform_entitlement_history','SIU'),
    ('platform_incidents','SIU'), ('tenant_health_events','SIU'),
    ('employee_pay_structure','SIU'), ('employees','SIU'), ('pay_components','SIU'),
    ('statutory_rates','SIU'), ('payroll_runs','SIU'), ('gst_returns','SIU'),
    ('channel_partner_commissions','SIU'), ('holiday_calendar','SIU'),
    ('leave_periods','SIU'), ('leave_requests','SIU'), ('leave_types','SIU'),
    ('staff_attendance','SIU'), ('credit_dunning_ladders','SIU'),
    ('credit_dunning_stages','SIU'), ('credit_hold_events','SIU'),
    ('credit_hold_overrides','SIU'), ('cost_centres','SIU'), ('budget_lines','SIU'),
    ('appraisal_cycles','SIU'), ('appraisal_reviews','SIU'),
    ('appraisal_subjects','SIU'),
    ('platform_approval_queue','ALL'), ('reporting_lines','ALL'), ('agent_triggers','ALL')
  ) AS t(table_name, privilege_set)
),
actual AS (
  SELECT c.relname AS table_name,
         array_agg(DISTINCT p.privilege_type ORDER BY p.privilege_type) AS has
  FROM information_schema.role_table_grants p
  JOIN pg_class c ON c.relname = p.table_name
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE p.grantee = 'ordence_app'
    AND p.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
  GROUP BY c.relname
),
actual_cast AS (
  SELECT table_name, has::text[] AS has FROM actual
)
SELECT
  t.table_name,
  t.privilege_set AS certified,
  COALESCE(array_to_string(a.has, ','), '(NONE)') AS actually_holds,
  CASE
    WHEN a.has IS NULL THEN 'MISSING — table revoked correctly or role absent'
    WHEN a.has <@ t.wants THEN
      CASE WHEN t.wants <@ a.has THEN 'OK'
           ELSE 'NARROWER — safer than certified (acceptable)' END
    ELSE 'WIDER — unexpected privileges, RE-INVESTIGATE'
  END AS status
FROM target t
LEFT JOIN actual_cast a ON a.table_name = t.table_name
ORDER BY t.table_name
;

-- Extra eyes, for the deployer, on what the blanket grant did NOT intend to
-- survive: any table not listed above must hold no UPDATE/DELETE privilege.
-- This statement is self-contained (no CTE dependency on the first) so it
-- survives even if the first query were run alone.
SELECT
  'UNINTENDED HOLD' AS check_name,
  count(*) AS tables_with_residue
FROM information_schema.role_table_grants p
WHERE p.grantee = 'ordence_app'
  AND p.privilege_type IN ('UPDATE','DELETE')
  AND p.table_name NOT IN (
    SELECT UNNEST(ARRAY[
      'bank_line_matches','bank_statement_lines','bank_statements',
      'credit_dunning_log','leave_ledger','appraisal_amendments','payslips',
      'bank_accounts','agent_definitions','agent_runs','agent_triggers',
      'platform_entitlement_history','platform_incidents','tenant_health_events',
      'employee_pay_structure','employees','pay_components','statutory_rates',
      'payroll_runs','gst_returns','channel_partner_commissions',
      'holiday_calendar','leave_periods','leave_requests','leave_types',
      'staff_attendance','credit_dunning_ladders','credit_dunning_stages',
      'credit_hold_events','credit_hold_overrides','cost_centres','budget_lines',
      'appraisal_cycles','appraisal_reviews','appraisal_subjects',
      'platform_approval_queue','reporting_lines'
    ])
  )
  AND p.table_schema = 'public';
