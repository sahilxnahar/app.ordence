-- ############################################################################
-- 0110 · ONE RECEIPT AGAINST THREE INVOICES, AND THE INPUT CREDIT ON A
--        BANK CHARGE THAT NOBODY WAS EVER TOLD ABOUT
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.67.0-alpha   ·   Migration number: 0110
--
-- PURPOSE
-- -------
-- `0102` finished the reconciliation STATEMENT and stated two limitations
-- plainly. This file closes them.
--
--   F1  `bank_line_matches` is strictly 1:1 because of two unique indexes
--       `0070` created. A customer paying three invoices with one NEFT is not
--       representable, and neither is a cheque covering two bills.
--
--   F2  A bank charge is posted GROSS and the role help says to claim the
--       input credit from the bank's own tax invoice by hand. Nothing recorded
--       that it was owed, nothing totalled it, and nothing ever asked.
--
-- And one thing `0102` reasoned about and never tested, which this file does
-- test: `bank_reconciliations.statement_id ON DELETE CASCADE`.
--
-- ############################################################################
-- 🔴🔴 F1 · WHY DROPPING THE TWO INDEXES ALONE WOULD HAVE BEEN WORSE THAN
--      LEAVING THEM
-- ############################################################################
--
-- `0070:262-265` created `bank_line_matches_one_per_line` and
-- `bank_line_matches_one_per_document`, and its comment gives the right
-- reason:
--
--     "WITHOUT BOTH HALVES THE RECONCILIATION CAN BALANCE WHILE BEING
--      NONSENSE. Matching one receipt to two statement lines explains twice
--      as much money as actually moved, and the residue comes out to zero
--      because the same rupees were counted on both sides."
--
-- That is true, and it is an argument for an AMOUNT, not for 1:1. The indexes
-- were the right invariant enforced by the wrong mechanism: they stopped
-- double-explaining by forbidding N:M entirely, which also forbade the
-- ordinary case.
--
-- ⭐⭐ SO THE UNIT OF MATCHING BECOMES THE AMOUNT. Every match row carries
--    `allocated_minor` and TWO SUMS BOUND IT:
--
--        |Σ allocations against one statement line| ≤ |line amount|
--        |Σ allocations against one document|      ≤ |document amount|
--
-- ⚠️ `≤` AND NOT `=`, AND THAT IS THE ONE DESIGN DECISION IN THIS FILE.
--    Matching one receipt to three invoices is THREE ACTS BY A PERSON. After
--    the first, the line is one third explained. An equality constraint would
--    refuse that first insert, so the only way to record three allocations
--    would be to record all three in one statement — and a screen that makes
--    you get a whole month right in one submission is a screen where somebody
--    guesses the third figure to make the form submit.
--
-- 🔴 EQUALITY IS A PROPERTY INSTEAD, AND THE BRS READS IT. A line whose
--    allocations do not sum to it is PARTLY explained, and its unexplained
--    RESIDUE is an outstanding item on the reconciliation statement, by name,
--    with its own amount. See `ResidualItem` in
--    `lib/banking/reconciliation.ts` and the `partlyExplained` input to
--    `buildBrs`, which is REQUIRED rather than optional so that a caller who
--    has not thought about it does not compile.
--
--    That is the half that makes a false balance impossible rather than
--    merely unlikely. `≤` alone would let a ₹10,000 line carry ₹6,000 of
--    allocations and vanish off the outstanding list, and the missing ₹4,000
--    would surface at the bottom of the statement as an "unexplained
--    difference" with nothing saying which line it came from. With the
--    residue carried as a named item, EVERY PAISA IS EITHER ALLOCATED TO A
--    DOCUMENT OR PRINTED AS OUTSTANDING. There is no third place for money.
--
-- ############################################################################
-- 🔴🔴 F2 · WHY THE GST ON A BANK CHARGE IS NOT SPLIT OUT BY A RATE
-- ############################################################################
--
-- The obvious fix is to take 18% off every charge. It is wrong in the way
-- that survives review and fails an audit:
--
--   • s.16(2)(a) CGST Act — credit only where the recipient IS IN POSSESSION
--     OF A TAX INVOICE. At write-up time there is none: the bank invoices
--     separately, usually consolidated for the month.
--   • s.16(2)(aa) with Rule 36(4) — the credit must have been furnished by
--     the supplier and reached the recipient's GSTR-2B. A figure derived from
--     a statement line has no supplier invoice number, so it can NEVER be
--     matched to a 2B row. It would sit in GSTR-3B as an unsupported claim.
--   • s.12(12) IGST Act — place of supply for banking services is the
--     recipient's location on the SUPPLIER's records, so a charge can be IGST
--     rather than CGST+SGST and a computed split would file it in the wrong
--     box of the wrong return. Interest is exempt outright, Notification
--     12/2017-Central Tax (Rate) entry 27.
--
-- ⚠️ AND MAKING THE OPERATOR TYPE THE SPLIT AT WRITE-UP TIME IS THE SAME
--    GUESS WITH A HUMAN ALIBI. They do not have the invoice either. They
--    would type 18% because the screen asked for a number.
--
-- ⭐⭐ SO: THE CHARGE IS STILL POSTED GROSS, which is CORRECT at that moment,
--    and the deferred credit becomes a ROW with a state, a tax period and a
--    total on a screen. It is closed only against a real invoice whose
--    number, date and GSTIN are recorded, and whose split MUST FOOT TO THE
--    MONEY THAT LEFT THE ACCOUNT:
--
--        taxable + CGST + SGST + IGST + cess = gross
--
--    A CHECK enforces that. It is the constraint that refuses an assumed 18%
--    coming back in through the form: a rate read off an invoice foots, and
--    a rate assumed on a charge that was partly exempt does not.
--
-- 🔴 WHAT THIS FILE DELIBERATELY DOES NOT DO: it does not build the journal
--    that moves the tax out of Bank Charges into input credit
--    (Dr Input CGST, Dr Input SGST, Cr Bank Charges). Every posting builder
--    in this product lives in `lib/accounting/sales-posting.ts`, which this
--    batch does not own. The register records exactly what that journal
--    needs, and the batch report names it as a handoff. A second posting path
--    in the banking module is how the period lock came to be forgotten once
--    already.
--
-- ############################################################################
-- 🔴🔴🔴 HOW TO RUN THIS FILE
-- ############################################################################
--
-- Paste it into the Neon SQL editor and run it. THERE IS NO `BEGIN;` AND NO
-- `COMMIT;` IN IT, DELIBERATELY: the console sends each statement on its own
-- connection, so a `BEGIN;` opens a transaction the console holds, one
-- failing statement silently discards everything after it, and the final
-- `COMMIT` rolls the whole thing back with no visible error. `0091` once
-- appeared to apply and applied nothing.
--
-- ⚠️ EVERY STATEMENT IS INDEPENDENTLY IDEMPOTENT and re-runnable. Every write
--    to a FORCE-RLS table is inside a single `DO $tag$ ... $tag$;` block, so
--    one statement is one connection is one transaction, by construction.
--
-- ⚠️ `psql -f` DOES NOT REPRODUCE THE FAILURE MODE, because it sends the whole
--    file on one connection. Testing a file the way it is not used proves
--    nothing about the way it is used.
--
-- 🔴 RUN ORDER RELATIVE TO THE CODE PUSH: **SQL FIRST, THEN THE CODE, WITH NO
--    DELIBERATE GAP.** The pushed `confirmMatch` writes `allocated_minor` on
--    every insert, so code first would mean every match attempt failing on a
--    column that does not exist. SQL first is safe because the column is
--    added NULLABLE and only made NOT NULL at the end of Section 2.
--
-- ⚠️ IF A MATCH IS CREATED BETWEEN THE TWO HALVES, the old code inserts it
--    with a NULL allocation and Section 2 step ④ REFUSES to set NOT NULL,
--    naming the count. That is the right failure: it is loud, it is at the
--    end, and the remedy is to run Section 2 again once the code is up.
--    Section 2 is idempotent precisely so that re-running it is the answer.
--
-- 🔴 THERE IS DELIBERATELY NO DEFAULT ON THE COLUMN, and the first draft of
--    this file had one. A `DEFAULT 0` would have filled every existing row at
--    `ADD COLUMN` time, which meant `SET NOT NULL` passed on a database where
--    the backfill had missed a row — the proof proved nothing. Found by
--    running the file, not by reading it.
--
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUN THIS FIRST AND READ THE ANSWER
-- ============================================================================
-- ⭐ THE DIAGNOSTIC IS FIRST BECAUSE A FILE WHOSE MOST VALUABLE OUTPUT SITS
--    BEHIND ITS LEAST CERTAIN OPERATION TEACHES NOTHING ON THE DAY IT BREAKS.
--    If Section 3 refuses, this has already told you what was there.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️⚠️ `query_to_xml` IS NOT AN EXISTENCE GUARD, AND `0102` USED IT AS ONE
-- ══════════════════════════════════════════════════════════════════════════
-- `0102`'s own header says it chose `query_to_xml` over a `CASE` because "the
-- planner resolves both branches of a CASE before the guard runs". Half right.
-- `query_to_xml` defers PLANNING, not EXISTENCE: the string it is handed still
-- EXECUTES, and it still fails on a missing table.
--
-- ⭐ SO THE `CASE` GOES AROUND THE SQL STRING, NOT AROUND THE RELATION. The
--    CASE chooses between two strings, the planner has nothing to resolve, and
--    `query_to_xml` executes whichever string was chosen. Both warnings are
--    satisfied at once, and this file never names a possibly-absent table in a
--    FROM clause.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴🔴🔴 AND THE FIRST VERSION OF THIS DIAGNOSTIC COUNTED ZERO ON A DATABASE
--        WITH TWO MATCH ROWS IN IT
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ THIS IS RECORDED BECAUSE IT WAS FOUND BY EXECUTING THE FILE, NOT BY
--    READING IT. `bank_line_matches` carries FORCE ROW LEVEL SECURITY from
--    `0070`, a migration runs as the table owner, and FORCE means the owner is
--    NOT exempt. With no tenant pinned, `count(*)` returned 0 — confidently,
--    with no error — and the file would have reported "nothing to back-fill"
--    on a database full of rows.
--
-- 🔴 A DIAGNOSTIC THAT CANNOT SEE THE ROWS IT IS DIAGNOSING IS WORSE THAN NO
--    DIAGNOSTIC, because it produces a number somebody acts on.
--
-- ⭐ THE FIX IS THE CTE BELOW. `app_platform_scope()` IS in this policy's
--    USING (it is absent only from WITH CHECK), so platform scope grants the
--    READ, and it must be set INSIDE this statement because
--    `SET LOCAL app.platform_scope` as its own statement reports success and
--    evaporates before the next one runs.
--
-- ⚠️ AND IT IS A CTE RATHER THAN A SCALAR SUBQUERY FOR A REASON WORTH
--    KNOWING: PostgreSQL will not inline a CTE containing a VOLATILE
--    function, and `set_config` is volatile. So `scope` is materialised and
--    evaluated before the target list that depends on it. A bare
--    `(SELECT set_config(...))` in the target list has no such ordering
--    guarantee, and an ordering that happens to work is an ordering that will
--    stop working.
-- ============================================================================

