-- =====================================================================
--  ORDENCE 0060 — TASKS, THE UNIVERSAL TIMELINE, AND THE CALENDAR
--  v1.9.0-alpha · Front office, batch 1 and 2
-- =====================================================================
--
--  🔴🔴 WHAT WAS MISSING, AND IT WAS EVERYTHING A PERSON DOES
--
--  Ordence could record what a business IS: its invoices, its stock, its
--  matters, its units. It could not record what anybody DID about any of
--  it. There was no task table anywhere in fifty-nine migrations. No
--  follow-up, no assignment, no note against a customer, no "ring him
--  Tuesday".
--
--  ⚠️ THAT IS WHY THE SPREADSHEET SURVIVES. A system that holds the
--  ledger but not the follow-up leaves every human process outside it,
--  and once a process lives outside the system the data follows.
--
--  ⭐ THREE TABLES, AND THE ORDER MATTERS.
--
--    ① tasks       — what somebody has to do, and by when
--    ② activities  — what actually happened, append-only
--    ③ calendar_events — where somebody has to be
--
--  🔴 THEY ARE NOT THE SAME THING AND MERGING THEM IS THE COMMON
--     MISTAKE. A task can be done late. A meeting cannot. A note about
--     what happened is not something to do. Products that model all
--     three as one "activity" end up with a to-do list that contains
--     history and a calendar that contains wishes.
--
--  Depends on: core (tenants, users), crm (companies, contacts).
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① TASKS
-- =====================================================================

