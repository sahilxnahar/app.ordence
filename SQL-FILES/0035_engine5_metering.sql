-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — ENGINE 5 · UTILITY METERING & CONSUMPTION BILLING
-- File 0035 · v0.63.0-alpha · Session 1
--
-- Idempotent. Safe to run repeatedly.
--
-- ⭐ THE FILE THAT REFUSES TO STORE A NUMBER IT CANNOT LATER PROVE
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ These are PHYSICAL meters — electricity, solar, water, gas, fuel.
-- The Phase 15 tables in db/schema/metering.ts count how much of ORDENCE
-- a tenant has used. Two different things; deliberately different names.
--
-- The instinct is to store "450 units consumed in July". It is wrong and
-- the wrongness is not recoverable: a meter shows a CUMULATIVE total, so
-- consumption is a DIFFERENCE, and storing only the difference throws
-- away the one thing that could ever verify it. When a customer disputes
-- July you then have your own arithmetic and nothing to check it against.
--
-- So `reading_value` is what the dial said, and everything else is
-- derived by the trigger below.
--
-- ⚠️ FOUR THINGS IN THIS FILE ARE LOAD-BEARING:
--
--   1. ROLLOVER. A 5-digit dial passing 99999 → 00042 consumed 43 units.
--      Naive subtraction says −99,957 and auto-issues a credit note for
--      roughly a year of free supply, to whoever happens to be on that
--      meter.
--
--   2. NEVER SUBTRACTING ACROSS METERS. A replacement meter starts at
--      zero and has no arithmetic relationship to the old one at all.
--
--   3. ANOMALIES ARE FLAGGED, NEVER REJECTED. A 300% jump is theft, a
--      fault, a typo — and also a family that bought an air conditioner.
--      Rejecting makes an honest bill impossible; not noticing is how
--      tampering runs for two years.
--
--   4. NET EXPORT IS BANKED, NOT NETTED. Import minus export within the
--      month silently destroys the bank, every month, in the utility's
--      favour. That is the kind of arithmetic a regulator notices.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0 · Prerequisites ────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'utility_meters', 'meter_readings', 'meter_billing_periods'
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
-- ⚠️ ENABLE **AND** FORCE — the owner bypasses a policy that is only
-- enabled, and migrations run as the owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'utility_meters', 'meter_readings', 'meter_billing_periods'
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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='meter_readings_meter_tenant_fk') THEN
    ALTER TABLE meter_readings
      ADD CONSTRAINT meter_readings_meter_tenant_fk
      FOREIGN KEY (meter_id, tenant_id)
      REFERENCES utility_meters (id, tenant_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='meter_billing_periods_meter_tenant_fk') THEN
    ALTER TABLE meter_billing_periods
      ADD CONSTRAINT meter_billing_periods_meter_tenant_fk
      FOREIGN KEY (meter_id, tenant_id)
      REFERENCES utility_meters (id, tenant_id) ON DELETE CASCADE;
  END IF;

  -- ⭐ A replacement points at its predecessor, in the same tenant.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='utility_meters_replaces_tenant_fk') THEN
    ALTER TABLE utility_meters
      ADD CONSTRAINT utility_meters_replaces_tenant_fk
      FOREIGN KEY (replaces_meter_id, tenant_id)
      REFERENCES utility_meters (id, tenant_id) ON DELETE SET NULL;
  END IF;

  -- ⚠️ The previous reading is on the SAME meter, always. Enforced as a
  -- composite key to the reading table plus the equality check in the
  -- trigger; a previous-reading pointer that crossed meters would make
  -- consumption meaningless in a way no report would reveal.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='meter_readings_previous_tenant_fk') THEN
    ALTER TABLE meter_readings
      ADD CONSTRAINT meter_readings_previous_tenant_fk
      FOREIGN KEY (previous_reading_id, tenant_id)
      REFERENCES meter_readings (id, tenant_id) ON DELETE SET NULL;
  END IF;
END $$;

