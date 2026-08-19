-- ############################################################################
-- DRILL · 0110 · THROWAWAY POSTGRES ONLY · 🔴 DO NOT RUN THIS IN NEON
-- ############################################################################
--
-- Repo: app.ordence   ·   Pairs with SQL-FILES/0110_bank_allocation_and_bank_charge_itc.sql
--
-- ══════════════════════════════════════════════════════════════════════════
-- 🔴🔴 WHY THIS FILE EXISTS AND WHY IT MUST NOT RUN AS A SUPERUSER
-- ══════════════════════════════════════════════════════════════════════════
-- A drill that tests whether a policy or a trigger REFUSES something proves
-- nothing when it is run as `postgres`: a superuser bypasses row-level
-- security entirely, so every refusal test passes and the file reports
-- success on a database where the control does not work.
--
-- ⭐ STEP 0 REFUSES TO PROCEED unless the connection is a NON-SUPERUSER,
--    NON-BYPASSRLS role and the database name looks like a throwaway.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️ AND IT EXERCISES BOTH BRANCHES OF EVERY GUARD
-- ══════════════════════════════════════════════════════════════════════════
-- A verify file that has only ever been run on the passing case is not a
-- verify file. Every section below asserts a refusal AND the permission that
-- must survive alongside it — most importantly Section 3, where the whole
-- point is that the same trigger refuses a real delete and silently permits a
-- tenant cascade.
--
-- HOW TO RUN
-- ----------
--   createdb -O ordence_owner drill_0110
--   psql -d drill_0110 -f <prerequisite schema>       -- 0070 + 0102 subset
--   psql -d drill_0110 -f 0110_bank_allocation_and_bank_charge_itc.sql
--   psql -U ordence_app -d drill_0110 -f DRILL-DO-NOT-RUN-IN-NEON-0110.sql
--
-- ⚠️ THE DRILL IS THE ONE FILE HERE THAT MAY BE RUN WITH `psql -f`. It is not
--    a migration; it is not pasted into a console; and it needs its own
--    transactions so a refusal can be caught without discarding the rest.
-- ############################################################################


-- ============================================================================
-- STEP 0 · REFUSE TO RUN ANYWHERE THAT MIGHT BE REAL
-- ============================================================================
DO $step0$
DECLARE
    db     text := current_database();
    superu boolean;
    bypass boolean;
BEGIN
    SELECT rolsuper, rolbypassrls INTO superu, bypass
      FROM pg_roles WHERE rolname = current_user;

    IF db !~ '(drill|throwaway|scratch|harness|test)' THEN
        RAISE EXCEPTION
            'REFUSING TO RUN. The database is called "%", which does not look like a throwaway. This file writes and deletes rows and will delete a tenant. Create a scratch database whose name contains "drill" and run it there.', db;
    END IF;

    IF superu THEN
        RAISE EXCEPTION
            'REFUSING TO RUN. "%" is a SUPERUSER, which bypasses row-level security. Every refusal test in this file would pass and prove nothing — which is precisely the failure this file exists to avoid. Connect as a non-superuser role such as ordence_app.', current_user;
    END IF;

    IF bypass THEN
        RAISE EXCEPTION
            'REFUSING TO RUN. "%" has BYPASSRLS. Same problem as a superuser: the refusals would not be exercised.', current_user;
    END IF;

    RAISE NOTICE 'DRILL 0110 · database %, role % (not superuser, no bypassrls). Proceeding.', db, current_user;
END;
$step0$;


