-- ════════════════════════════════════════════════════════════════════
-- Ordence — Phase 39: Sales Orders, Lines and Fulfilment
-- File: 0028_phase39_orders.sql
-- Version: v0.39.0-alpha
-- ════════════════════════════════════════════════════════════════════
--
-- RUN THIS AFTER the tables exist (drizzle-kit push, or the generated
-- 00-CREATE-TABLES file). This script adds the guarantees; it does not
-- create the tables.
--
-- WHAT THIS FILE GUARANTEES, AND WHY IT — NOT THE APPLICATION — DOES IT
-- ────────────────────────────────────────────────────────────────────
-- The server actions in `server/actions/orders.ts` are ONE write path.
-- The others are a back-fill of a year of historical orders, a support
-- fix at a psql prompt, and (from Phase 41) a public REST API used by a
-- customer's own procurement system with no human reading anything. The
-- back-fill is where the volume is; the API is where the malformed input
-- is. A rule enforced only in TypeScript is a rule those two bypass.
--
--   §1  Row-Level Security, ENABLED and FORCED, on all five tables
--   §2  Composite foreign keys — a child row cannot cross tenants
--   §3  ⭐ Confirmed lines are frozen; edits require an amendment
--   §4  Order totals and progress recomputed from the lines
--   §5  ⭐ A fulfilment can never dispatch more than was ordered
--   §6  Cancellation requires a named human and a reason
--   §7  Legal status transitions only
--   §8  updated_at maintenance
--
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- §1  ROW-LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════════
--
-- ⚠️ ENABLE alone is not enough. Without FORCE, the table OWNER bypasses
-- every policy — and the owner is the role the application connects as
-- on most managed Postgres providers, including Neon. `ENABLE` without
-- `FORCE` is the single most common way a multi-tenant product ships
-- with RLS that has never once been evaluated.

ALTER TABLE sales_orders                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_orders                    FORCE  ROW LEVEL SECURITY;
ALTER TABLE sales_order_lines               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_lines               FORCE  ROW LEVEL SECURITY;
ALTER TABLE sales_order_fulfillments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_fulfillments        FORCE  ROW LEVEL SECURITY;
ALTER TABLE sales_order_fulfillment_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_fulfillment_lines   FORCE  ROW LEVEL SECURITY;
ALTER TABLE sales_order_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_events              FORCE  ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sales_orders',
    'sales_order_lines',
    'sales_order_fulfillments',
    'sales_order_fulfillment_lines',
    'sales_order_events'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    -- ⚠️ current_setting(..., true) returns NULL when the setting is
    -- absent, and `tenant_id = NULL` is NULL, which is not TRUE, so the
    -- row is invisible. A connection that forgot to set the tenant sees
    -- NOTHING rather than everything. That is the intended failure.
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
-- ⭐ A plain `order_id -> sales_orders(id)` foreign key says the parent
-- EXISTS. It does not say the parent belongs to the same tenant. With a
-- leaked or guessed UUID, a line could be attached to another workspace's
-- order — the insert would satisfy the FK, satisfy the line's own RLS
-- policy (its tenant_id is ours), and produce a row that shows up on
-- somebody else's order screen.
--
-- Referencing (id, tenant_id) makes that impossible in the database
-- rather than in a code review.

ALTER TABLE sales_order_lines
  DROP CONSTRAINT IF EXISTS sales_order_lines_order_tenant_fk;
ALTER TABLE sales_order_lines
  ADD CONSTRAINT sales_order_lines_order_tenant_fk
  FOREIGN KEY (order_id, tenant_id)
  REFERENCES sales_orders (id, tenant_id)
  ON DELETE CASCADE;

ALTER TABLE sales_order_fulfillments
  DROP CONSTRAINT IF EXISTS sales_order_fulfillments_order_tenant_fk;
ALTER TABLE sales_order_fulfillments
  ADD CONSTRAINT sales_order_fulfillments_order_tenant_fk
  FOREIGN KEY (order_id, tenant_id)
  REFERENCES sales_orders (id, tenant_id)
  ON DELETE CASCADE;

ALTER TABLE sales_order_fulfillment_lines
  DROP CONSTRAINT IF EXISTS sales_order_fulfillment_lines_fulfillment_tenant_fk;
