-- ############################################################################
-- 0100 , THE FIXED ASSET REGISTER, AND DEPRECIATION UNDER TWO STATUTES
-- ############################################################################
--
-- PURPOSE
-- -------
-- Before this file, `grep -ril depreciation` across Ordence returned four
-- files and every one of them was a TALLY IMPORT validator. The product could
-- READ a depreciation figure somebody else had computed and could compute
-- none of its own. An Indian company keeping its books here could not produce
-- a depreciation schedule, could not post the charge, and therefore could not
-- sign its accounts , the one entry every business with a fixed asset makes
-- was simply absent from the profit and loss account.
--
-- ############################################################################
-- 🔴 WHY THIS IS NOT A COLUMN ON `assets`
-- ############################################################################
-- `assets` (RUN-THESE-IN-ORDER-13, db/schema/assets.ts) already exists and it
-- was seriously considered. It is the wrong home:
--
--   ① IT IS A CRM / REAL-ESTATE CATALOGUE. Its enum covers property, unit,
--      plot, case, matter, subscription_plan; it carries owner_company_id,
--      linked_deal_id, latitude and longitude. A flat in a project being SOLD
--      is stock in trade. A lathe the company USES is a fixed asset. They sit
--      on opposite sides of the balance sheet and one row cannot be both.
--
--   ② ITS MONEY COLUMN IS THE WRONG TYPE AND THE WRONG THING.
--      `value_amount numeric(18,2)` is rupees, where this product's rule is
--      bigint paise , and "value" is a valuation, where depreciation is
--      computed on COST. Cost and value diverge on day one.
--
--   ③ SCHEDULE II COMPONENT ACCOUNTING NEEDS A CARVE-OUT INVARIANT.
--      Note 4 makes a significant part with its own useful life separately
--      depreciable, and only works if the parent's cost EXCLUDES it.
--      `asset_relationships` can express the edge; it cannot hold the money
--      invariant. registerFixedAsset() carves the cost out of the parent in
--      the same transaction and refuses once the parent has been depreciated.
--
-- ⭐ SO: A SEPARATE REGISTER WITH A NULLABLE `crm_asset_id` LINK, and neither
--    table has to pretend to be the other.
--
-- ############################################################################
-- 🔴🔴 TWO STATUTES, TWO COMPUTATIONS, ONE SET OF ASSETS
-- ############################################################################
-- COMPANIES ACT 2013, SCHEDULE II , the BOOK charge. Per ASSET, USEFUL-LIFE
-- based, pro-rated by DAYS from the date of put to use, leaving a residual of
-- not more than 5% of cost (Part A note 5), on SLM or WDV, with significant
-- components depreciated separately (note 4) and +50% / +100% for double and
-- triple shift working (note 6). THIS is what hits the ledger.
--
-- INCOME-TAX ACT 1961, SECTION 32 , the TAX allowance. Per BLOCK OF ASSETS
-- (s.2(11)): the written-down value belongs to the POOL, not to any asset in
-- it. RATE based. Half the rate where an asset was acquired and put to use for
-- under 180 days in that previous year (second proviso to s.32(1)). Sale
-- proceeds ("moneys payable", s.43(6)(c)(i)(B)) come off the block and produce
-- NO gain or loss at asset level , only a s.50(1) gain if they exhaust the
-- block, or a s.50(2) loss if the block empties. THIS NEVER TOUCHES THE
-- LEDGER, and section 4 below puts a CHECK constraint under that sentence.
--
-- ⭐ The two diverge permanently and the divergence is the input to deferred
--    tax under AS 22 / Ind AS 12. A product that computes one of them cannot
--    produce the other and cannot produce deferred tax at all.
--
-- ############################################################################
-- 🔴 NO COUNTER COLUMNS. ACCUMULATED DEPRECIATION IS FOLDED FROM THE LINES.
-- ############################################################################
-- `fixed_assets` has NO accumulated_depreciation_minor and must never have
-- one , the same argument as employee_advances having no outstanding_minor in
-- 0096. A run cancelled and recomputed decrements twice; a run posted twice
-- leaves it high; nothing complains, because a counter has no way to know it
-- is wrong. `depreciation_lines` belonging to POSTED runs IS the balance.
-- Section 7's verdict asserts the column's absence.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
-- Same reason as 0092 through 0099. Migrations here are PASTED INTO THE NEON
-- BROWSER CONSOLE, which sends each statement on its own connection. `BEGIN`
-- buys no atomicity across that boundary , it only makes a half-applied file
-- look like a clean one, which is exactly how 0091 applied half way while
-- reporting success. `SET LOCAL app.platform_scope` reports "executed
-- successfully" and has evaporated before the next statement runs.
--
-- ⭐ EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT , CREATE TABLE IF NOT
--    EXISTS, CREATE INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP POLICY
--    IF EXISTS before CREATE POLICY, DROP TRIGGER IF EXISTS before CREATE
--    TRIGGER , and the file is safe to re-run from the top after a failure at
--    any point.
--
-- ⭐ AND THERE IS NO DML AT ALL, WHICH IS THE STRONGEST FORM OF THIS. Nothing
--    below writes a row, so nothing below can be refused by a FORCE ROW LEVEL
--    SECURITY policy , the failure mode 0091 and 0092 both hit. No backfill is
--    possible either: nobody's existing `assets` rows carry a cost, a useful
--    life or a date of put to use, and inventing them would put a fabricated
--    depreciation charge into somebody's accounts.
--
-- RUN ORDER: after 0099. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If a later section refuses, this row is still on your screen and still says
-- what was there before you started.
-- ============================================================================

