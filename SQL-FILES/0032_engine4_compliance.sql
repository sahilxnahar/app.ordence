-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — ENGINE 4 · THE COMPLIANCE CALENDAR
-- File 0032 · v0.57.0-alpha · Session 1
--
-- Idempotent. Safe to run repeatedly.
--
-- WHAT THIS FILE ENFORCES THAT THE APPLICATION CANNOT
-- ══════════════════════════════════════════════════════════════════════
--   1. Tenant isolation — RLS ENABLE **and FORCE** on all four tables
--   2. ⭐ The due date is DERIVED from the period, never accepted
--   3. A filing cannot be marked done without its acknowledgement number
--   4. `not_applicable` / `waived` cannot be set without a written reason
--   5. Days late and the late fee are COMPUTED, never typed
--   6. Licence status follows from the expiry date, not from a form
--   7. Evidence is append-only: superseding adds a row, never replaces
--
-- Every one of these lives in the database because a rule that lives in a
-- screen is a rule the back-fill, the import and the 6pm support fix walk
-- straight past — and the compliance register's whole value is that it is
-- true even when somebody was in a hurry.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0 · Guard: the tables must exist ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'compliance_obligations'
  ) THEN
    RAISE EXCEPTION
      'compliance_obligations is missing. Run `drizzle-kit push` (or deploy) before this file.';
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 1 · ROW-LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ ENABLE alone is not enough. Without FORCE, the table OWNER bypasses
-- every policy — and the application connects as the owner on Neon. A
-- suite that verified isolation as the owner would report green forever,
-- including on the day the policies were dropped.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'compliance_obligations',
    'compliance_tasks',
    'compliance_evidence',
    'compliance_licences'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
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
-- A plain foreign key lets a task in tenant A point at an obligation in
-- tenant B. Both rows individually satisfy their own RLS policy, so
-- nothing complains — and the join silently reads across the boundary.
-- The composite key makes that state unrepresentable.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'compliance_tasks_obligation_tenant_fk'
  ) THEN
    ALTER TABLE compliance_tasks
      ADD CONSTRAINT compliance_tasks_obligation_tenant_fk
      FOREIGN KEY (obligation_id, tenant_id)
      REFERENCES compliance_obligations (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'compliance_evidence_task_tenant_fk'
  ) THEN
    ALTER TABLE compliance_evidence
      ADD CONSTRAINT compliance_evidence_task_tenant_fk
      FOREIGN KEY (task_id, tenant_id)
      REFERENCES compliance_tasks (id, tenant_id)
      ON DELETE CASCADE;
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- 3 · ONE OBLIGATION PER CODE PER SUBJECT
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ TWO PARTIAL INDEXES, NOT ONE COMPOSITE UNIQUE.
--
-- `subject_company_id` is nullable, and in a unique index NULL is never
-- equal to NULL. A single UNIQUE(tenant_id, code, subject_company_id)
-- would therefore permit unlimited duplicates of the tenant's OWN
-- obligations — the exact rows that matter most — while appearing to
-- prevent duplication. Two partial indexes cover both cases honestly.

CREATE UNIQUE INDEX IF NOT EXISTS compliance_obligations_own_code_key
  ON compliance_obligations (tenant_id, code)
  WHERE subject_company_id IS NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS compliance_obligations_client_code_key
  ON compliance_obligations (tenant_id, subject_company_id, code)
  WHERE subject_company_id IS NOT NULL AND deleted_at IS NULL;


-- ══════════════════════════════════════════════════════════════════════
-- 4 · ⭐ THE DUE DATE IS DERIVED
-- ══════════════════════════════════════════════════════════════════════
--
-- GSTR-3B for July is due 20 August. Not "twenty days after the row was
-- created" — the twentieth of the following month, always.
--
-- ⚠️ AND DAY 31 IS CLAMPED TO THE MONTH'S REAL LAST DAY.
--
-- Storing 31 to mean "last day of the month" is the natural thing to do
-- and it breaks in February, in April, and in every 30-day month. Rather
-- than a separate `use_last_day` flag that somebody will forget to set,
-- the trigger clamps: day 31 of a 28-day February is 28 February. So
-- "31" reads as "the last day", correctly, everywhere.

