-- =====================================================================
-- VERIFY 0091  ·  SAFE TO RUN IN NEON  ·  Repo: app.ordence
-- =====================================================================
--
-- Run this AFTER `0091_slug_authority.sql`.
--
-- ⚠️ IT IS NOT PURELY READ-ONLY, AND THAT IS DELIBERATE. Sections 1 to 6
--    only read catalogs. Section 7 actually ATTEMPTS four refusals plus
--    one CONTROL that must be accepted, and reports which SQLSTATE came
--    back in each case, because a policy that exists in
--    pg_catalog and a policy that actually refuses are different claims,
--    and this project has already shipped a verify file that printed
--    "policies OK" over a real cross-tenant leak.
--
--    🔴 Every attempt in section 7 runs inside a subtransaction that is
--    ROLLED BACK. It creates no tenant, it modifies no row, and it leaves
--    nothing behind except a probe FUNCTION that tab 9 drops. Read section
--    7's own comment if you want to satisfy yourself of that.
--
--    ⚠️ Section 7 used a TEMP table and did not work: a browser console
--       sends each statement on its own connection, and a temp table is
--       session-scoped, so it was created on one connection and read from
--       another. It is a function now, because a function lives in the
--       catalog rather than the session.
--
-- ⚠️ NO `\echo`, NO `RAISE NOTICE`. Both are invisible or unsupported in
--    the Neon editor. Everything comes back as a result ROW. This file was
--    written after `VERIFY-0089` failed in your editor for exactly that
--    reason.
--
-- SEND ME TAB 8. It is one row per thing 0091 promised.
--
-- ⚠️ RUN `STATE-OF-0091-neon-safe.sql` FIRST if you have not. 0091 applied
--    only partially once, and this file assumes its objects exist.
-- =====================================================================


-- =====================================================================
-- TAB 1 · THE TWO CHECK CONSTRAINTS ON tenants
-- =====================================================================
SELECT
    'TAB 1 · check constraints'   AS section,
    con.conname                   AS constraint_name,
    pg_get_constraintdef(con.oid) AS definition,
    con.convalidated              AS validated
FROM pg_constraint con
WHERE con.conrelid = 'public.tenants'::regclass
  AND con.conname IN ('tenants_slug_lowercase', 'tenants_slug_shape')
ORDER BY con.conname;

-- ⚠️ `validated = false` would mean the constraint exists but was added
--    NOT VALID and is not being applied to existing rows. 0091 never does
--    that. If you see false, something else added it.


-- =====================================================================
-- TAB 2 · THE RESERVED LIST
-- =====================================================================
SELECT
    'TAB 2 · reserved_slugs'      AS section,
    category                      AS category,
    count(*)                      AS names,
    string_agg(slug, ', ' ORDER BY slug) AS the_names
FROM public.reserved_slugs
GROUP BY category
ORDER BY
    CASE category
        WHEN 'certificate' THEN 1
        WHEN 'impersonate' THEN 2
        WHEN 'mail'        THEN 3
        WHEN 'money'       THEN 4
        WHEN 'identity'    THEN 5
        ELSE 6
    END;

-- Expected: 71 names total. The `certificate` group must contain exactly
-- abuse, hostmaster, postmaster, webmaster. Those four are the addresses a
-- certificate authority will accept as proof of domain control, and they
-- are the ones the two original TypeScript lists both missed.


-- =====================================================================
-- TAB 3 · THE FOLD COLUMN AND ITS UNIQUE INDEX
-- =====================================================================
SELECT
    'TAB 3 · fold'                        AS section,
    a.attname                             AS column_name,
    a.attgenerated = 's'                  AS is_stored_generated,
    pg_get_expr(d.adbin, d.adrelid)       AS generation_expression
FROM pg_attribute a
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = 'public.tenants'::regclass
  AND a.attname  = 'slug_fold'
  AND NOT a.attisdropped;

-- 🔴 CHECK THE EXPRESSION CHARACTER BY CHARACTER. It must read
--    translate(replace(replace(replace(slug, '-'::text, ''::text),
--    'rn'::text, 'm'::text), 'vv'::text, 'w'::text), '01l'::text, 'oii'::text)
--    The final argument is 'oii', NOT 'oli'. The first draft of this
--    migration used 'oli', which maps `1` to `l` instead of to `i`, and
--    `zedbui1ders` walked straight past this index. It looked right and it
--    was wrong. Read the last three characters.

