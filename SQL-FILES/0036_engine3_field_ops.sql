-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — ENGINE 3 · FIELD & MOBILE OPERATIONS
-- File 0036 · v0.65.0-alpha · Session 1
--
-- Idempotent. Safe to run repeatedly.
--
-- ⭐ THE FILE THAT ASSUMES THE PHONE IS OFFLINE
-- ══════════════════════════════════════════════════════════════════════
-- Not "might occasionally be" — a basement plant room, a lift, a rooftop
-- behind a parapet, a driver in a tunnel. Offline is the NORMAL case and
-- every rule below follows from taking that literally.
--
-- ⚠️ FOUR THINGS IN THIS FILE ARE LOAD-BEARING:
--
--   1. THE DEVICE OWNS THE IDEMPOTENCY KEY. A phone that submits a
--      check-in, loses signal before the response and retries has sent
--      the same event twice. A server-side id cannot tell them apart —
--      they are two POSTs — so the customer gets two visits and two
--      bills. `client_event_id` is chosen on the handset before the first
--      attempt, so the retry collides with itself.
--
--   2. GPS IS EVIDENCE, NOT A GATE. Refusing a check-in 600 m out does
--      not stop the technician working; the customer is standing there.
--      It stops the work being RECORDED. What survives is a job history
--      missing exactly the hard jobs, and a team that has learned to
--      route around the system.
--
--   3. HAVERSINE, NOT PYTHAGORAS. A degree of longitude is 111 km at the
--      equator and 85 km at Delhi. Treating lat/long as a flat grid
--      understates east–west distance by about a quarter across India —
--      consistently, and in the direction that makes a distant check-in
--      look closer. That is the exact error the number exists to catch.
--
--   4. STATUS TRANSITIONS ARE ENFORCED IN THE DATABASE. An offline client
--      replaying a queue out of order will otherwise complete a job it
--      never arrived at, and the first-time-fix rate becomes fiction.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0 · Prerequisites ────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'field_jobs', 'field_visits', 'field_proofs', 'field_job_materials'
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
-- ⚠️ ENABLE **AND** FORCE — the owner bypasses a merely-enabled policy,
-- and migrations run as the owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'field_jobs', 'field_visits', 'field_proofs', 'field_job_materials'
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='field_visits_job_tenant_fk') THEN
    ALTER TABLE field_visits
      ADD CONSTRAINT field_visits_job_tenant_fk
      FOREIGN KEY (job_id, tenant_id)
      REFERENCES field_jobs (id, tenant_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='field_proofs_job_tenant_fk') THEN
    ALTER TABLE field_proofs
      ADD CONSTRAINT field_proofs_job_tenant_fk
      FOREIGN KEY (job_id, tenant_id)
      REFERENCES field_jobs (id, tenant_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='field_proofs_visit_tenant_fk') THEN
    ALTER TABLE field_proofs
      ADD CONSTRAINT field_proofs_visit_tenant_fk
      FOREIGN KEY (visit_id, tenant_id)
      REFERENCES field_visits (id, tenant_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='field_job_materials_job_tenant_fk') THEN
    ALTER TABLE field_job_materials
      ADD CONSTRAINT field_job_materials_job_tenant_fk
      FOREIGN KEY (job_id, tenant_id)
      REFERENCES field_jobs (id, tenant_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='field_job_materials_visit_tenant_fk') THEN
    ALTER TABLE field_job_materials
      ADD CONSTRAINT field_job_materials_visit_tenant_fk
      FOREIGN KEY (visit_id, tenant_id)
      REFERENCES field_visits (id, tenant_id) ON DELETE SET NULL;
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 3 · ⭐ HAVERSINE — DISTANCE ON A SPHERE
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ NOT PostGIS, AND NOT PYTHAGORAS.
--
-- PostGIS is the right answer for routing and polygons; it is a heavy
-- extension Neon must enable, it complicates every restore, and the only
-- spatial question this engine asks is "how far was the technician from
-- the site". That is one formula over two points.
--
-- Pythagoras on raw degrees is the tempting shortcut and it is wrong by
-- about 25% east-to-west across India — always in the direction that
-- makes a distant check-in look nearer than it was.
--
-- Mirrors haversineMetres() in db/schema/field-ops.ts.

