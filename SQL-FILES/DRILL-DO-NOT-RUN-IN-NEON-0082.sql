-- =====================================================================
--  🔴🔴🔴 DRILL — DO NOT RUN THIS IN NEON 🔴🔴🔴
-- =====================================================================
--
--  It creates tables, seeds employees and payroll runs, and then
--  deliberately breaks things to show them being refused. Throwaway
--  Postgres only.
--
--     createdb drill0082
--     psql -q -d drill0082 -f DRILL-DO-NOT-RUN-IN-NEON-0082.sql
--
--  ⚠️ LIKE 0081'S DRILL AND UNLIKE 0079'S, THIS ONE DOES NOT REFUSE TO
--  RUN AS A SUPERUSER. Nothing under test here is a permission: every
--  refusal below is a CHECK constraint, a unique index, an exclusion
--  constraint or a trigger, and no role bypasses any of those. RLS is
--  therefore deliberately absent from the reproduction — 0079's drill
--  covers it, and including it here would only invite the reader to
--  think a refusal came from a policy when it came from arithmetic.
--
--  ⭐ EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL WORK. A
--  drill that only shows breaks cannot tell "the constraint works" from
--  "the table rejects everything", and a table that rejects everything
--  passes every refusal in this file.
--
--  ⚠️ ONE THING HERE IS A DEMONSTRATION RATHER THAN A TEST, AND IS
--  LABELLED AS ONE. POSITIVE 2 shows a mid-year joiner earning a
--  pro-rated balance. The pro-ration itself lives in
--  `lib/leave/accrual.ts` and is proved by `tests/ui/leave.test.ts`;
--  reimplementing it in SQL would give the product two accrual engines
--  that have to agree forever. What this file proves is that the LEDGER
--  faithfully reports whatever the engine wrote, which is the half a
--  database can be responsible for.
-- =====================================================================


-- =====================================================================
--  STEP 0 — REFUSE TO RUN SOMEWHERE THAT MATTERS
-- =====================================================================
DO $$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production')
  THEN
    RAISE EXCEPTION
      '🔴 REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =====================================================================
--  STEP 1 — THE SHAPES, REPRODUCED FROM 0075 AND 0082
-- =====================================================================
--
--  `employees` and `payroll_runs` are cut down to the columns this drill
--  reasons about. Everything from 0082 is copied as it ships.

DROP TABLE IF EXISTS staff_attendance, leave_ledger, leave_requests,
                     leave_types, holiday_calendar, leave_periods,
                     payslips, payroll_runs, employees, users, tenants CASCADE;
DROP VIEW IF EXISTS leave_balance_report CASCADE;
DROP FUNCTION IF EXISTS leave_ledger_block_mutation() CASCADE;
DROP FUNCTION IF EXISTS ordence_guard_staff_attendance_frozen() CASCADE;
DROP TYPE IF EXISTS leave_accrual_method, leave_entry_kind,
                    leave_request_status, staff_attendance_status,
                    payroll_run_status CASCADE;

CREATE TABLE tenants (id uuid PRIMARY KEY);
CREATE TABLE users   (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TABLE employees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_code varchar(40) NOT NULL,
  full_name     varchar(200) NOT NULL,
  joined_on     date NOT NULL,
  left_on       date,
  is_active     boolean NOT NULL DEFAULT true
);

CREATE TYPE payroll_run_status AS ENUM
  ('draft', 'computed', 'approved', 'posted', 'cancelled');

CREATE TABLE payroll_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  run_no       varchar(30) NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  status       payroll_run_status NOT NULL DEFAULT 'draft'
);

CREATE TABLE payslips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES payroll_runs(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  payable_days numeric(6,2) NOT NULL,
  lop_days     numeric(6,2) NOT NULL DEFAULT 0
);

-- ---- 0082 enums, verbatim -------------------------------------------
CREATE TYPE leave_accrual_method AS ENUM
  ('monthly_earned', 'annual_advance', 'none');

CREATE TYPE leave_entry_kind AS ENUM
  ('opening_balance', 'accrual', 'carry_forward_in', 'lapse',
   'taken', 'encashed', 'adjustment',
   'commitment', 'commitment_release');

CREATE TYPE leave_request_status AS ENUM
  ('draft', 'submitted', 'approved', 'rejected', 'cancelled');

CREATE TYPE staff_attendance_status AS ENUM
  ('present', 'on_duty', 'weekly_off', 'holiday',
   'paid_leave', 'unpaid_leave', 'absent');

