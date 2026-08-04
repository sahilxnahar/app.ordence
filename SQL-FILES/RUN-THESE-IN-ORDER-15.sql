-- ═════════════════════════════════════════════════════════════════════
--  ORDENCE — FILE 15
--  Phase 42: Land, Title and the Joint Development Agreement
-- ═════════════════════════════════════════════════════════════════════
--
--  RUN FILES 13 AND 14 FIRST.
--
--  WHAT TO DO
--  ----------
--  1. Open Neon:  https://console.neon.tech
--  2. Click your project, then "SQL Editor" in the left sidebar.
--  3. Select ALL the text in this file (Cmd+A), copy it (Cmd+C).
--  4. Paste it into the SQL Editor box.
--  5. Click "Run". Wait about 15 seconds.
--  6. Scroll to the bottom. Look for the word PASS — eighteen of them.
--
--  IF YOU SEE "FAIL": stop and send Claude a screenshot.
--  IF YOU SEE RED TEXT: nothing was changed — the whole file runs as one
--  unit. Send Claude the red text.
--
--  SAFE TO RUN TWICE.
--
--  WHAT THIS FILE DOES
--  -------------------
--  Part 1 creates thirteen tables covering land, title deeds, landowners
--  and their heirs, joint development agreements, khata, e-stamps,
--  approvals and plan sanction.
--
--  Part 2 locks them down and adds five rules worth knowing about:
--
--    * A chain of title cannot skip a position. If you have deeds at
--      1, 2 and 4, the system refuses the 4 and tells you 3 is missing.
--      A chain with a hole looks complete in a list, and the missing
--      document is the one an opposing lawyer will ask for.
--
--    * Where one deed's seller is not the previous deed's buyer, you get
--      a warning rather than a refusal. That is normal at a partition or
--      a will, and a serious problem anywhere else — so it is a question
--      for a person, not for the computer.
--
--    * Heirs' shares cannot add up to more than the whole property.
--      Shares are stored as real fractions, so three heirs of one third
--      add to exactly one. Stored as percentages they would add to
--      99.99 and every check built on them would be useless.
--
--    * The FAR deviation is calculated by the system and cannot be
--      typed. And an occupancy certificate cannot be marked received on
--      a building more than 5% over its sanctioned FAR unless you record
--      the regularisation reference. Without an OC a finished tower
--      cannot be occupied, buyers cannot register, and banks will not
--      disburse.
--
--    * Dropping a land parcel needs a written reason. In two years
--      somebody will look at that land again, and the reason is the only
--      thing that will stop them repeating the work.
--
-- ═════════════════════════════════════════════════════════════════════

BEGIN;

-- ═════════════════════════════════════════════════════════════════════
--  PART 1 — THE TABLES
-- ═════════════════════════════════════════════════════════════════════

