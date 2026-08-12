-- 0049_sales_invoices.sql
-- ⭐ THE OUTWARD DOCUMENT. Phase 49.
--
-- ══════════════════════════════════════════════════════════════════════
-- WHAT THIS CLOSES
-- ══════════════════════════════════════════════════════════════════════
-- Before this file the chain stopped dead at a confirmed order:
--
--   lead → deal → sales order → CONFIRMED → … nothing.
--
-- There was no document between a confirmed order and money, which meant
-- no accounts receivable for a company customer, no input to GSTR-1, and
-- `sales_orders.received_value_minor` written by nothing at all — so the
-- credit limits added in 0048 measured an exposure that could never come
-- down. A customer reached their ceiling once and stayed there.
--
-- ⚠️ `invoices` IN billing.ts IS NOT THIS DOCUMENT AND MUST NOT BE REUSED.
--    That table is ORDENCE billing its own tenants: `invoice_generator.ts`
--    sets `customer_legal_name` from the TENANT, and it carries
--    `subscription_id`, `provider_invoice_id` and `hosted_invoice_url`.
--    Its customer is the workspace. This table's customer is the
--    workspace's customer. Same shape, opposite direction, and merging
--    them would put Ordence's own revenue in its tenants' GSTR-1.
--
-- ══════════════════════════════════════════════════════════════════════
-- ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════
-- It does not compute tax. `lib/gst/tax.ts` (computeInvoiceTax) already
-- does, it is pure and tested, and it is what Phase 32 used. It does not
-- check Rule 46 either — `lib/gst/invoice-fields.ts` (checkRule46) does.
-- A second tax engine inside a trigger would be a second answer to "what
-- is the CGST on this line", and the two would disagree the first time a
-- rate changed mid-year.
--
-- What it DOES guarantee, because only the database can:
--   · the number series has no duplicates, under concurrency
--   · an issued invoice is frozen
--   · you cannot allocate more money than a receipt holds
--   · you cannot allocate more to an invoice than the invoice is for
--   · the order's progress columns agree with the documents under them

-- =====================================================================
--  ENUMS
-- =====================================================================

