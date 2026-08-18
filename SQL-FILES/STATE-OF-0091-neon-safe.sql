-- =====================================================================
-- STATE OF 0091  ·  READ ONLY  ·  ONE STATEMENT  ·  SAFE IN NEON
-- Repo: app.ordence
-- =====================================================================
--
-- 🔴 WHY THIS FILE EXISTS
--
--    `0091` reported success and only PARTIALLY applied. `reserved_slugs`
--    exists (a write to it was refused by its RLS policy, which proves
--    both the table and the policy are there), and `tenant_slug_history`
--    does not exist at all. Something between them stopped the run.
--
-- ⚠️ HOW A MIGRATION WRAPPED IN BEGIN/COMMIT APPLIES HALF-WAY
--
--    `0091` opens with `BEGIN;` and closes with `COMMIT;`. In a terminal
--    that makes it atomic. In a browser SQL console it does not, because
--    the console sends each statement SEPARATELY and does not hold a
--    transaction across them. Every statement autocommits on its own, so
--    the file is not one migration, it is thirty independent ones, and
--    the first failure leaves everything before it committed and
--    everything after it never run.
--
--    The `BEGIN;` at the top was doing nothing except making it look safe.
--
-- 🔴 AND MY OWN DIAGNOSTIC HAD THE SAME CLASS OF FAULT, WHICH IS WHY THIS
--    FILE IS WRITTEN THE WAY IT IS.
--
--    The diagnostic in `0092` did `SELECT count(*) FROM tenant_slug_history`
--    to report the state of the database, and died with
--    `relation "public.tenant_slug_history" does not exist`. A diagnostic
--    that assumes the thing it is diagnosing is not a diagnostic.
--
--    So EVERYTHING below reads `pg_catalog` through `to_regclass`, which
--    returns NULL for a missing object instead of raising. The only real
--    table it touches is `tenants`, which certainly exists, and even that
--    is guarded.
--
-- HOW TO RUN
--    Paste the whole file. It is ONE statement, so it cannot half-run.
--    You get ONE result grid. Send me all of it.
-- =====================================================================

