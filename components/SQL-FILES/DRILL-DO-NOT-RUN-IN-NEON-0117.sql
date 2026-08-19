-- 🔴🔴 DRILL. NEVER RUN THIS AGAINST NEON. It writes rows and expects
--      failures. It proves 0117's constraints, its idempotency index and its
--      append-only guard refuse what the header claims they refuse.
--
-- 🔴 RUN IT AS A ROLE THAT OWNS THE TABLES AND DOES *NOT* HAVE BYPASSRLS.
--    Step ⑫ self-checks this and refuses a false pass.

DO $d$
DECLARE
    t1 uuid; t2 uuid; u1 uuid; r uuid; n int; bypasses boolean;
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);
    INSERT INTO public.tenants DEFAULT VALUES RETURNING id INTO t1;
    INSERT INTO public.tenants DEFAULT VALUES RETURNING id INTO t2;
    INSERT INTO public.users   DEFAULT VALUES RETURNING id INTO u1;
    PERFORM set_config('app.platform_scope', 'off', true);

    PERFORM set_config('app.current_tenant_id', t1::text, true);

    -- ① A run that has not finished has no finish time.
    BEGIN
        INSERT INTO public.import_runs
            (tenant_id, started_by, entity_key, source_format, duplicate_mode,
             expected_rows, status, finished_at)
        VALUES (t1, u1, 'companies', 'xlsx', 'skip', 100, 'running', now());
        RAISE EXCEPTION '① FAILED — a running import was accepted with a finish time';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '① a running import with a finish time refused: ok';
    END;

    INSERT INTO public.import_runs
        (tenant_id, started_by, entity_key, source_format, source_name,
         duplicate_mode, expected_rows)
    VALUES (t1, u1, 'companies', 'xlsx', 'customers-2026.xlsx', 'skip', 1000)
    RETURNING id INTO r;
    RAISE NOTICE '② a 1,000-row run started: ok';

    -- ③ 🔴 A CHUNK'S OWN ARITHMETIC MUST ADD UP.
    BEGIN
        INSERT INTO public.import_run_chunks
            (tenant_id, run_id, chunk_index, row_count, rows_written, rows_skipped, rows_failed)
        VALUES (t1, r, 0, 500, 400, 50, 10);
        RAISE EXCEPTION '③ FAILED — a chunk whose outcomes do not sum to its row count was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '③ a chunk that does not add up refused: ok';
    END;

    INSERT INTO public.import_run_chunks
        (tenant_id, run_id, chunk_index, row_count, rows_written, rows_skipped, rows_failed)
    VALUES (t1, r, 0, 500, 480, 15, 5);
    RAISE NOTICE '④ chunk 0 committed: ok';

    -- ⑤ 🔴 THE REPLAY. A chunk that timed out has often already committed, and
    --    the browser cannot tell "never arrived" from "arrived and the answer
    --    was lost". Both look identical from a laptop that went to sleep.
    BEGIN
        INSERT INTO public.import_run_chunks
            (tenant_id, run_id, chunk_index, row_count, rows_written, rows_skipped, rows_failed)
        VALUES (t1, r, 0, 500, 480, 15, 5);
        RAISE EXCEPTION '⑤ FAILED — chunk 0 was committed twice. A retry would double every count.';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE '⑤ a replayed chunk refused by the unique index: ok';
    END;

    UPDATE public.import_runs
       SET rows_written = 480, rows_skipped = 15, rows_failed = 5
     WHERE id = r;

    -- ⑥ 🔴 A RUN CANNOT BE COMPLETE WITH ROWS UNACCOUNTED FOR. This is the
    --    constraint that stops "your migration finished" from being a hope.
    BEGIN
        UPDATE public.import_runs
           SET status = 'completed', finished_at = now()
         WHERE id = r;
        RAISE EXCEPTION '⑥ FAILED — a run reported as completed with 500 of 1,000 rows accounted for';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑥ a half-finished run refused the completed status: ok';
    END;

    -- ⑦ AND STOPPING NEEDS A REASON.
    BEGIN
        UPDATE public.import_runs
           SET status = 'incomplete', finished_at = now()
         WHERE id = r;
        RAISE EXCEPTION '⑦ FAILED — a run stopped with no reason recorded';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑦ stopping without a reason refused: ok';
    END;

    -- ⑧ THE REST OF THE FILE ARRIVES, AND THEN IT MAY COMPLETE.
    INSERT INTO public.import_run_chunks
        (tenant_id, run_id, chunk_index, row_count, rows_written, rows_skipped, rows_failed)
    VALUES (t1, r, 1, 500, 500, 0, 0);
    UPDATE public.import_runs
       SET rows_written = 980, rows_skipped = 15, rows_failed = 5,
           status = 'completed', finished_at = now()
     WHERE id = r;
    RAISE NOTICE '⑧ every row accounted for, run completed: ok';

    -- ⑨ 🔴 A COMMITTED CHUNK IS A FACT.
    BEGIN
        UPDATE public.import_run_chunks SET rows_written = 500 WHERE run_id = r AND chunk_index = 0;
        RAISE EXCEPTION '⑨ FAILED — a committed chunk was edited';
    EXCEPTION WHEN raise_exception THEN
        IF sqlerrm LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑨ editing a committed chunk refused: ok';
    END;

    -- ⑩ 🔴 AN AUTOMATIC COMMIT MUST HAVE CLEARED THE THRESHOLD. The database
    --    refusing to hold a record that contradicts the code.
    BEGIN
        INSERT INTO public.import_mapping_proposals
            (tenant_id, run_id, proposed_for, entity_key, source_headers,
             proposal, confidence_milli, outcome)
        VALUES (t1, r, u1, 'companies', ARRAY['F1','F2'],
                '{"name":"F1"}'::jsonb, 700, 'auto');
        RAISE EXCEPTION
            '⑩ FAILED — a mapping was recorded as auto-committed at 70%% confidence. lib/import/proposal.ts says the threshold is 90%%.';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑩ an auto-commit below the threshold refused: ok';
    END;

    -- ⑪ A MODEL WAS EITHER USED, WITH A KEY, OR NOT USED AT ALL.
    BEGIN
        INSERT INTO public.import_mapping_proposals
            (tenant_id, proposed_for, entity_key, source_headers,
             proposal, confidence_milli, used_model)
        VALUES (t1, u1, 'companies', ARRAY['F1'], '{}'::jsonb, 950, true);
        RAISE EXCEPTION '⑪ FAILED — a model was recorded as used with nobody''s key';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑪ a model with no credential source refused: ok';
    END;

    INSERT INTO public.import_mapping_proposals
        (tenant_id, run_id, proposed_for, entity_key, source_headers,
         proposal, confidence_milli, used_model, model_source, outcome, corrections)
    VALUES (t1, r, u1, 'companies', ARRAY['F1','F2','F3'],
            '{"name":"F1","gstin":"F3"}'::jsonb, 950, true, 'tenant', 'corrected',
            '{"gstin":{"from":"F2","to":"F3"}}'::jsonb);
    RAISE NOTICE '⑫ a proposal a person corrected, with what they changed: ok';

    -- ⑬ 🔴 ISOLATION, WITH THE SELF-CHECK THAT MAKES IT MEAN ANYTHING.
    SELECT rolbypassrls INTO bypasses FROM pg_roles WHERE rolname = current_user;
    PERFORM set_config('app.current_tenant_id', t2::text, true);
    SELECT count(*) INTO n FROM public.import_runs;

    IF bypasses THEN
        RAISE EXCEPTION
            '⑬ INCONCLUSIVE — this role has BYPASSRLS, so the isolation check proves nothing whatever it returns. Re-run this drill as an owner with NOBYPASSRLS.';
    END IF;
    IF n <> 0 THEN
        RAISE EXCEPTION
            '⑬ FAILED — workspace 2 can see % of workspace 1''s migration runs, including their file names and row counts.', n;
    END IF;
    RAISE NOTICE '⑬ another workspace sees 0 runs, as a NOBYPASSRLS role: ok';

    RAISE NOTICE 'DRILL 0117 PASSED — 13 checks';
END
$d$;