WITH scope AS (
    SELECT set_config('app.platform_scope', 'on', true) AS enabled
)
SELECT
    '0110 · diagnostic'                                          AS finding,
    current_user                                                 AS running_as,
    (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS running_as_superuser,

    to_regclass('public.bank_line_matches')          IS NOT NULL AS matches_present,
    to_regclass('public.bank_charge_itc_deferrals')  IS NOT NULL AS itc_register_already_present,

    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'bank_line_matches'
               AND column_name = 'allocated_minor')              AS allocated_minor_already_present,

    EXISTS (SELECT 1 FROM pg_class
             WHERE relname = 'bank_line_matches_one_per_line')   AS old_one_per_line_index_present,
    EXISTS (SELECT 1 FROM pg_class
             WHERE relname = 'bank_line_matches_one_per_document') AS old_one_per_document_index_present,

    -- ⭐ HOW MANY ROWS THE BACKFILL WILL TOUCH. "It applied without error" and
    --   "it did what it was for" are different claims, and a backfill against
    --   an empty table reports success and exercises nothing. This number is
    --   what tells the two apart.
    (SELECT (xpath('/row/c/text()', query_to_xml(
        CASE WHEN to_regclass('public.bank_line_matches') IS NULL
                  OR scope.enabled <> 'on'
             THEN 'SELECT 0 AS c'
             ELSE 'SELECT count(*) AS c FROM public.bank_line_matches'
        END, false, true, '')))[1]::text)                        AS match_rows_today,

    -- 🔴 AND HOW MANY OF THEM SIT UNDER A SIGNED RECONCILIATION. Those are the
    --   rows `ordence_guard_reconciled_bank_line` will refuse to let the
    --   backfill touch. Section 2 handles them explicitly and says so; this
    --   is how you know in advance whether that path will run at all.
    (SELECT (xpath('/row/c/text()', query_to_xml(
        CASE WHEN to_regclass('public.bank_line_matches') IS NULL
                  OR to_regclass('public.bank_statement_lines') IS NULL
                  OR to_regclass('public.bank_accounts') IS NULL
                  OR scope.enabled <> 'on'
             THEN 'SELECT 0 AS c'
             ELSE 'SELECT count(*) AS c
                     FROM public.bank_line_matches m
                     JOIN public.bank_statement_lines l ON l.id = m.statement_line_id
                     JOIN public.bank_accounts a        ON a.id = l.bank_account_id
                    WHERE a.reconciled_to IS NOT NULL
                      AND l.value_date <= a.reconciled_to'
        END, false, true, '')))[1]::text)                        AS match_rows_inside_a_signed_period,

    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgname = 'ordence_guard_reconciled_bank_line'
               AND NOT tgisinternal)                             AS lock_trigger_present,
    -- ⚠️ `tgenabled`, NOT MERELY PRESENCE. A disabled trigger is a trigger
    --    that exists and does nothing, and `ALTER TABLE ... DISABLE TRIGGER`
    --    leaves no other trace. 'O' means enabled for origin, the normal state.
    (SELECT tgenabled FROM pg_trigger
      WHERE tgname = 'ordence_guard_reconciled_bank_line'
        AND NOT tgisinternal)                                    AS lock_trigger_enabled_flag,
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgname = 'ordence_guard_summed_bank_allocation'
               AND NOT tgisinternal)                             AS allocation_guard_already_present,
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgname = 'ordence_guard_reconciled_statement_delete'
               AND NOT tgisinternal)                             AS statement_delete_guard_already_present
