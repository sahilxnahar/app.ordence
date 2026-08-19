-- ############################################################################
-- 0102 · THE BANK RECONCILIATION STATEMENT, AND THE LOCK THAT WAS NEVER READ
-- ############################################################################
--
-- PURPOSE
-- -------
-- 0070 built bank statement import and manual, line-by-line MATCHING. It did
-- not build RECONCILING, and the two are not the same act.
--
-- ⭐ MATCHING pairs a bank line with a document. It is the INPUT.
--
-- ⭐⭐ RECONCILING is the statement an auditor asks for — balance as per the
--    bank, less cheques issued but not presented, add deposits not yet
--    credited, add bank charges the books do not have, less interest credited,
--    equals balance as per books — and the act of SAYING SO, on a date, by a
--    person, after which the months beneath it stop moving.
--
-- ############################################################################
-- 🔴🔴 `bank_accounts.reconciled_to` WAS THE EIGHTH FIELD IN THIS PRODUCT
--      DECLARED AND ENFORCED BY NOTHING
-- ############################################################################
--
-- It has existed since 0070. `db/schema/banking.ts` describes it as "everything
-- on or before this date has been explained". `getBankAccounts()` reads it and
-- the banking screen prints it.
--
-- ⚠️ AND THE ONLY WRITE TO IT IN THE WHOLE TREE WAS `reconciledTo: null` AT
--    ACCOUNT CREATION. Nothing ever set it, and nothing ever consulted it.
--    `unmatch()` deleted any confirmed match, at any date, with one click.
--
-- 🔴 THAT IS THE SHAPE THIS CODEBASE KEEPS PRODUCING: `valuation_method`
--    stored and read at zero computations; `require_mfa` stored and never
--    checked; 34 of 71 entitlement keys never gated; dunning letters queued
--    and never sent. A lock of that kind is WORSE than no lock, because it
--    looks like control.
--
-- ⭐ SO THIS FILE'S CENTRE IS SECTION 5: A TRIGGER THAT REFUSES. Not a column,
--    not a comment, not a check somewhere in TypeScript. The application half
--    (`server/banking/reconciliation-service.ts` → `lineLockState`, called by
--    `confirmMatch`, `unmatch` and `postBankLineAdjustment`) produces a
--    SENTENCE a person can act on. The trigger makes the rule TRUE for the
--    import, the support fix and the API route nobody has written yet. Same
--    doctrine, and the same two halves, as `ordence_guard_closed_period` in
--    0073.
--
-- ############################################################################
-- 🔴 WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ############################################################################
--
-- ⚠️ IT DOES NOT RELAX `bank_line_matches_one_per_line` OR
--    `bank_line_matches_one_per_document`. Those two unique indexes make a
--    match strictly one-to-one, so one bank credit against three invoices —
--    which is ordinary — cannot be recorded today. That is a REAL limitation
--    and it is stated here rather than half-fixed: representing many-to-many
--    correctly needs an allocated amount per match row and a constraint that
--    the allocations sum to the line, and dropping the unique indexes without
--    that would let one receipt explain two statement lines. 0070's own
--    comment is right about why: "the residue still comes out to zero because
--    the same rupees were counted on both sides."
--
-- ⚠️ IT DOES NOT SPLIT GST OUT OF A BANK CHARGE. A statement line is one gross
--    figure with no GSTIN, no invoice number and no rate on it. The input
--    credit is claimed from the bank's own tax invoice; deriving it from this
--    line would put an unsupported claim in GSTR-3B.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Same reason as 0092 through 0099. Migrations here are PASTED INTO THE NEON
-- BROWSER CONSOLE, which sends each statement on its own connection. `BEGIN`
-- buys no atomicity across that boundary; it only makes a half-applied file
-- look like a clean one, which is exactly how 0091 applied half-way while
-- reporting success. `SET LOCAL app.platform_scope` reports "executed
-- successfully" and has evaporated by the time the next statement runs.
--
-- ⭐ EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT — ADD COLUMN IF NOT
--    EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, DROP
--    POLICY IF EXISTS before CREATE POLICY, DROP TRIGGER IF EXISTS before
--    CREATE TRIGGER — and the file is safe to re-run from the top after a
--    failure at any point.
--
-- ⭐ AND THERE IS NO DML AT ALL. Nothing below writes a row, so nothing below
--    can be refused by a FORCE ROW LEVEL SECURITY policy — the failure mode
--    0091 and 0092 both hit. No backfill is needed: `reconciled_to` is null on
--    every existing account, which correctly means nothing is reconciled yet,
--    and `import_digest` is null on every historic statement because nobody
--    kept the file it came from and inventing a digest would be inventing
--    evidence.
--
-- RUN ORDER: after 0101. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If a later section refuses, this row is still on your screen and still tells
-- you what was there before you started.
--
-- ⚠️ `query_to_xml` RATHER THAN A `CASE`. The planner resolves both branches of
--    a CASE before the guard runs, so `CASE WHEN to_regclass(...) IS NOT NULL
--    THEN (SELECT count(*) FROM that_table) END` fails to PARSE when the table
--    does not exist. This form evaluates the text only when the guard passes.
-- ============================================================================

