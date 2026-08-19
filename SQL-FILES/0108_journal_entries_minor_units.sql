-- ############################################################################
-- 0108 , THE LEDGER'S OWN CURRENCY: journal_entries.amount BECOMES bigint MINOR
-- ############################################################################
--
-- PURPOSE
-- -------
-- `journal_entries.amount` is numeric(18,2). Two decimal places. Every other
-- money column in this product became `bigint` minor units years ago , paise
-- for rupees, integer thousandths for quantities, centidays for LOP , and the
-- ledger, the one place every figure in the business eventually lands, was
-- left behind.
--
-- Two decimals CANNOT REPRESENT A DINAR. One Kuwaiti dinar is 1000 fils, and
-- the same is true of the Bahraini, Iraqi, Jordanian, Libyan, Omani and
-- Tunisian units. A workspace keeping its books in KWD does not merely find
-- this inconvenient: the third decimal is silently discarded at the moment of
-- writing, the journal is out by up to 0.999 fils per leg, and nothing
-- anywhere reports a problem. Batches 0101 and 1.66.0 built multi-currency
-- everywhere except here, and post-sales.ts said so in writing rather than
-- hiding it. This file is the other half of that sentence.
--
-- ############################################################################
-- THE NEW COLUMN IS ADDED. THE OLD ONE IS NOT ALTERED IN PLACE.
-- ############################################################################
--
-- `ALTER COLUMN amount TYPE bigint USING (amount * 100)::bigint` is one
-- statement and it is IRREVERSIBLE. The original values are gone the instant
-- it commits; there is no column left holding what they were, and if the
-- multiplier turns out to have been wrong for some subset of rows , and
-- section 1 below shows that it IS wrong, for every row whose transaction is
-- not in a two-decimal currency , there is nothing to recompute from.
--
-- Adding `amount_minor` and backfilling it is reversible by `DROP COLUMN`.
-- The rollback for this entire file is at the bottom and it is four
-- statements. That asymmetry is the whole reason for the shape.
--
-- ############################################################################
-- 🔴 A BLANKET x100 BACKFILL WOULD CORRUPT EVERY NON-INR POSTING
-- ############################################################################
--
-- The obvious backfill is `amount * 100`. It is wrong, and it is wrong in the
-- direction that looks right.
--
-- `writeFxPosting()` in server/accounting/post-sales.ts has, since 0101,
-- written its legs with `formatMinorPlain(amountMinor, functionalCurrency)`,
-- which uses THAT CURRENCY'S exponent. So:
--
--   * a JPY exchange difference of 1234 yen was written as the string '1234'.
--     x100 makes it 123400 minor units, which in a zero-decimal currency IS
--     123400 yen. Overstated ONE HUNDRED FOLD.
--   * a KWD difference of 1234 fils was written as '1.234' and numeric(18,2)
--     ROUNDED IT TO 1.23 on the way in. The third digit is already gone. x100
--     gives 123 minor units where the truth was 1234. Understated ten fold,
--     and the missing digit is not recoverable from this table.
--
-- So the backfill scales by `currency_units.exponent` for the row's OWN
-- transaction currency, and section 1 counts the rows in each class BEFORE
-- anything is written, so the operator can see the size of both problems.
--
-- ⚠️ THE ROUNDED DINAR ROWS ARE REPORTED, NOT REPAIRED. The information was
-- destroyed at write time in 2026, not by this file. A backfill that invented
-- the missing digit would be a guess wearing the costume of a migration.
--
-- ############################################################################
-- 🔴 THIS TABLE IS APPEND-ONLY AND THE BACKFILL IS AN UPDATE
-- ############################################################################
--
-- `journal_entries_no_update` is a BEFORE UPDATE trigger that raises
-- unconditionally, and `journal_entries_period_lock` refuses any row whose
-- transaction falls in a closed period , which is most of the history worth
-- backfilling. Neither consults `app.platform_scope`; neither can be talked
-- round. They have to be turned off for the backfill and turned back on.
--
-- THAT IS THREE STATEMENTS, AND THIS FILE IS PASTED INTO A CONSOLE THAT SENDS
-- EACH STATEMENT ON ITS OWN CONNECTION. If the UPDATE failed between them, the
-- ledger would be left MUTABLE and the file would report an ordinary error.
-- So all three live inside ONE `DO $tag$ ... $tag$;` block: one statement, one
-- connection, one transaction. A failure anywhere inside it rolls back the
-- DISABLE along with everything else, and the guards are never off afterwards.
--
-- ⚠️ AND A TRAP FOUND BY RUNNING IT, NOT BY READING IT.
--    `ALTER TABLE ... ENABLE TRIGGER` fails with
--
--        ERROR:  cannot ALTER TABLE "journal_entries" because it has pending
--                trigger events
--
--    if a DEFERRABLE CONSTRAINT TRIGGER has fired earlier in the same
--    transaction and not yet been checked , which `journal_entries_balance_
--    check` does on every row the backfill touches. The re-enable, the one
--    statement that must not fail, is the statement that fails. The fix is to
--    disable that constraint trigger for the duration too, so nothing is left
--    pending when the re-enables run, and then to prove footing with an
--    explicit read instead of relying on the trigger to have run.
--
-- ############################################################################
-- 🔴 THE BACKFILL LOOPS OVER TENANTS. IT DOES NOT WEAKEN RLS.
-- ############################################################################
--
-- `journal_entries_tenant_isolation` is `tenant_id = app_current_tenant_id()`
-- and has NO platform-scope clause , deliberately, and ALL-IN-ONE-SETUP.sql
-- says why: platform staff may see THAT a workspace exists, never what is in
-- its books. So `PERFORM set_config('app.platform_scope','on',true)` does not
-- open this table and was never going to.
--
-- The backfill therefore pins `app.current_tenant_id` to each workspace in
-- turn and updates within it. `NO FORCE ROW LEVEL SECURITY`, even for one
-- transaction, does not appear in this file and must not be added to it: a
-- file containing that line is a file somebody copies.
--
-- ############################################################################
-- WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Same reason as 0092 through 0107. `BEGIN` buys no atomicity across a
-- statement-per-connection console; it only makes a half-applied file look
-- clean, which is how 0091 applied nothing while reporting success.
-- `SET LOCAL app.platform_scope` as its own statement reports success and has
-- evaporated before the next statement runs. Every DML statement below is
-- inside a single `DO $tag$ ... $tag$;` that begins by setting its own scope.
--
-- Every statement is independently idempotent and the file is safe to re-run
-- from the top after a failure at any point.
--
-- HOW THIS FILE WAS TESTED, AND IT WAS NOT BY READING IT:
--   scripts/run-sql-statement-per-connection.mjs sends each statement on
--   its OWN connection as a named non-superuser, which is the only thing
--   that reproduces the Neon console. It found three defects here that the
--   file did not show on the page - the pending-trigger-events failure in
--   section 6, a RETURNS TABLE type mismatch that raised only at CALL time,
--   and section 1's original `count(*)` returning 0 for the table OWNER
--   under FORCE RLS. `psql -f` would have caught none of the third and
--   would have reported the first differently.
--
-- RUN ORDER: after 0107. 🔴 RUN THIS BEFORE THE CODE PUSH, NOT AFTER.
--
-- ⚠️ 0106 AND 0107 ARE NOT IN THIS TREE AND THAT IS EXPECTED. They belong
--    to the main line, which ships several times an hour; this file is one
--    of five written in parallel and numbered from 0108 up precisely so the
--    continuous stream is never blocked waiting on a stream that ships once.
--    `npm run check:migrations` therefore reports "Missing migration 0106 /
--    0107" in THIS tree and goes green as soon as the two land beside it.
--
-- 🔴 DO NOT "FIX" THAT BY ADDING 0106 OR 0107 TO `KNOWN_GAPS` IN
--    scripts/check-migrations.mjs. That list means "never written, and never
--    will be". These two exist. Marking a real migration as a permanent hole
--    would make the gate lie about the one thing it was built to catch, and
--    its own header says it: a check that tolerates a category of fault has
--    stopped catching that fault.
--
--            The consequences of each deploy order are set out in section 10.
-- DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If any later section refuses, this output is still on your screen and still
-- tells you what was true before you started. A file whose most valuable
-- output sits behind its least certain operation teaches nothing on the day
-- it breaks.
--
-- WHAT TO READ HERE:
--   running_as        🔴 must NOT be a superuser if you are testing a refusal.
--                     A drill run as `postgres` passes every refusal test and
--                     proves nothing.
--   currency_units_present
--                     false means 0101 was never applied and the backfill in
--                     section 5 cannot scale anything. Stop and fix that.
--   already_present   true on a re-run. Sections 2-8 are then no-ops.
--   legs              rows in journal_entries.
--   max_amount        the largest single leg in the table, as numeric.
--
-- THE TWO PROOFS THIS FILE OWES YOU, BOTH TAKEN BEFORE ANYTHING IS WRITTEN:
--
--   lossy_scale_rows  rows where `amount * 10^exponent` is NOT a whole number,
--                     i.e. rows that would lose precision on conversion.
--                     numeric(18,2) holds at most two decimals, so this is 0
--                     for every currency with exponent >= 2 by construction.
--                     🔴 IT IS NOT NECESSARILY 0 FOR JPY (exponent 0): a leg
--                     of 1234.50 yen cannot become an integer count of yen.
--                     Any non-zero number here must be understood before
--                     section 5 runs, and section 5 leaves those rows NULL
--                     rather than rounding them.
--
--   overflow_rows     rows where `amount * 10^exponent` exceeds
--                     9223372036854775807, the largest bigint.
--                     numeric(18,2) tops out at 9999999999999999.99, so the
--                     worst case at exponent 4 is ~1.0e20, which DOES
--                     overflow. At exponent 2 the worst case is ~1.0e18 and
--                     does not. This is why the question is asked of the data
--                     instead of argued from the type.
-- ============================================================================