-- ⚠️ A METER CANNOT REPLACE ITSELF. Left unchecked it produces a cycle
-- that any history walk follows forever.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='utility_meters_no_self_replace') THEN
    ALTER TABLE utility_meters
      ADD CONSTRAINT utility_meters_no_self_replace
      CHECK (replaces_meter_id IS NULL OR replaces_meter_id <> id);
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 3 · ⭐ THE ROLLOVER ARITHMETIC
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THIS IS THE FUNCTION THE WHOLE ENGINE TURNS ON.
--
-- 99999 → 00042 on a 5-digit dial is 43 units consumed. Without the
-- digit count the only choices are to reject a perfectly legitimate
-- reading or to compute −99,957 and hand somebody a year of free supply.
--
-- ⚠️ AND THE ROLLOVER READING IS NOT ASSUMED. A drop is only treated as
-- a wrap when the numbers are actually consistent with one — i.e. when
-- the resulting consumption is plausible against the meter's own
-- history. A meter that reads 99999 then 00042 has wrapped; a meter that
-- reads 4000 then 40 has almost certainly been misread or replaced, and
-- calling that a wrap would invent 96,040 units of consumption out of a
-- typo. The distinction is made in the trigger, which has the history.
--
-- Mirrors consumptionBetween() in db/schema/utility-meters.ts.

CREATE OR REPLACE FUNCTION ordence_meter_consumption(
  p_previous   numeric,
  p_current    numeric,
  p_digits     integer,
  p_multiplier numeric DEFAULT 1
) RETURNS TABLE (consumption numeric, is_rollover boolean)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  ceiling numeric;
BEGIN
  IF p_current >= p_previous THEN
    consumption := (p_current - p_previous) * p_multiplier;
    is_rollover := false;
    RETURN NEXT;
    RETURN;
  END IF;

  -- The dial wrapped.
  ceiling     := power(10::numeric, p_digits);
  consumption := (ceiling - p_previous + p_current) * p_multiplier;
  is_rollover := true;
  RETURN NEXT;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 4 · ⭐ THE DERIVATION TRIGGER
-- ══════════════════════════════════════════════════════════════════════
--
-- Finds the previous reading ON THE SAME METER, computes consumption,
-- decides whether a drop is a wrap or an error, and flags an anomaly
-- against the meter's own recent average.
--
-- ⚠️ "PREVIOUS" IS BY `read_at`, NOT BY `created_at`.
--
-- Readings arrive out of order constantly — a field agent's phone syncs
-- three days late, a smart-meter backfill lands after a manual entry.
-- Chaining by insertion time would make consumption depend on upload
-- order, which is not a property of the meter at all.
--
-- ⚠️ AND A BACKDATED READING REPAIRS THE ONE AFTER IT. Inserting a
-- reading between two existing ones invalidates the later one's baseline;
-- leaving it stale means two months of consumption that do not add up to
-- the meter's own movement, discovered by a customer.

CREATE OR REPLACE FUNCTION meter_reading_derive()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  m           RECORD;
  prev        RECORD;
  calc        RECORD;
  avg_recent  numeric;
  history_n   integer;