-- ---- 0082 section ①, verbatim ---------------------------------------
CREATE TABLE leave_periods (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  label     varchar(60) NOT NULL,
  starts_on date NOT NULL,
  ends_on   date NOT NULL,
  is_closed boolean NOT NULL DEFAULT false,
  CONSTRAINT leave_periods_dates_ordered CHECK (ends_on > starts_on),
  CONSTRAINT leave_periods_length_sane CHECK (ends_on - starts_on BETWEEN 27 AND 400)
);
CREATE UNIQUE INDEX leave_periods_start_key ON leave_periods (tenant_id, starts_on);
ALTER TABLE leave_periods ADD CONSTRAINT leave_periods_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&);

CREATE TABLE holiday_calendar (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  on_date         date NOT NULL,
  label           varchar(120) NOT NULL,
  work_state_code varchar(2),
  is_restricted   boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX holiday_calendar_date_key
  ON holiday_calendar (tenant_id, on_date, work_state_code) NULLS NOT DISTINCT;

-- ---- 0082 section ②, verbatim ---------------------------------------
CREATE TABLE leave_types (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenants(id),
  code                       varchar(20) NOT NULL,
  label                      varchar(120) NOT NULL,
  is_paid                    boolean NOT NULL DEFAULT true,
  accrual_method             leave_accrual_method NOT NULL DEFAULT 'monthly_earned',
  annual_entitlement_days    numeric(7,2) NOT NULL DEFAULT 0,
  accrual_round_to_days      numeric(4,2) NOT NULL DEFAULT 0.5,
  probation_days             integer NOT NULL DEFAULT 0,
  carry_forward_cap_days     numeric(7,2) NOT NULL DEFAULT 0,
  encashment_cap_days        numeric(7,2) NOT NULL DEFAULT 0,
  encashment_min_retain_days numeric(7,2) NOT NULL DEFAULT 0,
  allow_negative_balance     boolean NOT NULL DEFAULT false,
  max_negative_days          numeric(7,2) NOT NULL DEFAULT 0,
  counts_holidays_and_offs   boolean NOT NULL DEFAULT false,
  min_notice_days            integer NOT NULL DEFAULT 0,
  max_consecutive_days       numeric(7,2),
  allow_half_day             boolean NOT NULL DEFAULT true,
  display_order              integer NOT NULL DEFAULT 100,
  is_active                  boolean NOT NULL DEFAULT true,
  CONSTRAINT leave_types_entitlement_sane
    CHECK (annual_entitlement_days >= 0 AND annual_entitlement_days <= 365),
  CONSTRAINT leave_types_caps_sane
    CHECK (carry_forward_cap_days >= 0 AND encashment_cap_days >= 0
           AND encashment_min_retain_days >= 0 AND max_negative_days >= 0),
  CONSTRAINT leave_types_rounding_sane
    CHECK (accrual_round_to_days >= 0 AND accrual_round_to_days <= 1),
  CONSTRAINT leave_types_negative_consistent
    CHECK (allow_negative_balance OR max_negative_days = 0),
  CONSTRAINT leave_types_no_accrual_no_balance
    CHECK (accrual_method <> 'none'
           OR (annual_entitlement_days = 0
               AND carry_forward_cap_days = 0
               AND encashment_cap_days = 0)),
  CONSTRAINT leave_types_probation_sane
    CHECK (probation_days >= 0 AND probation_days <= 730)
);
CREATE UNIQUE INDEX leave_types_code_key ON leave_types (tenant_id, code);

-- ---- 0082 section ③, verbatim ---------------------------------------
CREATE TABLE leave_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  leave_type_id uuid NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  period_id     uuid NOT NULL REFERENCES leave_periods(id) ON DELETE RESTRICT,
  kind          leave_entry_kind NOT NULL,
  days_delta    numeric(7,2) NOT NULL,
  effective_on  date NOT NULL,
  request_id    uuid,
  attendance_id uuid,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_ledger_delta_non_zero CHECK (days_delta <> 0),
  CONSTRAINT leave_ledger_sign_matches_kind CHECK (
    (kind IN ('accrual', 'carry_forward_in', 'commitment_release') AND days_delta > 0)
    OR (kind IN ('lapse', 'taken', 'encashed', 'commitment') AND days_delta < 0)
    OR (kind IN ('opening_balance', 'adjustment'))
  ),
  CONSTRAINT leave_ledger_adjustment_explained CHECK (
    kind <> 'adjustment' OR (note IS NOT NULL AND length(btrim(note)) >= 3)
  ),
  CONSTRAINT leave_ledger_taken_from_attendance CHECK (
    kind <> 'taken' OR attendance_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX leave_ledger_accrual_once
  ON leave_ledger (tenant_id, employee_id, leave_type_id, effective_on)
  WHERE kind = 'accrual';

CREATE OR REPLACE FUNCTION leave_ledger_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'leave_ledger is append-only; % is not permitted. Correct a wrong entry with an adjustment in the opposite direction and a note.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER leave_ledger_no_update
  BEFORE UPDATE ON leave_ledger
  FOR EACH ROW EXECUTE FUNCTION leave_ledger_block_mutation();
CREATE TRIGGER leave_ledger_no_delete
  BEFORE DELETE ON leave_ledger
  FOR EACH ROW EXECUTE FUNCTION leave_ledger_block_mutation();

-- ---- 0082 section ④, verbatim ---------------------------------------
CREATE TABLE leave_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  leave_type_id  uuid NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  from_on        date NOT NULL,
  to_on          date NOT NULL,
  half_day_start boolean NOT NULL DEFAULT false,
  half_day_end   boolean NOT NULL DEFAULT false,
  days           numeric(7,2) NOT NULL,
  status         leave_request_status NOT NULL DEFAULT 'draft',
  reason         text,
  decided_at     timestamptz,
  decision_note  text,
  CONSTRAINT leave_requests_dates_ordered CHECK (to_on >= from_on),
  CONSTRAINT leave_requests_days_positive CHECK (days > 0 AND days <= 400),
  CONSTRAINT leave_requests_half_days_coherent CHECK (
    from_on <> to_on OR NOT (half_day_start AND half_day_end)
  ),
  CONSTRAINT leave_requests_rejection_explained CHECK (
    status <> 'rejected'
    OR (decision_note IS NOT NULL AND length(btrim(decision_note)) >= 3)
  ),
  CONSTRAINT leave_requests_decided_together CHECK (
    (status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)
  )
);
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_no_overlap
  EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(from_on, to_on, '[]') WITH &&
  ) WHERE (status IN ('submitted', 'approved'));

