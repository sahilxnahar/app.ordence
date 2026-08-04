-- ════════════════════════════════════════════════════════════════════
-- Ordence — Phase 40: Inventory
-- File: 0029_phase40_inventory.sql
-- Version: v0.40.0-alpha
-- ════════════════════════════════════════════════════════════════════
--
--   §1  Row-Level Security, ENABLED and FORCED, on all seven tables
--   §2  Composite foreign keys — a child row cannot cross tenants
--   §3  ⭐ THE LEDGER IS APPEND-ONLY. No UPDATE. No DELETE. Ever.
--   §4  Balances recomputed from the ledger on every movement
--   §5  An adjustment needs a written note and a named approver
--   §6  ⭐ Stock cannot go negative unless that store is allowed to
--   §7  ⭐ A reservation cannot exceed what is actually available
--   §8  A movement's sign must match its stated reason
--
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- §1  ROW-LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'warehouses','stock_items','stock_movements','stock_balances',
    'stock_reservations','stock_counts','stock_count_lines'
  ]
  LOOP
    -- ⚠️ ENABLE without FORCE is RLS that has never once been evaluated,
    -- because the table owner bypasses every policy and the owner is the
    -- role the application connects as on Neon.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I
        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    $p$, t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- §2  COMPOSITE FOREIGN KEYS
-- ════════════════════════════════════════════════════════════════════
--
-- ⭐ A plain `warehouse_id -> warehouses(id)` says the parent EXISTS. It
-- does not say the parent is OURS. Referencing (id, tenant_id) is what
-- makes a movement into another workspace's warehouse impossible in the
-- database rather than in a code review.

DO $ordence$
DECLARE
  spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['stock_movements',    'stock_item_id',  'stock_items',  'RESTRICT'],
    ['stock_movements',    'warehouse_id',   'warehouses',   'RESTRICT'],
    ['stock_balances',     'stock_item_id',  'stock_items',  'CASCADE'],
    ['stock_balances',     'warehouse_id',   'warehouses',   'CASCADE'],
    ['stock_reservations', 'stock_item_id',  'stock_items',  'CASCADE'],
    ['stock_reservations', 'warehouse_id',   'warehouses',   'CASCADE'],
    ['stock_counts',       'warehouse_id',   'warehouses',   'RESTRICT'],
    ['stock_count_lines',  'count_id',       'stock_counts', 'CASCADE'],
    ['stock_count_lines',  'stock_item_id',  'stock_items',  'RESTRICT']
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
                   spec[1], spec[1] || '_' || spec[2] || '_tenant_fk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, tenant_id)
         REFERENCES %I (id, tenant_id) ON DELETE %s',
      spec[1], spec[1] || '_' || spec[2] || '_tenant_fk', spec[2],
      spec[3], spec[4]);
  END LOOP;
END $ordence$;

-- The reversal pointer must land on a movement in the same workspace.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reverses_tenant_fk;
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_reverses_tenant_fk
  FOREIGN KEY (reverses_movement_id, tenant_id)
  REFERENCES stock_movements (id, tenant_id)
  ON DELETE RESTRICT;

-- ════════════════════════════════════════════════════════════════════
-- §3  ⭐ THE LEDGER IS APPEND-ONLY
-- ════════════════════════════════════════════════════════════════════
--
-- This is the phase. Everything else is arithmetic on top of it.
--
-- An inventory history that can be edited is an inventory history nobody
-- can rely on — and inventory arguments are with suppliers, over money,
-- months after the fact. The whole value of a ledger is that the past
-- does not move. One UPDATE statement in a support script is enough to
-- destroy that permanently and silently, so the guarantee cannot live in
-- application code that a psql prompt bypasses.
--
-- ⚠️ THERE IS NO ESCAPE HATCH HERE, DELIBERATELY. The freeze on order
-- lines in Phase 39 has one (`app.order_amendment_id`) because amending a
-- live order is a real business act. Correcting stock is NOT: it is a
-- reversing movement, which is a normal INSERT and needs no exemption. A
-- setting that unlocked this table would exist only to be misused.