SELECT
    '0102 · diagnostic'                                        AS finding,
    current_user                                               AS running_as,
    to_regclass('public.bank_accounts')        IS NOT NULL     AS bank_accounts_present,
    to_regclass('public.bank_line_matches')    IS NOT NULL     AS matches_present,
    to_regclass('public.bank_reconciliations') IS NOT NULL     AS reconciliations_already_present,
    (SELECT (xpath('/row/c/text()',
                   query_to_xml('SELECT count(*) AS c FROM public.bank_accounts
                                  WHERE reconciled_to IS NOT NULL',
                                false, true, '')))[1]::text
       WHERE to_regclass('public.bank_accounts') IS NOT NULL)  AS accounts_with_a_lock_date_today,
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgname = 'ordence_guard_reconciled_bank_line'
               AND NOT tgisinternal)                           AS lock_trigger_already_installed;


-- ============================================================================
-- SECTION 2 · TWO COLUMNS ON TABLES THAT ALREADY EXIST
-- ============================================================================
-- ⚠️ CHECKED FOR EXISTING TRIGGERS FIRST. `bank_accounts`, `bank_statements`,
--    `bank_statement_lines` and `bank_line_matches` carry NO triggers today —
--    0070 created only `ordence_guard_posted_count`, and that is on
--    `stock_count_lines`. So nothing pre-existing can overwrite what is
--    written here, which is the failure `ordence_validate_stock_movement`
--    produced in the previous batch.
-- ============================================================================

-- 🔴🔴 THE TOLERANCE. ZERO ON EVERY ACCOUNT UNLESS A HUMAN SETS IT.
--
-- A reconciliation that "balances" because of a rounding tolerance is a
-- reconciliation that does not balance. This exists because a small number of
-- real accounts carry a permanent paise-level difference from a historic
-- conversion, and the alternative to a configured, per-account, RECORDED
-- allowance is somebody posting a fake journal to make the screen go green.
--
-- ⭐ `lib/banking/reconciliation.ts` → `buildBrs()` READS THIS AT THE
--    COMPARISON, and whatever it lets through is written onto the
--    reconciliation row as `difference_absorbed_minor` and stays there. The
--    tolerance decides whether somebody may SIGN. It never decides whether the
--    account reconciled.
ALTER TABLE public.bank_accounts
    ADD COLUMN IF NOT EXISTS reconciliation_tolerance_minor bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.bank_accounts.reconciliation_tolerance_minor IS
    'Paise of difference this account may be signed off with. Zero by default. '
    'Read at the comparison in lib/banking/reconciliation.ts; anything it '
    'absorbs is recorded on the reconciliation as difference_absorbed_minor. '
    'Permission to sign, never evidence that the account balanced.';

-- ⚠️ A CHECK, BECAUSE A TOLERANCE LARGE ENOUGH TO HIDE A TRANSACTION IS NOT A
--    TOLERANCE. ₹100 in paise. A bank charge is more than a hundred rupees, so
--    nothing this is meant to absorb can hide one. The server action refuses
--    above this too; the constraint is what makes it true for the SQL console.
DO $tol$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'bank_accounts_tolerance_sane'
           AND conrelid = 'public.bank_accounts'::regclass
    ) THEN
        ALTER TABLE public.bank_accounts
            ADD CONSTRAINT bank_accounts_tolerance_sane
            CHECK (reconciliation_tolerance_minor >= 0
                   AND reconciliation_tolerance_minor <= 10000);
    END IF;
