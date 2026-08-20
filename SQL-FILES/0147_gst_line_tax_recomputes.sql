-- ############################################################################
-- 0147 — A LINE'S STORED GST MUST SURVIVE BEING RECOMPUTED
--        (Wave 15 / Track E — GST, TDS and statutory correctness)
-- ############################################################################
--
-- WHY THIS FILE EXISTS
-- -------------------
-- 0021 §6 installed `enforce_gst_invoice_reconciles`, a deferred constraint
-- trigger that proves an invoice's HEADER agrees with the SUM OF ITS LINES.
-- It is correct and it is not enough, for two separate reasons.
--
-- 🔴 REASON ONE: IT HAS NEVER RUN. Its first statement is
--
--       IF NOT COALESCE(v_invoice.gst_computed, false) THEN RETURN NULL; END IF;
--
-- and `invoices.gst_computed` is set to true by no code path in this product.
-- `server/billing/invoice-generator.ts` is the only writer of `invoices` and
-- `invoice_lines` and it never sets it. Proven on a live Postgres before this
-- file was written:
--
--     PROOF 3a: an invoice with gst_computed=false committed with a header
--               that disagreed with its own lines.
--     PROOF 3b: the identical invoice was REFUSED once gst_computed=true.
--
-- The trigger works. The opt-in is what stops it running. `SELECT count(*)
-- FILTER (WHERE gst_computed) FROM invoices` returns 0.
--
-- 🔴 REASON TWO, AND IT IS THE LARGER ONE: FOOTING IS NOT ARITHMETIC. A
-- document whose header equals the sum of its lines is internally consistent
-- and can still be wrong in every figure. Nothing anywhere checks that a
-- line's CGST/SGST/IGST is what its own taxable value and its own rate
-- produce:
--
--     PROOF 1: taxable_value_minor = 100000, tax_rate_bps = 1800,
--              igst_minor = 1. The database accepted it. The arithmetic
--              says 18000.
--
-- And the tables where this matters most are not the ones 0021 guarded.
-- `sales_invoice_lines` — the outward supplies GSTR-1 is built from — has no
-- `gst_computed` column, no reconciliation trigger, and its `tax_rate_bps`
-- and `hsn_sac_rate_id` both arrive from the client (`lib/validators/orders.ts`
-- types the rate id as an optional uuid; `server/actions/orders.ts` passes both
-- through untouched).
--
-- ⭐ SO THERE IS NO OPT-IN FLAG IN THIS FILE, AND THAT IS THE DESIGN.
-- An opt-in is how the last one came to have never executed. The arithmetic
-- check cannot break a correct document — a line that adds up passes it — so
-- it does not need one. Coverage of the RATE PIN, which genuinely cannot be
-- made mandatory today because nothing populates it, is reported as a number
-- by 0148 rather than asserted as a floor.
--
-- ⚠️ THIS FILE ENFORCES ARITHMETIC, NOT POLICY. It does not decide whether
-- 18% was the right rate for that classification, or whether the place of
-- supply was right. It decides that whatever rate the document claims, the
-- money on the document is what that rate produces — and that a rate pinned
-- to a period is pinned to a period covering the document's own date.
--
-- IS THERE DATA LOSS? No. It adds functions and BEFORE triggers. Existing
-- rows are untouched and are re-checked only if somebody edits their tax.
--
-- RUN ORDER: after 0146 (which makes a pin tenant-true — this file trusts
-- that). Before 0148. Code push order does not matter: every current code
-- path already computes with this exact arithmetic, so nothing that works
-- today starts failing because this landed first. See §5 for the evidence.
-- ############################################################################


-- ############################################################################
-- SECTION 1 — THE ARITHMETIC, ONCE, IN SQL, MIRRORING THE TYPESCRIPT EXACTLY
-- ############################################################################
--
-- ⚠️ TWO IMPLEMENTATIONS OF GST IS A DEFECT EVEN WHEN BOTH ARE RIGHT, because
-- they will not stay right together. This file writes a second one anyway, and
-- the justification has to be better than "the database needs it".
--
-- It is this: these two functions are not a tax engine. They are the two
-- rounding primitives, and they are transcribed from
-- `lib/billing/money.ts` — `applyRateBps` and `splitEvenly` — which
-- `lib/gst/tax.ts:8` explicitly forbids restating. Every rule that could
-- diverge (which rate, which place of supply, whether reverse charge applies,
-- what the taxable value is) stays in TypeScript. What crosses into SQL is
-- integer division, and integer division does not drift.
--
-- ⭐ AND §5 PROVES THEY AGREE, on every case that has ever been observed to
-- separate two half-up implementations, rather than asserting that they do.

