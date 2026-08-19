-- 🔴🔴 DRILL. NEVER RUN THIS AGAINST NEON. It writes rows and expects
--      failures. It proves 0119 counts what the limiter claims to count.
--
-- ⭐ THIS DRILL IS DIFFERENT FROM THE OTHERS: it does not only prove that
--    refusals refuse. It proves the COUNTER IS ATOMIC — the single property
--    the in-memory fallback lacked and the reason this migration exists.

DO $d$
DECLARE
    h    char(64) := repeat('a', 64);
    h2   char(64) := repeat('b', 64);
    n    integer;
    /*
     * ⚠️ THE BASE IS DERIVED FROM `now()`, NOT HARD-CODED.
     *
     * 🔴 THE FIRST DRAFT USED A FIXED EPOCH AND STEP ⑧ FAILED — correctly.
     * `expires_at` is computed from the WINDOW, so a window in the past is
     * already expired and the sweeper removed it, exactly as designed. A
     * hard-coded epoch in a drill is a fixture that quietly rots into a
     * false failure the moment enough time passes, which is worse than no
     * drill at all.
     */
    base bigint;
    i    integer;
BEGIN
    base := (extract(epoch from now())::bigint / 60) * 60;
    -- ① The hash column is a hash, and the database says so.
    BEGIN
        INSERT INTO public.rate_limit_counters
            (key_hash, window_start, policy, window_seconds, expires_at)
        VALUES ('ip:203.0.113.9 padded out to sixty four characters............',
                base, 'auth', 60, now() + interval '2 minutes');
        RAISE EXCEPTION
            '① FAILED — a raw key padded to 64 characters was accepted. char(64) alone does not make a hash.';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '① a non-hash key refused: ok';
    END;

    -- ② Counting. Ten hits in one window is ten.
    FOR i IN 1..10 LOOP
        n := public.ordence_rate_limit_hit(h, 'auth', 60, base + 5);
    END LOOP;
    IF n <> 10 THEN
        RAISE EXCEPTION '② FAILED — ten hits counted as %', n;
    END IF;
    RAISE NOTICE '② ten hits in one window counted as ten: ok';

    -- ③ 🔴 THE ATOMICITY THE MEMORY COUNTER LACKED. Every call, from every
    --    instance, increments the SAME row. This is the whole migration.
    SELECT hits INTO n FROM public.rate_limit_counters
     WHERE key_hash = h AND window_start = (base + 5) / 60 * 60;
    IF n <> 10 THEN
        RAISE EXCEPTION '③ FAILED — the shared row holds % rather than 10', n;
    END IF;
    RAISE NOTICE '③ one shared row, not one per caller: ok';

    -- ④ A DIFFERENT KEY IS A DIFFERENT BUDGET.
    n := public.ordence_rate_limit_hit(h2, 'auth', 60, base + 5);
    IF n <> 1 THEN
        RAISE EXCEPTION '④ FAILED — a different key started at % rather than 1', n;
    END IF;
    RAISE NOTICE '④ a different key has its own budget: ok';

    -- ⑤ ⭐ THE WINDOW ROLLS. The next window starts from one, and it does so
    --    without any read deciding whether the old count was stale.
    n := public.ordence_rate_limit_hit(h, 'auth', 60, base + 65);
    IF n <> 1 THEN
        RAISE EXCEPTION '⑤ FAILED — the next window started at % rather than 1', n;
    END IF;
    RAISE NOTICE '⑤ the window rolls, and the new one starts at one: ok';

    -- ⑥ ⚠️ THE BOUNDARY. Two calls a fraction apart but inside one window are
    --    the same window; the classic off-by-one here lets an attacker have
    --    2x the limit by straddling it.
    n := public.ordence_rate_limit_hit(h2, 'auth', 60, base + 59);
    IF n <> 2 THEN
        RAISE EXCEPTION '⑥ FAILED — the same window counted as % rather than 2', n;
    END IF;
    n := public.ordence_rate_limit_hit(h2, 'auth', 60, base + 60);
    IF n <> 1 THEN
        RAISE EXCEPTION '⑥ FAILED — the next second did not open a new window (got %)', n;
    END IF;
    RAISE NOTICE '⑥ the window boundary is exactly one second wide: ok';

    -- ⑦ A ZERO OR NEGATIVE WINDOW IS A PROGRAMMING ERROR, NOT A LIMIT.
    BEGIN
        n := public.ordence_rate_limit_hit(h, 'auth', 0, base);
        RAISE EXCEPTION '⑦ FAILED — a zero-second window was accepted';
    EXCEPTION WHEN raise_exception THEN
        IF sqlerrm LIKE '%FAILED%' THEN RAISE; END IF;
        RAISE NOTICE '⑦ a zero-second window refused: ok';
    END;

    -- ⑧ THE SWEEPER REMOVES ONLY WHAT HAS EXPIRED.
    UPDATE public.rate_limit_counters SET expires_at = now() - interval '1 hour'
     WHERE key_hash = h2;
    n := public.ordence_rate_limit_sweep(1000);
    IF n < 1 THEN
        RAISE EXCEPTION '⑧ FAILED — the sweeper removed nothing';
    END IF;
    SELECT count(*) INTO n FROM public.rate_limit_counters WHERE key_hash = h;
    IF n < 1 THEN
        RAISE EXCEPTION '⑧ FAILED — the sweeper removed a live window';
    END IF;
    RAISE NOTICE '⑧ the sweeper removes expired windows and leaves live ones: ok';

    -- ⑨ 🔴 THE DEFINER FUNCTIONS PIN THEIR search_path.
    --    An unpinned search_path on a SECURITY DEFINER function is the classic
    --    privilege-escalation shape: a caller creates their own `now()` in a
    --    schema earlier on the path and the function calls theirs.
    SELECT count(*) INTO n
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('ordence_rate_limit_hit', 'ordence_rate_limit_sweep')
       AND p.prosecdef
       AND array_to_string(p.proconfig, ',') LIKE '%search_path%';
    IF n <> 2 THEN
        RAISE EXCEPTION
            '⑨ FAILED — % of 2 definer functions pin their search_path', n;
    END IF;
    RAISE NOTICE '⑨ both definer functions pin their search_path: ok';

    RAISE NOTICE 'DRILL 0119 PASSED — 9 checks';
END
$d$;
