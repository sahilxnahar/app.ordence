-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — FILE 20 · THE TABLES THEMSELVES
-- v0.68.0-alpha
--
-- ⭐ RUN THIS FIRST — BEFORE 21, 22, 23, 24 AND 25.
-- ══════════════════════════════════════════════════════════════════════
-- Every one of those files begins by checking that its tables exist and
-- refuses to run if they do not. This file is what creates them.
--
-- Normally the tables come from `npx drizzle-kit push` in a terminal.
-- This file does exactly the same thing as a paste-in, so the whole
-- deployment stays copy-and-paste.
--
-- ⚠️ SAFE TO RUN ON A DATABASE THAT ALREADY HAS SOME OF THIS. Every
-- statement below is guarded: an object that already exists is skipped,
-- not recreated and not altered. Running it twice changes nothing the
-- second time.
--
-- ⚠️ IT CREATES ONLY. Nothing here drops a table, drops a column, or
-- deletes a row. There is no path through this file that loses data.
--
-- ⚠️ AND THE ORDER OF THE SECTIONS BELOW IS LOAD-BEARING. Foreign keys
-- come LAST, after the indexes — because several of them point at a
-- (id, tenant_id) pair whose uniqueness comes from a unique INDEX rather
-- than a table constraint. Emitted in the obvious order, Postgres
-- refuses the key with "there is no unique constraint matching given
-- keys", which reads like a missing column and is really a missing
-- index that had not been created yet.
--
-- What it creates: 33 tables and 30 enum types across
--   · Engine 2 — rate cards and pricing
--   · Engine 3 — field jobs and mobile technicians
--   · Engine 5 — utility meters and readings
--   · Engine 6 — the sensitive-data vault
--   · BOQ, measurement books, rate analysis and variations
--   · Site labour — workers, attendance, welfare, daily logs
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1 · TYPES
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ POSTGRES HAS NO `CREATE TYPE IF NOT EXISTS`. Each one is therefore
-- wrapped in a catalogue check. Without it, a second run fails on the
-- first type that already exists and rolls back everything after it.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_kind') THEN
    EXECUTE 'CREATE TYPE public.attendance_kind AS ENUM (
    ''check_in'',
    ''check_out''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'boq_item_category') THEN
    EXECUTE 'CREATE TYPE public.boq_item_category AS ENUM (
    ''earthwork'',
    ''piling_foundation'',
    ''concrete'',
    ''reinforcement'',
    ''formwork'',
    ''masonry'',
    ''plaster'',
    ''flooring'',
    ''waterproofing'',
    ''doors_windows'',
    ''painting'',
    ''plumbing'',
    ''electrical'',
    ''hvac'',
    ''fire_fighting'',
    ''lifts'',
    ''external_development'',
    ''preliminaries'',
    ''miscellaneous''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'boq_status') THEN
    EXECUTE 'CREATE TYPE public.boq_status AS ENUM (
    ''draft'',
    ''issued'',
    ''superseded'',
    ''closed''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'contract_advance_kind') THEN
    EXECUTE 'CREATE TYPE public.contract_advance_kind AS ENUM (
    ''mobilisation'',
    ''material'',
    ''plant'',
    ''secured_advance''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'field_failure_reason') THEN
    EXECUTE 'CREATE TYPE public.field_failure_reason AS ENUM (
    ''customer_absent'',
    ''access_denied'',
    ''site_not_ready'',
    ''part_unavailable'',
    ''wrong_address'',
    ''unsafe_conditions'',
    ''weather'',
    ''vehicle_breakdown'',
    ''customer_refused'',
    ''other''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'field_job_priority') THEN
    EXECUTE 'CREATE TYPE public.field_job_priority AS ENUM (
    ''routine'',
    ''standard'',
    ''urgent'',
    ''emergency''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'field_job_status') THEN
    EXECUTE 'CREATE TYPE public.field_job_status AS ENUM (
    ''draft'',
    ''scheduled'',
    ''dispatched'',
    ''travelling'',
    ''on_site'',
    ''paused'',
    ''completed'',
    ''could_not_complete'',
    ''cancelled''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'field_proof_kind') THEN
    EXECUTE 'CREATE TYPE public.field_proof_kind AS ENUM (
    ''photo_before'',
    ''photo_after'',
    ''signature'',
    ''otp'',
    ''barcode_scan'',
    ''document'',
    ''reading'',
    ''note''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'measurement_status') THEN
    EXECUTE 'CREATE TYPE public.measurement_status AS ENUM (
    ''recorded'',
    ''checked'',
    ''billed'',
    ''rejected''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meter_kind') THEN
    EXECUTE 'CREATE TYPE public.meter_kind AS ENUM (
    ''electricity_import'',
    ''electricity_export'',
    ''electricity_net'',
    ''solar_generation'',
    ''water'',
    ''gas'',
    ''fuel'',
    ''sub_meter''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meter_status') THEN
    EXECUTE 'CREATE TYPE public.meter_status AS ENUM (
    ''pending_installation'',
    ''active'',
    ''faulty'',
    ''replaced'',
    ''disconnected'',
    ''removed''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rate_basis') THEN
    EXECUTE 'CREATE TYPE public.rate_basis AS ENUM (
    ''per_unit'',
    ''per_night'',
    ''per_hour'',
    ''per_day'',
    ''per_km'',
    ''per_kg'',
    ''per_kwh'',
    ''flat_fee'',
    ''percentage''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rate_component_kind') THEN
    EXECUTE 'CREATE TYPE public.rate_component_kind AS ENUM (
    ''material'',
    ''labour'',
    ''plant'',
    ''transport'',
    ''wastage'',
    ''overhead'',
    ''profit''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rate_scope') THEN
    EXECUTE 'CREATE TYPE public.rate_scope AS ENUM (
    ''list'',
    ''seasonal'',
    ''channel'',
    ''segment'',
    ''contracted'',
    ''promotional''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reading_source') THEN
    EXECUTE 'CREATE TYPE public.reading_source AS ENUM (
    ''manual'',
    ''photo'',
    ''smart_meter'',
    ''api'',
    ''estimated'',
    ''customer_submitted''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reading_status') THEN
    EXECUTE 'CREATE TYPE public.reading_status AS ENUM (
    ''recorded'',
    ''validated'',
    ''disputed'',
    ''superseded'',
    ''rejected''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'retention_entry_kind') THEN
    EXECUTE 'CREATE TYPE public.retention_entry_kind AS ENUM (
    ''held'',
    ''released''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'retention_release_stage') THEN
    EXECUTE 'CREATE TYPE public.retention_release_stage AS ENUM (
    ''practical_completion'',
    ''defect_liability_expiry'',
    ''bank_guarantee_substitution'',
    ''ad_hoc''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shift_kind') THEN
    EXECUTE 'CREATE TYPE public.shift_kind AS ENUM (
    ''morning'',
    ''evening'',
    ''night'',
    ''full_day'',
    ''off''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'slab_mode') THEN
    EXECUTE 'CREATE TYPE public.slab_mode AS ENUM (
    ''progressive'',
    ''flat'',
    ''none''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'uan_status') THEN
    EXECUTE 'CREATE TYPE public.uan_status AS ENUM (
    ''pending'',
    ''valid'',
    ''invalid'',
    ''not_applicable''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'uom_code') THEN
    EXECUTE 'CREATE TYPE public.uom_code AS ENUM (
    ''cum'',
    ''sqm'',
    ''sqft'',
    ''rmt'',
    ''kg'',
    ''mt'',
    ''quintal'',
    ''nos'',
    ''bag'',
    ''brass'',
    ''ltr'',
    ''day'',
    ''month'',
    ''ls''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'variation_kind') THEN
    EXECUTE 'CREATE TYPE public.variation_kind AS ENUM (
    ''addition'',
    ''omission'',
    ''rate_change'',
    ''substitution'',
    ''extra_item''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'variation_status') THEN
    EXECUTE 'CREATE TYPE public.variation_status AS ENUM (
    ''draft'',
    ''submitted'',
    ''approved'',
    ''rejected'',
    ''withdrawn''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vault_access_purpose') THEN
    EXECUTE 'CREATE TYPE public.vault_access_purpose AS ENUM (
    ''kyc_verification'',
    ''payment_processing'',
    ''statutory_filing'',
    ''customer_request'',
    ''clinical_care'',
    ''dispute_resolution'',
    ''audit'',
    ''bulk_export'',
    ''support_troubleshooting'',
    ''migration''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vault_kind') THEN
    EXECUTE 'CREATE TYPE public.vault_kind AS ENUM (
    ''pan'',
    ''aadhaar'',
    ''passport'',
    ''driving_licence'',
    ''voter_id'',
    ''bank_account'',
    ''ifsc_pair'',
    ''gstin_credential'',
    ''portal_password'',
    ''api_credential'',
    ''health_identifier'',
    ''salary'',
    ''other''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vault_status') THEN
    EXECUTE 'CREATE TYPE public.vault_status AS ENUM (
    ''active'',
    ''superseded'',
    ''expired'',
    ''erased''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vendor_default_kind') THEN
    EXECUTE 'CREATE TYPE public.vendor_default_kind AS ENUM (
    ''abandonment'',
    ''quality_failure'',
    ''delay'',
    ''financial'',
    ''safety'',
    ''labour_compliance'',
    ''other''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vendor_default_severity') THEN
    EXECUTE 'CREATE TYPE public.vendor_default_severity AS ENUM (
    ''low'',
    ''medium'',
    ''high'',
    ''blacklist''
);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'welfare_category') THEN
    EXECUTE 'CREATE TYPE public.welfare_category AS ENUM (
    ''drinking_water'',
    ''sanitation'',
    ''creche'',
    ''first_aid'',
    ''rest_shelter'',
    ''medical_camp'',
    ''safety_training'',
    ''canteen'',
    ''accommodation'',
    ''other''
);';
  END IF;
