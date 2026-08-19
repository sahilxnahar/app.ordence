-- ═════════════════════════════════════════════════════════════════════
--  ORDENCE — FILE 16
--  Phase 44: RA Bills & Contractor Compliance
-- ═════════════════════════════════════════════════════════════════════
--
--  RUN FILES 13, 14 AND 15 FIRST.
--
--  WHAT TO DO
--  1. Open Neon:  https://console.neon.tech  →  SQL Editor
--  2. Select all of this file (Cmd+A), copy (Cmd+C), paste, Run.
--  3. Wait ~10 seconds. Scroll to the bottom. Look for PASS — eleven.
--
--  IF YOU SEE "FAIL" or red text: stop, send Claude a screenshot.
--  SAFE TO RUN TWICE.
--
--  WHAT THIS FILE DOES
--  -------------------
--  Six tables for works contracts and running-account bills, then the
--  rules. Three worth knowing about:
--
--  * EVERY FIGURE ON AN RA BILL IS CALCULATED, NOT TYPED. Gross value
--    goes in; the 1% labour cess, 5% retention, TDS and the net payable
--    all come out. Most importantly "previously paid" is worked out from
--    the earlier bills automatically — that is the number which, keyed
--    by hand, drifts one plausible bill at a time and is discovered at
--    the final bill when the contractor has already left.
--
--  * A CONTRACTOR WITH NO VERIFIED EPF/ESI CHALLAN CANNOT BE PAID for
--    that month. You are the principal employer: if he has not deposited
--    his workers' PF and insurance, the liability is yours, and you
--    would pay him now and pay the authority again later with damages.
--    The system will refuse and tell you exactly which challan is
--    missing. An UPLOADED challan is not enough — somebody has to have
--    verified it.
--
--  * A CERTIFIED BILL'S FIGURES CANNOT BE EDITED. An engineer put their
--    name to that quantity. Corrections go on the next RA bill, which is
--    what a running account is for.
--
-- ═════════════════════════════════════════════════════════════════════

BEGIN;

-- ═════════════════════════════════════════════════════════════════════
--  PART 1 — THE TABLES
-- ═════════════════════════════════════════════════════════════════════

DO $ordence$ BEGIN
  CREATE TYPE public.ra_bill_status AS ENUM
    ('draft','submitted','certified','approved','paid','rejected','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.compliance_doc_kind AS ENUM
    ('epf','esi','professional_tax','labour_licence','wc_policy','gst_return','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.compliance_doc_status AS ENUM
    ('pending','uploaded','verified','rejected','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

DO $ordence$ BEGIN
  CREATE TYPE public.works_contract_status AS ENUM
    ('draft','active','suspended','completed','terminated');
EXCEPTION WHEN duplicate_object THEN NULL; END $ordence$;

CREATE TABLE IF NOT EXISTS public.compliance_docs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    kind public.compliance_doc_kind NOT NULL,
    period_month character varying(7) NOT NULL,
    challan_no character varying(100),
    amount_minor bigint,
    paid_on date,
    status public.compliance_doc_status DEFAULT 'pending'::public.compliance_doc_status NOT NULL,
    document_id uuid,
    verified_by uuid,
    verified_at timestamp with time zone,
    rejection_reason text,
    uploaded_by uuid,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT compliance_docs_period_shape CHECK (((period_month)::text ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))
);

CREATE TABLE IF NOT EXISTS public.engineer_certifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    period character varying(30) NOT NULL,
    is_cleared boolean DEFAULT false NOT NULL,
    certified_by uuid,
    certified_by_name character varying(200),
    certified_at timestamp with time zone,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ra_bill_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    ra_bill_id uuid NOT NULL,
    line_no integer NOT NULL,
    boq_code character varying(60),
    description text NOT NULL,
    unit character varying(20) NOT NULL,
    quantity numeric(18,3) NOT NULL,
    rate_minor bigint NOT NULL,
    amount_minor bigint DEFAULT 0 NOT NULL,
    cumulative_quantity numeric(18,3),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ra_bill_lines_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT ra_bill_lines_rate_non_negative CHECK ((rate_minor >= 0))
);

CREATE TABLE IF NOT EXISTS public.ra_bills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    bill_no character varying(60) NOT NULL,
    sequence integer NOT NULL,
    contract_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    project_id uuid,
    period_from date,
    period_to date,
    compliance_month character varying(7),
    gross_value_minor bigint DEFAULT 0 NOT NULL,
    previous_paid_minor bigint DEFAULT 0 NOT NULL,
    cess_rate_bps integer DEFAULT 100 NOT NULL,
    cess_amount_minor bigint DEFAULT 0 NOT NULL,
    retention_rate_bps integer DEFAULT 500 NOT NULL,
    retention_amount_minor bigint DEFAULT 0 NOT NULL,
    tds_section character varying(10),
    tds_rate_bps integer,
    tds_amount_minor bigint DEFAULT 0 NOT NULL,
    other_deductions_minor bigint DEFAULT 0 NOT NULL,
    other_deductions_note text,
    net_payable_minor bigint DEFAULT 0 NOT NULL,
    status public.ra_bill_status DEFAULT 'draft'::public.ra_bill_status NOT NULL,
    submitted_at timestamp with time zone,
    certified_by uuid,
    certified_at timestamp with time zone,
    approved_by uuid,
    approved_at timestamp with time zone,
    paid_at timestamp with time zone,
    payment_utr character varying(60),
    rejection_reason text,
    narration text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT ra_bills_gross_non_negative CHECK ((gross_value_minor >= 0)),
    CONSTRAINT ra_bills_rates_sane CHECK (((cess_rate_bps >= 0) AND (retention_rate_bps >= 0) AND ((tds_rate_bps IS NULL) OR (tds_rate_bps >= 0)))),
    CONSTRAINT ra_bills_sequence_positive CHECK ((sequence >= 1))
);