END;
$tol$;

-- ⭐⭐ THE WHOLE-FILE DUPLICATE GUARD.
--
-- ⚠️ `bank_statement_lines.fingerprint` catches a LINE that resembles a stored
--    line and deliberately only WARNS, because two identical payments on one
--    day are real. That was the only guard there was, so re-importing January
--    warned and then wrote every January line a second time — the account then
--    reads out by exactly the month's turnover with nothing saying why.
--
-- 🔴 A WHOLE FILE IMPORTED TWICE IS A DIFFERENT CLAIM AND CAN BE REFUSED
--    OUTRIGHT. The digest covers the account, the period, both balances and
--    every line fingerprint IN ORDER, so the only thing it collides with is
--    the same export imported again.
--
-- ⚠️ NULLABLE, and NULLs are distinct in a Postgres unique index, so every
--    statement imported before 0102 neither collides nor blocks.
ALTER TABLE public.bank_statements
    ADD COLUMN IF NOT EXISTS import_digest varchar(64);

COMMENT ON COLUMN public.bank_statements.import_digest IS
    'SHA-256 over the account, period, both balances and every line '
    'fingerprint in order. See lib/banking/statement-digest.ts. Null on '
    'statements imported before 0102: the file they came from was not kept and '
    'inventing a digest would be inventing evidence.';

CREATE UNIQUE INDEX IF NOT EXISTS bank_statements_import_digest_unique
    ON public.bank_statements (tenant_id, bank_account_id, import_digest);