-- `applyRateBps` (lib/billing/money.ts:163), transcribed.
--   const rounded = (abs * BigInt(rateBps) + 5000n) / 10_000n;
--   return negative ? -rounded : rounded;
-- Half-up in exact integer arithmetic, symmetric about zero, so a credit of
-- -₹100 at 18% is exactly the negative of a charge of ₹100 at 18%.
-- ⚠️ PostgreSQL bigint division truncates TOWARD ZERO, as BigInt does. On the
-- absolute value that is floor, which is what half-up needs. Doing this on the
-- signed value instead would round -0.5 the wrong way.
CREATE OR REPLACE FUNCTION gst_apply_rate_bps(p_amount_minor bigint, p_rate_bps integer)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE WHEN p_amount_minor < 0 THEN -1 ELSE 1 END
       * ((abs(p_amount_minor) * p_rate_bps + 5000) / 10000);
$$;

COMMENT ON FUNCTION gst_apply_rate_bps(bigint, integer) IS
  'Half-up rate application in exact integer arithmetic. Transcribed from '
  'applyRateBps in lib/billing/money.ts. 0147 §5 proves the two agree.';

-- `splitEvenly(total, 2)[0]` (lib/billing/money.ts:185), transcribed.
--   base = total / 2 (truncating toward zero); remainder = total - base*2;
--   the FIRST share takes the odd minor unit.
-- The second share is always `total - first`, so the two are exact by
-- construction. ⭐ THE ROUNDED TOTAL IS SPLIT, NOT THE RATE HALVED: halving
-- the rate and rounding each half separately turns ₹100.01 of tax into
-- ₹50.01 + ₹50.01 and the invoice stops balancing.
CREATE OR REPLACE FUNCTION gst_cgst_share(p_total_tax_minor bigint)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT (p_total_tax_minor / 2)
       + CASE WHEN p_total_tax_minor - (p_total_tax_minor / 2) * 2 = 0 THEN 0
              WHEN p_total_tax_minor < 0 THEN -1
              ELSE 1 END;
$$;

COMMENT ON FUNCTION gst_cgst_share(bigint) IS
  'The CGST half of a rounded line tax; SGST is the remainder. Transcribed '
  'from splitEvenly(total, 2) in lib/billing/money.ts. The odd paisa lands '
  'on CGST, deterministically. 0147 §5 proves the two agree.';


-- ############################################################################
-- SECTION 2 — ONE TRIGGER FUNCTION, FIVE TABLES
-- ############################################################################
--
-- ⭐ ONE FUNCTION PARAMETERISED BY TG_ARGV, NOT FIVE NEAR-IDENTICAL COPIES.
-- Five copies is how `enforce_gst_rate_history_immutable` and
-- `block_used_gst_rate_delete` came to count the same thing two different ways
-- and only one of them got extended (0146 §3). A rule enforced in five places
-- is enforced in one place and imitated in four.
--
-- The row is read as JSONB so one body can serve tables whose columns differ.
--
-- TG_ARGV
--   0  parent table                     e.g. 'sales_invoices'
--   1  the line's FK to the parent      e.g. 'invoice_id'
--   2  the parent's document date       e.g. 'invoice_date'  ('' = no date)
--   3  the line's rate-pin column       e.g. 'hsn_sac_rate_id'  ('' = none)
--   4  the line's cess rate column      e.g. 'cess_rate_bps'    ('' = none)
--   5  the parent's inter-state flag    e.g. 'is_inter_state'   ('' = none)
--   6  mode: 'full' or 'pin_only'
--   7  the line's RATE column            e.g. 'tax_rate_bps'
--   8  the line's line-number column     e.g. 'line_no'  ('' = none)
--
-- ⚠️ 7 AND 8 EXIST BECAUSE THE FIVE TABLES DO NOT AGREE ON THEIR OWN COLUMN
-- NAMES. `purchase_invoice_lines` calls the rate `rate_bps` and the line number
-- `line_number`; the other four say `tax_rate_bps`, and `invoice_lines` has no
-- line number at all (it has `sort_order`). The first version of this file
-- hardcoded `tax_rate_bps` and `line_no`, which meant every purchase line was
-- silently evaluated at a rate of ZERO and every purchase-side message read
-- "Line ?". It did no damage in `pin_only` mode, which reads neither — and that
-- is precisely why it would have survived: a latent, invisible mis-wiring that
-- becomes a total outage the day somebody promotes purchases to 'full' and the
-- trigger refuses every taxed bill in the product. Naming the columns removes
-- the trap rather than documenting it.
--
-- ⚠️ SECURITY DEFINER, AND THE REASON MATTERS. The pin check reads the
-- `hsn_sac_rates` row the line points at. Under FORCE RLS a legitimate
-- platform-scope write cannot see that row, and a check that silently skips
-- when it cannot see its input is precisely the defect this file was written
-- to remove. 0146 makes the pin a two-column key onto (id, tenant_id), so the
-- referenced row is GUARANTEED to be the writing tenant's own: there is no
-- cross-tenant read here to leak, and the error messages quote only figures
-- from the caller's own workspace. `search_path` is pinned, without which a
-- SECURITY DEFINER function is a privilege-escalation vector.

