-- =====================================================================
--  ORDENCE 0059 — COURT FEES, DISBURSEMENTS AND RULE 33
--  v1.8.0-alpha · Legal, batch 2
-- =====================================================================
--
--  🔴🔴 THE ONE CONSTRAINT THIS MIGRATION EXISTS FOR
--
--     matter_disbursements_pure_agent_is_at_actual
--
--  A firm pays a ₹50,000 court fee for a client and recovers ₹50,500.
--  Under Rule 33 of the CGST Rules the ₹500 does not cost ₹90 of GST.
--  It costs ₹9,090 — because Explanation (d) requires a pure agent to
--  receive "only the actual amount incurred", and once that fails the
--  WHOLE ₹50,500 falls into the value of supply.
--
--  ⚠️ This is not a warning. A warning on this gets clicked through by
--  somebody rounding a bill at 7pm. The database refuses the row.
--
--  ⭐ AND ORDENCE SHIPS NO COURT FEE RATES. Court fees are a State
--  subject — the 1870 Act, the Bombay Court Fees Act 1959, and a dozen
--  other State Acts, each with its own Schedule and its own maximum,
--  amended on State budget cycles nobody publishes to software vendors.
--  A stale slab is worse than an empty table: a firm that types the fee
--  off the registry wall is right, and a firm that trusts an eighteen-
--  month-old Maharashtra table while filing in Bengaluru has its plaint
--  returned for deficit court fee — which loses the filing date, which
--  can lose the limitation.
--
--  So: the STRUCTURE is here. The RATES are the tenant's.
--
--  Depends on: 0058 (legal_matters), 0049 (sales_invoices), companies.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① THE VALUATION THE FEE IS COMPUTED ON
-- =====================================================================
--  🔴 AND IT IS NOT THE CLAIM AMOUNT.
--
--  The fee is charged on the value of the suit "for the purposes of
--  court fees and jurisdiction" — a statutory valuation under the Suits
--  Valuation Act and the State's Court Fees Act. For a money suit that
--  is usually the sum claimed. For a declaration, an injunction, a
--  partition, specific performance or possession it very often is not,
--  and the gap between the two is the entire subject of the preliminary
--  objection the other side will take.
--
--  ⚠️ Which is why this is its own column and not an alias.

ALTER TABLE legal_matters
    ADD COLUMN IF NOT EXISTS suit_valuation_minor bigint;

ALTER TABLE legal_matters
    ADD COLUMN IF NOT EXISTS valuation_basis text;

DO $$ BEGIN
    ALTER TABLE legal_matters
        ADD CONSTRAINT legal_matters_valuation_non_negative
        CHECK (suit_valuation_minor IS NULL OR suit_valuation_minor >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =====================================================================
--  ② THE SCHEDULE — SHAPE ONLY, NO RATES
-- =====================================================================

CREATE TABLE IF NOT EXISTS court_fee_schedules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    /** "Karnataka Court Fees and Suits Valuation Act 1958, Schedule I, Art 1". */
    name                varchar(200) NOT NULL,
    statute_ref         varchar(300) NOT NULL,
    /** Two-digit GST State code, so the schedule can be picked by court. */
    state_code          varchar(2),
    /** "district", "high_court", "tribunal", "consumer" — the tenant's words. */
    court_tier          varchar(40),

    basis               varchar(20) NOT NULL DEFAULT 'ad_valorem',

    fixed_minor         bigint,
    /** 🔴 Most State Acts cap the fee, and the cap bites on large suits. */
    maximum_minor       bigint,
    minimum_minor       bigint,
    /** Some Acts round the fee up to the next ₹10. 1000 = ₹10. */
    round_up_to_minor   bigint,

    effective_from      date,
    effective_to        date,
    is_active           boolean NOT NULL DEFAULT true,
    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT court_fee_schedules_basis_known CHECK (
        basis IN ('fixed', 'ad_valorem', 'manual')
    ),
    -- ⚠️ A fixed schedule with no amount computes nothing and says nothing.
    CONSTRAINT court_fee_schedules_fixed_has_amount CHECK (
        basis <> 'fixed' OR fixed_minor IS NOT NULL
    ),
    CONSTRAINT court_fee_schedules_amounts_non_negative CHECK (
        (fixed_minor IS NULL OR fixed_minor >= 0)
        AND (maximum_minor IS NULL OR maximum_minor >= 0)
        AND (minimum_minor IS NULL OR minimum_minor >= 0)
        AND (round_up_to_minor IS NULL OR round_up_to_minor > 0)
    ),
    -- ⚠️ A maximum below the minimum is a schedule that cannot produce a fee.
    CONSTRAINT court_fee_schedules_max_above_min CHECK (
        maximum_minor IS NULL OR minimum_minor IS NULL OR maximum_minor >= minimum_minor
    ),
    CONSTRAINT court_fee_schedules_dates_ordered CHECK (
        effective_from IS NULL OR effective_to IS NULL OR effective_to > effective_from
    )
);