CREATE OR REPLACE FUNCTION ordence_haversine_m(
  lat1 numeric, lon1 numeric,
  lat2 numeric, lon2 numeric
) RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  r        double precision := 6371000;  -- mean Earth radius, metres
  d_lat    double precision;
  d_lon    double precision;
  a        double precision;
BEGIN
  IF lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN
    RETURN NULL;
  END IF;

  d_lat := radians(lat2::double precision - lat1::double precision);
  d_lon := radians(lon2::double precision - lon1::double precision);

  a := sin(d_lat / 2) ^ 2
     + cos(radians(lat1::double precision))
     * cos(radians(lat2::double precision))
     * sin(d_lon / 2) ^ 2;

  RETURN round(2 * r * asin(LEAST(1, sqrt(a))))::integer;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 4 · ⭐ VISIT DERIVATION — DISTANCE AS A FLAG, NEVER A REFUSAL
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ READ THE HEADER BEFORE CHANGING THIS TO A RAISE EXCEPTION.
--
-- Every field system eventually has somebody propose "reject a check-in
-- more than 200 m from site". It sounds like a fraud control. What it
-- actually does is make the basement plant room, the metal-roofed
-- warehouse and the rural site unworkable — and the technician, who has a
-- customer waiting, does the job and records it later from the car park,
-- from memory. You have not gained a control; you have lost the data,
-- and specifically the data about the hardest jobs.
--
-- 500 m is a loose threshold on purpose. Urban GPS is routinely out by
-- 100–200 m. A trip-wire that fires on half of all honest check-ins is a
-- trip-wire everyone learns to ignore.

CREATE OR REPLACE FUNCTION field_visit_derive()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  job RECORD;
BEGIN
  SELECT id, site_latitude, site_longitude, status, job_number
    INTO job
    FROM field_jobs
   WHERE id = NEW.job_id AND tenant_id = NEW.tenant_id;

  IF job IS NULL THEN
    RAISE EXCEPTION 'Job % does not exist in this workspace.', NEW.job_id;
  END IF;

  /* ---- Distance from site: computed, stored, NOT enforced --------- */
  IF job.site_latitude IS NOT NULL AND NEW.checked_in_latitude IS NOT NULL THEN
    NEW.distance_from_site_m := ordence_haversine_m(
      job.site_latitude, job.site_longitude,
      NEW.checked_in_latitude, NEW.checked_in_longitude
    );

    -- ⚠️ MUST MATCH SUSPICIOUS_DISTANCE_M in db/schema/field-ops.ts.
    NEW.is_distance_suspicious := NEW.distance_from_site_m > /*SUSPICIOUS-M*/ 500;
  ELSE
    NEW.distance_from_site_m  := NULL;
    NEW.is_distance_suspicious := false;
  END IF;

  /* ---- Time on site ------------------------------------------------
   * ⚠️ FROM THE DEVICE CLOCK, NOT THE SERVER'S. A visit recorded at
   * 11:05 and synced at 18:40 when the technician got back into
   * coverage is an 11:05 visit that lasted however long it lasted. */
  IF NEW.checked_in_at IS NOT NULL AND NEW.checked_out_at IS NOT NULL THEN
    NEW.on_site_minutes := GREATEST(0, ROUND(
      EXTRACT(EPOCH FROM (NEW.checked_out_at - NEW.checked_in_at)) / 60
    )::integer);
  END IF;

  /* ---- Sequence within the job ------------------------------------- */
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(MAX(sequence), 0) + 1 INTO NEW.sequence
      FROM field_visits
     WHERE tenant_id = NEW.tenant_id AND job_id = NEW.job_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_field_visits_010_derive ON field_visits;
CREATE TRIGGER trg_field_visits_010_derive
  BEFORE INSERT OR UPDATE ON field_visits
  FOR EACH ROW EXECUTE FUNCTION field_visit_derive();
