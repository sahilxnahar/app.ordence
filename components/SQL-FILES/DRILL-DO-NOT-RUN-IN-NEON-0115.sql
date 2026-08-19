-- 🔴🔴 DRILL. NEVER RUN THIS AGAINST NEON. It writes rows and expects
--      failures.
DO $d$
DECLARE t uuid; caught text; n int;
BEGIN
    SELECT id INTO t FROM public.tenants LIMIT 1;

    -- ① a policy the resolver has never heard of is refused by the database
    BEGIN
        UPDATE public.tenants SET ai_credential_policy = 'byo-required' WHERE id = t;
        RAISE EXCEPTION '① FAILED — a misspelt policy was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '① misspelt policy refused: ok';
    END;

    -- ② the three real values are accepted
    UPDATE public.tenants SET ai_credential_policy = 'byo_required'     WHERE id = t;
    UPDATE public.tenants SET ai_credential_policy = 'byo_preferred'    WHERE id = t;
    UPDATE public.tenants SET ai_credential_policy = 'platform_allowed' WHERE id = t;
    RAISE NOTICE '② all three policies accepted: ok';

    -- ③ an ordinary usage row
    INSERT INTO public.ai_usage
        (tenant_id, provider_id, model, credential_source, prompt_tokens,
         completion_tokens, total_tokens, feature)
    VALUES (t, 'groq', 'llama-3.3-70b', 'tenant', 800, 200, 1000, 'assistant');
    RAISE NOTICE '③ a tenant-key call recorded: ok';

    -- ④ 🔴 A FAILURE MUST SAY WHY. A row saying "failed" and nothing else is
    --   one nobody can act on.
    BEGIN
        INSERT INTO public.ai_usage
            (tenant_id, provider_id, credential_source, feature, outcome)
        VALUES (t, 'groq', 'tenant', 'assistant', 'failed');
        RAISE EXCEPTION '④ FAILED — an unexplained failure was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '④ unexplained failure refused: ok';
    END;

    INSERT INTO public.ai_usage
        (tenant_id, provider_id, credential_source, feature, outcome, failure_kind,
         prompt_tokens)
    VALUES (t, 'groq', 'tenant', 'assistant', 'failed', 'rate_limited', 800);
    RAISE NOTICE '⑤ a failure that cost tokens IS recorded: ok';

    -- ⑥ an unknown credential source
    BEGIN
        INSERT INTO public.ai_usage
            (tenant_id, provider_id, credential_source, feature)
        VALUES (t, 'groq', 'ours', 'assistant');
        RAISE EXCEPTION '⑥ FAILED — an unknown credential source was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑥ unknown credential source refused: ok';
    END;

    -- ⑦ negative tokens are not a measurement
    BEGIN
        INSERT INTO public.ai_usage
            (tenant_id, provider_id, credential_source, feature, total_tokens)
        VALUES (t, 'groq', 'tenant', 'assistant', -5);
        RAISE EXCEPTION '⑦ FAILED — negative tokens were accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '⑦ negative tokens refused: ok';
    END;

    -- ⑧ ⚠️ NULL TOKENS ARE ALLOWED, and that is deliberate: not every
    --   provider returns usage, and a zero would be a measurement where NULL
    --   is the honest statement that the provider did not say.
    INSERT INTO public.ai_usage
        (tenant_id, provider_id, credential_source, feature)
    VALUES (t, 'cohere', 'platform', 'goal_planner');
    RAISE NOTICE '⑧ a provider that reported no usage: ok';

    -- ⑨ 🔴 APPEND-ONLY. The edit somebody wants is always the one that lowers
    --   a number.
    BEGIN
        UPDATE public.ai_usage SET total_tokens = 1 WHERE tenant_id = t;
        RAISE EXCEPTION '⑨ FAILED — a usage row was edited';
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS caught = MESSAGE_TEXT;
        IF caught LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑨ editing a usage row refused: ok';
    END;

    BEGIN
        DELETE FROM public.ai_usage WHERE tenant_id = t;
        RAISE EXCEPTION '⑩ FAILED — a usage row was deleted';
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS caught = MESSAGE_TEXT;
        IF caught LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑩ deleting a usage row refused: ok';
    END;

    -- ⑪ ⭐ AND THE QUESTION THE TABLE EXISTS FOR ACTUALLY ANSWERS
    SELECT count(*) INTO n FROM public.ai_usage
     WHERE tenant_id = t AND credential_source = 'platform';
    IF n <> 1 THEN
        RAISE EXCEPTION '⑪ FAILED — expected 1 platform-funded call, found %', n;
    END IF;
    RAISE NOTICE '⑪ "how many calls did this workspace put on OUR key" answers: ok';

    RAISE NOTICE 'DRILL 0115 PASSED';
END
$d$;
