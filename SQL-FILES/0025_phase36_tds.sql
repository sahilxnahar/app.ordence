-- ============================================================================
-- Ordence — Phase 36: ⭐ Tax Deducted at Source (Chapter XVII-B)
-- Version: v0.36.0-alpha
--
-- Run AFTER `ALL-IN-ONE-SETUP.sql`, `0017_change_log.sql`, `0016_phase22_sales.sql`
-- and `0023_phase33_purchases.sql`. It depends on `set_updated_at()`,
-- `app_current_tenant_id()`, `record_change()`, `indian_financial_year(date)`,
-- and on the tables `vendors`, `purchase_invoices`, `channel_partners` and
-- `projects`.
--
-- Safe to run before `drizzle-kit push`: Section 1 creates its own types and
-- tables idempotently. Safe to re-run: every statement is guarded.
--
-- Contents:
--   1.  Enums and tables
--   2.  ⭐ ONE DEDUCTEE PER PAN — the index the annual threshold rests on
--   3.  Row-level security
--   4.  ⭐ Composite foreign keys — the hole RLS does NOT close
--   5.  ⭐ SECTION 206AA AND SECTION 197: THE DATABASE REFUSES THE WRONG RATE
--   6.  ⭐⭐ THE CUMULATIVE THRESHOLD — deferred, at commit
--   7.  ⭐ A CHALLAN MAY NOT BE OVER-UTILISED — deferred, at commit
--   8.  Statutory constants, restated for the database
--   9.  updated_at, and the change log
--   10. Grants
--   11. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Phase 33's hazard was a tax that was OURS and was claimed wrongly. This
-- phase's hazard is a tax that was never ours at all.
--
-- TDS is the government making us its collection agent on money we pay to
-- other people. Every mistake therefore lands on somebody else's balance sheet
-- first and on ours second, which is why nobody inside the company notices:
--
--     A labour contractor is paid ₹25,000 in April, ₹25,000 in June, ₹25,000
--     in September and ₹25,000 in December. Every payment is below Section
--     194C's ₹30,000 single-payment limit, so nothing is deducted. Four times.
--
--     ⭐ THE THRESHOLD IS NOT ON THE PAYMENT. IT IS ON THE YEAR. The second
--     limb of Section 194C(5) makes tax deductible once the aggregate reaches
--     ₹1,00,000 — and deductible on the WHOLE ₹1,00,000, not on the last
--     ₹25,000. The three earlier payments are brought into charge at the
--     fourth.
--
--     ₹1,000 was not deducted. The contractor has been paid and has left the
--     site. Section 201(1) makes the company an assessee in default for the
--     whole ₹1,000; interest under 201(1A) runs from the date each payment was
--     made; and 30% of the ₹1,00,000 of expenditure is disallowed under
--     Section 40(a)(ia). A ₹1,000 arithmetic error costs several times ₹1,000,
--     two years later.
--
--     Four correct-looking vouchers. Four correct-looking transfers. No error
--     anywhere, on any screen, at any point.
--
-- The other three that are just as quiet:
--
--     • A vendor whose PAN we do not hold, deducted at 1% under Section 194C
--       instead of 20% under Section 206AA. The bill is right, the payment is
--       right, and TRACES raises a short-deduction demand for the year.
--     • A Section 197 lower-deduction certificate that expired on 31 March and
--       is still being applied in August. A real document, correctly issued,
--       and no defence at all for the period after it lapsed.
--     • ⭐ A challan with ₹3,50,000 in it and ₹4,00,000 of deductions mapped
--       to it. The return is ACCEPTED. Some deductees get credit in their
--       Form 26AS and some silently do not, chosen by the order the Department
--       processes records in. They find out in October.
--
-- None can be caught by looking at the product. So they are caught here:
--
--   • Section 2 — one deductee row per PAN per workspace. Two rows for one
--     person split the running total in two, and each half sits comfortably
--     under ₹1,00,000 while the person is over it.
--   • Section 5 — a deduction against a deductee with no usable PAN may not be
--     below the Section 206AA floor, and a Section 197 certificate may not be
--     applied outside its window or to another section.
--   • Section 6 — ⭐⭐ the running total must actually run, and a
--     whole-aggregate section past its annual threshold may not have deducted
--     on PART of its own aggregate.
--   • Section 7 — no challan may carry more tax than was deposited into it.
--
-- Money is bigint paise. Rates are integer basis points.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — ENUMS AND TABLES
-- ############################################################################
--
-- `drizzle-kit push` creates these from `db/schema/tds.ts`. They are restated
-- here because a file that can only run second is a file that fails on a fresh
-- database.

DO $$
BEGIN
  -- ⭐ The nine sections a construction and real-estate business actually
  -- meets. 194I and 194J are split into their limbs because the split is a
  -- factor of five in the rate and nothing on an invoice states which side of
  -- it a bill falls. See db/schema/tds.ts.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_section') THEN
    CREATE TYPE tds_section AS ENUM
      ('192','194A','194C','194H','194I_a','194I_b','194IA','194J_a','194J_b',
       '194Q','195');
  END IF;

  -- ⭐ Decides Section 194C at 1% or 2%, and it is the fourth character of the
  -- deductee's PAN.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_deductee_type') THEN
    CREATE TYPE tds_deductee_type AS ENUM
      ('individual','huf','company','firm','association_of_persons',
       'body_of_individuals','local_authority','trust',
       'artificial_juridical_person','government');
  END IF;

  -- ⚠️ `inoperative` is not padding. A PAN not linked to Aadhaar is
  -- inoperative under Rule 114AAA, and CBDT Circular 3/2023 treats a deduction
  -- against one exactly as a deduction against no PAN — 20%, recoverable from
  -- the DEDUCTOR. It passes every structure check and is worth nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_pan_status') THEN
    CREATE TYPE tds_pan_status AS ENUM
      ('valid','not_furnished','invalid','inoperative','applied_for');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_rate_basis') THEN
    CREATE TYPE tds_rate_basis AS ENUM
      ('normal','section_206aa_no_pan','section_206ab_non_filer',
       'section_206aa_and_206ab','section_197_certificate','manually_determined');
  END IF;

  -- ⭐ `below_threshold` rows are the mechanism, not noise. A register that
  -- holds only DEDUCTIONS cannot produce the running total the annual
  -- threshold is tested against.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_deduction_outcome') THEN
    CREATE TYPE tds_deduction_outcome AS ENUM
      ('deducted','below_threshold','nil_certificate','exempt');
  END IF;

  -- ⚠️ The FINANCIAL-year quarter. January is Q4 of the previous year.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_quarter') THEN
    CREATE TYPE tds_quarter AS ENUM ('Q1','Q2','Q3','Q4');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_challan_status') THEN
    CREATE TYPE tds_challan_status AS ENUM
      ('pending','deposited','verified','failed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_certificate_form') THEN
    CREATE TYPE tds_certificate_form AS ENUM ('16','16A','16B','27D');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_certificate_status') THEN
    CREATE TYPE tds_certificate_status AS ENUM
      ('draft','requested','issued','revised');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_return_form') THEN
    CREATE TYPE tds_return_form AS ENUM ('24Q','26Q','27Q','27EQ');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tds_return_status') THEN
    CREATE TYPE tds_return_status AS ENUM ('draft','validated','filed','revised');
  END IF;
END
$$;


CREATE TABLE IF NOT EXISTS tds_deductees (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                        varchar(40)  NOT NULL,
  legal_name                  varchar(255) NOT NULL,
  pan_number                  varchar(10),
  pan_status                  tds_pan_status NOT NULL DEFAULT 'not_furnished',
  pan_verified_on             date,
  deductee_type               tds_deductee_type NOT NULL DEFAULT 'company',
  is_non_resident             boolean NOT NULL DEFAULT false,
  is_specified_person_206ab   boolean NOT NULL DEFAULT false,
  specified_person_checked_on date,
  specified_person_reference  varchar(64),
  vendor_id                   uuid,
  channel_partner_id          uuid,
  email                       varchar(320),
  phone                       varchar(32),
  address                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active                   boolean NOT NULL DEFAULT true,
  notes                       text,
  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tds_deductees_pan_shape
    CHECK (pan_number IS NULL OR pan_number ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  -- ⭐ A PAN STATUS OF `valid` WITH NO PAN IS THE 20% BUG, WRITTEN DOWN. The
  -- rate engine asks `pan_status = 'valid'` and would apply the ordinary rate
  -- to a deductee who has furnished nothing, where Section 206AA requires 20%.
  -- Section 201(1) makes the shortfall ours.
  CONSTRAINT tds_deductees_pan_status_consistent
    CHECK (pan_status <> 'valid' OR pan_number IS NOT NULL),
  -- ⭐ The 206AB determination belongs to the Department's Compliance Check
  -- utility, not to us. An undated copy of it is a guess.
  CONSTRAINT tds_deductees_specified_person_evidenced
    CHECK ((NOT is_specified_person_206ab) OR specified_person_checked_on IS NOT NULL)
);


CREATE TABLE IF NOT EXISTS tds_lower_deduction_certificates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deductee_id         uuid NOT NULL,
  certificate_number  varchar(24) NOT NULL,
  section             tds_section NOT NULL,
  rate_bps            integer NOT NULL,
  valid_from          date NOT NULL,
  valid_to            date NOT NULL,
  cap_base_minor      bigint,
  financial_year      varchar(7) NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tds_ldc_rate_sane  CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  CONSTRAINT tds_ldc_window_sane CHECK (valid_to >= valid_from),
  CONSTRAINT tds_ldc_cap_sane   CHECK (cap_base_minor IS NULL OR cap_base_minor > 0),
  CONSTRAINT tds_ldc_fy_shape   CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$')
);


CREATE TABLE IF NOT EXISTS tds_challans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tan              varchar(10) NOT NULL,
  bsr_code         varchar(7)  NOT NULL,
  challan_serial   varchar(5)  NOT NULL,
  deposit_date     date NOT NULL,
  financial_year   varchar(7) NOT NULL,
  assessment_year  varchar(7) NOT NULL,
  quarter          tds_quarter NOT NULL,
  section          tds_section,
  tax_minor        bigint NOT NULL DEFAULT 0,
  surcharge_minor  bigint NOT NULL DEFAULT 0,
  cess_minor       bigint NOT NULL DEFAULT 0,
  interest_minor   bigint NOT NULL DEFAULT 0,
  fee_minor        bigint NOT NULL DEFAULT 0,
  total_minor      bigint NOT NULL DEFAULT 0,
  status           tds_challan_status NOT NULL DEFAULT 'deposited',
  bank_reference   varchar(64),
  verified_on      date,
  notes            text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- ⚠️ A TAN, not a PAN. Four letters, five digits, one letter. Both are ten
  -- characters, which is exactly why one gets pasted into the other's field.
  CONSTRAINT tds_challans_tan_shape CHECK (tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  -- ⭐ Seven digits INCLUDING leading zeros. A spreadsheet strips them, and a
  -- challan quoted with `1234` where OLTAS holds `0001234` matches nothing —
  -- so the return is accepted and every deductee on that challan gets no
  -- credit in their Form 26AS.
  CONSTRAINT tds_challans_bsr_shape    CHECK (bsr_code ~ '^[0-9]{7}$'),
  CONSTRAINT tds_challans_serial_shape CHECK (challan_serial ~ '^[0-9]{5}$'),
  CONSTRAINT tds_challans_non_negative
    CHECK (tax_minor >= 0 AND surcharge_minor >= 0 AND cess_minor >= 0
           AND interest_minor >= 0 AND fee_minor >= 0),
  -- ⚠️ ITNS 281 has five boxes and the return quotes each one. A stored total
  -- that is not its parts is a reconciliation against a number the government
  -- never saw.
  CONSTRAINT tds_challans_total_balances
    CHECK (total_minor = tax_minor + surcharge_minor + cess_minor
           + interest_minor + fee_minor),
  CONSTRAINT tds_challans_fy_shape
    CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'
           AND assessment_year ~ '^[0-9]{4}-[0-9]{2}$')
);


