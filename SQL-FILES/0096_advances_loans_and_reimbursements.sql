-- ############################################################################
-- 0096 , EMPLOYEE ADVANCES AND LOANS, AND REIMBURSEMENTS AGAINST EVIDENCE
-- ############################################################################
--
-- PURPOSE
-- -------
-- Two things employers do every month that Ordence could not record, and they
-- are genuinely different animals however similar they look on a payslip.
--
-- ⭐ A REIMBURSEMENT is the employer giving back money the EMPLOYEE ALREADY
--    SPENT. Nothing accrues to the employee, so it is not wages, so provident
--    fund, ESI, professional tax and s.192 TDS have nothing to bite on.
--
-- 🔴 AN ALLOWANCE IS THE OPPOSITE AND LOOKS IDENTICAL. A fixed monthly
--    "travel reimbursement" paid whether or not anybody travelled is a sum the
--    employee keeps. It is salary income under s.17(1)(iv) of the Income-tax
--    Act, 1961 and it is TAXABLE.
--
-- ⭐⭐ THE ONLY THING THAT TELLS THEM APART IS THE EVIDENCE. So the evidence
--    is a column, the treatment is DERIVED from it in
--    lib/payroll/reimbursements.ts, and section 4 below puts a CHECK
--    constraint under that rule so an INSERT cannot walk around it. Without
--    it the whole feature is one boolean away from being a tickbox that makes
--    tax disappear.
--
-- 🔴 AN ADVANCE OR LOAN is the employer LENDING money. That is a RECEIVABLE,
--    not payroll cost , the business is not poorer for having made it, it
--    holds a claim instead of cash. ⚠️ STATED GAP: it is not posted to the
--    ledger in this release. lib/accounting/sales-posting.ts has no advances
--    role and inventing one would require a chart-of-accounts mapping nobody
--    has configured. advanceLedgerIntent() names the two legs and the account
--    TYPE so that the day the role exists nobody wires a disbursement to
--    salary_expense because it was the nearest role to hand.
--
-- ############################################################################
-- 🔴🔴 THE LAW THAT GOVERNS THE RECOVERY, AND IT IS ALREADY IMPLEMENTED
-- ############################################################################
--
-- Section 7 of the Payment of Wages Act, 1936 is an EXHAUSTIVE list of
-- permitted deductions, and s.7(3) caps the TOTAL at fifty per cent of the
-- wages of the WAGE PERIOD , seventy-five where any part of them is a payment
-- to a co-operative society under s.7(2)(j).
--
-- ⭐⭐ THAT IS NOT AN EXIT RULE. A monthly loan instalment off a live payslip
--    is a deduction of that wage period exactly as a settlement recovery is.
--    lib/payroll/advances.ts therefore IMPORTS deductionCapBp() and
--    maximumLawfulDeductionMinor() from lib/payroll/settlement.ts and defines
--    no cap of its own. Two implementations that agree today diverge the first
--    time one is corrected, and the symptom is that the monthly deduction and
--    the final settlement disagree about how much may lawfully be taken from
--    the same person.
--
-- 🔴 AND AN OVER-CAP RECOVERY REFUSES, IT DOES NOT CLAMP. Nothing is taken
--    that month and the instalment rolls forward; the schedule EXTENDS and
--    the instalment does not shrink. A part-instalment would leave the
--    employer believing the schedule was on track and would silently change
--    figures the employee consented to under s.12.
--
-- ⚠️ SECTION 12 , THE RULES OF RECOVERY MUST BE PRESCRIBED. s.7(2)(f) permits
--    the deduction; s.12(b) subjects an advance of wages not already earned to
--    State rules "regulating the extent to which such advances may be given
--    and the instalments by which they may be recovered". So an open-ended
--    monthly deduction at the employer's discretion is NOT lawful even when it
--    is under the cap. agreement_reference and employee_consented_on are
--    therefore NOT NULL: no agreement, no deduction. The STATE rules
--    themselves are NOT guessed , state_limits is null until somebody enters
--    them and the engine says on every result that they have not been checked.
--
-- ############################################################################
-- 🔴🔴 THE BALANCE IS FOLDED FROM THE LEDGER. THERE IS NO COUNTER COLUMN.
-- ############################################################################
--
-- employee_advances has NO outstanding_minor column and must never have one.
-- Every failure mode of a counter is a real one: a payroll run reversed and
-- re-run decrements twice, a voided recovery leaves it high, two payslips in
-- one run lose an update. Nothing complains, because a counter has no way to
-- know it is wrong , and the drift lands on somebody's salary in both
-- directions: money taken after the advance was repaid, or a debt that was
-- already settled.
--
-- ⭐ SO employee_advance_recoveries IS THE BALANCE, and section 3 makes it
--    APPEND-ONLY BY TRIGGER. A recovery that can be edited after the fact is
--    not evidence that the recovery happened , the same argument that makes
--    audit_logs (0001) and permission_denials (0005) append-only, with more
--    money on it.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Same reason as 0092, 0093 and 0094. Migrations here are PASTED INTO THE NEON
-- BROWSER CONSOLE, which sends each statement on its own. `BEGIN` buys no
-- atomicity across that boundary, it only makes a half-applied file look like
-- a clean one , which is exactly how 0091 applied half-way while reporting
-- success. `SET LOCAL app.platform_scope` reports "executed successfully" and
-- has evaporated by the time the next statement runs.
--
-- ⭐ SO EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT , CREATE TABLE IF
--    NOT EXISTS, CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before
--    CREATE POLICY, DROP TRIGGER IF EXISTS before CREATE TRIGGER , and the
--    file is safe to re-run from the top after a failure at any point.
--
-- ⭐ AND THERE IS NO DML AT ALL, WHICH IS THE STRONGEST FORM OF THIS. Nothing
--    below writes a row, so nothing below can be refused by a FORCE ROW LEVEL
--    SECURITY policy , the failure mode 0091 and 0092 both hit. No backfill is
--    needed either: there are no historic advances to migrate, and inventing
--    an agreement for one would be inventing the s.12 consent that makes it
--    lawful.
--
-- RUN ORDER: after 0096. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If a later section refuses, this row is still on your screen and still tells
-- you what was there before you started.
-- ============================================================================

