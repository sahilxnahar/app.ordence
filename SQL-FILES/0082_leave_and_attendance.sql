-- =====================================================================
--  ORDENCE — 0082 · LEAVE, ACCRUAL, AND STAFF ATTENDANCE
--  Version: v1.46.0-alpha · Batch 59
--
--  ⚠️ RUN AFTER 0081. Six new tables, four new enums, three triggers.
--  It reads `employees` and `payroll_runs` from 0075 and touches
--  neither.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded: tables are CREATE ...
--     IF NOT EXISTS, enums are created inside an exception handler,
--     constraints are DROP ... IF EXISTS then ADD, indexes are CREATE
--     ... IF NOT EXISTS, functions are CREATE OR REPLACE, all inside one
--     transaction.
--
--  ⭐ RUN THIS BEFORE PUSHING THE CODE. It is purely additive — nothing
--     that exists today reads or writes any of it — so on the current
--     build the file is inert. The new code, however, SELECTs from
--     `staff_attendance` and `leave_ledger`, and against a database
--     without them every leave screen raises 42P01.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 WHAT THIS UNBLOCKS, IN ONE PARAGRAPH
--  ══════════════════════════════════════════════════════════════════
--  `components/payroll/payroll-run-board.tsx` passes `attendance: []`
--  to the payroll compute. It is HARDCODED, so loss of pay can never be
--  entered and every run pays every salaried person a full month. It is
--  hardcoded because there was no table to read from: `site_attendance`
--  (0031, labour) records check-in/check-out punches for CONTRACT
--  LABOUR, who are brought by a vendor, paid through that vendor's RA
--  bill, and are on nobody's payroll. Giving them payslips would
--  misstate the employment relationship in a way a labour inspector
--  cares about, which is why `employees` and `site_workers` are separate
--  tables in the first place.
--
--  ⭐ `staff_attendance` BELOW IS THE MISSING TABLE. One row per
--  employee per day, carrying the one number payroll needs from it —
--  `lop_fraction`.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 THE FOUR DECISIONS THIS FILE IS MADE OF
--  ══════════════════════════════════════════════════════════════════
--
--  ① ACCRUAL IS EARNED, NOT GRANTED. The default method is
--     `monthly_earned`: entitlement is earned across the leave year in
--     proportion to the days the employee was actually on the rolls, and
--     written as a dated ledger entry at each month end. A full year's
--     balance appearing on 1 April for somebody who joined in October is
--     a liability the business does not owe, cannot recover, and will
--     discover in March when half a year of staffing cost has gone out
--     as paid absence. `annual_advance` exists because casual and sick
--     leave are commonly granted up front in India — and even under it
--     `lib/leave/accrual.ts` pro-rates a part-year joiner, because
--     granting a full year to somebody who will be there for five months
--     is the specific mistake this batch exists to prevent.
--
--  ② A BALANCE IS DERIVED FROM ENTRIES, NEVER STORED. 🔴 THERE IS NO
--     `leave_balances` TABLE IN THIS FILE AND ITS ABSENCE IS THE DESIGN.
--     A stored balance is a cache of a sum, and a cache that disagrees
--     with its ledger is unarguable with an employee: they have their own
--     list of the days they took. `leave_ledger` is append-only by
--     trigger and the balance is `sum(days_delta)`.
--
--  ③ CARRY-FORWARD AND ENCASHMENT HAVE CAPS, AND THE CAPS ARE NOT NULL
--     WITH NO "UNLIMITED" SENTINEL. Thirty people leaving five days a
--     year unused, carried without limit, is 900 days of obligation after
--     six years that has never appeared in a single management account,
--     and it becomes cash in one quarter the first time a team turns
--     over. Zero — use it or lose it — is a perfectly good answer. It
--     just has to be typed.
--
--  ④ AN APPROVED REQUEST AND AN ATTENDANCE RECORD ARE DIFFERENT FACTS.
--     Approving four days in December COMMITS four days; it does not
--     spend them. People cancel plans and come in anyway. The balance
--     moves only when `staff_attendance` says the person was actually
--     absent on an actual date — and `leave_ledger_taken_from_attendance`
--     below is that rule as a CHECK constraint rather than a convention.
--
--  ══════════════════════════════════════════════════════════════════
--  ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT STORE
--  ══════════════════════════════════════════════════════════════════
--  NO GENDER. NO MARITAL STATUS. NO PREGNANCY DATE. NO MEDICAL
--  CERTIFICATE CONTENT. NO DIAGNOSIS.
--
--  🔴 THIS IS THE ONE PLACE IN THE PRODUCT WHERE THE OBVIOUS FEATURE IS
--  THE DANGEROUS ONE. "Maternity leave needs to know who is eligible" is
--  true, and the version of it that stores a gender flag and an expected
--  date of delivery turns a leave table into special-category health data
--  that every support session can read. Maternity is modelled as a leave
--  TYPE, assigned by an `adjustment` entry made by a human who decided
--  eligibility off-system. What is recorded is the entitlement, never the
--  reason for it.
-- =====================================================================

BEGIN;