ALTER TABLE leave_ledger ADD CONSTRAINT leave_ledger_request_fk
  FOREIGN KEY (request_id) REFERENCES leave_requests(id) ON DELETE RESTRICT;

-- ---- 0082 section ⑤, verbatim ---------------------------------------
CREATE TABLE staff_attendance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  on_date       date NOT NULL,
  status        staff_attendance_status NOT NULL,
  lop_fraction  numeric(3,2) NOT NULL DEFAULT 0,
  leave_type_id uuid REFERENCES leave_types(id) ON DELETE RESTRICT,
  request_id    uuid REFERENCES leave_requests(id) ON DELETE RESTRICT,
  note          text,
  CONSTRAINT staff_attendance_fraction_sane CHECK (
    lop_fraction >= 0 AND lop_fraction <= 1
  ),
  CONSTRAINT staff_attendance_status_fraction_coherent CHECK (
    (status IN ('present', 'on_duty', 'weekly_off', 'holiday') AND lop_fraction = 0)
    OR (status = 'absent'       AND lop_fraction > 0)
    OR (status = 'unpaid_leave' AND lop_fraction > 0)
    OR (status = 'paid_leave')
  ),
  CONSTRAINT staff_attendance_leave_has_type CHECK (
    status NOT IN ('paid_leave', 'unpaid_leave') OR leave_type_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX staff_attendance_day_key
  ON staff_attendance (tenant_id, employee_id, on_date);

ALTER TABLE leave_ledger ADD CONSTRAINT leave_ledger_attendance_fk
  FOREIGN KEY (attendance_id) REFERENCES staff_attendance(id) ON DELETE RESTRICT;

-- ---- 0082 section ⑥, verbatim ---------------------------------------
CREATE OR REPLACE FUNCTION ordence_guard_staff_attendance_frozen()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid;
  v_date   date;
  v_run    record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id;
    v_date   := OLD.on_date;
  ELSE
    v_tenant := NEW.tenant_id;
    v_date   := NEW.on_date;
  END IF;

  SELECT r.run_no, r.status INTO v_run
    FROM payroll_runs r
   WHERE r.tenant_id = v_tenant
     AND r.status IN ('approved', 'posted')
     AND v_date BETWEEN r.period_start AND r.period_end
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Payroll run % is already % for the period containing %. Attendance for it cannot be changed — the wage bill has been signed off. Record the correction against the next payroll instead.',
      v_run.run_no, v_run.status, v_date
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ordence_guard_staff_attendance_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON staff_attendance
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_staff_attendance_frozen();

/*
 * THE BALANCE, AS A VIEW — the SQL twin of `foldLedger()` in
 * lib/leave/balance.ts and of section 6 of VERIFY-0082.
 *
 * ⭐ KEPT AS A VIEW SO EVERY ASSERTION BELOW READS `SELECT * FROM
 * leave_balance_report` and the drill cannot accidentally test a fold
 * that is not the shipped one.
 *
 * 🔴 NOTE THE TWO COLUMNS. `balance` is what has been earned and not
 * spent; `available` is that less what approvals have reserved. Decision
 * ④ is the difference between them, and POSITIVE 3 and POSITIVE 4 below
 * are that difference happening.
 */
CREATE VIEW leave_balance_report AS
SELECT e.employee_code,
       t.code AS leave_type,
       coalesce(sum(l.days_delta) FILTER (
         WHERE l.kind NOT IN ('commitment', 'commitment_release')), 0) AS balance,
       -coalesce(sum(l.days_delta) FILTER (
         WHERE l.kind IN ('commitment', 'commitment_release')), 0)     AS committed,
       coalesce(sum(l.days_delta), 0)                                  AS available,
       count(*)                                                        AS entries
  FROM leave_ledger l
  JOIN employees   e ON e.id = l.employee_id
  JOIN leave_types t ON t.id = l.leave_type_id
 GROUP BY e.employee_code, t.code
 ORDER BY e.employee_code, t.code;


-- =====================================================================
--  STEP 2 — A WORKSPACE
-- =====================================================================
--
--  Priya joined years ago: a full leave year, every time.
--  Ravi joined 20 October 2025: ⭐ THE MID-YEAR JOINER, who is the whole
--  reason decision ① exists.

\set T '''11111111-1111-1111-1111-111111111111'''

INSERT INTO tenants (id) VALUES (:T::uuid);

INSERT INTO employees (id, tenant_id, employee_code, full_name, joined_on)
VALUES ('22222222-2222-2222-2222-222222222222', :T::uuid, 'EMP-001', 'Priya Nair',  '2020-06-01'),
       ('33333333-3333-3333-3333-333333333333', :T::uuid, 'EMP-002', 'Ravi Kumar',  '2025-10-20');

\set PRIYA '''22222222-2222-2222-2222-222222222222'''
\set RAVI  '''33333333-3333-3333-3333-333333333333'''

INSERT INTO leave_periods (id, tenant_id, label, starts_on, ends_on)
VALUES ('44444444-4444-4444-4444-444444444444', :T::uuid, 'FY 2025-26', '2025-04-01', '2026-03-31');
\set FY '''44444444-4444-4444-4444-444444444444'''

--  EL earns monthly and carries at most 10 days. CL is granted up front.
--  LOP is never earned at all — an unpaid day is still applied for and
--  recorded, which is the only way the payslip and the register agree.
INSERT INTO leave_types (id, tenant_id, code, label, accrual_method,
                         annual_entitlement_days, carry_forward_cap_days,
                         counts_holidays_and_offs, is_paid)
VALUES ('55555555-5555-5555-5555-555555555555', :T::uuid, 'EL', 'Earned Leave',
        'monthly_earned', 18, 10, true, true),
       ('66666666-6666-6666-6666-666666666666', :T::uuid, 'CL', 'Casual Leave',
        'annual_advance', 12, 0, false, true),
       ('77777777-7777-7777-7777-777777777777', :T::uuid, 'LOP', 'Loss of Pay',
        'none', 0, 0, false, false);

\set EL  '''55555555-5555-5555-5555-555555555555'''
\set CL  '''66666666-6666-6666-6666-666666666666'''
\set LOP '''77777777-7777-7777-7777-777777777777'''

--  The payroll runs. December is still `computed` — nobody has signed it
--  off, so its attendance is still editable. November is `approved`.
INSERT INTO payroll_runs (id, tenant_id, run_no, period_start, period_end, status)
VALUES ('88888888-8888-8888-8888-888888888888', :T::uuid, 'PR-2025-11',
        '2025-11-01', '2025-11-30', 'approved'),
       ('99999999-9999-9999-9999-999999999999', :T::uuid, 'PR-2025-12',
        '2025-12-01', '2025-12-31', 'computed');


\set ON_ERROR_STOP off

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 1 — a full-year employee accrues month by month --'
--     🔴 THE ASSERTION THE WHOLE FILE HANGS ON. If ordinary accrual
--     entries do not produce an ordinary balance, every refusal below
--     passed for the wrong reason.
--
--     18 days a year, rounded to half days, cumulative: 1.5 a month.
-- ---------------------------------------------------------------------
INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on)
SELECT :T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'accrual', 1.5, d
  FROM generate_series('2025-04-30'::date, '2025-12-31'::date, '1 month') g(d);

