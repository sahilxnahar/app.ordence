-- =====================================================================
--  0052 — POSSESSION: THE DATE THAT MAKES REVENUE REAL
--  Ordence · v1.0.0-rc.4
-- =====================================================================
--
--  ⭐⭐ WHY THIS COLUMN IS THE MOST IMPORTANT ONE IN THE PROPERTY MODULE
--  ------------------------------------------------------------------
--  Under Ind AS 115 a residential developer recognises revenue when
--  control of the flat transfers — at POSSESSION, a point in time.
--  `postPossession()` was written and tested in v1.0.0-rc.3 and NOTHING
--  COULD CALL IT, because there was nowhere to record that a flat had
--  been handed over.
--
--  🔴 THE CONSEQUENCE WAS ABSOLUTE: a developer running Ordence would
--     collect every rupee of a project, watch "Advance from Customers"
--     grow to the whole book value, and report ZERO TURNOVER FOREVER.
--     Every figure would be correct. The P&L would be empty.
--
-- =====================================================================
--  ⚠️ NO NEW STATUS ON `booking_status`, DELIBERATELY
-- =====================================================================
--  The obvious move is a `possession` member on the enum. Two reasons
--  not to:
--
--    1. ⚠️ `ALTER TYPE ... ADD VALUE` cannot be used in the same
--       transaction that then references the new value. This file would
--       have to be split, or run outside a transaction, and a migration
--       whose safety depends on how it is pasted is not safe.
--
--    2. ⭐ THE STATUS WOULD BE A SECOND SOURCE OF TRUTH. "Has this flat
--       been handed over" is answered exactly by `possession_date IS NOT
--       NULL`. A status column carrying the same fact can disagree with
--       it — and the one that disagrees is always the one somebody
--       updated by hand.
--
--  `registered` remains the terminal booking status. Possession is a
--  DATE, and the question is asked of the date.
-- =====================================================================

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS possession_date date;

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS possession_recorded_at timestamptz;

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS possession_recorded_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS possession_note text;

-- ⭐ Finding "handed over this month" is a month-end question asked of
--   every project at once. Partial, because most bookings never have one.
CREATE INDEX IF NOT EXISTS bookings_possession_idx
    ON bookings (tenant_id, possession_date)
    WHERE possession_date IS NOT NULL;

-- =====================================================================
--  🔴 A CANCELLED BOOKING CANNOT HAVE BEEN HANDED OVER
-- =====================================================================
--  ⚠️ Both facts are recorded independently — `cancelled_at` by the
--  cancellation path, `possession_date` by the possession path — and
--  nothing stopped a booking carrying both. That combination has already
--  recognised revenue AND refunded the buyer, and it balances.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'bookings_possession_not_cancelled'
    ) THEN
        ALTER TABLE bookings
            ADD CONSTRAINT bookings_possession_not_cancelled
            CHECK (possession_date IS NULL OR status <> 'cancelled');
    END IF;
END $$;

-- =====================================================================
--  ⚠️ NO RLS BLOCK HERE, AND THAT IS CORRECT.
--  `bookings` already has row-level security enabled, forced and
--  policied. Adding columns does not change a policy, and re-declaring
--  one would silently replace whatever it says today with whatever this
--  file happened to say.
-- =====================================================================
