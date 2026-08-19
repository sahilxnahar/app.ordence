-- =====================================================================
--  🔴🔴🔴 DRILL — DO NOT RUN THIS IN NEON 🔴🔴🔴
-- =====================================================================
--
--  It creates tables, seeds employees, reporting lines and appraisals,
--  and then deliberately breaks things to show them being refused.
--  Throwaway Postgres only.
--
--     createdb drill0085
--     psql -q -d drill0085 -f DRILL-DO-NOT-RUN-IN-NEON-0085.sql
--
--  ⚠️ LIKE 0082'S DRILL, THIS ONE DOES NOT REFUSE TO RUN AS A SUPERUSER.
--  Nothing under test here is a permission: every refusal below is a
--  CHECK constraint, a unique index or a trigger, and no role bypasses
--  any of those. RLS is deliberately absent from the reproduction —
--  0079's drill covers it, and including it here would invite the reader
--  to think a refusal came from a policy when it came from a trigger.
--
--  ⭐ EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL WORK. A
--  drill that only shows breaks cannot tell "the trigger works" from
--  "the table rejects everything", and a table that rejects everything
--  passes every refusal in this file.
--
--  🔴 THE HEADLINE IS NEGATIVE 3: A TWO-HOP CYCLE. It is the one this
--  whole batch is arranged around, it is the one a foreign key has no
--  opinion about, and before 0085 the database would have accepted it
--  and then hung the first time anything walked the chart.
-- =====================================================================


-- =====================================================================
--  STEP 0 — REFUSE TO RUN SOMEWHERE THAT MATTERS
-- =====================================================================
DO $$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production')
  THEN
    RAISE EXCEPTION
      '🔴 REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;
END
$$;

-- =====================================================================
--  STEP 1 — THE SHAPES, REPRODUCED FROM 0075 AND 0085
-- =====================================================================
--
--  `employees` is cut down to the columns this drill reasons about.
--  Everything from 0085 is copied as it ships.

DROP TABLE IF EXISTS appraisal_amendments, appraisal_reviews, appraisal_subjects,
                     appraisal_cycles, reporting_lines, employees, users, tenants CASCADE;
DROP FUNCTION IF EXISTS reporting_lines_no_cycle() CASCADE;
DROP FUNCTION IF EXISTS appraisal_subjects_freeze_signed() CASCADE;
DROP FUNCTION IF EXISTS appraisal_reviews_reviewer_matches_kind() CASCADE;
DROP FUNCTION IF EXISTS appraisal_reviews_freeze_submitted() CASCADE;
DROP FUNCTION IF EXISTS appraisal_amendments_block_mutation() CASCADE;
DROP TYPE IF EXISTS appraisal_rating, appraisal_review_kind,
                    appraisal_cycle_status, appraisal_subject_status CASCADE;

CREATE TABLE tenants (id uuid PRIMARY KEY);
CREATE TABLE users   (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TABLE employees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  employee_code varchar(40) NOT NULL,
  full_name     varchar(200) NOT NULL,
  joined_on     date NOT NULL,
  left_on       date
);

CREATE TYPE appraisal_rating AS ENUM
  ('unsatisfactory', 'needs_improvement', 'meets', 'exceeds', 'outstanding');
CREATE TYPE appraisal_review_kind AS ENUM ('self', 'manager', 'skip_level');
CREATE TYPE appraisal_cycle_status AS ENUM ('draft', 'open', 'closed', 'cancelled');
CREATE TYPE appraisal_subject_status AS ENUM
  ('pending', 'self_submitted', 'manager_submitted', 'signed_off', 'released');

CREATE TABLE reporting_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    manager_id      uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    effective_from  date NOT NULL,
    ended_on        date,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT reporting_lines_no_self CHECK (employee_id <> manager_id),
    CONSTRAINT reporting_lines_dates_ordered
      CHECK (ended_on IS NULL OR ended_on >= effective_from)
);
CREATE UNIQUE INDEX reporting_lines_current_key
    ON reporting_lines (tenant_id, employee_id) WHERE ended_on IS NULL;

