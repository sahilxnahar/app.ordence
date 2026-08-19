-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — BOQ, MEASUREMENT, VARIATIONS AND SITE LABOUR
-- File 0038 · v0.67.0-alpha
--
-- Idempotent. Safe to run repeatedly.
--
-- ⭐ THE FILE THAT FINALLY PROTECTS NINETEEN TABLES THAT EXISTED ON PAPER
-- ══════════════════════════════════════════════════════════════════════
-- `db/schema/construction.ts` and `db/schema/labour.ts` were written
-- months ago and never registered in the schema barrel. `construction`
-- could not be, because it declared its own `ra_bills` and collided
-- head-on with `contracting`; `labour` was simply forgotten alongside it.
--
-- ⚠️ THE COST OF THAT WAS NOT THE MISSING FEATURE. It was that nineteen
-- tables carrying a `tenant_id` sat outside every protection this system
-- has — no row-level security, no cross-tenant reference guard, no
-- privilege narrowing. Nothing failed, because nothing used them. The
-- isolation test found them the instant they were registered, which is
-- exactly the job that test exists to do.
--
-- The duplicate RA-bill tables are gone. `contracting` owns the BILL;
-- `construction` owns what the bill is ABOUT — the bill of quantities,
-- the measurement book its quantities are read from, the rate analysis
-- behind each rate, and the variations that change the contract.
--
-- ⚠️ THREE THINGS IN THIS FILE ARE LOAD-BEARING:
--
--   1. RLS ON ALL NINETEEN, ENABLED **AND** FORCED. See §1.
--
--   2. COMPOSITE FOREIGN KEYS. A measurement entry in tenant A pointing
--      at a BOQ line in tenant B is a measurement against a line the
--      reader cannot see — and it prices, silently, from somebody else's
--      contract.
--
--   3. THE ATTENDANCE ROW IS WHAT MAKES THE EPF/ESI GATE REAL. That gate
--      (in 0031) refuses to pay a contractor with no verified challan for
--      the period, because the developer is the principal employer and
--      pays twice if the contractor did not deposit. A challan is only
--      checkable against who was actually on site — which is `labour`.
--      Without it the gate verifies a document against nothing.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0 · Prerequisites ────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'boq_item_master', 'boqs', 'boq_items', 'rate_analyses',
    'rate_analysis_components', 'boq_variations', 'boq_variation_items',
    'measurement_books', 'measurement_entries', 'contract_advances',
    'retention_ledger',
    'site_workers', 'welfare_logs', 'piece_rate_entries', 'site_attendance',
    'duty_rosters', 'vendor_defaults', 'daily_site_logs', 'site_photos'
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
-- ENABLE and no FORCE reads as protected in the catalogue and is not.
--
-- ⚠️ AND `site_workers` DESERVES A SECOND LOOK. It holds names, UAN
-- numbers and welfare categories for people who are not the tenant's own
-- employees and who will never see this system. They are the least able
-- of anyone in the chain to notice or complain about a leak, which is a
-- reason for more care here rather than less.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'boq_item_master', 'boqs', 'boq_items', 'rate_analyses',
    'rate_analysis_components', 'boq_variations', 'boq_variation_items',
    'measurement_books', 'measurement_entries', 'contract_advances',
    'retention_ledger',
    'site_workers', 'welfare_logs', 'piece_rate_entries', 'site_attendance',
    'duty_rosters', 'vendor_defaults', 'daily_site_logs', 'site_photos'
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
-- ⚠️ (child_id, tenant_id) → (id, tenant_id), NEVER id → id.
--
-- The failure a plain FK permits is quiet and expensive: a measurement
-- entry in tenant A referencing a BOQ line in tenant B passes every
-- constraint, RLS hides the line from A, and the entry then prices from a
-- rate belonging to a different company's contract. Nothing errors, and
-- the number looks entirely reasonable on the bill.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- child table,               child column,            parent table,        on delete
      ('boq_items',                 'boq_id',                'boqs',              'CASCADE'),
      ('boq_items',                 'item_master_id',        'boq_item_master',   'SET NULL'),
      ('boq_items',                 'rate_analysis_id',      'rate_analyses',     'SET NULL'),
      ('rate_analyses',             'item_master_id',        'boq_item_master',   'SET NULL'),
      ('rate_analysis_components',  'rate_analysis_id',      'rate_analyses',     'CASCADE'),
      ('boq_variations',            'boq_id',                'boqs',              'CASCADE'),
      ('boq_variation_items',       'variation_id',          'boq_variations',    'CASCADE'),
      ('boq_variation_items',       'boq_item_id',           'boq_items',         'SET NULL'),
      ('boq_variation_items',       'rate_analysis_id',      'rate_analyses',     'SET NULL'),
      ('measurement_books',         'boq_id',                'boqs',              'CASCADE'),
      ('measurement_entries',       'measurement_book_id',   'measurement_books', 'CASCADE'),
      ('measurement_entries',       'boq_item_id',           'boq_items',         'SET NULL'),
      -- ⚠️ RESTRICT, NOT CASCADE. A measurement that has been billed is
      -- evidence of what was certified. Deleting the bill must not delete
      -- the measurement it was raised from.
      ('measurement_entries',       'ra_bill_id',            'ra_bills',          'RESTRICT'),
      ('contract_advances',         'boq_id',                'boqs',              'SET NULL'),
      ('retention_ledger',          'boq_id',                'boqs',              'SET NULL'),
      ('retention_ledger',          'ra_bill_id',            'ra_bills',          'RESTRICT'),
      ('site_attendance',           'worker_id',             'site_workers',      'CASCADE'),
      ('site_photos',               'daily_site_log_id',     'daily_site_logs',   'CASCADE'),
      ('piece_rate_entries',        'ra_bill_id',            'ra_bills',          'RESTRICT')
    ) AS v(child, col, parent, ondelete)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = r.child || '_' || r.col || '_tenant_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, tenant_id) '
        'REFERENCES %I (id, tenant_id) ON DELETE %s',
        r.child, r.child || '_' || r.col || '_tenant_fk', r.col, r.parent, r.ondelete);
    END IF;
  END LOOP;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 3 · ⭐ A MEASUREMENT THAT HAS BEEN BILLED IS FROZEN
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THE MEASUREMENT BOOK IS THE EVIDENCE BEHIND THE MONEY.
--
-- A running-account bill certifies quantities. Those quantities come from
-- the measurement book. If a measurement can be edited after the bill
-- that used it was raised, then the bill certifies a number that no
-- longer exists anywhere — and the only surviving copy of what was
-- actually measured is the contractor's.
--
-- This is not a hypothetical dispute. The measurement book is the single
-- document arbitrators ask for in a construction claim, and "our system
-- lets that be changed afterwards" ends the conversation.
--
-- Corrections are made by a NEW entry that supersedes, never by editing.