END $do$;


-- ══════════════════════════════════════════════════════════════════════
-- 2 · TABLES
-- ══════════════════════════════════════════════════════════════════════
--
-- `IF NOT EXISTS` throughout. A table that is already present is left
-- exactly as it is — this file will not alter or replace one.

CREATE TABLE IF NOT EXISTS public.rate_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code character varying(80) NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    scope public.rate_scope DEFAULT 'list'::public.rate_scope NOT NULL,
    slab_mode public.slab_mode NOT NULL,
    basis public.rate_basis NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    applies_to_kind character varying(60),
    applies_to_id uuid,
    customer_company_id uuid,
    channel character varying(60),
    valid_from date,
    valid_to date,
    days_of_week character varying(7),
    currency character varying(3) DEFAULT 'INR'::character varying NOT NULL,
    base_amount_minor bigint DEFAULT 0 NOT NULL,
    tax_rate_bps integer DEFAULT 0 NOT NULL,
    is_tax_inclusive boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT rate_cards_tax_sane CHECK (((tax_rate_bps >= 0) AND (tax_rate_bps <= 10000))),
    CONSTRAINT rate_cards_validity_ordered CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to > valid_from)))
);

CREATE TABLE IF NOT EXISTS public.rate_slabs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    rate_card_id uuid NOT NULL,
    sequence integer NOT NULL,
    up_to_quantity bigint,
    unit_amount_minor bigint NOT NULL,
    fixed_amount_minor bigint DEFAULT 0 NOT NULL,
    label character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_slabs_amount_non_negative CHECK (((unit_amount_minor >= 0) AND (fixed_amount_minor >= 0))),
    CONSTRAINT rate_slabs_up_to_positive CHECK (((up_to_quantity IS NULL) OR (up_to_quantity > 0)))
);

CREATE TABLE IF NOT EXISTS public.rate_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    rate_card_id uuid NOT NULL,
    sequence integer NOT NULL,
    label character varying(160) NOT NULL,
    percentage_bps integer DEFAULT 0 NOT NULL,
    fixed_amount_minor bigint DEFAULT 0 NOT NULL,
    is_visible boolean DEFAULT true NOT NULL,
    is_statutory boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.rate_quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    rate_card_id uuid NOT NULL,
    quantity bigint NOT NULL,
    subtotal_minor bigint NOT NULL,
    adjustments_minor bigint DEFAULT 0 NOT NULL,
    tax_minor bigint DEFAULT 0 NOT NULL,
    total_minor bigint NOT NULL,
    breakdown jsonb DEFAULT '[]'::jsonb NOT NULL,
    selection_reason text,
    quoted_for character varying(200),
    quoted_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.utility_meters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    serial_number character varying(120) NOT NULL,
    kind public.meter_kind NOT NULL,
    status public.meter_status DEFAULT 'active'::public.meter_status NOT NULL,
    consumer_contact_id uuid,
    location character varying(300),
    connection_ref character varying(120),
    digit_count integer DEFAULT 6 NOT NULL,
    multiplier numeric(12,4) DEFAULT '1'::numeric NOT NULL,
    unit character varying(20) DEFAULT 'kWh'::character varying NOT NULL,
    rate_card_id uuid,
    installed_on date,
    initial_reading numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    replaces_meter_id uuid,
    replaced_on date,
    is_net_metered boolean DEFAULT false NOT NULL,
    sanctioned_load_kw numeric(12,3),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT utility_meters_digits_sane CHECK (((digit_count >= 3) AND (digit_count <= 12))),
    CONSTRAINT utility_meters_no_self_replace CHECK (((replaces_meter_id IS NULL) OR (replaces_meter_id <> id)))
);

CREATE TABLE IF NOT EXISTS public.meter_readings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    meter_id uuid NOT NULL,
    read_at timestamp with time zone NOT NULL,
    reading_value numeric(18,4) NOT NULL,
    source public.reading_source DEFAULT 'manual'::public.reading_source NOT NULL,
    status public.reading_status DEFAULT 'recorded'::public.reading_status NOT NULL,
    previous_reading_id uuid,
    previous_value numeric(18,4),
    consumption numeric(18,4),
    is_rollover boolean DEFAULT false NOT NULL,
    is_anomaly boolean DEFAULT false NOT NULL,
    anomaly_note text,
    document_id uuid,
    read_by_user_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meter_readings_value_non_negative CHECK ((reading_value >= (0)::numeric))
);

CREATE TABLE IF NOT EXISTS public.meter_billing_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    meter_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    label character varying(60) NOT NULL,
    opening_reading_id uuid,
    closing_reading_id uuid,
    units_consumed numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    units_exported numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    units_banked_opening numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    units_banked_closing numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    rate_card_id uuid,
    energy_charge_minor bigint DEFAULT 0 NOT NULL,
    fixed_charge_minor bigint DEFAULT 0 NOT NULL,
    duty_minor bigint DEFAULT 0 NOT NULL,
    export_credit_minor bigint DEFAULT 0 NOT NULL,
    total_minor bigint DEFAULT 0 NOT NULL,
    is_finalised boolean DEFAULT false NOT NULL,
    finalised_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meter_billing_periods_ordered CHECK ((period_end >= period_start))
);

CREATE TABLE IF NOT EXISTS public.field_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    job_number character varying(60) NOT NULL,
    title character varying(250) NOT NULL,
    description text,
    job_kind character varying(60) NOT NULL,
    status public.field_job_status DEFAULT 'draft'::public.field_job_status NOT NULL,
    priority public.field_job_priority DEFAULT 'standard'::public.field_job_priority NOT NULL,
    customer_company_id uuid,
    customer_contact_id uuid,
    site_address text,
    site_landmark character varying(250),
    site_latitude numeric(10,7),
    site_longitude numeric(10,7),
    window_start timestamp with time zone,
    window_end timestamp with time zone,
    estimated_minutes integer,
    assigned_user_id uuid,
    crew_name character varying(120),
    completed_at timestamp with time zone,
    failure_reason public.field_failure_reason,
    failure_note text,
    visit_count integer DEFAULT 0 NOT NULL,
    rate_card_id uuid,
    quoted_amount_minor bigint,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT field_jobs_coords_paired CHECK (((site_latitude IS NULL) = (site_longitude IS NULL))),
    CONSTRAINT field_jobs_coords_sane CHECK (((site_latitude IS NULL) OR (((site_latitude >= ('-90'::integer)::numeric) AND (site_latitude <= (90)::numeric)) AND ((site_longitude >= ('-180'::integer)::numeric) AND (site_longitude <= (180)::numeric))))),
    CONSTRAINT field_jobs_window_ordered CHECK (((window_end IS NULL) OR (window_start IS NULL) OR (window_end >= window_start)))
);

CREATE TABLE IF NOT EXISTS public.field_visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    job_id uuid NOT NULL,
    client_event_id character varying(120) NOT NULL,
    sequence integer DEFAULT 1 NOT NULL,
    checked_in_at timestamp with time zone,
    checked_in_latitude numeric(10,7),
    checked_in_longitude numeric(10,7),
    checked_in_accuracy_m integer,
    checked_out_at timestamp with time zone,
    checked_out_latitude numeric(10,7),
    checked_out_longitude numeric(10,7),
    distance_from_site_m integer,
    is_distance_suspicious boolean DEFAULT false NOT NULL,
    on_site_minutes integer,
    technician_user_id uuid,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT field_visits_times_ordered CHECK (((checked_out_at IS NULL) OR (checked_in_at IS NULL) OR (checked_out_at >= checked_in_at)))
);

CREATE TABLE IF NOT EXISTS public.field_proofs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    visit_id uuid NOT NULL,
    job_id uuid NOT NULL,
    kind public.field_proof_kind NOT NULL,
    document_id uuid,
    storage_key character varying(500),
    value text,
    accepted_by_name character varying(200),
    otp_verified boolean DEFAULT false NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    captured_latitude numeric(10,7),
    captured_longitude numeric(10,7),
    client_event_id character varying(120) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.field_job_materials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    job_id uuid NOT NULL,
    visit_id uuid,
    item_code character varying(100) NOT NULL,
    item_name character varying(250) NOT NULL,
    quantity numeric(18,4) NOT NULL,
    unit character varying(20) DEFAULT 'nos'::character varying NOT NULL,
    unit_cost_minor bigint DEFAULT 0 NOT NULL,
    is_billable boolean DEFAULT true NOT NULL,
    is_warranty boolean DEFAULT false NOT NULL,
    serial_number character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT field_job_materials_quantity_non_zero CHECK ((quantity <> (0)::numeric))
);

