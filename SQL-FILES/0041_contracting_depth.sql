-- ════════════════════════════════════════════════════════════════════
-- Ordence — 0041: joining the BOQ world to the RA-bill world
-- Version: v0.68.0-alpha
-- Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════
--
-- ⚠️ THE PROBLEM THIS FILE EXISTS TO FIX
--
-- This product has two complete, well-built halves of contracting that
-- have never been introduced to each other.
--
--   THE MEASUREMENT HALF (0038): boqs → boq_items → measurement_books
--     → measurement_entries. Composite FKs throughout, a guard that
--     stops a billed measurement being edited, and v_boq_consumption
--     reporting authorised-vs-measured per line.
--
--   THE PAYMENT HALF (0031): works_contracts → ra_bills → ra_bill_lines,
--     with derived cess/retention/TDS, a compliance gate that blocks
--     payment without PF/ESI/cess documents, and a sequence guard.
--
-- Between them:
--
--     boqs.contract_ref  varchar(120)      -- free text
--     ra_bill_lines.boq_code varchar(60)   -- free text
--
-- Two strings. Nothing joins, nothing cascades, nothing can be checked.
-- `getCostControl()` bridges them at query time on project_id + vendor_id
-- and says so in its own comments, because that is the only join
-- available.
--
-- ⚠️ WHY THAT IS EXPENSIVE RATHER THAN UNTIDY
--
-- The single most common way money is lost in Indian contracting is
-- OVER-BILLING against a BOQ line: a subcontractor bills 1,100 m³ of
-- concrete against a line authorised for 1,000, across four RA bills
-- none of which looks wrong on its own. It is caught, when it is caught,
-- by somebody adding up the cumulative column by hand at final bill.
--
-- The check needs one thing: knowing which BOQ line a bill line is
-- against. A `varchar` code that may be mistyped, reused across two
-- BOQs, or left blank cannot support it. So this file gives the link a
-- real column and a real constraint, and then adds the check.
--
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- §1  THE LINK: A BOQ BELONGS TO A WORKS CONTRACT
-- ════════════════════════════════════════════════════════════════════
--
-- ⚠️ NULLABLE, AND IT STAYS NULLABLE. A BOQ is routinely priced and
-- issued for tender BEFORE any contract exists — that is the normal
-- order of events, not an edge case. Making this NOT NULL would force
-- an invented contract row for every estimate.

ALTER TABLE boqs ADD COLUMN IF NOT EXISTS contract_id uuid;

-- Backfill from the free-text reference, but ONLY where it is
-- unambiguous. A `contract_ref` matching two contracts, or none, is left
-- null for a human — guessing here would attach a bill to the wrong
-- contract, which is worse than leaving the link absent.
UPDATE boqs b
   SET contract_id = wc.id
  FROM works_contracts wc
 WHERE b.contract_id IS NULL
   AND b.contract_ref IS NOT NULL
   AND wc.tenant_id = b.tenant_id
   AND upper(trim(wc.contract_no)) = upper(trim(b.contract_ref))
   AND NOT EXISTS (
     SELECT 1 FROM works_contracts w2
      WHERE w2.tenant_id = b.tenant_id
        AND upper(trim(w2.contract_no)) = upper(trim(b.contract_ref))
        AND w2.id <> wc.id
   );