SELECT * FROM leave_balance_report WHERE employee_code = 'EMP-001';
-- EXPECT: EL balance 13.50 over 9 entries (April to December), committed 0.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 2 — the MID-YEAR JOINER, which is decision ① -----'
--     ⚠️ A DEMONSTRATION, NOT A TEST OF THE ENGINE. The arithmetic lives
--     in lib/leave/accrual.ts; this shows the LEDGER reporting it
--     faithfully, which is the half a database is responsible for.
--
--     Ravi joined 20 October. By 31 March he has been on the rolls for
--     163 of the leave year's 365 days, so he has earned
--     18 × 163/365 = 8.04 days, which rounds to 8.00 at half-day
--     granularity.
--
--     🔴 THE WRONG ANSWER IS 18. It is what a system that grants the
--     entitlement on 1 April produces, it is on his screen, he will take
--     it, and the employer discovers in March that ten days of paid
--     absence per head were never earned and cannot be recovered.
-- ---------------------------------------------------------------------
SELECT '2026-03-31'::date - '2025-10-20'::date + 1                AS days_on_rolls,
       '2026-03-31'::date - '2025-04-01'::date + 1                AS days_in_leave_year,
       round(18 * (('2026-03-31'::date - '2025-10-20'::date + 1)::numeric
                   / ('2026-03-31'::date - '2025-04-01'::date + 1)), 2)
                                                                   AS earned_exact,
       round(18 * (('2026-03-31'::date - '2025-10-20'::date + 1)::numeric
                   / ('2026-03-31'::date - '2025-04-01'::date + 1)) / 0.5, 0) * 0.5
                                                                   AS earned_rounded,
       18                                                          AS what_a_grant_would_have_given;
