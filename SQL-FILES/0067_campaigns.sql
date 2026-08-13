-- =====================================================================
--  ORDENCE 0067 — CAMPAIGNS
--  v1.15.0-alpha · Front office, batch 9
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴🔴 THE AUDIENCE IS FROZEN AT APPROVAL. IT IS NOT A SAVED FILTER.
--  ══════════════════════════════════════════════════════════════════════
--  Every marketing tool ever built stores the FILTER and re-runs it when
--  the send starts. "Customers in Pune who bought in the last year."
--
--  ⚠️ THE LIST THAT GOES OUT IS THEREFORE NOT THE LIST THAT WAS
--  APPROVED. Somebody enquires in the twenty minutes between approval and
--  send, matches the filter, and receives a campaign nobody ever decided
--  to send them. The count on the approval screen said 6,000 and 6,140
--  messages went.
--
--  🔴 AND IT IS WORSE THAN A COUNTING ERROR. The person who approved it
--  approved a specific number of messages at a specific cost, and this
--  is the one place in the system where being wrong spends money that
--  cannot be got back.
--
--  ⭐ SO APPROVAL WRITES ROWS. `campaign_recipients` is the audience,
--  one row per person, resolved once. The filter that produced it is
--  kept as evidence of how it was built, and is never re-run.
--
--  ══════════════════════════════════════════════════════════════════════
--  ⚠️ AND EVERY EXCLUSION IS A ROW TOO
--  ══════════════════════════════════════════════════════════════════════
--  A list of 9,000 that becomes 6,000 is a list where 3,000 people were
--  dropped for reasons nobody saw. Some of those reasons are "they
--  withdrew consent", which is correct. Some are "no mobile number",
--  which is a data problem worth fixing. Some are "already sent this
--  week", which is a decision somebody may disagree with.
--
--  🔴 A SILENT EXCLUSION IS HOW A FIRM DISCOVERS IT HAS BEEN MAILING
--  6,000 PEOPLE INSTEAD OF 9,000 FOR A YEAR. The excluded rows are
--  written with their reason and shown before approval, not after.
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴 THE STOP BUTTON HAS TO WORK MID-SEND
--  ══════════════════════════════════════════════════════════════════════
--  A campaign to ten thousand people takes minutes. The moment somebody
--  realises the wording is wrong is usually about ninety seconds in.
--
--  ⚠️ A CANCEL FLAG THE RUNNER READS ONCE AT THE START IS NOT A STOP
--  BUTTON. It is checked per message, in the database, by the same
--  trigger that enforces the ceiling.
--
--  Depends on: 0066 (message_sends, templates), 0061 (consent).
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① THE CAMPAIGN
-- =====================================================================