-- ============================================================================
-- SECTION 3 · `bank_reconciliations` · THE ARTEFACT
-- ============================================================================
-- 🔴 EVERY FIGURE IS FROZEN ONTO THIS ROW. The reconciliation is NOT
--    re-derived when somebody opens it later, and that is the entire point: a
--    March statement re-derived in September shows whatever March looks like
--    in September, and a signature on a document that changes is a signature
--    on nothing.
--
-- ⚠️ MONEY IS bigint PAISE. Never a float, never a rupee, never numeric here —
--    0070 set bigint for this module and two money types in one module is how
--    a sum silently rounds.
--
-- ⚠️ statement_id IS ON DELETE CASCADE AND IT IS A COMPROMISE WORTH NAMING.
--    RESTRICT is what this relationship deserves — a statement that has been
--    reconciled should not be deletable — but the chain from `tenants` is
--    CASCADE all the way down, so a RESTRICT here would make deleting a tenant
--    impossible, and the first person to hit that would drop the constraint
--    rather than the row. Nothing in the tree deletes a statement. The
--    protection that matters is the trigger in section 5, which refuses the
--    CHANGE rather than the row.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bank_reconciliations (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid NOT NULL REFERENCES public.tenants(id)        ON DELETE CASCADE,
    bank_account_id             uuid NOT NULL REFERENCES public.bank_accounts(id)  ON DELETE CASCADE,
    statement_id                uuid NOT NULL REFERENCES public.bank_statements(id) ON DELETE CASCADE,

    -- 🔴 THE LOCK BOUNDARY. Everything on or before this date is sealed.
    reconciled_to               date NOT NULL,

    -- ⭐ WHAT `bank_accounts.reconciled_to` WAS BEFORE THIS SIGN-OFF, so a
    --    reopen restores it EXACTLY instead of guessing. Null where this was
    --    the first reconciliation on the account. Neither "null" nor "the
    --    previous month end" is a safe guess: one unlocks every reconciliation
    --    the account has ever had, the other unlocks or re-locks whatever
    --    happens to fall near it.
    previous_reconciled_to      date,

    bank_balance_minor          bigint NOT NULL,
    book_balance_minor          bigint NOT NULL,

    -- ⭐ POSITIVE MAGNITUDES. The direction of each category lives in
    --    CATEGORY_META in lib/banking/reconciliation.ts, in ONE place, rather
    --    than in a sign every renderer has to remember to interpret.
    cheques_not_presented_minor bigint NOT NULL DEFAULT 0,
    deposits_not_credited_minor bigint NOT NULL DEFAULT 0,
    bank_charges_minor          bigint NOT NULL DEFAULT 0,
    direct_credits_minor        bigint NOT NULL DEFAULT 0,

    -- 🔴 book − (bank − cheques + deposits + charges − credits). Zero on a
    --    statement that foots. Signed: positive means the books hold more than
    --    the bank plus the outstanding items can account for.
    difference_minor            bigint NOT NULL DEFAULT 0,

    -- ⚠️ THE TOLERANCE AS IT STOOD AT SIGN-OFF, frozen. Reading today's value
    --    when re-rendering a two-year-old reconciliation would show a
    --    statement signed under different rules from the ones printed on it.
    tolerance_minor             bigint NOT NULL DEFAULT 0,

    -- 🔴🔴 WHAT THE TOLERANCE LET THROUGH, RECORDED SO IT IS NOT SWALLOWED.
    --    Zero on a statement that footed exactly. Non-zero is an account that
    --    did NOT reconcile and was signed anyway, deliberately, and the amount
    --    stays on this row forever.
    difference_absorbed_minor   bigint NOT NULL DEFAULT 0,

    -- signed_off · reopened
    status                      varchar(20) NOT NULL DEFAULT 'signed_off',

    signed_off_at               timestamptz NOT NULL DEFAULT now(),
    signed_off_by               uuid REFERENCES public.users(id) ON DELETE SET NULL,
    note                        text,

    -- ⚠️ Reopening is an exceptional act and must be justified. The row is
    --    KEPT and marked, never deleted: the row is the only evidence that a
    --    figure was ever signed, and deleting it makes the reopen invisible.
    reopened_at                 timestamptz,
    reopened_by                 uuid REFERENCES public.users(id) ON DELETE SET NULL,
    reopen_reason               text,

    CONSTRAINT bank_reconciliations_status_known
        CHECK (status IN ('signed_off', 'reopened')),

    -- 🔴 THE TOLERANCE CANNOT ABSORB MORE THAN IT IS. A row claiming to have
    --    let 500 paise through on a 100-paise tolerance is a row that was
    --    written by something that did not read the tolerance.
    CONSTRAINT bank_reconciliations_absorbed_within_tolerance
        CHECK (abs(difference_absorbed_minor) <= tolerance_minor),

    -- ⚠️ ABSORBED IS EITHER ZERO OR THE WHOLE DIFFERENCE. A partial absorption
    --    would mean part of a difference was explained and part was not, and
    --    nothing anywhere says which part.
    CONSTRAINT bank_reconciliations_absorbed_is_the_difference
        CHECK (difference_absorbed_minor = 0
               OR difference_absorbed_minor = difference_minor),

    CONSTRAINT bank_reconciliations_reopen_needs_reason
        CHECK (status <> 'reopened'
               OR (reopened_at IS NOT NULL AND reopen_reason IS NOT NULL)),

    -- ⚠️ A reconciliation cannot seal a date before the one it restores to.
    CONSTRAINT bank_reconciliations_moves_forward
        CHECK (previous_reconciled_to IS NULL
               OR reconciled_to > previous_reconciled_to)
);

COMMENT ON TABLE public.bank_reconciliations IS
    'The signed bank reconciliation statement. Every figure is frozen at '
    'sign-off and nothing is recomputed on read: a March statement re-derived '
    'in September is whatever March looks like in September, and a signature '
    'on a document that changes is a signature on nothing.';

COMMENT ON COLUMN public.bank_reconciliations.difference_absorbed_minor IS
    'What the account tolerance let through at sign-off. Non-zero means the '
    'account did NOT reconcile and was signed anyway, deliberately. Never '
    'silently swallowed: it is on this row, on the printed statement and on '
    'the audit entry.';

CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliations_id_tenant_key
    ON public.bank_reconciliations (id, tenant_id);