-- EXPECT: 163 of 365 days, 8.04 exact, 8.00 rounded — against 18 granted.

INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on)
VALUES (:T::uuid, :RAVI::uuid, :EL::uuid, :FY::uuid, 'accrual', 8.00, '2026-03-31');

SELECT * FROM leave_balance_report WHERE employee_code = 'EMP-002';
-- EXPECT: EL balance 8.00, not 18.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 3 — APPROVING leave COMMITS it, it does not spend it'
--     🔴 DECISION ④. Priya is approved for 22–24 December, three days.
--     Her BALANCE must not move: she has not been absent yet, and people
--     cancel plans and come in anyway. Her AVAILABLE must drop, or two
--     applications can be approved against the same three days.
-- ---------------------------------------------------------------------
INSERT INTO leave_requests (id, tenant_id, employee_id, leave_type_id,
                            from_on, to_on, days, status, decided_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', :T::uuid, :PRIYA::uuid, :EL::uuid,
        '2025-12-22', '2025-12-24', 3, 'approved', now());

INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on, request_id)
VALUES (:T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'commitment', -3, '2025-12-22',
        'aaaaaaaa-0000-0000-0000-000000000001');

SELECT * FROM leave_balance_report WHERE employee_code = 'EMP-001';
-- EXPECT: balance still 13.50, committed 3.00, available 10.50.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 1 — a `taken` entry with NO attendance behind it --'
--     🔴 DECISION ④ AS A CONSTRAINT RATHER THAN A CONVENTION. This is
--     the write an approval handler would make if somebody "simplified"
--     the flow by spending the days at approval time. Once one of these
--     exists, nobody can tell which days the employee was actually
--     absent, and the leave register and the payslip stop being about
--     the same thing.
-- ---------------------------------------------------------------------
INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on, request_id)
VALUES (:T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'taken', -3, '2025-12-22',
        'aaaaaaaa-0000-0000-0000-000000000001');
-- EXPECT: ERROR 23514 violates check constraint "leave_ledger_taken_from_attendance"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 4 — RECORDING attendance is what spends the days -'
--     The 22nd arrives, Priya is in fact away, and attendance says so.
--     Now — and only now — a `taken` entry moves the balance, and a
--     `commitment_release` cancels one day of the reservation.
-- ---------------------------------------------------------------------
INSERT INTO staff_attendance (id, tenant_id, employee_id, on_date, status,
                              lop_fraction, leave_type_id, request_id)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', :T::uuid, :PRIYA::uuid,
        '2025-12-22', 'paid_leave', 0, :EL::uuid,
        'aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on, request_id, attendance_id)
VALUES (:T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'taken', -1, '2025-12-22',
        'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001'),
       (:T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'commitment_release', 1, '2025-12-22',
        'aaaaaaaa-0000-0000-0000-000000000001', NULL);

SELECT * FROM leave_balance_report WHERE employee_code = 'EMP-001';
-- EXPECT: balance 12.50 (one day spent), committed 2.00, available 10.50.
--         ⭐ AVAILABLE IS UNCHANGED AT 10.50 AND THAT IS THE POINT — the
--         day moved from reserved to spent, and the employee's room to
--         apply for more did not change when it did.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 2 — the ledger cannot be UPDATED ------------------'
--     A wrong entry is corrected with an `adjustment` in the opposite
--     direction and a note. A balance somebody can quietly edit is not an
--     argument an employee can have.
-- ---------------------------------------------------------------------
UPDATE leave_ledger SET days_delta = -0.5 WHERE kind = 'taken';
-- EXPECT: ERROR — leave_ledger is append-only; UPDATE is not permitted

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 3 — and it cannot be DELETED ----------------------'
-- ---------------------------------------------------------------------
DELETE FROM leave_ledger WHERE kind = 'commitment';
-- EXPECT: ERROR — leave_ledger is append-only; DELETE is not permitted

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 5 — a correction is an ADJUSTMENT with a note ----'
--     The append-only rule is survivable precisely because this works.
-- ---------------------------------------------------------------------
INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on, note)
VALUES (:T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'adjustment', 0.5, '2025-12-31',
        'Half day on 22 December was recorded as a full day. Corrected by A. Rao.')
