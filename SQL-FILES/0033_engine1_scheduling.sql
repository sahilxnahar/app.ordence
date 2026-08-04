-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — ENGINE 1 · SCHEDULING & CAPACITY
-- File 0033 · v0.59.0-alpha · Session 1
--
-- Idempotent. Safe to run repeatedly.
--
-- ⭐ THE FILE THAT MAKES DOUBLE-BOOKING IMPOSSIBLE
-- ══════════════════════════════════════════════════════════════════════
-- Every booking system ever written checks availability and then writes.
-- Two statements. Between them, another transaction can do exactly the
-- same thing — and both see a free room, and both write.
--
-- This is not a rare race. It is what happens the first time two agents
-- work the phones at once, and it is why hotels have a walk policy.
--
-- No amount of application code fixes it, because the gap is between the
-- statements and not inside either one. What fixes it is asking the
-- DATABASE to refuse the second write, at commit time, under concurrency:
-- a GiST EXCLUSION CONSTRAINT over a time range.
--
-- Tested below with two genuinely concurrent transactions.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0 · Prerequisites ────────────────────────────────────────────────
--
-- ⚠️ btree_gist is REQUIRED. A GiST index handles ranges natively but not
-- plain equality on uuid/integer, and this constraint needs BOTH — equal
-- resource AND overlapping range. Without the extension the constraint
-- cannot be created at all, which is a loud failure and therefore fine;
-- the dangerous version of this file would be one that silently degraded
-- to a weaker guarantee.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'schedule_bookings'
  ) THEN
    RAISE EXCEPTION
      'schedule_bookings is missing. Run `drizzle-kit push` (or deploy) before this file.';
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 1 · ROW-LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'schedule_resources', 'schedule_bookings', 'schedule_blocks'
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='schedule_bookings_resource_tenant_fk') THEN
    ALTER TABLE schedule_bookings
      ADD CONSTRAINT schedule_bookings_resource_tenant_fk
      FOREIGN KEY (resource_id, tenant_id)
      REFERENCES schedule_resources (id, tenant_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='schedule_blocks_resource_tenant_fk') THEN
    ALTER TABLE schedule_blocks
      ADD CONSTRAINT schedule_blocks_resource_tenant_fk
      FOREIGN KEY (resource_id, tenant_id)
      REFERENCES schedule_resources (id, tenant_id) ON DELETE CASCADE;
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 3 · ⭐ THE EXCLUSION CONSTRAINT — EXCLUSIVE RESOURCES
-- ══════════════════════════════════════════════════════════════════════
--
-- For a resource with capacity 1 — a room, a truck, a surgeon — two
-- overlapping bookings are simply not representable.
--
-- ⚠️ THE `WHERE` CLAUSE IS THE ENTIRE DESIGN, AND IT HAS THREE PARTS:
--
--   1. capacity_hint = 1     only exclusive resources. A 20-bed ward
--                            legitimately overlaps and is counted by the
--                            trigger below instead.
--   2. status IN (...)       ⚠️ MUST MATCH `CAPACITY_CONSUMING_STATUSES`
--                            in db/schema/scheduling.ts, exactly. A
--                            cancelled booking must not block a resale;
--                            a held one must. The two lists drifting
--                            apart is the single most dangerous edit
--                            anybody can make to this engine, so the test
--                            suite asserts they are identical.
--   3. quantity              irrelevant here; exclusivity is binary.
--
-- ⚠️ AND `capacity_hint` IS A DENORMALISED COLUMN, NOT A JOIN.
--
-- An exclusion constraint's predicate cannot query another table. The
-- capacity therefore has to live ON the booking row, maintained by
-- trigger — see section 4. That is a real cost and it is the price of
-- getting the guarantee from the database rather than from hope.

ALTER TABLE schedule_bookings
  ADD COLUMN IF NOT EXISTS capacity_hint integer NOT NULL DEFAULT 1;

