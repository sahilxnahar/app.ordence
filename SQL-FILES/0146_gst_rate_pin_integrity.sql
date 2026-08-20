-- ############################################################################
-- 0146 — A PINNED GST RATE MUST BE THIS TENANT'S RATE, AND IT MUST STAY PUT
--        (Wave 15 / Track E — GST, TDS and statutory correctness)
-- ############################################################################
--
-- WHY THIS FILE EXISTS
-- -------------------
-- 0021 §3 wrote several hundred words about a specific hole and then closed
-- it — for the two tables that existed at the time:
--
--     -- a line in tenant A carrying
--     --     gst_rate_id = <a rate row owned by B>   <- passes a single-column FK
--
-- It closed it with a composite key:
--
--     FOREIGN KEY (gst_rate_id, tenant_id) REFERENCES hsn_sac_rates (id, tenant_id)
--
-- 🔴 `sales_invoice_lines` AND `sales_order_lines`, ADDED LATER IN 0049 AND
-- 0028, NEVER GOT IT. Their rate pin is `REFERENCES hsn_sac_rates(id)` — the
-- single-column form 0021 spent a page explaining is not enough.
--
-- ⚠️ AND RLS DOES NOT COVER FOR IT. PostgreSQL runs referential-integrity
-- checks as the referenced table's owner with row security OFF. So the FK
-- happily resolves a rate row the writing session cannot even SELECT. Proven
-- on a live Postgres 16 before this file was written:
--
--     PROOF 2a: sales_invoice_lines accepted a TENANT_A line pinned to
--               TENANT_B's hsn_sac_rates row.
--     PROOF 2b: invoice_lines REFUSED the identical pin.
--
-- Two tables, one schema, the same pin, opposite outcomes. This file makes the
-- four tables agree.
--
-- 🔴 THE SECOND HALF OF THE SAME OMISSION. `enforce_gst_rate_history_immutable`
-- (0021 §5) refuses to move a rate period out from under a document that used
-- it — but it counts usage through `invoice_lines` ONLY. It is blind to
-- `sales_invoice_lines` and `sales_order_lines`, which is to say it is blind to
-- every outward supply the product actually raises. A rate period can therefore
-- be re-dated, or its bps edited, under a filed sales invoice, and the trigger
-- written to prevent exactly that reports nothing. Same for the delete guard.
--
-- WHAT THIS FILE DOES NOT DO
-- --------------------------
-- It does not decide any tax. It makes a pin mean what it says. The arithmetic
-- is 0147's problem.
--
-- IS THERE DATA LOSS? No. It adds constraints and widens two trigger
-- functions. It refuses to install a constraint that existing rows violate,
-- and tells you how many and which, rather than dropping them.
--
-- RUN ORDER: after 0021, 0028 and 0049. Before 0147, which relies on the pin
-- being tenant-true. Code push order does not matter: nothing in the
-- application writes these columns with a resolved value today (that is the
-- defect), so nothing can start failing because this landed first.
-- ############################################################################


-- ############################################################################
-- SECTION 1 — REFUSE TO PROCEED OVER EXISTING VIOLATIONS
-- ############################################################################
--
-- ⭐ THIS RUNS BEFORE THE CONSTRAINTS, AND THAT IS THE POINT. `ALTER TABLE ...
-- ADD CONSTRAINT` would fail on its own with `violates foreign key constraint`
-- and no count, no ids, and no instruction. A migration that fails should say
-- what to fix.
--
-- ⚠️ SECURITY DEFINER IS NOT USED AND MUST NOT BE. This block runs as the
-- migration runner, which under FORCE RLS sees only what its policies allow.
-- It is looking for rows whose tenant_id disagrees with the referenced row's,
-- which is a comparison of two columns, not a cross-tenant read.

DO $$
DECLARE
  v_bad_inv_rate  bigint;
  v_bad_inv_code  bigint;
  v_bad_ord_rate  bigint;
  v_bad_ord_code  bigint;