RETURNING kind, days_delta, note;
-- EXPECT: one row. (RETURNING because `psql -q` suppresses the command
--         tag, and a positive nobody can see in the transcript is not one.)

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 4 — an adjustment with NO note --------------------'
--     The entry most likely to be disputed is the one a human typed.
-- ---------------------------------------------------------------------
INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on)
VALUES (:T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'adjustment', 5, '2025-12-31');
-- EXPECT: ERROR 23514 violates check constraint "leave_ledger_adjustment_explained"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 5 — the accrual cannot run twice for one month ----'
--     ⚠️ THE MOST LIKELY REAL INCIDENT IN THIS WHOLE MODULE. A cron that
--     retried, an admin who clicked again because the first click seemed
--     slow, a deploy that replayed a queue. Without the index the second
--     run is SILENT and everybody is a month richer, forever.
-- ---------------------------------------------------------------------
INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on)
VALUES (:T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'accrual', 1.5, '2025-11-30');
-- EXPECT: ERROR 23505 duplicate key value violates unique constraint
--         "leave_ledger_accrual_once"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 6 — an accrual with a NEGATIVE delta --------------'
--     The sign is part of the meaning. A negative `accrual` folds into a
--     balance that looks entirely reasonable and is short by whatever it
--     was.
-- ---------------------------------------------------------------------
INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on)
VALUES (:T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'accrual', -1.5, '2026-01-31');
-- EXPECT: ERROR 23514 violates check constraint "leave_ledger_sign_matches_kind"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 7 — nobody is on two leaves at once ---------------'
--     ⚠️ THE COMMONEST DOUBLE-COUNT IN LEAVE ADMINISTRATION. Casual
--     leave 10–14 March, then sick leave 12–16 March, approved by
--     different people on different days. Two commitments for the same
--     three dates, the balance reduced twice, and when attendance is
--     finally recorded there is one row per date and no way to say which
--     request it belonged to.
-- ---------------------------------------------------------------------
INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id,
                            from_on, to_on, days, status)
VALUES (:T::uuid, :PRIYA::uuid, :CL::uuid, '2025-12-23', '2025-12-26', 4, 'submitted');
-- EXPECT: ERROR 23P01 conflicting key value violates exclusion constraint
--         "leave_requests_no_overlap"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 6 — a non-overlapping application is fine --------'
--     Paired with refusal 7 so the constraint cannot be passing by
--     rejecting everything.
-- ---------------------------------------------------------------------
INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id,
                            from_on, to_on, days, status)
VALUES (:T::uuid, :PRIYA::uuid, :CL::uuid, '2026-01-05', '2026-01-06', 2, 'submitted')
RETURNING from_on, to_on, days, status;
-- EXPECT: one row.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 8 — a CANCELLED request does not block a new one --'
--     ⚠️ THIS ONE IS A POSITIVE WEARING A REFUSAL''S NUMBER, DELIBERATELY.
--     The exclusion constraint is partial: `submitted` and `approved`
--     only. If it covered every status, cancelling a holiday and
--     rebooking the same week would be impossible, which is a support
--     ticket a week and would be "fixed" by dropping the constraint.
-- ---------------------------------------------------------------------
UPDATE leave_requests SET status = 'cancelled'
 WHERE from_on = '2026-01-05';
INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id,
                            from_on, to_on, days, status)
VALUES (:T::uuid, :PRIYA::uuid, :CL::uuid, '2026-01-05', '2026-01-06', 2, 'submitted')
RETURNING from_on, to_on, status;
-- EXPECT: one row. The cancelled application no longer reserves the dates.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 9 — two overlapping LEAVE YEARS -------------------'
--     "Which period does 12 August belong to" must have one answer, or
--     the accrual credits the same month twice, once in each. An
--     off-by-one on an end date — 31 March against 1 April — is exactly
--     how the overlap gets typed.
-- ---------------------------------------------------------------------
INSERT INTO leave_periods (tenant_id, label, starts_on, ends_on)
VALUES (:T::uuid, 'FY 2026-27', '2026-03-31', '2027-03-30');
-- EXPECT: ERROR 23P01 conflicting key value violates exclusion constraint
--         "leave_periods_no_overlap"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 7 — the next leave year, starting the day after --'
-- ---------------------------------------------------------------------
INSERT INTO leave_periods (id, tenant_id, label, starts_on, ends_on)
VALUES ('cccccccc-0000-0000-0000-000000000001', :T::uuid,
        'FY 2026-27', '2026-04-01', '2027-03-31')
