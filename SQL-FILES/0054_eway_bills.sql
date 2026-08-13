-- =====================================================================
--  0054 — E-WAY BILL · Rule 138, and the truck that is standing still
--  Ordence · v1.3.0-alpha
-- =====================================================================
--
--  ⭐⭐ WHY THIS IS THE HIGHEST-LEVERAGE THING LEFT
--  ------------------------------------------------------------------
--  Trading, small business, solar equipment and logistics all move
--  goods, and NONE of them can move a consignment worth more than
--  ₹50,000 without an e-way bill. A consignment stopped without one is
--  a penalty of ₹10,000 or the tax sought to be evaded, whichever is
--  higher, plus detention of the goods AND the vehicle under s.129.
--
--  ⚠️ SO THE COST OF GETTING THIS WRONG IS NOT A WRONG NUMBER IN A
--  REPORT. It is a truck at a checkpost, a driver on the phone, and a
--  customer who does not get their delivery.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴 WHAT THIS DOES **NOT** DO, STATED FIRST
--  ══════════════════════════════════════════════════════════════════
--  IT DOES NOT TALK TO THE NIC PORTAL. Ordence has no GSP credentials —
--  the same block that stops GSTR-1 filing. Inventing an integration
--  that cannot be tested would produce a screen that LOOKS like it
--  generated an e-way bill and did not, which is worse than no screen:
--  somebody would dispatch on the strength of it.
--
--  ⭐ SO THE HONEST SHAPE IS: Ordence PREPARES the e-way bill, exports
--  the NIC JSON, and RECORDS the number the portal returns. Status
--  `prepared` is never called `active`. The truck does not leave on a
--  `prepared`.
--
--  ⚠️ AND THE VALIDITY IS COMPUTED HERE, NOT COPIED. If the portal's
--  figure and ours disagree, that is a bug worth knowing about — a
--  screen that just echoes whatever was typed cannot tell you.
-- =====================================================================