CREATE TABLE IF NOT EXISTS public.retention_releases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    vendor_id uuid NOT NULL,
    amount_minor bigint NOT NULL,
    released_on date,
    reason text NOT NULL,
    approved_by uuid,
    payment_utr character varying(60),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT retention_releases_amount_positive CHECK ((amount_minor > 0))
);

CREATE TABLE IF NOT EXISTS public.works_contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    contract_no character varying(100) NOT NULL,
    title character varying(300) NOT NULL,
    project_id uuid,
    vendor_id uuid NOT NULL,
    status public.works_contract_status DEFAULT 'draft'::public.works_contract_status NOT NULL,
    contract_value_minor bigint,
    start_on date,
    end_on date,
    defect_liability_ends_on date,
    liability_clause text,
    cess_rate_bps integer DEFAULT 100 NOT NULL,
    retention_rate_bps integer DEFAULT 500 NOT NULL,
    tds_section character varying(10) DEFAULT '194C'::character varying,
    tds_rate_bps integer DEFAULT 200,
    requires_labour_compliance boolean DEFAULT true NOT NULL,
    requires_engineer_certificate boolean DEFAULT true NOT NULL,
    daily_report_required boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT works_contracts_rates_sane CHECK (((cess_rate_bps >= 0) AND (cess_rate_bps <= 10000) AND (retention_rate_bps >= 0) AND (retention_rate_bps <= 10000) AND ((tds_rate_bps IS NULL) OR ((tds_rate_bps >= 0) AND (tds_rate_bps <= 10000)))))
);

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'compliance_docs_pkey'
                    AND conrelid = 'public.compliance_docs'::regclass) THEN
    ALTER TABLE ONLY public.compliance_docs
    ADD CONSTRAINT compliance_docs_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'engineer_certifications_pkey'
                    AND conrelid = 'public.engineer_certifications'::regclass) THEN
    ALTER TABLE ONLY public.engineer_certifications
    ADD CONSTRAINT engineer_certifications_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bill_lines_pkey'
                    AND conrelid = 'public.ra_bill_lines'::regclass) THEN
    ALTER TABLE ONLY public.ra_bill_lines
    ADD CONSTRAINT ra_bill_lines_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bills_pkey'
                    AND conrelid = 'public.ra_bills'::regclass) THEN
    ALTER TABLE ONLY public.ra_bills
    ADD CONSTRAINT ra_bills_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'retention_releases_pkey'
                    AND conrelid = 'public.retention_releases'::regclass) THEN
    ALTER TABLE ONLY public.retention_releases
    ADD CONSTRAINT retention_releases_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'works_contracts_pkey'
                    AND conrelid = 'public.works_contracts'::regclass) THEN
    ALTER TABLE ONLY public.works_contracts
    ADD CONSTRAINT works_contracts_pkey PRIMARY KEY (id);
  END IF;