SELECT
    '0108 · who is running this'                                     AS finding,
    current_user                                                     AS running_as,
    (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user)  AS is_superuser,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)  AS bypasses_rls,
    to_regclass('public.journal_entries') IS NOT NULL                AS journal_present,
    to_regclass('public.transactions')    IS NOT NULL                AS transactions_present,
    to_regclass('public.currency_units')  IS NOT NULL                AS currency_units_present,
    EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'journal_entries'
           AND column_name  = 'amount_minor'
    )                                                                AS already_present;


-- ---------------------------------------------------------------------------
-- 1b · THE CENSUS FUNCTION
--
-- 🔴🔴 WHY THE CENSUS IS A FUNCTION THAT LOOPS TENANTS AND NOT A PLAIN
--      `SELECT count(*) FROM journal_entries`.
--
-- Because a plain count RETURNS ZERO for the person running this file, and
-- says so with total confidence.
--
-- `journal_entries` is FORCE ROW LEVEL SECURITY and its policy is
-- `tenant_id = app_current_tenant_id()` with NO platform-scope clause. FORCE
-- means the policy applies TO THE TABLE OWNER TOO. Measured in a PostgreSQL 16
-- sandbox carrying the real policies and the real triggers, against ten legs:
--
--     superuser `postgres`                           10   <- bypasses RLS
--     table owner, non-superuser, no tenant pinned    0
--     table owner, `app.platform_scope = on`          0   <- no such clause
--     `ordence_app`, no tenant pinned                 0
--
-- Whoever pastes this file into the Neon console is the middle case. A
-- diagnostic that reports "0 legs, nothing to convert" about a table holding a
-- million of them is not a weak diagnostic, it is a LIE that reads like
-- reassurance, and it is exactly the "it applied without error" failure this
-- project keeps paying for. The only reason it was caught is that the file was
-- executed as a non-superuser instead of read.
--
-- ⚠️ SO THE CENSUS PINS EACH WORKSPACE IN TURN AND READS UNDER THE POLICY,
--    which is what the backfill in section 6 has to do anyway. Nothing is
--    bypassed and no policy is weakened; every read below is one a legitimate
--    session could make. Run it as a superuser and it will agree with itself
--    for a different reason, which is why section 1a prints `is_superuser`.
--
-- ⚠️ IT IS CREATED BEFORE IT IS CALLED, so this is the one thing standing in
--    front of the diagnostic. `CREATE OR REPLACE FUNCTION` is not the file's
--    least certain operation , the backfill is , and the rule the house
--    style states is that the diagnostic must not sit behind THAT. It is also
--    left in place afterwards on purpose: section 10 verifies through the same
--    function, and the census can be re-run any day without editing SQL.
--
-- ⚠️ INVOKER, NOT DEFINER. SECURITY DEFINER would not help , FORCE RLS
--    applies to the definer as well , and it would hide which role the read
--    really succeeded as. This function is honest about running as you.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ordence_journal_currency_census()
RETURNS TABLE (
    currency        text,
    exponent        text,
    legs            bigint,
    lossy_legs      bigint,
    overflow_legs   bigint,
    at_risk_legs    bigint,
    unscaled_legs   bigint,
    unfooted_txns   bigint
)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_tenants uuid[];
    v_tenant  uuid;
    v_has_minor boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'journal_entries'
           AND column_name = 'amount_minor'
    ) INTO v_has_minor;

    PERFORM set_config('app.platform_scope', 'on', true);
    SELECT array_agg(id) INTO v_tenants FROM public.tenants;
    IF v_tenants IS NULL THEN RETURN; END IF;

    CREATE TEMP TABLE IF NOT EXISTS ordence_0108_census (
        currency text, exponent text, legs bigint,
        lossy_legs bigint, overflow_legs bigint, at_risk_legs bigint,
        unscaled_legs bigint, unfooted_txns bigint
    ) ON COMMIT DROP;
    DELETE FROM ordence_0108_census;

    FOREACH v_tenant IN ARRAY v_tenants LOOP
        PERFORM set_config('app.current_tenant_id', v_tenant::text, true);

        -- ⚠️ `amount_minor` is named only through EXECUTE, and only when the
        --    column exists. Naming a missing column in ordinary plpgsql SQL
        --    fails at first execution whatever the IF says, because the
        --    statement is planned when it is first reached.
        EXECUTE format($sql$
            INSERT INTO ordence_0108_census
            SELECT t.currency::text,
                   COALESCE(cu.exponent::text, 'UNKNOWN'),
                   count(*),
                   count(*) FILTER (
                       WHERE cu.exponent IS NOT NULL
                         AND je.amount IS NOT NULL
                         AND je.amount * (10::numeric ^ cu.exponent)
                             <> trunc(je.amount * (10::numeric ^ cu.exponent))),
                   count(*) FILTER (
                       WHERE cu.exponent IS NOT NULL
                         AND je.amount IS NOT NULL
                         AND abs(je.amount) * (10::numeric ^ cu.exponent)
                             > 9223372036854775807::numeric),
                   -- 🔴 THE TRUNCATION THAT CANNOT BE DETECTED PER ROW, SIZED.
                   --    A KWD leg reading 1.23 may have been 1.234 before
                   --    numeric(18,2) rounded it at write time, and may
                   --    equally have been exactly 1.230. The two are
                   --    indistinguishable in this table forever. What CAN be
                   --    counted is the exposure: every leg in a currency with
                   --    more than two decimals is a leg whose full precision
                   --    this column could never have held.
                   count(*) FILTER (WHERE COALESCE(cu.exponent, 2) > 2),
                   %s,
                   0
              FROM public.journal_entries je
              JOIN public.transactions t ON t.id = je.transaction_id
              LEFT JOIN public.currency_units cu ON cu.code = t.currency
             GROUP BY t.currency, cu.exponent
        $sql$, CASE WHEN v_has_minor
                    THEN 'count(*) FILTER (WHERE je.amount_minor IS NULL)'
                    ELSE 'count(*)' END);

        IF v_has_minor THEN
            EXECUTE $sql$
                UPDATE ordence_0108_census c
                   SET unfooted_txns = c.unfooted_txns + (
                       SELECT count(*) FROM (
                           SELECT je.transaction_id
                             FROM public.journal_entries je
                             JOIN public.transactions t ON t.id = je.transaction_id
                            WHERE t.currency::text = c.currency
                            GROUP BY je.transaction_id
                           HAVING COALESCE(SUM(CASE WHEN je.entry_type = 'debit'
                                                    THEN je.amount_minor ELSE 0 END), 0)
                               <> COALESCE(SUM(CASE WHEN je.entry_type = 'credit'
                                                    THEN je.amount_minor ELSE 0 END), 0)
                       ) u)
            $sql$;
        END IF;
    END LOOP;

    PERFORM set_config('app.current_tenant_id', '', true);

    RETURN QUERY
        -- ⚠️ EVERY AGGREGATE IS CAST. `sum()` over bigint returns NUMERIC,
        --    and a RETURNS TABLE column declared bigint then raises
        --    `42804 structure of query does not match function result type`
        --    at CALL time, not at CREATE time. The function created cleanly
        --    and every call failed; only running it showed that.
        SELECT c.currency, max(c.exponent), sum(c.legs)::bigint,
               sum(c.lossy_legs)::bigint, sum(c.overflow_legs)::bigint,
               sum(c.at_risk_legs)::bigint, sum(c.unscaled_legs)::bigint,
               sum(c.unfooted_txns)::bigint
          FROM ordence_0108_census c
         GROUP BY c.currency
         ORDER BY c.currency;
