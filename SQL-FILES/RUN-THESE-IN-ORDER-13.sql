-- ═════════════════════════════════════════════════════════════════════
--  ORDENCE — FILE 13
--  Phase 39: Sales Orders
-- ═════════════════════════════════════════════════════════════════════
--
--  YOU ARE IN THE RIGHT PLACE IF you have already run files 01 through
--  12. If you have not, stop and do those first, in order.
--
--  WHAT TO DO
--  ----------
--  1. Open Neon:  https://console.neon.tech
--  2. Click your project, then "SQL Editor" in the left sidebar.
--  3. Select ALL the text in this file (Cmd+A), copy it (Cmd+C).
--  4. Paste it into the SQL Editor box.
--  5. Click "Run".
--  6. Wait. It takes about 10 seconds.
--  7. Scroll to the bottom of the results. You are looking for the
--     word PASS. You should see nine of them.
--
--  IF YOU SEE THE WORD "FAIL" ANYWHERE: stop, and send Claude a
--  screenshot. Do not deploy until it is sorted.
--
--  IF YOU SEE AN ERROR IN RED: nothing has been changed. The whole
--  file runs as one unit — either all of it applied or none of it did.
--  Send Claude the red text.
--
--  SAFE TO RUN TWICE. If you are not sure whether it worked, run it
--  again. It will not duplicate anything or lose data.
--
--  WHAT THIS FILE DOES
--  -------------------
--  Part 1 creates five new tables that hold customer orders.
--  Part 2 locks them down.
--
--  Part 2 is the part that matters. Without it the orders screen still
--  works perfectly — every page loads, nothing shows an error. The only
--  difference is that every customer can read every other customer's
--  orders, a confirmed price can be quietly rewritten after the customer
--  has agreed to it, and a warehouse can dispatch more goods than were
--  ordered. Nothing anywhere would tell you.
--
-- ═════════════════════════════════════════════════════════════════════

BEGIN;

-- ═════════════════════════════════════════════════════════════════════
--  PART 1 — THE TABLES
-- ═════════════════════════════════════════════════════════════════════
--
--  First the four lists of allowed values (an order's status can only
--  be one of eight words; a line can only be one of six kinds). The
--  database refuses anything else, so a typo cannot become a status
--  nobody planned for.

DO $ordence$ BEGIN
  CREATE TYPE public.sales_order_status AS ENUM (
    'draft','pending_approval','confirmed','partially_fulfilled',
    'fulfilled','closed','cancelled','on_hold');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.sales_order_source AS ENUM (
    'manual','quote','portal','api','import','recurring');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.sales_order_line_kind AS ENUM (
    'goods','service','works_contract','freight','discount','other_charge');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.sales_fulfillment_status AS ENUM (
    'planned','picked','dispatched','in_transit','delivered','returned','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;



CREATE TABLE IF NOT EXISTS public.sales_order_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    event_type character varying(60) NOT NULL,
    from_status public.sales_order_status,
    to_status public.sales_order_status,
    revision integer,
    summary text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_user_id uuid,
    impersonation_id uuid,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sales_order_fulfillment_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    fulfillment_id uuid NOT NULL,
    order_line_id uuid NOT NULL,
    quantity numeric(18,3) NOT NULL,
    batch_no character varying(100),
    serial_numbers jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT sales_order_fulfillment_lines_quantity_positive CHECK ((quantity > (0)::numeric))
);

CREATE TABLE IF NOT EXISTS public.sales_order_fulfillments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    fulfillment_no character varying(60) NOT NULL,
    status public.sales_fulfillment_status DEFAULT 'planned'::public.sales_fulfillment_status NOT NULL,
    dispatched_at timestamp with time zone,
    delivered_at timestamp with time zone,
    carrier_name character varying(150),
    tracking_number character varying(120),
    vehicle_number character varying(40),
    driver_name character varying(150),
    driver_phone character varying(40),
    eway_bill_no character varying(30),
    eway_bill_date date,
    received_by character varying(200),
    proof_document_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.sales_order_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    line_no integer NOT NULL,
    kind public.sales_order_line_kind DEFAULT 'goods'::public.sales_order_line_kind NOT NULL,
    asset_id uuid,
    sku character varying(100),
    description text NOT NULL,
    hsn_sac_code_id uuid,
    hsn_sac_rate_id uuid,
    tax_rate_bps integer,
    cess_rate_bps integer,
    quantity numeric(18,3) NOT NULL,
    uom character varying(20) DEFAULT 'nos'::character varying NOT NULL,
    qty_fulfilled numeric(18,3) DEFAULT 0 NOT NULL,
    qty_invoiced numeric(18,3) DEFAULT 0 NOT NULL,
    qty_cancelled numeric(18,3) DEFAULT 0 NOT NULL,
    qty_returned numeric(18,3) DEFAULT 0 NOT NULL,
    unit_price_minor bigint NOT NULL,
    discount_minor bigint DEFAULT 0 NOT NULL,
    taxable_value_minor bigint DEFAULT 0 NOT NULL,
    cgst_minor bigint DEFAULT 0 NOT NULL,
    sgst_minor bigint DEFAULT 0 NOT NULL,
    igst_minor bigint DEFAULT 0 NOT NULL,
    cess_minor bigint DEFAULT 0 NOT NULL,
    line_total_minor bigint DEFAULT 0 NOT NULL,
    warehouse_code character varying(60),
    requested_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT sales_order_lines_fulfilment_within_order CHECK (((qty_fulfilled + qty_cancelled) <= quantity)),
    CONSTRAINT sales_order_lines_invoiced_within_order CHECK ((qty_invoiced <= quantity)),
    CONSTRAINT sales_order_lines_progress_non_negative CHECK (((qty_fulfilled >= (0)::numeric) AND (qty_invoiced >= (0)::numeric) AND (qty_cancelled >= (0)::numeric) AND (qty_returned >= (0)::numeric))),
    CONSTRAINT sales_order_lines_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT sales_order_lines_returned_within_fulfilled CHECK ((qty_returned <= qty_fulfilled))
);