ALTER TABLE sales_order_fulfillment_lines
  ADD CONSTRAINT sales_order_fulfillment_lines_fulfillment_tenant_fk
  FOREIGN KEY (fulfillment_id, tenant_id)
  REFERENCES sales_order_fulfillments (id, tenant_id)
  ON DELETE CASCADE;

ALTER TABLE sales_order_fulfillment_lines
  DROP CONSTRAINT IF EXISTS sales_order_fulfillment_lines_order_line_tenant_fk;
ALTER TABLE sales_order_fulfillment_lines
  ADD CONSTRAINT sales_order_fulfillment_lines_order_line_tenant_fk
  FOREIGN KEY (order_line_id, tenant_id)
  REFERENCES sales_order_lines (id, tenant_id)
  ON DELETE RESTRICT;

ALTER TABLE sales_order_events
  DROP CONSTRAINT IF EXISTS sales_order_events_order_tenant_fk;
ALTER TABLE sales_order_events
  ADD CONSTRAINT sales_order_events_order_tenant_fk
  FOREIGN KEY (order_id, tenant_id)
  REFERENCES sales_orders (id, tenant_id)
  ON DELETE CASCADE;

-- ════════════════════════════════════════════════════════════════════
-- §3  ⭐ A CONFIRMED LINE IS FROZEN
-- ════════════════════════════════════════════════════════════════════
--
-- This is the reason Phase 39 exists as a phase rather than as a table.
--
-- Once an order is confirmed, its lines are the reference every other
-- number in the system is measured against: what may be dispatched, what
-- may be invoiced, what revenue is recognised, what commission is owed,
-- and what the customer holds on paper. Editing a confirmed line moves
-- all of those retroactively and silently.
--
-- The trigger permits exactly the columns that MUST move as the order
-- progresses — the four quantity counters, the audit stamps — and
-- refuses price, quantity, tax and identity. A genuine change is an
-- AMENDMENT: the application bumps `revision`, and this trigger lets the
-- write through only when it sees that bump on the parent in the same
-- statement (recorded via app.order_amendment_id).

CREATE OR REPLACE FUNCTION ordence_freeze_confirmed_order_line()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_status text;
  amending      text;
  passthrough   sales_order_lines;
BEGIN
  -- ⚠️ `NEW` IS NULL ON DELETE AND `OLD` IS NULL ON INSERT. Reading
  -- NEW.order_id unconditionally makes the DELETE branch look up a NULL
  -- id, find nothing, take the "not confirmed, allow it" path — and then
  -- `RETURN NEW` returns NULL, which in a BEFORE trigger CANCELS the row
  -- operation silently. The delete reports "DELETE 0" and nobody is told
  -- anything. Silently doing nothing is the worst of the three possible
  -- outcomes: worse than allowing it, and far worse than refusing it,
  -- because the operator believes the line is gone.
  passthrough := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  SELECT status::text INTO parent_status
    FROM sales_orders
   WHERE id = COALESCE(NEW.order_id, OLD.order_id);

  IF parent_status IS NULL OR parent_status IN ('draft', 'pending_approval') THEN
    RETURN passthrough;
  END IF;

  -- An explicit, audited amendment is allowed through. The application
  -- sets this for the duration of one transaction and never leaves it on.
  amending := NULLIF(current_setting('app.order_amendment_id', true), '');
  IF amending IS NOT NULL THEN
    RETURN passthrough;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Order line % cannot be deleted: the order is %. A confirmed line is what the customer agreed to and what every dispatch, invoice and commission figure is measured against. Cancel the line quantity instead — that leaves the commitment on the record and shows the customer what changed.',
      OLD.line_no, parent_status
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.quantity        IS DISTINCT FROM OLD.quantity
  OR NEW.unit_price_minor IS DISTINCT FROM OLD.unit_price_minor
  OR NEW.discount_minor   IS DISTINCT FROM OLD.discount_minor
  OR NEW.taxable_value_minor IS DISTINCT FROM OLD.taxable_value_minor
  OR NEW.cgst_minor      IS DISTINCT FROM OLD.cgst_minor
  OR NEW.sgst_minor      IS DISTINCT FROM OLD.sgst_minor
  OR NEW.igst_minor      IS DISTINCT FROM OLD.igst_minor
  OR NEW.cess_minor      IS DISTINCT FROM OLD.cess_minor
  OR NEW.line_total_minor IS DISTINCT FROM OLD.line_total_minor
  OR NEW.hsn_sac_rate_id IS DISTINCT FROM OLD.hsn_sac_rate_id
  OR NEW.hsn_sac_code_id IS DISTINCT FROM OLD.hsn_sac_code_id
  OR NEW.tax_rate_bps    IS DISTINCT FROM OLD.tax_rate_bps
  OR NEW.asset_id        IS DISTINCT FROM OLD.asset_id
  OR NEW.description     IS DISTINCT FROM OLD.description
  OR NEW.uom             IS DISTINCT FROM OLD.uom
  OR NEW.line_no         IS DISTINCT FROM OLD.line_no
  THEN
    RAISE EXCEPTION
      'Order line % is frozen: the order is % and this changes price, quantity, tax or description. These are what the customer agreed to, and every dispatchable quantity, invoice, revenue figure and commission is derived from them — changing one here restates all of them for work already done, with nothing on the record saying so. Raise an amendment instead: it does the same change, bumps the revision the warehouse and the customer can see, and says who made it and why.',
      OLD.line_no, parent_status
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_freeze_confirmed_order_line ON sales_order_lines;
CREATE TRIGGER trg_freeze_confirmed_order_line
  BEFORE UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION ordence_freeze_confirmed_order_line();