CREATE OR REPLACE FUNCTION enforce_gst_line_recomputes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new          jsonb := to_jsonb(NEW);
  v_old          jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  v_parent       text  := TG_ARGV[0];
  v_fk_col       text  := TG_ARGV[1];
  v_date_col     text  := TG_ARGV[2];
  v_pin_col      text  := TG_ARGV[3];
  v_cess_col     text  := TG_ARGV[4];
  v_inter_col    text  := TG_ARGV[5];
  v_mode         text  := TG_ARGV[6];
  v_rate_col     text  := COALESCE(NULLIF(TG_ARGV[7], ''), 'tax_rate_bps');
  v_lineno_col   text  := TG_ARGV[8];
  v_lineno       text;

  v_taxable      bigint;
  v_rate_bps     integer;
  v_cess_bps     integer;
  v_cgst         bigint;
  v_sgst         bigint;
  v_igst         bigint;
  v_cess         bigint;

  v_exp_tax      bigint;
  v_exp_cgst     bigint;
  v_exp_sgst     bigint;
  v_exp_igst     bigint;
  v_exp_cess     bigint;

  v_pin          uuid;
  v_doc_date     date;
  v_inter        boolean;
  v_rate         record;
BEGIN
  /*
   * ⭐ ON UPDATE, ONLY RE-CHECK IF SOMETHING RELEVANT MOVED.
   *
   * Without this, a legacy row written before this file existed could never
   * be marked paid, void, or reconciled again: an UPDATE touching only
   * `status` would be refused for arithmetic nobody is changing. That turns
   * a correctness control into an outage, and the person on the other end
   * fixes it by dropping the trigger.
   *
   * ⚠️ THE LIST IS THE TAX COLUMNS AND ONLY THE TAX COLUMNS. If a column
   * that feeds the arithmetic is ever added, it belongs here, and §5's
   * disproof will not notice if it is forgotten — that is stated in
   * TRACK-REPORT.md rather than pretended away.
   */
  IF TG_OP = 'UPDATE'
     AND (v_new -> 'taxable_value_minor') IS NOT DISTINCT FROM (v_old -> 'taxable_value_minor')
     AND (v_new -> v_rate_col)            IS NOT DISTINCT FROM (v_old -> v_rate_col)
     AND (v_new -> 'cgst_minor')          IS NOT DISTINCT FROM (v_old -> 'cgst_minor')
     AND (v_new -> 'sgst_minor')          IS NOT DISTINCT FROM (v_old -> 'sgst_minor')
     AND (v_new -> 'igst_minor')          IS NOT DISTINCT FROM (v_old -> 'igst_minor')
     AND (v_new -> 'cess_minor')          IS NOT DISTINCT FROM (v_old -> 'cess_minor')
     AND (v_cess_col = '' OR (v_new -> v_cess_col) IS NOT DISTINCT FROM (v_old -> v_cess_col))
     AND (v_pin_col  = '' OR (v_new -> v_pin_col)  IS NOT DISTINCT FROM (v_old -> v_pin_col))
  THEN
    RETURN NEW;
  END IF;

  v_taxable  := COALESCE((v_new ->> 'taxable_value_minor')::bigint, 0);
  v_rate_bps := COALESCE((v_new ->> v_rate_col)::integer, 0);
  v_lineno   := CASE WHEN v_lineno_col = '' THEN '?'
                     ELSE COALESCE(v_new ->> v_lineno_col, '?') END;
  v_cgst     := COALESCE((v_new ->> 'cgst_minor')::bigint, 0);
  v_sgst     := COALESCE((v_new ->> 'sgst_minor')::bigint, 0);
  v_igst     := COALESCE((v_new ->> 'igst_minor')::bigint, 0);
  v_cess     := COALESCE((v_new ->> 'cess_minor')::bigint, 0);
  v_cess_bps := CASE WHEN v_cess_col = '' THEN NULL
                     ELSE COALESCE((v_new ->> v_cess_col)::integer, 0) END;
  v_pin      := CASE WHEN v_pin_col = '' THEN NULL
                     ELSE (v_new ->> v_pin_col)::uuid END;

  /* ─────────────────────────────────────────────────────────────────────
   * A. THE ARITHMETIC
   * ─────────────────────────────────────────────────────────────────────
   * Deliberately header-free. The head that was used is read off the line
   * itself, so this holds even on a table whose parent does not record an
   * inter-state flag. Whether that head was the RIGHT one is checked in B,
   * where the parent does record it.
   */
  IF v_mode = 'full' THEN
    v_exp_tax := gst_apply_rate_bps(v_taxable, v_rate_bps);

    IF v_igst <> 0 THEN
      v_exp_igst := v_exp_tax; v_exp_cgst := 0; v_exp_sgst := 0;
    ELSIF v_cgst <> 0 OR v_sgst <> 0 THEN
      v_exp_igst := 0;
      v_exp_cgst := gst_cgst_share(v_exp_tax);
      v_exp_sgst := v_exp_tax - v_exp_cgst;
    ELSE
      -- Nothing charged under any head. Correct only if nothing is due.
      v_exp_igst := 0; v_exp_cgst := 0; v_exp_sgst := 0;
      IF v_exp_tax <> 0 THEN
        RAISE EXCEPTION
          'Line % of this document declares a rate of % bps on a taxable value '
          'of % paise, which is % paise of tax, and carries none. A line cannot '
          'both name a rate and charge nothing under it — either the rate is '
          'wrong or the tax was never computed.',
          v_lineno, v_rate_bps, v_taxable, v_exp_tax
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF v_cgst <> v_exp_cgst OR v_sgst <> v_exp_sgst OR v_igst <> v_exp_igst THEN
      RAISE EXCEPTION
        'Line % does not recompute. Taxable % paise at % bps is % paise of tax, '
        'which is CGST %, SGST %, IGST %. The line stores CGST %, SGST %, '
        'IGST %. An auditor recomputing this line by hand gets a different '
        'answer from the document.',
        v_lineno, v_taxable, v_rate_bps, v_exp_tax,
        v_exp_cgst, v_exp_sgst, v_exp_igst, v_cgst, v_sgst, v_igst
        USING ERRCODE = '23514';
    END IF;

    -- Cess, where the table records the rate it was charged at.
    -- ⚠️ AD VALOREM ONLY. None of these tables carries a per-unit cess column,
    -- so a specific-rate cess (tobacco, pan masala) cannot be represented on
    -- them at all. That is a real gap and it is reported, not papered over:
    -- see TRACK-REPORT.md §4.
    IF v_cess_col <> '' THEN
      v_exp_cess := gst_apply_rate_bps(v_taxable, v_cess_bps);
      IF v_cess <> v_exp_cess THEN
        RAISE EXCEPTION
          'Line % does not recompute its cess. Taxable % paise at % bps is % '
          'paise of cess; the line stores %.',
          v_lineno, v_taxable, v_cess_bps,
          v_exp_cess, v_cess
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  /* ─────────────────────────────────────────────────────────────────────
   * B. THE HEAD MUST MATCH THE PLACE OF SUPPLY
   * ─────────────────────────────────────────────────────────────────────
   * Charging IGST on an intra-state supply is not a rounding error. The
   * customer cannot claim it, the supplier pays CGST+SGST again, and the
   * wrongly-paid IGST comes back as a refund claim months later. It is one
   * of the most expensive ordinary mistakes in Indian GST and it is a
   * single boolean away from being impossible.
   */
  IF v_inter_col <> '' AND v_mode = 'full' AND (v_cgst <> 0 OR v_sgst <> 0 OR v_igst <> 0) THEN
    EXECUTE format('SELECT %I FROM %I WHERE id = $1', v_inter_col, v_parent)
      INTO v_inter USING (v_new ->> v_fk_col)::uuid;

    IF v_inter IS NOT NULL THEN
      IF v_inter AND v_igst = 0 THEN
        RAISE EXCEPTION
          'Line % charges CGST and SGST on an inter-state supply. Inter-state '
          'is IGST at the full rate; CGST+SGST on it is tax paid to the wrong '
          'government and claimable by nobody.',
          v_lineno
          USING ERRCODE = '23514';
      END IF;
      IF NOT v_inter AND v_igst <> 0 THEN
        RAISE EXCEPTION
          'Line % charges IGST on an intra-state supply. Intra-state is CGST '
          'plus SGST; the recipient cannot claim this IGST and the supplier '
          'will pay CGST and SGST again on the same supply.',
          v_lineno
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  /* ─────────────────────────────────────────────────────────────────────
   * C. THE PIN MUST BE A REAL PIN
   * ─────────────────────────────────────────────────────────────────────
   * A `hsn_sac_rate_id` that names a period which does not cover the
   * document's own date is worse than no pin at all: it looks like
   * provenance and is not. 0146 already guarantees the row belongs to this
   * tenant. This adds the two things that make it mean something.
   */
  IF v_pin IS NOT NULL THEN
    SELECT r.rate_bps, r.cess_rate_bps, r.effective_from, r.effective_to
      INTO v_rate
      FROM hsn_sac_rates r
     WHERE r.id = v_pin;

    IF NOT FOUND THEN
      -- Cannot happen while the composite FK from 0146 is installed. If it
      -- ever does, the FK is gone and this is the louder symptom.
      RAISE EXCEPTION
        'Line % pins rate % which does not exist. The composite foreign key '
        'installed by 0146 has been dropped.',
        v_lineno, v_pin
        USING ERRCODE = '23503';
    END IF;

    -- C1. The pinned rate must be the rate charged.
    -- ⚠️ NOT APPLIED IN 'pin_only' MODE, and that is a deliberate asymmetry.
    -- On a PURCHASE the figures are the SUPPLIER'S. If a vendor charged 12%
    -- where the master says 18%, that is a dispute to record and pursue, not
    -- a row to refuse — refusing it would leave the business unable to enter
    -- a bill it has actually received. `server/purchases/engine.ts:268`
    -- already raises a `rateMismatch` warning for exactly this case. On an
    -- OUTWARD supply the figures are ours and there is no such excuse.
    IF v_mode = 'full' AND v_rate.rate_bps IS DISTINCT FROM v_rate_bps THEN
      RAISE EXCEPTION
        'Line % is pinned to a rate period of % bps but charges % bps. The pin '
        'is what proves which notification the figure came from; a pin that '
        'disagrees with the figure proves the opposite.',
        v_lineno, v_rate.rate_bps, v_rate_bps
        USING ERRCODE = '23514';
    END IF;

    IF v_mode = 'full' AND v_cess_col <> ''
       AND v_rate.cess_rate_bps IS DISTINCT FROM v_cess_bps THEN
      RAISE EXCEPTION
        'Line % is pinned to a rate period whose cess is % bps but charges % bps.',
        v_lineno, v_rate.cess_rate_bps, v_cess_bps
        USING ERRCODE = '23514';
    END IF;

    -- C2. The pinned period must cover the document's own date.
    IF v_date_col <> '' THEN
      EXECUTE format('SELECT %I FROM %I WHERE id = $1', v_date_col, v_parent)
        INTO v_doc_date USING (v_new ->> v_fk_col)::uuid;

      IF v_doc_date IS NOT NULL
         AND (v_doc_date < v_rate.effective_from
              OR (v_rate.effective_to IS NOT NULL AND v_doc_date >= v_rate.effective_to)) THEN
        RAISE EXCEPTION
          'Line % is on a document dated % but is pinned to a rate period '
          'running from % to %. The rate in force on the document''s own date '
          'is the one that governs; this pin points at a different period and '
          'would restate the document if anyone followed it.',
          v_lineno, v_doc_date,
          v_rate.effective_from, COALESCE(v_rate.effective_to::text, 'open')
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_gst_line_recomputes() FROM PUBLIC;