END $ordence$;

CREATE UNIQUE INDEX IF NOT EXISTS compliance_docs_slot_unique ON public.compliance_docs USING btree (tenant_id, vendor_id, kind, period_month);

CREATE INDEX IF NOT EXISTS compliance_docs_status_idx ON public.compliance_docs USING btree (tenant_id, status);

CREATE INDEX IF NOT EXISTS compliance_docs_tenant_idx ON public.compliance_docs USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS compliance_docs_vendor_idx ON public.compliance_docs USING btree (tenant_id, vendor_id);

CREATE INDEX IF NOT EXISTS engineer_certifications_cleared_idx ON public.engineer_certifications USING btree (tenant_id, is_cleared);

CREATE UNIQUE INDEX IF NOT EXISTS engineer_certifications_slot_unique ON public.engineer_certifications USING btree (contract_id, period);

CREATE INDEX IF NOT EXISTS engineer_certifications_tenant_idx ON public.engineer_certifications USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS ra_bill_lines_bill_idx ON public.ra_bill_lines USING btree (tenant_id, ra_bill_id);

CREATE UNIQUE INDEX IF NOT EXISTS ra_bill_lines_no_unique ON public.ra_bill_lines USING btree (ra_bill_id, line_no);

CREATE INDEX IF NOT EXISTS ra_bill_lines_tenant_idx ON public.ra_bill_lines USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS ra_bills_contract_idx ON public.ra_bills USING btree (tenant_id, contract_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS ra_bills_id_tenant_unique ON public.ra_bills USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS ra_bills_no_unique ON public.ra_bills USING btree (tenant_id, bill_no);

CREATE UNIQUE INDEX IF NOT EXISTS ra_bills_sequence_unique ON public.ra_bills USING btree (contract_id, sequence);

CREATE INDEX IF NOT EXISTS ra_bills_status_idx ON public.ra_bills USING btree (tenant_id, status);

CREATE INDEX IF NOT EXISTS ra_bills_tenant_idx ON public.ra_bills USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS ra_bills_vendor_idx ON public.ra_bills USING btree (tenant_id, vendor_id);

CREATE INDEX IF NOT EXISTS retention_releases_contract_idx ON public.retention_releases USING btree (tenant_id, contract_id);

CREATE INDEX IF NOT EXISTS retention_releases_tenant_idx ON public.retention_releases USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS works_contracts_dlp_idx ON public.works_contracts USING btree (tenant_id, defect_liability_ends_on);

CREATE UNIQUE INDEX IF NOT EXISTS works_contracts_id_tenant_unique ON public.works_contracts USING btree (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS works_contracts_no_unique ON public.works_contracts USING btree (tenant_id, contract_no);

CREATE INDEX IF NOT EXISTS works_contracts_project_idx ON public.works_contracts USING btree (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS works_contracts_tenant_idx ON public.works_contracts USING btree (tenant_id);

CREATE INDEX IF NOT EXISTS works_contracts_vendor_idx ON public.works_contracts USING btree (tenant_id, vendor_id);

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'compliance_docs_uploaded_by_users_id_fk'
                    AND conrelid = 'public.compliance_docs'::regclass) THEN
    ALTER TABLE ONLY public.compliance_docs
    ADD CONSTRAINT compliance_docs_uploaded_by_users_id_fk FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'compliance_docs_verified_by_users_id_fk'
                    AND conrelid = 'public.compliance_docs'::regclass) THEN
    ALTER TABLE ONLY public.compliance_docs
    ADD CONSTRAINT compliance_docs_verified_by_users_id_fk FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'engineer_certifications_certified_by_users_id_fk'
                    AND conrelid = 'public.engineer_certifications'::regclass) THEN
    ALTER TABLE ONLY public.engineer_certifications
    ADD CONSTRAINT engineer_certifications_certified_by_users_id_fk FOREIGN KEY (certified_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'engineer_certifications_contract_id_tenant_fk'
                    AND conrelid = 'public.engineer_certifications'::regclass) THEN
    ALTER TABLE ONLY public.engineer_certifications
    ADD CONSTRAINT engineer_certifications_contract_id_tenant_fk FOREIGN KEY (contract_id, tenant_id) REFERENCES public.works_contracts(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'engineer_certifications_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.engineer_certifications'::regclass) THEN
    ALTER TABLE ONLY public.engineer_certifications
    ADD CONSTRAINT engineer_certifications_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bill_lines_ra_bill_id_tenant_fk'
                    AND conrelid = 'public.ra_bill_lines'::regclass) THEN
    ALTER TABLE ONLY public.ra_bill_lines
    ADD CONSTRAINT ra_bill_lines_ra_bill_id_tenant_fk FOREIGN KEY (ra_bill_id, tenant_id) REFERENCES public.ra_bills(id, tenant_id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bill_lines_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.ra_bill_lines'::regclass) THEN
    ALTER TABLE ONLY public.ra_bill_lines
    ADD CONSTRAINT ra_bill_lines_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bills_approved_by_users_id_fk'
                    AND conrelid = 'public.ra_bills'::regclass) THEN
    ALTER TABLE ONLY public.ra_bills
    ADD CONSTRAINT ra_bills_approved_by_users_id_fk FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bills_certified_by_users_id_fk'
                    AND conrelid = 'public.ra_bills'::regclass) THEN
    ALTER TABLE ONLY public.ra_bills
    ADD CONSTRAINT ra_bills_certified_by_users_id_fk FOREIGN KEY (certified_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bills_contract_id_tenant_fk'
                    AND conrelid = 'public.ra_bills'::regclass) THEN
    ALTER TABLE ONLY public.ra_bills
    ADD CONSTRAINT ra_bills_contract_id_tenant_fk FOREIGN KEY (contract_id, tenant_id) REFERENCES public.works_contracts(id, tenant_id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bills_created_by_users_id_fk'
                    AND conrelid = 'public.ra_bills'::regclass) THEN
    ALTER TABLE ONLY public.ra_bills
    ADD CONSTRAINT ra_bills_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bills_project_id_projects_id_fk'
                    AND conrelid = 'public.ra_bills'::regclass) THEN
    ALTER TABLE ONLY public.ra_bills
    ADD CONSTRAINT ra_bills_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bills_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.ra_bills'::regclass) THEN
    ALTER TABLE ONLY public.ra_bills
    ADD CONSTRAINT ra_bills_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ra_bills_updated_by_users_id_fk'
                    AND conrelid = 'public.ra_bills'::regclass) THEN
    ALTER TABLE ONLY public.ra_bills
    ADD CONSTRAINT ra_bills_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'retention_releases_approved_by_users_id_fk'
                    AND conrelid = 'public.retention_releases'::regclass) THEN
    ALTER TABLE ONLY public.retention_releases
    ADD CONSTRAINT retention_releases_approved_by_users_id_fk FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'retention_releases_contract_id_tenant_fk'
                    AND conrelid = 'public.retention_releases'::regclass) THEN
    ALTER TABLE ONLY public.retention_releases
    ADD CONSTRAINT retention_releases_contract_id_tenant_fk FOREIGN KEY (contract_id, tenant_id) REFERENCES public.works_contracts(id, tenant_id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'retention_releases_created_by_users_id_fk'
                    AND conrelid = 'public.retention_releases'::regclass) THEN
    ALTER TABLE ONLY public.retention_releases
    ADD CONSTRAINT retention_releases_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'retention_releases_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.retention_releases'::regclass) THEN
    ALTER TABLE ONLY public.retention_releases
    ADD CONSTRAINT retention_releases_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'works_contracts_created_by_users_id_fk'
                    AND conrelid = 'public.works_contracts'::regclass) THEN
    ALTER TABLE ONLY public.works_contracts
    ADD CONSTRAINT works_contracts_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'works_contracts_project_id_projects_id_fk'
                    AND conrelid = 'public.works_contracts'::regclass) THEN
    ALTER TABLE ONLY public.works_contracts
    ADD CONSTRAINT works_contracts_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'works_contracts_tenant_id_tenants_id_fk'
                    AND conrelid = 'public.works_contracts'::regclass) THEN
    ALTER TABLE ONLY public.works_contracts
    ADD CONSTRAINT works_contracts_tenant_id_tenants_id_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'works_contracts_updated_by_users_id_fk'
                    AND conrelid = 'public.works_contracts'::regclass) THEN
    ALTER TABLE ONLY public.works_contracts
    ADD CONSTRAINT works_contracts_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $ordence$;

