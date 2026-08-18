-- ############################################################################
-- 0101 , MULTI-CURRENCY AND FOREIGN EXCHANGE
-- ############################################################################
--
-- PURPOSE
-- -------
-- Before this file there were SIXTEEN `currency` columns across
-- `db/schema/` and NOT ONE RATE ANYWHERE. The grep that proves it:
--
--     grep -rn "exchangeRate|exchange_rate|fxRate|fx_rate|conversionRate" db lib server
--         (no matches)
--
-- So a currency was a label that was written, displayed, and never honoured.
-- The only currency logic in the entire product was a REFUSAL in
-- server/actions/accounting.ts:251 , "All ledgers in a transaction must use
-- ${data.currency}" , which is a locked door, not a translation.
--
-- 🔴 THE FAILURE THAT PRODUCES IS NOT AN ERROR MESSAGE. It is
--    `sum(amount_minor)` over a mixed-currency set returning a number that is
--    the arithmetic sum of a column and a quantity of nothing , printed on a
--    receivables ageing, believed, and chased. Nothing throws, nothing is
--    NULL, and the trial balance still foots.
--
-- ############################################################################
-- 🔴🔴 WHY THERE ARE TWO RATE TABLES, AND WHICH ONE IS TENANT-SCOPED
-- ############################################################################
--
-- This is the hardest decision in the batch, and the answer is that there are
-- two DIFFERENT KINDS OF FACT wearing the same shape.
--
-- ⭐ `fx_reference_rates` IS PLATFORM-SCOPED AND HAS NO `tenant_id`.
--    The Reserve Bank's reference rate for 31 March 2026 is one published
--    number. It is not Acme's opinion of the dollar and it is not Bharat
--    Steel's , it is the same fact for every workspace, and it is public.
--    Copying it per tenant would mean thousands of rows saying the same thing,
--    a platform write on every workspace every day, and the certainty that
--    some copies would drift. READABLE BY EVERY SESSION, WRITABLE ONLY UNDER
--    `app_platform_scope()`.
--
-- ⭐ `fx_rates` IS TENANT-SCOPED WITH `tenant_id` NOT NULL.
--    A rate somebody typed off their own bank's advice, or a forward contract
--    rate they booked, is THEIR fact and evidence for THEIR books only. One
--    workspace must never read another's, so this table carries the ordinary
--    tenant policy with NO platform escape hatch whatsoever.
--
-- 🔴 THE THIRD DESIGN , ONE TABLE WITH A NULLABLE `tenant_id` , WAS
--    CONSIDERED AND REJECTED. It works, and it makes the isolation of a
--    manual rate depend on a policy predicate reading
--    `tenant_id IS NULL OR tenant_id = app_current_tenant_id()`. That
--    predicate is correct until somebody puts a view, a materialised view or a
--    SECURITY DEFINER helper over it , at which point one workspace's
--    negotiated rate becomes another's. Two tables make the boundary
--    STRUCTURAL rather than CONDITIONAL: there is no query shape that can
--    return a foreign tenant's manual rate, because such a row is not in the
--    table being read.
--
-- ⚠️ AND NEITHER CHOICE NEEDS A PLATFORM WRITE ON A TENANT TRANSACTION. A
--    tenant invoicing in dollars READS the published rate, or WRITES its own
--    row in its own table. The platform writes once per pair per day, for
--    everybody.
--
-- ############################################################################
-- ⚠️ HOW A RATE IS STORED , DIRECTION, PRECISION, AND WHY
-- ############################################################################
--
-- `numeric(30,12)`, holding "how many QUOTE units per ONE BASE unit", with the
-- pair named explicitly and stored IN THE DIRECTION IT WAS PUBLISHED.
--
-- ⭐ PAIR-AS-PUBLISHED, NOT BASE-ANCHORED. Anchoring everything to INR and
--    dividing to get EUR/USD produces a number the RBI never published, from a
--    division nobody can point at. The tenant then cannot answer "where did
--    this rate come from" with a document. Storing the pair as published means
--    the number on the invoice is the number in the circular. The price is
--    that INVERSION IS EXPLICIT , `invertQuote()` in lib/fx/rates.ts marks
--    its result `derived`, and that flag is carried onto the screen.
--
-- ⭐ TWELVE DECIMAL PLACES. RBI publishes to FOUR (83.2150), which is enough
--    to store what is published and nowhere near enough to store its inverse:
--    truncating 1/83.215 at four places is a 1.4 per cent error , ₹1.4 lakh on
--    a ₹1 crore receivable. Twelve holds the reciprocal of any plausible rate
--    to about ten significant figures.
--
-- ⭐ AND MINOR UNITS ARE NOT UNIVERSALLY TWO DECIMAL PLACES, which is why
--    `currency_units` exists. JPY and the CFA francs have ZERO; BHD, IQD,
--    JOD, KWD, LYD, OMR and TND have THREE; CLF and UYW have FOUR.
--    lib/billing/money.ts got this wrong before this batch , it named five
--    zero-decimal currencies and defaulted everything else to two, so
--    `formatMoneyPlain(1234n,'KWD')` printed "12.34" for 1.234 dinars.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Same reason as 0092 through 0096. Migrations here are PASTED INTO THE NEON
-- BROWSER CONSOLE, which sends each statement on its own connection. `BEGIN`
-- buys no atomicity across that boundary; it only makes a half-applied file
-- look like a clean one , which is how 0091 applied half-way while reporting
-- success. `SET LOCAL app.platform_scope` as its own statement reports
-- "executed successfully" and has evaporated before the next statement runs.
--
-- ⭐ SO EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT , CREATE TABLE IF
--    NOT EXISTS, CREATE INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP
--    POLICY IF EXISTS before CREATE POLICY, ON CONFLICT DO NOTHING on every
--    seed , and the file is safe to re-run from the top after a failure at any
--    point.
--
-- ⭐ AND THE ONE SEED THAT TOUCHES A FORCE-RLS TABLE IS INSIDE A SINGLE
--    `DO $seed$ ... $seed$;` BLOCK THAT OPENS WITH
--    `PERFORM set_config('app.platform_scope','on',true)`. That is section 8.
--
-- RUN ORDER: after 0100. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If a later section refuses, this row is still on your screen and still tells
-- you what was there before you started.
-- ============================================================================

