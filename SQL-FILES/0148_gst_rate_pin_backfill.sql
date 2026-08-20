-- ############################################################################
-- 0148 — BACKFILL THE RATE PIN WHERE IT IS RECOVERABLE, AND NAME EVERY ROW
--        WHERE IT IS NOT
--        (Wave 15 / Track E — GST, TDS and statutory correctness)
-- ############################################################################
--
-- WHY THIS FILE EXISTS
-- -------------------
-- 0146 made a rate pin tenant-true and 0147 made it mean something. Neither
-- put one on an existing row. Almost every outward-supply line in this product
-- has `hsn_sac_rate_id IS NULL`, because no code path has ever resolved one.
--
-- 🔴 AND A BACKFILL IS EXACTLY WHERE AN ERP LIES TO ITS CUSTOMER. Recomputing
-- historical tax at today's rates is the classic version: rates change, the
-- rate in force on the invoice date governs, and a sweep that assumes
-- otherwise silently restates documents that have already been filed. The
-- resulting figures look identical to real ones and are not.
--
-- ⭐ SO THIS FILE PINS ONLY WHERE PINNING IS IDENTIFICATION, NOT INFERENCE.
-- A line is pinned only when all four hold:
--
--   1. the line names a classification (`hsn_sac_code_id`),
--   2. exactly one rate period for that classification covers the DOCUMENT'S
--      OWN date,
--   3. that period's `rate_bps` and `cess_rate_bps` EQUAL what the line
--      already charged, and
--   4. the document is still a draft, so writing to it is legal.
--
-- Under those four the pin does not change a single figure. It records which
-- row already produced the figure that is there. Anything else is marked and
-- left alone, and the marking says which of the four failed.
--
-- ⚠️ THE MARKING IS A VIEW, NOT A COLUMN, AND THAT IS A DECISION WITH A COST.
-- Every line table in this product freezes once its document leaves draft
-- (`sales_invoice_line_freeze`, `prevent_issued_invoice_line_change`,
-- `ordence_freeze_confirmed_order_line`). An issued invoice's line cannot be
-- UPDATEd at all — which means a stored `unbackfillable` marker could not be
-- written onto the very rows that most need one, and the only way to write it
-- would be to weaken a freeze guard. This codebase's rule 3 is "never fix an
-- error by deleting a guard".
--
-- The cost of the view is that it reports the verdict as at the moment you ask,
-- not as at the migration. If a rate period is added tomorrow, a line that
-- reads `no_rate_in_force` today reads `pinnable` tomorrow. For this purpose
-- that is the more useful answer — it is a worklist, and the point of a
-- worklist is that it shrinks. The as-at-migration snapshot is preserved in
-- this file's own NOTICE output, which is permanent.
--
-- IS THERE DATA LOSS? No. The only write is setting `hsn_sac_rate_id` on draft
-- lines that already agree with the registry. No money moves. `gst_computed`
-- is deliberately NOT set — see §5.
--
-- RUN ORDER: after 0146 and 0147, which it depends on. Code push order does
-- not matter.
-- ############################################################################


-- ############################################################################
-- SECTION 1 — THE CLASSIFICATION, AS A VIEW
-- ############################################################################
--
-- ⚠️ `security_invoker = true`. Without it the view runs as its owner and
-- every tenant reads every tenant's worklist. RLS on the underlying tables is
-- the entire tenant boundary in this product; a view that switches it off is a
-- hole with a friendly name.
--
-- One row per outward-supply line, with a verdict and the two rates that
-- produced it, so the reason is legible without a second query.