DO $ordence$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'works_contracts_vendor_id_vendors_id_fk'
                    AND conrelid = 'public.works_contracts'::regclass) THEN
    ALTER TABLE ONLY public.works_contracts
    ADD CONSTRAINT works_contracts_vendor_id_vendors_id_fk FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE RESTRICT;
  END IF;
END $ordence$;

-- ════════════════════════════════════════════════════════════════════
-- Ordence — Phase 44: RA Bills & Contractor Compliance  (PORT WAVE B)
-- File: 0031_phase44_ra_bills.sql
-- Version: v0.44.0-alpha
-- ════════════════════════════════════════════════════════════════════
--
--   §1  Row-Level Security, ENABLED and FORCED, on all six tables
--   §2  Composite foreign keys — a child row cannot cross tenants
--   §3  ⭐ THE ARITHMETIC IS DERIVED, NEVER TYPED
--   §4  ⭐ THE EPF/ESI PAYMENT GATE — the reason this phase exists
--   §5  ⭐ RA bills run in sequence and cannot skip
--   §6  A certified bill's figures are frozen
--   §7  Retention cannot be released beyond what was withheld
--   §8  updated_at
--
-- ════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════
-- §1  ROW-LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'works_contracts','compliance_docs','engineer_certifications',
    'ra_bills','ra_bill_lines','retention_releases'
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
    ['ra_bills',                 'contract_id', 'works_contracts', 'RESTRICT'],
    ['ra_bill_lines',            'ra_bill_id',  'ra_bills',        'CASCADE'],
    ['engineer_certifications',  'contract_id', 'works_contracts', 'CASCADE'],
    ['retention_releases',       'contract_id', 'works_contracts', 'RESTRICT']
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
-- §3  ⭐ THE ARITHMETIC IS DERIVED, NEVER TYPED
-- ════════════════════════════════════════════════════════════════════
--
-- Every deduction on a running-account bill is somebody else's money —
-- the labour welfare board's, the contractor's own withheld retention,
-- the income tax department's. A figure that can be keyed by hand is a
-- figure that drifts, and RA-bill drift is discovered at the FINAL bill,
-- when the cumulative totals do not reconcile and the contractor has
-- already left the site.
--
-- ⚠️ `previous_paid` IS THE DANGEROUS ONE. It is the sum of everything
-- paid on EARLIER bills of the same contract. Typed by hand it stays
-- plausible bill after bill while the running account quietly diverges.
-- Computed here it cannot.
--
-- ⚠️ THE ROUNDING IS HALF-UP AND EXPLICIT, matching `lib/orders/pricing.ts`
-- and every Indian accounting package a customer will reconcile against.

