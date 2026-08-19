-- ############################################################################
-- 0099 , STOP THE LEDGER TRIGGER OVERWRITING THE VALUATION ENGINE
-- ############################################################################
--
-- PURPOSE
-- -------
-- `stock_items.valuation_method` has existed since 0029 with four values ,
-- fifo, weighted_average, specific, standard , and was read at ZERO
-- computations. Batches 85-87 add `lib/inventory/valuation.ts`, a pure layer
-- model that consumes cost layers in the order the chosen method says, and
-- `server/inventory/valuation-service.ts`, which replays `stock_movements`
-- and costs an issue BEFORE the row is written.
--
-- 🔴 THE ENGINE WOULD HAVE BEEN SILENTLY DISCARDED BY THIS TRIGGER.
--    `ordence_validate_stock_movement` (0029 §3) ends with:
--
--        IF NEW.unit_cost_minor IS NOT NULL THEN
--          NEW.value_minor := ROUND(NEW.unit_cost_minor * NEW.quantity);
--        END IF;
--
--    An UNCONDITIONAL overwrite. Any caller that supplies a computed
--    `value_minor` and also carries a `unit_cost_minor` , which is exactly
--    what a FIFO issue out of two layers at different prices looks like ,
--    has its answer replaced by rate x quantity, which is not FIFO, not a
--    weighted average, and not any basis a customer chose. The engine would
--    have run, been correct, and been thrown away by the database on the way
--    past. That is the same shape of defect this batch exists to close, one
--    layer down.
--
-- ⭐ THE FIX IS ONE WORD: DERIVE ONLY WHEN NOTHING WAS STATED.
--    `value_minor` defaults to 0. Every caller written before this batch
--    leaves it at 0, so every one of them keeps the EXACT behaviour it has
--    today , the derivation still runs and the balance cache is unchanged.
--    A caller that has computed the value states it, and the database now
--    respects the statement instead of second-guessing it.
--
-- ⚠️ WHY NOT "NEVER DERIVE ON AN OUTWARD MOVEMENT", WHICH IS THE PURER RULE.
--    Cost on the way out belongs to the layers, never to a rate typed on the
--    issue, so on principle an outward row should refuse `unit_cost_minor`
--    outright. But six other action modules , transfers, goods returns,
--    stock counts, batches, purchase orders, import , still post outward
--    rows carrying a unit cost and relying on that derivation for the
--    balance cache. Turning it off for them in the same migration that adds
--    the engine would zero the value of every transfer in the system and
--    call it an improvement. The stricter rule belongs with the batch that
--    wires those six, and it is written down here so it is not forgotten.
--
-- ⭐ NO NEW TABLE, AND THAT IS DELIBERATE. A cost-layer ledger was
--    considered and rejected: the layers are DERIVED by replaying
--    `stock_movements`, which is already append-only and already guarded.
--    A stored layer table is a second copy of the same facts that can drift
--    from them, and an auditor re-performing the valuation would then have
--    to be told which copy is authoritative. Replay has the property that
--    matters , delete every derived figure and it comes back identical ,
--    and it is the same property `stock_balances` was built on in 0029.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO `SET LOCAL`
-- ----------------------------------------------------------------------------
-- The Neon browser console sends each statement separately. A `BEGIN;` at the
-- top gives no atomicity , it opens a transaction that the next statement's
-- own implicit commit closes , and 0091 applied half-way while reporting
-- success because of exactly that. Every statement below is independently
-- idempotent and safe to re-run.
--
-- `SET LOCAL app.platform_scope` would evaporate before the next statement
-- for the same reason. Nothing here writes to a tenant-scoped table, so no
-- scope is needed at all; `CREATE OR REPLACE FUNCTION` is DDL.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · THE TRIGGER FUNCTION, REPLACED WHOLE
-- ============================================================================
--
-- ⚠️ REPLACED IN FULL RATHER THAN PATCHED. A trigger function cannot be
-- edited in place, and reproducing it whole means the file can be read as
-- the current definition rather than as a diff against a file from 0029 that
-- the reader would have to go and find.
--
-- Everything above the valuation block is 0029 verbatim: the tenant match,
-- the sign-versus-reason check, the adjustment note, and the negative-stock
-- refusal with its `allow_negative_stock` escape.

CREATE OR REPLACE FUNCTION ordence_validate_stock_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  item        RECORD;
  wh          RECORD;
  current_qty numeric(18,3);