CREATE INDEX IF NOT EXISTS bank_reconciliations_account_idx
    ON public.bank_reconciliations (tenant_id, bank_account_id, reconciled_to DESC);

-- 🔴 ONE LIVE SIGN-OFF PER ACCOUNT PER DATE, AND PARTIAL SO THAT REOPENING A
--    MARCH RECONCILIATION AND SIGNING A CORRECTED ONE IS POSSIBLE — which is
--    the whole reason reopening exists.
CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliations_live_per_date
    ON public.bank_reconciliations (tenant_id, bank_account_id, reconciled_to)
    WHERE status = 'signed_off';


-- ============================================================================
-- SECTION 4 · `bank_reconciliation_items` · THE LINES OF THE STATEMENT
-- ============================================================================
-- ⚠️ A BRS WHOSE TOTALS ARE STORED AND WHOSE LINES ARE RECOMPUTED FOOTS
--    AGAINST NOTHING. Both halves are frozen or neither is.
--
-- 🔴 `source_id` IS NOT A FOREIGN KEY, DELIBERATELY. It points at a bank
--    statement line for a bank-side item and at a receipt or a payment for a
--    book-side item, and the point of freezing them is that the evidence
--    survives whatever happens to the document afterwards. A cascade here
--    would delete the reason a signed figure was what it was.
--
-- ⚠️ `category` IS CONSTRAINED TO THE FOUR STRINGS IN
--    RECONCILIATION_CATEGORIES. It is DERIVED from which side the item is
--    unmatched on and the sign of its amount — never chosen from a dropdown,
--    because a dropdown is a place to put a cheque in the wrong row and still
--    see a statement that foots.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bank_reconciliation_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    reconciliation_id  uuid NOT NULL
        REFERENCES public.bank_reconciliations(id) ON DELETE CASCADE,

    category           varchar(40) NOT NULL,
    side               varchar(10) NOT NULL,

    source_id          uuid NOT NULL,
    source_kind        varchar(30),

    occurred_on        date   NOT NULL,
    -- 🔴 SIGNED. Positive is money IN, as everywhere else in this module.
    amount_minor       bigint NOT NULL,
    description        text   NOT NULL,

    CONSTRAINT bank_reconciliation_items_category_known
        CHECK (category IN ('cheque_not_presented',
                            'deposit_not_credited',
                            'bank_charge_not_in_books',
                            'direct_credit_not_in_books')),

    CONSTRAINT bank_reconciliation_items_side_known
        CHECK (side IN ('bank', 'books')),

    -- ⚠️ AN ITEM OF NOTHING IS A PARSING FAILURE, NOT AN OUTSTANDING ITEM.
    CONSTRAINT bank_reconciliation_items_amount_not_zero
        CHECK (amount_minor <> 0),

    -- 🔴🔴 THE CATEGORY IS THE SIDE AND THE SIGN, AND THE DATABASE SAYS SO.
    --    This is the constraint that stops a future writer storing a category
    --    that contradicts the amount, which would produce a statement whose
    --    lines are individually plausible and whose total is wrong.
    CONSTRAINT bank_reconciliation_items_category_matches_sign
        CHECK (
            (side = 'books' AND amount_minor > 0 AND category = 'deposit_not_credited')
         OR (side = 'books' AND amount_minor < 0 AND category = 'cheque_not_presented')
         OR (side = 'bank'  AND amount_minor > 0 AND category = 'direct_credit_not_in_books')
         OR (side = 'bank'  AND amount_minor < 0 AND category = 'bank_charge_not_in_books')
        )
);

COMMENT ON TABLE public.bank_reconciliation_items IS
    'The outstanding items behind one signed reconciliation, frozen. category '
    'is derived from the side and the sign and a CHECK enforces that: a '
    'statement whose lines are individually plausible and whose total is wrong '
    'is the artefact this table exists to prevent.';

CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliation_items_id_tenant_key
    ON public.bank_reconciliation_items (id, tenant_id);

CREATE INDEX IF NOT EXISTS bank_reconciliation_items_parent_idx
    ON public.bank_reconciliation_items (tenant_id, reconciliation_id, category);


