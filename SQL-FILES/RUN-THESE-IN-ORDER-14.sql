-- ═════════════════════════════════════════════════════════════════════
--  ORDENCE — FILE 14
--  Phase 40: Inventory
-- ═════════════════════════════════════════════════════════════════════
--
--  RUN FILE 13 FIRST. This one will not work without it.
--
--  WHAT TO DO
--  ----------
--  1. Open Neon:  https://console.neon.tech
--  2. Click your project, then "SQL Editor" in the left sidebar.
--  3. Select ALL the text in this file (Cmd+A), copy it (Cmd+C).
--  4. Paste it into the SQL Editor box.
--  5. Click "Run".
--  6. Wait about 10 seconds.
--  7. Scroll to the bottom. You are looking for the word PASS.
--     There should be twelve of them.
--
--  IF YOU SEE "FAIL": stop and send Claude a screenshot.
--  IF YOU SEE RED TEXT: nothing was changed — the whole file runs as one
--  unit. Send Claude the red text.
--
--  SAFE TO RUN TWICE.
--
--  WHAT THIS FILE DOES
--  -------------------
--  Part 1 creates seven tables for warehouses and stock.
--  Part 2 locks them down.
--
--  The important thing in Part 2 is that stock movements become
--  PERMANENT. Once this runs, nobody — not you, not a developer, not
--  Claude — can edit or delete a stock movement, ever. A mistake is
--  corrected by posting an opposite movement that points at the wrong
--  one, so the error and the fix both stay visible.
--
--  That sounds inconvenient and it is the entire point. It is what lets
--  you answer "why does the shed have 380 bags when the system says
--  400" six months later, instead of just changing the number to 380
--  and having the same argument again next quarter.
--
-- ═════════════════════════════════════════════════════════════════════

BEGIN;

-- ═════════════════════════════════════════════════════════════════════
--  PART 1 — THE TABLES
-- ═════════════════════════════════════════════════════════════════════

DO $ordence$ BEGIN
  CREATE TYPE public.warehouse_type AS ENUM
    ('own','site','consignment','transit','third_party','quarantine');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.stock_movement_reason AS ENUM
    ('purchase_receipt','sales_dispatch','sales_return','purchase_return',
     'transfer_out','transfer_in','production_consume','production_output',
     'adjustment','opening_balance','damage','theft','expiry','reversal');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.stock_tracking_mode AS ENUM ('none','batch','serial');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.stock_valuation_method AS ENUM
    ('fifo','weighted_average','specific','standard');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.stock_reservation_status AS ENUM
    ('held','picked','released','consumed','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.stock_count_status AS ENUM
    ('draft','counting','review','posted','abandoned');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

CREATE TABLE IF NOT EXISTS public.stock_balances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    stock_item_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    batch_no character varying(100) DEFAULT ''::character varying NOT NULL,
    quantity_on_hand numeric(18,3) DEFAULT 0 NOT NULL,
    quantity_reserved numeric(18,3) DEFAULT 0 NOT NULL,
    value_minor bigint DEFAULT 0 NOT NULL,
    last_movement_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.stock_count_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    count_id uuid NOT NULL,
    stock_item_id uuid NOT NULL,
    batch_no character varying(100),
    expected_quantity numeric(18,3) DEFAULT 0 NOT NULL,
    counted_quantity numeric(18,3),
    counted_by uuid,
    counted_at timestamp with time zone,
    variance_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.stock_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    count_no character varying(60) NOT NULL,
    warehouse_id uuid NOT NULL,
    status public.stock_count_status DEFAULT 'draft'::public.stock_count_status NOT NULL,
    scheduled_for date,
    started_at timestamp with time zone,
    posted_at timestamp with time zone,
    posted_by uuid,
    variance_value_minor bigint DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);

CREATE TABLE IF NOT EXISTS public.stock_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    asset_id uuid,
    sku character varying(100) NOT NULL,
    name character varying(300) NOT NULL,
    description text,
    uom character varying(20) DEFAULT 'nos'::character varying NOT NULL,
    tracking_mode public.stock_tracking_mode DEFAULT 'none'::public.stock_tracking_mode NOT NULL,
    valuation_method public.stock_valuation_method DEFAULT 'weighted_average'::public.stock_valuation_method NOT NULL,
    standard_cost_minor bigint,
    reorder_level numeric(18,3),
    reorder_quantity numeric(18,3),
    lead_time_days integer,
    shelf_life_days integer,
    hsn_sac_code character varying(20),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.stock_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    stock_item_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    quantity numeric(18,3) NOT NULL,
    reason public.stock_movement_reason NOT NULL,
    moved_at timestamp with time zone DEFAULT now() NOT NULL,
    unit_cost_minor bigint,
    value_minor bigint DEFAULT 0 NOT NULL,
    batch_no character varying(100),
    serial_no character varying(120),
    expiry_date date,
    sales_order_id uuid,
    sales_order_line_id uuid,
    reference_type character varying(60),
    reference_id uuid,
    document_no character varying(80),
    reverses_movement_id uuid,
    adjustment_note text,
    approved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    impersonation_id uuid,
    CONSTRAINT stock_movements_quantity_non_zero CHECK ((quantity <> (0)::numeric)),
    CONSTRAINT stock_movements_serial_is_single_unit CHECK (((serial_no IS NULL) OR (abs(quantity) = (1)::numeric)))
);