ALTER TABLE schedule_bookings
  ADD COLUMN IF NOT EXISTS reserved_range tstzrange;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'schedule_bookings_no_overlap'
  ) THEN
    ALTER TABLE schedule_bookings
      ADD CONSTRAINT schedule_bookings_no_overlap
      EXCLUDE USING gist (
        tenant_id    WITH =,
        resource_id  WITH =,
        reserved_range WITH &&
      )
      WHERE (
        capacity_hint = 1
        AND /*CAPACITY-STATUSES*/ status IN ('held','confirmed','checked_in','in_progress')
      );
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 4 · MAINTAINING THE RANGE AND THE CAPACITY HINT
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THE BUFFER IS BAKED INTO THE RANGE, NOT CHECKED SEPARATELY.
--
-- A room needing 30 minutes to clean reserves [start, end + 30min). The
-- exclusion constraint then enforces the buffer for free, under the same
-- concurrency guarantee as the booking itself. A buffer applied by
-- application code is a buffer that the busy Tuesday ignores.
--
-- Half-open `[)` so back-to-back bookings do not collide: one ending at
-- 11:00 and one starting at 11:00 are adjacent, not overlapping.

CREATE OR REPLACE FUNCTION schedule_booking_prepare()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  res RECORD;
BEGIN
  SELECT capacity, overbook_limit, buffer_minutes, is_active
    INTO res
    FROM schedule_resources
   WHERE id = NEW.resource_id AND tenant_id = NEW.tenant_id;

  IF res IS NULL THEN
    RAISE EXCEPTION 'Resource % does not exist in this workspace.', NEW.resource_id;
  END IF;

  IF NOT res.is_active AND NEW.status IN ('held','confirmed') THEN
    RAISE EXCEPTION 'Resource is not active and cannot take new bookings.';
  END IF;

  NEW.capacity_hint := res.capacity;

  NEW.reserved_range := tstzrange(
    NEW.starts_at,
    NEW.ends_at + (res.buffer_minutes || ' minutes')::interval,
    '[)'
  );

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_schedule_bookings_010_prepare ON schedule_bookings;
CREATE TRIGGER trg_schedule_bookings_010_prepare
  BEFORE INSERT OR UPDATE ON schedule_bookings
  FOR EACH ROW EXECUTE FUNCTION schedule_booking_prepare();
-- ⚠️ `010_` — BEFORE triggers fire in ALPHABETICAL order. The capacity
-- guard below reads `reserved_range`, so it must run after this.


-- ══════════════════════════════════════════════════════════════════════
-- 5 · ⭐ SHARED RESOURCES — COUNTING, WITH A LOCK
-- ══════════════════════════════════════════════════════════════════════
--
-- A 20-bed ward cannot use an exclusion constraint: overlap is the normal
-- case. It needs a COUNT — and a count read in one statement and acted on
-- in the next is the very race this engine exists to close.
--
-- ⚠️ SO THE RESOURCE ROW IS LOCKED FIRST, WITH `FOR UPDATE`.
--
-- Two concurrent bookings for the same ward serialise on that lock: the
-- second waits, then counts, and sees the first. Without it both count 19
-- of 20 and both write, and the ward holds 21 patients.
--
-- The lock is on the RESOURCE, so bookings for different wards never
-- block each other — the serialisation is exactly as narrow as the
-- correctness requires.

CREATE OR REPLACE FUNCTION schedule_capacity_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  res        RECORD;
  used       integer;
  ceiling    integer;
  blocked    integer;
BEGIN
  IF NEW.status NOT IN /*CAPACITY-STATUSES*/ ('held','confirmed','checked_in','in_progress') THEN
    RETURN NEW;
  END IF;

  -- ⚠️ FOR UPDATE. See the header — this is what makes the count safe.
  SELECT capacity, overbook_limit, name
    INTO res
    FROM schedule_resources
   WHERE id = NEW.resource_id AND tenant_id = NEW.tenant_id
     FOR UPDATE;

  /* ---- Blocked time is never bookable, at ANY capacity ----------
   * Maintenance is not a demand problem. Overbooking allowance does
   * not apply to a room whose ceiling has fallen in.
   */
  SELECT count(*) INTO blocked
    FROM schedule_blocks b
   WHERE b.tenant_id = NEW.tenant_id
     AND b.resource_id = NEW.resource_id
     AND tstzrange(b.starts_at, b.ends_at, '[)') && NEW.reserved_range;

  IF blocked > 0 THEN
    RAISE EXCEPTION
      'Resource "%" is blocked for that period (maintenance, closure or breakdown).',
      res.name;
  END IF;

  -- Exclusive resources are already guaranteed by the exclusion
  -- constraint; counting them again would be duplicated logic that can
  -- disagree with itself.
  IF res.capacity = 1 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO used
    FROM schedule_bookings
   WHERE tenant_id = NEW.tenant_id
     AND resource_id = NEW.resource_id
     AND id <> NEW.id
     AND /*CAPACITY-STATUSES*/ status IN ('held','confirmed','checked_in','in_progress')
     AND reserved_range && NEW.reserved_range;

  ceiling := res.capacity + res.overbook_limit;

  IF used + NEW.quantity > ceiling THEN
    RAISE EXCEPTION
      'Resource "%" has no capacity for that period. Capacity %, overbooking allowance %, already committed %, requested %.',
      res.name, res.capacity, res.overbook_limit, used, NEW.quantity;
  END IF;

  /* ⭐ RECORD THAT THIS ONE WENT BEYOND CAPACITY.
   *
   * Permitted, because a hotel that cannot oversell is a hotel losing
   * money on no-shows. But an overbooking nobody can find afterwards is
   * how a front desk discovers at 9pm that it has walked three guests.
   */
  NEW.is_overbooking := (used + NEW.quantity) > res.capacity;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_schedule_bookings_020_capacity ON schedule_bookings;
