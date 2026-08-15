-- =====================================================================
--  ORDENCE — THE EXECUTION HARNESS SCHEMA
--
--  ⚠️ Throwaway Postgres only. This is not a migration and never runs
--  anywhere real. It exists so that SQL which is currently only
--  TYPECHECKED can actually be EXECUTED.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TABLE IF EXISTS journal_entries, transactions, sales_posting_accounts,
  sales_invoices, customer_receipts, purchase_invoices, ra_bills,
  vendor_payments, demand_notices, bookings, channel_partner_commissions,
  payroll_runs, gst_returns CASCADE;

CREATE TABLE transactions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    transaction_number varchar(120) NOT NULL,
    description        text,
    transaction_date   date NOT NULL,
    status             varchar(20) NOT NULL DEFAULT 'posted',
    reference_type     varchar(30),
    reference_id       uuid,
    currency           varchar(3) DEFAULT 'INR',
    total_amount       numeric(18,2),
    created_by         uuid,
    posted_at          timestamptz
);
CREATE UNIQUE INDEX transactions_number_key ON transactions (tenant_id, transaction_number);

CREATE TABLE sales_posting_accounts (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    role      varchar(60) NOT NULL,
    ledger_id uuid NOT NULL
);

CREATE TABLE journal_entries (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    transaction_id     uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    ledger_id          uuid NOT NULL,
    entry_type         varchar(10) NOT NULL,
    amount             numeric(18,2) NOT NULL,
    description        text,
    reference_type     varchar(30),
    reference_id       uuid,
    counterparty_type  varchar(40),
    counterparty_id    uuid,
    counterparty_name  varchar(255)
);

/* ---- the six probe tables, with ONLY the columns the probe names ---- */

CREATE TABLE sales_invoices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    invoice_date date NOT NULL,
    status       varchar(20) NOT NULL,
    total_minor  bigint NOT NULL DEFAULT 0
);

CREATE TABLE customer_receipts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    received_on  date NOT NULL,
    status       varchar(20) NOT NULL,
    amount_minor bigint NOT NULL DEFAULT 0
);

CREATE TABLE purchase_invoices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    invoice_date date NOT NULL,
    total_minor  bigint NOT NULL DEFAULT 0
);

CREATE TABLE ra_bills (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL,
    period_to  date NOT NULL,
    status     varchar(20) NOT NULL
);

CREATE TABLE vendor_payments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    payment_date date NOT NULL,
    status       varchar(20) NOT NULL
);

CREATE TABLE demand_notices (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    notice_date date NOT NULL,
    status      varchar(20) NOT NULL
);

/* ---- the drizzle-queried ones ------------------------------------- */

CREATE TABLE bookings (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,
    reference               varchar(40) NOT NULL,
    status                  varchar(30) NOT NULL,
    cancelled_at            timestamptz,
    cancellation_posted_at  timestamptz,
    refund_amount_minor     bigint,
    refund_paid_at          timestamptz
);

CREATE TABLE channel_partner_commissions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    status            varchar(20) NOT NULL,
    credited_on       date NOT NULL,
    net_payable_minor bigint NOT NULL DEFAULT 0,
    tds_minor         bigint NOT NULL DEFAULT 0
);

CREATE TABLE payroll_runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    status       varchar(20) NOT NULL,
    period_start date NOT NULL,
    period_end   date NOT NULL
);

CREATE TABLE gst_returns (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    tax_period       varchar(7) NOT NULL,
    status           varchar(20) NOT NULL,
    period_end       date NOT NULL,
    due_on           date,
    total_cash_minor bigint NOT NULL DEFAULT 0,
    transaction_id   uuid
);
