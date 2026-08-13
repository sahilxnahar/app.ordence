-- =====================================================================
--  ORDENCE 0066 — UTILITY MESSAGING
--  v1.14.0-alpha · Front office, batch 8
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴🔴 THE DUNNING LADDER HAS RECORDED WHATSAPP DELIVERIES SINCE 0027
--     AND NOTHING HAS EVER SENT ONE
--  ══════════════════════════════════════════════════════════════════════
--  `dunning_channel` has included `whatsapp` from the start.
--  `dunning_events` records the channel, the recipient, `sent_at`, the
--  amount outstanding on that day and who authorised it. The whole table
--  exists, in its own words, to be "the evidence that the buyer was
--  given every chance".
--
--  ⚠️ AND THE ROW IS WRITTEN BY A PERSON TICKING A BOX. Nothing leaves
--  the building. So a firm can hold a perfect, append-only, legally
--  shaped record that a demand notice was served by WhatsApp on a date
--  when no message was sent at all.
--
--  🔴 THAT IS WORSE THAN A MISSING FEATURE. A gap in evidence is a gap.
--  Evidence of something that did not happen is a different problem, and
--  it is discovered by the other side.
--
--  ⭐ SO THIS MIGRATION DOES NOT BUILD A MESSAGING PRODUCT. It builds the
--  thing that makes `dunning_events.channel = 'whatsapp'` true, and the
--  same machinery then serves every other utility message the system
--  already knows it wants to send.
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴 YOU ARE BILLED ON DELIVERY, NOT ON SEND
--  ══════════════════════════════════════════════════════════════════════
--  Meta charges per message and, in its own words, "only when a template
--  message is delivered". Since 1 July 2025, per message, not per
--  conversation.
--
--  ⚠️ SO COST BOOKED AT SEND TIME IS WRONG IN BOTH DIRECTIONS. A send to
--  a number that no longer has WhatsApp costs nothing and would be
--  counted; and a spend ceiling that counts attempts stops a business
--  from sending messages it was never going to be charged for.
--
--  ⭐ `cost_minor` IS THEREFORE NULL UNTIL THE DELIVERY RECEIPT ARRIVES,
--  and a CHECK refuses a cost on anything that has not been delivered.
--
--  ══════════════════════════════════════════════════════════════════════
--  ⚠️ AND THE 24 HOUR WINDOW IS THE DIFFERENCE BETWEEN FREE AND NOT
--  ══════════════════════════════════════════════════════════════════════
--  A utility template inside an open customer service window is FREE.
--  The same template one minute after it closes is charged. Nothing
--  about the message changes.
--
--  🔴 A PRODUCT THAT DOES NOT TRACK THE WINDOW CANNOT TELL A CUSTOMER
--  WHY THE SAME REMINDER COST NOTHING ON MONDAY AND MONEY ON TUESDAY.
--
--  Depends on: 0064 (connections), 0061 (consent), 0027 (dunning).
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① THE TEMPLATE, AS META HOLDS IT
-- =====================================================================
--  ⭐ A LOCAL COPY OF SOMETHING META OWNS.
--
--  ⚠️ Approval, category and quality are all decided at their end and
--  can change without us asking. So this table records what we last
--  knew and WHEN we last knew it, rather than pretending to be the
--  source of truth.