-- ============================================================================
-- STEP 1 · A TENANT AND ONE OPEN STATEMENT TO WORK ON
-- ============================================================================
-- ⚠️ EVERY BLOCK BELOW PINS THE TENANT ITSELF. `SET LOCAL app.current_tenant_id`
--    as a standalone statement would evaporate before the next block ran, and
--    the drill would then be testing a tenant of NULL.
-- ============================================================================
DO $setup$
DECLARE
    td uuid := '33333333-3333-4333-8333-333333333333';
    ld uuid; ad uuid; sd uuid;
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);
    INSERT INTO tenants (id, name) VALUES (td, 'Drill Co')
        ON CONFLICT (id) DO NOTHING;

    PERFORM set_config('app.current_tenant_id', td::text, true);

    INSERT INTO ledgers (id, tenant_id, name)
        VALUES ('33333333-0000-4000-8000-00000000000d', td, 'Drill bank')
        ON CONFLICT (id) DO NOTHING;
    INSERT INTO bank_accounts (id, tenant_id, ledger_id, label, reconciled_to)
        VALUES ('33333333-0000-4000-8000-00000000000a', td,
                '33333333-0000-4000-8000-00000000000d', 'Drill HDFC', NULL)
        ON CONFLICT (id) DO NOTHING;
    INSERT INTO bank_statements (id, tenant_id, bank_account_id, period_from, period_to,
                                 opening_balance_minor, closing_balance_minor)
        VALUES ('33333333-0000-4000-8000-0000000000f0', td,
                '33333333-0000-4000-8000-00000000000a', '2026-05-01', '2026-05-31', 0, 0)
        ON CONFLICT (id) DO NOTHING;

    -- ⭐ ONE RECEIPT OF ₹10,000 AND A BANK LINE OF ₹10,000, plus a second
    --   line, so both the line bound and the document bound can be pushed.
    INSERT INTO bank_statement_lines (id, tenant_id, statement_id, bank_account_id,
                                      value_date, amount_minor, narration)
        VALUES ('33333333-0000-4000-8000-0000000000b1', td,
                '33333333-0000-4000-8000-0000000000f0',
                '33333333-0000-4000-8000-00000000000a', '2026-05-10', 1000000,
                'NEFT INWARD THREE INVOICES'),
               ('33333333-0000-4000-8000-0000000000b2', td,
                '33333333-0000-4000-8000-0000000000f0',
                '33333333-0000-4000-8000-00000000000a', '2026-05-12', 400000,
                'NEFT INWARD SECOND'),
               ('33333333-0000-4000-8000-0000000000b3', td,
                '33333333-0000-4000-8000-0000000000f0',
                '33333333-0000-4000-8000-00000000000a', '2026-05-14', -118000,
                'NEFT CHRG MAY26'),
               -- ⚠️ A FOURTH LINE, POSITIVE AND WITH ROOM TO SPARE, EXISTS
               --    ONLY SO THAT THE DOCUMENT BOUND AND THE PAIR INDEX CAN BE
               --    TESTED IN ISOLATION. The first draft of this drill pushed
               --    both against a NEGATIVE line, so the SIGN check fired
               --    first and both "passed" without the rule under test ever
               --    running. A refusal is not evidence unless it is the
               --    refusal you claimed.
               ('33333333-0000-4000-8000-0000000000b4', td,
                '33333333-0000-4000-8000-0000000000f0',
                '33333333-0000-4000-8000-00000000000a', '2026-05-16', 300000,
                'NEFT INWARD FOURTH')
        ON CONFLICT (id) DO NOTHING;

    INSERT INTO customer_receipts (id, tenant_id, received_on, amount_minor, receipt_number)
        VALUES ('33333333-0000-4000-8000-0000000000c1', td, '2026-05-10', 400000, 'RC-1'),
               ('33333333-0000-4000-8000-0000000000c2', td, '2026-05-10', 600000, 'RC-2'),
               ('33333333-0000-4000-8000-0000000000c3', td, '2026-05-10', 500000, 'RC-3'),
               ('33333333-0000-4000-8000-0000000000c4', td, '2026-05-16', 900000, 'RC-4')
        ON CONFLICT (id) DO NOTHING;

    RAISE NOTICE 'DRILL 0110 · set up: line1 1000000, line2 400000, charge -118000; receipts 400000 / 600000 / 500000.';
END;
$setup$;


-- ============================================================================
-- STEP 2 · 🔴 F1 · THE ALLOCATION GUARD · BOTH BRANCHES OF EVERY RULE
-- ============================================================================
DO $f1$
DECLARE
    td   uuid := '33333333-3333-4333-8333-333333333333';
    l1   uuid := '33333333-0000-4000-8000-0000000000b1';
    l2   uuid := '33333333-0000-4000-8000-0000000000b2';
    l3   uuid := '33333333-0000-4000-8000-0000000000b3';
    r1   uuid := '33333333-0000-4000-8000-0000000000c1';
    r2   uuid := '33333333-0000-4000-8000-0000000000c2';
    l4   uuid := '33333333-0000-4000-8000-0000000000b4';
    r3   uuid := '33333333-0000-4000-8000-0000000000c3';
    r4   uuid := '33333333-0000-4000-8000-0000000000c4';
    passed int := 0;
    failed int := 0;
