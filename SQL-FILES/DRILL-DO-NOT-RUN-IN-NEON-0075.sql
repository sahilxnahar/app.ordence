-- =====================================================================
--  🔴🔴🔴 DO NOT RUN THIS AGAINST NEON. DO NOT RUN IT AGAINST ANY
--  DATABASE THAT HAS REAL DATA IN IT.
--
--  It proves the constraints REFUSE things, which it does by trying to
--  insert bad rows against a made-up tenant and made-up employees. On a
--  live database it would either fail on foreign keys or, worse,
--  succeed and leave fake payroll runs in your books.
--
--  It has already been run here, on a throwaway Postgres, as the
--  non-superuser role `app_user`. The transcript beside this file is
--  the evidence. Keep both; execute neither.
-- =====================================================================
--
--  ORDENCE — THE DRILL FOR 0075 · PAYROLL
--  Version: v1.23.0-alpha
--
--  🔴 RUN AS `app_user`, NEVER AS THE OWNER OR A SUPERUSER. A superuser
--  BYPASSES row level security entirely, so a drill run as postgres
--  proves that postgres can read everything — which was never in
--  question, and has passed while policies were wrong.
--
--  ⚠️ EVERY REFUSAL IS PAIRED WITH A POSITIVE. A statement that failed
--  cannot be told apart from a statement that never ran, and the 0074
--  drill proved that the hard way: an UPDATE reported zero rows because
--  RLS had hidden them, and it looked exactly like a constraint working.
-- =====================================================================

-- =====================================================================
--  ① THE PAYSLIP MUST ADD UP TO ITSELF
-- =====================================================================

\echo '--- ①a POSITIVE: a payslip whose net equals gross minus deductions'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO payslips
  (tenant_id, run_id, employee_id, employee_name, employee_code,
   days_in_month, payable_days, lop_days,
   gross_minor, total_deductions_minor, net_pay_minor, lines)
VALUES
  ('11111111-1111-1111-1111-111111111111',
   '44444444-4444-4444-4444-444444444444',
   '55555555-5555-5555-5555-555555555555',
   'Asha Rao', 'E-001', 30, 30, 0,
   3200000, 213500, 2986500, '[]'::jsonb);
COMMIT;

\echo '--- ①b NEGATIVE: a payslip that does NOT add up must be REFUSED'
\echo '    (an employee with a calculator checks this, and they are right to)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO payslips
  (tenant_id, run_id, employee_id, employee_name, employee_code,
   days_in_month, payable_days, lop_days,
   gross_minor, total_deductions_minor, net_pay_minor, lines)
VALUES
  ('11111111-1111-1111-1111-111111111111',
   '44444444-4444-4444-4444-444444444444',
   '66666666-6666-6666-6666-666666666666',
   'Bhaskar N', 'E-002', 30, 30, 0,
   3200000, 213500, 3000000, '[]'::jsonb);
COMMIT;

\echo '--- ①c NEGATIVE: more loss of pay than payable days must be REFUSED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO payslips
  (tenant_id, run_id, employee_id, employee_name, employee_code,
   days_in_month, payable_days, lop_days,
   gross_minor, total_deductions_minor, net_pay_minor, lines)
VALUES
  ('11111111-1111-1111-1111-111111111111',
   '44444444-4444-4444-4444-444444444444',
   '66666666-6666-6666-6666-666666666666',
   'Bhaskar N', 'E-002', 30, 10, 20,
   0, 0, 0, '[]'::jsonb);
COMMIT;

\echo '--- ①d NEGATIVE: two payslips for one employee in one run must be REFUSED'
\echo '    (two is a duplicate payment)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO payslips
  (tenant_id, run_id, employee_id, employee_name, employee_code,
   days_in_month, payable_days, lop_days,
   gross_minor, total_deductions_minor, net_pay_minor, lines)
VALUES
  ('11111111-1111-1111-1111-111111111111',
   '44444444-4444-4444-4444-444444444444',
   '55555555-5555-5555-5555-555555555555',
   'Asha Rao', 'E-001', 30, 30, 0,
   3200000, 213500, 2986500, '[]'::jsonb);
COMMIT;

-- =====================================================================
--  ② ONE LIVE RUN PER PERIOD
-- =====================================================================