CREATE TABLE IF NOT EXISTS public.vault_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind public.vault_kind NOT NULL,
    status public.vault_status DEFAULT 'active'::public.vault_status NOT NULL,
    owner_kind character varying(60) NOT NULL,
    owner_id uuid NOT NULL,
    label character varying(200),
    ciphertext text NOT NULL,
    iv character varying(64) NOT NULL,
    key_ref character varying(120) NOT NULL,
    algorithm character varying(40) DEFAULT 'AES-GCM-256'::character varying NOT NULL,
    blind_index character varying(64),
    masked_display character varying(100),
    retain_until timestamp with time zone,
    erased_at timestamp with time zone,
    erased_reason text,
    supersedes_id uuid,
    access_count integer DEFAULT 0 NOT NULL,
    last_accessed_at timestamp with time zone,
    created_by_user_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_secrets_erasure_is_real CHECK (((status <> 'erased'::public.vault_status) OR ((ciphertext = ''::text) AND (erased_at IS NOT NULL)))),
    CONSTRAINT vault_secrets_no_self_supersede CHECK (((supersedes_id IS NULL) OR (supersedes_id <> id)))
);

CREATE TABLE IF NOT EXISTS public.vault_access_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    secret_id uuid NOT NULL,
    secret_kind public.vault_kind NOT NULL,
    owner_kind character varying(60) NOT NULL,
    owner_id uuid NOT NULL,
    user_id uuid,
    user_email character varying(320),
    purpose public.vault_access_purpose NOT NULL,
    justification text,
    was_decrypted boolean DEFAULT true NOT NULL,
    ip_address character varying(45),
    user_agent text,
    via_impersonation boolean DEFAULT false NOT NULL,
    accessed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_access_log_bulk_needs_justification CHECK (((purpose <> 'bulk_export'::public.vault_access_purpose) OR ((justification IS NOT NULL) AND (length(justification) >= 20))))
);

CREATE TABLE IF NOT EXISTS public.vault_consents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_kind character varying(60) NOT NULL,
    subject_id uuid NOT NULL,
    purpose character varying(200) NOT NULL,
    notice_text text NOT NULL,
    notice_version character varying(40) NOT NULL,
    granted_at timestamp with time zone NOT NULL,
    granted_via character varying(60) NOT NULL,
    withdrawn_at timestamp with time zone,
    withdrawn_reason text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_consents_withdrawn_after_granted CHECK (((withdrawn_at IS NULL) OR (withdrawn_at >= granted_at)))
);

CREATE TABLE IF NOT EXISTS public.boq_item_master (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code character varying(60) NOT NULL,
    category public.boq_item_category DEFAULT 'miscellaneous'::public.boq_item_category NOT NULL,
    short_description character varying(500) NOT NULL,
    full_description text,
    specification_ref character varying(255),
    uom public.uom_code NOT NULL,
    indicative_rate_minor bigint,
    indicative_rate_on date,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT boq_item_master_rate_non_negative CHECK (((indicative_rate_minor IS NULL) OR (indicative_rate_minor >= 0)))
);

CREATE TABLE IF NOT EXISTS public.boqs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    work_package character varying(200) NOT NULL,
    code character varying(60) NOT NULL,
    title character varying(255) NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status public.boq_status DEFAULT 'draft'::public.boq_status NOT NULL,
    contractor_vendor_id uuid,
    contract_ref character varying(120),
    contract_date date,
    original_sum_minor bigint DEFAULT 0 NOT NULL,
    variation_sum_minor bigint DEFAULT 0 NOT NULL,
    revised_sum_minor bigint DEFAULT 0 NOT NULL,
    retention_rate_bps integer DEFAULT 500 NOT NULL,
    retention_cap_minor bigint,
    retention_release_completion_bps integer DEFAULT 5000 NOT NULL,
    defect_liability_months integer DEFAULT 12 NOT NULL,
    gst_rate_bps integer DEFAULT 1800 NOT NULL,
    gst_tds_applicable boolean DEFAULT false NOT NULL,
    gst_tds_rate_bps integer DEFAULT 200 NOT NULL,
    tds_section character varying(12) DEFAULT '194C'::character varying NOT NULL,
    issued_at timestamp with time zone,
    issued_by uuid,
    superseded_by_id uuid,
    closed_at timestamp with time zone,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT boqs_rates_sane CHECK ((((retention_rate_bps >= 0) AND (retention_rate_bps <= 10000)) AND ((retention_release_completion_bps >= 0) AND (retention_release_completion_bps <= 10000)) AND ((gst_rate_bps >= 0) AND (gst_rate_bps <= 10000)) AND ((gst_tds_rate_bps >= 0) AND (gst_tds_rate_bps <= 10000)) AND (defect_liability_months >= 0) AND (version >= 1))),
    CONSTRAINT boqs_retention_cap_non_negative CHECK (((retention_cap_minor IS NULL) OR (retention_cap_minor >= 0))),
    CONSTRAINT boqs_sum_balances CHECK ((revised_sum_minor = (original_sum_minor + variation_sum_minor)))
);

CREATE TABLE IF NOT EXISTS public.boq_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    boq_id uuid NOT NULL,
    item_master_id uuid,
    item_code character varying(60) NOT NULL,
    sequence integer NOT NULL,
    is_heading boolean DEFAULT false NOT NULL,
    category public.boq_item_category DEFAULT 'miscellaneous'::public.boq_item_category NOT NULL,
    description text NOT NULL,
    specification_ref character varying(255),
    uom public.uom_code NOT NULL,
    quantity_scaled bigint DEFAULT 0 NOT NULL,
    rate_minor bigint DEFAULT 0 NOT NULL,
    amount_minor bigint DEFAULT 0 NOT NULL,
    varied_quantity_scaled bigint DEFAULT 0 NOT NULL,
    varied_rate_minor bigint,
    varied_amount_minor bigint DEFAULT 0 NOT NULL,
    rate_analysis_id uuid,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT boq_items_authorised_non_negative CHECK (((quantity_scaled + varied_quantity_scaled) >= 0)),
    CONSTRAINT boq_items_heading_is_empty CHECK (((NOT is_heading) OR ((quantity_scaled = 0) AND (rate_minor = 0) AND (amount_minor = 0)))),
    CONSTRAINT boq_items_non_negative CHECK (((quantity_scaled >= 0) AND (rate_minor >= 0) AND (amount_minor >= 0) AND ((varied_rate_minor IS NULL) OR (varied_rate_minor >= 0))))
);

CREATE TABLE IF NOT EXISTS public.rate_analyses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code character varying(60) NOT NULL,
    title character varying(255) NOT NULL,
    item_master_id uuid,
    uom public.uom_code NOT NULL,
    output_quantity_scaled bigint NOT NULL,
    priced_on date NOT NULL,
    material_minor bigint DEFAULT 0 NOT NULL,
    labour_minor bigint DEFAULT 0 NOT NULL,
    plant_minor bigint DEFAULT 0 NOT NULL,
    transport_minor bigint DEFAULT 0 NOT NULL,
    wastage_minor bigint DEFAULT 0 NOT NULL,
    overhead_minor bigint DEFAULT 0 NOT NULL,
    profit_minor bigint DEFAULT 0 NOT NULL,
    total_minor bigint DEFAULT 0 NOT NULL,
    derived_rate_minor bigint DEFAULT 0 NOT NULL,
    overhead_rate_bps integer DEFAULT 0 NOT NULL,
    profit_rate_bps integer DEFAULT 0 NOT NULL,
    wastage_rate_bps integer DEFAULT 0 NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_analyses_non_negative CHECK (((material_minor >= 0) AND (labour_minor >= 0) AND (plant_minor >= 0) AND (transport_minor >= 0) AND (wastage_minor >= 0) AND (overhead_minor >= 0) AND (profit_minor >= 0) AND (derived_rate_minor >= 0))),
    CONSTRAINT rate_analyses_output_positive CHECK ((output_quantity_scaled > 0)),
    CONSTRAINT rate_analyses_total_balances CHECK ((total_minor = ((((((material_minor + labour_minor) + plant_minor) + transport_minor) + wastage_minor) + overhead_minor) + profit_minor)))
);

CREATE TABLE IF NOT EXISTS public.rate_analysis_components (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    rate_analysis_id uuid NOT NULL,
    sequence integer NOT NULL,
    kind public.rate_component_kind NOT NULL,
    description character varying(500) NOT NULL,
    uom public.uom_code NOT NULL,
    quantity_scaled bigint DEFAULT 0 NOT NULL,
    rate_minor bigint DEFAULT 0 NOT NULL,
    amount_minor bigint DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_analysis_components_non_negative CHECK (((quantity_scaled >= 0) AND (rate_minor >= 0) AND (amount_minor >= 0)))
);

