-- ============================================================================
-- Ordence — Phase 23: Workflow & Automation Engine
-- Version: v0.23.0-alpha
--
-- Run AFTER `npx drizzle-kit push`, and after `ALL-IN-ONE-SETUP.sql` and
-- `0017_change_log.sql` — it depends on `set_updated_at()`,
-- `app_current_tenant_id()` and `record_change()` from those. Like 0017, it
-- ships as a standalone numbered file rather than being folded into the
-- all-in-one; that file is the Phase 1–22 baseline.
--
-- Safe to run before `drizzle-kit push` too — Section 1 creates the tables
-- itself, idempotently, so a deployment that applies SQL first is not broken.
-- Safe to re-run: every statement is guarded.
--
-- Contents:
--   1. Enums and tables
--   2. Row-level security
--   3. ⭐ Cross-tenant reference integrity — the hole RLS does NOT close
--   4. ⭐ THE LOOP GUARD — depth and cycle detection, computed not trusted
--   5. An active version is immutable
--   6. Archiving a workflow with runs in flight
--   7. A finished run cannot be rewritten
--   8. Approval tasks
--   9. updated_at, and the change log
--  10. Grants
--  11. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Twenty-two phases have stored what a customer DID. This one stores what a
-- customer WROTE — a program, authored in the workspace, executed on our
-- servers, against a database shared with everybody else on the instance.
--
-- That brings a failure mode none of the earlier phases had:
--
--     A WORKFLOW THAT NEVER STOPS.
--
-- It is not an attack. It is the first automation almost everybody writes:
--
--     "When a lead is updated, update the lead."
--
-- Saved at 4pm. By 4:01 the engine has executed it several thousand times,
-- the change log has several thousand rows, the connection pool is gone, and
-- every other tenant on the instance is timing out. One customer's honest
-- mistake became everybody's outage, and no single component did anything
-- it was told not to.
--
-- The guards live at four levels, and only the last two are in this file:
--
--   1. `lib/workflows/validation.ts` warns the author at publish time.
--   2. `lib/workflows/triggers.ts` refuses to start the run, with a reason
--      the author can read in the history.
--   3. ⭐ Section 4 — the database RECOMPUTES depth and the causal chain
--      from the parent row and refuses a cycle. The caller does not get a
--      vote, because a guard that trusts the value it is guarding is not a
--      guard: an import script, a future API route or a bug in the planner
--      would each silently pass `depth: 0`.
--   4. Check constraints, as the backstop for anything that gets past 3.
--
-- The second theme of the file is Section 5. An ACTIVE VERSION IS IMMUTABLE,
-- because a run is not instantaneous: it can be suspended for thirty days by
-- a `delay`, or indefinitely by an approval, and while it waits it holds a
-- cursor — a position in the step list. Edit the definition underneath it and
-- that position means something else. Step 3 was an email and is now a
-- delete. The run resumes and deletes a record on the strength of an approval
-- somebody gave for an email. Section 5 makes that unrepresentable.
-- ============================================================================


CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ENUMS AND TABLES
-- ############################################################################
--
-- `drizzle-kit push` creates these from `db/schema/workflows.ts`. They are
-- restated here for the same reason Phase 22 restates its unique index: push
-- removes what it does not recognise, and a file that can only run second is
-- a file that fails on a fresh database.
--
-- ⚠️ THE ACTION AND TRIGGER ENUMS ARE GENERATED FROM
-- `lib/workflows/program.ts`. If you add a value here by hand and not there,
-- the database will accept a step the planner has never heard of — a run that
-- starts and can never finish. Add it in TypeScript; the enum follows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_trigger_type') THEN
    CREATE TYPE workflow_trigger_type AS ENUM
      ('record_created','record_updated','record_deleted','manual','scheduled','webhook');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_action_type') THEN
    CREATE TYPE workflow_action_type AS ENUM
      ('create_record','update_record','delete_record','find_records','send_email',
       'http_request','filter','if_else','iterator','delay','form');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_version_status') THEN
    CREATE TYPE workflow_version_status AS ENUM ('draft','active','archived');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_status') THEN
    CREATE TYPE workflow_run_status AS ENUM
      ('queued','running','waiting_delay','waiting_form','succeeded','stopped',
       'failed','cancelled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_step_status') THEN
    CREATE TYPE workflow_step_status AS ENUM ('running','succeeded','failed','skipped');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_task_status') THEN
    CREATE TYPE workflow_task_status AS ENUM
      ('pending','approved','rejected','expired','cancelled');
  END IF;
END
$$;