CREATE INDEX IF NOT EXISTS court_fee_schedules_pick_idx
    ON court_fee_schedules (tenant_id, state_code, court_tier)
    WHERE is_active;


CREATE TABLE IF NOT EXISTS court_fee_slabs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    schedule_id         uuid NOT NULL REFERENCES court_fee_schedules(id) ON DELETE CASCADE,

    /** ⭐ Half-open: from inclusive, upto exclusive, last band NULL. */
    from_minor          bigint NOT NULL,
    upto_minor          bigint,
    rate_bps            integer NOT NULL DEFAULT 0,
    /** A flat sum added for this band, where the Act expresses it that way. */
    add_minor           bigint NOT NULL DEFAULT 0,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT court_fee_slabs_from_non_negative CHECK (from_minor >= 0),
    CONSTRAINT court_fee_slabs_band_is_real CHECK (
        upto_minor IS NULL OR upto_minor > from_minor
    ),
    CONSTRAINT court_fee_slabs_rate_sane CHECK (rate_bps BETWEEN 0 AND 10000),
    CONSTRAINT court_fee_slabs_add_non_negative CHECK (add_minor >= 0)
);

CREATE INDEX IF NOT EXISTS court_fee_slabs_schedule_idx
    ON court_fee_slabs (tenant_id, schedule_id, from_minor);


--  🔴 A GAP IN A SCHEDULE DOES NOT THROW — IT UNDER-CHARGES, SILENTLY.
--
--  ⚠️ Bands of 0–1,00,000 and 2,00,000–upwards look perfectly fine on a
--  screen and compute the fee on a ₹1,50,000 suit as though the middle
--  lakh did not exist. The plaint is returned for deficit court fee and
--  the filing date goes with it.
--
--  ⭐ DEFERRABLE INITIALLY DEFERRED, exactly like ordence_validate_rate_slabs
--  in 0057 — the bands of one schedule are inserted as a set, and a
--  row-by-row check would reject the first one every time.
CREATE OR REPLACE FUNCTION ordence_validate_court_fee_slabs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  sched      RECORD;
  r          RECORD;
  prev_upto  bigint;
  n_open     integer;
  n_bands    integer;
  sched_id   uuid;