CREATE TABLE IF NOT EXISTS public.boq_variations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    boq_id uuid NOT NULL,
    variation_number character varying(40) NOT NULL,
    sequence integer NOT NULL,
    kind public.variation_kind NOT NULL,
    status public.variation_status DEFAULT 'draft'::public.variation_status NOT NULL,
    title character varying(255) NOT NULL,
    reason text NOT NULL,
    instruction_ref character varying(120),
    instructed_on date,
    effect_minor bigint DEFAULT 0 NOT NULL,
    submitted_at timestamp with time zone,
    submitted_by uuid,
    approved_at timestamp with time zone,
    approved_by uuid,
    rejected_at timestamp with time zone,
    rejection_reason text,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT boq_variations_approval_complete CHECK (((status <> 'approved'::public.variation_status) OR ((approved_by IS NOT NULL) AND (approved_at IS NOT NULL)))),
    CONSTRAINT boq_variations_rejection_explained CHECK (((status <> 'rejected'::public.variation_status) OR ((rejected_at IS NOT NULL) AND (rejection_reason IS NOT NULL)))),
    CONSTRAINT boq_variations_sign_matches_kind CHECK ((((kind <> 'omission'::public.variation_kind) OR (effect_minor <= 0)) AND ((kind <> 'addition'::public.variation_kind) OR (effect_minor >= 0))))
);

CREATE TABLE IF NOT EXISTS public.boq_variation_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    variation_id uuid NOT NULL,
    boq_item_id uuid,
    sequence integer NOT NULL,
    description text NOT NULL,
    uom public.uom_code NOT NULL,
    quantity_delta_scaled bigint DEFAULT 0 NOT NULL,
    rate_minor bigint DEFAULT 0 NOT NULL,
    replaces_rate boolean DEFAULT false NOT NULL,
    amount_delta_minor bigint DEFAULT 0 NOT NULL,
    rate_analysis_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT boq_variation_items_rate_change_has_item CHECK (((NOT replaces_rate) OR (boq_item_id IS NOT NULL))),
    CONSTRAINT boq_variation_items_rate_non_negative CHECK ((rate_minor >= 0))
);

CREATE TABLE IF NOT EXISTS public.measurement_books (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    boq_id uuid NOT NULL,
    book_number character varying(40) NOT NULL,
    title character varying(255),
    opened_on date NOT NULL,
    closed_on date,
    is_closed boolean DEFAULT false NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT measurement_books_closed_is_dated CHECK (((NOT is_closed) OR (closed_on IS NOT NULL)))
);

CREATE TABLE IF NOT EXISTS public.measurement_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    measurement_book_id uuid NOT NULL,
    boq_item_id uuid NOT NULL,
    ra_bill_id uuid,
    page_ref character varying(40),
    sequence integer NOT NULL,
    location_ref character varying(255) NOT NULL,
    level_ref character varying(120),
    description text,
    nos_scaled bigint,
    length_scaled bigint,
    breadth_scaled bigint,
    depth_scaled bigint,
    quantity_scaled bigint NOT NULL,
    is_deduction boolean DEFAULT false NOT NULL,
    measured_on date NOT NULL,
    measured_by uuid NOT NULL,
    status public.measurement_status DEFAULT 'recorded'::public.measurement_status NOT NULL,
    checked_by uuid,
    checked_at timestamp with time zone,
    rejection_reason text,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT measurement_entries_check_attributed CHECK (((status <> 'checked'::public.measurement_status) OR ((checked_by IS NOT NULL) AND (checked_at IS NOT NULL)))),
    CONSTRAINT measurement_entries_dimensions_non_negative CHECK ((((nos_scaled IS NULL) OR (nos_scaled >= 0)) AND ((length_scaled IS NULL) OR (length_scaled >= 0)) AND ((breadth_scaled IS NULL) OR (breadth_scaled >= 0)) AND ((depth_scaled IS NULL) OR (depth_scaled >= 0)))),
    CONSTRAINT measurement_entries_quantity_positive CHECK ((quantity_scaled >= 0))
);

CREATE TABLE IF NOT EXISTS public.contract_advances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    boq_id uuid NOT NULL,
    contractor_vendor_id uuid NOT NULL,
    kind public.contract_advance_kind NOT NULL,
    reference character varying(80) NOT NULL,
    granted_minor bigint NOT NULL,
    granted_on date NOT NULL,
    recovery_rate_bps integer DEFAULT 0 NOT NULL,
    recovery_starts_progress_bps integer DEFAULT 0 NOT NULL,
    recovery_complete_progress_bps integer DEFAULT 10000 NOT NULL,
    recovered_minor bigint DEFAULT 0 NOT NULL,
    bank_guarantee_ref character varying(120),
    bank_guarantee_expires_on date,
    interest_rate_bps integer DEFAULT 0 NOT NULL,
    is_closed boolean DEFAULT false NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_advances_rates_sane CHECK ((((recovery_rate_bps >= 0) AND (recovery_rate_bps <= 10000)) AND ((recovery_starts_progress_bps >= 0) AND (recovery_starts_progress_bps <= 10000)) AND ((recovery_complete_progress_bps >= 0) AND (recovery_complete_progress_bps <= 10000)) AND ((interest_rate_bps >= 0) AND (interest_rate_bps <= 10000)))),
    CONSTRAINT contract_advances_recovery_bounded CHECK (((recovered_minor >= 0) AND (recovered_minor <= granted_minor))),
    CONSTRAINT contract_advances_recovery_within_grant CHECK (((granted_minor > 0) AND (recovered_minor >= 0) AND (recovered_minor <= granted_minor)))
);

CREATE TABLE IF NOT EXISTS public.retention_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    boq_id uuid NOT NULL,
    contractor_vendor_id uuid NOT NULL,
    entry_kind public.retention_entry_kind NOT NULL,
    ra_bill_id uuid,
    release_stage public.retention_release_stage,
    amount_minor bigint NOT NULL,
    effective_on date NOT NULL,
    reason text,
    reference character varying(120),
    actor_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retention_ledger_amount_positive CHECK ((amount_minor > 0)),
    CONSTRAINT retention_ledger_shape_matches_kind CHECK ((((entry_kind = 'held'::public.retention_entry_kind) AND (ra_bill_id IS NOT NULL) AND (release_stage IS NULL)) OR ((entry_kind = 'released'::public.retention_entry_kind) AND (release_stage IS NOT NULL) AND (reason IS NOT NULL))))
);

CREATE TABLE IF NOT EXISTS public.site_workers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    vendor_id uuid,
    project_id uuid,
    worker_name character varying(200) NOT NULL,
    trade character varying(100),
    uan character varying(12),
    uan_status public.uan_status DEFAULT 'pending'::public.uan_status NOT NULL,
    uan_verified_at timestamp with time zone,
    uan_verified_by uuid,
    uan_rejection_reason text,
    is_admissible boolean DEFAULT false NOT NULL,
    blocked_reason text,
    inducted_on date,
    exited_on date,
    photo_document_id uuid,
    phone character varying(20),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT site_workers_uan_shape CHECK (((uan IS NULL) OR ((uan)::text ~ '^[0-9]{12}$'::text)))
);

CREATE TABLE IF NOT EXISTS public.welfare_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    category public.welfare_category NOT NULL,
    logged_on date NOT NULL,
    headcount integer,
    photo_document_id uuid,
    note text,
    logged_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT welfare_logs_headcount_non_negative CHECK (((headcount IS NULL) OR (headcount >= 0)))
);

CREATE TABLE IF NOT EXISTS public.piece_rate_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    vendor_id uuid,
    work_item character varying(300) NOT NULL,
    unit character varying(20) DEFAULT 'sqft'::character varying NOT NULL,
    quantity numeric(18,3) NOT NULL,
    rate_per_unit_minor bigint NOT NULL,
    amount_minor bigint DEFAULT 0 NOT NULL,
    measured_on date NOT NULL,
    measured_by uuid,
    witnessed_by_name character varying(200),
    ra_bill_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT piece_rate_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT piece_rate_rate_non_negative CHECK ((rate_per_unit_minor >= 0))
);

CREATE TABLE IF NOT EXISTS public.site_attendance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    worker_id uuid,
    project_id uuid,
    kind public.attendance_kind NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7),
    accuracy_metres integer,
    distance_metres integer,
    within_site boolean DEFAULT false NOT NULL,
    is_offline boolean DEFAULT false NOT NULL,
    synced_at timestamp with time zone,
    photo_document_id uuid,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_attendance_one_subject CHECK ((((user_id IS NOT NULL) AND (worker_id IS NULL)) OR ((user_id IS NULL) AND (worker_id IS NOT NULL))))
);

CREATE TABLE IF NOT EXISTS public.duty_rosters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id uuid,
    roster_date date NOT NULL,
    shift public.shift_kind DEFAULT 'full_day'::public.shift_kind NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);

CREATE TABLE IF NOT EXISTS public.vendor_defaults (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    project_id uuid,
    kind public.vendor_default_kind NOT NULL,
    severity public.vendor_default_severity DEFAULT 'medium'::public.vendor_default_severity NOT NULL,
    occurred_on date NOT NULL,
    description text NOT NULL,
    estimated_cost_minor bigint,
    approved_by uuid,
    approved_at timestamp with time zone,
    resolved_on date,
    resolution_note text,
    reported_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.daily_site_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    log_date date NOT NULL,
    weather character varying(100),
    rainfall_mm numeric(8,2),
    hours_lost numeric(5,2),
    labour_count integer DEFAULT 0 NOT NULL,
    labour_by_trade jsonb DEFAULT '{}'::jsonb NOT NULL,
    work_done text,
    issues text,
    visitors text,
    author_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT daily_site_logs_labour_non_negative CHECK ((labour_count >= 0))
);

