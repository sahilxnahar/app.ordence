-- =====================================================================
--  🔴🔴🔴 DRILL — DO NOT RUN THIS IN NEON 🔴🔴🔴
-- =====================================================================
--
--  It creates types, tables and rows, and deliberately provokes CHECK
--  violations. Throwaway Postgres only.
--
--     createdb drill0080
--     psql -d drill0080 -f DRILL-DO-NOT-RUN-IN-NEON-0080.sql
--
--  ⭐ EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL WORK. A
--  drill that only shows refusals cannot tell "correctly constrained"
--  from "broken", and the whole risk of 0080 is that it tightens onto an
--  order somebody still needs to raise.
--
--  ⚠️ THIS DRILL DOES NOT NEED A NON-SUPERUSER. Unlike 0079 it tests
--  CHECK constraints, which bind every role including the owner. RLS
--  bypass is irrelevant here, so there is no role guard and its absence
--  is deliberate rather than forgotten.
-- =====================================================================


-- =====================================================================
--  STEP 0 — REFUSE TO RUN SOMEWHERE THAT MATTERS
-- =====================================================================
DO $$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production')
  THEN
    RAISE EXCEPTION
      '🔴 REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;
END
$$;


-- =====================================================================
--  STEP 1 — THE SHAPE, REPRODUCED FROM THE MIGRATION
-- =====================================================================

DROP TABLE IF EXISTS sales_orders CASCADE;
DROP TYPE  IF EXISTS gst_supply_type CASCADE;
DROP TYPE  IF EXISTS gst_registration_type CASCADE;

CREATE TYPE gst_supply_type AS ENUM ('goods', 'services', 'immovable_property');
CREATE TYPE gst_registration_type AS ENUM
  ('regular', 'composition', 'unregistered', 'sez', 'overseas');

CREATE TABLE sales_orders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no               text NOT NULL,
  place_of_supply_code   varchar(2),
  is_inter_state         boolean,
  supply_type            gst_supply_type NOT NULL DEFAULT 'services',
  property_state_code    varchar(2),
  recipient_registration gst_registration_type,
  place_of_supply_basis  varchar(40),
  place_of_supply_ref    varchar(60),
  is_union_territory     boolean NOT NULL DEFAULT false
);

ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_immovable_property_pos
  CHECK (
    supply_type <> 'immovable_property'
    OR (property_state_code IS NOT NULL
        AND place_of_supply_code IS NOT NULL
        AND place_of_supply_code = property_state_code)
  );

ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_sez_is_inter_state
  CHECK (recipient_registration IS DISTINCT FROM 'sez' OR is_inter_state = true);

ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_ut_is_intra_state
  CHECK (is_union_territory = false OR is_inter_state IS NOT TRUE);

ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_pos_has_basis
  CHECK (place_of_supply_code IS NULL OR place_of_supply_basis IS NOT NULL);


-- =====================================================================
--  ASSERTIONS
-- =====================================================================

\set ON_ERROR_STOP off

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 1 — the ordinary case. A registered buyer in another
--     state, services, inter-state. This is 90% of orders and it must
--     stay effortless.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders
  (order_no, place_of_supply_code, is_inter_state, supply_type,
   recipient_registration, place_of_supply_basis, place_of_supply_ref)
VALUES
  ('SO-1', '29', true, 'services', 'regular',
   'recipient_registration', 'Section 12(2)(a), IGST Act');
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 2 — a works contract on a site in OUR state, sold to a
--     buyer registered elsewhere. s.12(3): the SITE decides, so this is
--     INTRA-state despite the buyer being in Karnataka.
--
--     🔴 THIS IS THE CASE THE OLD CODE GOT WRONG EVERY TIME. It compared
--     the buyer's state to ours, found them different, and charged IGST
--     on a supply that owes CGST + SGST.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders
  (order_no, place_of_supply_code, is_inter_state, supply_type,
   property_state_code, recipient_registration,
   place_of_supply_basis, place_of_supply_ref)
VALUES
  ('SO-2', '27', false, 'immovable_property', '27', 'regular',
   'immovable_property_location', 'Section 12(3)(a), IGST Act');
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 1 — the same works contract, taxed from the BUYER.
--     Place of supply 29 while the property is in 27.
--     ⚠️ THE MOST EXPENSIVE SINGLE ROW IN THIS PRODUCT.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders
  (order_no, place_of_supply_code, is_inter_state, supply_type,
   property_state_code, recipient_registration, place_of_supply_basis)