BEGIN
    PERFORM set_config('app.current_tenant_id', td::text, true);

    DELETE FROM bank_line_matches WHERE statement_line_id IN (l1, l2, l3, l4);

    -- ── ⭐ THE CASE 0070 FORBADE: ONE LINE, TWO DOCUMENTS ──────────────────
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l1, 'customer_receipt', r1, 400000);
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · 400000 of a 1000000 line allocated to RC-1. The line is now PARTLY explained, which 0070 could not represent at all.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · a partial allocation was refused: %', SQLERRM;
    END;

    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l1, 'customer_receipt', r2, 600000);
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · a second document on the same line brings it to 1000000. ONE RECEIPT AGAINST TWO INVOICES IS NOW REPRESENTABLE.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · the second allocation on one line was refused: %', SQLERRM;
    END;

    -- ── 🔴 AND THE LINE BOUND HOLDS: ONE PAISA MORE IS REFUSED ─────────────
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l1, 'customer_receipt', r3, 1);
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · ONE PAISA OF OVER-ALLOCATION WAS ACCEPTED. The reconciliation can now balance while being false.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · over-allocating the line by 1 paisa refused: %', SQLERRM;
    END;

    -- ── 🔴 THE SIGN ────────────────────────────────────────────────────────
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l2, 'customer_receipt', r3, -100000);
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · an allocation pointing the wrong way was accepted.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · a negative allocation against a positive line refused: %', SQLERRM;
    END;

    -- ── 🔴 ZERO ────────────────────────────────────────────────────────────
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l2, 'customer_receipt', r3, 0);
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · an allocation of zero was accepted.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · an allocation of zero refused: %', SQLERRM;
    END;

    -- ── ⭐ ONE DOCUMENT ACROSS TWO LINES, WITHIN ITS OWN AMOUNT ────────────
    --    The other half of what 0070 forbade: a customer pays in two
    --    instalments against one receipt.
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l2, 'customer_receipt', r3, 400000);
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · RC-3 (500000) allocated 400000 to a SECOND line. ONE DOCUMENT ACROSS TWO LINES IS NOW REPRESENTABLE.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · allocating one document to a second line was refused: %', SQLERRM;
    END;

    -- ── 🔴 AND THE DOCUMENT BOUND HOLDS, IN ISOLATION ──────────────────────
    --
    -- ⚠️ AGAINST `l4`, WHICH IS POSITIVE AND HAS 300000 OF ROOM. The first
    --    draft pushed this against the NEGATIVE charge line, so the SIGN check
    --    fired and the document bound was never reached — the assertion passed
    --    and proved nothing. Here the sign agrees and the line has room, so
    --    the ONLY rule that can refuse it is the document bound.
    --
    --    RC-3 is 500000 and 400000 of it is on `l2`, so 100000 is left.
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l4, 'customer_receipt', r3, 200000);
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · A DOCUMENT WAS OVER-ALLOCATED. One receipt now explains more money than it is worth.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · over-allocating the DOCUMENT refused: %', SQLERRM;
    END;

    -- ── ⭐ AND WHAT IS ACTUALLY LEFT OF IT IS ACCEPTED ─────────────────────
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l4, 'customer_receipt', r3, 100000);
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · the remaining 100000 of RC-3 allocated to a THIRD line. The bound refuses the excess, not the document.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · the last 100000 of a document was refused: %', SQLERRM;
    END;

    -- ── 🔴 ONE ROW PER (LINE, DOCUMENT) PAIR, IN ISOLATION ─────────────────
    --
    -- ⚠️ THE SUM GUARD IS A `BEFORE` TRIGGER AND THE UNIQUE INDEX IS CHECKED
    --    AFTER IT, so the pair index can only be reached by a duplicate that
    --    the sums PERMIT. `l4` is 300000 with 100000 used, and RC-4 is 900000,
    --    so 100000 twice is within both bounds and the only thing left to
    --    refuse it is the index. The first draft of this assertion duplicated
    --    a pair on a line that was already full, so the LINE bound fired and
    --    the index was never exercised.
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l4, 'customer_receipt', r4, 100000);
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · RC-4 allocated 100000 to l4, which still has 100000 of room.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · a third document on one line was refused: %', SQLERRM;
    END;

    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l4, 'customer_receipt', r4, 100000);
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · a second row for the same line and document was accepted. "Unmatch this document from this line" now has two answers.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · a duplicate (line, document) pair refused: %', SQLERRM;
    END;

    -- ── 🔴 A JOURNAL CANNOT BE ALLOCATED IN PART ───────────────────────────
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l3, 'journal_entry', gen_random_uuid(), -50000);
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · a journal was allocated in part. Its residue can never be closed.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · a partial allocation to a journal refused: %', SQLERRM;
    END;

    -- ── ⭐ AND A WHOLE-LINE JOURNAL IS FINE ────────────────────────────────
    BEGIN
        INSERT INTO bank_line_matches (tenant_id, statement_line_id, matched_kind, matched_id, allocated_minor)
            VALUES (td, l3, 'journal_entry', '33333333-0000-4000-8000-0000000000e1', -118000);
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · a journal for the whole line accepted, which is how postBankLineAdjustment writes one.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · a whole-line journal was refused: %', SQLERRM;
    END;

    -- ── ⭐ REMOVING AN ALLOCATION IS NEVER REFUSED BY THE SUM GUARD ────────
    --    `≤` stays true when a term is taken away, which is why the trigger
    --    does not fire on DELETE at all.
    BEGIN
        DELETE FROM bank_line_matches
         WHERE statement_line_id = l1 AND matched_id = r1;
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · removing one allocation from a line is permitted. The line is partly explained again.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · removing an allocation was refused: %', SQLERRM;
    END;

    RAISE NOTICE 'DRILL 0110 · F1 allocation: % passed, % FAILED.', passed, failed;
    IF failed > 0 THEN
        RAISE EXCEPTION 'DRILL 0110 · F1 FAILED % assertion(s). Read the warnings above.', failed;
    END IF;