CREATE TABLE IF NOT EXISTS campaigns (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id       uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    template_id         uuid REFERENCES message_templates(id) ON DELETE SET NULL,

    name                varchar(200) NOT NULL,
    /** Why this is going out. Shown on the approval screen. */
    purpose             varchar(500),

    /**
     * 🔴 THE STATE, AND THE ONLY LEGAL PATH THROUGH IT.
     *   draft      — being built, audience not resolved
     *   review     — audience frozen, waiting for a person
     *   approved   — a person accepted the count and the cost
     *   sending    — in flight
     *   sent       — finished
     *   stopped    — a person stopped it mid-flight
     *   cancelled  — abandoned before it went
     */
    status              varchar(20) NOT NULL DEFAULT 'draft',

    /**
     * ⭐ THE FILTER, KEPT AS EVIDENCE OF HOW THE LIST WAS BUILT AND
     * NEVER RE-RUN.
     *
     * ⚠️ This is the whole point of the file. See the header.
     */
    audience_filter     jsonb NOT NULL DEFAULT '{}'::jsonb,
    audience_resolved_at timestamptz,

    /* ── what was approved ───────────────────────────────────────── */
    /**
     * 🔴 THE NUMBERS AS THEY STOOD WHEN A PERSON SAID YES. Frozen. If
     * the audience is rebuilt afterwards the campaign returns to review,
     * because the approval was for these figures and not for whatever
     * they became.
     */
    approved_recipients integer,
    approved_cost_minor bigint,
    approved_at         timestamptz,
    approved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    /**
     * ⚠️ THE AMOUNT, TYPED BY THE PERSON APPROVING.
     *
     * ⭐ Not a checkbox. The same reasoning the tenant-suspension screen
     * already uses for a typed slug: an amount somebody had to read and
     * copy is an amount somebody read.
     */
    approved_amount_typed varchar(40),

    /* ── the stop button ─────────────────────────────────────────── */
    /**
     * 🔴 CHECKED PER MESSAGE, IN THE DATABASE. A flag the runner reads
     * once at the start is not a stop button.
     */
    stop_requested_at   timestamptz,
    stop_requested_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    stop_reason         varchar(500),

    started_at          timestamptz,
    finished_at         timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT campaigns_status_known CHECK (
        status IN ('draft', 'review', 'approved', 'sending', 'sent', 'stopped', 'cancelled')
    ),
    -- 🔴 AN APPROVAL IS WHOLE OR IT IS NOT AN APPROVAL. Who, when, what
    -- count, what cost, and the amount they typed. All five or none.
    CONSTRAINT campaigns_approval_is_whole CHECK (
        status NOT IN ('approved', 'sending', 'sent', 'stopped')
        OR (approved_at IS NOT NULL
            AND approved_by IS NOT NULL
            AND approved_recipients IS NOT NULL
            AND approved_cost_minor IS NOT NULL
            AND approved_amount_typed IS NOT NULL)
    ),
    -- ⚠️ A stopped campaign says who stopped it and why. "It stopped" is
    -- not an answer anybody can give afterwards.
    CONSTRAINT campaigns_stop_is_explained CHECK (
        status <> 'stopped'
        OR (stop_requested_at IS NOT NULL
            AND stop_requested_by IS NOT NULL
            AND stop_reason IS NOT NULL)
    ),
    -- ⭐ Nothing may be approved without an audience that was actually
    -- resolved. Approving a filter is approving a guess.
    CONSTRAINT campaigns_approved_has_an_audience CHECK (
        status IN ('draft', 'review', 'cancelled') OR audience_resolved_at IS NOT NULL
    ),
    CONSTRAINT campaigns_counts_non_negative CHECK (
        (approved_recipients IS NULL OR approved_recipients >= 0)
        AND (approved_cost_minor IS NULL OR approved_cost_minor >= 0)
    )
);

CREATE INDEX IF NOT EXISTS campaigns_tenant_idx
    ON campaigns (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_live_idx
    ON campaigns (tenant_id, status)
    WHERE status IN ('review', 'approved', 'sending');


-- =====================================================================
--  ② THE AUDIENCE, AS ROWS
-- =====================================================================
--  🔴🔴 THIS TABLE IS THE POINT OF THE MIGRATION.
--
--  ⚠️ Both the people who will receive it AND the people who will not,
--  because a list that shrinks silently is a list nobody can check.

CREATE TABLE IF NOT EXISTS campaign_recipients (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id         uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,

    /** Who, in the vocabulary the rest of the system uses. */
    subject_type        varchar(40) NOT NULL,
    subject_id          uuid NOT NULL,
    /** ⭐ Frozen at resolution. The name may change; this is who it went to. */
    display_name        varchar(255),
    phone_digits        varchar(15),

    /**
     * 🔴 INCLUDED OR EXCLUDED, DECIDED ONCE.
     *
     * ⚠️ An excluded row is not a deletion. It is the answer to "why did
     * only 6,000 of my 9,000 customers get this", and that question is
     * asked after the send, when the filter can no longer be re-run.
     */
    is_included         boolean NOT NULL,
    /** Mirrors the refusal codes in `lib/messaging/gate.ts`. */
    exclusion_code      varchar(40),
    exclusion_reason    varchar(500),

    /** ⭐ Whether their free window was open when the list was built. */
    inside_service_window boolean NOT NULL DEFAULT false,
    /** What this one was expected to cost. Estimated, never billed. */
    estimated_cost_minor bigint NOT NULL DEFAULT 0,

    /* ── what actually happened ──────────────────────────────────── */
    message_send_id     uuid REFERENCES message_sends(id) ON DELETE SET NULL,
    /** queued · sent · skipped · failed. Null until the run reaches them. */
    send_outcome        varchar(20),
    send_error          varchar(500),
    processed_at        timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),

    -- 🔴 AN EXCLUSION SAYS WHY. Without this the table answers nothing.
    CONSTRAINT campaign_recipients_exclusion_is_explained CHECK (
        is_included OR (exclusion_code IS NOT NULL AND exclusion_reason IS NOT NULL)
    ),
    -- ⚠️ AND AN INCLUDED PERSON HAS A NUMBER TO SEND TO.
    CONSTRAINT campaign_recipients_included_has_a_number CHECK (
        NOT is_included OR phone_digits IS NOT NULL
    ),
    CONSTRAINT campaign_recipients_outcome_known CHECK (
        send_outcome IS NULL
        OR send_outcome IN ('queued', 'sent', 'skipped', 'failed')
    ),
    -- ⭐ AND AN EXCLUDED PERSON IS NEVER SENT TO. The database says so as
    -- well as the runner, because this is the mistake that costs money
    -- and reputation at the same time.
    CONSTRAINT campaign_recipients_excluded_are_not_sent CHECK (
        is_included OR message_send_id IS NULL
    )
);

