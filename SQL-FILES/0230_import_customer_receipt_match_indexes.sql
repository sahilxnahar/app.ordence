-- =====================================================================
-- 0230 — the two indexes an imported receipt is matched on
-- Repo: app.ordence · Phase 5 (entities: sales) · block 0230–0239
-- =====================================================================
--
-- ══════════════════════════════════════════════════════════════════════
-- WHAT THIS IS FOR
-- ══════════════════════════════════════════════════════════════════════
-- Phase 5 adds a `receipts` import entity whose destination is
-- `customer_receipts`. Re-run safety for it is `findExisting` in
-- `server/import/writers/sales/customer-receipts.ts`, which resolves the
-- whole file in ONE query, keyed on one of two composites:
--
--   ① (customer, reference)                 where a reference is given
--   ② (customer, date, amount, method)      where one is not — the weak
--                                           key, labelled weak in the UI
--
-- Both join `companies` to fold the customer's name the way the pure
-- layer folded it. Nothing in `0049` supports either shape: the existing
-- indexes are `(tenant_id, received_on)`, `(tenant_id, company_id,
-- status)` and the unapplied-money index. So the duplicate check on a
-- 5,000-row receipts file is a scan of every receipt the workspace has,
-- on EVERY preview and again on every commit — and the preview is the
-- half a customer runs three or four times while fixing their file.
--
-- ⚠️ NOT UNIQUE, AND THAT IS THE DECISION IN THIS FILE.
--
-- A unique index on either composite would be a stronger guarantee than
-- the natural key deserves and it would bind every OTHER write path too:
--
--   · ① is not unique in life. A cheque number is unique within a bank
--     account, not within a workspace, and two customers' banks reuse
--     numbers freely. `recordCustomerReceipt` has always allowed a
--     repeated `instrument_ref` and rows in production already do.
--   · ② is emphatically not unique: a customer who pays ₹5,000 in cash
--     twice on the same day has two receipts, and the importer says so
--     in the entity — it treats them as one and skips the second, which
--     is the better of two wrong answers for an IMPORT and would be
--     simply wrong as a database constraint on the whole product.
--
-- Making either unique would turn a real second payment into a 23505 on
-- the counter clerk's screen. The importer's job is to be careful with a
-- file; the table's job is to record what happened.
--
-- ⚠️ PARTIAL ON `instrument_ref IS NOT NULL` for ①: the rows without one
-- are the rows that index can never serve, and leaving them out keeps it
-- proportional to referenced receipts. A partial index's predicate is
-- proven at plan time by implication rather than evaluated per row,
-- which is also why it is unaffected by the RLS/leakproof interaction
-- 0151 documents.
--
-- ⚠️ `upper(instrument_ref)` AND `lower(regexp_replace(name, ...))` ARE
-- THE MATCH, so they are what is indexed. An index on the bare columns
-- would not be used by the writer's predicate at all — the expression
-- has to be identical, character for character, to the one in the query.
-- The suite `tests/ui/import-sales-entities.test.ts` asserts that the
-- writer still spells them this way.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ RLS: NOTHING TO DO HERE, AND THAT IS CHECKED RATHER THAN ASSUMED
-- ══════════════════════════════════════════════════════════════════════
-- `customer_receipts` already carries ENABLE + FORCE ROW LEVEL SECURITY
-- and its tenant policy from `0049_sales_invoices.sql` §RLS. Only FORCE
-- binds `neondb_owner`, which owns these tables, so a re-`ENABLE` would
-- be inert and is not repeated. An index is not a policy and changes
-- neither.
--
-- ORDER: safe before or after the code push. It creates no object the
-- application requires in order to work — only ones that make the
-- duplicate check fast enough to run twice.
--
-- ⚠️ `CONCURRENTLY` CANNOT RUN INSIDE A TRANSACTION BLOCK. Run this file
-- as-is (psql / the Neon SQL editor run it statement by statement); do
-- not wrap it in BEGIN…COMMIT.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS customer_receipts_import_ref_idx
    ON public.customer_receipts (tenant_id, company_id, upper(instrument_ref))
    WHERE instrument_ref IS NOT NULL;

COMMENT ON INDEX public.customer_receipts_import_ref_idx IS
  'Phase 5 / 0230. Supports the receipts importer''s duplicate check on '
  '(customer, upper(reference)) — see findExisting in '
  'server/import/writers/sales/customer-receipts.ts. NOT unique on purpose: a '
  'cheque number is unique within a bank account, not within a workspace.';

CREATE INDEX CONCURRENTLY IF NOT EXISTS customer_receipts_import_unreferenced_idx
    ON public.customer_receipts (tenant_id, company_id, received_on, amount_minor, method);

COMMENT ON INDEX public.customer_receipts_import_unreferenced_idx IS
  'Phase 5 / 0230. Supports the receipts importer''s WEAK duplicate check for rows '
  'with no reference: (customer, date, amount, method). Not unique — two cash '
  'payments of the same amount on the same day are two receipts.';

-- =====================================================================
--  VERIFY — the shape this file claims, read back from the catalogue
--
--  ⚠️ CREATE INDEX CONCURRENTLY CAN FAIL AND LEAVE AN INVALID INDEX
--  BEHIND, which is still visible in `pg_indexes` and is never used by
--  the planner. "The index exists" is therefore not the check; `indisvalid`
--  and `indisready` are. A silently invalid index here would mean the
--  duplicate scan quietly stays a sequential one.
-- =====================================================================
DO $$
DECLARE
  v_name text;
  v_valid boolean;
  v_ready boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'customer_receipts_import_ref_idx',
    'customer_receipts_import_unreferenced_idx'
  ] LOOP
    SELECT i.indisvalid, i.indisready
      INTO v_valid, v_ready
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = v_name;

    IF v_valid IS NULL THEN
      RAISE EXCEPTION '0230: index % was not created.', v_name;
    END IF;

    IF NOT v_valid OR NOT v_ready THEN
      RAISE EXCEPTION
        '0230: index % exists but is INVALID (valid=%, ready=%). CREATE INDEX '
        'CONCURRENTLY failed part way. DROP INDEX CONCURRENTLY % and run this file again.',
        v_name, v_valid, v_ready, v_name;
    END IF;
  END LOOP;

  -- ⚠️ AND THE PROTECTION THAT MUST NOT HAVE MOVED. Only FORCE binds the
  -- owner, and production connects as neondb_owner, which owns this table.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'customer_receipts'
       AND relrowsecurity
       AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION
      '0230: customer_receipts is not under FORCE ROW LEVEL SECURITY. This file did '
      'not change that, so something else has — stop and find out what.';
  END IF;

  RAISE NOTICE '0230 OK: both import match indexes are valid, FORCE RLS intact.';
END $$;