CREATE OR REPLACE FUNCTION measurement_entry_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.ra_bill_id IS NOT NULL THEN
      RAISE EXCEPTION
        'Measurement entry % has been billed on an RA bill and cannot be deleted. It is the evidence behind a certified quantity — record a corrective entry instead.',
        OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.ra_bill_id IS NOT NULL THEN
    IF (NEW.quantity_scaled, NEW.is_deduction, NEW.boq_item_id, NEW.ra_bill_id)
       IS DISTINCT FROM
       (OLD.quantity_scaled, OLD.is_deduction, OLD.boq_item_id, OLD.ra_bill_id)
    THEN
      RAISE EXCEPTION
        'Measurement entry % has already been billed. Its quantity and the line it belongs to are frozen — the RA bill certified this number, and changing it now leaves the bill certifying a figure that exists nowhere. Record a corrective measurement instead.',
        OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_measurement_entries_guard ON measurement_entries;
CREATE TRIGGER trg_measurement_entries_guard
  BEFORE UPDATE OR DELETE ON measurement_entries
  FOR EACH ROW EXECUTE FUNCTION measurement_entry_guard();


-- ══════════════════════════════════════════════════════════════════════
-- 4 · ⭐ AN ADVANCE CANNOT BE OVER-RECOVERED
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ RECOVERING MORE THAN WAS LENT TAKES MONEY THAT WAS NEVER OWED, AND
-- IT IS INVISIBLE. Each individual bill's arithmetic stays internally
-- consistent; the error only surfaces at the final account, by which
-- point several RA bills have been paid on the wrong basis and the
-- contractor has a claim.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='contract_advances_recovery_bounded'
  ) THEN
    ALTER TABLE contract_advances
      ADD CONSTRAINT contract_advances_recovery_bounded
      CHECK (recovered_minor >= 0 AND recovered_minor <= granted_minor);
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 5 · ⭐ THE SAME PUNCH CANNOT BE RECORDED TWICE
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ DOUBLE-MARKED ATTENDANCE IS DOUBLE-PAID LABOUR, and on a site with
-- four hundred workers and a paper muster nobody reconciles it is the
-- oldest leak there is. A supervisor marking the same man twice — or a
-- gangmaster marking a man who was never there, twice — costs a day's
-- wage each time and is untraceable once the month closes.
--
-- ⚠️ ATTENDANCE HERE IS AN EVENT, NOT A DAY. `site_attendance` records
-- check_in and check_out punches with an instant, which is the right
-- model — a man who leaves at noon for a hospital run and returns at
-- three worked one day in two pieces, and a one-row-per-day table cannot
-- say that. So the uniqueness that matters is per PUNCH: the same worker
-- cannot check in twice at the same instant.
--
-- ⚠️ AND THAT IS ALSO THE OFFLINE GUARANTEE. `site_attendance` carries
-- `is_offline` and `synced_at` — a phone at a site with no coverage
-- queues punches and replays them on reconnect. Without this index the
-- replay silently doubles the muster for that morning.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND indexname='site_attendance_worker_punch_key'
  ) THEN
    CREATE UNIQUE INDEX site_attendance_worker_punch_key
      ON site_attendance (tenant_id, worker_id, kind, occurred_at)
      WHERE worker_id IS NOT NULL;
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 6 · VIEWS
-- ══════════════════════════════════════════════════════════════════════
--
-- `security_invoker` on both — without it a view runs as its OWNER and
-- RLS does not apply, which is a cross-tenant leak that no policy audit
-- catches because every policy underneath is correct.