CREATE OR REPLACE FUNCTION reporting_lines_no_cycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cursor_id uuid; hops int := 0;
BEGIN
  IF NEW.ended_on IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.employee_id = NEW.manager_id THEN
    RAISE EXCEPTION 'reporting line refused: % cannot report to themselves', NEW.employee_id
      USING ERRCODE = 'check_violation';
  END IF;
  cursor_id := NEW.manager_id;
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.employee_id THEN
      RAISE EXCEPTION
        'reporting line refused: this would make the hierarchy loop (% is already above %)',
        NEW.employee_id, NEW.manager_id
        USING ERRCODE = 'check_violation';
    END IF;
    hops := hops + 1;
    IF hops > 64 THEN
      RAISE EXCEPTION 'reporting line refused: chain deeper than 64 above %', NEW.manager_id
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r.manager_id INTO cursor_id
      FROM reporting_lines r
     WHERE r.tenant_id = NEW.tenant_id AND r.employee_id = cursor_id
       AND r.ended_on IS NULL
       AND (TG_OP <> 'UPDATE' OR r.id <> NEW.id)
     LIMIT 1;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER reporting_lines_no_cycle_check
  BEFORE INSERT OR UPDATE ON reporting_lines
  FOR EACH ROW EXECUTE FUNCTION reporting_lines_no_cycle();

CREATE TABLE appraisal_cycles (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                   varchar(120) NOT NULL,
    period_start           date NOT NULL,
    period_end             date NOT NULL,
    fy_label               varchar(7) NOT NULL,
    self_review_due_on     date,
    manager_review_due_on  date,
    status                 appraisal_cycle_status NOT NULL DEFAULT 'draft',
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT appraisal_cycles_dates_ordered CHECK (period_end > period_start),
    CONSTRAINT appraisal_cycles_period_sane
      CHECK (period_end - period_start BETWEEN 27 AND 400)
);

CREATE TABLE appraisal_subjects (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    cycle_id               uuid NOT NULL REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
    employee_id            uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    manager_employee_id    uuid REFERENCES employees(id) ON DELETE RESTRICT,
    skip_level_employee_id uuid REFERENCES employees(id) ON DELETE RESTRICT,
    status                 appraisal_subject_status NOT NULL DEFAULT 'pending',
    outcome_rating         appraisal_rating,
    outcome_summary        text,
    signed_off_at          timestamptz,
    signed_off_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    released_at            timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT appraisal_subjects_signed_has_outcome
      CHECK (signed_off_at IS NULL OR outcome_rating IS NOT NULL),
    CONSTRAINT appraisal_subjects_release_after_signoff
      CHECK (released_at IS NULL OR signed_off_at IS NOT NULL),
    CONSTRAINT appraisal_subjects_reviewer_not_self CHECK (
      (manager_employee_id IS NULL OR manager_employee_id <> employee_id)
      AND (skip_level_employee_id IS NULL OR skip_level_employee_id <> employee_id)
      AND (skip_level_employee_id IS NULL OR manager_employee_id IS NULL
           OR skip_level_employee_id <> manager_employee_id)
    )
);
CREATE UNIQUE INDEX appraisal_subjects_cycle_employee_key
    ON appraisal_subjects (tenant_id, cycle_id, employee_id);

CREATE OR REPLACE FUNCTION appraisal_subjects_freeze_signed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signed_off_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.outcome_rating IS DISTINCT FROM OLD.outcome_rating
     OR NEW.outcome_summary IS DISTINCT FROM OLD.outcome_summary
     OR NEW.signed_off_at   IS DISTINCT FROM OLD.signed_off_at
     OR NEW.signed_off_by   IS DISTINCT FROM OLD.signed_off_by
     OR NEW.employee_id     IS DISTINCT FROM OLD.employee_id
     OR NEW.cycle_id        IS DISTINCT FROM OLD.cycle_id
  THEN
    RAISE EXCEPTION 'a signed-off appraisal outcome cannot be edited (subject %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appraisal_subjects_frozen_after_signoff
  BEFORE UPDATE ON appraisal_subjects
  FOR EACH ROW EXECUTE FUNCTION appraisal_subjects_freeze_signed();

