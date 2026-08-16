-- ############################################################################
-- VERIFY-0089 — READ-ONLY, NEON-SAFE. WHAT THE POLICIES ACTUALLY DO.
-- ############################################################################
--
--   psql -d <database> -f VERIFY-0089-neon-safe.sql
--
-- Writes nothing. Creates nothing. Every session setting it touches is
-- transaction-local and gone when the statement ends. Safe against Neon.
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 WHY THIS FILE WAS REWRITTEN: THE OLD ONE PRINTED "OK" ON A
--    DATABASE THAT WAS LEAKING TENANT DATA
-- ══════════════════════════════════════════════════════════════════════
-- 0089 shipped its platform policy as `FOR ALL USING (true) WITH CHECK
-- (app_platform_scope())`. Permissive policies are OR'd, and a `FOR ALL`
-- policy supplies USING for SELECT, so effective visibility became
-- `(tenant_id = mine) OR (true)` — every row of the table, to every
-- caller. Proven on a real PostgreSQL: a session pinned to tenant A read
-- tenant B's lockout row, and could DELETE it.
--
-- The old check number 3 in this file read:
--
--     (polcmd <> 'r' AND pg_get_expr(polwithcheck, polrelid)
--                       = 'app_platform_scope()')
--
-- It judged the `FOR ALL` policy on its WITH CHECK ALONE and never once
-- looked at `polqual` — the single clause that caused the leak. It also
-- asked whether the text of the policy MATCHED A STRING, which is a
-- question about shape. A policy can have exactly the right shape and
-- still admit the wrong rows, and no amount of string comparison will
-- say so.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⭐ SO THIS FILE ASKS BEHAVIOUR INSTEAD, AND SAYS WHAT IT ASKED
-- ══════════════════════════════════════════════════════════════════════
-- Section 2 pulls the LIVE predicates out of `pg_policy` — USING and
-- WITH CHECK, every policy, no exceptions — and EVALUATES them, under
-- simulated sessions, against a synthetic row belonging to a workspace
-- that is not the caller's. It then combines them the way PostgreSQL
-- does (permissive OR'd, restrictive AND'd, `FOR ALL` counting towards
-- every command) and reports the answer to the only question that
-- matters: WOULD THIS ROW BE VISIBLE / WRITABLE?
--
-- No row is created to do it. The synthetic row is a one-row subquery in
-- a SELECT; nothing is inserted, and the predicates are the database's
-- own, read back from the catalogue.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ WHAT THIS FILE HONESTLY CANNOT DO
-- ══════════════════════════════════════════════════════════════════════
-- ① IT CANNOT CREATE TWO TENANTS AND CROSS BETWEEN THEM. That is the
--    strongest possible proof and it requires writing rows to a real
--    database, which a Neon-safe verifier must never do. The two-tenant
--    proof lives in `DRILL-DO-NOT-RUN-IN-NEON-0089.sql`, which seeds a
--    row under each of two workspaces, reproduces the leak on purpose so
--    it can be seen, then installs the shipped policy and shows tenant A
--    getting exactly one row back. Run that on a throwaway Postgres.
-- ② IT CANNOT MAKE ITSELF A NON-PRIVILEGED ROLE. If you run this as the
--    Neon owner, section 3's live read is meaningless — the owner
--    bypasses RLS. Section 3 says so in its own output rather than
--    quietly reporting a pass.
-- ③ IT DOES NOT PROVE THE APPLICATION SCOPES ITS QUERIES. That is
--    `npm run check:rls-writes`, which is a different failure: correct
--    policies plus an unscoped client is a silent empty answer, not an
--    error. See `lib/security/lockout.ts`.
-- ############################################################################


\echo ''
\echo '================ VERIFY-0089 — login_lockouts ================'
\echo ''
\echo '=== 1. THE POLICIES, VERBATIM. BOTH CLAUSES. ==='
\echo '    Printed in full so a reader can see what section 2 evaluated.'
\echo '    `qual` is USING: it decides which existing rows SELECT, UPDATE'
\echo '    and DELETE may touch. `with_check` decides which NEW rows'
\echo '    INSERT and UPDATE may produce. A policy with cmd = ALL supplies'
\echo '    BOTH, for every command — which is how `USING (true)` leaked.'
\echo ''