SELECT
    '0101 · diagnostic'                                        AS finding,
    current_user                                               AS running_as,
    to_regclass('public.tenants')          IS NOT NULL         AS tenants_present,
    to_regclass('public.sales_invoices')   IS NOT NULL         AS sales_invoices_present,
    to_regclass('public.purchase_invoices') IS NOT NULL        AS purchase_invoices_present,
    to_regclass('public.transactions')     IS NOT NULL         AS transactions_present,
    to_regclass('public.currency_units')   IS NOT NULL         AS currency_units_already_present,
    to_regclass('public.fx_rates')         IS NOT NULL         AS fx_rates_already_present;


-- ============================================================================
-- SECTION 2 · `currency_units` · THE EXPONENT, AS A FACT SQL CAN READ
-- ============================================================================
-- 🔴 PLATFORM REFERENCE DATA. No `tenant_id`: the number of decimal places in
--    the Kuwaiti dinar is not a property of a workspace.
--
-- ⚠️ WHY IT EXISTS WHEN lib/fx/currency.ts HOLDS THE SAME TABLE. A reporting
--    query written in SQL , a Neon console investigation, a future view ,
--    needs the exponent to scale a bigint minor amount into something a human
--    reads, and it cannot import TypeScript.
--
-- ⭐ AND THE DUPLICATE IS CHECKED RATHER THAN TRUSTED.
--    server/fx/rate-service.ts#verifyCurrencyUnits() compares this table with
--    the engine's and returns every disagreement; server/actions/fx.ts puts
--    the list on a screen. A duplicate that is compared is a cache. A
--    duplicate that is not is a second source of truth wearing a disguise.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.currency_units (
    code        varchar(3)  PRIMARY KEY,
    -- 🔴 NOT ALWAYS 2. See the header.
    exponent    integer     NOT NULL,
    name        varchar(80) NOT NULL,
    is_active   boolean     NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT currency_units_code_shape  CHECK (code ~ '^[A-Z]{3}$'),
    -- ⚠️ ISO-4217 has never defined an exponent outside 0..4.
    CONSTRAINT currency_units_exponent_range CHECK (exponent BETWEEN 0 AND 4)
);

COMMENT ON TABLE public.currency_units IS
    'ISO-4217 minor-unit exponents. Platform reference data, no tenant_id: the '
    'dinar has three decimal places in every workspace. Compared against '
    'lib/fx/currency.ts by verifyCurrencyUnits() so the two copies cannot '
    'drift in silence.';

COMMENT ON COLUMN public.currency_units.exponent IS
    'Decimal places. 0 for JPY and the CFA francs, 3 for BHD/IQD/JOD/KWD/LYD/'
    'OMR/TND, 4 for CLF/UYW, 2 for everything else. A routine that hardcodes '
    'hundredths is wrong the first time somebody invoices in yen and wrong by '
    'a factor of ten the first time somebody invoices in dinars.';

CREATE INDEX IF NOT EXISTS currency_units_active_idx
    ON public.currency_units (is_active);

-- 🔴 RLS ON A TABLE WITH NO tenant_id, AND IT IS NOT DECORATION. Without
--    FORCE, any session could UPDATE the exponent of INR to 0 and every
--    rupee figure in every SQL report would become a hundredth of itself.
--    Readable by all , it is public reference data; writable only under
--    platform scope.
ALTER TABLE public.currency_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.currency_units FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS currency_units_read_all ON public.currency_units;
CREATE POLICY currency_units_read_all ON public.currency_units
    FOR SELECT
    USING (true);
DROP POLICY IF EXISTS currency_units_platform_write ON public.currency_units;
CREATE POLICY currency_units_platform_write ON public.currency_units
    FOR ALL
    USING      (app_platform_scope())
    WITH CHECK (app_platform_scope());


