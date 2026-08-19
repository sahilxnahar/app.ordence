-- =====================================================================
--  ORDENCE — 0075 · PAYROLL
--  Version: v1.23.0-alpha · Batch 15
--
--  ⚠️ RUN AFTER 0074. Five new tables, two new enums, one trigger.
--  Touches nothing that already exists.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded.
--  ⭐ ADDITIVE ONLY. No DROP, no RENAME, no type change on a live
--     column — so a code rollback leaves these tables sitting harmless.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 THE ONE THING TO GET RIGHT IS THAT PAYROLL ACCRUES
--  ══════════════════════════════════════════════════════════════════
--  The wrong payroll journal debits "Salaries" with the NET paid and
--  credits the bank. It balances. It is also understated by every
--  rupee of PF, ESI, professional tax and TDS withheld — money the
--  business spent on employing people and owes to somebody else.
--
--  ⭐ The right one debits the GROSS, debits the employer's own
--  contributions on top, and credits five separate liabilities. What
--  leaves the bank is a LATER event against Salaries Payable, on the
--  day the transfer actually clears.
--
--  ⚠️ WHICH IS WHY THIS FILE STORES NO BANK ACCOUNT NUMBERS. Ordence
--  accrues payroll; it does not disburse it. A bank account number here
--  would be a credential sitting in a row every support session can
--  read, in service of a feature that does not exist yet. When NEFT
--  advice files are built they will read from `vault_secrets`.
--
--  🔴 AND NO AADHAAR, ever, for the same reason the labour module
--  refuses it: it is the identifier that makes a breach unrecoverable,
--  and payroll can be operated correctly without it.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ENUMS
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE payroll_run_status AS ENUM
    ('draft', 'computed', 'approved', 'posted', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tax_regime AS ENUM ('new', 'old');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
--  ① EMPLOYEES
-- =====================================================================
--
--  ⚠️ NOT `users` AND NOT `site_workers`, AND BOTH SEPARATIONS MATTER.
--  `users` are people who can sign in; most employees on a payroll
--  never will. `site_workers` are contract labour brought by a vendor
--  and paid through that vendor's RA bill — giving them payslips would
--  misstate the employment relationship in a way a labour inspector
--  cares about.
CREATE TABLE IF NOT EXISTS employees (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    employee_code       varchar(40) NOT NULL,
    full_name           varchar(200) NOT NULL,
    designation         varchar(120),
    department          varchar(120),

    user_id             uuid REFERENCES users(id) ON DELETE SET NULL,

    --  🔴 THE STATE THE EMPLOYEE WORKS IN, NOT WHERE THE COMPANY IS
    --  REGISTERED. Professional tax is a State levy, and a Bengaluru
    --  company with three people in Mumbai owes Maharashtra for those
    --  three.
    work_state_code     varchar(2) NOT NULL,

    joined_on           date NOT NULL,
    left_on             date,

    --  ⚠️ REQUIRED TO OPERATE SECTION 192. Its ABSENCE makes the
    --  calculation refuse rather than silently apply 20% under 206AA to
    --  somebody who has simply not typed it in yet.
    pan                 varchar(10),
    uan                 varchar(12),
    esic_number         varchar(17),

    pf_exempt           boolean NOT NULL DEFAULT false,
    pf_on_full_wages    boolean NOT NULL DEFAULT false,
    esi_exempt          boolean NOT NULL DEFAULT false,

    tax_regime          tax_regime NOT NULL DEFAULT 'new',
    declared_deductions_minor numeric(18,0) NOT NULL DEFAULT 0,

    --  ⭐ THE ACCOUNTANT'S OWN FIGURE, OR NULL TO PROJECT. First-class
    --  rather than a hack: a payroll system that refuses the number the
    --  accountant arrived at is one that gets bypassed with a
    --  spreadsheet, after which nothing in the ledger is right.
    tds_override_minor  numeric(18,0),

    is_active           boolean NOT NULL DEFAULT true,
    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT employees_pan_shape CHECK (
        pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'
    ),
    CONSTRAINT employees_uan_shape CHECK (
        uan IS NULL OR uan ~ '^[0-9]{12}$'
    ),
    CONSTRAINT employees_dates_ordered CHECK (
        left_on IS NULL OR left_on >= joined_on
    ),
    CONSTRAINT employees_deductions_sane CHECK (declared_deductions_minor >= 0),
    CONSTRAINT employees_override_sane CHECK (
        tds_override_minor IS NULL OR tds_override_minor >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS employees_id_tenant_key
    ON employees (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS employees_code_key
    ON employees (tenant_id, employee_code);
CREATE UNIQUE INDEX IF NOT EXISTS employees_uan_key
    ON employees (tenant_id, uan) WHERE uan IS NOT NULL;
CREATE INDEX IF NOT EXISTS employees_active_idx
    ON employees (tenant_id, is_active, full_name);

-- =====================================================================
--  ② PAY COMPONENTS AND STRUCTURE
-- =====================================================================

CREATE TABLE IF NOT EXISTS pay_components (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    code                varchar(40) NOT NULL,
    label               varchar(120) NOT NULL,
    kind                varchar(12) NOT NULL,

    pf_applicable       boolean NOT NULL DEFAULT false,
    esi_applicable      boolean NOT NULL DEFAULT true,
    taxable             boolean NOT NULL DEFAULT true,

    --  🔴 THE MOST ARGUED-ABOUT FLAG IN INDIAN PAYROLL. False means the
    --  amount is paid in full regardless of days worked. Backwards on
    --  one component produces a payslip wrong by a plausible amount for
    --  everybody who took a day off.
    pro_rates           boolean NOT NULL DEFAULT true,

    display_order       integer NOT NULL DEFAULT 100,
    is_active           boolean NOT NULL DEFAULT true,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pay_components_kind_known CHECK (kind IN ('earning', 'deduction'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pay_components_id_tenant_key
    ON pay_components (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS pay_components_code_key
    ON pay_components (tenant_id, code);

--  ⚠️ EFFECTIVE-DATED AND NEVER UPDATED IN PLACE. A raise is a NEW ROW.
--  Editing the old one silently re-prices every payslip ever reissued
--  from it, and payroll is retrospective by nature.
CREATE TABLE IF NOT EXISTS employee_pay_structure (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    employee_id         uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    component_id        uuid NOT NULL REFERENCES pay_components(id) ON DELETE RESTRICT,

    monthly_amount_minor numeric(18,0) NOT NULL,

    effective_from      date NOT NULL,
    effective_to        date,
    reason              text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT employee_pay_structure_amount_sane CHECK (monthly_amount_minor >= 0),
    CONSTRAINT employee_pay_structure_dates_ordered CHECK (
        effective_to IS NULL OR effective_to >= effective_from
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_pay_structure_id_tenant_key
    ON employee_pay_structure (id, tenant_id);
CREATE INDEX IF NOT EXISTS employee_pay_structure_lookup_idx
    ON employee_pay_structure (tenant_id, employee_id, effective_from);

--  ⭐ ONE LIVE STRUCTURE ROW PER EMPLOYEE PER COMPONENT.
--
--  ⚠️ WITHOUT THIS, TWO OPEN-ENDED ROWS FOR "BASIC" BOTH APPLY AND THE
--  EMPLOYEE IS PAID BASIC TWICE. It is the exact shape of mistake a
--  correction made in a hurry produces: add the new row, forget to
--  close the old one.
CREATE UNIQUE INDEX IF NOT EXISTS employee_pay_structure_one_open
    ON employee_pay_structure (employee_id, component_id)
    WHERE effective_to IS NULL;

-- =====================================================================
--  ③ STATUTORY RATES — ROWS, NEVER CONSTANTS
-- =====================================================================
--
--  🔴 THE POINT IS THE DATES, NOT THE STORAGE. Payroll is
--  retrospective: March must be calculable in September using MARCH's
--  rates. A rate compiled into code makes that impossible, and nobody
--  notices until an employee asks for a duplicate payslip and gets a
--  different number from the one in their bank statement.
CREATE TABLE IF NOT EXISTS statutory_rates (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    --  pf · esi · professional_tax · income_tax · income_tax_slab
    kind                varchar(30) NOT NULL,
    --  State code for professional tax; regime for income tax; else NULL.
    scope               varchar(20),

    effective_from      date NOT NULL,
    effective_to        date,

    payload             jsonb NOT NULL,
    note                text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT statutory_rates_kind_known CHECK (
        kind IN ('pf', 'esi', 'professional_tax', 'income_tax', 'income_tax_slab')
    ),
    CONSTRAINT statutory_rates_dates_ordered CHECK (
        effective_to IS NULL OR effective_to >= effective_from
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS statutory_rates_id_tenant_key
    ON statutory_rates (id, tenant_id);
CREATE INDEX IF NOT EXISTS statutory_rates_lookup_idx
    ON statutory_rates (tenant_id, kind, scope, effective_from);

-- =====================================================================
--  ④ THE RUN
-- =====================================================================

CREATE TABLE IF NOT EXISTS payroll_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    run_no              varchar(30) NOT NULL,
    period_start        date NOT NULL,
    period_end          date NOT NULL,

    status              payroll_run_status NOT NULL DEFAULT 'draft',

    employee_count      integer NOT NULL DEFAULT 0,
    gross_minor         numeric(18,0) NOT NULL DEFAULT 0,
    employee_pf_minor   numeric(18,0) NOT NULL DEFAULT 0,
    employer_pf_minor   numeric(18,0) NOT NULL DEFAULT 0,
    employer_pension_minor numeric(18,0) NOT NULL DEFAULT 0,
    edli_minor          numeric(18,0) NOT NULL DEFAULT 0,
    pf_admin_minor      numeric(18,0) NOT NULL DEFAULT 0,
    employee_esi_minor  numeric(18,0) NOT NULL DEFAULT 0,
    employer_esi_minor  numeric(18,0) NOT NULL DEFAULT 0,
    professional_tax_minor numeric(18,0) NOT NULL DEFAULT 0,
    tds_minor           numeric(18,0) NOT NULL DEFAULT 0,
    other_deductions_minor numeric(18,0) NOT NULL DEFAULT 0,
    net_pay_minor       numeric(18,0) NOT NULL DEFAULT 0,
    employer_cost_minor numeric(18,0) NOT NULL DEFAULT 0,

    problem_count       integer NOT NULL DEFAULT 0,

    computed_at         timestamptz,
    approved_at         timestamptz,
    approved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    approval_note       text,

    posted_at           timestamptz,
    transaction_id      uuid REFERENCES transactions(id) ON DELETE RESTRICT,

    cancelled_at        timestamptz,
    cancel_reason       text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT payroll_runs_period_ordered CHECK (period_end >= period_start),
    --  ⚠️ A CANCELLED RUN HAS TO SAY WHY. "Cancelled" with no reason is
    --  a row somebody will ask about in six months and nobody can
    --  answer.
    CONSTRAINT payroll_runs_cancel_explained CHECK (
        status <> 'cancelled' OR length(btrim(coalesce(cancel_reason, ''))) >= 10
    ),
    --  🔴 POSTED MEANS THERE IS A JOURNAL. A run marked posted with no
    --  transaction is the exact state that makes a wage bill vanish
    --  from the P&L while the screen says it was posted.
    CONSTRAINT payroll_runs_posted_has_journal CHECK (
        status <> 'posted' OR transaction_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_id_tenant_key
    ON payroll_runs (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_no_key
    ON payroll_runs (tenant_id, run_no);

--  🔴🔴 ONE LIVE RUN PER PERIOD.
--
--  ⚠️ TWO PAYROLLS FOR THE SAME MARCH BOTH POST, and the wage bill
--  doubles in the ledger with nothing anywhere reporting a problem.
--  Every figure downstream — the P&L, the PF challan, the 24Q — is then
--  exactly twice the truth and entirely plausible.
--
--  ⭐ A CANCELLED RUN DOES NOT COUNT, which is what makes a redo
--  possible without deleting evidence.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_one_live_per_period
    ON payroll_runs (tenant_id, period_start)
    WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS payroll_runs_status_idx
    ON payroll_runs (tenant_id, status, period_start DESC);

-- =====================================================================
--  ⑤ PAYSLIPS
-- =====================================================================
--
--  ⭐ THE EMPLOYEE'S NAME AND CODE ARE FROZEN ON THE ROW. A payslip
--  reissued after a name change must show the name that was on it;
--  joining to `employees` at read time shows today's, and a payslip
--  that does not match the one the employee is holding is worse than
--  no payslip at all.
CREATE TABLE IF NOT EXISTS payslips (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    run_id              uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id         uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,

    employee_name       varchar(200) NOT NULL,
    employee_code       varchar(40) NOT NULL,

    days_in_month       integer NOT NULL,
    payable_days        numeric(6,2) NOT NULL,
    lop_days            numeric(6,2) NOT NULL DEFAULT 0,

    gross_minor         numeric(18,0) NOT NULL,
    pf_wages_minor      numeric(18,0) NOT NULL DEFAULT 0,
    employee_pf_minor   numeric(18,0) NOT NULL DEFAULT 0,
    employer_pf_minor   numeric(18,0) NOT NULL DEFAULT 0,
    employer_pension_minor numeric(18,0) NOT NULL DEFAULT 0,
    edli_minor          numeric(18,0) NOT NULL DEFAULT 0,
    pf_admin_minor      numeric(18,0) NOT NULL DEFAULT 0,
    employee_esi_minor  numeric(18,0) NOT NULL DEFAULT 0,
    employer_esi_minor  numeric(18,0) NOT NULL DEFAULT 0,
    professional_tax_minor numeric(18,0) NOT NULL DEFAULT 0,
    tds_minor           numeric(18,0) NOT NULL DEFAULT 0,
    other_deductions_minor numeric(18,0) NOT NULL DEFAULT 0,
    total_deductions_minor numeric(18,0) NOT NULL DEFAULT 0,
    net_pay_minor       numeric(18,0) NOT NULL,

    tds_is_projection   boolean NOT NULL DEFAULT false,
    tds_overridden      boolean NOT NULL DEFAULT false,

    lines               jsonb NOT NULL,
    notes               jsonb NOT NULL DEFAULT '[]'::jsonb,
    problems            jsonb NOT NULL DEFAULT '[]'::jsonb,

    created_at          timestamptz NOT NULL DEFAULT now(),

    --  ⚠️ THE PAYSLIP MUST ADD UP TO ITSELF, IN THE DATABASE.
    --  An employee with a calculator checks this, and they are right to.
    CONSTRAINT payslips_adds_up CHECK (
        net_pay_minor = gross_minor - total_deductions_minor
    ),
    CONSTRAINT payslips_days_sane CHECK (
        days_in_month BETWEEN 28 AND 31
        AND payable_days >= 0
        AND lop_days >= 0
        AND lop_days <= payable_days
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS payslips_id_tenant_key
    ON payslips (id, tenant_id);
--  ⚠️ One payslip per employee per run. Two is a duplicate payment.
CREATE UNIQUE INDEX IF NOT EXISTS payslips_run_employee_key
    ON payslips (run_id, employee_id);
CREATE INDEX IF NOT EXISTS payslips_run_idx ON payslips (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS payslips_employee_idx ON payslips (tenant_id, employee_id);

-- =====================================================================
--  ⑥ THE GUARD: AN APPROVED RUN IS FROZEN
-- =====================================================================
--
--  🔴🔴 THIS IS THE ONE TRIGGER IN THIS FILE AND IT IS THE WHOLE
--  INTEGRITY STORY.
--
--  ⚠️ APPROVAL IS A SIGNATURE. Somebody looked at a wage bill and said
--  yes to it. If a payslip can still change afterwards, the signature
--  attaches to nothing — and the change that gets made after approval
--  is never a correction of a typo, it is a number somebody wanted to
--  be different.
--
--  ⭐ THE REMEDY IS TO CANCEL AND RE-RUN, WITH A REASON, which leaves
--  both runs in the table. Editing in place leaves one.
CREATE OR REPLACE FUNCTION ordence_guard_payroll_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status payroll_run_status;
BEGIN
  SELECT status INTO run_status FROM payroll_runs
   WHERE id = COALESCE(NEW.run_id, OLD.run_id);

  IF run_status IN ('approved', 'posted') THEN
    RAISE EXCEPTION
      'This payroll run has been approved and its payslips can no longer change. Approval is a signature on a wage bill; if the figures are wrong, cancel the run with a reason and raise a new one so both are on the record.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_payroll_frozen ON payslips;
CREATE TRIGGER ordence_guard_payroll_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON payslips
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_payroll_frozen();

--  ⚠️ AND THE RUN ITSELF MAY NOT WALK BACKWARDS.
--
--  🔴 A posted run returning to draft would let the same wage bill post
--  twice. The status column is a ratchet, and `cancelled` is the only
--  exit from any state before `posted`.
CREATE OR REPLACE FUNCTION ordence_guard_payroll_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rank_old int;
  rank_new int;
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;

  IF NEW.status = 'cancelled' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION
        'This run has already been posted to the ledger and cannot be cancelled. A posted wage bill is reversed with a journal entry, not by changing a status.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  rank_old := CASE OLD.status
    WHEN 'draft' THEN 1 WHEN 'computed' THEN 2
    WHEN 'approved' THEN 3 WHEN 'posted' THEN 4 ELSE 0 END;
  rank_new := CASE NEW.status
    WHEN 'draft' THEN 1 WHEN 'computed' THEN 2
    WHEN 'approved' THEN 3 WHEN 'posted' THEN 4 ELSE 0 END;

  --  ⭐ COMPUTED BACK TO DRAFT IS THE ONE PERMITTED REVERSAL, because
  --  recomputing a run nobody has signed off is ordinary work.
  IF rank_old = 2 AND rank_new = 1 THEN RETURN NEW; END IF;

  IF rank_new < rank_old THEN
    RAISE EXCEPTION
      'A payroll run cannot go from % back to %. Cancel it with a reason and raise a new one.',
      OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_payroll_status ON payroll_runs;
CREATE TRIGGER ordence_guard_payroll_status
  BEFORE UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_payroll_status();

-- =====================================================================
--  ⑦ ROW LEVEL SECURITY
-- =====================================================================
--
--  ⚠️ PAYROLL IS THE MOST SENSITIVE DATA IN THE PRODUCT. One tenant
--  reading another's salaries is not a data leak like any other — it is
--  every individual's pay in a competitor's hands.
--
--  ⭐ `app_platform_scope()` GOES IN `USING` AND NEVER IN `WITH CHECK`,
--  the house rule the whole schema follows and that 0014 fails a deploy
--  over.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employees', 'pay_components', 'employee_pay_structure',
    'statutory_rates', 'payroll_runs', 'payslips'
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

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  NO BANK ACCOUNT NUMBERS AND NO NEFT ADVICE. Payroll accrues here;
--  the transfer is made in the bank's portal and cleared as a payment
--  against Salaries Payable. When advice files are built they will read
--  account numbers from `vault_secrets`, encrypted, with their own
--  argument for why.
--
--  NO FORM 16 AND NO 24Q. Those are returns, and returns belong with
--  the monthly-return batch that reads what this one posts.
--
--  NO ARREARS, GRATUITY, BONUS OR FULL-AND-FINAL SETTLEMENT. Each is a
--  real feature with its own rules, and shipping a half version of any
--  of them would produce numbers that look right.
--
--  NO EMPLOYEE LOAN LEDGER. `other_deductions` is therefore credited to
--  Salaries Payable rather than to a loan account. That is stated in
--  the posting builder as a limitation rather than hidden as a design.
-- =====================================================================