-- 🔴 ONE ROW PER PERSON PER CAMPAIGN. The same customer appearing twice
-- in a resolved audience is two messages and one complaint.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_unique
    ON campaign_recipients (campaign_id, subject_type, subject_id);

CREATE INDEX IF NOT EXISTS campaign_recipients_pending_idx
    ON campaign_recipients (campaign_id, id)
    WHERE is_included AND send_outcome IS NULL;
CREATE INDEX IF NOT EXISTS campaign_recipients_excluded_idx
    ON campaign_recipients (campaign_id, exclusion_code)
    WHERE NOT is_included;


--  ⭐⭐ THE AUDIENCE IS FROZEN THE MOMENT IT IS APPROVED.
--
--  🔴 Adding, removing or editing a recipient after approval would make
--  the approved count a lie, and the approved count is what somebody
--  read the money off.
CREATE OR REPLACE FUNCTION ordence_guard_campaign_audience()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM campaigns
   WHERE id = COALESCE(NEW.campaign_id, OLD.campaign_id);

  -- ⭐ The run writes the outcome onto the row, which is the one change
  -- permitted after approval.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.subject_id IS DISTINCT FROM OLD.subject_id
       OR NEW.is_included IS DISTINCT FROM OLD.is_included
       OR NEW.phone_digits IS DISTINCT FROM OLD.phone_digits
       OR NEW.estimated_cost_minor IS DISTINCT FROM OLD.estimated_cost_minor THEN
      IF v_status <> 'draft' THEN
        RAISE EXCEPTION
          'The audience was frozen when this campaign was approved. Who is in it, who is out and what it costs cannot change afterwards, because those are the figures somebody approved. Rebuild the audience instead, which returns the campaign to review.'
          USING ERRCODE = 'raise_exception';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION
        'A resolved audience cannot be edited. The excluded rows are the answer to "why did only some of my customers get this", and that is asked after the send.'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT
  IF v_status NOT IN ('draft', 'review') THEN
    RAISE EXCEPTION
      'Nobody may be added to a campaign that has already been approved. The approval was for a specific number of people at a specific cost.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_campaign_audience ON campaign_recipients;
CREATE TRIGGER trg_guard_campaign_audience
  BEFORE INSERT OR UPDATE OR DELETE ON campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_campaign_audience();


-- =====================================================================
--  ③ THE APPROVAL, AND THE STOP
-- =====================================================================

CREATE OR REPLACE FUNCTION ordence_guard_campaign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_included integer;
  v_cost     bigint;
BEGIN
  -- 🔴🔴 THE APPROVED FIGURES MUST MATCH THE AUDIENCE THAT EXISTS.
  --
  -- ⚠️ Not "roughly". The whole reason the audience is rows rather than
  -- a filter is so that this comparison is possible at all, and a
  -- product that resolves a list and then approves a different number
  -- has simply moved the bug one table along.
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    SELECT count(*), COALESCE(sum(estimated_cost_minor), 0)
      INTO v_included, v_cost
      FROM campaign_recipients
     WHERE campaign_id = NEW.id AND is_included;

    IF NEW.approved_recipients <> v_included THEN
      RAISE EXCEPTION
        'This approval says % recipients and the resolved audience holds %. Approve the list that exists, or rebuild it.',
        NEW.approved_recipients, v_included
        USING ERRCODE = 'raise_exception';
    END IF;

    IF NEW.approved_cost_minor <> v_cost THEN
      RAISE EXCEPTION
        'This approval says a cost that does not match the resolved audience. The figure somebody read is the figure that has to be approved.'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  -- ⚠️ A CAMPAIGN THAT HAS GONE OUT CANNOT BE UN-APPROVED. The messages
  -- have left; changing the record afterwards makes the audit trail say
  -- nobody authorised them.
  IF OLD.status IN ('sending', 'sent', 'stopped')
     AND NEW.status IN ('draft', 'review') THEN
    RAISE EXCEPTION
      'This campaign has already started sending. It cannot be returned to draft, because the messages that went out were sent on somebody''s authority and the record has to keep saying so.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 🔴 AND THE APPROVAL CANNOT BE EDITED AFTER THE FACT.
  IF OLD.approved_at IS NOT NULL
     AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
          OR NEW.approved_recipients IS DISTINCT FROM OLD.approved_recipients
          OR NEW.approved_cost_minor IS DISTINCT FROM OLD.approved_cost_minor)
     AND NEW.status <> 'review' THEN
    RAISE EXCEPTION
      'Who approved this, for how many people and at what cost cannot be changed afterwards.'
      USING ERRCODE = 'raise_exception';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_campaign ON campaigns;