-- ════════════════════════════════════════════════════════════════════
-- §4  ORDER TOTALS AND PROGRESS, RECOMPUTED FROM THE LINES
-- ════════════════════════════════════════════════════════════════════
--
-- The header figures are denormalised so an order list does not have to
-- aggregate every line of every order. Denormalised numbers drift; the
-- only defence is that nothing but the database is allowed to write them.
--
-- ⚠️ THE PROGRESS FIGURES ARE VALUE-WEIGHTED, NOT LINE-COUNTED. An order
-- with one ₹50 line dispatched and one ₹50,00,000 line outstanding is 0.001%
-- fulfilled, not 50%. A line-counted percentage on a screen is how an
-- operations meeting concludes an order is nearly done.

CREATE OR REPLACE FUNCTION ordence_recompute_order_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target uuid;
BEGIN
  target := COALESCE(NEW.order_id, OLD.order_id);

  UPDATE sales_orders o
     SET subtotal_minor       = COALESCE(agg.subtotal, 0),
         discount_minor       = COALESCE(agg.discount, 0),
         taxable_value_minor  = COALESCE(agg.taxable, 0),
         cgst_minor           = COALESCE(agg.cgst, 0),
         sgst_minor           = COALESCE(agg.sgst, 0),
         igst_minor           = COALESCE(agg.igst, 0),
         cess_minor           = COALESCE(agg.cess, 0),
         total_minor          = COALESCE(agg.total, 0) + o.other_charges_minor + o.round_off_minor,
         fulfilled_value_minor = COALESCE(agg.fulfilled_value, 0),
         invoiced_value_minor  = COALESCE(agg.invoiced_value, 0),
         updated_at            = now()
    FROM (
      SELECT
        SUM(l.unit_price_minor * ROUND(l.quantity)::bigint)     AS subtotal,
        SUM(l.discount_minor)                                    AS discount,
        SUM(l.taxable_value_minor)                               AS taxable,
        SUM(l.cgst_minor)                                        AS cgst,
        SUM(l.sgst_minor)                                        AS sgst,
        SUM(l.igst_minor)                                        AS igst,
        SUM(l.cess_minor)                                        AS cess,
        SUM(l.line_total_minor)                                  AS total,
        -- Value-weighted, and integer-safe: the ratio is applied to the
        -- line total in paise and truncated, never floated.
        SUM(
          CASE WHEN l.quantity > 0
               THEN (l.line_total_minor * ROUND(l.qty_fulfilled * 1000)::bigint)
                    / ROUND(l.quantity * 1000)::bigint
               ELSE 0 END
        )                                                        AS fulfilled_value,
        SUM(
          CASE WHEN l.quantity > 0
               THEN (l.line_total_minor * ROUND(l.qty_invoiced * 1000)::bigint)
                    / ROUND(l.quantity * 1000)::bigint
               ELSE 0 END
        )                                                        AS invoiced_value
      FROM sales_order_lines l
      WHERE l.order_id = target
    ) AS agg
   WHERE o.id = target;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_recompute_order_totals ON sales_order_lines;