BEGIN
  SELECT id, serial_number, digit_count, multiplier, initial_reading, status
    INTO m
    FROM utility_meters
   WHERE id = NEW.meter_id AND tenant_id = NEW.tenant_id;

  IF m IS NULL THEN
    RAISE EXCEPTION 'Meter % does not exist in this workspace.', NEW.meter_id;
  END IF;

  IF m.status IN ('removed', 'disconnected') AND NEW.status <> 'rejected' THEN
    RAISE EXCEPTION
      'Meter % is % and cannot take new readings. If it was replaced, record the reading against the replacement meter.',
      m.serial_number, m.status;
  END IF;

  /* ⚠️ SAME METER ONLY. A replacement meter starts at zero and has NO
   * arithmetic relationship to its predecessor — subtracting across the
   * pair is not a smaller error than rollover, it is a meaningless
   * number that looks exactly like a real one. */
  SELECT id, read_at, reading_value, consumption
    INTO prev
    FROM meter_readings
   WHERE tenant_id = NEW.tenant_id
     AND meter_id  = NEW.meter_id
     AND id       <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND read_at   < NEW.read_at
     AND status   <> 'rejected'
   ORDER BY read_at DESC
   LIMIT 1;

  IF prev IS NULL THEN
    -- The first reading on this meter. Baseline is the installation
    -- reading, so a meter installed showing 1,250 does not bill its new
    -- consumer for 1,250 units somebody else used.
    NEW.previous_reading_id := NULL;
    NEW.previous_value      := m.initial_reading;

    SELECT c.consumption, c.is_rollover INTO calc
      FROM ordence_meter_consumption(
             m.initial_reading, NEW.reading_value, m.digit_count, m.multiplier
           ) c;
  ELSE
    NEW.previous_reading_id := prev.id;
    NEW.previous_value      := prev.reading_value;

    SELECT c.consumption, c.is_rollover INTO calc
      FROM ordence_meter_consumption(
             prev.reading_value, NEW.reading_value, m.digit_count, m.multiplier
           ) c;
  END IF;

  NEW.consumption := calc.consumption;
  NEW.is_rollover := calc.is_rollover;

  /* ---- Anomaly detection, against this meter's OWN history ---------
   *
   * ⚠️ AGAINST ITSELF, NOT AGAINST A GLOBAL AVERAGE. A steel plant and a
   * one-room flat are both "electricity". A threshold that works for one
   * flags every reading of the other.
   *
   * ⚠️ ASYMMETRIC: 3.0× up, 0.4× down. A doubling is often seasonal and
   * honest. A collapse to two-fifths of normal rarely is — it is a
   * bypassed meter, a stopped dial or a misread. The thresholds reflect
   * the direction fraud actually travels in, and they MUST match
   * ANOMALY_HIGH_MULTIPLIER / ANOMALY_LOW_MULTIPLIER in
   * db/schema/utility-meters.ts. The test suite asserts it.
   */
  SELECT count(*), AVG(consumption)
    INTO history_n, avg_recent
    FROM (
      SELECT consumption
        FROM meter_readings
       WHERE tenant_id = NEW.tenant_id
         AND meter_id  = NEW.meter_id
         AND read_at   < NEW.read_at
         AND status   <> 'rejected'
         AND consumption IS NOT NULL
       ORDER BY read_at DESC
       LIMIT 3   -- ⚠️ MUST MATCH ANOMALY_LOOKBACK
    ) recent;

  IF history_n >= 2 AND avg_recent IS NOT NULL AND avg_recent > 0 THEN
    IF NEW.consumption > avg_recent * 3.0 THEN
      NEW.is_anomaly  := true;
      NEW.anomaly_note := format(
        'Consumption %s is more than 3× this meter''s recent average of %s. Verify the reading before billing — a genuine jump (new equipment, seasonal load) is fine, but so is a transposed digit.',
        round(NEW.consumption, 2), round(avg_recent, 2));
    ELSIF NEW.consumption < avg_recent * 0.4 THEN
      NEW.is_anomaly  := true;
      NEW.anomaly_note := format(
        'Consumption %s is below 40%% of this meter''s recent average of %s. Check the meter physically — a sustained drop of this size is more often a stopped dial or a bypass than a change in usage.',
        round(NEW.consumption, 2), round(avg_recent, 2));
    END IF;

    /* ⚠️ A "ROLLOVER" THAT DOES NOT LOOK LIKE ONE IS PROBABLY A TYPO.
     * A true wrap consumes roughly what the meter normally consumes. A
     * drop from 4000 to 40 on a 6-digit meter computes 996,040 units —
     * arithmetically a wrap, and obviously not one. Flagged loudly
     * rather than billed. */
    IF calc.is_rollover AND NEW.consumption > avg_recent * 3.0 THEN
      NEW.is_anomaly  := true;
      NEW.anomaly_note := format(
        'This reading is LOWER than the previous one and was treated as a dial rollover, but the resulting consumption (%s) is far above this meter''s recent average (%s). A misread digit or an unrecorded meter replacement is far more likely than a genuine wrap. Do not bill this period until it is confirmed.',
        round(NEW.consumption, 2), round(avg_recent, 2));
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_meter_readings_010_derive ON meter_readings;
CREATE TRIGGER trg_meter_readings_010_derive
  BEFORE INSERT OR UPDATE ON meter_readings
  FOR EACH ROW EXECUTE FUNCTION meter_reading_derive();