/**
 * ⭐ BOQ CONSUMPTION — how much of each line has actually been measured.
 *
 * ⚠️ THE OVER-MEASURED LINES ARE THE POINT. A line measured beyond its
 * BOQ quantity is either a variation nobody raised or a measurement
 * error, and both are money. Finding out at the final account is finding
 * out too late; the contractor has done the work either way and the only
 * question left is who pays for it.
 */
--
-- ⚠️ QUANTITIES ARE MICRO-UNITS (1e6). 12.345 cum is stored as 12345000.
-- Every figure below stays in micro-units; converting here would put a
-- rounding step between the contract and the report, and the report is
-- what somebody compares against the contractor's own claim.
--
-- ⚠️ AND THE AUTHORISED QUANTITY IS quantity + varied_quantity, NOT
-- quantity. `quantity_scaled` is frozen at issue and every approved
-- variation lands in `varied_quantity_scaled`. Comparing measurement
-- against the original alone reports every legitimately varied line as
-- over-measured — which trains everyone to ignore the flag.
--
-- ⚠️ A DEDUCTION ENTRY SUBTRACTS. A measurement book records voids,
-- openings and cut-outs as deduction rows; summing them as positives
-- inflates the measured quantity by exactly the volume of every window
-- opening on the job.
CREATE OR REPLACE VIEW v_boq_consumption
WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  i.boq_id,
  i.id                                    AS boq_item_id,
  i.item_code,
  i.description,
  i.uom,
  i.quantity_scaled                       AS contract_quantity_scaled,
  i.varied_quantity_scaled                AS varied_quantity_scaled,
  (i.quantity_scaled + COALESCE(i.varied_quantity_scaled, 0))
                                          AS authorised_quantity_scaled,
  COALESCE(SUM(
    CASE WHEN e.is_deduction THEN -e.quantity_scaled ELSE e.quantity_scaled END
  ), 0)                                   AS measured_quantity_scaled,
  (i.quantity_scaled + COALESCE(i.varied_quantity_scaled, 0))
    - COALESCE(SUM(
        CASE WHEN e.is_deduction THEN -e.quantity_scaled ELSE e.quantity_scaled END
      ), 0)                               AS remaining_quantity_scaled,
  CASE WHEN (i.quantity_scaled + COALESCE(i.varied_quantity_scaled, 0)) > 0
       THEN ROUND(
         100.0 * COALESCE(SUM(
           CASE WHEN e.is_deduction THEN -e.quantity_scaled ELSE e.quantity_scaled END
         ), 0)
         / (i.quantity_scaled + COALESCE(i.varied_quantity_scaled, 0)), 1)
  END                                     AS measured_pct,
  /* ⭐ THE FLAG WORTH BUILDING THE VIEW FOR.
   * A line measured beyond its authorised quantity is either a variation
   * nobody raised or a measurement error, and both are money. Finding out
   * at the final account is finding out too late — the contractor has
   * done the work either way, and the only question left is who pays. */
  (COALESCE(SUM(
     CASE WHEN e.is_deduction THEN -e.quantity_scaled ELSE e.quantity_scaled END
   ), 0) > (i.quantity_scaled + COALESCE(i.varied_quantity_scaled, 0)))
                                          AS is_over_measured,
  COUNT(e.id) FILTER (WHERE e.ra_bill_id IS NULL AND e.status <> 'rejected')
                                          AS unbilled_entries
