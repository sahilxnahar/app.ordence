-- ############################################################################
-- 0106 , RULE 26 · TDS ON A PAYMENT IN FOREIGN CURRENCY, AT THE RATE THE
--        STATUTE NAMES
-- ############################################################################
--
-- PURPOSE
-- -------
-- Rule 26 of the Income-tax Rules 1962:
--
--     "For the purpose of deduction of tax at source on any income payable in
--      foreign currency, the rate of exchange for the calculation of the value
--      in rupees of such income shall be the TELEGRAPHIC TRANSFER BUYING RATE
--      of such currency as on the date on which the tax is required to be
--      deducted."
--
-- Two earlier batches reported that this is applied nowhere. `server/tds/
-- registry.ts` says so twice in its own comments, and v1.66.0 named the
-- blocker exactly: `fx_rates` carries `source` (WHO published the number) and
-- nothing at all for WHICH SIDE OF THE SPREAD it is.
--
-- 🔴 MID, TT BUYING AND TT SELLING ARE THREE DIFFERENT NUMBERS ON THE SAME
--    DAY. The spread between the buying and selling sides of the dollar is
--    routinely 40 to 80 paise. On a US$100,000 remittance that is ₹40,000 to
--    ₹80,000 of chargeable base, and the tax on the difference is OURS:
--    s.201(1) makes a deductor who deducts short an assessee in default for
--    the whole shortfall, s.201(1A) charges interest at 1% or 1.5% a month on
--    it, and s.40(a)(i) disallows the expenditure. None of that is visible on
--    the voucher, which foots.
--
-- ############################################################################
-- ⭐⭐⭐ WHAT `rate_type` IS, AND WHY IT IS NOT A NEW `source` VALUE
-- ############################################################################
--
-- `source` answers WHO PUBLISHED IT , the Reserve Bank, a vendor feed, a
-- person in the workspace. `rate_type` answers WHICH OF THAT PUBLISHER'S
-- THREE DAILY NUMBERS IT IS. They are orthogonal axes:
--
--     source = 'rbi_reference', rate_type = 'mid'
--     source = 'manual',        rate_type = 'tt_buying'   (a bank advice)
--     source = 'manual',        rate_type = 'tt_selling'  (the same advice)
--     source = 'provider',      rate_type = 'mid'
--
-- ⚠️ SMUGGLING 'tt_buying' IN AS A `source` VALUE WAS THE CHEAP OPTION AND IS
--    WRONG. It would make `source = 'tt_buying'` an answer to "who published
--    this", which it is not, and it would make the pair (RBI, TT buying)
--    inexpressible , which is the pair that actually matters, since it is the
--    State Bank's TT buying rate that Rule 26 practice looks to. It would also
--    have to be added to `STORABLE_FX_RATE_SOURCES`, a CLOSED LIST whose whole
--    purpose is to be a list of publishers.
--
-- 🔴 AND NOTHING ANYWHERE INFERS ONE AXIS FROM THE OTHER. There is no
--    `rate_type_of(source)` in the TypeScript and there is none here.
--    "rbi_reference implies mid" is a true statement about the RBI's current
--    publication policy, not a fact about our data, and encoding it would
--    silently re-label every historical row the day it stopped being true.
--
-- ############################################################################
-- 🔴🔴 WHAT EVERY EXISTING ROW MEANS: 'unstated'. THE ARGUMENT.
-- ############################################################################
--
-- Every row in `fx_rates` and `fx_reference_rates` written before this file
-- carries no side of the spread, because the column did not exist and nobody
-- was ever asked the question. The backfill records that ignorance as a fact
-- rather than replacing it with a guess.
--
-- ⚠️ IT IS NOT 'mid', AND 'mid' WAS THE OBVIOUS WRONG MOVE. The most plausible
--    story for a hand-entered rate is that somebody copied it off a bank
--    advice for a real remittance , and an advice quotes a BUYING or a SELLING
--    rate, never a mid. So 'mid' would be false for exactly the rows most
--    likely to exist, and false in a way that reads as deliberate.
--
-- 🔴 IT IS EMPHATICALLY NOT 'tt_buying'. That one word would make every
--    historical rate immediately eligible to compute a s.195 chargeable base,
--    which is the silent mis-deduction this file exists to prevent. A wrong
--    'mid' refuses a conversion; a wrong 'tt_buying' performs one.
--
-- ⭐ AND 'unstated' COSTS NOTHING THAT IS WORKING TODAY. An unstated rate is
--    still used for everything it was already used for , AS 11 initial
--    recognition, the closing-rate revaluation, a receivables ageing , because
--    none of those name a side of the spread. It is refused ONLY where a
--    statute names one. No figure now on a screen moves because of this file.
--
-- ⚠️ THE BACKFILL IS DONE BY THE `ADD COLUMN ... DEFAULT` ITSELF AND BY NO
--    `UPDATE`. That is not a style choice. `fx_rates` has FORCE ROW LEVEL
--    SECURITY with `USING (tenant_id = app_current_tenant_id())` and NO
--    platform escape hatch , by design, see 0101 §4 , so an `UPDATE` from a
--    migration session matches ZERO rows and reports success. Setting
--    `app.platform_scope` would not help either, because that table's policy
--    does not consult it. DDL is not subject to row-level security, so the
--    column default fills every row in every tenant, exactly once, and then
--    the default is DROPPED so that a future insert must say which rate it is.
--
-- ############################################################################
-- ⚠️ THE UNIQUE KEYS CHANGE, AND THEY HAVE TO
-- ############################################################################
--
-- 0101 created:
--     fx_rates_pair_day_key            (tenant_id, base, quote, rate_date)
--     fx_reference_rates_pair_day_key  (base, quote, rate_date, source)
--
-- A workspace that remits dollars and receives dollars holds a TT buying AND a
-- TT selling rate for the same pair on the same day, both off one advice.
-- Under the old key the second write EVICTS the first , silently, because
-- `recordTenantRate` upserts , and the s.195 base moves without anybody
-- touching a deduction. So the rate type joins both keys and the old indexes
-- are dropped.
--
-- ⭐ THE NEW INDEX IS CREATED BEFORE THE OLD ONE IS DROPPED. The new key is a
--    SUPERSET of the old one, so it cannot be violated by data the old one
--    already permitted, and doing it in this order means a failure at any
--    point leaves the table with at least one uniqueness guarantee rather than
--    none.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Same reason as 0092 through 0105. This is pasted into the Neon browser
-- console, which sends each statement on its own connection. `BEGIN` buys no
-- atomicity across that boundary; it only makes a half-applied file look like
-- a clean one, which is how 0091 applied half-way while reporting success.
--
-- ⭐ EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT , ADD COLUMN IF NOT
--    EXISTS, CREATE INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before ADD
--    CONSTRAINT , and the file is safe to re-run from the top after a failure
--    at any point.
--
-- ⭐ AND THERE IS NO DML AT ALL. Not one INSERT, UPDATE or DELETE. See the
--    backfill argument above: on these tables DML is the shape that fails
--    silently, and DDL is the shape that works.
--
-- RUN ORDER: after 0105. Re-runnable.
-- ⚠️ RUN IT BEFORE THE PUSH THAT CARRIES THIS BATCH'S TypeScript. The new code
--    SELECTs `fx_rates.rate_type` on every rate lookup and INSERTs
--    `tds_deductions.payment_currency`; deployed against a database without
--    these columns, every FX conversion in the product fails. In the other
--    order , this file first , the columns simply sit unread until the deploy.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If a later section refuses, this row is still on your screen and still says
-- what was there before you started.
-- ============================================================================