BEGIN
  SELECT id, name, uom, tenant_id INTO item
    FROM stock_items
   WHERE id = NEW.stock_item_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That stock item does not belong to this business.'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT id, name, allow_negative_stock, tenant_id INTO wh
    FROM warehouses
   WHERE id = NEW.warehouse_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That warehouse does not belong to this business.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.reason = 'adjustment'
     AND (NEW.adjustment_note IS NULL OR btrim(NEW.adjustment_note) = '') THEN
    RAISE EXCEPTION
      'An adjustment needs a reason. Somebody will ask why this quantity changed, and "adjustment" is not an answer.'
      USING ERRCODE = 'raise_exception';
  END IF;

  /* --- Refuse to go negative unless this store is allowed to -------- */
  IF NEW.quantity < 0 AND NOT wh.allow_negative_stock THEN
    SELECT COALESCE(SUM(m.quantity), 0) INTO current_qty
      FROM stock_movements m
     WHERE m.tenant_id     = NEW.tenant_id
       AND m.stock_item_id = NEW.stock_item_id
       AND m.warehouse_id  = NEW.warehouse_id
       AND COALESCE(m.batch_no, '') = COALESCE(NEW.batch_no, '');

    IF current_qty + NEW.quantity < 0 THEN
      RAISE EXCEPTION
        'Not enough stock. "%" at % has % % on hand%, and this movement takes out %. Either the receipt has not been entered yet, or the quantity is wrong. If this store really does issue before it receives, switch on "allow negative stock" for it , deliberately, because every valuation for this store then depends on paperwork catching up.',
        item.name, wh.name, current_qty, item.uom,
        CASE WHEN NEW.batch_no IS NOT NULL
             THEN ' in batch ' || NEW.batch_no ELSE '' END,
        abs(NEW.quantity)
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  /* --- Value the movement, in integer paise ------------------------ */
  --
  -- ⭐ THE ONE CHANGE IN 0099: `AND COALESCE(NEW.value_minor, 0) = 0`.
  --
  -- 🔴 A STATED VALUE IS EVIDENCE AND A DERIVED ONE IS A GUESS. When the
  --    caller has costed the movement through the valuation engine , FIFO
  --    layers, a running weighted average, a standard with its variance ,
  --    that figure is the answer, and rate x quantity is not. Overwriting it
  --    here would mean the method a customer chose is read by the
  --    application and then discarded by the database.
  --
  -- ⚠️ ZERO MEANS "NOT STATED", WHICH IS ALSO TRUE OF A GENUINELY NIL
  --    ISSUE , stock issued with no cost evidence at all, which the engine
  --    reports as NO_COST_EVIDENCE and refuses to invent a figure for. Such
  --    a row falls back to the derivation if it happens to carry a unit
  --    cost. That is acceptable and it is the direction of prudence: a
  --    stated rate on a costless issue is better evidence than nothing.
  IF NEW.unit_cost_minor IS NOT NULL
     AND COALESCE(NEW.value_minor, 0) = 0 THEN
    -- Quantity is `numeric(18,3)` in WHOLE stocking units, so the product is
    -- already paise; ROUND applies the rounding explicitly rather than
    -- letting a cast decide silently.
    NEW.value_minor := ROUND(NEW.unit_cost_minor * NEW.quantity)::bigint;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_stock_movement ON stock_movements;
CREATE TRIGGER trg_validate_stock_movement
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_validate_stock_movement();


-- ============================================================================
-- SECTION 2 · CONFIRMATION · THE ROW TO READ
-- ============================================================================
--
-- ⚠️ IT CHECKS THE FUNCTION BODY, NOT THAT THE FUNCTION EXISTS. It existed
-- before this file ran. What changed is one condition inside it, and a
-- verification that cannot tell the two versions apart verifies nothing.

SELECT
    '0099 · verdict'                                     AS finding,
    p.proname                                            AS function_name,
    CASE
        WHEN pg_get_functiondef(p.oid) LIKE '%COALESCE(NEW.value_minor, 0) = 0%'
            THEN 'PASS , a movement that arrives with a value already computed keeps it; the valuation method a customer chose now survives the write'
        ELSE 'FAIL , section 1 did not apply as written, send me the error from its tab'
    END                                                  AS verdict
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'ordence_validate_stock_movement';