FROM scope;


-- ============================================================================
-- SECTION 2 · `allocated_minor` · THE COLUMN, ITS BACKFILL, AND THE GUARD
--             TRIGGER THAT STANDS IN THE BACKFILL'S WAY
-- ============================================================================
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴🔴🔴 I READ THE TRIGGER BEFORE WRITING THIS. IT DOES NOT OVERWRITE
--        ANYTHING, AND IT DOES REFUSE THE BACKFILL.
-- ══════════════════════════════════════════════════════════════════════════
-- `ordence_guard_reconciled_bank_line` (0102:453-521) is BEFORE INSERT OR
-- UPDATE OR DELETE on `bank_line_matches`. Two facts about it matter here and
-- both were checked against the function body, not assumed:
--
--   ① IT NEVER ASSIGNS TO `NEW`. It ends `RETURN CASE WHEN TG_OP = 'DELETE'
--      THEN OLD ELSE NEW END`, unmodified. So it CANNOT silently discard an
--      engine-computed figure the way `ordence_validate_stock_movement` once
--      overwrote `NEW.value_minor`. `allocated_minor` reaches the table as
--      written.
--
--   ② IT RAISES ON ANY UPDATE TO A ROW WHOSE LINE IS DATED ON OR BEFORE THE
--      ACCOUNT'S `reconciled_to`. A backfill is an UPDATE. So on any database
--      where a reconciliation has been signed off since 0102, the backfill of
--      those rows is REFUSED — correctly, by a guard doing exactly its job.
--
-- ⭐ ADDING THE COLUMN IS DDL AND FIRES NO ROW TRIGGER, so step ① below is
--    always safe. It is the UPDATE that meets the guard.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ AND RLS REFUSES IT TOO, FOR A COMPLETELY SEPARATE REASON
-- ══════════════════════════════════════════════════════════════════════════
-- `0070` puts FORCE ROW LEVEL SECURITY on `bank_line_matches` with
--
--     WITH CHECK (tenant_id = app_current_tenant_id())
--
-- and NO `app_platform_scope()` escape on the write side — deliberately, and
-- correctly. A migration runs as the table owner, FORCE means the owner is not
-- exempt, and `app_current_tenant_id()` is NULL unless somebody sets it. So a
-- plain `UPDATE bank_line_matches` from this file is refused outright:
--
--     ERROR: new row violates row-level security policy
--
-- That is the `0092` incident exactly. 🔴 SETTING `app.platform_scope` WOULD
-- NOT FIX IT, because platform scope appears only in this policy's USING and
-- never in its WITH CHECK. THE HONEST FIX IS TO SET THE TENANT, ONE TENANT AT
-- A TIME, WHICH IS WHAT THE APPLICATION ITSELF DOES INSIDE `withTenant`. No
-- security property is suspended and the loop is visible.
-- ============================================================================

-- ── ① THE COLUMN. DDL, so no row trigger fires and RLS does not apply. ──────
--
-- ⚠️ NULLABLE, AND WITH NO DEFAULT. Both matter.
--
-- 🔴 NULL IS THE "NOT YET BACKFILLED" MARKER, AND IT HAS TO BE UNAMBIGUOUS.
--    The first draft of this file gave the column `DEFAULT 0` so that the old
--    `confirmMatch` could keep inserting during the deploy. That filled every
--    existing row with 0 at ADD COLUMN time, so `SET NOT NULL` in step ④
--    passed on a database where the backfill had skipped a row — the check
--    that was supposed to prove the backfill proved nothing at all, and the
--    miss surfaced two statements later on a CHECK constraint instead.
--
-- ⚠️ FOUND BY EXECUTING THIS FILE AGAINST A THROWAWAY POSTGRES AS A
--    NON-SUPERUSER, not by reading it. Recorded here because the convenient
--    version and the correct version differ by one keyword.
ALTER TABLE public.bank_line_matches
    ADD COLUMN IF NOT EXISTS allocated_minor bigint;

COMMENT ON COLUMN public.bank_line_matches.allocated_minor IS
    'How much of the statement line this match explains, signed, in paise. '
    'Positive is money in, as everywhere in this module. Two sums bound it and '
    'ordence_guard_summed_bank_allocation enforces both: the allocations on '
    'one line may not exceed the line, and the allocations on one document may '
    'not exceed the document. Equality is NOT a constraint — a line whose '
    'allocations do not sum to it is partly explained and its residue is an '
    'outstanding item on the BRS, which is what makes a false balance '
    'impossible. See lib/banking/allocation.ts.';


-- ── ② THE BACKFILL, TENANT BY TENANT, WITH THE LOCK TRIGGER LIVE ───────────
--
-- ⭐ EVERY EXISTING ROW EXPLAINS ITS LINE IN FULL, BY CONSTRUCTION. The two
--    unique indexes `0070` created made matching strictly 1:1, so a match row
--    that exists today is the only one on its line and accounts for all of it.
--    That is not an assumption about the data; it is what the indexes enforced.
--    Section 3 drops them only AFTER this has run.
--
-- 🔴 SO THIS BACKFILL CHANGES NO SIGNED FIGURE. It writes down an amount every
--    existing row already implied. The BRS arithmetic before and after is
--    identical, which is why the locked rows in step ③ can be filled in at all
--    without the signed statements ceasing to be reproducible.
--
-- ⚠️ THIS STEP TOUCHES ONLY ROWS THE GUARD PERMITS. Rows under a signed
--    reconciliation are left for step ③, so the ordinary case runs with the
--    lock fully live and nothing unusual is exercised for it.
DO $backfill_open$
DECLARE
    t          record;
    filled     bigint := 0;
    this_round bigint;