FROM boq_items i
LEFT JOIN measurement_entries e
  ON e.boq_item_id = i.id
 AND e.tenant_id   = i.tenant_id
 AND e.status     <> 'rejected'
WHERE i.is_heading = false
GROUP BY i.tenant_id, i.boq_id, i.id, i.item_code, i.description, i.uom,
         i.quantity_scaled, i.varied_quantity_scaled;

/**
 * ⭐ WHO WAS ON SITE, BY CONTRACTOR AND MONTH.
 *
 * ⚠️ THIS IS THE DENOMINATOR THE EPF/ESI GATE NEEDS. A challan says "we
 * deposited for N workers". Without a count of who was actually present,
 * N is a number nobody can check — and the developer, as principal
 * employer, is the one who pays again when it turns out to have been
 * wrong.
 */
--
-- ⚠️ MAN-DAYS ARE COUNTED FROM CHECK-INS ONLY. Counting every punch
-- doubles the figure, because a normal day is one check_in and one
-- check_out. A worker who forgot to check out still worked that day, so
-- the check-in is the honest unit — it is also the one a muster roll
-- records, which is what this has to reconcile against.
CREATE OR REPLACE VIEW v_site_labour_summary
WITH (security_invoker = true) AS
SELECT
  a.tenant_id,
  a.project_id,
  w.vendor_id                                     AS contractor_vendor_id,
  date_trunc('month', a.occurred_at)::date        AS period_month,
  COUNT(DISTINCT a.worker_id)                     AS distinct_workers,
  COUNT(*) FILTER (WHERE a.kind = 'check_in')     AS man_days,
  COUNT(DISTINCT (a.worker_id, a.occurred_at::date))
    FILTER (WHERE a.kind = 'check_in')            AS worker_days,
  COUNT(DISTINCT a.worker_id) FILTER (WHERE w.uan_status = 'valid')
                                                  AS workers_with_valid_uan,
  /* ⚠️ THE GAP THAT COSTS MONEY. A worker whose UAN is not `valid` is a
   * worker the contractor may not have deposited EPF for — and the
   * developer, as principal employer, pays again if they did not. This
   * is the number to look at before releasing an RA bill.
   *
   * ⚠️ `not_applicable` IS EXCLUDED FROM THE GAP, NOT COUNTED IN IT. A
   * worker legitimately outside EPF (below the threshold, or an
   * exempted establishment) is not a compliance risk, and folding them
   * in would put a permanent non-zero number on the screen that
   * everybody learns to ignore. */
  COUNT(DISTINCT a.worker_id)
    FILTER (WHERE w.uan_status IN ('pending', 'invalid'))
                                                  AS workers_without_valid_uan,
  /* Offline punches that reached the server late — useful when a
   * month's muster does not reconcile and nobody can say why. */
  COUNT(*) FILTER (WHERE a.is_offline)            AS offline_punches
FROM site_attendance a
JOIN site_workers w
  ON w.id = a.worker_id AND w.tenant_id = a.tenant_id
WHERE a.worker_id IS NOT NULL
GROUP BY a.tenant_id, a.project_id, w.vendor_id,
         date_trunc('month', a.occurred_at);


-- ══════════════════════════════════════════════════════════════════════
-- 7 · GRANTS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ GRANT DOES NOT NARROW. A privilege already held survives a later
-- GRANT that omits it; removing one takes an explicit REVOKE.

DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'boq_item_master', 'boqs', 'boq_items', 'rate_analyses',
      'rate_analysis_components', 'boq_variations', 'boq_variation_items',
      'measurement_books', 'measurement_entries', 'contract_advances',
      'retention_ledger',
      'site_workers', 'welfare_logs', 'piece_rate_entries', 'site_attendance',
      'duty_rosters', 'vendor_defaults', 'daily_site_logs', 'site_photos'
    ]
    LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ordence_app', t);
    END LOOP;

    /* ⭐ THE RETENTION LEDGER IS APPEND-ONLY.
     *
     * ⚠️ It is a running record of money withheld from a contractor and
     * later released. A deletable row means retention that was held can
     * be made to look as though it never was — which is the contractor's
     * money, and the dispute is unwinnable without the ledger. */
    REVOKE DELETE, TRUNCATE ON retention_ledger FROM ordence_app;

    GRANT SELECT ON v_boq_consumption      TO ordence_app;
    GRANT SELECT ON v_site_labour_summary  TO ordence_app;
  END IF;
END $$;

COMMIT;