CREATE TABLE IF NOT EXISTS tds_returns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tan                    varchar(10) NOT NULL,
  form_type              tds_return_form NOT NULL,
  financial_year         varchar(7) NOT NULL,
  quarter                tds_quarter NOT NULL,
  status                 tds_return_status NOT NULL DEFAULT 'draft',
  deductee_count         integer NOT NULL DEFAULT 0,
  deduction_count        integer NOT NULL DEFAULT 0,
  total_base_minor       bigint NOT NULL DEFAULT 0,
  total_tds_minor        bigint NOT NULL DEFAULT 0,
  total_deposited_minor  bigint NOT NULL DEFAULT 0,
  total_interest_minor   bigint NOT NULL DEFAULT 0,
  late_filing_fee_minor  bigint NOT NULL DEFAULT 0,
  due_date               date,
  filed_on               date,
  acknowledgement_number varchar(20),
  validation_report      jsonb NOT NULL DEFAULT '[]'::jsonb,
  validated_at           timestamptz,
  notes                  text,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tds_returns_tan_shape CHECK (tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  CONSTRAINT tds_returns_fy_shape  CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT tds_returns_non_negative
    CHECK (total_base_minor >= 0 AND total_tds_minor >= 0
           AND total_deposited_minor >= 0 AND total_interest_minor >= 0
           AND late_filing_fee_minor >= 0
           AND deductee_count >= 0 AND deduction_count >= 0),
  -- ⚠️ "We filed it" without a provisional receipt number is a claim, not a
  -- fact — and the Section 234E fee at ₹200 a day runs until the Department
  -- says it holds the statement.
  CONSTRAINT tds_returns_filed_is_evidenced
    CHECK (status <> 'filed'
           OR (filed_on IS NOT NULL AND acknowledgement_number IS NOT NULL))
);


CREATE TABLE IF NOT EXISTS tds_deductions (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deductee_id                    uuid NOT NULL,
  section                        tds_section NOT NULL,
  financial_year                 varchar(7) NOT NULL,
  quarter                        tds_quarter NOT NULL,
  -- ⭐ DATE OF CREDIT OR OF PAYMENT, WHICHEVER IS EARLIER. Not the payment
  -- date. A March bill booked in March and paid in June was deductible in
  -- MARCH, belongs to Q4, and its deposit was due on 30 April.
  deduction_date                 date NOT NULL,
  payment_date                   date,

  -- ⭐ THE FOUR MONEY COLUMNS. One `amount` column collapses all four, and the
  -- collapse is where the money is lost.
  payment_base_minor             bigint NOT NULL DEFAULT 0,
  catch_up_base_minor            bigint NOT NULL DEFAULT 0,
  chargeable_base_minor          bigint NOT NULL DEFAULT 0,
  aggregate_before_minor         bigint NOT NULL DEFAULT 0,
  aggregate_after_minor          bigint NOT NULL DEFAULT 0,

  rate_bps                       integer NOT NULL DEFAULT 0,
  rate_basis                     tds_rate_basis NOT NULL DEFAULT 'normal',
  lower_deduction_certificate_id uuid,
  statutory_ref                  varchar(32),
  explanation                    text,

  tds_minor                      bigint NOT NULL DEFAULT 0,
  surcharge_minor                bigint NOT NULL DEFAULT 0,
  cess_minor                     bigint NOT NULL DEFAULT 0,
  total_deducted_minor           bigint NOT NULL DEFAULT 0,

  outcome                        tds_deduction_outcome NOT NULL,

  purchase_invoice_id            uuid,
  vendor_id                      uuid,
  project_id                     uuid,
  channel_partner_id             uuid,
  reference_number               varchar(80),
  description                    text,

  challan_id                     uuid,
  tds_return_id                  uuid,

  created_by                     uuid,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tds_deductions_fy_shape
    CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT tds_deductions_rate_sane
    CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  CONSTRAINT tds_deductions_non_negative
    CHECK (payment_base_minor >= 0 AND catch_up_base_minor >= 0
           AND chargeable_base_minor >= 0 AND aggregate_before_minor >= 0
           AND aggregate_after_minor >= 0 AND tds_minor >= 0
           AND surcharge_minor >= 0 AND cess_minor >= 0),
  -- ⭐ THE CHARGEABLE BASE IS SOME OF THIS PAYMENT PLUS THE CATCH-UP.
  --
  -- ⚠️ NOT AN EQUALITY, AND WRITING IT AS ONE WAS THE FIRST DRAFT.
  -- `chargeable = payment + catch_up` is true for 194C and false for the other
  -- two threshold modes: a `below_threshold` row has a real payment and
  -- nothing chargeable, and under 194Q the tax is on the EXCESS over ₹50 lakh
  -- so the payment that crosses the line is only PARTLY chargeable. An
  -- equality would force the whole payment into charge and over-deduct on a
  -- cement account by a factor of several.
  CONSTRAINT tds_deductions_chargeable_within_payment
    CHECK (chargeable_base_minor >= catch_up_base_minor
           AND chargeable_base_minor - catch_up_base_minor <= payment_base_minor),
  CONSTRAINT tds_deductions_aggregate_balances
    CHECK (aggregate_after_minor = aggregate_before_minor + payment_base_minor),
  CONSTRAINT tds_deductions_total_balances
    CHECK (total_deducted_minor = tds_minor + surcharge_minor + cess_minor),
  -- ⚠️ Bringing more into charge than was ever paid over-deducts, and the
  -- deductee can only recover it on their own return a year later.
  CONSTRAINT tds_deductions_catch_up_bounded
    CHECK (catch_up_base_minor <= aggregate_before_minor),
  CONSTRAINT tds_deductions_outcome_matches_money
    CHECK ((outcome = 'deducted'
              AND tds_minor > 0 AND chargeable_base_minor > 0)
           OR (outcome = 'below_threshold'
              AND tds_minor = 0 AND chargeable_base_minor = 0
              AND catch_up_base_minor = 0)
           OR (outcome = 'nil_certificate'
              AND tds_minor = 0 AND surcharge_minor = 0 AND cess_minor = 0)
           OR (outcome = 'exempt'
              AND tds_minor = 0 AND chargeable_base_minor = 0)),
  -- ⭐⭐ A REDUCED RATE MUST NAME THE CERTIFICATE THAT AUTHORISED IT. A
  -- deduction below the section's rate is either a Section 197 certificate or
  -- a short deduction, and there is no third possibility. A certificate that
  -- is not quoted on the return is no defence: the Department reads the
  -- statement, not the drawer.
  CONSTRAINT tds_deductions_certificate_rate_is_evidenced
    CHECK ((rate_basis <> 'section_197_certificate' AND outcome <> 'nil_certificate')
           OR lower_deduction_certificate_id IS NOT NULL)
);


CREATE TABLE IF NOT EXISTS tds_certificates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deductee_id            uuid NOT NULL,
  tds_return_id          uuid,
  form_type              tds_certificate_form NOT NULL,
  financial_year         varchar(7) NOT NULL,
  quarter                tds_quarter NOT NULL,
  tan                    varchar(10) NOT NULL,
  certificate_number     varchar(24),
  total_base_minor       bigint NOT NULL DEFAULT 0,
  total_tds_minor        bigint NOT NULL DEFAULT 0,
  -- ⭐ TRACES certifies what was DEPOSITED AND MATCHED, not what was deducted.
  -- The gap between this and `total_tds_minor` is the number the deductee's
  -- phone call is about.
  deposited_tds_minor    bigint NOT NULL DEFAULT 0,
  line_detail            jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                 tds_certificate_status NOT NULL DEFAULT 'draft',
  traces_request_number  varchar(40),
  issued_on              date,
  due_date               date,
  notes                  text,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tds_certificates_tan_shape CHECK (tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  CONSTRAINT tds_certificates_fy_shape
    CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT tds_certificates_non_negative
    CHECK (total_base_minor >= 0 AND total_tds_minor >= 0
           AND deposited_tds_minor >= 0),
  -- ⭐ Certifying more than was deducted hands the deductee a credit they will
  -- claim and their assessing officer will disallow — from THEM, on our paper.
  CONSTRAINT tds_certificates_deposited_bounded
    CHECK (deposited_tds_minor <= total_tds_minor),
  CONSTRAINT tds_certificates_issued_is_numbered
    CHECK (status <> 'issued'
           OR (certificate_number IS NOT NULL AND issued_on IS NOT NULL))
);


-- Indexes. `drizzle-kit push` creates these too; restated for a fresh database.
CREATE UNIQUE INDEX IF NOT EXISTS tds_deductees_code_tenant_unique
  ON tds_deductees (tenant_id, code);