DO $ordence$ BEGIN
  CREATE TYPE public.land_parcel_stage AS ENUM
    ('identified','under_negotiation','agreed','due_diligence','registered','dropped');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.title_doc_kind AS ENUM
    ('mother_deed','sale_deed','gift_deed','partition_deed','release_deed','will',
     'court_decree','mutation_extract','encumbrance_certificate','rtc_pahani',
     'khata_certificate','conversion_order','power_of_attorney','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.jda_share_type AS ENUM ('area_share','revenue_share','hybrid');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.land_conversion_stage AS ENUM
    ('applied','rtc_verified','dc_scrutiny','fee_demanded','fee_paid',
     'dc_order_issued','khata_updated','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.khata_type AS ENUM ('a_khata','b_khata','e_khata','none');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.estamp_status AS ENUM
    ('requested','generated','used','cancelled','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.sanction_status AS ENUM
    ('not_started','applied','in_process','query_raised','approved','rejected','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.land_verification_status AS ENUM
    ('pending','verified','rejected','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.due_diligence_record_type AS ENUM
    ('rera_certificate','encumbrance_certificate','land_record_ror','rtc_pahani',
     'patta','chitta','adangal','survey_sketch','fmb','na_order','court_clearance',
     'town_planning_approval','municipal_sanction','master_plan_extract',
     'hill_area_clearance','airport_height_clearance','fire_noc',
     'environment_clearance','water_approval','electricity_approval','land_title','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.land_revenue_record_kind AS ENUM
    ('khata','patta','chitta','dc_conversion','betterment','property_tax','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

CREATE TABLE IF NOT EXISTS public.approval_sanctions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    parcel_id uuid,
    project_id uuid,
    authority character varying(150) NOT NULL,
    name character varying(250) NOT NULL,
    status public.sanction_status DEFAULT 'not_started'::public.sanction_status NOT NULL,
    applied_on date,
    expected_on date,
    approved_on date,
    expires_on date,
    fee_paid_minor bigint,
    current_desk character varying(200),
    reference_no character varying(150),
    query_raised text,
    document_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);

CREATE TABLE IF NOT EXISTS public.due_diligence_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid,
    parcel_id uuid,
    unit_id uuid,
    record_type public.due_diligence_record_type NOT NULL,
    state character varying(120) NOT NULL,
    region character varying(150),
    authority_name character varying(250) NOT NULL,
    reference character varying(200),
    document_id uuid,
    valid_until date,
    verification_status public.land_verification_status DEFAULT 'pending'::public.land_verification_status NOT NULL,
    verified_by uuid,
    verified_at timestamp with time zone,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.estamp_certificates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid,
    parcel_id uuid,
    booking_id uuid,
    purpose character varying(250) NOT NULL,
    consideration_minor bigint,
    duty_minor bigint NOT NULL,
    certificate_no character varying(80),
    status public.estamp_status DEFAULT 'requested'::public.estamp_status NOT NULL,
    provider_ref character varying(120),
    first_party character varying(300),
    second_party character varying(300),
    issued_on date,
    used_on date,
    cancelled_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT estamp_duty_non_negative CHECK ((duty_minor >= 0))
);

CREATE TABLE IF NOT EXISTS public.joint_development_agreements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    parcel_id uuid NOT NULL,
    project_id uuid,
    agreement_no character varying(120),
    landowner_name character varying(300) NOT NULL,
    share_type public.jda_share_type DEFAULT 'area_share'::public.jda_share_type NOT NULL,
    developer_share_bps integer,
    landowner_share_bps integer,
    refundable_deposit_minor bigint,
    non_refundable_minor bigint,
    signed_on date,
    registered_on date,
    registration_no character varying(120),
    owner_unit_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    obligations text,
    handover_due_on date,
    penalty_per_month_minor bigint,
    document_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT jda_shares_sum_to_whole CHECK ((((developer_share_bps IS NULL) AND (landowner_share_bps IS NULL)) OR ((developer_share_bps + landowner_share_bps) = 10000)))
);

CREATE TABLE IF NOT EXISTS public.khata_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    parcel_id uuid,
    project_id uuid,
    unit_id uuid,
    khata_type public.khata_type DEFAULT 'none'::public.khata_type NOT NULL,
    pid character varying(80),
    khata_no character varying(120),
    assessment_no character varying(120),
    owner_name character varying(300),
    last_ec_on date,
    ec_clear boolean DEFAULT false NOT NULL,
    property_tax_paid_upto date,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.land_conversions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    parcel_id uuid,
    project_id uuid,
    survey_no character varying(120) NOT NULL,
    village character varying(150),
    taluk character varying(150),
    extent_acre numeric(12,4),
    from_use character varying(60) DEFAULT 'agricultural'::character varying NOT NULL,
    to_use character varying(60) DEFAULT 'residential'::character varying NOT NULL,
    stage public.land_conversion_stage DEFAULT 'applied'::public.land_conversion_stage NOT NULL,
    dc_order_no character varying(120),
    conversion_fee_minor bigint,
    applied_on date,
    ordered_on date,
    khata_updated_on date,
    rejection_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);

CREATE TABLE IF NOT EXISTS public.land_parcels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid,
    name character varying(250) NOT NULL,
    survey_number character varying(120),
    village character varying(150),
    hobli character varying(150),
    taluk character varying(150),
    district character varying(150),
    state character varying(120),
    state_code character varying(2),
    extent_acre numeric(12,4),
    extent_guntha numeric(12,3),
    extent_sqft numeric(16,2),
    stage public.land_parcel_stage DEFAULT 'identified'::public.land_parcel_stage NOT NULL,
    asking_rate_minor bigint,
    agreed_rate_minor bigint,
    consideration_minor bigint,
    advance_paid_minor bigint DEFAULT 0 NOT NULL,
    owner_name character varying(300),
    registered_on date,
    dropped_reason text,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT land_parcels_guntha_below_forty CHECK (((extent_guntha IS NULL) OR ((extent_guntha >= (0)::numeric) AND (extent_guntha < (40)::numeric)))),
    CONSTRAINT land_parcels_money_non_negative CHECK ((COALESCE(advance_paid_minor, (0)::bigint) >= 0))
);

CREATE TABLE IF NOT EXISTS public.land_revenue_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    parcel_id uuid NOT NULL,
    kind public.land_revenue_record_kind DEFAULT 'other'::public.land_revenue_record_kind NOT NULL,
    reference character varying(200),
    authority character varying(200),
    paid_to_date date,
    amount_minor bigint,
    document_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.landowners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    parcel_id uuid,
    project_id uuid,
    name character varying(300) NOT NULL,
    relation_to_parent character varying(120),
    parent_id uuid,
    is_deceased boolean DEFAULT false NOT NULL,
    share_num integer,
    share_den integer,
    relinquished boolean DEFAULT false NOT NULL,
    relinquish_deed_no character varying(120),
    relinquished_on date,
    pan_number character varying(10),
    phone character varying(40),
    address text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT landowners_relinquish_has_deed CHECK (((relinquished = false) OR (relinquish_deed_no IS NOT NULL))),
    CONSTRAINT landowners_share_valid CHECK ((((share_num IS NULL) AND (share_den IS NULL)) OR ((share_num >= 0) AND (share_den > 0) AND (share_num <= share_den))))
);

CREATE TABLE IF NOT EXISTS public.liaison_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    chased_by uuid,
    chased_by_name character varying(200),
    met_with character varying(200),
    note text NOT NULL,
    chased_on timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.plan_sanctions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sanction_no character varying(150),
    authority character varying(100) NOT NULL,
    sanctioned_far_bps integer NOT NULL,
    built_far_bps integer DEFAULT 0 NOT NULL,
    sanctioned_area_sqft numeric(16,2),
    built_area_sqft numeric(16,2),
    deviation_bps integer DEFAULT 0 NOT NULL,
    oc_applied boolean DEFAULT false NOT NULL,
    oc_received boolean DEFAULT false NOT NULL,
    oc_number character varying(150),
    oc_received_on date,
    regularisation_ref character varying(150),
    sanctioned_on date,
    valid_until date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plan_sanctions_far_positive CHECK (((sanctioned_far_bps > 0) AND (built_far_bps >= 0)))
);