SELECT
    '0100 · diagnostic'                                        AS finding,
    current_user                                               AS running_as,
    to_regclass('public.tenants')            IS NOT NULL       AS tenants_present,
    to_regclass('public.assets')             IS NOT NULL       AS crm_assets_present,
    to_regclass('public.transactions')       IS NOT NULL       AS ledger_present,
    to_regclass('public.financial_periods')  IS NOT NULL       AS periods_present,
    to_regclass('public.fixed_assets')       IS NOT NULL       AS register_already_present,
    to_regclass('public.depreciation_runs')  IS NOT NULL       AS runs_already_present;


-- ============================================================================
-- SECTION 2 · `it_asset_blocks` · THE INCOME-TAX POOL, s.2(11)
-- ============================================================================
-- ⭐ Every asset of the same class attracting the same prescribed rate is ONE
--    block, and the written-down value belongs to the block.
--
-- ⚠️ `rate_bp` IS TYPED IN, NOT DERIVED, AND THAT IS HONEST. Appendix I to the
--    Income-tax Rules, 1962 prescribes it, but which entry an asset falls
--    under is a judgement about the asset , a "computer" at 40% and general
--    plant at 15% look identical on a purchase invoice. A guessed rate is a
--    number in a return that nobody chose.
--
-- ⚠️ `opening_wdv_minor` IS AN OPENING BALANCE, DATED , the figure from the
--    tenant's last filed computation. Every later year is COMPUTED from it by
--    incomeTaxBlockYear(), so there is no stored per-year balance to drift.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.it_asset_blocks (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    name                varchar(120) NOT NULL,
    -- 'building' | 'furniture_fittings' | 'plant_machinery' | 'intangible'.
    block_class         varchar(30)  NOT NULL,

    -- Whole basis points. 15% is 1500. Read at the computation, never a label.
    rate_bp             integer      NOT NULL,

    opening_wdv_minor   bigint       NOT NULL DEFAULT 0,
    opening_wdv_as_at   date         NOT NULL,

    notes               text,

    created_at          timestamptz  NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT it_asset_blocks_rate_is_a_percentage
        CHECK (rate_bp >= 0 AND rate_bp <= 10000),
    -- 🔴 A BLOCK NEVER CARRIES A NEGATIVE WRITTEN-DOWN VALUE. An excess of
    --    sale proceeds is a short-term capital gain under s.50(1), not a
    --    negative block that depreciates the gain away next year.
    CONSTRAINT it_asset_blocks_opening_not_negative
        CHECK (opening_wdv_minor >= 0)
);