END;
$fn$;

COMMENT ON FUNCTION public.ordence_journal_currency_census() IS
    'Per-currency census of journal_entries: legs, legs that cannot be expressed '
    'as a whole number of that currency''s minor units, legs too large for a '
    'bigint, legs whose currency has more decimals than numeric(18,2) could '
    'ever have held, legs not yet scaled, and transactions that do not foot in minor '
    'units. Pins each tenant in turn because journal_entries is FORCE RLS with '
    'no platform-scope clause, so a plain count returns 0 even for the owner.';


-- ---------------------------------------------------------------------------
-- 1c · THE TWO PROOFS THIS FILE OWES YOU, TAKEN BEFORE ANYTHING IS WRITTEN
--
--   lossy_legs     legs where `amount * 10^exponent` is not a whole number,
--                  i.e. legs that would lose precision on conversion.
--                  numeric(18,2) holds at most two decimals, so this is 0 for
--                  every currency of exponent >= 2 BY CONSTRUCTION.
--                  🔴 IT NEED NOT BE 0 FOR JPY (exponent 0): a leg of 1234.50
--                  yen is not a whole number of yen. Section 6 leaves any such
--                  leg NULL rather than rounding it, and section 9 then
--                  refuses to SET NOT NULL. That refusal is the point.
--
--   overflow_legs  legs where `amount * 10^exponent` exceeds
--                  9223372036854775807, the largest bigint.
--                  numeric(18,2) tops out at 9999999999999999.99. At exponent
--                  2 the worst case is ~1.0e18 and fits. 🔴 AT EXPONENT 4
--                  (CLF, UYW) the worst case is ~1.0e20 and DOES NOT. This is
--                  why the question is asked of the data rather than argued
--                  from the type: "numeric(18,2) always fits in a bigint after
--                  scaling" is FALSE, and it is false for currencies this
--                  product already accepts.
--
--   at_risk_legs   legs in a currency of more than two decimals. 🔴 THIS ONE
--                  IS NOT A DEFECT THIS FILE CAN FIX AND IT IS NOT COUNTED BY
--                  `lossy_legs`. A KWD leg reading 1.23 was written by
--                  `formatMinorPlain(1234, 'KWD')` as the string '1.234' and
--                  numeric(18,2) ROUNDED IT ON THE WAY IN. 1.23 x 1000 = 1230
--                  fils is a whole number, so `lossy_legs` sees nothing wrong
--                  with it, and the backfill will happily write 1230 where the
--                  truth was 1234. The fourth digit is gone and no arithmetic
--                  recovers it.
--                  So the file REPORTS THE EXPOSURE rather than repairing it.
--                  A backfill that invented the missing digit would be a guess
--                  wearing the costume of a migration. If this number is not 0,
--                  those workspaces' dinar books need reconciling against the
--                  source documents by a person, and that is a finance job and
--                  not a SQL one.
--
-- `lossy_legs` and `overflow_legs` must be 0 before section 6 is worth
-- running. If either is not, the rows behind it need a person, and section 9
-- will say so by refusing.
-- ---------------------------------------------------------------------------

