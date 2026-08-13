-- =====================================================================
--  ORDENCE 0068 — ORDER RHYTHM AND THE EVENTS THAT FIRE AUTOMATIONS
--  v1.16.0-alpha · Front office, batch 10
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴🔴 THE AUTOMATION ENGINE HAS EXISTED SINCE v0.7x AND NO BUSINESS
--     EVENT HAS EVER REACHED IT
--  ══════════════════════════════════════════════════════════════════════
--  `workflows`, `workflow_versions`, `workflow_runs`, `workflow_run_steps`
--  and `workflow_tasks` are all built. There is an executor, a step
--  budget, loop prevention by watched fields, conditions, a run log and
--  a screen at `/automations`.
--
--  ⚠️ AND THE ONLY WAY TO START ONE IS `runWorkflowNow`, which is a
--  person pressing a button. `record_created` and `record_updated` are
--  in the trigger vocabulary and nothing in the application has ever
--  emitted one.
--
--  🔴 SO EVERY CUSTOMER'S AUTOMATIONS ARE MANUAL AUTOMATIONS, which is
--  a contradiction, and the screen quietly implies otherwise.
--
--  ⭐ THIS MIGRATION DOES NOT BUILD A SECOND AUTOMATION ENGINE. It
--  builds the events, and the first producer of them is the thing the
--  owner actually asked for: knowing which customer is about to order.
--
--  ══════════════════════════════════════════════════════════════════════
--  ⭐⭐ AND THE RHYTHM IS DERIVED, NEVER TYPED
--  ══════════════════════════════════════════════════════════════════════
--  `customer_rhythms` is a cache of an answer computed from order dates.
--  Nothing may edit it by hand.
--
--  🔴 A PREDICTION SOMEBODY CAN OVERRIDE IS A PREDICTION NOBODY CAN
--  TRUST, because six months later nothing says whether a given row came
--  from the arithmetic or from an optimistic salesman. The recompute
--  replaces it wholesale; there is no other write path.
--
--  ══════════════════════════════════════════════════════════════════════
--  ⚠️ AND A SIGNAL IS RAISED ONCE, NOT EVERY TIME THE JOB RUNS
--  ══════════════════════════════════════════════════════════════════════
--  🔴 A nightly job that re-raises "this customer is due" every night
--  for five nights produces five tasks, and the salesman turns the
--  feature off on the third day. The unique index is what makes the
--  feature survive contact with a scheduler.
--
--  Depends on: 0060 (tasks), 0027 (customers/orders), workflows.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① THE RHYTHM, DERIVED
-- =====================================================================