BEGIN
  sched_id := COALESCE(NEW.schedule_id, OLD.schedule_id);

  SELECT * INTO sched FROM court_fee_schedules WHERE id = sched_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- ⚠️ Only ad valorem schedules have bands to validate.
  IF sched.basis <> 'ad_valorem' THEN
    IF EXISTS (SELECT 1 FROM court_fee_slabs WHERE schedule_id = sched_id) THEN
      RAISE EXCEPTION
        'Schedule "%" is marked % but has bands. A fixed or manual schedule computes nothing from bands, so bands on it are a schedule somebody half-changed.',
        sched.name, sched.basis
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NULL;
  END IF;

  SELECT count(*) INTO n_bands FROM court_fee_slabs WHERE schedule_id = sched_id;
  IF n_bands = 0 THEN
    RAISE EXCEPTION
      'Schedule "%" is ad valorem but has no bands. It would compute a court fee of zero on every suit.',
      sched.name
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO n_open
    FROM court_fee_slabs WHERE schedule_id = sched_id AND upto_minor IS NULL;

  IF n_open <> 1 THEN
    RAISE EXCEPTION
      'Schedule "%" has % open-ended bands. Exactly one is needed — the top one — or a suit valued above the highest band is charged nothing on the excess. If the Act caps the fee, leave the top band open and set the maximum instead.',
      sched.name, n_open
      USING ERRCODE = 'raise_exception';
  END IF;

  prev_upto := NULL;
  FOR r IN
    SELECT from_minor, upto_minor
      FROM court_fee_slabs
     WHERE schedule_id = sched_id
     ORDER BY from_minor
  LOOP
    IF prev_upto IS NULL THEN
      IF r.from_minor <> 0 THEN
        RAISE EXCEPTION
          'Schedule "%" starts at % instead of zero, so any suit valued below that computes no court fee at all.',
          sched.name, r.from_minor
          USING ERRCODE = 'raise_exception';
      END IF;
    ELSIF r.from_minor > prev_upto THEN
      RAISE EXCEPTION
        'Schedule "%" has a gap: one band ends at % and the next starts at %. A suit valued in between would be charged nothing on that slice, and the plaint comes back for deficit court fee.',
        sched.name, prev_upto, r.from_minor
        USING ERRCODE = 'raise_exception';
    ELSIF r.from_minor < prev_upto THEN
      RAISE EXCEPTION
        'Schedule "%" has an overlap: one band ends at % and the next starts at %. The same rupee would be charged twice.',
        sched.name, prev_upto, r.from_minor
        USING ERRCODE = 'raise_exception';
    END IF;

    -- ⚠️ The open band must be last; ORDER BY from_minor puts NULL upto
    -- wherever its from_minor falls, so an early open band shows up as a
    -- NULL prev_upto on the next iteration.
    IF r.upto_minor IS NULL THEN
      prev_upto := NULL;
    ELSE
      IF prev_upto IS NULL AND r.from_minor <> 0 THEN
        RAISE EXCEPTION
          'Schedule "%" has an open-ended band that is not the top one. Everything above it is unreachable.',
          sched.name
          USING ERRCODE = 'raise_exception';
      END IF;
      prev_upto := r.upto_minor;
    END IF;
  END LOOP;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_validate_court_fee_slabs ON court_fee_slabs;
CREATE CONSTRAINT TRIGGER trg_validate_court_fee_slabs
  AFTER INSERT OR UPDATE OR DELETE ON court_fee_slabs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ordence_validate_court_fee_slabs();


-- =====================================================================
--  ③ WHAT WAS PAID OUT ON THE CLIENT'S BEHALF
-- =====================================================================

CREATE TABLE IF NOT EXISTS matter_disbursements (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    matter_id           uuid NOT NULL REFERENCES legal_matters(id) ON DELETE RESTRICT,
    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,

    disbursement_date   date NOT NULL,
    kind                varchar(30) NOT NULL,
    description         text NOT NULL,
    /** Receipt or challan number from the registry. */
    reference_no        varchar(120),
    paid_to             varchar(255),

    /** 🔴 What went out. */
    paid_amount_minor   bigint NOT NULL,
    /** 🔴 What is being charged to the client. */
    recovered_amount_minor bigint NOT NULL,

    /**
     * 🔴 THE FLAG THE WHOLE TABLE TURNS ON.
     * True → excluded from the value of supply under Rule 33.
     */
    is_pure_agent       boolean NOT NULL DEFAULT true,
    /** Rule 33(i) and Explanation (a). */
    client_authorised   boolean NOT NULL DEFAULT false,

    /** Where the money came from, if it came out of client funds. */
    client_account_entry_id uuid REFERENCES client_account_entries(id) ON DELETE SET NULL,
    /** The fee note it was recovered on. NULL until billed. */
    invoice_id          uuid REFERENCES sales_invoices(id) ON DELETE RESTRICT,

    /** For a court fee that may come back — see ④. */
    court_fee_schedule_id uuid REFERENCES court_fee_schedules(id) ON DELETE SET NULL,

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT matter_disbursements_kind_known CHECK (
        kind IN ('court_fee', 'process_fee', 'stamp_duty', 'welfare_stamp',
                 'copying_charges', 'expert_fee', 'filing_fee', 'travel',
                 'courier', 'other')
    ),
    CONSTRAINT matter_disbursements_amounts_positive CHECK (
        paid_amount_minor > 0 AND recovered_amount_minor >= 0
    ),

    -- =================================================================
    -- 🔴🔴 THE CONSTRAINT.
    --
    -- Explanation (d) to Rule 33: the pure agent "receives only the
    -- actual amount incurred". Not approximately. Not rounded up to the
    -- nearest hundred. Exactly.
    --
    -- ⚠️ Recover one paisa more and the exclusion is lost — and not just
    -- on the paisa. On the WHOLE recovery. A ₹500 handling charge on a
    -- ₹50,000 court fee creates ₹9,090 of GST liability, not ₹90.
    --
    -- ⭐ If the firm wants to charge for the work of going to the
    -- registry, that is a FEE. Bill it as one, on its own line, and let
    -- it bear tax. The disbursement stays at actual.
    -- =================================================================
    CONSTRAINT matter_disbursements_pure_agent_is_at_actual CHECK (
        NOT is_pure_agent OR recovered_amount_minor = paid_amount_minor
    ),

    -- 🔴 Rule 33(i) — payment to the third party is made "on
    -- authorisation by such recipient". No authorisation, no pure agent.
    CONSTRAINT matter_disbursements_pure_agent_is_authorised CHECK (
        NOT is_pure_agent OR client_authorised
    ),

    -- ⚠️ Travel and courier are the firm's own costs. The client was
    -- never liable to the airline. Recovering them is part of the fee
    -- and bears tax — calling them a pure agent recovery is the second
    -- most common Rule 33 error after the markup.
    CONSTRAINT matter_disbursements_own_costs_are_not_pure_agent CHECK (
        NOT is_pure_agent OR kind NOT IN ('travel', 'courier')
    )
);