BEGIN
  SELECT count(*) INTO v_bad_inv_rate
    FROM sales_invoice_lines l JOIN hsn_sac_rates r ON r.id = l.hsn_sac_rate_id
   WHERE l.tenant_id <> r.tenant_id;

  SELECT count(*) INTO v_bad_inv_code
    FROM sales_invoice_lines l JOIN hsn_sac_codes c ON c.id = l.hsn_sac_code_id
   WHERE l.tenant_id <> c.tenant_id;

  SELECT count(*) INTO v_bad_ord_rate
    FROM sales_order_lines l JOIN hsn_sac_rates r ON r.id = l.hsn_sac_rate_id
   WHERE l.tenant_id <> r.tenant_id;

  SELECT count(*) INTO v_bad_ord_code
    FROM sales_order_lines l JOIN hsn_sac_codes c ON c.id = l.hsn_sac_code_id
   WHERE l.tenant_id <> c.tenant_id;

  IF v_bad_inv_rate + v_bad_inv_code + v_bad_ord_rate + v_bad_ord_code > 0 THEN
    RAISE EXCEPTION
      '0146 REFUSED: % sales invoice line(s) and % sales order line(s) already '
      'point at another tenant''s rate row, and % / % at another tenant''s '
      'classification. Do not delete them. Each one is a document charged at a '
      'rate its own workspace does not hold, so the fix is a decision, not a '
      'sweep: identify the correct rate period in this tenant, repoint the line, '
      'and credit-and-reissue anything already filed. Then re-run this file.',
      v_bad_inv_rate, v_bad_ord_rate, v_bad_inv_code, v_bad_ord_code
      USING ERRCODE = '23503';
  END IF;

  RAISE NOTICE
    '0146 §1: no existing cross-tenant rate or classification pins. Safe to '
    'install the composite keys.';
END
$$;


-- ############################################################################
-- SECTION 2 — THE COMPOSITE KEYS
-- ############################################################################
--
-- `hsn_sac_rates` and `hsn_sac_codes` already carry the UNIQUE (id, tenant_id)
-- that a composite FK needs — 0021 added both. So this is purely the
-- referencing side.
--
-- ⚠️ ON DELETE RESTRICT IS PRESERVED, not upgraded to CASCADE. A rate row is
-- the evidence of what a document was charged at. Deleting it should be refused,
-- not silently propagated.

DO $$
BEGIN
  -- sales_invoice_lines → hsn_sac_rates
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'sales_invoice_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk') THEN
    ALTER TABLE sales_invoice_lines
      DROP CONSTRAINT sales_invoice_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_invoice_lines_rate_same_tenant') THEN
    ALTER TABLE sales_invoice_lines
      ADD CONSTRAINT sales_invoice_lines_rate_same_tenant
      FOREIGN KEY (hsn_sac_rate_id, tenant_id)
      REFERENCES hsn_sac_rates (id, tenant_id) ON DELETE RESTRICT;
  END IF;

  -- sales_invoice_lines → hsn_sac_codes
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'sales_invoice_lines_hsn_sac_code_id_hsn_sac_codes_id_fk') THEN
    ALTER TABLE sales_invoice_lines
      DROP CONSTRAINT sales_invoice_lines_hsn_sac_code_id_hsn_sac_codes_id_fk;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_invoice_lines_hsn_same_tenant') THEN
    ALTER TABLE sales_invoice_lines
      ADD CONSTRAINT sales_invoice_lines_hsn_same_tenant
      FOREIGN KEY (hsn_sac_code_id, tenant_id)
      REFERENCES hsn_sac_codes (id, tenant_id) ON DELETE RESTRICT;
  END IF;

  -- sales_order_lines → hsn_sac_rates
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'sales_order_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk') THEN
    ALTER TABLE sales_order_lines
      DROP CONSTRAINT sales_order_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_rate_same_tenant') THEN
    ALTER TABLE sales_order_lines
      ADD CONSTRAINT sales_order_lines_rate_same_tenant
      FOREIGN KEY (hsn_sac_rate_id, tenant_id)
      REFERENCES hsn_sac_rates (id, tenant_id) ON DELETE RESTRICT;
  END IF;

  -- sales_order_lines → hsn_sac_codes
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'sales_order_lines_hsn_sac_code_id_hsn_sac_codes_id_fk') THEN
    ALTER TABLE sales_order_lines
      DROP CONSTRAINT sales_order_lines_hsn_sac_code_id_hsn_sac_codes_id_fk;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_order_lines_hsn_same_tenant') THEN
    ALTER TABLE sales_order_lines
      ADD CONSTRAINT sales_order_lines_hsn_same_tenant
      FOREIGN KEY (hsn_sac_code_id, tenant_id)
      REFERENCES hsn_sac_codes (id, tenant_id) ON DELETE RESTRICT;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 3 — THE RATE-HISTORY GUARDS LEARN ABOUT OUTWARD SUPPLIES