CREATE TABLE IF NOT EXISTS public.site_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    daily_site_log_id uuid NOT NULL,
    document_id uuid,
    milestone_tag character varying(150) NOT NULL,
    caption text,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- ══════════════════════════════════════════════════════════════════════
-- 3 · PRIMARY KEYS, UNIQUENESS AND CHECKS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ GUARDED BY NAME, NOT BY `IF NOT EXISTS` — `ADD CONSTRAINT` has no
-- such clause. A constraint that is already there is skipped.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_item_master_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_item_master
    ADD CONSTRAINT boq_item_master_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_items
    ADD CONSTRAINT boq_items_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variation_items_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_variation_items
    ADD CONSTRAINT boq_variation_items_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variations_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_variations
    ADD CONSTRAINT boq_variations_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boqs_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.boqs
    ADD CONSTRAINT boqs_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_advances_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.contract_advances
    ADD CONSTRAINT contract_advances_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_site_logs_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.daily_site_logs
    ADD CONSTRAINT daily_site_logs_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'duty_rosters_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.duty_rosters
    ADD CONSTRAINT duty_rosters_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_job_materials_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_job_materials
    ADD CONSTRAINT field_job_materials_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_jobs_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_jobs
    ADD CONSTRAINT field_jobs_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_proofs_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_proofs
    ADD CONSTRAINT field_proofs_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_visits_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'measurement_books_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.measurement_books
    ADD CONSTRAINT measurement_books_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'measurement_entries_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.measurement_entries
    ADD CONSTRAINT measurement_entries_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meter_billing_periods_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.meter_billing_periods
    ADD CONSTRAINT meter_billing_periods_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meter_readings_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.meter_readings
    ADD CONSTRAINT meter_readings_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_rate_entries_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.piece_rate_entries
    ADD CONSTRAINT piece_rate_entries_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_adjustments_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_adjustments
    ADD CONSTRAINT rate_adjustments_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_analyses_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_analyses
    ADD CONSTRAINT rate_analyses_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_analysis_components_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_analysis_components
    ADD CONSTRAINT rate_analysis_components_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_cards_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_cards
    ADD CONSTRAINT rate_cards_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_quotes_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_quotes
    ADD CONSTRAINT rate_quotes_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_slabs_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_slabs
    ADD CONSTRAINT rate_slabs_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retention_ledger_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.retention_ledger
    ADD CONSTRAINT retention_ledger_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_attendance_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_attendance
    ADD CONSTRAINT site_attendance_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_photos_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_photos
    ADD CONSTRAINT site_photos_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_workers_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_workers
    ADD CONSTRAINT site_workers_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'utility_meters_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.utility_meters
    ADD CONSTRAINT utility_meters_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vault_access_log_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.vault_access_log
    ADD CONSTRAINT vault_access_log_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vault_consents_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.vault_consents
    ADD CONSTRAINT vault_consents_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vault_secrets_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.vault_secrets
    ADD CONSTRAINT vault_secrets_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_defaults_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.vendor_defaults
    ADD CONSTRAINT vendor_defaults_pkey PRIMARY KEY (id);';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welfare_logs_pkey') THEN
    EXECUTE 'ALTER TABLE ONLY public.welfare_logs
    ADD CONSTRAINT welfare_logs_pkey PRIMARY KEY (id);';
  END IF;
END $do$;


-- ══════════════════════════════════════════════════════════════════════
-- 4 · INDEXES
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THESE COME BEFORE THE FOREIGN KEYS ON PURPOSE. The composite keys
-- in section 5 reference (id, tenant_id) pairs whose uniqueness is a
-- unique index, and a foreign key cannot be created against a uniqueness
-- that does not exist yet.

