-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — ENGINE 2 · RATE & PRICING
-- File 0034 · v0.62.0-alpha · Session 1
--
-- Idempotent. Safe to run repeatedly.
--
-- ⭐ THE FILE THAT MAKES A PRICE EXPLAINABLE
-- ══════════════════════════════════════════════════════════════════════
-- Six verticals price the same way and describe it six ways. An
-- electricity tariff, a freight rate, a volume discount, a seasonal room
-- rate, a hospital tariff class, a per-hour service rate — all of them
-- are "a quantity, banded, times a rate, plus levies".
--
-- Written six times they become six engines that round money six
-- slightly different ways, and every difference is a customer argument
-- you cannot win because your own two screens disagree.
--
-- ⚠️ THREE THINGS IN THIS FILE ARE LOAD-BEARING:
--
--   1. SLAB CONTIGUITY. A tariff with a gap between bands prices the
--      units inside the gap at ZERO and nothing errors. Enforced by a
--      deferred constraint trigger, because the rule is about the SET of
--      slabs and a row-level CHECK cannot see its siblings.
--
--   2. THE ARITHMETIC LIVES IN BOTH PLACES AND MUST AGREE. The TypeScript
--      in db/schema/pricing.ts prices the quote screen; the SQL below
--      prices the batch run. Two implementations of one formula is a real
--      risk, so the test suite runs both over the same table of cases and
--      asserts they produce identical paise.
--
--   3. QUOTES ARE APPEND-ONLY, AT THE PRIVILEGE LEVEL. "What did you
--      quote us on 14 March" is the question this engine exists to
--      answer, and it is unanswerable if the row can be edited afterwards.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0 · Prerequisites ────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rate_cards', 'rate_slabs', 'rate_adjustments', 'rate_quotes'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE EXCEPTION
        '% is missing. Run `drizzle-kit push` (or deploy) before this file.', t;
    END IF;
  END LOOP;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 1 · ROW-LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ ENABLE **AND** FORCE. `ENABLE` alone does not apply the policy to
-- the table's OWNER, and migrations run as the owner — so a table with
-- ENABLE and no FORCE looks protected in the catalogue and leaks every
-- tenant's rate card to anything connecting as the owning role.
--
-- Rate cards are commercially sensitive in a way most tables are not:
-- they ARE the negotiated margin. A competitor who is also a tenant on
-- this platform reading them is not a theoretical harm.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rate_cards', 'rate_slabs', 'rate_adjustments', 'rate_quotes'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename=t
         AND policyname = t || '_tenant_isolation'
    ) THEN
      EXECUTE format($f$
        CREATE POLICY %I ON %I
          USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
          WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      $f$, t || '_tenant_isolation', t);
    END IF;
  END LOOP;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 2 · COMPOSITE FOREIGN KEYS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ (id, tenant_id) → (id, tenant_id), NOT id → id.