CREATE TABLE IF NOT EXISTS public.stock_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    stock_item_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    batch_no character varying(100),
    quantity numeric(18,3) NOT NULL,
    status public.stock_reservation_status DEFAULT 'held'::public.stock_reservation_status NOT NULL,
    sales_order_id uuid,
    sales_order_line_id uuid,
    expires_at timestamp with time zone,
    released_at timestamp with time zone,
    release_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT stock_reservations_quantity_positive CHECK ((quantity > (0)::numeric))
);

CREATE TABLE IF NOT EXISTS public.warehouses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code character varying(40) NOT NULL,
    name character varying(200) NOT NULL,
    warehouse_type public.warehouse_type DEFAULT 'own'::public.warehouse_type NOT NULL,
    project_id uuid,
    address_line1 character varying(255),
    address_line2 character varying(255),
    city character varying(120),
    state character varying(120),
    postal_code character varying(20),
    country character varying(2) DEFAULT 'IN'::character varying,
    gstin character varying(15),
    state_code character varying(2),
    manager_user_id uuid,
    allow_negative_stock boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone
);

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_balances_pkey'
                    AND conrelid = 'public.stock_balances'::regclass) THEN
    ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_count_lines_pkey'
                    AND conrelid = 'public.stock_count_lines'::regclass) THEN
    ALTER TABLE ONLY public.stock_count_lines
    ADD CONSTRAINT stock_count_lines_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_counts_pkey'
                    AND conrelid = 'public.stock_counts'::regclass) THEN
    ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_items_pkey'
                    AND conrelid = 'public.stock_items'::regclass) THEN
    ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_movements_pkey'
                    AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_reservations_pkey'
                    AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'warehouses_pkey'
                    AND conrelid = 'public.warehouses'::regclass) THEN
    ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