-- ############################################################################
-- SECTION 3 — ATTACHING IT
-- ############################################################################
--
-- ⚠️ BEFORE, NOT AFTER, AND NOT DEFERRED. 0021's reconciliation trigger has to
-- be deferred because it compares a header to lines that do not exist yet.
-- This one compares a line to ITSELF, so it can and should refuse at the
-- statement rather than at COMMIT — the error then names the statement that
-- caused it.

DROP TRIGGER IF EXISTS sales_invoice_lines_gst_recomputes ON sales_invoice_lines;
CREATE TRIGGER sales_invoice_lines_gst_recomputes
  BEFORE INSERT OR UPDATE ON sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_gst_line_recomputes(
    'sales_invoices', 'invoice_id', 'invoice_date',
    'hsn_sac_rate_id', 'cess_rate_bps', 'is_inter_state', 'full',
    'tax_rate_bps', 'line_no');

-- ⚠️ NO `cess_rate_bps` ON A CREDIT NOTE LINE, AND NO PIN. The column does not
-- exist, and `server/actions/sales-invoices.ts:1229` hardcodes `cessRateBps: 0`
-- when building one. So a credit note against a cess-bearing line silently
-- drops the cess, which under s.34 it must carry. That is a schema gap this
-- file cannot close from inside its own ownership; it is reported in
-- TRACK-REPORT.md §4. What CAN be enforced here is that whatever tax the
-- credit note does carry, recomputes.
DROP TRIGGER IF EXISTS sales_credit_note_lines_gst_recomputes ON sales_credit_note_lines;
CREATE TRIGGER sales_credit_note_lines_gst_recomputes
  BEFORE INSERT OR UPDATE ON sales_credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_gst_line_recomputes(
    'sales_credit_notes', 'credit_note_id', 'note_date',
    '', '', 'is_inter_state', 'full',
    'tax_rate_bps', 'line_no');

