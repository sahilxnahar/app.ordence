-- 🔴🔴 DRILL. NEVER RUN THIS AGAINST NEON.
--
-- ⭐ THIS ONE DOES NOT TEST 0115. It tests the REASON 0115 is shaped the way
--   it is, and it is here because the reason is invisible in the file itself.
--
-- `check:sql-rls-writes` refused the first draft, which grandfathered existing
-- workspaces with a bare `UPDATE public.tenants`. `tenants` has FORCE ROW
-- LEVEL SECURITY, so that UPDATE affects ZERO ROWS for any role without
-- BYPASSRLS — and it reports `UPDATE 0` rather than an error.
--
-- ⚠️ THE FAILURE THAT FOLLOWS IS LOUD BUT POINTS AT THE WRONG THING. The next
--    statement, `SET NOT NULL`, fails with
--
--        ERROR: column "ai_credential_policy" of relation "tenants"
--               contains null values
--
--    which says nothing about row-level security. You would be left with the
--    column added, the default set, nobody grandfathered, and an error message
--    sending you to look at the data. On the deploy where you change who pays
--    for AI.
--
-- 🔴 RUN THIS AS A ROLE THAT OWNS THE TABLE AND DOES *NOT* HAVE BYPASSRLS.
--    Running it as a superuser or as `neondb_owner` proves nothing: both
--    bypass RLS unconditionally, so the bare UPDATE would appear to work.
--    That is exactly how this class of bug reaches production.

DO $d$
DECLARE n int;
BEGIN
    -- ① The bare UPDATE, as the refused draft had it.
    UPDATE public.tenants SET ai_credential_policy = 'platform_allowed'
     WHERE ai_credential_policy IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION
            '① FAILED — % rows were updated without a platform scope. This role bypasses RLS, so this drill proves nothing. Re-run it as an owner with NOBYPASSRLS.', n;
    END IF;
    RAISE NOTICE '① a bare UPDATE on tenants touched 0 rows, silently: confirmed';

    -- ② And the shape 0115 actually uses.
    PERFORM set_config('app.platform_scope', 'on', true);
    UPDATE public.tenants SET ai_credential_policy = 'platform_allowed'
     WHERE ai_credential_policy IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
        RAISE EXCEPTION '② FAILED — the platform scope did not help. Nobody would be grandfathered.';
    END IF;
    RAISE NOTICE '② with app.platform_scope set, % workspace(s) grandfathered: ok', n;

    RAISE NOTICE 'DRILL 0115b PASSED — the gate was right';
END
$d$;