CREATE TRIGGER trg_guard_campaign
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_campaign();


--  🔴🔴 THE STOP BUTTON, ENFORCED ON EVERY SINGLE MESSAGE.
--
--  ⚠️ A campaign to ten thousand people takes minutes, and the moment
--  somebody notices the wording is wrong is about ninety seconds in. A
--  flag the runner reads once at the start is not a stop button.
--
--  ⭐ SO IT IS A TRIGGER ON THE SEND ITSELF, beside the spend ceiling
--  from 0066, for exactly the same reason: a rule enforced by the code
--  that sends is a rule the next code path forgets.
CREATE OR REPLACE FUNCTION ordence_enforce_campaign_stop()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status  text;
  v_stopped timestamptz;
BEGIN
  IF NEW.subject_type <> 'campaign' OR NEW.subject_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'refused' THEN
    RETURN NEW;
  END IF;

  SELECT status, stop_requested_at
    INTO v_status, v_stopped
    FROM campaigns WHERE id = NEW.subject_id;

  IF v_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_stopped IS NOT NULL THEN
    RAISE EXCEPTION
      'This campaign was stopped. Nothing further goes out, including messages already prepared.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⭐ AND A CAMPAIGN THAT WAS NEVER APPROVED SENDS NOTHING, whatever
  -- the calling code believes.
  IF v_status NOT IN ('approved', 'sending') THEN
    RAISE EXCEPTION
      'This campaign is %, not approved. Marketing messages are not sent from a campaign nobody has authorised.', v_status
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_campaign_stop ON message_sends;
CREATE TRIGGER trg_enforce_campaign_stop
  BEFORE INSERT ON message_sends
  FOR EACH ROW EXECUTE FUNCTION ordence_enforce_campaign_stop();


-- =====================================================================
--  ④ WHAT HAPPENED
-- =====================================================================
--  ⭐ THE ONE VIEW SOMEBODY OPENS AFTERWARDS, and the number it leads
--  with is not "messages sent".

CREATE OR REPLACE VIEW v_campaign_outcome
WITH (security_invoker = true) AS
SELECT
    c.tenant_id,
    c.id                                                        AS campaign_id,
    c.name,
    c.status,
    c.approved_recipients,
    c.approved_cost_minor,
    count(r.*) FILTER (WHERE r.is_included)                     AS in_audience,
    count(r.*) FILTER (WHERE NOT r.is_included)                 AS excluded,
    count(r.*) FILTER (WHERE r.send_outcome = 'sent')           AS sent,
    count(r.*) FILTER (WHERE r.send_outcome = 'failed')         AS failed,
    count(r.*) FILTER (WHERE r.is_included AND r.send_outcome IS NULL) AS never_reached,
    count(s.*) FILTER (WHERE s.delivered_at IS NOT NULL)        AS delivered,
    count(s.*) FILTER (WHERE s.read_at IS NOT NULL)             AS read_count,
    /**
     * 🔴 WHAT IT ACTUALLY COST, from the delivery receipts, beside what
     * was approved. The two are never equal and the difference is the
     * point: billing is on delivery, so anything that did not arrive
     * cost nothing.
     */
    COALESCE(sum(s.cost_minor), 0)::bigint                      AS actual_cost_minor
FROM campaigns c
LEFT JOIN campaign_recipients r ON r.campaign_id = c.id
LEFT JOIN message_sends s ON s.id = r.message_send_id
GROUP BY c.tenant_id, c.id, c.name, c.status,
         c.approved_recipients, c.approved_cost_minor;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app') THEN
    GRANT SELECT ON v_campaign_outcome TO ordence_app;
  END IF;
END $$;


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⭐ app_platform_scope() in USING, never in WITH CHECK.

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaigns_tenant_isolation ON campaigns;
CREATE POLICY campaigns_tenant_isolation ON campaigns
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_recipients_tenant_isolation ON campaign_recipients;
CREATE POLICY campaign_recipients_tenant_isolation ON campaign_recipients
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