--
-- A plain FK on rate_card_id alone permits a slab in tenant A pointing at
-- a card in tenant B. RLS then hides the card from A and shows the slab,
-- and the result is a price built from bands the reader cannot see. The
-- composite key makes the cross-tenant reference unrepresentable rather
-- than merely unlikely.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rate_slabs_card_tenant_fk') THEN
    ALTER TABLE rate_slabs
      ADD CONSTRAINT rate_slabs_card_tenant_fk
      FOREIGN KEY (rate_card_id, tenant_id)
      REFERENCES rate_cards (id, tenant_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rate_adjustments_card_tenant_fk') THEN
    ALTER TABLE rate_adjustments
      ADD CONSTRAINT rate_adjustments_card_tenant_fk
      FOREIGN KEY (rate_card_id, tenant_id)
      REFERENCES rate_cards (id, tenant_id) ON DELETE CASCADE;
  END IF;

  -- ⚠️ RESTRICT, NOT CASCADE, ON THE QUOTE.
  --
  -- A quote is evidence of what was said. Deleting the rate card it was
  -- built from must NOT delete the record of the conversation — that is
  -- precisely the moment somebody would want it gone. Deleting a card
  -- with quotes against it therefore fails; retiring a card is
  -- `is_active = false`, which is what the selection view already reads.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rate_quotes_card_tenant_fk') THEN
    ALTER TABLE rate_quotes
      ADD CONSTRAINT rate_quotes_card_tenant_fk
      FOREIGN KEY (rate_card_id, tenant_id)
      REFERENCES rate_cards (id, tenant_id) ON DELETE RESTRICT;
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 3 · ⭐ SLAB CONTIGUITY — THE GAP THAT PRICES AT ZERO
-- ══════════════════════════════════════════════════════════════════════
--
-- Bands are stored as one exclusive upper bound each: (0,100], (100,300],
-- (300,∞) is up_to = 100, 300, NULL. That already makes overlaps
-- unrepresentable — with a single boundary per row there is nothing to
-- overlap with.
--
-- What it does NOT prevent is the set being wrong as a whole:
--
--   * bounds out of order for their sequence (up_to 300 at sequence 1,
--     100 at sequence 2) — unit 150 then falls in band 1 by value and
--     band 2 by order, and progressive and flat disagree about the price
--   * two unbounded slabs — the second is unreachable, silently
--   * an unbounded slab that is NOT last — every band after it is dead
--   * sequences with a gap (1, 2, 4) — usually a deleted band, and the
--     deletion is exactly the edit that opens a hole in the tariff
--
-- ⚠️ THIS CANNOT BE A ROW-LEVEL CHECK. A CHECK constraint sees one row.
-- The rule is about the whole card, so it is a CONSTRAINT TRIGGER,
-- DEFERRABLE INITIALLY DEFERRED — which is what lets a legitimate edit
-- rewrite all four bands inside one transaction and be judged on the
-- result rather than on each intermediate state. A non-deferred version
-- would reject the correct edit because the second statement of five
-- leaves the set momentarily inconsistent.

CREATE OR REPLACE FUNCTION rate_slabs_validate_set()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  card_id     uuid;
  card_tenant uuid;
  card        RECORD;
  slab_count  integer;
  unbounded   integer;
  prev_upto   bigint;
  expected    integer := 1;
  r           RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    card_id     := OLD.rate_card_id;
    card_tenant := OLD.tenant_id;
  ELSE
    card_id     := NEW.rate_card_id;
    card_tenant := NEW.tenant_id;
  END IF;

  SELECT id, code, slab_mode INTO card
    FROM rate_cards
   WHERE id = card_id AND tenant_id = card_tenant;

  -- The card itself was deleted in this transaction; the slabs went with
  -- it by cascade and there is nothing left to validate.
  IF card IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE up_to_quantity IS NULL)
    INTO slab_count, unbounded
    FROM rate_slabs
   WHERE rate_card_id = card_id AND tenant_id = card_tenant;

  IF slab_count = 0 THEN
    RETURN NULL;   -- A card priced from base_amount_minor alone. Legal.
  END IF;

  /* ⚠️ A BANDED CARD DECLARING slab_mode = 'none' IS THE SILENT ONE.
   * The bands exist, the pricing function ignores them, and the customer
   * is billed the flat base amount. Nothing errors and the number is
   * plausible. So it errors here instead. */
  IF card.slab_mode = 'none' THEN
    RAISE EXCEPTION
      'Rate card "%" is declared slab_mode = ''none'' but has % slab(s). Set the card to ''progressive'' or ''flat'', or remove the slabs — otherwise the bands would be silently ignored at billing time.',
      card.code, slab_count;
  END IF;

  IF unbounded > 1 THEN
    RAISE EXCEPTION
      'Rate card "%" has % open-ended slabs. Only the final slab may have an empty upper limit; the others would never be reached.',
      card.code, unbounded;
  END IF;

  prev_upto := NULL;

  FOR r IN
    SELECT sequence, up_to_quantity
      FROM rate_slabs
     WHERE rate_card_id = card_id AND tenant_id = card_tenant
     ORDER BY sequence
  LOOP
    IF r.sequence <> expected THEN
      RAISE EXCEPTION
        'Rate card "%" has a gap in its slab order: expected slab %, found slab %. Slabs must be numbered 1, 2, 3 … with no gaps, or the bands do not join up.',
        card.code, expected, r.sequence;
    END IF;

    -- An unbounded band must be the last one.
    IF prev_upto IS NULL AND expected > 1 THEN
      RAISE EXCEPTION
        'Rate card "%": slab % has no upper limit but is not the last slab. Every band after it would be unreachable.',
        card.code, expected - 1;
    END IF;

    IF r.up_to_quantity IS NOT NULL
       AND prev_upto IS NOT NULL
       AND r.up_to_quantity <= prev_upto THEN
      RAISE EXCEPTION
        'Rate card "%": slab % ends at % but the slab before it already ended at %. Upper limits must increase, or the bands overlap and the price depends on which reading you take.',
        card.code, r.sequence, r.up_to_quantity, prev_upto;
    END IF;

    prev_upto := r.up_to_quantity;
    expected  := expected + 1;
  END LOOP;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_rate_slabs_validate_set ON rate_slabs;