SELECT
    '0106 · before'                                                  AS finding,
    to_regclass('public.fx_rates')            IS NOT NULL            AS fx_rates_present,
    to_regclass('public.fx_reference_rates')  IS NOT NULL            AS fx_reference_rates_present,
    to_regclass('public.tds_deductions')      IS NOT NULL            AS tds_deductions_present,
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'fx_rates'
               AND column_name = 'rate_type')                        AS fx_rates_typed_already,
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'tds_deductions'
               AND column_name = 'fx_rate_type')                     AS deductions_typed_already,
    -- ⚠️ query_to_xml, NOT a CASE over the table. The planner resolves BOTH
    --    branches of a CASE before the guard runs, so a diagnostic that reads
    --    a table whose existence it is testing fails with "relation does not
    --    exist" instead of reporting it. THE SQL STRING is what is guarded,
    --    and BOTH branches return exactly one row , a query returning no rows
    --    produces an empty document that xmltable/xpath cannot parse.
    (xpath('/row/c/text()',
           query_to_xml(
               CASE WHEN to_regclass('public.fx_rates') IS NULL
                    THEN 'SELECT -1::bigint AS c'
                    ELSE 'SELECT count(*)::bigint AS c FROM public.fx_rates'
               END, false, true, '')))[1]::text::bigint              AS tenant_rates_on_file,
    (xpath('/row/c/text()',
           query_to_xml(
               CASE WHEN to_regclass('public.fx_reference_rates') IS NULL
                    THEN 'SELECT -1::bigint AS c'
                    ELSE 'SELECT count(*)::bigint AS c FROM public.fx_reference_rates'
               END, false, true, '')))[1]::text::bigint              AS published_rates_on_file,
    (xpath('/row/c/text()',
           query_to_xml(
               CASE WHEN to_regclass('public.tds_deductions') IS NULL
                    THEN 'SELECT -1::bigint AS c'
                    ELSE 'SELECT count(*)::bigint AS c FROM public.tds_deductions'
               END, false, true, '')))[1]::text::bigint              AS deductions_on_file;