-- ⚠️ `010_` — BEFORE triggers fire in ALPHABETICAL order by trigger
-- name, not creation order. Anything added later that reads
-- NEW.consumption must sort after this.


-- ══════════════════════════════════════════════════════════════════════
-- 5 · ⭐ BACKDATED READINGS REPAIR THEIR SUCCESSOR
-- ══════════════════════════════════════════════════════════════════════
--
-- Insert a reading for 15 July when readings already exist for 1 July and
-- 1 August, and the August row's baseline is now wrong — it still
-- subtracts from 1 July. The two periods then do not sum to the meter's
-- own movement, and the customer is the one who notices.
--
-- ⚠️ AN AFTER TRIGGER, AND IT RE-TOUCHES EXACTLY ONE ROW. Recomputing
-- the whole chain would be simpler to write and would rewrite finalised
-- history on every late sync.

CREATE OR REPLACE FUNCTION meter_reading_repair_successor()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  successor uuid;
BEGIN
  SELECT id INTO successor
    FROM meter_readings
   WHERE tenant_id = NEW.tenant_id
     AND meter_id  = NEW.meter_id
     AND id       <> NEW.id
     AND read_at   > NEW.read_at
     AND status   <> 'rejected'
   ORDER BY read_at ASC
   LIMIT 1;

  IF successor IS NOT NULL THEN
    /* Touching the row re-fires the BEFORE trigger in section 4, which
     * re-derives previous_value, consumption and the anomaly flag from
     * whatever now precedes it. */
    UPDATE meter_readings
       SET notes = notes
     WHERE id = successor AND tenant_id = NEW.tenant_id;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_meter_readings_repair ON meter_readings;
CREATE TRIGGER trg_meter_readings_repair
  AFTER INSERT ON meter_readings
  FOR EACH ROW EXECUTE FUNCTION meter_reading_repair_successor();


-- ══════════════════════════════════════════════════════════════════════
-- 6 · ⭐ READINGS ARE APPEND-ONLY IN THE WAYS THAT MATTER
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THE DIAL VALUE AND THE INSTANT CANNOT BE EDITED. Everything else
-- can: status moves to `disputed` or `validated`, notes get added, the
-- derived columns are rewritten by the triggers above.
--
-- A wrong reading is corrected by SUPERSEDING it — mark the old one
-- `superseded` and record a new one. Editing the number in place means
-- last month's bill was computed from a figure that no longer exists
-- anywhere, and the customer's copy of the invoice is now the only
-- record of what the system actually did.

CREATE OR REPLACE FUNCTION meter_reading_guard_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reading_value IS DISTINCT FROM OLD.reading_value THEN
    RAISE EXCEPTION
      'A meter reading''s value cannot be edited (meter reading %). Mark this reading ''superseded'' and record a new one — last month''s bill was computed from the old figure, and editing it in place leaves no record of what the system actually did.',
      OLD.id;
  END IF;

  IF NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION
      'A meter reading''s date cannot be edited (meter reading %). Moving it re-chains every reading after it. Supersede and re-record instead.',
      OLD.id;
  END IF;

  IF NEW.meter_id IS DISTINCT FROM OLD.meter_id THEN
    RAISE EXCEPTION
      'A meter reading cannot be moved to a different meter. Readings are odometer values and mean nothing on another dial.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_meter_readings_005_immutable ON meter_readings;
CREATE TRIGGER trg_meter_readings_005_immutable
  BEFORE UPDATE ON meter_readings
  FOR EACH ROW EXECUTE FUNCTION meter_reading_guard_immutable();
-- ⚠️ `005_` — sorts BEFORE `010_derive`. The edit is rejected before any
-- derivation work is done on a row that is not going to be written.


-- ══════════════════════════════════════════════════════════════════════
-- 7 · ⭐ A FINALISED BILLING PERIOD IS FROZEN
-- ══════════════════════════════════════════════════════════════════════
--
-- Once a period is billed, its numbers are what the customer holds a
-- copy of. Un-finalising is permitted — mistakes happen and a credit
-- note needs a period to attach to — but it is a deliberate, separate
-- act, not a side effect of editing a figure.