CREATE OR REPLACE FUNCTION ordence_compute_ra_bill()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  prior bigint;
BEGIN
  -- Everything actually paid on earlier bills of this contract.
  SELECT COALESCE(SUM(net_payable_minor), 0) INTO prior
    FROM ra_bills
   WHERE tenant_id  = NEW.tenant_id
     AND contract_id = NEW.contract_id
     AND sequence   < NEW.sequence
     AND status      = 'paid';

  NEW.previous_paid_minor := prior;

  -- Cess, retention and TDS all sit on the value of work certified in
  -- THIS bill. Half-up, stated once each.
  NEW.cess_amount_minor :=
    ((NEW.gross_value_minor * NEW.cess_rate_bps) + 5000) / 10000;

  NEW.retention_amount_minor :=
    ((NEW.gross_value_minor * NEW.retention_rate_bps) + 5000) / 10000;

  NEW.tds_amount_minor := CASE
    WHEN NEW.tds_rate_bps IS NULL THEN 0
    ELSE ((NEW.gross_value_minor * NEW.tds_rate_bps) + 5000) / 10000
  END;

  NEW.net_payable_minor :=
      NEW.gross_value_minor
    - NEW.cess_amount_minor
    - NEW.retention_amount_minor
    - NEW.tds_amount_minor
    - COALESCE(NEW.other_deductions_minor, 0);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_compute_ra_bill ON ra_bills;