CREATE OR REPLACE VIEW gst_rate_pin_status
WITH (security_invoker = true)
AS
WITH lines AS (
  SELECT l.tenant_id,
         'sales_invoice_lines'::varchar(40) AS document_table,
         l.id                               AS document_line_id,
         l.invoice_id                       AS document_id,
         i.invoice_number                   AS document_number,
         i.invoice_date                     AS document_date,
         (i.status = 'draft')               AS document_is_draft,
         l.line_no,
         l.hsn_sac_code_id,
         l.hsn_sac_rate_id,
         COALESCE(l.tax_rate_bps, 0)        AS charged_rate_bps,
         COALESCE(l.cess_rate_bps, 0)       AS charged_cess_bps,
         (l.cgst_minor + l.sgst_minor + l.igst_minor + l.cess_minor) AS tax_minor
    FROM sales_invoice_lines l
    JOIN sales_invoices i ON i.id = l.invoice_id

  UNION ALL

  SELECT l.tenant_id,
         'sales_order_lines'::varchar(40),
         l.id, l.order_id, o.order_no, o.order_date,
         (o.status = 'draft'),
         l.line_no, l.hsn_sac_code_id, l.hsn_sac_rate_id,
         COALESCE(l.tax_rate_bps, 0), COALESCE(l.cess_rate_bps, 0),
         (l.cgst_minor + l.sgst_minor + l.igst_minor + l.cess_minor)
    FROM sales_order_lines l
    JOIN sales_orders o ON o.id = l.order_id
),
resolved AS (
  SELECT ln.*,
         r.id            AS candidate_rate_id,
         r.rate_bps      AS registry_rate_bps,
         r.cess_rate_bps AS registry_cess_bps,
         r.effective_from,
         r.effective_to
    FROM lines ln
    LEFT JOIN hsn_sac_rates r
           ON r.tenant_id  = ln.tenant_id
          AND r.hsn_sac_id = ln.hsn_sac_code_id
          AND ln.document_date >= r.effective_from
          AND (r.effective_to IS NULL OR ln.document_date < r.effective_to)
)
SELECT tenant_id, document_table, document_line_id, document_id, document_number,
       document_date, line_no, document_is_draft,
       hsn_sac_code_id, hsn_sac_rate_id,
       charged_rate_bps, charged_cess_bps,
       candidate_rate_id, registry_rate_bps, registry_cess_bps,
       effective_from, effective_to,
       CASE
         WHEN hsn_sac_rate_id IS NOT NULL                    THEN 'already_pinned'
         WHEN tax_minor = 0 AND charged_rate_bps = 0         THEN 'no_tax_to_trace'
         WHEN hsn_sac_code_id IS NULL                        THEN 'unbackfillable_no_classification'
         WHEN candidate_rate_id IS NULL                      THEN 'unbackfillable_no_rate_in_force'
         WHEN registry_rate_bps  IS DISTINCT FROM charged_rate_bps
           OR registry_cess_bps  IS DISTINCT FROM charged_cess_bps
                                                             THEN 'unbackfillable_rate_disagrees'
         WHEN NOT document_is_draft                          THEN 'unbackfillable_document_frozen'
         ELSE 'pinnable'
       END AS verdict
  FROM resolved;

COMMENT ON VIEW gst_rate_pin_status IS
  'One row per outward-supply line with a verdict on whether its rate can be '
  'traced to a registry period. 0148. `pinnable` is a worklist for '
  'gst_backfill_rate_pins(); every `unbackfillable_*` says which of the four '
  'conditions failed. No threshold, no PASS column: this reports a number.';


-- ############################################################################
-- SECTION 2 — THE BACKFILL, AS A RE-RUNNABLE FUNCTION WITH A DRY RUN
-- ############################################################################
--
-- ⚠️ DRY RUN IS THE DEFAULT. `SELECT * FROM gst_backfill_rate_pins()` changes
-- nothing and tells you what it would do. A backfill whose only mode is "go"
-- gets run once by someone who wanted to look.
--
-- ⚠️ SECURITY INVOKER. It writes through RLS, so it can only pin the calling
-- tenant's rows. Making it DEFINER would let one workspace's call rewrite
-- another's documents, and there is no version of that which is worth the
-- convenience of a single-session sweep.