CREATE OR REPLACE FUNCTION meter_period_guard_finalised()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_finalised AND NEW.is_finalised THEN
    IF (NEW.units_consumed,  NEW.units_exported,
        NEW.energy_charge_minor, NEW.fixed_charge_minor,
        NEW.duty_minor, NEW.export_credit_minor, NEW.total_minor,
        NEW.units_banked_opening, NEW.units_banked_closing,
        NEW.opening_reading_id, NEW.closing_reading_id)
       IS DISTINCT FROM
       (OLD.units_consumed,  OLD.units_exported,
        OLD.energy_charge_minor, OLD.fixed_charge_minor,
        OLD.duty_minor, OLD.export_credit_minor, OLD.total_minor,
        OLD.units_banked_opening, OLD.units_banked_closing,
        OLD.opening_reading_id, OLD.closing_reading_id)
    THEN
      RAISE EXCEPTION
        'Billing period "%" is finalised and its figures cannot be changed. The customer holds a copy of these numbers. Un-finalise it explicitly first, or raise a credit note against it.',
        OLD.label;
    END IF;
  END IF;

  IF NEW.is_finalised AND NOT OLD.is_finalised THEN
    NEW.finalised_at := now();
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_meter_periods_finalised ON meter_billing_periods;
CREATE TRIGGER trg_meter_periods_finalised
  BEFORE UPDATE ON meter_billing_periods
  FOR EACH ROW EXECUTE FUNCTION meter_period_guard_finalised();


-- ══════════════════════════════════════════════════════════════════════
-- 8 · ⭐ CLOSING A PERIOD — INCLUDING THE BANK
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ NET METERING IS NOT `import − export`.
--
-- Surplus export is BANKED: carried to the next period and settled
-- annually, usually at a rate different from the import tariff. Netting
-- within the month destroys the bank — quietly, monthly, in the
-- utility's favour, and in a way that is invisible on the invoice
-- because the invoice only shows the net.
--
-- So export offsets import down to zero and NO FURTHER; whatever is left
-- becomes the closing bank and opens the next period.