CREATE OR REPLACE FUNCTION ordence_stock_ledger_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Stock movements cannot be deleted. This one is dated % for % unit(s). To correct it, post a REVERSAL for the opposite quantity with reverses_movement_id = %. That leaves both the mistake and the correction on the record, each with a date and a person against it — which is what you will need if a supplier disputes a delivery six months from now.',
      OLD.moved_at, OLD.quantity, OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  RAISE EXCEPTION
    'Stock movements cannot be edited. Movement % is dated % for % unit(s). Post a REVERSAL and then the correct movement. A stock history that can be rewritten is a stock history that proves nothing, and the whole reason this table exists is so that a wrong balance can be explained rather than merely corrected.',
    OLD.id, OLD.moved_at, OLD.quantity
    USING ERRCODE = 'raise_exception';
END $$;

DROP TRIGGER IF EXISTS trg_stock_ledger_append_only ON stock_movements;
CREATE TRIGGER trg_stock_ledger_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_stock_ledger_append_only();

-- ════════════════════════════════════════════════════════════════════
-- §4, §5, §6, §8  WHAT HAPPENS WHEN A MOVEMENT IS POSTED
-- ════════════════════════════════════════════════════════════════════
--
-- One BEFORE trigger validates, one AFTER trigger maintains the cache.
-- Split deliberately: validation must be able to refuse before anything
-- is written, and the cache update must see the committed row.

CREATE OR REPLACE FUNCTION ordence_validate_stock_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  wh          RECORD;
  item        RECORD;
  current_qty numeric(18,3);
BEGIN
  SELECT * INTO wh FROM warehouses WHERE id = NEW.warehouse_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That warehouse does not exist.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO item FROM stock_items WHERE id = NEW.stock_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That stock item does not exist.' USING ERRCODE = 'raise_exception';
  END IF;

  /* --- §8  THE SIGN MUST MATCH THE STATED REASON ------------------- */
  --
  -- ⚠️ A `purchase_receipt` for a NEGATIVE quantity is somebody's bug —
  -- a sign flipped in a loop, an import column read backwards. It is
  -- perfectly valid arithmetic and completely wrong, and left alone it
  -- shows up months later as a valuation nobody can explain. Caught at
  -- entry it is a two-minute fix.
  IF NEW.reason::text IN ('purchase_receipt','sales_return','transfer_in',
                          'production_output','opening_balance')
     AND NEW.quantity < 0 THEN
    RAISE EXCEPTION
      'A % adds stock, so its quantity must be positive. You entered %. If you meant to take stock out, use the matching outward reason; if you are correcting an earlier receipt, post a reversal against it.',
      NEW.reason, NEW.quantity
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.reason::text IN ('sales_dispatch','purchase_return','transfer_out',
                          'production_consume','damage','theft','expiry')
     AND NEW.quantity > 0 THEN
    RAISE EXCEPTION
      'A % takes stock out, so its quantity must be negative. You entered %.',
      NEW.reason, NEW.quantity
      USING ERRCODE = 'raise_exception';
  END IF;

  /* --- §5  AN ADJUSTMENT IS SOMEBODY OVERRULING THE SYSTEM --------- */
  --
  -- ⚠️ It is occasionally correct and it is always where unexplained
  -- shrinkage enters. A note and a named approver do not stop theft;
  -- they make the pattern visible, which is the most any system can do.
  IF NEW.reason = 'adjustment' THEN
    IF NEW.adjustment_note IS NULL OR length(btrim(NEW.adjustment_note)) < 10 THEN
      RAISE EXCEPTION
        'A stock adjustment needs a written reason of at least ten characters. An adjustment is a person telling the system it is wrong. That is sometimes true — and it is also how stock quietly disappears, so every one of them has to be explainable later.'
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION
        'A stock adjustment needs a named approver. The person who noticed the discrepancy should not also be the only person who authorised writing it off.'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  /* --- A reversal must actually point at something ----------------- */
  IF NEW.reason = 'reversal' AND NEW.reverses_movement_id IS NULL THEN
    RAISE EXCEPTION
      'A reversal must name the movement it reverses. A reversal that points at nothing is an adjustment with a friendlier label, and it will not be found by anyone auditing the original.'
      USING ERRCODE = 'raise_exception';
  END IF;

  /* --- §6  ⭐ NEGATIVE STOCK ---------------------------------------- */
  --
  -- ⚠️ Negative stock means the system believes goods were issued that
  -- were never received — the paperwork is behind the lorry. Some site
  -- stores genuinely work that way and blocking it stops real work. But
  -- it has to be a decision somebody made about a specific store, not
  -- silent behaviour everywhere, because every valuation derived from a
  -- negative balance is meaningless.
  IF NEW.quantity < 0 AND NOT wh.allow_negative_stock THEN
    SELECT COALESCE(SUM(m.quantity), 0) INTO current_qty
      FROM stock_movements m
     WHERE m.stock_item_id = NEW.stock_item_id
       AND m.warehouse_id  = NEW.warehouse_id
       AND COALESCE(m.batch_no, '') = COALESCE(NEW.batch_no, '');

    IF current_qty + NEW.quantity < 0 THEN
      RAISE EXCEPTION
        'Not enough stock. "%" at % has % % on hand%, and this movement takes out %. Either the receipt has not been entered yet, or the quantity is wrong. If this store really does issue before it receives, switch on "allow negative stock" for it — deliberately, because every valuation for this store then depends on paperwork catching up.',
        item.name, wh.name, current_qty, item.uom,
        CASE WHEN NEW.batch_no IS NOT NULL
             THEN ' in batch ' || NEW.batch_no ELSE '' END,
        abs(NEW.quantity)
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  /* --- Value the movement, in integer paise ------------------------ */
  IF NEW.unit_cost_minor IS NOT NULL THEN
    -- Quantity is scaled by 1000 to stay in integers; ROUND applies the
    -- rounding explicitly rather than letting a cast decide silently.
    NEW.value_minor := ROUND(NEW.unit_cost_minor * NEW.quantity)::bigint;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_stock_movement ON stock_movements;