CREATE INDEX IF NOT EXISTS tds_deductees_tenant_idx
  ON tds_deductees (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS tds_deductees_vendor_idx
  ON tds_deductees (tenant_id, vendor_id);
CREATE INDEX IF NOT EXISTS tds_deductees_partner_idx
  ON tds_deductees (tenant_id, channel_partner_id);
CREATE INDEX IF NOT EXISTS tds_deductees_specified_idx
  ON tds_deductees (tenant_id, specified_person_checked_on)
  WHERE is_specified_person_206ab;

CREATE UNIQUE INDEX IF NOT EXISTS tds_ldc_number_tenant_unique
  ON tds_lower_deduction_certificates (tenant_id, certificate_number, section);
CREATE INDEX IF NOT EXISTS tds_ldc_deductee_idx
  ON tds_lower_deduction_certificates (tenant_id, deductee_id, section, valid_from);

CREATE INDEX IF NOT EXISTS tds_challans_period_idx
  ON tds_challans (tenant_id, financial_year, quarter);
CREATE INDEX IF NOT EXISTS tds_challans_tan_idx
  ON tds_challans (tenant_id, tan, deposit_date);

CREATE UNIQUE INDEX IF NOT EXISTS tds_returns_period_key
  ON tds_returns (tenant_id, tan, form_type, financial_year, quarter)
  WHERE status <> 'revised';
CREATE INDEX IF NOT EXISTS tds_returns_status_idx
  ON tds_returns (tenant_id, status, financial_year);

-- ⭐ The index the threshold engine lives on. Everything about the cumulative
-- rule is a scan of exactly this: one deductee, one section, one financial
-- year, in date order.
CREATE INDEX IF NOT EXISTS tds_deductions_accumulation_idx
  ON tds_deductions (tenant_id, deductee_id, section, financial_year, deduction_date);
CREATE INDEX IF NOT EXISTS tds_deductions_quarter_idx
  ON tds_deductions (tenant_id, financial_year, quarter, section);
CREATE INDEX IF NOT EXISTS tds_deductions_challan_idx
  ON tds_deductions (tenant_id, challan_id);
CREATE INDEX IF NOT EXISTS tds_deductions_return_idx
  ON tds_deductions (tenant_id, tds_return_id);
CREATE INDEX IF NOT EXISTS tds_deductions_invoice_idx
  ON tds_deductions (tenant_id, purchase_invoice_id);
-- The "deducted but not deposited" worklist — the 1.5%-a-month one.
CREATE INDEX IF NOT EXISTS tds_deductions_undeposited_idx
  ON tds_deductions (tenant_id, deduction_date)
  WHERE challan_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tds_certificates_quarter_key
  ON tds_certificates (tenant_id, tan, deductee_id, form_type, financial_year, quarter)
  WHERE status <> 'revised';
CREATE INDEX IF NOT EXISTS tds_certificates_deductee_idx
  ON tds_certificates (tenant_id, deductee_id, financial_year);
CREATE INDEX IF NOT EXISTS tds_certificates_return_idx
  ON tds_certificates (tenant_id, tds_return_id);


-- ############################################################################
-- SECTION 2 — ⭐ ONE DEDUCTEE PER PAN, AND ONE CHALLAN PER OLTAS KEY
-- ############################################################################
--
-- ⭐ THE CHEAPEST INDEX IN THE PHASE AND THE ONE THE WHOLE THRESHOLD ENGINE
-- RESTS ON.
--
--     The site office creates a deductee for the labour contract. Accounts
--     creates another for the same firm's crane hire, because the name on the
--     second invoice reads slightly differently. One PAN, two rows, two
--     running totals.
--
--     ₹60,000 under one and ₹55,000 under the other. Each is comfortably below
--     Section 194C's ₹1,00,000 annual threshold. The person is ₹15,000 over
--     it, and nothing on either row looks wrong.
--
-- ⚠️ THE STATUTORY UNIT OF ACCOUNT IS THE PAN. Not the vendor, not the
-- contract, not the site. Splitting a PAN across two rows does not fail — it
-- under-deducts by construction, and the deduction that never happened cannot
-- be found by looking for a wrong one.
--
-- ⚠️ PARTIAL, on `pan_number IS NOT NULL`. A deductee with no PAN is a lawful
-- deductee at 20% under Section 206AA, and several of them must be able to
-- coexist. Their exposure is a RATE problem, and it is handled in Section 5.

CREATE UNIQUE INDEX IF NOT EXISTS tds_deductees_pan_tenant_unique
  ON tds_deductees (tenant_id, pan_number)
  WHERE pan_number IS NOT NULL;

-- ⭐ THE GOVERNMENT'S OWN KEY, AND THEREFORE OURS.
--
-- (BSR code, deposit date, challan serial) is unique in OLTAS. The same
-- challan recorded twice would let a month's deductions be mapped across two
-- copies of one payment — so the register reconciles to the challans perfectly
-- while only half the money ever moved, and Section 7 below cannot see it
-- because each copy is individually within its own capacity.

CREATE UNIQUE INDEX IF NOT EXISTS tds_challans_oltas_key
  ON tds_challans (tenant_id, bsr_code, deposit_date, challan_serial);


-- ############################################################################
-- SECTION 3 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER too, which
-- is the half everybody forgets: without it the role that created the table
-- reads everything and the policies look like they are working.
--
-- ⚠️ NO `app_is_platform_scope()` ON ANY POLICY HERE. `tds_deductees` is a
-- list of every contractor, consultant, landlord and landowner a developer
-- pays, WITH THEIR PAN — a stronger identity document than anything in the
-- CRM, and one that is directly usable to look a person up elsewhere.
-- `tds_deductions` is what each of them was paid, month by month. Platform
-- staff have no business reading either.

ALTER TABLE tds_deductees ENABLE ROW LEVEL SECURITY;
ALTER TABLE tds_deductees FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_deductees_tenant_isolation ON tds_deductees;
CREATE POLICY tds_deductees_tenant_isolation ON tds_deductees
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tds_lower_deduction_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tds_lower_deduction_certificates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_ldc_tenant_isolation ON tds_lower_deduction_certificates;
CREATE POLICY tds_ldc_tenant_isolation ON tds_lower_deduction_certificates
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tds_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE tds_challans FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_challans_tenant_isolation ON tds_challans;
CREATE POLICY tds_challans_tenant_isolation ON tds_challans
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tds_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE tds_returns FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_returns_tenant_isolation ON tds_returns;
CREATE POLICY tds_returns_tenant_isolation ON tds_returns
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tds_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tds_deductions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_deductions_tenant_isolation ON tds_deductions;
CREATE POLICY tds_deductions_tenant_isolation ON tds_deductions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tds_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tds_certificates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_certificates_tenant_isolation ON tds_certificates;
CREATE POLICY tds_certificates_tenant_isolation ON tds_certificates
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
--     Tenant A inserts a deduction with
--         tenant_id   = A                             ← passes WITH CHECK
--         challan_id  = <a challan owned by B>        ← passes a single-column FK
--
--     A's deductions are now discharged by B's deposit. B's challan is
--     over-utilised by money that is not theirs, so B's return silently
--     withholds credit from B's OWN vendors — and the cause is in a table B
--     cannot read.
--
-- ⚠️ AND `deductee_id` IS WORSE STILL: guessing deductee ids until one is
-- accepted is an existence oracle over another developer's PAN register.

CREATE UNIQUE INDEX IF NOT EXISTS tds_deductees_id_tenant_key
  ON tds_deductees (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tds_ldc_id_tenant_key
  ON tds_lower_deduction_certificates (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tds_challans_id_tenant_key
  ON tds_challans (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tds_returns_id_tenant_key
  ON tds_returns (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tds_deductions_id_tenant_key
  ON tds_deductions (id, tenant_id);

-- Parents in earlier phases. Created idempotently so this file does not depend
-- on the order the SQL directory is applied in.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_key             ON users (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS vendors_id_tenant_key           ON vendors (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_id_tenant_key ON purchase_invoices (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_tenant_key          ON projects (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_partners_id_tenant_key  ON channel_partners (id, tenant_id);

DO $$
BEGIN
  /* --- tds_deductees -------------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductees_vendor_same_tenant') THEN
    ALTER TABLE tds_deductees ADD CONSTRAINT tds_deductees_vendor_same_tenant
      FOREIGN KEY (vendor_id, tenant_id) REFERENCES vendors (id, tenant_id)
      -- SET NULL, not CASCADE: the PAN, the year's aggregate and the tax
      -- already deposited under it outlive a commercial relationship.
      ON DELETE SET NULL (vendor_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductees_partner_same_tenant') THEN
    ALTER TABLE tds_deductees ADD CONSTRAINT tds_deductees_partner_same_tenant
      FOREIGN KEY (channel_partner_id, tenant_id) REFERENCES channel_partners (id, tenant_id)
      ON DELETE SET NULL (channel_partner_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductees_created_by_same_tenant') THEN
    ALTER TABLE tds_deductees ADD CONSTRAINT tds_deductees_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  /* --- tds_lower_deduction_certificates ------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_ldc_deductee_same_tenant') THEN
    ALTER TABLE tds_lower_deduction_certificates
      ADD CONSTRAINT tds_ldc_deductee_same_tenant
      FOREIGN KEY (deductee_id, tenant_id) REFERENCES tds_deductees (id, tenant_id)
      ON DELETE RESTRICT;
  END IF;

  /* --- tds_deductions ------------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductions_deductee_same_tenant') THEN
    ALTER TABLE tds_deductions ADD CONSTRAINT tds_deductions_deductee_same_tenant
      FOREIGN KEY (deductee_id, tenant_id) REFERENCES tds_deductees (id, tenant_id)
      -- ⚠️ RESTRICT. A deductee with tax deposited against their PAN can never
      -- be removed: the deduction IS the evidence for their Form 26AS credit.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductions_certificate_same_tenant') THEN
    ALTER TABLE tds_deductions ADD CONSTRAINT tds_deductions_certificate_same_tenant
      FOREIGN KEY (lower_deduction_certificate_id, tenant_id)
      REFERENCES tds_lower_deduction_certificates (id, tenant_id)
      -- ⚠️ RESTRICT, not SET NULL. The certificate is the ONLY authority for a
      -- rate below the section's. Losing the pointer turns a lawful deduction
      -- into an unexplained short one, and the check constraint
      -- `tds_deductions_certificate_rate_is_evidenced` would then be violated
      -- by a row nobody touched.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductions_challan_same_tenant') THEN
    ALTER TABLE tds_deductions ADD CONSTRAINT tds_deductions_challan_same_tenant
      FOREIGN KEY (challan_id, tenant_id) REFERENCES tds_challans (id, tenant_id)
      -- ⚠️ RESTRICT. The challan is the proof the money reached the
      -- government. A deduction whose challan vanished is a deduction the
      -- deductee gets no credit for.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductions_return_same_tenant') THEN
    ALTER TABLE tds_deductions ADD CONSTRAINT tds_deductions_return_same_tenant
      FOREIGN KEY (tds_return_id, tenant_id) REFERENCES tds_returns (id, tenant_id)
      ON DELETE SET NULL (tds_return_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductions_invoice_same_tenant') THEN
    ALTER TABLE tds_deductions ADD CONSTRAINT tds_deductions_invoice_same_tenant
      FOREIGN KEY (purchase_invoice_id, tenant_id)
      REFERENCES purchase_invoices (id, tenant_id)
      ON DELETE SET NULL (purchase_invoice_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductions_vendor_same_tenant') THEN
    ALTER TABLE tds_deductions ADD CONSTRAINT tds_deductions_vendor_same_tenant
      FOREIGN KEY (vendor_id, tenant_id) REFERENCES vendors (id, tenant_id)
      ON DELETE SET NULL (vendor_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductions_project_same_tenant') THEN
    ALTER TABLE tds_deductions ADD CONSTRAINT tds_deductions_project_same_tenant
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      ON DELETE SET NULL (project_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductions_partner_same_tenant') THEN
    ALTER TABLE tds_deductions ADD CONSTRAINT tds_deductions_partner_same_tenant
      FOREIGN KEY (channel_partner_id, tenant_id)
      REFERENCES channel_partners (id, tenant_id)
      ON DELETE SET NULL (channel_partner_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_deductions_created_by_same_tenant') THEN
    ALTER TABLE tds_deductions ADD CONSTRAINT tds_deductions_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  /* --- tds_certificates ----------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_certificates_deductee_same_tenant') THEN
    ALTER TABLE tds_certificates ADD CONSTRAINT tds_certificates_deductee_same_tenant
      FOREIGN KEY (deductee_id, tenant_id) REFERENCES tds_deductees (id, tenant_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_certificates_return_same_tenant') THEN
    ALTER TABLE tds_certificates ADD CONSTRAINT tds_certificates_return_same_tenant
      FOREIGN KEY (tds_return_id, tenant_id) REFERENCES tds_returns (id, tenant_id)
      ON DELETE SET NULL (tds_return_id);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — ⭐ SECTION 206AA AND SECTION 197: THE WRONG RATE IS REFUSED
-- ############################################################################
--
-- TWO GUARDS, BOTH FOR MISTAKES THAT ARE INVISIBLE AT THE TIME AND EXPENSIVE
-- LATER, AND BOTH FOR MISTAKES THE ENGINE ALONE CANNOT PREVENT.
--
-- ⚠️ WHY THE DATABASE AND NOT JUST `lib/tds/rates.ts`. The engine is ONE write
-- path. An import of a year of historical payments is another, a correction at
-- a psql prompt is a third, and a future payment-run API is a fourth. The
-- import is where the volume is — and an import is exactly where a lapsed
-- certificate gets applied to twelve months because it was right for the first.

-- ---------------------------------------------------------------------------
-- 5a — ⭐ NO PAN MEANS AT LEAST 20%.
-- ---------------------------------------------------------------------------
--
-- Section 206AA: where the deductee has not furnished a PAN, tax is deducted
-- at the HIGHER of the rate in the relevant provision, the rate in force, or
-- twenty per cent.
--
-- ⚠️ THE PROVISO THAT IS ALWAYS MISSED: the second proviso to 206AA(1) caps
-- the no-PAN rate at FIVE per cent for Section 194Q. Applying the general 20%
-- to a ₹60 lakh cement account instead of 5% of the excess deducts ₹12 lakh
-- where ₹50,000 was due, from a supplier who will stop supplying.
--
-- ⚠️ AND `inoperative` COUNTS AS NO PAN. Rule 114AAA and CBDT Circular 3/2023:
-- a PAN not linked to Aadhaar is inoperative, and a deduction against one is
-- treated as a deduction against no PAN — with the shortfall recoverable from
-- the DEDUCTOR. The number is on file and passes every structure check.

CREATE OR REPLACE FUNCTION tds_section_206aa_floor_bps(p_section tds_section)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  -- ⚠️ MIRRORS `SECTION_206AA_BPS` AND `SECTION_206AA_194Q_BPS` IN
  -- lib/tds/sections.ts, which is the source of truth. Check 6 below proves
  -- they still agree.
  SELECT CASE WHEN p_section = '194Q' THEN 500 ELSE 2000 END;
$$;

CREATE OR REPLACE FUNCTION enforce_tds_rate_floor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_pan_status tds_pan_status;
  v_pan        varchar(10);
  v_name       varchar(255);
  v_floor      integer;
BEGIN
  IF NEW.outcome <> 'deducted' THEN
    RETURN NEW;
  END IF;

  SELECT d.pan_status, d.pan_number, d.legal_name
    INTO v_pan_status, v_pan, v_name
    FROM tds_deductees d
   WHERE d.id = NEW.deductee_id;

  -- Invisible under RLS, or created later in the same transaction. The
  -- composite foreign key already refuses the cross-tenant case.
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_pan_status = 'valid' AND v_pan IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_floor := tds_section_206aa_floor_bps(NEW.section);

  IF NEW.rate_bps < v_floor THEN
    -- ⚠️ `%%` IS A LITERAL PER CENT SIGN IN A RAISE FORMAT STRING. A bare `%`
    -- is a parameter placeholder, and an unmatched one makes the whole
    -- function fail to COMPILE — so the guard never installs and the file
    -- stops before every verification after it. Learned in Phase 33.
    RAISE EXCEPTION
      'Section 206AA: % has no usable PAN (status %), so tax must be deducted '
      'at the HIGHER of the Section % rate and % basis points. This deduction '
      'is at % basis points — 100 basis points is one per cent. Deducting the '
      'ordinary rate here is a short deduction: Section 201(1) makes the whole '
      'shortfall ours, interest under 201(1A) runs from the date of the '
      'payment, and Section 205 bars us from recovering it from the deductee '
      'once it is deposited. Obtain the PAN before paying.',
      v_name, v_pan_status, NEW.section, v_floor, NEW.rate_bps
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tds_deductions_rate_floor ON tds_deductions;
CREATE TRIGGER tds_deductions_rate_floor
  BEFORE INSERT OR UPDATE ON tds_deductions
  FOR EACH ROW EXECUTE FUNCTION enforce_tds_rate_floor();


-- ---------------------------------------------------------------------------
-- 5b — ⭐ A SECTION 197 CERTIFICATE APPLIES INSIDE ITS WINDOW AND NOWHERE ELSE
-- ---------------------------------------------------------------------------
--
-- THE COMMONEST WAY A LOWER-DEDUCTION CERTIFICATE TURNS INTO A DEMAND.
--
--     The subcontractor sends the certificate in June. Accounts files it and
--     starts deducting at 0.5% instead of 2%. The certificate expired on
--     31 March. Every payment from 1 April onwards is short by three quarters
--     of the tax, Section 201(1) makes the shortfall ours, and 30% of the
--     expenditure is disallowed under Section 40(a)(ia).
--
--     The certificate is a real document, correctly issued, and it is no
--     defence at all for the period after it lapsed.
--
-- Three things are checked, and each of them is a different way the same
-- mistake is made:
--
--   • THE WINDOW. Both ends. A certificate is commonly issued from the date of
--     APPLICATION, so payments made while it was pending are at the ordinary
--     rate too.
--   • THE SECTION. A 194C certificate does not reduce a 194J fee to the same
--     firm.
--   • ⚠️ THE PAN. Section 206AA(4) forbids the Assessing Officer from granting
--     a certificate where no PAN is quoted, so a certificate against a
--     PAN-less deductee is a document that cannot exist. 5a already refuses
--     the rate; this names why.

CREATE OR REPLACE FUNCTION enforce_tds_certificate_window()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cert tds_lower_deduction_certificates%ROWTYPE;
  v_name varchar(255);
BEGIN
  IF NEW.lower_deduction_certificate_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_cert
    FROM tds_lower_deduction_certificates c
   WHERE c.id = NEW.lower_deduction_certificate_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT d.legal_name INTO v_name FROM tds_deductees d WHERE d.id = NEW.deductee_id;

  IF v_cert.deductee_id <> NEW.deductee_id THEN
    RAISE EXCEPTION
      'Certificate % was issued to a different deductee. A Section 197 '
      'certificate authorises a lower rate for ONE person against ONE section '
      '— it is not a rate this workspace may apply generally.',
      v_cert.certificate_number
      USING ERRCODE = '23514';
  END IF;

  IF v_cert.section <> NEW.section THEN
    RAISE EXCEPTION
      'Certificate % was issued for Section % and this deduction is under '
      'Section %. A certificate covers one section: a 194C certificate does not '
      'reduce a 194J fee to the same firm, and quoting it on the return against '
      'the wrong section is a short deduction the Department will raise.',
      v_cert.certificate_number, v_cert.section, NEW.section
      USING ERRCODE = '23514';
  END IF;

  -- ⭐ THE EXPENSIVE ONE.
  IF NEW.deduction_date < v_cert.valid_from OR NEW.deduction_date > v_cert.valid_to THEN
    RAISE EXCEPTION
      'Certificate % under Section 197 is valid from % to %, and this deduction '
      'is dated %. Outside that window the ORDINARY rate applies. A lapsed '
      'certificate is a real, correctly issued document and is no defence at '
      'all for the period after it closed — Section 201(1) makes the shortfall '
      'ours, with interest, and 30%% of the expenditure is disallowed under '
      'Section 40(a)(ia). Ask the deductee for the renewal; only they can apply '
      'for it.',
      v_cert.certificate_number, v_cert.valid_from, v_cert.valid_to,
      NEW.deduction_date
      USING ERRCODE = '23514';
  END IF;

  IF NOT v_cert.is_active THEN
    RAISE EXCEPTION
      'Certificate % has been withdrawn and cannot be applied to a deduction.',
      v_cert.certificate_number
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tds_deductions_certificate_window ON tds_deductions;
CREATE TRIGGER tds_deductions_certificate_window
  BEFORE INSERT OR UPDATE ON tds_deductions
  FOR EACH ROW EXECUTE FUNCTION enforce_tds_certificate_window();


-- ############################################################################
-- SECTION 6 — ⭐⭐ THE CUMULATIVE THRESHOLD
-- ############################################################################
--
-- THE GUARD THIS WHOLE PHASE EXISTS FOR.
--
-- Two invariants over each (deductee, section, financial year) group, both
-- checked at COMMIT because a group is written by several statements and is
-- only complete when the transaction ends:
--
--   ⭐ (a) THE RUNNING TOTAL MUST ACTUALLY RUN. `aggregate_before_minor` on
--          each row must equal the sum of `payment_base_minor` on every
--          earlier row, in date order.
--
--          A broken chain is never cosmetic. The aggregate is what the annual
--          threshold was tested against, so if it is wrong the test was wrong
--          — and the direction it is usually wrong in is too low, because the
--          usual cause is a BACKDATED invoice entered after the fact.
--
--   ⭐⭐ (b) A WHOLE-AGGREGATE SECTION PAST ITS ANNUAL THRESHOLD MAY NOT HAVE
--          DEDUCTED ON PART OF ITS OWN AGGREGATE.
--
--          Four ₹25,000 payments to a labour contractor reach Section 194C's
--          ₹1,00,000 annual limit. Once reached, tax is due on the WHOLE
--          ₹1,00,000, including the three payments already made below it. A
--          register showing ₹1,00,000 paid and ₹25,000 charged is the classic
--          under-deduction, and it is the one nothing else in the system can
--          see: every individual row is internally consistent.
--
-- ⚠️ WHY (b) NEEDS THE THRESHOLDS RESTATED IN SQL. The database cannot call
-- `lib/tds/sections.ts`. `tds_annual_threshold_minor()` below is a copy, and
-- Check 6 of the verification — plus a test in `tests/security/tds.test.ts` —
-- proves the copy still agrees with the original. A copy nobody checks is how
-- the guard quietly stops guarding.
--
-- ⚠️ `exempt` ROWS ARE EXCLUDED FROM BOTH. A payment the section does not
-- reach at all is not part of the section's aggregate, so counting it would
-- make the chain break on a row that is correct.

CREATE OR REPLACE FUNCTION tds_annual_threshold_minor(p_section tds_section)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  -- ⚠️ A COPY. lib/tds/sections.ts is the source of truth; Check 6 proves the
  -- two still agree. Paise. FY 2024-25 figures — every Finance Act moves some
  -- of them, and a deduction keeps the rate and threshold it was computed
  -- with, so changing these restates nothing already recorded.
  SELECT CASE p_section
           WHEN '194A'   THEN      500000::bigint  -- ₹5,000
           WHEN '194C'   THEN    10000000::bigint  -- ₹1,00,000  ⭐
           WHEN '194H'   THEN     2000000::bigint  -- ₹20,000
           WHEN '194I_a' THEN    24000000::bigint  -- ₹2,40,000
           WHEN '194I_b' THEN    24000000::bigint  -- ₹2,40,000
           WHEN '194J_a' THEN     3000000::bigint  -- ₹30,000
           WHEN '194J_b' THEN     3000000::bigint  -- ₹30,000
           ELSE NULL
         END;
$$;

CREATE OR REPLACE FUNCTION tds_section_aggregates_whole(p_section tds_section)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  -- ⚠️ MIRRORS `ThresholdMode = 'aggregate_whole'` IN lib/tds/sections.ts.
  --
  -- ⭐ 194Q IS DELIBERATELY ABSENT. Its threshold is on the aggregate and the
  -- tax is on the EXCESS over ₹50 lakh only — so `sum(chargeable) =
  -- sum(payment)` is FALSE for a healthy 194Q group, and applying (b) to it
  -- would refuse every correct 194Q deduction. ⭐ 194IA is absent because it
  -- does not aggregate across the year at all.
  SELECT p_section IN ('194A','194C','194H','194I_a','194I_b','194J_a','194J_b');
$$;

CREATE OR REPLACE FUNCTION enforce_tds_accumulation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_row        record;
  v_running    bigint := 0;
  v_paid       bigint := 0;
  v_charged    bigint := 0;
  v_threshold  bigint;
  v_name       varchar(255);
BEGIN
  SELECT d.legal_name INTO v_name FROM tds_deductees d WHERE d.id = NEW.deductee_id;

  /* --- ⭐ (a) THE CHAIN ------------------------------------------ */
  FOR v_row IN
    SELECT id, deduction_date, payment_base_minor, chargeable_base_minor,
           aggregate_before_minor
      FROM tds_deductions
     WHERE tenant_id      = NEW.tenant_id
       AND deductee_id    = NEW.deductee_id
       AND section        = NEW.section
       AND financial_year = NEW.financial_year
       AND outcome <> 'exempt'
     ORDER BY deduction_date, id
  LOOP
    IF v_row.aggregate_before_minor <> v_running THEN
      RAISE EXCEPTION
        'The running total for % under Section % in % breaks at the deduction '
        'dated %: the earlier rows total % paise and that row was computed '
        'against %. The aggregate is what the annual threshold is tested '
        'against, so this deduction and every one after it was decided on the '
        'wrong number. The usual cause is a BACKDATED payment entered after the '
        'fact — ordinary work, which means these rows need recomputing rather '
        'than editing by hand.',
        COALESCE(v_name, NEW.deductee_id::text), NEW.section, NEW.financial_year,
        v_row.deduction_date, v_running, v_row.aggregate_before_minor
        USING ERRCODE = '23514';
    END IF;
    v_running := v_running + v_row.payment_base_minor;
    v_paid    := v_paid + v_row.payment_base_minor;
    v_charged := v_charged + v_row.chargeable_base_minor;
  END LOOP;

  /* --- ⭐⭐ (b) THE CATCH-UP ------------------------------------- */
  IF tds_section_aggregates_whole(NEW.section) THEN
    v_threshold := tds_annual_threshold_minor(NEW.section);

    IF v_threshold IS NOT NULL AND v_paid >= v_threshold AND v_charged <> v_paid THEN
      RAISE EXCEPTION
        '% has been paid % paise under Section % in %, at or above the % paise '
        'annual threshold — so tax is deductible on the WHOLE aggregate, not on '
        'the payments made after it was crossed. Only % paise has been brought '
        'into charge, leaving % paise uncharged. Deducting on each payment in '
        'isolation is the classic error: Section 201(1) makes the whole '
        'shortfall ours whether or not the deductee paid their own tax on it, '
        'interest under 201(1A) runs from the date of each payment, and 30%% of '
        'the expenditure is disallowed under Section 40(a)(ia). Recompute the '
        'group so the crossing payment carries the catch-up.',
        COALESCE(v_name, NEW.deductee_id::text), v_paid, NEW.section,
        NEW.financial_year, v_threshold, v_charged, v_paid - v_charged
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tds_deductions_accumulation ON tds_deductions;
CREATE CONSTRAINT TRIGGER tds_deductions_accumulation
  AFTER INSERT OR UPDATE ON tds_deductions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_tds_accumulation();


-- ############################################################################
-- SECTION 7 — ⭐ A CHALLAN MAY NOT BE OVER-UTILISED
-- ############################################################################
--
-- THE FAILURE THAT PRODUCES A RETURN THE DEPARTMENT ACCEPTS AND SOME DEDUCTEES
-- GET NOTHING FROM.
--
--     ₹3,50,000 is deposited. ₹4,00,000 of deductions is mapped to that
--     challan. The quarterly statement is filed and ACCEPTED — nothing about
--     the file is malformed. The Department matches the challan against OLTAS,
--     finds ₹3,50,000, and gives credit until it runs out. The remaining
--     deductees get no entry in their Form 26AS, and which ones they are is
--     decided by the order the records were processed in.
--
--     They find out in October, when they file their own returns.
--
-- ⚠️ THE CAPACITY IS TAX + SURCHARGE + CESS, **NOT** `total_minor`. Interest
-- under Section 201(1A) and the fee under Section 234E are deposited on the
-- same challan and cannot discharge anybody's tax — OLTAS keeps the boxes
-- separate. Reconciling against the total makes the books balance while some
-- deductee's credit does not exist, which is strictly worse than not
-- reconciling at all.
--
-- ⚠️ DEFERRED, because a batch that re-points several deductions from one
-- challan to another passes through intermediate states in which the
-- destination is briefly over its capacity. Only the state at COMMIT is a
-- claim about anything.
--
-- ⚠️ AND IT FIRES ON `tds_challans` TOO. Editing a challan DOWNWARDS — a
-- typo corrected from ₹4,00,000 to ₹3,50,000 — over-utilises it without
-- touching a single deduction row.

CREATE OR REPLACE FUNCTION enforce_tds_challan_not_over_utilised()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_challan_id uuid;
  v_capacity   bigint;
  v_used       bigint;
  v_key        text;
BEGIN
  IF TG_TABLE_NAME = 'tds_challans' THEN
    v_challan_id := NEW.id;
  ELSE
    v_challan_id := NEW.challan_id;
  END IF;

  IF v_challan_id IS NULL THEN RETURN NULL; END IF;

  SELECT c.tax_minor + c.surcharge_minor + c.cess_minor,
         c.bsr_code || '/' || c.deposit_date::text || '/' || c.challan_serial
    INTO v_capacity, v_key
    FROM tds_challans c
   WHERE c.id = v_challan_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(d.tds_minor + d.surcharge_minor + d.cess_minor), 0)
    INTO v_used
    FROM tds_deductions d
   WHERE d.challan_id = v_challan_id;

  IF v_used > v_capacity THEN
    RAISE EXCEPTION
      'Challan % holds % paise of tax and % paise of deductions is mapped to it '
      '— % paise more than was ever deposited. The return would be ACCEPTED and '
      'the excess deductees would get NO credit in their Form 26AS, chosen by '
      'nothing anybody controls. Either the challan is short and the difference '
      'must be deposited with interest under Section 201(1A), or some of these '
      'deductions belong to another challan. ⚠️ Interest and the Section 234E '
      'fee on a challan cannot discharge anybody''s tax — the capacity here is '
      'tax plus surcharge plus cess only.',
      v_key, v_capacity, v_used, v_used - v_capacity
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tds_deductions_challan_capacity ON tds_deductions;
CREATE CONSTRAINT TRIGGER tds_deductions_challan_capacity
  AFTER INSERT OR UPDATE ON tds_deductions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_tds_challan_not_over_utilised();

DROP TRIGGER IF EXISTS tds_challans_capacity ON tds_challans;
CREATE CONSTRAINT TRIGGER tds_challans_capacity
  AFTER UPDATE ON tds_challans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_tds_challan_not_over_utilised();


-- ############################################################################
-- SECTION 8 — STATUTORY CONSTANTS, RESTATED FOR THE DATABASE
-- ############################################################################
--
-- ⚠️ THE FINANCIAL-YEAR QUARTER, WHICH IS NOT THE CALENDAR QUARTER. Q1 is
-- April–June and January is Q4 OF THE PREVIOUS FINANCIAL YEAR. Filing a
-- January deduction in "Q1" because January starts the calendar year puts it
-- in a return for a year that has not begun — rejected, after the due date.
--
-- `indian_financial_year(date)` already exists, from 0023. It is not
-- redefined; a second definition that disagreed by a day would put deductions
-- either side of 1 April into the wrong year's return and the wrong year's
-- threshold.

CREATE OR REPLACE FUNCTION tds_quarter_of(p_day date)
RETURNS tds_quarter
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN extract(month FROM p_day) BETWEEN 4 AND 6  THEN 'Q1'
           WHEN extract(month FROM p_day) BETWEEN 7 AND 9  THEN 'Q2'
           WHEN extract(month FROM p_day) BETWEEN 10 AND 12 THEN 'Q3'
           ELSE 'Q4'
         END::tds_quarter;
$$;

-- ⭐ Rule 30(2): the 7th of the following month, EXCEPT for tax deducted in
-- March, which is due on 30 April; and Rule 30(2C) gives Section 194-IA thirty
-- days from the END of the month, on Form 26QB.
--
-- ⚠️ THE MARCH EXCEPTION LOOKS LIKE A CONCESSION AND BEHAVES LIKE A TRAP: a
-- March deduction not deposited by 30 April misses the Q4 return due on
-- 31 May, and a return filed without the challan cannot claim it — so the
-- deductee's Form 26AS is short for the whole year, in the quarter their own
-- return is filed from.
CREATE OR REPLACE FUNCTION tds_deposit_due_date(p_day date, p_section tds_section)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN p_section = '194IA'
             THEN (date_trunc('month', p_day) + interval '1 month' - interval '1 day'
                   + interval '30 days')::date
           WHEN extract(month FROM p_day) = 3
             THEN make_date(extract(year FROM p_day)::int, 4, 30)
           ELSE (date_trunc('month', p_day) + interval '1 month'
                 + interval '6 days')::date
         END;
$$;

-- ⭐ Rule 31A(2). ⚠️ Q4 IS TWO MONTHS, NOT ONE — 31 May, not 30 April. The
-- reverse mistake accrues ₹200 a day under Section 234E for a month before
-- anybody looks.
CREATE OR REPLACE FUNCTION tds_return_due_date(p_fy varchar, p_quarter tds_quarter)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_quarter
           WHEN 'Q1' THEN make_date(left(p_fy, 4)::int,     7, 31)
           WHEN 'Q2' THEN make_date(left(p_fy, 4)::int,    10, 31)
           WHEN 'Q3' THEN make_date(left(p_fy, 4)::int + 1, 1, 31)
           ELSE            make_date(left(p_fy, 4)::int + 1, 5, 31)
         END;
$$;


-- ############################################################################
-- SECTION 9 — updated_at, AND THE CHANGE LOG
-- ############################################################################

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['tds_deductees','tds_lower_deduction_certificates',
                         'tds_challans','tds_returns','tds_deductions',
                         'tds_certificates'];
BEGIN
  FOREACH t IN ARRAY tables
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
    FOREACH t IN ARRAY tables
    LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_change_log', t);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION record_change()',
        t || '_change_log', t);
    END LOOP;
  END IF;

  -- ⚠️ AND THE IMPERSONATION GUARD. A support session wearing a customer's
  -- face must not be able to DELETE a tax record: a deleted deduction removes
  -- the evidence for a credit the Government has already given somebody, and
  -- it leaves no trace in the customer's own UI.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'refuse_delete_under_impersonation') THEN
    FOREACH t IN ARRAY tables
    LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'no_delete_under_impersonation', t);
      EXECUTE format(
        'CREATE TRIGGER no_delete_under_impersonation BEFORE DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION refuse_delete_under_impersonation()',
        t);
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
-- ⚠️ NO DELETE ON `tds_deductions`, `tds_challans` OR `tds_certificates`, AND
-- THAT IS THE POINT OF THE TABLES.
--
-- A deduction is money taken from somebody else and handed to the government
-- under our TAN. A challan is the government's own receipt for it. A
-- certificate is the document a vendor attaches to their own tax return. None
-- of the three is ours to tidy away: a deleted deduction leaves the deductee
-- with credit in their Form 26AS that our books cannot explain, and a deleted
-- challan leaves a set of deductions with no deposit behind them.
--
-- A wrong deduction is corrected by a further row and a correction statement,
-- which is also how the Department's own records behave.
--
-- `tds_deductees` and `tds_lower_deduction_certificates` DO get DELETE,
-- narrowly: a deductee created by mistake before anything was deducted from
-- them is an ordinary correction. The rows that matter are protected by the
-- RESTRICT foreign keys, which refuse the delete the moment a deduction points
-- at them.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON tds_deductees                    FROM ordence_app;
    REVOKE ALL ON tds_lower_deduction_certificates FROM ordence_app;
    REVOKE ALL ON tds_challans                     FROM ordence_app;
    REVOKE ALL ON tds_returns                      FROM ordence_app;
    REVOKE ALL ON tds_deductions                   FROM ordence_app;
    REVOKE ALL ON tds_certificates                 FROM ordence_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON tds_deductees                    TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON tds_lower_deduction_certificates TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON tds_challans                     TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON tds_returns                      TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON tds_deductions                   TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON tds_certificates                 TO ordence_app;

    GRANT EXECUTE ON FUNCTION tds_quarter_of(date)                         TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_deposit_due_date(date, tds_section)      TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_return_due_date(varchar, tds_quarter)    TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_annual_threshold_minor(tds_section)      TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_section_aggregates_whole(tds_section)    TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_section_206aa_floor_bps(tds_section)     TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 11 — VERIFICATION
-- ############################################################################
--
-- Every check names what breaks if it fails, because "FAIL" on its own tells
-- you nothing about whether to panic.

-- Check 1 — RLS is ENABLED **and FORCED** on all six new tables.
-- ⚠️ `relforcerowsecurity` is the column that matters. ENABLE without FORCE
-- looks protected in every UI and is not protected against the owner.
SELECT
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS (enabled + forced)'
       WHEN c.relrowsecurity
       THEN '*** FAIL — enabled but NOT FORCED: the owner bypasses it ***'
       ELSE '*** FAIL — ROW LEVEL SECURITY IS OFF: every tenant can read every '
            'other tenant''s deductee register, which is a list of every '
            'contractor they pay WITH THEIR PAN ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('tds_deductees','tds_lower_deduction_certificates',
                    'tds_challans','tds_returns','tds_deductions',
                    'tds_certificates')
ORDER BY c.relname;


-- Check 2 — every policy has BOTH a read and a write clause.
SELECT
  tablename, policyname,
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS (read + write)'
       WHEN with_check IS NULL
       THEN '*** FAIL — no WITH CHECK: a tenant can plant a deduction in '
            'another tenant''s register ***'
       ELSE '*** FAIL — no USING clause ***'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('tds_deductees','tds_lower_deduction_certificates',
                    'tds_challans','tds_returns','tds_deductions',
                    'tds_certificates')
ORDER BY tablename;


-- Check 3 — ⭐ the composite foreign keys exist (Section 4).
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: a row can point at another tenant''s record ***'
  END AS verdict
FROM (VALUES
  ('tds_deductees_vendor_same_tenant'),
  ('tds_deductees_partner_same_tenant'),
  ('tds_deductees_created_by_same_tenant'),
  ('tds_ldc_deductee_same_tenant'),
  ('tds_deductions_deductee_same_tenant'),
  ('tds_deductions_certificate_same_tenant'),
  ('tds_deductions_challan_same_tenant'),
  ('tds_deductions_return_same_tenant'),
  ('tds_deductions_invoice_same_tenant'),
  ('tds_deductions_vendor_same_tenant'),
  ('tds_deductions_project_same_tenant'),
  ('tds_deductions_partner_same_tenant'),
  ('tds_deductions_created_by_same_tenant'),
  ('tds_certificates_deductee_same_tenant'),
  ('tds_certificates_return_same_tenant')
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
  ('tds_deductions_rate_floor',           'tds_deductions'),
  ('tds_deductions_certificate_window',   'tds_deductions'),
  ('tds_deductions_accumulation',         'tds_deductions'),
  ('tds_deductions_challan_capacity',     'tds_deductions'),
  ('tds_challans_capacity',               'tds_challans')
) AS expected(tgname, tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tgname
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tgname;


-- Check 5 — ⭐⭐ THE CUMULATIVE THRESHOLD, PROVED NOT INSPECTED.
--
-- Four ₹25,000 payments to one labour contractor under Section 194C. The
-- first three are below both limbs and must be ACCEPTED as `below_threshold`.
-- The fourth reaches ₹1,00,000 and must be chargeable on the WHOLE aggregate:
-- an attempt to charge only its own ₹25,000 must be REFUSED, and the correct
-- catch-up must be ACCEPTED.
--
-- ⚠️ `SET CONSTRAINTS … IMMEDIATE` IS WHAT MAKES THIS CHECK MEAN ANYTHING.
-- The guard is DEFERRABLE INITIALLY DEFERRED, so it fires at COMMIT — and this
-- block ends in a deliberate rollback, so without forcing it the offending
-- INSERT "succeeds" and the check reports a failure that is entirely an
-- artefact of how it was written.
--
-- ⚠️ AND THE INSERT AND THE `SET CONSTRAINTS` MUST BE IN THE **SAME**
-- plpgsql BEGIN…EXCEPTION BLOCK. When a subtransaction aborts, the after-
-- trigger events queued inside it are discarded; events queued OUTSIDE it
-- would fire again at the block's own rollback and surface as an unrelated
-- failure.
DO $$
DECLARE
  v_tenant   uuid := gen_random_uuid();
  v_deductee uuid := gen_random_uuid();
  v_below_ok boolean := false;
  v_part_ref boolean := false;
  v_full_ok  boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_tds_' || v_tenant, 'tds-' || left(v_tenant::text, 8),
            'TDS threshold verification', 'active');
  INSERT INTO tds_deductees (id, tenant_id, code, legal_name, pan_number,
                             pan_status, deductee_type)
    VALUES (v_deductee, v_tenant, 'D-VFY', 'Verification Labour Contractor',
            'AAAPA1234A', 'valid', 'individual');

  /* --- Three ₹25,000 payments, below both limbs. MUST be accepted. */
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, aggregate_before_minor, aggregate_after_minor,
       outcome)
    VALUES
      (v_tenant, v_deductee, '194C', '2024-25', 'Q1', DATE '2024-04-10',
       2500000, 0, 2500000, 'below_threshold'),
      (v_tenant, v_deductee, '194C', '2024-25', 'Q1', DATE '2024-06-10',
       2500000, 2500000, 5000000, 'below_threshold'),
      (v_tenant, v_deductee, '194C', '2024-25', 'Q2', DATE '2024-09-10',
       2500000, 5000000, 7500000, 'below_threshold');
    SET CONSTRAINTS tds_deductions_accumulation IMMEDIATE;
    SET CONSTRAINTS tds_deductions_accumulation DEFERRED;
    v_below_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_below_ok := false;
    RAISE NOTICE 'below-threshold rows refused: %', SQLERRM;
  END;

  /* --- ⭐ The fourth payment, charged on its OWN ₹25,000 only.
         Every CHECK on the row passes and the chain is intact — only the
         cumulative guard catches it. MUST be REFUSED. --------------- */
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, catch_up_base_minor, chargeable_base_minor,
       aggregate_before_minor, aggregate_after_minor,
       rate_bps, rate_basis, tds_minor, total_deducted_minor, outcome)
    VALUES
      (v_tenant, v_deductee, '194C', '2024-25', 'Q3', DATE '2024-12-10',
       2500000, 0, 2500000, 7500000, 10000000,
       100, 'normal', 25000, 25000, 'deducted');
    SET CONSTRAINTS tds_deductions_accumulation IMMEDIATE;
    SET CONSTRAINTS tds_deductions_accumulation DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_part_ref := true;
  END;

  /* --- ⭐ The same payment with the catch-up. MUST be ACCEPTED. --- */
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, catch_up_base_minor, chargeable_base_minor,
       aggregate_before_minor, aggregate_after_minor,
       rate_bps, rate_basis, tds_minor, total_deducted_minor, outcome)
    VALUES
      (v_tenant, v_deductee, '194C', '2024-25', 'Q3', DATE '2024-12-10',
       2500000, 7500000, 10000000, 7500000, 10000000,
       100, 'normal', 100000, 100000, 'deducted');
    SET CONSTRAINTS tds_deductions_accumulation IMMEDIATE;
    SET CONSTRAINTS tds_deductions_accumulation DEFERRED;
    v_full_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_full_ok := false;
    RAISE NOTICE 'catch-up row refused: %', SQLERRM;
  END;

  IF v_below_ok AND v_part_ref AND v_full_ok THEN
    RAISE NOTICE 'PASS: ⭐⭐ four ₹25,000 payments cross Section 194C''s ₹1,00,000 '
                 'annual threshold, deducting on the fourth payment alone is '
                 'REFUSED, and the catch-up on the whole ₹1,00,000 is accepted.';
  ELSIF NOT v_below_ok THEN
    RAISE WARNING '*** FAIL — ordinary below-threshold payments were refused, so '
                  'the running total cannot be recorded at all and the annual '
                  'limb can never be applied. ***';
  ELSIF NOT v_part_ref THEN
    RAISE WARNING '*** FAIL — ⭐⭐ A DEDUCTION ON ₹25,000 WAS ACCEPTED WHERE '
                  '₹1,00,000 HAD BECOME CHARGEABLE. This is the classic and '
                  'expensive under-deduction: four correct-looking vouchers, no '
                  'error anywhere, and Section 201(1) makes the whole shortfall '
                  'ours with interest and a 30%% disallowance under Section '
                  '40(a)(ia). ***';
  ELSE
    RAISE WARNING '*** FAIL — the CORRECT catch-up was refused, so a workspace '
                  'cannot record the right answer at all. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 6 — ⭐ THE SQL COPY OF THE THRESHOLDS AGREES WITH lib/tds/sections.ts.
--
-- Section 6(b) cannot call TypeScript, so `tds_annual_threshold_minor()` is a
-- copy. A copy nobody checks is how a guard quietly stops guarding — it would
-- keep passing while testing the wrong number. `tests/security/tds.test.ts`
-- asserts the same table from the other side.
SELECT
  expected.section,
  CASE WHEN tds_annual_threshold_minor(expected.section::tds_section)
            IS NOT DISTINCT FROM expected.minor
       THEN 'PASS'
       ELSE '*** FAIL — the database and the engine disagree about Section '
            || expected.section || '''s annual threshold: SQL says '
            || COALESCE(tds_annual_threshold_minor(expected.section::tds_section)::text, 'NULL')
            || ', the engine says ' || COALESCE(expected.minor::text, 'NULL')
            || '. The cumulative guard is testing a different number from the '
            'one the deduction was computed against. ***'
  END AS verdict
FROM (VALUES
  ('194A',       500000::bigint),
  ('194C',     10000000::bigint),
  ('194H',      2000000::bigint),
  ('194I_a',   24000000::bigint),
  ('194I_b',   24000000::bigint),
  ('194J_a',    3000000::bigint),
  ('194J_b',    3000000::bigint),
  ('194IA',            NULL::bigint),
  ('192',              NULL::bigint),
  ('195',              NULL::bigint)
) AS expected(section, minor)
ORDER BY expected.section;


-- Check 7 — ⭐ SECTION 206AA: NO PAN MEANS AT LEAST 20%, AND 5% FOR 194Q.
DO $$
DECLARE
  v_tenant   uuid := gen_random_uuid();
  v_nopan    uuid := gen_random_uuid();
  v_haspan   uuid := gen_random_uuid();
  v_low_ref  boolean := false;
  v_20_ok    boolean := false;
  v_normal_ok boolean := false;
  v_194q_ok  boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_206_' || v_tenant, 'a206-' || left(v_tenant::text, 8),
            '206AA verification', 'active');
  INSERT INTO tds_deductees (id, tenant_id, code, legal_name, pan_status, deductee_type)
    VALUES (v_nopan, v_tenant, 'D-NOPAN', 'Contractor With No PAN',
            'not_furnished', 'individual');
  INSERT INTO tds_deductees (id, tenant_id, code, legal_name, pan_number,
                             pan_status, deductee_type)
    VALUES (v_haspan, v_tenant, 'D-PAN', 'Contractor With PAN', 'AAAPB5678C',
            'valid', 'individual');

  -- 1% under 194C against a PAN-less deductee. MUST be REFUSED.
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, chargeable_base_minor, aggregate_after_minor,
       rate_bps, tds_minor, total_deducted_minor, outcome)
    VALUES (v_tenant, v_nopan, '194C', '2024-25', 'Q1', DATE '2024-05-10',
            20000000, 20000000, 20000000, 100, 200000, 200000, 'deducted');
  EXCEPTION WHEN OTHERS THEN
    v_low_ref := true;
  END;

  -- 20% against the same deductee. MUST be ACCEPTED.
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, chargeable_base_minor, aggregate_after_minor,
       rate_bps, rate_basis, tds_minor, total_deducted_minor, outcome)
    VALUES (v_tenant, v_nopan, '194C', '2024-25', 'Q1', DATE '2024-05-10',
            20000000, 20000000, 20000000, 2000, 'section_206aa_no_pan',
            4000000, 4000000, 'deducted');
    v_20_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_20_ok := false;
    RAISE NOTICE '20%% deduction refused: %', SQLERRM;
  END;

  -- 1% against a deductee WITH a PAN. MUST be ACCEPTED.
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, chargeable_base_minor, aggregate_after_minor,
       rate_bps, tds_minor, total_deducted_minor, outcome)
    VALUES (v_tenant, v_haspan, '194C', '2024-25', 'Q1', DATE '2024-05-10',
            20000000, 20000000, 20000000, 100, 200000, 200000, 'deducted');
    v_normal_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_normal_ok := false;
    RAISE NOTICE 'normal 1%% deduction refused: %', SQLERRM;
  END;

  -- ⭐ 5% under 194Q against the PAN-less deductee. MUST be ACCEPTED: the
  -- second proviso to 206AA(1) caps it at 5%, not 20%. A guard that demanded
  -- 20% here would over-deduct fortyfold on a cement account.
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, chargeable_base_minor, aggregate_after_minor,
       rate_bps, rate_basis, tds_minor, total_deducted_minor, outcome)
    VALUES (v_tenant, v_nopan, '194Q', '2024-25', 'Q1', DATE '2024-05-11',
            100000000, 100000000, 100000000, 500, 'section_206aa_no_pan',
            5000000, 5000000, 'deducted');
    v_194q_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_194q_ok := false;
    RAISE NOTICE '194Q 5%% deduction refused: %', SQLERRM;
  END;

  IF v_low_ref AND v_20_ok AND v_normal_ok AND v_194q_ok THEN
    RAISE NOTICE 'PASS: ⭐ Section 206AA is enforced — a PAN-less deductee cannot '
                 'be deducted below 20%%, a deductee WITH a PAN still gets the '
                 'ordinary rate, and the 194Q cap of 5%% is respected.';
  ELSIF NOT v_low_ref THEN
    RAISE WARNING '*** FAIL — ⭐ A DEDUCTION AT 1%% WAS ACCEPTED AGAINST A '
                  'DEDUCTEE WITH NO PAN. Section 206AA requires 20%%. TRACES '
                  'raises a short-deduction demand for the whole year, and '
                  'Section 205 bars recovering it from the deductee. ***';
  ELSIF NOT v_20_ok THEN
    RAISE WARNING '*** FAIL — a CORRECT 20%% deduction under 206AA was refused. ***';
  ELSIF NOT v_normal_ok THEN
    RAISE WARNING '*** FAIL — the ordinary rate was refused for a deductee who '
                  'HAS furnished a PAN, so every compliant vendor is over-'
                  'deducted twentyfold. ***';
  ELSE
    RAISE WARNING '*** FAIL — the 194Q cap of 5%% under the second proviso to '
                  '206AA(1) is not honoured, so a cement account is deducted at '
                  '20%% instead of 5%% of the excess. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 8 — ⭐ A SECTION 197 CERTIFICATE APPLIES INSIDE ITS WINDOW ONLY.
DO $$
DECLARE
  v_tenant   uuid := gen_random_uuid();
  v_deductee uuid := gen_random_uuid();
  v_cert     uuid := gen_random_uuid();
  v_in_ok    boolean := false;
  v_out_ref  boolean := false;
  v_sect_ref boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_197_' || v_tenant, 'a197-' || left(v_tenant::text, 8),
            '197 verification', 'active');
  INSERT INTO tds_deductees (id, tenant_id, code, legal_name, pan_number,
                             pan_status, deductee_type)
    VALUES (v_deductee, v_tenant, 'D-197', 'Subcontractor With Certificate',
            'AAACD1234E', 'valid', 'company');
  INSERT INTO tds_lower_deduction_certificates
    (id, tenant_id, deductee_id, certificate_number, section, rate_bps,
     valid_from, valid_to, financial_year)
    VALUES (v_cert, v_tenant, v_deductee, 'CERT001', '194C', 50,
            DATE '2024-06-01', DATE '2025-03-31', '2024-25');

  -- Inside the window, at 0.5%. MUST be ACCEPTED.
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, chargeable_base_minor, aggregate_after_minor,
       rate_bps, rate_basis, lower_deduction_certificate_id,
       tds_minor, total_deducted_minor, outcome)
    VALUES (v_tenant, v_deductee, '194C', '2024-25', 'Q2', DATE '2024-08-15',
            50000000, 50000000, 50000000, 50, 'section_197_certificate', v_cert,
            250000, 250000, 'deducted');
    v_in_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_in_ok := false;
    RAISE NOTICE 'in-window certificate deduction refused: %', SQLERRM;
  END;

  -- ⭐ BEFORE the window opened. MUST be REFUSED. Payments made while the
  -- application was pending are at the ordinary rate.
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, chargeable_base_minor, aggregate_after_minor,
       rate_bps, rate_basis, lower_deduction_certificate_id,
       tds_minor, total_deducted_minor, outcome)
    VALUES (v_tenant, v_deductee, '194C', '2024-25', 'Q1', DATE '2024-04-15',
            50000000, 50000000, 50000000, 50, 'section_197_certificate', v_cert,
            250000, 250000, 'deducted');
  EXCEPTION WHEN OTHERS THEN
    v_out_ref := true;
  END;

  -- Right window, WRONG SECTION. MUST be REFUSED.
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, chargeable_base_minor, aggregate_after_minor,
       rate_bps, rate_basis, lower_deduction_certificate_id,
       tds_minor, total_deducted_minor, outcome)
    VALUES (v_tenant, v_deductee, '194J_b', '2024-25', 'Q2', DATE '2024-08-15',
            50000000, 50000000, 50000000, 50, 'section_197_certificate', v_cert,
            250000, 250000, 'deducted');
  EXCEPTION WHEN OTHERS THEN
    v_sect_ref := true;
  END;

  IF v_in_ok AND v_out_ref AND v_sect_ref THEN
    RAISE NOTICE 'PASS: ⭐ a Section 197 certificate reduces the rate inside its '
                 'window and is refused outside it, and for another section.';
  ELSIF NOT v_in_ok THEN
    RAISE WARNING '*** FAIL — a VALID certificate was refused inside its own '
                  'window, so a lawful lower deduction cannot be recorded and '
                  'the vendor is over-deducted for the year. ***';
  ELSIF NOT v_out_ref THEN
    RAISE WARNING '*** FAIL — ⭐ A LAPSED (OR NOT YET EFFECTIVE) CERTIFICATE WAS '
                  'APPLIED. This is the commonest way a lower-deduction '
                  'certificate turns into a demand: a real, correctly issued '
                  'document that is no defence at all outside its window. ***';
  ELSE
    RAISE WARNING '*** FAIL — a 194C certificate was applied to a 194J deduction. '
                  'A certificate covers ONE section. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 9 — ⭐ A CHALLAN CANNOT BE OVER-UTILISED, AND INTEREST DOES NOT COUNT.
DO $$
DECLARE
  v_tenant   uuid := gen_random_uuid();
  v_deductee uuid := gen_random_uuid();
  v_challan  uuid := gen_random_uuid();
  v_fit_ok   boolean := false;
  v_over_ref boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_chl_' || v_tenant, 'chl-' || left(v_tenant::text, 8),
            'Challan verification', 'active');
  INSERT INTO tds_deductees (id, tenant_id, code, legal_name, pan_number,
                             pan_status, deductee_type)
    VALUES (v_deductee, v_tenant, 'D-CHL', 'Challan Verification Vendor',
            'AAACF9999K', 'valid', 'company');
  -- ⭐ ₹1,000 of tax and ₹300 of interest. The capacity is ₹1,000, NOT ₹1,300:
  -- interest deposited on a challan cannot discharge anybody's tax.
  INSERT INTO tds_challans
    (id, tenant_id, tan, bsr_code, challan_serial, deposit_date,
     financial_year, assessment_year, quarter,
     tax_minor, interest_minor, total_minor)
    VALUES (v_challan, v_tenant, 'RTKA12345B', '0001234', '00001',
            DATE '2024-06-07', '2024-25', '2025-26', 'Q1',
            100000, 30000, 130000);

  -- ₹1,000 of deductions against ₹1,000 of tax capacity. MUST be ACCEPTED.
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, chargeable_base_minor, aggregate_after_minor,
       rate_bps, tds_minor, total_deducted_minor, outcome, challan_id)
    VALUES (v_tenant, v_deductee, '194C', '2024-25', 'Q1', DATE '2024-05-10',
            5000000, 5000000, 5000000, 200, 100000, 100000, 'deducted', v_challan);
    SET CONSTRAINTS tds_deductions_challan_capacity IMMEDIATE;
    SET CONSTRAINTS tds_deductions_challan_capacity DEFERRED;
    v_fit_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_fit_ok := false;
    RAISE NOTICE 'fitting deduction refused: %', SQLERRM;
  END;

  -- ⭐ One more rupee. The challan's TOTAL would still cover it — the interest
  -- box has ₹300 in it — and the tax box does not. MUST be REFUSED.
  BEGIN
    INSERT INTO tds_deductions
      (tenant_id, deductee_id, section, financial_year, quarter, deduction_date,
       payment_base_minor, catch_up_base_minor, chargeable_base_minor,
       aggregate_before_minor, aggregate_after_minor,
       rate_bps, tds_minor, total_deducted_minor, outcome, challan_id)
    VALUES (v_tenant, v_deductee, '194C', '2024-25', 'Q1', DATE '2024-05-11',
            5000000, 0, 5000000, 5000000, 10000000,
            200, 100000, 100000, 'deducted', v_challan);
    SET CONSTRAINTS tds_deductions_challan_capacity IMMEDIATE;
    SET CONSTRAINTS tds_deductions_challan_capacity DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    v_over_ref := true;
  END;

  IF v_fit_ok AND v_over_ref THEN
    RAISE NOTICE 'PASS: ⭐ a challan cannot carry more tax than was deposited into '
                 'it, and the interest box does not add to its capacity.';
  ELSIF NOT v_fit_ok THEN
    RAISE WARNING '*** FAIL — a deduction that FITS its challan was refused, so '
                  'no deposit can be mapped at all. ***';
  ELSE
    RAISE WARNING '*** FAIL — ⭐ A CHALLAN WAS OVER-UTILISED. The return would be '
                  'ACCEPTED and the excess deductees would get NO credit in '
                  'their Form 26AS, chosen by the order the Department '
                  'processes records in. They find out in October. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 10 — ⭐ ONE DEDUCTEE PER PAN.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_dup_ref boolean := false;
  v_two_nopan_ok boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_pan_' || v_tenant, 'pan-' || left(v_tenant::text, 8),
            'PAN uniqueness verification', 'active');
  INSERT INTO tds_deductees (tenant_id, code, legal_name, pan_number, pan_status)
    VALUES (v_tenant, 'D-1', 'Sahyadri Constructions', 'AAACS1234F', 'valid');

  -- The same PAN under a slightly different trade name. MUST be REFUSED.
  BEGIN
    INSERT INTO tds_deductees (tenant_id, code, legal_name, pan_number, pan_status)
      VALUES (v_tenant, 'D-2', 'Sahyadri Constructions Pvt Ltd', 'AAACS1234F', 'valid');
  EXCEPTION WHEN OTHERS THEN
    v_dup_ref := true;
  END;

  -- Two deductees with NO PAN. MUST be ACCEPTED — a PAN-less deductee is
  -- lawful at 20%, and refusing them would push somebody into inventing a
  -- number, which is worse than the 20%.
  BEGIN
    INSERT INTO tds_deductees (tenant_id, code, legal_name, pan_status)
      VALUES (v_tenant, 'D-3', 'Labour Gang A', 'not_furnished'),
             (v_tenant, 'D-4', 'Labour Gang B', 'not_furnished');
    v_two_nopan_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_two_nopan_ok := false;
  END;

  IF v_dup_ref AND v_two_nopan_ok THEN
    RAISE NOTICE 'PASS: ⭐ one deductee row per PAN, and several PAN-less '
                 'deductees may coexist.';
  ELSIF NOT v_dup_ref THEN
    RAISE WARNING '*** FAIL — ⭐ TWO DEDUCTEE ROWS SHARE ONE PAN. The annual '
                  'threshold is on the PAN, so the running total is split in '
                  'two and each half sits under ₹1,00,000 while the person is '
                  'over it. It under-deducts by construction. ***';
  ELSE
    RAISE WARNING '*** FAIL — two PAN-less deductees were refused, which pushes '
                  'somebody into inventing a PAN. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 11 — the app role cannot DELETE a tax record.
SELECT
  t.table_name, t.privilege_type,
  '*** FAIL — DELETE granted: the evidence for credit the Government has '
  'already given a deductee can be erased ***' AS verdict
FROM information_schema.role_table_grants t
WHERE t.grantee = 'ordence_app'
  AND t.privilege_type = 'DELETE'
  AND t.table_name IN ('tds_deductions','tds_challans','tds_certificates','tds_returns');
-- (No rows returned = PASS.)


-- Check 12 — the calendar functions agree with lib/tds/calendar.ts.
-- ⚠️ A disagreement puts a deduction in the wrong quarter's return, which the
-- Department rejects — after the due date, with the Section 234E fee running.
SELECT
  sample.label,
  CASE WHEN sample.actual::text = sample.expected THEN 'PASS'
       ELSE '*** FAIL — got ' || sample.actual::text || ', expected '
            || sample.expected || ' ***'
  END AS verdict
FROM (VALUES
  -- ⚠️ January is Q4 of the PREVIOUS financial year.
  ('quarter of 15 Jan 2025',   tds_quarter_of(DATE '2025-01-15')::text, 'Q4'),
  ('quarter of 1 Apr 2024',    tds_quarter_of(DATE '2024-04-01')::text, 'Q1'),
  ('quarter of 30 Sep 2024',   tds_quarter_of(DATE '2024-09-30')::text, 'Q2'),
  ('quarter of 1 Oct 2024',    tds_quarter_of(DATE '2024-10-01')::text, 'Q3'),
  -- Rule 30(2): 7th of the following month.
  ('deposit due, 10 May 2024', tds_deposit_due_date(DATE '2024-05-10', '194C')::text,
                               '2024-06-07'),
  -- ⭐ March is the exception: 30 April.
  ('deposit due, 31 Mar 2025', tds_deposit_due_date(DATE '2025-03-31', '194C')::text,
                               '2025-04-30'),
  -- ⭐ 194-IA: thirty days from the end of the month, on Form 26QB.
  ('deposit due, 194IA May',   tds_deposit_due_date(DATE '2024-05-10', '194IA')::text,
                               '2024-06-30'),
  -- ⭐ Rule 31A(2): Q4 is 31 May, not 30 April.
  ('return due, Q4 2024-25',   tds_return_due_date('2024-25', 'Q4')::text, '2025-05-31'),
  ('return due, Q1 2024-25',   tds_return_due_date('2024-25', 'Q1')::text, '2024-07-31'),
  ('return due, Q3 2024-25',   tds_return_due_date('2024-25', 'Q3')::text, '2025-01-31')
) AS sample(label, actual, expected);


-- Check 13 — nothing points across a tenant boundary TODAY.
SELECT 'deductions → deductees' AS relationship, count(*) AS violations,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END AS verdict
  FROM tds_deductions d JOIN tds_deductees e ON e.id = d.deductee_id
 WHERE d.tenant_id <> e.tenant_id
UNION ALL
SELECT 'deductions → challans', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM tds_deductions d JOIN tds_challans c ON c.id = d.challan_id
 WHERE d.tenant_id <> c.tenant_id
UNION ALL
SELECT 'deductions → certificates (197)', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM tds_deductions d
  JOIN tds_lower_deduction_certificates l ON l.id = d.lower_deduction_certificate_id
 WHERE d.tenant_id <> l.tenant_id
UNION ALL
SELECT 'deductions → returns', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM tds_deductions d JOIN tds_returns r ON r.id = d.tds_return_id
 WHERE d.tenant_id <> r.tenant_id
UNION ALL
SELECT 'Form 16A → deductees', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM tds_certificates f JOIN tds_deductees e ON e.id = f.deductee_id
 WHERE f.tenant_id <> e.tenant_id;


-- Check 14 — ⭐ no whole-aggregate section has deducted on PART of its own
-- aggregate TODAY.
--
-- Belt and braces: if the trigger were added after data existed, a wrong group
-- could predate it. This is the single query a TDS assessment starts from, and
-- it is the one that finds a year of history entered by somebody who tested
-- each payment on its own.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every deductee past an annual threshold has been charged on '
            'the whole aggregate'
       ELSE '*** FAIL — ' || count(*) || ' (deductee, section, year) group(s) '
            'have crossed the annual threshold and had tax computed on only '
            'part of the aggregate. Section 201(1) makes the whole shortfall '
            'ours, interest under 201(1A) runs from the date of each payment, '
            'and 30% of the expenditure is disallowed under Section 40(a)(ia). '
            '***'
  END AS check_no_partial_catch_up
FROM (
  SELECT tenant_id, deductee_id, section, financial_year,
         sum(payment_base_minor)    AS paid,
         sum(chargeable_base_minor) AS charged
    FROM tds_deductions
   WHERE outcome <> 'exempt'
     AND tds_section_aggregates_whole(section)
   GROUP BY tenant_id, deductee_id, section, financial_year
) g
WHERE tds_annual_threshold_minor(g.section) IS NOT NULL
  AND g.paid >= tds_annual_threshold_minor(g.section)
  AND g.charged <> g.paid;


-- Check 15 — ⭐ no challan is over-utilised TODAY.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every challan carries at most the tax deposited into it'
       ELSE '*** FAIL — ' || count(*) || ' challan(s) have more tax mapped to '
            'them than was ever deposited. The returns quoting them are '
            'ACCEPTED and the excess deductees get no credit in their Form '
            '26AS. ***'
  END AS check_no_over_utilised_challans
FROM (
  SELECT c.id,
         c.tax_minor + c.surcharge_minor + c.cess_minor AS capacity,
         COALESCE(sum(d.tds_minor + d.surcharge_minor + d.cess_minor), 0) AS used
    FROM tds_challans c
    LEFT JOIN tds_deductions d ON d.challan_id = c.id
   GROUP BY c.id, c.tax_minor, c.surcharge_minor, c.cess_minor
) u
WHERE u.used > u.capacity;


-- Check 16 — ⭐ no deduction below the 206AA floor for a PAN-less deductee
-- TODAY.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: no deductee without a usable PAN has been deducted below the '
            'Section 206AA floor'
       ELSE '*** FAIL — ' || count(*) || ' deduction(s) against a deductee with '
            'no usable PAN are below the Section 206AA rate. TRACES raises a '
            'short-deduction demand for the whole year, and Section 205 bars '
            'recovering it from the deductee. ***'
  END AS check_206aa_floor
FROM tds_deductions d
JOIN tds_deductees e ON e.id = d.deductee_id AND e.tenant_id = d.tenant_id
WHERE d.outcome = 'deducted'
  AND NOT (e.pan_status = 'valid' AND e.pan_number IS NOT NULL)
  AND d.rate_bps < tds_section_206aa_floor_bps(d.section);


-- Check 17 — ⭐ no Section 197 certificate has been applied outside its window
-- TODAY.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every certificate-rate deduction falls inside its '
            'certificate''s window'
       ELSE '*** FAIL — ' || count(*) || ' deduction(s) apply a Section 197 '
            'certificate outside its validity window or to another section. A '
            'lapsed certificate is no defence for the period after it closed. '
            '***'
  END AS check_197_window
FROM tds_deductions d
JOIN tds_lower_deduction_certificates l
  ON l.id = d.lower_deduction_certificate_id AND l.tenant_id = d.tenant_id
WHERE d.deduction_date < l.valid_from
   OR d.deduction_date > l.valid_to
   OR l.section <> d.section
   OR l.deductee_id <> d.deductee_id;


-- Check 18 — the change log covers this phase.
SELECT
  expected.tbl,
  CASE WHEN t.tgname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — changes here are not recorded and could never sync ***'
  END AS verdict
FROM (VALUES
  ('tds_deductees'), ('tds_lower_deduction_certificates'), ('tds_challans'),
  ('tds_returns'), ('tds_deductions'), ('tds_certificates')
) AS expected(tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tbl || '_change_log'
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tbl;


-- Check 19 — ⭐ a support session cannot DELETE a tax record.
SELECT
  expected.tbl,
  CASE WHEN t.tgname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — an impersonating operator can delete from this table, '
            'and a deleted deduction removes the evidence for credit the '
            'Government has already given a third party ***'
  END AS verdict
FROM (VALUES
  ('tds_deductees'), ('tds_lower_deduction_certificates'), ('tds_challans'),
  ('tds_returns'), ('tds_deductions'), ('tds_certificates')
) AS expected(tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = 'no_delete_under_impersonation'
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tbl;


-- Check 20 — the unique keys that make the phase safe exist.
SELECT
  expected.idx,
  CASE WHEN EXISTS (SELECT 1 FROM pg_indexes
                     WHERE schemaname = 'public' AND indexname = expected.idx)
       THEN 'PASS'
       ELSE '*** FAIL — ' || expected.idx || ' IS MISSING ***'
  END AS verdict
FROM (VALUES
  -- ⭐ Two rows for one PAN split the annual threshold in two.
  ('tds_deductees_pan_tenant_unique'),
  -- ⭐ One challan recorded twice lets the register reconcile against money
  -- that only moved once.
  ('tds_challans_oltas_key'),
  -- Two original returns for one quarter produce two sets of credit in the
  -- deductees' Form 26AS, and the Department resolves it by rejecting one.
  ('tds_returns_period_key'),
  ('tds_certificates_quarter_key'),
  ('tds_deductions_accumulation_idx')
) AS expected(idx)
ORDER BY expected.idx;