CREATE TABLE IF NOT EXISTS tasks (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    title               varchar(300) NOT NULL,
    detail              text,

    /**
     * ⭐ THE POLYMORPHIC LINK, AND IT IS DELIBERATE.
     *
     * A task hangs off a company, a contact, an invoice, a matter, a
     * unit, a consignment or nothing at all. Foreign keys to twenty
     * tables would mean twenty nullable columns and a check constraint
     * nobody could read.
     *
     * ⚠️ The cost is that the database cannot enforce that the subject
     * exists. That is accepted knowingly: the alternative is a task
     * table that has to be altered every time a module is added, which
     * is the thing that stops people creating tasks at all.
     *
     * 🔴 The subject TYPE is constrained even though the id is not,
     * because a free-text type is how you get "invoice", "Invoice" and
     * "sales_invoice" in the same column and a timeline that shows a
     * third of the history.
     */
    subject_type        varchar(40),
    subject_id          uuid,
    /** What to show when the subject is named. Denormalised on purpose. */
    subject_label       varchar(300),

    assigned_to         uuid REFERENCES users(id) ON DELETE SET NULL,
    /** Nullable: a task can be for the firm before it is for a person. */
    due_on              date,
    /** For something that has to happen at a time, not on a day. */
    due_at              timestamptz,

    priority            varchar(10) NOT NULL DEFAULT 'normal',
    status              varchar(20) NOT NULL DEFAULT 'open',

    /**
     * 🔴 A COMPLETED TASK MUST CARRY ITS EVIDENCE.
     * "Done" with nobody's name and no time on it is not a record of
     * anything. It is the checkbox somebody ticked to clear a screen.
     */
    completed_at        timestamptz,
    completed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    outcome             text,

    /**
     * ⚠️ A CANCELLED TASK SAYS WHY.
     * "Cancelled" with no reason is indistinguishable from "forgotten",
     * and the two need different conversations.
     */
    cancelled_reason    varchar(500),

    /**
     * ⭐ RECURRENCE, KEPT DELIBERATELY SIMPLE.
     * Every N days, optionally until a date. No cron expressions, no
     * "third Tuesday" rules. A monthly filing is 30 days and a quarterly
     * one is 90, and the compliance calendar already handles the cases
     * where the real rule is statutory.
     *
     * 🔴 THE NEXT ONE IS CREATED WHEN THIS ONE IS COMPLETED, not on a
     * schedule. A nightly job that generates recurrences produces a
     * backlog of forty identical tasks the first time it is left off.
     */
    repeat_every_days   integer,
    repeat_until        date,
    /** Set on the child, pointing at the task it came from. */
    recurred_from       uuid REFERENCES tasks(id) ON DELETE SET NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tasks_priority_known CHECK (
        priority IN ('low', 'normal', 'high', 'urgent')
    ),
    CONSTRAINT tasks_status_known CHECK (
        status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled')
    ),
    CONSTRAINT tasks_subject_type_known CHECK (
        subject_type IS NULL OR subject_type IN (
            'company', 'contact', 'deal', 'lead', 'sales_order',
            'sales_invoice', 'purchase_invoice', 'receipt', 'matter',
            'hearing', 'project', 'unit', 'booking', 'consignment',
            'stock_item', 'asset', 'licence', 'compliance_task',
            'campaign', 'other'
        )
    ),
    -- ⚠️ A subject type with no id, or an id with no type, is half a
    -- link and will never resolve on a screen.
    CONSTRAINT tasks_subject_is_whole CHECK (
        (subject_type IS NULL AND subject_id IS NULL)
        OR (subject_type IS NOT NULL AND subject_id IS NOT NULL)
    ),

    -- 🔴 THE CONSTRAINT THIS TABLE EXISTS FOR.
    CONSTRAINT tasks_done_is_evidenced CHECK (
        status <> 'done' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL)
    ),
    CONSTRAINT tasks_cancelled_is_explained CHECK (
        status <> 'cancelled' OR cancelled_reason IS NOT NULL
    ),
    -- ⚠️ An open task cannot carry a completion. That combination is a
    -- reopened task whose history was not cleared, and it makes every
    -- "completed this week" count wrong.
    CONSTRAINT tasks_open_is_not_completed CHECK (
        status IN ('done', 'cancelled') OR completed_at IS NULL
    ),
    CONSTRAINT tasks_repeat_is_positive CHECK (
        repeat_every_days IS NULL OR repeat_every_days > 0
    ),
    -- 🔴 A REPEATING TASK NEEDS A DATE TO REPEAT FROM. Without a due
    -- date there is nothing to add the interval to, and the recurrence
    -- silently never happens.
    CONSTRAINT tasks_repeat_needs_a_due_date CHECK (
        repeat_every_days IS NULL OR due_on IS NOT NULL
    ),
    CONSTRAINT tasks_repeat_until_is_later CHECK (
        repeat_until IS NULL OR due_on IS NULL OR repeat_until >= due_on
    ),
    -- ⚠️ due_at and due_on must agree where both are given, or two
    -- screens show two different days for the same task.
    CONSTRAINT tasks_due_times_agree CHECK (
        due_at IS NULL OR due_on IS NULL OR (due_at AT TIME ZONE 'Asia/Kolkata')::date = due_on
    )
);

-- ⭐ THE QUERY THE TABLE EXISTS FOR: what is on my desk, soonest first.
CREATE INDEX IF NOT EXISTS tasks_mine_idx
    ON tasks (tenant_id, assigned_to, due_on)
    WHERE status IN ('open', 'in_progress', 'blocked');
CREATE INDEX IF NOT EXISTS tasks_subject_idx
    ON tasks (tenant_id, subject_type, subject_id);
-- ⚠️ Unassigned open work. The list nobody looks at and everybody should.
CREATE INDEX IF NOT EXISTS tasks_unassigned_idx
    ON tasks (tenant_id, due_on)
    WHERE assigned_to IS NULL AND status IN ('open', 'in_progress', 'blocked');