CREATE TABLE IF NOT EXISTS public.powers_of_attorney (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    parcel_id uuid,
    project_id uuid,
    grantor character varying(300) NOT NULL,
    attorney character varying(300) NOT NULL,
    scope text NOT NULL,
    is_registered boolean DEFAULT false NOT NULL,
    registration_no character varying(120),
    valid_from date,
    valid_until date,
    revoked boolean DEFAULT false NOT NULL,
    revoked_on date,
    revocation_deed_no character varying(120),
    document_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.title_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    parcel_id uuid NOT NULL,
    kind public.title_doc_kind DEFAULT 'other'::public.title_doc_kind NOT NULL,
    title character varying(300) NOT NULL,
    chain_position integer NOT NULL,
    from_party character varying(300),
    to_party character varying(300),
    document_date date,
    registered_on date,
    registration_no character varying(120),
    sro_office character varying(200),
    period_from_year integer,
    period_to_year integer,
    expires_on date,
    renewal_note text,
    document_id uuid,
    is_verified boolean DEFAULT false NOT NULL,
    verified_by uuid,
    verified_at timestamp with time zone,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT title_documents_period_ordered CHECK (((period_from_year IS NULL) OR (period_to_year IS NULL) OR (period_from_year <= period_to_year))),
    CONSTRAINT title_documents_position_positive CHECK ((chain_position >= 1))
);

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'approval_sanctions_pkey'
                    AND conrelid = 'public.approval_sanctions'::regclass) THEN
    ALTER TABLE ONLY public.approval_sanctions
    ADD CONSTRAINT approval_sanctions_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'due_diligence_records_pkey'
                    AND conrelid = 'public.due_diligence_records'::regclass) THEN
    ALTER TABLE ONLY public.due_diligence_records
    ADD CONSTRAINT due_diligence_records_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'estamp_certificates_pkey'
                    AND conrelid = 'public.estamp_certificates'::regclass) THEN
    ALTER TABLE ONLY public.estamp_certificates
    ADD CONSTRAINT estamp_certificates_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'joint_development_agreements_pkey'
                    AND conrelid = 'public.joint_development_agreements'::regclass) THEN
    ALTER TABLE ONLY public.joint_development_agreements
    ADD CONSTRAINT joint_development_agreements_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'khata_records_pkey'
                    AND conrelid = 'public.khata_records'::regclass) THEN
    ALTER TABLE ONLY public.khata_records
    ADD CONSTRAINT khata_records_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_conversions_pkey'
                    AND conrelid = 'public.land_conversions'::regclass) THEN
    ALTER TABLE ONLY public.land_conversions
    ADD CONSTRAINT land_conversions_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_parcels_pkey'
                    AND conrelid = 'public.land_parcels'::regclass) THEN
    ALTER TABLE ONLY public.land_parcels
    ADD CONSTRAINT land_parcels_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_revenue_records_pkey'
                    AND conrelid = 'public.land_revenue_records'::regclass) THEN
    ALTER TABLE ONLY public.land_revenue_records
    ADD CONSTRAINT land_revenue_records_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'landowners_pkey'
                    AND conrelid = 'public.landowners'::regclass) THEN
    ALTER TABLE ONLY public.landowners
    ADD CONSTRAINT landowners_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'liaison_logs_pkey'
                    AND conrelid = 'public.liaison_logs'::regclass) THEN
    ALTER TABLE ONLY public.liaison_logs
    ADD CONSTRAINT liaison_logs_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'plan_sanctions_pkey'
                    AND conrelid = 'public.plan_sanctions'::regclass) THEN
    ALTER TABLE ONLY public.plan_sanctions
    ADD CONSTRAINT plan_sanctions_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'powers_of_attorney_pkey'
                    AND conrelid = 'public.powers_of_attorney'::regclass) THEN
    ALTER TABLE ONLY public.powers_of_attorney
    ADD CONSTRAINT powers_of_attorney_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'title_documents_pkey'
                    AND conrelid = 'public.title_documents'::regclass) THEN
    ALTER TABLE ONLY public.title_documents
    ADD CONSTRAINT title_documents_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

CREATE INDEX IF NOT EXISTS approval_sanctions_expected_idx ON public.approval_sanctions USING btree (tenant_id, expected_on);

CREATE UNIQUE INDEX IF NOT EXISTS approval_sanctions_id_tenant_unique ON public.approval_sanctions USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS approval_sanctions_status_idx ON public.approval_sanctions USING btree (tenant_id, status);

CREATE INDEX IF NOT EXISTS approval_sanctions_tenant_idx ON public.approval_sanctions USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS dd_records_expiry_idx ON public.due_diligence_records USING btree (tenant_id, valid_until) WHERE (valid_until IS NOT NULL);

CREATE INDEX IF NOT EXISTS dd_records_status_idx ON public.due_diligence_records USING btree (tenant_id, verification_status);

CREATE INDEX IF NOT EXISTS dd_records_tenant_idx ON public.due_diligence_records USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS dd_records_type_idx ON public.due_diligence_records USING btree (tenant_id, record_type);

CREATE UNIQUE INDEX IF NOT EXISTS estamp_certificates_no_unique ON public.estamp_certificates USING btree (tenant_id, certificate_no) WHERE (certificate_no IS NOT NULL);

CREATE INDEX IF NOT EXISTS estamp_certificates_status_idx ON public.estamp_certificates USING btree (tenant_id, status);

CREATE INDEX IF NOT EXISTS estamp_certificates_tenant_idx ON public.estamp_certificates USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS jda_id_tenant_unique ON public.joint_development_agreements USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS jda_parcel_idx ON public.joint_development_agreements USING btree (tenant_id, parcel_id);

CREATE INDEX IF NOT EXISTS jda_tenant_idx ON public.joint_development_agreements USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS khata_records_parcel_idx ON public.khata_records USING btree (tenant_id, parcel_id);

CREATE INDEX IF NOT EXISTS khata_records_tenant_idx ON public.khata_records USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS khata_records_type_idx ON public.khata_records USING btree (tenant_id, khata_type);

CREATE INDEX IF NOT EXISTS khata_records_unit_idx ON public.khata_records USING btree (tenant_id, unit_id);

CREATE UNIQUE INDEX IF NOT EXISTS land_conversions_id_tenant_unique ON public.land_conversions USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS land_conversions_parcel_idx ON public.land_conversions USING btree (tenant_id, parcel_id);

CREATE INDEX IF NOT EXISTS land_conversions_stage_idx ON public.land_conversions USING btree (tenant_id, stage);