SELECT '0108 · precision and overflow proof' AS finding, *
  FROM public.ordence_journal_currency_census();


-- ============================================================================
-- SECTION 2 · THE COLUMN
-- ============================================================================
-- NULLABLE, and it stays nullable until section 8. Two reasons, and the second
-- is the one that matters:
--
--   1. A NOT NULL column added to a populated table needs a DEFAULT, and any
--      constant default here would be a wrong amount on every historical row.
--
--   2. 🔴 BETWEEN THIS FILE RUNNING AND THE CODE PUSH LANDING, THE OLD CODE IS
--      STILL WRITING. It supplies `amount` and knows nothing about
--      `amount_minor`. A NOT NULL column would refuse every posting in the
--      product for the length of that window. The trigger in section 4 fills
--      the column for those rows instead, which is what makes the window safe.
-- ============================================================================

ALTER TABLE public.journal_entries
    ADD COLUMN IF NOT EXISTS amount_minor bigint;

COMMENT ON COLUMN public.journal_entries.amount_minor IS
    'The leg, in the minor units of its transaction''s currency. Paise for INR, '
    'fils for KWD (1000 to the dinar), whole yen for JPY. THIS IS THE '
    'AUTHORITATIVE AMOUNT: the balance check in 0108 section 6 foots on this '
    'column and server/accounting/post-sales.ts writes only this column. '
    'Always positive; direction is carried by entry_type, never by sign.';

COMMENT ON COLUMN public.journal_entries.amount IS
    'LEGACY MIRROR, DERIVED, LOSSY ABOVE TWO DECIMALS. Kept because readers '
    'outside this batch still sum it. Filled by trigger journal_entries_zz_'
    'fill_minor from amount_minor and the transaction currency exponent; it '
    'rounds for KWD/BHD/OMR/JOD/TND/LYD/IQD (exponent 3) and CLF/UYW '
    '(exponent 4), and is NULL where that rounding would produce zero. '
    'amount_minor is the authority. Do not add a new reader of this column.';