BEGIN
    FOR t IN SELECT id FROM public.tenants LOOP
        -- 🔴 THE TENANT, NOT THE PLATFORM SCOPE. See the section header:
        --    this policy's WITH CHECK has no platform escape and setting one
        --    would achieve nothing. `true` scopes it to this transaction,
        --    which is this DO block, which is this statement.
        PERFORM set_config('app.current_tenant_id', t.id::text, true);

        UPDATE public.bank_line_matches m
           SET allocated_minor = l.amount_minor
          FROM public.bank_statement_lines l
               JOIN public.bank_accounts a ON a.id = l.bank_account_id
         WHERE l.id = m.statement_line_id
           AND m.tenant_id = t.id
           AND m.allocated_minor IS NULL
           -- ⚠️ ONLY THE ROWS THE LOCK PERMITS. The rest are step ③.
           AND (a.reconciled_to IS NULL OR l.value_date > a.reconciled_to);

        GET DIAGNOSTICS this_round = ROW_COUNT;
        filled := filled + this_round;
    END LOOP;

    PERFORM set_config('app.current_tenant_id', '', true);

    RAISE NOTICE '0110 · backfilled % unlocked match row(s) with the guard live.', filled;
END;
$backfill_open$;


-- ── ③ THE ROWS UNDER A SIGNED RECONCILIATION ───────────────────────────────
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴🔴🔴 THIS BLOCK SUSPENDS `ordence_guard_reconciled_bank_line` AND SAYS SO
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ I CONSIDERED THREE ALTERNATIVES AND REJECTED ALL OF THEM:
--
--   • Widening the trigger to permit an UPDATE that changes only
--     `allocated_minor`. That leaves a PERMANENT hole in production to serve
--     a ONE-TIME migration, and the hole is exactly the shape of "an UPDATE
--     that only looks harmless".
--   • `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` for the duration. That
--     suspends tenant isolation, which is the only tenant isolation this
--     product has. Not for a backfill. Not ever.
--   • Leaving the locked rows NULL. Step ④ would then fail, or would have to
--     be dropped, and `allocated_minor` would be a nullable column whose NULL
--     silently means "the whole line" — a field with an implicit meaning,
--     which is how `0070` describes the two-column withdrawal/deposit trap it
--     refused for exactly this reason.
--
-- ⭐ SO: SUSPENDED, ATOMICALLY, INSIDE ONE STATEMENT. `ALTER TABLE ... DISABLE
--    TRIGGER` is transactional in PostgreSQL. One `DO` block is one statement
--    is one connection is one transaction, so if ANY line below raises, the
--    whole block aborts and the DISABLE is rolled back with it. There is no
--    interleaving in which this file ends with the lock off.
--
-- 🔴 AND IT ASSERTS BOTH FACTS BEFORE IT FINISHES: the trigger is enabled
--    again, and no row is left unfilled. Either failing raises, which aborts
--    the block, which restores everything.
--
-- ⚠️ IT DOES NOTHING AT ALL IF THERE IS NOTHING TO DO. On a database with no
--    signed reconciliations the trigger is never touched — which is the
--    common case and should not pay for the rare one.
DO $backfill_locked$
DECLARE
    t          record;
    pending    bigint;
    filled     bigint := 0;
    this_round bigint;
    still_null bigint;
    flag       "char";
BEGIN
    -- 🔴🔴 PLATFORM SCOPE FOR THE READS, AND ONLY THE READS.
    --
    -- ⚠️ THE FIRST DRAFT OF THIS BLOCK COUNTED ZERO ON A DATABASE THAT HAD A
    --    LOCKED ROW IN IT, and returned early saying "nothing to do". FORCE
    --    RLS applies to the owner, no tenant was pinned, and the count came
    --    back 0 with no error. The block then skipped the backfill, and the
    --    CHECK two statements later was what finally caught it.
    --
    -- ⭐ `app_platform_scope()` IS in `0070`'s USING and absent only from its
    --    WITH CHECK, so this grants the READ and grants nothing on the write
    --    side. The writes below still pin a real tenant, one at a time.
    PERFORM set_config('app.platform_scope', 'on', true);

    SELECT count(*) INTO pending
      FROM public.bank_line_matches m
      JOIN public.bank_statement_lines l ON l.id = m.statement_line_id
      JOIN public.bank_accounts        a ON a.id = l.bank_account_id
     WHERE m.allocated_minor IS NULL
       AND a.reconciled_to IS NOT NULL
       AND l.value_date <= a.reconciled_to;

    IF pending = 0 THEN
        RAISE NOTICE '0110 · no match rows sit under a signed reconciliation. The lock trigger was not touched.';
        RETURN;
    END IF;

    RAISE NOTICE '0110 · % match row(s) sit under a signed reconciliation. Suspending ordence_guard_reconciled_bank_line for this statement only.', pending;

    ALTER TABLE public.bank_line_matches
        DISABLE TRIGGER ordence_guard_reconciled_bank_line;

    FOR t IN SELECT id FROM public.tenants LOOP
        PERFORM set_config('app.current_tenant_id', t.id::text, true);

        UPDATE public.bank_line_matches m
           SET allocated_minor = l.amount_minor
          FROM public.bank_statement_lines l
         WHERE l.id = m.statement_line_id
           AND m.tenant_id = t.id
           AND m.allocated_minor IS NULL;

        GET DIAGNOSTICS this_round = ROW_COUNT;
        filled := filled + this_round;
    END LOOP;

    -- ⚠️ THE TENANT PIN IS CLEARED AND PLATFORM SCOPE IS LEFT ON FOR THE
    --    ASSERTIONS BELOW, which have to be able to see every tenant's rows.
    --    An assertion that can only see one tenant is an assertion that
    --    passes on the other nineteen.
    PERFORM set_config('app.current_tenant_id', '', true);

    ALTER TABLE public.bank_line_matches
        ENABLE TRIGGER ordence_guard_reconciled_bank_line;

    -- 🔴 THE TWO ASSERTIONS. A block that restores the guard "and then
    --    returns" is a block whose restoration nobody checked.
    SELECT tgenabled INTO flag
      FROM pg_trigger
     WHERE tgname = 'ordence_guard_reconciled_bank_line' AND NOT tgisinternal;

    IF flag IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION
            '0110 refused to finish: ordence_guard_reconciled_bank_line is in state % rather than enabled. Nothing in this block has been kept.', flag;
    END IF;

    SELECT count(*) INTO still_null
      FROM public.bank_line_matches
     WHERE allocated_minor IS NULL;

    IF still_null > 0 THEN
        RAISE EXCEPTION
            '0110 refused to finish: % match row(s) still have no allocated_minor. Nothing in this block has been kept.', still_null;
    END IF;

    RAISE NOTICE '0110 · backfilled % locked match row(s). Guard restored and verified.', filled;
END;
$backfill_locked$;


-- ── ④ NOT NULL, AND THE TEMPORARY DEFAULT REMOVED ──────────────────────────
--
-- 🔴 THIS IS THE PROOF THAT THE BACKFILL WORKED, AND IT IS ONLY A PROOF
--    BECAUSE THE COLUMN HAS NO DEFAULT. `SET NOT NULL` scans the whole table
--    at the storage layer — RLS does not apply to it — and refuses if a single
--    row was missed. A count printed by this file can be read and shrugged at;
--    a refusal cannot.
--
-- ⚠️ IF THIS REFUSES, a match was created between this file running and the
--    code being pushed, with a NULL allocation. Re-run Section 2 step ② — it
--    is idempotent — and then run this again.
DO $notnull$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'bank_line_matches'
           AND column_name = 'allocated_minor'
           AND is_nullable = 'YES'
    ) THEN
        ALTER TABLE public.bank_line_matches
            ALTER COLUMN allocated_minor SET NOT NULL;
    END IF;