CREATE INDEX IF NOT EXISTS matter_disbursements_matter_idx
    ON matter_disbursements (tenant_id, matter_id, disbursement_date);
-- ⭐ THE QUERY THE TABLE EXISTS FOR: what has been paid out and not billed.
CREATE INDEX IF NOT EXISTS matter_disbursements_unbilled_idx
    ON matter_disbursements (tenant_id, company_id, disbursement_date)
    WHERE invoice_id IS NULL;


-- =====================================================================
--  ④ GETTING THE COURT FEE BACK
-- =====================================================================
--  ⭐ The Supreme Court held on 20 December 2024, in Sanjeevkumar
--  Harakchand Kankariya v. Union of India (2024 INSC 1004), that a Lok
--  Adalat award and a mediated settlement are NOT the same thing. A Lok
--  Adalat award carries a full statutory refund under s.21 of the Legal
--  Services Authorities Act 1987. A mediation settlement gets whatever
--  the State's own Court Fees Act gives it — in Maharashtra, after the
--  2018 amendment, a full refund; elsewhere, possibly nothing.
--
--  ⚠️ So the ROUTE is recorded, because the route decides the answer,
--  and no rate or entitlement is stored — only what was claimed and what
--  came back.

CREATE TABLE IF NOT EXISTS court_fee_refund_claims (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    matter_id           uuid NOT NULL REFERENCES legal_matters(id) ON DELETE RESTRICT,
    disbursement_id     uuid REFERENCES matter_disbursements(id) ON DELETE SET NULL,

    /** 🔴 How the case ended. This, not the amount, decides entitlement. */
    settlement_route    varchar(40) NOT NULL,
    settled_on          date NOT NULL,
    /** The Act relied on — the tenant's words, because it is their State's. */
    statute_ref         varchar(300),

    claimed_minor       bigint NOT NULL,
    claim_filed_on      date,
    received_minor      bigint NOT NULL DEFAULT 0,
    received_on         date,
    /** Paid back to the client, where the client funded the fee. */
    passed_to_client_on date,

    status              varchar(20) NOT NULL DEFAULT 'identified',
    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT court_fee_refund_claims_route_known CHECK (
        settlement_route IN ('lok_adalat', 'court_referred_mediation',
                             'court_referred_arbitration', 'private_settlement',
                             'withdrawal')
    ),
    CONSTRAINT court_fee_refund_claims_status_known CHECK (
        status IN ('identified', 'filed', 'received', 'rejected', 'abandoned')
    ),
    CONSTRAINT court_fee_refund_claims_amounts_non_negative CHECK (
        claimed_minor >= 0 AND received_minor >= 0
    ),
    -- ⚠️ A refund cannot exceed what was claimed.
    CONSTRAINT court_fee_refund_claims_not_over_recovered CHECK (
        received_minor <= claimed_minor
    ),
    -- 🔴 A claim that is "filed" has to say when. A refund that is
    -- "received" has to say when and how much. Otherwise the report of
    -- outstanding refunds is a list of things somebody feels good about.
    CONSTRAINT court_fee_refund_claims_filed_is_dated CHECK (
        status NOT IN ('filed', 'received') OR claim_filed_on IS NOT NULL
    ),
    CONSTRAINT court_fee_refund_claims_received_is_real CHECK (
        status <> 'received' OR (received_on IS NOT NULL AND received_minor > 0)
    )
);