CREATE TRIGGER trg_compute_ra_bill
  BEFORE INSERT OR UPDATE ON ra_bills
  FOR EACH ROW EXECUTE FUNCTION ordence_compute_ra_bill();

-- ════════════════════════════════════════════════════════════════════
-- §4  ⭐ THE EPF/ESI PAYMENT GATE — WHY THIS PHASE EXISTS
-- ════════════════════════════════════════════════════════════════════
--
-- Under the EPF and ESI Acts the PRINCIPAL EMPLOYER — the developer — is
-- liable for a contractor's unpaid employee provident fund and insurance
-- contributions. Pay a contractor who has not deposited them and you pay
-- twice: once to him now, and again to the authority later, with damages
-- and interest.
--
-- So a bill cannot reach `paid` for a period unless a challan for that
-- period exists and somebody has VERIFIED it.
--
-- ⚠️ IT GATES `paid`, NOT `certified`. The engineer certifies that work
-- was done; that is true whatever the contractor filed. Blocking
-- certification would stop the site record being accurate in order to
-- enforce a finance rule, and the two must not be entangled.
--
-- ⚠️ AND IT REQUIRES `verified`, NOT MERELY `uploaded`. An uploaded file
-- is a PDF somebody attached. Verified means a person opened it and
-- checked the establishment code and the amount. The whole liability
-- turns on the challan being real.

CREATE OR REPLACE FUNCTION ordence_ra_bill_compliance_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  contract      RECORD;
  missing       text[];
  doc_status    text;
  gating        text;
  cert_cleared  boolean;
BEGIN
  IF NEW.status <> 'paid' OR OLD.status = 'paid' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO contract FROM works_contracts WHERE id = NEW.contract_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That contract does not exist.' USING ERRCODE = 'raise_exception';
  END IF;

  /* --- The engineer's certificate, where the contract requires it -- */
  IF contract.requires_engineer_certificate THEN
    SELECT is_cleared INTO cert_cleared
      FROM engineer_certifications
     WHERE tenant_id = NEW.tenant_id
       AND contract_id = NEW.contract_id
       AND period = COALESCE(NEW.compliance_month, '')
     LIMIT 1;

    IF cert_cleared IS NULL THEN
      RAISE EXCEPTION
        'Bill % cannot be paid: no engineer''s certificate exists for %. The contract requires one. Certification says the work was actually done to specification — paying without it means paying on somebody''s word that nobody recorded.',
        NEW.bill_no, COALESCE(NEW.compliance_month, '(no period set)')
        USING ERRCODE = 'raise_exception';
    END IF;

    IF NOT cert_cleared THEN
      RAISE EXCEPTION
        'Bill % cannot be paid: the engineer has NOT cleared %. That is a finding, not an oversight — somebody looked at the work and was not satisfied. It outranks the payment run.',
        NEW.bill_no, NEW.compliance_month
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  /* --- ⭐ EPF AND ESI ---------------------------------------------- */
  IF NOT contract.requires_labour_compliance THEN
    RETURN NEW;
  END IF;

  IF NEW.compliance_month IS NULL THEN
    RAISE EXCEPTION
      'Bill % cannot be paid without a compliance month. That month decides which EPF and ESI challans are checked, and this contract requires them.',
      NEW.bill_no
      USING ERRCODE = 'raise_exception';
  END IF;

  missing := ARRAY[]::text[];

  FOREACH gating IN ARRAY ARRAY['epf', 'esi'] LOOP
    SELECT status::text INTO doc_status
      FROM compliance_docs
     WHERE tenant_id    = NEW.tenant_id
       AND vendor_id    = NEW.vendor_id
       AND kind::text   = gating
       AND period_month = NEW.compliance_month
     LIMIT 1;

    IF doc_status IS NULL THEN
      missing := missing || (upper(gating) || ' (no challan on file)');
    ELSIF doc_status <> 'verified' THEN
      missing := missing || (upper(gating) || ' (challan is ' || doc_status || ', not verified)');
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION
      'Bill % cannot be paid for %: %. You are the principal employer. If this contractor has not deposited his workers'' provident fund and insurance for that month, the liability is yours — you would pay him now and pay the authority again later, with damages and interest. Get the challan, verify it, then pay.',
      NEW.bill_no, NEW.compliance_month, array_to_string(missing, '; ')
      USING ERRCODE = 'raise_exception';
  END IF;

  IF COALESCE(btrim(NEW.payment_utr), '') = '' THEN
    RAISE EXCEPTION
      'Bill % marked paid with no UTR. The UTR is the only evidence the money actually moved, and it is what a contractor disputing non-payment will be asked for.',
      NEW.bill_no
      USING ERRCODE = 'raise_exception';
  END IF;

  NEW.paid_at := COALESCE(NEW.paid_at, now());
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ra_bill_compliance_gate ON ra_bills;
CREATE TRIGGER trg_ra_bill_compliance_gate
  BEFORE UPDATE ON ra_bills
  FOR EACH ROW EXECUTE FUNCTION ordence_ra_bill_compliance_gate();