-- ============================================================================
-- SECTION 3 · THE EXPONENT, AS ONE FUNCTION BOTH THE TRIGGER AND THE BACKFILL
--             CONSULT
-- ============================================================================
-- Two copies of "how many decimals does this currency have" is how the copies
-- drift. `currency_units` is the SQL-side source (0101), `lib/fx/currency.ts`
-- is the engine-side one, and verifyCurrencyUnits() already compares them.
-- This function is how SQL asks.
--
-- ⚠️ IT RETURNS NULL FOR AN UNKNOWN CODE AND DOES NOT DEFAULT TO 2. A default
--    of 2 is exactly the bug lib/billing/money.ts carried: right for most
--    currencies and wrong by a factor of ten for the Gulf. Everything
--    downstream treats NULL as "cannot scale this row", which is the truth.
--
-- ⚠️ SECURITY DEFINER, and it must be. `currency_units` is FORCE RLS with a
--    SELECT policy of USING (true), so any role may read it , but the trigger
--    in section 4 runs during an INSERT by `ordence_app`, and a function that
--    could be made to fail there would fail the posting. DEFINER pins the
--    read to the owner and `SET search_path = pg_catalog, public` stops the
--    classic definer-function hijack via a shadowed schema.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ordence_currency_exponent(p_code text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
    SELECT exponent FROM public.currency_units WHERE code = upper(trim(p_code));
$fn$;

COMMENT ON FUNCTION public.ordence_currency_exponent(text) IS
    'Decimal places for an ISO-4217 code, from currency_units. NULL for a code '
    'the table does not carry - deliberately, so that a row whose currency is '
    'unknown is left unscaled and reported rather than silently assumed to '
    'have two decimals.';


-- ============================================================================
-- SECTION 4 · THE FILL TRIGGER · WHAT MAKES BOTH DEPLOY ORDERS SURVIVABLE
-- ============================================================================
-- One BEFORE INSERT trigger that fills whichever of the pair is missing:
--
--   old code writes `amount` only            -> amount_minor is derived
--   new code writes `amount_minor` only      -> amount is derived (rounded)
--   something writes both                    -> both are left alone
--
-- 🔴 THE NAME BEGINS `aa_` AND THAT IS LOAD-BEARING. PostgreSQL fires BEFORE
--    ROW triggers in ALPHABETICAL ORDER BY TRIGGER NAME, and this one must run
--    FIRST , specifically before `journal_entries_update_balance`.
--
--    THE FIRST DRAFT NAMED IT `zz_` so that it would run LAST, on the
--    reasoning that it wanted `balance_after` already populated. That
--    reasoning was wrong and the cost was total: `update_ledger_balance()`
--    reads `NEW.amount` to work out its delta, so when new code supplied only
--    `amount_minor` the delta was NULL, `current_balance + NULL` was NULL, and
--    every posting died with
--
--        ERROR:  null value in column "current_balance" of relation "ledgers"
--                violates not-null constraint
--
--    on a trigger this file never touches. It was found by inserting a row,
--    and by nothing else; the file read perfectly and every gate was green.
--
-- ⚠️ `amount` IS SET TO NULL RATHER THAN 0.00 WHEN THE ROUNDING WOULD PRODUCE
--    ZERO. A 4-fil leg is 0.004 KWD, which is 0.00 at two decimals, and
--    `journal_entries_amount_positive` (CHECK amount > 0) would refuse the
--    row. NULL passes that CHECK, sums as nothing under the COALESCE every
--    existing reader already uses, and is honest: there is no two-decimal
--    number for this leg.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.journal_entry_fill_minor()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_currency text;
    v_exponent integer;
    v_scale    numeric;
    v_mirror   numeric;
BEGIN
    IF NEW.amount_minor IS NOT NULL AND NEW.amount IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT currency INTO v_currency FROM public.transactions WHERE id = NEW.transaction_id;
    v_exponent := public.ordence_currency_exponent(COALESCE(v_currency, 'INR'));

    IF v_exponent IS NULL THEN
        -- 🔴 NAMED, NOT GUESSED. The alternative is assuming two decimals,
        -- which is the defect this whole batch exists to stop repeating.
        RAISE EXCEPTION
            'Cannot record this journal leg: currency "%" is not in currency_units, '
            'so the number of decimal places it has is unknown.', v_currency
            USING ERRCODE = 'check_violation',
                  HINT = 'Add the code to currency_units (0101 seeds the ISO-4217 set), '
                         'or correct the transaction''s currency.';
    END IF;

    v_scale := 10::numeric ^ v_exponent;

    IF NEW.amount_minor IS NULL AND NEW.amount IS NOT NULL THEN
        IF NEW.amount * v_scale <> trunc(NEW.amount * v_scale) THEN
            RAISE EXCEPTION
                'Cannot record this journal leg: % is not a whole number of % minor units.',
                NEW.amount, v_currency
                USING ERRCODE = 'check_violation';
        END IF;
        NEW.amount_minor := (NEW.amount * v_scale)::bigint;
    END IF;

    IF NEW.amount IS NULL AND NEW.amount_minor IS NOT NULL THEN
        v_mirror := round(NEW.amount_minor::numeric / v_scale, 2);
        NEW.amount := CASE WHEN v_mirror = 0 THEN NULL ELSE v_mirror END;
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS journal_entries_aa_fill_minor ON public.journal_entries;
CREATE TRIGGER journal_entries_aa_fill_minor
    BEFORE INSERT ON public.journal_entries
    FOR EACH ROW EXECUTE FUNCTION public.journal_entry_fill_minor();


-- ============================================================================
-- SECTION 4b · THE LEDGER CACHE STOPS ASSUMING `amount` IS THERE
-- ============================================================================
-- `update_ledger_balance()` maintains `ledgers.current_balance`, a numeric(20,2)
-- cache so a dashboard need not aggregate the whole journal. It computes its
-- delta from `NEW.amount`.
--
-- 🔴 AFTER SECTION 5 THAT COLUMN CAN LEGITIMATELY BE NULL , for a leg below
--    one hundredth of a major unit, where there is no two-decimal number to
--    put in it. `current_balance + NULL` is NULL, and `current_balance` is NOT
--    NULL, so the INSERT dies inside a trigger this batch did not write and
--    the error names `ledgers`, not `journal_entries`. COALESCE is the whole
--    fix.
--
-- ⚠️ AND IT MEANS THE CACHE UNDERSTATES A DINAR BOOK BY ITS SUB-PAISA LEGS.
--    That is not introduced here , `numeric(20,2)` never could hold fils , it
--    is made visible here. The AUTHORITATIVE balance is
--    `SUM(journal_entries.amount_minor)`, which is exact, and
--    `ledgerBalanceAt()` in server/banking/reconciliation-service.ts already
--    computes it that way. `ledgers.current_balance` needs its own
--    `current_balance_minor` and that is a separate batch; it is listed in
--    this batch's report rather than half-built here.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_ledger_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_account_type text;
    v_delta        numeric(20,2);
    v_new_balance  numeric(20,2);
    v_amount       numeric(20,2);
BEGIN
    SELECT account_type::text INTO v_account_type FROM public.ledgers WHERE id = NEW.ledger_id;

    -- 🔴 COALESCE. See the section header. A leg with no two-decimal
    -- representation contributes nothing to a two-decimal cache, which is the
    -- truth; it contributes exactly to amount_minor, which is the authority.
    v_amount := COALESCE(NEW.amount, 0);

    IF v_account_type IN ('asset', 'expense') THEN
        v_delta := CASE WHEN NEW.entry_type = 'debit' THEN v_amount ELSE -v_amount END;
    ELSE
        v_delta := CASE WHEN NEW.entry_type = 'credit' THEN v_amount ELSE -v_amount END;
    END IF;

    UPDATE public.ledgers
       SET current_balance = current_balance + v_delta,
           updated_at      = now()
     WHERE id = NEW.ledger_id
    RETURNING current_balance INTO v_new_balance;

    NEW.balance_after := v_new_balance;
    RETURN NEW;
END;
$fn$;


-- ============================================================================
-- SECTION 5 · `amount` STOPS BEING MANDATORY
-- ============================================================================
-- Required before the trigger above may set it to NULL, and before new code
-- may write only `amount_minor`.
--
-- ⭐ REVERSIBLE: `SET NOT NULL` restores it, and will succeed as long as no
--    sub-minor-unit leg has been written since. See the rollback at the end.
-- ============================================================================

ALTER TABLE public.journal_entries ALTER COLUMN amount DROP NOT NULL;


-- ============================================================================
-- SECTION 6 · THE BACKFILL · ONE STATEMENT, ONE CONNECTION, ONE TRANSACTION
-- ============================================================================
-- Everything the header warns about is contained here on purpose: the three
-- disabled guards, the tenant loop, the drain of pending deferred events, the
-- re-enable, and an assertion that the re-enable actually happened. If any
-- line of it raises, the whole block rolls back and the guards were never off.
--
-- IDEMPOTENT: `WHERE amount_minor IS NULL`. A second run updates nothing.
--
-- ⚠️ IT SCALES BY THE ROW'S OWN CURRENCY, NOT BY 100. See the header.
-- ⚠️ IT SKIPS ROWS IT CANNOT SCALE HONESTLY , unknown currency, or a value
--    that is not a whole number of minor units , and RAISES A NOTICE naming
--    the count. Section 8 will then refuse to SET NOT NULL, loudly, which is
--    the correct outcome: those rows need a human.
-- ============================================================================

DO $backfill$
DECLARE
    v_tenants  uuid[];
    v_tenant   uuid;
    v_updated  bigint := 0;
    v_n        bigint;
    v_left     bigint;
    v_armed    boolean;
BEGIN
    IF to_regclass('public.currency_units') IS NULL THEN
        RAISE EXCEPTION '0108 section 6 needs currency_units. Apply 0101 first.';
    END IF;

    -- Reading the tenant LIST is platform work; reading their books is not.
    PERFORM set_config('app.platform_scope', 'on', true);
    SELECT array_agg(id) INTO v_tenants FROM public.tenants;

    IF v_tenants IS NULL THEN
        RAISE NOTICE '0108: no tenants. Nothing to backfill.';
        RETURN;
    END IF;

    -- 🔴 THE THREE GUARDS, OFF ONLY INSIDE THIS TRANSACTION.
    --    journal_entries_no_update    raises on every UPDATE, unconditionally.
    --    journal_entries_period_lock  refuses any row in a closed period, which
    --                                 is most of the history worth backfilling.
    --    journal_entries_balance_check is DEFERRABLE; if it fires here it
    --                                 leaves pending events and the re-enables
    --                                 below fail with "cannot ALTER TABLE ...
    --                                 because it has pending trigger events".
    ALTER TABLE public.journal_entries DISABLE TRIGGER journal_entries_no_update;
    ALTER TABLE public.journal_entries DISABLE TRIGGER journal_entries_period_lock;
    ALTER TABLE public.journal_entries DISABLE TRIGGER journal_entries_balance_check;

    FOREACH v_tenant IN ARRAY v_tenants LOOP
        PERFORM set_config('app.current_tenant_id', v_tenant::text, true);

        UPDATE public.journal_entries je
           SET amount_minor = (je.amount * (10::numeric ^ cu.exponent))::bigint
          FROM public.transactions t
          JOIN public.currency_units cu ON cu.code = t.currency
         WHERE t.id = je.transaction_id
           AND je.amount_minor IS NULL
           AND je.amount IS NOT NULL
           -- Only rows that convert EXACTLY. A 1234.50 yen leg is not a whole
           -- number of yen and is left for a person to look at.
           AND je.amount * (10::numeric ^ cu.exponent)
               = trunc(je.amount * (10::numeric ^ cu.exponent))
           AND abs(je.amount) * (10::numeric ^ cu.exponent) <= 9223372036854775807::numeric;

        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_updated := v_updated + v_n;
    END LOOP;

    -- Back on, in the same transaction that turned them off.
    ALTER TABLE public.journal_entries ENABLE TRIGGER journal_entries_balance_check;
    ALTER TABLE public.journal_entries ENABLE TRIGGER journal_entries_period_lock;
    ALTER TABLE public.journal_entries ENABLE TRIGGER journal_entries_no_update;

    -- ⭐ AND PROVE IT, rather than assuming the ALTERs did what they said.
    SELECT bool_and(tgenabled <> 'D') INTO v_armed
      FROM pg_trigger
     WHERE tgrelid = 'public.journal_entries'::regclass
       AND tgname IN ('journal_entries_no_update',
                      'journal_entries_period_lock',
                      'journal_entries_balance_check');

    IF v_armed IS NOT TRUE THEN
        RAISE EXCEPTION
            '0108: a guard trigger on journal_entries is still disabled. '
            'Rolling back so the ledger is never left mutable.';
    END IF;

    -- What could not be scaled. Counted across all tenants under platform
    -- scope? No , the policy has no platform clause. Counted the same way it
    -- was written: per tenant.
    v_left := 0;
    FOREACH v_tenant IN ARRAY v_tenants LOOP
        PERFORM set_config('app.current_tenant_id', v_tenant::text, true);
        SELECT v_left + count(*) INTO v_left
          FROM public.journal_entries WHERE amount_minor IS NULL;
    END LOOP;

    RAISE NOTICE '0108: backfilled % legs across % workspaces. % legs left unscaled.',
        v_updated, array_length(v_tenants, 1), v_left;

    IF v_left > 0 THEN
        RAISE NOTICE '0108: those % legs are in a currency currency_units does not '
                     'carry, or hold a value that is not a whole number of that '
                     'currency''s minor units. Section 9 will refuse SET NOT NULL '
                     'until they are resolved. That refusal is the point.', v_left;
    END IF;
END
$backfill$;


-- ============================================================================
-- SECTION 7 · THE BALANCE CHECK FOOTS ON MINOR UNITS
-- ============================================================================
-- 🔴 THIS IS NOT TIDYING. Without it a dinar book CANNOT POST AT ALL.
--
-- The old function sums `amount`, which is now a rounded mirror. Three legs of
-- 1.235 KWD each net to 3.705; their mirrors are 1.24, 1.24 and 1.23 and net
-- to 3.71 against a 3.70 debit. The books balance and the constraint refuses
-- them. Footing on the integer that was actually posted removes the question.
--
-- ⚠️ A NULL `amount_minor` IS REFUSED BY NAME rather than skipped by SUM().
--    SUM ignores NULLs, so an unscaled leg would silently make an unbalanced
--    transaction look balanced , which is the failure this trigger exists to
--    prevent, arriving through the trigger itself.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_double_entry_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_transaction_id uuid;
    v_debits         bigint;
    v_credits        bigint;
    v_count          integer;
    v_unscaled       integer;
    v_diff           bigint;
BEGIN
    v_transaction_id := COALESCE(NEW.transaction_id, OLD.transaction_id);

    SELECT COALESCE(SUM(CASE WHEN entry_type = 'debit'  THEN amount_minor ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount_minor ELSE 0 END), 0),
           COUNT(*),
           COUNT(*) FILTER (WHERE amount_minor IS NULL)
      INTO v_debits, v_credits, v_count, v_unscaled
      FROM public.journal_entries
     WHERE transaction_id = v_transaction_id;

    -- A transaction with no legs left (fully rolled back) is fine.
    IF v_count = 0 THEN
        RETURN NULL;
    END IF;

    IF v_unscaled > 0 THEN
        RAISE EXCEPTION
            'Transaction % cannot be checked: % of its % legs have no amount_minor.',
            v_transaction_id, v_unscaled, v_count
            USING ERRCODE = 'check_violation',
                  HINT = 'Every leg must carry an integer amount in its currency''s '
                         'minor units. A leg with none cannot be added up.';
    END IF;

    IF v_count < 2 THEN
        RAISE EXCEPTION
            'Transaction % is unbalanced: only % entry found. Double-entry requires at least two.',
            v_transaction_id, v_count
            USING ERRCODE = 'check_violation',
                  HINT = 'Every transaction needs at least one debit and one credit.';
    END IF;

    v_diff := v_debits - v_credits;

    IF v_diff <> 0 THEN
        RAISE EXCEPTION
            'Transaction % does not balance. Debits = %, Credits = %, difference = % (minor units).',
            v_transaction_id, v_debits, v_credits, v_diff
            USING ERRCODE = 'check_violation',
                  HINT = 'Debits must exactly equal credits. Check for a missing or mistyped entry.';
    END IF;

    RETURN NULL;
END;
$fn$;


-- ============================================================================
-- SECTION 8 · THE CONSTRAINT AND THE INDEX
-- ============================================================================
-- Positive, like `amount`, and for the same reason: direction lives in
-- entry_type, and allowing a sign as well would give two ways to say one thing
-- and two ways to get it wrong.
--
-- ⚠️ `IS NULL OR` IS PRESENT AND IS NOT SLOPPINESS. The column is nullable
--    until section 9 succeeds, and a CHECK that refused NULL would refuse
--    every insert during the window before the code push.
-- ============================================================================

ALTER TABLE public.journal_entries
    DROP CONSTRAINT IF EXISTS journal_entries_amount_minor_positive;
ALTER TABLE public.journal_entries
    ADD CONSTRAINT journal_entries_amount_minor_positive
    CHECK (amount_minor IS NULL OR amount_minor > 0);

-- ⚠️ The old CHECK is RESTATED, not dropped. `amount > 0` already accepts
--    NULL (a NULL comparison is NULL, never false), so the mirror going NULL
--    for a sub-paisa dinar leg does not violate it. Restating it here is a
--    re-runnable way to say "this was considered and left alone".
ALTER TABLE public.journal_entries
    DROP CONSTRAINT IF EXISTS journal_entries_amount_positive;
ALTER TABLE public.journal_entries
    ADD CONSTRAINT journal_entries_amount_positive
    CHECK (amount IS NULL OR amount > 0);

-- The statement-of-account and trial-balance sums now read this column.
CREATE INDEX IF NOT EXISTS journal_entries_ledger_minor_idx
    ON public.journal_entries (tenant_id, ledger_id, amount_minor);


-- ============================================================================
-- SECTION 9 · NOT NULL, LAST, AND ALLOWED TO FAIL
-- ============================================================================
-- 🔴 IF THIS STATEMENT FAILS, READ SECTION 6'S NOTICE AND STOP. It fails only
--    when legs remain that could not be scaled honestly, and the right
--    response is to look at them, not to work around this line.
--
-- ⚠️ IT IS SAFE TO LEAVE FAILED. A nullable amount_minor still works: the
--    section 4 trigger fills every new row, and the section 7 check refuses
--    any transaction containing an unscaled leg by name. The column being
--    NOT NULL is a statement about history, not a requirement of the code.
--
-- Idempotent: SET NOT NULL on an already-NOT NULL column succeeds silently.
-- ============================================================================

ALTER TABLE public.journal_entries ALTER COLUMN amount_minor SET NOT NULL;


-- ============================================================================
-- SECTION 10 · VERIFY · RUN THIS AFTER, AND RUN IT AS `ordence_app`
-- ============================================================================
-- 🔴 RUN AS THE APPLICATION ROLE. Every read below is subject to RLS, and a
--    superuser sees all of it whatever the policies say. A verification run as
--    `postgres` proves the rows exist and proves nothing about isolation.
--
-- WHAT TO READ:
--   guards_armed       must be 3. Anything less means a trigger is disabled
--                      and the ledger is mutable. Section 6 cannot leave it
--                      that way, but this is the read that proves it.
--   unscaled_legs      must be 0.
--   mismatched_legs    legs where the mirror and the authority disagree by
--                      more than the rounding the mirror is allowed. Must be 0.
--   unfooted_txns      transactions whose debits and credits differ IN MINOR
--                      UNITS. Must be 0. This is the claim the whole file
--                      rests on and it is the one worth checking by hand.
--
-- ⚠️ `unfooted_txns` COUNTED IN MINOR UNITS IS A DIFFERENT QUESTION FROM THE
--    OLD ONE. A dinar transaction can foot in fils and not foot in the
--    two-decimal mirror. That is the defect, not a fault in the check.
-- ============================================================================

SELECT
    '0108 · verify · guards' AS finding,
    (SELECT count(*) FROM pg_trigger
      WHERE tgrelid = 'public.journal_entries'::regclass
        AND tgenabled <> 'D'
        AND tgname IN ('journal_entries_no_update',
                       'journal_entries_period_lock',
                       'journal_entries_balance_check'))            AS guards_armed,
    (SELECT count(*) FROM pg_trigger
      WHERE tgrelid = 'public.journal_entries'::regclass
        AND tgname = 'journal_entries_aa_fill_minor')               AS fill_trigger_present,
    (SELECT a.attnotnull FROM pg_attribute a
      WHERE a.attrelid = 'public.journal_entries'::regclass
        AND a.attname = 'amount_minor')                             AS amount_minor_not_null,
    (SELECT a.attnotnull FROM pg_attribute a
      WHERE a.attrelid = 'public.journal_entries'::regclass
        AND a.attname = 'amount')                                   AS amount_still_not_null;


-- ⚠️ THE SAME CENSUS, RUN AGAIN. `unscaled_legs` and `unfooted_txns` must both
--    be 0 in every row. `lossy_legs` and `overflow_legs` will read exactly what
--    they read in section 1c , this file does not change them and cannot.
SELECT '0108 · verify · census' AS finding, *
  FROM public.ordence_journal_currency_census();


-- ############################################################################
-- RUN ORDER, STATED BOTH WAYS BECAUSE ONE OF THEM IS FATAL
-- ############################################################################
--
-- 🔴 SQL FIRST, THEN THE CODE PUSH. This is the only correct order.
--
-- IF THE SQL LANDS FIRST AND THE CODE LATER (correct):
--   Nothing breaks and nothing is lost. The column exists and is backfilled.
--   The old code keeps writing `amount` and knows nothing about the new
--   column; the section 4 trigger derives `amount_minor` for every row it
--   writes, so no gap opens in the history during the window. The section 7
--   balance check foots on a column that is populated for every row. When the
--   code push lands it starts writing `amount_minor` and the trigger starts
--   deriving `amount` instead. There is no moment at which either column is
--   missing for any row.
--
-- 🔴 IF THE CODE LANDS FIRST AND THE SQL LATER (fatal, and immediately):
--   `server/accounting/post-sales.ts` inserts `amount_minor` into a column
--   that does not exist. PostgreSQL raises `column "amount_minor" of relation
--   "journal_entries" does not exist` (SQLSTATE 42703) on the FIRST posting.
--   Because posting shares the caller's transaction, THE WHOLE OPERATION
--   FAILS: issuing a sales invoice, recording a receipt, posting a vendor
--   bill, running payroll and closing a depreciation run all raise instead of
--   completing. This is not a degraded mode with a backlog; it is an outage of
--   every write path that touches the ledger, and it starts with the first
--   request after the deploy. The remedy is to run this file, which takes
--   effect immediately with no restart.
--
-- ⚠️ ONE PATH IS ALREADY BROKEN TODAY AND THIS FILE IS WHAT FIXES IT.
--   `ledgerBalanceAt()` in server/banking/reconciliation-service.ts has been
--   querying `je.amount_minor` since 0102 , a column that has never existed.
--   It is raw SQL, so `tsc` cannot see it and no gate checks column names in
--   a template string. Bank reconciliation and the bank-account closing
--   balance raise 42703 on every call today. Section 2 is what makes them
--   work. That is an argument for running this file SOONER, not later.
--
-- ############################################################################
-- ROLLBACK , FOUR STATEMENTS, AND THIS IS WHY THE COLUMN WAS ADDED RATHER
-- THAN THE OLD ONE ALTERED IN PLACE
-- ############################################################################
--
--   ALTER TABLE public.journal_entries ALTER COLUMN amount SET NOT NULL;
--   DROP TRIGGER IF EXISTS journal_entries_aa_fill_minor ON public.journal_entries;
--   ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS amount_minor;
--   -- then restore enforce_double_entry_balance() from ALL-IN-ONE-SETUP.sql
--   -- section 5, which sums `amount`.
--
-- ⚠️ THE FIRST STATEMENT FAILS IF ANY SUB-MINOR-UNIT LEG HAS BEEN WRITTEN
--    SINCE , a dinar leg below one paisa, whose mirror is NULL. There is no
--    two-decimal number for that leg, so the rollback is telling the truth:
--    the book now contains a figure the old schema could not hold. Delete
--    those legs' transactions or accept the column stays nullable.
--
-- 🔴 THE ROLLBACK IS NOT AVAILABLE THE OTHER WAY ROUND. Had this file done
--    `ALTER COLUMN amount TYPE bigint`, there would be nothing to drop and
--    nothing to restore from.
-- ############################################################################
