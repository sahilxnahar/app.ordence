-- =====================================================================
--  ORDENCE 0061 — CRM COMPLETION, CONSENT, AND INTERNAL MESSAGING
--  v1.10.0-alpha · Front office, batch 3 and 4
-- =====================================================================
--
--  ⭐⭐ THIS MIGRATION DOES NOT CREATE A SECOND LEAD TABLE.
--
--  `leads` has existed since the real estate work and it is already
--  mostly generic: name, email, phone, source, status, temperature,
--  score, requirement, owner, next follow-up, lost reason. What is
--  real-estate-shaped about it is the PROJECT link, and what is missing
--  is a general one.
--
--  🔴 A second lead table would give two answers to "who enquired", and
--  somebody would reconcile them forever. The same decision as the price
--  list in 0057, for the same reason. So this EXTENDS it.
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴🔴 AND THE PART THAT IS NOT OPTIONAL: CONSENT
--  ══════════════════════════════════════════════════════════════════════
--  The Digital Personal Data Protection Rules 2025 were notified on
--  13 November 2025. Consent manager registration closes November 2026
--  and the penalty regime begins May 2027, which is inside the life of
--  this plan and not after it.
--
--  ⚠️ Consent recorded as a boolean is not consent. The Act turns on
--  what the person was TOLD, for what PURPOSE, and how easily they can
--  take it back. So:
--
--    consent_notices — the exact wording shown, versioned, and frozen
--                      the moment anybody agrees to it
--    consents        — one row per party, purpose and channel, naming
--                      the notice it was given against
--
--  🔴 A consent row that does not name a notice is a checkbox, not
--     evidence, and the constraint below refuses it.
--
--  🔴 AND WITHDRAWAL IS NEVER A DELETE. A withdrawn consent is a fact
--     that has to survive, because the question afterwards is always
--     "when did they say stop, and did we".
--
--  Depends on: crm (contacts, companies), sales (leads), core, work.
-- =====================================================================

BEGIN;

-- =====================================================================
--  ① WHERE LEADS COME FROM
-- =====================================================================
--  ⭐ The existing `source` enum stays exactly where it is. Rows already
--  use it and rewriting history to fit a new table is how a migration
--  becomes a data loss incident.
--
--  ⚠️ What it cannot do is name IndiaMART, JustDial or a specific
--  campaign, and it cannot carry what the source COST. Attribution
--  through to collected money is the whole reason batch 7 is worth
--  building, and it needs a real row per source.