-- ############################################################################
--
-- ⭐ THE COUNT MOVES INTO ONE FUNCTION, CALLED BY BOTH GUARDS. The update guard
-- and the delete guard were counting the same thing two different ways, and
-- only one of them was ever extended. Counting in one place is why the next
-- table that pins a rate only has to be added once.
--
-- ⚠️ SECURITY INVOKER, deliberately, exactly as 0021 argued: the lookup runs
-- under RLS, so a rate row in another tenant reports no dependants. That is
-- correct — after Section 2 a cross-tenant dependency cannot exist — and
-- making it DEFINER would hand the caller a cross-tenant read through an
-- error message.
--
-- ⚠️ THE DATE USED IS THE DOCUMENT'S OWN DATE, per table, because the tables
-- disagree about what that column is called. `invoices` has `tax_point_date`
-- falling back to issue then creation; `sales_invoices` has `invoice_date`,
-- which is NOT NULL; `sales_orders` has `order_date`. Guessing one name and
-- COALESCEing would have silently returned NULL for two of the three.

CREATE OR REPLACE FUNCTION gst_rate_usage(p_rate_id uuid)
RETURNS TABLE (used bigint, earliest date, latest date)
LANGUAGE sql
STABLE
AS $$
  WITH uses AS (
    SELECT COALESCE(i.tax_point_date, i.issued_at::date, i.created_at::date) AS on_date
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
     WHERE l.gst_rate_id = p_rate_id

    UNION ALL

    SELECT i.invoice_date
      FROM sales_invoice_lines l
      JOIN sales_invoices i ON i.id = l.invoice_id
     WHERE l.hsn_sac_rate_id = p_rate_id

    UNION ALL

    SELECT o.order_date
      FROM sales_order_lines l
      JOIN sales_orders o ON o.id = l.order_id
     WHERE l.hsn_sac_rate_id = p_rate_id

    UNION ALL

    SELECT p.invoice_date
      FROM purchase_invoice_lines l
      JOIN purchase_invoices p ON p.id = l.purchase_invoice_id
     WHERE l.gst_rate_id = p_rate_id
  )
  SELECT count(*)::bigint, min(on_date), max(on_date) FROM uses;
$$;

COMMENT ON FUNCTION gst_rate_usage(uuid) IS
  'Every document line pinned to a rate period, across all four tables that '
  'pin one, with the earliest and latest document date. 0146. If a fifth '
  'table ever pins a rate, add it HERE and both guards learn about it at once.';


CREATE OR REPLACE FUNCTION enforce_gst_rate_history_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_used     bigint;
  v_earliest date;
  v_latest   date;
