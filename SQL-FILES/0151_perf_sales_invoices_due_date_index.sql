-- =====================================================================
-- 0151 — sales_invoices (tenant_id, due_date)
-- Repo: app.ordence · Track F (performance) · Wave 16
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 THE FINDING THIS EXISTS FOR, AND IT IS NOT ABOUT THIS TABLE
-- ══════════════════════════════════════════════════════════════════════
-- The overdue-receivables query — the one credit control opens every
-- morning and `server/credit/dunning-sweep.ts` runs on a schedule — is:
--
--     SELECT ... FROM sales_invoices
--      WHERE tenant_id = $1
--        AND status IN ('issued','part_paid')
--        AND due_date < current_date
--      ORDER BY due_date ASC LIMIT 200;
--
-- `sales_invoices_status_idx (tenant_id, status, due_date)` already
-- exists and is, on paper, exactly the right index for it.
--
-- 🔴 THE PLANNER WILL NOT USE IT, AND THE REASON IS IN pg_proc.
--
--     SELECT proname, proleakproof FROM pg_proc WHERE proname = 'enum_eq';
--      enum_eq | f
--
-- Under row-level security PostgreSQL divides the WHERE clause into
-- SECURITY quals (from the policy) and USER quals (from the query). A
-- user qual may only be evaluated BEFORE a security qual if it is
-- LEAKPROOF — otherwise an error raised by the operator could reveal the
-- existence of a row the policy was hiding.
--
-- `status` is an enum. `status = ANY(...)` uses `enum_eq`, which is NOT
-- leakproof. So it cannot become an index condition; it is demoted to a
-- heap filter that runs after the RLS check. `due_date < CURRENT_DATE`
-- uses `date_lt`, which IS leakproof, and can.
--
-- Measured on `enterprise-01` (48,000 invoices of 72,000 in the table),
-- as `ordence_app` with FORCE RLS in effect:
--
--   WITHOUT this index   Bitmap Heap Scan on sales_invoices
--                        using sales_invoices_order_idx   ← the WRONG index,
--                        chosen only because it starts with tenant_id
--                        Rows Removed by Filter: 31,708
--                        4,660 buffers        27.8 ms
--
--   WITH this index      Index Scan using sales_invoices_tenant_due_idx
--                        Index Cond: (tenant_id = $1 AND due_date < CURRENT_DATE)
--                        1,236 buffers         1.6 ms
--
--   Same query with RLS BYPASSED, no new index, for contrast:
--                        Bitmap Index Scan using sales_invoices_status_idx
--                        Index Cond includes status AND due_date
--                          985 buffers          9.3 ms
--
-- That third line is the whole finding: the plan the planner would pick
-- if RLS were off is not available to the application, and nothing in
-- the repository said so.
--
-- ⚠️ THIS GENERALISES. Every enum-typed column in this schema —
-- `transaction_status`, `entry_type`, `stock_movement_reason`,
-- `sales_invoice_status` and the rest — is unusable as an index
-- condition under RLS for exactly the same reason. Composite indexes
-- that lead `(tenant_id, <enum>, <date>)` are, throughout this schema,
-- indexes on `(tenant_id)` with two decorative columns. See
-- `docs/PERFORMANCE.md` §3.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ CONCURRENTLY, AND WHY THAT IS SAFE HERE
-- ══════════════════════════════════════════════════════════════════════
-- A plain `CREATE INDEX` takes ACCESS EXCLUSIVE on `sales_invoices` for
-- the duration. On the production table that blocks every invoice write.
-- `CONCURRENTLY` does not, at the cost of two table passes.
--
-- `CONCURRENTLY` cannot run inside a transaction block. That is fine
-- here and it is not luck: the Neon console sends EACH STATEMENT ON ITS
-- OWN CONNECTION, and `scripts/migrate.mjs` opens a new connection per
-- statement for the same reason (see its comment at line 124). This file
-- also carries no file-level BEGIN or COMMIT, which the gate refuses.
--
-- 🔴 A FAILED `CREATE INDEX CONCURRENTLY` LEAVES AN INVALID INDEX
-- BEHIND, and an invalid index is never used by any plan while still
-- being written to on every insert — the worst of both. The verification
-- block below therefore checks `indisvalid`, not merely existence.
--
-- ORDER: safe before or after the code push. It adds a read path and
-- removes nothing.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS sales_invoices_tenant_due_idx
    ON public.sales_invoices (tenant_id, due_date);

COMMENT ON INDEX public.sales_invoices_tenant_due_idx IS
  'Track F / 0151. Overdue receivables. Exists because enum_eq is not leakproof, '
  'so `status` cannot be an index condition under RLS and sales_invoices_status_idx '
  'is unusable for this query. due_date is leakproof and can be. 27.8ms -> 1.6ms.';

-- ---------------------------------------------------------------------
-- VERIFY. Raises if the index is absent, invalid, or the wrong shape.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_valid   boolean;
  v_ready   boolean;
  v_cols    text;
BEGIN
  SELECT i.indisvalid, i.indisready,
         pg_get_indexdef(i.indexrelid)
    INTO v_valid, v_ready, v_cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'sales_invoices_tenant_due_idx';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      '0151 FAILED: sales_invoices_tenant_due_idx does not exist after CREATE INDEX.';
  END IF;

  -- 🔴 The check that matters. An INVALID index is written on every
  -- insert and read by nothing.
  IF NOT v_valid OR NOT v_ready THEN
    RAISE EXCEPTION
      '0151 FAILED: sales_invoices_tenant_due_idx exists but is INVALID '
      '(indisvalid=%, indisready=%). CREATE INDEX CONCURRENTLY did not finish. '
      'DROP INDEX CONCURRENTLY sales_invoices_tenant_due_idx; then re-run this file.',
      v_valid, v_ready;
  END IF;

  -- The shape, not just the name. An index of the right name and the
  -- wrong columns is the same defect wearing a disguise.
  IF v_cols !~ '\(tenant_id, due_date\)' THEN
    RAISE EXCEPTION
      '0151 FAILED: sales_invoices_tenant_due_idx has the wrong shape: %', v_cols;
  END IF;

  RAISE NOTICE '0151 PASS: % ', v_cols;
END
$$;
