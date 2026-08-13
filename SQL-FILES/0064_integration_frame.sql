-- =====================================================================
--  ORDENCE 0064 — THE INTEGRATION FRAME
--  v1.12.0-alpha · Front office, batch 6
-- =====================================================================
--
--  ⭐⭐ ONE FRAME, BUILT ONCE, FOR FIVE INTEGRATIONS.
--
--  IndiaMART, JustDial, Meta, WhatsApp and email are five connections.
--  Building the frame once is one session. Building it five times is five
--  sessions and five different bugs — and the fifth one is always the
--  worst, because by then nobody remembers how the first one handled a
--  retry.
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴🔴 THE FAILURE LOG IS NOT OPTIONAL
--  ══════════════════════════════════════════════════════════════════════
--  When leads stop arriving, the customer rings and asks why. If the
--  answer is "let me check with the developer", the integration has
--  already failed twice: once technically, and once as a product.
--
--  ⚠️ Every fetch and every inbound delivery is recorded with its
--  outcome, in words the customer can read. `sync_runs` and
--  `webhook_deliveries` exist for the day something breaks, not for the
--  days it works.
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴 AND THE THROTTLE IS REAL
--  ══════════════════════════════════════════════════════════════════════
--  IndiaMART's pull API allows one call every five minutes; more than
--  five in a minute triggers a fifteen minute lockout; the window is
--  seven days and history runs 365. A polling integration that ignores
--  that gets locked out, and a locked-out integration looks exactly like
--  a broken one.
--
--  ⭐ So the lockout is STATE ON THE CONNECTION, not a comment in a
--  runner somewhere. Anything that fetches has to see it.
--
--  ══════════════════════════════════════════════════════════════════════
--  🔴🔴 SECRETS — AND THE TABLE THAT IS NOT HERE
--  ══════════════════════════════════════════════════════════════════════
--  ⭐⭐ THIS IS THE FIRST TIME ORDENCE HOLDS SOMEBODY ELSE'S CREDENTIAL.
--  Everything stored until now has been the tenant's own data. From here
--  the database holds keys that open OTHER PEOPLE'S systems: an
--  IndiaMART seller account, a Meta page, a WhatsApp number that can
--  send messages in the customer's name.
--
--  ⚠️ WHICH CHANGES THE THREAT. It is no longer "somebody reads tenant
--  A's rows"; it is "somebody obtains a backup and can now post as four
--  hundred businesses". RLS does not help with a stolen dump. Only
--  encryption does, and only if the key is somewhere the dump is not.
--
--  🔴 THE VAULT THAT DOES THAT HAS EXISTED SINCE 0037 AND NOTHING HAS
--  EVER WRITTEN TO IT. So this migration creates NO secrets table at
--  all. See section ② for the full argument.
--
--  ⚠️ AND NOTHING READS A SECRET BACK TO A SCREEN. There is no action
--  that returns one; the screen shows the vault's masked display.
--
--  Depends on: core (tenants, users), 0037 (vault_secrets).
-- =====================================================================

-- =====================================================================
--  ⚠️ OUTSIDE THE TRANSACTION, AND THAT IS NOT A STYLE CHOICE.
-- =====================================================================
--  A new enum value cannot be USED in the transaction that adds it, so
--  these two run first, on their own, and are idempotent.
--
--  🔴 THE VAULT'S ACCESS LOG DEMANDS A PURPOSE FROM A FIXED LIST, and
--  0037 was right to: a free-text reason box gets "work" typed into it
--  four thousand times and answers nothing. But its ten purposes were
--  all written for a PERSON reading a PAN, and neither of the two things
--  that are about to happen thousands of times a week was among them.
--
--  ⭐ `integration_setup` — a person entering or rotating a key. Rare,
--     deliberate, and exactly the event the log exists for.
--
--  ⭐ `integration_sync` — the runner reading a key to make a call.
--     Machine, unattended, and every few minutes.
--
--  ⚠️ THE DISTINCTION MATTERS BECAUSE OF WHAT WE DO NOT LOG. A
--  connection polling every six minutes reads its key 240 times a day.
--  Writing 240 access rows a day per connection would bury the handful
--  of rows where a HUMAN opened a credential, and 0037's own header
--  makes that argument about masked display: "the log would drown in
--  noise, which is the same as having no log."
--
--  🔴 SO THE RUNNER'S READ IS ACCOUNTED FOR BY ITS `sync_runs` ROW,
--  which already records what ran, when, for which connection and with
--  what result. `integration_sync` is written when a key is read OUTSIDE
--  a recorded run, which should be never, and is therefore worth seeing.
ALTER TYPE vault_access_purpose ADD VALUE IF NOT EXISTS 'integration_setup';
ALTER TYPE vault_access_purpose ADD VALUE IF NOT EXISTS 'integration_sync';

