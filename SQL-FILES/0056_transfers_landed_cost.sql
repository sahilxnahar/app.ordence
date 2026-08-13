-- =====================================================================
--  0056 — STOCK TRANSFERS AND LANDED COST
--  Ordence · v1.5.0-alpha · Trading, batch 1
-- =====================================================================
--
--  ⭐⭐ TWO THINGS A DISTRIBUTOR DOES EVERY DAY AND ORDENCE COULD NOT DO
--  ------------------------------------------------------------------
--
--  🔴 ① A TRANSFER WAS TWO INDEPENDENT MOVEMENTS AND NOTHING JOINED THEM.
--
--  `stock_movements` has had `transfer_out` and `transfer_in` since 0029,
--  and `postMovement()` posts ONE movement at a time. So moving 100 bags
--  from Pune to Nagpur meant two unrelated rows, and:
--
--    • post both at dispatch → the stock exists at Nagpur before the
--      lorry does, and can be SOLD from there for three days; or
--    • post only the OUT → 100 bags vanish off the balance sheet until
--      somebody remembers to post the IN.
--
--  ⚠️ BOTH ARE WRONG AND BOTH LOOK FINE. And there was no third state
--  to choose, because nothing recorded that a transfer was in progress.
--
--  ⭐ THE `transit` WAREHOUSE TYPE HAS EXISTED IN THE ENUM SINCE 0029 AND
--  NOTHING EVER USED IT. Same shape as `tracking_mode = 'serial'` in the
--  last migration: a type was declared and nothing enforced it.
--
--  🔴 ② AN INTER-GSTIN TRANSFER IS A TAXABLE SUPPLY, AND MOST SOFTWARE
--       TREATS EVERY TRANSFER AS A NON-EVENT.
--
--  Section 25(4): each registration is a DISTINCT PERSON. Schedule I
--  para 2: a supply between distinct persons in the course of business
--  is taxable EVEN WITHOUT CONSIDERATION. So a Pune (27) → Bengaluru
--  (29) branch transfer between the company's own two GSTINs needs a
--  TAX INVOICE with IGST on it — and the receiving branch claims the
--  credit.
--
--  ⚠️ A transfer between two godowns under ONE GSTIN is not a supply at
--  all: Rule 55 delivery challan, no tax. Getting these two the same way
--  round is the entire compliance question, and it is decided by the
--  GSTINs, not by the state codes.
--
--  🔴 ③ LANDED COST DID NOT EXIST ANYWHERE.
--
--  Goods bought at ₹100 do not cost ₹100. Freight, insurance, customs
--  duty, clearing and loading are all part of the cost of purchase under
--  Ind AS 2 — and the standard says "other than those subsequently
--  recoverable from the taxing authorities", which is the line most
--  implementations cross.
-- =====================================================================