-- ============================================================================
-- SECTION 2 · `fx_reference_rates` · WHICH SIDE OF THE SPREAD
-- ============================================================================
-- 🔴 PLATFORM-SCOPED, NO tenant_id, FORCE RLS, WITH CHECK (app_platform_scope()).
--    DDL only , see the header. No DML is attempted on this table at all.
-- ============================================================================

ALTER TABLE public.fx_reference_rates
    ADD COLUMN IF NOT EXISTS rate_type varchar(12) NOT NULL DEFAULT 'unstated';

-- ⭐ THE DEFAULT EXISTED ONLY TO FILL HISTORY. A new row must say which of the
--    publisher's three numbers it is, so the default is removed and the
--    application supplies the value on every insert.
ALTER TABLE public.fx_reference_rates
    ALTER COLUMN rate_type DROP DEFAULT;

ALTER TABLE public.fx_reference_rates
    DROP CONSTRAINT IF EXISTS fx_reference_rates_rate_type_known;
ALTER TABLE public.fx_reference_rates
    ADD CONSTRAINT fx_reference_rates_rate_type_known
    CHECK (rate_type IN ('unstated','mid','tt_buying','tt_selling'));

COMMENT ON COLUMN public.fx_reference_rates.rate_type IS
    'Which side of the spread: mid, tt_buying, tt_selling, or unstated for a '
    'row written before SQL 0106 when nobody was asked. ORTHOGONAL to source, '
    'which says WHO published the number, and never derived from it. Rule 26 '
    'of the Income-tax Rules names the telegraphic transfer buying rate for '
    'TDS on income payable in foreign currency, and a statutory conversion is '
    'REFUSED rather than served a rate of any other type.';

-- ⭐ NEW KEY FIRST (a superset of the old one), OLD KEY SECOND.
CREATE UNIQUE INDEX IF NOT EXISTS fx_reference_rates_pair_day_type_key
    ON public.fx_reference_rates (base_currency, quote_currency, rate_date, source, rate_type);

DROP INDEX IF EXISTS public.fx_reference_rates_pair_day_key;

CREATE INDEX IF NOT EXISTS fx_reference_rates_type_lookup_idx
    ON public.fx_reference_rates (base_currency, quote_currency, rate_type, rate_date DESC);


-- ============================================================================
-- SECTION 3 · `fx_rates` · WHICH SIDE OF THE SPREAD
-- ============================================================================
-- 🔴 TENANT-SCOPED, FORCE RLS, `USING (tenant_id = app_current_tenant_id())`
--    AND NO PLATFORM ESCAPE HATCH. This is the table where an `UPDATE` from a
--    migration session would match zero rows and report success , which is
--    why the backfill is the ADD COLUMN default and nothing else.
--
-- ⚠️ THIS TABLE IS DIFFERENT FROM `fx_reference_rates` ON PURPOSE AND 0101 §4
--    ARGUES IT AT LENGTH: a published reference rate is one fact for every
--    workspace, a rate somebody typed off their own bank's advice is evidence
--    for their books and nobody else's. The two tables get the same column and
--    keep their different policies.
-- ============================================================================

ALTER TABLE public.fx_rates
    ADD COLUMN IF NOT EXISTS rate_type varchar(12) NOT NULL DEFAULT 'unstated';

ALTER TABLE public.fx_rates
    ALTER COLUMN rate_type DROP DEFAULT;

ALTER TABLE public.fx_rates
    DROP CONSTRAINT IF EXISTS fx_rates_rate_type_known;
ALTER TABLE public.fx_rates
    ADD CONSTRAINT fx_rates_rate_type_known
    CHECK (rate_type IN ('unstated','mid','tt_buying','tt_selling'));

