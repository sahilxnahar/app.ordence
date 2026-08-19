-- ============================================================================
-- Ordence — Phase 33: Purchases, Vendor Invoices and ⭐ Input Tax Credit
-- Version: v0.33.0-alpha
--
-- Run AFTER `ALL-IN-ONE-SETUP.sql`, `0017_change_log.sql` and
-- `0021_phase32_gst.sql`. It depends on `set_updated_at()`,
-- `app_current_tenant_id()`, `record_change()`, and on the Phase 32 tables
-- `gst_parties`, `gst_registrations`, `hsn_sac_codes` and `hsn_sac_rates`.
--
-- Safe to run before `drizzle-kit push`: Section 1 creates its own types and
-- tables idempotently. Safe to re-run: every statement is guarded.
--
-- Contents:
--   1.  Enums and tables
--   2.  ⭐ NO VENDOR BILL MAY BE ENTERED TWICE — the duplicate-claim defence
--   3.  Row-level security
--   4.  ⭐ Composite foreign keys — the hole RLS does NOT close
--   5.  ⭐ SECTION 17(5): THE DATABASE REFUSES THE EXPENSIVE MISTAKE
--   6.  ⭐ THE PURCHASE INVOICE MUST ADD UP — deferred, at commit
--   7.  ⭐ A CREDIT MAY NOT BE CLAIMED TWICE ACROSS PERIODS
--   8.  The Section 16(4) deadline, and the Indian financial year
--   9.  updated_at, and the change log
--   10. Grants
--   11. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Phase 32 enforced rules whose violation was invisible for years. This phase
-- enforces rules whose violation is invisible for years AND profitable in the
-- meantime, which is a materially worse combination — because the wrong answer
-- puts money in the bank today and takes it back with interest later.
--
--     A lorry of cement goes into the head office the company is building for
--     itself. Somebody books it the way they booked yesterday's cement, which
--     went into a tower whose flats are being sold. The credit is claimed. The
--     GSTR-3B files cleanly. The cash position improves by the tax. Nothing
--     errors, nothing looks different, and the mistake is worth ₹18 on every
--     ₹100 of cement.
--
--     Section 17(5)(d) blocks that credit outright. It is found at an audit,
--     with interest at 18% under Section 50 running from the date of the claim
--     and a penalty under Section 122. On a mid-size tower the blocked credit
--     runs to crores, because cement and steel and the main contractor's bill
--     ARE the cost of the building.
--
--     The same vendor bill entered twice — once by the site office from the
--     delivery copy, once by accounts from the emailed PDF — claims the credit
--     twice. Neither entry looks wrong. It surfaces when GSTR-2B shows one
--     invoice and our books show two, by which time the excess is utilised.
--
-- Neither can be caught by looking at the product. So they are caught here:
--
--   • Section 2 — a vendor's invoice number is unique per vendor per financial
--     year. The second entry is refused.
--   • Section 5 — a line booked to own-account construction may NOT carry an
--     eligible credit, and a blocked line must name its clause.
--   • Section 6 — the header's tax AND its ITC split must equal the sum of its
--     lines, at COMMIT.
--   • Section 7 — the credit claimed against a line, across ALL periods, net
--     of reversals, may never exceed the credit that line was determined to
--     have. This is the one the per-period unique index does not catch.
--
-- Money is bigint paise. Rates are integer basis points.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — ENUMS AND TABLES
-- ############################################################################
--
-- `drizzle-kit push` creates these from `db/schema/purchases.ts`. They are
-- restated here because a file that can only run second is a file that fails on
-- a fresh database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vendor_type') THEN
    CREATE TYPE vendor_type AS ENUM
      ('material_supplier','contractor','professional','transporter',
       'landlord','utility','government','other');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'msme_category') THEN
    CREATE TYPE msme_category AS ENUM ('micro','small','medium');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'purchase_invoice_status') THEN
    CREATE TYPE purchase_invoice_status AS ENUM
      ('draft','recorded','approved','paid','cancelled');
  END IF;

  -- ⭐ THE ENUM THE PHASE TURNS ON. See db/schema/purchases.ts for why
  -- `sold_before_completion` and `own_account_construction` are different
  -- values rather than a boolean: same cement, opposite answers.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'itc_purpose') THEN
    CREATE TYPE itc_purpose AS ENUM
      ('taxable_supply','sold_before_completion','own_account_construction',
       'further_supply_works_contract','plant_and_machinery','exempt_supply',
       'common','non_business');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'expenditure_nature') THEN
    CREATE TYPE expenditure_nature AS ENUM
      ('goods','input_service','capital_goods','motor_vehicle','vessel_or_aircraft',
       'motor_vehicle_related_service','food_and_beverage','outdoor_catering',
       'beauty_or_health_service','club_or_fitness_membership',
       'employee_travel_benefit','life_or_health_insurance','works_contract_service',
       'construction_material','rent_a_cab');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'itc_eligibility') THEN
    CREATE TYPE itc_eligibility AS ENUM ('eligible','blocked','proportionate');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'itc_block_reason') THEN
    CREATE TYPE itc_block_reason AS ENUM
      ('motor_vehicle','vessel_or_aircraft','vehicle_related_service',
       'food_beverage_catering','beauty_or_health_service','life_or_health_insurance',
       'club_membership','employee_travel_benefit','works_contract_immovable',
       'construction_own_account','composition_supplier','non_resident_supplier',
       'personal_consumption','lost_stolen_destroyed_gifted','confiscated_or_seized',
       'exempt_supply','notified_rate_without_itc','no_valid_tax_invoice');
  END IF;

  -- The letters of the Rule 42 formula, kept as the rule names them so the
  -- reversal in a return can be checked against the working.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rule42_attribution') THEN
    CREATE TYPE rule42_attribution AS ENUM
      ('exclusively_non_business','exclusively_exempt','blocked',
       'exclusively_taxable','common');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'itc_register_status') THEN
    CREATE TYPE itc_register_status AS ENUM
      ('claimed','blocked','deferred','reversed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'itc_movement_reason') THEN
    CREATE TYPE itc_movement_reason AS ENUM
      ('invoice_claim','rcm_self_assessed','section_17_5_blocked',
       'rule_42_common_reversal','rule_43_capital_reversal',
       'rule_37_non_payment_180_days','credit_note_received','goods_not_received',
       'supplier_not_filed','reclaim_after_payment','annual_true_up');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vendor_ledger_entry_type') THEN
    CREATE TYPE vendor_ledger_entry_type AS ENUM
      ('purchase_invoice','debit_note','credit_note','payment','advance',
       'tds_deducted','retention_held','retention_released','adjustment');
  END IF;
END
$$;


CREATE TABLE IF NOT EXISTS vendors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                 varchar(40)  NOT NULL,
  gst_party_id         uuid,
  company_id           uuid,
  legal_name           varchar(255) NOT NULL,
  trade_name           varchar(255),
  vendor_type          vendor_type NOT NULL DEFAULT 'other',
  pan_number           varchar(10),
  msme_registered      boolean NOT NULL DEFAULT false,
  udyam_number         varchar(19),
  msme_category        msme_category,
  msme_registered_on   date,
  payment_terms_days   integer NOT NULL DEFAULT 30,
  tds_applicable       boolean NOT NULL DEFAULT false,
  default_tds_section  varchar(12),
  bank_details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  address              jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active            boolean NOT NULL DEFAULT true,
  blocked_reason       text,
  notes                text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- ⚠️ An MSME claim without a Udyam number is not an MSME claim. Section
  -- 43B(h) reaches an enterprise REGISTERED under the MSMED Act; a vendor who
  -- merely says they are small is outside it, and putting them on the 45-day
  -- alarm is how a real alarm gets ignored.
  CONSTRAINT vendors_msme_complete
    CHECK ((NOT msme_registered)
           OR (udyam_number IS NOT NULL AND msme_category IS NOT NULL)),
  -- Udyam replaced the 12-digit Udyog Aadhaar in July 2020. A 12-digit number
  -- in this column is not verifiable on any portal.
  CONSTRAINT vendors_udyam_shape
    CHECK (udyam_number IS NULL OR udyam_number ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$'),
  CONSTRAINT vendors_pan_shape
    CHECK (pan_number IS NULL OR pan_number ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  -- ⭐ Section 15 of the MSMED Act caps the agreed period at 45 days and
  -- Section 32 voids any agreement to the contrary. A 90-day term against a
  -- micro vendor is not a commercial choice — it is a Section 43B(h)
  -- disallowance of the whole expenditure.
  CONSTRAINT vendors_terms_sane
    CHECK (payment_terms_days >= 0
           AND (NOT msme_registered OR msme_category = 'medium'
                OR payment_terms_days <= 45))
);


CREATE TABLE IF NOT EXISTS purchase_invoices (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id                 uuid NOT NULL,
  gst_party_id              uuid,
  recipient_registration_id uuid,
  recipient_gstin           varchar(15),
  recipient_state_code      varchar(2),
  supplier_gstin            varchar(15),
  supplier_state_code       varchar(2),
  invoice_number            varchar(64) NOT NULL,
  invoice_date              date NOT NULL,
  received_date             date,
  goods_received_date       date,
  is_bill_of_supply         boolean NOT NULL DEFAULT false,
  supply_type               gst_supply_type NOT NULL DEFAULT 'goods',
  place_of_supply_code      varchar(2),
  property_state_code       varchar(2),
  is_inter_state            boolean NOT NULL DEFAULT false,
  project_id                uuid,
  currency                  varchar(3) NOT NULL DEFAULT 'INR',
  subtotal_minor            bigint NOT NULL DEFAULT 0,
  discount_minor            bigint NOT NULL DEFAULT 0,
  taxable_value_minor       bigint NOT NULL DEFAULT 0,
  cgst_minor                bigint NOT NULL DEFAULT 0,
  sgst_minor                bigint NOT NULL DEFAULT 0,
  igst_minor                bigint NOT NULL DEFAULT 0,
  cess_minor                bigint NOT NULL DEFAULT 0,
  round_off_minor           bigint NOT NULL DEFAULT 0,
  total_minor               bigint NOT NULL DEFAULT 0,
  is_reverse_charge         boolean NOT NULL DEFAULT false,
  rcm_tax_minor             bigint NOT NULL DEFAULT 0,
  rcm_section               varchar(16),
  itc_eligible_tax_minor    bigint NOT NULL DEFAULT 0,
  itc_blocked_tax_minor     bigint NOT NULL DEFAULT 0,
  tax_period                varchar(7),
  is_tds_deductible         boolean NOT NULL DEFAULT false,
  tds_section               varchar(12),
  tds_base_minor            bigint NOT NULL DEFAULT 0,
  status                    purchase_invoice_status NOT NULL DEFAULT 'draft',
  gst_computed              boolean NOT NULL DEFAULT false,
  notes                     text,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT purchase_invoices_totals_balance
    CHECK (taxable_value_minor = subtotal_minor - discount_minor
           AND total_minor = taxable_value_minor
                           + cgst_minor + sgst_minor + igst_minor + cess_minor
                           + round_off_minor),
  -- ⭐ Every paisa of tax on a purchase is either claimable or blocked. A gap
  -- is credit that belongs to nobody: it reaches neither the return nor the
  -- cost of the building, and the two then differ by exactly that amount.
  CONSTRAINT purchase_invoices_itc_splits_exactly
    CHECK (itc_eligible_tax_minor + itc_blocked_tax_minor
           = cgst_minor + sgst_minor + igst_minor + cess_minor),
  CONSTRAINT purchase_invoices_non_negative
    CHECK (subtotal_minor >= 0 AND discount_minor >= 0
           AND cgst_minor >= 0 AND sgst_minor >= 0
           AND igst_minor >= 0 AND cess_minor >= 0
           AND rcm_tax_minor >= 0 AND tds_base_minor >= 0
           AND itc_eligible_tax_minor >= 0 AND itc_blocked_tax_minor >= 0),
  -- A supplier who charged both got the place of supply wrong; entering it as
  -- received doubles the credit claimed on one supply.
  CONSTRAINT purchase_invoices_heads_exclusive
    CHECK (NOT (igst_minor > 0 AND (cgst_minor > 0 OR sgst_minor > 0))),
  CONSTRAINT purchase_invoices_period_shape
    CHECK (tax_period IS NULL OR tax_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- ⭐ Section 12(3), on the inward side too. A credit taxed to the wrong
  -- state lands in a ledger with nothing to set it against.
  CONSTRAINT purchase_invoices_immovable_property_pos
    CHECK (supply_type <> 'immovable_property'
           OR (property_state_code IS NOT NULL
               AND place_of_supply_code IS NOT NULL
               AND place_of_supply_code = property_state_code)),
  -- A bill of supply carries no tax, so no credit can arise from it —
  -- Section 17(5)(e).
  CONSTRAINT purchase_invoices_bill_of_supply_no_tax
    CHECK (NOT is_bill_of_supply
           OR (cgst_minor = 0 AND sgst_minor = 0 AND igst_minor = 0 AND cess_minor = 0))
);


CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_invoice_id      uuid NOT NULL,
  line_number              integer NOT NULL,
  description              text NOT NULL,
  hsn_sac_id               uuid,
  hsn_sac_code             varchar(8),
  gst_rate_id              uuid,
  quantity                 numeric(18,3),
  uqc                      varchar(10),
  unit_price_minor         bigint,
  amount_minor             bigint NOT NULL,
  discount_minor           bigint NOT NULL DEFAULT 0,
  taxable_value_minor      bigint NOT NULL,
  rate_bps                 integer NOT NULL DEFAULT 0,
  cess_rate_bps            integer NOT NULL DEFAULT 0,
  cgst_minor               bigint NOT NULL DEFAULT 0,
  sgst_minor               bigint NOT NULL DEFAULT 0,
  igst_minor               bigint NOT NULL DEFAULT 0,
  cess_minor               bigint NOT NULL DEFAULT 0,
  is_reverse_charge        boolean NOT NULL DEFAULT false,
  expenditure_nature       expenditure_nature NOT NULL DEFAULT 'goods',
  itc_purpose              itc_purpose NOT NULL DEFAULT 'taxable_supply',
  project_id               uuid,
  itc_eligibility          itc_eligibility NOT NULL DEFAULT 'eligible',
  itc_block_reason         itc_block_reason,
  itc_statutory_ref        varchar(24),
  itc_eligible_tax_minor   bigint NOT NULL DEFAULT 0,
  itc_blocked_tax_minor    bigint NOT NULL DEFAULT 0,
  rule42_attribution       rule42_attribution NOT NULL DEFAULT 'exclusively_taxable',
  is_capital_goods         boolean NOT NULL DEFAULT false,
  itc_note                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT purchase_invoice_lines_taxable_consistent
    CHECK (taxable_value_minor = amount_minor - discount_minor),
  CONSTRAINT purchase_invoice_lines_non_negative
    CHECK (amount_minor >= 0 AND discount_minor >= 0
           AND cgst_minor >= 0 AND sgst_minor >= 0
           AND igst_minor >= 0 AND cess_minor >= 0
           AND rate_bps >= 0 AND cess_rate_bps >= 0
           AND itc_eligible_tax_minor >= 0 AND itc_blocked_tax_minor >= 0),
  CONSTRAINT purchase_invoice_lines_heads_exclusive
    CHECK (NOT (igst_minor > 0 AND (cgst_minor > 0 OR sgst_minor > 0))),
  CONSTRAINT purchase_invoice_lines_itc_splits_exactly
    CHECK (itc_eligible_tax_minor + itc_blocked_tax_minor
           = cgst_minor + sgst_minor + igst_minor + cess_minor),
  CONSTRAINT purchase_invoice_lines_itc_split_matches_verdict
    CHECK ((itc_eligibility = 'blocked' AND itc_eligible_tax_minor = 0)
        OR (itc_eligibility <> 'blocked' AND itc_blocked_tax_minor = 0)),
  -- "Blocked" without a clause is an assertion, not a determination. At an
  -- assessment the question is never "is it blocked" but "under which clause",
  -- and a register that cannot answer loses the credit by default.
  CONSTRAINT purchase_invoice_lines_block_reason_presence
    CHECK ((itc_eligibility = 'blocked' AND itc_block_reason IS NOT NULL)
        OR (itc_eligibility <> 'blocked' AND itc_block_reason IS NULL)),
  -- ⚠️ "Blocked" maps to THREE letters of the Rule 42 formula, not one: T1
  -- (non-business), T2 (exclusively exempt) and T3 (Section 17(5)). The
  -- obvious check — attribution='blocked' ⇔ eligibility='blocked' — would
  -- refuse every 17(5)(g) and every Section 17(2) line in the system.
  CONSTRAINT purchase_invoice_lines_verdict_matches_attribution
    CHECK ((itc_eligibility = 'blocked')
           = (rule42_attribution IN ('blocked','exclusively_non_business',
                                     'exclusively_exempt'))),
  CONSTRAINT purchase_invoice_lines_eligible_attribution
    CHECK ((itc_eligibility = 'eligible') = (rule42_attribution = 'exclusively_taxable')),
  CONSTRAINT purchase_invoice_lines_common_implies_proportionate
    CHECK ((rule42_attribution = 'common') = (itc_eligibility = 'proportionate'))
);


CREATE TABLE IF NOT EXISTS itc_register (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  registration_id           uuid,
  tax_period                varchar(7) NOT NULL,
  purchase_invoice_id       uuid,
  purchase_invoice_line_id  uuid,
  vendor_id                 uuid,
  project_id                uuid,
  status                    itc_register_status NOT NULL,
  reason                    itc_movement_reason NOT NULL,
  statutory_ref             varchar(24),
  note                      text,
  cgst_minor                bigint NOT NULL DEFAULT 0,
  sgst_minor                bigint NOT NULL DEFAULT 0,
  igst_minor                bigint NOT NULL DEFAULT 0,
  cess_minor                bigint NOT NULL DEFAULT 0,
  filed_at                  timestamptz,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT itc_register_period_shape
    CHECK (tax_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT itc_register_non_negative
    CHECK (cgst_minor >= 0 AND sgst_minor >= 0 AND igst_minor >= 0 AND cess_minor >= 0),
  -- A register full of nil rows makes "was this credit ever claimed?" a
  -- question about reading amounts rather than about finding a row.
  CONSTRAINT itc_register_not_empty
    CHECK (cgst_minor + sgst_minor + igst_minor + cess_minor > 0),
  CONSTRAINT itc_register_line_implies_invoice
    CHECK (purchase_invoice_line_id IS NULL OR purchase_invoice_id IS NOT NULL),
  -- Rule 42/43 reversals are computed on a whole period and legitimately have
  -- no line. Nothing else may.
  CONSTRAINT itc_register_period_level_is_reversal
    CHECK (purchase_invoice_line_id IS NOT NULL
           OR reason IN ('rule_42_common_reversal','rule_43_capital_reversal',
                         'annual_true_up'))
);


CREATE TABLE IF NOT EXISTS vendor_ledger_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id            uuid NOT NULL,
  entry_date           date NOT NULL,
  entry_type           vendor_ledger_entry_type NOT NULL,
  purchase_invoice_id  uuid,
  reference_number     varchar(80),
  description          text,
  debit_minor          bigint NOT NULL DEFAULT 0,
  credit_minor         bigint NOT NULL DEFAULT 0,
  due_date             date,
  exclude_from_ageing  boolean NOT NULL DEFAULT false,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vendor_ledger_entries_non_negative
    CHECK (debit_minor >= 0 AND credit_minor >= 0),
  -- ⚠️ Exactly one side. An entry carrying both is a net figure somebody
  -- worked out by hand, and the working is gone — the gross movements are what
  -- a vendor reconciles their own ledger against.
  CONSTRAINT vendor_ledger_entries_exactly_one_side
    CHECK ((debit_minor > 0) <> (credit_minor > 0))
);


-- ---------------------------------------------------------------------------
-- 1b. Indexes
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS vendors_code_tenant_unique ON vendors (tenant_id, code);
CREATE INDEX IF NOT EXISTS vendors_tenant_idx  ON vendors (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS vendors_party_idx   ON vendors (tenant_id, gst_party_id);
CREATE INDEX IF NOT EXISTS vendors_company_idx ON vendors (tenant_id, company_id);
CREATE INDEX IF NOT EXISTS vendors_msme_idx
  ON vendors (tenant_id, msme_category) WHERE msme_registered;

CREATE INDEX IF NOT EXISTS purchase_invoices_tenant_idx
  ON purchase_invoices (tenant_id, status);
CREATE INDEX IF NOT EXISTS purchase_invoices_vendor_idx
  ON purchase_invoices (tenant_id, vendor_id, invoice_date);
CREATE INDEX IF NOT EXISTS purchase_invoices_period_idx
  ON purchase_invoices (tenant_id, tax_period);
CREATE INDEX IF NOT EXISTS purchase_invoices_project_idx
  ON purchase_invoices (tenant_id, project_id);
-- ⭐ The GSTR-2B match key Phase 34 joins on.
CREATE INDEX IF NOT EXISTS purchase_invoices_match_idx
  ON purchase_invoices (tenant_id, supplier_gstin, invoice_number, invoice_date);

CREATE INDEX IF NOT EXISTS purchase_invoice_lines_invoice_idx
  ON purchase_invoice_lines (tenant_id, purchase_invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoice_lines_number_unique
  ON purchase_invoice_lines (purchase_invoice_id, line_number);
CREATE INDEX IF NOT EXISTS purchase_invoice_lines_itc_idx
  ON purchase_invoice_lines (tenant_id, itc_eligibility, itc_purpose);
CREATE INDEX IF NOT EXISTS purchase_invoice_lines_project_idx
  ON purchase_invoice_lines (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS purchase_invoice_lines_rate_idx
  ON purchase_invoice_lines (tenant_id, gst_rate_id);

CREATE INDEX IF NOT EXISTS itc_register_period_idx
  ON itc_register (tenant_id, tax_period, status);
CREATE INDEX IF NOT EXISTS itc_register_line_idx
  ON itc_register (tenant_id, purchase_invoice_line_id);
CREATE INDEX IF NOT EXISTS itc_register_invoice_idx
  ON itc_register (tenant_id, purchase_invoice_id);
CREATE INDEX IF NOT EXISTS itc_register_vendor_idx
  ON itc_register (tenant_id, vendor_id);
CREATE INDEX IF NOT EXISTS itc_register_registration_idx
  ON itc_register (tenant_id, registration_id, tax_period);

-- ⚠️ NOT the double-claim defence — see Section 7. This only stops the same
-- line being claimed twice IN ONE MONTH (a re-run of the period build).
CREATE UNIQUE INDEX IF NOT EXISTS itc_register_one_movement_per_period
  ON itc_register (tenant_id, purchase_invoice_line_id, tax_period, status, reason)
  WHERE purchase_invoice_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS vendor_ledger_vendor_date_idx
  ON vendor_ledger_entries (tenant_id, vendor_id, entry_date);
CREATE INDEX IF NOT EXISTS vendor_ledger_invoice_idx
  ON vendor_ledger_entries (tenant_id, purchase_invoice_id);
CREATE INDEX IF NOT EXISTS vendor_ledger_due_idx
  ON vendor_ledger_entries (tenant_id, due_date);


-- ############################################################################
-- SECTION 2 — ⭐ NO VENDOR BILL MAY BE ENTERED TWICE
-- ############################################################################
--
-- THE MOST VALUABLE INDEX IN THE PHASE, AND THE CHEAPEST.
--
--     The site office enters the contractor's bill from the delivery copy on
--     Tuesday. Accounts enters the same bill from the emailed PDF on Friday.
--     Neither entry looks wrong. The credit is claimed twice, the vendor
--     balance is doubled, and the payment run pays it twice.
--
-- The uniqueness that matters is (vendor, their invoice number, their
-- financial year) — NOT our own voucher number, which is different on both
-- entries by construction.
--
-- ⚠️ WHY THE FINANCIAL YEAR IS PART OF THE KEY. Rule 46(b) makes a supplier's
-- serial unique for a FINANCIAL year, so "INV/001" legitimately recurs every
-- April. A key without the year would refuse a genuine second-year invoice and
-- push somebody into prefixing it by hand — at which point the duplicate
-- defence is defeated by the workaround.
--
-- ⚠️ AND WHY `upper(trim(...))`. Vendors are inconsistent about case and
-- spacing between the two copies of their own document: "inv/2024/001" and
-- "INV/2024/001 " are the same bill and would otherwise both be accepted.
--
-- ⚠️ CANCELLED DOCUMENTS ARE EXCLUDED. A bill entered wrongly, cancelled and
-- re-entered correctly is ordinary work. The cancelled row stays — it may
-- already have fed a return — and must not block the correction.

CREATE OR REPLACE FUNCTION indian_financial_year(p_day date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- The Indian financial year runs 1 April to 31 March. A calendar-year
  -- key would reset three months late and merge two years of serials.
  SELECT CASE
           WHEN extract(month FROM p_day) >= 4
             THEN extract(year FROM p_day)::int
           ELSE extract(year FROM p_day)::int - 1
         END::text
      || '-' ||
         lpad(((CASE
                  WHEN extract(month FROM p_day) >= 4
                    THEN extract(year FROM p_day)::int + 1
                  ELSE extract(year FROM p_day)::int
                END) % 100)::text, 2, '0');
$$;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_no_duplicate_bill
  ON purchase_invoices (
    tenant_id,
    vendor_id,
    upper(btrim(invoice_number)),
    indian_financial_year(invoice_date)
  )
  WHERE status <> 'cancelled';


-- ############################################################################
-- SECTION 3 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER too, which
-- is the half everybody forgets: without it the role that created the table
-- reads everything and the policies look like they are working.
--
-- ⚠️ NO `app_is_platform_scope()` ON ANY POLICY HERE. A tenant's purchase
-- ledger is who they buy from, at what price, on what terms — the most
-- commercially sensitive table in the product after the sales pipeline. Its
-- ITC register is their tax position. Platform staff have no business reading
-- either.

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendors_tenant_isolation ON vendors;
CREATE POLICY vendors_tenant_isolation ON vendors
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE purchase_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_invoices FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_invoices_tenant_isolation ON purchase_invoices;
CREATE POLICY purchase_invoices_tenant_isolation ON purchase_invoices
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE purchase_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_invoice_lines FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_invoice_lines_tenant_isolation ON purchase_invoice_lines;
CREATE POLICY purchase_invoice_lines_tenant_isolation ON purchase_invoice_lines
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE itc_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE itc_register FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS itc_register_tenant_isolation ON itc_register;
CREATE POLICY itc_register_tenant_isolation ON itc_register
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE vendor_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_ledger_entries FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_ledger_entries_tenant_isolation ON vendor_ledger_entries;
CREATE POLICY vendor_ledger_entries_tenant_isolation ON vendor_ledger_entries
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 4 — ⭐ COMPOSITE FOREIGN KEYS
-- ############################################################################
--
-- ⚠️ FOREIGN-KEY CHECKS RUN AS THE SYSTEM AND IGNORE ROW-LEVEL SECURITY. That
-- is documented PostgreSQL behaviour and it is why every pointer in this phase
-- is a COMPOSITE key on (col, tenant_id).
--
-- The shape of the hole, concretely for this phase:
--
--     Tenant A inserts a purchase invoice line with
--         tenant_id   = A                          ← passes WITH CHECK
--         gst_rate_id = <a rate row owned by B>    ← passes a single-column FK
--
--     A's purchase is now checked against B's rate master. Worse, with
--     `project_id`: a line claiming credit against ANOTHER TENANT'S project is
--     a cross-tenant existence oracle, and the evidence trail for the single
--     most valuable determination in the phase points at a building that
--     belongs to somebody else.

CREATE UNIQUE INDEX IF NOT EXISTS vendors_id_tenant_key
  ON vendors (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_id_tenant_key
  ON purchase_invoices (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoice_lines_id_tenant_key
  ON purchase_invoice_lines (id, tenant_id);

-- Parents in earlier phases. Created idempotently so this file does not depend
-- on the order the SQL directory is applied in.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_key            ON users (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS companies_id_tenant_key        ON companies (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_tenant_key         ON projects (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS gst_parties_id_tenant_key      ON gst_parties (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS gst_registrations_id_tenant_key ON gst_registrations (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS hsn_sac_codes_id_tenant_key    ON hsn_sac_codes (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS hsn_sac_rates_id_tenant_key    ON hsn_sac_rates (id, tenant_id);

DO $$
BEGIN
  /* --- vendors -------------------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_party_same_tenant') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_party_same_tenant
      FOREIGN KEY (gst_party_id, tenant_id) REFERENCES gst_parties (id, tenant_id)
      -- SET NULL, not CASCADE: the commercial relationship, its balance and
      -- the credits already claimed outlive a tax-identity row.
      ON DELETE SET NULL (gst_party_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_company_same_tenant') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_company_same_tenant
      FOREIGN KEY (company_id, tenant_id) REFERENCES companies (id, tenant_id)
      ON DELETE SET NULL (company_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_created_by_same_tenant') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  /* --- purchase_invoices ---------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoices_vendor_same_tenant') THEN
    ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_vendor_same_tenant
      FOREIGN KEY (vendor_id, tenant_id) REFERENCES vendors (id, tenant_id)
      -- ⚠️ RESTRICT. A vendor with a filed return behind them can never be
      -- removed: the credit claimed against their bills is evidence.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoices_party_same_tenant') THEN
    ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_party_same_tenant
      FOREIGN KEY (gst_party_id, tenant_id) REFERENCES gst_parties (id, tenant_id)
      ON DELETE SET NULL (gst_party_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoices_registration_same_tenant') THEN
    ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_registration_same_tenant
      FOREIGN KEY (recipient_registration_id, tenant_id)
      REFERENCES gst_registrations (id, tenant_id)
      -- ⚠️ RESTRICT. The credit landed in THAT GSTIN's electronic credit
      -- ledger. Losing the pointer loses which state the credit is in.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoices_project_same_tenant') THEN
    ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_project_same_tenant
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      ON DELETE SET NULL (project_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoices_created_by_same_tenant') THEN
    ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  /* --- purchase_invoice_lines ----------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoice_lines_invoice_same_tenant') THEN
    ALTER TABLE purchase_invoice_lines
      ADD CONSTRAINT purchase_invoice_lines_invoice_same_tenant
      FOREIGN KEY (purchase_invoice_id, tenant_id)
      REFERENCES purchase_invoices (id, tenant_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoice_lines_hsn_same_tenant') THEN
    ALTER TABLE purchase_invoice_lines
      ADD CONSTRAINT purchase_invoice_lines_hsn_same_tenant
      FOREIGN KEY (hsn_sac_id, tenant_id) REFERENCES hsn_sac_codes (id, tenant_id)
      ON DELETE SET NULL (hsn_sac_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoice_lines_rate_same_tenant') THEN
    ALTER TABLE purchase_invoice_lines
      ADD CONSTRAINT purchase_invoice_lines_rate_same_tenant
      FOREIGN KEY (gst_rate_id, tenant_id) REFERENCES hsn_sac_rates (id, tenant_id)
      -- ⭐ RESTRICT, the same rule as on the outward side. The rate period a
      -- purchase was checked against is the evidence that the supplier's
      -- charge was correct — or that it was not.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_invoice_lines_project_same_tenant') THEN
    ALTER TABLE purchase_invoice_lines
      ADD CONSTRAINT purchase_invoice_lines_project_same_tenant
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      ON DELETE SET NULL (project_id);
  END IF;

  /* --- itc_register --------------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'itc_register_registration_same_tenant') THEN
    ALTER TABLE itc_register ADD CONSTRAINT itc_register_registration_same_tenant
      FOREIGN KEY (registration_id, tenant_id)
      REFERENCES gst_registrations (id, tenant_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'itc_register_invoice_same_tenant') THEN
    ALTER TABLE itc_register ADD CONSTRAINT itc_register_invoice_same_tenant
      FOREIGN KEY (purchase_invoice_id, tenant_id)
      REFERENCES purchase_invoices (id, tenant_id)
      -- ⚠️ RESTRICT. A purchase invoice whose credit has reached a return
      -- cannot be deleted; the register is the evidence it was claimed.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'itc_register_line_same_tenant') THEN
    ALTER TABLE itc_register ADD CONSTRAINT itc_register_line_same_tenant
      FOREIGN KEY (purchase_invoice_line_id, tenant_id)
      REFERENCES purchase_invoice_lines (id, tenant_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'itc_register_vendor_same_tenant') THEN
    ALTER TABLE itc_register ADD CONSTRAINT itc_register_vendor_same_tenant
      FOREIGN KEY (vendor_id, tenant_id) REFERENCES vendors (id, tenant_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'itc_register_project_same_tenant') THEN
    ALTER TABLE itc_register ADD CONSTRAINT itc_register_project_same_tenant
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      ON DELETE SET NULL (project_id);
  END IF;

  /* --- vendor_ledger_entries ------------------------------------ */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_ledger_vendor_same_tenant') THEN
    ALTER TABLE vendor_ledger_entries ADD CONSTRAINT vendor_ledger_vendor_same_tenant
      FOREIGN KEY (vendor_id, tenant_id) REFERENCES vendors (id, tenant_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_ledger_invoice_same_tenant') THEN
    ALTER TABLE vendor_ledger_entries ADD CONSTRAINT vendor_ledger_invoice_same_tenant
      FOREIGN KEY (purchase_invoice_id, tenant_id)
      REFERENCES purchase_invoices (id, tenant_id) ON DELETE CASCADE;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — ⭐ SECTION 17(5): THE DATABASE REFUSES THE EXPENSIVE MISTAKE
-- ############################################################################
--
-- THE CONSTRAINT THIS PHASE EXISTS FOR.
--
-- A line whose purpose is construction of an immovable property ON OUR OWN
-- ACCOUNT may never carry an eligible credit. Section 17(5)(d) admits one
-- exception — plant and machinery — and plant and machinery is a DIFFERENT
-- value of `itc_purpose`, so it is unreachable from here by construction.
--
-- ⚠️ WHY THE DATABASE AND NOT JUST `lib/purchases/itc.ts`. The engine is ONE
-- write path of four. An import of a year of historical purchase bills, a
-- correction at a psql prompt, and a future API route are the others — and
-- every one of them will be written by somebody who has yesterday's eligible
-- answer in their head. The engine gets it right; the import is where it goes
-- wrong, and the import is where the volume is.
--
-- ⚠️ AND WHY IT IS A CHECK RATHER THAN A TRIGGER: a CHECK is validated against
-- every EXISTING row when it is added, so a migration onto historical data
-- fails loudly rather than leaving the wrong rows in place. That is the right
-- trade here, because a pre-existing wrong row is exactly the thing that has
-- to be found.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'purchase_invoice_lines_own_account_blocked') THEN
    ALTER TABLE purchase_invoice_lines
      ADD CONSTRAINT purchase_invoice_lines_own_account_blocked
      CHECK (itc_purpose <> 'own_account_construction'
             OR (itc_eligibility = 'blocked'
                 AND itc_block_reason = 'construction_own_account'));
  END IF;
END
$$;

-- ⭐ And its mirror: a line the register CLAIMS must be a line the
-- determination found eligible.
--
-- The check above stops the wrong determination being STORED. This stops the
-- right determination being IGNORED — a register row that claims credit
-- against a line whose verdict is `blocked`. That is the shape a period build
-- takes when somebody "fixes" it to make the totals agree with a spreadsheet.

CREATE OR REPLACE FUNCTION enforce_itc_claim_matches_determination()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_eligibility   itc_eligibility;
  v_block_reason  itc_block_reason;
  v_eligible      bigint;
BEGIN
  IF NEW.purchase_invoice_line_id IS NULL OR NEW.status <> 'claimed' THEN
    RETURN NEW;
  END IF;

  SELECT l.itc_eligibility, l.itc_block_reason, l.itc_eligible_tax_minor
    INTO v_eligibility, v_block_reason, v_eligible
    FROM purchase_invoice_lines l
   WHERE l.id = NEW.purchase_invoice_line_id;

  -- Invisible under RLS, or deleted later in the same transaction. The
  -- composite foreign key already refuses the cross-tenant case.
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_eligibility = 'blocked' THEN
    RAISE EXCEPTION
      'This line was determined BLOCKED under Section %, so no input tax credit '
      'may be claimed against it. The determination is the record of why the '
      'credit was not taken; claiming it anyway puts the tax in a return with '
      'nothing to support it, and interest under Section 50 runs from the date '
      'of the claim.',
      COALESCE(v_block_reason::text, '17(5)')
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS itc_register_claim_matches_determination ON itc_register;
CREATE TRIGGER itc_register_claim_matches_determination
  BEFORE INSERT OR UPDATE ON itc_register
  FOR EACH ROW EXECUTE FUNCTION enforce_itc_claim_matches_determination();


-- ############################################################################
-- SECTION 6 — ⭐ THE PURCHASE INVOICE MUST ADD UP
-- ############################################################################
--
-- `purchase_invoices_totals_balance` (Section 1) proves the HEADER is
-- internally consistent. It says nothing about whether the header agrees with
-- its LINES, and that is where the drift happens: the header is written by one
-- statement and the lines by another, and a partially-updated document
-- balances perfectly while carrying tax no line accounts for.
--
-- ⚠️ TWO IDENTITIES ARE CHECKED, NOT ONE, AND THE SECOND IS THE VALUABLE ONE.
--
--   a) the tax heads equal the sum of the lines. Anybody reading the invoice
--      would catch this eventually.
--   b) ⭐ the ITC SPLIT equals the sum of the per-line determinations. Nobody
--      would ever catch this: the eligible figure goes into a GSTR-3B, the
--      blocked figure is capitalised into the cost of a building, and if they
--      do not together equal the tax on the document then some tax reached
--      neither. The return and the books then differ by exactly that amount,
--      permanently, and no screen anywhere shows it.
--
-- ⚠️ A CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, AND IT HAS TO BE. A
-- BEFORE INSERT trigger on `purchase_invoices` fires before any line exists and
-- would refuse every invoice ever created. COMMIT is the only point at which
-- the header and its lines are both present and both final.
--
-- ⚠️ IT ONLY FIRES ON `gst_computed` DOCUMENTS, exactly as the Phase 32 one
-- does. An import of legacy bills with header totals only is not refused; a
-- document that declares the Phase 33 engine produced it must add up.

CREATE OR REPLACE FUNCTION enforce_purchase_invoice_reconciles()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_inv        purchase_invoices%ROWTYPE;
  v_taxable    bigint;
  v_cgst       bigint;
  v_sgst       bigint;
  v_igst       bigint;
  v_cess       bigint;
  v_eligible   bigint;
  v_blocked    bigint;
BEGIN
  IF TG_TABLE_NAME = 'purchase_invoices' THEN
    v_inv := NEW;
  ELSE
    SELECT * INTO v_inv FROM purchase_invoices WHERE id = NEW.purchase_invoice_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;

  IF NOT COALESCE(v_inv.gst_computed, false) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(l.taxable_value_minor), 0),
         COALESCE(sum(l.cgst_minor), 0),
         COALESCE(sum(l.sgst_minor), 0),
         COALESCE(sum(l.igst_minor), 0),
         COALESCE(sum(l.cess_minor), 0),
         COALESCE(sum(l.itc_eligible_tax_minor), 0),
         COALESCE(sum(l.itc_blocked_tax_minor), 0)
    INTO v_taxable, v_cgst, v_sgst, v_igst, v_cess, v_eligible, v_blocked
    FROM purchase_invoice_lines l
   WHERE l.purchase_invoice_id = v_inv.id;

  IF v_taxable <> v_inv.taxable_value_minor THEN
    RAISE EXCEPTION
      'Purchase invoice % from this vendor does not add up: the lines total % '
      'paise of taxable value and the invoice says %. That figure is the one a '
      'GSTR-2B reconciliation matches on, so a document that disagrees with its '
      'own lines will never match.',
      v_inv.invoice_number, v_taxable, v_inv.taxable_value_minor
      USING ERRCODE = '23514';
  END IF;

  IF v_cgst <> v_inv.cgst_minor OR v_sgst <> v_inv.sgst_minor
     OR v_igst <> v_inv.igst_minor OR v_cess <> v_inv.cess_minor THEN
    RAISE EXCEPTION
      'Purchase invoice % does not add up: the lines carry CGST %, SGST %, IGST '
      '%, cess %, and the invoice says CGST %, SGST %, IGST %, cess %.',
      v_inv.invoice_number, v_cgst, v_sgst, v_igst, v_cess,
      v_inv.cgst_minor, v_inv.sgst_minor, v_inv.igst_minor, v_inv.cess_minor
      USING ERRCODE = '23514';
  END IF;

  -- ⭐ THE ONE NOBODY WOULD OTHERWISE CATCH.
  IF v_eligible <> v_inv.itc_eligible_tax_minor
     OR v_blocked <> v_inv.itc_blocked_tax_minor THEN
    RAISE EXCEPTION
      'Purchase invoice %: the input tax credit on the document does not match '
      'the per-line determinations. The lines determine % paise eligible and % '
      'paise blocked; the invoice says % and %. The eligible figure goes into a '
      'return and the blocked figure into the cost of a building — if they do '
      'not agree with the lines, some tax has reached neither and nothing '
      'anywhere would report the gap.',
      v_inv.invoice_number, v_eligible, v_blocked,
      v_inv.itc_eligible_tax_minor, v_inv.itc_blocked_tax_minor
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS purchase_invoices_reconciles ON purchase_invoices;
CREATE CONSTRAINT TRIGGER purchase_invoices_reconciles
  AFTER INSERT OR UPDATE ON purchase_invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_purchase_invoice_reconciles();

DROP TRIGGER IF EXISTS purchase_invoice_lines_reconciles ON purchase_invoice_lines;
CREATE CONSTRAINT TRIGGER purchase_invoice_lines_reconciles
  AFTER INSERT OR UPDATE ON purchase_invoice_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_purchase_invoice_reconciles();


-- ############################################################################
-- SECTION 7 — ⭐ A CREDIT MAY NOT BE CLAIMED TWICE ACROSS PERIODS
-- ############################################################################
--
-- THE DEFENCE THE UNIQUE INDEX DOES NOT PROVIDE.
--
-- `itc_register_one_movement_per_period` stops one line being claimed twice in
-- ONE month. The expensive case is different and passes that index cleanly:
--
--     A contractor's bill is entered in April and the period build claims the
--     credit. In June somebody re-runs the build over a wider date range, or
--     re-enters the bill against a corrected project, and the credit is
--     claimed again — in a DIFFERENT period. Two rows, two months, two
--     perfectly valid unique keys, and the same rupee claimed twice.
--
-- The invariant that catches it is cumulative and holds across all time:
--
--     Σ(claimed) − Σ(reversed)  ≤  the line's determined eligible credit
--
-- ⚠️ IT IS A SUBTRACTION AND NOT `Σ(claimed) ≤ eligible`, BECAUSE RE-CLAIMING
-- IS LAWFUL. A credit reversed under Rule 37 (supplier not paid within 180
-- days) is re-availed once payment is made, and GSTR-3B puts it back in the
-- SAME box as an ordinary availment. A rule that counted gross claims would
-- refuse a legitimate re-claim, and the workaround — editing the original row
-- — would destroy the history the register exists to keep.
--
-- ⚠️ DEFERRED TO COMMIT, so a period build that reverses and re-claims in one
-- transaction is judged on its net effect rather than on the order of its
-- statements.

CREATE OR REPLACE FUNCTION enforce_itc_not_claimed_twice()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_line_id   uuid;
  v_claimed   bigint;
  v_reversed  bigint;
  v_eligible  bigint;
  v_number    varchar(64);
BEGIN
  v_line_id := COALESCE(NEW.purchase_invoice_line_id, OLD.purchase_invoice_line_id);
  IF v_line_id IS NULL THEN RETURN NULL; END IF;

  SELECT l.itc_eligible_tax_minor, i.invoice_number
    INTO v_eligible, v_number
    FROM purchase_invoice_lines l
    JOIN purchase_invoices i ON i.id = l.purchase_invoice_id
   WHERE l.id = v_line_id;

  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(cgst_minor + sgst_minor + igst_minor + cess_minor)
                    FILTER (WHERE status = 'claimed'), 0),
         COALESCE(sum(cgst_minor + sgst_minor + igst_minor + cess_minor)
                    FILTER (WHERE status = 'reversed'), 0)
    INTO v_claimed, v_reversed
    FROM itc_register
   WHERE purchase_invoice_line_id = v_line_id;

  IF (v_claimed - v_reversed) > v_eligible THEN
    RAISE EXCEPTION
      'Input tax credit on a line of purchase invoice % has been claimed % paise '
      'net of reversals, but the determination allows only % paise. The same '
      'credit has been claimed in more than one tax period. Nothing about either '
      'claim looks wrong on its own — it is found when GSTR-2B shows one invoice '
      'and the books show two, by which time the excess has been utilised.',
      v_number, v_claimed - v_reversed, v_eligible
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS itc_register_not_claimed_twice ON itc_register;
CREATE CONSTRAINT TRIGGER itc_register_not_claimed_twice
  AFTER INSERT OR UPDATE OR DELETE ON itc_register
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_itc_not_claimed_twice();


-- ############################################################################
-- SECTION 8 — THE SECTION 16(4) DEADLINE
-- ############################################################################
--
-- Section 16(4): a credit for an invoice may not be taken after 30 November
-- following the end of the financial year in which the invoice was issued, or
-- the date of filing the annual return for that year, whichever is EARLIER.
--
-- ⚠️ IT IS A CLIFF, NOT A TAPER. A credit claimed one month late is not
-- reduced or penalised — it is simply not available, permanently, and the money
-- is gone. The invoices most likely to be late are exactly the large ones,
-- because a large bill is the one that sits in a dispute for eight months.
--
-- ⚠️ A FUNCTION AND A WARNING, NOT A CONSTRAINT, AND THE RESTRAINT IS
-- DELIBERATE. Successive amnesties and notifications have reopened the window
-- for particular years, and Section 16(5)/(6) inserted in 2024 extended it
-- retrospectively for 2017-18 to 2020-21. A hard CHECK would refuse a claim the
-- Government had just permitted, in the week that mattered, with no way round
-- it but a migration.

CREATE OR REPLACE FUNCTION itc_claim_deadline_period(p_invoice_date date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (CASE
            WHEN extract(month FROM p_invoice_date) >= 4
              THEN extract(year FROM p_invoice_date)::int + 1
            ELSE extract(year FROM p_invoice_date)::int
          END)::text || '-11';
$$;


-- ############################################################################
-- SECTION 9 — ⭐ SUPPORT SESSIONS MAY NOT DELETE TAX RECORDS
-- ############################################################################
--
-- Phase 17 installed `refuse_delete_under_impersonation()` and attached it to
-- nineteen tables holding customer records, money and access. These five join
-- them, and the argument is stronger here than for most of that list.
--
-- ⚠️ DELETION IS THE ONE FORBIDDEN OPERATION A CUSTOMER CANNOT DETECT
-- AFTERWARDS. A deleted contact leaves no trace in their UI. A deleted
-- purchase invoice leaves no trace either — and it also removes the evidence
-- for a credit that has already been claimed in a return the Government holds
-- a copy of. The customer's books would then show less input tax than their
-- own GSTR-3B, in a direction that looks like under-claiming, and the
-- reconciliation in Phase 34 would report a discrepancy with no cause.
--
-- ⚠️ AND IT IS A TRIGGER RATHER THAN A GATE FOR THE USUAL REASON: it is the
-- one refusal that does not depend on a developer remembering to call the
-- TypeScript check at a new call site.
--
-- `itc_register` and `vendor_ledger_entries` also have no DELETE grant at all
-- (Section 10), so this is the second of two locks on them. That is deliberate
-- — the grant protects against the application, the trigger against a session
-- that has legitimately been given the application's rights.
--
-- Written with a `to_regclass` check so the file stays runnable against a
-- database where Phase 17 has not been applied.

DO $$
DECLARE
  guarded text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'refuse_delete_under_impersonation') THEN
    FOREACH guarded IN ARRAY ARRAY[
      'vendors', 'purchase_invoices', 'purchase_invoice_lines',
      'itc_register', 'vendor_ledger_entries'
    ]
    LOOP
      IF to_regclass('public.' || guarded) IS NOT NULL THEN
        EXECUTE format(
          'DROP TRIGGER IF EXISTS %I ON %I', 'no_delete_under_impersonation', guarded
        );
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW '
          'EXECUTE FUNCTION refuse_delete_under_impersonation()',
          'no_delete_under_impersonation', guarded
        );
      END IF;
    END LOOP;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 9b — updated_at, AND THE CHANGE LOG
-- ############################################################################

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendors','purchase_invoices','purchase_invoice_lines',
                           'itc_register','vendor_ledger_entries']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_set_updated_at', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t || '_set_updated_at', t);
  END LOOP;

  -- ⚠️ ATTACHED HERE rather than left to 0017, which discovers tenant-scoped
  -- tables only when it is re-run — and a deployment applying files in
  -- numerical order runs it BEFORE these exist.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_change') THEN
    FOREACH t IN ARRAY ARRAY['vendors','purchase_invoices','purchase_invoice_lines',
                             'itc_register','vendor_ledger_entries']
    LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_change_log', t);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION record_change()',
        t || '_change_log', t);
    END LOOP;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 10 — GRANTS
-- ############################################################################
--
-- REVOKE before GRANT. An additive-only block is defeated by any prior
-- `GRANT ALL ON ALL TABLES`, which is the first thing most people run when a
-- query fails with "permission denied". Found the hard way in Phase 11.
--
-- ⚠️ NO DELETE ON `itc_register`, AND THAT IS THE POINT OF THE TABLE.
--
-- A return, once filed, cannot be unfiled. The register is the record of what
-- went into it, and a register that could be tidied would let this month's
-- figures stop agreeing with the GSTR-3B already submitted — with nothing
-- anywhere to show that they once did. A movement is corrected by a further
-- movement, which is also how the Government's own ledger behaves.
--
-- ⚠️ NO DELETE ON `vendor_ledger_entries` EITHER, for the same reason one step
-- removed: an entry is what a vendor reconciles their own books against, and a
-- statement that can lose a row is a statement nobody can rely on. A wrong
-- entry is reversed, not removed.
--
-- `vendors`, `purchase_invoices` and `purchase_invoice_lines` DO get DELETE,
-- narrowly: a bill typed in by mistake before it has been passed is an
-- ordinary correction. The rows that matter are protected by the RESTRICT
-- foreign keys, which refuse the delete the moment the register points at them.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON vendors                FROM ordence_app;
    REVOKE ALL ON purchase_invoices      FROM ordence_app;
    REVOKE ALL ON purchase_invoice_lines FROM ordence_app;
    REVOKE ALL ON itc_register           FROM ordence_app;
    REVOKE ALL ON vendor_ledger_entries  FROM ordence_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON vendors                TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_invoices      TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_invoice_lines TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON itc_register           TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON vendor_ledger_entries  TO ordence_app;

    GRANT EXECUTE ON FUNCTION indian_financial_year(date)     TO ordence_app;
    GRANT EXECUTE ON FUNCTION itc_claim_deadline_period(date) TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 11 — VERIFICATION
-- ############################################################################
--
-- Every check names what breaks if it fails, because "FAIL" on its own tells
-- you nothing about whether to panic.

-- Check 1 — RLS is ENABLED **and FORCED** on all five new tables.
-- ⚠️ `relforcerowsecurity` is the column that matters. ENABLE without FORCE
-- looks protected in every UI and is not protected against the owner.
SELECT
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS (enabled + forced)'
       WHEN c.relrowsecurity
       THEN '*** FAIL — enabled but NOT FORCED: the owner bypasses it ***'
       ELSE '*** FAIL — ROW LEVEL SECURITY IS OFF: every tenant can read every '
            'other tenant''s purchase ledger and tax position ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('vendors','purchase_invoices','purchase_invoice_lines',
                    'itc_register','vendor_ledger_entries')
ORDER BY c.relname;


-- Check 2 — every policy has BOTH a read and a write clause.
SELECT
  tablename, policyname,
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS (read + write)'
       WHEN with_check IS NULL
       THEN '*** FAIL — no WITH CHECK: a tenant can plant a purchase invoice in '
            'another tenant''s ledger ***'
       ELSE '*** FAIL — no USING clause ***'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('vendors','purchase_invoices','purchase_invoice_lines',
                    'itc_register','vendor_ledger_entries')
ORDER BY tablename;


-- Check 3 — ⭐ the composite foreign keys exist (Section 4).
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: a row can point at another tenant''s record ***'
  END AS verdict
FROM (VALUES
  ('vendors_party_same_tenant'),
  ('vendors_company_same_tenant'),
  ('vendors_created_by_same_tenant'),
  ('purchase_invoices_vendor_same_tenant'),
  ('purchase_invoices_party_same_tenant'),
  ('purchase_invoices_registration_same_tenant'),
  ('purchase_invoices_project_same_tenant'),
  ('purchase_invoice_lines_invoice_same_tenant'),
  ('purchase_invoice_lines_hsn_same_tenant'),
  ('purchase_invoice_lines_rate_same_tenant'),
  ('purchase_invoice_lines_project_same_tenant'),
  ('itc_register_registration_same_tenant'),
  ('itc_register_invoice_same_tenant'),
  ('itc_register_line_same_tenant'),
  ('itc_register_vendor_same_tenant'),
  ('vendor_ledger_vendor_same_tenant'),
  ('vendor_ledger_invoice_same_tenant')
) AS expected(conname)
LEFT JOIN pg_constraint pc ON pc.conname = expected.conname
ORDER BY expected.conname;


-- Check 4 — the guards are installed AND enabled.
-- ⚠️ `tgenabled` needs the ::text cast; without it the comparison silently
-- misbehaves. Found in Phase 11 against a real PostgreSQL.
SELECT
  expected.tgname,
  CASE WHEN t.tgname IS NULL THEN '*** FAIL — TRIGGER MISSING ***'
       WHEN t.tgenabled::text = 'O' THEN 'PASS (enabled)'
       ELSE '*** FAIL — trigger DISABLED: ' || t.tgenabled::text || ' ***'
  END AS verdict
FROM (VALUES
  ('purchase_invoices_reconciles',            'purchase_invoices'),
  ('purchase_invoice_lines_reconciles',       'purchase_invoice_lines'),
  ('itc_register_not_claimed_twice',          'itc_register'),
  ('itc_register_claim_matches_determination','itc_register')
) AS expected(tgname, tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tgname
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tgname;


-- Check 5 — ⭐⭐ SECTION 17(5)(d) IS REFUSED, PROVED NOT INSPECTED.
--
-- The same cement, twice: once into a tower sold before completion (must be
-- ACCEPTED as eligible) and once into our own building (an eligible credit
-- must be REFUSED). A constraint whose expression is subtly inverted passes
-- every "does it exist" check, so this builds both rows and tries them.
DO $$
DECLARE
  v_tenant   uuid := gen_random_uuid();
  v_vendor   uuid := gen_random_uuid();
  v_inv_ok   uuid := gen_random_uuid();
  v_inv_bad  uuid := gen_random_uuid();
  v_sold_ok  boolean := false;
  v_own_ref  boolean := false;
  v_own_ok   boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_itc_' || v_tenant, 'itc-' || left(v_tenant::text, 8),
            'ITC verification', 'active');
  INSERT INTO vendors (id, tenant_id, code, legal_name)
    VALUES (v_vendor, v_tenant, 'V-VFY', 'Verification Cement Co');

  /* --- ⭐ SOLD BEFORE COMPLETION → ELIGIBLE. Must be ACCEPTED. --- */
  BEGIN
    INSERT INTO purchase_invoices
      (id, tenant_id, vendor_id, invoice_number, invoice_date,
       subtotal_minor, taxable_value_minor, cgst_minor, sgst_minor,
       total_minor, itc_eligible_tax_minor, itc_blocked_tax_minor, gst_computed)
      VALUES (v_inv_ok, v_tenant, v_vendor, 'CEM/001', DATE '2024-05-10',
              10000000, 10000000, 900000, 900000, 11800000, 1800000, 0, false);
    INSERT INTO purchase_invoice_lines
      (tenant_id, purchase_invoice_id, line_number, description,
       amount_minor, taxable_value_minor, rate_bps, cgst_minor, sgst_minor,
       expenditure_nature, itc_purpose, itc_eligibility,
       itc_eligible_tax_minor, itc_blocked_tax_minor, rule42_attribution)
      VALUES (v_tenant, v_inv_ok, 1, 'Cement — Tower B, sold pre-completion',
              10000000, 10000000, 1800, 900000, 900000,
              'construction_material', 'sold_before_completion', 'eligible',
              1800000, 0, 'exclusively_taxable');
    v_sold_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_sold_ok := false;
    RAISE NOTICE 'sold-before-completion insert failed: %', SQLERRM;
  END;

  /* --- ⭐ OWN ACCOUNT + ELIGIBLE. Must be REFUSED. -------------- */
  INSERT INTO purchase_invoices
    (id, tenant_id, vendor_id, invoice_number, invoice_date,
     subtotal_minor, taxable_value_minor, cgst_minor, sgst_minor,
     total_minor, itc_eligible_tax_minor, itc_blocked_tax_minor, gst_computed)
    VALUES (v_inv_bad, v_tenant, v_vendor, 'CEM/002', DATE '2024-05-11',
            10000000, 10000000, 900000, 900000, 11800000, 0, 1800000, false);

  BEGIN
    INSERT INTO purchase_invoice_lines
      (tenant_id, purchase_invoice_id, line_number, description,
       amount_minor, taxable_value_minor, rate_bps, cgst_minor, sgst_minor,
       expenditure_nature, itc_purpose, itc_eligibility,
       itc_eligible_tax_minor, itc_blocked_tax_minor, rule42_attribution)
      VALUES (v_tenant, v_inv_bad, 1, 'Cement — our own head office',
              10000000, 10000000, 1800, 900000, 900000,
              'construction_material', 'own_account_construction', 'eligible',
              1800000, 0, 'exclusively_taxable');
  EXCEPTION WHEN OTHERS THEN
    v_own_ref := true;
  END;

  /* --- The same line, correctly BLOCKED. Must be ACCEPTED. ------ */
  BEGIN
    INSERT INTO purchase_invoice_lines
      (tenant_id, purchase_invoice_id, line_number, description,
       amount_minor, taxable_value_minor, rate_bps, cgst_minor, sgst_minor,
       expenditure_nature, itc_purpose, itc_eligibility, itc_block_reason,
       itc_statutory_ref, itc_eligible_tax_minor, itc_blocked_tax_minor,
       rule42_attribution)
      VALUES (v_tenant, v_inv_bad, 2, 'Cement — our own head office',
              10000000, 10000000, 1800, 900000, 900000,
              'construction_material', 'own_account_construction', 'blocked',
              'construction_own_account', '17(5)(d)', 0, 1800000, 'blocked');
    v_own_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_own_ok := false;
    RAISE NOTICE 'blocked own-account insert failed: %', SQLERRM;
  END;

  IF v_sold_ok AND v_own_ref AND v_own_ok THEN
    RAISE NOTICE 'PASS: ⭐ the same cement is ELIGIBLE for a tower sold before '
                 'completion and BLOCKED for our own building — and the database '
                 'refuses the eligible answer on the own-account line.';
  ELSIF NOT v_sold_ok THEN
    RAISE WARNING '*** FAIL — a CORRECT pre-completion credit was refused. The '
                  'constraint is inverted and no developer can claim the credit '
                  'the law gives them on units they are selling. ***';
  ELSIF NOT v_own_ref THEN
    RAISE WARNING '*** FAIL — ⭐⭐ AN OWN-ACCOUNT CONSTRUCTION CREDIT WAS '
                  'ACCEPTED AS ELIGIBLE. Section 17(5)(d) blocks it outright. '
                  'Nothing errors, the GSTR-3B files cleanly, and it is found at '
                  -- ⚠️ `%%`, not `%`. In a RAISE format string a bare % is a
                  -- parameter placeholder, and "18%" makes the whole DO block
                  -- fail to COMPILE — so the check never runs and the file
                  -- stops before every verification after it.
                  'an audit with interest at 18%% running from the claim. This is '
                  'the single most expensive GST error a developer can make. ***';
  ELSE
    RAISE WARNING '*** FAIL — a correctly BLOCKED own-account line was refused, '
                  'so a blocked credit cannot be recorded at all and the tax '
                  'cannot be capitalised into the cost of the building. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 6 — ⭐ THE SAME VENDOR BILL CANNOT BE ENTERED TWICE.
-- Proves the financial-year half too: the same serial in the NEXT financial
-- year must be accepted, because Rule 46(b) makes a supplier's serial unique
-- per financial year and "INV/001" legitimately recurs every April.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_vendor  uuid := gen_random_uuid();
  v_dup_ref boolean := false;
  v_case_ref boolean := false;
  v_next_ok boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_dup_' || v_tenant, 'dup-' || left(v_tenant::text, 8),
            'Duplicate verification', 'active');
  INSERT INTO vendors (id, tenant_id, code, legal_name)
    VALUES (v_vendor, v_tenant, 'V-DUP', 'Verification Contractor');

  INSERT INTO purchase_invoices (tenant_id, vendor_id, invoice_number, invoice_date)
    VALUES (v_tenant, v_vendor, 'INV/001', DATE '2024-05-10');

  BEGIN
    INSERT INTO purchase_invoices (tenant_id, vendor_id, invoice_number, invoice_date)
      VALUES (v_tenant, v_vendor, 'INV/001', DATE '2024-06-20');
  EXCEPTION WHEN OTHERS THEN
    v_dup_ref := true;
  END;

  -- The same bill, retyped in different case with a trailing space. Two copies
  -- of one document routinely differ exactly this much.
  BEGIN
    INSERT INTO purchase_invoices (tenant_id, vendor_id, invoice_number, invoice_date)
      VALUES (v_tenant, v_vendor, 'inv/001 ', DATE '2024-07-01');
  EXCEPTION WHEN OTHERS THEN
    v_case_ref := true;
  END;

  -- Next financial year. MUST be accepted.
  BEGIN
    INSERT INTO purchase_invoices (tenant_id, vendor_id, invoice_number, invoice_date)
      VALUES (v_tenant, v_vendor, 'INV/001', DATE '2025-05-10');
    v_next_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_next_ok := false;
  END;

  IF v_dup_ref AND v_case_ref AND v_next_ok THEN
    RAISE NOTICE 'PASS: a vendor bill cannot be entered twice in a financial '
                 'year, case and spacing do not defeat it, and the same serial '
                 'in the next year is accepted.';
  ELSIF NOT v_dup_ref THEN
    RAISE WARNING '*** FAIL — THE SAME VENDOR BILL WAS ENTERED TWICE. The credit '
                  'is claimed twice, the vendor balance is doubled, and the '
                  'payment run pays it twice. ***';
  ELSIF NOT v_case_ref THEN
    RAISE WARNING '*** FAIL — the same bill retyped in different case was '
                  'accepted. Two copies of one vendor document routinely differ '
                  'by exactly that much. ***';
  ELSE
    RAISE WARNING '*** FAIL — a legitimate reuse of a serial in the NEXT '
                  'financial year was refused. Rule 46(b) makes a supplier''s '
                  'serial unique per financial year; somebody will prefix it by '
                  'hand and defeat the duplicate defence entirely. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 7 — ⭐ A CREDIT CANNOT BE CLAIMED IN TWO PERIODS, BUT A RULE 37
-- RE-CLAIM AFTER A REVERSAL MUST STILL WORK.
--
-- ⚠️ `SET CONSTRAINTS … IMMEDIATE` IS WHAT MAKES THIS CHECK MEAN ANYTHING,
-- AND WITHOUT IT THE CHECK PASSES WHILE PROVING NOTHING.
--
-- The guard is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so it fires
-- at COMMIT. This whole DO block ends in a deliberate rollback, so COMMIT never
-- happens, so the trigger never fires, so the offending INSERT "succeeds" and
-- the verification reports a failure that is entirely an artefact of how it was
-- written. Forcing the constraint to IMMEDIATE inside each sub-block fires the
-- pending events at that point instead.
--
-- ⚠️ AND THE INSERT AND THE `SET CONSTRAINTS` MUST BE IN THE **SAME**
-- plpgsql BEGIN…EXCEPTION BLOCK. When a subtransaction aborts, the after-
-- trigger events queued inside it are discarded; events queued OUTSIDE it are
-- not, and would fire again at the block's own rollback and surface as an
-- unrelated failure.
DO $$
DECLARE
  v_tenant     uuid := gen_random_uuid();
  v_vendor     uuid := gen_random_uuid();
  v_inv        uuid := gen_random_uuid();
  v_line       uuid := gen_random_uuid();
  v_first_ok   boolean := false;
  v_twice_ref  boolean := false;
  v_reclaim_ok boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_twice_' || v_tenant, 'twice-' || left(v_tenant::text, 8),
            'Double-claim verification', 'active');
  INSERT INTO vendors (id, tenant_id, code, legal_name)
    VALUES (v_vendor, v_tenant, 'V-TWICE', 'Verification Supplier');
  INSERT INTO purchase_invoices
    (id, tenant_id, vendor_id, invoice_number, invoice_date,
     subtotal_minor, taxable_value_minor, cgst_minor, sgst_minor, total_minor,
     itc_eligible_tax_minor)
    VALUES (v_inv, v_tenant, v_vendor, 'TW/001', DATE '2024-04-05',
            10000000, 10000000, 900000, 900000, 11800000, 1800000);
  INSERT INTO purchase_invoice_lines
    (id, tenant_id, purchase_invoice_id, line_number, description,
     amount_minor, taxable_value_minor, rate_bps, cgst_minor, sgst_minor,
     itc_eligibility, itc_eligible_tax_minor, rule42_attribution)
    VALUES (v_line, v_tenant, v_inv, 1, 'Steel', 10000000, 10000000, 1800,
            900000, 900000, 'eligible', 1800000, 'exclusively_taxable');

  -- The ordinary first claim. MUST be accepted.
  BEGIN
    INSERT INTO itc_register
      (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
       vendor_id, status, reason, cgst_minor, sgst_minor)
      VALUES (v_tenant, '2024-04', v_inv, v_line, v_vendor, 'claimed',
              'invoice_claim', 900000, 900000);
    SET CONSTRAINTS itc_register_not_claimed_twice IMMEDIATE;
    SET CONSTRAINTS itc_register_not_claimed_twice DEFERRED;
    v_first_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_first_ok := false;
    RAISE NOTICE 'first claim refused: %', SQLERRM;
  END;

  -- ⭐ The same credit again, in a DIFFERENT period. Passes the per-period
  -- unique index cleanly. MUST be refused by the cumulative trigger.
  BEGIN
    INSERT INTO itc_register
      (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
       vendor_id, status, reason, cgst_minor, sgst_minor)
      VALUES (v_tenant, '2024-06', v_inv, v_line, v_vendor, 'claimed',
              'invoice_claim', 900000, 900000);
    SET CONSTRAINTS itc_register_not_claimed_twice IMMEDIATE;
    SET CONSTRAINTS itc_register_not_claimed_twice DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_twice_ref := true;
  END;

  -- Rule 37: reversed in October for non-payment, re-claimed in December once
  -- the supplier is paid. Lawful, and MUST still work — GSTR-3B puts a
  -- re-availment back in the same box as an ordinary one.
  BEGIN
    INSERT INTO itc_register
      (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
       vendor_id, status, reason, cgst_minor, sgst_minor)
      VALUES (v_tenant, '2024-10', v_inv, v_line, v_vendor, 'reversed',
              'rule_37_non_payment_180_days', 900000, 900000);
    INSERT INTO itc_register
      (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
       vendor_id, status, reason, cgst_minor, sgst_minor)
      VALUES (v_tenant, '2024-12', v_inv, v_line, v_vendor, 'claimed',
              'reclaim_after_payment', 900000, 900000);
    SET CONSTRAINTS itc_register_not_claimed_twice IMMEDIATE;
    SET CONSTRAINTS itc_register_not_claimed_twice DEFERRED;
    v_reclaim_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_reclaim_ok := false;
    RAISE NOTICE 'reclaim refused: %', SQLERRM;
  END;

  IF v_first_ok AND v_twice_ref AND v_reclaim_ok THEN
    RAISE NOTICE 'PASS: a credit cannot be claimed in two periods, and a Rule 37 '
                 're-claim after a reversal still works.';
  ELSIF NOT v_first_ok THEN
    RAISE WARNING '*** FAIL — an ORDINARY first claim was refused. No credit can '
                  'be availed at all. ***';
  ELSIF NOT v_twice_ref THEN
    RAISE WARNING '*** FAIL — THE SAME CREDIT WAS CLAIMED IN TWO TAX PERIODS. '
                  'Two rows, two months, two valid unique keys, and the same '
                  'rupee claimed twice. ***';
  ELSE
    RAISE WARNING '*** FAIL — a lawful Rule 37 re-claim was refused. Somebody '
                  'will edit the original register row instead, which destroys '
                  'the history the register exists to keep. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 8 — ⭐ THE PURCHASE INVOICE MUST RECONCILE TO ITS LINES, IN TAX AND
-- IN THE ITC SPLIT.
--
-- ⚠️ THE `SET CONSTRAINTS … IMMEDIATE` IS DOING TWO JOBS HERE, AND THE SECOND
-- IS THE INTERESTING ONE. It fires the deferred trigger inside a block that
-- will be rolled back (see Check 7) — and it also proves the trigger is
-- correctly DEFERRED in the first place: the header is inserted before any
-- line exists, and an immediate trigger would refuse it. If someone ever
-- "simplifies" this to a BEFORE INSERT trigger, the good case below fails and
-- says so.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_vendor  uuid := gen_random_uuid();
  v_inv     uuid := gen_random_uuid();
  v_bad     uuid := gen_random_uuid();
  v_good_ok boolean := false;
  v_itc_ref boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_rec_' || v_tenant, 'rec-' || left(v_tenant::text, 8),
            'Reconciliation verification', 'active');
  INSERT INTO vendors (id, tenant_id, code, legal_name)
    VALUES (v_vendor, v_tenant, 'V-REC', 'Verification Vendor');

  -- A correct GST-computed purchase invoice. MUST be accepted.
  BEGIN
    INSERT INTO purchase_invoices
      (id, tenant_id, vendor_id, invoice_number, invoice_date,
       subtotal_minor, taxable_value_minor, cgst_minor, sgst_minor, total_minor,
       itc_eligible_tax_minor, gst_computed)
      VALUES (v_inv, v_tenant, v_vendor, 'REC/001', DATE '2024-05-10',
              10000000, 10000000, 900000, 900000, 11800000, 1800000, true);
    INSERT INTO purchase_invoice_lines
      (tenant_id, purchase_invoice_id, line_number, description,
       amount_minor, taxable_value_minor, rate_bps, cgst_minor, sgst_minor,
       itc_eligibility, itc_eligible_tax_minor, rule42_attribution)
      VALUES (v_tenant, v_inv, 1, 'Steel', 10000000, 10000000, 1800,
              900000, 900000, 'eligible', 1800000, 'exclusively_taxable');
    SET CONSTRAINTS purchase_invoices_reconciles,
                    purchase_invoice_lines_reconciles IMMEDIATE;
    SET CONSTRAINTS purchase_invoices_reconciles,
                    purchase_invoice_lines_reconciles DEFERRED;
    v_good_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_good_ok := false;
    RAISE NOTICE 'correct invoice refused: %', SQLERRM;
  END;

  -- ⭐ The header claims the credit; the line determines it BLOCKED. Both the
  -- header and the line satisfy every CHECK constraint on their own, and the
  -- four tax heads still balance — so ONLY the ITC identity in the deferred
  -- trigger catches this. MUST be refused.
  BEGIN
    INSERT INTO purchase_invoices
      (id, tenant_id, vendor_id, invoice_number, invoice_date,
       subtotal_minor, taxable_value_minor, cgst_minor, sgst_minor, total_minor,
       itc_eligible_tax_minor, gst_computed)
      VALUES (v_bad, v_tenant, v_vendor, 'REC/002', DATE '2024-05-11',
              10000000, 10000000, 900000, 900000, 11800000, 1800000, true);
    INSERT INTO purchase_invoice_lines
      (tenant_id, purchase_invoice_id, line_number, description,
       amount_minor, taxable_value_minor, rate_bps, cgst_minor, sgst_minor,
       itc_eligibility, itc_block_reason, itc_eligible_tax_minor,
       itc_blocked_tax_minor, rule42_attribution)
      VALUES (v_tenant, v_bad, 1, 'Club membership', 10000000, 10000000, 1800,
              900000, 900000, 'blocked', 'club_membership', 0, 1800000, 'blocked');
    SET CONSTRAINTS purchase_invoices_reconciles,
                    purchase_invoice_lines_reconciles IMMEDIATE;
    SET CONSTRAINTS purchase_invoices_reconciles,
                    purchase_invoice_lines_reconciles DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_itc_ref := true;
  END;

  IF v_good_ok AND v_itc_ref THEN
    RAISE NOTICE 'PASS: a purchase invoice must reconcile to its lines, in tax '
                 'AND in the ITC split.';
  ELSIF NOT v_good_ok THEN
    RAISE WARNING '*** FAIL — a CORRECT purchase invoice was refused. Either the '
                  'reconciliation is wrong, or the trigger has stopped being '
                  'DEFERRED and now fires before any line exists. ***';
  ELSE
    RAISE WARNING '*** FAIL — ⭐ an invoice claiming more eligible credit than '
                  'its lines determine was ACCEPTED. The eligible figure goes '
                  'into a return and the blocked figure into the cost of a '
                  'building; a gap reaches neither and nothing reports it. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 9 — the app role cannot DELETE from the ITC register or the vendor
-- ledger. A filed return cannot be unfiled.
SELECT
  t.table_name, t.privilege_type,
  '*** FAIL — DELETE granted: the record of what went into a filed return can '
  'be erased ***' AS verdict
FROM information_schema.role_table_grants t
WHERE t.grantee = 'ordence_app'
  AND t.privilege_type = 'DELETE'
  AND t.table_name IN ('itc_register','vendor_ledger_entries');
-- (No rows returned = PASS.)


-- Check 10 — the financial-year function agrees with `financialYearOf` in
-- lib/gst/constants.ts. A disagreement makes the duplicate index key differ
-- from what the application believes it is, so a duplicate slips through in
-- the three months either side of April.
SELECT
  sample.day,
  CASE WHEN indian_financial_year(sample.day) = sample.expected THEN 'PASS'
       ELSE '*** FAIL — the database and the application disagree about which '
            'financial year this day falls in: got '
            || indian_financial_year(sample.day) || ', expected '
            || sample.expected || ' ***'
  END AS verdict
FROM (VALUES
  (DATE '2024-04-01', '2024-25'),  -- first day of the year
  (DATE '2025-03-31', '2024-25'),  -- last day of the same year
  (DATE '2025-04-01', '2025-26'),  -- the changeover
  (DATE '2024-01-15', '2023-24'),  -- January belongs to the PREVIOUS year
  (DATE '1999-12-31', '1999-00')   -- the century roll, two digits
) AS sample(day, expected);


-- Check 11 — nothing points across a tenant boundary TODAY.
SELECT 'purchase invoices → vendors' AS relationship, count(*) AS violations,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END AS verdict
  FROM purchase_invoices i JOIN vendors v ON v.id = i.vendor_id
 WHERE i.tenant_id <> v.tenant_id
UNION ALL
SELECT 'purchase lines → invoices', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM purchase_invoice_lines l JOIN purchase_invoices i ON i.id = l.purchase_invoice_id
 WHERE l.tenant_id <> i.tenant_id
UNION ALL
SELECT 'purchase lines → rate periods', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM purchase_invoice_lines l JOIN hsn_sac_rates r ON r.id = l.gst_rate_id
 WHERE l.tenant_id <> r.tenant_id
UNION ALL
SELECT 'ITC register → lines', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM itc_register g JOIN purchase_invoice_lines l ON l.id = g.purchase_invoice_line_id
 WHERE g.tenant_id <> l.tenant_id
UNION ALL
SELECT 'vendor ledger → vendors', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM vendor_ledger_entries e JOIN vendors v ON v.id = e.vendor_id
 WHERE e.tenant_id <> v.tenant_id;


-- Check 12 — ⭐ no own-account construction credit is eligible TODAY.
-- Belt and braces: if the CHECK were added after data existed, a wrong row
-- could predate it. This is the single query an auditor would run first.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: no credit is claimed on construction for our own account'
       ELSE '*** FAIL — ' || count(*) || ' line(s) claim input tax credit on '
            'construction of an immovable property ON OUR OWN ACCOUNT. Section '
            '17(5)(d) blocks it outright, and interest under Section 50 runs '
            'from the date of each claim. ***'
  END AS check_no_own_account_credit
FROM purchase_invoice_lines
WHERE itc_purpose = 'own_account_construction'
  AND (itc_eligibility <> 'blocked' OR itc_eligible_tax_minor <> 0);


-- Check 13 — every purchase invoice's ITC split accounts for all of its tax.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every paisa of purchase tax is either claimable or blocked'
       ELSE '*** FAIL — ' || count(*) || ' invoice(s) have tax that is neither '
            'claimed nor blocked. It reaches neither the return nor the cost of '
            'the building. ***'
  END AS check_itc_splits_exactly
FROM purchase_invoices
WHERE itc_eligible_tax_minor + itc_blocked_tax_minor
      <> cgst_minor + sgst_minor + igst_minor + cess_minor;


-- Check 14 — no credit is over-claimed across periods TODAY.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: no line has more credit claimed than it was determined to have'
       ELSE '*** FAIL — ' || count(*) || ' line(s) have been claimed in more '
            'than one period, net of reversals. ***'
  END AS check_no_double_claims
FROM (
  SELECT g.purchase_invoice_line_id AS line_id,
         sum(g.cgst_minor + g.sgst_minor + g.igst_minor + g.cess_minor)
           FILTER (WHERE g.status = 'claimed')  AS claimed,
         sum(g.cgst_minor + g.sgst_minor + g.igst_minor + g.cess_minor)
           FILTER (WHERE g.status = 'reversed') AS reversed
    FROM itc_register g
   WHERE g.purchase_invoice_line_id IS NOT NULL
   GROUP BY g.purchase_invoice_line_id
) claims
JOIN purchase_invoice_lines l ON l.id = claims.line_id
WHERE COALESCE(claims.claimed, 0) - COALESCE(claims.reversed, 0)
      > l.itc_eligible_tax_minor;


-- Check 14b — ⭐ a support session cannot DELETE a tax record.
SELECT
  expected.tbl,
  CASE WHEN t.tgname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — an impersonating operator can delete from this table, '
            'and a deleted purchase invoice leaves no trace in the customer''s '
            'UI while removing the evidence for a credit already filed ***'
  END AS verdict
FROM (VALUES
  ('vendors'), ('purchase_invoices'), ('purchase_invoice_lines'),
  ('itc_register'), ('vendor_ledger_entries')
) AS expected(tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = 'no_delete_under_impersonation'
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tbl;


-- Check 15 — the change log covers this phase.
SELECT
  expected.tbl,
  CASE WHEN t.tgname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — changes here are not recorded and could never sync ***'
  END AS verdict
FROM (VALUES
  ('vendors'), ('purchase_invoices'), ('purchase_invoice_lines'),
  ('itc_register'), ('vendor_ledger_entries')
) AS expected(tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tbl || '_change_log'
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tbl;


-- Check 16 — the duplicate-bill index exists.
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_indexes
                     WHERE tablename = 'purchase_invoices'
                       AND indexname = 'purchase_invoices_no_duplicate_bill')
       THEN 'PASS: a vendor bill cannot be entered twice in a financial year'
       ELSE '*** FAIL: purchase_invoices_no_duplicate_bill IS MISSING — the same '
            'bill entered by the site office and by accounts claims the credit '
            'twice and pays the vendor twice ***'
  END AS check_no_duplicate_bills;