-- =====================================================================
--  ① THE TRANSFER DOCUMENT
-- =====================================================================
CREATE TABLE IF NOT EXISTS stock_transfers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    transfer_no         varchar(40) NOT NULL,
    transfer_date       date NOT NULL,

    from_warehouse_id   uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    to_warehouse_id     uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    /**
     * ⭐ WHERE THE GOODS LIVE WHILE THEY ARE ON THE LORRY.
     *
     * 🔴 THIS IS THE COLUMN THE WHOLE TABLE EXISTS FOR. Between dispatch
     * and receipt the stock is OURS and is in NEITHER godown. Without a
     * third location it has to be in one of them, and both answers are
     * wrong — one lets it be sold before it arrives, the other takes it
     * off the balance sheet for three days.
     */
    transit_warehouse_id uuid REFERENCES warehouses(id) ON DELETE RESTRICT,

    /**
     * 🔴 CAPTURED AT DISPATCH, NEVER JOINED AT READ TIME — the same rule
     * Rule 46 forces on a tax invoice. A branch that changes its GSTIN
     * next year must not restate a transfer made this year.
     */
    from_gstin          varchar(15),
    to_gstin            varchar(15),
    from_state_code     varchar(2),
    to_state_code       varchar(2),

    /**
     * ⭐ DERIVED FROM THE GSTINS, NOT FROM THE STATES.
     *
     * ⚠️ TWO GODOWNS IN DIFFERENT STATES UNDER ONE GSTIN IS STILL NOT A
     * SUPPLY, and two godowns in ONE state under two GSTINs IS one.
     * Deciding this on the state code is the mistake, and it is the
     * intuitive mistake.
     */
    is_taxable_supply   boolean NOT NULL DEFAULT false,
    document_type       varchar(20) NOT NULL DEFAULT 'delivery_challan',
    /** The Rule 55 challan number, or the Rule 46 invoice number. */
    document_no         varchar(40),
    invoice_id          uuid REFERENCES sales_invoices(id) ON DELETE SET NULL,

    -- Money. Zero on a delivery challan, real on a tax invoice.
    taxable_value_minor bigint NOT NULL DEFAULT 0,
    cgst_minor          bigint NOT NULL DEFAULT 0,
    sgst_minor          bigint NOT NULL DEFAULT 0,
    igst_minor          bigint NOT NULL DEFAULT 0,
    cess_minor          bigint NOT NULL DEFAULT 0,

    eway_bill_no        varchar(20),
    transporter_name    varchar(255),
    vehicle_no          varchar(20),
    distance_km         integer,

    status              varchar(20) NOT NULL DEFAULT 'draft',

    dispatched_at       timestamptz,
    dispatched_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    received_at         timestamptz,
    received_by         uuid REFERENCES users(id) ON DELETE SET NULL,

    cancelled_at        timestamptz,
    cancelled_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    cancel_reason       text,

    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT stock_transfers_status_known CHECK (
        status IN ('draft', 'dispatched', 'received', 'cancelled')
    ),
    CONSTRAINT stock_transfers_document_type_known CHECK (
        document_type IN ('delivery_challan', 'tax_invoice')
    ),
    -- ⚠️ Moving stock to where it already is is a typo, and it produces
    -- a transfer that reconciles perfectly and means nothing.
    CONSTRAINT stock_transfers_two_places CHECK (
        from_warehouse_id <> to_warehouse_id
    ),

    -- 🔴 A TAXABLE TRANSFER IS AN INVOICE, NOT A CHALLAN.
    --    Schedule I para 2 read with s.25(4). Recording an inter-GSTIN
    --    move on a delivery challan understates outward supply on one
    --    GSTIN's GSTR-1 and denies the other branch its credit — and
    --    both halves are found at the same assessment.
    CONSTRAINT stock_transfers_taxable_needs_invoice CHECK (
        NOT is_taxable_supply OR document_type = 'tax_invoice'
    ),
    CONSTRAINT stock_transfers_taxable_names_both_gstins CHECK (
        NOT is_taxable_supply OR (from_gstin IS NOT NULL AND to_gstin IS NOT NULL)
    ),
    -- ⚠️ AND THE MIRROR: a delivery challan carries no tax. A challan
    -- with GST on it is one of the two facts being wrong, and the row
    -- cannot say which.
    CONSTRAINT stock_transfers_challan_is_untaxed CHECK (
        is_taxable_supply
        OR (cgst_minor = 0 AND sgst_minor = 0 AND igst_minor = 0 AND cess_minor = 0)
    ),

    -- ⚠️ Goods cannot arrive before they left.
    CONSTRAINT stock_transfers_received_after_dispatch CHECK (
        received_at IS NULL OR (dispatched_at IS NOT NULL AND received_at >= dispatched_at)
    ),
    CONSTRAINT stock_transfers_status_matches_events CHECK (
        (status <> 'dispatched' OR dispatched_at IS NOT NULL)
        AND (status <> 'received' OR received_at IS NOT NULL)
    ),
    CONSTRAINT stock_transfers_cancel_is_explained CHECK (
        cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL)
    ),
    CONSTRAINT stock_transfers_values_positive CHECK (
        taxable_value_minor >= 0 AND cgst_minor >= 0 AND sgst_minor >= 0
        AND igst_minor >= 0 AND cess_minor >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_no_unique
    ON stock_transfers (tenant_id, transfer_no);
-- ⭐ The query somebody runs on a Monday: what left and never arrived.
CREATE INDEX IF NOT EXISTS stock_transfers_in_transit_idx
    ON stock_transfers (tenant_id, dispatched_at)
    WHERE status = 'dispatched';
CREATE INDEX IF NOT EXISTS stock_transfers_route_idx
    ON stock_transfers (tenant_id, from_warehouse_id, to_warehouse_id, transfer_date);


CREATE TABLE IF NOT EXISTS stock_transfer_lines (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    transfer_id         uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,

    line_no             integer NOT NULL,
    stock_item_id       uuid NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
    batch_no            varchar(100),
    serial_no           varchar(120),

    qty_dispatched      numeric(18,3) NOT NULL,
    /**
     * ⭐ COUNTED AT THE OTHER END, BY SOMEBODY ELSE. Null until then —
     * NOT defaulted to the dispatched quantity, because a default of
     * "however many we sent" is a receipt nobody performed.
     */
    qty_received        numeric(18,3),

    /** Cost travels with the goods, so the destination values them right. */
    unit_cost_minor     bigint NOT NULL DEFAULT 0,
    /** On a taxable transfer only — Rule 28. */
    taxable_value_minor bigint NOT NULL DEFAULT 0,
    tax_rate_bps        integer NOT NULL DEFAULT 0,

    /** The variance write-off, once somebody has owned it. */
    variance_movement_id uuid,
    variance_note       text,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT stock_transfer_lines_qty_positive CHECK (qty_dispatched > 0),
    CONSTRAINT stock_transfer_lines_received_sane CHECK (
        qty_received IS NULL OR qty_received >= 0
    ),
    -- 🔴 MORE CANNOT ARRIVE THAN LEFT.
    --    An excess receipt creates stock out of nothing. If more bags
    --    genuinely turned up, the DISPATCH count was wrong, and that is
    --    a correction at the sending end rather than a quiet gain at the
    --    receiving end.
    CONSTRAINT stock_transfer_lines_no_excess CHECK (
        qty_received IS NULL OR qty_received <= qty_dispatched
    ),
    CONSTRAINT stock_transfer_lines_cost_positive CHECK (unit_cost_minor >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_lines_no_unique
    ON stock_transfer_lines (tenant_id, transfer_id, line_no);
CREATE INDEX IF NOT EXISTS stock_transfer_lines_item_idx
    ON stock_transfer_lines (tenant_id, stock_item_id);
-- ⭐ Shortages that nobody has written off yet.
CREATE INDEX IF NOT EXISTS stock_transfer_lines_variance_idx
    ON stock_transfer_lines (tenant_id, transfer_id)
    WHERE qty_received IS NOT NULL AND qty_received < qty_dispatched
      AND variance_movement_id IS NULL;


-- =====================================================================
--  ② NOTHING IS SOLD OUT OF A LORRY
-- =====================================================================
--  🔴 A TRANSIT WAREHOUSE IS NOT A PLACE YOU CAN PICK FROM.
--
--  The whole point of parking goods in transit is that they are on the
--  balance sheet and NOT available. If a sales dispatch could be posted
--  against a transit location, the model would be back where it started
--  — stock sold from a lorry that has not arrived.
--
--  ⚠️ TRANSFERS IN AND OUT ARE ALLOWED, obviously, and so is a write-off:
--  goods lost in transit have to be able to leave.
CREATE OR REPLACE FUNCTION ordence_guard_transit_warehouse()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  wh RECORD;
BEGIN
  SELECT * INTO wh FROM warehouses WHERE id = NEW.warehouse_id;
  IF NOT FOUND OR wh.warehouse_type <> 'transit' THEN
    RETURN NEW;
  END IF;

  IF NEW.reason::text IN ('sales_dispatch','production_consume','sales_return',
                          'purchase_receipt','purchase_return') THEN
    RAISE EXCEPTION
      '"%" is a transit location — it holds goods that are on a lorry between two of our own places. A % cannot happen there. Receive the transfer at its destination first.',
      wh.name, NEW.reason
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_transit_warehouse ON stock_movements;
CREATE TRIGGER trg_guard_transit_warehouse
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_transit_warehouse();


-- =====================================================================
--  ③ LANDED COST
-- =====================================================================
--  ⭐ Ind AS 2: the cost of purchase is "the purchase price, import
--    duties and other taxes (OTHER THAN THOSE SUBSEQUENTLY RECOVERABLE
--    BY THE ENTITY FROM THE TAXING AUTHORITIES), and transport, handling
--    and other costs directly attributable to the acquisition".
--
--  🔴 THE PARENTHESIS IS THE WHOLE THING, AND IT SPLITS TWO CHARGES THAT
--     ARRIVE ON THE SAME CUSTOMS DOCUMENT:
--
--       Basic Customs Duty  → NOT recoverable → part of inventory cost
--       IGST on imports     → recoverable     → NOT part of it
--
--  ⚠️ Capitalising the IGST inflates closing stock AND loses the input
--  credit. Both halves are wrong, they are wrong in the same direction,
--  and the balance sheet still balances.
CREATE TABLE IF NOT EXISTS landed_costs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    /** The purchase this charge belongs to. */
    purchase_invoice_id uuid REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
    reference_no        varchar(60),

    cost_type           varchar(30) NOT NULL,
    description         text,

    /** Who charged us. Often not the supplier of the goods. */
    vendor_id           uuid REFERENCES vendors(id) ON DELETE SET NULL,
    vendor_invoice_no   varchar(60),
    cost_date           date NOT NULL,

    amount_minor        bigint NOT NULL,

    /**
     * 🔴 THE FLAG THAT DECIDES WHETHER THIS TOUCHES INVENTORY AT ALL.
     *    Recoverable means it is an input tax credit, not a cost.
     */
    is_recoverable      boolean NOT NULL DEFAULT false,

    /**
     * ⭐ HOW IT IS SPREAD ACROSS THE LINES.
     *
     * ⚠️ APPORTIONING EVERYTHING BY VALUE IS THE DEFAULT AND IT IS WRONG
     * FOR FREIGHT. A container of feathers and lead apportioned by value
     * gives the lead almost no freight and the feathers almost all of
     * it, which is the exact opposite of what the lorry did.
     */
    apportion_basis     varchar(20) NOT NULL DEFAULT 'value',

    status              varchar(20) NOT NULL DEFAULT 'draft',
    applied_at          timestamptz,
    applied_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT landed_costs_type_known CHECK (
        cost_type IN ('freight_inward', 'insurance', 'customs_duty', 'customs_igst',
                      'clearing_forwarding', 'loading_unloading', 'inspection',
                      'octroi_entry_tax', 'other')
    ),
    CONSTRAINT landed_costs_basis_known CHECK (
        apportion_basis IN ('value', 'quantity', 'weight', 'volume', 'equal')
    ),
    CONSTRAINT landed_costs_status_known CHECK (
        status IN ('draft', 'applied', 'cancelled')
    ),
    CONSTRAINT landed_costs_amount_positive CHECK (amount_minor > 0),

    -- 🔴 A RECOVERABLE CHARGE MUST NOT BE APPLIED TO INVENTORY.
    --    `customs_igst` is the one everybody capitalises by accident,
    --    because it arrives on the same bill of entry as the duty that
    --    genuinely is a cost.
    CONSTRAINT landed_costs_recoverable_is_not_capitalised CHECK (
        NOT is_recoverable OR status <> 'applied'
    )
);

CREATE INDEX IF NOT EXISTS landed_costs_invoice_idx
    ON landed_costs (tenant_id, purchase_invoice_id);
CREATE INDEX IF NOT EXISTS landed_costs_status_idx
    ON landed_costs (tenant_id, status, cost_date DESC);


--  ⭐ WHERE EACH RUPEE OF A CHARGE ENDED UP.
--
--  🔴 AND IT IS SPLIT BETWEEN STOCK AND COST OF SALES, BECAUSE THE
--     FREIGHT BILL ARRIVES AFTER THE GOODS.
--
--  ⚠️ Two weeks after a consignment lands, half of it has been sold. The
--  freight invoice then turns up. Adding all of it to the REMAINING
--  stock overstates the value of what is left AND overstates the margin
--  on what was already sold — twice wrong, in opposite directions, and
--  the total is right so nothing looks odd.
CREATE TABLE IF NOT EXISTS landed_cost_allocations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    landed_cost_id      uuid NOT NULL REFERENCES landed_costs(id) ON DELETE CASCADE,

    purchase_line_id    uuid,
    stock_item_id       uuid REFERENCES stock_items(id) ON DELETE RESTRICT,
    batch_no            varchar(100),

    /** The basis figure this line contributed — value, kg, units. */
    basis_amount        numeric(18,3) NOT NULL DEFAULT 0,
    allocated_minor     bigint NOT NULL DEFAULT 0,

    /** ⭐ The split. These two always add up to `allocated_minor`. */
    to_inventory_minor  bigint NOT NULL DEFAULT 0,
    to_cogs_minor       bigint NOT NULL DEFAULT 0,

    qty_received        numeric(18,3) NOT NULL DEFAULT 0,
    qty_still_on_hand   numeric(18,3) NOT NULL DEFAULT 0,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT landed_cost_allocations_positive CHECK (
        allocated_minor >= 0 AND to_inventory_minor >= 0 AND to_cogs_minor >= 0
    ),
    -- 🔴 THE SPLIT CANNOT LOSE A PAISA. If these ever disagree, some of
    --    the freight has gone neither into stock nor into cost of sales,
    --    and the P&L is short by exactly that much with nothing naming it.
    CONSTRAINT landed_cost_allocations_split_is_whole CHECK (
        to_inventory_minor + to_cogs_minor = allocated_minor
    )
);

CREATE INDEX IF NOT EXISTS landed_cost_allocations_cost_idx
    ON landed_cost_allocations (tenant_id, landed_cost_id);
CREATE INDEX IF NOT EXISTS landed_cost_allocations_item_idx
    ON landed_cost_allocations (tenant_id, stock_item_id);


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⚠️ app_platform_scope() belongs in USING and NEVER in WITH CHECK.

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_transfers_tenant_isolation ON public.stock_transfers;
CREATE POLICY stock_transfers_tenant_isolation ON public.stock_transfers
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_transfer_lines_tenant_isolation ON public.stock_transfer_lines;
CREATE POLICY stock_transfer_lines_tenant_isolation ON public.stock_transfer_lines
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE landed_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE landed_costs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS landed_costs_tenant_isolation ON public.landed_costs;
CREATE POLICY landed_costs_tenant_isolation ON public.landed_costs
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE landed_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE landed_cost_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS landed_cost_allocations_tenant_isolation ON public.landed_cost_allocations;
CREATE POLICY landed_cost_allocations_tenant_isolation ON public.landed_cost_allocations
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON stock_transfers          TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_transfer_lines     TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON landed_costs             TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON landed_cost_allocations  TO ordence_app;


-- =====================================================================
--  ⚠️ WHAT IS DELIBERATELY NOT HERE
-- =====================================================================
--  NO `quantity_in_transit` COLUMN ON `stock_balances`. Goods in transit
--  are a real balance in a real warehouse of type `transit`, which means
--  the existing balance trigger, the existing valuation and the existing
--  stock-count screens all handle them with no changes at all. A
--  separate in-transit figure would be a second answer to "what do we
--  own", and the two would drift.
--
--  NO AUTOMATIC VARIANCE WRITE-OFF. When 100 bags leave and 98 arrive,
--  the two missing bags are a loss somebody has to own — and under
--  s.17(5)(h) the input tax credit on them has to be reversed, which is
--  a decision with a named approver, not a background job. The transfer
--  shows the variance and refuses to be quietly complete.
--
--  NO LANDED COST ON A DRAFT PURCHASE. A charge apportioned across lines
--  that can still change is an apportionment that has to be redone, and
--  the version somebody already posted to the ledger would be the wrong
--  one.
-- =====================================================================