COMMENT ON COLUMN public.fx_rates.rate_type IS
    'Which side of the spread: mid, tt_buying, tt_selling, or unstated for a '
    'row written before SQL 0106. A bank advice for a real remittance quotes a '
    'BUYING and a SELLING rate and never a mid, which is why the backfill did '
    'NOT assume mid; and it did not assume tt_buying because that would make '
    'every historical rate eligible to compute a s.195 deduction.';

CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_pair_day_type_key
    ON public.fx_rates (tenant_id, base_currency, quote_currency, rate_date, rate_type);

DROP INDEX IF EXISTS public.fx_rates_pair_day_key;

CREATE INDEX IF NOT EXISTS fx_rates_type_lookup_idx
    ON public.fx_rates (tenant_id, base_currency, quote_currency, rate_type, rate_date DESC);


-- ============================================================================
-- SECTION 4 · `tds_deductions` · THE DATE THE TAX IS REQUIRED TO BE DEDUCTED
-- ============================================================================
-- ⭐⭐ `deduction_date` HAS ALWAYS CLAIMED TO BE "the earlier of credit and
--     payment" AND NOTHING COULD CHECK THE CLAIM, because the table held only
--     ONE of the two dates. `payment_date` is there and documented as being
--     "for the audit trail only"; there was no credit date at all.
--
-- 🔴 THAT IS TOLERABLE WHILE A WRONG DEDUCTION DATE ONLY MIS-FILES A QUARTER.
--    It stops being tolerable under Rule 26, where the deduction date IS the
--    rate date: an invoice credited in March and paid in June, dated June,
--    is translated at June's dollar , so the CHARGEABLE BASE ITSELF is wrong,
--    not merely its quarter.
--
-- ⚠️ NULL ON EVERY EXISTING ROW, AND NULL IS THE HONEST ANSWER. Nobody was
--    ever asked for a credit date, so none is invented. The CHECK binds only
--    where the credit date is known.
-- ============================================================================

ALTER TABLE public.tds_deductions
    ADD COLUMN IF NOT EXISTS credit_date date;

COMMENT ON COLUMN public.tds_deductions.credit_date IS
    'The date the sum was credited to the payee''s account in our books , the '
    'day the expense and the creditor were recognised. NOT the invoice date: '
    'an invoice dated 28 March and booked on 4 April was credited on 4 April. '
    'With payment_date it makes deduction_date DERIVABLE rather than asserted.';


-- ----------------------------------------------------------------------------
-- ⭐⭐ RULE 26 · THE FOREIGN-CURRENCY MEASUREMENT, WITH ITS WORKING
-- ----------------------------------------------------------------------------
-- Before this file the rupee base of a s.195 payment was whatever figure
-- somebody typed, translated at a rate nobody recorded, and "which rate did
-- this deduction use" had NO ANSWER , which is the first question a s.201
-- proceeding asks.
-- ----------------------------------------------------------------------------

ALTER TABLE public.tds_deductions
    ADD COLUMN IF NOT EXISTS payment_currency varchar(3);

-- ⚠️ MINOR UNITS OF ITS OWN CURRENCY, AND THEY ARE NOT UNIVERSALLY HUNDREDTHS.
--    JPY has no minor unit and KWD has three. lib/fx/currency.ts carries the
--    exponent; nothing in this column assumes one.
ALTER TABLE public.tds_deductions
    ADD COLUMN IF NOT EXISTS foreign_payment_base_minor bigint;

ALTER TABLE public.tds_deductions
    ADD COLUMN IF NOT EXISTS fx_rate numeric(30,12);

ALTER TABLE public.tds_deductions
    ADD COLUMN IF NOT EXISTS fx_rate_date date;

ALTER TABLE public.tds_deductions
    ADD COLUMN IF NOT EXISTS fx_rate_type varchar(12);

ALTER TABLE public.tds_deductions
    ADD COLUMN IF NOT EXISTS fx_rate_source varchar(20);

-- ⚠️ NO FOREIGN KEY, DELIBERATELY. The rate could have come from `fx_rates`
--    (tenant-scoped) or `fx_reference_rates` (platform-scoped) and no single
--    FK can name both; and a rate row deleted years later must not delete or
--    null a filed deduction's evidence. The RATE ITSELF is copied onto this
--    row for that reason , the id is a pointer, not the evidence.
ALTER TABLE public.tds_deductions
    ADD COLUMN IF NOT EXISTS fx_rate_id uuid;

ALTER TABLE public.tds_deductions
    ADD COLUMN IF NOT EXISTS fx_statutory_ref varchar(60);