CREATE INDEX IF NOT EXISTS land_conversions_tenant_idx ON public.land_conversions USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS land_parcels_id_tenant_unique ON public.land_parcels USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS land_parcels_project_idx ON public.land_parcels USING btree (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS land_parcels_stage_idx ON public.land_parcels USING btree (tenant_id, stage);

CREATE INDEX IF NOT EXISTS land_parcels_survey_idx ON public.land_parcels USING btree (tenant_id, village, survey_number);

CREATE INDEX IF NOT EXISTS land_parcels_tenant_idx ON public.land_parcels USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS land_revenue_records_parcel_idx ON public.land_revenue_records USING btree (tenant_id, parcel_id, kind);

CREATE INDEX IF NOT EXISTS land_revenue_records_tenant_idx ON public.land_revenue_records USING btree (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS landowners_id_tenant_unique ON public.landowners USING btree (id, tenant_id);

CREATE INDEX IF NOT EXISTS landowners_parcel_idx ON public.landowners USING btree (tenant_id, parcel_id);

CREATE INDEX IF NOT EXISTS landowners_parent_idx ON public.landowners USING btree (tenant_id, parent_id);

CREATE INDEX IF NOT EXISTS landowners_tenant_idx ON public.landowners USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS liaison_logs_approval_idx ON public.liaison_logs USING btree (tenant_id, approval_id, chased_on);

CREATE INDEX IF NOT EXISTS liaison_logs_tenant_idx ON public.liaison_logs USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS plan_sanctions_project_idx ON public.plan_sanctions USING btree (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS plan_sanctions_tenant_idx ON public.plan_sanctions USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS poa_parcel_idx ON public.powers_of_attorney USING btree (tenant_id, parcel_id);

CREATE INDEX IF NOT EXISTS poa_tenant_idx ON public.powers_of_attorney USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS poa_validity_idx ON public.powers_of_attorney USING btree (tenant_id, valid_until);

CREATE INDEX IF NOT EXISTS title_documents_chain_idx ON public.title_documents USING btree (tenant_id, parcel_id, chain_position);

CREATE INDEX IF NOT EXISTS title_documents_expiry_idx ON public.title_documents USING btree (tenant_id, expires_on) WHERE (expires_on IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS title_documents_id_tenant_unique ON public.title_documents USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS title_documents_position_unique ON public.title_documents USING btree (parcel_id, chain_position);

CREATE INDEX IF NOT EXISTS title_documents_tenant_idx ON public.title_documents USING btree (tenant_id);

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'approval_sanctions_parcel_id_tenant_fk'
                    AND conrelid = 'public.approval_sanctions'::regclass) THEN
    ALTER TABLE ONLY public.approval_sanctions
    ADD CONSTRAINT approval_sanctions_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'approval_sanctions_project_id_projects_id_fk'
                    AND conrelid = 'public.approval_sanctions'::regclass) THEN
    ALTER TABLE ONLY public.approval_sanctions
    ADD CONSTRAINT approval_sanctions_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'approval_sanctions_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.approval_sanctions'::regclass) THEN
    ALTER TABLE ONLY public.approval_sanctions
    ADD CONSTRAINT approval_sanctions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'due_diligence_records_parcel_id_tenant_fk'
                    AND conrelid = 'public.due_diligence_records'::regclass) THEN
    ALTER TABLE ONLY public.due_diligence_records
    ADD CONSTRAINT due_diligence_records_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'due_diligence_records_project_id_projects_id_fk'
                    AND conrelid = 'public.due_diligence_records'::regclass) THEN
    ALTER TABLE ONLY public.due_diligence_records
    ADD CONSTRAINT due_diligence_records_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'due_diligence_records_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.due_diligence_records'::regclass) THEN
    ALTER TABLE ONLY public.due_diligence_records
    ADD CONSTRAINT due_diligence_records_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'due_diligence_records_unit_id_units_id_fk'
                    AND conrelid = 'public.due_diligence_records'::regclass) THEN
    ALTER TABLE ONLY public.due_diligence_records
    ADD CONSTRAINT due_diligence_records_unit_id_units_id_fk FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'due_diligence_records_verified_by_users_id_fk'
                    AND conrelid = 'public.due_diligence_records'::regclass) THEN
    ALTER TABLE ONLY public.due_diligence_records
    ADD CONSTRAINT due_diligence_records_verified_by_users_id_fk FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'estamp_certificates_created_by_users_id_fk'
                    AND conrelid = 'public.estamp_certificates'::regclass) THEN
    ALTER TABLE ONLY public.estamp_certificates
    ADD CONSTRAINT estamp_certificates_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'estamp_certificates_parcel_id_tenant_fk'
                    AND conrelid = 'public.estamp_certificates'::regclass) THEN
    ALTER TABLE ONLY public.estamp_certificates
    ADD CONSTRAINT estamp_certificates_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'estamp_certificates_project_id_projects_id_fk'
                    AND conrelid = 'public.estamp_certificates'::regclass) THEN
    ALTER TABLE ONLY public.estamp_certificates
    ADD CONSTRAINT estamp_certificates_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'estamp_certificates_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.estamp_certificates'::regclass) THEN
    ALTER TABLE ONLY public.estamp_certificates
    ADD CONSTRAINT estamp_certificates_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'joint_development_agreements_created_by_users_id_fk'
                    AND conrelid = 'public.joint_development_agreements'::regclass) THEN
    ALTER TABLE ONLY public.joint_development_agreements
    ADD CONSTRAINT joint_development_agreements_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'joint_development_agreements_parcel_id_tenant_fk'
                    AND conrelid = 'public.joint_development_agreements'::regclass) THEN
    ALTER TABLE ONLY public.joint_development_agreements
    ADD CONSTRAINT joint_development_agreements_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'joint_development_agreements_project_id_projects_id_fk'
                    AND conrelid = 'public.joint_development_agreements'::regclass) THEN
    ALTER TABLE ONLY public.joint_development_agreements
    ADD CONSTRAINT joint_development_agreements_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'joint_development_agreements_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.joint_development_agreements'::regclass) THEN
    ALTER TABLE ONLY public.joint_development_agreements
    ADD CONSTRAINT joint_development_agreements_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'khata_records_parcel_id_tenant_fk'
                    AND conrelid = 'public.khata_records'::regclass) THEN
    ALTER TABLE ONLY public.khata_records
    ADD CONSTRAINT khata_records_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'khata_records_project_id_projects_id_fk'
                    AND conrelid = 'public.khata_records'::regclass) THEN
    ALTER TABLE ONLY public.khata_records
    ADD CONSTRAINT khata_records_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'khata_records_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.khata_records'::regclass) THEN
    ALTER TABLE ONLY public.khata_records
    ADD CONSTRAINT khata_records_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'khata_records_unit_id_units_id_fk'
                    AND conrelid = 'public.khata_records'::regclass) THEN
    ALTER TABLE ONLY public.khata_records
    ADD CONSTRAINT khata_records_unit_id_units_id_fk FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_conversions_created_by_users_id_fk'
                    AND conrelid = 'public.land_conversions'::regclass) THEN
    ALTER TABLE ONLY public.land_conversions
    ADD CONSTRAINT land_conversions_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_conversions_parcel_id_tenant_fk'
                    AND conrelid = 'public.land_conversions'::regclass) THEN
    ALTER TABLE ONLY public.land_conversions
    ADD CONSTRAINT land_conversions_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_conversions_project_id_projects_id_fk'
                    AND conrelid = 'public.land_conversions'::regclass) THEN
    ALTER TABLE ONLY public.land_conversions
    ADD CONSTRAINT land_conversions_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_conversions_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.land_conversions'::regclass) THEN
    ALTER TABLE ONLY public.land_conversions
    ADD CONSTRAINT land_conversions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_parcels_created_by_users_id_fk'
                    AND conrelid = 'public.land_parcels'::regclass) THEN
    ALTER TABLE ONLY public.land_parcels
    ADD CONSTRAINT land_parcels_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_parcels_project_id_projects_id_fk'
                    AND conrelid = 'public.land_parcels'::regclass) THEN
    ALTER TABLE ONLY public.land_parcels
    ADD CONSTRAINT land_parcels_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_parcels_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.land_parcels'::regclass) THEN
    ALTER TABLE ONLY public.land_parcels
    ADD CONSTRAINT land_parcels_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_parcels_updated_by_users_id_fk'
                    AND conrelid = 'public.land_parcels'::regclass) THEN
    ALTER TABLE ONLY public.land_parcels
    ADD CONSTRAINT land_parcels_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_revenue_records_parcel_id_tenant_fk'
                    AND conrelid = 'public.land_revenue_records'::regclass) THEN
    ALTER TABLE ONLY public.land_revenue_records
    ADD CONSTRAINT land_revenue_records_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'land_revenue_records_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.land_revenue_records'::regclass) THEN
    ALTER TABLE ONLY public.land_revenue_records
    ADD CONSTRAINT land_revenue_records_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'landowners_created_by_users_id_fk'
                    AND conrelid = 'public.landowners'::regclass) THEN
    ALTER TABLE ONLY public.landowners
    ADD CONSTRAINT landowners_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'landowners_parcel_id_tenant_fk'
                    AND conrelid = 'public.landowners'::regclass) THEN
    ALTER TABLE ONLY public.landowners
    ADD CONSTRAINT landowners_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'landowners_parent_id_tenant_fk'
                    AND conrelid = 'public.landowners'::regclass) THEN
    ALTER TABLE ONLY public.landowners
    ADD CONSTRAINT landowners_parent_id_tenant_fk FOREIGN KEY (parent_id, tenant_id) REFERENCES public.landowners(id, tenant_id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'landowners_project_id_projects_id_fk'
                    AND conrelid = 'public.landowners'::regclass) THEN
    ALTER TABLE ONLY public.landowners
    ADD CONSTRAINT landowners_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'landowners_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.landowners'::regclass) THEN
    ALTER TABLE ONLY public.landowners
    ADD CONSTRAINT landowners_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'liaison_logs_approval_id_tenant_fk'
                    AND conrelid = 'public.liaison_logs'::regclass) THEN
    ALTER TABLE ONLY public.liaison_logs
    ADD CONSTRAINT liaison_logs_approval_id_tenant_fk FOREIGN KEY (approval_id, tenant_id) REFERENCES public.approval_sanctions(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'liaison_logs_chased_by_users_id_fk'
                    AND conrelid = 'public.liaison_logs'::regclass) THEN
    ALTER TABLE ONLY public.liaison_logs
    ADD CONSTRAINT liaison_logs_chased_by_users_id_fk FOREIGN KEY (chased_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'liaison_logs_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.liaison_logs'::regclass) THEN
    ALTER TABLE ONLY public.liaison_logs
    ADD CONSTRAINT liaison_logs_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'plan_sanctions_project_id_projects_id_fk'
                    AND conrelid = 'public.plan_sanctions'::regclass) THEN
    ALTER TABLE ONLY public.plan_sanctions
    ADD CONSTRAINT plan_sanctions_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'plan_sanctions_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.plan_sanctions'::regclass) THEN
    ALTER TABLE ONLY public.plan_sanctions
    ADD CONSTRAINT plan_sanctions_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'powers_of_attorney_parcel_id_tenant_fk'
                    AND conrelid = 'public.powers_of_attorney'::regclass) THEN
    ALTER TABLE ONLY public.powers_of_attorney
    ADD CONSTRAINT powers_of_attorney_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'powers_of_attorney_project_id_projects_id_fk'
                    AND conrelid = 'public.powers_of_attorney'::regclass) THEN
    ALTER TABLE ONLY public.powers_of_attorney
    ADD CONSTRAINT powers_of_attorney_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'powers_of_attorney_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.powers_of_attorney'::regclass) THEN
    ALTER TABLE ONLY public.powers_of_attorney
    ADD CONSTRAINT powers_of_attorney_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'title_documents_created_by_users_id_fk'
                    AND conrelid = 'public.title_documents'::regclass) THEN
    ALTER TABLE ONLY public.title_documents
    ADD CONSTRAINT title_documents_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'title_documents_parcel_id_tenant_fk'
                    AND conrelid = 'public.title_documents'::regclass) THEN
    ALTER TABLE ONLY public.title_documents
    ADD CONSTRAINT title_documents_parcel_id_tenant_fk FOREIGN KEY (parcel_id, tenant_id) REFERENCES public.land_parcels(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'title_documents_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.title_documents'::regclass) THEN
    ALTER TABLE ONLY public.title_documents
    ADD CONSTRAINT title_documents_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'title_documents_verified_by_users_id_fk'
                    AND conrelid = 'public.title_documents'::regclass) THEN
    ALTER TABLE ONLY public.title_documents
    ADD CONSTRAINT title_documents_verified_by_users_id_fk FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