CREATE TABLE IF NOT EXISTS workflows (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key                  varchar(80)  NOT NULL,
  name                 varchar(200) NOT NULL,
  description          text,
  is_enabled           boolean NOT NULL DEFAULT true,
  -- The hash, never the token. See db/schema/workflows.ts.
  webhook_secret_hash  varchar(64),
  next_run_at          timestamptz,
  last_run_at          timestamptz,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  archived_by          uuid
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id     uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  status          workflow_version_status NOT NULL DEFAULT 'draft',
  trigger_type    workflow_trigger_type NOT NULL,
  trigger_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps           jsonb NOT NULL DEFAULT '[]'::jsonb,
  step_budget     integer NOT NULL DEFAULT 100,
  run_as_user_id  uuid,
  notes           text,
  published_at    timestamptz,
  published_by    uuid,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflow_versions_number_positive CHECK (version > 0),
  -- 500 is MAX_STEPS_PER_RUN in lib/workflows/limits.ts. A version may
  -- tighten its own budget; it may never loosen it past the engine's cap.
  CONSTRAINT workflow_versions_budget_sane
    CHECK (step_budget >= 1 AND step_budget <= 500),
  -- ⚠️ An active version must name the identity its unattended runs borrow.
  -- Nullable here would mean the executor has to decide what to do with a
  -- null actor, and every answer to that is worse than refusing the row.
  CONSTRAINT workflow_versions_active_is_published
    CHECK (status <> 'active' OR (published_at IS NOT NULL AND run_as_user_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id      uuid NOT NULL,
  version_id       uuid NOT NULL,
  status           workflow_run_status NOT NULL DEFAULT 'queued',
  trigger_type     workflow_trigger_type NOT NULL,
  record_type      varchar(60),
  record_id        uuid,
  context          jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- ⭐ Who this run IS. Not nullable: there is no such thing as a run with
  -- no responsible human, and a nullable column would eventually hold one.
  actor_user_id    uuid NOT NULL,
  actor_role       varchar(60) NOT NULL,

  -- ⭐ Loop control. Every column below is COMPUTED by the trigger in
  -- Section 4 from the parent row. The caller supplies parent_run_id only.
  parent_run_id    uuid,
  root_run_id      uuid,
  depth            integer NOT NULL DEFAULT 0,
  origin_chain     uuid[]  NOT NULL DEFAULT ARRAY[]::uuid[],

  steps_executed   integer NOT NULL DEFAULT 0,
  iterations_used  integer NOT NULL DEFAULT 0,
  resume_at        timestamptz,
  error            text,
  error_step_key   varchar(80),
  stop_reason      text,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- 10 is ABSOLUTE_MAX_TRIGGER_DEPTH; the engine refuses at 5. If this
  -- constraint ever fires, the guards above it have been bypassed — which
  -- is worth an error rather than a silent clamp.
  CONSTRAINT workflow_runs_depth_sane CHECK (depth >= 0 AND depth <= 10),
  CONSTRAINT workflow_runs_steps_sane
    CHECK (steps_executed >= 0 AND steps_executed <= 500),
  CONSTRAINT workflow_runs_chain_bounded
    CHECK (array_length(origin_chain, 1) IS NULL OR array_length(origin_chain, 1) <= 10),
  CONSTRAINT workflow_runs_failure_has_reason
    CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL,
  step_key     varchar(80)  NOT NULL,
  step_path    varchar(200) NOT NULL,
  action_type  workflow_action_type NOT NULL,
  status       workflow_step_status NOT NULL DEFAULT 'running',
  iteration    integer,
  sequence     integer NOT NULL,
  input        jsonb,
  output       jsonb,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id                uuid NOT NULL,
  step_key              varchar(80)  NOT NULL,
  title                 varchar(200) NOT NULL,
  instructions          text,
  assigned_to_user_id   uuid,
  status                workflow_task_status NOT NULL DEFAULT 'pending',
  -- NOT NULL. A run waiting on a person who has left the company waits
  -- forever, holding a cursor and blocking its workflow from ever being
  -- archived cleanly.
  expires_at            timestamptz NOT NULL,
  response              jsonb,
  responded_by          uuid,
  responded_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflow_tasks_response_attributed
    CHECK (status NOT IN ('approved','rejected')
           OR (responded_by IS NOT NULL AND responded_at IS NOT NULL))
);

-- Indexes. Every partial index here is partial on purpose: the sweepers scan
-- them every minute, and an index over all of run history would grow without
-- bound while answering a question about a handful of rows.
CREATE UNIQUE INDEX IF NOT EXISTS workflows_key_tenant_unique
  ON workflows (tenant_id, key) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS workflows_tenant_idx ON workflows (tenant_id);
CREATE INDEX IF NOT EXISTS workflows_tenant_enabled_idx ON workflows (tenant_id, is_enabled);
CREATE INDEX IF NOT EXISTS workflows_due_idx ON workflows (next_run_at)
  WHERE is_enabled AND archived_at IS NULL AND next_run_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_versions_number_unique
  ON workflow_versions (workflow_id, version);
-- ⭐ At most one active version per workflow. Two would mean one event
-- starting two runs of "the same" workflow doing different things, and no
-- page in the product would show anything wrong.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_versions_one_active
  ON workflow_versions (workflow_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS workflow_versions_tenant_idx ON workflow_versions (tenant_id);
CREATE INDEX IF NOT EXISTS workflow_versions_dispatch_idx
  ON workflow_versions (tenant_id, trigger_type) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS workflow_runs_tenant_idx ON workflow_runs (tenant_id, queued_at);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx ON workflow_runs (workflow_id, queued_at);
CREATE INDEX IF NOT EXISTS workflow_runs_status_idx ON workflow_runs (tenant_id, status);
CREATE INDEX IF NOT EXISTS workflow_runs_resume_idx ON workflow_runs (resume_at)
  WHERE status = 'waiting_delay';
CREATE INDEX IF NOT EXISTS workflow_runs_parent_idx ON workflow_runs (parent_run_id);

CREATE INDEX IF NOT EXISTS workflow_run_steps_run_idx ON workflow_run_steps (run_id, sequence);
CREATE INDEX IF NOT EXISTS workflow_run_steps_tenant_idx ON workflow_run_steps (tenant_id);
CREATE INDEX IF NOT EXISTS workflow_run_steps_failed_idx
  ON workflow_run_steps (tenant_id, started_at) WHERE status = 'failed';

CREATE UNIQUE INDEX IF NOT EXISTS workflow_tasks_one_pending
  ON workflow_tasks (run_id, step_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS workflow_tasks_tenant_idx ON workflow_tasks (tenant_id, status);
CREATE INDEX IF NOT EXISTS workflow_tasks_assignee_idx
  ON workflow_tasks (tenant_id, assigned_to_user_id);
CREATE INDEX IF NOT EXISTS workflow_tasks_expiry_idx ON workflow_tasks (expires_at)
  WHERE status = 'pending';


-- ############################################################################
-- SECTION 2 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER as well,
-- which is the half everybody forgets: without it, the role that created the
-- table reads everything and the policies look like they are working.
--
-- ⚠️ NOTE WHAT IS ABSENT: no policy here carries `OR app_is_platform_scope()`.
-- A workflow definition is a map of how a company runs — which fields it
-- watches, which endpoints it calls, which records it writes — and a run's
-- context contains copies of the customer records that passed through it.
-- Platform staff have no business reading either, and the narrowing of that
-- marker away from customer content was itself a defect fixed in v0.14.1.

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflows_tenant_isolation ON workflows;
CREATE POLICY workflows_tenant_isolation ON workflows
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_versions_tenant_isolation ON workflow_versions;
CREATE POLICY workflow_versions_tenant_isolation ON workflow_versions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_runs_tenant_isolation ON workflow_runs;
CREATE POLICY workflow_runs_tenant_isolation ON workflow_runs
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE workflow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_run_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_run_steps_tenant_isolation ON workflow_run_steps;
CREATE POLICY workflow_run_steps_tenant_isolation ON workflow_run_steps
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE workflow_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_tasks_tenant_isolation ON workflow_tasks;
CREATE POLICY workflow_tasks_tenant_isolation ON workflow_tasks
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 3 — ⭐ CROSS-TENANT REFERENCE INTEGRITY
-- ############################################################################
--
-- ⚠️ FOREIGN-KEY CHECKS RUN AS THE SYSTEM AND IGNORE ROW-LEVEL SECURITY.
-- That is documented PostgreSQL behaviour, it is easy to read past, and it is
-- why every pointer in this phase is a COMPOSITE key on (col, tenant_id).
--
-- The shape of the hole, concretely for this phase:
--
--     Tenant A inserts a run with
--         tenant_id  = A                       ← passes WITH CHECK
--         version_id = <a version owned by B>   ← passes the FK, it exists
--
--     The run is now executing TENANT B'S PROGRAM against tenant A's data,
--     as one of tenant A's users. Every step is authorised correctly, every
--     row written belongs to A, and the automation was written by somebody
--     in another company. Nothing errors. Nothing logs.
--
-- That is the worst version of this bug anywhere in the codebase so far —
-- elsewhere a cross-tenant pointer produces a wrong label on a page. Here it
-- produces code execution from one workspace inside another.
--
-- The `users` edges get the same treatment for the reasons Phase 22 Section
-- 2d spells out: an existence oracle, and one tenant's user deletion writing
-- into another tenant's rows.

CREATE UNIQUE INDEX IF NOT EXISTS workflows_id_tenant_key
  ON workflows (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_versions_id_tenant_key
  ON workflow_versions (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_id_tenant_key
  ON workflow_runs (id, tenant_id);

-- users(id, tenant_id) already exists from Phase 22 §2d; created here too so
-- this file does not depend on the order the SQL directory is applied in.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_key
  ON users (id, tenant_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_versions_workflow_same_tenant') THEN
    ALTER TABLE workflow_versions
      ADD CONSTRAINT workflow_versions_workflow_same_tenant
      FOREIGN KEY (workflow_id, tenant_id)
      REFERENCES workflows (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_versions_run_as_same_tenant') THEN
    ALTER TABLE workflow_versions
      ADD CONSTRAINT workflow_versions_run_as_same_tenant
      FOREIGN KEY (run_as_user_id, tenant_id)
      REFERENCES users (id, tenant_id)
      -- ⚠️ SET NULL, and the consequence is deliberate: when the publisher
      -- leaves, an unattended workflow loses the identity it ran as, the
      -- CHECK above stops it being active with none, and the executor
      -- refuses it. A workflow acting on behalf of somebody who no longer
      -- works there is precisely what should stop.
      ON DELETE SET NULL (run_as_user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_workflow_same_tenant') THEN
    ALTER TABLE workflow_runs
      ADD CONSTRAINT workflow_runs_workflow_same_tenant
      FOREIGN KEY (workflow_id, tenant_id)
      REFERENCES workflows (id, tenant_id)
      -- ⚠️ RESTRICT, NOT CASCADE. See Section 6 — run history outlives the
      -- workflow it came from, because "what did that automation do to our
      -- data?" is asked after somebody has already tried to get rid of it.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_version_same_tenant') THEN
    ALTER TABLE workflow_runs
      ADD CONSTRAINT workflow_runs_version_same_tenant
      FOREIGN KEY (version_id, tenant_id)
      REFERENCES workflow_versions (id, tenant_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_parent_same_tenant') THEN
    ALTER TABLE workflow_runs
      ADD CONSTRAINT workflow_runs_parent_same_tenant
      FOREIGN KEY (parent_run_id, tenant_id)
      REFERENCES workflow_runs (id, tenant_id)
      ON DELETE SET NULL (parent_run_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_actor_same_tenant') THEN
    ALTER TABLE workflow_runs
      ADD CONSTRAINT workflow_runs_actor_same_tenant
      FOREIGN KEY (actor_user_id, tenant_id)
      REFERENCES users (id, tenant_id)
      -- ⚠️ RESTRICT. The actor is the answer to "who is responsible for
      -- what this run did". A cascade would erase that answer at exactly
      -- the moment somebody leaves under a cloud, and SET NULL is refused
      -- by the NOT NULL. So a user with run history is offboarded (their
      -- status changes) rather than deleted, which is what the product
      -- does anyway.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_run_steps_run_same_tenant') THEN
    ALTER TABLE workflow_run_steps
      ADD CONSTRAINT workflow_run_steps_run_same_tenant
      FOREIGN KEY (run_id, tenant_id)
      REFERENCES workflow_runs (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_tasks_run_same_tenant') THEN
    ALTER TABLE workflow_tasks
      ADD CONSTRAINT workflow_tasks_run_same_tenant
      FOREIGN KEY (run_id, tenant_id)
      REFERENCES workflow_runs (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_tasks_assignee_same_tenant') THEN
    ALTER TABLE workflow_tasks
      ADD CONSTRAINT workflow_tasks_assignee_same_tenant
      FOREIGN KEY (assigned_to_user_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (assigned_to_user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflows_created_by_same_tenant') THEN
    ALTER TABLE workflows
      ADD CONSTRAINT workflows_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_versions_published_by_same_tenant') THEN
    ALTER TABLE workflow_versions
      ADD CONSTRAINT workflow_versions_published_by_same_tenant
      FOREIGN KEY (published_by, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (published_by);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 4 — ⭐ THE LOOP GUARD
-- ############################################################################
--
-- The most important function in the phase.
--
-- Every run carries three facts about how it came to exist: how deep it sits
-- in a chain of workflows that triggered each other (`depth`), which versions
-- are already in that chain (`origin_chain`), and which run started the whole
-- thing (`root_run_id`).
--
-- ⚠️ THE CALLER SUPPLIES NONE OF THEM. It supplies `parent_run_id`, and this
-- function derives the rest from the parent row.
--
-- That is the entire point. An engine that accepted `depth` from its caller
-- has a loop guard any caller can switch off — and the caller that switches
-- it off is far more likely to be a well-meaning import script or a bug in
-- the planner than an attacker. Derivation makes the guard true by
-- construction rather than by everybody remembering.
--
-- THE TWO REFUSALS:
--
--   CYCLE — this version is already in the chain. Catches the pair that
--     ping-pongs: A updates a lead, B fires and updates the lead, A fires
--     again. Neither workflow triggers itself, and the two never stop.
--
--   DEPTH — the chain is longer than five. The backstop for chains that are
--     long rather than circular, and the only one that catches a cycle
--     passing through a workflow that has been republished — a new version
--     id, so the cycle check sees a stranger.
--
-- ⚠️ Keying on the VERSION rather than the workflow is deliberate. The
-- workflow is the identity; the version is the program. Two different
-- programs of one workflow chaining is odd but legitimate during a
-- migration; the same program running itself is a loop.
--
-- ⚠️ THIS FUNCTION IS SECURITY INVOKER, NOT DEFINER. The parent lookup is
-- therefore subject to RLS, so a run in another tenant is simply not found
-- and the insert is refused — the composite key in Section 3 says the same
-- thing a second way. Making it DEFINER to "fix" a not-found would hand the
-- caller a cross-tenant read.

CREATE OR REPLACE FUNCTION workflow_run_chain_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_run  workflow_runs%ROWTYPE;
  v_chain     uuid[];
  v_depth     integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_run_id IS NULL THEN
      v_depth := 0;
      v_chain := ARRAY[]::uuid[];
      -- A run with no parent is the root of its own chain.
      NEW.root_run_id := NEW.id;
    ELSE
      SELECT * INTO parent_run FROM workflow_runs WHERE id = NEW.parent_run_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Parent run % does not exist, or belongs to another workspace.',
          NEW.parent_run_id
          USING ERRCODE = '23503';
      END IF;

      v_depth := parent_run.depth + 1;
      v_chain := parent_run.origin_chain;
      NEW.root_run_id := COALESCE(parent_run.root_run_id, parent_run.id);
    END IF;

    -- ⭐ CYCLE DETECTION.
    IF NEW.version_id = ANY (v_chain) THEN
      RAISE EXCEPTION
        'This workflow already ran earlier in the chain of events that led here. '
        'Starting it again would loop: check which workflows write to the records '
        'the others watch.'
        USING ERRCODE = '23514';
    END IF;

    v_chain := v_chain || NEW.version_id;

    -- ⭐ DEPTH. 5 is MAX_TRIGGER_DEPTH in lib/workflows/limits.ts.
    IF v_depth > 5 THEN
      RAISE EXCEPTION
        'Automations have already chained 5 deep from the original change. '
        'Stopping here — a chain longer than this is almost always a loop '
        'between workflows rather than a design.'
        USING ERRCODE = '23514';
    END IF;

    NEW.depth        := v_depth;
    NEW.origin_chain := v_chain;
    RETURN NEW;
  END IF;

  -- ── UPDATE ──────────────────────────────────────────────────────────
  --
  -- ⚠️ THE PROVENANCE COLUMNS ARE IMMUTABLE, AND SO IS THE ACTOR.
  --
  -- Without this, the guard above is a formality: insert a run at depth 5,
  -- then UPDATE it to depth 0 and use it as the parent of the next one.
  -- The same reasoning covers `actor_user_id` — a run that could change
  -- who it is acting as, mid-flight, is a privilege-escalation primitive
  -- with a queue in front of it.
  IF NEW.depth        IS DISTINCT FROM OLD.depth
     OR NEW.origin_chain  IS DISTINCT FROM OLD.origin_chain
     OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
     OR NEW.root_run_id   IS DISTINCT FROM OLD.root_run_id
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.version_id    IS DISTINCT FROM OLD.version_id
     OR NEW.workflow_id   IS DISTINCT FROM OLD.workflow_id THEN
    RAISE EXCEPTION
      'A run''s workflow, version, actor and chain position cannot be changed '
      'after it starts. These are what the loop guard and the permission check '
      'are computed from.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_runs_chain_guard ON workflow_runs;
CREATE TRIGGER workflow_runs_chain_guard
  BEFORE INSERT OR UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION workflow_run_chain_guard();


-- ############################################################################
-- SECTION 5 — AN ACTIVE VERSION IS IMMUTABLE
-- ############################################################################
--
-- See the file header for why. In short: a suspended run holds a POSITION in
-- the step list, and editing the list underneath it makes that position mean
-- something else.
--
-- ⚠️ THE ALLOWED UPDATES ARE LISTED, NOT THE FORBIDDEN ONES.
--
-- The tempting implementation is "refuse if `steps` changed". Then somebody
-- adds a column next phase, it is not in the list, and it becomes editable on
-- an active version by omission. Naming what MAY change means a new column is
-- frozen by default, which is the safe direction for a rule whose failure is
-- silent.

CREATE OR REPLACE FUNCTION enforce_workflow_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A draft is a draft. Edit freely.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- The only lifecycle move allowed on a published version is retirement.
  -- Going back to draft would resurrect an editable definition that runs
  -- already point at.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'active' AND NEW.status = 'archived') THEN
      RAISE EXCEPTION
        'A % version cannot become %. Publish a new draft instead — that is '
        'what versioning is for.',
        OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.steps          IS DISTINCT FROM OLD.steps
     OR NEW.trigger_type   IS DISTINCT FROM OLD.trigger_type
     OR NEW.trigger_config IS DISTINCT FROM OLD.trigger_config
     OR NEW.step_budget    IS DISTINCT FROM OLD.step_budget
     OR NEW.version        IS DISTINCT FROM OLD.version
     OR NEW.workflow_id    IS DISTINCT FROM OLD.workflow_id
     OR NEW.published_at   IS DISTINCT FROM OLD.published_at
     OR NEW.published_by   IS DISTINCT FROM OLD.published_by THEN
    RAISE EXCEPTION
      'Version % is % and cannot be edited. Runs may be suspended part-way '
      'through it right now — a delay or an approval can hold a run for days — '
      'and they hold a POSITION in this step list. Changing the steps under '
      'them makes that position mean something else. Create a new draft.',
      OLD.version, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- `run_as_user_id` is deliberately absent from that list: the composite
  -- foreign key sets it to NULL when the publisher's user row is deleted,
  -- and refusing that write would block the deletion of a departing
  -- employee. The CHECK constraint then stops the version staying active
  -- with no identity, which is the outcome we actually want.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_versions_immutable ON workflow_versions;
CREATE TRIGGER workflow_versions_immutable
  BEFORE UPDATE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_workflow_version_immutable();


-- ############################################################################
-- SECTION 6 — ARCHIVING A WORKFLOW WITH RUNS IN FLIGHT
-- ############################################################################
--
-- The question this section answers: what happens to a run that is suspended
-- on an approval when somebody deletes the workflow?
--
-- THE THREE POSSIBLE ANSWERS, AND WHY TWO OF THEM ARE WRONG:
--
--   a) CASCADE the delete. The run history goes with it — including the
--      record of what the automation did to customer data last month. That
--      is the one thing nobody may lose, and it is precisely what somebody
--      covering up a bad automation would choose.
--
--   b) REFUSE while runs exist. Sounds principled. In practice the operator
--      cannot get rid of a workflow that is misbehaving, at the moment they
--      most want to, because it has runs in flight — which it does BECAUSE
--      it is misbehaving.
--
--   c) ARCHIVE. Stop it starting anything new, leave what has already
--      started to finish or be cancelled explicitly, keep the history.
--
-- (c), and the API makes the caller say which of "let them finish" or
-- "cancel them" they mean, with no default (`archiveWorkflowSchema`).
--
-- ⚠️ ARCHIVING ALSO DISABLES. Otherwise an archived workflow whose
-- `is_enabled` is still true is one bug in a dispatcher query away from
-- running again, and `next_run_at` left set is a scheduled fire the sweeper
-- will happily pick up.

CREATE OR REPLACE FUNCTION enforce_workflow_archive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    NEW.is_enabled  := false;
    NEW.next_run_at := NULL;
  END IF;

  -- Un-archiving is allowed — a mistaken archive should be recoverable —
  -- but the workflow comes back switched OFF. Restoring something that
  -- immediately starts running is how an "undo" becomes an incident.
  IF NEW.archived_at IS NULL AND OLD.archived_at IS NOT NULL THEN
    NEW.is_enabled := false;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflows_archive_guard ON workflows;
CREATE TRIGGER workflows_archive_guard
  BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION enforce_workflow_archive();


-- A hard delete is refused at two levels: no DELETE grant (Section 10), and
-- the RESTRICT foreign keys in Section 3. This trigger is the third, and it
-- exists to give a HUMAN AT A psql PROMPT a sentence rather than a constraint
-- name — that person is usually resolving an incident at speed, and
-- `violates foreign key constraint "workflow_runs_workflow_same_tenant"` does
-- not tell them what to do instead.

CREATE OR REPLACE FUNCTION block_workflow_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_count integer;
BEGIN
  SELECT count(*) INTO run_count FROM workflow_runs WHERE workflow_id = OLD.id;

  IF run_count > 0 THEN
    RAISE EXCEPTION
      'Workflow "%" has % run(s) in its history and cannot be deleted. Archive '
      'it instead: that stops it running, keeps the record of what it already '
      'did, and is reversible.',
      OLD.name, run_count
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS workflows_no_delete_with_runs ON workflows;
CREATE TRIGGER workflows_no_delete_with_runs
  BEFORE DELETE ON workflows
  FOR EACH ROW EXECUTE FUNCTION block_workflow_delete();


-- ############################################################################
-- SECTION 7 — A FINISHED RUN CANNOT BE REWRITTEN
-- ############################################################################
--
-- Run history is the answer to "why is this record like this?". It is read in
-- exactly the situations where somebody would prefer a different answer: a
-- customer was emailed the wrong figure, a lead was reassigned, a record was
-- deleted overnight.
--
-- A finished run is therefore closed. The correction for a wrong one is a new
-- run, or a note elsewhere — not an edit. This is the same argument as
-- `lead_activities` in Phase 22, and the same argument as the audit log in
-- Phase 1; it keeps arriving because it keeps being right.
--
-- ⚠️ NOT `block_mutation_append_only()`. A run is legitimately updated many
-- times WHILE it is alive — status, cursor, context, counters. Only the
-- transition into a terminal state is one-way.

CREATE OR REPLACE FUNCTION enforce_run_finality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('succeeded','stopped','failed','cancelled') THEN
    RAISE EXCEPTION
      'Run % finished as % and cannot be changed. If it did the wrong thing, '
      'the record of that is the point.',
      OLD.id, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_runs_final ON workflow_runs;
CREATE TRIGGER workflow_runs_final
  BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_run_finality();


-- A step row is written once when it starts and once when it ends. After
-- that it is evidence, and the same rule applies.
CREATE OR REPLACE FUNCTION enforce_step_finality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION
      'Step % of this run has already finished and cannot be rewritten.',
      OLD.step_key
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_run_steps_final ON workflow_run_steps;
CREATE TRIGGER workflow_run_steps_final
  BEFORE UPDATE ON workflow_run_steps
  FOR EACH ROW EXECUTE FUNCTION enforce_step_finality();


-- ----------------------------------------------------------------------------
-- 7b. Resuming a run that nothing is running.
-- ----------------------------------------------------------------------------
--
-- Two sweepers, both narrow, both idempotent, and neither of them deletes
-- anything — the same reasoning as `release_expired_unit_holds` in Phase 22.
--
-- ⚠️ `FOR UPDATE SKIP LOCKED` is what makes them safe to run from more than
-- one worker. Without it two dispatchers claim the same run and execute it
-- twice, which for a `send_email` step means a buyer gets the message twice.

CREATE OR REPLACE FUNCTION claim_due_workflow_runs(
  p_tenant_id uuid DEFAULT NULL,
  p_limit     integer DEFAULT 50
)
RETURNS TABLE (run_id uuid, workflow_id uuid, resumed_from timestamptz)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE workflow_runs r
     SET status     = 'queued',
         resume_at  = NULL,
         updated_at = now()
    FROM (
      SELECT w.id, w.workflow_id, w.resume_at
        FROM workflow_runs w
       WHERE w.status = 'waiting_delay'
         AND w.resume_at IS NOT NULL
         AND w.resume_at <= now()
         AND (p_tenant_id IS NULL OR w.tenant_id = p_tenant_id)
       ORDER BY w.resume_at
       LIMIT GREATEST(p_limit, 0)
       FOR UPDATE SKIP LOCKED
    ) due
   WHERE r.id = due.id
  RETURNING due.id, due.workflow_id, due.resume_at;
END;
$$;


-- Approval requests that nobody answered.
--
-- ⚠️ The TASK expires and the RUN fails, in that order and in one statement
-- each. An expired task that left its run waiting would be the worst of both:
-- the request is gone from everybody's list and the run is still holding a
-- cursor, waiting for a reply that can no longer be given.

CREATE OR REPLACE FUNCTION expire_workflow_tasks(p_tenant_id uuid DEFAULT NULL)
RETURNS TABLE (task_id uuid, run_id uuid)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH expired AS (
    UPDATE workflow_tasks t
       SET status = 'expired', updated_at = now()
     WHERE t.status = 'pending'
       AND t.expires_at <= now()
       AND (p_tenant_id IS NULL OR t.tenant_id = p_tenant_id)
    RETURNING t.id, t.run_id, t.title
  ), failed AS (
    UPDATE workflow_runs r
       SET status         = 'failed',
           error          = 'Nobody responded to the approval request "'
                            || e.title || '" before it expired.',
           error_step_key = NULL,
           finished_at    = now(),
           updated_at     = now()
      FROM expired e
     WHERE r.id = e.run_id
       AND r.status = 'waiting_form'
    RETURNING r.id
  )
  SELECT e.id, e.run_id FROM expired e;
END;
$$;


-- ############################################################################
-- SECTION 8 — APPROVAL TASKS
-- ############################################################################
--
-- ⚠️ A TASK IS ANSWERED ONCE.
--
-- Without this, two clicks on "Approve" — a double-tap on a phone, a retried
-- request — resume the run twice from the same cursor, and every step after
-- the approval happens twice. For an approval step that is the single most
-- likely place for a duplicate to matter, because what follows an approval is
-- usually the irreversible part.

CREATE OR REPLACE FUNCTION enforce_task_answered_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'This request was already %. It cannot be answered twice — what follows '
      'an approval is usually the part that cannot be undone.',
      OLD.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('approved','rejected') AND NEW.responded_at IS NULL THEN
    NEW.responded_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_tasks_answered_once ON workflow_tasks;
CREATE TRIGGER workflow_tasks_answered_once
  BEFORE UPDATE ON workflow_tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_task_answered_once();


-- ############################################################################
-- SECTION 9 — updated_at, AND THE CHANGE LOG
-- ############################################################################

DROP TRIGGER IF EXISTS workflows_set_updated_at ON workflows;
CREATE TRIGGER workflows_set_updated_at BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS workflow_versions_set_updated_at ON workflow_versions;
CREATE TRIGGER workflow_versions_set_updated_at BEFORE UPDATE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS workflow_runs_set_updated_at ON workflow_runs;
CREATE TRIGGER workflow_runs_set_updated_at BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS workflow_tasks_set_updated_at ON workflow_tasks;
CREATE TRIGGER workflow_tasks_set_updated_at BEFORE UPDATE ON workflow_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ⚠️ THE CHANGE LOG IS ATTACHED HERE RATHER THAN LEFT TO 0017.
--
-- `0017_change_log.sql` discovers every tenant-scoped table and attaches
-- `record_change()` to it — but only when it is re-run, and a deployment that
-- applies files in numerical order runs it BEFORE these tables exist. The
-- coverage check in that file would then report five tables recording nothing,
-- which is a real gap: anything written to them could never sync.
--
-- ⚠️ `workflow_run_steps` IS INCLUDED, AND IT WAS THE ONE ARGUABLE CALL.
--
-- It is by far the fastest-growing table in the phase — one row per step
-- EXECUTION, so a four-step loop over fifty items is two hundred rows — and
-- the case for excluding it (like `lead_activities`) is that its rows are
-- immutable once finished, so the table is already its own history.
--
-- It is logged anyway, for one reason that outweighs the volume: a step row
-- holds RESOLVED INPUT. The address an email actually went to, the values
-- actually written to a lead. That is customer content, including personal
-- data, and a table of personal data that no change feed covers is a table
-- that silently diverges the first time sync exists. Storage is cheap and
-- retention is a separate, solvable problem; a hole in the log is not.

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_change') THEN
    FOREACH t IN ARRAY ARRAY['workflows','workflow_versions','workflow_runs',
                             'workflow_run_steps','workflow_tasks']
    LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_change_log', t);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION record_change()',
        t || '_change_log', t);
    END LOOP;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 10 — GRANTS
-- ############################################################################
--
-- REVOKE before GRANT. An additive-only block is defeated by any prior
-- `GRANT ALL ON ALL TABLES`, which is the first thing most people run when a
-- query fails with "permission denied". Found the hard way in Phase 11.
--
-- ⚠️ NO DELETE ON ANYTHING IN THIS PHASE.
--
--   `workflows`          — archived, never deleted. Section 6.
--   `workflow_versions`  — a version with runs against it is the only record
--                          of what those runs executed.
--   `workflow_runs`      — history. The whole point.
--   `workflow_run_steps` — the same, one level down.
--   `workflow_tasks`     — evidence that a person approved something.
--
-- A workflow engine with a DELETE grant on its own run history is a workflow
-- engine whose first step can be "delete the evidence of the second".

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON workflows          FROM ordence_app;
    REVOKE ALL ON workflow_versions  FROM ordence_app;
    REVOKE ALL ON workflow_runs      FROM ordence_app;
    REVOKE ALL ON workflow_run_steps FROM ordence_app;
    REVOKE ALL ON workflow_tasks     FROM ordence_app;

    GRANT SELECT, INSERT, UPDATE ON workflows          TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON workflow_versions  TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON workflow_runs      TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON workflow_run_steps TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON workflow_tasks     TO ordence_app;

    GRANT EXECUTE ON FUNCTION claim_due_workflow_runs(uuid, integer) TO ordence_app;
    GRANT EXECUTE ON FUNCTION expire_workflow_tasks(uuid)            TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 11 — VERIFICATION
-- ############################################################################
--
-- Every check names what breaks if it fails, because "FAIL" on its own tells
-- you nothing about whether to panic.

-- Check 1 — RLS is ENABLED **and FORCED** on all five tables.
-- ⚠️ `relforcerowsecurity` is the column that matters. A table with ENABLE
-- but not FORCE looks protected in every UI and is not protected against its
-- own owner.
SELECT
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS (enabled + forced)'
       WHEN c.relrowsecurity
       THEN '*** FAIL — enabled but NOT FORCED: the owner bypasses it ***'
       ELSE '*** FAIL — ROW LEVEL SECURITY IS OFF: every tenant can read and '
            'run every other tenant''s automations ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('workflows','workflow_versions','workflow_runs',
                    'workflow_run_steps','workflow_tasks')
ORDER BY c.relname;


-- Check 2 — every policy has BOTH a read and a write clause.
SELECT
  tablename, policyname,
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS (read + write)'
       WHEN with_check IS NULL
       THEN '*** FAIL — no WITH CHECK: a tenant can plant a workflow in '
            'another tenant''s workspace ***'
       ELSE '*** FAIL — no USING clause ***'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('workflows','workflow_versions','workflow_runs',
                    'workflow_run_steps','workflow_tasks')
ORDER BY tablename;


-- Check 3 — ⭐ the composite foreign keys exist (Section 3).
-- A missing one here means a run can execute ANOTHER TENANT'S PROGRAM
-- against this tenant's data.
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: a row can point at another tenant''s record ***'
  END AS verdict
FROM (VALUES
  ('workflow_versions_workflow_same_tenant'),
  ('workflow_versions_run_as_same_tenant'),
  ('workflow_versions_published_by_same_tenant'),
  ('workflow_runs_workflow_same_tenant'),
  ('workflow_runs_version_same_tenant'),
  ('workflow_runs_parent_same_tenant'),
  ('workflow_runs_actor_same_tenant'),
  ('workflow_run_steps_run_same_tenant'),
  ('workflow_tasks_run_same_tenant'),
  ('workflow_tasks_assignee_same_tenant'),
  ('workflows_created_by_same_tenant')
) AS expected(conname)
LEFT JOIN pg_constraint pc ON pc.conname = expected.conname;


-- Check 4 — ⭐ THE LOOP GUARD IS INSTALLED AND ENABLED.
-- ⚠️ `tgenabled` needs the ::text cast; without it the comparison silently
-- misbehaves. Found in Phase 11 against a real PostgreSQL.
SELECT
  expected.tgname,
  CASE WHEN t.tgname IS NULL THEN '*** FAIL — TRIGGER MISSING ***'
       WHEN t.tgenabled::text = 'O' THEN 'PASS (enabled)'
       ELSE '*** FAIL — trigger DISABLED: ' || t.tgenabled::text || ' ***'
  END AS verdict
FROM (VALUES
  ('workflow_runs_chain_guard',    'workflow_runs'),
  ('workflow_runs_final',          'workflow_runs'),
  ('workflow_versions_immutable',  'workflow_versions'),
  ('workflows_archive_guard',      'workflows'),
  ('workflows_no_delete_with_runs','workflows'),
  ('workflow_run_steps_final',     'workflow_run_steps'),
  ('workflow_tasks_answered_once', 'workflow_tasks')
) AS expected(tgname, tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tgname
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal;


-- Check 5 — ⭐ the loop guard actually REFUSES, proved rather than inspected.
--
-- A trigger that exists and does nothing passes Check 4. This one builds a
-- real chain of runs in a temporary tenant, tries to close the cycle, and
-- reports whether the database said no. It rolls everything back.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_user    uuid := gen_random_uuid();
  v_wf      uuid := gen_random_uuid();
  v_version uuid := gen_random_uuid();
  v_root    uuid;
  v_child   uuid;
  v_depth   integer;
  v_refused boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_verify_' || v_tenant, 'vfy-' || left(v_tenant::text, 8),
            'Verification', 'active');
  INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
    VALUES (v_user, v_tenant, 'usr_verify_' || v_user, 'verify@example.test',
            'tenant_admin', 'active');
  INSERT INTO workflows (id, tenant_id, key, name)
    VALUES (v_wf, v_tenant, 'verify', 'Verification workflow');
  INSERT INTO workflow_versions
    (id, tenant_id, workflow_id, version, status, trigger_type, published_at, run_as_user_id)
    VALUES (v_version, v_tenant, v_wf, 1, 'active', 'record_updated', now(), v_user);

  INSERT INTO workflow_runs (tenant_id, workflow_id, version_id, trigger_type,
                             actor_user_id, actor_role, depth)
    -- ⚠️ depth 4 is supplied ON PURPOSE and must be IGNORED. The trigger
    -- recomputes it from the parent (there is none, so zero).
    VALUES (v_tenant, v_wf, v_version, 'record_updated', v_user, 'tenant_admin', 4)
    RETURNING id, depth INTO v_root, v_depth;

  IF v_depth <> 0 THEN
    RAISE WARNING '*** FAIL — the caller''s depth was TRUSTED (got %). The loop '
                  'guard can be switched off by whoever inserts the run. ***', v_depth;
  END IF;

  BEGIN
    INSERT INTO workflow_runs (tenant_id, workflow_id, version_id, trigger_type,
                               actor_user_id, actor_role, parent_run_id)
      VALUES (v_tenant, v_wf, v_version, 'record_updated', v_user, 'tenant_admin', v_root)
      RETURNING id INTO v_child;
  EXCEPTION WHEN OTHERS THEN
    v_refused := true;
  END;

  IF v_refused AND v_depth = 0 THEN
    RAISE NOTICE 'PASS: the loop guard recomputed depth and refused the cycle.';
  ELSIF NOT v_refused THEN
    RAISE WARNING '*** FAIL — A WORKFLOW WAS ALLOWED TO TRIGGER ITSELF. One '
                  'customer''s automation can now consume the whole instance. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 6 — at most one active version per workflow.
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'workflow_versions'
       AND indexname = 'workflow_versions_one_active'
  ) THEN 'PASS: a workflow cannot have two live definitions'
  ELSE  '*** FAIL: workflow_versions_one_active IS MISSING — one event would '
        'start two runs of the same workflow doing different things ***'
  END AS check_one_active_version;


-- Check 7 — no workflow currently HAS two active versions.
-- Belt and braces: if the index were created after data existed, duplicates
-- could predate it.
SELECT
  workflow_id, count(*) AS active_versions,
  '*** FAIL — this workflow has two live definitions. Archive one before '
  'anything else in this file. ***' AS verdict
FROM workflow_versions
WHERE status = 'active'
GROUP BY workflow_id
HAVING count(*) > 1;
-- (No rows returned = PASS.)


-- Check 8 — nothing points across a tenant boundary TODAY.
SELECT 'versions → workflows' AS relationship, count(*) AS violations,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END AS verdict
  FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id
 WHERE v.tenant_id <> w.tenant_id
UNION ALL
SELECT 'runs → versions', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM workflow_runs r JOIN workflow_versions v ON v.id = r.version_id
 WHERE r.tenant_id <> v.tenant_id
UNION ALL
SELECT 'runs → users (actor)', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM workflow_runs r JOIN users u ON u.id = r.actor_user_id
 WHERE r.tenant_id <> u.tenant_id
UNION ALL
SELECT 'steps → runs', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
 WHERE s.tenant_id <> r.tenant_id
UNION ALL
SELECT 'tasks → runs', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE '*** FAIL ***' END
  FROM workflow_tasks t JOIN workflow_runs r ON r.id = t.run_id
 WHERE t.tenant_id <> r.tenant_id;


-- Check 9 — the app role cannot DELETE any workflow record.
SELECT
  t.table_name, t.privilege_type,
  '*** FAIL — DELETE granted: an automation''s history can be erased, '
  'including by an automation ***' AS verdict
FROM information_schema.role_table_grants t
WHERE t.grantee = 'ordence_app'
  AND t.privilege_type = 'DELETE'
  AND t.table_name IN ('workflows','workflow_versions','workflow_runs',
                       'workflow_run_steps','workflow_tasks');
-- (No rows returned = PASS.)


-- Check 10 — every active version names the identity it runs as.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every live automation has a responsible user'
       ELSE '*** FAIL — ' || count(*) || ' live automation(s) have no identity. '
            'Their unattended runs would have no permissions to check against. ***'
  END AS check_active_has_actor
FROM workflow_versions
WHERE status = 'active' AND (run_as_user_id IS NULL OR published_at IS NULL);


-- Check 11 — no run claims a depth the guard would refuse.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: no run is deeper than the chain limit'
       ELSE '*** FAIL — ' || count(*) || ' run(s) exceed the depth limit. The '
            'chain guard is not holding. ***'
  END AS check_no_deep_runs
FROM workflow_runs
WHERE depth > 5;


-- Check 12 — the sweepers exist and are callable.
SELECT
  CASE WHEN (SELECT count(*) FROM pg_proc
              WHERE proname IN ('claim_due_workflow_runs','expire_workflow_tasks')) = 2
       THEN 'PASS: delayed runs resume and unanswered approvals expire'
       ELSE '*** FAIL — a sweeper is missing: runs suspended on a delay or an '
            'approval would wait forever, holding a cursor each ***'
  END AS check_sweepers;


-- Check 13 — the change log covers this phase.
SELECT
  expected.tbl,
  CASE WHEN t.tgname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — changes here are not recorded and could never sync ***'
  END AS verdict
FROM (VALUES
  ('workflows'), ('workflow_versions'), ('workflow_runs'),
  ('workflow_run_steps'), ('workflow_tasks')
) AS expected(tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tbl || '_change_log'
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal;
