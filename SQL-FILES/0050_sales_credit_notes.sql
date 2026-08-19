-- 0050_sales_credit_notes.sql
-- ⭐ THE ONLY LAWFUL WAY TO REDUCE AN ISSUED TAX INVOICE. Phase 52.
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS
-- ══════════════════════════════════════════════════════════════════════
-- 0049 froze issued invoices with a trigger: after issue, the figures
-- cannot move. That was correct and it left a hole — a sales return had
-- nowhere to go at all. The customer sends goods back and the system has
-- no way to say so.
--
-- Section 34(1) of the CGST Act: where the taxable value or tax charged
-- in a tax invoice EXCEEDS what is actually payable — a return, a rate
-- revision, a deficiency, a post-sale discount agreed at the time of
-- supply — the supplier "may issue a credit note". It is its own
-- document, with its own consecutive number, and it reports on its own
-- line of GSTR-1.
--
-- ⚠️ A CREDIT NOTE IS NOT AN EDIT AND MUST NEVER BECOME ONE. The customer
--    holds the original invoice and may already have claimed input credit
--    on it. Both documents must continue to exist, and the pair must
--    reconcile — theirs and ours.
--
-- ⚠️ THERE IS NO DEBIT NOTE IN THIS FILE. A debit note INCREASES what is
--    owed, and under Section 34(3) that is a supply — it needs its own
--    tax determination, not a mirror of this table. Doing both at once
--    would produce one table with a sign column, and a sign column is how
--    a refund eventually gets recorded as a charge.

CREATE TABLE IF NOT EXISTS sales_credit_notes (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    credit_note_number  varchar(60) NOT NULL,
    financial_year      varchar(9)  NOT NULL,
    status              sales_invoice_status NOT NULL DEFAULT 'draft',

    -- ⭐ ALWAYS AGAINST AN INVOICE. NOT NULL, and RESTRICT.
    --
    -- ⚠️ A FREE-FLOATING CREDIT NOTE IS UNRECONCILABLE. GSTR-1 reports a
    --    credit note against the original document; a customer matches it
    --    against the invoice in their books. One that names no invoice is
    --    a reduction nobody can tie to a supply, and it is exactly what an
    --    officer asks about first.
    invoice_id          uuid        NOT NULL,
    company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,

    note_date           date        NOT NULL,

    -- Section 34(1) grounds. varchar rather than an enum so a workspace
    -- can extend without a type migration — same reasoning as `scope` on
    -- approval_limits.
    reason_code         varchar(40) NOT NULL,
    -- 'sales_return' | 'rate_revision' | 'deficiency' | 'post_sale_discount' | 'other'
    reason              text        NOT NULL,

    -- Frozen from the invoice, never re-joined. Rule 46 applies to a
    -- credit note too (Rule 53(1A) lists substantially the same fields).
    customer_legal_name varchar(255),
    customer_gstin      varchar(15),
    supplier_gstin      varchar(15),
    place_of_supply_code varchar(2),
    is_inter_state      boolean     NOT NULL DEFAULT false,

    currency            varchar(3)  NOT NULL DEFAULT 'INR',
    taxable_value_minor bigint      NOT NULL DEFAULT 0,
    cgst_minor          bigint      NOT NULL DEFAULT 0,
    sgst_minor          bigint      NOT NULL DEFAULT 0,
    igst_minor          bigint      NOT NULL DEFAULT 0,
    cess_minor          bigint      NOT NULL DEFAULT 0,
    round_off_minor     bigint      NOT NULL DEFAULT 0,
    total_minor         bigint      NOT NULL DEFAULT 0,

    issued_at           timestamptz,
    issued_by           uuid        REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at        timestamptz,
    cancel_reason       text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid        REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT sales_credit_notes_number_tenant_key UNIQUE (tenant_id, credit_note_number),
    CONSTRAINT sales_credit_notes_id_tenant_key UNIQUE (id, tenant_id),
    CONSTRAINT sales_credit_notes_invoice_fk
        FOREIGN KEY (invoice_id, tenant_id)
        REFERENCES sales_invoices(id, tenant_id) ON DELETE RESTRICT,

    CONSTRAINT sales_credit_notes_amounts_non_negative CHECK (
        taxable_value_minor >= 0 AND cgst_minor >= 0 AND sgst_minor >= 0
        AND igst_minor >= 0 AND cess_minor >= 0 AND total_minor >= 0
    ),
    CONSTRAINT sales_credit_notes_gst_mutually_exclusive CHECK (
        (igst_minor = 0) OR (cgst_minor = 0 AND sgst_minor = 0)
    ),
    CONSTRAINT sales_credit_notes_issued_has_stamp CHECK (
        status = 'draft' OR status = 'cancelled' OR issued_at IS NOT NULL
    )
);