CREATE TABLE appraisal_reviews (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subject_id           uuid NOT NULL REFERENCES appraisal_subjects(id) ON DELETE CASCADE,
    kind                 appraisal_review_kind NOT NULL,
    reviewer_employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    rating               appraisal_rating,
    strengths            text,
    improvements         text,
    submitted_at         timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX appraisal_reviews_subject_kind_key
    ON appraisal_reviews (tenant_id, subject_id, kind);

CREATE OR REPLACE FUNCTION appraisal_reviews_reviewer_matches_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  SELECT employee_id, manager_employee_id, skip_level_employee_id INTO s
    FROM appraisal_subjects WHERE id = NEW.subject_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'appraisal review refused: subject % is not in this tenant', NEW.subject_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.kind = 'self' AND NEW.reviewer_employee_id IS DISTINCT FROM s.employee_id THEN
    RAISE EXCEPTION 'a self review must be written by the person being reviewed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'manager'
     AND (s.manager_employee_id IS NULL
          OR NEW.reviewer_employee_id IS DISTINCT FROM s.manager_employee_id) THEN
    RAISE EXCEPTION 'a manager review must be written by the reporting manager recorded on this appraisal'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'skip_level'
     AND (s.skip_level_employee_id IS NULL
          OR NEW.reviewer_employee_id IS DISTINCT FROM s.skip_level_employee_id) THEN
    RAISE EXCEPTION 'a skip-level review must be written by the skip-level manager recorded on this appraisal'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appraisal_reviews_reviewer_check
  BEFORE INSERT OR UPDATE ON appraisal_reviews
  FOR EACH ROW EXECUTE FUNCTION appraisal_reviews_reviewer_matches_kind();

CREATE OR REPLACE FUNCTION appraisal_reviews_freeze_submitted()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.submitted_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.rating IS DISTINCT FROM OLD.rating
     OR NEW.strengths IS DISTINCT FROM OLD.strengths
     OR NEW.improvements IS DISTINCT FROM OLD.improvements
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.reviewer_employee_id IS DISTINCT FROM OLD.reviewer_employee_id
  THEN
    RAISE EXCEPTION 'a submitted appraisal review cannot be edited (review %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appraisal_reviews_frozen_after_submit
  BEFORE UPDATE ON appraisal_reviews
  FOR EACH ROW EXECUTE FUNCTION appraisal_reviews_freeze_submitted();

CREATE TABLE appraisal_amendments (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subject_id             uuid NOT NULL REFERENCES appraisal_subjects(id) ON DELETE CASCADE,
    previous_rating        appraisal_rating NOT NULL,
    new_rating             appraisal_rating NOT NULL,
    previous_summary       text,
    new_summary            text,
    amended_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    amended_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
    reason                 text NOT NULL,
    amended_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT appraisal_amendments_reason_meant CHECK (length(btrim(reason)) >= 20),
    CONSTRAINT appraisal_amendments_changes_something
      CHECK (new_rating <> previous_rating
             OR new_summary IS DISTINCT FROM previous_summary)
);

CREATE OR REPLACE FUNCTION appraisal_amendments_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'appraisal_amendments is append-only'
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER appraisal_amendments_append_only
  BEFORE UPDATE OR DELETE ON appraisal_amendments
  FOR EACH ROW EXECUTE FUNCTION appraisal_amendments_block_mutation();

-- =====================================================================
--  STEP 2 — THE FIXTURE: FOUR PEOPLE, THREE LAYERS, ONE LEAVER
-- =====================================================================
--
--     Anil  (MD, no line)
--       └── Priya  (head of delivery)
--             └── Rahul  (engineer)
--       └── Sunita (left on 2025-08-31)
--             └── Vikram (still pointed at her — the stale-line case)

INSERT INTO tenants (id) VALUES ('11111111-1111-1111-1111-111111111111');

INSERT INTO employees (id, tenant_id, employee_code, full_name, joined_on, left_on) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','E001','Anil',   '2019-04-01', NULL),
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','E002','Priya',  '2020-06-15', NULL),
 ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','E003','Rahul',  '2022-01-10', NULL),
 ('aaaaaaaa-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','E004','Sunita', '2018-07-01', '2025-08-31'),
 ('aaaaaaaa-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','E005','Vikram', '2023-03-01', NULL);

INSERT INTO reporting_lines (tenant_id, employee_id, manager_id, effective_from) VALUES
 ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2020-06-15'),
 ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','2022-01-10'),
 ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','2018-07-01'),
 ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000004','2023-03-01');

\echo '=== POSITIVE 1: the hierarchy is four lines deep and walkable ==='
WITH RECURSIVE walk AS (
  SELECT employee_id, manager_id, 1 AS depth FROM reporting_lines WHERE ended_on IS NULL
  UNION ALL
  SELECT w.employee_id, r.manager_id, w.depth + 1
    FROM walk w JOIN reporting_lines r
      ON r.employee_id = w.manager_id AND r.ended_on IS NULL
   WHERE w.depth < 64
)
SELECT e.full_name, max(depth) AS levels_above
  FROM walk w JOIN employees e ON e.id = w.employee_id
 GROUP BY e.full_name ORDER BY 2 DESC, 1;
-- ⭐ EXPECT: Rahul 2, Vikram 2, Priya 1, Sunita 1. Anil is absent — no line.

\echo '=== POSITIVE 2: a stale line survives, and is FINDABLE ==='
SELECT e.full_name AS reports, m.full_name AS to_whom, m.left_on
  FROM reporting_lines r
  JOIN employees e ON e.id = r.employee_id
  JOIN employees m ON m.id = r.manager_id
 WHERE r.ended_on IS NULL AND m.left_on IS NOT NULL;
-- ⭐ EXPECT: Vikram → Sunita, left 2025-08-31.
-- 🔴 THE DECISION THIS DEMONSTRATES: Vikram was NOT silently moved to
--    Anil and his line was NOT blanked. Either would have changed who
--    signs off his appraisal without a human deciding. He stays, the
--    row is findable, and the org chart shows it as a warning band.

-- =====================================================================
--  NEGATIVE 1 — SELF-REPORTING, REFUSED BY A CHECK
-- =====================================================================
\echo '=== NEGATIVE 1: Anil reports to Anil (expect: refused) ==='
DO $$
BEGIN
  INSERT INTO reporting_lines (tenant_id, employee_id, manager_id, effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001', '2025-04-01');
  RAISE EXCEPTION '🔴 DRILL FAILED: self-reporting was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

-- =====================================================================
--  NEGATIVE 2 — TWO CURRENT LINES FOR ONE PERSON
-- =====================================================================
--  ⚠️ TWO OPEN LINES MEANS TWO MANAGERS, and every recursive walk visits
--  the person twice — producing a chart with duplicated subtrees that
--  looks exactly like a real chart.
\echo '=== NEGATIVE 2: a second current line for Rahul (expect: refused) ==='
DO $$
BEGIN
  INSERT INTO reporting_lines (tenant_id, employee_id, manager_id, effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-0000-0000-0000-000000000003',
          'aaaaaaaa-0000-0000-0000-000000000001', '2025-04-01');
  RAISE EXCEPTION '🔴 DRILL FAILED: a second open line was accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

-- =====================================================================
--  🔴🔴🔴 NEGATIVE 3 — THE TWO-HOP CYCLE. THE HEADLINE OF THIS DRILL.
-- =====================================================================
--
--  Priya reports to Anil. Now point Anil at Priya.
--
--  ⚠️ EVERY FOREIGN KEY IS SATISFIED. Both rows exist, both are in the
--  tenant, the CHECK on self-reporting passes because the two ids
--  differ. Before 0085 this INSERT SUCCEEDS, and the next `WITH
--  RECURSIVE` that walks the chart runs until the connection dies.
\echo '=== NEGATIVE 3: Anil reports to Priya, who reports to Anil (expect: refused) ==='
DO $$
BEGIN
  INSERT INTO reporting_lines (tenant_id, employee_id, manager_id, effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000002', '2025-04-01');
  RAISE EXCEPTION '🔴 DRILL FAILED: a two-hop cycle was accepted. Every recursive query that walks this chart now hangs.';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

-- =====================================================================
--  NEGATIVE 4 — THE THREE-HOP CYCLE, WHICH IS THE ONE PEOPLE ACTUALLY
--  CREATE
-- =====================================================================
--  Anil → Rahul → Priya → Anil. Nobody types this in one go; it is two
--  edits a month apart, each of which looked reasonable to whoever made
--  it. That is why it has to be refused by the database rather than by
--  the form somebody was looking at.
\echo '=== NEGATIVE 4: Anil reports to Rahul (three-hop loop) (expect: refused) ==='
DO $$
BEGIN
  INSERT INTO reporting_lines (tenant_id, employee_id, manager_id, effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000003', '2025-04-01');
  RAISE EXCEPTION '🔴 DRILL FAILED: a three-hop cycle was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

-- =====================================================================
--  NEGATIVE 5 — RE-OPENING AN ENDED LINE THAT WOULD CLOSE A LOOP
-- =====================================================================
--  ⚠️ THE UPDATE PATH IS THE ONE A TRIGGER GUARDING ONLY INSERT MISSES,
--  and "undo the reorganisation" is exactly how somebody reaches for it.
\echo '=== NEGATIVE 5: an ended loop-closing line is re-opened (expect: refused) ==='
DO $$
DECLARE loop_id uuid;
BEGIN
  INSERT INTO reporting_lines (tenant_id, employee_id, manager_id, effective_from, ended_on)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000002', '2024-04-01', '2024-09-30')
  RETURNING id INTO loop_id;
  -- ⭐ THAT INSERT MUST SUCCEED: an ENDED line is history, not part of
  --    the live graph, and refusing it would make it impossible to
  --    record a reorganisation that was later undone.
  RAISE NOTICE '✅ an ENDED loop-closing line is allowed as history';

  UPDATE reporting_lines SET ended_on = NULL WHERE id = loop_id;
  RAISE EXCEPTION '🔴 DRILL FAILED: re-opening a loop-closing line was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused on re-open: %', SQLERRM;
END $$;

-- =====================================================================
--  POSITIVE 3 — A LEGITIMATE REORGANISATION STILL WORKS
-- =====================================================================
--  ⚠️ THE DRILL THAT ONLY SHOWS BREAKS CANNOT TELL "the trigger works"
--  FROM "the table rejects everything".
\echo '=== POSITIVE 3: Vikram is moved from Sunita to Priya ==='
UPDATE reporting_lines SET ended_on = '2025-08-31'
 WHERE employee_id = 'aaaaaaaa-0000-0000-0000-000000000005' AND ended_on IS NULL;
INSERT INTO reporting_lines (tenant_id, employee_id, manager_id, effective_from, note)
VALUES ('11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000005',
        'aaaaaaaa-0000-0000-0000-000000000002', '2025-09-01',
        'Sunita left; moved by a human, not by a trigger');
SELECT e.full_name, m.full_name AS manager, r.effective_from, r.ended_on
  FROM reporting_lines r
  JOIN employees e ON e.id = r.employee_id
  JOIN employees m ON m.id = r.manager_id
 WHERE r.employee_id = 'aaaaaaaa-0000-0000-0000-000000000005'
 ORDER BY r.effective_from;
-- ⭐ EXPECT two rows: the old line ENDED, the new one open. 🔴 THE OLD
--    ROW IS STILL THERE — an appraisal covering April to August is
--    assigned from it, and overwriting manager_id in place would have
--    destroyed exactly that.

-- =====================================================================
--  STEP 3 — AN APPRAISAL, SIGNED OFF, AND THE FREEZE
-- =====================================================================

INSERT INTO appraisal_cycles (id, tenant_id, name, period_start, period_end, fy_label, status)
VALUES ('cccccccc-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'Annual review 2025-26', '2025-04-01', '2026-03-31', '2025-26', 'open');

INSERT INTO appraisal_subjects
  (id, tenant_id, cycle_id, employee_id, manager_employee_id, skip_level_employee_id)
VALUES ('dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'cccccccc-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000003',   -- Rahul
        'aaaaaaaa-0000-0000-0000-000000000002',   -- manager: Priya
        'aaaaaaaa-0000-0000-0000-000000000001');  -- skip-level: Anil

\echo '=== POSITIVE 4: three reviews of three kinds, by three people ==='
INSERT INTO appraisal_reviews (tenant_id, subject_id, kind, reviewer_employee_id, rating, submitted_at)
VALUES ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001',
        'self','aaaaaaaa-0000-0000-0000-000000000003','exceeds', now()),
       ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001',
        'manager','aaaaaaaa-0000-0000-0000-000000000002','meets', now()),
       ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001',
        'skip_level','aaaaaaaa-0000-0000-0000-000000000001','meets', now());
SELECT kind, rating FROM appraisal_reviews
 WHERE subject_id = 'dddddddd-0000-0000-0000-000000000001' ORDER BY kind;
-- ⭐ EXPECT three rows. Three ACTS, three rows — not one row with a
--    `comments` column, which is the build that publishes the skip-level
--    review to the manager it is about.

-- =====================================================================
--  NEGATIVE 6 — A MANAGER REVIEW WRITTEN BY THE WRONG PERSON
-- =====================================================================
--  🔴 THIS IS A FORGERY THAT LOOKS GENUINE FOREVER. The application
--  checks it too; this is the refusal that has no code path around it.
\echo '=== NEGATIVE 6: Rahul files a manager review of himself (expect: refused) ==='
DO $$
BEGIN
  UPDATE appraisal_reviews SET reviewer_employee_id = 'aaaaaaaa-0000-0000-0000-000000000003'
   WHERE subject_id = 'dddddddd-0000-0000-0000-000000000001' AND kind = 'manager';
  RAISE EXCEPTION '🔴 DRILL FAILED: a manager review by the subject was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

-- =====================================================================
--  NEGATIVE 7 — A SIGN-OFF WITH NO RATING
-- =====================================================================
--  ⚠️ A SIGNATURE ON A BLANK PAGE, and exactly what an over-eager
--  "mark all complete" button produces.
\echo '=== NEGATIVE 7: signed off with no outcome (expect: refused) ==='
DO $$
BEGIN
  UPDATE appraisal_subjects SET signed_off_at = now()
   WHERE id = 'dddddddd-0000-0000-0000-000000000001';
  RAISE EXCEPTION '🔴 DRILL FAILED: a sign-off with no rating was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

\echo '=== POSITIVE 5: a proper sign-off ==='
UPDATE appraisal_subjects
   SET outcome_rating = 'meets', outcome_summary = 'A solid year on delivery.',
       status = 'signed_off', signed_off_at = now()
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';
SELECT outcome_rating, signed_off_at IS NOT NULL AS signed, released_at
  FROM appraisal_subjects WHERE id = 'dddddddd-0000-0000-0000-000000000001';
-- ⭐ EXPECT: meets, signed = true, released_at NULL. Signed is not
--    released: the gap is the conversation.

-- =====================================================================
--  🔴🔴 NEGATIVE 8 — EDITING A SIGNED-OFF OUTCOME
-- =====================================================================
--  THE SECOND HEADLINE OF THIS DRILL. An appraisal outcome is evidence.
\echo '=== NEGATIVE 8: quietly upgrade a signed-off rating (expect: refused) ==='
DO $$
BEGIN
  UPDATE appraisal_subjects SET outcome_rating = 'outstanding'
   WHERE id = 'dddddddd-0000-0000-0000-000000000001';
  RAISE EXCEPTION '🔴 DRILL FAILED: a signed-off outcome was edited in place';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

\echo '=== POSITIVE 6: releasing is still allowed after sign-off ==='
UPDATE appraisal_subjects SET released_at = now(), status = 'released'
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';
SELECT released_at IS NOT NULL AS released FROM appraisal_subjects
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';
-- ⭐ EXPECT true. ⚠️ RELEASING IS NOT CHANGING THE EVIDENCE. Freezing it
--    along with the outcome would mean an appraisal could be signed off
--    and never shown to the person it is about.

-- =====================================================================
--  NEGATIVE 9 — AN AMENDMENT WITH A ONE-WORD REASON
-- =====================================================================
\echo '=== NEGATIVE 9: amendment reason "typo" (expect: refused) ==='
DO $$
BEGIN
  INSERT INTO appraisal_amendments
    (tenant_id, subject_id, previous_rating, new_rating, reason)
  VALUES ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001',
          'meets','exceeds','typo');
  RAISE EXCEPTION '🔴 DRILL FAILED: a one-word reason was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

\echo '=== POSITIVE 7: the correction, recorded properly ==='
INSERT INTO appraisal_amendments
  (tenant_id, subject_id, previous_rating, new_rating, previous_summary, new_summary, reason)
VALUES ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001',
        'meets','exceeds','A solid year on delivery.','A solid year on delivery.',
        'Moderation panel on 12 May reconsidered the Q3 delivery and agreed the original rating understated it.');