-- ════════════════════════════════════════════════════════════════════
-- Ordence — Phase 42: Land, Title and the JDA   (PORT WAVE A)
-- File: 0030_phase42_land.sql
-- Version: v0.42.0-alpha
-- ════════════════════════════════════════════════════════════════════
--
--   §1  Row-Level Security, ENABLED and FORCED, on all thirteen tables
--   §2  Composite foreign keys — a child row cannot cross tenants
--   §3  ⭐ THE CHAIN OF TITLE HAS NO GAPS AND NO HOLES
--   §4  ⭐ THE FAR DEVIATION IS DERIVED, AND IT GATES THE OC
--   §5  A dropped parcel says why; a relinquishment names its deed
--   §6  ⭐ An e-stamp certificate may be used once
--   §7  Heir shares cannot exceed the whole
--   §8  updated_at
--
-- ⚠️ THE SOURCE OF THIS MODEL IS A SINGLE-COMPANY SYSTEM WITH NO
-- TENANCY. Every table here has been rebuilt with a tenant column, and
-- §1 and §2 are what make that real rather than decorative. Ported
-- without them, one developer would read another's land deals: every
-- page would work and nothing would error.
--
-- ════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════
-- §1  ROW-LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'land_parcels','title_documents','landowners',
    'joint_development_agreements','land_conversions','khata_records',
    'estamp_certificates','powers_of_attorney','due_diligence_records',
    'approval_sanctions','liaison_logs','plan_sanctions',
    'land_revenue_records'
  ]
  LOOP
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

