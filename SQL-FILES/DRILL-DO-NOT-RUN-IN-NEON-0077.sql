-- =====================================================================
--  🔴🔴🔴 DO NOT RUN THIS AGAINST NEON. DO NOT RUN IT AGAINST ANY
--  DATABASE THAT HAS REAL DATA IN IT.
--
--  It proves the constraints REFUSE things, which it does by trying to
--  insert bad rows against a made-up tenant. On a live database it
--  would either fail on foreign keys or, worse, succeed and leave fake
--  tax returns in your records.
--
--  It has already been run here, on a throwaway Postgres, as the
--  non-superuser role `app_user`. The transcript beside this file is
--  the evidence. Keep both; execute neither.
-- =====================================================================
--
--  ORDENCE — THE DRILL FOR 0077 · THE MONTHLY RETURN
--  Version: v1.24.0-alpha
--
--  ⚠️ EVERY REFUSAL IS PAIRED WITH A POSITIVE. A statement that failed
--  cannot be told apart from a statement that never ran.
-- =====================================================================

-- =====================================================================
--  ① ONE LIVE RETURN PER GSTIN PER PERIOD
-- =====================================================================

\echo '--- ①a POSITIVE: the first return for a period must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO gst_returns (tenant_id, gstin, tax_period, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', '29ABCDE1234F1Z5',
        '2026-07', DATE '2026-07-01', DATE '2026-07-31');
COMMIT;

\echo '--- ①b NEGATIVE: a SECOND live return for the same GSTIN and period'
\echo '    must be REFUSED (it would post the reclassification twice and'
\echo '     clear the input tax account by double what was utilised)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO gst_returns (tenant_id, gstin, tax_period, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', '29ABCDE1234F1Z5',
        '2026-07', DATE '2026-07-01', DATE '2026-07-31');
COMMIT;

\echo '--- ①c POSITIVE: a DIFFERENT GSTIN for the same period must SUCCEED'
\echo '    (three States means three returns and three set-offs)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO gst_returns (tenant_id, gstin, tax_period, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', '27ABCDE1234F1Z5',
        '2026-07', DATE '2026-07-01', DATE '2026-07-31');
COMMIT;

\echo '--- ①d NEGATIVE: a malformed tax period must be REFUSED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO gst_returns (tenant_id, gstin, tax_period, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', '29ABCDE1234F1Z5',
        'July-26', DATE '2026-07-01', DATE '2026-07-31');
COMMIT;

-- =====================================================================
--  ② THE CASH TOTAL MUST ADD UP TO ITSELF
-- =====================================================================

\echo '--- ②a NEGATIVE: a total that does not equal its parts must be REFUSED'
\echo '    (this is the figure somebody arranges money for)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns
   SET cash_cgst_minor = 3000000, cash_sgst_minor = 3000000,
       total_cash_minor = 5000000
 WHERE tax_period = '2026-07' AND gstin = '29ABCDE1234F1Z5';
COMMIT;

\echo '--- ②b POSITIVE: the same update with a correct total must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns
   SET cash_cgst_minor = 3000000, cash_sgst_minor = 3000000,
       total_cash_minor = 6000000
 WHERE tax_period = '2026-07' AND gstin = '29ABCDE1234F1Z5';
COMMIT;

-- =====================================================================
--  ③ FILING, AND THE FREEZE
-- =====================================================================

\echo '--- ③a POSITIVE: draft to finalised must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns SET status = 'finalised', finalised_at = now()
 WHERE tax_period = '2026-07' AND gstin = '29ABCDE1234F1Z5';
COMMIT;

\echo '--- ③b NEGATIVE: finalised back to draft must be REFUSED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns SET status = 'draft'
 WHERE tax_period = '2026-07' AND gstin = '29ABCDE1234F1Z5';
COMMIT;