-- ============================================================================
-- SECTION 5 · 🔴🔴🔴 THE LOCK, IN THE DATABASE
-- ============================================================================
-- This is the section the file exists for.
--
-- ⭐ A TRIGGER RATHER THAN AN APPLICATION CHECK ALONE, for the same reason
--    0073 gives about the period lock: the application is not the only thing
--    that will ever write to `bank_line_matches`. An import, a support fix, a
--    future API route and a migration are all callers, and a lock that lives
--    only in the code path somebody remembered is a lock with a hole in it.
--
-- ⚠️ IT FIRES ON INSERT, UPDATE **AND** DELETE. Adding a match under a signed
--    date is exactly as destructive as removing one — both move an item off
--    the outstanding list and change the signed statement's arithmetic — and
--    only one of them looks like a deletion. A guard on DELETE alone would be
--    a hole shaped like `confirmMatch`.
--
-- ⚠️ IT CHECKS THE LINE'S `value_date`, NOT `confirmed_at`. The date the money
--    moved is what decides which reconciliation it belongs to. Checking the
--    confirmation time would let somebody match a March-dated line in June and
--    call it fine because June is unreconciled — precisely the move the lock
--    exists to prevent, and precisely the mistake 0073 warns about.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴 THE CASCADE PROBLEM, AND HOW THIS AVOIDS IT
-- ══════════════════════════════════════════════════════════════════════════
-- `bank_line_matches` cascades from `bank_statement_lines`, which cascades
-- from `bank_statements`, which cascades from `bank_accounts`, which cascades
-- from `tenants`. A BEFORE DELETE trigger that raised unconditionally would
-- make DELETING A TENANT IMPOSSIBLE, and the person who hit that would drop
-- the trigger rather than the tenant.
--
-- ⭐ THE GUARD IS SELF-LIMITING BECAUSE OF WHAT IT READS. It looks the lock up
--    THROUGH the statement line and the bank account. During any cascade the
--    parent has already been deleted in the same transaction, the lookup finds
--    nothing, `FOUND` is false, and the delete proceeds. During a real
--    `unmatch` the line and the account are both still there and the lock is
--    read. No special case, no exception list — the shape of the query is the
--    exemption.
-- ============================================================================

CREATE OR REPLACE FUNCTION ordence_guard_reconciled_bank_line()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  line_id       uuid;
  guarded       record;
BEGIN
  -- ⚠️ OLD ON DELETE, NEW OTHERWISE. On an UPDATE that MOVES a match to a
  --    different line, BOTH ends matter; the OLD end is covered because an
  --    UPDATE fires this once with NEW and the row it left is checked by the
  --    second lookup below.
  line_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.statement_line_id
                  ELSE NEW.statement_line_id END;

  SELECT l.value_date, a.reconciled_to, a.label
    INTO guarded
    FROM bank_statement_lines l
    JOIN bank_accounts        a ON a.id = l.bank_account_id
   WHERE l.id = line_id
     AND a.reconciled_to IS NOT NULL
     -- 🔴 `<=`, NOT `<`. "Reconciled to 31 March" INCLUDES 31 March. A lock
     --    excluding its own boundary leaves the last day of every reconciled
     --    month editable, and that is the day the month-end entries are on.
     AND l.value_date <= a.reconciled_to;

  IF FOUND THEN
    RAISE EXCEPTION
      'The bank line dated % is inside a reconciliation signed off to % on account "%". % would change a figure that has already been signed, and the signed statement would no longer be reproducible from the data behind it. Reopen that reconciliation with a reason if the signed figure is genuinely wrong.',
      guarded.value_date, guarded.reconciled_to, guarded.label, TG_OP
      USING ERRCODE = 'check_violation';
  END IF;

  -- ⭐ AN UPDATE THAT MOVES A MATCH OFF A SEALED LINE IS ALSO REFUSED. Without
  --    this, `UPDATE bank_line_matches SET statement_line_id = <open line>`
  --    would empty a reconciled line without ever touching a sealed row on the
  --    NEW side.
  IF TG_OP = 'UPDATE' AND OLD.statement_line_id IS DISTINCT FROM NEW.statement_line_id THEN
    SELECT l.value_date, a.reconciled_to, a.label
      INTO guarded
      FROM bank_statement_lines l
      JOIN bank_accounts        a ON a.id = l.bank_account_id
     WHERE l.id = OLD.statement_line_id
       AND a.reconciled_to IS NOT NULL
       AND l.value_date <= a.reconciled_to;

    IF FOUND THEN
      RAISE EXCEPTION
        'The bank line dated % is inside a reconciliation signed off to % on account "%". Moving its match elsewhere would change a figure that has already been signed.',
        guarded.value_date, guarded.reconciled_to, guarded.label
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

