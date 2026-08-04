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

BEGIN;

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