\echo '--- ③c NEGATIVE: filed with no acknowledgement number must be REFUSED'
\echo '    (without one, "filed" is a claim nobody can check)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns SET status = 'filed', filed_at = now()
 WHERE tax_period = '2026-07' AND gstin = '29ABCDE1234F1Z5';
COMMIT;

\echo '--- ③d POSITIVE: filed WITH an acknowledgement number must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns SET status = 'filed', arn = 'AA290726123456X', filed_at = now()
 WHERE tax_period = '2026-07' AND gstin = '29ABCDE1234F1Z5';
COMMIT;

\echo '--- ③e NEGATIVE: changing a FILED return figure must be REFUSED'
\echo '    (GST provides no amendment of a filed 3B — a mistake is'
\echo '     corrected in a LATER period, which is the legal remedy)'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns SET output_cgst_minor = 1
 WHERE tax_period = '2026-07' AND gstin = '29ABCDE1234F1Z5';
COMMIT;

\echo '--- ③f NEGATIVE: superseding a FILED return must be REFUSED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns SET status = 'superseded', superseded_at = now(),
       supersede_reason = 'Changed my mind about the figures'
 WHERE tax_period = '2026-07' AND gstin = '29ABCDE1234F1Z5';
COMMIT;

\echo '--- ③g POSITIVE: attaching the reclassification journal to a FILED'
\echo '    return must SUCCEED — it happens after filing by design'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns SET prepared_at = now()
 WHERE tax_period = '2026-07' AND gstin = '29ABCDE1234F1Z5';
COMMIT;

\echo '--- ③h NEGATIVE: superseding a DRAFT without a reason must be REFUSED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns SET status = 'superseded', superseded_at = now()
 WHERE tax_period = '2026-07' AND gstin = '27ABCDE1234F1Z5';
COMMIT;

\echo '--- ③i POSITIVE: superseding a DRAFT WITH a reason must SUCCEED'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE gst_returns SET status = 'superseded', superseded_at = now(),
       supersede_reason = 'Prepared against the wrong registration.'
 WHERE tax_period = '2026-07' AND gstin = '27ABCDE1234F1Z5';
COMMIT;

\echo '--- ③j POSITIVE: with that one superseded, the slot is free again'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO gst_returns (tenant_id, gstin, tax_period, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', '27ABCDE1234F1Z5',
        '2026-07', DATE '2026-07-01', DATE '2026-07-31');
COMMIT;

-- =====================================================================
--  ④ ROW LEVEL SECURITY
-- =====================================================================

\echo '--- ④a POSITIVE: the owning tenant sees its own returns'
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) AS own_tenant_sees FROM gst_returns;
COMMIT;

\echo '--- ④b NEGATIVE: another tenant sees none of them'
BEGIN;
SET LOCAL app.current_tenant_id = '22222222-2222-2222-2222-222222222222';
SELECT count(*) AS other_tenant_sees FROM gst_returns;
COMMIT;

\echo '--- ④c NEGATIVE: and cannot write into the first tenant'
BEGIN;
SET LOCAL app.current_tenant_id = '22222222-2222-2222-2222-222222222222';
INSERT INTO gst_returns (tenant_id, gstin, tax_period, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', '29ZZZZZ1234F1Z5',
        '2026-08', DATE '2026-08-01', DATE '2026-08-31');
COMMIT;

\echo '--- ④d POSITIVE: the platform scope may READ across tenants'
BEGIN;
SET LOCAL app.platform_scope = 'on';
SELECT count(*) AS platform_sees FROM gst_returns;
COMMIT;

\echo '--- ④e NEGATIVE: and may NOT write, because WITH CHECK excludes it'
BEGIN;
SET LOCAL app.platform_scope = 'on';
INSERT INTO gst_returns (tenant_id, gstin, tax_period, period_start, period_end)
VALUES ('11111111-1111-1111-1111-111111111111', '29PLATF1234F1Z5',
        '2026-09', DATE '2026-09-01', DATE '2026-09-30');
COMMIT;

\echo '--- DRILL COMPLETE ---'