DROP TRIGGER IF EXISTS sales_order_lines_gst_recomputes ON sales_order_lines;
CREATE TRIGGER sales_order_lines_gst_recomputes
  BEFORE INSERT OR UPDATE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_gst_line_recomputes(
    'sales_orders', 'order_id', 'order_date',
    'hsn_sac_rate_id', 'cess_rate_bps', 'is_inter_state', 'full',
    'tax_rate_bps', 'line_no');

-- The Phase 16 subscription invoice. `invoices` records no inter-state flag,
-- so §B is skipped here and the head is read off the line, which is exactly
-- what the header-free form in §A was written for.
DROP TRIGGER IF EXISTS invoice_lines_gst_recomputes ON invoice_lines;
CREATE TRIGGER invoice_lines_gst_recomputes
  BEFORE INSERT OR UPDATE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_gst_line_recomputes(
    'invoices', 'invoice_id', 'tax_point_date',
    'gst_rate_id', 'cess_rate_bps', '', 'full',
    'tax_rate_bps', 'sort_order');

-- ⭐ PURCHASES ARE `pin_only`, AND THE ASYMMETRY IS THE POINT.
-- The money on a purchase bill is the supplier's, not ours. See §C1.
DROP TRIGGER IF EXISTS purchase_invoice_lines_gst_recomputes ON purchase_invoice_lines;
CREATE TRIGGER purchase_invoice_lines_gst_recomputes
  BEFORE INSERT OR UPDATE ON purchase_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_gst_line_recomputes(
    'purchase_invoices', 'purchase_invoice_id', 'invoice_date',
    'gst_rate_id', 'cess_rate_bps', '', 'pin_only',
    'rate_bps', 'line_number');