RETURNING label, starts_on, ends_on;
-- EXPECT: one row.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 8 — CARRY-FORWARD IS CAPPED, decision ③ ----------'
--     Priya closes FY 2025-26 with 13.00 days of EL. The cap is 10.
--     ⭐ 10 CARRY AND 3 LAPSE, AND THE LAPSE IS AN ENTRY WITH A REASON ON
--     IT rather than a number that quietly went missing. An employee who
--     asks what happened to their three days gets a date and a sentence.
--
--     🔴 WITHOUT THE CAP: thirty people leaving five days a year unused
--     is 900 days of obligation after six years that has never appeared
--     in a management account, payable in cash the first time a team
--     turns over.
-- ---------------------------------------------------------------------
SELECT balance AS closing_balance,
       (SELECT carry_forward_cap_days FROM leave_types WHERE id = :EL::uuid) AS cap,
       least(balance, (SELECT carry_forward_cap_days FROM leave_types WHERE id = :EL::uuid))
         AS will_carry,
       balance - least(balance, (SELECT carry_forward_cap_days FROM leave_types WHERE id = :EL::uuid))
         AS will_lapse
  FROM leave_balance_report WHERE employee_code = 'EMP-001' AND leave_type = 'EL';

INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, period_id,
                          kind, days_delta, effective_on, note)
VALUES (:T::uuid, :PRIYA::uuid, :EL::uuid, :FY::uuid, 'lapse', -3.00, '2026-03-31',
        'Carry-forward cap for Earned Leave is 10 days. 3 days above it lapsed at the close of FY 2025-26.'),
       (:T::uuid, :PRIYA::uuid, :EL::uuid, 'cccccccc-0000-0000-0000-000000000001',
        'carry_forward_in', 10.00, '2026-04-01',
        'Carried forward from FY 2025-26, within the 10-day cap.');

SELECT * FROM leave_balance_report WHERE employee_code = 'EMP-001';
-- EXPECT: EL balance 20.00 across both periods — 13 closing, less 3
--         lapsed, plus 10 carried in. The 3 days are visible as an entry.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 10 — a weekly off cannot carry loss of pay --------'
--     Somebody has been docked for a Sunday. One keystroke on a grid of
--     thirty days, and it does not look wrong in a list.
-- ---------------------------------------------------------------------
INSERT INTO staff_attendance (tenant_id, employee_id, on_date, status, lop_fraction)
VALUES (:T::uuid, :PRIYA::uuid, '2025-12-28', 'weekly_off', 1);
-- EXPECT: ERROR 23514 violates check constraint
--         "staff_attendance_status_fraction_coherent"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 11 — an ABSENT day cannot be paid in full ---------'
--     The opposite keystroke, and the one that costs the employer.
-- ---------------------------------------------------------------------
INSERT INTO staff_attendance (tenant_id, employee_id, on_date, status, lop_fraction)
VALUES (:T::uuid, :PRIYA::uuid, '2025-12-29', 'absent', 0);
-- EXPECT: ERROR 23514 violates check constraint
--         "staff_attendance_status_fraction_coherent"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 9 — a HALF day of loss of pay on PAID leave ------'
--     🔴 THE CASE A STATUS-ONLY MODEL CANNOT EXPRESS AT ALL, and the
--     reason `lop_fraction` is a column rather than a derivation of the
--     status. Ravi takes a full day off with half a day of balance left:
--     half of it is leave, half of it is loss of pay.
-- ---------------------------------------------------------------------
INSERT INTO staff_attendance (tenant_id, employee_id, on_date, status,
                              lop_fraction, leave_type_id)
VALUES (:T::uuid, :RAVI::uuid, '2025-12-15', 'paid_leave', 0.50, :EL::uuid)
RETURNING on_date, status, lop_fraction;
-- EXPECT: one row, lop_fraction 0.50.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 12 — two verdicts for one person on one day -------'
--     Two rows for one day double the loss of pay, and a payslip short by
--     a plausible amount is the hardest kind of error to notice.
-- ---------------------------------------------------------------------
INSERT INTO staff_attendance (tenant_id, employee_id, on_date, status, lop_fraction)
VALUES (:T::uuid, :RAVI::uuid, '2025-12-15', 'present', 0);
-- EXPECT: ERROR 23505 duplicate key value violates unique constraint
--         "staff_attendance_day_key"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 13 — attendance for an APPROVED payroll period ----'
--     🔴 THE MOST DAMAGING SEQUENCE IN THE MODULE, AS TWO ORDINARY
--     CLICKS: November payroll is approved and paid; somebody then
--     corrects a November attendance row. The register now says one thing
--     and the payslip that was paid says another, and neither is wrong on
--     its own terms.
-- ---------------------------------------------------------------------
INSERT INTO staff_attendance (tenant_id, employee_id, on_date, status, lop_fraction)
VALUES (:T::uuid, :RAVI::uuid, '2025-11-14', 'absent', 1);
-- EXPECT: ERROR — Payroll run PR-2025-11 is already approved for the
--         period containing 2025-11-14 ...

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 10 — a run that is only COMPUTED does not freeze -'
--     ⚠️ PAIRED WITH REFUSAL 13 ON PURPOSE. Recomputing a run nobody has
--     signed off is ordinary work, and locking attendance the moment
--     somebody presses Compute would make the correction loop impossible
--     and the freeze would be turned off within a week.
-- ---------------------------------------------------------------------
INSERT INTO staff_attendance (tenant_id, employee_id, on_date, status, lop_fraction)
VALUES (:T::uuid, :RAVI::uuid, '2025-12-16', 'absent', 1)
RETURNING on_date, status, lop_fraction;
-- EXPECT: one row. December is `computed`, not `approved`.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 14 — a never-earned type with a carry-forward cap -'
--     Loss of pay with a carry-forward cap of 5 is not a policy, it is a
--     row nobody read back.
-- ---------------------------------------------------------------------
INSERT INTO leave_types (tenant_id, code, label, accrual_method,
                         annual_entitlement_days, carry_forward_cap_days)