CREATE CONSTRAINT TRIGGER trg_rate_slabs_validate_set
  AFTER INSERT OR UPDATE OR DELETE ON rate_slabs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION rate_slabs_validate_set();


-- ══════════════════════════════════════════════════════════════════════
-- 4 · ⭐ THE ARITHMETIC — HALF-UP, ON INTEGERS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ NOT `round()` ON A NUMERIC, AND CERTAINLY NOT ON A FLOAT.
--
-- PostgreSQL's `round()` on numeric is half-up, but on double precision
-- it is half-to-even and the difference shows up as a rupee here and
-- there on large batches. More importantly, half-up is what Tally does —
-- and every one of these customers reconciles against Tally. A rounding
-- rule that differs by a rupee a line turns a billing conversation into
-- an argument about arithmetic, which is unwinnable even when you are
-- right.
--
-- Mirrors divideRoundHalfUp() in db/schema/pricing.ts exactly, including
-- the symmetry about zero: −3/2 rounds to −2, not −1.

CREATE OR REPLACE FUNCTION ordence_div_round_half_up(
  numerator bigint,
  denominator bigint
) RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  negative  boolean;
  n         bigint;
  d         bigint;
  quotient  bigint;
  remainder bigint;
BEGIN
  IF denominator = 0 THEN
    RAISE EXCEPTION 'Division by zero in rate arithmetic.';
  END IF;

  negative := (numerator < 0) <> (denominator < 0);
  n := abs(numerator);
  d := abs(denominator);

  quotient  := n / d;
  remainder := n % d;

  IF remainder * 2 >= d THEN
    quotient := quotient + 1;
  END IF;

  RETURN CASE WHEN negative THEN -quotient ELSE quotient END;
END $$;

/** Apply a basis-point rate. 1800 bps = 18%. */
CREATE OR REPLACE FUNCTION ordence_apply_bps(
  amount_minor bigint,
  bps integer
) RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ordence_div_round_half_up(amount_minor * bps::bigint, 10000::bigint);
$$;


-- ══════════════════════════════════════════════════════════════════════
-- 5 · ⭐ SLAB PRICING — THE 27% DECISION, IN SQL
-- ══════════════════════════════════════════════════════════════════════
--
-- 250 units against (≤100 @ ₹4.50, ≤300 @ ₹6.20, ∞ @ ₹8.00):
--
--   PROGRESSIVE   100 × 450 + 150 × 620 = 138,000 paise = ₹1,380
--   FLAT          250 × 620             = 155,000 paise = ₹1,550
--
-- ⚠️ ₹170 APART ON AN IDENTICAL CARD — 12% of the bill, and on the
-- three-band example in the schema header it reaches 27%. Both readings
-- are in daily use: Indian electricity tariffs and income tax are
-- progressive; most freight rates and volume discounts are flat.
--
-- There is therefore no defensible default, and `slab_mode` is NOT NULL
-- with none. A pricing engine that picks silently is wrong for half its
-- users and gives neither half a clue.
--
-- ⚠️ THIS FUNCTION MUST AGREE WITH priceProgressive() AND priceFlat() IN
-- db/schema/pricing.ts TO THE PAISE. Two implementations of one formula
-- is a genuine hazard; the test suite runs both over a shared table of
-- cases rather than trusting that they look similar.

CREATE OR REPLACE FUNCTION ordence_price_slabs(
  p_tenant_id uuid,
  p_card_id   uuid,
  p_quantity  bigint
) RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  card      RECORD;
  r         RECORD;
  total     bigint := 0;
  remaining bigint;
  lower     bigint := 0;
  upper     bigint;
  band      bigint;
  in_band   bigint;
  have_last boolean := false;
  last_unit  bigint;
  last_fixed bigint;