CREATE TRIGGER trg_recompute_order_totals
  AFTER INSERT OR UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION ordence_recompute_order_totals();

-- ════════════════════════════════════════════════════════════════════
-- §5  ⭐ A FULFILMENT CANNOT DISPATCH MORE THAN WAS ORDERED
-- ════════════════════════════════════════════════════════════════════
--
-- The CHECK constraint on the line catches the final state. This catches
-- the ATTEMPT, and names the line, so the operator sees "line 3 has 40
-- outstanding, you entered 60" instead of a constraint name.
--
-- ⚠️ IT ALSO WRITES BACK `qty_fulfilled`. That column is derived from the
-- fulfilment lines and must never be typed by anybody; letting the
-- application maintain it means a dispatch that succeeds and a counter
-- that silently does not move.

CREATE OR REPLACE FUNCTION ordence_apply_fulfillment_line()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  line      RECORD;
  delta     numeric(18,3);
  new_total numeric(18,3);
  parent    text;
BEGIN
  delta := COALESCE(NEW.quantity, 0) - COALESCE(OLD.quantity, 0);
  IF TG_OP = 'DELETE' THEN
    delta := -OLD.quantity;
  END IF;

  SELECT l.*, o.status::text AS order_status
    INTO line
    FROM sales_order_lines l
    JOIN sales_orders o ON o.id = l.order_id
   WHERE l.id = COALESCE(NEW.order_line_id, OLD.order_line_id)
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order line not found for this dispatch.'
      USING ERRCODE = 'raise_exception';
  END IF;

  parent := line.order_status;

  IF TG_OP <> 'DELETE' AND parent IN ('draft', 'pending_approval') THEN
    RAISE EXCEPTION
      'Nothing may be dispatched against a % order. Confirm it first — a dispatch against a draft is goods leaving the building on a commitment nobody has made.',
      parent
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP <> 'DELETE' AND parent = 'cancelled' THEN
    RAISE EXCEPTION
      'This order is cancelled. Nothing may be dispatched against it.'
      USING ERRCODE = 'raise_exception';
  END IF;

  new_total := line.qty_fulfilled + delta;

  IF new_total < 0 THEN
    RAISE EXCEPTION
      'Line % would fall below zero dispatched. Reverse the delivery challan rather than editing the quantity downwards.',
      line.line_no
      USING ERRCODE = 'raise_exception';
  END IF;

  IF new_total + line.qty_cancelled > line.quantity THEN
    RAISE EXCEPTION
      'Line % is over-dispatched. Ordered %, already dispatched %, cancelled % — that leaves % outstanding, and this challan is for %. Dispatching more than was ordered sends goods the customer never agreed to buy and cannot be invoiced against this order.',
      line.line_no,
      line.quantity, line.qty_fulfilled, line.qty_cancelled,
      (line.quantity - line.qty_fulfilled - line.qty_cancelled),
      COALESCE(NEW.quantity, 0)
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE sales_order_lines
     SET qty_fulfilled = new_total,
         updated_at    = now()
   WHERE id = line.id;

  -- Move the header status to match reality, but never out of a terminal
  -- or held state — those were set by a human for a reason.
  UPDATE sales_orders o
     SET status = CASE
           WHEN o.status IN ('cancelled', 'closed', 'on_hold') THEN o.status
           WHEN NOT EXISTS (
             SELECT 1 FROM sales_order_lines l
              WHERE l.order_id = o.id
                AND l.qty_fulfilled + l.qty_cancelled < l.quantity
           ) THEN 'fulfilled'::sales_order_status
           WHEN EXISTS (
             SELECT 1 FROM sales_order_lines l
              WHERE l.order_id = o.id AND l.qty_fulfilled > 0
           ) THEN 'partially_fulfilled'::sales_order_status
           ELSE o.status
         END,
         updated_at = now()
   WHERE o.id = line.order_id;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_apply_fulfillment_line ON sales_order_fulfillment_lines;
CREATE TRIGGER trg_apply_fulfillment_line
  AFTER INSERT OR UPDATE OR DELETE ON sales_order_fulfillment_lines
  FOR EACH ROW EXECUTE FUNCTION ordence_apply_fulfillment_line();