CREATE INDEX IF NOT EXISTS court_fee_refund_claims_open_idx
    ON court_fee_refund_claims (tenant_id, status, settled_on)
    WHERE status IN ('identified', 'filed');


--  🔴 THE TRIGGER: A REFUND CANNOT EXCEED THE FEE THAT WAS PAID.
--
--  ⚠️ And it must not exceed what is left after earlier claims on the
--  same disbursement — a court fee refunded twice is money that came
--  from somewhere else.
CREATE OR REPLACE FUNCTION ordence_guard_court_fee_refund()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  d            RECORD;
  already      bigint;
BEGIN
  IF NEW.disbursement_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO d FROM matter_disbursements WHERE id = NEW.disbursement_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF d.kind <> 'court_fee' THEN
    RAISE EXCEPTION
      'A court fee refund can only be claimed against a court fee. This disbursement is recorded as %.',
      d.kind
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COALESCE(SUM(claimed_minor), 0) INTO already
    FROM court_fee_refund_claims
   WHERE tenant_id = NEW.tenant_id
     AND disbursement_id = NEW.disbursement_id
     AND status <> 'rejected'
     AND status <> 'abandoned'
     AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF already + NEW.claimed_minor > d.paid_amount_minor THEN
    RAISE EXCEPTION
      'This would claim back % against a court fee of % (% already claimed on it). A court fee cannot be refunded twice, and the excess would have to come from somewhere it did not.',
      to_char((already + NEW.claimed_minor)::numeric / 100, 'FM999999999990.00'),
      to_char(d.paid_amount_minor::numeric / 100, 'FM999999999990.00'),
      to_char(already::numeric / 100, 'FM999999999990.00')
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_court_fee_refund ON court_fee_refund_claims;
CREATE TRIGGER trg_guard_court_fee_refund
  BEFORE INSERT OR UPDATE ON court_fee_refund_claims
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_court_fee_refund();


--  ⚠️ AND A DISBURSEMENT ALREADY BILLED CANNOT HAVE ITS RECOVERY MOVED.
--
--  🔴 Changing the recovered amount after the fee note has gone out
--  changes the Rule 33 position on a document already in the client's
--  hands. The invoice says one thing and the ledger says another, and
--  the one the assessment reads is the invoice.
CREATE OR REPLACE FUNCTION ordence_guard_billed_disbursement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.recovered_amount_minor IS DISTINCT FROM OLD.recovered_amount_minor
     OR NEW.paid_amount_minor IS DISTINCT FROM OLD.paid_amount_minor
     OR NEW.is_pure_agent IS DISTINCT FROM OLD.is_pure_agent
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION
      'This disbursement has already been billed on a fee note. Changing what was paid, what is recovered, or whether it was a pure agent recovery would contradict a document the client is holding — and on an assessment the invoice is what counts. Raise a credit note instead.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_billed_disbursement ON matter_disbursements;
CREATE TRIGGER trg_guard_billed_disbursement
  BEFORE UPDATE ON matter_disbursements
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_billed_disbursement();


-- =====================================================================
--  ⑤ HOW THIS FIRM IS TAXED
-- =====================================================================
--  🔴 THE COLUMN THAT FIXES v1.2.0.
--
--  `raiseInvoiceFromTime` has charged 18% forward on every invoice since
--  v1.2.0. For an advocate or a firm of advocates that is wrong in very
--  nearly every case — legal services are either exempt under
--  Notification 12/2017 Sr. No. 45 or on reverse charge under
--  Notification 13/2017 Sr. No. 2, where the CLIENT pays.
--
--  ⚠️ Charging tax that was not chargeable is not a neutral error.
--  s.76 requires every rupee collected as tax to be paid over whether or
--  not it was due, and the client cannot claim credit for it either.

