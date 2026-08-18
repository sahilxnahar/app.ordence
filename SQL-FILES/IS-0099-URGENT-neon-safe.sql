-- ############################################################################
-- IS 0099 URGENT? , ONE READ THAT ANSWERS IT FROM YOUR DATA
-- ############################################################################
--
-- THE QUESTION
-- ------------
-- `0099` is the only migration in the queue that fixes something the code
-- already shipped depends on. `v1.63.0-alpha` added the inventory valuation
-- engine, which computes a FIFO / weighted-average / standard figure and
-- writes it into `stock_movements.value_minor`.
--
-- 🔴 THE OLD TRIGGER OVERWRITES THAT FIGURE. Before `0099`,
--    `ordence_validate_stock_movement` ran `NEW.value_minor := ROUND(
--    unit_cost_minor * quantity)` unconditionally, BEFORE INSERT. So the
--    method the customer chose is read by the application and then discarded
--    by the database, silently, on every movement.
--
-- ⚠️ SO THE ANSWER DEPENDS ON A FACT I DO NOT HAVE: whether `v1.63.0-alpha`
--    is live on Railway yet.
--    · If it is NOT deployed, `0099` is routine. Run it before you push.
--    · If it IS deployed, every stock movement posted since is carrying a
--      derived figure instead of the engine's, and `0099` is the first thing
--      to run today.
--
-- ⭐ RATHER THAN ASK YOU TO REMEMBER, THIS READS THE ROWS.
--
-- The trigger fires BEFORE INSERT only, so nothing already stored is being
-- rewritten and no data is decaying while you read this. The exposure is
-- exactly the set of movements inserted while the new code was live and this
-- migration was not.
--
-- HOW TO READ IT
-- --------------
--   movements_total = 0            → nothing is at risk. `0099` is routine.
--   engine_figure_survived > 0     → `0099` is already applied and working.
--   indistinguishable > 0 AND      → these MAY have had an engine figure
--     movements_since_yesterday > 0   discarded. Compare `newest_movement`
--                                     against your Railway deploy time.
--
-- ⚠️ `indistinguishable` is not the same as `damaged`. A weighted-average
--    movement whose average happens to equal the stated rate looks identical
--    to an overwritten FIFO one. This tells you where to look, not what
--    happened. **A count is not a diagnosis.**
--
-- ############################################################################
-- ⚠️ A THING I GOT WRONG WHILE WRITING THIS FILE, CORRECTED HERE
-- ############################################################################
-- The first version used bare `query_to_xml('SELECT ... FROM stock_movements')`
-- on the belief that it made the read safe on a database where the table is
-- absent. IT DOES NOT. `query_to_xml` defers PLANNING, not EXISTENCE: the
-- string is still executed, and on a database without the table it fails with
-- `relation "public.stock_movements" does not exist`, which is the same
-- useless outcome as the `CASE` it was meant to replace.
--
-- ⭐ THE GUARD HAS TO BE ON THE STRING, NOT ON THE QUERY. Every read below
--    picks its SQL TEXT with `CASE WHEN to_regclass(...) IS NULL`. The CASE
--    now chooses between two strings, which the planner has nothing to
--    resolve, and `query_to_xml` runs whichever string was chosen. I proved
--    both branches: against a database that has the table, and against an
--    empty one.
--
-- A count of `-1` in any column means "the table is not here", not "zero".
-- ############################################################################
--
-- READ ONLY. Writes nothing, locks nothing, safe on production at any hour,
-- safe to run repeatedly.
--
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################

SELECT
    '0099 · exposure' AS finding,

    -- 🔴 IS THE FIX IN? Read from the function body itself, not from a
    --    migrations table that nothing maintains.
    (SELECT count(*) > 0 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'ordence_validate_stock_movement'
        AND pg_get_functiondef(p.oid)
            LIKE '%COALESCE(NEW.value_minor, 0) = 0%')     AS fix_0099_applied,

    -- ⚠️ query_to_xml, not a CASE over the table. The planner resolves both
    --    branches of a CASE before the guard runs, so a file asking whether
    --    a table exists must never name it in a FROM clause.
    (xpath('/row/c/text()', query_to_xml(
        CASE WHEN to_regclass('public.stock_movements') IS NULL THEN 'SELECT -1 AS c'
             ELSE 'SELECT count(*) AS c FROM public.stock_movements' END,
        false, true, '')))[1]::text::bigint                AS movements_total,

    (xpath('/row/c/text()', query_to_xml(
        CASE WHEN to_regclass('public.stock_movements') IS NULL THEN 'SELECT -1 AS c'
             ELSE 'SELECT count(*) AS c FROM public.stock_movements'
                  ' WHERE unit_cost_minor IS NOT NULL' END,
        false, true, '')))[1]::text::bigint                AS movements_with_a_rate,

    -- Rows whose stored value is EXACTLY what the old trigger would have
    -- written. Pre-0099 every rated row looks like this by construction.
    (xpath('/row/c/text()', query_to_xml(
        CASE WHEN to_regclass('public.stock_movements') IS NULL THEN 'SELECT -1 AS c'
             ELSE 'SELECT count(*) AS c FROM public.stock_movements'
                  ' WHERE unit_cost_minor IS NOT NULL'
                  '   AND value_minor = ROUND(unit_cost_minor * quantity)::bigint' END,
        false, true, '')))[1]::text::bigint                AS indistinguishable,

    -- 🔴 THE ROW THAT PROVES THE ENGINE'S FIGURE IS SURVIVING. Impossible
    --    under the old trigger. Any number above zero means 0099 is in.
    (xpath('/row/c/text()', query_to_xml(
        CASE WHEN to_regclass('public.stock_movements') IS NULL THEN 'SELECT -1 AS c'
             ELSE 'SELECT count(*) AS c FROM public.stock_movements'
                  ' WHERE unit_cost_minor IS NOT NULL'
                  '   AND value_minor <> ROUND(unit_cost_minor * quantity)::bigint' END,
        false, true, '')))[1]::text::bigint                AS engine_figure_survived,

    (xpath('/row/c/text()', query_to_xml(
        CASE WHEN to_regclass('public.stock_movements') IS NULL THEN 'SELECT -1 AS c'
             ELSE 'SELECT count(*) AS c FROM public.stock_movements'
                  ' WHERE moved_at > (CURRENT_DATE - 7)' END,
        false, true, '')))[1]::text::bigint                AS movements_last_7_days,

    (xpath('/row/m/text()', query_to_xml(
        CASE WHEN to_regclass('public.stock_movements') IS NULL THEN 'SELECT NULL::text AS m'
             ELSE 'SELECT max(moved_at) AS m FROM public.stock_movements' END,
        false, true, '')))[1]::text                        AS newest_movement,

    CASE
        WHEN to_regclass('public.stock_movements') IS NULL
            THEN '⬜ There is no stock_movements table on this database. Nothing to assess.'
        WHEN (xpath('/row/c/text()', query_to_xml(
                'SELECT count(*) AS c FROM public.stock_movements',
                false, true, '')))[1]::text::bigint = 0
            THEN '✅ No stock movements exist. Nothing is at risk. Run 0099 in normal order, before the push.'
        WHEN (SELECT count(*) > 0 FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND p.proname = 'ordence_validate_stock_movement'
                 AND pg_get_functiondef(p.oid)
                     LIKE '%COALESCE(NEW.value_minor, 0) = 0%')
            THEN '✅ 0099 is applied. New movements keep the engine figure.'
        ELSE '⚠️ 0099 is NOT applied and movements exist. Compare newest_movement against your Railway deploy time, and send me this row before doing anything else.'
    END                                                    AS verdict;