SELECT s.outcome_rating           AS original_still_says,
       a.new_rating               AS effective_now,
       a.reason IS NOT NULL       AS has_a_reason,
       a.amended_at IS NOT NULL   AS has_a_timestamp
  FROM appraisal_subjects s
  JOIN appraisal_amendments a ON a.subject_id = s.id
 WHERE s.id = 'dddddddd-0000-0000-0000-000000000001';
-- ⭐ EXPECT: original_still_says = meets, effective_now = exceeds.
-- 🔴 BOTH FACTS SURVIVE. The effective outcome is a FOLD over the
--    amendments, never a column that was overwritten — the same call
--    leave_ledger makes about balances, and for the same reason.

-- =====================================================================
--  NEGATIVE 10 — EDITING OR DELETING AN AMENDMENT
-- =====================================================================
--  ⚠️ AN AMENDMENT THAT CAN BE EDITED IS NOT AN AUDIT TRAIL, IT IS A
--  SECOND EDITABLE COPY OF THE THING IT WAS SUPPOSED TO PROTECT.
\echo '=== NEGATIVE 10: rewrite the amendment reason (expect: refused) ==='
DO $$
BEGIN
  UPDATE appraisal_amendments SET reason = 'a different story entirely, told later'
   WHERE subject_id = 'dddddddd-0000-0000-0000-000000000001';
  RAISE EXCEPTION '🔴 DRILL FAILED: an amendment was edited';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