-- ════════════════════════════════════════════════════════════════════
-- §6 & §7  CANCELLATION EVIDENCE AND LEGAL TRANSITIONS
-- ════════════════════════════════════════════════════════════════════
--
-- ⚠️ `closed` IS NOT REACHABLE FROM `confirmed`. An order that shipped
-- nothing and was "closed" is a cancellation wearing a friendlier word,
-- and it is precisely how delivery performance gets overstated in a
-- board pack: the cancelled orders quietly become completed ones.

CREATE OR REPLACE FUNCTION ordence_guard_order_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  legal text[];
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  legal := CASE OLD.status::text
    WHEN 'draft'               THEN ARRAY['pending_approval','confirmed','cancelled']
    WHEN 'pending_approval'    THEN ARRAY['confirmed','draft','cancelled']
    WHEN 'confirmed'           THEN ARRAY['partially_fulfilled','fulfilled','on_hold','cancelled']
    WHEN 'partially_fulfilled' THEN ARRAY['fulfilled','on_hold','closed','cancelled']
    WHEN 'fulfilled'           THEN ARRAY['closed','partially_fulfilled']
    WHEN 'on_hold'             THEN ARRAY['confirmed','partially_fulfilled','cancelled']
    WHEN 'closed'              THEN ARRAY[]::text[]
    WHEN 'cancelled'           THEN ARRAY[]::text[]
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status::text = ANY(legal)) THEN
    RAISE EXCEPTION
      'Order % cannot go from % to %. Allowed from here: %. A "closed" order means it finished — delivered and invoiced. An order that stopped is "cancelled". Reporting them as one number overstates what was actually delivered.',
      NEW.order_no, OLD.status, NEW.status,
      COALESCE(NULLIF(array_to_string(legal, ', '), ''), 'nothing — this is a final state')
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by IS NULL
       OR NEW.cancellation_reason IS NULL
       OR length(btrim(NEW.cancellation_reason)) < 10 THEN
      RAISE EXCEPTION
        'Cancelling order % needs a named person and a reason of at least ten characters. This destroys a commitment made to a customer, and somebody will ask who decided and why — usually the customer.',
        NEW.order_no
        USING ERRCODE = 'raise_exception';
    END IF;
    NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
  END IF;

  IF NEW.status = 'confirmed' AND OLD.status IN ('draft','pending_approval') THEN
    IF NOT EXISTS (SELECT 1 FROM sales_order_lines l WHERE l.order_id = NEW.id) THEN
      RAISE EXCEPTION
        'Order % has no lines. An order with nothing on it confirms a commitment to supply nothing, and it will sit in the fulfilment queue forever because there is nothing to dispatch.',
        NEW.order_no
        USING ERRCODE = 'raise_exception';
    END IF;
    NEW.confirmed_at := COALESCE(NEW.confirmed_at, now());
  END IF;

  IF NEW.status = 'closed' THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_order_status ON sales_orders;
CREATE TRIGGER trg_guard_order_status
  BEFORE UPDATE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_order_status();

-- ════════════════════════════════════════════════════════════════════
-- §8  updated_at
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ordence_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_touch_sales_orders ON sales_orders;
CREATE TRIGGER trg_touch_sales_orders
  BEFORE UPDATE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION ordence_touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_sales_order_fulfillments ON sales_order_fulfillments;
CREATE TRIGGER trg_touch_sales_order_fulfillments
  BEFORE UPDATE ON sales_order_fulfillments
  FOR EACH ROW EXECUTE FUNCTION ordence_touch_updated_at();

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — run this after COMMIT. Five rows, all true.
-- ════════════════════════════════════════════════════════════════════
--
-- SELECT c.relname,
--        c.relrowsecurity  AS rls_enabled,
--        c.relforcerowsecurity AS rls_forced,
--        (SELECT count(*) FROM pg_policies p
--          WHERE p.tablename = c.relname) AS policies
--   FROM pg_class c
--  WHERE c.relname IN ('sales_orders','sales_order_lines',
--                      'sales_order_fulfillments',
--                      'sales_order_fulfillment_lines',
--                      'sales_order_events')
--  ORDER BY c.relname;
