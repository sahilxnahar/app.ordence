-- =====================================================================
-- DID 0093 APPLY?  ·  ONE STATEMENT  ·  READ ONLY  ·  SAFE IN NEON
-- Repo: app.ordence
-- =====================================================================
--
-- ⚠️ WHAT YOU SENT ME WAS ALMOST CERTAINLY FINE.
--
--    `0093` has three statements and therefore three result tabs:
--
--      TAB 1  diagnostic   , runs BEFORE the change
--      TAB 2  ALTER TABLE  , the change itself
--      TAB 3  verdict      , runs AFTER the change
--
--    You exported TAB 1. `column_already_present: false` is the CORRECT
--    answer there on a first run: it is a pre-check, and it says "this
--    column is not here yet, so there is work to do". Tab 3 is the one
--    that says whether the work happened.
--
-- ⭐ RATHER THAN ASK YOU TO RE-RUN AND CLICK THE RIGHT TAB, THIS ANSWERS
--    IT FROM THE CATALOG. One statement, one row, no dependence on which
--    tab was open.
--
-- 🔴 It reads `pg_catalog` through `to_regclass`, so it cannot error on a
--    missing object. A diagnostic that assumes the thing it is
--    diagnosing is not a diagnostic , that mistake cost this project a
--    round trip earlier this week.
-- =====================================================================

SELECT
    '0093 · did it apply'                                      AS finding,
    current_user                                               AS running_as,
    (to_regclass('public.users') IS NOT NULL)                  AS users_table_exists,
    EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = to_regclass('public.users')
          AND a.attname  = 'preferences'
          AND NOT a.attisdropped
    )                                                          AS preferences_column_present,
    (SELECT pg_get_expr(d.adbin, d.adrelid)
       FROM pg_attribute a
       JOIN pg_attrdef  d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass('public.users')
        AND a.attname  = 'preferences')                        AS column_default,
    (SELECT a.attnotnull
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass('public.users')
        AND a.attname  = 'preferences')                        AS is_not_null,
    CASE
        WHEN to_regclass('public.users') IS NULL
            THEN '🔴 the users table itself is missing, which is a much bigger problem than 0093'
        WHEN EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = to_regclass('public.users')
              AND a.attname = 'preferences' AND NOT a.attisdropped)
            THEN '✅ 0093 APPLIED. Nothing to do. The tab you exported was the pre-check, which runs before the change.'
        ELSE '🔴 0093 did NOT apply. Re-run the file and read TAB 3, and send me the error from whichever tab is red.'
    END                                                        AS verdict;
