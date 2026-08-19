-- =====================================================================
--  ORDENCE 0065 — LEAD INTAKE
--  v1.13.0-alpha · Front office, batch 7
-- =====================================================================
--
--  ⭐⭐ THE FRAME FROM 0064 NOW CARRIES SOMETHING.
--
--  IndiaMART, JustDial and Meta all produce the same thing: a person who
--  wants to buy, with a name, a number, and something they asked about.
--  Three transports, one outcome.
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴🔴 THE ENQUIRY THAT ARRIVES TWICE
--  ══════════════════════════════════════════════════════════════════════
--  IndiaMART pushes a lead the moment it happens AND answers for it on
--  the pull API. A customer running both — which is what we recommend,
--  because push is fast and pull is the safety net — receives every
--  enquiry twice by design.
--
--  ⚠️ AND IT RETRIES. "Leads will be retried at regular intervals until
--  successfully transferred." So a slow response, a deploy, a restart,
--  and the same enquiry arrives again an hour later.
--
--  🔴 SO PROVENANCE IS A UNIQUE INDEX ON THE LEAD, not a check the
--  application remembers to do. `UNIQUE_QUERY_ID` is IndiaMART's own
--  identifier for the enquiry and is the same on both routes, which is
--  precisely what makes it the right key.
--
--  ══════════════════════════════════════════════════════════════════════
--  ⚠️ WHICH IS A DIFFERENT QUESTION FROM "IS THIS THE SAME PERSON"
--  ══════════════════════════════════════════════════════════════════════
--  0061 built the second one and deliberately did NOT make it unique: a
--  genuine second enquiry from the same man six months later is a real
--  lead, and refusing it teaches the salesman to type a fake number.
--
--  ⭐ THE TWO MUST NOT BE CONFUSED.
--
--    `external_id`     THE SAME EVENT, delivered again. Refuse it.
--    `phone_digits`    THE SAME PERSON, enquiring again. Show it.
--
--  A product that treats the second as the first loses real business. A
--  product that treats the first as the second rings one man three times.
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴 AND A LEAD NOBODY COULD FILE IS STILL A LEAD
--  ══════════════════════════════════════════════════════════════════════
--  `lead_intake_failures` exists because the alternative is a lead that
--  arrived, could not be parsed, and vanished. The customer paid for that
--  enquiry. If the choice is between a row somebody has to look at and no
--  row at all, it is not a close call.
--
--  Depends on: 0061 (leads extensions, lead_sources), 0064 (connections).
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① WHERE A LEAD CAME FROM, EXACTLY
-- =====================================================================

--  ⭐ WHICH CONNECTION, not merely which channel. `lead_source_id` from
--  0061 already answers "IndiaMART"; this answers "the IndiaMART account
--  we know as Main", which is the one a person can act on.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS connection_id uuid
    REFERENCES connections(id) ON DELETE SET NULL;

--  🔴 THE SENDER'S OWN ID FOR THE ENQUIRY.
--
--  ⚠️ NOT OURS. A key we mint cannot answer "have we had this before",
--  because we mint a new one each time we are asked.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_id varchar(200);