-- ⚠️ REQUIRED BY THE OVERLAP CONSTRAINTS BELOW. A GiST index handles a
-- daterange natively but not the uuid it has to be paired with, so
-- `EXCLUDE USING gist (tenant_id WITH =, ...)` needs btree_gist. Already
-- installed by 0005, 0021 and 0033; repeated because a file that only
-- works when its neighbours ran first is a file that fails on a fresh
-- database at 2am.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =====================================================================
--  ENUMS
-- =====================================================================

--  ⭐ HOW A LEAVE TYPE COMES INTO EXISTENCE FOR AN EMPLOYEE.
--  `monthly_earned` is the default and the recommended answer.
--  `annual_advance` changes the TIMING — the whole pro-rated entitlement
--  is available on day one — and carries the real cost that somebody who
--  takes it all in April and resigns in May has been paid for days they
--  did not earn. `none` is for types that are never earned; loss of pay
--  is the obvious one.
DO $$ BEGIN
  CREATE TYPE leave_accrual_method AS ENUM
    ('monthly_earned', 'annual_advance', 'none');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--  🔴 THE VOCABULARY OF THE LEDGER. Every one of these is a row with a
--  sign on it: `days_delta` is signed, and the kind says why.
--
--  ⚠️ THE SPLIT BETWEEN THE FIRST SEVEN AND THE LAST TWO IS DECISION ④.
--  A `commitment` is what an APPROVAL writes. It never changes what has
--  been earned; it changes what may still be applied for.
DO $$ BEGIN
  CREATE TYPE leave_entry_kind AS ENUM
    ('opening_balance', 'accrual', 'carry_forward_in', 'lapse',
     'taken', 'encashed', 'adjustment',
     'commitment', 'commitment_release');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE leave_request_status AS ENUM
    ('draft', 'submitted', 'approved', 'rejected', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--  🔴 THE STATUS IS THE FACT; `lop_fraction` IS THE MONEY. They are
--  stored separately and not derived from each other, which looks
--  redundant and is not — `paid_leave` with half a day of loss of pay is
--  somebody who took a full day against half a day of balance, which is
--  an extremely common Indian payroll case a status-only model cannot
--  express at all.
DO $$ BEGIN
  CREATE TYPE staff_attendance_status AS ENUM
    ('present', 'on_duty', 'weekly_off', 'holiday',
     'paid_leave', 'unpaid_leave', 'absent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
--  ① THE LEAVE YEAR
-- =====================================================================
--
--  ⭐ THE LEAVE YEAR IS A ROW, NOT A CONSTANT. Hardcoding 1 April – 31
--  March would be wrong for a large minority of Indian employers:
--  calendar-year leave years are common in multinationals and
--  joining-anniversary years exist. A constant in code means the only
--  workspaces the product fits are the ones that guessed the way we did.
--
--  🔴 `is_closed` IS NOT A DISPLAY FLAG. Closing a period is the event
--  that writes the carry-forward and lapse entries, and this column is
--  the record that it has already happened — which is what stops it
--  running twice and doubling everybody's opening balance.
CREATE TABLE IF NOT EXISTS leave_periods (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    label           varchar(60) NOT NULL,
    starts_on       date NOT NULL,
    ends_on         date NOT NULL,          -- inclusive: 31 March, not 1 April

    is_closed       boolean NOT NULL DEFAULT false,
    closed_at       timestamptz,
    closed_by       uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT leave_periods_dates_ordered CHECK (ends_on > starts_on),
    --  ⚠️ A "LEAVE YEAR" OF FOUR YEARS IS NOT A LEAVE YEAR. The accrual
    --  divides the entitlement across the period, so a length nobody
    --  meant silently changes everybody's monthly accrual rate.
    CONSTRAINT leave_periods_length_sane
      CHECK (ends_on - starts_on BETWEEN 27 AND 400)
);

CREATE UNIQUE INDEX IF NOT EXISTS leave_periods_id_tenant_key
    ON leave_periods (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS leave_periods_start_key
    ON leave_periods (tenant_id, starts_on);
CREATE INDEX IF NOT EXISTS leave_periods_range_idx
    ON leave_periods (tenant_id, starts_on, ends_on);

--  🔴 TWO OVERLAPPING LEAVE YEARS MAKE "WHICH PERIOD DOES 12 AUGUST
--  BELONG TO" UNANSWERABLE, and the accrual would credit the same month
--  twice — once in each. The unique index on `starts_on` above catches
--  the duplicate but not the overlap, and an off-by-one on an end date
--  (31 March vs 1 April) is exactly how the overlap gets typed.
ALTER TABLE leave_periods DROP CONSTRAINT IF EXISTS leave_periods_no_overlap;
ALTER TABLE leave_periods ADD  CONSTRAINT leave_periods_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  );

--  ⭐ DECLARED HOLIDAYS, BECAUSE OTHERWISE "FIVE DAYS OF LEAVE" IS
--  AMBIGUOUS.
--
--  ⚠️ NOT `court_holidays` (0043) AND NOT THE SCHEDULING MODULE'S
--  `holiday` BLOCK REASON. Those answer "is the registry open" and "is
--  this room bookable". This one answers "does Thursday come out of the
--  employee's balance", which is a money question with a different owner
--  and a different list — a company observes Ugadi whether or not the
--  High Court does.
--
--  🔴 `is_restricted` IS THE INDIAN SPECIFIC MOST PRODUCTS MISS. A
--  restricted holiday is published but paid only if the employee elects
--  it, and each employee gets a fixed number of elections. Modelling it
--  as an ordinary holiday pays everybody for every festival on the list.
CREATE TABLE IF NOT EXISTS holiday_calendar (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    on_date         date NOT NULL,
    label           varchar(120) NOT NULL,

    --  ⚠️ NULL MEANS EVERY LOCATION, which is the common case and so the
    --  default. Holiday lists are frequently per-State in India:
    --  Maharashtra observes Gudi Padwa, Karnataka observes Ugadi, and a
    --  company with offices in both publishes two lists.
    work_state_code varchar(2),

    is_restricted   boolean NOT NULL DEFAULT false,

    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS holiday_calendar_id_tenant_key
    ON holiday_calendar (id, tenant_id);
--  ⚠️ THE STATE CODE IS PART OF THE KEY, so one date can be a holiday in
--  Karnataka and a working day in Maharashtra. NULLS NOT DISTINCT so that
--  two "every location" rows for one date are still a duplicate import.
CREATE UNIQUE INDEX IF NOT EXISTS holiday_calendar_date_key
    ON holiday_calendar (tenant_id, on_date, work_state_code) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS holiday_calendar_date_idx
    ON holiday_calendar (tenant_id, on_date);

-- =====================================================================
--  ② THE LEAVE TYPES — THE POLICY, WRITTEN DOWN AS COLUMNS
-- =====================================================================
--
--  🔴 WHAT THIS TABLE IS NOT: A STATUTORY CALCULATOR.
--
--  Indian leave entitlement is not one rule. Earned leave for a factory
--  worker comes from section 79 of the Factories Act 1948 — one day for
--  every twenty days worked, credited in the FOLLOWING year, with its own
--  carry-forward limit. Everybody else is covered by their State's Shops
--  and Establishments Act, and those differ from each other on the number
--  of days, on whether sick and casual leave are separate, and on what
--  lapses.
--
--  ⚠️ ORDENCE DOES NOT KNOW WHICH ACT APPLIES TO A GIVEN EMPLOYEE, AND A
--  PRODUCT THAT GUESSED WOULD BE CONFIDENTLY WRONG FOR MOST OF ITS
--  USERS. So this table models the CONTRACTUAL policy the employer has
--  actually decided, and the screen says that it must be at least the
--  statutory minimum for the establishment. The check is a human's, made
--  once, and recorded here.
CREATE TABLE IF NOT EXISTS leave_types (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    code                      varchar(20) NOT NULL,
    label                     varchar(120) NOT NULL,

    --  🔴 FALSE MEANS EVERY DAY TAKEN IS LOSS OF PAY. Loss of pay is a
    --  leave TYPE rather than the absence of one, so an unpaid day is
    --  applied for, approved and recorded exactly like any other — which
    --  is the only way the payroll number and the leave register ever
    --  agree.
    is_paid                   boolean NOT NULL DEFAULT true,

    accrual_method            leave_accrual_method NOT NULL DEFAULT 'monthly_earned',
    annual_entitlement_days   numeric(7,2) NOT NULL DEFAULT 0,

    --  ⭐ ROUNDING, STORED AND EXPLICIT, BECAUSE IT IS THE FIRST THING AN
    --  EMPLOYEE NOTICES. ⚠️ IT IS APPLIED TO THE CUMULATIVE TARGET AND
    --  NOT TO EACH MONTH — see lib/leave/accrual.ts. Rounding each month
    --  independently turns 1.25 days a month into 18 days a year against
    --  an entitlement of 15, and the error is invisible until March.
    accrual_round_to_days     numeric(4,2) NOT NULL DEFAULT 0.5,

    --  ⚠️ PROBATION, COUNTED FROM JOINING AND NOT FROM 1 APRIL. A version
    --  measured from the start of the leave year would re-impose it on
    --  every employee every year.
    probation_days            integer NOT NULL DEFAULT 0,

    --  🔴🔴 DECISION ③. NOT NULL, AND NO SENTINEL FOR "UNLIMITED".
    carry_forward_cap_days    numeric(7,2) NOT NULL DEFAULT 0,
    encashment_cap_days       numeric(7,2) NOT NULL DEFAULT 0,
    --  ⚠️ WHAT MUST REMAIN AFTER AN ENCASHMENT. Encashing to zero and
    --  then falling ill is how an employee ends up on loss of pay in the
    --  month after they were paid for their leave.
    encashment_min_retain_days numeric(7,2) NOT NULL DEFAULT 0,

    allow_negative_balance    boolean NOT NULL DEFAULT false,
    max_negative_days         numeric(7,2) NOT NULL DEFAULT 0,

    --  🔴 THE OTHER MOST ARGUED-ABOUT FLAG, AFTER `pro_rates` IN PAYROLL.
    --  TRUE: an intervening Sunday or declared holiday inside a leave
    --  block is deducted — usual for earned/privilege leave. FALSE: only
    --  working days come out — usual for casual and sick leave. Getting
    --  it backwards on one type costs every employee who takes a long
    --  holiday exactly two days a week, and it looks plausible
    --  throughout.
    counts_holidays_and_offs  boolean NOT NULL DEFAULT false,

    min_notice_days           integer NOT NULL DEFAULT 0,
    max_consecutive_days      numeric(7,2),          -- NULL means no limit
    allow_half_day            boolean NOT NULL DEFAULT true,

    display_order             integer NOT NULL DEFAULT 100,
    is_active                 boolean NOT NULL DEFAULT true,
    notes                     text,

    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT leave_types_entitlement_sane CHECK (
        annual_entitlement_days >= 0 AND annual_entitlement_days <= 365
    ),
    CONSTRAINT leave_types_caps_sane CHECK (
        carry_forward_cap_days >= 0 AND encashment_cap_days >= 0
        AND encashment_min_retain_days >= 0 AND max_negative_days >= 0
    ),
    --  ⚠️ ROUNDING GRANULARITY ABOVE ONE DAY IS NOT ROUNDING, IT IS A
    --  DIFFERENT ACCRUAL POLICY, and it would round a 1.25-day month to
    --  zero forever.
    CONSTRAINT leave_types_rounding_sane CHECK (
        accrual_round_to_days >= 0 AND accrual_round_to_days <= 1
    ),
    --  A stale negative limit on a type that forbids negatives is a lie.
    CONSTRAINT leave_types_negative_consistent CHECK (
        allow_negative_balance OR max_negative_days = 0
    ),
    --  🔴 A TYPE THAT IS NEVER EARNED CANNOT CARRY FORWARD OR BE ENCASHED.
    --  Loss of pay with a carry-forward cap of 5 is not a policy, it is a
    --  row nobody read back.
    CONSTRAINT leave_types_no_accrual_no_balance CHECK (
        accrual_method <> 'none'
        OR (annual_entitlement_days = 0
            AND carry_forward_cap_days = 0
            AND encashment_cap_days = 0)
    ),
    CONSTRAINT leave_types_probation_sane CHECK (
        probation_days >= 0 AND probation_days <= 730
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS leave_types_id_tenant_key
    ON leave_types (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS leave_types_code_key
    ON leave_types (tenant_id, code);
CREATE INDEX IF NOT EXISTS leave_types_active_idx
    ON leave_types (tenant_id, is_active, display_order);

-- =====================================================================
--  ③ THE LEDGER — DECISION ②
-- =====================================================================
--
--  ⭐⭐⭐ EVERY MOVEMENT OF EVERY BALANCE, AND THE ONLY PLACE A BALANCE
--  COMES FROM.
--
--  🔴 APPEND-ONLY BY TRIGGER, LIKE `audit_logs`. A mistaken entry is
--  corrected by an `adjustment` in the opposite direction with a note,
--  exactly as a mistaken journal entry is reversed rather than erased.
--
--  ⚠️ WHICH IS WHY EVERY FOREIGN KEY HERE IS `RESTRICT` AND NOT
--  `CASCADE`. A cascade is a DELETE, and a DELETE the trigger refuses
--  turns "deactivate this employee" into an error message nobody can act
--  on. Employees are deactivated, leave types are deactivated, requests
--  are cancelled — nothing in this module is ever deleted, and the FKs
--  are what make that true rather than customary.
CREATE TABLE IF NOT EXISTS leave_ledger (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,

    employee_id     uuid NOT NULL REFERENCES employees(id)      ON DELETE RESTRICT,
    leave_type_id   uuid NOT NULL REFERENCES leave_types(id)    ON DELETE RESTRICT,
    period_id       uuid NOT NULL REFERENCES leave_periods(id)  ON DELETE RESTRICT,

    kind            leave_entry_kind NOT NULL,

    --  🔴 SIGNED, AND IN DAYS. Positive earns, negative spends.
    --  ⚠️ `numeric(7,2)` AND NOT A FLOAT, for the same reason money is
    --  `numeric(18,0)` and not a float: 0.1 + 0.2 is not 0.3 in binary
    --  floating point, and a balance that prints as 12.299999999999 is a
    --  support ticket nobody can answer.
    days_delta      numeric(7,2) NOT NULL,

    --  ⭐ THE DATE THE ENTRY BELONGS TO, WHICH IS NOT `created_at`. A May
    --  accrual run executed in June is dated 31 May. Backdating a
    --  correction is ordinary and honest; pretending it was written then
    --  is not, and `created_at` says when it was actually typed.
    effective_on    date NOT NULL,

    request_id      uuid,
    attendance_id   uuid,

    note            text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    --  A zero-day entry says nothing and makes the ledger harder to read.
    CONSTRAINT leave_ledger_delta_non_zero CHECK (days_delta <> 0),

    --  ⚠️ THE SIGN IS PART OF THE MEANING. An `accrual` of −3 or a
    --  `taken` of +2 is a bug in whatever wrote it, and it would fold
    --  into a balance that looks entirely reasonable.
    CONSTRAINT leave_ledger_sign_matches_kind CHECK (
        (kind IN ('accrual', 'carry_forward_in', 'commitment_release') AND days_delta > 0)
        OR (kind IN ('lapse', 'taken', 'encashed', 'commitment') AND days_delta < 0)
        OR (kind IN ('opening_balance', 'adjustment'))
    ),

    --  ⚠️ AN UNEXPLAINED MANUAL MOVEMENT OF SOMEBODY'S LEAVE BALANCE IS
    --  THE ENTRY IN THIS TABLE MOST LIKELY TO BE DISPUTED. "There is a
    --  note on it" is the difference between an answer and an accusation.
    CONSTRAINT leave_ledger_adjustment_explained CHECK (
        kind <> 'adjustment' OR (note IS NOT NULL AND length(btrim(note)) >= 3)
    ),

    --  🔴🔴 DECISION ④, AS A CONSTRAINT RATHER THAN A CONVENTION. A
    --  `taken` entry MUST point at the attendance row that caused it.
    --  Without this a `taken` can be written from an approval, which is
    --  precisely the conflation this module exists to prevent — and once
    --  one exists nobody can tell which days were actually absent.
    CONSTRAINT leave_ledger_taken_from_attendance CHECK (
        kind <> 'taken' OR attendance_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS leave_ledger_id_tenant_key
    ON leave_ledger (id, tenant_id);
--  ⭐ THE INDEX THE BALANCE QUERY LIVES ON. Every read of this table is
--  "every entry for this person and this type in this period"; without it
--  the fold degrades into a sequential scan of the whole workspace's
--  leave history on every screen.
CREATE INDEX IF NOT EXISTS leave_ledger_balance_idx
    ON leave_ledger (tenant_id, employee_id, leave_type_id, period_id);
CREATE INDEX IF NOT EXISTS leave_ledger_effective_idx
    ON leave_ledger (tenant_id, effective_on);
CREATE INDEX IF NOT EXISTS leave_ledger_request_idx
    ON leave_ledger (tenant_id, request_id);

--  ⭐⭐ THE ACCRUAL RUN'S IDEMPOTENCY KEY, AND ITS WHOLE SAFETY STORY.
--
--  🔴 AN ACCRUAL RUN IS EXACTLY THE KIND OF JOB THAT GETS TRIGGERED
--  TWICE: a cron that retried, an admin who clicked again because the
--  first click seemed slow, a deploy that replayed a queue. Without this
--  index the second run is silent and everybody's balance is wrong by one
--  month, forever, because the ledger is append-only and the only fix is
--  another visible entry with somebody's name on it.
CREATE UNIQUE INDEX IF NOT EXISTS leave_ledger_accrual_once
    ON leave_ledger (tenant_id, employee_id, leave_type_id, effective_on)
    WHERE kind = 'accrual';

--  ⚠️ THE APPEND-ONLY TRIGGER, THE SAME SHAPE AS `audit_logs` FROM 0001.
--  It stops the APPLICATION rewriting a balance; it detects nothing, and
--  anybody with owner rights can disable it. What it buys is that every
--  ordinary code path — an ORM update, a bad migration, a support script
--  — fails loudly instead of quietly changing what somebody is owed.
CREATE OR REPLACE FUNCTION leave_ledger_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'leave_ledger is append-only; % is not permitted. Correct a wrong entry with an adjustment in the opposite direction and a note.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS leave_ledger_no_update ON leave_ledger;
CREATE TRIGGER leave_ledger_no_update
  BEFORE UPDATE ON leave_ledger
  FOR EACH ROW EXECUTE FUNCTION leave_ledger_block_mutation();

DROP TRIGGER IF EXISTS leave_ledger_no_delete ON leave_ledger;
CREATE TRIGGER leave_ledger_no_delete
  BEFORE DELETE ON leave_ledger
  FOR EACH ROW EXECUTE FUNCTION leave_ledger_block_mutation();

-- =====================================================================
--  ④ THE REQUEST
-- =====================================================================
--
--  🔴 `days` IS STORED AND IT IS NOT A BALANCE. It is what this
--  application ASKS FOR, computed once by `lib/leave/request.ts` from the
--  dates, the type's holiday rule and the calendar in force at the time.
--  Storing it is right for the same reason an invoice stores its own line
--  totals: the holiday calendar can be edited afterwards, and an
--  application must still say what it said when it was approved.
--
--  ⚠️ WHAT IS NOT STORED HERE IS THE BALANCE IT LEAVES BEHIND. That is
--  decision ②, and a `balance_after` column would be the stored balance
--  in disguise.
CREATE TABLE IF NOT EXISTS leave_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    employee_id     uuid NOT NULL REFERENCES employees(id)   ON DELETE RESTRICT,
    leave_type_id   uuid NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,

    from_on         date NOT NULL,
    to_on           date NOT NULL,          -- inclusive

    half_day_start  boolean NOT NULL DEFAULT false,
    half_day_end    boolean NOT NULL DEFAULT false,

    days            numeric(7,2) NOT NULL,
    status          leave_request_status NOT NULL DEFAULT 'draft',

    --  ⚠️ OPTIONAL, AND LABELLED OPTIONAL ON THE SCREEN. An employee who
    --  types a diagnosis into it has volunteered it; a required field
    --  would have demanded it.
    reason          text,

    submitted_at    timestamptz,
    decided_at      timestamptz,
    decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    --  🔴 REQUIRED ON A REJECTION. A refusal with no reason is the thing
    --  an employee escalates, and the person who has to answer for it
    --  three months later is not the person who clicked.
    decision_note   text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT leave_requests_dates_ordered CHECK (to_on >= from_on),
    CONSTRAINT leave_requests_days_positive CHECK (days > 0 AND days <= 400),
    --  ⚠️ A HALF DAY AT BOTH ENDS OF A ONE-DAY APPLICATION IS ZERO DAYS,
    --  and the arithmetic that produced it was asked a question that makes
    --  no sense.
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

CREATE UNIQUE INDEX IF NOT EXISTS leave_requests_id_tenant_key
    ON leave_requests (id, tenant_id);
CREATE INDEX IF NOT EXISTS leave_requests_employee_idx
    ON leave_requests (tenant_id, employee_id, from_on);
--  The approver's queue: everything awaiting a decision, oldest first.
CREATE INDEX IF NOT EXISTS leave_requests_pending_idx
    ON leave_requests (tenant_id, status, from_on) WHERE status = 'submitted';

--  🔴🔴 NOBODY IS ON TWO LEAVES AT ONCE, AND THIS IS WHERE THAT IS TRUE.
--
--  ⚠️ WITHOUT IT THE COMMONEST DOUBLE-COUNT IN LEAVE ADMINISTRATION IS
--  SILENT: an employee applies for 10–14 March as casual leave, then
--  applies again for 12–16 March as sick leave, and both are approved by
--  different people on different days. Two commitments exist for the same
--  three dates, the balance is reduced twice, and when attendance is
--  finally recorded there is one row per date and no way to say which
--  request it belonged to.
--
--  ⭐ `submitted` IS INSIDE THE PREDICATE AS WELL AS `approved`, so the
--  second application is refused at the point it is made rather than at
--  the point somebody approves it. Telling an employee "no" while they
--  are still typing is a different experience from telling their manager
--  "no" a week later.
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_no_overlap;
ALTER TABLE leave_requests ADD  CONSTRAINT leave_requests_no_overlap
  EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(from_on, to_on, '[]') WITH &&
  ) WHERE (status IN ('submitted', 'approved'));

--  ⚠️ THE FOREIGN KEYS FROM THE LEDGER BACK TO THE REQUEST, ADDED HERE
--  BECAUSE THE LEDGER IS DECLARED FIRST. `RESTRICT`, like everything else
--  pointing at an append-only table: a request that has moved a balance
--  is a request that can be cancelled but never deleted.
ALTER TABLE leave_ledger DROP CONSTRAINT IF EXISTS leave_ledger_request_fk;
ALTER TABLE leave_ledger ADD  CONSTRAINT leave_ledger_request_fk
  FOREIGN KEY (request_id) REFERENCES leave_requests(id) ON DELETE RESTRICT;

-- =====================================================================
--  ⑤ STAFF ATTENDANCE — THE TABLE BATCH 50 IS WAITING FOR
-- =====================================================================
--
--  ⭐⭐⭐ ONE ROW PER SALARIED PERSON PER DAY, AND THE ONLY SOURCE OF
--  LOSS OF PAY.
--
--  ⚠️ `site_attendance` IS NOT THIS TABLE AND MUST NOT BECOME IT. It
--  records punches — a timestamp and a direction — for people who are not
--  employees. This one records a DAY'S VERDICT for people who are.
--
--  ══════════════════════════════════════════════════════════════════
--  ⭐ ONE FRACTION, NOT TWO
--  ══════════════════════════════════════════════════════════════════
--  The table stores `lop_fraction` and no `paid_fraction`. 🔴 A SECOND
--  COLUMN THAT MUST ALWAYS EQUAL `1 - lop_fraction` IS THE STORED-BALANCE
--  MISTAKE AT THE SCALE OF ONE DAY: the moment one is written without the
--  other, a day is both paid and unpaid and the payslip and the register
--  disagree about somebody's salary.
--
--  ⚠️ AND PAYROLL ONLY NEEDS THE LOP HALF. `server/payroll/run.ts` already
--  derives `payableDays` from the days on the rolls in the period and gets
--  joiners and leavers right. The one thing attendance adds to the money
--  is `lopDays = sum(lop_fraction)`.
CREATE TABLE IF NOT EXISTS staff_attendance (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    on_date         date NOT NULL,

    status          staff_attendance_status NOT NULL,

    --  🔴 THE NUMBER THAT REACHES THE PAYSLIP. 0.00 · 0.50 · 1.00 in
    --  practice; `numeric(3,2)` because quarter days exist in some
    --  establishments and a CHECK is a better place to say "no" than a
    --  type is.
    lop_fraction    numeric(3,2) NOT NULL DEFAULT 0,

    --  ⚠️ NULLABLE, AND ITS NULLABILITY IS DECISION ④ AGAIN. Somebody who
    --  simply did not turn up is `absent` with no leave type and no
    --  request. Forcing a type here would make the system unable to record
    --  the most common reason anybody opens this screen.
    leave_type_id   uuid REFERENCES leave_types(id)    ON DELETE RESTRICT,
    request_id      uuid REFERENCES leave_requests(id) ON DELETE RESTRICT,

    note            text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT staff_attendance_fraction_sane CHECK (
        lop_fraction >= 0 AND lop_fraction <= 1
    ),

    --  🔴 THE PAIRS THAT ARE NONSENSE, REFUSED AT THE DATABASE.
    --
    --  A weekly off or a declared holiday carrying loss of pay means
    --  somebody has been docked for a Sunday. An `absent` day with no loss
    --  of pay means an unexplained absence was paid in full. Both are
    --  single-keystroke errors on a grid of thirty days and neither looks
    --  wrong in a list.
    --
    --  ⚠️ `paid_leave` IS DELIBERATELY ALLOWED A NON-ZERO FRACTION: a full
    --  day taken against half a day of balance is real, and the other half
    --  is loss of pay.
    CONSTRAINT staff_attendance_status_fraction_coherent CHECK (
        (status IN ('present', 'on_duty', 'weekly_off', 'holiday') AND lop_fraction = 0)
        OR (status = 'absent'       AND lop_fraction > 0)
        OR (status = 'unpaid_leave' AND lop_fraction > 0)
        OR (status = 'paid_leave')
    ),

    --  A leave day with no type recorded cannot be reconciled to anything.
    CONSTRAINT staff_attendance_leave_has_type CHECK (
        status NOT IN ('paid_leave', 'unpaid_leave') OR leave_type_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_attendance_id_tenant_key
    ON staff_attendance (id, tenant_id);
--  🔴 ONE VERDICT PER PERSON PER DAY. Two rows for one day double the
--  loss of pay, and a payslip short by a plausible amount is the hardest
--  kind of error to notice.
CREATE UNIQUE INDEX IF NOT EXISTS staff_attendance_day_key
    ON staff_attendance (tenant_id, employee_id, on_date);
--  ⭐ The exact shape of the payroll query: a tenant and a date range.
CREATE INDEX IF NOT EXISTS staff_attendance_period_idx
    ON staff_attendance (tenant_id, on_date, employee_id);
CREATE INDEX IF NOT EXISTS staff_attendance_request_idx
    ON staff_attendance (tenant_id, request_id);

ALTER TABLE leave_ledger DROP CONSTRAINT IF EXISTS leave_ledger_attendance_fk;
ALTER TABLE leave_ledger ADD  CONSTRAINT leave_ledger_attendance_fk
  FOREIGN KEY (attendance_id) REFERENCES staff_attendance(id) ON DELETE RESTRICT;

-- =====================================================================
--  ⑥ THE TRIGGER THAT CONNECTS ATTENDANCE TO THE WAGE BILL
-- =====================================================================
--
--  🔴🔴 ATTENDANCE FOR A PERIOD WHOSE PAYROLL HAS BEEN APPROVED IS
--  FROZEN, AND THIS IS THE ONLY PLACE THAT IS TRUE.
--
--  ⚠️ WITHOUT IT, THE MOST DAMAGING SEQUENCE IN THE WHOLE MODULE IS TWO
--  ORDINARY CLICKS: payroll for March is computed, approved and posted;
--  somebody then corrects a March attendance row; the leave register now
--  says one thing and the payslip that was paid says another, and neither
--  is wrong on its own terms. Reconciling them afterwards means deciding
--  which of two true records to disbelieve.
--
--  ⭐ THE REFUSAL NAMES THE RUN AND SUGGESTS THE REAL REMEDY, which is an
--  adjustment in the NEXT month's payroll — the same way every payroll
--  department in the country handles a late correction. A system that
--  merely said "denied" would be worked around by cancelling the run,
--  which un-posts a journal.
--
--  ⚠️ `computed` AND `draft` RUNS DO NOT FREEZE ANYTHING. Recomputing a
--  run nobody has signed off is ordinary work, and locking attendance the
--  moment somebody presses Compute would make the correction loop
--  impossible.
CREATE OR REPLACE FUNCTION ordence_guard_staff_attendance_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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

DROP TRIGGER IF EXISTS ordence_guard_staff_attendance_frozen ON staff_attendance;
CREATE TRIGGER ordence_guard_staff_attendance_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON staff_attendance
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_staff_attendance_frozen();

-- ⭐ `set_updated_at()` is from 0001. Without these, `updated_at` is the
--    creation time forever and "when did this change" has no answer.
DROP TRIGGER IF EXISTS leave_periods_set_updated_at ON leave_periods;
CREATE TRIGGER leave_periods_set_updated_at
  BEFORE UPDATE ON leave_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS leave_types_set_updated_at ON leave_types;
CREATE TRIGGER leave_types_set_updated_at
  BEFORE UPDATE ON leave_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS leave_requests_set_updated_at ON leave_requests;
CREATE TRIGGER leave_requests_set_updated_at
  BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS staff_attendance_set_updated_at ON staff_attendance;
CREATE TRIGGER staff_attendance_set_updated_at
  BEFORE UPDATE ON staff_attendance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
--  ⑦ ROW LEVEL SECURITY
-- =====================================================================
--
--  🔴 A LEAVE REGISTER IS NOT AS SENSITIVE AS A SALARY AND IT IS CLOSER
--  THAN IT LOOKS. Who took sick leave, how often, and in which weeks is
--  an inference about somebody's health; who took four weeks in December
--  is an inference about their religion. One tenant reading another's
--  leave register is that, for every employee at once.
--
--  ⭐ `app_platform_scope()` GOES IN `USING` AND NEVER IN `WITH CHECK`,
--  the house rule the whole schema follows and that 0014 fails a deploy
--  over: platform staff may READ across tenants to answer a support
--  question, and may never WRITE a row into a workspace that is not the
--  session's.
--
--  ⚠️ FORCE, NOT JUST ENABLE. This application connects as the table
--  owner, and an owner without FORCE bypasses every policy — which is
--  precisely what `check:rls-writes` was built after finding.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leave_periods', 'holiday_calendar', 'leave_types',
    'leave_ledger', 'leave_requests', 'staff_attendance'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING (tenant_id = app_current_tenant_id() OR app_platform_scope()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_isolation', t
    );
  END LOOP;
END
$$;

-- =====================================================================
--  ⑧ THE TABLE COMMENTS, FOR WHOEVER OPENS THIS IN A CLIENT
-- =====================================================================

COMMENT ON TABLE leave_ledger IS
  'Every movement of every leave balance, append-only by trigger. 🔴 THE '
  'BALANCE IS sum(days_delta) AND IS NEVER STORED: a cached balance that '
  'disagrees with its ledger is unarguable with an employee, who has '
  'their own list of the days they took. Correct a wrong entry with an '
  'adjustment in the opposite direction and a note, never an UPDATE.';

COMMENT ON COLUMN leave_ledger.kind IS
  'commitment / commitment_release do NOT move the balance — they record '
  'what an approval has reserved. Only `taken`, written from a '
  'staff_attendance row, spends days. An approved leave is not an '
  'absence: people cancel plans and come in anyway.';

COMMENT ON TABLE staff_attendance IS
  'One row per salaried employee per day. 🔴 THE SOURCE OF LOSS OF PAY '
  'FOR PAYROLL — `lopDays = sum(lop_fraction)`. NOT site_attendance, '
  'which records check-in/check-out punches for contract labour who are '
  'paid through a vendor RA bill and are on nobody''s payroll. Frozen by '
  'trigger once the payroll run covering the date is approved.';

COMMENT ON COLUMN staff_attendance.lop_fraction IS
  'The portion of the day that is loss of pay. There is deliberately no '
  'paid_fraction: a second column that must always equal 1 - this one is '
  'the stored-balance mistake at the scale of one day.';

COMMENT ON COLUMN leave_types.carry_forward_cap_days IS
  'NOT NULL with no "unlimited" value, on purpose. Uncapped carry-forward '
  'compounds into a liability that appears on nobody''s balance sheet '
  'until a team turns over. Zero — use it or lose it — is a good answer; '
  'it just has to be typed.';

COMMENT ON COLUMN leave_types.accrual_method IS
  'monthly_earned is the default: entitlement is earned in proportion to '
  'days on the rolls. A full year appearing on 1 April for an October '
  'joiner is a liability the business does not owe and cannot recover.';

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  NO PER-EMPLOYEE ENTITLEMENT TABLE. Different entitlements by grade are
--  real, and today they are expressed either as more than one leave type
--  or as an `adjustment` entry with a note. A `leave_type_entitlements`
--  table is the right long-term answer and it needs an effective-dated
--  design of its own; a half version of it would silently take precedence
--  over the type's own number for some employees and not others.
--
--  NO COMPENSATORY OFF. Working a declared holiday and banking a day in
--  return is a genuine feature with its own approval trail, and it is
--  NOT the same as an adjustment entry with a friendly note.
--
--  NO ENCASHMENT POSTING. `lib/leave/balance.ts` values an encashment in
--  paise, and nothing here writes it to the ledger or to a payslip:
--  paying leave out is a pay component and belongs to the payroll batch
--  that owns `pay_components`.
--
--  NO LEAVE ACCRUAL FOR `site_workers`. Contract labour is engaged by a
--  vendor and their leave is that vendor's obligation. Accruing it here
--  would create a record suggesting a direct employment relationship,
--  which is the one inference this schema must never invite.
--
--  ⚠️ AND NO WIRING OF THE PAYROLL RUN BOARD. `staff_attendance` now
--  exists and `lib/leave/attendance.ts#summariseAttendance` produces
--  exactly the shape `server/payroll/run.ts#AttendanceInput` accepts.
--  Replacing the hardcoded `attendance: []` in
--  `components/payroll/payroll-run-board.tsx` is Batch 50's, deliberately
--  — two batches editing one compute path in one run is how a wage bill
--  gets computed twice from two half-merged branches.
-- =====================================================================