END;
$notnull$;

-- ⚠️ A MATCH THAT ACCOUNTS FOR NOTHING IS NOT AN EXPLANATION, and it would be
--    counted as one by every screen that counts rows rather than money.
DO $nonzero$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'bank_line_matches_allocation_not_zero'
           AND conrelid = 'public.bank_line_matches'::regclass
    ) THEN
        ALTER TABLE public.bank_line_matches
            ADD CONSTRAINT bank_line_matches_allocation_not_zero
            CHECK (allocated_minor <> 0);
    END IF;
END;
$nonzero$;


-- ============================================================================
-- SECTION 3 · THE TWO 1:1 INDEXES GO, AND ONE DIFFERENT INDEX ARRIVES
-- ============================================================================
-- ⚠️ AFTER THE BACKFILL, NEVER BEFORE IT. Section 2 relies on 1:1 still being
--    true to know that each existing row explains its whole line.
--
-- 🔴 THE NEW INDEX IS A DIFFERENT RULE AND IS STILL NEEDED. One line may be
--    allocated to many documents and one document to many lines, but the SAME
--    line and the SAME document may meet only once. Two rows for one pair
--    would sum correctly and be impossible to read, and "unmatch this document
--    from this line" would have no single answer.
-- ============================================================================

DROP INDEX IF EXISTS bank_line_matches_one_per_line;
DROP INDEX IF EXISTS bank_line_matches_one_per_document;

CREATE UNIQUE INDEX IF NOT EXISTS bank_line_matches_one_row_per_pair
    ON public.bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id);

-- ⭐ THE TWO SUM BOUNDS ARE READ ON EVERY WRITE, ONE PER SIDE, SO BOTH LOOKUPS
--    ARE INDEXED. Without these the guard trigger is a sequential scan per row
--    inserted, which turns matching a 400-line statement into a morning.
CREATE INDEX IF NOT EXISTS bank_line_matches_line_idx
    ON public.bank_line_matches (tenant_id, statement_line_id);

CREATE INDEX IF NOT EXISTS bank_line_matches_document_idx
    ON public.bank_line_matches (tenant_id, matched_kind, matched_id);


-- ============================================================================
-- SECTION 4 · 🔴🔴🔴 THE ALLOCATION GUARD, IN THE DATABASE
-- ============================================================================
-- ⭐ A TRIGGER RATHER THAN AN APPLICATION CHECK ALONE, for the same reason
--    `0102` gives about the reconciliation lock and `0073` about the period
--    lock: the application is not the only thing that will ever write to
--    `bank_line_matches`. An import, a support fix, a future API route and a
--    migration are all callers, and a rule that lives only in the code path
--    somebody remembered is a rule with a hole in it.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ THE NAME SORTS AFTER `ordence_guard_reconciled_bank_line`, ON PURPOSE
-- ══════════════════════════════════════════════════════════════════════════
-- PostgreSQL fires BEFORE triggers in NAME ORDER. `..._reconciled_bank_line`
-- sorts before `..._summed_bank_allocation`, so when a write is both inside a
-- signed period AND over-allocated, the operator is told about the LOCK first.
-- That is the right answer: if the month is sealed, how the allocation adds up
-- is not the thing they need to fix.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 THE CASCADE PROBLEM, AND THE SAME EXEMPTION-BY-SHAPE `0102` USED
-- ══════════════════════════════════════════════════════════════════════════
-- This fires on INSERT and UPDATE only, never DELETE, so a cascade from
-- `tenants` cannot reach it at all. Removing an allocation can never break a
-- sum bound: `≤` stays true when a term is taken away.
-- ============================================================================

CREATE OR REPLACE FUNCTION ordence_guard_summed_bank_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    line_amount    bigint;
    line_date      date;
    allocated_line bigint;
    doc_amount     bigint;
    allocated_doc  bigint;
