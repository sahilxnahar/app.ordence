-- =====================================================================
--  Ordence · 0080 · The order could not represent the correct answer
--  Version: v1.37.0-alpha  (Mega-wave 1, Batch 33)
-- =====================================================================
--
--  🔴 RUN THIS AFTER PUSHING THE CODE, NOT BEFORE.
--
--  The CHECK constraints below refuse rows the OLD code can produce. In
--  particular `sales_orders_pos_has_basis` refuses any order that stores
--  a place of supply without recording which rule produced it, and every
--  order written before v1.37.0 did exactly that. Existing rows are
--  backfilled in section 2; new rows from an older build would be
--  rejected at INSERT, which would break order creation.
--
--  ⚠️ SAFE TO RUN TWICE. Columns are ADD ... IF NOT EXISTS, constraints
--  are DROP ... IF EXISTS then ADD, all inside one transaction.
--
-- =====================================================================
--  WHAT THIS FIXES, IN ONE PARAGRAPH
-- =====================================================================
--
--  `server/actions/orders.ts` decided CGST+SGST versus IGST by comparing
--  two strings:
--
--      const isInterState = data.placeOfSupplyCode !== sellerStateCode
--
--  Meanwhile `lib/gst/place-of-supply.ts` holds a complete engine that
--  implements s.12(3) immovable property, s.7(5)(b) SEZ, s.10(1)(a)
--  goods movement, s.12(2) services and the UT/UTGST distinction, with a
--  statutory reference for each. Nothing called it.
--
--  🔴 THE ORDER TABLE COULD NOT HOLD THE ENGINE'S ANSWER. It had two
--  columns: `place_of_supply_code` and `is_inter_state`. There was
--  nowhere to record the site of a works contract, nowhere to record
--  that the recipient is an SEZ unit, and nowhere to record that an
--  intra-state supply is intra-UT and therefore CGST + UTGST.
--
--  So this migration is not "wire up an engine". It is "give the table
--  the columns the answer needs", and then the CHECKs make the wrong
--  answer unstorable from ANY write path, not just the one we fixed.
--
-- =====================================================================

BEGIN;

-- =====================================================================
--  SECTION 1 — THE COLUMNS
-- =====================================================================
--
--  ⭐ EVERY COLUMN IS NULLABLE OR DEFAULTED, so the orders already in
--  this table stay valid without a rewrite. `supply_type` defaults to
--  'services', which is what the old code effectively assumed: it never
--  branched on the nature of the supply at all.

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS supply_type gst_supply_type NOT NULL DEFAULT 'services',
  ADD COLUMN IF NOT EXISTS property_state_code varchar(2),
  ADD COLUMN IF NOT EXISTS recipient_registration gst_registration_type,
  ADD COLUMN IF NOT EXISTS place_of_supply_basis varchar(40),
  ADD COLUMN IF NOT EXISTS place_of_supply_ref varchar(60),
  ADD COLUMN IF NOT EXISTS is_union_territory boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sales_orders.property_state_code IS
  'Where the site, flat or plot IS. Under s.12(3) IGST Act this is the '
  'place of supply for anything relating to immovable property, '
  'regardless of the buyer''s registration or address. Enforced by '
  'sales_orders_immovable_property_pos.';

COMMENT ON COLUMN sales_orders.is_union_territory IS
  'True only when the supply is INTRA-state AND the state is a Union '
  'Territory without a legislature. Selects CGST + UTGST, which is a '
  'different Act from SGST and a different box in GSTR-1. The money is '
  'identical, which is why this was invisible for so long.';

COMMENT ON COLUMN sales_orders.place_of_supply_basis IS
  'Which rule produced place_of_supply_code. Values come from '
  'PlaceOfSupplyBasis in lib/gst/place-of-supply.ts. A code stored '
  'without a basis is a code somebody guessed.';

-- ---------------------------------------------------------------------
--  🔴 AND THE COLUMN WITHOUT WHICH SECTION 12(3) CANNOT BE ANSWERED
-- ---------------------------------------------------------------------
--
--  `projects.state` is varchar(120) holding "Maharashtra". The engine
--  needs "27". Those are not convertible without a lookup table and a
--  spelling policy, and a tax decided by fuzzy string match will be
--  wrong for one project in fifty and blamed on somebody's typing.
--
--  ⚠️ NOT BACKFILLED FROM `state`, ON PURPOSE. A project with no code
--  makes the engine REFUSE, naming this field in the remedy. A guess
--  would make it answer, and the answer would be unverifiable. Refusing
--  gets the data fixed. Guessing ships wrong returns quietly for a year.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS state_code varchar(2);