CREATE OR REPLACE FUNCTION compliance_derive_due_date()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ob            RECORD;
  base_month    date;
  target_month  date;
  last_day      integer;
  effective_day integer;
BEGIN
  SELECT due_month_offset, due_day_of_month, severity, owner_user_id
    INTO ob
    FROM compliance_obligations
   WHERE id = NEW.obligation_id
     AND tenant_id = NEW.tenant_id;

  IF ob IS NULL THEN
    RAISE EXCEPTION
      'Obligation % does not exist in this workspace.', NEW.obligation_id;
  END IF;

  -- First day of the month the period ends in.
  base_month   := date_trunc('month', NEW.period_end)::date;
  target_month := (base_month + (ob.due_month_offset || ' months')::interval)::date;

  -- The real number of days in that target month.
  last_day := EXTRACT(
    DAY FROM (date_trunc('month', target_month) + interval '1 month - 1 day')
  )::integer;

  effective_day := LEAST(ob.due_day_of_month, last_day);

  NEW.due_date := (date_trunc('month', target_month)
                    + ((effective_day - 1) || ' days')::interval)::date;

  -- Severity follows the obligation unless the task overrides it.
  IF TG_OP = 'INSERT' THEN
    NEW.severity := COALESCE(NEW.severity, ob.severity);
    NEW.owner_user_id := COALESCE(NEW.owner_user_id, ob.owner_user_id);
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_compliance_tasks_010_due_date ON compliance_tasks;
CREATE TRIGGER trg_compliance_tasks_010_due_date
  BEFORE INSERT OR UPDATE OF period_end, obligation_id ON compliance_tasks
  FOR EACH ROW EXECUTE FUNCTION compliance_derive_due_date();
--
-- ⚠️ THE `010_` PREFIX IS LOAD-BEARING.
--
-- PostgreSQL fires BEFORE triggers in ALPHABETICAL order by name, not in
-- creation order. The completion trigger below computes days late from
-- `due_date`, so it MUST run after this one. Numbering the names is the
-- only way to state that dependency; relying on creation order works
-- until somebody recreates one trigger and not the other.


-- ══════════════════════════════════════════════════════════════════════
-- 5 · ⭐ COMPLETION: THE RULES OF BEING DONE
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION compliance_task_completion_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ob        RECORD;
  filed_on  date;
  late_days integer;
  fee       bigint;