CREATE INDEX IF NOT EXISTS stock_balances_item_idx ON public.stock_balances USING btree (tenant_id, stock_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS stock_balances_slot_unique ON public.stock_balances USING btree (tenant_id, stock_item_id, warehouse_id, batch_no);

CREATE INDEX IF NOT EXISTS stock_balances_tenant_idx ON public.stock_balances USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS stock_balances_warehouse_idx ON public.stock_balances USING btree (tenant_id, warehouse_id);

CREATE INDEX IF NOT EXISTS stock_count_lines_count_idx ON public.stock_count_lines USING btree (tenant_id, count_id);

CREATE UNIQUE INDEX IF NOT EXISTS stock_count_lines_slot_unique ON public.stock_count_lines USING btree (count_id, stock_item_id, batch_no);

CREATE INDEX IF NOT EXISTS stock_count_lines_tenant_idx ON public.stock_count_lines USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_id_tenant_unique ON public.stock_counts USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_no_unique ON public.stock_counts USING btree (tenant_id, count_no);

CREATE INDEX IF NOT EXISTS stock_counts_tenant_idx ON public.stock_counts USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS stock_counts_warehouse_idx ON public.stock_counts USING btree (tenant_id, warehouse_id);

CREATE INDEX IF NOT EXISTS stock_items_asset_idx ON public.stock_items USING btree (tenant_id, asset_id);

CREATE UNIQUE INDEX IF NOT EXISTS stock_items_id_tenant_unique ON public.stock_items USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS stock_items_reorder_idx ON public.stock_items USING btree (tenant_id, reorder_level) WHERE ((reorder_level IS NOT NULL) AND (deleted_at IS NULL));

CREATE INDEX IF NOT EXISTS stock_items_tenant_idx ON public.stock_items USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS stock_items_tenant_sku_unique ON public.stock_items USING btree (tenant_id, sku) WHERE (deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS stock_movements_balance_idx ON public.stock_movements USING btree (tenant_id, stock_item_id, warehouse_id);

CREATE INDEX IF NOT EXISTS stock_movements_batch_idx ON public.stock_movements USING btree (tenant_id, stock_item_id, batch_no) WHERE (batch_no IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_id_tenant_unique ON public.stock_movements USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS stock_movements_moved_at_idx ON public.stock_movements USING btree (tenant_id, moved_at);

CREATE INDEX IF NOT EXISTS stock_movements_order_idx ON public.stock_movements USING btree (tenant_id, sales_order_id);

CREATE INDEX IF NOT EXISTS stock_movements_reversal_idx ON public.stock_movements USING btree (tenant_id, reverses_movement_id) WHERE (reverses_movement_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS stock_movements_tenant_idx ON public.stock_movements USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS stock_reservations_expiry_idx ON public.stock_reservations USING btree (tenant_id, expires_at) WHERE ((status = 'held'::public.stock_reservation_status) AND (expires_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS stock_reservations_live_idx ON public.stock_reservations USING btree (tenant_id, status) WHERE (status = ANY (ARRAY['held'::public.stock_reservation_status, 'picked'::public.stock_reservation_status]));

CREATE INDEX IF NOT EXISTS stock_reservations_order_line_idx ON public.stock_reservations USING btree (tenant_id, sales_order_line_id);

CREATE INDEX IF NOT EXISTS stock_reservations_slot_idx ON public.stock_reservations USING btree (tenant_id, stock_item_id, warehouse_id);

CREATE INDEX IF NOT EXISTS stock_reservations_tenant_idx ON public.stock_reservations USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS warehouses_id_tenant_unique ON public.warehouses USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS warehouses_project_idx ON public.warehouses USING btree (tenant_id, project_id);

CREATE UNIQUE INDEX IF NOT EXISTS warehouses_tenant_code_unique ON public.warehouses USING btree (tenant_id, code) WHERE (deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS warehouses_tenant_idx ON public.warehouses USING btree (tenant_id);

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_balances_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.stock_balances'::regclass) THEN
    ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_balances_warehouse_id_tenant_fk'
                    AND conrelid = 'public.stock_balances'::regclass) THEN
    ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_warehouse_id_tenant_fk FOREIGN KEY (warehouse_id, tenant_id) REFERENCES public.warehouses(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_count_lines_count_id_tenant_fk'
                    AND conrelid = 'public.stock_count_lines'::regclass) THEN
    ALTER TABLE ONLY public.stock_count_lines
    ADD CONSTRAINT stock_count_lines_count_id_tenant_fk FOREIGN KEY (count_id, tenant_id) REFERENCES public.stock_counts(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_count_lines_counted_by_users_id_fk'
                    AND conrelid = 'public.stock_count_lines'::regclass) THEN
    ALTER TABLE ONLY public.stock_count_lines
    ADD CONSTRAINT stock_count_lines_counted_by_users_id_fk FOREIGN KEY (counted_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_count_lines_stock_item_id_tenant_fk'
                    AND conrelid = 'public.stock_count_lines'::regclass) THEN
    ALTER TABLE ONLY public.stock_count_lines
    ADD CONSTRAINT stock_count_lines_stock_item_id_tenant_fk FOREIGN KEY (stock_item_id, tenant_id) REFERENCES public.stock_items(id, tenant_id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_count_lines_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.stock_count_lines'::regclass) THEN
    ALTER TABLE ONLY public.stock_count_lines
    ADD CONSTRAINT stock_count_lines_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_counts_created_by_users_id_fk'
                    AND conrelid = 'public.stock_counts'::regclass) THEN
    ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_counts_posted_by_users_id_fk'
                    AND conrelid = 'public.stock_counts'::regclass) THEN
    ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_posted_by_users_id_fk FOREIGN KEY (posted_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_counts_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.stock_counts'::regclass) THEN
    ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_counts_warehouse_id_tenant_fk'
                    AND conrelid = 'public.stock_counts'::regclass) THEN
    ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_warehouse_id_tenant_fk FOREIGN KEY (warehouse_id, tenant_id) REFERENCES public.warehouses(id, tenant_id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_items_asset_id_assets_id_fk'
                    AND conrelid = 'public.stock_items'::regclass) THEN
    ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_asset_id_assets_id_fk FOREIGN KEY (asset_id) REFERENCES public.assets(id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_items_created_by_users_id_fk'
                    AND conrelid = 'public.stock_items'::regclass) THEN
    ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_items_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.stock_items'::regclass) THEN
    ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_items_updated_by_users_id_fk'
                    AND conrelid = 'public.stock_items'::regclass) THEN
    ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_movements_approved_by_users_id_fk'
                    AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_approved_by_users_id_fk FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_movements_created_by_users_id_fk'
                    AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_movements_reverses_tenant_fk'
                    AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_reverses_tenant_fk FOREIGN KEY (reverses_movement_id, tenant_id) REFERENCES public.stock_movements(id, tenant_id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_movements_sales_order_id_sales_orders_id_fk'
                    AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_sales_order_id_sales_orders_id_fk FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_movements_sales_order_line_id_sales_order_lines_id_fk'
                    AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_sales_order_line_id_sales_order_lines_id_fk FOREIGN KEY (sales_order_line_id) REFERENCES public.sales_order_lines(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_movements_stock_item_id_tenant_fk'
                    AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_stock_item_id_tenant_fk FOREIGN KEY (stock_item_id, tenant_id) REFERENCES public.stock_items(id, tenant_id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_movements_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_movements_warehouse_id_tenant_fk'
                    AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_warehouse_id_tenant_fk FOREIGN KEY (warehouse_id, tenant_id) REFERENCES public.warehouses(id, tenant_id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_reservations_created_by_users_id_fk'
                    AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_reservations_sales_order_id_sales_orders_id_fk'
                    AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_sales_order_id_sales_orders_id_fk FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_reservations_sales_order_line_id_sales_order_lines_id_fk'
                    AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_sales_order_line_id_sales_order_lines_id_fk FOREIGN KEY (sales_order_line_id) REFERENCES public.sales_order_lines(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_reservations_stock_item_id_tenant_fk'
                    AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_stock_item_id_tenant_fk FOREIGN KEY (stock_item_id, tenant_id) REFERENCES public.stock_items(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_reservations_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stock_reservations_warehouse_id_tenant_fk'
                    AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_warehouse_id_tenant_fk FOREIGN KEY (warehouse_id, tenant_id) REFERENCES public.warehouses(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'warehouses_created_by_users_id_fk'
                    AND conrelid = 'public.warehouses'::regclass) THEN
    ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'warehouses_manager_user_id_users_id_fk'
                    AND conrelid = 'public.warehouses'::regclass) THEN
    ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_manager_user_id_users_id_fk FOREIGN KEY (manager_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'warehouses_project_id_projects_id_fk'
                    AND conrelid = 'public.warehouses'::regclass) THEN
    ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'warehouses_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.warehouses'::regclass) THEN
    ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'warehouses_updated_by_users_id_fk'
                    AND conrelid = 'public.warehouses'::regclass) THEN
    ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

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

-- ═════════════════════════════════════════════════════════════════════
--  PART 3 — THE CHECK   (look for PASS, twelve times)
-- ═════════════════════════════════════════════════════════════════════

SELECT 'Table exists: ' || t AS check_name,
       CASE WHEN to_regclass('public.' || t) IS NOT NULL
            THEN 'PASS' ELSE 'FAIL — not created' END AS result
FROM unnest(ARRAY['warehouses','stock_items','stock_movements','stock_balances',
                  'stock_reservations','stock_counts','stock_count_lines']) AS t

UNION ALL
SELECT 'Every inventory table has tenant isolation ON and FORCED',
       CASE WHEN count(*) = 7 THEN 'PASS'
            ELSE 'FAIL — only ' || count(*) || ' of 7 protected' END
FROM pg_class c
WHERE c.relname IN ('warehouses','stock_items','stock_movements','stock_balances',
                    'stock_reservations','stock_counts','stock_count_lines')
  AND c.relrowsecurity AND c.relforcerowsecurity

UNION ALL
SELECT 'Every inventory table has an isolation policy',
       CASE WHEN count(*) = 7 THEN 'PASS'
            ELSE 'FAIL — only ' || count(*) || ' of 7' END
FROM pg_policies
WHERE tablename IN ('warehouses','stock_items','stock_movements','stock_balances',
                    'stock_reservations','stock_counts','stock_count_lines')

UNION ALL
SELECT 'Stock movements can no longer be edited or deleted',
       CASE WHEN count(*) = 1 THEN 'PASS'
            ELSE 'FAIL — the append-only guard is missing' END
FROM pg_trigger
WHERE NOT tgisinternal AND tgname = 'trg_stock_ledger_append_only'

UNION ALL
SELECT 'Nothing can be promised to two customers at once',
       CASE WHEN count(*) = 1 THEN 'PASS'
            ELSE 'FAIL — the reservation guard is missing' END
FROM pg_trigger
WHERE NOT tgisinternal AND tgname = 'trg_guard_stock_reservation'

UNION ALL
SELECT 'A child row cannot be attached to another customer''s stock',
       CASE WHEN count(*) >= 10 THEN 'PASS'
            ELSE 'FAIL — only ' || count(*) || ' cross-tenant guards' END
FROM pg_constraint
WHERE conname LIKE '%_tenant_fk'
  AND (conrelid::regclass::text LIKE 'stock%'
    OR conrelid::regclass::text LIKE 'warehouse%')

ORDER BY 2 DESC, 1;