COMMENT ON FUNCTION ordence_guard_reconciled_bank_line() IS
    'Refuses any INSERT, UPDATE or DELETE on bank_line_matches whose statement '
    'line is dated on or before the account''s reconciled_to. Checks the '
    'line''s value_date, never confirmed_at. Silently permits cascades: the '
    'lock is looked up THROUGH the line and the account, both of which are '
    'already gone when a tenant or a statement is being deleted.';

DROP TRIGGER IF EXISTS ordence_guard_reconciled_bank_line ON public.bank_line_matches;
CREATE TRIGGER ordence_guard_reconciled_bank_line
    BEFORE INSERT OR UPDATE OR DELETE ON public.bank_line_matches
    FOR EACH ROW EXECUTE FUNCTION ordence_guard_reconciled_bank_line();

-- ⭐ AND THE SAME GUARD ON THE STATEMENT LINES THEMSELVES.
--
-- ⚠️ NOTHING IN THE TREE EDITS OR DELETES A STATEMENT LINE, AND THAT IS
--    EXACTLY WHY THIS IS CHEAP TO ADD AND WORTH ADDING. A future importer that
--    "corrects" a reconciled month by rewriting its lines would change the
--    bank balance a signed statement was drawn against, and no code review of
--    the banking module would catch it because it would not be in the banking
--    module.
CREATE OR REPLACE FUNCTION ordence_guard_reconciled_statement_line()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  guarded record;
BEGIN
  SELECT a.reconciled_to, a.label
    INTO guarded
    FROM bank_accounts a
   WHERE a.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_account_id
                     ELSE NEW.bank_account_id END
     AND a.reconciled_to IS NOT NULL
     AND CASE WHEN TG_OP = 'DELETE' THEN OLD.value_date ELSE NEW.value_date END
         <= a.reconciled_to;

  IF FOUND THEN
    RAISE EXCEPTION
      'That bank statement line falls inside a reconciliation signed off to % on account "%". % on it would change the bank balance a signed statement was drawn against.',
      guarded.reconciled_to, guarded.label, TG_OP
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

COMMENT ON FUNCTION ordence_guard_reconciled_statement_line() IS
    'Refuses UPDATE or DELETE of a bank statement line dated on or before its '
    'account''s reconciled_to. INSERT is guarded in the application, in '
    'importStatement, because refusing it here would give the operator a '
    'trigger message instead of a sentence naming how many lines and which '
    'dates.';

DROP TRIGGER IF EXISTS ordence_guard_reconciled_statement_line
    ON public.bank_statement_lines;
CREATE TRIGGER ordence_guard_reconciled_statement_line
    BEFORE UPDATE OR DELETE ON public.bank_statement_lines
    FOR EACH ROW EXECUTE FUNCTION ordence_guard_reconciled_statement_line();


-- ============================================================================
-- SECTION 6 · ROW LEVEL SECURITY ON BOTH NEW TABLES
-- ============================================================================
-- 🔴 BOTH CARRY tenant_id, SO check-rls-coverage REQUIRES ENABLE, FORCE, and a
--    policy whose USING names app_current_tenant_id().
--
-- ⚠️ FORCE MATTERS MORE THAN ENABLE. Plain ENABLE does not apply to the table
--    OWNER, and a migration runs as the owner. FORCE exists precisely so the
--    owner is not exempt — without it the isolation is a comment, not a
--    control.
--
-- ⚠️ AND NEITHER IS PLATFORM-WRITABLE. `app_platform_scope()` belongs in
--    USING and never in WITH CHECK: support may READ a tenant's reconciliation
--    to answer a question about it. Support SIGNING a tenant's reconciliation
--    is a different thing entirely, and the two are one keyword apart.
-- ============================================================================

