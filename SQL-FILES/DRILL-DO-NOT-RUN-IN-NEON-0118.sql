-- 🔴🔴 DRILL. NEVER RUN THIS AGAINST NEON. It writes rows and expects
--      failures. It proves 0118's constraints and guards refuse what the
--      header claims they refuse.
--
-- 🔴 RUN IT AS A ROLE THAT OWNS THE TABLES AND DOES *NOT* HAVE BYPASSRLS.
--    Step ⑭ self-checks this and refuses a false pass.

DO $d$
DECLARE
    t1 uuid; t2 uuid; u1 uuid; doc1 uuid; doc2 uuid;
    d1 uuid; p1 uuid; rB uuid; rC uuid; m1 uuid;
    n int; bypasses boolean;
BEGIN
    INSERT INTO public.tenants   DEFAULT VALUES RETURNING id INTO t1;
    INSERT INTO public.tenants   DEFAULT VALUES RETURNING id INTO t2;
    INSERT INTO public.users     DEFAULT VALUES RETURNING id INTO u1;
    INSERT INTO public.documents DEFAULT VALUES RETURNING id INTO doc1;
    INSERT INTO public.documents DEFAULT VALUES RETURNING id INTO doc2;
    p1 := gen_random_uuid();

    PERFORM set_config('app.current_tenant_id', t1::text, true);

    INSERT INTO public.drawings (tenant_id, drawing_number, title, project_id, created_by)
    VALUES (t1, 'DRG-102', 'Ground floor plan', p1, u1) RETURNING id INTO d1;
    RAISE NOTICE '① a drawing: ok';

    -- ② 🔴 TWO SHEETS SHARING A NUMBER IS HOW A SITE BUILDS TO THE WRONG ONE.
    --    And the match is case-insensitive and space-insensitive, because
    --    "drg-102 " and "DRG-102" are the same sheet to everybody except SQL.
    BEGIN
        INSERT INTO public.drawings (tenant_id, drawing_number, title, project_id, created_by)
        VALUES (t1, '  drg-102 ', 'Someone else''s ground floor', p1, u1);
        RAISE EXCEPTION '② FAILED — a duplicate drawing number was accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE '② duplicate drawing number refused, ignoring case and spaces: ok';
    END;

    -- ③ ⚠️ AND THE PROJECT-LESS CASE IS COVERED TOO. A single unique index on
    --    (tenant, project, number) would NOT catch this, because NULL is not
    --    equal to NULL in SQL and every project-less row is distinct.
    INSERT INTO public.drawings (tenant_id, drawing_number, title, created_by)
    VALUES (t1, 'TENDER-01', 'Tender issue', u1);
    BEGIN
        INSERT INTO public.drawings (tenant_id, drawing_number, title, created_by)
        VALUES (t1, 'tender-01', 'The same number again', u1);
        RAISE EXCEPTION '③ FAILED — two project-less drawings shared a number';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE '③ duplicate number with no project refused: ok';
    END;

    -- ④ A revision, with the unit the file declared.
    INSERT INTO public.drawing_revisions
        (tenant_id, drawing_id, revision, revision_order, document_id,
         source_format, entity_count, layer_count, declared_unit, uploaded_by)
    VALUES (t1, d1, 'B', 2, doc1, 'dxf', 4120, 18, 'millimetres', u1)
    RETURNING id INTO rB;
    RAISE NOTICE '④ revision B, in millimetres as the file said: ok';

    -- ⑤ 🔴 AN ASSUMPTION IS SOMEBODY'S ASSUMPTION.
    BEGIN
        UPDATE public.drawing_revisions SET assumed_unit = 'metres' WHERE id = rB;
        RAISE EXCEPTION '⑤ FAILED — an assumed unit with nobody''s name on it was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑤ an unattributed unit assumption refused: ok';
    END;

    -- ⑥ ⚠️ AND YOU DO NOT ASSUME WHAT THE FILE ALREADY TOLD YOU.
    BEGIN
        UPDATE public.drawing_revisions
           SET assumed_unit = 'metres', assumed_by = u1, assumed_at = now()
         WHERE id = rB;
        RAISE EXCEPTION '⑥ FAILED — an assumption was recorded over a declared unit';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑥ assuming over a declared unit refused: ok';
    END;

    -- ⑦ Two revisions cannot share a label, or an order.
    BEGIN
        INSERT INTO public.drawing_revisions
            (tenant_id, drawing_id, revision, revision_order, document_id,
             source_format, uploaded_by)
        VALUES (t1, d1, 'b', 3, doc2, 'dxf', u1);
        RAISE EXCEPTION '⑦ FAILED — two revisions both called B';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE '⑦ duplicate revision label refused: ok';
    END;

    INSERT INTO public.drawing_revisions
        (tenant_id, drawing_id, revision, revision_order, document_id,
         source_format, uploaded_by)
    VALUES (t1, d1, 'C', 3, doc2, 'dxf', u1) RETURNING id INTO rC;

    UPDATE public.drawing_revisions SET superseded_at = now() WHERE id = rB;
    UPDATE public.drawings SET current_revision_id = rC WHERE id = d1;
    RAISE NOTICE '⑧ revision C issued, B superseded: ok';

    -- ⑨ 🔴 A SUPERSEDED REVISION IS FROZEN. Rev B is what the slab was poured
    --    against.
    BEGIN
        UPDATE public.drawing_revisions SET notes = 'tidied up' WHERE id = rB;
        RAISE EXCEPTION '⑨ FAILED — a superseded revision was edited';
    EXCEPTION WHEN raise_exception THEN
        IF sqlerrm LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑨ editing a superseded revision refused: ok';
    END;

    -- ⑩ ⭐ AND THE ONE EXCEPTION WORKS: withdrawing a revision issued in error.
    UPDATE public.drawing_revisions SET superseded_at = NULL WHERE id = rB;
    UPDATE public.drawing_revisions SET superseded_at = now() WHERE id = rB;
    RAISE NOTICE '⑩ un-superseding, for a revision issued in error: ok';

    -- ⑪ A markup is an overlay, and a text markup says something.
    BEGIN
        INSERT INTO public.drawing_markups (tenant_id, revision_id, kind, points, created_by)
        VALUES (t1, rC, 'text', '[{"x":10,"y":10}]'::jsonb, u1);
        RAISE EXCEPTION '⑪ FAILED — a text markup with no text was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑪ an empty text markup refused: ok';
    END;

    INSERT INTO public.drawing_markups (tenant_id, revision_id, kind, points, body, created_by)
    VALUES (t1, rC, 'cloud', '[{"x":0,"y":0},{"x":100,"y":100}]'::jsonb,
            'Check the lintel level against the structural drawing', u1);
    RAISE NOTICE '⑫ a cloud markup, in drawing coordinates: ok';

    -- ⑬ 🔴 EXACT MEANS EXACT.
    BEGIN
        INSERT INTO public.drawing_measurements
            (tenant_id, revision_id, kind, label, value_si, max_error_si, is_exact,
             unit_basis, unit_was_assumed, points, taken_by)
        VALUES (t1, rC, 'area', 'Slab', 412.15, 0.004, true,
                'millimetres', false, '[]'::jsonb, u1);
        RAISE EXCEPTION '⑬ FAILED — a measurement was flagged exact with an error bound on it';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑬ an exact measurement with an error bound refused: ok';
    END;

    INSERT INTO public.drawing_measurements
        (tenant_id, revision_id, kind, label, value_si, max_error_si, is_exact,
         unit_basis, unit_was_assumed, points, taken_by)
    VALUES (t1, rC, 'area', 'Ground floor slab', 412.15, 0.004, false,
            'millimetres', false, '[{"x":0,"y":0}]'::jsonb, u1)
    RETURNING id INTO m1;

    -- ⑭ A measurement may be attached to a BOQ line and not otherwise touched.
    UPDATE public.drawing_measurements SET boq_item_id = gen_random_uuid() WHERE id = m1;
    RAISE NOTICE '⑭ attaching a measurement to a BOQ line: ok';

    BEGIN
        UPDATE public.drawing_measurements SET value_si = 500 WHERE id = m1;
        RAISE EXCEPTION '⑮ FAILED — a measured quantity was edited';
    EXCEPTION WHEN raise_exception THEN
        IF sqlerrm LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑮ editing a measured quantity refused: ok';
    END;

    -- ⑯ 🔴 ISOLATION, WITH THE SELF-CHECK THAT MAKES IT MEAN ANYTHING.
    SELECT rolbypassrls INTO bypasses FROM pg_roles WHERE rolname = current_user;
    PERFORM set_config('app.current_tenant_id', t2::text, true);
    SELECT count(*) INTO n FROM public.drawings;

    IF bypasses THEN
        RAISE EXCEPTION
            '⑯ INCONCLUSIVE — this role has BYPASSRLS, so the isolation check proves nothing whatever it returns. Re-run this drill as an owner with NOBYPASSRLS.';
    END IF;
    IF n <> 0 THEN
        RAISE EXCEPTION
            '⑯ FAILED — workspace 2 can see % of workspace 1''s drawings.', n;
    END IF;
    RAISE NOTICE '⑯ another workspace sees 0 drawings, as a NOBYPASSRLS role: ok';

    RAISE NOTICE 'DRILL 0118 PASSED — 16 checks';
END
$d$;