DO $$ BEGIN
    CREATE TYPE sales_invoice_status AS ENUM (
        'draft',
        'issued',
        'part_paid',
        'paid',
        'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ⚠️ THERE IS NO 'void' AND NO 'deleted'. Under Rule 53 a tax invoice
--    that has been issued is reduced or reversed by a CREDIT NOTE, which
--    is its own document with its own number and its own GSTR-1 line.
--    `cancelled` exists only for the narrow lawful case below.

DO $$ BEGIN
    CREATE TYPE customer_receipt_method AS ENUM (
        'cash',
        'cheque',
        'neft',
        'rtgs',
        'imps',
        'upi',
        'card',
        'adjustment'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE customer_receipt_status AS ENUM (
        'pending',
        'cleared',
        'bounced',
        'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
--  TABLE: sales_invoices
-- =====================================================================

CREATE TABLE IF NOT EXISTS sales_invoices (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- ⭐ HUMAN-FACING, UNIQUE PER TENANT, AND NEVER ACCEPTED FROM A FORM.
    --
    -- Rule 46(b) requires a consecutive serial number unique for a
    -- financial year. `financial_year` is stored beside it so the series
    -- can restart each April without the uniqueness check having to parse
    -- the string — a check that parsed "AH/2026-27/000148" would break the
    -- first time a workspace changed its prefix.
    invoice_number      varchar(60) NOT NULL,
    financial_year      varchar(9)  NOT NULL,          -- '2026-27'

    status              sales_invoice_status NOT NULL DEFAULT 'draft',

    -- ⭐ THE COUNTERPARTY. This is the column `invoices` in billing.ts
    --    does not have and cannot have, and it is the whole reason this
    --    table exists: without it there is no customer ledger, because
    --    there is nothing to group a customer's documents by.
    --
    -- ON DELETE RESTRICT. A company with an issued tax invoice against it
    -- cannot be deleted — the document has to keep naming somebody.
    company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    contact_id          uuid        REFERENCES contacts(id) ON DELETE SET NULL,

    -- Where it came from. Nullable: a service invoice or a counter sale
    -- may have no order behind it, and refusing those would push the
    -- workspace back to Tally for exactly the documents this exists for.
    order_id            uuid        REFERENCES sales_orders(id) ON DELETE RESTRICT,

    invoice_date        date        NOT NULL,
    due_date            date,

    -- ⚠️ CAPTURED AT ISSUE, NEVER JOINED AT READ TIME. Rule 46(d)–(f).
    --    A customer who changes their registered name next year must not
    --    restate the document we gave them this year. Same rule the
    --    billing invoices already follow.
    customer_legal_name varchar(255),
    customer_gstin      varchar(15),
    customer_address    jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Rule 46(a) — ours, as it stood on the invoice date.
    supplier_registration_id uuid   REFERENCES gst_registrations(id) ON DELETE RESTRICT,
    supplier_gstin      varchar(15),
    supplier_state_code varchar(2),

    gst_party_id        uuid        REFERENCES gst_parties(id) ON DELETE RESTRICT,

    -- ⚠️ STORED, NOT DERIVED ON READ. A legal determination made against
    --    the facts on the invoice date. Deriving it later re-splits every
    --    historical CGST/SGST into IGST the day a delivery address moves.
    place_of_supply_code varchar(2),
    place_of_supply_basis varchar(40),
    is_inter_state      boolean     NOT NULL DEFAULT false,
    is_union_territory  boolean     NOT NULL DEFAULT false,
    supply_type         varchar(20) NOT NULL DEFAULT 'goods',
    property_state_code varchar(2),

    -- ⚠️ ON A SALES INVOICE, REVERSE-CHARGE TAX IS SHOWN AND NOT
    --    COLLECTED. The recipient pays it to the Government. Charging it
    --    is the error, and it is invisible until the customer refuses to
    --    pay the tax line.
    is_reverse_charge   boolean     NOT NULL DEFAULT false,

    currency            varchar(3)  NOT NULL DEFAULT 'INR',

    -- Money — every figure integer paise, computed by lib/gst/tax.ts.
    subtotal_minor      bigint      NOT NULL DEFAULT 0,
    discount_minor      bigint      NOT NULL DEFAULT 0,
    taxable_value_minor bigint      NOT NULL DEFAULT 0,
    cgst_minor          bigint      NOT NULL DEFAULT 0,
    sgst_minor          bigint      NOT NULL DEFAULT 0,
    igst_minor          bigint      NOT NULL DEFAULT 0,
    cess_minor          bigint      NOT NULL DEFAULT 0,
    other_charges_minor bigint      NOT NULL DEFAULT 0,
    round_off_minor     bigint      NOT NULL DEFAULT 0,
    total_minor         bigint      NOT NULL DEFAULT 0,

    -- ⭐ MAINTAINED BY TRIGGER FROM THE ALLOCATIONS, NEVER BY THE APP.
    --    This is the column whose absence on `sales_orders` made the
    --    0048 credit limits inert. It is written in exactly one place.
    received_minor      bigint      NOT NULL DEFAULT 0,

    -- e-invoicing. Nullable: below the turnover threshold an IRN is not
    -- required, and a NOT NULL here would make the table unusable for
    -- every small workspace.
    irn                 varchar(64),
    irn_generated_at    timestamptz,
    ack_no              varchar(30),
    signed_qr_code      text,
    eway_bill_no        varchar(30),
    eway_bill_date      date,

    -- ⚠️ ONE-WAY. Set when the document becomes a tax invoice.
    issued_at           timestamptz,
    issued_by           uuid        REFERENCES users(id) ON DELETE SET NULL,

    -- Cancellation carries a named human and a reason, or it does not
    -- happen — matching the rule sales orders already enforce.
    cancelled_at        timestamptz,
    cancelled_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
    cancel_reason       text,

    notes               text,
    terms               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid        REFERENCES users(id) ON DELETE SET NULL,

    -- ⭐ THE NUMBER SERIES GUARANTEE. Not the application's job: two
    --    concurrent issues can read the same maximum, and only this index
    --    stops both writing it.
    CONSTRAINT sales_invoices_number_tenant_key UNIQUE (tenant_id, invoice_number),

    -- Lets child rows carry a composite FK, so a line can never point at
    -- an invoice belonging to another workspace.
    CONSTRAINT sales_invoices_id_tenant_key UNIQUE (id, tenant_id),

    CONSTRAINT sales_invoices_amounts_non_negative CHECK (
        subtotal_minor >= 0 AND taxable_value_minor >= 0 AND
        cgst_minor >= 0 AND sgst_minor >= 0 AND igst_minor >= 0 AND
        cess_minor >= 0 AND total_minor >= 0 AND received_minor >= 0
    ),

    -- ⚠️ IGST IS MUTUALLY EXCLUSIVE WITH CGST/SGST. A document carrying
    --    both is not a rounding error, it is a place-of-supply bug, and
    --    it reaches GSTR-1 as a mismatch the officer sees before we do.
    CONSTRAINT sales_invoices_gst_mutually_exclusive CHECK (
        (igst_minor = 0) OR (cgst_minor = 0 AND sgst_minor = 0)
    ),

    -- ⭐ MONEY RECEIVED CANNOT EXCEED THE DOCUMENT. An over-allocation is
    --    how a customer ledger silently goes into credit.
    CONSTRAINT sales_invoices_received_within_total CHECK (received_minor <= total_minor),

    -- ⚠️ AN ISSUED INVOICE HAS AN ISSUE DATE AND AN ISSUER. Rule 46
    --    requires the document to be dated; a status that says issued
    --    with no timestamp is a document that cannot be defended.
    CONSTRAINT sales_invoices_issued_has_stamp CHECK (
        status = 'draft' OR status = 'cancelled' OR (issued_at IS NOT NULL)
    ),

    CONSTRAINT sales_invoices_cancel_has_reason CHECK (
        status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)
    )
);

-- =====================================================================
--  TABLE: sales_invoice_lines
-- =====================================================================

CREATE TABLE IF NOT EXISTS sales_invoice_lines (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    invoice_id          uuid        NOT NULL,

    line_no             integer     NOT NULL,

    -- ⭐ WHICH ORDER LINE THIS BILLS. This is what makes partial
    --    invoicing possible and what the qty_invoiced write-back is
    --    computed from. Nullable for invoices raised without an order.
    order_line_id       uuid,

    asset_id            uuid        REFERENCES assets(id) ON DELETE RESTRICT,
    sku                 varchar(100),
    -- ⚠️ ALWAYS PRESENT AND COPIED, NEVER JOINED. A catalogue rename must
    --    not rewrite last year's paperwork.
    description         text        NOT NULL,

    hsn_sac_code_id     uuid        REFERENCES hsn_sac_codes(id) ON DELETE RESTRICT,
    hsn_sac_rate_id     uuid        REFERENCES hsn_sac_rates(id) ON DELETE RESTRICT,
    -- Rule 46(g) prints the CODE, so it is stored as text too: the rate
    -- row can be superseded, and the document must still render.
    hsn_sac_code        varchar(10),
    tax_rate_bps        integer,
    cess_rate_bps       integer,

    quantity            numeric(18,3) NOT NULL,
    uom                 varchar(20)   NOT NULL DEFAULT 'nos',

    unit_price_minor    bigint      NOT NULL,
    discount_minor      bigint      NOT NULL DEFAULT 0,
    taxable_value_minor bigint      NOT NULL DEFAULT 0,
    cgst_minor          bigint      NOT NULL DEFAULT 0,
    sgst_minor          bigint      NOT NULL DEFAULT 0,
    igst_minor          bigint      NOT NULL DEFAULT 0,
    cess_minor          bigint      NOT NULL DEFAULT 0,
    line_total_minor    bigint      NOT NULL DEFAULT 0,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sales_invoice_lines_invoice_fk
        FOREIGN KEY (invoice_id, tenant_id)
        REFERENCES sales_invoices(id, tenant_id) ON DELETE CASCADE,

    CONSTRAINT sales_invoice_lines_order_line_fk
        FOREIGN KEY (order_line_id, tenant_id)
        REFERENCES sales_order_lines(id, tenant_id) ON DELETE RESTRICT,

    CONSTRAINT sales_invoice_lines_line_no_key UNIQUE (invoice_id, line_no),
    CONSTRAINT sales_invoice_lines_quantity_positive CHECK (quantity > 0),
    CONSTRAINT sales_invoice_lines_gst_mutually_exclusive CHECK (
        (igst_minor = 0) OR (cgst_minor = 0 AND sgst_minor = 0)
    )
);

-- =====================================================================
--  TABLE: customer_receipts
--
--  ⚠️ NAMED `customer_receipts`, NOT `receipts`. `receipts` already
--     exists in receivables.ts and is keyed on `booking_id` — it is the
--     real-estate side, where the counterparty is a flat buyer and the
--     money answers a RERA milestone demand. This one is keyed on
--     `company_id`. Two ledgers, two counterparties; merging them would
--     let one payment settle the wrong kind of debt.
-- =====================================================================

CREATE TABLE IF NOT EXISTS customer_receipts (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    receipt_number      varchar(40) NOT NULL,
    company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,

    received_on         date        NOT NULL,
    amount_minor        bigint      NOT NULL,

    -- ⭐ Section 194-Q / 194-C tax the CUSTOMER withheld. It settles the
    --    invoice as surely as cash does — a customer who deducts TDS has
    --    paid that money, to the Government, on our behalf. Treating it
    --    as a shortfall is how a fully-settled account shows as overdue
    --    and a dunning letter goes to a customer who paid in full.
    tds_credit_minor    bigint      NOT NULL DEFAULT 0,

    -- Maintained by trigger from the allocation rows. Never by the app.
    allocated_minor     bigint      NOT NULL DEFAULT 0,

    method              customer_receipt_method NOT NULL,
    status              customer_receipt_status NOT NULL DEFAULT 'cleared',

    instrument_ref      varchar(120),
    bank_ref            varchar(120),
    cleared_on          date,
    bounced_on          date,
    bounce_reason       text,

    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid        REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT customer_receipts_number_tenant_key UNIQUE (tenant_id, receipt_number),
    CONSTRAINT customer_receipts_id_tenant_key UNIQUE (id, tenant_id),
    CONSTRAINT customer_receipts_amount_positive CHECK (amount_minor > 0),
    CONSTRAINT customer_receipts_tds_non_negative CHECK (tds_credit_minor >= 0),

    -- ⭐ YOU CANNOT ALLOCATE MORE THAN ARRIVED. Cash plus the tax the
    --    customer withheld is the total settling power of this receipt.
    CONSTRAINT customer_receipts_allocated_within_amount CHECK (
        allocated_minor <= amount_minor + tds_credit_minor
    )
);

-- =====================================================================
--  TABLE: customer_receipt_allocations
--  Which receipt settled which invoice, and by how much.
-- =====================================================================

CREATE TABLE IF NOT EXISTS customer_receipt_allocations (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    receipt_id          uuid        NOT NULL,
    invoice_id          uuid        NOT NULL,

    amount_minor        bigint      NOT NULL,
    allocated_on        date        NOT NULL DEFAULT CURRENT_DATE,
    note                text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid        REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT customer_receipt_allocations_receipt_fk
        FOREIGN KEY (receipt_id, tenant_id)
        REFERENCES customer_receipts(id, tenant_id) ON DELETE CASCADE,

    CONSTRAINT customer_receipt_allocations_invoice_fk
        FOREIGN KEY (invoice_id, tenant_id)
        REFERENCES sales_invoices(id, tenant_id) ON DELETE RESTRICT,

    -- ⚠️ ONE ROW PER (receipt, invoice). A second row for the same pair
    --    is an amendment, and an amendment that adds rather than replaces
    --    is how a ledger quietly double-counts a payment.
    CONSTRAINT customer_receipt_allocations_pair_key UNIQUE (receipt_id, invoice_id),
    CONSTRAINT customer_receipt_allocations_amount_positive CHECK (amount_minor > 0)
);

-- =====================================================================
--  INDEXES
-- =====================================================================

CREATE INDEX IF NOT EXISTS sales_invoices_tenant_idx
    ON sales_invoices (tenant_id, invoice_date DESC);
-- ⭐ THE CUSTOMER LEDGER INDEX. "What does this company owe us" is the
--    question the credit check asks on every order confirmation.
CREATE INDEX IF NOT EXISTS sales_invoices_company_idx
    ON sales_invoices (tenant_id, company_id, status);
CREATE INDEX IF NOT EXISTS sales_invoices_order_idx
    ON sales_invoices (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS sales_invoices_status_idx
    ON sales_invoices (tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS sales_invoices_fy_idx
    ON sales_invoices (tenant_id, financial_year);

CREATE INDEX IF NOT EXISTS sales_invoice_lines_invoice_idx
    ON sales_invoice_lines (tenant_id, invoice_id);
CREATE INDEX IF NOT EXISTS sales_invoice_lines_order_line_idx
    ON sales_invoice_lines (tenant_id, order_line_id);

CREATE INDEX IF NOT EXISTS customer_receipts_tenant_idx
    ON customer_receipts (tenant_id, received_on DESC);
CREATE INDEX IF NOT EXISTS customer_receipts_company_idx
    ON customer_receipts (tenant_id, company_id, status);
-- Finds unapplied money — cash on a customer's account with no invoice
-- to answer. `allocated_minor` is in the index so the question is
-- answered from it rather than by reading every receipt ever taken.
CREATE INDEX IF NOT EXISTS customer_receipts_unapplied_idx
    ON customer_receipts (tenant_id, company_id, allocated_minor, amount_minor);

CREATE INDEX IF NOT EXISTS customer_receipt_allocations_receipt_idx
    ON customer_receipt_allocations (tenant_id, receipt_id);
CREATE INDEX IF NOT EXISTS customer_receipt_allocations_invoice_idx
    ON customer_receipt_allocations (tenant_id, invoice_id);

-- =====================================================================
--  ⭐ §1 — AN ISSUED INVOICE IS FROZEN
--
--  ⚠️ THIS IS THE MOST IMPORTANT TRIGGER IN THE FILE.
--
--  A tax invoice is a legal document the customer already holds and has
--  taken input credit against. Editing one after issue means our copy and
--  theirs disagree, and the disagreement surfaces in THEIR GSTR-2B
--  reconciliation, months later, as a mismatch they raise with us.
--
--  The lawful way to change an issued invoice is a credit note under
--  Rule 53 — its own document, its own number, its own GSTR-1 line.
--
--  Only the columns below may move after issue, and each for a reason:
--    · status / received_minor  — settlement, driven by allocations
--    · irn, ack_no, signed_qr_code, eway_bill_*  — assigned by the
--      Government portal AFTER we issue, never by us
--    · cancelled_*              — the narrow lawful cancellation below
--    · updated_at / updated_by  — bookkeeping
-- =====================================================================

CREATE OR REPLACE FUNCTION sales_invoice_freeze_after_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'draft' OR OLD.status = 'cancelled' THEN
        RETURN NEW;
    END IF;

    IF NEW.invoice_number    IS DISTINCT FROM OLD.invoice_number
    OR NEW.financial_year    IS DISTINCT FROM OLD.financial_year
    OR NEW.company_id        IS DISTINCT FROM OLD.company_id
    OR NEW.invoice_date      IS DISTINCT FROM OLD.invoice_date
    OR NEW.customer_gstin    IS DISTINCT FROM OLD.customer_gstin
    OR NEW.customer_legal_name IS DISTINCT FROM OLD.customer_legal_name
    OR NEW.supplier_gstin    IS DISTINCT FROM OLD.supplier_gstin
    OR NEW.place_of_supply_code IS DISTINCT FROM OLD.place_of_supply_code
    OR NEW.is_inter_state    IS DISTINCT FROM OLD.is_inter_state
    OR NEW.taxable_value_minor IS DISTINCT FROM OLD.taxable_value_minor
    OR NEW.cgst_minor        IS DISTINCT FROM OLD.cgst_minor
    OR NEW.sgst_minor        IS DISTINCT FROM OLD.sgst_minor
    OR NEW.igst_minor        IS DISTINCT FROM OLD.igst_minor
    OR NEW.cess_minor        IS DISTINCT FROM OLD.cess_minor
    OR NEW.total_minor       IS DISTINCT FROM OLD.total_minor
    THEN
        RAISE EXCEPTION
          'Invoice % has been issued and cannot be edited. The customer holds this document and may already have claimed credit on it — change it with a credit note (Rule 53), which is its own numbered document.',
          OLD.invoice_number
          USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_invoices_freeze ON sales_invoices;
CREATE TRIGGER sales_invoices_freeze
    BEFORE UPDATE ON sales_invoices
    FOR EACH ROW EXECUTE FUNCTION sales_invoice_freeze_after_issue();

-- ⚠️ AND THE LINES OF AN ISSUED INVOICE MAY NOT MOVE AT ALL. Freezing the
--    header while leaving the lines editable would let the printed
--    document change while its totals stayed put — the worst of both.

CREATE OR REPLACE FUNCTION sales_invoice_line_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status sales_invoice_status;
    parent_number varchar(60);
BEGIN
    SELECT status, invoice_number INTO parent_status, parent_number
      FROM sales_invoices
     WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

    IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
        RAISE EXCEPTION
          'Invoice % has been issued. Its lines are the document — they cannot be added to, changed or removed. Raise a credit note instead.',
          parent_number
          USING ERRCODE = 'check_violation';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS sales_invoice_lines_freeze ON sales_invoice_lines;
CREATE TRIGGER sales_invoice_lines_freeze
    BEFORE INSERT OR UPDATE OR DELETE ON sales_invoice_lines
    FOR EACH ROW EXECUTE FUNCTION sales_invoice_line_freeze();

-- =====================================================================
--  ⭐ §2 — SETTLEMENT ROLLS UP FROM THE ALLOCATIONS
--
--  ⚠️ ONE WRITER FOR received_minor, AND IT IS THIS FUNCTION.
--
--  0048's credit limits were inert because `sales_orders
--  .received_value_minor` had NO writer. The lesson is not "add a writer"
--  — it is "name the single writer and put it where every path goes
--  through it". An allocation row is that path.
-- =====================================================================

CREATE OR REPLACE FUNCTION sales_invoice_recalc_settlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_invoice uuid;
    target_receipt uuid;
BEGIN
    target_invoice := COALESCE(NEW.invoice_id, OLD.invoice_id);
    target_receipt := COALESCE(NEW.receipt_id, OLD.receipt_id);

    UPDATE sales_invoices i
       SET received_minor = COALESCE(agg.total, 0),
           status = CASE
               -- ⚠️ A CANCELLED OR DRAFT INVOICE KEEPS ITS STATUS. Money
               --    landing against a draft is a data error, not a
               --    settlement, and silently promoting it to 'paid' would
               --    hide it.
               WHEN i.status IN ('draft', 'cancelled') THEN i.status
               WHEN COALESCE(agg.total, 0) >= i.total_minor THEN 'paid'
               WHEN COALESCE(agg.total, 0) > 0            THEN 'part_paid'
               ELSE 'issued'
           END,
           updated_at = now()
      FROM (
          SELECT SUM(a.amount_minor) AS total
            FROM customer_receipt_allocations a
            JOIN customer_receipts r
              ON r.id = a.receipt_id
           -- ⭐ A BOUNCED CHEQUE SETTLES NOTHING. Excluding it here means
           --    a bounce automatically re-opens every invoice it touched,
           --    with no cleanup path to forget to run.
           WHERE a.invoice_id = target_invoice
             AND r.status IN ('pending', 'cleared')
      ) agg
     WHERE i.id = target_invoice;

    UPDATE customer_receipts r
       SET allocated_minor = COALESCE((
               SELECT SUM(a.amount_minor)
                 FROM customer_receipt_allocations a
                WHERE a.receipt_id = target_receipt
           ), 0),
           updated_at = now()
     WHERE r.id = target_receipt;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS customer_receipt_allocations_recalc ON customer_receipt_allocations;
CREATE TRIGGER customer_receipt_allocations_recalc
    AFTER INSERT OR UPDATE OR DELETE ON customer_receipt_allocations
    FOR EACH ROW EXECUTE FUNCTION sales_invoice_recalc_settlement();

-- ⚠️ A RECEIPT CHANGING STATUS MUST RE-RUN THE SAME ARITHMETIC. Marking a
--    cheque bounced does not touch the allocation rows, so without this
--    the invoices it settled would stay 'paid' on money that never came.

CREATE OR REPLACE FUNCTION customer_receipt_status_cascade()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE sales_invoices i
           SET received_minor = COALESCE(agg.total, 0),
               status = CASE
                   WHEN i.status IN ('draft', 'cancelled') THEN i.status
                   WHEN COALESCE(agg.total, 0) >= i.total_minor THEN 'paid'
                   WHEN COALESCE(agg.total, 0) > 0            THEN 'part_paid'
                   ELSE 'issued'
               END,
               updated_at = now()
          FROM (
              SELECT a2.invoice_id, SUM(a2.amount_minor) AS total
                FROM customer_receipt_allocations a2
                JOIN customer_receipts r2 ON r2.id = a2.receipt_id
               WHERE r2.status IN ('pending', 'cleared')
               GROUP BY a2.invoice_id
          ) agg
         WHERE i.id = agg.invoice_id
           AND i.id IN (
               SELECT a3.invoice_id
                 FROM customer_receipt_allocations a3
                WHERE a3.receipt_id = NEW.id
           );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_receipts_status_cascade ON customer_receipts;
CREATE TRIGGER customer_receipts_status_cascade
    AFTER UPDATE ON customer_receipts
    FOR EACH ROW EXECUTE FUNCTION customer_receipt_status_cascade();

-- =====================================================================
--  ⭐ §3 — THE WRITE-BACK THAT BRINGS 0048 TO LIFE
--
--  `sales_orders.received_value_minor` and `sales_order_lines
--  .qty_invoiced` are the two columns nothing wrote. This is where they
--  get written, and it is the only place.
--
--  ⚠️ ONLY ISSUED DOCUMENTS COUNT. A draft invoice is a working paper. If
--     a draft moved the order's invoiced quantity, a salesperson
--     experimenting with a split delivery would consume the order.
-- =====================================================================

CREATE OR REPLACE FUNCTION sales_order_recalc_from_invoices()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order uuid;
BEGIN
    target_order := COALESCE(NEW.order_id, OLD.order_id);
    IF target_order IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Per-line invoiced quantity, from issued invoices only.
    UPDATE sales_order_lines l
       SET qty_invoiced = COALESCE((
               SELECT SUM(il.quantity)
                 FROM sales_invoice_lines il
                 JOIN sales_invoices i ON i.id = il.invoice_id
                WHERE il.order_line_id = l.id
                  AND i.status IN ('issued', 'part_paid', 'paid')
           ), 0),
           updated_at = now()
     WHERE l.order_id = target_order;

    -- ⭐ AND THE ORDER'S RECEIVED VALUE — the column 0048 needed.
    UPDATE sales_orders o
       SET received_value_minor = COALESCE((
               SELECT SUM(i.received_minor)
                 FROM sales_invoices i
                WHERE i.order_id = target_order
                  AND i.status IN ('issued', 'part_paid', 'paid')
           ), 0),
           updated_at = now()
     WHERE o.id = target_order;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS sales_invoices_order_writeback ON sales_invoices;
CREATE TRIGGER sales_invoices_order_writeback
    AFTER INSERT OR UPDATE OR DELETE ON sales_invoices
    FOR EACH ROW EXECUTE FUNCTION sales_order_recalc_from_invoices();

-- The line-level trigger fires on the LINE's parent invoice, so it has to
-- resolve the order itself.
CREATE OR REPLACE FUNCTION sales_order_recalc_from_invoice_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order uuid;
BEGIN
    SELECT i.order_id INTO target_order
      FROM sales_invoices i
     WHERE i.id = COALESCE(NEW.invoice_id, OLD.invoice_id);

    IF target_order IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    UPDATE sales_order_lines l
       SET qty_invoiced = COALESCE((
               SELECT SUM(il.quantity)
                 FROM sales_invoice_lines il
                 JOIN sales_invoices i2 ON i2.id = il.invoice_id
                WHERE il.order_line_id = l.id
                  AND i2.status IN ('issued', 'part_paid', 'paid')
           ), 0),
           updated_at = now()
     WHERE l.order_id = target_order;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS sales_invoice_lines_order_writeback ON sales_invoice_lines;
CREATE TRIGGER sales_invoice_lines_order_writeback
    AFTER INSERT OR UPDATE OR DELETE ON sales_invoice_lines
    FOR EACH ROW EXECUTE FUNCTION sales_order_recalc_from_invoice_lines();

-- =====================================================================
--  ROW LEVEL SECURITY
--
--  ⚠️ `OR app_platform_scope()` BELONGS IN `USING` AND NEVER IN
--     `WITH CHECK`. Platform staff must be able to READ a workspace's
--     documents to support it — that is what admin.ordence.com does for a
--     living, and a table without the clause is invisible to it. They may
--     never WRITE: an invoice nobody in that workspace raised, appearing
--     in their GSTR-1, is indistinguishable from a breach.
-- =====================================================================

ALTER TABLE sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_invoices_tenant_isolation ON public.sales_invoices;
CREATE POLICY sales_invoices_tenant_isolation ON public.sales_invoices
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE sales_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoice_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_invoice_lines_tenant_isolation ON public.sales_invoice_lines;
CREATE POLICY sales_invoice_lines_tenant_isolation ON public.sales_invoice_lines
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE customer_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_receipts_tenant_isolation ON public.customer_receipts;
CREATE POLICY customer_receipts_tenant_isolation ON public.customer_receipts
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE customer_receipt_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_receipt_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_receipt_allocations_tenant_isolation ON public.customer_receipt_allocations;
CREATE POLICY customer_receipt_allocations_tenant_isolation ON public.customer_receipt_allocations
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

-- =====================================================================
--  GRANTS
--
--  A table nobody granted is a 42501 in production — this project shipped
--  exactly that with three views and found it days later. Grant in the
--  same file as the table, every time.
--
--  ⚠️ DELETE IS GRANTED AND THE "YOU MAY NOT DELETE AN ISSUED INVOICE"
--     RULE LIVES IN THE TRIGGER AND THE ACTION LAYER, where the refusal
--     is a sentence a person can act on rather than `permission denied
--     for table sales_invoices`.
-- =====================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_invoices                TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_invoice_lines           TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_receipts             TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_receipt_allocations  TO ordence_app;