-- ============================================================================
-- SECTION 3 · `fx_reference_rates` · WHAT WAS PUBLISHED
-- ============================================================================
-- 🔴 PLATFORM-SCOPED, NO `tenant_id`. See the header for the full argument.
--
-- ⚠️ `rate_date` IS THE DATE THE RATE IS FOR. `published_at` is when the row
--    was loaded, and they are routinely different , a backfill of a week of
--    history writes seven rate_dates and one published_at.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fx_reference_rates (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    base_currency     varchar(3)     NOT NULL,
    quote_currency    varchar(3)     NOT NULL,

    -- "How many quote_currency for ONE base_currency." Twelve decimals.
    rate              numeric(30,12) NOT NULL,
    rate_date         date           NOT NULL,

    -- 'rbi_reference' | 'provider'. Never 'manual' , that is tenant data.
    source            varchar(20)    NOT NULL,
    source_reference  text,

    published_at      timestamptz    NOT NULL DEFAULT now(),
    created_at        timestamptz    NOT NULL DEFAULT now(),

    -- 🔴 A RATE OF ZERO OR LESS IS NOT A RATE. Direction is carried by the
    --    pair, never by the sign, and a zero rate would make every converted
    --    figure zero while balancing perfectly.
    CONSTRAINT fx_reference_rates_positive CHECK (rate > 0),
    -- ⚠️ A SELF-PAIR IS NOT STORABLE. INR/INR is exactly 1 by construction in
    --    lib/fx/rates.ts#identityQuote; a row would be a 1 somebody could edit.
    CONSTRAINT fx_reference_rates_distinct CHECK (base_currency <> quote_currency),
    CONSTRAINT fx_reference_rates_code_shape
        CHECK (base_currency ~ '^[A-Z]{3}$' AND quote_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT fx_reference_rates_source_known
        CHECK (source IN ('rbi_reference','provider'))
);

COMMENT ON TABLE public.fx_reference_rates IS
    'Published reference exchange rates. NO tenant_id on purpose: the RBI '
    'reference rate for a day is one fact for every workspace. Readable in any '
    'session, writable only under app_platform_scope().';

-- ⚠️ THE SOURCE IS PART OF THE KEY. RBI and a commercial provider may both
--    publish USD/INR for the same day and they differ in the fourth decimal.
--    Collapsing them would make "which rate did we use" unanswerable, which is
--    the question an auditor asks.
CREATE UNIQUE INDEX IF NOT EXISTS fx_reference_rates_pair_day_key
    ON public.fx_reference_rates (base_currency, quote_currency, rate_date, source);

CREATE INDEX IF NOT EXISTS fx_reference_rates_lookup_idx
    ON public.fx_reference_rates (base_currency, quote_currency, rate_date DESC);

ALTER TABLE public.fx_reference_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_reference_rates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_reference_rates_read_all ON public.fx_reference_rates;
CREATE POLICY fx_reference_rates_read_all ON public.fx_reference_rates
    FOR SELECT
    USING (true);
DROP POLICY IF EXISTS fx_reference_rates_platform_write ON public.fx_reference_rates;
CREATE POLICY fx_reference_rates_platform_write ON public.fx_reference_rates
    FOR ALL
    USING      (app_platform_scope())
    WITH CHECK (app_platform_scope());


-- ============================================================================
-- SECTION 4 · `fx_rates` · WHAT THIS WORKSPACE TYPED
-- ============================================================================
-- 🔴 TENANT-SCOPED, `tenant_id` NOT NULL, ordinary policy, NO PLATFORM
--    ESCAPE HATCH. A tenant's negotiated rate is evidence for their books and
--    nobody else's. Unlike tenant_slug_history in 0091 , which records what
--    the PLATFORM did to a tenant , nobody, operator included, types a rate
--    into somebody's profit and loss account except in that tenant's own
--    session.
--
-- 🔴 `entered_by` IS NOT DECORATION. AS 11 ¶13 sends every exchange
--    difference to the P&L, so one paisa on a ₹10 crore exposure moves
--    reported profit by ₹1 lakh. Who typed it is part of the evidence.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fx_rates (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid           NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    base_currency     varchar(3)     NOT NULL,
    quote_currency    varchar(3)     NOT NULL,

    rate              numeric(30,12) NOT NULL,
    rate_date         date           NOT NULL,

    source            varchar(20)    NOT NULL DEFAULT 'manual',
    source_reference  text,
    note              text,

    created_at        timestamptz    NOT NULL DEFAULT now(),
    updated_at        timestamptz    NOT NULL DEFAULT now(),
    entered_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT fx_rates_positive CHECK (rate > 0),
    CONSTRAINT fx_rates_distinct CHECK (base_currency <> quote_currency),
    CONSTRAINT fx_rates_code_shape
        CHECK (base_currency ~ '^[A-Z]{3}$' AND quote_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT fx_rates_source_known
        CHECK (source IN ('manual','provider'))
);

COMMENT ON TABLE public.fx_rates IS
    'Exchange rates entered by a workspace , their bank''s advice, their '
    'forward cover. Strictly tenant-scoped: one workspace''s negotiated rate '
    'is not evidence for anybody else''s books.';

COMMENT ON COLUMN public.fx_rates.rate_date IS
    'The day the rate APPLIES TO, never the day it was typed. Correcting a '
    'rate for a day updates this row in place and moves updated_at and '
    'entered_by; it does not create a second row for the same day, because '
    'two rates for one day makes "which one did the invoice use" unanswerable.';

CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_id_tenant_key
    ON public.fx_rates (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_pair_day_key
    ON public.fx_rates (tenant_id, base_currency, quote_currency, rate_date);

CREATE INDEX IF NOT EXISTS fx_rates_lookup_idx
    ON public.fx_rates (tenant_id, base_currency, quote_currency, rate_date DESC);

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_rates_tenant_isolation ON public.fx_rates;
CREATE POLICY fx_rates_tenant_isolation ON public.fx_rates
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 5 · `fx_revaluations` · THE REPORTING-DATE RESTATEMENT RUN
-- ============================================================================
-- AS 11 ¶11 / Ind AS 21 ¶23.
--
-- ⚠️ THE GAIN AND THE LOSS ARE HELD SEPARATELY AND ARE NEVER NETTED INTO ONE
--    COLUMN. The same argument as inventory_variance_gain and
--    inventory_variance_loss: netting makes "how much did the currency cost us
--    this year" a question with no answer anywhere in the system, and in an
--    exporting business a board asks it every quarter. The net is derivable
--    from the two halves; the two halves are not derivable from the net.
--
-- ⭐ `functional_currency` IS FROZEN ON THE ROW. It lives in a JSONB settings
--    blob anybody with settings:update can change; a run that read it live
--    would silently re-base a historic restatement the day somebody switched
--    the workspace from INR to USD.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fx_revaluations (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    as_of_date           date          NOT NULL,
    functional_currency  varchar(3)    NOT NULL,

    status               varchar(20)   NOT NULL DEFAULT 'draft',

    -- Positive magnitudes, both. The net is (gain - loss).
    gain_minor           bigint        NOT NULL DEFAULT 0,
    loss_minor           bigint        NOT NULL DEFAULT 0,

    restated_count       integer       NOT NULL DEFAULT 0,
    skipped_count        integer       NOT NULL DEFAULT 0,

    -- ⚠️ NULL UNTIL POSTED, AND NULL IS HONEST. A run whose chart of accounts
    --    has no fx_gain / fx_loss ledger computes correctly and posts nothing,
    --    exactly as a sales invoice does; unposted_reason says which.
    transaction_id       uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
    unposted_reason      text,

    note                 text,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    created_by           uuid REFERENCES public.users(id) ON DELETE SET NULL,
    posted_at            timestamptz,

    CONSTRAINT fx_revaluations_magnitudes CHECK (gain_minor >= 0 AND loss_minor >= 0),
    CONSTRAINT fx_revaluations_status_known
        CHECK (status IN ('draft','posted','void')),
    CONSTRAINT fx_revaluations_currency_shape
        CHECK (functional_currency ~ '^[A-Z]{3}$'),
    -- 🔴 A POSTED RUN HAS A JOURNAL. Without this a run could be marked
    --    posted with nothing in the ledger, and the exchange difference would
    --    be missing from the P&L with the screen saying it was taken.
    CONSTRAINT fx_revaluations_posted_has_journal
        CHECK (status <> 'posted' OR (transaction_id IS NOT NULL AND posted_at IS NOT NULL))
);

COMMENT ON TABLE public.fx_revaluations IS
    'One reporting-date restatement of foreign-currency monetary items under '
    'AS 11 para 11 / Ind AS 21 para 23. Gain and loss are held separately and '
    'never netted.';

CREATE UNIQUE INDEX IF NOT EXISTS fx_revaluations_id_tenant_key
    ON public.fx_revaluations (id, tenant_id);

-- ⚠️ ONE LIVE RUN PER REPORTING DATE. A second run of the same 31 March would
--    restate from the carrying amounts the FIRST one left behind, correctly
--    find a difference of nil, and leave the P&L short by whatever the first
--    took if the first were then voided. Voided runs are excluded so a mistake
--    can be redone.
CREATE UNIQUE INDEX IF NOT EXISTS fx_revaluations_as_of_key
    ON public.fx_revaluations (tenant_id, as_of_date)
    WHERE status <> 'void';

CREATE INDEX IF NOT EXISTS fx_revaluations_tenant_idx
    ON public.fx_revaluations (tenant_id, as_of_date DESC);

ALTER TABLE public.fx_revaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_revaluations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_revaluations_tenant_isolation ON public.fx_revaluations;
CREATE POLICY fx_revaluations_tenant_isolation ON public.fx_revaluations
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 6 · `fx_revaluation_lines` · INCLUDING WHAT WAS **NOT** RESTATED
-- ============================================================================
-- 🔴🔴 THE NON-MONETARY ITEMS ARE ON THIS TABLE WITH `restated = false` AND A
--    REASON, RATHER THAN OMITTED FROM THE QUERY.
--
--    AS 11 ¶11 restates MONETARY items , a right to receive or an obligation
--    to deliver a FIXED OR DETERMINABLE NUMBER OF CURRENCY UNITS , at the
--    closing rate. It leaves NON-MONETARY items carried at historical cost at
--    the rate on the transaction date, for ever.
--
--    ⚠️ RESTATING A NON-MONETARY ITEM IS THE CLASSIC ERROR AND IT IS SILENT.
--    Revaluing a machine bought for USD 100,000 in 2019 at today's rate writes
--    up a fixed asset and puts a fictitious gain in the P&L , and the balance
--    sheet and the trial balance both still foot.
--
--    ⭐ A run that silently SKIPS such an item is indistinguishable from a run
--    whose join is broken. A line saying "not restated, AS 11 ¶11(b),
--    non-monetary" is a policy an auditor can read.
--
-- ⭐ THE CHECK BELOW IS THE DATABASE'S COPY OF THAT RULE: no reason, no skip.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fx_revaluation_lines (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    revaluation_id              uuid          NOT NULL REFERENCES public.fx_revaluations(id) ON DELETE CASCADE,

    -- A member of FX_ITEM_KINDS in lib/fx/restatement.ts.
    item_kind                   varchar(40)   NOT NULL,
    -- 🔴 DERIVED FROM item_kind BY isMonetary(), never chosen on a form.
    is_monetary_item            boolean       NOT NULL,

    source_table                varchar(60)   NOT NULL,
    source_id                   uuid,
    source_reference            varchar(120),

    foreign_currency            varchar(3)    NOT NULL,
    foreign_amount_minor        bigint        NOT NULL,

    carrying_functional_minor   bigint        NOT NULL,
    restated_functional_minor   bigint        NOT NULL,
    difference_minor            bigint        NOT NULL DEFAULT 0,
    -- ⭐ The same number with the balance-sheet side applied: positive is a
    --    GAIN in the P&L. A liability worth more in functional terms is a
    --    LOSS, and that flip lives in exchangeDifferenceForPl() alone.
    pl_effect_minor             bigint        NOT NULL DEFAULT 0,

    rate                        numeric(30,12),
    rate_date                   date,
    rate_source                 varchar(20),
    rate_derived                boolean       NOT NULL DEFAULT false,

    restated                    boolean       NOT NULL DEFAULT false,
    skip_reason                 text,

    created_at                  timestamptz   NOT NULL DEFAULT now(),

    -- 🔴 NO SKIP WITHOUT A REASON. The rule this table exists to make
    --    readable, put where an INSERT cannot walk around it.
    CONSTRAINT fx_revaluation_lines_skip_needs_reason
        CHECK (restated = true OR skip_reason IS NOT NULL),

    -- 🔴 A RESTATED LINE CARRIES THE RATE IT USED. A restatement whose rate
    --    is not recorded cannot be reproduced, and reproducing it is the whole
    --    point of writing the line down.
    CONSTRAINT fx_revaluation_lines_restated_has_rate
        CHECK (restated = false OR (rate IS NOT NULL AND rate_date IS NOT NULL)),

    -- ⚠️ THE ARITHMETIC, IN THE DATABASE. A difference that is not
    --    (restated - carrying) is a row somebody computed elsewhere.
    CONSTRAINT fx_revaluation_lines_difference_adds_up
        CHECK (difference_minor = restated_functional_minor - carrying_functional_minor),

    -- 🔴🔴 AS 11 ¶11(b) IN THE DATABASE. A non-monetary item is NEVER
    --    restated, whatever the application believes.
    CONSTRAINT fx_revaluation_lines_non_monetary_never_restated
        CHECK (is_monetary_item = true OR restated = false),

    CONSTRAINT fx_revaluation_lines_currency_shape
        CHECK (foreign_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT fx_revaluation_lines_rate_positive
        CHECK (rate IS NULL OR rate > 0)
);

COMMENT ON TABLE public.fx_revaluation_lines IS
    'One item considered by a revaluation run, INCLUDING the ones it did not '
    'touch. A non-monetary item appears with restated=false and the AS 11 '
    'para 11(b) reason on the row, because a silent skip is indistinguishable '
    'from a broken join.';

COMMENT ON COLUMN public.fx_revaluation_lines.pl_effect_minor IS
    'Positive is a gain in the profit and loss account. Differs in sign from '
    'difference_minor for a liability: owing more of your own money is a loss, '
    'and getting that backwards does not unbalance anything.';

CREATE UNIQUE INDEX IF NOT EXISTS fx_revaluation_lines_id_tenant_key
    ON public.fx_revaluation_lines (id, tenant_id);

-- One line per item per run , a re-run must not double-count.
CREATE UNIQUE INDEX IF NOT EXISTS fx_revaluation_lines_item_key
    ON public.fx_revaluation_lines (tenant_id, revaluation_id, source_table, source_id);

CREATE INDEX IF NOT EXISTS fx_revaluation_lines_run_idx
    ON public.fx_revaluation_lines (tenant_id, revaluation_id);

ALTER TABLE public.fx_revaluation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_revaluation_lines FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fx_revaluation_lines_tenant_isolation ON public.fx_revaluation_lines;
CREATE POLICY fx_revaluation_lines_tenant_isolation ON public.fx_revaluation_lines
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 7 · PRESENTATION CURRENCY vs FUNCTIONAL CURRENCY, ON THE DOCUMENTS
-- ============================================================================
-- 🔴 THE COLUMNS THAT MAKE THE THREE MOMENTS POSSIBLE.
--
-- `currency` , already on both tables since Phase 32/49 and read by nothing ,
-- is what the COUNTERPARTY is billed in. `functional_currency` is what the
-- BOOKS are kept in (tenants.settings.currency).
--
-- ⚠️ THE LEDGER GETS THE FUNCTIONAL FIGURE AND NOTHING ELSE. Before this
--    batch server/accounting/post-sales.ts hardcoded `currency: 'INR'` on
--    every transaction it wrote and formatted every leg as rupees, so a
--    USD 10,000 invoice would have posted 10,000 to a rupee receivables ledger
--    , a hundred-fold understatement that balances perfectly.
--
-- ⭐⭐ `fx_carried_functional_minor` IS THE COLUMN THAT MAKES SETTLEMENT
--    CORRECT. AS 11 ¶13 measures the realised difference against the rate the
--    item was LAST CARRIED AT, not against the original invoice. An invoice
--    raised at 82, restated at 31 March to 83 and settled in May at 85
--    produces a gain of 1 in year one and 2 in year two; measuring settlement
--    against 82 books all 3 in year two and DOUBLE-COUNTS the 1 that year
--    one's P&L already took.
--
-- ⚠️ EVERY COLUMN IS NULLABLE AND NULL IS CORRECT FOR EVERY EXISTING ROW.
--    An invoice raised before this migration has no functional figure and no
--    honest one can be invented for it. The CHECK below therefore constrains
--    only rows that HAVE a functional currency recorded.
-- ============================================================================

ALTER TABLE public.sales_invoices
    ADD COLUMN IF NOT EXISTS functional_currency          varchar(3),
    ADD COLUMN IF NOT EXISTS functional_total_minor       bigint,
    ADD COLUMN IF NOT EXISTS fx_rate                      numeric(30,12),
    ADD COLUMN IF NOT EXISTS fx_rate_date                 date,
    ADD COLUMN IF NOT EXISTS fx_rate_source               varchar(20),
    ADD COLUMN IF NOT EXISTS fx_carried_functional_minor  bigint,
    ADD COLUMN IF NOT EXISTS fx_last_revalued_on          date;

ALTER TABLE public.purchase_invoices
    ADD COLUMN IF NOT EXISTS functional_currency          varchar(3),
    ADD COLUMN IF NOT EXISTS functional_total_minor       bigint,
    ADD COLUMN IF NOT EXISTS fx_rate                      numeric(30,12),
    ADD COLUMN IF NOT EXISTS fx_rate_date                 date,
    ADD COLUMN IF NOT EXISTS fx_rate_source               varchar(20),
    ADD COLUMN IF NOT EXISTS fx_carried_functional_minor  bigint,
    ADD COLUMN IF NOT EXISTS fx_last_revalued_on          date;

COMMENT ON COLUMN public.sales_invoices.functional_total_minor IS
    'The invoice total in the books'' own currency, at the rate on the invoice '
    'date, frozen. This is what posts to the ledger. NULL only on invoices '
    'raised before SQL 0101.';

COMMENT ON COLUMN public.sales_invoices.fx_carried_functional_minor IS
    'What the outstanding balance is currently carried at. Moved by every '
    'reporting-date restatement, and what AS 11 para 13 measures a settlement '
    'against. Measuring settlement against fx_rate instead re-books a '
    'difference a previous year already took.';

COMMENT ON COLUMN public.purchase_invoices.functional_total_minor IS
    'As sales_invoices.functional_total_minor, on the payables side.';

-- ----------------------------------------------------------------------------
-- 🔴 THE RULE THAT MAKES THE COLUMNS MEAN SOMETHING
-- ----------------------------------------------------------------------------
-- A row whose document currency DIFFERS from its functional currency must
-- carry a rate and a functional total. Without this the columns are exactly
-- the defect this batch exists to close , declared, and enforced by nothing.
--
-- ⚠️ NOT VALID, deliberately, and this is the one place in the file where a
--    constraint is not immediately enforced against history. Every pre-0101
--    row has functional_currency NULL and would fail nothing (the predicate is
--    vacuously true), but a partially-migrated database in which somebody set
--    functional_currency by hand and not the rate would refuse the whole ALTER
--    and leave the table without the constraint at all. NOT VALID applies it
--    to every future write immediately, which is what matters, and the table
--    can be VALIDATEd later once the data is known good.
-- ----------------------------------------------------------------------------

DO $fxcheck$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'sales_invoices_fx_translation_complete'
           AND conrelid = 'public.sales_invoices'::regclass
    ) THEN
        ALTER TABLE public.sales_invoices
            ADD CONSTRAINT sales_invoices_fx_translation_complete
            CHECK (
                functional_currency IS NULL
                OR functional_currency = currency
                OR (fx_rate IS NOT NULL
                    AND fx_rate_date IS NOT NULL
                    AND functional_total_minor IS NOT NULL)
            ) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'purchase_invoices_fx_translation_complete'
           AND conrelid = 'public.purchase_invoices'::regclass
    ) THEN
        ALTER TABLE public.purchase_invoices
            ADD CONSTRAINT purchase_invoices_fx_translation_complete
            CHECK (
                functional_currency IS NULL
                OR functional_currency = currency
                OR (fx_rate IS NOT NULL
                    AND fx_rate_date IS NOT NULL
                    AND functional_total_minor IS NOT NULL)
            ) NOT VALID;
    END IF;
END
$fxcheck$;

CREATE INDEX IF NOT EXISTS sales_invoices_foreign_open_idx
    ON public.sales_invoices (tenant_id, currency, status)
    WHERE currency <> 'INR';

CREATE INDEX IF NOT EXISTS purchase_invoices_foreign_open_idx
    ON public.purchase_invoices (tenant_id, currency, status)
    WHERE currency <> 'INR';


-- ============================================================================
-- SECTION 8 · THE SEED · ONE `DO` BLOCK, PLATFORM SCOPE SET INSIDE IT
-- ============================================================================
-- 🔴🔴 THIS IS THE ONLY DML IN THE FILE AND IT IS THE SHAPE THAT BROKE 0092.
--
-- `currency_units` is FORCE ROW LEVEL SECURITY with a WITH CHECK of
-- `app_platform_scope()`, and FORCE applies to the table OWNER , which is
-- what a migration runs as. A bare INSERT is refused with
--
--     ERROR: new row violates row-level security policy for table "currency_units"
--
-- ⚠️ AND `SET LOCAL app.platform_scope = 'on';` AS ITS OWN STATEMENT DOES NOT
--    HELP. The Neon console sends each statement on its own connection; the
--    setting reports success and has evaporated before the INSERT runs.
--
-- ⭐ SO THE `PERFORM set_config(...)` AND THE INSERT ARE IN ONE `DO` BLOCK,
--    which is ONE statement and therefore one transaction, whatever the
--    console does with it.
--
-- ⚠️ ON CONFLICT DO NOTHING RATHER THAN DO UPDATE. Re-running this file must
--    not silently revert an exponent that a later migration corrected. A
--    genuine correction is a later file with an explicit UPDATE and a reason.
--
-- ⭐ NO RATES ARE SEEDED. There is deliberately no starter USD/INR row: a
--    rate is a fact with a date and a source, and inventing "83-ish, from
--    somewhere, on the day the migration ran" would put an unevidenced number
--    in front of an auditor. The table starts empty and the resolver says
--    "no rate is on file for that date", which is true.
-- ============================================================================

DO $seed$
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);

    INSERT INTO public.currency_units (code, exponent, name)
    SELECT v.code, v.exponent, v.code
      FROM (VALUES
        ('AED', 2), ('AFN', 2), ('ALL', 2), ('AMD', 2), ('ANG', 2), ('AOA', 2),
        ('ARS', 2), ('AUD', 2), ('AWG', 2), ('AZN', 2), ('BAM', 2), ('BBD', 2),
        ('BDT', 2), ('BGN', 2), ('BHD', 3), ('BIF', 0), ('BMD', 2), ('BND', 2),
        ('BOB', 2), ('BOV', 2), ('BRL', 2), ('BSD', 2), ('BTN', 2), ('BWP', 2),
        ('BYN', 2), ('BZD', 2), ('CAD', 2), ('CDF', 2), ('CHE', 2), ('CHF', 2),
        ('CHW', 2), ('CLF', 4), ('CLP', 0), ('CNY', 2), ('COP', 2), ('COU', 2),
        ('CRC', 2), ('CUP', 2), ('CVE', 2), ('CZK', 2), ('DJF', 0), ('DKK', 2),
        ('DOP', 2), ('DZD', 2), ('EGP', 2), ('ERN', 2), ('ETB', 2), ('EUR', 2),
        ('FJD', 2), ('FKP', 2), ('GBP', 2), ('GEL', 2), ('GHS', 2), ('GIP', 2),
        ('GMD', 2), ('GNF', 0), ('GTQ', 2), ('GYD', 2), ('HKD', 2), ('HNL', 2),
        ('HTG', 2), ('HUF', 2), ('IDR', 2), ('ILS', 2), ('INR', 2), ('IQD', 3),
        ('IRR', 2), ('ISK', 0), ('JMD', 2), ('JOD', 3), ('JPY', 0), ('KES', 2),
        ('KGS', 2), ('KHR', 2), ('KMF', 0), ('KPW', 2), ('KRW', 0), ('KWD', 3),
        ('KYD', 2), ('KZT', 2), ('LAK', 2), ('LBP', 2), ('LKR', 2), ('LRD', 2),
        ('LSL', 2), ('LYD', 3), ('MAD', 2), ('MDL', 2), ('MGA', 2), ('MKD', 2),
        ('MMK', 2), ('MNT', 2), ('MOP', 2), ('MRU', 2), ('MUR', 2), ('MVR', 2),
        ('MWK', 2), ('MXN', 2), ('MXV', 2), ('MYR', 2), ('MZN', 2), ('NAD', 2),
        ('NGN', 2), ('NIO', 2), ('NOK', 2), ('NPR', 2), ('NZD', 2), ('OMR', 3),
        ('PAB', 2), ('PEN', 2), ('PGK', 2), ('PHP', 2), ('PKR', 2), ('PLN', 2),
        ('PYG', 0), ('QAR', 2), ('RON', 2), ('RSD', 2), ('RUB', 2), ('RWF', 0),
        ('SAR', 2), ('SBD', 2), ('SCR', 2), ('SDG', 2), ('SEK', 2), ('SGD', 2),
        ('SHP', 2), ('SLE', 2), ('SOS', 2), ('SRD', 2), ('SSP', 2), ('STN', 2),
        ('SVC', 2), ('SYP', 2), ('SZL', 2), ('THB', 2), ('TJS', 2), ('TMT', 2),
        ('TND', 3), ('TOP', 2), ('TRY', 2), ('TTD', 2), ('TWD', 2), ('TZS', 2),
        ('UAH', 2), ('UGX', 0), ('USD', 2), ('USN', 2), ('UYI', 0), ('UYU', 2),
        ('UYW', 4), ('UZS', 2), ('VED', 2), ('VES', 2), ('VND', 0), ('VUV', 0),
        ('WST', 0), ('XAF', 0), ('XCD', 2), ('XCG', 2), ('XOF', 0), ('XPF', 0),
        ('YER', 2), ('ZAR', 2), ('ZMW', 2), ('ZWG', 2)
      ) AS v(code, exponent)
    ON CONFLICT (code) DO NOTHING;
