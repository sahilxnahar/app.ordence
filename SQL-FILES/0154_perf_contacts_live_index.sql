-- =====================================================================
-- 0154 — contacts (tenant_id, created_at) WHERE deleted_at IS NULL
-- Repo: app.ordence · Track F (performance) · Wave 16
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY A PARTIAL INDEX AND NOT A WIDER ONE
-- ══════════════════════════════════════════════════════════════════════
-- Every read of `contacts` that a customer can see filters
-- `deleted_at IS NULL` — the list page (`server/actions/contacts.ts:153`),
-- its count (`:164`), and the export (`server/export/datasets.ts:208`).
-- No index carries that predicate, so the count that renders "N contacts"
-- on the CRM list page is a sequential scan of the tenant's whole
-- contact history including everything ever soft-deleted.
--
-- A partial index is the right shape rather than adding `deleted_at` as
-- a column, for two reasons:
--
--   ① It is smaller. Soft-deleted rows are not in it at all, so it stays
--      proportional to LIVE contacts rather than to all contacts ever.
--   ② `deleted_at IS NULL` is proven by PREDICATE IMPLICATION at plan
--      time — a proof, not an execution. That matters here in a way it
--      does not in a normal schema: under RLS a non-leakproof qual
--      cannot be evaluated before the security qual (see 0151), but a
--      partial index's predicate is never evaluated per row at all, so
--      it is unaffected. Partial indexes are the reliable way to express
--      a filter under RLS.
--
-- Measured on `enterprise-01` (8,000 live contacts of 12,000 rows), as
-- `ordence_app` with FORCE RLS:
--
--   contacts.count   WITHOUT   1.72 ms    678 buffers   (Seq Scan)
--                    WITH      0.92 ms     48 buffers   (Index Only Scan)
--
-- 14× fewer pages on a query that runs on every render of the contact
-- list, beside the page query itself.
--
-- ⚠️ WHAT IT DID NOT HELP, STATED BECAUSE IT WAS MEASURED. The contact
-- EXPORT (`export.contacts` in the catalogue) did not improve: 1,216
-- buffers before and after. It reads every column of every live contact,
-- so no index can avoid the heap. The export's problem is that it has no
-- LIMIT at all — see TRACK-REPORT.md §4 and PATCH-REQUEST-F.md.
--
-- ORDER: safe before or after the code push.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_tenant_live_idx
    ON public.contacts (tenant_id, created_at)
    WHERE deleted_at IS NULL;

COMMENT ON INDEX public.contacts_tenant_live_idx IS
  'Track F / 0154. Every customer-visible read of contacts filters deleted_at IS NULL '
  'and nothing carried it. Partial so it stays proportional to live rows. '
  'contacts.count: 678 -> 48 buffers.';

DO $$
DECLARE
  v_valid boolean;
  v_ready boolean;
  v_def   text;
BEGIN
  SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
    INTO v_valid, v_ready, v_def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'contacts_tenant_live_idx';

  IF NOT FOUND THEN
    RAISE EXCEPTION '0154 FAILED: contacts_tenant_live_idx does not exist.';
  END IF;
  IF NOT v_valid OR NOT v_ready THEN
    RAISE EXCEPTION
      '0154 FAILED: contacts_tenant_live_idx is INVALID (indisvalid=%, indisready=%). '
      'DROP INDEX CONCURRENTLY contacts_tenant_live_idx; then re-run.', v_valid, v_ready;
  END IF;

  -- 🔴 THE PREDICATE IS THE INDEX. Without it this is a duplicate of
  -- nothing useful and every claim above is false.
  IF v_def !~ 'WHERE \(deleted_at IS NULL\)' THEN
    RAISE EXCEPTION
      '0154 FAILED: contacts_tenant_live_idx exists but carries no '
      '`WHERE deleted_at IS NULL` predicate. Definition: %', v_def;
  END IF;

  RAISE NOTICE '0154 PASS: %', v_def;
END
$$;