SELECT
    'TAB 3 · indexes on tenants'  AS section,
    i.relname                     AS index_name,
    idx.indisunique               AS is_unique,
    pg_get_indexdef(idx.indexrelid) AS definition
FROM pg_index idx
JOIN pg_class i ON i.oid = idx.indexrelid
WHERE idx.indrelid = 'public.tenants'::regclass
  AND i.relname IN ('tenants_slug_unique', 'tenants_slug_fold_unique')
ORDER BY i.relname;


-- =====================================================================
-- TAB 4 · SLUG HISTORY, ITS INDEXES AND ITS RLS
-- =====================================================================
SELECT
    'TAB 4 · history table'       AS section,
    c.relname                     AS table_name,
    c.relrowsecurity              AS rls_enabled,
    c.relforcerowsecurity         AS rls_forced,
    (SELECT count(*) FROM pg_index x WHERE x.indrelid = c.oid) AS index_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('tenant_slug_history', 'reserved_slugs')
ORDER BY c.relname;

-- 🔴 `rls_forced` MUST be true on both. ENABLE alone does not apply to the
--    table OWNER, and the application connects as the owner on Neon, so
--    ENABLE without FORCE is decoration.

SELECT
    'TAB 4 · policies'            AS section,
    p.tablename                   AS table_name,
    p.policyname                  AS policy_name,
    p.cmd                         AS applies_to,
    p.qual                        AS using_clause,
    p.with_check                  AS with_check_clause
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.tablename IN ('tenant_slug_history', 'reserved_slugs')
ORDER BY p.tablename, p.policyname;

-- ⚠️ WHAT TO LOOK FOR, AND WHY THE `reserved_slugs` READ POLICY IS NOT THE
--    BUG THAT 0089 FIXED.
--
--    `reserved_slugs_read` is `FOR SELECT USING (true)`. That is correct:
--    the list contains no tenant data and no secret, its contents are
--    shipped to every browser inside lib/slug.ts, and the guard needs to
--    read it. In 0089 the problem was a `FOR ALL ... USING (true)` on a
--    table full of TENANT rows, which supplied USING for SELECT and erased
--    the tenant read boundary. Two different things. The read and write
--    policies are separate here precisely so they cannot be confused.
--
--    `tenant_slug_history_read` MUST name `app_current_tenant_id`.
--    `tenant_slug_history_write` MUST have `app_platform_scope()` in
--    WITH CHECK and MUST still name the tenant in USING.


-- =====================================================================
-- TAB 5 · THE GUARD, AND ITS TWO SAFETY PROPERTIES
-- =====================================================================
SELECT
    'TAB 5 · guard'                    AS section,
    p.proname                          AS function_name,
    p.prosecdef                        AS is_security_definer,
    array_to_string(p.proconfig, ', ') AS pinned_settings,
    r.rolname                          AS owned_by
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r     ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.proname = 'ordence_guard_tenant_slug';

-- 🔴 BOTH OF THESE MUST BE TRUE, AND THEY ARE TWO HALVES OF ONE DECISION.
--
--    is_security_definer = true, because a guard that reads a table
--    through RLS FAILS OPEN: if the session cannot see the
--    tenant_slug_history rows, the lookup returns nothing, the guard
--    concludes "not recently released", and the claim is ALLOWED. The
--    refusal silently becomes a permission and nothing logs it. This was
--    proved, not assumed: with SECURITY INVOKER, a squatter successfully
--    claimed a slug released five days earlier.
--
--    pinned_settings must contain `search_path=public, pg_temp`, because
--    SECURITY DEFINER without a pinned search_path is a privilege
--    escalation: anyone able to create a schema earlier in the path can
--    shadow reserved_slugs with an empty table and the guard reads that.

SELECT
    'TAB 5 · trigger'             AS section,
    t.tgname                      AS trigger_name,
    pg_get_triggerdef(t.oid)      AS definition,
    t.tgenabled = 'O'             AS enabled_in_origin_mode
FROM pg_trigger t
WHERE t.tgrelid = 'public.tenants'::regclass
  AND NOT t.tgisinternal
  AND t.tgname = 'ordence_guard_tenant_slug';

-- ⚠️ The definition must read BEFORE INSERT OR UPDATE OF slug. The column
--    list keeps ordinary tenant settings saves off this path.


