-- ============================================================================
-- Ordence — Phase 22: Sales Pipeline & Inventory
-- Version: v0.22.0-alpha
--
-- Run AFTER `npx drizzle-kit push`.
--
-- Contents:
--   1. Row-level security on all seven tables
--   2. ⭐ Cross-tenant reference integrity — the hole RLS does NOT close
--   3. ⭐ One live booking per unit, under concurrency
--   4. Unit status coherence — a booked unit cannot be sold twice
--   5. The hold, and how it releases itself
--   6. The commission-protection window
--   7. Lead activity is append-only
--   8. updated_at
--   9. Grants
--  10. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- This phase is where the product stops being a generic CRM and starts being
-- a real-estate one, and it brings a failure mode none of the previous
-- twenty-one phases had:
--
--     TWO BUYERS PROMISED THE SAME FLAT.
--
-- Every other integrity problem in this system is recoverable with an UPDATE.
-- This one is not. By the time anybody notices, two families have paid a
-- booking amount, two agreements may be drafted, and the remedy is a refund,
-- a broken relationship, and — in India — a live RERA complaint.
--
-- It is also, specifically, a CONCURRENCY problem. A single-organisation app
-- gets away with "check, then write" because the two reps who might collide
-- are sitting in the same room. A product used by a twelve-person sales team
-- on a launch weekend does not: two `SELECT status FROM units` both return
-- `available`, both then INSERT, and the application logic that looked
-- obviously correct has just double-sold a flat.
--
-- So the guarantee lives in the database (Sections 3 and 4), not in a server
-- action. Section 10 proves it is there.
-- ============================================================================


CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER as well,
-- which is the half everybody forgets: without it, the role that created the
-- table reads everything and the policies look like they are working.
--
-- ⚠️ NOTE WHAT IS ABSENT: none of these policies carry
-- `OR app_is_platform_scope()`. That marker exists so platform staff can
-- resolve a webhook to a subscription; it deliberately does NOT extend to
-- customer content. A support engineer has no business reading a customer's
-- pipeline, and the narrowing was itself a defect found and fixed in v0.14.1.

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_tenant_isolation ON projects;
CREATE POLICY projects_tenant_isolation ON projects
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS units_tenant_isolation ON units;
CREATE POLICY units_tenant_isolation ON units
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leads_tenant_isolation ON leads;
CREATE POLICY leads_tenant_isolation ON leads
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_activities_tenant_isolation ON lead_activities;
CREATE POLICY lead_activities_tenant_isolation ON lead_activities
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE channel_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_partners FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_partners_tenant_isolation ON channel_partners;
CREATE POLICY channel_partners_tenant_isolation ON channel_partners
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bookings_tenant_isolation ON bookings;
CREATE POLICY bookings_tenant_isolation ON bookings
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE payment_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_milestones FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_milestones_tenant_isolation ON payment_milestones;
CREATE POLICY payment_milestones_tenant_isolation ON payment_milestones
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 2 — ⭐ CROSS-TENANT REFERENCE INTEGRITY
-- ############################################################################
--
-- ⚠️ THIS IS THE ONE THAT IS NOT OBVIOUS, AND IT IS A REAL HOLE.
--
-- Row-level security governs which rows a session can SEE and WRITE. It does
-- not govern what a row POINTS AT, because **foreign-key checks run as the
-- system and ignore RLS entirely**. That is documented PostgreSQL behaviour
-- and it is easy to read past.
--
-- The consequence, concretely:
--
--   Tenant A inserts a unit with
--       tenant_id  = A          ← passes WITH CHECK, it is their own tenant
--       project_id = <a UUID belonging to tenant B>
--
--   The WITH CHECK passes. The foreign key passes, because the referenced
--   project genuinely exists. Tenant A now owns a unit attached to tenant B's
--   development. Nothing errors. Nothing logs. Every page renders.
--
-- Is it exploitable? It needs a UUID from another tenant, which is not
-- guessable. But UUIDs leak — a support ticket, a screenshot, a CSV, a URL
-- pasted into a chat. "Requires a leaked identifier" is a description of the
-- attack, not a defence against it, and the same reasoning is why we do not
-- rely on unguessable ids anywhere else in this system.
--
-- THE FIX: composite foreign keys.
--
-- Reference (tenant_id, id) rather than (id). The child row must then name
-- the SAME tenant as its parent — and since WITH CHECK has already pinned the
-- child's tenant_id to the current tenant, a cross-tenant pointer becomes
-- arithmetically impossible rather than merely unlikely.
--
-- The parent needs a UNIQUE index on (id, tenant_id) for the composite key to
-- reference. `id` is already the primary key, so this index is redundant for
-- lookups and exists purely to give the FK something to attach to. That is a
-- normal and accepted cost of the pattern.