CREATE TABLE IF NOT EXISTS sales_credit_note_lines (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    credit_note_id      uuid        NOT NULL,
    line_no             integer     NOT NULL,

    -- Which invoice line is being reduced. Nullable only for a
    -- whole-document adjustment with no line detail.
    invoice_line_id     uuid,

    description         text        NOT NULL,
    hsn_sac_code        varchar(10),
    tax_rate_bps        integer,
    quantity            numeric(18,3) NOT NULL,
    uom                 varchar(20) NOT NULL DEFAULT 'nos',
    unit_price_minor    bigint      NOT NULL,
    taxable_value_minor bigint      NOT NULL DEFAULT 0,
    cgst_minor          bigint      NOT NULL DEFAULT 0,
    sgst_minor          bigint      NOT NULL DEFAULT 0,
    igst_minor          bigint      NOT NULL DEFAULT 0,
    cess_minor          bigint      NOT NULL DEFAULT 0,
    line_total_minor    bigint      NOT NULL DEFAULT 0,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sales_credit_note_lines_parent_fk
        FOREIGN KEY (credit_note_id, tenant_id)
        REFERENCES sales_credit_notes(id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT sales_credit_note_lines_line_no_key UNIQUE (credit_note_id, line_no),
    CONSTRAINT sales_credit_note_lines_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS sales_credit_notes_tenant_idx
    ON sales_credit_notes (tenant_id, note_date DESC);
CREATE INDEX IF NOT EXISTS sales_credit_notes_invoice_idx
    ON sales_credit_notes (tenant_id, invoice_id);
CREATE INDEX IF NOT EXISTS sales_credit_notes_company_idx
    ON sales_credit_notes (tenant_id, company_id, status);
CREATE INDEX IF NOT EXISTS sales_credit_note_lines_parent_idx
    ON sales_credit_note_lines (tenant_id, credit_note_id);

-- =====================================================================
--  ⭐ §1 — A CREDIT NOTE MAY NOT EXCEED WHAT THE INVOICE CHARGED
--
--  ⚠️ THIS IS THE GUARANTEE THAT CANNOT LIVE IN THE APPLICATION.
--
--  Credit notes are raised one at a time, often months apart, by
--  different people. A check that summed them in TypeScript would be
--  correct on one write path and absent on the public API of Phase 41, on
--  a back-fill, and on anything an operator does in a console.
--
--  Over-crediting is not a rounding error: it is a refund of tax that was
--  never collected, and it reaches GSTR-1 as a negative supply the
--  Government will notice before we do.
-- =====================================================================

CREATE OR REPLACE FUNCTION sales_credit_note_within_invoice()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    invoice_total bigint;
    invoice_ref   varchar(60);
    credited      bigint;
BEGIN
    -- Only issued credit notes consume the invoice's headroom. A draft is
    -- a working paper and must not block a colleague's legitimate one.
    IF NEW.status = 'draft' OR NEW.status = 'cancelled' THEN
        RETURN NEW;
    END IF;

    SELECT total_minor, invoice_number INTO invoice_total, invoice_ref
      FROM sales_invoices WHERE id = NEW.invoice_id;

    SELECT COALESCE(SUM(total_minor), 0) INTO credited
      FROM sales_credit_notes
     WHERE invoice_id = NEW.invoice_id
       AND id <> NEW.id
       AND status NOT IN ('draft', 'cancelled');

    IF credited + NEW.total_minor > invoice_total THEN
        RAISE EXCEPTION
          'Credit notes against invoice % would total %, which is more than the invoice charged (%). A credit note can only reverse what was actually billed.',
          invoice_ref,
          (credited + NEW.total_minor) / 100.0,
          invoice_total / 100.0
          USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_credit_notes_within_invoice ON sales_credit_notes;
CREATE TRIGGER sales_credit_notes_within_invoice
    BEFORE INSERT OR UPDATE ON sales_credit_notes
    FOR EACH ROW EXECUTE FUNCTION sales_credit_note_within_invoice();

-- =====================================================================
--  ⭐ §2 — AN ISSUED CREDIT NOTE IS FROZEN, exactly as an invoice is.
-- =====================================================================

CREATE OR REPLACE FUNCTION sales_credit_note_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'draft' OR OLD.status = 'cancelled' THEN
        RETURN NEW;
    END IF;

    IF NEW.credit_note_number IS DISTINCT FROM OLD.credit_note_number
    OR NEW.invoice_id         IS DISTINCT FROM OLD.invoice_id
    OR NEW.note_date          IS DISTINCT FROM OLD.note_date
    OR NEW.taxable_value_minor IS DISTINCT FROM OLD.taxable_value_minor
    OR NEW.total_minor        IS DISTINCT FROM OLD.total_minor
    THEN
        RAISE EXCEPTION
          'Credit note % has been issued and cannot be edited. The customer holds it and has reversed credit against it.',
          OLD.credit_note_number
          USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_credit_notes_freeze ON sales_credit_notes;
CREATE TRIGGER sales_credit_notes_freeze
    BEFORE UPDATE ON sales_credit_notes
    FOR EACH ROW EXECUTE FUNCTION sales_credit_note_freeze();

-- =====================================================================
--  ROW LEVEL SECURITY  — platform staff READ, never WRITE.
-- =====================================================================

ALTER TABLE sales_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_credit_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_credit_notes_tenant_isolation ON public.sales_credit_notes;
CREATE POLICY sales_credit_notes_tenant_isolation ON public.sales_credit_notes
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE sales_credit_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_credit_note_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_credit_note_lines_tenant_isolation ON public.sales_credit_note_lines;
CREATE POLICY sales_credit_note_lines_tenant_isolation ON public.sales_credit_note_lines
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_credit_notes      TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_credit_note_lines TO ordence_app;