-- =====================================================================
-- TAB 6 · BACKFILL COMPLETENESS
-- =====================================================================
SELECT
    'TAB 6 · backfill'                                          AS section,
    (SELECT count(*) FROM public.tenants)                       AS tenants,
    (SELECT count(*) FROM public.tenant_slug_history)           AS history_rows,
    (SELECT count(*) FROM public.tenants t
       WHERE NOT EXISTS (SELECT 1 FROM public.tenant_slug_history h
                         WHERE h.tenant_id = t.id AND h.slug = t.slug))
                                                                AS tenants_with_no_history,
    (SELECT count(*) FROM public.tenant_slug_history h
       JOIN public.tenants t ON t.id = h.tenant_id
      WHERE h.released_at IS NULL AND h.slug <> t.slug)         AS open_rows_naming_a_stale_slug;

-- `tenants_with_no_history` must be 0, otherwise the first rename of that
-- workspace has nothing to close and its old hostname is never retained.
-- `open_rows_naming_a_stale_slug` must be 0: an OPEN history row that names
-- a slug the tenant no longer holds means a rename closed the wrong row.


-- =====================================================================
-- TAB 7 · THE GUARD ACTUALLY REFUSES  (attempts, then rolls back)
-- =====================================================================
--
-- 🔴 THIS WAS A TEMP TABLE AND A `DO` BLOCK ACROSS THREE STATEMENTS, AND
--    THAT DOES NOT WORK IN A BROWSER SQL CONSOLE.
--
--    The console sends each statement on its own connection. A TEMP table
--    is session-scoped, so it was created on one connection, written on a
--    second and read from a third, and the third reported
--    `relation "verify_0091_findings" does not exist`.
--
--    Same root cause as `SET LOCAL` evaporating in 0092 and as 0091's
--    `BEGIN;` providing no atomicity: **nothing session-scoped or
--    transaction-scoped survives between statements here.**
--
-- ⭐ A FUNCTION DOES SURVIVE, because it lives in the catalog rather than
--    in the session. So the probes are a function, called by the next
--    statement, and dropped by the last one. Each statement stands alone.
--
-- ⚠️ WHAT IT DOES TO YOUR DATA: nothing. Each attempt runs in a
--    `BEGIN ... EXCEPTION` block, which in PL/pgSQL is a SUBTRANSACTION,
--    and catching the exception rolls that subtransaction back. The one
--    attempt that SUCCEEDS (the control) raises a private SQLSTATE on
--    purpose so that it is undone too. No tenant is created.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.ordence_verify_0091()
RETURNS TABLE (
    ord          int,
    attempt      text,
    expected     text,
    got_sqlstate text,
    verdict      text,
    got_message  text
)
LANGUAGE plpgsql
AS $verify$
DECLARE
    v_state  text;
    v_msg    text;
    v_probe  text;
    v_target text;
