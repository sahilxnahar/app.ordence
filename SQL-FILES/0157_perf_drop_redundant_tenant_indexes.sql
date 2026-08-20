-- =====================================================================
-- 0157 — drop the bare (tenant_id) indexes a wider index already covers
-- Repo: app.ordence · Track F (performance) · Wave 16
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- THE RULE, AND WHY IT IS SAFE
-- ══════════════════════════════════════════════════════════════════════
-- 102 tables carry BOTH a non-unique, non-partial index on `(tenant_id)`
-- alone AND a non-partial index whose first key column is `tenant_id`
-- and which has more columns — for example:
--
--   journal_entries_tenant_idx  (tenant_id)                              <- dropped
--   journal_entries_ledger_idx  (tenant_id, ledger_id, created_at)       <- kept
--
-- B-TREE PREFIX RULE: an index on `(a, b, c)` can serve any lookup that
-- constrains a leading subset of its columns, including `a` alone. The
-- narrow index cannot serve one single query the wide one cannot. It
-- contributes to no plan.
--
-- What it does contribute is a page write on every INSERT and on every
-- UPDATE that is not HOT, on 102 tables, forever.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ WHAT THE MEASUREMENT ACTUALLY SHOWED, INCLUDING THE PART THAT
--    DOES NOT FLATTER THIS FILE
-- ══════════════════════════════════════════════════════════════════════
-- `scripts/perf/measure-writes.mjs`, 2,000 INSERTs into `journal_entries`
-- (9 indexes, 9 triggers) on a 360,000-row table:
--
--   A · production shape                     642 ms   321 us/row
--   C · 1 redundant bare index dropped        557 ms   278 us/row   13.3% cheaper
--   B · change-log trigger off                549 ms   275 us/row   14.5% cheaper
--   D · all user triggers off                  54 ms    27 us/row   91.6% cheaper
--
-- 🔴 READ LINE D BEFORE CONGRATULATING THIS FILE. Dropping the redundant
-- index buys 13%. The triggers cost 92%. This is a real saving and it is
-- the SMALL one; the write-path finding that matters is in
-- `docs/PERFORMANCE.md` §6 and it is not an index problem.
--
-- The saving is nonetheless free — it costs no read anywhere, which is
-- asserted rather than assumed:
-- `node scripts/perf/check-query-budgets.mjs` was run before and after
-- and every catalogued query stayed within budget.
--
-- ══════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT DROPPED
-- ══════════════════════════════════════════════════════════════════════
--   • UNIQUE indexes. A unique index is a CONSTRAINT. Dropping it
--     changes what the database permits, which is not a performance
--     decision to make in a performance migration.
--   • PARTIAL indexes. The planner may use one only where it can prove
--     the query implies its predicate, so a partial index serves queries
--     a wider plain index cannot.
--   • Any index backing a constraint. Postgres refuses to drop those
--     directly and the refusal would abort the sweep.
--
-- All three exclusions live in `ordence_index_health()` (0155), not here.
--
-- ORDER: after 0155. Independent of the code push.
-- ⚠️ RE-RUNNABLE. It recomputes the set every time; a second run drops
-- nothing and passes.
-- =====================================================================

DO $$
DECLARE
  r           record;
  v_planned   int;
  v_dropped   int := 0;
  v_failed    text[] := ARRAY[]::text[];
  v_remaining int;
  v_orphaned  int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ordence_index_health') THEN
    RAISE EXCEPTION '0157 FAILED: ordence_index_health() is missing. Run 0155 first.';
  END IF;

  -- ⚠️ Fail fast rather than queue behind a long reader. See 0156.
  PERFORM set_config('lock_timeout', '3s', true);

  SELECT count(*) INTO v_planned
    FROM public.ordence_index_health() WHERE category = 'redundant-prefix';

  -- 🔴 THE CEILING. 102 is the measured set at 1.81.0-alpha. If a future
  -- edit to the rule in 0155 widens it, this refuses instead of dropping
  -- indexes nobody reviewed.
  IF v_planned > 200 THEN
    RAISE EXCEPTION
      '0157 REFUSED: % redundant-prefix indexes reported. The known set is ~102. '
      'A number this large means the rule in ordence_index_health() changed. '
      'Review it before dropping anything.', v_planned;
  END IF;

  FOR r IN
    SELECT table_name, index_name, detail
      FROM public.ordence_index_health()
     WHERE category = 'redundant-prefix'
     ORDER BY table_name, index_name
  LOOP
    BEGIN
      EXECUTE format('DROP INDEX public.%I', r.index_name);
      v_dropped := v_dropped + 1;
    EXCEPTION
      WHEN lock_not_available OR undefined_object OR dependent_objects_still_exist THEN
        v_failed := v_failed || (r.index_name || ' (' || SQLERRM || ')');
    END;
  END LOOP;

  -- ---------------------------------------------------------------
  -- VERIFY ① — the category is empty.
  -- ---------------------------------------------------------------
  SELECT count(*) INTO v_remaining
    FROM public.ordence_index_health() WHERE category = 'redundant-prefix';

  -- ---------------------------------------------------------------
  -- 🔴 VERIFY ② — AND THIS IS THE ONE THAT MATTERS.
  --
  -- The whole safety argument is "a wider tenant-leading index already
  -- covers it". If that were ever false for one table, this sweep would
  -- have left that table with NO index leading with `tenant_id`, and
  -- every tenant-scoped read of it would become a sequential scan — a
  -- performance migration causing the exact defect it is fixing.
  --
  -- So: count the tables that had a leading-tenant index before and do
  -- not have one now. It must be zero. This is checked AFTER the drops,
  -- against the live catalogue, not against an assumption.
  -- ---------------------------------------------------------------
  SELECT count(*) INTO v_orphaned
    FROM public.ordence_index_health()
   WHERE category = 'missing-tenant-leading'
     AND table_name NOT IN (
       -- The 11 tables that already lacked one before this file ran.
       -- Reported by 0155, untouched here, and listed in TRACK-REPORT.md §4.
       'campaign_recipients', 'change_log', 'consents', 'court_fee_refund_claims',
       'court_fee_schedules', 'email_suppressions', 'goods_receipt_lines',
       'lead_intake_failures', 'login_lockouts', 'message_templates',
       'webhook_endpoints'
     );

  IF v_orphaned > 0 THEN
    RAISE EXCEPTION
      '0157 FAILED: % table(s) now have NO index leading with tenant_id that did not '
      'have that problem before. The sweep dropped an index nothing else covered. '
      'Restore from the index definitions in SQL-FILES before continuing.', v_orphaned;
  END IF;

  IF array_length(v_failed, 1) > 0 THEN
    RAISE EXCEPTION
      '0157 INCOMPLETE: dropped % of %, could not drop: %. Re-run this file; it '
      'recomputes the set and is safe to repeat.',
      v_dropped, v_planned, array_to_string(v_failed, ', ');
  END IF;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      '0157 FAILED: % redundant index(es) remain after a sweep that reported no '
      'errors. The drop and the detection disagree.', v_remaining;
  END IF;

  RAISE NOTICE
    '0157 PASS: % redundant bare (tenant_id) index(es) dropped, 0 remain, '
    '0 tables newly left without a tenant-leading index.', v_dropped;
END
$$;