BEGIN
  /* ---- 1 · A filing needs its acknowledgement -------------------
   *
   * ⚠️ ARN, challan, SRN, receipt — whatever the authority gave back.
   * "I definitely filed it" has never won an argument with a regulator,
   * and a register full of unreferenced filings is a register that
   * cannot be defended. Enforced here rather than in the form because
   * the back-fill and the support fix do not go through the form.
   */
  IF NEW.status IN ('filed', 'late_filed')
     AND (NEW.filing_reference IS NULL OR btrim(NEW.filing_reference) = '') THEN
    RAISE EXCEPTION
      'Cannot mark "%" as % without a filing reference (ARN / challan / receipt number).',
      NEW.period_label, NEW.status;
  END IF;

  /* ---- 2 · Not-applicable needs a reason ------------------------
   *
   * "We did not file because we are not registered for it" and "we did
   * not file" are completely different facts, and a status alone cannot
   * tell them apart. Six months later nobody remembers which it was.
   */
  IF NEW.status IN ('not_applicable', 'waived')
     AND (NEW.exemption_reason IS NULL OR btrim(NEW.exemption_reason) = '') THEN
    RAISE EXCEPTION
      'Marking "%" as % requires a written reason.', NEW.period_label, NEW.status;
  END IF;

  /* ---- 3 · Days late and the fee are COMPUTED ------------------- */
  IF NEW.status IN ('filed', 'late_filed') THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
    filed_on := (NEW.completed_at AT TIME ZONE 'UTC')::date;

    late_days := GREATEST(0, filed_on - NEW.due_date);
    NEW.days_late := late_days;

    /* ⚠️ THE STATUS IS CORRECTED, NOT TRUSTED.
     *
     * Somebody marking a filing `filed` when it went in three weeks
     * after the deadline is not lying — they are using the button that
     * says "done". But a register where late filings are recorded as
     * on-time cannot answer "how often are we late", which is the only
     * leading indicator of a compliance failure that exists. So the
     * dates decide, not the dropdown.
     */
    IF late_days > 0 THEN
      NEW.status := 'late_filed';
    ELSE
      NEW.status := 'filed';
    END IF;

    SELECT late_fee_per_day_minor, late_fee_cap_minor
      INTO ob
      FROM compliance_obligations
     WHERE id = NEW.obligation_id AND tenant_id = NEW.tenant_id;

    fee := COALESCE(ob.late_fee_per_day_minor, 0) * late_days;

    IF ob.late_fee_cap_minor IS NOT NULL AND fee > ob.late_fee_cap_minor THEN
      fee := ob.late_fee_cap_minor;
    END IF;

    NEW.late_fee_minor := fee;

  ELSIF NEW.status IN ('not_applicable', 'waived') THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
    NEW.days_late := 0;
    NEW.late_fee_minor := 0;

  ELSE
    -- Reopened. Clear the completion facts rather than leaving stale
    -- ones behind, which would read as "filed, and also pending".
    NEW.completed_at := NULL;
    NEW.completed_by_user_id := NULL;
    NEW.days_late := 0;
    NEW.late_fee_minor := 0;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_compliance_tasks_020_completion ON compliance_tasks;
CREATE TRIGGER trg_compliance_tasks_020_completion
  BEFORE INSERT OR UPDATE ON compliance_tasks
  FOR EACH ROW EXECUTE FUNCTION compliance_task_completion_guard();


-- ══════════════════════════════════════════════════════════════════════
-- 6 · ⭐ A MISSED DEADLINE CANNOT BE DELETED
-- ══════════════════════════════════════════════════════════════════════
--
-- The register's entire value is that it can be handed to an inspector.
-- A system that lets you delete the filing you forgot produces a clean
-- register and a false one — and it will let you forget the next one too,
-- because nothing accumulates.
--
-- Draft/pending tasks generated in error CAN be removed: nothing has been
-- asserted about them yet. Anything that was ever completed, or is now
-- overdue, stays.

CREATE OR REPLACE FUNCTION compliance_task_delete_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('filed', 'late_filed', 'missed', 'not_applicable', 'waived') THEN
    RAISE EXCEPTION
      'Task "%" is % and cannot be deleted. A compliance register that can be tidied is not a register. Reopen it instead if it was recorded in error.',
      OLD.period_label, OLD.status;
  END IF;

  IF OLD.due_date < CURRENT_DATE THEN
    RAISE EXCEPTION
      'Task "%" is past its due date (%) and cannot be deleted. Mark it not_applicable with a reason if it never applied.',
      OLD.period_label, OLD.due_date;
  END IF;

  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_compliance_tasks_delete_guard ON compliance_tasks;
CREATE TRIGGER trg_compliance_tasks_delete_guard
  BEFORE DELETE ON compliance_tasks
  FOR EACH ROW EXECUTE FUNCTION compliance_task_delete_guard();


-- ══════════════════════════════════════════════════════════════════════
-- 7 · EVIDENCE IS APPEND-ONLY
-- ══════════════════════════════════════════════════════════════════════
--
-- A revised return does not erase the original — it supersedes it, and
-- being able to show BOTH is what a revision is. So superseding writes a
-- pointer; it never overwrites and never deletes.
--
-- ⚠️ The hash is immutable too. An evidence row whose `content_sha256`
-- can be edited proves nothing at all: the whole point is that the file
-- either matches the value recorded at upload or it has changed since.