BEGIN
  SELECT id, code, slab_mode, base_amount_minor
    INTO card
    FROM rate_cards
   WHERE id = p_card_id AND tenant_id = p_tenant_id;

  IF card IS NULL THEN
    RAISE EXCEPTION 'Rate card % does not exist in this workspace.', p_card_id;
  END IF;

  IF p_quantity < 0 THEN
    RAISE EXCEPTION 'Quantity cannot be negative.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM rate_slabs
     WHERE rate_card_id = p_card_id AND tenant_id = p_tenant_id
  ) THEN
    -- No bands: a flat card. The base amount is the whole answer.
    RETURN card.base_amount_minor;
  END IF;

  IF card.slab_mode = 'progressive' THEN
    remaining := p_quantity;

    FOR r IN
      SELECT sequence, up_to_quantity, unit_amount_minor, fixed_amount_minor
        FROM rate_slabs
       WHERE rate_card_id = p_card_id AND tenant_id = p_tenant_id
       ORDER BY sequence
    LOOP
      EXIT WHEN remaining <= 0;

      -- NULL upper bound = infinity: the band swallows everything left.
      upper := COALESCE(r.up_to_quantity, p_quantity + lower);
      band  := upper - lower;
      CONTINUE WHEN band <= 0;

      in_band := LEAST(remaining, band);

      total     := total + in_band * r.unit_amount_minor + r.fixed_amount_minor;
      remaining := remaining - in_band;
      lower     := upper;
    END LOOP;

    RETURN total;
  END IF;

  IF card.slab_mode = 'flat' THEN
    FOR r IN
      SELECT sequence, up_to_quantity, unit_amount_minor, fixed_amount_minor
        FROM rate_slabs
       WHERE rate_card_id = p_card_id AND tenant_id = p_tenant_id
       ORDER BY sequence
    LOOP
      have_last  := true;
      last_unit  := r.unit_amount_minor;
      last_fixed := r.fixed_amount_minor;

      IF r.up_to_quantity IS NULL OR p_quantity <= r.up_to_quantity THEN
        RETURN p_quantity * r.unit_amount_minor + r.fixed_amount_minor;
      END IF;
    END LOOP;

    /* Fell off the end: every band is bounded and the quantity exceeds
     * all of them. The last band's rate applies — the same fallback the
     * TypeScript takes, so the two never diverge on the tail case. */
    IF have_last THEN
      RETURN p_quantity * last_unit + last_fixed;
    END IF;

    RETURN 0;
  END IF;

  -- slab_mode = 'none' with slabs present cannot occur; section 3 rejects
  -- it at write time. Reaching here means that guard was bypassed.
  RETURN card.base_amount_minor;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 6 · ⭐ THE FULL QUOTE — SLABS, THEN ADJUSTMENTS, THEN TAX
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THE ORDER IS THE ANSWER, AND IT IS NOT COMMUTATIVE.
--
-- 10% off then 18% tax on ₹1,000 is ₹1,062. 18% tax then 10% off is
-- ₹1,062 too — but add a fixed ₹50 statutory levy and they part company,
-- and add a second percentage adjustment and they part company badly.
-- Hence `sequence` on rate_adjustments, applied in order, each one
-- against the running subtotal rather than against the original.
--
-- Tax last, because that is what the law describes: tax is levied on the
-- consideration actually payable, i.e. after discounts.