\echo '--- ②a NEGATIVE: a SECOND live run for the same March must be REFUSED'
\echo '    (two runs post the wage bill twice, and every figure downstream'
\echo '     is then exactly twice the truth and entirely plausible)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO payroll_runs (tenant_id, run_no, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', 'PR-202503-DUP',
        DATE '2025-03-01', DATE '2025-03-31');
COMMIT;

\echo '--- ②b POSITIVE: a run for a DIFFERENT period must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO payroll_runs (tenant_id, run_no, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', 'PR-202504',
        DATE '2025-04-01', DATE '2025-04-30');
COMMIT;

\echo '--- ②c NEGATIVE: a period that ends before it starts must be REFUSED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO payroll_runs (tenant_id, run_no, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', 'PR-BACKWARDS',
        DATE '2025-05-31', DATE '2025-05-01');
COMMIT;

-- =====================================================================
--  ③ THE STATUS RATCHET AND THE FREEZE
-- =====================================================================

\echo '--- ③a POSITIVE: draft to computed must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE payroll_runs SET status = 'computed'
 WHERE run_no = 'PR-202504';
COMMIT;

\echo '--- ③b POSITIVE: computed back to draft is the ONE permitted reversal'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE payroll_runs SET status = 'draft' WHERE run_no = 'PR-202504';
UPDATE payroll_runs SET status = 'computed' WHERE run_no = 'PR-202504';
COMMIT;

\echo '--- ③c POSITIVE: computed to approved must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE payroll_runs SET status = 'approved', approved_at = now()
 WHERE run_no = 'PR-202504';
COMMIT;

\echo '--- ③d NEGATIVE: approved back to computed must be REFUSED'
\echo '    (a run that walks backwards can post the same wage bill twice)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE payroll_runs SET status = 'computed' WHERE run_no = 'PR-202504';
COMMIT;

\echo '--- ③e NEGATIVE: a payslip in an APPROVED run may not change'
\echo '    (approval is a signature; if the figures can still move it'
\echo '     attaches to nothing)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO payslips
  (tenant_id, run_id, employee_id, employee_name, employee_code,
   days_in_month, payable_days, lop_days,
   gross_minor, total_deductions_minor, net_pay_minor, lines)
SELECT '11111111-1111-1111-1111-111111111111', id,
       '55555555-5555-5555-5555-555555555555', 'Asha Rao', 'E-001',
       30, 30, 0, 1, 0, 1, '[]'::jsonb
  FROM payroll_runs WHERE run_no = 'PR-202504';
COMMIT;

\echo '--- ③f NEGATIVE: an approved run may not be posted with no journal'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE payroll_runs SET status = 'posted', posted_at = now()
 WHERE run_no = 'PR-202504';
COMMIT;

\echo '--- ③g NEGATIVE: cancelling without a reason must be REFUSED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE payroll_runs SET status = 'cancelled', cancelled_at = now()
 WHERE run_no = 'PR-202504';
COMMIT;

\echo '--- ③h POSITIVE: cancelling WITH a reason must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE payroll_runs
   SET status = 'cancelled', cancelled_at = now(),
       cancel_reason = 'Structure was wrong for two people; re-running.'
 WHERE run_no = 'PR-202504';
COMMIT;

\echo '--- ③i POSITIVE: with that one cancelled, the period is free again'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO payroll_runs (tenant_id, run_no, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', 'PR-202504-B',
        DATE '2025-04-01', DATE '2025-04-30');
COMMIT;

-- =====================================================================
--  ④ THE EMPLOYEE MASTER
-- =====================================================================

\echo '--- ④a NEGATIVE: a malformed PAN must be REFUSED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO employees (tenant_id, employee_code, full_name, work_state_code, joined_on, pan)
VALUES ('11111111-1111-1111-1111-111111111111', 'E-BAD', 'Test', 'KA',
        DATE '2025-01-01', 'NOTAPAN');
COMMIT;

\echo '--- ④b POSITIVE: a well-formed PAN must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO employees (tenant_id, employee_code, full_name, work_state_code, joined_on, pan)
VALUES ('11111111-1111-1111-1111-111111111111', 'E-003', 'Chitra P', 'MH',
        DATE '2025-01-01', 'ABCDE1234F');
COMMIT;