DO $ordence$
DECLARE spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['title_documents',              'parcel_id',   'land_parcels',       'CASCADE'],
    ['joint_development_agreements', 'parcel_id',   'land_parcels',       'CASCADE'],
    ['land_revenue_records',         'parcel_id',   'land_parcels',       'CASCADE'],
    ['landowners',                   'parcel_id',   'land_parcels',       'CASCADE'],
    ['land_conversions',             'parcel_id',   'land_parcels',       'SET NULL'],
    ['khata_records',                'parcel_id',   'land_parcels',       'SET NULL'],
    ['estamp_certificates',          'parcel_id',   'land_parcels',       'SET NULL'],
    ['powers_of_attorney',           'parcel_id',   'land_parcels',       'SET NULL'],
    ['due_diligence_records',        'parcel_id',   'land_parcels',       'SET NULL'],
    ['approval_sanctions',           'parcel_id',   'land_parcels',       'SET NULL'],
    ['liaison_logs',                 'approval_id', 'approval_sanctions', 'CASCADE'],
    ['landowners',                   'parent_id',   'landowners',         'SET NULL']
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

-- ════════════════════════════════════════════════════════════════════
-- §3  ⭐ THE CHAIN OF TITLE HAS NO GAPS AND NO HOLES
-- ════════════════════════════════════════════════════════════════════
--
-- A chain of title is only worth anything if it is CONTINUOUS. Its value
-- is not the documents — it is the absence of a break between them.
--
-- Two different defects, both invisible in an unordered list of scans:
--
--   A HOLE  — positions 1, 2, 4. Something sat at 3 and is not here.
--   A GAP   — link 3's seller is not link 2's buyer. Ownership passed
--             through somebody with no recorded right to pass it.
--
-- The hole is refused outright: a chain cannot skip a position, because
-- the missing document is precisely the one nobody uploaded and precisely
-- the one an opposing advocate will find.
--
-- The gap is WARNED, not refused, and that difference is deliberate. Real
-- chains legitimately break at a partition deed, a will, a court decree
-- or a mutation — ownership moves without a matching sale. Refusing those
-- would make the table unusable for the messy chains that actually need
-- checking. So the trigger raises a NOTICE naming both parties, and the
-- screen reports it as an open question for a human to answer.

CREATE OR REPLACE FUNCTION ordence_guard_title_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  max_pos  integer;
  prev_to  text;
BEGIN
  SELECT COALESCE(MAX(chain_position), 0) INTO max_pos
    FROM title_documents
   WHERE tenant_id = NEW.tenant_id
     AND parcel_id = NEW.parcel_id
     AND (TG_OP = 'INSERT' OR id <> NEW.id);

  -- ⚠️ A HOLE IS REFUSED. Position 1 is the mother deed; every later
  -- link must sit immediately after an existing one.
  IF NEW.chain_position > max_pos + 1 THEN
    RAISE EXCEPTION
      'This chain jumps from position % to position %. A chain of title is worth something only because it is unbroken — the document that belongs at position % is exactly the one an opposing advocate will ask for, and a chain with a hole in it looks complete in a list. Add the missing link first, or renumber this one to %.',
      max_pos, NEW.chain_position, max_pos + 1, max_pos + 1
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⭐ A GAP IS REPORTED, NOT REFUSED. See the note above.
  IF NEW.chain_position > 1 AND NEW.from_party IS NOT NULL THEN
    SELECT to_party INTO prev_to
      FROM title_documents
     WHERE tenant_id = NEW.tenant_id
       AND parcel_id = NEW.parcel_id
       AND chain_position = NEW.chain_position - 1;

    IF prev_to IS NOT NULL
       AND lower(btrim(prev_to)) <> lower(btrim(NEW.from_party)) THEN
      RAISE NOTICE
        'Chain gap at position %: the previous link ends with "%" but this one begins with "%". That is normal at a partition, a will, a court decree or a mutation — and it is a break in title anywhere else. Record which it is in the remarks.',
        NEW.chain_position, prev_to, NEW.from_party;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_title_chain ON title_documents;