WITH have AS (
    SELECT
        -- Objects, via to_regclass: NULL when absent, never an error.
        (to_regclass('public.reserved_slugs')      IS NOT NULL) AS t_reserved,
        (to_regclass('public.tenant_slug_history') IS NOT NULL) AS t_history,
        (to_regclass('public.tenants_slug_fold_unique') IS NOT NULL) AS i_fold,
        (to_regclass('public.tenants_slug_unique')     IS NOT NULL) AS i_slug,
        (EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.tenants'::regclass
                    AND attname = 'slug_fold' AND NOT attisdropped)) AS c_fold,
        (EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.tenants'::regclass
                    AND conname = 'tenants_slug_lowercase'))         AS k_lower,
        (EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.tenants'::regclass
                    AND conname = 'tenants_slug_shape'))             AS k_shape,
        (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public'
                    AND p.proname = 'ordence_guard_tenant_slug'))    AS f_guard,
        (EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.tenants'::regclass
                    AND tgname = 'ordence_guard_tenant_slug'
                    AND NOT tgisinternal))                           AS g_trigger,
        -- Who is running this, and does RLS even apply to them.
        current_user                                                 AS who,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
        (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS super
),
counts AS (
    SELECT
        (SELECT count(*) FROM public.tenants)                        AS tenants,
        (SELECT count(*) FROM public.tenants WHERE slug <> lower(slug)) AS bad_case,
        (SELECT count(*) FROM public.tenants
          WHERE slug !~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$')     AS bad_shape,
        (SELECT coalesce(sum(c), 0) FROM (
            SELECT count(*) AS c FROM public.tenants
            GROUP BY translate(replace(replace(replace(slug,'-',''),'rn','m'),'vv','w'),'01l','oii')
            HAVING count(*) > 1) x)                                   AS fold_collisions,
        /*
         * 🔴 `query_to_xml`, NOT A CASE AROUND A DIRECT SELECT.
         *
         * The obvious spelling is
         *     CASE WHEN to_regclass('public.reserved_slugs') IS NULL THEN -1
         *          ELSE (SELECT count(*) FROM public.reserved_slugs) END
         * and it DOES NOT WORK. PostgreSQL parses and plans the whole
         * statement before evaluating any branch, so a missing relation is a
         * parse-time error and the CASE never gets the chance to guard it.
         *
         * ⚠️ I WROTE EXACTLY THAT AND IT FAILED ON A FRESH DATABASE, in the
         *    same file whose header criticises a diagnostic for assuming the
         *    thing it is diagnosing. A guard that the planner evaluates before
         *    the guard runs is not a guard.
         *
         * `query_to_xml` takes the query as TEXT and executes it at RUNTIME,
         * so the CASE really does short-circuit and a missing table costs
         * nothing.
         */
        (CASE WHEN to_regclass('public.reserved_slugs') IS NULL THEN -1
              ELSE (xpath('/row/c/text()',
                          query_to_xml('SELECT count(*) AS c FROM public.reserved_slugs',
                                       false, true, '')))[1]::text::bigint
         END)                                                         AS reserved_rows
)
SELECT * FROM (
    SELECT  1 AS ord, 'WHO IS RUNNING THIS'            AS item,
            h.who                                       AS observed,
            CASE WHEN h.bypass OR h.super
                 THEN 'BYPASSES RLS , every FORCE ROW LEVEL SECURITY here is decoration for this role'
                 ELSE 'does NOT bypass RLS , the isolation model is real' END AS meaning
      FROM have h
    UNION ALL SELECT 2, '0091 §1 tenants_slug_lowercase',
            CASE WHEN h.k_lower THEN 'present' ELSE 'MISSING' END,
            'lowercase CHECK on tenants.slug' FROM have h
    UNION ALL SELECT 3, '0091 §1 tenants_slug_shape',
            CASE WHEN h.k_shape THEN 'present' ELSE 'MISSING' END,
            '3-to-63 DNS label CHECK on tenants.slug' FROM have h
    UNION ALL SELECT 4, '0091 §2 reserved_slugs table',
            CASE WHEN h.t_reserved THEN 'present' ELSE 'MISSING' END,
            'the reserved-word table' FROM have h
    UNION ALL SELECT 5, '0091 §2 reserved_slugs rows',
            CASE WHEN c.reserved_rows < 0 THEN 'table missing'
                 ELSE c.reserved_rows::text || ' of 71' END,
            'seeded reserved names' FROM counts c
    UNION ALL SELECT 6, '0091 §3 tenants.slug_fold column',
            CASE WHEN h.c_fold THEN 'present' ELSE 'MISSING' END,
            'the confusable-fold generated column' FROM have h
    UNION ALL SELECT 7, '0091 §3 tenants_slug_fold_unique',
            CASE WHEN h.i_fold THEN 'present' ELSE 'MISSING' END,
            'the index that stops 0rdence sitting beside ordence' FROM have h
    UNION ALL SELECT 8, '0091 §4 tenant_slug_history table',
            CASE WHEN h.t_history THEN 'present' ELSE 'MISSING' END,
            '365-day retention on released hostnames' FROM have h
    UNION ALL SELECT 9, '0091 §5 guard function',
            CASE WHEN h.f_guard THEN 'present' ELSE 'MISSING' END,
            'refuses reserved and recently-released slugs' FROM have h
    UNION ALL SELECT 10, '0091 §5 guard trigger on tenants',
            CASE WHEN h.g_trigger THEN 'present' ELSE 'MISSING' END,
            'without this the function is never called' FROM have h
    UNION ALL SELECT 11, 'tenants_slug_unique (from 0001)',
            CASE WHEN h.i_slug THEN 'present' ELSE 'MISSING' END,
            'pre-existing, should always be present' FROM have h
    -- ---- can a re-run succeed, or will it fail on real data ----------
    UNION ALL SELECT 20, 'RE-RUN BLOCKER · uppercase slugs',
            c.bad_case::text || ' row(s)',
            CASE WHEN c.bad_case = 0 THEN 'clear'
                 ELSE 'BLOCKS the lowercase CHECK , send me these rows' END FROM counts c
    UNION ALL SELECT 21, 'RE-RUN BLOCKER · bad shape',
            c.bad_shape::text || ' row(s)',
            CASE WHEN c.bad_shape = 0 THEN 'clear'
                 ELSE 'BLOCKS the shape CHECK , send me these rows' END FROM counts c
    UNION ALL SELECT 22, 'RE-RUN BLOCKER · fold collisions',
            c.fold_collisions::text || ' row(s)',
            CASE WHEN c.fold_collisions = 0 THEN 'clear'
                 ELSE 'BLOCKS tenants_slug_fold_unique , send me these rows' END FROM counts c
    UNION ALL SELECT 23, 'workspaces in the database',
            c.tenants::text,
            'context, and it decides whether the backfill does anything' FROM counts c
) v
ORDER BY ord;