SELECT
    p.polname                                   AS policy,
    CASE p.polcmd WHEN 'r' THEN 'SELECT'
                  WHEN 'a' THEN 'INSERT'
                  WHEN 'w' THEN 'UPDATE'
                  WHEN 'd' THEN 'DELETE'
                  WHEN '*' THEN 'ALL'
    END                                         AS cmd,
    CASE WHEN p.polpermissive THEN 'PERMISSIVE (OR''d)'
         ELSE 'RESTRICTIVE (AND''ed)' END       AS combines_as,
    coalesce(pg_get_expr(p.polqual, p.polrelid), '(none)')      AS using_clause,
    coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '(none)') AS with_check_clause
FROM pg_policy p
WHERE p.polrelid = to_regclass('public.login_lockouts')
ORDER BY p.polname;


\echo ''
\echo '=== 2. BEHAVIOUR. THE CHECK THE OLD FILE DID NOT DO. ==='
\echo '    Every policy''s LIVE predicate is evaluated against a synthetic'
\echo '    row, under a simulated session, and combined the way Postgres'
\echo '    combines them. Read the NOTICE lines: each one names the'
\echo '    session, the row, the command and the answer.'
\echo ''

DO $verify$
DECLARE
    TENANT_A  constant text := '11111111-1111-1111-1111-111111111111';
    TENANT_B  constant text := '22222222-2222-2222-2222-222222222222';

    rel       oid := to_regclass('public.login_lockouts');
    sc        record;
    pol       record;
    cols      text;
    expr      text;
    one       boolean;
    permitted boolean;
    blocked   boolean;
    effective boolean;
    failures  int := 0;
    checks    int := 0;