SELECT
    '0096 · diagnostic'                                       AS finding,
    current_user                                              AS running_as,
    to_regclass('public.employees')          IS NOT NULL      AS employees_present,
    to_regclass('public.payslips')           IS NOT NULL      AS payslips_present,
    to_regclass('public.employee_advances')  IS NOT NULL      AS advances_already_present,
    to_regclass('public.employee_reimbursement_claims') IS NOT NULL
                                                              AS reimbursements_already_present;


-- ============================================================================
-- SECTION 2 · `employee_advances` · THE AGREEMENT
-- ============================================================================
-- 🔴 NO outstanding_minor COLUMN. See the header. The balance is folded from
--    employee_advance_recoveries every time it is read.
--
-- ⚠️ employee_id IS ON DELETE RESTRICT. Deleting an employee must not delete
--    the record of money they were lent and may still owe.
--
-- ⚠️ MONEY IS numeric(18,0) PAISE, as everywhere else in Ordence. Never a
--    float, and never a rupee.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.employee_advances (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid          NOT NULL REFERENCES public.tenants(id)   ON DELETE CASCADE,
    employee_id               uuid          NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,

    advance_no                varchar(30)   NOT NULL,
    -- 'salary_advance' | 'welfare_loan' | 'house_building_loan'. Not cosmetic:
    -- it picks the clause. A salary advance recovers under s.7(2)(f) read with
    -- s.12; the loan kinds recover under s.7(2)(fff) and s.7(2)(ffff), which
    -- s.12 does not constrain the same way because a housing or welfare loan
    -- is not an advance of unearned wages.
    kind                      varchar(30)   NOT NULL,

    principal_minor           numeric(18,0) NOT NULL,
    disbursed_on              date          NOT NULL,

    -- 🔴 s.12 OF THE PAYMENT OF WAGES ACT, 1936 , THE RULES OF RECOVERY MUST
    --    BE PRESCRIBED. Both NOT NULL: no agreement, no deduction.
    agreement_reference       text          NOT NULL,
    employee_consented_on     date          NOT NULL,

    instalment_count          integer       NOT NULL,
    -- "YYYY-MM", the wage period the first instalment falls in.
    first_recovery_period     varchar(7)    NOT NULL,

    -- ⚠️ Basis points per annum; 0 is interest-free and is the common case.
    interest_rate_bp          integer       NOT NULL DEFAULT 0,

    -- 🔴 ALWAYS 'not_computed' TODAY, AND THE COLUMN EXISTS TO SAY SO OUT
    --    LOUD. Rule 3(7)(i) of the Income-tax Rules, 1962 values an
    --    interest-free or concessional loan as a PERQUISITE on the maximum
    --    outstanding monthly balance, at the SBI rate for the corresponding
    --    kind of loan as on the first day of the previous year. That rate is
    --    an external annual fact Ordence does not hold, the "corresponding
    --    kind" mapping is a judgement, and the small-loan and
    --    specified-disease exceptions move. A stated gap on every row beats a
    --    number derived from a guessed rate landing in somebody's Form 16.
    --    ⚠️ A CA MUST VALUE IT, from maximumOutstandingMinor().
    perquisite_valuation      varchar(20)   NOT NULL DEFAULT 'not_computed',

    status                    varchar(20)   NOT NULL DEFAULT 'active',

    -- ⚠️ A WAIVED LOAN IS TAXABLE IN THE EMPLOYEE'S HANDS. Whether it is a
    --    perquisite under s.17(2) of the Income-tax Act, 1961 or a profit in
    --    lieu of salary under s.17(3), and in which previous year, depends on
    --    the terms of the waiver. 🔴 ORDENCE DOES NOT DECIDE. The amount is
    --    stored so the accountant has the figure; the treatment is theirs.
    written_off_minor         numeric(18,0) NOT NULL DEFAULT 0,
    written_off_on            date,
    written_off_reason        text,

    -- ⭐ The State's s.12(b) rules, verbatim, or NULL where unconfigured , and
    --    NULL is the honest default. A number invented here would be wrong in
    --    most States and confidently applied in all of them.
    state_limits              jsonb,

    created_at                timestamptz   NOT NULL DEFAULT now(),
    created_by                uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT employee_advances_principal_positive
        CHECK (principal_minor > 0),

    -- 🔴 s.12(b) speaks of "the instalments". At least one, agreed in advance.
    CONSTRAINT employee_advances_instalments_agreed
        CHECK (instalment_count >= 1),

    CONSTRAINT employee_advances_write_off_needs_reason
        CHECK (written_off_minor = 0
               OR (written_off_on IS NOT NULL AND written_off_reason IS NOT NULL)),

    CONSTRAINT employee_advances_write_off_within_principal
        CHECK (written_off_minor >= 0 AND written_off_minor <= principal_minor)
);

