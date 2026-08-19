-- Seed: July 2026. Some documents posted, some deliberately not.
\set T '11111111-1111-1111-1111-111111111111'

INSERT INTO sales_posting_accounts (tenant_id, role, ledger_id) VALUES
  (:'T', 'receivable',        gen_random_uuid()),
  (:'T', 'revenue',           gen_random_uuid()),
  (:'T', 'output_cgst',       gen_random_uuid()),
  (:'T', 'output_sgst',       gen_random_uuid()),
  (:'T', 'bank',              gen_random_uuid()),
  (:'T', 'customer_advance',  gen_random_uuid()),
  (:'T', 'booking_receivable',gen_random_uuid()),
  (:'T', 'tds_receivable',    gen_random_uuid()),
  (:'T', 'tds_payable_salary',gen_random_uuid()),
  (:'T', 'pf_payable',        gen_random_uuid()),
  (:'T', 'pension_payable',   gen_random_uuid()),
  (:'T', 'esi_payable',       gen_random_uuid()),
  (:'T', 'professional_tax_payable', gen_random_uuid()),
  (:'T', 'salary_expense',    gen_random_uuid()),
  (:'T', 'employer_pf_expense', gen_random_uuid()),
  (:'T', 'salaries_payable',  gen_random_uuid()),
  (:'T', 'tds_payable',       gen_random_uuid());

-- ① two sales invoices; ONE posted, ONE not
INSERT INTO sales_invoices (id, tenant_id, invoice_date, status, total_minor) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', :'T', DATE '2026-07-05', 'issued', 11800000),
  ('aaaaaaaa-0000-0000-0000-000000000002', :'T', DATE '2026-07-19', 'paid',    5900000);
INSERT INTO transactions (tenant_id, transaction_number, transaction_date, status, total_amount)
VALUES (:'T', 'SALES:INV:aaaaaaaa-0000-0000-0000-000000000001', DATE '2026-07-05', 'posted', 118000);

-- a DRAFT invoice, which must NOT be reported
INSERT INTO sales_invoices (tenant_id, invoice_date, status, total_minor)
VALUES (:'T', DATE '2026-07-22', 'draft', 999900);

-- an invoice OUTSIDE the period, which must NOT be reported
INSERT INTO sales_invoices (tenant_id, invoice_date, status, total_minor)
VALUES (:'T', DATE '2026-08-02', 'issued', 700000);

-- another TENANT's unposted invoice, which must NOT be reported
INSERT INTO sales_invoices (tenant_id, invoice_date, status, total_minor)
VALUES ('99999999-9999-9999-9999-999999999999', DATE '2026-07-10', 'issued', 4200000);

-- ② a bounced receipt (never posts) and an unposted cleared one
INSERT INTO customer_receipts (tenant_id, received_on, status, amount_minor) VALUES
  (:'T', DATE '2026-07-11', 'bounced', 300000),
  (:'T', DATE '2026-07-14', 'cleared', 2500000);

-- ③ purchase invoice — no status column at all
INSERT INTO purchase_invoices (tenant_id, invoice_date, total_minor)
VALUES (:'T', DATE '2026-07-09', 3300000);

-- ④ RA bills — a draft (ignored) and a certified one (blocking)
INSERT INTO ra_bills (tenant_id, period_to, status) VALUES
  (:'T', DATE '2026-07-31', 'draft'),
  (:'T', DATE '2026-07-31', 'certified');

-- ⑤ 🔴 THE ONE THAT MATTERS: a vendor payment posted under the LEGACY
--    `RCP` tag. It IS in the ledger and must NOT be reported.
INSERT INTO vendor_payments (id, tenant_id, payment_date, status)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', :'T', DATE '2026-07-16', 'paid');
INSERT INTO transactions (tenant_id, transaction_number, transaction_date, status)
VALUES (:'T', 'SALES:RCP:bbbbbbbb-0000-0000-0000-000000000001', DATE '2026-07-16', 'posted');

-- and one genuinely unposted vendor payment
INSERT INTO vendor_payments (tenant_id, payment_date, status)
VALUES (:'T', DATE '2026-07-20', 'paid');

-- ⑥ demand notices
INSERT INTO demand_notices (tenant_id, notice_date, status) VALUES
  (:'T', DATE '2026-07-03', 'issued'),
  (:'T', DATE '2026-07-04', 'cancelled');

-- drizzle-queried sources
INSERT INTO bookings (tenant_id, reference, status, cancelled_at, cancellation_posted_at, refund_amount_minor, refund_paid_at) VALUES
  (:'T', 'BKG-0001', 'cancelled', TIMESTAMPTZ '2026-07-08 10:00+05:30', NULL, 6000000, NULL),
  (:'T', 'BKG-0002', 'cancelled', TIMESTAMPTZ '2026-06-08 10:00+05:30', TIMESTAMPTZ '2026-06-09 10:00+05:30', 2000000, NULL);

INSERT INTO channel_partner_commissions (tenant_id, status, credited_on, net_payable_minor, tds_minor) VALUES
  (:'T', 'approved', DATE '2026-07-12', 1856000, 32000),
  (:'T', 'posted',   DATE '2026-07-12',  784000, 16000);