--  ⭐ The delivery or run that produced it, so any lead can be traced
--  back to the exact bytes that arrived.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS intake_delivery_id uuid
    REFERENCES webhook_deliveries(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS intake_run_id uuid
    REFERENCES sync_runs(id) ON DELETE SET NULL;

--  ⚠️ WHAT THEY ACTUALLY SAID, kept verbatim.
--
--  🔴 Every connector has fields we do not map, and the one nobody
--  mapped is always the one the customer asks about. Keeping the
--  normalised record is not the same as keeping the enquiry.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS intake_payload jsonb;

-- 🔴🔴 THE SAME EVENT LANDS ONCE. This is the whole point of the file.
--
-- ⚠️ Scoped to the CONNECTION, not the tenant. Two IndiaMART accounts in
-- one company are two seller panels with two independent id sequences,
-- and colliding them would silently drop a real enquiry from the second.
CREATE UNIQUE INDEX IF NOT EXISTS leads_external_unique
    ON leads (connection_id, external_id)
    WHERE connection_id IS NOT NULL AND external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_connection_idx
    ON leads (tenant_id, connection_id, created_at DESC)
    WHERE connection_id IS NOT NULL;


-- =====================================================================
--  ② THE LEAD NOBODY COULD FILE
-- =====================================================================
--  🔴 A DELIVERY THAT ARRIVED AND COULD NOT BECOME A LEAD.
--
--  ⚠️ The customer paid for that enquiry. The choice is between a row
--  somebody has to look at and no row at all, and it is not close.
--
--  ⭐ AND IT IS SEPARATE FROM `webhook_deliveries` ON PURPOSE. That table
--  answers "did the bytes arrive", which is a developer's question. This
--  one answers "did a person get lost", which is the owner's.

CREATE TABLE IF NOT EXISTS lead_intake_failures (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id       uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

    delivery_id         uuid REFERENCES webhook_deliveries(id) ON DELETE SET NULL,
    run_id              uuid REFERENCES sync_runs(id) ON DELETE SET NULL,

    external_id         varchar(200),
    occurred_at         timestamptz NOT NULL DEFAULT now(),

    /**
     * 🔴 WHY, IN WORDS THE OWNER CAN ACT ON.
     *
     * ⚠️ "Validation error" is not a reason. "The enquiry arrived with
     * no phone number and no email address, so there is nobody to call"
     * is a reason, and it tells them to go and look in the IndiaMART
     * panel rather than ring us.
     */
    reason              varchar(500) NOT NULL,
    reason_code         varchar(60) NOT NULL,

    /** ⭐ Whatever arrived, redacted, so it can be filed by hand. */
    payload             jsonb,

    /**
     * ⚠️ RESOLVED BY A PERSON, and it records who. A failure list that
     * cannot be cleared is a list nobody opens twice.
     */
    resolved_at         timestamptz,
    resolved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    resolved_note       varchar(500),
    /** Where somebody filed it by hand after all. */
    resolved_lead_id    uuid REFERENCES leads(id) ON DELETE SET NULL,

    /** 🔴 DPDP again. A failed enquiry is still somebody's phone number. */
    purge_after         date NOT NULL,

    CONSTRAINT lead_intake_failures_reason_code_known CHECK (
        reason_code IN (
            'no_contact_details', 'unparseable', 'unknown_shape',
            'lead_fetch_failed', 'rejected_by_rules', 'internal_error'
        )
    ),
    -- ⚠️ A RESOLUTION SAYS WHO AND WHEN. Both, or neither.
    CONSTRAINT lead_intake_failures_resolution_is_whole CHECK (
        (resolved_at IS NULL AND resolved_by IS NULL)
        OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS lead_intake_failures_open_idx
    ON lead_intake_failures (tenant_id, occurred_at DESC)
    WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS lead_intake_failures_purge_idx
    ON lead_intake_failures (purge_after);


--  ⚠️ A FAILURE IS EVIDENCE TOO. It may be resolved and it may be
--  purged. It may not be quietly rewritten into something less alarming.
CREATE OR REPLACE FUNCTION ordence_guard_intake_failure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.purge_after > CURRENT_DATE THEN
      RAISE EXCEPTION
        'This intake failure is still inside its retention window. Resolve it rather than deleting it: the row is the record that somebody enquired and never got a call.'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION
      'What failed and why cannot be edited afterwards. Record how it was resolved instead.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⭐ Same rule as a delivery body: removable, never rewritable.
  IF NEW.payload IS DISTINCT FROM OLD.payload AND NEW.payload IS NOT NULL THEN
    RAISE EXCEPTION
      'A stored enquiry may be removed but not rewritten. It is the only copy of what the buyer actually sent.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⚠️ AND A RESOLUTION IS NOT UNDONE. Marking a lost enquiry unresolved
  -- again is how one gets counted twice in whatever report reads this.
  IF OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION
      'A resolved intake failure cannot be reopened. Record a new one if something else went wrong.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_intake_failure ON lead_intake_failures;
CREATE TRIGGER trg_guard_intake_failure
  BEFORE UPDATE OR DELETE ON lead_intake_failures
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_intake_failure();


-- =====================================================================
--  ③ THE SOURCE ROW A CONNECTION IMPLIES
-- =====================================================================
--  ⭐ 0061 built `lead_sources` and nothing has ever created one.
--
--  ⚠️ A lead arriving with `lead_source_id` NULL is a lead that does not
--  appear in "where does our business come from", which is the single
--  report this whole batch exists to make true. So a connection carries
--  the source it files under, and the intake refuses to guess.

ALTER TABLE connections ADD COLUMN IF NOT EXISTS lead_source_id uuid
    REFERENCES lead_sources(id) ON DELETE SET NULL;

--  ⭐ AND THE STAGE A NEW ENQUIRY LANDS ON.
--
--  ⚠️ NOT "the first stage by position". A tenant who reorders their
--  board would silently start filing new enquiries into whatever ended
--  up leftmost, which on a board that begins with "Contacted" means
--  every new lead is recorded as already contacted.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS intake_stage_id uuid
    REFERENCES pipeline_stages(id) ON DELETE SET NULL;

--  🔴 WHO PICKS IT UP. Null means nobody, and nobody is a real answer
--  that the screen shows rather than hides.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS intake_owner_id uuid
    REFERENCES users(id) ON DELETE SET NULL;

--  ⭐⭐ WHETHER TO RAISE A TASK FOR EVERY ENQUIRY.
--
--  🔴 DEFAULT TRUE, AND THAT IS THE POINT OF THE WHOLE BATCH. A lead in
--  a list nobody opens is a lead nobody rings. 0060 built tasks; this is
--  what makes an arriving enquiry turn into something on a person's day.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS intake_creates_task boolean
    NOT NULL DEFAULT true;

--  ⚠️ HOW LONG THEY HAVE. An enquiry answered within an hour is a
--  different business from one answered on Thursday.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS intake_task_due_minutes integer
    NOT NULL DEFAULT 60;

DO $$ BEGIN
    ALTER TABLE connections ADD CONSTRAINT connections_task_due_sane
        CHECK (intake_task_due_minutes BETWEEN 5 AND 10080);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⭐ app_platform_scope() in USING, never in WITH CHECK.

ALTER TABLE lead_intake_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intake_failures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_intake_failures_tenant_isolation ON lead_intake_failures;
CREATE POLICY lead_intake_failures_tenant_isolation ON lead_intake_failures
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