CREATE OR REPLACE FUNCTION gst_backfill_rate_pins(p_commit boolean DEFAULT false)
RETURNS TABLE (verdict text, lines bigint, acted boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pinned_inv bigint := 0;
  v_pinned_ord bigint := 0;
BEGIN
  IF p_commit THEN
    WITH todo AS (
      SELECT s.document_line_id, s.candidate_rate_id
        FROM gst_rate_pin_status s
       WHERE s.verdict = 'pinnable' AND s.document_table = 'sales_invoice_lines'
    )
    UPDATE sales_invoice_lines l
       SET hsn_sac_rate_id = t.candidate_rate_id
      FROM todo t
     WHERE l.id = t.document_line_id;
    GET DIAGNOSTICS v_pinned_inv = ROW_COUNT;

    WITH todo AS (
      SELECT s.document_line_id, s.candidate_rate_id
        FROM gst_rate_pin_status s
       WHERE s.verdict = 'pinnable' AND s.document_table = 'sales_order_lines'
    )
    UPDATE sales_order_lines l
       SET hsn_sac_rate_id = t.candidate_rate_id
      FROM todo t
     WHERE l.id = t.document_line_id;
    GET DIAGNOSTICS v_pinned_ord = ROW_COUNT;
  END IF;

  RETURN QUERY
    SELECT s.verdict::text, count(*)::bigint,
           (p_commit AND s.verdict = 'already_pinned')
      FROM gst_rate_pin_status s
     GROUP BY s.verdict
     ORDER BY s.verdict;

  IF p_commit THEN
    RAISE NOTICE
      'gst_backfill_rate_pins: pinned % sales invoice line(s) and % sales order '
      'line(s). Every one already charged exactly what its registry period says, '
      'so no figure changed. Rows this could not reach are in '
      'gst_rate_pin_status with the reason.',
      v_pinned_inv, v_pinned_ord;
  ELSE
    RAISE NOTICE
      'gst_backfill_rate_pins: DRY RUN. Nothing was written. Call '
      'gst_backfill_rate_pins(true) to act on the `pinnable` rows.';
  END IF;
END;
$$;


-- ############################################################################
-- SECTION 3 — RUN IT, FOR REAL, ONCE, AND RECORD WHAT IT FOUND
-- ############################################################################
--
-- ⭐ THE NOTICE IS THE SNAPSHOT. The view moves as the registry is filled in;
-- this output does not. It is the answer to "what did the tax data look like
-- the day the control went in", which is the question an auditor asks.

DO $$
DECLARE
  v_row      record;
  v_total    bigint := 0;
  v_report   text := '';
BEGIN
  PERFORM set_config('app.platform_scope', 'on', true);

  FOR v_row IN SELECT * FROM gst_backfill_rate_pins(true) LOOP
    v_total  := v_total + v_row.lines;
    v_report := v_report || format(E'\n    %-36s %s', v_row.verdict, v_row.lines);
  END LOOP;

  IF v_total = 0 THEN
    RAISE NOTICE
      '0148 §3: this database holds no outward-supply lines at all, so the '
      'backfill had nothing to visit. That is not a pass and not a failure — '
      'it is an empty database. The controls in 0146 and 0147 still apply to '
      'the first line written.';
  ELSE
    RAISE NOTICE E'0148 §3: backfill run, as at this migration. % line(s):%',
      v_total, v_report;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 4 — SELF-VERIFICATION
-- ############################################################################
--
-- ⭐ A BACKFILL THAT SUCCEEDS WHILE DOING NOTHING IS THE SAME BUG AS THE
-- `count(*) >= 10 THEN 'PASS'` GATE. So this does not check that the function
-- exists. It builds a workspace with one line of each verdict, runs the
-- backfill for real inside a savepoint, and asserts that the ONE resolvable
-- line was pinned and that each of the four unresolvable ones was left alone
-- AND named correctly. Then it rolls the whole thing back.
--
-- ⚠️ THE FOUR NEGATIVE CASES ARE THE POINT. A backfill that pinned all five
-- would pass a "did it pin anything" check and would have invented four rate
-- provenances, which is the failure this file exists to avoid.

DO $$
DECLARE
  v_t     uuid := gen_random_uuid();
  v_co    uuid := gen_random_uuid();
  v_code  uuid := gen_random_uuid();
  v_r18   uuid := gen_random_uuid();
  v_r12   uuid := gen_random_uuid();
  v_inv   uuid := gen_random_uuid();
  v_issued uuid := gen_random_uuid();
  l_ok       uuid := gen_random_uuid();
  l_noclass  uuid := gen_random_uuid();
  l_norate   uuid := gen_random_uuid();
  l_disagree uuid := gen_random_uuid();
  l_frozen   uuid := gen_random_uuid();
  v_ran   boolean := false;
  v_v     jsonb   := '{}'::jsonb;
  v_pin   uuid;
  v_stray bigint;
BEGIN
  BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);

    INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_t, 'org_0148_' || substr(v_t::text, 1, 8),
            '0148-probe-' || substr(v_t::text, 1, 8), '0148 probe', 'active');
    INSERT INTO companies (id, tenant_id, name) VALUES (v_co, v_t, '0148 probe customer');
    INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
    VALUES (v_code, v_t, '998314', 'sac', '0148 probe');

    -- 18% in force on the document date; 12% closed long before it.
    INSERT INTO hsn_sac_rates (id, tenant_id, hsn_sac_id, rate_bps, cess_rate_bps,
                               effective_from, effective_to)
    VALUES (v_r18, v_t, v_code, 1800, 0, DATE '2019-04-01', NULL),
           (v_r12, v_t, v_code, 1200, 0, DATE '2017-07-01', DATE '2019-04-01');

    INSERT INTO sales_invoices
      (id, tenant_id, invoice_number, financial_year, status, company_id,
       invoice_date, place_of_supply_code, is_inter_state, supply_type, currency)
    VALUES (v_inv, v_t, '0148-DRAFT', '2026-27', 'draft', v_co,
            DATE '2026-08-19', '29', true, 'services', 'INR');

    -- 1. RESOLVABLE: classified, an 18% period covers the date, charged 18%.
    INSERT INTO sales_invoice_lines
      (id, tenant_id, invoice_id, line_no, description, quantity, uom,
       unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
       hsn_sac_code_id)
    VALUES (l_ok, v_t, v_inv, 1, 'resolvable', 1, 'nos', 100000, 100000,
            1800, 18000, v_code);

    -- 2. NO CLASSIFICATION: charged tax, names no HSN/SAC.
    INSERT INTO sales_invoice_lines
      (id, tenant_id, invoice_id, line_no, description, quantity, uom,
       unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor)
    VALUES (l_noclass, v_t, v_inv, 2, 'no classification', 1, 'nos', 100000, 100000,
            1800, 18000);

    -- 3. RATE DISAGREES: classified, a period covers the date, but it says 18%
    --    and the document charged 5%. Pinning would assert a provenance the
    --    figure does not have.
    INSERT INTO sales_invoice_lines
      (id, tenant_id, invoice_id, line_no, description, quantity, uom,
       unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
       hsn_sac_code_id)
    VALUES (l_disagree, v_t, v_inv, 3, 'rate disagrees', 1, 'nos', 100000, 100000,
            500, 5000, v_code);

    -- 4. FROZEN DOCUMENT: identical to case 1 but the invoice has been issued.
    INSERT INTO sales_invoices
      (id, tenant_id, invoice_number, financial_year, status, company_id,
       invoice_date, place_of_supply_code, is_inter_state, supply_type, currency,
       issued_at)
    VALUES (v_issued, v_t, '0148-ISSUED', '2026-27', 'draft', v_co,
            DATE '2026-08-19', '29', true, 'services', 'INR', now());
    INSERT INTO sales_invoice_lines
      (id, tenant_id, invoice_id, line_no, description, quantity, uom,
       unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
       hsn_sac_code_id)
    VALUES (l_frozen, v_t, v_issued, 1, 'frozen', 1, 'nos', 100000, 100000,
            1800, 18000, v_code);
    UPDATE sales_invoices SET status = 'issued' WHERE id = v_issued;

    -- 5. NO RATE IN FORCE: a second classification with no period at all.
    INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
    VALUES (l_norate, v_t, '998315', 'sac', '0148 probe, unrated');
    INSERT INTO sales_invoice_lines
      (tenant_id, invoice_id, line_no, description, quantity, uom,
       unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
       hsn_sac_code_id)
    VALUES (v_t, v_inv, 4, 'no rate in force', 1, 'nos', 100000, 100000,
            1800, 18000, l_norate);

    -- ── RUN THE BACKFILL FOR REAL ──────────────────────────────────────
    PERFORM gst_backfill_rate_pins(true);

    SELECT jsonb_object_agg(document_line_id::text, verdict)
      INTO v_v
      FROM gst_rate_pin_status
     WHERE tenant_id = v_t;

    SELECT hsn_sac_rate_id INTO v_pin FROM sales_invoice_lines WHERE id = l_ok;

    SELECT count(*) INTO v_stray
      FROM sales_invoice_lines
     WHERE tenant_id = v_t AND id <> l_ok AND hsn_sac_rate_id IS NOT NULL;

    v_ran := true;
    RAISE EXCEPTION '0148_PROBE_ROLLBACK' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> '0148_PROBE_ROLLBACK' THEN RAISE; END IF;
  END;

  IF NOT v_ran THEN
    RAISE EXCEPTION
      '0148 FAILED: the verification probe did not reach its own last line, so '
      'every verdict it recorded is meaningless.';
  END IF;

  IF v_pin IS DISTINCT FROM v_r18 THEN
    RAISE EXCEPTION
      '0148 FAILED: the one line that WAS resolvable — classified, charged 18%%, '
      'with an 18%% period covering its date — was not pinned (got %). A '
      'backfill that pins nothing passes every "did it invent a rate" check.',
      COALESCE(v_pin::text, 'NULL');
  END IF;

  IF v_stray <> 0 THEN
    RAISE EXCEPTION
      '0148 FAILED: % line(s) other than the resolvable one were pinned. The '
      'backfill inferred a rate provenance it could not identify, which is the '
      'exact failure this file exists to avoid.', v_stray;
  END IF;

  IF v_v ->> l_noclass::text <> 'unbackfillable_no_classification' THEN
    RAISE EXCEPTION '0148 FAILED: an unclassified line was reported as "%".',
      COALESCE(v_v ->> l_noclass::text, 'NULL');
  END IF;
  IF v_v ->> l_disagree::text <> 'unbackfillable_rate_disagrees' THEN
    RAISE EXCEPTION '0148 FAILED: a line charging 5%% under an 18%% period was reported as "%".',
      COALESCE(v_v ->> l_disagree::text, 'NULL');
  END IF;
  IF v_v ->> l_frozen::text <> 'unbackfillable_document_frozen' THEN
    RAISE EXCEPTION '0148 FAILED: a line on an issued invoice was reported as "%".',
      COALESCE(v_v ->> l_frozen::text, 'NULL');
  END IF;
  IF NOT (v_v::text LIKE '%unbackfillable_no_rate_in_force%') THEN
    RAISE EXCEPTION
      '0148 FAILED: the line classified under a code with no rate period at all '
      'was not reported as unbackfillable_no_rate_in_force. Verdicts seen: %',
      v_v::text;
  END IF;

  RAISE NOTICE
    '0148 PASS: of five probe lines the ONE identifiable line was pinned to the '
    'period in force on its own date, and the other four were left untouched '
    'and named — no classification, rate disagrees, document frozen, no rate in '
    'force. No figure moved. All probe rows were rolled back.';