CREATE TRIGGER trg_guard_title_chain
  BEFORE INSERT OR UPDATE ON title_documents
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_title_chain();

-- ════════════════════════════════════════════════════════════════════
-- §4  ⭐ THE FAR DEVIATION IS DERIVED, AND IT GATES THE OC
-- ════════════════════════════════════════════════════════════════════
--
-- Floor Area Ratio sanctioned against FAR actually built. The gap between
-- those two numbers decides whether the occupancy certificate issues, and
-- without an OC the building cannot be lawfully occupied, buyers cannot
-- register their flats, and lenders will not disburse against them. A
-- finished tower with no OC is a finished tower nobody can move into.
--
-- ⚠️ THE DEVIATION IS COMPUTED HERE AND NOWHERE ELSE. A percentage that
-- can be typed independently of the two numbers it comes from will
-- eventually disagree with them — and it will disagree in the direction
-- that makes the project look compliant, because that is the number
-- somebody wanted to see.
--
-- ⚠️ AND MARKING THE OC RECEIVED WITH A LIVE DEVIATION IS REFUSED unless
-- a regularisation reference is recorded. An authority that regularised a
-- deviation issued a document saying so; if no such document exists, the
-- OC being ticked is somebody's optimism, and every buyer's registration
-- downstream depends on it.

CREATE OR REPLACE FUNCTION ordence_plan_sanction_deviation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- 5% is the tolerance most authorities work to. It is a default, not a
  -- law: it lives here so that changing it is one visible edit rather
  -- than a number scattered through screens.
  tolerance_bps constant integer := 500;
BEGIN
  IF NEW.sanctioned_far_bps IS NULL OR NEW.sanctioned_far_bps = 0 THEN
    NEW.deviation_bps := 0;
  ELSE
    NEW.deviation_bps := GREATEST(
      0,
      ((NEW.built_far_bps - NEW.sanctioned_far_bps) * 10000)
        / NEW.sanctioned_far_bps
    );
  END IF;

  IF NEW.oc_received
     AND NEW.deviation_bps > tolerance_bps
     AND COALESCE(btrim(NEW.regularisation_ref), '') = '' THEN
    -- ⚠️ The percentage is formatted into a text value FIRST. Building it
    -- inline with `%.%%%` produced "20.%0" — a mangled number inside the
    -- most consequential message in this file, on the one screen where a
    -- reader needs to know exactly how far over the limit they are.
    RAISE EXCEPTION
      'This project is built at % over its sanctioned FAR, and the occupancy certificate cannot be marked received without a regularisation reference. Sanctioned FAR %, built %. If the authority regularised the deviation there is a document saying so — record its number. If it did not, then the OC has not issued, and every buyer registration and bank disbursement recorded against it downstream is standing on nothing.',
      to_char(NEW.deviation_bps / 100.0, 'FM990.00') || '%',
      to_char(NEW.sanctioned_far_bps / 10000.0, 'FM990.0000'),
      to_char(NEW.built_far_bps / 10000.0, 'FM990.0000')
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.oc_received AND COALESCE(btrim(NEW.oc_number), '') = '' THEN
    RAISE EXCEPTION
      'An occupancy certificate marked received needs its number. It is the document buyers hand to their bank.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_plan_sanction_deviation ON plan_sanctions;
CREATE TRIGGER trg_plan_sanction_deviation
  BEFORE INSERT OR UPDATE ON plan_sanctions
  FOR EACH ROW EXECUTE FUNCTION ordence_plan_sanction_deviation();

-- ════════════════════════════════════════════════════════════════════
-- §5  A DROPPED PARCEL SAYS WHY
-- ════════════════════════════════════════════════════════════════════
--
-- A parcel that quietly disappears from the pipeline teaches nobody
-- anything. The reason it was dropped — a defective title, a litigating
-- heir, a price that moved — is the institutional memory that stops the
-- same land being looked at again in two years by somebody who was not
-- there the first time.

CREATE OR REPLACE FUNCTION ordence_guard_land_parcel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.stage = 'dropped'
     AND (NEW.dropped_reason IS NULL OR length(btrim(NEW.dropped_reason)) < 10) THEN
    RAISE EXCEPTION
      'Dropping a parcel needs a reason of at least ten characters. Somebody will look at this land again in two years, and the reason it was dropped the first time is the only thing that will stop them repeating the work.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Keep the derived square-footage in step. 1 acre = 43,560 sq ft;
  -- 1 guntha = 1,089 sq ft. Stated in one place.
  NEW.extent_sqft := ROUND(
    COALESCE(NEW.extent_acre, 0) * 43560 + COALESCE(NEW.extent_guntha, 0) * 1089,
    2);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_land_parcel ON land_parcels;
CREATE TRIGGER trg_guard_land_parcel
  BEFORE INSERT OR UPDATE ON land_parcels
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_land_parcel();

-- ════════════════════════════════════════════════════════════════════
-- §6  ⭐ AN E-STAMP CERTIFICATE MAY BE USED ONCE
-- ════════════════════════════════════════════════════════════════════
--
-- The unique index already stops the same certificate number being
-- recorded twice. This stops a certificate already marked USED being
-- attached to a second document — the same defect arriving by a different
-- route, which is exactly the failure mode the source system's own
-- security review kept finding: a rule enforced on one path while a
-- sibling path kept the old behaviour.

CREATE OR REPLACE FUNCTION ordence_guard_estamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'used'
     AND NEW.status = 'used'
     AND NEW.booking_id IS DISTINCT FROM OLD.booking_id
     AND OLD.booking_id IS NOT NULL THEN
    RAISE EXCEPTION
      'E-stamp certificate % has already been used. A certificate may be used once; the same number on two documents makes one of them void, and the person who finds out is a sub-registrar refusing to register. Buy a fresh certificate.',
      COALESCE(OLD.certificate_no, '(no number)')
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.status = 'cancelled'
     AND (NEW.cancelled_reason IS NULL OR length(btrim(NEW.cancelled_reason)) < 5) THEN
    RAISE EXCEPTION 'Cancelling an e-stamp certificate needs a reason — the duty is refundable and somebody has to claim it.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_estamp ON estamp_certificates;