CREATE OR REPLACE FUNCTION compliance_evidence_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Compliance evidence is never deleted. Supersede it with a newer row instead.';
  END IF;

  IF OLD.content_sha256 IS NOT NULL
     AND NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 THEN
    RAISE EXCEPTION
      'The content hash of filed evidence cannot be changed. Upload the new file as a superseding row.';
  END IF;

  IF NEW.document_id IS DISTINCT FROM OLD.document_id
     AND OLD.document_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Filed evidence cannot be repointed at a different document. Supersede it instead.';
  END IF;

  IF NEW.superseded_by_evidence_id IS NOT NULL
     AND OLD.superseded_by_evidence_id IS NULL THEN
    NEW.superseded_at := COALESCE(NEW.superseded_at, now());
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_compliance_evidence_append_only ON compliance_evidence;
CREATE TRIGGER trg_compliance_evidence_append_only
  BEFORE UPDATE OR DELETE ON compliance_evidence
  FOR EACH ROW EXECUTE FUNCTION compliance_evidence_append_only();


-- ══════════════════════════════════════════════════════════════════════
-- 8 · ⭐ LICENCE STATUS FOLLOWS THE CALENDAR
-- ══════════════════════════════════════════════════════════════════════
--
-- A licence that expired last Tuesday is expired, whatever the dropdown
-- says. Leaving status to a human means a fire NOC reads `active` for
-- eight months after it lapsed, and the one thing this table exists to
-- prevent is exactly that.
--
-- ⚠️ `suspended` / `cancelled` / `not_required` are NOT overwritten. Those
-- are external facts about the licence, not positions on a calendar — a
-- suspended licence is suspended whether or not its printed date has
-- passed, and quietly relabelling it `active` because the date is in the
-- future would be worse than doing nothing.

CREATE OR REPLACE FUNCTION compliance_licence_status_from_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('suspended', 'cancelled', 'not_required') THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.valid_until IS NULL THEN
    NEW.status := 'active';           -- no expiry recorded
  ELSIF NEW.valid_until < CURRENT_DATE THEN
    NEW.status := 'expired';
  ELSIF NEW.valid_until - CURRENT_DATE <= NEW.renewal_lead_days THEN
    -- Inside the renewal window. `under_renewal` is a human statement
    -- that somebody has started, so it is not overwritten.
    IF NEW.status <> 'under_renewal' THEN
      NEW.status := 'renewal_due';
    END IF;
  ELSE
    NEW.status := 'active';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_compliance_licences_status ON compliance_licences;
CREATE TRIGGER trg_compliance_licences_status
  BEFORE INSERT OR UPDATE ON compliance_licences
  FOR EACH ROW EXECUTE FUNCTION compliance_licence_status_from_dates();


-- ══════════════════════════════════════════════════════════════════════
-- 9 · THE BOARD — read-optimised views
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ `security_invoker = true` ON BOTH, AND IT IS LOAD-BEARING.
--
-- A PostgreSQL view runs as its OWNER by default, so row-level security
-- does NOT apply through it: an ordinary view over these tables would
-- return every tenant's compliance position to whoever could read it.
-- Measured during Phase 10 on the analytics views: 6 tenants visible
-- through a naive view, 1 through a security_invoker view. The failure
-- has no symptom — nothing errors, the numbers are simply everybody's.

CREATE OR REPLACE VIEW v_compliance_board
WITH (security_invoker = true) AS
SELECT
  t.id,
  t.tenant_id,
  t.subject_company_id,
  c.name                                    AS subject_name,
  o.code                                    AS obligation_code,
  o.name                                    AS obligation_name,
  o.authority,
  o.frequency,
  t.period_label,
  t.period_start,
  t.period_end,
  t.due_date,
  t.status,
  t.severity,
  t.owner_user_id,
  t.days_late,
  t.late_fee_minor,
  t.filing_reference,

  -- Negative = overdue by that many days. One signed number is easier to
  -- sort and reason about than a boolean plus a magnitude.
  (t.due_date - CURRENT_DATE)               AS days_until_due,

  CASE
    WHEN t.status IN ('filed','late_filed','not_applicable','waived') THEN 'done'
    WHEN t.due_date <  CURRENT_DATE                                  THEN 'overdue'
    WHEN t.due_date =  CURRENT_DATE                                  THEN 'due_today'
    WHEN t.due_date - CURRENT_DATE <= o.reminder_lead_days            THEN 'due_soon'
    ELSE 'upcoming'
  END                                       AS bucket,

  -- ⭐ What being late WOULD cost, if it is not done yet. This is the
  -- number that makes somebody act today instead of tomorrow.
  CASE
    WHEN t.status IN ('filed','late_filed','not_applicable','waived') THEN t.late_fee_minor
    WHEN t.due_date < CURRENT_DATE THEN
      LEAST(
        COALESCE(o.late_fee_cap_minor, 9223372036854775807),
        o.late_fee_per_day_minor * (CURRENT_DATE - t.due_date)
      )
    ELSE 0
  END                                       AS exposure_minor
