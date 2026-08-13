-- =====================================================================
--  0053 — TIME & BILLING · the engine Legal and Professional Services
--         both run on, and neither could use
--  Ordence · v1.1.0-alpha
-- =====================================================================
--
--  ⭐⭐ WHY THIS IS THE RIGHT SHARED ENGINE
--  ------------------------------------------------------------------
--  A law firm, a CA practice and a software consultancy sell the same
--  thing: a person's hour. Ordence could invoice it, tax it, collect it
--  and post it to the ledger — and had nowhere to RECORD it.
--
--  `server/actions/timesheets.ts` has exactly one function, and it only
--  reads. `field_jobs.is_billable` is a flag with no hours behind it.
--  There was no time entry, no rate, and no path from an hour worked to
--  a rupee invoiced.
--
--  ⚠️ AND NO RETAINER TABLE IS CREATED HERE, DELIBERATELY. A legal
--  retainer is money held before work is done — which is EXACTLY an
--  unapplied customer receipt, already built and tested in v0.98.0. A
--  second table for the same fact would give two balances for one pot of
--  the client's money, and the reconciliation between them would be
--  somebody's monthly job forever.
-- =====================================================================


-- =====================================================================
--  ① BILLING RATES
-- =====================================================================
--  🔴 RATES ARE EFFECTIVE-DATED AND NEVER OVERWRITTEN.
--
--  A partner's rate goes from ₹8,000 to ₹9,500 on 1 April. Work done in
--  March must still bill at ₹8,000 — six months later, when somebody
--  finally raises the invoice. Updating the rate in place silently
--  re-prices every unbilled hour ever worked, and nobody notices until a
--  client queries a bill against an engagement letter.
--
--  ⚠️ THIS IS THE SAME DISCIPLINE AS GST RATE PERIODS IN 0021. An old
--  document keeps its old rate. It is not optional in either case.
CREATE TABLE IF NOT EXISTS billing_rates (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- ⭐ THE RESOLUTION LADDER. Most specific wins:
    --      person + client  →  person  →  role + client  →  role
    -- NULL means "any". A rate with both NULL is the house default.
    user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
    role_name      varchar(60),
    company_id     uuid REFERENCES companies(id) ON DELETE CASCADE,

    rate_minor     bigint NOT NULL,
    currency       varchar(3) NOT NULL DEFAULT 'INR',

    -- ⚠️ Half-open: [effective_from, effective_to). A closed range makes
    -- the last second of a day ambiguous, and that is the second a
    -- year-end entry lands on.
    effective_from date NOT NULL,
    effective_to   date,

    note           text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT billing_rates_positive     CHECK (rate_minor >= 0),
    CONSTRAINT billing_rates_sane_window  CHECK (effective_to IS NULL OR effective_to > effective_from),
    -- ⚠️ A rate that names neither a person nor a role is the house
    -- default; a rate naming a client but nothing else is that client's
    -- default. Both are legitimate. What is NOT legitimate is nothing at
    -- all with no client either — that is a row nobody can explain.
    CONSTRAINT billing_rates_has_a_subject CHECK (
        user_id IS NOT NULL OR role_name IS NOT NULL OR company_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS billing_rates_lookup_idx
    ON billing_rates (tenant_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS billing_rates_user_idx
    ON billing_rates (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_rates_company_idx
    ON billing_rates (tenant_id, company_id) WHERE company_id IS NOT NULL;


-- =====================================================================
--  ② TIME ENTRIES
-- =====================================================================
--  🔴 DURATION IS STORED IN WHOLE MINUTES, AS AN INTEGER.
--
--  Never hours as a decimal. `0.1 + 0.1 + 0.1` is 0.30000000000000004 in
--  every language this will ever be read from, and a timesheet is
--  hundreds of those additions. Minutes are exact, and the conversion to
--  "2.4 hours" happens once, at the edge, for display.
--
--  ⚠️ The same rule as money: the smallest unit, as an integer, always.
CREATE TABLE IF NOT EXISTS time_entries (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    company_id        uuid REFERENCES companies(id) ON DELETE RESTRICT,

    -- ⭐ WHAT THE TIME WAS SPENT ON, polymorphically. A law firm says
    -- "matter", a CA says "engagement", a consultancy says "project" —
    -- one column, because they are one concept wearing three words.
    subject_type      varchar(40),
    subject_id        uuid,
    subject_label     varchar(255),

    entry_date        date NOT NULL,
    minutes           integer NOT NULL,

    -- ⚠️ The rounded, BILLABLE figure — see `lib/billing/time.ts`.
    -- Stored rather than derived so that changing the firm's increment
    -- next year cannot silently re-price last year's unbilled work.
    billable_minutes  integer NOT NULL DEFAULT 0,

    is_billable       boolean NOT NULL DEFAULT true,

    -- ⚠️ THE RATE IS COPIED ONTO THE ENTRY, not looked up at invoice
    -- time. This is what makes an effective-dated rate table actually
    -- work: the hour carries the price it was worth when it was worked.
    rate_minor        bigint NOT NULL DEFAULT 0,
    value_minor       bigint NOT NULL DEFAULT 0,

    -- 🔴 REQUIRED ON A BILLABLE ENTRY. A client reads this line on the
    -- bill. "Work done" is the narrative that gets an invoice queried,
    -- and in a taxation of costs it is the narrative that gets it cut.
    narrative         text,

    status            varchar(20) NOT NULL DEFAULT 'draft',
    invoice_id        uuid,

    approved_at       timestamptz,
    approved_by       uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT time_entries_minutes_positive  CHECK (minutes > 0),
    CONSTRAINT time_entries_billable_sane     CHECK (billable_minutes >= 0),
    CONSTRAINT time_entries_value_positive    CHECK (value_minor >= 0),
    CONSTRAINT time_entries_status_known      CHECK (
        status IN ('draft', 'submitted', 'approved', 'billed', 'written_off')
    ),
    -- ⚠️ A non-billable entry must carry no value. Otherwise a written-off
    -- hour still shows up in the unbilled figure somebody is chasing.
    CONSTRAINT time_entries_non_billable_is_free CHECK (
        is_billable OR (billable_minutes = 0 AND value_minor = 0)
    ),
    -- 🔴 A billed entry MUST name its invoice, and an unbilled one must
    -- not. Without this, "what have we billed" and "what is unbilled"
    -- can both be true of the same row.
    CONSTRAINT time_entries_billed_has_invoice CHECK (
        (status = 'billed') = (invoice_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS time_entries_unbilled_idx
    ON time_entries (tenant_id, company_id, status)
    WHERE status IN ('draft', 'submitted', 'approved');
CREATE INDEX IF NOT EXISTS time_entries_user_idx
    ON time_entries (tenant_id, user_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS time_entries_subject_idx
    ON time_entries (tenant_id, subject_type, subject_id)
    WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS time_entries_invoice_idx
    ON time_entries (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⚠️ app_platform_scope() belongs in USING and NEVER in WITH CHECK.

ALTER TABLE billing_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_rates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_rates_tenant_isolation ON public.billing_rates;
CREATE POLICY billing_rates_tenant_isolation ON public.billing_rates
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS time_entries_tenant_isolation ON public.time_entries;
CREATE POLICY time_entries_tenant_isolation ON public.time_entries
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON billing_rates TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON time_entries  TO ordence_app;
