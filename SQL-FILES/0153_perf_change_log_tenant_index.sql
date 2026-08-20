-- =====================================================================
-- 0153 — change_log (tenant_id, changed_at)
-- Repo: app.ordence · Track F (performance) · Wave 16
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 THE WORST-INDEXED TABLE IN THE SCHEMA IS ALSO THE FASTEST-GROWING
-- ══════════════════════════════════════════════════════════════════════
-- `change_log` has a `tenant_id` column and FORCE ROW LEVEL SECURITY, so
-- every read of it carries an implicit `tenant_id = app_current_tenant_id()`.
-- It has exactly two indexes (0017_change_log.sql:98-101):
--
--   change_log_unsynced_idx  (tenant_id, seq) WHERE synced_at IS NULL
--   change_log_row_idx       (table_name, row_id, seq DESC)
--
-- The first is PARTIAL — usable only for the sync path, because the
-- planner may use a partial index only when it can prove the query
-- implies the predicate. The second does not begin with `tenant_id`.
--
-- So every tenant-scoped read of `change_log` is a sequential scan of
-- the entire table. Including the retention sweep.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ AND THE RETENTION SWEEP RUNS ONCE PER TENANT, BY DESIGN
-- ══════════════════════════════════════════════════════════════════════
-- `prune_change_log()` (0128_change_log_retention.sql:113) loops over
-- tenants deliberately — its own comment explains that a single
-- un-scoped `DELETE FROM change_log` would be filtered by RLS to
-- nothing. Correct, and it means N full sequential scans of the biggest
-- table in the database on every retention run.
--
-- How big it gets: `record_change()` is attached to 289 tables and
-- writes a full `to_jsonb(OLD)` + `to_jsonb(NEW)` image FOR EACH ROW of
-- every INSERT, UPDATE and DELETE. Measured (scripts/perf/measure-writes.mjs):
--
--   2,000 INSERTs into sales_invoices   ->  2,000 change_log rows
--   2,000 INSERTs into journal_entries  ->  4,000 change_log rows
--
-- The second number is two per row: the leg's own entry, plus the one
-- produced by the `update_ledger_balance` trigger's UPDATE of `ledgers`.
--
-- Measured on a 480,000-row change_log, tenant `enterprise-01`, as
-- `ordence_app` with FORCE RLS:
--
--   WITHOUT   Seq Scan on change_log, Rows Removed by Filter: 212,739
--             39,654 buffers      83.4 ms
--   WITH      Index Scan using change_log_tenant_changed_at_idx
--                696 buffers      13.0 ms
--
-- 57× fewer pages. On Neon, where a buffer miss is a network fetch, that
-- is the number that matters — and it is per tenant, per sweep.
--
-- ⚠️ WHY (tenant_id, changed_at) AND NOT (tenant_id, seq). `seq` is a
-- bigserial and correlates with time, so it would work today. It is not
-- what the sweep filters on: `WHERE changed_at < cutoff` (0128:156). An
-- index on a column that merely correlates with the predicate is a
-- promise that nobody will ever backfill a row with an explicit
-- `changed_at`, and there is no constraint anywhere making that true.
--
-- ORDER: safe before or after the code push. Apply it BEFORE the next
-- `prune_change_log()` run, which is the thing it makes affordable.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS change_log_tenant_changed_at_idx
    ON public.change_log (tenant_id, changed_at);

COMMENT ON INDEX public.change_log_tenant_changed_at_idx IS
  'Track F / 0153. The only non-partial index on change_log that begins with '
  'tenant_id. Serves prune_change_log() (0128), which scans per tenant by design. '
  '39,654 -> 696 buffers on a 480k-row table.';

DO $$
DECLARE
  v_valid   boolean;
  v_ready   boolean;
  v_def     text;
  v_leading int;
BEGIN
  SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
    INTO v_valid, v_ready, v_def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'change_log_tenant_changed_at_idx';

  IF NOT FOUND THEN
    RAISE EXCEPTION '0153 FAILED: change_log_tenant_changed_at_idx does not exist.';
  END IF;
  IF NOT v_valid OR NOT v_ready THEN
    RAISE EXCEPTION
      '0153 FAILED: change_log_tenant_changed_at_idx is INVALID (indisvalid=%, indisready=%). '
      'DROP INDEX CONCURRENTLY change_log_tenant_changed_at_idx; then re-run.',
      v_valid, v_ready;
  END IF;

  -- ⭐ THE PROPERTY, NOT THE NAME. Assert that `change_log` now has at
  -- least one NON-PARTIAL index whose FIRST key column is `tenant_id`.
  -- That is the thing that was missing; an index of the right name and
  -- the wrong leading column would leave it missing.
  SELECT count(*) INTO v_leading
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
   WHERE c.relname = 'change_log'
     AND i.indpred IS NULL
     AND i.indisvalid
     AND (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attnum = i.indkey[0]) = 'tenant_id';

  IF v_leading = 0 THEN
    RAISE EXCEPTION
      '0153 FAILED: change_log still has no non-partial index leading with tenant_id. '
      'Every tenant-scoped read of it remains a sequential scan.';
  END IF;

  RAISE NOTICE '0153 PASS: % (% non-partial tenant-leading index(es) on change_log)',
    v_def, v_leading;
END
$$;