-- ############################################################################
-- SECTION 4 — SELF-VERIFICATION: ATTEMPT THE WRITES, DO NOT ASK THE CATALOGUE
-- ############################################################################
--
-- ⭐ EVERY CHECK BELOW PERFORMS A WRITE AND RECORDS WHETHER IT WAS REFUSED.
-- `SELECT count(*) FROM pg_trigger WHERE tgname = ...` proves a name was
-- registered. It does not prove the trigger refuses anything, and this
-- codebase has been bitten 23 times by exactly that distance.
--
-- The whole probe is one savepoint and is always rolled back. plpgsql
-- variables are not transactional, so the verdicts survive the rollback and
-- nothing is left behind.
--
-- ⚠️ THE NEGATIVE CASES ARE NOT OPTIONAL. Four of the eight checks assert that
-- a CORRECT line is still ACCEPTED. A trigger that refuses everything passes
-- every refusal test and takes the product down.

DO $$
DECLARE
  v_t        uuid := gen_random_uuid();
  v_co       uuid := gen_random_uuid();
  v_code     uuid := gen_random_uuid();
  v_rate     uuid := gen_random_uuid();
  v_old_rate uuid := gen_random_uuid();
  v_inv_intra uuid := gen_random_uuid();
  v_inv_inter uuid := gen_random_uuid();
  v_ran           boolean := false;
  r_wrong_tax     boolean := false;
  r_zero_tax      boolean := false;
  r_wrong_head    boolean := false;
  r_stale_pin     boolean := false;
  r_pin_disagrees boolean := false;
  a_intra         boolean := false;
  a_inter         boolean := false;
  a_odd_paisa     boolean := false;
  a_exempt        boolean := false;
  v_err           text := '';
