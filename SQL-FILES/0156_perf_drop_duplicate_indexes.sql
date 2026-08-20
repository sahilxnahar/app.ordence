-- =====================================================================
-- 0156 — drop exact-duplicate indexes
-- Repo: app.ordence · Track F (performance) · Wave 16
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- WHAT AN "EXACT DUPLICATE" IS HERE
-- ══════════════════════════════════════════════════════════════════════
-- Same table, identical key columns in identical order, identical
-- predicate, identical uniqueness — two indexes that are the same index
-- under two names, created by two migrations that each used
-- `IF NOT EXISTS` and each thought it was first.
--
-- Five pairs exist. `ordence_index_health()` (0155) finds them; this
-- file does not list them, for the reason argued in 0155: six other
-- tracks are editing this repository and a hand-written list of index
-- names is stale before it is reviewed.
--
-- The measured cost of the SECOND copy is one B-tree page write on every
-- INSERT and every non-HOT UPDATE, forever, in exchange for nothing at
-- all — the planner cannot use two identical indexes.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ WHY NOT `DROP INDEX CONCURRENTLY`
-- ══════════════════════════════════════════════════════════════════════
-- `DROP INDEX CONCURRENTLY` cannot run inside a transaction block, and
-- therefore cannot run inside a `DO $$ ... $$` block, and therefore
-- cannot be driven by a query over the catalogue. The set has to be
-- computed at run time, so a plain `DROP INDEX` it is.
--
-- A plain `DROP INDEX` takes ACCESS EXCLUSIVE on the table, but only for
-- as long as the catalogue update — the file unlink happens at commit.
-- It is milliseconds. The danger is not the drop; it is WAITING for the
-- lock behind somebody's long-running report, with every subsequent
-- write queued behind the waiter.
--
-- 🔴 SO `lock_timeout` IS SET, TRANSACTION-LOCAL, AND FAILURE IS
-- REPORTED RATHER THAN QUEUED. An index that could not be locked in
-- three seconds is left alone, named in the exception, and the file is
-- re-run later. Re-running is safe: the set is recomputed.
--
-- ⚠️ `SET LOCAL lock_timeout` AS ITS OWN STATEMENT DOES NOT WORK IN THE
-- NEON CONSOLE, which sends each statement on its own connection. It is
-- written as `set_config(..., true)` INSIDE the DO block, which is the
-- pattern the whole repository uses for the same reason.
--
-- ORDER: after 0155 (it calls that function). Independent of the code
-- push — it removes nothing any query can see.
-- =====================================================================

DO $$
DECLARE
  r          record;
  v_planned  int;
  v_dropped  int := 0;
  v_failed   text[] := ARRAY[]::text[];
  v_remaining int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ordence_index_health') THEN
    RAISE EXCEPTION
      '0156 FAILED: ordence_index_health() is missing. Run 0155 first.';
  END IF;

  PERFORM set_config('lock_timeout', '3s', true);

  SELECT count(*) INTO v_planned
    FROM public.ordence_index_health() WHERE category = 'exact-duplicate';

  -- ⚠️ A CEILING. If the rule in 0155 is ever edited into something
  -- broader, this refuses rather than dropping half the schema. 40 is
  -- eight times the known set; a real regression would blow past it.
  IF v_planned > 40 THEN
    RAISE EXCEPTION
      '0156 REFUSED: ordence_index_health() reports % exact duplicates. That is far '
      'more than this schema has ever had; the rule is probably wrong. Investigate '
      'before dropping anything.', v_planned;
  END IF;

  IF v_planned = 0 THEN
    RAISE NOTICE '0156: no exact-duplicate indexes found — already applied, or none exist.';
  END IF;

  FOR r IN
    SELECT table_name, index_name, detail
      FROM public.ordence_index_health()
     WHERE category = 'exact-duplicate'
     ORDER BY table_name, index_name
  LOOP
    BEGIN
      EXECUTE format('DROP INDEX public.%I', r.index_name);
      v_dropped := v_dropped + 1;
      RAISE NOTICE '0156 dropped %.% (%)', r.table_name, r.index_name, r.detail;
    EXCEPTION
      WHEN lock_not_available OR undefined_object THEN
        v_failed := v_failed || (r.index_name || ' (' || SQLERRM || ')');
    END;
  END LOOP;

  -- ---------------------------------------------------------------
  -- VERIFY. Not "did the loop run" — is the CATEGORY EMPTY. A loop that
  -- executed and dropped nothing is the failure this repository keeps
  -- finding, and it is indistinguishable from success without this.
  -- ---------------------------------------------------------------
  SELECT count(*) INTO v_remaining
    FROM public.ordence_index_health() WHERE category = 'exact-duplicate';

  IF array_length(v_failed, 1) > 0 THEN
    RAISE EXCEPTION
      '0156 INCOMPLETE: dropped % of %, could not drop: %. Re-run this file; it '
      'recomputes the set and is safe to repeat.',
      v_dropped, v_planned, array_to_string(v_failed, ', ');
  END IF;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      '0156 FAILED: % exact-duplicate index(es) remain after the sweep reported no '
      'errors. The drop and the detection disagree.', v_remaining;
  END IF;

  RAISE NOTICE '0156 PASS: % duplicate index(es) dropped, 0 remain.', v_dropped;
END
$$;