\echo '=== NEGATIVE 10b: delete the amendment (expect: refused) ==='
DO $$
BEGIN
  DELETE FROM appraisal_amendments
   WHERE subject_id = 'dddddddd-0000-0000-0000-000000000001';
  RAISE EXCEPTION '🔴 DRILL FAILED: an amendment was deleted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

-- =====================================================================
--  NEGATIVE 11 — THE SKIP-LEVEL WHO IS ALSO THE MANAGER
-- =====================================================================
--  ⚠️ A SECOND MANAGER REVIEW WEARING A DIFFERENT LABEL. It defeats the
--  visibility rule the whole design turns on: the skip-level review is
--  hidden from the manager precisely because it is about them.
\echo '=== NEGATIVE 11: skip-level = manager (expect: refused) ==='
DO $$
BEGIN
  INSERT INTO appraisal_subjects
    (tenant_id, cycle_id, employee_id, manager_employee_id, skip_level_employee_id)
  VALUES ('11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000005',
          'aaaaaaaa-0000-0000-0000-000000000002',
          'aaaaaaaa-0000-0000-0000-000000000002');
  RAISE EXCEPTION '🔴 DRILL FAILED: skip-level equal to manager was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

-- =====================================================================
--  NEGATIVE 12 — A REVIEW PERIOD OF FOUR YEARS
-- =====================================================================
\echo '=== NEGATIVE 12: a four-year "review period" (expect: refused) ==='
DO $$
BEGIN
  INSERT INTO appraisal_cycles (tenant_id, name, period_start, period_end, fy_label)
  VALUES ('11111111-1111-1111-1111-111111111111','Mistyped year',
          '2022-04-01','2026-03-31','2025-26');
  RAISE EXCEPTION '🔴 DRILL FAILED: a four-year review period was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ refused: %', SQLERRM;
END $$;

-- =====================================================================
--  WHAT THIS DRILL DOES NOT PROVE
-- =====================================================================
\echo ''
\echo '🔴 WHAT THIS DRILL CANNOT SHOW YOU:'
\echo '   · That a manager cannot READ outside their own line. Every'
\echo '     colleague''s row is in the same tenant, so RLS is satisfied by'
\echo '     the leaking query exactly as by the correct one. The narrowing'
\echo '     lives in server/actions/appraisals.ts and is asserted by'
\echo '     tests/ui/appraisals-and-org-chart.test.ts against the source.'
\echo '   · That a skip-level review was never RENDERED to the manager.'
\echo '     The database stores the row; lib/hr/visibility.ts decides who'
\echo '     is shown it.'
\echo '   · Anything at all about pay. There is no money column in 0085.'
\echo '     An appraisal rating changes nobody''s salary in this product.'