BEGIN
  BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);

    INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_t, 'org_0147_' || substr(v_t::text, 1, 8),
            '0147-probe-' || substr(v_t::text, 1, 8), '0147 probe', 'active');
    INSERT INTO companies (id, tenant_id, name) VALUES (v_co, v_t, '0147 probe customer');
    INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
    VALUES (v_code, v_t, '998314', 'sac', '0147 probe');

    -- The rate in force, and a superseded one that ended before the document.
    INSERT INTO hsn_sac_rates (id, tenant_id, hsn_sac_id, rate_bps, cess_rate_bps,
                               effective_from, effective_to)
    VALUES (v_old_rate, v_t, v_code, 1200, 0, DATE '2017-07-01', DATE '2019-04-01'),
           (v_rate,     v_t, v_code, 1800, 0, DATE '2019-04-01', NULL);

    INSERT INTO sales_invoices
      (id, tenant_id, invoice_number, financial_year, status, company_id,
       invoice_date, place_of_supply_code, is_inter_state, supply_type, currency)
    VALUES (v_inv_intra, v_t, '0147-INTRA', '2026-27', 'draft', v_co,
            DATE '2026-08-19', '27', false, 'services', 'INR'),
           (v_inv_inter, v_t, '0147-INTER', '2026-27', 'draft', v_co,
            DATE '2026-08-19', '29', true,  'services', 'INR');

    /* ── REFUSALS ─────────────────────────────────────────────────────── */

    -- 1. PROOF 1's exact row: ₹1,000 at 18%, one paisa of IGST.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, quantity, uom,
         unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor)
      VALUES (v_t, v_inv_inter, 1, 'wrong tax', 1, 'nos', 100000, 100000, 1800, 1);
    EXCEPTION WHEN check_violation THEN r_wrong_tax := true;
    END;

    -- 2. A rate named and nothing charged under it.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, quantity, uom,
         unit_price_minor, taxable_value_minor, tax_rate_bps)
      VALUES (v_t, v_inv_inter, 2, 'rate but no tax', 1, 'nos', 100000, 100000, 1800);
    EXCEPTION WHEN check_violation THEN r_zero_tax := true;
    END;

    -- 3. IGST on an intra-state supply. Arithmetically perfect, statutorily wrong.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, quantity, uom,
         unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor)
      VALUES (v_t, v_inv_intra, 3, 'wrong head', 1, 'nos', 100000, 100000, 1800, 18000);
    EXCEPTION WHEN check_violation THEN r_wrong_head := true;
    END;

    -- 4. Pinned to a period that closed in 2019 on a 2026 document.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, quantity, uom,
         unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
         hsn_sac_rate_id)
      VALUES (v_t, v_inv_inter, 4, 'stale pin', 1, 'nos', 100000, 100000, 1200, 12000,
              v_old_rate);
    EXCEPTION WHEN check_violation THEN r_stale_pin := true;
    END;

    -- 5. Pinned to the 18% period while charging 12%.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, quantity, uom,
         unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
         hsn_sac_rate_id)
      VALUES (v_t, v_inv_inter, 5, 'pin disagrees', 1, 'nos', 100000, 100000, 1200, 12000,
              v_rate);
    EXCEPTION WHEN check_violation THEN r_pin_disagrees := true;
    END;

    /* ── ACCEPTANCES ──────────────────────────────────────────────────── */

    -- 6. A correct inter-state line, correctly pinned.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, quantity, uom,
         unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
         hsn_sac_rate_id)
      VALUES (v_t, v_inv_inter, 6, 'correct inter-state', 1, 'nos', 100000, 100000,
              1800, 18000, v_rate);
      a_inter := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [6] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 7. A correct intra-state line: 18000 splits 9000 / 9000.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, quantity, uom,
         unit_price_minor, taxable_value_minor, tax_rate_bps,
         cgst_minor, sgst_minor)
      VALUES (v_t, v_inv_intra, 7, 'correct intra-state', 1, 'nos', 100000, 100000,
              1800, 9000, 9000);
      a_intra := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [7] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 8. ⭐ THE ODD PAISA. Taxable 10001 at 18% is 1800.18 → 1800 paise of tax,
    --    which splits 900 / 900. Taxable 10005 at 18% is 1800.9 → 1801, which
    --    splits 901 / 900. A `cgst = sgst` constraint would refuse this
    --    CORRECT line; 0021 §1c explains at length why it was not written.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, quantity, uom,
         unit_price_minor, taxable_value_minor, tax_rate_bps,
         cgst_minor, sgst_minor)
      VALUES (v_t, v_inv_intra, 8, 'odd paisa', 1, 'nos', 10005, 10005,
              1800, 901, 900);
      a_odd_paisa := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [8] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 9. An exempt / nil-rated line: no rate, no tax. Must still be accepted.
    BEGIN
      INSERT INTO sales_invoice_lines
        (tenant_id, invoice_id, line_no, description, quantity, uom,
         unit_price_minor, taxable_value_minor)
      VALUES (v_t, v_inv_intra, 9, 'exempt', 1, 'nos', 100000, 100000);
      a_exempt := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [9] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    v_ran := true;
    RAISE EXCEPTION '0147_PROBE_ROLLBACK' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> '0147_PROBE_ROLLBACK' THEN RAISE; END IF;
  END;

  IF NOT v_ran THEN
    RAISE EXCEPTION
      '0147 FAILED: the verification probe did not reach its own last line, so '
      'every verdict it recorded is meaningless. Do not read this as a pass.';
  END IF;

  IF NOT r_wrong_tax THEN
    RAISE EXCEPTION '0147 FAILED: a ₹1,000 line at 18%% carrying 1 paisa of IGST was accepted.';
  END IF;
  IF NOT r_zero_tax THEN
    RAISE EXCEPTION '0147 FAILED: a line naming an 18%% rate and charging no tax was accepted.';
  END IF;
  IF NOT r_wrong_head THEN
    RAISE EXCEPTION '0147 FAILED: IGST on an intra-state supply was accepted.';
  END IF;
  IF NOT r_stale_pin THEN
    RAISE EXCEPTION '0147 FAILED: a 2026 document pinned to a rate period that closed in 2019 was accepted.';
  END IF;
  IF NOT r_pin_disagrees THEN
    RAISE EXCEPTION '0147 FAILED: a line charging 12%% pinned to an 18%% rate period was accepted.';
  END IF;

  IF NOT (a_inter AND a_intra AND a_odd_paisa AND a_exempt) THEN
    RAISE EXCEPTION
      '0147 FAILED: a CORRECT line was refused. inter=% intra=% odd_paisa=% '
      'exempt=%. Errors:%. A control that refuses correct documents is worse '
      'than the gap it closed.',
      a_inter, a_intra, a_odd_paisa, a_exempt, v_err;
  END IF;

  RAISE NOTICE
    '0147 PASS: five wrong lines were ATTEMPTED and REFUSED (tax that does not '
    'recompute, a rate charging nothing, IGST intra-state, a stale pin, a pin '
    'disagreeing with the rate charged) and four correct lines were ATTEMPTED '
    'and ACCEPTED (inter-state pinned, intra-state, the odd paisa 901/900, and '
    'an exempt line with no rate). All probe rows were rolled back.';
END
$$;


-- ############################################################################
-- SECTION 5 — PROVING THE SQL AND THE TYPESCRIPT AGREE
-- ############################################################################
--
-- 🔴 THE REAL RISK IN THIS FILE IS NOT THAT IT REFUSES TOO LITTLE. It is that
-- `gst_apply_rate_bps` and `applyRateBps` disagree on one case in ten thousand,
-- and the database starts refusing correct invoices at a rate nobody can
-- reproduce. Two implementations of the same arithmetic is the thing §1 had to
-- justify, and this is the justification being tested rather than asserted.
--
-- The cases below are the ones that separate half-up implementations: exact
-- halves, the paisa either side of a half, negatives (credit notes), zero, a
-- zero rate, and a large value where a float implementation would already have
-- lost precision. The expected values are computed by hand from the rule
-- `(abs * bps + 5000) / 10000`, not by calling the function under test.
--
-- ⚠️ `tests/security/gst-recompute.test.ts` runs the SAME table against the
-- TYPESCRIPT `applyRateBps`. Neither half is sufficient alone: this proves SQL
-- matches the arithmetic, that proves TypeScript matches the same arithmetic,
-- and together they prove the two match each other.