VALUES (:T::uuid, 'LWP', 'Leave Without Pay', 'none', 0, 5);
-- EXPECT: ERROR 23514 violates check constraint
--         "leave_types_no_accrual_no_balance"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- 🔴 REFUSAL 15 — a negative-balance limit on a type that ------'
\echo '                    forbids negative balances --------------------'
--     A stale number in a row is a lie the next reader believes.
-- ---------------------------------------------------------------------
INSERT INTO leave_types (tenant_id, code, label, allow_negative_balance, max_negative_days)
VALUES (:T::uuid, 'SL', 'Sick Leave', false, 3);
-- EXPECT: ERROR 23514 violates check constraint
--         "leave_types_negative_consistent"

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 11 — WHAT PAYROLL READS, WHICH IS BATCH 50 -------'
--     🔴 THE QUERY THAT REPLACES `attendance: []` IN
--     components/payroll/payroll-run-board.tsx. One row per employee,
--     `lopDays` summed from the register. `payableDays` is NOT computed
--     here — server/payroll/run.ts already derives days on the rolls and
--     gets joiners and leavers right; the one thing attendance adds to
--     the money is the loss of pay.
-- ---------------------------------------------------------------------
SELECT e.employee_code,
       e.full_name,
       sum(a.lop_fraction) AS lop_days,
       count(*)            AS days_recorded
  FROM staff_attendance a
  JOIN employees e ON e.id = a.employee_id
  JOIN payroll_runs r
    ON r.id = '99999999-9999-9999-9999-999999999999'
   AND a.on_date BETWEEN r.period_start AND r.period_end
 WHERE a.tenant_id = :T::uuid
   AND a.lop_fraction > 0
 GROUP BY e.employee_code, e.full_name
 ORDER BY e.employee_code;
-- EXPECT: EMP-002 with 1.50 days of loss of pay across 2 recorded days —
--         the half day on the 15th and the full day on the 16th.
--         🔴 UNDER THE HARDCODED `attendance: []` THIS IS THE NUMBER THE
--         DECEMBER PAYSLIPS WOULD HAVE IGNORED.

-- ---------------------------------------------------------------------
\echo ''
\echo '--- ⭐ POSITIVE 12 — there is NO stored balance table ------------'
--     🔴 DECISION ②, VERIFIED BY ABSENCE. Every number above came out of
--     a fold over the ledger. If a `leave_balances` table ever appears,
--     the balance has two sources and they will disagree — and the
--     employee, who has their own list of the days they took, will be the
--     one who notices.
-- ---------------------------------------------------------------------
SELECT count(*) AS stored_balance_tables
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND (c.relname LIKE '%leave_balance%' OR c.relname LIKE '%leave_entitlement%');
-- EXPECT: 0.

\set ON_ERROR_STOP on

-- =====================================================================
--  SUMMARY OF WHAT MUST HAVE HAPPENED
-- =====================================================================
--   12 positives succeeded
--   15 refusals raised an error
--
--  ⚠️ IF POSITIVE 1 DID NOT SHOW A BALANCE OF 13.50, STOP AND READ
--  NOTHING ELSE. A ledger that cannot record an ordinary accrual makes
--  every refusal below it pass for the wrong reason.
--
--  ⚠️ AND IF REFUSAL 8 RAISED AN ERROR, THE EXCLUSION CONSTRAINT IS NOT
--  PARTIAL. That is not stricter, it is broken: cancelling a holiday and
--  rebooking the same week becomes impossible, which is a support ticket
--  a week until somebody drops the constraint entirely and the real
--  double-booking comes back with it.
-- =====================================================================
