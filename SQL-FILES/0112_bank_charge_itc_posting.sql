-- ############################################################################
-- 0112 · THE JOURNAL THAT MOVES A BANK CHARGE'S TAX OUT OF AN EXPENSE AND
--        INTO INPUT CREDIT
-- ############################################################################
--
-- Repo: app.ordence   ·   Base: v1.68.0-alpha + 0108..0111   ·   Number: 0112
--
-- 🔴 RUN AFTER 0110. This file alters a table 0110 creates. It also assumes
--    0108, because the posting it enables writes `journal_entries.amount_minor`
--    and that column does not exist before 0108.
--
-- ############################################################################
-- WHY THIS FILE EXISTS AT ALL
-- ############################################################################
--
-- Batch 0110 built the register, the refusals and the screen, and then stopped
-- at a boundary it was right to stop at. Its own report says so:
--
--     "Until it exists, `invoice_recorded` is a worklist state, not a posted
--      credit."
--
-- Every posting builder in this product lives in one file,
-- `lib/accounting/sales-posting.ts`, and that file belonged to a different
-- stream in the same wave. 0110 refused to reach across the line or to open a
-- second posting path inside the banking module, and gave the reason: a second
-- posting path is how the period lock came to be forgotten once already.
--
-- ⭐ SO THE STATE OF THE PRODUCT TODAY IS THIS. A customer can be shown that
--    ₹1,180 of bank charges carried ₹180 of credit, can enter the bank's tax
--    invoice number, date and GSTIN, can watch the arithmetic foot against the
--    money that left the account, and the ₹180 stays sitting inside Bank
--    Charges in the trial balance. The register knows. The ledger does not.
--
-- ############################################################################
-- 🔴🔴🔴 THE DESIGN DECISION IN THIS FILE, AND IT IS A REFUSAL
-- ############################################################################
--
-- The obvious shape is a fourth status: `credit_posted`, after
-- `invoice_recorded`. It is wrong, and the reason is worth writing down because
-- it is not obvious until you read 0110's constraints.
--
-- SIX of 0110's CHECK constraints are written as `status <> 'invoice_recorded'
-- OR <the real rule>`:
--
--     _invoice_complete      four identity fields and five figures, or nothing
--     _invoice_foots         taxable + cgst + sgst + igst + cess = gross
--     _cgst_equals_sgst      two halves of one rate
--     _one_tax_regime        IGST or CGST+SGST, never both
--     _heads_not_negative
--     (and _refusal_needs_reason, on the other branch)
--
-- ⚠️ A FOURTH STATUS TURNS EVERY ONE OF THOSE OFF FOR POSTED ROWS. `status <>
--    'invoice_recorded'` is TRUE when the status is `credit_posted`, so the OR
--    short-circuits and the rule stops applying — to precisely the rows where
--    it matters most, the ones whose figures are already in the ledger. Six
--    constraints would have to be rewritten as `status NOT IN (...)`, and
--    getting one of the six wrong would be invisible: the constraint would
--    still exist, still be listed by `\d`, and enforce nothing.
--
-- ⭐⭐ SO POSTING IS NOT A STATE. IT IS A FACT ABOUT A ROW THAT IS ALREADY IN
--    ONE. `credit_posted_at` and `credit_transaction_id` are added beside the
--    status, the status stays `invoice_recorded`, and all six constraints go on
--    applying to a posted row exactly as they did before it was posted. Which
--    is what you want: a credit that is in the books must still foot, must
--    still carry a GSTIN, must still be one tax regime.
--
-- ⭐ AND THE WORKLIST BECOMES A NULL TEST rather than a status. "Recorded and
--    not yet posted" is `status = 'invoice_recorded' AND credit_posted_at IS
--    NULL`, which is a partial index below and cannot drift out of step with a
--    status enum, because there is no second enum.
--
-- ############################################################################
-- ⚠️ AND THE GUARD, WHICH IS THE HALF THAT IS EASY TO SKIP
-- ############################################################################
--
-- Once the journal is written, the transcribed figures are no longer merely a
-- record of what the bank's invoice said. They are what the ledger says. An
-- UPDATE that corrects a mistyped CGST figure after posting leaves the register
-- and the trial balance disagreeing, permanently, with nothing anywhere saying
-- which is right.
--
-- 0110 already refuses re-recording an invoice over one recorded, in the server
-- action, with a good sentence. This adds the database half, because a server
-- action is not a constraint: `ordence_guard_posted_itc_deferral` refuses the
-- UPDATE itself. Same technique as `ordence_guard_reconciled_bank_line` in
-- 0102 — a trigger and not a foreign key, so a tenant cascade still deletes.
--
-- ############################################################################
-- SAFE TO RUN TWICE. Every statement is guarded. No BEGIN, no COMMIT, no bare
-- SET LOCAL: the Neon browser console sends each statement on its own
-- connection, so a transaction opened in one is not open in the next and a
-- `SET LOCAL` set in one is gone by the next.
-- ############################################################################


-- ============================================================================
-- ① THE THREE COLUMNS
-- ============================================================================
--
-- ⚠️ `credit_transaction_id` IS NOT A FOREIGN KEY, and for the reason 0110
--    gives about `transaction_id` two columns above it: the register has to
--    survive whatever happens to the transaction. A cascade here would delete
--    the evidence that a credit was posted, which is the one row an auditor
--    asking "where did this input credit come from" is looking for.

ALTER TABLE public.bank_charge_itc_deferrals
    ADD COLUMN IF NOT EXISTS credit_transaction_id  uuid,
    ADD COLUMN IF NOT EXISTS credit_posted_at       timestamptz,
    ADD COLUMN IF NOT EXISTS credit_posted_by       uuid REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bank_charge_itc_deferrals.credit_transaction_id IS
    'The journal that moved the tax out of Bank Charges and into the input '
    'credit heads. Deliberately not a foreign key: the register must outlive '
    'the transaction, because this row is the evidence the credit was taken.';

COMMENT ON COLUMN public.bank_charge_itc_deferrals.credit_posted_at IS
    'When that journal was written. NULL means the invoice is recorded and the '
    'credit is still sitting inside Bank Charges, which is a worklist and not '
    'an error. Posting is recorded here rather than as a fourth status so that '
    'all six of 0110''s transcription CHECKs keep applying to posted rows.';


-- ============================================================================
-- ② THE TWO CHECKS
-- ============================================================================
--
-- ⚠️ `IS NULL = IS NULL` RATHER THAN TWO SEPARATE NOT-NULL RULES. A posted-at
--    with no transaction id says a journal was written and refuses to name it;
--    a transaction id with no posted-at is a journal with no date. Neither is a
--    state anybody should be able to reach, and one CHECK says so once.

DO $c1$
BEGIN
    IF to_regclass('public.bank_charge_itc_deferrals') IS NOT NULL
       AND NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'bank_charge_itc_deferrals_posting_pair'
       )
    THEN
        ALTER TABLE public.bank_charge_itc_deferrals
            ADD CONSTRAINT bank_charge_itc_deferrals_posting_pair
            CHECK ((credit_transaction_id IS NULL) = (credit_posted_at IS NULL));
    END IF;
END
$c1$;

-- 🔴 THE ONE THAT MATTERS. A credit cannot be posted from a row that has no
--    invoice behind it. `awaiting_invoice` has no figures to post and
--    `not_claimable` is a decision that there is nothing to take; a journal
--    against either would be exactly the unsupported claim that the whole of
--    0110 exists to refuse.

DO $c2$
BEGIN
    IF to_regclass('public.bank_charge_itc_deferrals') IS NOT NULL
       AND NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'bank_charge_itc_deferrals_posted_needs_invoice'
       )
    THEN
        ALTER TABLE public.bank_charge_itc_deferrals
            ADD CONSTRAINT bank_charge_itc_deferrals_posted_needs_invoice
            CHECK (credit_posted_at IS NULL OR status = 'invoice_recorded');
    END IF;
END
$c2$;


-- ============================================================================
-- ③ THE WORKLIST INDEX
-- ============================================================================
--
-- ⭐ PARTIAL, AND THE PREDICATE IS THE WORKLIST ITSELF. "Which credits are
--    identified and still not in the books" is the only question this table is
--    asked between recording an invoice and posting it, and it is asked on
--    every render of the register.

CREATE INDEX IF NOT EXISTS bank_charge_itc_deferrals_unposted_idx
    ON public.bank_charge_itc_deferrals (tenant_id, tax_period)
 WHERE status = 'invoice_recorded' AND credit_posted_at IS NULL;


-- ============================================================================
-- ④ 🔴 THE GUARD
-- ============================================================================
--
-- ⚠️ IT REFUSES EDITS TO THE FIGURES, NOT EVERY UPDATE. Setting the three
--    posting columns is the whole point, so it must pass; and it must pass ONCE
--    ONLY, or a second posting would overwrite the first journal's id and the
--    first journal would become unreachable from here.
--
-- ⚠️ AND IT LETS `resolved_at` / `resolved_by` MOVE, because those record who
--    last acted on the row and posting is an act.

CREATE OR REPLACE FUNCTION public.ordence_guard_posted_itc_deferral()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
    IF OLD.credit_posted_at IS NULL THEN
        RETURN NEW;
    END IF;

    -- 🔴 ALREADY POSTED. Nothing that the journal was built from may move.
    IF NEW.status              IS DISTINCT FROM OLD.status
       OR NEW.invoice_no          IS DISTINCT FROM OLD.invoice_no
       OR NEW.invoice_date        IS DISTINCT FROM OLD.invoice_date
       OR NEW.supplier_gstin      IS DISTINCT FROM OLD.supplier_gstin
       OR NEW.taxable_value_minor IS DISTINCT FROM OLD.taxable_value_minor
       OR NEW.cgst_minor          IS DISTINCT FROM OLD.cgst_minor
       OR NEW.sgst_minor          IS DISTINCT FROM OLD.sgst_minor
       OR NEW.igst_minor          IS DISTINCT FROM OLD.igst_minor
       OR NEW.cess_minor          IS DISTINCT FROM OLD.cess_minor
       OR NEW.gross_minor         IS DISTINCT FROM OLD.gross_minor
    THEN
        RAISE EXCEPTION
            'The input credit on this bank charge has already been posted to the ledger on %. Changing the invoice it was built from would leave the register and the trial balance disagreeing with nothing to say which is right. Reverse the journal first.',
            OLD.credit_posted_at
            USING ERRCODE = 'raise_exception';
    END IF;

    -- 🔴 AND IT MAY NOT BE POSTED TWICE. The second journal would take the
    --    column and the first would still be in the books, unreachable.
    IF NEW.credit_transaction_id IS DISTINCT FROM OLD.credit_transaction_id THEN
        RAISE EXCEPTION
            'This credit is already posted as transaction %. A second posting would replace the reference and leave the first journal in the ledger with nothing pointing at it.',
            OLD.credit_transaction_id
            USING ERRCODE = 'raise_exception';
    END IF;

    RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS ordence_guard_posted_itc_deferral ON public.bank_charge_itc_deferrals;

CREATE TRIGGER ordence_guard_posted_itc_deferral
    BEFORE UPDATE ON public.bank_charge_itc_deferrals
    FOR EACH ROW EXECUTE FUNCTION public.ordence_guard_posted_itc_deferral();


-- ============================================================================
-- ⑤ THE VERDICT
-- ============================================================================
--
-- ⚠️ ONE STATEMENT, AND THE STRING IS SINGLE-QUOTED. A dollar-quoted literal
--    in a verdict SELECT was mangled once in 0101 and the result was the worst
--    available: every earlier statement applied, and the single row that would
--    have told you so was a syntax error.

SELECT
    'SQL 0112 · bank charge input credit posting'                       AS migration,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'bank_charge_itc_deferrals'
        AND column_name IN ('credit_transaction_id','credit_posted_at','credit_posted_by'))
                                                                        AS columns_added_expect_3,
    (SELECT count(*) FROM pg_constraint
      WHERE conname IN ('bank_charge_itc_deferrals_posting_pair',
                        'bank_charge_itc_deferrals_posted_needs_invoice'))
                                                                        AS checks_expect_2,
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname  = 'bank_charge_itc_deferrals_unposted_idx')      AS worklist_index_expect_1,
    (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname = 'ordence_guard_posted_itc_deferral')               AS guard_expect_1,
    (SELECT count(*) FROM public.bank_charge_itc_deferrals
      WHERE status = 'invoice_recorded' AND credit_posted_at IS NULL)   AS credits_identified_and_not_yet_posted;