END
$$;


-- ############################################################################
-- SECTION 5 — WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ############################################################################
--
-- 🔴 IT DOES NOT SET `invoices.gst_computed = true` ON ANY HISTORICAL ROW, AND
-- SETTING IT WOULD BREAK THE DATABASE. `server/billing/invoice-generator.ts`
-- writes header tax and leaves EVERY line-level tax column at zero. 0021 §6's
-- deferred trigger, which `gst_computed` opts into, compares the header to the
-- sum of the lines. Flipping the flag on those rows makes the next UPDATE of
-- any of them — marking one paid — fail at COMMIT with a message about a
-- document that does not add up. The flag is not the fix; per-line tax is, and
-- that is a change to a file Track E does not own. It is in PATCH-REQUEST-E.md.
--
-- 🔴 IT DOES NOT BACKFILL `invoice_lines.gst_rate_id` EITHER, AND CANNOT.
-- Those are Ordence's own subscription invoices. They carry no HSN/SAC
-- classification of any kind — `SAAS_GST_RATE_BPS = 1800` is a constant in
-- `lib/validators/billing.ts`, not a registry lookup — so there is no rate row
-- to identify. Inventing one would be exactly the guess this file refuses to
-- make anywhere else. Condition 1 of the four is unsatisfiable for every row in
-- that table, today and retrospectively.
--
-- ⚠️ IT DOES NOT TOUCH PURCHASE LINES. `server/actions/purchases.ts` is the one
-- path that already resolves and writes a rate id, so there is nothing to
-- backfill; and where it did not, the missing pin is a supplier's document we
-- would be guessing about rather than our own.
--
-- HOW TO USE IT AFTERWARDS
-- ------------------------
--   -- What is left, and why:
--   SELECT verdict, count(*) FROM gst_rate_pin_status GROUP BY verdict;
--
--   -- The worklist, once the registry has been filled in:
--   SELECT * FROM gst_backfill_rate_pins();        -- dry run
--   SELECT * FROM gst_backfill_rate_pins(true);    -- act
--
-- ⭐ RE-RUN IT AFTER EVERY RATE-MASTER IMPORT. Each new period turns some
-- `unbackfillable_no_rate_in_force` rows into `pinnable` ones. Nothing about
-- this is one-shot.
-- ############################################################################
