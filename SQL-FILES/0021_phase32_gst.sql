-- ============================================================================
-- Ordence — Phase 32: GST Foundation
-- Version: v0.32.0-alpha
--
-- Run AFTER `ALL-IN-ONE-SETUP.sql` (Phase 1–22 baseline) and after
-- `0017_change_log.sql` — it depends on `set_updated_at()`,
-- `app_current_tenant_id()` and `record_change()`. It also EXTENDS the
-- Phase 11/16 `invoices` and `invoice_lines` tables, so those must exist.
--
-- Safe to run before `drizzle-kit push`: Section 1 creates its own tables and
-- columns idempotently. Safe to re-run: every statement is guarded.
--
-- Contents:
--   1.  Enums, tables, and the extension of the Phase 16 invoice
--   2.  Row-level security
--   3.  ⭐ Composite foreign keys — the hole RLS does NOT close
--   4.  ⭐ NO TWO RATES MAY COVER ONE DAY — the exclusion constraint
--   5.  ⭐ A RATE AN INVOICE HAS USED IS FROZEN
--   6.  ⭐ THE INVOICE MUST ADD UP — deferred, at commit
--   7.  The GSTIN checksum, in the database
--   8.  Immovable property: the place of supply IS the property
--   9.  updated_at, and the change log
--   10. Grants
--   11. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Thirty-one phases have enforced rules whose violation was VISIBLE: a double
-- booking, a run that would not stop, a total that did not balance. Somebody
-- noticed within the hour.
--
-- This phase enforces rules whose violation is INVISIBLE FOR YEARS.
--
--     A GST rate is corrected in the master. Every historical invoice
--     re-renders at the new rate. No exception is raised, no row changes, no
--     page looks different. The documents simply stop matching the returns
--     that were filed against them, and it is discovered during an assessment
--     two years later — at which point the interest has been running since
--     the original date.
--
--     An invoice for a flat in Pune is taxed as an inter-state supply because
--     the buyer's GSTIN is Karnataka. The total is right to the paisa. The
--     buyer cannot claim the credit, because it sits in a state we never
--     supplied. Recovering the wrongly-paid tax is an application under
--     Section 77 that takes months.
--
-- Neither of those can be caught by looking at the product. So they are caught
-- here, by constraints:
--
--   • Section 4 — two rates may not cover the same day, so "which rate
--     applied" never has two answers.
--   • Section 5 — a rate row an invoice has already used cannot have its rate
--     changed, and cannot have its window pulled off that invoice's date.
--   • Section 6 — an invoice's tax heads must equal the sum of its lines, at
--     COMMIT, so a header written by one code path and lines by another cannot
--     drift apart.
--   • Section 8 — for immovable property, the place of supply must EQUAL the
--     property's state. The database refuses the mistake everybody makes.
--
-- Money is bigint paise. Rates are integer basis points.
-- ============================================================================


CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

-- Needed by the EXCLUDE constraint in Section 4: it mixes an equality on uuid
-- columns with an overlap on a daterange, and a plain GiST index cannot do the
-- equality half without this.
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ############################################################################
-- SECTION 1 — ENUMS, TABLES, AND THE EXTENSION OF THE PHASE 16 INVOICE
-- ############################################################################
--
-- `drizzle-kit push` creates the four new tables from `db/schema/gst.ts`. They
-- are restated here because a file that can only run second is a file that
-- fails on a fresh database.
--
-- ⚠️ THE INVOICE IS EXTENDED, NOT REPLACED. A parallel `tax_invoices` table
-- would give "what did we bill them" two answers, which is the failure mode
-- this phase exists to close. Every column added below is NULLABLE or
-- DEFAULTED, so the Phase 11 subscription invoices already in the table stay
-- valid without a backfill.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gst_registration_type') THEN
    CREATE TYPE gst_registration_type AS ENUM
      ('regular','composition','unregistered','sez','overseas');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gst_supply_type') THEN
    CREATE TYPE gst_supply_type AS ENUM ('goods','services','immovable_property');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hsn_sac_kind') THEN
    CREATE TYPE hsn_sac_kind AS ENUM ('hsn','sac');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gst_party_type') THEN
    CREATE TYPE gst_party_type AS ENUM ('customer','vendor');
  END IF;
END
$$;


CREATE TABLE IF NOT EXISTS gst_registrations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  gstin              varchar(15)  NOT NULL,
  state_code         varchar(2)   NOT NULL,
  legal_name         varchar(255) NOT NULL,
  trade_name         varchar(255),
  registration_type  gst_registration_type NOT NULL DEFAULT 'regular',
  address            jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from     date NOT NULL,
  effective_to       date,
  is_primary         boolean NOT NULL DEFAULT false,
  is_active          boolean NOT NULL DEFAULT true,
  notes              text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gst_registrations_gstin_shape
    CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'),
  -- The denormalised state must stay equal to the GSTIN prefix. Every tax
  -- decision reads the column; the GSTIN is the truth.
  CONSTRAINT gst_registrations_state_matches_gstin
    CHECK (state_code = substring(gstin from 1 for 2)),
  CONSTRAINT gst_registrations_period_sane
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS gst_parties (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_type           gst_party_type NOT NULL,
  lead_id              uuid,
  channel_partner_id   uuid,
  company_id           uuid,
  legal_name           varchar(255) NOT NULL,
  trade_name           varchar(255),
  gstin                varchar(15),
  pan_number           varchar(10),
  registration_type    gst_registration_type NOT NULL DEFAULT 'unregistered',
  state_code           varchar(2),
  address              jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from       date NOT NULL,
  effective_to         date,
  is_active            boolean NOT NULL DEFAULT true,
  verified_at          timestamptz,
  verification_source  varchar(60),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gst_parties_gstin_shape
    CHECK (gstin IS NULL
           OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'),
  -- ⚠️ A "regular" party with no GSTIN fails at GSTR-1 upload weeks later;
  -- an "unregistered" party WITH one silently denies the buyer their input
  -- credit. Both are refused here rather than at filing.
  CONSTRAINT gst_parties_type_matches_gstin
    CHECK ((registration_type IN ('unregistered','overseas') AND gstin IS NULL)
        OR (registration_type NOT IN ('unregistered','overseas') AND gstin IS NOT NULL)),
  CONSTRAINT gst_parties_state_matches_gstin
    CHECK (gstin IS NULL OR state_code IS NULL
           OR state_code = substring(gstin from 1 for 2)),
  CONSTRAINT gst_parties_period_sane
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS hsn_sac_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code         varchar(8) NOT NULL,
  kind         hsn_sac_kind NOT NULL,
  description  text NOT NULL,
  uqc          varchar(10),
  is_active    boolean NOT NULL DEFAULT true,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- HSN is 2/4/6/8 digits; SAC is six digits starting 99. A code of the wrong
  -- shape passes every screen and is rejected by the GSTN portal at filing.
  CONSTRAINT hsn_sac_codes_shape
    CHECK ((kind = 'hsn' AND code ~ '^[0-9]{2}([0-9]{2}([0-9]{2}([0-9]{2})?)?)?$')
        OR (kind = 'sac' AND code ~ '^99[0-9]{4}$'))
);

-- ⭐ THE TABLE THE WHOLE PHASE IS BUILT AROUND. See db/schema/gst.ts for the
-- long version; the short version is that a rate is a fact about a PERIOD, and
-- a rate stored on the code restates every historical invoice the day somebody
-- corrects it.
CREATE TABLE IF NOT EXISTS hsn_sac_rates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hsn_sac_id           uuid NOT NULL,
  rate_bps             integer NOT NULL,
  cess_rate_bps        integer NOT NULL DEFAULT 0,
  cess_per_unit_minor  bigint  NOT NULL DEFAULT 0,
  effective_from       date NOT NULL,
  effective_to         date,
  notification_ref     varchar(160),
  itc_eligible         boolean NOT NULL DEFAULT true,
  reverse_charge       boolean NOT NULL DEFAULT false,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hsn_sac_rates_rate_sane CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  -- ⚠️ Cess is NOT bounded by 10000. Compensation cess on some tobacco runs
  -- past 200%, and a bound written by analogy with the GST rate would refuse a
  -- legitimate notification.
  CONSTRAINT hsn_sac_rates_cess_sane
    CHECK (cess_rate_bps >= 0 AND cess_rate_bps <= 100000 AND cess_per_unit_minor >= 0),
  -- Strictly greater: a window that opens and closes on one day applied for
  -- zero days and would sit invisibly in the middle of a correct history.
  CONSTRAINT hsn_sac_rates_period_sane
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);


