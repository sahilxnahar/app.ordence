-- 🔴🔴 DRILL. NEVER RUN THIS AGAINST NEON. It writes rows and expects
--      failures. It exists to prove that 0112's guard refuses what it
--      claims to refuse, on a throwaway database.
DO $d$
DECLARE
    t uuid; b uuid; l uuid; d uuid; caught text;
BEGIN
    INSERT INTO public.tenants DEFAULT VALUES RETURNING id INTO t;
    INSERT INTO public.bank_accounts DEFAULT VALUES RETURNING id INTO b;
    INSERT INTO public.bank_statement_lines DEFAULT VALUES RETURNING id INTO l;

    INSERT INTO public.bank_charge_itc_deferrals
        (tenant_id, bank_account_id, statement_line_id, gross_minor, value_date, tax_period,
         status, invoice_no, invoice_date, supplier_gstin,
         taxable_value_minor, cgst_minor, sgst_minor, igst_minor, cess_minor)
    VALUES (t, b, l, 118000, DATE '2026-03-31', '2026-03',
            'invoice_recorded', 'BNK/26/0001', DATE '2026-03-31', '29AAACH1234K1ZK',
            100000, 9000, 9000, 0, 0)
    RETURNING id INTO d;
    RAISE NOTICE '① recorded, unposted: ok';

    -- ② posting is allowed exactly once
    UPDATE public.bank_charge_itc_deferrals
       SET credit_transaction_id = gen_random_uuid(), credit_posted_at = now()
     WHERE id = d;
    RAISE NOTICE '② first posting: ok';

    -- ③ editing a figure after posting must be refused
    BEGIN
        UPDATE public.bank_charge_itc_deferrals SET cgst_minor = 8000 WHERE id = d;
        RAISE EXCEPTION '③ FAILED — the guard permitted an edit after posting';
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS caught = MESSAGE_TEXT;
        IF caught LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '③ edit after posting refused: ok';
    END;

    -- ④ a second posting must be refused
    BEGIN
        UPDATE public.bank_charge_itc_deferrals
           SET credit_transaction_id = gen_random_uuid() WHERE id = d;
        RAISE EXCEPTION '④ FAILED — the guard permitted a second posting';
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS caught = MESSAGE_TEXT;
        IF caught LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '④ second posting refused: ok';
    END;

    -- ⑤ a half pair must be refused by the CHECK, not the trigger
    BEGIN
        INSERT INTO public.bank_charge_itc_deferrals
            (tenant_id, bank_account_id, statement_line_id, gross_minor, value_date,
             tax_period, status, credit_posted_at)
        VALUES (t, b, gen_random_uuid(), 100, DATE '2026-03-01', '2026-03',
                'awaiting_invoice', now());
        RAISE EXCEPTION '⑤ FAILED — posted_at with no transaction id was accepted';
    EXCEPTION
        WHEN check_violation THEN RAISE NOTICE '⑤ half pair refused: ok';
        WHEN foreign_key_violation THEN RAISE NOTICE '⑤ (fk first, acceptable in the stub schema)';
    END;

    -- ⑥ posting a row with no invoice behind it must be refused
    BEGIN
        UPDATE public.bank_charge_itc_deferrals
           SET status = 'awaiting_invoice' WHERE id = d;
        RAISE EXCEPTION '⑥ FAILED — status moved off invoice_recorded while posted';
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS caught = MESSAGE_TEXT;
        IF caught LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑥ status change after posting refused: ok';
    END;

    -- ⑦ 0110's six transcription CHECKs still apply to a POSTED row.
    --   This is the whole argument for not adding a fourth status.
    BEGIN
        UPDATE public.bank_charge_itc_deferrals
           SET credit_posted_at = NULL, credit_transaction_id = NULL WHERE id = d;
        RAISE EXCEPTION '⑦ FAILED — unposting was permitted';
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS caught = MESSAGE_TEXT;
        IF caught LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑦ unposting refused: ok';
    END;

    -- ⑧ 🔴🔴 THE CLAIM THE WHOLE DESIGN RESTS ON, TESTED DIRECTLY.
    --    The header says a fourth status would have switched 0110's six
    --    transcription CHECKs OFF for posted rows. ③ proves the trigger
    --    refuses an edit, which means the CHECK is never reached — so it
    --    proves nothing about the CHECK. This drops the trigger, edits a
    --    POSTED row so that it no longer foots, and shows the CHECK still
    --    refuses it. That is the property `status = 'invoice_recorded'`
    --    buys and a `credit_posted` status would have thrown away.
    ALTER TABLE public.bank_charge_itc_deferrals
        DISABLE TRIGGER ordence_guard_posted_itc_deferral;
    BEGIN
        UPDATE public.bank_charge_itc_deferrals SET cgst_minor = 8000 WHERE id = d;
        RAISE EXCEPTION '⑧ FAILED — a posted row was allowed not to foot';
    EXCEPTION
        WHEN check_violation THEN
            RAISE NOTICE '⑧ 0110 transcription CHECK still applies to a POSTED row: ok';
        WHEN raise_exception THEN
            GET STACKED DIAGNOSTICS caught = MESSAGE_TEXT;
            IF caught LIKE '%FAILED%' THEN RAISE; END IF;
    END;
    ALTER TABLE public.bank_charge_itc_deferrals
        ENABLE TRIGGER ordence_guard_posted_itc_deferral;

    -- ⚠️ AND THE RE-ARM IS ASSERTED, not assumed. A drill that leaves a
    --    guard disabled has taught the wrong lesson.
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.bank_charge_itc_deferrals'::regclass
           AND tgname  = 'ordence_guard_posted_itc_deferral'
           AND tgenabled <> 'D')
    THEN
        RAISE EXCEPTION 'THE GUARD WAS NOT RE-ARMED after step ⑧.';
    END IF;
    RAISE NOTICE '⑧ guard re-armed: ok';

    RAISE NOTICE 'DRILL 0112 PASSED';
END
$d$;