-- ════════════════════════════════════════════════════════════════════
-- §5, §6  SEQUENCE AND FREEZE
-- ════════════════════════════════════════════════════════════════════
--
-- ⚠️ RA BILLS ARE A RUNNING ACCOUNT. Bill N measures against the
-- cumulative position after bill N−1. Creating RA-5 when RA-4 does not
-- exist means RA-5's "previous paid" is measured against a gap, and the
-- error propagates to every bill after it.
--
-- ⚠️ AND A CERTIFIED BILL'S FIGURES ARE FROZEN. Certification is an
-- engineer putting their name to a quantity. Editing the amount
-- afterwards makes them the author of a number they never saw.

CREATE OR REPLACE FUNCTION ordence_guard_ra_bill()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  max_seq integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(MAX(sequence), 0) INTO max_seq
      FROM ra_bills
     WHERE tenant_id = NEW.tenant_id AND contract_id = NEW.contract_id;

    IF NEW.sequence > max_seq + 1 THEN
      RAISE EXCEPTION
        'This contract is at RA-%, so the next bill is RA-% — not RA-%. A running account measures each bill against the cumulative position after the one before it; skipping a number means every bill after this one is measured against a gap.',
        max_seq, max_seq + 1, NEW.sequence
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: once certified, the money figures are fixed.
  IF OLD.status IN ('certified', 'approved', 'paid')
     AND (NEW.gross_value_minor IS DISTINCT FROM OLD.gross_value_minor
       OR NEW.cess_rate_bps      IS DISTINCT FROM OLD.cess_rate_bps
       OR NEW.retention_rate_bps IS DISTINCT FROM OLD.retention_rate_bps
       OR NEW.tds_rate_bps       IS DISTINCT FROM OLD.tds_rate_bps
       OR NEW.other_deductions_minor IS DISTINCT FROM OLD.other_deductions_minor)
  THEN
    RAISE EXCEPTION
      'Bill % is % and its figures cannot change. An engineer put their name to that quantity; editing the amount afterwards makes them the author of a number they never saw. Reject the bill and raise the next RA bill with the correction — that is what a running account is for.',
      OLD.bill_no, OLD.status
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.status = 'rejected'
     AND (NEW.rejection_reason IS NULL OR length(btrim(NEW.rejection_reason)) < 10) THEN
    RAISE EXCEPTION
      'Rejecting bill % needs a reason of at least ten characters. The contractor will ask, and "rejected" on its own is not an answer anybody can act on.',
      OLD.bill_no
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_ra_bill ON ra_bills;
CREATE TRIGGER trg_guard_ra_bill
  BEFORE INSERT OR UPDATE ON ra_bills
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_ra_bill();

-- ⚠️ Ordering matters: the compute trigger must run BEFORE the gate, so
-- the gate sees final figures. PostgreSQL fires BEFORE triggers in
-- alphabetical order by name — trg_compute_ra_bill, then
-- trg_guard_ra_bill, then trg_ra_bill_compliance_gate. That is the
-- correct order and it is not an accident; renaming any of them changes
-- it.

-- ════════════════════════════════════════════════════════════════════
-- §7  ⭐ RETENTION CANNOT BE RELEASED BEYOND WHAT WAS WITHHELD
-- ════════════════════════════════════════════════════════════════════
--
-- Retention is the contractor's own money, held back across many bills
-- as security against defects. Releasing more than was ever withheld is
-- not a release — it is an unsecured payment wearing the word.