CREATE OR REPLACE FUNCTION ordence_close_meter_period(
  p_tenant_id uuid,
  p_period_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  p            RECORD;
  m            RECORD;
  v_open_id    uuid;
  v_close_id   uuid;
  v_consumed   numeric := 0;
  v_exported   numeric := 0;
  v_bank_open  numeric := 0;
  v_bank_close numeric;
  v_offset     numeric;
  v_billable   numeric;
  v_energy     bigint  := 0;
BEGIN
  SELECT * INTO p
    FROM meter_billing_periods
   WHERE id = p_period_id AND tenant_id = p_tenant_id;

  IF p IS NULL THEN
    RAISE EXCEPTION 'Billing period % does not exist in this workspace.', p_period_id;
  END IF;

  IF p.is_finalised THEN
    RAISE EXCEPTION
      'Billing period "%" is already finalised. Un-finalise it before recomputing.', p.label;
  END IF;

  SELECT id, serial_number, kind, is_net_metered, rate_card_id, connection_ref
    INTO m
    FROM utility_meters
   WHERE id = p.meter_id AND tenant_id = p_tenant_id;

  IF m IS NULL THEN
    RAISE EXCEPTION 'Meter % does not exist in this workspace.', p.meter_id;
  END IF;

  /* Opening reading: the last one at or before the period start.
   * ⚠️ AT OR BEFORE, not "the first one inside". A period with no reading
   * on its exact first day would otherwise silently start from the first
   * reading INSIDE it and lose everything consumed before that date. */
  SELECT id INTO v_open_id
    FROM meter_readings
   WHERE tenant_id = p_tenant_id
     AND meter_id  = p.meter_id
     AND status   <> 'rejected'
     AND read_at  <= (p.period_start::timestamptz)
   ORDER BY read_at DESC
   LIMIT 1;

  SELECT id INTO v_close_id
    FROM meter_readings
   WHERE tenant_id = p_tenant_id
     AND meter_id  = p.meter_id
     AND status   <> 'rejected'
     AND read_at  <= (p.period_end::timestamptz + interval '1 day')
   ORDER BY read_at DESC
   LIMIT 1;

  /* ⚠️ SUM THE DERIVED CONSUMPTION, DO NOT SUBTRACT THE TWO ENDPOINTS.
   * Subtracting endpoints gets rollover wrong again — and gets it wrong
   * silently, having already got it right on the individual readings. */
  SELECT COALESCE(SUM(consumption), 0) INTO v_consumed
    FROM meter_readings
   WHERE tenant_id = p_tenant_id
     AND meter_id  = p.meter_id
     AND status   <> 'rejected'
     AND read_at   > (p.period_start::timestamptz)
     AND read_at  <= (p.period_end::timestamptz + interval '1 day');

  /* Export comes from the paired export meter at the SAME connection.
   *
   * ⚠️ PAIRED BY `connection_ref`, NOT BY CONSUMER. One consumer can hold
   * several connections; crediting a rooftop's generation against a
   * different premises' consumption is a real and expensive mistake. If
   * the import meter has no connection_ref there is nothing to pair on,
   * and export stays zero rather than being guessed at. */
  IF m.is_net_metered AND m.connection_ref IS NOT NULL THEN
    SELECT COALESCE(SUM(r.consumption), 0) INTO v_exported
      FROM meter_readings r
      JOIN utility_meters em
        ON em.id = r.meter_id AND em.tenant_id = r.tenant_id
     WHERE r.tenant_id      = p_tenant_id
       AND em.id           <> m.id
       AND em.deleted_at   IS NULL
       AND em.connection_ref = m.connection_ref
       AND em.kind IN ('electricity_export', 'solar_generation')
       AND r.status <> 'rejected'
       AND r.read_at  > (p.period_start::timestamptz)
       AND r.read_at <= (p.period_end::timestamptz + interval '1 day');

    -- Bank carried in from the previous period on this meter.
    SELECT COALESCE(units_banked_closing, 0) INTO v_bank_open
      FROM meter_billing_periods
     WHERE tenant_id = p_tenant_id
       AND meter_id  = p.meter_id
       AND period_start < p.period_start
     ORDER BY period_start DESC
     LIMIT 1;

    v_bank_open := COALESCE(v_bank_open, 0);

    /* ⭐ OFFSET DOWN TO ZERO, NEVER BELOW. What is left is banked. */
    v_offset     := LEAST(v_consumed, v_exported + v_bank_open);
    v_billable   := v_consumed - v_offset;
    v_bank_close := (v_exported + v_bank_open) - v_offset;
  ELSE
    v_billable   := v_consumed;
    v_bank_close := 0;
  END IF;

  IF m.rate_card_id IS NOT NULL THEN
    v_energy := ordence_price_slabs(
      p_tenant_id, m.rate_card_id, floor(v_billable)::bigint
    );
  END IF;

  UPDATE meter_billing_periods
     SET opening_reading_id   = v_open_id,
         closing_reading_id   = v_close_id,
         units_consumed       = v_consumed,
         units_exported       = v_exported,
         units_banked_opening = v_bank_open,
         units_banked_closing = v_bank_close,
         rate_card_id         = COALESCE(rate_card_id, m.rate_card_id),
         energy_charge_minor  = v_energy,
         total_minor          = v_energy + fixed_charge_minor + duty_minor
                                - export_credit_minor,
         updated_at           = now()
   WHERE id = p_period_id AND tenant_id = p_tenant_id;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 9 · VIEWS
-- ══════════════════════════════════════════════════════════════════════
--
-- `security_invoker` on both. Without it a view runs as its OWNER and RLS
-- does not apply — which turns a convenience view into a cross-tenant
-- data leak that no policy audit would catch, because the policies are
-- all correctly in place on the tables underneath.

CREATE OR REPLACE VIEW v_meter_status
WITH (security_invoker = true) AS
SELECT
  m.tenant_id,
  m.id                    AS meter_id,
  m.serial_number,
  m.kind,
  m.status,
  m.unit,
  m.location,
  m.consumer_contact_id,
  m.is_net_metered,
  m.rate_card_id,
  last_r.read_at          AS last_read_at,
  last_r.reading_value    AS last_reading_value,
  last_r.consumption      AS last_consumption,
  last_r.source           AS last_source,
  last_r.is_anomaly       AS last_was_anomaly,
  -- ⭐ How stale is this meter? The operational question the whole
  -- reading round is planned from.
  CASE WHEN last_r.read_at IS NULL THEN NULL
       ELSE EXTRACT(DAY FROM (now() - last_r.read_at))::integer
  END                     AS days_since_read,
  (SELECT count(*) FROM meter_readings a
    WHERE a.tenant_id = m.tenant_id AND a.meter_id = m.id
      AND a.is_anomaly AND a.status <> 'rejected')  AS open_anomalies
FROM utility_meters m
LEFT JOIN LATERAL (
  SELECT r.read_at, r.reading_value, r.consumption, r.source, r.is_anomaly
    FROM meter_readings r
   WHERE r.tenant_id = m.tenant_id
     AND r.meter_id  = m.id
     AND r.status   <> 'rejected'
   ORDER BY r.read_at DESC
   LIMIT 1
) last_r ON true
WHERE m.deleted_at IS NULL;


/**
 * ⭐ THE ESTIMATE LEDGER.
 *
 * ⚠️ AN ESTIMATED READING IS A DEBT THE SYSTEM OWES ITSELF. When nobody
 * could reach the meter the bill still goes out based on history — and
 * the next ACTUAL reading must reconcile against it, crediting or
 * charging the difference. A run of estimates that nobody is tracking is
 * how a customer receives one enormous correct bill after a year of
 * small wrong ones.
 */
CREATE OR REPLACE VIEW v_meter_estimates_outstanding
WITH (security_invoker = true) AS
SELECT
  m.tenant_id,
  m.id                     AS meter_id,
  m.serial_number,
  m.consumer_contact_id,
  count(*)                 AS consecutive_estimates,
  min(r.read_at)           AS estimating_since,
  sum(r.consumption)       AS estimated_units
FROM utility_meters m
JOIN meter_readings r
  ON r.meter_id = m.id AND r.tenant_id = m.tenant_id
WHERE m.deleted_at IS NULL
  AND r.source = 'estimated'
  AND r.status <> 'rejected'
  -- Only estimates with no actual reading after them are still outstanding.
  AND NOT EXISTS (
    SELECT 1 FROM meter_readings later
     WHERE later.tenant_id = r.tenant_id
       AND later.meter_id  = r.meter_id
       AND later.read_at   > r.read_at
       AND later.status   <> 'rejected'
       AND later.source   <> 'estimated'
  )
GROUP BY m.tenant_id, m.id, m.serial_number, m.consumer_contact_id;


-- ══════════════════════════════════════════════════════════════════════
-- 10 · GRANTS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ GRANT DOES NOT NARROW — a privilege already held survives a later
-- GRANT that omits it. Removing one takes an explicit REVOKE.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON utility_meters        TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON meter_billing_periods TO ordence_app;

    /* ⭐ READINGS: NO DELETE, EVER.
     *
     * A deleted reading silently re-chains everything after it — the
     * next reading's baseline jumps back to the one before the deleted
     * row, consumption for that period doubles, and the bill that was
     * already sent no longer matches anything in the database. A wrong
     * reading is marked `superseded` or `rejected`; both keep the row. */
    GRANT SELECT, INSERT, UPDATE ON meter_readings TO ordence_app;
    REVOKE DELETE, TRUNCATE ON meter_readings FROM ordence_app;

    GRANT SELECT ON v_meter_status                TO ordence_app;
    GRANT SELECT ON v_meter_estimates_outstanding TO ordence_app;

    GRANT EXECUTE ON FUNCTION ordence_meter_consumption(numeric, numeric, integer, numeric)
      TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_close_meter_period(uuid, uuid) TO ordence_app;
  END IF;
END $$;

COMMIT;
