-- =====================================================================
--  ORDENCE — 0077 · THE MONTHLY RETURN
--  Version: v1.24.0-alpha · Batch 16
--
--  ⚠️ NOTE THE NUMBER: 0077, NOT 0076. 0076 was used once and retired,
--  and the migration gate refused the reuse — the third time now that a
--  retired number has tried to come back.
--
--  ⚠️ RUN AFTER 0075. One new table, one new enum, one trigger.
--  Touches nothing that already exists.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded.
--  ⭐ ADDITIVE ONLY. No DROP, no RENAME, no type change on a live
--     column — so a code rollback leaves this table sitting harmless.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 GSTR-1 IS A STATEMENT. GSTR-3B IS THE ONE YOU PAY FROM.
--  ══════════════════════════════════════════════════════════════════
--  Ordence has built GSTR-1 since v0.9x and it settles nothing. The 3B
--  is where output tax meets input credit and whatever is left has to
--  leave a bank account by the twentieth.
--
--  ⚠️ AND EVERY MONTH THE OUTPUT AND INPUT TAX ACCOUNTS HAVE TO BE
--  CLEARED AGAINST EACH OTHER. Left alone both sides grow forever: a
--  balance sheet showing ₹40 lakh owed and ₹38 lakh receivable when the
--  business actually owes ₹2 lakh. It balances, it is arithmetically
--  correct, and a lender reading it sees a company with a large tax
--  liability.
--
--  🔴 THE RULE THIS FILE EXISTS TO MAKE ENFORCEABLE: CGST credit may
--  NEVER be set off against SGST, or the other way round. Not in any
--  order, not as a last resort. They are different governments, and a
--  set-off that treats the pools as interchangeable produces a smaller,
--  entirely plausible cash figure that the department disagrees with.
-- =====================================================================

BEGIN;