CREATE TABLE IF NOT EXISTS lead_sources (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    name                varchar(160) NOT NULL,
    /** The kind of place it came from. Constrained so it can be grouped. */
    channel             varchar(30) NOT NULL,
    /** For an integration, the key the connector uses. */
    connector_key       varchar(60),

    /** ⭐ Paid sources get their cost tracked so attribution can be real. */
    is_paid             boolean NOT NULL DEFAULT false,
    is_active           boolean NOT NULL DEFAULT true,
    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT lead_sources_channel_known CHECK (
        channel IN ('website', 'walk_in', 'referral', 'campaign', 'marketplace',
                    'social', 'phone', 'exhibition', 'partner', 'other')
    ),
    -- ⚠️ A source that arrives through a connector has to say which one,
    -- or a lead cannot be traced back when the feed breaks.
    CONSTRAINT lead_sources_marketplace_has_connector CHECK (
        channel <> 'marketplace' OR connector_key IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_sources_name_unique
    ON lead_sources (tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS lead_sources_active_idx
    ON lead_sources (tenant_id, channel) WHERE is_active;


-- =====================================================================
--  ② THE PIPELINE, WITH STAGES THE TENANT DEFINES
-- =====================================================================
--  🔴 `lead_status` is an enum with real-estate words in it: site_visit,
--  booked. A trading company does not do site visits and a law firm does
--  not book units.
--
--  ⚠️ The enum stays, because existing rows use it. New work reads
--  `stage_id`, and the enum becomes what it always was: a coarse
--  lifecycle marker.

CREATE TABLE IF NOT EXISTS pipeline_stages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    /** Which board this stage belongs to. */
    pipeline_key        varchar(40) NOT NULL DEFAULT 'lead',
    name                varchar(80) NOT NULL,
    position            integer NOT NULL,

    /**
     * 🔴 EXACTLY ONE WON STAGE PER PIPELINE, ENFORCED BELOW.
     * Two "won" columns means two conversion rates, and every report
     * built on them disagrees with every other one.
     */
    is_won              boolean NOT NULL DEFAULT false,
    is_lost             boolean NOT NULL DEFAULT false,
    /** ⚠️ A lost stage asks why. The reasons are the whole value of it. */
    requires_reason     boolean NOT NULL DEFAULT false,
    colour              varchar(20),

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pipeline_stages_position_positive CHECK (position > 0),
    -- ⚠️ A stage cannot be both the win and the loss.
    CONSTRAINT pipeline_stages_not_both_ends CHECK (NOT (is_won AND is_lost))
);

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_position_unique
    ON pipeline_stages (tenant_id, pipeline_key, position);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_name_unique
    ON pipeline_stages (tenant_id, pipeline_key, lower(name));


--  🔴 A BOARD WITH TWO WIN COLUMNS PRODUCES TWO CONVERSION RATES.
--
--  ⭐ DEFERRABLE INITIALLY DEFERRED, like the rate slabs in 0057 and the
--  court fee bands in 0059, because the stages of a pipeline are entered
--  as a set and a row-by-row check would reject the first one every
--  time.
CREATE OR REPLACE FUNCTION ordence_validate_pipeline()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t_id      uuid;
  p_key     text;
  n_won     integer;
  n_stages  integer;
  max_pos   integer;
BEGIN
  t_id  := COALESCE(NEW.tenant_id, OLD.tenant_id);
  p_key := COALESCE(NEW.pipeline_key, OLD.pipeline_key);

  SELECT count(*), COALESCE(max(position), 0)
    INTO n_stages, max_pos
    FROM pipeline_stages
   WHERE tenant_id = t_id AND pipeline_key = p_key;

  -- ⚠️ The last stage of a pipeline being deleted is a legitimate
  -- teardown, not an error.
  IF n_stages = 0 THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO n_won
    FROM pipeline_stages
   WHERE tenant_id = t_id AND pipeline_key = p_key AND is_won;

  IF n_won <> 1 THEN
    RAISE EXCEPTION
      'The "%" board has % stages marked as won. Exactly one is needed. Two win columns produce two conversion rates, and every report built on them disagrees with every other one.',
      p_key, n_won
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 🔴 POSITIONS MUST BE CONTIGUOUS FROM ONE.
  -- ⚠️ A gap is invisible on a board and reorders it silently the next
  -- time anybody inserts a stage.
  IF max_pos <> n_stages THEN
    RAISE EXCEPTION
      'The "%" board has % stages but its highest position is %. Positions must run from 1 with no gaps, or the board reorders itself the next time a stage is added.',
      p_key, n_stages, max_pos
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_validate_pipeline ON pipeline_stages;
CREATE CONSTRAINT TRIGGER trg_validate_pipeline
  AFTER INSERT OR UPDATE OR DELETE ON pipeline_stages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ordence_validate_pipeline();


-- =====================================================================
--  ③ GENERALISING THE LEAD
-- =====================================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_source_id uuid
    REFERENCES lead_sources(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage_id uuid
    REFERENCES pipeline_stages(id) ON DELETE SET NULL;

--  ⭐ What the enquiry is ABOUT, for a business that does not sell flats.
--  The same vocabulary tasks and activities use, so one lead can be
--  about a stock item, a service, a matter or a project.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS interest_type varchar(40);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS interest_id uuid;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS interest_label varchar(300);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_id uuid
    REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_id uuid
    REFERENCES contacts(id) ON DELETE SET NULL;

--  🔴🔴 THE DUPLICATE PROBLEM, AND WHY A RAW STRING CANNOT SOLVE IT.
--
--  The same person enquires three times and arrives as:
--
--      +91 98765 43210
--      098765 43210
--      9876543210
--
--  ⚠️ A duplicate check on the stored text finds NOTHING. Three leads,
--  three follow-ups, three salespeople ringing the same man in one
--  afternoon, and he thinks the firm is a shambles because it is.
--
--  ⭐ GENERATED ALWAYS, so it cannot drift from the column it is derived
--  from and cannot be forgotten by an import.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_digits varchar(10)
    GENERATED ALWAYS AS (
        right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10)
    ) STORED;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_key varchar(320)
    GENERATED ALWAYS AS (lower(btrim(COALESCE(email, '')))) STORED;

--  ⚠️ NOT a unique index. A genuine second enquiry from the same person
--  six months later is a real lead, and refusing it would push the
--  salesman into typing a fake number. It is an INDEX so the duplicate
--  can be found and shown, and a decision made by a person.
CREATE INDEX IF NOT EXISTS leads_phone_digits_idx
    ON leads (tenant_id, phone_digits) WHERE phone_digits <> '';
CREATE INDEX IF NOT EXISTS leads_email_key_idx
    ON leads (tenant_id, email_key) WHERE email_key <> '';

--  ⭐ Where a duplicate WAS decided, it is recorded rather than deleted.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS duplicate_of uuid
    REFERENCES leads(id) ON DELETE SET NULL;

DO $$ BEGIN
    ALTER TABLE leads ADD CONSTRAINT leads_not_own_duplicate
        CHECK (duplicate_of IS NULL OR duplicate_of <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE leads ADD CONSTRAINT leads_interest_is_whole
        CHECK (
            (interest_type IS NULL AND interest_id IS NULL)
            OR (interest_type IS NOT NULL AND interest_id IS NOT NULL)
        );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS leads_stage_idx
    ON leads (tenant_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_source_idx
    ON leads (tenant_id, lead_source_id) WHERE deleted_at IS NULL;


-- =====================================================================
--  ④ THE NOTICE, WHICH IS THE HALF EVERYBODY SKIPS
-- =====================================================================
--  🔴 CONSENT IS NOT A BOOLEAN. It is a person agreeing to a specific
--  thing they were told, for a specific purpose. A tick box with no
--  record of the wording proves nothing at all, and proving it is the
--  entire point of keeping the record.

CREATE TABLE IF NOT EXISTS consent_notices (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    /** "Marketing consent, v3". */
    name                varchar(160) NOT NULL,
    version             integer NOT NULL DEFAULT 1,
    /** ⭐ THE ACTUAL WORDING SHOWN TO THE PERSON. Not a link to it. */
    body                text NOT NULL,
    /** Which purposes this notice covers. */
    purposes            text[] NOT NULL DEFAULT ARRAY['marketing'],
    language            varchar(8) NOT NULL DEFAULT 'en',

    effective_from      date NOT NULL,
    is_active           boolean NOT NULL DEFAULT true,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT consent_notices_version_positive CHECK (version > 0),
    -- ⚠️ A notice with no words in it is not a notice.
    CONSTRAINT consent_notices_has_words CHECK (length(btrim(body)) >= 20),
    CONSTRAINT consent_notices_has_purposes CHECK (array_length(purposes, 1) >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS consent_notices_version_unique
    ON consent_notices (tenant_id, lower(name), version, language);


-- =====================================================================
--  ⑤ THE CONSENT ITSELF
-- =====================================================================

CREATE TABLE IF NOT EXISTS consents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    /** Who gave it. One of the three, and at least one. */
    contact_id          uuid REFERENCES contacts(id) ON DELETE CASCADE,
    company_id          uuid REFERENCES companies(id) ON DELETE CASCADE,
    lead_id             uuid REFERENCES leads(id) ON DELETE CASCADE,

    /**
     * 🔴 THE PURPOSE. The Act is a purpose-limitation Act: consent to be
     * contacted about an order is not consent to be sent a campaign.
     */
    purpose             varchar(30) NOT NULL,
    /**
     * ⭐ `all` is a real value and it is the important one. A person who
     * says stop means stop, not stop-on-email-and-keep-the-WhatsApp.
     */
    channel             varchar(20) NOT NULL DEFAULT 'all',

    state               varchar(20) NOT NULL DEFAULT 'granted',

    /** 🔴 WHICH NOTICE THEY AGREED TO. Not optional for a grant. */
    notice_id           uuid REFERENCES consent_notices(id) ON DELETE RESTRICT,

    granted_at          timestamptz,
    withdrawn_at        timestamptz,
    /** How it was obtained or withdrawn: web form, signed paper, reply. */
    evidence            varchar(200),
    evidence_ref        varchar(200),

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT consents_purpose_known CHECK (
        purpose IN ('marketing', 'transactional', 'service', 'profiling', 'all')
    ),
    CONSTRAINT consents_channel_known CHECK (
        channel IN ('all', 'whatsapp', 'email', 'sms', 'call', 'post')
    ),
    CONSTRAINT consents_state_known CHECK (state IN ('granted', 'withdrawn')),

    -- ⚠️ A consent belonging to nobody cannot be honoured or produced.
    CONSTRAINT consents_has_a_party CHECK (
        contact_id IS NOT NULL OR company_id IS NOT NULL OR lead_id IS NOT NULL
    ),

    -- =================================================================
    -- 🔴🔴 A GRANT MUST NAME THE NOTICE IT WAS GIVEN AGAINST.
    --
    -- Without it there is a row saying somebody agreed and no record of
    -- what they agreed to. That is a checkbox, not evidence, and it is
    -- exactly what an inspection asks to see.
    -- =================================================================
    CONSTRAINT consents_grant_names_its_notice CHECK (
        state <> 'granted' OR (notice_id IS NOT NULL AND granted_at IS NOT NULL)
    ),

    -- 🔴 A WITHDRAWAL MUST BE DATED. "They opted out at some point" does
    -- not answer whether the campaign sent on the 14th was lawful.
    CONSTRAINT consents_withdrawal_is_dated CHECK (
        state <> 'withdrawn' OR withdrawn_at IS NOT NULL
    ),
    -- ⚠️ And it cannot precede the grant it takes back.
    CONSTRAINT consents_withdrawal_follows_grant CHECK (
        withdrawn_at IS NULL OR granted_at IS NULL OR withdrawn_at >= granted_at
    )
);

CREATE INDEX IF NOT EXISTS consents_contact_idx
    ON consents (tenant_id, contact_id, purpose) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS consents_lead_idx
    ON consents (tenant_id, lead_id, purpose) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS consents_company_idx
    ON consents (tenant_id, company_id, purpose) WHERE company_id IS NOT NULL;


--  🔴🔴 WITHDRAWAL IS NEVER A DELETE, AND A NOTICE IS FROZEN ONCE USED.
--
--  ⚠️ The question after a complaint is always "when did they say stop,
--  and did we". A deleted row cannot answer it, and a consent table that
--  can be tidied is a consent table that proves nothing.
CREATE OR REPLACE FUNCTION ordence_guard_consent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'A consent record cannot be deleted. Withdrawal is a state with a date on it, not an absence — the question after a complaint is always when the person said stop and whether anything was sent afterwards, and a deleted row cannot answer it.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 🔴 A GRANT CANNOT BE EDITED INTO A DIFFERENT GRANT.
  IF OLD.state = 'granted' AND NEW.state = 'granted' THEN
    IF NEW.purpose IS DISTINCT FROM OLD.purpose
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.notice_id IS DISTINCT FROM OLD.notice_id
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
      RAISE EXCEPTION
        'What somebody consented to cannot be changed afterwards. Withdraw this consent and record a new one, so the file shows both what was agreed and what changed.'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  -- ⚠️ And a withdrawal cannot be quietly reversed.
  IF OLD.state = 'withdrawn' AND NEW.state = 'granted' THEN
    RAISE EXCEPTION
      'A withdrawn consent cannot be switched back on. If the person has agreed again, record a NEW consent against the notice they were shown this time.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_consent ON consents;
CREATE TRIGGER trg_guard_consent
  BEFORE UPDATE OR DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_consent();


--  🔴 THE WORDING SOMEBODY AGREED TO CANNOT BE EDITED AFTERWARDS.
--
--  ⚠️ That is the entire point of storing it. A notice whose text can be
--  changed after people have agreed to it is worth exactly as much as no
--  notice at all. Publish a new version instead.
CREATE OR REPLACE FUNCTION ordence_guard_consent_notice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  used integer;
BEGIN
  SELECT count(*) INTO used FROM consents WHERE notice_id = OLD.id;

  IF used = 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      '% people have consented against this notice. It cannot be deleted — the wording is the evidence of what they agreed to.',
      used
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.purposes IS DISTINCT FROM OLD.purposes
     OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION
      '% people have already consented against this notice, so its wording is frozen. Publish a new version instead — a notice that can be edited after people agree to it is worth exactly as much as no notice at all.',
      used
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_consent_notice ON consent_notices;
CREATE TRIGGER trg_guard_consent_notice
  BEFORE UPDATE OR DELETE ON consent_notices
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_consent_notice();


-- =====================================================================
--  ⑥ INTERNAL MESSAGING
-- =====================================================================
--  ⭐ THE CHEAPEST LOYALTY FEATURE ON THE WHOLE PLAN.
--
--  Ledgers do not create habit. Conversations do. And a conversation
--  about an invoice belongs ON the invoice, not in somebody's email
--  where the next person to pick the file up cannot find it.

CREATE TABLE IF NOT EXISTS message_threads (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    title               varchar(300),
    /** The same vocabulary tasks and activities use. */
    subject_type        varchar(40),
    subject_id          uuid,
    subject_label       varchar(300),

    is_closed           boolean NOT NULL DEFAULT false,
    closed_reason       varchar(300),

    /** ⭐ Denormalised so a thread list does not need a subquery per row. */
    last_message_at     timestamptz,
    message_count       integer NOT NULL DEFAULT 0,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT message_threads_subject_is_whole CHECK (
        (subject_type IS NULL AND subject_id IS NULL)
        OR (subject_type IS NOT NULL AND subject_id IS NOT NULL)
    ),
    -- ⚠️ A thread with neither a title nor a record it belongs to cannot
    -- be found again by anybody who was not in it at the time.
    CONSTRAINT message_threads_is_findable CHECK (
        title IS NOT NULL OR subject_type IS NOT NULL
    ),
    CONSTRAINT message_threads_closed_is_explained CHECK (
        NOT is_closed OR closed_reason IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS message_threads_subject_idx
    ON message_threads (tenant_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS message_threads_recent_idx
    ON message_threads (tenant_id, last_message_at DESC);


CREATE TABLE IF NOT EXISTS thread_participants (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    thread_id           uuid NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    /** 🔴 Unread is computed from this, never stored as a count. */
    last_read_at        timestamptz,
    is_muted            boolean NOT NULL DEFAULT false,
    /** How they got here: added, or mentioned into it. */
    joined_via          varchar(20) NOT NULL DEFAULT 'added',

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT thread_participants_joined_via_known CHECK (
        joined_via IN ('added', 'mentioned', 'creator')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS thread_participants_unique
    ON thread_participants (thread_id, user_id);
CREATE INDEX IF NOT EXISTS thread_participants_mine_idx
    ON thread_participants (tenant_id, user_id);


CREATE TABLE IF NOT EXISTS messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    thread_id           uuid NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,

    author_id           uuid REFERENCES users(id) ON DELETE SET NULL,
    body                text NOT NULL,
    /** Who was named in it. The trigger below adds them to the thread. */
    mentions            uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
    reply_to            uuid REFERENCES messages(id) ON DELETE SET NULL,

    /** ⭐ Set when a message became a task, so it is not done twice. */
    task_id             uuid REFERENCES tasks(id) ON DELETE SET NULL,

    /** ⚠️ An edit is recorded, never hidden. */
    edited_at           timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT messages_has_words CHECK (length(btrim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS messages_thread_idx
    ON messages (tenant_id, thread_id, created_at);


--  🔴 YOU CANNOT POST INTO A CONVERSATION YOU ARE NOT IN.
--
--  ⚠️ It sounds obvious and it is the check every messaging feature
--  forgets, because the screen only ever shows you threads you are in.
--  The screen is not the boundary.
--
--  ⭐ AND MENTIONING SOMEBODY ADDS THEM. That is what a mention is for:
--  bringing a person into a conversation. A mention that notifies
--  somebody who then cannot read the thread is worse than no mention.
CREATE OR REPLACE FUNCTION ordence_guard_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  is_participant boolean;
  closed         boolean;
  m              uuid;
BEGIN
  SELECT is_closed INTO closed FROM message_threads
   WHERE id = NEW.thread_id AND tenant_id = NEW.tenant_id;

  IF closed IS NULL THEN
    RAISE EXCEPTION 'That conversation does not exist.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF closed THEN
    RAISE EXCEPTION
      'This conversation has been closed. Reopen it, or start a new one, so the record shows the discussion resumed rather than never having stopped.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.author_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM thread_participants
       WHERE thread_id = NEW.thread_id AND user_id = NEW.author_id
    ) INTO is_participant;

    IF NOT is_participant THEN
      RAISE EXCEPTION
        'You are not in this conversation, so you cannot post into it. Being able to see a thread and being part of it are two different things, and only one of them is a permission.'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  -- ⭐ A mention brings the person in.
  IF array_length(NEW.mentions, 1) IS NOT NULL THEN
    FOREACH m IN ARRAY NEW.mentions LOOP
      INSERT INTO thread_participants (tenant_id, thread_id, user_id, joined_via)
      VALUES (NEW.tenant_id, NEW.thread_id, m, 'mentioned')
      ON CONFLICT (thread_id, user_id) DO NOTHING;
    END LOOP;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_message ON messages;
CREATE TRIGGER trg_guard_message
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_message();


--  ⚠️ A MESSAGE CANNOT BE DELETED, AND AN EDIT SAYS SO.
--
--  🔴 A conversation about an invoice that can be silently rewritten is
--  worse than no record, because people will rely on it.
CREATE OR REPLACE FUNCTION ordence_guard_message_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'A message cannot be deleted. People act on what was said, and a conversation that can be quietly rewritten is worse than no record at all. Post a correction instead.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.body IS DISTINCT FROM OLD.body AND NEW.edited_at IS NULL THEN
    RAISE EXCEPTION
      'An edited message has to be marked as edited. The other people in the conversation read the first version.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.author_id IS DISTINCT FROM OLD.author_id THEN
    RAISE EXCEPTION 'A message cannot change author.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_message_history ON messages;
CREATE TRIGGER trg_guard_message_history
  BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_message_history();


--  ⭐ Keep the thread summary honest without a subquery per row.
CREATE OR REPLACE FUNCTION ordence_touch_thread()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE message_threads
     SET last_message_at = NEW.created_at,
         message_count   = message_count + 1,
         updated_at      = now()
   WHERE id = NEW.thread_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_touch_thread ON messages;
CREATE TRIGGER trg_touch_thread
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION ordence_touch_thread();


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⭐ app_platform_scope() in USING, never in WITH CHECK.

ALTER TABLE lead_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_sources_tenant_isolation ON lead_sources;
CREATE POLICY lead_sources_tenant_isolation ON lead_sources
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_stages_tenant_isolation ON pipeline_stages;
CREATE POLICY pipeline_stages_tenant_isolation ON pipeline_stages
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE consent_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_notices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_notices_tenant_isolation ON consent_notices;
CREATE POLICY consent_notices_tenant_isolation ON consent_notices
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consents_tenant_isolation ON consents;
CREATE POLICY consents_tenant_isolation ON consents
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE message_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_threads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_threads_tenant_isolation ON message_threads;
CREATE POLICY message_threads_tenant_isolation ON message_threads
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE thread_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_participants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS thread_participants_tenant_isolation ON thread_participants;
CREATE POLICY thread_participants_tenant_isolation ON thread_participants
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_tenant_isolation ON messages;
CREATE POLICY messages_tenant_isolation ON messages
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
