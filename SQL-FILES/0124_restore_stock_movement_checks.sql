-- ############################################################################
-- 0124 — THE STOCK LEDGER LOST THREE REFUSALS IN 0099, WHICH SAID IT KEPT THEM
--        (Infra wave 13 / v1.80.0-alpha)
-- ############################################################################
--
-- WHAT THIS FIXES
-- ---------------
-- `stock_movements` currently accepts all three of these:
--
--   ①  a `purchase_receipt` for a NEGATIVE quantity, or a `transfer_out` for
--      a POSITIVE one , arithmetically valid, completely wrong, and it flows
--      straight into `stock_balances` and every valuation derived from them
--   ②  a stock `adjustment` with NO NAMED APPROVER
--   ③  a `reversal` that names no movement to reverse
--
-- and it accepts an adjustment note of one character where ten were required.
--
-- `stock_movements` is INSERT-only and append-only. This BEFORE INSERT trigger
-- is the only enforcement point there has ever been for any of the four.
--
-- HOW THEY WERE LOST
-- ------------------
-- 0029_phase40_inventory.sql defined `ordence_validate_stock_movement()` with
-- all four checks and a paragraph of reasoning above each.
--
-- 0099_stock_movement_valuation.sql needed to change one thing: stop the
-- trigger overwriting a value the application had already costed through the
-- FIFO / weighted-average / standard-cost engine. A trigger function cannot be
-- patched in place, so 0099 reproduced the whole body , correctly reasoned,
-- and stated at line 81:
--
--     -- Everything above the valuation block is 0029 verbatim: the tenant
--     -- match, the sign-versus-reason check, the adjustment note, and the
--     -- negative-stock refusal with its `allow_negative_stock` escape.
--
-- 🔴 IT IS NOT. The sign-versus-reason check is absent. The approver check is
-- absent. The reversal-target check is absent. The note rule survived as
-- `btrim(...) = ''` instead of `length(btrim(...)) < 10`.
--
-- ⚠️ THE FILE'S OWN VERIFICATION COULD NOT SEE IT. 0099 checks its work by
-- grepping the new function body for `COALESCE(NEW.value_minor, 0) = 0`, which
-- is present, so it passes. A verification that looks for what was ADDED
-- cannot notice what was REMOVED.
--
-- ⚠️ AND 0099 GENUINELY IMPROVED ONE THING, which is why this file restores
-- rather than reverts: 0029 looked up the warehouse and the stock item by id
-- alone, so a movement could reference another tenant's warehouse. 0099 added
-- `AND tenant_id = NEW.tenant_id` to both lookups. That stays.
--
-- WHAT THIS FILE DOES
-- -------------------
-- Redefines the function as the union of both: 0099's tenant match and its
-- valuation rule, plus 0029's four refusals, restored verbatim including
-- their messages , which are written for the storekeeper who hits them, not
-- for a developer.
--
-- IS THERE DATA LOSS?  No. One function is replaced. No row is read or written.
--
-- ⚠️ EXISTING BAD ROWS ARE NOT CORRECTED, AND MUST NOT BE. A movement already
-- in the ledger is history. `stock_movements` is append-only precisely so that
-- a wrong figure is corrected by a REVERSAL that names it, not by an UPDATE
-- that erases it. The report at the end of this file lists any row that would
-- be refused today, so somebody can post the reversals deliberately.
--
-- RUN ORDER
-- ---------
-- After 0099. SQL FIRST, then the code.
--
-- ⚠️ NO BEGIN/COMMIT. Each statement is independently idempotent.
--
-- RLS
-- ---
-- Not applicable. No table is created or altered.
-- ############################################################################

CREATE OR REPLACE FUNCTION ordence_validate_stock_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  item        RECORD;
  wh          RECORD;
  current_qty numeric(18,3);
BEGIN
  /* --- 0099's tenant match. KEPT. --------------------------------- */
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

  /* --- §8  THE SIGN MUST MATCH THE STATED REASON. RESTORED. -------- */
  --
  -- ⚠️ A `purchase_receipt` for a NEGATIVE quantity is somebody's bug ,
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

  /* --- §5  AN ADJUSTMENT IS SOMEBODY OVERRULING THE SYSTEM. ------- */
  --
  -- ⚠️ It is occasionally correct and it is always where unexplained
  -- shrinkage enters. A note and a named approver do not stop theft;
  -- they make the pattern visible, which is the most any system can do.
  --
  -- 🔴 THE TEN-CHARACTER FLOOR IS NOT ARBITRARY. 0099 weakened this to
  -- "not empty", which accepts "x". A note that cannot be understood
  -- six months later by somebody who was not there is the same as no
  -- note, and it is worse, because it looks like a record.
  IF NEW.reason = 'adjustment' THEN
    IF NEW.adjustment_note IS NULL OR length(btrim(NEW.adjustment_note)) < 10 THEN
      RAISE EXCEPTION
        'A stock adjustment needs a written reason of at least ten characters. An adjustment is a person telling the system it is wrong. That is sometimes true , and it is also how stock quietly disappears, so every one of them has to be explainable later.'
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION
        'A stock adjustment needs a named approver. The person who noticed the discrepancy should not also be the only person who authorised writing it off.'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  /* --- A reversal must actually point at something. RESTORED. ------ */
  IF NEW.reason = 'reversal' AND NEW.reverses_movement_id IS NULL THEN
    RAISE EXCEPTION
      'A reversal must name the movement it reverses. A reversal that points at nothing is an adjustment with a friendlier label, and it will not be found by anyone auditing the original.'
      USING ERRCODE = 'raise_exception';
  END IF;

  /* --- §6  ⭐ NEGATIVE STOCK. Unchanged. --------------------------- */
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

  /* --- 0099's valuation rule. KEPT, with its reasoning. ------------ */
  --
  -- 🔴 A STATED VALUE IS EVIDENCE AND A DERIVED ONE IS A GUESS. When the
  --    caller has costed the movement through the valuation engine , FIFO
  --    layers, a running weighted average, a standard with its variance ,
  --    that figure is the answer, and rate x quantity is not.
  IF NEW.unit_cost_minor IS NOT NULL
     AND COALESCE(NEW.value_minor, 0) = 0 THEN
    NEW.value_minor := ROUND(NEW.unit_cost_minor * NEW.quantity)::bigint;
  END IF;

  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_validate_stock_movement ON stock_movements;