-- ⚠️ COMPOSITE `(id, tenant_id)`, LIKE EVERY OTHER FK IN THIS SCHEMA.
-- A plain `REFERENCES works_contracts(id)` would permit a BOQ in tenant
-- A to point at a contract in tenant B. The database would accept it,
-- RLS would hide the parent, and the child would render with a blank
-- contract that nobody can explain. The composite form makes the
-- cross-tenant row unrepresentable rather than merely invisible.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'boqs_contract_tenant_fk'
  ) THEN
    ALTER TABLE boqs
      ADD CONSTRAINT boqs_contract_tenant_fk
      FOREIGN KEY (contract_id, tenant_id)
      REFERENCES works_contracts (id, tenant_id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS boqs_contract_idx ON boqs (tenant_id, contract_id);

-- ════════════════════════════════════════════════════════════════════
-- §2  THE LINK: A BILL LINE IS AGAINST A BOQ LINE
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE ra_bill_lines ADD COLUMN IF NOT EXISTS boq_item_id uuid;

-- ⚠️ THIS INDEX MUST EXIST BEFORE THE FOREIGN KEY BELOW, NOT AFTER IT.
-- A composite `REFERENCES boq_items (id, tenant_id)` needs a unique
-- constraint on exactly those two columns to point at; without one
-- PostgreSQL refuses with "there is no unique constraint matching given
-- keys". 0038 creates it, so on an existing database the order does not
-- show — it shows on a fresh one, which is every CI run and every new
-- environment. Written second, discovered by running it.
CREATE UNIQUE INDEX IF NOT EXISTS boq_items_id_tenant_unique
  ON boq_items (id, tenant_id);

-- ⚠️ ON DELETE SET NULL, NOT CASCADE. Deleting a BOQ line must never
-- delete a line of an issued bill. The bill is a financial record of
-- what was claimed; the BOQ is an estimate that gets revised. Cascading
-- from the estimate to the record would erase history to tidy a plan.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ra_bill_lines_boq_item_tenant_fk'
  ) THEN
    ALTER TABLE ra_bill_lines
      ADD CONSTRAINT ra_bill_lines_boq_item_tenant_fk
      FOREIGN KEY (boq_item_id, tenant_id)
      REFERENCES boq_items (id, tenant_id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ra_bill_lines_boq_item_idx
  ON ra_bill_lines (tenant_id, boq_item_id);

-- ════════════════════════════════════════════════════════════════════
-- §3  ⭐ A BILL CANNOT CLAIM MORE THAN THE BOQ AUTHORISES
-- ════════════════════════════════════════════════════════════════════
--
-- This is what §1 and §2 were for.
--
--   AUTHORISED = original quantity + approved variations
--   CLAIMED    = the sum of every bill line against that BOQ item,
--                across every bill that is not rejected or cancelled
--
-- ⚠️ QUANTITIES ARE SCALED BY 1,000,000 IN boq_items AND UNSCALED IN
-- ra_bill_lines. `boq_items.quantity_scaled` is micro-units — an
-- integer count of millionths — because a BOQ quantity of 1/3 m³ has no
-- exact decimal form and a float would drift across four bills.
-- `ra_bill_lines.quantity` is numeric(18,3).
--
-- Comparing them without converting is the single most likely bug in
-- this file, and it fails in the safe-looking direction: every claim
-- looks a million times too small, the check never fires, and the guard
-- silently does nothing forever. The conversion is done ONCE, here,
-- named, so it cannot be re-derived differently somewhere else.
--
-- ⚠️ A TOLERANCE IS APPLIED, DELIBERATELY. Site measurement is not
-- exact, and a final bill that lands 0.5% over on a line is an ordinary
-- rounding of levels and lengths, not an overclaim. Refusing it would
-- make the guard something people route around. 50 bps — half a
-- percent — is the tolerance, and it is applied to the AUTHORISED
-- quantity, not the claim.

CREATE OR REPLACE FUNCTION ordence_guard_ra_bill_line_authorised()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  authorised_micro  numeric;
  claimed_qty       numeric(18,3);
  authorised_qty    numeric(18,3);
  ceiling_qty       numeric(18,3);
  item              RECORD;
  bill_no_text      text;
BEGIN
  -- A line with no BOQ link cannot be checked. That is not a failure:
  -- day-work, provisional sums and materials-at-site are all legitimate
  -- bill lines with no BOQ item behind them.
  IF NEW.boq_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT bi.id,
         bi.item_code,
         bi.description,
         bi.uom,
         bi.quantity_scaled,
         bi.varied_quantity_scaled
    INTO item
    FROM boq_items bi
   WHERE bi.id = NEW.boq_item_id
     AND bi.tenant_id = NEW.tenant_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;   -- the FK will refuse it; nothing useful to add here
  END IF;

  authorised_micro := COALESCE(item.quantity_scaled, 0)
                    + COALESCE(item.varied_quantity_scaled, 0);

  -- ⚠️ THE ONE CONVERSION. Micro-units → real quantity.
  authorised_qty := ROUND(authorised_micro / 1000000.0, 3);

  -- Everything already claimed against this line, plus this row.
  --
  -- ⚠️ `status NOT IN ('rejected','cancelled')` — a rejected bill has
  -- consumed nothing and must not block the corrected one that replaces
  -- it. Counting it would make every rejection permanently reduce what
  -- the contractor can ever bill.
  SELECT COALESCE(SUM(l.quantity), 0) INTO claimed_qty
    FROM ra_bill_lines l
    JOIN ra_bills b ON b.id = l.ra_bill_id AND b.tenant_id = l.tenant_id
   WHERE l.tenant_id   = NEW.tenant_id
     AND l.boq_item_id = NEW.boq_item_id
     AND b.status NOT IN ('rejected', 'cancelled')
     AND (TG_OP = 'INSERT' OR l.id <> NEW.id);

  claimed_qty := claimed_qty + NEW.quantity;

  -- Half a percent of tolerance on the authorised figure.
  ceiling_qty := ROUND(authorised_qty * 1.005, 3);

  IF claimed_qty <= ceiling_qty THEN
    RETURN NEW;
  END IF;

  SELECT b.bill_no INTO bill_no_text
    FROM ra_bills b
   WHERE b.id = NEW.ra_bill_id AND b.tenant_id = NEW.tenant_id;

  RAISE EXCEPTION
    'Bill % claims a cumulative % % of "%" (item %), but the BOQ authorises only % including approved variations. Billing beyond the BOQ is how a contract quietly overruns: each bill looks reasonable on its own and the overclaim is only found by adding four of them up by hand at final bill. Either raise a variation for the extra quantity, or reduce this line.',
    COALESCE(bill_no_text, 'this bill'),
    claimed_qty,
    -- ⚠️ `::text` BEFORE THE COALESCE, AND IT IS NOT COSMETIC.
    --
    -- `boq_items.uom` is the `uom_code` ENUM. `COALESCE(uom, 'units')`
    -- makes PostgreSQL resolve the whole expression to `uom_code`, so
    -- it tries to cast the fallback string to that enum — and 'units'
    -- is not a member. The result:
    --
    --     ERROR: invalid input value for enum uom_code: "units"
    --
    -- raised INSTEAD of the over-billing message, from inside the
    -- refusal path. The guard still refused, so the money was still
    -- safe — but the operator was told the unit code was invalid on a
    -- line whose unit was 'cum', which sends them to fix the wrong
    -- thing entirely and eventually to route around the check.
    --
    -- Found by attempting the refusal against a real database. It is
    -- invisible in any test that only asserts "the insert failed".
    COALESCE(item.uom::text, 'units'),
    COALESCE(item.description, 'that item'),
    COALESCE(item.item_code, '—'),
    authorised_qty
    USING ERRCODE = 'raise_exception';
END $$;

COMMENT ON FUNCTION ordence_guard_ra_bill_line_authorised() IS
  'Refuses an RA bill line whose cumulative claim exceeds the BOQ authorised quantity (original + approved variations) by more than 50 bps. Lines with no boq_item_id — day-work, provisional sums — are not checked.';

DROP TRIGGER IF EXISTS trg_030_guard_ra_bill_line_authorised ON ra_bill_lines;
CREATE TRIGGER trg_030_guard_ra_bill_line_authorised
  BEFORE INSERT OR UPDATE ON ra_bill_lines
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_ra_bill_line_authorised();

-- ════════════════════════════════════════════════════════════════════
-- §4  WHAT A PROJECT WAS SUPPOSED TO COST
-- ════════════════════════════════════════════════════════════════════
--
-- `projects` carried no budget of any kind, so every cost report in the
-- product could say what has been SPENT and nothing about whether that
-- is too much. "₹4.1 crore committed" is a number; "₹4.1 crore against a
-- ₹3.8 crore budget" is a decision.
--
-- ⚠️ MINOR UNITS (paise) AS bigint, like every other money column here.
-- A `numeric` budget compared against a `bigint` spend is a units bug
-- waiting in whichever report joins them.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_minor bigint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contingency_bps integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS saleable_area_sqft numeric(18,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_budget_non_negative') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_budget_non_negative
      CHECK (budget_minor IS NULL OR budget_minor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_contingency_bounded') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_contingency_bounded
      CHECK (contingency_bps IS NULL OR (contingency_bps >= 0 AND contingency_bps <= 10000));
  END IF;
END $$;

COMMENT ON COLUMN projects.budget_minor IS
  'Approved project cost in paise. NULL means no budget has been set — reports must say so rather than showing 0, which reads as "on budget".';

-- ════════════════════════════════════════════════════════════════════
-- §5  THE VIEW THAT MAKES ALL OF THE ABOVE VISIBLE
-- ════════════════════════════════════════════════════════════════════
--
-- Authorised, measured and billed for every BOQ line, side by side, with
-- the two gaps that matter named:
--
--   measured_not_billed  — work done that nobody has claimed for. This
--                          is the contractor's money sitting idle and
--                          the most common reason a subcontractor stops
--                          work.
--   billed_over_measured — claimed beyond what was measured. This is the
--                          one to look at first, every time.
--
-- ⚠️ `security_invoker = true`. Without it the view runs as its OWNER and
-- RLS does not apply — on a view spanning every tenant's contract values
-- that is the most consequential leak in the product.

CREATE OR REPLACE VIEW v_boq_billing_position
WITH (security_invoker = true) AS
WITH measured AS (
  SELECT me.tenant_id,
         me.boq_item_id,
         SUM(CASE WHEN me.is_deduction THEN -me.quantity_scaled ELSE me.quantity_scaled END) AS measured_micro
    FROM measurement_entries me
   WHERE me.boq_item_id IS NOT NULL
     AND me.status <> 'rejected'
   GROUP BY me.tenant_id, me.boq_item_id
),
billed AS (
  SELECT l.tenant_id,
         l.boq_item_id,
         SUM(l.quantity)     AS billed_qty,
         SUM(l.amount_minor) AS billed_minor
    FROM ra_bill_lines l
    JOIN ra_bills b ON b.id = l.ra_bill_id AND b.tenant_id = l.tenant_id
   WHERE l.boq_item_id IS NOT NULL
     AND b.status NOT IN ('rejected', 'cancelled')
   GROUP BY l.tenant_id, l.boq_item_id
)
SELECT bi.tenant_id,
       bi.boq_id,
       b.project_id,
       b.contract_id,
       b.code                                            AS boq_code,
       bi.id                                             AS boq_item_id,
       bi.item_code,
       bi.description,
       bi.uom,
       ROUND((COALESCE(bi.quantity_scaled, 0)
            + COALESCE(bi.varied_quantity_scaled, 0)) / 1000000.0, 3)  AS authorised_qty,
       ROUND(COALESCE(m.measured_micro, 0) / 1000000.0, 3)             AS measured_qty,
       COALESCE(bl.billed_qty, 0)                                      AS billed_qty,
       COALESCE(bi.varied_rate_minor, bi.rate_minor)                   AS rate_minor,
       COALESCE(bl.billed_minor, 0)                                    AS billed_minor,
       -- Work measured but not yet claimed, in money.
       GREATEST(
         ROUND(COALESCE(m.measured_micro, 0) / 1000000.0, 3) - COALESCE(bl.billed_qty, 0),
         0
       ) * COALESCE(bi.varied_rate_minor, bi.rate_minor)               AS measured_not_billed_minor,
       -- Claimed beyond what was measured. Look here first.
       GREATEST(
         COALESCE(bl.billed_qty, 0) - ROUND(COALESCE(m.measured_micro, 0) / 1000000.0, 3),
         0
       )                                                               AS billed_over_measured_qty
  FROM boq_items bi
  JOIN boqs b     ON b.id = bi.boq_id       AND b.tenant_id = bi.tenant_id
  LEFT JOIN measured m ON m.boq_item_id = bi.id AND m.tenant_id = bi.tenant_id
  LEFT JOIN billed  bl ON bl.boq_item_id = bi.id AND bl.tenant_id = bi.tenant_id
 WHERE bi.is_heading = false;

COMMENT ON VIEW v_boq_billing_position IS
  'Authorised vs measured vs billed for every BOQ line. billed_over_measured_qty > 0 is always worth investigating; measured_not_billed_minor is the contractor money sitting unclaimed.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- AFTER RUNNING THIS FILE:
--
--   SELECT boq_code, item_code, authorised_qty, measured_qty, billed_qty
--     FROM v_boq_billing_position
--    WHERE billed_over_measured_qty > 0;
--
-- Zero rows is the expected answer.
-- ════════════════════════════════════════════════════════════════════