COMMENT ON TABLE public.employee_advances IS
    'Salary advances and employee loans. A RECEIVABLE, not payroll cost. '
    'There is deliberately NO outstanding balance column: the balance is '
    'folded from employee_advance_recoveries, because a counter drifts and it '
    'drifts in the direction of over- or under-recovering from a salary.';

COMMENT ON COLUMN public.employee_advances.agreement_reference IS
    'Required by s.12 of the Payment of Wages Act, 1936: the rules of recovery '
    'must be prescribed. An open-ended monthly deduction at the employer''s '
    'discretion is not lawful even when it is under the s.7(3) cap.';

COMMENT ON COLUMN public.employee_advances.perquisite_valuation IS
    'Always not_computed. Rule 3(7)(i) of the Income-tax Rules, 1962 needs the '
    'SBI rate as on the first day of the previous year, which Ordence does not '
    'hold. A CA must value the perquisite.';

CREATE UNIQUE INDEX IF NOT EXISTS employee_advances_id_tenant_key
    ON public.employee_advances (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS employee_advances_no_key
    ON public.employee_advances (tenant_id, advance_no);

CREATE INDEX IF NOT EXISTS employee_advances_employee_idx
    ON public.employee_advances (tenant_id, employee_id, status);


-- ============================================================================
-- SECTION 2b · `employee_advance_instalments` · THE AGREED SCHEDULE
-- ============================================================================
-- s.12(b) , "the instalments by which they may be recovered".
--
-- 🔴 THE INSTALMENTS SUM TO THE PRINCIPAL EXACTLY. buildInstalmentSchedule()
--    makes the LAST one absorb the remainder, so ₹10,000 over three months is
--    3333.33 + 3333.33 + 3333.34. Three equal instalments recover either a
--    paise too few (the advance never closes and the employee owes ₹0.01
--    forever) or a paise too many (an unauthorised deduction under s.7(1),
--    however trivial the amount).
--
-- ⚠️ THIS TABLE IS MUTABLE AND THE RECOVERY LEDGER IS NOT, WHICH IS THE RIGHT
--    WAY ROUND. A refused instalment is DEFERRED: its period moves to the far
--    end of the schedule and its amount does not change. The plan may move;
--    what was actually taken from somebody's wages may not.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.employee_advance_instalments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    advance_id    uuid          NOT NULL REFERENCES public.employee_advances(id) ON DELETE CASCADE,

    -- 1-based and STABLE across deferrals, so the ledger can name it.
    seq           integer       NOT NULL,
    -- "YYYY-MM". Moves on deferral; seq does not.
    period        varchar(7)    NOT NULL,
    amount_minor  numeric(18,0) NOT NULL,

    -- ⭐ How many wage periods this instalment has been pushed back by a
    --    s.7(3) refusal. Visible because an employer whose employee is at the
    --    cap month after month needs to SEE it happening rather than discover
    --    it when the advance has not closed a year later.
    deferrals     integer       NOT NULL DEFAULT 0,

    created_at    timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT employee_advance_instalments_positive
        CHECK (amount_minor > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_advance_instalments_id_tenant_key
    ON public.employee_advance_instalments (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS employee_advance_instalments_seq_key
    ON public.employee_advance_instalments (tenant_id, advance_id, seq);

CREATE INDEX IF NOT EXISTS employee_advance_instalments_period_idx
    ON public.employee_advance_instalments (tenant_id, period);


-- ============================================================================
-- SECTION 3 · `employee_advance_recoveries` · THE APPEND-ONLY LEDGER
-- ============================================================================
-- 🔴🔴 THIS IS THE BALANCE. Nothing else is.
--
-- ⭐ THE CAP WORKING IS FROZEN ON EVERY ROW , cap_base_minor, cap_bp and
--    other_deductions_minor are what s.7(3) was applied to at the time. An
--    employee querying a deduction two years later is entitled to the working,
--    and re-deriving it from today's payslip proves nothing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.employee_advance_recoveries (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    -- 🔴 RESTRICT, not cascade. The evidence outlives the header row.
    advance_id             uuid          NOT NULL REFERENCES public.employee_advances(id) ON DELETE RESTRICT,
    -- Nullable only for a recovery made outside a payroll run.
    payslip_id             uuid REFERENCES public.payslips(id) ON DELETE RESTRICT,

    period                 varchar(7)    NOT NULL,
    -- ⚠️ Paise ACTUALLY deducted. Never a clamped part-instalment: an over-cap
    --    recovery is refused and writes no row at all.
    amount_minor           numeric(18,0) NOT NULL,
    instalment_seq         integer       NOT NULL,

    cap_base_minor         numeric(18,0) NOT NULL,
    cap_bp                 integer       NOT NULL DEFAULT 5000,
    other_deductions_minor numeric(18,0) NOT NULL DEFAULT 0,

    recovered_on           date          NOT NULL,
    created_at             timestamptz   NOT NULL DEFAULT now(),
    created_by             uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT employee_advance_recoveries_positive
        CHECK (amount_minor > 0),

    -- 🔴🔴 s.7(3) IN THE DATABASE, in integer basis points so no rounding can
    --    creep in: (this recovery + the other deductions of the same wage
    --    period) × 10000 ≤ wages × bp. The same shape as
    --    employee_settlements_within_cap from 0094, because it is the same
    --    rule , the cap applies to the TOTAL of the deductions of a wage
    --    period, not to each of them separately.
    CONSTRAINT employee_advance_recoveries_within_cap
        CHECK ((amount_minor + other_deductions_minor) * 10000
               <= cap_base_minor * cap_bp)
);

COMMENT ON TABLE public.employee_advance_recoveries IS
    'Append-only ledger of instalments ACTUALLY recovered from wages. The '
    'outstanding balance of an advance is folded from this table and is stored '
    'nowhere. A recovery that can be edited after the fact is not evidence '
    'that the recovery happened.';

CREATE UNIQUE INDEX IF NOT EXISTS employee_advance_recoveries_id_tenant_key
    ON public.employee_advance_recoveries (id, tenant_id);

-- ⚠️ ONE RECOVERY PER ADVANCE PER WAGE PERIOD. A payroll run that is re-run
--    must not deduct twice from the same month's wages, and on an append-only
--    table the unique index is the only thing that can stop it , there is no
--    UPDATE path to make idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS employee_advance_recoveries_period_key
    ON public.employee_advance_recoveries (tenant_id, advance_id, period);

CREATE INDEX IF NOT EXISTS employee_advance_recoveries_advance_idx
    ON public.employee_advance_recoveries (tenant_id, advance_id);


-- ----------------------------------------------------------------------------
-- 🔴 THE APPEND-ONLY GUARD, BELOW THE APPLICATION
-- ----------------------------------------------------------------------------
-- block_mutation_append_only() already exists , 0005 created it for
-- permission_denials and it is generic (it names TG_TABLE_NAME and TG_OP).
-- CREATE OR REPLACE here rather than assuming, so this file is re-runnable
-- against a database where 0005 has been superseded.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION block_mutation_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

DROP TRIGGER IF EXISTS employee_advance_recoveries_no_update
    ON public.employee_advance_recoveries;
CREATE TRIGGER employee_advance_recoveries_no_update
    BEFORE UPDATE ON public.employee_advance_recoveries
    FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();

DROP TRIGGER IF EXISTS employee_advance_recoveries_no_delete
    ON public.employee_advance_recoveries;
CREATE TRIGGER employee_advance_recoveries_no_delete
    BEFORE DELETE ON public.employee_advance_recoveries
    FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();


-- ============================================================================
-- SECTION 4 · `employee_reimbursement_claims` · EVIDENCE DECIDES THE TAX
-- ============================================================================
-- 🔴🔴 treatment IS NEVER A USER'S CHOICE. lib/payroll/reimbursements.ts adds
--    up the ACCEPTABLE documents and the part with nothing behind it becomes a
--    TAXABLE ALLOWANCE under s.17(1)(iv) of the Income-tax Act, 1961 rather
--    than a tax-free repayment of expenditure.
--
-- ⚠️ THE SHORTFALL IS RECLASSIFIED, NOT REFUSED. Refusing would push the
--    employer into paying it outside the payroll, where no tax is deducted at
--    all, which is worse than paying it and taxing it.
--
-- ⭐ THE CHECK BELOW IS THE DATABASE'S COPY OF THE RULE. A pure function is a
--    rule an INSERT can walk around; a constraint is not.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.employee_reimbursement_claims (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid          NOT NULL REFERENCES public.tenants(id)   ON DELETE CASCADE,
    employee_id             uuid          NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,

    claim_no                varchar(30)   NOT NULL,
    category                varchar(40)   NOT NULL,
    description             text          NOT NULL,
    incurred_on             date          NOT NULL,

    claimed_minor           numeric(18,0) NOT NULL,
    -- Paise proven by acceptable documents, capped at the claim. A ₹6,000 bill
    -- against a ₹4,000 claim evidences ₹4,000 , letting the surplus carry
    -- would let one large bill launder a later claim.
    evidenced_minor         numeric(18,0) NOT NULL DEFAULT 0,
    -- 🔴 Not wages: outside PF, ESI, professional tax and s.192 entirely.
    not_wages_minor         numeric(18,0) NOT NULL DEFAULT 0,
    -- 🔴 Salary income. Taxable. The part with no bill behind it.
    taxable_allowance_minor numeric(18,0) NOT NULL DEFAULT 0,

    treatment               varchar(40)   NOT NULL,

    -- ⚠️ 'no' or 'notDecided'. Ordence does NOT decide whether PF and ESI
    --    reach the allowance portion. It turns on whether the sum is "basic
    --    wages" under s.2(b) of the Employees' Provident Funds and
    --    Miscellaneous Provisions Act, 1952 and "wages" under s.2(22) of the
    --    Employees' State Insurance Act, 1948 , a boundary the Supreme
    --    Court's 2019 decision on universally-paid allowances left
    --    establishment-specific. A stated "not decided" on the screen is worth
    --    more than a confident flag that is wrong for this establishment, and
    --    being wrong costs interest under s.7Q and damages under s.14B.
    pf_on_allowance         varchar(20)   NOT NULL DEFAULT 'no',
    esi_on_allowance        varchar(20)   NOT NULL DEFAULT 'no',

    -- ⭐ The documents themselves , kind, reference, date, amount.
    evidence                jsonb         NOT NULL DEFAULT '[]'::jsonb,
    assessment              jsonb         NOT NULL,

    -- 🔴 THE SECOND CONDITION, INDEPENDENT OF THE BILL. A fully-billed dinner
    --    that was not for the employer is not a reimbursement however good the
    --    receipt is , s.10(14)(i) requires the expense to be incurred in the
    --    performance of the duties of an office.
    incurred_for_employer   boolean       NOT NULL DEFAULT false,

    status                  varchar(20)   NOT NULL DEFAULT 'submitted',
    approved_at             timestamptz,
    approved_by             uuid REFERENCES public.users(id) ON DELETE SET NULL,
    payslip_id              uuid REFERENCES public.payslips(id) ON DELETE SET NULL,
    paid_on                 date,

    created_at              timestamptz   NOT NULL DEFAULT now(),
    created_by              uuid REFERENCES public.users(id) ON DELETE SET NULL,

    -- ⭐ Nothing is lost and nothing is invented: the split IS the claim.
    CONSTRAINT employee_reimbursement_claims_split_adds_up
        CHECK (not_wages_minor + taxable_allowance_minor = claimed_minor),

    -- 🔴🔴 NO EVIDENCE, NO TAX-FREE TREATMENT. The rule the whole feature
    --    exists for, enforced where an INSERT cannot route around it.
    CONSTRAINT employee_reimbursement_claims_not_wages_needs_evidence
        CHECK (not_wages_minor = 0
               OR (jsonb_array_length(evidence) > 0 AND incurred_for_employer = true)),

    CONSTRAINT employee_reimbursement_claims_evidence_within_claim
        CHECK (evidenced_minor >= 0 AND evidenced_minor <= claimed_minor),

    -- The non-wages part is never more than what the documents prove.
    CONSTRAINT employee_reimbursement_claims_not_wages_within_evidence
        CHECK (not_wages_minor <= evidenced_minor)
);

COMMENT ON TABLE public.employee_reimbursement_claims IS
    'Reimbursement claims. The tax treatment is DERIVED from the evidence, not '
    'chosen: a claim with no acceptable document behind it is a taxable '
    'allowance under s.17(1)(iv) of the Income-tax Act, 1961, not a tax-free '
    'repayment of expenditure.';

CREATE UNIQUE INDEX IF NOT EXISTS employee_reimbursement_claims_id_tenant_key
    ON public.employee_reimbursement_claims (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS employee_reimbursement_claims_no_key
    ON public.employee_reimbursement_claims (tenant_id, claim_no);

CREATE INDEX IF NOT EXISTS employee_reimbursement_claims_employee_idx
    ON public.employee_reimbursement_claims (tenant_id, employee_id, status);


-- ============================================================================
-- SECTION 5 · ROW LEVEL SECURITY ON ALL FOUR TABLES
-- ============================================================================
-- 🔴 EVERY ONE OF THESE CARRIES tenant_id, SO check-rls-coverage REQUIRES:
--    ENABLE, FORCE, and a policy whose USING names app_current_tenant_id().
--
-- ⚠️ FORCE MATTERS MORE THAN ENABLE HERE. Plain ENABLE does not apply to the
--    table OWNER, and a migration runs as the owner. FORCE exists precisely so
--    the owner is not exempt , without it the isolation would be a comment
--    rather than a control.
--
-- ⚠️ AND NONE OF THESE IS PLATFORM-WRITABLE, DELIBERATELY. An advance is the
--    tenant's own act: their HR grants it, their employee consents to it,
--    their payroll recovers it. Unlike tenant_slug_history in 0091, which
--    records what the PLATFORM did to a tenant, nobody , operator included ,
--    writes a loan against somebody's salary except in that tenant's own
--    session. So the WITH CHECK is the plain tenant predicate and there is no
--    escape hatch.
-- ============================================================================

ALTER TABLE public.employee_advances                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_advances                FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_advances_tenant_isolation ON public.employee_advances;
CREATE POLICY employee_advances_tenant_isolation ON public.employee_advances
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.employee_advance_instalments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_advance_instalments     FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_advance_instalments_tenant_isolation
    ON public.employee_advance_instalments;
CREATE POLICY employee_advance_instalments_tenant_isolation
    ON public.employee_advance_instalments
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.employee_advance_recoveries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_advance_recoveries      FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_advance_recoveries_tenant_isolation
    ON public.employee_advance_recoveries;
CREATE POLICY employee_advance_recoveries_tenant_isolation
    ON public.employee_advance_recoveries
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.employee_reimbursement_claims    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_reimbursement_claims    FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_reimbursement_claims_tenant_isolation
    ON public.employee_reimbursement_claims;
CREATE POLICY employee_reimbursement_claims_tenant_isolation
    ON public.employee_reimbursement_claims
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 6 · CONFIRMATION · THE ROW TO READ
-- ============================================================================

SELECT
    '0096 · verdict'                                          AS finding,
    (SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('employee_advances','employee_advance_instalments',
                          'employee_advance_recoveries',
                          'employee_reimbursement_claims'))    AS tables_present,
    (SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('employee_advances','employee_advance_instalments',
                          'employee_advance_recoveries',
                          'employee_reimbursement_claims')
        AND c.relrowsecurity AND c.relforcerowsecurity)        AS tables_forced,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('employee_advances','employee_advance_instalments',
                          'employee_advance_recoveries',
                          'employee_reimbursement_claims'))    AS policies_present,
    (SELECT count(*) FROM pg_trigger
      WHERE tgrelid = 'public.employee_advance_recoveries'::regclass
        AND NOT tgisinternal)                                  AS append_only_triggers,
    -- 🔴 The one column that must NOT exist. A running counter drifts, and it
    --    drifts in the direction of over- or under-recovering from a salary.
    NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_advances'
           AND column_name IN ('outstanding_minor','balance_minor')
    )                                                          AS no_balance_counter,
    CASE
        WHEN (SELECT count(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public'
                 AND c.relname IN ('employee_advances','employee_advance_instalments',
                                   'employee_advance_recoveries',
                                   'employee_reimbursement_claims')
                 AND c.relrowsecurity AND c.relforcerowsecurity) = 4
         AND (SELECT count(*) FROM pg_trigger
               WHERE tgrelid = 'public.employee_advance_recoveries'::regclass
                 AND NOT tgisinternal) >= 2
            THEN 'PASS , four tenant-scoped tables with RLS enabled AND forced, and the recovery ledger is append-only by trigger'
        ELSE 'FAIL , send me the error from the tab that refused'
    END                                                        AS verdict;
