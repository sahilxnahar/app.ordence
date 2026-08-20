-- =====================================================================
-- 0152 — audit_logs (tenant_id, created_at DESC, id DESC)
-- Repo: app.ordence · Track F (performance) · Wave 16
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY, IN ONE SENTENCE
-- ══════════════════════════════════════════════════════════════════════
-- `server/actions/audit-trail.ts:325` reads its page with
--
--     ORDER BY created_at DESC, id DESC LIMIT size + 1
--
-- and the only index that begins with `tenant_id` on this table is
-- `audit_logs_tenant_created_idx (tenant_id, created_at)` — ascending,
-- and without the tiebreak column. So the tiebreak cannot come from the
-- index.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ THE TIEBREAK IS NOT DECORATION, IT IS THE CURSOR'S CORRECTNESS
-- ══════════════════════════════════════════════════════════════════════
-- Audit rows arrive in bursts: one user action writes several, all with
-- the same `created_at` to microsecond resolution in the same statement.
-- A keyset cursor over `created_at` alone cannot say which of them it
-- has already returned, which is why `audit-trail.ts` compares BOTH
-- columns — and its own comment (line 331) says a mismatch here "does
-- not error, it quietly returns overlapping pages".
--
-- An index that cannot supply that order forces a sort of the whole
-- tenant slice before the LIMIT can take 51 rows from it.
--
-- Measured on `enterprise-01` (120,000 audit rows of 180,000), as
-- `ordence_app` with FORCE RLS:
--
--   WITHOUT   0.77 ms      452 buffers
--   WITH      0.49 ms      162 buffers
--
-- ⚠️ THE MILLISECONDS ARE NOT THE ARGUMENT. On this container the table
-- is in shared buffers and the sort is small. The argument is 452 → 162
-- pages: Ordence runs on Neon, where a page that misses shared buffers
-- is a network fetch from a page server. On that storage the buffer
-- count is the cost, and it fell by 64%. See `docs/PERFORMANCE.md` §5.
--
-- ⚠️ ASC vs DESC in a B-tree matters ONLY for multi-column ordering.
-- PostgreSQL reads any single-column index backwards for free; it cannot
-- mix directions across columns. `(created_at DESC, id DESC)` is
-- therefore the only shape that serves this ORDER BY, and it also serves
-- `ORDER BY created_at ASC, id ASC` read backwards — so nothing that
-- used the old index loses.
--
-- ORDER: safe before or after the code push.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_tenant_keyset_idx
    ON public.audit_logs (tenant_id, created_at DESC, id DESC);

COMMENT ON INDEX public.audit_logs_tenant_keyset_idx IS
  'Track F / 0152. Serves the keyset cursor in server/actions/audit-trail.ts:325 '
  '(ORDER BY created_at DESC, id DESC) natively. 452 -> 162 buffers per page.';

DO $$
DECLARE
  v_valid boolean;
  v_ready boolean;
  v_def   text;
BEGIN
  SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
    INTO v_valid, v_ready, v_def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'audit_logs_tenant_keyset_idx';

  IF NOT FOUND THEN
    RAISE EXCEPTION '0152 FAILED: audit_logs_tenant_keyset_idx does not exist.';
  END IF;
  IF NOT v_valid OR NOT v_ready THEN
    RAISE EXCEPTION
      '0152 FAILED: audit_logs_tenant_keyset_idx is INVALID (indisvalid=%, indisready=%). '
      'DROP INDEX CONCURRENTLY audit_logs_tenant_keyset_idx; then re-run.', v_valid, v_ready;
  END IF;

  -- 🔴 THE DESC MARKERS ARE THE WHOLE POINT. An index of this name
  -- created ascending would pass an existence check and serve nothing.
  IF v_def !~ 'created_at DESC' OR v_def !~ 'id DESC' THEN
    RAISE EXCEPTION
      '0152 FAILED: the index exists but is not descending on both columns, so it '
      'cannot serve the cursor. Definition: %', v_def;
  END IF;

  RAISE NOTICE '0152 PASS: %', v_def;
END
$$;