COMMENT ON TABLE public.it_asset_blocks IS
    'Blocks of assets under s.2(11) of the Income-tax Act, 1961. The written-'
    'down value belongs to the POOL, not to any asset in it, which is why a '
    'sale produces no gain or loss at asset level.';

COMMENT ON COLUMN public.it_asset_blocks.rate_bp IS
    'Whole basis points from Appendix I to the Income-tax Rules, 1962. Read by '
    'incomeTaxBlockYear() at the point the allowance is computed.';

CREATE UNIQUE INDEX IF NOT EXISTS it_asset_blocks_id_tenant_key
    ON public.it_asset_blocks (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS it_asset_blocks_name_key
    ON public.it_asset_blocks (tenant_id, name);
CREATE INDEX IF NOT EXISTS it_asset_blocks_tenant_idx
    ON public.it_asset_blocks (tenant_id);


-- ============================================================================
-- SECTION 3 · `fixed_assets` · THE REGISTER
-- ============================================================================
-- 🔴 THE CONFIGURATION COLUMNS BELOW ARE ALL READ AT A COMPUTATION, and the
--    constraints exist so an INSERT cannot produce a row the engine would have
--    to guess about:
--
--      asset_class         → the Schedule II Part C life AND whether extra
--                            shift depreciation may apply at all (note 6 NESD)
--      useful_life_months  → the SLM denominator and the WDV rate
--      residual_bp         → where the schedule stops (Part A note 5, 5% cap)
--      depreciation_method → slm or wdv, refused by name if it is neither
--      shift_usage         → note 6, +50% double, +100% triple
--
-- ⚠️ `put_to_use_on` IS NOT `acquired_on`. Depreciation runs from USE under
--    both statutes; a machine bought in March and commissioned in June is a
--    June asset for Schedule II and a March ADDITION for the s.32 block with
--    the 180-day test run on the June date. Both dates are stored because
--    neither can be derived from the other.
--
-- ⚠️ MONEY IS bigint PAISE. Never a float, never rupees.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fixed_assets (
    id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                     uuid         NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    asset_no                      varchar(40)  NOT NULL,
    description                   text         NOT NULL,

    -- A `ScheduleIIClass` from lib/fixed-assets/depreciation.ts.
    asset_class                   varchar(40)  NOT NULL,

    -- ⭐ Schedule II Part A note 4 , a significant component with its own
    --    useful life is separately depreciable. The parent's cost is carved
    --    out when the component is registered.
    parent_fixed_asset_id         uuid,

    cost_minor                    bigint       NOT NULL,

    residual_bp                   integer      NOT NULL DEFAULT 500,
    residual_justification        text,

    useful_life_months            integer      NOT NULL,
    life_justification            text,

    -- 'slm' | 'wdv'.
    depreciation_method           varchar(3)   NOT NULL,
    -- 'single' | 'double' | 'triple'.
    shift_usage                   varchar(10)  NOT NULL DEFAULT 'single',

    acquired_on                   date         NOT NULL,
    put_to_use_on                 date         NOT NULL,

    it_block_id                   uuid REFERENCES public.it_asset_blocks(id) ON DELETE RESTRICT,

    -- 'in_use' | 'disposed' | 'written_off'.
    status                        varchar(20)  NOT NULL DEFAULT 'in_use',

    disposed_on                   date,
    -- ⚠️ ONE FIGURE, TWO STATUTES. Sale consideration for the Companies Act
    --    profit or loss; "moneys payable" under s.43(6)(c)(i)(B) for the block.
    disposal_consideration_minor  bigint,
    disposal_transaction_id       uuid REFERENCES public.transactions(id) ON DELETE SET NULL,

    -- Optional link to the CRM catalogue row for the same physical thing.
    crm_asset_id                  uuid REFERENCES public.assets(id) ON DELETE SET NULL,

    -- ⚠️ Descriptive only: where somebody goes to physically verify it.
    --
    -- 🔴 THERE IS DELIBERATELY NO cost_centre COLUMN. One was drafted and
    --    removed. lib/accounting/cost-centre.ts exists, the depreciation
    --    journal is ONE entry for the whole run, and a cost centre stamped on
    --    an asset that no posting reads would claim the charge is allocated
    --    when it is not , the declared-and-enforced-by-nothing defect this
    --    batch exists to avoid. It belongs with the batch that splits the
    --    journal by cost centre, and not a release earlier.
    location                      varchar(160),

    created_at                    timestamptz  NOT NULL DEFAULT now(),
    created_by                    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at                    timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT fixed_assets_cost_positive
        CHECK (cost_minor > 0),

    CONSTRAINT fixed_assets_method_known
        CHECK (depreciation_method IN ('slm', 'wdv')),

    CONSTRAINT fixed_assets_shift_known
        CHECK (shift_usage IN ('single', 'double', 'triple')),

    CONSTRAINT fixed_assets_status_known
        CHECK (status IN ('in_use', 'disposed', 'written_off')),

    CONSTRAINT fixed_assets_life_positive
        CHECK (useful_life_months >= 1),

    CONSTRAINT fixed_assets_residual_is_a_proportion
        CHECK (residual_bp >= 0 AND residual_bp <= 10000),

    -- 🔴🔴 SCHEDULE II PART A NOTE 5 IN THE DATABASE. "The residual value of
    --      an asset shall not be more than five per cent of the original cost"
    --      , unless the company justifies the difference by technical advice
    --      and discloses it. So it is CONDITIONAL, not forbidden, and the
    --      condition is a written justification. The engine refuses to
    --      depreciate without one; this constraint means an INSERT cannot
    --      create the row in the first place.
    CONSTRAINT fixed_assets_residual_above_5pc_needs_justification
        CHECK (residual_bp <= 500 OR residual_justification IS NOT NULL),

    -- ⚠️ USE FOLLOWS ACQUISITION. The reverse is not a small data error: it
    --    would start Schedule II depreciation before the company owned the
    --    asset.
    CONSTRAINT fixed_assets_use_after_acquisition
        CHECK (put_to_use_on >= acquired_on),

    -- ⚠️ A DISPOSAL NEEDS A DATE AND A CONSIDERATION , nil is a consideration
    --    and is written as 0, but NULL means nobody recorded one, and the
    --    block computation would silently treat it as a free gift.
    CONSTRAINT fixed_assets_disposal_is_complete
        CHECK (status <> 'disposed'
               OR (disposed_on IS NOT NULL AND disposal_consideration_minor IS NOT NULL)),

    CONSTRAINT fixed_assets_disposal_after_use
        CHECK (disposed_on IS NULL OR disposed_on >= put_to_use_on),

    CONSTRAINT fixed_assets_consideration_not_negative
        CHECK (disposal_consideration_minor IS NULL OR disposal_consideration_minor >= 0),

    -- ⚠️ AN ASSET IS NOT ITS OWN COMPONENT.
    CONSTRAINT fixed_assets_component_is_not_itself
        CHECK (parent_fixed_asset_id IS NULL OR parent_fixed_asset_id <> id)
);

COMMENT ON TABLE public.fixed_assets IS
    'The fixed asset register: things the company USES. Deliberately separate '
    'from `assets`, which is a CRM / real-estate catalogue and also holds the '
    'flats a developer is SELLING , stock in trade, the other side of the '
    'balance sheet. There is NO accumulated depreciation column: the balance '
    'is folded from depreciation_lines of posted runs, because a counter '
    'drifts and it drifts into the profit and loss account.';

COMMENT ON COLUMN public.fixed_assets.put_to_use_on IS
    'Depreciation runs from USE, not from purchase , Schedule II for the books '
    'and s.32 for the tax computation. Read at every charge.';

COMMENT ON COLUMN public.fixed_assets.shift_usage IS
    'Schedule II Part A note 6: double shift working increases the charge by '
    '50%, triple by 100%. Read by shiftFactorBp(), which returns 10000 '
    'regardless for a class marked NESD , so a building cannot be made to '
    'depreciate faster by ticking a box.';

COMMENT ON COLUMN public.fixed_assets.useful_life_months IS
    'Read by assertAssetIsDepreciable(), which REFUSES to compute when it '
    'differs from the Schedule II Part C life for the class and no '
    'life_justification is recorded. Part C permits a different life only '
    'where it is justified by technical advice and disclosed.';

CREATE UNIQUE INDEX IF NOT EXISTS fixed_assets_id_tenant_key
    ON public.fixed_assets (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS fixed_assets_no_key
    ON public.fixed_assets (tenant_id, asset_no);
CREATE INDEX IF NOT EXISTS fixed_assets_tenant_idx
    ON public.fixed_assets (tenant_id);
CREATE INDEX IF NOT EXISTS fixed_assets_status_idx
    ON public.fixed_assets (tenant_id, status);
CREATE INDEX IF NOT EXISTS fixed_assets_block_idx
    ON public.fixed_assets (tenant_id, it_block_id);
CREATE INDEX IF NOT EXISTS fixed_assets_parent_idx
    ON public.fixed_assets (tenant_id, parent_fixed_asset_id);

-- ----------------------------------------------------------------------------
-- ⚠️ THE SELF-REFERENCE IS ADDED SEPARATELY AND CONDITIONALLY, because a
--    composite foreign key to (id, tenant_id) is what stops a component being
--    attached to ANOTHER TENANT'S asset. A plain FK proves the row exists, not
--    that it belongs to you , the same reasoning as the cross-tenant reference
--    triggers from 0001.
-- ----------------------------------------------------------------------------

DO $fk$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fixed_assets_parent_same_tenant_fkey'
           AND conrelid = 'public.fixed_assets'::regclass
    ) THEN
        ALTER TABLE public.fixed_assets
            ADD CONSTRAINT fixed_assets_parent_same_tenant_fkey
            FOREIGN KEY (parent_fixed_asset_id, tenant_id)
            REFERENCES public.fixed_assets (id, tenant_id)
            ON DELETE RESTRICT;
    END IF;
END
$fk$;


-- ============================================================================
-- SECTION 4 · `depreciation_runs` · ONE RUN PER BASIS PER PERIOD
-- ============================================================================
-- 🔴🔴 THE CONSTRAINT THAT MATTERS MOST IN THIS FILE IS
--      `depreciation_runs_tax_never_posts`.
--
--      Section 32 depreciation is an ALLOWANCE IN A TAX COMPUTATION. It is
--      computed on the same assets, it is usually larger, and it is NOT an
--      accounting entry. Posting it would put the Income-tax Act's figure into
--      a Companies Act balance sheet and overstate accumulated depreciation by
--      the whole timing difference , while balancing perfectly, so nothing
--      would shout. There is no postIncomeTaxDepreciation() anywhere in the
--      codebase; this constraint is what makes that true for the import, the
--      support fix and the API route that have not been written yet.
--
-- ⭐ THE UNIQUE INDEX ON (tenant, basis, period) IS THE OTHER HALF OF "a
--    closed period must not be recomputable". Two people pressing Run at once
--    produce one run, not two charges for the same month.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.depreciation_runs (
    id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                     uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    -- 'companies_act' | 'income_tax'.
    basis                         varchar(20) NOT NULL,

    period_start                  date        NOT NULL,
    period_end                    date        NOT NULL,

    -- 'computed' | 'posted' | 'cancelled'.
    status                        varchar(20) NOT NULL DEFAULT 'computed',

    total_charge_minor            bigint      NOT NULL DEFAULT 0,

    -- s.50(1) and s.50(2). Income-tax runs only, and never posted.
    short_term_capital_gain_minor bigint      NOT NULL DEFAULT 0,
    short_term_capital_loss_minor bigint      NOT NULL DEFAULT 0,

    computed_at                   timestamptz NOT NULL DEFAULT now(),
    computed_by                   uuid REFERENCES public.users(id) ON DELETE SET NULL,
    posted_at                     timestamptz,
    transaction_id                uuid REFERENCES public.transactions(id) ON DELETE SET NULL,

    note                          text,

    CONSTRAINT depreciation_runs_basis_known
        CHECK (basis IN ('companies_act', 'income_tax')),

    CONSTRAINT depreciation_runs_status_known
        CHECK (status IN ('computed', 'posted', 'cancelled')),

    CONSTRAINT depreciation_runs_period_forwards
        CHECK (period_end >= period_start),

    CONSTRAINT depreciation_runs_charge_not_negative
        CHECK (total_charge_minor >= 0),

    -- 🔴🔴 THE INCOME-TAX ALLOWANCE NEVER REACHES THE LEDGER.
    CONSTRAINT depreciation_runs_tax_never_posts
        CHECK (basis <> 'income_tax'
               OR (transaction_id IS NULL AND posted_at IS NULL AND status <> 'posted')),

    -- ⚠️ A POSTED RUN NAMES ITS JOURNAL. A `posted` status with no transaction
    --    is a run that claims to be in the books and is not , which is the
    --    exact shape of defect the posting gates in this repo exist for.
    CONSTRAINT depreciation_runs_posted_names_its_journal
        CHECK (status <> 'posted' OR (transaction_id IS NOT NULL AND posted_at IS NOT NULL))
);

COMMENT ON TABLE public.depreciation_runs IS
    'One depreciation run per basis per period. basis = companies_act is the '
    'Schedule II book charge and it posts; basis = income_tax is the s.32 '
    'allowance for the return and a CHECK constraint refuses to let it post.';

CREATE UNIQUE INDEX IF NOT EXISTS depreciation_runs_id_tenant_key
    ON public.depreciation_runs (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS depreciation_runs_period_key
    ON public.depreciation_runs (tenant_id, basis, period_start, period_end);
CREATE INDEX IF NOT EXISTS depreciation_runs_tenant_idx
    ON public.depreciation_runs (tenant_id);
CREATE INDEX IF NOT EXISTS depreciation_runs_status_idx
    ON public.depreciation_runs (tenant_id, status, period_end);


-- ============================================================================
-- SECTION 5 · `depreciation_lines` · THE WORKING, NOT JUST THE ANSWER
-- ============================================================================
-- ⚠️ days_in_use, rate_bp, shift_factor_bp AND half_rate ARE COLUMNS BECAUSE
--    AN AUDITOR ASKING "why is this figure ₹1,23,456" IS ENTITLED TO THE
--    ARITHMETIC, and re-deriving it from today's configuration proves nothing
--    about what was charged two years ago.
--
-- 🔴 ONE OF fixed_asset_id / it_block_id, NEVER BOTH AND NEVER NEITHER. A book
--    line belongs to an ASSET; a tax line belongs to a BLOCK. A row with both
--    would be claiming an asset-level tax WDV, which does not exist.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.depreciation_lines (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    run_id           uuid        NOT NULL REFERENCES public.depreciation_runs(id) ON DELETE CASCADE,

    fixed_asset_id   uuid REFERENCES public.fixed_assets(id) ON DELETE RESTRICT,
    it_block_id      uuid REFERENCES public.it_asset_blocks(id) ON DELETE RESTRICT,

    opening_minor    bigint      NOT NULL DEFAULT 0,
    charge_minor     bigint      NOT NULL DEFAULT 0,
    closing_minor    bigint      NOT NULL DEFAULT 0,

    -- 'slm' | 'wdv' on a book line; 'block_wdv' on a tax line.
    method           varchar(12) NOT NULL,
    rate_bp          integer,
    shift_factor_bp  integer     NOT NULL DEFAULT 10000,
    days_in_use      integer     NOT NULL DEFAULT 0,
    half_rate        boolean     NOT NULL DEFAULT false,

    working          jsonb       NOT NULL DEFAULT '{}'::jsonb,

    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT depreciation_lines_asset_xor_block
        CHECK ((fixed_asset_id IS NOT NULL) <> (it_block_id IS NOT NULL)),

    CONSTRAINT depreciation_lines_charge_not_negative
        CHECK (charge_minor >= 0),

    -- ⚠️ Schedule II Part A note 6 allows +50% and +100% and nothing else.
    CONSTRAINT depreciation_lines_shift_factor_known
        CHECK (shift_factor_bp IN (10000, 15000, 20000))
);

COMMENT ON TABLE public.depreciation_lines IS
    'The per-asset (book) or per-block (tax) working behind a run. Lines of '
    'POSTED companies_act runs ARE the accumulated depreciation balance , '
    'there is no counter column anywhere.';

CREATE UNIQUE INDEX IF NOT EXISTS depreciation_lines_id_tenant_key
    ON public.depreciation_lines (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS depreciation_lines_run_asset_key
    ON public.depreciation_lines (run_id, fixed_asset_id)
    WHERE fixed_asset_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS depreciation_lines_run_block_key
    ON public.depreciation_lines (run_id, it_block_id)
    WHERE it_block_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS depreciation_lines_tenant_idx
    ON public.depreciation_lines (tenant_id);
CREATE INDEX IF NOT EXISTS depreciation_lines_run_idx
    ON public.depreciation_lines (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS depreciation_lines_asset_idx
    ON public.depreciation_lines (tenant_id, fixed_asset_id);


-- ----------------------------------------------------------------------------
-- 🔴🔴 A POSTED RUN'S WORKING IS FROZEN, BELOW THE APPLICATION
-- ----------------------------------------------------------------------------
-- The service refuses to recompute a posted run and the ledger refuses a
-- second posting under the same key. This is the third lock and the only one
-- an UPDATE run from a database client cannot walk around: once the charge is
-- in the books, the lines it was computed from cannot be edited or deleted.
--
-- ⚠️ AN UNPOSTED RUN REMAINS FULLY MUTABLE, and that is the useful case ,
--    somebody adds an asset they forgot and runs the month again.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ordence_depreciation_lines_frozen_when_posted()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
    v_run   uuid;
    v_state text;
BEGIN
    v_run := COALESCE(NEW.run_id, OLD.run_id);
    SELECT status INTO v_state FROM public.depreciation_runs WHERE id = v_run;

    IF v_state = 'posted' THEN
        RAISE EXCEPTION
            'depreciation run % is posted; its lines are the working behind a journal entry and cannot be %',
            v_run, lower(TG_OP)
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS depreciation_lines_frozen_update ON public.depreciation_lines;
CREATE TRIGGER depreciation_lines_frozen_update
    BEFORE UPDATE ON public.depreciation_lines
    FOR EACH ROW EXECUTE FUNCTION ordence_depreciation_lines_frozen_when_posted();

DROP TRIGGER IF EXISTS depreciation_lines_frozen_delete ON public.depreciation_lines;
CREATE TRIGGER depreciation_lines_frozen_delete
    BEFORE DELETE ON public.depreciation_lines
    FOR EACH ROW EXECUTE FUNCTION ordence_depreciation_lines_frozen_when_posted();


-- ============================================================================
-- SECTION 6 · ROW LEVEL SECURITY ON ALL FOUR TABLES
-- ============================================================================
-- 🔴 EVERY ONE OF THESE CARRIES tenant_id, SO check-rls-coverage REQUIRES:
--    ENABLE, FORCE, and a policy whose USING names app_current_tenant_id().
--
-- ⚠️ FORCE MATTERS MORE THAN ENABLE. Plain ENABLE does not apply to the table
--    OWNER, and the application connects as the owner. FORCE is what makes the
--    isolation a control rather than a comment.
--
-- ⚠️ AND NONE OF THESE IS PLATFORM-WRITABLE. A fixed asset register is the
--    tenant's own book , nobody, operator included, capitalises an asset or
--    charges depreciation in somebody else's accounts. So the WITH CHECK is
--    the plain tenant predicate and there is no escape hatch.
-- ============================================================================

ALTER TABLE public.it_asset_blocks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.it_asset_blocks      FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS it_asset_blocks_tenant_isolation ON public.it_asset_blocks;
CREATE POLICY it_asset_blocks_tenant_isolation ON public.it_asset_blocks
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.fixed_assets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixed_assets         FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fixed_assets_tenant_isolation ON public.fixed_assets;
CREATE POLICY fixed_assets_tenant_isolation ON public.fixed_assets
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.depreciation_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.depreciation_runs    FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS depreciation_runs_tenant_isolation ON public.depreciation_runs;
CREATE POLICY depreciation_runs_tenant_isolation ON public.depreciation_runs
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.depreciation_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.depreciation_lines   FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS depreciation_lines_tenant_isolation ON public.depreciation_lines;
CREATE POLICY depreciation_lines_tenant_isolation ON public.depreciation_lines
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 7 · CONFIRMATION · THE ROW TO READ
-- ============================================================================
-- ⚠️ EVERY BRANCH BELOW READS A CATALOGUE TABLE THAT CERTAINLY EXISTS
--    (pg_class, pg_policies, pg_constraint, information_schema). Nothing here
--    reads a table whose existence it is testing , the planner resolves both
--    arms of a CASE before the guard runs, which is how a diagnostic ends up
--    failing on the database it was written to diagnose.
-- ============================================================================

SELECT
    '0100 · verdict'                                           AS finding,
    (SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('fixed_assets','it_asset_blocks',
                          'depreciation_runs','depreciation_lines'))   AS tables_present,
    (SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('fixed_assets','it_asset_blocks',
                          'depreciation_runs','depreciation_lines')
        AND c.relrowsecurity AND c.relforcerowsecurity)                AS tables_forced,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('fixed_assets','it_asset_blocks',
                          'depreciation_runs','depreciation_lines'))   AS policies_present,
    (SELECT count(*) FROM pg_trigger
      WHERE tgrelid = to_regclass('public.depreciation_lines')
        AND NOT tgisinternal)                                          AS frozen_line_triggers,
    -- 🔴 THE CONSTRAINT THAT KEEPS TWO STATUTES APART.
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'depreciation_runs_tax_never_posts')      AS tax_never_posts,
    -- 🔴 SCHEDULE II PART A NOTE 5, IN THE DATABASE.
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'fixed_assets_residual_above_5pc_needs_justification')
                                                                       AS residual_cap_enforced,
    -- 🔴 THE COLUMN THAT MUST NOT EXIST. A running accumulated-depreciation
    --    counter drifts, and it drifts straight into the profit and loss
    --    account.
    NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'fixed_assets'
           AND column_name IN ('accumulated_depreciation_minor','wdv_minor','net_block_minor')
    )                                                                  AS no_accumulated_counter,
    CASE
        WHEN (SELECT count(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public'
                 AND c.relname IN ('fixed_assets','it_asset_blocks',
                                   'depreciation_runs','depreciation_lines')
                 AND c.relrowsecurity AND c.relforcerowsecurity) = 4
         AND EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conname = 'depreciation_runs_tax_never_posts')
         AND (SELECT count(*) FROM pg_trigger
               WHERE tgrelid = to_regclass('public.depreciation_lines')
                 AND NOT tgisinternal) >= 2
            THEN 'PASS , four tenant-scoped tables with RLS enabled AND forced, the income-tax basis cannot post, and a posted run''s working is frozen by trigger'
        ELSE 'FAIL , send me the error from the tab that refused'
    END                                                                AS verdict;