-- =====================================================================
--  ① THE E-WAY BILL
-- =====================================================================
--  🔴 PART A AND PART B ARE ONE ROW, BUT TWO EVENTS.
--
--  Part A is the consignment: who, what, from where, to where, how much.
--  Part B is the vehicle. Rule 138(2) lets Part A be furnished first and
--  Part B later — and 🔴 **VALIDITY IS COUNTED FROM THE FIRST PART B
--  ENTRY, NOT FROM PART A.** A Part A filled on Monday and a lorry
--  loaded on Thursday gives an e-way bill valid from Thursday.
--
--  ⚠️ Getting that backwards shortens every validity by the loading
--  delay, and the error only shows up as an expired bill at a checkpost
--  two states away.
CREATE TABLE IF NOT EXISTS eway_bills (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- ⭐ THE SOURCE DOCUMENT, POLYMORPHIC ON PURPOSE. Rule 138 accepts a
    -- tax invoice, a bill of supply, a delivery challan or a bill of
    -- entry. A foreign key to sales_invoices alone would make stock
    -- transfers and job work — which move on a challan and no invoice —
    -- impossible to cover.
    document_type       varchar(20) NOT NULL,
    document_no         varchar(40) NOT NULL,
    document_date       date        NOT NULL,
    invoice_id          uuid REFERENCES sales_invoices(id) ON DELETE RESTRICT,

    -- Rule 138(1) Part A — the parties.
    supplier_gstin      varchar(15),
    supplier_legal_name varchar(255),
    from_state_code     varchar(2)  NOT NULL,
    from_place          varchar(255),
    from_pincode        varchar(6)  NOT NULL,

    recipient_gstin     varchar(15),
    recipient_legal_name varchar(255),
    to_state_code       varchar(2)  NOT NULL,
    to_place            varchar(255),
    to_pincode          varchar(6)  NOT NULL,

    -- ⚠️ `URP` — unregistered person — IS A LEGITIMATE VALUE and not a
    -- missing GSTIN. A B2C dispatch above ₹50,000 still needs an e-way
    -- bill. Storing NULL and treating it as "not filled in yet" would
    -- block exactly the movements that most need covering.
    transaction_type    varchar(30) NOT NULL DEFAULT 'regular',
    supply_type         varchar(10) NOT NULL DEFAULT 'outward',
    sub_supply_type     varchar(30) NOT NULL DEFAULT 'supply',

    -- 🔴 THE THRESHOLD FIGURE, AND IT IS NOT THE INVOICE TOTAL.
    --    Explanation 2 to Rule 138(1): consignment value is the s.15
    --    value declared in the document, INCLUDING CGST/SGST/UTGST/IGST
    --    and cess — and EXCLUDING the value of exempt supply where one
    --    invoice carries both exempt and taxable goods.
    --
    -- ⚠️ Both halves matter and they pull in opposite directions.
    --    Using the taxable value alone under-states it and skips e-way
    --    bills that were required. Using the invoice total on a mixed
    --    invoice over-states it and raises e-way bills that were not.
    taxable_value_minor bigint  NOT NULL DEFAULT 0,
    tax_value_minor     bigint  NOT NULL DEFAULT 0,
    exempt_value_minor  bigint  NOT NULL DEFAULT 0,
    consignment_value_minor bigint NOT NULL DEFAULT 0,

    -- Part B — transport.
    transport_mode      varchar(10),
    transporter_gstin   varchar(15),
    transporter_name    varchar(255),
    transporter_doc_no  varchar(40),
    transporter_doc_date date,
    vehicle_no          varchar(20),
    vehicle_type        varchar(10) NOT NULL DEFAULT 'regular',

    -- 🔴 DISTANCE DECIDES VALIDITY, so it is a stored fact and not a
    --    number somebody re-enters at extension time.
    -- ⚠️ The portal caps it at 4,000 km and rejects more.
    distance_km         integer NOT NULL DEFAULT 0,

    -- ⭐ WHAT THE PORTAL GAVE BACK. Nullable, because a `prepared` bill
    -- has none — and that is the whole point of the status.
    ewb_no              varchar(20),
    generated_at        timestamptz,
    valid_from          timestamptz,
    valid_until         timestamptz,

    -- ⚠️ THE ORIGINAL GENERATION INSTANT SURVIVES EVERY EXTENSION.
    --    Since 1 January 2025 an e-way bill cannot be extended beyond
    --    360 days FROM ORIGINAL GENERATION. Overwriting `generated_at`
    --    on each extension would let the cap slide forward forever,
    --    which is precisely the abuse the cap was introduced to stop.
    extension_count     integer NOT NULL DEFAULT 0,
    last_extended_at    timestamptz,

    status              varchar(20) NOT NULL DEFAULT 'prepared',

    cancelled_at        timestamptz,
    cancelled_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    cancel_reason       text,

    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT eway_bills_status_known CHECK (
        status IN ('prepared', 'active', 'expired', 'cancelled', 'rejected')
    ),
    CONSTRAINT eway_bills_document_type_known CHECK (
        document_type IN ('tax_invoice', 'bill_of_supply', 'delivery_challan',
                          'bill_of_entry', 'credit_note', 'others')
    ),
    CONSTRAINT eway_bills_supply_type_known CHECK (
        supply_type IN ('outward', 'inward')
    ),
    CONSTRAINT eway_bills_vehicle_type_known CHECK (
        vehicle_type IN ('regular', 'odc')
    ),

    -- 🔴 AN ACTIVE E-WAY BILL MUST HAVE A NUMBER AND A VALIDITY.
    --    Without this, a `prepared` row could be flipped to `active` by
    --    any code path that forgot to record the portal's response — and
    --    the list screen would show a green row for a consignment with
    --    no e-way bill at all. That is the single most dangerous state
    --    this table can hold: it is the one that puts a truck on a road.
    CONSTRAINT eway_bills_active_is_real CHECK (
        status <> 'active' OR (
            ewb_no IS NOT NULL AND valid_from IS NOT NULL AND valid_until IS NOT NULL
        )
    ),

    -- ⚠️ Validity that ends before it starts is not a data-entry slip,
    -- it is a broken computation. Refused rather than stored.
    CONSTRAINT eway_bills_validity_ordered CHECK (
        valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from
    ),

    CONSTRAINT eway_bills_distance_sane CHECK (
        distance_km >= 0 AND distance_km <= 4000
    ),
    CONSTRAINT eway_bills_values_positive CHECK (
        taxable_value_minor >= 0 AND tax_value_minor >= 0
        AND exempt_value_minor >= 0 AND consignment_value_minor >= 0
    ),
    CONSTRAINT eway_bills_extensions_sane CHECK (extension_count >= 0),

    -- Cancellation carries a named human and a reason, or it does not
    -- happen — the same rule sales orders and invoices already follow.
    CONSTRAINT eway_bills_cancel_is_explained CHECK (
        cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL)
    )
);

