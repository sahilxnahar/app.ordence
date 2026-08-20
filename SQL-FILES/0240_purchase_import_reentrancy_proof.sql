-- ############################################################################
-- 0240 — PHASE 6: THE TWO INDEXES THE PURCHASE IMPORT'S RE-RUN SAFETY RESTS ON
-- ############################################################################
--
-- Ordence · v1.85.0-alpha · Phase 6 (entities: purchases)
-- Block 0240–0249 is reserved to this phase in scripts/track-ownership.json.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE ADDS NO TABLE AND NO COLUMN
-- ══════════════════════════════════════════════════════════════════════════
-- Phase 6 imports into two tables that already exist. It needs no schema
-- change, and inventing one to fill a reserved block would be worse than
-- using none of it.
--
-- What it does need is a GUARANTEE, and the guarantee is not the importer's.
-- "A re-run of the whole file creates nothing the second time" is the single
-- most important property in this track, and the importer's contribution to
-- it is a courtesy: `findExisting` looks the row up and reports a readable
-- outcome. What actually makes two people pressing the button at once safe —
-- and what makes the property survive a bug in the importer — is a UNIQUE
-- INDEX in the database. There are two:
--
--   vendors_code_tenant_unique          UNIQUE (tenant_id, code)
--   purchase_invoices_no_duplicate_bill UNIQUE (tenant_id, vendor_id,
--                                              upper(btrim(invoice_number)),
--                                              indian_financial_year(invoice_date))
--                                       WHERE status <> 'cancelled'
--
-- ⚠️ AND `SELECT ... FROM pg_indexes WHERE indexname = ...` DOES NOT PROVE
--    EITHER OF THEM. It proves a NAME was registered. 0147 §4 makes the same
--    argument and says this codebase "has been bitten 23 times by exactly that
--    distance". An index can exist, be `NOT VALID`-adjacent, be on the wrong
--    expression, or have had its predicate widened by a later migration, and
--    the catalogue query passes every time.
--
-- ⭐ SO EVERY CHECK BELOW ATTEMPTS THE WRITE AND RECORDS WHETHER IT WAS
--    REFUSED. The whole probe is one sub-transaction and is always rolled
--    back; plpgsql variables are not transactional, so the verdicts survive
--    the rollback and nothing is left behind.
--
-- ⚠️ THE ACCEPTANCES ARE NOT OPTIONAL. Three of the seven checks assert that
--    a LEGITIMATE row is still ACCEPTED. An index that refused everything
--    would pass every refusal test and take the product down — and two of
--    these three are cases the importer deliberately treats differently from
--    the database, which is exactly where a wrong assumption would hide.
--
-- ⚠️ IDEMPOTENT AND READ-ONLY IN EFFECT. Running it twice does the same
--    thing twice and changes nothing either time. It is safe on production
--    and it is meant to be run there, because the index it is asserting
--    about is production's.
--
-- ############################################################################

DO $$
DECLARE
  v_t            uuid := gen_random_uuid();
  v_vendor       uuid := gen_random_uuid();
  v_vendor_alt   uuid := gen_random_uuid();
  v_bill         uuid := gen_random_uuid();
  v_cancelled    uuid := gen_random_uuid();
  v_ran          boolean := false;

  -- Refusals we require.
  r_vendor_code_twice     boolean := false;
  r_bill_twice            boolean := false;
  r_bill_case_and_space   boolean := false;

  -- Acceptances we require.
  a_same_serial_next_fy   boolean := false;
  a_after_cancellation    boolean := false;
  a_vendor_code_case      boolean := false;
  a_bill_other_vendor     boolean := false;

  v_err text := '';
