-- ############################################################################
-- DRILL 0208a — INDUCE EVERY WAY A REVERSAL COULD LIE, AND WATCH IT REFUSED
--               (Phase 2 — the run ledger, idempotency and reversal)
-- ############################################################################
--
-- 🔴🔴 DO NOT RUN THIS AGAINST NEON. It creates a tenant, a user, a run and a
--      reversal. Everything is inside one transaction which the last line
--      ROLLS BACK, and that is still not a reason to point it at a database
--      holding a customer's books.
--
-- ══════════════════════════════════════════════════════════════════════════
-- RUN IT AS `ordence_app`, AND THAT IS THE WHOLE POINT
-- ══════════════════════════════════════════════════════════════════════════
--     psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=0 \
--          -f SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0208a-partial-reversal.sql
--
-- `ordence_app` is NOSUPERUSER and NOBYPASSRLS — created that way by
-- `scripts/bootstrap-test-db.mjs` for exactly this reason. A drill run as a
-- superuser proves nothing: it bypasses every policy, so every write succeeds
-- for a reason that has nothing to do with the controls being tested. This
-- repository has already shipped "a query measurer that measured as a
-- superuser under a header saying NOBYPASSRLS".
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHAT IS BEING INDUCED
-- ══════════════════════════════════════════════════════════════════════════
--   ① status `reversed` with rows left behind          → refused by a CHECK
--   ② status `partial` naming none of the rows          → refused by a DEFERRED
--                                                          constraint trigger
--   ③ an `irreversible` reversal claiming to have run   → refused by a CHECK
--   ④ a named failure whose reason is "failed"          → refused by a CHECK
--   ⑤ an honest partial, which must be ACCEPTED         → the control
--
-- ⚠️ ⑤ IS NOT DECORATION. A drill that only shows things being refused cannot
-- tell "correctly locked down" from "broken" — the argument
-- `check-rls-writes.mjs` makes for pairing every refusal with the positive
-- case that must still work.
--
-- ⚠️ `ON_ERROR_STOP=0`. Four of these statements are MEANT to fail, and each
-- expected error is printed above by a \echo. Read the output: four ERRORs
-- naming four different constraints, then one silent success.
-- ############################################################################

BEGIN;

-- The workspace this drill invents. `app.current_tenant_id` is set FIRST so
-- the tenant row satisfies its own policy (`id = app_current_tenant_id()`) —
-- without it the very first INSERT is refused by row-level security, which is
-- the 0092 failure mode and is worth seeing once.
SELECT set_config('app.current_tenant_id', '00000000-0000-4000-8000-0000000d2080', true);

INSERT INTO tenants (id, clerk_org_id, name, slug)
VALUES ('00000000-0000-4000-8000-0000000d2080', 'org_drill_0208', 'Drill 0208', 'drill-0208');

INSERT INTO users (id, tenant_id, clerk_user_id, email, first_name, last_name, role)
VALUES ('00000000-0000-4000-8000-0000000d2081',
        '00000000-0000-4000-8000-0000000d2080',
        'clerk_drill_0208', 'drill0208@example.invalid', 'Drill', '0208', 'tenant_owner');

INSERT INTO import_runs (id, tenant_id, started_by, entity_key, source_format, duplicate_mode, expected_rows)
VALUES ('00000000-0000-4000-8000-0000000d2082',
        '00000000-0000-4000-8000-0000000d2080',
        '00000000-0000-4000-8000-0000000d2081',
        'companies', 'csv', 'update', 1000);

INSERT INTO import_reversals (id, tenant_id, run_id, entity_key, kind, requested_by)
VALUES ('00000000-0000-4000-8000-0000000d2083',
        '00000000-0000-4000-8000-0000000d2080',
        '00000000-0000-4000-8000-0000000d2082',
        'companies', 'delete',
        '00000000-0000-4000-8000-0000000d2081');


\echo ''
\echo '=== (1) "reversed" with 100 of 1000 rows left behind ==='
\echo '    EXPECT: ERROR … violates check constraint "import_reversals_reversed_is_complete"'
SAVEPOINT s1;
UPDATE import_reversals
   SET status = 'reversed', finished_at = now(),
       rows_considered = 1000, rows_reversed = 900, rows_unreversed = 100
 WHERE id = '00000000-0000-4000-8000-0000000d2083';
ROLLBACK TO SAVEPOINT s1;


\echo ''
\echo '=== (2) "partial" reporting 100 unreversed rows and naming none of them ==='
\echo '    EXPECT: ERROR … reports 100 row(s) that could not be reversed and names 0'
SAVEPOINT s2;
UPDATE import_reversals
   SET status = 'partial', finished_at = now(),
       rows_considered = 1000, rows_reversed = 900, rows_unreversed = 100
 WHERE id = '00000000-0000-4000-8000-0000000d2083';
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO SAVEPOINT s2;


\echo ''
\echo '=== (3) an `irreversible` reversal recording 5 rows reversed ==='
\echo '    EXPECT: ERROR … violates check constraint "import_reversals_irreversible_refuses"'
SAVEPOINT s3;
UPDATE import_reversals
   SET kind = 'irreversible', status = 'reversed', finished_at = now(),
       rows_considered = 5, rows_reversed = 5, rows_unreversed = 0
 WHERE id = '00000000-0000-4000-8000-0000000d2083';
ROLLBACK TO SAVEPOINT s3;


\echo ''
\echo '=== (4) a named failure whose whole reason is "failed" ==='
\echo '    EXPECT: ERROR … violates check constraint "import_reversal_failures_named"'
SAVEPOINT s4;
INSERT INTO import_reversal_failures (tenant_id, reversal_id, blocked_by)
VALUES ('00000000-0000-4000-8000-0000000d2080',
        '00000000-0000-4000-8000-0000000d2083', 'failed');
ROLLBACK TO SAVEPOINT s4;


\echo ''
\echo '=== (5) THE CONTROL — an honest partial, named row by row, MUST be accepted ==='
\echo '    EXPECT: no error, and the SELECT below reports partial 1/2 with 1 row named'
INSERT INTO import_reversal_failures
  (tenant_id, reversal_id, target_table, target_id, input_row_number, blocked_by, sqlstate)
VALUES ('00000000-0000-4000-8000-0000000d2080',
        '00000000-0000-4000-8000-0000000d2083',
        'sales_invoices', '00000000-0000-4000-8000-0000000d2084', 412,
        'A payment has been recorded against this invoice since the import, so deleting it would leave the payment pointing at nothing.',
        '23503');

UPDATE import_reversals
   SET status = 'partial', finished_at = now(),
       rows_considered = 2, rows_reversed = 1, rows_unreversed = 1
 WHERE id = '00000000-0000-4000-8000-0000000d2083';
SET CONSTRAINTS ALL IMMEDIATE;

SELECT r.status,
       r.rows_considered,
       r.rows_reversed,
       r.rows_unreversed,
       (SELECT count(*) FROM import_reversal_failures f WHERE f.reversal_id = r.id) AS rows_named
  FROM import_reversals r
 WHERE r.id = '00000000-0000-4000-8000-0000000d2083';


\echo ''
\echo '=== (6) and the role this ran as, so the output cannot be misread ==='
SELECT current_user,
       (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS is_superuser,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls;

ROLLBACK;