ALTER TABLE public.bank_reconciliations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_reconciliations       FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_reconciliations_tenant ON public.bank_reconciliations;
CREATE POLICY bank_reconciliations_tenant ON public.bank_reconciliations
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.bank_reconciliation_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_reconciliation_items  FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_reconciliation_items_tenant ON public.bank_reconciliation_items;
CREATE POLICY bank_reconciliation_items_tenant ON public.bank_reconciliation_items
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 7 · GRANTS · AND A DEFECT IN 0087 THIS FILE HAS TO CORRECT
-- ============================================================================
-- 🔴🔴 `unmatch()` HAS NEVER BEEN ABLE TO RUN AS `ordence_app`.
--
-- 0087 narrowed the banking grants and gave `bank_line_matches` only
-- SELECT, INSERT. Its comment says:
--
--     "Matches are append-only reconciliation evidence; the guard trigger
--      fires for UPDATE/DELETE regardless, and the privilege layer is the
--      belt to its braces."
--
-- ⚠️ THERE WAS NO SUCH TRIGGER. 0070 created exactly one trigger and it is
--    `ordence_guard_posted_count` on `stock_count_lines`. The comment
--    described a guard that did not exist, and meanwhile
--    `server/actions/banking.ts` exposes `unmatch()`, the banking screen calls
--    it, and its own header calls unmatching "a first-class operation, not an
--    undo". On any deployment where `ordence_app` exists, that button returns
--    a privilege error.
--
-- ⭐ SECTION 5 IS NOW THE TRIGGER 0087 ASSUMED, so the grant it was pairing
--    with can finally be correct: DELETE is permitted by the privilege layer
--    and REFUSED by the trigger for exactly the rows that matter — the ones
--    inside a signed reconciliation. That is the right division. A privilege
--    that blocks the feature entirely is not a control, it is an outage.
--
-- ⚠️ STATED PLAINLY: this WIDENS a privilege 0087 narrowed. It is done with
--    the guard in place and not before it, and it is the only widening here.
-- ============================================================================

DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        -- The reconciliation artefact: written once, and UPDATEd only to mark
        -- it reopened. Never deleted — the row is the evidence that a figure
        -- was signed, and a reopen that erased it would be invisible.
        GRANT SELECT, INSERT, UPDATE ON public.bank_reconciliations      TO ordence_app;
        -- The frozen items are written with their parent and never touched
        -- again. No UPDATE, no DELETE.
        GRANT SELECT, INSERT         ON public.bank_reconciliation_items TO ordence_app;

        -- 🔴 THE CORRECTION. See the section header.
        GRANT DELETE ON public.bank_line_matches TO ordence_app;
    END IF;
END;
$grants$;


-- ============================================================================
-- SECTION 8 · VERIFICATION · READ ONLY · RUN THIS LAST AND READ IT
-- ============================================================================
-- ⚠️ EVERY ROW SHOULD READ true. A false in `lock_is_enforced` means the
--    reconciliation lock is a column again — declared, displayed, and enforced
--    by nothing — which is the defect this whole file exists to end.
-- ============================================================================

SELECT
    '0102 · verification'                                          AS finding,
    to_regclass('public.bank_reconciliations')      IS NOT NULL    AS artefact_table_present,
    to_regclass('public.bank_reconciliation_items') IS NOT NULL    AS items_table_present,
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'bank_accounts'
               AND column_name = 'reconciliation_tolerance_minor')  AS tolerance_column_present,
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'bank_statements'
               AND column_name = 'import_digest')                   AS import_digest_present,
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgname = 'ordence_guard_reconciled_bank_line'
               AND NOT tgisinternal)                                AS lock_is_enforced,
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgname = 'ordence_guard_reconciled_statement_line'
               AND NOT tgisinternal)                                AS lines_are_guarded,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('bank_reconciliations', 'bank_reconciliation_items'))
                                                                    AS policies_present,
    (SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
       FROM pg_class c
      WHERE c.relname IN ('bank_reconciliations', 'bank_reconciliation_items'))
                                                                    AS rls_enabled_and_forced;
