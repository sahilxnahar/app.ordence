-- 🔴🔴 DRILL. NEVER RUN THIS AGAINST NEON. It writes rows and expects
--      failures. It proves 0116's constraints, its RLS policy and its
--      append-only guard refuse what the header claims they refuse.
--
-- 🔴 RUN IT AS A ROLE THAT OWNS THE TABLE AND DOES *NOT* HAVE BYPASSRLS.
--    Step ⑨ SELF-CHECKS THIS and refuses a false pass: a superuser bypasses
--    RLS unconditionally, so the isolation half of this drill would appear to
--    pass while proving nothing. That is exactly how 0115's grandfather bug
--    got as far as it did.

DO $d$
DECLARE
    t1 uuid; t2 uuid; u1 uuid; u2 uuid; e uuid;
    n int;
    bypasses boolean;
BEGIN
    INSERT INTO public.tenants DEFAULT VALUES RETURNING id INTO t1;
    INSERT INTO public.tenants DEFAULT VALUES RETURNING id INTO t2;
    INSERT INTO public.users DEFAULT VALUES RETURNING id INTO u1;
    INSERT INTO public.users DEFAULT VALUES RETURNING id INTO u2;

    PERFORM set_config('app.current_tenant_id', t1::text, true);

    -- ① A real, delivered export with no personal data in it.
    INSERT INTO public.data_exports
        (tenant_id, exported_by, subject, dataset_keys, format,
         row_count, byte_count, includes_personal_data)
    VALUES (t1, u1, 'Chart of accounts', ARRAY['ledgers'], 'xlsx', 412, 90112, false)
    RETURNING id INTO e;
    RAISE NOTICE '① a delivered export was recorded: ok';

    -- ② 🔴 THE FLAG WITHOUT THE LIST IS A SMOKE ALARM WITH NO ADDRESS ON IT.
    BEGIN
        INSERT INTO public.data_exports
            (tenant_id, exported_by, subject, dataset_keys, format,
             row_count, byte_count, includes_personal_data)
        VALUES (t1, u1, 'Contacts', ARRAY['contacts'], 'csv', 2000, 300000, true);
        RAISE EXCEPTION
            '② FAILED — an export marked as containing personal data was accepted without naming a single field. s.8(6) DPDPA requires the notification to state WHAT.';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '② personal-data export with no columns named refused: ok';
    END;

    INSERT INTO public.data_exports
        (tenant_id, exported_by, subject, dataset_keys, format,
         row_count, byte_count, includes_personal_data, personal_columns)
    VALUES (t1, u1, 'Contacts', ARRAY['contacts'], 'csv', 2000, 300000, true,
            ARRAY['Email', 'Mobile', 'First name']);
    RAISE NOTICE '③ the same export, with the fields named: ok';

    -- ④ AN EXPORT THAT RECORDS NOTHING ABOUT WHAT WAS EXPORTED IS NOT A RECORD.
    BEGIN
        INSERT INTO public.data_exports
            (tenant_id, exported_by, subject, dataset_keys, format,
             row_count, byte_count, includes_personal_data)
        VALUES (t1, u1, 'Something', ARRAY[]::text[], 'json', 1, 1, false);
        RAISE EXCEPTION '④ FAILED — an export naming no dataset was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '④ an export naming no dataset refused: ok';
    END;

    -- ⑤ A FAILURE SAYS WHY.
    BEGIN
        INSERT INTO public.data_exports
            (tenant_id, exported_by, subject, dataset_keys, format,
             row_count, byte_count, includes_personal_data, outcome)
        VALUES (t1, u1, 'Sales register', ARRAY['sales-register'], 'pdf', 0, 0, false, 'refused');
        RAISE EXCEPTION '⑤ FAILED — a refusal with no reason was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑤ a refusal with no reason refused: ok';
    END;

    INSERT INTO public.data_exports
        (tenant_id, exported_by, subject, dataset_keys, format,
         row_count, byte_count, includes_personal_data, outcome, failure_reason)
    VALUES (t1, u1, 'Sales register', ARRAY['sales-register'], 'pdf', 0, 0, false,
            'refused', 'This export is 412,000 rows, which is beyond the 200,000 Ordence will build in one file.');
    RAISE NOTICE '⑥ a refusal, with the sentence the person was shown: ok';

    -- ⑦ 🔴 THE FORMAT LIST. This is the constraint `check:export-registry`
    --   exists to keep in step with `lib/export/registry.ts`. A format the
    --   picker offers and this refuses produces an export that is BUILT AND
    --   DELIVERED and then fails at the log.
    BEGIN
        INSERT INTO public.data_exports
            (tenant_id, exported_by, subject, dataset_keys, format,
             row_count, byte_count, includes_personal_data)
        VALUES (t1, u1, 'Contacts', ARRAY['contacts'], 'xslx', 1, 1, false);
        RAISE EXCEPTION '⑦ FAILED — the format "xslx" was accepted. That is a typo, not a format.';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑦ an unknown format refused: ok';
    END;

    -- ⑧ 🔴 APPEND-ONLY. The edit somebody wants to make to an export log is
    --   always the one removing the export they should not have run.
    BEGIN
        UPDATE public.data_exports SET subject = 'Nothing' WHERE id = e;
        RAISE EXCEPTION '⑧ FAILED — an export log entry was edited';
    EXCEPTION WHEN raise_exception THEN
        IF sqlerrm LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑧ editing the log refused: ok';
    END;

    BEGIN
        DELETE FROM public.data_exports WHERE id = e;
        RAISE EXCEPTION '⑨ FAILED — an export log entry was deleted';
    EXCEPTION WHEN raise_exception THEN
        IF sqlerrm LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑨ deleting the log refused: ok';
    END;

    -- ⑩ 🔴 THE ISOLATION HALF, AND THE SELF-CHECK THAT MAKES IT MEAN ANYTHING.
    SELECT rolbypassrls INTO bypasses FROM pg_roles WHERE rolname = current_user;

    PERFORM set_config('app.current_tenant_id', t2::text, true);
    SELECT count(*) INTO n FROM public.data_exports;

    IF bypasses THEN
        RAISE EXCEPTION
            '⑩ INCONCLUSIVE — this role has BYPASSRLS, so the isolation check proves nothing whatever it returns. Re-run this drill as an owner with NOBYPASSRLS. Running it as a superuser is how a missing policy reaches production looking tested.';
    END IF;

    IF n <> 0 THEN
        RAISE EXCEPTION
            '⑩ FAILED — workspace 2 can see % of workspace 1''s export records. Every export this workspace ever ran is visible to another customer.', n;
    END IF;
    RAISE NOTICE '⑩ another workspace sees 0 of these rows, as a NOBYPASSRLS role: ok';

    -- ⑪ AND WORKSPACE 2 CANNOT WRITE A ROW BELONGING TO WORKSPACE 1.
    BEGIN
        INSERT INTO public.data_exports
            (tenant_id, exported_by, subject, dataset_keys, format,
             row_count, byte_count, includes_personal_data)
        VALUES (t1, u2, 'Contacts', ARRAY['contacts'], 'csv', 1, 1, false);
        RAISE EXCEPTION '⑪ FAILED — a workspace wrote an export record against another tenant';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE '⑪ cross-tenant write refused by the policy: ok';
    END;

    RAISE NOTICE 'DRILL 0116 PASSED — 11 checks';
END
$d$;
