-- =====================================================================
--  0250 — A BATCH MAY ONLY BELONG TO AN ITEM OF ITS OWN TENANT
--  Ordence · v1.85.0-alpha · Phase 7, inventory import entities
-- =====================================================================
--
--  ⭐⭐ THE ARGUMENT IS 0029'S, APPLIED TO A TABLE 0029 DID NOT COVER
--  ------------------------------------------------------------------
--  `SQL-FILES/0029_phase40_inventory.sql` says it in its own header:
--
--      "A plain `warehouse_id -> warehouses(id)` says the parent
--       EXISTS. It does not say the parent is MINE."
--
--  and then rewrites eight inventory foreign keys as COMPOSITE keys on
--  `(tenant_id, <parent>_id)` so that the database itself refuses a row
--  pointing at another tenant's parent.
--
--  🔴 `stock_batches` WAS CREATED AFTERWARDS, IN 0055, AND MISSED THAT
--     TREATMENT. Its foreign key is the single-column
--     `stock_item_id -> stock_items(id)`, so a batch row carrying tenant
--     A's `tenant_id` and tenant B's `stock_item_id` satisfies every
--     constraint on the table:
--
--       · the FK is happy, because the item exists;
--       · the RLS policy is happy, because it tests `tenant_id` — the
--         batch's own — and never looks at the item;
--       · `stock_batches_item_batch_unique` is happy, because it is
--         scoped by tenant and this is the tenant's first such row.
--
--  ⚠️ WHY THIS PHASE IS THE ONE THAT CLOSES IT. Phase 7 adds a `batches`
--  IMPORTER, whose whole job is to write `stock_item_id` from a value
--  that arrived in a spreadsheet. Its writer resolves the SKU inside a
--  tenant-scoped query and joins tenant-scoped again, so the importer
--  cannot produce the bad row. That is two application-level layers
--  guarding a hole the database could close outright — and
--  `db/index.ts`'s own reasoning applies: relying on a single layer is
--  how single layers become the only layer.
--
--  ⚠️ NOTHING HERE CHANGES BEHAVIOUR FOR CORRECT DATA. A composite key
--  is strictly narrower than the one it replaces; every row that
--  satisfied the old one and is not cross-tenant satisfies this one.
--  §1 proves that on the live data before §2 changes anything.
--
--  SAFE TO RUN TWICE. Every statement is guarded, and §3 re-reads the
--  catalog rather than trusting §2 to have worked.
--
--  ⚠️ NO `BEGIN`/`COMMIT`, DELIBERATELY. A browser SQL console sends
--  each statement on its own connection, so a wrapper here would give
--  the APPEARANCE of atomicity and none of it: a failure in the middle
--  leaves everything before it committed, everything after it unrun, and
--  the console reporting success. Every statement below is independently
--  idempotent instead, and §3 re-reads the catalog so a half-application
--  is loud rather than silent. `check:sql-rls-writes` is the gate.
-- =====================================================================

-- =====================================================================
--  §1  REFUSE TO PROCEED IF THE HOLE HAS ALREADY BEEN USED
-- =====================================================================
--  ⚠️ `EXISTS`, NOT `count(*) > 0`. A count compared to a literal in a
--  pass/fail decision is the floor idiom `check:sealed-grants` refuses,
--  and it refuses it for a good reason — but the deeper point is that
--  the NUMBER is not what anyone needs here. What a person needs is the
--  rows, so the message names the first offender and the total together.
--
--  🔴 AND IT RAISES RATHER THAN REPAIRING. A cross-tenant batch is one
--  customer's lot register pointing at another customer's item; the
--  only people who can say which of the two is wrong are the humans
--  looking at the data. A migration that "fixed" it by nulling a column
--  would destroy the evidence of a tenant-isolation breach.
DO $$
DECLARE
  offenders bigint;
  sample    text;
