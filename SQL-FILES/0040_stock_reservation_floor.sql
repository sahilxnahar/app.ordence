-- ════════════════════════════════════════════════════════════════════
-- Ordence — 0040: stock can never fall below what is already promised
-- Version: v0.67.0-alpha
-- Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════
--
-- ⚠️ WHAT WAS WRONG
--
-- 0029 §7 guards ONE direction. It refuses a RESERVATION that exceeds
-- available stock:
--
--     reserve 400 when 100 are on hand   →  refused, loudly, correctly
--
-- Nothing guarded the other direction. A MOVEMENT that takes stock out
-- from underneath an existing reservation was accepted in silence:
--
--     400 bags received, 300 reserved for Thursday's order
--     someone reverses the receipt (a typo, a wrong warehouse, a
--     supplier credit note)
--     → on hand 0, reserved 300, available −300
--
-- The balance cache is recomputed from the ledger AFTER each insert, so
-- the numbers stay internally consistent. They are just wrong about the
-- world. `available` goes negative, every screen keeps showing the
-- reservation as good, and the first person to learn that Thursday's
-- cement does not exist is the customer waiting for it on Thursday.
--
-- ⚠️ THIS IS THE FAILURE MODE THIS WHOLE SUBSYSTEM WAS BUILT TO AVOID.
-- 0029's own header argues that a drifting integer balance is the enemy
-- and recomputes from the ledger to prevent it. That was the right call
-- and it does not help here: the ledger is accurate, the invariant it
-- must satisfy simply was not stated anywhere.
--
-- ⚠️ AND IT COULD NOT BE CAUGHT IN TYPESCRIPT. `reverseMovement()` in
-- server/actions/inventory.ts guards double-reversal and
-- reversing-a-reversal, both carefully. It never reads
-- `quantity_reserved`, because the reservation lives in a different
-- table that the reversal has no reason to look at. Every other writer
-- of stock_movements has the same blind spot, and always will. The
-- invariant belongs to the database.
--
-- ────────────────────────────────────────────────────────────────────
-- ⚠️ WHY IT REFUSES RATHER THAN WARNING, ADJUSTING, OR AUTO-RELEASING
-- ────────────────────────────────────────────────────────────────────
-- Stock genuinely does get lost — damage, theft, expiry are all real
-- and all in the reason enum. So the tempting design is to allow the
-- movement and quietly cancel enough reservations to rebalance.
--
-- That is the worst of the options. Deciding WHICH customer does not
-- get their goods is a commercial decision with a person's name on it.
-- A trigger that picks — by date, by size, by row order — makes that
-- decision anonymously, at 2am, and tells nobody.
--
-- So: the movement is refused, and the message names exactly what is in
-- the way. Releasing those reservations is then a deliberate act by
-- someone who knows which order they are disappointing, and it is
-- audited as such. The stock write-off goes through immediately after.
-- One extra step, and the step is the point.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- §1  THE GUARD
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ordence_guard_stock_floor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_qty   numeric(18,3);
  resulting_qty numeric(18,3);
  reserved      numeric(18,3);
  item_name     text;
  blocking      text;