-- ---------------------------------------------------------------------------
-- 1b. Indexes
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS gst_registrations_gstin_tenant_unique
  ON gst_registrations (tenant_id, gstin);
-- ⭐ One default GSTIN. Two would mean "which do we issue from" is decided by
-- whichever the ORDER BY happens to put first.
CREATE UNIQUE INDEX IF NOT EXISTS gst_registrations_one_primary
  ON gst_registrations (tenant_id) WHERE is_primary AND is_active;
CREATE INDEX IF NOT EXISTS gst_registrations_tenant_idx ON gst_registrations (tenant_id);
CREATE INDEX IF NOT EXISTS gst_registrations_state_idx
  ON gst_registrations (tenant_id, state_code);

CREATE UNIQUE INDEX IF NOT EXISTS gst_parties_gstin_type_unique
  ON gst_parties (tenant_id, party_type, gstin) WHERE gstin IS NOT NULL AND is_active;
CREATE INDEX IF NOT EXISTS gst_parties_tenant_idx ON gst_parties (tenant_id, party_type);
CREATE INDEX IF NOT EXISTS gst_parties_lead_idx ON gst_parties (tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS gst_parties_partner_idx
  ON gst_parties (tenant_id, channel_partner_id);
CREATE INDEX IF NOT EXISTS gst_parties_gstin_idx ON gst_parties (tenant_id, gstin);

CREATE UNIQUE INDEX IF NOT EXISTS hsn_sac_codes_code_tenant_unique
  ON hsn_sac_codes (tenant_id, code);
CREATE INDEX IF NOT EXISTS hsn_sac_codes_tenant_idx ON hsn_sac_codes (tenant_id, kind);

CREATE INDEX IF NOT EXISTS hsn_sac_rates_code_idx
  ON hsn_sac_rates (hsn_sac_id, effective_from);
CREATE INDEX IF NOT EXISTS hsn_sac_rates_tenant_idx ON hsn_sac_rates (tenant_id);
CREATE INDEX IF NOT EXISTS hsn_sac_rates_resolve_idx
  ON hsn_sac_rates (tenant_id, hsn_sac_id, effective_from, effective_to);


-- ---------------------------------------------------------------------------
-- 1c. ⭐ EXTENDING THE PHASE 16 INVOICE
-- ---------------------------------------------------------------------------
--
-- Rule 46 wants facts the Phase 11 schema had no reason to hold: our own GSTIN
-- and state (it assumed one), whether the supply is goods, services or
-- immovable property, where the property is, whether the tax is on reverse
-- charge, and cess.
--
-- ⚠️ `gst_computed` IS THE COMPATIBILITY SWITCH, AND IT IS WHY THIS SECTION
-- DOES NOT BREAK PHASE 16. The subscription invoice generator writes header
-- taxes with no per-line tax columns at all. The reconciliation trigger in
-- Section 6 would refuse every one of those. So it only fires on documents
-- that say they were computed by the Phase 32 engine — and any document that
-- says so must add up.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS supplier_registration_id uuid,
  ADD COLUMN IF NOT EXISTS supplier_gstin           varchar(15),
  ADD COLUMN IF NOT EXISTS supplier_state_code      varchar(2),
  ADD COLUMN IF NOT EXISTS supply_type              gst_supply_type NOT NULL DEFAULT 'services',
  ADD COLUMN IF NOT EXISTS property_state_code      varchar(2),
  ADD COLUMN IF NOT EXISTS recipient_registration   gst_registration_type,
  ADD COLUMN IF NOT EXISTS place_of_supply_basis    varchar(40),
  ADD COLUMN IF NOT EXISTS is_union_territory       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_reverse_charge        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reverse_charge_tax_minor bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cess_minor               bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_off_minor          bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_point_date           date,
  ADD COLUMN IF NOT EXISTS gst_computed             boolean NOT NULL DEFAULT false;

ALTER TABLE invoice_lines
  -- ⭐ The exact rate row this line was priced from. ON DELETE RESTRICT in
  -- Section 3, so history cannot be unmade by tidying the master.
  ADD COLUMN IF NOT EXISTS gst_rate_id         uuid,
  ADD COLUMN IF NOT EXISTS cess_rate_bps       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_minor      bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxable_value_minor bigint,
  ADD COLUMN IF NOT EXISTS cgst_minor          bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_minor          bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_minor          bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cess_minor          bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_reverse_charge   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS uqc                 varchar(10);

-- ⚠️ NO `CHECK (cgst_minor = sgst_minor)`, AND THE OMISSION IS DELIBERATE.
--
-- It is the obvious constraint and it is wrong. An odd tax amount cannot be
-- halved into two equal whole paise: ₹100.01 of tax splits 50.01 / 50.00, and
-- `splitEvenly` produces exactly that so the two halves still add to the tax
-- charged. A constraint demanding equality would refuse a correct invoice and
-- push somebody towards rounding each half separately — which produces
-- 50.01 + 50.01 and a document that does not balance.

DO $$
BEGIN
  -- Widen the Phase 11 balance check to include cess. Existing rows have
  -- cess_minor = 0 and are unaffected; new ones must account for it.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_totals_balance') THEN
    ALTER TABLE invoices DROP CONSTRAINT invoices_totals_balance;
  END IF;

  ALTER TABLE invoices ADD CONSTRAINT invoices_totals_balance
    CHECK (total_minor = subtotal_minor - discount_minor
                       + cgst_minor + sgst_minor + igst_minor
                       + COALESCE(cess_minor, 0));

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'invoices_reverse_charge_non_negative') THEN
    -- ⚠️ `reverse_charge_tax_minor` is deliberately NOT part of the balance
    -- above. Under Section 9(3)/9(4) the RECIPIENT pays that tax directly to
    -- the Government; adding it to the total charges the customer for tax we
    -- do not owe, and they then pay it a second time themselves.
    ALTER TABLE invoices ADD CONSTRAINT invoices_reverse_charge_non_negative
      CHECK (reverse_charge_tax_minor >= 0 AND cess_minor >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'invoices_supplier_state_matches_gstin') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_supplier_state_matches_gstin
      CHECK (supplier_gstin IS NULL
             OR supplier_state_code IS NULL
             OR supplier_state_code = substring(supplier_gstin from 1 for 2));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'invoice_lines_taxable_consistent') THEN
    ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_taxable_consistent
      CHECK (taxable_value_minor IS NULL
             OR taxable_value_minor = amount_minor - discount_minor);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'invoice_lines_gst_non_negative') THEN
    ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_gst_non_negative
      CHECK (cgst_minor >= 0 AND sgst_minor >= 0 AND igst_minor >= 0
             AND cess_minor >= 0 AND discount_minor >= 0
             AND cess_rate_bps >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'invoice_lines_gst_mutually_exclusive') THEN
    -- IGST and the CGST/SGST pair cannot both be charged on one line. Both
    -- populated is a double charge that the header check would not catch,
    -- because the header would still balance against its own inflated total.
    ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_gst_mutually_exclusive
      CHECK (NOT (igst_minor > 0 AND (cgst_minor > 0 OR sgst_minor > 0)));
  END IF;