BEGIN
  BEGIN
    /*
     * ⚠️ PLATFORM SCOPE, FOR THE SAME REASON 0147's PROBE SETS IT: the
     * probe creates its own tenant and must be able to write into it
     * before any `app.tenant_id` has been established. It is set LOCAL
     * (third argument `true`), so it dies with this sub-transaction.
     */
    PERFORM set_config('app.platform_scope', 'on', true);

    INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_t, 'org_0240_' || substr(v_t::text, 1, 8),
            '0240-probe-' || substr(v_t::text, 1, 8), '0240 probe', 'active');

    INSERT INTO vendors (id, tenant_id, code, legal_name)
    VALUES (v_vendor, v_t, 'V-0240', '0240 probe vendor');

    /* ══════════════════════════════════════════════════════════════════
     * A. THE VENDOR CODE IS UNIQUE PER WORKSPACE
     * ══════════════════════════════════════════════════════════════════
     * `lib/import/entities-purchases.ts` keys the `vendors` entity on the
     * code alone. If this index is not there, a re-run of a vendor master
     * creates every vendor a second time and a CRM with every supplier in
     * it twice cannot be cleaned up without deciding, per pair, which copy
     * the bills point at.
     */
    BEGIN
      INSERT INTO vendors (id, tenant_id, code, legal_name)
      VALUES (gen_random_uuid(), v_t, 'V-0240', 'the same vendor again');
    EXCEPTION WHEN unique_violation THEN r_vendor_code_twice := true;
    END;

    /*
     * ⚠️ AND THE INDEX IS CASE-SENSITIVE, WHICH THE IMPORTER IS NOT.
     *
     * This acceptance is the one that would surprise somebody reading only
     * the importer. `vendors_code_tenant_unique` is on the raw `code`, so
     * Postgres considers `v-0240` a DIFFERENT vendor from `V-0240` and
     * accepts it. `naturalKey` in the entity lower-cases, so the importer
     * treats the two spellings as one vendor and refuses the second row
     * INSIDE THE FILE with a message naming the first.
     *
     * 🔴 THE IMPORTER IS DELIBERATELY STRICTER THAN THE DATABASE HERE, AND
     *    THAT IS THE SAFE DIRECTION. Two vendors whose codes differ only in
     *    case are indistinguishable on a payment run. Proving the database
     *    would have allowed it is what makes the importer's extra strictness
     *    a decision rather than an accident — and it is why
     *    `resolveLookups`' `vendor_by_code` matches on `lower(code)` too, so
     *    a bill quoting either spelling reaches one vendor rather than
     *    failing ambiguously.
     */
    BEGIN
      INSERT INTO vendors (id, tenant_id, code, legal_name)
      VALUES (v_vendor_alt, v_t, 'v-0240', 'lower-case code, a different row');
      a_vendor_code_case := true;
    EXCEPTION WHEN unique_violation THEN a_vendor_code_case := false;
    END;

    /* ══════════════════════════════════════════════════════════════════
     * B. THE BILL IS UNIQUE PER VENDOR PER FINANCIAL YEAR
     * ══════════════════════════════════════════════════════════════════
     * Totals are left at their defaults so `purchase_invoices_totals_balance`
     * and `purchase_invoices_itc_splits_exactly` hold trivially (0 = 0 - 0,
     * and 0 + 0 = 0 + 0 + 0 + 0). This probe is about the identity, not the
     * arithmetic; 0147 §4 already proves the arithmetic.
     */
    INSERT INTO purchase_invoices
      (id, tenant_id, vendor_id, invoice_number, invoice_date, status)
    VALUES (v_bill, v_t, v_vendor, 'INV-001', DATE '2024-06-15', 'recorded');

    BEGIN
      INSERT INTO purchase_invoices
        (id, tenant_id, vendor_id, invoice_number, invoice_date, status)
      VALUES (gen_random_uuid(), v_t, v_vendor, 'INV-001', DATE '2024-09-20', 'recorded');
    EXCEPTION WHEN unique_violation THEN r_bill_twice := true;
    END;

    /*
     * ⚠️ THE INDEX IS ON `upper(btrim(invoice_number))`, NOT ON THE COLUMN.
     *
     * This is the check that would catch a later migration quietly
     * rebuilding the index on the bare column — after which " inv-001 " out
     * of a spreadsheet would import as a SECOND bill, the payment run would
     * pay it, and the vendor would be paid twice for one supply. The
     * importer mirrors the expression exactly in `naturalKey` and in
     * `findExisting`; this proves the expression is still what they mirror.
     */
    BEGIN
      INSERT INTO purchase_invoices
        (id, tenant_id, vendor_id, invoice_number, invoice_date, status)
      VALUES (gen_random_uuid(), v_t, v_vendor, '  inv-001 ', DATE '2024-11-02', 'recorded');
    EXCEPTION WHEN unique_violation THEN r_bill_case_and_space := true;
    END;

    /*
     * ⚠️ THE SAME SERIAL IN THE NEXT FINANCIAL YEAR IS A DIFFERENT BILL,
     * AND THIS ACCEPTANCE IS WHY THE KEY CARRIES THE YEAR AT ALL.
     *
     * Rule 46(b) makes a vendor's serial unique for a financial year, not
     * for ever. A vendor who restarts at 001 every April is normal, and an
     * index without the year would refuse their second year of bills —
     * which is an outage arriving on 1 April, on the day nobody can afford
     * one. 15 June 2024 is FY 2024-25; 15 June 2025 is FY 2025-26.
     */
    BEGIN
      INSERT INTO purchase_invoices
        (id, tenant_id, vendor_id, invoice_number, invoice_date, status)
      VALUES (gen_random_uuid(), v_t, v_vendor, 'INV-001', DATE '2025-06-15', 'recorded');
      a_same_serial_next_fy := true;
    EXCEPTION WHEN unique_violation THEN a_same_serial_next_fy := false;
    END;

    /*
     * ⚠️ A CANCELLED BILL DOES NOT OCCUPY ITS NUMBER, AND
     * `purchaseInvoicesWriter.findExisting` MIRRORS THAT WITH
     * `ne(status, 'cancelled')`.
     *
     * 🔴 THIS IS THE ONE THE IMPORTER WOULD GET WRONG BY DEFAULT. Without
     *    the `status <> 'cancelled'` filter in `findExisting`, a customer
     *    re-entering a bill they had voided would be told "already
     *    imported, skipped" — in the PREVIEW, which they would believe —
     *    and the bill would never land. The index's predicate is what makes
     *    that filter correct rather than a guess, so it is proved here.
     */
    INSERT INTO purchase_invoices
      (id, tenant_id, vendor_id, invoice_number, invoice_date, status)
    VALUES (v_cancelled, v_t, v_vendor, 'INV-777', DATE '2024-06-15', 'cancelled');

    BEGIN
      INSERT INTO purchase_invoices
        (id, tenant_id, vendor_id, invoice_number, invoice_date, status)
      VALUES (gen_random_uuid(), v_t, v_vendor, 'INV-777', DATE '2024-06-15', 'recorded');
      a_after_cancellation := true;
    EXCEPTION WHEN unique_violation THEN a_after_cancellation := false;
    END;

    /*
     * ⚠️ THE VENDOR IS IN THE KEY. Two suppliers both numbering their bills
     * INV-001 is the ordinary case, not an edge case, and an index keyed on
     * the number alone would refuse the second supplier's entire ledger.
     * The importer's natural key carries the vendor code for the same
     * reason.
     */
    BEGIN
      INSERT INTO purchase_invoices
        (id, tenant_id, vendor_id, invoice_number, invoice_date, status)
      VALUES (gen_random_uuid(), v_t, v_vendor_alt, 'INV-001', DATE '2024-06-15', 'recorded');
      a_bill_other_vendor := true;
    EXCEPTION WHEN unique_violation THEN a_bill_other_vendor := false;
    END;

    v_ran := true;

    /*
     * ⚠️ THE ROLLBACK IS A DELIBERATE EXCEPTION, NOT A `ROLLBACK`
     * STATEMENT — plpgsql cannot issue one inside a DO block. This is the
     * same mechanism 0147 §4 uses, and the sentinel is matched by text so
     * that a REAL error from any statement above is re-raised rather than
     * swallowed into a silent pass.
     */
    RAISE EXCEPTION '0240_PROBE_ROLLBACK' USING ERRCODE = 'P0001';

  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> '0240_PROBE_ROLLBACK' THEN
      v_err := SQLERRM;
      RAISE EXCEPTION
        '0240 FAILED: the probe could not run, so nothing below was proved. %',
        v_err;
    END IF;
  END;

  IF NOT v_ran THEN
    RAISE EXCEPTION
      '0240 FAILED: the probe did not reach its own end. Every verdict below '
      'is therefore the initial FALSE and would have been reported as a '
      'refusal that never happened. This is the floor refusing to pass.';
  END IF;

  /* ── THE REFUSALS ────────────────────────────────────────────────── */

  IF NOT r_vendor_code_twice THEN
    RAISE EXCEPTION
      '0240 FAILED: a second vendor with the code V-0240 was ACCEPTED. '
      'vendors_code_tenant_unique is not enforcing, so re-running a vendor '
      'import duplicates every vendor and the bills cannot be told apart.';
  END IF;

  IF NOT r_bill_twice THEN
    RAISE EXCEPTION
      '0240 FAILED: the same vendor''s bill INV-001 was accepted twice in one '
      'financial year. purchase_invoices_no_duplicate_bill is not enforcing. '
      'Entering a bill twice claims the input tax credit twice and pays the '
      'vendor twice, and re-uploading the file is the normal second action.';
  END IF;

  IF NOT r_bill_case_and_space THEN
    RAISE EXCEPTION
      '0240 FAILED: "  inv-001 " was accepted alongside "INV-001". The index '
      'is no longer on upper(btrim(invoice_number)), so a bill number with a '
      'trailing space — which is most of them, out of a spreadsheet — is a '
      'second bill. The importer mirrors that expression and now mirrors '
      'nothing.';
  END IF;

  /* ── THE ACCEPTANCES ─────────────────────────────────────────────── */

  IF NOT a_vendor_code_case THEN
    RAISE EXCEPTION
      '0240 FAILED: "v-0240" was REFUSED alongside "V-0240". '
      'vendors_code_tenant_unique has become case-insensitive. That is not '
      'harmful in itself, but the vendors entity lower-cases its natural key '
      'on the stated understanding that it is being STRICTER than the '
      'database. The comment in lib/import/entities-purchases.ts is now '
      'wrong, and a wrong comment about a key is how the next author '
      'removes the lower-casing.';
  END IF;

  IF NOT a_same_serial_next_fy THEN
    RAISE EXCEPTION
      '0240 FAILED: the same serial in the NEXT financial year was refused. '
      'indian_financial_year() has left the index or has stopped moving at 1 '
      'April. Every vendor who restarts numbering each April is now unable '
      'to have their second year of bills entered.';
  END IF;

  IF NOT a_after_cancellation THEN
    RAISE EXCEPTION
      '0240 FAILED: a bill could not be re-entered after the first was '
      'cancelled. The index has lost its WHERE status <> ''cancelled'' '
      'predicate. purchaseInvoicesWriter.findExisting excludes cancelled '
      'bills to match it; that exclusion is now wrong in the other '
      'direction and the customer will be told a bill was imported when it '
      'was refused.';
  END IF;

  IF NOT a_bill_other_vendor THEN
    RAISE EXCEPTION
      '0240 FAILED: a DIFFERENT vendor''s INV-001 was refused. The vendor has '
      'left the index. Two suppliers both numbering from 001 is the ordinary '
      'case and the second supplier''s whole ledger is now unenterable.';
  END IF;

  RAISE NOTICE
    '0240 OK — seven writes attempted. Refused: a duplicate vendor code, a '
    'duplicate bill in one financial year, and the same bill number differing '
    'only in case and spacing. Accepted: a code differing only in case (the '
    'importer is stricter on purpose), the same serial in the next financial '
    'year, a re-entry after cancellation, and another vendor''s INV-001. '
    'Nothing was left behind.';
END $$;