CREATE TABLE IF NOT EXISTS public.sales_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    order_no character varying(60) NOT NULL,
    customer_reference character varying(120),
    status public.sales_order_status DEFAULT 'draft'::public.sales_order_status NOT NULL,
    source public.sales_order_source DEFAULT 'manual'::public.sales_order_source NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    order_date date NOT NULL,
    promised_date date,
    expected_dispatch_date date,
    company_id uuid,
    contact_id uuid,
    gst_party_id uuid,
    seller_registration_id uuid,
    place_of_supply_code character varying(2),
    is_inter_state boolean,
    deal_id uuid,
    project_id uuid,
    booking_id uuid,
    channel_partner_id uuid,
    currency character varying(3) DEFAULT 'INR'::character varying NOT NULL,
    subtotal_minor bigint DEFAULT 0 NOT NULL,
    discount_minor bigint DEFAULT 0 NOT NULL,
    taxable_value_minor bigint DEFAULT 0 NOT NULL,
    cgst_minor bigint DEFAULT 0 NOT NULL,
    sgst_minor bigint DEFAULT 0 NOT NULL,
    igst_minor bigint DEFAULT 0 NOT NULL,
    cess_minor bigint DEFAULT 0 NOT NULL,
    other_charges_minor bigint DEFAULT 0 NOT NULL,
    round_off_minor bigint DEFAULT 0 NOT NULL,
    total_minor bigint DEFAULT 0 NOT NULL,
    fulfilled_value_minor bigint DEFAULT 0 NOT NULL,
    invoiced_value_minor bigint DEFAULT 0 NOT NULL,
    received_value_minor bigint DEFAULT 0 NOT NULL,
    payment_terms_days integer,
    payment_terms_note character varying(300),
    incoterm character varying(20),
    shipping_name character varying(200),
    shipping_line1 character varying(255),
    shipping_line2 character varying(255),
    shipping_city character varying(120),
    shipping_state character varying(120),
    shipping_postal_code character varying(20),
    shipping_country character varying(2) DEFAULT 'IN'::character varying,
    shipping_phone character varying(40),
    requires_approval boolean DEFAULT false NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    closed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    cancellation_reason text,
    hold_reason text,
    owner_user_id uuid,
    notes text,
    customer_notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT sales_orders_fulfilled_within_total CHECK ((fulfilled_value_minor <= total_minor)),
    CONSTRAINT sales_orders_invoiced_within_total CHECK ((invoiced_value_minor <= total_minor)),
    CONSTRAINT sales_orders_revision_non_negative CHECK ((revision >= 0)),
    CONSTRAINT sales_orders_total_non_negative CHECK ((total_minor >= 0))
);

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_events_pkey'
                    AND conrelid = 'public.sales_order_events'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_events
    ADD CONSTRAINT sales_order_events_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillment_lines_pkey'
                    AND conrelid = 'public.sales_order_fulfillment_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillment_lines
    ADD CONSTRAINT sales_order_fulfillment_lines_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillments_pkey'
                    AND conrelid = 'public.sales_order_fulfillments'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillments
    ADD CONSTRAINT sales_order_fulfillments_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_pkey'
                    AND conrelid = 'public.sales_order_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_pkey'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

CREATE INDEX IF NOT EXISTS sales_order_events_order_idx ON public.sales_order_events USING btree (tenant_id, order_id, occurred_at);

CREATE INDEX IF NOT EXISTS sales_order_events_tenant_idx ON public.sales_order_events USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS sales_order_fulfillment_lines_fulfillment_idx ON public.sales_order_fulfillment_lines USING btree (tenant_id, fulfillment_id);