COMMENT ON COLUMN public.tds_deductions.fx_rate_date IS
    'The date the rate is FOR. The CHECK tds_deductions_rule_26_complete '
    'forces it to equal deduction_date: that equality IS Rule 26, "as on the '
    'date on which the tax is required to be deducted", written where it '
    'cannot be forgotten by a future writer.';

COMMENT ON COLUMN public.tds_deductions.fx_rate_type IS
    'Always ''tt_buying'' where the payment currency is not the rupee, and the '
    'CHECK permits nothing else. Mid and TT selling are different numbers and '
    'using one of them under-deducts or over-deducts; s.201(1) makes the '
    'deductor personally liable for a shortfall, plus s.201(1A) interest.';


-- ----------------------------------------------------------------------------
-- 🔴 THE CHECKS. Validated, not NOT VALID , every existing row has NULL in
--    every column named below, so both predicates are vacuously true across
--    the whole table and the ALTER cannot refuse on history.
-- ----------------------------------------------------------------------------

ALTER TABLE public.tds_deductions
    DROP CONSTRAINT IF EXISTS tds_deductions_deduction_date_is_earlier;
ALTER TABLE public.tds_deductions
    ADD CONSTRAINT tds_deductions_deduction_date_is_earlier
    CHECK (
        credit_date IS NULL
        OR deduction_date = LEAST(credit_date, COALESCE(payment_date, credit_date))
    );

-- ⚠️ IT DELIBERATELY DOES NOT BIND ON payment_date ALONE. A March bill
--    credited in March and paid in June is a CORRECT row with deduction_date
--    in March and payment_date in June , the shape s.194C(1) and s.195(1)
--    describe , and a check forcing them equal would refuse the very case
--    Chapter XVII-B is most often got wrong.

ALTER TABLE public.tds_deductions
    DROP CONSTRAINT IF EXISTS tds_deductions_rule_26_complete;
ALTER TABLE public.tds_deductions
    ADD CONSTRAINT tds_deductions_rule_26_complete
    CHECK (
        payment_currency IS NULL
        OR payment_currency = 'INR'
        OR (foreign_payment_base_minor IS NOT NULL
            AND foreign_payment_base_minor >= 0
            AND fx_rate IS NOT NULL
            AND fx_rate > 0
            AND fx_rate_date IS NOT NULL
            AND fx_rate_date = deduction_date
            AND fx_rate_type = 'tt_buying'
            AND fx_rate_source IS NOT NULL
            AND fx_statutory_ref IS NOT NULL)
    );

ALTER TABLE public.tds_deductions
    DROP CONSTRAINT IF EXISTS tds_deductions_domestic_carries_no_rate;
ALTER TABLE public.tds_deductions
    ADD CONSTRAINT tds_deductions_domestic_carries_no_rate
    CHECK (
        (payment_currency IS NOT NULL AND payment_currency <> 'INR')
        OR (fx_rate IS NULL
            AND fx_rate_date IS NULL
            AND fx_rate_type IS NULL
            AND foreign_payment_base_minor IS NULL)
    );

ALTER TABLE public.tds_deductions
    DROP CONSTRAINT IF EXISTS tds_deductions_payment_currency_shape;
ALTER TABLE public.tds_deductions
    ADD CONSTRAINT tds_deductions_payment_currency_shape
    CHECK (payment_currency IS NULL OR payment_currency ~ '^[A-Z]{3}$');

-- The worklist a reviewer wants: every deduction measured in a foreign
-- currency, newest first, per workspace.
CREATE INDEX IF NOT EXISTS tds_deductions_foreign_currency_idx
    ON public.tds_deductions (tenant_id, payment_currency, deduction_date DESC)
    WHERE payment_currency IS NOT NULL AND payment_currency <> 'INR';


-- ============================================================================
-- SECTION 5 · CONFIRMATION · THE ROW TO READ
-- ============================================================================
-- ⚠️ Every count that reads one of the changed tables goes through
--    query_to_xml with THE SQL STRING guarded , both on the relation and on
--    the column , and both branches of every guard return exactly one row.
-- ============================================================================