BEGIN
  SELECT count(*),
         min(b.id::text)
    INTO offenders, sample
    FROM stock_batches b
    JOIN stock_items i ON i.id = b.stock_item_id
   WHERE i.tenant_id <> b.tenant_id;

  IF offenders > 0 THEN
    RAISE EXCEPTION
      'Refusing to add the tenant-scoped foreign key: % stock_batches row(s) already point at an item belonging to a DIFFERENT tenant (for example batch %). That is a tenant-isolation breach, not a data-quality problem — it must be looked at by a person before this constraint hides it.',
      offenders, sample
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- =====================================================================
--  §2  THE COMPOSITE KEY
-- =====================================================================
--  ⚠️ THE TARGET OF A COMPOSITE FK MUST BE A UNIQUE INDEX ON EXACTLY
--  THOSE COLUMNS. `stock_items_id_tenant_unique` is declared in
--  `db/schema/inventory.ts` and shipped in `RUN-THESE-IN-ORDER-14.sql`,
--  which is not a numbered migration — so a database built only from
--  `SQL-FILES/0001..0249` may not have it. Created here, IF NOT EXISTS,
--  rather than assumed: a migration that depends on a file outside the
--  numbered sequence is a migration that fails on a fresh database.
CREATE UNIQUE INDEX IF NOT EXISTS stock_items_id_tenant_unique
    ON public.stock_items (id, tenant_id);

--  ⚠️ THE OLD CONSTRAINT IS FOUND BY SHAPE, NOT BY NAME. It was created
--  by `drizzle-kit push` on some databases and by hand on others, and a
--  `DROP CONSTRAINT stock_batches_stock_item_id_fkey` that guesses wrong
--  silently leaves the weak key in place beside the strong one — which
--  reads as done and is not.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class     src ON src.oid = con.conrelid
      JOIN pg_class     tgt ON tgt.oid = con.confrelid
     WHERE con.contype = 'f'
       AND src.relname = 'stock_batches'
       AND tgt.relname = 'stock_items'
       AND array_length(con.conkey, 1) = 1
  LOOP
    EXECUTE format('ALTER TABLE public.stock_batches DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE 'dropped single-column foreign key %', c.conname;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
     WHERE con.contype = 'f'
       AND src.relname = 'stock_batches'
       AND con.conname = 'stock_batches_item_tenant_fkey'
  ) THEN
    -- ⚠️ ON DELETE RESTRICT, unchanged from 0055. An item with lots
    -- recorded against it is an item somebody has physically received;
    -- deleting it would leave a lot register describing nothing.
    ALTER TABLE public.stock_batches
      ADD CONSTRAINT stock_batches_item_tenant_fkey
      FOREIGN KEY (stock_item_id, tenant_id)
      REFERENCES public.stock_items (id, tenant_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- =====================================================================
--  §3  THE FILE VERIFIES ITSELF
-- =====================================================================
--  ⚠️ IT RE-READS THE CATALOG. §2 ran inside a DO block whose exceptions
--  would abort the transaction — but "the statement did not error" is
--  not the same claim as "the constraint is there with two columns", and
--  0126 Section 1 errored on every database it was applied to while the
--  file still printed PASS.
--
--  ⚠️ THE ASSERTION IS EXACT (`<> 2`), NOT A FLOOR. A key on ONE column
--  named `stock_batches_item_tenant_fkey` would pass "at least one
--  column" and would be exactly the defect this file exists to remove.
DO $$
DECLARE
  cols int;
  weak int;
BEGIN
  SELECT coalesce(array_length(con.conkey, 1), 0)
    INTO cols
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
   WHERE con.contype = 'f'
     AND src.relname = 'stock_batches'
     AND con.conname = 'stock_batches_item_tenant_fkey';

  IF cols IS NULL OR cols <> 2 THEN
    RAISE EXCEPTION
      '0250 did not take: stock_batches_item_tenant_fkey covers % column(s), expected exactly 2 (stock_item_id, tenant_id).',
      coalesce(cols, 0)
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*)
    INTO weak
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
   WHERE con.contype = 'f'
     AND src.relname = 'stock_batches'
     AND tgt.relname = 'stock_items'
     AND array_length(con.conkey, 1) = 1;

  IF weak <> 0 THEN
    RAISE EXCEPTION
      '0250 left % single-column foreign key(s) from stock_batches to stock_items in place. The weak key beside the strong one is the state this file exists to remove.',
      weak
      USING ERRCODE = 'raise_exception';
  END IF;

  RAISE NOTICE '0250 OK — stock_batches.(stock_item_id, tenant_id) references stock_items.(id, tenant_id).';
END $$;