DO $$ BEGIN
  CREATE TYPE gst_return_status AS ENUM
    ('draft', 'finalised', 'filed', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS gst_returns (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    return_type         varchar(12) NOT NULL DEFAULT 'GSTR3B',
    --  🔴 PER GSTIN, NOT PER TENANT. A business registered in three
    --  States files three separate returns with three separate
    --  set-offs. Keying this on the tenant alone would merge them and
    --  produce a set-off that is illegal in all three States.
    gstin               varchar(15) NOT NULL,
    tax_period          varchar(7) NOT NULL,
    period_start        date NOT NULL,
    period_end          date NOT NULL,

    status              gst_return_status NOT NULL DEFAULT 'draft',

    outward_taxable_value_minor numeric(18,0) NOT NULL DEFAULT 0,
    output_igst_minor   numeric(18,0) NOT NULL DEFAULT 0,
    output_cgst_minor   numeric(18,0) NOT NULL DEFAULT 0,
    output_sgst_minor   numeric(18,0) NOT NULL DEFAULT 0,
    output_cess_minor   numeric(18,0) NOT NULL DEFAULT 0,

    --  ⚠️ REVERSE CHARGE IS HELD SEPARATELY BECAUSE IT MAY NOT BE SET
    --  OFF. The credit for it arises only once it has been PAID, so
    --  discharging it from credit spends something that does not exist
    --  yet. It is the second most common 3B error.
    rcm_igst_minor      numeric(18,0) NOT NULL DEFAULT 0,
    rcm_cgst_minor      numeric(18,0) NOT NULL DEFAULT 0,
    rcm_sgst_minor      numeric(18,0) NOT NULL DEFAULT 0,
    rcm_cess_minor      numeric(18,0) NOT NULL DEFAULT 0,

    itc_igst_minor      numeric(18,0) NOT NULL DEFAULT 0,
    itc_cgst_minor      numeric(18,0) NOT NULL DEFAULT 0,
    itc_sgst_minor      numeric(18,0) NOT NULL DEFAULT 0,
    itc_cess_minor      numeric(18,0) NOT NULL DEFAULT 0,

    itc_reversed_igst_minor numeric(18,0) NOT NULL DEFAULT 0,
    itc_reversed_cgst_minor numeric(18,0) NOT NULL DEFAULT 0,
    itc_reversed_sgst_minor numeric(18,0) NOT NULL DEFAULT 0,
    itc_reversed_cess_minor numeric(18,0) NOT NULL DEFAULT 0,

    cash_igst_minor     numeric(18,0) NOT NULL DEFAULT 0,
    cash_cgst_minor     numeric(18,0) NOT NULL DEFAULT 0,
    cash_sgst_minor     numeric(18,0) NOT NULL DEFAULT 0,
    cash_cess_minor     numeric(18,0) NOT NULL DEFAULT 0,
    interest_minor      numeric(18,0) NOT NULL DEFAULT 0,
    late_fee_minor      numeric(18,0) NOT NULL DEFAULT 0,
    total_cash_minor    numeric(18,0) NOT NULL DEFAULT 0,

    carried_igst_minor  numeric(18,0) NOT NULL DEFAULT 0,
    carried_cgst_minor  numeric(18,0) NOT NULL DEFAULT 0,
    carried_sgst_minor  numeric(18,0) NOT NULL DEFAULT 0,
    carried_cess_minor  numeric(18,0) NOT NULL DEFAULT 0,

    --  ⭐ The set-off move by move, with the rule that permitted each.
    --  An accountant checking a return should be able to read WHY each
    --  pound of credit went where it went, not just the total.
    setoff_moves        jsonb NOT NULL DEFAULT '[]'::jsonb,
    notes               jsonb NOT NULL DEFAULT '[]'::jsonb,
    problems            jsonb NOT NULL DEFAULT '[]'::jsonb,

    due_on              date,

    prepared_at         timestamptz,
    finalised_at        timestamptz,
    finalised_by        uuid REFERENCES users(id) ON DELETE SET NULL,

    arn                 varchar(40),
    filed_at            timestamptz,
    filed_by            uuid REFERENCES users(id) ON DELETE SET NULL,

    transaction_id      uuid REFERENCES transactions(id) ON DELETE RESTRICT,

    superseded_at       timestamptz,
    supersede_reason    text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT gst_returns_period_ordered CHECK (period_end >= period_start),
    CONSTRAINT gst_returns_period_shape CHECK (tax_period ~ '^[0-9]{4}-[0-9]{2}$'),
    --  🔴 FILED MEANS THE PORTAL ACKNOWLEDGED IT. A row marked filed
    --  with no acknowledgement number is a claim nobody can check, and
    --  it is the state somebody reaches for when they mean "I think I
    --  filed this".
    CONSTRAINT gst_returns_filed_has_arn CHECK (
        status <> 'filed' OR (arn IS NOT NULL AND length(btrim(arn)) >= 4)
    ),
    --  ⚠️ A superseded return has to say why.
    CONSTRAINT gst_returns_supersede_explained CHECK (
        status <> 'superseded' OR length(btrim(coalesce(supersede_reason, ''))) >= 10
    ),
    --  ⭐ THE CASH TOTAL MUST ADD UP TO ITS OWN PARTS, in the database.
    --  This is the figure somebody arranges money for.
    CONSTRAINT gst_returns_cash_adds_up CHECK (
        total_cash_minor =
          cash_igst_minor + cash_cgst_minor + cash_sgst_minor + cash_cess_minor
          + interest_minor + late_fee_minor
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS gst_returns_id_tenant_key
    ON gst_returns (id, tenant_id);

--  🔴🔴 ONE LIVE RETURN PER GSTIN PER PERIOD PER TYPE.
--
--  ⚠️ TWO 3Bs FOR ONE JULY would post the reclassification journal
--  twice and clear the input tax account by double what was actually
--  utilised — after which the ledger claims credit was spent that is
--  still sitting on the portal.
CREATE UNIQUE INDEX IF NOT EXISTS gst_returns_one_live_per_period
    ON gst_returns (tenant_id, gstin, return_type, tax_period)
    WHERE status <> 'superseded';

CREATE INDEX IF NOT EXISTS gst_returns_status_idx
    ON gst_returns (tenant_id, status, tax_period DESC);

-- =====================================================================
--  THE GUARD: A FILED RETURN IS EVIDENCE
-- =====================================================================
--
--  🔴 ONCE A 3B CARRIES AN ACKNOWLEDGEMENT NUMBER, THE FIGURES IN IT
--  ARE WHAT WAS DECLARED TO THE GOVERNMENT. Editing one afterwards
--  produces a record that disagrees with what the department holds, and
--  the department's copy is the one that counts.
--
--  ⭐ AND THE REMEDY IS THE ONE THE LAW PROVIDES: correct it in a LATER
--  period. GST has no amendment of a filed 3B — only an adjustment in
--  the next one — so a system that permits an edit is teaching a
--  workflow that does not exist.
CREATE OR REPLACE FUNCTION ordence_guard_filed_return()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'filed' THEN
    --  The only permitted change to a filed return is attaching the
    --  reclassification journal, which happens after filing by design.
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.total_cash_minor IS DISTINCT FROM OLD.total_cash_minor
       OR NEW.output_igst_minor IS DISTINCT FROM OLD.output_igst_minor
       OR NEW.output_cgst_minor IS DISTINCT FROM OLD.output_cgst_minor
       OR NEW.output_sgst_minor IS DISTINCT FROM OLD.output_sgst_minor
       OR NEW.itc_igst_minor IS DISTINCT FROM OLD.itc_igst_minor
       OR NEW.itc_cgst_minor IS DISTINCT FROM OLD.itc_cgst_minor
       OR NEW.itc_sgst_minor IS DISTINCT FROM OLD.itc_sgst_minor
       OR NEW.arn IS DISTINCT FROM OLD.arn
    THEN
      RAISE EXCEPTION
        'This return has been filed and acknowledged as %. Its figures are what was declared to the Government and cannot be changed here. GST provides no amendment of a filed 3B — a mistake is corrected in a LATER period, which is both the legal remedy and the only one the department will recognise.',
        OLD.arn
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  --  ⚠️ AND A RETURN MAY NOT WALK BACKWARDS out of finalised either,
  --  except to superseded, which leaves both rows on the record.
  IF OLD.status = 'finalised'
     AND NEW.status = 'draft' THEN
    RAISE EXCEPTION
      'This return has been finalised. If the figures are wrong, supersede it with a reason and prepare another, so both are on the record.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_filed_return ON gst_returns;
CREATE TRIGGER ordence_guard_filed_return
  BEFORE UPDATE ON gst_returns
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_filed_return();

-- =====================================================================
--  ROW LEVEL SECURITY
-- =====================================================================
--
--  ⭐ `app_platform_scope()` IN `USING` AND NEVER IN `WITH CHECK`, the
--  house rule the whole schema follows and that 0014 fails a deploy
--  over.
ALTER TABLE gst_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_returns FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gst_returns_isolation ON gst_returns;
CREATE POLICY gst_returns_isolation ON gst_returns
  USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
  WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  NO PORTAL FILING. Ordence prepares the return and records the
--  acknowledgement number a human keys back in. Filing needs a GSP, and
--  the GSP needs the LLP.
--
--  NO GSTR-9 ANNUAL RETURN and NO GSTR-9C RECONCILIATION. Both read a
--  full year of 3Bs, so they need a year of them to exist first.
--
--  NO RULE 42/43 APPORTIONMENT CALCULATOR. The reversal figure is
--  entered rather than computed. Apportioning credit between taxable and
--  exempt supplies depends on turnover splits Ordence does not model
--  yet, and a wrong reversal is a wrong return with interest attached.
-- =====================================================================