BEGIN
    IF rel IS NULL THEN
        RAISE EXCEPTION '🔴 login_lockouts does not exist. 0089 has not been applied here.';
    END IF;

    /*
     * ⭐ THE SCENARIOS. Each one is a sentence a human can check.
     *
     * `expect_allow = false` means: this caller must get NOTHING. The
     * boundary is proven by asking for the thing across it and being
     * refused, so every refusal below is paired with an `expect_allow =
     * true` row — otherwise a table that answers nobody would pass.
     */
    FOR sc IN
        SELECT * FROM (VALUES
          ('tenant A pinned, no platform marker', TENANT_A, '',   TENANT_B, 'r', 'u', false,
           'tenant A must not SEE tenant B''s lockout row'),
          ('tenant A pinned, no platform marker', TENANT_A, '',   TENANT_B, 'd', 'u', false,
           'tenant A must not DELETE tenant B''s lockout evidence'),
          ('tenant A pinned, no platform marker', TENANT_A, '',   NULL,     'r', 'u', false,
           'tenant A must not SEE unattributed platform evidence'),
          ('nothing set at all (bare pooled connection)', NULL,  '', TENANT_B, 'r', 'u', false,
           'an unscoped connection must SEE nothing'),
          ('nothing set at all (bare pooled connection)', NULL,  '', NULL,    'r', 'u', false,
           'an unscoped connection must SEE no platform evidence either'),
          ('nothing set at all (bare pooled connection)', NULL,  '', NULL,    'a', 'c', false,
           'an unscoped connection must not INSERT'),
          ('tenant A pinned, no platform marker', TENANT_A, '',   TENANT_A, 'a', 'c', false,
           'a tenant must not forge a lockout row for itself'),
          ('tenant A pinned, no platform marker', TENANT_A, '',   TENANT_A, 'r', 'u', true,
           'tenant A MUST still see its own attributed row'),
          ('platform marker set',                 NULL,     'on', TENANT_B, 'r', 'u', true,
           'the platform MUST still read across workspaces'),
          ('platform marker set',                 NULL,     'on', NULL,     'r', 'u', true,
           'the platform MUST still read its own unattributed evidence'),
          ('platform marker set',                 NULL,     'on', NULL,     'a', 'c', true,
           'the platform MUST still INSERT a lockout row'),
          ('platform marker set',                 NULL,     'on', NULL,     'w', 'u', true,
           'the platform MUST still find the row it is UPDATING'),
          ('platform marker set',                 NULL,     'on', NULL,     'w', 'c', true,
           'the platform MUST still be allowed the UPDATED row')
        ) AS s(session_name, tenant, platform, row_tenant, cmd, clause,
               expect_allow, what)
    LOOP
        /*
         * ⚠️ TRANSACTION-LOCAL, so nothing survives this DO block. A
         * verifier that changed a real session's settings would be a
         * write in everything but name.
         */
        PERFORM set_config('app.current_tenant_id', coalesce(sc.tenant, ''), true);
        PERFORM set_config('app.platform_scope',    sc.platform,             true);

        /*
         * The synthetic row: every column of the real table, NULL except
         * the tenant the scenario is about. Built from `pg_attribute` so
         * a predicate that reads any other column still evaluates rather
         * than erroring — and so this file does not go stale when a
         * column is added.
         */
        SELECT string_agg(
                 format('%s::%s AS %I',
                        CASE WHEN a.attname = 'tenant_id'
                             THEN coalesce(quote_literal(sc.row_tenant), 'NULL')
                             ELSE 'NULL' END,
                        format_type(a.atttypid, a.atttypmod),
                        a.attname),
                 ', ' ORDER BY a.attnum)
          INTO cols
          FROM pg_attribute a
         WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped;

        permitted := false;   -- any PERMISSIVE policy said yes
        blocked   := false;   -- some RESTRICTIVE policy said no

        FOR pol IN
            SELECT polname, polpermissive, polcmd,
                   pg_get_expr(polqual, polrelid)      AS q,
                   pg_get_expr(polwithcheck, polrelid) AS c
              FROM pg_policy
             WHERE polrelid = rel
               AND (polcmd = sc.cmd OR polcmd = '*')
        LOOP
            IF sc.clause = 'u' THEN
                expr := pol.q;
            ELSE
                /* ⚠️ Postgres falls back to USING when WITH CHECK is
                 * omitted. Modelling that is the difference between
                 * auditing the policy and auditing the DDL text. */
                expr := coalesce(pol.c, pol.q);
            END IF;
            CONTINUE WHEN expr IS NULL;

            EXECUTE format('SELECT coalesce((%s), false) FROM (SELECT %s) AS login_lockouts',
                           expr, cols)
               INTO one;

            IF pol.polpermissive THEN
                permitted := permitted OR one;
            ELSIF NOT one THEN
                blocked := true;
            END IF;
        END LOOP;

        effective := permitted AND NOT blocked;
        checks    := checks + 1;

        IF effective = sc.expect_allow THEN
            RAISE NOTICE '   ✅ % — % (evaluated % / %: got %)',
                sc.session_name, sc.what,
                CASE sc.cmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                            WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END,
                CASE sc.clause WHEN 'u' THEN 'USING' ELSE 'WITH CHECK' END,
                effective;
        ELSE
            failures := failures + 1;
            RAISE WARNING '   ❌ % — % (evaluated % / %: expected %, got %)',
                sc.session_name, sc.what,
                CASE sc.cmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                            WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END,
                CASE sc.clause WHEN 'u' THEN 'USING' ELSE 'WITH CHECK' END,
                sc.expect_allow, effective;
        END IF;
    END LOOP;

    RAISE NOTICE '';
    IF failures = 0 THEN
        RAISE NOTICE '   VERDICT: % behavioural checks, all as intended.', checks;
        RAISE NOTICE '   Checked: the USING clause AND the WITH CHECK clause of';
        RAISE NOTICE '   EVERY policy on login_lockouts, combined as Postgres';
        RAISE NOTICE '   combines them, for SELECT / INSERT / UPDATE / DELETE.';
    ELSE
        RAISE EXCEPTION
          '🔴 % of % behavioural checks FAILED. login_lockouts does not isolate as 0089 intends — see the ❌ lines above. Do not deploy.',
          failures, checks;
    END IF;
END
$verify$;


\echo ''
\echo '=== 3. THE LIVE READ, AND WHETHER IT MEANT ANYTHING ==='
\echo '    Section 2 evaluated predicates. This asks the table itself.'
\echo '    ⚠️ It is only evidence when the connected role does NOT bypass'
\echo '    RLS. The verdict column says which case you are in — a pass'
\echo '    under a bypassing role is reported as NOT PROVEN, not as OK.'
\echo ''

BEGIN;
SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true) AS pinned_tenant;