CREATE TABLE IF NOT EXISTS legal_practice_profile (
    tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

    /** individual_advocate | senior_advocate | firm_of_advocates | not_an_advocate */
    supplier_kind       varchar(30) NOT NULL DEFAULT 'firm_of_advocates',
    /** ⚠️ Does the firm make ANY forward-charge supply? One kills the s.23(2) relief. */
    has_forward_charge_supplies boolean NOT NULL DEFAULT false,
    /** The firm's own view on the senior-advocate-to-advocate question. */
    senior_to_advocate_position varchar(20),
    senior_to_advocate_note text,

    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT legal_practice_profile_supplier_known CHECK (
        supplier_kind IN ('individual_advocate', 'senior_advocate',
                          'firm_of_advocates', 'not_an_advocate')
    ),
    CONSTRAINT legal_practice_profile_position_known CHECK (
        senior_to_advocate_position IS NULL
        OR senior_to_advocate_position IN ('reverse_charge', 'exempt')
    ),
    -- ⭐ A view taken on a contested question has to say why. That note is
    -- what the firm shows when it is asked, two years later, why it did
    -- what it did.
    CONSTRAINT legal_practice_profile_position_is_reasoned CHECK (
        senior_to_advocate_position IS NULL OR senior_to_advocate_note IS NOT NULL
    )
);


--  ⭐ What Ordence decided about a client, and when — because the
--  exemption turns on the client's turnover in the PRECEDING financial
--  year, and that answer changes on 1 April.
CREATE TABLE IF NOT EXISTS legal_client_tax_status (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    /** not_a_business | business_entity | government | advocate_or_firm */
    recipient_kind      varchar(30) NOT NULL DEFAULT 'business_entity',
    /** 🔴 The threshold that applies is the one in the CLIENT's State. */
    state_code          varchar(2),
    recipient_outside_india boolean NOT NULL DEFAULT false,

    /** Which FY the turnover below relates to. "2024-25". */
    turnover_fy         varchar(9),
    turnover_minor      bigint,
    /** Tenant override where the State threshold is contested. */
    threshold_override_minor bigint,

    /** Who said so, and when. An answer with no provenance is a guess. */
    confirmed_on        date,
    confirmed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT legal_client_tax_status_kind_known CHECK (
        recipient_kind IN ('not_a_business', 'business_entity',
                           'government', 'advocate_or_firm')
    ),
    CONSTRAINT legal_client_tax_status_amounts_non_negative CHECK (
        (turnover_minor IS NULL OR turnover_minor >= 0)
        AND (threshold_override_minor IS NULL OR threshold_override_minor > 0)
    ),
    -- ⚠️ A turnover with no year attached is not evidence of anything.
    -- The exemption is decided on the PRECEDING financial year, so which
    -- year it is is half the fact.
    CONSTRAINT legal_client_tax_status_turnover_has_year CHECK (
        turnover_minor IS NULL OR turnover_fy IS NOT NULL
    ),
    -- 🔴 A client outside India is not a business entity in the taxable
    -- territory, so reverse charge cannot reach them. Recording both is
    -- a contradiction that would decide a bill.
    CONSTRAINT legal_client_tax_status_overseas_is_not_local CHECK (
        NOT recipient_outside_india OR state_code IS NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_client_tax_status_unique
    ON legal_client_tax_status (tenant_id, company_id);


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⭐ app_platform_scope() belongs in USING and NEVER in WITH CHECK —
--  platform staff may read across tenants for support; nothing writes a
--  row into somebody else's tenant.

ALTER TABLE court_fee_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_fee_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS court_fee_schedules_tenant_isolation ON court_fee_schedules;
CREATE POLICY court_fee_schedules_tenant_isolation ON court_fee_schedules
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE court_fee_slabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_fee_slabs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS court_fee_slabs_tenant_isolation ON court_fee_slabs;
CREATE POLICY court_fee_slabs_tenant_isolation ON court_fee_slabs
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE matter_disbursements ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_disbursements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS matter_disbursements_tenant_isolation ON matter_disbursements;
CREATE POLICY matter_disbursements_tenant_isolation ON matter_disbursements
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE court_fee_refund_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_fee_refund_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS court_fee_refund_claims_tenant_isolation ON court_fee_refund_claims;
CREATE POLICY court_fee_refund_claims_tenant_isolation ON court_fee_refund_claims
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE legal_practice_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_practice_profile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_practice_profile_tenant_isolation ON legal_practice_profile;
CREATE POLICY legal_practice_profile_tenant_isolation ON legal_practice_profile
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE legal_client_tax_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_client_tax_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_client_tax_status_tenant_isolation ON legal_client_tax_status;
CREATE POLICY legal_client_tax_status_tenant_isolation ON legal_client_tax_status
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