-- 2a. Targets for the composite keys.
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_tenant_key
  ON projects (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS units_id_tenant_key
  ON units (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS leads_id_tenant_key
  ON leads (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_id_tenant_key
  ON bookings (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS channel_partners_id_tenant_key
  ON channel_partners (id, tenant_id);

-- 2b. The composite keys themselves.
--
-- Each is added only if absent, so this file is safe to re-run. The
-- single-column FKs that drizzle created stay: they are not wrong, they are
-- merely insufficient, and dropping them would remove the ON DELETE behaviour
-- the application relies on.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'units_project_same_tenant') THEN
    ALTER TABLE units
      ADD CONSTRAINT units_project_same_tenant
      FOREIGN KEY (project_id, tenant_id)
      REFERENCES projects (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_project_same_tenant') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_project_same_tenant
      FOREIGN KEY (project_id, tenant_id)
      REFERENCES projects (id, tenant_id)
      ON DELETE SET NULL (project_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_activities_lead_same_tenant') THEN
    ALTER TABLE lead_activities
      ADD CONSTRAINT lead_activities_lead_same_tenant
      FOREIGN KEY (lead_id, tenant_id)
      REFERENCES leads (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_unit_same_tenant') THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_unit_same_tenant
      FOREIGN KEY (unit_id, tenant_id)
      REFERENCES units (id, tenant_id)
      ON DELETE SET NULL (unit_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_lead_same_tenant') THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_lead_same_tenant
      FOREIGN KEY (lead_id, tenant_id)
      REFERENCES leads (id, tenant_id)
      ON DELETE SET NULL (lead_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_partner_same_tenant') THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_partner_same_tenant
      FOREIGN KEY (channel_partner_id, tenant_id)
      REFERENCES channel_partners (id, tenant_id)
      ON DELETE SET NULL (channel_partner_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestones_booking_same_tenant') THEN
    ALTER TABLE payment_milestones
      ADD CONSTRAINT milestones_booking_same_tenant
      FOREIGN KEY (booking_id, tenant_id)
      REFERENCES bookings (id, tenant_id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- 2c. `leads.channel_partner_id` and `units.held_for_lead_id` were declared
-- in the schema WITHOUT a foreign key, to avoid a circular table definition
-- in TypeScript. They get theirs here, composite from the start.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_partner_same_tenant') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_partner_same_tenant
      FOREIGN KEY (channel_partner_id, tenant_id)
      REFERENCES channel_partners (id, tenant_id)
      ON DELETE SET NULL (channel_partner_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'units_held_lead_same_tenant') THEN
    ALTER TABLE units
      ADD CONSTRAINT units_held_lead_same_tenant
      FOREIGN KEY (held_for_lead_id, tenant_id)
      REFERENCES leads (id, tenant_id)
      ON DELETE SET NULL (held_for_lead_id);
  END IF;
END
$$;


-- 2d. ⚠️ THE EDGES SECTION 2 MISSED: EVERY POINTER INTO `users`.
--
-- Found by an adversarial review, and it is worth recording exactly how
-- it slipped through. Section 2 was written as "give every sales→sales
-- relationship a composite key", and it did that completely. But four
-- columns point at `users`, which is NOT a sales table, so they were
-- never in scope — and Check 8 tested only the sales→sales edges, so the
-- verification reported PASS.
--
--     leads.owner_id            units.held_by_user_id
--     bookings.sales_rep_id     lead_activities.user_id
--
-- `users` carries a tenant_id, so these are the same defect as the rest
-- of Section 2. Verified accepted before this fix:
--
--     UPDATE leads SET owner_id = '<a user in ANOTHER tenant>';   -- UPDATE 1
--
-- Three consequences, in ascending order of seriousness:
--
--   1. Tenant A stores tenant B's user ids in its own rows.
--   2. A clean EXISTENCE ORACLE. A real UUID from any workspace on the
--      platform is accepted; a random one is refused with a foreign-key
--      error. That difference is enough to confirm whether a given id is
--      a real user somewhere — the exact leak the `bookings.unit_id`
--      path already avoids by returning the same message either way.
--   3. When tenant B later deletes that user, the ON DELETE SET NULL
--      performs a WRITE into tenant A's rows. One customer's admin
--      action silently mutating another customer's data is the single
--      worst outcome in this list, and nothing anywhere would report it.
--
-- The lesson generalises: "every table in this phase" is the wrong scope
-- for a cross-tenant audit. The right scope is EVERY COLUMN THAT POINTS
-- AT A TENANT-SCOPED TABLE, wherever that table happens to live.

CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_key
  ON users (id, tenant_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_owner_same_tenant') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_owner_same_tenant
      FOREIGN KEY (owner_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (owner_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'units_held_by_same_tenant') THEN
    ALTER TABLE units
      ADD CONSTRAINT units_held_by_same_tenant
      FOREIGN KEY (held_by_user_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (held_by_user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_rep_same_tenant') THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_rep_same_tenant
      FOREIGN KEY (sales_rep_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (sales_rep_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_activities_user_same_tenant') THEN
    ALTER TABLE lead_activities
      ADD CONSTRAINT lead_activities_user_same_tenant
      FOREIGN KEY (user_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (user_id);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 3 — ⭐ ONE LIVE BOOKING PER UNIT
-- ############################################################################
--
-- The index is declared in `db/schema/sales.ts`, which means `drizzle-kit
-- push` creates it. It is restated here for one reason: **push removes what
-- it does not recognise, and a future schema edit could drop it silently.**
-- This file is the belt; the schema is the braces.
--
-- WHY AN INDEX AND NOT A CHECK IN THE SERVER ACTION:
--
--   Two reps click "Book" on unit A-1203 within the same second.
--
--     T1: SELECT ... FROM bookings WHERE unit_id = X AND status <> 'cancelled'
--         → 0 rows. Proceed.
--     T2: SELECT ... same query
--         → 0 rows. Proceed.          ← T1 has not committed yet
--     T1: INSERT booking. COMMIT.
--     T2: INSERT booking. COMMIT.
--
--   Both transactions were individually correct. Both read a consistent
--   snapshot. READ COMMITTED — Postgres's default, and ours — permits this
--   exactly. There is no arrangement of application code that closes it
--   without either a lock or a unique index.
--
--   The unique index makes T2 fail with 23505. Section 4's trigger takes the
--   lock as well, so the common case is a clean error rather than a
--   constraint violation surfacing to a user.
--
-- PARTIAL, and both exclusions are deliberate:
--   • `status <> 'cancelled'` — a cancelled booking must free the unit.
--     Otherwise a buyer who walks away permanently poisons the flat.
--   • `unit_id IS NOT NULL` — a booking can exist before a unit is allotted
--     (a "soft" booking against a project), and those must not collide.

CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_live_per_unit
  ON bookings (unit_id)
  WHERE status <> 'cancelled' AND unit_id IS NOT NULL;


-- ############################################################################
-- SECTION 4 — UNIT STATUS COHERENCE
-- ############################################################################
--
-- The index in Section 3 stops two rows existing. It does not stop the FIRST
-- one being wrong — booking a unit that management has blocked, or one
-- already sold, or one another rep is holding for a different buyer.
--
-- Those are business rules, so they could live in the server action. They do
-- not, for the same reason as Section 3: an import script, a support fix and
-- a future API route are all write paths, and a rule enforced in one of four
-- write paths is a rule that will eventually be bypassed by the other three.
--
-- ⚠️ THE `FOR UPDATE` IS THE POINT OF THIS FUNCTION.
--
-- Reading the unit's status without locking it reproduces the exact race
-- Section 3 describes, one table across. The lock serialises concurrent
-- attempts on the same unit, so the second one sees the first one's effect
-- instead of a stale snapshot.

CREATE OR REPLACE FUNCTION enforce_unit_bookable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  unit_row units%ROWTYPE;
BEGIN
  -- A booking with no unit has nothing to check.
  IF NEW.unit_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A cancellation never needs the unit to be free.
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, only re-check when the unit or the liveness actually changed.
  --
  -- ⚠️ NESTED, NOT `TG_OP = 'UPDATE' AND OLD.…`. PL/pgSQL does not guarantee
  -- short-circuit evaluation of AND — the condition is handed to the SQL
  -- executor, which may evaluate either side first. On an INSERT, OLD is
  -- unassigned and touching it raises `record "old" is not assigned yet`,
  -- turning a guard into an outage on the happy path.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.unit_id IS NOT DISTINCT FROM NEW.unit_id
       AND OLD.status <> 'cancelled' THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ⚠️ FOR UPDATE. See the note above — without it this is decorative.
  SELECT * INTO unit_row FROM units WHERE id = NEW.unit_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unit % does not exist.', NEW.unit_id
      USING ERRCODE = '23503';
  END IF;

  IF unit_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Unit % has been deleted and cannot be booked. Restore it first.',
      unit_row.code
      USING ERRCODE = '23514';
  END IF;

  IF unit_row.status = 'blocked' THEN
    RAISE EXCEPTION
      'Unit % is blocked and is not available for sale. Management removed it '
      'from the market — unblock it before booking.',
      unit_row.code
      USING ERRCODE = '23514';
  END IF;

  IF unit_row.status = 'sold' THEN
    RAISE EXCEPTION
      'Unit % is already sold.', unit_row.code
      USING ERRCODE = '23514';
  END IF;

  -- ⚠️ A HOLD BELONGS TO A NAMED BUYER.
  --
  -- Booking a held unit for somebody ELSE is the quiet version of the
  -- double-sale: the rep who placed the hold made a promise, and the system
  -- let a colleague break it without either of them noticing. A live hold
  -- for a different lead is refused; an EXPIRED hold is not, because the
  -- whole point of the deadline is that it releases.
  IF unit_row.status = 'held'
     AND unit_row.hold_until > now()
     AND unit_row.held_for_lead_id IS DISTINCT FROM NEW.lead_id THEN
    RAISE EXCEPTION
      'Unit % is held for another buyer until %. Release the hold first, or '
      'wait for it to expire.',
      unit_row.code, unit_row.hold_until
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_unit_bookable ON bookings;
CREATE TRIGGER bookings_unit_bookable
  BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_unit_bookable();


-- ----------------------------------------------------------------------------
-- 4b. The unit follows the booking.
-- ----------------------------------------------------------------------------
--
-- Keeping `units.status` in step with its live booking is the sort of thing
-- an application usually does in a second UPDATE after the insert — and that
-- second UPDATE is exactly what fails to run when the request times out, the
-- process is killed, or somebody writes the booking from a script.
--
-- The result is an inventory board that says "available" for a flat that is
-- sold. In this product the inventory board is what the sales team trusts.
--
-- ⚠️ Deliberately does NOT touch `blocked`. Management blocking a unit
-- outranks the pipeline, and having the trigger quietly override a
-- management decision would be worse than the inconsistency it fixes.

-- ══════════════════════════════════════════════════════════════════════
-- 🔴 THE DEFECT AN ADVERSARIAL REVIEW FOUND HERE, AND WHY IT MATTERED
-- ══════════════════════════════════════════════════════════════════════
-- The first version of this function keyed off NEW.status alone. A
-- security reviewer turned that into a write primitive against `units`
-- in a single statement:
--
--     INSERT INTO bookings (..., unit_id, status, cancel_reason)
--     VALUES (..., <a unit held for someone else>, 'cancelled', 'oops');
--
-- `enforce_unit_bookable` waves cancelled rows through deliberately — a
-- cancellation does not need the unit to be free. This function then ran
-- its "cancelled" branch and freed the unit: hold_until, held_for_lead_id,
-- held_by_user_id, the token and the note, all wiped. A second INSERT
-- then booked the flat for whoever wanted it.
--
-- No error. No cross-tenant access needed. Any rep with `bookings:create`
-- could strip a colleague's hold on any unit in the workspace — which is
-- precisely the "quiet version of the double-sale" this file claims to
-- prevent.
--
-- THE ROOT CAUSE was asking "is this booking cancelled?" instead of "did
-- this booking just STOP occupying that unit?". Those coincide on the
-- happy path and diverge on every abusive one.
--
-- The same mistake produced a second, quieter bug: re-pointing a booking
-- from unit A to unit B synced only B, leaving A stuck at `booked` with
-- no live booking — permanently unsellable, on the board the sales team
-- trusts.
--
-- Both are fixed by computing the VACATED unit explicitly.

CREATE OR REPLACE FUNCTION sync_unit_status_from_booking()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  vacated uuid;
BEGIN
  /* ---------------------------------------------------------------- */
  /* 1. Which unit, if any, has this booking just STOPPED occupying?   */
  /* ---------------------------------------------------------------- */
  --
  -- ⚠️ Only ever on UPDATE, and only when the booking was previously
  -- LIVE ON THAT UNIT. An INSERT cannot vacate anything — a booking that
  -- did not exist a moment ago was not holding a flat. That single
  -- condition is what closes the born-cancelled hole above.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'cancelled' AND OLD.unit_id IS NOT NULL THEN
      IF NEW.status = 'cancelled' OR NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
        vacated := OLD.unit_id;
      END IF;
    END IF;
  END IF;

  IF vacated IS NOT NULL THEN
    UPDATE units
       SET status           = 'available',
           hold_until       = NULL,
           held_for_lead_id = NULL,
           held_by_user_id  = NULL,
           hold_token_minor = NULL,
           hold_note        = NULL,
           updated_at       = now()
     WHERE id = vacated
       -- Management's decision outranks the pipeline. A blocked unit
       -- stays blocked whatever happens to bookings around it.
       AND status <> 'blocked'
       -- And only if nothing ELSE live is attached to it.
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.unit_id = vacated
            AND b.status <> 'cancelled'
            AND b.id <> NEW.id
       );
  END IF;

  /* ---------------------------------------------------------------- */
  /* 2. Apply this booking's effect on the unit it now occupies.       */
  /* ---------------------------------------------------------------- */
  IF NEW.status = 'cancelled' OR NEW.unit_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'registered' THEN
    UPDATE units
       SET status = 'sold', hold_until = NULL, held_for_lead_id = NULL,
           held_by_user_id = NULL, updated_at = now()
     WHERE id = NEW.unit_id AND status <> 'blocked';
  ELSE
    -- tentative | confirmed | agreement — all mean "spoken for".
    UPDATE units
       SET status = 'booked', hold_until = NULL, held_for_lead_id = NULL,
           held_by_user_id = NULL, updated_at = now()
     WHERE id = NEW.unit_id AND status <> 'blocked';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_sync_unit ON bookings;
CREATE TRIGGER bookings_sync_unit
  AFTER INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_unit_status_from_booking();


-- ############################################################################
-- SECTION 5 — THE HOLD, AND HOW IT RELEASES ITSELF
-- ############################################################################
--
-- A hold with no deadline is a unit removed from sale by somebody who has
-- since left the company. The schema already refuses a `held` unit with no
-- `hold_until` (constraint `units_hold_is_complete`); this section is what
-- makes the deadline mean something.
--
-- ⚠️ IT IS A FUNCTION, NOT A CRON JOB THAT DELETES THINGS.
--
-- Same reasoning as the recycle bin in Phase 21: an unattended sweeper whose
-- failure mode is destroying customer state is a bad trade. This one only
-- ever moves `held` → `available`, which is recoverable by re-holding, and it
-- returns what it did so a caller can log it.
--
-- Call it from the inventory page load and from a scheduled route. Running it
-- twice is harmless.

-- ⚠️ THE `FROM prev` SUBQUERY IS NOT DECORATION.
--
-- The first version did `RETURNING u.held_for_lead_id` in the very
-- statement that sets `held_for_lead_id = NULL`. RETURNING yields the
-- NEW value, so the function dutifully reported that every hold had been
-- released from nobody.
--
-- Nothing errored. The sweep worked. Only the evidence was empty — which
-- is the exact failure mode that made the audit trail useless for
-- fourteen phases, arriving again in a new costume. Reading the OLD row
-- from a subquery first is the only way to report what was actually
-- there.

CREATE OR REPLACE FUNCTION release_expired_unit_holds(p_tenant_id uuid DEFAULT NULL)
RETURNS TABLE (unit_id uuid, unit_code text, released_from uuid)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE units u
     SET status           = 'available',
         hold_until       = NULL,
         held_for_lead_id = NULL,
         held_by_user_id  = NULL,
         hold_token_minor = NULL,
         hold_note        = NULL,
         updated_at       = now()
    FROM (
      SELECT p.id, p.code, p.held_for_lead_id
        FROM units p
       WHERE p.status = 'held'
         AND p.hold_until IS NOT NULL
         AND p.hold_until <= now()
         -- A held unit that somehow also has a live booking is NOT freed.
         -- That combination should be impossible; if it happens, the
         -- booking wins and a human should look at it.
         AND NOT EXISTS (
           SELECT 1 FROM bookings b
            WHERE b.unit_id = p.id AND b.status <> 'cancelled'
         )
         AND (p_tenant_id IS NULL OR p.tenant_id = p_tenant_id)
       -- ⚠️ FOR UPDATE, so two concurrent sweeps cannot both claim the
       -- same unit and both report having released it.
       FOR UPDATE
    ) prev
   WHERE u.id = prev.id
  RETURNING prev.id, prev.code::text, prev.held_for_lead_id;
END;
$$;


-- ----------------------------------------------------------------------------
-- 5b. A hold cannot be placed on a unit that is not free.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_unit_hold_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'held' THEN
    RETURN NEW;
  END IF;

  -- ⚠️ Every OLD reference below is nested inside `TG_OP = 'UPDATE'`, never
  -- combined with it by AND. PL/pgSQL will not promise to evaluate the left
  -- side first, and on an INSERT `OLD` is unassigned — reading it raises.
  IF TG_OP = 'UPDATE' THEN
    -- ══════════════════════════════════════════════════════════════
    -- 🔴 THE HOLE A SECURITY REVIEW FOUND HERE
    -- ══════════════════════════════════════════════════════════════
    -- This block used to early-return only when the lead was UNCHANGED,
    -- and fall through to the generic checks when it differed. A live
    -- hold passes every one of those checks trivially — not sold, not
    -- blocked, deadline in the future, no live booking.
    --
    -- So this was accepted, in two statements, with no error:
    --
    --     UPDATE units SET status='held', hold_until=now()+'5 days',
    --                      held_for_lead_id = <buyer A>  WHERE id = :u;
    --     UPDATE units SET held_for_lead_id = <buyer B>  WHERE id = :u;
    --
    -- Buyer A's hold silently became buyer B's, and `enforce_unit_bookable`
    -- then let B book the flat — because as far as it could tell, the
    -- unit was held for exactly the person now booking it. The headline
    -- hold guarantee was defeated without touching bookings at all.
    --
    -- A LIVE hold is now released explicitly or it is not moved.
    IF OLD.status = 'held'
       AND OLD.hold_until IS NOT NULL
       AND OLD.hold_until > now()
       AND OLD.held_for_lead_id IS DISTINCT FROM NEW.held_for_lead_id THEN
      RAISE EXCEPTION
        'Unit % is held for another buyer until %. Release that hold before '
        'holding it for someone else — reassigning it silently is how one '
        'buyer''s reservation becomes another''s.',
        NEW.code, OLD.hold_until
        USING ERRCODE = '23514';
    END IF;

    -- Re-saving a hold that is already in place, for the same buyer, is the
    -- ordinary case: extending a deadline, adding a note.
    --
    -- ⚠️ The deadline check below is deliberately NOT skipped here. The
    -- earlier version returned before it, which let an existing hold be
    -- backdated into the past — an expired hold that the sweep then had
    -- to clean up, created by a write path that should have refused it.
    IF OLD.status = 'held'
       AND OLD.held_for_lead_id IS NOT DISTINCT FROM NEW.held_for_lead_id THEN
      IF NEW.hold_until <= now() THEN
        RAISE EXCEPTION
          'A hold on unit % must expire in the future. Given: %.',
          NEW.code, NEW.hold_until
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    -- A sold or blocked unit is not available to hold. `sold` is obvious;
    -- `blocked` is the one that matters, because a rep holding a unit
    -- management has withdrawn is how a withdrawn unit gets sold anyway.
    IF OLD.status IN ('sold', 'blocked') THEN
      RAISE EXCEPTION
        'Unit % is %, so it cannot be held.', NEW.code, OLD.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.hold_until <= now() THEN
    RAISE EXCEPTION
      'A hold on unit % must expire in the future. Given: %.',
      NEW.code, NEW.hold_until
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM bookings b
     WHERE b.unit_id = NEW.id AND b.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION
      'Unit % already has a live booking and cannot be held.', NEW.code
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS units_hold_valid ON units;
CREATE TRIGGER units_hold_valid
  BEFORE INSERT OR UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION enforce_unit_hold_valid();


-- ############################################################################
-- SECTION 6 — THE COMMISSION-PROTECTION WINDOW
-- ############################################################################
--
-- A broker registers a buyer; for a defined period that buyer is theirs. It
-- is one of the most argued-about mechanics in Indian real estate, and the
-- argument is always about the same thing: somebody re-attributed the lead.
--
-- The re-attribution is rarely malicious. A rep merges duplicates, an import
-- overwrites a column, a manager reassigns a pipeline. The broker finds out
-- when the commission does not arrive, and the company has no record of the
-- change because a plain UPDATE leaves none.
--
-- ⚠️ THIS TRIGGER REFUSES, IT DOES NOT WARN.
--
-- A warning in the UI is bypassed by every write path that is not the UI.
-- Clearing the lock is a deliberate, separate act — set `cp_locked_until` to
-- NULL or to the past first, which is itself an UPDATE that the audit trail
-- records. That turns a silent overwrite into a decision somebody made.

CREATE OR REPLACE FUNCTION enforce_cp_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Nothing to protect.
  IF OLD.channel_partner_id IS NULL OR OLD.cp_locked_until IS NULL THEN
    RETURN NEW;
  END IF;

  -- The window has closed. The lead is fair game.
  IF OLD.cp_locked_until <= now() THEN
    RETURN NEW;
  END IF;

  -- Unchanged attribution — the usual case, every other edit to the lead.
  IF NEW.channel_partner_id IS NOT DISTINCT FROM OLD.channel_partner_id THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Lead % is registered to a channel partner until %. Re-attributing it now '
    'would move a commission that has already been earned. Clear the '
    'protection window first if that is genuinely what you intend.',
    OLD.reference, OLD.cp_locked_until
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS leads_cp_lock ON leads;
CREATE TRIGGER leads_cp_lock
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION enforce_cp_lock();


-- ############################################################################
-- SECTION 7 — LEAD ACTIVITY IS APPEND-ONLY
-- ############################################################################
--
-- `lead_activities` is the record of what was said to a buyer and when. It is
-- the first thing anybody reads in a dispute — a RERA complaint, a broker
-- argument, a customer saying they were promised something.
--
-- A record that can be edited afterwards is not evidence, and the edit that
-- matters is never done by an attacker. It is done by the rep who wants the
-- note to read better before a review.
--
-- Correcting a mistake means adding a new entry saying so. That is how a
-- ledger works, and this table is a ledger.

DROP TRIGGER IF EXISTS lead_activities_append_only ON lead_activities;
CREATE TRIGGER lead_activities_append_only
  BEFORE UPDATE OR DELETE ON lead_activities
  FOR EACH ROW EXECUTE FUNCTION block_mutation_append_only();


-- ############################################################################
-- SECTION 8 — updated_at
-- ############################################################################

DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS units_set_updated_at ON units;
CREATE TRIGGER units_set_updated_at BEFORE UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS leads_set_updated_at ON leads;
CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS channel_partners_set_updated_at ON channel_partners;
CREATE TRIGGER channel_partners_set_updated_at BEFORE UPDATE ON channel_partners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS bookings_set_updated_at ON bookings;
CREATE TRIGGER bookings_set_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS payment_milestones_set_updated_at ON payment_milestones;
CREATE TRIGGER payment_milestones_set_updated_at BEFORE UPDATE ON payment_milestones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ############################################################################
-- SECTION 9 — GRANTS
-- ############################################################################
--
-- REVOKE before GRANT. An additive-only block is defeated by any prior
-- `GRANT ALL ON ALL TABLES`, which is the first thing most people run when a
-- query fails with "permission denied". Found the hard way in Phase 11.
--
-- ⚠️ NO DELETE ON `bookings`.
--
-- A booking is a commercial commitment. The correction for a wrong one is
-- `cancelled` with a reason — which keeps the history, keeps the audit trail,
-- and frees the unit through Section 4b. A DELETE would do the same thing to
-- the inventory while erasing the fact that it ever happened, which is
-- precisely what somebody covering up a double-sale would want.
--
-- ⚠️ NO DELETE ON `lead_activities` either. Section 7's trigger already
-- refuses; removing the privilege means the attempt fails at the door rather
-- than inside a transaction that has already done other work.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON projects           FROM ordence_app;
    REVOKE ALL ON units              FROM ordence_app;
    REVOKE ALL ON leads              FROM ordence_app;
    REVOKE ALL ON lead_activities    FROM ordence_app;
    REVOKE ALL ON channel_partners   FROM ordence_app;
    REVOKE ALL ON bookings           FROM ordence_app;
    REVOKE ALL ON payment_milestones FROM ordence_app;

    -- Soft-deleted, so no DELETE.
    GRANT SELECT, INSERT, UPDATE ON projects         TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON units            TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON leads            TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON channel_partners TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON bookings         TO ordence_app;

    -- Append-only.
    GRANT SELECT, INSERT ON lead_activities TO ordence_app;

    -- Milestones are a plan, and a plan gets redrawn. DELETE is legitimate
    -- here — the payments themselves live in the Phase 11 ledger, not in
    -- this table, so removing a milestone destroys no financial record.
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment_milestones TO ordence_app;

    GRANT EXECUTE ON FUNCTION release_expired_unit_holds(uuid) TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 10 — VERIFICATION
-- ############################################################################
--
-- Run this whole section after `drizzle-kit push`. Every check names what
-- breaks if it fails, because "FAIL" on its own tells you nothing about
-- whether to panic.

-- Check 1 — RLS is ENABLED **and FORCED** on all seven tables.
-- ⚠️ `relforcerowsecurity` is the column that matters. A table with
-- ENABLE but not FORCE looks protected in every UI and is not protected
-- against its own owner.
SELECT
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS (enabled + forced)'
       WHEN c.relrowsecurity
       THEN '*** FAIL — enabled but NOT FORCED: the owner bypasses it ***'
       ELSE '*** FAIL — ROW LEVEL SECURITY IS OFF: every tenant can read '
            'every other tenant ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('projects','units','leads','lead_activities',
                    'channel_partners','bookings','payment_milestones')
ORDER BY c.relname;


-- Check 2 — every policy has BOTH a read and a write clause.
-- A policy with USING and no WITH CHECK stops a tenant READING another's
-- rows and happily lets them WRITE one.
SELECT
  tablename, policyname,
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS (read + write)'
       WHEN with_check IS NULL
       THEN '*** FAIL — no WITH CHECK: a tenant can INSERT a row into '
            'another tenant''s account ***'
       ELSE '*** FAIL — no USING clause ***'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('projects','units','leads','lead_activities',
                    'channel_partners','bookings','payment_milestones')
ORDER BY tablename;


-- Check 3 — ⭐ the composite foreign keys exist (Section 2).
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: a row can point at another tenant''s '
            'parent record ***'
  END AS verdict
FROM (VALUES
  ('units_project_same_tenant'),
  ('leads_project_same_tenant'),
  ('lead_activities_lead_same_tenant'),
  ('bookings_unit_same_tenant'),
  ('bookings_lead_same_tenant'),
  ('bookings_partner_same_tenant'),
  ('milestones_booking_same_tenant'),
  ('leads_partner_same_tenant'),
  ('units_held_lead_same_tenant'),
  -- 2d — the `users` edges. Absent from the first version of this check,
  -- which is why the gap reported PASS for a whole phase.
  ('leads_owner_same_tenant'),
  ('units_held_by_same_tenant'),
  ('bookings_rep_same_tenant'),
  ('lead_activities_user_same_tenant')
) AS expected(conname)
LEFT JOIN pg_constraint pc ON pc.conname = expected.conname;


-- Check 4 — ⭐ the double-sale index exists.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'bookings' AND indexname = 'bookings_one_live_per_unit'
  ) THEN 'PASS: one unit cannot carry two live bookings'
  ELSE  '*** FAIL: bookings_one_live_per_unit IS MISSING — two reps booking '
        'the same flat at the same moment WILL both succeed ***'
  END AS check_no_double_sale;


-- Check 5 — no unit is currently double-sold.
-- Belt and braces: if the index were created after data existed, duplicates
-- could predate it.
SELECT
  unit_id, count(*) AS live_bookings,
  '*** FAIL — TWO BUYERS ARE HOLDING THIS UNIT. Deal with this before '
  'anything else in this file. ***' AS verdict
FROM bookings
WHERE status <> 'cancelled' AND unit_id IS NOT NULL
GROUP BY unit_id
HAVING count(*) > 1;
-- (No rows returned = PASS.)


-- Check 6 — the guard triggers are installed AND enabled.
-- ⚠️ `tgenabled` needs the ::text cast; without it the comparison silently
-- misbehaves. Found in Phase 11 against a real PostgreSQL.
SELECT
  expected.tgname,
  CASE WHEN t.tgname IS NULL THEN '*** FAIL — TRIGGER MISSING ***'
       WHEN t.tgenabled::text = 'O' THEN 'PASS (enabled)'
       ELSE '*** FAIL — trigger DISABLED: ' || t.tgenabled::text || ' ***'
  END AS verdict
FROM (VALUES
  ('bookings_unit_bookable',      'bookings'),
  ('bookings_sync_unit',          'bookings'),
  ('units_hold_valid',            'units'),
  ('leads_cp_lock',               'leads'),
  ('lead_activities_append_only', 'lead_activities')
) AS expected(tgname, tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tgname
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal;


-- Check 7 — no held unit is missing its deadline or its buyer.
SELECT
  code,
  '*** FAIL — held with no deadline or no lead: this unit will never '
  'release ***' AS verdict
FROM units
WHERE status = 'held'
  AND (hold_until IS NULL OR held_for_lead_id IS NULL);
-- (No rows returned = PASS.)


-- Check 8 — nothing points across a tenant boundary TODAY.
-- The constraints in Section 2 prevent it going forward; this proves the
-- existing data is clean, which is what you need to know before trusting
-- that the constraints actually applied.
SELECT 'units → projects' AS relationship, count(*) AS violations,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END AS verdict
  FROM units u JOIN projects p ON p.id = u.project_id
 WHERE u.tenant_id <> p.tenant_id
UNION ALL
SELECT 'bookings → units', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM bookings b JOIN units u ON u.id = b.unit_id
 WHERE b.tenant_id <> u.tenant_id
UNION ALL
SELECT 'bookings → leads', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM bookings b JOIN leads l ON l.id = b.lead_id
 WHERE b.tenant_id <> l.tenant_id
UNION ALL
SELECT 'milestones → bookings', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM payment_milestones m JOIN bookings b ON b.id = m.booking_id
 WHERE m.tenant_id <> b.tenant_id
UNION ALL
-- The four edges into `users`. Omitted from the first version of this
-- check, which is exactly why the defect survived.
SELECT 'leads → users (owner)', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM leads l JOIN users u ON u.id = l.owner_id
 WHERE l.tenant_id <> u.tenant_id
UNION ALL
SELECT 'units → users (held by)', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM units un JOIN users u ON u.id = un.held_by_user_id
 WHERE un.tenant_id <> u.tenant_id
UNION ALL
SELECT 'bookings → users (rep)', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM bookings b JOIN users u ON u.id = b.sales_rep_id
 WHERE b.tenant_id <> u.tenant_id
UNION ALL
SELECT 'lead_activities → users', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM lead_activities la JOIN users u ON u.id = la.user_id
 WHERE la.tenant_id <> u.tenant_id;


-- Check 9 — the app role cannot DELETE a booking or an activity.
SELECT
  t.table_name, t.privilege_type,
  '*** FAIL — DELETE granted: a commercial record can be erased ***' AS verdict
FROM information_schema.role_table_grants t
WHERE t.grantee = 'ordence_app'
  AND t.privilege_type = 'DELETE'
  AND t.table_name IN ('bookings','lead_activities','projects','units','leads');
-- (No rows returned = PASS.)


-- Check 10 — the hold sweeper exists and is callable.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'release_expired_unit_holds'
  ) THEN 'PASS: expired holds can be released'
  ELSE  '*** FAIL — release_expired_unit_holds is missing: every hold ever '
        'placed is permanent ***'
  END AS check_hold_sweeper;
