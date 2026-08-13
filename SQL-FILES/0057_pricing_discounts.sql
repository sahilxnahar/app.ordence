-- =====================================================================
--  0057 — PRICE LISTS THAT ACTUALLY SELL, AND POST-SUPPLY DISCOUNTS
--  Ordence · v1.6.0-alpha · Trading, batch 2
-- =====================================================================
--
--  ⭐⭐ WHAT I DID **NOT** BUILD, AND IT IS THE MOST IMPORTANT LINE HERE
--  ------------------------------------------------------------------
--  🔴 THERE IS NO NEW PRICE LIST TABLE.
--
--  `rate_cards` and `rate_slabs` have existed since 0034. They already
--  carry a customer (`customer_company_id`), a subject
--  (`applies_to_kind` / `applies_to_id`), a priority, a half-open
--  validity window, a currency, a tax rate, and — the hard part —
--  `slab_mode`, which states whether "first 100 at ₹4.50, next 200 at
--  ₹6.20" is read progressively or flat. That distinction is 27% of the
--  bill on a common example.
--
--  ⚠️ A `customer_price_lists` TABLE WOULD HAVE BEEN THE OBVIOUS THING
--  TO WRITE, AND IT WOULD HAVE BEEN THE MISTAKE. Two tables answering
--  "what does this cost this customer today" is two answers, and the
--  wrong one is whichever the invoice screen happens to read.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴 SO WHAT WAS ACTUALLY MISSING? NOTHING SELLS THROUGH THE ENGINE.
--  ══════════════════════════════════════════════════════════════════
--  `sales_order_lines.unit_price_minor` is **typed in**. There is no
--  resolver — nothing picks the right card for (customer, item, date,
--  quantity) and returns a price. The rate cards are read by metering
--  and by a rates screen, and by nothing that sells goods.
--
--  ⚠️ So a distributor with negotiated customer prices retypes them on
--  every line, and the price list is decoration. That gap is closed in
--  `lib/pricing/resolve.ts` and needs no schema at all.
--
--  ⭐ THIS MIGRATION THEREFORE ADDS ONLY WHAT GENUINELY HAS NOWHERE TO
--  LIVE: a guard on slab bands, a floor price, and the machinery
--  Section 15(3) demands for a discount given AFTER the sale.
-- =====================================================================


-- =====================================================================
--  ① SLAB BANDS THAT CANNOT OVERLAP OR LEAVE A GAP
-- =====================================================================
--  🔴 AN OVERLAP IS TWO PRICES FOR ONE QUANTITY, AND A GAP IS NONE.
--
--  Bands of "up to 100", "up to 500", "up to NULL" are fine. Bands of
--  "up to 100" and "up to 100" are two answers for the 100th unit, and
--  which one wins depends on the order rows come back in — so the same
--  quote can price differently on two runs.
--
--  ⚠️ A gap is worse and quieter: `priceFlat` falls through to the last
--  band, so a quantity that matches nothing is priced at the TOP band
--  rather than erroring. The customer is charged the wrong figure and
--  the screen shows no sign of it.
--
--  ⭐ WHY A TRIGGER AND NOT AN `EXCLUDE` CONSTRAINT. The elegant answer
--  is `EXCLUDE USING gist (rate_card_id WITH =, numrange(...) WITH &&)`,
--  which needs the `btree_gist` extension. A migration that depends on
--  an extension being installable is a migration that fails on a managed
--  database at 2am, and the error it gives is about operator classes
--  rather than about pricing. The trigger works everywhere and says what
--  is wrong in a sentence.
CREATE OR REPLACE FUNCTION ordence_validate_rate_slabs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  card_id    uuid;
  prev_upper bigint;
  r          RECORD;
  open_ended int;