FROM compliance_tasks t
JOIN compliance_obligations o
  ON o.id = t.obligation_id AND o.tenant_id = t.tenant_id
LEFT JOIN companies c
  ON c.id = t.subject_company_id AND c.tenant_id = t.tenant_id;


CREATE OR REPLACE VIEW v_compliance_licence_board
WITH (security_invoker = true) AS
SELECT
  l.id,
  l.tenant_id,
  l.subject_company_id,
  c.name                                    AS subject_name,
  l.name,
  l.authority,
  l.licence_number,
  l.applies_to,
  l.valid_until,
  l.status,
  l.severity,
  l.renewal_fee_minor,
  l.owner_user_id,
  (l.valid_until - CURRENT_DATE)            AS days_until_expiry,
  CASE
    WHEN l.status IN ('cancelled','not_required')            THEN 'closed'
    WHEN l.status = 'suspended'                              THEN 'suspended'
    WHEN l.valid_until IS NULL                               THEN 'no_expiry'
    WHEN l.valid_until <  CURRENT_DATE                       THEN 'expired'
    WHEN l.valid_until - CURRENT_DATE <= l.renewal_lead_days  THEN 'renewal_due'
    ELSE 'active'
  END                                       AS bucket
FROM compliance_licences l
LEFT JOIN companies c
  ON c.id = l.subject_company_id AND c.tenant_id = l.tenant_id
WHERE l.deleted_at IS NULL;


-- ══════════════════════════════════════════════════════════════════════
-- 10 · GRANTS
-- ══════════════════════════════════════════════════════════════════════
--
-- ⚠️ NO DELETE ON EVIDENCE. The trigger refuses it anyway, but a revoked
-- privilege is a wall and a trigger is a rule — and walls do not depend
-- on the rule still being installed after the next `drizzle-kit push`.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON compliance_obligations TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON compliance_tasks       TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON compliance_evidence    TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON compliance_licences    TO ordence_app;
    GRANT SELECT ON v_compliance_board          TO ordence_app;
    GRANT SELECT ON v_compliance_licence_board  TO ordence_app;

    /* ⭐ AND THEN REVOKE — GRANT DOES NOT NARROW.
     *
     * ══════════════════════════════════════════════════════════════
     * 🔴 CAUGHT BY TESTING, NOT BY READING.
     * ══════════════════════════════════════════════════════════════
     * Granting `SELECT, INSERT, UPDATE` above does NOT take DELETE
     * away. Privileges accumulate. The CI pipeline — and every
     * sensible bootstrap — starts with a blanket
     * `GRANT ALL ON ALL TABLES IN SCHEMA public`, so DELETE on
     * evidence was already there, and the narrower grant above sat
     * quietly on top of it changing nothing.
     *
     * The append-only trigger still refused the delete, which is how
     * this survived the first test run looking green. But a trigger
     * is a rule and a revoked privilege is a wall: `drizzle-kit push`
     * drops triggers it does not know about, and the wall is what
     * remains standing on the day the rule does not.
     */
    REVOKE DELETE ON compliance_evidence FROM ordence_app;
  END IF;
END $$;

COMMIT;

-- ══════════════════════════════════════════════════════════════════════
-- DONE. Four tables, two views, seven enforced rules.
-- ══════════════════════════════════════════════════════════════════════