END;
$f1$;


-- ============================================================================
-- STEP 3 · 🔴 F2 · THE INPUT CREDIT REGISTER · THE CONSTRAINT THAT REFUSES A
--          GUESSED RATE
-- ============================================================================
DO $f2$
DECLARE
    td uuid := '33333333-3333-4333-8333-333333333333';
    l3 uuid := '33333333-0000-4000-8000-0000000000b3';
    d  uuid;
    passed int := 0;
    failed int := 0;
BEGIN
    PERFORM set_config('app.current_tenant_id', td::text, true);
    DELETE FROM bank_charge_itc_deferrals WHERE tenant_id = td;

    INSERT INTO bank_charge_itc_deferrals
        (tenant_id, bank_account_id, statement_line_id, gross_minor, value_date, tax_period)
    VALUES (td, '33333333-0000-4000-8000-00000000000a', l3, 118000, '2026-05-14', '2026-05')
    RETURNING id INTO d;
    passed := passed + 1;
    RAISE NOTICE '✅ PASS · a charge of 118000 paise recorded as awaiting_invoice. The credit on it is unclaimed AND now counted.';

    -- ── 🔴 ONE STATEMENT LINE IS ONE CHARGE IS ONE DEFERRAL ────────────────
    BEGIN
        INSERT INTO bank_charge_itc_deferrals
            (tenant_id, bank_account_id, statement_line_id, gross_minor, value_date, tax_period)
        VALUES (td, '33333333-0000-4000-8000-00000000000a', l3, 118000, '2026-05-14', '2026-05');
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · a second deferral for one statement line was accepted.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · a duplicate deferral on one line refused: %', SQLERRM;
    END;

    -- ── 🔴🔴🔴 THE GUESSED RATE. 18% on 118000 "looks right" and does not
    --      foot: 100000 + 9000 + 9000 = 118000 does. 118000 * 18/118 rounded
    --      the wrong way, or a charge that was partly exempt, does not.
    BEGIN
        UPDATE bank_charge_itc_deferrals
           SET status = 'invoice_recorded', invoice_no = 'BNK/26/0091',
               invoice_date = '2026-05-31', supplier_gstin = '27AAACR5055K1Z7',
               taxable_value_minor = 100000, cgst_minor = 9000, sgst_minor = 9000,
               igst_minor = 0, cess_minor = 100
         WHERE id = d;
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · A SPLIT THAT DOES NOT FOOT TO THE MONEY THAT MOVED WAS ACCEPTED. An assumed rate can now reach GSTR-3B.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · a split summing to 118100 against a charge of 118000 refused: %', SQLERRM;
    END;

    -- ── 🔴 CGST AND SGST ARE TWO HALVES OF ONE RATE ────────────────────────
    BEGIN
        UPDATE bank_charge_itc_deferrals
           SET status = 'invoice_recorded', invoice_no = 'BNK/26/0091',
               invoice_date = '2026-05-31', supplier_gstin = '27AAACR5055K1Z7',
               taxable_value_minor = 100000, cgst_minor = 10000, sgst_minor = 8000,
               igst_minor = 0, cess_minor = 0
         WHERE id = d;
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · unequal CGST and SGST accepted.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · unequal CGST and SGST refused: %', SQLERRM;
    END;

    -- ── 🔴 ONE SUPPLY CARRIES IGST OR CGST+SGST, NEVER BOTH ────────────────
    BEGIN
        UPDATE bank_charge_itc_deferrals
           SET status = 'invoice_recorded', invoice_no = 'BNK/26/0091',
               invoice_date = '2026-05-31', supplier_gstin = '27AAACR5055K1Z7',
               taxable_value_minor = 100000, cgst_minor = 4500, sgst_minor = 4500,
               igst_minor = 9000, cess_minor = 0
         WHERE id = d;
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · IGST and CGST/SGST on one supply accepted.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · IGST alongside CGST/SGST refused: %', SQLERRM;
    END;

    -- ── 🔴 AN INVOICE IS FOUR THINGS OR IT IS NOTHING ──────────────────────
    BEGIN
        UPDATE bank_charge_itc_deferrals
           SET status = 'invoice_recorded', invoice_no = 'BNK/26/0091',
               invoice_date = '2026-05-31', supplier_gstin = NULL,
               taxable_value_minor = 100000, cgst_minor = 9000, sgst_minor = 9000,
               igst_minor = 0, cess_minor = 0
         WHERE id = d;
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · an invoice recorded with no supplier GSTIN was accepted. That credit can never match a GSTR-2B row.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · a recorded invoice with no GSTIN refused: %', SQLERRM;
    END;

    -- ── ⭐ AND THE CORRECT TRANSCRIPTION IS ACCEPTED ───────────────────────
    BEGIN
        UPDATE bank_charge_itc_deferrals
           SET status = 'invoice_recorded', invoice_no = 'BNK/26/0091',
               invoice_date = '2026-05-31', supplier_gstin = '27AAACR5055K1Z7',
               taxable_value_minor = 100000, cgst_minor = 9000, sgst_minor = 9000,
               igst_minor = 0, cess_minor = 0
         WHERE id = d;
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · 100000 + 9000 + 9000 = 118000 accepted. 18000 paise of credit is now IDENTIFIED against invoice BNK/26/0091.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · a correct transcription was refused: %', SQLERRM;
    END;

    -- ── 🔴 "NOT CLAIMABLE" WITH NO REASON ──────────────────────────────────
    BEGIN
        UPDATE bank_charge_itc_deferrals
           SET status = 'not_claimable', not_claimable_reason = NULL WHERE id = d;
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · a credit was written off with no reason.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · not_claimable with no reason refused: %', SQLERRM;
    END;

    RAISE NOTICE 'DRILL 0110 · F2 input credit: % passed, % FAILED.', passed, failed;
    IF failed > 0 THEN
        RAISE EXCEPTION 'DRILL 0110 · F2 FAILED % assertion(s).', failed;
    END IF;