SELECT
    '0106 · verdict'                                                 AS finding,

    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('fx_rates','fx_reference_rates')
        AND column_name = 'rate_type')                               AS rate_type_columns,

    (SELECT count(*) FROM pg_constraint
      WHERE conname IN ('fx_rates_rate_type_known',
                        'fx_reference_rates_rate_type_known'))       AS rate_type_checks,

    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('fx_rates_pair_day_type_key',
                          'fx_reference_rates_pair_day_type_key'))   AS new_unique_keys,

    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('fx_rates_pair_day_key',
                          'fx_reference_rates_pair_day_key'))        AS old_unique_keys_left,

    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tds_deductions'
        AND column_name IN ('credit_date','payment_currency',
                            'foreign_payment_base_minor','fx_rate','fx_rate_date',
                            'fx_rate_type','fx_rate_source','fx_rate_id',
                            'fx_statutory_ref'))                     AS deduction_columns,

    (SELECT count(*) FROM pg_constraint
      WHERE conname IN ('tds_deductions_deduction_date_is_earlier',
                        'tds_deductions_rule_26_complete',
                        'tds_deductions_domestic_carries_no_rate',
                        'tds_deductions_payment_currency_shape'))    AS deduction_checks,

    -- ⭐ EVERY PRE-0106 RATE IS 'unstated'. If this is not the whole table,
    --    somebody has already started stating rate types, which is fine , but
    --    it means this file is being re-run rather than run.
    (xpath('/row/c/text()',
           query_to_xml(
               CASE WHEN NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'fx_rates'
                           AND column_name = 'rate_type')
                    THEN 'SELECT -1::bigint AS c'
                    ELSE 'SELECT count(*)::bigint AS c FROM public.fx_rates'
                         ' WHERE rate_type = ''unstated'''
               END, false, true, '')))[1]::text::bigint              AS tenant_rates_unstated,

    (xpath('/row/c/text()',
           query_to_xml(
               CASE WHEN NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public'
                           AND table_name = 'fx_reference_rates'
                           AND column_name = 'rate_type')
                    THEN 'SELECT -1::bigint AS c'
                    ELSE 'SELECT count(*)::bigint AS c FROM public.fx_reference_rates'
                         ' WHERE rate_type = ''unstated'''
               END, false, true, '')))[1]::text::bigint              AS published_rates_unstated,

    -- 🔴 THE ONE THAT MATTERS. A foreign-currency deduction measured at
    --    anything other than the TT buying rate for its own deduction date is
    --    now unrepresentable, so this must be zero for ever.
    (xpath('/row/c/text()',
           query_to_xml(
               CASE WHEN NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'tds_deductions'
                           AND column_name = 'fx_rate_type')
                    THEN 'SELECT -1::bigint AS c'
                    ELSE 'SELECT count(*)::bigint AS c FROM public.tds_deductions'
                         ' WHERE payment_currency IS NOT NULL'
                         '   AND payment_currency <> ''INR'''
                         '   AND (fx_rate_type IS DISTINCT FROM ''tt_buying'''
                         '        OR fx_rate_date IS DISTINCT FROM deduction_date)'
               END, false, true, '')))[1]::text::bigint              AS mis_measured_deductions,

    CASE
        WHEN (SELECT count(*) FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name IN ('fx_rates','fx_reference_rates')
                 AND column_name = 'rate_type') = 2
         AND (SELECT count(*) FROM pg_indexes
               WHERE schemaname = 'public'
                 AND indexname IN ('fx_rates_pair_day_type_key',
                                   'fx_reference_rates_pair_day_type_key')) = 2
         AND (SELECT count(*) FROM pg_indexes
               WHERE schemaname = 'public'
                 AND indexname IN ('fx_rates_pair_day_key',
                                   'fx_reference_rates_pair_day_key')) = 0
         AND (SELECT count(*) FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'tds_deductions'
                 AND column_name IN ('credit_date','payment_currency',
                                     'foreign_payment_base_minor','fx_rate','fx_rate_date',
                                     'fx_rate_type','fx_rate_source','fx_rate_id',
                                     'fx_statutory_ref')) = 9
         AND (SELECT count(*) FROM pg_constraint
               WHERE conname IN ('tds_deductions_deduction_date_is_earlier',
                                 'tds_deductions_rule_26_complete',
                                 'tds_deductions_domestic_carries_no_rate',
                                 'tds_deductions_payment_currency_shape')) = 4
        THEN '✅ 0106 APPLIED , rate_type is an axis of its own, every pre-0106 '
             'rate is unstated and refused for Rule 26, and a foreign-currency '
             'deduction cannot be stored except at the TT buying rate for its '
             'own deduction date.'
        ELSE '❌ 0106 INCOMPLETE , re-run this file from the top and read the '
             'counts above. Every statement is idempotent.'
    END                                                              AS verdict;