-- ⚠️ `010_` — BEFORE triggers fire in ALPHABETICAL order by name.


-- ══════════════════════════════════════════════════════════════════════
-- 5 · ⭐ THE VISIT COUNTER — THE NUMBER ALWAYS MISSING
-- ══════════════════════════════════════════════════════════════════════
--
-- How many times somebody was sent for this job. A job that took three
-- visits cost three lots of travel and burned two of the customer's
-- afternoons for nothing.
--
-- ⚠️ MAINTAINED BY TRIGGER, NOT COUNTED AT REPORT TIME. A dispatcher
-- needs to see it on the list, before assigning a fourth — and a report
-- nobody runs on a Tuesday morning is not a control.

CREATE OR REPLACE FUNCTION field_job_recount_visits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_job    uuid;
  target_tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_job := OLD.job_id; target_tenant := OLD.tenant_id;
  ELSE
    target_job := NEW.job_id; target_tenant := NEW.tenant_id;
  END IF;

  UPDATE field_jobs
     SET visit_count = (
           SELECT count(*) FROM field_visits
            WHERE job_id = target_job AND tenant_id = target_tenant
         ),
         updated_at = now()
   WHERE id = target_job AND tenant_id = target_tenant;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_field_visits_recount ON field_visits;
CREATE TRIGGER trg_field_visits_recount
  AFTER INSERT OR DELETE ON field_visits
  FOR EACH ROW EXECUTE FUNCTION field_job_recount_visits();


-- ══════════════════════════════════════════════════════════════════════
-- 6 · ⭐ THE STATUS MACHINE, ENFORCED WHERE THE CLIENT CANNOT REACH
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ THIS IS NOT DEFENSIVE PROGRAMMING; IT IS THE OFFLINE MODEL.
--
-- A phone that has been out of coverage for four hours reconnects and
-- replays a queue. The queue is not guaranteed to be in order — a retry
-- of an early event can land after a later one. Without a guard here, a
-- job gets marked `completed` and then `travelling`, or `completed`
-- without ever having been `on_site`, and the first-time-fix rate — the
-- one number field service is actually managed by — becomes fiction.
--
-- ⚠️ AND `completed` IS TERMINAL. Re-opening is a NEW job that references
-- this one. Letting a completed job move backwards means every failed
-- fix quietly edits itself out of the record.
--
-- The map below MUST match FIELD_JOB_TRANSITIONS in
-- db/schema/field-ops.ts. The test suite asserts it, field by field.