CREATE TRIGGER trg_validate_stock_movement
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_validate_stock_movement();

-- ════════════════════════════════════════════════════════════════════
-- §4  THE BALANCE CACHE
-- ════════════════════════════════════════════════════════════════════
--
-- ⚠️ RECOMPUTED FROM THE LEDGER, NOT INCREMENTED. An incremental
-- `balance = balance + NEW.quantity` is the drifting integer this phase
-- exists to avoid, just moved one table across. Summing the ledger for
-- one item in one store is an index lookup, and it is correct by
-- construction: if the cache row were deleted it would come back right.

CREATE OR REPLACE FUNCTION ordence_refresh_stock_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  agg RECORD;
BEGIN
  SELECT COALESCE(SUM(m.quantity), 0)     AS qty,
         COALESCE(SUM(m.value_minor), 0)  AS val,
         MAX(m.moved_at)                  AS last_at
    INTO agg
    FROM stock_movements m
   WHERE m.tenant_id     = NEW.tenant_id
     AND m.stock_item_id = NEW.stock_item_id
     AND m.warehouse_id  = NEW.warehouse_id
     AND COALESCE(m.batch_no, '') = COALESCE(NEW.batch_no, '');

  INSERT INTO stock_balances (
    tenant_id, stock_item_id, warehouse_id, batch_no,
    quantity_on_hand, value_minor, last_movement_at, updated_at)
  VALUES (
    NEW.tenant_id, NEW.stock_item_id, NEW.warehouse_id,
    COALESCE(NEW.batch_no, ''),
    agg.qty, agg.val, agg.last_at, now())
  ON CONFLICT (tenant_id, stock_item_id, warehouse_id, batch_no)
  DO UPDATE SET
    quantity_on_hand = EXCLUDED.quantity_on_hand,
    value_minor      = EXCLUDED.value_minor,
    last_movement_at = EXCLUDED.last_movement_at,
    updated_at       = now();

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_refresh_stock_balance ON stock_movements;
CREATE TRIGGER trg_refresh_stock_balance
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_refresh_stock_balance();