COMMENT ON COLUMN projects.state_code IS
  'Two-digit GST state code for the SITE. Under s.12(3) IGST Act this is '
  'the place of supply for every works contract and every '
  'under-construction unit sold from this project. Deliberately not '
  'derived from the free-text state column.';

-- =====================================================================
--  SECTION 2 — BACKFILL, HONESTLY LABELLED
-- =====================================================================
--
--  ⚠️ WE DO NOT RE-DETERMINE HISTORICAL ORDERS. Place of supply is a
--  legal determination made against the facts on the order date, and we
--  no longer hold those facts as they were. Re-running the engine now
--  against today's addresses would silently restate documents that have
--  already been invoiced, filed and reconciled.
--
--  ⭐ SO THE BACKFILL RECORDS WHAT ACTUALLY HAPPENED: these rows were
--  decided by comparing two state codes. That is the honest basis, it is
--  a distinct value, and it is greppable. A later reconciliation can ask
--  "which orders predate the engine" and get an exact answer instead of
--  an estimate.

UPDATE sales_orders
   SET place_of_supply_basis = 'legacy_state_compare',
       place_of_supply_ref   = 'Pre-v1.37.0, no determination recorded'
 WHERE place_of_supply_code IS NOT NULL
   AND place_of_supply_basis IS NULL;

-- =====================================================================
--  SECTION 3 — THE CONSTRAINTS
-- =====================================================================
--
--  🔴 THIS IS THE PART THAT OUTLIVES THE FIX.
--
--  We corrected one write path. There are three more: an import of
--  historical orders, a support fix at a psql prompt, and the public
--  REST API. Each of them will reach for the customer's state, because
--  the column beside it is called `place_of_supply_code` and the
--  customer's state is the obvious thing to put in it.
--
--  A constraint is what makes the obvious wrong thing impossible rather
--  than merely discouraged.

ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_immovable_property_pos;
ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_immovable_property_pos
  CHECK (
    supply_type <> 'immovable_property'
    OR (property_state_code IS NOT NULL
        AND place_of_supply_code IS NOT NULL
        AND place_of_supply_code = property_state_code)
  );

-- 🔴 s.7(5)(b). An SEZ unit in our own state is STILL inter-state.
--    Matching the codes and concluding intra-state under-collects IGST
--    that is paid later with interest.
ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_sez_is_inter_state;
ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_sez_is_inter_state
  CHECK (
    recipient_registration IS DISTINCT FROM 'sez'
    OR is_inter_state = true
  );

-- ⚠️ UTGST only exists on an intra-state supply. Both flags true at once
--    would mean IGST and UTGST on one document.
ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_ut_is_intra_state;
ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_ut_is_intra_state
  CHECK (is_union_territory = false OR is_inter_state IS NOT TRUE);

-- ⭐ A determination leaves a trace. This is what stops a future write
--    path storing a code it guessed: it would have to invent a basis.
ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_pos_has_basis;
ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_pos_has_basis
  CHECK (place_of_supply_code IS NULL OR place_of_supply_basis IS NOT NULL);

-- =====================================================================
--  SECTION 4 — THE INDEX THE RETURNS WILL WANT
-- =====================================================================
--
--  GSTR-1 is built per registration per place of supply. Without this,
--  a return over a year of orders is a sequential scan.

CREATE INDEX IF NOT EXISTS sales_orders_pos_idx
  ON sales_orders (tenant_id, place_of_supply_code, order_date)
  WHERE deleted_at IS NULL;

COMMIT;

-- =====================================================================
--  ⚠️ WHAT TO CHECK AFTER RUNNING THIS
-- =====================================================================
--
--  VERIFY-0080-neon-safe.sql          read-only, safe against Neon
--  DRILL-DO-NOT-RUN-IN-NEON-0080.sql  paired positives and refusals
--
--  🔴 THE NUMBER THAT MATTERS is section 3 of the VERIFY: how many
--  orders carry `legacy_state_compare`. Every one of them was taxed by
--  string comparison. That is not automatically wrong — for a plain
--  intra-state supply of services to a registered buyer the string
--  compare gives the same answer the engine does — but it is unverified,
--  and the ones to check by hand are any with a works contract line or
--  an SEZ buyer.
-- =====================================================================