END
$$;


-- ############################################################################
-- SECTION 2 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER too, which
-- is the half everybody forgets: without it the role that created the table
-- reads everything and the policies look like they are working.
--
-- ⚠️ NO `app_is_platform_scope()` ON ANY POLICY HERE. A tenant's GSTIN
-- registry is the map of where a company is registered and who it trades with;
-- its rate masters are what it charges. Platform staff have no business
-- reading either, and the narrowing of that marker away from customer content
-- was itself a defect fixed in v0.14.1.

ALTER TABLE gst_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_registrations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gst_registrations_tenant_isolation ON gst_registrations;
CREATE POLICY gst_registrations_tenant_isolation ON gst_registrations
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE gst_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_parties FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gst_parties_tenant_isolation ON gst_parties;
CREATE POLICY gst_parties_tenant_isolation ON gst_parties
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE hsn_sac_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hsn_sac_codes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hsn_sac_codes_tenant_isolation ON hsn_sac_codes;
CREATE POLICY hsn_sac_codes_tenant_isolation ON hsn_sac_codes
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE hsn_sac_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hsn_sac_rates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hsn_sac_rates_tenant_isolation ON hsn_sac_rates;
CREATE POLICY hsn_sac_rates_tenant_isolation ON hsn_sac_rates
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 3 — ⭐ COMPOSITE FOREIGN KEYS
-- ############################################################################
--
-- ⚠️ FOREIGN-KEY CHECKS RUN AS THE SYSTEM AND IGNORE ROW-LEVEL SECURITY. That
-- is documented PostgreSQL behaviour and it is why every pointer in this phase
-- is a COMPOSITE key on (col, tenant_id).
--
-- The shape of the hole, concretely for this phase:
--
--     Tenant A inserts an invoice line with
--         tenant_id   = A                         ← passes WITH CHECK
--         gst_rate_id = <a rate row owned by B>   ← passes a single-column FK
--
--     A's invoice is now priced from B's rate master. Nothing errors, nothing
--     logs, and the rate on the document is one this workspace never entered —
--     so when somebody asks "why is this 12%?", the answer is not in their
--     data at all.
--
-- The same applies to the party pointers: a `gst_parties` row aimed at another
-- tenant's lead is a cross-tenant existence oracle, and one tenant's lead
-- deletion would cascade into another tenant's tax registry.