END;
$f2$;


-- ============================================================================
-- STEP 4 · 🔴🔴 F3 · THE STATEMENT DELETE GUARD · THE TEST 0102 NEVER WROTE
-- ============================================================================
-- `0102` reasoned that RESTRICT on `bank_reconciliations.statement_id` would
-- make deleting a tenant impossible, and settled for CASCADE. This asserts
-- that the trigger gets both:
--
--   ① a reconciled statement CANNOT be deleted while its tenant is alive
--   ② an unreconciled statement CAN
--   ③ deleting the TENANT still takes everything with it
--
-- ⚠️ ③ IS THE ONE THAT MATTERS. It is the branch a guard of this shape gets
--    wrong, and it is the branch that never gets tested because it looks like
--    it obviously works.
-- ============================================================================
DO $f3$
DECLARE
    tz uuid := '44444444-4444-4444-8444-444444444444';
    lz uuid := '44444444-0000-4000-8000-00000000000d';
    az uuid := '44444444-0000-4000-8000-00000000000a';
    s_signed   uuid := '44444444-0000-4000-8000-0000000000f1';
    s_unsigned uuid := '44444444-0000-4000-8000-0000000000f2';
    passed int := 0;
    failed int := 0;
    survivors int;
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);
    DELETE FROM tenants WHERE id = tz;
    INSERT INTO tenants (id, name) VALUES (tz, 'Cascade Co');

    PERFORM set_config('app.current_tenant_id', tz::text, true);
    INSERT INTO ledgers (id, tenant_id, name) VALUES (lz, tz, 'Cascade bank');
    INSERT INTO bank_accounts (id, tenant_id, ledger_id, label) VALUES (az, tz, lz, 'Cascade HDFC');
    INSERT INTO bank_statements (id, tenant_id, bank_account_id, period_from, period_to,
                                 opening_balance_minor, closing_balance_minor)
        VALUES (s_signed,   tz, az, '2026-01-01', '2026-01-31', 0, 500000),
               (s_unsigned, tz, az, '2026-02-01', '2026-02-28', 500000, 700000);
    INSERT INTO bank_reconciliations (tenant_id, bank_account_id, statement_id, reconciled_to,
                                      bank_balance_minor, book_balance_minor)
        VALUES (tz, az, s_signed, '2026-01-31', 500000, 500000);

    -- ── ① REFUSED, TENANT ALIVE ────────────────────────────────────────────
    BEGIN
        DELETE FROM bank_statements WHERE id = s_signed;
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · A RECONCILED STATEMENT WAS DELETED. The signed reconciliation now refers to evidence that is gone.';
    EXCEPTION WHEN OTHERS THEN
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · deleting a reconciled statement refused: %', SQLERRM;
    END;

    -- ── ② PERMITTED, BECAUSE NOTHING WAS SIGNED AGAINST IT ─────────────────
    BEGIN
        DELETE FROM bank_statements WHERE id = s_unsigned;
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · deleting an UNRECONCILED statement is still permitted. The guard is not a blanket refusal.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · an unreconciled statement could not be deleted: %', SQLERRM;
    END;

    -- ── ③ 🔴 THE TENANT CASCADE STILL WORKS ────────────────────────────────
    --    This is the branch `0102` chose CASCADE to protect and never tested.
    --    The guard reads `tenants`, which is gone by the time the cascade
    --    fires, so the exemption is the shape of the query and not a list.
    PERFORM set_config('app.current_tenant_id', '', true);
    BEGIN
        DELETE FROM tenants WHERE id = tz;
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · deleting the TENANT still cascades through a reconciled statement. RESTRICT would have made this impossible; the trigger does not.';
    EXCEPTION WHEN OTHERS THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · DELETING A TENANT IS NOW IMPOSSIBLE. This is exactly the outcome 0102 chose CASCADE to avoid: %', SQLERRM;
    END;

    PERFORM set_config('app.platform_scope', 'on', true);
    SELECT count(*) INTO survivors FROM bank_statements WHERE tenant_id = tz;
    IF survivors <> 0 THEN
        failed := failed + 1;
        RAISE WARNING '❌ FAIL · % statement row(s) survived the tenant deletion.', survivors;
    ELSE
        passed := passed + 1;
        RAISE NOTICE '✅ PASS · no statement rows survived the tenant deletion.';
    END IF;

    RAISE NOTICE 'DRILL 0110 · F3 statement delete: % passed, % FAILED.', passed, failed;
    IF failed > 0 THEN
        RAISE EXCEPTION 'DRILL 0110 · F3 FAILED % assertion(s).', failed;
    END IF;