--  🔴 THE TRIGGER THAT CREATES THE NEXT ONE.
--
--  ⭐ Fired on completion, not on a schedule. A recurring task that is
--  generated nightly produces forty identical rows the first time the
--  job is left off, and a person who sees forty stops reading the list.
--  Generated on completion, there is exactly one live instance at a
--  time, which is what a recurring obligation actually is.
CREATE OR REPLACE FUNCTION ordence_recur_task()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  next_due date;
BEGIN
  IF NEW.status <> 'done' OR OLD.status = 'done' THEN
    RETURN NEW;
  END IF;
  IF NEW.repeat_every_days IS NULL OR NEW.due_on IS NULL THEN
    RETURN NEW;
  END IF;

  next_due := NEW.due_on + NEW.repeat_every_days;

  IF NEW.repeat_until IS NOT NULL AND next_due > NEW.repeat_until THEN
    RETURN NEW;
  END IF;

  -- ⚠️ Guard against a duplicate. Completing the same task twice
  -- through two tabs would otherwise create two next instances.
  IF EXISTS (
    SELECT 1 FROM tasks
     WHERE tenant_id = NEW.tenant_id
       AND recurred_from = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO tasks (
    tenant_id, title, detail, subject_type, subject_id, subject_label,
    assigned_to, due_on, priority, status,
    repeat_every_days, repeat_until, recurred_from, created_by
  ) VALUES (
    NEW.tenant_id, NEW.title, NEW.detail, NEW.subject_type, NEW.subject_id,
    NEW.subject_label, NEW.assigned_to, next_due, NEW.priority, 'open',
    NEW.repeat_every_days, NEW.repeat_until, NEW.id, NEW.completed_by
  );

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_recur_task ON tasks;
CREATE TRIGGER trg_recur_task
  AFTER UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION ordence_recur_task();


-- =====================================================================
--  ② THE UNIVERSAL TIMELINE
-- =====================================================================
--  ⭐ ONE TABLE FOR "WHAT HAPPENED", ACROSS EVERY MODULE.
--
--  A call to a customer, a note on a matter, an email sent, a status
--  changed, a lead received from an outside platform, a message on
--  WhatsApp. Today those would be six tables and six screens, and the
--  question a person actually asks is "what has happened with this
--  customer", which none of the six can answer.
--
--  🔴🔴 AND IT IS APPEND-ONLY FOR ANYTHING THE SYSTEM WROTE.
--
--  ⚠️ A history that can be edited is not a history. A manual note can
--  be corrected, because a person typing at seven in the evening makes
--  typing mistakes and hiding that helps nobody. But a row the system or
--  an integration wrote is evidence, and the trigger below refuses to
--  let it be changed or deleted at all.

CREATE TABLE IF NOT EXISTS activities (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    subject_type        varchar(40) NOT NULL,
    subject_id          uuid NOT NULL,
    subject_label       varchar(300),

    kind                varchar(30) NOT NULL,
    /**
     * 🔴 WHEN IT HAPPENED, WHICH IS NOT WHEN IT WAS TYPED.
     * A call made on Tuesday and written up on Friday belongs on
     * Tuesday. Timelines that sort by created_at tell a story in the
     * wrong order and quietly make people look slower than they were.
     */
    occurred_at         timestamptz NOT NULL DEFAULT now(),

    /** inbound = they contacted us. outbound = we contacted them. */
    direction           varchar(10),

    summary             varchar(500) NOT NULL,
    body                text,

    /** Who did it. Null for something the system did by itself. */
    user_id             uuid REFERENCES users(id) ON DELETE SET NULL,

    /**
     * manual      — a person typed it
     * system      — Ordence recorded it
     * integration — it arrived from outside
     */
    source              varchar(20) NOT NULL DEFAULT 'manual',
    /** Which integration, where source is integration. */
    source_name         varchar(60),
    /** The outside system's own id, for duplicate control. */
    external_ref        varchar(200),

    task_id             uuid REFERENCES tasks(id) ON DELETE SET NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT activities_kind_known CHECK (
        kind IN ('note', 'call', 'email', 'meeting', 'whatsapp', 'sms',
                 'visit', 'status_change', 'document', 'payment',
                 'lead_received', 'campaign_send', 'system')
    ),
    CONSTRAINT activities_subject_type_known CHECK (
        subject_type IN (
            'company', 'contact', 'deal', 'lead', 'sales_order',
            'sales_invoice', 'purchase_invoice', 'receipt', 'matter',
            'hearing', 'project', 'unit', 'booking', 'consignment',
            'stock_item', 'asset', 'licence', 'compliance_task',
            'campaign', 'other'
        )
    ),
    CONSTRAINT activities_source_known CHECK (
        source IN ('manual', 'system', 'integration')
    ),
    CONSTRAINT activities_direction_known CHECK (
        direction IS NULL OR direction IN ('inbound', 'outbound')
    ),
    -- ⚠️ An integration row that does not say which integration cannot
    -- be traced back when the feed goes wrong.
    CONSTRAINT activities_integration_is_named CHECK (
        source <> 'integration' OR source_name IS NOT NULL
    ),
    -- 🔴 A CONTACT EVENT HAS A DIRECTION. "A call happened" with nobody
    -- knowing who rang whom is the note that starts an argument.
    CONSTRAINT activities_contact_has_direction CHECK (
        kind NOT IN ('call', 'email', 'whatsapp', 'sms', 'visit')
        OR direction IS NOT NULL
    )
);

-- ⭐ THE QUERY THE TABLE EXISTS FOR: this customer's whole history.
CREATE INDEX IF NOT EXISTS activities_subject_idx
    ON activities (tenant_id, subject_type, subject_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activities_recent_idx
    ON activities (tenant_id, occurred_at DESC);
-- ⚠️ Duplicate control for anything arriving from outside.
CREATE UNIQUE INDEX IF NOT EXISTS activities_external_unique
    ON activities (tenant_id, source_name, external_ref)
    WHERE external_ref IS NOT NULL;


--  🔴🔴 THE TRIGGER THAT MAKES HISTORY HISTORY.
CREATE OR REPLACE FUNCTION ordence_guard_activity_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source <> 'manual' THEN
      RAISE EXCEPTION
        'This is a % record of something that happened, not a note. It cannot be deleted. If it is wrong, add a correcting note beside it — a timeline somebody can prune is a timeline nobody can rely on.',
        OLD.source
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.source <> 'manual' THEN
    RAISE EXCEPTION
      'This % activity cannot be edited. It records what happened, and history that can be rewritten is not evidence of anything.',
      OLD.source
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⚠️ Even on a manual note, the subject and the time it happened are
  -- fixed. Moving a note onto a different customer, or onto a different
  -- day, turns a correction into a fabrication.
  IF NEW.subject_type IS DISTINCT FROM OLD.subject_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id THEN
    RAISE EXCEPTION
      'A note cannot be moved to a different record. Delete it and write it where it belongs, so the move is visible.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION
      'The time something happened cannot be changed after the fact. Correct the text if it was written up wrongly.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_activity_immutable ON activities;
CREATE TRIGGER trg_guard_activity_immutable
  BEFORE UPDATE OR DELETE ON activities
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_activity_immutable();


-- =====================================================================
--  ③ THE CALENDAR
-- =====================================================================
--  🔴 A MEETING IS NOT A TASK.
--
--  A task can be done late and the world carries on. A meeting at eleven
--  cannot be attended at four. Products that model both as one row end
--  up with a to-do list containing appointments and a calendar
--  containing wishes, and people stop trusting both.
--
--  ⚠️ AND THE CALENDAR SCREEN DOES NOT READ ONLY THIS TABLE. It merges
--  hearings, compliance due dates, licence expiries and payment
--  milestones, all of which already exist and are already dated. The
--  point of a calendar is that everything dated is on it.

CREATE TABLE IF NOT EXISTS calendar_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    title               varchar(300) NOT NULL,
    detail              text,
    location            varchar(300),

    starts_at           timestamptz NOT NULL,
    ends_at             timestamptz NOT NULL,
    /** ⭐ An all-day entry still has a start and end; it just displays flat. */
    all_day             boolean NOT NULL DEFAULT false,

    subject_type        varchar(40),
    subject_id          uuid,
    subject_label       varchar(300),

    organiser_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    kind                varchar(20) NOT NULL DEFAULT 'meeting',
    status              varchar(20) NOT NULL DEFAULT 'confirmed',
    cancelled_reason    varchar(500),

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT calendar_events_kind_known CHECK (
        kind IN ('meeting', 'call', 'site_visit', 'hearing', 'inspection',
                 'delivery', 'personal', 'other')
    ),
    CONSTRAINT calendar_events_status_known CHECK (
        status IN ('confirmed', 'tentative', 'cancelled')
    ),
    -- 🔴 AN EVENT THAT ENDS BEFORE IT STARTS IS A TYPED YEAR, AND IT
    -- ALWAYS LOOKS PLAUSIBLE ON A FORM.
    CONSTRAINT calendar_events_ends_after_start CHECK (ends_at > starts_at),
    CONSTRAINT calendar_events_cancelled_is_explained CHECK (
        status <> 'cancelled' OR cancelled_reason IS NOT NULL
    ),
    CONSTRAINT calendar_events_subject_is_whole CHECK (
        (subject_type IS NULL AND subject_id IS NULL)
        OR (subject_type IS NOT NULL AND subject_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS calendar_events_when_idx
    ON calendar_events (tenant_id, starts_at)
    WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS calendar_events_subject_idx
    ON calendar_events (tenant_id, subject_type, subject_id);


CREATE TABLE IF NOT EXISTS calendar_event_attendees (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_id            uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,

    /** One of these two. A colleague, or somebody outside. */
    user_id             uuid REFERENCES users(id) ON DELETE CASCADE,
    contact_id          uuid REFERENCES contacts(id) ON DELETE CASCADE,
    /** For somebody who is neither yet. */
    external_name       varchar(200),

    response            varchar(20) NOT NULL DEFAULT 'invited',

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT calendar_event_attendees_response_known CHECK (
        response IN ('invited', 'accepted', 'declined', 'tentative', 'attended', 'absent')
    ),
    -- ⚠️ AN ATTENDEE WHO IS NOBODY. A row with no user, no contact and
    -- no name is an invitation that will never reach a person.
    CONSTRAINT calendar_event_attendees_is_somebody CHECK (
        user_id IS NOT NULL OR contact_id IS NOT NULL OR external_name IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS calendar_event_attendees_event_idx
    ON calendar_event_attendees (tenant_id, event_id);
-- ⭐ My day. The only query a person runs on this table.
CREATE INDEX IF NOT EXISTS calendar_event_attendees_mine_idx
    ON calendar_event_attendees (tenant_id, user_id)
    WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_attendees_user_unique
    ON calendar_event_attendees (event_id, user_id)
    WHERE user_id IS NOT NULL;


--  ⚠️ A CANCELLED EVENT KEEPS ITS ATTENDEES.
--
--  🔴 Deleting the attendee rows when an event is cancelled is the
--  obvious tidy-up and it is wrong: the question afterwards is always
--  "who was supposed to be there", and by then the rows are gone. The
--  event is marked cancelled with a reason and everything else stays.
CREATE OR REPLACE FUNCTION ordence_guard_event_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION
      'A cancelled entry cannot be un-cancelled. People were told it was off. Create a new entry so the record shows both facts.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⚠️ Moving an event that has already happened rewrites the past.
  IF OLD.ends_at < now() AND NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    RAISE EXCEPTION
      'This entry is already in the past and cannot be moved. If it did not happen as recorded, cancel it with a reason or add a note to the record it belongs to.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_event_history ON calendar_events;
CREATE TRIGGER trg_guard_event_history
  BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_event_history();


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⭐ app_platform_scope() in USING, never in WITH CHECK.

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_tenant_isolation ON tasks;
CREATE POLICY tasks_tenant_isolation ON tasks
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS activities_tenant_isolation ON activities;
CREATE POLICY activities_tenant_isolation ON activities
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_events_tenant_isolation ON calendar_events;
CREATE POLICY calendar_events_tenant_isolation ON calendar_events
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE calendar_event_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_attendees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_event_attendees_tenant_isolation ON calendar_event_attendees;
CREATE POLICY calendar_event_attendees_tenant_isolation ON calendar_event_attendees
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
