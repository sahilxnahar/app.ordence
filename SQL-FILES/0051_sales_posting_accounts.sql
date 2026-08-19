-- =====================================================================
--  0051 — WHICH LEDGER EACH PART OF A SALES DOCUMENT POSTS TO
--  Ordence · v0.99.0-alpha
-- =====================================================================
--
--  ⭐⭐ WHY THIS FILE EXISTS
--  ------------------------------------------------------------------
--  `server/tally/exporter.ts` has said since Phase 37:
--
--      "THE SOURCE IS THE LEDGER, AND ONLY THE LEDGER"
--
--  It is right, and it exposed something nobody had noticed: the sales
--  invoice subsystem built across Phases 49–57 posts NOTHING to
--  `transactions` / `journal_entries`.
--
--  🔴 SO EVERY SALES INVOICE EVER RAISED IS INVISIBLE TO:
--       • the P&L — the revenue is not there
--       • the balance sheet — the receivable is not there
--       • the trial balance
--       • the GST output liability under "Duties & Taxes"
--       • the Tally export, which reads the ledger and only the ledger
--
--  The documents were correct the whole time. The books did not know
--  about them.
--
--  ⚠️ A LEDGER CANNOT BE GUESSED FROM A NAME OR A CODE. Every tenant
--  builds their own chart of accounts; "4000" is revenue in one and a
--  bank account in another. Inferring the mapping would post a customer's
--  turnover into whatever ledger happened to match a string — and a
--  posting that balances is not the same as a posting that is right.
--
--  So the mapping is DATA, declared once per tenant, and posting refuses
--  when a role is unmapped rather than choosing for them.
-- =====================================================================

CREATE TABLE IF NOT EXISTS sales_posting_accounts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- ⚠️ varchar, NOT an enum. A new role — cess, TCS, an export ledger —
    -- must be a row and a code change, never a migration that locks the
    -- table while a tenant is invoicing.
    role         varchar(40) NOT NULL,

    -- ⚠️ ON DELETE RESTRICT. A ledger that sales posts into must not be
    -- deletable out from under the mapping; the alternative is a mapping
    -- pointing at nothing and a posting that fails at issue time.
    ledger_id    uuid NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,

    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

-- ⭐ ONE LEDGER PER ROLE PER TENANT. Two ledgers claiming "output_igst"
--   would make the posting non-deterministic — the same invoice landing
--   in different accounts depending on row order.
CREATE UNIQUE INDEX IF NOT EXISTS sales_posting_accounts_role_key
    ON sales_posting_accounts (tenant_id, role);

CREATE INDEX IF NOT EXISTS sales_posting_accounts_ledger_idx
    ON sales_posting_accounts (tenant_id, ledger_id);

-- =====================================================================
--  ⭐ IDEMPOTENCY — THE PROPERTY THAT MAKES "POST IT LATER" SAFE
-- =====================================================================
--
--  Posting is retried: an invoice issued before the chart of accounts was
--  mapped sits unposted until somebody presses a button. Retrying is only
--  safe if a second attempt cannot create a second transaction.
--
--  ⚠️ THE APPLICATION CHECKING FIRST IS NOT ENOUGH. Two people pressing
--  "post the backlog" at the same moment both read "not posted" and both
--  insert. That is the double post `server/tally/exporter.ts` is dedicated
--  to preventing — arriving through our own front door.
--
--  🔴 SO THE KEY IS A PARTIAL UNIQUE INDEX. The second insert is refused
--     by the database, not by a code path somebody can forget.
--
--  ⚠️ IT KEYS ON `transaction_number`, NOT ON (reference_type,
--  reference_id), AND THAT IS DELIBERATE — twice over:
--
--    1. `reference_type` is a POSTGRES ENUM with no sales members. Sales
--       documents correctly reuse the existing values: an invoice posts as
--       'invoice', a receipt as 'receipt', a credit note as 'adjustment'.
--       `classifyVoucherType()` in `lib/tally/vouchers.ts` already maps
--       those to Tally's sales / receipt / credit_note vouchers. Adding
--       enum members to describe something the system already describes
--       correctly would be a migration in service of nothing.
--
--    2. ⚠️ 'invoice' IS SHARED WITH BILLING. A unique index on
--       (tenant_id, 'invoice', reference_id) would also constrain the
--       subscription invoices from Phase 32, and other subsystems
--       legitimately post several transactions against one reference — a
--       recurring contract bills monthly against the same contract id. A
--       blanket constraint fixes our problem by breaking theirs.
--
--  The prefix scopes the index to rows this subsystem writes and nothing
--  else. Existing rows are untouched and cannot collide, because none of
--  them begins with 'SALES:'.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_sales_document_once
    ON transactions (tenant_id, transaction_number)
    WHERE transaction_number LIKE 'SALES:%';

-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⚠️ app_platform_scope() belongs in USING and NEVER in WITH CHECK.
--  Platform staff may READ across tenants to support them; nothing may
--  WRITE a row into a tenant it does not belong to.

ALTER TABLE sales_posting_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_posting_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_posting_accounts_tenant_isolation ON public.sales_posting_accounts;
CREATE POLICY sales_posting_accounts_tenant_isolation ON public.sales_posting_accounts
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_posting_accounts TO ordence_app;