-- ════════════════════════════════════════════════════════════════════
-- §7  ⭐ A RESERVATION CANNOT EXCEED WHAT IS AVAILABLE
-- ════════════════════════════════════════════════════════════════════
--
--        AVAILABLE = ON HAND − ALREADY RESERVED
--
-- Four hundred bags in the shed and three hundred promised to Thursday's
-- order means one hundred are sellable, not four hundred. Without this
-- check a salesperson looking at the on-hand figure sells the same
-- cement twice, and nobody finds out until Thursday.
--
-- ⚠️ THE ROW IS LOCKED FIRST. Two salespeople clicking at the same
-- instant would otherwise both read "100 available" and both reserve it.
-- The lock is what makes the check mean anything under concurrency; the
-- arithmetic alone does not.

CREATE OR REPLACE FUNCTION ordence_guard_stock_reservation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  on_hand   numeric(18,3);
  reserved  numeric(18,3);
  available numeric(18,3);
  item_name text;
BEGIN
  IF NEW.status NOT IN ('held', 'picked') THEN
    RETURN NEW;   -- releasing or consuming frees stock; nothing to check
  END IF;

  SELECT COALESCE(b.quantity_on_hand, 0) INTO on_hand
    FROM stock_balances b
   WHERE b.tenant_id     = NEW.tenant_id
     AND b.stock_item_id = NEW.stock_item_id
     AND b.warehouse_id  = NEW.warehouse_id
     AND b.batch_no      = COALESCE(NEW.batch_no, '')
   FOR UPDATE;

  on_hand := COALESCE(on_hand, 0);

  SELECT COALESCE(SUM(r.quantity), 0) INTO reserved
    FROM stock_reservations r
   WHERE r.tenant_id     = NEW.tenant_id
     AND r.stock_item_id = NEW.stock_item_id
     AND r.warehouse_id  = NEW.warehouse_id
     AND COALESCE(r.batch_no, '') = COALESCE(NEW.batch_no, '')
     AND r.status IN ('held', 'picked')
     AND (TG_OP = 'INSERT' OR r.id <> NEW.id);

  available := on_hand - reserved;

  IF NEW.quantity > available THEN
    SELECT name INTO item_name FROM stock_items WHERE id = NEW.stock_item_id;
    RAISE EXCEPTION
      'Cannot reserve % of "%". There are % on hand but % are already promised to other orders, so only % can be sold. Reserving more would promise the same stock to two customers, and neither of them would find out until the day it was due.',
      NEW.quantity, COALESCE(item_name, 'that item'),
      on_hand, reserved, available
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_stock_reservation ON stock_reservations;
CREATE TRIGGER trg_guard_stock_reservation
  BEFORE INSERT OR UPDATE ON stock_reservations
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_stock_reservation();

-- Keep the reserved figure on the balance cache in step.
CREATE OR REPLACE FUNCTION ordence_refresh_reserved_quantity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r RECORD;
  total numeric(18,3);
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  SELECT COALESCE(SUM(x.quantity), 0) INTO total
    FROM stock_reservations x
   WHERE x.tenant_id     = r.tenant_id
     AND x.stock_item_id = r.stock_item_id
     AND x.warehouse_id  = r.warehouse_id
     AND COALESCE(x.batch_no, '') = COALESCE(r.batch_no, '')
     AND x.status IN ('held', 'picked');

  UPDATE stock_balances
     SET quantity_reserved = total, updated_at = now()
   WHERE tenant_id     = r.tenant_id
     AND stock_item_id = r.stock_item_id
     AND warehouse_id  = r.warehouse_id
     AND batch_no      = COALESCE(r.batch_no, '');

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_refresh_reserved_quantity ON stock_reservations;
CREATE TRIGGER trg_refresh_reserved_quantity
  AFTER INSERT OR UPDATE OR DELETE ON stock_reservations
  FOR EACH ROW EXECUTE FUNCTION ordence_refresh_reserved_quantity();

-- ════════════════════════════════════════════════════════════════════
-- updated_at
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ordence_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouses','stock_items','stock_counts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_touch_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW
         EXECUTE FUNCTION ordence_touch_updated_at()', 'trg_touch_' || t, t);
  END LOOP;
END $$;

COMMIT;