CREATE OR REPLACE FUNCTION ordence_guard_retention_release()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  withheld bigint;
  released bigint;
  dlp_ends date;
BEGIN
  SELECT COALESCE(SUM(retention_amount_minor), 0) INTO withheld
    FROM ra_bills
   WHERE tenant_id = NEW.tenant_id
     AND contract_id = NEW.contract_id
     AND status IN ('paid', 'approved');

  SELECT COALESCE(SUM(amount_minor), 0) INTO released
    FROM retention_releases
   WHERE tenant_id = NEW.tenant_id
     AND contract_id = NEW.contract_id
     AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF released + NEW.amount_minor > withheld THEN
    RAISE EXCEPTION
      'Cannot release that much retention. % has been withheld on this contract and % already released, leaving %. Releasing more than was withheld is not a release — it is an unsecured payment.',
      withheld, released, (withheld - released)
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Early release is allowed and noted. The reason column is NOT NULL,
  -- so an early release always carries an explanation.
  SELECT defect_liability_ends_on INTO dlp_ends
    FROM works_contracts WHERE id = NEW.contract_id;

  IF dlp_ends IS NOT NULL AND COALESCE(NEW.released_on, CURRENT_DATE) < dlp_ends THEN
    RAISE NOTICE
      'Retention released before the defect liability period ends on %. That is allowed, and it gives up the only leverage left over a contractor who has finished and gone. The reason recorded is: %',
      dlp_ends, NEW.reason;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_retention_release ON retention_releases;
CREATE TRIGGER trg_guard_retention_release
  BEFORE INSERT OR UPDATE ON retention_releases
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_retention_release();

-- ════════════════════════════════════════════════════════════════════
-- §8  updated_at
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ordence_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['works_contracts','compliance_docs','ra_bills'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_touch_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW
         EXECUTE FUNCTION ordence_touch_updated_at()', 'trg_touch_' || t, t);
  END LOOP;
END $$;


COMMIT;

-- ═════════════════════════════════════════════════════════════════════
--  PART 3 — THE CHECK   (look for PASS, eleven times)
-- ═════════════════════════════════════════════════════════════════════

SELECT 'Table exists: ' || t AS check_name,
       CASE WHEN to_regclass('public.' || t) IS NOT NULL THEN 'PASS'
            ELSE 'FAIL — not created' END AS result
FROM unnest(ARRAY['works_contracts','compliance_docs','engineer_certifications',
                  'ra_bills','ra_bill_lines','retention_releases']) AS t
UNION ALL
SELECT 'Every table has tenant isolation ON and FORCED',
       CASE WHEN count(*) = 6 THEN 'PASS' ELSE 'FAIL — only ' || count(*) || ' of 6' END
FROM pg_class c WHERE c.relname IN ('works_contracts','compliance_docs',
  'engineer_certifications','ra_bills','ra_bill_lines','retention_releases')
  AND c.relrowsecurity AND c.relforcerowsecurity
UNION ALL
SELECT 'Every table has an isolation policy',
       CASE WHEN count(*) = 6 THEN 'PASS' ELSE 'FAIL — only ' || count(*) || ' of 6' END
FROM pg_policies WHERE tablename IN ('works_contracts','compliance_docs',
  'engineer_certifications','ra_bills','ra_bill_lines','retention_releases')
UNION ALL
SELECT 'RA bill figures are calculated, not typed',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — missing' END
FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_compute_ra_bill'
UNION ALL
SELECT 'No payment without a verified EPF/ESI challan',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — the payment gate is missing' END
FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_ra_bill_compliance_gate'
UNION ALL
SELECT 'Retention cannot be over-released',
       CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — missing' END
FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_retention_release'
UNION ALL
SELECT 'A child row cannot be attached to another customer''s contract',
       CASE WHEN count(*) >= 4 THEN 'PASS' ELSE 'FAIL — only ' || count(*) END
FROM pg_constraint WHERE conname LIKE '%_tenant_fk'
  AND (conrelid::regclass::text LIKE 'ra_bill%'
    OR conrelid::regclass::text LIKE 'engineer%'
    OR conrelid::regclass::text LIKE 'retention%')
ORDER BY 2 DESC, 1;