CREATE TABLE IF NOT EXISTS message_templates (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id       uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

    /** Meta's own template name. Lower case, underscores. */
    name                varchar(120) NOT NULL,
    language            varchar(10) NOT NULL DEFAULT 'en',

    /**
     * 🔴 THE CATEGORY DECIDES THE PRICE AND THE RULES, AND META DECIDES
     * THE CATEGORY.
     *
     * ⚠️ They re-categorise. A template written as `utility` that reads
     * like an advertisement is moved to `marketing`, and the same send
     * silently costs seven times more. Which is why the category is
     * stored as what they last told us, not as what we asked for.
     */
    category            varchar(20) NOT NULL,
    /** ⭐ What we asked for, kept so a re-categorisation is visible. */
    requested_category  varchar(20),

    /**
     * The template body with `{{1}}`, `{{2}}` placeholders, exactly as
     * approved.
     *
     * ⚠️ KEPT SO WE CAN COUNT AND VALIDATE THE VARIABLES BEFORE SENDING.
     * Meta rejects a send whose parameter count does not match, and
     * discovering that at send time means the reminder did not go.
     */
    body                text NOT NULL,
    header_text         text,
    footer_text         text,
    variable_count      integer NOT NULL DEFAULT 0,

    /**
     * 🔴 THE STATUS, INCLUDING THE ONES THAT ARE NOT ERRORS.
     *   in_review  — with Meta, cannot send
     *   approved   — sendable
     *   rejected   — failed review, cannot send
     *   paused     — automatically suspended on quality, cannot send
     *   disabled   — permanently blocked, cannot send
     *
     * ⚠️ `paused` IS TEMPORARY AND ESCALATING: three hours, then six,
     * then permanent. A product that treats a pause as a failure retries
     * into the next pause and reaches `disabled`, which cannot be undone.
     */
    status              varchar(20) NOT NULL DEFAULT 'in_review',
    /** green / yellow / red, as Meta reports it. Null before any data. */
    quality             varchar(10),
    rejection_reason    varchar(500),
    paused_until        timestamptz,
    /** ⭐ How many times it has been paused. Three is permanent. */
    pause_count         integer NOT NULL DEFAULT 0,

    /** When we last heard from Meta about any of the above. */
    synced_at           timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT message_templates_category_known CHECK (
        category IN ('marketing', 'utility', 'authentication', 'service')
    ),
    CONSTRAINT message_templates_status_known CHECK (
        status IN ('in_review', 'approved', 'rejected', 'paused', 'disabled')
    ),
    CONSTRAINT message_templates_quality_known CHECK (
        quality IS NULL OR quality IN ('green', 'yellow', 'red', 'unknown')
    ),
    CONSTRAINT message_templates_variables_non_negative CHECK (variable_count >= 0),
    -- 🔴 A REJECTION SAYS WHY. "Rejected" on a screen with no reason is a
    -- support call, and the reason is the only thing that lets somebody
    -- rewrite it.
    CONSTRAINT message_templates_rejection_is_explained CHECK (
        status <> 'rejected' OR rejection_reason IS NOT NULL
    ),
    -- ⚠️ A pause says when it lifts, for the same reason a locked
    -- connection does in 0064.
    CONSTRAINT message_templates_pause_has_an_end CHECK (
        status <> 'paused' OR paused_until IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS message_templates_unique
    ON message_templates (connection_id, name, language);


-- =====================================================================
--  ② THE CUSTOMER SERVICE WINDOW
-- =====================================================================
--  🔴🔴 THE DIFFERENCE BETWEEN FREE AND NOT, AND IT IS INVISIBLE.
--
--  A customer messages us. That opens a 24 hour window. Inside it a
--  utility template is free and a plain text reply is free. One minute
--  after it closes the identical utility template is charged.
--
--  ⚠️ NOTHING ABOUT THE MESSAGE CHANGES. Only the clock. So a product
--  that does not track this cannot answer "why did the same reminder
--  cost nothing on Monday", and cannot make the one optimisation that
--  actually saves the customer money: send the reminder while the window
--  is open.

CREATE TABLE IF NOT EXISTS service_windows (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id       uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

    /** ⚠️ Digits only, last ten, matching the rest of the system. */
    phone_digits        varchar(15) NOT NULL,

    /** When they last messaged us. The window runs from here. */
    opened_at           timestamptz NOT NULL,
    expires_at          timestamptz NOT NULL,

    /**
     * ⭐ A FREE ENTRY POINT WINDOW IS 72 HOURS, NOT 24, AND EVERYTHING
     * IS FREE INSIDE IT — including marketing.
     *
     * ⚠️ It is opened by a click-to-WhatsApp ad or a page call-to-action,
     * so a business running those has a materially different cost
     * profile and no product tells them.
     */
    is_free_entry_point boolean NOT NULL DEFAULT false,

    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT service_windows_ordered CHECK (expires_at > opened_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS service_windows_unique
    ON service_windows (connection_id, phone_digits);
CREATE INDEX IF NOT EXISTS service_windows_open_idx
    ON service_windows (tenant_id, expires_at);


--  ⭐ THE WINDOW IS EXTENDED, NEVER SHORTENED.
--
--  ⚠️ A second inbound message restarts the 24 hours. An UPDATE that
--  moved `expires_at` backwards would close a window that is genuinely
--  open and start charging for messages that are free.
CREATE OR REPLACE FUNCTION ordence_extend_service_window()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.expires_at < OLD.expires_at THEN
    NEW.expires_at := OLD.expires_at;
  END IF;
  -- 🔴 AND A FREE ENTRY POINT WINDOW IS NEVER DOWNGRADED to an ordinary
  -- one while it is still running: everything inside it is free, and
  -- losing that flag starts charging for messages that are not.
  IF OLD.is_free_entry_point AND OLD.expires_at > now() THEN
    NEW.is_free_entry_point := true;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_extend_service_window ON service_windows;
CREATE TRIGGER trg_extend_service_window
  BEFORE UPDATE ON service_windows
  FOR EACH ROW EXECUTE FUNCTION ordence_extend_service_window();


-- =====================================================================
--  ③ WHAT WE ACTUALLY SENT
-- =====================================================================
--  🔴 THE ROW THAT MAKES `dunning_events.channel = 'whatsapp'` TRUE.

CREATE TABLE IF NOT EXISTS message_sends (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id       uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    template_id         uuid REFERENCES message_templates(id) ON DELETE SET NULL,

    /**
     * 🔴🔴 THE IDEMPOTENCY KEY, AND IT IS OURS, NOT THEIRS.
     *
     * ⚠️ Meta gives us a message id only in the RESPONSE, which is no
     * use for deciding whether to send. A retry after a timeout would
     * otherwise send the same payment reminder twice, and the second one
     * is the one the customer complains about.
     *
     * ⭐ Derived from what the message IS: "demand:<id>:rung3". Two
     * attempts to send the same thing collide here and the second is
     * refused by the database rather than by a promise in a runner.
     */
    idempotency_key     varchar(200) NOT NULL,

    /** What this message is about, in the vocabulary tasks already use. */
    subject_type        varchar(40),
    subject_id          uuid,

    to_phone_digits     varchar(15) NOT NULL,
    /** As dialled, for evidence. */
    to_phone            varchar(32),

    category            varchar(20) NOT NULL,
    language            varchar(10) NOT NULL DEFAULT 'en',
    /**
     * ⚠️ THE RENDERED TEXT, KEPT.
     *
     * 🔴 A demand notice is served evidence. "Template X with parameters
     * A, B" is not what the buyer received; the rendered sentence is,
     * and six months later the template will have been edited.
     */
    rendered_body       text NOT NULL,

    /**
     * 🔴 WAS THE WINDOW OPEN WHEN WE SENT? Recorded at send time,
     * because it cannot be reconstructed afterwards and it is the whole
     * explanation of the price.
     */
    inside_service_window boolean NOT NULL DEFAULT false,

    status              varchar(20) NOT NULL DEFAULT 'queued',
    /** Meta's id for the message, once they give us one. */
    provider_message_id varchar(200),

    queued_at           timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz,
    delivered_at        timestamptz,
    read_at             timestamptz,
    failed_at           timestamptz,

    error_code          varchar(60),
    /** ⚠️ In words the customer can read. Never a stack trace. */
    error_message       varchar(500),

    /**
     * 🔴🔴 NULL UNTIL DELIVERED. See the file header.
     *
     * ⚠️ Meta charges only when a template message is DELIVERED. A cost
     * booked at send time counts messages that were never charged, and a
     * spend ceiling built on it stops a business from sending messages
     * that are free.
     */
    cost_minor          bigint,
    /** The rate used, so an old send can be explained after a rate change. */
    rate_minor          bigint,

    /** ⭐ Which person or job caused this. Null means a scheduled job. */
    requested_by        uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT message_sends_category_known CHECK (
        category IN ('marketing', 'utility', 'authentication', 'service')
    ),
    CONSTRAINT message_sends_status_known CHECK (
        status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'refused')
    ),
    -- 🔴 A COST MAY ONLY EXIST ON SOMETHING THAT WAS DELIVERED.
    CONSTRAINT message_sends_cost_follows_delivery CHECK (
        cost_minor IS NULL OR delivered_at IS NOT NULL
    ),
    CONSTRAINT message_sends_cost_non_negative CHECK (
        cost_minor IS NULL OR cost_minor >= 0
    ),
    -- ⚠️ A failure says why. A send log whose rows say "failed" answers
    -- nothing at the moment somebody asks why the buyer never heard.
    CONSTRAINT message_sends_failure_is_explained CHECK (
        status NOT IN ('failed', 'refused') OR error_message IS NOT NULL
    ),
    -- ⭐ READ IMPLIES DELIVERED, AND DELIVERED IMPLIES SENT. The states
    -- arrive out of order from the provider often enough that this is
    -- worth the database refusing rather than a screen showing a message
    -- read before it was sent.
    CONSTRAINT message_sends_states_are_ordered CHECK (
        (delivered_at IS NULL OR sent_at IS NOT NULL)
        AND (read_at IS NULL OR delivered_at IS NOT NULL)
    )
);

-- 🔴 THE SAME MESSAGE IS NOT SENT TWICE.
CREATE UNIQUE INDEX IF NOT EXISTS message_sends_idempotency_unique
    ON message_sends (tenant_id, idempotency_key);

CREATE INDEX IF NOT EXISTS message_sends_subject_idx
    ON message_sends (tenant_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS message_sends_spend_idx
    ON message_sends (tenant_id, delivered_at)
    WHERE cost_minor IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_sends_pending_idx
    ON message_sends (tenant_id, queued_at)
    WHERE status IN ('queued', 'sent');


--  ⭐ A SEND IS EVIDENCE. The provider's own callbacks move it forward
--  and nothing moves it back.
CREATE OR REPLACE FUNCTION ordence_guard_message_send()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'A sent message cannot be deleted. It is the evidence that the customer was told, and on a demand notice it is the evidence of service.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 🔴 THE RENDERED TEXT IS WHAT THE PERSON RECEIVED. It cannot change
  -- afterwards, because the template it came from certainly will.
  IF NEW.rendered_body IS DISTINCT FROM OLD.rendered_body
     OR NEW.to_phone_digits IS DISTINCT FROM OLD.to_phone_digits
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.inside_service_window IS DISTINCT FROM OLD.inside_service_window THEN
    RAISE EXCEPTION
      'What was sent, to whom, and whether the free window was open cannot be changed afterwards. Record a new send instead.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⚠️ DELIVERY RECEIPTS ARRIVE OUT OF ORDER. A "sent" callback landing
  -- after a "delivered" one must not walk the row backwards, or a
  -- delivered message reports as merely sent and its cost is lost.
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS NULL THEN
    RAISE EXCEPTION
      'A delivered message cannot become undelivered. Delivery receipts arrive out of order and the later one is not always the newer one.'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS NULL THEN
    RAISE EXCEPTION 'A read message cannot become unread.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 🔴 AND THE COST IS SET ONCE. Meta bills per delivered message; a
  -- second callback for the same message must not double the spend.
  IF OLD.cost_minor IS NOT NULL AND NEW.cost_minor IS DISTINCT FROM OLD.cost_minor THEN
    RAISE EXCEPTION
      'The cost of a delivered message is recorded once. A repeated delivery receipt must not be charged twice.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_message_send ON message_sends;
CREATE TRIGGER trg_guard_message_send
  BEFORE UPDATE OR DELETE ON message_sends
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_message_send();


-- =====================================================================
--  ④ THE CEILING
-- =====================================================================
--  🔴🔴 A BUG IN A LOOP SPENDS REAL MONEY AT ABOUT ₹1 A MESSAGE.
--
--  ⚠️ Everything else in this system that goes wrong produces a wrong
--  number on a screen. This produces a bill, and a customer whose phone
--  buzzed forty times at three in the morning.
--
--  ⭐ SO THE CEILING IS IN THE DATABASE, NOT IN THE SENDER. A limit
--  enforced by the code that does the sending is a limit that the next
--  code path forgets.

ALTER TABLE connections ADD COLUMN IF NOT EXISTS daily_spend_cap_minor bigint;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS daily_send_cap integer;

DO $$ BEGIN
    ALTER TABLE connections ADD CONSTRAINT connections_spend_caps_sane
        CHECK (
            (daily_spend_cap_minor IS NULL OR daily_spend_cap_minor >= 0)
            AND (daily_send_cap IS NULL OR daily_send_cap >= 0)
        );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--  ⭐ WHAT HAS ACTUALLY BEEN SPENT TODAY, AND WHAT HAS MERELY BEEN SENT.
--
--  🔴 THE TWO ARE DIFFERENT AND BOTH MATTER. Spend is billed on
--  delivery, so it lags; the send count is what a runaway loop moves
--  first. A ceiling on spend alone would let a loop fire ten thousand
--  messages before the first receipt came back.
CREATE OR REPLACE VIEW v_message_spend_today
WITH (security_invoker = true) AS
SELECT
    s.tenant_id,
    s.connection_id,
    count(*) FILTER (WHERE s.status <> 'refused')                   AS attempted,
    count(*) FILTER (WHERE s.delivered_at IS NOT NULL)              AS delivered,
    count(*) FILTER (WHERE s.status = 'failed')                     AS failed,
    COALESCE(sum(s.cost_minor), 0)::bigint                          AS spent_minor,
    count(*) FILTER (WHERE s.inside_service_window)                 AS free_window_sends
FROM message_sends s
WHERE s.queued_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
GROUP BY s.tenant_id, s.connection_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app') THEN
    GRANT SELECT ON v_message_spend_today TO ordence_app;
  END IF;
END $$;


--  🔴🔴 THE CEILING, ENFORCED ON INSERT, BY THE DATABASE.
--
--  ⚠️ Counted on ATTEMPTS, not on delivered spend, precisely because
--  spend lags. A runaway loop moves the attempt count immediately and
--  the spend figure only minutes later, by which time the money is gone.
CREATE OR REPLACE FUNCTION ordence_enforce_send_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_send_cap  integer;
  v_spend_cap bigint;
  v_sent      integer;
  v_spent     bigint;
BEGIN
  -- ⭐ A refusal is recorded, not sent, so it does not count against the
  -- ceiling it is the record of.
  IF NEW.status = 'refused' THEN
    RETURN NEW;
  END IF;

  SELECT daily_send_cap, daily_spend_cap_minor
    INTO v_send_cap, v_spend_cap
    FROM connections
   WHERE id = NEW.connection_id;

  IF v_send_cap IS NULL AND v_spend_cap IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*), COALESCE(sum(cost_minor), 0)
    INTO v_sent, v_spent
    FROM message_sends
   WHERE connection_id = NEW.connection_id
     AND status <> 'refused'
     AND queued_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata');

  IF v_send_cap IS NOT NULL AND v_sent >= v_send_cap THEN
    RAISE EXCEPTION
      'This connection has already sent its daily limit of % messages. Nothing further will go out today. Raise the limit deliberately if that is what you want.', v_send_cap
      USING ERRCODE = 'raise_exception';
  END IF;

  IF v_spend_cap IS NOT NULL AND v_spent >= v_spend_cap THEN
    RAISE EXCEPTION
      'This connection has reached its daily spend limit. Nothing further will go out today.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_send_cap ON message_sends;
CREATE TRIGGER trg_enforce_send_cap
  BEFORE INSERT ON message_sends
  FOR EACH ROW EXECUTE FUNCTION ordence_enforce_send_cap();


-- =====================================================================
--  ⑤ THE LINK BACK TO THE DUNNING LADDER
-- =====================================================================
--  ⭐⭐ THE POINT OF THE WHOLE MIGRATION.
--
--  🔴 `dunning_events` has claimed to record WhatsApp service since
--  0027. From here a row may name the message that actually went, and a
--  report can tell the two apart: served, and merely recorded.

ALTER TABLE dunning_events ADD COLUMN IF NOT EXISTS message_send_id uuid
    REFERENCES message_sends(id) ON DELETE SET NULL;

--  ⚠️ NOT `NOT NULL`, AND THAT IS DELIBERATE. Post, courier and hand
--  delivery are real channels with no message behind them, and they are
--  the ones that actually constitute service under most agreements. The
--  column answers "did an electronic message go", not "was it served".
COMMENT ON COLUMN dunning_events.message_send_id IS
  'The WhatsApp/SMS message that carried this notice, where one did. NULL for post, courier and hand delivery, which are service in their own right.';


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⭐ app_platform_scope() in USING, never in WITH CHECK.

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_templates_tenant_isolation ON message_templates;
CREATE POLICY message_templates_tenant_isolation ON message_templates
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE service_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_windows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_windows_tenant_isolation ON service_windows;
CREATE POLICY service_windows_tenant_isolation ON service_windows
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE message_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_sends FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_sends_tenant_isolation ON message_sends;
CREATE POLICY message_sends_tenant_isolation ON message_sends
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