BEGIN
    SELECT l.amount_minor, l.value_date
      INTO line_amount, line_date
      FROM bank_statement_lines l
     WHERE l.id = NEW.statement_line_id;

    -- ⚠️ NO LINE, NO OPINION. The foreign key is what refuses a match to a
    --    line that does not exist; duplicating that here would produce a
    --    second, worse error message for the same fault.
    IF line_amount IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.allocated_minor = 0 THEN
        RAISE EXCEPTION
            'An allocation of zero explains nothing. Remove the match instead of setting it to zero: a match row that accounts for no money still looks like an explanation on every screen that counts rows.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- 🔴 THE SIGN. An allocation pointing the other way from the line would
    --    let two rows cancel to nothing while both claim to explain money that
    --    actually moved, which is the arithmetic form of a false balance.
    IF sign(NEW.allocated_minor) <> sign(line_amount) THEN
        RAISE EXCEPTION
            'That bank line dated % % money, so an allocation against it has to do the same. An allocation in the other direction lets two rows cancel to nothing while both claim to explain money that moved.',
            line_date,
            CASE WHEN line_amount > 0 THEN 'brought in' ELSE 'took out' END
            USING ERRCODE = 'check_violation';
    END IF;

    -- ⭐ A JOURNAL WRITTEN UP FROM A LINE EXPLAINS ALL OF IT AND IS THE ONLY
    --   THING ON IT. `postBankLineAdjustment` builds the journal FROM the
    --   line for the line's amount, so a partial allocation against one would
    --   leave a residue on the BRS that no document can ever close: a journal
    --   cannot be topped up, only reversed.
    IF NEW.matched_kind = 'journal_entry' AND NEW.allocated_minor <> line_amount THEN
        RAISE EXCEPTION
            'A journal written up from a bank statement line is for the whole line by construction, so it cannot be allocated in part. If only part of this line is a bank charge, the rest is a document somewhere else and belongs matched to that document.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- ── BOUND ①: THE LINE ──────────────────────────────────────────────────
    --
    -- ⚠️ `NEW.id` IS EXCLUDED SO THAT AN UPDATE COUNTS ITS OWN ROW ONCE. On
    --    INSERT the row is not yet visible and the exclusion is harmless; on
    --    UPDATE, counting the stored value AND the new one would refuse the
    --    one change somebody makes after getting it wrong — shrinking it.
    SELECT COALESCE(sum(m.allocated_minor), 0)
      INTO allocated_line
      FROM bank_line_matches m
     WHERE m.statement_line_id = NEW.statement_line_id
       AND m.id <> NEW.id;

    IF abs(allocated_line + NEW.allocated_minor) > abs(line_amount) THEN
        RAISE EXCEPTION
            'The bank line dated % is % paise and % paise of it is already allocated, so % paise are left. Allocating % paise would explain more money than actually moved, and a statement line that is over-explained makes the reconciliation balance while being false: the same rupees are counted on both sides.',
            line_date, abs(line_amount), abs(allocated_line),
            abs(line_amount) - abs(allocated_line), abs(NEW.allocated_minor)
            USING ERRCODE = 'check_violation';
    END IF;

    -- ── BOUND ②: THE DOCUMENT ──────────────────────────────────────────────
    --
    -- 🔴 THIS IS THE BOUND THE OLD `bank_line_matches_one_per_document` INDEX
    --    WAS CARRYING. Without it a ₹10,000 receipt could be allocated in full
    --    to a January line and in full again to a February one, and each line
    --    on its own would balance.
    --
    -- ⚠️ THE SIGN CONVENTION IS COPIED FROM `loadCandidates` AND MUST STAY
    --    IDENTICAL: a customer receipt is positive, a vendor payment is
    --    NEGATED. That single minus sign is the easiest thing in this module
    --    to get wrong, and getting it wrong here would refuse every vendor
    --    payment allocation while every one of them looked correct.
    --
    -- ⚠️ A DOCUMENT THAT CANNOT BE FOUND GETS NO OPINION rather than a
    --    refusal. During a cascade the document may already be gone, and a
    --    guard that raises then would make deleting a tenant impossible — the
    --    same self-limiting shape `0102` relies on.
    doc_amount := NULL;

    IF NEW.matched_kind = 'customer_receipt' THEN
        SELECT r.amount_minor INTO doc_amount
          FROM customer_receipts r WHERE r.id = NEW.matched_id;
    ELSIF NEW.matched_kind = 'vendor_payment' THEN
        SELECT -p.net_minor INTO doc_amount
          FROM vendor_payments p WHERE p.id = NEW.matched_id;
    END IF;

    IF doc_amount IS NOT NULL AND doc_amount <> 0 THEN
        SELECT COALESCE(sum(m.allocated_minor), 0)
          INTO allocated_doc
          FROM bank_line_matches m
         WHERE m.matched_kind = NEW.matched_kind
           AND m.matched_id   = NEW.matched_id
           AND m.id <> NEW.id;

        IF abs(allocated_doc + NEW.allocated_minor) > abs(doc_amount) THEN
            RAISE EXCEPTION
                'That % is % paise and % paise of it is already allocated to bank lines, so % paise are left. Allocating % paise would mean the document has been settled more than once as far as the books are concerned, and the extra payment has nowhere to sit.',
                replace(NEW.matched_kind, '_', ' '), abs(doc_amount),
                abs(allocated_doc), abs(doc_amount) - abs(allocated_doc),
                abs(NEW.allocated_minor)
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION ordence_guard_summed_bank_allocation() IS
    'Refuses any INSERT or UPDATE on bank_line_matches that would allocate '
    'more than a statement line moved, or more than a document is worth, or '
    'in the wrong direction, or nothing at all. Mirrors allocationRefusal in '
    'lib/banking/allocation.ts, which produces the sentence a person reads; '
    'this makes the rule true for the import and the API route nobody has '
    'written yet. Never fires on DELETE: removing a term cannot break a <=.';

DROP TRIGGER IF EXISTS ordence_guard_summed_bank_allocation ON public.bank_line_matches;
CREATE TRIGGER ordence_guard_summed_bank_allocation
    BEFORE INSERT OR UPDATE ON public.bank_line_matches
    FOR EACH ROW EXECUTE FUNCTION ordence_guard_summed_bank_allocation();


-- ============================================================================
-- SECTION 5 · `bank_charge_itc_deferrals` · THE CREDIT NOBODY WAS TOLD ABOUT
-- ============================================================================
-- The argument for the shape is in this file's header and in
-- `lib/banking/bank-charge-itc.ts`. The constraints are the part that make it
-- true rather than intended.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bank_charge_itc_deferrals (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES public.tenants(id)             ON DELETE CASCADE,
    bank_account_id        uuid NOT NULL REFERENCES public.bank_accounts(id)       ON DELETE CASCADE,
    statement_line_id      uuid NOT NULL REFERENCES public.bank_statement_lines(id) ON DELETE CASCADE,

    -- 🔴 NOT A FOREIGN KEY, for the same reason
    --    `bank_reconciliation_items.source_id` is not one: this points at the
    --    posted transaction and the register has to survive whatever happens
    --    to it. A cascade here would delete the evidence that a credit was
    --    ever deferred.
    transaction_id         uuid,

    -- ⚠️ POSITIVE MAGNITUDE IN PAISE. A bank charge is negative on the
    --    statement line; `postBankLineAdjustment` already turns it into a
    --    magnitude before posting, and keeping the same convention here makes
    --    the footing CHECK below a plain sum rather than a sign puzzle.
    gross_minor            bigint NOT NULL,

    value_date             date NOT NULL,

    -- ⚠️ `YYYY-MM`, FROM `value_date` AND NEVER FROM TODAY. A March charge
    --    found in June belongs in March's return, which is both correct and
    --    the thing that makes the period lock mean something.
    tax_period             varchar(7) NOT NULL,

    -- awaiting_invoice · invoice_recorded · not_claimable
    status                 varchar(20) NOT NULL DEFAULT 'awaiting_invoice',

    invoice_no             varchar(100),
    invoice_date           date,
    supplier_gstin         varchar(15),
    taxable_value_minor    bigint,
    cgst_minor             bigint,
    sgst_minor             bigint,
    igst_minor             bigint,
    cess_minor             bigint,

    not_claimable_reason   text,

    created_at             timestamptz NOT NULL DEFAULT now(),
    resolved_at            timestamptz,
    resolved_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT bank_charge_itc_deferrals_status_known
        CHECK (status IN ('awaiting_invoice', 'invoice_recorded', 'not_claimable')),

    CONSTRAINT bank_charge_itc_deferrals_gross_positive
        CHECK (gross_minor > 0),

    CONSTRAINT bank_charge_itc_deferrals_period_shape
        CHECK (tax_period ~ '^\d{4}-\d{2}$'),

    -- ⭐ AN INVOICE IS FOUR THINGS OR IT IS NOTHING. A recorded status with a
    --   missing GSTIN is a claim that cannot be matched in GSTR-2B, which is
    --   the same as no claim with more confidence attached.
    CONSTRAINT bank_charge_itc_deferrals_invoice_complete
        CHECK (status <> 'invoice_recorded'
               OR (invoice_no IS NOT NULL
                   AND invoice_date IS NOT NULL
                   AND supplier_gstin IS NOT NULL
                   AND taxable_value_minor IS NOT NULL
                   AND cgst_minor IS NOT NULL
                   AND sgst_minor IS NOT NULL
                   AND igst_minor IS NOT NULL
                   AND cess_minor IS NOT NULL)),

    -- 🔴🔴🔴 THE CONSTRAINT THAT REFUSES A GUESSED RATE.
    --
    -- ⚠️ A transcribed invoice foots to the money that actually left the
    --    account. An assumed 18% on a charge that was partly exempt does not.
    --    This is the whole reason the split is never derived, never
    --    configured and never defaulted anywhere in this module: the
    --    arithmetic here is what tells a read figure from an invented one.
    CONSTRAINT bank_charge_itc_deferrals_invoice_foots
        CHECK (status <> 'invoice_recorded'
               OR taxable_value_minor + cgst_minor + sgst_minor
                  + igst_minor + cess_minor = gross_minor),

    -- ⚠️ CGST AND SGST ARE TWO HALVES OF ONE RATE. A difference between them
    --    is a transcription error, never something a bank charged.
    CONSTRAINT bank_charge_itc_deferrals_cgst_equals_sgst
        CHECK (status <> 'invoice_recorded' OR cgst_minor = sgst_minor),

    -- 🔴 ONE SUPPLY CARRIES IGST OR CGST+SGST, NEVER BOTH. This is a
    --    TRANSCRIPTION check and not a determination: which applies is
    --    decided by the bank under s.12(12) IGST Act and printed on the
    --    invoice. Nothing in Ordence decides it here.
    CONSTRAINT bank_charge_itc_deferrals_one_tax_regime
        CHECK (status <> 'invoice_recorded'
               OR igst_minor = 0
               OR (cgst_minor = 0 AND sgst_minor = 0)),

    CONSTRAINT bank_charge_itc_deferrals_heads_not_negative
        CHECK (status <> 'invoice_recorded'
               OR (taxable_value_minor >= 0 AND cgst_minor >= 0
                   AND sgst_minor >= 0 AND igst_minor >= 0 AND cess_minor >= 0)),

    -- ⚠️ "WE ARE NOT CLAIMING THIS" WITH NO REASON IS INDISTINGUISHABLE FROM
    --    AN OVERSIGHT SIX MONTHS LATER, which is when somebody asks.
    CONSTRAINT bank_charge_itc_deferrals_refusal_needs_reason
        CHECK (status <> 'not_claimable' OR not_claimable_reason IS NOT NULL)
);