CREATE OR REPLACE FUNCTION field_job_guard_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status::text
    /*TRANSITIONS*/
    WHEN 'draft'              THEN ARRAY['scheduled','cancelled']
    WHEN 'scheduled'          THEN ARRAY['dispatched','cancelled','scheduled']
    WHEN 'dispatched'         THEN ARRAY['travelling','on_site','could_not_complete','cancelled','scheduled']
    WHEN 'travelling'         THEN ARRAY['on_site','could_not_complete','cancelled']
    WHEN 'on_site'            THEN ARRAY['paused','completed','could_not_complete']
    WHEN 'paused'             THEN ARRAY['on_site','could_not_complete','cancelled']
    WHEN 'completed'          THEN ARRAY[]::text[]
    WHEN 'could_not_complete' THEN ARRAY['scheduled']
    WHEN 'cancelled'          THEN ARRAY[]::text[]
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status::text = ANY(allowed)) THEN
    RAISE EXCEPTION
      'Job % cannot move from % to %. Permitted next steps: %. (A completed or cancelled job is final — re-open by raising a new job that references this one, so the failed first attempt stays in the record.)',
      OLD.job_number, OLD.status, NEW.status,
      CASE WHEN array_length(allowed,1) IS NULL
           THEN 'none — this status is final'
           ELSE array_to_string(allowed, ', ') END;
  END IF;

  /* ⚠️ A JOB CANNOT BE COMPLETED WITHOUT SOMEBODY HAVING ARRIVED.
   * Otherwise a mis-tapped button on a list screen closes a job nobody
   * attended, and it looks identical to one that went perfectly. */
  IF NEW.status = 'completed' THEN
    IF NOT EXISTS (
      SELECT 1 FROM field_visits
       WHERE job_id = NEW.id AND tenant_id = NEW.tenant_id
         AND checked_in_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION
        'Job % cannot be completed: no visit has been checked in against it. Record the visit first — a job completed with nobody having arrived is indistinguishable from one that went perfectly.',
        OLD.job_number;
    END IF;
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  END IF;

  /* A stated failure reason, or the number is meaningless. */
  IF NEW.status = 'could_not_complete' AND NEW.failure_reason IS NULL THEN
    RAISE EXCEPTION
      'Job % cannot be marked "could not complete" without a reason. "Closed" and "completed" are different outcomes, and a team that drives to sites and finds nobody home has a scheduling problem invisible to anyone reading a single closed flag.',
      OLD.job_number;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_field_jobs_transition ON field_jobs;
CREATE TRIGGER trg_field_jobs_transition
  BEFORE UPDATE ON field_jobs
  FOR EACH ROW EXECUTE FUNCTION field_job_guard_transition();


-- ══════════════════════════════════════════════════════════════════════
-- 7 · ⭐ PROOF IS APPEND-ONLY
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ A PHOTO THAT CAN BE REPLACED AFTERWARDS IS NOT EVIDENCE, IT IS A
-- PICTURE. The only reason a customer accepts "we attended and the unit
-- was working" is that nobody could have changed the record later.
-- Editable proof is worth nothing in the single conversation it exists
-- for.

CREATE OR REPLACE FUNCTION field_proof_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Proof of service cannot be % (proof %). Add a NEW proof record instead — the value of this table is that nothing in it can be changed after the fact.',
    lower(TG_OP), OLD.id;
END $$;

DROP TRIGGER IF EXISTS trg_field_proofs_immutable ON field_proofs;
CREATE TRIGGER trg_field_proofs_immutable
  BEFORE UPDATE OR DELETE ON field_proofs
  FOR EACH ROW EXECUTE FUNCTION field_proof_immutable();


-- ══════════════════════════════════════════════════════════════════════
-- 8 · VIEWS
-- ══════════════════════════════════════════════════════════════════════
--
-- `security_invoker` on both: without it a view runs as its OWNER and RLS
-- does not apply, which is a cross-tenant leak no policy audit catches
-- because every policy underneath is correct.

/**
 * ⭐ THE DISPATCH BOARD. What is open, who has it, and whether it is late.
 */
CREATE OR REPLACE VIEW v_field_dispatch_board
WITH (security_invoker = true) AS
SELECT
  j.tenant_id,
  j.id                AS job_id,
  j.job_number,
  j.title,
  j.job_kind,
  j.status,
  j.priority,
  j.assigned_user_id,
  j.crew_name,
  j.window_start,
  j.window_end,
  j.visit_count,
  j.customer_company_id,
  j.site_address,
  -- ⭐ Late against the promise made to the customer, not against an
  -- internal target nobody was told about.
  (j.window_end IS NOT NULL
   AND j.window_end < now()
   AND j.status NOT IN ('completed','cancelled','could_not_complete'))
                      AS is_overdue,
  -- ⚠️ A THIRD VISIT IS THE OPERATIONAL ALARM. Two is bad luck; three is
  -- a diagnosis that was wrong twice, and it is almost always cheaper to
  -- send a different person than the same one again.
  (j.visit_count >= 3) AS is_repeat_failure,
  (SELECT count(*) FROM field_visits v
    WHERE v.job_id = j.id AND v.tenant_id = j.tenant_id
      AND v.is_distance_suspicious)  AS suspicious_checkins
FROM field_jobs j
WHERE j.deleted_at IS NULL
  AND j.status NOT IN ('completed','cancelled');

/**
 * ⭐ FIRST-TIME FIX RATE, per technician.
 *
 * ⚠️ THE ONE NUMBER FIELD SERVICE IS ACTUALLY MANAGED BY, and the reason
 * `completed` is a terminal status. If a completed job could be moved
 * backwards and completed again, every failed first attempt would edit
 * itself out of this calculation and the figure would trend to 100%
 * while the business got worse.
 */
-- ⚠️ THE JOIN THAT USED TO BE HERE MADE THIS METRIC LIE, AND IT LIED IN
-- THE DIRECTION THAT HIDES THE PROBLEM.
--
-- The first version `LEFT JOIN`ed `field_visits` to get an average time on
-- site, then counted with a bare `count(*)`. A join like that fans out:
-- a job with three visits becomes three rows. So `completed` counted that
-- job three times — while `first_time_fixes`, which only ever matches
-- single-visit jobs, counted its jobs once.
--
-- The published percentage was therefore
--
--     single-visit completions ÷ SUM OF VISITS across completions
--
-- rather than ÷ number of completions. The denominator grows with exactly
-- the repeat work the metric exists to expose, so a technician who needed
-- three trips per job scored roughly a third of their true rate — and a
-- team improving its first-time-fix rate would watch the number barely
-- move, because the fan-out shrank at the same time.
--
-- ⭐ `count(DISTINCT j.id)` IS THE FIX, and the average moves to a lateral
-- so the visit rows never multiply the job rows in the first place.
CREATE OR REPLACE VIEW v_field_technician_performance
WITH (security_invoker = true) AS
SELECT
  j.tenant_id,
  j.assigned_user_id,
  count(DISTINCT j.id)                                      AS jobs_closed,
  count(DISTINCT j.id) FILTER (WHERE j.status = 'completed')
                                                            AS completed,
  count(DISTINCT j.id) FILTER (WHERE j.status = 'could_not_complete')
                                                            AS failed,
  count(DISTINCT j.id) FILTER (
    WHERE j.status = 'completed' AND j.visit_count = 1
  )                                                         AS first_time_fixes,
  /* ⭐ THE ONE NUMBER FIELD SERVICE IS ACTUALLY MANAGED BY. It is also
   * why `completed` is a terminal status: if a completed job could be
   * re-opened and completed again, every failed first attempt would edit
   * itself out of this figure and it would trend to 100% while the
   * business got worse. */
  ROUND(
    100.0 * count(DISTINCT j.id) FILTER (
      WHERE j.status = 'completed' AND j.visit_count = 1
    )
    / NULLIF(count(DISTINCT j.id) FILTER (WHERE j.status = 'completed'), 0)
  , 1)                                                      AS first_time_fix_pct,
  AVG(mins.avg_on_site)                                     AS avg_on_site_minutes
FROM field_jobs j
LEFT JOIN LATERAL (
  SELECT AVG(v.on_site_minutes) AS avg_on_site
    FROM field_visits v
   WHERE v.job_id = j.id
     AND v.tenant_id = j.tenant_id
     AND v.on_site_minutes IS NOT NULL
) mins ON true
WHERE j.deleted_at IS NULL
  AND j.status IN ('completed','could_not_complete')
GROUP BY j.tenant_id, j.assigned_user_id;


-- ══════════════════════════════════════════════════════════════════════
-- 9 · GRANTS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ GRANT DOES NOT NARROW. A privilege already held survives a later
-- GRANT that omits it; removing one takes an explicit REVOKE.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON field_jobs          TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON field_visits        TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON field_job_materials TO ordence_app;

    -- ⭐ PROOF IS APPEND-ONLY AT THE PRIVILEGE LEVEL, not only by trigger.
    GRANT SELECT, INSERT ON field_proofs TO ordence_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON field_proofs FROM ordence_app;

    GRANT SELECT ON v_field_dispatch_board          TO ordence_app;
    GRANT SELECT ON v_field_technician_performance  TO ordence_app;

    GRANT EXECUTE ON FUNCTION ordence_haversine_m(numeric, numeric, numeric, numeric)
      TO ordence_app;
  END IF;
END $$;

COMMIT;