CREATE INDEX IF NOT EXISTS boq_item_master_active_idx ON public.boq_item_master USING btree (tenant_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS boq_item_master_code_tenant_unique ON public.boq_item_master USING btree (tenant_id, code);

CREATE UNIQUE INDEX IF NOT EXISTS boq_item_master_id_tenant_key ON public.boq_item_master USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS boq_item_master_tenant_idx ON public.boq_item_master USING btree (tenant_id, category);

CREATE UNIQUE INDEX IF NOT EXISTS boq_items_code_boq_unique ON public.boq_items USING btree (boq_id, item_code);

CREATE UNIQUE INDEX IF NOT EXISTS boq_items_id_tenant_key ON public.boq_items USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS boq_items_master_idx ON public.boq_items USING btree (tenant_id, item_master_id);

CREATE UNIQUE INDEX IF NOT EXISTS boq_items_sequence_boq_unique ON public.boq_items USING btree (boq_id, sequence);

CREATE INDEX IF NOT EXISTS boq_items_tenant_idx ON public.boq_items USING btree (tenant_id, boq_id);

CREATE UNIQUE INDEX IF NOT EXISTS boq_variation_items_id_tenant_key ON public.boq_variation_items USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS boq_variation_items_item_idx ON public.boq_variation_items USING btree (tenant_id, boq_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS boq_variation_items_seq_unique ON public.boq_variation_items USING btree (variation_id, sequence);

CREATE INDEX IF NOT EXISTS boq_variation_items_tenant_idx ON public.boq_variation_items USING btree (tenant_id, variation_id);

CREATE INDEX IF NOT EXISTS boq_variations_boq_idx ON public.boq_variations USING btree (tenant_id, boq_id);

CREATE UNIQUE INDEX IF NOT EXISTS boq_variations_id_tenant_key ON public.boq_variations USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS boq_variations_number_boq_unique ON public.boq_variations USING btree (boq_id, variation_number);

CREATE INDEX IF NOT EXISTS boq_variations_tenant_idx ON public.boq_variations USING btree (tenant_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS boqs_code_version_tenant_unique ON public.boqs USING btree (tenant_id, code, version);

CREATE INDEX IF NOT EXISTS boqs_contractor_idx ON public.boqs USING btree (tenant_id, contractor_vendor_id);

CREATE UNIQUE INDEX IF NOT EXISTS boqs_id_tenant_key ON public.boqs USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS boqs_project_idx ON public.boqs USING btree (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS boqs_tenant_idx ON public.boqs USING btree (tenant_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS contract_advances_id_tenant_key ON public.contract_advances USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS contract_advances_ref_boq_unique ON public.contract_advances USING btree (boq_id, reference);

CREATE INDEX IF NOT EXISTS contract_advances_tenant_idx ON public.contract_advances USING btree (tenant_id, boq_id);

CREATE INDEX IF NOT EXISTS contract_advances_vendor_idx ON public.contract_advances USING btree (tenant_id, contractor_vendor_id);

CREATE INDEX IF NOT EXISTS daily_site_logs_date_idx ON public.daily_site_logs USING btree (tenant_id, log_date);

CREATE UNIQUE INDEX IF NOT EXISTS daily_site_logs_id_tenant_key ON public.daily_site_logs USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS daily_site_logs_id_tenant_unique ON public.daily_site_logs USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS daily_site_logs_slot_unique ON public.daily_site_logs USING btree (project_id, log_date);

CREATE INDEX IF NOT EXISTS daily_site_logs_tenant_idx ON public.daily_site_logs USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS duty_rosters_date_idx ON public.duty_rosters USING btree (tenant_id, roster_date);

CREATE UNIQUE INDEX IF NOT EXISTS duty_rosters_id_tenant_key ON public.duty_rosters USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS duty_rosters_slot_unique ON public.duty_rosters USING btree (user_id, roster_date);

CREATE INDEX IF NOT EXISTS duty_rosters_tenant_idx ON public.duty_rosters USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS field_job_materials_id_tenant_key ON public.field_job_materials USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS field_job_materials_item_idx ON public.field_job_materials USING btree (tenant_id, item_code);

CREATE INDEX IF NOT EXISTS field_job_materials_job_idx ON public.field_job_materials USING btree (tenant_id, job_id);

CREATE INDEX IF NOT EXISTS field_job_materials_tenant_idx ON public.field_job_materials USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS field_jobs_assigned_idx ON public.field_jobs USING btree (tenant_id, assigned_user_id, window_start);

CREATE UNIQUE INDEX IF NOT EXISTS field_jobs_id_tenant_key ON public.field_jobs USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS field_jobs_number_key ON public.field_jobs USING btree (tenant_id, job_number);

CREATE INDEX IF NOT EXISTS field_jobs_status_idx ON public.field_jobs USING btree (tenant_id, status);

CREATE INDEX IF NOT EXISTS field_jobs_tenant_idx ON public.field_jobs USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS field_jobs_window_idx ON public.field_jobs USING btree (tenant_id, window_start);

CREATE UNIQUE INDEX IF NOT EXISTS field_proofs_client_event_key ON public.field_proofs USING btree (tenant_id, client_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS field_proofs_id_tenant_key ON public.field_proofs USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS field_proofs_job_idx ON public.field_proofs USING btree (tenant_id, job_id, kind);

CREATE INDEX IF NOT EXISTS field_proofs_tenant_idx ON public.field_proofs USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS field_proofs_visit_idx ON public.field_proofs USING btree (tenant_id, visit_id);

CREATE UNIQUE INDEX IF NOT EXISTS field_visits_client_event_key ON public.field_visits USING btree (tenant_id, client_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS field_visits_id_tenant_key ON public.field_visits USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS field_visits_job_idx ON public.field_visits USING btree (tenant_id, job_id, sequence);

CREATE INDEX IF NOT EXISTS field_visits_suspicious_idx ON public.field_visits USING btree (tenant_id, is_distance_suspicious);

CREATE INDEX IF NOT EXISTS field_visits_technician_idx ON public.field_visits USING btree (tenant_id, technician_user_id, checked_in_at);

CREATE INDEX IF NOT EXISTS field_visits_tenant_idx ON public.field_visits USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS measurement_books_id_tenant_key ON public.measurement_books USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS measurement_books_number_tenant_unique ON public.measurement_books USING btree (tenant_id, book_number);

CREATE INDEX IF NOT EXISTS measurement_books_project_idx ON public.measurement_books USING btree (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS measurement_books_tenant_idx ON public.measurement_books USING btree (tenant_id, boq_id);

CREATE INDEX IF NOT EXISTS measurement_entries_bill_idx ON public.measurement_entries USING btree (tenant_id, ra_bill_id);

CREATE INDEX IF NOT EXISTS measurement_entries_book_idx ON public.measurement_entries USING btree (tenant_id, measurement_book_id);

CREATE UNIQUE INDEX IF NOT EXISTS measurement_entries_id_tenant_key ON public.measurement_entries USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS measurement_entries_seq_unique ON public.measurement_entries USING btree (measurement_book_id, sequence);

CREATE INDEX IF NOT EXISTS measurement_entries_tenant_idx ON public.measurement_entries USING btree (tenant_id, boq_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS meter_billing_periods_id_tenant_key ON public.meter_billing_periods USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS meter_billing_periods_meter_idx ON public.meter_billing_periods USING btree (tenant_id, meter_id, period_start);

CREATE UNIQUE INDEX IF NOT EXISTS meter_billing_periods_meter_period_key ON public.meter_billing_periods USING btree (meter_id, period_start);

CREATE INDEX IF NOT EXISTS meter_billing_periods_tenant_idx ON public.meter_billing_periods USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS meter_readings_anomaly_idx ON public.meter_readings USING btree (tenant_id, is_anomaly);

CREATE UNIQUE INDEX IF NOT EXISTS meter_readings_id_tenant_key ON public.meter_readings USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS meter_readings_meter_instant_key ON public.meter_readings USING btree (meter_id, read_at);

CREATE INDEX IF NOT EXISTS meter_readings_meter_time_idx ON public.meter_readings USING btree (tenant_id, meter_id, read_at);

CREATE INDEX IF NOT EXISTS meter_readings_tenant_idx ON public.meter_readings USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS piece_rate_entries_billed_idx ON public.piece_rate_entries USING btree (tenant_id, ra_bill_id) WHERE (ra_bill_id IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS piece_rate_entries_id_tenant_key ON public.piece_rate_entries USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS piece_rate_entries_project_idx ON public.piece_rate_entries USING btree (tenant_id, project_id, measured_on);

CREATE INDEX IF NOT EXISTS piece_rate_entries_tenant_idx ON public.piece_rate_entries USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS piece_rate_entries_vendor_idx ON public.piece_rate_entries USING btree (tenant_id, vendor_id);

CREATE INDEX IF NOT EXISTS rate_adjustments_card_idx ON public.rate_adjustments USING btree (tenant_id, rate_card_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS rate_adjustments_id_tenant_key ON public.rate_adjustments USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS rate_adjustments_sequence_key ON public.rate_adjustments USING btree (rate_card_id, sequence);

CREATE INDEX IF NOT EXISTS rate_adjustments_tenant_idx ON public.rate_adjustments USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS rate_analyses_code_tenant_unique ON public.rate_analyses USING btree (tenant_id, code);

CREATE UNIQUE INDEX IF NOT EXISTS rate_analyses_id_tenant_key ON public.rate_analyses USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS rate_analyses_tenant_idx ON public.rate_analyses USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS rate_analysis_components_id_tenant_key ON public.rate_analysis_components USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS rate_analysis_components_seq_unique ON public.rate_analysis_components USING btree (rate_analysis_id, sequence);

CREATE INDEX IF NOT EXISTS rate_analysis_components_tenant_idx ON public.rate_analysis_components USING btree (tenant_id, rate_analysis_id);

CREATE UNIQUE INDEX IF NOT EXISTS rate_cards_code_key ON public.rate_cards USING btree (tenant_id, code);

CREATE INDEX IF NOT EXISTS rate_cards_customer_idx ON public.rate_cards USING btree (tenant_id, customer_company_id);

CREATE UNIQUE INDEX IF NOT EXISTS rate_cards_id_tenant_key ON public.rate_cards USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS rate_cards_lookup_idx ON public.rate_cards USING btree (tenant_id, applies_to_kind, applies_to_id, priority);

CREATE INDEX IF NOT EXISTS rate_cards_tenant_idx ON public.rate_cards USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS rate_quotes_card_idx ON public.rate_quotes USING btree (tenant_id, rate_card_id);

CREATE UNIQUE INDEX IF NOT EXISTS rate_quotes_id_tenant_key ON public.rate_quotes USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS rate_quotes_tenant_idx ON public.rate_quotes USING btree (tenant_id, quoted_at);

CREATE INDEX IF NOT EXISTS rate_slabs_card_idx ON public.rate_slabs USING btree (tenant_id, rate_card_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS rate_slabs_id_tenant_key ON public.rate_slabs USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS rate_slabs_sequence_key ON public.rate_slabs USING btree (rate_card_id, sequence);

CREATE INDEX IF NOT EXISTS rate_slabs_tenant_idx ON public.rate_slabs USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS retention_ledger_bill_idx ON public.retention_ledger USING btree (tenant_id, ra_bill_id);

CREATE UNIQUE INDEX IF NOT EXISTS retention_ledger_hold_once_per_bill ON public.retention_ledger USING btree (ra_bill_id) WHERE (entry_kind = 'held'::public.retention_entry_kind);

CREATE UNIQUE INDEX IF NOT EXISTS retention_ledger_id_tenant_key ON public.retention_ledger USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS retention_ledger_kind_idx ON public.retention_ledger USING btree (tenant_id, boq_id, entry_kind);

CREATE INDEX IF NOT EXISTS retention_ledger_tenant_idx ON public.retention_ledger USING btree (tenant_id, boq_id);

CREATE UNIQUE INDEX IF NOT EXISTS site_attendance_id_tenant_key ON public.site_attendance USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS site_attendance_offline_idx ON public.site_attendance USING btree (tenant_id, occurred_at) WHERE (is_offline = true);

CREATE INDEX IF NOT EXISTS site_attendance_project_idx ON public.site_attendance USING btree (tenant_id, project_id, occurred_at);

CREATE INDEX IF NOT EXISTS site_attendance_tenant_idx ON public.site_attendance USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS site_attendance_user_idx ON public.site_attendance USING btree (tenant_id, user_id, occurred_at);

CREATE INDEX IF NOT EXISTS site_attendance_worker_idx ON public.site_attendance USING btree (tenant_id, worker_id, occurred_at);

CREATE UNIQUE INDEX IF NOT EXISTS site_attendance_worker_punch_key ON public.site_attendance USING btree (tenant_id, worker_id, kind, occurred_at) WHERE (worker_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS site_photos_id_tenant_key ON public.site_photos USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS site_photos_log_idx ON public.site_photos USING btree (tenant_id, daily_site_log_id);

CREATE INDEX IF NOT EXISTS site_photos_tag_idx ON public.site_photos USING btree (tenant_id, milestone_tag);

CREATE INDEX IF NOT EXISTS site_photos_tenant_idx ON public.site_photos USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS site_workers_admissible_idx ON public.site_workers USING btree (tenant_id, project_id, is_admissible);

CREATE UNIQUE INDEX IF NOT EXISTS site_workers_id_tenant_key ON public.site_workers USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS site_workers_id_tenant_unique ON public.site_workers USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS site_workers_project_idx ON public.site_workers USING btree (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS site_workers_tenant_idx ON public.site_workers USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS site_workers_uan_status_idx ON public.site_workers USING btree (tenant_id, uan_status);

CREATE UNIQUE INDEX IF NOT EXISTS site_workers_uan_unique ON public.site_workers USING btree (tenant_id, uan) WHERE (uan IS NOT NULL);

CREATE INDEX IF NOT EXISTS site_workers_vendor_idx ON public.site_workers USING btree (tenant_id, vendor_id);

CREATE INDEX IF NOT EXISTS utility_meters_consumer_idx ON public.utility_meters USING btree (tenant_id, consumer_contact_id);

CREATE UNIQUE INDEX IF NOT EXISTS utility_meters_id_tenant_key ON public.utility_meters USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS utility_meters_serial_key ON public.utility_meters USING btree (tenant_id, serial_number);

CREATE INDEX IF NOT EXISTS utility_meters_status_idx ON public.utility_meters USING btree (tenant_id, status);

CREATE INDEX IF NOT EXISTS utility_meters_tenant_idx ON public.utility_meters USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS vault_access_log_id_tenant_key ON public.vault_access_log USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS vault_access_log_purpose_idx ON public.vault_access_log USING btree (tenant_id, purpose, accessed_at);

CREATE INDEX IF NOT EXISTS vault_access_log_secret_idx ON public.vault_access_log USING btree (tenant_id, secret_id);

CREATE INDEX IF NOT EXISTS vault_access_log_tenant_idx ON public.vault_access_log USING btree (tenant_id, accessed_at);

CREATE INDEX IF NOT EXISTS vault_access_log_user_idx ON public.vault_access_log USING btree (tenant_id, user_id, accessed_at);

CREATE UNIQUE INDEX IF NOT EXISTS vault_consents_id_tenant_key ON public.vault_consents USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS vault_consents_purpose_idx ON public.vault_consents USING btree (tenant_id, purpose);

CREATE INDEX IF NOT EXISTS vault_consents_subject_idx ON public.vault_consents USING btree (tenant_id, subject_kind, subject_id);

CREATE INDEX IF NOT EXISTS vault_consents_tenant_idx ON public.vault_consents USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS vault_secrets_blind_idx ON public.vault_secrets USING btree (tenant_id, blind_index);

CREATE UNIQUE INDEX IF NOT EXISTS vault_secrets_id_tenant_key ON public.vault_secrets USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS vault_secrets_kind_idx ON public.vault_secrets USING btree (tenant_id, kind, status);

CREATE INDEX IF NOT EXISTS vault_secrets_owner_idx ON public.vault_secrets USING btree (tenant_id, owner_kind, owner_id);

CREATE UNIQUE INDEX IF NOT EXISTS vault_secrets_owner_kind_active_key ON public.vault_secrets USING btree (tenant_id, owner_kind, owner_id, kind, blind_index) WHERE (status = 'active'::public.vault_status);

CREATE INDEX IF NOT EXISTS vault_secrets_retention_idx ON public.vault_secrets USING btree (retain_until);

CREATE INDEX IF NOT EXISTS vault_secrets_tenant_idx ON public.vault_secrets USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS vendor_defaults_id_tenant_key ON public.vendor_defaults USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS vendor_defaults_open_idx ON public.vendor_defaults USING btree (tenant_id, vendor_id) WHERE (resolved_on IS NULL);

CREATE INDEX IF NOT EXISTS vendor_defaults_severity_idx ON public.vendor_defaults USING btree (tenant_id, severity);

CREATE INDEX IF NOT EXISTS vendor_defaults_tenant_idx ON public.vendor_defaults USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS vendor_defaults_vendor_idx ON public.vendor_defaults USING btree (tenant_id, vendor_id);

CREATE INDEX IF NOT EXISTS welfare_logs_category_idx ON public.welfare_logs USING btree (tenant_id, category);

CREATE UNIQUE INDEX IF NOT EXISTS welfare_logs_id_tenant_key ON public.welfare_logs USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS welfare_logs_project_date_idx ON public.welfare_logs USING btree (tenant_id, project_id, logged_on);

CREATE INDEX IF NOT EXISTS welfare_logs_tenant_idx ON public.welfare_logs USING btree (tenant_id);


-- ══════════════════════════════════════════════════════════════════════
-- 5 · FOREIGN KEYS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ (child_id, tenant_id) → (id, tenant_id) WHEREVER BOTH SIDES ARE
-- TENANT-SCOPED. A plain key on the id alone would let a row in one
-- workspace point at a parent in another — the parent is then hidden by
-- row-level security while the child stays visible, and the result is a
-- figure computed from a record the reader cannot see.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_item_master_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_item_master
    ADD CONSTRAINT boq_item_master_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_boq_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_items
    ADD CONSTRAINT boq_items_boq_id_tenant_fk FOREIGN KEY (boq_id, tenant_id) REFERENCES public.boqs(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_item_master_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_items
    ADD CONSTRAINT boq_items_item_master_id_tenant_fk FOREIGN KEY (item_master_id, tenant_id) REFERENCES public.boq_item_master(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_rate_analysis_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_items
    ADD CONSTRAINT boq_items_rate_analysis_id_tenant_fk FOREIGN KEY (rate_analysis_id, tenant_id) REFERENCES public.rate_analyses(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_items
    ADD CONSTRAINT boq_items_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variation_items_boq_item_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_variation_items
    ADD CONSTRAINT boq_variation_items_boq_item_id_tenant_fk FOREIGN KEY (boq_item_id, tenant_id) REFERENCES public.boq_items(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variation_items_rate_analysis_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_variation_items
    ADD CONSTRAINT boq_variation_items_rate_analysis_id_tenant_fk FOREIGN KEY (rate_analysis_id, tenant_id) REFERENCES public.rate_analyses(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variation_items_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_variation_items
    ADD CONSTRAINT boq_variation_items_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variation_items_variation_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_variation_items
    ADD CONSTRAINT boq_variation_items_variation_id_tenant_fk FOREIGN KEY (variation_id, tenant_id) REFERENCES public.boq_variations(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variations_boq_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_variations
    ADD CONSTRAINT boq_variations_boq_id_tenant_fk FOREIGN KEY (boq_id, tenant_id) REFERENCES public.boqs(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variations_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boq_variations
    ADD CONSTRAINT boq_variations_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boqs_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.boqs
    ADD CONSTRAINT boqs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_advances_boq_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.contract_advances
    ADD CONSTRAINT contract_advances_boq_id_tenant_fk FOREIGN KEY (boq_id, tenant_id) REFERENCES public.boqs(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_advances_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.contract_advances
    ADD CONSTRAINT contract_advances_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_site_logs_author_id_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.daily_site_logs
    ADD CONSTRAINT daily_site_logs_author_id_users_id_fk FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_site_logs_project_id_projects_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.daily_site_logs
    ADD CONSTRAINT daily_site_logs_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_site_logs_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.daily_site_logs
    ADD CONSTRAINT daily_site_logs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'duty_rosters_created_by_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.duty_rosters
    ADD CONSTRAINT duty_rosters_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'duty_rosters_project_id_projects_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.duty_rosters
    ADD CONSTRAINT duty_rosters_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'duty_rosters_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.duty_rosters
    ADD CONSTRAINT duty_rosters_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'duty_rosters_user_id_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.duty_rosters
    ADD CONSTRAINT duty_rosters_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_job_materials_job_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_job_materials
    ADD CONSTRAINT field_job_materials_job_tenant_fk FOREIGN KEY (job_id, tenant_id) REFERENCES public.field_jobs(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_job_materials_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_job_materials
    ADD CONSTRAINT field_job_materials_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_job_materials_visit_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_job_materials
    ADD CONSTRAINT field_job_materials_visit_tenant_fk FOREIGN KEY (visit_id, tenant_id) REFERENCES public.field_visits(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_jobs_assigned_user_id_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_jobs
    ADD CONSTRAINT field_jobs_assigned_user_id_users_id_fk FOREIGN KEY (assigned_user_id) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_jobs_customer_company_id_companies_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_jobs
    ADD CONSTRAINT field_jobs_customer_company_id_companies_id_fk FOREIGN KEY (customer_company_id) REFERENCES public.companies(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_jobs_customer_contact_id_contacts_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_jobs
    ADD CONSTRAINT field_jobs_customer_contact_id_contacts_id_fk FOREIGN KEY (customer_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_jobs_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_jobs
    ADD CONSTRAINT field_jobs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_proofs_job_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_proofs
    ADD CONSTRAINT field_proofs_job_tenant_fk FOREIGN KEY (job_id, tenant_id) REFERENCES public.field_jobs(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_proofs_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_proofs
    ADD CONSTRAINT field_proofs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_proofs_visit_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_proofs
    ADD CONSTRAINT field_proofs_visit_tenant_fk FOREIGN KEY (visit_id, tenant_id) REFERENCES public.field_visits(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_visits_job_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_job_tenant_fk FOREIGN KEY (job_id, tenant_id) REFERENCES public.field_jobs(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_visits_technician_user_id_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_technician_user_id_users_id_fk FOREIGN KEY (technician_user_id) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_visits_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.field_visits
    ADD CONSTRAINT field_visits_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'measurement_books_boq_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.measurement_books
    ADD CONSTRAINT measurement_books_boq_id_tenant_fk FOREIGN KEY (boq_id, tenant_id) REFERENCES public.boqs(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'measurement_books_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.measurement_books
    ADD CONSTRAINT measurement_books_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'measurement_entries_boq_item_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.measurement_entries
    ADD CONSTRAINT measurement_entries_boq_item_id_tenant_fk FOREIGN KEY (boq_item_id, tenant_id) REFERENCES public.boq_items(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'measurement_entries_measurement_book_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.measurement_entries
    ADD CONSTRAINT measurement_entries_measurement_book_id_tenant_fk FOREIGN KEY (measurement_book_id, tenant_id) REFERENCES public.measurement_books(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'measurement_entries_ra_bill_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.measurement_entries
    ADD CONSTRAINT measurement_entries_ra_bill_id_tenant_fk FOREIGN KEY (ra_bill_id, tenant_id) REFERENCES public.ra_bills(id, tenant_id) ON DELETE RESTRICT;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'measurement_entries_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.measurement_entries
    ADD CONSTRAINT measurement_entries_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meter_billing_periods_meter_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.meter_billing_periods
    ADD CONSTRAINT meter_billing_periods_meter_tenant_fk FOREIGN KEY (meter_id, tenant_id) REFERENCES public.utility_meters(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meter_billing_periods_rate_card_id_rate_cards_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.meter_billing_periods
    ADD CONSTRAINT meter_billing_periods_rate_card_id_rate_cards_id_fk FOREIGN KEY (rate_card_id) REFERENCES public.rate_cards(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meter_billing_periods_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.meter_billing_periods
    ADD CONSTRAINT meter_billing_periods_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meter_readings_meter_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.meter_readings
    ADD CONSTRAINT meter_readings_meter_tenant_fk FOREIGN KEY (meter_id, tenant_id) REFERENCES public.utility_meters(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meter_readings_previous_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.meter_readings
    ADD CONSTRAINT meter_readings_previous_tenant_fk FOREIGN KEY (previous_reading_id, tenant_id) REFERENCES public.meter_readings(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meter_readings_read_by_user_id_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.meter_readings
    ADD CONSTRAINT meter_readings_read_by_user_id_users_id_fk FOREIGN KEY (read_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meter_readings_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.meter_readings
    ADD CONSTRAINT meter_readings_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_rate_entries_created_by_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.piece_rate_entries
    ADD CONSTRAINT piece_rate_entries_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_rate_entries_measured_by_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.piece_rate_entries
    ADD CONSTRAINT piece_rate_entries_measured_by_users_id_fk FOREIGN KEY (measured_by) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_rate_entries_project_id_projects_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.piece_rate_entries
    ADD CONSTRAINT piece_rate_entries_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_rate_entries_ra_bill_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.piece_rate_entries
    ADD CONSTRAINT piece_rate_entries_ra_bill_id_tenant_fk FOREIGN KEY (ra_bill_id, tenant_id) REFERENCES public.ra_bills(id, tenant_id) ON DELETE RESTRICT;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_rate_entries_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.piece_rate_entries
    ADD CONSTRAINT piece_rate_entries_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_rate_entries_vendor_id_vendors_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.piece_rate_entries
    ADD CONSTRAINT piece_rate_entries_vendor_id_vendors_id_fk FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_adjustments_card_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_adjustments
    ADD CONSTRAINT rate_adjustments_card_tenant_fk FOREIGN KEY (rate_card_id, tenant_id) REFERENCES public.rate_cards(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_adjustments_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_adjustments
    ADD CONSTRAINT rate_adjustments_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_analyses_item_master_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_analyses
    ADD CONSTRAINT rate_analyses_item_master_id_tenant_fk FOREIGN KEY (item_master_id, tenant_id) REFERENCES public.boq_item_master(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_analyses_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_analyses
    ADD CONSTRAINT rate_analyses_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_analysis_components_rate_analysis_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_analysis_components
    ADD CONSTRAINT rate_analysis_components_rate_analysis_id_tenant_fk FOREIGN KEY (rate_analysis_id, tenant_id) REFERENCES public.rate_analyses(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_analysis_components_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_analysis_components
    ADD CONSTRAINT rate_analysis_components_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_cards_customer_company_id_companies_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_cards
    ADD CONSTRAINT rate_cards_customer_company_id_companies_id_fk FOREIGN KEY (customer_company_id) REFERENCES public.companies(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_cards_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_cards
    ADD CONSTRAINT rate_cards_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_quotes_card_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_quotes
    ADD CONSTRAINT rate_quotes_card_tenant_fk FOREIGN KEY (rate_card_id, tenant_id) REFERENCES public.rate_cards(id, tenant_id) ON DELETE RESTRICT;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_quotes_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_quotes
    ADD CONSTRAINT rate_quotes_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_slabs_card_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_slabs
    ADD CONSTRAINT rate_slabs_card_tenant_fk FOREIGN KEY (rate_card_id, tenant_id) REFERENCES public.rate_cards(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_slabs_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.rate_slabs
    ADD CONSTRAINT rate_slabs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retention_ledger_boq_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.retention_ledger
    ADD CONSTRAINT retention_ledger_boq_id_tenant_fk FOREIGN KEY (boq_id, tenant_id) REFERENCES public.boqs(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retention_ledger_ra_bill_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.retention_ledger
    ADD CONSTRAINT retention_ledger_ra_bill_id_tenant_fk FOREIGN KEY (ra_bill_id, tenant_id) REFERENCES public.ra_bills(id, tenant_id) ON DELETE RESTRICT;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retention_ledger_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.retention_ledger
    ADD CONSTRAINT retention_ledger_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_attendance_project_id_projects_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_attendance
    ADD CONSTRAINT site_attendance_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_attendance_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_attendance
    ADD CONSTRAINT site_attendance_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_attendance_user_id_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_attendance
    ADD CONSTRAINT site_attendance_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_attendance_worker_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_attendance
    ADD CONSTRAINT site_attendance_worker_id_tenant_fk FOREIGN KEY (worker_id, tenant_id) REFERENCES public.site_workers(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_photos_daily_site_log_id_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_photos
    ADD CONSTRAINT site_photos_daily_site_log_id_tenant_fk FOREIGN KEY (daily_site_log_id, tenant_id) REFERENCES public.daily_site_logs(id, tenant_id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_photos_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_photos
    ADD CONSTRAINT site_photos_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_workers_created_by_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_workers
    ADD CONSTRAINT site_workers_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_workers_project_id_projects_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_workers
    ADD CONSTRAINT site_workers_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_workers_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_workers
    ADD CONSTRAINT site_workers_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_workers_uan_verified_by_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_workers
    ADD CONSTRAINT site_workers_uan_verified_by_users_id_fk FOREIGN KEY (uan_verified_by) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_workers_vendor_id_vendors_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.site_workers
    ADD CONSTRAINT site_workers_vendor_id_vendors_id_fk FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'utility_meters_consumer_contact_id_contacts_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.utility_meters
    ADD CONSTRAINT utility_meters_consumer_contact_id_contacts_id_fk FOREIGN KEY (consumer_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'utility_meters_rate_card_id_rate_cards_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.utility_meters
    ADD CONSTRAINT utility_meters_rate_card_id_rate_cards_id_fk FOREIGN KEY (rate_card_id) REFERENCES public.rate_cards(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'utility_meters_replaces_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.utility_meters
    ADD CONSTRAINT utility_meters_replaces_tenant_fk FOREIGN KEY (replaces_meter_id, tenant_id) REFERENCES public.utility_meters(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'utility_meters_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.utility_meters
    ADD CONSTRAINT utility_meters_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vault_access_log_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vault_access_log
    ADD CONSTRAINT vault_access_log_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vault_access_log_user_id_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vault_access_log
    ADD CONSTRAINT vault_access_log_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vault_consents_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vault_consents
    ADD CONSTRAINT vault_consents_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vault_secrets_created_by_user_id_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vault_secrets
    ADD CONSTRAINT vault_secrets_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vault_secrets_supersedes_tenant_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vault_secrets
    ADD CONSTRAINT vault_secrets_supersedes_tenant_fk FOREIGN KEY (supersedes_id, tenant_id) REFERENCES public.vault_secrets(id, tenant_id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vault_secrets_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vault_secrets
    ADD CONSTRAINT vault_secrets_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_defaults_approved_by_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vendor_defaults
    ADD CONSTRAINT vendor_defaults_approved_by_users_id_fk FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_defaults_project_id_projects_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vendor_defaults
    ADD CONSTRAINT vendor_defaults_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_defaults_reported_by_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vendor_defaults
    ADD CONSTRAINT vendor_defaults_reported_by_users_id_fk FOREIGN KEY (reported_by) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_defaults_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vendor_defaults
    ADD CONSTRAINT vendor_defaults_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_defaults_vendor_id_vendors_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.vendor_defaults
    ADD CONSTRAINT vendor_defaults_vendor_id_vendors_id_fk FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welfare_logs_logged_by_users_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.welfare_logs
    ADD CONSTRAINT welfare_logs_logged_by_users_id_fk FOREIGN KEY (logged_by) REFERENCES public.users(id) ON DELETE SET NULL;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welfare_logs_project_id_projects_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.welfare_logs
    ADD CONSTRAINT welfare_logs_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;';
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welfare_logs_tenant_id_tenants_id_fk') THEN
    EXECUTE 'ALTER TABLE ONLY public.welfare_logs
    ADD CONSTRAINT welfare_logs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;';
  END IF;
END $do$;


-- ══════════════════════════════════════════════════════════════════════
-- 6 · DONE
-- ══════════════════════════════════════════════════════════════════════
--
-- The tables now exist but are NOT yet protected — no row-level
-- security, no cross-tenant guards, no triggers. That is what files 21
-- to 25 add, and they should be run straight after this one.

COMMIT;