COMMENT ON TABLE public.bank_charge_itc_deferrals IS
    'The input tax credit on a bank charge, which 0102 posted gross and left '
    'to be claimed by hand from an invoice nothing recorded. One row per '
    'charge. The split is never derived from a rate: s.16(2)(a) CGST Act '
    'gives no credit without the invoice in hand, s.16(2)(aa) with Rule 36(4) '
    'wants it in GSTR-2B, and s.12(12) IGST Act can make it IGST rather than '
    'CGST+SGST. It is transcribed from the bank''s invoice and must foot to '
    'the money that left the account.';

COMMENT ON COLUMN public.bank_charge_itc_deferrals.status IS
    'awaiting_invoice: posted gross, credit unclaimed, nobody has said why — '
    'counted and shown per tax period. invoice_recorded: the bank''s invoice '
    'is entered and the credit is a known amount. not_claimable: somebody '
    'decided, with a reason. The status decides which of three totals the row '
    'lands in, and the three carry three different instructions.';

CREATE UNIQUE INDEX IF NOT EXISTS bank_charge_itc_deferrals_line_unique
    ON public.bank_charge_itc_deferrals (tenant_id, statement_line_id);

CREATE INDEX IF NOT EXISTS bank_charge_itc_deferrals_period_idx
    ON public.bank_charge_itc_deferrals (tenant_id, tax_period, status);


-- ============================================================================
-- SECTION 6 · ROW LEVEL SECURITY ON THE NEW TABLE
-- ============================================================================
-- 🔴 IT CARRIES tenant_id, SO check-rls-coverage REQUIRES ENABLE, FORCE, and a
--    policy whose USING names app_current_tenant_id(). Shape copied from
--    `0096_advances_loans_and_reimbursements.sql`.
--
-- ⚠️ FORCE MATTERS MORE THAN ENABLE. Plain ENABLE does not apply to the table
--    OWNER, and a migration runs as the owner. FORCE exists precisely so the
--    owner is not exempt — without it the isolation is a comment, not a
--    control.
--
-- ⚠️ AND THERE IS NO `app_platform_scope()` ANYWHERE IN THIS POLICY, not even
--    in USING. This register holds a tenant's tax position. Support reading it
--    to answer a question is imaginable; support being able to do so by
--    default is a standing window onto every customer's GST exposure, and
--    `bank_reconciliations` set the precedent that this module keeps its
--    platform surface at zero on the write side. Here it is zero on both,
--    which is the narrower and therefore the safer default. Widening it later
--    is one line and a decision; narrowing it later is a migration nobody
--    writes.
-- ============================================================================

ALTER TABLE public.bank_charge_itc_deferrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_charge_itc_deferrals FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_charge_itc_deferrals_tenant_isolation
    ON public.bank_charge_itc_deferrals;
CREATE POLICY bank_charge_itc_deferrals_tenant_isolation
    ON public.bank_charge_itc_deferrals
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 7 · F3 · `bank_reconciliations.statement_id` — THE SHAPE THAT GETS
--             BOTH, AND IT IS THE ONE `0102` ALREADY INVENTED
-- ============================================================================
-- `0102:217-224` says this plainly and then does not act on it:
--
--     "statement_id IS ON DELETE CASCADE AND IT IS A COMPROMISE WORTH NAMING.
--      RESTRICT is what this relationship deserves ... but the chain from
--      `tenants` is CASCADE all the way down, so a RESTRICT here would make
--      deleting a tenant impossible."
--
-- ⭐ THAT IS TRUE OF A FOREIGN KEY AND NOT TRUE OF A TRIGGER, and `0102`
--    already demonstrates the technique two sections later. Its
--    `ordence_guard_reconciled_bank_line` refuses a real `unmatch` and
--    silently permits a cascade, with no exception list, because of WHAT IT
--    READS: during a cascade the parent is already gone, the lookup finds
--    nothing, and the delete proceeds.
--
-- 🔴 SO THE FK STAYS CASCADE AND A BEFORE DELETE TRIGGER REFUSES THE ROW.
--    Deleting a tenant still works; deleting a reconciled statement while its
--    tenant is alive does not.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ THE ANCHOR IS `tenants` AND THE CHOICE MATTERS
-- ══════════════════════════════════════════════════════════════════════════
-- `bank_statements` and `bank_accounts` BOTH reference `tenants` directly, and
-- PostgreSQL does not promise an order between two referencing tables in one
-- cascade. Anchoring on `bank_accounts` would work or not depending on which
-- constraint fired first — a guard that is correct by luck.
--
-- ⭐ `tenants` IS DIFFERENT: it is the row being deleted, so it is gone before
--    any cascade runs. Reading it is a reliable "is this a tenant deletion".
--
-- ⚠️ AND THIS ALSO REFUSES DELETING A BANK ACCOUNT THAT HAS SIGNED
--    RECONCILIATIONS, which is correct and was not previously refused
--    anywhere. Nothing in the tree deletes one today, which is exactly why
--    this is cheap to add and worth adding: the writer who adds that path
--    will not be reading this module.
--
-- 🔴 BOTH BRANCHES ARE EXERCISED IN `DRILL-DO-NOT-RUN-IN-NEON-0110.sql`,
--    against a throwaway PostgreSQL, as a non-superuser. A verify that has
--    only ever been run on the passing case is not a verify.
-- ============================================================================

