-- =====================================================================
--  ORDENCE — 0085 · THE REPORTING HIERARCHY AND THE APPRAISAL CYCLE
--  Version: v1.47.0-alpha · Batch 109
--
--  ⚠️ RUN AFTER 0082. Five new tables, four new enums, four triggers.
--  It reads `employees` from 0075 and TOUCHES NOTHING THAT EXISTS —
--  no column is added to `employees`, no constraint on it is changed,
--  nothing in payroll or leave is altered.
--
--  ⚠️ 0083 AND 0084 ARE OTHER BATCHES' FILES. This one neither depends
--  on them nor conflicts with them; it may run before or after either.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded: tables are CREATE ...
--     IF NOT EXISTS, enums are created inside an exception handler,
--     constraints are DROP ... IF EXISTS then ADD, indexes are CREATE
--     ... IF NOT EXISTS, functions are CREATE OR REPLACE, triggers are
--     DROP ... IF EXISTS then CREATE, all inside one transaction.
--
--  ⭐ RUN THIS BEFORE PUSHING THE CODE. It is purely additive — nothing
--     that exists today reads or writes any of it — so on the current
--     build the file is inert. The new code, however, SELECTs from
--     `reporting_lines` and `appraisal_subjects` on the first render of
--     /hr, and against a database without them every HR screen raises
--     42P01.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 WHAT THIS UNBLOCKS, IN ONE PARAGRAPH
--  ══════════════════════════════════════════════════════════════════
--  There was no reporting hierarchy in Ordence at all. `employees`
--  (0075) has no `manager_id`, no `reports_to` and no table hanging off
--  it that records one, so the product could not answer "who does this
--  person report to" — which means it could not answer "who reviews
--  them", "who approves this on their behalf" or "who is affected if
--  they leave". There was no appraisal table either. This is not the
--  usual Ordence pattern of an engine nothing reaches; there was no
--  engine.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴🔴 THE DECISION THIS FILE IS MOSTLY MADE OF: A CYCLE IN THE
--         HIERARCHY HANGS EVERY RECURSIVE QUERY THAT WALKS IT
--  ══════════════════════════════════════════════════════════════════
--  A reports to B, B reports to A. `WITH RECURSIVE` has no idea it is
--  going round; it produces rows until the connection dies or the plan
--  spills to disk. It is TWO ORDINARY EDITS, made a month apart by two
--  people who were each individually right, and NO FOREIGN KEY HAS AN
--  OPINION ABOUT REACHABILITY — the database will accept both writes
--  and then hang the first time anything asks for the chart.
--
--  ⭐ SO IT IS REFUSED HERE, IN THE DATABASE, IN THREE PLACES:
--
--    ① `reporting_lines_no_self` — a CHECK. The one-hop cycle is
--       refused by the planner on every row, and it is the cheapest and
--       least skippable of the three.
--
--    ② `reporting_lines_no_cycle()` — a BEFORE INSERT OR UPDATE
--       TRIGGER. It walks up from the proposed manager through the
--       CURRENT lines (`ended_on IS NULL`) and raises if it meets the
--       employee, and raises again past a depth of 64. 🔴 THIS IS THE
--       ONE THAT MATTERS, because it is the only refusal that a CSV
--       import, a psql session, a restore script or a server action
--       written next year cannot go round. The application also checks
--       — `lib/hr/hierarchy.ts#wouldCreateCycle` — but only so the
--       person gets a sentence naming the two people instead of P0001.
--
--    ③ The WALK ITSELF IS BOUNDED. Even the trigger's own loop counts
--       its hops, because a cycle-detector that loops forever while
--       detecting a loop is not a joke, it is what happens if the walk
--       trusts the data it is validating.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴 WHAT HAPPENS TO THE REPORTS OF SOMEBODY WHO HAS LEFT — DECIDED,
--     AND THE DECISION IS "NOTHING AUTOMATIC"
--  ══════════════════════════════════════════════════════════════════
--  The leaver keeps their node. Their reports are NOT moved and their
--  lines are NOT ended. Both automatic alternatives are worse:
--
--    • Nulling the reports' manager on exit ORPHANS them SILENTLY. They
--      vanish from under their branch, reappear at the root next to the
--      managing director, and nobody is told. Mid-cycle it makes four
--      manager reviews nobody's job and the cycle closes without them.
--
--    • Re-pointing them at the leaver's own manager looks correct,
--      which is what makes it dangerous. It changes who signs off an
--      appraisal for a period that person did not supervise, silently,
--      for everybody at once.
--
--  ⭐ INSTEAD THE RISK IS MADE LOUD: `lib/hr/hierarchy.ts` reports every
--  line whose manager has left as a `staleLines` list, the org chart
--  renders it as a warning band, and a human moves them. And a live
--  appraisal is unaffected either way, because the reviewer is
--  SNAPSHOTTED onto `appraisal_subjects` at enrolment — see ③ below.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 A SIGNED-OFF OUTCOME IS EVIDENCE. IT IS NOT EDITABLE.
--  ══════════════════════════════════════════════════════════════════
--  `appraisal_subjects_frozen_after_signoff` refuses any UPDATE to
--  `outcome_rating`, `outcome_summary`, `signed_off_at` or
--  `signed_off_by` once `signed_off_at` is set. Not by convention, by
--  trigger — so no future action, import or support session can quietly
--  rewrite what somebody's performance was recorded as.
--
--  ⭐ A CORRECTION IS AN `appraisal_amendments` ROW, append-only by
--  trigger, carrying the previous rating, the new rating, WHO, WHEN and
--  a reason the database insists is at least twenty characters. The
--  EFFECTIVE outcome is the latest amendment or the original — a fold,
--  never a column, which is the same call `leave_ledger` makes about
--  balances and for the same reason: a stored figure somebody has
--  quietly overwritten cannot be argued with, and an appraisal is
--  argued with by definition.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴🔴 THIS IS NOT WIRED TO PAY. SAID PLAINLY.
--  ══════════════════════════════════════════════════════════════════
--  THERE IS NO MONEY COLUMN IN THIS FILE. No increment, no bonus, no
--  revised CTC, no percentage, no paise. Nothing in payroll reads any
--  of these tables and nothing here writes a pay component, a salary
--  structure or a payslip line. A rating of 'outstanding' changes
--  NOBODY'S SALARY — somebody opens payroll and types the new figure.
--
--  ══════════════════════════════════════════════════════════════════
--  ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT STORE
--  ══════════════════════════════════════════════════════════════════
--  NO PERFORMANCE IMPROVEMENT PLAN CONTENT. NO DISCIPLINARY RECORD. NO
--  MEDICAL OR PERSONAL CIRCUMSTANCE. NO NUMERIC SCORE THAT LOOKS LIKE A
--  RANKING OF ONE PERSON AGAINST ANOTHER.
--
--  🔴 A FORCED-DISTRIBUTION OR STACK-RANK COLUMN IS THE OBVIOUS NEXT
--  FEATURE AND IT IS ABSENT ON PURPOSE. A stored rank is a number that
--  outlives its context, is read years later as a fact about a person,
--  and in India is quoted in exactly one place: a wrongful-termination
--  hearing. The rating enum is worded, per-person, and carries no
--  implied position in a cohort.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ENUMS
-- =====================================================================