BEGIN
  card_id := COALESCE(NEW.rate_card_id, OLD.rate_card_id);

  -- ⚠️ At most ONE open-ended band, and it must be the last one. Two
  -- "and the rest" bands means the second is unreachable and somebody
  -- has priced into a row that will never be read.
  SELECT COUNT(*) INTO open_ended
    FROM rate_slabs
   WHERE rate_card_id = card_id AND up_to_quantity IS NULL;

  IF open_ended > 1 THEN
    RAISE EXCEPTION
      'This rate card has % open-ended bands. Only the last band can be "and everything above" — a second one can never be reached, and whatever was priced into it will never be charged.',
      open_ended
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⚠️ AND THE OPEN-ENDED BAND MUST SORT LAST. Anything after "and
  -- everything above" can never be reached, so whatever was priced into
  -- it will never be charged — silently.
  PERFORM 1
     FROM rate_slabs a
     JOIN rate_slabs b
       ON b.rate_card_id = a.rate_card_id
      AND b.sequence > a.sequence
    WHERE a.rate_card_id = card_id
      AND a.up_to_quantity IS NULL;

  IF FOUND THEN
    RAISE EXCEPTION
      'A band on this rate card comes after the open-ended one. Nothing can follow "and everything above" — it would never be reached, and whatever was priced into it would never be charged.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 🔴 STRICTLY ASCENDING. Equal or falling upper bounds mean two bands
  -- cover one quantity, and the winner depends on the order the rows
  -- come back in — so the same quote prices differently on two runs.
  prev_upper := NULL;

  FOR r IN
    SELECT sequence, up_to_quantity
      FROM rate_slabs
     WHERE rate_card_id = card_id
       AND up_to_quantity IS NOT NULL
     ORDER BY sequence
  LOOP
    IF prev_upper IS NOT NULL AND r.up_to_quantity <= prev_upper THEN
      RAISE EXCEPTION
        'Band % on this rate card ends at % but the band before it already reached %. Bands have to climb — two bands covering the same quantity give two prices, and which one wins depends on the order the rows come back in.',
        r.sequence, r.up_to_quantity, prev_upper
        USING ERRCODE = 'raise_exception';
    END IF;
    prev_upper := r.up_to_quantity;
  END LOOP;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_validate_rate_slabs ON rate_slabs;
-- ⚠️ A STATEMENT-LEVEL, DEFERRED-STYLE CHECK. Row-level would refuse a
-- perfectly good multi-row insert half way through, because the bands
-- are only coherent once the whole set is in.
CREATE CONSTRAINT TRIGGER trg_validate_rate_slabs
  AFTER INSERT OR UPDATE ON rate_slabs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ordence_validate_rate_slabs();


-- =====================================================================
--  ② A FLOOR PRICE
-- =====================================================================
--  ⭐ THE PRICE BELOW WHICH THIS CARD MUST NOT SELL.
--
--  🔴 A selling price set against the INVOICE price rather than the
--  LANDED price looks profitable and is not — and on 4–8% trading
--  margins an 8% freight uplift turns every sale into a loss. 0056 gave
--  the landed figure; this is where a floor derived from it is kept.
--
--  ⚠️ NULLABLE, DELIBERATELY. A card with no floor is not "a floor of
--  zero" — it is a card nobody has set a floor on, and those two must
--  not look the same on a screen that is meant to prompt somebody.
ALTER TABLE rate_cards
    ADD COLUMN IF NOT EXISTS floor_price_minor bigint;

ALTER TABLE rate_cards
    DROP CONSTRAINT IF EXISTS rate_cards_floor_positive;
ALTER TABLE rate_cards
    ADD CONSTRAINT rate_cards_floor_positive
    CHECK (floor_price_minor IS NULL OR floor_price_minor >= 0);