CREATE OR REPLACE FUNCTION ordence_guard_reconciled_statement_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    signed_to date;
BEGIN
    -- ⭐ THE EXEMPTION IS THE SHAPE OF THE QUERY, NOT A SPECIAL CASE. If the
    --   tenant row is gone, this is a tenant deletion and the statement is
    --   supposed to go with it.
    IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = OLD.tenant_id) THEN
        RETURN OLD;
    END IF;

    SELECT r.reconciled_to INTO signed_to
      FROM bank_reconciliations r
     WHERE r.statement_id = OLD.id
       AND r.status = 'signed_off'
     ORDER BY r.reconciled_to DESC
     LIMIT 1;

    IF signed_to IS NOT NULL THEN
        RAISE EXCEPTION
            'That bank statement is the evidence behind a reconciliation signed off to %. Deleting it would leave a signed statement whose figures cannot be reproduced from the data behind them. Reopen that reconciliation with a reason first; the reopen is recorded and deleting the statement quietly is not.',
            signed_to
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN OLD;
END;
$fn$;

COMMENT ON FUNCTION ordence_guard_reconciled_statement_delete() IS
    'Refuses deletion of a bank statement that a signed-off reconciliation '
    'was drawn against. Gets what RESTRICT would give without breaking tenant '
    'deletion: the guard reads the tenants row, which is already gone during '
    'a cascade, so the exemption is the shape of the query rather than an '
    'exception list. Closes the compromise 0102 named and did not act on.';

DROP TRIGGER IF EXISTS ordence_guard_reconciled_statement_delete
    ON public.bank_statements;
CREATE TRIGGER ordence_guard_reconciled_statement_delete
    BEFORE DELETE ON public.bank_statements
    FOR EACH ROW EXECUTE FUNCTION ordence_guard_reconciled_statement_delete();


-- ============================================================================
-- SECTION 8 · GRANTS
-- ============================================================================
-- ⚠️ NOTHING IS WIDENED ON `bank_line_matches`. `0087` gave it SELECT, INSERT
--    and `0102` added DELETE. Changing an allocation is a DELETE followed by
--    an INSERT inside one transaction — which is what `unmatch` then
--    `confirmMatch` already are — so UPDATE is not needed and is not granted.
--    A privilege granted "because an edit is obviously an UPDATE" is a
--    privilege nothing in the tree uses and everything in the tree could.
--
-- ⭐ THE REGISTER TAKES SELECT, INSERT AND UPDATE. It is written when a charge
--    is posted and UPDATEd exactly twice in its life at most: once to record
--    an invoice, once to mark it not claimable. NO DELETE: the row is the
--    evidence that a credit was deferred, and a register somebody can empty
--    is not a register.
-- ============================================================================

DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        GRANT SELECT, INSERT, UPDATE ON public.bank_charge_itc_deferrals TO ordence_app;
    END IF;
END;
$grants$;


-- ============================================================================
-- SECTION 9 · VERIFICATION · READ ONLY · RUN THIS LAST AND READ IT
-- ============================================================================
-- ⚠️ EVERY BOOLEAN SHOULD READ true AND `match_rows_without_an_allocation`
--    SHOULD READ 0. A false in `allocation_guard_installed` means one receipt
--    can now be spread across two lines with nothing counting the total, which
--    is strictly worse than the 1:1 restriction this file removed.
--
-- 🔴 `lock_trigger_still_enabled` IS THE ONE TO READ TWICE. Section 2 step ③
--    suspends `ordence_guard_reconciled_bank_line` for one statement. It
--    restores it in the same statement and asserts it before finishing, so
--    this can only read false if something very strange happened — and that is
--    exactly why it is printed rather than assumed.
-- ============================================================================

-- ⚠️ THE SAME `scope` CTE AS SECTION 1, FOR THE SAME REASON. The row count
--    below reads a FORCE-RLS table, and without platform scope it returns 0
--    on every database — a verification that always passes. `set_config` is
--    VOLATILE, so PostgreSQL will not inline the CTE and it is evaluated
--    before the target list that references it.
WITH scope AS (
    SELECT set_config('app.platform_scope', 'on', true) AS enabled
)
SELECT
    '0110 · verification'                                          AS finding,

    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'bank_line_matches'
               AND column_name = 'allocated_minor'
               AND is_nullable = 'NO')                             AS allocated_minor_present_and_not_null,

    (SELECT (xpath('/row/c/text()', query_to_xml(
        CASE WHEN to_regclass('public.bank_line_matches') IS NULL
                  OR scope.enabled <> 'on'
             THEN 'SELECT -1 AS c'
             ELSE 'SELECT count(*) AS c FROM public.bank_line_matches
                    WHERE allocated_minor IS NULL'
        END, false, true, '')))[1]::text)                          AS match_rows_without_an_allocation,

    NOT EXISTS (SELECT 1 FROM pg_class
                 WHERE relname = 'bank_line_matches_one_per_line') AS old_one_per_line_index_gone,
    NOT EXISTS (SELECT 1 FROM pg_class
                 WHERE relname = 'bank_line_matches_one_per_document') AS old_one_per_document_index_gone,
    EXISTS (SELECT 1 FROM pg_class
             WHERE relname = 'bank_line_matches_one_row_per_pair')  AS pair_index_present,

    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgname = 'ordence_guard_summed_bank_allocation'
               AND NOT tgisinternal)                               AS allocation_guard_installed,

    -- 🔴 PRESENCE AND STATE. `ALTER TABLE ... DISABLE TRIGGER` leaves a
    --    trigger that exists and does nothing, and no other trace.
    COALESCE((SELECT tgenabled = 'O' FROM pg_trigger
               WHERE tgname = 'ordence_guard_reconciled_bank_line'
                 AND NOT tgisinternal), false)                     AS lock_trigger_still_enabled,

    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgname = 'ordence_guard_reconciled_statement_delete'
               AND NOT tgisinternal)                               AS statement_delete_guard_installed,

    to_regclass('public.bank_charge_itc_deferrals') IS NOT NULL    AS itc_register_present,

    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'bank_charge_itc_deferrals')               AS itc_policies_present,

    COALESCE((SELECT c.relrowsecurity AND c.relforcerowsecurity
                FROM pg_class c
               WHERE c.relname = 'bank_charge_itc_deferrals'), false)
                                                                   AS itc_rls_enabled_and_forced,

    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = to_regclass('public.bank_charge_itc_deferrals')
        AND contype = 'c')                                         AS itc_check_constraints
FROM scope;
