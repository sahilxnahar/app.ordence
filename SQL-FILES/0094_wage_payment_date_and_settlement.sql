-- ############################################################################
-- 0094 , THE DATE WAGES WERE PAID, AND THE FULL AND FINAL SETTLEMENT
-- ############################################################################
--
-- PURPOSE , PART 1: A PAYROLL RUN COULD NOT SAY WHEN IT WAS PAID
-- ----------------------------------------------------------------------------
-- `payroll_runs` recorded gross, PF, pension, EDLI, ESI, professional tax,
-- TDS, net pay and employer cost. It recorded `computed_at`, `approved_at`,
-- `approved_by`, `posted_at` and the journal `transaction_id`.
--
-- 🔴 IT RECORDED NOTHING WHATEVER ABOUT WHEN THE MONEY REACHED THE EMPLOYEE,
--    AND THE ENTIRE PAYMENT OF WAGES ACT, 1936 IS ABOUT THAT DAY.
--
--      s.4    a wage period may not exceed one month.
--      s.5(1) wages shall be paid before the expiry of the SEVENTH day after
--             the last day of the wage period where fewer than one thousand
--             persons are employed, and before the expiry of the TENTH day
--             in any other case.
--      s.5    where employment is TERMINATED, the wages earned fall due by
--             reference to the last working day and not to the wage period ,
--             the leaver no longer has a wage period for s.5(1) to govern.
--      s.13A  the employer shall maintain registers. The register an
--             inspector opens is a register of DATES PAID, not of amounts
--             computed.
--      s.20   delay is an offence, and paying later does not undo it.
--
-- ⚠️ SO THE ONE QUESTION A LABOUR INSPECTOR ASKS , "show me when these wages
--    were paid" , had no answer in this schema even in principle.
--
-- ⭐⭐ WHY PAYMENT IS NOT A NEW VALUE ON `payroll_run_status`.
--    That enum is a one-way ladder: draft → computed → approved → posted.
--    Every rung is an INTERNAL act , a signature, a journal , and the ladder
--    is enforced as one-way everywhere in `server/payroll/`.
--
--    Payment is not an internal act. It is a fact about a bank. It FAILS. A
--    run approved on the 3rd whose NEFT file bounces on the 6th would need a
--    backwards status transition to be recorded, which the state machine
--    forbids; and a `paid` rung would make the truly dangerous row , posted,
--    journalled, and never actually paid , indistinguishable from a healthy
--    one, because `posted` would look like the normal resting state.
--
--    🔴 SO APPROVAL AND PAYMENT ARE SEPARATE AXES. `status` keeps its
--    meaning untouched. `paid_on` NULL means UNPAID, and it never means
--    "approved, therefore presumably paid". `payment_failed_on` records the
--    bounce without unwinding the approval. A CHECK forbids both at once, so
--    a successful retry must clear the failure rather than leave a row that
--    says it both bounced and settled.
--
-- ⭐ AND `wage_payment_due_on` IS FROZEN ON THE ROW RATHER THAN DERIVED AT
--    READ TIME. The s.5(1) band depends on how many persons the
--    ESTABLISHMENT employs, which changes. A register reprinted in 2028 must
--    show the date that governed in 2026. `lib/compliance/statutory-due.ts`
--    computes it , the same module, and the same `dueDateFor`, that already
--    owns "the Nth day of the following month" for GST, TDS, PF and ESI , and
--    this column remembers what it said.
--
-- PURPOSE , PART 2: THERE WAS NO EXIT FLOW AT ALL
-- ----------------------------------------------------------------------------
-- `employees.left_on` was a date that stopped payroll. Nothing anywhere
-- assembled what a leaver was owed: no part-month wages, no leave
-- encashment, no gratuity, no notice, no recoveries, no clearance.
--
-- 🔴 THE HALF OF THAT FEATURE THAT HURTS PEOPLE IS THE RECOVERIES, AND THE
--    LAW LIMITS THEM. Section 7(1) of the Payment of Wages Act, 1936 allows
--    NO deduction except those the Act authorises; s.7(2) enumerates them
--    exhaustively; s.7(3) caps the TOTAL at fifty per cent of the wages of
--    the wage period, seventy-five where the deductions include payments to
--    co-operative societies under s.7(2)(j); and s.10 permits a deduction for
--    damage or loss only after the employee has been heard, limited to the
--    loss actually caused.
--
--    A settlement that nets a leaver's dues to zero against a disputed
--    laptop is unlawful, not merely harsh. `lib/payroll/settlement.ts`
--    REFUSES such a settlement rather than clamping it to the cap, and
--    `employee_settlements` carries that refusal as a stored fact , with the
--    reason , so an employer who paid anyway is shown to have been warned.
--
-- 🔴 GRATUITY IS NOT IN THE CAP BASE. s.2(vi) of the Payment of Wages Act
--    excludes "any gratuity payable on the termination of employment" from
--    the definition of wages, and s.13 of the Payment of Gratuity Act, 1972
--    protects gratuity from attachment. `deduction_cap_base_minor` is
--    therefore stored SEPARATELY from `gross_dues_minor`: the gap between
--    the two is the auditor's proof that the exclusion was applied.
--
-- ⭐ AND THE INPUTS ARE STORED, NOT ONLY THE TOTAL. A settlement is disputed
--    years later, before the authority under s.15 of the Payment of Wages
--    Act or the controlling authority under s.7 of the Gratuity Act. By then
--    the gratuity ceiling has moved and the leave ledger has been corrected.
--    Recomputing from the tables of the day proves nothing. `inputs` holds
--    the argument set verbatim and `computed` holds the working; the row is
--    the evidence.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
-- Same reason as 0092 and 0093. Migrations here are PASTED INTO THE NEON
-- BROWSER CONSOLE, which sends each statement separately. `BEGIN` buys no
-- atomicity across that boundary, it only makes a half-applied file look
-- clean , which is how 0091 applied half-way while reporting success. A bare
-- `SET LOCAL app.platform_scope` reports "executed successfully" and has
-- evaporated before the next statement runs.
--
-- ⭐ EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT and the file is safe
--    to re-run from the top after a failure at any point:
--    `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
--    `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` before every
--    `CREATE POLICY`, and each named CHECK guarded by a catalogue lookup
--    inside a single PL/pgSQL `DO $$ ... $$;` block. (`DO $$ BEGIN ... END $$`
--    is PL/pgSQL block syntax, not a transaction , it is the construct the
--    project's own rule prescribes.)
--
-- ⭐ THERE IS NO DML IN THIS FILE AT ALL, which is the strongest form of the
--    rule: DDL is not subject to a row-level security WITH CHECK, so nothing
--    here needs `app.platform_scope` and nothing here can be refused by a
--    policy , the failure mode 0091 and 0092 both hit. There is no backfill
--    either, and NULL is the correct value for every existing run: it means
--    "nobody has recorded a payment date", which is exactly true.
--
-- RUN ORDER: after 0093. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275+ tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If anything below refuses, this row is still on screen and still says the
-- two things worth knowing: whether the change is already in, and how many
-- runs are about to gain a payment date they have never had.
-- ============================================================================

SELECT
    '0094 · diagnostic'                                     AS finding,
    current_user                                            AS running_as,
    (SELECT count(*) FROM public.payroll_runs)              AS payroll_run_rows,
    (SELECT count(*) FROM public.payroll_runs
      WHERE status IN ('approved', 'posted'))               AS runs_with_no_payment_date_today,
    EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'payroll_runs'
          AND column_name  = 'paid_on'
    )                                                       AS paid_on_already_present,
    to_regclass('public.employee_settlements') IS NOT NULL   AS settlements_already_present;


-- ============================================================================
-- SECTION 2 · THE PAYMENT AXIS ON `payroll_runs`
-- ============================================================================
-- ⚠️ ALL NULLABLE, DELIBERATELY. NULL `paid_on` is the honest record of every
--    run that exists today: nobody has ever recorded when it was paid, and a
--    backfill from `approved_at` would invent the very fact the Act asks for.
--    On PostgreSQL 11+ a nullable ADD COLUMN is a catalogue-only change.
-- ============================================================================

ALTER TABLE public.payroll_runs
    ADD COLUMN IF NOT EXISTS paid_on date;

ALTER TABLE public.payroll_runs
    ADD COLUMN IF NOT EXISTS payment_reference text;

-- ⚠️ Nullable on purpose: a cash-paid establishment has no UTR, and refusing
--    to record the DATE for want of a REFERENCE would defeat the column.
ALTER TABLE public.payroll_runs
    ADD COLUMN IF NOT EXISTS payment_mode varchar(20);

ALTER TABLE public.payroll_runs
    ADD COLUMN IF NOT EXISTS payment_marked_at timestamptz;

ALTER TABLE public.payroll_runs
    ADD COLUMN IF NOT EXISTS payment_marked_by uuid;

ALTER TABLE public.payroll_runs
    ADD COLUMN IF NOT EXISTS payment_failed_on date;

ALTER TABLE public.payroll_runs
    ADD COLUMN IF NOT EXISTS payment_failure_reason text;

ALTER TABLE public.payroll_runs
    ADD COLUMN IF NOT EXISTS wage_payment_due_on date;

ALTER TABLE public.payroll_runs
    ADD COLUMN IF NOT EXISTS wage_payment_band varchar(20);

COMMENT ON COLUMN public.payroll_runs.paid_on IS
    'The date the net wages actually reached the employees. NULL means UNPAID '
    'and never means "approved, therefore presumably paid". Payment of Wages '
    'Act, 1936 s.5 and s.13A: the register an inspector reads is a register '
    'of dates paid.';

COMMENT ON COLUMN public.payroll_runs.wage_payment_due_on IS
    'The s.5(1) due date frozen at the time the run was approved, because the '
    'headcount band that produced it changes and a register reprinted years '
    'later must show the date that governed then.';


-- ============================================================================
-- SECTION 3 · THE THREE CHECKS THAT KEEP APPROVAL AND PAYMENT APART
-- ============================================================================
-- ⚠️ ONE `DO` BLOCK, WITH A CATALOGUE LOOKUP PER CONSTRAINT. `ALTER TABLE ...
--    ADD CONSTRAINT` has no IF NOT EXISTS, so a re-run of a bare statement
--    would fail the file at its second execution. `NOT VALID` is deliberately
--    NOT used: there are no rows that can violate these , every existing run
--    has NULL in all three columns , so a full validation is free.
-- ============================================================================

DO $$
BEGIN
    -- 🔴 A run cannot be paid before it was approved. A payment date on an
    --    unapproved run is either a typo or an unauthorised transfer.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'payroll_runs_paid_needs_approval'
          AND conrelid = 'public.payroll_runs'::regclass
    ) THEN
        ALTER TABLE public.payroll_runs
            ADD CONSTRAINT payroll_runs_paid_needs_approval
            CHECK (paid_on IS NULL OR approved_at IS NOT NULL);
    END IF;

    -- ⚠️ Paid and failed cannot both stand. A retry that succeeds must clear
    --    the failure, or the register shows a run that both bounced and
    --    settled and nobody can tell which is current.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'payroll_runs_paid_not_failed'
          AND conrelid = 'public.payroll_runs'::regclass
    ) THEN
        ALTER TABLE public.payroll_runs
            ADD CONSTRAINT payroll_runs_paid_not_failed
            CHECK (paid_on IS NULL OR payment_failed_on IS NULL);
    END IF;

    -- ⭐ A failure with no stated reason is a record that helps nobody in
    --    exactly the conversation it exists for.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'payroll_runs_failure_needs_reason'
          AND conrelid = 'public.payroll_runs'::regclass
    ) THEN
        ALTER TABLE public.payroll_runs
            ADD CONSTRAINT payroll_runs_failure_needs_reason
            CHECK (payment_failed_on IS NULL OR payment_failure_reason IS NOT NULL);
    END IF;

    -- The FK on who marked it paid. Separate from the CHECKs because a
    -- missing `users` table would be a different failure worth seeing alone.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'payroll_runs_payment_marked_by_fkey'
          AND conrelid = 'public.payroll_runs'::regclass
    ) THEN
        ALTER TABLE public.payroll_runs
            ADD CONSTRAINT payroll_runs_payment_marked_by_fkey
            FOREIGN KEY (payment_marked_by) REFERENCES public.users(id)
            ON DELETE SET NULL;
    END IF;
END
$$;

-- ⭐ THE LOOKUP THE WHOLE COLUMN SET EXISTS FOR: which runs are past their
--    statutory date and not marked paid.
CREATE INDEX IF NOT EXISTS payroll_runs_unpaid_idx
    ON public.payroll_runs (tenant_id, wage_payment_due_on)
    WHERE paid_on IS NULL;


-- ============================================================================
-- SECTION 4 · `employee_settlements` , THE FULL AND FINAL
-- ============================================================================
-- ⚠️ `employee_id` IS ON DELETE RESTRICT, NOT CASCADE. Deleting an employee
--    must not delete the evidence of what they were paid on the way out.
--
-- ⚠️ MONEY IS numeric(18,0) PAISE, as everywhere else in Ordence. Never a
--    float, and never a rupee.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.employee_settlements (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid        NOT NULL REFERENCES public.tenants(id)   ON DELETE CASCADE,
    employee_id                 uuid        NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,

    settlement_no               varchar(30) NOT NULL,

    -- ⭐ Inclusive, as lib/payroll/gratuity.ts defines it: the day is served
    --    and paid, so 1 Jan 2015 → 31 Dec 2019 is exactly five years.
    last_working_day            date        NOT NULL,
    -- The TerminationCause union. It drives the proviso to s.4(1) of the
    -- Payment of Gratuity Act, 1972 that waives the five-year rule for death
    -- and disablement, so it is not cosmetic.
    cause                       varchar(30) NOT NULL,

    part_month_wages_minor      numeric(18,0) NOT NULL DEFAULT 0,
    leave_encashment_minor      numeric(18,0) NOT NULL DEFAULT 0,
    notice_pay_minor            numeric(18,0) NOT NULL DEFAULT 0,
    gratuity_statutory_minor    numeric(18,0) NOT NULL DEFAULT 0,
    gratuity_ex_gratia_minor    numeric(18,0) NOT NULL DEFAULT 0,
    gross_dues_minor            numeric(18,0) NOT NULL DEFAULT 0,

    -- 🔴 THE s.7(3) BASE, STORED APART FROM THE GROSS. Gratuity is excluded
    --    from it by s.2(vi); the gap between this and gross_dues_minor is the
    --    auditor's proof that the exclusion was applied.
    deduction_cap_base_minor    numeric(18,0) NOT NULL DEFAULT 0,
    -- 5000, or 7500 where the deductions include a payment to a co-operative
    -- society under s.7(2)(j) , the proviso lifts the cap on the whole set
    -- once any part of it is such a payment.
    deduction_cap_bp            integer     NOT NULL DEFAULT 5000,
    recoveries_claimed_minor    numeric(18,0) NOT NULL DEFAULT 0,
    -- ⭐ ZERO ON A REFUSAL. Never a figure clamped down to the cap.
    deductions_applied_minor    numeric(18,0) NOT NULL DEFAULT 0,
    net_payable_minor           numeric(18,0) NOT NULL DEFAULT 0,

    refused                     boolean     NOT NULL DEFAULT false,
    refusal_reason              text,

    -- ⭐ The working, so the settlement is reproducible without the tables.
    inputs                      jsonb       NOT NULL,
    computed                    jsonb       NOT NULL,

    computed_at                 timestamptz NOT NULL DEFAULT now(),
    approved_at                 timestamptz,
    approved_by                 uuid REFERENCES public.users(id) ON DELETE SET NULL,

    -- 🔴 The same approval/payment separation as payroll_runs, and it matters
    --    more here: the leaver has no access to the system and nobody chasing
    --    the transfer on their behalf.
    wage_payment_due_on         date,
    paid_on                     date,
    payment_reference           text,
    payment_failed_on           date,
    payment_failure_reason      text,

    created_at                  timestamptz NOT NULL DEFAULT now(),
    created_by                  uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT employee_settlements_refusal_needs_reason
        CHECK (refused = false OR refusal_reason IS NOT NULL),

    -- 🔴🔴 A REFUSED SETTLEMENT MAY NOT BE MARKED PAID. This is the database's
    --    copy of the rule in lib/payroll/settlement.ts: an over-cap
    --    settlement is a REFUSAL and not a clamp, and no code path anywhere
    --    may quietly settle one.
    CONSTRAINT employee_settlements_refused_not_paid
        CHECK (refused = false OR paid_on IS NULL),

    CONSTRAINT employee_settlements_paid_not_failed
        CHECK (paid_on IS NULL OR payment_failed_on IS NULL),

    -- ⭐ s.7(3) ENFORCED IN THE DATABASE TOO, in integer basis points so no
    --    rounding can creep in: applied × 10000 ≤ base × bp.
    CONSTRAINT employee_settlements_within_cap
        CHECK (deductions_applied_minor * 10000 <= deduction_cap_base_minor * deduction_cap_bp)
);

COMMENT ON TABLE public.employee_settlements IS
    'Full and final settlement on separation. Stores the INPUTS as well as the '
    'computed figures, because a settlement is disputed years later when the '
    'gratuity ceiling has moved and the leave ledger has been corrected, and '
    'recomputing from the tables of the day proves nothing.';

COMMENT ON COLUMN public.employee_settlements.deduction_cap_base_minor IS
    'The "wages" the 50%% cap in s.7(3) of the Payment of Wages Act, 1936 '
    'bites on. Gratuity is NOT in it , s.2(vi) excludes gratuity payable on '
    'termination from the definition of wages.';

CREATE UNIQUE INDEX IF NOT EXISTS employee_settlements_id_tenant_key
    ON public.employee_settlements (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS employee_settlements_no_key
    ON public.employee_settlements (tenant_id, settlement_no);

-- ⚠️ ONE SETTLEMENT PER EMPLOYEE. Two full-and-finals for the same person is
--    two gratuity payments, and only the auditor ever finds the second.
CREATE UNIQUE INDEX IF NOT EXISTS employee_settlements_one_per_employee
    ON public.employee_settlements (tenant_id, employee_id);

CREATE INDEX IF NOT EXISTS employee_settlements_due_idx
    ON public.employee_settlements (tenant_id, wage_payment_due_on)
    WHERE paid_on IS NULL;


-- ============================================================================
-- SECTION 5 · RLS ON `employee_settlements`
-- ============================================================================
-- 🔴 THIS TABLE CARRIES tenant_id, SO check-rls-coverage REQUIRES: ENABLE,
--    FORCE, and a policy whose USING names app_current_tenant_id().
--
-- ⚠️ AND IT IS NOT IN OPT_IN_PLATFORM_WRITE, DELIBERATELY. A settlement is
--    the tenant's own act , their HR runs it, their signatory approves it ,
--    unlike tenant_slug_history in 0091, which records what the PLATFORM did
--    to a tenant and which the tenant must not be able to write. So the WITH
--    CHECK is the plain tenant predicate and there is no platform escape
--    hatch: nobody, operator included, writes a settlement on a tenant's
--    behalf without it being that tenant's session.
--
-- FORCE matters here more than usual: without it the table owner (which is
-- what a migration runs as) bypasses the policy entirely, and the isolation
-- would be a comment rather than a control.
-- ============================================================================

ALTER TABLE public.employee_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_settlements FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_settlements_tenant_isolation ON public.employee_settlements;

CREATE POLICY employee_settlements_tenant_isolation ON public.employee_settlements
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 6 · CONFIRMATION · THE ROW TO READ
-- ============================================================================

SELECT
    '0094 · verdict'                                        AS finding,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payroll_runs'
        AND column_name IN ('paid_on','payment_reference','payment_mode',
                            'payment_marked_at','payment_marked_by',
                            'payment_failed_on','payment_failure_reason',
                            'wage_payment_due_on','wage_payment_band'))
                                                            AS payment_columns_present,
    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.payroll_runs'::regclass
        AND conname IN ('payroll_runs_paid_needs_approval',
                        'payroll_runs_paid_not_failed',
                        'payroll_runs_failure_needs_reason'))
                                                            AS payment_checks_present,
    to_regclass('public.employee_settlements') IS NOT NULL   AS settlements_table_present,
    (SELECT relrowsecurity FROM pg_class
      WHERE oid = 'public.employee_settlements'::regclass)   AS settlements_rls_enabled,
    (SELECT relforcerowsecurity FROM pg_class
      WHERE oid = 'public.employee_settlements'::regclass)   AS settlements_rls_forced,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'employee_settlements')
                                                            AS settlements_policies,
    CASE
        WHEN (SELECT count(*) FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'payroll_runs'
                 AND column_name IN ('paid_on','payment_reference','payment_mode',
                                     'payment_marked_at','payment_marked_by',
                                     'payment_failed_on','payment_failure_reason',
                                     'wage_payment_due_on','wage_payment_band')) = 9
         AND (SELECT count(*) FROM pg_constraint
               WHERE conrelid = 'public.payroll_runs'::regclass
                 AND conname IN ('payroll_runs_paid_needs_approval',
                                 'payroll_runs_paid_not_failed',
                                 'payroll_runs_failure_needs_reason')) = 3
         AND to_regclass('public.employee_settlements') IS NOT NULL
         AND (SELECT relrowsecurity      FROM pg_class WHERE oid = 'public.employee_settlements'::regclass)
         AND (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.employee_settlements'::regclass)
            THEN 'PASS , a payroll run can now record WHEN it was paid, separately from when it was approved, and a full and final settlement has somewhere to live with its working and its s.7(3) cap enforced'
        ELSE 'FAIL , read the counts above and send me the error from the tab that refused'
    END                                                     AS verdict;