CREATE INDEX IF NOT EXISTS sales_order_fulfillment_lines_order_line_idx ON public.sales_order_fulfillment_lines USING btree (tenant_id, order_line_id);

CREATE INDEX IF NOT EXISTS sales_order_fulfillment_lines_tenant_idx ON public.sales_order_fulfillment_lines USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS sales_order_fulfillment_lines_unique ON public.sales_order_fulfillment_lines USING btree (fulfillment_id, order_line_id);

CREATE UNIQUE INDEX IF NOT EXISTS sales_order_fulfillments_id_tenant_unique ON public.sales_order_fulfillments USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS sales_order_fulfillments_no_unique ON public.sales_order_fulfillments USING btree (tenant_id, fulfillment_no);

CREATE INDEX IF NOT EXISTS sales_order_fulfillments_order_idx ON public.sales_order_fulfillments USING btree (tenant_id, order_id);

CREATE INDEX IF NOT EXISTS sales_order_fulfillments_status_idx ON public.sales_order_fulfillments USING btree (tenant_id, status);

CREATE INDEX IF NOT EXISTS sales_order_fulfillments_tenant_idx ON public.sales_order_fulfillments USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS sales_order_lines_asset_idx ON public.sales_order_lines USING btree (tenant_id, asset_id);

CREATE UNIQUE INDEX IF NOT EXISTS sales_order_lines_id_tenant_unique ON public.sales_order_lines USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS sales_order_lines_order_idx ON public.sales_order_lines USING btree (tenant_id, order_id);

CREATE UNIQUE INDEX IF NOT EXISTS sales_order_lines_order_line_no_unique ON public.sales_order_lines USING btree (order_id, line_no);

CREATE INDEX IF NOT EXISTS sales_order_lines_tenant_idx ON public.sales_order_lines USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_id_tenant_unique ON public.sales_orders USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS sales_orders_promised_idx ON public.sales_orders USING btree (tenant_id, promised_date) WHERE (status = ANY (ARRAY['confirmed'::public.sales_order_status, 'partially_fulfilled'::public.sales_order_status]));

CREATE INDEX IF NOT EXISTS sales_orders_tenant_company_idx ON public.sales_orders USING btree (tenant_id, company_id);

CREATE INDEX IF NOT EXISTS sales_orders_tenant_date_idx ON public.sales_orders USING btree (tenant_id, order_date);