BEGIN
  -- A movement that ADDS stock can never breach a floor. Skipping it
  -- keeps every receipt off the locking path below, which matters:
  -- receipts are the highest-volume write in the system.
  IF NEW.quantity >= 0 THEN
    RETURN NEW;
  END IF;

  -- ⚠️ LOCK FIRST, READ SECOND, AND LOCK THE SAME ROW 0029 §7 LOCKS.
  --
  -- Without this, a dispatch and a reservation running at the same
  -- instant both read the pre-change figures and both succeed — the
  -- exact interleaving the reservation guard already takes the lock to
  -- prevent. Two guards protecting one invariant have to queue on the
  -- same row or neither of them means anything.
  --
  -- The balance row may not exist yet (first movement for this batch),
  -- in which case there is nothing to lock and nothing reserved.
  PERFORM 1
     FROM stock_balances b
    WHERE b.tenant_id     = NEW.tenant_id
      AND b.stock_item_id = NEW.stock_item_id
      AND b.warehouse_id  = NEW.warehouse_id
      AND b.batch_no      = COALESCE(NEW.batch_no, '')
      FOR UPDATE;

  -- ⚠️ SUMMED FROM THE LEDGER, NOT READ FROM THE CACHE.
  --
  -- `stock_balances.quantity_on_hand` is maintained by an AFTER trigger,
  -- so inside this BEFORE trigger it still describes the world without
  -- NEW. Reading it and adding NEW.quantity would be right today and
  -- would silently become wrong the moment anything writes two movements
  -- in one statement. The ledger is the source of truth; use it.
  SELECT COALESCE(SUM(m.quantity), 0) INTO current_qty
    FROM stock_movements m
   WHERE m.tenant_id     = NEW.tenant_id
     AND m.stock_item_id = NEW.stock_item_id
     AND m.warehouse_id  = NEW.warehouse_id
     AND COALESCE(m.batch_no, '') = COALESCE(NEW.batch_no, '');

  resulting_qty := current_qty + NEW.quantity;

  SELECT COALESCE(SUM(r.quantity), 0) INTO reserved
    FROM stock_reservations r
   WHERE r.tenant_id     = NEW.tenant_id
     AND r.stock_item_id = NEW.stock_item_id
     AND r.warehouse_id  = NEW.warehouse_id
     AND COALESCE(r.batch_no, '') = COALESCE(NEW.batch_no, '')
     AND r.status IN ('held', 'picked');

  IF resulting_qty >= reserved THEN
    RETURN NEW;
  END IF;

  SELECT name INTO item_name FROM stock_items WHERE id = NEW.stock_item_id;

  -- ⚠️ NAME THE ORDERS THAT ARE IN THE WAY.
  --
  -- "Cannot go below reserved" tells the operator they are blocked and
  -- nothing about what to do next, so the next thing they try is a
  -- different route to the same wrong outcome. Listing the reservations
  -- turns the refusal into an instruction: these are the promises you
  -- must break first, and here is who they are.
  --
  -- ⚠️ THE JOIN IS A LEFT JOIN. `sales_order_id` is nullable on
  -- stock_reservations, so an inner join would silently drop exactly the
  -- reservations that have no order behind them — which are the ones
  -- hardest to trace and therefore the most important to name.
  SELECT string_agg(
           format('%s (%s)', COALESCE(so.order_no, 'reservation ' || left(r.id::text, 8)), r.quantity),
           ', ' ORDER BY r.created_at)
    INTO blocking
    FROM stock_reservations r
    LEFT JOIN sales_orders so
      ON so.id = r.sales_order_id AND so.tenant_id = r.tenant_id
   WHERE r.tenant_id     = NEW.tenant_id
     AND r.stock_item_id = NEW.stock_item_id
     AND r.warehouse_id  = NEW.warehouse_id
     AND COALESCE(r.batch_no, '') = COALESCE(NEW.batch_no, '')
     AND r.status IN ('held', 'picked');

  RAISE EXCEPTION
    'This movement would leave % of "%" in stock, but % are already promised to other orders: %. Post it and those orders would be short without anyone being told — the customer would find out on the day it was due. Release or reduce the reservations first, so that somebody decides which order is affected, then post this again.',
    resulting_qty,
    COALESCE(item_name, 'that item'),
    reserved,
    COALESCE(blocking, 'unknown')
    USING ERRCODE = 'raise_exception';
END $$;

COMMENT ON FUNCTION ordence_guard_stock_floor() IS
  'Refuses any stock movement that would leave on-hand below the quantity already reserved. Counterpart to ordence_guard_stock_reservation(); together they keep available = on_hand - reserved non-negative from both directions.';

-- ⚠️ THE NAME BEGINS `trg_020_`, AND THAT IS NOT DECORATION.
--
-- PostgreSQL fires BEFORE triggers on one table in ALPHABETICAL ORDER
-- of trigger name. 0029 §5 installs a BEFORE trigger on this same table
-- that validates the sign against the stated reason and requires a note
-- for adjustments. That one must run FIRST: refusing on a floor breach
-- before establishing that the row is even coherent produces a
-- confusing message for what is really a malformed entry.
--
-- Numeric prefixes make the ordering explicit rather than an accident of
-- how the trigger happened to be named.
DROP TRIGGER IF EXISTS trg_020_guard_stock_floor ON stock_movements;
CREATE TRIGGER trg_020_guard_stock_floor
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_stock_floor();

-- ════════════════════════════════════════════════════════════════════
-- §2  A REPORT FOR THE BREACHES THAT ALREADY EXIST
-- ════════════════════════════════════════════════════════════════════
--
-- The trigger stops NEW breaches. It cannot fix rows written before it
-- existed, and refusing to install until the data is clean would mean
-- the guard is never installed at all.
--
-- ⚠️ THESE ROWS ARE NOT A DATA-QUALITY CURIOSITY. Each one is a customer
-- who is going to be short, and nobody currently knows. Run this
-- immediately after applying the file, and work the list.
--
-- `security_invoker = true` — without it the view runs as its OWNER and
-- Row-Level Security does not apply, which on a view that spans every
-- tenant's stock is the most consequential kind of leak available.

CREATE OR REPLACE VIEW v_stock_over_committed
WITH (security_invoker = true) AS
SELECT b.tenant_id,
       b.stock_item_id,
       i.sku,
       i.name                                    AS item_name,
       b.warehouse_id,
       w.name                                    AS warehouse_name,
       NULLIF(b.batch_no, '')                    AS batch_no,
       b.quantity_on_hand,
       b.quantity_reserved,
       b.quantity_on_hand - b.quantity_reserved  AS available,
       b.updated_at
  FROM stock_balances b
  JOIN stock_items    i ON i.id = b.stock_item_id AND i.tenant_id = b.tenant_id
  JOIN warehouses     w ON w.id = b.warehouse_id  AND w.tenant_id = b.tenant_id
 WHERE b.quantity_on_hand < b.quantity_reserved;

COMMENT ON VIEW v_stock_over_committed IS
  'Rows where more stock is promised than exists. Every row is an order that will be short. Should be empty; 0040 stops new ones appearing.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- AFTER RUNNING THIS FILE, RUN THIS AND READ THE RESULT:
--
--   SELECT * FROM v_stock_over_committed;
--
-- Zero rows is the expected and required answer.
-- ════════════════════════════════════════════════════════════════════
