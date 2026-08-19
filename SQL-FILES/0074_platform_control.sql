-- =====================================================================
--  ORDENCE — 0074 · THE CONTROL PLANE'S OWN CONTROLS
--  Version: v1.22.0-alpha
--
--  ⚠️ RUN AFTER 0073. Four new tables and four columns. Touches no
--  tenant data and changes nothing that already exists.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 THE PANEL HAS ALWAYS RECORDED WHAT IT DID AND NEVER STOPPED
--  ANYTHING
--  ══════════════════════════════════════════════════════════════════
--  `platform_action_log` has been complete since the console was built.
--  Every suspension, every override, every impersonation is in it, with
--  the operator and the reason.
--
--  ⚠️ AND NONE OF IT PREVENTS ANYTHING. A log is a record of what
--  happened, written after it happened. On the afternoon somebody has
--  two tabs open and the wrong workspace in the search box, the log
--  captures the mistake perfectly and forty-three people are still
--  locked out of their ERP.
--
--  🔴 THE ASYMMETRY IS THE ARGUMENT. Un-suspending takes one click.
--  Explaining to a customer why their staff could not work for twenty
--  minutes takes a relationship, and the log does not help with that
--  conversation at all.
--
--  ⭐ THIS FILE ADDS FIVE THINGS THE PANEL COULD NOT DO: hold a
--  dangerous action for a second pair of eyes, remember what an
--  entitlement looked like before it was changed, notice a customer in
--  trouble, put ceremony around access taken without consent, and tie a
--  bad hour together under one name.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① THE APPROVAL QUEUE
-- =====================================================================
--
--  🔴 A DANGEROUS ACTION IS NOT EXECUTED. IT IS PROPOSED.
--
--  ⚠️ THE QUEUE IS DELIBERATELY SHORT. A queue that fires on routine
--  work is a queue people learn to rubber-stamp, and a rubber-stamped
--  approval is worse than none at all because it looks like a control
--  in an audit. Provisioning, consented read-only impersonation and
--  overrides on trial workspaces all still execute immediately.
CREATE TABLE IF NOT EXISTS platform_approval_queue (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    action_kind         varchar(60) NOT NULL,
    target_type         varchar(40) NOT NULL,
    target_id           uuid,
    --  ⭐ The human name of the thing, frozen at request time. A queue
    --  row that says "suspend 3f2a..." is a row nobody can approve
    --  safely, and looking the name up later shows today's name rather
    --  than the one the requester saw.
    target_label        varchar(200) NOT NULL,

    --  What would change, for the approver to read.
    proposed_before     jsonb,
    proposed_after      jsonb NOT NULL DEFAULT '{}'::jsonb,
    --  The validated arguments, replayed verbatim on approval.
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,

    --  🔴 `platform_staff`, NOT `users`. An operator is not a member of
    --  any workspace; `PlatformOperator` carries a `clerkUserId` and a
    --  staff row and has no `users.id` at all. Pointing this at `users`
    --  compiled, and would have failed on the first real insert with a
    --  foreign key violation naming a table nobody expected.
    requested_by        uuid NOT NULL REFERENCES platform_staff(id) ON DELETE RESTRICT,
    requested_at        timestamptz NOT NULL DEFAULT now(),

    --  🔴 MANDATORY, AND TWENTY CHARACTERS IS NOT ARBITRARY. "fix" is
    --  not a reason. This field exists to be read six months later by
    --  somebody who was not in the room, and a field that accepts three
    --  characters is a field that receives three characters.
    justification       text NOT NULL,

    required_grade      varchar(20) NOT NULL,

    status              varchar(20) NOT NULL DEFAULT 'pending',
    approver_id         uuid REFERENCES platform_staff(id) ON DELETE SET NULL,
    decided_at          timestamptz,
    decision_note       text,

    --  ⚠️ REQUESTS EXPIRE. A queue with three-week-old items is a queue
    --  nobody reads, and somebody eventually approves a stale request
    --  whose context has entirely changed.
    expires_at          timestamptz NOT NULL,

    executed_at         timestamptz,
    execution_error     varchar(1000),

    CONSTRAINT platform_approval_status_known CHECK (
        status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')
    ),
    CONSTRAINT platform_approval_justification_real CHECK (
        length(btrim(justification)) >= 20
    ),
    CONSTRAINT platform_approval_decision_has_an_approver CHECK (
        status NOT IN ('approved', 'rejected') OR approver_id IS NOT NULL
    ),
    --  🔴🔴 THE REQUESTER MAY NOT BE THE APPROVER, AND THIS IS IN THE
    --  DATABASE RATHER THAN THE UI BECAUSE THE UI IS ONE ROUTE AMONG
    --  SEVERAL. A future API, a script, a support fix: all of them go
    --  through this constraint and none of them go through the screen.
    --
    --  ⭐ THE ONE EXCEPTION IS NAMED AND VISIBLE. See `self_approved`.
    CONSTRAINT platform_approval_not_self CHECK (
        approver_id IS NULL OR approver_id <> requested_by OR self_approved
    ),
    self_approved       boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS platform_approval_pending_idx
    ON platform_approval_queue (status, requested_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS platform_approval_target_idx
    ON platform_approval_queue (target_type, target_id, requested_at DESC);

--  ⭐⭐ THE SINGLE-OPERATOR ESCAPE HATCH, STATED HONESTLY RATHER THAN
--  HIDDEN.
--
--  ⚠️ Ordence has one operator today. A queue that cannot be cleared is
--  a queue that blocks the only person who can clear it, at midnight,
--  and the predictable response is to disable the whole mechanism.
--
--  🔴 SO SELF-APPROVAL IS PERMITTED AND COSTS FIFTEEN MINUTES. Not a
--  loophole: a speed bump with a name on it. It is flagged in the row,
--  it is flagged in the log, and it disappears from every screen the
--  day a second operator exists.
CREATE OR REPLACE FUNCTION ordence_guard_self_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  waited interval;
BEGIN
  IF NEW.status = 'approved' AND NEW.approver_id = NEW.requested_by THEN
    IF NOT NEW.self_approved THEN
      RAISE EXCEPTION
        'This request was made by the same operator who is approving it. That is allowed while Ordence has one operator, but it has to be recorded as a self-approval rather than passed off as a second pair of eyes.'
        USING ERRCODE = 'check_violation';
    END IF;

    waited := COALESCE(NEW.decided_at, now()) - NEW.requested_at;
    IF waited < interval '15 minutes' THEN
      RAISE EXCEPTION
        'A self-approval needs fifteen minutes between requesting and approving. % have passed. The wait is the entire control: it exists so the decision is made twice, by the same person, in two different moods.',
        justify_interval(waited)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_self_approval ON platform_approval_queue;
CREATE TRIGGER ordence_guard_self_approval
  BEFORE INSERT OR UPDATE ON platform_approval_queue
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_self_approval();

-- =====================================================================
--  ② WHAT AN ENTITLEMENT LOOKED LIKE BEFORE
-- =====================================================================
--
--  ⭐ THE TOGGLE HAS WORKED SINCE THE CONSOLE WAS BUILT. What it has
--  never had is a memory, and a change you cannot undo is a change
--  people hesitate over.
--
--  ⚠️ NOT DERIVED FROM THE ACTION LOG. The log holds a description
--  written for a human; this holds the exact prior value, shaped for
--  restoring. Reconstructing state from prose is how a revert applies
--  something nobody intended.
CREATE TABLE IF NOT EXISTS platform_entitlement_history (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    flag_key            varchar(120) NOT NULL,
    --  Null where the flag did not exist before. That is different from
    --  false, and collapsing them makes a revert create a row that was
    --  never there.
    before_enabled      boolean,
    after_enabled       boolean NOT NULL,

    changed_by          uuid REFERENCES platform_staff(id) ON DELETE SET NULL,
    changed_at          timestamptz NOT NULL DEFAULT now(),
    reason              text,

    --  ⭐ A REVERT IS A NEW ROW, NEVER A DELETION. The history of a
    --  workspace's configuration is evidence; editing it to make the
    --  present tidy destroys the only record of what a customer had
    --  when they complained.
    reverts_id          uuid REFERENCES platform_entitlement_history(id),

    --  🔴 DID IT ACTUALLY TAKE EFFECT? Written after a fresh read.
    --  A toggle that silently fails is worse than one that errors,
    --  because it produces a support ticket beginning "I enabled it".
    verified_at         timestamptz,
    verified_ok         boolean,
    verify_note         varchar(500)
);

CREATE INDEX IF NOT EXISTS platform_entitlement_history_tenant_idx
    ON platform_entitlement_history (tenant_id, changed_at DESC);

-- =====================================================================
--  ③ TENANT HEALTH
-- =====================================================================
--
--  🔴 THE EVENT ORDENCE MOST NEEDS AND HAS NEVER HAD: a customer who
--  provisioned and never came back.
--
--  ⚠️ That is churn which has already happened and nobody has been
--  told. Caught in week one it is a phone call. Caught in month three
--  it is a refund and a bad review.
CREATE TABLE IF NOT EXISTS tenant_health_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    rule_key            varchar(60) NOT NULL,
    severity            varchar(10) NOT NULL,
    --  What the rule saw, so the alert can argue for itself.
    evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,
    headline            varchar(300) NOT NULL,
    --  ⭐ THE NEXT STEP, FROZEN AT DETECTION TIME. An alert with no
    --  action is noise with a colour, and looking the advice up from
    --  today's rule table would show a sentence the person who raised it
    --  never saw.
    what_to_do          text NOT NULL DEFAULT '',

    detected_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    resolved_by         uuid REFERENCES platform_staff(id) ON DELETE SET NULL,
    --  ⚠️ MANDATORY ON RESOLVE. An alert dismissed without a note is an
    --  alert that will be raised again next week and dismissed again.
    resolution_note     text,

    CONSTRAINT tenant_health_severity_known CHECK (
        severity IN ('high', 'medium', 'low')
    ),
    CONSTRAINT tenant_health_resolution_is_explained CHECK (
        resolved_at IS NULL OR length(btrim(coalesce(resolution_note, ''))) >= 10
    )
);

--  ⭐ ONE OPEN EVENT PER RULE PER TENANT. Without this a nightly
--  evaluation raises the same "gone quiet" alert every night and the
--  dashboard becomes a wall of the same sentence.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_health_one_open_per_rule
    ON tenant_health_events (tenant_id, rule_key)
    WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS tenant_health_open_idx
    ON tenant_health_events (severity, detected_at DESC)
    WHERE resolved_at IS NULL;

-- =====================================================================
--  ④ BREAK-GLASS: THE PROCEDURE, NOT JUST THE MODE
-- =====================================================================
--
--  🔴 `break_glass` HAS EXISTED AS AN IMPERSONATION MODE WITH NO
--  CEREMONY AROUND IT. It is the one path that reads a customer's data
--  without their consent, and today it costs one capability check.
--
--  ⭐ FOUR OF THE FIVE CONTROLS BELOW ARE GATES. The fifth is a
--  CONSEQUENCE, and consequences are what make people think before
--  reaching for something.
ALTER TABLE platform_impersonation_sessions
    ADD COLUMN IF NOT EXISTS break_glass_reason text;

ALTER TABLE platform_impersonation_sessions
    ADD COLUMN IF NOT EXISTS post_incident_note text;

ALTER TABLE platform_impersonation_sessions
    ADD COLUMN IF NOT EXISTS post_incident_at timestamptz;

--  ⭐ WHO WROTE IT, WHICH IS NOT ALWAYS WHO WENT IN. An operator who
--  leaves the company still owes the note, and somebody else writing it
--  from the log is a legitimate outcome that must be visible as such
--  rather than indistinguishable from the operator writing it himself.
ALTER TABLE platform_impersonation_sessions
    ADD COLUMN IF NOT EXISTS post_incident_by uuid REFERENCES platform_staff(id) ON DELETE SET NULL;

COMMENT ON COLUMN platform_impersonation_sessions.post_incident_note IS
  'Required within 24 hours of a break-glass session. Until it is written the operator cannot start another one. This is the consequence rather than the gate, and it is the control that actually changes behaviour.';

--  ⚠️ THE INDEX THE BLOCK READS ON EVERY BREAK-GLASS ATTEMPT. Partial,
--  because the only rows it ever wants are the handful that owe a note.
CREATE INDEX IF NOT EXISTS platform_impersonation_note_debt_idx
    ON platform_impersonation_sessions (staff_id, expires_at)
    WHERE mode = 'break_glass' AND post_incident_note IS NULL;

--  ⚠️ FIFTY CHARACTERS, NOT TWENTY. Break-glass is rarer and more
--  serious than a queued action, and the note is the only thing the
--  customer will be shown about why their data was read.
DO $$ BEGIN
  ALTER TABLE platform_impersonation_sessions
    ADD CONSTRAINT platform_impersonation_break_glass_is_explained
    CHECK (mode <> 'break_glass' OR length(btrim(coalesce(break_glass_reason, ''))) >= 50);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
--  ⑤ INCIDENT MODE
-- =====================================================================
--
--  ⚠️ AT THREE IN THE MORNING NOBODY WRITES DOWN WHAT THEY DID. The
--  panel writing it down for them is the difference between a
--  post-mortem and an argument a week later about the order of events.
CREATE TABLE IF NOT EXISTS platform_incidents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reference           varchar(20) NOT NULL,
    title               varchar(200) NOT NULL,
    severity            varchar(10) NOT NULL,

    --  Null means every workspace. A filter rather than a list, because
    --  the affected set changes while an incident is open.
    affected_filter     jsonb,

    declared_by         uuid NOT NULL REFERENCES platform_staff(id) ON DELETE RESTRICT,
    declared_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    resolved_by         uuid REFERENCES platform_staff(id) ON DELETE SET NULL,

    summary             text,
    --  ⭐ Written after, from the tagged actions rather than from memory.
    postmortem          text,

    CONSTRAINT platform_incident_severity_known CHECK (
        severity IN ('sev1', 'sev2', 'sev3')
    ),
    CONSTRAINT platform_incident_resolution_has_a_summary CHECK (
        resolved_at IS NULL OR length(btrim(coalesce(summary, ''))) >= 20
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_incidents_reference_key
    ON platform_incidents (reference);

CREATE INDEX IF NOT EXISTS platform_incidents_open_idx
    ON platform_incidents (declared_at DESC) WHERE resolved_at IS NULL;

--  🔴 EVERY ACTION TAKEN WHILE AN INCIDENT IS OPEN IS TAGGED WITH IT.
--  This one column is what makes the post-mortem assemble itself.
ALTER TABLE platform_action_log
    ADD COLUMN IF NOT EXISTS incident_id uuid REFERENCES platform_incidents(id);

CREATE INDEX IF NOT EXISTS platform_action_log_incident_idx
    ON platform_action_log (incident_id, created_at)
    WHERE incident_id IS NOT NULL;

-- =====================================================================
--  ⑥ ROW LEVEL SECURITY ON THE TWO TABLES THAT CARRY A TENANT ID
-- =====================================================================
--
--  🔴🔴 I ARGUED MYSELF OUT OF THIS ONCE AND `check:sql` CAUGHT IT.
--
--  ⚠️ THE ARGUMENT I WROTE AT THE BOTTOM OF THIS FILE WAS: these are
--  platform tables, they are only ever reached through
--  `withPlatformScope`, which is already guarded by `requireCapability`,
--  so a tenant policy would be decoration. Every clause of that is true
--  and the conclusion is still wrong.
--
--  🔴 RLS THAT IS NOT ENABLED DOES NOT REFUSE ANYTHING. It is not a
--  policy that evaluates to false for a tenant session — it is no
--  policy at all, and Postgres returns every row. The protection I was
--  relying on is entirely in the application: one tenant-side query
--  that joins `tenant_health_events` for a plausible reason, and a
--  customer reads our private notes about which of their neighbours we
--  think is about to churn.
--
--  ⭐ "ONLY THE PLATFORM READS IT TODAY" IS A STATEMENT ABOUT TODAY'S
--  CODE. RLS is what makes it a statement about the database.
--
--  ⚠️ `app_platform_scope()` GOES IN `USING`, NEVER IN `WITH CHECK` —
--  the house rule the whole schema follows, and `0014` has a checker
--  that fails the deploy if any policy breaks it.
ALTER TABLE tenant_health_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_health_events        FORCE  ROW LEVEL SECURITY;
ALTER TABLE platform_entitlement_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_entitlement_history FORCE  ROW LEVEL SECURITY;

--  🔴 NOT `tenant_id = app_current_tenant_id() OR app_platform_scope()`,
--  which is the shape almost every other table uses. These rows are
--  what WE think about a customer, not what the customer owns. A
--  workspace reading its own churn assessment is the leak, not the
--  fix — so a tenant session sees nothing here at all.
DROP POLICY IF EXISTS tenant_health_events_platform_only ON tenant_health_events;
CREATE POLICY tenant_health_events_platform_only ON tenant_health_events
  USING      (app_platform_scope())
  WITH CHECK (app_current_tenant_id() IS NULL);

DROP POLICY IF EXISTS platform_entitlement_history_platform_only ON platform_entitlement_history;
CREATE POLICY platform_entitlement_history_platform_only ON platform_entitlement_history
  USING      (app_platform_scope())
  WITH CHECK (app_current_tenant_id() IS NULL);

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  NO AUTO-REMEDIATION ANYWHERE. No auto-suspend on payment failure, no
--  auto-throttle on a noisy workspace, no auto-disable of a failing
--  integration. Every one of those is an action taken on somebody's
--  business by nobody. The panel shows the problem and puts the fix one
--  click away; a person clicks it.
-- =====================================================================