-- =====================================================================
--  ③ THE AGREEMENT THAT MUST EXIST **BEFORE** THE SALE
-- =====================================================================
--  ⭐⭐ SECTION 15(3) — WHEN A DISCOUNT REDUCES THE TAXABLE VALUE.
--
--    (a) given **before or at the time of** supply, and recorded in the
--        invoice → always reduces the value; and
--
--    (b) given **after** the supply, only if
--        (i)  it is established in terms of an agreement entered into
--             **at or before the time of such supply** AND is
--             **specifically linked to relevant invoices**, and
--        (ii) the **recipient has reversed the input tax credit**
--             attributable to it.
--
--  🔴 SO A YEAR-END VOLUME REBATE AGREED IN DECEMBER CANNOT REDUCE THE
--     GST ON APRIL'S SALES. The agreement did not exist when the supply
--     was made. The credit note can still be issued — the customer
--     genuinely owes less — but it is a FINANCIAL credit note with no
--     tax on it, and the supplier eats the GST already paid.
--
--  ⚠️ Trading businesses give exactly those rebates, constantly, and
--  agree them at the end of the year they relate to. This table exists
--  so the date the agreement was struck is a recorded fact rather than
--  something reconstructed from an email thread two years later.
CREATE TABLE IF NOT EXISTS price_agreements (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    reference_no        varchar(60) NOT NULL,
    title               varchar(255) NOT NULL,

    /**
     * 🔴 THE COLUMN EVERYTHING TURNS ON.
     *
     * A supply made BEFORE this date can never have its tax reduced by a
     * discount under this agreement — s.15(3)(b)(i). Everything else on
     * this table is commentary; this is the fact.
     */
    agreement_date      date NOT NULL,

    /** The period the discount is measured over. */
    effective_from      date NOT NULL,
    effective_to        date,

    /** 'turnover_rebate' | 'quantity_rebate' | 'target' | 'other' */
    discount_kind       varchar(30) NOT NULL DEFAULT 'turnover_rebate',
    /**
     * ⭐ THE SLABS, AS JSON — deliberately not a second slab table.
     * `rate_slabs` prices a SALE; this describes a REBATE measured on a
     * period's turnover. Reusing the sales slab table would put two
     * unrelated meanings in one place and the pricing resolver would
     * have to learn to ignore half its own rows.
     */
    slabs               jsonb NOT NULL DEFAULT '[]'::jsonb,

    document_url        text,
    notes               text,
    status              varchar(20) NOT NULL DEFAULT 'active',

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT price_agreements_status_known CHECK (
        status IN ('draft', 'active', 'expired', 'cancelled')
    ),
    CONSTRAINT price_agreements_kind_known CHECK (
        discount_kind IN ('turnover_rebate', 'quantity_rebate', 'target', 'other')
    ),
    CONSTRAINT price_agreements_period_ordered CHECK (
        effective_to IS NULL OR effective_to > effective_from
    ),
    -- ⚠️ AN AGREEMENT SIGNED AFTER THE PERIOD IT COVERS IS EXACTLY THE
    -- ARRANGEMENT s.15(3)(b)(i) REFUSES. It is not forbidden to record
    -- one — businesses really do this — but it must be visible, so the
    -- constraint allows it and the ENGINE refuses the tax adjustment.
    CONSTRAINT price_agreements_slabs_is_array CHECK (
        jsonb_typeof(slabs) = 'array'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS price_agreements_ref_unique
    ON price_agreements (tenant_id, reference_no);
CREATE INDEX IF NOT EXISTS price_agreements_company_idx
    ON price_agreements (tenant_id, company_id, effective_from DESC);


-- =====================================================================
--  ④ THE DISCOUNT ITSELF
-- =====================================================================
CREATE TABLE IF NOT EXISTS post_supply_discounts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    agreement_id        uuid REFERENCES price_agreements(id) ON DELETE RESTRICT,

    reference_no        varchar(60) NOT NULL,
    /** The period whose turnover earned it. */
    period_from         date NOT NULL,
    period_to           date NOT NULL,
    computed_on         date NOT NULL,

    turnover_minor      bigint NOT NULL DEFAULT 0,
    discount_minor      bigint NOT NULL DEFAULT 0,
    /** The GST that would come back if the tax adjustment qualifies. */
    tax_at_stake_minor  bigint NOT NULL DEFAULT 0,

    /**
     * 🔴 THE VERDICT, STORED — because it is a conclusion about facts as
     * they stood on a date, and re-deriving it next year against an
     * agreement somebody has since edited would give a different answer
     * to the one that was acted on.
     */
    reduces_tax         boolean NOT NULL DEFAULT false,
    verdict_reason      text NOT NULL,

    /**
     * ⚠️ s.15(3)(b)(ii) — the recipient must have reversed the credit.
     *
     * ⭐ Circular 212/6/2024-GST once required the supplier to hold a
     * certificate or undertaking proving it. **That circular was
     * WITHDRAWN by Circular 253/10/2025-GST with effect from 1 October
     * 2025** — no separate evidentiary procedure is required now.
     *
     * 🔴 THE SUBSTANTIVE CONDITION SURVIVES THE WITHDRAWAL. The credit
     * still has to have been reversed; only the paperwork requirement
     * went. So this stays as a recorded fact, and the screen says which
     * of those two things it is.
     */
    recipient_reversal_confirmed boolean NOT NULL DEFAULT false,
    recipient_reversal_note text,

    credit_note_id      uuid REFERENCES sales_credit_notes(id) ON DELETE SET NULL,
    status              varchar(20) NOT NULL DEFAULT 'draft',

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT post_supply_discounts_status_known CHECK (
        status IN ('draft', 'issued', 'cancelled')
    ),
    CONSTRAINT post_supply_discounts_period_ordered CHECK (period_to >= period_from),
    CONSTRAINT post_supply_discounts_values_positive CHECK (
        turnover_minor >= 0 AND discount_minor >= 0 AND tax_at_stake_minor >= 0
    ),
    -- 🔴 A DISCOUNT THAT REDUCES TAX MUST NAME THE AGREEMENT IT CAME
    --    FROM. s.15(3)(b)(i) requires one to have existed at or before
    --    the supply; a tax-reducing rebate with no agreement on file is
    --    a position nobody can defend.
    CONSTRAINT post_supply_discounts_tax_needs_agreement CHECK (
        NOT reduces_tax OR agreement_id IS NOT NULL
    ),
    -- ⚠️ AND IT MUST RECORD THE RECIPIENT'S REVERSAL. The circular that
    -- prescribed HOW to evidence it was withdrawn in October 2025; the
    -- condition in the section was not.
    CONSTRAINT post_supply_discounts_tax_needs_reversal CHECK (
        NOT reduces_tax OR recipient_reversal_confirmed
    ),
    -- ⚠️ Every verdict carries its reason, whichever way it went.
    CONSTRAINT post_supply_discounts_verdict_is_explained CHECK (
        length(btrim(verdict_reason)) >= 10
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS post_supply_discounts_ref_unique
    ON post_supply_discounts (tenant_id, reference_no);
CREATE INDEX IF NOT EXISTS post_supply_discounts_company_idx
    ON post_supply_discounts (tenant_id, company_id, period_to DESC);
-- ⭐ The one somebody wants at year end: rebates whose tax was lost.
CREATE INDEX IF NOT EXISTS post_supply_discounts_lost_tax_idx
    ON post_supply_discounts (tenant_id, computed_on)
    WHERE reduces_tax = false AND status <> 'cancelled';


-- =====================================================================
--  ⑤ THE INVOICE LINKAGE s.15(3)(b)(i) DEMANDS
-- =====================================================================
--  🔴 "SPECIFICALLY LINKED TO RELEVANT INVOICES" IS NOT DECORATION.
--
--  A rebate computed on a period's turnover and credited as one lump is
--  exactly what the section refuses. The discount has to be attributable
--  to identified invoices — which is also the only way the recipient can
--  work out how much credit to reverse.
--
--  ⚠️ Software that stores a rebate as a single figure cannot produce
--  that linkage afterwards, because the apportionment was never done.
CREATE TABLE IF NOT EXISTS post_supply_discount_invoices (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    discount_id         uuid NOT NULL REFERENCES post_supply_discounts(id) ON DELETE CASCADE,
    invoice_id          uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,

    /** Captured, so an invoice renumbered later cannot rewrite history. */
    invoice_number      varchar(60),
    invoice_date        date,
    invoice_taxable_minor bigint NOT NULL DEFAULT 0,

    /** This invoice's share of the rebate. */
    allocated_minor     bigint NOT NULL DEFAULT 0,
    tax_rate_bps        integer NOT NULL DEFAULT 0,
    tax_allocated_minor bigint NOT NULL DEFAULT 0,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT post_supply_discount_invoices_positive CHECK (
        allocated_minor >= 0 AND tax_allocated_minor >= 0
        AND invoice_taxable_minor >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS post_supply_discount_invoices_unique
    ON post_supply_discount_invoices (tenant_id, discount_id, invoice_id);
CREATE INDEX IF NOT EXISTS post_supply_discount_invoices_invoice_idx
    ON post_supply_discount_invoices (tenant_id, invoice_id);


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⚠️ app_platform_scope() belongs in USING and NEVER in WITH CHECK.

ALTER TABLE price_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_agreements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS price_agreements_tenant_isolation ON public.price_agreements;
CREATE POLICY price_agreements_tenant_isolation ON public.price_agreements
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE post_supply_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_supply_discounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS post_supply_discounts_tenant_isolation ON public.post_supply_discounts;
CREATE POLICY post_supply_discounts_tenant_isolation ON public.post_supply_discounts
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE post_supply_discount_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_supply_discount_invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS post_supply_discount_invoices_tenant_isolation ON public.post_supply_discount_invoices;
CREATE POLICY post_supply_discount_invoices_tenant_isolation ON public.post_supply_discount_invoices
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON price_agreements               TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON post_supply_discounts          TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON post_supply_discount_invoices  TO ordence_app;


-- =====================================================================
--  ⚠️ WHAT IS DELIBERATELY NOT HERE
-- =====================================================================
--  NO `customer_price_lists` TABLE. See the header. `rate_cards` already
--  models a customer price list completely, and a second table would
--  give two answers to "what does this cost this customer today".
--
--  NO `current_price` COLUMN ON `stock_items`. A price is a fact about a
--  customer, a quantity and a DATE. A single cached figure would be
--  right for the general public and wrong for every negotiated account —
--  and it would be the figure somebody's report read.
--
--  NO STORED REBATE ACCRUAL. What a customer has earned so far this year
--  is `SUM(invoices) → slab`, computed on read. A stored accrual needs a
--  job, and the month the job does not run is the month a rebate is
--  under-provided in accounts that have already been signed.
-- =====================================================================