-- 🔴 THE SAME PORTAL NUMBER CANNOT BE RECORDED TWICE.
--    Two rows carrying one EWB number means two consignments each
--    believe they are covered, and only one of them is.
CREATE UNIQUE INDEX IF NOT EXISTS eway_bills_number_unique
    ON eway_bills (tenant_id, ewb_no) WHERE ewb_no IS NOT NULL;

-- 🔴 ONE LIVE E-WAY BILL PER SOURCE DOCUMENT.
--    A second active bill against one invoice is a second consignment
--    that does not exist, and it doubles the value declared to the
--    Government for goods that moved once.
-- ⚠️ Cancelled and expired rows are deliberately outside the index — a
--    cancelled bill SHOULD be replaceable, that is what cancelling is
--    for.
CREATE UNIQUE INDEX IF NOT EXISTS eway_bills_one_live_per_document
    ON eway_bills (tenant_id, document_type, document_no)
    WHERE status IN ('prepared', 'active');

CREATE INDEX IF NOT EXISTS eway_bills_expiry_idx
    ON eway_bills (tenant_id, valid_until)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS eway_bills_invoice_idx
    ON eway_bills (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS eway_bills_status_idx
    ON eway_bills (tenant_id, status, document_date DESC);


-- =====================================================================
--  ② PART B HISTORY — EVERY VEHICLE THE GOODS EVER SAT IN
-- =====================================================================
--  🔴 TRANSSHIPMENT IS NORMAL, AND OVERWRITING THE VEHICLE DESTROYS THE
--     ONLY EVIDENCE THAT THE MOVEMENT WAS LAWFUL.
--
--  Goods move Mumbai → Nagpur on one lorry, are cross-docked, and go
--  Nagpur → Raipur on another. Rule 138(5) requires the new conveyance
--  in Part B before the second leg starts. If Ordence simply UPDATEs
--  `vehicle_no`, then at a check in Raipur the record says the goods
--  were always on the second lorry — and the first leg, which actually
--  happened, has no record at all.
--
--  ⚠️ AN OFFICER'S QUESTION IS "WHERE HAS THIS BEEN", NOT "WHERE IS IT".
--  A single mutable column cannot answer it.
--
--  ⭐ So `eway_bills.vehicle_no` is a CACHE OF THE LATEST LEG for the
--  list screen, and THIS table is the record.
CREATE TABLE IF NOT EXISTS eway_bill_vehicles (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    eway_bill_id        uuid NOT NULL REFERENCES eway_bills(id) ON DELETE CASCADE,

    leg_no              integer NOT NULL,
    transport_mode      varchar(10) NOT NULL,
    vehicle_no          varchar(20),
    transporter_doc_no  varchar(40),
    transporter_doc_date date,

    from_place          varchar(255),
    from_state_code     varchar(2),

    -- ⭐ THE INSTANT THAT STARTS THE CLOCK, on leg 1 only.
    entered_at          timestamptz NOT NULL DEFAULT now(),
    reason_code         varchar(20),
    reason_note         text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT eway_vehicles_leg_positive CHECK (leg_no > 0),
    CONSTRAINT eway_vehicles_mode_known CHECK (
        transport_mode IN ('road', 'rail', 'air', 'ship')
    ),
    -- 🔴 ROAD MEANS A VEHICLE NUMBER. Rail, air and ship mean a
    --    transport document number. A leg with neither is a leg that
    --    cannot be verified by anybody, in either direction.
    CONSTRAINT eway_vehicles_identified CHECK (
        (transport_mode = 'road' AND vehicle_no IS NOT NULL)
        OR (transport_mode <> 'road' AND transporter_doc_no IS NOT NULL)
    )
);

-- ⚠️ Leg numbers are unique per bill, so "leg 2" means one thing.
CREATE UNIQUE INDEX IF NOT EXISTS eway_vehicles_leg_unique
    ON eway_bill_vehicles (tenant_id, eway_bill_id, leg_no);
CREATE INDEX IF NOT EXISTS eway_vehicles_bill_idx
    ON eway_bill_vehicles (tenant_id, eway_bill_id, leg_no DESC);


-- =====================================================================
--  ③ THE LINES DECLARED ON THE BILL
-- =====================================================================
--  ⚠️ COPIED FROM THE DOCUMENT, NOT JOINED TO IT AT READ TIME — the same
--  rule Rule 46 already forces on the tax invoice. What was declared to
--  the Government on the day of movement must not change because
--  somebody later corrected an HSN code on a stock item.
CREATE TABLE IF NOT EXISTS eway_bill_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    eway_bill_id        uuid NOT NULL REFERENCES eway_bills(id) ON DELETE CASCADE,

    line_no             integer NOT NULL,
    product_name        varchar(255) NOT NULL,
    description         text,
    hsn_code            varchar(10) NOT NULL,
    quantity            numeric(18,3) NOT NULL DEFAULT 0,
    uqc                 varchar(10) NOT NULL DEFAULT 'NOS',

    taxable_value_minor bigint NOT NULL DEFAULT 0,
    cgst_rate_bps       integer NOT NULL DEFAULT 0,
    sgst_rate_bps       integer NOT NULL DEFAULT 0,
    igst_rate_bps       integer NOT NULL DEFAULT 0,
    cess_rate_bps       integer NOT NULL DEFAULT 0,

    -- ⚠️ An exempt line still travels in the lorry and still appears on
    -- the e-way bill. It just does not count towards the ₹50,000.
    is_exempt           boolean NOT NULL DEFAULT false,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT eway_items_line_positive CHECK (line_no > 0),
    CONSTRAINT eway_items_value_positive CHECK (taxable_value_minor >= 0),
    -- 🔴 EXEMPT MEANS NO TAX. A line flagged exempt that also carries a
    --    rate is one of the two figures being wrong, and there is no way
    --    to tell which from the row alone.
    CONSTRAINT eway_items_exempt_is_untaxed CHECK (
        NOT is_exempt OR (cgst_rate_bps = 0 AND sgst_rate_bps = 0
                          AND igst_rate_bps = 0 AND cess_rate_bps = 0)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS eway_items_line_unique
    ON eway_bill_items (tenant_id, eway_bill_id, line_no);


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⚠️ app_platform_scope() belongs in USING and NEVER in WITH CHECK.

ALTER TABLE eway_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE eway_bills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eway_bills_tenant_isolation ON public.eway_bills;
CREATE POLICY eway_bills_tenant_isolation ON public.eway_bills
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE eway_bill_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE eway_bill_vehicles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eway_bill_vehicles_tenant_isolation ON public.eway_bill_vehicles;
CREATE POLICY eway_bill_vehicles_tenant_isolation ON public.eway_bill_vehicles
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE eway_bill_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE eway_bill_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eway_bill_items_tenant_isolation ON public.eway_bill_items;
CREATE POLICY eway_bill_items_tenant_isolation ON public.eway_bill_items
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON eway_bills         TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON eway_bill_vehicles TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON eway_bill_items    TO ordence_app;


-- =====================================================================
--  ⚠️ WHAT IS DELIBERATELY NOT HERE
-- =====================================================================
--  NO `is_expired` COLUMN. Expiry is `now() > valid_until` and nothing
--  else. A stored flag needs a job to maintain it, and the hour between
--  the bill expiring and the job running is an hour in which the screen
--  says a truck is legal and it is not.
--
--  The `status = 'expired'` value exists only for a bill somebody has
--  formally closed out; the SCREENS compute expiry from the timestamp.
--
--  NO CONSOLIDATED E-WAY BILL (EWB-02) TABLE YET. A consolidated bill is
--  a wrapper over several EWB numbers for one vehicle. It is real and it
--  is next — but building the wrapper before the thing being wrapped is
--  reliable would mean debugging both at once.
-- =====================================================================
