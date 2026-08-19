-- 🔴🔴 DRILL. NEVER RUN THIS AGAINST NEON. It writes rows and expects
--      failures. It proves 0114's constraints and guard refuse what the
--      header claims they refuse.
DO $d$
DECLARE t uuid; u uuid; u2 uuid; r uuid; caught text;
BEGIN
    INSERT INTO public.tenants DEFAULT VALUES RETURNING id INTO t;
    INSERT INTO public.users (status) VALUES ('pending_seat') RETURNING id INTO u;
    INSERT INTO public.users (status) VALUES ('pending_seat') RETURNING id INTO u2;
    RAISE NOTICE '① pending_seat is a usable status: ok';

    -- ② a grant needs a real reason
    BEGIN
        INSERT INTO public.seat_grants (tenant_id, seats, reason) VALUES (t, 1, 'ok');
        RAISE EXCEPTION '② FAILED — a two-character reason was accepted';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE '② short reason refused: ok';
    END;

    -- ③ a grant of zero seats is not a grant
    BEGIN
        INSERT INTO public.seat_grants (tenant_id, seats, reason)
        VALUES (t, 0, 'enterprise deal signed, not yet billed');
        RAISE EXCEPTION '③ FAILED — a zero-seat grant was accepted';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE '③ zero-seat grant refused: ok';
    END;

    INSERT INTO public.seat_grants (tenant_id, seats, reason)
    VALUES (t, 3, 'migration in progress, comped until 31 March');
    RAISE NOTICE '④ a real grant: ok';

    -- ⑤ revoking needs a reason too
    BEGIN
        UPDATE public.seat_grants SET revoked_at = now() WHERE tenant_id = t;
        RAISE EXCEPTION '⑤ FAILED — a revocation with no reason was accepted';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE '⑤ revocation without reason refused: ok';
    END;

    -- ⑥ a request, and its frozen seat position
    INSERT INTO public.seat_requests
        (tenant_id, user_id, source, seats_used_at_request, seats_available_at_request)
    VALUES (t, u, 'identity_provider', 10, 0) RETURNING id INTO r;
    RAISE NOTICE '⑥ a parked person: ok';

    -- ⑦ 🔴 THE REPLAY. Clerk replays membership events on purpose, and this
    --   codebase has been bitten by it before. A second open request for the
    --   same person would let an owner approve a seat for somebody who
    --   already has one.
    BEGIN
        INSERT INTO public.seat_requests
            (tenant_id, user_id, source, seats_used_at_request, seats_available_at_request)
        VALUES (t, u, 'identity_provider', 10, 0);
        RAISE EXCEPTION '⑦ FAILED — a duplicate open request was accepted';
    EXCEPTION WHEN unique_violation THEN RAISE NOTICE '⑦ duplicate open request refused: ok';
    END;

    -- ⑧ a resolution without a time is half a decision
    BEGIN
        UPDATE public.seat_requests SET resolution = 'approved' WHERE id = r;
        RAISE EXCEPTION '⑧ FAILED — a resolution with no timestamp was accepted';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE '⑧ half-recorded resolution refused: ok';
    END;

    -- ⑨ declining needs a reason; approving does not
    BEGIN
        UPDATE public.seat_requests
           SET resolution = 'declined', resolved_at = now() WHERE id = r;
        RAISE EXCEPTION '⑨ FAILED — a decline with no reason was accepted';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE '⑨ decline without reason refused: ok';
    END;

    UPDATE public.seat_requests
       SET resolution = 'approved', resolved_at = now() WHERE id = r;
    RAISE NOTICE '⑩ approval needs no reason, because the seat count explains it: ok';

    -- ⑪ 🔴 AND A RESOLVED REQUEST DOES NOT UNMAKE ITSELF
    BEGIN
        UPDATE public.seat_requests
           SET resolution = 'declined', resolution_reason = 'changed my mind about this'
         WHERE id = r;
        RAISE EXCEPTION '⑪ FAILED — a resolved request was reopened';
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS caught = MESSAGE_TEXT;
        IF caught LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑪ reopening a resolved request refused: ok';
    END;

    -- ⑫ ⚠️ AND THE UNIQUE INDEX IS PARTIAL, so the same person CAN be parked
    --   again after the first request is closed. A person declined in March
    --   and hired properly in June is two requests, not an error.
    INSERT INTO public.seat_requests
        (tenant_id, user_id, source, seats_used_at_request, seats_available_at_request)
    VALUES (t, u, 'invite', 12, 0);
    RAISE NOTICE '⑫ a second request after the first was closed: ok';

    RAISE NOTICE 'DRILL 0114 PASSED';
END
$d$;