BEGIN;

-- =====================================================================
--  ① THE CONNECTION
-- =====================================================================

CREATE TABLE IF NOT EXISTS connections (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    /** Which outside system: indiamart, justdial, meta, whatsapp, email. */
    connector_key       varchar(40) NOT NULL,
    name                varchar(160) NOT NULL,

    /**
     * ⭐ Non-secret configuration only: an account id, a page id, a
     * mobile number, a lane. Anything secret goes in
     * `vault_secrets` and never here.
     */
    config              jsonb NOT NULL DEFAULT '{}'::jsonb,

    /**
     * 🔴 THE STATE A HUMAN READS.
     *   connected   — working
     *   degraded    — failing, still trying
     *   locked      — throttled by the far end, waiting it out
     *   paused      — a person turned it off
     *   revoked     — credentials rejected; a person must act
     */
    state               varchar(20) NOT NULL DEFAULT 'paused',
    state_reason        varchar(500),

    /* ── polling ─────────────────────────────────────────────────── */
    /** ⚠️ Zero means push-only. A webhook connection never polls. */
    poll_every_seconds  integer NOT NULL DEFAULT 0,
    last_attempt_at     timestamptz,
    last_success_at     timestamptz,
    /** ⭐ Where the next fetch should start from. */
    cursor_at           timestamptz,

    /* ── health ──────────────────────────────────────────────────── */
    consecutive_failures integer NOT NULL DEFAULT 0,
    /**
     * 🔴 SET BY THE FAR END'S THROTTLE OR BY OUR OWN BACKOFF. Nothing
     * may fetch before this passes.
     */
    locked_until        timestamptz,
    last_error_code     varchar(60),
    last_error_at       timestamptz,
    /** In words the customer can read, never a stack trace. */
    last_error_message  varchar(500),

    is_active           boolean NOT NULL DEFAULT true,
    notes               text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT connections_state_known CHECK (
        state IN ('connected', 'degraded', 'locked', 'paused', 'revoked')
    ),
    CONSTRAINT connections_poll_sane CHECK (poll_every_seconds >= 0),
    CONSTRAINT connections_failures_non_negative CHECK (consecutive_failures >= 0),

    -- 🔴 A CONNECTION THAT IS NOT WORKING HAS TO SAY WHY, IN WORDS.
    --
    -- ⚠️ "Degraded" on a screen with no reason is the support call this
    -- whole table exists to prevent. The customer rings, and the answer
    -- has to be on the screen they are already looking at.
    CONSTRAINT connections_unhealthy_is_explained CHECK (
        state IN ('connected', 'paused') OR state_reason IS NOT NULL
    ),
    -- ⚠️ A locked connection says when it comes back.
    CONSTRAINT connections_locked_has_an_end CHECK (
        state <> 'locked' OR locked_until IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS connections_key_unique
    ON connections (tenant_id, connector_key, lower(name));
-- ⭐ THE QUERY THE RUNNER MAKES: what is due to be fetched.
CREATE INDEX IF NOT EXISTS connections_due_idx
    ON connections (tenant_id, last_attempt_at)
    WHERE is_active AND poll_every_seconds > 0
      AND state IN ('connected', 'degraded');


-- =====================================================================
--  ② THE SECRET — AND THE TABLE THIS MIGRATION DELIBERATELY DOES NOT
--     CREATE
-- =====================================================================
--
--  ⭐⭐⭐ THE VAULT HAS EXISTED SINCE 0037 AND NOTHING HAS EVER WRITTEN
--  TO IT.
--
--  `vault_secrets` was built in v0.66.0-alpha with ciphertext-only
--  storage, a key that lives outside the database, an HMAC blind index
--  under a server-side pepper, a masked display column, a retention
--  date set at write time, an erasure function that actually zeroes the
--  value, and an append-only access log that no application role may
--  delete. It has `api_credential` in its own kind list. It is granted,
--  policied, triggered and tested.
--
--  🔴 AND NOT ONE LINE OF APPLICATION CODE TOUCHES IT.
--
--  ⚠️ SO THE FIRST DRAFT OF THIS MIGRATION CREATED `connection_secrets`,
--  WHICH WOULD HAVE BEEN THE SECOND VAULT. That is the same mistake the
--  price list avoided in 0057 and the lead table avoided in 0061, except
--  worse, because the thing being duplicated is where credentials live:
--
--    • Two erasure paths, and a data-deletion request that satisfies one
--      of them while the value survives in the other.
--    • Two rotation stories, and a key rotated in one place and stale in
--      the other.
--    • ⚠️ AND THE ACCESS LOG WOULD NOT COVER THE CREDENTIALS MOST WORTH
--      LOGGING. An IndiaMART key opens somebody else's seller account. A
--      WhatsApp token can send messages in the customer's name. If any
--      secret in this system deserves "who read this, and why", it is
--      these — and a private table beside the vault is precisely the one
--      place the vault's log does not reach.
--
--  ⭐ SO INTEGRATION CREDENTIALS GO IN `vault_secrets`:
--
--        kind        = 'api_credential'
--        owner_kind  = 'connection'
--        owner_id    = connections.id
--        label       = 'api_key' | 'access_token' | 'app_secret' | ...
--
--  The vault's `ON DELETE` behaviour is deliberately NOT a cascade from
--  `connections` — deleting a connection must not silently destroy the
--  record that a credential was held. `server/vault/secrets.ts` erases
--  through `ordence_vault_erase`, which keeps the row as the receipt.

-- ⚠️ RUN BEFORE THE TRANSACTION BELOW OPENS — see the top of this file.
--    The two purposes the vault was missing.


--  ⭐ WHAT A PERSON MAY SEE ABOUT A STORED CREDENTIAL.
--
--  🔴 NO CIPHERTEXT. NO BLIND INDEX. The blind index is a searchable
--  derivative of the value, so a screen about which keys are loaded has
--  no business carrying it — the same reasoning 0037 applied to
--  `v_vault_retention_due`.
--
--  ⚠️ AND `has_credential` IS A COUNT, NOT A BOOLEAN SOMEBODY SETS. A
--  flag on `connections` saying "configured" would drift the moment a
--  secret was erased, and the screen would go on promising a key that
--  is no longer there.
CREATE OR REPLACE VIEW v_connection_credentials
WITH (security_invoker = true) AS
SELECT
    c.tenant_id,
    c.id                AS connection_id,
    c.connector_key,
    s.id                AS secret_id,
    s.label             AS secret_name,
    s.masked_display,
    s.status,
    s.key_ref,
    s.algorithm,
    s.created_at,
    s.updated_at        AS rotated_at,
    -- ⚠️ NO `expires_at` COLUMN EXISTS ON THE VAULT, and adding one for a
    -- Meta access token would widen a table that every kind shares for
    -- the benefit of one. It goes in the metadata the table already has.
    (s.metadata->>'expires_at')::timestamptz AS expires_at,
    s.retain_until,
    s.access_count,
    s.last_accessed_at
FROM connections c
JOIN vault_secrets s
  ON s.tenant_id  = c.tenant_id
 AND s.owner_kind = 'connection'
 AND s.owner_id   = c.id
WHERE s.status <> 'erased';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app') THEN
    GRANT SELECT ON v_connection_credentials TO ordence_app;
  END IF;
END $$;


-- =====================================================================
--  ③ EVERY FETCH, RECORDED
-- =====================================================================
--  ⭐ THIS TABLE EXISTS FOR THE DAY SOMETHING BREAKS, NOT FOR THE DAYS
--  IT WORKS.

CREATE TABLE IF NOT EXISTS sync_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id       uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

    started_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz,

    /** The window actually asked for, so a gap can be seen. */
    window_from         timestamptz,
    window_to           timestamptz,

    outcome             varchar(20) NOT NULL DEFAULT 'running',

    /**
     * ⭐ THREE COUNTS, NOT ONE.
     *
     * 🔴 "Fetched 40" answers nothing. Forty seen, forty duplicates and
     * nothing new is a healthy run on a quiet day. Forty seen and forty
     * new every single time is a cursor that is not moving, which looks
     * like success and is a silent re-import.
     */
    items_seen          integer NOT NULL DEFAULT 0,
    items_new           integer NOT NULL DEFAULT 0,
    items_duplicate     integer NOT NULL DEFAULT 0,
    items_failed        integer NOT NULL DEFAULT 0,

    error_code          varchar(60),
    /** ⚠️ In words the customer can read. Never a stack trace. */
    error_message       varchar(500),
    /** Set where the far end told us to wait. */
    retry_after         timestamptz,

    CONSTRAINT sync_runs_outcome_known CHECK (
        outcome IN ('running', 'success', 'partial', 'failed', 'skipped_locked', 'skipped_too_soon')
    ),
    CONSTRAINT sync_runs_counts_non_negative CHECK (
        items_seen >= 0 AND items_new >= 0 AND items_duplicate >= 0 AND items_failed >= 0
    ),
    -- ⚠️ The parts cannot exceed the whole.
    CONSTRAINT sync_runs_counts_add_up CHECK (
        items_new + items_duplicate + items_failed <= items_seen
    ),
    -- 🔴 A FAILED RUN SAYS WHY. A failure log whose rows say "failed" is
    -- a failure log that answers nothing.
    CONSTRAINT sync_runs_failure_is_explained CHECK (
        outcome NOT IN ('failed', 'partial') OR error_message IS NOT NULL
    ),
    CONSTRAINT sync_runs_finished_is_dated CHECK (
        outcome = 'running' OR finished_at IS NOT NULL
    ),
    CONSTRAINT sync_runs_window_ordered CHECK (
        window_from IS NULL OR window_to IS NULL OR window_to >= window_from
    )
);

CREATE INDEX IF NOT EXISTS sync_runs_connection_idx
    ON sync_runs (tenant_id, connection_id, started_at DESC);
-- ⭐ The screen a customer opens when leads stop arriving.
CREATE INDEX IF NOT EXISTS sync_runs_failures_idx
    ON sync_runs (tenant_id, started_at DESC)
    WHERE outcome IN ('failed', 'partial');


-- =====================================================================
--  ④ INBOUND
-- =====================================================================

CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connection_id       uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

    /**
     * 🔴 THE UNGUESSABLE PART OF THE URL. Long and random, because for
     * some senders it is the only thing standing between the endpoint
     * and the open internet — JustDial, for one, has no signature at
     * all.
     */
    path_token          varchar(64) NOT NULL,
    /** How the sender proves it is them. */
    verification        varchar(20) NOT NULL DEFAULT 'hmac_sha256',
    signature_header    varchar(80),
    /** ⚠️ Tolerance for clock skew on a signed timestamp, in seconds. */
    timestamp_tolerance_seconds integer NOT NULL DEFAULT 300,

    is_active           boolean NOT NULL DEFAULT true,
    last_delivery_at    timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT webhook_endpoints_verification_known CHECK (
        verification IN ('hmac_sha256', 'hmac_sha1', 'shared_token', 'none')
    ),
    CONSTRAINT webhook_endpoints_tolerance_sane CHECK (
        timestamp_tolerance_seconds BETWEEN 0 AND 3600
    ),
    -- 🔴 A SIGNED ENDPOINT HAS TO SAY WHICH HEADER CARRIES THE SIGNATURE,
    -- or every delivery fails verification for a reason nobody can see.
    CONSTRAINT webhook_endpoints_signed_names_its_header CHECK (
        verification IN ('none', 'shared_token') OR signature_header IS NOT NULL
    ),
    -- ⚠️ AN UNGUESSABLE PATH IS THE ONLY DEFENCE AN UNSIGNED ENDPOINT
    -- HAS. Thirty-two characters is not a preference.
    CONSTRAINT webhook_endpoints_token_is_long_enough CHECK (
        length(path_token) >= 32
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_endpoints_token_unique
    ON webhook_endpoints (path_token);


CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    endpoint_id         uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,

    received_at         timestamptz NOT NULL DEFAULT now(),
    /** The sender's own id for this event, where it gives one. */
    external_id         varchar(200),

    /**
     * 🔴 WHETHER WE BELIEVED IT.
     *   verified     — signature checked and correct
     *   invalid      — signature present and wrong. Kept, and not acted on.
     *   absent       — no signature offered
     *   not_required — endpoint is unsigned by design
     */
    signature_state     varchar(20) NOT NULL,
    /** ⚠️ A delivery we have already seen. */
    is_replay           boolean NOT NULL DEFAULT false,

    payload_hash        varchar(64) NOT NULL,
    /**
     * ⭐ REDACTED BEFORE IT IS STORED. A webhook body is full of
     * somebody's personal data and this table would otherwise keep it
     * forever, which is a DPDP problem sitting in a debugging tool.
     */
    payload             jsonb,
    /** 🔴 When this row is deleted. Not optional, and not "someday". */
    purge_after         date NOT NULL,

    processed_at        timestamptz,
    outcome             varchar(20) NOT NULL DEFAULT 'received',
    error_message       varchar(500),

    CONSTRAINT webhook_deliveries_signature_state_known CHECK (
        signature_state IN ('verified', 'invalid', 'absent', 'not_required')
    ),
    CONSTRAINT webhook_deliveries_outcome_known CHECK (
        outcome IN ('received', 'processed', 'rejected', 'failed', 'ignored_replay')
    ),
    CONSTRAINT webhook_deliveries_failure_is_explained CHECK (
        outcome NOT IN ('rejected', 'failed') OR error_message IS NOT NULL
    ),
    -- 🔴 A DELIVERY WHOSE SIGNATURE WAS WRONG IS NEVER "PROCESSED".
    --
    -- ⚠️ It is kept, because an endpoint suddenly receiving invalid
    -- signatures is either a rotated secret or somebody probing it, and
    -- both are worth seeing. It is never acted on.
    CONSTRAINT webhook_deliveries_invalid_is_not_processed CHECK (
        signature_state <> 'invalid' OR outcome <> 'processed'
    ),
    -- ⚠️ And neither is a replay.
    CONSTRAINT webhook_deliveries_replay_is_not_processed CHECK (
        NOT is_replay OR outcome <> 'processed'
    )
);

-- 🔴🔴 REPLAY PROTECTION, IN AN INDEX RATHER THAN IN A CHECK SOMEWHERE.
--
-- ⚠️ Every one of these senders retries. A delivery that arrives twice
-- has to land once, and the only reliable key is the sender's own id.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_external_unique
    ON webhook_deliveries (endpoint_id, external_id)
    WHERE external_id IS NOT NULL AND NOT is_replay;

CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx
    ON webhook_deliveries (tenant_id, endpoint_id, received_at DESC);
-- ⭐ The purge job's only query.
CREATE INDEX IF NOT EXISTS webhook_deliveries_purge_idx
    ON webhook_deliveries (purge_after);


--  🔴 A DELIVERY IS EVIDENCE. IT CANNOT BE EDITED.
--
--  ⚠️ The only thing that may change after the fact is whether it was
--  processed and what happened. Rewriting the payload, the signature
--  verdict or the time it arrived would make the log useless for the one
--  thing it is for.
CREATE OR REPLACE FUNCTION ordence_guard_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- ⭐ The retention purge is allowed; deleting a live row is not.
    IF OLD.purge_after > CURRENT_DATE THEN
      RAISE EXCEPTION
        'This delivery is still inside its retention window and cannot be deleted. The log is the answer to "why did the leads stop", and a log somebody can prune is not an answer.'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.signature_state IS DISTINCT FROM OLD.signature_state
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION
      'What arrived, when it arrived and whether it was believed cannot be changed afterwards. Record what was done with it instead.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 🔴🔴 FOUND BY A DRILL, NOT BY THE DESIGN.
  --
  -- ⚠️ The first version of this guard froze the payload HASH and left
  -- the payload itself editable. So the stored body could be rewritten
  -- to say something else entirely while the hash beside it went on
  -- attesting to the original. That is worse than no record at all: it
  -- is a record that looks verified and is not.
  --
  -- ⭐ THE PAYLOAD MAY BE REMOVED, AND ONLY REMOVED. Redacting further,
  -- or answering a data-deletion request, sets it to NULL. Replacing it
  -- with different content is refused, exactly as the vault distinguishes
  -- erasure from a quiet edit.
  IF NEW.payload IS DISTINCT FROM OLD.payload AND NEW.payload IS NOT NULL THEN
    RAISE EXCEPTION
      'A stored delivery body may be removed but not rewritten. The hash beside it attests to what actually arrived, and a body that no longer matches it is a record that looks verified and is not.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_delivery ON webhook_deliveries;
CREATE TRIGGER trg_guard_delivery
  BEFORE UPDATE OR DELETE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_delivery();


--  ⭐ KEEP THE CONNECTION'S HEALTH HONEST, IN THE DATABASE.
--
--  🔴 A health field maintained only by the runner is a health field that
--  lies the first time the runner crashes between the fetch and the
--  update. Derived from the run that just finished.
CREATE OR REPLACE FUNCTION ordence_sync_connection_health()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.outcome = 'running' THEN
    RETURN NULL;
  END IF;

  IF NEW.outcome = 'success' THEN
    UPDATE connections
       SET consecutive_failures = 0,
           last_success_at      = COALESCE(NEW.finished_at, now()),
           last_attempt_at      = COALESCE(NEW.finished_at, now()),
           last_error_code      = NULL,
           last_error_message   = NULL,
           -- ⚠️ A success clears a degraded state but never un-pauses a
           -- connection somebody deliberately switched off.
           state                = CASE WHEN state IN ('degraded', 'locked')
                                       THEN 'connected' ELSE state END,
           state_reason         = CASE WHEN state IN ('degraded', 'locked')
                                       THEN NULL ELSE state_reason END,
           locked_until         = NULL,
           updated_at           = now()
     WHERE id = NEW.connection_id;

  ELSIF NEW.outcome IN ('failed', 'partial') THEN
    UPDATE connections
       SET consecutive_failures = consecutive_failures + 1,
           last_attempt_at      = COALESCE(NEW.finished_at, now()),
           last_error_code      = NEW.error_code,
           last_error_at        = COALESCE(NEW.finished_at, now()),
           last_error_message   = NEW.error_message,
           locked_until         = COALESCE(NEW.retry_after, locked_until),
           state                = CASE
                                    WHEN NEW.retry_after IS NOT NULL THEN 'locked'
                                    WHEN state = 'paused' THEN 'paused'
                                    ELSE 'degraded'
                                  END,
           state_reason         = COALESCE(NEW.error_message, 'The last fetch failed.'),
           updated_at           = now()
     WHERE id = NEW.connection_id;

  ELSIF NEW.outcome = 'skipped_locked' THEN
    UPDATE connections
       SET last_attempt_at = COALESCE(NEW.finished_at, now()),
           updated_at      = now()
     WHERE id = NEW.connection_id;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_sync_connection_health ON sync_runs;
CREATE TRIGGER trg_sync_connection_health
  AFTER INSERT OR UPDATE ON sync_runs
  FOR EACH ROW EXECUTE FUNCTION ordence_sync_connection_health();


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⭐ app_platform_scope() in USING, never in WITH CHECK.
--
--  ⚠️ THERE IS NO SECRETS TABLE HERE TO PROTECT. Credentials live in
--  `vault_secrets`, which has carried its own policies since 0037, and
--  whose real protection was never the policy anyway — it is that the
--  key is not in the database at all.

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connections_tenant_isolation ON connections;
CREATE POLICY connections_tenant_isolation ON connections
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_runs_tenant_isolation ON sync_runs;
CREATE POLICY sync_runs_tenant_isolation ON sync_runs
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_endpoints_tenant_isolation ON webhook_endpoints;
CREATE POLICY webhook_endpoints_tenant_isolation ON webhook_endpoints
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_tenant_isolation ON webhook_deliveries;
CREATE POLICY webhook_deliveries_tenant_isolation ON webhook_deliveries
    USING (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