CREATE OR REPLACE FUNCTION ordence_quote_rate(
  p_tenant_id uuid,
  p_card_id   uuid,
  p_quantity  bigint
) RETURNS TABLE (
  subtotal_minor    bigint,
  adjustments_minor bigint,
  tax_minor         bigint,
  total_minor       bigint,
  breakdown         jsonb
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  card      RECORD;
  adj       RECORD;
  v_sub     bigint;
  v_running bigint;
  v_adj_tot bigint := 0;
  v_tax     bigint := 0;
  v_delta   bigint;
  v_lines   jsonb := '[]'::jsonb;
BEGIN
  SELECT id, code, name, slab_mode, tax_rate_bps, is_tax_inclusive, currency
    INTO card
    FROM rate_cards
   WHERE id = p_card_id AND tenant_id = p_tenant_id;

  IF card IS NULL THEN
    RAISE EXCEPTION 'Rate card % does not exist in this workspace.', p_card_id;
  END IF;

  v_sub     := ordence_price_slabs(p_tenant_id, p_card_id, p_quantity);
  v_running := v_sub;

  v_lines := v_lines || jsonb_build_object(
    'kind', 'base',
    'label', card.name,
    'slabMode', card.slab_mode,
    'quantity', p_quantity,
    'amountMinor', v_sub
  );

  FOR adj IN
    SELECT sequence, label, percentage_bps, fixed_amount_minor,
           is_visible, is_statutory
      FROM rate_adjustments
     WHERE rate_card_id = p_card_id AND tenant_id = p_tenant_id
     ORDER BY sequence
  LOOP
    -- ⚠️ AGAINST THE RUNNING SUBTOTAL, NOT THE ORIGINAL. A 10% discount
    -- followed by a 5% surcharge is not 95% of the base.
    v_delta := ordence_apply_bps(v_running, adj.percentage_bps)
             + adj.fixed_amount_minor;

    v_running := v_running + v_delta;
    v_adj_tot := v_adj_tot + v_delta;

    v_lines := v_lines || jsonb_build_object(
      'kind', 'adjustment',
      'sequence', adj.sequence,
      'label', adj.label,
      'percentageBps', adj.percentage_bps,
      'fixedAmountMinor', adj.fixed_amount_minor,
      'isVisible', adj.is_visible,
      'isStatutory', adj.is_statutory,
      'amountMinor', v_delta
    );
  END LOOP;

  IF card.tax_rate_bps > 0 THEN
    IF card.is_tax_inclusive THEN
      /* ⚠️ INCLUSIVE TAX IS EXTRACTED, NOT ADDED — and it is NOT 18% of
       * the gross. On ₹118 at 18%, the tax is ₹18, which is 118 × 1800 /
       * 11800. Taking 18% of 118 gives ₹21.24 and overstates the levy on
       * every inclusive-priced line in the system. */
      v_tax     := ordence_div_round_half_up(
                     v_running * card.tax_rate_bps::bigint,
                     (10000 + card.tax_rate_bps)::bigint
                   );
      -- The total does not move: tax was already inside the price.
    ELSE
      v_tax     := ordence_apply_bps(v_running, card.tax_rate_bps);
      v_running := v_running + v_tax;
    END IF;

    v_lines := v_lines || jsonb_build_object(
      'kind', 'tax',
      'label', CASE WHEN card.is_tax_inclusive
                    THEN 'Tax (included)' ELSE 'Tax' END,
      'rateBps', card.tax_rate_bps,
      'isInclusive', card.is_tax_inclusive,
      'amountMinor', v_tax
    );
  END IF;

  subtotal_minor    := v_sub;
  adjustments_minor := v_adj_tot;
  tax_minor         := v_tax;
  total_minor       := v_running;
  breakdown         := v_lines;
  RETURN NEXT;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 7 · ⭐ QUOTE IMMUTABILITY
-- ══════════════════════════════════════════════════════════════════════
--
-- A quote is the record of what was said to a customer on a date. It is
-- the only thing that can settle "you quoted us ₹1,380" — recomputing
-- cannot, because the card has changed since, and recomputation returns
-- today's number with total confidence and no relationship to the
-- conversation.
--
-- ⚠️ SO IT IS ENFORCED TWICE, DELIBERATELY.
--
-- The trigger gives a clear message to a developer who tries. The REVOKE
-- in section 9 means the application role cannot do it at all, even
-- through a path that skips the trigger. Belt and braces, because the
-- failure is silent and permanent: an edited quote looks exactly like a
-- correct one.

CREATE OR REPLACE FUNCTION rate_quotes_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Quotes cannot be % once recorded. A quote is evidence of what was offered on a date; if the price has changed, record a NEW quote — the history is the point of the table.',
    lower(TG_OP);
END $$;

DROP TRIGGER IF EXISTS trg_rate_quotes_immutable ON rate_quotes;
CREATE TRIGGER trg_rate_quotes_immutable
  BEFORE UPDATE OR DELETE ON rate_quotes
  FOR EACH ROW EXECUTE FUNCTION rate_quotes_immutable();


-- ══════════════════════════════════════════════════════════════════════
-- 8 · ⭐ CARD SELECTION — WHY THIS PRICE AND NOT THAT ONE
-- ══════════════════════════════════════════════════════════════════════
--
-- Several cards can legitimately apply at once: a list price, a seasonal
-- rate, a channel rate, and a contracted rate for this customer.
--
-- ⚠️ "MOST RECENTLY CREATED WINS" IS THE COMMON ANSWER AND IT IS A TRAP.
-- The winner then changes when somebody edits an unrelated card, the
-- price moves for no visible reason, and nobody can reconstruct why.
--
-- So precedence is STATED: scope rank first (contracted beats
-- promotional beats segment beats channel beats seasonal beats list),
-- then the card's own priority, and `created_at` only as a final
-- tie-break so the result is deterministic rather than arbitrary.
--
-- ⚠️ THE RANKS BELOW MUST MATCH `RATE_SCOPE_PRIORITY` IN
-- db/schema/pricing.ts. The test suite asserts it.

CREATE OR REPLACE VIEW v_rate_card_candidates
WITH (security_invoker = true) AS
SELECT
  c.tenant_id,
  c.id                AS rate_card_id,
  c.code,
  c.name,
  c.scope,
  c.slab_mode,
  c.basis,
  c.priority,
  c.applies_to_kind,
  c.applies_to_id,
  c.customer_company_id,
  c.channel,
  c.valid_from,
  c.valid_to,
  c.days_of_week,
  c.currency,
  c.tax_rate_bps,
  c.is_tax_inclusive,
  CASE c.scope
    WHEN 'contracted'  THEN 500
    WHEN 'promotional' THEN 400
    WHEN 'segment'     THEN 300
    WHEN 'channel'     THEN 200
    WHEN 'seasonal'    THEN 150
    WHEN 'list'        THEN 100
    ELSE 0
  END                 AS scope_rank,
  (SELECT count(*) FROM rate_slabs s
    WHERE s.rate_card_id = c.id
      AND s.tenant_id    = c.tenant_id)  AS slab_count
FROM rate_cards c
WHERE c.deleted_at IS NULL
  AND c.is_active;

/**
 * ⭐ Resolve the single winning card for a set of facts.
 *
 * ⚠️ VALIDITY IS HALF-OPEN: valid_to is EXCLUSIVE. A card ending 31 March
 * and one starting 31 March would otherwise both apply on that day, and
 * which one won would depend on sort order — the exact class of bug that
 * shows up once a quarter and cannot be reproduced.
 */
CREATE OR REPLACE FUNCTION ordence_select_rate_card(
  p_tenant_id   uuid,
  p_kind        varchar,
  p_applies_to  uuid,
  p_customer_id uuid,
  p_channel     varchar,
  p_on_date     date
) RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT v.rate_card_id
    FROM v_rate_card_candidates v
   WHERE v.tenant_id = p_tenant_id
     AND (v.applies_to_kind IS NULL OR v.applies_to_kind = p_kind)
     AND (v.applies_to_id   IS NULL OR v.applies_to_id   = p_applies_to)
     -- ⚠️ A CONTRACTED CARD IS FOR ONE CUSTOMER AND NOBODY ELSE. A card
     -- naming a customer must never be selected for a different one —
     -- that is somebody else's negotiated margin on your invoice.
     AND (v.customer_company_id IS NULL OR v.customer_company_id = p_customer_id)
     AND (v.channel IS NULL OR v.channel = p_channel)
     AND (v.valid_from IS NULL OR v.valid_from <= p_on_date)
     AND (v.valid_to   IS NULL OR v.valid_to   >  p_on_date)
     AND (
       v.days_of_week IS NULL
       -- ISO day 1..7 (Mon..Sun) indexes the mask "1111100".
       OR substring(v.days_of_week FROM EXTRACT(ISODOW FROM p_on_date)::int FOR 1) = '1'
     )
   ORDER BY
     v.scope_rank DESC,
     v.priority   DESC,
     -- Specific beats general when everything else ties.
     (v.customer_company_id IS NOT NULL) DESC,
     (v.applies_to_id IS NOT NULL) DESC,
     v.rate_card_id
   LIMIT 1;
$$;


-- ══════════════════════════════════════════════════════════════════════
-- 9 · GRANTS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ GRANT DOES NOT NARROW. Privileges accumulate, so listing
-- SELECT, INSERT on rate_quotes does NOT take away an UPDATE granted
-- earlier or by a blanket `GRANT ALL ON ALL TABLES`. Removing a
-- privilege requires REVOKE, explicitly, every time. This was found the
-- hard way on Engine 4.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_cards       TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_slabs       TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_adjustments TO ordence_app;

    -- ⭐ APPEND-ONLY, AT THE PRIVILEGE LEVEL.
    GRANT SELECT, INSERT ON rate_quotes TO ordence_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON rate_quotes FROM ordence_app;

    GRANT SELECT ON v_rate_card_candidates TO ordence_app;

    GRANT EXECUTE ON FUNCTION ordence_div_round_half_up(bigint, bigint) TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_apply_bps(bigint, integer)        TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_price_slabs(uuid, uuid, bigint)   TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_quote_rate(uuid, uuid, bigint)    TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_select_rate_card(uuid, varchar, uuid, uuid, varchar, date)
      TO ordence_app;
  END IF;
END $$;

COMMIT;