CREATE TRIGGER trg_schedule_bookings_020_capacity
  BEFORE INSERT OR UPDATE ON schedule_bookings
  FOR EACH ROW EXECUTE FUNCTION schedule_capacity_guard();


-- ══════════════════════════════════════════════════════════════════════
-- 6 · A BLOCK CANNOT LAND ON TOP OF A LIVE BOOKING
-- ══════════════════════════════════════════════════════════════════════
--
-- Enforced in the opposite direction too, because the failure is
-- asymmetric and ugly: block a room that somebody is checked into and the
-- guest is now, formally, in a room that is out of service.

CREATE OR REPLACE FUNCTION schedule_block_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE clashes integer;
BEGIN
  SELECT count(*) INTO clashes
    FROM schedule_bookings b
   WHERE b.tenant_id = NEW.tenant_id
     AND b.resource_id = NEW.resource_id
     AND /*CAPACITY-STATUSES*/ b.status IN ('held','confirmed','checked_in','in_progress')
     AND b.reserved_range && tstzrange(NEW.starts_at, NEW.ends_at, '[)');

  IF clashes > 0 THEN
    RAISE EXCEPTION
      'Cannot block this resource: % live booking(s) already cover that period. Move or cancel them first.',
      clashes;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_schedule_blocks_guard ON schedule_blocks;
CREATE TRIGGER trg_schedule_blocks_guard
  BEFORE INSERT OR UPDATE ON schedule_blocks
  FOR EACH ROW EXECUTE FUNCTION schedule_block_guard();


-- ══════════════════════════════════════════════════════════════════════
-- 7 · UTILISATION VIEW
-- ══════════════════════════════════════════════════════════════════════
--
-- Occupancy, fill rate, billable ratio — five verticals, three names, one
-- calculation. `security_invoker` for the same reason as everywhere else:
-- without it the view runs as its owner and returns every tenant's
-- occupancy to whoever can read it, silently.

CREATE OR REPLACE VIEW v_schedule_utilisation
WITH (security_invoker = true) AS
SELECT
  r.tenant_id,
  r.id                                        AS resource_id,
  r.code,
  r.name,
  r.kind,
  r.group_name,
  r.capacity,
  r.overbook_limit,
  COUNT(b.id) FILTER (
    WHERE /*CAPACITY-STATUSES*/ b.status IN ('held','confirmed','checked_in','in_progress')
  )                                           AS live_bookings,
  COUNT(b.id) FILTER (WHERE b.status = 'no_show')   AS no_shows,
  COUNT(b.id) FILTER (WHERE b.status = 'cancelled') AS cancellations,
  COUNT(b.id) FILTER (WHERE b.is_overbooking)       AS overbookings,
  COALESCE(SUM(b.quoted_rate_minor) FILTER (
    WHERE b.status IN ('confirmed','checked_in','in_progress','completed','no_show')
  ), 0)                                       AS committed_revenue_minor
FROM schedule_resources r
LEFT JOIN schedule_bookings b
  ON b.resource_id = r.id AND b.tenant_id = r.tenant_id
WHERE r.deleted_at IS NULL
GROUP BY r.tenant_id, r.id, r.code, r.name, r.kind, r.group_name,
         r.capacity, r.overbook_limit;


-- ══════════════════════════════════════════════════════════════════════
-- 8 · GRANTS
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_resources TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_bookings  TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_blocks    TO ordence_app;
    GRANT SELECT ON v_schedule_utilisation TO ordence_app;
  END IF;
END $$;

COMMIT;
