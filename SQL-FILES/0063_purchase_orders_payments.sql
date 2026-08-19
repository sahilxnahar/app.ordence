-- =====================================================================
--  ORDENCE 0063 — PURCHASE ORDERS, GOODS RECEIPTS AND VENDOR PAYMENTS
--  v1.11.0-alpha · Front office, batch 5
-- =====================================================================
--
--  🔴🔴 THE TDS ENGINE HAS EXISTED SINCE 0025 AND NOTHING REACHED IT.
--
--  Sections, thresholds, catch-up bases, lower deduction certificates,
--  challans, quarterly returns, certificates and interest exposure are
--  all built. The posting gate has said so for twenty sessions:
--
--     tds: "TDS is deducted at PAYMENT, and vendor payment posting is
--           not built yet."
--
--  ⚠️ THAT IS THE WHOLE REASON. Tax is deducted when the money moves,
--  and there were no payments. Not a missing feature — a missing
--  *event*. This migration creates the event.
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴 AND A PAYMENT RUN OVER UNMATCHED BILLS PAYS THE WRONG THINGS
--     FASTER
--  ══════════════════════════════════════════════════════════════════════
--  Which is why the three-way match ships in the same migration and not
--  after it. Three documents have to agree: what was ordered, what
--  arrived, and what was billed.
--
--  ⚠️ The classic fraud is not a fake invoice. It is a real vendor
--  billing for eleven when ten arrived, every month, for years — because
--  the vendor is real, the goods are real, and each difference is small.
--
--  Depends on: purchases (vendors, purchase_invoices), accounting,
--              inventory (warehouses), core.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① WHAT WAS ORDERED
-- =====================================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,

    po_number           varchar(40) NOT NULL,
    po_date             date NOT NULL,
    expected_on         date,

    /**
     * ⭐ A WRITTEN AGREEMENT ON CREDIT DAYS, AND IT MATTERS MORE THAN
     * PEOPLE THINK. Section 15 of the MSMED Act allows fifteen days by
     * default and forty-five only where there is a written agreement.
     * This IS that written agreement, and the payment run reads it.
     */
    agreed_credit_days  integer,

    currency            varchar(3) NOT NULL DEFAULT 'INR',
    subtotal_minor      bigint NOT NULL DEFAULT 0,
    tax_minor           bigint NOT NULL DEFAULT 0,
    total_minor         bigint NOT NULL DEFAULT 0,

    status              varchar(20) NOT NULL DEFAULT 'draft',
    /** 🔴 Who authorised the spend, and when. */
    approved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at         timestamptz,
    closed_reason       varchar(300),

    notes               text,
    terms               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT purchase_orders_status_known CHECK (
        status IN ('draft', 'approved', 'part_received', 'received', 'closed', 'cancelled')
    ),
    CONSTRAINT purchase_orders_amounts_non_negative CHECK (
        subtotal_minor >= 0 AND tax_minor >= 0 AND total_minor >= 0
    ),
    -- 🔴 AN ORDER PAST DRAFT HAS BEEN AUTHORISED BY SOMEBODY, AND SAYS
    --    WHO. An approved order with no approver is a commitment nobody
    --    made and everybody will disown.
    CONSTRAINT purchase_orders_approved_is_evidenced CHECK (
        status = 'draft' OR status = 'cancelled'
        OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    ),
    CONSTRAINT purchase_orders_closed_is_explained CHECK (
        status NOT IN ('closed', 'cancelled') OR closed_reason IS NOT NULL
    ),
    -- ⚠️ s.15 MSMED caps the period at forty-five days. A ninety day
    -- clause is void to that extent, so it cannot even be recorded.
    CONSTRAINT purchase_orders_credit_days_are_lawful CHECK (
        agreed_credit_days IS NULL OR (agreed_credit_days > 0 AND agreed_credit_days <= 45)
    ),
    CONSTRAINT purchase_orders_expected_after_order CHECK (
        expected_on IS NULL OR expected_on >= po_date
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_number_unique
    ON purchase_orders (tenant_id, po_number);
CREATE INDEX IF NOT EXISTS purchase_orders_open_idx
    ON purchase_orders (tenant_id, vendor_id, po_date)
    WHERE status IN ('approved', 'part_received');


CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    po_id               uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,

    line_no             integer NOT NULL,
    description         varchar(500) NOT NULL,
    stock_item_id       uuid,
    hsn_sac_code        varchar(10),
    uom                 varchar(20),

    /** ⭐ Thousandths, the same convention as the stock ledger. */
    ordered_qty         bigint NOT NULL,
    unit_price_minor    bigint NOT NULL,
    tax_rate_bps        integer NOT NULL DEFAULT 0,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT purchase_order_lines_qty_positive CHECK (ordered_qty > 0),
    CONSTRAINT purchase_order_lines_price_non_negative CHECK (unit_price_minor >= 0),
    CONSTRAINT purchase_order_lines_tax_sane CHECK (tax_rate_bps BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_lines_no_unique
    ON purchase_order_lines (po_id, line_no);
CREATE INDEX IF NOT EXISTS purchase_order_lines_po_idx
    ON purchase_order_lines (tenant_id, po_id);


-- =====================================================================
--  ② WHAT ARRIVED
-- =====================================================================
--  🔴 THE RECEIPT DATE IS NOT PAPERWORK. Section 15 of the MSMED Act
--  runs from ACCEPTANCE, not from the invoice — and where nobody objects
--  in writing, acceptance is deemed fifteen days after delivery. So the
--  date on this row is the date the deduction clock starts.

CREATE TABLE IF NOT EXISTS goods_receipts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
    po_id               uuid REFERENCES purchase_orders(id) ON DELETE RESTRICT,

    grn_number          varchar(40) NOT NULL,
    received_on         date NOT NULL,
    /** The vendor's own delivery note. */
    challan_no          varchar(80),
    challan_date        date,
    warehouse_id        uuid,
    received_by         uuid REFERENCES users(id) ON DELETE SET NULL,

    status              varchar(20) NOT NULL DEFAULT 'received',
    /** ⚠️ A rejection says why. "Rejected" alone starts an argument. */
    rejection_reason    varchar(500),

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT goods_receipts_status_known CHECK (
        status IN ('received', 'part_rejected', 'rejected', 'cancelled')
    ),
    CONSTRAINT goods_receipts_rejection_is_explained CHECK (
        status NOT IN ('part_rejected', 'rejected') OR rejection_reason IS NOT NULL
    ),
    CONSTRAINT goods_receipts_challan_dated_before_receipt CHECK (
        challan_date IS NULL OR challan_date <= received_on
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS goods_receipts_number_unique
    ON goods_receipts (tenant_id, grn_number);
CREATE INDEX IF NOT EXISTS goods_receipts_po_idx
    ON goods_receipts (tenant_id, po_id) WHERE po_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS goods_receipt_lines (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    grn_id              uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
    po_line_id          uuid REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,

    line_no             integer NOT NULL,
    description         varchar(500) NOT NULL,
    stock_item_id       uuid,

    accepted_qty        bigint NOT NULL DEFAULT 0,
    /** ⭐ Kept apart. Rejected goods were delivered and are not payable. */
    rejected_qty        bigint NOT NULL DEFAULT 0,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT goods_receipt_lines_qty_non_negative CHECK (
        accepted_qty >= 0 AND rejected_qty >= 0
    ),
    -- ⚠️ A receipt line recording nothing at all is a row somebody
    -- started and abandoned, and it makes the match arithmetic wrong.
    CONSTRAINT goods_receipt_lines_is_something CHECK (
        accepted_qty > 0 OR rejected_qty > 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS goods_receipt_lines_no_unique
    ON goods_receipt_lines (grn_id, line_no);
CREATE INDEX IF NOT EXISTS goods_receipt_lines_po_line_idx
    ON goods_receipt_lines (tenant_id, po_line_id) WHERE po_line_id IS NOT NULL;


--  🔴 YOU CANNOT RECEIVE MORE THAN WAS ORDERED.
--
--  ⚠️ Not a warning. An over-receipt that nobody decided to accept is
--  either a delivery error or a quantity typed with an extra zero, and
--  both of them become a payment on the next invoice if the receipt is
--  allowed to stand. Raising the order first is a decision somebody
--  makes on purpose.
CREATE OR REPLACE FUNCTION ordence_guard_over_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ordered     bigint;
  already     bigint;
  descr       text;
BEGIN
  IF NEW.po_line_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ordered_qty, description INTO ordered, descr
    FROM purchase_order_lines WHERE id = NEW.po_line_id;

  IF ordered IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(accepted_qty + rejected_qty), 0) INTO already
    FROM goods_receipt_lines
   WHERE tenant_id = NEW.tenant_id
     AND po_line_id = NEW.po_line_id
     AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF already + NEW.accepted_qty + NEW.rejected_qty > ordered THEN
    RAISE EXCEPTION
      'This would receive % against an order for % on "%" (% already received). Raise or amend the order first — an over-receipt nobody decided to accept becomes a payment on the next invoice.',
      to_char((already + NEW.accepted_qty + NEW.rejected_qty)::numeric / 1000, 'FM999999999990.000'),
      to_char(ordered::numeric / 1000, 'FM999999999990.000'),
      descr,
      to_char(already::numeric / 1000, 'FM999999999990.000')
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_over_receipt ON goods_receipt_lines;
CREATE TRIGGER trg_guard_over_receipt
  BEFORE INSERT OR UPDATE ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_over_receipt();


-- =====================================================================
--  ③ TYING THE BILL TO THE ORDER AND THE DELIVERY
-- =====================================================================

ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS po_id uuid
    REFERENCES purchase_orders(id) ON DELETE SET NULL;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS grn_id uuid
    REFERENCES goods_receipts(id) ON DELETE SET NULL;
--  ⭐ THE DATE THE MSME CLOCK RUNS FROM. Copied from the receipt when
--  there is one, because s.15 runs from acceptance and not from the
--  invoice date the vendor chose to print.
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS accepted_on date;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS amount_paid_minor bigint
    NOT NULL DEFAULT 0;
--  🔴 A PAYABLE WITH NO DUE DATE CANNOT BE AGED, AND THERE WAS NONE.
--
--  ⚠️ Ageing runs from the due date and never the bill date. These are
--  different numbers and only one of them is true: a bill dated the 1st
--  on sixty day terms is not sixty days overdue on the 1st of March, it
--  is not due at all. The receivables side has worked this way since
--  0027 and the payables side has to agree, or the two reports describe
--  different worlds.
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS due_date date;
--  🔴 The three-way match result, stored at approval so the reason a
--  bill was passed survives the tolerance being changed later.
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS match_state varchar(20);
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS match_note text;

DO $$ BEGIN
    ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_paid_non_negative
        CHECK (amount_paid_minor >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_match_state_known
        CHECK (match_state IS NULL OR match_state IN
               ('matched', 'matched_within_tolerance', 'unmatched', 'no_order'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ⚠️ A bill that passed only on a tolerance has to say what the
-- tolerance let through. "Matched" with no note is the audit trail
-- saying nothing at the exact point somebody will ask.
DO $$ BEGIN
    ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_tolerance_is_explained
        CHECK (match_state <> 'matched_within_tolerance' OR match_note IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =====================================================================
--  ④ THE PAYMENT
-- =====================================================================
--  🔴 THIS IS THE EVENT THE TDS ENGINE HAS BEEN WAITING FOR SINCE 0025.

CREATE TABLE IF NOT EXISTS vendor_payments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,

    payment_number      varchar(40) NOT NULL,
    payment_date        date NOT NULL,
    method              varchar(20) NOT NULL DEFAULT 'bank_transfer',
    bank_reference      varchar(120),
    /** Which bank ledger it left. */
    bank_ledger_id      uuid,

    /**
     * 🔴 THE THREE AMOUNTS, AND THEY ARE NOT THE SAME NUMBER.
     *
     *   gross  — what the bills are being settled for
     *   tds    — withheld and owed to the Government
     *   net    — what actually leaves the bank
     *
     * ⚠️ A payments table with one "amount" column cannot answer which
     * of the three it holds, and every reconciliation afterwards is a
     * guess.
     */
    gross_minor         bigint NOT NULL,
    tds_minor           bigint NOT NULL DEFAULT 0,
    /** ⭐ Mandatory, compounding, and never deductible. */
    msme_interest_minor bigint NOT NULL DEFAULT 0,
    round_off_minor     bigint NOT NULL DEFAULT 0,
    net_minor           bigint NOT NULL,

    /** The section the deduction was made under, and the engine's record. */
    tds_section         varchar(12),
    tds_deduction_id    uuid,

    status              varchar(20) NOT NULL DEFAULT 'draft',
    approved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at         timestamptz,
    /** Set once the ledger has it. */
    posted_at           timestamptz,
    void_reason         varchar(300),

    /** ⭐ A payment run groups payments approved together. */
    run_id              uuid,

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT vendor_payments_method_known CHECK (
        method IN ('bank_transfer', 'cheque', 'cash', 'upi', 'adjustment')
    ),
    CONSTRAINT vendor_payments_status_known CHECK (
        status IN ('draft', 'approved', 'paid', 'void')
    ),
    CONSTRAINT vendor_payments_amounts_non_negative CHECK (
        gross_minor >= 0 AND tds_minor >= 0 AND net_minor >= 0
        AND msme_interest_minor >= 0
    ),

    -- =================================================================
    -- 🔴🔴 THE ARITHMETIC THAT CANNOT BE WRONG.
    --
    --    net = gross - tds + msme interest + rounding
    --
    -- ⚠️ Every one of these has been got wrong in a real system: TDS
    -- added instead of deducted, interest netted off instead of added,
    -- and a "net" that was simply typed. The database does the sum.
    -- =================================================================
    CONSTRAINT vendor_payments_arithmetic CHECK (
        net_minor = gross_minor - tds_minor + msme_interest_minor + round_off_minor
    ),
    -- ⚠️ Withholding more than the payment itself is a sign error.
    CONSTRAINT vendor_payments_tds_within_gross CHECK (tds_minor <= gross_minor),
    -- 🔴 A deduction has to name its section, or the return cannot be built.
    CONSTRAINT vendor_payments_tds_names_its_section CHECK (
        tds_minor = 0 OR tds_section IS NOT NULL
    ),
    CONSTRAINT vendor_payments_approved_is_evidenced CHECK (
        status IN ('draft', 'void') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    ),
    CONSTRAINT vendor_payments_void_is_explained CHECK (
        status <> 'void' OR void_reason IS NOT NULL
    ),
    CONSTRAINT vendor_payments_paid_is_posted CHECK (
        status <> 'paid' OR posted_at IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS vendor_payments_number_unique
    ON vendor_payments (tenant_id, payment_number);
CREATE INDEX IF NOT EXISTS vendor_payments_vendor_idx
    ON vendor_payments (tenant_id, vendor_id, payment_date);
CREATE INDEX IF NOT EXISTS vendor_payments_run_idx
    ON vendor_payments (tenant_id, run_id) WHERE run_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS vendor_payment_allocations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    payment_id          uuid NOT NULL REFERENCES vendor_payments(id) ON DELETE CASCADE,
    invoice_id          uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE RESTRICT,

    allocated_minor     bigint NOT NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_payment_allocations_positive CHECK (allocated_minor > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS vendor_payment_allocations_unique
    ON vendor_payment_allocations (payment_id, invoice_id);
CREATE INDEX IF NOT EXISTS vendor_payment_allocations_invoice_idx
    ON vendor_payment_allocations (tenant_id, invoice_id);


--  🔴 A BILL CANNOT BE PAID TWICE.
--
--  ⚠️ The duplicate payment is the single most common loss in accounts
--  payable and it almost never involves anybody dishonest. The same
--  invoice arrives by email and by post, gets two internal numbers, and
--  is paid on two different runs three weeks apart.
CREATE OR REPLACE FUNCTION ordence_guard_payment_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  bill_total   bigint;
  bill_number  text;
  already      bigint;
  pay_status   text;
BEGIN
  SELECT total_minor, invoice_number INTO bill_total, bill_number
    FROM purchase_invoices WHERE id = NEW.invoice_id;

  IF bill_total IS NULL THEN
    RAISE EXCEPTION 'That bill does not exist.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT status INTO pay_status FROM vendor_payments WHERE id = NEW.payment_id;
  IF pay_status IN ('paid', 'void') THEN
    RAISE EXCEPTION
      'This payment is already % and its allocations are fixed. Raise a new payment rather than changing what a settled one paid for.',
      pay_status
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COALESCE(SUM(a.allocated_minor), 0) INTO already
    FROM vendor_payment_allocations a
    JOIN vendor_payments p ON p.id = a.payment_id
   WHERE a.tenant_id = NEW.tenant_id
     AND a.invoice_id = NEW.invoice_id
     AND p.status <> 'void'
     AND a.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF already + NEW.allocated_minor > bill_total THEN
    RAISE EXCEPTION
      'Bill % is for % and % has already been allocated to it. This would pay % against it. A bill paid twice is the commonest loss in accounts payable and it almost never involves anybody dishonest — the same invoice arrives by email and by post and gets two internal numbers.',
      bill_number,
      to_char(bill_total::numeric / 100, 'FM999999999990.00'),
      to_char(already::numeric / 100, 'FM999999999990.00'),
      to_char((already + NEW.allocated_minor)::numeric / 100, 'FM999999999990.00')
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_payment_allocation ON vendor_payment_allocations;
CREATE TRIGGER trg_guard_payment_allocation
  BEFORE INSERT OR UPDATE ON vendor_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_payment_allocation();


--  🔴 A PAID PAYMENT IS IN THE LEDGER AND IN SOMEBODY'S BANK ACCOUNT.
--
--  ⚠️ Editing the amount afterwards changes the books and does not
--  change the bank, and the two never agree again. Voiding it is a
--  decision with a reason on it.
CREATE OR REPLACE FUNCTION ordence_guard_paid_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'paid' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'void' THEN
    IF NEW.void_reason IS NULL THEN
      RAISE EXCEPTION 'Voiding a settled payment has to say why.'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.gross_minor IS DISTINCT FROM OLD.gross_minor
     OR NEW.tds_minor IS DISTINCT FROM OLD.tds_minor
     OR NEW.net_minor IS DISTINCT FROM OLD.net_minor
     OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
     OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id THEN
    RAISE EXCEPTION
      'This payment has been made and posted. Changing the amount or the date now changes the books without changing the bank, and the two never agree again. Void it with a reason and raise a new one.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_paid_payment ON vendor_payments;
CREATE TRIGGER trg_guard_paid_payment
  BEFORE UPDATE ON vendor_payments
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_paid_payment();


--  ⭐ KEEP THE BILL'S PAID FIGURE HONEST, IN THE DATABASE.
--
--  🔴 A "paid so far" column maintained by application code is a column
--  that goes wrong the first time anything writes an allocation by
--  another route. It is derived here, on every allocation change.
CREATE OR REPLACE FUNCTION ordence_sync_invoice_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  inv uuid;
BEGIN
  inv := COALESCE(NEW.invoice_id, OLD.invoice_id);

  UPDATE purchase_invoices pi
     SET amount_paid_minor = COALESCE((
           SELECT SUM(a.allocated_minor)
             FROM vendor_payment_allocations a
             JOIN vendor_payments p ON p.id = a.payment_id
            WHERE a.invoice_id = inv
              AND p.status <> 'void'
         ), 0)
   WHERE pi.id = inv;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_sync_invoice_paid ON vendor_payment_allocations;
CREATE TRIGGER trg_sync_invoice_paid
  AFTER INSERT OR UPDATE OR DELETE ON vendor_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION ordence_sync_invoice_paid();


--  🔴🔴 AND VOIDING A PAYMENT HAS TO RELEASE THE BILLS IT PAID.
--
--  ⚠️ THIS WAS FOUND BY THE DRILL, NOT BY THE DESIGN. The allocation
--  trigger above excludes void payments from the sum, but it only fires
--  when an ALLOCATION changes — and voiding a payment changes the
--  PAYMENT. So a voided payment left every bill it had settled still
--  showing as paid.
--
--  🔴 That bill would then never appear on a payment run again, never be
--  chased, and never be paid: a cheque bounces, somebody voids the
--  payment correctly, and the supplier simply stops being paid with no
--  trace of why. Silent, permanent, and entirely invisible.
CREATE OR REPLACE FUNCTION ordence_resync_on_void()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  -- ⚠️ Only a change into or out of `void` alters what counts as paid.
  IF NEW.status <> 'void' AND OLD.status <> 'void' THEN
    RETURN NULL;
  END IF;

  UPDATE purchase_invoices pi
     SET amount_paid_minor = COALESCE((
           SELECT SUM(a2.allocated_minor)
             FROM vendor_payment_allocations a2
             JOIN vendor_payments p2 ON p2.id = a2.payment_id
            WHERE a2.invoice_id = pi.id
              AND p2.status <> 'void'
         ), 0)
   WHERE pi.id IN (
     SELECT invoice_id FROM vendor_payment_allocations WHERE payment_id = NEW.id
   );

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_resync_on_void ON vendor_payments;
CREATE TRIGGER trg_resync_on_void
  AFTER UPDATE ON vendor_payments
  FOR EACH ROW EXECUTE FUNCTION ordence_resync_on_void();


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_orders_tenant_isolation ON purchase_orders;
CREATE POLICY purchase_orders_tenant_isolation ON purchase_orders
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_order_lines_tenant_isolation ON purchase_order_lines;
CREATE POLICY purchase_order_lines_tenant_isolation ON purchase_order_lines
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goods_receipts_tenant_isolation ON goods_receipts;
CREATE POLICY goods_receipts_tenant_isolation ON goods_receipts
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goods_receipt_lines_tenant_isolation ON goods_receipt_lines;
CREATE POLICY goods_receipt_lines_tenant_isolation ON goods_receipt_lines
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_payments_tenant_isolation ON vendor_payments;
CREATE POLICY vendor_payments_tenant_isolation ON vendor_payments
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE vendor_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_payment_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_payment_allocations_tenant_isolation ON vendor_payment_allocations;
CREATE POLICY vendor_payment_allocations_tenant_isolation ON vendor_payment_allocations
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