BEGIN
    -- 🔴 `tenants` carries FORCE ROW LEVEL SECURITY from 0014. Without this
    --    every attempt below is refused by RLS rather than by the thing being
    --    tested, the CONTROL reads "the guard is refusing legal names", and
    --    rows 2 to 5 report PASS for the wrong reason.
    PERFORM set_config('app.platform_scope', 'on', true);

    -- 0 · CONTROL: a legal slug must be ACCEPTED. Without this row, a guard
    --     that refused everything would score four out of four.
    v_state := NULL; v_msg := NULL;
    BEGIN
        INSERT INTO public.tenants (clerk_org_id, slug, name)
        VALUES ('verify0091:probe', 'zzverify0091probe', 'VERIFY 0091 control');
        RAISE EXCEPTION USING ERRCODE = 'P0098', MESSAGE = 'control rollback';
    EXCEPTION
        WHEN SQLSTATE 'P0098' THEN NULL;          -- accepted, and now undone
        WHEN OTHERS THEN v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    ord := 1; attempt := 'CONTROL: a fresh, legal slug'; expected := 'ACCEPTED';
    got_sqlstate := coalesce(v_state,'none'); got_message := v_msg;
    verdict := CASE WHEN v_state IS NULL THEN 'PASS'
                    ELSE 'FAIL, the guard is refusing legal names' END;
    RETURN NEXT;

    -- 1 · reserved name
    v_state := NULL; v_msg := NULL;
    BEGIN
        INSERT INTO public.tenants (clerk_org_id, slug, name)
        VALUES ('verify0091:r', 'postmaster', 'VERIFY 0091');
    EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    ord := 2; attempt := 'reserved name "postmaster"'; expected := 'P0091';
    got_sqlstate := coalesce(v_state,'none'); got_message := v_msg;
    verdict := CASE WHEN v_state = 'P0091' THEN 'PASS'
                    WHEN v_state IS NULL    THEN 'FAIL, it was ACCEPTED'
                    ELSE 'FAIL, wrong SQLSTATE' END;
    RETURN NEXT;

    -- 2 · mixed case. 🔴 This is the one that closes a LIVE duplicate:
    --     normaliseHost() lowercases the Host header, so `Acme` and `acme`
    --     both answer to acme.ordence.com and the old index compared bytes.
    v_state := NULL; v_msg := NULL;
    BEGIN
        INSERT INTO public.tenants (clerk_org_id, slug, name)
        VALUES ('verify0091:u', 'ZZVerify0091', 'VERIFY 0091');
    EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    ord := 3; attempt := 'mixed-case slug "ZZVerify0091"';
    expected := '23514 tenants_slug_lowercase';
    got_sqlstate := coalesce(v_state,'none'); got_message := v_msg;
    verdict := CASE WHEN v_state = '23514' THEN 'PASS'
                    WHEN v_state IS NULL    THEN 'FAIL, it was ACCEPTED'
                    ELSE 'FAIL, wrong SQLSTATE' END;
    RETURN NEXT;

    -- 3 · two characters
    v_state := NULL; v_msg := NULL;
    BEGIN
        INSERT INTO public.tenants (clerk_org_id, slug, name)
        VALUES ('verify0091:s', 'zz', 'VERIFY 0091');
    EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    ord := 4; attempt := 'two-character slug "zz"';
    expected := '23514 tenants_slug_shape';
    got_sqlstate := coalesce(v_state,'none'); got_message := v_msg;
    verdict := CASE WHEN v_state = '23514' THEN 'PASS'
                    WHEN v_state IS NULL    THEN 'FAIL, it was ACCEPTED'
                    ELSE 'FAIL, wrong SQLSTATE' END;
    RETURN NEXT;

    -- 4 · ⭐ a confusable built from one of YOUR OWN live slugs, so this
    --     proves the fold index against real data rather than a fixture.
    --     The substitution is l -> 1, the exact pair the first draft of
    --     0091 got wrong.
    v_state := NULL; v_msg := NULL;
    SELECT t.slug INTO v_target FROM public.tenants t
     WHERE t.slug LIKE '%l%' ORDER BY t.created_at LIMIT 1;

    IF v_target IS NULL THEN
        ord := 5; attempt := 'confusable of a live slug';
        expected := '23505 tenants_slug_fold_unique';
        got_sqlstate := 'none'; got_message := NULL;
        verdict := 'SKIPPED, no existing slug contains the letter l';
        RETURN NEXT;
    ELSE
        v_probe := replace(v_target, 'l', '1');
        BEGIN
            INSERT INTO public.tenants (clerk_org_id, slug, name)
            VALUES ('verify0091:f', v_probe, 'VERIFY 0091');
        EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; v_msg := SQLERRM;
        END;
        ord := 5;
        attempt := 'confusable "' || v_probe || '" of live slug "' || v_target || '"';
        expected := '23505 tenants_slug_fold_unique';
        got_sqlstate := coalesce(v_state,'none'); got_message := v_msg;
        verdict := CASE WHEN v_state = '23505' THEN 'PASS'
                        WHEN v_state IS NULL    THEN 'FAIL, ACCEPTED, the fold is not working'
                        ELSE 'FAIL, wrong SQLSTATE' END;
        RETURN NEXT;
    END IF;
END
$verify$;

SELECT
    '-- TAB 7 · live refusals' AS section,
    v.ord, v.attempt, v.expected, v.got_sqlstate, v.verdict, v.got_message
FROM public.ordence_verify_0091() v
ORDER BY v.ord;