BEGIN
  SELECT u.used, u.earliest, u.latest
    INTO v_used, v_earliest, v_latest
    FROM gst_rate_usage(OLD.id) u;

  IF COALESCE(v_used, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.rate_bps               IS DISTINCT FROM OLD.rate_bps
     OR NEW.cess_rate_bps       IS DISTINCT FROM OLD.cess_rate_bps
     OR NEW.cess_per_unit_minor IS DISTINCT FROM OLD.cess_per_unit_minor
     OR NEW.hsn_sac_id          IS DISTINCT FROM OLD.hsn_sac_id THEN
    RAISE EXCEPTION
      'This rate has already been used on % document line(s) and cannot be '
      'changed. A historical invoice keeps the rate that applied on its date — '
      'editing this row would silently restate every document raised under it, '
      'including ones already filed in a return. Close this period and open a '
      'new one instead, then credit and reissue anything that went out at the '
      'wrong figure.',
      v_used
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.effective_from > v_earliest THEN
    RAISE EXCEPTION
      'A document dated % is already priced from this rate, so the period '
      'cannot start on %. Moving the window off a document leaves it pointing '
      'at a rate period that does not cover its own date.',
      v_earliest, NEW.effective_from
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.effective_to IS NOT NULL AND v_latest >= NEW.effective_to THEN
    RAISE EXCEPTION
      'A document dated % is already priced from this rate, so the period '
      'cannot end on %. Close it no earlier than the day after the last '
      'document that used it.',
      v_latest, NEW.effective_to
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION block_used_gst_rate_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_used bigint;
BEGIN
  SELECT u.used INTO v_used FROM gst_rate_usage(OLD.id) u;

  IF COALESCE(v_used, 0) > 0 THEN
    RAISE EXCEPTION
      'This rate period is used by % document line(s) and cannot be deleted. It '
      'is the evidence of what those documents were charged at. Close the period '
      'with an end date instead — that is how a superseded rate is retired.',
      v_used
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN OLD;
END;
$$;


-- ############################################################################
-- SECTION 4 — SELF-VERIFICATION
-- ############################################################################
--
-- ⭐ THIS DOES NOT ASK pg_constraint WHETHER THE CONSTRAINT EXISTS AND THEN
-- DECLARE VICTORY. A row in `pg_constraint` proves a name was registered; it
-- does not prove the key refuses anything. The count-the-catalogue check is the
-- `count(*) >= 10 THEN 'PASS'` shape this codebase has been bitten by, applied
-- to DDL.
--
-- So this ATTEMPTS THE WRITE THE FILE EXISTS TO REFUSE, inside a savepoint,
-- against two real tenants it creates and removes. If the insert succeeds, the
-- file failed and says so. If the constraint were dropped tomorrow, this block
-- re-run would fail on the same line.
--
-- ⚠️ IT ALSO CHECKS THE NEGATIVE: a SAME-tenant pin must still be ACCEPTED.
-- A constraint that refuses everything passes a refusal test and breaks the
-- product.

DO $$
DECLARE
  v_a        uuid := gen_random_uuid();
  v_b        uuid := gen_random_uuid();
  v_co_a     uuid := gen_random_uuid();
  v_code_a   uuid := gen_random_uuid();
  v_code_b   uuid := gen_random_uuid();
  v_rate_a   uuid := gen_random_uuid();
  v_rate_b   uuid := gen_random_uuid();
  v_inv_a    uuid := gen_random_uuid();
  v_probe_ran      boolean := false;
  v_refused_cross  boolean := false;
  v_accepted_same  boolean := false;
  v_same_err       text := '';
BEGIN
  /*
   * ⭐ THE WHOLE PROBE IS ONE SAVEPOINT AND IT IS ALWAYS ROLLED BACK.
   *
   * A self-verification that leaves rows behind is a migration that seeds
   * a production database with fake tenants. A sentinel exception at the
   * end of the sub-block discards every insert; the plpgsql variables
   * survive it, because plpgsql variables are not transactional, and the
   * assertions below read them.
   *
   * ⚠️ `v_probe_ran` EXISTS BECAUSE OF THE 23-TIMES DEFECT. If a fixture
   * insert failed for an unrelated reason, every `v_refused_*` flag would
   * still read `false` and every "did it refuse?" assertion could be
   * written to pass on a probe that never happened. So the first thing
   * asserted is that the probe reached its own last line.
   */
  BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);

    INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_a, 'org_0146_probe_' || substr(v_a::text, 1, 8),
            '0146-probe-a-' || substr(v_a::text, 1, 8), '0146 probe A', 'active'),
           (v_b, 'org_0146_probe_' || substr(v_b::text, 1, 8),
            '0146-probe-b-' || substr(v_b::text, 1, 8), '0146 probe B', 'active');

    INSERT INTO companies (id, tenant_id, name)
    VALUES (v_co_a, v_a, '0146 probe customer');

    INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
    VALUES (v_code_a, v_a, '998314', 'sac', '0146 probe'),
           (v_code_b, v_b, '998314', 'sac', '0146 probe');

    INSERT INTO hsn_sac_rates (id, tenant_id, hsn_sac_id, rate_bps, effective_from)
    VALUES (v_rate_a, v_a, v_code_a, 1800, DATE '2017-07-01'),
           (v_rate_b, v_b, v_code_b,  500, DATE '2017-07-01');

    INSERT INTO sales_invoices
      (id, tenant_id, invoice_number, financial_year, status, company_id,
       invoice_date, place_of_supply_code, is_inter_state, supply_type, currency)
    VALUES (v_inv_a, v_a, '0146-PROBE-1', '2026-27', 'draft', v_co_a,
            DATE '2026-08-19', '27', true, 'services', 'INR');

    -- ── 1. THE CROSS-TENANT PIN MUST NOW BE REFUSED ────────────────────
    -- This is the exact insert the Track E harness proved SUCCEEDED before
    -- this file existed (PROOF 2a).
    --
    -- ⚠️ THE LINE IS ARITHMETICALLY CORRECT ON PURPOSE — 500 bps on ₹1,000 is
    -- ₹50, which is tenant B's rate. 0147's BEFORE trigger fires ahead of the
    -- foreign key, so a line that failed ITS check would abort here with a
    -- `check_violation` and this block would report the pin as unrefused. The
    -- probe has to give 0147 nothing to object to, so that the only thing left
    -- that can refuse it is the key this file installs.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, hsn_sac_rate_id,
         quantity, uom, unit_price_minor, taxable_value_minor,
         tax_rate_bps, igst_minor)
      VALUES (v_a, v_inv_a, 1, '0146 probe cross-tenant pin', v_rate_b,
              1, 'nos', 100000, 100000, 500, 5000);
    EXCEPTION
      WHEN foreign_key_violation THEN v_refused_cross := true;
    END;

    -- ── 2. THE SAME-TENANT PIN MUST STILL BE ACCEPTED ──────────────────
    -- A constraint that refuses everything passes a refusal test and breaks
    -- the product. This is the half that catches that.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, hsn_sac_rate_id,
         quantity, uom, unit_price_minor, taxable_value_minor,
         tax_rate_bps, igst_minor)
      VALUES (v_a, v_inv_a, 2, '0146 probe same-tenant pin', v_rate_a,
              1, 'nos', 100000, 100000, 1800, 18000);
      v_accepted_same := true;
    EXCEPTION
      WHEN others THEN
        v_accepted_same := false;
        v_same_err := SQLSTATE || ' ' || SQLERRM;
    END;

    v_probe_ran := true;
    RAISE EXCEPTION '0146_PROBE_ROLLBACK' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> '0146_PROBE_ROLLBACK' THEN RAISE; END IF;
  END;

  IF NOT v_probe_ran THEN
    RAISE EXCEPTION
      '0146 FAILED: the verification probe did not reach its own last line, so '
      'every flag it sets is meaningless. Do not read the flags as a pass.';
  END IF;

  IF NOT v_refused_cross THEN
    RAISE EXCEPTION
      '0146 FAILED: sales_invoice_lines still accepted a line in tenant A '
      'pinned to a hsn_sac_rates row owned by tenant B. That is the exact '
      'write this file exists to refuse, and it is still allowed.';
  END IF;

  IF NOT v_accepted_same THEN
    RAISE EXCEPTION
      '0146 FAILED: a line pinned to its OWN tenant''s rate row was refused '
      'with: %. The new key refuses something correct, which is worse than the '
      'hole it closed.', v_same_err;
  END IF;

  -- ── 3. THE SINGLE-COLUMN FORMS MUST BE GONE ─────────────────────────
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname IN ('sales_invoice_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk',
                                'sales_order_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk',
                                'sales_invoice_lines_hsn_sac_code_id_hsn_sac_codes_id_fk',
                                'sales_order_lines_hsn_sac_code_id_hsn_sac_codes_id_fk')) THEN
    RAISE EXCEPTION
      '0146 FAILED: a single-column rate or classification foreign key is still '
      'installed alongside the composite one.';
  END IF;

  -- ── 4. THE HISTORY GUARDS MUST READ ALL FOUR PINNING TABLES ─────────
  -- Reading the installed function body, not trusting that the CREATE OR
  -- REPLACE above is the definition now in place: another file later in the
  -- run order could have replaced it.
  IF pg_get_functiondef('gst_rate_usage(uuid)'::regprocedure) NOT LIKE '%sales_invoice_lines%'
     OR pg_get_functiondef('gst_rate_usage(uuid)'::regprocedure) NOT LIKE '%sales_order_lines%'
     OR pg_get_functiondef('gst_rate_usage(uuid)'::regprocedure) NOT LIKE '%purchase_invoice_lines%' THEN
    RAISE EXCEPTION
      '0146 FAILED: gst_rate_usage() does not read all four tables that pin a '
      'rate. The history guard is still blind to at least one of them.';
  END IF;

  IF pg_get_functiondef('enforce_gst_rate_history_immutable()'::regprocedure)
       NOT LIKE '%gst_rate_usage%'
     OR pg_get_functiondef('block_used_gst_rate_delete()'::regprocedure)
       NOT LIKE '%gst_rate_usage%' THEN
    RAISE EXCEPTION
      '0146 FAILED: a rate-history guard still counts usage its own way and did '
      'not pick up gst_rate_usage(). It remains blind to sales invoices.';
  END IF;

  RAISE NOTICE
    '0146 PASS: a cross-tenant rate pin on sales_invoice_lines was ATTEMPTED '
    'and REFUSED; a same-tenant pin was ATTEMPTED and ACCEPTED; both '
    'single-column keys are gone from both sales tables; gst_rate_usage() '
    'reads all four pinning tables and both history guards call it. The probe '
    'rows were rolled back and nothing was left behind.';
END
$$;


-- ############################################################################
-- SECTION 5 — WHAT THIS FILE DELIBERATELY LEAVES OPEN
-- ############################################################################
--
-- ⚠️ A PIN IS STILL OPTIONAL. `hsn_sac_rate_id` is nullable on both tables and
-- almost every row has NULL, because no code path resolves it. This file makes
-- a pin, WHEN PRESENT, tenant-true. It does not make one mandatory: doing that
-- in the same file would have refused every insert the product currently makes
-- and the whole file would have had to be reverted, taking the tenant fix with
-- it. Coverage is 0148's problem and it is reported as a number, not asserted
-- as a floor.
--
-- ⚠️ AND A PIN STILL NEED NOT AGREE WITH `tax_rate_bps`. That is 0147.
-- ############################################################################