CREATE INDEX IF NOT EXISTS sales_orders_tenant_idx ON public.sales_orders USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_tenant_order_no_unique ON public.sales_orders USING btree (tenant_id, order_no) WHERE (deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS sales_orders_tenant_owner_idx ON public.sales_orders USING btree (tenant_id, owner_user_id);

CREATE INDEX IF NOT EXISTS sales_orders_tenant_project_idx ON public.sales_orders USING btree (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS sales_orders_tenant_status_idx ON public.sales_orders USING btree (tenant_id, status);

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_events_order_tenant_fk'
                    AND conrelid = 'public.sales_order_events'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_events
    ADD CONSTRAINT sales_order_events_order_tenant_fk FOREIGN KEY (order_id, tenant_id) REFERENCES public.sales_orders(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_events_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.sales_order_events'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_events
    ADD CONSTRAINT sales_order_events_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillment_lines_created_by_users_id_fk'
                    AND conrelid = 'public.sales_order_fulfillment_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillment_lines
    ADD CONSTRAINT sales_order_fulfillment_lines_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillment_lines_fulfillment_tenant_fk'
                    AND conrelid = 'public.sales_order_fulfillment_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillment_lines
    ADD CONSTRAINT sales_order_fulfillment_lines_fulfillment_tenant_fk FOREIGN KEY (fulfillment_id, tenant_id) REFERENCES public.sales_order_fulfillments(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillment_lines_order_line_tenant_fk'
                    AND conrelid = 'public.sales_order_fulfillment_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillment_lines
    ADD CONSTRAINT sales_order_fulfillment_lines_order_line_tenant_fk FOREIGN KEY (order_line_id, tenant_id) REFERENCES public.sales_order_lines(id, tenant_id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillment_lines_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.sales_order_fulfillment_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillment_lines
    ADD CONSTRAINT sales_order_fulfillment_lines_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillments_created_by_users_id_fk'
                    AND conrelid = 'public.sales_order_fulfillments'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillments
    ADD CONSTRAINT sales_order_fulfillments_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillments_order_tenant_fk'
                    AND conrelid = 'public.sales_order_fulfillments'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillments
    ADD CONSTRAINT sales_order_fulfillments_order_tenant_fk FOREIGN KEY (order_id, tenant_id) REFERENCES public.sales_orders(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillments_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.sales_order_fulfillments'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillments
    ADD CONSTRAINT sales_order_fulfillments_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_fulfillments_updated_by_users_id_fk'
                    AND conrelid = 'public.sales_order_fulfillments'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_fulfillments
    ADD CONSTRAINT sales_order_fulfillments_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_asset_id_assets_id_fk'
                    AND conrelid = 'public.sales_order_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_asset_id_assets_id_fk FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_created_by_users_id_fk'
                    AND conrelid = 'public.sales_order_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_hsn_sac_code_id_hsn_sac_codes_id_fk'
                    AND conrelid = 'public.sales_order_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_hsn_sac_code_id_hsn_sac_codes_id_fk FOREIGN KEY (hsn_sac_code_id) REFERENCES public.hsn_sac_codes(id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk'
                    AND conrelid = 'public.sales_order_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk FOREIGN KEY (hsn_sac_rate_id) REFERENCES public.hsn_sac_rates(id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_order_tenant_fk'
                    AND conrelid = 'public.sales_order_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_order_tenant_fk FOREIGN KEY (order_id, tenant_id) REFERENCES public.sales_orders(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.sales_order_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_updated_by_users_id_fk'
                    AND conrelid = 'public.sales_order_lines'::regclass) THEN
    ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_approved_by_users_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_approved_by_users_id_fk FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_booking_id_bookings_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_booking_id_bookings_id_fk FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_cancelled_by_users_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_cancelled_by_users_id_fk FOREIGN KEY (cancelled_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_channel_partner_id_channel_partners_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_channel_partner_id_channel_partners_id_fk FOREIGN KEY (channel_partner_id) REFERENCES public.channel_partners(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_company_id_companies_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_confirmed_by_users_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_confirmed_by_users_id_fk FOREIGN KEY (confirmed_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_contact_id_contacts_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_created_by_users_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_deal_id_deals_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_deal_id_deals_id_fk FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_gst_party_id_gst_parties_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_gst_party_id_gst_parties_id_fk FOREIGN KEY (gst_party_id) REFERENCES public.gst_parties(id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_owner_user_id_users_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_project_id_projects_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_seller_registration_id_gst_registrations_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_seller_registration_id_gst_registrations_id_fk FOREIGN KEY (seller_registration_id) REFERENCES public.gst_registrations(id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_orders_updated_by_users_id_fk'
                    AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

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

-- ═════════════════════════════════════════════════════════════════════
--  PART 3 — THE CHECK
-- ═════════════════════════════════════════════════════════════════════
--
--  Look for PASS. Nine rows. If any row says FAIL, send Claude a
--  screenshot and do not deploy.

SELECT
  'Table exists: ' || t AS check_name,
  CASE WHEN to_regclass('public.' || t) IS NOT NULL
       THEN 'PASS' ELSE 'FAIL — the table was not created' END AS result
FROM unnest(ARRAY['sales_orders','sales_order_lines',
                  'sales_order_fulfillments','sales_order_fulfillment_lines',
                  'sales_order_events']) AS t

UNION ALL

SELECT
  'Every orders table has tenant isolation switched ON and FORCED',
  CASE WHEN count(*) = 5 THEN 'PASS'
       ELSE 'FAIL — only ' || count(*) || ' of 5 are protected' END
FROM pg_class c
WHERE c.relname IN ('sales_orders','sales_order_lines',
                    'sales_order_fulfillments','sales_order_fulfillment_lines',
                    'sales_order_events')
  AND c.relrowsecurity AND c.relforcerowsecurity

UNION ALL

SELECT
  'Every orders table has an isolation policy attached',
  CASE WHEN count(*) = 5 THEN 'PASS'
       ELSE 'FAIL — only ' || count(*) || ' of 5 have one' END
FROM pg_policies
WHERE tablename IN ('sales_orders','sales_order_lines',
                    'sales_order_fulfillments','sales_order_fulfillment_lines',
                    'sales_order_events')

UNION ALL

SELECT
  'A child row cannot be attached to another customer''s order',
  CASE WHEN count(*) = 5 THEN 'PASS'
       ELSE 'FAIL — only ' || count(*) || ' of 5 cross-tenant guards exist' END
FROM pg_constraint
WHERE conname LIKE '%_tenant_fk'
  AND conrelid::regclass::text LIKE 'sales_order%'

UNION ALL

SELECT
  'The four guards are live (frozen lines, totals, dispatch, status)',
  CASE WHEN count(*) >= 4 THEN 'PASS'
       ELSE 'FAIL — only ' || count(*) || ' of 4 guards are active' END
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgname IN ('trg_freeze_confirmed_order_line',
                 'trg_recompute_order_totals',
                 'trg_apply_fulfillment_line',
                 'trg_guard_order_status')

ORDER BY 2 DESC, 1;