-- =====================================================================
-- TAB 8 · THE VERDICT.  SEND ME THIS ONE.
-- =====================================================================
WITH facts AS (
    SELECT
        (SELECT count(*) FROM pg_constraint
          WHERE conrelid = 'public.tenants'::regclass
            AND conname IN ('tenants_slug_lowercase','tenants_slug_shape')
            AND convalidated)                                          AS checks_ok,
        (SELECT count(*) FROM public.reserved_slugs)                   AS reserved_count,
        (SELECT count(*) FROM pg_attribute
          WHERE attrelid='public.tenants'::regclass AND attname='slug_fold'
            AND attgenerated='s' AND NOT attisdropped)                 AS fold_generated,
        (SELECT count(*) FROM pg_class WHERE relname='tenants_slug_fold_unique') AS fold_index,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='ordence_guard_tenant_slug'
            AND p.prosecdef
            AND array_to_string(p.proconfig,',') LIKE '%search_path%')  AS guard_hardened,
        (SELECT count(*) FROM pg_trigger
          WHERE tgrelid='public.tenants'::regclass
            AND tgname='ordence_guard_tenant_slug' AND NOT tgisinternal) AS trigger_present,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='tenant_slug_history'
            AND c.relrowsecurity AND c.relforcerowsecurity)             AS history_rls,
        (SELECT count(*) FROM public.tenants t
          WHERE NOT EXISTS (SELECT 1 FROM public.tenant_slug_history h
                            WHERE h.tenant_id=t.id AND h.slug=t.slug))  AS backfill_gaps,
        (SELECT count(*) FROM public.ordence_verify_0091() WHERE verdict LIKE 'FAIL%') AS live_failures,
        (SELECT count(*) FROM public.ordence_verify_0091())              AS live_attempts
)
SELECT * FROM (
    SELECT 1 AS ord, 'shape and case constraints' AS item,
           checks_ok::text || ' of 2' AS observed,
           CASE WHEN checks_ok = 2 THEN 'PASS' ELSE 'FAIL' END AS verdict FROM facts
    UNION ALL SELECT 2, 'reserved_slugs seeded',
           reserved_count::text || ' of 71',
           CASE WHEN reserved_count >= 71 THEN 'PASS' ELSE 'FAIL' END FROM facts
    UNION ALL SELECT 3, 'slug_fold is a STORED generated column',
           fold_generated::text || ' of 1',
           CASE WHEN fold_generated = 1 THEN 'PASS' ELSE 'FAIL' END FROM facts
    UNION ALL SELECT 4, 'tenants_slug_fold_unique exists',
           fold_index::text || ' of 1',
           CASE WHEN fold_index = 1 THEN 'PASS' ELSE 'FAIL' END FROM facts
    UNION ALL SELECT 5, 'guard is SECURITY DEFINER with pinned search_path',
           guard_hardened::text || ' of 1',
           CASE WHEN guard_hardened = 1 THEN 'PASS' ELSE 'FAIL, the guard fails OPEN' END FROM facts
    UNION ALL SELECT 6, 'trigger attached to tenants',
           trigger_present::text || ' of 1',
           CASE WHEN trigger_present = 1 THEN 'PASS' ELSE 'FAIL' END FROM facts
    UNION ALL SELECT 7, 'tenant_slug_history RLS enabled AND forced',
           history_rls::text || ' of 1',
           CASE WHEN history_rls = 1 THEN 'PASS' ELSE 'FAIL' END FROM facts
    UNION ALL SELECT 8, 'every tenant has a history row',
           backfill_gaps::text || ' missing',
           CASE WHEN backfill_gaps = 0 THEN 'PASS' ELSE 'FAIL' END FROM facts
    UNION ALL SELECT 9, 'live refusals actually refused',
           (live_attempts - live_failures)::text || ' of ' || live_attempts::text,
           -- 🔴 ZERO ATTEMPTS IS A FAILURE, NOT A PASS. If the DO block in TAB 7
           --    errored, no findings were written, and `live_failures = 0` would
           --    otherwise print PASS over a section that never ran. A check that
           --    passes vacuously is worse than one that fails: it is the same
           --    defect as a CI floor of `if COUNT -lt 100`.
           CASE WHEN live_attempts < 5 THEN 'FAIL, TAB 7 did not run, read the error printed above it'
                WHEN live_failures = 0 THEN 'PASS'
                ELSE 'FAIL, see TAB 7' END FROM facts
) v
ORDER BY ord;


-- =====================================================================
-- TAB 9 · CLEAN UP
-- ---------------------------------------------------------------------
-- The probe function is scaffolding, not part of the product. Drop it.
-- ⚠️ If you re-run this file it is simply recreated, so forgetting to run
--    this is untidy rather than dangerous.
-- =====================================================================

DROP FUNCTION IF EXISTS public.ordence_verify_0091();