VALUES
  ('SO-3', '29', true, 'immovable_property', '27', 'regular',
   'recipient_registration');
-- EXPECT: ERROR 23514 sales_orders_immovable_property_pos

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 2 — an immovable-property order with no site at all.
--     The old code accepted this silently and answered from the buyer.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders
  (order_no, place_of_supply_code, is_inter_state, supply_type,
   place_of_supply_basis)
VALUES
  ('SO-4', '27', false, 'immovable_property', 'recipient_address');
-- EXPECT: ERROR 23514 sales_orders_immovable_property_pos

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 3 — an SEZ buyer, correctly recorded as inter-state even
--     though the SEZ is in our own state (place of supply 27 = ours).
-- ---------------------------------------------------------------------
INSERT INTO sales_orders
  (order_no, place_of_supply_code, is_inter_state, supply_type,
   recipient_registration, place_of_supply_basis, place_of_supply_ref)
VALUES
  ('SO-5', '27', true, 'services', 'sez',
   'sez_deemed_interstate', 'Section 7(5)(b), IGST Act');
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 3 — the SEZ mistake. Codes match, so "intra-state".
--     s.7(5)(b) says otherwise, and the shortfall accrues interest.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders
  (order_no, place_of_supply_code, is_inter_state, supply_type,
   recipient_registration, place_of_supply_basis)
VALUES
  ('SO-6', '27', false, 'services', 'sez', 'recipient_registration');
-- EXPECT: ERROR 23514 sales_orders_sez_is_inter_state

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 4 — an intra-UT supply, CGST + UTGST, correctly marked.
--     35 is Andaman and Nicobar.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders
  (order_no, place_of_supply_code, is_inter_state, supply_type,
   recipient_registration, is_union_territory,
   place_of_supply_basis, place_of_supply_ref)
VALUES
  ('SO-7', '35', false, 'services', 'regular', true,
   'recipient_registration', 'Section 12(2)(a), IGST Act');
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 4 — IGST and UTGST on one document. Impossible.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders
  (order_no, place_of_supply_code, is_inter_state, supply_type,
   is_union_territory, place_of_supply_basis)
VALUES
  ('SO-8', '35', true, 'services', true, 'recipient_registration');
-- EXPECT: ERROR 23514 sales_orders_ut_is_intra_state

-- ---------------------------------------------------------------------
--  🔴 REFUSAL 5 — a place of supply with no rule behind it. This is the
--     shape every guessing write path produces.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders (order_no, place_of_supply_code, is_inter_state)
VALUES ('SO-9', '29', true);
-- EXPECT: ERROR 23514 sales_orders_pos_has_basis

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 5 — a draft with NO place of supply yet is still allowed.
--     ⚠️ THIS ONE MATTERS. An operator who has not yet chosen the buyer
--     must be able to save a draft. Requiring the determination at
--     insert would make the constraint a usability failure, and the
--     first workaround would be a default.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders (order_no) VALUES ('SO-10');
-- EXPECT: INSERT 0 1

-- ---------------------------------------------------------------------
--  ⭐ POSITIVE 6 — overseas buyer, export, place of supply 96.
-- ---------------------------------------------------------------------
INSERT INTO sales_orders
  (order_no, place_of_supply_code, is_inter_state, supply_type,
   recipient_registration, place_of_supply_basis, place_of_supply_ref)
VALUES
  ('SO-11', '96', true, 'services', 'overseas',
   'outside_india', 'Section 2(6) read with Section 16, IGST Act');
-- EXPECT: INSERT 0 1

\set ON_ERROR_STOP on

-- =====================================================================
--  SUMMARY OF WHAT MUST HAVE HAPPENED
-- =====================================================================
SELECT count(*) AS should_be_six FROM sales_orders;
--    6 positives inserted (SO-1, 2, 5, 7, 10, 11)
--    5 refusals raised 23514 (SO-3, 4, 6, 8, 9)
--
--  ⚠️ IF A REFUSAL SUCCEEDED, STOP. The most likely cause is that the
--  constraint was not created, which means 0080 did not run to
--  completion.
-- =====================================================================