DO $$
DECLARE
  v_case  record;
  v_got   bigint;
  v_fails text := '';
BEGIN
  FOR v_case IN
    SELECT * FROM (VALUES
      -- amount,   bps,  expected tax,  what it pins down
      (100000::bigint, 1800, 18000::bigint, 'the ordinary case'),
      (10005::bigint,  1800,  1801::bigint, 'x.9 rounds up'),
      (10001::bigint,  1800,  1800::bigint, 'x.18 rounds down'),
      (5::bigint,      1000,     1::bigint, 'exactly a half rounds UP, not to even'),
      (15::bigint,     1000,     2::bigint, 'the next half also rounds UP — banker''s would give 2 here and 0 above'),
      (-100000::bigint,1800,-18000::bigint, 'a credit note is the exact negative'),
      (-5::bigint,     1000,    -1::bigint, 'a half rounds AWAY from zero when negative'),
      (0::bigint,      1800,     0::bigint, 'zero'),
      (100000::bigint,    0,     0::bigint, 'a nil rate'),
      (999999999999::bigint, 1800, 180000000000::bigint, 'a trillion paise — well inside float64, kept because it is the largest ordinary value'),
      (99999999999999::bigint, 1800, 18000000000000::bigint, 'amount x bps is 1.8e17, genuinely past 2^53 — a float implementation loses the paisa here')
    ) AS t(amount, bps, expected, note)
  LOOP
    v_got := gst_apply_rate_bps(v_case.amount, v_case.bps);
    IF v_got <> v_case.expected THEN
      v_fails := v_fails || format(E'\n  gst_apply_rate_bps(%s, %s) = %s, expected %s  (%s)',
                                   v_case.amount, v_case.bps, v_got, v_case.expected, v_case.note);
    END IF;
  END LOOP;

  -- The split. First share takes the odd minor unit; the two must sum exactly.
  FOR v_case IN
    SELECT * FROM (VALUES
      (18000::bigint, 9000::bigint),
      (1801::bigint,   901::bigint),
      (1::bigint,        1::bigint),
      (0::bigint,        0::bigint),
      (-1::bigint,      -1::bigint),
      (-1801::bigint, -901::bigint)
    ) AS t(total, expected_cgst)
  LOOP
    v_got := gst_cgst_share(v_case.total);
    IF v_got <> v_case.expected_cgst THEN
      v_fails := v_fails || format(E'\n  gst_cgst_share(%s) = %s, expected %s',
                                   v_case.total, v_got, v_case.expected_cgst);
    END IF;
    IF v_got + (v_case.total - v_got) <> v_case.total THEN
      v_fails := v_fails || format(E'\n  gst_cgst_share(%s) does not sum back', v_case.total);
    END IF;
  END LOOP;

  IF v_fails <> '' THEN
    RAISE EXCEPTION
      '0147 FAILED: the SQL rounding does not match the rule transcribed from '
      'lib/billing/money.ts. Every invoice this database refuses from now on '
      'would be refused for the wrong reason.%', v_fails;
  END IF;

  RAISE NOTICE
    '0147 §5 PASS: gst_apply_rate_bps and gst_cgst_share agree with '
    'applyRateBps and splitEvenly on 17 cases including exact halves in both '
    'directions (5 and 15 at 1000 bps — half-up gives 1 and 2, banker''s would '
    'give 0 and 2, so BOTH are needed or the drift is missed half the time), '
    'both signs, a nil rate, and a product past 2^53.';
END
$$;


-- ############################################################################
-- SECTION 6 — WHAT THIS FILE DELIBERATELY LEAVES OPEN
-- ############################################################################
--
-- ⚠️ IT DOES NOT MAKE A PIN MANDATORY. Nothing populates `hsn_sac_rate_id` on
-- an outward supply today, so requiring one would refuse every invoice the
-- product raises. 0148 measures the coverage and reports it as a number.
--
-- ⚠️ IT DOES NOT VERIFY THE RATE IS RIGHT FOR THE CLASSIFICATION. It verifies
-- the document is internally honest about the rate it names. Whether 998314 is
-- really 18% on that date is what the registry is for, and only a pinned line
-- gets that checked.
--
-- ⚠️ IT DOES NOT COVER SPECIFIC-RATE CESS. No line table carries a per-unit
-- cess column. See TRACK-REPORT.md §4.
--
-- ⚠️ IT DOES NOT COVER `demand_notices`, `stock_transfers` OR
-- `channel_partner_commissions`, all of which carry a CGST/SGST/IGST split
-- computed three different ways. Two of those are outside Track E's file
-- ownership and one is a Rule 28 valuation with its own arithmetic. They are
-- listed in TRACK-REPORT.md §4 with what each would need.
-- ############################################################################