CREATE TABLE IF NOT EXISTS customer_rhythms (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    /** Who. Loose (kind, id) so this works for a contact or a company. */
    subject_type        varchar(40) NOT NULL,
    subject_id          uuid NOT NULL,
    subject_label       varchar(255),

    /**
     * 🔴 THE VERDICT, INCLUDING THE ONES THAT ARE REFUSALS.
     *   regular         — a usable rhythm
     *   irregular       — orders, but no rhythm worth acting on
     *   too_few_orders  — not enough history to say anything
     *   lapsed          — a rhythm that existed and has been abandoned
     *   one_off         — bought once, ever
     *
     * ⭐ THE REFUSALS ARE STORED, NOT DISCARDED. "We looked and there is
     * no pattern" is an answer, and a screen that shows only the
     * confident rows makes a business look like it has forty customers
     * when it has four hundred.
     */
    verdict             varchar(20) NOT NULL,

    order_count         integer NOT NULL DEFAULT 0,
    first_order_on      date,
    last_order_on       date,
    /** Median, never mean. One bulk order should not move this. */
    median_gap_days     integer,
    /** Median absolute deviation. The robust spread. */
    mad_days            integer,

    expected_next_on    date,
    window_days         integer,
    /** 0..100, and deliberately hard to get high. */
    confidence          integer NOT NULL DEFAULT 0,
    /** steady · slowing · quickening · unknown */
    drift               varchar(20) NOT NULL DEFAULT 'unknown',

    /**
     * ⭐ THE SENTENCE, STORED. A salesman reads this, not the numbers,
     * and storing it means the screen and any message that quotes it
     * cannot drift apart.
     */
    explanation         varchar(1000) NOT NULL,

    computed_at         timestamptz NOT NULL DEFAULT now(),
    /** ⚠️ What it was computed from, so a stale row is visible. */
    computed_through_on date,

    CONSTRAINT customer_rhythms_verdict_known CHECK (
        verdict IN ('regular', 'irregular', 'too_few_orders', 'lapsed', 'one_off')
    ),
    CONSTRAINT customer_rhythms_drift_known CHECK (
        drift IN ('steady', 'slowing', 'quickening', 'unknown')
    ),
    CONSTRAINT customer_rhythms_confidence_bounded CHECK (
        confidence BETWEEN 0 AND 100
    ),
    CONSTRAINT customer_rhythms_counts_non_negative CHECK (
        order_count >= 0
        AND (median_gap_days IS NULL OR median_gap_days > 0)
        AND (mad_days IS NULL OR mad_days >= 0)
    ),
    -- 🔴 ONLY A `regular` RHYTHM MAY NAME A DATE.
    --
    -- ⚠️ This is the constraint that stops the feature lying. Every
    -- prediction product drifts towards showing a date for everybody,
    -- because a list with dates looks more finished than a list with
    -- "we do not know" on half the rows.
    CONSTRAINT customer_rhythms_only_regular_predicts CHECK (
        verdict = 'regular' OR expected_next_on IS NULL
    ),
    -- ⚠️ And a prediction carries its own window. A date with no honest
    -- width is a false promise.
    CONSTRAINT customer_rhythms_prediction_has_a_window CHECK (
        expected_next_on IS NULL OR window_days IS NOT NULL
    ),
    -- ⭐ A rhythm needs the history it claims to be built on.
    CONSTRAINT customer_rhythms_regular_has_history CHECK (
        verdict <> 'regular' OR (order_count >= 4 AND median_gap_days IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_rhythms_unique
    ON customer_rhythms (tenant_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS customer_rhythms_due_idx
    ON customer_rhythms (tenant_id, expected_next_on)
    WHERE verdict = 'regular';
-- ⭐ The query that matters most: who has stopped.
CREATE INDEX IF NOT EXISTS customer_rhythms_lapsed_idx
    ON customer_rhythms (tenant_id, last_order_on)
    WHERE verdict = 'lapsed';


--  🔴🔴 A DERIVED ROW MAY NOT BE EDITED BY HAND.
--
--  ⚠️ A prediction somebody can override is a prediction nobody can
--  trust: six months later nothing says whether a row came from the
--  arithmetic or from an optimistic salesman. The recompute replaces the
--  row wholesale, and there is no other write path.
CREATE OR REPLACE FUNCTION ordence_guard_rhythm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- ⭐ A recompute is an UPDATE that moves `computed_at` forward. Any
  -- other update is a person editing a derived figure.
  IF NEW.computed_at IS NOT DISTINCT FROM OLD.computed_at THEN
    RAISE EXCEPTION
      'This row is worked out from the order history and cannot be edited. A prediction somebody can overrule is a prediction nobody can trust, because afterwards nothing says which rows were arithmetic and which were opinion.'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_rhythm ON customer_rhythms;
CREATE TRIGGER trg_guard_rhythm
  BEFORE UPDATE ON customer_rhythms
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_rhythm();


-- =====================================================================
--  ② THE SIGNAL, RAISED ONCE
-- =====================================================================
--  🔴 A NIGHTLY JOB THAT RE-RAISES "THIS CUSTOMER IS DUE" EVERY NIGHT
--  FOR FIVE NIGHTS PRODUCES FIVE TASKS, and the salesman turns the
--  feature off on the third day.

CREATE TABLE IF NOT EXISTS rhythm_signals (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    subject_type        varchar(40) NOT NULL,
    subject_id          uuid NOT NULL,
    subject_label       varchar(255),

    /** due_now · due_soon · overdue · lapsed */
    kind                varchar(20) NOT NULL,
    /** ⭐ The occurrence this signal belongs to. See the unique index. */
    occurrence          varchar(40) NOT NULL,

    due_on              date NOT NULL,
    confidence          integer NOT NULL DEFAULT 0,
    headline            varchar(300) NOT NULL,
    detail              varchar(1000) NOT NULL,

    raised_at           timestamptz NOT NULL DEFAULT now(),
    /** The task this produced, where one was raised. */
    task_id             uuid REFERENCES tasks(id) ON DELETE SET NULL,

    /**
     * ⭐⭐ WHAT HAPPENED NEXT, WHICH IS THE ONLY WAY TO KNOW IF ANY OF
     * THIS WORKS.
     *
     * 🔴 A prediction feature nobody scores is astrology. If the
     * customer ordered within their window the signal was right; if
     * nothing happened it was not, and a business deserves to know which
     * before it trusts the list.
     */
    outcome             varchar(20),
    outcome_at          timestamptz,
    /** The order that vindicated it, where there was one. */
    outcome_order_id    uuid,

    CONSTRAINT rhythm_signals_kind_known CHECK (
        kind IN ('due_now', 'due_soon', 'overdue', 'lapsed')
    ),
    CONSTRAINT rhythm_signals_outcome_known CHECK (
        outcome IS NULL OR outcome IN ('ordered', 'no_order', 'dismissed')
    ),
    CONSTRAINT rhythm_signals_outcome_is_dated CHECK (
        (outcome IS NULL AND outcome_at IS NULL)
        OR (outcome IS NOT NULL AND outcome_at IS NOT NULL)
    ),
    CONSTRAINT rhythm_signals_confidence_bounded CHECK (
        confidence BETWEEN 0 AND 100
    )
);

-- 🔴🔴 ONE SIGNAL PER CUSTOMER PER KIND PER OCCURRENCE.
--
-- ⚠️ `occurrence` is the expected date for a due signal and the month
-- for a lapsed one, so a nightly job re-raising the same thing collides
-- here rather than making a fifth task.
CREATE UNIQUE INDEX IF NOT EXISTS rhythm_signals_once
    ON rhythm_signals (tenant_id, subject_type, subject_id, kind, occurrence);

CREATE INDEX IF NOT EXISTS rhythm_signals_open_idx
    ON rhythm_signals (tenant_id, due_on)
    WHERE outcome IS NULL;


--  ⚠️ A SIGNAL IS EVIDENCE OF WHAT WE PREDICTED, so what we predicted
--  cannot be edited after the fact. Only the outcome may be written.
CREATE OR REPLACE FUNCTION ordence_guard_signal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.due_on IS DISTINCT FROM OLD.due_on
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.headline IS DISTINCT FROM OLD.headline
     OR NEW.raised_at IS DISTINCT FROM OLD.raised_at THEN
    RAISE EXCEPTION
      'What was predicted, when, and how confidently cannot be changed afterwards. Scoring a prediction against a record somebody edited afterwards measures nothing.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 🔴 AND AN OUTCOME IS RECORDED ONCE. Re-scoring the same prediction
  -- until it looks right is the oldest trick there is.
  IF OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    RAISE EXCEPTION
      'This prediction has already been scored. It cannot be scored again.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_signal ON rhythm_signals;
CREATE TRIGGER trg_guard_signal
  BEFORE UPDATE ON rhythm_signals
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_signal();


-- =====================================================================
--  ③ THE EVENT THE AUTOMATION ENGINE HAS BEEN WAITING FOR
-- =====================================================================
--  ⭐⭐ NOT A SECOND ENGINE. A queue of business events that the
--  existing executor can be pointed at.
--
--  🔴 KEPT AS A TABLE RATHER THAN A DIRECT CALL, deliberately. A trigger
--  that invoked a workflow inline would run somebody's HTTP step inside
--  the transaction that created an invoice, and a slow endpoint would
--  then hold a lock on the ledger. The event is written; the runner
--  picks it up afterwards.

CREATE TABLE IF NOT EXISTS automation_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    /** Matches the workflow trigger vocabulary. */
    trigger_type        varchar(30) NOT NULL,
    record_type         varchar(40) NOT NULL,
    record_id           uuid NOT NULL,

    /** ⭐ Which fields changed, for the watch-field loop prevention. */
    changed_fields      text[],

    /** Small, and never the whole record. See below. */
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,

    occurred_at         timestamptz NOT NULL DEFAULT now(),
    /**
     * ⚠️ NULL UNTIL THE RUNNER HAS DEALT WITH IT. The index below is the
     * runner's only query.
     */
    processed_at        timestamptz,
    /** How many workflows this event actually started. Zero is common. */
    runs_started        integer NOT NULL DEFAULT 0,
    error_message       varchar(500),

    /** 🔴 DPDP again: an event carries somebody's data. */
    purge_after         date NOT NULL,

    CONSTRAINT automation_events_trigger_known CHECK (
        trigger_type IN ('record_created', 'record_updated', 'record_deleted', 'webhook')
    ),
    CONSTRAINT automation_events_runs_non_negative CHECK (runs_started >= 0)
);

CREATE INDEX IF NOT EXISTS automation_events_pending_idx
    ON automation_events (tenant_id, occurred_at)
    WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS automation_events_record_idx
    ON automation_events (tenant_id, record_type, record_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS automation_events_purge_idx
    ON automation_events (purge_after);


--  🔴🔴 THE LOOP BRAKE, IN THE DATABASE.
--
--  ⚠️ Workflow A updates a lead. That raises `record_updated`. Workflow
--  A watches leads. It runs again. `watchFields` in the program is the
--  first defence and it is the right one, but it depends on the author
--  scoping their trigger, and the author who did not is exactly the
--  author who needs the brake.
--
--  ⭐ SO A RECORD MAY NOT PRODUCE MORE THAN A FIXED NUMBER OF EVENTS IN
--  A MINUTE. Beyond that the event is refused, loudly, naming the record.
--  A runaway loop then costs a rejected insert rather than a night of
--  workflow runs and a very large bill for whatever they call.
CREATE OR REPLACE FUNCTION ordence_guard_automation_storm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_recent integer;
BEGIN
  SELECT count(*) INTO v_recent
    FROM automation_events
   WHERE tenant_id = NEW.tenant_id
     AND record_type = NEW.record_type
     AND record_id = NEW.record_id
     AND occurred_at > now() - interval '1 minute';

  IF v_recent >= 20 THEN
    RAISE EXCEPTION
      'The record % of type % has produced 20 automation events in the last minute. That is a loop, not a business process: something is updating a record that triggers a workflow that updates the record. Scope the trigger to the fields it cares about.',
      NEW.record_id, NEW.record_type
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_automation_storm ON automation_events;
CREATE TRIGGER trg_guard_automation_storm
  BEFORE INSERT ON automation_events
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_automation_storm();


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⭐ app_platform_scope() in USING, never in WITH CHECK.

ALTER TABLE customer_rhythms ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_rhythms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_rhythms_tenant_isolation ON customer_rhythms;
CREATE POLICY customer_rhythms_tenant_isolation ON customer_rhythms
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE rhythm_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhythm_signals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rhythm_signals_tenant_isolation ON rhythm_signals;
CREATE POLICY rhythm_signals_tenant_isolation ON rhythm_signals
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE automation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_events_tenant_isolation ON automation_events;
CREATE POLICY automation_events_tenant_isolation ON automation_events
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