END;
$f3$;


-- ============================================================================
-- STEP 5 · 🔴 THE 0102 LOCK IS STILL A LOCK
-- ============================================================================
-- ⚠️ 0110 SUSPENDS `ordence_guard_reconciled_bank_line` FOR ONE STATEMENT
--    during its backfill. This asserts it came back. A guard that was
--    switched off and left off leaves no trace beyond `pg_trigger.tgenabled`,
--    and nothing else in the system would notice.
-- ============================================================================
DO $lock$
DECLARE
    flag "char";
BEGIN
    SELECT tgenabled INTO flag FROM pg_trigger
     WHERE tgname = 'ordence_guard_reconciled_bank_line' AND NOT tgisinternal;

    IF flag IS NULL THEN
        RAISE EXCEPTION '❌ FAIL · ordence_guard_reconciled_bank_line is GONE.';
    ELSIF flag <> 'O' THEN
        RAISE EXCEPTION '❌ FAIL · ordence_guard_reconciled_bank_line is in state "%" rather than enabled. 0110 suspended it and did not restore it.', flag;
    END IF;

    RAISE NOTICE '✅ PASS · ordence_guard_reconciled_bank_line is present and enabled.';
    RAISE NOTICE 'DRILL 0110 · every section passed.';
END;
$lock$;