CREATE UNIQUE INDEX IF NOT EXISTS gst_registrations_id_tenant_key
  ON gst_registrations (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS hsn_sac_codes_id_tenant_key
  ON hsn_sac_codes (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS hsn_sac_rates_id_tenant_key
  ON hsn_sac_rates (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS gst_parties_id_tenant_key
  ON gst_parties (id, tenant_id);

-- Parents that live in earlier phases. Created here too, idempotently, so this
-- file does not depend on the order the SQL directory is applied in.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_key            ON users (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS leads_id_tenant_key            ON leads (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_partners_id_tenant_key ON channel_partners (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS companies_id_tenant_key        ON companies (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_id_tenant_key         ON invoices (id, tenant_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hsn_sac_rates_code_same_tenant') THEN
    ALTER TABLE hsn_sac_rates
      ADD CONSTRAINT hsn_sac_rates_code_same_tenant
      FOREIGN KEY (hsn_sac_id, tenant_id)
      REFERENCES hsn_sac_codes (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gst_registrations_created_by_same_tenant') THEN
    ALTER TABLE gst_registrations
      ADD CONSTRAINT gst_registrations_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gst_parties_lead_same_tenant') THEN
    ALTER TABLE gst_parties
      ADD CONSTRAINT gst_parties_lead_same_tenant
      FOREIGN KEY (lead_id, tenant_id)
      REFERENCES leads (id, tenant_id)
      -- SET NULL, not CASCADE: the tax identity of a buyer outlives the lead
      -- record it was first captured against, and an invoice already refers to
      -- it. Losing the party row would orphan the invoice's counterparty.
      ON DELETE SET NULL (lead_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gst_parties_partner_same_tenant') THEN
    ALTER TABLE gst_parties
      ADD CONSTRAINT gst_parties_partner_same_tenant
      FOREIGN KEY (channel_partner_id, tenant_id)
      REFERENCES channel_partners (id, tenant_id)
      ON DELETE SET NULL (channel_partner_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gst_parties_company_same_tenant') THEN
    ALTER TABLE gst_parties
      ADD CONSTRAINT gst_parties_company_same_tenant
      FOREIGN KEY (company_id, tenant_id)
      REFERENCES companies (id, tenant_id)
      ON DELETE SET NULL (company_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_supplier_registration_same_tenant') THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_supplier_registration_same_tenant
      FOREIGN KEY (supplier_registration_id, tenant_id)
      REFERENCES gst_registrations (id, tenant_id)
      -- ⚠️ RESTRICT. A registration that has issued invoices is surrendered by
      -- closing it (`effective_to`), never by deleting it: the document must
      -- still render the GSTIN it was issued under, years later.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_lines_gst_rate_same_tenant') THEN
    ALTER TABLE invoice_lines
      ADD CONSTRAINT invoice_lines_gst_rate_same_tenant
      FOREIGN KEY (gst_rate_id, tenant_id)
      REFERENCES hsn_sac_rates (id, tenant_id)
      -- ⭐ RESTRICT, AND THIS IS ONE OF THE FOUR DEFENCES OF THE PHASE'S
      -- CENTRAL RULE. A rate row an invoice has been priced from cannot be
      -- deleted. Tidying the master must never be able to remove the evidence
      -- of what a historical document was charged at.
      ON DELETE RESTRICT;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 4 — ⭐ NO TWO RATES MAY COVER ONE DAY
-- ############################################################################
--
-- If two rate periods for one code overlap, then on any day in the overlap
-- "what is the rate?" has two answers and the resolver picks by sort order.
-- The invoice raised that day carries one of them, arbitrarily, and NOTHING ON
-- THE DOCUMENT SHOWS WHICH — the buyer's copy and our copy would agree, and
-- both would be indefensible.
--
-- ⚠️ THE RANGE IS HALF-OPEN: '[)'. `effective_from` is inclusive and
-- `effective_to` is exclusive, matching `lib/gst/rates.ts`. With '[]' the
-- changeover day would belong to both periods and the constraint would refuse
-- a correct history — the 12% period ending 2019-04-01 and the 5% period
-- starting 2019-04-01 is exactly how a notification works.
--
-- `'infinity'` stands in for an open-ended period. A NULL upper bound in a
-- daterange is also unbounded, but being explicit here keeps the intent
-- readable next to the CHECK constraints that treat NULL as "still current".

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hsn_sac_rates_no_overlap') THEN
    ALTER TABLE hsn_sac_rates
      ADD CONSTRAINT hsn_sac_rates_no_overlap
      EXCLUDE USING gist (
        tenant_id  WITH =,
        hsn_sac_id WITH =,
        daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&
      );
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — ⭐ A RATE AN INVOICE HAS USED IS FROZEN
-- ############################################################################
--
-- THE MOST IMPORTANT TRIGGER IN THE PHASE.
--
-- Section 3's RESTRICT stops a used rate row being DELETED. This stops the
-- subtler and far more likely thing: it being EDITED.
--
--     Somebody notices the residential rate is 12% and "corrects" it to 5%.
--     Every invoice raised under that row now says 5%. The PDFs already sent
--     say 12%. The returns already filed say 12%. Nothing errors.
--
-- Two edits are refused once any invoice line points at the row:
--
--   a) CHANGING THE RATE OR THE CESS. There is no legitimate version of this.
--      A rate that was entered wrongly is corrected by closing the period and
--      opening a new one, and by crediting and reissuing the documents that
--      went out at the wrong figure — which is what the law requires anyway.
--
--   b) PULLING THE WINDOW OFF A DOCUMENT'S DATE. Moving `effective_from`
--      forward past an invoice, or `effective_to` back before one, leaves that
--      invoice pointing at a period that does not contain its own date. The
--      document and the master then disagree and neither is obviously wrong.
--
-- ⚠️ CLOSING A PERIOD FORWARD IS STILL ALLOWED, because that is how every rate
-- change is recorded. A guard that froze the row completely would make the
-- next notification unrecordable, and somebody would edit the rate in place
-- instead — the exact outcome this trigger exists to prevent.
--
-- ⚠️ SECURITY INVOKER, deliberately. The lookup of dependent invoices runs
-- under RLS, so a rate row in another tenant reports no dependants — which is
-- correct, because a cross-tenant dependency cannot exist (Section 3) and
-- making this DEFINER to "see everything" would hand the caller a
-- cross-tenant read through the error message.

CREATE OR REPLACE FUNCTION enforce_gst_rate_history_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_used        integer;
  v_earliest    date;
  v_latest      date;
BEGIN
  SELECT count(*),
         min(COALESCE(i.tax_point_date, i.issued_at::date, i.created_at::date)),
         max(COALESCE(i.tax_point_date, i.issued_at::date, i.created_at::date))
    INTO v_used, v_earliest, v_latest
    FROM invoice_lines l
    JOIN invoices i ON i.id = l.invoice_id
   WHERE l.gst_rate_id = OLD.id;

  IF v_used = 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.rate_bps            IS DISTINCT FROM OLD.rate_bps
     OR NEW.cess_rate_bps       IS DISTINCT FROM OLD.cess_rate_bps
     OR NEW.cess_per_unit_minor IS DISTINCT FROM OLD.cess_per_unit_minor
     OR NEW.hsn_sac_id          IS DISTINCT FROM OLD.hsn_sac_id THEN
    RAISE EXCEPTION
      'This rate has already been used on % invoice line(s) and cannot be changed. '
      'A historical invoice keeps the rate that applied on its date — editing this '
      'row would silently restate every document raised under it, including ones '
      'already filed in a return. Close this period and open a new one instead, '
      'then credit and reissue anything that went out at the wrong figure.',
      v_used
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.effective_from > v_earliest THEN
    RAISE EXCEPTION
      'An invoice dated % is already priced from this rate, so the period cannot '
      'start on %. Moving the window off a document leaves it pointing at a rate '
      'period that does not cover its own date.',
      v_earliest, NEW.effective_from
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.effective_to IS NOT NULL AND v_latest >= NEW.effective_to THEN
    RAISE EXCEPTION
      'An invoice dated % is already priced from this rate, so the period cannot '
      'end on %. Close it no earlier than the day after the last document that '
      'used it.',
      v_latest, NEW.effective_to
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hsn_sac_rates_history_immutable ON hsn_sac_rates;
CREATE TRIGGER hsn_sac_rates_history_immutable
  BEFORE UPDATE ON hsn_sac_rates
  FOR EACH ROW EXECUTE FUNCTION enforce_gst_rate_history_immutable();


-- The delete path is already refused by the RESTRICT foreign key. This exists
-- to give a HUMAN AT A psql PROMPT a sentence rather than a constraint name —
-- that person is usually tidying a master at speed, and
-- `violates foreign key constraint "invoice_lines_gst_rate_same_tenant"` does
-- not tell them what to do instead.
CREATE OR REPLACE FUNCTION block_used_gst_rate_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_used integer;
BEGIN
  SELECT count(*) INTO v_used FROM invoice_lines WHERE gst_rate_id = OLD.id;

  IF v_used > 0 THEN
    RAISE EXCEPTION
      'This rate period is used by % invoice line(s) and cannot be deleted. It is '
      'the evidence of what those documents were charged at. Close the period '
      'with an end date instead — that is how a superseded rate is retired.',
      v_used
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS hsn_sac_rates_no_delete_when_used ON hsn_sac_rates;
CREATE TRIGGER hsn_sac_rates_no_delete_when_used
  BEFORE DELETE ON hsn_sac_rates
  FOR EACH ROW EXECUTE FUNCTION block_used_gst_rate_delete();


-- ############################################################################
-- SECTION 6 — ⭐ THE INVOICE MUST ADD UP
-- ############################################################################
--
-- `invoices_totals_balance` (Section 1c) proves the HEADER is internally
-- consistent. It says nothing about whether the header agrees with the LINES,
-- and that is where the drift happens: the header is written by one statement
-- and the lines by another, and an interrupted or partially-updated document
-- balances perfectly while charging tax no line accounts for.
--
-- ⚠️ A CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, AND IT HAS TO BE.
-- A BEFORE INSERT trigger on `invoices` fires before any line exists and would
-- refuse every invoice ever created. Deferring to COMMIT is the only point at
-- which the header and its lines are both present and both final.
--
-- ⚠️ IT ONLY FIRES ON `gst_computed` DOCUMENTS. The Phase 16 subscription
-- generator writes header taxes and leaves the line tax columns at zero; every
-- one of those would fail this check. A document only opts in by declaring
-- that the Phase 32 engine produced it — and having declared it, it must add
-- up.

CREATE OR REPLACE FUNCTION enforce_gst_invoice_reconciles()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice   invoices%ROWTYPE;
  v_taxable   bigint;
  v_cgst      bigint;
  v_sgst      bigint;
  v_igst      bigint;
  v_cess      bigint;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    v_invoice := NEW;
  ELSE
    SELECT * INTO v_invoice FROM invoices WHERE id = NEW.invoice_id;
    -- The invoice may have been deleted later in the same transaction, or may
    -- sit in another tenant and therefore be invisible under RLS. Either way
    -- there is nothing here to reconcile, and the composite key already
    -- refuses the cross-tenant case.
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;

  IF NOT COALESCE(v_invoice.gst_computed, false) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(COALESCE(l.taxable_value_minor, l.amount_minor - l.discount_minor)), 0),
         COALESCE(sum(l.cgst_minor) FILTER (WHERE NOT l.is_reverse_charge), 0),
         COALESCE(sum(l.sgst_minor) FILTER (WHERE NOT l.is_reverse_charge), 0),
         COALESCE(sum(l.igst_minor) FILTER (WHERE NOT l.is_reverse_charge), 0),
         COALESCE(sum(l.cess_minor) FILTER (WHERE NOT l.is_reverse_charge), 0)
    INTO v_taxable, v_cgst, v_sgst, v_igst, v_cess
    FROM invoice_lines l
   WHERE l.invoice_id = v_invoice.id;

  IF v_taxable <> (v_invoice.subtotal_minor - v_invoice.discount_minor) THEN
    RAISE EXCEPTION
      'Invoice % does not add up: the lines total % paise of taxable value and '
      'the invoice says %. A document whose foot disagrees with its own column '
      'cannot be issued.',
      v_invoice.invoice_number, v_taxable,
      v_invoice.subtotal_minor - v_invoice.discount_minor
      USING ERRCODE = '23514';
  END IF;

  IF v_cgst <> v_invoice.cgst_minor
     OR v_sgst <> v_invoice.sgst_minor
     OR v_igst <> v_invoice.igst_minor
     OR v_cess <> COALESCE(v_invoice.cess_minor, 0) THEN
    RAISE EXCEPTION
      'Invoice % does not add up: the lines carry CGST %, SGST %, IGST %, cess %, '
      'and the invoice says CGST %, SGST %, IGST %, cess %. Somebody adding the '
      'tax column would get a different answer from the total.',
      v_invoice.invoice_number, v_cgst, v_sgst, v_igst, v_cess,
      v_invoice.cgst_minor, v_invoice.sgst_minor, v_invoice.igst_minor,
      COALESCE(v_invoice.cess_minor, 0)
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS invoices_gst_reconciles ON invoices;
CREATE CONSTRAINT TRIGGER invoices_gst_reconciles
  AFTER INSERT OR UPDATE ON invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_gst_invoice_reconciles();

DROP TRIGGER IF EXISTS invoice_lines_gst_reconciles ON invoice_lines;
CREATE CONSTRAINT TRIGGER invoice_lines_gst_reconciles
  AFTER INSERT OR UPDATE ON invoice_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_gst_invoice_reconciles();


-- ############################################################################
-- SECTION 7 — THE GSTIN CHECKSUM, IN THE DATABASE
-- ############################################################################
--
-- The regex in Section 1 checks the SHAPE. It accepts `27AAACR5055K1ZX` — the
-- right length, the right character classes, a real state code, and a
-- fifteenth character that is simply wrong.
--
-- ⚠️ A GSTIN IS TYPED OFF A CERTIFICATE, AN EMAIL SIGNATURE OR A PHOTOGRAPH.
-- Fifteen characters, no separators, containing both O and 0 and both I and 1.
-- A mistyped one passes every screen in the product and is rejected at GSTR-1
-- upload weeks later, by which time the customer has paid against a document
-- that now has to be cancelled and reissued — and their input credit for that
-- month is gone until it is.
--
-- `lib/billing/money.ts` already validates the mod-36 checksum in TypeScript.
-- This is the same algorithm in the database, for the reason every guarantee
-- in this codebase ends up there: the server action is one of several write
-- paths, and an import script, a support fix at a psql prompt and a future API
-- route are the others.
--
-- ⚠️ IMMUTABLE, so it can be used in a CHECK constraint. It genuinely is: it
-- reads no tables, no settings and no clock.

CREATE OR REPLACE FUNCTION gstin_check_character(p_gstin text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  alphabet  constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  v_sum     integer := 0;
  v_value   integer;
  v_product integer;
  i         integer;
BEGIN
  IF p_gstin IS NULL OR length(p_gstin) < 14 THEN
    RETURN NULL;
  END IF;

  FOR i IN 1..14 LOOP
    -- position() is 1-based and returns 0 when absent, so subtract 1 to get
    -- the alphabet index. A character outside the alphabet makes the whole
    -- GSTIN unverifiable rather than accidentally valid.
    v_value := position(substring(upper(p_gstin) from i for 1) in alphabet) - 1;
    IF v_value < 0 THEN RETURN NULL; END IF;

    -- Weights alternate 1,2,1,2… over 1-based positions: odd positions get 1.
    v_product := v_value * (CASE WHEN i % 2 = 1 THEN 1 ELSE 2 END);
    v_sum := v_sum + (v_product / 36) + (v_product % 36);
  END LOOP;

  RETURN substring(alphabet from ((36 - (v_sum % 36)) % 36) + 1 for 1);
END;
$$;

CREATE OR REPLACE FUNCTION is_valid_gstin(p_gstin text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_gstin IS NOT NULL
     AND upper(p_gstin) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
     AND gstin_check_character(p_gstin) = substring(upper(p_gstin) from 15 for 1);
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gst_registrations_gstin_checksum') THEN
    ALTER TABLE gst_registrations
      ADD CONSTRAINT gst_registrations_gstin_checksum CHECK (is_valid_gstin(gstin));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gst_parties_gstin_checksum') THEN
    ALTER TABLE gst_parties
      ADD CONSTRAINT gst_parties_gstin_checksum
      CHECK (gstin IS NULL OR is_valid_gstin(gstin));
  END IF;

  -- ⚠️ NOT added to `invoices.customer_gstin`. There are rows in that column
  -- already, written before this function existed, and a CHECK is validated
  -- against every existing row when it is added. Failing the migration on
  -- historical data would be the wrong trade: the registry is where a GSTIN
  -- is entered from now on, and it is checked there.
END
$$;


-- ############################################################################
-- SECTION 8 — ⭐ IMMOVABLE PROPERTY: THE PLACE OF SUPPLY IS THE PROPERTY
-- ############################################################################
--
-- Section 12(3) of the IGST Act. For anything directly in relation to
-- immovable property — the sale of an under-construction flat, a works
-- contract, a lease, an architect's fee — the place of supply is THE LOCATION
-- OF THE PROPERTY. Not the buyer's address. Not the buyer's GSTIN state. Not
-- where the agreement was signed.
--
-- This is the rule a real-estate company relies on for almost every rupee it
-- bills, and it is the rule every generic billing engine gets wrong, because
-- every generic billing engine derives place of supply from the customer
-- record. An NRI in Dubai buying a flat in Pune from a Maharashtra-registered
-- developer is an INTRA-state supply: CGST + SGST, place of supply 27.
--
-- ⚠️ WHY A CONSTRAINT AND NOT JUST THE ENGINE. `lib/gst/place-of-supply.ts`
-- gets this right, and it is one of four write paths. An import of historical
-- bookings, a support correction at a psql prompt and a future API route are
-- the others, and every one of them would reach for the customer's state
-- because that is what the column next to it is called.
--
-- The cost of getting it wrong is not a wrong total — the total is right to
-- the paisa. It is that the tax sits in a state we never supplied, the buyer
-- cannot claim it, and recovering it is an application under Section 77.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_immovable_property_pos') THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_immovable_property_pos
      CHECK (
        supply_type <> 'immovable_property'
        OR (property_state_code IS NOT NULL
            AND place_of_supply_code IS NOT NULL
            AND place_of_supply_code = property_state_code)
      );
  END IF;
END
$$;


-- ############################################################################
-- SECTION 9 — updated_at, AND THE CHANGE LOG
-- ############################################################################

DROP TRIGGER IF EXISTS gst_registrations_set_updated_at ON gst_registrations;
CREATE TRIGGER gst_registrations_set_updated_at BEFORE UPDATE ON gst_registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS gst_parties_set_updated_at ON gst_parties;
CREATE TRIGGER gst_parties_set_updated_at BEFORE UPDATE ON gst_parties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS hsn_sac_codes_set_updated_at ON hsn_sac_codes;
CREATE TRIGGER hsn_sac_codes_set_updated_at BEFORE UPDATE ON hsn_sac_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS hsn_sac_rates_set_updated_at ON hsn_sac_rates;
CREATE TRIGGER hsn_sac_rates_set_updated_at BEFORE UPDATE ON hsn_sac_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ⚠️ ATTACHED HERE RATHER THAN LEFT TO 0017, which discovers tenant-scoped
-- tables only when it is re-run — and a deployment applying files in numerical
-- order runs it BEFORE these exist. The coverage test in
-- `tests/security/change-log.test.ts` discovers the omission rather than
-- trusting a list, so a missing trigger here fails that suite, not this file.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_change') THEN
    FOREACH t IN ARRAY ARRAY['gst_registrations','gst_parties',
                             'hsn_sac_codes','hsn_sac_rates']
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
-- ⚠️ NO DELETE ON `hsn_sac_rates`, AND THAT IS THE POINT OF THE PHASE.
--
-- A rate period is the evidence of what a historical document was charged at.
-- It is retired by closing it with an end date, never by deleting it — and a
-- tax engine with a DELETE grant on its own rate history is a tax engine whose
-- first step can be "remove the record of what we charged".
--
-- `gst_registrations` is the same argument: a surrendered registration is
-- closed, because invoices issued under it must still render its GSTIN.
--
-- `gst_parties` and `hsn_sac_codes` DO get DELETE, narrowly: a party typed in
-- by mistake before it has been used, and a classification added to the master
-- in error, are ordinary data-entry corrections. The rows that matter are
-- protected by the RESTRICT foreign keys, which refuse the delete the moment
-- anything points at them.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON gst_registrations FROM ordence_app;
    REVOKE ALL ON gst_parties       FROM ordence_app;
    REVOKE ALL ON hsn_sac_codes     FROM ordence_app;
    REVOKE ALL ON hsn_sac_rates     FROM ordence_app;

    GRANT SELECT, INSERT, UPDATE         ON gst_registrations TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON gst_parties       TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON hsn_sac_codes     TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON hsn_sac_rates     TO ordence_app;

    GRANT EXECUTE ON FUNCTION gstin_check_character(text) TO ordence_app;
    GRANT EXECUTE ON FUNCTION is_valid_gstin(text)        TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 11 — VERIFICATION
-- ############################################################################
--
-- Every check names what breaks if it fails, because "FAIL" on its own tells
-- you nothing about whether to panic.

-- Check 1 — RLS is ENABLED **and FORCED** on all four new tables.
-- ⚠️ `relforcerowsecurity` is the column that matters. A table with ENABLE but
-- not FORCE looks protected in every UI and is not protected against its owner.
SELECT
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS (enabled + forced)'
       WHEN c.relrowsecurity
       THEN '*** FAIL — enabled but NOT FORCED: the owner bypasses it ***'
       ELSE '*** FAIL — ROW LEVEL SECURITY IS OFF: every tenant can read and '
            'edit every other tenant''s GSTINs and rate masters ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('gst_registrations','gst_parties','hsn_sac_codes','hsn_sac_rates')
ORDER BY c.relname;


-- Check 2 — every policy has BOTH a read and a write clause.
SELECT
  tablename, policyname,
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS (read + write)'
       WHEN with_check IS NULL
       THEN '*** FAIL — no WITH CHECK: a tenant can plant a rate in another '
            'tenant''s master ***'
       ELSE '*** FAIL — no USING clause ***'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('gst_registrations','gst_parties','hsn_sac_codes','hsn_sac_rates')
ORDER BY tablename;


-- Check 3 — ⭐ the composite foreign keys exist (Section 3).
-- A missing one means a row can point at another tenant's record — and for
-- `invoice_lines_gst_rate_same_tenant` specifically, that an invoice can be
-- priced from a rate master this workspace has never seen.
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: a row can point at another tenant''s record ***'
  END AS verdict
FROM (VALUES
  ('hsn_sac_rates_code_same_tenant'),
  ('gst_registrations_created_by_same_tenant'),
  ('gst_parties_lead_same_tenant'),
  ('gst_parties_partner_same_tenant'),
  ('gst_parties_company_same_tenant'),
  ('invoices_supplier_registration_same_tenant'),
  ('invoice_lines_gst_rate_same_tenant')
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
  ('hsn_sac_rates_history_immutable',   'hsn_sac_rates'),
  ('hsn_sac_rates_no_delete_when_used', 'hsn_sac_rates'),
  ('invoices_gst_reconciles',           'invoices'),
  ('invoice_lines_gst_reconciles',      'invoice_lines')
) AS expected(tgname, tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tgname
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tgname;


-- Check 5 — ⭐ THE OVERLAP CONSTRAINT ACTUALLY REFUSES, proved not inspected.
--
-- A constraint that exists and does not bite passes Check 6. This one builds a
-- real rate history in a temporary tenant and tries to overlap it. It also
-- proves the half-open boundary: a period ENDING on the day the next one
-- BEGINS must be accepted, because that is how every notification works.
DO $$
DECLARE
  v_tenant   uuid := gen_random_uuid();
  v_code     uuid := gen_random_uuid();
  v_adjacent boolean := false;
  v_refused  boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_gstv_' || v_tenant, 'gstv-' || left(v_tenant::text, 8),
            'GST verification', 'active');
  INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
    VALUES (v_code, v_tenant, '995411', 'sac', 'Construction of residential buildings');

  INSERT INTO hsn_sac_rates (tenant_id, hsn_sac_id, rate_bps, effective_from, effective_to)
    VALUES (v_tenant, v_code, 1200, DATE '2017-07-01', DATE '2019-04-01');

  -- Adjacent, not overlapping. MUST be accepted.
  BEGIN
    INSERT INTO hsn_sac_rates (tenant_id, hsn_sac_id, rate_bps, effective_from)
      VALUES (v_tenant, v_code, 500, DATE '2019-04-01');
    v_adjacent := true;
  EXCEPTION WHEN OTHERS THEN
    v_adjacent := false;
  END;

  -- Overlapping. MUST be refused.
  BEGIN
    INSERT INTO hsn_sac_rates (tenant_id, hsn_sac_id, rate_bps, effective_from, effective_to)
      VALUES (v_tenant, v_code, 1800, DATE '2018-01-01', DATE '2018-06-01');
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;

  IF v_adjacent AND v_refused THEN
    RAISE NOTICE 'PASS: rate periods may touch but may never overlap.';
  ELSIF NOT v_adjacent THEN
    RAISE WARNING '*** FAIL — an ADJACENT rate period was refused. Every rate '
                  'change in the country ends one period on the day the next '
                  'begins; the boundary must be half-open. ***';
  ELSE
    RAISE WARNING '*** FAIL — TWO RATES MAY COVER ONE DAY. "What rate applied?" '
                  'now has two answers and the invoice raised that day carries '
                  'whichever the sort order picked. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 6 — the exclusion constraint is present.
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hsn_sac_rates_no_overlap')
       THEN 'PASS: no two rate periods can cover one day'
       ELSE '*** FAIL: hsn_sac_rates_no_overlap IS MISSING — two rates valid on '
            'one date means the rate on an invoice is decided by a sort order ***'
  END AS check_no_overlapping_rates;


-- Check 7 — ⭐ the GSTIN checksum function agrees with the TypeScript one.
-- The two known-good values are the ones asserted in tests/ui/billing-money.test.tsx;
-- if these diverge, a GSTIN accepted by the form is refused by the database
-- (or, far worse, the reverse).
SELECT
  sample.gstin,
  CASE WHEN is_valid_gstin(sample.gstin) = sample.expected THEN 'PASS'
       ELSE '*** FAIL — the database and the application disagree about whether '
            'this GSTIN is valid ***'
  END AS verdict
FROM (VALUES
  ('27AAACR5055K1Z7', true),   -- valid: shape, state and checksum all correct
  ('29AAACR5055K1Z3', true),   -- the same PAN registered in another state
  ('29AAACR5055K1ZX', false),  -- ⭐ correct shape, WRONG check character
  ('99AAACR5055K1Z5', false),  -- state 99 does not exist
  ('29AAACR5055K1Z',  false)   -- 14 characters
) AS sample(gstin, expected);


-- Check 8 — ⭐ the immovable-property constraint refuses the mistake.
-- Proved, not inspected: a constraint whose expression is subtly inverted
-- passes every "does it exist" check.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_ok      boolean := false;
  v_refused boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_pos_' || v_tenant, 'pos-' || left(v_tenant::text, 8),
            'POS verification', 'active');

  -- Flat in Maharashtra, buyer registered in Karnataka. Place of supply MUST
  -- be 27 (the property), and 27 must be accepted.
  BEGIN
    INSERT INTO invoices (tenant_id, invoice_number, subtotal_minor, discount_minor,
                          cgst_minor, sgst_minor, igst_minor, total_minor,
                          supply_type, property_state_code, place_of_supply_code,
                          customer_gstin)
      VALUES (v_tenant, 'VFY/POS/1', 10000000, 0, 250000, 250000, 0, 10500000,
              'immovable_property', '27', '27', '29AAACR5055K1Z3');
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;

  -- The same document taxed at the BUYER's state. MUST be refused.
  BEGIN
    INSERT INTO invoices (tenant_id, invoice_number, subtotal_minor, discount_minor,
                          cgst_minor, sgst_minor, igst_minor, total_minor,
                          supply_type, property_state_code, place_of_supply_code,
                          customer_gstin)
      VALUES (v_tenant, 'VFY/POS/2', 10000000, 0, 0, 0, 500000, 10500000,
              'immovable_property', '27', '29', '29AAACR5055K1Z3');
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;

  IF v_ok AND v_refused THEN
    RAISE NOTICE 'PASS: for immovable property the place of supply must be the '
                 'property''s state, not the buyer''s.';
  ELSIF NOT v_ok THEN
    RAISE WARNING '*** FAIL — a CORRECT immovable-property invoice was refused. '
                  'The constraint is inverted and no flat can be invoiced. ***';
  ELSE
    RAISE WARNING '*** FAIL — an invoice for a flat was taxed in the BUYER''S '
                  'state. The tax lands in a state we never supplied, the buyer '
                  'cannot claim it, and recovering it is a Section 77 claim. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 9 — ⭐ a used rate cannot be edited or deleted.
DO $$
DECLARE
  v_tenant   uuid := gen_random_uuid();
  v_code     uuid := gen_random_uuid();
  v_rate     uuid := gen_random_uuid();
  v_invoice  uuid := gen_random_uuid();
  v_edit_ref boolean := false;
  v_del_ref  boolean := false;
  v_close_ok boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_rate_' || v_tenant, 'rate-' || left(v_tenant::text, 8),
            'Rate verification', 'active');
  INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
    VALUES (v_code, v_tenant, '995411', 'sac', 'Construction of residential buildings');
  INSERT INTO hsn_sac_rates (id, tenant_id, hsn_sac_id, rate_bps, effective_from)
    VALUES (v_rate, v_tenant, v_code, 1200, DATE '2017-07-01');

  INSERT INTO invoices (id, tenant_id, invoice_number, subtotal_minor, discount_minor,
                        cgst_minor, sgst_minor, igst_minor, total_minor, tax_point_date)
    VALUES (v_invoice, v_tenant, 'VFY/RATE/1', 10000000, 0, 600000, 600000, 0,
            11200000, DATE '2018-05-10');
  INSERT INTO invoice_lines (invoice_id, tenant_id, description, quantity,
                             unit_amount_minor, amount_minor, tax_rate_bps, gst_rate_id,
                             taxable_value_minor, cgst_minor, sgst_minor)
    VALUES (v_invoice, v_tenant, 'Construction', 1, 10000000, 10000000, 1200, v_rate,
            10000000, 600000, 600000);

  BEGIN
    UPDATE hsn_sac_rates SET rate_bps = 500 WHERE id = v_rate;
  EXCEPTION WHEN OTHERS THEN
    v_edit_ref := true;
  END;

  BEGIN
    DELETE FROM hsn_sac_rates WHERE id = v_rate;
  EXCEPTION WHEN OTHERS THEN
    v_del_ref := true;
  END;

  -- Closing the period FORWARD is how every notification is recorded and must
  -- still work. A guard that froze the row entirely would make the next rate
  -- change unrecordable and push somebody into editing in place.
  BEGIN
    UPDATE hsn_sac_rates SET effective_to = DATE '2019-04-01' WHERE id = v_rate;
    v_close_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_close_ok := false;
  END;

  IF v_edit_ref AND v_del_ref AND v_close_ok THEN
    RAISE NOTICE 'PASS: a used rate is frozen but can still be superseded.';
  ELSIF NOT v_edit_ref THEN
    RAISE WARNING '*** FAIL — A USED RATE WAS EDITED. Every invoice raised under '
                  'it has silently restated itself and no longer matches the '
                  'return filed against it. ***';
  ELSIF NOT v_del_ref THEN
    RAISE WARNING '*** FAIL — a used rate was DELETED. The evidence of what a '
                  'historical document was charged at is gone. ***';
  ELSE
    RAISE WARNING '*** FAIL — a used rate could not be SUPERSEDED. The next rate '
                  'notification cannot be recorded, so somebody will edit the '
                  'rate in place instead. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 10 — the app role cannot DELETE a rate period or a registration.
SELECT
  t.table_name, t.privilege_type,
  '*** FAIL — DELETE granted: the record of what a historical document was '
  'charged at can be erased ***' AS verdict
FROM information_schema.role_table_grants t
WHERE t.grantee = 'ordence_app'
  AND t.privilege_type = 'DELETE'
  AND t.table_name IN ('hsn_sac_rates','gst_registrations');
-- (No rows returned = PASS.)


-- Check 11 — nothing points across a tenant boundary TODAY.
SELECT 'rates → codes' AS relationship, count(*) AS violations,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END AS verdict
  FROM hsn_sac_rates r JOIN hsn_sac_codes c ON c.id = r.hsn_sac_id
 WHERE r.tenant_id <> c.tenant_id
UNION ALL
SELECT 'invoice lines → rates', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM invoice_lines l JOIN hsn_sac_rates r ON r.id = l.gst_rate_id
 WHERE l.tenant_id <> r.tenant_id
UNION ALL
SELECT 'invoices → registrations', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM invoices i JOIN gst_registrations g ON g.id = i.supplier_registration_id
 WHERE i.tenant_id <> g.tenant_id
UNION ALL
SELECT 'parties → leads', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM gst_parties p JOIN leads l ON l.id = p.lead_id
 WHERE p.tenant_id <> l.tenant_id;


-- Check 12 — no rate history currently overlaps.
-- Belt and braces: if the EXCLUDE constraint were added after data existed,
-- overlaps could predate it.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every code has at most one rate on any given day'
       ELSE '*** FAIL — ' || count(*) || ' pair(s) of rate periods overlap. The '
            'rate on an invoice raised in the overlap is arbitrary. ***'
  END AS check_no_overlaps_today
FROM hsn_sac_rates a
JOIN hsn_sac_rates b
  ON b.hsn_sac_id = a.hsn_sac_id AND b.tenant_id = a.tenant_id AND b.id > a.id
 AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[)')
  && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[)');


-- Check 13 — every GST-computed invoice adds up against its own lines.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every GST invoice''s foot agrees with its column'
       ELSE '*** FAIL — ' || count(*) || ' invoice(s) do not add up. Somebody '
            'adding the tax column gets a different answer from the total. ***'
  END AS check_invoices_reconcile
FROM invoices i
WHERE i.gst_computed
  AND (
    i.cgst_minor <> COALESCE((SELECT sum(l.cgst_minor) FROM invoice_lines l
                               WHERE l.invoice_id = i.id AND NOT l.is_reverse_charge), 0)
 OR i.sgst_minor <> COALESCE((SELECT sum(l.sgst_minor) FROM invoice_lines l
                               WHERE l.invoice_id = i.id AND NOT l.is_reverse_charge), 0)
 OR i.igst_minor <> COALESCE((SELECT sum(l.igst_minor) FROM invoice_lines l
                               WHERE l.invoice_id = i.id AND NOT l.is_reverse_charge), 0)
  );


-- Check 14 — the change log covers this phase.
SELECT
  expected.tbl,
  CASE WHEN t.tgname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — changes here are not recorded and could never sync ***'
  END AS verdict
FROM (VALUES
  ('gst_registrations'), ('gst_parties'), ('hsn_sac_codes'), ('hsn_sac_rates')
) AS expected(tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tbl || '_change_log'
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tbl;


-- Check 15 — a registration cannot be primary twice.
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_indexes
                     WHERE tablename = 'gst_registrations'
                       AND indexname = 'gst_registrations_one_primary')
       THEN 'PASS: one default GSTIN per workspace'
       ELSE '*** FAIL: gst_registrations_one_primary IS MISSING — which GSTIN we '
            'issue from would be decided by a sort order ***'
  END AS check_one_primary_registration;