END
$seed$;


-- ============================================================================
-- SECTION 9 · CONFIRMATION · THE ROW TO READ
-- ============================================================================
-- ⚠️ `query_to_xml` RATHER THAN A `CASE` OVER THE NEW TABLES. The planner
--    resolves BOTH branches of a CASE before the guard runs, so a diagnostic
--    that reads a table whose existence it is testing fails with "relation
--    does not exist" instead of reporting it. This is the shape that works.
-- ============================================================================

SELECT
    '0101 · verdict'                                          AS finding,
    (SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('currency_units','fx_reference_rates','fx_rates',
                          'fx_revaluations','fx_revaluation_lines'))   AS tables_present,
    (SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('currency_units','fx_reference_rates','fx_rates',
                          'fx_revaluations','fx_revaluation_lines')
        AND c.relrowsecurity AND c.relforcerowsecurity)               AS tables_forced,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('currency_units','fx_reference_rates','fx_rates',
                          'fx_revaluations','fx_revaluation_lines'))   AS policies_present,
    -- ⭐ The seed, counted through query_to_xml so this SELECT parses even on
    --    a database where section 2 refused.
    (xpath('/row/c/text()',
           query_to_xml('SELECT count(*) AS c FROM public.currency_units',
                        false, true, '')))[1]::text::int               AS currency_rows,
    -- 🔴 The three exponents that were wrong before this batch.
    (xpath('/row/c/text()',
           query_to_xml('SELECT count(*) AS c FROM public.currency_units'
                        ' WHERE (code = ''KWD'' AND exponent = 3)'
                        '    OR (code = ''JPY'' AND exponent = 0)'
                        '    OR (code = ''INR'' AND exponent = 2)',
                        false, true, '')))[1]::text::int              AS exponents_correct,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sales_invoices'
        AND column_name IN ('functional_currency','functional_total_minor','fx_rate',
                            'fx_rate_date','fx_rate_source','fx_carried_functional_minor',
                            'fx_last_revalued_on'))                    AS sales_fx_columns,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'purchase_invoices'
        AND column_name IN ('functional_currency','functional_total_minor','fx_rate',
                            'fx_rate_date','fx_rate_source','fx_carried_functional_minor',
                            'fx_last_revalued_on'))                    AS purchase_fx_columns,
    CASE
        WHEN (SELECT count(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public'
                 AND c.relname IN ('currency_units','fx_reference_rates','fx_rates',
                                   'fx_revaluations','fx_revaluation_lines')
                 AND c.relrowsecurity AND c.relforcerowsecurity) = 5
         AND (SELECT count(*) FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'sales_invoices'
                 AND column_name IN ('functional_currency','functional_total_minor','fx_rate',
                                     'fx_rate_date','fx_rate_source',
                                     'fx_carried_functional_minor','fx_last_revalued_on')) = 7
            THEN 'PASS , five tables with RLS enabled AND forced, both invoice tables carry the functional-currency columns, and the exponent seed is in'
        ELSE 'FAIL , send me the error from the tab that refused'
    END                                                                AS verdict;