INSERT INTO payroll_runs (tenant_id, status, period_start, period_end) VALUES
  (:'T', 'approved', DATE '2026-07-01', DATE '2026-07-31'),
  (:'T', 'computed', DATE '2026-07-01', DATE '2026-07-31');

INSERT INTO gst_returns (tenant_id, tax_period, status, period_end, due_on, total_cash_minor, transaction_id) VALUES
  (:'T', '2026-06', 'filed',     DATE '2026-06-30', DATE '2026-07-20', 4500000, NULL),
  (:'T', '2026-07', 'finalised', DATE '2026-07-31', DATE '2026-08-20', 3900000, NULL);
\set T '11111111-1111-1111-1111-111111111111'
\set B 'cccccccc-0000-0000-0000-000000000001'

-- a booking's real lifecycle, posted exactly as the code posts it
INSERT INTO transactions (id, tenant_id, transaction_number, transaction_date, status)
VALUES ('dddddddd-0000-0000-0000-000000000001', :'T', 'SALES:DMD:demand-1', DATE '2026-05-10', 'posted'),
       ('dddddddd-0000-0000-0000-000000000002', :'T', 'SALES:BRC:receipt-1', DATE '2026-06-02', 'posted');

-- demand: Dr booking_receivable 10,500 / Cr customer_advance 10,000 + Cr CGST 250 + Cr SGST 250
INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, counterparty_type, counterparty_id)
SELECT :'T', 'dddddddd-0000-0000-0000-000000000001', ledger_id, 'debit', 10500.00, 'booking', :'B'
  FROM sales_posting_accounts WHERE tenant_id = :'T' AND role = 'booking_receivable';
INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, counterparty_type, counterparty_id)
SELECT :'T', 'dddddddd-0000-0000-0000-000000000001', ledger_id, 'credit', 10000.00, 'booking', :'B'
  FROM sales_posting_accounts WHERE tenant_id = :'T' AND role = 'customer_advance';
INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, counterparty_type, counterparty_id)
SELECT :'T', 'dddddddd-0000-0000-0000-000000000001', ledger_id, 'credit', 250.00, 'booking', :'B'
  FROM sales_posting_accounts WHERE tenant_id = :'T' AND role = 'output_cgst';
INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, counterparty_type, counterparty_id)
SELECT :'T', 'dddddddd-0000-0000-0000-000000000001', ledger_id, 'credit', 250.00, 'booking', :'B'
  FROM sales_posting_accounts WHERE tenant_id = :'T' AND role = 'output_sgst';

-- receipt: Dr bank 8,500 / Cr booking_receivable 8,500
INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, counterparty_type, counterparty_id)
SELECT :'T', 'dddddddd-0000-0000-0000-000000000002', ledger_id, 'debit', 8500.00, 'booking', :'B'
  FROM sales_posting_accounts WHERE tenant_id = :'T' AND role = 'bank';
INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, counterparty_type, counterparty_id)
SELECT :'T', 'dddddddd-0000-0000-0000-000000000002', ledger_id, 'credit', 8500.00, 'booking', :'B'
  FROM sales_posting_accounts WHERE tenant_id = :'T' AND role = 'booking_receivable';


-- =====================================================================
--  ⭐⭐ A POSTED PAYROLL JOURNAL, so the statutory sweep has something
--  real to read.
--
--  🔴 IT DEBITS THE GROSS. What was withheld is not a reduction of cost;
--  it is five liabilities the employer holds and remits later — and it
--  is those five the compliance page and the morning summary read.
-- =====================================================================
INSERT INTO transactions (id, tenant_id, transaction_number, transaction_date, status)
VALUES ('eeeeeeee-0000-0000-0000-000000000001', :'T', 'SALES:PAY:run-july', DATE '2026-07-31', 'posted'),
       ('eeeeeeee-0000-0000-0000-000000000002', :'T', 'SALES:VPY:vp-july',  DATE '2026-07-16', 'posted');

CREATE OR REPLACE FUNCTION seed_leg(p_txn uuid, p_role text, p_type text, p_amount numeric)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
  SELECT tenant_id, p_txn, ledger_id, p_type, p_amount
    FROM sales_posting_accounts
   WHERE role = p_role
     AND tenant_id = '11111111-1111-1111-1111-111111111111'::uuid;
$$;

--  Dr 5,00,000 salaries + 60,000 employer PF = 5,60,000
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000001', 'salary_expense',      'debit',  500000.00);
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000001', 'employer_pf_expense', 'debit',   60000.00);
--  Cr the five statutory liabilities plus what actually leaves the bank
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000001', 'pf_payable',              'credit', 120000.00);
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000001', 'pension_payable',         'credit',  40000.00);
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000001', 'esi_payable',             'credit',  20000.00);
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000001', 'professional_tax_payable','credit',   2000.00);
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000001', 'tds_payable_salary',      'credit',  50000.00);
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000001', 'salaries_payable',        'credit', 328000.00);

--  ⚠️ AND A VENDOR TDS WITHHOLDING, which is a DIFFERENT obligation with
--  a different due date from the salary one. Seeded separately precisely
--  so a sweep that merged them would be caught.
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000002', 'tds_payable', 'credit', 15000.00);
SELECT seed_leg('eeeeeeee-0000-0000-0000-000000000002', 'bank',        'debit',  15000.00);

DROP FUNCTION seed_leg(uuid, text, text, numeric);