--  ⭐ A WORDED SCALE, NOT A NUMBER OUT OF FIVE. "3" is half a rating:
--  out of what, and is five good? Two products in this market use 1 as
--  best. A stored integer leaves the meaning in whichever screen last
--  rendered it, and words survive the export to a spreadsheet that all
--  appraisal data eventually becomes.
DO $$ BEGIN
  CREATE TYPE appraisal_rating AS ENUM
    ('unsatisfactory', 'needs_improvement', 'meets', 'exceeds', 'outstanding');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--  🔴 THREE ACTS, THREE VALUES, NOT INTERCHANGEABLE. One `review` row
--  with a `comments` column would have been the obvious build and it
--  publishes the skip-level review to the manager it is about — which
--  is the single thing a skip-level review must never do, because the
--  whole point of it is that it is a check ON the manager.
DO $$ BEGIN
  CREATE TYPE appraisal_review_kind AS ENUM ('self', 'manager', 'skip_level');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--  ⚠️ `closed` IS NOT `cancelled`. A closed cycle happened and its
--  outcomes stand. A cancelled one was abandoned and must not be quoted
--  — and its rows still stay, because deleting appraisals that became
--  inconvenient is the worst-looking thing in an employment file.
DO $$ BEGIN
  CREATE TYPE appraisal_cycle_status AS ENUM ('draft', 'open', 'closed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--  ⭐ `released` IS SEPARATE FROM `signed_off`. Signing off fixes the
--  evidence; releasing is when the subject may read the manager review.
--  In practice they are days apart and the gap is the conversation.
DO $$ BEGIN
  CREATE TYPE appraisal_subject_status AS ENUM
    ('pending', 'self_submitted', 'manager_submitted', 'signed_off', 'released');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
--  ① THE REPORTING LINE
-- =====================================================================
--
--  ⭐ ITS OWN TABLE, NOT `employees.manager_id`, AND THE REASON IS THE
--  APPRAISAL. A single self-referencing column answers "who is your
--  manager" and cannot answer "who was your manager in October". A cycle
--  covering April to September, signed off in November by whoever holds
--  the column today, is signed by somebody who may never have managed
--  the person — and that signature looks exactly like a valid one.
--
--  A row with `ended_on IS NULL` is the line in force. A change ENDS the
--  old row and INSERTS a new one; updating `manager_id` in place would
--  erase the fact that anybody else ever held the line, which is the
--  fact the appraisal is assigned from.
CREATE TABLE IF NOT EXISTS reporting_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    --  ⚠️ RESTRICT, NOT CASCADE AND NOT SET NULL. Deleting a manager row
    --  must not silently delete or blank the lines of everybody under
    --  them. `employees` is not deleted in normal operation — `left_on`
    --  is set — so this makes the abnormal case refuse.
    manager_id      uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,

    effective_from  date NOT NULL,
    ended_on        date,                    -- NULL while in force

    note            text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    --  🔴 THE ONE-HOP CYCLE, REFUSED BY THE TABLE ITSELF.
    CONSTRAINT reporting_lines_no_self CHECK (employee_id <> manager_id),
    CONSTRAINT reporting_lines_dates_ordered
      CHECK (ended_on IS NULL OR ended_on >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS reporting_lines_id_tenant_key
    ON reporting_lines (id, tenant_id);

--  🔴 THE PARTIAL UNIQUE INDEX IS WHAT MAKES "CURRENT" MEAN ANYTHING.
--  Two open lines for one employee means two managers, and every
--  recursive walk visits the person twice — producing a chart with
--  duplicated subtrees that looks like a real chart.
CREATE UNIQUE INDEX IF NOT EXISTS reporting_lines_current_key
    ON reporting_lines (tenant_id, employee_id) WHERE ended_on IS NULL;

CREATE INDEX IF NOT EXISTS reporting_lines_manager_idx
    ON reporting_lines (tenant_id, manager_id, ended_on);
CREATE INDEX IF NOT EXISTS reporting_lines_employee_idx
    ON reporting_lines (tenant_id, employee_id, effective_from);

-- ---------------------------------------------------------------------
--  🔴🔴🔴 THE CYCLE REFUSAL. THE MOST IMPORTANT OBJECT IN THIS FILE.
-- ---------------------------------------------------------------------
--
--  Walks UP from the proposed manager through the current lines. If it
--  meets the employee, the write would close a loop and is refused.
--
--  ⚠️ IT WALKS UP RATHER THAN DOWN ON PURPOSE. Down needs the whole
--  subtree; up needs one pointer per hop and terminates at a root.
--
--  ⚠️ THE HOP COUNTER IS NOT DEFENSIVE PROGRAMMING, IT IS THE POINT. If
--  a cycle is ALREADY in the table — a restore, a row that predates this
--  trigger, a direct INSERT while the trigger was disabled — then this
--  walk would itself loop forever while checking for loops. Sixty-four
--  is far past any real reporting chain, and hitting it refuses.
--
--  ⭐ ALSO FIRES ON UPDATE, because re-opening an ended line (setting
--  `ended_on` back to NULL) creates a current edge exactly as an INSERT
--  does, and a trigger that only guarded INSERT would be bypassed by an
--  UPDATE that reads like an undo.
CREATE OR REPLACE FUNCTION reporting_lines_no_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_id uuid;
  hops      int := 0;
BEGIN
  -- Only a CURRENT line can be part of the live graph.
  IF NEW.ended_on IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.employee_id = NEW.manager_id THEN
    RAISE EXCEPTION
      'reporting line refused: % cannot report to themselves', NEW.employee_id
      USING ERRCODE = 'check_violation';
  END IF;

  cursor_id := NEW.manager_id;

  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.employee_id THEN
      RAISE EXCEPTION
        'reporting line refused: this would make the hierarchy loop (% is already above %)',
        NEW.employee_id, NEW.manager_id
        USING ERRCODE = 'check_violation',
              HINT = 'A loop hangs every recursive query that walks the chart. '
                     'Move the manager out from under the employee first.';
    END IF;

    hops := hops + 1;
    IF hops > 64 THEN
      RAISE EXCEPTION
        'reporting line refused: chain deeper than 64 above %. '
        'That is a loop already in the data, or a chain nobody meant to type.',
        NEW.manager_id
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT r.manager_id INTO cursor_id
      FROM reporting_lines r
     WHERE r.tenant_id   = NEW.tenant_id
       AND r.employee_id = cursor_id
       AND r.ended_on IS NULL
       --  ⚠️ THE ROW BEING REPLACED IS EXCLUDED FROM THE WALK. On an
       --  UPDATE the old version is still visible to this snapshot, and
       --  counting it would refuse a perfectly legal correction that
       --  merely re-points an existing line.
       AND (TG_OP <> 'UPDATE' OR r.id <> NEW.id)
     LIMIT 1;
  END LOOP;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS reporting_lines_no_cycle_check ON reporting_lines;
CREATE TRIGGER reporting_lines_no_cycle_check
  BEFORE INSERT OR UPDATE ON reporting_lines
  FOR EACH ROW EXECUTE FUNCTION reporting_lines_no_cycle();

-- =====================================================================
--  ② THE CYCLE — WHO IS REVIEWED, OVER WHAT PERIOD
-- =====================================================================
--
--  ⭐ THE PERIOD IS TYPED AND THE FINANCIAL YEAR IS DERIVED FROM IT.
--  Indian employers appraise on the financial year more often than not —
--  1 April to 31 March — and `fy_label` records which one so the
--  register can be read by year. Hardcoding April would fit only the
--  workspaces that guessed as we did: half-yearly and calendar-year
--  cycles are common enough to matter.
CREATE TABLE IF NOT EXISTS appraisal_cycles (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    name                   varchar(120) NOT NULL,

    period_start           date NOT NULL,
    period_end             date NOT NULL,     -- inclusive
    fy_label               varchar(7) NOT NULL,  -- '2025-26'

    self_review_due_on     date,
    manager_review_due_on  date,

    status                 appraisal_cycle_status NOT NULL DEFAULT 'draft',

    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    created_by             uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT appraisal_cycles_dates_ordered CHECK (period_end > period_start),
    --  ⚠️ A "REVIEW PERIOD" OF FOUR YEARS IS A MISTYPED YEAR, and it
    --  silently makes every enrolment pick the wrong historical line.
    CONSTRAINT appraisal_cycles_period_sane
      CHECK (period_end - period_start BETWEEN 27 AND 400)
);

CREATE UNIQUE INDEX IF NOT EXISTS appraisal_cycles_id_tenant_key
    ON appraisal_cycles (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS appraisal_cycles_name_key
    ON appraisal_cycles (tenant_id, name);
CREATE INDEX IF NOT EXISTS appraisal_cycles_fy_idx
    ON appraisal_cycles (tenant_id, fy_label, period_start);

-- =====================================================================
--  ③ THE SUBJECT — ONE PERSON'S APPRAISAL IN ONE CYCLE
-- =====================================================================
--
--  🔴🔴 THE REVIEWERS ARE SNAPSHOTTED AT ENROLMENT, NOT JOINED AT READ
--  TIME. `manager_employee_id` and `skip_level_employee_id` are COPIES
--  of the reporting line as it stood over the review period.
--
--  ⚠️ THE JOIN-AT-READ-TIME VERSION IS SHORTER AND IT IS THE BUG. A
--  reorganisation in week three would move a live appraisal to a manager
--  who has never met the person, delete the half-written review of the
--  one who has, and do it to forty people at once with nobody informed.
--  `payslips` makes the same call about `employees` for the same reason.
--
--  ⭐ SKIP-LEVEL IS NULLABLE AND OFTEN NULL. It is the manager's own
--  manager, and near the top of a small company there is not one. NULL
--  means "no skip-level review expected", which the screen states rather
--  than rendering a box that never fills.
CREATE TABLE IF NOT EXISTS appraisal_subjects (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    cycle_id               uuid NOT NULL REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
    employee_id            uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,

    manager_employee_id    uuid REFERENCES employees(id) ON DELETE RESTRICT,
    skip_level_employee_id uuid REFERENCES employees(id) ON DELETE RESTRICT,

    status                 appraisal_subject_status NOT NULL DEFAULT 'pending',

    --  🔴 FROZEN BY TRIGGER ONCE signed_off_at IS SET.
    outcome_rating         appraisal_rating,
    outcome_summary        text,

    signed_off_at          timestamptz,
    signed_off_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    --  ⭐ WHEN THE SUBJECT BECAME ALLOWED TO READ THE MANAGER REVIEW.
    released_at            timestamptz,

    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    created_by             uuid REFERENCES users(id) ON DELETE SET NULL,

    --  ⚠️ A SIGN-OFF WITHOUT A RATING IS A SIGNATURE ON A BLANK PAGE,
    --  and it is exactly what an over-eager "mark all complete" produces.
    CONSTRAINT appraisal_subjects_signed_has_outcome
      CHECK (signed_off_at IS NULL OR outcome_rating IS NOT NULL),
    --  ⚠️ NOTHING IS RELEASED TO THE SUBJECT BEFORE IT IS SIGNED OFF.
    CONSTRAINT appraisal_subjects_release_after_signoff
      CHECK (released_at IS NULL OR signed_off_at IS NOT NULL),
    --  🔴 NOBODY REVIEWS THEMSELVES AT EITHER LEVEL, AND THE SKIP-LEVEL
    --  IS NOT THE MANAGER. A skip-level equal to the manager is a
    --  second manager review wearing a different label, and it defeats
    --  the visibility rule the whole design turns on.
    CONSTRAINT appraisal_subjects_reviewer_not_self CHECK (
      (manager_employee_id IS NULL OR manager_employee_id <> employee_id)
      AND (skip_level_employee_id IS NULL OR skip_level_employee_id <> employee_id)
      AND (skip_level_employee_id IS NULL OR manager_employee_id IS NULL
           OR skip_level_employee_id <> manager_employee_id)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS appraisal_subjects_id_tenant_key
    ON appraisal_subjects (id, tenant_id);
--  ⚠️ ONE APPRAISAL PER PERSON PER CYCLE. Two is a duplicate enrolment,
--  and two ratings for one period is the argument nobody can settle.
CREATE UNIQUE INDEX IF NOT EXISTS appraisal_subjects_cycle_employee_key
    ON appraisal_subjects (tenant_id, cycle_id, employee_id);
--  🔴 THE INDEX THE LINE-SCOPED READ DEPENDS ON. A manager's queue is
--  "the subjects whose manager is me", and it must not be a full scan of
--  the register — a slow narrow query is what somebody later "optimises"
--  into a fast wide one.
CREATE INDEX IF NOT EXISTS appraisal_subjects_manager_idx
    ON appraisal_subjects (tenant_id, manager_employee_id, cycle_id);
CREATE INDEX IF NOT EXISTS appraisal_subjects_skip_idx
    ON appraisal_subjects (tenant_id, skip_level_employee_id, cycle_id);
CREATE INDEX IF NOT EXISTS appraisal_subjects_employee_idx
    ON appraisal_subjects (tenant_id, employee_id);

-- ---------------------------------------------------------------------
--  🔴🔴 THE FREEZE. AN OUTCOME THAT HAS BEEN SIGNED OFF IS EVIDENCE.
-- ---------------------------------------------------------------------
--
--  ⚠️ `released_at`, `status` AND `updated_at` MAY STILL MOVE, and that
--  is not a hole. Releasing is not changing the evidence — it is
--  recording that the conversation has happened and the subject may now
--  read it. Freezing release along with the outcome would mean an
--  appraisal could be signed off and never shown to the person it is
--  about, which is the opposite of what the freeze is for.
CREATE OR REPLACE FUNCTION appraisal_subjects_freeze_signed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.signed_off_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.outcome_rating  IS DISTINCT FROM OLD.outcome_rating
     OR NEW.outcome_summary IS DISTINCT FROM OLD.outcome_summary
     OR NEW.signed_off_at   IS DISTINCT FROM OLD.signed_off_at
     OR NEW.signed_off_by   IS DISTINCT FROM OLD.signed_off_by
     OR NEW.employee_id     IS DISTINCT FROM OLD.employee_id
     OR NEW.cycle_id        IS DISTINCT FROM OLD.cycle_id
  THEN
    RAISE EXCEPTION
      'a signed-off appraisal outcome cannot be edited (subject %)', OLD.id
      USING ERRCODE = 'check_violation',
            HINT = 'Record an appraisal_amendments row instead: it keeps the '
                   'original, and carries who changed it, when, and why.';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS appraisal_subjects_frozen_after_signoff ON appraisal_subjects;
CREATE TRIGGER appraisal_subjects_frozen_after_signoff
  BEFORE UPDATE ON appraisal_subjects
  FOR EACH ROW EXECUTE FUNCTION appraisal_subjects_freeze_signed();

-- =====================================================================
--  ④ THE REVIEWS — THREE DIFFERENT ACTS
-- =====================================================================
--
--  ⭐ ONE ROW PER (SUBJECT, KIND). The self review, the manager review
--  and the skip-level review are three rows, not three columns on one,
--  because they have three authors and three readerships:
--
--    self       written by the subject; readable by them, their manager
--               and their skip-level.
--    manager    written by the reporting manager; the subject reads it
--               only after the outcome is RELEASED. ⚠️ Not because it is
--               secret: a manager who knows the text is being watched
--               live writes a blander, useless one, and an employee
--               reading "needs improvement" at 11pm before anybody has
--               spoken to them is the harm the release step prevents.
--    skip_level written by the manager's manager. 🔴 NEVER READABLE BY
--               THE SUBJECT OR BY THE MANAGER. Showing it to the manager
--               makes it a second manager review and nobody writes an
--               honest one again.
--
--  ⚠️ `submitted_at IS NULL` MEANS DRAFT, AND A DRAFT IS PRIVATE. Once
--  set, the row is frozen: a review somebody has acted on is evidence in
--  the same way the outcome is, and "let me soften that line" after the
--  conversation must leave a trace rather than simply happen.
CREATE TABLE IF NOT EXISTS appraisal_reviews (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    subject_id           uuid NOT NULL REFERENCES appraisal_subjects(id) ON DELETE CASCADE,
    kind                 appraisal_review_kind NOT NULL,

    reviewer_employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,

    --  ⚠️ NULLABLE ON PURPOSE. A self review that had to carry a rating
    --  forces people to grade themselves before saying anything, and the
    --  number typed under that pressure is noise.
    rating               appraisal_rating,
    strengths            text,
    improvements         text,

    submitted_at         timestamptz,

    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS appraisal_reviews_id_tenant_key
    ON appraisal_reviews (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS appraisal_reviews_subject_kind_key
    ON appraisal_reviews (tenant_id, subject_id, kind);
CREATE INDEX IF NOT EXISTS appraisal_reviews_reviewer_idx
    ON appraisal_reviews (tenant_id, reviewer_employee_id);

-- ---------------------------------------------------------------------
--  🔴 THE REVIEWER MUST MATCH THE KIND, AND THE DATABASE SAYS SO
-- ---------------------------------------------------------------------
--
--  A `manager` row whose reviewer is not the snapshotted manager is
--  refused. So is a `self` row written by anybody but the subject, and a
--  `skip_level` row by anybody but the snapshotted skip-level.
--
--  ⚠️ THE APPLICATION CHECKS THIS TOO (`lib/hr/visibility.ts#canWriteReview`)
--  and that check is not enough on its own: a second action, an import
--  or a script would file one person's opinion under another's name and
--  it would read as genuine forever. This is the refusal that has no
--  code path around it.
CREATE OR REPLACE FUNCTION appraisal_reviews_reviewer_matches_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  s RECORD;
BEGIN
  SELECT employee_id, manager_employee_id, skip_level_employee_id
    INTO s
    FROM appraisal_subjects
   WHERE id = NEW.subject_id
     AND tenant_id = NEW.tenant_id;

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
END
$$;

DROP TRIGGER IF EXISTS appraisal_reviews_reviewer_check ON appraisal_reviews;
CREATE TRIGGER appraisal_reviews_reviewer_check
  BEFORE INSERT OR UPDATE ON appraisal_reviews
  FOR EACH ROW EXECUTE FUNCTION appraisal_reviews_reviewer_matches_kind();

-- ---------------------------------------------------------------------
--  ⚠️ A SUBMITTED REVIEW IS FROZEN.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION appraisal_reviews_freeze_submitted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.submitted_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.rating       IS DISTINCT FROM OLD.rating
     OR NEW.strengths    IS DISTINCT FROM OLD.strengths
     OR NEW.improvements IS DISTINCT FROM OLD.improvements
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.kind         IS DISTINCT FROM OLD.kind
     OR NEW.reviewer_employee_id IS DISTINCT FROM OLD.reviewer_employee_id
  THEN
    RAISE EXCEPTION 'a submitted appraisal review cannot be edited (review %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS appraisal_reviews_frozen_after_submit ON appraisal_reviews;
CREATE TRIGGER appraisal_reviews_frozen_after_submit
  BEFORE UPDATE ON appraisal_reviews
  FOR EACH ROW EXECUTE FUNCTION appraisal_reviews_freeze_submitted();

-- =====================================================================
--  ⑤ THE AMENDMENTS — APPEND-ONLY, AND THE ONLY WAY AN OUTCOME CHANGES
-- =====================================================================
--
--  🔴 THE EFFECTIVE OUTCOME IS `latest amendment ?? subject.outcome_rating`
--  AND IT IS NEVER WRITTEN BACK. Two places holding the same fact
--  disagree the first time one write of a pair is missed, and both look
--  like ratings, so nothing on any screen would show which is stale.
--
--  ⚠️ `reason` IS NOT NULL WITH A LENGTH FLOOR THE DATABASE ENFORCES.
--  "typo" is not a reason to change what somebody's performance was
--  recorded as, and an optional reason field is an empty reason field.
CREATE TABLE IF NOT EXISTS appraisal_amendments (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    subject_id             uuid NOT NULL REFERENCES appraisal_subjects(id) ON DELETE CASCADE,

    previous_rating        appraisal_rating NOT NULL,
    new_rating             appraisal_rating NOT NULL,
    previous_summary       text,
    new_summary            text,

    --  🔴 THE ACTOR. Not "the system", not the last person to sign in.
    amended_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    amended_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
    reason                 text NOT NULL,

    amended_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT appraisal_amendments_reason_meant
      CHECK (length(btrim(reason)) >= 20),
    --  ⚠️ AN AMENDMENT THAT CHANGES NOTHING MUDDIES THE TRAIL.
    CONSTRAINT appraisal_amendments_changes_something
      CHECK (new_rating <> previous_rating
             OR new_summary IS DISTINCT FROM previous_summary)
);

CREATE UNIQUE INDEX IF NOT EXISTS appraisal_amendments_id_tenant_key
    ON appraisal_amendments (id, tenant_id);
CREATE INDEX IF NOT EXISTS appraisal_amendments_subject_idx
    ON appraisal_amendments (tenant_id, subject_id, amended_at);

-- ---------------------------------------------------------------------
--  🔴 APPEND-ONLY BY TRIGGER, NOT BY CONVENTION.
--
--  ⚠️ AN AMENDMENT THAT CAN BE EDITED IS NOT AN AUDIT TRAIL, IT IS A
--  SECOND EDITABLE COPY OF THE THING IT WAS SUPPOSED TO PROTECT. The
--  same rule `leave_ledger` applies to itself.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION appraisal_amendments_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'appraisal_amendments is append-only: an amendment records that an outcome changed, so changing it defeats the record'
    USING ERRCODE = 'check_violation';
END
$$;

DROP TRIGGER IF EXISTS appraisal_amendments_append_only ON appraisal_amendments;
CREATE TRIGGER appraisal_amendments_append_only
  BEFORE UPDATE OR DELETE ON appraisal_amendments
  FOR EACH ROW EXECUTE FUNCTION appraisal_amendments_block_mutation();

-- =====================================================================
--  ⑥ updated_at
-- =====================================================================
--  ⭐ `set_updated_at()` is from 0001. Without these, `updated_at` is the
--     creation time forever and "when did this change" has no answer.

DROP TRIGGER IF EXISTS appraisal_cycles_set_updated_at ON appraisal_cycles;
CREATE TRIGGER appraisal_cycles_set_updated_at
  BEFORE UPDATE ON appraisal_cycles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS appraisal_subjects_set_updated_at ON appraisal_subjects;
CREATE TRIGGER appraisal_subjects_set_updated_at
  BEFORE UPDATE ON appraisal_subjects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS appraisal_reviews_set_updated_at ON appraisal_reviews;
CREATE TRIGGER appraisal_reviews_set_updated_at
  BEFORE UPDATE ON appraisal_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
--  ⑦ ROW LEVEL SECURITY
-- =====================================================================
--
--  🔴 AN APPRAISAL REGISTER IS AS SENSITIVE AS A SALARY AND SLIGHTLY
--  WORSE IN ONE WAY: a salary is a number the employer set, and a rating
--  is an opinion recorded about a person that follows them. One tenant
--  reading another's is that, for every employee at once.
--
--  ⚠️ AND RLS IS NOT THE CONTROL INSIDE A TENANT. Every colleague's
--  appraisal is in the same tenant, so the policy is satisfied by a
--  query that returns the whole company exactly as it is by one that
--  returns a manager's own line. The narrowing that matters lives in the
--  WHERE clause of `server/actions/appraisals.ts` — `myAppraisals()`
--  asks which rows POINT AT the caller — and nothing in this section can
--  substitute for it. That is the `myPayslips()` lesson, restated for a
--  module where the dangerous reader is a manager rather than a stranger.
--
--  ⭐ `app_platform_scope()` GOES IN `USING` AND NEVER IN `WITH CHECK`,
--  the house rule the whole schema follows: platform staff may READ
--  across tenants to answer a support question, and may never WRITE a
--  row into a workspace that is not the session's.
--
--  ⚠️ FORCE, NOT JUST ENABLE. This application connects as the table
--  owner, and an owner without FORCE bypasses every policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'reporting_lines', 'appraisal_cycles', 'appraisal_subjects',
    'appraisal_reviews', 'appraisal_amendments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING (tenant_id = app_current_tenant_id() OR app_platform_scope()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_isolation', t
    );
  END LOOP;
END
$$;

-- =====================================================================
--  ⑧ THE TABLE COMMENTS, FOR WHOEVER OPENS THIS IN A CLIENT
-- =====================================================================

COMMENT ON TABLE reporting_lines IS
  'Who reports to whom, DATED. One current row per employee (partial '
  'unique index on ended_on IS NULL) plus the history. 🔴 A CYCLE HANGS '
  'EVERY RECURSIVE QUERY THAT WALKS THIS TABLE and is refused by the '
  'reporting_lines_no_cycle trigger, not merely by the application. '
  'Change a line by ending it and inserting a new one — never by '
  'UPDATEing manager_id, which erases the fact an appraisal for a past '
  'period is assigned from.';

COMMENT ON COLUMN reporting_lines.ended_on IS
  'NULL means the line is in force. A leaver''s lines are NOT ended '
  'automatically and their reports are NOT moved: nulling them orphans '
  'people silently, and re-pointing them at the grandparent silently '
  'changes who signs off an appraisal for a period they did not '
  'supervise. The org chart reports stale lines and a human decides.';

COMMENT ON TABLE appraisal_subjects IS
  'One person''s appraisal in one cycle. 🔴 THE REVIEWERS ARE SNAPSHOTS '
  'TAKEN AT ENROLMENT from the reporting line in force over the review '
  'period — not a join. A reorganisation mid-cycle must not move forty '
  'live appraisals to managers who have never met the people. The '
  'outcome is frozen by trigger once signed_off_at is set.';

COMMENT ON COLUMN appraisal_subjects.released_at IS
  'Separate from signed_off_at on purpose. Signing off fixes the '
  'evidence; releasing is when the subject may read the manager review. '
  'They are days apart in practice and the gap is the conversation.';

COMMENT ON TABLE appraisal_reviews IS
  'Three acts, three rows: self, manager, skip_level. 🔴 THE SKIP-LEVEL '
  'REVIEW IS NEVER SHOWN TO THE SUBJECT OR TO THE DIRECT MANAGER — it '
  'is a check ON the manager, and showing it to them makes it a second '
  'manager review nobody writes honestly. The reviewer is checked '
  'against the kind by trigger, so no code path can file one person''s '
  'opinion under another''s name.';

COMMENT ON TABLE appraisal_amendments IS
  'The ONLY way a signed-off outcome changes. Append-only by trigger, '
  'carrying the previous rating, the new rating, the actor, the time and '
  'a reason of at least twenty characters. The effective outcome is the '
  'latest amendment or the original — a fold, never a column, the same '
  'call leave_ledger makes about balances.';

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  NO LINK TO PAY. There is no increment column, no bonus, no revised
--  CTC and no join to pay_components or employee_salary_structures.
--  Ordence records the appraisal; the increment is typed into payroll by
--  a human. An appraisal engine that moves money on its own needs the
--  effective-dating, the approval separation and the arrears arithmetic
--  a salary revision already has, and half of that is a wage bill
--  computed from a rating nobody signed.
--
--  NO GOALS OR OBJECTIVES TABLE. Goal-setting is a real feature with its
--  own cadence, its own mid-year check-in and its own ownership, and it
--  is NOT "an appraisal with more text boxes". A half version of it
--  would become the place people record goals badly.
--
--  NO PEER OR 360 REVIEW. A fourth review kind is one enum value and a
--  completely different consent question: who nominated the peer, who
--  sees that they were nominated, and whether the subject learns who
--  said what. That question has to be answered before the column exists,
--  not after.
--
--  NO CALIBRATION OR FORCED DISTRIBUTION. See the header: a stored rank
--  is a number that outlives its context and is quoted in exactly one
--  place years later.
--
--  ⚠️ AND NO NEW PERMISSION KEY. The HR screens borrow `users:read`,
--  `payroll.manage`, `payroll.read` and `payroll.approve` because Batch
--  109 does not own `db/schema/auth.ts`. The four keys that should exist
--  — `hr.orgchart.read`, `hr.orgchart.manage`, `hr.appraisals.read` and
--  `hr.appraisals.signoff` — are reported rather than invented, and
--  until they exist an HR coordinator cannot maintain the org chart
--  without also holding the key that edits salaries. That is the one
--  thing in this batch that is worse than it should be.
-- =====================================================================