\echo '--- ④c NEGATIVE: leaving before joining must be REFUSED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO employees (tenant_id, employee_code, full_name, work_state_code, joined_on, left_on)
VALUES ('11111111-1111-1111-1111-111111111111', 'E-TIME', 'Time Traveller', 'KA',
        DATE '2025-06-01', DATE '2025-01-01');
COMMIT;

\echo '--- ④d NEGATIVE: two employees with one UAN must be REFUSED'
\echo '    (one UAN on two people means an identity has been reused)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO employees (tenant_id, employee_code, full_name, work_state_code, joined_on, uan)
VALUES ('11111111-1111-1111-1111-111111111111', 'E-004', 'Dev S', 'KA',
        DATE '2025-01-01', '100200300400');
INSERT INTO employees (tenant_id, employee_code, full_name, work_state_code, joined_on, uan)
VALUES ('11111111-1111-1111-1111-111111111111', 'E-005', 'Esha T', 'KA',
        DATE '2025-01-01', '100200300400');
COMMIT;

-- =====================================================================
--  ⑤ ONE OPEN STRUCTURE ROW PER COMPONENT
-- =====================================================================

\echo '--- ⑤a POSITIVE: the first open structure row must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO employee_pay_structure
  (tenant_id, employee_id, component_id, monthly_amount_minor, effective_from)
VALUES ('11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555',
        '77777777-7777-7777-7777-777777777777',
        2000000, DATE '2025-01-01');
COMMIT;

\echo '--- ⑤b NEGATIVE: a SECOND open row for the same component must be REFUSED'
\echo '    (two open Basic rows both apply, and the employee is paid Basic twice)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO employee_pay_structure
  (tenant_id, employee_id, component_id, monthly_amount_minor, effective_from)
VALUES ('11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555',
        '77777777-7777-7777-7777-777777777777',
        2500000, DATE '2025-07-01');
COMMIT;

\echo '--- ⑤c POSITIVE: close the old one, then the new one is accepted'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE employee_pay_structure SET effective_to = DATE '2025-06-30'
 WHERE employee_id = '55555555-5555-5555-5555-555555555555'
   AND effective_to IS NULL;
INSERT INTO employee_pay_structure
  (tenant_id, employee_id, component_id, monthly_amount_minor, effective_from, reason)
VALUES ('11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555',
        '77777777-7777-7777-7777-777777777777',
        2500000, DATE '2025-07-01', 'Annual review');
COMMIT;

-- =====================================================================
--  ⑥ ROW LEVEL SECURITY — THE PART A SUPERUSER CANNOT TEST
-- =====================================================================

\echo '--- ⑥a POSITIVE: the owning tenant sees its own employees'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) AS own_tenant_sees FROM employees;
COMMIT;

\echo '--- ⑥b NEGATIVE: ANOTHER tenant sees none of them'
\echo '    (salary is the one figure people quit over knowing)'
BEGIN;
SET LOCAL app.current_tenant_id = '22222222-2222-2222-2222-222222222222';
SELECT count(*) AS other_tenant_sees FROM employees;
SELECT count(*) AS other_tenant_sees_payslips FROM payslips;
COMMIT;

\echo '--- ⑥c NEGATIVE: and cannot WRITE into the first tenant either'
BEGIN;
SET LOCAL app.current_tenant_id = '22222222-2222-2222-2222-222222222222';
INSERT INTO employees (tenant_id, employee_code, full_name, work_state_code, joined_on)
VALUES ('11111111-1111-1111-1111-111111111111', 'E-EVIL', 'Injected', 'KA',
        DATE '2025-01-01');
COMMIT;

\echo '--- ⑥d POSITIVE: the platform scope may READ across tenants'
BEGIN;
SET LOCAL app.platform_scope = 'on';
SELECT count(*) AS platform_sees FROM employees;
COMMIT;

\echo '--- ⑥e NEGATIVE: and may NOT write, because WITH CHECK excludes it'
BEGIN;
SET LOCAL app.platform_scope = 'on';
INSERT INTO employees (tenant_id, employee_code, full_name, work_state_code, joined_on)
VALUES ('11111111-1111-1111-1111-111111111111', 'E-PLATFORM', 'Support wrote this', 'KA',
        DATE '2025-01-01');
COMMIT;

\echo '--- DRILL COMPLETE ---'