CREATE TRIGGER trg_validate_stock_movement
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_validate_stock_movement();


-- ----------------------------------------------------------------------------
-- VERIFY , BY WHAT IS PRESENT, NOT BY WHAT WAS ADDED
-- ----------------------------------------------------------------------------
--
-- ⚠️ 0099's verification looked for the one string it had added. That is why
-- it passed while three checks were missing. This one names every check that
-- must be present and raises if ANY is absent, so the next full-body rewrite
-- cannot quietly drop one either.

DO $$
DECLARE
  src     text;
  missing text[] := ARRAY[]::text[];
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'ordence_validate_stock_movement';

  IF src IS NULL THEN
    RAISE EXCEPTION '0124 FAILED: ordence_validate_stock_movement() is missing.';
  END IF;

  IF position('purchase_receipt'     in src) = 0 THEN missing := missing || 'sign-versus-reason (inward)';  END IF;
  IF position('sales_dispatch'       in src) = 0 THEN missing := missing || 'sign-versus-reason (outward)'; END IF;
  IF position('approved_by'          in src) = 0 THEN missing := missing || 'adjustment approver';          END IF;
  IF position('reverses_movement_id' in src) = 0 THEN missing := missing || 'reversal target';              END IF;
  IF position('< 10'                 in src) = 0 THEN missing := missing || 'ten-character note floor';     END IF;
  IF position('allow_negative_stock' in src) = 0 THEN missing := missing || 'negative stock';               END IF;
  IF position('value_minor'          in src) = 0 THEN missing := missing || 'stated valuation is kept';     END IF;
  IF position('tenant_id = NEW.tenant_id' in src) = 0 THEN missing := missing || 'tenant match';            END IF;

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION
      '0124 FAILED: the stock movement validator is missing % check(s): %. '
      'This trigger is the ONLY enforcement point on an append-only ledger.',
      cardinality(missing), array_to_string(missing, ', ')
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE '0124 PASS: all eight stock movement checks are present.';
END
$$;


-- ----------------------------------------------------------------------------
-- REPORT , ROWS ALREADY IN THE LEDGER THAT THIS TRIGGER WOULD NOW REFUSE
-- ----------------------------------------------------------------------------
--
-- ⚠️ A NOTICE, NOT AN EXCEPTION, AND NOTHING IS CORRECTED. These rows are
-- history on an append-only table. The right correction is a reversal that
-- names the movement, posted deliberately by somebody who can explain it.
-- Blocking the migration on them would only mean the checks stay off.

DO $$
DECLARE
  wrong_sign   bigint;
  no_approver  bigint;
  no_target    bigint;
  thin_note    bigint;
BEGIN
  IF to_regclass('public.stock_movements') IS NULL THEN
    RETURN;
  END IF;

  SELECT
    count(*) FILTER (
      WHERE (reason::text IN ('purchase_receipt','sales_return','transfer_in',
                              'production_output','opening_balance') AND quantity < 0)
         OR (reason::text IN ('sales_dispatch','purchase_return','transfer_out',
                              'production_consume','damage','theft','expiry') AND quantity > 0)),
    count(*) FILTER (WHERE reason::text = 'adjustment' AND approved_by IS NULL),
    count(*) FILTER (WHERE reason::text = 'reversal'   AND reverses_movement_id IS NULL),
    count(*) FILTER (WHERE reason::text = 'adjustment'
                       AND (adjustment_note IS NULL OR length(btrim(adjustment_note)) < 10))
    INTO wrong_sign, no_approver, no_target, thin_note
    FROM stock_movements;

  IF wrong_sign + no_approver + no_target + thin_note = 0 THEN
    RAISE NOTICE
      '0124: no movement already in the ledger would be refused by the '
      'restored checks. Nothing to correct.';
  ELSE
    RAISE NOTICE
      '0124 ⚠️ EXISTING ROWS THAT THE RESTORED CHECKS WOULD REFUSE: '
      'wrong sign for the reason = %, adjustment with no approver = %, '
      'reversal naming nothing = %, adjustment note under ten characters = %. '
      'These are NOT corrected here. stock_movements is append-only: correct a '
      'wrong figure with a reversal that names it, not with an UPDATE that '
      'hides it. Every one of these is a valuation somebody may have to explain.',
      wrong_sign, no_approver, no_target, thin_note;
  END IF;
END
$$;
