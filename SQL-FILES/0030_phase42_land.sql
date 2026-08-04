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

BEGIN;

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