SELECT
    'live read as ' || current_user AS what,
    CASE
      WHEN (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
        THEN 'NOT PROVEN — ' || current_user || ' bypasses RLS, so this read '
             || 'saw everything regardless of policy. Re-run as ordence_app, '
             || 'or use DRILL-DO-NOT-RUN-IN-NEON-0089.sql.'
      WHEN (SELECT count(*) FROM login_lockouts
             WHERE tenant_id IS DISTINCT FROM '11111111-1111-1111-1111-111111111111'::uuid) = 0
        THEN 'OK — pinned to one workspace with no platform marker, this '
             || 'role could read no row belonging to any other workspace.'
      ELSE '🔴 LEAK — this role read rows belonging to other workspaces '
           || 'while pinned to one. Do not deploy.'
    END AS verdict;
COMMIT;


\echo ''
\echo '=== 4. RLS IS ON, AND FORCED EVEN FOR THE OWNER ==='
\echo ''

SELECT
    'rls' AS what,
    'ENABLE and FORCE ROW LEVEL SECURITY on login_lockouts' AS checked,
    CASE WHEN bool_and(relrowsecurity) AND bool_and(relforcerowsecurity) THEN 'OK'
         WHEN NOT bool_and(relrowsecurity) THEN '🔴 RLS NOT ENABLED — every policy above is inert'
         ELSE '🔴 NOT FORCED — the table owner bypasses all of it'
    END AS verdict
FROM pg_class WHERE relname = 'login_lockouts';


\echo ''
\echo '=== 5. THE TABLE SHAPE ==='
\echo ''

SELECT
    'table' AS what,
    'the 10 columns 0089 creates, by name' AS checked,
    CASE WHEN missing = '{}' THEN 'OK'
         ELSE '🔴 MISSING: ' || array_to_string(missing, ', ') END AS verdict
FROM (
  SELECT ARRAY(
    SELECT c FROM unnest(ARRAY['id','email','failed_attempts','locked_until',
                               'locked_reason','last_failure_at','tenant_id',
                               'actor_user_id','created_at','updated_at']) AS c
    EXCEPT
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'login_lockouts'
  ) AS missing
) s;


\echo ''
\echo '=== 6. GRANTS — WHAT ordence_app MAY ATTEMPT ==='
\echo '    ⚠️ A SECOND GATE, NOT THE SAME ONE. Grants decide what the'
\echo '    role may attempt; the policies in sections 1-2 decide which'
\echo '    rows it then reaches. Both must be right.'
\echo ''

SELECT
    'grants' AS what,
    'ordence_app holds SELECT, holds no DELETE or TRUNCATE, and has '
    || 'column privileges only on the lockout API''s own columns' AS checked,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
           THEN 'SKIPPED — role ordence_app does not exist on this database'
         WHEN has_table_privilege('ordence_app', 'login_lockouts', 'SELECT')
          AND NOT has_table_privilege('ordence_app', 'login_lockouts', 'DELETE')
          AND NOT has_table_privilege('ordence_app', 'login_lockouts', 'TRUNCATE')
          AND NOT EXISTS (
              SELECT 1 FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
              WHERE c.relname = 'login_lockouts'
                AND a.attname NOT IN ('email', 'failed_attempts', 'locked_until',
                                      'locked_reason', 'last_failure_at',
                                      'tenant_id', 'actor_user_id')
                AND a.attacl::text LIKE '%ordence_app%')
           THEN 'OK'
         ELSE '🔴 GRANTS WRONG — see \dp login_lockouts' END AS verdict;


\echo ''
\echo '=== 7. RESIDUE — NOBODY ELSE HOLDS ANYTHING ==='
\echo ''

SELECT
    'residue' AS what,
    'no role outside {ordence_app, ordence_test, postgres} holds any '
    || 'table privilege on login_lockouts' AS checked,
    CASE WHEN count(*) = 0 THEN 'OK'
         ELSE '🔴 UNINTENDED ACCESS: ' || string_agg(grantee, ', ') END AS verdict
FROM (
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_name = 'login_lockouts'
      AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      AND grantee NOT IN ('ordence_app', 'ordence_test', 'postgres')
) r;

\echo ''
\echo '=============== END VERIFY-0089 ==============================='
\echo ''