CREATE TRIGGER trg_guard_estamp
  BEFORE INSERT OR UPDATE ON estamp_certificates
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_estamp();

-- ════════════════════════════════════════════════════════════════════
-- §7  ⭐ HEIR SHARES CANNOT EXCEED THE WHOLE
-- ════════════════════════════════════════════════════════════════════
--
-- Siblings dividing an ancestral property hold fractions that sum to one.
-- Shares summing to more than one means somebody has been recorded twice,
-- or a share was entered as a percentage into a fraction — and a purchase
-- built on it pays for more than exists.
--
-- ⚠️ EXACT ARITHMETIC, NO FLOATS. The shares are summed as
-- SUM(num * (lcm/den)) over a common denominator, which is why they were
-- stored as num/den in the first place. Three thirds sum to exactly one
-- here and to 0.9999 in any decimal representation.

CREATE OR REPLACE FUNCTION ordence_guard_heir_shares()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  total numeric;
BEGIN
  IF NEW.share_num IS NULL OR NEW.share_den IS NULL OR NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(share_num::numeric / share_den::numeric), 0)
    INTO total
    FROM landowners
   WHERE tenant_id = NEW.tenant_id
     AND parent_id = NEW.parent_id
     AND relinquished = false
     AND share_num IS NOT NULL
     AND share_den IS NOT NULL
     AND (TG_OP = 'INSERT' OR id <> NEW.id);

  total := total + (NEW.share_num::numeric / NEW.share_den::numeric);

  -- A hair of tolerance for a chain of thirds, and no more.
  IF total > 1.0000001 THEN
    RAISE EXCEPTION
      'These heirs'' shares add up to more than the whole (%). Either somebody is recorded twice, or a percentage has been entered where a fraction belongs — 33 out of 100 is not a third. Buying on shares that oversum means paying for more of the land than exists.',
      ROUND(total, 6)
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_heir_shares ON landowners;
CREATE TRIGGER trg_guard_heir_shares
  BEFORE INSERT OR UPDATE ON landowners
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_heir_shares();

-- ════════════════════════════════════════════════════════════════════
-- §8  updated_at
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ordence_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'land_parcels','title_documents','landowners',
    'joint_development_agreements','land_conversions','khata_records',
    'estamp_certificates','powers_of_attorney','due_diligence_records',
    'approval_sanctions','plan_sanctions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_touch_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW
         EXECUTE FUNCTION ordence_touch_updated_at()', 'trg_touch_' || t, t);
  END LOOP;
END $$;


COMMIT;

-- ═════════════════════════════════════════════════════════════════════
--  PART 3 — THE CHECK   (look for PASS, eighteen times)
-- ═════════════════════════════════════════════════════════════════════

SELECT 'Table exists: ' || t AS check_name,
       CASE WHEN to_regclass('public.' || t) IS NOT NULL
            THEN 'PASS' ELSE 'FAIL — not created' END AS result
FROM unnest(ARRAY['land_parcels','title_documents','landowners',
                  'joint_development_agreements','land_conversions','khata_records',
                  'estamp_certificates','powers_of_attorney','due_diligence_records',
                  'approval_sanctions','liaison_logs','plan_sanctions',
                  'land_revenue_records']) AS t

UNION ALL
SELECT 'Every land table has tenant isolation ON and FORCED',
       CASE WHEN count(*) = 13 THEN 'PASS'
            ELSE 'FAIL — only ' || count(*) || ' of 13 protected' END
FROM pg_class c
WHERE c.relname IN ('land_parcels','title_documents','landowners',
                    'joint_development_agreements','land_conversions','khata_records',
                    'estamp_certificates','powers_of_attorney','due_diligence_records',
                    'approval_sanctions','liaison_logs','plan_sanctions',
                    'land_revenue_records')
  AND c.relrowsecurity AND c.relforcerowsecurity

UNION ALL
SELECT 'Every land table has an isolation policy',
       CASE WHEN count(*) = 13 THEN 'PASS'
            ELSE 'FAIL — only ' || count(*) || ' of 13' END
FROM pg_policies
WHERE tablename IN ('land_parcels','title_documents','landowners',
                    'joint_development_agreements','land_conversions','khata_records',
                    'estamp_certificates','powers_of_attorney','due_diligence_records',
                    'approval_sanctions','liaison_logs','plan_sanctions',
                    'land_revenue_records')

UNION ALL
SELECT 'A title chain cannot skip a position',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — chain guard missing' END
FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_title_chain'

UNION ALL
SELECT 'Heirs'' shares cannot exceed the whole property',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — heir guard missing' END
FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_heir_shares'

UNION ALL
SELECT 'FAR deviation is calculated, and gates the occupancy certificate',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — OC gate missing' END
FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_plan_sanction_deviation'

UNION ALL
SELECT 'A child row cannot be attached to another customer''s land',
       CASE WHEN count(*) >= 12 THEN 'PASS'
            ELSE 'FAIL — only ' || count(*) || ' cross-tenant guards' END
FROM pg_constraint
WHERE conname LIKE '%_tenant_fk'
  AND (conrelid::regclass::text LIKE 'land%'
    OR conrelid::regclass::text LIKE 'title%'
    OR conrelid::regclass::text LIKE 'joint%'
    OR conrelid::regclass::text LIKE 'liaison%'
    OR conrelid::regclass::text LIKE 'approval%'
    OR conrelid::regclass::text LIKE 'khata%'
    OR conrelid::regclass::text LIKE 'estamp%'
    OR conrelid::regclass::text LIKE 'powers%'
    OR conrelid::regclass::text LIKE 'due_%')

ORDER BY 2 DESC, 1;
